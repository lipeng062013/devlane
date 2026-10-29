import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AgentAdapter,
  type AgentMessage,
  type AgentProcess,
  type AgentStart,
  type ClaudeBinary,
  quoteShellArg,
  resolveBinary,
} from '../claude';
import { wireLineTextProcess } from './codex';

/**
 * Grok Build 第一刀适配器。
 * 本机实名二进制是 `grok`（例：C:\\Users\\…\\.grok\\bin\\grok.exe），不是 grok-build。
 * resolve 常见名兜底；未确认协议前以 settings.grokBuildPath 为准。
 */
const GROK_NAMES = process.platform === 'win32'
  ? ['grok.exe', 'grok', 'grok-build.exe', 'grok-build']
  : ['grok', 'grok-build'];

export function resolveGrokBuild(custom?: string): ClaudeBinary | null {
  return resolveBinary(GROK_NAMES, custom);
}

/** 无头单轮参数。必须用 -p/--single 或 --prompt-file；裸 [PROMPT]/- 会进 TUI。 */
export function buildGrokArgs(promptFile: string): string[] {
  return [
    '--prompt-file',
    promptFile,
    '--output-format',
    'plain',
    '--always-approve',
    '--permission-mode',
    'dontAsk',
  ];
}

function writePromptFile(opts: AgentStart): string {
  const dir = opts.settingsPath
    ? dirname(opts.settingsPath)
    : mkdtempSync(join(tmpdir(), 'devlane-grok-'));
  const file = join(dir, 'grok-prompt.txt');
  writeFileSync(file, opts.prompt, 'utf8');
  return file;
}

/**
 * 启动：`grok --prompt-file <path> --output-format plain --always-approve --permission-mode dontAsk`
 * 本机验证：`grok -p 'ping' --output-format plain --permission-mode dontAsk --always-approve` 可正常退出。
 * 不套 Claude settings / 权限模型。
 */
export class GrokBuildAgent implements AgentAdapter {
  start(opts: AgentStart, onMessage: (m: AgentMessage) => void): AgentProcess {
    const bin = resolveGrokBuild(opts.binaryPath ?? opts.claudePath);
    if (!bin) {
      return {
        done: Promise.resolve({
          code: null,
          stderr: '找不到 Grok（grok）命令。请先安装 Grok Build，或在「设置」里填写它的路径',
          killed: false,
        }),
        kill: () => undefined,
      };
    }

    const promptFile = writePromptFile(opts);
    const rawArgs = buildGrokArgs(promptFile);
    const args = bin.shell ? rawArgs.map(quoteShellArg) : rawArgs;
    const command = bin.shell ? quoteShellArg(bin.command) : bin.command;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: bin.shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return wireLineTextProcess(child, onMessage);
  }

  version(binaryPath?: string): Promise<string | null> {
    const bin = resolveGrokBuild(binaryPath);
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      const command = bin.shell ? quoteShellArg(bin.command) : bin.command;
      execFile(command, ['--version'], { shell: bin.shell, windowsHide: true, timeout: 30_000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  }
}
