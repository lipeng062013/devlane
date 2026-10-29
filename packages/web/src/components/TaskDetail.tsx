import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { AgentProvider, Task } from '../types';

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
import TestTab from './TestTab';
import Timeline, { useTimeline } from './Timeline';

type Tab = 'timeline' | 'changes' | 'test' | 'deliver';

export default function TaskDetail({ task }: { task: Task }) {
  const { state, versions, act, notify } = useApp();
  const project = state.projects.find((p) => p.id === task.projectId);
  const version = versions[task.id] ?? 0;
  const items = useTimeline(task.id, version);
  const [tab, setTab] = useState<Tab>('timeline');
  const [text, setText] = useState('');

  const idle = IDLE_STATUSES.includes(task.status);
  const running = task.status === 'running';
  const gone = task.status === 'discarded';

  async function send(): Promise<void> {
    const t = text.trim();
    if (!t) return;
    const r = await act(() => api.message(task.id, t));
    if (r) setText('');
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'timeline', label: '过程' },
    { id: 'changes', label: '变更' },
    { id: 'test', label: task.test ? `测试 · ${{ passed: '通过', failed: '失败', running: '运行中', stopped: '已停止' }[task.test.status]}` : '测试' },
    { id: 'deliver', label: task.prUrl ? '交付 · 已开 PR' : task.commitSha ? '交付 · 已提交' : '交付' },
  ];

  return (
    <div className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h2>{task.title}</h2>
          <span className={`chip chip-kind-${task.kind}`}>{KIND_LABEL[task.kind]}</span>
          <span className={`chip st-chip st-${task.status}`}>{STATUS_LABEL[task.status]}</span>
          {task.jiraKey && <span className="chip chip-source">{task.jiraKey}</span>}
        </div>
        <div className="detail-meta muted small">
          <span>{project?.name ?? task.projectId}</span>
          <span>Agent · {agentLabel(task.agentProvider)}</span>
          <span className="mono" title="任务分支">{task.branch}</span>
          <span>基于 {task.baseBranch}</span>
          <span>{money(task.costUsd)} · {task.turns} 轮 · 共 {task.runCount} 次运行</span>
          <button className="link" onClick={() => void navigator.clipboard.writeText(task.worktreePath).then(() => notify('已复制工作区路径'))} title={task.worktreePath}>
            复制工作区路径
          </button>
        </div>
        {task.lastError && (task.status === 'failed' || task.status === 'stopped') && <div className="detail-error">{task.lastError}</div>}
        {task.notes.map((n) => (
          <div className="detail-note" key={n}>
            {n}
          </div>
        ))}
        <div className="detail-actions">
          {running && (
            <button className="btn btn-sm btn-danger" onClick={() => void act(() => api.stop(task.id))}>
              停止
            </button>
          )}
          {task.status === 'queued' && (
            <button className="btn btn-sm" onClick={() => void act(() => api.stop(task.id))}>
              取消排队
            </button>
          )}
          {(task.status === 'stopped' || task.status === 'failed') && (
            <button className="btn btn-sm btn-primary" onClick={() => void act(() => api.message(task.id, '请继续完成任务，并在最后简要汇报当前状态。'))}>
              继续
            </button>
          )}
        </div>
      </header>

      {!gone && <DenialPanel task={task} />}

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === 'timeline' && <Timeline items={items} running={running} />}
        {tab === 'changes' && <ChangesTab task={task} version={version} />}
        {tab === 'test' && <TestTab task={task} project={project} />}
        {tab === 'deliver' && <DeliverTab task={task} />}
      </div>

      {!gone && (
        <footer className="composer">
          <textarea
            rows={2}
            value={text}
            disabled={!idle}
            placeholder={idle ? `追问或给 ${agentLabel(task.agentProvider)} 新指令，例如：再补一个边界测试 / 这里不要改接口 / 解释一下为什么这样改（Ctrl+Enter 发送）` : running ? `${agentLabel(task.agentProvider)} 正在工作，完成后可以追问` : '当前状态不能追问'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn btn-primary" disabled={!idle || !text.trim()} onClick={() => void send()}>
            发送
          </button>
        </footer>
      )}
    </div>
  );
}
