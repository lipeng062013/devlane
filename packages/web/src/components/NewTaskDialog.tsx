import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { AgentProvider, ReasoningEffort, Task, TaskDraft, TaskKind, TaskPriority } from '../types';
import { EFFORT_LABEL, REASONING_EFFORTS } from '../types';
import { PRIORITY_LABEL, normalizeTagsClient } from '../task-filters';
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
  const [tags, setTags] = useState<string[]>(normalizeTagsClient(draft.tags));
  const [tagInput, setTagInput] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(draft.priority ?? 'none');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; isDefault: boolean; label?: string }>>([]);
  const [effort, setEffort] = useState<ReasoningEffort | ''>('');
  const [usePoteto, setUsePoteto] = useState(false);
  const [busy, setBusy] = useState(false);

  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    let cancelled = false;
    setModel('');
    setModelOptions([]);
    void api.models(agentProvider).then((res) => {
      if (cancelled) return;
      setModelOptions(res.models);
      const preferred = res.models.find((m) => m.isDefault) ?? res.models[0];
      if (preferred) setModel(preferred.id);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agentProvider]);

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
        tags,
        priority,
        model: model.trim() || undefined,
        effort: effort || undefined,
        usePoteto,
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
        <div className="form-row">
          <label>
            模型（本机列表）
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions.length === 0 && <option value="">这个 Agent 还读不到模型列表</option>}
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {(m.label ?? m.id) + (m.isDefault ? '（本机默认）' : '')}
                </option>
              ))}
            </select>
          </label>
          <label>
            思考强度
            <select value={effort} onChange={(e) => setEffort(e.target.value as ReasoningEffort | '')}>
              <option value="">默认</option>
              {REASONING_EFFORTS.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_LABEL[level]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check-line">
          <input type="checkbox" checked={usePoteto} onChange={(e) => setUsePoteto(e.target.checked)} />
          使用 /pstack:poteto-mode 执行
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

        <div className="form-row">
          <label>
            优先级（本地，不回写 Jira）
            <select id="new-task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              <option value="none">{PRIORITY_LABEL.none}</option>
              <option value="high">{PRIORITY_LABEL.high}</option>
              <option value="medium">{PRIORITY_LABEL.medium}</option>
              <option value="low">{PRIORITY_LABEL.low}</option>
            </select>
          </label>
          <label>
            标签（本地，逗号或 Enter 添加）
            <div className="tag-input-row">
              {tags.map((t) => (
                <span className="chip chip-tag" key={t}>
                  {t}
                  <button type="button" className="tag-x" aria-label={'移除 ' + t} onClick={() => setTags(tags.filter((x) => x !== t))}>
                    ×
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    const next = normalizeTagsClient([...tags, ...tagInput.split(',')]);
                    setTags(next);
                    setTagInput('');
                  }
                }}
                onBlur={() => {
                  if (!tagInput.trim()) return;
                  setTags(normalizeTagsClient([...tags, ...tagInput.split(',')]));
                  setTagInput('');
                }}
                placeholder="例如 frontend"
              />
            </div>
          </label>
        </div>
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
