// 生成可部署的压缩包 release/devlane.tgz。
// 包内只有：server.mjs、web 静态文件、sql.js（纯 JS + wasm，无需在服务器上编译）。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败`);
};

run('node', ['scripts/build.mjs']);

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
