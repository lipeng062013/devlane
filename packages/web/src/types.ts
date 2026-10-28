import type { LaneEvent } from '@devlane/event-schema';
import type { LaneState } from '@devlane/state-machine';

export type { LaneEvent, LaneState };

export type IssueType = 'bug' | 'story' | 'task';

export interface Readiness {
  score: number;
  ready: boolean;
  missing: Array<{ key: string; weight: number; message: string }>;
}

export interface Issue {
  id: string;
  key: string;
  source: 'demo' | 'manual' | 'jira';
  type: IssueType;
  typeName: string;
  title: string;
  markdown: string;
  priority?: string;
  dueDate?: string;
  reporter?: string;
  assignee?: string;
  components: string[];
  url?: string;
  createdAt: string;
  readiness: Readiness;
  activeLaneId: string | null;
}

export interface Lane {
  id: string;
  issueKey: string;
  title: string;
  type: IssueType;
  state: LaneState;
  phase: string;
  branch: string;
  worktreePath: string;
  executor: string | null;
  prUrl: string | null;
  prNumber: number | null;
  blockedGateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Gate {
  id: string;
  laneId: string;
  gateType: string;
  reason: string;
  status: 'open' | 'resolved' | 'cancelled';
  decision?: 'approve' | 'reject';
  resolver?: string;
  openedAt: string;
  resolvedAt?: string;
}

export interface Snapshot {
  config: { executor: string; maxParallel: number; tickMs: number; jiraConfigured: boolean };
  issues: Issue[];
  lanes: Lane[];
  gates: Gate[];
  events: Record<string, LaneEvent[]>;
}

export type LaneAction = 'queue' | 'resume' | 'pause' | 'abandon' | 'merge';

export interface NewIssueInput {
  title: string;
  type: string;
  priority?: string;
  dueDate?: string;
  reporter?: string;
  assignee?: string;
  components?: string[];
  markdown?: string;
}
