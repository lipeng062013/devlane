export const EVENT_TYPES = [
  'commit',
  'test_pass',
  'test_fail',
  'artifact',
  'gate_open',
  'gate_resolved',
  'handoff',
  'brief_ack',
  'review_pass',
  'tool_call',
  'branch',
  'merge',
  'checkpoint',
  'model_switch',
  'context_compact',
  'error',
  'retry',
  'cross_ref',
  'jira_sync',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface Actor {
  kind: 'agent' | 'human' | 'system';
  id: string;
  model?: string;
}

export interface LaneEvent {
  id: string;
  laneId: string;
  runId: string | null;
  seq: number;
  parentIds: string[];
  type: EventType;
  actor: Actor;
  ts: string;
  payload: Record<string, unknown>;
  artifactIds: string[];
  prevHash: string;
}

/** 新建事件时调用方提供的字段，seq、prevHash 由追加逻辑填入。 */
export type NewEvent = Omit<LaneEvent, 'seq' | 'prevHash'>;
