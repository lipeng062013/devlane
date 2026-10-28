import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useApp } from '../ctx';
import type { Project, Task } from '../types';
import { formatDuration, DEV_SERVER_HINT, looksLikeDevServer } from '../util';

const CHIP = { passed: 'chip-ok', failed: 'chip-bad', running: 'chip-run', stopped: 'chip-warn' } as const;

function label(t: NonNullable<Task['test']>): string {
  switch (t.status) {
    case 'passed':
      return '通过';
    case 'failed':
      return `失败${t.exitCode !== null ? `（退出码 ${t.exitCode}）` : ''}`;
    case 'stopped':
      return '已停止';
    default:
      return '运行中…';
  }
}

export default function TestTab({ task, project }: { task: Task; project: Project | undefined }) {
  const { act, go } = useApp();
  const t = task.test;
  const command = project?.testCommand.trim();
  const running = t?.status === 'running';

  // 运行中输出会不断增长，停在底部才看得到最新进度；用户往上翻看时不打扰
  const out = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [t?.output]);

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
          <span className={`chip ${CHIP[t.status]}`}>
            {label(t)}
            {t.durationMs !== null && ` · ${formatDuration(t.durationMs)}`}
          </span>
        )}
        {running ? (
          <button className="btn btn-sm btn-danger" onClick={() => void act(() => api.stopTests(task.id))}>
            停止测试
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={task.status === 'discarded'} onClick={() => void act(() => api.runTests(task.id))}>
            {t ? '重新运行' : '运行测试'}
          </button>
        )}
      </div>
      <p className="muted small">在这个任务的工作区里运行，与 Claude 看到的代码相同。运行中可以随时停止，会连同它启动的子进程一起终止。</p>
      {looksLikeDevServer(command) && <div className="notice-inline warn">{DEV_SERVER_HINT}</div>}
      {t?.output ? (
        <pre
          className="test-output"
          ref={out}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {t.output}
        </pre>
      ) : (
        <div className="empty">{running ? '运行中，等待输出…' : '还没有运行过'}</div>
      )}
    </div>
  );
}
