import type { Task, TaskPriority } from './types';

export type TaskListFilters = {
  statusSeg: 'active' | 'all' | 'done';
  projectId: string;
  q: string;
  tag: string;
  priority: 'all' | TaskPriority;
};

export function statusSegMatches(task: Task, filter: TaskListFilters['statusSeg']): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return task.status === 'discarded' || task.status === 'pr_opened';
  return task.status !== 'discarded' && task.status !== 'pr_opened';
}

export function taskTags(task: Task): string[] {
  return Array.isArray(task.tags) ? task.tags : [];
}

export function taskPriority(task: Task): TaskPriority {
  const p = task.priority;
  return p === 'high' || p === 'medium' || p === 'low' || p === 'none' ? p : 'none';
}

/** Frontend instant filter: status x project x q x tag x priority intersection. */
export function taskMatchesFilters(task: Task, f: TaskListFilters): boolean {
  if (!statusSegMatches(task, f.statusSeg)) return false;
  if (f.projectId !== 'all' && task.projectId !== f.projectId) return false;
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = (task.title + '\n' + task.description + '\n' + (task.jiraKey ?? '')).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (f.tag !== 'all') {
    const tags = taskTags(task).map((t) => t.toLowerCase());
    if (!tags.includes(f.tag.toLowerCase())) return false;
  }
  if (f.priority !== 'all' && taskPriority(task) !== f.priority) return false;
  return true;
}

/** Union of tags appearing on current task list (keep first-seen form). */
export function collectTagOptions(tasks: Task[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    for (const t of taskTags(task)) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
  none: '无',
};

export function normalizeTagsClient(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    if (t.length > 32) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

export function mapJiraPriority(name: string | undefined | null): TaskPriority {
  if (!name) return 'none';
  const s = name.trim();
  if (/Highest|High|最高/i.test(s)) return 'high';
  if (/^高$|高优先/i.test(s) || (s.includes('高') && !/中|低/.test(s))) return 'high';
  if (/Medium|中/i.test(s)) return 'medium';
  if (/Lowest|Low|低/i.test(s)) return 'low';
  return 'none';
}
