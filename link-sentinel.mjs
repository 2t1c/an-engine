#!/usr/bin/env node
// link-sentinel.mjs — the link safety net that can also ACT.
//
// The fear this answers: a tracked CTA link dies silently and money leaks with no alarm. The
// existing guards each cover a slice — the n8n Dead CTA Guard checks SCHEDULED drafts once a day
// and alerts; product-health marks unavailable products weekly; the Levanta webhook remediation
// fires only for Levanta-side deactivation. What none of them do:
//
//   - check LIVE posts. Every guard runs pre-publication, so a Winner earning for weeks whose
//     link dies on day 3 is invisible until revenue quietly sags.
//   - FIX anything. A 15:30 alert about a draft publishing at 21:00 works only when a human is
//     awake between those times.
//   - watch the money itself. A link can resolve perfectly while attribution is broken — clicks
//     arriving, revenue zero — and no HTTP check can see that.
//
// Three layers, one script:
//   1) SCHEDULED drafts (next 7d): dead link -> re-mint the same product on the same subid and
//      swap the URL inside the draft (schedule intact). No clean fix -> UNSCHEDULE + retitle so
//      fill-queue cannot put the dead link back on the calendar. Both gated by LINK_SENTINEL_AUTOFIX.
//      A native X Article's body (x_article.content_markdown) is read like a thread's posts.
//   2) LIVE posts (last 45d + anything already flagged): dead link -> `Link Dead` + `Link Note` on
//      the registry row (the dashboard raises it as critical), ranked by clicks-at-risk. A live
//      tweet cannot be edited, so surfacing fast IS the fix. Recovery clears the flag.
//      Every row it probes (and every scheduled draft with a registry row) also gets its RECEIPT
//      (operator 2026-09-02): `Links Verified` ticked when every tracked link resolved, cleared
//      when one failed, `Links Checked At` saying when — re-stamped on a flip or once a day.
//   3) MONEY canary: yesterday's fleet clicks with ZERO commission -> attribution alarm, the
//      failure class every link-level check is structurally blind to.
//
// Every dead verdict is DOUBLE-CHECKED (two failures ~20s apart) before anything acts or alerts:
// an unattended job that unschedules drafts off one flaky Amazon anti-bot response would be worse
// than no job at all.
//
//   node link-sentinel.mjs           # check + fix + alert + registry writes
//   node link-sentinel.mjs --dry     # full report to console; touches no DRAFT and no Typefully
//                                    state. Two writes still happen and are meant to: the logs/
//                                    run-metrics file and the Ops Log canary row, both of which
//                                    exist to prove the run HAPPENED. It used to claim "zero
//                                    writes anywhere", which is the kind of promise someone
//                                    eventually relies on.
//   node link-sentinel.mjs --hours 72
import { isArticleDraft, isStandalonePost } from './monitoring-scope.mjs';
import { buildPlatforms } from './platforms.mjs';
import { articlePlatforms } from './scripts/run-articles.mjs';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, typefully, levanta, telegram, esc, fmtSaigon, logRun, report, opsLog, OPS_LOG_TABLE, HERE_DIR, lvIdOf, alertDecision, readAlertState, writeAlertState, recordAlert } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE, LINK_SENTINEL_AUTOFIX } from './config.mjs';
import { ALLOW_ASINS, DENY_ASINS, SYMPTOM_TERMS, substanceTermsFor, isTrackedLink } from './checks.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const HOURS = parseInt(flag('hours', '168'), 10);
const LIVE_DAYS = parseInt(flag('live-days', '45'), 10);
// Yesterday's whole-fleet clicks at $0 commission that trips the attribution alarm. High enough
// that a slow day never false-alarms; a genuinely broken attribution pipe crosses it in hours.
export const CANARY_MIN_CLICKS = 80;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Same judgement as link-check.mjs/the n8n guard, kept bit-identical on purpose: a healthy tracked
// link resolves to a PRODUCT page; a disabled Levanta link falls back to the Amazon HOMEPAGE with a
// 200, which is exactly the failure to catch. Destination decides, never the HTTP status alone —
// Amazon's anti-bot 503 must not read as dead.
export const PRODUCT_RE = /\/(dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}|amzn\.to\/[A-Za-z0-9]|a\.co\/[A-Za-z0-9]|gumroad\.com\/l\/[A-Za-z0-9]/i;
export const linksOf = (txt) => [...String(txt).matchAll(/https?:\/\/(?:lvnta\.com|gumroad\.com)\/\S+/gi)].map((m) => m[0].replace(/[)\].,'"]+$/, ''));

/**
 * The platforms a draft actually targets, each with its own posts and joined text.
 *
 * Takes the `platforms` object from getDraft — NOT from the drafts LIST, which has no such key
 * (it carries `x_post_enabled` / `threads_post_enabled` booleans and no post bodies at all).
 * A cross-post holds its own tracked links, so every lane has to be read on its own terms.
 */
export function lanesOf(platforms) {
  const lanes = Object.entries(platforms || {})
    .filter(([, v]) => v?.enabled && Array.isArray(v.posts) && v.posts.length)
    .map(([name, v]) => ({ name, posts: v.posts, text: v.posts.map((p) => p.text).join('\n') }));
  // A NATIVE X ARTICLE (owner, R2026-10-03: articles are additive) carries its body, plugs included, in
  // x_article.content_markdown and has no posts. It is one lane holding the whole body as one "post", so
  // the probe, the receipt and the swap reach it like any other; `article` marks it for the patch.
  const md = articleMarkdownOf(platforms);
  if (md != null) lanes.push({ name: 'x_article', article: true, posts: [{ text: md }], text: md });
  return lanes;
}

/** The article body a draft would publish, or null: the same payload rule as monitoring-scope
 *  isArticleDraft (an x_article not switched off, with a body). */
export const articleMarkdownOf = (platforms) => {
  const a = platforms?.x_article;
  return a && a.enabled !== false && typeof a.content_markdown === 'string' && a.content_markdown ? a.content_markdown : null;
};

/**
 * url -> the lanes carrying it, so each URL is probed ONCE however many platforms hold it while a
 * fix still reaches all of them. Insertion-ordered, so the readout follows the draft's own order.
 */
export function urlLanes(lanes) {
  const out = new Map();
  for (const lane of lanes || []) for (const url of new Set(linksOf(lane.text))) {
    if (!out.has(url)) out.set(url, []);
    out.get(url).push(lane);
  }
  return out;
}

/** Judge a final destination. Pure — the network half lives in checkLink(). */
export function classifyDestination(finalUrl, status) {
  if (PRODUCT_RE.test(finalUrl || '')) return { ok: true };
  if (status >= 400) return { ok: false, reason: `HTTP ${status} — ${String(finalUrl).slice(0, 44)}` };
  return { ok: false, reason: `fell back to a non-product page: ${String(finalUrl).slice(0, 44)}` };
}

export async function checkLink(url) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: ctrl.signal });
    clearTimeout(t);
    return classifyDestination(res.url || url, res.status);
  } catch (e) { return { ok: false, reason: `unreachable (${String(e.message || e).slice(0, 40)})` }; }
}

/** Dead only if dead TWICE, a pause apart. Transient anti-bot noise fails once, not twice. */
export async function confirmDead(url, { pauseMs = 20_000, check = checkLink } = {}) {
  const first = await check(url);
  if (first.ok) return { dead: false };
  await new Promise((r) => setTimeout(r, pauseMs));
  const second = await check(url);
  if (second.ok) return { dead: false, flaky: true };
  return { dead: true, reason: second.reason || first.reason };
}

/** PURE. Every tracked link a thread would publish, across X and each cross-post. */
export function scheduledLinks(xPosts = [], platformPosts = {}) {
  const texts = [...xPosts, ...Object.values(platformPosts || {}).flat()].map((p) => String(p?.text ?? p ?? ''));
  return [...new Set(texts.flatMap((t) => (t.match(/https?:\/\/\S+/g) || []).map((u) => u.replace(/[)\].,;:'"]+$/, ''))))].filter((u) => isTrackedLink(u));
}

/**
 * The final link check before a thread is scheduled (owner, 2026-09-24: "link sentinel should be part
 * of the final check before publish too. That way we are sure the links work."). The same judgement
 * and the same double check as the sentinel: dead only if dead twice, a pause apart. Returns every
 * dead link with its reason; the caller writes nothing when any is dead.
 */
export async function linkGate(urls, { confirm = confirmDead } = {}) {
  const dead = [], flaky = [];
  for (const url of [...new Set(urls)]) {
    const v = await confirm(url);
    if (v.dead) dead.push({ url, reason: v.reason });
    else if (v.flaky) flaky.push(url);
  }
  return { dead, flaky, checked: new Set(urls).size };
}

// ---- a dead product: Jev picks the replacement (decisions/plug-replacement.mjs) ------------------

const substanceOf = (p) => { const symptoms = new Set(SYMPTOM_TERMS[p?.asin] || []); return substanceTermsFor(p || {}).filter((t) => !symptoms.has(t)); };
/**
 * PURE. Products that may take a dead product's link: the curated menu (KEEP ∪ allow), never DENY,
 * never the dead ASIN, sharing a substance with it. Same brand first (the plug often names it), then
 * by EPC. At most `max`.
 */
export function replacementCandidates(dead, catalog, { allow = ALLOW_ASINS, deny = DENY_ASINS, max = 6 } = {}) {
  const want = new Set(substanceOf(dead));
  if (!want.size) return [];
  const brand = String(dead?.brand || '').toLowerCase();
  return (catalog || [])
    .filter((p) => p?.asin && p.asin !== dead.asin && allow.has(p.asin) && !deny.has(p.asin) && substanceOf(p).some((t) => want.has(t)))
    .sort((a, b) => (String(b.brand || '').toLowerCase() === brand) - (String(a.brand || '').toLowerCase() === brand) || (Number(b.epc) || 0) - (Number(a.epc) || 0))
    .slice(0, max)
    .map((p) => ({ asin: p.asin, title: p.title, brand: p.brand || null }));
}

/** PURE. The plug tweet that holds `url`, and the tweet before it. */
export function plugContext(posts, url) {
  const i = (posts || []).findIndex((p) => String(p?.text || '').includes(url));
  return i < 0 ? null : { plug: String(posts[i].text), before: i > 0 ? String(posts[i - 1].text) : '' };
}

/**
 * Jev's pick among the candidates, or null. Fail-safe: no candidates, no reading, or nothing at
 * matchAt means null, and the sentinel unschedules exactly as it did before.
 */
export async function pickReplacement({ plug, before, dead, candidates }, { client, decide, registry, laws, log = null, cache, subject = null } = {}) {
  if (!candidates?.length || !plug) return null;
  try {
    const d = await decide('plug-replacement', { plug, before, dead, candidates }, { client, registry, laws, log, cache, subject });
    // Only a reading decide() let act: a shadow downgrade (unpinned model, changed wording, another
    // build) or a fallback leaves the thread to be unscheduled as before.
    if (d.source !== 'jev' || d.action !== 'replace' || !d.detail?.asin) return null;
    const hit = candidates.find((c) => c.asin === d.detail.asin);
    return hit ? { ...hit, confidence: d.confidence, readings: d.detail.readings } : null;
  } catch { return null; }
}

/**
 * Swap one exact URL inside a draft's posts. Pure text surgery, no LLM, no regex on content:
 * exact-match replace of the dead URL, and the caller only applies the result when something was
 * actually replaced — a swap that finds nothing must fall through to unschedule, never silently
 * "succeed" while the dead link stays in the thread.
 */
export function applyUrlSwap(posts, oldUrl, newUrl) {
  let replaced = 0;
  const out = posts.map((p) => {
    const text = String(p.text ?? '');
    if (!text.includes(oldUrl)) return p;
    replaced += text.split(oldUrl).length - 1;
    return { ...p, text: text.split(oldUrl).join(newUrl) };
  });
  return { posts: out, replaced };
}

/**
 * PURE. The `platforms` PATCH that swaps `url` for `newUrl` in every lane holding it (lanesOf lanes),
 * built on `existing`, the draft as it stands. Each social platform gets ITS OWN swapped posts through
 * buildPlatforms, which carries the rest of the draft forward; an article lane gets its body through
 * scripts/run-articles.mjs articlePlatforms and never goes through buildPlatforms, which always writes
 * an ENABLED X lane and would switch X posting on for an article.
 * Returns { platforms, replaced, article, swapped }: `article` is the body written, or null when no
 * article lane held the link; `swapped` is [lane, posts] for the caller to commit once the PATCH lands.
 */
export function swapPatch(holders, url, newUrl, existing) {
  const platformPosts = {}, swapped = [];
  let replaced = 0, article = null;
  for (const lane of holders) {
    const swap = applyUrlSwap(lane.posts, url, newUrl);
    if (!swap.replaced) continue;
    replaced += swap.replaced;
    swapped.push([lane, swap.posts]);
    if (lane.article) article = swap.posts[0].text;
    else platformPosts[lane.name] = swap.posts;
  }
  // buildPlatforms takes X's posts positionally and ignores platformPosts.x, so X's own swapped copy
  // goes in as the first argument.
  const platforms = Object.keys(platformPosts).length
    ? buildPlatforms(platformPosts.x || existing?.x?.posts || [], { existing, platformPosts }) : {};
  if (article != null) platforms.x_article = articlePlatforms(article, existing?.x_article?.cover_media_id || null).x_article;
  return { platforms, replaced, article, swapped };
}

/** Record a PATCH that landed: the lanes and the draft snapshot now hold what Typefully holds, so the
 *  next dead link builds on it. Without this, a second link (a product's Threads twin, say) was patched
 *  over the draft as it was first read, which put the first swap's dead link back. */
export function commitSwap(patch, platforms) {
  for (const [lane, posts] of patch.swapped) { lane.posts = posts; lane.text = posts.map((p) => p.text).join('\n'); }
  if (platforms) Object.assign(platforms, patch.platforms);
}

/**
 * Which fix a confirmed-dead scheduled link gets.
 *
 * remint: only when the ledger knows the link (asin + subid1 to re-mint faithfully) AND the dead
 * URL appears verbatim in the draft text. Anything else — gumroad, hand-edited URL, unknown link —
 * takes the safe path: off the calendar. The fall-through direction is deliberate: the worst
 * outcome is not "a good draft got unscheduled", it is "a dead link published on schedule".
 */
export function decideFix({ ledgerEntry, textHasUrl }) {
  if (ledgerEntry?.asin && ledgerEntry?.subid1 && textHasUrl) return 'remint';
  return 'unschedule';
}

/** True when yesterday's fleet behaviour says attribution itself is broken. */
export function canaryVerdict({ clicks, commission, minClicks = CANARY_MIN_CLICKS }) {
  return clicks >= minClicks && commission <= 0;
}

/** Canary dedupe (Phase 7b). The canary reads YESTERDAY's numbers on a 2h cron, so one bad day
 *  paged the same line 12 times. The day is the fingerprint and the window is a day, because the
 *  number under it changes once a day: each bad day pages once, a NEW bad day pages at once, and a
 *  clean day clears the key. Pure. Returns { tripped, page, record } — record is what to persist
 *  once the page is delivered. */
export const CANARY_KEY = 'link-sentinel:canary';
export const CANARY_WINDOW_H = 24;
export function canaryPlan({ clicks, commission, day, prev, now = Date.now() }) {
  if (!canaryVerdict({ clicks, commission })) return { tripped: false, page: false, record: prev ? { ok: true } : null };
  const page = alertDecision(prev, { fingerprint: day, now, windowH: CANARY_WINDOW_H }) === 'send';
  return { tripped: true, page, record: page ? { fingerprint: day, now } : null };
}

/** [dead-link] prefix breaks fill-queue's ^[workflow] match, so it cannot reschedule the draft. */
export const deadTitle = (title) => (/^\[dead-link\]/i.test(title || '') ? title : `[dead-link] ${title || ''}`.trim());

/** The receipt (operator 2026-09-02): after a probe, the registry row says whether EVERY tracked
 *  link in the thread resolved (`Links Verified`) and when it was last looked at (`Links Checked
 *  At`). Pure: returns the patch, or null when the row already says this and the stamp is fresh.
 *  The sentinel runs every 2h across ~45 days of live rows; re-stamping every row every run would
 *  be hundreds of writes that change nothing. A flip (pass ↔ fail) always writes; an unchanged
 *  verdict re-stamps once a day, so a tick with a stale date reads as stale. */
export const RECEIPT_MAX_AGE_MS = 24 * 36e5;
export function linkReceipt({ verified, prevVerified = false, prevCheckedAt = null, now = Date.now(), maxAgeMs = RECEIPT_MAX_AGE_MS } = {}) {
  const prevMs = prevCheckedAt ? Date.parse(prevCheckedAt) : NaN;
  const fresh = Number.isFinite(prevMs) && now - prevMs < maxAgeMs;
  if (Boolean(prevVerified) === Boolean(verified) && fresh) return null;
  return { 'Links Verified': Boolean(verified), 'Links Checked At': new Date(now).toISOString() };
}

/**
 * Scheduled draft that carries no PUBLIC share link. Engine-created drafts always have one
 * (lib.mjs createDraft defaults share:true; recreate.mjs sends it on the patch path too) — the gap
 * is drafts made BY HAND in the Typefully UI ([re-run] copies, unfilled placeholders), where share
 * is off by default. Those render on the dashboard calendar as chips with no copyable link, which
 * reads as a bug. The fix is one idempotent PATCH {share:true}; content and schedule are untouched.
 */
export const needsShareBackfill = (d) => !!d?.scheduled_date && !d?.share_url;

/**
 * webhookIssues(hooks) — the RT bridge's delivery path, watched.
 *
 * A webhook is the one integration that can die without anything failing anywhere. Typefully sets
 * `is_active: false` on its own after repeated delivery errors and tells nobody: no failed run, no
 * error row, no alert. That is exactly what happened on 2026-08-10 (`auto_disabled_reason:
 * "invalid_url"`) — AI Evolution's group pings stopped for five days and the first signal was the
 * operator noticing posts weren't landing. Nothing in the fleet was watching it, which is the same
 * class of hole the Sentinel exists to close: silence is as loud as failure.
 *
 * Three shapes, all silent:
 *   - DISABLED — `is_active` false. Deliveries have stopped.
 *   - FLAPPED — active, but `auto_disabled_reason` is set. Typefully disabled it at some point and
 *     something (a human, our own re-enable) turned it back on. The cause is unfixed, so it goes
 *     again. Worth saying out loud rather than reading "active" as healthy.
 *   - GONE / NARROWED — the registration was deleted, or its event list no longer carries the event
 *     the bridge fires on. Same dead outcome, and there is no `is_active` flag to read for it.
 *
 * SECURITY: the raw registration carries `webhook_secret`, and the URL path itself is unguessable-
 * by-design (it is the delivery credential). These strings go to Telegram, so this returns the HOST
 * only and never the path, the secret, or the whole object.
 *
 * Pure + testable. Returns [] when everything is healthy.
 */
export const WEBHOOK_REQUIRED_EVENTS = ['draft.published'];
export function webhookIssues(hooks, { required = WEBHOOK_REQUIRED_EVENTS } = {}) {
  const list = Array.isArray(hooks) ? hooks : [];
  if (!list.length) return [{ name: '(none)', host: '', reason: 'NO webhook is registered at all — the bridge has no delivery path' }];
  const out = [];
  for (const h of list) {
    const name = String(h?.name || h?.id || '?');
    const host = (String(h?.url || '').match(/^https?:\/\/([^/]+)/) || [, ''])[1];
    if (h?.is_active === false) {
      out.push({ name, host, reason: `DISABLED by Typefully${h.auto_disabled_reason ? ` (${h.auto_disabled_reason})` : ''} — deliveries have stopped` });
    } else if (h?.auto_disabled_reason) {
      out.push({ name, host, reason: `active, but was auto-disabled (${h.auto_disabled_reason}) — the cause is unfixed and it will disable again` });
    }
    const events = Array.isArray(h?.events) ? h.events : [];
    const missing = required.filter((e) => !events.includes(e));
    if (missing.length) out.push({ name, host, reason: `no longer subscribed to ${missing.join(', ')} — the bridge cannot fire` });
  }
  return out;
}

// ---------------------------------------------------------------------------

const lvId = lvIdOf; // canonical join key (lib.mjs) — adgroup-aware since the 2026-08-24 direct-rail audit

function loadLedger() {
  const f = join(HERE_DIR, 'ledger.jsonl');
  const byLv = new Map();
  if (!existsSync(f)) return byLv;
  for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      const id = lvId(e.link); if (id) byLv.set(id, e);
      // The SECOND product's link was invisible here (352 rows carry a subid1b) — a dead link2
      // could only be unscheduled, never re-minted. Present it as a first-class entry carrying
      // ITS product's asin/subid so decideFix and the remint path work unchanged.
      const id2 = lvId(e.link2);
      if (id2) byLv.set(id2, { ...e, asin: e.asin2, subid1: e.subid1b, product: e.product2, _link2Of: String(e.draftId ?? '') });
    } catch {}
  }
  return byLv;
}

async function registryRows(env) {
  const cutoff = new Date(Date.now() - LIVE_DAYS * 864e5).toISOString();
  // Live money rows in the window, PLUS anything already flagged — recovery must clear the flag
  // even on a post that has aged out of the window.
  const formula = `OR(AND(OR({Status}='Posted',{Status}='Reposted',{Status}='Winner',{Status}='Repost Candidate'),IS_AFTER({Posted Date},'${cutoff}')),{Link Dead})`;
  return (await airtable(env, env.REGISTRY_BASE_ID).listAll(REGISTRY_TABLE, {
    formula,
    fields: ['Type', 'Post', 'Account', 'X URL', 'Subid', 'Link Dead', 'Link Note', 'Posted Date', 'Links Verified', 'Links Checked At'],
  })).filter(r => !isStandalonePost(r));
}

// Re-minted links land here. Batching + 429 retry live in lib's client now (2026-08-30) — this one
// already threw on failure, it just gave up on the first transient 429 mid-sweep.
const patchRegistry = (env, updates) => airtable(env, env.REGISTRY_BASE_ID).update(REGISTRY_TABLE, updates);

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', ...(DRY ? [] : ['AIRTABLE_PAT', 'REGISTRY_BASE_ID'])]);
  const tf = typefully(env);
  const ledgerByLv = loadLedger();
  const fixing = LINK_SENTINEL_AUTOFIX && !DRY;
  const alerts = [];   // telegram lines, worst first
  // Loaded only when a product actually died: the catalogue and Jev (decisions/plug-replacement.mjs).
  let catalogCache = null, jevCache = null;
  const catalog = () => (catalogCache ||= JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || []);
  const jevContext = async () => {
    if (jevCache) return jevCache;
    const [{ jev }, { decide, createDecisionLog }, { DECISIONS }, { LAWS }] = await Promise.all([
      import('./jev.mjs'), import('./jev-decide.mjs'), import('./decisions/index.mjs'), import('./laws.mjs')]); // optional-import
    return (jevCache = { client: jev(env), decide, registry: DECISIONS, laws: LAWS, log: createDecisionLog() });
  };
  const stats = { checked: 0, scheduledDead: 0, reminted: 0, replaced: 0, unscheduled: 0, fixFailed: 0, liveDead: 0, liveRecovered: 0, flaky: 0, shared: 0, webhookIssues: 0, webhookReenabled: 0, receipts: 0 };
  const checkCache = new Map(); // url -> {ok}|{dead...} — one verdict per unique URL per run

  const verdictFor = async (url) => {
    if (!checkCache.has(url)) {
      const first = await checkLink(url);
      checkCache.set(url, first.ok ? { dead: false } : await confirmDead(url));
      stats.checked++;
    }
    return checkCache.get(url);
  };

  // ── Layer 1 — scheduled drafts ─────────────────────────────────────────────
  const health = Object.values(ACCOUNTS).filter((a) => a.plugHeavyExample && !a.paused && a.socialSetId);
  const now = Date.now(), end = now + HOURS * 36e5;
  const draftReceipts = new Map(); // draftId -> { links, dead } — the receipt for scheduled drafts
  for (const acc of health) {
    let drafts = [];
    try {
      let offset = 0;
      while (true) {
        const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=scheduled&limit=50&offset=${offset}`);
        drafts.push(...(j.results || []));
        if (!j.next || !(j.results || []).length) break;
        offset += j.results.length;
      }
    } catch (e) { alerts.push(`⚠️ <b>${esc(acc.name)}</b> — could not list scheduled drafts (${esc(String(e.message).slice(0, 60))}); this account is UNCHECKED this run`); continue; }

    drafts = drafts.filter(d => !isStandalonePost(d));

    // Share backfill rider: every scheduled draft gets a public share_url, whatever created it.
    // Rides here because this loop already holds the full scheduled list per account (zero extra
    // list calls) and the sentinel is the draft-hygiene job. Gated with the other fixes; a failed
    // patch is cosmetic (the calendar chip just stays linkless) so it must never abort the walk.
    if (fixing) {
      for (const d of drafts.filter(needsShareBackfill)) {
        try {
          const p = await tf.patchDraft(acc.socialSetId, d.id, { share: true });
          if (p?.share_url) { d.share_url = p.share_url; stats.shared++; }
        } catch { /* link checking below is the job that matters */ }
      }
    }

    for (const d of drafts.filter((d) => d.scheduled_date && Date.parse(d.scheduled_date) >= now && Date.parse(d.scheduled_date) <= end)) {
      let full; try { full = await tf.getDraft(acc.socialSetId, d.id); } catch { continue; }
      // An article is never a single, even with one placeholder X post (monitoring-scope).
      if (isStandalonePost(full) && !isArticleDraft(full)) continue;
      // EVERY platform the draft targets, not just X. A cross-post carries its OWN tracked links
      // (the `-th` twins, so Levanta can tell Threads from X — it reports on subids, never on
      // referrers), which means X's text is NOT a proxy for the Threads copy: a dead Threads link
      // is invisible in X's posts and vice versa. Scanning X alone left every cross-posted link on
      // the fleet unchecked — no probe, no re-mint, no unschedule.
      // One probe per URL however many platforms carry it (network cost, and the receipt counts
      // tracked links, not link-platform pairs), but the swap below still reaches every holder.
      for (const [url, holders] of urlLanes(lanesOf(full?.platforms))) {
        const text = holders.map((l) => l.text).join('\n');
        const where = holders.map((l) => l.name).join('+');
        const inArticle = holders.some((l) => l.article);
        const v = await verdictFor(url);
        if (v.flaky) stats.flaky++;
        const rc = draftReceipts.get(String(d.id)) || { links: 0, dead: 0 };
        rc.links++; if (v.dead) rc.dead++;
        draftReceipts.set(String(d.id), rc);
        if (!v.dead) continue;
        stats.scheduledDead++;
        const entry = ledgerByLv.get(lvId(url));
        const fix = decideFix({ ledgerEntry: entry, textHasUrl: text.includes(url) });
        const draftRef = `<a href="${full.share_url || `https://typefully.com/?d=${d.id}`}">${esc((d.draft_title || d.id).toString().slice(0, 44))}</a>`;

        if (!fixing) {
          alerts.push(`🔴 <b>${esc(acc.name)}</b> · scheduled ${fmtSaigon(d.scheduled_date)} — dead link on <b>${esc(where)}</b> (${esc(v.reason)})\n   ${draftRef} — ${DRY ? 'dry run' : 'autofix OFF'}, fix by hand`);
          continue;
        }

        // Swap newUrl in for url in every lane that holds it, patching each platform with ITS OWN posts.
        // Two failures live here, both silent:
        //   - swapping only X leaves the same dead link live on the cross-post;
        //   - `existing: d?.platforms` read the LIST item, which carries no `platforms` key at
        //     all (only `*_post_enabled` booleans). undefined sent buildPlatforms down its
        //     CREATE branch with account:null, so the patch returned `{x}` alone and every
        //     re-mint QUIETLY DROPPED Threads and its `-th` twins. `full` is the getDraft
        //     response and does carry `platforms`.
        const swapInto = async (newUrl) => {
          const patch = swapPatch(holders, url, newUrl, full?.platforms);
          if (!patch.replaced) throw new Error('url not found in draft text at patch time');
          await tf.patchDraft(acc.socialSetId, d.id, { platforms: patch.platforms });
          commitSwap(patch, full?.platforms);
        };
        // An article body is read back once its ledger row is written (so a link that reached the draft is
        // always traceable), as scripts/run-articles.mjs reads back every body it writes. The test is the
        // link, not the bytes (Typefully may normalise markdown): the new link in, the dead one out. A swap
        // that did not land throws, and the article falls through to unschedule.
        const readBack = async (newUrl) => {
          if (!inArticle) return;
          const back = String((await tf.getDraft(acc.socialSetId, d.id))?.platforms?.x_article?.content_markdown || '');
          if (!back.includes(newUrl) || back.includes(url)) throw new Error('the article body did not take the new link');
        };
        // URL preference mirrors recreate/republish: lvnta redirect unless the account opted into
        // the direct rail (mint.link never existed in Levanta's response shape).
        const mintFor = async (asin, subid) => {
          const mint = await levanta(env).mintLink(asin, subid);
          const newUrl = acc.directLink ? (mint?.url || mint?.mobileOptimizedUrl || mint?.mobile_optimized_url)
            : (mint?.mobileOptimizedUrl || mint?.mobile_optimized_url || mint?.url);
          if (!newUrl) throw new Error('mint returned no url');
          const after = await checkLink(newUrl);
          if (!after.ok) throw new Error(`fresh link also dead: ${after.reason}`);
          return newUrl;
        };
        const nonce = () => Math.random().toString(36).slice(2, 6);

        if (fix === 'remint') {
          try {
            // Same-subid remint returns the SAME (dead) link — the collision class recreate.mjs
            // nonces against — so the fresh mint gets a -s<nonce> suffix and the ledger row records it.
            const remintSubid = `${entry.subid1}-s${nonce()}`;
            const newUrl = await mintFor(entry.asin, remintSubid);
            await swapInto(newUrl);
            appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(entry._link2Of
              ? { ts: new Date().toISOString(), account: entry.account, draftId: entry.draftId, mode: 'sentinel-remint', link2: newUrl, subid1b: remintSubid, asin2: entry.asin, product2: entry.product, remintOf: url, note: 'link-sentinel remint (second product)' }
              : { ...entry, ts: new Date().toISOString(), subid1: remintSubid, link: newUrl, remintOf: url, note: 'link-sentinel remint' }) + '\n');
            await readBack(newUrl);
            stats.reminted++;
            rc.dead--; // the dead link is out of the draft and its replacement passed checkLink above
            await opsLog(env, { source: 'link-sentinel', level: 'action', event: `re-minted dead link in scheduled draft (${acc.name})`, detail: { draft: d.id, platforms: where, old: url, new: newUrl, asin: entry.asin, subid1: entry.subid1 } });
            alerts.push(`🟢 <b>${esc(acc.name)}</b> · ${fmtSaigon(d.scheduled_date)} — dead link REPLACED in place on <b>${esc(where)}</b> (${esc(entry.product?.slice(0, 30) || entry.asin)}), schedule intact\n   ${draftRef}`);
            continue;
          } catch (e) {
            stats.fixFailed++;
            alerts.push(`🟠 <b>${esc(acc.name)}</b> — remint failed (${esc(String(e.message).slice(0, 60))}); asking Jev for a replacement product`);
          }
          // THE PRODUCT ITSELF IS DEAD (owner, 2026-09-24): Jev picks a replacement the plug already
          // describes truthfully (decisions/plug-replacement.mjs), so the thread keeps its slot. Only
          // the link changes, never the words. No pick: unschedule below, exactly as before.
          try {
            const dead = catalog().find((p) => p.asin === entry.asin) || { asin: entry.asin, title: entry.product || entry.asin };
            const candidates = replacementCandidates(dead, catalog());
            // An ARTICLE never takes a replacement product: its body argues the product across a whole
            // section, not in one plug tweet the decision reads, so it goes off the calendar instead.
            const ctx = inArticle ? null : plugContext(holders.find((l) => l.text.includes(url))?.posts || [], url);
            const pick = candidates.length && ctx ? await pickReplacement({ ...ctx, dead, candidates }, { ...(await jevContext()), subject: `draft:${d.id}` }) : null;
            if (pick) {
              const subid = `${entry.subid1}-r${nonce()}`;
              const newUrl = await mintFor(pick.asin, subid);
              await swapInto(newUrl);
              appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(entry._link2Of
                ? { ts: new Date().toISOString(), account: entry.account, draftId: entry.draftId, mode: 'sentinel-replace', link2: newUrl, subid1b: subid, asin2: pick.asin, product2: pick.title, replacedFrom: entry.asin, remintOf: url, note: `link-sentinel replacement (Jev ${pick.confidence})` }
                : { ...entry, ts: new Date().toISOString(), asin: pick.asin, product: pick.title, subid1: subid, link: newUrl, replacedFrom: entry.asin, remintOf: url, note: `link-sentinel replacement (Jev ${pick.confidence})` }) + '\n');
              stats.replaced++;
              rc.dead--;
              await opsLog(env, { source: 'link-sentinel', level: 'action', event: `replaced a dead product in a scheduled draft (${acc.name})`, detail: { draft: d.id, platforms: where, old: url, new: newUrl, from: entry.asin, to: pick.asin, jev: pick.confidence } });
              alerts.push(`🟢 <b>${esc(acc.name)}</b> · ${fmtSaigon(d.scheduled_date)} — product dead; Jev swapped the link to <b>${esc(String(pick.title).slice(0, 40))}</b> (the plug fits it, ${pick.confidence}), schedule intact\n   ${draftRef}`);
              continue;
            }
            alerts.push(inArticle
              ? `🟠 <b>${esc(acc.name)}</b> — the article's product is dead and an article never takes a replacement product; unscheduling`
              : `🟠 <b>${esc(acc.name)}</b> — no replacement the plug describes truthfully (${candidates.length} candidate(s) read); unscheduling`);
          } catch (e) {
            stats.fixFailed++;
            alerts.push(`🟠 <b>${esc(acc.name)}</b> — replacement failed (${esc(String(e.message).slice(0, 60))}); unscheduling`);
          }
        }

        // Unschedule + retitle, then VERIFY — an unverified unschedule is a false sense of safety.
        try {
          await tf.patchDraft(acc.socialSetId, d.id, { publish_at: null, draft_title: deadTitle(d.draft_title) });
          const check = await tf.getDraft(acc.socialSetId, d.id);
          if (check?.scheduled_date) throw new Error('draft still shows a scheduled_date after PATCH');
          stats.unscheduled++;
          await opsLog(env, { source: 'link-sentinel', level: 'action', event: `unscheduled draft with dead link (${acc.name})`, detail: { draft: d.id, was: d.scheduled_date, reason: v.reason } });
          alerts.push(`🔴 <b>${esc(acc.name)}</b> — dead link (${esc(v.reason)}); draft UNSCHEDULED so it cannot publish broken\n   ${draftRef} · was ${fmtSaigon(d.scheduled_date)} · swap the product, then reschedule`);
        } catch (e) {
          stats.fixFailed++;
          alerts.push(`🚨 <b>${esc(acc.name)}</b> — dead link AND unschedule FAILED (${esc(String(e.message).slice(0, 60))}) — publishes ${fmtSaigon(d.scheduled_date)} UNLESS FIXED BY HAND\n   ${draftRef}`);
        }
      }
    }
  }

  // Receipts for scheduled drafts: the registry row gets the same tick, when registry-sync has
  // built one. EXISTING rows only — a stub created here would be an orphan the moment the draft
  // is deleted, and registry-sync owns row creation. A draft with no tracked link gets no receipt:
  // nothing was verified.
  if (draftReceipts.size && !DRY && env.AIRTABLE_PAT) {
    try {
      const ids = [...draftReceipts.keys()].filter((id) => draftReceipts.get(id).links > 0);
      const at = airtable(env, env.REGISTRY_BASE_ID);
      const updates = [];
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        // lib's list() takes `formula` (not Airtable's `filterByFormula`) — the wrong key is ignored
        // and the first page comes back unfiltered, which is how the first live run stamped zero
        // scheduled rows while reporting success.
        const rows = await at.list(REGISTRY_TABLE, { formula: `OR(${chunk.map((id) => `{Draft ID}='${id}'`).join(',')})`, fields: ['Draft ID', 'Links Verified', 'Links Checked At'], pageSize: 50, max: 50 });
        for (const row of rows) {
          const rc = draftReceipts.get(String(row.fields['Draft ID']));
          if (!rc) continue;
          const receipt = linkReceipt({ verified: rc.dead === 0, prevVerified: row.fields['Links Verified'], prevCheckedAt: row.fields['Links Checked At'] });
          if (receipt) updates.push({ id: row.id, fields: receipt });
        }
      }
      if (updates.length) { await patchRegistry(env, updates); stats.receipts += updates.length; }
    } catch (e) { alerts.push(`⚠️ scheduled-draft receipts not written (${esc(String(e.message).slice(0, 60))})`); }
  }

  // ── Layer 2 — live posts ───────────────────────────────────────────────────
  let liveRows = [];
  try { liveRows = DRY && !env.AIRTABLE_PAT ? [] : await registryRows(env); }
  catch (e) { alerts.push(`⚠️ registry unreadable (${esc(String(e.message).slice(0, 60))}) — live posts UNCHECKED this run`); }

  // Clicks in the last 14d per lv id — turns "a link is dead" into "how much traffic is hitting it".
  const clicksByLv = new Map();
  try {
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const dayMax = new Map();
    for (const r of await levanta(env).listReports({ start: since, end: new Date().toISOString().slice(0, 10) })) {
      const id = r.link?.id; if (!id) continue;
      const k = `${String(r.date || '').slice(0, 10)}|${id}`;
      const c = Number(r.clicks) || 0;
      if (c > (dayMax.get(k) || 0)) dayMax.set(k, c);
    }
    for (const [k, c] of dayMax) { const id = k.split('|')[1]; clicksByLv.set(id, (clicksByLv.get(id) || 0) + c); }
  } catch { /* ranking is decoration; the check itself must not depend on it */ }

  const subidToLv = new Map();
  for (const e of ledgerByLv.values()) if (e.subid1) subidToLv.set(e.subid1, e);
  const regUpdates = [];  // state transitions (dead / recovered) — alerted and Ops-logged
  const receipts = [];    // receipt-only patches — silent; the tick and its date are the message
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const row of liveRows) {
    const f = row.fields;
    const entry = f.Subid ? subidToLv.get(f.Subid) : null;
    if (!entry?.link) continue; // no tracked link on record — nothing to verify, so no receipt either
    const v = await verdictFor(entry.link);
    if (v.flaky) stats.flaky++;
    const wasDead = Boolean(f['Link Dead']);
    let transition = null;
    if (v.dead && !wasDead) {
      stats.liveDead++;
      const clicks = clicksByLv.get(lvId(entry.link)) || 0;
      transition = { 'Link Dead': true, 'Link Note': `dead ${stamp} · ${v.reason?.slice(0, 80)}` };
      alerts.push(`🔴 <b>LIVE</b> · ${esc(f.Account || '?')} — <b>${esc((f.Post || '').slice(0, 40))}</b>\n   link dead (${esc(v.reason)}) · <b>${clicks} clicks</b> hit it in 14d${f['X URL'] ? ` · <a href="${f['X URL']}">post</a>` : ''}`);
    } else if (!v.dead && wasDead) {
      stats.liveRecovered++;
      transition = { 'Link Dead': false, 'Link Note': `recovered ${stamp}` };
      alerts.push(`🟢 LIVE recovered · ${esc(f.Account || '?')} — ${esc((f.Post || '').slice(0, 40))}`);
    }
    const receipt = linkReceipt({ verified: !v.dead, prevVerified: f['Links Verified'], prevCheckedAt: f['Links Checked At'] });
    if (transition) regUpdates.push({ id: row.id, fields: { ...transition, ...(receipt || {}) } });
    else if (receipt) receipts.push({ id: row.id, fields: receipt });
  }
  if ((regUpdates.length || receipts.length) && !DRY) {
    await patchRegistry(env, [...regUpdates, ...receipts]);
    stats.receipts += receipts.length + regUpdates.filter((u) => 'Links Verified' in u.fields).length;
    for (const u of regUpdates) {
      await opsLog(env, { source: 'link-sentinel', level: u.fields['Link Dead'] ? 'action' : 'info', event: u.fields['Link Dead'] ? 'flagged LIVE post: link dead' : 'live post link recovered — flag cleared', detail: { record: u.id, note: u.fields['Link Note'] } });
    }
  }

  // ── Layer 3 — money canary ─────────────────────────────────────────────────
  let canary = null;
  try {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const rows = await levanta(env).listReports({ start: y, end: y });
    const dayMax = new Map(); let commission = 0;
    for (const r of rows) {
      const id = r.link?.id; if (!id) continue;
      commission += Number(r.commissionEarned) || 0;
      const c = Number(r.clicks) || 0;
      if (c > (dayMax.get(id) || 0)) dayMax.set(id, c);
    }
    const clicks = [...dayMax.values()].reduce((s, c) => s + c, 0);
    canary = canaryPlan({ clicks, commission, day: y, prev: readAlertState()[CANARY_KEY] });
    if (canary.tripped) {
      // The Ops Log row stays on every run — it is the durable record; only the page is deduped.
      await opsLog(env, { source: 'link-sentinel', level: 'warn', event: `attribution canary: ${clicks} clicks, $0 commission yesterday`, detail: { clicks, commission } });
      if (!canary.page) console.log(`  canary: ${y} already paged within ${CANARY_WINDOW_H}h — not repeated`);
    }
    if (canary.page) {
      alerts.unshift(`🚨 <b>ATTRIBUTION CANARY</b> — ${clicks} fleet clicks yesterday, <b>$0.00 commission</b>. Links may resolve while attribution is broken; check Levanta subids/keys NOW.`);
    }
  } catch (e) { canary = null; alerts.push(`⚠️ canary skipped (Levanta: ${esc(String(e.message).slice(0, 50))})`); }

  // ── Layer 4 — webhook watch ────────────────────────────────────────────────
  // Detection always runs (read-only); only the re-enable is gated, like every other fix here.
  try {
    const hooks = await tf.get('/webhooks');
    const issues = webhookIssues(hooks);
    stats.webhookIssues = issues.length;
    for (const i of issues) alerts.unshift(`🚨 <b>WEBHOOK</b> · ${esc(i.name)}${i.host ? ` (${esc(i.host)})` : ''} — ${esc(i.reason)}`);

    // Re-enabling is the one repair here worth automating: it is idempotent, and every minute the
    // webhook stays off is events lost for good (Typefully does not replay them). It is never
    // silent — the alert above already fired, and this adds its own line. If Typefully disables it
    // again the next run says so again, and THAT repetition is the signal that the endpoint itself
    // is wrong and needs a human, rather than a third re-enable.
    if (fixing) {
      for (const h of (Array.isArray(hooks) ? hooks : []).filter((h) => h?.is_active === false && h?.id)) {
        const label = String(h.name || h.id);
        try {
          await tf.patch(`/webhooks/${h.id}`, { is_active: true });
          stats.webhookReenabled++;
          alerts.unshift(`🔧 re-enabled webhook <b>${esc(label)}</b> — confirm the endpoint actually answers, or Typefully will disable it again`);
          await opsLog(env, { source: 'link-sentinel', level: 'action', event: `re-enabled Typefully webhook ${label}`, detail: { reason: h.auto_disabled_reason || null } });
        } catch (e) {
          alerts.unshift(`⚠️ could not re-enable webhook <b>${esc(label)}</b>: ${esc(String(e.message).slice(0, 60))} — fix it by hand`);
        }
      }
    }
    if (issues.length && !DRY) {
      await opsLog(env, { source: 'link-sentinel', level: 'warn', event: `webhook watch: ${issues.length} issue(s)`, detail: { issues } });
    }
  } catch (e) { alerts.push(`⚠️ webhook watch skipped (Typefully: ${esc(String(e.message).slice(0, 50))})`); }

  // ── Ops Log retention ──────────────────────────────────────────────────────
  // ~30 days is enough to diagnose anything and keeps the table small enough that the dashboard
  // reads it whole. Capped per run so a huge backlog can never stall the sentinel's real job.
  if (!DRY) {
    try {
      const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
      const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
      const p = new URLSearchParams({ pageSize: '100', filterByFormula: `IS_BEFORE({At},'${cutoff}')` });
      p.append('fields[]', 'At');
      const j = await (await fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(OPS_LOG_TABLE)}?${p}`, { headers: h })).json();
      const ids = (j.records || []).slice(0, 200).map((r) => r.id);
      for (let i = 0; i < ids.length; i += 10) {
        const q = ids.slice(i, i + 10).map((id) => `records[]=${id}`).join('&');
        await fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(OPS_LOG_TABLE)}?${q}`, { method: 'DELETE', headers: h });
      }
      if (ids.length) console.log(`ops-log: pruned ${ids.length} row(s) older than 30d`);
    } catch { /* retention is housekeeping — never the reason a run fails */ }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const summary = `checked ${stats.checked} link(s) · scheduled dead ${stats.scheduledDead} (reminted ${stats.reminted}, replaced ${stats.replaced}, unscheduled ${stats.unscheduled}, failed ${stats.fixFailed}) · live dead ${stats.liveDead}, recovered ${stats.liveRecovered}${stats.flaky ? ` · ${stats.flaky} flaky (passed on recheck)` : ''}${stats.shared ? ` · ${stats.shared} share link(s) backfilled` : ''}${stats.receipts ? ` · ${stats.receipts} receipt(s) stamped` : ''}${stats.webhookIssues ? ` · webhook ${stats.webhookIssues} issue(s)${stats.webhookReenabled ? `, ${stats.webhookReenabled} re-enabled` : ''}` : ''}`;
  console.log(`link-sentinel: ${summary}`);
  for (const a of alerts) console.log('  ' + a.replace(/<[^>]+>/g, ''));
  logRun('link-sentinel', { ...stats, alerts: alerts.length, autofix: fixing });

  // Interrupt-only: a quiet run says nothing (SEND_STATE_DIGESTS philosophy) — every message from
  // this sender must mean "something needs or took an action", or the reader learns to swipe it away.
  if (alerts.length && !DRY) {
    const out = report({
      emoji: '🛡️', title: 'Link Sentinel', scope: `next ${HOURS}h scheduled + last ${LIVE_DAYS}d live`,
      status: summary,
      sections: [{ label: 'EVENTS', body: alerts.slice(0, 25).join('\n\n') }],
      action: stats.unscheduled ? 'Unscheduled drafts need a product swap, then reschedule.' : 'Review the events above.',
    });
    await telegram(env, out, 'alerts');
  }
  // Persisted only after the page was delivered (a throw above skips this, so it retries next run).
  if (canary?.record && !DRY) writeAlertState(recordAlert(readAlertState(), CANARY_KEY, canary.record));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('link-sentinel failed:', e.stack || e.message); process.exit(1); });
}
