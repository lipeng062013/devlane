import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { JiraClient } from '../src/jira';
import type { Orchestrator } from '../src/orchestrator';
import { makeHarness } from './helpers';

const PASSWORD = 'correct horse';

let app: FastifyInstance;
let orch: Orchestrator;
let cookie = '';

async function setup(jira: JiraClient | null = null): Promise<void> {
  const h = await makeHarness();
  orch = h.orch;
  app = buildApp({ orchestrator: orch, password: PASSWORD, tickMs: 1000, maxParallel: 3, jira, jiraJql: 'project = X' });
  await app.ready();
}

async function login(): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const set = res.headers['set-cookie'];
  cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
}

const authed = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { cookie } });

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await app.close();
});

describe('认证', () => {
  it('健康检查不需要登录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('未登录访问业务接口返回 401', async () => {
    for (const url of ['/api/snapshot', '/api/me', '/api/stream']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    const post = await app.inject({ method: 'POST', url: '/api/issues', payload: { title: 'x' } });
    expect(post.statusCode).toBe(401);
  });

  it('口令错误返回 401 且不下发会话', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('伪造的会话 cookie 被拒绝', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'devlane_session=abc' } });
    expect(res.statusCode).toBe(401);
  });

  it('登录后下发 HttpOnly 的会话 cookie，并能访问业务接口', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(res.headers['set-cookie'])).toMatch(/SameSite=Strict/);
    await login();
    expect((await authed('GET', '/api/me')).statusCode).toBe(200);
  });

  it('连续输错口令超过上限后被限流，即使之后输对也暂时拒绝', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } });
    expect(blocked.statusCode).toBe(429);
  });

  it('响应带安全头', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
  });
});

describe('业务接口', () => {
  beforeEach(login);

  it('快照包含配置、需求和就绪评分', async () => {
    const res = await authed('GET', '/api/snapshot');
    const body = res.json();
    expect(body.config).toMatchObject({ executor: 'simulated', maxParallel: 3, jiraConfigured: false });
    expect(body.issues).toHaveLength(5);
    expect(body.issues[0].readiness.score).toBe(100);
  });

  it('创建需求并校验标题', async () => {
    const bad = await authed('POST', '/api/issues', { title: '  ' });
    expect(bad.statusCode).toBe(400);
    const ok = await authed('POST', '/api/issues', { title: '新需求', type: 'Bug', components: ['a', 'b'] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ id: 'DL-106', type: 'bug', components: ['a', 'b'], source: 'manual' });
  });

  it('开泳道、排队、推进、合并的完整流程', async () => {
    const created = await authed('POST', '/api/issues/DL-103/lane');
    expect(created.statusCode).toBe(201);
    const laneId = created.json().id as string;

    expect((await authed('POST', `/api/lanes/${laneId}/actions`, { action: 'queue' })).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) await orch.tick();

    const snap = (await authed('GET', '/api/snapshot')).json();
    expect(snap.lanes[0].state).toBe('reviewing');
    expect(snap.events[laneId].length).toBeGreaterThan(5);

    const verify = await authed('GET', `/api/lanes/${laneId}/verify`);
    expect(verify.json()).toMatchObject({ ok: true });

    const merged = await authed('POST', `/api/lanes/${laneId}/actions`, { action: 'merge' });
    expect(merged.json().state).toBe('merged');
  });

  it('未就绪需求开泳道返回 422', async () => {
    const res = await authed('POST', '/api/issues/DL-104/lane');
    expect(res.statusCode).toBe(422);
    expect(res.json().details.missing.length).toBeGreaterThan(0);
  });

  it('未知操作返回 400，未知泳道返回 404', async () => {
    const created = await authed('POST', '/api/issues/DL-103/lane');
    const laneId = created.json().id as string;
    expect((await authed('POST', `/api/lanes/${laneId}/actions`, { action: 'explode' })).statusCode).toBe(400);
    expect((await authed('POST', '/api/lanes/L-999/actions', { action: 'queue' })).statusCode).toBe(404);
    expect((await authed('GET', '/api/lanes/L-999/verify')).statusCode).toBe(404);
  });

  it('门禁处理需要合法的 decision', async () => {
    expect((await authed('POST', '/api/gates/G-1/resolve', { decision: 'maybe' })).statusCode).toBe(400);
    expect((await authed('POST', '/api/gates/G-1/resolve', { decision: 'approve' })).statusCode).toBe(404);
  });

  it('故事泳道经 HTTP 批准门禁后继续', async () => {
    const created = await authed('POST', '/api/issues/DL-102/lane');
    const laneId = created.json().id as string;
    await authed('POST', `/api/lanes/${laneId}/actions`, { action: 'queue' });
    for (let i = 0; i < 12; i++) await orch.tick();

    const blocked = (await authed('GET', '/api/snapshot')).json();
    expect(blocked.lanes[0].state).toBe('blocked');
    const gateId = blocked.gates[0].id as string;
    expect((await authed('POST', `/api/gates/${gateId}/resolve`, { decision: 'approve' })).statusCode).toBe(200);
    for (let i = 0; i < 12; i++) await orch.tick();
    expect((await authed('GET', '/api/snapshot')).json().lanes[0].state).toBe('reviewing');
  });

  it('未配置 Jira 时导入返回 503', async () => {
    const res = await authed('POST', '/api/jira/import', {});
    expect(res.statusCode).toBe(503);
  });

  it('不存在的接口返回 404 JSON', async () => {
    const res = await authed('GET', '/api/nothing');
    expect(res.statusCode).toBe(404);
  });
});

describe('Jira 导入接口', () => {
  it('导入后需求出现在快照里，重复导入走更新', async () => {
    await app.close();
    const jira = new JiraClient({
      baseUrl: 'https://example.atlassian.net',
      email: 'a@b.c',
      apiToken: 't',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            isLast: true,
            issues: [{ key: 'HOUSE-7', fields: { summary: '来自 Jira', issuetype: { name: 'Bug' } } }],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await setup(jira);
    await login();

    const first = await authed('POST', '/api/jira/import', {});
    expect(first.json()).toMatchObject({ fetched: 1, created: 1, updated: 0 });
    const second = await authed('POST', '/api/jira/import', {});
    expect(second.json()).toMatchObject({ created: 0, updated: 1 });

    const snap = (await authed('GET', '/api/snapshot')).json();
    expect(snap.config.jiraConfigured).toBe(true);
    expect(snap.issues.find((i: { id: string }) => i.id === 'HOUSE-7')).toMatchObject({ source: 'jira', type: 'bug' });
  });
});
