import type { Project } from './domain';

/**
 * 永远禁止的命令前缀。即使用户点「允许」也不能放行：
 * 提交、推送、改历史由用户在界面里完成，删除类命令风险过大。
 */
const DENY_PREFIXES = [
  'git push',
  'git commit',
  'git reset',
  'git checkout',
  'git switch',
  'git restore',
  'git clean',
  'git rebase',
  'git merge',
  'git stash',
  'git config',
  'git remote',
  'git worktree',
  'git branch',
  'git tag',
  'git cherry-pick',
  'git revert',
  'git am',
  'git apply',
  'gh',
  'rm',
  'rmdir',
  'del',
  'rd',
  'sudo',
  'su',
  'chmod',
  'chown',
  'format',
  'shutdown',
  'reg',
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'sh',
  'eval',
  'ssh',
  'scp',
  'curl',
  'wget',
];

/** 即使不在禁止清单里，这些程序也不提供「允许同类」的前缀放行（范围太宽）。 */
const NO_PREFIX = new Set(['node', 'python', 'python3', 'py', 'npx', 'deno', 'bun', 'ruby', 'perl', 'php']);

/** 允许的命令文本：只含字母数字和常见路径、参数字符。排除 & | ; < > ( ) $ ` " ' 换行。 */
const SAFE_COMMAND = /^[\w@%+=,./\\: *\-]+$/;

export function isSafeCommandText(cmd: string): boolean {
  const text = cmd.trim();
  return text.length > 0 && text.length <= 200 && SAFE_COMMAND.test(text) && !text.includes('%');
}

/** 命令是否以任一禁止前缀开头（按单词边界）。 */
export function isForbiddenCommand(cmd: string): boolean {
  const normalized = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  return DENY_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p} `));
}

export type ApproveMode = 'exact' | 'prefix';

/** 把一条被拒绝的命令转成 Bash 允许规则。不能放行时返回 null。 */
export function ruleFromCommand(cmd: string, mode: ApproveMode): string | null {
  const text = cmd.trim().replace(/\s+/g, ' ');
  if (!isSafeCommandText(text) || isForbiddenCommand(text)) return null;
  if (mode === 'exact') return `Bash(${text})`;

  const tokens = text.split(' ');
  const first = tokens[0]!.toLowerCase();
  if (NO_PREFIX.has(first)) return null;
  const second = tokens[1];
  const prefix = second && !second.startsWith('-') ? `${tokens[0]} ${second}` : tokens[0]!;
  if (isForbiddenCommand(prefix)) return null;
  return `Bash(${prefix}:*)`;
}

const READ_ONLY_GIT = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'];

export interface ClaudeSettings {
  permissions: { allow: string[]; deny: string[] };
}

/** 生成传给 claude --settings 的权限文件内容。 */
export function buildClaudeSettings(project: Pick<Project, 'testCommand' | 'extraAllowed'>, approvedRules: string[]): ClaudeSettings {
  const allow = new Set<string>(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit']);
  for (const sub of READ_ONLY_GIT) allow.add(`Bash(git ${sub}:*)`);
  allow.add('Bash(ls:*)');
  allow.add('Bash(pwd)');

  const tests = project.testCommand.trim();
  if (isSafeCommandText(tests) && !isForbiddenCommand(tests)) {
    allow.add(`Bash(${tests})`);
    allow.add(`Bash(${tests}:*)`);
  }
  for (const extra of project.extraAllowed) {
    const text = extra.trim();
    if (isSafeCommandText(text) && !isForbiddenCommand(text)) {
      allow.add(`Bash(${text})`);
      allow.add(`Bash(${text}:*)`);
    }
  }
  // 用户批准过的规则；再核一遍，避免状态文件被改动后绕过禁止清单
  for (const rule of approvedRules) {
    const m = /^Bash\((.+?)(:\*)?\)$/.exec(rule);
    if (m && isSafeCommandText(m[1]!) && !isForbiddenCommand(m[1]!)) allow.add(rule);
  }

  const deny = DENY_PREFIXES.map((p) => `Bash(${p}:*)`);
  deny.push('Bash(rm -rf:*)', 'Bash(rm -r:*)');
  return { permissions: { allow: [...allow], deny } };
}
