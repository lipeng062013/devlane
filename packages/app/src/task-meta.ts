import { HttpError, type TaskPriority } from './domain';

const MAX_TAG_LEN = 32;
const MAX_TAGS = 10;

/** 规范化本地标签：trim、拒空、≤32 字、最多 10 个、大小写不敏感去重（保留先写形式）。 */
export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    if (t.length > MAX_TAG_LEN) {
      throw new HttpError(400, `单个标签不能超过 ${MAX_TAG_LEN} 字`);
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function normalizePriority(input: unknown): TaskPriority {
  if (input === 'high' || input === 'medium' || input === 'low' || input === 'none') return input;
  return 'none';
}

/** Jira priority 名 → 本地 priority（仅建任务预填，零写回）。 */
export function mapJiraPriority(name: string | undefined | null): TaskPriority {
  if (!name) return 'none';
  const s = name.trim();
  if (/Highest|High|最高/i.test(s)) return 'high';
  if (/^高$|高优先/i.test(s) || (s.includes('高') && !/中|低/.test(s))) return 'high';
  if (/Medium|中/i.test(s)) return 'medium';
  if (/Lowest|Low|低/i.test(s)) return 'low';
  return 'none';
}

export function coerceTaskTags(task: { tags?: string[] }): string[] {
  return Array.isArray(task.tags) ? task.tags : [];
}

export function coerceTaskPriority(task: { priority?: TaskPriority }): TaskPriority {
  return normalizePriority(task.priority);
}
