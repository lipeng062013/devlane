import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  EventValidationError,
  GENESIS_HASH,
  hashEvent,
  validatePayload,
  verifyChain,
} from '../src/index';
import type { LaneEvent, NewEvent } from '../src/index';

function commitInput(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    id: '01TEST',
    laneId: 'lane-1',
    runId: 'run-1',
    parentIds: [],
    type: 'commit',
    actor: { kind: 'agent', id: 'agent-1', model: 'm1' },
    ts: '2026-10-27T10:00:00.000Z',
    payload: { sha: 'abc1234', message: 'init', additions: 3, deletions: 1 },
    artifactIds: [],
    ...overrides,
  };
}

function buildChain(n: number): LaneEvent[] {
  const events: LaneEvent[] = [];
  let last: LaneEvent | null = null;
  for (let i = 0; i < n; i++) {
    last = appendEvent(last, commitInput({ id: `E${i}` }));
    events.push(last);
  }
  return events;
}

describe('validatePayload', () => {
  it('合法 payload 返回空错误列表', () => {
    expect(validatePayload('commit', commitInput().payload)).toEqual([]);
  });

  it('报告缺失字段', () => {
    const errors = validatePayload('commit', { sha: 'x' });
    expect(errors).toContain('commit: 缺少字段 message');
    expect(errors).toContain('commit: 缺少字段 additions');
  });

  it('报告类型错误', () => {
    const errors = validatePayload('test_fail', {
      command: 'npm test',
      exitCode: '1',
      durationMs: 10,
      attempt: 1,
    });
    expect(errors).toEqual(['test_fail: 字段 exitCode 应为 number，实际为 string']);
  });

  it('拒绝 NaN 数值', () => {
    const errors = validatePayload('retry', { attempt: Number.NaN, reason: 'x' });
    expect(errors).toHaveLength(1);
  });
});

describe('appendEvent', () => {
  it('首个事件 seq 为 1 且 prevHash 为创世哈希', () => {
    const first = appendEvent(null, commitInput());
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
  });

  it('后续事件 seq 递增且 prevHash 指向上一事件', () => {
    const [first, second] = buildChain(2) as [LaneEvent, LaneEvent];
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(hashEvent(first));
  });

  it('payload 不合法时抛出 EventValidationError', () => {
    expect(() => appendEvent(null, commitInput({ payload: {} }))).toThrow(EventValidationError);
  });

  it('跨 lane 追加被拒绝', () => {
    const first = appendEvent(null, commitInput());
    expect(() => appendEvent(first, commitInput({ laneId: 'lane-2' }))).toThrow(
      EventValidationError,
    );
  });
});

describe('hashEvent', () => {
  it('对象键顺序不同时哈希一致', () => {
    const a = appendEvent(null, commitInput({ payload: { sha: 's', message: 'm', additions: 1, deletions: 2 } }));
    const b: LaneEvent = {
      ...a,
      payload: { deletions: 2, additions: 1, message: 'm', sha: 's' },
    };
    expect(hashEvent(a)).toBe(hashEvent(b));
  });
});

describe('verifyChain', () => {
  it('完整链通过校验', () => {
    expect(verifyChain(buildChain(5))).toEqual({ ok: true });
  });

  it('空链通过校验', () => {
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('篡改中间事件后在下一事件处报错', () => {
    const events = buildChain(4);
    events[1] = { ...events[1]!, payload: { ...events[1]!.payload, message: '被改动' } };
    expect(verifyChain(events)).toEqual({
      ok: false,
      brokenAtSeq: 3,
      reason: 'prevHash 不匹配',
    });
  });

  it('缺失事件导致 seq 不连续', () => {
    const events = buildChain(4);
    events.splice(1, 1);
    expect(verifyChain(events)).toEqual({ ok: false, brokenAtSeq: 3, reason: 'seq 不连续' });
  });
});
