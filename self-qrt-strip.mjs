// self-qrt-strip.mjs — the exact inverse of self-qrt-topup.mjs: take the self-QRT back OFF every
// scheduled draft that carries one (operator 2026-08-31, "turn off and remove the self QRTs from any
// drafts we got scheduled — we need to fix the self rt mechanism").
//
//   node self-qrt-strip.mjs --dry                  # report only, touches nothing
//   node self-qrt-strip.mjs                        # strip + log what was removed
//   node self-qrt-strip.mjs --account julian       # one account
//   node self-qrt-strip.mjs --include-unscheduled  # also drafts with no scheduled date
//   node self-qrt-strip.mjs --all-accounts         # ignore the plug-heavy default (see below)
//
// SCOPE = THE LANE'S OWN FOOTPRINT. By default this sweeps exactly the accounts self-qrt-topup could
// ever have written to — the ones with a plugHeavyExample — because it is that job's inverse and
// should undo its output, not everyone's. That default also holds the line SELF-QRT-PLAN.md draws
// around AI Evolution ("client rules own its QRT convention"): its [HailMary] drafts each carry one
// self-quote card by the client's own convention, and the operator confirmed 2026-08-31 that they are
// not ours to remove. --all-accounts sweeps the whole fleet for the day that changes.
//
// Removing a quote card is three edits, and doing only the first two is how the draft and its note
// end up disagreeing (the failure self-qrt-topup's single-writer rewrite already had to fix once):
//   1. drop `quote_post_url` from every post — X, and every enabled cross-post platform;
//   2. drop the echo tweet ("If you loved this thread, …") that only exists to carry the second card;
//   3. drop the scratchpad line that claims a QRT, in BOTH shapes we have ever written —
//      `SELF-QRT: <url> (…)` (self-qrt-topup) and `QRT (quotes our prior post): <url>` (the
//      AI Evolution HailMary drafts, whose whole quote convention is one card on a single post).
//
// ONLY SELF-quotes are stripped. A quote card pointing at somebody ELSE's post is a deliberate
// editorial choice by whoever built that draft, not this lane's output, so it is left alone and
// reported. That check is on the handle in the quoted URL vs the account's own handle — the same
// thing that makes a self-QRT "self".
//
// The removed URL is never thrown away: every strip appends a ledger line carrying `selfQrtRemoved`,
// so re-attaching by hand later is a lookup rather than an archaeology dig. Those lines deliberately
// do NOT carry `selfQrtOf` — that key is the rotation memory (recentSelfQrts), and a removal must not
// read as "we already quoted this one" and lock the donor out of the next 7 days.
import { buildPlatforms, CROSS_POST_PLATFORMS } from './platforms.mjs';
import { loadEnv, requireEnv, typefully, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SELF_QRT_ECHO_PREFIX, statusIdOf } from './self-qrt.mjs';

/** The handle a quoted x.com URL points at, lowercased ('' when the URL is not a status URL). */
export const quotedHandle = (url = '') => (String(url).match(/^https?:\/\/(?:www\.)?x\.com\/([^/]+)\/status\/\d+/i) || [])[1]?.toLowerCase() || '';
/** Is this quote card the account quoting ITSELF? That is what makes it a self-QRT, and it is the
 *  only kind this tool removes. */
export const isSelfQuote = (url, handle) => !!url && !!handle && quotedHandle(url) === String(handle).toLowerCase() && !!statusIdOf(url);

/** Pure (tested): strip the self-QRT out of one platform's post array.
 *  Returns the new posts plus what came off, so the caller can log and ledger it.
 *  `handle` = the account's own handle; quotes of anyone else are left in place and reported
 *  separately in `foreign`. Every other field on a post (media_ids, made_with_ai, …) is carried
 *  through untouched — this removes a key, it does not rebuild the post. */
export function stripSelfQrtPosts(posts, handle) {
  const removed = [], foreign = [];
  let echoes = 0;
  const out = [];
  for (const p of posts || []) {
    const q = p?.quote_post_url;
    // A quote of someone else is checked FIRST, before the echo rule, so that "never silently delete
    // another account's quote" holds even for a post that also looks like our echo copy.
    if (q && !isSelfQuote(q, handle)) { foreign.push(q); out.push({ ...p }); continue; }
    // The echo tweet exists ONLY to carry the second quote card. Once the card is gone it is a
    // dangling "you will love this one:" with nothing after the colon, so it goes with the card —
    // and its card still counts as removed, or the log undercounts the cards that actually came off.
    if (String(p?.text || '').startsWith(SELF_QRT_ECHO_PREFIX)) { if (q) removed.push(q); echoes++; continue; }
    if (q) { removed.push(q); const { quote_post_url, ...rest } = p; out.push(rest); continue; }
    out.push({ ...p });
  }
  return { posts: out, removed, foreign, echoes };
}

/** Pure (tested): drop every line that claims this draft carries a QRT, in both shapes we write.
 *  Blank runs left behind by the removal are collapsed so the scratchpad does not grow a hole. */
export function stripSelfQrtNote(text = '') {
  const kept = String(text || '').split('\n').filter((l) => !/^\s*(?:SELF-QRT\b|QRT \(quotes our prior post\))/i.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Pure (tested): does this draft carry anything for us to remove? Cheap pre-filter so a sweep only
 *  PATCHes drafts it actually changes — a no-op patch still bumps updated_at and burns a write. */
export function draftCarriesSelfQrt(full, handle) {
  const plats = ['x', ...CROSS_POST_PLATFORMS];
  for (const key of plats) {
    const posts = full?.platforms?.[key]?.posts || [];
    const r = stripSelfQrtPosts(posts, handle);
    if (r.removed.length || r.echoes) return true;
  }
  return stripSelfQrtNote(full?.scratchpad_text || '') !== String(full?.scratchpad_text || '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

async function main() {
  const DRY = process.argv.includes('--dry');
  const ALL_ACCOUNTS = process.argv.includes('--all-accounts');
  // Unscheduled drafts are OFF by default: the operator's ask was about what is going out. But a card
  // sitting on an unscheduled draft still ships the moment somebody schedules it, so the sweep can
  // reach them on request (Magnus 10269469 was carrying exactly that on 2026-08-31).
  const INCLUDE_UNSCHEDULED = process.argv.includes('--include-unscheduled');
  // indexOf returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] — the node binary — which
  // is truthy and matches no account, silently filtering the whole fleet out of the sweep.
  const ai = process.argv.indexOf('--account');
  const only = (ai > -1 ? process.argv[ai + 1] || '' : '').toLowerCase();
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const now = Date.now();
  let stripped = 0, scanned = 0, foreignKept = 0;
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    if (!acc.socialSetId) continue;
    if (only && key.toLowerCase() !== only && acc.name.toLowerCase() !== only) continue;
    if (!ALL_ACCOUNTS && !only && !acc.plugHeavyExample) continue; // the lane's own footprint — see SCOPE above
    let off = 0, all = [];
    while (true) {
      const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?limit=50&offset=${off}`);
      all.push(...(j.results || []));
      if (!j.next || !(j.results || []).length) break;
      off += j.results.length;
    }
    // FUTURE SCHEDULED ONLY. A published draft is already on X — editing it here changes nothing on
    // the timeline and only desyncs our copy from what actually shipped. No title filter either:
    // [Evergreen] and [HOLD] are skipped when ATTACHING a quote, but if one somehow carries a self-
    // QRT the operator asked for it gone, so removal sweeps wider than attachment ever did.
    const sched = all.filter((d) => {
      if (d.published_at) return false; // already on X: editing here only desyncs our copy from what shipped
      const isScheduled = d.scheduled_date && new Date(d.scheduled_date).getTime() >= now && String(d.status).toLowerCase() === 'scheduled';
      return isScheduled || (INCLUDE_UNSCHEDULED && !d.scheduled_date);
    });
    for (const d of sched) {
      scanned++;
      const full = await tf.getDraft(acc.socialSetId, d.id);
      if (!draftCarriesSelfQrt(full, acc.handle)) continue;
      // Strip X and every cross-post platform. buildPlatforms carries a draft's existing cross-post
      // posts forward verbatim on an edit, so a platform we did not hand it would keep its card.
      const xr = stripSelfQrtPosts(full.platforms?.x?.posts || [], acc.handle);
      const platformPosts = {};
      const allRemoved = [...xr.removed];
      for (const p of CROSS_POST_PLATFORMS) {
        if (!full.platforms?.[p]?.enabled) continue;
        const r = stripSelfQrtPosts(full.platforms[p].posts || [], acc.handle);
        platformPosts[p] = r.posts;
        allRemoved.push(...r.removed);
      }
      if (xr.foreign.length) foreignKept += xr.foreign.length;
      const sp = stripSelfQrtNote(full.scratchpad_text || '');
      const when = d.scheduled_date ? String(d.scheduled_date).slice(5, 16) : 'unscheduled';
      console.log(`${DRY ? '[dry] ' : ''}✓ ${acc.name} ${d.id} (${when}): -${allRemoved.length} quote card(s)${xr.echoes ? ` · -${xr.echoes} echo tweet(s)` : ''}${sp !== String(full.scratchpad_text || '') ? ' · note cleaned' : ''}${xr.foreign.length ? ` · KEPT ${xr.foreign.length} non-self quote(s)` : ''}  ${[...new Set(allRemoved)].join(' ') || ''}`);
      if (DRY) { stripped++; continue; }
      await tf.patchDraft(acc.socialSetId, d.id, {
        platforms: buildPlatforms(xr.posts, { existing: full?.platforms, platformPosts }),
        scratchpad_text: sp,
      });
      // Provenance, not rotation memory: `selfQrtRemoved` (never `selfQrtOf`) so the reuse window
      // cannot mistake a removal for a fresh quote.
      appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account: acc.name, recId: `qrt-strip-${d.id}`, draftId: String(d.id), mode: 'self-qrt-strip', selfQrtRemoved: [...new Set(allRemoved)], echoesRemoved: xr.echoes }) + '\n');
      stripped++;
    }
  }
  console.log(`\nstrip done: ${stripped} draft(s) ${DRY ? 'would be ' : ''}cleared of self-QRTs · ${scanned} draft(s) scanned (${ALL_ACCOUNTS || only ? 'all accounts' : 'plug-heavy accounts'}, ${INCLUDE_UNSCHEDULED ? 'scheduled + unscheduled' : 'scheduled only'})${foreignKept ? ` · ${foreignKept} quote(s) of OTHER accounts left in place` : ''}`);
}

// Script-only, same guard as self-qrt-topup: importing this module for its pure helpers must never
// fire a live sweep across every account's drafts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
