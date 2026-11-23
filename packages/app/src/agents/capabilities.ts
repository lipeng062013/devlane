import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type CapabilityKind = 'skill' | 'mcp';
export type CapabilityScope = 'project' | 'user' | 'machine';

export interface Capability {
  kind: CapabilityKind;
  name: string;
  scope: CapabilityScope;
  source: string;
}

const SKIP = new Set(['node_modules', '.git', 'dist']);

function skillName(file: string, fallback: string): string {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 2000);
    const match = text.match(/^---\s*\n[\s\S]*?^name:\s*([^\n]+)/m);
    const name = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (name) return name;
  } catch {
    /* 读不到就用目录名 */
  }
  return fallback;
}

function walkSkills(root: string, scope: CapabilityScope, source: string, out: Capability[], depth = 0): void {
  if (!existsSync(root) || depth > 4) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const dir = join(root, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skill = join(dir, 'SKILL.md');
    if (existsSync(skill)) out.push({ kind: 'skill', name: skillName(skill, name), scope, source });
    else walkSkills(dir, scope, source, out, depth + 1);
  }
}

function mcpNamesFromToml(file: string): string[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const names: string[] = [];
  const re = /^\[mcp_servers\.([^\]]+)\]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1]?.trim();
    if (name && !name.includes('.')) names.push(name);
  }
  return names;
}

function mcpNamesFromJson(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

export interface CapabilityRoots {
  projectPath: string;
  home?: string;
}

/** 项目、个人、这台电脑三档。同名同种类时项目覆盖个人，个人覆盖电脑。 */
export function discoverCapabilities(roots: CapabilityRoots): Capability[] {
  const home = roots.home ?? homedir();
  const project = resolve(roots.projectPath);
  const found: Capability[] = [];

  const skillRoots: Array<[string, CapabilityScope, string]> = [
    [join(project, '.grok', 'skills'), 'project', '项目 .grok/skills'],
    [join(project, '.claude', 'skills'), 'project', '项目 .claude/skills'],
    [join(project, '.agents', 'skills'), 'project', '项目 .agents/skills'],
    [join(home, '.grok', 'skills'), 'user', '个人 ~/.grok/skills'],
    [join(home, '.claude', 'skills'), 'user', '个人 ~/.claude/skills'],
    [join(home, '.agents', 'skills'), 'user', '个人 ~/.agents/skills'],
    [join(home, '.codex', 'skills'), 'user', '个人 ~/.codex/skills'],
    [join(home, '.grok', 'bundled', 'skills'), 'machine', '本机 grok 自带'],
    [join(home, '.grok', 'installed-plugins'), 'machine', '本机 grok 插件'],
  ];
  for (const [dir, scope, source] of skillRoots) walkSkills(dir, scope, source, found);

  const mcpFiles: Array<[string, CapabilityScope, string, 'toml' | 'json']> = [
    [join(project, '.grok', 'config.toml'), 'project', '项目 .grok/config.toml', 'toml'],
    [join(project, '.mcp.json'), 'project', '项目 .mcp.json', 'json'],
    [join(project, '.claude', 'settings.json'), 'project', '项目 Claude 设置', 'json'],
    [join(home, '.grok', 'config.toml'), 'user', '个人 ~/.grok/config.toml', 'toml'],
    [join(home, '.claude.json'), 'user', '个人 ~/.claude.json', 'json'],
    [join(home, '.codex', 'config.toml'), 'user', '个人 ~/.codex/config.toml', 'toml'],
  ];
  for (const [file, scope, source, format] of mcpFiles) {
    const names = format === 'toml' ? mcpNamesFromToml(file) : mcpNamesFromJson(file);
    for (const name of names) found.push({ kind: 'mcp', name, scope, source });
  }

  const rank: Record<CapabilityScope, number> = { project: 3, user: 2, machine: 1 };
  const best = new Map<string, Capability>();
  for (const item of found) {
    const key = `${item.kind}:${item.name}`;
    const prev = best.get(key);
    if (!prev || rank[item.scope] > rank[prev.scope]) best.set(key, item);
  }
  return [...best.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** 工作区在 DevLane 管理的目录里时，可以交给 grok --trust。 */
export function workspaceIsManaged(worktree: string, allowedRoots: string[]): boolean {
  const target = resolve(worktree);
  return allowedRoots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}
