import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './api';
import NewTaskDialog from './components/NewTaskDialog';
import { Ctx, type AppCtx, type View } from './ctx';
import JiraPage from './pages/JiraPage';
import ProjectsPage from './pages/ProjectsPage';
import SettingsPage from './pages/SettingsPage';
import TasksPage from './pages/TasksPage';
import type { AppState, EnvInfo, TaskDraft } from './types';

const VIEWS: View[] = ['tasks', 'jira', 'projects', 'settings'];

function parseHash(): { view: View; taskId: string | null } {
  const [, view, id] = window.location.hash.split('/');
  const v = VIEWS.includes(view as View) ? (view as View) : 'tasks';
  return { view: v, taskId: v === 'tasks' && id ? id : null };
}

interface Toast {
  id: number;
  text: string;
  level: 'info' | 'error';
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [route, setRoute] = useState(parseHash);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [offline, setOffline] = useState(false);
  const toastId = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const notify = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, level }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 9000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setOffline(false);
    } catch (e) {
      if (!(e instanceof ApiError)) setOffline(true);
    }
  }, []);

  const refreshEnv = useCallback(async () => {
    try {
      setEnv(await api.env(true));
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.env().then(setEnv).catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 实时推送：任务、时间线、项目、设置变化
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.onmessage = (ev) => {
      let change: { type: string; id: string };
      try {
        change = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (change.id) setVersions((v) => ({ ...v, [change.id]: (v[change.id] ?? 0) + 1 }));
      if (change.type !== 'timeline') {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void refresh(), 120);
      }
    };
    source.onerror = () => undefined;
    // 兜底轮询，防止推送被打断
    const poll = window.setInterval(() => void refresh(), 15_000);
    return () => {
      source.close();
      window.clearInterval(poll);
      window.clearTimeout(timer.current);
    };
  }, [refresh]);

  const go = useCallback((view: View) => {
    window.location.hash = `#/${view}`;
  }, []);

  const openTask = useCallback((id: string) => {
    window.location.hash = `#/tasks/${id}`;
  }, []);

  const act = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        const r = await fn();
        await refresh();
        return r;
      } catch (e) {
        notify(e instanceof Error ? e.message : '操作失败', 'error');
        await refresh();
        return undefined;
      }
    },
    [refresh, notify],
  );

  const ctx = useMemo<AppCtx | null>(
    () =>
      state
        ? { state, env, versions, refresh, refreshEnv, notify, go, openTask, newTask: (d) => setDraft(d ?? {}), act }
        : null,
    [state, env, versions, refresh, refreshEnv, notify, go, openTask, act],
  );

  if (!ctx || !state) {
    return <div className="center muted">{offline ? '连不上 DevLane 服务。它还在运行吗？' : '加载中…'}</div>;
  }

  const needYou = state.tasks.filter((t) => t.status === 'needs_you').length;
  const running = state.tasks.filter((t) => t.status === 'running').length;
  const nav: Array<[View, string, number]> = [
    ['tasks', '任务', needYou],
    ['jira', 'Jira', 0],
    ['projects', '项目', 0],
    ['settings', '设置', 0],
  ];

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <nav className="rail">
          <div className="brand">DevLane</div>
          {nav.map(([id, label, badge]) => (
            <button key={id} className={`rail-item ${route.view === id ? 'on' : ''}`} onClick={() => go(id)}>
              {label}
              {badge > 0 && <span className="badge">{badge}</span>}
            </button>
          ))}
          <span className="spacer" />
          <div className="rail-foot muted small">
            {running > 0 && <div>{running} 个运行中</div>}
            <div>
              {env === null ? '检测中…' : env.claude ? 'Claude 就绪' : <button className="link bad-text" onClick={() => go('settings')}>没找到 claude</button>}
            </div>
          </div>
        </nav>

        <main className="main">
          {offline && <div className="banner-bad">和 DevLane 服务的连接中断了，正在重试…</div>}
          {route.view === 'tasks' && <TasksPage selectedId={route.taskId} />}
          {route.view === 'jira' && <JiraPage />}
          {route.view === 'projects' && (
            <div className="page-scroll">
              <ProjectsPage />
            </div>
          )}
          {route.view === 'settings' && (
            <div className="page-scroll">
              <SettingsPage />
            </div>
          )}
        </main>

        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.level}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              {t.text}
            </div>
          ))}
        </div>

        {draft && (
          <NewTaskDialog
            draft={draft}
            onClose={() => setDraft(null)}
            onCreated={(task) => {
              setDraft(null);
              openTask(task.id);
            }}
          />
        )}
      </div>
    </Ctx.Provider>
  );
}
