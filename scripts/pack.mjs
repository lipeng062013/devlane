// 生成可部署的压缩包 release/devlane.tgz：只有 server.mjs 和 web/，不需要 node_modules。
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const run = (cmd, args) => {
  // 不经过 shell：在 Windows 上嵌套的 cmd 会让 vite 构建子进程异常退出
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败 (status ${r.status})`);
};

run(process.execPath, ['scripts/build.mjs']);
mkdirSync(resolve(root, 'release'), { recursive: true });
run('tar', ['-czf', 'release/devlane.tgz', '-C', 'dist', 'server.mjs', 'web']);
console.log('已生成 release/devlane.tgz');
