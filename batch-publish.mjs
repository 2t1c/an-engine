#!/usr/bin/env node
// batch-publish.mjs <dir> --grid <key=HH:MM,...> [--day YYYY-MM-DD] [--dry] — ship a folder of specs,
// each at its own slot time, through publish-thread.mjs.
//
// publish-thread already has `--dir`, which ships every spec in a folder UNSCHEDULED. A cover day
// needs the other thing: each account at its own minute inside the cover window, which meant calling
// publish-thread 42 times by hand on 2026-09-03 and reading 42 blocks of output for the one line that
// mattered. This does that loop and prints one line per thread.
//
//   node batch-publish.mjs queues/batch/2026-09-04 --plan queues/run-2026-09-04.json
//   node batch-publish.mjs queues/batch/2026-09-04 --grid camila=06:00,clara=06:07 --dry # preview
//   node batch-publish.mjs queues/batch/2026-09-04 --plan ... --dry     # validate every spec, write nothing
//
// PREFER --plan. The run plan carries its own `grid` (see slots.mjs coverGrid), so the minute a page
// posts at is derived once, written down, and identical on every day of the batch. --grid stays for
// dry preview; effectful runs require saved day rows to checkpoint outcomes. A hand-typed grid
// can drift when a second writer types a different schedule.
//
// It never invents a time. A spec with no entry in the grid is SKIPPED and named, because the
// alternative — defaulting to some minute — is how two accounts end up sharing a slot.
//
// With a saved plan, confirmed drafts and unresolved intents are skipped or held on reruns. With --plan, a spec whose plan row (same account, same bucket, same day)
// already carries a draftId is SKIPPED and named — ship-day.mjs stamps that id after every publish —
// and a spec the plan has no row for is skipped too. A plan with no rows for the day ships the
// folder only in dry mode. Effectful runs require saved day rows.
//
// publish-thread stays the only thing that talks to Typefully and the only thing that writes the
// ledger. This is a loop around it, deliberately: the 2026-09-03 subid repair exists because a
// scratchpad publisher wrote thread rows without subid1, and nothing here re-implements that path.
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runResultChild } from './process-result.mjs';
import { pathToFileURL } from 'node:url';
import { HERE_DIR } from './lib.mjs';
import { resolveAccountKey } from './accounts.mjs';

/** PURE. A run plan's grid as the same Map parseGrid returns, so the two sources are interchangeable
 *  downstream. A plan with no `grid` is not an error here — main() says so and stops. */
export function gridFromPlan(plan) {
  const g = plan?.grid;
  if (!g || typeof g !== 'object') return null;
  return parseGrid(Object.entries(g).map(([k, v]) => `${k}=${v}`).join(','));
}

/** PURE. "a=06:00,b=07:10" -> Map. Rejects a malformed entry loudly rather than dropping it. */
export function parseGrid(s) {
  const grid = new Map();
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9_-]+)=([0-2]\d:[0-5]\d)$/);
    if (!m) throw new Error(`bad grid entry "${part}" — expected key=HH:MM`);
    if (grid.has(m[1])) throw new Error(`grid names ${m[1]} twice`);
    grid.set(m[1], m[2]);
  }
  const times = [...grid.values()];
  const dup = times.find((t, i) => times.indexOf(t) !== i);
  if (dup) throw new Error(`grid puts two accounts at ${dup} — a shared minute is a double-booking`);
  return grid;
}

/** PURE. The day a spec belongs to: --day wins, else the YYYY-MM-DD prefix of its filename. */
export function dayOf(file, override = null) {
  if (override) return override;
  const m = basename(file).match(/^(\d{4}-\d\d-\d\d)/);
  return m ? m[1] : null;
}

/** PURE. Which bucket a spec ships into, in the run plan's vocabulary (cover / harvest / pot). */
export const bucketOf = (spec = {}) => (spec.potOf ? 'pot' : (spec.harvestOf || spec.variationOf) ? 'harvest' : 'cover');

/** PURE. The plan row a spec fills on `day` (same account, same bucket), or null when the plan has
 *  no such row. Returns undefined when the plan carries no rows for the day at all, so a grid-only
 *  plan keeps shipping a folder exactly as before.
 *
 *  Why this exists (2026-09-07): a second `batch-publish` over a folder created every draft a second
 *  time — nothing remembered what had shipped except the operator. The plan row's `draftId` is that
 *  memory: ship-day stamps it after every publish, and a spec whose row already carries one is
 *  SKIPPED here, by name. A spec with no row is skipped too: the plan is the ledger of what ships,
 *  and a file that is not in it does not ship because it happens to sit in the folder. */
export function shippedRow(plan, day, key, bucket) {
  const rows = plan?.days?.[day];
  if (!Array.isArray(rows)) return undefined;
  return rows.find((r) => r.account === key && r.bucket === bucket) || null;
}

/** PURE. The indent a JSON file is already stored with, from its first indented line. */
export function detectIndent(text, fallback = 2) {
  const m = String(text || '').match(/\n([ \t]+)\S/);
  if (!m) return fallback;
  return m[1][0] === '\t' ? '\t' : m[1].length;
}

// Atomic within one filesystem; independent writers still require the state authority pilot.
//
// KEEP THE FILE'S OWN INDENTATION (2026-09-17). This wrote `null, 2` unconditionally while the run
// plans are stored at one space, so every publish reformatted all 1,500 lines of the plan it was
// only stamping draft ids onto. The cost is not cosmetic: the reformat took one run's diff to
// 1,498 additions and 1,264 deletions against a real change of 324 and 90, and GitHub omits the
// `patch` for a file that size — which auto-merge-evidence refuses outright, correctly, because
// nobody can review a diff that was never sent. A run's own publish step was making its plan
// unreviewable. Reading the indent back off the file keeps that decision with whoever created it.
export function writeBatchPlan(file, plan) {
  const destination = resolve(file);
  let indent = 2;
  try { indent = detectIndent(readFileSync(destination, 'utf8')); } catch { /* new file: 2 is fine */ }
  const temp = mkdtempSync(join(dirname(destination), '.batch-plan-'));
  try {
    const path = join(temp, 'plan.json');
    writeFileSync(path, JSON.stringify(plan, null, indent) + '\n', { mode: 0o600 });
    renameSync(path, destination);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** PURE. The plan row's approved `at`, normalised to a UTC minute, or a hold when it cannot be used. */
export function rowAt(row, day) {
  if (!row?.at) return { at: null, hold: null };
  const ms = Date.parse(row.at);
  if (!Number.isFinite(ms) || ms % 60_000) return { at: null, hold: 'ROW_AT_INVALID' };
  if (new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10) !== day) return { at: null, hold: 'ROW_AT_OFF_DAY' };
  return { at: new Date(ms).toISOString().replace('.000Z', 'Z'), hold: null };
}

export function recordBatchOutcome(plan, result) {
  const row = shippedRow(plan, result.day ?? result.at?.slice(0, 10), result.key, result.bucket);
  if (!row || result.skip) return;
  row.processOutcome = { operationKey: result.operationKey, phase: result.phase, error: result.error || null };
  if (result.draftId) {
    if (row.draftId && String(row.draftId) !== String(result.draftId)) throw new Error('Conflicting confirmed draft IDs; reconcile the plan');
    row.draftId = result.draftId;
    if (result.shareUrl) row.shareUrl = result.shareUrl;
  }
}

export async function publishBatch({ dir, grid, runPlan = null, day: dayOverride = null, dry = false,
  execute = runResultChild, onRow = () => {}, log = console.log, resultRoot = join(HERE_DIR, '.process-results') }) {
  if (!(grid instanceof Map)) throw new Error('A slot grid is required');
  const timedRows = Object.values(runPlan?.days || {}).flat().some((row) => row?.at);
  if (!grid.size && !timedRows) throw new Error('A non-empty slot grid (or plan rows carrying their approved `at`) is required');
  if (!dry && !runPlan?.days) throw new Error('Effectful publishing requires a saved plan with day rows; use --dry to preview a grid');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

  const plan = [];
  let warnedNoRows = false;
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!spec.account || !Array.isArray(spec.tweets)) continue;
    const key = resolveAccountKey(spec.account) || String(spec.account);
    const hm = grid.get(key);
    const day = dayOf(f, dayOverride);
    if (!day) { plan.push({ f, key, skip: 'no day in the filename and no --day' }); continue; }
    // The plan remembers what shipped (see shippedRow). A grid-only plan (no rows for the day) is
    // told so once and the folder ships as it always did.
    const row = shippedRow(runPlan, day, key, bucketOf(spec));
    // THE APPROVED MINUTE WINS (R1, 2026-09-23). A plan row that carries `at` — the exact time the
    // owner approved at the brief and stop 5 verified — is published at that minute. The grid is only
    // the fallback for a row without one; writing plan.grid over an approved time is how the approved
    // time and the written time came apart.
    const timed = rowAt(row, day);
    const at = timed.at ?? (hm ? `${day}T${hm}:00Z` : null);
    if (!at && !timed.hold) { plan.push({ f, key, skip: 'no grid entry' }); continue; }
    if (!dry && row === undefined) throw new Error('Effectful publishing requires saved plan rows for every day');
    if (row === null) { plan.push({ f, key, skip: `not in the plan: no ${bucketOf(spec)} row for ${key} on ${day}` }); continue; }
    if (row?.processOutcome && (['started', 'unknown'].includes(row.processOutcome.phase) || (row.processOutcome.phase === 'confirmed' && row.processOutcome.error))) {
      plan.push({ f, key, day, bucket: bucketOf(spec), at: at ?? row.at, hold: 'RECONCILIATION_REQUIRED', operationKey: row.processOutcome.operationKey }); continue;
    }
    if (row?.draftId) { plan.push({ f, key, skip: `already shipped as draft ${row.draftId}` }); continue; }
    if (timed.hold) { plan.push({ f, key, day, bucket: bucketOf(spec), at: row.at, hold: timed.hold }); continue; }
    if (runPlan && row === undefined && !warnedNoRows) { warnedNoRows = true; log(`plan has no rows for ${day} — nothing to reconcile, shipping the folder as listed`); }
    plan.push({ f, key, day, bucket: bucketOf(spec), at });
  }
  // Publish in slot order, earliest first, so an interrupted run has always shipped the threads with
  // the least time left before they fire.
  plan.sort((a, b) => String(a.at || '~').localeCompare(String(b.at || '~')));

  const minutes = new Map();
  for (const row of plan.filter(row => !row.skip && !row.hold)) {
    if (minutes.has(row.at) && minutes.get(row.at) !== row.key) throw new Error(`plan puts ${minutes.get(row.at)} and ${row.key} at ${row.at} — a shared minute is a double-booking`);
    minutes.set(row.at, row.key);
  }
  const intents = new Set();
  for (const row of plan.filter(row => !row.skip)) {
    const identity = JSON.stringify([runPlan?.batch || 'grid', row.key, row.bucket, row.at]);
    if (intents.has(identity)) throw new Error('Multiple specs target the same plan slot');
    intents.add(identity);
    row.operationKey ||= `batch:${createHash('sha256').update(identity).digest('hex')}`;
  }
  const rows = [];
  let stopped = false;
  for (const row of plan) {
    if (row.skip) { log(`SKIP ${row.key.padEnd(9)} ${row.skip}`); rows.push(row); continue; }
    if (row.hold || stopped) {
      const result = { ...row, ok: false, phase: 'unknown', error: row.hold || 'BATCH_STOPPED' };
      rows.push(result);
      log(`HOLD ${row.key.padEnd(9)} ${result.error}`);
      stopped = true; continue;
    }
    // Record intent before the child can create. A rerun of this same plan holds an unresolved slot.
    // This local checkpoint does not coordinate separate runners or bypass provider reconciliation.
    if (!dry) await onRow({ ...row, ok: false, phase: 'started', error: null });
    const outcome = await execute(join(HERE_DIR, 'publish-thread.mjs'),
      ['--file', resolve(dir, row.f), '--at', row.at, ...(dry ? ['--dry'] : [])],
      { operationKey: row.operationKey, cwd: HERE_DIR, timeout: 280000, resultRoot });
    const good = outcome.ok && outcome.phase === (dry ? 'validated' : 'confirmed');
    const result = { ...row, ok: good, phase: outcome.phase, error: outcome.error,
      draftId: outcome.result?.draftId || null, shareUrl: outcome.result?.shareUrl || null, evidencePath: outcome.evidencePath };
    rows.push(result);
    if (!dry) await onRow(result);
    log(`${good ? 'OK  ' : 'FAIL'} ${row.key.padEnd(9)} ${row.at}  ${result.draftId ? `Draft created: ${result.draftId}` : result.phase}${result.error ? ` (${result.error})` : ''}`);
    if (result.evidencePath) log(`       receipt: ${result.evidencePath}`);
    if (!good && ['unknown', 'confirmed', 'started'].includes(outcome.phase)) stopped = true;
  }
  const failed = rows.filter(row => !row.skip && !row.ok);
  log(`\n${rows.filter(row => row.ok).length} ${dry ? 'validated' : 'shipped'}, ${failed.length} failed or held, ${rows.filter(row => row.skip).length} skipped`);
  return { schemaVersion: 1, ok: failed.length === 0, rows };
}

async function main() {
  const dir = process.argv[2];
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  if (!dir || (!arg('grid') && !arg('plan'))) { console.error('usage: node batch-publish.mjs <dir> (--plan <run.json> | --grid <key=HH:MM,...>) [--day YYYY-MM-DD] [--dry]'); process.exit(2); }
  const dry = process.argv.includes('--dry');
  let grid, runPlan = null;
  if (arg('plan')) {
    runPlan = JSON.parse(readFileSync(arg('plan'), 'utf8'));
    grid = gridFromPlan(runPlan);
    if (!grid) { console.error(`${arg('plan')} has no \`grid\` — add one (slots.mjs coverGrid) or pass --grid`); process.exit(2); }
    console.log(`grid from ${arg('plan')} — ${grid.size} account(s)`);
  } else grid = parseGrid(arg('grid'));
  const result = await publishBatch({ dir, grid, runPlan, day: arg('day'), dry,
    onRow: row => { if (runPlan) { recordBatchOutcome(runPlan, row); writeBatchPlan(arg('plan'), runPlan); } } });
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Batch publishing failed. Effectful runs require a saved plan with day rows; inspect plan checkpoints and process receipts before retrying.'); process.exitCode = 1;
});
