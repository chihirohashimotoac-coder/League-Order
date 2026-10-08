import type { Player, PlayerId, PlayerSkills, Ppr, Rating, TeamId } from '../types';

/**
 * New players that are entered by hand (F06, F07).
 *
 * Two kinds, deliberately different in what they are:
 *
 * - **A member added for next time** (`newMember`) is an ordinary roster player from the
 *   moment they are added, whether or not n01 knows them yet. They are offered for every
 *   order and counted in the season. If a PPR is typed it is kept as the player's chosen
 *   PPR (`pprSource: 'manual'`), also after n01 starts listing them.
 * - **A guest** (`newGuest`) plays one order. They get an id of their own and a `guest`
 *   flag; they are put in that order's players and participants and nowhere else, so they
 *   are never offered again and never counted in the season. Their id is never n01's
 *   shared 助っ人 label.
 *
 * Rating and PPR are optional on both: a blank is Unknown (`null`), rated at the median of
 * the participants and with low confidence — never as 0.
 */
export interface NewPlayerFields {
  name: string;
  rating: Rating;
  ppr: Ppr;
  skills: PlayerSkills;
  note?: string;
}

function build(teamId: TeamId, id: PlayerId, fields: NewPlayerFields, now: number): Player {
  return {
    id,
    teamId,
    name: fields.name.trim(),
    rating: fields.rating,
    ppr: fields.ppr,
    skills: { ...fields.skills },
    ...(fields.note?.trim() ? { note: fields.note.trim() } : {}),
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: now,
  };
}

export function newMember(teamId: TeamId, id: PlayerId, fields: NewPlayerFields, now: number): Player {
  const player = build(teamId, id, fields, now);
  return player.ppr === null ? player : { ...player, pprSource: 'manual' };
}

/**
 * A member entered through a form that filled the PPR in later than `newMember` was
 * called: a typed PPR is the player's chosen PPR (so it stays so once n01 lists them).
 */
export function finalizeMember(player: Player): Player {
  return player.ppr === null || player.pprSource !== undefined ? player : { ...player, pprSource: 'manual' };
}

export function newGuest(teamId: TeamId, id: PlayerId, fields: NewPlayerFields, now: number): Player {
  return { ...build(teamId, id, fields, now), guest: true };
}

export function isGuest(player: Pick<Player, 'guest'>): boolean {
  return player.guest === true;
}

/** The guests among a list of players, in order. */
export function guestsOf(players: readonly Player[]): Player[] {
  return players.filter(isGuest);
}
