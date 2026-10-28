// 用无头 Chrome/Edge 打开页面、按步骤操作并截图，同时收集控制台错误。
// 用法：node scripts/ui-shot.mjs <url> <out.png> [--click=按钮文字]... [--wait=毫秒]... [--theme=dark|light] [--size=宽x高]
// 步骤按出现顺序执行，最后截图。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, ...rest] = process.argv.slice(2);
const opts = rest.map((a) => {
  const m = /^--([a-z]+)=(.*)$/s.exec(a);
  return m ? [m[1], m[2]] : [a, ''];
});
const theme = opts.find(([k]) => k === 'theme')?.[1] ?? 'light';
const [width, height] = (opts.find(([k]) => k === 'size')?.[1] ?? '1500x900').split('x').map(Number);

const candidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const exe = candidates.find((p) => existsSync(p));
if (!exe) throw new Error('找不到 Chrome/Edge');

const port = 9340 + Math.floor(Math.random() * 50);
const proc = spawn(
  exe,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dl-shot-'))}`, `--window-size=${width},${height}`, '--no-first-run', 'about:blank'],
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
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
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
    if (msg.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
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
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await send('Page.navigate', { url });
  await sleep(1500);

  for (const [key, value] of opts) {
    if (key === 'wait') await sleep(Number(value));
    else if (key === 'click') {
      const ok = await evalJs(`(() => {
        const want = ${JSON.stringify(value)};
        const els = [...document.querySelectorAll('button, a, [role=tab]')];
        const el = els.find((e) => e.textContent.trim() === want) ?? els.find((e) => e.textContent.includes(want));
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!ok) problems.push(`找不到可点击的元素：${value}`);
      await sleep(500);
    } else if (key === 'hash') {
      await evalJs(`location.hash = ${JSON.stringify(value)}`);
      await sleep(700);
    } else if (key === 'eval') {
      console.log('eval ->', JSON.stringify(await evalJs(value)));
    }
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('截图：', out);
  console.log(problems.length ? '问题：\n' + problems.join('\n') : '无控制台错误');
  process.exitCode = problems.length ? 1 : 0;
  ws.close();
} finally {
  proc.kill();
}
