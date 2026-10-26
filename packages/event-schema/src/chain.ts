import { createHash } from 'node:crypto';
import type { LaneEvent, NewEvent } from './types';
import { EVENT_TYPES } from './types';
import { validatePayload } from './payload';

export const GENESIS_HASH = '0'.repeat(64);

/** 稳定序列化：对象键按字典序排列，保证同一内容得到同一哈希。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashEvent(event: LaneEvent): string {
  return createHash('sha256').update(stableStringify(event)).digest('hex');
}

export class EventValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'EventValidationError';
  }
}

/** 在 last 之后追加一个新事件，返回带 seq 与 prevHash 的完整事件。 */
export function appendEvent(last: LaneEvent | null, input: NewEvent): LaneEvent {
  const errors: string[] = [];
  if (!EVENT_TYPES.includes(input.type)) errors.push(`未知事件类型 ${String(input.type)}`);
  else errors.push(...validatePayload(input.type, input.payload));
  if (last && last.laneId !== input.laneId) errors.push('laneId 与上一事件不一致');
  if (errors.length > 0) throw new EventValidationError(errors);

  return {
    ...input,
    seq: last ? last.seq + 1 : 1,
    prevHash: last ? hashEvent(last) : GENESIS_HASH,
  };
}

export interface ChainCheck {
  ok: boolean;
  brokenAtSeq?: number;
  reason?: string;
}

/** 校验 seq 连续且 prevHash 与前一事件哈希一致。 */
export function verifyChain(events: LaneEvent[]): ChainCheck {
  for (let i = 0; i < events.length; i++) {
    const current = events[i]!;
    const prev = i > 0 ? events[i - 1]! : null;
    if (current.seq !== (prev ? prev.seq + 1 : 1)) {
      return { ok: false, brokenAtSeq: current.seq, reason: 'seq 不连续' };
    }
    const expected = prev ? hashEvent(prev) : GENESIS_HASH;
    if (current.prevHash !== expected) {
      return { ok: false, brokenAtSeq: current.seq, reason: 'prevHash 不匹配' };
    }
  }
  return { ok: true };
}
