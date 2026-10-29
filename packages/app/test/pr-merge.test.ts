import { readFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/domain';
import {
  canMergePr,
  isCiMergeable,
  mergeBlockReason,
  mergePullRequest,
} from '../src/pr-merge';
import type { GhExecFile } from '../src/pr-check';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('isCiMergeable / canMergePr', () => {
  it('success and none are mergeable ci', () => {
    expect(isCiMergeable('success')).toBe(true);
    expect(isCiMergeable('none')).toBe(true);
    expect(isCiMergeable('pending')).toBe(false);
    expect(isCiMergeable('failure')).toBe(false);
    expect(isCiMergeable('unknown')).toBe(false);
  });

  it('gate requires mergeable + good ci', () => {
    expect(canMergePr({ ci: 'success', merge: 'mergeable' })).toBe(true);
    expect(canMergePr({ ci: 'none', merge: 'mergeable' })).toBe(true);
    expect(canMergePr({ ci: 'failure', merge: 'mergeable' })).toBe(false);
    expect(canMergePr({ ci: 'success', merge: 'blocked' })).toBe(false);
    expect(canMergePr({ ci: 'success', merge: 'merged' })).toBe(false);
  });
});

describe('mergeBlockReason', () => {
  it('undefined when mergeable or already merged', () => {
    expect(mergeBlockReason({ ci: 'success', merge: 'mergeable' })).toBeUndefined();
    expect(mergeBlockReason({ ci: 'none', merge: 'mergeable' })).toBeUndefined();
    expect(mergeBlockReason({ ci: 'success', merge: 'merged' })).toBeUndefined();
  });

  it('readable reasons for blocked states', () => {
    expect(mergeBlockReason({ ci: 'failure', merge: 'mergeable' })).toMatch(/CI/);
    expect(mergeBlockReason({ ci: 'success', merge: 'blocked', mergeDetail: 'x' })).toContain('x');
    expect(mergeBlockReason({ ci: 'success', merge: 'closed' })).toMatch(/关闭|closed/i);
  });
});

describe('mergePullRequest', () => {
  it('calls gh pr merge --merge via execFile', async () => {
    const calls: string[][] = [];
    const execFile: GhExecFile = async (_f, args) => {
      calls.push([...args]);
      return { stdout: '', stderr: '' };
    };
    await mergePullRequest('https://github.com/o/r/pull/9', { execFile });
    expect(calls).toEqual([['pr', 'merge', 'https://github.com/o/r/pull/9', '--merge']]);
  });

  it('prefers mergeFn (FakeGh)', async () => {
    const seen: string[] = [];
    await mergePullRequest('https://github.com/o/r/pull/1', {
      mergeFn: async (url) => {
        seen.push(url);
      },
      execFile: async () => {
        throw new Error('should not call execFile');
      },
    });
    expect(seen).toEqual(['https://github.com/o/r/pull/1']);
  });

  it('empty url -> 400', async () => {
    const err = await mergePullRequest('').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  });

  it('exec error -> 502 with readable prefix', async () => {
    const execFile: GhExecFile = async () => {
      throw Object.assign(new Error('boom'), { stderr: 'GraphQL: denied' });
    };
    const err = await mergePullRequest('https://github.com/o/r/pull/2', { execFile }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).message).toContain('GraphQL');
  });
});

describe('T7 pr-check stays read-only', () => {
  it('pr-check.ts has no merge write command', () => {
    const src = readFileSync(pathJoin(__dirname, '..', 'src', 'pr-check.ts'), 'utf8');
    expect(src).toContain("'pr'");
    expect(src).toContain("'view'");
    expect(src).not.toMatch(/\bgh\s+pr\s+merge\b/);
    expect(src).not.toMatch(/\/merges\b/);
    expect(src).not.toContain("'merge'");
  });
});
