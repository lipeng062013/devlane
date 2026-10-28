import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { clock, formatDuration, money } from '../util';
import type { TimelineItem } from '../types';

/** 加载并增量更新一个任务的时间线。version 变化时拉取新条目。 */
export function useTimeline(taskId: string, version: number): TimelineItem[] {
  const [state, setState] = useState<{ id: string; items: TimelineItem[] }>({ id: taskId, items: [] });
  const lastSeq = useRef(0);
  const currentId = useRef(taskId);

  useEffect(() => {
    if (currentId.current !== taskId) {
      currentId.current = taskId;
      lastSeq.current = 0;
      setState({ id: taskId, items: [] });
    }
    let cancelled = false;
    void api
      .timeline(taskId, lastSeq.current)
      .then(({ items: fresh }) => {
        if (cancelled || currentId.current !== taskId) return;
        setState((prev) => {
          const base = prev.id === taskId ? prev.items : [];
          const max = base.length > 0 ? base[base.length - 1]!.seq : 0;
          const add = fresh.filter((f) => f.seq > max);
          if (add.length === 0) return prev.id === taskId ? prev : { id: taskId, items: base };
          lastSeq.current = add[add.length - 1]!.seq;
          return { id: taskId, items: [...base, ...add] };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, version]);

  return state.id === taskId ? state.items : [];
}

const TOOL_ICON: Record<string, string> = {
  Bash: '›_',
  Read: '📄',
  Edit: '✎',
  Write: '✎',
  MultiEdit: '✎',
  Glob: '🔍',
  Grep: '🔍',
};

function Collapsible({ text, lines = 6 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const all = text.split('\n');
  if (all.length <= lines) return <div className="pre">{text}</div>;
  return (
    <div>
      <div className="pre">{open ? text : all.slice(0, lines).join('\n') + '\n…'}</div>
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '收起' : `展开全部（${all.length} 行）`}
      </button>
    </div>
  );
}

export default function Timeline({ items, running }: { items: TimelineItem[]; running: boolean }) {
  const results = useMemo(() => {
    const map = new Map<string, Extract<TimelineItem, { type: 'tool_result' }>>();
    for (const i of items) if (i.type === 'tool_result') map.set(i.toolUseId, i);
    return map;
  }, [items]);
  const [openTools, setOpenTools] = useState<Set<number>>(new Set());

  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div
      className="timeline"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {items.length === 0 && <div className="empty">还没有记录</div>}
      {items.map((item) => {
        switch (item.type) {
          case 'prompt':
            return (
              <div className="tl-prompt" key={item.seq}>
                <div className="tl-label">
                  你 → Claude · 第 {item.run} 轮 <span className="muted">{clock(item.ts)}</span>
                </div>
                <Collapsible text={item.text} lines={5} />
              </div>
            );
          case 'text':
            return (
              <div className="tl-text" key={item.seq}>
                {item.text}
              </div>
            );
          case 'tool': {
            const res = results.get(item.toolUseId);
            const open = openTools.has(item.seq);
            const expandable = Boolean(item.detail) || Boolean(res?.text);
            return (
              <div className={`tl-tool ${res && !res.ok ? 'bad' : ''}`} key={item.seq}>
                <button
                  className="tl-tool-row"
                  disabled={!expandable}
                  onClick={() => {
                    const next = new Set(openTools);
                    if (open) next.delete(item.seq);
                    else next.add(item.seq);
                    setOpenTools(next);
                  }}
                >
                  <span className="tl-icon">{TOOL_ICON[item.name] ?? '⚙'}</span>
                  <span className="tl-name">{item.name}</span>
                  <span className="tl-sum">{item.summary}</span>
                  <span className="tl-state">{res ? (res.ok ? '✓' : '✗') : '…'}</span>
                </button>
                {open && (
                  <div className="tl-tool-body">
                    {item.detail && <div className="pre">{item.detail}</div>}
                    {res?.text && <div className={`pre ${res.ok ? '' : 'pre-bad'}`}>{res.text}</div>}
                  </div>
                )}
              </div>
            );
          }
          case 'tool_result':
            return null;
          case 'denied':
            return (
              <div className="tl-denied" key={item.seq}>
                <b>被拦截</b>：{item.tool} · <span className="mono">{item.summary}</span>
              </div>
            );
          case 'result':
            return (
              <div className={`tl-result ${item.ok ? 'ok' : 'bad'}`} key={item.seq}>
                <div className="tl-label">
                  {item.ok ? '这一轮完成' : '这一轮未完成'} · {money(item.costUsd)} · {item.turns} 轮 · {formatDuration(item.durationMs)}
                </div>
                {item.text && <div className="tl-final">{item.text}</div>}
              </div>
            );
          case 'note':
            return (
              <div className={`tl-note ${item.level === 'error' ? 'bad' : ''}`} key={item.seq}>
                {clock(item.ts)} · {item.text}
              </div>
            );
        }
      })}
      {running && <div className="tl-working">Claude 正在工作…</div>}
    </div>
  );
}
