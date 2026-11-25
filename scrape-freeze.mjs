// scrape-freeze.mjs — the safety net under per-tweet coverage, for EVERY fleet account.
//
// Typefully's per-tweet analytics (the include_replies pull in registry-sync) only exists while a
// post is inside PERTWEET_DAYS (21d). A post that misses its window — API outage, account hiccup,
// the pre-2026-08-17 era before the pull existed — has NO per-tweet curve, forever, and the
// retention / plug-funnel metrics built on that curve silently lose coverage. The 2026-08-17 audit
// found exactly this at scale: 18.4% coverage, backfilled to 87% by a one-off live read of X.
// This job is that backfill as a permanent nightly floor.
//
// WHAT IT DOES: for every published post belonging to a fleet account (derived from accounts.mjs —
// external accounts excluded, new accounts included automatically) that is PAST the Typefully
// boundary and still has no Tweet Views, scrape the live thread from X and write the same fields
// the engine computes, via the same pure functions (metrics.mjs plugFunnel/plugTweetIndices).
//
// WHAT IT REFUSES TO DO:
//   - Overwrite. Typefully data carries per-tweet CLICKS; a scrape only carries views. Writing
//     over a Typefully curve would destroy the richer sensor. Empty fields only.
//   - Compute True Plug CTR. No click data means blank, never a confident 0.
//   - Scrape inside the window (age <= BOUNDARY_DAYS). Typefully still owns those posts and may
//     deliver the click-bearing curve; scraping early would just be churn.
//   - Retry dead posts forever. A thread that returns no head tweet (deleted/suspended) is
//     retried MAX_ATTEMPTS times on separate nights, then parked in the state file.
//
// Validation basis: on the 135 posts where both sensors existed, live thread total vs stored
// Typefully Impressions agreed at a median ratio of 1.01x (2026-08-17).
//
//   node scrape-freeze.mjs           # live run (writes)
//   node scrape-freeze.mjs --dry     # scrape + report, no Airtable writes
//   node scrape-freeze.mjs --cap 40  # at most N posts this run (default 80)
//
// Env: RAPIDAPI_KEY (twitter241), AIRTABLE_PAT, REGISTRY_BASE_ID.
import { isThreadRow } from './monitoring-scope.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, logRun, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { plugFunnel, plugTweetIndices } from './metrics.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const CAP = Number(flag('cap', 80));           // nightly ceiling; steady state is a handful
const BOUNDARY_DAYS = 21;                      // mirrors registry-sync PERTWEET_DAYS — Typefully owns posts younger than this
const MAX_ATTEMPTS = 3;                        // separate-night retries before a dead thread is parked
const HOST = 'twitter241.p.rapidapi.com';
const STATE_FILE = join(HERE_DIR, 'queues', 'scrape-freeze-state.json');

export const tweetIdOf = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || '';
export const handleOf = (u) => (String(u || '').match(/(?:x|twitter)\.com\/([^/]+)\/status/i) || [])[1] || '';

// ---- pure: parse the twitter241 /tweet payload into the author's own thread ----------------------
// The head lives in a `tweet-<pid>` entry; the self-thread is the first `conversationthread-*`
// module whose items are ALL by the head's author (thread tweets are self-replies on X). Other
// conversation modules are strangers' replies and `tweetdetailrelatedtweets-*` is unrelated
// content — both excluded. Promoted entries are ads injected into the conversation.
export function parseThreadPayload(json, pid) {
  const ins = json?.data?.threaded_conversation_with_injections_v2?.instructions || [];
  const pick = (t) => ({
    id: t.rest_id,
    views: Number(t.views?.count ?? NaN),
    text: t.note_tweet?.note_tweet_results?.result?.text || t.legacy?.full_text || '',
    author: t.core?.user_results?.result?.core?.screen_name || null,
  });
  let head = null; const modules = [];
  for (const i of ins) for (const e of (i.entries || [])) {
    const id = String(e.entryId || '');
    if (id === `tweet-${pid}`) {
      const t = e.content?.itemContent?.tweet_results?.result;
      if (t?.rest_id) head = pick(t);
    } else if (id.startsWith('conversationthread-')) {
      const items = [];
      for (const it of (e.content?.items || [])) {
        if (String(it.entryId || '').includes('-promoted-')) continue;
        const t = it.item?.itemContent?.tweet_results?.result;
        if (t?.rest_id) items.push(pick(t));
      }
      if (items.length) modules.push(items);
    }
  }
  if (!head) return { error: 'no-head' };
  const self = modules.find((m) => m.every((t) => t.author === head.author)) || [];
  return { author: head.author, tweets: [head, ...self] };
}

// ---- pure: the registry rows this job is about ---------------------------------------------------
// THREADS ONLY. A standalone single and a native X Article (owner, R2026-10-03: articles are additive)
// have no self-thread: scraping one returns its head tweet alone, which freezeFields refuses as thin,
// so each article would spend three nights of reads before parking, and would count all along as a
// post without a curve, pulling the coverage figure down for a field it can never have.
export function freezeRows(records) {
  return records.filter((rec) => isThreadRow(rec)).map((rec) => ({ id: rec.id, xUrl: rec.fields['X URL'], tweetViews: rec.fields['Tweet Views'], postedDate: rec.fields['Posted Date'], account: rec.fields['Account'] }));
}

// ---- pure: which registry rows need a freeze -----------------------------------------------------
// rows: [{id, xUrl, tweetViews, postedDate}], fleetHandles: lowercased Set, attempts: {tweetId: n}.
export function freezeTargets(rows, fleetHandles, attempts, now = Date.now()) {
  const out = [];
  for (const r of rows) {
    const tid = tweetIdOf(r.xUrl);
    if (!tid) continue;                                       // not published
    if (r.tweetViews) continue;                               // Typefully (or a prior freeze) already owns it
    if (!fleetHandles.has(handleOf(r.xUrl).toLowerCase())) continue; // external / manual — not fleet content
    const ageDays = r.postedDate ? (now - new Date(r.postedDate).getTime()) / 864e5 : null;
    if (ageDays !== null && ageDays <= BOUNDARY_DAYS) continue; // inside the window: Typefully's post
    if ((attempts[tid] || 0) >= MAX_ATTEMPTS) continue;       // parked (deleted/suspended)
    out.push({ id: r.id, tid, ageDays });
  }
  // Oldest first: the further past the boundary, the longer the gap has existed and the more
  // settled the final numbers are.
  return out.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
}

// ---- pure: the field payload for one scraped thread ----------------------------------------------
// Same shape the registry-sync per-tweet path writes; True Plug CTR deliberately absent (no clicks).
export function freezeFields(tweets) {
  if (!tweets || tweets.length < 3) return null;              // a 1-2 tweet "thread" has no funnel to measure
  const views = tweets.map((t) => t.views);
  if (!views.every(Number.isFinite) || !(views[0] > 0)) return null;
  const series = tweets.map((t, i) => ({ i: i + 1, v: t.views, c: null, text: t.text || '' })); // c null: X scrapes carry no link clicks
  const plugIdx = plugTweetIndices(tweets.map((t) => t.text || ''));
  const f = plugFunnel(series, plugIdx);
  const fields = { 'Tweet Views': JSON.stringify(f.curve) };
  if (plugIdx.length) fields['Plug Tweets'] = plugIdx.join(',');
  if (f.plugExposure != null) fields['Plug Exposure %'] = f.plugExposure;
  if (f.postPlugDrop != null) fields['Post-Plug Drop %'] = f.postPlugDrop;
  if (f.readThrough != null) fields['Read-Through %'] = f.readThrough;
  return fields;
}

async function scrapeThread(env, pid, retries = 3) {
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await fetch(`https://${HOST}/tweet?pid=${pid}`, {
        headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': HOST },
      });
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 2500 * (a + 1))); continue; }
      if (!r.ok) { if (a === retries) return { error: `http-${r.status}` }; await new Promise((s) => setTimeout(s, 800 * (a + 1))); continue; }
      return parseThreadPayload(await r.json(), pid);
    } catch (e) { if (a === retries) return { error: e.message }; await new Promise((s) => setTimeout(s, 800 * (a + 1))); }
  }
  return { error: 'exhausted' };
}

async function listRegistry(env) {
  const base = env.REGISTRY_BASE_ID, h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const out = []; let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(REGISTRY_TABLE)}`);
    u.searchParams.set('pageSize', '100'); if (offset) u.searchParams.set('offset', offset);
    for (const f of ['Type', 'Post', 'X URL', 'Tweet Views', 'Posted Date', 'Account']) u.searchParams.append('fields[]', f);
    const r = await fetch(u, { headers: h });
    if (!r.ok) throw new Error(`registry read -> ${r.status}`);
    const j = await r.json();
    out.push(...freezeRows(j.records));
    offset = j.offset;
  } while (offset);
  return out;
}

// This was the repo's ONLY hand-rolled write retry — 5 attempts, linear backoff — and it was right
// to have one: a PATCH setting named fields on named records lands the same state whether it runs
// once or twice, so it is safe to repeat. That reasoning is now in lib's client as `idempotentWrite`,
// which is why folding this in keeps 5xx coverage instead of dropping to 429-only (2026-08-30).
const patchRows = (env, updates) => airtable(env, env.REGISTRY_BASE_ID).update(REGISTRY_TABLE, updates);

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'RAPIDAPI_KEY']);

  const fleetHandles = new Set(Object.values(ACCOUNTS).filter((a) => !a.external && a.handle).map((a) => a.handle.toLowerCase()));
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { attempts: {} };

  const rows = await listRegistry(env);
  const targets = freezeTargets(rows, fleetHandles, state.attempts);

  // Coverage per account BEFORE this run — the number this job exists to defend, and the
  // integrity sentinel's raw material.
  const cov = {};
  for (const r of rows) {
    if (!tweetIdOf(r.xUrl)) continue;
    if (!fleetHandles.has(handleOf(r.xUrl).toLowerCase())) continue;
    const a = r.account || '?';
    cov[a] = cov[a] || { posts: 0, withCurve: 0 };
    cov[a].posts++; if (r.tweetViews) cov[a].withCurve++;
  }
  const totals = Object.values(cov).reduce((s, c) => ({ posts: s.posts + c.posts, withCurve: s.withCurve + c.withCurve }), { posts: 0, withCurve: 0 });
  console.log(`fleet coverage before: ${totals.withCurve}/${totals.posts} (${(100 * totals.withCurve / Math.max(1, totals.posts)).toFixed(1)}%) · gaps eligible tonight: ${targets.length} (cap ${CAP})`);
  for (const [a, c] of Object.entries(cov).sort()) console.log(`  ${a.padEnd(16)} ${c.withCurve}/${c.posts}`);

  const batch = targets.slice(0, CAP);
  let frozen = 0, dead = 0, thin = 0, errors = 0;
  const updates = [];
  for (const t of batch) {
    const s = await scrapeThread(env, t.tid);
    if (s.error) {
      state.attempts[t.tid] = (state.attempts[t.tid] || 0) + 1;
      if (s.error === 'no-head') dead++; else errors++;
      continue;
    }
    const fields = freezeFields(s.tweets);
    if (!fields) { state.attempts[t.tid] = (state.attempts[t.tid] || 0) + 1; thin++; continue; }
    updates.push({ id: t.id, fields });
    frozen++;
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!DRY && updates.length) await patchRows(env, updates);
  if (!DRY) {
    mkdirSync(join(HERE_DIR, 'queues'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), attempts: state.attempts }, null, 1) + '\n');
  }

  const parked = Object.values(state.attempts).filter((n) => n >= MAX_ATTEMPTS).length;
  console.log(`${DRY ? '(dry) ' : ''}frozen ${frozen} · dead ${dead} · thin ${thin} · errors ${errors} · parked total ${parked} · remaining gaps ${Math.max(0, targets.length - frozen)}`);
  await logRun('scrape-freeze', {
    frozen, dead, thin, errors, parked,
    coverage: Number((100 * (totals.withCurve + (DRY ? 0 : frozen)) / Math.max(1, totals.posts)).toFixed(1)),
    eligible: targets.length, clean: errors === 0,
  });
}

// Import guard (same pattern as funnel-watch): the test scaffold imports the pure helpers above —
// importing this module must never fire a scrape or an Airtable write.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
