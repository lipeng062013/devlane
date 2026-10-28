import type { Gate, Issue, Lane, LaneAction, NewIssueInput, Snapshot } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; details?: unknown };
    throw new ApiError(res.status, obj.error ?? `请求失败 (HTTP ${res.status})`, obj.details);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: string }>('GET', '/api/me'),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),
  snapshot: () => request<Snapshot>('GET', '/api/snapshot'),
  createIssue: (input: NewIssueInput) => request<Issue>('POST', '/api/issues', input),
  createLane: (issueId: string) => request<Lane>('POST', `/api/issues/${encodeURIComponent(issueId)}/lane`),
  act: (laneId: string, action: LaneAction) =>
    request<Lane>('POST', `/api/lanes/${encodeURIComponent(laneId)}/actions`, { action }),
  resolveGate: (gateId: string, decision: 'approve' | 'reject') =>
    request<Gate>('POST', `/api/gates/${encodeURIComponent(gateId)}/resolve`, { decision }),
  verify: (laneId: string) =>
    request<{ ok: boolean; brokenAtSeq?: number; reason?: string; events: number }>(
      'GET',
      `/api/lanes/${encodeURIComponent(laneId)}/verify`,
    ),
  importJira: () => request<{ fetched: number; created: number; updated: number }>('POST', '/api/jira/import', {}),
};
