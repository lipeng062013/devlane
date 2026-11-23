import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ListedModel {
  id: string;
  isDefault: boolean;
  label?: string;
}

/** Claude Code 把可选模型写在 ~/.claude/settings.json 的 modelPicker.options。 */
export function readClaudeModels(settingsPath = join(homedir(), '.claude', 'settings.json')): ListedModel[] {
  if (!existsSync(settingsPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return [];
  }
  const root =
    parsed && typeof parsed === 'object' ? (parsed as { model?: unknown; modelPicker?: { options?: unknown } }) : {};
  const current = typeof root.model === 'string' ? root.model : '';
  const options = Array.isArray(root.modelPicker?.options) ? root.modelPicker.options : [];
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  for (const item of options) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { model?: unknown; label?: unknown };
    const id = typeof row.model === 'string' ? row.model.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, isDefault: id === current, label: typeof row.label === 'string' ? row.label : undefined });
  }
  if (current && !seen.has(current)) out.unshift({ id: current, isDefault: true });
  if (!out.some((m) => m.isDefault) && out[0]) out[0].isDefault = true;
  return out;
}

/** Codex 的 magpie 目录是 { models: [{ slug, display_name, visibility }] }。 */
export function readCodexModels(
  configPath = join(homedir(), '.codex', 'config.toml'),
  catalogPath = join(homedir(), '.codex', 'magpie-models.json'),
): ListedModel[] {
  const current = readTomlModel(configPath);
  if (!existsSync(catalogPath)) {
    return current ? [{ id: current, isDefault: true }] : [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    return current ? [{ id: current, isDefault: true }] : [];
  }
  const models = parsed && typeof parsed === 'object' ? (parsed as { models?: unknown }).models : undefined;
  const rows = Array.isArray(models) ? models : [];
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { slug?: unknown; display_name?: unknown; visibility?: unknown };
    if (row.visibility === 'hidden') continue;
    const id = typeof row.slug === 'string' ? row.slug.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      isDefault: id === current,
      label: typeof row.display_name === 'string' ? row.display_name : undefined,
    });
  }
  if (current && !seen.has(current)) out.unshift({ id: current, isDefault: true });
  if (!out.some((m) => m.isDefault) && out[0]) out[0].isDefault = true;
  return out;
}

function readTomlModel(path: string): string {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^model\s*=\s*"([^"]+)"/m);
  return match?.[1]?.trim() ?? '';
}
