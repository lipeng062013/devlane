import { describe, expect, it } from 'vitest';
import { looksLikeDevServer } from '../src/util';

describe('looksLikeDevServer', () => {
  it.each([
    'npm run dev',
    'npm run dev -- --port 3001',
    'npm start',
    'pnpm dev',
    'yarn serve',
    'bun run watch',
    'nuxt dev',
    'npx nuxi dev',
    'next dev',
    'vitest --watch',
    'jest --watchAll',
    'cross-env MODE=uat nuxt dev',
  ])('认为 %s 是开发服务器', (cmd) => {
    expect(looksLikeDevServer(cmd), cmd).toBe(true);
  });

  it.each([
    'npm test',
    'npm run test',
    'npm run typecheck',
    'npm run lint',
    'npm run build',
    'vitest run',
    'pytest -q',
    'go test ./...',
    'cargo test',
    'node check.js',
    'npm run test:watch',
    'npx playwright test',
  ])('不误报 %s', (cmd) => {
    expect(looksLikeDevServer(cmd), cmd).toBe(false);
  });
});
