#!/usr/bin/env node
// vendor-snapshot.mjs — date every change to the Fuel the Fire vendor roster.
//
// Editing a vendor's price in the Config table leaves no trace. That sounds harmless until you try
// to read a boost's economics months later: the T1-T5 ladder cost $100 on 2026-06-28 and $101.50 on
// 2026-07-26 with the IDENTICAL seven vendors in it, and the only way to discover that was to notice
// a total that had shifted and work backwards. Every efficiency figure computed from current prices
// silently restates history each time a price moves.
//
// So: snapshot the roster, diff it against the last snapshot, and write a row ONLY when something
// actually changed. A run that finds nothing writes nothing — the table is a change log, not a
// heartbeat, and a heartbeat would bury the four rows that matter under a thousand that do not.
//
// Fuel Log's `Tier Breakdown` already records what each vendor charged per fire, which is the
// authoritative per-fire price. This is the complement: it answers "when did this change and what
// was it before", which a per-fire ledger cannot, because a tier nobody fired for three weeks leaves
// no ledger lines at all.
//
//   node vendor-snapshot.mjs           # detect + record
//   node vendor-snapshot.mjs --dry     # print the diff, write nothing
import { loadEnv, requireEnv, airtable, telegram } from './lib.mjs';
import { TABLES } from './config.mjs';

const HISTORY_TABLE = 'tblvUIV7teNRDZ1Ae'; // Vendor Config History, in REGISTRY_BASE_ID
const TIERS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

/** A Config row is a send target if Fuel the Fire would actually message it. Mirrors the
 *  dashboard's `isTarget` exactly, so the two never disagree about what the ladder contains. */
function isTarget(f) {
  const name = String(f.Name ?? '');
  return /vendor/i.test(name) && name !== 'Vendor Bot' && Boolean(String(f['Chat ID'] ?? '').trim());
}

export function rosterOf(records) {
  return records
    .filter((r) => isTarget(r.fields))
    .map((r) => ({
      id: r.id,
      name: String(r.fields.Name ?? ''),
      tier: r.fields.Tier ? String(r.fields.Tier) : null,
      price: Number(r.fields.Price) || 0,
      networkSize: Number(r.fields['Network Size']) || 0,
      active: Boolean(r.fields.Active),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Cost of a full T1->T6 climb under this roster — the one number worth watching. */
export function ladderCost(roster) {
  return roster
    .filter((v) => v.active && v.tier && TIERS.includes(v.tier.toUpperCase()))
    .reduce((s, v) => s + v.price, 0);
}

/**
 * Field-level diff between two rosters.
 *
 * Keyed on record id, not name: renaming a vendor is a rename, and matching on name would report it
 * as one vendor vanishing and another appearing — losing the price history across the rename, which
 * is the only thing this file exists to preserve.
 */
export function diffRosters(prev, next) {
  const changes = [];
  const byId = new Map(prev.map((v) => [v.id, v]));
  const seen = new Set();
  for (const v of next) {
    seen.add(v.id);
    const old = byId.get(v.id);
    if (!old) {
      changes.push({ vendor: v.name, field: 'Added', old: '', new: `${v.tier ?? '—'} @ $${v.price.toFixed(2)}` });
      continue;
    }
    for (const [field, fmt] of [
      ['name', String], ['tier', (x) => x ?? '—'],
      ['price', (x) => `$${Number(x).toFixed(2)}`],
      ['networkSize', (x) => String(x)], ['active', (x) => (x ? 'yes' : 'no')],
    ]) {
      if (old[field] !== v[field]) {
        changes.push({ vendor: v.name, field: field === 'networkSize' ? 'Network Size' : field[0].toUpperCase() + field.slice(1), old: fmt(old[field]), new: fmt(v[field]) });
      }
    }
  }
  for (const v of prev) {
    if (!seen.has(v.id)) {
      changes.push({ vendor: v.name, field: 'Removed', old: `${v.tier ?? '—'} @ $${v.price.toFixed(2)}`, new: '' });
    }
  }
  return changes;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID']);

  const at = airtable(env);
  const records = await at.list(TABLES.config, { fields: ['Name', 'Tier', 'Price', 'Network Size', 'Active', 'Chat ID'], pageSize: 100 });
  const roster = rosterOf(records);
  const cost = ladderCost(roster);

  // Newest existing snapshot. The Snapshot column is authoritative; the per-field columns beside it
  // are a readable index and are never parsed back.
  const base = env.REGISTRY_BASE_ID;
  const url = `https://api.airtable.com/v0/${base}/${HISTORY_TABLE}?pageSize=1&sort%5B0%5D%5Bfield%5D=At&sort%5B0%5D%5Bdirection%5D=desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
  if (!res.ok) throw new Error(`history read -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const last = (await res.json()).records?.[0] ?? null;

  let prev = null;
  if (last?.fields?.Snapshot) {
    // A hand-edited or truncated Snapshot must not wedge the job forever. Treat it as no baseline:
    // the next run then records a fresh one, which is recoverable, where throwing every run is not.
    try { prev = JSON.parse(last.fields.Snapshot); } catch { prev = null; }
  }

  const changes = prev ? diffRosters(prev, roster) : [];
  const first = prev === null;

  if (!first && changes.length === 0) {
    console.log(`vendor-snapshot: no change (${roster.length} targets, full ladder $${cost.toFixed(2)})`);
    return;
  }

  const at_ = new Date().toISOString();
  const label = first
    ? `Baseline · ${roster.length} vendors · ladder $${cost.toFixed(2)}`
    : changes.length === 1
      ? `${changes[0].vendor} ${changes[0].field}: ${changes[0].old || '—'} → ${changes[0].new || '—'}`
      : `${changes.length} changes · ladder $${cost.toFixed(2)}`;

  console.log(`vendor-snapshot: ${label}`);
  for (const c of changes) console.log(`  ${c.vendor} · ${c.field}: ${c.old || '—'} -> ${c.new || '—'}`);
  if (dry) { console.log('(dry run — nothing written)'); return; }

  // One row per CHANGE, plus the full snapshot on each so any row can be read standalone. The
  // snapshot is duplicated deliberately: a change log whose rows only make sense in sequence is
  // unreadable the moment one row is deleted.
  const rows = (changes.length ? changes : [{ vendor: '', field: 'Baseline', old: '', new: '' }]).map((c) => ({
    fields: {
      Change: label, At: at_, Vendor: c.vendor, Field: c.field,
      Old: c.old, New: c.new,
      Snapshot: JSON.stringify(roster), 'Ladder Cost': cost,
    },
  }));

  // create(), not update(): these are new history rows, so the client deliberately does NOT replay
  // them on a 5xx — a duplicated entry in the table that exists to be a trustworthy record is worse
  // than a missing one, and this job writes only on change and re-diffs from Airtable next run.
  await airtable(env, base).create(HISTORY_TABLE, rows);
  console.log(`vendor-snapshot: wrote ${rows.length} row(s)`);

  // A price change is money and the operator did not necessarily make it — vendors raise prices.
  // The baseline is not news, so it never sends.
  if (!first && changes.some((c) => ['Price', 'Added', 'Removed', 'Tier'].includes(c.field))) {
    const lines = changes.map((c) => `• ${c.vendor} — ${c.field}: ${c.old || '—'} → ${c.new || '—'}`);
    await telegram(env, [
      '*Fuel vendor config changed*',
      ...lines,
      '',
      `Full T1–T6 ladder now *$${cost.toFixed(2)}*`,
    ].join('\n'), 'ops').catch((e) => console.error('telegram:', e.message));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('vendor-snapshot failed:', e.message); process.exit(1); });
}
