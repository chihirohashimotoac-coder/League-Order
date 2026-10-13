import { describe, expect, it } from 'vitest';
import { parseSlotEvidence } from './api/parse';
import { seasonComposition, slotFamily, slotFor } from './gameKind';
import { projectSeasons } from './projection';
import { checkPlayerSeason, reconstructGame, addVerified, bestLegsByStart } from './reconstruct';
import type { GameReconstruction, PlayerContributions } from './reconstruct';
import { classifyGames, linesFromGames } from './roleGames';
import { details2026, drizzumGamesWithDetails, OFFICIAL_2026_3RD, TDID_2026_3RD, drizzumGames, OFFICIAL_WPZB_2026_3RD, desperadoGames, details, OFFICIAL_2024_2ND, RAW_2024_2ND, RAW_2026_3RD, season2024Data, TDID_2024_2ND, withDetailSides } from './realData.roles.fixtures';

/**
 * The role analytics against real n01 data (ATDO, read 2026-10-13; see the fixtures file).
 * These are the checks that decided the design: what n01's season counters contain in a
 * Cricket-mixed season, and which throwing-order rule reproduces n01's own player totals.
 */

const slots2024 = parseSlotEvidence(RAW_2024_2ND);
const slots2026 = parseSlotEvidence(RAW_2026_3RD);

const season2024 = season2024Data;

function rebuilt(): Map<string, GameReconstruction> {
  return new Map(details().map((d) => [d.gameId, reconstructGame(d)]));
}

describe('real data: kind of game (2024 2nd has no match_type at all)', () => {
  it('reads the slots without inventing a type; "クリケット" + start 0 is Cricket, the rest is 01 by start score', () => {
    expect(slots2024.every((s) => s.matchType === null)).toBe(true);
    const cricket = slots2024.find((s) => s.schid === '8kxb')!;
    expect(slotFamily(cricket)).toEqual({ family: 'cricket', basis: 'start-score+name' });
    expect(slotFamily(slots2024.find((s) => s.schid === 'kwcg')!)).toEqual({ family: '01', basis: 'start-score' });
    expect(seasonComposition(slots2024, [0, 1]).composition).toBe('mixed');
  });

  it('2026 3rd: explicit 01 everywhere, and division 0 plays its own slots (best of 5 singles)', () => {
    expect(seasonComposition(slots2026, [0, 1, 2]).composition).toBe('pure01');
    expect(slotFor(slots2026, 'hvv5', 0)).toMatchObject({ division: 0, limitLegCount: 3, numPart: 1 });
    expect(slotFor(slots2026, 'fepq', 1)).toMatchObject({ division: null, limitLegCount: 2 });
    // An override schid is not looked up in another division.
    expect(slotFor(slots2026, 'hvv5', 1)).toBeNull();
  });

  it('classifies the 48 recorded games: 32 singles, 8 doubles, 8 team (4 players, 1001); none of them Cricket', () => {
    const games = classifyGames({ slots: slots2024 }, desperadoGames());
    expect(games.filter((g) => g.family.family === '01')).toHaveLength(48);
    expect(games.every((g) => g.family.basis === 'match-default')).toBe(true);
    expect(games.filter((g) => g.role === 'singles')).toHaveLength(32);
    expect(games.filter((g) => g.role === 'doubles')).toHaveLength(8);
    expect(games.filter((g) => g.role === 'team')).toHaveLength(8);
    expect(games.find((g) => g.role === 'team')!.startScore).toBe(1001);
  });
});

describe('real data: an all-01 season with a division override (2026 3rd, division A)', () => {
  it('games are read under the division\'s own slots (best-of-5 singles), and every counter equals n01\'s', () => {
    const games = classifyGames({ slots: slots2026 }, drizzumGames());
    expect(games.every((g) => g.division === 0 && g.family.family === '01' && g.family.basis === 'explicit')).toBe(true);
    expect(games.filter((g) => g.role === 'singles')).toHaveLength(8);
    expect(games.filter((g) => g.role === 'doubles')).toHaveLength(4);
    expect(games.filter((g) => g.role === 'team')).toHaveLength(2);
    const team = linesFromGames(games, 'all01').teams.get('WpZb')!;
    const o = OFFICIAL_WPZB_2026_3RD;
    // No Cricket: legs and sets agree too (and a best-of-5 singles game is 3–5 legs).
    expect([team.score, team.darts, team.leg, team.winLeg, team.set, team.winSet]).toEqual([o.score, o.darts, o.leg, o.winLeg, o.set, o.winSet]);
  });
});

describe('real data: the attribution rule in a recent all-01 season (2026 3rd)', () => {
  const games = () => classifyGames({ slots: slots2026 }, drizzumGamesWithDetails());
  const r = () => new Map(details2026().map((d) => [d.gameId, reconstructGame(d)]));

  it('灰田 裕一郎 (one doubles game): every field — 3DA, First 9, ton, High Finish and Break — equals n01\'s', () => {
    const check = checkPlayerSeason(TDID_2026_3RD, 'o3ul', OFFICIAL_2026_3RD.o3ul, games(), r(), true);
    expect(check.compared).toMatchObject({ score: [473, 473], darts: [26, 26], f9Score: [96, 96], f9Darts: [6, 6] });
    expect(check.state).toBe('verified');
    expect(check.verified).toEqual({ score: true, f9: true, tons: true, highOut: true, break: true });
  });

  it('柴田 圭介 (singles row + 3rd thrower of the team game) equals n01\'s score / darts', () => {
    const check = checkPlayerSeason(TDID_2026_3RD, '3oun', OFFICIAL_2026_3RD['3oun'], games(), r(), true);
    expect(check.compared).toMatchObject({ score: [2117, 2117], darts: [99, 99] });
    expect(check.verified.score).toBe(true);
  });

  it('n01\'s Best Leg ignores doubles legs (灰田: 2 legs won as a pair, Best Leg "none")', () => {
    expect(OFFICIAL_2026_3RD.o3ul.bestLeg).toBeNull();
    expect(bestLegsByStart('o3ul', games(), r()).size).toBe(0);
  });
});

describe('real data: what n01 season counters contain in a Cricket-mixed season', () => {
  it('score / darts are exactly the 01 games; legs and sets include the Cricket games entered without a record', () => {
    const lines = linesFromGames(classifyGames({ slots: slots2024 }, desperadoGames()), 'all01');
    const team = lines.teams.get('pzDR')!;
    expect([team.score, team.darts]).toEqual([OFFICIAL_2024_2ND.pzDR.score, OFFICIAL_2024_2ND.pzDR.darts]); // 48844 / 3559
    expect([team.leg, team.winLeg, team.set, team.winSet]).toEqual([102, 44, 48, 21]);
    // n01: 120 legs, 50 won, 56 sets, 23 won → +18 / +6 / +8 (one Cricket game per match) / +2.
    expect(OFFICIAL_2024_2ND.pzDR.leg! - team.leg!).toBe(18);
    expect(OFFICIAL_2024_2ND.pzDR.set! - team.set!).toBe(8);
  });

  it('a player who played 01 singles and Cricket: n01 score/darts/First 9/ton/High Finish/Best Leg are 01-only, legs are not', () => {
    const r = rebuilt();
    const g1 = r.get('ddPShVZI_1720702983621');
    const g2 = r.get('wcDQJSji_1721911865826');
    if (!g1?.ok || !g2?.ok) throw new Error('reconstruction failed');
    const a = g1.perPlayer['6s5w'];
    const b = g2.perPlayer['6s5w'];
    const o = OFFICIAL_2024_2ND['6s5w'];
    expect([a.score + b.score, a.darts + b.darts]).toEqual([o.score, o.darts]);
    expect([a.f9Score + b.f9Score, a.f9Darts + b.f9Darts]).toEqual([o.f9Score, o.f9Darts]); // 732 / 36
    expect([a.ton00 + b.ton00, a.ton40 + b.ton40]).toEqual([o.ton00, o.ton40]); // exclusive bands: 134,118 | 140
    expect(Math.max(a.highOut ?? 0, b.highOut ?? 0)).toBe(o.highOut);
    expect(Math.min(a.bestLeg ?? 99, b.bestLeg ?? 99)).toBe(o.bestLeg);
    // n01's Break counters agree with the 01 legs here as well (2 opportunities, 1 won)...
    expect([a.breakLegs + b.breakLegs, a.breakWins + b.breakWins]).toEqual([o.breakLegs, o.breakWins]);
    // ...but legs: 4 legs of 01 against n01's 9 (5 Cricket legs).
    expect(o.leg).toBe(9);
  });

  it('projection of "01全体": n01 values kept where 01-only, legs/sets recounted, Keep/Break withheld', () => {
    const s = season2024();
    const projection = projectSeasons([s], 'all01', { games: new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games: desperadoGames(), dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]), failed: new Set() });
    const team = projection.seasons[0].teams.find((t) => t.teamId === 'pzDR')!.line!;
    expect(team).toMatchObject({ score: 48844, darts: 3559, f9Score: 12879, leg: 102, winLeg: 44, set: 48, winSet: 21, breakLegs: null, breakWins: null, ton00: 41 });
    const p = projection.seasons[0].players.find((x) => x.oid === '6s5w')!.line;
    expect(p).toMatchObject({ score: 1814, darts: 103, leg: 4, winLeg: 2, set: 2, winSet: 1 });
    const adoption = projection.adoption[0];
    expect(adoption.composition).toBe('mixed');
    expect(adoption.metrics.legSet.state).toBe('recomputed');
    expect(adoption.metrics.keepBreak.state).toBe('excluded');
    expect(adoption.metrics.ppr.state).toBe('official');
  });

  it('without the game rows the mixed season contributes no Leg/Set rate rather than the Cricket-inflated one', () => {
    const projection = projectSeasons([season2024()], 'all01', { games: new Map(), failed: new Set([TDID_2024_2ND]) });
    expect(projection.seasons[0].teams.find((t) => t.teamId === 'pzDR')!.line).toMatchObject({ score: 48844, leg: null, set: null });
    expect(projection.adoption[0].metrics.legSet.state).toBe('excluded');
  });
});

describe('real data: per-player figures of doubles and team games', () => {
  it('every leg detail adds up to the game row (score and darts, dummy 0 rows and checkouts included)', () => {
    for (const d of details()) expect(reconstructGame(d)).toMatchObject({ ok: true });
  });

  it('rotation restarting at order[0] each leg reproduces n01\'s totals: 和田 圭司 (3 doubles + 5 team games)', () => {
    const s = season2024();
    const games = classifyGames(s, withDetailSides(desperadoGames()));
    const check = checkPlayerSeason(TDID_2024_2ND, '63Cz', OFFICIAL_2024_2ND['63Cz'], games, rebuilt(), false);
    // 6 singles rows (5850 / 421, exact) + reconstructed 2448 / 214 = n01's 8298 / 635.
    expect(check.compared).toMatchObject({ score: [8298, 8298], darts: [635, 635] });
    expect(check.verified.score).toBe(true);
    // Singles legs were not fetched: First 9 / ton cannot be compared, and are not claimed.
    expect(check.verified.f9).toBe(false);
    expect(check.state).toBe('partly-verified');
  });

  it('阿部 証人: 1 singles row + the team game (3rd thrower: visits 3, 7, 11, 15, 19 = 220 points / 15 darts)', () => {
    const s = season2024();
    const games = classifyGames(s, withDetailSides(desperadoGames()));
    const r = rebuilt();
    const team = r.get('2knTgF17_1720695211940');
    expect(team?.ok && team.perPlayer.vhqF).toMatchObject({ score: 220, darts: 15 });
    const check = checkPlayerSeason(TDID_2024_2ND, 'vhqF', OFFICIAL_2024_2ND.vhqF, games, r, false);
    expect(check.verified.score).toBe(true);
  });

  it('a wrong throwing order is caught: swapping the pair in the doubles games breaks the checksum', () => {
    const s = season2024();
    const swapped = details().map((d) =>
      d.gameId === 'VU6AjbQE_1724326953016' || d.gameId === 'KbzMhPtz_1723116985252'
        ? { ...d, sides: d.sides.map((side) => ({ ...side, players: [...side.players].reverse() })) as typeof d.sides }
        : d,
    );
    const r = new Map(swapped.map((d) => [d.gameId, reconstructGame(d)]));
    const check = checkPlayerSeason(TDID_2024_2ND, '63Cz', OFFICIAL_2024_2ND['63Cz'], classifyGames(s, withDetailSides(desperadoGames())), r, false);
    expect(check.state).toBe('mismatch');
    expect(check.verified.score).toBe(false);
  });

  it('a player whose multi-thrower games were not all fetched is "incomplete", never estimated', () => {
    const s = season2024();
    const check = checkPlayerSeason(TDID_2024_2ND, 'MHv6', OFFICIAL_2024_2ND.MHv6, classifyGames(s, withDetailSides(desperadoGames())), rebuilt(), false);
    expect(check.state).toBe('incomplete');
  });

  it('the doubles view shows team 3DA from side totals, and a player\'s 3DA only after a verified reconstruction', () => {
    const s = season2024();
    const raw = withDetailSides(desperadoGames());
    const source = { games: new Map([[TDID_2024_2ND, { tournamentId: TDID_2024_2ND, games: raw, dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: true }]]), failed: new Set<string>() };
    const before = projectSeasons([s], 'doubles', source);
    const team = before.seasons[0].teams.find((t) => t.teamId === 'pzDR')!.line!;
    // 8 doubles games: Σ side score / darts (the team's own throws, counted once).
    expect([team.score, team.darts, team.set]).toEqual([1465 + 886 + 593 + 918 + 955 + 1002 + 908 + 588, 116 + 81 + 60 + 99 + 90 + 65 + 108 + 78, 8]);
    const wada = () => before.seasons[0].players.find((p) => p.oid === '63Cz')!.line;
    expect(wada().darts).toBeNull(); // not the pair's total
    expect(wada()).toMatchObject({ set: 3, leg: 2 + 3 + 2, winLeg: 1 }); // credited as a pair, like n01

    const contributions: PlayerContributions = new Map();
    const games = classifyGames(s, raw);
    const r = rebuilt();
    addVerified(contributions, checkPlayerSeason(TDID_2024_2ND, '63Cz', OFFICIAL_2024_2ND['63Cz'], games, r, false), games, r);
    const after = projectSeasons([s], 'doubles', source, contributions);
    const line = after.seasons[0].players.find((p) => p.oid === '63Cz')!.line;
    const own = ['IDnJ5lpQ_1726141072552', 'VU6AjbQE_1724326953016', 'KbzMhPtz_1723116985252'].map((id) => {
      const g = r.get(id);
      return g?.ok ? g.perPlayer['63Cz'] : null;
    });
    expect(line.score).toBe(own.reduce((sum, c) => sum + (c?.score ?? 0), 0));
    expect(line.darts).toBe(own.reduce((sum, c) => sum + (c?.darts ?? 0), 0));
    // The partner was not verified: still withheld.
    expect(after.seasons[0].players.find((p) => p.oid === 'g1vr')!.line.darts).toBeNull();
  });

  it('Best Leg is reported per start score from rebuilt singles legs (never mixing 501 and 1001)', () => {
    const s = season2024();
    const best = bestLegsByStart('6s5w', classifyGames(s, withDetailSides(desperadoGames())), rebuilt());
    expect([...best]).toEqual([[501, 26]]);
  });
});
