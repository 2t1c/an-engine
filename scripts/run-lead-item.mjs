#!/usr/bin/env node
// scripts/run-lead-item.mjs — the lead item for every drafts row, in every lane (lead-item.mjs).
//
// Owner, 2026-09-28: "yes adopt fully — every numbered first tweet should have it implemented." A row whose
// first tweet shows item 1 gets Jev's reads (lead-pull-read, lead-order-read, lead-follow-read), and when
// another item is the stronger opener it trades places with item 1, every word kept. A cover planned with
// scripts/row-skeleton.mjs usually arrives already led by its strongest item and reads as kept; a harvest,
// a pot or a remix is led here. run-row drafts runs this first and writes the result back to its --input
// spec, so the Jev drafts read, the packet and the owner's review all see the copy that ships.
//
// Each row records row.draft.leadItem = { moved, from, name, pull, p1, was, ordered | reason, sha, at }.
// `sha` is the copy it checked: a re-run on unchanged copy reads nothing. A swap must pass what the drafts
// packet holds on: it may not give the canonical thread gate a new kind of issue (so a plug never leaves
// the CTA window), and a cover's hook must still clear the hook gate (in the last run's drafts, 2 of 14
// swaps would have dropped a cover's hook under the floor). A swap that fails gives way to the next item.
//
//   node scripts/run-lead-item.mjs --input SPEC [--output FILE] [--rows a,b] [--backup FILE]
//     --output defaults to --input (written in place); --backup keeps the spec as it was when a row moves.
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { leadItem, leadLine } from '../lead-item.mjs';
import { checkHook } from '../hooks-check.mjs';
import { gateThread } from '../gate-thread.mjs';
import { laneOf } from '../lanes.mjs';

export const copySha = (tweets) => createHash('sha256').update(JSON.stringify((tweets || []).map(String))).digest('hex').slice(0, 16);

/** PURE. A cover's gate for a swap: the canonical hook gate, as the drafts packet runs it, must still pass
 *  when it passed before. Null for any other lane, or a cover without its source hook. */
export function coverHookAccept(row) {
  const donor = String(row?.source?.hook || '').trim();
  if (laneOf(row?.lane) !== 'cover' || !donor) return null;
  const opts = { lane: 'cover', hookDrift: row.hook?.hookDrift || null, swapPromise: !!row.hook?.swapPromise };
  let passed = null;   // the copy's own verdict, read on the first swap asked about
  return (tweets) => {
    passed ??= checkHook(String(row.draft?.tweets?.[0] ?? ''), donor, opts).ok;
    return !passed || checkHook(String(tweets[0] ?? ''), donor, opts).ok;
  };
}

/** PURE. A swap must not give the canonical thread gate (as the drafts packet runs it) a kind of issue the
 *  copy did not already have; numbers aside, since a tweet number that shifts is the same finding. This is
 *  what keeps a plug inside the CTA window: a swap that pushes the ask past it is refused. */
export function gateAccept(row, { gate = gateThread } = {}) {
  const spec = (tweets) => ({ account: row.account, tweets, products: row.draft?.products || [], ctaDepth: row.draft?.ctaDepth,
    allowUnsold: row.draft?.allowUnsold, shape: row.draft?.shape, firstPlugAt: row.draft?.firstPlugAt, arm: row.draft?.arm || null });
  const kinds = (v) => new Set(v?.fatal ? [`fatal: ${v.fatal}`] : (v?.issues || []).map((i) => String(i).replace(/\d+/g, '#')));
  let before = null;   // read on the first swap asked about: most rows never get that far
  return (tweets) => {
    before ??= kinds(gate(spec((row.draft?.tweets || []).map(String))));
    return [...kinds(gate(spec(tweets)))].every((k) => before.has(k));
  };
}

/** PURE. Every gate a row's swap must pass, as one function. */
export function acceptFor(row) {
  const gates = [coverHookAccept(row), gateAccept(row)].filter(Boolean);
  return (tweets) => gates.every((g) => g(tweets));
}

/** PURE. The row's notes kept by tweet number, moved with their tweets after a swap: draft.sources
 *  ({ tweet, source }) and draft.firstPlugAt. A number the map does not know stays as it was. */
export function remapDraft(draft, map) {
  if (!map) return draft;
  const to = (n) => (Number.isInteger(n) && map[n] ? map[n] : n);
  const out = { ...draft };
  if (Array.isArray(draft.sources)) out.sources = draft.sources.map((x) => (x && Number.isInteger(x.tweet) ? { ...x, tweet: to(x.tweet) } : x));
  if (Number.isInteger(draft.firstPlugAt)) out.firstPlugAt = to(draft.firstPlugAt);
  return out;
}

/** PURE. The rows to check: every row with draft tweets, narrowed to `want` ids when given. */
export function rowsToCheck(spec, want = null) {
  return (spec.rows || []).filter((r) => Array.isArray(r.draft?.tweets) && r.draft.tweets.length && (!want || want.has(r.id)));
}

/**
 * The step over a spec. `lead(tweets, row)` is lead-item.mjs leadItem bound to a client and the row's
 * own gate (tests pass a fake).
 * Returns { spec, lines, moved } with each checked row's draft rewritten and recorded.
 */
export async function leadRows(spec, { want = null, lead, now = () => new Date().toISOString(), concurrency = 4 } = {}) {
  const out = JSON.parse(JSON.stringify(spec));
  const lines = [];
  let moved = 0;
  const rows = rowsToCheck(out, want);
  const one = async (row) => {
    const tweets = row.draft.tweets.map(String);
    const prior = row.draft.leadItem || null;
    if (prior?.sha && prior.sha === copySha(tweets)) { lines.push(`${row.id}: unchanged since checked · ${leadLine(prior)}`); return; }
    // Settled copy is not swapped again. A row swapped once keeps that record (its harvest check and its
    // tweet-1 line are read against it) even after a repair changes other words; and an owner's edit
    // settles the order (docs/thread-laws.md, the operator-edit rule).
    if (prior?.moved || row.operatorEdit?.message) {
      const why = prior?.moved ? 'swapped already; not swapped twice' : 'the owner edited this copy';
      row.draft.leadItem = { ...(prior || { moved: false, reason: why }), sha: copySha(tweets), recheck: why, at: now() };
      lines.push(`${row.id}: kept (${why})`);
      return;
    }
    let r;
    try { r = await lead(tweets, row); } catch (e) { r = { tweets, lead: { moved: false, reason: `not read (${String(e.message).slice(0, 80)})` } }; }
    Object.assign(row.draft, remapDraft(row.draft, r.map));
    row.draft.tweets = r.tweets;
    row.draft.leadItem = { ...r.lead, sha: copySha(r.tweets), at: now() };
    if (r.lead.moved) moved++;
    lines.push(`${row.id}: ${leadLine(r.lead)}`);
  };
  // A few rows at a time: each row asks Jev up to a dozen reads, and an unread item keeps item 1.
  for (let i = 0; i < rows.length; i += concurrency) await Promise.all(rows.slice(i, i + concurrency).map(one));
  lines.sort();
  return { spec: out, lines, moved, checked: rows.length };
}

async function main() {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const input = arg('input');
  if (!input) throw new Error('usage: node scripts/run-lead-item.mjs --input SPEC [--output FILE] [--rows a,b] [--backup FILE]');
  const output = arg('output', input);
  const want = arg('rows') ? new Set(arg('rows').split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const spec = JSON.parse(readFileSync(input, 'utf8'));
  const { loadEnv } = await import('../lib.mjs');
  const { jev } = await import('../jev.mjs');
  const { askThrough, createDecisionLog } = await import('../jev-decide.mjs');
  const client = jev(loadEnv());
  const log = createDecisionLog();
  try {
    const ask = (name, c, q, o) => askThrough(name, c, q, { ...o, log });
    const res = await leadRows(spec, { want, lead: (tweets, row) => leadItem(tweets, { client, ask, accept: acceptFor(row), keepFirstLink: false }) });
    if (res.moved && arg('backup')) copyFileSync(input, arg('backup'));
    const tmp = `${output}.lead-tmp`;
    writeFileSync(tmp, JSON.stringify(res.spec, null, 1), { mode: 0o600 });
    renameSync(tmp, output);
    for (const l of res.lines) console.log(`  ${l}`);
    console.log(`lead item: ${res.moved} moved · ${res.checked - res.moved} kept or not numbered · ${res.checked} row(s) checked`);
  } finally { log.flush(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
