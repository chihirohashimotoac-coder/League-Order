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
  'matches',
  'live',
  'watch',
  'more',
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
  analytics: '分析',
  // The three entries of the match screens are one screen (観戦) with its own tabs.
  matches: '観戦',
  live: '観戦',
  watch: '観戦',
  more: 'その他',
};

/**
 * Tabs shown in the bottom bar, in order: watching, analysis and orders are the three main uses;
 * everything else (members, formats, pairs, history, settings, change log) is one tap away
 * under その他.
 */
export const TABS: { page: Page; label: string; icon: IconName }[] = [
  { page: 'home', label: 'ホーム', icon: 'home' },
  { page: 'watch', label: '観戦', icon: 'trophy' },
  { page: 'analytics', label: '分析', icon: 'chart' },
  { page: 'setup', label: 'オーダー', icon: 'target' },
  { page: 'more', label: 'その他', icon: 'menu' },
];

/** Which tab is highlighted for a page that is not itself a tab. */
export const TAB_FOR_PAGE: Partial<Record<Page, Page>> = {
  result: 'setup',
  live: 'watch',
  matches: 'watch',
  players: 'more',
  formats: 'more',
  pairs: 'more',
  history: 'more',
  settings: 'more',
};

/** Pages reached from another screen rather than from the tab bar. */
export const BACK_TARGETS: Partial<Record<Page, Page>> = {
  players: 'more',
  formats: 'more',
  pairs: 'more',
  history: 'more',
  settings: 'more',
  result: 'setup',
};

/**
 * Where each screen sits under HOME, for the breadcrumb trail. RESULT is reached through
 * SETUP, so its trail is ホーム › オーダー設定 › オーダー結果.
 */
export const BREADCRUMB_PARENT: Partial<Record<Page, Page>> = {
  players: 'more',
  pairs: 'more',
  formats: 'more',
  history: 'more',
  settings: 'more',
  more: 'home',
  setup: 'home',
  result: 'setup',
  analytics: 'home',
  matches: 'home',
  live: 'home',
  watch: 'home',
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
    title: '観戦・分析',
    kicker: 'MATCH',
    entries: [
      { page: 'live', label: 'ライブ', icon: 'target', note: '進行中の全カードを観戦' },
      { page: 'matches', label: '日程・結果', icon: 'trophy', note: '結果・順位・スタッツ' },
      { page: 'analytics', label: '分析', icon: 'chart', note: '選手・チームの成績分析' },
    ],
  },
  {
    title: 'チーム',
    kicker: 'TEAM',
    entries: [
      { page: 'players', label: 'メンバー', icon: 'users', note: 'Rating・PPR・適性' },
      { page: 'formats', label: 'フォーマット', icon: 'format', note: 'ゲーム構成' },
      { page: 'pairs', label: 'ペア相性', icon: 'pair', note: '相性・禁止ペア' },
    ],
  },
  {
    title: 'アプリ',
    kicker: 'APP',
    entries: [{ page: 'settings', label: '設定 / バックアップ', icon: 'settings', note: '重み・JSON 入出力' }],
  },
];
