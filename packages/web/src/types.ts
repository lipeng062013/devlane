export type TaskKind = 'bug' | 'feature';

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
  path: string;
  baseBranch: string;
  testCommand: string;
  extraAllowed: string[];
  linkNodeModules: boolean;
  createdAt: string;
}

export interface Denial {
  id: string;
  tool: string;
  command?: string;
  detail: string;
  status: 'pending' | 'allowed' | 'ignored';
  allowable: boolean;
  rule?: string;
}

export interface TestRun {
  status: 'running' | 'passed' | 'failed';
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
  title: string;
  description: string;
  jiraKey?: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  status: TaskStatus;
  runCount: number;
  costUsd: number;
  turns: number;
  denials: Denial[];
  lastError?: string;
  commitSha?: string;
  prUrl?: string;
  test?: TestRun;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export type TimelineItem =
  | { seq: number; ts: string; type: 'prompt'; run: number; text: string }
  | { seq: number; ts: string; type: 'text'; text: string }
  | { seq: number; ts: string; type: 'tool'; toolUseId: string; name: string; summary: string; detail?: string }
  | { seq: number; ts: string; type: 'tool_result'; toolUseId: string; ok: boolean; text: string }
  | { seq: number; ts: string; type: 'denied'; toolUseId: string; tool: string; summary: string }
  | { seq: number; ts: string; type: 'result'; ok: boolean; text: string; costUsd: number; turns: number; durationMs: number }
  | { seq: number; ts: string; type: 'note'; level: 'info' | 'error'; text: string };

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface ChangeSet {
  files: FileChange[];
  patch: string;
  truncated: boolean;
}

export interface RepoInfo {
  root: string;
  currentBranch: string | null;
  suggestedBase: string;
  branches: string[];
  remotes: string[];
  dirty: boolean;
  dirtyCount: number;
  hasCommits: boolean;
}

export interface PublicSettings {
  claudePath?: string;
  model?: string;
  maxBudgetUsd: number;
  maxConcurrent: number;
  editorCommand: string;
  jira: { baseUrl: string; email: string; hasToken: boolean; defaultJql: string } | null;
}

export interface AppState {
  projects: Project[];
  tasks: Task[];
  settings: PublicSettings;
}

export interface EnvInfo {
  claude: string | null;
  git: string | null;
  gh: string | null;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  type: string;
  status: string;
  statusCategory: string;
  priority?: string;
  assignee?: string;
  updated: string;
  url: string;
}

export interface JiraIssueDetail extends JiraIssueSummary {
  description: string;
  reporter?: string;
  labels: string[];
  components: string[];
  comments: Array<{ author: string; created: string; body: string }>;
}

export interface NewTaskInput {
  projectId: string;
  kind: TaskKind;
  title: string;
  description?: string;
  jiraKey?: string;
  baseBranch?: string;
}

export interface TaskDraft {
  kind?: TaskKind;
  title?: string;
  description?: string;
  jiraKey?: string;
}
