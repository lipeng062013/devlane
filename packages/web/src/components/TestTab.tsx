import { api } from '../api';
import { useApp } from '../ctx';
import type { Project, Task } from '../types';
import { formatDuration } from '../util';

export default function TestTab({ task, project }: { task: Task; project: Project | undefined }) {
  const { act, go } = useApp();
  const t = task.test;
  const command = project?.testCommand.trim();

  if (!command) {
    return (
      <div className="empty">
        这个项目还没有配置测试命令。
        <div>
          <button className="link" onClick={() => go('projects')}>
            去项目页配置
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="test-tab">
      <div className="test-head">
        <span className="mono">{command}</span>
        <span className="spacer" />
        {t && (
          <span className={`chip ${t.status === 'passed' ? 'chip-ok' : t.status === 'failed' ? 'chip-bad' : 'chip-run'}`}>
            {t.status === 'passed' ? '通过' : t.status === 'failed' ? `失败${t.exitCode !== null ? `（退出码 ${t.exitCode}）` : ''}` : '运行中…'}
            {t.durationMs !== null && ` · ${formatDuration(t.durationMs)}`}
          </span>
        )}
        <button className="btn btn-sm btn-primary" disabled={t?.status === 'running' || task.status === 'discarded'} onClick={() => void act(() => api.runTests(task.id))}>
          {t?.status === 'running' ? '运行中…' : '运行测试'}
        </button>
      </div>
      <p className="muted small">在这个任务的工作区里运行，与 Claude 看到的代码相同。</p>
      {t?.output ? <pre className="test-output">{t.output}</pre> : <div className="empty">还没有运行过</div>}
    </div>
  );
}
