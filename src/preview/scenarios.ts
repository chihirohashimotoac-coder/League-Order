import type { GameSlotDef, OrderInput, Player } from '../domain/types';
import type { OpponentContext, OpponentGameContext, OpponentSideMember } from '../domain/prediction/opponentContext';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import { finishPrior } from '../domain/prediction/finishing';
import { DEFAULT_OPTIMIZER_SETTINGS, PRESETS } from '../domain/orders/presets';
import { createParticipantConfig } from '../domain/orders/participants';

/**
 * Preview scenarios (non-production test page only, docs/THROW_ORDER_MODEL.md §10).
 *
 * Synthetic, fictional data that makes each behaviour of the throw-order model and the underdog
 * plan visible in the real result screen: the numbers are produced by the real engine, the inputs
 * are invented. Nothing here is a real team, player or league, and none of it is real-world
 * evidence of better results.
 */

export interface PreviewScenario {
  id: string;
  title: string;
  summary: string;
  input: OrderInput;
}

const TEAM = 'preview_team';

function person(id: string, name: string, ppr: number, skills: Player['skills'] = {}): Player {
  return {
    id,
    teamId: TEAM,
    name,
    rating: null,
    ppr,
    skills,
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: 0,
  };
}

function ours(strength: number, first9Excess: number | null = null) {
  return { strength, confidence: 'HIGH' as const, legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess };
}

function context(
  players: OpponentContext['players'],
  games: Record<string, Partial<OpponentGameContext> & Pick<OpponentGameContext, 'sides' | 'numPart'>>,
  confidence: 'HIGH' | 'MEDIUM' = 'HIGH',
  opponentName = '架空チーム B',
): OpponentContext {
  return {
    version: 2,
    generatedAt: 0,
    matchId: 'preview',
    matchDate: '2026-10-20',
    opponentName,
    leagueMeanPpr: 52,
    players,
    games: Object.fromEntries(
      Object.entries(games).map(([gameId, game]) => [
        gameId,
        { gameId, signature: gameId, legsToWin: 2, cricket: false, likely: [], samples: 8, confidence, ...game } as OpponentGameContext,
      ]),
    ),
    orderConfidence: confidence,
    confidence,
    discipline: 'STEEL',
  };
}

function input(players: Player[], games: GameSlotDef[], opponent: OpponentContext | null, preset: OrderInput['preset'] = 'OPPONENT_OPTIMIZED'): OrderInput {
  return {
    teamId: TEAM,
    formatId: 'preview_format',
    games,
    players,
    participants: players.map((player) => createParticipantConfig(player.id)),
    pairs: [],
    locks: [],
    preset,
    weights: preset === 'CUSTOM' ? PRESETS.BALANCED.weights : { ...PRESETS[preset].weights },
    settings: { ...DEFAULT_OPTIMIZER_SETTINGS },
    discipline: 'STEEL',
    ...(opponent ? { opponent } : {}),
    throwOrderModel: THROW_ORDER_MODEL_VERSION,
  };
}

const side = (members: OpponentSideMember[], probability = 1) => ({
  strength: members.reduce((acc, m) => acc + m.strength, 0) / members.length,
  probability,
  members,
});

const trios: GameSlotDef = {
  id: 'tr',
  order: 1,
  name: 'Trios 701',
  kinds: ['TRIOS', 'G501'],
  playerCount: 3,
  n01: { schid: 'tr', numPart: 3, matchType: '01', startScore: 701, limitLegCount: 3, group: null, subtitle: null },
};

function trioScenario(reverseOpponent: boolean): OrderInput {
  const players = [person('p1', '赤井 (エース)', 65), person('p2', '青木', 55), person('p3', '黄田 (スコアラー)', 60)];
  const opponent = [
    { strength: 65, finish: 0.7 },
    { strength: 51, finish: 0.1261 },
    { strength: 62, finish: 0.2737 },
  ];
  const ordered = reverseOpponent ? [...opponent].reverse() : opponent;
  return input(
    players,
    [trios],
    context(
      { p1: ours(65, -3), p2: ours(55, -7), p3: ours(60, 14) },
      {
        tr: {
          numPart: 3,
          legsToWin: 3,
          startScore: 701,
          likely: [{ name: '架空 選手X', probability: 0.8 }],
          order: { known: true, confidence: 'HIGH', samples: 8, leaders: [{ name: reverseOpponent ? '架空 選手Z' : '架空 選手X', probability: 0.8 }] },
          sides: [side(ordered)],
        },
      },
    ),
  );
}

function shortageScenario(): OrderInput {
  const players = [person('q1', '緑川 (Singles型)', 52), person('q2', '白石 (Doubles型)', 50, { DOUBLES: 5 }), person('q3', '黒沢', 47)];
  const games: GameSlotDef[] = [
    { id: 's1', order: 1, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'd1', order: 2, name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  ];
  // No opponent data at all: the order is the strong order by role strength (aptitude included).
  return input(players, games, null, 'WIN_FIRST');
}

const SINGLES = [1, 2, 3, 4].map(
  (n): GameSlotDef => ({ id: `s${n}`, order: n, name: `Singles ${n}`, kinds: ['SINGLES', 'G501'], playerCount: 1 }),
);
const DOUBLES: GameSlotDef = {
  id: 'd1',
  order: 5,
  name: 'Doubles 501',
  kinds: ['DOUBLES', 'G501'],
  playerCount: 2,
  n01: { schid: 'd1', numPart: 2, matchType: '01', startScore: 501, limitLegCount: 2, group: null, subtitle: null },
};

function underdogScenario(): OrderInput {
  const strengths = [58, 50, 46, 44, 42];
  const names = ['桃井', '紺野', '茶谷', '灰原', '銀田'];
  const players = strengths.map((strength, index) => person(`u${index + 1}`, names[index], strength));
  const opp: Record<string, number> = { s1: 70, s2: 68, s3: 66, s4: 50, d1: 66 };
  return input(
    players,
    [...SINGLES, DOUBLES],
    context(
      Object.fromEntries(players.map((player, index) => [player.id, ours(strengths[index])])),
      Object.fromEntries(
        [...SINGLES, DOUBLES].map((game) => [
          game.id,
          game.playerCount === 1
            ? { numPart: 1, sides: [{ strength: opp[game.id], probability: 1 }], likely: [{ name: `架空 選手${game.order}`, probability: 0.75 }] }
            : {
                numPart: 2,
                startScore: 501,
                order: { known: true, confidence: 'MEDIUM' as const, samples: 6, leaders: [{ name: '架空 選手1', probability: 0.7 }] },
                sides: [side([0, 1].map(() => ({ strength: opp[game.id], finish: finishPrior(opp[game.id]) })))],
              },
        ]),
      ),
      'MEDIUM',
      '架空の強豪チーム',
    ),
  );
}

function aceScenario(): OrderInput {
  const players = [person('a1', '金子 (エース)', 62), person('a2', '銅島', 49), person('a3', '鉄本', 48)];
  const games = SINGLES.slice(0, 3);
  const base = input(
    players,
    games,
    context(
      { a1: ours(62), a2: ours(49), a3: ours(48) },
      {
        s1: { numPart: 1, sides: [{ strength: 72, probability: 1 }], likely: [{ name: '架空 エース', probability: 0.85 }] },
        s2: { numPart: 1, sides: [{ strength: 55, probability: 1 }], likely: [{ name: '架空 選手2', probability: 0.6 }] },
        s3: { numPart: 1, sides: [{ strength: 54, probability: 1 }], likely: [{ name: '架空 選手3', probability: 0.6 }] },
      },
    ),
  );
  // One Singles each, as a captain would set it for three players and three Singles.
  return { ...base, participants: base.participants.map((config) => ({ ...config, minAppearances: 1, maxAppearances: 1 })) };
}

export function previewScenarios(): PreviewScenario[] {
  return [
    {
      id: 'model-order',
      title: 'A. 推定で投順を変更 (Trios)',
      summary:
        'フィニッシュ根拠 (First9 由来・60 レッグ) が大きく異なる 3 人と、投順が分かっている相手。強い順より推定ゲーム勝率が 2pt 以上高く、信頼度 高・相手投順既知・安定性チェック通過のため、別の投順を採用します。',
      input: trioScenario(true),
    },
    {
      id: 'strong-order',
      title: 'B. 同じメンバー・相手の投順違い → 強い順',
      summary: 'A と同じ 3 人。相手の投順だけが違い、推定でも強い順が最善のため、基本どおり強い選手が 1 投目です。',
      input: trioScenario(false),
    },
    {
      id: 'shortage',
      title: 'C. データ不足 → 役割別強度の高い順',
      summary: '相手データなし (勝利優先)。Doubles 適性 5 の選手は Doubles でだけ強く評価され、そのゲームの 1 投目になります。内部 ID 順は使いません。',
      input: shortageScenario(),
    },
    {
      id: 'underdog',
      title: 'D. 格上対策の 1 タップ提案',
      summary: '標準案の推定 Match 勝率が 20% 以下・相手データ 中・相手が格上。「格上対策案を試す」で 1 案だけに切り替わり、「標準案に戻す」で戻せます。',
      input: underdogScenario(),
    },
    {
      id: 'ace',
      title: 'E. Singles: 相手エース枠の受け方',
      summary: '相手エース枠に自軍エースを必ず当てる固定ルールはありません。Match 全体の推定勝率で配置し、エースを当てた場合との比較を表示します。',
      input: aceScenario(),
    },
  ];
}
