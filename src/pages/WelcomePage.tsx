import { useState } from 'react';
import type { Player, Team } from '../domain/types';
import { createId } from '../utils/id';
import { FORMAT_TEMPLATES, formatFromTemplate } from '../storage/seed';
import { useAppStore } from '../state/appStore';
import { Field, useToast } from '../components/ui';
import { Icon } from '../components/icons';

/**
 * FIRST RUN.
 *
 * Shown whenever there is no team at all — a fresh install, or after "delete
 * everything". The captain chooses between their own team (a three-step setup that
 * creates nothing else) and the sample, which is labelled as demo data everywhere.
 */
export function WelcomePage(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [mode, setMode] = useState<'welcome' | 'setup'>('welcome');
  const [busy, setBusy] = useState(false);

  if (mode === 'setup') return <Onboarding onCancel={() => setMode('welcome')} />;

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
        <button type="button" className="btn primary xl" onClick={() => setMode('setup')}>
          <Icon name="users" size={22} />
          自分のチームを作る
        </button>
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
    </main>
  );
}

interface RosterEntry {
  key: string;
  name: string;
  rating: string;
}

const STEPS = ['チーム', 'メンバー', 'フォーマット'] as const;

function Onboarding({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [teamName, setTeamName] = useState('');
  const [leagueName, setLeagueName] = useState('');
  const [roster, setRoster] = useState<RosterEntry[]>(() => [{ key: createId('row'), name: '', rating: '' }]);
  const [templateKey, setTemplateKey] = useState<string>(FORMAT_TEMPLATES[0].key);
  const [busy, setBusy] = useState(false);

  const named = roster.filter((entry) => entry.name.trim() !== '');

  const next = (): void => {
    if (step === 0 && !teamName.trim()) {
      toast.show('チーム名を入力してください', 'error');
      return;
    }
    if (step === 1 && named.length === 0) {
      toast.show('メンバーを 1 名以上入力してください', 'error');
      return;
    }
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    finish();
  };

  const finish = (): void => {
    const now = Date.now();
    const team: Team = {
      id: createId('team'),
      name: teamName.trim(),
      leagueName: leagueName.trim() || undefined,
      createdAt: now,
    };
    const players: Player[] = named.map((entry, index) => {
      const parsed = Number(entry.rating.trim());
      return {
        id: createId('pl'),
        teamId: team.id,
        name: entry.name.trim(),
        // Empty means Unknown, never 0.
        rating: entry.rating.trim() !== '' && Number.isFinite(parsed) ? parsed : null,
        ppr: null,
        skills: {},
        seasonAppearances: 0,
        seasonAppearancesByKind: {},
        archived: false,
        createdAt: now + index,
      };
    });
    const template = FORMAT_TEMPLATES.find((entry) => entry.key === templateKey) ?? FORMAT_TEMPLATES[0];
    setBusy(true);
    void store
      .createTeamSetup(team, players, formatFromTemplate(template, team.id, now))
      .then(() => toast.show(`${team.name} を作成しました`, 'ok'))
      .catch(() => setBusy(false));
  };

  const updateEntry = (key: string, change: Partial<RosterEntry>): void =>
    setRoster((current) => current.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)));

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
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="例: KALAVINKA"
              autoComplete="off"
            />
          </Field>
          <Field label="リーグ名 (任意)">
            <input
              type="text"
              value={leagueName}
              onChange={(event) => setLeagueName(event.target.value)}
              placeholder="例: 秋季リーグ Div.2"
              autoComplete="off"
            />
          </Field>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <h1>メンバーを登録</h1>
          <p className="body-text lead">
            Rating は空欄で構いません (未入力は 0 ではなく「不明」として扱います)。適性などはあとから設定できます。
          </p>
          {roster.map((entry, index) => (
            <div className="roster-entry" key={entry.key}>
              <input
                type="text"
                value={entry.name}
                onChange={(event) => updateEntry(entry.key, { name: event.target.value })}
                placeholder={`メンバー ${index + 1}`}
                aria-label={`メンバー ${index + 1} の名前`}
                autoComplete="off"
              />
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={entry.rating}
                onChange={(event) => updateEntry(entry.key, { rating: event.target.value })}
                placeholder="Rt."
                aria-label={`メンバー ${index + 1} の Rating`}
              />
              <button
                type="button"
                className="btn icon ghost"
                onClick={() => setRoster((current) => current.filter((row) => row.key !== entry.key))}
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
            onClick={() => setRoster((current) => [...current, { key: createId('row'), name: '', rating: '' }])}
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
            リーグのゲーム構成です。あとから自由に編集・追加できます。
          </p>
          <div className="template-list" role="radiogroup" aria-label="フォーマット">
            {FORMAT_TEMPLATES.map((template) => (
              <button
                type="button"
                key={template.key}
                role="radio"
                aria-checked={templateKey === template.key}
                className="preset"
                onClick={() => setTemplateKey(template.key)}
              >
                <span className="p-head">
                  <Icon name="format" size={18} />
                  {template.name}
                  {templateKey === template.key ? (
                    <Icon name="check" size={18} className="p-check-mark" />
                  ) : null}
                </span>
                <span className="p-desc">{template.description}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="onboarding-foot">
        <button
          type="button"
          className="btn"
          onClick={() => (step === 0 ? onCancel() : setStep(step - 1))}
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
