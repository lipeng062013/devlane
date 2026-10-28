// 构建：服务端打成 dist/server.mjs，前端打成 dist/web。
// 用法：node scripts/build.mjs [--server-only]
import { build as esbuild } from 'esbuild';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const serverOnly = process.argv.includes('--server-only');

if (!serverOnly) rmSync(resolve(root, 'dist'), { recursive: true, force: true });

await esbuild({
  entryPoints: [resolve(root, 'packages/server/src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: resolve(root, 'dist/server.mjs'),
  // sql.js 要在运行时按相对路径读取 wasm 文件，不能打进包里
  external: ['sql.js'],
  // 让被打包的 CommonJS 依赖里的 require 在 ESM 输出中可用
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  sourcemap: true,
  logLevel: 'info',
});

if (!serverOnly) {
  const { build: viteBuild } = await import('vite');
  await viteBuild({
    root: resolve(root, 'packages/web'),
    configFile: resolve(root, 'packages/web/vite.config.ts'),
    logLevel: 'info',
  });
}
