/**
 * 搜索/标签/优先级：全 mock / fixture；禁止真实 Jira。
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Project } from '../src/domain';
import { StateStore } from '../src/store';
import { TaskManager } from '../src/tasks';
import { FakeAgent, hang } from './fake-agent';
import { cleanupTemp, makeRepo, tempDir } from './helpers';

afterEach(cleanupTemp);

function addProject(store: StateStore, repo: string, id = 'P1', name = '仓A'): Project {
  const project: Project = {
    id,
    name,
    path: repo,
    baseBranch: 'main',
    testCommand: '',
    extraAllowed: [],
    linkNodeModules: false,
    createdAt: new Date().toISOString(),
  };
  store.data.projects.push(project);
  return project;
}

describe('search-tags-priority API (mock only, zero real Jira)', () => {
  it('T3 create with tags/priority persists across store reload', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('devlane-data-');
    const statePath = join(dataDir, 'state.json');
    const store = new StateStore(statePath);
    addProject(store, repo);
    const manager = new TaskManager({ store, agent: new FakeAgent([hang]), dataDir });

    const task = await manager.createTask({
      projectId: 'P1',
      kind: 'bug',
      title: '带标签任务',
      description: 'desc',
      tags: ['  Alpha ', 'alpha', 'beta'],
      priority: 'high',
    });
    expect(task.tags).toEqual(['Alpha', 'beta']);
    expect(task.priority).toBe('high');

    const store2 = new StateStore(statePath);
    const reloaded = store2.data.tasks.find((t) => t.id === task.id)!;
    expect(reloaded.tags).toEqual(['Alpha', 'beta']);
    expect(reloaded.priority).toBe('high');
  });

  it('PATCH /api/tasks/:id updates tags/priority; discarded -> 409', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    addProject(store, repo);
    const manager = new TaskManager({ store, agent: new FakeAgent([hang, hang]), dataDir });
    const app = buildApp({ store, manager, agent: new FakeAgent([hang]), port: 7792 });
    await app.ready();
    try {
      const host = { host: '127.0.0.1:7792', 'x-devlane': '1' };
      const task = await manager.createTask({ projectId: 'P1', kind: 'bug', title: 'meta' });
      expect(task.priority).toBe('none');
      expect(task.tags).toEqual([]);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        headers: host,
        payload: { tags: ['ui', 'UI', 'core'], priority: 'medium' },
      });
      expect(patch.statusCode, patch.body).toBe(200);
      expect(patch.json().tags).toEqual(['ui', 'core']);
      expect(patch.json().priority).toBe('medium');

      await manager.discard(task.id);
      const bad = await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        headers: host,
        payload: { priority: 'low' },
      });
      expect(bad.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('T8 createTask path does not call real Jira (no jiraFactory used)', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    addProject(store, repo);
    let jiraCalls = 0;
    const manager = new TaskManager({
      store,
      agent: new FakeAgent([hang]),
      dataDir,
      jiraFactory: () => {
        jiraCalls += 1;
        throw new Error('must not touch Jira');
      },
    });
    await manager.createTask({
      projectId: 'P1',
      kind: 'feature',
      title: 'local only',
      tags: ['from-jira-labels'],
      priority: 'low',
    });
    expect(jiraCalls).toBe(0);
  });

  it('old tasks without tags/priority coerce on updateTaskMeta', async () => {
    const repo = makeRepo();
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    addProject(store, repo);
    const manager = new TaskManager({ store, agent: new FakeAgent([hang]), dataDir });
    const task = await manager.createTask({ projectId: 'P1', kind: 'bug', title: 'legacy' });
    // simulate pre-migration shape
    delete (task as { tags?: unknown }).tags;
    delete (task as { priority?: unknown }).priority;
    const updated = await manager.updateTaskMeta(task.id, { tags: ['x'] });
    expect(updated.tags).toEqual(['x']);
    expect(updated.priority).toBe('none');
  });
});
