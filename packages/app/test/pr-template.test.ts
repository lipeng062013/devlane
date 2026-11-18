import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftPullRequest } from '../src/pr-template';

const template = `<!-- 标题约定 -->\n## 背景/問題\n\n<!-- 有票删本节 -->\n\n## 改了什么\n\n<!-- 一两句 -->\n\n## 验证（作者侧）\n\n<!-- 跑了什么 -->\n`;

describe('draftPullRequest', () => {
  it('有模板且有票时按约定填标题，并删掉背景节', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlane-pr-'));
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), template);
    const draft = draftPullRequest(dir, {
      kind: 'bug',
      title: '404 入口跳转错误',
      description: '处理方案：\n1. 跳到响应式浏览记录',
      jiraKey: 'HOUSE-1090',
    });
    expect(draft.title).toBe('fix: 404 入口跳转错误 (HOUSE-1090)');
    expect(draft.fromTemplate).toBe(true);
    expect(draft.body).not.toContain('## 背景');
    expect(draft.body).toContain('## 改了什么');
    expect(draft.body).toContain('跳到响应式浏览记录');
    expect(draft.body).toContain('Jira: HOUSE-1090');
    expect(draft.body).toContain('没有这次任务的测试记录');
  });

  it('验证节写入这次测试的命令和结果', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlane-pr-'));
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), template);
    const draft = draftPullRequest(dir, {
      kind: 'bug',
      title: '入口',
      description: '改跳转',
      test: { status: 'passed', command: 'npm test', exitCode: 0, durationMs: 12500, output: '第一行\nPASS src/link.spec.ts\n' },
    });
    expect(draft.body).toContain('执行 `npm test`，结果通过，退出码 0，耗时 13 秒');
    expect(draft.body).toContain('PASS src/link.spec.ts');
    expect(draft.body).not.toContain('待补充');
  });

  it('没有模板时仍给原来的说明', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlane-pr-'));
    const draft = draftPullRequest(dir, { kind: 'feature', title: '加筛选', description: '增加标签筛选', jiraKey: '' });
    expect(draft.fromTemplate).toBe(false);
    expect(draft.title).toBe('feat: 加筛选');
    expect(draft.body).toBe('增加标签筛选');
  });
});
