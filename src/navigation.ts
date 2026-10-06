import type { IconName } from './components/icons';

/** Screen identifiers used by the app shell (spec §26). */
export const PAGES = [
  'home',
  'players',
  'pairs',
  'formats',
  'setup',
  'result',
  'history',
  'settings',
] as const;

export type Page = (typeof PAGES)[number];

/**
 * Header titles. HOME shows the active team's name instead (the header there reads
 * "LEAGUE ORDER / <TEAM>"), so its entry is only the fallback when no team exists.
 */
export const PAGE_TITLES: Record<Page, string> = {
  home: 'LEAGUE ORDER',
  players: 'メンバー',
  pairs: 'ペア相性',
  formats: 'フォーマット',
  setup: 'オーダー設定',
  result: 'オーダー結果',
  history: '履歴',
  settings: '設定',
};

/** Tabs shown in the bottom bar, in order. */
export const TABS: { page: Page; label: string; icon: IconName }[] = [
  { page: 'home', label: 'ホーム', icon: 'home' },
  { page: 'players', label: 'メンバー', icon: 'users' },
  { page: 'formats', label: 'フォーマット', icon: 'format' },
  { page: 'setup', label: 'オーダー', icon: 'target' },
  { page: 'history', label: '履歴', icon: 'history' },
];

/** Which tab is highlighted for a page that is not itself a tab. */
export const TAB_FOR_PAGE: Partial<Record<Page, Page>> = {
  result: 'setup',
  pairs: 'home',
  settings: 'home',
};

/** Pages reached from another screen rather than from the tab bar. */
export const BACK_TARGETS: Partial<Record<Page, Page>> = {
  pairs: 'home',
  settings: 'home',
  result: 'setup',
};
