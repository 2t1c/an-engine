// fuel-scorecard.mjs — the v1-vs-v2 ladder comparison, keyed on the Fuel Log `Ladder Version` stamp
// (blank = pre-2026-09-05 ladder, "v2 · 2026-09-05" = the operator's spreadsheet ladder). Same
// window either side of the cutover, holdouts excluded, views from the Growth Log at +6h and +24h.
//
//   node fuel-scorecard.mjs                          # print
//   node fuel-scorecard.mjs --v1-days 14 --send      # post to the Fuel topic (the weekly cron does this)
//   node fuel-scorecard.mjs --json
import { loadEnv, requireEnv, telegram, report, logRun, runMain, cliArg } from './lib.mjs';
const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
import { scorecard, formatScorecard, CUTOVER_V2 } from './fuel-ops-core.mjs';
import { fuelRows, growthSnaps } from './fuel-ops-io.mjs';

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const cutover = cliArg('cutover', CUTOVER_V2), v1Days = Number(cliArg('v1-days', 14));
  const since = new Date(Date.parse(cutover) - (v1Days + 2) * 864e5).toISOString();
  const [fuel, snaps] = await Promise.all([fuelRows(env), growthSnaps(env, since)]);
  const sc = scorecard(fuel, snaps, { cutover, v1Days });
  const text = report({ emoji: '📊', title: 'Ladder scorecard', scope: 'v1 vs v2', sections: [{ body: formatScorecard(sc) }],
    action: sc.v2.threads < 40 ? `${sc.v2.threads} v2 threads so far — read as a trend, not a verdict, until ~40.` : '' });
  if (process.argv.includes('--json')) console.log(JSON.stringify(sc, null, 2));
  else console.log(plain(text));
  if (process.argv.includes('--send')) await telegram(env, text, 'fuel');
  await logRun('fuel-scorecard', { v1: sc.v1.threads, v2: sc.v2.threads, v1Spend: sc.v1.spendPerThread, v2Spend: sc.v2.spendPerThread, v2Views24: sc.v2.medianViews24h });
}, 'fuel-scorecard');
