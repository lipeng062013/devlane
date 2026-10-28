import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NewTimelineItem, TimelineItem } from './domain';

const MAX_READ = 5000;

/** 每个任务一份 JSONL 时间线日志，追加写入，重启后可以回放。 */
export class TimelineLog {
  private readonly seqs = new Map<string, number>();

  constructor(private readonly root: string) {}

  private file(taskId: string): string {
    return join(this.root, 'tasks', taskId, 'log.jsonl');
  }

  private lastSeq(taskId: string): number {
    const cached = this.seqs.get(taskId);
    if (cached !== undefined) return cached;
    const items = this.read(taskId, 0);
    const last = items.length > 0 ? items[items.length - 1]!.seq : 0;
    this.seqs.set(taskId, last);
    return last;
  }

  append(taskId: string, item: NewTimelineItem, ts: string): TimelineItem {
    const seq = this.lastSeq(taskId) + 1;
    const full = { ...item, seq, ts } as TimelineItem;
    const file = this.file(taskId);
    mkdirSync(join(this.root, 'tasks', taskId), { recursive: true });
    appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
    this.seqs.set(taskId, seq);
    return full;
  }

  read(taskId: string, after = 0): TimelineItem[] {
    const file = this.file(taskId);
    if (!existsSync(file)) return [];
    const items: TimelineItem[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const item = JSON.parse(line) as TimelineItem;
        if (item.seq > after) items.push(item);
      } catch {
        /* 跳过损坏的行 */
      }
    }
    return items.length > MAX_READ ? items.slice(-MAX_READ) : items;
  }
}
