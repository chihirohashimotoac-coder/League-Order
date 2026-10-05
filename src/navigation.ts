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

export const PAGE_TITLES: Record<Page, string> = {
  home: 'Darts Order',
  players: 'メンバー',
  pairs: 'ペア相性',
  formats: 'フォーマット',
  setup: 'オーダー設定',
  result: 'オーダー結果',
  history: '履歴',
  settings: '設定',
};

/** Tabs shown in the bottom bar, in order. */
export const TABS: { page: Page; label: string; icon: string }[] = [
  { page: 'home', label: 'ホーム', icon: '⌂' },
  { page: 'players', label: 'メンバー', icon: '☰' },
  { page: 'formats', label: 'フォーマット', icon: '▤' },
  { page: 'setup', label: 'オーダー', icon: '◎' },
  { page: 'history', label: '履歴', icon: '⏱' },
];

/** Pages reached from another screen rather than from the tab bar. */
export const BACK_TARGETS: Partial<Record<Page, Page>> = {
  pairs: 'home',
  settings: 'home',
  result: 'setup',
};
