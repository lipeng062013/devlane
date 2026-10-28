// 生成可部署的压缩包 release/devlane.tgz。
// 包内只有：server.mjs、web 静态文件、sql.js（纯 JS + wasm，无需在服务器上编译）。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fs.cpSync 在 Windows + Node 22.19 且路径含中文时会使进程崩溃，这里手写复制
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = resolve(src, entry.name);
    const to = resolve(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}
const cpSync = (src, dest, opts) => (opts?.recursive ? copyTree(src, dest) : copyFileSync(src, dest));

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const run = (cmd, args) => {
  // 不经过 shell：在 Windows 上嵌套的 cmd 会让 vite 构建子进程异常退出
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败 (status ${r.status})`);
};

run(process.execPath, ['scripts/build.mjs']);

const stage = resolve(root, 'release/stage');
rmSync(resolve(root, 'release'), { recursive: true, force: true });
mkdirSync(resolve(stage, 'node_modules/sql.js/dist'), { recursive: true });

cpSync(resolve(root, 'dist/server.mjs'), resolve(stage, 'server.mjs'));
cpSync(resolve(root, 'dist/web'), resolve(stage, 'web'), { recursive: true });

const sqlSrc = resolve(root, 'node_modules/sql.js');
cpSync(resolve(sqlSrc, 'package.json'), resolve(stage, 'node_modules/sql.js/package.json'));
for (const f of ['sql-wasm.js', 'sql-wasm.wasm']) {
  cpSync(resolve(sqlSrc, 'dist', f), resolve(stage, 'node_modules/sql.js/dist', f));
}

const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(
  resolve(stage, 'package.json'),
  JSON.stringify({ name: 'devlane-release', private: true, type: 'module', version: rootPkg.version ?? '0.0.0' }, null, 2),
);

run('tar', ['-czf', 'release/devlane.tgz', '-C', 'release/stage', '.']);
console.log('已生成 release/devlane.tgz');
