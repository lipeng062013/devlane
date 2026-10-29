import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/domain';
import { fetchPrSnapshot, parsePrNumber, summarizeCi, summarizeMerge, type GhExecFile } from '../src/pr-check';

const noPr = String.fromCharCode(0x8fd8, 0x6ca1, 0x6709) + ' PR';
const refreshFail = String.fromCharCode(0x5237, 0x65b0) + ' PR ' + String.fromCharCode(0x72b6, 0x6001, 0x5931, 0x8d25);

describe('parsePrNumber', () => {
  it('parses', () => {
    expect(parsePrNumber('https://github.com/o/r/pull/42')).toBe(42);
    expect(parsePrNumber('https://github.com/o/r')).toBeUndefined();
  });
});

describe('summarizeCi', () => {
  it('T1 success / none', () => {
    expect(summarizeCi([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('success');
    expect(summarizeCi([])).toBe('none');
  });
  it('T2 failure/pending', () => {
    expect(summarizeCi([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('failure');
    expect(summarizeCi([{ status: 'IN_PROGRESS' }])).toBe('pending');
  });
});

describe('summarizeMerge', () => {
  it('T3 states', () => {
    expect(summarizeMerge({ state: 'MERGED' }).merge).toBe('merged');
    expect(summarizeMerge({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }).merge).toBe('mergeable');
    expect(summarizeMerge({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).merge).toBe('blocked');
    expect(summarizeMerge({ state: 'CLOSED' }).merge).toBe('closed');
  });
});

describe('fetchPrSnapshot', () => {
  it('T1 mock success no merge write', async () => {
    const calls: string[][] = [];
    const execFile: GhExecFile = async (_f, args) => {
      calls.push([...args]);
      return {
        stdout: JSON.stringify({
          number: 9,
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        stderr: '',
      };
    };
    const snap = await fetchPrSnapshot('https://github.com/o/r/pull/9', {
      execFile,
      now: () => new Date('2026-10-29T10:00:00.000Z'),
    });
    expect(snap).toMatchObject({ ci: 'success', merge: 'mergeable', prNumber: 9 });
    expect(calls[0]).not.toContain('merge');
  });

  it('T3 merged', async () => {
    const execFile: GhExecFile = async (_f, args) => {
      expect(args).not.toContain('merge');
      return { stdout: JSON.stringify({ number: 1, state: 'MERGED', statusCheckRollup: [] }), stderr: '' };
    };
    expect((await fetchPrSnapshot('https://github.com/o/r/pull/1', { execFile })).merge).toBe('merged');
  });

  it('T4 empty', async () => {
    const err = await fetchPrSnapshot('').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toContain(noPr);
  });

  it('T5 fail', async () => {
    const execFile: GhExecFile = async () => {
      const e = new Error('x') as Error & { stderr: string };
      e.stderr = 'authentication required';
      throw e;
    };
    const err = await fetchPrSnapshot('https://github.com/o/r/pull/1', { execFile }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain(refreshFail);
  });
});

describe('T8 static', () => {
  it('no merge write command', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'pr-check.ts'), 'utf8');
    expect(src).toContain("'pr'");
    expect(src).toContain("'view'");
    expect(src).toContain('--json');
    expect(src).not.toMatch(/\bgh\s+pr\s+merge\b/);
    expect(src).not.toMatch(/\/merges\b/);
    expect(src).not.toContain("'merge'");
  });
});
