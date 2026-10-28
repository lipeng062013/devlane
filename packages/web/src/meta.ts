import type { EventType } from '@devlane/event-schema';
import type { LaneEvent, LaneState } from './types';

export const STATE_LABEL: Record<LaneState, string> = {
  draft: '草稿',
  ready: '就绪',
  queued: '排队中',
  running: '运行中',
  blocked: '等待批准',
  paused: '已暂停',
  reviewing: '待评审',
  merged: '已合并',
  abandoned: '已放弃',
};

export const TYPE_LABEL = { bug: '缺陷', story: '需求', task: '任务' } as const;

export const EVENT_LABEL: Record<EventType, string> = {
  commit: '提交',
  test_pass: '测试通过',
  test_fail: '测试失败',
  artifact: '产出物',
  gate_open: '门禁开启',
  gate_resolved: '门禁处理',
  handoff: '交接',
  brief_ack: '简报确认',
  review_pass: '评审通过',
  tool_call: '工具调用',
  branch: '创建分支',
  merge: '合并',
  checkpoint: '检查点',
  model_switch: '切换模型',
  context_compact: '压缩上下文',
  error: '错误',
  retry: '重试',
  cross_ref: '跨泳道引用',
  jira_sync: 'Jira 同步',
};

/** 节点外观分类，对应样式里的 node-* 类。 */
export function nodeClass(e: LaneEvent): string {
  switch (e.type) {
    case 'gate_open':
    case 'gate_resolved':
      return 'node-gate';
    case 'error':
    case 'test_fail':
      return 'node-bad';
    case 'test_pass':
    case 'review_pass':
    case 'merge':
      return 'node-good';
    case 'commit':
      return 'node-commit';
    case 'artifact':
      return 'node-artifact';
    case 'retry':
    case 'model_switch':
      return 'node-warn';
    case 'tool_call':
      return e.payload.decision === 'deny' ? 'node-bad' : 'node-tool';
    default:
      return 'node-plain';
  }
}

export const LEGEND: Array<{ cls: string; label: string }> = [
  { cls: 'node-commit', label: '提交' },
  { cls: 'node-good', label: '通过 / 合并' },
  { cls: 'node-bad', label: '失败 / 被拒' },
  { cls: 'node-warn', label: '重试 / 换模型' },
  { cls: 'node-gate', label: '门禁' },
  { cls: 'node-artifact', label: '产出物' },
  { cls: 'node-tool', label: '工具调用' },
  { cls: 'node-plain', label: '检查点' },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function tail(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

/** 一行摘要，用于节点提示和事件列表。 */
export function summarize(e: LaneEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'commit':
      return `${str(p.sha)} ${str(p.message)}（+${str(p.additions)} -${str(p.deletions)}）`;
    case 'tool_call': {
      const args = (p.args ?? {}) as Record<string, unknown>;
      const target = args.path ? tail(str(args.path)) : str(args.command);
      const verdict = p.decision === 'deny' ? '【被拒绝】' : p.decision === 'approved' ? '【已批准】' : '';
      return `${str(p.tool)} ${target} ${verdict}`.trim();
    }
    case 'test_pass':
      return `${str(p.command)} 通过，${str(p.durationMs)}ms`;
    case 'test_fail':
      return `${str(p.command)} 失败（第 ${str(p.attempt)} 次），${str(p.durationMs)}ms`;
    case 'artifact':
      return str(p.title);
    case 'gate_open':
      return `${str(p.gateId)} ${str(p.reason)}`;
    case 'gate_resolved':
      return `${str(p.gateId)} ${p.decision === 'approve' ? '已批准' : '已拒绝'}，处理人 ${str(p.resolver)}`;
    case 'error':
      return str(p.message);
    case 'retry':
      return str(p.reason);
    case 'checkpoint':
      return `${str(p.label)}（${str(p.sha)}）`;
    case 'model_switch':
      return `${str(p.from)} → ${str(p.to)}：${str(p.reason)}`;
    case 'merge':
      return `PR #${str(p.prNumber)} 已合并（${str(p.mergeSha)}）`;
    case 'review_pass':
      return `${str(p.reviewer)} 评审通过`;
    case 'branch':
      return `${str(p.name)}，基线 ${str(p.baseSha)}`;
    default:
      return '';
  }
}

export function clock(ts: string): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
