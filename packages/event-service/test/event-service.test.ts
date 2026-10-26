import { describe, expect, it, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { EventService } from '../src/index';
import type { NewEvent } from '@devlane/event-schema';

const testDb = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

function makeEvent(laneId: string, type: 'commit' | 'test_pass' | 'test_fail' = 'commit', id = `E${Date.now()}`): NewEvent {
  const payloads: Record<string, Record<string, unknown>> = {
    commit: { sha: 'abc', message: 'test', additions: 1, deletions: 0 },
    test_pass: { command: 'npm test', exitCode: 0, durationMs: 100 },
    test_fail: { command: 'npm test', exitCode: 1, durationMs: 150, attempt: 1 },
  };
  return {
    id,
    laneId,
    runId: 'run-1',
    parentIds: [],
    type,
    actor: { kind: 'agent', id: 'a1' },
    ts: new Date().toISOString(),
    payload: payloads[type] ?? {},
    artifactIds: [],
  };
}

describe('EventService', () => {
  const dbs: string[] = [];
  afterEach(() => {
    dbs.forEach((p) => {
      try {
        unlinkSync(p);
      } catch {}
    });
    dbs.length = 0;
  });

  it('初始化时创建表', () => {
    const path = testDb();
    dbs.push(path);
    const svc = new EventService({ dbPath: path });
    expect(svc.getLast('lane-x')).toBeNull();
    svc.close();
  });

  it('追加事件后 seq 从 1 开始递增，prevHash 指向上一事件', () => {
    const path = testDb();
    dbs.push(path);
    const svc = new EventService({ dbPath: path });
    const e1 = svc.append(makeEvent('lane-1'));
    const e2 = svc.append(makeEvent('lane-1'));
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    // prevHash 由 event-schema 包的 hashEvent 计算，此处只验证非空且长度正确
    expect(e2.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e2.prevHash).not.toBe(e1.prevHash);
    svc.close();
  });

  it('不同 lane 的 seq 独立', () => {
    const path = testDb();
    dbs.push(path);
    const svc = new EventService({ dbPath: path });
    const a1 = svc.append(makeEvent('lane-a'));
    const b1 = svc.append(makeEvent('lane-b'));
    const a2 = svc.append(makeEvent('lane-a'));
    expect(a1.seq).toBe(1);
    expect(b1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    svc.close();
  });

  it('分页查询按 seq 升序返回', () => {
    const path = testDb();
    dbs.push(path);
    const svc = new EventService({ dbPath: path });
    for (let i = 0; i < 5; i++) svc.append(makeEvent('lane-1', 'commit', `E${i}`));
    const page1 = svc.list('lane-1', 0, 2);
    const page2 = svc.list('lane-1', page1[page1.length - 1]!.seq, 2);
    expect(page1.map((e) => e.seq)).toEqual([1, 2]);
    expect(page2.map((e) => e.seq)).toEqual([3, 4]);
    svc.close();
  });

  it('verifyLane 检测哈希链完整性', () => {
    const path = testDb();
    dbs.push(path);
    const svc = new EventService({ dbPath: path });
    svc.append(makeEvent('lane-1'));
    svc.append(makeEvent('lane-1'));
    expect(svc.verifyLane('lane-1')).toEqual({ ok: true });
    svc.close();
  });

  it('getLast 返回最新事件', () => {
    const path = testDb();
    dbs.push(path);
    const svc = new EventService({ dbPath: path });
    svc.append(makeEvent('lane-1', 'commit', 'E1'));
    const e2 = svc.append(makeEvent('lane-1', 'test_pass', 'E2'));
    expect(svc.getLast('lane-1')?.id).toBe('E2');
    expect(svc.getLast('lane-1')?.type).toBe('test_pass');
    svc.close();
  });
});
