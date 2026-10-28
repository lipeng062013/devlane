import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import type { Actor, EventType, LaneEvent } from '@devlane/event-schema';
import type { EventService } from '@devlane/event-service';
import { PolicyEngine, type PolicyContext, type PolicyResult } from '@devlane/policy-engine';
import { assessReadiness, type ReadinessResult } from '@devlane/readiness';
import { transit, TransitionError, type LaneState } from '@devlane/state-machine';
import { DomainError, normalizeIssueType, type GateRecord, type Issue, type LaneRecord } from './domain';
import type { Executor, ExecutorStep } from './executor';
import type { StateStore } from './store';

export type ChangeKind = 'lane' | 'event' | 'gate' | 'issue';
export interface Change {
  kind: ChangeKind;
  id: string;
}

export type LaneAction = 'queue' | 'resume' | 'pause' | 'abandon' | 'merge';
export const LANE_ACTIONS: readonly LaneAction[] = ['queue', 'resume', 'pause', 'abandon', 'merge'];

export interface OrchestratorOptions {
  store: StateStore;
  events: EventService;
  executor: Executor;
  policy?: PolicyEngine;
  /** 同时处于 running 的泳道上限。 */
  maxParallel?: number;
  projectId?: string;
  now?: () => Date;
}

export interface IssueInput {
  title: string;
  type?: string;
  markdown?: string;
  priority?: string;
  dueDate?: string;
  reporter?: string;
  assignee?: string;
  components?: string[];
}

export interface IssueView extends Issue {
  readiness: ReadinessResult;
  /** 该需求当前未终结的泳道 id。 */
  activeLaneId: string | null;
}

export interface Snapshot {
  issues: IssueView[];
  lanes: LaneRecord[];
  gates: GateRecord[];
  events: Record<string, LaneEvent[]>;
}

const TERMINAL: LaneState[] = ['merged', 'abandoned'];
const SYSTEM: Actor = { kind: 'system', id: 'devlane' };

export function readinessOf(issue: Issue): ReadinessResult {
  return assessReadiness({
    type: issue.typeName,
    markdown: issue.markdown,
    acceptance: issue.acceptance,
    priority: issue.priority,
    dueDate: issue.dueDate,
    reporter: issue.reporter,
    assignee: issue.assignee,
    components: issue.components,
  });
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 7);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export class Orchestrator extends EventEmitter {
  private readonly store: StateStore;
  private readonly events: EventService;
  private readonly executor: Executor;
  private readonly policy: PolicyEngine;
  private readonly maxParallel: number;
  private readonly projectId: string;
  private readonly clock: () => Date;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: OrchestratorOptions) {
    super();
    this.store = opts.store;
    this.events = opts.events;
    this.executor = opts.executor;
    this.policy = opts.policy ?? new PolicyEngine();
    this.maxParallel = opts.maxParallel ?? 3;
    this.projectId = opts.projectId ?? 'default';
    this.clock = opts.now ?? (() => new Date());
  }

  /** 所有会修改状态的操作都排进同一条队列，避免同一泳道的事件序号冲突。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private notify(kind: ChangeKind, id: string): void {
    this.emit('change', { kind, id } satisfies Change);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private findLane(id: string): LaneRecord {
    const lane = this.store.data.lanes.find((l) => l.id === id);
    if (!lane) throw new DomainError(404, `泳道 ${id} 不存在`);
    return lane;
  }

  private touch(lane: LaneRecord): void {
    lane.updatedAt = this.nowIso();
    this.store.save();
    this.notify('lane', lane.id);
  }

  private move(lane: LaneRecord, to: LaneState, ctx: Record<string, unknown> = {}): void {
    try {
      lane.state = transit(lane, to, ctx).state;
    } catch (err) {
      if (err instanceof TransitionError) throw new DomainError(409, err.message);
      throw err;
    }
  }

  private async emitEvent(
    lane: LaneRecord,
    type: EventType,
    payload: Record<string, unknown>,
    actor: Actor,
  ): Promise<LaneEvent> {
    const last = await this.events.getLast(lane.id);
    const event = await this.events.append({
      id: randomUUID(),
      laneId: lane.id,
      runId: `run-${lane.id}`,
      parentIds: last ? [last.id] : [],
      type,
      actor,
      ts: this.nowIso(),
      payload,
      artifactIds: type === 'artifact' ? [String(payload.artifactId)] : [],
    });
    this.notify('event', lane.id);
    return event;
  }

  /** 泳道当前所在提交：最近一次 commit，没有则取分支基线。 */
  private async currentSha(lane: LaneRecord): Promise<string> {
    const all = await this.events.list(lane.id, 0, 5000);
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]!;
      if (e.type === 'commit') return String(e.payload.sha);
      if (e.type === 'branch') return String(e.payload.baseSha);
    }
    return shortHash(lane.id);
  }

  private human(name: string): Actor {
    return { kind: 'human', id: name };
  }

  // ---------- 需求 ----------

  createIssue(input: IssueInput, source: Issue['source'] = 'manual'): Promise<Issue> {
    return this.serial(async () => {
      const title = (input.title ?? '').trim();
      if (!title) throw new DomainError(400, '标题不能为空');
      if (title.length > 200) throw new DomainError(400, '标题不能超过 200 字');
      const markdown = (input.markdown ?? '').trim();
      if (markdown.length > 20000) throw new DomainError(400, '描述不能超过 20000 字');
      const typeName = (input.type ?? 'Task').trim() || 'Task';
      const n = this.store.nextId('issue');
      const key = `DL-${n}`;
      const issue: Issue = {
        id: key,
        key,
        source,
        type: normalizeIssueType(typeName),
        typeName,
        title,
        markdown,
        priority: input.priority?.trim() || undefined,
        dueDate: input.dueDate?.trim() || undefined,
        reporter: input.reporter?.trim() || undefined,
        assignee: input.assignee?.trim() || undefined,
        components: (input.components ?? []).map((c) => c.trim()).filter(Boolean),
        createdAt: this.nowIso(),
      };
      this.store.data.issues.push(issue);
      this.store.save();
      this.notify('issue', issue.id);
      return issue;
    });
  }

  /** 按 key 覆盖或新增，用于 Jira 导入。已存在的需求保留原创建时间。 */
  upsertIssues(issues: Issue[]): Promise<{ created: number; updated: number }> {
    return this.serial(async () => {
      let created = 0;
      let updated = 0;
      for (const incoming of issues) {
        const index = this.store.data.issues.findIndex((i) => i.id === incoming.id);
        if (index >= 0) {
          const old = this.store.data.issues[index]!;
          this.store.data.issues[index] = { ...incoming, createdAt: old.createdAt };
          updated += 1;
        } else {
          this.store.data.issues.push(incoming);
          created += 1;
        }
      }
      this.store.save();
      if (issues.length > 0) this.notify('issue', '*');
      return { created, updated };
    });
  }

  // ---------- 泳道 ----------

  createLane(issueId: string, user: string): Promise<LaneRecord> {
    return this.serial(async () => {
      const issue = this.store.data.issues.find((i) => i.id === issueId);
      if (!issue) throw new DomainError(404, `需求 ${issueId} 不存在`);
      const readiness = readinessOf(issue);
      if (!readiness.ready) {
        throw new DomainError(422, `需求就绪评分 ${readiness.score}，未达到开泳道的阈值`, readiness);
      }
      const active = this.store.data.lanes.find((l) => l.issueKey === issue.key && !TERMINAL.includes(l.state));
      if (active) throw new DomainError(409, `需求 ${issue.key} 已有进行中的泳道 ${active.id}`);

      const n = this.store.nextId('lane');
      const id = `L-${n}`;
      const now = this.nowIso();
      const lane: LaneRecord = {
        id,
        projectId: this.projectId,
        issueSnapshotId: issue.id,
        state: 'draft',
        branch: `devlane/${slug(issue.key)}-${n}`,
        worktreePath: `/work/${id}`,
        executor: this.executor.name,
        createdAt: now,
        title: issue.title,
        issueKey: issue.key,
        type: issue.type,
        phase: 'created',
        step: 0,
        approvedStep: null,
        prUrl: null,
        prNumber: null,
        declaredScope: ['src/', 'tests/', 'package.json'],
        blockedGateId: null,
        updatedAt: now,
      };
      this.move(lane, 'ready');
      await this.emitEvent(lane, 'branch', { name: lane.branch, baseSha: shortHash(issue.key) }, this.human(user));
      this.store.data.lanes.push(lane);
      this.touch(lane);
      return lane;
    });
  }

  act(laneId: string, action: LaneAction, user: string): Promise<LaneRecord> {
    return this.serial(async () => {
      const lane = this.findLane(laneId);
      const actor = this.human(user);
      const sha = await this.currentSha(lane);
      switch (action) {
        case 'queue':
        case 'resume':
          this.move(lane, 'queued', { projectId: this.projectId });
          await this.emitEvent(lane, 'checkpoint', { sha, label: action === 'queue' ? '加入队列' : '恢复执行' }, actor);
          break;
        case 'pause':
          this.move(lane, 'paused');
          await this.emitEvent(lane, 'checkpoint', { sha, label: '人工暂停' }, actor);
          break;
        case 'abandon': {
          const gate = this.store.data.gates.find((g) => g.id === lane.blockedGateId);
          this.move(lane, 'abandoned');
          if (gate && gate.status === 'open') {
            gate.status = 'cancelled';
            gate.resolvedAt = this.nowIso();
            this.notify('gate', gate.id);
          }
          lane.blockedGateId = null;
          await this.emitEvent(lane, 'checkpoint', { sha, label: '人工放弃' }, actor);
          break;
        }
        case 'merge': {
          this.move(lane, 'merged');
          await this.emitEvent(
            lane,
            'merge',
            { prNumber: lane.prNumber ?? 0, mergeSha: shortHash(`${lane.id}:merge`) },
            actor,
          );
          break;
        }
        default:
          throw new DomainError(400, `未知操作 ${String(action)}`);
      }
      this.touch(lane);
      return lane;
    });
  }

  resolveGate(gateId: string, decision: 'approve' | 'reject', user: string): Promise<GateRecord> {
    return this.serial(async () => {
      const gate = this.store.data.gates.find((g) => g.id === gateId);
      if (!gate) throw new DomainError(404, `门禁 ${gateId} 不存在`);
      if (gate.status !== 'open') throw new DomainError(409, `门禁 ${gateId} 已处理`);
      const lane = this.findLane(gate.laneId);
      if (lane.state !== 'blocked' || lane.blockedGateId !== gate.id) {
        throw new DomainError(409, `泳道 ${lane.id} 当前不在等待该门禁`);
      }

      await this.emitEvent(lane, 'gate_resolved', { gateId, decision, resolver: user }, this.human(user));
      gate.status = 'resolved';
      gate.decision = decision;
      gate.resolver = user;
      gate.resolvedAt = this.nowIso();
      this.move(lane, 'running');
      lane.blockedGateId = null;
      if (decision === 'approve') {
        lane.approvedStep = lane.step;
      } else {
        await this.emitEvent(
          lane,
          'error',
          { code: 'GATE_REJECTED', message: `门禁 ${gateId} 被拒绝，跳过该步骤`, retryable: false },
          SYSTEM,
        );
        lane.step += 1;
      }
      this.notify('gate', gate.id);
      this.touch(lane);
      return gate;
    });
  }

  verifyLane(laneId: string): Promise<{ ok: boolean; brokenAtSeq?: number; reason?: string; events: number }> {
    return this.serial(async () => {
      this.findLane(laneId);
      const result = await this.events.verifyLane(laneId);
      const count = (await this.events.list(laneId, 0, 5000)).length;
      return { ...result, events: count };
    });
  }

  // ---------- 调度 ----------

  /** 推进一轮：先把排队的泳道提升为运行（受并发上限约束），再让每条运行中的泳道走一步。 */
  tick(): Promise<void> {
    return this.serial(async () => {
      const lanes = this.store.data.lanes;
      let free = this.maxParallel - lanes.filter((l) => l.state === 'running').length;
      const queued = lanes.filter((l) => l.state === 'queued').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const lane of queued) {
        if (free <= 0) break;
        this.move(lane, 'running');
        await this.emitEvent(lane, 'checkpoint', { sha: await this.currentSha(lane), label: '开始执行' }, SYSTEM);
        this.touch(lane);
        free -= 1;
      }
      for (const lane of lanes.filter((l) => l.state === 'running')) {
        await this.stepLane(lane);
      }
    });
  }

  private async stepLane(lane: LaneRecord): Promise<void> {
    const step = this.executor.plan(lane);
    if (!step) {
      await this.emitEvent(
        lane,
        'error',
        { code: 'SCRIPT_EXHAUSTED', message: '执行器脚本已结束但未创建 PR', retryable: false },
        SYSTEM,
      );
      this.move(lane, 'paused');
      this.touch(lane);
      return;
    }

    lane.phase = step.phase;
    const approved = lane.approvedStep === lane.step;

    if (step.tool) {
      const ctx: PolicyContext & { phase: string } = {
        laneId: lane.id,
        laneState: lane.state,
        laneType: lane.type,
        declaredScope: lane.declaredScope,
        worktreePath: lane.worktreePath,
        phase: step.phase,
      };
      const result: PolicyResult = approved ? { decision: 'allow' } : this.policy.evaluate(ctx, step.tool);

      if (result.decision === 'gate') {
        await this.openGate(lane, result);
        return;
      }
      if (result.decision === 'deny') {
        await this.emitEvent(
          lane,
          'tool_call',
          { tool: step.tool.tool, args: step.tool.args, decision: 'deny' },
          this.executor.actor,
        );
        await this.emitEvent(
          lane,
          'error',
          { code: 'POLICY_DENY', message: result.reason ?? '被策略拒绝', retryable: false },
          SYSTEM,
        );
        lane.step += 1;
        this.touch(lane);
        return;
      }
      await this.emitEvent(
        lane,
        'tool_call',
        { tool: step.tool.tool, args: step.tool.args, decision: approved ? 'approved' : 'allow' },
        this.executor.actor,
      );
    }

    for (const effect of step.effects) {
      const actor = effect.type === 'model_switch' ? SYSTEM : this.executor.actor;
      await this.emitEvent(lane, effect.type, effect.payload, actor);
    }
    if (approved) lane.approvedStep = null;
    lane.step += 1;

    if (step.openPr) await this.openPr(lane, step);
    this.touch(lane);
  }

  private async openGate(lane: LaneRecord, result: PolicyResult): Promise<void> {
    const gate: GateRecord = {
      id: `G-${this.store.nextId('gate')}`,
      laneId: lane.id,
      gateType: result.gateType ?? 'policy',
      reason: result.reason ?? '需要人工确认',
      status: 'open',
      openedAt: this.nowIso(),
    };
    await this.emitEvent(
      lane,
      'gate_open',
      { gateId: gate.id, gateType: gate.gateType, reason: gate.reason },
      SYSTEM,
    );
    this.store.data.gates.push(gate);
    this.move(lane, 'blocked', { gateId: gate.id });
    lane.blockedGateId = gate.id;
    this.notify('gate', gate.id);
    this.touch(lane);
  }

  private async openPr(lane: LaneRecord, step: ExecutorStep): Promise<void> {
    const n = this.store.nextId('pr');
    lane.prNumber = n;
    lane.prUrl = `simulated://pr/${n}`;
    this.move(lane, 'reviewing', { prUrl: lane.prUrl });
    await this.emitEvent(
      lane,
      'review_pass',
      { reviewer: 'agent-reviewer-sim', prTitle: step.openPr?.title ?? '' },
      { kind: 'agent', id: 'agent-reviewer-sim', model: 'simulated-strong' },
    );
  }

  start(tickMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.error('[devlane] tick 失败:', err);
      });
    }, tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- 读取 ----------

  async snapshot(): Promise<Snapshot> {
    const { issues, lanes, gates } = this.store.data;
    const events: Record<string, LaneEvent[]> = {};
    for (const lane of lanes) events[lane.id] = await this.events.list(lane.id, 0, 5000);
    return {
      issues: issues.map((issue) => ({
        ...issue,
        readiness: readinessOf(issue),
        activeLaneId: lanes.find((l) => l.issueKey === issue.key && !TERMINAL.includes(l.state))?.id ?? null,
      })),
      lanes,
      gates,
      events,
    };
  }
}
