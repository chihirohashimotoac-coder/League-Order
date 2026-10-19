import { useState } from 'react';
import type { DartsDiscipline, Player, Team } from '../domain/types';
import { DISCIPLINE_STRENGTH_WEIGHTS, describeStrengthWeights, parsePprInput } from '../domain/players/strength';
import { createId } from '../utils/id';
import { CUSTOM_FORMAT_START, FORMAT_TEMPLATES, formatFromTemplate, type FormatTemplate } from '../storage/seed';
import { totalSlots } from '../domain/games/format';
import { useAppStore } from '../state/appStore';
import { Field, RadioCards, onRadioGroupKeyDown, rovingTabIndex, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { N01TeamWizard } from '../components/n01/N01TeamWizard';

/** Where the app goes once the first team exists. */
export type FirstRunNext = { kind: 'home' } | { kind: 'editFormat'; formatId: string };

/**
 * FIRST RUN.
 *
 * Shown whenever there is no team at all — a fresh install, or after "delete
 * everything". The captain chooses between entering their own team by hand (soft or
 * hard darts, any league — no n01 account needed), importing a team from n01 League, and
 * the sample, which is labelled as demo data everywhere.
 *
 * What the captain types into the manual setup lives here, not in the setup steps, so
 * leaving the setup and coming back (or trying n01 first) loses nothing.
 */
export function WelcomePage({ onCreated }: { onCreated?: (next: FirstRunNext) => void }): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [mode, setMode] = useState<'welcome' | 'setup'>('welcome');
  const [busy, setBusy] = useState(false);
  const [n01Open, setN01Open] = useState(false);
  const [setup, setSetup] = useState<OnboardingDraft>(emptyDraft);

  if (mode === 'setup') {
    return (
      <Onboarding
        draft={setup}
        onDraftChange={setSetup}
        onCancel={() => setMode('welcome')}
        onCreated={onCreated}
      />
    );
  }

  return (
    <main className="welcome">
      <div className="welcome-board">
        <span className="brand-mark lg" aria-hidden="true">
          <Icon name="target" size={30} />
        </span>
        <span className="kicker">
          DARTS LEAGUE ORDER
        </span>
        <h1 className="welcome-title">
          Darts League Order
          <br />
          へようこそ
        </h1>
        <p className="welcome-lead">試合のオーダーを、速く・公平に・強く。メンバーと条件を入れるだけで候補を作ります。</p>
      </div>

      <div className="welcome-actions">
        <section className="start-option" aria-labelledby="start-manual">
          <h2 id="start-manual" className="start-title">
            手入力で作成
            <span className="start-tag">ソフト・ハード</span>
          </h2>
          <p className="start-note">
            n01 に登録していなくても作れます。メンバーと Rating・PPR (3投平均)、ゲーム構成を入力します。店舗リーグや
            Light League などのオンラインリーグもこちらです。
          </p>
          <button type="button" className="btn primary xl" onClick={() => setMode('setup')}>
            <Icon name="users" size={22} />
            自分のチームを作る
          </button>
        </section>

        <section className="start-option" aria-labelledby="start-n01">
          <h2 id="start-n01" className="start-title">
            n01 League から取り込み
          </h2>
          <p className="start-note">
            n01 League (n01darts.com のリーグ) に登録済みのチームから、メンバー・PPR・フォーマットを読み取ります。ATDO・TDO・TDA
            以外のリーグも名前で検索できます。n01 Online のスケジュールモードは対象外です。
          </p>
          <button type="button" className="btn xl" onClick={() => setN01Open(true)}>
            <Icon name="refresh" size={22} />
            n01から作成
          </button>
        </section>

        <button
          type="button"
          className="btn xl"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void store
              .loadSample()
              .then(() => toast.show('サンプルデータを読み込みました', 'ok'))
              .finally(() => setBusy(false));
          }}
        >
          <Icon name="spark" size={20} />
          サンプルで試す
        </button>
        <p className="note">サンプルは「DEMO」と表示され、あとからまとめて削除できます。データはこの端末の中だけに保存されます。</p>
      </div>
      {n01Open ? (
        <N01TeamWizard
          mode={{ kind: 'create' }}
          onClose={() => setN01Open(false)}
          onDone={() => setN01Open(false)}
          onManual={() => {
            setN01Open(false);
            setMode('setup');
          }}
        />
      ) : null}
    </main>
  );
}

interface RosterEntry {
  key: string;
  name: string;
  rating: string;
  ppr: string;
}

interface OnboardingDraft {
  step: number;
  teamName: string;
  leagueName: string;
  /** `null` until the captain chooses — "あとで設定" is a choice too (`UNSPECIFIED`). */
  discipline: DartsDiscipline | null;
  roster: RosterEntry[];
  templateKey: string;
  /** Once the captain picks a format themselves, a discipline change no longer re-picks it. */
  templateChosen: boolean;
}

function emptyDraft(): OnboardingDraft {
  return {
    step: 0,
    teamName: '',
    leagueName: '',
    discipline: null,
    roster: [{ key: createId('row'), name: '', rating: '', ppr: '' }],
    templateKey: FORMAT_TEMPLATES[0].key,
    templateChosen: false,
  };
}

const STEPS = ['チーム', 'メンバー', 'フォーマット'] as const;

const DISCIPLINE_OPTIONS: readonly { key: DartsDiscipline; label: string; hint: string }[] = [
  {
    key: 'SOFT',
    label: 'ソフトダーツ',
    hint: `Rating 重視で評価します (${describeStrengthWeights(DISCIPLINE_STRENGTH_WEIGHTS.SOFT)})。`,
  },
  {
    key: 'STEEL',
    label: 'ハードダーツ (スティール)',
    hint: `PPR (3投平均) 重視で評価します (${describeStrengthWeights(DISCIPLINE_STRENGTH_WEIGHTS.STEEL)})。`,
  },
  {
    key: 'UNSPECIFIED',
    label: 'あとで設定',
    hint: '「未設定」のまま作成し、Rating と PPR を同じ比重で評価します。あとから「フォーマット」画面の各フォーマットで変更できます。',
  },
];

/** The starter format that fits the chosen darts, until the captain picks one. */
function defaultTemplateFor(discipline: DartsDiscipline | null): string {
  return discipline === 'STEEL' ? 'zeroone5' : FORMAT_TEMPLATES[0].key;
}

const TEMPLATE_CHOICES: readonly FormatTemplate[] = [...FORMAT_TEMPLATES, CUSTOM_FORMAT_START];

function Onboarding({
  draft,
  onDraftChange,
  onCancel,
  onCreated,
}: {
  draft: OnboardingDraft;
  onDraftChange: (next: OnboardingDraft) => void;
  onCancel: () => void;
  onCreated?: (next: FirstRunNext) => void;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { step, roster, templateKey, discipline } = draft;
  const update = (change: Partial<OnboardingDraft>): void => onDraftChange({ ...draft, ...change });

  const named = roster.filter((entry) => entry.name.trim() !== '');

  const next = (): void => {
    if (step === 0 && !draft.teamName.trim()) {
      toast.show('チーム名を入力してください', 'error');
      return;
    }
    if (step === 0 && discipline === null) {
      toast.show('ダーツ種別を選んでください (「あとで設定」も選べます)', 'error');
      return;
    }
    if (step === 1 && named.length === 0) {
      toast.show('メンバーを 1 名以上入力してください', 'error');
      return;
    }
    if (step === 1) {
      const bad = named.find((entry) => !parsePprInput(entry.ppr).ok);
      if (bad) {
        const parsed = parsePprInput(bad.ppr);
        toast.show(`${bad.name.trim()}: ${parsed.ok ? '' : parsed.message}`, 'error');
        return;
      }
    }
    if (step < STEPS.length - 1) {
      update({ step: step + 1 });
      return;
    }
    finish();
  };

  const finish = (): void => {
    const now = Date.now();
    const team: Team = {
      id: createId('team'),
      name: draft.teamName.trim(),
      leagueName: draft.leagueName.trim() || undefined,
      createdAt: now,
    };
    const players: Player[] = named.map((entry, index) => {
      const parsed = Number(entry.rating.trim());
      const ppr = parsePprInput(entry.ppr);
      return {
        id: createId('pl'),
        teamId: team.id,
        name: entry.name.trim(),
        // Empty means Unknown, never 0.
        rating: entry.rating.trim() !== '' && Number.isFinite(parsed) ? parsed : null,
        ppr: ppr.ok ? ppr.value : null,
        skills: {},
        seasonAppearances: 0,
        seasonAppearancesByKind: {},
        archived: false,
        createdAt: now + index,
      };
    });
    const template = TEMPLATE_CHOICES.find((entry) => entry.key === templateKey) ?? FORMAT_TEMPLATES[0];
    const format = formatFromTemplate(template, team.id, now, discipline ?? 'UNSPECIFIED');
    setBusy(true);
    void store
      .createTeamSetup(team, players, format)
      .then(() => {
        toast.show(`${team.name} を作成しました`, 'ok');
        onCreated?.(template.key === CUSTOM_FORMAT_START.key ? { kind: 'editFormat', formatId: format.id } : { kind: 'home' });
      })
      .catch(() => setBusy(false));
  };

  const updateEntry = (key: string, change: Partial<RosterEntry>): void =>
    update({ roster: roster.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)) });

  const chooseDiscipline = (value: DartsDiscipline): void =>
    update({ discipline: value, templateKey: draft.templateChosen ? templateKey : defaultTemplateFor(value) });

  const selected = TEMPLATE_CHOICES.find((entry) => entry.key === templateKey) ?? FORMAT_TEMPLATES[0];

  return (
    <main className="onboarding">
      <span className="kicker accent">
        TEAM SETUP
      </span>
      <ol className="steps" aria-label="作成の手順">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? 'step' : undefined}
            className={index < step ? 'done' : undefined}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <>
          <h1>チームを作成</h1>
          <p className="body-text lead">
            共有するオーダー画像の見出しにも使います。
          </p>
          <Field label="チーム名">
            <input
              type="text"
              value={draft.teamName}
              onChange={(event) => update({ teamName: event.target.value })}
              placeholder="例: KALAVINKA"
              autoComplete="off"
            />
          </Field>
          <Field label="リーグ名 (任意)">
            <input
              type="text"
              value={draft.leagueName}
              onChange={(event) => update({ leagueName: event.target.value })}
              placeholder="例: 秋季リーグ Div.2"
              autoComplete="off"
            />
          </Field>
          <RadioCards
            label="ダーツ種別"
            options={DISCIPLINE_OPTIONS}
            value={discipline ?? ('' as DartsDiscipline)}
            onChange={chooseDiscipline}
            hint="戦力評価で Rating と PPR のどちらを重く見るかが変わります。"
          />
        </>
      ) : null}

      {step === 1 ? (
        <>
          <h1>メンバーを登録</h1>
          <p className="body-text lead">
            {discipline === 'STEEL'
              ? 'PPR (3投平均) を入れると戦力評価に使います。Rating は任意です。'
              : discipline === 'SOFT'
                ? 'Rating を入れると戦力評価に使います。PPR (3投平均) は任意です。'
                : 'Rating・PPR (3投平均) はどちらも任意です。'}
            空欄は 0 ではなく「不明」として扱います。適性などはあとから設定できます。
          </p>
          {roster.map((entry, index) => (
            <div className="roster-entry" key={entry.key}>
              <input
                className="re-name"
                type="text"
                value={entry.name}
                onChange={(event) => updateEntry(entry.key, { name: event.target.value })}
                placeholder={`メンバー ${index + 1}`}
                aria-label={`メンバー ${index + 1} の名前`}
                autoComplete="off"
              />
              <label className="re-rating re-field">
                <span className="re-cap" aria-hidden="true">
                  Rating
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={entry.rating}
                  onChange={(event) => updateEntry(entry.key, { rating: event.target.value })}
                  placeholder="—"
                  aria-label={`メンバー ${index + 1} の Rating`}
                />
              </label>
              <label className="re-ppr re-field">
                <span className="re-cap" aria-hidden="true">
                  PPR (3投平均)
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  max={180}
                  value={entry.ppr}
                  onChange={(event) => updateEntry(entry.key, { ppr: event.target.value })}
                  placeholder="—"
                  aria-label={`メンバー ${index + 1} の PPR (3投平均)`}
                />
              </label>
              <button
                type="button"
                className="btn icon ghost re-remove"
                onClick={() => update({ roster: roster.filter((row) => row.key !== entry.key) })}
                disabled={roster.length <= 1}
                aria-label={`メンバー ${index + 1} を削除`}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn block"
            onClick={() => update({ roster: [...roster, { key: createId('row'), name: '', rating: '', ppr: '' }] })}
          >
            <Icon name="plus" size={18} />
            メンバーを追加
          </button>
          <p className="tiny muted">{named.length} 名入力済み</p>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <h1>フォーマットを選択</h1>
          <p className="body-text lead">
            よくある構成の例です。特定のリーグの公式ルールではありません。リーグのゲーム数・人数・順番と見比べて選び、作成後は「フォーマット」画面で自由に編集できます。
          </p>
          <div className="template-list" role="radiogroup" aria-label="フォーマット" onKeyDown={onRadioGroupKeyDown}>
            {TEMPLATE_CHOICES.map((template, index) => {
              const checked = templateKey === template.key;
              const custom = template.key === CUSTOM_FORMAT_START.key;
              return (
                <button
                  type="button"
                  key={template.key}
                  role="radio"
                  aria-checked={checked}
                  tabIndex={rovingTabIndex(checked, index, TEMPLATE_CHOICES.some((entry) => entry.key === templateKey))}
                  className="preset"
                  onClick={() => update({ templateKey: template.key, templateChosen: true })}
                >
                  <span className="p-head">
                    <span className="p-radio" aria-hidden="true" />
                    <Icon name={custom ? 'edit' : 'format'} size={18} />
                    {custom ? '自分の構成を作る' : template.name}
                    {checked ? <Icon name="check" size={18} className="p-check-mark" /> : null}
                  </span>
                  <span className="p-desc">
                    {custom ? (
                      '1 ゲームから始めて、作成後すぐにフォーマット編集を開きます。'
                    ) : (
                      <>
                        <span className="template-play">{template.play === 'zeroone' ? '01 のみ' : '01 + Cricket'}</span>{' '}
                        {template.description}
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <section className="template-preview" aria-label="選んだ構成の内容" data-testid="template-preview">
            <p className="small-text secondary" style={{ margin: '0 0 6px' }}>
              {selected.key === CUSTOM_FORMAT_START.key
                ? '最初の 1 ゲーム (作成後に追加・編集します)'
                : `${selected.games.length} ゲーム ・ 総枠 ${totalSlots(selected.games)}`}
            </p>
            <ol className="lineup-preview">
              {selected.games.map((game, index) => (
                <li key={`${game.name}-${index}`}>
                  <span className="no">{String(index + 1).padStart(2, '0')}</span>
                  <span>{game.name}</span>
                  <span className="badge">{game.playerCount}名</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}

      <div className="onboarding-foot">
        <button
          type="button"
          className="btn"
          onClick={() => (step === 0 ? onCancel() : update({ step: step - 1 }))}
        >
          {step === 0 ? 'キャンセル' : '戻る'}
        </button>
        <button type="button" className="btn primary" onClick={next} disabled={busy}>
          {step === STEPS.length - 1 ? 'チームを作成' : '次へ'}
          {step < STEPS.length - 1 ? <Icon name="chevronRight" size={18} /> : null}
        </button>
      </div>
    </main>
  );
}
