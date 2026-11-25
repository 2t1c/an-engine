#!/usr/bin/env node
// gtx-registry.mjs — the GeniusGTX registry. One row per published post, with its lifetime
// metrics, in the GTX engine base (appzvAY2YXbjLOTFo -> "Registry").
//
// THE SPINE IS THE PUBLISHED-DRAFTS LIST (2026-10-02). Until then it was Typefully's
// /analytics/x/posts, which returned every published tweet with impressions and engagement. That
// endpoint has answered 404 since 2026-09-30 (the run crashed on it), so:
//   - WHICH posts: one row per publish from /drafts?status=published (x-views.mjs publishedDrafts),
//     keyed on its head tweet. An X Article (X posting off) costs one draft read for its tweet, once:
//     a later run finds it by Draft ID. Thread tweets 2..N are no longer added (the list does not
//     carry them); rows already in the registry keep theirs, and the X pass still refreshes them.
//   - TYPEFULLY'S OWN NUMBERS ({Impressions}, {Profile Clicks}, {Link Clicks}, {Engagement},
//     {Tweet Number}, {Last Synced}) are no longer written. A row keeps the last value Typefully gave
//     it; a new row leaves them blank. Never 0: there is no source for them now.
//   - FORMAT: the drafts list omits the platform payload, so format costs one draft fetch per post.
//     It is immutable after publishing, so that is one call per post EVER — rows that already carry a
//     Format are never re-fetched.
//   - REACH: X's own numbers through twitter241 on RapidAPI — the same provider the swipe scouts use —
//     fill {X Views} and the public engagement counts. A count X did not return is left unwritten,
//     never written as 0. Typefully's impressions ran 1-8% under X on settled posts and drifted badly on
//     recent ones (3.72x on the 2026-08-21 power-wall post), which is why eligibility was always
//     judged on X.
//   - The article queue. A LEAD long-form post that clears the reach bar ON X VIEWS gets
//     {Article Status} = Eligible, and the article pipeline reads that view.
//
//   node gtx-registry.mjs                  # sync both brands, rolling 120-day window
//   node gtx-registry.mjs --days 364       # widen the window (the API caps just under 400 days)
//   node gtx-registry.mjs --account gtx    # one brand only
//   node gtx-registry.mjs --bar 250000     # override the article-eligibility bar
//   node gtx-registry.mjs --dry            # compute and print, write nothing
//   node gtx-registry.mjs --no-format      # skip the format backfill (metrics only, much faster)
//   node gtx-registry.mjs --no-x           # skip the X pass (Typefully numbers only)
//
// Env: TYPEFULLY_API_KEY, AIRTABLE_PAT, RAPIDAPI_KEY.
import { loadEnv, requireEnv, airtable, typefully, cliArg } from './lib.mjs';
import { publishedDrafts, publishedAtOf, statusIdOf } from './x-views.mjs';

// THIS FILE IS A SCRIPT, NOT A MODULE. Everything below runs at import time — there is no main()
// to guard — so `import('./gtx-registry.mjs')` performs a full live sync against the registry base:
// thousands of Typefully reads, an X pass on RapidAPI, and upserts. That is exactly what happened
// on 2026-09-10, when a check that the imports merely RESOLVED kicked off a real sync of 2,608
// posts. Nothing was damaged (it is the same job the Mon/Wed/Fri cron runs) but nobody asked for
// it, and a silent side effect that large is worth one loud line to prevent.
//
// Ported from the Genius repo 2026-09-19, which has carried this guard since the incident while
// this copy — the one the accident actually happened in — still did not.
if (import.meta.url !== `file://${process.argv[1]}`) {
  throw new Error('gtx-registry.mjs is a script, not a module — importing it runs a live registry sync. Run it with `node gtx-registry.mjs` instead.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NO_FORMAT = args.includes('--no-format');
const NO_X = args.includes('--no-x');
const DAYS = Number(cliArg('days', 120));
const ONLY = (cliArg('account', '') || '').toLowerCase();
// Why 250K: long-form posts run a ~124K median, and 250K is roughly the top fifth of them — rare
// enough that Eligible stays a short list a human can actually read, generous enough to catch a
// piece a week in a good month. Judged on {X Views}, never on Typefully's impressions (operator
// 2026-09-02). Tune with --bar; nothing downstream assumes the number.
const BAR = Number(cliArg('bar', 250000));

const BRANDS = [
  { key: 'gtx', name: 'GeniusGTX', socialSetId: 151393, handle: 'GeniusGTX' },
  { key: 'learningtoan', name: 'LearningToan', socialSetId: 201212, handle: 'LearningToan' },
].filter((b) => !ONLY || b.key === ONLY || b.name.toLowerCase() === ONLY);
if (!BRANDS.length) { console.error(`unknown --account ${JSON.stringify(ONLY)} — use gtx or learningtoan.`); process.exit(1); }

const BASE = 'appzvAY2YXbjLOTFo';
const TABLE = 'tblkw8MzW7CzTFcrm';
const env = loadEnv();
requireEnv(env, ['TYPEFULLY_API_KEY', 'AIRTABLE_PAT']);
if (!NO_X) requireEnv(env, ['RAPIDAPI_KEY']);
const tf = typefully(env);
const at = airtable(env, BASE);

const isoDay = (d) => d.toISOString().slice(0, 10);

// Format from a draft payload.
//
// THE RULE (operator 2026-09-02): 2 posts is still LONG-FORM, more than 2 is a thread.
// GTX ships long-form as body + the standard PS/CTA post, so a 2-post publish is one piece of
// writing with a plug stapled on, not a thread — and that holds however short the body is, which
// is why length is not consulted at 2. Real threads run 7-24 posts with nothing at 3-6, so the
// boundary has clear air around it. Length only decides the single-post case: over 280 chars is
// long-form, under is a tweet.
export function formatOf(draft) {
  const pl = draft?.platforms || {};
  if ((pl.x_article || {}).content_markdown) return { format: 'Article', len: 1, chars: 0, qrt: false, quoted: null, media: false };
  const posts = (pl.x || {}).posts || [];
  if (!posts.length) return null;
  const first = posts[0] || {};
  const text = first.text || '';
  const len = posts.length;
  const format = len > 2 ? 'Thread' : (len === 2 || text.length > 280 ? 'Long-form' : 'Tweet');
  return {
    format, len, chars: text.length,
    qrt: Boolean(first.quote_post_url), quoted: first.quote_post_url || null,
    media: Boolean((first.media_ids || []).length),
  };
}

// ---- X's own numbers (twitter241 on RapidAPI) ------------------------------------------------
// Same host the swipe scouts use. Read in BULK via `from:<handle>` search — roughly 20 posts a
// page — rather than one call per post, which would be ~2,000 calls a run instead of ~100.
const RAPID_HOST = 'twitter241.p.rapidapi.com';
async function rapid(path, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(`https://${RAPID_HOST}${path}`, {
        headers: { 'x-rapidapi-host': RAPID_HOST, 'x-rapidapi-key': env.RAPIDAPI_KEY },
      });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (attempt + 1) ** 2); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return null;
}

// Shape-agnostic tweet extraction: the payload nests results differently across endpoints, so walk
// it and keep anything carrying a rest_id and a legacy block.
function collectTweets(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) { for (const v of obj) collectTweets(v, acc); return acc; }
  if (obj.rest_id && obj.legacy) acc.push(obj);
  for (const v of Object.values(obj)) collectTweets(v, acc);
  return acc;
}

// Every post by `handle` in the window, as a Map of post id -> X's public counts.
async function xMetrics(handle, days) {
  const since = isoDay(new Date(Date.now() - days * 864e5));
  const until = isoDay(new Date(Date.now() + 864e5)); // exclusive, so today is included
  const found = new Map();
  let cursor = null, pages = 0;
  for (;;) {
    let path = `/search?type=Latest&count=20&query=${encodeURIComponent(`from:${handle} since:${since} until:${until}`)}`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    const j = await rapid(path);
    if (!j) { console.warn(`  ! X search for @${handle} failed after ${pages} page(s) — posts past that point are not re-scored this run (their X fields keep their previous values)`); break; }
    const tweets = collectTweets(j);
    let fresh = 0;
    for (const t of tweets) {
      const id = String(t.rest_id);
      if (found.has(id)) continue;
      const lg = t.legacy || {};
      // A count the payload does not carry stays null and is not written — never 0.
      const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      found.set(id, {
        views: n(t.views?.count),
        likes: n(lg.favorite_count), comments: n(lg.reply_count),
        reposts: n(lg.retweet_count), quotes: n(lg.quote_count),
        bookmarks: n(lg.bookmark_count),
      });
      fresh++;
    }
    pages++;
    const next = j?.cursor?.bottom || j?.cursor_bottom || null;
    // Stop when a page adds nothing new or the cursor stops moving — search paginates past the
    // end by repeating its last page, and without this the loop never terminates.
    if (!fresh || !next || next === cursor || pages > 400) break;
    cursor = next;
    await sleep(250);
  }
  return found;
}

// One row per publish in the window, from the published-drafts list. An article's tweet is on the
// draft only (x_article_published_url), so it is read once; a later run finds it by Draft ID.
async function publishedRows(socialSetId, days, postIdByDraft) {
  const drafts = await publishedDrafts(tf, socialSetId, { sinceMs: Date.now() - days * 864e5 });
  const rows = [];
  let articleReadsFailed = 0;
  for (const d of drafts) {
    let url = d.x_published_url || '', full = null;
    if (!url && d.x_post_enabled === false) {
      const knownId = postIdByDraft.get(String(d.id));
      if (knownId) url = `https://x.com/i/status/${knownId}`;
      else {
        try { full = await tf.getDraft(socialSetId, d.id); url = full?.x_article_published_url || ''; }
        catch { articleReadsFailed++; continue; }
      }
    }
    const id = statusIdOf(url);
    if (!id) continue;
    rows.push({ post_id: id, url: d.x_published_url || full?.x_article_published_url || url, draft_id: d.id, preview_text: d.preview || '', created_at: new Date(publishedAtOf(d)).toISOString(), full });
  }
  if (articleReadsFailed) console.warn(`  ! ${articleReadsFailed} article draft read(s) failed — those articles are not registered this run`);
  return rows;
}

let created = 0, refreshed = 0, formatted = 0, eligible = 0, failed = 0, xSeen = 0;
for (const brand of BRANDS) {
  // What the registry already knows about this brand, by Post ID. {Format} tells us whether the
  // one-per-post draft fetch has been spent; {Article Status} is read so a later sync can never
  // overwrite an operator's Skipped or the pipeline's Queued; {Draft ID} finds an article's tweet.
  const known = new Map(), postIdByDraft = new Map();
  for (const r of await at.listAll(TABLE, { formula: `{Account}="${brand.name}"`, fields: ['Post ID', 'Format', 'Article Status', 'Draft ID'] })) {
    if (r.fields['Post ID']) known.set(String(r.fields['Post ID']), r.fields);
    if (r.fields['Post ID'] && r.fields['Draft ID']) postIdByDraft.set(String(r.fields['Draft ID']), String(r.fields['Post ID']));
  }
  const rows = await publishedRows(brand.socialSetId, DAYS, postIdByDraft);
  console.log(`\n${brand.name}: ${rows.length} published post(s) in the last ${DAYS} days`);
  console.log(`  ${known.size} already in the registry`);

  // Only NEW rows are written here: their content fields are immutable, and Typefully's numbers
  // ({Impressions}, {Link Clicks}, …) have no source any more, so an existing row is left exactly
  // as it is and a new row leaves them blank. {Tweet Number} 1: every row from the list is a head.
  const upserts = [], needFormat = [];
  for (const p of rows) {
    const id = p.post_id;
    const prior = known.get(id);
    if (!prior) {
      upserts.push({
        'Post ID': id, Account: brand.name, 'Tweet Number': 1,
        'X URL': p.url || undefined, 'Posted At': p.created_at || undefined,
        'Preview Text': (p.preview_text || '').slice(0, 2000) || undefined,
        'Draft ID': p.draft_id || undefined,
      });
      created++;
    } else refreshed++;
    if (!prior?.Format && p.draft_id) needFormat.push({ id, post: p, status: prior?.['Article Status'] || null });
  }

  if (!DRY && upserts.length) await at.upsert(TABLE, 'Post ID', upserts);

  // Format costs one draft fetch and is immutable, so it is fetched once per post, ever. Rows that
  // already carry a Format are skipped; a post with no draft (made outside Typefully) never gets one.
  if (!NO_FORMAT && needFormat.length) {
    console.log(`  fetching format for ${needFormat.length} row(s)…`);
    const batch = [];
    for (const t of needFormat) {
      let f = null;
      try { f = formatOf(t.post.full || await tf.getDraft(brand.socialSetId, t.post.draft_id)); }
      catch { failed++; }
      if (f) {
        const fields = {
          'Post ID': t.id, Format: f.format, 'Thread Length': f.len, 'First Post Chars': f.chars,
          'Is QRT': f.qrt, 'Has Media': f.media, ...(f.quoted ? { 'Quoted URL': f.quoted } : {}),
        };
        batch.push(fields); formatted++;
      }
      if (!DRY && batch.length >= 10) await at.upsert(TABLE, 'Post ID', batch.splice(0, 10));
      await sleep(120);
    }
    if (!DRY && batch.length) await at.upsert(TABLE, 'Post ID', batch);
  }

  // ---- X pass: the numbers eligibility is judged on ----
  if (!NO_X) {
    const x = await xMetrics(brand.handle, DAYS);
    console.log(`  X returned ${x.size} post(s) for @${brand.handle}`);
    // Re-read Format and Article Status: Format was only just written for new rows, and Status
    // must be respected so a later run never overwrites a Skipped or a Queued.
    const state = new Map();
    for (const r of await at.listAll(TABLE, { formula: `{Account}="${brand.name}"`, fields: ['Post ID', 'Format', 'Article Status', 'Tweet Number'] })) {
      if (r.fields['Post ID']) state.set(String(r.fields['Post ID']), r.fields);
    }
    const xBatch = [];
    for (const [id, m] of x) {
      const st = state.get(id);
      if (!st) continue; // a post X knows about but Typefully never published — not ours to register
      const fields = { 'Post ID': id, 'X Checked At': new Date().toISOString() };
      for (const [k, v] of [['X Views', m.views], ['Likes', m.likes], ['Comments', m.comments], ['Reposts', m.reposts], ['Quotes', m.quotes], ['Bookmarks', m.bookmarks]]) if (v != null) fields[k] = v;
      const fmt = (st.Format && st.Format.name) || st.Format;
      // The LEAD only: a plug sitting under a viral body must never queue itself as an article.
      const lead = (st['Tweet Number'] ?? 1) === 1;
      if (!st['Article Status'] && lead && fmt === 'Long-form' && m.views != null && m.views >= BAR) {
        fields['Article Status'] = 'Eligible'; eligible++;
      }
      xBatch.push(fields); xSeen++;
    }
    if (!DRY) for (let i = 0; i < xBatch.length; i += 10) await at.upsert(TABLE, 'Post ID', xBatch.slice(i, i + 10));
  }
}

console.log(`\nRegistry: ${created} created, ${refreshed} already known, ${formatted} typed, ${xSeen} scored on X, ${eligible} newly Eligible for an article${failed ? `, ${failed} format fetch(es) failed` : ''}${DRY ? ' [DRY]' : ''}`);
