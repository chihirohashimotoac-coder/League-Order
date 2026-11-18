import { useCallback, useState } from 'react';

/**
 * 表示テーマ (見た目だけの設定)。
 *
 * - 端末ごとの表示の好みなので、チームのデータ・JSON バックアップには含めず、この端末の
 *   localStorage にだけ保存する。保存できない環境 (プライベートモードなど) でも既定のテーマで動く。
 * - テーマは `<html data-theme="…">` で切り替え、色・影などは CSS のトークン (`--color-*`) が
 *   受け持つ。オーダー生成・推定・保存・n01 連携の計算には一切関与しない。
 * - 得点・進行状態の色の意味 (確定=緑 / 下書き=琥珀 / 更新=橙 / 違反=赤 / LOCK=紫 / シーズン=青、
 *   LIVE=赤 など) はどのテーマでも同じで、各テーマの背景に合わせて明るさだけを変える。
 */
export const THEME_IDS = ['sheet', 'stadium', 'clean'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'sheet';

export const THEMES: readonly { key: ThemeId; label: string; hint: string; color: string; scheme: 'light' | 'dark' }[] = [
  {
    key: 'sheet',
    label: 'マッチシート (既定)',
    hint: '紙色のページに白いカードと Teal。明るい会場で読みやすい標準のテーマ',
    color: '#ffffff',
    scheme: 'light',
  },
  {
    key: 'stadium',
    label: 'スタジアム (ダーク)',
    hint: '濃紺の画面に明るい数字。暗い会場や夜の観戦でまぶしくない',
    color: '#0d151b',
    scheme: 'dark',
  },
  {
    key: 'clean',
    label: 'クリーン (白基調)',
    hint: '白い画面に濃紺の操作色。罫線を減らした、すっきりした見た目',
    color: '#ffffff',
    scheme: 'light',
  },
];

export const THEME_STORAGE_KEY = 'league-order:theme';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

/** 保存されたテーマ。未保存・不正な値・読めない環境では既定のテーマ。 */
export function readTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ThemeId {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** テーマを保存する。保存できなくても例外は出さない (表示は切り替わる)。 */
export function saveTheme(theme: ThemeId, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
    return storage !== null;
  } catch {
    return false;
  }
}

/** `<html>` にテーマを適用する (data-theme・color-scheme・ブラウザ枠の色)。 */
export function applyTheme(theme: ThemeId, doc: Document = document): void {
  const meta = THEMES.find((entry) => entry.key === theme) ?? THEMES[0];
  const root = doc.documentElement;
  root.dataset.theme = meta.key;
  root.style.colorScheme = meta.scheme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', meta.color);
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', meta.scheme);
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 設定画面用: 現在のテーマと、選ぶと適用・保存する関数。 */
export function useTheme(): [ThemeId, (next: ThemeId) => void] {
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());
  const choose = useCallback((next: ThemeId) => {
    applyTheme(next);
    saveTheme(next);
    setTheme(next);
  }, []);
  return [theme, choose];
}
