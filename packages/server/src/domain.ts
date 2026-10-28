import type { Lane } from '@devlane/state-machine';

export type IssueType = 'bug' | 'story' | 'task';

export interface Issue {
  /** 与 key 相同。手动创建为 DL-n，Jira 导入为 Jira 的 issue key。 */
  id: string;
  key: string;
  source: 'demo' | 'manual' | 'jira';
  type: IssueType;
  /** 原始类型名，供就绪评分判断是否缺陷。 */
  typeName: string;
  title: string;
  markdown: string;
  acceptance?: string;
  priority?: string;
  dueDate?: string;
  reporter?: string;
  assignee?: string;
  components: string[];
  url?: string;
  createdAt: string;
}

export interface LaneRecord extends Lane {
  title: string;
  issueKey: string;
  type: IssueType;
  /** 当前所处流水线阶段，策略引擎的缺陷阶段规则会读取它。 */
  phase: string;
  /** 执行器脚本的下一步下标。落盘后进程重启可接着执行。 */
  step: number;
  /** 被人批准放行的步骤下标，该步骤跳过一次策略检查。 */
  approvedStep: number | null;
  prUrl: string | null;
  prNumber: number | null;
  declaredScope: string[];
  blockedGateId: string | null;
  updatedAt: string;
}

export interface GateRecord {
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

/** 携带 HTTP 状态码的业务错误，路由层据此返回响应。 */
export class DomainError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 把 Jira 的类型名归一为三类流水线。 */
export function normalizeIssueType(typeName: string): IssueType {
  if (/^(bug|defect|缺陷|故障)$/i.test(typeName.trim())) return 'bug';
  if (/^(story|epic|feature|需求|故事|新功能)$/i.test(typeName.trim())) return 'story';
  return 'task';
}
