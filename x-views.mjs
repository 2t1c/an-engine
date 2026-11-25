// x-views.mjs — where "which posts went out" and "how many views" come from now that Typefully's
// analytics endpoint is gone.
//
// Typefully's GET /v2/social-sets/{id}/analytics/x/posts has answered 404 (an HTML "Not Found" page)
// since about 2026-09-30 10:00Z, and its v2 docs no longer list any analytics endpoint. That one
// call used to carry the post list, impressions and link clicks together. It is split here:
//   - WHICH posts went out, and when: the published-drafts list, newest first — the same read Fuel
//     the Fire's Pick Candidates moved to (docs/FUEL-OPS.md, "Where candidates come from"). One item
//     per publish; its head tweet is x_published_url. Thread tweets 2..N are not in it.
//   - VIEWS: X's own count, read through twitter241 on RapidAPI (the source the registry's X pass and
//     the swipe scouts use). Bulk `from:<handle>` search first, then one /tweet?pid= read for any id
//     the search did not reach. BACKUP (2026-11-24): any id twitter241 could not read (no key, plan
//     lapsed, error) is read from FxTwitter's free status endpoint. X_VIEWS_FX=0 turns the backup off.
//   - LINK CLICKS (per tweet): no source. X does not expose them publicly; Levanta's store-side
//     clicks per minted link are the only click count left.
//
// THE RULE: a view count that was not read is ABSENT, never 0. lookup() leaves an unread id out of
// `views` and lists it in `missing`; every caller shows it as unknown.

export const ANALYTICS_GONE = "Typefully's /analytics/x/posts has answered 404 since 2026-09-30 and its v2 docs no longer list it";

export const statusIdOf = (url = '') => (String(url || '').match(/status\/(\d+)/) || [])[1] || '';
/** When a published draft went out on X. x_post_published_at is often null on the list; published_at is not. */
export const publishedAtOf = (d) => Date.parse((d && (d.x_post_published_at || d.published_at)) || '');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every draft on a social set published at or after sinceMs (and before untilMs), newest first.
 *  Pages GET /drafts?status=published&order_by=-published_at until a page reaches older than sinceMs.
 *  A failed read THROWS (tf.get retries first): a short list must never read as "fewer posts". */
export async function publishedDrafts(tf, socialSetId, { sinceMs, untilMs = Infinity, limit = 50, maxPages = 60 } = {}) {
  if (!Number.isFinite(sinceMs)) throw new Error('publishedDrafts needs sinceMs');
  const out = [];
  for (let page = 0, offset = 0; ; page++) {
    if (page >= maxPages) throw new Error(`published drafts for ${socialSetId}: still newer than the window after ${maxPages} pages — raise maxPages`);
    const j = await tf.get(`/social-sets/${socialSetId}/drafts?status=published&order_by=-published_at&limit=${limit}&offset=${offset}`);
    const rows = j?.results;
    if (!Array.isArray(rows)) throw new Error(`published drafts for ${socialSetId}: response has no results list`);
    let older = false;
    for (const d of rows) {
      const listed = Date.parse(d.published_at || '');
      if (Number.isFinite(listed) && listed < sinceMs) older = true;
      const at = publishedAtOf(d);
      if (Number.isFinite(at) && at >= sinceMs && at < untilMs) out.push(d);
    }
    if (older || !j.next || !rows.length) return out;
    offset += rows.length;
  }
}

class XViewsUnavailable extends Error {}

/** X's own counts for a set of tweet ids. available is false with no RAPIDAPI_KEY; lookup() then throws.
 *  lookup(ids, { handle, sinceMs }) -> { views: Map(id -> { views, likes, comments, reposts, quotes, bookmarks }),
 *  missing: [ids not read], failures: number of reads that failed }. */
export function xViews(env = {}, { fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)), maxSearchPages = 40, maxLookups = 300, fxFallback = env.X_VIEWS_FX !== '0' } = {}) {
  const key = env.RAPIDAPI_KEY;
  const HOST = 'twitter241.p.rapidapi.com';
  // A 401/403 is the plan itself ("You are not subscribed to this API", 2026-11-24): every later call
  // would answer the same, so twitter241 is skipped for the rest of this lookup and FxTwitter reads it.
  let rapidDead = false;
  async function rapid(path, tries = 4) {
    if (rapidDead) return null;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetchImpl(`https://${HOST}${path}`, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key } });
        if (res.status === 401 || res.status === 403) { rapidDead = true; return null; }
        if (res.status === 429 || res.status >= 500) { await sleepImpl(1000 * (attempt + 1) ** 2); continue; }
        if (!res.ok) return null;
        return await res.json();
      } catch { await sleepImpl(1000 * (attempt + 1)); }
    }
    return null;
  }
  // Only ids we asked for are kept: a search page also carries quoted tweets by other authors.
  function harvest(obj, want, found) {
    if (!obj || typeof obj !== 'object') return 0;
    if (Array.isArray(obj)) return obj.reduce((n, v) => n + harvest(v, want, found), 0);
    let n = 0;
    if (obj.rest_id && obj.legacy && want.has(String(obj.rest_id)) && !found.has(String(obj.rest_id))) {
      const views = Number(obj.views?.count);
      if (obj.views?.count != null && Number.isFinite(views)) {
        const lg = obj.legacy;
        found.set(String(obj.rest_id), {
          views, likes: lg.favorite_count ?? null, comments: lg.reply_count ?? null,
          reposts: lg.retweet_count ?? null, quotes: lg.quote_count ?? null, bookmarks: lg.bookmark_count ?? null,
        });
        n++;
      }
    }
    for (const v of Object.values(obj)) n += harvest(v, want, found);
    return n;
  }
  // BACKUP SOURCE (owner 2026-11-24): FxTwitter's public status read, free and keyless. One call per id;
  // it can answer an empty 404 for a live tweet, so it is retried with backoff. Same counts, same rule:
  // a tweet it cannot read stays missing, never 0.
  async function fx(id, tries = 3) {
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetchImpl(`https://api.fxtwitter.com/status/${id}`, { headers: { 'user-agent': 'pi-views/1.0' } });
        if (res.ok) {
          const t = (await res.json())?.tweet;
          const views = Number(t?.views);
          if (t && String(t.id) === String(id) && t.views != null && Number.isFinite(views)) {
            return { views, likes: t.likes ?? null, comments: t.replies ?? null, reposts: t.retweets ?? null, quotes: t.quotes ?? null, bookmarks: t.bookmarks ?? null };
          }
        }
      } catch { /* retried below */ }
      await sleepImpl(1000 * (attempt + 1));
    }
    return null;
  }
  return {
    available: Boolean(key) || fxFallback,
    async lookup(ids, { handle = null, sinceMs = null } = {}) {
      if (!key && !fxFallback) throw new XViewsUnavailable('X views need RAPIDAPI_KEY (twitter241) or the FxTwitter backup; without them views are unknown, not 0');
      const want = new Set([...ids].map(String).filter(Boolean));
      const views = new Map();
      let failures = 0;
      if (key && handle && Number.isFinite(sinceMs) && want.size > 1) {
        const query = `from:${handle} since:${isoDay(sinceMs)} until:${isoDay(Date.now() + 864e5)}`;
        let cursor = null;
        const seen = new Set();
        for (let page = 0; page < maxSearchPages && views.size < want.size; page++) {
          const j = await rapid(`/search?type=Latest&count=20&query=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          if (!j) { failures++; break; }
          harvest(j, want, views);
          // Search pages past its end by repeating the last page: stop when a page holds no new tweet.
          const before = seen.size;
          (function walk(o) { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (o.rest_id && o.legacy?.full_text != null) seen.add(String(o.rest_id)); Object.values(o).forEach(walk); })(j);
          const next = j?.cursor?.bottom || j?.cursor_bottom || null;
          if (seen.size === before || !next || next === cursor) break;
          cursor = next;
        }
      }
      let lookups = 0;
      const viaFx = new Set();
      for (const id of want) {
        if (views.has(id)) continue;
        if (lookups++ >= maxLookups) break;
        const j = key ? await rapid(`/tweet?pid=${id}`) : null;
        if (j) harvest(j, new Set([id]), views);
        if (!views.has(id) && fxFallback) {
          const v = await fx(id);
          if (v) { views.set(id, v); viaFx.add(id); }
        }
        if (!views.has(id)) failures++;
      }
      return { views, missing: [...want].filter((id) => !views.has(id)), failures, viaFx: [...viaFx], rapidDead };
    },
  };
}
export { XViewsUnavailable };
