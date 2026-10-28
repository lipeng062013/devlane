import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { Task } from '../types';
import { IDLE_STATUSES, defaultCommitMessage } from '../util';

export default function DeliverTab({ task }: { task: Task }) {
  const { act, env, notify } = useApp();
  const [message, setMessage] = useState(defaultCommitMessage(task));
  const [prTitle, setPrTitle] = useState(defaultCommitMessage(task));
  const [prBody, setPrBody] = useState(task.jiraKey ? `Jira: ${task.jiraKey}\n\n${task.description}`.trim() : task.description);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMessage(defaultCommitMessage(task));
    setPrTitle(defaultCommitMessage(task));
    // 只在切换任务时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const idle = IDLE_STATUSES.includes(task.status);
  const committed = Boolean(task.commitSha);

  async function openPr(): Promise<void> {
    setBusy(true);
    const r = await act(() => api.openPr(task.id, prTitle, prBody));
    setBusy(false);
    if (r?.prUrl) notify(`PR 已创建：${r.prUrl}`);
  }

  return (
    <div className="deliver">
      <section>
        <h3>1. 提交</h3>
        <p className="muted small">提交到任务分支 <span className="mono">{task.branch}</span>，不会动 {task.baseBranch}。先在「变更」里看过 diff 再提交。</p>
        <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} disabled={!idle} />
        <div className="form-actions">
          {task.commitSha && <span className="muted small">最近一次提交：<span className="mono">{task.commitSha.slice(0, 8)}</span></span>}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={!idle || !message.trim()} onClick={() => void act(() => api.commit(task.id, message))}>
            {committed ? '再提交一次' : '提交'}
          </button>
        </div>
        {!idle && task.status !== 'discarded' && <p className="muted small">Claude 还在工作，等它完成或先停止后再提交。</p>}
      </section>

      <section>
        <h3>2. 推送并创建 PR</h3>
        {task.prUrl ? (
          <p>
            已创建：<a href={task.prUrl} target="_blank" rel="noreferrer noopener">{task.prUrl}</a>
          </p>
        ) : (
          <>
            <p className="muted small">
              执行 <span className="mono">git push -u origin {task.branch}</span> 然后用 <span className="mono">gh pr create</span>。
              {env && !env.gh && <b className="bad-text"> 没有检测到 gh 命令，请先安装 GitHub CLI 并执行 gh auth login。</b>}
            </p>
            <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} disabled={!committed} placeholder="PR 标题" />
            <textarea rows={5} value={prBody} onChange={(e) => setPrBody(e.target.value)} disabled={!committed} placeholder="PR 描述" />
            <div className="form-actions">
              {!committed && <span className="muted small">先完成第 1 步提交</span>}
              <span className="spacer" />
              <button className="btn btn-primary" disabled={!committed || !idle || busy || !prTitle.trim()} onClick={() => void openPr()}>
                {busy ? '正在推送…' : '推送并创建 PR'}
              </button>
            </div>
          </>
        )}
      </section>

      <section>
        <h3>其他</h3>
        <div className="form-actions">
          <button className="btn" onClick={() => void act(() => api.openEditor(task.id))} disabled={task.status === 'discarded'}>
            用编辑器打开工作区
          </button>
          <button
            className="btn btn-danger"
            disabled={task.status === 'discarded'}
            onClick={() => {
              if (window.confirm(`丢弃任务 ${task.id}？\n会删除它的工作区和分支 ${task.branch}，未提交的改动无法找回。已推送的远程分支和 PR 不受影响。`)) {
                void act(() => api.discard(task.id));
              }
            }}
          >
            丢弃这个任务
          </button>
        </div>
        <p className="muted small mono">{task.worktreePath}</p>
      </section>
    </div>
  );
}
