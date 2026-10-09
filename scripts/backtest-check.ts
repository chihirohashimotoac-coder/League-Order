/**
 * Backtest evidence check (`npm run backtest:check`).
 *
 * `npm run backtest` prints a report and exits 0 whatever it says, so on its own it proves
 * nothing to a reviewer. This runs it, compares the result with the committed baseline
 * (`scripts/backtest.baseline.md`) and leaves the evidence behind in `backtest-report/`:
 *
 *   backtest.md             the raw report as printed
 *   backtest.normalized.md  the report with the machine-dependent lines masked
 *   backtest.baseline.md    the baseline it was compared with
 *   summary.md / .json      MATCH or MISMATCH, both sha256, the first differing lines
 *
 * Why it is safe to gate a release on: the report is deterministic. It uses fixture leagues
 * generated from fixed seeds (src/test/n01/generator.ts), a fixed clock, no network, and its
 * searches are bounded by node count, never by the clock (`UNTIMED` in backtest.ts). The only
 * numbers that vary between machines are the two wall-clock timing lines of section 4; they
 * are masked below and nothing else is. It writes only into `backtest-report/`.
 *
 * Exit code 0 = the report matches the baseline; 1 = it differs (or the backtest crashed).
 * A deliberate model change updates the baseline in the same commit: `npm run backtest:check -- --update`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = join(ROOT, 'scripts', 'backtest.baseline.md');
export const REPORT_DIR = join(ROOT, 'backtest-report');

/** The wall-clock lines of section 4, which differ on every run and every machine. */
const TIMING_MASKS: [RegExp, string][] = [
  [/^(- replay \(fetch \+ plan \+ intelligence\) of \d+ matches: )\d+ ms total$/u, '$1<ms> ms total'],
  [/^(- optimizer \(4 candidates\) per match: median )\d+ ms, max \d+ ms$/u, '$1<ms> ms, max <ms> ms'],
];

/** The report with line endings unified, trailing blanks dropped and the timing numbers masked. */
export function normalizeReport(text: string): string {
  const lines = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/\s+$/u, '');
      for (const [pattern, replacement] of TIMING_MASKS) if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement);
      return trimmed;
    });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface LineDifference {
  line: number;
  baseline: string | null;
  actual: string | null;
}

/** Differing lines, compared position by position (the report has a fixed layout), at most `limit`. */
export function differences(baseline: string, actual: string, limit = 40): { total: number; shown: LineDifference[] } {
  const a = baseline.split('\n');
  const b = actual.split('\n');
  const shown: LineDifference[] = [];
  let total = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    total += 1;
    if (shown.length < limit) shown.push({ line: i + 1, baseline: a[i] ?? null, actual: b[i] ?? null });
  }
  return { total, shown };
}

/** Sections the report must contain; a baseline or run missing one is not evidence of anything. */
export const REQUIRED_SECTIONS = [
  '# League Order — backtest report (fixture leagues)',
  '## 1. Prediction backtest',
  '## 2. Parameter grid',
  '## 3. Optimizer backtest',
  '## 3b. Sensitivity',
  '## 3c. Appearance-bias gate',
  '- requests: first sync',
  '- duplicate requests within one sync: 0',
];

export interface CheckResult {
  status: 'MATCH' | 'MISMATCH' | 'FAILED';
  message: string;
  actualSha: string | null;
  baselineSha: string | null;
  differing: { total: number; shown: LineDifference[] };
  missingSections: string[];
}

export interface BacktestRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `scripts/backtest.ts` exactly as `npm run backtest` does, without the npm banner. */
export function runBacktest(): BacktestRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'backtest.ts')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function compare(run: BacktestRun, baseline: string | null): CheckResult & { normalized: string } {
  const normalized = normalizeReport(run.stdout);
  const empty = { total: 0, shown: [] };
  if (run.status !== 0) {
    return {
      status: 'FAILED',
      message: `the backtest exited with status ${String(run.status)}: ${run.stderr.trim().split('\n').slice(0, 5).join(' | ') || '(no stderr)'}`,
      actualSha: null,
      baselineSha: baseline === null ? null : sha256(baseline),
      differing: empty,
      missingSections: [],
      normalized,
    };
  }
  const missingSections = REQUIRED_SECTIONS.filter((section) => !normalized.includes(section));
  if (missingSections.length > 0) {
    return {
      status: 'FAILED',
      message: `the report is missing ${missingSections.length} required section(s): ${missingSections.join('; ')}`,
      actualSha: sha256(normalized),
      baselineSha: baseline === null ? null : sha256(baseline),
      differing: empty,
      missingSections,
      normalized,
    };
  }
  if (baseline === null) {
    return {
      status: 'FAILED',
      message: 'scripts/backtest.baseline.md does not exist; create it with `npm run backtest:check -- --update`',
      actualSha: sha256(normalized),
      baselineSha: null,
      differing: empty,
      missingSections,
      normalized,
    };
  }
  const normalizedBaseline = normalizeReport(baseline);
  const actualSha = sha256(normalized);
  const baselineSha = sha256(normalizedBaseline);
  if (actualSha === baselineSha) {
    return {
      status: 'MATCH',
      message: `ベースラインと一致 / matches the baseline (${normalized.split('\n').length - 1} lines, sha256 ${actualSha})`,
      actualSha,
      baselineSha,
      differing: empty,
      missingSections,
      normalized,
    };
  }
  const differing = differences(normalizedBaseline, normalized);
  return {
    status: 'MISMATCH',
    message: `the report differs from the baseline in ${differing.total} line(s)`,
    actualSha,
    baselineSha,
    differing,
    missingSections,
    normalized,
  };
}

export function summaryMarkdown(result: CheckResult, context: { node: string; sha: string | null }): string {
  const lines = [
    `## Backtest vs baseline: ${result.status === 'MATCH' ? '✅ ベースラインと一致 (MATCH)' : `❌ ${result.status}`}`,
    '',
    result.message,
    '',
    '| | |',
    '|---|---|',
    `| report sha256 (normalized) | \`${result.actualSha ?? '—'}\` |`,
    `| baseline sha256 | \`${result.baselineSha ?? '—'}\` |`,
    `| commit | \`${context.sha ?? 'local'}\` |`,
    `| node | ${context.node} |`,
    '',
    'Only the two wall-clock timing lines of section 4 are masked; every other character is compared.',
  ];
  if (result.differing.shown.length > 0) {
    lines.push('', `First ${result.differing.shown.length} of ${result.differing.total} differing line(s):`, '', '```diff');
    for (const d of result.differing.shown) {
      lines.push(`@@ line ${d.line}`, `- ${d.baseline ?? '(missing)'}`, `+ ${d.actual ?? '(missing)'}`);
    }
    lines.push('```');
  }
  return `${lines.join('\n')}\n`;
}

export interface MainOptions {
  update?: boolean;
  baselinePath?: string;
  reportDir?: string;
  run?: () => BacktestRun;
  context?: { node: string; sha: string | null };
  /** Path GitHub Actions gives for the job summary. */
  stepSummaryPath?: string | null;
  log?: (line: string) => void;
}

/** Runs, compares, writes the evidence. Returns the process exit code. */
export function check(options: MainOptions = {}): number {
  const baselinePath = options.baselinePath ?? BASELINE_PATH;
  const reportDir = options.reportDir ?? REPORT_DIR;
  const log = options.log ?? ((line: string) => console.log(line));
  const context = options.context ?? { node: process.version, sha: process.env.GITHUB_SHA ?? null };
  const run = (options.run ?? runBacktest)();

  if (options.update) {
    const normalized = normalizeReport(run.stdout);
    if (run.status !== 0 || REQUIRED_SECTIONS.some((section) => !normalized.includes(section))) {
      log(`refusing to write a baseline from a failed or incomplete run (exit ${String(run.status)})`);
      return 1;
    }
    writeFileSync(baselinePath, normalized);
    log(`baseline written: ${baselinePath} (sha256 ${sha256(normalized)})`);
    return 0;
  }

  const baseline = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : null;
  const result = compare(run, baseline);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'backtest.md'), run.stdout);
  writeFileSync(join(reportDir, 'backtest.normalized.md'), result.normalized);
  if (baseline !== null) writeFileSync(join(reportDir, 'backtest.baseline.md'), normalizeReport(baseline));
  const summary = summaryMarkdown(result, context);
  writeFileSync(join(reportDir, 'summary.md'), summary);
  const { normalized: _normalized, ...json } = result;
  void _normalized;
  writeFileSync(join(reportDir, 'summary.json'), `${JSON.stringify({ ...json, ...context }, null, 2)}\n`);
  if (options.stepSummaryPath) writeFileSync(options.stepSummaryPath, summary, { flag: 'a' });

  log(`BACKTEST ${result.status}: ${result.message}`);
  for (const d of result.differing.shown.slice(0, 10)) log(`  line ${d.line}\n    baseline: ${d.baseline ?? '(missing)'}\n    actual:   ${d.actual ?? '(missing)'}`);
  log(`evidence: ${reportDir}`);
  return result.status === 'MATCH' ? 0 : 1;
}

// Run only as a script: the tests import `check` / `compare` and must not start a backtest.
const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = check({ update: process.argv.includes('--update'), stepSummaryPath: process.env.GITHUB_STEP_SUMMARY ?? null });
}
