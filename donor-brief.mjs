#!/usr/bin/env node
// donor-brief.mjs <recId> [...] [--full N] — a donor body in the shape a writer actually reads.
//
// Reading a slate means reading the bodies, and a rollup is long: pulling 13 donors for one day on
// 2026-09-03 produced a 39KB dump that overflowed and had to be re-read in slices, twice. Almost none
// of that volume is decision-relevant. What you need per tweet is the ITEM the donor is on, whether
// the creator put a sell there, and enough of the argument to recreate it — not the whole paragraph.
//
//   node donor-brief.mjs recKcZlgkL0XPtx64
//   node donor-brief.mjs recA recB recC          # a whole slate, one screen
//   node donor-brief.mjs recA --full 4           # tweet 4 in full, when the brief is not enough
//
// Prints, per donor: handle, views, age, the sell positions the creator chose, and one line per
// tweet — its item number where it has one, then the first sentence, clipped. The full text is one
// flag away, which is the point: cheap by default, complete on demand.
import { pathToFileURL } from 'node:url';
import { loadEnv, airtable } from './lib.mjs';
import { TABLES } from './config.mjs';
import { tweetsFromRollup, donorAgeDays } from './checks.mjs';

/** PURE. The item number a tweet announces ("3." / "3)" / "Rule 7." / "RULE 7:"), or null. */
export function itemNumber(tweet) {
  const first = String(tweet || '').trim().split('\n')[0];
  const m = first.match(/^(?:rule|step|tip|sign|mistake|no\.?)?\s*#?(\d{1,2})\s*[.):]/i);
  return m ? Number(m[1]) : null;
}

/** PURE. One readable line for a tweet: its item number, then its opening sentence, clipped to `w`. */
export function briefLine(tweet, w = 96) {
  const flat = String(tweet || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const stop = flat.search(/(?<=[.!?])\s/);
  const head = (stop > 20 ? flat.slice(0, stop) : flat).trim();
  return head.length > w ? head.slice(0, w - 1).trimEnd() + '…' : head;
}

/** PURE. Which tweets carry the creator's own link — the positions they conversion-tested. */
export function sellPositions(tweets) {
  return (tweets || []).map((t, i) => (/https?:\/\/\S+/.test(String(t)) ? i + 1 : 0)).filter(Boolean);
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => /^rec[A-Za-z0-9]+$/.test(a));
  if (!ids.length) { console.error('usage: node donor-brief.mjs <recId> [...] [--full N]'); process.exit(2); }
  const fi = process.argv.indexOf('--full');
  const full = fi > 0 ? Number(process.argv[fi + 1]) : null;
  const at = airtable(loadEnv());
  for (const id of ids) {
    let rec; try { rec = await at.getRecord(TABLES.swipe, id); } catch (e) { console.log(`\n${id}  ! ${String(e.message).slice(0, 90)}`); continue; }
    const f = rec?.fields || {};
    const tweets = tweetsFromRollup(String(f['Full Thread Text'] || ''));
    const handle = (String(f['Tweet URL'] || '').match(/x\.com\/([^/]+)\//) || [])[1] || '?';
    const age = donorAgeDays(f);
    const sells = sellPositions(tweets);
    console.log(`\n${id}  @${handle}  ${Number(f.Impressions || 0).toLocaleString()} views  ${age == null ? '?' : Math.round(age)}d  ${tweets.length} tweets`
      + (sells.length ? `  SELL@${sells.join(',')}` : '  (no sell slot)'));
    tweets.forEach((t, i) => {
      const n = itemNumber(t);
      const mark = sells.includes(i + 1) ? '$' : ' ';
      console.log(`  ${mark}${String(i + 1).padStart(2)} ${n ? `[${String(n).padStart(2)}]` : '    '} ${briefLine(t)}`);
    });
    if (full) console.log(`\n  --- tweet ${full} in full ---\n${String(tweets[full - 1] || '(no such tweet)').split('\n').map((l) => '  ' + l).join('\n')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
