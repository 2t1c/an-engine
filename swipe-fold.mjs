#!/usr/bin/env node
// swipe-fold.mjs — keep the swipe file and Competitor Threads at ONE ROW PER THREAD (thread-fold.mjs).
//
// The writers still add one row per tweet (n8n Get Thread, competitor-bodies.mjs). This job, daily:
//   1. SYNC  — for every thread that still has body rows, copies the live rollups (Full Thread Text,
//              Thread Length, Thread Retention, now named "… (live)") into the head's plain fields of
//              the same names, so readers see the same numbers they always did.
//   2. FOLD  — a thread whose numbers have settled (published 8+ days ago, so Stat Refresh's 7-day
//              window is over, and untouched for a day) gets its body rows written into the head's
//              {Body JSON} and {Body Media}. Next run, once Airtable has re-hosted every copied file,
//              the body rows are deleted. A head whose files are not all re-hosted yet waits.
//
//   node swipe-fold.mjs                 # dry: says what it would sync, fold and delete
//   node swipe-fold.mjs --go            # do it
//   node swipe-fold.mjs --go --limit 500   # fold at most 500 threads per table this run
//   node swipe-fold.mjs --go --no-quiet # same-day follow-up: delete rows of heads this job just folded
//   node swipe-fold.mjs --setup         # one-off: create the fold fields and swap the rollups for stored fields
//
// Deleting rows has no undo in Airtable. A body row is deleted only after its head has been re-read and
// shows the fold (same tweet count in {Body JSON}, every file in {Body Media} re-hosted).
import { loadEnv, requireEnv, airtable } from './lib.mjs';
import { TABLES, COMPETITOR_THREADS } from './config.mjs';
import { BODY_JSON, BODY_MEDIA, STORED, LIVE_SUFFIX, foldBody, bodyOf } from './thread-fold.mjs';
import { pathToFileURL } from 'node:url';

export const SETTLE_DAYS = 8; // Stat Refresh re-reads threads published in the last 7 days
export const QUIET_DAYS = 1;  // and a thread someone just touched (Update Thread) may still be moving
const READ_ONLY_TYPES = new Set(['formula', 'rollup', 'lookup', 'multipleLookupValues', 'count', 'button', 'createdTime',
  'lastModifiedTime', 'autoNumber', 'createdBy', 'lastModifiedBy', 'multipleRecordLinks', 'multipleAttachments']);
const CELL_MAX = 95_000; // Airtable's long text cap is 100,000 characters
// A fold PATCH carries whole threads ({Body JSON} near the cell cap, {Body Media} by URL): Airtable can take
// well over the client's default 15 s to answer ten of them, and the first bulk run died on every retry
// (transport_exhausted, 2026-10-20). So: three heads per PATCH, and 90 s per attempt.
export const FOLD_WRITE_BATCH = 3;
export const FOLD_TRANSPORT = { fold: false, attemptTimeoutMs: 90_000, overallTimeoutMs: 700_000 };

/** Write folded heads FOLD_WRITE_BATCH at a time (at.update would send ten per PATCH). */
export async function writeFolds(at, table, writes) {
  for (let i = 0; i < writes.length; i += FOLD_WRITE_BATCH) await at.update(table, writes.slice(i, i + FOLD_WRITE_BATCH), { typecast: false });
}

/** PURE. The body fields worth keeping in {Body JSON}: writable, not links, not attachments. */
export function keepFields(schemaFields = []) {
  const keep = new Set(schemaFields.filter((f) => !READ_ONLY_TYPES.has(f.type)).map((f) => f.name));
  for (const n of [BODY_JSON, BODY_MEDIA, ...STORED]) keep.delete(n);
  return (name) => keep.has(name);
}

/** PURE. Which field holds the live rollup and which the stored copy, before or after --setup's swap. */
export function fieldNames(schemaFields = []) {
  const byName = new Map(schemaFields.map((f) => [f.name, f]));
  const out = {};
  for (const n of STORED) {
    const live = [n + LIVE_SUFFIX, n].find((x) => byName.get(x)?.type === 'rollup') || null;
    const stored = [n, n + ' (stored)'].find((x) => byName.has(x) && byName.get(x).type !== 'rollup') || null;
    out[n] = { live, stored };
  }
  return out;
}

/** PURE. The head's stored fields from its live rollups, only where they differ. */
export function syncPatch(fields = {}, names) {
  const patch = {};
  for (const n of STORED) {
    const { live, stored } = names[n] || {};
    if (!live || !stored) continue;
    let v = fields[live];
    if (Array.isArray(v)) v = n === 'Full Thread Text' ? v.join('') : v[0];
    if (v === undefined) v = null;
    if (n === 'Full Thread Text' && v != null) v = String(v);
    if ((fields[stored] ?? null) !== v) patch[stored] = v;
  }
  return patch;
}

/** PURE. A head is folded and safe to drop its rows when {Body JSON} holds `tweets` and every file is re-hosted. */
export function foldLanded(head, { tweets, files }) {
  const body = bodyOf(head?.fields);
  if (!body || body.tweets.length !== tweets) return false;
  const att = head.fields[BODY_MEDIA] || [];
  // Airtable copies an attachment given by URL in the background; `size` appears once it has.
  return att.length === files && att.every((a) => a && Number(a.size) > 0);
}

async function meta(env, base, path, init) {
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${base}/${path}`, { ...init, headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`airtable meta ${init?.method || 'GET'} ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const TABLE_SPECS = {
  [TABLES.swipe]: { name: 'Threads', retention: { type: 'percent', options: { precision: 2 } } },
  [COMPETITOR_THREADS]: { name: 'Competitor Threads', retention: { type: 'number', options: { precision: 8 } } },
};

async function setup(env, base, table, log, go) {
  let schema = (await meta(env, base, 'tables')).tables.find((t) => t.id === table);
  const has = (n) => schema.fields.some((f) => f.name === n);
  const want = [
    { name: BODY_JSON, type: 'multilineText', description: 'One row per thread (thread-fold.mjs): the body tweets, written by swipe-fold.mjs.' },
    { name: BODY_MEDIA, type: 'multipleAttachments', description: 'Body tweets\' pictures and videos, named t<n><m|v><i>__<file> (thread-fold.mjs).' },
  ];
  const names = fieldNames(schema.fields);
  if (!names['Full Thread Text'].stored) want.push({ name: 'Full Thread Text (stored)', type: 'multilineText' });
  if (!names['Thread Length'].stored) want.push({ name: 'Thread Length (stored)', type: 'number', options: { precision: 0 } });
  if (!names['Thread Retention'].stored) want.push({ name: 'Thread Retention (stored)', ...TABLE_SPECS[table].retention });
  for (const f of want) {
    if (has(f.name)) continue;
    if (!go) { log(`  + ${TABLE_SPECS[table].name}.${f.name} (DRY)`); continue; }
    await meta(env, base, `tables/${table}/fields`, { method: 'POST', body: JSON.stringify(f) });
    log(`  + ${TABLE_SPECS[table].name}.${f.name}`);
  }
  schema = (await meta(env, base, 'tables')).tables.find((t) => t.id === table);
  return schema;
}

async function swap(env, base, table, log) {
  const schema = (await meta(env, base, 'tables')).tables.find((t) => t.id === table);
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  for (const n of STORED) {
    const live = byName.get(n), stored = byName.get(n + ' (stored)');
    if (!stored || live?.type !== 'rollup') continue;
    await meta(env, base, `tables/${table}/fields/${live.id}`, { method: 'PATCH', body: JSON.stringify({ name: n + LIVE_SUFFIX }) });
    await meta(env, base, `tables/${table}/fields/${stored.id}`, { method: 'PATCH', body: JSON.stringify({ name: n }) });
    log(`  ⇄ ${TABLE_SPECS[table].name}: "${n}" is the stored field now, the rollup is "${n}${LIVE_SUFFIX}"`);
  }
}

async function runTable(env, at, base, table, { go, limit, quiet = true, log }) {
  const spec = TABLE_SPECS[table];
  const schema = (await meta(env, base, 'tables')).tables.find((t) => t.id === table);
  const names = fieldNames(schema.fields);
  if (!schema.fields.some((f) => f.name === BODY_JSON) || !names['Thread Length'].live || !names['Thread Length'].stored) {
    log(`${spec.name}: fold fields missing — run --setup first`); return { synced: 0, folded: 0, deleted: 0 };
  }
  const len = `{${names['Thread Length'].live}}`;
  const keep = keepFields(schema.fields);
  const stats = { synced: 0, folded: 0, deleted: 0, waiting: 0, tooLong: 0 };

  // 1. SYNC every thread that still has body rows.
  const live = await at.listAll(table, { formula: `${len}>1`, fields: ['Tweets', BODY_JSON, ...new Set(STORED.flatMap((n) => [names[n].live, names[n].stored]))] });
  // How many heads link each row: a row two threads share is never deleted (it would leave the other).
  const linkCount = new Map();
  for (const r of live) for (const id of r.fields.Tweets || []) if (id !== r.id) linkCount.set(id, (linkCount.get(id) || 0) + 1);
  // A folded head's rollups only see what is left of its rows: its stored fields stay as folded.
  const patches = live.filter((r) => !r.fields[BODY_JSON]).map((r) => ({ id: r.id, fields: syncPatch(r.fields, names) })).filter((p) => Object.keys(p.fields).length);
  stats.synced = patches.length;
  if (go && patches.length) await at.update(table, patches, { typecast: false });

  // 2. FOLD settled threads, oldest first.
  const settled = `AND(${len}>1, IS_BEFORE({Published Date}, DATEADD(NOW(), -${SETTLE_DAYS}, 'days'))${quiet ? `, IS_BEFORE(LAST_MODIFIED_TIME(), DATEADD(NOW(), -${QUIET_DAYS}, 'days'))` : ''})`;
  const heads = (await at.listAll(table, { formula: settled })).slice(0, limit);
  for (let i = 0; i < heads.length; i += 10) {
    const batch = heads.slice(i, i + 10);
    const ids = batch.flatMap((h) => (h.fields.Tweets || []).filter((id) => id !== h.id));
    const rows = new Map();
    for (let j = 0; j < ids.length; j += 50) {
      const chunk = ids.slice(j, j + 50);
      for (const r of await at.listAll(table, { formula: `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})` })) rows.set(r.id, r);
    }
    const writes = [];
    const done = [];
    for (const h of batch) {
      const bodyRows = (h.fields.Tweets || []).filter((id) => id !== h.id).map((id) => rows.get(id)).filter(Boolean);
      if (!bodyRows.length) continue;
      const fold = foldBody(h, bodyRows, { keep });
      const plan = { tweets: fold.tweets, files: fold.media.length };
      const foldedIds = new Set(JSON.parse(fold.body).tweets.map((t) => t.id));
      // A link to a row that is not a body tweet (another head, Tweet Number 1): leave this thread as rows.
      if (bodyRows.some((r) => !foldedIds.has(r.id))) { stats.odd = (stats.odd || 0) + 1; log(`  ! ${h.id}: links a row that is not one of its body tweets — left as rows`); continue; }
      // Already written by an earlier run: drop the rows once the files are in.
      if (h.fields[BODY_JSON] === fold.body) {
        if (foldLanded(h, plan)) done.push(...bodyRows.filter((r) => (linkCount.get(r.id) || 0) <= 1).map((r) => r.id));
        else stats.waiting++; // the files are still being copied: next run
        continue;
      }
      if (fold.body.length > CELL_MAX) { stats.tooLong++; log(`  ! ${h.id}: body is ${fold.body.length} chars, over the cell cap — left as rows`); continue; }
      const fields = { [BODY_JSON]: fold.body, [BODY_MEDIA]: fold.media, ...syncPatch(h.fields, names) };
      writes.push({ id: h.id, fields });
      stats.folded++;
    }
    if (go && writes.length) await writeFolds(at, table, writes);
    if (go && done.length) await at.remove(table, done);
    stats.deleted += done.length;
  }
  log(`${spec.name}: ${live.length} threads with rows · ${stats.synced} synced · ${stats.folded} folded now · ${stats.waiting} waiting on files · ${stats.deleted} body rows ${go ? 'deleted' : 'to delete'}${stats.tooLong ? ` · ${stats.tooLong} too long` : ''}${go ? '' : ' · DRY'}`);
  return stats;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const go = argv.includes('--go');
  const i = argv.indexOf('--limit');
  const limit = i > -1 ? Math.max(1, Number(argv[i + 1]) || 1) : Infinity;
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
  const base = env.XDB_BASE_ID;
  const at = airtable(env, base, FOLD_TRANSPORT); // the raw rows: this job is the one that folds them
  if (argv.includes('--setup')) {
    for (const t of [TABLES.swipe, COMPETITOR_THREADS]) {
      const created = await setup(env, base, t, log, go);
      if (!go && !fieldNames(created.fields)['Thread Length'].stored) { log(`  ${TABLE_SPECS[t].name}: fields not created yet (DRY)`); continue; }
      // Fill the stored copies from the rollups before the swap, so no reader ever sees them empty.
      const schema = (await meta(env, base, 'tables')).tables.find((x) => x.id === t);
      const names = fieldNames(schema.fields);
      const rows = await at.listAll(t, { formula: `{${names['Thread Length'].live}}>0`, fields: [...new Set(STORED.flatMap((n) => [names[n].live, names[n].stored]))] });
      const patches = rows.map((r) => ({ id: r.id, fields: syncPatch(r.fields, names) })).filter((p) => Object.keys(p.fields).length);
      log(`  ${TABLE_SPECS[t].name}: ${patches.length} heads get their stored copies${go ? '' : ' (DRY)'}`);
      if (!go) continue;
      await at.update(t, patches, { typecast: false });
      await swap(env, base, t, log);
    }
    return;
  }
  // --no-quiet: a hand-run follow-up the same day (the first bulk fold), when the heads were just written by us.
  const quiet = !argv.includes('--no-quiet');
  for (const t of [TABLES.swipe, COMPETITOR_THREADS]) await runTable(env, at, base, t, { go, limit, quiet, log });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
