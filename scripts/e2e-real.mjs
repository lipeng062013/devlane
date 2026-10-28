// 真实端到端：用真正的 Claude 在一个临时仓库里修一个缺陷，走完 建项目 → 建任务 → 审阅 → 测试 → 提交 → 丢弃。
// 会产生真实的 API 费用（通常不到 1 美元）。
// 用法：node scripts/e2e-real.mjs [baseUrl]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:7788';
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

// ---- 准备一个有缺陷的临时仓库 ----
const repo = mkdtempSync(join(tmpdir(), 'devlane-e2e-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'e2e');
git('config', 'core.autocrlf', 'false');
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'sum.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
writeFileSync(
  join(repo, 'sum.test.js'),
  "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './sum.js';\ntest('add', () => { assert.strictEqual(add(2, 3), 5); });\ntest('add negative', () => { assert.strictEqual(add(-1, 1), 0); });\n",
);
writeFileSync(join(repo, 'package.json'), '{"name":"e2e-demo","type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
console.log(`临时仓库：${repo}`);

// ---- 项目 ----
const inspect = await call('POST', '/api/projects/inspect', { path: repo });
check('检查项目路径', inspect.status === 200 && inspect.data.currentBranch === 'main', inspect.data?.error);
const bad = await call('POST', '/api/projects/inspect', { path: join(repo, 'not-exist') });
check('不存在的路径被拒绝', bad.status === 400, bad.data?.error);

const project = await call('POST', '/api/projects', { path: repo, name: 'e2e-demo', testCommand: 'npm test', linkNodeModules: false });
check('添加项目', project.status === 201, project.data?.error);

// ---- 任务 ----
const created = await call('POST', '/api/tasks', {
  projectId: project.data.id,
  kind: 'bug',
  title: '修复 add 函数返回错误结果',
  description: 'add(2, 3) 返回 -1，应该返回 5。运行 npm test 可以看到失败。',
});
check('创建任务', created.status === 201, created.data?.error ?? created.data?.branch);
const id = created.data.id;
const wt = created.data.worktreePath;
check('建了独立工作区', existsSync(join(wt, 'sum.js')), wt);

const t0 = Date.now();
let task;
let lastSeq = 0;
for (;;) {
  const s = await call('GET', '/api/state');
  task = s.data.tasks.find((t) => t.id === id);
  const tl = await call('GET', `/api/tasks/${id}/timeline?after=${lastSeq}`);
  for (const it of tl.data.items) {
    lastSeq = it.seq;
    if (it.type === 'tool') console.log(`  · ${it.name} ${it.summary}`);
    else if (it.type === 'denied') console.log(`  ! 被拦截：${it.summary}`);
    else if (it.type === 'text') console.log(`  > ${it.text.split('\n')[0].slice(0, 90)}`);
  }
  if (['review', 'needs_you', 'failed', 'stopped'].includes(task.status)) break;
  if (Date.now() - t0 > 6 * 60_000) break;
  await sleep(2000);
}
console.log(`状态：${task.status}，花费 $${task.costUsd.toFixed(3)}，${task.turns} 轮，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
if (task.lastError) console.log('错误：', task.lastError);

if (task.status === 'needs_you') {
  console.log('被拦截的操作：', task.denials.map((d) => d.command ?? d.detail));
  await call('POST', `/api/tasks/${id}/ignore`);
}
check('Claude 完成一轮（待审阅）', ['review', 'needs_you'].includes(task.status), task.status);

// ---- 审阅 ----
const changes = await call('GET', `/api/tasks/${id}/changes`);
const files = changes.data.files.map((f) => f.path);
check('变更里有 sum.js', files.includes('sum.js'), files.join(', '));
check('diff 里是把减号改成加号', /^\+.*a \+ b/m.test(changes.data.patch) && /^-.*a - b/m.test(changes.data.patch));

const test = await call('POST', `/api/tasks/${id}/test`);
check('触发测试', test.status === 200, test.data?.error);
let t;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  t = (await call('GET', '/api/state')).data.tasks.find((x) => x.id === id).test;
  if (t && t.status !== 'running') break;
}
check('测试通过', t?.status === 'passed', t?.status);

// ---- 主仓库没被动 ----
check('主仓库仍在 main 且没有任何改动', git('branch', '--show-current').trim() === 'main' && git('status', '--porcelain').trim() === '');
check('主仓库里的 sum.js 仍是原样', git('show', 'HEAD:sum.js').includes('a - b') && !execFileSync('node', ['-e', "process.stdout.write(require('fs').readFileSync('sum.js','utf8'))"], { cwd: repo, encoding: 'utf8' }).includes('a + b'));

// ---- 提交 ----
const commit = await call('POST', `/api/tasks/${id}/commit`, { message: 'fix: 修复 add 函数返回错误结果' });
check('提交', commit.status === 200 && commit.data.status === 'committed', commit.data?.error);
const branch = created.data.branch;
check('任务分支上有这次提交', git('log', '-1', '--format=%s', branch).trim().startsWith('fix:'));
check('main 分支没有变化', git('log', '-1', '--format=%s', 'main').trim() === 'init');

// ---- 追问（同一会话续接）----
const follow = await call('POST', `/api/tasks/${id}/message`, { text: '只回答：sum.js 里现在 add 函数的返回表达式是什么？不要修改任何文件。' });
check('追问被接受', follow.status === 200, follow.data?.error);
let after;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  after = (await call('GET', '/api/state')).data.tasks.find((x) => x.id === id);
  if (!['queued', 'running'].includes(after.status)) break;
}
const tl = await call('GET', `/api/tasks/${id}/timeline`);
const results = tl.data.items.filter((i) => i.type === 'result');
check('追问跑完，共两轮结果', results.length === 2, `status=${after.status}`);
console.log('  回答：', (results.at(-1)?.text ?? '').split('\n')[0].slice(0, 120));
check('追问没有产生新的改动', git('status', '--porcelain').trim() === '');

// ---- 丢弃 ----
const discard = await call('POST', `/api/tasks/${id}/discard`);
check('丢弃', discard.status === 200 && discard.data.status === 'discarded', discard.data?.error);
check('工作区目录已删除', !existsSync(wt));
check('任务分支已删除', git('branch', '--list', 'devlane/*').trim() === '');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
