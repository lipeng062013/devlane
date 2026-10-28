import type {
  AppState,
  ChangeSet,
  EnvInfo,
  JiraIssueDetail,
  JiraIssueSummary,
  NewTaskInput,
  Project,
  PublicSettings,
  RepoInfo,
  Task,
  TimelineItem,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, url: string, body?: unknown): Promise<T> {
  const isWrite = method !== 'GET';
  const res = await fetch(url, {
    method,
    headers: isWrite ? { 'Content-Type': 'application/json', 'x-devlane': '1' } : undefined,
    body: isWrite ? JSON.stringify(body ?? {}) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface JiraListResult {
  jql: string;
  issues: JiraIssueSummary[];
  nextPageToken?: string;
}

export interface ProjectInput {
  path?: string;
  name?: string;
  baseBranch?: string;
  testCommand?: string;
  extraAllowed?: string[];
  linkNodeModules?: boolean;
}

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  env: (refresh = false) => request<EnvInfo>('GET', `/api/env${refresh ? '?refresh=1' : ''}`),

  inspectRepo: (path: string) => request<RepoInfo>('POST', '/api/projects/inspect', { path }),
  addProject: (input: ProjectInput) => request<Project>('POST', '/api/projects', input),
  updateProject: (id: string, input: ProjectInput) => request<Project>('PATCH', `/api/projects/${enc(id)}`, input),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', `/api/projects/${enc(id)}`),

  createTask: (input: NewTaskInput) => request<Task>('POST', '/api/tasks', input),
  timeline: (id: string, after = 0) => request<{ items: TimelineItem[] }>('GET', `/api/tasks/${enc(id)}/timeline?after=${after}`),
  changes: (id: string) => request<ChangeSet>('GET', `/api/tasks/${enc(id)}/changes`),
  message: (id: string, text: string) => request<Task>('POST', `/api/tasks/${enc(id)}/message`, { text }),
  allow: (id: string, denialIds: string[], mode: 'exact' | 'prefix') =>
    request<Task>('POST', `/api/tasks/${enc(id)}/allow`, { denialIds, mode }),
  ignore: (id: string) => request<Task>('POST', `/api/tasks/${enc(id)}/ignore`),
  stop: (id: string) => request<Task>('POST', `/api/tasks/${enc(id)}/stop`),
  runTests: (id: string) => request<Task>('POST', `/api/tasks/${enc(id)}/test`),
  stopTests: (id: string) => request<Task>('POST', `/api/tasks/${enc(id)}/test/stop`),
  commit: (id: string, message: string) => request<Task>('POST', `/api/tasks/${enc(id)}/commit`, { message }),
  openPr: (id: string, title: string, body: string) => request<Task>('POST', `/api/tasks/${enc(id)}/pr`, { title, body }),
  discard: (id: string) => request<Task>('POST', `/api/tasks/${enc(id)}/discard`),
  openEditor: (id: string) => request<{ ok: true }>('POST', `/api/tasks/${enc(id)}/open-editor`),

  saveSettings: (input: Record<string, unknown>) => request<PublicSettings>('PUT', '/api/settings', input),
  saveJira: (input: Record<string, unknown>) => request<PublicSettings>('PUT', '/api/settings/jira', input),
  clearJira: () => request<PublicSettings>('DELETE', '/api/settings/jira'),
  testJira: () => request<{ ok: true; user: { name: string; email?: string } }>('POST', '/api/jira/test'),
  jiraIssues: (params: { scope?: string; q?: string; jql?: string; pageToken?: string }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<JiraListResult>('GET', `/api/jira/issues?${qs.toString()}`);
  },
  jiraIssue: (key: string) => request<JiraIssueDetail>('GET', `/api/jira/issues/${enc(key)}`),
};
