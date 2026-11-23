import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import NewTaskDialog from './components/NewTaskDialog';
import { Ctx, type AppCtx, type View } from './ctx';
import JiraPage from './pages/JiraPage';
import ProjectsPage from './pages/ProjectsPage';
import SettingsPage from './pages/SettingsPage';
import TasksPage from './pages/TasksPage';
import { detectAgentTerminalToasts, syncStatusMap } from './agent-terminal-toast';
import type { AppState, EnvInfo, TaskDraft, TaskStatus } from './types';

const VIEWS: View[] = ['tasks', 'jira', 'projects', 'settings'];

function RailIcon({ d }: { d: string }) {
  return (
    <svg className="rail-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const iconTask = <RailIcon d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />;
const iconJira = <RailIcon d="M4 7h16M4 12h10M4 17h7" />;
const iconFolder = (
  <RailIcon d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10z" />
);
const iconGear = (
  <RailIcon d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 3.5v2M12 18.5v2M4.9 6.5l1.5 1.5M17.6 16l1.5 1.5M3.5 12h2M18.5 12h2M4.9 17.5l1.5-1.5M17.6 8l1.5-1.5" />
);

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
  /** Prev task status for running→terminal toast edge detection (SSE/poll/first paint). */
  const statusMapRef = useRef<Map<string, TaskStatus>>(new Map());

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
    void api
      .env()
      .then(setEnv)
      .catch(() => undefined);
  }, [refresh]);

  // Agent 终态 toast：仅 running→review/needs_you/failed 边沿；同 status 的 poll/SSE 不重弹
  useEffect(() => {
    if (!state) return;
    const edges = detectAgentTerminalToasts(statusMapRef.current, state.tasks);
    for (const t of edges) notify(t.text, t.level);
    syncStatusMap(statusMapRef.current, state.tasks);
  }, [state, notify]);

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
  const nav: Array<[View, string, ReactNode]> = [
    ['tasks', '任务', iconTask],
    ['jira', 'Jira', iconJira],
    ['projects', '项目', iconFolder],
    ['settings', '设置', iconGear],
  ];

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <nav className="rail" aria-label="主导航">
          <div className="brand-mark" title="DevLane">
            D
          </div>
          {nav.map(([id, label, icon]) => (
            <button
              key={id}
              className={`rail-item ${route.view === id ? 'on' : ''}`}
              onClick={() => go(id)}
              aria-current={route.view === id ? 'page' : undefined}
            >
              {icon}
              <span className="rail-label">{label}</span>
              {id === 'tasks' && needYou > 0 && <span className="badge">{needYou}</span>}
            </button>
          ))}
          <span className="spacer" />
          <div className="rail-foot muted small">
            {running > 0 && <div title={`${running} 个运行中`}>{running}</div>}
            <div>
              {env === null ? (
                '…'
              ) : env.claude ? (
                <span title="Claude 就绪">●</span>
              ) : (
                <button className="link bad-text rail-label" title="没找到 claude" onClick={() => go('settings')}>
                  未找到
                </button>
              )}
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
            <div
              key={t.id}
              className={`toast ${t.level}`}
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
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
