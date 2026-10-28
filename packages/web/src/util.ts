import type { Task, TaskKind, TaskStatus } from './types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  needs_you: '待你决定',
  review: '待审阅',
  stopped: '已停止',
  failed: '失败',
  committed: '已提交',
  pr_opened: '已开 PR',
  discarded: '已丢弃',
};

export const KIND_LABEL: Record<TaskKind, string> = { bug: '缺陷', feature: '需求' };

/** 这类状态下 Claude 没有在工作，可以追问、提交。 */
export const IDLE_STATUSES: TaskStatus[] = ['review', 'needs_you', 'stopped', 'failed', 'committed', 'pr_opened'];

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function money(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** 排序：需要你的在前，其次运行中，然后按更新时间倒序。 */
export function taskRank(task: Task): number {
  switch (task.status) {
    case 'needs_you':
      return 0;
    case 'failed':
      return 1;
    case 'running':
    case 'queued':
      return 2;
    case 'review':
    case 'stopped':
      return 3;
    case 'committed':
    case 'pr_opened':
      return 4;
    default:
      return 5;
  }
}

/** 把一个 unified diff 拆成每个文件一段。 */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = patch.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const header = part.split('\n', 1)[0] ?? '';
    const m = / b\/(.+)$/.exec(header);
    if (m?.[1]) out.set(m[1], `diff --git ${part}`);
  }
  return out;
}

/** 默认的提交说明。 */
export function defaultCommitMessage(task: Task): string {
  const prefix = task.kind === 'bug' ? 'fix' : 'feat';
  const ref = task.jiraKey ? `${task.jiraKey} ` : '';
  return `${prefix}: ${ref}${task.title}`;
}

const SERVER_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/i,
  /\b(nuxt|nuxi|next|vite|astro|webpack-dev-server|ng)\s+(dev|serve|start|preview)\b/i,
  /(^|\s)--watch(All)?\b/i,
];

/** 这条命令看起来像开发服务器或监听模式：它不会自己结束，不适合当「测试命令」。 */
export function looksLikeDevServer(command: string): boolean {
  return SERVER_PATTERNS.some((re) => re.test(command));
}

export const DEV_SERVER_HINT =
  '这看起来是开发服务器或监听模式，不会自己结束，不适合当测试命令。请换成会自行结束的命令，例如 npm test、npm run typecheck、npm run lint。';
