#!/usr/bin/env node
// scoreboard.mjs: the daily read of the plug tests, one row per logged thread and one line per test group.
//
// Owner, 2026-11-10: the CTA tweet "is probably the best place to test", and the tests move fast (two
// crossed tests in four days), so every day needs the same table: how many people reached the plug tweet,
// how many clicked, how many bought. The measure is clicks per 1,000 views OF THE PLUG TWEET, not of the
// hook: a thread that goes viral loses most readers before the plug, and hook views would hide the CTA.
//
//   node scripts/scoreboard.mjs --log FILE --date YYYY-MM-DD [--date ...] --out DIR
//
// Read-only: Typefully (the draft and its published URL), the X read API (views on every tweet),
// Geniuslink (clicks per link) and Levanta (orders and commission, which settle a day or two late).
// A number that could not be read, or that Levanta has not reported yet, is null and printed as
// "unread", never as 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chainOf, readTweet } from './hotlist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINK_RE = /https:\/\/(geni\.us|lvnta\.com)\/([A-Za-z0-9_-]+)/g;
export const CLICK_HOURS = 24, ORDER_HOURS = 48;

// ---- pure helpers (tests/scoreboard.test.mjs) ----------------------------------------------------
/** The links of a thread in reading order: which tweet (1-based), which service, which code. */
export function linksOf(texts = []) {
  const out = [];
  texts.forEach((t, i) => { for (const m of String(t || '').matchAll(LINK_RE)) out.push({ tweet: i + 1, kind: m[1] === 'geni.us' ? 'geni' : 'levanta', code: m[2] }); });
  return out;
}

/**
 * Levanta's numbers for one link. Its clicks and orders arrive a day or two late, and a link with no row
 * yet (or a row still at zero clicks) looks the same as a link nobody clicked. So inside the order clock
 * a missing row is unread and zero clicks are unread; after it, they are real zeros.
 */
export function levantaNumbers(g, ageH) {
  const settled = ageH != null && ageH >= ORDER_HOURS;
  if (!g) return settled ? { clicks: 0, orders: 0, comm: 0 } : { clicks: null, orders: null, comm: null };
  return { clicks: g.clicks > 0 || settled ? g.clicks : null, orders: g.orders, comm: g.comm };
}

const per1k = (n, views) => (n == null || !views ? null : +((n / views) * 1000).toFixed(2));

/**
 * One thread's row. `views` is the view count of every tweet (null when the thread could not be read),
 * `links` is linksOf() with clicks, orders and comm joined on. The heavy link is the first one.
 */
export function threadRow(log, { views = null, links = [], publishedAt = null, now = Date.now() } = {}) {
  const heavy = links[0] || null;
  const plugViews = views && heavy ? views[heavy.tweet - 1] ?? null : null;
  const sum = (k) => (links.length && links.every((l) => l[k] != null) ? links.reduce((n, l) => n + l[k], 0) : null);
  const clicks = sum('clicks'), orders = sum('orders'), comm = sum('comm');
  const ageH = publishedAt ? +((now - Date.parse(publishedAt)) / 36e5).toFixed(1) : null;
  return {
    date: log.date, account: log.account, variant: log.variant ?? null, lane: log.lane ?? 'cover', seed: log.seed ?? null, group: log.group ?? null, arm: log.arm ?? null, boost: log.boost ?? null, style: log.style ?? null, linkArm: log.linkArm ?? null,
    draftId: String(log.draftId), ageH, hookViews: views ? views[0] : null, plugTweet: heavy ? heavy.tweet : null, plugViews,
    reach: views && plugViews != null && views[0] ? +(plugViews / views[0]).toFixed(3) : null,
    heavyClicks: heavy?.clicks ?? null, clicks, orders, comm: comm == null ? null : +comm.toFixed(2),
    heavyPer1k: per1k(heavy?.clicks ?? null, plugViews), clicksPer1k: per1k(clicks, plugViews), ordersPer1k: per1k(orders, plugViews), commPer1k: per1k(comm, plugViews),
    clicksFinal: ageH != null && ageH >= CLICK_HOURS, ordersFinal: ageH != null && ageH >= ORDER_HOURS,
  };
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? +(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(2) : null; };

/**
 * One line per value of `key` (group, boost, arm ...). Rates are pooled (all clicks over all plug views),
 * so one big thread cannot be outvoted by small ones, and the median per-thread rate sits beside it so one
 * big thread cannot carry the group either. Threads with an unread number are counted in `unread` and left
 * out of the rates.
 */
export function groupTable(rows = [], key = 'group') {
  const by = new Map();
  for (const r of rows) { const k = r[key] ?? '(none)'; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by.entries()].map(([k, rs]) => {
    const read = rs.filter((r) => r.plugViews != null && r.heavyClicks != null);
    const tot = (f) => read.reduce((n, r) => n + (r[f] || 0), 0);
    const plugViews = tot('plugViews');
    const withOrders = read.filter((r) => r.orders != null);
    const orderViews = withOrders.reduce((n, r) => n + r.plugViews, 0);
    return {
      [key]: k, threads: rs.length, unread: rs.length - read.length, hookViews: tot('hookViews'), plugViews,
      heavyPer1k: per1k(read.length ? tot('heavyClicks') : null, plugViews), medianHeavyPer1k: median(read.map((r) => r.heavyPer1k)),
      orders: withOrders.length ? withOrders.reduce((n, r) => n + r.orders, 0) : null,
      ordersPer1k: per1k(withOrders.length ? withOrders.reduce((n, r) => n + r.orders, 0) : null, orderViews),
      commPer1k: per1k(withOrders.length ? withOrders.reduce((n, r) => n + (r.comm || 0), 0) : null, orderViews),
      clicksFinal: rs.filter((r) => r.clicksFinal).length, ordersFinal: rs.filter((r) => r.ordersFinal).length,
    };
  }).sort((a, b) => (b.heavyPer1k ?? -1) - (a.heavyPer1k ?? -1));
}

const show = (v) => (v == null ? 'unread' : v);
/** The group table as markdown, with how many threads have passed each clock. */
export function tableMd(table, key = 'group') {
  const head = `| ${key} | threads | plug-tweet views | heavy clicks / 1k | median | orders | orders / 1k | $ / 1k | past 24h | past 48h |\n|---|---|---|---|---|---|---|---|---|---|`;
  return [head, ...table.map((t) => `| ${t[key]} | ${t.threads}${t.unread ? ` (${t.unread} unread)` : ''} | ${t.plugViews} | ${show(t.heavyPer1k)} | ${show(t.medianHeavyPer1k)} | ${show(t.orders)} | ${show(t.ordersPer1k)} | ${show(t.commPer1k)} | ${t.clicksFinal} | ${t.ordersFinal} |`)].join('\n');
}

// ---- wiring --------------------------------------------------------------------------------------
const args = (argv, k) => argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] ? [argv[i + 1]] : []));
const day = (d) => new Date(d).toISOString().slice(0, 10);

export async function main(argv = process.argv.slice(2)) {
  const logFile = args(argv, 'log')[0], out = args(argv, 'out')[0], dates = args(argv, 'date');
  if (!logFile || !out || !dates.length) { console.error('usage: node scripts/scoreboard.mjs --log FILE --date YYYY-MM-DD [--date ...] --out DIR'); return 2; }
  const L = await import(pathToFileURL(path.join(ROOT, 'lib.mjs')).href);
  const env = L.loadEnv(); const tf = L.typefully(env), gl = L.geniuslink(env);
  const logRows = JSON.parse(fs.readFileSync(logFile, 'utf8')).rows.filter((r) => dates.includes(r.date));
  const today = day(Date.now()), start = dates.slice().sort()[0];

  // Levanta by link id. A link's clicks are reported once per day, its orders once per order row.
  let lev = null, codeToLv = new Map();
  try {
    lev = new Map(); const seen = new Set();
    for (const r of await L.levanta(env).listReports({ start, end: today })) {
      const id = r.link?.id || r.link || ''; const g = lev.get(id) || { clicks: 0, orders: 0, comm: 0 };
      const ck = `${r.date}|${id}`; if (!seen.has(ck)) { seen.add(ck); g.clicks += Number(r.clicks || 0); }
      g.orders += Number(r.conversions || 0); g.comm += Number(r.commissionEarned || 0); lev.set(id, g);
    }
    for (const l of await gl.listAllLinks({})) { const m = decodeURIComponent(String(l.destinationUrl || '')).match(/aa_adgroupid=(lv_[A-Za-z0-9]+)/); if (l.shortUrlCode && m) codeToLv.set(l.shortUrlCode, m[1]); }
  } catch (e) { console.log(`Levanta or the Geniuslink link list was not read (${String(e.message).slice(0, 80)}): orders are unread`); lev = null; }

  const rows = [], notes = [];
  for (const log of logRows) {
    let d; try { d = await tf.getDraft(log.socialSetId, log.draftId); } catch (e) { notes.push(`${log.account} ${log.date}: draft not read (${String(e.message).slice(0, 60)})`); rows.push(threadRow(log)); continue; }
    const texts = (d.platforms?.x?.posts || []).map((p) => p.text || '');
    const tweetId = (String(d.x_published_url || '').match(/status\/(\d+)/) || [])[1];
    if (!tweetId) { notes.push(`${log.account} ${log.date}: not posted yet (${d.status})`); continue; }
    const publishedAt = d.x_post_published_at || d.published_at || log.publishAt;
    let views = null;
    try {
      // twitter241 while it answers, FxTwitter otherwise (outage, 2026-11-25): hotlist.mjs readTweet.
      const chain = chainOf(await readTweet(env, tweetId), tweetId);
      if (!chain) throw new Error('root missing');
      views = chain.map((t) => t.views);
      if (views.length < texts.length) notes.push(`${log.account} ${log.date}: the read returned ${views.length} of ${texts.length} tweets`);
    } catch (e) { notes.push(`${log.account} ${log.date}: views not read (${String(e.message).slice(0, 60)})`); }
    const links = [], ageH = (Date.now() - Date.parse(publishedAt)) / 36e5;
    for (const l of linksOf(texts)) {
      const lvId = l.kind === 'geni' ? codeToLv.get(l.code) : l.code;
      const lv = lev && lvId ? levantaNumbers(lev.get(lvId), ageH) : { clicks: null, orders: null, comm: null };
      let clicks = lv.clicks;
      if (l.kind === 'geni') { clicks = null; try { clicks = (await gl.linkClicks({ code: l.code, start: day(publishedAt), end: today, resolution: 'day' })).reduce((n, r) => n + (r.clicksMinusBot || 0), 0); } catch (e) { notes.push(`${log.account} ${log.date}: clicks on ${l.code} not read`); } }
      links.push({ ...l, clicks, levClicks: lv.clicks, orders: lv.orders, comm: lv.comm });
    }
    rows.push({ ...threadRow(log, { views, links, publishedAt }), url: d.x_published_url, links });
  }

  const stamp = new Date().toISOString();
  const board = { at: stamp, dates, threads: rows.length, logged: logRows.length, byGroup: groupTable(rows, 'group'), byBoost: groupTable(rows, 'boost'), byArm: groupTable(rows, 'arm'), byLinkArm: groupTable(rows, 'linkArm'), byLane: groupTable(rows, 'lane'), bySeed: groupTable(rows.filter((r) => r.seed), 'seed'), rows, notes };
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `scoreboard-${dates.join('_')}-${stamp.slice(0, 13)}.json`);
  fs.writeFileSync(file, JSON.stringify(board, null, 1));
  console.log(`scoreboard ${dates.join(', ')}: ${rows.length} of ${logRows.length} logged threads posted -> ${file}`);
  console.log(`\nBy test group (clicks are final after ${CLICK_HOURS}h, orders after ${ORDER_HOURS}h)\n${tableMd(board.byGroup, 'group')}`);
  console.log(`\nBy boost\n${tableMd(board.byBoost, 'boost')}`);
  console.log(`\nBy CTA arm\n${tableMd(board.byArm, 'arm')}`);
  console.log(`\nBy lane (pots against covers)\n${tableMd(board.byLane, 'lane')}`);
  if (board.bySeed.length) console.log(`\nBy seed\n${tableMd(board.bySeed, 'seed')}`);
  console.log(`\nBy link (Geniuslink clicks and Levanta clicks are different counts: compare the links on orders and $)\n${tableMd(board.byLinkArm, 'linkArm')}`);
  console.log('\naccount | group | boost | age h | hook views | plug views | reach | heavy clicks | /1k | orders | $');
  for (const r of rows) console.log([r.account, r.group ?? '-', r.boost ?? '-', show(r.ageH), show(r.hookViews), show(r.plugViews), show(r.reach), show(r.heavyClicks), show(r.heavyPer1k), show(r.orders), show(r.comm)].join(' | '));
  for (const n of notes) console.log(`note: ${n}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
