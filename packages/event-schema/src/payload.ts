import type { EventType } from './types';

type FieldKind = 'string' | 'number' | 'boolean' | 'array';
type Spec = Record<string, FieldKind>;

/** 每类事件 payload 的必填字段及类型。 */
const REQUIRED: Record<EventType, Spec> = {
  commit: { sha: 'string', message: 'string', additions: 'number', deletions: 'number' },
  test_pass: { command: 'string', exitCode: 'number', durationMs: 'number' },
  test_fail: { command: 'string', exitCode: 'number', durationMs: 'number', attempt: 'number' },
  artifact: { artifactId: 'string', kind: 'string', title: 'string' },
  gate_open: { gateId: 'string', gateType: 'string' },
  gate_resolved: { gateId: 'string', decision: 'string', resolver: 'string' },
  handoff: { fromActor: 'string', toActor: 'string', briefArtifactId: 'string' },
  brief_ack: { briefArtifactId: 'string', nextStep: 'string' },
  review_pass: { reviewer: 'string' },
  tool_call: { tool: 'string' },
  branch: { name: 'string', baseSha: 'string' },
  merge: { prNumber: 'number', mergeSha: 'string' },
  checkpoint: { sha: 'string', label: 'string' },
  model_switch: { from: 'string', to: 'string', reason: 'string' },
  context_compact: { tokensBefore: 'number', tokensAfter: 'number', summaryArtifactId: 'string' },
  error: { code: 'string', message: 'string', retryable: 'boolean' },
  retry: { attempt: 'number', reason: 'string' },
  cross_ref: { sourceLaneId: 'string', sourceEventId: 'string', artifactId: 'string' },
  jira_sync: { operation: 'string', status: 'string' },
};

function kindOf(value: unknown): FieldKind | 'other' {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'other';
}

/** 返回错误列表，空数组表示通过。 */
export function validatePayload(type: EventType, payload: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const spec = REQUIRED[type];
  for (const [field, expected] of Object.entries(spec)) {
    if (!(field in payload)) {
      errors.push(`${type}: 缺少字段 ${field}`);
      continue;
    }
    const actual = kindOf(payload[field]);
    if (actual !== expected) {
      errors.push(`${type}: 字段 ${field} 应为 ${expected}，实际为 ${actual}`);
    }
  }
  return errors;
}
