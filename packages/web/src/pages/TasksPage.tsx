import { useMemo, useState } from 'react';
import TaskDetail from '../components/TaskDetail';
import { useApp } from '../ctx';
import type { TaskPriority } from '../types';
import {
  PRIORITY_LABEL,
  collectTagOptions,
  taskMatchesFilters,
  taskPriority,
  taskTags,
} from '../task-filters';
import { KIND_LABEL, STATUS_LABEL, money, taskRank, timeAgo } from '../util';

type Filter = 'active' | 'all' | 'done';

export default function TasksPage({ selectedId }: { selectedId: string | null }) {
  const { state, openTask, newTask } = useApp();
  const [filter, setFilter] = useState<Filter>('active');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');

  const tagOptions = useMemo(() => collectTagOptions(state.tasks), [state.tasks]);

  const tasks = useMemo(
    () =>
      state.tasks
        .filter((t) =>
          taskMatchesFilters(t, {
            statusSeg: filter,
            projectId: projectFilter,
            q,
            tag: tagFilter,
            priority: priorityFilter,
          }),
        )
        .sort((a, b) => taskRank(a) - taskRank(b) || b.updatedAt.localeCompare(a.updatedAt)),
    [state.tasks, filter, projectFilter, q, tagFilter, priorityFilter],
  );
  const selected = state.tasks.find((t) => t.id === selectedId) ?? null;
  const needYou = state.tasks.filter((t) => t.status === 'needs_you').length;

  const hasExtraFilters = q.trim() || tagFilter !== 'all' || priorityFilter !== 'all';

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="pane-head">
          <h1>任务</h1>
          {needYou > 0 && <span className="chip chip-warn">{needYou} 个等你</span>}
          <span className="spacer" />
          <button className="btn btn-primary btn-sm" onClick={() => newTask()}>
            新任务
          </button>
        </div>
        <div className="seg-filter" role="tablist">
          {(
            [
              ['active', '进行中'],
              ['done', '已结束'],
              ['all', '全部'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="list-filters">
          <div className="project-filter">
            <label className="muted small" htmlFor="task-project-filter">
              项目
            </label>
            <select
              id="task-project-filter"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label="按项目筛选"
            >
              <option value="all">全部项目</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="project-filter">
            <label className="muted small" htmlFor="task-search">
              搜索
            </label>
            <input
              id="task-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="标题 / 描述 / Jira 编号"
              aria-label="搜索任务"
            />
          </div>
          <div className="project-filter">
            <label className="muted small" htmlFor="task-tag-filter">
              标签
            </label>
            <select
              id="task-tag-filter"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              aria-label="按标签筛选"
            >
              <option value="all">全部标签</option>
              {tagOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="project-filter">
            <label className="muted small" htmlFor="task-priority-filter">
              优先级
            </label>
            <select
              id="task-priority-filter"
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as 'all' | TaskPriority)}
              aria-label="按优先级筛选"
            >
              <option value="all">全部优先级</option>
              <option value="high">{PRIORITY_LABEL.high}</option>
              <option value="medium">{PRIORITY_LABEL.medium}</option>
              <option value="low">{PRIORITY_LABEL.low}</option>
              <option value="none">{PRIORITY_LABEL.none}</option>
            </select>
          </div>
        </div>
        <ul className="task-list">
          {tasks.map((t) => {
            const project = state.projects.find((p) => p.id === t.projectId);
            const pri = taskPriority(t);
            const tags = taskTags(t).slice(0, 2);
            return (
              <li key={t.id}>
                <button className={`task-item ${t.id === selectedId ? 'sel' : ''}`} onClick={() => openTask(t.id)}>
                  <span className={`dot st-${t.status}`} aria-hidden />
                  <span className="task-main">
                    <span className="task-title">{t.title}</span>
                    <span className="task-sub muted small">
                      {project?.name ?? t.projectId} · {KIND_LABEL[t.kind]}
                      {t.jiraKey ? ` · ${t.jiraKey}` : ''}
                    </span>
                    {(pri !== 'none' || tags.length > 0) && (
                      <span className="task-chips">
                        {pri !== 'none' && <span className={`chip chip-pri chip-pri-${pri}`}>{PRIORITY_LABEL[pri]}</span>}
                        {tags.map((tag) => (
                          <span className="chip chip-tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="task-side">
                    <span className={`st-text st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    <span className="muted small">
                      {money(t.costUsd)} · {timeAgo(t.updatedAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {tasks.length === 0 && (
            <li className="empty">
              {state.tasks.length === 0 ? (
                <>
                  还没有任务。
                  <br />
                  点「新任务」描述一个缺陷或需求，或者去 Jira 页选一条。
                </>
              ) : hasExtraFilters ? (
                '没有匹配的任务'
              ) : projectFilter !== 'all' ? (
                '该项目下没有任务'
              ) : (
                '这个分类下没有任务'
              )}
            </li>
          )}
        </ul>
      </aside>

      <section className="detail-pane">
        {selected ? <TaskDetail key={selected.id} task={selected} /> : <div className="empty big">选择左边的任务，或新建一个。</div>}
      </section>
    </div>
  );
}
