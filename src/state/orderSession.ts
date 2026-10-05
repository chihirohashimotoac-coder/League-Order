import type {
  GameAssignment,
  GameId,
  LockEntry,
  OrderInput,
  OrderSolution,
  ParticipantConfig,
  PlayerId,
  PresetKey,
  ScoreWeights,
} from '../domain/types';
import { evaluateManualOrder } from '../optimizer/generateOrder';
import type { HardViolation } from '../optimizer/constraints/validate';

/**
 * Order session reducer: the editable state of one order (spec §14–§17).
 *
 * Deliberately a plain reducer over plain data with no React imports, so the undo
 * behaviour and the re-evaluation on every edit are directly unit-testable.
 *
 * Undo (spec §16) is a stack of whole snapshots rather than inverse operations. The
 * state is small (one order), snapshots are cheap, and "one snapshot per user action"
 * is impossible to get subtly wrong — an inverse-operation log would need an inverse
 * for every future action type.
 */

export interface OrderSessionState {
  input: OrderInput;
  /** Candidates from the last generation; index 0 is the recommended one. */
  candidates: OrderSolution[];
  selectedCandidate: number;
  /** The order currently being shown and edited. */
  current: OrderSolution | null;
  /** Hard-constraint violations of `current` (non-empty only after a manual edit). */
  violations: HardViolation[];
  /** True while `current` differs from the generated candidate. */
  edited: boolean;
}

export interface UndoableState {
  present: OrderSessionState;
  past: OrderSessionState[];
  future: OrderSessionState[];
}

/** Snapshots kept for undo (design D-14). */
export const UNDO_DEPTH = 30;

export type OrderSessionAction =
  | { type: 'generated'; candidates: OrderSolution[] }
  | { type: 'selectCandidate'; index: number }
  | { type: 'assignPlayer'; gameId: GameId; slotIndex: number; playerId: PlayerId | null }
  | { type: 'swapSlots'; from: { gameId: GameId; slotIndex: number }; to: { gameId: GameId; slotIndex: number } }
  | { type: 'toggleLock'; gameId: GameId; slotIndex: number }
  | { type: 'lockGame'; gameId: GameId; locked: boolean }
  | { type: 'lockAllExcept'; gameId: GameId }
  | { type: 'clearLocks' }
  | { type: 'setParticipants'; participants: ParticipantConfig[] }
  | { type: 'setPreset'; preset: PresetKey; weights: ScoreWeights }
  | { type: 'setSettings'; settings: OrderInput['settings'] }
  | { type: 'setInput'; input: OrderInput }
  | { type: 'reset'; state: OrderSessionState };

/** Actions that must not create an undo entry (they are not user edits). */
const TRANSPARENT_ACTIONS: ReadonlySet<OrderSessionAction['type']> = new Set(['reset']);

/**
 * True when an action should not be undoable in this state.
 *
 * The very first generation is excluded: undoing it would drop the captain back to an
 * empty result screen, which reads as a bug rather than an undo. A *re*-generation is
 * undoable, as spec §16 requires.
 */
function isTransparent(state: OrderSessionState, action: OrderSessionAction): boolean {
  if (TRANSPARENT_ACTIONS.has(action.type)) return true;
  return action.type === 'generated' && state.current === null;
}

export function createSession(input: OrderInput): OrderSessionState {
  return {
    input,
    candidates: [],
    selectedCandidate: 0,
    current: null,
    violations: [],
    edited: false,
  };
}

export function createUndoable(input: OrderInput): UndoableState {
  return { present: createSession(input), past: [], future: [] };
}

function lockKey(gameId: GameId, slotIndex: number): string {
  return `${gameId}#${slotIndex}`;
}

function withLocks(input: OrderInput, locks: LockEntry[]): OrderInput {
  const seen = new Set<string>();
  const unique: LockEntry[] = [];
  for (const lock of locks) {
    const key = lockKey(lock.gameId, lock.slotIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(lock);
  }
  unique.sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : a.slotIndex - b.slotIndex));
  return { ...input, locks: unique };
}

/** Re-evaluates the edited assignment so the UI always shows live numbers (spec §15). */
function reevaluate(state: OrderSessionState, assignments: GameAssignment[]): OrderSessionState {
  const result = evaluateManualOrder(state.input, assignments);
  return {
    ...state,
    current: result.solution ?? state.current,
    violations: result.violations,
    edited: true,
  };
}

function locksForGames(solution: OrderSolution, gameIds: readonly GameId[]): LockEntry[] {
  const wanted = new Set(gameIds);
  return solution.assignments
    .filter((assignment) => wanted.has(assignment.gameId))
    .flatMap((assignment) =>
      assignment.playerIds.map((playerId, slotIndex) => ({
        gameId: assignment.gameId,
        slotIndex,
        playerId,
      })),
    );
}

export function sessionReducer(
  state: OrderSessionState,
  action: OrderSessionAction,
): OrderSessionState {
  switch (action.type) {
    case 'generated': {
      const current = action.candidates[0] ?? null;
      return {
        ...state,
        candidates: action.candidates,
        selectedCandidate: 0,
        current,
        violations: [],
        edited: false,
      };
    }

    case 'selectCandidate': {
      const candidate = state.candidates[action.index];
      if (!candidate) return state;
      return {
        ...state,
        selectedCandidate: action.index,
        current: candidate,
        violations: [],
        edited: false,
      };
    }

    case 'assignPlayer': {
      if (!state.current) return state;
      const assignments = state.current.assignments.map((assignment) => {
        if (assignment.gameId !== action.gameId) return assignment;
        const playerIds = [...assignment.playerIds];
        if (action.playerId === null) {
          // Emptying a slot keeps the array length so the violation list reports the
          // empty slot instead of silently shrinking the game.
          playerIds[action.slotIndex] = '';
        } else {
          // Picking a player who already holds another slot in this game swaps them,
          // which is what a captain expects from a tap-to-change control.
          const existing = playerIds.indexOf(action.playerId);
          if (existing >= 0 && existing !== action.slotIndex) {
            playerIds[existing] = playerIds[action.slotIndex];
          }
          playerIds[action.slotIndex] = action.playerId;
        }
        return { ...assignment, playerIds };
      });
      return reevaluate(state, assignments);
    }

    case 'swapSlots': {
      if (!state.current) return state;
      const from = state.current.assignments.find((a) => a.gameId === action.from.gameId);
      const to = state.current.assignments.find((a) => a.gameId === action.to.gameId);
      if (!from || !to) return state;
      const fromPlayer = from.playerIds[action.from.slotIndex];
      const toPlayer = to.playerIds[action.to.slotIndex];
      if (fromPlayer === undefined || toPlayer === undefined) return state;

      const assignments = state.current.assignments.map((assignment) => {
        const playerIds = [...assignment.playerIds];
        if (assignment.gameId === action.from.gameId) playerIds[action.from.slotIndex] = toPlayer;
        if (assignment.gameId === action.to.gameId) playerIds[action.to.slotIndex] = fromPlayer;
        return { ...assignment, playerIds };
      });
      return reevaluate(state, assignments);
    }

    case 'toggleLock': {
      if (!state.current) return state;
      const key = lockKey(action.gameId, action.slotIndex);
      const existing = state.input.locks.find((lock) => lockKey(lock.gameId, lock.slotIndex) === key);
      if (existing) {
        return {
          ...state,
          input: withLocks(
            state.input,
            state.input.locks.filter((lock) => lockKey(lock.gameId, lock.slotIndex) !== key),
          ),
        };
      }
      const assignment = state.current.assignments.find((a) => a.gameId === action.gameId);
      const playerId = assignment?.playerIds[action.slotIndex];
      if (!playerId) return state;
      return {
        ...state,
        input: withLocks(state.input, [
          ...state.input.locks,
          { gameId: action.gameId, slotIndex: action.slotIndex, playerId },
        ]),
      };
    }

    case 'lockGame': {
      if (!state.current) return state;
      const others = state.input.locks.filter((lock) => lock.gameId !== action.gameId);
      const locks = action.locked
        ? [...others, ...locksForGames(state.current, [action.gameId])]
        : others;
      return { ...state, input: withLocks(state.input, locks) };
    }

    case 'lockAllExcept': {
      // The core of partial re-optimisation (spec §17): pin everything the captain is
      // happy with, then re-run so only the named game can move.
      if (!state.current) return state;
      const gameIds = state.current.assignments
        .map((assignment) => assignment.gameId)
        .filter((gameId) => gameId !== action.gameId);
      return { ...state, input: withLocks(state.input, locksForGames(state.current, gameIds)) };
    }

    case 'clearLocks':
      return { ...state, input: withLocks(state.input, []) };

    case 'setParticipants': {
      const input = { ...state.input, participants: action.participants };
      // Locks whose player just became unavailable are dropped, otherwise the next
      // generation would fail on a contradiction the captain did not ask for.
      const availability = new Map(action.participants.map((config) => [config.playerId, config.include]));
      const locks = input.locks.filter((lock) => availability.get(lock.playerId) !== false);
      return { ...state, input: withLocks(input, locks) };
    }

    case 'setPreset':
      return { ...state, input: { ...state.input, preset: action.preset, weights: action.weights } };

    case 'setSettings':
      return { ...state, input: { ...state.input, settings: action.settings } };

    case 'setInput':
      return { ...state, input: action.input };

    case 'reset':
      return action.state;

    default:
      return state;
  }
}

export type UndoableAction =
  | OrderSessionAction
  | { type: 'undo' }
  | { type: 'redo' };

export function undoableReducer(state: UndoableState, action: UndoableAction): UndoableState {
  if (action.type === 'undo') {
    const previous = state.past[state.past.length - 1];
    if (!previous) return state;
    return {
      present: previous,
      past: state.past.slice(0, -1),
      future: [state.present, ...state.future].slice(0, UNDO_DEPTH),
    };
  }

  if (action.type === 'redo') {
    const [next, ...rest] = state.future;
    if (!next) return state;
    return {
      present: next,
      past: [...state.past, state.present].slice(-UNDO_DEPTH),
      future: rest,
    };
  }

  const present = sessionReducer(state.present, action);
  if (present === state.present) return state;

  if (isTransparent(state.present, action)) {
    return { present, past: [], future: [] };
  }

  return {
    present,
    past: [...state.past, state.present].slice(-UNDO_DEPTH),
    // A new edit invalidates the redo branch, as in any editor.
    future: [],
  };
}

export function canUndo(state: UndoableState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: UndoableState): boolean {
  return state.future.length > 0;
}

/** Locks grouped by game, for rendering lock toggles. */
export function lockedSlots(input: OrderInput): Set<string> {
  return new Set(input.locks.map((lock) => lockKey(lock.gameId, lock.slotIndex)));
}

export { lockKey };
