// 在服务器上以 devlane 用户运行的冒烟测试：验证 Linux 上建 worktree、启动 claude 子进程、失败上报、丢弃清理。
// 不要求 claude 已登录：未登录时应该看到明确的失败原因，而不是卡住或崩溃。
// 用法：node remote-smoke.mjs [端口]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const base = `http://127.0.0.1:${process.argv[2] ?? '7790'}`;
const repo = '/opt/devlane/home/repos/_smoke';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'x-devlane': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
writeFileSync(`${repo}/a.txt`, 'hi\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

let projectId;
let taskId;
try {
  const p = await call('POST', '/api/projects', { path: repo, name: '_smoke', linkNodeModules: false });
  check('添加项目', p.status === 201, p.data?.error);
  projectId = p.data?.id;

  const t = await call('POST', '/api/tasks', { projectId, kind: 'feature', title: '冒烟：说一句话', description: '只回复“好”，不要修改任何文件。' });
  check('创建任务并建 worktree', t.status === 201 && existsSync(`${t.data?.worktreePath}/a.txt`), t.data?.worktreePath ?? t.data?.error);
  taskId = t.data?.id;

  let task;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    task = (await call('GET', '/api/state')).data.tasks.find((x) => x.id === taskId);
    if (!['queued', 'running'].includes(task.status)) break;
  }
  console.log(`  任务状态：${task.status}${task.lastError ? '；原因：' + task.lastError.split('\n')[0].slice(0, 160) : ''}`);
  check('claude 子进程已启动并结束（没有卡住）', !['queued', 'running'].includes(task.status), task.status);
  check('不是因为找不到 claude 而失败', !String(task.lastError ?? '').includes('找不到 claude'));
  if (task.status === 'failed') console.log('  （失败是预期的：服务器上的 claude 还没有登录。登录方式见部署说明）');
  if (task.status === 'review') console.log('  （任务竟然成功了：说明服务器上的 claude 已经有可用的认证）');
  check('主仓库没有被改动', git('status', '--porcelain').trim() === '' && git('branch', '--show-current').trim() === 'main');
} finally {
  if (taskId) {
    const d = await call('POST', `/api/tasks/${taskId}/discard`);
    check('丢弃任务', d.status === 200 && d.data?.status === 'discarded', d.data?.error);
  }
  if (projectId) {
    const r = await call('DELETE', `/api/projects/${projectId}`);
    check('移除测试项目', r.status === 200, r.data?.error);
  }
  rmSync(repo, { recursive: true, force: true });
}
const left = existsSync('/opt/devlane/home/.devlane/worktrees') ? execFileSync('ls', ['/opt/devlane/home/.devlane/worktrees'], { encoding: 'utf8' }).trim() : '';
check('没有遗留的工作区', left === '', left);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
