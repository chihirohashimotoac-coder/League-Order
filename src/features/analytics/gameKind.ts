/**
 * What kind of game a slot or a played game is (P0: 競技種別の正確な識別).
 *
 * Two independent axes:
 *  - **family** — the competition type: `01`, `cricket`, or `unknown`. `unknown` is never
 *    counted as 01.
 *  - **role** — how many throw per side: singles / doubles / trios / gallon / team (4+).
 *
 * Evidence order (most to least trusted):
 *  1. the game's own `match_type` (n01 documents a *played* match without it as 01, so a
 *     missing value on a played game is 01 — unless its schedule slot says otherwise);
 *  2. the slot's own `match_type`;
 *  3. the slot's start score / the containing setting's `match_type`;
 *  4. otherwise `unknown`.
 * A name alone never decides: "クリケット" counts only together with a start score of 0, and a
 * 01 start score with a cricket name is a conflict (→ unknown).
 *
 * The real seasons that shaped this (fixtures in `realData.roles.test.ts`): ATDO 2024 2nd has
 * no `match_type` anywhere and a slot "クリケット" with `startScore: 0`; ATDO 2026 has explicit
 * `match_type: "01"` on every slot and division overrides with their own `schid`s.
 */

export type GameFamily = '01' | 'cricket' | 'unknown';

export type FamilyBasis =
  /** The value was written on the game or the slot. */
  | 'explicit'
  /** The setting (`lg_setting` / `game_setting[i]`) carried it, the slot did not. */
  | 'setting'
  /** A positive start score (501, 701, 1001 …) on a slot without a type. */
  | 'start-score'
  /** Start score 0 *and* a cricket name on a slot without a type. */
  | 'start-score+name'
  /** A played game without a type: 01 per the n01 API specification. */
  | 'match-default'
  /** The evidence contradicts itself. */
  | 'conflict'
  | 'none';

export interface FamilyVerdict {
  family: GameFamily;
  basis: FamilyBasis;
}

export type GameRole = 'singles' | 'doubles' | 'trios' | 'gallon' | 'team' | 'unknown';

/** A schedule slot exactly as n01 wrote it (analytics keeps the absence of `match_type`). */
export interface SlotEvidence {
  schid: string;
  /** `null` = the base schedule (`lg_setting.schedule`); else the division (`game_setting[].round`). */
  division: number | null;
  numPart: number | null;
  subtitle: string | null;
  startScore: number | null;
  limitLegCount: number | null;
  /** The slot's own `match_type`, `null` when absent. */
  matchType: string | null;
  /** `match_type` of the setting that holds the slot, `null` when absent. */
  settingMatchType: string | null;
}

const CRICKET_NAME = /cricket|クリケット/iu;
const GALLON_NAME = /gallon|ガロン/iu;

/** `01` / `cricket` for a recognised type string, `null` for anything else. */
export function normalizeMatchType(raw: string | null | undefined): '01' | 'cricket' | null {
  if (raw === null || raw === undefined) return null;
  const type = raw.trim().toLowerCase();
  if (type === '') return null;
  if (type === '01' || /^\d{3,4}$/u.test(type)) return '01';
  if (type.includes('cricket') || type.includes('クリケット')) return 'cricket';
  return null;
}

function present(raw: string | null): boolean {
  return raw !== null && raw.trim() !== '';
}

export function slotFamily(slot: SlotEvidence): FamilyVerdict {
  if (present(slot.matchType)) {
    const type = normalizeMatchType(slot.matchType);
    return type ? { family: type, basis: 'explicit' } : { family: 'unknown', basis: 'explicit' };
  }
  const cricketName = slot.subtitle !== null && CRICKET_NAME.test(slot.subtitle);
  const positiveStart = slot.startScore !== null && slot.startScore > 0;
  if (present(slot.settingMatchType)) {
    const type = normalizeMatchType(slot.settingMatchType);
    if (type === '01' && cricketName && !positiveStart) return { family: 'unknown', basis: 'conflict' };
    if (type) return { family: type, basis: 'setting' };
  }
  if (positiveStart) return cricketName ? { family: 'unknown', basis: 'conflict' } : { family: '01', basis: 'start-score' };
  if (slot.startScore === 0 && cricketName) return { family: 'cricket', basis: 'start-score+name' };
  return { family: 'unknown', basis: 'none' };
}

/**
 * A played game. `matchType` is the game's own value (`null` when the row had none); `slot`
 * is the verdict for its schedule slot, when the slot is known.
 */
export function gameFamily(matchType: string | null, slot: FamilyVerdict | null): FamilyVerdict {
  if (present(matchType)) {
    const type = normalizeMatchType(matchType);
    if (!type) return { family: 'unknown', basis: 'explicit' };
    // A slot that is *explicitly* the other family contradicts the game.
    if (slot && slot.basis === 'explicit' && slot.family !== 'unknown' && slot.family !== type) return { family: 'unknown', basis: 'conflict' };
    return { family: type, basis: 'explicit' };
  }
  // n01: "match_type missing = 01" for played matches — but not against a cricket / foreign slot.
  if (slot && slot.family === 'cricket') return { family: 'unknown', basis: 'conflict' };
  if (slot && slot.family === 'unknown' && slot.basis === 'explicit') return { family: 'unknown', basis: 'conflict' };
  return { family: '01', basis: 'match-default' };
}

/** The slot a game was played under: the division's override first, then the base schedule. */
export function slotFor(slots: readonly SlotEvidence[], schid: string | null, division: number | null): SlotEvidence | null {
  if (!schid) return null;
  if (division !== null) {
    const own = slots.find((s) => s.division === division && s.schid === schid);
    if (own) return own;
  }
  return slots.find((s) => s.division === null && s.schid === schid) ?? null;
}

/** Slots in force for a division: its override when it has one, else the base schedule. */
export function effectiveSlots(slots: readonly SlotEvidence[], division: number | null): SlotEvidence[] {
  if (division !== null) {
    const own = slots.filter((s) => s.division === division);
    if (own.length > 0) return own;
  }
  return slots.filter((s) => s.division === null);
}

export function roleOfSize(size: number, subtitle: string | null): GameRole {
  if (size >= 2 && subtitle !== null && GALLON_NAME.test(subtitle)) return 'gallon';
  if (size === 1) return 'singles';
  if (size === 2) return 'doubles';
  if (size === 3) return 'trios';
  if (size >= 4) return 'team';
  return 'unknown';
}

/**
 * Role of a played game: the slot's `num_part` checked against the players actually listed on
 * both sides. A disagreement (a substitute listed as an extra thrower, a side short of
 * players) leaves the game unclassified rather than guessed.
 */
export function gameRole(slot: SlotEvidence | null, sideSizes: readonly [number, number]): GameRole {
  const listed = sideSizes[0] === sideSizes[1] ? sideSizes[0] : null;
  if (slot?.numPart) {
    if (listed !== null && listed !== slot.numPart) return 'unknown';
    if (listed === null) return 'unknown';
    return roleOfSize(slot.numPart, slot.subtitle);
  }
  return listed === null ? 'unknown' : roleOfSize(listed, null);
}

/** Season make-up from its schedule: every slot of every division in force. */
export type Composition = 'pure01' | 'mixed' | 'unknown';

export interface CompositionVerdict {
  composition: Composition;
  /** Slots that are not 01, with their verdict (for the details panel). */
  nonZeroOne: { schid: string; division: number | null; subtitle: string | null; verdict: FamilyVerdict }[];
}

export function seasonComposition(slots: readonly SlotEvidence[], divisions: readonly number[]): CompositionVerdict {
  const inForce = new Map<string, SlotEvidence>();
  const scopes = divisions.length > 0 ? divisions : [null];
  for (const division of scopes) for (const slot of effectiveSlots(slots, division)) inForce.set(`${slot.division ?? 'base'}:${slot.schid}`, slot);
  const nonZeroOne: CompositionVerdict['nonZeroOne'] = [];
  let composition: Composition = 'pure01';
  for (const slot of inForce.values()) {
    const verdict = slotFamily(slot);
    if (verdict.family === '01') continue;
    nonZeroOne.push({ schid: slot.schid, division: slot.division, subtitle: slot.subtitle, verdict });
    if (verdict.family === 'unknown') composition = 'unknown';
    else if (composition === 'pure01') composition = 'mixed';
  }
  if (inForce.size === 0) composition = 'unknown';
  return { composition, nonZeroOne };
}

export const FAMILY_LABEL: Record<GameFamily, string> = { '01': '01', cricket: 'Cricket', unknown: '種別不明' };
export const ROLE_LABEL: Record<GameRole, string> = {
  singles: 'シングルス',
  doubles: 'ダブルス',
  trios: 'トリオス',
  gallon: 'ガロン',
  team: 'チーム戦（4人以上）',
  unknown: '分類不能',
};
