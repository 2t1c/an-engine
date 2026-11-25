// config.mjs — single source of truth for IDENTITY: Airtable table/record IDs, the canonical
// Telegram route list, and shared slot times. Pure constants (NO imports) so lib.mjs and every
// script can import it without cycles. Base IDs stay in .env (deployment config):
//   XDB_BASE_ID      -> swipe DB + Config row (creator threads, bot config)
//   REGISTRY_BASE_ID -> Published Content (our own posts)
//   CLIPS_BASE_ID    -> Clip Library (podcast pool + clips); defaults to CLIPS_BASE below, since a base
//                       id is not a secret and the clip scripts should run without a deploy step

// Airtable tables (IDs are stable; base is chosen per call via env).
export const CLIPS_BASE = 'appMjL85FdALm5jkw'; // Clip Library (clip-pool.mjs), created 2026-09-23

// The GTX & AI clip pool (operator 2026-10-09): the same three tables in their own base, so the health
// MATCH never ranks a business clip and the wider pool never crowds the health one. clip-lanes.mjs maps
// TABLES.podcasts/clips/swipeMedia onto these ids when a script runs with --lane gtx.
export const GTX_CLIPS_BASE = 'appbZwcOiJCxPpKlU'; // Clip Library · GTX & AI, created 2026-10-09
export const GTX_CLIP_TABLES = { podcasts: 'tblr8qtNtNLCU9zwd', clips: 'tble4vJzALOEd7YgY', swipeMedia: 'tblbeRGrtS69D1u5o' };

// GROWTH LOG has its own base since 2026-11-25 (owner: split it off; the Project Infinity base was
// 3k rows from its 50k cap and the Growth Log was 62% of it). No Post link any more: links can't cross
// bases, and every reader matches rows by {X URL}. Rows over 30 days are archived and trimmed weekly.
export const GROWTH = { base: 'appz62qtYq8vhvpKs', table: 'tblmKHJZhcsZZPCVk' };
export const growthBase = (env = {}) => env.GROWTH_BASE_ID || GROWTH.base;

export const TABLES = {
  podcasts: 'tblW4RfyRKWDkUDsc', // CLIPS_BASE — the podcast pool, transcript attached
  clips: 'tblYAE4QJkmEyXRQy', // CLIPS_BASE — clips Jev found, every score a field
  swipeMedia: 'tblgcFFYuA8Sw3yv2', // CLIPS_BASE — swipe-DB media we placed on drafts, and where
  swipe: 'tblS9wU39UjUVSsvl', // XDB_BASE_ID — creator swipe threads (source of recreations)
  swipeUsers: 'tblEbIfYqCpxf1yMu', // XDB_BASE_ID — tracked creators; {Cohort} marks the Direct Competitor pages
  config: 'tblqCg6MjfRTHz1SO', // XDB_BASE_ID — bot token, chat id, topic map
  // Viral health SINGLES pool (2026-08-31): separate from `swipe` by design — its ingest bar is
  // >=100K views OR >=1,500 likes from the Users.{Health Source} roster, well under the swipe
  // scout's 250K floor, so blending them would pollute every selection pool that reads `swipe`.
  // Lives in its OWN base ("Health Tweets Database", HEALTH_XDB_BASE_ID / appUkzz5Sq0vg3uiL) so
  // its Media attachments never eat the X Swipe Database's per-base storage cap — callers must
  // pass that base to airtable(env, base), not the XDB default. Fed by n8n "Health Tweets (241)"
  // + n8n-x-pipeline/harvest-health.mjs; tag-niche.mjs heals its Niche gap via --table healthTweets.
  healthTweets: 'tblmJicvT1m5F745U', // HEALTH_XDB_BASE_ID — viral health singles (100K views / 1.5K likes bar)
};
// Competitor Threads (XDB_BASE_ID): every Direct Competitor thread, head + body (competitor-bodies.mjs).
export const COMPETITOR_THREADS = 'tblP4xywLyi2PZx3b';
// One row per thread (2026-10-20, thread-fold.mjs): in these tables a head carries its body tweets in
// {Body JSON}/{Body Media}, and lib.mjs's airtable() expands them on every read.
export const FOLDED_TABLES = Object.freeze([TABLES.swipe, COMPETITOR_THREADS]);
export const CONFIG_RECORD = 'recuCRHIrlQng6OyQ'; // the single Config row in TABLES.config
export const REGISTRY_TABLE = 'Published Content'; // REGISTRY_BASE_ID — our published posts (by name)

// The title a collaborative /run gives a thread while the operator is still reviewing it. It lives
// here, in the no-import constants file, because THREE unrelated places must agree on it exactly:
// scripts/run-review-drafts.mjs writes it, publish-thread.mjs refuses to overwrite a draft that
// does not carry it, and archive-drafts.mjs treats it as reference material. Owner 2026-09-22:
// "every thread should only ever have one draft and it sits exactly on the accounts it is going to
// publish for" — so the review draft lives in the page's own set and BECOMES the published draft,
// which makes this prefix the only thing separating an unapproved thread from an ordinary one.
export const REVIEW_PREFIX = '[REVIEW]';

// Swipe-DB Niche aliases (operator 2026-09-23): Health, Fitness and Mental Health are ONE niche,
// `Health`, and swipe-reclassify.mjs moves the swipe rows there. ACCOUNT niches are deliberately left
// as they are (they drive the live accountFit tiers in scripts/cover-selection.mjs), so every place
// that builds a swipe {Niche} filter from an account's niches expands them through swipeNiches(): an
// account listing Fitness or Mental Health also sees Health rows. The retired labels stay in the list
// so rows not yet renamed (n8n still emits them) remain visible.
export const SWIPE_NICHE_ALIASES = Object.freeze({ Fitness: 'Health', 'Mental Health': 'Health' });
export function swipeNiches(niches = []) {
  const out = [];
  for (const n of niches || []) for (const v of [n, SWIPE_NICHE_ALIASES[n]]) if (v && !out.includes(v)) out.push(v);
  return out;
}

// Canonical Telegram topic routes — MUST match the Topics map in the Airtable Config row.
// lib.telegram() warns if a script sends to a route not listed here (catches silent drift).
export const TELEGRAM_ROUTES = ['weekly', 'harvest', 'revenue', 'calendar', 'retro', 'alerts', 'daily', 'performance', 'ops', 'qc', 'overview', 'brief', 'fuel', 'posted', 'books'];

// MESSAGE KIND -> TOPIC (Phase 7b, 2026-09-23). Values are existing route keys only (the Topics map
// owns the thread ids): 'alerts' is Needs You — a decision or repair the owner must make; 'ops' is the
// Machine Room — operational news, no action. Two kinds were in the wrong room: the Seed-Eligible
// "sacred event" (it waits on the owner's /seed-mint) went to ops, and swipe DRY ("no infra action
// needed") went to Needs You. Kinds not listed here keep the route their sender passes.
export const MESSAGE_TOPICS = {
  'farm-sacred': 'alerts',     // Seed-Eligible: the owner runs /seed-mint and picks the name
  'farm-verdicts': 'ops',      // verdict digest: informational
  'farm-expiry': 'ops',        // hearts-expiry warning (unchanged)
  'swipe-down': 'alerts',      // scraper DOWN: someone must repair n8n
  'swipe-dry': 'ops',          // scraper healthy, supply drought: no action required
};
export const topicFor = (kind, fallback = 'ops') => MESSAGE_TOPICS[kind] || fallback;

// Operator-confirmed Command Center forum links (2026-09-12). These are public routing metadata,
// not credentials. `posted` is the existing route key for the topic now named Today.
export const COMMAND_CENTER_CHAT_ID = '-1004393112008';
export const COMMAND_CENTER_TOPICS = { posted: 2614, fuel: 2050, alerts: 7, books: 3298 };

// MEDIA FEATURE SWITCH (operator 2026-07-21): media attachment is its own feature so the fleet can go
// text-only at ANY time with a one-line flip — text-only is good for retention and sidesteps
// similar-image-ID duplicate detection entirely. The guard lives INSIDE media.mjs (it exits as a no-op
// when false), so every caller — daily-winners, run-weekly, fix-scheduled-media, manual runs — honors
// it from this single line. OFF since 2026-09-23 (owner: "stop adding old media — tomorrow I'll have a
// new system for you. With Jev"): the mock run's publisher attached donor images to 5 of 9 threads
// that had no media mapped, two of them on the wrong topic. Flip back only with the new media system.
export const ATTACH_MEDIA = false;

// STATE DIGEST SWITCH (2026-07-26). Telegram is good at interrupting you and bad at holding state.
// Until the dashboard existed there was nowhere better, so the scheduled digests went to chat too —
// Daily Performance, Publishing Today, Daily Sales, Week-over-week. Each is now rendered better by a
// screen that can sort, filter and drill in, and every one that keeps arriving is a message you learn
// to swipe past. That habit is not selective: it is exactly why the fleet's real "draft backlog
// rotting" alarm sat unread for weeks in the same channel.
//
// So the default inverts: a scheduled job says NOTHING unless it needs a human. Interrupts still send
// — failures, dead CTAs, untracked posts, a stalled scraper, a QC veto — and the Morning Brief still
// carries the daily rollup, now built from the shared needs-you definition.
//
// Flip to `true` to restore all four. Each script is gated at its own send call rather than inside
// telegram(), so the blast radius is greppable: `grep -rn SEND_STATE_DIGESTS`.
export const SEND_STATE_DIGESTS = false;

// LINK SENTINEL AUTOFIX SWITCH (2026-07-27). The sentinel can FIX what it finds: re-mint a dead
// Levanta link and swap the URL inside the still-scheduled draft, or — when no clean fix exists —
// unschedule the draft so a dead CTA never publishes. Both are reversible, both alert loudly, and
// both are gated HERE so one line flips the whole system back to detect-and-alert-only. Detection
// itself is never gated: turning this off must never turn the alarm off.
export const LINK_SENTINEL_AUTOFIX = true;

// T0 DIRECT-SEND SWITCH (2026-09-03). Fire the T0 baseline RT ping at the seven member networks
// ourselves (t0-direct.mjs) instead of buying it from the broker as one indivisible $8.60 block.
//
// OFF, deliberately. The module is built, tested and ready so that flipping this line is the only
// code step left (operator: "have it ready, don't turn it on yet"). Two things must happen in the
// same change, in this order:
//   1. Set the "Vendor – Boosting GA Bridge (T0)" Config row INACTIVE, so the n8n RT Bridge stops
//      firing the bundle. t0-direct refuses to send while that row is Active — running both pays
//      $8.60 twice and posts the link into each of the seven groups twice.
//   2. Flip this to true.
// Revert is this line alone; the broker row going back to Active restores the old path exactly.
//
// It is NOT a saving. The broker's $8.60 is a pass-through of what three of the seven charge, so
// direct costs the same money. It buys per-vendor confirms, X verification, one Fuel Log line per
// network instead of one opaque bundle line — and the ability to drop a member that never delivers.
export const T0_DIRECT = false;
