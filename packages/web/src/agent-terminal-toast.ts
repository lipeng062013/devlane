import type { Task, TaskStatus } from './types';
import { STATUS_LABEL } from './util';

/** Statuses that trigger an in-app Agent terminal toast (running → these). */
export const TERMINAL_TOAST_STATUSES = ['review', 'needs_you', 'failed'] as const;
export type TerminalToastStatus = (typeof TERMINAL_TOAST_STATUSES)[number];

export type ToastLevel = 'info' | 'error';

export interface AgentTerminalToast {
  taskId: string;
  status: TerminalToastStatus;
  text: string;
  level: ToastLevel;
}

function isTerminalToastStatus(s: TaskStatus): s is TerminalToastStatus {
  return s === 'review' || s === 'needs_you' || s === 'failed';
}

/** Readable task name for toast copy: title, else jiraKey, else id. */
export function taskLabel(task: Pick<Task, 'id' | 'title' | 'jiraKey'>): string {
  const t = task.title?.trim();
  if (t) return t;
  const key = task.jiraKey?.trim();
  if (key) return key;
  return task.id;
}

/**
 * Pure edge detector: toast only when prev status was `running` and next is
 * review / needs_you / failed. Same-status refresh / poll / SSE reconnect
 * does not emit (caller must sync the map after).
 */
export function detectAgentTerminalToasts(
  prevMap: ReadonlyMap<string, TaskStatus>,
  nextTasks: ReadonlyArray<Pick<Task, 'id' | 'title' | 'jiraKey' | 'status'>>,
): AgentTerminalToast[] {
  const out: AgentTerminalToast[] = [];
  for (const task of nextTasks) {
    const prev = prevMap.get(task.id);
    if (prev !== 'running') continue;
    if (!isTerminalToastStatus(task.status)) continue;
    const label = taskLabel(task);
    const statusLabel = STATUS_LABEL[task.status];
    out.push({
      taskId: task.id,
      status: task.status,
      text: `「${label}」进入${statusLabel}`,
      level: task.status === 'failed' ? 'error' : 'info',
    });
  }
  return out;
}

/** After emitting toasts, sync prev map to current task statuses (and prune gone ids). */
export function syncStatusMap(
  prevMap: Map<string, TaskStatus>,
  nextTasks: ReadonlyArray<Pick<Task, 'id' | 'status'>>,
): void {
  const seen = new Set<string>();
  for (const task of nextTasks) {
    seen.add(task.id);
    prevMap.set(task.id, task.status);
  }
  for (const id of [...prevMap.keys()]) {
    if (!seen.has(id)) prevMap.delete(id);
  }
}
