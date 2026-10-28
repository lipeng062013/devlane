import { EventService } from '@devlane/event-service';
import { SimulatedExecutor } from '../src/executor';
import { Orchestrator } from '../src/orchestrator';
import { seedDemoIssues } from '../src/seed';
import { StateStore } from '../src/store';

export interface Harness {
  orch: Orchestrator;
  store: StateStore;
  events: EventService;
}

/** 内存版编排器；时钟每次读取前进 1 秒，保证事件时间严格递增。 */
export async function makeHarness(opts: { maxParallel?: number; seed?: boolean } = {}): Promise<Harness> {
  const store = new StateStore();
  const events = new EventService();
  let t = Date.parse('2026-10-28T08:00:00Z');
  const orch = new Orchestrator({
    store,
    events,
    executor: new SimulatedExecutor(),
    maxParallel: opts.maxParallel ?? 3,
    now: () => new Date((t += 1000)),
  });
  if (opts.seed !== false) await seedDemoIssues(orch);
  return { orch, store, events };
}

/** 反复 tick，直到条件成立；超过上限说明流程卡住了。 */
export async function tickUntil(orch: Orchestrator, done: () => boolean, max = 60): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await orch.tick();
    if (done()) return i;
  }
  throw new Error(`tick ${max} 次后条件仍未满足`);
}
