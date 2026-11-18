import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_THEME, THEMES, THEME_IDS, THEME_STORAGE_KEY, applyTheme, readTheme, saveTheme } from './theme';

// 設定画面を描くための最小限のストア。テーマはストアを通らない (保存されるのは localStorage だけ)。
const saveSettings = vi.fn();
vi.mock('../state/appStore', () => ({
  useAppStore: () => ({
    settings: {
      n01: { autoSync: false, showPredictions: false, historyDepth: 2 },
      customWeights: { strength: 1, gameFit: 1, pairFit: 1, fairness: 1, roleFairness: 1, novelty: 1, consecutive: 1, season: 1 },
      optimizer: { timeLimitMs: 2000, beamWidth: 16, fairnessScope: 'today' },
      activeTeamId: null,
    },
    backendKind: 'indexeddb',
    saveSettings,
    snapshot: () => ({ teams: [], players: [], formats: [], pairs: [], orders: [], seasonCommits: [], settings: {} }),
    replaceEverything: vi.fn(),
  }),
}));

function resetDocument(): void {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff"><meta name="color-scheme" content="light">';
}

beforeEach(() => {
  window.localStorage.clear();
  resetDocument();
  saveSettings.mockClear();
});
afterEach(cleanup);

describe('theme storage', () => {
  it('defaults to the match-sheet theme when nothing is stored', () => {
    expect(DEFAULT_THEME).toBe('sheet');
    expect(readTheme()).toBe('sheet');
  });

  it('reads back a saved theme and ignores anything that is not a theme', () => {
    expect(saveTheme('stadium')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('stadium');
    expect(readTheme()).toBe('stadium');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readTheme()).toBe('sheet');
    window.localStorage.setItem(THEME_STORAGE_KEY, '');
    expect(readTheme()).toBe('sheet');
  });

  it('falls back to the default, without throwing, when storage cannot be used', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readTheme(broken)).toBe('sheet');
    expect(saveTheme('clean', broken)).toBe(false);
    expect(readTheme(null)).toBe('sheet');
    expect(saveTheme('clean', null)).toBe(false);
  });

  it('every theme has a label, a hint and a browser colour', () => {
    expect(THEMES.map((entry) => entry.key)).toEqual([...THEME_IDS]);
    for (const entry of THEMES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
      expect(entry.color).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });
});

describe('applyTheme', () => {
  it('sets data-theme, color-scheme and the browser colour', () => {
    applyTheme('stadium');
    expect(document.documentElement.dataset.theme).toBe('stadium');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0d151b');
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark');
    applyTheme('clean');
    expect(document.documentElement.dataset.theme).toBe('clean');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});

describe('SettingsPage: 表示テーマ', () => {
  it('lists the three themes with the saved one checked, and a pick applies and saves it on this device only', async () => {
    saveTheme('clean');
    const { SettingsPage } = await import('../pages/SettingsPage');
    render(<SettingsPage />);
    const group = screen.getByRole('group', { name: '画面の配色' });
    const radios = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.value)).toEqual(['sheet', 'stadium', 'clean']);
    expect((screen.getByRole('radio', { name: /クリーン/u }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /スタジアム/u }));
    expect((screen.getByRole('radio', { name: /スタジアム/u }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('stadium');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('stadium');
    // チームのデータ・バックアップ (AppSettings) には書かない。
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
