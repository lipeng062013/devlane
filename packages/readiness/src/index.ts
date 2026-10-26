export interface IssueInput {
  /** Jira issue 类型名，如 Bug、Story、Task。 */
  type: string;
  /** 描述转成 Markdown 后的文本。 */
  markdown: string;
  /** 字段映射得到的验收标准字段值。 */
  acceptance?: string;
  priority?: string;
  dueDate?: string;
  reporter?: string;
  assignee?: string;
  components?: string[];
}

export interface MissingItem {
  key: 'acceptance' | 'repro' | 'scope' | 'priority' | 'due' | 'owner';
  weight: number;
  message: string;
}

export interface ReadinessResult {
  /** 0 到 100，按适用项的满分折算。 */
  score: number;
  ready: boolean;
  missing: MissingItem[];
}

export const READY_THRESHOLD = 70;

const WEIGHTS = { acceptance: 30, repro: 30, scope: 20, priority: 5, due: 5, owner: 10 } as const;

const ACCEPTANCE_HEADING = /(验收标准|验收条件|acceptance criteria)/i;
const GIVEN_WHEN_THEN = /(given|假设|当).*(when|当|如果).*(then|则|那么)/is;
const REPRO_STEPS = /(复现步骤|重现步骤|复现方法|steps to reproduce|reproduction steps)/i;
const EXPECTED = /(期望|预期|expected)/i;
const ACTUAL = /(实际|actual)/i;
const SCOPE_HINT = /(影响范围|影响模块|affected|impact)/i;
const FILE_PATH = /[\w.-]+\/[\w./-]+\.\w{1,6}/;

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBug(type: string): boolean {
  return /^(bug|defect|缺陷|故障)$/i.test(type.trim());
}

export function assessReadiness(issue: IssueInput): ReadinessResult {
  const text = issue.markdown;
  const missing: MissingItem[] = [];
  let earned = 0;
  let max = 0;

  const check = (key: MissingItem['key'], ok: boolean, message: string): void => {
    const weight = WEIGHTS[key];
    max += weight;
    if (ok) earned += weight;
    else missing.push({ key, weight, message });
  };

  check(
    'acceptance',
    hasText(issue.acceptance) || ACCEPTANCE_HEADING.test(text) || GIVEN_WHEN_THEN.test(text),
    '缺少验收标准',
  );

  if (isBug(issue.type)) {
    const parts: string[] = [];
    if (!REPRO_STEPS.test(text)) parts.push('复现步骤');
    if (!EXPECTED.test(text)) parts.push('期望结果');
    if (!ACTUAL.test(text)) parts.push('实际结果');
    check('repro', parts.length === 0, `缺陷缺少：${parts.join('、')}`);
  }

  check(
    'scope',
    (issue.components?.length ?? 0) > 0 || SCOPE_HINT.test(text) || FILE_PATH.test(text),
    '缺少影响范围（模块、文件或接口）',
  );
  check('priority', hasText(issue.priority), '缺少优先级');
  check('due', hasText(issue.dueDate), '缺少截止时间');
  check('owner', hasText(issue.reporter) || hasText(issue.assignee), '缺少报告人或经办人');

  const score = max === 0 ? 0 : Math.round((earned / max) * 100);
  return { score, ready: score >= READY_THRESHOLD, missing };
}
