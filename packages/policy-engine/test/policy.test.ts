import { describe, expect, it } from 'vitest';
import { PolicyEngine, type PolicyContext, type ToolCall } from '../src/index';

const makeCtx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  laneId: 'lane-1',
  laneState: 'running',
  laneType: 'story',
  declaredScope: ['src/auth/'],
  worktreePath: '/tmp/wt',
  ...overrides,
});

describe('PolicyEngine', () => {
  const engine = new PolicyEngine();

  it('路径在 worktree 内且无 declaredScope 时允许', () => {
    const result = engine.evaluate(
      makeCtx({ declaredScope: [] }),
      { tool: 'write_file', args: { path: '/tmp/wt/src/auth/login.ts' } },
    );
    expect(result.decision).toBe('allow');
  });

  it('路径在 declaredScope 内允许', () => {
    const result = engine.evaluate(
      makeCtx({ declaredScope: ['src/auth/'] }),
      { tool: 'write_file', args: { path: '/tmp/wt/src/auth/login.ts' } },
    );
    expect(result.decision).toBe('allow');
  });

  it('路径在 worktree 外拒绝', () => {
    const result = engine.evaluate(
      makeCtx(),
      { tool: 'write_file', args: { path: '/etc/passwd' } },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('worktree 之外');
  });

  it('危险命令拒绝', () => {
    const result = engine.evaluate(
      makeCtx(),
      { tool: 'run_command', args: { command: 'git push --force' } },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('危险命令');
  });

  it('范围外文件触发门禁', () => {
    const result = engine.evaluate(
      makeCtx({ declaredScope: ['src/auth/'] }),
      { tool: 'write_file', args: { path: '/tmp/wt/src/payment/order.ts' } },
    );
    expect(result.decision).toBe('gate');
    expect(result.gateType).toBe('scope_change');
  });

  it('高风险文件触发门禁', () => {
    const result = engine.evaluate(
      makeCtx({ declaredScope: [] }),
      { tool: 'edit_file', args: { path: '/tmp/wt/package.json' } },
    );
    expect(result.decision).toBe('gate');
    expect(result.gateType).toBe('high_risk_file');
  });

  it('缺陷 lane 在复现阶段写业务代码拒绝', () => {
    const ctx = { ...makeCtx({ laneType: 'bug' as const, declaredScope: [] }), phase: 'reproduce' };
    const result = engine.evaluate(
      ctx,
      { tool: 'write_file', args: { path: '/tmp/wt/src/app.ts' } },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('只允许写测试文件');
  });

  it('缺陷 lane 在复现阶段写测试允许', () => {
    const ctx = { ...makeCtx({ laneType: 'bug' as const, declaredScope: [] }), phase: 'reproduce' };
    const result = engine.evaluate(
      ctx,
      { tool: 'write_file', args: { path: '/tmp/wt/src/__tests__/app.test.ts' } },
    );
    expect(result.decision).toBe('allow');
  });

  it('非文件操作工具直接允许', () => {
    const result = engine.evaluate(makeCtx(), { tool: 'read_file', args: { path: '/etc/hosts' } });
    expect(result.decision).toBe('allow');
  });

  it('Windows 路径规范化后判断', () => {
    const result = engine.evaluate(
      makeCtx({ worktreePath: 'E:\\tmp\\wt', declaredScope: [] }),
      { tool: 'write_file', args: { path: 'E:/tmp/wt/src/a.ts' } },
    );
    expect(result.decision).toBe('allow');
  });
});
