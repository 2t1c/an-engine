// competitor-backfill.mjs — capture EVERY post from the direct-competitor fleet, not just the ones
// the daily sampler happened to catch.
//
// WHY (operator, 2026-08-30): every competitor average we quote is computed over whatever n8n's
// "Track Users Timelines" scooped up that day — roughly 15 posts per creator per run, biased toward
// whatever was surfacing. That inflates their apparent per-thread reach, because a thread we notice
// is more likely to be one that travelled. Any comparison built on it flatters them, and the
// $6/post-versus-our-$22 efficiency question cannot be answered from a biased sample at all.
//
// This walks each tracked creator's FULL timeline with a cursor and writes the ones we do not have.
//
// A NOTE THAT CONTRADICTS AN OLDER ONE: reconcile-handles.mjs:12 records that
// `/user-tweets?user=<rest_id>` returns only ~6 posts "regardless of the count parameter". That is
// true WITHOUT a cursor. With cursor pagination the same endpoint walks the whole timeline —
// verified 2026-08-30 against @LevelUpPrime (28 heads over 2 pages, then exhausted, against a
// profile count of 35 including replies). The fetch-by-handle rule in reconcile-handles still
// stands for the DAILY sampler; this is a different job with a different access pattern.
//
//   node competitor-backfill.mjs --dry                 # plan only: who, how many pages, no writes
//   node competitor-backfill.mjs                       # backfill every Direct Competitor
//   node competitor-backfill.mjs --account LevelUpPrime
//   node competitor-backfill.mjs --max-pages 40        # deeper walk (default 12, ~300 posts each)
//   node competitor-backfill.mjs --cohort Adjacent --since 2026-06-04 --max-pages 400
//                                                      # a non-competitor, bounded by DATE not pages
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain } from './lib.mjs';
import { TBL } from './config.mjs';

const RAPID_HOST = 'twitter241.p.rapidapi.com';
const SWIPE_BASE = process.env.XDB_BASE_ID || '';
const USERS = TBL.swipeUsers;
const THREADS = TBL.swipe;        // the swipe file: winners only, threshold-filtered
const COMP = TBL.competitorThreads;           // Competitor Threads: the complete record, no threshold

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const MAX_PAGES = Number(arg('max-pages', 12));
const ONLY = arg('account', null);
// Which cohort to walk. The fleet we copy is "Direct Competitor"; "Adjacent" holds creators worth
// swiping for FORMAT rather than substance (josh_uglyasf, 2026-09-04: true crime, not health).
const COHORT = arg('cohort', 'Direct Competitor');
// VIEW FLOOR, and it is COHORT-DEPENDENT (operator 2026-09-04).
//   Direct Competitor -> NO floor. The whole point of that board is their true hit rate, and a
//     threshold would delete exactly the flops that make 76%-under-50k a real number.
//   Everything else   -> 500k, matching MIN_VIEWS in daily-winners. Those creators are DONOR
//     sources: we swipe their shape, so a post nobody read is not worth a row. A 3-month search of
//     six such accounts produced 2,185 rows of which 107 cleared the bar.
const MIN_VIEWS = Number(arg('min-views', COHORT === 'Direct Competitor' ? 0 : 500_000));
// Optional date floor, YYYY-MM-DD. A 74k-post account cannot be walked to exhaustion, so bound it
// by TIME instead of page count and say so in the readout.
const SINCE = arg('since', null);
const SINCE_MS = SINCE ? Date.parse(`${SINCE}T00:00:00Z`) : null;
if (SINCE && !Number.isFinite(SINCE_MS)) throw new Error(`--since expects YYYY-MM-DD, got "${SINCE}"`);

/** Split [since, until) into consecutive windows of `days`, oldest last (we search newest first).
 *  Search returns a bounded depth PER QUERY, so a three-month ask is served as many small windows
 *  rather than one big one. Pure. */
export function searchWindows(sinceIso, untilIso, days = 14) {
  const out = [];
  const start = Date.parse(`${sinceIso}T00:00:00Z`);
  let end = Date.parse(`${untilIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return out;
  const step = days * 864e5;
  while (end > start) {
    const from = Math.max(start, end - step);
    out.push({ since: new Date(from).toISOString().slice(0, 10), until: new Date(end).toISOString().slice(0, 10) });
    end = from;
  }
  return out;
}

/** True when this page carries nothing left to walk toward: every head we have NOT already seen in
 *  this walk predates the floor.
 *
 *  The `seen` set is load-bearing, not an optimisation. X repeats the PINNED tweet on every page,
 *  so a sparse page can contain that one old post and nothing else. Judging on all heads then reads
 *  "the whole page is below the floor" and stops the walk — measured 2026-09-04 on KarlApexFit,
 *  whose pin is dated 2026-05-20: page 44 held exactly one head (the pin), the walk halted, and it
 *  reported reaching the 4 June floor while actually stopping at 4 August. Two and a half months
 *  missing, announced as a success. Heads already seen contribute nothing to the decision. */
export const pageIsBelowFloor = (heads, sinceMs, seen = new Set()) => {
  if (!sinceMs) return false;
  const fresh = (heads || []).filter((h) => !seen.has(h.id));
  return fresh.length > 0 && fresh.every((h) => h.createdAt && Date.parse(h.createdAt) < sinceMs);
};

/** Every tweet object buried in a twitter241 timeline page, in entry order. Pure. */
export function tweetsFrom(page) {
  const out = [];
  const seen = new Set();
  // DEPTH 24, NOT 12 (2026-08-31). X serves two timeline shapes. The flat one nests a tweet at
  // depth ~11 (`content.itemContent.tweet_results.result.legacy`); the MODULE one adds three levels
  // (`content.items[0].item.itemContent...`) and lands at 14. A limit of 12 silently returned zero
  // tweets from a perfectly good 53KB payload, so five live competitors read as dead accounts.
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 24) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const leg = o.legacy;
    if (leg && typeof leg.full_text === 'string' && leg.id_str && !seen.has(leg.id_str)) {
      seen.add(leg.id_str);
      out.push({
        id: leg.id_str,
        text: leg.full_text,
        conversationId: leg.conversation_id_str || leg.id_str,
        createdAt: leg.created_at || null,
        likes: leg.favorite_count ?? 0,
        retweets: leg.retweet_count ?? 0,
        replies: leg.reply_count ?? 0,
        quotes: leg.quote_count ?? 0,
        bookmarks: leg.bookmark_count ?? 0,
        // views live OUTSIDE legacy, on the tweet result wrapper
        views: Number(o.views?.count ?? 0) || 0,
        // A retweet carries the original's text with an "RT @handle:" prefix and would double-count
        // someone else's numbers as this creator's.
        isRetweet: /^RT @/.test(leg.full_text),
        // A reply is not a thread head. conversation_id pointing elsewhere is the reliable tell;
        // in_reply_to_status_id_str catches self-threads that share a conversation id.
        isReply: !!leg.in_reply_to_status_id_str,
      });
    }
    for (const k of Object.keys(o)) if (k !== 'legacy') walk(o[k], depth + 1);
  };
  walk(page);
  return out;
}

/** The bottom cursor for the next page, or null when the walk is done. Pure. */
export function nextCursor(page) {
  const c = page?.cursor;
  const v = (typeof c === 'string' ? c : (c?.bottom ?? c?.next ?? null));
  if (typeof v === 'string' && v.length > 8) return v;
  const s = JSON.stringify(page || {});
  const m = s.match(/"cursorType":"Bottom","value":"([^"]+)"/) || s.match(/"value":"(DAAB[^"]+)"/);
  return m ? m[1] : null;
}

/** Thread HEADS only: this creator's own posts that start a conversation. Pure. */
export const headsOnly = (tweets) =>
  (tweets || []).filter((t) => !t.isRetweet && !t.isReply && t.conversationId === t.id);

const rapid = (env) => async (path) => {
  const r = await fetch(`https://${RAPID_HOST}${path}`, {
    headers: { 'x-rapidapi-host': RAPID_HOST, 'x-rapidapi-key': env.RAPIDAPI_KEY },
  });
  if (!r.ok) throw new Error(`twitter241 ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
};

// lib's airtable() is read-only (getRecord/list) and already bound to XDB_BASE_ID, which IS the
// swipe base. Creates go direct, in Airtable's 10-record batches.
const createRows = async (env, table, rows) => {
  for (let i = 0; i < rows.length; i += 10) {
    const r = await fetch(`https://api.airtable.com/v0/${SWIPE_BASE}/${table}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: rows.slice(i, i + 10), typecast: true }),
    });
    if (!r.ok) throw new Error(`airtable create ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
};

/** Airtable rows for a batch of heads. Shared by both walks so they cannot drift apart. */
const rowsFor = (heads, handle, restId, userRecId) => heads.map((t) => ({
  fields: {
    Text: t.text, TweetID: t.id,
    'Tweet URL': `https://x.com/${handle}/status/${t.id}`,
    Handle: handle, 'User RestID': restId, Source: 'backfill',
    Impressions: t.views, Likes: t.likes, Retweets: t.retweets,
    Comments: t.replies, Quotes: t.quotes, Bookmarks: t.bookmarks,
    ...(t.createdAt ? { 'Published Date': new Date(t.createdAt).toISOString() } : {}),
    User: [userRecId],
  },
}));

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'RAPIDAPI_KEY']);
  const at = airtable(env);
  const get = rapid(env);

  const users = (await at.list(USERS, {
    formula: `{Cohort}="${COHORT.replace(/"/g, '\\"')}"`,
    fields: ['Name', 'Handle', 'RestID', 'Followers', '# Threads'], pageSize: 100,
  })).filter((u) => u.fields.RestID && (!ONLY || String(u.fields.Handle || '').toLowerCase() === ONLY.toLowerCase()));

  if (!users.length) { console.log(ONLY ? `no tracked creator matches --account ${ONLY}` : `no ${COHORT} rows with a RestID`); return; }

  // Everything we already hold, so a re-run is cheap and additive rather than duplicating.
  // Folded threads (thread-fold.mjs) carry their body tweets in the head, so read those ids too.
  const held = await at.list(COMP, { fields: ['TweetID', 'Tweets'], pageSize: 100, max: 100000 });
  const known = new Set([...held, ...held.flatMap((r) => (r.fields.Tweets || []).map((id) => at.foldedRecord?.(id)).filter(Boolean))]
    .map((r) => String(r.fields.TweetID || '')).filter(Boolean));
  console.log(`${users.length} ${COHORT} creator(s) · ${known.size} threads already held · max ${MAX_PAGES} pages each${SINCE ? ` · since ${SINCE}` : ''}${MIN_VIEWS ? ` · >=${(MIN_VIEWS/1000)}k views` : ' · no view floor'}${DRY ? ' · DRY' : ''}\n`);

  let added = 0, scanned = 0;
  for (const u of users) {
    const { Handle: handle, RestID: restId, Name: name } = u.fields;
    const fresh = [];
    let cursor = null, pages = 0, seenHere = 0, hitFloor = false;
    const seenIds = new Set();   // ids this walk has already met — the pinned tweet recurs on every page

    // WITH A DATE FLOOR WE SEARCH, WE DO NOT PAGINATE (2026-09-04). `/user-tweets` exhausts at a
    // shallow timeline depth no page count can move: measured on KarlApexFit, 48 pages then the
    // cursor loops, 319 heads, nothing older than 4 August. `/search-v2` with `from:` plus
    // `since:`/`until:` reaches straight into any window — the same creator's 19 June to 5 July
    // returned 50 heads the timeline endpoint will not serve at all.
    if (SINCE_MS) {
      const today = new Date().toISOString().slice(0, 10);
      try {
        for (const w of searchWindows(SINCE, today, 14)) {
          let c = null;
          for (let i = 0; i < MAX_PAGES; i++) {
            // HEADS ONLY in the query (2026-11-02). Without the filters a page is ~90% self-replies
            // (a 14-tweet thread fills most of a 20-post page), so a page often carried no new head,
            // the `!gained` stop fired, and Better_men (52 heads in 15 days) read as 0.
            const q = `from:${handle} since:${w.since} until:${w.until} -filter:replies -filter:nativeretweets`;
            const page = await get(`/search-v2?type=Latest&count=20&query=${encodeURIComponent(q)}${c ? `&cursor=${encodeURIComponent(c)}` : ''}`);
            const heads = headsOnly(tweetsFrom(page));
            let gained = 0;
            for (const h of heads) {
              if (seenIds.has(h.id)) continue;
              seenIds.add(h.id); seenHere++; gained++;
              if (h.views < MIN_VIEWS) continue;
              if (!known.has(h.id)) { fresh.push(h); known.add(h.id); }
            }
            pages++;
            const nc = nextCursor(page);
            if (!tweetsFrom(page).length || !gained || !nc || nc === c) break;   // this window is spent
            c = nc;
          }
        }
        hitFloor = true;   // a search walk covers the window by construction
      } catch (e) { console.log(`  ✗ ${handle}: ${e.message}`); continue; }
      // SEARCH-HIDDEN creators (2026-11-02): _Gut_Laboratory, NutritionCorp and Fitby_Chandler return
      // nothing from `from:` search but post daily. A search that finds no head in the whole window
      // falls through to the timeline walk below, which does see them.
      if (seenHere === 0) console.log(`  ${String(handle || name).padEnd(20)} search found 0 heads, walking the timeline`);
    }
    if (SINCE_MS && seenHere > 0) {
      console.log(`  ${String(handle || name).padEnd(20)} ${String(pages).padStart(3)}q · ${String(seenHere).padStart(4)} heads · ${String(fresh.length).padStart(4)} NEW · searched back to ${SINCE}`);
      if (!DRY && fresh.length) await createRows(env, COMP, rowsFor(fresh, handle, restId, u.id));
      added += fresh.length;
      continue;
    }
    pages = 0;

    try {
      while (pages < MAX_PAGES) {
        const page = await get(`/user-tweets?user=${encodeURIComponent(restId)}&count=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        // Stop on an EMPTY page, never on a page with no heads. A creator who mostly replies and
        // retweets has reply-dominated pages, and `!heads.length` ended their walk on page 1 --
        // Human_Optimise, Dr_Biohacker and HeyDoc_MD each have ~22 heads reachable and we held 5.
        const all = tweetsFrom(page);
        const heads = headsOnly(all);
        seenHere += heads.length;
        // Decide the floor against what this walk had ALREADY seen, before this page's ids join it.
        const floorHit = pageIsBelowFloor(heads, SINCE_MS, seenIds);
        for (const h of heads) {
          seenIds.add(h.id);
          if (SINCE_MS && (!h.createdAt || Date.parse(h.createdAt) < SINCE_MS)) continue;
          if (h.views < MIN_VIEWS) continue;
          if (!known.has(h.id)) { fresh.push(h); known.add(h.id); }
        }
        const nc = nextCursor(page);
        pages++;
        if (floorHit) { hitFloor = true; break; }
        if (!nc || nc === cursor || !all.length) break;
        cursor = nc;
      }
    } catch (e) { console.log(`  ✗ ${handle}: ${e.message}`); continue; }
    scanned += seenHere;
    console.log(`  ${String(handle || name).padEnd(20)} ${String(pages).padStart(3)}p · ${String(seenHere).padStart(4)} heads seen · ${String(fresh.length).padStart(4)} NEW${hitFloor ? ` · reached ${SINCE}` : (SINCE && pages >= MAX_PAGES ? ' · STOPPED ON PAGE CAP, not the date' : '')}`);

    if (DRY || !fresh.length) { added += fresh.length; continue; }
    await createRows(env, COMP, rowsFor(fresh, handle, restId, u.id));
    added += fresh.length;
  }
  console.log(`\n${DRY ? '[dry] would add' : 'added'} ${added} thread(s) · ${scanned} heads scanned`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'competitor-backfill');
