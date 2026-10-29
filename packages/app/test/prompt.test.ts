import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUG_PROMPT,
  DEFAULT_FEATURE_PROMPT,
  applyPromptTemplate,
  buildInitialPrompt,
} from '../src/prompt';
import { updateSettings } from '../src/projects';
import { StateStore } from '../src/store';

const project = { name: 'demo', testCommand: 'node check.js' };
const bugTask = {
  kind: 'bug' as const,
  title: '求和结果错误',
  description: 'add(2,3) 应该是 5',
  jiraKey: 'ABC-12',
  branch: 'devlane/fix-abc-12-abcd',
  baseBranch: 'main',
};
const featureTask = {
  kind: 'feature' as const,
  title: '支持乘法',
  description: '实现 mul',
  branch: 'devlane/feat-mul-abcd',
  baseBranch: 'main',
};

const temps: string[] = [];
afterEach(() => {
  for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('buildInitialPrompt / templates', () => {
  it('T1 自定义模板生效', () => {
    const out = buildInitialPrompt(project, bugTask, {
      bug: 'CUSTOM-BUG {{title}} :: {{jiraKey}} :: {{testCommand}}',
    });
    expect(out).toBe('CUSTOM-BUG 求和结果错误 :: ABC-12 :: node check.js');
    expect(out).not.toContain('缺陷修复');
  });

  it('T2 清空/空白回落 DEFAULT', () => {
    const a = buildInitialPrompt(project, bugTask);
    const b = buildInitialPrompt(project, bugTask, { bug: '' });
    const c = buildInitialPrompt(project, bugTask, { bug: '   ' });
    const d = buildInitialPrompt(project, bugTask, { bug: undefined });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
    expect(a).toContain('缺陷修复');
    expect(a).toContain('求和结果错误');
    expect(a).toContain('ABC-12');
    expect(a).toContain('node check.js');
    expect(a).toContain('不要执行 git commit、git push');
    expect(DEFAULT_BUG_PROMPT).toContain('{{title}}');
    expect(DEFAULT_FEATURE_PROMPT).toContain('{{title}}');
  });

  it('T3 占位符替换；未知保留；空字段空串', () => {
    const out = buildInitialPrompt(
      project,
      { ...bugTask, description: '', jiraKey: undefined },
      {
        bug: 't={{title}} d={{description}} j={{jiraKey}} p={{projectName}} b={{branch}} bb={{baseBranch}} k={{kind}} tc={{testCommand}} u={{unknownX}}',
      },
    );
    expect(out).toBe(
      't=求和结果错误 d= j= p=demo b=devlane/fix-abc-12-abcd bb=main k=缺陷修复 tc=node check.js u={{unknownX}}',
    );
    expect(applyPromptTemplate('keep {{nope}}', { title: 'x' })).toBe('keep {{nope}}');
  });

  it('T4 经 updateSettings 持久化后再读仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devlane-prompt-'));
    temps.push(dir);
    const path = join(dir, 'state.json');
    const store = new StateStore(path);
    updateSettings(store, {
      promptTemplates: {
        bug: 'PERSIST {{title}}',
        feature: 'FEAT {{title}}',
      },
    });
    const reloaded = new StateStore(path);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      settings: { promptTemplates?: { bug?: string; feature?: string } };
    };
    expect(raw.settings.promptTemplates?.bug).toBe('PERSIST {{title}}');
    expect(reloaded.data.settings.promptTemplates?.bug).toBe('PERSIST {{title}}');
    expect(buildInitialPrompt(project, bugTask, reloaded.data.settings.promptTemplates)).toBe('PERSIST 求和结果错误');
  });

  it('T5 bug/feature 模板互不串用', () => {
    const templates = {
      bug: 'ONLY-BUG {{kind}}',
      feature: 'ONLY-FEATURE {{kind}}',
    };
    expect(buildInitialPrompt(project, bugTask, templates)).toBe('ONLY-BUG 缺陷修复');
    expect(buildInitialPrompt(project, featureTask, templates)).toBe('ONLY-FEATURE 需求开发');
    expect(buildInitialPrompt(project, featureTask, { bug: 'ONLY-BUG' })).toContain('需求开发');
    expect(buildInitialPrompt(project, featureTask, { bug: 'ONLY-BUG' })).toContain('补充测试');
  });

  it('默认描述空时回落补充说明；自定义空描述保持空', () => {
    const def = buildInitialPrompt(project, { ...bugTask, description: '' });
    expect(def).toContain('没有补充描述');
    const custom = buildInitialPrompt(
      project,
      { ...bugTask, description: '' },
      { bug: 'DESC[{{description}}]' },
    );
    expect(custom).toBe('DESC[]');
  });
});
