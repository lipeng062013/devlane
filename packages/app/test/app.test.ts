import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { HttpError } from '../src/domain';
import type { JiraApi } from '../src/jira';
import { StateStore } from '../src/store';
import { TaskManager } from '../src/tasks';
import { FakeAgent, denied, fixSum } from './fake-agent';
import { cleanupTemp, makeRepo, sh, tempDir } from './helpers';

afterEach(cleanupTemp);

const PORT = 7788;
const HOST = `127.0.0.1:${PORT}`;

class FakeJira implements JiraApi {
  searches: Array<{ jql: string; limit?: number; pageToken?: string }> = [];
  async myself() {
    return { name: '李明', email: 'me@example.com' };
  }
  async search(jql: string, opts: { limit?: number; pageToken?: string } = {}) {
    this.searches.push({ jql, ...opts });
    return {
      issues: [
        {
          key: 'HOUSE-7',
          summary: '登录页按钮无响应',
          type: 'Bug',
          status: '处理中',
          statusCategory: 'indeterminate',
          updated: '2026-10-28T00:00:00Z',
          url: 'https://x/browse/HOUSE-7',
        },
      ],
      nextPageToken: opts.pageToken ? undefined : 'next',
    };
  }
  async get(key: string) {
    if (key === 'HOUSE-404') throw new HttpError(404, 'Jira 里找不到这条记录或接口（404）');
    return {
      key,
      summary: '登录页按钮无响应',
      type: 'Bug',
      status: '处理中',
      statusCategory: 'indeterminate',
      updated: '',
      url: `https://x/browse/${key}`,
      description: '复现步骤：…',
      labels: [],
      components: [],
      comments: [],
    };
  }
}

let app: FastifyInstance;
let repo: string;
let store: StateStore;
let jira: FakeJira;
let factoryCfg: { baseUrl: string; email: string; apiToken: string } | undefined;

async function setup(agent = new FakeAgent([fixSum])) {
  repo = makeRepo();
  store = new StateStore();
  jira = new FakeJira();
  const manager = new TaskManager({ store, agent, dataDir: tempDir('devlane-data-') });
  app = buildApp({
    store,
    manager,
    agent,
    port: PORT,
    jiraFactory: (cfg) => {
      factoryCfg = cfg;
      return jira;
    },
  });
  await app.ready();
  return { agent, manager };
}

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as object, headers: { host: HOST, 'x-devlane': '1', ...headers } });

async function addProject(extra: object = {}) {
  const res = await send('POST', '/api/projects', { path: repo, testCommand: 'node check.js', linkNodeModules: false, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function waitStatus(id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const t = store.data.tasks.find((x) => x.id === id)!;
    if (t.status === status) return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待状态 ${status} 超时，当前 ${store.data.tasks.find((x) => x.id === id)?.status}`);
}

afterEach(async () => {
  await app?.close();
});

describe('访问来源防护', () => {
  beforeEach(async () => {
    await setup();
  });

  it('本机地址可以访问', async () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
      expect((await get('/api/health', { host })).statusCode, host).toBe(200);
    }
  });

  it('其他 Host（DNS 重绑定）被拒绝，包括读取接口', async () => {
    for (const host of ['evil.example.com', `evil.example.com:${PORT}`, '127.0.0.1', `127.0.0.1:${PORT + 1}`, '']) {
      const res = await get('/api/state', { host });
      expect(res.statusCode, host).toBe(403);
    }
  });

  it('写操作没有自定义请求头被拒绝', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/inspect', payload: { path: repo }, headers: { host: HOST } });
    expect(res.statusCode).toBe(403);
  });

  it('写操作来自其他网站（Origin 不符）被拒绝，即使带了请求头', async () => {
    const res = await send('POST', '/api/projects/inspect', { path: repo }, { origin: 'https://evil.example.com' });
    expect(res.statusCode).toBe(403);
    expect(store.data.projects).toHaveLength(0);
  });

  it('来自本页面的写操作（Origin 匹配）可以通过', async () => {
    const res = await send('POST', '/api/projects/inspect', { path: repo }, { origin: `http://localhost:${PORT}` });
    expect(res.statusCode).toBe(200);
  });

  it('实时推送接口同样受 Host 保护', async () => {
    expect((await get('/api/stream', { host: 'evil.com' })).statusCode).toBe(403);
  });

  it('不放行任何跨域读取', async () => {
    const res = await get('/api/state', { origin: 'https://evil.example.com' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
  });

  it('不存在的接口返回 JSON 404 或 404', async () => {
    expect((await get('/api/nothing')).statusCode).toBe(404);
  });
});

describe('项目', () => {
  beforeEach(async () => {
    await setup();
  });

  it('检查路径：返回分支、基线、脏状态', async () => {
    sh(repo, 'branch', 'develop');
    const res = await send('POST', '/api/projects/inspect', { path: repo });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ currentBranch: 'main', suggestedBase: 'main', dirty: false, hasCommits: true });
    expect(res.json().branches).toEqual(expect.arrayContaining(['main', 'develop']));
  });

  it.each([
    ['', '请输入项目路径'],
    ['not/absolute', '绝对路径'],
    ['C:\\definitely\\not\\here\\xyz', '路径不存在'],
  ])('检查无效路径 %j', async (path, text) => {
    const res = await send('POST', '/api/projects/inspect', { path });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(text);
  });

  it('不是 git 仓库的文件夹', async () => {
    const res = await send('POST', '/api/projects/inspect', { path: tempDir() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('不是 git 仓库');
  });

  it('添加项目：默认名称取文件夹名，基线取推荐值，默认链接 node_modules', async () => {
    const res = await send('POST', '/api/projects', { path: `"${repo}"` });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'P1', baseBranch: 'main', testCommand: '', linkNodeModules: true });
    expect(res.json().name.length).toBeGreaterThan(0);
  });

  it('同一个仓库不能重复添加', async () => {
    await addProject();
    const res = await send('POST', '/api/projects', { path: repo });
    expect(res.statusCode).toBe(409);
  });

  it('基线分支名不合法被拒绝', async () => {
    const res = await send('POST', '/api/projects', { path: repo, baseBranch: 'a;b' });
    expect(res.statusCode).toBe(400);
  });

  it('修改项目配置', async () => {
    await addProject();
    const res = await send('PATCH', '/api/projects/P1', { name: '演示', testCommand: 'npm test', extraAllowed: ['npm run lint', ' ', 'npm run lint'] });
    expect(res.json()).toMatchObject({ name: '演示', testCommand: 'npm test', extraAllowed: ['npm run lint'] });
    expect((await send('PATCH', '/api/projects/P9', { name: 'x' })).statusCode).toBe(404);
    expect((await send('PATCH', '/api/projects/P1', { name: '' })).statusCode).toBe(400);
  });

  it('有未丢弃的任务时不能删除项目，丢弃后可以', async () => {
    await addProject();
    const created = await send('POST', '/api/tasks', { projectId: 'P1', kind: 'bug', title: '求和错误' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await waitStatus(id, 'review');

    const blocked = await send('DELETE', '/api/projects/P1');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain('丢弃');

    await send('POST', `/api/tasks/${id}/discard`, {});
    expect((await send('DELETE', '/api/projects/P1')).statusCode).toBe(200);
    expect(store.data.projects).toHaveLength(0);
  });
});

describe('任务流程（通过 HTTP）', () => {
  it('创建、查看过程与变更、提交、丢弃', async () => {
    await setup();
    await addProject();
    const created = await send('POST', '/api/tasks', { projectId: 'P1', kind: 'bug', title: '求和错误', description: 'add(2,3)=-1' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await waitStatus(id, 'review');

    const timeline = (await get(`/api/tasks/${id}/timeline`)).json().items as Array<{ seq: number; type: string }>;
    expect(timeline.map((i) => i.type)).toEqual(expect.arrayContaining(['prompt', 'text', 'tool', 'result']));
    const later = (await get(`/api/tasks/${id}/timeline?after=${timeline[1]!.seq}`)).json().items;
    expect(later).toHaveLength(timeline.length - 2);

    const changes = (await get(`/api/tasks/${id}/changes`)).json();
    expect(changes.files).toEqual([expect.objectContaining({ path: 'sum.js', status: 'M', additions: 1, deletions: 1 })]);

    const commit = await send('POST', `/api/tasks/${id}/commit`, { message: 'fix: 求和' });
    expect(commit.json()).toMatchObject({ status: 'committed' });

    const state = (await get('/api/state')).json();
    expect(state.tasks[0]).toMatchObject({ id, status: 'committed' });

    const discarded = await send('POST', `/api/tasks/${id}/discard`, {});
    expect(discarded.json().status).toBe('discarded');
    expect((await get(`/api/tasks/${id}/changes`)).statusCode).toBe(409);
  });

  it('被拦截的命令：允许后继续', async () => {
    const { agent } = await setup(new FakeAgent([denied('npm install lodash'), fixSum]));
    await addProject();
    const id = (await send('POST', '/api/tasks', { projectId: 'P1', kind: 'feature', title: '加依赖' })).json().id as string;
    const task = await waitStatus(id, 'needs_you');
    expect(task.denials[0]).toMatchObject({ command: 'npm install lodash', allowable: true });

    expect((await send('POST', `/api/tasks/${id}/allow`, { denialIds: [] })).statusCode).toBe(400);
    expect((await send('POST', `/api/tasks/${id}/allow`, { denialIds: ['d1'], mode: 'exact' })).statusCode).toBe(200);
    await waitStatus(id, 'review');
    expect(agent.calls).toHaveLength(2);
  });

  it('停止测试：没有运行中的测试返回 409，未知任务返回 404', async () => {
    await setup();
    await addProject();
    const id = (await send('POST', '/api/tasks', { projectId: 'P1', kind: 'bug', title: 'x' })).json().id as string;
    await waitStatus(id, 'review');
    const none = await send('POST', `/api/tasks/${id}/test/stop`, {});
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toContain('没有正在运行');
    expect((await send('POST', '/api/tasks/T99/test/stop', {})).statusCode).toBe(404);
    // 缺少请求头同样被拒绝
    const raw = await app.inject({ method: 'POST', url: `/api/tasks/${id}/test/stop`, headers: { host: HOST } });
    expect(raw.statusCode).toBe(403);
  });

  it('追问与停止', async () => {
    const { agent } = await setup(new FakeAgent([fixSum]));
    await addProject();
    const id = (await send('POST', '/api/tasks', { projectId: 'P1', kind: 'bug', title: 'x' })).json().id as string;
    await waitStatus(id, 'review');
    expect((await send('POST', `/api/tasks/${id}/message`, { text: '' })).statusCode).toBe(400);
    expect((await send('POST', `/api/tasks/${id}/message`, { text: '再检查一遍' })).statusCode).toBe(200);
    await waitStatus(id, 'review');
    expect(agent.calls[1]!.prompt).toBe('再检查一遍');
    expect((await send('POST', `/api/tasks/${id}/stop`, {})).statusCode).toBe(409);
  });

  it('参数错误给出明确提示', async () => {
    await setup();
    await addProject();
    const r1 = await send('POST', '/api/tasks', { projectId: 'P1', kind: 'bug', title: '' });
    expect(r1.statusCode).toBe(400);
    const r2 = await send('POST', '/api/tasks', { projectId: 'P9', kind: 'bug', title: 'x' });
    expect(r2.statusCode).toBe(404);
    expect((await get('/api/tasks/T99/timeline')).statusCode).toBe(404);
  });
});

describe('设置', () => {
  beforeEach(async () => {
    await setup();
  });

  it('默认值', async () => {
    const s = (await get('/api/state')).json().settings;
    expect(s).toMatchObject({ maxBudgetUsd: 3, maxConcurrent: 2, editorCommand: 'code', jira: null });
  });

  it('修改通用设置', async () => {
    const res = await send('PUT', '/api/settings', { maxBudgetUsd: 5, maxConcurrent: 3, model: 'sonnet', editorCommand: 'cursor', claudePath: '' });
    expect(res.json()).toMatchObject({ maxBudgetUsd: 5, maxConcurrent: 3, model: 'sonnet', editorCommand: 'cursor' });
  });

  it.each([
    [{ maxBudgetUsd: 0 }, '预算'],
    [{ maxBudgetUsd: 1000 }, '预算'],
    [{ maxConcurrent: 0 }, '任务数'],
    [{ maxConcurrent: 99 }, '任务数'],
    [{ editorCommand: 'code && calc' }, '编辑器'],
    [{ editorCommand: 'a b' }, '编辑器'],
    [{ model: 'x & calc' }, '模型'],
  ])('拒绝不合法的设置 %j', async (body, text) => {
    const res = await send('PUT', '/api/settings', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(text);
  });
});

describe('Jira', () => {
  beforeEach(async () => {
    await setup();
  });

  const configure = () =>
    send('PUT', '/api/settings/jira', { baseUrl: 'https://house730.atlassian.net/some/path', email: 'me@example.com', apiToken: 'secret-token-123' });

  it('没配置时提示去设置', async () => {
    const res = await get('/api/jira/issues');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('设置');
  });

  it('保存配置：地址规范化，Token 永远不会返回给界面', async () => {
    const res = await configure();
    expect(res.statusCode).toBe(200);
    expect(res.json().jira).toEqual({ baseUrl: 'https://house730.atlassian.net', email: 'me@example.com', hasToken: true, defaultJql: '' });
    expect(res.body).not.toContain('secret-token-123');
    expect((await get('/api/state')).body).not.toContain('secret-token-123');
    // 内部确实保存了
    expect(store.data.settings.jira?.apiToken).toBe('secret-token-123');
  });

  it('更新时不填 Token 表示保持原来的', async () => {
    await configure();
    const res = await send('PUT', '/api/settings/jira', { email: 'new@example.com' });
    expect(res.statusCode).toBe(200);
    expect(store.data.settings.jira).toMatchObject({ email: 'new@example.com', apiToken: 'secret-token-123' });
  });

  it.each([
    [{ baseUrl: 'nonsense', email: 'a@b.c', apiToken: 't' }, '地址'],
    [{ baseUrl: 'https://x.atlassian.net', email: 'no-at', apiToken: 't' }, '邮箱'],
    [{ baseUrl: 'https://x.atlassian.net', email: 'a@b.c' }, 'Token'],
  ])('拒绝不完整的配置 %j', async (body, text) => {
    const res = await send('PUT', '/api/settings/jira', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(text);
  });

  it('测试连接', async () => {
    await configure();
    const res = await send('POST', '/api/jira/test', {});
    expect(res.json()).toEqual({ ok: true, user: { name: '李明', email: 'me@example.com' } });
    expect(factoryCfg).toMatchObject({ baseUrl: 'https://house730.atlassian.net', email: 'me@example.com' });
  });

  it('列表默认是「指派给我且未完成」', async () => {
    await configure();
    const res = await get('/api/jira/issues');
    expect(res.statusCode).toBe(200);
    expect(res.json().jql).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
    expect(res.json().issues[0]).toMatchObject({ key: 'HOUSE-7', type: 'Bug' });
    expect(res.json().nextPageToken).toBe('next');
  });

  it('范围、搜索、翻页、自定义 JQL', async () => {
    await configure();
    await get('/api/jira/issues?scope=reported&q=HOUSE-7');
    expect(jira.searches.at(-1)!.jql).toContain('reporter = currentUser()');
    expect(jira.searches.at(-1)!.jql).toContain('key = "HOUSE-7"');

    await get('/api/jira/issues?pageToken=abc&limit=5');
    expect(jira.searches.at(-1)).toMatchObject({ pageToken: 'abc', limit: 5 });

    const custom = await get(`/api/jira/issues?jql=${encodeURIComponent('project = HOUSE ORDER BY created')}`);
    expect(custom.json().jql).toBe('project = HOUSE ORDER BY created');
  });

  it('配置了默认 JQL 且没有任何筛选时使用它', async () => {
    await send('PUT', '/api/settings/jira', { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', defaultJql: 'project = HOUSE' });
    const res = await get('/api/jira/issues');
    expect(res.json().jql).toBe('project = HOUSE');
    const filtered = await get('/api/jira/issues?scope=mine');
    expect(filtered.json().jql).toContain('currentUser()');
  });

  it('详情，以及 Jira 返回的错误原样透传状态码', async () => {
    await configure();
    const ok = await get('/api/jira/issues/HOUSE-7');
    expect(ok.json()).toMatchObject({ key: 'HOUSE-7', description: '复现步骤：…' });
    expect((await get('/api/jira/issues/HOUSE-404')).statusCode).toBe(404);
  });

  it('删除配置', async () => {
    await configure();
    const res = await send('DELETE', '/api/settings/jira');
    expect(res.json().jira).toBeNull();
    expect(store.data.settings.jira).toBeUndefined();
  });
});

describe('环境信息', () => {
  it('返回 claude / git / gh 版本', async () => {
    await setup();
    const env = (await get('/api/env')).json();
    expect(env.claude).toBe('9.9.9 (fake)');
    expect(env.git).toContain('git version');
  });
});
