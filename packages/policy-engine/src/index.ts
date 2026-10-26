import type { LaneState } from '@devlane/state-machine';

export type Decision = 'allow' | 'deny' | 'gate';

export interface PolicyContext {
  laneId: string;
  laneState: LaneState;
  laneType: 'bug' | 'story' | 'task';
  declaredScope: string[];
  worktreePath: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface PolicyResult {
  decision: Decision;
  reason?: string;
  gateType?: string;
}

export interface Rule {
  name: string;
  check: (ctx: PolicyContext, call: ToolCall) => PolicyResult;
}

const DANGEROUS_COMMANDS = [
  /git\s+push\s+(--force|-f)/,
  /rm\s+-rf\s+\//,
  /git\s+remote\s+(set-url|add)/,
  /chmod\s+777/,
  /> \/dev\/null/,
];

const HIGH_RISK_PATTERNS = [
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /migrations?\//i,
];

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

const pathRule: Rule = {
  name: 'path',
  check: (ctx, call) => {
    if (call.tool !== 'write_file' && call.tool !== 'edit_file') return { decision: 'allow' };
    const target = String(call.args.path ?? call.args.file_path ?? '');
    const normalizedTarget = normalizePath(target);
    const normalizedWorktree = normalizePath(ctx.worktreePath);

    if (!normalizedTarget.startsWith(normalizedWorktree)) {
      return { decision: 'deny', reason: `路径 ${target} 在 worktree 之外` };
    }
    return { decision: 'allow' };
  },
};

const commandRule: Rule = {
  name: 'command',
  check: (ctx, call) => {
    if (call.tool !== 'run_command' && call.tool !== 'shell') return { decision: 'allow' };
    const cmd = String(call.args.command ?? call.args.cmd ?? '');
    for (const pattern of DANGEROUS_COMMANDS) {
      if (pattern.test(cmd)) {
        return { decision: 'deny', reason: `危险命令: ${cmd}` };
      }
    }
    return { decision: 'allow' };
  },
};

const scopeRule: Rule = {
  name: 'scope',
  check: (ctx, call) => {
    if (call.tool !== 'write_file' && call.tool !== 'edit_file') return { decision: 'allow' };
    if (ctx.declaredScope.length === 0) return { decision: 'allow' };
    const target = String(call.args.path ?? call.args.file_path ?? '');
    const normalizedTarget = normalizePath(target).replace(normalizePath(ctx.worktreePath), '').replace(/^\//, '');
    const inScope = ctx.declaredScope.some((s) => normalizedTarget.startsWith(s.replace(/^\//, '')));
    if (!inScope) {
      return { decision: 'gate', reason: `文件 ${target} 在声明范围外`, gateType: 'scope_change' };
    }
    return { decision: 'allow' };
  },
};

const highRiskRule: Rule = {
  name: 'high_risk',
  check: (ctx, call) => {
    if (call.tool !== 'write_file' && call.tool !== 'edit_file') return { decision: 'allow' };
    const target = String(call.args.path ?? call.args.file_path ?? '');
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(target)) {
        return { decision: 'gate', reason: `高风险文件: ${target}`, gateType: 'high_risk_file' };
      }
    }
    return { decision: 'allow' };
  },
};

const bugPhaseRule: Rule = {
  name: 'bug_phase',
  check: (ctx, call) => {
    if (ctx.laneType !== 'bug') return { decision: 'allow' };
    if (ctx.laneState !== 'running') return { decision: 'allow' };
    // 简化：假设 lane 有 phase 字段（此处模拟，实际应从上下文读取）
    // 在 red_test 阶段前，只允许写测试目录
    const phase = (ctx as any).phase ?? 'locate';
    if (phase === 'reproduce' || phase === 'red_test') {
      if (call.tool === 'write_file' || call.tool === 'edit_file') {
        const target = String(call.args.path ?? call.args.file_path ?? '');
        if (!/test|spec|__tests__/i.test(target)) {
          return {
            decision: 'deny',
            reason: '缺陷流水线在复现/红测阶段，只允许写测试文件',
          };
        }
      }
    }
    return { decision: 'allow' };
  },
};

export const DEFAULT_RULES: Rule[] = [
  pathRule,
  commandRule,
  bugPhaseRule,
  scopeRule,
  highRiskRule,
];

export class PolicyEngine {
  constructor(private rules: Rule[] = DEFAULT_RULES) {}

  evaluate(ctx: PolicyContext, call: ToolCall): PolicyResult {
    for (const rule of this.rules) {
      const result = rule.check(ctx, call);
      if (result.decision !== 'allow') return result;
    }
    return { decision: 'allow' };
  }
}
