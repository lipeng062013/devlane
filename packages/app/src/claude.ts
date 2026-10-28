import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// ---------- 对外的适配器接口 ----------

export interface AgentStart {
  cwd: string;
  prompt: string;
  sessionId: string;
  /** true 表示续接已有会话（--resume），false 表示新建（--session-id）。 */
  resume: boolean;
  /** 权限文件路径（--settings）。 */
  settingsPath: string;
  model?: string;
  maxBudgetUsd?: number;
  claudePath?: string;
}

export interface AgentExit {
  code: number | null;
  stderr: string;
  /** 是否是我们主动终止的。 */
  killed: boolean;
}

export interface AgentProcess {
  done: Promise<AgentExit>;
  kill(): void;
}

export type AgentMessage =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; isError: boolean; text: string }
  | { kind: 'denied'; toolUseId: string; toolName: string }
  | {
      kind: 'result';
      ok: boolean;
      subtype: string;
      text: string;
      costUsd: number;
      turns: number;
      durationMs: number;
      sessionId: string;
    };

export interface AgentAdapter {
  start(opts: AgentStart, onMessage: (m: AgentMessage) => void): AgentProcess;
  version(claudePath?: string): Promise<string | null>;
}

// ---------- 输出解析 ----------

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 解析 claude --output-format stream-json 的一行。无法识别的行返回空数组。 */
export function parseClaudeLine(line: string): AgentMessage[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let o: Record<string, any>;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: AgentMessage[] = [];
  switch (o.type) {
    case 'system':
      if (o.subtype === 'init') out.push({ kind: 'init', sessionId: String(o.session_id ?? ''), model: String(o.model ?? '') });
      else if (o.subtype === 'permission_denied') {
        out.push({ kind: 'denied', toolUseId: String(o.tool_use_id ?? ''), toolName: String(o.tool_name ?? '') });
      }
      break;
    case 'assistant':
      for (const block of o.message?.content ?? []) {
        if (block.type === 'text' && String(block.text ?? '').trim()) out.push({ kind: 'text', text: String(block.text) });
        else if (block.type === 'tool_use') {
          out.push({ kind: 'tool_use', id: String(block.id), name: String(block.name), input: block.input ?? {} });
        }
      }
      break;
    case 'user':
      for (const block of o.message?.content ?? []) {
        if (block && block.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            id: String(block.tool_use_id),
            isError: block.is_error === true,
            text: flattenContent(block.content),
          });
        }
      }
      break;
    case 'result':
      out.push({
        kind: 'result',
        ok: o.subtype === 'success' && o.is_error !== true,
        subtype: String(o.subtype ?? ''),
        text: String(o.result ?? ''),
        costUsd: Number(o.total_cost_usd ?? 0),
        turns: Number(o.num_turns ?? 0),
        durationMs: Number(o.duration_ms ?? 0),
        sessionId: String(o.session_id ?? ''),
      });
      break;
    default:
      break;
  }
  return out;
}

/** 给时间线看的一行工具摘要。 */
export function summarizeTool(name: string, input: Record<string, unknown>, cwd?: string): { summary: string; detail?: string } {
  const rel = (p: unknown): string => {
    const s = String(p ?? '');
    if (cwd && s.toLowerCase().startsWith(cwd.toLowerCase())) return s.slice(cwd.length).replace(/^[\\/]+/, '') || '.';
    return s;
  };
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command ?? '');
      return { summary: cmd.split('\n')[0]!.slice(0, 160), detail: cmd.length > 160 || cmd.includes('\n') ? cmd.slice(0, 2000) : undefined };
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { summary: rel(input.file_path ?? input.notebook_path) };
    case 'Glob':
      return { summary: String(input.pattern ?? '') };
    case 'Grep':
      return { summary: `${String(input.pattern ?? '')}${input.path ? `  (${rel(input.path)})` : ''}` };
    default:
      return { summary: '' };
  }
}

// ---------- 启动参数 ----------

const MODEL_PATTERN = /^[\w.\-[\]/:]+$/;

export function isValidModel(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

/** 构造 claude 命令行参数。用户输入的内容（提示词）走标准输入，不在这里。 */
export function buildClaudeArgs(opts: Pick<AgentStart, 'sessionId' | 'resume' | 'settingsPath' | 'model' | 'maxBudgetUsd'>): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--settings',
    opts.settingsPath,
    opts.resume ? '--resume' : '--session-id',
    opts.sessionId,
  ];
  if (opts.model) {
    if (!isValidModel(opts.model)) throw new Error(`模型名包含不允许的字符：${opts.model}`);
    args.push('--model', opts.model);
  }
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  return args;
}

// ---------- 定位可执行文件 ----------

export interface ClaudeBinary {
  command: string;
  /** .cmd / .bat 需要经过 shell 启动。 */
  shell: boolean;
}

function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export function resolveClaude(custom?: string): ClaudeBinary | null {
  const isWin = process.platform === 'win32';
  const found = custom
    ? existsSync(custom)
      ? custom
      : null
    : isWin
      ? (findOnPath(['claude.exe']) ?? findOnPath(['claude.cmd', 'claude.bat']))
      : findOnPath(['claude']);
  if (!found) return null;
  return { command: found, shell: isWin && /\.(cmd|bat)$/i.test(found) };
}

/** 经 shell 启动时给参数加引号；含有可能被 cmd 展开或截断的字符时直接拒绝。 */
export function quoteShellArg(arg: string): string {
  if (/[\r\n"%^!]/.test(arg)) throw new Error(`参数包含不允许的字符：${arg}`);
  return /^[\w.\-:[\]/\\]+$/.test(arg) ? arg : `"${arg}"`;
}

// ---------- 结束进程 ----------

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

// ---------- 真实适配器 ----------

export class ClaudeAgent implements AgentAdapter {
  start(opts: AgentStart, onMessage: (m: AgentMessage) => void): AgentProcess {
    const bin = resolveClaude(opts.claudePath);
    if (!bin) {
      return {
        done: Promise.resolve({ code: null, stderr: '找不到 claude 命令。请先安装 Claude Code，或在「设置」里填写它的路径。', killed: false }),
        kill: () => undefined,
      };
    }
    const rawArgs = buildClaudeArgs(opts);
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

    let killed = false;
    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        for (const m of parseClaudeLine(line)) onMessage(m);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });

    const done = new Promise<AgentExit>((resolve) => {
      child.on('error', (err) => resolve({ code: null, stderr: `${stderr}\n${err.message}`.trim(), killed }));
      child.on('close', (code) => {
        for (const m of parseClaudeLine(buffer)) onMessage(m);
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

  version(claudePath?: string): Promise<string | null> {
    const bin = resolveClaude(claudePath);
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      const command = bin.shell ? quoteShellArg(bin.command) : bin.command;
      execFile(command, ['--version'], { shell: bin.shell, windowsHide: true, timeout: 30_000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  }
}
