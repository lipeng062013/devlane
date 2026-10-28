import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { Gate, Lane, LaneAction, LaneEvent, LaneState } from '../types';
import { EVENT_LABEL, STATE_LABEL, TYPE_LABEL, clock, nodeClass, summarize } from '../meta';

interface Props {
  lane: Lane;
  events: LaneEvent[];
  gates: Gate[];
  selectedEventId: string | null;
  onSelectEvent: (eventId: string | null) => void;
  onAct: (laneId: string, action: LaneAction) => void;
  onResolve: (gateId: string, decision: 'approve' | 'reject') => void;
  onClose: () => void;
}

const ACTIONS: Record<LaneState, Array<{ action: LaneAction; label: string; kind?: 'primary' | 'danger' }>> = {
  draft: [],
  ready: [{ action: 'queue', label: '加入队列', kind: 'primary' }],
  queued: [{ action: 'pause', label: '暂停' }],
  running: [
    { action: 'pause', label: '暂停' },
    { action: 'abandon', label: '放弃', kind: 'danger' },
  ],
  blocked: [{ action: 'abandon', label: '放弃', kind: 'danger' }],
  paused: [
    { action: 'resume', label: '恢复', kind: 'primary' },
    { action: 'abandon', label: '放弃', kind: 'danger' },
  ],
  reviewing: [
    { action: 'merge', label: '合并', kind: 'primary' },
    { action: 'abandon', label: '放弃', kind: 'danger' },
  ],
  merged: [],
  abandoned: [],
};

export default function LaneDrawer(props: Props) {
  const { lane, events, gates, selectedEventId } = props;
  const [verify, setVerify] = useState<string | null>(null);
  const [verifyOk, setVerifyOk] = useState(true);

  useEffect(() => {
    setVerify(null);
  }, [lane.id]);

  const selected = events.find((e) => e.id === selectedEventId) ?? null;
  const openGate = gates.find((g) => g.id === lane.blockedGateId && g.status === 'open');

  async function runVerify(): Promise<void> {
    try {
      const r = await api.verify(lane.id);
      setVerifyOk(r.ok);
      setVerify(r.ok ? `哈希链完整，共 ${r.events} 个事件` : `在第 ${r.brokenAtSeq} 个事件处断裂：${r.reason}`);
    } catch (err) {
      setVerifyOk(false);
      setVerify(err instanceof ApiError ? err.message : '校验失败');
    }
  }

  function act(action: LaneAction): void {
    if (action === 'abandon' && !window.confirm(`确定放弃泳道 ${lane.id}？放弃后不能恢复。`)) return;
    props.onAct(lane.id, action);
  }

  return (
    <aside className="drawer" aria-label="泳道详情">
      <div className="panel-head">
        <h2>
          {lane.issueKey} <span className={`chip chip-state-${lane.state}`}>{STATE_LABEL[lane.state]}</span>
        </h2>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={props.onClose} aria-label="关闭详情">
          关闭
        </button>
      </div>

      <div className="drawer-body">
        <div className="drawer-title">{lane.title}</div>
        <dl className="meta">
          <dt>泳道</dt>
          <dd>
            {lane.id}（{TYPE_LABEL[lane.type]}）
          </dd>
          <dt>阶段</dt>
          <dd>{lane.phase}</dd>
          <dt>分支</dt>
          <dd className="mono">{lane.branch}</dd>
          <dt>工作目录</dt>
          <dd className="mono">{lane.worktreePath}</dd>
          <dt>执行器</dt>
          <dd>{lane.executor === 'simulated' ? '模拟执行器' : (lane.executor ?? '无')}</dd>
          {lane.prUrl && (
            <>
              <dt>PR</dt>
              <dd>模拟 PR #{lane.prNumber}</dd>
            </>
          )}
        </dl>

        {openGate && (
          <div className="drawer-gate">
            <div>
              <strong>等待你批准</strong>：{openGate.reason}
            </div>
            <div className="gate-actions">
              <button className="btn btn-primary btn-sm" onClick={() => props.onResolve(openGate.id, 'approve')}>
                批准
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => props.onResolve(openGate.id, 'reject')}>
                拒绝
              </button>
            </div>
          </div>
        )}

        <div className="drawer-actions">
          {ACTIONS[lane.state].map((a) => (
            <button
              key={a.action}
              className={`btn btn-sm ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : ''}`}
              onClick={() => act(a.action)}
            >
              {a.label}
            </button>
          ))}
          <button className="btn btn-sm" onClick={() => void runVerify()}>
            校验哈希链
          </button>
        </div>
        {verify && <div className={`verify ${verifyOk ? 'ok' : 'bad'}`}>{verify}</div>}

        <h3>事件 · {events.length}</h3>
        <ol className="event-list">
          {events.map((e) => (
            <li key={e.id}>
              <button
                className={`event-row ${e.id === selectedEventId ? 'sel' : ''}`}
                onClick={() => props.onSelectEvent(e.id === selectedEventId ? null : e.id)}
              >
                <i className={`node-dot ${nodeClass(e)}`} />
                <span className="event-seq">#{e.seq}</span>
                <span className="event-type">{EVENT_LABEL[e.type]}</span>
                <span className="event-sum">{summarize(e)}</span>
                <span className="event-time">{clock(e.ts)}</span>
              </button>
            </li>
          ))}
          {events.length === 0 && <li className="empty">暂无事件</li>}
        </ol>

        {selected && (
          <div className="event-detail">
            <div className="event-detail-head">
              事件 #{selected.seq} · {selected.actor.kind}:{selected.actor.id}
              {selected.actor.model ? ` (${selected.actor.model})` : ''}
            </div>
            <pre>{JSON.stringify({ id: selected.id, prevHash: selected.prevHash, payload: selected.payload }, null, 2)}</pre>
          </div>
        )}
      </div>
    </aside>
  );
}
