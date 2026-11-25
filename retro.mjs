// retro.mjs — CLI: per-pipeline metrics retro. Reads logs/*.json for a pipeline and feeds the
// SHARED retro brain (retro-core.mjs) — the same loop qc.mjs uses for its findings. One brain,
// two signal sources. Posts to the retro Telegram topic.
//   node retro.mjs --pipeline registry|revenue [--dry]
// The `weekly` and `daily` pipelines retired 2026-10-06 with their engines (deleted; see git history).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, LLM_KEYS, HERE_DIR, flushLlmSpend } from './lib.mjs';
import { runRetro } from './retro-core.mjs';
import { normalizeRunStatus } from './checks.mjs'; // retires the legacy NO_SCHEDULE label on read

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const PIPELINE = flag('pipeline', 'registry');

const MAPS = {
  revenue: `Revenue tracker: joins Levanta conversions + Gumroad sales by per-thread subid -> per-thread revenue report. Metrics: tracked-thread count, total revenue, Gumroad net, tagged-sale count.`,
  registry: `Registry sync: Typefully spine + ledger + analytics + Levanta/Gumroad revenue -> "Published Content"; Status is lifecycle-only (Draft/Scheduled/Posted/Reposted — the Winner/Repost Candidate flags retired 2026-09-02 with the farm; performance judgment lives in harvest-gate.mjs over the Harvests table, so never propose re-adding a winner flag here); warns on untracked manual posts. Metrics: row count, posted, reposted, untracked.`,
  harvest: `Harvest engine: detects own-page breakouts (>=3x baseline AND >=500k views), generates 3 ~95% hook variations, schedules into the 9pm slot. Metrics: breakouts found, varied, scheduled.`,
};

// ---- run-log signal hygiene (IMPROVEMENTS 2026-07-30) ---------------------------------------------
// The retro brain reasons about what it is handed, so a malformed or empty signal is worse than no
// signal: it invents root causes for a defect that is really in the READER. Two guards:
//   isMetricsObject — a run log must be a plain JSON object. An array, a bare number, or a
//     JSON-encoded string is a broken emitter; `latest` throws rather than feeding the model junk.
//   runSummary      — the old `recent` line was `${log.ok ?? '?'} ok`, but NO pipeline has ever
//     written an `ok` field (daily/registry/performance/learn all emit their own metric names), so
//     EVERY historical line rendered as "daily-2026-07-30.json: ? ok" — a permanently dead signal
//     the model has been reading as a real (and alarming) datum. Summarize by the outcome fields the
//     logs actually carry instead, in a stable precedence, and never emit a bare "?".
const isMetricsObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const OUTCOME_KEYS = ['status', 'ok', 'scheduled', 'posted', 'rows', 'winners', 'threads', 'untracked', 'alarms'];
//   normalizeRunStatus — a pre-2026-08-02 daily log still carries the retired `NO_SCHEDULE` label, and
//     the retro reads the last four runs, so those stale logs kept re-proposing the split that already
//     shipped. Re-derive the real label (NO_SLOTS vs ALL_FAILED) on read; every reader sees one schema.
function readRunLog(path) {
  try { return normalizeRunStatus(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}
function runSummary(log) {
  if (!isMetricsObject(log)) return 'unreadable (not a JSON metrics object)';
  const parts = OUTCOME_KEYS.filter((k) => log[k] !== undefined && log[k] !== null).map((k) => `${k}=${log[k]}`);
  return parts.length ? parts.join(' ') : `no outcome fields (keys: ${Object.keys(log).slice(0, 6).join(',') || 'none'})`;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, [LLM_KEYS, ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const logDir = join(HERE_DIR, 'logs');
  if (!existsSync(logDir)) throw new Error('No logs/ yet — run a pipeline first.');
  const files = readdirSync(logDir).filter((f) => f.startsWith(PIPELINE)).sort();
  if (!files.length) throw new Error(`No ${PIPELINE} run logs found.`);
  const latest = readRunLog(join(logDir, files[files.length - 1]));
  if (!isMetricsObject(latest)) throw new Error(`Latest ${PIPELINE} log (${files[files.length - 1]}) is not a JSON metrics object — refusing to retro on a malformed signal.`);
  const recent = files.slice(-4, -1).map((f) => `${f}: ${runSummary(readRunLog(join(logDir, f)))}`);

  const { improvements, applied, err } = await runRetro(env, {
    source: `${PIPELINE} pipeline`,
    context: MAPS[PIPELINE] || `Pipeline "${PIPELINE}" — infer from the metrics.`,
    signals: { latest, recent },
    dry: DRY, post: true,
  });
  if (err) { console.log(`Retro error: ${err}`); return; }
  console.log(`Retro (${PIPELINE}): ${improvements.length} improvement(s)${applied.length ? `, ${applied.length} auto-applied` : ''}${DRY ? ' [dry]' : ''}`);
  improvements.forEach((i) => console.log(`  [${i.severity}] ${i.title} (${i.type})`));
}
// Spend flushes on success AND failure (flushLlmSpend never throws; exit-1 contract untouched).
main()
  .then(() => flushLlmSpend(null, 'retro', PIPELINE))
  .catch(async (e) => { console.error('ERROR:', e.stack || e.message); await flushLlmSpend(null, 'retro', `${PIPELINE} · crashed`); process.exit(1); });
