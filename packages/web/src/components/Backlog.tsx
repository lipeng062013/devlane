import { useState, type FormEvent } from 'react';
import type { Issue, NewIssueInput } from '../types';
import { TYPE_LABEL } from '../meta';

interface Props {
  issues: Issue[];
  jiraConfigured: boolean;
  onOpenLane: (issueId: string) => void;
  onCreateIssue: (input: NewIssueInput) => Promise<boolean>;
  onImportJira: () => void;
  onSelectLane: (laneId: string) => void;
}

const TEMPLATES: Record<string, string> = {
  Bug: '## 复现步骤\n1. \n2. \n\n## 期望结果\n\n## 实际结果\n\n## 验收标准\n- \n\n## 影响范围\n',
  Story: '## 背景\n\n## 验收标准\n- 假设…，当…，则…\n\n## 影响范围\n',
  Task: '## 验收标准\n- \n\n## 影响范围\n',
};

const SOURCE_LABEL = { demo: '示例', manual: '手动', jira: 'Jira' } as const;

function IssueCard({ issue, onOpenLane, onSelectLane }: { issue: Issue } & Pick<Props, 'onOpenLane' | 'onSelectLane'>) {
  const { readiness } = issue;
  return (
    <li className="issue-card">
      <div className="issue-head">
        <span className="issue-key">{issue.key}</span>
        <span className={`chip chip-type-${issue.type}`}>{TYPE_LABEL[issue.type]}</span>
        <span className="chip chip-source">{SOURCE_LABEL[issue.source]}</span>
      </div>
      <div className="issue-title">{issue.title}</div>
      <div className="ready-row" title={readiness.missing.map((m) => m.message).join('；') || '各项齐全'}>
        <div className="ready-bar">
          <div
            className={`ready-fill ${readiness.ready ? 'ok' : 'low'}`}
            style={{ width: `${Math.max(readiness.score, 3)}%` }}
          />
        </div>
        <span className="ready-score">{readiness.score}</span>
      </div>
      {!readiness.ready && (
        <div className="missing">
          {readiness.missing.slice(0, 3).map((m) => (
            <span className="chip chip-missing" key={m.key}>
              {m.message}
            </span>
          ))}
        </div>
      )}
      <div className="issue-actions">
        {issue.activeLaneId ? (
          <button className="link" onClick={() => onSelectLane(issue.activeLaneId!)}>
            泳道 {issue.activeLaneId}
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            disabled={!readiness.ready}
            title={readiness.ready ? '为该需求创建泳道' : `就绪评分 ${readiness.score}，需达到 70 才能开泳道`}
            onClick={() => onOpenLane(issue.id)}
          >
            开泳道
          </button>
        )}
        {issue.url && (
          <a className="link" href={issue.url} target="_blank" rel="noreferrer noopener">
            在 Jira 打开
          </a>
        )}
      </div>
    </li>
  );
}

function NewIssueForm({ onSubmit, onCancel }: { onSubmit: Props['onCreateIssue']; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('Task');
  const [priority, setPriority] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [reporter, setReporter] = useState('');
  const [components, setComponents] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const ok = await onSubmit({
      title,
      type,
      priority: priority || undefined,
      dueDate: dueDate || undefined,
      reporter: reporter || undefined,
      components: components
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      markdown,
    });
    setBusy(false);
    if (ok) onCancel();
  }

  return (
    <form className="new-issue" onSubmit={(e) => void submit(e)}>
      <label>
        标题
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <div className="form-row">
        <label>
          类型
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option>Bug</option>
            <option>Story</option>
            <option>Task</option>
          </select>
        </label>
        <label>
          优先级
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">未设置</option>
            <option>High</option>
            <option>Medium</option>
            <option>Low</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          截止日期
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <label>
          报告人
          <input value={reporter} onChange={(e) => setReporter(e.target.value)} />
        </label>
      </div>
      <label>
        影响模块（逗号分隔）
        <input value={components} onChange={(e) => setComponents(e.target.value)} placeholder="web/login, api" />
      </label>
      <label>
        描述
        <textarea rows={7} value={markdown} onChange={(e) => setMarkdown(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn btn-sm" onClick={() => setMarkdown(TEMPLATES[type] ?? '')}>
          填入 {type} 模板
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn-sm btn-primary" disabled={busy || title.trim() === ''}>
          创建
        </button>
      </div>
      <p className="muted small">就绪评分满 70 才能开泳道：验收标准、影响范围、优先级、截止时间、负责人，缺陷还需复现步骤。</p>
    </form>
  );
}

export default function Backlog(props: Props) {
  const [creating, setCreating] = useState(false);
  const ready = props.issues.filter((i) => i.readiness.ready && !i.activeLaneId).length;
  return (
    <aside className="backlog">
      <div className="panel-head">
        <h2>需求池</h2>
        <span className="muted small">{ready} 个可开泳道</span>
        <span className="spacer" />
        {props.jiraConfigured && (
          <button className="btn btn-sm" onClick={props.onImportJira}>
            从 Jira 导入
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : '新建'}
        </button>
      </div>
      {creating && <NewIssueForm onSubmit={props.onCreateIssue} onCancel={() => setCreating(false)} />}
      <ul className="issue-list">
        {props.issues.map((issue) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            onOpenLane={props.onOpenLane}
            onSelectLane={props.onSelectLane}
          />
        ))}
        {props.issues.length === 0 && <li className="empty">还没有需求。点「新建」添加，或配置 Jira 后导入。</li>}
      </ul>
    </aside>
  );
}
