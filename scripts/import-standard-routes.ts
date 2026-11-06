/**
 * Imports the standard checkout routes (基準ルート) of 01 Arrangement Support
 * (https://github.com/chihirohashimotoac-coder/01ArrangementSupport) into
 * src/features/matches/standardRoutes.generated.ts.
 *
 *   npx tsx scripts/import-standard-routes.ts <path to a checkout of 01ArrangementSupport>
 *
 * It runs that repository's own accessors (`getStandardRoute`, `getStandardRouteFor`), so the
 * routes are exactly the ones it shows — Excel first candidates for 41–170, the approved rules
 * for 2–40 and for two darts left at 51–70 — and records where each came from. Nothing is
 * edited by hand; re-run to update.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] ?? '');
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
const origin = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin']).toString().trim();
if (!/01arrangementsupport/iu.test(origin)) throw new Error(`not 01ArrangementSupport: ${origin}`);

type Entry = { left: number; darts: readonly { id: string }[]; source: string; reviewStatus: string };
const module = (await import(pathToFileURL(resolve(repo, 'src/data/standardCheckoutRoutes.ts')).href)) as {
  getStandardRoute(left: number): Entry | null;
  getStandardRouteFor(left: number, darts: number): Entry | null;
};

const three: string[] = [];
const two: string[] = [];
for (let left = 2; left <= 170; left += 1) {
  const entry = module.getStandardRoute(left);
  if (entry) three.push(`  ${left}: { route: ${JSON.stringify(entry.darts.map((dart) => dart.id))}, source: '${entry.source}', review: '${entry.reviewStatus}' },`);
  const twoDarts = module.getStandardRouteFor(left, 2);
  if (twoDarts && twoDarts.source !== entry?.source && twoDarts.darts.length <= 2) {
    two.push(`  ${left}: { route: ${JSON.stringify(twoDarts.darts.map((dart) => dart.id))}, source: '${twoDarts.source}', review: '${twoDarts.reviewStatus}' },`);
  }
}

const out = `/**
 * 自動生成ファイル — 直接編集しないこと (scripts/import-standard-routes.ts で再生成)。
 *
 * 基準ルート (Standard Route): 01 Arrangement Support の基準ルートをそのまま取り込んだもの。
 *   出典   : ${origin.replace(/\.git$/u, '')}
 *   commit : ${commit}
 *   取得元 : src/data/standardCheckoutRoutes.ts (getStandardRoute / getStandardRouteFor)
 *   source : excel-first-candidate = 41〜170 の Excel 第1候補 (source of truth)
 *            derived-rule-v1       = 2〜40 の導出ルール (人間承認 v1)
 *            derived-two-dart-v2   = 残り 2 本・51〜70 の切り替え (人間承認 v2)
 *   表記   : S/D/T + 数字、SB = シングルブル (25)、BULL = ダブルブル (50)
 * 「PDC 公式ルート」ではなく「基準ルート」と呼ぶ (出典元の docs/CHECKOUT_DATA_POLICY.md)。
 */

export interface StandardRoute {
  readonly route: readonly string[];
  readonly source: 'excel-first-candidate' | 'derived-rule-v1' | 'derived-two-dart-v2';
  readonly review: string;
}

export const STANDARD_ROUTES_COMMIT = '${commit}';

/** Three darts in hand: every finishable LEFT 2〜170 (bogey numbers are absent). */
export const STANDARD_ROUTES: Readonly<Record<number, StandardRoute>> = {
${three.join('\n')}
};

/** Two darts in hand: only where the route differs from the three-dart one. */
export const STANDARD_ROUTES_TWO_DARTS: Readonly<Record<number, StandardRoute>> = {
${two.join('\n')}
};
`;
writeFileSync(resolve('src/features/matches/standardRoutes.generated.ts'), out);
console.log(`wrote ${three.length} three-dart and ${two.length} two-dart routes from ${commit}`);
