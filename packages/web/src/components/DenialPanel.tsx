import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { Task } from '../types';

export default function DenialPanel({ task }: { task: Task }) {
  const { act } = useApp();
  const pending = task.denials.filter((d) => d.status === 'pending');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  if (pending.length === 0) return null;

  const chosen = pending.filter((d) => picked.has(d.id));
  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const ids = chosen.map((d) => d.id);

  return (
    <section className="denials" aria-label="被拦截的操作">
      <div className="denials-title">Claude 想做下面这些事，被拦下了。你决定要不要放行：</div>
      {pending.map((d) => (
        <label key={d.id} className="denial-row">
          <input type="checkbox" disabled={!d.allowable} checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
          <span className="denial-tool">{d.tool}</span>
          <span className="mono denial-cmd">{d.command ?? d.detail}</span>
          {!d.allowable && <span className="chip chip-warn">不能放行</span>}
        </label>
      ))}
      <p className="muted small">
        放行只对这个任务有效，之后 Claude 会带着新权限接着做。<b>git 提交/推送、删除类命令、复合命令永远不能放行</b>；
        提交和推送请自己在「交付」里做。
      </p>
      <div className="denials-actions">
        <button className="btn btn-primary btn-sm" disabled={ids.length === 0} onClick={() => void act(() => api.allow(task.id, ids, 'exact'))}>
          只放行选中的这几条并继续
        </button>
        <button className="btn btn-sm" disabled={ids.length === 0} onClick={() => void act(() => api.allow(task.id, ids, 'prefix'))} title="例如放行 npm install lodash 时，同时放行所有 npm install …">
          放行同类命令并继续
        </button>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => void act(() => api.ignore(task.id))}>
          都不放行，直接审阅
        </button>
      </div>
    </section>
  );
}
