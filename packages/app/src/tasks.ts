import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentAdapter,
  type AgentExit,
  type AgentMessage,
  type AgentProcess,
  killTree,
  quoteShellArg,
  summarizeTool,
} from './claude';
import {
  type AgentProvider,
  type Denial,
  HttpError,
  normalizeAgentProvider,
  type NewTimelineItem,
  type Project,
  type PrCheckSnapshot,
  type Task,
  type TaskKind,
  type TaskPriority,
  type TimelineItem,
} from './domain';
import {
  type ChangeSet,
  addWorktree,
  changes,
  commitAll,
  createPullRequest,
  fetchPrSnapshot,
  ghVersion,
  git,
  parsePrNumber,
  hasUncommitted,
  inspectRepo,
  linkNodeModules,
  pushBranch,
  removeWorktree,
  worktreesRootFor,
} from './git';
import { type JiraApi, JiraClient } from './jira';
import { type ApproveMode, buildClaudeSettings, ruleFromCommand } from './permissions';
import { CONTINUE_PROMPT, buildAllowedPrompt, buildInitialPrompt } from './prompt';
import type { StateStore } from './store';
import { normalizePriority, normalizeTags } from './task-meta';
import { TimelineLog } from './timeline';

export interface TaskManagerDeps {
  store: StateStore;
  /** 按 provider 取适配器（优先）。 */
  getAgent?: (provider: AgentProvider) => AgentAdapter;
  /** 兼容旧测试：恒定 FakeAgent。 */
  agent?: AgentAdapter;
  dataDir: string;
  now?: () => Date;
  /** 可注入 FakeJira；默认真实 JiraClient（生产路径）。验收禁止真站。 */
  jiraFactory?: (cfg: { baseUrl: string; email: string; apiToken: string }) => JiraApi;
  prSnapshotFetcher?: (prUrl: string) => Promise<PrCheckSnapshot>;
  /** 测试可注入 FakeGh；默认真实 ghVersion / push / createPullRequest。验收禁真仓破坏。 */
  openPrDeps?: {
    ghVersion?: () => Promise<string | null>;
    pushBranch?: (worktreePath: string, branch: string) => Promise<void>;
    createPullRequest?: (
      worktreePath: string,
      opts: { base: string; head: string; title: string; body: string },
    ) => Promise<string>;
  };
}


export interface CreateTaskInput {
  projectId: string;
  kind: TaskKind;
  title: string;
  description?: string;
  jiraKey?: string;
  baseBranch?: string;
  agentProvider?: AgentProvider;
  tags?: string[];
  priority?: TaskPriority;
}

export type Change = { type: 'task' | 'timeline' | 'projects' | 'settings'; id: string };

interface RunState {
  proc?: AgentProcess;
  stopRequested: boolean;
  toolUses: Map<string, { name: string; input: Record<string, unknown> }>;
  result?: Extract<AgentMessage, { kind: 'result' }>;
}

const REVIEWABLE = new Set(['review', 'needs_you', 'stopped', 'failed', 'committed', 'pr_opened']);
const MAX_TEXT = 20_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return slug || 'task';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

export class TaskManager extends EventEmitter {
  readonly timeline: TimelineLog;
  private readonly store: StateStore;
  private readonly getAgent: (provider: AgentProvider) => AgentAdapter;
  private readonly makeJira: (cfg: { baseUrl: string; email: string; apiToken: string }) => JiraApi;
  private readonly prSnapshotFetcher?: (prUrl: string) => Promise<PrCheckSnapshot>;
  private readonly openPrDeps?: TaskManagerDeps['openPrDeps'];
  private readonly dataDir: string;
  private readonly clock: () => Date;
  private readonly runs = new Map<string, RunState>();
  private readonly busy = new Set<string>();
  private readonly testProcs = new Map<string, { kill: () => void; stopped: boolean; exited: Promise<void> }>();

  constructor(deps: TaskManagerDeps) {
    super();
    this.store = deps.store;
    this.getAgent = deps.getAgent ?? ((_: AgentProvider) => {
      if (!deps.agent) throw new Error('TaskManager 需要 getAgent 或 agent');
      return deps.agent;
    });
    this.makeJira = deps.jiraFactory ?? ((cfg) => new JiraClient(cfg));
    this.prSnapshotFetcher = deps.prSnapshotFetcher;
    this.openPrDeps = deps.openPrDeps;
    this.dataDir = deps.dataDir;
    this.clock = deps.now ?? (() => new Date());
    this.timeline = new TimelineLog(deps.dataDir);
    this.recover();
  }

  get worktreesRoot(): string {
    return join(this.dataDir, 'worktrees');
  }

  // ---------- 基础 ----------

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private notify(type: Change['type'], id: string): void {
    this.emit('change', { type, id } satisfies Change);
  }

  private touch(task: Task): void {
    task.updatedAt = this.nowIso();
    this.store.save();
    this.notify('task', task.id);
  }

  private log(task: Task, item: NewTimelineItem): TimelineItem {
    const saved = this.timeline.append(task.id, item, this.nowIso());
    this.notify('timeline', task.id);
    return saved;
  }

  private note(task: Task, text: string, level: 'info' | 'error' = 'info'): void {
    this.log(task, { type: 'note', level, text });
  }

  getTask(id: string): Task {
    const task = this.store.data.tasks.find((t) => t.id === id);
    if (!task) throw new HttpError(404, `任务 ${id} 不存在`);
    return task;
  }

  getProject(id: string): Project {
    const project = this.store.data.projects.find((p) => p.id === id);
    if (!project) throw new HttpError(404, `项目 ${id} 不存在`);
    return project;
  }

  isActive(task: Task): boolean {
    return task.status !== 'discarded';
  }

  /** 服务重启后：运行中的任务无法恢复，标记为已停止；排队的保留，等 pump。 */
  private recover(): void {
    for (const task of this.store.data.tasks) {
      if (task.status === 'running') {
        task.status = 'stopped';
        task.lastError = '服务重启，任务被中断；可以点「继续」接着做';
        this.note(task, task.lastError, 'error');
      }
      if (task.test?.status === 'running') {
        task.test = { ...task.test, status: 'failed', output: `${task.test.output}\n（服务重启，测试被中断）`, durationMs: null };
      }
    }
    this.store.save();
  }

  private async exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(taskId)) throw new HttpError(409, '这个任务正在执行另一项操作，请稍后再试');
    this.busy.add(taskId);
    try {
      return await fn();
    } finally {
      this.busy.delete(taskId);
    }
  }

  // ---------- 创建 ----------

  async createTask(input: CreateTaskInput): Promise<Task> {
    const project = this.getProject(input.projectId);
    const title = (input.title ?? '').trim();
    if (!title) throw new HttpError(400, '标题不能为空');
    if (title.length > 200) throw new HttpError(400, '标题不能超过 200 字');
    const description = (input.description ?? '').trim();
    if (description.length > MAX_TEXT) throw new HttpError(400, `描述不能超过 ${MAX_TEXT} 字`);
    if (input.kind !== 'bug' && input.kind !== 'feature') throw new HttpError(400, '任务类型必须是 bug 或 feature');
    const jiraKey = input.jiraKey?.trim() || undefined;
    if (jiraKey && !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(jiraKey)) throw new HttpError(400, `Jira 编号格式不对：${jiraKey}`);
    const base = (input.baseBranch ?? project.baseBranch).trim();
    if (!/^[\w./@-]+$/.test(base)) throw new HttpError(400, `基线分支名不合法：${base}`);

    const info = await inspectRepo(project.path);
    if (!info.hasCommits) throw new HttpError(400, '这个仓库还没有任何提交，无法创建工作区');

    const n = this.store.nextId('task');
    const id = `T${n}`;
    const slug = slugify(jiraKey ?? title);
    const branch = `devlane/${input.kind === 'bug' ? 'fix' : 'feat'}-${slug}-${randomBytes(2).toString('hex')}`;
    const dirName = `${slugify(project.name)}-${id}`;

    // 工作区放在和项目同一个盘符上（见 worktreesRootFor）；项目旁边不可写时退回数据目录
    let worktreePath = join(worktreesRootFor(info.root, this.dataDir), dirName);
    const notes: string[] = [];
    let baseSha: string;
    try {
      baseSha = await addWorktree(info.root, worktreePath, branch, base);
    } catch (err) {
      const fallbackPath = join(this.worktreesRoot, dirName);
      if (fallbackPath === worktreePath) throw new HttpError(400, `创建工作区失败：${(err as Error).message}`);
      try {
        baseSha = await addWorktree(info.root, fallbackPath, branch, base);
        worktreePath = fallbackPath;
        notes.push(`无法在项目旁边创建工作区（${(err as Error).message}），已改放到 ${this.worktreesRoot}。如果项目用了跨盘符的 node_modules 链接，Nuxt 等工具可能报路径错误，建议关闭项目的「链接 node_modules」`);
      } catch (err2) {
        throw new HttpError(400, `创建工作区失败：${(err2 as Error).message}`);
      }
    }
    if (project.linkNodeModules) {
      const note = await linkNodeModules(info.root, worktreePath);
      if (note) notes.push(note);
    }

    const now = this.nowIso();
    const agentProvider = normalizeAgentProvider(input.agentProvider);
    const task: Task = {
      id,
      projectId: project.id,
      kind: input.kind,
      agentProvider,
      title,
      description,
      jiraKey,
      baseBranch: base,
      baseSha,
      branch,
      worktreePath,
      status: 'queued',
      sessionId: randomUUID(),
      sessionStarted: false,
      runCount: 0,
      costUsd: 0,
      turns: 0,
      denials: [],
      approvedRules: [],
      notes,
      tags: normalizeTags(input.tags),
      priority: normalizePriority(input.priority),
      createdAt: now,
      updatedAt: now,
    };
    task.pendingPrompt = buildInitialPrompt(project, task);
    this.store.data.tasks.push(task);
    this.note(task, `已创建独立工作区：${worktreePath}（分支 ${branch}，基线 ${base} @ ${baseSha.slice(0, 8)}）`);
    for (const n2 of notes) this.note(task, n2);
    this.touch(task);
    this.pump();
    return task;
  }


  async updateTaskMeta(taskId: string, patch: { tags?: string[]; priority?: TaskPriority }): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status === 'discarded') throw new HttpError(409, '任务已丢弃');
    if (patch.tags !== undefined) task.tags = normalizeTags(patch.tags);
    else if (!Array.isArray(task.tags)) task.tags = [];
    if (patch.priority !== undefined) task.priority = normalizePriority(patch.priority);
    else if (!task.priority) task.priority = 'none';
    this.touch(task);
    return task;
  }

  // ---------- 调度与运行 ----------

  /** 按并发上限启动排队中的任务。 */
  pump(): void {
    const max = this.store.data.settings.maxConcurrent;
    for (;;) {
      if (this.runs.size >= max) return;
      const next = this.store.data.tasks
        .filter((t) => t.status === 'queued' && !this.runs.has(t.id))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!next) return;
      this.startRun(next);
    }
  }

  private startRun(task: Task): void {
    const project = this.store.data.projects.find((p) => p.id === task.projectId);
    if (!project) {
      this.failTask(task, '所属项目已被删除');
      return;
    }
    if (!existsSync(task.worktreePath)) {
      this.failTask(task, `工作区目录不存在：${task.worktreePath}`);
      return;
    }
    const settings = this.store.data.settings;
    const provider = normalizeAgentProvider(task.agentProvider);
    const prompt = task.pendingPrompt ?? CONTINUE_PROMPT;
    task.pendingPrompt = undefined;
    task.runCount += 1;
    task.status = 'running';
    task.lastError = undefined;

    const dir = join(this.dataDir, 'tasks', task.id);
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, 'settings.json');
    if (provider === 'claude') {
      writeFileSync(settingsPath, JSON.stringify(buildClaudeSettings(project, task.approvedRules), null, 2), 'utf8');
    } else {
      writeFileSync(settingsPath, '{}', 'utf8');
      if (task.runCount === 1) {
        this.note(task, '本 Agent 第一刀无 Claude 级权限拦截');
      }
    }

    this.log(task, { type: 'prompt', run: task.runCount, text: clip(prompt, MAX_TEXT) });

    const binaryPath =
      provider === 'claude'
        ? settings.claudePath || undefined
        : provider === 'codex'
          ? settings.codexPath || undefined
          : settings.grokBuildPath || undefined;

    const run: RunState = { stopRequested: false, toolUses: new Map() };
    this.runs.set(task.id, run);
    try {
      run.proc = this.getAgent(provider).start(
        {
          cwd: task.worktreePath,
          prompt,
          sessionId: task.sessionId,
          resume: task.sessionStarted,
          settingsPath,
          model: settings.model || undefined,
          maxBudgetUsd: settings.maxBudgetUsd,
          binaryPath,
        },
        (m) => this.onMessage(task, run, m),
      );
    } catch (err) {
      this.runs.delete(task.id);
      this.failTask(task, `无法启动 ${provider}：${(err as Error).message}`);
      return;
    }
    void run.proc.done.then((exit) => this.onExit(task, run, exit));
    this.touch(task);
  }

  private failTask(task: Task, message: string): void {
    task.status = 'failed';
    task.lastError = message;
    this.note(task, message, 'error');
    this.touch(task);
  }

  private onMessage(task: Task, run: RunState, m: AgentMessage): void {
    switch (m.kind) {
      case 'init':
        task.sessionStarted = true;
        if (m.sessionId) task.sessionId = m.sessionId;
        this.touch(task);
        break;
      case 'text':
        this.log(task, { type: 'text', text: clip(m.text, MAX_TEXT) });
        break;
      case 'tool_use': {
        run.toolUses.set(m.id, { name: m.name, input: m.input });
        const { summary, detail } = summarizeTool(m.name, m.input, task.worktreePath);
        this.log(task, { type: 'tool', toolUseId: m.id, name: m.name, summary, detail });
        break;
      }
      case 'tool_result':
        this.log(task, { type: 'tool_result', toolUseId: m.id, ok: !m.isError, text: clip(m.text, 4000) });
        break;
      case 'denied': {
        const use = run.toolUses.get(m.toolUseId);
        const command = use?.name === 'Bash' ? String(use.input.command ?? '') : undefined;
        const { summary } = use ? summarizeTool(use.name, use.input, task.worktreePath) : { summary: '' };
        if (!task.denials.some((d) => d.id === m.toolUseId)) {
          const denial: Denial = {
            id: m.toolUseId,
            tool: m.toolName || use?.name || '',
            command,
            detail: summary,
            status: 'pending',
            allowable: command !== undefined && ruleFromCommand(command, 'exact') !== null,
          };
          task.denials.push(denial);
        }
        this.log(task, { type: 'denied', toolUseId: m.toolUseId, tool: m.toolName, summary: command ?? summary });
        this.touch(task);
        break;
      }
      case 'result':
        run.result = m;
        task.costUsd += m.costUsd;
        task.turns += m.turns;
        this.log(task, {
          type: 'result',
          ok: m.ok,
          text: clip(m.text, MAX_TEXT),
          costUsd: m.costUsd,
          turns: m.turns,
          durationMs: m.durationMs,
        });
        break;
    }
  }

  private explainFailure(result: NonNullable<RunState['result']>): string {
    const budget = this.store.data.settings.maxBudgetUsd;
    if (result.subtype === 'error_max_budget_usd') return `这一轮花费超过了单次预算上限 $${budget}，已自动停止。可以在「设置」里调高预算，然后点「继续」`;
    if (result.subtype === 'error_max_turns') return '这一轮对话轮数达到上限，已自动停止。点「继续」可以接着做';
    return result.text.trim() || `Agent 没有正常完成（${result.subtype || '未知原因'}）`;
  }

  private onExit(task: Task, run: RunState, exit: AgentExit): void {
    this.runs.delete(task.id);
    if (run.stopRequested || exit.killed) {
      task.status = 'stopped';
      this.note(task, '已停止');
    } else if (run.result) {
      if (run.result.ok) {
        task.status = task.denials.some((d) => d.status === 'pending') ? 'needs_you' : 'review';
      } else {
        task.status = 'failed';
        task.lastError = this.explainFailure(run.result);
        this.note(task, task.lastError, 'error');
      }
    } else {
      task.status = 'failed';
      const tail = exit.stderr.trim().split('\n').slice(-5).join('\n');
      task.lastError = tail || `Claude 异常退出（退出码 ${exit.code ?? '无'}）`;
      this.note(task, task.lastError, 'error');
    }
    this.touch(task);
    this.pump();
  }

  // ---------- 与 Claude 交互 ----------

  async sendMessage(taskId: string, text: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!REVIEWABLE.has(task.status)) throw new HttpError(409, `当前状态（${task.status}）不能追问`);
    const msg = (text ?? '').trim();
    if (!msg) throw new HttpError(400, '内容不能为空');
    if (msg.length > MAX_TEXT) throw new HttpError(400, `内容不能超过 ${MAX_TEXT} 字`);
    for (const d of task.denials) if (d.status === 'pending') d.status = 'ignored';
    task.pendingPrompt = msg;
    task.status = 'queued';
    this.touch(task);
    this.pump();
    return task;
  }

  /** 允许被拦截的命令并让 Claude 继续。 */
  async allowDenials(taskId: string, denialIds: string[], mode: ApproveMode): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status !== 'needs_you' && task.status !== 'review') throw new HttpError(409, `当前状态（${task.status}）没有待处理的拦截`);
    if (mode !== 'exact' && mode !== 'prefix') throw new HttpError(400, 'mode 必须是 exact 或 prefix');
    const picked = task.denials.filter((d) => denialIds.includes(d.id) && d.status === 'pending');
    if (picked.length === 0) throw new HttpError(400, '没有选中可处理的拦截');

    const commands: string[] = [];
    for (const d of picked) {
      const rule = d.command ? ruleFromCommand(d.command, mode) : null;
      if (!rule) throw new HttpError(400, `这条无法放行：${d.command ?? d.detail}（危险命令、复合命令或非命令类操作不支持放行）`);
      if (!task.approvedRules.includes(rule)) task.approvedRules.push(rule);
      d.status = 'allowed';
      d.rule = rule;
      commands.push(mode === 'prefix' ? `${rule.slice(5, -1).replace(/:\*$/, '')} …（同类命令）` : d.command!);
    }
    this.note(task, `已允许：${commands.join('； ')}`);
    task.pendingPrompt = buildAllowedPrompt(commands);
    task.status = 'queued';
    this.touch(task);
    this.pump();
    return task;
  }

  /** 不放行，保持现状，直接进入待审阅。 */
  async ignoreDenials(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    for (const d of task.denials) if (d.status === 'pending') d.status = 'ignored';
    if (task.status === 'needs_you') task.status = 'review';
    this.touch(task);
    return task;
  }

  async stop(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    const run = this.runs.get(taskId);
    if (task.status === 'running' && run) {
      run.stopRequested = true;
      run.proc?.kill();
      return task;
    }
    if (task.status === 'queued') {
      task.status = 'stopped';
      this.note(task, '已取消排队');
      this.touch(task);
      return task;
    }
    throw new HttpError(409, `当前状态（${task.status}）没有正在运行的内容可停止`);
  }

  // ---------- 审阅与交付 ----------

  async getChanges(taskId: string): Promise<ChangeSet> {
    const task = this.getTask(taskId);
    if (task.status === 'discarded') throw new HttpError(409, '任务已丢弃');
    if (!existsSync(task.worktreePath)) throw new HttpError(409, '工作区目录不存在');
    return changes(task.worktreePath, task.baseSha);
  }

  private ensureIdle(task: Task, what: string): void {
    if (task.status === 'running' || task.status === 'queued') throw new HttpError(409, `Claude 还在工作，请先停止或等它完成再${what}`);
    if (task.status === 'discarded') throw new HttpError(409, '任务已丢弃');
  }

  async commit(taskId: string, message: string): Promise<Task> {
    const task = this.getTask(taskId);
    this.ensureIdle(task, '提交');
    const msg = (message ?? '').trim();
    if (!msg) throw new HttpError(400, '提交说明不能为空');
    if (msg.length > 5000) throw new HttpError(400, '提交说明不能超过 5000 字');
    return this.exclusive(taskId, async () => {
      const sha = await commitAll(task.worktreePath, msg).catch((err) => {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, (err as Error).message);
      });
      task.commitSha = sha;
      if (task.status !== 'pr_opened') task.status = 'committed';
      this.note(task, `已提交 ${sha.slice(0, 8)}：${msg.split('\n')[0]}`);
      this.touch(task);
      return task;
    });
  }

  async openPullRequest(taskId: string, input: { title: string; body: string }): Promise<Task> {
    const task = this.getTask(taskId);
    this.ensureIdle(task, '创建 PR');
    const title = (input.title ?? '').trim();
    if (!title) throw new HttpError(400, 'PR 标题不能为空');
    if (!task.commitSha) throw new HttpError(409, '还没有提交，请先提交改动');
    return this.exclusive(taskId, async () => {
      if (await hasUncommitted(task.worktreePath)) throw new HttpError(409, '还有未提交的改动，请先提交，避免 PR 缺内容');
      const project = this.getProject(task.projectId);
      const remotes = (await git(project.path, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
      if (!remotes.includes('origin')) throw new HttpError(400, '仓库没有名为 origin 的远程，无法推送');
      const checkGh = this.openPrDeps?.ghVersion ?? ghVersion;
      if (!(await checkGh())) throw new HttpError(400, '找不到 gh 命令。请安装 GitHub CLI 并执行 gh auth login');

      try {
        const doPush = this.openPrDeps?.pushBranch ?? pushBranch;
        await doPush(task.worktreePath, task.branch);
      } catch (err) {
        throw new HttpError(502, `推送失败：${(err as Error).message}`);
      }
      this.note(task, `已推送分支 ${task.branch}`);
      let url: string;
      try {
        const doCreate = this.openPrDeps?.createPullRequest ?? createPullRequest;
        url = await doCreate(task.worktreePath, {
          base: task.baseBranch,
          head: task.branch,
          title,
          body: (input.body ?? '').slice(0, 20_000),
        });
      } catch (err) {
        this.note(task, `分支已推送，但创建 PR 失败：${(err as Error).message}`, 'error');
        this.touch(task);
        throw err;
      }
      task.prUrl = url;
      const n = parsePrNumber(url);
      if (n) task.prNumber = n;
      task.status = 'pr_opened';
      this.note(task, `已创建 PR：${url}`);
      this.touch(task);
      // 评论回写失败不得推翻 PR 成功
      await this.maybeAutoJiraComment(task);
      return task;
    });
  }



  async refreshPrCheck(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task.prUrl) throw new HttpError(400, '还没有 PR');
    return this.exclusive(taskId, async () => {
      try {
        let snap: PrCheckSnapshot;
        if (this.prSnapshotFetcher) {
          snap = await this.prSnapshotFetcher(task.prUrl!);
        } else {
          if (!(await ghVersion())) {
            throw new HttpError(400, '找不到 gh 命令。请安装 GitHub CLI 并执行 gh auth login');
          }
          snap = await fetchPrSnapshot(task.prUrl!);
        }
        if (snap.prNumber) task.prNumber = snap.prNumber;
        task.prCheck = {
          refreshedAt: snap.refreshedAt,
          prNumber: snap.prNumber ?? task.prNumber ?? parsePrNumber(task.prUrl!),
          ci: snap.ci,
          merge: snap.merge,
          mergeDetail: snap.mergeDetail,
        };
        this.note(task, `已刷新 PR 状态：CI ${snap.ci}，合并 ${snap.merge}`);
        this.touch(task);
        return task;
      } catch (err) {
        const msg = err instanceof HttpError ? err.message : (err as Error).message;
        const prev = task.prCheck;
        task.prCheck = {
          refreshedAt: prev?.refreshedAt ?? this.nowIso(),
          prNumber: prev?.prNumber ?? task.prNumber ?? parsePrNumber(task.prUrl!),
          ci: prev?.ci ?? 'unknown',
          merge: prev?.merge ?? 'unknown',
          mergeDetail: prev?.mergeDetail,
          lastError: msg,
        };
        this.note(task, `刷新 PR 状态失败：${msg}`, 'error');
        this.touch(task);
        throw err instanceof HttpError ? err : new HttpError(502, msg);
      }
    });
  }

  /** Auto Jira comment: only pr_opened + writeEnabled + jiraKey; same fingerprint skips. Errors note only. */
  async maybeAutoJiraComment(task: Task): Promise<void> {
    if (!task.jiraKey) return;
    const cfg = this.store.data.settings.jira;
    if (!cfg?.writeEnabled) return;
    if (task.status !== 'pr_opened' || !task.prUrl) return;
    const fingerprint = `pr_opened:${task.prUrl}`;
    if (task.jiraWrite?.lastFingerprint === fingerprint) return;
    try {
      const text = `DevLane status: ${task.status}\nPR: ${task.prUrl}`;
      await this.makeJira(cfg).addComment(task.jiraKey, text);
      task.jiraWrite = { lastFingerprint: fingerprint, lastAt: this.nowIso() };
      this.note(task, `Jira comment written to ${task.jiraKey}`);
      this.touch(task);
    } catch (err) {
      const msg = (err as Error).message;
      task.jiraWrite = {
        lastFingerprint: task.jiraWrite?.lastFingerprint,
        lastError: msg,
        lastAt: this.nowIso(),
      };
      this.note(task, `Jira comment failed: ${msg}`, 'error');
      this.touch(task);
    }
  }

  /** Manual Jira comment. No key => no-op; writeEnabled off => 400. force uses new fingerprint. */
  async writeJiraComment(taskId: string, opts: { force?: boolean } = {}): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task.jiraKey) return task;
    const cfg = this.store.data.settings.jira;
    if (!cfg?.writeEnabled) throw new HttpError(400, '未开启回写：请到设置页打开「允许回写 Jira 评论」');
    return this.exclusive(taskId, async () => {
      const fingerprint = opts.force ? `manual:${this.nowIso()}` : `pr_opened:${task.prUrl ?? ''}`;
      if (!opts.force && task.jiraWrite?.lastFingerprint === fingerprint && fingerprint !== 'pr_opened:') {
        return task;
      }
      try {
        const lines = [`DevLane status: ${task.status}`];
        if (task.prUrl) lines.push(`PR: ${task.prUrl}`);
        lines.push(`task: ${task.title}`);
        await this.makeJira(cfg).addComment(task.jiraKey!, lines.join('\n'));
        task.jiraWrite = { lastFingerprint: fingerprint, lastAt: this.nowIso() };
        this.note(task, `Jira comment written to ${task.jiraKey}`);
        this.touch(task);
      } catch (err) {
        const msg = (err as Error).message;
        task.jiraWrite = {
          lastFingerprint: task.jiraWrite?.lastFingerprint,
          lastError: msg,
          lastAt: this.nowIso(),
        };
        this.note(task, `Jira comment failed: ${msg}`, 'error');
        this.touch(task);
        throw err instanceof HttpError ? err : new HttpError(502, msg);
      }
      return task;
    });
  }

  async discard(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status === 'discarded') return task;
    return this.exclusive(taskId, async () => {
      const run = this.runs.get(taskId);
      if (run?.proc) {
        run.stopRequested = true;
        run.proc.kill();
        await Promise.race([run.proc.done, new Promise((r) => setTimeout(r, 10_000))]);
      }
      const testRun = this.testProcs.get(taskId);
      if (testRun) {
        testRun.kill();
        // 等测试进程真正退出再删目录，否则 Windows 上目录会被占用
        await Promise.race([testRun.exited, new Promise((r) => setTimeout(r, 10_000))]);
      }
      const project = this.store.data.projects.find((p) => p.id === task.projectId);
      const repo = project?.path ?? '';
      // 旧任务可能在数据目录里，新任务在项目旁边，两处都允许清理
      const roots = [this.worktreesRoot];
      if (project) roots.push(worktreesRootFor(project.path, this.dataDir));
      try {
        await removeWorktree(repo || this.dataDir, task.worktreePath, task.branch, roots);
      } catch (err) {
        throw new HttpError(500, `清理工作区失败：${(err as Error).message}`);
      }
      task.status = 'discarded';
      task.pendingPrompt = undefined;
      this.note(task, '已丢弃：工作区和分支已删除');
      this.touch(task);
      this.pump();
      return task;
    });
  }

  // ---------- 测试 ----------

  async runTests(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status === 'discarded') throw new HttpError(409, '任务已丢弃');
    const project = this.getProject(task.projectId);
    const command = project.testCommand.trim();
    if (!command) throw new HttpError(400, '这个项目还没有配置测试命令，请到「项目」页填写');
    if (this.testProcs.has(taskId)) throw new HttpError(409, '测试正在运行');
    if (!existsSync(task.worktreePath)) throw new HttpError(409, '工作区目录不存在');

    const started = Date.now();
    task.test = { status: 'running', command, exitCode: null, output: '', startedAt: this.nowIso(), durationMs: null };
    this.touch(task);

    const child = spawn(command, {
      cwd: task.worktreePath,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let output = '';
    let lastPush = 0;
    // 运行中把输出实时放进任务状态，让你能看到进度、决定要不要停；最多每 400ms 推送一次
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-200_000);
      const now = Date.now();
      if (task.test?.status === 'running' && now - lastPush > 400) {
        lastPush = now;
        task.test = { ...task.test, output: output.replace(ANSI, '') };
        this.notify('task', task.id);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      output += `\n（超过 ${TEST_TIMEOUT_MS / 60000} 分钟，已终止）`;
      killTree(child);
    }, TEST_TIMEOUT_MS);
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const handle = {
      stopped: false,
      exited,
      kill: (): void => {
        handle.stopped = true;
        killTree(child);
      },
    };
    this.testProcs.set(taskId, handle);

    child.on('close', (code) => {
      clearTimeout(timer);
      this.testProcs.delete(taskId);
      if (handle.stopped) output += '\n（已被你停止）';
      task.test = {
        status: handle.stopped ? 'stopped' : code === 0 ? 'passed' : 'failed',
        command,
        exitCode: code,
        output: output.replace(ANSI, ''),
        startedAt: task.test?.startedAt ?? this.nowIso(),
        durationMs: Date.now() - started,
      };
      this.touch(task);
      markExited();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      this.testProcs.delete(taskId);
      task.test = {
        status: 'failed',
        command,
        exitCode: null,
        output: `无法运行测试命令：${err.message}`,
        startedAt: task.test?.startedAt ?? this.nowIso(),
        durationMs: Date.now() - started,
      };
      this.touch(task);
      markExited();
    });
    return task;
  }

  /** 停止正在运行的测试：终止整个进程树（包括测试命令派生的子进程）。 */
  async stopTests(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    const handle = this.testProcs.get(taskId);
    if (!handle || task.test?.status !== 'running') throw new HttpError(409, '没有正在运行的测试');
    handle.kill();
    return task;
  }

  // ---------- 编辑器 ----------

  openEditor(taskId: string): void {
    const task = this.getTask(taskId);
    if (task.status === 'discarded') throw new HttpError(409, '任务已丢弃');
    const editor = this.store.data.settings.editorCommand;
    if (!/^[\w.-]+$/.test(editor)) throw new HttpError(400, '编辑器命令只能是一个程序名，例如 code');
    const child = spawn(editor, [quoteShellArg(task.worktreePath)], { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  }

  /** 关闭前停止所有运行中的进程。 */
  shutdown(): void {
    for (const run of this.runs.values()) {
      run.stopRequested = true;
      run.proc?.kill();
    }
    for (const t of this.testProcs.values()) t.kill();
  }
}
