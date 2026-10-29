import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/domain';
import { mapJiraPriority, normalizePriority, normalizeTags } from '../src/task-meta';

describe('normalizeTags', () => {
  it('trims, drops empty, dedupes case-insensitively keeping first form', () => {
    expect(normalizeTags(['  Foo ', 'foo', 'Bar', '', '  '])).toEqual(['Foo', 'Bar']);
  });

  it('caps at 10 tags', () => {
    const input = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(normalizeTags(input)).toHaveLength(10);
  });

  it('rejects tag longer than 32', () => {
    expect(() => normalizeTags(['x'.repeat(33)])).toThrow(HttpError);
  });

  it('non-array -> []', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags('nope')).toEqual([]);
  });
});

describe('normalizePriority', () => {
  it('defaults to none', () => {
    expect(normalizePriority(undefined)).toBe('none');
    expect(normalizePriority('weird')).toBe('none');
  });
  it('accepts known values', () => {
    for (const p of ['high', 'medium', 'low', 'none'] as const) expect(normalizePriority(p)).toBe(p);
  });
});

describe('mapJiraPriority (AC7, FakeJira-only mapping)', () => {
  it('maps High/Highest/高', () => {
    expect(mapJiraPriority('Highest')).toBe('high');
    expect(mapJiraPriority('High')).toBe('high');
    expect(mapJiraPriority('最高')).toBe('high');
    expect(mapJiraPriority('高')).toBe('high');
  });
  it('maps Medium/中', () => {
    expect(mapJiraPriority('Medium')).toBe('medium');
    expect(mapJiraPriority('中')).toBe('medium');
  });
  it('maps Low/Lowest/低', () => {
    expect(mapJiraPriority('Low')).toBe('low');
    expect(mapJiraPriority('Lowest')).toBe('low');
    expect(mapJiraPriority('低')).toBe('low');
  });
  it('other -> none', () => {
    expect(mapJiraPriority(undefined)).toBe('none');
    expect(mapJiraPriority('Blocker')).toBe('none');
  });
});
