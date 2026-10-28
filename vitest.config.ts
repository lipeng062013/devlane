import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // 很多测试要真的调用 git（建仓库、worktree），Windows 上单次约 1 到 2 秒
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
