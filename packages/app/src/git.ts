import { execFile } from 'node:child_process';
import { existsSync, lstatSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './domain';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** 运行 git。参数始终以数组传入，不经过 shell。 */
export async function git(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 60_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const stderr = (e.stderr ?? '').toString();
    const firstLine = (stderr || e.message).trim().split('\n')[0] ?? '';
    throw new GitError(`git ${args[0]} 失败：${firstLine}`, stderr);
  }
}

export async function gitVersion(): Promise<string | null> {
  try {
    return (await git(process.cwd(), ['--version'])).trim();
  } catch {
    return null;
  }
}

export interface RepoInfo {
  root: string;
  currentBranch: string | null;
  suggestedBase: string;
  branches: string[];
  remotes: string[];
  dirty: boolean;
  dirtyCount: number;
  hasCommits: boolean;
}

/** 去掉两端空白和用户从资源管理器复制路径时带上的引号。 */
export function cleanPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1).trim();
  return p;
}

/** 校验并读取一个本地仓库的信息。路径有问题时抛出带中文说明的 HttpError。 */
export async function inspectRepo(rawPath: string): Promise<RepoInfo> {
  const p = cleanPath(rawPath);
  if (!p) throw new HttpError(400, '请输入项目路径');
  if (!isAbsolute(p)) throw new HttpError(400, '请输入完整的绝对路径，例如 D:\\code\\my-app');

  let info;
  try {
    info = await stat(p);
  } catch {
    throw new HttpError(400, `路径不存在：${p}`);
  }
  if (!info.isDirectory()) throw new HttpError(400, `这不是文件夹：${p}`);

  let root: string;
  try {
    root = resolve((await git(p, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw new HttpError(400, `这个文件夹不是 git 仓库：${p}`);
  }

  const hasCommits = await git(root, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);

  const currentBranch = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
    .then((s) => s.trim() || null)
    .catch(() => null);

  const refs = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']))
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'));
  const locals = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const originHead = await git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
    .then((s) => s.trim().replace(/^origin\//, ''))
    .catch(() => '');
  const candidates = [originHead, 'main', 'master', 'develop', currentBranch ?? ''];
  const suggestedBase = candidates.find((c) => c && locals.includes(c)) ?? currentBranch ?? 'HEAD';

  const remotes = (await git(root, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const porcelain = (await git(root, ['status', '--porcelain'])).split('\n').filter(Boolean);

  return {
    root,
    currentBranch,
    suggestedBase,
    branches: refs,
    remotes,
    dirty: porcelain.length > 0,
    dirtyCount: porcelain.length,
    hasCommits,
  };
}

// ---------- worktree ----------

/** 在 worktreesRoot 之下，创建一个基于 base 的新分支和工作目录，返回基线提交。 */
export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<string> {
  await git(repo, ['check-ref-format', '--branch', branch]);
  const baseSha = (await git(repo, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseSha], { timeoutMs: 180_000 });
  return baseSha;
}

/**
 * 把主仓库的 node_modules 链接进 worktree。只有在它已被 .gitignore 忽略时才链接，
 * 否则 git add -A 可能把整个依赖目录加进提交。返回给用户看的说明（成功时为空）。
 */
export async function linkNodeModules(repo: string, worktreePath: string): Promise<string | null> {
  const source = join(repo, 'node_modules');
  const target = join(worktreePath, 'node_modules');
  if (!existsSync(source)) return '主仓库没有 node_modules，未链接依赖；需要的话请在任务里让 Claude 安装，或先在主仓库安装依赖';
  if (existsSync(target)) return null;
  try {
    symlinkSync(source, target, 'junction');
  } catch (err) {
    return `无法链接 node_modules：${(err as Error).message}`;
  }
  const ignored = await git(worktreePath, ['check-ignore', '-q', 'node_modules'])
    .then(() => true)
    .catch(() => false);
  if (!ignored) {
    unlinkLink(target);
    return 'node_modules 没有被 .gitignore 忽略，为避免它进入提交，已取消链接';
  }
  return null;
}

/** 只移除链接本身，不碰链接指向的真实目录。 */
function unlinkLink(path: string): void {
  try {
    rmdirSync(path);
    return;
  } catch {
    /* 换一种方式 */
  }
  unlinkSync(path);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 判断 child 是否位于 parent 之内（不含 parent 自身）。 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 删除任务的 worktree 和分支。
 * 先摘除 node_modules 链接：git worktree remove 和递归删除有可能顺着链接删掉主仓库的依赖。
 */
export async function removeWorktree(repo: string, worktreePath: string, branch: string, worktreesRoot: string): Promise<void> {
  if (!isInside(worktreesRoot, worktreePath)) {
    throw new GitError(`拒绝删除不在 DevLane 工作区内的目录：${worktreePath}`, '');
  }
  const nm = join(worktreePath, 'node_modules');
  if (isLink(nm)) {
    unlinkLink(nm);
    if (isLink(nm)) throw new GitError('无法摘除 node_modules 链接，已停止清理以保护主仓库的依赖', '');
  }
  await git(repo, ['worktree', 'remove', '--force', worktreePath], { timeoutMs: 120_000 }).catch(() => undefined);
  if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
  if (branch.startsWith('devlane/')) await git(repo, ['branch', '-D', branch]).catch(() => undefined);
}

// ---------- 变更 ----------

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface ChangeSet {
  files: FileChange[];
  patch: string;
  truncated: boolean;
}

const MAX_PATCH_BYTES = 1_500_000;

/** worktree 相对基线提交的全部变更，包含未跟踪的新文件和已经提交的内容。 */
export async function changes(worktreePath: string, baseSha: string): Promise<ChangeSet> {
  // 让新文件也出现在 diff 里（只改 worktree 自己的索引）
  await git(worktreePath, ['add', '-N', '.']).catch(() => undefined);

  const numstat = await git(worktreePath, ['diff', '--no-renames', '--numstat', '-z', baseSha]);
  const nameStatus = await git(worktreePath, ['diff', '--no-renames', '--name-status', '-z', baseSha]);

  const statusByPath = new Map<string, 'A' | 'M' | 'D'>();
  const ns = nameStatus.split('\0').filter((s) => s !== '');
  for (let i = 0; i + 1 < ns.length; i += 2) {
    const code = ns[i]!.charAt(0);
    statusByPath.set(ns[i + 1]!, code === 'A' ? 'A' : code === 'D' ? 'D' : 'M');
  }

  const files: FileChange[] = [];
  for (const rec of numstat.split('\0').filter((s) => s !== '')) {
    const [add, del, ...rest] = rec.split('\t');
    const path = rest.join('\t');
    const binary = add === '-' && del === '-';
    files.push({
      path,
      status: statusByPath.get(path) ?? 'M',
      additions: binary ? null : Number(add),
      deletions: binary ? null : Number(del),
      binary,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  let patch = files.length === 0 ? '' : await git(worktreePath, ['diff', '--no-renames', '--no-color', '--unified=3', baseSha]);
  let truncated = false;
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    patch = patch.slice(0, MAX_PATCH_BYTES);
    truncated = true;
  }
  return { files, patch, truncated };
}

export async function hasUncommitted(worktreePath: string): Promise<boolean> {
  const out = await git(worktreePath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

/** 提交 worktree 内的全部改动，返回新提交的哈希。 */
export async function commitAll(worktreePath: string, message: string): Promise<string> {
  await git(worktreePath, ['add', '-A']);
  const staged = await git(worktreePath, ['diff', '--cached', '--name-only']);
  if (staged.trim() === '') throw new HttpError(409, '没有可提交的改动');
  await git(worktreePath, ['commit', '-m', message], { timeoutMs: 180_000 });
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ['push', '-u', 'origin', branch], { timeoutMs: 180_000 });
}

export async function ghVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['--version'], { windowsHide: true, timeout: 15_000 });
    return stdout.split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** 用 gh 创建 PR，返回 PR 地址。 */
export async function createPullRequest(
  worktreePath: string,
  opts: { base: string; head: string; title: string; body: string },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'create', '--base', opts.base.replace(/^origin\//, ''), '--head', opts.head, '--title', opts.title, '--body', opts.body],
      { cwd: worktreePath, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const url = stdout.trim().split('\n').pop() ?? '';
    return url;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new HttpError(502, `gh 创建 PR 失败：${(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

/** 路径转成当前系统的写法并确保位于某个根之内；用于拼接 worktree 路径。 */
export function safeJoin(root: string, ...parts: string[]): string {
  const full = resolve(root, ...parts);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) {
    throw new HttpError(400, '路径越界');
  }
  return full;
}
