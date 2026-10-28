import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { DomainError } from './domain';
import type { JiraClient } from './jira';
import { LANE_ACTIONS, type Change, type LaneAction, type Orchestrator } from './orchestrator';

export interface AppOptions {
  orchestrator: Orchestrator;
  /** 登录口令。所有 /api 接口（除健康检查和登录）都需要登录后的会话。 */
  password: string;
  /** 前端静态文件目录；不存在则只提供 API。 */
  webDir?: string;
  jira?: JiraClient | null;
  /** Jira 导入默认使用的 JQL。 */
  jiraJql?: string;
  tickMs: number;
  maxParallel: number;
  logger?: boolean;
}

const COOKIE = 'devlane_session';
const USER = 'admin';
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

function sessionToken(password: string): string {
  return createHmac('sha256', password).update('devlane-session-v1').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });
  const orch = opts.orchestrator;
  const expected = sessionToken(opts.password);
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const isAuthed = (cookieHeader: string | undefined): boolean => {
    const token = readCookie(cookieHeader, COOKIE);
    return token !== undefined && safeEqual(token, expected);
  };

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    );
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    if (path === '/api/health' || path === '/api/login') return;
    if (!isAuthed(req.headers.cookie)) {
      return reply.code(401).send({ error: '未登录' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({ error: err.message, details: err.details });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: '服务器内部错误' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/login', async (req, reply) => {
    const now = Date.now();
    const slot = attempts.get(req.ip);
    const current = slot && slot.resetAt > now ? slot : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    if (current.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: '尝试次数过多，请稍后再试' });
    }
    current.count += 1;
    attempts.set(req.ip, current);

    const given = String(asObject(req.body).password ?? '');
    if (!safeEqual(sessionToken(given), expected)) {
      return reply.code(401).send({ error: '口令不正确' });
    }
    attempts.delete(req.ip);
    reply.header('Set-Cookie', `${COOKIE}=${expected}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
    return { ok: true, user: USER };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/me', async () => ({ user: USER }));

  app.get('/api/snapshot', async () => ({
    config: {
      executor: 'simulated',
      maxParallel: opts.maxParallel,
      tickMs: opts.tickMs,
      jiraConfigured: Boolean(opts.jira),
    },
    ...(await orch.snapshot()),
  }));

  app.post('/api/issues', async (req, reply) => {
    const b = asObject(req.body);
    const issue = await orch.createIssue({
      title: String(b.title ?? ''),
      type: typeof b.type === 'string' ? b.type : undefined,
      markdown: typeof b.markdown === 'string' ? b.markdown : undefined,
      priority: typeof b.priority === 'string' ? b.priority : undefined,
      dueDate: typeof b.dueDate === 'string' ? b.dueDate : undefined,
      reporter: typeof b.reporter === 'string' ? b.reporter : undefined,
      assignee: typeof b.assignee === 'string' ? b.assignee : undefined,
      components: Array.isArray(b.components) ? b.components.map(String) : undefined,
    });
    return reply.code(201).send(issue);
  });

  app.post<{ Params: { id: string } }>('/api/issues/:id/lane', async (req, reply) => {
    const lane = await orch.createLane(req.params.id, USER);
    return reply.code(201).send(lane);
  });

  app.post<{ Params: { id: string } }>('/api/lanes/:id/actions', async (req) => {
    const action = String(asObject(req.body).action ?? '') as LaneAction;
    if (!LANE_ACTIONS.includes(action)) throw new DomainError(400, `未知操作 ${action}`);
    return orch.act(req.params.id, action, USER);
  });

  app.get<{ Params: { id: string } }>('/api/lanes/:id/verify', async (req) => orch.verifyLane(req.params.id));

  app.post<{ Params: { id: string } }>('/api/gates/:id/resolve', async (req) => {
    const decision = asObject(req.body).decision;
    if (decision !== 'approve' && decision !== 'reject') {
      throw new DomainError(400, 'decision 必须是 approve 或 reject');
    }
    return orch.resolveGate(req.params.id, decision, USER);
  });

  app.post('/api/jira/import', async (req) => {
    if (!opts.jira) throw new DomainError(503, '未配置 Jira 连接，请设置 JIRA_BASE_URL、JIRA_EMAIL、JIRA_API_TOKEN');
    const jql = typeof asObject(req.body).jql === 'string' ? String(asObject(req.body).jql) : opts.jiraJql;
    if (!jql) throw new DomainError(400, '缺少 JQL');
    let issues;
    try {
      issues = await opts.jira.searchIssues(jql, 100);
    } catch (err) {
      throw new DomainError(502, err instanceof Error ? err.message : 'Jira 请求失败');
    }
    return { fetched: issues.length, ...(await orch.upsertIssues(issues)) };
  });

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const onChange = (change: Change): void => {
      res.write(`data: ${JSON.stringify(change)}\n\n`);
    };
    orch.on('change', onChange);
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      orch.off('change', onChange);
    });
  });

  if (opts.webDir && existsSync(opts.webDir)) {
    void app.register(fastifyStatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
