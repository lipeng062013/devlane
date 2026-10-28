import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateRecord, Issue, LaneRecord } from './domain';

export interface StateData {
  seq: { issue: number; lane: number; gate: number; pr: number };
  issues: Issue[];
  lanes: LaneRecord[];
  gates: GateRecord[];
}

function emptyState(): StateData {
  return { seq: { issue: 100, lane: 0, gate: 0, pr: 0 }, issues: [], lanes: [], gates: [] };
}

/**
 * 看板元数据（需求、泳道、门禁）的 JSON 文件存储。
 * 事件本身不在这里，由 EventService 持有。
 */
export class StateStore {
  readonly data: StateData;

  constructor(private readonly path?: string) {
    this.data = this.load();
  }

  private load(): StateData {
    if (!this.path || !existsSync(this.path)) return emptyState();
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateData>;
    const base = emptyState();
    return {
      seq: { ...base.seq, ...parsed.seq },
      issues: parsed.issues ?? [],
      lanes: parsed.lanes ?? [],
      gates: parsed.gates ?? [],
    };
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  nextId(kind: keyof StateData['seq']): number {
    this.data.seq[kind] += 1;
    return this.data.seq[kind];
  }
}
