import { useEffect, useMemo, useRef } from 'react';
import type { Lane, LaneAction, LaneEvent } from '../types';
import { EVENT_LABEL, LEGEND, STATE_LABEL, TYPE_LABEL, clock, nodeClass, summarize } from '../meta';

const SPACING = 44;
const PAD = 28;

interface Props {
  lanes: Lane[];
  events: Record<string, LaneEvent[]>;
  selectedLaneId: string | null;
  selectedEventId: string | null;
  onSelect: (laneId: string, eventId: string | null) => void;
  onAct: (laneId: string, action: LaneAction) => void;
}

const QUICK: Partial<Record<Lane['state'], { action: LaneAction; label: string }>> = {
  ready: { action: 'queue', label: '加入队列' },
  paused: { action: 'resume', label: '恢复' },
  reviewing: { action: 'merge', label: '合并' },
};

const TERMINAL = new Set(['merged', 'abandoned']);

export default function Board({ lanes, events, selectedLaneId, selectedEventId, onSelect, onAct }: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  const ordered = useMemo(
    () =>
      [...lanes].sort((a, b) => {
        const ta = TERMINAL.has(a.state) ? 1 : 0;
        const tb = TERMINAL.has(b.state) ? 1 : 0;
        return ta - tb || a.createdAt.localeCompare(b.createdAt);
      }),
    [lanes],
  );

  const maxEvents = Math.max(8, ...lanes.map((l) => events[l.id]?.length ?? 0));
  const trackWidth = PAD * 2 + maxEvents * SPACING;

  // 有新事件时，如果用户本来就停在最右侧，就跟随滚动
  const lastMax = useRef(maxEvents);
  useEffect(() => {
    const el = scroller.current;
    if (el && maxEvents > lastMax.current) {
      const nearEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < SPACING * 6 + 300;
      if (nearEnd) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
    }
    lastMax.current = maxEvents;
  }, [maxEvents]);

  return (
    <section className="board">
      <div className="panel-head">
        <h2>泳道</h2>
        <div className="legend">
          {LEGEND.map((item) => (
            <span className="legend-item" key={item.cls}>
              <i className={`node-dot ${item.cls}`} />
              {item.label}
            </span>
          ))}
        </div>
      </div>

      {ordered.length === 0 ? (
        <div className="empty board-empty">
          还没有泳道。在左侧需求池里，选一个就绪评分达标的需求，点「开泳道」。
        </div>
      ) : (
        <div className="board-scroll" ref={scroller}>
          {ordered.map((lane) => {
            const list = events[lane.id] ?? [];
            const quick = QUICK[lane.state];
            const selected = lane.id === selectedLaneId;
            return (
              <div
                className={`lane-row ${selected ? 'selected' : ''} state-${lane.state}`}
                key={lane.id}
                style={{ minWidth: 280 + trackWidth }}
              >
                <div className="lane-label" onClick={() => onSelect(lane.id, null)}>
                  <div className="lane-label-top">
                    <span className="issue-key">{lane.issueKey}</span>
                    <span className={`chip chip-type-${lane.type}`}>{TYPE_LABEL[lane.type]}</span>
                    <span className={`chip chip-state-${lane.state}`}>{STATE_LABEL[lane.state]}</span>
                  </div>
                  <div className="lane-title" title={lane.title}>
                    {lane.title}
                  </div>
                  <div className="lane-label-bottom">
                    <span className="muted small">
                      {lane.id} · {lane.phase}
                    </span>
                    {quick && (
                      <button
                        className="btn btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAct(lane.id, quick.action);
                        }}
                      >
                        {quick.label}
                      </button>
                    )}
                  </div>
                </div>

                <div className="lane-track" style={{ width: trackWidth }}>
                  {list.length > 1 && (
                    <div className="track-line" style={{ left: PAD, width: (list.length - 1) * SPACING }} />
                  )}
                  {list.map((e, i) => (
                    <button
                      key={e.id}
                      className={`node ${nodeClass(e)} ${e.id === selectedEventId ? 'sel' : ''}`}
                      style={{ left: PAD + i * SPACING }}
                      title={`#${e.seq} ${EVENT_LABEL[e.type]} · ${clock(e.ts)}\n${summarize(e)}`}
                      aria-label={`${EVENT_LABEL[e.type]} ${summarize(e)}`}
                      onClick={() => onSelect(lane.id, e.id)}
                    />
                  ))}
                  {lane.state === 'running' && (
                    <span className="pulse" style={{ left: PAD + list.length * SPACING }} aria-hidden />
                  )}
                  {lane.state === 'blocked' && (
                    <span className="wait-tag" style={{ left: PAD + list.length * SPACING - 10 }}>
                      等待批准
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
