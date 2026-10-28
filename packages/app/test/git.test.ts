import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/domain';
import {
  addWorktree,
  changes,
  cleanPath,
  commitAll,
  git,
  hasUncommitted,
  inspectRepo,
  isInside,
  linkNodeModules,
  removeWorktree,
} from '../src/git';
import { cleanupTemp, makeRepo, sh, tempDir, writeFiles } from './helpers';

afterEach(cleanupTemp);

describe('cleanPath', () => {
  it('去掉空白和引号', () => {
    expect(cleanPath('  "D:\\a b\\c"  ')).toBe('D:\\a b\\c');
    expect(cleanPath("'/x/y'")).toBe('/x/y');
  });
});

describe('inspectRepo', () => {
  it('读取分支、基线、远程与脏状态', async () => {
    const repo = makeRepo();
    sh(repo, 'branch', 'develop');
    writeFiles(repo, { 'dirty.txt': 'x' });
    const info = await inspectRepo(repo);
    expect(info.root.toLowerCase()).toBe(repo.toLowerCase());
    expect(info.currentBranch).toBe('main');
    expect(info.suggestedBase).toBe('main');
    expect(info.branches).toEqual(expect.arrayContaining(['main', 'develop']));
    expect(info.dirty).toBe(true);
    expect(info.dirtyCount).toBe(1);
    expect(info.hasCommits).toBe(true);
    expect(info.remotes).toEqual([]);
  });

  it('接受带引号的路径', async () => {
    const repo = makeRepo();
    const info = await inspectRepo(`"${repo}"`);
    expect(info.currentBranch).toBe('main');
  });

  it('子目录会解析到仓库根', async () => {
    const repo = makeRepo({ 'src/a.js': '1' });
    const info = await inspectRepo(join(repo, 'src'));
    expect(info.root.toLowerCase()).toBe(repo.toLowerCase());
  });

  it.each([
    ['', '请输入项目路径'],
    ['relative/path', '绝对路径'],
  ])('无效输入 %j 给出明确提示', async (input, message) => {
    const err = await inspectRepo(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toContain(message);
  });

  it('路径不存在', async () => {
    const err = await inspectRepo(join(tempDir(), 'nope')).catch((e: unknown) => e);
    expect((err as HttpError).message).toContain('路径不存在');
  });

  it('是文件而不是文件夹', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'x');
    const err = await inspectRepo(join(dir, 'a.txt')).catch((e: unknown) => e);
    expect((err as HttpError).message).toContain('不是文件夹');
  });

  it('不是 git 仓库', async () => {
    const err = await inspectRepo(tempDir()).catch((e: unknown) => e);
    expect((err as HttpError).message).toContain('不是 git 仓库');
  });
});

describe('worktree 与变更', () => {
  async function setup() {
    const repo = makeRepo();
    const root = tempDir('devlane-wt-');
    const wt = join(root, 'T1');
    const baseSha = await addWorktree(repo, wt, 'devlane/fix-sum-ab12', 'main');
    return { repo, root, wt, baseSha };
  }

  it('创建独立的工作目录和分支，主工作目录不受影响', async () => {
    const { repo, wt, baseSha } = await setup();
    expect(existsSync(join(wt, 'sum.js'))).toBe(true);
    expect(baseSha).toBe(sh(repo, 'rev-parse', 'main').trim());
    expect((await git(wt, ['branch', '--show-current'])).trim()).toBe('devlane/fix-sum-ab12');
    expect((await git(repo, ['branch', '--show-current'])).trim()).toBe('main');
    expect(await hasUncommitted(repo)).toBe(false);
  });

  it('拒绝非法分支名', async () => {
    const repo = makeRepo();
    const wt = join(tempDir(), 'T1');
    await expect(addWorktree(repo, wt, 'bad name~^', 'main')).rejects.toThrow();
  });

  it('基线不存在时报错', async () => {
    const repo = makeRepo();
    await expect(addWorktree(repo, join(tempDir(), 'T1'), 'devlane/x', 'no-such-branch')).rejects.toThrow();
  });

  it('变更包含修改、新增（未跟踪）和删除，并统计行数', async () => {
    const { wt, baseSha } = await setup();
    writeFileSync(join(wt, 'sum.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
    writeFiles(wt, { 'new.txt': 'a\nb\nc\n' });
    const result = await changes(wt, baseSha);
    const by = Object.fromEntries(result.files.map((f) => [f.path, f]));
    expect(by['sum.js']).toMatchObject({ status: 'M', additions: 1, deletions: 1 });
    expect(by['new.txt']).toMatchObject({ status: 'A', additions: 3, deletions: 0 });
    expect(result.patch).toContain('+  return a + b;');
    expect(result.patch).toContain('+++ b/new.txt');
    expect(result.truncated).toBe(false);
  });

  it('没有改动时返回空', async () => {
    const { wt, baseSha } = await setup();
    const result = await changes(wt, baseSha);
    expect(result.files).toEqual([]);
    expect(result.patch).toBe('');
  });

  it('提交后变更仍然相对基线可见', async () => {
    const { wt, baseSha } = await setup();
    writeFileSync(join(wt, 'sum.js'), 'export const add = (a, b) => a + b;\n');
    const sha = await commitAll(wt, 'fix: add');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await hasUncommitted(wt)).toBe(false);
    const result = await changes(wt, baseSha);
    expect(result.files.map((f) => f.path)).toEqual(['sum.js']);
  });

  it('没有改动时提交报 409', async () => {
    const { wt } = await setup();
    const err = await commitAll(wt, 'x').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(409);
  });

  it('提交说明里的特殊字符不会被当成命令', async () => {
    const { wt } = await setup();
    writeFiles(wt, { 'a.txt': '1' });
    const msg = 'fix: "quoted" & $(whoami) `x` ; rm -rf /';
    await commitAll(wt, msg);
    expect((await git(wt, ['log', '-1', '--format=%s'])).trim()).toBe(msg);
  });

  it('二进制文件不统计行数', async () => {
    const { wt, baseSha } = await setup();
    writeFileSync(join(wt, 'x.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    const result = await changes(wt, baseSha);
    expect(result.files.find((f) => f.path === 'x.bin')).toMatchObject({ binary: true, additions: null });
  });

  it('中文文件名正常显示', async () => {
    const { wt, baseSha } = await setup();
    writeFiles(wt, { '说明.md': '你好\n' });
    const result = await changes(wt, baseSha);
    expect(result.files.map((f) => f.path)).toContain('说明.md');
  });
});

describe('丢弃任务', () => {
  it('删除 worktree 和分支', async () => {
    const repo = makeRepo();
    const root = tempDir('devlane-wt-');
    const wt = join(root, 'T1');
    await addWorktree(repo, wt, 'devlane/fix-a-1111', 'main');
    writeFiles(wt, { 'x.txt': 'unsaved' });
    await removeWorktree(repo, wt, 'devlane/fix-a-1111', root);
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'devlane/*').trim()).toBe('');
    expect(sh(repo, 'worktree', 'list')).not.toContain('T1');
  });

  it('只删 devlane/ 前缀的分支，不会删用户自己的分支', async () => {
    const repo = makeRepo();
    const root = tempDir('devlane-wt-');
    const wt = join(root, 'T1');
    await addWorktree(repo, wt, 'feature/mine', 'main');
    await removeWorktree(repo, wt, 'feature/mine', root);
    expect(sh(repo, 'branch', '--list', 'feature/mine').trim()).not.toBe('');
  });

  it('拒绝删除工作区之外的目录', async () => {
    const repo = makeRepo();
    const root = tempDir('devlane-wt-');
    await expect(removeWorktree(repo, repo, 'devlane/x', root)).rejects.toThrow('拒绝删除');
    expect(existsSync(join(repo, 'sum.js'))).toBe(true);
  });

  it('链接了 node_modules 时，丢弃不会删掉主仓库的依赖', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    const root = tempDir('devlane-wt-');
    const wt = join(root, 'T1');
    await addWorktree(repo, wt, 'devlane/fix-nm-2222', 'main');

    const note = await linkNodeModules(repo, wt);
    expect(note).toBeNull();
    expect(existsSync(join(wt, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    // 链接不应让依赖目录出现在 git 状态里
    expect(await hasUncommitted(wt)).toBe(false);

    await removeWorktree(repo, wt, 'devlane/fix-nm-2222', root);
    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1;');
  });

  it('node_modules 未被忽略时不链接，并给出说明', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), '');
    sh(repo, 'commit', '-qam', 'no ignore');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'a.js'), '1');
    const root = tempDir('devlane-wt-');
    const wt = join(root, 'T1');
    await addWorktree(repo, wt, 'devlane/fix-nm-3333', 'main');
    const note = await linkNodeModules(repo, wt);
    expect(note).toContain('没有被 .gitignore 忽略');
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
    expect(readFileSync(join(repo, 'node_modules', 'a.js'), 'utf8')).toBe('1');
  });

  it('主仓库没有 node_modules 时给出说明', async () => {
    const repo = makeRepo();
    const root = tempDir('devlane-wt-');
    const wt = join(root, 'T1');
    await addWorktree(repo, wt, 'devlane/fix-nm-4444', 'main');
    expect(await linkNodeModules(repo, wt)).toContain('没有 node_modules');
  });
});

describe('isInside', () => {
  it('判断目录包含关系', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });
});
