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
  type Denial,
  HttpError,
  type NewTimelineItem,
  type Project,
  type Task,
  type TaskKind,
  type TimelineItem,
} from './domain';
import {
  type ChangeSet,
  addWorktree,
  changes,
  commitAll,
  createPullRequest,
  ghVersion,
  git,
  hasUncommitted,
  inspectRepo,
  linkNodeModules,
  pushBranch,
  removeWorktree,
} from './git';
import { type ApproveMode, buildClaudeSettings, ruleFromCommand } from './permissions';
import { CONTINUE_PROMPT, buildAllowedPrompt, buildInitialPrompt } from './prompt';
import type { StateStore } from './store';
import { TimelineLog } from './timeline';

export interface TaskManagerDeps {
  store: StateStore;
  agent: AgentAdapter;
  dataDir: string;
  now?: () => Date;
}

export interface CreateTaskInput {
  projectId: string;
  kind: TaskKind;
  title: string;
  description?: string;
  jiraKey?: string;
  baseBranch?: string;
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
  private readonly agent: AgentAdapter;
  private readonly dataDir: string;
  private readonly clock: () => Date;
  private readonly runs = new Map<string, RunState>();
  private readonly busy = new Set<string>();
  private readonly testProcs = new Map<string, { kill: () => void }>();

  constructor(deps: TaskManagerDeps) {
    super();
    this.store = deps.store;
    this.agent = deps.agent;
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
    const worktreePath = join(this.worktreesRoot, `${slugify(project.name)}-${id}`);

    let baseSha: string;
    try {
      baseSha = await addWorktree(info.root, worktreePath, branch, base);
    } catch (err) {
      throw new HttpError(400, `创建工作区失败：${(err as Error).message}`);
    }

    const notes: string[] = [];
    if (project.linkNodeModules) {
      const note = await linkNodeModules(info.root, worktreePath);
      if (note) notes.push(note);
    }

    const now = this.nowIso();
    const task: Task = {
      id,
      projectId: project.id,
      kind: input.kind,
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
    const prompt = task.pendingPrompt ?? CONTINUE_PROMPT;
    task.pendingPrompt = undefined;
    task.runCount += 1;
    task.status = 'running';
    task.lastError = undefined;

    const dir = join(this.dataDir, 'tasks', task.id);
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(buildClaudeSettings(project, task.approvedRules), null, 2), 'utf8');

    this.log(task, { type: 'prompt', run: task.runCount, text: clip(prompt, MAX_TEXT) });

    const run: RunState = { stopRequested: false, toolUses: new Map() };
    this.runs.set(task.id, run);
    try {
      run.proc = this.agent.start(
        {
          cwd: task.worktreePath,
          prompt,
          sessionId: task.sessionId,
          resume: task.sessionStarted,
          settingsPath,
          model: settings.model || undefined,
          maxBudgetUsd: settings.maxBudgetUsd,
          claudePath: settings.claudePath || undefined,
        },
        (m) => this.onMessage(task, run, m),
      );
    } catch (err) {
      this.runs.delete(task.id);
      this.failTask(task, `无法启动 Claude：${(err as Error).message}`);
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
    return result.text.trim() || `Claude 没有正常完成（${result.subtype || '未知原因'}）`;
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
      if (!(await ghVersion())) throw new HttpError(400, '找不到 gh 命令。请安装 GitHub CLI 并执行 gh auth login');

      try {
        await pushBranch(task.worktreePath, task.branch);
      } catch (err) {
        throw new HttpError(502, `推送失败：${(err as Error).message}`);
      }
      this.note(task, `已推送分支 ${task.branch}`);
      let url: string;
      try {
        url = await createPullRequest(task.worktreePath, {
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
      task.status = 'pr_opened';
      this.note(task, `已创建 PR：${url}`);
      this.touch(task);
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
      this.testProcs.get(taskId)?.kill();
      const project = this.store.data.projects.find((p) => p.id === task.projectId);
      const repo = project?.path ?? '';
      try {
        await removeWorktree(repo || this.dataDir, task.worktreePath, task.branch, this.worktreesRoot);
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
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-200_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      output += `\n（超过 ${TEST_TIMEOUT_MS / 60000} 分钟，已终止）`;
      killTree(child);
    }, TEST_TIMEOUT_MS);
    this.testProcs.set(taskId, { kill: () => killTree(child) });

    child.on('close', (code) => {
      clearTimeout(timer);
      this.testProcs.delete(taskId);
      task.test = {
        status: code === 0 ? 'passed' : 'failed',
        command,
        exitCode: code,
        output: output.replace(ANSI, ''),
        startedAt: task.test?.startedAt ?? this.nowIso(),
        durationMs: Date.now() - started,
      };
      this.touch(task);
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
    });
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
