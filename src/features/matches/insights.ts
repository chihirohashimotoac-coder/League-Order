import type { SavedOrder } from '../../domain/types';
import type { CardGame, MatchCard } from './cards';
import { slotStructure } from './cards';
import type { GameRow, SeasonDocument } from './parse';
import { slotsFor, teamDivision } from './parse';

/**
 * MATCH INTELLIGENCE: what League Order adds on top of n01's numbers.
 *
 * Every figure here is labelled by where it comes from: n01's official values are passed
 * through; League Order's own counts and rates say so; small samples are flagged instead of
 * being turned into verdicts.
 */

/** Below this many games a rate is shown as 参考 (reference only). */
export const MIN_SAMPLE = 5;
/** A game whose estimate was at least this sure, and went the other way, is a surprise. */
export const SURPRISE_AT = 0.65;

// ---------------------------------------------------------------------------
// Prediction (League Order order) ↔ result (n01 card)
// ---------------------------------------------------------------------------

export interface PredictionLink {
  orderId: string;
  orderTitle: string;
  ourSide: 0 | 1;
  matchWin: number | null;
  /** Actual card outcome from our side, official only. */
  actual: 'W' | 'D' | 'L' | null;
  games: {
    slotLabel: string;
    structure: string;
    predicted: number | null;
    actual: 'W' | 'L' | null;
    surprise: boolean;
  }[];
  surprises: number;
  /** Next-match hints, only when the evidence is there. */
  hints: string[];
}

/**
 * An order is linked to a card only when it was made for exactly that card: its opponent
 * context names the card (`lsid`), every game of the order is a game of that season
 * (`n01g_<tdid>_<schid>`), and our side is the side whose name is not the opponent's. Anything
 * short of that is not linked — a similar date or opponent name is never enough.
 */
export function linkOrder(order: SavedOrder, card: MatchCard): PredictionLink | null {
  const opponent = order.input.opponent;
  if (!opponent || opponent.matchId !== card.lsid) return null;
  const prefix = `n01g_${card.tournamentId}_`;
  if (order.input.games.length === 0 || !order.input.games.every((game) => game.id.startsWith(prefix))) return null;
  const opponentSide = card.teams.findIndex((team) => team.name === opponent.opponentName);
  if (opponentSide === -1 || card.teams[0].name === card.teams[1].name) return null;
  const ourSide = (1 - opponentSide) as 0 | 1;
  const prediction = order.solution.prediction;
  const bySchid = new Map(card.games.map((game) => [game.slot.schid, game]));
  const games = order.input.games.map((game) => {
    const schid = game.id.slice(prefix.length);
    const played: CardGame | undefined = bySchid.get(schid);
    const predicted = prediction?.games.find((entry) => entry.gameId === game.id)?.probability ?? null;
    const actual: 'W' | 'L' | null = played && played.winner !== null ? (played.winner === ourSide ? 'W' : 'L') : null;
    const surprise = predicted !== null && actual !== null && ((predicted >= SURPRISE_AT && actual === 'L') || (predicted <= 1 - SURPRISE_AT && actual === 'W'));
    return { slotLabel: played?.slot.label ?? game.name, structure: played ? slotStructure(played.slot) : '', predicted, actual, surprise };
  });
  const actual = card.official
    ? card.official[ourSide] > card.official[1 - ourSide]
      ? 'W'
      : card.official[ourSide] < card.official[1 - ourSide]
        ? 'L'
        : 'D'
    : null;
  const hints: string[] = [];
  const upsets = games.filter((game) => game.surprise && game.actual === 'L');
  for (const game of upsets) {
    hints.push(`${game.slotLabel}: 推定勝率 ${Math.round((game.predicted ?? 0) * 100)}% で敗戦。次戦はこの枠の組合せ・投順を見直す候補です (1 試合の結果で、偶然の可能性もあります)。`);
  }
  return {
    orderId: order.id,
    orderTitle: order.title,
    ourSide,
    matchWin: prediction?.win ?? null,
    actual,
    games,
    surprises: games.filter((game) => game.surprise).length,
    hints,
  };
}

// ---------------------------------------------------------------------------
// Players of one team in one season
// ---------------------------------------------------------------------------

export interface KindRecord {
  games: number;
  wins: number;
}

export interface PlayerForm {
  /** Season-scoped member id (`oid`); players are never merged across ids or by name. */
  oid: string;
  name: string;
  byStructure: Record<string, KindRecord>;
  /** Singles only — the only games whose average is the player's own. */
  singles01: { season: number | null; recent: number | null; games: number; trend: number[] };
  singlesCricket: { season: number | null; recent: number | null; games: number };
  notes: string[];
}

const RECENT = 3;

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Card side index of a team in one game row, or `null`. */
function sideOf(game: GameRow, teamId: string): 0 | 1 | null {
  return game.sides[0].teamId === teamId ? 0 : game.sides[1].teamId === teamId ? 1 : null;
}

function rate(game: GameRow, side: 0 | 1): number | null {
  const row = game.sides[side];
  if (row.darts === null || row.darts <= 0) return null;
  if (game.matchType === 'cricket') return row.marks === null ? null : (row.marks / row.darts) * 3;
  return row.score === null ? null : (row.score / row.darts) * 3;
}

export function playerForms(season: SeasonDocument, games: readonly GameRow[], teamId: string): PlayerForm[] {
  const slotBySchid = new Map(slotsFor(season, teamDivision(season, teamId)).map((slot) => [slot.schid, slot]));
  const forms = new Map<string, PlayerForm & { s01: number[]; sc: number[] }>();
  const sorted = [...games].filter((game) => game.finished).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  for (const game of sorted) {
    const side = sideOf(game, teamId);
    if (side === null) continue;
    const slot = game.schid ? slotBySchid.get(game.schid) : undefined;
    const structure = slot ? slotStructure(slot) : 'UNKNOWN';
    const legs = [game.sides[0].legsWon, game.sides[1].legsWon];
    const won = legs[0] !== null && legs[1] !== null && legs[side]! > legs[1 - side]!;
    for (const member of game.sides[side].members) {
      if (!member.oid) continue;
      const form =
        forms.get(member.oid) ??
        ({
          oid: member.oid,
          name: member.name,
          byStructure: {},
          singles01: { season: null, recent: null, games: 0, trend: [] },
          singlesCricket: { season: null, recent: null, games: 0 },
          notes: [],
          s01: [],
          sc: [],
        } as PlayerForm & { s01: number[]; sc: number[] });
      const record = form.byStructure[structure] ?? { games: 0, wins: 0 };
      record.games += 1;
      if (won) record.wins += 1;
      form.byStructure[structure] = record;
      if (game.sides[side].members.length === 1) {
        const value = rate(game, side);
        if (value !== null) (game.matchType === 'cricket' ? form.sc : form.s01).push(value);
      }
      forms.set(member.oid, form);
    }
  }
  return [...forms.values()].map(({ s01, sc, ...form }) => {
    form.singles01 = { season: mean(s01), recent: s01.length > RECENT ? mean(s01.slice(-RECENT)) : null, games: s01.length, trend: s01.slice(-8) };
    form.singlesCricket = { season: mean(sc), recent: sc.length > RECENT ? mean(sc.slice(-RECENT)) : null, games: sc.length };
    const kinds = Object.entries(form.byStructure).filter(([, record]) => record.games >= MIN_SAMPLE);
    if (kinds.length >= 2) {
      const ranked = kinds.map(([kind, record]) => ({ kind, rate: record.wins / record.games })).sort((a, b) => b.rate - a.rate);
      if (ranked[0].rate - ranked[ranked.length - 1].rate >= 0.25) {
        form.notes.push(`${ranked[0].kind} の勝率が最も高く (${Math.round(ranked[0].rate * 100)}%)、${ranked[ranked.length - 1].kind} は ${Math.round(ranked[ranked.length - 1].rate * 100)}% です。`);
      }
    }
    if (form.singles01.season !== null && form.singles01.recent !== null && form.singles01.games >= MIN_SAMPLE + RECENT) {
      const delta = form.singles01.recent - form.singles01.season;
      if (Math.abs(delta) >= 3) form.notes.push(`直近 ${RECENT} 試合の Singles 01 平均がシーズン平均より ${delta > 0 ? '+' : ''}${delta.toFixed(1)}。`);
    }
    return form;
  }).sort((a, b) => totalGames(b) - totalGames(a));
}

function totalGames(form: PlayerForm): number {
  return Object.values(form.byStructure).reduce((sum, record) => sum + record.games, 0);
}

// ---------------------------------------------------------------------------
// One team in one season, and two teams against each other
// ---------------------------------------------------------------------------

export interface TeamProfile {
  teamId: string;
  name: string;
  cards: { w: number; d: number; l: number };
  byStructure: Record<string, KindRecord>;
  singles01: number | null;
  singles01Games: number;
}

export function teamProfile(season: SeasonDocument, cards: readonly MatchCard[], games: readonly GameRow[], teamId: string): TeamProfile {
  const record = { w: 0, d: 0, l: 0 };
  for (const card of cards) {
    if (!card.official) continue;
    const side = card.teams[0].id === teamId ? 0 : card.teams[1].id === teamId ? 1 : null;
    if (side === null) continue;
    const diff = card.official[side] - card.official[1 - side];
    if (diff > 0) record.w += 1;
    else if (diff < 0) record.l += 1;
    else record.d += 1;
  }
  const slotBySchid = new Map(slotsFor(season, teamDivision(season, teamId)).map((slot) => [slot.schid, slot]));
  const byStructure: Record<string, KindRecord> = {};
  const singles: number[] = [];
  for (const game of games) {
    if (!game.finished) continue;
    const side = sideOf(game, teamId);
    if (side === null) continue;
    const slot = game.schid ? slotBySchid.get(game.schid) : undefined;
    const structure = slot ? slotStructure(slot) : 'UNKNOWN';
    const [a, b] = [game.sides[side].legsWon, game.sides[1 - side].legsWon];
    if (a === null || b === null) continue;
    const entry = byStructure[structure] ?? { games: 0, wins: 0 };
    entry.games += 1;
    if (a > b) entry.wins += 1;
    byStructure[structure] = entry;
    if (game.matchType === '01' && game.sides[side].members.length === 1) {
      const value = rate(game, side);
      if (value !== null) singles.push(value);
    }
  }
  return { teamId, name: season.teams.get(teamId) ?? teamId, cards: record, byStructure, singles01: mean(singles), singles01Games: singles.length };
}

export interface HeadToHeadRow {
  tournamentId: string;
  seasonTitle: string;
  ours: number;
  theirs: number;
  /** How the two teams were found in that season. */
  matchedBy: 'id' | 'name';
}

/**
 * Official card results between two teams across seasons. In the season the ids come from
 * they are matched by id (`tpid`); in any other season only by the exact team name — a
 * renamed team is not found, and the rows say which way each was matched.
 */
export function headToHead(
  seasons: readonly SeasonDocument[],
  current: { tournamentId: string; ourId: string; theirId: string; ourName: string; theirName: string },
): HeadToHeadRow[] {
  const rows: HeadToHeadRow[] = [];
  for (const season of seasons) {
    let ours: string | null;
    let theirs: string | null;
    let matchedBy: 'id' | 'name';
    if (season.tournamentId === current.tournamentId) {
      ours = current.ourId;
      theirs = current.theirId;
      matchedBy = 'id';
    } else {
      const byName = (name: string): string | null => {
        const found = [...season.teams.entries()].filter(([, entry]) => entry.trim() === name.trim());
        return found.length === 1 ? found[0][0] : null;
      };
      ours = byName(current.ourName);
      theirs = byName(current.theirName);
      matchedBy = 'name';
    }
    if (!ours || !theirs) continue;
    for (const result of season.results.values()) {
      const a = result.get(ours);
      const b = result.get(theirs);
      if (a && b) rows.push({ tournamentId: season.tournamentId, seasonTitle: season.title, ours: a.r, theirs: b.r, matchedBy });
    }
  }
  return rows;
}

export function percent(record: KindRecord | undefined): string {
  if (!record || record.games === 0) return '—';
  const value = `${Math.round((record.wins / record.games) * 100)}%`;
  return record.games < MIN_SAMPLE ? `${value} (参考 ${record.games}試合)` : `${value} (${record.games}試合)`;
}

// ---------------------------------------------------------------------------
// Who a team puts in which game (起用傾向)
// ---------------------------------------------------------------------------

export interface SlotUsage {
  /** The season's games the team has played, in schedule order. */
  slots: { schid: string; label: string }[];
  /** Cards (matches) the team has played this season. */
  cards: number;
  /** Per player: how many cards they played each slot in (same order as `slots`). */
  rows: { oid: string; name: string; counts: number[]; total: number }[];
}

/**
 * From the finished games n01 lists (who actually played, not the submitted orders): for each
 * player of the team, the number of cards in which they played each game of the schedule.
 * Players are told apart by their season member id.
 */
export function slotUsage(season: SeasonDocument, games: readonly GameRow[], teamId: string): SlotUsage {
  const schedule = slotsFor(season, teamDivision(season, teamId));
  const index = new Map(schedule.map((slot, i) => [slot.schid, i]));
  const cards = new Set<string>();
  const players = new Map<string, { oid: string; name: string; counts: number[] }>();
  for (const game of games) {
    if (!game.finished || !game.schid || !index.has(game.schid)) continue;
    const side = sideOf(game, teamId);
    if (side === null) continue;
    cards.add(game.tmid ?? game.scid ?? game.mid);
    for (const member of game.sides[side].members) {
      if (!member.oid) continue;
      const row = players.get(member.oid) ?? { oid: member.oid, name: member.name, counts: Array(schedule.length).fill(0) };
      row.counts[index.get(game.schid)!] += 1;
      players.set(member.oid, row);
    }
  }
  const used = schedule.map((_, i) => [...players.values()].some((row) => row.counts[i] > 0));
  const slots = schedule.filter((_, i) => used[i]).map((slot) => ({ schid: slot.schid, label: slot.label }));
  const rows = [...players.values()]
    .map((row) => {
      const counts = row.counts.filter((_, i) => used[i]);
      return { oid: row.oid, name: row.name, counts, total: counts.reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ja'));
  return { slots, cards: cards.size, rows };
}
