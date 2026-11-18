import { api } from '../api';
import { useApp } from '../ctx';
import type { ReasoningEffort, Task } from '../types';
import { money, STATUS_LABEL } from '../util';

const STEPS = ['排队或开工', 'Agent 工作', '你审阅', '提交', '开 PR'] as const;

function stepIndex(task: Task): number {
  switch (task.status) {
    case 'queued':
      return 0;
    case 'running':
    case 'needs_you':
    case 'stopped':
    case 'failed':
      return 1;
    case 'review':
      return 2;
    case 'committed':
      return 3;
    case 'pr_opened':
      return 4;
    default:
      return 0;
  }
}

export default function TaskLane({
  task,
  runModel,
  runEffort,
}: {
  task: Task;
  runModel: string;
  runEffort: ReasoningEffort | '';
}) {
  const { state, act, notify } = useApp();
  const project = state.projects.find((p) => p.id === task.projectId);
  const pending = task.denials.filter((d) => d.status === 'pending');
  const idx = stepIndex(task);
  const cap = state.settings.maxBudgetUsd;
  const ratio = cap > 0 ? Math.min(100, Math.round((task.costUsd / cap) * 100)) : 0;
  const gone = task.status === 'discarded';
  const running = task.status === 'running';

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

  return (
    <aside className="lane" aria-label="这条任务">
      <div>
        <div className="lane-title">这条任务</div>
        <div className="lane-sub">{project?.name ?? task.projectId} · {STATUS_LABEL[task.status]}</div>
      </div>

      <section className="lane-card">
        <h3>步骤</h3>
        {STEPS.map((label, i) => (
          <div className="lane-step" key={label}>
            <span className={`dot ${i < idx ? 'st-committed' : i === idx ? `st-${task.status}` : ''}`} />
            <span>{label}</span>
          </div>
        ))}
        <div className="lane-meter" aria-hidden>
          <i style={{ width: `${Math.min(100, ((idx + (task.status === 'pr_opened' ? 1 : 0.35)) / STEPS.length) * 100)}%` }} />
        </div>
      </section>

      <section className="lane-card">
        <h3>拦截</h3>
        {pending.length === 0 ? (
          <div className="lane-step">没有待放行的命令</div>
        ) : (
          pending.slice(0, 3).map((d) => (
            <div className="lane-step" key={d.id}>
              <span className="dot st-needs_you" />
              <span className="mono">{d.command ?? d.detail}</span>
            </div>
          ))
        )}
      </section>

      <section className="lane-card">
        <h3>花费</h3>
        <div className="lane-step">
          {money(task.costUsd)}
          {cap > 0 ? ` / 上限 ${money(cap)}` : ' · 不设上限'}
        </div>
        {cap > 0 && (
          <div className="lane-meter" aria-hidden>
            <i style={{ width: `${ratio}%` }} />
          </div>
        )}
        {task.test && <div className="lane-step">测试 · {{ passed: '通过', failed: '失败', running: '运行中', stopped: '已停止' }[task.test.status]}</div>}
      </section>

      <div className="lane-actions">
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
          <button className="btn btn-sm btn-primary" onClick={() => void act(() => api.message(task.id, '请继续完成任务，并在最后简要汇报当前状态。', { model: runModel.trim(), effort: runEffort }))}>
            继续
          </button>
        )}
        {task.status === 'archived' && (
          <button className="btn btn-sm" onClick={() => void act(() => api.unarchiveTask(task.id))}>
            取消归档
          </button>
        )}
        {!gone && task.status !== 'archived' && task.status !== 'running' && task.status !== 'queued' && (
          <button className="btn btn-sm" onClick={() => void archive()}>
            归档
          </button>
        )}
        {task.status !== 'running' && task.status !== 'queued' && (
          <button className="btn btn-sm btn-danger" onClick={() => void remove()}>
            删除
          </button>
        )}
        <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(task.worktreePath).then(() => notify('已复制工作区路径'))}>
          复制路径
        </button>
      </div>
    </aside>
  );
}
