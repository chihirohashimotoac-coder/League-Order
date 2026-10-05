import { describe, expect, it } from 'vitest';
import { mergeDefined } from './merge';

describe('mergeDefined', () => {
  it('applies defined overrides', () => {
    expect(mergeDefined({ a: 1, b: 2 }, { b: 5 })).toEqual({ a: 1, b: 5 });
  });

  it('ignores undefined values so a default survives', () => {
    expect(mergeDefined({ a: 1, b: 2 }, { b: undefined })).toEqual({ a: 1, b: 2 });
  });

  it('keeps explicit nulls and zeros', () => {
    expect(mergeDefined({ a: 1 as number | null, b: 2 }, { a: null, b: 0 })).toEqual({ a: null, b: 0 });
  });

  it('returns a copy when there are no overrides', () => {
    const base = { a: 1 };
    const result = mergeDefined(base, undefined);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });
});
