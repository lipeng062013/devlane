import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ChangeSet, Task } from '../types';
import { splitPatch } from '../util';

const STATUS_MARK = { A: '新增', M: '修改', D: '删除' } as const;

function DiffLines({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = '';
        if (line.startsWith('@@')) cls = 'hunk';
        else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta';
        else if (line.startsWith('+')) cls = 'add';
        else if (line.startsWith('-')) cls = 'del';
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export default function ChangesTab({ task, version }: { task: Task; version: number }) {
  const [data, setData] = useState<ChangeSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .changes(task.id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        setSelected((cur) => (cur && d.files.some((f) => f.path === cur) ? cur : (d.files[0]?.path ?? null)));
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // 任务状态变化（比如 Claude 完成一轮）时刷新
  }, [task.id, task.updatedAt, version]);

  const perFile = useMemo(() => (data ? splitPatch(data.patch) : new Map<string, string>()), [data]);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">{loading ? '正在读取变更…' : ''}</div>;
  if (data.files.length === 0) return <div className="empty">还没有任何改动。</div>;

  const totalAdd = data.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const totalDel = data.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const current = selected ? perFile.get(selected) : undefined;
  const file = data.files.find((f) => f.path === selected);

  return (
    <div className="changes">
      <div className="changes-files">
        <div className="changes-sum">
          {data.files.length} 个文件 <span className="add">+{totalAdd}</span> <span className="del">-{totalDel}</span>
        </div>
        {data.files.map((f) => (
          <button key={f.path} className={`file-row ${f.path === selected ? 'sel' : ''}`} onClick={() => setSelected(f.path)} title={f.path}>
            <span className={`file-status st-${f.status}`}>{STATUS_MARK[f.status]}</span>
            <span className="file-path">{f.path}</span>
            <span className="file-stat">
              {f.binary ? '二进制' : (
                <>
                  <span className="add">+{f.additions}</span> <span className="del">-{f.deletions}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="changes-diff">
        {data.truncated && <div className="notice-inline">改动太大，只显示了前一部分</div>}
        {file?.binary ? <div className="empty">二进制文件，不显示内容</div> : current ? <DiffLines text={current} /> : <div className="empty">没有可显示的内容</div>}
      </div>
    </div>
  );
}
