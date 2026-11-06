import type { StructuralKind } from '../types';

/**
 * Known league rules (リーグ規則カタログ).
 *
 * Each entry says, for one league on n01, which appearance caps League Order applies to its
 * league fixtures without asking, and *why* — the basis is kept apart from the caps so a rule
 * the captain stated is never shown as one read from the official regulations.
 *
 * - `basis: 'official'`: read in the league's published regulations (`sources` names them and
 *   their revision date). No entry has it yet: the ATDO and TDO regulations could not be read
 *   from the environment this was built in (see `officialCheck`).
 * - `basis: 'requirement'`: stated by the League Order owner as a confirmed requirement for the
 *   league (2026-11-06: "ATDO・TDO では、同じ日の対戦で同一選手をダブルスに 2 回、またはシングルス
 *   に 2 回出場させてはいけない"). Applied as a hard rule, labelled as the user's requirement.
 *
 * An n01 schedule that *has* two Doubles games is never evidence of a cap: the caps come from
 * here, from the format editor, or from the captain's answer — nothing else.
 */

export type RuleBasis = 'official' | 'requirement';

export interface RuleSourceRecord {
  title: string;
  url: string | null;
  /** `YYYY-MM-DD` of the revision read, or `null` when not known. */
  revisedAt: string | null;
  /** What was (or could not be) checked in it. */
  note: string;
}

export interface LeagueRuleCatalogEntry {
  id: string;
  /** Short name shown on screen (`ATDO`, `TDO`). */
  title: string;
  /** n01 league ids (`lgid`) the entry applies to. */
  leagueIds: readonly string[];
  /**
   * What the caps apply to. Only formats n01 manages are matched, and those are always built
   * from the league fixtures (`lg_setting` schedule) — never from a playoff or a cup that
   * runs under the same league id with its own rules.
   */
  scope: { ttype: 'lg'; seasons: 'all'; description: string };
  /** Appearances one player may make in one order (one match card) per player-count kind. */
  caps: Partial<Record<StructuralKind, number>>;
  basis: RuleBasis;
  /** When the entry was recorded. */
  recordedAt: string;
  /** The result of looking for the official regulations. */
  officialCheck: { status: 'confirmed' | 'unconfirmed'; checkedAt: string; note: string };
  sources: readonly RuleSourceRecord[];
  /**
   * The unit the rule is stated in ("同じ日の対戦"). League Order checks one order — one match
   * card. When a team plays two cards on one day, an appearance in the other card is not seen.
   */
  statedUnit: 'matchDay';
}

const REQUIREMENT_SOURCE: RuleSourceRecord = {
  title: 'League Order 利用者の確定要件 (2026-11-06 の実装指示)',
  url: null,
  revisedAt: '2026-11-06',
  note: '同じ日の対戦で同一選手をダブルスに 2 回、またはシングルスに 2 回出場させてはいけない。',
};

export const LEAGUE_RULE_CATALOG: readonly LeagueRuleCatalogEntry[] = [
  {
    id: 'atdo-league',
    title: 'ATDO',
    leagueIds: ['lg_l3hI_3397'],
    scope: { ttype: 'lg', seasons: 'all', description: 'ATDO DARTS LEAGUE のリーグ戦 (n01 のリーグ戦スケジュール)' },
    caps: { SINGLES: 1, DOUBLES: 1 },
    basis: 'requirement',
    recordedAt: '2026-11-06',
    officialCheck: {
      status: 'unconfirmed',
      checkedAt: '2026-11-06',
      note: 'ATDO の公式規約は見つかりませんでした (Web 検索・n01 のリーグ説明欄・各シーズンの開催要項欄はいずれも空)。',
    },
    sources: [
      REQUIREMENT_SOURCE,
      {
        title: 'n01 リーグポータル (ATDO DARTS LEAGUE)',
        url: 'https://n01darts.com/n01/league/portal.php?lgid=lg_l3hI_3397',
        revisedAt: null,
        note: '説明欄・開催要項欄に出場規則の記載なし (2026-11-06 確認)。',
      },
    ],
    statedUnit: 'matchDay',
  },
  {
    id: 'tdo-league',
    title: 'TDO',
    leagueIds: ['lg_3qgW_6619'],
    scope: { ttype: 'lg', seasons: 'all', description: 'TDO (東京ダーツオーガニゼイション) のリーグ戦 (n01 のリーグ戦スケジュール)' },
    caps: { SINGLES: 1, DOUBLES: 1 },
    basis: 'requirement',
    recordedAt: '2026-11-06',
    officialCheck: {
      status: 'unconfirmed',
      checkedAt: '2026-11-06',
      note:
        'TDO 公式サイトの資料ページ (リーグ競技規則・パブリーグ規約) は検索で見つかりましたが、本文は閲覧できず内容は未確認です。',
    },
    sources: [
      REQUIREMENT_SOURCE,
      {
        title: 'TDO 公式サイト 資料ダウンロード (リーグ競技規則・パブリーグ規約)',
        url: 'https://www.tokyodarts.org/tdo/download/',
        revisedAt: null,
        note: '本文未確認。出場回数の規定が書かれているかは確認できていません。',
      },
    ],
    statedUnit: 'matchDay',
  },
];

export function catalogEntryForLeague(leagueId: string | null | undefined): LeagueRuleCatalogEntry | null {
  if (!leagueId) return null;
  return LEAGUE_RULE_CATALOG.find((entry) => entry.leagueIds.includes(leagueId)) ?? null;
}

export function catalogEntryById(id: string | null | undefined): LeagueRuleCatalogEntry | null {
  if (!id) return null;
  return LEAGUE_RULE_CATALOG.find((entry) => entry.id === id) ?? null;
}

/** On-screen label of an entry's basis. */
export function basisLabel(entry: Pick<LeagueRuleCatalogEntry, 'basis' | 'title'>): string {
  return entry.basis === 'official' ? `${entry.title} 公式規約` : `${entry.title} の出場規則 (利用者の確定要件・公式規約は未確認)`;
}
