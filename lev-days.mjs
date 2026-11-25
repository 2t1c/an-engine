// lev-days.mjs — committed per-(date, link) Levanta history, so LIFETIME revenue exists.
//
// The registry's money window is a rolling 59 days and `Commission` is overwritten on every one of
// six daily runs — a post's earnings silently DECAY to $0 as its sales age out (June 2026: 15 of
// 178 posts still showed revenue at audit). This file is the fix that keeps history without trusting
// Airtable to hold it: one JSON line per (date, linkId), merged on every registry run.
//
// Merge rule: days INSIDE the current fetch window are always replaced by the fresh read — Levanta
// is authoritative there and that is what records reversals (Amazon returns shrink a day). Days
// OUTSIDE the window are frozen history. A never-decrease merge was rejected exactly because it
// could not record a reversal and conflated "window slid" with "revenue reversed".
//
// Line shape (sorted by date then link id, so git diffs stay stable and append-mostly):
//   {"d":"2026-08-20","lv":"lv_x","c":1.23,"s":10.5,"o":1,"k":140,"sid":"x-thread-...","a":"B0..."}
//   c=commission s=sales o=orders k=clicks(deduped) sid=Levanta sourceId (our subid) a=ASIN the link targets
//
// WHY sid AND a ARE STORED (2026-08-27). The board used to resolve link -> ASIN through the ledger's
// stored link URL alone, and that misses whenever a subid was minted more than once: each mint gets a
// fresh adgroup id, the ledger keeps one, and Levanta counts clicks on whichever link was actually
// posted. 24 links, 737 clicks and $294.81 sat unattributed for exactly that reason. Levanta's own
// report row already carries the subid AND the target ASIN in the link URL, so persisting both makes
// the join self-sufficient and offline. A subid is the thread's identity; a link id is one mint of it.
//
//   node lev-days.mjs --backfill 2026-06-01   # walk <=59-day windows back to the date (runner only)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, levanta, HERE_DIR } from './lib.mjs';

export const LEV_DAYS_FILE = 'levanta-days.jsonl';
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/** Fresh v1 report rows -> one aggregate per (date, link). Clicks dedup by MAX per (date, link)
 *  (the halo-ASIN repeat, same rule as aggregateLevReports); money fields sum per row. Pure. */
export const asinFromLevUrl = (u) => (String(u || '').match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || '';

export function dayRowsFromReports(reports) {
  const byDayLink = new Map();
  for (const r of reports || []) {
    const lv = r.link?.id, d = String(r.date || '').slice(0, 10);
    if (!lv || !d) continue;
    const key = `${d}|${lv}`;
    const g = byDayLink.get(key) || { d, lv, c: 0, s: 0, o: 0, k: 0, sid: '', a: '' };
    g.c += Number(r.commissionEarned) || 0; g.s += Number(r.sales) || 0; g.o += Number(r.conversions) || 0;
    g.k = Math.max(g.k, Number(r.clicks) || 0);
    // Both are properties of the LINK, identical on every row for it, so first non-empty wins.
    if (!g.sid) g.sid = String(r.link?.sourceId || '');
    if (!g.a) g.a = asinFromLevUrl(r.link?.url);
    byDayLink.set(key, g);
  }
  return [...byDayLink.values()].map((g) => ({ ...g, c: r2(g.c), s: r2(g.s) }));
}

/** link id -> {sid, asin} from the file text. Pure. The offline half of the subid join. */
export function linkMetaFrom(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line); if (!r.lv) continue;
      const g = out.get(r.lv) || { sid: '', asin: '' };
      if (!g.sid && r.sid) g.sid = r.sid;
      if (!g.asin && r.a) g.asin = r.a;
      out.set(r.lv, g);
    } catch {}
  }
  return out;
}

/** Merge fresh reports into the existing file text. In-window days replaced, older days frozen. Pure. */
export function mergeLevDays(existingText, freshReports, { windowStart }) {
  const kept = [];
  for (const line of String(existingText || '').split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row.d && row.d < windowStart) kept.push(row); } catch {}
  }
  const merged = [...kept, ...dayRowsFromReports(freshReports).filter((r) => r.d >= windowStart)];
  merged.sort((a, b) => (a.d === b.d ? (a.lv < b.lv ? -1 : a.lv > b.lv ? 1 : 0) : (a.d < b.d ? -1 : 1)));
  return merged.map((r) => JSON.stringify(r)).join('\n') + (merged.length ? '\n' : '');
}

/** Lifetime totals per link id from the file text. Pure. */
export function lifetimeByLink(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line); if (!r.lv) continue;
      const g = out.get(r.lv) || { commission: 0, sales: 0, orders: 0, clicks: 0 };
      g.commission += r.c || 0; g.sales += r.s || 0; g.orders += r.o || 0; g.clicks += r.k || 0;
      out.set(r.lv, g);
    } catch {}
  }
  return out;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const i = process.argv.indexOf('--backfill');
  const target = i > -1 ? process.argv[i + 1] : null;
  if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) { console.error('usage: node lev-days.mjs --backfill YYYY-MM-DD'); process.exit(1); }
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY']);
  const fp = join(HERE_DIR, LEV_DAYS_FILE);
  let text = existsSync(fp) ? readFileSync(fp, 'utf8') : '';
  // Walk backwards in <=59-day windows (Levanta caps the RANGE at 60 days, not recency). If an
  // older window returns zero rows, report the honest boundary and stop — pre-boundary history is
  // then unrecoverable and pretending otherwise would just freeze empty days into the file.
  // COLLECT every window first, then merge ONCE at `target`. Merging per window is what the loop used
  // to do and it silently destroys the file: mergeLevDays keeps only rows OLDER than its windowStart,
  // so each step backwards discards everything the previous, newer window had just written. A two
  // window walk left 59 day-rows and $425 behind out of 2,808 rows and $14,906 (2026-08-27). The
  // merge boundary for a backfill is the TARGET date, once, not each window's own start.
  const all = [];
  let end = new Date();
  while (isoDay(end) >= target) {
    const start = new Date(Math.max(Date.parse(target), end.getTime() - 59 * 864e5));
    const s = isoDay(start), e = isoDay(end);
    const reports = await levanta(env).listReports({ start: s, end: e });
    console.log(`window ${s} → ${e}: ${reports.length} report row(s)`);
    if (!reports.length && isoDay(end) !== isoDay(new Date())) {
      console.log(`Levanta returned nothing for ${s} → ${e} — treating ${e} as the honest history boundary and stopping.`);
      break;
    }
    all.push(...reports);
    if (s === target) break;
    end = new Date(start.getTime() - 864e5);
  }
  const before = lifetimeByLink(text);
  text = mergeLevDays(text, all, { windowStart: target });
  // A backfill must never shrink history. Levanta is authoritative for what it returns, but a short
  // read (an API hiccup, a silent cap) would otherwise overwrite good data with less of it.
  const after = lifetimeByLink(text);
  if (before.size && after.size < before.size * 0.9) {
    console.error(`REFUSING TO WRITE: backfill would drop ${before.size} links to ${after.size}. Levanta returned less than the file already holds — re-run when the API is healthy.`);
    process.exit(1);
  }
  writeFileSync(fp, text);
  const lt = lifetimeByLink(text);
  const total = [...lt.values()].reduce((a, g) => a + g.commission, 0);
  console.log(`${LEV_DAYS_FILE}: ${text.split('\n').filter(Boolean).length} day-rows · ${lt.size} links · lifetime commission $${total.toFixed(2)}`);
}
