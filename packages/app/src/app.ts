import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentAdapter } from './claude';
import { type AgentProvider, HttpError, normalizeAgentProvider } from './domain';
import { gitVersion, ghVersion, inspectRepo } from './git';
import { type JiraApi, JiraClient, type JiraScope, buildJql } from './jira';
import {
  addProject,
  publicSettings,
  removeProject,
  updateJira,
  updateProject,
  updateSettings,
} from './projects';
import { buildGuard } from './security';
import type { StateStore } from './store';
import type { Change, TaskManager } from './tasks';

export interface AppOptions {
  store: StateStore;
  manager: TaskManager;
  /** 按 provider 取适配器（优先）。 */
  getAgent?: (provider: AgentProvider) => AgentAdapter;
  /** 兼容旧测试：恒定返回同一 FakeAgent。 */
  agent?: AgentAdapter;
  port: number;
  webDir?: string;
  jiraFactory?: (cfg: { baseUrl: string; email: string; apiToken: string }) => JiraApi;
  prSnapshotFetcher?: (prUrl: string) => Promise<import('./domain').PrCheckSnapshot>;
  extraOrigins?: string[];
  logger?: boolean;
}

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  const { store, manager } = opts;
  const getAgent = opts.getAgent ?? ((_: AgentProvider) => {
    if (!opts.agent) throw new Error('buildApp 需要 getAgent 或 agent');
    return opts.agent;
  });
  const makeJira = opts.jiraFactory ?? ((cfg) => new JiraClient(cfg));

  app.addHook('onRequest', buildGuard(opts.port, opts.extraOrigins));
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: `服务器内部错误：${err.message}` });
  });

  // ---------- 环境 ----------
  let envCache: { at: number; value: Record<string, unknown> } | null = null;
  async function environment(force = false): Promise<Record<string, unknown>> {
    if (!force && envCache && Date.now() - envCache.at < 60_000) return envCache.value;
    const settings = store.data.settings;
    const [claude, codex, grokBuild, git, gh] = await Promise.all([
      getAgent('claude').version(settings.claudePath).catch(() => null),
      getAgent('codex').version(settings.codexPath).catch(() => null),
      getAgent('grok-build').version(settings.grokBuildPath).catch(() => null),
      gitVersion(),
      ghVersion(),
    ]);
    envCache = { at: Date.now(), value: { claude, codex, grokBuild, git, gh } };
    return envCache.value;
  }

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/env', async (req) => environment((req.query as { refresh?: string }).refresh === '1'));

  app.get('/api/state', async () => ({
    projects: store.data.projects,
    tasks: store.data.tasks,
    settings: publicSettings(store.data.settings),
  }));

  // ---------- 项目 ----------
  app.post('/api/projects/inspect', async (req) => inspectRepo(String(obj(req.body).path ?? '')));

  app.post('/api/projects', async (req, reply) => {
    const b = obj(req.body);
    const project = await addProject(
      store,
      {
        path: str(b.path),
        name: str(b.name),
        baseBranch: str(b.baseBranch),
        testCommand: str(b.testCommand),
        extraAllowed: Array.isArray(b.extraAllowed) ? b.extraAllowed.map(String) : undefined,
        linkNodeModules: typeof b.linkNodeModules === 'boolean' ? b.linkNodeModules : undefined,
      },
      new Date().toISOString(),
    );
    manager.emit('change', { type: 'projects', id: project.id } satisfies Change);
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    const b = obj(req.body);
    const project = updateProject(store, req.params.id, {
      name: str(b.name),
      baseBranch: str(b.baseBranch),
      testCommand: str(b.testCommand),
      extraAllowed: Array.isArray(b.extraAllowed) ? b.extraAllowed.map(String) : undefined,
      linkNodeModules: typeof b.linkNodeModules === 'boolean' ? b.linkNodeModules : undefined,
    });
    manager.emit('change', { type: 'projects', id: project.id } satisfies Change);
    return project;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    removeProject(store, req.params.id);
    manager.emit('change', { type: 'projects', id: req.params.id } satisfies Change);
    return { ok: true };
  });

  // ---------- 任务 ----------
  app.post('/api/tasks', async (req, reply) => {
    const b = obj(req.body);
    const task = await manager.createTask({
      projectId: String(b.projectId ?? ''),
      kind: b.kind as 'bug' | 'feature',
      title: String(b.title ?? ''),
      description: str(b.description),
      jiraKey: str(b.jiraKey),
      baseBranch: str(b.baseBranch),
      agentProvider: normalizeAgentProvider(b.agentProvider),
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : undefined,
      priority: str(b.priority) as 'high' | 'medium' | 'low' | 'none' | undefined,
    });
    return reply.code(201).send(task);
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const b = obj(req.body);
    const patch: { tags?: string[]; priority?: 'high' | 'medium' | 'low' | 'none' } = {};
    if ('tags' in b) patch.tags = Array.isArray(b.tags) ? (b.tags as string[]) : [];
    if ('priority' in b) patch.priority = str(b.priority) as 'high' | 'medium' | 'low' | 'none';
    return manager.updateTaskMeta(req.params.id, patch);
  });


  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/tasks/:id/timeline', async (req) => {
    manager.getTask(req.params.id);
    return { items: manager.timeline.read(req.params.id, Number(req.query.after ?? 0) || 0) };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/changes', async (req) => manager.getChanges(req.params.id));

  app.post<{ Params: { id: string } }>('/api/tasks/:id/message', async (req) =>
    manager.sendMessage(req.params.id, String(obj(req.body).text ?? '')),
  );

  app.post<{ Params: { id: string } }>('/api/tasks/:id/allow', async (req) => {
    const b = obj(req.body);
    const ids = Array.isArray(b.denialIds) ? b.denialIds.map(String) : [];
    return manager.allowDenials(req.params.id, ids, b.mode === 'prefix' ? 'prefix' : 'exact');
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/ignore', async (req) => manager.ignoreDenials(req.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (req) => manager.stop(req.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/test', async (req) => manager.runTests(req.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/test/stop', async (req) => manager.stopTests(req.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/discard', async (req) => manager.discard(req.params.id));

  app.post<{ Params: { id: string } }>('/api/tasks/:id/commit', async (req) =>
    manager.commit(req.params.id, String(obj(req.body).message ?? '')),
  );

  app.post<{ Params: { id: string } }>('/api/tasks/:id/pr', async (req) => {
    const b = obj(req.body);
    return manager.openPullRequest(req.params.id, { title: String(b.title ?? ''), body: String(b.body ?? '') });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/jira-comment', async (req) => {
    const force = Boolean(obj(req.body).force);
    return manager.writeJiraComment(req.params.id, { force });
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/pr-check', async (req) => manager.refreshPrCheck(req.params.id));


app.post<{ Params: { id: string } }>('/api/tasks/:id/open-editor', async (req) => {
    manager.openEditor(req.params.id);
    return { ok: true };
  });

  // ---------- 设置 ----------
  app.put('/api/settings', async (req) => {
    const b = obj(req.body);
    updateSettings(store, {
      claudePath: str(b.claudePath),
      codexPath: str(b.codexPath),
      grokBuildPath: str(b.grokBuildPath),
      model: str(b.model),
      maxBudgetUsd: b.maxBudgetUsd === undefined ? undefined : Number(b.maxBudgetUsd),
      maxConcurrent: b.maxConcurrent === undefined ? undefined : Number(b.maxConcurrent),
      editorCommand: str(b.editorCommand),
    });
    manager.emit('change', { type: 'settings', id: '' } satisfies Change);
    manager.pump();
    return publicSettings(store.data.settings);
  });

  app.put('/api/settings/jira', async (req) => {
    const b = obj(req.body);
    updateJira(store, {
      baseUrl: str(b.baseUrl),
      email: str(b.email),
      apiToken: str(b.apiToken),
      defaultJql: str(b.defaultJql),
      writeEnabled: b.writeEnabled === undefined ? undefined : Boolean(b.writeEnabled),
    });
    manager.emit('change', { type: 'settings', id: '' } satisfies Change);
    return publicSettings(store.data.settings);
  });

  app.delete('/api/settings/jira', async () => {
    store.data.settings.jira = undefined;
    store.save();
    manager.emit('change', { type: 'settings', id: '' } satisfies Change);
    return publicSettings(store.data.settings);
  });

  // ---------- Jira（查询 + 可选评论回写） ----------
  function jira(): JiraApi {
    const cfg = store.data.settings.jira;
    if (!cfg) throw new HttpError(400, '还没有配置 Jira，请先到「设置」页填写站点、邮箱和 API Token');
    return makeJira(cfg);
  }

  app.post('/api/jira/test', async () => ({ ok: true, user: await jira().myself() }));

  app.get<{ Querystring: { scope?: string; q?: string; jql?: string; pageToken?: string; limit?: string } }>(
    '/api/jira/issues',
    async (req) => {
      const client = jira();
      const { scope, q, jql: rawJql, pageToken } = req.query;
      let jql: string;
      if (rawJql && rawJql.trim()) {
        if (rawJql.length > 2000) throw new HttpError(400, 'JQL 过长');
        jql = rawJql.trim();
      } else if (!scope && !q && store.data.settings.jira?.defaultJql) {
        jql = store.data.settings.jira.defaultJql;
      } else {
        const s = scope === 'reported' || scope === 'recent' ? (scope as JiraScope) : 'mine';
        jql = buildJql({ scope: s, q });
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 30) || 30, 1), 100);
      const result = await client.search(jql, { limit, pageToken: pageToken || undefined });
      return { jql, ...result };
    },
  );

  app.get<{ Params: { key: string } }>('/api/jira/issues/:key', async (req) => jira().get(req.params.key));

  // ---------- 实时推送 ----------
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const onChange = (c: Change): void => {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
    };
    manager.on('change', onChange);
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      manager.off('change', onChange);
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
