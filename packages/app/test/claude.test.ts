import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AgentMessage,
  buildClaudeArgs,
  isValidModel,
  parseClaudeLine,
  quoteShellArg,
  summarizeTool,
} from '../src/claude';

const fixture = readFileSync(join(__dirname, 'fixtures', 'claude-fix-bug.jsonl'), 'utf8');
const all: AgentMessage[] = fixture.split('\n').flatMap(parseClaudeLine);
const kinds = (k: AgentMessage['kind']) => all.filter((m) => m.kind === k);

describe('parseClaudeLine（真实 claude 输出）', () => {
  it('识别会话开始', () => {
    expect(all[0]).toMatchObject({ kind: 'init', sessionId: 'sess-0001', model: 'claude-sonnet' });
  });

  it('把文字与工具调用拆成独立条目，顺序与输出一致', () => {
    const seq = all.map((m) => (m.kind === 'tool_use' ? `tool:${m.name}` : m.kind));
    expect(seq.slice(1, 6)).toEqual(['text', 'tool:Bash', 'tool:Glob', 'tool_result', 'tool_result']);
    expect(kinds('tool_use').map((m) => (m as Extract<AgentMessage, { kind: 'tool_use' }>).name)).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Bash', 'Glob']),
    );
  });

  it('工具结果带上对应的 tool_use id 与成败', () => {
    const uses = new Map(kinds('tool_use').map((m) => [(m as { id: string }).id, m]));
    for (const r of kinds('tool_result') as Array<Extract<AgentMessage, { kind: 'tool_result' }>>) {
      expect(uses.has(r.id)).toBe(true);
    }
    const failed = (kinds('tool_result') as Array<Extract<AgentMessage, { kind: 'tool_result' }>>).filter((r) => r.isError);
    // 第一次 npm test（红）和被拒绝的 npm view
    expect(failed.length).toBe(2);
  });

  it('识别权限拒绝事件，并能关联到被拒绝的命令', () => {
    const denied = kinds('denied')[0] as Extract<AgentMessage, { kind: 'denied' }>;
    expect(denied.toolName).toBe('Bash');
    const use = kinds('tool_use').find((m) => (m as { id: string }).id === denied.toolUseId) as Extract<AgentMessage, { kind: 'tool_use' }>;
    expect(use.input.command).toBe('npm view lodash version');
  });

  it('解析结果：成功、花费、轮数', () => {
    const result = kinds('result')[0] as Extract<AgentMessage, { kind: 'result' }>;
    expect(result).toMatchObject({ ok: true, subtype: 'success' });
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.turns).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('忽略空行、损坏行和未知类型', () => {
    expect(parseClaudeLine('')).toEqual([]);
    expect(parseClaudeLine('not json')).toEqual([]);
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseClaudeLine('{"type":"system","subtype":"commands_changed"}')).toEqual([]);
  });

  it('错误结果被识别为失败', () => {
    const [m] = parseClaudeLine('{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":3.1,"num_turns":9}');
    expect(m).toMatchObject({ kind: 'result', ok: false, subtype: 'error_max_budget_usd', costUsd: 3.1 });
  });

  it('tool_result 的内容可以是数组', () => {
    const [m] = parseClaudeLine(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":[{"type":"text","text":"x"},{"type":"text","text":"y"}]}]}}',
    );
    expect(m).toMatchObject({ kind: 'tool_result', id: 'a', isError: false, text: 'x\ny' });
  });
});

describe('summarizeTool', () => {
  it('Bash 显示命令首行，多行命令附详情', () => {
    expect(summarizeTool('Bash', { command: 'npm test' })).toEqual({ summary: 'npm test', detail: undefined });
    const multi = summarizeTool('Bash', { command: 'a\nb' });
    expect(multi.summary).toBe('a');
    expect(multi.detail).toBe('a\nb');
  });

  it('文件类工具显示相对路径', () => {
    expect(summarizeTool('Edit', { file_path: 'C:\\work\\T1\\src\\a.ts' }, 'C:\\work\\T1').summary).toBe('src\\a.ts');
    expect(summarizeTool('Read', { file_path: 'sum.js' }, '/x').summary).toBe('sum.js');
  });

  it('搜索类工具显示模式', () => {
    expect(summarizeTool('Glob', { pattern: '**/*.ts' }).summary).toBe('**/*.ts');
    expect(summarizeTool('Grep', { pattern: 'foo', path: 'src' }).summary).toContain('foo');
  });
});

describe('buildClaudeArgs', () => {
  const base = { sessionId: 'abc', resume: false, settingsPath: '/s.json' };

  it('首次用 --session-id，续接用 --resume', () => {
    expect(buildClaudeArgs(base)).toEqual(expect.arrayContaining(['--session-id', 'abc']));
    expect(buildClaudeArgs(base)).not.toContain('--resume');
    const resumed = buildClaudeArgs({ ...base, resume: true });
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(resumed).not.toContain('--session-id');
  });

  it('固定使用无人审批的权限模式和流式输出', () => {
    const args = buildClaudeArgs(base);
    expect(args).toEqual(expect.arrayContaining(['-p', '--verbose', '--output-format', 'stream-json']));
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(args.join(' ')).toContain('--permission-prompts none');
    expect(args.join(' ')).toContain('--settings /s.json');
  });

  it('不会危险地跳过权限检查', () => {
    expect(buildClaudeArgs({ ...base, model: 'sonnet', maxBudgetUsd: 3 }).join(' ')).not.toContain('dangerously');
  });

  it('可选的模型与预算', () => {
    const args = buildClaudeArgs({ ...base, model: 'provider/claude-x[1m]', maxBudgetUsd: 2.5 });
    expect(args).toEqual(expect.arrayContaining(['--model', 'provider/claude-x[1m]', '--max-budget-usd', '2.5']));
  });

  it('模型名含 shell 特殊字符时拒绝', () => {
    expect(() => buildClaudeArgs({ ...base, model: 'x & calc' })).toThrow();
    expect(isValidModel('opus')).toBe(true);
    expect(isValidModel('a;b')).toBe(false);
  });

  it('提示词从不出现在参数里', () => {
    const withPrompt = { ...base, prompt: 'SECRET-MARKER-123' } as Parameters<typeof buildClaudeArgs>[0];
    expect(buildClaudeArgs(withPrompt).join(' ')).not.toContain('SECRET-MARKER-123');
  });
});

describe('quoteShellArg', () => {
  it('简单参数原样返回，含空格或非 ASCII 的加引号', () => {
    expect(quoteShellArg('--verbose')).toBe('--verbose');
    expect(quoteShellArg('C:\\Users\\a b\\s.json')).toBe('"C:\\Users\\a b\\s.json"');
    expect(quoteShellArg('C:\\用户\\s.json')).toBe('"C:\\用户\\s.json"');
  });

  it('拒绝会被 cmd 展开或截断的字符', () => {
    for (const bad of ['a"b', '%PATH%', 'a^b', 'a!b', 'a\nb']) expect(() => quoteShellArg(bad)).toThrow();
  });
});
