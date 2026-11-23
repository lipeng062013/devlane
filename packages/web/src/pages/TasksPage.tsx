import { useEffect, useMemo, useRef, useState } from 'react';
import TaskDetail from '../components/TaskDetail';
import TaskLane from '../components/TaskLane';
import { useApp } from '../ctx';
import type { ReasoningEffort, Task, TaskPriority } from '../types';
import { PRIORITY_LABEL, collectTagOptions, taskMatchesFilters, taskPriority, taskTags } from '../task-filters';
import { KIND_LABEL, STATUS_LABEL, taskRank, timeAgo } from '../util';

type Filter = 'active' | 'all' | 'done';

function groupByProject(
  tasks: Task[],
  projects: { id: string; name: string }[],
): Array<{ id: string; name: string; tasks: Task[] }> {
  const order: string[] = [];
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!map.has(t.projectId)) {
      map.set(t.projectId, []);
      order.push(t.projectId);
    }
    map.get(t.projectId)!.push(t);
  }
  return order.map((id) => ({
    id,
    name: projects.find((p) => p.id === id)?.name ?? id,
    tasks: map.get(id) ?? [],
  }));
}

export default function TasksPage({ selectedId }: { selectedId: string | null }) {
  const { state, openTask, newTask } = useApp();
  const [filter, setFilter] = useState<Filter>('active');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [run, setRun] = useState<{ model: string; effort: ReasoningEffort | '' }>({ model: '', effort: '' });
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const hasExtraFilters = q.trim() || tagFilter !== 'all' || priorityFilter !== 'all' || projectFilter !== 'all';
  const groups = useMemo(() => groupByProject(tasks, state.projects), [tasks, state.projects]);
  const activeCount = state.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;

  return (
    <div className="workbench">
      <aside className="list-pane">
        <div className="pane-head">
          <h1>任务</h1>
          {needYou > 0 && <span className="chip chip-warn">{needYou} 个等你</span>}
          <span className="spacer" />
          <button className="btn btn-primary btn-icon" onClick={() => newTask()} aria-label="新任务" title="新任务">
            +
          </button>
        </div>
        <div className="search-box">
          <input
            ref={searchRef}
            id="task-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索任务"
            aria-label="搜索任务"
          />
          <span className="search-kbd">Ctrl K</span>
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
            <button type="button" className="link" onClick={() => setFiltersOpen((v) => !v)}>
              {filtersOpen ? '收起筛选' : '项目、标签、优先级'}
            </button>
          </div>
          {filtersOpen && (
            <>
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
            </>
          )}
        </div>
        <ul className="task-list">
          {groups.map((group) => (
            <li key={group.id}>
              <div className="list-group">{group.name}</div>
              <ul className="task-list" style={{ overflow: 'visible', flex: 'none', padding: 0 }}>
                {group.tasks.map((t) => {
                  const pri = taskPriority(t);
                  const tags = taskTags(t).slice(0, 2);
                  return (
                    <li key={t.id}>
                      <button
                        className={`task-item ${t.id === selectedId ? 'sel' : ''}`}
                        onClick={() => openTask(t.id)}
                      >
                        <span className={`dot st-${t.status}`} aria-hidden />
                        <span className="task-main">
                          <span className="task-title">{t.title}</span>
                          <span className="task-sub muted small">
                            {KIND_LABEL[t.kind]}
                            {t.jiraKey ? ` · ${t.jiraKey}` : ''}
                          </span>
                          {(pri !== 'none' || tags.length > 0) && (
                            <span className="task-chips">
                              {pri !== 'none' && (
                                <span className={`chip chip-pri chip-pri-${pri}`}>{PRIORITY_LABEL[pri]}</span>
                              )}
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
                          <span className="muted small">{timeAgo(t.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {tasks.length === 0 && (
            <li className="empty">
              {state.tasks.length === 0 ? (
                <>
                  还没有任务。
                  <br />
                  点「+」描述一个缺陷或需求，或者去 Jira 页选一条。
                </>
              ) : hasExtraFilters ? (
                '没有匹配的任务'
              ) : (
                '这个分类下没有任务'
              )}
            </li>
          )}
        </ul>
        <div className="list-foot">
          {activeCount > 0 ? `${activeCount} 个运行或排队 · ` : ''}
          {state.tasks.length} 个任务
        </div>
      </aside>

      <section className="detail-pane">
        {selected ? (
          <TaskDetail key={selected.id} task={selected} onRunChange={setRun} />
        ) : (
          <div className="empty big">选择左边的任务，或新建一个。</div>
        )}
      </section>
      {selected && <TaskLane key={selected.id} task={selected} runModel={run.model} runEffort={run.effort} />}
    </div>
  );
}
