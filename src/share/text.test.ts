import { describe, expect, it } from 'vitest';
import {
  renderAllPlayersText,
  renderDetailText,
  renderLineText,
  renderPlayerText,
  renderShareText,
  renderSimpleText,
} from './text';
import { buildPlayerSchedules } from './layout';
import { generateOrder } from '../optimizer/generateOrder';
import { games, orderInput, player, sampleFormatGames } from '../test/factories';
import type { GameSlotDef, MatchInfo, OrderSolution, Player, SkillLevel } from '../domain/types';
import { createMatchInfo } from '../domain/types';

function solutionFor(roster: Player[], gameDefs: GameSlotDef[]): OrderSolution {
  const result = generateOrder(orderInput(roster, gameDefs));
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return result.candidates[0];
}

const fullMatch: MatchInfo = {
  leagueName: '',
  teamName: 'kalavinka',
  opponentName: 'Team B',
  matchDate: '2026-10-08',
};

/** The §13 roster: Japanese names, one very long name, mixed ratings. */
function jpRoster(): Player[] {
  return [
    player({ id: 'p1', name: 'シンタロー', rating: 14, skills: { SINGLES: 5, G501: 5 } }),
    player({ id: 'p2', name: 'ちひろ', rating: 14, skills: { CRICKET: 5, DOUBLES: 5 } }),
    player({ id: 'p3', name: 'かいり', rating: 11 }),
    player({ id: 'p4', name: 'おたぬ', rating: 8 }),
    player({ id: 'p5', name: 'ながいなまえのせんしゅさん', rating: 4 }),
  ];
}

describe('renderLineText (要件 §6)', () => {
  const roster = jpRoster();
  const gameDefs = sampleFormatGames();
  const solution = solutionFor(roster, gameDefs);

  it('starts with one emoji, the short date and the matchup', () => {
    const text = renderLineText(gameDefs, roster, solution, fullMatch);
    const lines = text.split('\n');
    expect(lines[0]).toBe('🎯 10/8 DARTS LEAGUE');
    expect(lines[1]).toBe('kalavinka vs Team B');
    // Exactly one emoji: decoration stays minimal.
    expect(text.match(/🎯/g)).toHaveLength(1);
  });

  it('puts each game on its own labelled block with the players beneath', () => {
    const text = renderLineText(gameDefs, roster, solution, fullMatch);
    for (const game of gameDefs) expect(text).toContain(`G${game.order}｜${game.name}`);
    for (const p of roster) expect(text).toContain(p.name);
  });

  it('uses the league name when one is set', () => {
    const text = renderLineText(gameDefs, roster, solution, { ...fullMatch, leagueName: '秋季リーグ' });
    expect(text.split('\n')[0]).toBe('🎯 10/8 秋季リーグ');
  });

  it('omits the opponent and the date cleanly when they are not set', () => {
    const text = renderLineText(gameDefs, roster, solution, createMatchInfo('kalavinka'));
    const lines = text.split('\n');
    expect(lines[0]).toBe('🎯 DARTS LEAGUE');
    expect(lines[1]).toBe('kalavinka');
    expect(text).not.toContain('vs');
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('never contains optimisation scores (要件 §4)', () => {
    const text = renderLineText(gameDefs, roster, solution, fullMatch);
    for (const forbidden of ['総合', '戦力', '公平性', '評価', 'Score']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('renderSimpleText', () => {
  it('uses one line per game and no emoji', () => {
    const roster = jpRoster();
    const gameDefs = sampleFormatGames();
    const text = renderSimpleText(gameDefs, roster, solutionFor(roster, gameDefs), fullMatch);

    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).toContain('2026/10/08 DARTS LEAGUE');
    const gameLines = text.split('\n').filter((line) => /^G\d+ /.test(line));
    expect(gameLines).toHaveLength(gameDefs.length);
    expect(gameLines[0]).toMatch(/^G1 Singles 501 : /);
  });
});

describe('renderDetailText', () => {
  const roster = jpRoster();
  const gameDefs = sampleFormatGames();
  const solution = solutionFor(roster, gameDefs);

  it('adds appearances, ratings and the order type', () => {
    const text = renderDetailText(gameDefs, roster, solution, fullMatch);
    expect(text).toContain('--- ORDER ---');
    expect(text).toContain('--- 出場回数 ---');
    expect(text).toContain('オーダータイプ');
    for (const p of roster) expect(text).toContain(p.name);
    expect(text).toMatch(/今回\d+回 \/ Season\d+回/);
  });

  it('still withholds the internal evaluation (要件 §4)', () => {
    const text = renderDetailText(gameDefs, roster, solution, fullMatch);
    for (const forbidden of ['総合', '戦力', '公平性', '最大出場差', 'ノード']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain(String(solution.score.display));
  });

  it('notes an imputed rating rather than printing a zero', () => {
    const withUnknown = jpRoster();
    withUnknown[2] = player({ id: 'p3', name: 'かいり', rating: null });
    const text = renderDetailText(gameDefs, withUnknown, solutionFor(withUnknown, gameDefs), fullMatch);
    expect(text).toContain('中央値');
    expect(text).not.toContain('R0 ');
  });
});

describe('renderShareText dispatch', () => {
  it('returns the matching variant for each format', () => {
    const roster = jpRoster();
    const gameDefs = sampleFormatGames();
    const solution = solutionFor(roster, gameDefs);
    expect(renderShareText(gameDefs, roster, solution, fullMatch, 'line')).toContain('🎯');
    expect(renderShareText(gameDefs, roster, solution, fullMatch, 'simple')).not.toContain('🎯');
    expect(renderShareText(gameDefs, roster, solution, fullMatch, 'detail')).toContain('--- ORDER ---');
  });
});

describe('player view text (要件 §5)', () => {
  const roster = jpRoster();
  const gameDefs = sampleFormatGames();
  const solution = solutionFor(roster, gameDefs);

  it('lists one player’s games and their partners', () => {
    const schedules = buildPlayerSchedules(gameDefs, roster, solution);
    const target = schedules.find((schedule) => schedule.entries.some((entry) => entry.partners.length > 0))!;
    const text = renderPlayerText(target, fullMatch);

    expect(text).toContain(target.name);
    for (const entry of target.entries) {
      expect(text).toContain(entry.no);
      expect(text).toContain(entry.gameName);
      if (entry.partners.length > 0) expect(text).toContain(`Partner: ${entry.partners.join(' / ')}`);
    }
    // A player's own name must not be listed as their own partner.
    expect(text).not.toContain(`Partner: ${target.name}`);
  });

  it('says so when a player is not fielded', () => {
    const shortFormat = games([{ id: 'g1', name: 'S1', kinds: ['SINGLES'], playerCount: 1 }]);
    const shortSolution = solutionFor(roster, shortFormat);
    const schedules = buildPlayerSchedules(shortFormat, roster, shortSolution);
    const benched = schedules.find((schedule) => schedule.entries.length === 0)!;
    expect(renderPlayerText(benched, fullMatch)).toContain('出場なし');
  });

  it('renders every player in one message', () => {
    const text = renderAllPlayersText(gameDefs, roster, solution, fullMatch);
    for (const p of roster) expect(text).toContain(`■ ${p.name}`);
  });
});

describe('§13 coverage: shapes, languages and sizes', () => {
  const roster = jpRoster();

  it('handles a singles-only format', () => {
    const gameDefs = games(
      Array.from({ length: 5 }, (_, index) => ({
        id: `g${index + 1}`,
        name: `Singles ${index + 1}`,
        kinds: ['SINGLES' as const, 'G501' as const],
        playerCount: 1,
      })),
    );
    const text = renderLineText(gameDefs, roster, solutionFor(roster, gameDefs), fullMatch);
    expect(text).not.toContain(' / ');
    expect(text.split('\n').filter((line) => line.startsWith('G'))).toHaveLength(5);
  });

  it('handles doubles and trios', () => {
    const gameDefs = games([
      { id: 'g1', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: 'g2', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
    ]);
    const text = renderSimpleText(gameDefs, roster, solutionFor(roster, gameDefs), fullMatch);
    expect(text.split('\n').find((line) => line.startsWith('G1'))!.split(' / ')).toHaveLength(2);
    expect(text.split('\n').find((line) => line.startsWith('G2'))!.split(' / ')).toHaveLength(3);
  });

  it('keeps long Japanese player and team names intact', () => {
    const gameDefs = sampleFormatGames();
    const longMatch: MatchInfo = {
      leagueName: '関東ソフトダーツ秋季リーグ ディビジョン2',
      teamName: 'とてもながいチームめいのダーツチーム',
      opponentName: 'あいてチームのながいなまえ',
      matchDate: '2026-10-08',
    };
    const text = renderLineText(gameDefs, roster, solutionFor(roster, gameDefs), longMatch);
    expect(text).toContain('ながいなまえのせんしゅさん');
    expect(text).toContain('とてもながいチームめいのダーツチーム vs あいてチームのながいなまえ');
    expect(text).toContain('関東ソフトダーツ秋季リーグ ディビジョン2');
  });

  it('handles a long order with many games', () => {
    const many = games(
      Array.from({ length: 18 }, (_, index) => ({
        id: `g${index + 1}`,
        name: index % 2 === 0 ? `Singles ${index + 1}` : `Doubles ${index + 1}`,
        kinds: (index % 2 === 0 ? ['SINGLES', 'G501'] : ['DOUBLES', 'CRICKET']) as never,
        playerCount: index % 2 === 0 ? 1 : 2,
      })),
    );
    const bigRoster = Array.from({ length: 9 }, (_, index) =>
      player({
        id: `p${index + 1}`,
        name: `せんしゅ${index + 1}`,
        rating: 4 + index,
        skills: { SINGLES: (((index % 5) + 1) as SkillLevel) },
      }),
    );
    const text = renderLineText(many, bigRoster, solutionFor(bigRoster, many), fullMatch);
    expect(text.split('\n').filter((line) => line.includes('｜'))).toHaveLength(18);
    expect(text).toContain('G18｜');
  });

  it('works with no ratings at all', () => {
    const unrated = jpRoster().map((entry) => player({ id: entry.id, name: entry.name }));
    const gameDefs = sampleFormatGames();
    const text = renderDetailText(gameDefs, unrated, solutionFor(unrated, gameDefs), fullMatch);
    expect(text).toContain('Rt.—');
    expect(text).not.toContain('R0');
  });
});
