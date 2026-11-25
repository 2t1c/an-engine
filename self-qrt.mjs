// self-qrt.mjs — every fresh thread quote-retweets the account's OWN best recent post
// (operator idea 2026-08-10, spec: SELF-QRT-PLAN.md; selection modeled on the operator's reference
// system, adapted: Typefully analytics is the ONLY candidate source + ranking signal).
//
// Placement is TWO-fold (operator): the winner's URL rides (1) the FIRST tweet — the whole thread
// publishes as a QRT of the winner — and (2) an echo tweet after the closer, before the disclaimer
// ("If you loved this thread, you will love this one…"). A tweet whose text ends with a status URL
// renders as a quote card on X; Typefully publishes those normally (replies 403, quotes do not).
//
// Selection (per account, OWN posts only — never cross-account):
//   - Candidates: the account's published drafts (x-views.mjs publishedDrafts), last
//     SELF_QRT_WINDOW_DAYS (14). Views are X's own count (twitter241, x-views.mjs xViews).
//     Until 2026-09-30 both came from Typefully /analytics/x/posts, which now answers 404. A
//     candidate whose views could not be read is never treated as 0 views, and a run where NO view
//     could be read throws instead of shipping standalone.
//   - HARD floor: impressions >= SELF_QRT_MIN_VIEWS (200k, operator 2026-08-10). No qualifying
//     winner -> ship standalone (young pages). Deliberate deviation from the reference's
//     "preference, not veto": quoting a weak post adds nothing on a health page.
//   - MAX AGE 24h (operator 2026-08-14): the quoted post must still have momentum when our thread
//     lands a few hours later. Nothing fresh enough -> NO quote card (blank), never a stale one.
//   - Rotation: skip anything this account QRT'd within SELF_QRT_REUSE_DAYS (7) — the ledger's
//     `selfQrtOf` lines are the memory (same pattern as every other engine).
//   - Score (reference weights): 0.5 log-normalized views + 0.3 word-overlap relevance to the new
//     thread + 0.2 linear recency. Log stops one runaway banger dominating; overlap implements
//     "if there's a connection, even better".
// KILL SWITCH — OFF BY DEFAULT (operator 2026-09-04: "turn off self QRT for now, make sure it's off").
//
// This comment used to read "SELF_QRT='' disables the lane (daily-winners checks it)". That stopped
// being true at the 2026-08-14 single-writer consolidation: daily-winners no longer attaches
// anything, self-qrt-topup.mjs does, and it never read the variable. So the documented kill switch
// did not exist in the live path — the workflow's crons were commented out on 2026-09-03, which
// stops the schedule, but `workflow_dispatch` was still one click from attaching cards to live
// drafts. A switch that is only a comment is worse than no switch, because everyone believes it.
//
// Now it is real, and it defaults to OFF: the lane runs only when SELF_QRT is set to something
// non-empty. Gated at the two WRITERS rather than inside pickSelfQrt, so the selection logic below
// stays a pure function of its inputs and its existing tests keep passing.
//
// Re-enabling deliberately takes TWO edits — uncomment the crons in the workflow AND set SELF_QRT=1.
// Either alone still ships nothing.
//
// The switch stops NEW cards. It does not touch the ones already attached to drafts that were
// scheduled while the lane ran — `self-qrt-strip.mjs` is what takes those back off.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR, loadEnv } from './lib.mjs';
import { publishedDrafts, publishedAtOf, xViews as xViewsSource } from './x-views.mjs';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** Is the self-QRT lane on? Only when SELF_QRT is set to something non-empty; unset, empty and
 *  whitespace all mean OFF, which is the default. Reads the LOADED env (.env merged over
 *  process.env) rather than process.env alone, because recreate.mjs reads its flags before it ever
 *  calls loadEnv() — a switch that only half-works is the thing this replaces. Read per call so a
 *  test, or a deliberate one-off re-enable, can flip it without reloading the module. */
export const selfQrtEnabled = (env = null) => !!String((env || loadEnv())?.SELF_QRT ?? '').trim();
export const SELF_QRT_MIN_VIEWS = num(process.env.SELF_QRT_MIN_VIEWS, 200_000);
const WINDOW_DAYS = num(process.env.SELF_QRT_WINDOW_DAYS, 14);
const REUSE_DAYS = num(process.env.SELF_QRT_REUSE_DAYS, 7);
// 24-HOUR MOMENTUM RULE (operator 2026-08-14). The quoted post must still be climbing when our new
// thread publishes a few hours later — quoting a 5-day-old winner sends readers to something already
// past its peak, and X drops it from For You at 48h anyway (AgeFilter, X-ALGORITHM-NOTES.md §1c).
// If nothing qualifies we ship BLANK. That is a deliberate reversal of the old NEVER-EMPTY fallback,
// which re-picked the single highest-scoring winner whenever every candidate sat inside the reuse
// window — and since scoring is deterministic it picked the SAME post every time. Measured
// 2026-08-14 over 14d: Julian 1 donor across 6 QRTs, Tina 1/4, Lorenzo 1/4, Jasper 1/3, Rafael 2/4.
// A blank quote is strictly better than quoting the same post six times.
export const SELF_QRT_MAX_AGE_HOURS = num(process.env.SELF_QRT_MAX_AGE_HOURS, 24);

const STOP = new Set('the,a,an,of,to,in,on,for,and,or,is,are,was,be,you,your,it,this,that,with,at,as,by,how,why,what,when,i,my,we,our,after,every,here,not,no,do,does,did'.split(','));
export const sigWords = (t = '') => new Set(String(t).toLowerCase().replace(/https?:\/\/\S+/g, '').match(/[a-z][a-z+\-']{2,}/g)?.filter((w) => !STOP.has(w)) || []);
export function wordOverlap(a, b) { const A = sigWords(a), B = sigWords(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n; }

// HEAD-TWEET ONLY (operator 2026-08-11: "make sure the tweet we QRT is a HOOK — never a tweet
// inside a thread"). A quote card renders ONE tweet, so quoting tweet #7 shows a headless fragment
// with no hook. Typefully's analytics feed returns one row per TWEET, not per thread (Magnus: 291
// rows across 20 drafts), and on a viral thread the mid-thread rows clear the 200k floor on their
// own — a live candidate was "It's dangerous because most varieties contain 1,500 to 2,000" at
// 423k views. X status ids are time-ordered, so within a draft the SMALLEST id is the head; verified
// on every sampled draft (the head also held max impressions in each).
export const statusIdOf = (url = '') => (String(url).match(/status\/(\d+)/) || [])[1] || '';
const statusHandleOf = (url = '') => (String(url).match(/x\.com\/([^/]+)\/status/) || [])[1] || null;
const idLt = (a, b) => (a.length === b.length ? a < b : a.length < b.length); // numeric compare without BigInt
// Backstop for the one case the id rule can't see: if a thread's real head was deleted, tweet #2
// becomes the min id — these shapes are never a hook.
const CONTINUATION_RE = /^(\d{1,3}[.)]\s|DISCLAIMER\b|Repost the first tweet|Aff link)/i;
export function headTweetsOnly(cands) {
  const minId = new Map();
  for (const c of cands) {
    const d = String(c.draftId || ''), id = statusIdOf(c.url);
    if (!d || !id) continue;
    const cur = minId.get(d);
    if (cur === undefined || idLt(id, cur)) minId.set(d, id);
  }
  return cands.filter((c) => {
    const d = String(c.draftId || ''), id = statusIdOf(c.url);
    if (!d || !id) return false;            // ungrouped row: can't prove it's a head -> never quote it
    if (id !== minId.get(d)) return false;  // a tweet from inside the thread
    return !CONTINUATION_RE.test(String(c.preview || '').trim());
  });
}

/** Pure ranking term (tested): 0.5 log-views + 0.3 relevance + 0.2 recency, each normalized 0-1 vs pool best. */
export function scoreSelfQrt({ views, bestViews, overlap, bestOverlap, ageDays, windowDays = WINDOW_DAYS }) {
  const v = bestViews > 1 ? Math.log(Math.max(views, 1)) / Math.log(bestViews) : 0;
  const r = bestOverlap > 0 ? overlap / bestOverlap : 0;
  const rec = Math.max(0, 1 - ageDays / windowDays);
  return 0.5 * v + 0.3 * r + 0.2 * rec;
}

// Ledger memory: URLs this account self-QRT'd within the reuse window.
export function recentSelfQrts(accountName, { days = REUSE_DAYS, now = Date.now(), lines } = {}) {
  const used = new Set();
  try {
    const src = lines ?? (existsSync(join(HERE_DIR, 'ledger.jsonl')) ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean) : []);
    const cutoff = now - days * 864e5;
    for (const line of src) {
      try { const e = typeof line === 'string' ? JSON.parse(line) : line; if (e.account === accountName && e.selfQrtOf && e.ts && Date.parse(e.ts) >= cutoff) used.add(e.selfQrtOf); } catch {}
    }
  } catch {}
  return used;
}

/** Pick the account's best own winner from the last SELF_QRT_MAX_AGE_HOURS (24h) to quote, or null.
 *  BLANK-IS-FINE (operator 2026-08-14, replacing the 2026-08-10 NEVER-EMPTY rule): a thread with no
 *  fresh qualifying winner ships with NO quote card. The old rule guaranteed a quote by falling back
 *  to the best already-used winner, which — because scoring is deterministic — meant re-quoting one
 *  post indefinitely (Julian: 6 QRTs, 1 donor). Expect fewer QRTs overall; that is the intent.
 *  `avoid` = same-run in-memory dedup (two parallel slots picked the same winner before either's
 *  ledger line existed); `ledgerLines` injectable for tests. */
export async function pickSelfQrt(env, tfClient, account, { newText = '', excludeDraftId = null, now = Date.now(), avoid = null, ledgerLines = null, publishAt = null, xViews = null } = {}) {
  // The 24h cap is measured at PUBLISH time, not pick time. A quote chosen at 2pm Saigon for a 6am
  // slot publishes 16h later, so picking on "age now" would ship a donor 40h old. `publishAt` (the
  // draft's scheduled_date) is what the reader actually experiences; falls back to `now` for callers
  // with no scheduled time.
  const ageRef = publishAt ? new Date(publishAt).getTime() : now;
  const sinceMs = now - WINDOW_DAYS * 864e5;
  // One item per publish, its head tweet in x_published_url — so every candidate is already a hook.
  const drafts = await publishedDrafts(tfClient, account.socialSetId, { sinceMs, untilMs: now + 1 });
  const rows = drafts.map((d) => ({ url: d.x_published_url || '', preview: d.preview || '', draftId: String(d.id || ''), at: publishedAtOf(d) }))
    .filter((r) => /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(r.url) // malformed URL fails the whole draft — hard filter
      && (ageRef - r.at) / 36e5 <= SELF_QRT_MAX_AGE_HOURS                    // 24h momentum rule, before spending a views read
      && !(avoid && avoid.has(r.url)) && (!excludeDraftId || r.draftId !== String(excludeDraftId)));
  let read = { views: new Map(), missing: [] };
  if (rows.length) {
    const src = xViews || xViewsSource(env || {});
    read = await src.lookup(rows.map((r) => statusIdOf(r.url)), { handle: account.handle || statusHandleOf(rows[0].url), sinceMs: Math.min(...rows.map((r) => r.at)) - 36e5 });
    if (!read.views.size) throw new Error(`self-QRT ${account.name}: no X view count could be read for ${rows.length} candidate(s) — views unknown, not below the floor`);
    if (read.missing.length) console.warn(`self-QRT ${account.name}: ${read.missing.length} candidate(s) skipped, X views unread (unknown, not 0)`);
  }
  const posts = rows.filter((r) => read.views.has(statusIdOf(r.url)))
    .map((r) => ({ url: r.url, preview_text: r.preview, draft_id: r.draftId, created_at: new Date(r.at).toISOString(), metrics: { impressions: read.views.get(statusIdOf(r.url)).views } }));
  const used = recentSelfQrts(account.name, { now, ...(ledgerLines ? { lines: ledgerLines } : {}) });
  const base = headTweetsOnly(posts
    .map((p) => ({ url: p.url, preview: p.preview_text || '', draftId: String(p.draft_id || ''), views: p.metrics?.impressions || 0,
      ageDays: Math.max(0, (now - Date.parse(p.created_at || 0)) / 864e5),                 // age NOW (scoring/recency + logs)
      ageAtPublishH: Math.max(0, (ageRef - Date.parse(p.created_at || 0)) / 36e5) })))     // age when the reader sees it (the 24h gate)
    .filter((c) => /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(String(c.url || '')) // malformed URL fails the whole draft — hard filter
      && c.views >= SELF_QRT_MIN_VIEWS && !(avoid && avoid.has(c.url)) && (!excludeDraftId || c.draftId !== String(excludeDraftId))
      && c.ageAtPublishH <= SELF_QRT_MAX_AGE_HOURS); // 24h momentum rule, measured at PUBLISH time
  // Reuse window still applies, and there is NO never-empty fallback: nothing fresh and unused ->
  // return null and the thread ships with no quote card. Blank beats quoting the same post twice.
  const cands = base.filter((c) => !used.has(c.url));
  if (!cands.length) return null;
  const bestViews = Math.max(...cands.map((c) => c.views));
  const overlaps = cands.map((c) => wordOverlap(newText, c.preview));
  const bestOverlap = Math.max(...overlaps, 0);
  let best = null, bestScore = -1;
  cands.forEach((c, i) => {
    const s = scoreSelfQrt({ views: c.views, bestViews, overlap: overlaps[i], bestOverlap, ageDays: c.ageDays });
    if (s > bestScore) { bestScore = s; best = { ...c, overlap: overlaps[i], score: s }; }
  });
  return best;
}

// Human phrase for the echo copy's "[key topics]" — from the winner's own preview text.
export function topicPhrase(preview = '') {
  const words = [...sigWords(preview)].slice(0, 3);
  return words.length ? words.slice(0, 2).join(' and ') : 'this';
}

/** Pure insertion (tested) — NATIVE QRT (operator 2026-08-10): Typefully's per-post
 *  `quote_post_url` field renders a real quote card, so tweet TEXT never carries the URL —
 *  tweet 1 stays byte-identical to what the hook rules produced (no "Convert to quote" prompt,
 *  no length pressure), and the echo tweet ships as pure copy. The posts builder attaches
 *  quote_post_url to tweet 1 and to the echo (matched by ECHO_PREFIX, index-drift-proof). */
export const SELF_QRT_ECHO_PREFIX = 'If you loved this thread';
export function selfQrtInsert(tweets, { topics = 'this', disclaimer = null }) {
  const out = [...tweets];
  const echo = `${SELF_QRT_ECHO_PREFIX}, you will love this one where we go deeper on ${topics}:`;
  const di = disclaimer ? out.lastIndexOf(disclaimer) : -1;
  if (di >= 0) out.splice(di, 0, echo); else out.push(echo);
  return { tweets: out, placed: ['tweet1', 'echo'] };
}
/** Which posts of a final tweet array carry the quote card: tweet 1 + the echo (matched by prefix,
 *  so later pipeline mutations that shift indexes can never misplace the quote). */
export const selfQrtQuotesHere = (t, i) => i === 0 || String(t).startsWith(SELF_QRT_ECHO_PREFIX);
