import { describe, expect, it } from 'vitest';
import type { Task } from '../src/types';
import {
  collectTagOptions,
  mapJiraPriority,
  normalizeTagsClient,
  taskMatchesFilters,
} from '../src/task-filters';

function task(partial: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    projectId: 'P1',
    kind: 'bug',
    description: '',
    baseBranch: 'main',
    branch: 'b',
    worktreePath: '/tmp',
    status: 'review',
    runCount: 0,
    costUsd: 0,
    turns: 0,
    denials: [],
    notes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...partial,
  };
}

const base = {
  statusSeg: 'all' as const,
  projectId: 'all',
  q: '',
  tag: 'all',
  priority: 'all' as const,
};

describe('taskMatchesFilters', () => {
  it('T1 search title (case-insensitive)', () => {
    const t = task({ id: 'T1', title: 'Fix Login Bug', description: 'x', jiraKey: 'ABC-1' });
    expect(taskMatchesFilters(t, { ...base, q: 'login' })).toBe(true);
    expect(taskMatchesFilters(t, { ...base, q: 'nope' })).toBe(false);
  });

  it('T1 also matches description and jiraKey', () => {
    const t = task({ id: 'T1', title: 'a', description: 'WeirdToken', jiraKey: 'ZZ-9' });
    expect(taskMatchesFilters(t, { ...base, q: 'weird' })).toBe(true);
    expect(taskMatchesFilters(t, { ...base, q: 'zz-9' })).toBe(true);
  });

  it('T2 empty match when filters exclude all', () => {
    const list = [task({ id: 'T1', title: 'alpha', tags: ['a'], priority: 'low' })];
    const filtered = list.filter((t) => taskMatchesFilters(t, { ...base, q: 'zzz' }));
    expect(filtered).toHaveLength(0);
  });

  it('T4 tag + project intersection', () => {
    const a = task({ id: 'T1', title: 'a', projectId: 'P1', tags: ['ui'] });
    const b = task({ id: 'T2', title: 'b', projectId: 'P2', tags: ['ui'] });
    const c = task({ id: 'T3', title: 'c', projectId: 'P1', tags: ['api'] });
    const f = { ...base, projectId: 'P1', tag: 'ui' };
    expect([a, b, c].filter((t) => taskMatchesFilters(t, f)).map((t) => t.id)).toEqual(['T1']);
  });

  it('T5 priority filter', () => {
    const hi = task({ id: 'T1', title: 'h', priority: 'high' });
    const lo = task({ id: 'T2', title: 'l', priority: 'low' });
    expect(taskMatchesFilters(hi, { ...base, priority: 'high' })).toBe(true);
    expect(taskMatchesFilters(lo, { ...base, priority: 'high' })).toBe(false);
    expect(taskMatchesFilters(task({ id: 'T3', title: 'old' }), { ...base, priority: 'none' })).toBe(true);
  });

  it('T6 after meta change filter follows new tags', () => {
    const t = task({ id: 'T1', title: 'm', tags: ['old'] });
    expect(taskMatchesFilters(t, { ...base, tag: 'new' })).toBe(false);
    t.tags = ['new'];
    expect(taskMatchesFilters(t, { ...base, tag: 'new' })).toBe(true);
  });

  it('T7 project + status regression', () => {
    const active = task({ id: 'T1', title: 'a', projectId: 'P1', status: 'review' });
    const done = task({ id: 'T2', title: 'b', projectId: 'P1', status: 'pr_opened' });
    const other = task({ id: 'T3', title: 'c', projectId: 'P2', status: 'review' });
    const f = { ...base, statusSeg: 'active' as const, projectId: 'P1' };
    expect([active, done, other].filter((t) => taskMatchesFilters(t, f)).map((t) => t.id)).toEqual(['T1']);
  });
});

describe('collectTagOptions / normalizeTagsClient / mapJiraPriority', () => {
  it('collects union of tags', () => {
    expect(
      collectTagOptions([
        task({ id: 'T1', title: 'a', tags: ['B', 'a'] }),
        task({ id: 'T2', title: 'b', tags: ['a', 'C'] }),
      ]),
    ).toEqual(['a', 'B', 'C'].sort((x, y) => x.localeCompare(y, 'zh-CN')));
  });

  it('normalizeTagsClient drops overlong and caps', () => {
    expect(normalizeTagsClient(['  ok ', 'ok', 'x'.repeat(33)])).toEqual(['ok']);
  });

  it('T8/AC7 mapJiraPriority', () => {
    expect(mapJiraPriority('High')).toBe('high');
    expect(mapJiraPriority('Medium')).toBe('medium');
    expect(mapJiraPriority('Low')).toBe('low');
    expect(normalizeTagsClient(['L1', 'l1', 'L2'])).toEqual(['L1', 'L2']);
  });
});
