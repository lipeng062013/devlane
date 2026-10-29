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
