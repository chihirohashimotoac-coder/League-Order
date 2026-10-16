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
  'analytics',
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
  analytics: 'データ分析',
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
  analytics: 'home',
};

/** Pages reached from another screen rather than from the tab bar. */
export const BACK_TARGETS: Partial<Record<Page, Page>> = {
  pairs: 'home',
  settings: 'home',
  analytics: 'home',
  result: 'setup',
};

/**
 * Where each screen sits under HOME, for the breadcrumb trail. RESULT is reached through
 * SETUP, so its trail is ホーム › オーダー設定 › オーダー結果.
 */
export const BREADCRUMB_PARENT: Partial<Record<Page, Page>> = {
  players: 'home',
  pairs: 'home',
  formats: 'home',
  setup: 'home',
  result: 'setup',
  history: 'home',
  settings: 'home',
  analytics: 'home',
};

/** Short breadcrumb label; HOME reads ホーム rather than the team name. */
export const BREADCRUMB_LABELS: Record<Page, string> = { ...PAGE_TITLES, home: 'ホーム' };

/** The trail from HOME to `page`, HOME first. */
export function breadcrumbTrail(page: Page): Page[] {
  const trail: Page[] = [page];
  let current = BREADCRUMB_PARENT[page];
  while (current && trail.length < PAGES.length) {
    trail.unshift(current);
    current = BREADCRUMB_PARENT[current];
  }
  return trail;
}

export interface MenuEntry {
  page: Page;
  label: string;
  icon: IconName;
  note: string;
}

/** The hamburger menu: every screen, grouped by what the captain is doing. */
export const MENU_GROUPS: { title: string; kicker: string; entries: MenuEntry[] }[] = [
  {
    title: 'オーダー',
    kicker: 'ORDER',
    entries: [
      { page: 'setup', label: 'オーダー設定', icon: 'target', note: '参加者・条件・プリセット' },
      { page: 'result', label: 'オーダー結果', icon: 'checkCircle', note: '作業中のオーダー' },
      { page: 'history', label: '履歴', icon: 'history', note: '保存・確定したオーダー' },
    ],
  },
  {
    title: 'チーム',
    kicker: 'TEAM',
    entries: [
      { page: 'players', label: 'メンバー', icon: 'users', note: 'Rating・PPR・適性' },
      { page: 'formats', label: 'フォーマット', icon: 'format', note: 'ゲーム構成' },
      { page: 'pairs', label: 'ペア相性', icon: 'pair', note: '相性・禁止ペア' },
      { page: 'analytics', label: 'データ分析', icon: 'chart', note: 'n01 の成績分析' },
    ],
  },
  {
    title: 'アプリ',
    kicker: 'APP',
    entries: [{ page: 'settings', label: '設定 / バックアップ', icon: 'settings', note: '重み・JSON 入出力' }],
  },
];
