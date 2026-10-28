import { createContext, useContext } from 'react';
import type { AppState, EnvInfo, TaskDraft } from './types';

export type View = 'tasks' | 'jira' | 'projects' | 'settings';

export interface AppCtx {
  state: AppState;
  env: EnvInfo | null;
  /** 每个任务的变更计数，时间线、变更等子视图靠它知道该重新加载。 */
  versions: Record<string, number>;
  refresh: () => Promise<void>;
  refreshEnv: () => Promise<void>;
  notify: (text: string, level?: 'info' | 'error') => void;
  go: (view: View) => void;
  openTask: (id: string) => void;
  newTask: (draft?: TaskDraft) => void;
  /** 执行一个写操作：成功后刷新状态，失败时弹出提示。返回是否成功。 */
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('缺少 AppCtx');
  return v;
}
