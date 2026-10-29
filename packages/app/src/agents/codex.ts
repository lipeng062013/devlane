import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  type AgentAdapter,
  type AgentExit,
  type AgentMessage,
  type AgentProcess,
  type AgentStart,
  type ClaudeBinary,
  killTree,
  quoteShellArg,
  resolveBinary,
} from '../claude';

/** PATH / 设置里常见的 Codex CLI 文件名（Windows 含 .cmd）。 */
const CODEX_NAMES = process.platform === 'win32'
  ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
  : ['codex'];

export function resolveCodex(custom?: string): ClaudeBinary | null {
  return resolveBinary(CODEX_NAMES, custom);
}

/**
 * Codex 第一刀适配器。
 * 启动：`codex exec --json -`，prompt 走 stdin；非 Claude stream-json，按行作 text。
 * 不使用 settingsPath / Claude 权限参数。
 */
export class CodexAgent implements AgentAdapter {
  start(opts: AgentStart, onMessage: (m: AgentMessage) => void): AgentProcess {
    const bin = resolveCodex(opts.binaryPath ?? opts.claudePath);
    if (!bin) {
      return {
        done: Promise.resolve({
          code: null,
          stderr: '找不到 Codex 命令。请先安装 Codex CLI，或在「设置」里填写它的路径',
          killed: false,
        }),
        kill: () => undefined,
      };
    }

    // 第一刀：非交互 exec + JSONL；参数以本机 `codex exec --help` 为准（猜过则标在 PR）
    const rawArgs = ['exec', '--json', '-'];
    const args = bin.shell ? rawArgs.map(quoteShellArg) : rawArgs;
    const command = bin.shell ? quoteShellArg(bin.command) : bin.command;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: bin.shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.prompt);

    return wireLineTextProcess(child, onMessage);
  }

  version(binaryPath?: string): Promise<string | null> {
    const bin = resolveCodex(binaryPath);
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      const command = bin.shell ? quoteShellArg(bin.command) : bin.command;
      execFile(command, ['--version'], { shell: bin.shell, windowsHide: true, timeout: 30_000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  }
}

/** 把 stdout 按行塞进 text；结束时补一个简单 result。供 Codex/Grok 复用。 */
export function wireLineTextProcess(
  child: ChildProcess,
  onMessage: (m: AgentMessage) => void,
): AgentProcess {
  let killed = false;
  let buffer = '';
  let stderr = '';
  let sawText = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const text = line.replace(/\r$/, '');
      if (text.trim()) {
        sawText = true;
        onMessage({ kind: 'text', text });
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-20_000);
  });

  const done = new Promise<AgentExit>((resolve) => {
    child.on('error', (err) => resolve({ code: null, stderr: `${stderr}\n${err.message}`.trim(), killed }));
    child.on('close', (code) => {
      const rest = buffer.replace(/\r$/, '').trim();
      if (rest) {
        sawText = true;
        onMessage({ kind: 'text', text: rest });
      }
      onMessage({
        kind: 'result',
        ok: !killed && code === 0,
        subtype: killed ? 'killed' : code === 0 ? 'success' : 'error',
        text: sawText ? '' : stderr.slice(0, 2000),
        costUsd: 0,
        turns: 0,
        durationMs: 0,
        sessionId: '',
      });
      resolve({ code, stderr, killed });
    });
  });

  return {
    done,
    kill: () => {
      killed = true;
      killTree(child);
    },
  };
}
