import { useCallback, useEffect, useRef, useState } from 'react';
import { type JiraListResult, api } from '../api';
import { useApp } from '../ctx';
import type { JiraIssueDetail, JiraIssueSummary } from '../types';
import { timeAgo } from '../util';

type Scope = 'mine' | 'reported' | 'recent';

const SCOPES: Array<[Scope, string]> = [
  ['mine', '指派给我（未完成）'],
  ['reported', '我报告的（未完成）'],
  ['recent', '最近 30 天有更新'],
];

const CATEGORY_CLASS: Record<string, string> = { new: 'jira-new', indeterminate: 'jira-doing', done: 'jira-done' };

function isBugType(type: string): boolean {
  return /bug|defect|缺陷|故障/i.test(type);
}

function describeIssue(d: JiraIssueDetail): string {
  const parts = [d.description || '（Jira 上没有填写描述）', '', `——`, `Jira：${d.url}`, `类型：${d.type}　状态：${d.status}${d.priority ? `　优先级：${d.priority}` : ''}`];
  if (d.components.length) parts.push(`模块：${d.components.join('、')}`);
  if (d.comments.length) {
    parts.push('', '最近评论：');
    for (const c of d.comments) parts.push(`- ${c.author}：${c.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return parts.join('\n').slice(0, 15000);
}

export default function JiraPage() {
  const { state, go, newTask, notify } = useApp();
  const configured = Boolean(state.settings.jira);

  const [scope, setScope] = useState<Scope>('mine');
  const [q, setQ] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [jql, setJql] = useState('');
  const [result, setResult] = useState<JiraListResult | null>(null);
  const [issues, setIssues] = useState<JiraIssueSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<JiraIssueDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (more = false) => {
      const my = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const r = await api.jiraIssues({
          scope: advanced ? undefined : scope,
          q: advanced ? undefined : q.trim(),
          jql: advanced ? jql.trim() : undefined,
          pageToken: more ? result?.nextPageToken : undefined,
        });
        if (my !== seq.current) return;
        setResult(r);
        setIssues((prev) => (more ? [...prev, ...r.issues] : r.issues));
      } catch (e) {
        if (my === seq.current) setError((e as Error).message);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [advanced, scope, q, jql, result?.nextPageToken],
  );

  // 进入页面和切换范围时自动加载（搜索词、JQL 要按回车才触发）
  useEffect(() => {
    if (configured) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, scope, advanced]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    api
      .jiraIssue(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setDetailError(e.message));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (!configured) {
    return (
      <div className="page-pad">
        <h1>Jira</h1>
        <div className="callout">
          <p>还没有连接 Jira。填写站点地址、登录邮箱和 API Token 之后，这里会列出指派给你的 issue，可以一键变成任务。</p>
          <button className="btn btn-primary" onClick={() => go('settings')}>
            去设置里连接 Jira
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="split">
      <aside className="list-pane wide">
        <div className="pane-head">
          <h1>Jira</h1>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => void load(false)} disabled={loading}>
            刷新
          </button>
        </div>
        <form
          className="jira-filter"
          onSubmit={(e) => {
            e.preventDefault();
            void load(false);
          }}
        >
          <button type="button" className="link jira-toggle" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '用简单筛选' : '写 JQL'}
          </button>
          {!advanced ? (
            <>
              <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="范围">
                {SCOPES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="编号（ABC-123）或关键字，回车搜索" className="jira-q" />
            </>
          ) : (
            <input value={jql} onChange={(e) => setJql(e.target.value)} placeholder="JQL，例如 project = ABC AND status = 'In Progress'，回车查询" className="mono jira-q" />
          )}
        </form>
        {result && <div className="muted small jira-jql" title="实际使用的 JQL">{result.jql}</div>}
        {error && <div className="notice-inline bad">{error}</div>}
        <ul className="jira-list">
          {issues.map((i) => (
            <li key={i.key}>
              <button className={`jira-item ${i.key === selected ? 'sel' : ''}`} onClick={() => setSelected(i.key)}>
                <span className="jira-top">
                  <span className="mono jira-key">{i.key}</span>
                  <span className={`chip chip-jira-type ${isBugType(i.type) ? 'is-bug' : ''}`}>{i.type}</span>
                  <span className={`chip ${CATEGORY_CLASS[i.statusCategory] ?? ''}`}>{i.status}</span>
                  <span className="spacer" />
                  <span className="muted small">{timeAgo(i.updated)}</span>
                </span>
                <span className="jira-summary">{i.summary}</span>
                <span className="muted small">
                  {i.priority ?? '无优先级'} · {i.assignee ?? '未指派'}
                </span>
              </button>
            </li>
          ))}
          {!loading && !error && issues.length === 0 && <li className="empty">没有符合条件的 issue</li>}
          {loading && <li className="empty">加载中…</li>}
          {result?.nextPageToken && !loading && (
            <li className="more">
              <button className="btn btn-sm" onClick={() => void load(true)}>
                加载更多
              </button>
            </li>
          )}
        </ul>
      </aside>

      <section className="detail-pane">
        {!selected && <div className="empty big">选择左边的 issue 查看详情。</div>}
        {selected && detailError && <div className="empty big bad-text">{detailError}</div>}
        {selected && !detail && !detailError && <div className="empty big">加载中…</div>}
        {detail && (
          <div className="jira-detail">
            <div className="detail-title">
              <h2>
                <span className="mono">{detail.key}</span> {detail.summary}
              </h2>
            </div>
            <div className="detail-meta muted small">
              <span>{detail.type}</span>
              <span>{detail.status}</span>
              <span>{detail.priority ?? '无优先级'}</span>
              <span>经办人：{detail.assignee ?? '未指派'}</span>
              {detail.reporter && <span>报告人：{detail.reporter}</span>}
              {detail.components.length > 0 && <span>模块：{detail.components.join('、')}</span>}
              {detail.labels.length > 0 && <span>标签：{detail.labels.join('、')}</span>}
            </div>
            <div className="detail-actions">
              <button
                className="btn btn-primary"
                onClick={() =>
                  newTask({
                    kind: isBugType(detail.type) ? 'bug' : 'feature',
                    title: detail.summary,
                    description: describeIssue(detail),
                    jiraKey: detail.key,
                  })
                }
              >
                用它创建任务
              </button>
              <a className="btn" href={detail.url} target="_blank" rel="noreferrer noopener" onClick={() => notify('已在新标签页打开 Jira')}>
                在 Jira 打开
              </a>
            </div>
            <h3>描述</h3>
            <div className="pre jira-desc">{detail.description || '（没有描述）'}</div>
            {detail.comments.length > 0 && (
              <>
                <h3>最近评论</h3>
                {detail.comments.map((c, i) => (
                  <div className="jira-comment" key={i}>
                    <div className="muted small">
                      {c.author} · {timeAgo(c.created)}
                    </div>
                    <div className="pre">{c.body}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
