import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HttpError,
  type PrCheckCi,
  type PrCheckMerge,
  type PrCheckSnapshot,
} from './domain';

const execFileAsync = promisify(execFile);

/** Parse PR number from URL. */
export function parsePrNumber(prUrl: string): number | undefined {
  const m = String(prUrl ?? '').match(/\/pulls?\/(\d+)(?:\/|$|\?|#)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type GhExecFile = (
  file: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    timeout?: number;
    windowsHide?: boolean;
    maxBuffer?: number;
    encoding?: BufferEncoding;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

type RollupItem = {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
};

export function summarizeCi(rollup: unknown): PrCheckCi {
  if (rollup == null) return 'none';
  if (!Array.isArray(rollup)) return 'unknown';
  if (rollup.length === 0) return 'none';
  let anyPending = false;
  let anyFailure = false;
  let anySuccess = false;
  for (const raw of rollup) {
    if (!raw || typeof raw !== 'object') return 'unknown';
    const item = raw as RollupItem;
    const status = String(item.status ?? '').toUpperCase();
    const conclusion = String(item.conclusion ?? '').toUpperCase();
    const state = String(item.state ?? '').toUpperCase();

    if (
      status === 'IN_PROGRESS' ||
      status === 'QUEUED' ||
      status === 'PENDING' ||
      status === 'REQUESTED' ||
      status === 'WAITING'
    ) {
      anyPending = true;
      continue;
    }
    if (status === 'COMPLETED' || conclusion) {
      if (
        ['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'CANCELED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
          conclusion,
        )
      ) {
        anyFailure = true;
      } else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
        anySuccess = true;
      } else if (!conclusion) {
        return 'unknown';
      } else {
        anyFailure = true;
      }
      continue;
    }
    if (state === 'PENDING' || state === 'EXPECTED') {
      anyPending = true;
    } else if (state === 'FAILURE' || state === 'ERROR') {
      anyFailure = true;
    } else if (state === 'SUCCESS') {
      anySuccess = true;
    } else {
      return 'unknown';
    }
  }
  if (anyFailure) return 'failure';
  if (anyPending) return 'pending';
  if (anySuccess) return 'success';
  return 'unknown';
}

export function summarizeMerge(raw: {
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
}): { merge: PrCheckMerge; mergeDetail?: string } {
  const state = String(raw.state ?? '').toUpperCase();
  if (state === 'MERGED') return { merge: 'merged' };
  if (state === 'CLOSED') return { merge: 'closed' };
  const mergeable = String(raw.mergeable ?? '').toUpperCase();
  const mss = String(raw.mergeStateStatus ?? '').toUpperCase();
  if (mergeable === 'MERGEABLE' && mss !== 'DIRTY') {
    return { merge: 'mergeable' };
  }
  let mergeDetail: string | undefined;
  if (mergeable === 'CONFLICTING' || mss === 'DIRTY') mergeDetail = "有冲突";
  else if (mss === 'BLOCKED') mergeDetail = "检查未过或被阻止";
  else if (mss === 'BEHIND') mergeDetail = "落后基线";
  else if (mss === 'DRAFT') mergeDetail = "草稿";
  else if (mss === 'UNSTABLE') mergeDetail = "状态不稳定";
  else if (mergeable === 'UNKNOWN' || !mergeable) mergeDetail = "合并态未知";
  else mergeDetail = mss || mergeable || "不可合并";
  return { merge: 'blocked', mergeDetail };
}

const PR_VIEW_FIELDS = 'number,url,state,mergeable,mergeStateStatus,statusCheckRollup';

/**
 * Read-only PR CI / merge snapshot.
 * Must not wrap any merge-write CLI/REST.
 * Acceptance: FakeGh / mock execFile only.
 */
export async function fetchPrSnapshot(
  prUrl: string,
  deps: { execFile?: GhExecFile; now?: () => Date } = {},
): Promise<PrCheckSnapshot> {
  const url = String(prUrl ?? '').trim();
  if (!url) throw new HttpError(400, "还没有 PR");
  const numHint = parsePrNumber(url);
  const exec = deps.execFile ?? (execFileAsync as unknown as GhExecFile);
  const now = deps.now ?? (() => new Date());
  let stdout: string;
  try {
    const result = await exec('gh', ['pr', 'view', url, '--json', PR_VIEW_FIELDS], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    stdout = String(result.stdout ?? '');
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message: string };
    const detail = String(e.stderr || e.message)
      .trim()
      .split('\n')[0]
      ?.slice(0, 300);
    const prefix = "刷新 PR 状态失败：";
    throw new HttpError(502, detail ? prefix + detail : prefix + 'gh error');
  }
  let raw: {
    number?: number;
    url?: string;
    state?: string;
    mergeable?: string;
    mergeStateStatus?: string;
    statusCheckRollup?: unknown;
  };
  try {
    raw = JSON.parse(stdout) as typeof raw;
  } catch {
    throw new HttpError(502, "刷新 PR 状态失败：gh JSON 无法解析");
  }
  const ci = summarizeCi(raw.statusCheckRollup);
  const { merge, mergeDetail } = summarizeMerge(raw);
  const prNumber = typeof raw.number === 'number' && raw.number > 0 ? raw.number : numHint;
  return {
    refreshedAt: now().toISOString(),
    prNumber,
    ci,
    merge,
    mergeDetail,
  };
}

export const PR_CHECK_READONLY = true as const;
