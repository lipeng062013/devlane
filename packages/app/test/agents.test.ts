import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../src/agents/registry';
import { normalizeAgentProvider } from '../src/domain';
import { StateStore } from '../src/store';
import { TaskManager } from '../src/tasks';
import { FakeAgent, justFinish } from './fake-agent';
import { cleanupTemp, makeRepo, tempDir } from './helpers';
import { afterEach } from 'vitest';

afterEach(cleanupTemp);

describe('normalizeAgentProvider', () => {
  it('缺省与非法值读作 claude', () => {
    expect(normalizeAgentProvider(undefined)).toBe('claude');
    expect(normalizeAgentProvider(null)).toBe('claude');
    expect(normalizeAgentProvider('cursor')).toBe('claude');
    expect(normalizeAgentProvider('codex')).toBe('codex');
    expect(normalizeAgentProvider('grok-build')).toBe('grok-build');
  });
});

describe('createAgentRegistry', () => {
  it('三家各返回不同实例且实现 version', async () => {
    const reg = createAgentRegistry();
    const a = reg.getAgent('claude');
    const b = reg.getAgent('codex');
    const c = reg.getAgent('grok-build');
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(reg.getAgent('claude')).toBe(a);
    // version 不抛；找不到二进制时可为 null
    const v = await a.version();
    expect(v === null || typeof v === 'string').toBe(true);
  });
});

describe('createTask agentProvider', () => {
  it('持久化 provider；旧任务无字段当 claude', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    const agent = new FakeAgent([justFinish]);
    const manager = new TaskManager({ store, agent, dataDir });
    // 手工加项目
    store.data.projects.push({
      id: 'P1',
      name: 'demo',
      path: repo,
      baseBranch: 'main',
      testCommand: '',
      extraAllowed: [],
      linkNodeModules: false,
      createdAt: new Date().toISOString(),
    });
    store.save();

    const t1 = await manager.createTask({
      projectId: 'P1',
      kind: 'bug',
      title: '用 codex',
      agentProvider: 'codex',
    });
    expect(t1.agentProvider).toBe('codex');
    expect(store.data.tasks.find((x) => x.id === t1.id)?.agentProvider).toBe('codex');

    const t2 = await manager.createTask({ projectId: 'P1', kind: 'feature', title: '默认' });
    expect(t2.agentProvider).toBe('claude');

    // 模拟旧任务无字段
    const legacy = store.data.tasks.find((x) => x.id === t2.id)!;
    delete (legacy as { agentProvider?: string }).agentProvider;
    store.save();
    expect(normalizeAgentProvider(legacy.agentProvider)).toBe('claude');
  });
});

describe('environment 三家互不拖垮', () => {
  it('一家 version 抛错不影响其余', async () => {
    const { buildApp } = await import('../src/app');
    const store = new StateStore();
    const dataDir = tempDir('devlane-data-');
    const ok = new FakeAgent([justFinish]);
    class BoomAgent extends FakeAgent {
      override async version(): Promise<string | null> {
        throw new Error('boom');
      }
    }
    const boom = new BoomAgent([justFinish]);
    const manager = new TaskManager({
      store,
      getAgent: (p) => (p === 'codex' ? boom : ok),
      dataDir,
    });
    const app = buildApp({
      store,
      manager,
      getAgent: (p) => (p === 'codex' ? boom : ok),
      port: 7788,
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/env', headers: { host: '127.0.0.1:7788' } });
    const env = res.json();
    expect(env.claude).toBe('9.9.9 (fake)');
    expect(env.codex).toBeNull();
    expect(env.grokBuild).toBe('9.9.9 (fake)');
    await app.close();
  });
});


describe('buildGrokArgs headless', () => {
  it('用 --prompt-file，不用裸 - / TUI PROMPT', async () => {
    const { buildGrokArgs } = await import('../src/agents/grok-build');
    const args = buildGrokArgs('C:\\tmp\\prompt.txt');
    expect(args).toContain('--prompt-file');
    expect(args).toContain('C:\\tmp\\prompt.txt');
    expect(args).toContain('--output-format');
    expect(args).toContain('streaming-json');
    expect(args).not.toContain('-');
    expect(args[0]).not.toBe('-');
  });

  it('带上模型和思考强度，续接时用 --resume', async () => {
    const { buildGrokArgs } = await import('../src/agents/grok-build');
    const args = buildGrokArgs({
      promptFile: 'C:\\tmp\\prompt.txt',
      model: 'grok-4.6',
      effort: 'high',
      resumeSessionId: 'sess-1',
    });
    expect(args).toEqual(expect.arrayContaining(['--model', 'grok-4.6', '--effort', 'high', '--resume', 'sess-1']));
  });
});

describe('parseGrokModels', () => {
  it('读出 id，星号是默认', async () => {
    const { parseGrokModels } = await import('../src/agents/grok-build');
    const models = parseGrokModels('Available models:\n  - grok-4.7\n  * magpie/tokenshop/grok-4.7 (default)\n  - magpie/remote-magpie/infron/qwen/qwen3.8-27b:free\n');
    expect(models).toEqual([
      { id: 'grok-4.7', isDefault: false },
      { id: 'magpie/tokenshop/grok-4.7', isDefault: true },
      { id: 'magpie/remote-magpie/infron/qwen/qwen3.8-27b:free', isDefault: false },
    ]);
  });
});

describe('discoverCapabilities', () => {
  it('项目覆盖同名个人 skill，并读出 toml 与 json 的 MCP', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { discoverCapabilities } = await import('../src/agents/capabilities');
    const root = mkdtempSync(join(tmpdir(), 'devlane-cap-'));
    const project = join(root, 'repo');
    const home = join(root, 'home');
    mkdirSync(join(project, '.grok', 'skills', 'review'), { recursive: true });
    mkdirSync(join(home, '.grok', 'skills', 'review'), { recursive: true });
    mkdirSync(join(home, '.claude', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(project, '.grok', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n');
    writeFileSync(join(home, '.grok', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n');
    writeFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { local: {} } }));
    writeFileSync(join(home, '.grok', 'config.toml'), '[mcp_servers.atlassian]\ncommand = "npx"\n');
    const items = discoverCapabilities({ projectPath: project, home });
    expect(items.find((item) => item.name === 'review')).toMatchObject({ kind: 'skill', scope: 'project' });
    expect(items.find((item) => item.name === 'mine')).toMatchObject({ scope: 'user' });
    expect(items.find((item) => item.name === 'local')).toMatchObject({ kind: 'mcp', scope: 'project' });
    expect(items.find((item) => item.name === 'atlassian')).toMatchObject({ kind: 'mcp', scope: 'user' });
  });
});

describe('parseGrokStreamLine', () => {
  it('工具和文字在结束前就能解析，end 带轮数', async () => {
    const { parseGrokStreamLine } = await import('../src/agents/grok-build');
    expect(parseGrokStreamLine('{"type":"text","data":"先看代码"}')).toEqual([{ kind: 'text', text: '先看代码' }]);
    expect(parseGrokStreamLine('{"type":"tool_call","toolCallId":"c1","toolName":"read_file","rawInput":{"path":"a.ts"}}')).toMatchObject([
      { kind: 'tool_use', id: 'c1', name: 'read_file' },
    ]);
    expect(parseGrokStreamLine('{"type":"tool_call_update","toolCallId":"c1","status":null,"content":[{"type":"content","content":{"type":"text","text":"User cancelled the execution for tool"}}]}')).toEqual([]);
    const end = parseGrokStreamLine('{"type":"end","num_turns":3,"total_cost_usd":0.1,"sessionId":"s"}');
    expect(end[0]).toMatchObject({ kind: 'result', turns: 3, costUsd: 0.1, costKnown: true, sessionId: 's' });
  });
});

describe('local model catalogs', () => {
  it('读 Claude modelPicker 和 Codex slug', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readClaudeModels, readCodexModels } = await import('../src/agents/local-models');
    const dir = mkdtempSync(join(tmpdir(), 'devlane-models-'));
    const claude = join(dir, 'settings.json');
    writeFileSync(claude, JSON.stringify({ model: 'sonnet', modelPicker: { options: [{ model: 'opus', label: 'Opus' }, { model: 'sonnet', label: 'Sonnet' }] } }));
    expect(readClaudeModels(claude)).toEqual([
      { id: 'opus', isDefault: false, label: 'Opus' },
      { id: 'sonnet', isDefault: true, label: 'Sonnet' },
    ]);
    const config = join(dir, 'config.toml');
    const catalog = join(dir, 'models.json');
    writeFileSync(config, 'model = "gpt-a"\n');
    writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'gpt-a', display_name: 'A' }, { slug: 'gpt-b', visibility: 'hidden' }] }));
    expect(readCodexModels(config, catalog)).toEqual([{ id: 'gpt-a', isDefault: true, label: 'A' }]);
  });
});

describe('parseGrokResult', () => {
  it('读出轮数、花费和会话；缺花费时不当成 0', async () => {
    const { parseGrokResult } = await import('../src/agents/grok-build');
    const full = parseGrokResult('{"text":"done","num_turns":4,"total_cost_usd":0.2,"sessionId":"abc"}');
    expect(full).toMatchObject({ text: 'done', turns: 4, costUsd: 0.2, costKnown: true, sessionId: 'abc', ok: true });
    const missing = parseGrokResult('{"text":"done","num_turns":2,"sessionId":"abc"}');
    expect(missing).toMatchObject({ turns: 2, costUsd: 0, costKnown: false });
    expect(parseGrokResult('not json')).toBeNull();
  });
});

describe('startRun 按 provider 选型', () => {
  it('codex 任务调用 getAgent(codex) 而非 claude', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    store.data.projects.push({
      id: 'P1',
      name: 'demo',
      path: repo,
      baseBranch: 'main',
      testCommand: '',
      extraAllowed: [],
      linkNodeModules: false,
      createdAt: new Date().toISOString(),
    });
    store.save();

    const seen: string[] = [];
    const make = (name: string) => {
      const a = new FakeAgent([justFinish]);
      const orig = a.start.bind(a);
      a.start = (opts, onMessage) => {
        seen.push(name);
        return orig(opts, onMessage);
      };
      return a;
    };
    const agents = {
      claude: make('claude'),
      codex: make('codex'),
      'grok-build': make('grok-build'),
    } as const;
    const manager = new TaskManager({
      store,
      getAgent: (p) => agents[p],
      dataDir,
    });
    const task = await manager.createTask({
      projectId: 'P1',
      kind: 'bug',
      title: '选型',
      agentProvider: 'codex',
    });
    // pump 会 startRun
    manager.pump();
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toContain('codex');
    expect(seen).not.toContain('claude');
    expect(normalizeAgentProvider(task.agentProvider)).toBe('codex');
  });
});
