// mold-promote.mjs — the promotion half of the operator's loop: "mostly mold -> experiment -> an
// experiment that converts is promoted into the library as a template -> scale its quantity."
//
// Reads ledger rows stamped with a moldId (the mold lane stamps one per generated thread), joins
// each to its Published Content row for realized views + commission, groups by mold, and applies
// checks.mjs's moldStatusChange — the same pure function the tests pin down — to flip status in
// molds.json. Experimental molds that cleared promote_rev_per_1k over min_posts become proven with
// their measurement recorded; proven molds that decayed below demote_rev_per_1k are flagged (status
// flip to experimental + a loud note), never silently dropped.
//
// Runs as a step of the learn workflow (after registry-sync, so Airtable views are current).
// Idempotent: same inputs -> same molds.json. No-ops cleanly while no ledger row carries a moldId.
//   node mold-promote.mjs          # apply + print
//   node mold-promote.mjs --dry    # print only
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, logRun, runMain, HERE_DIR } from './lib.mjs';
import { MOLDS, MOLD_THRESHOLDS, moldStatusChange } from './checks.mjs';
import { REGISTRY_TABLE } from './config.mjs';

const DRY = process.argv.includes('--dry');
const TODAY = new Date().toISOString().slice(0, 10);

// Pure core: ledger rows + a draftId->outcome map -> per-mold outcome lists.
// ONE DRAFT, ONE OUTCOME (fixed 2026-08-25). This iterated ledger ROWS, and a draft owns several:
// the mint row, the publish row, an extra attribution row per product beyond the second, and any
// correction row appended later. Every one of them re-counted that draft's views AND revenue, so a
// mold's score scaled with how many products it plugged and how often it was repaired rather than
// with how it performed. Measured live: 1.2x-1.5x inflation across M0/M1/M2/M3/M5, and M4 — the
// best-converting mold, with exactly one row per draft — was the only one NOT inflated, so the
// bug actively ranked the honest mold last. Dedupe by draftId; a later row wins the mold stamp.
export function moldOutcomes(ledgerRows, outcomeByDraft) {
  const moldOf = new Map();
  for (const e of ledgerRows) {
    if (!e?.moldId || !e.draftId) continue;
    if (!outcomeByDraft.has(String(e.draftId))) continue; // not published / not synced — not an outcome
    moldOf.set(String(e.draftId), e.moldId);
  }
  const byMold = new Map();
  for (const [draftId, moldId] of moldOf) {
    const o = outcomeByDraft.get(draftId);
    if (!byMold.has(moldId)) byMold.set(moldId, []);
    byMold.get(moldId).push({ views: o.views, revenue: o.revenue, clicks: o.clicks || 0, draftId });
  }
  return byMold;
}

// The scorecard, computed the same way everywhere it is read. clicksPer100k is the operator's chosen
// yardstick (2026-08-25: revenue attribution "could be wrong", the store-side click counter is what
// we aim at), so it is recorded alongside revenue rather than instead of it.
export function moldScore(outcomes = []) {
  const posts = outcomes.length;
  const views = outcomes.reduce((s, o) => s + (Number(o.views) || 0), 0);
  const revenue = outcomes.reduce((s, o) => s + (Number(o.revenue) || 0), 0);
  const clicks = outcomes.reduce((s, o) => s + (Number(o.clicks) || 0), 0);
  return {
    posts,
    views,
    revenue: Number(revenue.toFixed(2)),
    clicks,
    revPer1k: views ? Number((revenue / (views / 1000)).toFixed(3)) : 0,
    clicksPer100k: views ? Number((clicks / (views / 100000)).toFixed(1)) : 0,
  };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);

  const ledger = existsSync(join(HERE_DIR, 'ledger.jsonl'))
    ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const stamped = ledger.filter((e) => e.moldId);
  if (!stamped.length) { console.log('no ledger rows carry a moldId yet — nothing to measure'); return; }

  // Published outcomes by draft id (views + commission), straight from the registry table.
  const outcomeByDraft = new Map();
  let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(REGISTRY_TABLE)}`);
    u.searchParams.set('pageSize', '100');
    // Lifetime first (docs/money-columns.md): a mold is promoted or demoted on revenue per 1k
    // views, so reading the 59-day `Commission` demoted proven molds purely because their posts
    // aged past the window. The windowed pair stays as the fallback for rows with no lifetime cell.
    ['Draft ID', 'Impressions', 'Lifetime Commission', 'Commission', 'Lifetime Clicks', 'Affiliate Clicks'].forEach((f) => u.searchParams.append('fields[]', f));
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`registry fetch -> ${r.status}`);
    const j = await r.json();
    for (const rec of j.records) {
      const id = String(rec.fields['Draft ID'] || '');
      if (id) outcomeByDraft.set(id, {
        views: Number(rec.fields.Impressions) || 0,
        revenue: Number(rec.fields['Lifetime Commission'] ?? rec.fields.Commission) || 0,
        clicks: Number(rec.fields['Lifetime Clicks'] ?? rec.fields['Affiliate Clicks']) || 0,
      });
    }
    offset = j.offset;
  } while (offset);

  const byMold = moldOutcomes(stamped, outcomeByDraft);
  const file = join(HERE_DIR, 'molds.json');
  const { changes, text } = nextMoldsFile(readFileSync(file, 'utf8'), byMold, TODAY);

  for (const [id, list] of byMold) console.log(`${id}: ${list.length} measured post(s)`);
  if (!changes.length) console.log('no status changes');
  for (const c of changes) console.log(c);
  if (text == null) { console.log('molds.json unchanged'); return; }
  if (DRY) { console.log('(dry — molds.json untouched)'); return; }
  writeFileSync(file, text);
  logRun('mold-promote', { measured: [...byMold.keys()].length, changes: changes.length, detail: changes.join(' | ') });
}

// Pure: molds.json text in -> { changes, text } out, text null when nothing moved.
// Save the scorecard every run (fixed 2026-09-23). main() used to return on "no status changes"
// before writing, so the every-run scorecard applyMoldScores refreshes never reached molds.json
// unless a status flipped. Now any scorecard or status change is written; a run that moves nothing
// leaves the file (and meta.updated) untouched.
export function nextMoldsFile(raw, byMold, today) {
  const doc = JSON.parse(raw);
  const changes = applyMoldScores(doc, byMold, today);
  if (JSON.stringify(doc, null, 1) + '\n' === raw) return { changes, text: null };
  doc.meta.updated = today;
  return { changes, text: JSON.stringify(doc, null, 1) + '\n' };
}

// Pure: refresh every measured mold's scorecard and apply status flips, in place on the molds.json
// doc. Returns the status-change lines (empty when nothing flipped). Exported for tests.
export function applyMoldScores(doc, byMold, TODAY) {
  const changes = [];
  for (const mold of doc.molds) {
    const outcomes = byMold.get(mold.id) || [];
    // Write the scorecard EVERY run, not only when the status flips (fixed 2026-08-25). Before this,
    // `measured` was frozen at whatever the numbers were on the day a mold was last promoted or
    // demoted, so the library carried figures years-stale next to fresh ones and every reader —
    // including the planner and any human reading molds.json — ranked molds on a mix of the two.
    const score = moldScore(outcomes);
    // scoredFrom is replaced too: the hand-scored 2026-09-07 label would otherwise sit on registry figures.
    if (score.posts) mold.measured = { ...(mold.measured || {}), ...score, scoredOn: TODAY, scoredFrom: 'registry (mold-promote.mjs)' };
    const change = moldStatusChange(mold, outcomes);
    if (!change) continue;
    const { revenue, revPer1k } = score;
    if (change === 'promote') {
      mold.status = 'proven';
      mold.measured = { ...(mold.measured || {}), ...score, promoted: TODAY };
      changes.push(`PROMOTED ${mold.id} (${mold.name}): $${revPer1k}/1k over ${outcomes.length} posts (bar $${MOLD_THRESHOLDS.promote})`);
    } else {
      mold.status = 'experimental';
      mold.measured = { ...(mold.measured || {}), decayRevPer1k: revPer1k, demoted: TODAY };
      changes.push(`DEMOTED ${mold.id} (${mold.name}): decayed to $${revPer1k}/1k over ${outcomes.length} posts (floor $${MOLD_THRESHOLDS.demote})`);
    }
  }
  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'mold-promote');
