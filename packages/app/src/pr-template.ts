import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PrDraft {
  title: string;
  body: string;
  fromTemplate: boolean;
}

export interface PrDraftTest {
  status: 'running' | 'passed' | 'failed' | 'stopped';
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  output: string;
}

export interface PrDraftInput {
  kind: 'bug' | 'feature';
  title: string;
  description: string;
  jiraKey?: string;
  test?: PrDraftTest;
}

const TEMPLATE_PATHS = [join('.github', 'PULL_REQUEST_TEMPLATE.md'), join('.github', 'pull_request_template.md')];

/** 标题约定：type: 描述 (JIRA)。有票时去掉背景节，细节留在 Jira。 */
export function draftPullRequest(worktreePath: string, input: PrDraftInput): PrDraft {
  const type = input.kind === 'bug' ? 'fix' : 'feat';
  const ticket = input.jiraKey?.trim() ?? '';
  const title = ticket ? `${type}: ${input.title} (${ticket})` : `${type}: ${input.title}`;
  const template = readTemplate(worktreePath);
  if (!template) {
    const body = ticket ? `Jira: ${ticket}\n\n${input.description}`.trim() : input.description;
    return { title, body, fromTemplate: false };
  }
  return { title, body: fillTemplate(template, input), fromTemplate: true };
}

function readTemplate(worktreePath: string): string {
  for (const rel of TEMPLATE_PATHS) {
    const file = join(worktreePath, rel);
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return '';
}

function fillTemplate(template: string, input: PrDraftInput): string {
  const ticket = input.jiraKey?.trim() ?? '';
  let text = template.replace(/\r\n/g, '\n');
  if (ticket) text = text.replace(/^## 背景\/[^\n]*[\s\S]*?(?=^## )/m, '');
  text = text.replace(/^(## 改了什么\n)\n?<!--[\s\S]*?-->\n?/m, `$1\n${summarize(input.description)}\n\n`);
  text = text.replace(/^(## 验证（作者侧）\n)\n?<!--[\s\S]*?-->\n?/m, `$1\n${verification(input.test)}\n\n`);
  if (ticket) text = `Jira: ${ticket}\n\n${text.trim()}\n`;
  return text.trim() + '\n';
}

function verification(test: PrDraftTest | undefined): string {
  if (!test) return '中台没有这次任务的测试记录。';
  const status =
    test.status === 'passed'
      ? '通过'
      : test.status === 'failed'
        ? '失败'
        : test.status === 'stopped'
          ? '已停止'
          : '还在运行';
  const code = test.exitCode === null ? '' : `，退出码 ${test.exitCode}`;
  const duration = test.durationMs === null ? '' : `，耗时 ${Math.round(test.durationMs / 1000)} 秒`;
  const tail = test.output.trim().split('\n').slice(-8).join('\n');
  const output = tail ? `\n\n输出末尾：\n\n\`\`\`\n${tail.slice(0, 1200)}\n\`\`\`` : '';
  return `在任务工作区执行 \`${test.command}\`，结果${status}${code}${duration}。${output}`;
}

function summarize(description: string): string {
  const lines = description
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^https?:\/\//.test(line) &&
        !line.startsWith('——') &&
        !line.startsWith('Jira：') &&
        !line.startsWith('类型：'),
    );
  const picked = lines.slice(0, 8);
  if (picked.length === 0) return '待补充。';
  return picked.map((line) => (line.startsWith('-') || /^\d+\./.test(line) ? line : `- ${line}`)).join('\n');
}
