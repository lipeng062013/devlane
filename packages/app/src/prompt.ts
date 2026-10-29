import type { Project, Task } from './domain';

export type PromptTemplates = { bug?: string; feature?: string };

/** 缺陷类任务的默认初始提示（含占位符；空/未配置时回落至此）。 */
export const DEFAULT_BUG_PROMPT = "你在项目「{{projectName}}」的一个独立 git worktree 里工作（分支 {{branch}}，基于 {{baseBranch}}）。\n任务类型：缺陷修复\n{{jiraLine}}标题：{{title}}\n\n任务描述：\n{{description}}\n\n要求：\n1. 先阅读相关代码，定位根因，不要只修表面症状。\n2. 如果可行，先写一个能复现该缺陷的失败测试，并确认它确实失败。\n3. 做最小的修复，不要顺手重构，也不要改无关文件。\n4. {{verify}}\n5. 不要执行 git commit、git push，也不要切换或创建分支；改动留在工作区，由用户审阅后提交。\n6. 如果某个命令被拒绝执行，不要反复重试，也不要绕开；继续做不需要它的部分，并在最后说明你需要运行什么、为什么需要。\n\n完成后用简短的中文总结：根因或实现思路、改了哪些文件、验证结果、还有什么没做或需要用户注意。";

/** 需求类任务的默认初始提示（含占位符；空/未配置时回落至此）。 */
export const DEFAULT_FEATURE_PROMPT = "你在项目「{{projectName}}」的一个独立 git worktree 里工作（分支 {{branch}}，基于 {{baseBranch}}）。\n任务类型：需求开发\n{{jiraLine}}标题：{{title}}\n\n任务描述：\n{{description}}\n\n要求：\n1. 先阅读相关代码，理清现有结构和风格，再动手。\n2. 按描述实现功能，保持与现有代码一致的风格；范围以描述为准，不要夹带无关改动。\n3. 为新增的行为补充测试。\n4. {{verify}}\n5. 不要执行 git commit、git push，也不要切换或创建分支；改动留在工作区，由用户审阅后提交。\n6. 如果某个命令被拒绝执行，不要反复重试，也不要绕开；继续做不需要它的部分，并在最后说明你需要运行什么、为什么需要。\n\n完成后用简短的中文总结：根因或实现思路、改了哪些文件、验证结果、还有什么没做或需要用户注意。";

const DESCRIPTION_FALLBACK = '（没有补充描述，请根据标题和代码自行判断）';

function buildVars(
  project: Pick<Project, 'name' | 'testCommand'>,
  task: Pick<Task, 'kind' | 'title' | 'description' | 'jiraKey' | 'branch' | 'baseBranch'>,
  opts: { descriptionFallback: boolean },
): Record<string, string> {
  const test = (project.testCommand ?? '').trim();
  const verify = test
    ? `用 \`${test}\` 验证改动；如果失败，分析原因并修复，直到通过或确认是无关的既有失败。`
    : '这个项目没有配置测试命令；请说明你是如何验证改动的。';
  const desc = (task.description ?? '').trim();
  const jiraKey = task.jiraKey ?? '';
  return {
    title: task.title ?? '',
    description: desc || (opts.descriptionFallback ? DESCRIPTION_FALLBACK : ''),
    jiraKey,
    testCommand: test,
    projectName: project.name ?? '',
    branch: task.branch ?? '',
    baseBranch: task.baseBranch ?? '',
    kind: task.kind === 'bug' ? '缺陷修复' : '需求开发',
    verify,
    jiraLine: jiraKey ? `Jira：${jiraKey}\n` : '',
  };
}

/** 替换 {{name}}；未知占位符原样保留；已知名空字段为空串。 */
export function applyPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}

/** 首次运行时发给 Agent 的任务说明。templates 对应 kind 非空则用自定义，否则 DEFAULT。 */
export function buildInitialPrompt(
  project: Pick<Project, 'name' | 'testCommand'>,
  task: Pick<Task, 'kind' | 'title' | 'description' | 'jiraKey' | 'branch' | 'baseBranch'>,
  templates?: PromptTemplates,
): string {
  const kind = task.kind === 'bug' ? 'bug' : 'feature';
  const custom = templates?.[kind]?.trim() ?? '';
  const template = custom || (kind === 'bug' ? DEFAULT_BUG_PROMPT : DEFAULT_FEATURE_PROMPT);
  const vars = buildVars(project, task, { descriptionFallback: !custom });
  return applyPromptTemplate(template, vars);
}

export function buildAllowedPrompt(commands: string[]): string {
  const list = commands.map((c) => `- ${c}`).join('\n');
  return `用户已允许你运行下面的命令：\n${list}\n请继续完成之前因为这些命令被拒绝而没做的部分，然后重新验证并简要汇报。`;
}

export const CONTINUE_PROMPT = '请继续完成任务，并在最后简要汇报当前状态。';
