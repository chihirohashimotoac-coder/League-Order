/** One version entry in the update history. */
export interface ChangelogEntry {
  /** Semantic version string, e.g. "1.1.0" */
  version: string;
  /** ISO date string (YYYY-MM-DD) of the release. */
  date: string;
  /** User-facing summary of this version's changes (2–5 items). */
  items: string[];
  /** Optional context note shown below the items. */
  note?: string;
  /** Optional GitHub PR links related to this release. */
  prLinks?: { label: string; url: string }[];
}

/**
 * App update history, newest first.
 *
 * Versions must match the value in package.json (checked by the version-consistency test).
 * When adding a new release: prepend an entry here and bump package.json.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.1.0',
    date: '2026-10-13',
    items: [
      '設定画面にアプリバージョンを表示するようにしました',
      '更新履歴をいつでも設定画面から確認できるようにしました',
      'オフライン環境でも更新履歴を表示できます',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-05',
    note: '以下は履歴管理を開始した時点でのアプリの主な機能です。',
    items: [
      '1投目を誰が担当するかを考慮した投順最適化と、格上チーム相手の1タップ作戦提案を追加しました',
      '編集中のスロットで文字のコントラストが失われる表示不具合を修正しました',
      '選手・チームの詳細データ分析画面（勝率・PPR・シーズン推移）を追加しました',
      'n01との連携で対戦相手データを自動取得し、オーダー最適化に活用できるようになりました',
      'PPR・Soft/Steel強度モデル、役割分散、リーグマッチシートUIを導入しました',
    ],
    prLinks: [
      { label: 'PR #17 投順最適化・格上対策', url: 'https://github.com/chihirohashimotoac-coder/League-Order/pull/17' },
      { label: 'PR #18 UIアクセシビリティ修正', url: 'https://github.com/chihirohashimotoac-coder/League-Order/pull/18' },
      { label: 'PR #13 データ分析画面', url: 'https://github.com/chihirohashimotoac-coder/League-Order/pull/13' },
    ],
  },
];

/** The version string of the latest entry. Must equal __APP_VERSION__ at runtime. */
export const CHANGELOG_LATEST_VERSION = CHANGELOG[0].version;
