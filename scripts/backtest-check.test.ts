import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINE_PATH, REQUIRED_SECTIONS, check, compare, differences, normalizeReport, sha256, type BacktestRun } from './backtest-check';

/**
 * The evidence check for `npm run backtest`, run with a canned backtest (no child process):
 * it must pass only on the baseline's exact content, tolerate only the two timing lines, and
 * leave the proof behind.
 */

const REPORT = [
  '# League Order — backtest report (fixture leagues)',
  '',
  '## 1. Prediction backtest (strictly earlier days only)',
  '| ATDO | game | 312 | 0.2312 | 0.2500 |',
  '## 2. Parameter grid (ATDO games; defaults in bold)',
  '## 3. Optimizer backtest (time-travel replays, model estimates only)',
  '- replays: 40',
  '## 3b. Sensitivity of the recommended order (ATDO, 7-game format, 6 replays)',
  '## 4. Performance (Node, this machine)',
  '- replay (fetch + plan + intelligence) of 40 matches: 213 ms total',
  '- optimizer (4 candidates) per match: median 33 ms, max 1212 ms',
  '## 3c. Appearance-bias gate: threshold calibration (same replays, 対戦相手最適化 candidate)',
  '- requests: first sync 4, + opponent analysis (2 past seasons) 12, re-sync season resolution 2',
  '- duplicate requests within one sync: 0',
  '',
].join('\n');

const ok = (stdout: string): BacktestRun => ({ status: 0, stdout, stderr: '' });
const withTimings = (replay: number, median: number, max: number): string =>
  REPORT.replace('213 ms total', `${replay} ms total`).replace('median 33 ms, max 1212 ms', `median ${median} ms, max ${max} ms`);

function sandbox(baseline: string | null): { baselinePath: string; reportDir: string; summaryPath: string; log: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'backtest-check-'));
  const baselinePath = join(dir, 'baseline.md');
  if (baseline !== null) writeFileSync(baselinePath, baseline);
  return { baselinePath, reportDir: join(dir, 'report'), summaryPath: join(dir, 'step-summary.md'), log: [] };
}

describe('normalizeReport', () => {
  it('masks the two timing lines and nothing else', () => {
    const normalized = normalizeReport(REPORT);
    expect(normalized).toContain('- replay (fetch + plan + intelligence) of 40 matches: <ms> ms total');
    expect(normalized).toContain('- optimizer (4 candidates) per match: median <ms> ms, max <ms> ms');
    expect(normalized).toContain('| ATDO | game | 312 | 0.2312 | 0.2500 |');
    expect(normalized).toContain('- replays: 40');
    expect(differences(REPORT, normalized).total).toBe(2);
  });

  it('keeps the match count of the replay line: a different count is a real change', () => {
    expect(normalizeReport(REPORT.replace('of 40 matches', 'of 39 matches'))).not.toBe(normalizeReport(REPORT));
  });

  it('ignores CRLF and trailing blanks', () => {
    expect(normalizeReport(REPORT.replace(/\n/gu, '  \r\n') + '\n\n')).toBe(normalizeReport(REPORT));
  });
});

describe('compare', () => {
  it('matches when only the timings differ', () => {
    const result = compare(ok(withTimings(9999, 7, 31)), REPORT);
    expect(result.status).toBe('MATCH');
    expect(result.actualSha).toBe(result.baselineSha);
  });

  it('is a mismatch when any figure changes, and names the line', () => {
    const result = compare(ok(REPORT.replace('0.2312', '0.2313')), REPORT);
    expect(result.status).toBe('MISMATCH');
    expect(result.differing.total).toBe(1);
    expect(result.differing.shown[0]).toMatchObject({ line: 4, baseline: '| ATDO | game | 312 | 0.2312 | 0.2500 |', actual: '| ATDO | game | 312 | 0.2313 | 0.2500 |' });
  });

  it('is a mismatch when a line disappears', () => {
    expect(compare(ok(REPORT.replace('- replays: 40\n', '')), REPORT).status).toBe('MISMATCH');
  });

  it('fails when the backtest crashes, even if the baseline would match', () => {
    const result = compare({ status: 1, stdout: REPORT, stderr: 'Error: generation failed\n    at …' }, REPORT);
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/generation failed/);
  });

  it('fails when a required section is missing from the run (an empty output proves nothing)', () => {
    const result = compare(ok(''), '');
    expect(result.status).toBe('FAILED');
    expect(result.missingSections.length).toBe(REQUIRED_SECTIONS.length);
  });

  it('fails when there is no baseline', () => {
    const result = compare(ok(REPORT), null);
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/baseline/);
  });
});

describe('check (evidence on disk)', () => {
  it('writes the report, the baseline copy and a summary naming both hashes; exit 0 on a match', () => {
    const box = sandbox(REPORT);
    const code = check({
      baselinePath: box.baselinePath,
      reportDir: box.reportDir,
      run: () => ok(withTimings(1, 2, 3)),
      context: { node: 'v22.0.0', sha: 'abc123' },
      stepSummaryPath: box.summaryPath,
      log: (line) => box.log.push(line),
    });
    expect(code).toBe(0);
    for (const file of ['backtest.md', 'backtest.normalized.md', 'backtest.baseline.md', 'summary.md', 'summary.json']) {
      expect(existsSync(join(box.reportDir, file)), file).toBe(true);
    }
    const json = JSON.parse(readFileSync(join(box.reportDir, 'summary.json'), 'utf8'));
    expect(json).toMatchObject({ status: 'MATCH', sha: 'abc123', node: 'v22.0.0' });
    expect(json.actualSha).toBe(sha256(normalizeReport(REPORT)));
    expect(json.baselineSha).toBe(json.actualSha);
    expect(readFileSync(box.summaryPath, 'utf8')).toMatch(/ベースラインと一致 \(MATCH\)/);
    expect(box.log.join('\n')).toMatch(/^BACKTEST MATCH: ベースラインと一致/);
    // The raw output is kept untouched, so a reader can see the real timings.
    expect(readFileSync(join(box.reportDir, 'backtest.md'), 'utf8')).toContain('1 ms total');
  });

  it('exits 1 on a mismatch, with the differing lines in the summary and the log', () => {
    const box = sandbox(REPORT);
    const code = check({
      baselinePath: box.baselinePath,
      reportDir: box.reportDir,
      run: () => ok(REPORT.replace('0.2312', '0.9999')),
      context: { node: 'v22.0.0', sha: null },
      log: (line) => box.log.push(line),
    });
    expect(code).toBe(1);
    expect(readFileSync(join(box.reportDir, 'summary.md'), 'utf8')).toMatch(/\+ \| ATDO \| game \| 312 \| 0\.9999/);
    expect(box.log.join('\n')).toMatch(/BACKTEST MISMATCH/);
  });

  it('--update writes the baseline from a good run and refuses a crashed one', () => {
    const box = sandbox(null);
    expect(check({ update: true, baselinePath: box.baselinePath, reportDir: box.reportDir, run: () => ok(withTimings(5, 6, 7)), log: () => undefined })).toBe(0);
    expect(readFileSync(box.baselinePath, 'utf8')).toBe(normalizeReport(REPORT));
    const before = readFileSync(box.baselinePath, 'utf8');
    expect(check({ update: true, baselinePath: box.baselinePath, reportDir: box.reportDir, run: () => ({ status: 1, stdout: '', stderr: 'x' }), log: () => undefined })).toBe(1);
    expect(readFileSync(box.baselinePath, 'utf8')).toBe(before);
  });
});

describe('the committed baseline', () => {
  const baseline = readFileSync(BASELINE_PATH, 'utf8');

  it('is a complete report with every required section', () => {
    for (const section of REQUIRED_SECTIONS) expect(baseline, section).toContain(section);
  });

  it('is stored normalized, so no machine timing is baked in', () => {
    expect(normalizeReport(baseline)).toBe(baseline);
    expect(baseline).toContain('<ms> ms total');
    expect(baseline).not.toMatch(/\d+ ms total/u);
  });
});
