import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cleanups: string[] = [];

export function tempDir(prefix = 'devlane-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** 创建一个带初始提交的临时仓库，默认分支 main。 */
export function makeRepo(files: Record<string, string> = {}): string {
  const root = tempDir('devlane-repo-');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  sh(root, 'config', 'core.autocrlf', 'false');
  writeFiles(root, {
    'sum.js': 'export function add(a, b) {\n  return a - b;\n}\n',
    '.gitignore': 'node_modules/\n',
    ...files,
  });
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  return root;
}
