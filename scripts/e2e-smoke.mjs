// 端到端冒烟：对运行中的服务走一遍 登录 → 开泳道 → 执行 → 门禁 → 合并。
// 用法：node scripts/e2e-smoke.mjs <baseUrl> <password>
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const password = process.argv[3] ?? '';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  check(label, false, '超时');
  throw new Error(`等待超时: ${label}`);
}

check('健康检查', (await call('GET', '/api/health')).status === 200);
check('未登录被拒绝', (await call('GET', '/api/snapshot')).status === 401);
check('错误口令被拒绝', (await call('POST', '/api/login', { password: password + 'x' })).status === 401);
check('登录成功', (await call('POST', '/api/login', { password })).status === 200);

const html = await fetch(base + '/');
const text = await html.text();
check('首页返回前端页面', html.status === 200 && text.includes('<div id="root">'));
check('深层路径回落到前端页面', (await fetch(base + '/some/deep/route')).status === 200);

// 新建一个需求，避免与已有数据冲突
const created = await call('POST', '/api/issues', {
  title: `冒烟-${Date.now()}`,
  type: 'Story',
  priority: 'High',
  dueDate: '2026-12-31',
  reporter: 'smoke',
  components: ['smoke'],
  markdown: '## 验收标准\n- 能走完流程',
});
check('创建需求', created.status === 201, created.data?.id);
const lane = await call('POST', `/api/issues/${created.data.id}/lane`);
check('开泳道', lane.status === 201, lane.data?.id);
const laneId = lane.data.id;
check('加入队列', (await call('POST', `/api/lanes/${laneId}/actions`, { action: 'queue' })).status === 200);

const snapshot = async () => (await call('GET', '/api/snapshot')).data;
const find = (s) => s.lanes.find((l) => l.id === laneId);

const blocked = await waitFor(async () => {
  const l = find(await snapshot());
  return l.state === 'blocked' ? l : null;
}, '泳道触发门禁');
check('泳道因高风险文件进入等待批准', blocked.state === 'blocked');

const s1 = await snapshot();
const gate = s1.gates.find((g) => g.laneId === laneId && g.status === 'open');
check('存在待处理门禁', Boolean(gate), gate?.gateType);
check('批准门禁', (await call('POST', `/api/gates/${gate.id}/resolve`, { decision: 'approve' })).status === 200);

await waitFor(async () => find(await snapshot()).state === 'reviewing', '泳道进入评审');
check('泳道进入待评审', true);

const verify = await call('GET', `/api/lanes/${laneId}/verify`);
check('事件哈希链完整', verify.data?.ok === true, `${verify.data?.events} 个事件`);

const merged = await call('POST', `/api/lanes/${laneId}/actions`, { action: 'merge' });
check('合并', merged.data?.state === 'merged');

// SSE：连接后触发一次变更，应收到推送
const ctrl = new AbortController();
const stream = await fetch(base + '/api/stream', { headers: { cookie }, signal: ctrl.signal });
check('SSE 连接成功', stream.status === 200 && String(stream.headers.get('content-type')).includes('text/event-stream'));
const reader = stream.body.getReader();
await call('POST', '/api/issues', { title: 'sse-trigger' });
let received = '';
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !received.includes('data:')) {
  const chunk = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)]);
  if (!chunk || chunk.done) break;
  received += Buffer.from(chunk.value).toString();
}
check('SSE 收到变更推送', received.includes('data:'), received.includes('"kind"') ? '' : JSON.stringify(received));
ctrl.abort();

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
