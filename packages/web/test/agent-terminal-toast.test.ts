import { describe, expect, it } from 'vitest';
import {
  detectAgentTerminalToasts,
  syncStatusMap,
  taskLabel,
} from '../src/agent-terminal-toast';
import type { Task, TaskStatus } from '../src/types';
import { STATUS_LABEL } from '../src/util';

function task(
  partial: Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>,
): Pick<Task, 'id' | 'title' | 'jiraKey' | 'status'> {
  return {
    jiraKey: partial.jiraKey,
    id: partial.id,
    title: partial.title,
    status: partial.status,
  };
}

describe('detectAgentTerminalToasts', () => {
  it('T1 running → review emits info toast with title', () => {
    const prev = new Map<string, TaskStatus>([['T1', 'running']]);
    const next = [task({ id: 'T1', title: 'Fix login', status: 'review' })];
    const toasts = detectAgentTerminalToasts(prev, next);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      taskId: 'T1',
      status: 'review',
      level: 'info',
    });
    expect(toasts[0]!.text).toContain('Fix login');
    expect(toasts[0]!.text).toContain(STATUS_LABEL.review);
  });

  it('T2 running → needs_you emits info toast', () => {
    const prev = new Map<string, TaskStatus>([['T2', 'running']]);
    const next = [task({ id: 'T2', title: 'Need decision', status: 'needs_you' })];
    const toasts = detectAgentTerminalToasts(prev, next);
    expect(toasts).toEqual([
      expect.objectContaining({
        taskId: 'T2',
        status: 'needs_you',
        level: 'info',
        text: expect.stringContaining('Need decision'),
      }),
    ]);
    expect(toasts[0]!.text).toContain(STATUS_LABEL.needs_you);
  });

  it('T3 running → failed emits error-level toast', () => {
    const prev = new Map<string, TaskStatus>([['T3', 'running']]);
    const next = [task({ id: 'T3', title: 'Boom', status: 'failed' })];
    const toasts = detectAgentTerminalToasts(prev, next);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.level).toBe('error');
    expect(toasts[0]!.status).toBe('failed');
    expect(toasts[0]!.text).toContain('Boom');
    expect(toasts[0]!.text).toContain(STATUS_LABEL.failed);
  });

  it('T4 stacks multiple simultaneous terminal edges', () => {
    const prev = new Map<string, TaskStatus>([
      ['A', 'running'],
      ['B', 'running'],
      ['C', 'running'],
    ]);
    const next = [
      task({ id: 'A', title: 'A', status: 'review' }),
      task({ id: 'B', title: 'B', status: 'needs_you' }),
      task({ id: 'C', title: 'C', status: 'failed' }),
    ];
    const toasts = detectAgentTerminalToasts(prev, next);
    expect(toasts.map((t) => t.taskId)).toEqual(['A', 'B', 'C']);
    expect(toasts.map((t) => t.level)).toEqual(['info', 'info', 'error']);
  });

  it('T5 same-status touch / poll does not re-toast after sync', () => {
    const prev = new Map<string, TaskStatus>([['T5', 'running']]);
    const next = [task({ id: 'T5', title: 'Stable', status: 'review' })];
    const first = detectAgentTerminalToasts(prev, next);
    expect(first).toHaveLength(1);
    syncStatusMap(prev, next);
    const second = detectAgentTerminalToasts(prev, next);
    expect(second).toHaveLength(0);
    // another poll with identical status
    syncStatusMap(prev, next);
    expect(detectAgentTerminalToasts(prev, next)).toHaveLength(0);
  });

  it('T6 first paint of already-terminal does not toast', () => {
    const prev = new Map<string, TaskStatus>();
    const next = [
      task({ id: 'T6', title: 'Old review', status: 'review' }),
      task({ id: 'T6b', title: 'Old fail', status: 'failed' }),
    ];
    expect(detectAgentTerminalToasts(prev, next)).toHaveLength(0);
  });

  it('T7 non-terminal / non-running edges do not toast', () => {
    const prev = new Map<string, TaskStatus>([
      ['Q', 'queued'],
      ['R', 'running'],
      ['S', 'stopped'],
    ]);
    const next = [
      task({ id: 'Q', title: 'Q', status: 'review' }), // queued→review: no
      task({ id: 'R', title: 'R', status: 'stopped' }), // running→stopped: no
      task({ id: 'S', title: 'S', status: 'failed' }), // stopped→failed: no
    ];
    expect(detectAgentTerminalToasts(prev, next)).toHaveLength(0);
  });

  it('T8 label falls back to jiraKey then id', () => {
    expect(taskLabel({ id: 'id1', title: '  ', jiraKey: 'ABC-1' })).toBe('ABC-1');
    expect(taskLabel({ id: 'id2', title: '', jiraKey: undefined })).toBe('id2');
    expect(taskLabel({ id: 'id3', title: 'Named', jiraKey: 'X-1' })).toBe('Named');
  });
});

describe('syncStatusMap', () => {
  it('updates and prunes', () => {
    const map = new Map<string, TaskStatus>([
      ['gone', 'running'],
      ['keep', 'queued'],
    ]);
    syncStatusMap(map, [
      { id: 'keep', status: 'running' },
      { id: 'new', status: 'review' },
    ]);
    expect([...map.entries()].sort()).toEqual([
      ['keep', 'running'],
      ['new', 'review'],
    ]);
  });
});
