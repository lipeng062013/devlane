export const LANE_STATES = [
  'draft',
  'ready',
  'queued',
  'running',
  'blocked',
  'paused',
  'reviewing',
  'merged',
  'abandoned',
] as const;

export type LaneState = (typeof LANE_STATES)[number];

export interface Lane {
  id: string;
  projectId: string;
  issueSnapshotId: string;
  state: LaneState;
  branch: string;
  worktreePath: string;
  executor: string | null;
  createdAt: string;
}

export interface Transition {
  from: LaneState;
  to: LaneState;
  event?: string;
  guard?: (lane: Lane, context: Record<string, unknown>) => { ok: boolean; reason?: string };
}

/** 返回合法的下一状态集合。 */
export function allowedNextStates(current: LaneState): LaneState[] {
  const map: Record<LaneState, LaneState[]> = {
    draft: ['ready'],
    ready: ['queued'],
    queued: ['running', 'paused'],
    running: ['blocked', 'paused', 'reviewing', 'abandoned'],
    blocked: ['running', 'abandoned'],
    paused: ['queued', 'abandoned'],
    reviewing: ['merged', 'running', 'abandoned'],
    merged: [],
    abandoned: [],
  };
  return map[current] ?? [];
}

export class TransitionError extends Error {
  constructor(
    public readonly from: LaneState,
    public readonly to: LaneState,
    public readonly reason: string,
  ) {
    super(`状态迁移非法: ${from} -> ${to} (${reason})`);
    this.name = 'TransitionError';
  }
}

/** 校验迁移是否合法，返回错误信息或 null。 */
export function validateTransition(
  lane: Lane,
  to: LaneState,
  context: Record<string, unknown> = {},
): { ok: boolean; reason?: string } {
  const allowed = allowedNextStates(lane.state);
  if (!allowed.includes(to)) {
    return { ok: false, reason: `当前状态 ${lane.state} 不允许迁移到 ${to}` };
  }

  // 守卫条件
  if (to === 'queued' && !context.projectId) {
    return { ok: false, reason: '缺少项目并发配置' };
  }
  if (to === 'reviewing' && !context.prUrl) {
    return { ok: false, reason: 'PR 尚未创建' };
  }
  if (to === 'blocked' && !context.gateId) {
    return { ok: false, reason: '缺少门禁 ID' };
  }

  return { ok: true };
}

/** 执行状态迁移，返回新 lane 或抛出 TransitionError。 */
export function transit(lane: Lane, to: LaneState, context: Record<string, unknown> = {}): Lane {
  const check = validateTransition(lane, to, context);
  if (!check.ok) {
    throw new TransitionError(lane.state, to, check.reason!);
  }
  return { ...lane, state: to };
}
