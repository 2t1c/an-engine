#!/usr/bin/env node
// click-check.mjs — one post, every click counter we hold, side by side.
//
// Built 2026-08-26 after a comparison went wrong three times in a row, each time because a number
// was not what it was labelled. The failures are worth naming, because this tool exists to make them
// impossible to repeat:
//
//   1. "X clicks" was read from Airtable's `Link Clicks`, which registry-sync writes as
//      MAX(Typefully, Levanta). Comparing a maximum against one of its own inputs guarantees the
//      input never wins, so the ratio measured the arithmetic rather than the platforms.
//   2. Levanta clicks were read from Airtable's `Affiliate Clicks`, which lags the store by ~25%
//      fleet-wide. Levanta's own day file is the only honest source.
//   3. "Views" were a SUM of impressions across every tweet in the thread. X shows the HEAD tweet's
//      number. On a 13-tweet thread that is a 34x overstatement.
//
// So: views are the head tweet's and Levanta comes from levanta-days.jsonl.
//
// SINCE 2026-10-02 there is no Typefully column. Its per-tweet impressions and link_clicks came from
// /analytics/x/posts, which has answered 404 since 2026-09-30 (the run crashed on it). Views are now
// X's own count for the head tweet (twitter241, x-views.mjs); per-tweet link clicks have no source and
// print as "not available", never 0. Without RAPIDAPI_KEY, or when X cannot be read, views print as
// unknown.
//
//   node click-check.mjs https://x.com/MagnusLindbrg/status/2091...
//   node click-check.mjs 10256230
//
import { readFileSync } from 'node:fs';
import { loadEnv, typefully, lvIdOf, HERE_DIR, runMain } from './lib.mjs';
import { ANALYTICS_GONE, statusIdOf, xViews } from './x-views.mjs';
import { pathToFileURL } from 'node:url';
import { ACCOUNTS } from './accounts.mjs';
import { join } from 'node:path';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
/** The views line: X's head-tweet count, or why it is unknown. Never a 0 for a count that was not read. */
export function viewsLine({ views = null, reason = null } = {}) {
  return views == null
    ? `VIEWS         head tweet: unknown (${reason || 'not read'})`
    : `VIEWS         head tweet ${Number(views).toLocaleString('en-US')} (X's own count)`;
}
/** The Typefully line: the source is gone, so it says so instead of printing a total. */
export const typefullyLine = () => `TYPEFULLY     per-tweet impressions and link_clicks: not available — ${ANALYTICS_GONE}`;

const readJsonl = (f) => readFileSync(join(HERE_DIR, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function main() {
  if (!arg) throw new Error('Pass an X post URL or a Typefully draft id');
  const env = loadEnv();
  const tf = typefully(env);

  // ---- resolve the post to a draft --------------------------------------------------------------
  const facts = readJsonl('facts.jsonl');
  const statusId = (String(arg).match(/status\/(\d+)/) || [])[1];
  let row = /^\d+$/.test(arg)
    ? facts.filter((f) => String(f.draftId) === arg).pop()
    : facts.filter((f) => f.xUrl && (statusId ? String(f.xUrl).includes(statusId) : f.xUrl === arg)).pop();
  // facts.jsonl is rebuilt nightly, so a post from today is not in it yet. Ask Typefully directly
  // rather than refusing — a same-day post is exactly the one worth checking.
  if (!row && statusId) {
    for (const a of Object.values(ACCOUNTS).filter((x) => x.socialSetId)) {
      for (let off = 0; ; off += 50) {
        let j; try { j = await tf.get(`/social-sets/${a.socialSetId}/drafts?status=published&limit=50&offset=${off}`); } catch { break; }
        const hit = (j.results || []).find((d) => String(d.x_published_url || '').includes(statusId));
        if (hit) { row = { draftId: String(hit.id), account: a.name, title: String(hit.platforms?.x?.posts?.[0]?.text || '').split('\n')[0], xUrl: hit.x_published_url, postedAt: hit.published_at }; break; }
        if (!j.next || !(j.results || []).length) break;
      }
      if (row) break;
    }
  }
  if (!row) throw new Error(`No thread found for ${arg} — is it one of ours?`);
  const acc = Object.values(ACCOUNTS).find((a) => a.name === row.account);
  if (!acc) throw new Error(`Unknown account on that thread: ${row.account}`);

  // ---- LEVANTA: the store's own counter, never Airtable's copy of it ----------------------------
  const days = readJsonl('levanta-days.jsonl');
  const lastDay = days.map((d) => d.d).sort().pop();
  const ledger = readJsonl('ledger.jsonl').filter((l) => String(l.draftId) === String(row.draftId));
  const links = [];
  for (const l of ledger) for (const [u, a] of [[l.link, l.asin], [l.link2, l.asin2]]) {
    const id = u && lvIdOf(u);
    if (id && !links.find((x) => x.id === id)) links.push({ id, url: u, asin: a });
  }
  for (const l of links) {
    const mine = days.filter((d) => d.lv === l.id);
    l.clicks = mine.reduce((n, d) => n + (d.k || 0), 0);
    l.commission = mine.reduce((n, d) => n + (d.c || 0), 0);
    l.orders = mine.reduce((n, d) => n + (d.o || 0), 0);
  }

  // ---- X: the head tweet's views (Typefully's per-tweet analytics are gone) ----------------------
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const headId = statusIdOf(row.xUrl);
  let xv = { views: null, reason: null };
  const src = xViews(env);
  if (!headId) xv.reason = 'no X URL on record';
  else if (!src.available) xv.reason = 'RAPIDAPI_KEY not set';
  else {
    const r = await src.lookup([headId]);
    if (r.views.has(headId)) xv.views = r.views.get(headId).views; else xv.reason = 'X read failed';
  }

  // ---- report -----------------------------------------------------------------------------------
  console.log(`\n${row.account} · draft ${row.draftId}`);
  console.log(`${String(row.title || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 74)}`);
  console.log(row.xUrl || '(no x url on record)');

  console.log(`\n${viewsLine(xv)}`);
  console.log(`\n${typefullyLine()}`);
  console.log(`\nLEVANTA, per link — store-side, from levanta-days.jsonl (through ${lastDay})`);
  if (!links.length) console.log('  no tracked link on record for this thread — nothing to attribute');
  for (const l of links) console.log(`  ${l.id}  ${String(l.asin || '').padEnd(11)} clicks ${String(l.clicks).padStart(6)}   $${l.commission.toFixed(2)}   ${l.orders} order(s)`);
  const levTotal = links.reduce((a, l) => a + l.clicks, 0);
  console.log(`  LEVANTA TOTAL:   ${levTotal}`);

  console.log(`\n  Levanta ${levTotal}   ·   Typefully n/a (source gone)`);
  console.log('  X Analytics: open the post above and read its own link-click figure.\n');
  if (row.postedAt && iso(row.postedAt) > lastDay) console.log(`  ⚠ posted after ${lastDay}, the last day in the Levanta file — its clicks may not be pulled yet.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'click-check');
