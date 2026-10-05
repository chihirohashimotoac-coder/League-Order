import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Diagnostic, MatchInfo, OrderInput, SavedOrder } from './domain/types';
import { createMatchInfo } from './domain/types';
import {
  createVersion,
  deriveOrderState,
  latestVersion,
  orderFingerprint,
} from './domain/orders/lifecycle';
import { seasonCommitStatus } from './domain/orders/seasonLedger';
import { validateHardConstraints } from './optimizer/constraints/validate';
import { createId } from './utils/id';
import { syncParticipants } from './domain/orders/participants';
import {
  autoValuesOf,
  syncMatchWithTeam,
  type AutoMatchValues,
} from './domain/orders/matchInfo';
import { createRunner, type OrderRunner } from './optimizer/runner';
import { useAppStore } from './state/appStore';
import {
  createUndoable,
  undoableReducer,
  type UndoableAction,
  type UndoableState,
} from './state/orderSession';
import { BACK_TARGETS, PAGE_TITLES, TABS, type Page } from './navigation';
import { onUpdateAvailable } from './pwa';
import { useToast } from './components/ui';
import { HomePage } from './pages/HomePage';
import { PlayersPage } from './pages/PlayersPage';
import { PairsPage } from './pages/PairsPage';
import { FormatsPage } from './pages/FormatsPage';
import { SetupPage, type SetupDraft } from './pages/SetupPage';
import { ResultPage } from './pages/ResultPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * Application shell.
 *
 * Owns navigation, the order session (with its undo history) and the optimizer runner.
 * The runner lives here rather than in a page so that generation survives navigating
 * between SETUP and RESULT.
 */
export function App(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [page, setPage] = useState<Page>('home');
  const [session, setSession] = useState<UndoableState | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [generating, setGenerating] = useState(false);
  const runnerRef = useRef<OrderRunner | null>(null);

  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [match, setMatch] = useState<MatchInfo>(() => createMatchInfo());
  /** The persisted order record, once the captain has saved or finalized it. */
  const [record, setRecord] = useState<SavedOrder | null>(null);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  // A new build is never applied automatically — the captain decides when.
  useEffect(() => onUpdateAvailable((apply) => setApplyUpdate(() => apply)), []);

  useEffect(() => {
    runnerRef.current = createRunner();
    return () => {
      runnerRef.current?.dispose();
      runnerRef.current = null;
    };
  }, []);

  // Keep the setup draft in step with the roster and the saved settings.
  useEffect(() => {
    if (!store.ready) return;
    setDraft((current) => {
      const formatId =
        current && store.teamFormats.some((format) => format.id === current.formatId)
          ? current.formatId
          : (store.teamFormats[0]?.id ?? '');
      const participants = syncParticipants(current?.participants ?? [], store.teamPlayers);
      return {
        formatId,
        participants,
        preset: current?.preset ?? store.settings.lastPreset,
        settings: current?.settings ?? store.settings.optimizer,
      };
    });
  }, [store.ready, store.teamPlayers, store.teamFormats, store.settings]);

  /**
   * Keeps the match header in step with the active team (see `syncMatchWithTeam`).
   *
   * The previous automatic values are read into a local before the ref is updated: the
   * state updater runs after this effect body, so reading the ref from inside it would
   * always see the new values and never recognise an untouched field.
   */
  const autoMatch = useRef<AutoMatchValues>({ teamName: '', leagueName: '' });
  useEffect(() => {
    if (!store.ready) return;
    const previous = autoMatch.current;
    autoMatch.current = autoValuesOf(store.activeTeam);
    setMatch((current) => syncMatchWithTeam(current, previous, store.activeTeam));
  }, [store.ready, store.activeTeam]);

  const dispatch = useCallback((action: UndoableAction) => {
    setSession((current) => (current ? undoableReducer(current, action) : current));
  }, []);

  const run = useCallback(
    async (input: OrderInput, options?: { candidateCount?: number }) => {
      const runner = runnerRef.current;
      if (!runner) return;
      setGenerating(true);
      setDiagnostics([]);
      try {
        const result = await runner.generate(input, options);
        if (result.ok) {
          setSession((current) => {
            const base = current && current.present.current ? current : createUndoable(input);
            const withInput = undoableReducer(base, { type: 'setInput', input });
            return undoableReducer(withInput, { type: 'generated', candidates: result.candidates });
          });
          setDiagnostics([]);
          setPage('result');
        } else {
          setSession((current) => {
            // Keep the previous order visible so the captain does not lose their work;
            // the diagnostics explain why the new attempt failed.
            const base = current ?? createUndoable(input);
            return undoableReducer(base, { type: 'setInput', input });
          });
          setDiagnostics(result.diagnostics);
          setPage('result');
          toast.show('条件を満たすオーダーがありません。理由を表示します。', 'error');
        }
      } catch (error) {
        toast.show(`生成に失敗しました: ${(error as Error).message}`, 'error');
      } finally {
        setGenerating(false);
      }
    },
    [toast],
  );

  const handleGenerate = useCallback(
    (input: OrderInput) => {
      store.saveSettings({
        ...store.settings,
        lastPreset: input.preset,
        optimizer: input.settings,
      });
      // Generating from SETUP starts a new order: it is a fresh draft, not a revision of
      // whatever was previously finalized.
      setRecord(null);
      void run(input);
    },
    [run, store],
  );

  /**
   * Re-optimisation (spec §17). `keepGameId === null` keeps the current locks as they
   * are; otherwise every other game is pinned first so only the named game can change.
   */
  const handleReoptimise = useCallback(
    (keepGameId: string | null) => {
      setSession((current) => {
        if (!current?.present.current) return current;
        const next =
          keepGameId === null
            ? current
            : undoableReducer(current, { type: 'lockAllExcept', gameId: keepGameId });
        void run(next.present.input, { candidateCount: 1 });
        return next;
      });
    },
    [run],
  );

  const handleRegenerate = useCallback(() => {
    if (!session?.present.input) return;
    void run(session.present.input);
  }, [run, session]);

  const openSavedOrder = useCallback(
    (order: SavedOrder) => {
      const restored = undoableReducer(createUndoable(order.input), {
        type: 'generated',
        candidates: [order.solution],
      });
      setSession(restored);
      // A saved order carries the match it was played for, so re-sharing it later
      // reproduces the same header, and its versions so the lifecycle resumes correctly.
      if (order.match) setMatch(order.match);
      setRecord(order);
      setDiagnostics([]);
      setPage('result');
      toast.show('履歴から読み込みました', 'ok');
    },
    [toast],
  );

  const games = useMemo(() => {
    if (session?.present.input.games.length) return session.present.input.games;
    const format = store.teamFormats.find((entry) => entry.id === draft?.formatId);
    return format?.games ?? [];
  }, [session, store.teamFormats, draft]);

  const solution = session?.present.current ?? null;

  /**
   * Lifecycle state (追加要件 §2, §8).
   *
   * Derived from the finalized versions and a fingerprint of the working copy, so it can
   * never go stale: an edit that changes what the team would see flips FINALIZED to
   * UPDATED by itself, and merely opening the share screen cannot change it.
   */
  const currentFingerprint = useMemo(
    () => (solution ? orderFingerprint(games, solution.assignments, match) : null),
    [solution, games, match],
  );

  const lifecycle = useMemo(
    () => deriveOrderState(record?.versions ?? [], currentFingerprint),
    [record, currentFingerprint],
  );

  const seasonStatus = useMemo(() => {
    if (!record) return 'none' as const;
    const commit = store.seasonCommitFor(record.id);
    return seasonCommitStatus(commit, latestVersion(record.versions)?.version ?? null);
  }, [record, store]);

  /** Creates or updates the persisted record for the current working order. */
  const persist = useCallback(
    (mutate: (base: SavedOrder) => SavedOrder): SavedOrder | null => {
      if (!session?.present.current || !store.activeTeamId) return null;
      const now = Date.now();
      const base: SavedOrder =
        record ??
        {
          id: createId('ord'),
          teamId: store.activeTeamId,
          title: `${new Date(now).toLocaleDateString('ja-JP')} ${session.present.current.meta.label}`,
          createdAt: now,
          updatedAt: now,
          input: session.present.input,
          solution: session.present.current,
          match,
          versions: [],
          seasonApplied: false,
        };

      const next = mutate({
        ...base,
        updatedAt: now,
        input: session.present.input,
        solution: session.present.current,
        match,
      });
      setRecord(next);
      store.saveOrder(next);
      return next;
    },
    [record, session, store, match],
  );

  const handleSaveDraft = useCallback(() => {
    const saved = persist((base) => base);
    toast.show(saved ? '履歴に保存しました' : '保存できませんでした', saved ? 'ok' : 'error');
  }, [persist, toast]);

  /**
   * Finalization (追加要件 §3, §4).
   *
   * Re-validates every hard constraint before freezing a version: a line-up that breaks
   * one must never be handed to the team as confirmed.
   */
  const handleFinalize = useCallback(() => {
    if (!session?.present.current) return;
    const violations = validateHardConstraints(session.present.input, session.present.current.assignments);
    if (violations.length > 0) {
      toast.show(`確定できません: ${violations[0].message}`, 'error');
      return;
    }
    if (lifecycle === 'FINALIZED') {
      toast.show('すでに確定済みです (内容に変更はありません)', 'ok');
      return;
    }

    const saved = persist((base) => ({
      ...base,
      versions: [
        ...base.versions,
        createVersion(session.present.input, session.present.current!, match, base.versions, Date.now()),
      ],
    }));
    if (!saved) {
      toast.show('確定できませんでした', 'error');
      return;
    }
    const version = latestVersion(saved.versions)!;
    toast.show(`v${version.version} として確定しました`, 'ok');
  }, [session, lifecycle, persist, match, toast]);

  const handleCommitSeason = useCallback(() => {
    if (!record) return;
    const version = latestVersion(record.versions);
    if (!version) return;
    const result = store.commitSeason(record, version);
    toast.show(result.message, result.ok ? 'ok' : 'error');
    if (result.clamped.length > 0) {
      toast.show(`${result.clamped.length} 名の累計が 0 未満になるため 0 に丸めました`, 'error');
    }
  }, [record, store, toast]);

  const handleWithdrawSeason = useCallback(() => {
    if (!record) return;
    const result = store.withdrawSeason(record.id);
    toast.show(result.message, result.ok ? 'ok' : 'error');
  }, [record, store, toast]);

  const hasActionBar =
    page === 'setup' || page === 'result' || page === 'players' || page === 'formats';

  if (!store.ready) {
    return (
      <div className="app">
        <main className="app-main">
          <div className="empty-state">
            <span className="spinner" aria-hidden="true" />
            <p>読み込み中…</p>
          </div>
        </main>
      </div>
    );
  }

  const backTarget = BACK_TARGETS[page];

  return (
    <div className="app">
      <header className="app-header">
        {backTarget ? (
          <button
            type="button"
            className="btn icon ghost"
            onClick={() => setPage(backTarget)}
            aria-label="戻る"
          >
            ‹
          </button>
        ) : null}
        <span className="header-titles">
          <h1>{PAGE_TITLES[page]}</h1>
          <span className="subtitle">{store.activeTeam?.name ?? 'チーム未設定'}</span>
        </span>
        {page === 'result' && session?.present.current ? (
          <span className="badge accent">{session.present.current.score.display}</span>
        ) : null}
      </header>

      <main className={hasActionBar ? 'app-main has-action-bar' : 'app-main'}>
        {applyUpdate ? (
          <div className="notice info">
            <span aria-hidden="true">↻</span>
            <span className="grow small-text">新しいバージョンがあります。</span>
            <button type="button" className="btn small primary" onClick={applyUpdate}>
              更新
            </button>
          </div>
        ) : null}
        {page === 'home' ? <HomePage onNavigate={setPage} /> : null}
        {page === 'players' ? <PlayersPage /> : null}
        {page === 'pairs' ? <PairsPage /> : null}
        {page === 'formats' ? <FormatsPage /> : null}
        {page === 'setup' && draft ? (
          <SetupPage
            draft={draft}
            onDraftChange={setDraft}
            match={match}
            onMatchChange={setMatch}
            onGenerate={handleGenerate}
            generating={generating}
          />
        ) : null}
        {page === 'result' ? (
          session ? (
            <ResultPage
              session={session}
              dispatch={dispatch}
              games={games}
              diagnostics={diagnostics}
              generating={generating}
              match={match}
              onMatchChange={setMatch}
              onRegenerate={handleRegenerate}
              onReoptimise={handleReoptimise}
              record={record}
              lifecycle={lifecycle}
              seasonStatus={seasonStatus}
              onFinalize={handleFinalize}
              onSaveDraft={handleSaveDraft}
              onCommitSeason={handleCommitSeason}
              onWithdrawSeason={handleWithdrawSeason}
            />
          ) : (
            <div className="empty-state">
              まだオーダーがありません。
              <br />
              「オーダー」タブから生成してください。
            </div>
          )
        ) : null}
        {page === 'history' ? <HistoryPage onOpen={openSavedOrder} /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </main>

      <nav className="tab-bar" aria-label="メインナビゲーション">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.page}
            onClick={() =>
              // Once an order has been generated, the ORDER tab returns to the result
              // rather than the setup form: that is the screen the captain is working
              // on, and the header's back arrow still leads to the setup.
              setPage(tab.page === 'setup' && session?.present.current ? 'result' : tab.page)
            }
            aria-current={page === tab.page ? 'page' : undefined}
          >
            <span className="tab-icon" aria-hidden="true">
              {tab.icon}
            </span>
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
