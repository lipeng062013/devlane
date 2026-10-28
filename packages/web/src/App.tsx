import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './api';
import Backlog from './components/Backlog';
import Board from './components/Board';
import GateBanner from './components/GateBanner';
import LaneDrawer from './components/LaneDrawer';
import Login from './components/Login';
import type { LaneAction, NewIssueInput, Snapshot } from './types';

type Phase = 'loading' | 'login' | 'ready';

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.details as { missing?: Array<{ message: string }> } | undefined;
    const missing = details?.missing?.map((m) => m.message).join('；');
    return missing ? `${err.message}：${missing}` : err.message;
  }
  return '无法连接服务器';
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [laneId, setLaneId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.snapshot());
      setPhase('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPhase('login');
      else setNotice(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const source = new EventSource('/api/stream');
    source.onmessage = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 120);
    };
    // 代理可能缓冲 SSE，轮询兜底
    const poll = window.setInterval(() => void refresh(), 10_000);
    return () => {
      source.close();
      window.clearInterval(poll);
      window.clearTimeout(timer.current);
    };
  }, [phase, refresh]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** 执行一次写操作：成功后刷新，失败时提示原因。返回是否成功。 */
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        await refresh();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setPhase('login');
        else setNotice(describeError(err));
        return false;
      }
    },
    [refresh],
  );

  const stats = useMemo(() => {
    const count = (s: string) => snap?.lanes.filter((l) => l.state === s).length ?? 0;
    return [
      { label: '运行中', value: count('running') },
      { label: '排队', value: count('queued') },
      { label: '等待批准', value: count('blocked') },
      { label: '待评审', value: count('reviewing') },
      { label: '已合并', value: count('merged') },
    ];
  }, [snap]);

  if (phase === 'loading') return <div className="center muted">加载中…</div>;
  if (phase === 'login' || !snap) return <Login onDone={() => void refresh()} />;

  const lane = snap.lanes.find((l) => l.id === laneId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">DevLane</div>
        <div className="stats">
          {stats.map((s) => (
            <div className="stat" key={s.label}>
              <b>{s.value}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
        <span className="spacer" />
        <span
          className="badge-sim"
          title={`当前由模拟执行器按脚本产生事件，不会调用模型或修改代码。并发上限 ${snap.config.maxParallel}。`}
        >
          模拟执行器
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            void api.logout().finally(() => {
              setSnap(null);
              setPhase('login');
            });
          }}
        >
          退出
        </button>
      </header>

      {notice && (
        <div className="notice" role="alert" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <GateBanner
        gates={snap.gates}
        lanes={snap.lanes}
        onResolve={(id, decision) => void run(() => api.resolveGate(id, decision))}
        onOpenLane={(id) => {
          setLaneId(id);
          setEventId(null);
        }}
      />

      <main className={`layout ${lane ? 'with-drawer' : ''}`}>
        <Backlog
          issues={snap.issues}
          jiraConfigured={snap.config.jiraConfigured}
          onOpenLane={(issueId) =>
            void run(async () => {
              const created = await api.createLane(issueId);
              setLaneId(created.id);
              setEventId(null);
            })
          }
          onCreateIssue={(input: NewIssueInput) => run(() => api.createIssue(input))}
          onImportJira={() =>
            void run(async () => {
              const r = await api.importJira();
              setNotice(`已从 Jira 取回 ${r.fetched} 条，新增 ${r.created}，更新 ${r.updated}`);
            })
          }
          onSelectLane={(id) => {
            setLaneId(id);
            setEventId(null);
          }}
        />

        <Board
          lanes={snap.lanes}
          events={snap.events}
          selectedLaneId={laneId}
          selectedEventId={eventId}
          onSelect={(l, e) => {
            setLaneId(l);
            setEventId(e);
          }}
          onAct={(id, action: LaneAction) => void run(() => api.act(id, action))}
        />

        {lane && (
          <LaneDrawer
            lane={lane}
            events={snap.events[lane.id] ?? []}
            gates={snap.gates}
            selectedEventId={eventId}
            onSelectEvent={setEventId}
            onAct={(id, action) => void run(() => api.act(id, action))}
            onResolve={(id, decision) => void run(() => api.resolveGate(id, decision))}
            onClose={() => {
              setLaneId(null);
              setEventId(null);
            }}
          />
        )}
      </main>
    </div>
  );
}
