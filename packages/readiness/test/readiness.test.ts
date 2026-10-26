import { describe, expect, it } from 'vitest';
import { assessReadiness } from '../src/index';
import type { IssueInput } from '../src/index';

const completeStory: IssueInput = {
  type: 'Story',
  markdown: '## 验收标准\n- 登录成功后跳转首页\n\n影响范围：src/auth/login.ts',
  priority: 'High',
  dueDate: '2026-11-10',
  reporter: 'alice',
};

describe('assessReadiness', () => {
  it('信息完整的需求得 100 分并就绪', () => {
    expect(assessReadiness(completeStory)).toEqual({ score: 100, ready: true, missing: [] });
  });

  it('非缺陷类不计复现步骤', () => {
    const result = assessReadiness(completeStory);
    expect(result.missing.find((m) => m.key === 'repro')).toBeUndefined();
  });

  it('验收标准可来自映射字段', () => {
    const result = assessReadiness({ ...completeStory, markdown: 'src/a/b.ts', acceptance: '页面可打开' });
    expect(result.missing.find((m) => m.key === 'acceptance')).toBeUndefined();
  });

  it('Given When Then 文本视为验收标准', () => {
    const result = assessReadiness({
      ...completeStory,
      markdown: 'Given 已登录 When 点击退出 Then 回到登录页\nsrc/a/b.ts',
    });
    expect(result.missing.find((m) => m.key === 'acceptance')).toBeUndefined();
  });

  it('缺陷缺少复现信息时列出具体缺项，得分 70 恰在阈值上', () => {
    const result = assessReadiness({
      type: 'Bug',
      markdown: '## 验收标准\n- 不再崩溃\n偶发崩溃，位于 src/pay/order.ts',
      priority: 'High',
      dueDate: '2026-11-10',
      reporter: 'bob',
    });
    expect(result.ready).toBe(true);
    expect(result.score).toBe(70);
    expect(result.missing).toEqual([
      { key: 'repro', weight: 30, message: '缺陷缺少：复现步骤、期望结果、实际结果' },
    ]);
  });

  it('缺陷信息完整时就绪', () => {
    const result = assessReadiness({
      type: 'Bug',
      markdown:
        '## 验收标准\n- 不再崩溃\n## 复现步骤\n1. 下单\n期望：成功\n实际：崩溃\nsrc/pay/order.ts',
      priority: 'High',
      dueDate: '2026-11-10',
      reporter: 'bob',
    });
    expect(result).toEqual({ score: 100, ready: true, missing: [] });
  });

  it('空白需求得低分并列出全部缺项', () => {
    const result = assessReadiness({ type: 'Task', markdown: '' });
    expect(result.score).toBe(0);
    expect(result.ready).toBe(false);
    expect(result.missing.map((m) => m.key)).toEqual([
      'acceptance',
      'scope',
      'priority',
      'due',
      'owner',
    ]);
  });

  it('非缺陷类按适用项满分 70 折算，阈值两侧分别判定', () => {
    // 验收标准 30 + 报告人 10 + 优先级 5 = 45 / 70 = 64，未就绪
    const below = assessReadiness({
      type: 'Story',
      markdown: '验收标准：页面可打开',
      priority: 'High',
      reporter: 'carol',
    });
    expect(below.score).toBe(64);
    expect(below.ready).toBe(false);
    // 再加截止时间 5 = 50 / 70 = 71，就绪
    const above = assessReadiness({
      type: 'Story',
      markdown: '验收标准：页面可打开',
      priority: 'High',
      dueDate: '2026-11-10',
      reporter: 'carol',
    });
    expect(above.score).toBe(71);
    expect(above.ready).toBe(true);
  });

  it('空白字符串字段视为缺失', () => {
    const result = assessReadiness({ ...completeStory, priority: '   ' });
    expect(result.missing.map((m) => m.key)).toEqual(['priority']);
  });
});
