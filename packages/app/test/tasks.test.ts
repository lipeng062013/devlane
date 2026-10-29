import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, type Project, type Task } from '../src/domain';
import { DEFAULT_BUG_PROMPT, DEFAULT_FEATURE_PROMPT } from '../src/prompt';
import { git, hasUncommitted } from '../src/git';
import { StateStore } from '../src/store';
import { TaskManager } from '../src/tasks';
import { FakeAgent, type Script, denied, fixSum, hang, init, justFinish, result } from './fake-agent';
import { cleanupTemp, makeRepo, sh, tempDir } from './helpers';

afterEach(cleanupTemp);

const CHECK_JS = "const fs = require('fs');\nconst s = fs.readFileSync('sum.js', 'utf8');\nconsole.log('checking');\nprocess.exit(s.includes('a + b') ? 0 : 1);\n";
// 模拟一个跑很久的测试：先输出一行，记下自己的进程号，然后一直挂着
const SLOW_JS = "const fs = require('fs');\nfs.writeFileSync('slow.pid', String(process.pid));\nconsole.log('started');\nsetInterval(() => {}, 1000);\n";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function setup(scripts: Script[], opts: { maxConcurrent?: number; project?: Partial<Project> } = {}) {
  const repo = makeRepo({ 'check.js': CHECK_JS, 'slow.js': SLOW_JS });
  const dataDir = tempDir('devlane-data-');
  const store = new StateStore();
  store.data.settings.maxConcurrent = opts.maxConcurrent ?? 2;
  const project: Project = {
    id: 'P1',
    name: 'demo',
    path: repo,
    baseBranch: 'main',
    testCommand: 'node check.js',
    extraAllowed: [],
    linkNodeModules: false,
    createdAt: new Date().toISOString(),
    ...opts.project,
  };
  store.data.projects.push(project);
  const agent = new FakeAgent(scripts);
  const manager = new TaskManager({ store, agent, dataDir });
  return { repo, dataDir, store, agent, manager, project };
}

async function waitFor(cond: () => boolean, what = '条件', ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const bug = { projectId: 'P1', kind: 'bug' as const, title: '求和结果错误', description: 'add(2,3) 应该是 5' };

async function expectHttp(p: Promise<unknown>, status: number, text?: string): Promise<void> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  if (text) expect((err as HttpError).message).toContain(text);
}

describe('创建任务', () => {
  it('建独立 worktree 和分支，立刻开始运行，提示词包含要求', async () => {
    const { manager, agent, repo } = setup([hang]);
    const task = await manager.createTask({ ...bug, jiraKey: 'ABC-12' });
    expect(task.status).toBe('running');
    expect(task.id).toBe('T1');
    expect(task.branch).toMatch(/^devlane\/fix-abc-12-[0-9a-f]{4}$/);
    expect(existsSync(join(task.worktreePath, 'sum.js'))).toBe(true);
    expect(task.baseSha).toBe(sh(repo, 'rev-parse', 'main').trim());

    const call = agent.calls[0]!;
    expect(call.cwd).toBe(task.worktreePath);
    expect(call.resume).toBe(false);
    expect(call.sessionId).toBe(task.sessionId);
    expect(call.prompt).toContain('求和结果错误');
    expect(call.prompt).toContain('add(2,3) 应该是 5');
    expect(call.prompt).toContain('ABC-12');
    expect(call.prompt).toContain('node check.js');
    expect(call.prompt).toContain('不要执行 git commit、git push');
    expect(call.prompt).toContain('缺陷修复');
    expect(call.maxBudgetUsd).toBe(3);
    // 主仓库完全没动
    expect(await hasUncommitted(repo)).toBe(false);
    expect((await git(repo, ['branch', '--show-current'])).trim()).toBe('main');
  });

  it('需求类任务用需求提示词', async () => {
    const { manager, agent } = setup([hang]);
    await manager.createTask({ ...bug, kind: 'feature', title: '支持乘法' });
    expect(agent.calls[0]!.prompt).toContain('需求开发');
    expect(agent.calls[0]!.prompt).toContain('补充测试');
    expect(DEFAULT_FEATURE_PROMPT).toContain('{{title}}');
    expect(DEFAULT_BUG_PROMPT).toContain('缺陷修复');
  });

  it('写出权限文件：允许测试命令，禁止提交与推送', async () => {
    const { manager, agent } = setup([hang]);
    await manager.createTask(bug);
    const settings = JSON.parse(readFileSync(agent.calls[0]!.settingsPath, 'utf8'));
    expect(settings.permissions.allow).toContain('Bash(node check.js)');
    expect(settings.permissions.deny).toContain('Bash(git push:*)');
    expect(settings.permissions.deny).toContain('Bash(git commit:*)');
  });

  it('可以指定基线分支', async () => {
    const { manager, repo } = setup([hang]);
    sh(repo, 'branch', 'develop');
    const task = await manager.createTask({ ...bug, baseBranch: 'develop' });
    expect(task.baseBranch).toBe('develop');
  });

  it('参数校验', async () => {
    const { manager } = setup([hang]);
    await expectHttp(manager.createTask({ ...bug, title: '  ' }), 400, '标题');
    await expectHttp(manager.createTask({ ...bug, title: 'x'.repeat(201) }), 400);
    await expectHttp(manager.createTask({ ...bug, kind: 'other' as never }), 400, '类型');
    await expectHttp(manager.createTask({ ...bug, jiraKey: 'bad key' }), 400, 'Jira');
    await expectHttp(manager.createTask({ ...bug, projectId: 'P9' }), 404);
    await expectHttp(manager.createTask({ ...bug, baseBranch: 'a b;c' }), 400);
    await expectHttp(manager.createTask({ ...bug, baseBranch: 'nope' }), 400, '创建工作区失败');
  });

  it('创建失败不会留下半成品任务', async () => {
    const { manager, store } = setup([hang]);
    await manager.createTask({ ...bug, baseBranch: 'nope' }).catch(() => undefined);
    expect(store.data.tasks).toHaveLength(0);
  });
});

describe('运行与审阅', () => {
  it('Claude 完成后进入待审阅，记录时间线与花费，变更可见', async () => {
    const { manager, repo } = setup([fixSum]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review', '待审阅');

    expect(task.costUsd).toBeCloseTo(0.25);
    expect(task.turns).toBe(3);
    expect(task.sessionStarted).toBe(true);

    const items = manager.timeline.read(task.id);
    expect(items.map((i) => i.type)).toEqual(expect.arrayContaining(['note', 'prompt', 'text', 'tool', 'tool_result', 'result']));
    const seqs = items.map((i) => i.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const changes = await manager.getChanges(task.id);
    expect(changes.files.map((f) => f.path)).toEqual(['sum.js']);
    expect(changes.patch).toContain('+  return a + b;');
    expect(await hasUncommitted(repo)).toBe(false);
    expect(readFileSync(join(repo, 'sum.js'), 'utf8')).toContain('a - b');
  });

  it('时间线可以按 seq 增量读取', async () => {
    const { manager } = setup([fixSum]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    const all = manager.timeline.read(task.id);
    const tail = manager.timeline.read(task.id, all[2]!.seq);
    expect(tail).toHaveLength(all.length - 3);
  });

  it('运行失败（无结果、退出码非零）时标记失败并带上错误输出', async () => {
    const crash: Script = () => ({ code: 1, stderr: 'Error: not logged in\nPlease run /login' });
    const { manager } = setup([crash]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'failed');
    expect(task.lastError).toContain('Please run /login');
  });

  it('超出预算：失败并说明可以调高预算后继续', async () => {
    const over: Script = (opts, emit) => {
      emit(init(opts));
      emit(result({ ok: false, subtype: 'error_max_budget_usd', text: '', costUsd: 3.1 }));
    };
    const { manager } = setup([over]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'failed');
    expect(task.lastError).toContain('预算');
    expect(task.costUsd).toBeCloseTo(3.1);
  });

  it('找不到 claude 时给出可读的提示', async () => {
    const missing: Script = () => ({ code: null, stderr: '找不到 claude 命令。请先安装 Claude Code' });
    const { manager } = setup([missing]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'failed');
    expect(task.lastError).toContain('找不到 claude');
  });
});

describe('权限拦截', () => {
  it('被拦截的命令进入「待你决定」，允许后用 --resume 续接并放行那条命令', async () => {
    const { manager, agent } = setup([denied('npm install lodash'), justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'needs_you', '待你决定');

    expect(task.denials).toHaveLength(1);
    expect(task.denials[0]).toMatchObject({ tool: 'Bash', command: 'npm install lodash', status: 'pending', allowable: true });

    await manager.allowDenials(task.id, ['d1'], 'exact');
    await waitFor(() => task.status === 'review', '待审阅');

    expect(task.denials[0]!.status).toBe('allowed');
    expect(task.approvedRules).toEqual(['Bash(npm install lodash)']);
    const second = agent.calls[1]!;
    expect(second.resume).toBe(true);
    expect(second.sessionId).toBe(task.sessionId);
    expect(second.prompt).toContain('npm install lodash');
    const settings = JSON.parse(readFileSync(second.settingsPath, 'utf8'));
    expect(settings.permissions.allow).toContain('Bash(npm install lodash)');
    // 永久禁止清单不会因为放行而改变
    expect(settings.permissions.deny).toContain('Bash(git push:*)');
  });

  it('同类前缀放行', async () => {
    const { manager } = setup([denied('npm install lodash'), justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'needs_you');
    await manager.allowDenials(task.id, ['d1'], 'prefix');
    expect(task.approvedRules).toEqual(['Bash(npm install:*)']);
  });

  it('危险命令不能放行', async () => {
    const { manager } = setup([denied('git push origin main')]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'needs_you');
    expect(task.denials[0]!.allowable).toBe(false);
    await expectHttp(manager.allowDenials(task.id, ['d1'], 'exact'), 400, '无法放行');
    expect(task.approvedRules).toEqual([]);
    expect(task.status).toBe('needs_you');
  });

  it('非命令类的拦截（例如越界写文件）不能放行', async () => {
    const { manager } = setup([denied('/etc/hosts', 'Edit')]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'needs_you');
    expect(task.denials[0]).toMatchObject({ tool: 'Edit', allowable: false });
    await expectHttp(manager.allowDenials(task.id, ['d1'], 'exact'), 400);
  });

  it('忽略后直接进入待审阅', async () => {
    const { manager } = setup([denied('npm install lodash')]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'needs_you');
    await manager.ignoreDenials(task.id);
    expect(task.status).toBe('review');
    expect(task.denials[0]!.status).toBe('ignored');
  });

  it('同一个拦截不会重复记录', async () => {
    const twice: Script = (opts, emit) => {
      emit(init(opts));
      emit({ kind: 'tool_use', id: 'd1', name: 'Bash', input: { command: 'npm i' } });
      emit({ kind: 'denied', toolUseId: 'd1', toolName: 'Bash' });
      emit({ kind: 'denied', toolUseId: 'd1', toolName: 'Bash' });
      emit(result());
    };
    const { manager } = setup([twice]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'needs_you');
    expect(task.denials).toHaveLength(1);
  });
});

describe('追问、停止与重启', () => {
  it('追问沿用同一会话', async () => {
    const { manager, agent } = setup([fixSum, justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.sendMessage(task.id, '再补一个边界测试');
    await waitFor(() => agent.calls.length === 2 && task.status === 'review');
    expect(agent.calls[1]).toMatchObject({ resume: true, prompt: '再补一个边界测试', sessionId: task.sessionId });
    expect(task.runCount).toBe(2);
    expect(task.costUsd).toBeCloseTo(0.5);
  });

  it('追问内容不能为空，运行中不能追问', async () => {
    const { manager } = setup([hang]);
    const task = await manager.createTask(bug);
    await expectHttp(manager.sendMessage(task.id, 'x'), 409);
    await manager.stop(task.id);
    await waitFor(() => task.status === 'stopped');
    await expectHttp(manager.sendMessage(task.id, '   '), 400);
  });

  it('停止会终止进程，之后可以继续', async () => {
    const { manager, agent } = setup([hang, justFinish]);
    const task = await manager.createTask(bug);
    await manager.stop(task.id);
    await waitFor(() => task.status === 'stopped');
    expect(agent.killCount).toBe(1);
    await manager.sendMessage(task.id, '请继续');
    await waitFor(() => task.status === 'review');
    expect(agent.calls[1]!.resume).toBe(true);
  });

  it('第一次运行还没建立会话就被停止时，继续仍用 --session-id', async () => {
    const early: Script = async (_opts, _emit, ctl) => {
      await ctl.untilKilled();
    };
    const { manager, agent } = setup([early, justFinish]);
    const task = await manager.createTask(bug);
    await manager.stop(task.id);
    await waitFor(() => task.status === 'stopped');
    expect(task.sessionStarted).toBe(false);
    await manager.sendMessage(task.id, '继续');
    await waitFor(() => task.status === 'review');
    expect(agent.calls[1]!.resume).toBe(false);
  });

  it('不在运行的任务不能停止', async () => {
    const { manager } = setup([justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await expectHttp(manager.stop(task.id), 409);
  });

  it('服务重启后，运行中的任务变成已停止，可以继续', async () => {
    const { manager, store, dataDir } = setup([hang]);
    const task = await manager.createTask(bug);
    expect(task.status).toBe('running');
    const agent2 = new FakeAgent([justFinish]);
    const manager2 = new TaskManager({ store, agent: agent2, dataDir });
    const reloaded = manager2.getTask(task.id);
    expect(reloaded.status).toBe('stopped');
    expect(reloaded.lastError).toContain('重启');
    await manager2.sendMessage(task.id, '继续');
    await waitFor(() => reloaded.status === 'review');
    manager.shutdown();
  });
});

describe('并发', () => {
  it('超过并发上限的任务排队，前一个结束后自动开始', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Script = async (opts, emit) => {
      emit(init(opts));
      await gate;
      emit(result());
    };
    const { manager, agent } = setup([slow], { maxConcurrent: 1 });
    const t1 = await manager.createTask(bug);
    const t2 = await manager.createTask({ ...bug, title: '第二个' });
    expect(t1.status).toBe('running');
    expect(t2.status).toBe('queued');
    expect(agent.calls).toHaveLength(1);
    release();
    await waitFor(() => t2.status === 'review', '第二个完成');
    expect(t1.status).toBe('review');
    expect(agent.calls).toHaveLength(2);
  });

  it('取消排队', async () => {
    const { manager } = setup([hang], { maxConcurrent: 1 });
    await manager.createTask(bug);
    const t2 = await manager.createTask({ ...bug, title: '第二个' });
    await manager.stop(t2.id);
    expect(t2.status).toBe('stopped');
    manager.shutdown();
  });
});

describe('提交', () => {
  it('提交到任务分支，主分支不受影响', async () => {
    const { manager, repo } = setup([fixSum]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.commit(task.id, 'fix: 修复求和\n\nJira ABC-1');
    expect(task.status).toBe('committed');
    expect(task.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(repo, ['log', '-1', '--format=%s', task.branch])).trim()).toBe('fix: 修复求和');
    expect((await git(repo, ['log', '-1', '--format=%s', 'main'])).trim()).toBe('init');
    expect((await manager.getChanges(task.id)).files).toHaveLength(1);
  });

  it('没有改动、说明为空、Claude 仍在运行时拒绝提交', async () => {
    const { manager } = setup([justFinish, hang]);
    const t1 = await manager.createTask(bug);
    await waitFor(() => t1.status === 'review');
    await expectHttp(manager.commit(t1.id, 'x'), 409, '没有可提交');
    await expectHttp(manager.commit(t1.id, ' '), 400);
    const t2 = await manager.createTask({ ...bug, title: '另一个' });
    await expectHttp(manager.commit(t2.id, 'x'), 409, '还在工作');
    manager.shutdown();
  });

  it('创建 PR 需要先提交，且仓库要有 origin', async () => {
    const { manager } = setup([fixSum]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await expectHttp(manager.openPullRequest(task.id, { title: 't', body: '' }), 409, '先提交');
    await manager.commit(task.id, 'fix');
    await expectHttp(manager.openPullRequest(task.id, { title: 't', body: '' }), 400, 'origin');
    await expectHttp(manager.openPullRequest(task.id, { title: ' ', body: '' }), 400, '标题');
  });

  it('提交后还有新改动时不允许开 PR', async () => {
    const { manager, repo } = setup([fixSum]);
    const remote = tempDir('devlane-remote-');
    sh(remote, 'init', '-q', '--bare', '-b', 'main');
    sh(repo, 'remote', 'add', 'origin', remote);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.commit(task.id, 'fix');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(task.worktreePath, 'late.txt'), 'x');
    await expectHttp(manager.openPullRequest(task.id, { title: 't', body: '' }), 409, '未提交');
  });
});

describe('丢弃', () => {
  it('删除工作区与分支，保留记录', async () => {
    const { manager, repo } = setup([fixSum]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.discard(task.id);
    expect(task.status).toBe('discarded');
    expect(existsSync(task.worktreePath)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'devlane/*').trim()).toBe('');
    expect(readFileSync(join(repo, 'sum.js'), 'utf8')).toContain('a - b');
    await expectHttp(manager.getChanges(task.id), 409);
    await expectHttp(manager.sendMessage(task.id, 'x'), 409);
  });

  it('运行中丢弃会先终止进程', async () => {
    const { manager, agent } = setup([hang]);
    const task = await manager.createTask(bug);
    await manager.discard(task.id);
    expect(agent.killCount).toBe(1);
    expect(task.status).toBe('discarded');
    expect(existsSync(task.worktreePath)).toBe(false);
  });

  it('重复丢弃是幂等的', async () => {
    const { manager } = setup([justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.discard(task.id);
    await expect(manager.discard(task.id)).resolves.toBe(task);
  });

  it('工作区被用户手动删掉后仍能丢弃', async () => {
    const { manager } = setup([justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    const { rmSync } = await import('node:fs');
    rmSync(task.worktreePath, { recursive: true, force: true });
    await manager.discard(task.id);
    expect(task.status).toBe('discarded');
  });
});

describe('测试命令', () => {
  it('运行中能实时看到输出，并且可以停止：进程树被真正终止，状态为已停止', async () => {
    const { manager } = setup([justFinish], { project: { testCommand: 'node slow.js' } });
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');

    await manager.runTests(task.id);
    await waitFor(() => task.test?.output.includes('started') === true, '实时输出');
    expect(task.test?.status).toBe('running');

    const pid = Number(readFileSync(join(task.worktreePath, 'slow.pid'), 'utf8'));
    expect(alive(pid)).toBe(true);

    await manager.stopTests(task.id);
    await waitFor(() => task.test?.status !== 'running', '测试结束');
    expect(task.test?.status).toBe('stopped');
    expect(task.test?.output).toContain('started');
    expect(task.test?.output).toContain('已被你停止');
    await waitFor(() => !alive(pid), '测试进程退出', 8000);
  });

  it('停止之后可以重新运行', async () => {
    const { manager, store } = setup([justFinish], { project: { testCommand: 'node slow.js' } });
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.runTests(task.id);
    await waitFor(() => task.test?.output.includes('started') === true);
    await manager.stopTests(task.id);
    await waitFor(() => task.test?.status === 'stopped');

    store.data.projects[0]!.testCommand = 'node check.js';
    await manager.runTests(task.id);
    await waitFor(() => task.test?.status !== 'running');
    expect(task.test?.status).toBe('failed');
    expect(task.test?.output).toContain('checking');
    expect(task.test?.output).not.toContain('已被你停止');
  });

  it('没有正在运行的测试时停止返回 409', async () => {
    const { manager } = setup([justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await expectHttp(manager.stopTests(task.id), 409, '没有正在运行');
    await manager.runTests(task.id);
    await waitFor(() => task.test?.status !== 'running');
    await expectHttp(manager.stopTests(task.id), 409, '没有正在运行');
  });

  it('测试还在运行时丢弃任务：先终止测试进程，再干净地删除工作区', async () => {
    const { manager } = setup([justFinish], { project: { testCommand: 'node slow.js' } });
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.runTests(task.id);
    await waitFor(() => task.test?.output.includes('started') === true);
    const pid = Number(readFileSync(join(task.worktreePath, 'slow.pid'), 'utf8'));

    await manager.discard(task.id);
    expect(task.status).toBe('discarded');
    expect(existsSync(task.worktreePath)).toBe(false);
    await waitFor(() => !alive(pid), '测试进程退出', 8000);
  });

  it('在任务工作区里运行项目的测试命令：失败再通过', async () => {
    const { manager } = setup([justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');

    await manager.runTests(task.id);
    expect(task.test?.status).toBe('running');
    await waitFor(() => task.test?.status !== 'running', '测试结束');
    expect(task.test).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(task.test?.output).toContain('checking');

    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(task.worktreePath, 'sum.js'), 'export const add = (a, b) => a + b;\n');
    await manager.runTests(task.id);
    await waitFor(() => task.test?.status !== 'running');
    expect(task.test).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(task.test!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('测试运行期间不能重复启动；没配置命令时报错', async () => {
    const { manager, store } = setup([justFinish]);
    const task = await manager.createTask(bug);
    await waitFor(() => task.status === 'review');
    await manager.runTests(task.id);
    await expectHttp(manager.runTests(task.id), 409);
    await waitFor(() => task.test?.status !== 'running');
    store.data.projects[0]!.testCommand = '';
    await expectHttp(manager.runTests(task.id), 400, '测试命令');
  });
});

describe('其他', () => {
  it('任务状态在 state 里完整，且 getTask 对未知 id 返回 404', async () => {
    const { manager } = setup([justFinish]);
    await expectHttp(Promise.resolve().then(() => manager.getTask('T99')), 404);
  });

  it('项目被删除后排队的任务会失败而不是崩溃', async () => {
    const { manager, store } = setup([hang], { maxConcurrent: 1 });
    await manager.createTask(bug);
    const t2 = await manager.createTask({ ...bug, title: '第二个' });
    store.data.projects = [];
    manager.shutdown();
    await waitFor(() => (t2 as Task).status === 'failed', '失败');
    expect(t2.lastError).toContain('项目');
  });
});
