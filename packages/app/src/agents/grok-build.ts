import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AgentAdapter,
  type AgentExit,
  type AgentMessage,
  type AgentProcess,
  type AgentStart,
  type ClaudeBinary,
  isValidModel,
  killTree,
  quoteShellArg,
  resolveBinary,
} from '../claude';
import { normalizeEffort } from '../domain';

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

export interface ListedModel {
  id: string;
  isDefault: boolean;
}

/** 解析 `grok models` 的文本。星号是默认模型。读不到时返回空列表。 */
export function parseGrokModels(text: string): ListedModel[] {
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([*-])\s+(\S+)/);
    if (!match) continue;
    const id = match[2]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, isDefault: match[1] === '*' });
  }
  return out;
}

export interface GrokRunOptions {
  promptFile: string;
  model?: string;
  effort?: string;
  /** 续接上一次跑完后 CLI 返回的 sessionId。空则新会话。 */
  resumeSessionId?: string;
  /** 工作区已由 DevLane 创建。让 grok 加载项目 skill 和 MCP。 */
  trustWorkspace?: boolean;
}

/** 无头参数。必须用 --prompt-file；裸 [PROMPT]/- 会进 TUI。streaming-json 边跑边出工具和文字。 */
export function buildGrokArgs(opts: string | GrokRunOptions): string[] {
  const o: GrokRunOptions = typeof opts === 'string' ? { promptFile: opts } : opts;
  const args = ['--prompt-file', o.promptFile, '--output-format', 'streaming-json', '--always-approve'];
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  if (o.model) {
    if (!isValidModel(o.model)) throw new Error(`模型名包含不允许的字符：${o.model}`);
    args.push('--model', o.model);
  }
  const effort = normalizeEffort(o.effort);
  if (effort) args.push('--effort', effort);
  if (o.trustWorkspace) args.push('--trust');
  return args;
}

export interface GrokResultStats {
  text: string;
  turns: number;
  costUsd: number;
  costKnown: boolean;
  sessionId: string;
  ok: boolean;
}

/** 读 grok --output-format json 的最终对象。缺 total_cost_usd 时 costKnown 为 false。 */
export function parseGrokResult(raw: string): GrokResultStats | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    const slice = start >= 0 ? trimmed.slice(start + 1) : trimmed.startsWith('{') ? trimmed : '';
    if (!slice) return null;
    try {
      o = JSON.parse(slice) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (o.type === 'error' && typeof o.message === 'string') {
    return { text: o.message, turns: 0, costUsd: 0, costKnown: false, sessionId: '', ok: false };
  }
  const turns = Number(o.num_turns ?? 0);
  const costRaw = o.total_cost_usd;
  const costKnown = costRaw !== undefined && costRaw !== null && Number.isFinite(Number(costRaw));
  return {
    text: typeof o.text === 'string' ? o.text : '',
    turns: Number.isFinite(turns) ? turns : 0,
    costUsd: costKnown ? Number(costRaw) : 0,
    costKnown,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
    ok: o.type !== 'error',
  };
}

function summarizeRaw(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return '';
  }
}

/** 一行 streaming-json。工具和文字立刻发出。end 才带轮数和花费。 */
export function parseGrokStreamLine(line: string): AgentMessage[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(o.type ?? '');
  if (type === 'text' && typeof o.data === 'string' && o.data.trim()) return [{ kind: 'text', text: o.data }];
  if (type === 'tool_call') {
    return [{
      kind: 'tool_use',
      id: String(o.toolCallId ?? ''),
      name: String(o.toolName ?? o.title ?? 'tool'),
      input: o.rawInput && typeof o.rawInput === 'object' ? (o.rawInput as Record<string, unknown>) : {},
    }];
  }
  if (type === 'tool_call_update') {
    const status = String(o.status ?? '');
    if (status !== 'completed' && status !== 'failed' && status !== 'error') return [];
    return [{
      kind: 'tool_result',
      id: String(o.toolCallId ?? ''),
      isError: status === 'failed' || status === 'error',
      text: summarizeRaw(o.rawOutput ?? o.content),
    }];
  }
  if (type === 'end' || type === 'error') {
    const costRaw = o.total_cost_usd;
    const costKnown = costRaw !== undefined && costRaw !== null && Number.isFinite(Number(costRaw));
    const turns = Number(o.num_turns ?? 0);
    return [{
      kind: 'result',
      ok: type === 'end',
      subtype: type === 'end' ? 'success' : 'error',
      text: typeof o.message === 'string' ? o.message : '',
      costUsd: costKnown ? Number(costRaw) : 0,
      costKnown,
      turns: Number.isFinite(turns) ? turns : 0,
      durationMs: 0,
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
    }];
  }
  return [];
}

/** stdout 按行解析 streaming-json。结束时如果没有 end，补一条结果。耗时用进程墙上时间。 */
export function wireGrokJsonProcess(child: ChildProcess, onMessage: (m: AgentMessage) => void): AgentProcess {
  let killed = false;
  let buffer = '';
  let stderr = '';
  let sawResult = false;
  const started = Date.now();
  const take = (line: string): void => {
    for (const message of parseGrokStreamLine(line)) {
      if (message.kind === 'result') {
        sawResult = true;
        onMessage({ ...message, durationMs: Date.now() - started });
        if (message.sessionId) onMessage({ kind: 'init', sessionId: message.sessionId, model: '' });
      } else {
        onMessage(message);
      }
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      take(line.replace(/\r$/, ''));
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
      if (rest) take(rest);
      if (!sawResult) {
        const parsed = parseGrokResult(rest);
        onMessage({
          kind: 'result',
          ok: !killed && code === 0 && (parsed?.ok ?? true),
          subtype: killed ? 'killed' : code === 0 ? 'success' : 'error',
          text: parsed?.text.trim() ? parsed.text : stderr.slice(0, 2000),
          costUsd: parsed?.costUsd ?? 0,
          costKnown: parsed?.costKnown ?? false,
          turns: parsed?.turns ?? 0,
          durationMs: Date.now() - started,
          sessionId: parsed?.sessionId ?? '',
        });
      }
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

function writePromptFile(opts: AgentStart): string {
  const dir = opts.settingsPath
    ? dirname(opts.settingsPath)
    : mkdtempSync(join(tmpdir(), 'devlane-grok-'));
  const file = join(dir, 'grok-prompt.txt');
  writeFileSync(file, opts.prompt, 'utf8');
  return file;
}

/**
 * 启动：`grok --prompt-file <path> --output-format streaming-json --always-approve`
 * 不传 --permission-mode dontAsk。无头模式里 dontAsk 会把需要确认的工具直接取消。
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
    const rawArgs = buildGrokArgs({
      promptFile,
      model: opts.model,
      effort: opts.effort,
      resumeSessionId: opts.resume && opts.sessionId ? opts.sessionId : undefined,
      trustWorkspace: opts.trustWorkspace === true,
    });
    const args = bin.shell ? rawArgs.map(quoteShellArg) : rawArgs;
    const command = bin.shell ? quoteShellArg(bin.command) : bin.command;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: bin.shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return wireGrokJsonProcess(child, onMessage);
  }

  listModels(binaryPath?: string): Promise<ListedModel[]> {
    const bin = resolveGrokBuild(binaryPath);
    if (!bin) return Promise.resolve([]);
    return new Promise((resolve) => {
      const command = bin.shell ? quoteShellArg(bin.command) : bin.command;
      execFile(command, ['models'], { shell: bin.shell, windowsHide: true, timeout: 20_000 }, (err, stdout) => {
        resolve(err ? [] : parseGrokModels(stdout));
      });
    });
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
