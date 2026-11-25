#!/usr/bin/env node
// scripts/donor-labels.mjs — the Phase 3a donor label set (docs/typesafe-jev.md "Donor selection"), built
// from the operator's own selection verdicts in committed run files: swaps, drops and kept donors whose
// note says why.
//
//   node scripts/donor-labels.mjs            # extract and report: label counts per decision and source, skips
//   node scripts/donor-labels.mjs --write    # also read each donor from Airtable (READ-ONLY) and write
//                                            # evals/jev/donor-<decision>.jsonl, hash-only
//
// Sources: queues/run-*.json (day-row notes, intentScreen.dropped / routedToRemix, fitNotes) and the
// markdown notes (queues/next-run-notes.md, queues/run-*.note.md). Every source names swipe rec ids only;
// the donor text lives in the swipe table (XDB_BASE_ID, config.mjs TABLES.swipe).
//
// Mapping (each rule quotes the note it read; a note no rule reads is SKIPPED and reported):
//   donor-account-fit  `specific` (binary)  swapped "on voice" or out of a page as off-niche → false for
//                      the page it left; the page it moved to (the note says why it fits) → true.
//   donor-writeability `swap` (binary)      swapped because its body cannot be written (no substance,
//                      cannot be recreated) or dropped with "no substance to plug" → true; a kept donor
//                      whose product re-cut or test top-up reads a substance the donor itself carries, or
//                      a replacement the note says argues or plugs a product → false.
//   donor-screen       `flag` (binary)      dropped OFF-NICHE (or explicit, or not English) → true; a donor
//                      the note calls clean on every screen, or one a note places as specific to a fleet
//                      page (it is on-niche) → false.
//   Premise and hook-frame twins, reach floors, topic intent, harvest-body duplicates and the operator's
//   "seen it too many times" (saturation) are verdicts no Phase 3a decision owns: skipped as out of scope.
//
// Label rows: { id, recId, page, labels, source: "file#key", reason (a quote from the note), sha256 }.
// sha256 is over JSON.stringify(tweets), the copyDigest convention of scripts/run-jev.mjs. NO DONOR TEXT is
// ever written. At eval time loadDonorItem() re-reads the donor by recId and skips a row whose hash changed.
// Airtable is read with getRecord / listAll only: nothing here writes.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DECISIONS = Object.freeze(['donor-account-fit', 'donor-writeability', 'donor-screen']);
export const FIELD = Object.freeze({ 'donor-account-fit': 'specific', 'donor-writeability': 'swap', 'donor-screen': 'flag' });
export const LABELS_DIR = 'evals/jev';
const REC = 'rec[A-Za-z0-9]{14}';
const REC_RE = new RegExp(REC, 'g');
const MAX_REASON = 240;

export const donorDigest = (tweets) => createHash('sha256').update(JSON.stringify((tweets || []).map(String))).digest('hex');

// ---- Extraction (pure) ---------------------------------------------------------------------------------

/** A verdict word: without one, a note segment is description, not a selection verdict. */
const VERDICT = /\b(swap(?:ped|s)?|re-cut|top-up|dropp?ed|replaced|rejected|kept|approved)\b/i;

const quote = (text, re) => {
  const m = re ? String(text).match(re) : null;
  const s = m ? m[0] : String(text);
  return s.replace(/\s+/g, ' ').trim().replace(/^["'\s]+/, '').slice(0, MAX_REASON);
};

/** The note units a run file carries: day-row bracket segments, drops, remix routes and fit notes. */
export function unitsOf(file, json) {
  const units = [];
  for (const [day, rows] of Object.entries(json?.days || {})) {
    (Array.isArray(rows) ? rows : []).forEach((row, i) => {
      if (!row?.donor || typeof row.note !== 'string') return; // harvest / pot rows carry no donor
      const segments = row.note.match(/\[[^\]]*\]/g) || [];
      segments.forEach((seg, s) => units.push({ file, key: `days.${day}[${i}].note[${s}]`, kind: 'row', recId: row.donor, page: row.account || null, text: seg.slice(1, -1) }));
    });
  }
  (json?.intentScreen?.dropped || []).forEach((d, i) => units.push({ file, key: `intentScreen.dropped[${i}]`, kind: 'dropped', recId: d.recId, page: null, text: String(d.why || '') }));
  (json?.intentScreen?.routedToRemix || []).forEach((d, i) => units.push({ file, key: `intentScreen.routedToRemix[${i}]`, kind: 'routed', recId: d.recId, page: null, text: String(d.why || '') }));
  (json?.fitNotes || []).forEach((d, i) => units.push({ file, key: `fitNotes[${i}]`, kind: 'fit', recId: null, page: null, swap: String(d.swap || ''), text: String(d.why || '') }));
  return units;
}

/** Markdown notes: any line naming a rec id beside a verdict word is a unit no rule reads (skipped). */
export function markdownUnits(file, text) {
  return String(text).split('\n').map((line, i) => ({ line, i })).filter(({ line }) => new RegExp(REC).test(line) && VERDICT.test(line))
    .map(({ line, i }) => ({ file, key: `L${i + 1}`, kind: 'markdown', recId: line.match(new RegExp(REC))[0], page: null, text: line }));
}

const OUT_OF_SCOPE = [
  [/under floor/i, 'reach floor'],
  [/SAME SOURCE THREAD/, 'duplicate source thread'],
  [/PREMISE COLLISION|premise twin/i, 'premise twin'],
  [/HOOK-FRAME TWIN/, 'hook-frame twin'],
  [/near-duplicated? a harvest body/i, 'duplicates a harvest body'],
  [/fleet intent/i, 'topic buyer intent'],
];

/**
 * From `start` to the first sentence end: a period followed by a capital letter or the end of the note.
 * `start` must not carry the i flag, which would let [A-Z] match a lowercase word after "peak.".
 */
const SENTENCE = (start) => new RegExp(`${start.source}.*?\\.(?=\\s+[A-Z]|\\s*$)`, start.flags);

const label = (decision, recId, page, value, u, reason) => ({ decision, recId, page: page || null, value, source: `${u.file}#${u.key}`, reason });

/**
 * Pure. One unit → { labels, skip }. `skip` is null when the note was read in full, else { category, why }:
 * `out_of_scope` (a verdict no Phase 3a decision owns), `ambiguous` (a verdict no rule can read), or
 * `no_verdict` (description only; not reported as a skip).
 */
export function mapUnit(u) {
  const t = u.text;
  const labels = [];
  if (u.kind === 'row') {
    const voice = t.match(/donor SWAPPED with (\w+) on voice/i);
    if (voice) {
      const other = voice[1].toLowerCase();
      const why = quote(t, SENTENCE(/on voice:/)); // "peak." is a handle, not a sentence end
      labels.push(label('donor-account-fit', u.recId, u.page, true, u, why));
      labels.push(label('donor-account-fit', u.recId, other, false, u, why));
      if (/donor argues|donor's argument/i.test(t)) labels.push(label('donor-writeability', u.recId, u.page, false, u, quote(t, /[^.:]*donor(?:'s)? (?:argues|argument)[^.]*/i)));
      return { labels, skip: null };
    }
    const cannot = t.match(new RegExp(`donor SWAPPED: (${REC})\\b[^\\]]*?(no substance|can(?:'|no)t (?:be )?recreat|not recreatable|cannot be rewritten)`, 'i'));
    if (cannot) {
      labels.push(label('donor-writeability', cannot[1], u.page, true, u, quote(t, new RegExp(`${REC}[^.]*\\.`))));
      if (/This one argues .+ by name/i.test(t)) labels.push(label('donor-writeability', u.recId, u.page, false, u, quote(t, /This one argues[^.]*\./i)));
      return { labels, skip: null };
    }
    for (const [re, why] of OUT_OF_SCOPE) if (re.test(t)) return { labels, skip: { category: 'out_of_scope', why } };
    if (/buyer intent/i.test(t)) return { labels, skip: { category: 'ambiguous', why: 'swapped on buyer intent; "no bridge" may or may not be writeability' } };
    // A product re-cut or test top-up keeps the donor and re-fits a product to the donor's own content:
    // the note reads a substance the donor carries, so the donor was writeable (and was written).
    if (/^\s*(?:heavy |light |pair )?re-cut:|^\s*test top-up:/i.test(t) && /\bdonor\b/i.test(t)) {
      labels.push(label('donor-writeability', u.recId, u.page, false, u, quote(t, /[^.:;]*\bdonor\b[^.;]*/i)));
      return { labels, skip: null };
    }
    return { labels, skip: VERDICT.test(t) ? { category: 'ambiguous', why: 'verdict word, no rule reads it' } : { category: 'no_verdict' } };
  }
  if (u.kind === 'dropped') {
    if (/OFF-NICHE/.test(t) || /\b(explicit|sexual|not (?:in )?English|in Spanish|in Portuguese|foreign[- ]language)\b/i.test(t)) {
      labels.push(label('donor-screen', u.recId, null, true, u, quote(t, /^[^.]*\.[^.]*\./)));
      // [^\]]*? not [^.]*: the replacement's stats ("85.9d, 1.6M") carry periods before "plugs cleanly".
      const repl = t.match(new RegExp(`Replaced by (${REC})[^\\]]*?plugs cleanly[^.]*`));
      if (repl) labels.push(label('donor-writeability', repl[1], null, false, u, quote(repl[0])));
      return { labels, skip: null };
    }
    if (/no substance to plug/i.test(t)) {
      labels.push(label('donor-writeability', u.recId, null, true, u, quote(t)));
      return { labels, skip: null };
    }
    if (/seen this \w* too many times/i.test(t)) {
      // The operator's objection is saturation (out of scope); the same note says every screen passed it.
      if (/clean on every screen/i.test(t)) labels.push(label('donor-screen', u.recId, null, false, u, quote(t, /[^.]*clean on every screen[^.—]*/i)));
      return { labels, skip: { category: 'out_of_scope', why: `saturation (seen it too many times)${labels.length ? '; the screen pass in the same note is read' : ''}` } };
    }
    for (const [re, why] of OUT_OF_SCOPE) if (re.test(t)) return { labels, skip: { category: 'out_of_scope', why } };
    return { labels, skip: { category: 'ambiguous', why: 'drop reason no rule reads' } };
  }
  if (u.kind === 'routed') {
    for (const [re, why] of OUT_OF_SCOPE) if (re.test(t)) return { labels, skip: { category: 'out_of_scope', why } };
    return { labels, skip: { category: 'ambiguous', why: 'remix route no rule reads' } };
  }
  if (u.kind === 'fit') {
    const pair = u.swap.match(new RegExp(`(${REC})\\s*<->\\s*(${REC})`));
    const page = t.match(/sitting as a COVER on (\w+)/i);
    const home = t.match(/puts the (\w+) donor on the \1 page/i);
    if (pair && page && /off-niche/i.test(t)) {
      labels.push(label('donor-account-fit', pair[1], page[1].toLowerCase(), false, u, quote(t, /sitting as a COVER on[^.]*/i)));
      if (home) labels.push(label('donor-account-fit', pair[2], page[1].toLowerCase(), true, u, quote(home[0])));
      return { labels, skip: null };
    }
    return { labels, skip: { category: 'ambiguous', why: 'fit note no rule reads' } };
  }
  return { labels, skip: { category: 'ambiguous', why: 'no rule reads this source' } };
}

/**
 * Pure. Units → { labels (deduped per decision and item), skipped, conflicts }. A donor placed as
 * `specific` on a fleet page is on-niche, so it also counts as a screen pass (derived, same source).
 * Account fit is keyed by (recId, page); writeability and screen by recId (they do not read the page).
 * Two sources that disagree on one item drop it and report the conflict.
 */
export function extract(units) {
  const raw = [], skipped = [];
  for (const u of units) {
    const r = mapUnit(u);
    raw.push(...r.labels);
    if (r.skip && r.skip.category !== 'no_verdict') skipped.push({ source: `${u.file}#${u.key}`, recId: u.recId || null, ...r.skip });
  }
  for (const l of [...raw]) if (l.decision === 'donor-account-fit' && l.value === true) raw.push({ ...l, decision: 'donor-screen', value: false, page: null, derived: 'specific to a fleet page, so on-niche' });
  const byKey = new Map(), conflicts = [];
  for (const l of raw) {
    const key = `${l.decision}|${l.recId}|${l.decision === 'donor-account-fit' ? l.page : ''}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, l); continue; }
    if (prev.conflict) continue;
    if (prev.value !== l.value) { conflicts.push({ decision: l.decision, recId: l.recId, page: l.page, sources: [prev.source, l.source] }); byKey.set(key, { ...prev, conflict: true }); }
  }
  const labels = [...byKey.values()].filter((l) => !l.conflict);
  return { labels, skipped, conflicts };
}

/** The committed sources, read from the repo. */
export function loadSources(root = ROOT) {
  const dir = join(root, 'queues');
  const units = [];
  const names = readdirSync(dir).sort();
  for (const f of names.filter((n) => /^run-.*\.json$/.test(n))) units.push(...unitsOf(`queues/${f}`, JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  for (const f of names.filter((n) => n === 'next-run-notes.md' || /^run-.*\.note\.md$/.test(n))) units.push(...markdownUnits(`queues/${f}`, readFileSync(join(dir, f), 'utf8')));
  return units;
}

// ---- Donor text: Airtable, READ-ONLY ---------------------------------------------------------------------

/** The donor thread for a swipe head record: its Tweets in Tweet Number order (thread-brief.mjs's read). */
export async function readDonor(at, recId, { table } = {}) {
  const t = table || (await import('../config.mjs')).TABLES.swipe;
  const head = await at.getRecord(t, recId);
  if (!head?.fields) return null;
  const ids = Array.isArray(head.fields.Tweets) ? head.fields.Tweets : [];
  let rows = [];
  // A folded thread's body tweets have no rows to query: the client already holds them (thread-fold.mjs).
  const foldedRecs = ids.map((id) => at.foldedRecord?.(id)).filter(Boolean);
  const rowIds = ids.filter((id) => !at.foldedRecord?.(id));
  if (rowIds.length) {
    const formula = `OR(${rowIds.map((id) => `RECORD_ID()='${String(id).replace(/[^A-Za-z0-9]/g, '')}'`).join(',')})`;
    foldedRecs.push(...await at.listAll(t, { formula, fields: ['Text', 'Tweet Number'] }));
  }
  if (ids.length) rows = foldedRecs.map((r) => ({ n: Number(r.fields?.['Tweet Number']) || 0, text: String(r.fields?.Text || '') })).filter((r) => r.text);
  const tweets = rows.sort((a, b) => a.n - b.n).map((r) => r.text);
  if (!tweets.length && head.fields.Text) tweets.push(String(head.fields.Text));
  return tweets.length ? { hook: tweets[0], tweets } : null;
}

let defaultAt = null;
async function readOnlyAirtable() {
  if (!defaultAt) {
    const lib = await import('../lib.mjs');
    const at = lib.airtable(lib.loadEnv());
    defaultAt = { getRecord: at.getRecord.bind(at), listAll: at.listAll.bind(at) }; // reads only: no write method is reachable
  }
  return defaultAt;
}

/**
 * The eval adapter hook (scripts/jev-eval.mjs, EVAL.loadItem): fetch the row's donor by recId and return
 * { id, hook, tweets, account? }, or { skip: reason } when it cannot be read or its sha256 changed.
 * ctx: { at, cache: Map, needAccount, accountOf }.
 */
export async function loadDonorItem(row, ctx = {}) {
  if (!row?.recId) return { skip: 'no_recid' };
  if (!row.sha256) return { skip: 'no_sha256' };
  const cache = ctx.cache || new Map();
  const key = `donor:${row.recId}`;
  if (!cache.has(key)) {
    const at = ctx.at || (await readOnlyAirtable());
    cache.set(key, readDonor(at, row.recId).catch(() => 'error'));
  }
  const donor = await cache.get(key);
  if (donor === 'error') return { skip: 'fetch_failed' };
  if (!donor) return { skip: 'not_found' };
  if (donorDigest(donor.tweets) !== row.sha256) return { skip: 'sha_changed' };
  const item = { id: row.id, hook: donor.hook, tweets: donor.tweets };
  if (ctx.needAccount) {
    try { item.account = await (ctx.accountOf || (async (n) => (await import('../accounts.mjs')).getAccount(n)))(row.page); } catch { return { skip: 'no_account' }; }
    if (!item.account) return { skip: 'no_account' };
  }
  return item;
}

// ---- Rows --------------------------------------------------------------------------------------------------

/** Label rows for one decision: ids, pointers, a quote and the donor hash. No donor text. */
export async function buildRows(labels, { at, readDonorImpl = readDonor } = {}) {
  const out = Object.fromEntries(DECISIONS.map((d) => [d, []]));
  const unread = [];
  const hashes = new Map();
  for (const l of labels) {
    if (!hashes.has(l.recId)) {
      let h = null;
      try { const d = await readDonorImpl(at, l.recId); h = d ? donorDigest(d.tweets) : null; } catch { h = null; }
      hashes.set(l.recId, h);
    }
    const sha256 = hashes.get(l.recId);
    if (!sha256) { unread.push({ decision: l.decision, recId: l.recId }); continue; }
    const id = `${l.decision.replace('donor-', '')}:${l.recId}${l.decision === 'donor-account-fit' ? `:${l.page}` : ''}`;
    out[l.decision].push({ id, recId: l.recId, page: l.page, labels: { [FIELD[l.decision]]: l.value }, source: l.source, reason: l.reason, sha256 });
  }
  return { rows: out, unread };
}

/** Counts per decision, per label value and per source file. */
export function summarize(labels) {
  const s = {};
  for (const l of labels) {
    const d = (s[l.decision] ||= { total: 0, positive: 0, negative: 0, bySource: {} });
    d.total++; d[l.value ? 'positive' : 'negative']++;
    const f = l.source.split('#')[0];
    d.bySource[f] = (d.bySource[f] || 0) + 1;
  }
  return s;
}

async function main(argv) {
  const units = loadSources();
  const { labels, skipped, conflicts } = extract(units);
  const sum = summarize(labels);
  console.log(`donor labels from ${units.length} note units`);
  for (const d of DECISIONS) {
    const x = sum[d] || { total: 0, positive: 0, negative: 0, bySource: {} };
    console.log(`  ${d.padEnd(20)} ${String(x.total).padStart(3)}  (${FIELD[d]}=true ${x.positive}, false ${x.negative})  ${Object.entries(x.bySource).map(([f, n]) => `${f} ${n}`).join(', ')}`);
  }
  const byCat = skipped.reduce((m, s) => ({ ...m, [s.category]: (m[s.category] || 0) + 1 }), {});
  console.log(`skipped: ${skipped.length} (${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
  for (const s of skipped) console.log(`  - [${s.category}] ${s.source}${s.recId ? ` ${s.recId}` : ''}: ${s.why}`);
  if (conflicts.length) for (const c of conflicts) console.log(`  ! conflict ${c.decision} ${c.recId} ${c.page || ''}: ${c.sources.join(' vs ')}`);
  if (!argv.includes('--write')) return;
  const { rows, unread } = await buildRows(labels, { at: await readOnlyAirtable() });
  mkdirSync(join(ROOT, LABELS_DIR), { recursive: true });
  for (const d of DECISIONS) {
    writeFileSync(join(ROOT, LABELS_DIR, `${d}.jsonl`), rows[d].map((r) => JSON.stringify(r)).join('\n') + (rows[d].length ? '\n' : ''));
    console.log(`wrote ${LABELS_DIR}/${d}.jsonl: ${rows[d].length} rows`);
  }
  if (unread.length) console.log(`donor text unreadable (row not written): ${unread.map((u) => `${u.decision} ${u.recId}`).join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
