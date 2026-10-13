import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CHANGELOG, CHANGELOG_LATEST_VERSION } from '../data/changelog';

afterEach(cleanup);

// Minimal store stub so SettingsPage renders without a real provider.
vi.mock('../state/appStore', () => ({
  useAppStore: () => ({
    settings: {
      n01: { autoSync: false, showPredictions: false, historyDepth: 2 },
      customWeights: {
        strength: 1, gameFit: 1, pairFit: 1, fairness: 1,
        roleFairness: 1, novelty: 1, consecutive: 1, season: 1,
      },
      optimizer: { timeLimitMs: 2000, beamWidth: 16, fairnessScope: 'today' },
      activeTeamId: null,
    },
    backendKind: 'indexeddb',
    saveSettings: vi.fn(),
    snapshot: () => ({ teams: [], players: [], formats: [], pairs: [], orders: [], seasonCommits: [], settings: {} }),
    replaceEverything: vi.fn(),
  }),
}));

async function renderSettings() {
  const { SettingsPage } = await import('../pages/SettingsPage');
  return render(<SettingsPage />);
}

describe('changelog data', () => {
  it('CHANGELOG is non-empty and sorted newest first', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(CHANGELOG[i - 1].date >= CHANGELOG[i].date).toBe(true);
    }
  });

  it('CHANGELOG_LATEST_VERSION is the newest versioned entry and matches the app version', () => {
    expect(CHANGELOG_LATEST_VERSION).toBe(CHANGELOG.find((entry) => entry.version)?.version);
    expect(__APP_VERSION__).toBe(CHANGELOG_LATEST_VERSION);
  });

  it('entries have unique ids and titles, and 2–5 items each', () => {
    expect(new Set(CHANGELOG.map((entry) => entry.id)).size).toBe(CHANGELOG.length);
    for (const entry of CHANGELOG) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.items.length).toBeGreaterThanOrEqual(2);
      expect(entry.items.length).toBeLessThanOrEqual(5);
    }
  });

  it('versions are not repeated and carry no link or PR URL anywhere', () => {
    const versions = CHANGELOG.flatMap((entry) => (entry.version ? [entry.version] : []));
    expect(new Set(versions).size).toBe(versions.length);
    expect(JSON.stringify(CHANGELOG)).not.toMatch(/https?:\/\//);
  });
});

describe('SettingsPage: version display', () => {
  it('shows the app version in the ABOUT card', async () => {
    await renderSettings();
    const versionEl = screen.getByTestId('app-version');
    expect(versionEl.textContent).toBe(`v${__APP_VERSION__}`);
  });

  it('shows "更新履歴を見る" button', async () => {
    await renderSettings();
    expect(screen.getByRole('button', { name: '更新履歴を見る' })).toBeTruthy();
  });

  it('shows copyright notice', async () => {
    await renderSettings();
    expect(screen.getByText(/© 2026 Chihiro Hashimoto/)).toBeTruthy();
  });
});

describe('SettingsPage: changelog sheet', () => {
  it('changelog sheet is not visible on load', async () => {
    await renderSettings();
    expect(screen.queryByRole('dialog', { name: '更新履歴' })).toBeNull();
  });

  it('opens the changelog sheet when the button is clicked', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '更新履歴を見る' }));
    expect(screen.getByRole('dialog', { name: '更新履歴' })).toBeTruthy();
  });

  it('shows every changelog entry in the sheet', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '更新履歴を見る' }));
    const dialog = screen.getByRole('dialog', { name: '更新履歴' });
    for (const entry of CHANGELOG) {
      expect(dialog.querySelector(`[data-entry="${entry.id}"]`)).toBeTruthy();
      if (entry.version) expect(dialog.querySelector(`[data-version="${entry.version}"]`)).toBeTruthy();
    }
  });

  it('renders no links in the sheet', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '更新履歴を見る' }));
    expect(screen.getByRole('dialog', { name: '更新履歴' }).querySelectorAll('a').length).toBe(0);
  });

  it('closes the sheet with the close button', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '更新履歴を見る' }));
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog', { name: '更新履歴' })).toBeNull();
  });

  it('closes the sheet with Escape', async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '更新履歴を見る' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '更新履歴' })).toBeNull();
  });
});
