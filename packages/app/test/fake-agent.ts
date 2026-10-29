import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentExit, AgentMessage, AgentProcess, AgentStart } from '../src/claude';

export interface Ctl {
  readonly killed: boolean;
  /** 等待被终止（模拟一直在工作）。 */
  untilKilled(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type Script = (opts: AgentStart, emit: (m: AgentMessage) => void, ctl: Ctl) => Promise<Partial<AgentExit> | void> | Partial<AgentExit> | void;

/** 按调用顺序执行脚本的假 agent；脚本用完后重复最后一个。 */
export class FakeAgent implements AgentAdapter {
  readonly calls: AgentStart[] = [];
  killCount = 0;

  constructor(private readonly scripts: Script[]) {}

  start(opts: AgentStart, onMessage: (m: AgentMessage) => void): AgentProcess {
    const index = this.calls.length;
    this.calls.push(opts);
    const script = this.scripts[Math.min(index, this.scripts.length - 1)]!;
    let killed = false;
    let wake: () => void = () => undefined;
    const killedPromise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const ctl: Ctl = {
      get killed() {
        return killed;
      },
      untilKilled: () => killedPromise,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };

    const done = (async (): Promise<AgentExit> => {
      await Promise.resolve();
      try {
        const out = (await script(opts, onMessage, ctl)) ?? {};
        return { code: 0, stderr: '', killed, ...out };
      } catch (err) {
        return { code: 1, stderr: (err as Error).message, killed };
      }
    })();

    return {
      done,
      kill: () => {
        killed = true;
        this.killCount += 1;
        wake();
      },
    };
  }

  async version(_binaryPath?: string): Promise<string | null> {
    return '9.9.9 (fake)';
  }
}

// ---------- 常用脚本 ----------

export const init = (opts: AgentStart): AgentMessage => ({ kind: 'init', sessionId: opts.sessionId, model: 'fake' });

export const result = (over: Partial<Extract<AgentMessage, { kind: 'result' }>> = {}): AgentMessage => ({
  kind: 'result',
  ok: true,
  subtype: 'success',
  text: '完成',
  costUsd: 0.25,
  turns: 3,
  durationMs: 1200,
  sessionId: 's',
  ...over,
});

/** 修复 sum.js 的缺陷然后成功结束。 */
export const fixSum: Script = (opts, emit) => {
  emit(init(opts));
  emit({ kind: 'text', text: '我来修复 add 函数' });
  emit({ kind: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: join(opts.cwd, 'sum.js') } });
  writeFileSync(join(opts.cwd, 'sum.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  emit({ kind: 'tool_result', id: 'u1', isError: false, text: 'ok' });
  emit(result());
};

/** 只成功结束，不改文件。 */
export const justFinish: Script = (opts, emit) => {
  emit(init(opts));
  emit(result());
};

/** 尝试运行一条被拒绝的命令，然后成功结束。 */
export const denied =
  (command: string, tool = 'Bash'): Script =>
  (opts, emit) => {
    emit(init(opts));
    emit({ kind: 'tool_use', id: 'd1', name: tool, input: tool === 'Bash' ? { command } : { file_path: command } });
    emit({ kind: 'denied', toolUseId: 'd1', toolName: tool });
    emit({ kind: 'tool_result', id: 'd1', isError: true, text: '被拒绝' });
    emit(result());
  };

/** 一直工作直到被终止。 */
export const hang: Script = async (opts, emit, ctl) => {
  emit(init(opts));
  emit({ kind: 'text', text: '正在工作…' });
  await ctl.untilKilled();
};
