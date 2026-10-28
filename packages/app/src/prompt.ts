import type { Project, Task } from './domain';

/** 首次运行时发给 Claude 的任务说明。 */
export function buildInitialPrompt(
  project: Pick<Project, 'name' | 'testCommand'>,
  task: Pick<Task, 'kind' | 'title' | 'description' | 'jiraKey' | 'branch' | 'baseBranch'>,
): string {
  const isBug = task.kind === 'bug';
  const lines: string[] = [];
  lines.push(
    `你在项目「${project.name}」的一个独立 git worktree 里工作（分支 ${task.branch}，基于 ${task.baseBranch}）。`,
    `任务类型：${isBug ? '缺陷修复' : '需求开发'}`,
  );
  if (task.jiraKey) lines.push(`Jira：${task.jiraKey}`);
  lines.push(`标题：${task.title}`, '', '任务描述：', task.description.trim() || '（没有补充描述，请根据标题和代码自行判断）', '', '要求：');

  const test = project.testCommand.trim();
  const verify = test
    ? `用 \`${test}\` 验证改动；如果失败，分析原因并修复，直到通过或确认是无关的既有失败。`
    : '这个项目没有配置测试命令；请说明你是如何验证改动的。';

  if (isBug) {
    lines.push(
      '1. 先阅读相关代码，定位根因，不要只修表面症状。',
      '2. 如果可行，先写一个能复现该缺陷的失败测试，并确认它确实失败。',
      '3. 做最小的修复，不要顺手重构，也不要改无关文件。',
      `4. ${verify}`,
    );
  } else {
    lines.push(
      '1. 先阅读相关代码，理清现有结构和风格，再动手。',
      '2. 按描述实现功能，保持与现有代码一致的风格；范围以描述为准，不要夹带无关改动。',
      '3. 为新增的行为补充测试。',
      `4. ${verify}`,
    );
  }
  lines.push(
    '5. 不要执行 git commit、git push，也不要切换或创建分支；改动留在工作区，由用户审阅后提交。',
    '6. 如果某个命令被拒绝执行，不要反复重试，也不要绕开；继续做不需要它的部分，并在最后说明你需要运行什么、为什么需要。',
    '',
    '完成后用简短的中文总结：根因或实现思路、改了哪些文件、验证结果、还有什么没做或需要用户注意。',
  );
  return lines.join('\n');
}

export function buildAllowedPrompt(commands: string[]): string {
  const list = commands.map((c) => `- ${c}`).join('\n');
  return `用户已允许你运行下面的命令：\n${list}\n请继续完成之前因为这些命令被拒绝而没做的部分，然后重新验证并简要汇报。`;
}

export const CONTINUE_PROMPT = '请继续完成任务，并在最后简要汇报当前状态。';
