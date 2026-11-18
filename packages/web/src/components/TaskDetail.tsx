import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { AgentProvider, ReasoningEffort, Task, TaskPriority } from '../types';
import { EFFORT_LABEL, REASONING_EFFORTS } from '../types';
import { PRIORITY_LABEL, normalizeTagsClient, taskPriority, taskTags } from '../task-filters';

const AGENT_LABEL: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'grok-build': 'Grok Build',
};

function agentLabel(v: unknown): string {
  const p: AgentProvider = v === 'codex' || v === 'grok-build' || v === 'claude' ? v : 'claude';
  return AGENT_LABEL[p];
}
import { IDLE_STATUSES, KIND_LABEL, STATUS_LABEL, money } from '../util';
import ChangesTab from './ChangesTab';
import DeliverTab from './DeliverTab';
import DenialPanel from './DenialPanel';
import TaskTerminal from './TaskTerminal';
import TestTab from './TestTab';
import Timeline, { useTimeline } from './Timeline';

type Tab = 'timeline' | 'terminal' | 'changes' | 'test' | 'deliver';

export default function TaskDetail({
  task,
  onRunChange,
}: {
  task: Task;
  onRunChange?: (run: { model: string; effort: ReasoningEffort | '' }) => void;
}) {
  const { state, versions, act, notify } = useApp();
  const project = state.projects.find((p) => p.id === task.projectId);
  const version = versions[task.id] ?? 0;
  const items = useTimeline(task.id, version);
  const [tab, setTab] = useState<Tab>('timeline');
  const [text, setText] = useState('');
  const [metaTags, setMetaTags] = useState<string[]>(() => taskTags(task));
  const [metaPriority, setMetaPriority] = useState<TaskPriority>(() => taskPriority(task));
  const [tagInput, setTagInput] = useState('');
  const [metaBusy, setMetaBusy] = useState(false);
  const [runModel, setRunModel] = useState(task.model ?? '');
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; isDefault: boolean; label?: string }>>([]);
  const [runEffort, setRunEffort] = useState<ReasoningEffort | ''>(task.effort ?? '');
  const provider = task.agentProvider === 'codex' || task.agentProvider === 'grok-build' ? task.agentProvider : 'claude';
  useEffect(() => {
    setRunModel(task.model ?? '');
    setRunEffort(task.effort ?? '');
  }, [task.id, task.model, task.effort]);
  useEffect(() => {
    onRunChange?.({ model: runModel, effort: runEffort });
  }, [runModel, runEffort, onRunChange]);
  useEffect(() => {
    let cancelled = false;
    void api.models(provider).then((res) => {
      if (!cancelled) setModelOptions(res.models);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [provider]);

  async function saveMeta(): Promise<void> {
    setMetaBusy(true);
    const r = await act(() => api.updateTaskMeta(task.id, { tags: metaTags, priority: metaPriority }));
    setMetaBusy(false);
    if (r) {
      setMetaTags(taskTags(r));
      setMetaPriority(taskPriority(r));
    }
  }


  const idle = IDLE_STATUSES.includes(task.status);
  const running = task.status === 'running' || task.status === 'queued';
  const canSend = idle || running;
  const gone = task.status === 'discarded';
  const archived = task.status === 'archived';

  async function send(): Promise<void> {
    const t = text.trim();
    if (!t) return;
    const r = await act(() => api.message(task.id, t, { model: runModel.trim(), effort: runEffort }));
    if (r) setText('');
  }

  async function archive(): Promise<void> {
    if (!window.confirm(`归档任务「${task.title}」？\n工作区和分支会保留。它会从「进行中」移到「已结束」。`)) return;
    await act(() => api.archiveTask(task.id));
  }

  async function remove(): Promise<void> {
    const extra = task.status === 'discarded' ? '' : `\n会先删除工作区和分支 ${task.branch}，未提交的改动无法找回。`;
    if (!window.confirm(`删除任务「${task.title}」？\n任务记录会从列表里消失。${extra}`)) return;
    const r = await act(() => api.deleteTask(task.id));
    if (r) notify('任务已删除');
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'timeline', label: '对话' },
    { id: 'terminal', label: '终端' },
    { id: 'changes', label: '变更' },
    { id: 'test', label: task.test ? `测试 · ${{ passed: '通过', failed: '失败', running: '运行中', stopped: '已停止' }[task.test.status]}` : '测试' },
    { id: 'deliver', label: task.prUrl ? '交付 · 已开 PR' : task.commitSha ? '交付 · 已提交' : '交付' },
  ];

  return (
    <div className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <span className="chip">{project?.name ?? task.projectId}</span>
          <span className={`chip chip-kind-${task.kind}`}>{KIND_LABEL[task.kind]}</span>
          <span className="chip">{agentLabel(task.agentProvider)}</span>
          <span className={`chip st-chip st-${task.status}`}>{STATUS_LABEL[task.status]}</span>
          {task.jiraKey && <span className="chip chip-source">{task.jiraKey}</span>}
        </div>
        <h2 style={{ marginTop: 8 }}>{task.title}</h2>
        <div className="detail-meta muted small">
          <span className="mono" title="任务分支">{task.branch}</span>
          <span>基于 {task.baseBranch}</span>
          <span>
            {money(task.costUsd)} · {task.turns} 轮
            {task.model ? ` · ${task.model}` : ''}
            {task.effort ? ` · 思考 ${EFFORT_LABEL[task.effort]}` : ''}
            {task.usePoteto ? ' · poteto' : ''}
          </span>
        </div>
        {task.lastError && (task.status === 'failed' || task.status === 'stopped') && <div className="detail-error">{task.lastError}</div>}
        {task.notes.map((n) => (
          <div className="detail-note" key={n}>
            {n}
          </div>
        ))}
      </header>


      {!gone && !archived && (
        <div className="task-meta-editor">
          <label className="muted small">
            本地优先级
            <select value={metaPriority} onChange={(e) => setMetaPriority(e.target.value as TaskPriority)} disabled={metaBusy}>
              <option value="none">{PRIORITY_LABEL.none}</option>
              <option value="high">{PRIORITY_LABEL.high}</option>
              <option value="medium">{PRIORITY_LABEL.medium}</option>
              <option value="low">{PRIORITY_LABEL.low}</option>
            </select>
          </label>
          <label className="muted small">
            本地标签
            <div className="tag-input-row">
              {metaTags.map((t) => (
                <span className="chip chip-tag" key={t}>
                  {t}
                  <button
                    type="button"
                    className="tag-x"
                    aria-label={'移除 ' + t}
                    onClick={() => setMetaTags(metaTags.filter((x) => x !== t))}
                    disabled={metaBusy}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                disabled={metaBusy}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    setMetaTags(normalizeTagsClient([...metaTags, ...tagInput.split(',')]));
                    setTagInput('');
                  }
                }}
                placeholder="逗号/Enter 添加"
              />
            </div>
          </label>
          <button className="btn btn-sm" disabled={metaBusy} onClick={() => void saveMeta()}>
            {metaBusy ? '保存中…' : '保存标签/优先级'}
          </button>
        </div>
      )}

      {!gone && !archived && <DenialPanel task={task} />}

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === 'timeline' && <Timeline items={items} running={running} agentName={agentLabel(task.agentProvider)} />}
        {tab === 'terminal' && <TaskTerminal items={items} running={running} agentName={agentLabel(task.agentProvider)} queued={Boolean(task.pendingPrompt)} />}
        {tab === 'changes' && <ChangesTab task={task} version={version} />}
        {tab === 'test' && <TestTab task={task} project={project} />}
        {tab === 'deliver' && <DeliverTab task={task} />}
      </div>

      {!gone && task.status !== 'archived' && (
        <footer className="composer">
          <div className="composer-run">
            <label className="muted small">
              模型
              <select value={modelOptions.some((m) => m.id === runModel) ? runModel : ''} disabled={!idle || modelOptions.length === 0} onChange={(e) => setRunModel(e.target.value)}>
                {!modelOptions.some((m) => m.id === runModel) && (
                  <option value="">{modelOptions.length === 0 ? '读不到模型列表' : runModel ? `${runModel}（不在本机列表）` : '请选择'}</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {(m.label ?? m.id) + (m.isDefault ? '（本机默认）' : '')}
                  </option>
                ))}
              </select>
            </label>
            <label className="muted small">
              思考强度
              <select value={runEffort} disabled={!idle} onChange={(e) => setRunEffort(e.target.value as ReasoningEffort | '')}>
                <option value="">默认</option>
                {REASONING_EFFORTS.map((level) => (
                  <option key={level} value={level}>
                    {EFFORT_LABEL[level]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            rows={2}
            value={text}
            disabled={!canSend}
            placeholder={canSend ? (running ? `发给 ${agentLabel(task.agentProvider)}。当前这轮结束后在同一会话里继续` : `追问或给 ${agentLabel(task.agentProvider)} 新指令，例如：再补一个边界测试 / 这里不要改接口 / 解释一下为什么这样改（Ctrl+Enter 发送）`) : '当前状态不能发送'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn btn-primary" disabled={!canSend || !text.trim()} onClick={() => void send()} aria-label="发送">
            ↑
          </button>
        </footer>
      )}
    </div>
  );
}
