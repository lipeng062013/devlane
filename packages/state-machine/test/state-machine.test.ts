import { describe, expect, it } from 'vitest';
import { allowedNextStates, transit, TransitionError, type Lane } from '../src/index';

const makeLane = (state: Lane['state']): Lane => ({
  id: 'lane-1',
  projectId: 'proj-1',
  issueSnapshotId: 'snap-1',
  state,
  branch: 'devlane/TEST-1',
  worktreePath: '/tmp/wt',
  executor: null,
  createdAt: '2026-10-27T00:00:00Z',
});

describe('allowedNextStates', () => {
  it('draft 只能到 ready', () => {
    expect(allowedNextStates('draft')).toEqual(['ready']);
  });

  it('running 可到 blocked、paused、reviewing、abandoned', () => {
    expect(allowedNextStates('running')).toEqual(['blocked', 'paused', 'reviewing', 'abandoned']);
  });

  it('merged 和 abandoned 是终态', () => {
    expect(allowedNextStates('merged')).toEqual([]);
    expect(allowedNextStates('abandoned')).toEqual([]);
  });
});

describe('transit', () => {
  it('合法迁移返回新 lane', () => {
    const lane = makeLane('draft');
    const next = transit(lane, 'ready');
    expect(next.state).toBe('ready');
    expect(next.id).toBe(lane.id);
  });

  it('非法迁移抛出 TransitionError', () => {
    const lane = makeLane('draft');
    expect(() => transit(lane, 'running')).toThrow(TransitionError);
  });

  it('进入 blocked 需要 gateId', () => {
    const lane = makeLane('running');
    expect(() => transit(lane, 'blocked')).toThrow(/缺少门禁 ID/);
    const ok = transit(lane, 'blocked', { gateId: 'gate-1' });
    expect(ok.state).toBe('blocked');
  });

  it('进入 reviewing 需要 prUrl', () => {
    const lane = makeLane('running');
    expect(() => transit(lane, 'reviewing')).toThrow(/PR 尚未创建/);
    const ok = transit(lane, 'reviewing', { prUrl: 'https://github.com/...' });
    expect(ok.state).toBe('reviewing');
  });

  it('从 blocked 回到 running 不需要额外条件', () => {
    const lane = makeLane('blocked');
    const next = transit(lane, 'running');
    expect(next.state).toBe('running');
  });

  it('queued 需要 projectId', () => {
    const lane = makeLane('ready');
    expect(() => transit(lane, 'queued')).toThrow(/项目并发配置/);
    const ok = transit(lane, 'queued', { projectId: 'proj-1' });
    expect(ok.state).toBe('queued');
  });
});
