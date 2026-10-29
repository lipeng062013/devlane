/**
 * 跨仓/多项目：仅用临时 fixture 仓（makeRepo），禁止拿用户真实仓当唯一证据或做破坏性操作。
 * FakeGh 注入 openPrDeps，不连真 GitHub。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Project } from '../src/domain';
import { worktreesRootFor } from '../src/git';
import { StateStore } from '../src/store';
import { TaskManager } from '../src/tasks';
import { FakeAgent, hang, justFinish } from './fake-agent';
import { cleanupTemp, makeRepo, sh, tempDir } from './helpers';

afterEach(cleanupTemp);

function addProject(store: StateStore, repo: string, id: string, name: string): Project {
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

async function waitStatus(manager: TaskManager, id: string, status: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (true) {
    const task = manager.getTask(id);
    if (task.status === status) return;
    if (Date.now() - start > ms) throw new Error(`等待 ${status} 超时，当前 ${task.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('multi-project / 双 fixture 仓（mock only）', () => {
  it('T1 两个不同 path 均可 POST /api/projects', async () => {
    const repoA = makeRepo({ 'a-only.txt': 'A' });
    const repoB = makeRepo({ 'b-only.txt': 'B' });
    expect(resolve(repoA)).not.toBe(resolve(repoB));

    const store = new StateStore();
    const dataDir = tempDir('devlane-data-');
    const agent = new FakeAgent([hang]);
    const manager = new TaskManager({ store, agent, dataDir });
    const app = buildApp({ store, manager, agent, port: 7791 });
    await app.ready();
    try {
      const host = { host: '127.0.0.1:7791', 'x-devlane': '1' };
      const a = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repoA, linkNodeModules: false }, headers: host });
      const b = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repoB, linkNodeModules: false }, headers: host });
      expect(a.statusCode, a.body).toBe(201);
      expect(b.statusCode, b.body).toBe(201);
      expect(a.json().path).not.toBe(b.json().path);
      expect(store.data.projects).toHaveLength(2);

      const dup = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: repoA, linkNodeModules: false }, headers: host });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toContain('已经添加过了');
    } finally {
      await app.close();
    }
  });

  it('T2 各项目任务 projectId 正确，worktree 分属两仓侧', async () => {
    const repoA = makeRepo({ 'a-only.txt': 'A' });
    const repoB = makeRepo({ 'b-only.txt': 'B' });
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    addProject(store, repoA, 'P1', '仓A');
    addProject(store, repoB, 'P2', '仓B');
    const manager = new TaskManager({ store, agent: new FakeAgent([justFinish]), dataDir });

    const tA = await manager.createTask({ projectId: 'P1', kind: 'bug', title: '任务A', description: 'da' });
    const tB = await manager.createTask({ projectId: 'P2', kind: 'feature', title: '任务B', description: 'db' });

    expect(tA.projectId).toBe('P1');
    expect(tB.projectId).toBe('P2');

    const rootA = worktreesRootFor(repoA, dataDir);
    const rootB = worktreesRootFor(repoB, dataDir);
    const norm = (p: string) => resolve(p).toLowerCase();
    expect(norm(tA.worktreePath) === norm(rootA) || norm(tA.worktreePath).startsWith(norm(rootA) + sep.toLowerCase())).toBe(true);
    expect(norm(tB.worktreePath) === norm(rootB) || norm(tB.worktreePath).startsWith(norm(rootB) + sep.toLowerCase())).toBe(true);
    expect(resolve(tA.worktreePath)).not.toBe(resolve(tB.worktreePath));
    expect(existsSync(join(tA.worktreePath, 'a-only.txt'))).toBe(true);
    expect(existsSync(join(tA.worktreePath, 'b-only.txt'))).toBe(false);
    expect(existsSync(join(tB.worktreePath, 'b-only.txt'))).toBe(true);
    expect(existsSync(join(tB.worktreePath, 'a-only.txt'))).toBe(false);
  });

  it('T3 两任务 commit 后 B 仓工作区无 A 的改动', async () => {
    const repoA = makeRepo({ 'marker.txt': 'base' });
    const repoB = makeRepo({ 'marker.txt': 'base' });
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    addProject(store, repoA, 'P1', '仓A');
    addProject(store, repoB, 'P2', '仓B');
    const manager = new TaskManager({ store, agent: new FakeAgent([justFinish, justFinish]), dataDir });

    const tA = await manager.createTask({ projectId: 'P1', kind: 'bug', title: '改A' });
    const tB = await manager.createTask({ projectId: 'P2', kind: 'bug', title: '改B' });

    await waitStatus(manager, tA.id, 'review');
    await waitStatus(manager, tB.id, 'review');

    writeFileSync(join(tA.worktreePath, 'marker.txt'), 'from-A-only');
    writeFileSync(join(tA.worktreePath, 'a-extra.txt'), 'secret-A');
    await manager.commit(tA.id, 'commit A');

    expect(readFileSync(join(tB.worktreePath, 'marker.txt'), 'utf8')).toBe('base');
    expect(existsSync(join(tB.worktreePath, 'a-extra.txt'))).toBe(false);
    expect(existsSync(join(repoB, 'a-extra.txt'))).toBe(false);
    expect(readFileSync(join(repoB, 'marker.txt'), 'utf8')).toBe('base');
    // A 主仓也未因 worktree 提交被污染到 B 文件
    expect(existsSync(join(repoA, 'a-extra.txt'))).toBe(false);
  });

  it('T4 FakeGh 两任务 open PR：create cwd 各为各自 worktree，不串', async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    // 本地 bare origin，满足 openPullRequest 对 origin 的检查；push 走 Fake
    for (const repo of [repoA, repoB]) {
      const bare = tempDir('devlane-bare-');
      sh(bare, 'init', '-q', '--bare');
      sh(repo, 'remote', 'add', 'origin', bare);
    }

    const createCalls: Array<{ cwd: string; head: string; title: string }> = [];
    const dataDir = tempDir('devlane-data-');
    const store = new StateStore();
    addProject(store, repoA, 'P1', '仓A');
    addProject(store, repoB, 'P2', '仓B');
    const manager = new TaskManager({
      store,
      agent: new FakeAgent([justFinish, justFinish]),
      dataDir,
      openPrDeps: {
        ghVersion: async () => 'gh fake 0.0',
        pushBranch: async () => {},
        createPullRequest: async (cwd, opts) => {
          createCalls.push({ cwd, head: opts.head, title: opts.title });
          return `https://github.com/example/${basename(cwd)}/pull/${createCalls.length}`;
        },
      },
    });

    const tA = await manager.createTask({ projectId: 'P1', kind: 'bug', title: 'PRA' });
    const tB = await manager.createTask({ projectId: 'P2', kind: 'bug', title: 'PRB' });
    await waitStatus(manager, tA.id, 'review');
    await waitStatus(manager, tB.id, 'review');
    writeFileSync(join(tA.worktreePath, 'x.txt'), 'a');
    writeFileSync(join(tB.worktreePath, 'x.txt'), 'b');
    await manager.commit(tA.id, 'a');
    await manager.commit(tB.id, 'b');

    await manager.openPullRequest(tA.id, { title: 'PR for A', body: '' });
    await manager.openPullRequest(tB.id, { title: 'PR for B', body: '' });

    expect(createCalls).toHaveLength(2);
    expect(resolve(createCalls[0]!.cwd)).toBe(resolve(tA.worktreePath));
    expect(resolve(createCalls[1]!.cwd)).toBe(resolve(tB.worktreePath));
    expect(createCalls[0]!.cwd).not.toBe(createCalls[1]!.cwd);
    expect(createCalls.map((c) => c.title)).toEqual(['PR for A', 'PR for B']);
    // 无 merge 写
    expect(JSON.stringify(createCalls)).not.toMatch(/pr merge/i);
  });
});