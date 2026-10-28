import { createHash } from 'node:crypto';
import type { Actor, EventType } from '@devlane/event-schema';
import type { ToolCall } from '@devlane/policy-engine';
import type { LaneRecord } from './domain';

export interface EmittedEvent {
  type: EventType;
  payload: Record<string, unknown>;
}

export interface ExecutorStep {
  phase: string;
  /** 本步要调用的工具。先过策略引擎，放行后才产生 effects。 */
  tool?: ToolCall;
  /** 工具调用被放行（或被人批准）后产生的事件。 */
  effects: EmittedEvent[];
  /** 最后一步：创建 PR 并把泳道送去评审。 */
  openPr?: { title: string };
}

/**
 * 执行器适配接口。真实执行器（命令行 agent、容器沙箱）实现同样的 plan 契约后可替换。
 * plan 按泳道上的 step 下标返回下一步，返回 null 表示脚本已走完。
 */
export interface Executor {
  readonly name: string;
  readonly actor: Actor;
  plan(lane: LaneRecord): ExecutorStep | null;
}

function sha(lane: LaneRecord, n: number): string {
  return createHash('sha1').update(`${lane.id}:${n}`).digest('hex').slice(0, 7);
}

function script(lane: LaneRecord): ExecutorStep[] {
  const wt = lane.worktreePath;
  const read = (file: string, phase: string): ExecutorStep => ({
    phase,
    tool: { tool: 'read_file', args: { path: `${wt}/${file}` } },
    effects: [],
  });
  const write = (file: string, phase: string, effects: EmittedEvent[] = []): ExecutorStep => ({
    phase,
    tool: { tool: 'write_file', args: { path: `${wt}/${file}` } },
    effects,
  });
  const run = (command: string, phase: string, effects: EmittedEvent[]): ExecutorStep => ({
    phase,
    tool: { tool: 'run_command', args: { command } },
    effects,
  });
  const commit = (n: number, message: string, additions: number, deletions: number): EmittedEvent => ({
    type: 'commit',
    payload: { sha: sha(lane, n), message, additions, deletions },
  });
  const testFail = (attempt: number, durationMs: number): EmittedEvent => ({
    type: 'test_fail',
    payload: { command: 'npm test', exitCode: 1, durationMs, attempt },
  });
  const testPass = (durationMs: number): EmittedEvent => ({
    type: 'test_pass',
    payload: { command: 'npm test', exitCode: 0, durationMs },
  });
  const artifact = (suffix: string, kind: string, title: string): EmittedEvent => ({
    type: 'artifact',
    payload: { artifactId: `A-${lane.id}-${suffix}`, kind, title },
  });

  if (lane.type === 'bug') {
    return [
      read('src/core/handler.ts', 'locate'),
      run('grep -rn "handler" src', 'locate', [artifact('rca', 'analysis', `根因定位：${lane.title}`)]),
      write('tests/regression.test.ts', 'reproduce'),
      run('npm test', 'reproduce', [testFail(1, 1840)]),
      // 红测阶段直接改业务代码，会被缺陷流水线规则拦下。
      write('src/core/handler.ts', 'red_test'),
      write('src/core/handler.ts', 'fix', [commit(1, `fix: ${lane.title}`, 14, 3)]),
      run('npm test', 'fix', [
        testFail(2, 2210),
        { type: 'retry', payload: { attempt: 2, reason: '边界值未处理，补充判断后重试' } },
      ]),
      write('src/core/handler.ts', 'fix', [commit(2, 'fix: 补充边界值处理', 6, 1)]),
      run('npm test', 'verify', [testPass(2390)]),
      {
        phase: 'pr',
        effects: [artifact('pr', 'pr_description', `PR 描述：${lane.title}`)],
        openPr: { title: `fix: ${lane.title}` },
      },
    ];
  }

  if (lane.type === 'story') {
    return [
      read('docs/spec.md', 'plan'),
      {
        phase: 'plan',
        effects: [artifact('plan', 'plan', `实现计划：${lane.title}`)],
      },
      write('src/feature/index.ts', 'implement', [commit(1, `feat: ${lane.title}`, 86, 4)]),
      write('tests/feature.test.ts', 'implement', [commit(2, 'test: 补充功能测试', 52, 0)]),
      run('npm test', 'verify', [
        testFail(1, 3120),
        {
          type: 'model_switch',
          payload: { from: 'simulated-fast', to: 'simulated-strong', reason: '测试失败，切换到更强的模型' },
        },
      ]),
      // 修改依赖清单属于高风险文件，需要人批准。
      write('package.json', 'implement', [commit(3, 'chore: 增加运行依赖', 3, 0)]),
      run('npm test', 'verify', [testPass(3380)]),
      {
        phase: 'pr',
        effects: [artifact('pr', 'pr_description', `PR 描述：${lane.title}`)],
        openPr: { title: `feat: ${lane.title}` },
      },
    ];
  }

  return [
    read('src/index.ts', 'locate'),
    write('src/index.ts', 'implement', [commit(1, `chore: ${lane.title}`, 18, 9)]),
    run('npm test', 'verify', [testPass(1260)]),
    {
      phase: 'pr',
      effects: [artifact('pr', 'pr_description', `PR 描述：${lane.title}`)],
      openPr: { title: `chore: ${lane.title}` },
    },
  ];
}

/**
 * 模拟执行器：按固定脚本产生真实结构的事件，不调用模型，也不改任何代码。
 * 用于验证调度、策略、门禁、观测链路，接入真实执行器后可整体替换。
 */
export class SimulatedExecutor implements Executor {
  readonly name = 'simulated';
  readonly actor: Actor = { kind: 'agent', id: 'agent-sim-1', model: 'simulated-fast' };

  plan(lane: LaneRecord): ExecutorStep | null {
    return script(lane)[lane.step] ?? null;
  }
}
