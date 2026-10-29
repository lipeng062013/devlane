import { HttpError, type Project, type Settings } from './domain';
import { inspectRepo } from './git';
import { isValidModel } from './claude';
import { normalizeBaseUrl } from './jira';
import type { StateStore } from './store';

export interface ProjectInput {
  path?: string;
  name?: string;
  baseBranch?: string;
  testCommand?: string;
  extraAllowed?: string[];
  linkNodeModules?: boolean;
}

function validBranch(name: string): boolean {
  return /^[\w./@-]+$/.test(name);
}

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].slice(0, 30);
}

export async function addProject(store: StateStore, input: ProjectInput, now: string): Promise<Project> {
  const info = await inspectRepo(input.path ?? '');
  if (!info.hasCommits) throw new HttpError(400, '这个仓库还没有任何提交，请先做一次初始提交');
  const existing = store.data.projects.find((p) => p.path.toLowerCase() === info.root.toLowerCase());
  if (existing) throw new HttpError(409, `这个仓库已经添加过了（${existing.name}）`);

  const baseBranch = (input.baseBranch ?? info.suggestedBase).trim();
  if (!validBranch(baseBranch)) throw new HttpError(400, `基线分支名不合法：${baseBranch}`);
  const folderName = info.root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  const name = (input.name ?? '').trim() || folderName;
  if (name.length > 80) throw new HttpError(400, '项目名不能超过 80 字');

  const project: Project = {
    id: `P${store.nextId('project')}`,
    name,
    path: info.root,
    baseBranch,
    testCommand: (input.testCommand ?? '').trim().slice(0, 500),
    extraAllowed: cleanList(input.extraAllowed),
    linkNodeModules: input.linkNodeModules ?? true,
    createdAt: now,
  };
  store.data.projects.push(project);
  store.save();
  return project;
}

export function updateProject(store: StateStore, id: string, input: ProjectInput): Project {
  const project = store.data.projects.find((p) => p.id === id);
  if (!project) throw new HttpError(404, `项目 ${id} 不存在`);
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new HttpError(400, '项目名需要 1 到 80 字');
    project.name = name;
  }
  if (input.baseBranch !== undefined) {
    const b = input.baseBranch.trim();
    if (!validBranch(b)) throw new HttpError(400, `基线分支名不合法：${b}`);
    project.baseBranch = b;
  }
  if (input.testCommand !== undefined) project.testCommand = input.testCommand.trim().slice(0, 500);
  if (input.extraAllowed !== undefined) project.extraAllowed = cleanList(input.extraAllowed);
  if (input.linkNodeModules !== undefined) project.linkNodeModules = Boolean(input.linkNodeModules);
  store.save();
  return project;
}

export function removeProject(store: StateStore, id: string): void {
  const project = store.data.projects.find((p) => p.id === id);
  if (!project) throw new HttpError(404, `项目 ${id} 不存在`);
  const live = store.data.tasks.filter((t) => t.projectId === id && t.status !== 'discarded');
  if (live.length > 0) {
    throw new HttpError(409, `还有 ${live.length} 个任务没有丢弃，请先处理（丢弃会清理它们的工作区）`);
  }
  store.data.projects = store.data.projects.filter((p) => p.id !== id);
  store.data.tasks = store.data.tasks.filter((t) => t.projectId !== id);
  store.save();
}

// ---------- 设置 ----------

export interface SettingsInput {
  claudePath?: string;
  codexPath?: string;
  grokBuildPath?: string;
  model?: string;
  maxBudgetUsd?: number;
  maxConcurrent?: number;
  editorCommand?: string;
}

export function updateSettings(store: StateStore, input: SettingsInput): Settings {
  const s = store.data.settings;
  if (input.claudePath !== undefined) s.claudePath = input.claudePath.trim().replace(/^"|"$/g, '') || undefined;
  if (input.codexPath !== undefined) s.codexPath = input.codexPath.trim().replace(/^"|"$/g, '') || undefined;
  if (input.grokBuildPath !== undefined) s.grokBuildPath = input.grokBuildPath.trim().replace(/^"|"$/g, '') || undefined;
  if (input.model !== undefined) {
    const model = input.model.trim();
    if (model && !isValidModel(model)) throw new HttpError(400, '模型名包含不允许的字符');
    s.model = model || undefined;
  }
  if (input.maxBudgetUsd !== undefined) {
    const v = Number(input.maxBudgetUsd);
    if (!Number.isFinite(v) || v < 0.1 || v > 100) throw new HttpError(400, '单次预算需要在 0.1 到 100 美元之间');
    s.maxBudgetUsd = v;
  }
  if (input.maxConcurrent !== undefined) {
    const v = Number(input.maxConcurrent);
    if (!Number.isInteger(v) || v < 1 || v > 8) throw new HttpError(400, '同时运行的任务数需要在 1 到 8 之间');
    s.maxConcurrent = v;
  }
  if (input.editorCommand !== undefined) {
    const v = input.editorCommand.trim();
    if (!/^[\w.-]+$/.test(v)) throw new HttpError(400, '编辑器命令只能是一个程序名，例如 code');
    s.editorCommand = v;
  }
  store.save();
  return s;
}

export interface JiraInput {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  defaultJql?: string;
  writeEnabled?: boolean;
}

export function updateJira(store: StateStore, input: JiraInput): void {
  const current = store.data.settings.jira;
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? current?.baseUrl ?? '');
  const email = (input.email ?? current?.email ?? '').trim();
  if (!email.includes('@')) throw new HttpError(400, '请填写 Jira 登录邮箱');
  // 不填 Token 表示保持原来的
  const apiToken = input.apiToken?.trim() || current?.apiToken || '';
  if (!apiToken) throw new HttpError(400, '请填写 API Token');
  const writeEnabled =
    input.writeEnabled !== undefined ? Boolean(input.writeEnabled) : Boolean(current?.writeEnabled);
  store.data.settings.jira = {
    baseUrl,
    email,
    apiToken,
    defaultJql: input.defaultJql?.trim() || undefined,
    writeEnabled,
  };
  store.save();
}

/** 返回给界面的设置：永远不带 Token。 */
export function publicSettings(settings: Settings): Record<string, unknown> {
  const { jira, ...rest } = settings;
  return {
    ...rest,
    jira: jira
      ? {
          baseUrl: jira.baseUrl,
          email: jira.email,
          hasToken: Boolean(jira.apiToken),
          defaultJql: jira.defaultJql ?? '',
          writeEnabled: Boolean(jira.writeEnabled),
        }
      : null,
  };
}
