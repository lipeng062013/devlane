// 用无头 Chrome/Edge 打开页面，登录后截图，并收集控制台错误。
// 用法：node scripts/ui-check.mjs <baseUrl> <password> <outPng> [waitMs]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, password, out, waitArg] = process.argv.slice(2);
const waitMs = Number(waitArg ?? 3000);
const candidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const exe = candidates.find((p) => existsSync(p));
if (!exe) throw new Error('找不到 Chrome/Edge');

const port = 9333;
const proc = spawn(
  exe,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dl-ui-'))}`,
    '--window-size=1600,900',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* 浏览器尚未就绪 */
    }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push('异常: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      problems.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  // 先看登录页
  await send('Page.navigate', { url: base });
  await sleep(1500);
  const loginShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out.replace(/\.png$/, '-login.png'), Buffer.from(loginShot.result.data, 'base64'));

  // 通过界面登录
  await send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input[type=password]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(password)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  });
  await sleep(200);
  await send('Runtime.evaluate', { expression: `document.querySelector('form button').click()` });
  await sleep(waitMs);

  const state = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      lanes: document.querySelectorAll('.lane-row').length,
      nodes: document.querySelectorAll('.node').length,
      issues: document.querySelectorAll('.issue-card').length,
      gates: document.querySelectorAll('.gate-item').length,
      stats: [...document.querySelectorAll('.stat')].map(e => e.textContent).join('|'),
    })`,
  });
  console.log('页面状态:', state.result.result.value);

  // 点开第一条泳道的最后一个节点，验证详情抽屉
  await send('Runtime.evaluate', {
    expression: `(() => { const rows = document.querySelectorAll('.lane-row'); if (!rows.length) return; const nodes = rows[0].querySelectorAll('.node'); nodes[nodes.length - 1]?.click(); })()`,
  });
  await sleep(600);
  const drawer = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({ drawer: !!document.querySelector('.drawer'), events: document.querySelectorAll('.event-row').length, detail: !!document.querySelector('.event-detail') })`,
  });
  console.log('详情抽屉:', drawer.result.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('截图:', out);
  console.log(problems.length ? '前端问题:\n' + problems.join('\n') : '无控制台错误');
  process.exitCode = problems.length ? 1 : 0;
  ws.close();
} finally {
  proc.kill();
}
