import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  createUndoable,
  lockedSlots,
  undoableReducer,
  UNDO_DEPTH,
  type UndoableState,
} from './orderSession';
import { generateOrder } from '../optimizer/generateOrder';
import { orderInput, sampleFormatGames, sampleRoster } from '../test/factories';
import { validateHardConstraints } from '../optimizer/constraints/validate';

function startedSession(): UndoableState {
  const input = orderInput(sampleRoster(), sampleFormatGames());
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return undoableReducer(createUndoable(input), { type: 'generated', candidates: result.candidates });
}

describe('order session: generation and candidate selection', () => {
  it('shows the first candidate after generating', () => {
    const state = startedSession();
    expect(state.present.candidates.length).toBeGreaterThan(0);
    expect(state.present.current).toBe(state.present.candidates[0]);
    expect(state.present.edited).toBe(false);
  });

  it('switches to another candidate', () => {
    const state = startedSession();
    if (state.present.candidates.length < 2) return;
    const next = undoableReducer(state, { type: 'selectCandidate', index: 1 });
    expect(next.present.current).toBe(next.present.candidates[1]);
    expect(next.present.selectedCandidate).toBe(1);
  });
});

describe('order session: manual editing (spec §15)', () => {
  it('re-evaluates the tallies immediately after a change', () => {
    const state = startedSession();
    const before = state.present.current!.tallies.find((t) => t.playerId === 'p5')!.count;

    const target = state.present.current!.assignments[0];
    const next = undoableReducer(state, {
      type: 'assignPlayer',
      gameId: target.gameId,
      slotIndex: 0,
      playerId: 'p5',
    });

    expect(next.present.edited).toBe(true);
    expect(next.present.current!.assignments[0].playerIds[0]).toBe('p5');
    const after = next.present.current!.tallies.find((t) => t.playerId === 'p5')!.count;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(next.present.current!.metrics.totalSlots).toBe(10);
  });

  it('swaps instead of duplicating when the picked player already holds another slot', () => {
    const state = startedSession();
    const doubles = state.present.current!.assignments.find((a) => a.playerIds.length === 2)!;
    const [first, second] = doubles.playerIds;
    const next = undoableReducer(state, {
      type: 'assignPlayer',
      gameId: doubles.gameId,
      slotIndex: 0,
      playerId: second,
    });
    const updated = next.present.current!.assignments.find((a) => a.gameId === doubles.gameId)!;
    expect(updated.playerIds).toEqual([second, first]);
    expect(new Set(updated.playerIds).size).toBe(2);
  });

  it('reports a hard-constraint violation created by hand', () => {
    const state = startedSession();
    const doubles = state.present.current!.assignments.find((a) => a.playerIds.length === 2)!;
    // Force a duplicate by emptying a slot then filling it with the other occupant.
    const emptied = undoableReducer(state, {
      type: 'assignPlayer',
      gameId: doubles.gameId,
      slotIndex: 1,
      playerId: null,
    });
    expect(emptied.present.violations.some((v) => v.code === 'EMPTY_SLOT')).toBe(true);
  });

  it('swaps two players between games', () => {
    const state = startedSession();
    const [a, b] = state.present.current!.assignments;
    const playerA = a.playerIds[0];
    const playerB = b.playerIds[0];
    const next = undoableReducer(state, {
      type: 'swapSlots',
      from: { gameId: a.gameId, slotIndex: 0 },
      to: { gameId: b.gameId, slotIndex: 0 },
    });
    const updatedA = next.present.current!.assignments.find((x) => x.gameId === a.gameId)!;
    const updatedB = next.present.current!.assignments.find((x) => x.gameId === b.gameId)!;
    expect(updatedA.playerIds[0]).toBe(playerB);
    expect(updatedB.playerIds[0]).toBe(playerA);
  });
});

describe('order session: locks (spec §14)', () => {
  it('toggles a single slot lock on and off', () => {
    const state = startedSession();
    const target = state.present.current!.assignments[0];
    const locked = undoableReducer(state, { type: 'toggleLock', gameId: target.gameId, slotIndex: 0 });
    expect(locked.present.input.locks).toHaveLength(1);
    expect(locked.present.input.locks[0]).toEqual({
      gameId: target.gameId,
      slotIndex: 0,
      playerId: target.playerIds[0],
    });
    expect(lockedSlots(locked.present.input).has(`${target.gameId}#0`)).toBe(true);

    const unlocked = undoableReducer(locked, { type: 'toggleLock', gameId: target.gameId, slotIndex: 0 });
    expect(unlocked.present.input.locks).toHaveLength(0);
  });

  it('locks and unlocks an entire game', () => {
    const state = startedSession();
    const trios = state.present.current!.assignments.find((a) => a.playerIds.length === 3)!;
    const locked = undoableReducer(state, { type: 'lockGame', gameId: trios.gameId, locked: true });
    expect(locked.present.input.locks).toHaveLength(3);
    const cleared = undoableReducer(locked, { type: 'lockGame', gameId: trios.gameId, locked: false });
    expect(cleared.present.input.locks).toHaveLength(0);
  });

  it('locks everything except one game for partial re-optimisation (spec §17)', () => {
    const state = startedSession();
    const target = state.present.current!.assignments[2];
    const locked = undoableReducer(state, { type: 'lockAllExcept', gameId: target.gameId });
    const lockedGames = new Set(locked.present.input.locks.map((lock) => lock.gameId));
    expect(lockedGames.has(target.gameId)).toBe(false);
    expect(lockedGames.size).toBe(state.present.current!.assignments.length - 1);

    // The subsequent re-generation must preserve every locked slot.
    const result = generateOrder(locked.present.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const lock of locked.present.input.locks) {
      const assignment = result.candidates[0].assignments.find((a) => a.gameId === lock.gameId)!;
      expect(assignment.playerIds[lock.slotIndex]).toBe(lock.playerId);
    }
    expect(validateHardConstraints(locked.present.input, result.candidates[0].assignments)).toEqual([]);
  });

  it('drops locks for a player who has just been marked absent', () => {
    const state = startedSession();
    const target = state.present.current!.assignments[0];
    const locked = undoableReducer(state, { type: 'toggleLock', gameId: target.gameId, slotIndex: 0 });
    const absent = undoableReducer(locked, {
      type: 'setParticipants',
      participants: locked.present.input.participants.map((config) =>
        config.playerId === target.playerIds[0] ? { ...config, include: false } : config,
      ),
    });
    expect(absent.present.input.locks).toHaveLength(0);
    // And the re-generation must then succeed rather than report a lock contradiction.
    const result = generateOrder(absent.present.input);
    expect(result.ok).toBe(true);
  });

  it('clears every lock', () => {
    const state = startedSession();
    const locked = undoableReducer(state, { type: 'lockAllExcept', gameId: 'nope' });
    expect(locked.present.input.locks.length).toBeGreaterThan(0);
    const cleared = undoableReducer(locked, { type: 'clearLocks' });
    expect(cleared.present.input.locks).toHaveLength(0);
  });
});

describe('order session: undo (spec §16)', () => {
  it('undoes a manual player change', () => {
    const state = startedSession();
    const original = state.present.current!.assignments[0].playerIds[0];
    const edited = undoableReducer(state, {
      type: 'assignPlayer',
      gameId: state.present.current!.assignments[0].gameId,
      slotIndex: 0,
      playerId: 'p5',
    });
    expect(canUndo(edited)).toBe(true);
    const undone = undoableReducer(edited, { type: 'undo' });
    expect(undone.present.current!.assignments[0].playerIds[0]).toBe(original);
    expect(undone.present.edited).toBe(false);
  });

  it('undoes a lock change', () => {
    const state = startedSession();
    const locked = undoableReducer(state, {
      type: 'toggleLock',
      gameId: state.present.current!.assignments[0].gameId,
      slotIndex: 0,
    });
    const undone = undoableReducer(locked, { type: 'undo' });
    expect(undone.present.input.locks).toHaveLength(0);
  });

  it('undoes a regeneration back to the previous order', () => {
    const state = startedSession();
    const first = state.present.current!.assignments;
    const regenerated = undoableReducer(state, {
      type: 'generated',
      candidates: [
        {
          ...state.present.candidates[0],
          assignments: state.present.candidates[0].assignments.map((a) => ({ ...a, playerIds: ['p5'] })),
        },
      ],
    });
    expect(regenerated.present.current!.assignments[0].playerIds).toEqual(['p5']);
    const undone = undoableReducer(regenerated, { type: 'undo' });
    expect(undone.present.current!.assignments).toEqual(first);
  });

  it('supports redo and invalidates it on a new edit', () => {
    const state = startedSession();
    const gameId = state.present.current!.assignments[0].gameId;
    const edited = undoableReducer(state, { type: 'assignPlayer', gameId, slotIndex: 0, playerId: 'p5' });
    const undone = undoableReducer(edited, { type: 'undo' });
    expect(canRedo(undone)).toBe(true);
    const redone = undoableReducer(undone, { type: 'redo' });
    expect(redone.present.current!.assignments[0].playerIds[0]).toBe('p5');

    const undoneAgain = undoableReducer(redone, { type: 'undo' });
    const newEdit = undoableReducer(undoneAgain, {
      type: 'assignPlayer',
      gameId,
      slotIndex: 0,
      playerId: 'p4',
    });
    expect(canRedo(newEdit)).toBe(false);
  });

  it('leaves the first generation outside the undo history', () => {
    // Undoing the very first generation would show an empty result screen, so it is
    // deliberately not recorded; a re-generation is (covered above).
    const state = startedSession();
    expect(canUndo(state)).toBe(false);
    expect(undoableReducer(state, { type: 'undo' })).toBe(state);
    expect(undoableReducer(state, { type: 'redo' })).toBe(state);
  });

  it('caps the history depth', () => {
    let state = startedSession();
    const gameId = state.present.current!.assignments[0].gameId;
    for (let i = 0; i < UNDO_DEPTH + 10; i += 1) {
      state = undoableReducer(state, {
        type: 'assignPlayer',
        gameId,
        slotIndex: 0,
        playerId: i % 2 === 0 ? 'p5' : 'p4',
      });
    }
    expect(state.past.length).toBe(UNDO_DEPTH);
  });

  it('does not record an undo entry for a no-op action', () => {
    const state = startedSession();
    const next = undoableReducer(state, { type: 'selectCandidate', index: 99 });
    expect(next).toBe(state);
    expect(next.past).toHaveLength(0);
    expect(canUndo(next)).toBe(false);
  });
});
