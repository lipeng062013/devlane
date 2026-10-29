export type AgentProvider = 'claude' | 'codex' | 'grok-build';

export function normalizeAgentProvider(v: unknown): AgentProvider {
  return v === 'codex' || v === 'grok-build' || v === 'claude' ? v : 'claude';
}

export type PrCheckCi = 'success' | 'pending' | 'failure' | 'none' | 'unknown';
export type PrCheckMerge = 'merged' | 'mergeable' | 'blocked' | 'closed' | 'unknown';
export interface PrCheckSnapshot {
  refreshedAt: string;
  prNumber?: number;
  ci: PrCheckCi;
  merge: PrCheckMerge;
  mergeDetail?: string;
  lastError?: string;
}
export type TaskKind = 'bug' | 'feature';

export type TaskPriority = 'high' | 'medium' | 'low' | 'none';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'needs_you'
  | 'review'
  | 'stopped'
  | 'failed'
  | 'committed'
  | 'pr_opened'
  | 'discarded';

export interface Project {
  id: string;
  name: string;
  /** 仓库根目录（绝对路径）。 */
  path: string;
  baseBranch: string;
  testCommand: string;
  /** 额外允许 Claude 执行的命令，如 `npm run lint`。每条会变成一条 Bash 允许规则。 */
  extraAllowed: string[];
  /** 把主仓库的 node_modules 链接进每个任务的 worktree，省去重新安装。 */
  linkNodeModules: boolean;
  createdAt: string;
}

export interface Denial {
  /** 即 Claude 的 tool_use_id。 */
  id: string;
  tool: string;
  /** Bash 的完整命令；其他工具为空。 */
  command?: string;
  detail: string;
  status: 'pending' | 'allowed' | 'ignored';
  /** 是否能通过「允许」放行（只有简单的 Bash 命令可以）。 */
  allowable: boolean;
  rule?: string;
}

export interface TestRun {
  status: 'running' | 'passed' | 'failed' | 'stopped';
  command: string;
  exitCode: number | null;
  output: string;
  startedAt: string;
  durationMs: number | null;
}

export interface Task {
  id: string;
  projectId: string;
  kind: TaskKind;
  /** 执行该任务的 Agent；旧数据缺省按 claude 读 */
  agentProvider: AgentProvider;
  title: string;
  description: string;
  jiraKey?: string;
  /** local tags (independent of Jira, no write-back) */
  tags: string[];
  /** local priority (independent of Jira, no write-back) */
  priority: TaskPriority;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  status: TaskStatus;
  /** Claude 会话 id，追问时用 --resume 续接。 */
  sessionId: string;
  /** 是否已经和 Claude 建立过会话（决定下一次用 --session-id 还是 --resume）。 */
  sessionStarted: boolean;
  /** 等待发送给 Claude 的下一条指令。 */
  pendingPrompt?: string;
  runCount: number;
  costUsd: number;
  turns: number;
  denials: Denial[];
  /** 你批准过的 Bash 规则。 */
  approvedRules: string[];
  lastError?: string;
  commitSha?: string;
  prUrl?: string;
  prNumber?: number;
  prCheck?: PrCheckSnapshot;
  /** Jira 评论回写状态（本刀仅评论，无 transition） */
  jiraWrite?: { lastFingerprint?: string; lastError?: string; lastAt?: string };
  test?: TestRun;
  /** 创建 worktree 时附带的提示（例如 node_modules 未能链接）。 */
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JiraSettings {
  baseUrl: string;
  email: string;
  apiToken: string;
  defaultJql?: string;
  /** 允许把进展以评论回写到 Jira；缺省视为 false */
  writeEnabled?: boolean;
}

export interface Settings {
  claudePath?: string;
  codexPath?: string;
  grokBuildPath?: string;
  model?: string;
  maxBudgetUsd: number;
  maxConcurrent: number;
  editorCommand: string;
  jira?: JiraSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  maxBudgetUsd: 3,
  maxConcurrent: 2,
  editorCommand: 'code',
};

/** 携带 HTTP 状态码的错误，路由层据此返回响应。 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type TimelineItem =
  | { seq: number; ts: string; type: 'prompt'; run: number; text: string }
  | { seq: number; ts: string; type: 'text'; text: string }
  | { seq: number; ts: string; type: 'tool'; toolUseId: string; name: string; summary: string; detail?: string }
  | { seq: number; ts: string; type: 'tool_result'; toolUseId: string; ok: boolean; text: string }
  | { seq: number; ts: string; type: 'denied'; toolUseId: string; tool: string; summary: string }
  | {
      seq: number;
      ts: string;
      type: 'result';
      ok: boolean;
      text: string;
      costUsd: number;
      turns: number;
      durationMs: number;
    }
  | { seq: number; ts: string; type: 'note'; level: 'info' | 'error'; text: string };

/** 去掉 seq 和 ts 的时间线条目，由写入方补齐。 */
export type NewTimelineItem = TimelineItem extends infer T ? (T extends unknown ? Omit<T, 'seq' | 'ts'> : never) : never;
