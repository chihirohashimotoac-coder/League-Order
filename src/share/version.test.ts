import { describe, expect, it } from 'vitest';
import {
  buildShareLayout,
  renderShareText,
  renderUpdateText,
  shareableFromVersion,
  versionInfoOf,
  versionText,
} from './index';
import { createVersion, diffVersions } from '../domain/orders/lifecycle';
import { generateOrder } from '../optimizer/generateOrder';
import { orderInput, sampleFormatGames, sampleRoster } from '../test/factories';
import type { MatchInfo, OrderSolution, OrderVersion } from '../domain/types';

const MATCH: MatchInfo = {
  leagueName: '',
  teamName: 'kalavinka',
  opponentName: 'Team B',
  matchDate: '2026-10-08',
};

function fixture() {
  const roster = sampleRoster();
  const games = sampleFormatGames();
  const input = orderInput(roster, games);
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return { roster, games, input, solution: result.candidates[0] };
}

/** v1, then a v2 in which game 1 is handed to p5. */
function twoVersions(): { v1: OrderVersion; v2: OrderVersion; changedSolution: OrderSolution } {
  const { input, solution } = fixture();
  const v1 = createVersion(input, solution, MATCH, [], 1000);
  const changedSolution: OrderSolution = {
    ...solution,
    assignments: solution.assignments.map((entry, index) =>
      index === 0 ? { ...entry, playerIds: ['p5'] } : entry,
    ),
  };
  const v2 = createVersion(input, changedSolution, MATCH, [v1], 2000);
  return { v1, v2, changedSolution };
}

describe('versionText (追加要件 §6, §7)', () => {
  it('labels the first finalization', () => {
    expect(versionText({ version: 1, isUpdate: false, draft: false })).toBe('ORDER v1');
  });

  it('marks a re-finalization as an update', () => {
    expect(versionText({ version: 2, isUpdate: true, draft: false })).toBe('ORDER v2 · 更新版');
  });

  it('marks a draft explicitly', () => {
    expect(versionText({ version: 0, isUpdate: false, draft: true })).toBe('未確定 (DRAFT)');
  });

  it('is empty when no version info is supplied', () => {
    expect(versionText(undefined)).toBe('');
  });
});

describe('version in the shared image layout', () => {
  it('carries the version badge in the header', () => {
    const { games, roster, solution } = fixture();
    const layout = buildShareLayout(games, roster, solution, MATCH, 'compact', {
      version: 1,
      isUpdate: false,
      draft: false,
    });
    expect(layout.header.versionText).toBe('ORDER v1');
  });

  it('shows the draft marker for an unconfirmed order', () => {
    const { games, roster, solution } = fixture();
    const layout = buildShareLayout(games, roster, solution, MATCH, 'compact', {
      version: 0,
      isUpdate: false,
      draft: true,
    });
    expect(layout.header.versionText).toContain('未確定');
  });

  it('still carries no optimisation score alongside the version', () => {
    const { games, roster, solution } = fixture();
    const layout = buildShareLayout(games, roster, solution, MATCH, 'detail', {
      version: 2,
      isUpdate: true,
      draft: false,
    });
    const serialised = JSON.stringify(layout);
    for (const forbidden of ['総合', '戦力', '公平性', 'Score']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('version in the shared text (追加要件 §16 Sharing)', () => {
  it('shows v1 for the first version and v2 for the second', () => {
    const { v1, v2 } = twoVersions();

    const text1 = renderShareText(
      v1.games,
      v1.players,
      shareableFromVersion(v1),
      v1.match,
      'line',
      { version: versionInfoOf(v1) },
    );
    expect(text1).toContain('ORDER v1');
    expect(text1).not.toContain('v2');

    const text2 = renderShareText(
      v2.games,
      v2.players,
      shareableFromVersion(v2),
      v2.match,
      'line',
      { version: versionInfoOf(v2) },
    );
    expect(text2).toContain('ORDER v2 · 更新版');
  });

  it('puts the version on every text format', () => {
    const { v1 } = twoVersions();
    for (const format of ['line', 'simple', 'detail'] as const) {
      const text = renderShareText(v1.games, v1.players, shareableFromVersion(v1), v1.match, format, {
        version: versionInfoOf(v1),
      });
      expect(text).toContain('ORDER v1');
    }
  });

  it('warns in the text itself when the order is not finalized', () => {
    const { games, roster, solution } = fixture();
    const text = renderShareText(games, roster, solution, MATCH, 'line', {
      version: { version: 0, isUpdate: false, draft: true },
    });
    expect(text).toContain('未確定');
  });
});

describe('update text (追加要件 §10)', () => {
  it('leads with the change and names the new version', () => {
    const { v1, v2 } = twoVersions();
    const diff = diffVersions(v1, v2);
    const text = renderUpdateText(
      v2.games,
      v2.players,
      shareableFromVersion(v2),
      v2.match,
      diff,
      versionInfoOf(v2),
      { includeFullOrder: false },
    );

    expect(text.split('\n')[0]).toBe('🎯 オーダー変更 v2');
    expect(text).toContain('変更：');
    expect(text).toContain('↓');
    // Shows the game that changed, with before and after.
    const changed = diff.changes[0];
    expect(text).toContain(`G${changed.order} ${changed.gameName}`);
    expect(text).toContain(changed.beforeNames.join(' / '));
    expect(text).toContain(changed.afterNames.join(' / '));
    // The diff-only form omits the full listing.
    expect(text).not.toContain('【最新オーダー】');
  });

  it('can append the full current order', () => {
    const { v1, v2 } = twoVersions();
    const diff = diffVersions(v1, v2);
    const text = renderUpdateText(
      v2.games,
      v2.players,
      shareableFromVersion(v2),
      v2.match,
      diff,
      versionInfoOf(v2),
      { includeFullOrder: true },
    );
    expect(text).toContain('【最新オーダー】');
    for (const game of v2.games) expect(text).toContain(`G${game.order} ${game.name}`);
  });

  it('is reachable through renderShareText with both update formats', () => {
    const { v1, v2 } = twoVersions();
    const diff = diffVersions(v1, v2);
    const context = { diff, version: versionInfoOf(v2) };

    const diffOnly = renderShareText(v2.games, v2.players, shareableFromVersion(v2), v2.match, 'updateDiff', context);
    const full = renderShareText(v2.games, v2.players, shareableFromVersion(v2), v2.match, 'updateFull', context);

    expect(diffOnly).toContain('オーダー変更 v2');
    expect(diffOnly).not.toContain('【最新オーダー】');
    expect(full).toContain('【最新オーダー】');
  });

  it('falls back to the ordinary message when there is nothing to diff', () => {
    const { games, roster, solution } = fixture();
    const text = renderShareText(games, roster, solution, MATCH, 'updateDiff', {});
    expect(text).not.toContain('オーダー変更');
    expect(text).toContain('🎯');
  });

  it('says so when the versions are identical', () => {
    const { v1 } = twoVersions();
    const diff = diffVersions(v1, v1);
    const text = renderUpdateText(
      v1.games,
      v1.players,
      shareableFromVersion(v1),
      v1.match,
      diff,
      versionInfoOf(v1),
      { includeFullOrder: false },
    );
    expect(text).toContain('変更はありません');
  });
});

describe('sharing a frozen version (追加要件 §5)', () => {
  it('renders the names the version was finalized with, not the current ones', () => {
    const { input, solution } = fixture();
    const v1 = createVersion(input, solution, MATCH, [], 1000);

    // The live roster is renamed afterwards.
    input.players[0].name = '改名後';

    const text = renderShareText(
      v1.games,
      v1.players,
      shareableFromVersion(v1),
      v1.match,
      'line',
      { version: versionInfoOf(v1) },
    );
    expect(text).toContain('Aoki');
    expect(text).not.toContain('改名後');
  });
});
