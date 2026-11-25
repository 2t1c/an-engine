// fx-read.mjs — X reads through FxTwitter's free, keyless API, for when the paid read API is gone.
//
// Owner, 2026-11-25: "we literally have no money for Zernio and the other Twitter API tools ... imagine
// this is day zero". twitter241 (RapidAPI) answers "You are not subscribed to this API" since
// 2026-11-24. FxTwitter serves everything the daily jobs read, for free:
//   - fxThread(id)      GET /2/thread/<id>            the author's whole thread, per-tweet views and media
//   - fxTimeline(handle) GET /2/profile/<h>/statuses  ~20 newest posts, INCLUDING what the page reposted
//                                                    (reposted_by), which is how new network pages surface
//   - fxUser(handle)    GET /<handle>                 follower count
// It answers an empty 404 (or an empty results list) for a live account about half the time, so every
// read retries with backoff. A read that never answers is an error, never an empty list or a 0.
//
// The shapes returned match what the twitter241 parsers produced (scripts/hotlist.mjs tweetsIn), so
// chainOf() and the callers work unchanged.

const BASE = 'https://api.fxtwitter.com';
const UA = { 'user-agent': 'pi-reader/1.0' };
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a FxTwitter path; `ok(json)` says whether the answer is real. Throws after `tries`. */
export async function fxGet(pathname, ok, { fetchImpl = globalThis.fetch, sleepImpl = defaultSleep, tries = 5 } = {}) {
  let last = 'no answer';
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetchImpl(`${BASE}${pathname}`, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (res.ok) {
        const j = await res.json();
        if (ok(j)) return j;
        last = 'empty answer';
      } else last = `HTTP ${res.status}`;
    } catch (e) { last = String(e?.message || 'fetch failed').slice(0, 60); }
    if (attempt < tries - 1) await sleepImpl(1500 * (attempt + 1));
  }
  throw new Error(`FxTwitter ${pathname}: ${last} after ${tries} tries`);
}

const mediaOf = (t) => (t?.media?.all || []).map((m) => (m.type === 'photo' ? 'photo' : m.type === 'gif' ? 'animated_gif' : 'video'));

/** PURE. One FxTwitter status -> the tweetsIn() row shape. */
export function fxRow(t) {
  return {
    id: String(t.id),
    uid: String(t.author?.id || t.author?.screen_name || ''),
    handle: t.author?.screen_name || '',
    views: t.views == null ? null : Number(t.views),
    likes: t.likes ?? null, reposts: t.reposts ?? null, bookmarks: t.bookmarks ?? null, replies: t.replies ?? null, quotes: t.quotes ?? null,
    reply: t.replying_to?.status ? String(t.replying_to.status) : null,
    text: String(t.raw_text?.text || t.text || ''),
    media: mediaOf(t),
    videos: (t.media?.all || []).filter((m) => m.type !== 'photo' && m.url).map((m) => m.url),
    created: t.created_timestamp ? new Date(t.created_timestamp * 1000).toISOString() : (t.created_at ? new Date(t.created_at).toISOString() : null),
    repostedBy: t.reposted_by?.screen_name || null,
    url: t.url || null,
  };
}

/** The author's thread from the root down, as Map(id -> row) (same as tweetsIn), so chainOf(all, id) works. */
export async function fxThread(id, opts = {}) {
  const j = await fxGet(`/2/thread/${id}`, (x) => x?.status || (Array.isArray(x?.thread) && x.thread.length), opts);
  const list = Array.isArray(j.thread) && j.thread.length ? j.thread : [j.status];
  const all = new Map();
  for (const t of list) if (t?.id) all.set(String(t.id), fxRow(t));
  return all;
}

/** Map(reference tweet number, 1-based -> mp4 URL) for the author's tweets that carry a video or GIF.
 *  Null when FxTwitter never answers. media.mjs's "follow the reference" pass reads this. */
export async function fxVideoByNum(hookId, { thread = fxThread, ...opts } = {}) {
  try {
    const all = await thread(hookId, opts);
    const head = all.get(String(hookId)); if (!head) return null;
    const mine = [...all.values()].filter((t) => t.uid === head.uid).sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
    const map = new Map();
    mine.forEach((t, i) => { if (t.videos?.[0]) map.set(i + 1, t.videos[0]); });
    return map;
  } catch { return null; }
}

/** A page's newest posts (its own and what it reposted). Throws when FxTwitter never answers. */
export async function fxTimeline(handle, opts = {}) {
  const j = await fxGet(`/2/profile/${encodeURIComponent(handle)}/statuses`, (x) => Array.isArray(x?.results) && x.results.length, opts);
  return j.results.map(fxRow);
}

/** { followers, restId } | { error } — the same contract as x-followers.mjs read(). */
export async function fxUser(handle, opts = {}) {
  try {
    const j = await fxGet(`/${encodeURIComponent(handle)}`, (x) => x?.user && Number.isFinite(Number(x.user.followers)), opts);
    return { followers: Number(j.user.followers), restId: String(j.user.id || '') || null };
  } catch (e) { return { error: e.message }; }
}

/**
 * PURE. Thread heads from timelines: posts that are not replies, made in the window. A post the page
 * reposted counts as a head of its ORIGINAL author (src 'fx-repost', via = who reposted it): that is how
 * a new network page we do not track yet shows up.
 */
export function headsFromTimelines(timelines = [], { sinceMs = 0 } = {}) {
  const heads = new Map();
  for (const { handle, rows } of timelines) for (const r of rows || []) {
    if (r.reply) continue;
    const at = Date.parse(r.created || '');
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const prev = heads.get(r.id);
    const own = !r.repostedBy || String(r.handle || '').toLowerCase() === String(handle || '').toLowerCase();
    const src = own ? 'fx' : 'fx-repost';
    if (prev && prev.src === 'fx') continue;
    heads.set(r.id, {
      id: r.id, src, recId: null, handle: r.handle || handle, via: own ? null : handle,
      url: r.url || `https://x.com/${r.handle || handle}/status/${r.id}`, published: r.created,
      stored: Number(r.views || 0), live: r.views == null ? undefined : Number(r.views),
      text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 140), media: r.media,
    });
  }
  return [...heads.values()];
}

/**
 * Read a watchlist keyed by X user ID (owner, 2026-11-25: "track through their ID, not their handle,
 * since handle can change, but ID is constant"). FxTwitter only looks pages up by handle, so each page
 * keeps its ID, its last known handle and its last seen tweet id:
 *   1. read the timeline by the last known handle, and keep it only if the page's own posts carry the
 *      stored ID (a freed-up handle taken by someone else is not our page);
 *   2. otherwise look up the last seen tweet by its id (works without a handle): its author with the
 *      same ID gives the page's current handle, and the timeline is read again under it.
 * Returns { timelines: [{handle, id, rows}], pages (updated copy), renamed: [{id, from, to}], unread: [handle] }.
 */
export async function readWatchlist(pages = [], { timeline = fxTimeline, status = (id, o) => fxGet(`/i/status/${id}`, (x) => x?.tweet?.author, o), concurrency = 4, ...opts } = {}) {
  const out = { timelines: [], pages: pages.map((p) => ({ ...p })), renamed: [], unread: [] };
  const ownOf = (rows, id) => rows.filter((r) => String(r.uid) === String(id) && !r.repostedBy);
  const read = async (handle) => { try { return await timeline(handle, opts); } catch { return null; } };
  // Valid = the page's own posts carry the stored ID (a timeline of only reposts can't be checked; kept).
  const valid = (rows, id) => Array.isArray(rows) && (ownOf(rows, id).length > 0 || rows.every((r) => r.repostedBy));
  async function one(p) {
    let rows = await read(p.handle);
    if (!valid(rows, p.id) && p.lastTweetId) {
      try {
        const a = (await status(p.lastTweetId, opts)).tweet.author;
        if (String(a.id) === String(p.id) && a.screen_name && a.screen_name.toLowerCase() !== String(p.handle).toLowerCase()) {
          out.renamed.push({ id: p.id, from: p.handle, to: a.screen_name });
          p.handle = a.screen_name;
          rows = await read(p.handle);
        }
      } catch { /* stays unread below */ }
    }
    if (!valid(rows, p.id)) { out.unread.push(p.handle); return; }
    const newest = ownOf(rows, p.id).map((r) => r.id).sort((x, y) => (BigInt(y) > BigInt(x) ? 1 : -1))[0];
    if (newest) p.lastTweetId = newest;
    out.timelines.push({ handle: p.handle, id: p.id, rows });
  }
  for (let i = 0; i < out.pages.length; i += concurrency) await Promise.all(out.pages.slice(i, i + concurrency).map(one));
  return out;
}
