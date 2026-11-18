import { afterEach, describe, expect, it } from 'vitest';
import { HARIMARU_STORAGE_KEY, readHarimaruEnabled, resetHarimaruPreferenceForTests, saveHarimaruEnabled } from './preference';

afterEach(() => {
  window.localStorage.clear();
  resetHarimaruPreferenceForTests();
});

describe('ハリマルの表示設定', () => {
  it('初期値は ON', () => {
    expect(readHarimaruEnabled()).toBe(true);
  });
  it('OFF / ON を端末に保存する', () => {
    expect(saveHarimaruEnabled(false)).toBe(true);
    expect(window.localStorage.getItem(HARIMARU_STORAGE_KEY)).toBe('off');
    expect(readHarimaruEnabled()).toBe(false);
    expect(saveHarimaruEnabled(true)).toBe(true);
    expect(readHarimaruEnabled()).toBe(true);
  });
  it('不正な値・読めない環境では ON', () => {
    window.localStorage.setItem(HARIMARU_STORAGE_KEY, 'maybe');
    expect(readHarimaruEnabled()).toBe(true);
    expect(readHarimaruEnabled({ getItem: () => { throw new Error('denied'); } })).toBe(true);
  });
  it('保存できない環境でも例外を出さず、このタブの中では選択が効く', () => {
    expect(saveHarimaruEnabled(false, { setItem: () => { throw new Error('quota'); } })).toBe(false);
    expect(readHarimaruEnabled()).toBe(false);
  });
});
