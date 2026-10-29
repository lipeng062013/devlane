import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { AgentProvider, Task, TaskDraft, TaskKind } from '../types';
import Modal from './Modal';

const LAST_PROJECT = 'devlane.lastProject';

export default function NewTaskDialog({ draft, onClose, onCreated }: { draft: TaskDraft; onClose: () => void; onCreated: (t: Task) => void }) {
  const { state, go, act } = useApp();
  const projects = state.projects;
  const remembered = localStorage.getItem(LAST_PROJECT);
  const [projectId, setProjectId] = useState(projects.find((p) => p.id === remembered)?.id ?? projects[0]?.id ?? '');
  const [kind, setKind] = useState<TaskKind>(draft.kind ?? 'bug');
  const [agentProvider, setAgentProvider] = useState<AgentProvider>('claude');
  const [title, setTitle] = useState(draft.title ?? '');
  const [description, setDescription] = useState(draft.description ?? '');
  const [baseBranch, setBaseBranch] = useState('');
  const [busy, setBusy] = useState(false);

  const project = projects.find((p) => p.id === projectId);

  if (projects.length === 0) {
    return (
      <Modal title="新任务" onClose={onClose}>
        <p>还没有项目。先添加一个本地 git 项目，DevLane 才知道在哪里干活。</p>
        <div className="form-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              onClose();
              go('projects');
            }}
          >
            去添加项目
          </button>
        </div>
      </Modal>
    );
  }

  async function submit(): Promise<void> {
    setBusy(true);
    const task = await act(() =>
      api.createTask({
        projectId,
        kind,
        title,
        description,
        jiraKey: draft.jiraKey,
        baseBranch: baseBranch.trim() || undefined,
        agentProvider,
      }),
    );
    setBusy(false);
    if (task) {
      localStorage.setItem(LAST_PROJECT, projectId);
      onCreated(task);
    }
  }

  return (
    <Modal title={draft.jiraKey ? `新任务 · ${draft.jiraKey}` : '新任务'} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="form-row">
          <label>
            项目
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            类型
            <div className="segmented">
              <button type="button" className={kind === 'bug' ? 'on' : ''} onClick={() => setKind('bug')}>
                缺陷修复
              </button>
              <button type="button" className={kind === 'feature' ? 'on' : ''} onClick={() => setKind('feature')}>
                需求开发
              </button>
            </div>
          </label>
        </div>
        <label>
          Agent
          <div className="segmented">
            <button type="button" className={agentProvider === 'claude' ? 'on' : ''} onClick={() => setAgentProvider('claude')}>
              Claude（默认 Claude）
            </button>
            <button type="button" className={agentProvider === 'codex' ? 'on' : ''} onClick={() => setAgentProvider('codex')}>
              Codex
            </button>
            <button type="button" className={agentProvider === 'grok-build' ? 'on' : ''} onClick={() => setAgentProvider('grok-build')}>
              Grok Build
            </button>
          </div>
        </label>
        <label>
          标题
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="一句话说清楚要解决什么" />
        </label>
        <label>
          描述
          <textarea
            rows={10}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              kind === 'bug'
                ? '怎么复现、期望什么、实际是什么、错误信息或日志。写得越具体，修得越准。'
                : '要做什么、验收标准、涉及的模块或文件、需要遵守的约定。'
            }
          />
        </label>
        <label>
          基线分支（留空用项目默认：{project?.baseBranch}）
          <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder={project?.baseBranch} />
        </label>
        <p className="muted small">
          会在 <span className="mono">~/.devlane/worktrees</span> 里为它建一个独立的工作区和分支，不会动你当前的工作目录。
        </p>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()}>
            {busy ? '正在创建工作区…' : '创建并开始'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
