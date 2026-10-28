// 真实验证「被拦截 → 放行 → 续接」：让 Claude 运行一条默认不在允许清单里的命令。
// 会产生少量真实 API 费用。用法：node scripts/e2e-approval.mjs [baseUrl]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
async function waitIdle(id, label) {
  const t0 = Date.now();
  for (;;) {
    const t = (await call('GET', '/api/state')).data.tasks.find((x) => x.id === id);
    if (!['queued', 'running'].includes(t.status)) return t;
    if (Date.now() - t0 > 5 * 60_000) throw new Error(`${label} 超时`);
    await sleep(2000);
  }
}

const repo = mkdtempSync(join(tmpdir(), 'devlane-e2e-ap-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'e2e');
writeFileSync(join(repo, 'README.md'), '# demo\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

const project = await call('POST', '/api/projects', { path: repo, name: 'approval-demo', linkNodeModules: false });
check('添加项目', project.status === 201, project.data?.error);

const COMMAND = 'npm view lodash version';
const created = await call('POST', '/api/tasks', {
  projectId: project.data.id,
  kind: 'feature',
  title: '查询 lodash 最新版本',
  description: `不要修改任何文件。请只做一件事：运行命令 \`${COMMAND}\`，然后把输出的版本号告诉我。`,
});
check('创建任务', created.status === 201, created.data?.error);
const id = created.data.id;

const first = await waitIdle(id, '第一轮');
console.log(`第一轮状态：${first.status}，拦截：${JSON.stringify(first.denials.map((d) => d.command ?? d.detail))}`);
check('命令被拦截，任务进入「待你决定」', first.status === 'needs_you', first.status);
const denial = first.denials.find((d) => d.command?.trim() === COMMAND);
check('拦截记录里有这条命令且允许放行', Boolean(denial?.allowable), JSON.stringify(denial));

if (denial) {
  const allow = await call('POST', `/api/tasks/${id}/allow`, { denialIds: [denial.id], mode: 'exact' });
  check('放行', allow.status === 200, allow.data?.error);
  const second = await waitIdle(id, '放行后');
  console.log(`放行后状态：${second.status}，已批准规则：${JSON.stringify(second.approvedRules)}`);
  check('放行后任务完成并进入待审阅', second.status === 'review', second.status);
  const tl = (await call('GET', `/api/tasks/${id}/timeline`)).data.items;
  const runs = tl.filter((i) => i.type === 'tool' && i.name === 'Bash' && i.summary.includes(COMMAND));
  const lastRun = runs.at(-1);
  const res = tl.find((i) => i.type === 'tool_result' && i.toolUseId === lastRun?.toolUseId);
  check('放行后这条命令真的执行成功', Boolean(res?.ok) && /\d+\.\d+\.\d+/.test(res?.text ?? ''), (res?.text ?? '').slice(0, 60));
  const final = tl.filter((i) => i.type === 'result').at(-1);
  console.log('  最终回答：', (final?.text ?? '').split('\n')[0].slice(0, 100));
  check('主仓库没有任何改动', git('status', '--porcelain').trim() === '');
}

await call('POST', `/api/tasks/${id}/discard`);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;

