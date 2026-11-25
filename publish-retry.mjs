#!/usr/bin/env node
// publish-retry.mjs — when a scheduled post fails on X, post it again by itself, twice at most, and
// only then page the owner on Telegram.
//
// OWNER RULE (2026-11-13): "always self retry to post at least 2 times. If that fails then I should
// receive a telegram notification". Lucas's 12:15 UTC thread (draft 11895263) failed on X that day
// while its Threads copy posted; the owner re-posted it by hand.
//
// WHY A COPY. Typefully's v2 API refuses every edit to a draft in status 'error' ("Only drafts in
// 'draft', 'planned', or 'scheduled' status can be edited using the API", read 2026-11-13), so the
// failed draft cannot be re-published in place. A retry is a NEW draft in the same social set with
// the original's X posts and media, X only (a Threads copy that already posted is never doubled; a
// Threads-only failure is not retried at all), published with publish_at 'now'. Its title is
// "[RETRY n of <id>] <title>", which is the only state this job keeps: every run re-reads the copies
// from Typefully, so a missed or crashed run picks up exactly where the last one stopped.
//
// ATTRIBUTION. The copy carries the original's tracked links unchanged. Its ledger rows (same
// lvLink, draftId = the copy, retryOf = the original) let registry-sync's claimant rule credit the
// copy, which is the one that is live on X.
//
// SAFETY. A copy still publishing (publish_state not finished) is never followed by another copy:
// that run stops and the next one reads the result. The original is re-read before each copy, so a
// post the owner retried by hand is left alone.
//
//   node publish-retry.mjs              # hourly from Railway pi-cron (.github/workflows/publish-retry.yml)
//   node publish-retry.mjs --dry        # say what it would retry; writes nothing
//   node publish-retry.mjs --hours 12   # look further back than the default 6 h
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, typefully, telegram, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';

export const MAX_RETRIES = 2;
export const WINDOW_H = 6;
const SKIP_ACCOUNTS = new Set(['burner']); // drafts only, never publishes
const RETRY_RE = /^\[RETRY (\d+) of (\d+)\]/;

/** PURE. "[RETRY 2 of 11895263] title" -> { n: 2, of: '11895263' }, else null. */
export function parseRetryTitle(title) {
  const m = RETRY_RE.exec(String(title || ''));
  return m ? { n: Number(m[1]), of: m[2] } : null;
}

export const retryTitle = (n, id, title) => `[RETRY ${n} of ${id}] ${String(title || '').replace(RETRY_RE, '').trim()}`.slice(0, 200);

/** PURE. Errored list rows that failed ON X inside the window: X enabled, X never published, not a
 *  retry copy itself. A Threads-only failure (X published) is not a retry case. */
export function failedOnX(rows, { now = Date.now(), windowH = WINDOW_H } = {}) {
  return (rows || []).filter((d) => {
    if (d.status !== 'error' || d.x_post_published_at) return false;
    if (d.x_post_enabled === false) return false;
    if (parseRetryTitle(d.draft_title)) return false;
    const at = Date.parse(d.scheduled_date || d.updated_at || '');
    return Number.isFinite(at) && at <= now && now - at <= windowH * 3600e3;
  });
}

/** PURE. Where one original stands, from its retry copies: 'done' (a copy is on X), 'wait' (a copy is
 *  still publishing), 'retry' (fewer than MAX_RETRIES copies failed), or 'alert'. */
export function retryState(copies, max = MAX_RETRIES) {
  if (copies.some((c) => c.x_post_published_at)) return { state: 'done', failed: copies.length };
  if (copies.some((c) => c.status !== 'error')) return { state: 'wait', failed: copies.filter((c) => c.status === 'error').length };
  return copies.length >= max ? { state: 'alert', failed: copies.length } : { state: 'retry', failed: copies.length };
}

/** PURE. The new draft's body: the original's X posts and media only, published now. */
export function copyBody(orig, n) {
  const posts = (orig.platforms?.x?.posts || []).map((p) => ({ text: p.text, media_ids: p.media_ids || [] }));
  if (!posts.length) return null;
  const x = { enabled: true, posts, ...(orig.platforms?.x?.settings ? { settings: orig.platforms.x.settings } : {}) };
  return {
    platforms: { x },
    publish_at: 'now',
    draft_title: retryTitle(n, orig.id, orig.draft_title),
    scratchpad_text: `Auto-retry ${n} of ${MAX_RETRIES} for draft ${orig.id}, which failed on X (owner rule 2026-11-13). X only.\n\n${orig.scratchpad_text || ''}`.slice(0, 5000),
  };
}

/** PURE. Ledger rows that move the original's X links onto the copy. Threads twins (-th) stay put. */
export function ledgerRowsForCopy(ledger, origId, copyId, xText, { now = Date.now() } = {}) {
  return (ledger || [])
    .filter((r) => String(r.draftId) === String(origId) && r.lvLink && (xText.includes(r.lvLink) || (r.glink && xText.includes(r.glink))))
    .map(({ ts, draftId, ...rest }) => ({ ...rest, ts: new Date(now).toISOString(), draftId: String(copyId), retryOf: String(origId), source: 'publish-retry' }));
}

export function alertText({ handle, orig, copies }) {
  const slot = String(orig.scheduled_date || '').slice(11, 16);
  return [
    `🚨 <b>@${handle}</b>: a post failed on X and ${copies.length} automatic retries failed too.`,
    `Slot ${slot} UTC · “${String(orig.preview || orig.draft_title || '').split('\n')[0].slice(0, 80)}”`,
    `Draft: ${orig.share_url || orig.private_url || orig.id}${copies.length ? ` · retries ${copies.map((c) => c.id).join(', ')}` : ''}`,
    'A failed post can mean the page is locked or hit (verification, shadowban). Check the page.',
  ].join('\n');
}

async function listStatus(tf, ss, status, limit) {
  try { return (await tf.listPage(`/social-sets/${ss}/drafts?status=${status}`, { limit })).items; }
  catch (e) { console.warn(`  ${ss} list ${status}: ${e.message}`); return null; }
}

async function pollUntilDone(tf, ss, id, { tries = 16, sleepMs = 15_000, sleep }) {
  let d = null;
  for (let i = 0; i < tries; i++) {
    await sleep(sleepMs);
    d = await tf.getDraft(ss, id);
    if (d.publish_state === 'finished' || d.status === 'error' || d.status === 'published') return d;
  }
  return d;
}

/** One pass over every posting social set. Injectable for tests. Returns a summary per original. */
export async function runRetries({ tf, notify, ledger = [], appendLedger = () => {}, log = () => {}, accounts = ACCOUNTS,
  now = Date.now(), windowH = WINDOW_H, dry = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollOpts = {} } = {}) {
  const out = [];
  const seen = new Set();
  for (const [key, acc] of Object.entries(accounts)) {
    const ss = acc?.socialSetId;
    // A paused page (Airtable roster switch) is never posted to, retry or not.
    if (!ss || seen.has(ss) || SKIP_ACCOUNTS.has(key) || acc.paused) continue;
    seen.add(ss);
    const errored = await listStatus(tf, ss, 'error', 30);
    if (!errored) { out.push({ key, state: 'unread' }); continue; }
    const failed = failedOnX(errored, { now, windowH });
    if (!failed.length) continue;
    // Copies can be in any status; a publishing one reads as 'draft' until it finishes.
    const pool = [...errored];
    for (const st of ['published', 'draft', 'scheduled']) pool.push(...((await listStatus(tf, ss, st, 30)) || []));
    for (const row of failed) {
      const copies = pool.filter((d) => parseRetryTitle(d.draft_title)?.of === String(row.id));
      let { state } = retryState(copies);
      const rec = { key, handle: acc.handle, id: row.id, copies: copies.map((c) => c.id) };
      if (state === 'retry' && !dry) {
        let orig = await tf.getDraft(ss, row.id);
        while (state === 'retry') {
          if (orig.status !== 'error' || orig.x_post_published_at) { state = 'done-by-hand'; break; }
          const n = copies.length + 1;
          const body = copyBody(orig, n);
          if (!body) { state = 'no-x-posts'; break; }
          const made = await tf.createDraft(ss, body);
          console.log(`  @${acc.handle} ${row.id}: retry ${n} -> draft ${made.id}`);
          const done = await pollUntilDone(tf, ss, made.id, { sleep, ...pollOpts });
          copies.push(done || { id: made.id, status: 'draft' });
          rec.copies.push(made.id);
          log({ ts: new Date().toISOString(), account: key, draftId: String(row.id), retry: n, copyId: String(made.id), outcome: done?.x_post_published_at ? 'published' : (done?.status === 'error' ? 'error' : 'pending'), x: done?.x_published_url || null });
          if (done?.x_post_published_at) {
            const xText = body.platforms.x.posts.map((p) => p.text).join('\n');
            const rows = ledgerRowsForCopy(ledger, row.id, made.id, xText);
            if (rows.length) appendLedger(rows);
            rec.url = done.x_published_url;
          }
          ({ state } = retryState(copies));
          if (state === 'retry') orig = await tf.getDraft(ss, row.id);
        }
      }
      if (state === 'alert') {
        const orig = await tf.getDraft(ss, row.id);
        if (!dry) await notify(alertText({ handle: acc.handle, orig, copies }), { key: `publish-retry:${row.id}`, fingerprint: `failed-${copies.length}` });
      }
      rec.state = state;
      out.push(rec);
      console.log(`  @${acc.handle} ${row.id}: ${state}${rec.url ? ` ${rec.url}` : ''}${dry ? ' (dry)' : ''}`);
    }
  }
  return out;
}

/** Raw ledger rows (one JSON object per line); a bad line is skipped, never fatal. */
function readLedgerRows() {
  let raw = '';
  try { raw = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8'); } catch { return []; }
  return raw.split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const hi = args.indexOf('--hours');
  const windowH = hi > -1 ? Number(args[hi + 1]) || WINDOW_H : WINDOW_H;
  const env = loadEnv();
  if (!env.TYPEFULLY_API_KEY) { console.log('TYPEFULLY_API_KEY missing — skipping.'); return; }
  const tf = typefully(env);
  mkdirSync(join(HERE_DIR, 'logs'), { recursive: true });
  const res = await runRetries({
    tf, dry, windowH, ledger: readLedgerRows(),
    notify: (text, opts) => telegram(env, text, 'alerts', { ...opts, windowH: 24 * 7 }),
    appendLedger: (rows) => appendFileSync(join(HERE_DIR, 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
    log: (row) => appendFileSync(join(HERE_DIR, 'logs', 'publish-retry.jsonl'), JSON.stringify(row) + '\n'),
  });
  console.log(`publish-retry: ${res.length ? res.map((r) => `${r.key}:${r.id ?? ''}=${r.state}`).join(', ') : 'no failed X posts in the last ' + windowH + 'h'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exit(1); });
