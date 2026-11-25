#!/usr/bin/env node
// hotlist.mjs: what is going viral in the niche RIGHT NOW, read once at the start of donor selection.
//
// Owner, 2026-11-10: "how about we just run the hot list once during the donor selection to make sure
// we capture the latest stats and then just recreate from there." The swipe table's view counts were
// about 36 hours stale that morning and a 4.88M thread was only found by hand. So: take every thread
// head from the last N hours (Competitor Threads + Swipe), re-read them live, rank by live
// views and views per hour. No held slots, no recurring job.
//
// Every head is re-read live (owner, 2026-11-11: "why didn't we spot the creatine thread earlier.
// dial in our hot list mechanism"). The list used to re-read only the top N by STORED views, and a
// stored count is a snapshot taken whenever the row was saved, often minutes after posting: Dr_Biohacker's
// creatine thread was stored at 751 views, missed the cut of 60 among 99 heads, and sat at 2.04M in 13 h
// unseen. Now the stored count only orders the reads when there are more heads than --read allows, and
// heads under 24 h old (whose stored count says nothing yet) are read first.
//
//   node scripts/hotlist.mjs --out DIR [--hours 48] [--top 45] [--read 250]   ranked list -> DIR/hotlist-<time>.json
//   (--top only limits the printed rows; the file keeps every head, read or not.)
//   node scripts/hotlist.mjs bodies <tweetId>... --out DIR           full threads -> DIR/donors/<id>.body.json
//
//   node scripts/hotlist.mjs --out DIR --source fx [--watchlist FILE | --handles a,b] [--grok FILE]
//   The fx pages come from data/health-watchlist.json by default: keyed by X USER ID, not handle
//   (owner 2026-11-25), and rewritten after each read so a renamed page keeps its new handle.
//   --source airtable|fx|both (default both). fx = the tracked health pages' own timelines read live
//   from FxTwitter (free; their reposts surface pages we do not track yet), no Airtable rows needed.
//   --grok FILE merges the Grok daily scout's Section E JSON (an array of {handle,url,tweet_id,...}).
//
// OUTAGE (owner, 2026-11-25): twitter241 answers "not subscribed" since 2026-11-24, and the n8n trackers
// that fed Competitor Threads/Swipe stopped writing on 2026-11-23. Every live read now falls back to
// FxTwitter (fx-read.mjs) when the RapidAPI key is missing or refused.
//
// Read-only: Airtable and the X read API. It picks nothing; pick-donors.mjs still serves the older
// proven pool, and the writer chooses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fxThread, fxTimeline, headsFromTimelines, readWatchlist } from '../fx-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'twitter241.p.rapidapi.com';
export const COMPETITOR_THREADS = 'tblP4xywLyi2PZx3b';

// ---- pure helpers (tests/hotlist.test.mjs) -------------------------------------------------------
/** One row per tweet id from the two tables; the higher stored view count wins, both sources are named. */
export function mergeHeads(competitor = [], swipe = []) {
  const heads = new Map();
  for (const [src, rows] of [['competitor', competitor], ['swipe', swipe]]) for (const r of rows) {
    const x = r.fields || {}; const id = String(x.TweetID || (String(x['Tweet URL'] || '').match(/status\/(\d+)/) || [])[1] || '');
    if (!id) continue;
    const prev = heads.get(id);
    heads.set(id, {
      id, src: prev ? `${prev.src}+${src}` : src,
      recId: src === 'swipe' ? r.id : prev?.recId ?? null,
      handle: x.Handle || (String(x['Tweet URL'] || '').match(/x\.com\/([^/]+)/) || [])[1] || prev?.handle || '',
      url: x['Tweet URL'] || prev?.url || null, published: x['Published Date'] || prev?.published || null,
      stored: Math.max(Number(x.Impressions || 0), prev?.stored || 0),
      text: String(x.Text || prev?.text || '').replace(/\s+/g, ' ').slice(0, 140),
    });
  }
  return [...heads.values()];
}

/** Every tweet object in an API payload, keyed by id (the payload nests them at varying depths). */
export function tweetsIn(payload) {
  const all = new Map();
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.legacy && o.rest_id && o.legacy.full_text !== undefined && !all.has(o.rest_id)) {
      all.set(o.rest_id, {
        id: o.rest_id, uid: o.legacy.user_id_str, views: Number(o.views?.count || 0), reply: o.legacy.in_reply_to_status_id_str || null,
        text: o.note_tweet?.note_tweet_results?.result?.text || o.legacy.full_text,
        media: (o.legacy.extended_entities?.media || []).map((m) => m.type),
      });
    }
    for (const v of Object.values(o)) walk(v);
  })(payload);
  return all;
}

/**
 * Which heads to re-read live, in order. All of them when they fit under `cap`. Otherwise every head
 * younger than `freshH` hours first (newest first: a young stored count is a snapshot of the first
 * minutes), then the rest by stored views. Pure.
 */
export function readOrder(heads = [], cap = 250, now = Date.now(), freshH = 24) {
  const age = (h) => (now - Date.parse(h.published || 0)) / 36e5;
  const fresh = heads.filter((h) => age(h) < freshH).sort((a, b) => age(a) - age(b));
  const rest = heads.filter((h) => !(age(h) < freshH)).sort((a, b) => b.stored - a.stored);
  return [...fresh, ...rest].slice(0, Math.max(0, cap));
}

/** The author's own reply chain from the root down. Null when the root is not in the payload. */
export function chainOf(all, rootId) {
  const root = all.get(String(rootId)); if (!root) return null;
  const chain = [root];
  for (;;) { const next = [...all.values()].find((t) => t.reply === chain.at(-1).id && t.uid === root.uid); if (!next) break; chain.push(next); }
  return chain;
}

/** Age, the view count to trust (live when read, stored otherwise) and views per hour; sorted by views. */
export function rank(heads = [], now = Date.now()) {
  return heads.map((h) => {
    const ageH = +((now - Date.parse(h.published)) / 36e5).toFixed(1);
    const views = h.live ?? h.stored;
    return { ...h, ageH, views, perHour: Math.round(views / Math.max(ageH, 1)), liveRead: h.live != null };
  }).sort((a, b) => b.views - a.views);
}

// ---- wiring --------------------------------------------------------------------------------------
const arg = (argv, k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
// twitter241 first while it answers; a 401/403 is the plan itself, so the rest of the run reads FxTwitter.
let rapidDead = false;
async function readRapid(env, id, tries = 3) {
  const res = await fetch(`https://${HOST}/tweet?pid=${id}`, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': env.RAPIDAPI_KEY } });
  if (res.status === 401 || res.status === 403) { rapidDead = true; return null; }
  // 5 reads run at once now, and the plan answers 429 when they land together: wait and retry.
  if (res.status === 429 && tries > 1) { await new Promise((r) => setTimeout(r, 1500 * (4 - tries))); return readRapid(env, id, tries - 1); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return tweetsIn(await res.json());
}
/** Map(id -> tweet row) holding the thread of `id`: twitter241 when it answers, FxTwitter otherwise. */
export async function readTweet(env, id, { fx = fxThread } = {}) {
  if (env.RAPIDAPI_KEY && !rapidDead && env.X_READ_FX_ONLY !== '1') {
    try { const all = await readRapid(env, id); if (all && chainOf(all, id)) return all; } catch { /* FxTwitter below */ }
  }
  return fx(id);
}

/** PURE. Grok scout Section E rows -> heads. A row with no readable tweet id is dropped. */
export function headsFromGrok(rows = []) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String(r?.tweet_id || (String(r?.url || '').match(/status\/(\d+)/) || [])[1] || '');
    if (!/^\d{6,}$/.test(id)) continue;
    out.push({ id, src: 'grok', recId: null, handle: String(r.handle || (String(r.url || '').match(/x\.com\/([^/]+)/) || [])[1] || '').replace(/^@/, ''),
      url: r.url || null, published: r.posted_utc || null, stored: Number(r.views || 0), text: String(r.hook || '').replace(/\s+/g, ' ').slice(0, 140) });
  }
  return out;
}

/** PURE. Several head lists -> one row per id: sources joined, the higher stored count and the first known fields kept. */
export function mergeHeadLists(...lists) {
  const heads = new Map();
  for (const list of lists) for (const h of list || []) {
    const prev = heads.get(h.id);
    if (!prev) { heads.set(h.id, { ...h }); continue; }
    heads.set(h.id, { ...h, ...prev, src: prev.src.split('+').includes(h.src) ? prev.src : `${prev.src}+${h.src}`,
      recId: prev.recId ?? h.recId ?? null, published: prev.published || h.published, handle: prev.handle || h.handle,
      stored: Math.max(prev.stored || 0, h.stored || 0), via: prev.via ?? h.via ?? null });
  }
  return [...heads.values()];
}

/** The health pages whose timelines the fx source reads: every cohort row except Lifepad, plus Health Source. */
export const ROSTER_COHORTS = ['Direct Competitor', 'Same Niche', 'Competitor RT Bridge', 'Adjacent'];

export async function main(argv = process.argv.slice(2)) {
  const out = arg(argv, 'out');
  if (!out) { console.error('usage: node scripts/hotlist.mjs --out DIR [--hours 48] [--top 45] | bodies <tweetId>... --out DIR'); return 2; }
  const L = await import(pathToFileURL(path.join(ROOT, 'lib.mjs')).href);
  const env = L.loadEnv();
  if (argv[0] === 'bodies') {
    const ids = argv.slice(1).filter((a) => /^\d{10,}$/.test(a));
    fs.mkdirSync(path.join(out, 'donors'), { recursive: true });
    let failed = 0;
    for (const id of ids) {
      try {
        const chain = chainOf(await readTweet(env, id), id);
        if (!chain) throw new Error('root tweet missing (deleted or unavailable)');
        const body = { id, fetchedAt: new Date().toISOString(), views: chain.map((t) => t.views), tweets: chain.map((t) => String(t.text).replace(/\s*https:\/\/t\.co\/\S+$/, '')), media: chain.map((t) => t.media), videos: chain.map((t) => t.videos || []) };
        fs.writeFileSync(path.join(out, 'donors', `${id}.body.json`), JSON.stringify(body, null, 1));
        console.log(`${id}: ${chain.length} tweets · ${body.views[0]} views · hook media ${body.media[0].join(',') || 'none'}`);
      } catch (e) { failed++; console.log(`${id}: NOT READ (${e.message})`); }
    }
    return failed ? 1 : 0;
  }
  const { TABLES } = await import(pathToFileURL(path.join(ROOT, 'config.mjs')).href);
  const hours = Number(arg(argv, 'hours', 48)), topN = Number(arg(argv, 'top', 45)), cap = Number(arg(argv, 'read', 250));
  const source = arg(argv, 'source', 'both');
  const sinceMs = Date.now() - hours * 36e5;
  let competitor = [], swipe = [], fxHeads = [], grokHeads = [];
  const notes = [];
  const at = env.AIRTABLE_PAT && env.XDB_BASE_ID ? L.airtable(env, env.XDB_BASE_ID) : null;
  if (source !== 'fx' && at) {
    const formula = `AND({Tweet Number}=1, IS_AFTER({Published Date}, DATEADD(NOW(), -${hours}, 'hours')))`;
    try { competitor = await at.listAll(COMPETITOR_THREADS, { formula }); swipe = await at.listAll(TABLES.swipe, { formula }); }
    catch (e) { notes.push(`Airtable heads not read (${String(e.message).slice(0, 60)})`); }
  }
  if (source !== 'airtable') {
    let handles = String(arg(argv, 'handles', '') || '').split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean);
    const explicit = handles.length > 0;
    const wlFile = arg(argv, 'watchlist', explicit ? null : path.join(ROOT, 'data', 'health-watchlist.json'));
    if (!explicit && at && !(wlFile && fs.existsSync(wlFile))) {
      try {
        const cohorts = ROSTER_COHORTS.map((c) => `{Cohort}='${c}'`).join(',');
        const users = await at.listAll(TABLES.swipeUsers, { formula: `OR(${cohorts},{Health Source})`, fields: ['Handle'] });
        handles = [...new Set(users.map((u) => String(u.fields?.Handle || '').replace(/^@/, '')).filter(Boolean))];
      } catch (e) { notes.push(`roster not read (${String(e.message).slice(0, 60)})`); }
    }
    // BY ID (owner 2026-11-25): the watchlist file keys every page by its X user ID; a renamed page is
    // found again from its last seen tweet and the file is rewritten with the new handle.
    let timelines = [], unread = 0, pagesTotal = handles.length;
    if (wlFile && fs.existsSync(wlFile)) {
      const wl = JSON.parse(fs.readFileSync(wlFile, 'utf8'));
      const res = await readWatchlist(wl.pages || []);
      timelines = res.timelines; unread = res.unread.length; pagesTotal = (wl.pages || []).length;
      fs.writeFileSync(wlFile, `${JSON.stringify({ ...wl, pages: res.pages }, null, 1)}\n`);
      for (const r of res.renamed) notes.push(`RENAMED: user ${r.id} @${r.from} -> @${r.to} (watchlist updated)`);
      if (res.unread.length) notes.push(`not read: ${res.unread.map((h) => `@${h}`).join(', ')}`);
    } else {
      for (let i = 0; i < handles.length; i += 4) {
        await Promise.all(handles.slice(i, i + 4).map(async (handle) => {
          try { timelines.push({ handle, rows: await fxTimeline(handle) }); } catch { unread++; }
        }));
      }
    }
    const handlesLen = pagesTotal;
    fxHeads = headsFromTimelines(timelines, { sinceMs });
    notes.push(`FxTwitter timelines: ${timelines.length} of ${handlesLen} pages read${unread ? `, ${unread} NOT read` : ''}, ${fxHeads.length} heads (${fxHeads.filter((h) => h.src === 'fx-repost').length} reposted from other pages)`);
  }
  const grokFile = arg(argv, 'grok');
  if (grokFile) {
    try { const raw = fs.readFileSync(grokFile, 'utf8'); const m = raw.match(/\[[\s\S]*\]/); grokHeads = headsFromGrok(JSON.parse(m ? m[0] : raw)); }
    catch (e) { notes.push(`Grok file not read (${String(e.message).slice(0, 60)})`); }
    notes.push(`Grok scout: ${grokHeads.length} rows`);
  }
  const heads = mergeHeadLists(mergeHeads(competitor, swipe), fxHeads, grokHeads);
  const toRead = readOrder(heads, cap);
  for (const h of heads) if (!toRead.includes(h)) h.error = `over --read ${cap}`;
  for (let i = 0; i < toRead.length; i += 5) {
    await Promise.all(toRead.slice(i, i + 5).map(async (h) => {
      try { const all = await readTweet(env, h.id); const chain = chainOf(all, h.id); if (!chain) throw new Error('root missing'); if (chain[0].views != null) h.live = chain[0].views; h.len = chain.length; if (!h.published && chain[0].created) h.published = chain[0].created; if (!h.handle && chain[0].handle) h.handle = chain[0].handle; }
      catch (e) { h.error = String(e.message || e).slice(0, 60); }
    }));
  }
  const ranked = rank(heads);
  const unread = ranked.filter((h) => !h.liveRead).length;
  const stamp = new Date().toISOString();
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `hotlist-${stamp.slice(0, 16).replace(':', '')}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: stamp, hours, source, heads: heads.length, competitor: competitor.length, swipe: swipe.length, fx: fxHeads.length, grok: grokHeads.length, notes, top: ranked }, null, 1));
  for (const n of notes) console.log(n);
  console.log(`thread heads in ${hours}h: ${heads.length} (competitor ${competitor.length}, swipe ${swipe.length}, fx ${fxHeads.length}, grok ${grokHeads.length}), re-read live ${heads.length - unread}, not re-read ${unread} -> ${file}`);
  for (const h of ranked.slice(0, topN)) console.log([h.views, `${h.perHour}/h`, `${h.ageH}h`, h.liveRead ? 'live' : `STORED, not re-read (${h.error})`, `len ${h.len ?? '?'}`, h.src, h.recId || '-', `@${h.handle}${h.via ? ` (via @${h.via})` : ''}`, h.id, h.text.slice(0, 90)].join(' | '));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
