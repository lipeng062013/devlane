import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HttpError,
  type PrCheckCi,
  type PrCheckMerge,
  type PrCheckSnapshot,
} from './domain';
import type { GhExecFile } from './pr-check';

const execFileAsync = promisify(execFile);

export type MergePrDeps = {
  /** Inject mock execFile; tests use FakeGh only */
  execFile?: GhExecFile;
  /** High-level inject (FakeGh in tests); preferred over execFile */
  mergeFn?: (prUrl: string) => Promise<void>;
};

/** CI mergeable: success or none. pending/failure/unknown blocked. */
export function isCiMergeable(ci: PrCheckCi): boolean {
  return ci === 'success' || ci === 'none';
}

/** Gate: ci in {success,none} and merge === mergeable */
export function canMergePr(snap: Pick<PrCheckSnapshot, 'ci' | 'merge'>): boolean {
  return isCiMergeable(snap.ci) && snap.merge === 'mergeable';
}

const MSG = {
  closed: 'PR ' + String.fromCharCode(0x5df2, 0x5173, 0x95ed, 0xff0c, 0x65e0, 0x6cd5, 0x5408, 0x5e76),
  blockedPrefix: String.fromCharCode(0x4e0d, 0x53ef, 0x5408, 0x5e76, 0xff1a),
  blockedPlain: String.fromCharCode(0x4e0d, 0x53ef, 0x5408, 0x5e76, 0xff08, 0x88ab, 0x963b, 0x6b62, 0x6216, 0x6709, 0x51b2, 0x7a81, 0xff09),
  unknownMerge: String.fromCharCode(0x5408, 0x5e76, 0x6001, 0x672a, 0x77e5, 0xff0c, 0x8bf7, 0x5148, 0x5237, 0x65b0),
  pending: 'CI ' + String.fromCharCode(0x8fdb, 0x884c, 0x4e2d, 0xff0c, 0x6682, 0x4e0d, 0x53ef, 0x5408, 0x5e76),
  failure: 'CI ' + String.fromCharCode(0x5931, 0x8d25, 0xff0c, 0x4e0d, 0x53ef, 0x5408, 0x5e76),
  unknownCi: 'CI ' + String.fromCharCode(0x72b6, 0x6001, 0x672a, 0x77e5, 0xff0c, 0x6682, 0x4e0d, 0x53ef, 0x5408, 0x5e76),
  fallback: String.fromCharCode(0x5f53, 0x524d, 0x4e0d, 0x6ee1, 0x8db3, 0x5408, 0x5e76, 0x6761, 0x4ef6),
  noPr: String.fromCharCode(0x8fd8, 0x6ca1, 0x6709) + ' PR',
  failPrefix: String.fromCharCode(0x5408, 0x5e76) + ' PR ' + String.fromCharCode(0x5931, 0x8d25, 0xff1a),
};

/** Human-readable block reason; undefined if merged or mergeable. */
export function mergeBlockReason(
  snap: Pick<PrCheckSnapshot, 'ci' | 'merge' | 'mergeDetail'>,
): string | undefined {
  if (snap.merge === 'merged') return undefined;
  if (canMergePr(snap)) return undefined;
  if (snap.merge === 'closed') return MSG.closed;
  if (snap.merge === 'blocked') {
    const detail = snap.mergeDetail?.trim();
    return detail ? MSG.blockedPrefix + detail : MSG.blockedPlain;
  }
  if (snap.merge === 'unknown') return MSG.unknownMerge;
  if (snap.ci === 'pending') return MSG.pending;
  if (snap.ci === 'failure') return MSG.failure;
  if (snap.ci === 'unknown') return MSG.unknownCi;
  return MSG.fallback;
}

/** Write-merge: gh pr merge <ref> --merge. Keep pr-check.ts read-only. */
export async function mergePullRequest(prUrl: string, deps: MergePrDeps = {}): Promise<void> {
  const url = String(prUrl ?? '').trim();
  if (!url) throw new HttpError(400, MSG.noPr);
  if (deps.mergeFn) {
    await deps.mergeFn(url);
    return;
  }
  const exec = deps.execFile ?? (execFileAsync as unknown as GhExecFile);
  try {
    await exec('gh', ['pr', 'merge', url, '--merge'], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message: string };
    const detail = String(e.stderr || e.message)
      .trim()
      .split('\n')[0]
      ?.slice(0, 300);
    throw new HttpError(502, detail ? MSG.failPrefix + detail : MSG.failPrefix + 'gh error');
  }
}

export type { PrCheckCi, PrCheckMerge };
