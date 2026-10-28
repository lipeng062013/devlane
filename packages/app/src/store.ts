import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, type Project, type Settings, type Task } from './domain';

export interface StateData {
  seq: { project: number; task: number };
  projects: Project[];
  tasks: Task[];
  settings: Settings;
}

function empty(): StateData {
  return { seq: { project: 0, task: 0 }, projects: [], tasks: [], settings: { ...DEFAULT_SETTINGS } };
}

/** 项目、任务、设置的 JSON 文件存储。先写临时文件再改名，避免中途退出损坏数据。 */
export class StateStore {
  readonly data: StateData;

  constructor(private readonly path?: string) {
    this.data = this.load();
  }

  private load(): StateData {
    if (!this.path || !existsSync(this.path)) return empty();
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateData>;
    const base = empty();
    return {
      seq: { ...base.seq, ...parsed.seq },
      projects: parsed.projects ?? [],
      tasks: parsed.tasks ?? [],
      settings: { ...base.settings, ...parsed.settings },
    };
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      // 里面可能有 Jira Token；在 Windows 上这一步没有实际效果，但不会出错
      chmodSync(this.path, 0o600);
    } catch {
      /* 忽略 */
    }
  }

  nextId(kind: keyof StateData['seq']): number {
    this.data.seq[kind] += 1;
    return this.data.seq[kind];
  }
}
