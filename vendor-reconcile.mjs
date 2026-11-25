// vendor-reconcile.mjs — PI's per-network Fuel Log lines against what the RT bot says it metered for
// the same days (GET /vendor-status, per-source tallies). Detect-and-report only: this never edits
// either ledger. Drift = a network PI billed itself for that the bot did not count (or count as
// skipped), or the reverse.
//
//   node vendor-reconcile.mjs              # yesterday + today (UTC), print
//   node vendor-reconcile.mjs --days 7
//   node vendor-reconcile.mjs --send       # post to the Fuel topic ONLY when there is drift
import { loadEnv, requireEnv, telegram, report, logRun, runMain, cliArg } from './lib.mjs';
import { lastLog, alertDelta } from './alert-delta.mjs';
const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
import { reconcile, formatReconcile, tallySince, utcDay } from './fuel-ops-core.mjs';
import { fuelRows, configRows, botStatus, vendorByChat } from './fuel-ops-io.mjs';

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID']);
  const n = Number(cliArg('days', 2));
  const days = Array.from({ length: n }, (_, i) => utcDay(new Date(Date.now() - i * 864e5).toISOString())).reverse();
  const [fuel, cfg] = await Promise.all([fuelRows(env), configRows(env)]);
  const { status, note } = await botStatus(cfg);
  if (!status) {
    console.log(`reconcile: no bot ledger — ${note}. Nothing compared.`);
    await logRun('vendor-reconcile', { days: days.join(','), bot: note, drift: null });
    return;
  }
  // The bot only tallies from its first boot with the tally code; PI lines older than that are not
  // drift, and a bot that has tallied nothing yet gives the window nothing to compare against.
  const since = tallySince(status);
  if (since === Infinity) {
    console.log('reconcile: the bot has tallied nothing for rt-bridge yet — nothing to compare.');
    await logRun('vendor-reconcile', { days: days.join(','), bot: 'no tallies yet', drift: null });
    return;
  }
  const rows = reconcile(fuel, status, { days, vendorByChat: vendorByChat() });
  const drift = rows.filter((r) => r.state === 'drift' || r.state === 'unknown-to-bot');
  const text = report({ emoji: drift.length ? '❗' : '🔁', title: 'Vendor reconcile', scope: `${days[0]} → ${days[days.length - 1]} (UTC) · bot tallies since ${new Date(since).toISOString().slice(0, 16)}Z`, sections: [{ body: formatReconcile(rows) }] });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.log(plain(text));
  // Since 2026-10-06 only NEW drift is sent (alert-delta.mjs): 18-33 of 17-34 lines drifted every day
  // for a month, so the daily message carried no news. --always sends the full table regardless.
  const driftKeys = [...new Set(drift.map((r) => `${r.vendor}:${r.state}`))].sort(); // no day: the window rolls daily
  const delta = alertDelta(lastLog('vendor-reconcile')?.driftKeys, driftKeys);
  if (process.argv.includes('--send') && drift.length && (delta.changed || process.argv.includes('--always'))) await telegram(env, text, 'fuel');
  else if (process.argv.includes('--send') && drift.length) console.log(`(--send: no new drift since last run, ${drift.length} standing — nothing sent)`);
  await logRun('vendor-reconcile', { days: days.join(','), lines: rows.length, drift: drift.length, newDrift: delta.fresh.length, driftKeys });
}, 'vendor-reconcile');
