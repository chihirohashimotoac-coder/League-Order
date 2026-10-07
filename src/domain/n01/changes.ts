/**
 * What a sync changed (MASTER SPEC Phase 5 §5).
 *
 * Built by the sync planner, shown to the captain before an order is generated. Only
 * changes that can alter an order are listed — season, division, discipline, format,
 * roster, PPR and the opponent — so the summary stays short enough to be read.
 */
export interface N01ChangeSummary {
  /** True on the first sync of a team (everything is new; nothing is "changed"). */
  firstSync: boolean;
  season: { from: string | null; to: string } | null;
  division: { from: string | null; to: string | null } | null;
  discipline: { from: string; to: string } | null;
  format: { from: string | null; to: string } | null;
  rosterAdded: string[];
  rosterInactive: string[];
  rosterReturned: string[];
  rosterRenamed: { from: string; to: string }[];
  pprChanged: { name: string; from: number | null; to: number | null }[];
  opponent: { from: string | null; to: string | null } | null;
  /** n01 names that were not matched automatically because the name was ambiguous. */
  ambiguousNames: string[];
  /** Anything else the captain should know (e.g. a sync that skipped the roster). */
  notes: string[];
}

export function emptyChangeSummary(firstSync = false): N01ChangeSummary {
  return {
    firstSync,
    season: null,
    division: null,
    discipline: null,
    format: null,
    rosterAdded: [],
    rosterInactive: [],
    rosterReturned: [],
    rosterRenamed: [],
    pprChanged: [],
    opponent: null,
    ambiguousNames: [],
    notes: [],
  };
}

/** Changes that should stop the one-tap flow and be shown before generating. */
export function hasImportantChanges(summary: N01ChangeSummary): boolean {
  if (summary.firstSync) return false;
  return (
    summary.season !== null ||
    summary.division !== null ||
    summary.discipline !== null ||
    summary.format !== null ||
    summary.rosterAdded.length > 0 ||
    summary.rosterInactive.length > 0 ||
    summary.rosterReturned.length > 0 ||
    summary.opponent !== null ||
    summary.ambiguousNames.length > 0 ||
    summary.notes.length > 0
  );
}

/** True when anything at all changed (PPR updates and renames included). */
export function hasAnyChanges(summary: N01ChangeSummary): boolean {
  return hasImportantChanges(summary) || summary.pprChanged.length > 0 || summary.rosterRenamed.length > 0;
}

function fmtPpr(value: number | null): string {
  return value === null ? '—' : String(Math.round(value * 100) / 100);
}

/** One line per change, most important first. */
export function describeChanges(summary: N01ChangeSummary): string[] {
  const lines: string[] = [...summary.notes];
  if (summary.season) lines.push(`シーズン: ${summary.season.from ?? '—'} → ${summary.season.to}`);
  if (summary.division) lines.push(`ディビジョン: ${summary.division.from ?? '—'} → ${summary.division.to ?? '—'}`);
  if (summary.discipline) lines.push(`ダーツ種別: ${summary.discipline.from} → ${summary.discipline.to}`);
  if (summary.format) lines.push(`フォーマット: ${summary.format.to}`);
  if (summary.opponent) lines.push(`次の対戦相手: ${summary.opponent.from ?? '—'} → ${summary.opponent.to ?? '—'}`);
  if (summary.rosterAdded.length > 0) lines.push(`メンバー追加: ${summary.rosterAdded.join('、')}`);
  if (summary.rosterInactive.length > 0) lines.push(`登録から外れた: ${summary.rosterInactive.join('、')}`);
  if (summary.rosterReturned.length > 0) lines.push(`登録に復帰: ${summary.rosterReturned.join('、')}`);
  for (const rename of summary.rosterRenamed) lines.push(`名前変更: ${rename.from} → ${rename.to}`);
  if (summary.ambiguousNames.length > 0) {
    lines.push(`同名のため自動で対応付けしなかった選手: ${summary.ambiguousNames.join('、')}`);
  }
  if (summary.pprChanged.length > 0) {
    const shown = summary.pprChanged.slice(0, 4).map((entry) => `${entry.name} ${fmtPpr(entry.from)}→${fmtPpr(entry.to)}`);
    const more = summary.pprChanged.length > 4 ? ` ほか ${summary.pprChanged.length - 4} 名` : '';
    lines.push(`PPR 更新: ${shown.join('、')}${more}`);
  }
  return lines;
}
