import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventService } from '@devlane/event-service';
import { DomainError } from '../src/domain';
import { SimulatedExecutor } from '../src/executor';
import { Orchestrator } from '../src/orchestrator';
import { StateStore } from '../src/store';
import { makeHarness, tickUntil } from './helpers';

const BUG = 'DL-101';
const STORY = 'DL-102';
const TASK = 'DL-103';
const UNREADY_BUG = 'DL-104';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('开泳道', () => {
  it('就绪的需求可以开泳道，初始为 ready 并记录 branch 事件', async () => {
    const { orch, events } = await makeHarness();
    const lane = await orch.createLane(BUG, 'admin');
    expect(lane.state).toBe('ready');
    expect(lane.type).toBe('bug');
    const list = await events.list(lane.id);
    expect(list.map((e) => e.type)).toEqual(['branch']);
    expect(list[0]!.actor).toEqual({ kind: 'human', id: 'admin' });
  });

  it('未达到就绪阈值时拒绝，并返回缺失项', async () => {
    const { orch } = await makeHarness();
    const err = await orch.createLane(UNREADY_BUG, 'admin').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
    expect((err as DomainError).details).toMatchObject({ ready: false });
  });

  it('同一需求已有未终结泳道时拒绝重复开', async () => {
    const { orch } = await makeHarness();
    await orch.createLane(BUG, 'admin');
    const err = await orch.createLane(BUG, 'admin').catch((e: unknown) => e);
    expect((err as DomainError).status).toBe(409);
  });

  it('需求不存在返回 404', async () => {
    const { orch } = await makeHarness();
    const err = await orch.createLane('NOPE-1', 'admin').catch((e: unknown) => e);
    expect((err as DomainError).status).toBe(404);
  });
});

describe('缺陷流水线', () => {
  it('从排队一路执行到评审，红测阶段改业务代码被策略拒绝，事件哈希链完整', async () => {
    const { orch, store, events } = await makeHarness();
    const lane = await orch.createLane(BUG, 'admin');
    await orch.act(lane.id, 'queue', 'admin');
    await tickUntil(orch, () => store.data.lanes[0]!.state === 'reviewing');

    const list = await events.list(lane.id);
    const types = list.map((e) => e.type);
    expect(types).toContain('test_fail');
    expect(types).toContain('retry');
    expect(types).toContain('test_pass');
    expect(types).toContain('review_pass');

    const denied = list.find((e) => e.type === 'error' && e.payload.code === 'POLICY_DENY');
    expect(denied).toBeDefined();
    const deniedCall = list.find((e) => e.type === 'tool_call' && e.payload.decision === 'deny');
    expect(deniedCall).toBeDefined();

    expect(store.data.lanes[0]!.prUrl).toBe('simulated://pr/1');
    const check = await orch.verifyLane(lane.id);
    expect(check).toMatchObject({ ok: true, events: list.length });
  });

  it('评审通过后人工合并，泳道进入终态并记录 merge 事件', async () => {
    const { orch, store, events } = await makeHarness();
    const lane = await orch.createLane(BUG, 'admin');
    await orch.act(lane.id, 'queue', 'admin');
    await tickUntil(orch, () => store.data.lanes[0]!.state === 'reviewing');
    const merged = await orch.act(lane.id, 'merge', 'admin');
    expect(merged.state).toBe('merged');
    const last = await events.getLast(lane.id);
    expect(last).toMatchObject({ type: 'merge', payload: { prNumber: 1 } });
  });

  it('非评审状态不能合并', async () => {
    const { orch } = await makeHarness();
    const lane = await orch.createLane(BUG, 'admin');
    const err = await orch.act(lane.id, 'merge', 'admin').catch((e: unknown) => e);
    expect((err as DomainError).status).toBe(409);
  });
});

describe('门禁', () => {
  async function runToGate() {
    const h = await makeHarness();
    const lane = await h.orch.createLane(STORY, 'admin');
    await h.orch.act(lane.id, 'queue', 'admin');
    await tickUntil(h.orch, () => h.store.data.lanes[0]!.state === 'blocked');
    return { ...h, lane };
  }

  it('修改 package.json 触发高风险门禁，泳道进入 blocked 且不再前进', async () => {
    const { orch, store, events, lane } = await runToGate();
    const gate = store.data.gates[0]!;
    expect(gate).toMatchObject({ laneId: lane.id, gateType: 'high_risk_file', status: 'open' });
    expect(store.data.lanes[0]!.blockedGateId).toBe(gate.id);

    const before = (await events.list(lane.id)).length;
    await orch.tick();
    expect((await events.list(lane.id)).length).toBe(before);
  });

  it('批准后继续执行，被放行的步骤不会再次触发门禁', async () => {
    const { orch, store, events, lane } = await runToGate();
    const gate = store.data.gates[0]!;
    await orch.resolveGate(gate.id, 'approve', 'admin');
    expect(store.data.lanes[0]!.state).toBe('running');
    await tickUntil(orch, () => store.data.lanes[0]!.state === 'reviewing');
    expect(store.data.gates).toHaveLength(1);

    const list = await events.list(lane.id);
    const approvedCall = list.find((e) => e.type === 'tool_call' && e.payload.decision === 'approved');
    expect(approvedCall).toBeDefined();
    expect(list.some((e) => e.type === 'model_switch')).toBe(true);
    expect((await orch.verifyLane(lane.id)).ok).toBe(true);
  });

  it('拒绝后跳过该步骤并记录错误，流程继续', async () => {
    const { orch, store, events, lane } = await runToGate();
    await orch.resolveGate(store.data.gates[0]!.id, 'reject', 'admin');
    await tickUntil(orch, () => store.data.lanes[0]!.state === 'reviewing');
    const list = await events.list(lane.id);
    expect(list.some((e) => e.type === 'error' && e.payload.code === 'GATE_REJECTED')).toBe(true);
    // 被拒绝的步骤带有 package.json 的提交，不应出现
    expect(list.some((e) => e.type === 'commit' && String(e.payload.message).includes('增加运行依赖'))).toBe(false);
  });

  it('同一门禁不能重复处理', async () => {
    const { orch, store } = await runToGate();
    const id = store.data.gates[0]!.id;
    await orch.resolveGate(id, 'approve', 'admin');
    const err = await orch.resolveGate(id, 'approve', 'admin').catch((e: unknown) => e);
    expect((err as DomainError).status).toBe(409);
  });

  it('放弃处于阻塞的泳道时，门禁被取消', async () => {
    const { orch, store, lane } = await runToGate();
    await orch.act(lane.id, 'abandon', 'admin');
    expect(store.data.lanes[0]!.state).toBe('abandoned');
    expect(store.data.gates[0]!.status).toBe('cancelled');
  });
});

describe('调度', () => {
  it('并发上限为 1 时，同一轮只提升一条泳道', async () => {
    const { orch, store } = await makeHarness({ maxParallel: 1 });
    const a = await orch.createLane(BUG, 'admin');
    const b = await orch.createLane(TASK, 'admin');
    await orch.act(a.id, 'queue', 'admin');
    await orch.act(b.id, 'queue', 'admin');
    await orch.tick();
    const states = store.data.lanes.map((l) => l.state);
    expect(states.filter((s) => s === 'running')).toHaveLength(1);
    expect(states.filter((s) => s === 'queued')).toHaveLength(1);
  });

  it('前一条泳道进入评审后，排队的泳道开始运行', async () => {
    const { orch, store } = await makeHarness({ maxParallel: 1 });
    const a = await orch.createLane(TASK, 'admin');
    const b = await orch.createLane(BUG, 'admin');
    await orch.act(a.id, 'queue', 'admin');
    await orch.act(b.id, 'queue', 'admin');
    await tickUntil(orch, () => store.data.lanes.find((l) => l.id === b.id)!.state === 'running');
    expect(store.data.lanes.find((l) => l.id === a.id)!.state).toBe('reviewing');
  });

  it('暂停后不再前进，恢复后继续', async () => {
    const { orch, store, events } = await makeHarness();
    const lane = await orch.createLane(TASK, 'admin');
    await orch.act(lane.id, 'queue', 'admin');
    await orch.tick();
    await orch.act(lane.id, 'pause', 'admin');
    const count = (await events.list(lane.id)).length;
    await orch.tick();
    expect((await events.list(lane.id)).length).toBe(count);

    await orch.act(lane.id, 'resume', 'admin');
    await tickUntil(orch, () => store.data.lanes[0]!.state === 'reviewing');
  });

  it('非法状态迁移返回 409', async () => {
    const { orch } = await makeHarness();
    const lane = await orch.createLane(TASK, 'admin');
    const err = await orch.act(lane.id, 'pause', 'admin').catch((e: unknown) => e);
    expect((err as DomainError).status).toBe(409);
  });
});

describe('快照', () => {
  it('需求带就绪评分与进行中的泳道', async () => {
    const { orch } = await makeHarness();
    const lane = await orch.createLane(BUG, 'admin');
    const snap = await orch.snapshot();
    const bug = snap.issues.find((i) => i.id === BUG)!;
    const unready = snap.issues.find((i) => i.id === UNREADY_BUG)!;
    expect(bug.readiness).toMatchObject({ score: 100, ready: true });
    expect(bug.activeLaneId).toBe(lane.id);
    expect(unready.readiness.ready).toBe(false);
    expect(unready.readiness.missing.length).toBeGreaterThan(0);
    expect(snap.events[lane.id]).toHaveLength(1);
  });
});

describe('持久化', () => {
  it('重启后泳道、门禁和事件链都能恢复，并从断点继续执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlane-'));
    tmpDirs.push(dir);
    const statePath = join(dir, 'state.json');
    const dbPath = join(dir, 'events.db');

    const store1 = new StateStore(statePath);
    const events1 = new EventService({ dbPath });
    const orch1 = new Orchestrator({ store: store1, events: events1, executor: new SimulatedExecutor() });
    await orch1.createIssue({
      title: '持久化验证',
      type: 'Story',
      priority: 'High',
      dueDate: '2026-12-01',
      reporter: 'tester',
      components: ['core'],
      markdown: '## 验收标准\n- 重启后数据仍在',
    });
    const lane = await orch1.createLane('DL-101', 'admin');
    await orch1.act(lane.id, 'queue', 'admin');
    await tickUntil(orch1, () => store1.data.lanes[0]!.state === 'blocked');
    const before = (await events1.list(lane.id)).length;
    events1.close();

    const store2 = new StateStore(statePath);
    const events2 = new EventService({ dbPath });
    const orch2 = new Orchestrator({ store: store2, events: events2, executor: new SimulatedExecutor() });
    expect(store2.data.lanes[0]).toMatchObject({ id: lane.id, state: 'blocked' });
    expect((await events2.list(lane.id)).length).toBe(before);
    expect((await orch2.verifyLane(lane.id)).ok).toBe(true);

    await orch2.resolveGate(store2.data.gates[0]!.id, 'approve', 'admin');
    await tickUntil(orch2, () => store2.data.lanes[0]!.state === 'reviewing');
    expect((await orch2.verifyLane(lane.id)).ok).toBe(true);
    events2.close();
  });
});
