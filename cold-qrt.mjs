#!/usr/bin/env node
// cold-qrt.mjs — the cold QRT lane: two quote posts a day on other creators' X Articles.
//
// PORTED FROM 2t1c/genius (cold-qrt.mjs at aba3896). Owner, 2026-10-02: "port into PI", and "No cadence yet — I want you
// to understand the structure and how it works". The machine is Genius's, kept as close to it as PI allows, so a later
// Genius fix carries over as a small diff. What PI changes:
//   - THE PAGE: any PI account, named with --account (or read off the slate). Its settings are qrt-boxes.mjs, and every
//     page's cold lane is OFF until the owner's spec turns one on, so every command refuses until then.
//   - WHAT A PAGE QUOTES (fitOf): only its own niches (onlyNiches), never a handle on its never-quote list, and no
//     partner-network pieces (no PI page has a partner; GTX's is a16z).
//   - APPROVAL: PI has no Genius-style run batch, so the owner's approval is recorded on the slot itself
//     (`approve`, with their words). `schedule` takes a slot that auto-passed or carries that approval.
//   - NOT PORTED: the a16z ASAP lane (`a16z`), visuals (`visual`, `visuals`: GTX's house chart has no PI style yet),
//     the batch into Genius runs (`batch`), and Jev's advisory reading (`check --read`, Genius's qrt-fill.mjs saver).
//     Their pure helpers stay, with their tests, so the port tracks Genius.
// In PI:
//   node cold-qrt.mjs pick --account <page> --from 2026-10-05 [--skip <tid,…>] [--show 15]   # the week's slate + material
//   (write each slot's `text` in the slate, in the chat)
//   node cold-qrt.mjs check    --slate qrts/cold/<page>/W2026-10-05.json   # hard stops, structure, variety; AUTO or PASS
//   node cold-qrt.mjs draft    --slate … [--dry]                           # Typefully quote posts, share:false, NOT scheduled
//   node cold-qrt.mjs approve  --slate … --slot <at|all> --words "…"       # the owner's approval of a PASS line, in their words
//   node cold-qrt.mjs schedule --slate … [--dry]                           # ONLY on the owner's word: AUTO lines and approved ones
//   node cold-qrt.mjs fresh --account <page> [--apply] · plan --slate … [--apply] · space --slate … [--apply]
// Everything below this block is Genius's own account of the lane; read "GTX" as "the page".
//
// Operator, 2026-09-28: "we have an article tracker that's already in Airtable that tracks popular articles by big
// creators, we can create a cold retweet content lane … just like the way that AI guides are doing them. Super simple
// … 7 a week, so 1 per day … we don't need the retweet path for it." Raised to two a day on 2026-09-29 ("Can we
// increase cold QRT volume to 2/day"), with the 15:30 slot open to articles the scout found in the last two days.
//
// The model is @AIGuide_ (26 days studied, 2026-09-02 → 09-27): 63% of what they write is QRTs, and 7 of their 8 posts
// over 100K are short lines on top of OTHER creators' X Articles. What worked, and what this lane keeps:
//   - quote an evergreen X Article (age did not matter: 7 minutes, 15 days and 236 days all cleared 100K);
//   - 40–200 characters, "if you [...] read this" / "must read" / one short pulled line in quotation marks;
//   - ask them to read it (and not just bookmark it), give one reason, never a summary (summaries: median 5.2K,
//     none reached 20K);
//   - no media on the QRT (all 8 of their 100K+ QRTs had none);
//   - never the same article two days in a row (operator 2026-09-28: "drop this rule — just make sure not same
//     article 2 days in a row"); reuse is otherwise allowed, and recent use only lowers an article's rank.
//
// THE SOURCE is the Articles table the article scout fills (n8n-x-pipeline/article-harvest.mjs, swipe base,
// `tblnvV3IusVkEX6jg`): native X Articles over 200K views or 2K likes, with their body text. The lane reads it live.
//
// THE RT PATH IS NOT NEEDED, and nothing has to be switched off for that: a cold QRT is one post, and GeniusGTX runs
// `RT Threads Only` on the RT Bridge, so a single never pings the vendor groups or enters the paid ladder.
//
// Writing happens in the chat (operator 2026-09-25: "all writing should be done in my cloud or codex chat not through
// API"). This file picks, files the material, checks, drafts and schedules: a proven template kept almost exactly
// auto-passes (autoPassOf, operator 2026-09-29: "structure with high confidence"); anything else waits for the
// operator's Approve in the batch.
//
//   node cold-qrt.mjs pick --from 2026-09-29            # a week's slate (two a day): qrts/cold/W2026-09-29.json + each article's material
//   node cold-qrt.mjs pick --from 2026-09-29 --skip <tweetId,…> --show 20   # swap picks out, see the alternates
//   (write each slot's `text` in the slate, in the chat)
//   node cold-qrt.mjs check --slate qrts/cold/W2026-09-29.json     # lane rules + the saver against the article body
//   node cold-qrt.mjs draft --slate qrts/cold/W2026-09-29.json [--dry]      # Typefully drafts, quote posts, share:false, NOT scheduled
//   node cold-qrt.mjs fresh [--hours 48] [--apply]                       # the newest tracked article onto the next open 15:30 slot
//   node cold-qrt.mjs a16z [--hours 6] [--apply]                         # new a16z-network articles onto ASAP slots
//   node cold-qrt.mjs space --slate qrts/cold/W….json [--apply]           # move cold slots so no GTX post is within 45 min of another
//   node cold-qrt.mjs plan --slate qrts/cold/W….json [--apply]            # a rubric template per unwritten slot, families rotated
//   node cold-qrt.mjs visuals --slate qrts/cold/W….json [--apply]         # which slots earn a diagram (≤2 a week, one a day)
//   node cold-qrt.mjs visual --slate … --slot <at> --html chart.html [--dry]  # a house chart (chart-shot.mjs), upload, set on the slot
//   node cold-qrt.mjs visual --slate … --slot <at> --scene "…" [--dry]       # or the engraved diagram (cover-gen --diagram 1:1)
//   node cold-qrt.mjs batch --slate qrts/cold/W2026-09-29.json [--dry]      # the slots into their runs' review batch (draft does it too)
//   node cold-qrt.mjs schedule --slate qrts/cold/W2026-09-29.json [--dry]   # ONLY when the operator says so, and only slots Approved in the batch
//
// THE BATCH (operator 2026-09-29: "yes put cold QRTs in the batch"). Every drafted slot is also a QRT piece in the run
// whose window holds its day (`cold-<date>`, lane "cold"), so it is reviewed in Notion with the rest of the run's
// content, and `schedule` only takes the slots whose piece carries the operator's Approve.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyQuotesOf } from './quote-mine.mjs';
import { pick as rubricPick } from './qrt-pick.mjs';
import { NOTE_FRAMES, STRUCTURE_MIN, provenOf, templateFit, viralityOf } from './qrt-score.mjs';
import { codeChecks, materialOf as pieceMaterialOf } from './qrt-checks.mjs';
import { boxOf, coldPages } from './qrt-boxes.mjs';
import { MEME_TEMPLATES, isMemeTemplate, uploadMeme } from './qrt-meme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIR = path.join(HERE, 'qrts', 'cold');
export const ARTICLES = 'tblnvV3IusVkEX6jg';
// THE PAGE a run works for (the toolkit, operator 2026-09-29: "Package our QRT and Article into a toolkit that I can
// implement to other pages too"). `--account <key>` switches it: the page's slates live in qrts/cold/<key>/ (GTX, the
// first page, keeps qrts/cold/), its drafts go to its own social set, and its box (boxes.mjs `qrt.cold`) sets its
// niche weights. Everything else in the lane is the same machine for every page.
// PI: no default page. `usePage` sets it; `pages` lets a test hand in its own settings (qrt-boxes.mjs boxOf).
export let PAGE = null;
/** Point the lane at a page. Returns the page. Throws when the page is unknown or its cold lane is off. */
export function usePage(key, { pages } = {}) {
  const box = boxOf(key, pages ? { pages } : undefined);
  const cold = box.qrt?.cold;
  if (!cold?.on) throw new Error(`cold-qrt: ${box.account}'s cold lane is off (qrt-boxes.mjs PAGES.${box.account}.cold.on; owner 2026-10-02: "No cadence yet")`);
  const handles = (list) => new Set((list || []).map((h) => String(h).replace(/^@/, '').toLowerCase()));
  PAGE = {
    key: box.account, handle: box.identity.xHandle || box.identity.handle, socialSetId: box.identity.socialSetId,
    dir: path.join(DIR, box.account), nicheWeight: cold.niches || null, onlyNiches: cold.onlyNiches !== false,
    offTypes: new Set(cold.offTypes || DEFAULT_OFF_TYPES), neverQuote: handles(cold.neverQuote), partner: cold.partner || null,
    visuals: cold.visuals || null,
    // PI: a page may set its own slot times and count (the boosters' A slots, qrt-boxes.mjs), and share a `group` whose
    // pages never quote the same article on the same day.
    slots: Array.isArray(cold.slots) && cold.slots.length ? cold.slots : null, perDay: cold.perDay || null, group: cold.group || null,
  };
  return PAGE;
}
// TWO LANES, ONE SLOT EACH A DAY (operator 2026-09-29: "Can we increase cold QRT volume to 2/day", then "we can have
// 2 lanes —> new QT (newly publish) and old QT (old but viral)"). Both slots sit inside the operator's 14:00–18:00
// window on times the posting grid (docs/gtx-week-schedule.md) leaves free every day. 15:30 is the NEW lane: articles
// published in the last NEW_DAYS, fastest first, and `fresh` swaps in anything newer the scout finds during the week.
// 16:30 is the OLD lane: proven, saved-and-viral pieces of any age, and the a16z pick on the 2nd and 5th days.
//
// ON US EASTERN TIME (operator 2026-09-30: "our main post should come when the audience is awake … give it a little bit
// of time for it to mature, and then our [QRTs] will come in"). The NEW lane now starts at 10:00 AM ET (14:00 UTC,
// 21:00 Saigon) and the OLD lane at 3:00 PM ET (19:00 UTC, 02:00 Saigon), after the 7:00 AM ET main post. These are
// starting points: `qrt-queue.mjs spread` then fits each day to boxes.mjs qrt.daily (weekends an hour later, clear of
// the day's originals). The times are fixed in UTC, so from Nov 1 (EST) they read an hour earlier in ET until spread.
// LEGACY_SLOTS are the 15:30/16:30 Saigon times slates written before 2026-09-30 still carry.
export const SLOTS = Object.freeze([
  Object.freeze({ saigon: '21:00', et: '10:00', utcHour: 14, utcMinute: 0, kind: 'new' }),
  Object.freeze({ saigon: '02:00', et: '15:00', utcHour: 19, utcMinute: 0, kind: 'old' }),
]);
export const LEGACY_SLOTS = Object.freeze([
  Object.freeze({ saigon: '15:30', utcHour: 8, utcMinute: 30, kind: 'new' }),
  Object.freeze({ saigon: '16:30', utcHour: 9, utcMinute: 30, kind: 'old' }),
]);
export const SLOT = SLOTS[1];
export const PER_DAY = SLOTS.length;
export const PER_WEEK = 7 * PER_DAY;
/** PURE. The slot definition of a slot time (UTC ISO): the slot's stored lane, its time, or the OLD-lane slot. */
export const slotDefOf = (at, lane = null) => {
  const d = new Date(at);
  const hit = [...(PAGE?.slots || []), ...SLOTS, ...LEGACY_SLOTS].find((x) => x.utcHour === d.getUTCHours() && x.utcMinute === d.getUTCMinutes());
  if (lane) return (PAGE?.slots || SLOTS).find((x) => x.kind === lane) || hit || SLOT;
  return hit || SLOT;
};

const sel = (x) => (x && typeof x === 'object' ? x.name : x) || '';
const num = (x) => (Number.isFinite(+x) ? +x : 0);

// GTX is "the greatest minds in economics, psychology, and history". Tool tutorials and listicles are the tracker's
// AI-hustle half and do not fit the brand; on the AI floor only the pieces that argue something stay in. PI: a page's
// own offTypes (qrt-boxes.mjs) replace these; this is the default.
export const DEFAULT_OFF_TYPES = Object.freeze(['Tool Tutorial', 'Listicle']);
// PI fix (2026-10-02, found on the first PI pick): Genius's pattern anchored the swear to the start of a word, so
// compounds went through ("How to Unf*ck Your Life.", "(No Bullsh*t Guide)"). A swear anywhere in a word now counts.
export const PROFANE = /f[u*]ck|\bsh[i*]t|sh[i*]t\b|bitch|\bdamn\b|\bass\b/i;
export const AI_TYPES = new Set(['Explainer', 'Contrarian Thesis', 'Market Analysis', 'Prediction', 'Framework', 'Story']);
// GTX's own topics win ties and then some (operator 2026-09-28, Niche on the tracker): the tracker's {Niche} weighs the
// evergreen score. Anything unlisted counts 1. PI: the weights are the page's own (qrt-boxes.mjs cold.niches).
export const nicheWeightOf = (niche) => (PAGE?.nicheWeight || {})[niche] || 1;
// THE a16z NETWORK (operator 2026-09-28: "we will also want to track a16z's partner's articles … even if they have lower
// engagement, it's still good for us to QRT them to build the right association"). The tracker files them as Floor Tier
// "Partner" (over 20K views). Their numbers can't compete with a 5M-view self-help piece, so they get their own days:
// the 2nd and 5th of every week, picked by recency, niche and reach instead of the evergreen score.
export const PARTNER_TIER = 'Partner';
export const PARTNER_DAYS = new Set([1, 4]);
export const isPartner = (r) => r.floor === PARTNER_TIER;

/** PURE. The tracked row as the lane reads it. */
export function rowOf(fields = {}) {
  const url = String(fields['Tweet URL'] || '').trim();
  const tid = String(fields.TweetID || (url.match(/status\/(\d+)/) || [])[1] || '').trim();
  const views = num(fields.Impressions);
  const bookmarks = num(fields.Bookmarks);
  return {
    tid, url, handle: String(fields.Handle || '').replace(/^@/, '').trim(), title: String(fields.Title || '').trim(),
    type: sel(fields['Article Type']), niche: sel(fields.Niche), floor: sel(fields['Floor Tier']), views, bookmarks, likes: num(fields.Likes),
    bpv: views ? bookmarks / views : 0, published: String(fields['Published Date'] || ''), body: String(fields['Body Text'] || ''),
    preview: String(fields['Preview Text'] || ''),
  };
}

/** PURE. Whether the page can quote this article, and why not. */
export function fitOf(r) {
  if (!r.tid || !/^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(r.url)) return { ok: false, why: 'no post URL' };
  if (PAGE && r.handle.toLowerCase() === PAGE.handle.toLowerCase()) return { ok: false, why: 'our own article' };
  if (!r.title) return { ok: false, why: 'no title' };
  // The quote card carries their title under our name, so a sworn title is ours too.
  if (PROFANE.test(r.title)) return { ok: false, why: 'profanity in the title: off-brand under our name' };
  // PI: a handle the page never quotes, whatever the article (qrt-boxes.mjs cold.neverQuote).
  if (PAGE?.neverQuote?.has(r.handle.toLowerCase())) return { ok: false, why: `@${r.handle} is on this page's never-quote list` };
  // The association is the point for a page with a partner network: any of its pieces the tracker kept. PI pages have none.
  if (isPartner(r)) return PAGE?.partner ? { ok: true, why: '' } : { ok: false, why: 'a partner-network piece: this page has no partner network' };
  if ((PAGE?.offTypes || new Set(DEFAULT_OFF_TYPES)).has(r.type)) return { ok: false, why: `${r.type}: off-brand for this page` };
  if (r.floor === 'AI' && !AI_TYPES.has(r.type)) return { ok: false, why: `AI ${r.type || 'piece'}: off-brand for this page` };
  // PI: a page quotes only its own niches (a health page under an AI tutorial reads as off-brand).
  if (PAGE?.onlyNiches && !Object.prototype.hasOwnProperty.call(PAGE.nicheWeight || {}, r.niche)) return { ok: false, why: `${r.niche || 'no niche'}: not one of this page's niches` };
  return { ok: true, why: '' };
}

/** PURE. Evergreen pull first: bookmarks per view says people keep it, log views says the reach is real, and GTX's
 *  own topics weigh more. */
export const scoreOf = (r) => r.bpv * Math.log10(Math.max(10, r.views)) * nicheWeightOf(r.niche);

/** PURE. An a16z-network piece on `day`: the newer the better (the association is with what they're saying now), on
 *  GTX's topics, with reach as the tiebreak. Halves every 30 days of age. */
export const partnerScoreOf = (r, day) => {
  const age = r.published ? Math.max(0, (Date.parse(`${day}T00:00:00Z`) - Date.parse(r.published)) / 86400000) : 365;
  return 0.5 ** (age / 30) * Math.log10(Math.max(10, r.views)) * nicheWeightOf(r.niche);
};

/** PURE. When every article in the earlier slates was last quoted, counting only days before `before`: { tid: 'YYYY-MM-DD' }. */
export function usedOf(slates = [], before = '9999-12-31') {
  const last = {};
  for (const s of slates) for (const x of s.slots || []) {
    const day = String(x.at || '').slice(0, 10);
    if (x.tid && day && day < before && !(last[x.tid] >= day)) last[x.tid] = day;
  }
  return last;
}

const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
// Reuse is allowed (operator 2026-09-28: "drop this rule — just make sure not same article 2 days in a row"). This is
// not a rule, only the ranking: an article quoted d days ago counts 1 - 0.5^(d/7) of its score (half a week later, 3/4
// two weeks later), so the two best articles don't simply alternate forever.
export const REUSE_HALF_LIFE_DAYS = 7;
export const freshnessOf = (days) => (days == null ? 1 : 1 - 0.5 ** (Math.max(0, days) / REUSE_HALF_LIFE_DAYS));

/** PURE. The slot times, UTC ISO and in order, for `days` days from `from` (YYYY-MM-DD): `perDay` a day (both slots,
 *  or only the evergreen 16:30 one when `perDay` is 1). */
export function slotsOf(from, days = 7, perDay = PAGE?.perDay || PER_DAY) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from))) throw new Error(`--from must be YYYY-MM-DD (got ${JSON.stringify(from)})`);
  const d0 = Date.parse(`${from}T00:00:00Z`);
  const all = PAGE?.slots || SLOTS;   // PI: a page's own slot times (qrt-boxes.mjs cold.slots)
  const defs = perDay >= all.length ? all : all.slice(-perDay);
  return Array.from({ length: days }, (_, i) => defs.map((x) => {
    const t = new Date(d0 + i * 86400000);
    t.setUTCHours(x.utcHour, x.utcMinute, 0, 0);
    return t.toISOString().replace('.000Z', 'Z');
  })).flat();
}

/** PURE. The picks, a slot at a time from `from`, `perDay` a day (`n` slots in all). The one rule: never the same
 *  article twice in one day (operator 2026-09-29: "Each article can be QRTed as many times as you wish — and it doesn't
 *  matter if it's old"). Reuse is otherwise free, and only discounted in the ranking by how recently it ran, so the lanes
 *  don't loop the same two pieces. With two a day, the first slot is the NEW lane (published in the last NEW_DAYS as of
 *  that day, fastest first by views an hour, niche-weighted; the OLD pick when nothing is new) and the last is the OLD
 *  lane (the evergreen score), which the 2nd and 5th days give to the a16z network (partnerScoreOf). A partner slot
 *  with nothing eligible falls back to the OLD pick. `skip` drops tweet ids the operator swapped out; `pinned`
 *  ({ slotIndex: row }) keeps a slot's article as it is (a drafted slot, or a fresh swap). */
export const NEW_DAYS = 7;
// PI: `blocked` ({ 'YYYY-MM-DD|tid' }) holds what the page's group already quotes on each day (the boosters never quote
// one article on the same day).
export function pickSlate(rows, { used = {}, n = PER_WEEK, perDay = PER_DAY, skip = [], pinned = {}, from = new Date().toISOString().slice(0, 10), blocked = new Set() } = {}) {
  const skipped = new Set(skip.map(String));
  const pool = rows.map((r) => ({ r, fit: fitOf(r) }))
    .filter(({ r, fit }) => fit.ok && !skipped.has(r.tid))
    .map(({ r }) => r)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || b.views - a.views);
  const last = { ...used };
  const picks = [];
  for (let i = 0; i < n; i++) {
    const d = Math.floor(i / perDay);
    const day = new Date(Date.parse(`${from}T00:00:00Z`) + d * DAY).toISOString().slice(0, 10);
    if (pinned[i]) { picks.push(pinned[i]); last[pinned[i].tid] = day; continue; }
    const fresh = (r) => freshnessOf(last[r.tid] ? daysBetween(last[r.tid], day) : null);
    // Never twice in one day; a pinned slot later today counts too.
    const pinnedToday = new Set(Object.entries(pinned).filter(([k]) => Math.floor(k / perDay) === d).map(([, r]) => r.tid));
    const open = (r) => !pinnedToday.has(r.tid) && last[r.tid] !== day && !blocked.has(`${day}|${r.tid}`);
    const bestOf = (cands, score) => { let best = null, top = -1; for (const r of cands) { if (!open(r)) continue; const s = score(r) * fresh(r); if (s > top) { best = r; top = s; } } return best; };
    const k = i % perDay;
    const partnerSlot = !!PAGE?.partner && PARTNER_DAYS.has(d % 7) && k === perDay - 1; // PI: only a page with a partner network
    const newSlot = perDay > 1 && k === 0;
    const at = Date.parse(`${day}T12:00:00Z`);
    const isNew = (r) => { const t = Date.parse(r.published || ''); return Number.isFinite(t) && t <= at && at - t <= NEW_DAYS * DAY; };
    const best = (partnerSlot && bestOf(pool.filter(isPartner), (r) => partnerScoreOf(r, day)))
      || (newSlot && bestOf(pool.filter((r) => !isPartner(r) && isNew(r)), (r) => velocityOf(r, at)))
      || bestOf(pool.filter((r) => !isPartner(r)), scoreOf);
    if (!best) break;
    picks.push(best);
    last[best.tid] = day;
  }
  return { picks, pool };
}

// ─── Fresh articles ──────────────────────────────────────────────────────────────────────────────
// The scout (n8n-x-pipeline, article-scout.yml) runs daily at 11:20 Saigon and files every new X Article over the floor.
// `fresh` puts the fastest of them on the next open 15:30 slot instead of letting it wait for next week's pick, ranked
// by views per hour since it went up (niche-weighted), since an article is climbing hardest in its first two days.
export const FRESH_HOURS = 48;
export const FRESH_LEAD_HOURS = 2;
const HOUR = 3600000;

/** PURE. Views an hour since publishing, niche-weighted (0 without a publish time). */
export const velocityOf = (r, now = Date.now()) => {
  const t = Date.parse(r.published || '');
  if (!Number.isFinite(t)) return 0;
  return (r.views / Math.max(1, (now - t) / HOUR)) * nicheWeightOf(r.niche);
};

/** PURE. The fresh articles: fit for GTX, published in the last `hours`, never quoted by the lane, fastest first. */
export function freshPool(rows, { now = Date.now(), hours = FRESH_HOURS, quoted = new Set() } = {}) {
  return rows.filter((r) => fitOf(r).ok && !quoted.has(r.tid) && Number.isFinite(Date.parse(r.published)) && now - Date.parse(r.published) <= hours * HOUR && now >= Date.parse(r.published))
    .sort((a, b) => velocityOf(b, now) - velocityOf(a, now));
}

/** PURE. The next fresh slot a new article can take: a 15:30 slot at least `lead` hours away that has no draft yet and
 *  isn't already a fresh swap. Returns { file, index, slot } or null. `slates` is [{ file, slate }]. */
export function nextFreshSlot(slates, { now = Date.now(), lead = FRESH_LEAD_HOURS } = {}) {
  const open = [];
  for (const { file, slate } of slates) (slate.slots || []).forEach((slot, index) => {
    if (slotDefOf(slot.at, slot.lane).kind === 'new' && Date.parse(slot.at) - now >= lead * HOUR && !slot.draft && !slot.fresh) open.push({ file, index, slot });
  });
  return open.sort((a, b) => Date.parse(a.slot.at) - Date.parse(b.slot.at))[0] || null;
}

/** PURE. Whether an article may sit on `day` without breaking the rule (already quoted that same day, in any slate,
 *  ignoring the slot being replaced). */
export function placeable(slates, tid, day, { except = null } = {}) {
  for (const { slate } of slates) for (const s of slate.slots || []) {
    if (s === except || s.tid !== tid) continue;
    if (String(s.at).slice(0, 10) === day) return false;
  }
  return true;
}

/** PURE. An article's material in the package shape qrt-fill.mjs reads (`--piece`): the saver checks every claim and
 *  every quotation in the QRT against this body, word for word. */
export function materialOf(r) {
  const body = (r.body || r.preview || '').trim();
  return [
    '---', `source: ${r.url}`, `author: @${r.handle}`, `type: ${r.type || '?'}`, `views: ${r.views}`, `bookmarks: ${r.bookmarks}`, `published: ${r.published.slice(0, 10)}`, '---', '',
    `Tracked X Article by @${r.handle}, filed by cold-qrt.mjs from the Articles table. The body below is the article as the scout stored it.`,
    '', '# Article body', `# ${r.title}`, '', body, '',
  ].join('\n');
}

/** PURE. A cold QRT's copy against the lane's rules (the AIGuide_ numbers). Returns the reasons it fails. */
export function laneFails(text) {
  const t = String(text || '').trim();
  const out = [];
  if (!t) return ['no copy yet'];
  if (t.length < 20) out.push(`${t.length} chars: too thin to carry a reason`);
  if (t.length > 200) out.push(`${t.length} chars: over 200 (their long QRTs medianed 5.2K and none reached 20K)`);
  if (/https?:\/\//.test(t)) out.push('a link in the copy: the quoted article is the link');
  if (/[—–]/.test(t)) out.push('an em or en dash (house ban)');
  if (/#\w/.test(t)) out.push('a hashtag');
  if (/^\s*[-*•]\s|\n\s*[-*•]\s|\n\s*\d+[.)]\s/.test(t)) out.push('a list: give one reason, never the summary');
  if (RETIRED_SHAPES.includes(shapeOf(t))) out.push(`the ${shapeOf(t)} frame ("the most interesting part of …"), retired by the owner 2026-10-04`);
  return out;
}

// ─── Variety: the shape of the line ──────────────────────────────────────────────────────────────
// The operator, 2026-09-29: "Why is all our Cold QRTs now 'if you are..., do XYZ' structure? What happened to the
// choose and diversity?" The old auto-pass rule (the AIGuide formula) rewarded one opening, "if you [...], read this", and the cold lane
// had no variety rule of its own (the rubric's family rotation only ran for promo and bridge QRTs), so 8 of 12 lines
// opened the same way. AIGuide's own winners use several shapes, and a timeline of one shape reads as a bot. So every
// line has a shape, `pick` hands each slot one to write to (rotating, never the neighbour's), and `check` fails a line
// that repeats the shape of the cold slot before or after it, or takes more than a third of the week.
export const SHAPES = Object.freeze({
  beg: 'im begging you to read this: + one pulled line (O3)',
  must: 'MUST READ / "If you\'re going to read anything today, read this" (O4, O5)',
  quote: 'the pulled line first, then the ask ("read this one slowly")',
  internalize: 'everyone should internalize this / read it, bookmark it, read it again / + what it unlocks (O12)',
  who: 'if you [are / want / keep …], read this (the AIGuide opener)',
  // RETIRED with T130 (owner, 2026-10-04, on peak's "the most interesting aspect of this is the mirror…": "I also don't
  // like this qrt format either, i don't think it would work"). Out of SHAPE_ORDER, so no slot is ever handed it, and
  // laneFails fails a line written in it. Kept here so shapeOf still names it.
  insight: 'the most interesting part of [X] is [the non-obvious point in the article] (T130) · RETIRED 2026-10-04',
  question: 'one of the most [unsettling / important] questions in [field]: [the article\'s question]? (T094; needs your Approve)',
});
export const SHAPE_ORDER = Object.freeze(['who', 'quote', 'beg', 'must', 'internalize', 'question']);
/** Shapes no slot is handed and no line may take (see SHAPES). */
export const RETIRED_SHAPES = Object.freeze(['insight']);
export const MAX_SHAPE_SHARE = 1 / 3;

/** PURE. The shape of a line, read off its opening. */
export function shapeOf(text) {
  const t = String(text || '').trim().replace(/[’‘]/g, "'");
  const first = t.split('\n')[0].trim();
  if (!t) return null;
  if (/^["“]/.test(first)) return 'quote';
  if (/^i'?m begging you/i.test(first)) return 'beg';
  if (/^(must\b|this is a must read|if you're going to read anything)/i.test(first)) return 'must';
  if (/^(everyone|every \w+) should (internalize|read|study)|internalize this/i.test(first)) return 'internalize';
  if (/^(the (most interesting|best|real|scariest|quietest) (part|aspect|point|idea|thing))/i.test(first)) return 'insight';
  if (/\?\s*$/.test(first) || /questions? (in|about|of)\b/i.test(first)) return 'question';
  if (/^(if you|if you're|if you've|for anyone|anyone who|for every)\b/i.test(first)) return 'who';
  return 'other';
}

/** PURE. Why a slot's line breaks the variety rule inside its slate: the same shape as the cold slot right before or
 *  after it, or its shape over a third of the slate's written lines. */
export function shapeFails(slots, slot) {
  const shape = shapeOf(slot.text);
  if (!shape || shape === 'other') return [];
  const byTime = [...slots].filter((x) => x.text).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const i = byTime.indexOf(slot);
  const out = [];
  const near = [byTime[i - 1], byTime[i + 1]].filter(Boolean).filter((x) => shapeOf(x.text) === shape);
  if (near.length) out.push(`the same "${shape}" opening as the cold QRT ${near.map((x) => x.at.slice(0, 16).replace('T', ' ')).join(' and ')}Z`);
  const same = byTime.filter((x) => shapeOf(x.text) === shape).length;
  const cap = Math.max(2, Math.ceil(byTime.length * MAX_SHAPE_SHARE));
  if (same > cap) out.push(`${same} of ${byTime.length} lines this week open "${shape}" (at most ${cap})`);
  return out;
}

/** PURE. A shape for each slot still to be written: the next in SHAPE_ORDER that neither written neighbour has and the
 *  week has least of. Written slots keep theirs. Returns the slots with `shape` set. */
export function planShapes(slots) {
  const byTime = [...slots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const count = Object.fromEntries(SHAPE_ORDER.map((k) => [k, 0]));
  for (const x of byTime) { const k = shapeOf(x.text); if (k in count) count[k]++; }
  const shapeAt = (x) => (x ? (x.text ? shapeOf(x.text) : x.shape) : null);
  byTime.forEach((x, i) => {
    if (x.text) { x.shape = shapeOf(x.text); return; }
    const avoid = new Set([shapeAt(byTime[i - 1]), shapeAt(byTime[i + 1])]);
    // The auto-passable shapes first; question (which asserts something) only when the rest are used up. insight is retired.
    const pickable = SHAPE_ORDER.filter((k) => !avoid.has(k));
    x.shape = pickable.sort((a, b) => count[a] - count[b] || SHAPE_ORDER.indexOf(a) - SHAPE_ORDER.indexOf(b))[0];
    count[x.shape]++;
  });
  return slots;
}

// ─── Variety across the whole shortlist: the rubric's templates, rotated by family ──────────────────────────────
// The operator, 2026-09-29: "from our entire QRT shortlist — how can we ensure diversity and cross coverage … The AIGuide
// is a case study, but it shouldn't prevent us from also using other ones that score high … these QRT are structures so
// we can use them flexibly." The seven openings above all came from one study, and three of them (who, beg, must) are
// the same Must-Read family. So each slot now gets a TEMPLATE from the full catalog (learnings/qrt/catalog.json, 11
// families), ranked by the rubric (qrt-pick.mjs: fit 45, proof 35, saves 20) for an Article quoted from another creator.
// The article's backs (a quote, figures, a list) come from its body. A template is a structure: the line is written to
// it in the chat, loosely, in the house voice.
//
// The plan, per week (`planTemplates`):
//   - Coverage first: a family the week hasn't used yet gets COVERAGE_BONUS, so the week spreads across families.
//   - Never the family of the cold QRT right before or after, and no family over FAMILY_SHARE of the week.
//   - Never a template already used on that article (rule 1, across every slate and run), nor one the lane used in
//     the last TEMPLATE_COOLDOWN_DAYS.
//   - A template under MIN_TEMPLATE_SCORE is never planned.
// Each slot keeps its top 3 (different families) as options, each with its donor post.
export const MIN_TEMPLATE_SCORE = 0.35;
export const COVERAGE_BONUS = 0.15;
export const FAMILY_SHARE = 0.25;
export const TEMPLATE_COOLDOWN_DAYS = 7;
// PI: a group's pages (the boosters) post their cold QRTs minutes apart, so a template another page of the group planned
// within GROUP_TEMPLATE_HOURS of a slot is out for it too: on 2026-10-04 the five boosters, all new to the lane, ranked
// the catalog the same way and took the same three frames, six minutes apart.
export const GROUP_TEMPLATE_HOURS = 24;
// A written line without a planned template, read into a family by its opening (the lines from before the planner).
// Out of the cold lane: a first-person story would be an invented experience in GTX's mouth, and a "posted N minutes
// ago, already N likes" line only works on a post that is minutes old (the a16z ASAP slots and fresh swaps can use it).
/** PURE. Why a catalog template can't go on this cold slot, or null. */
export function coldGateOf(t, slot) {
  if (NOTE_FRAMES.includes(t.id)) return 'its skeleton carries a format note the structure score reads as words';
  if (t.family === 'Personal Story') return 'a first-person story: the page has no such experience to tell';
  const young = slot.asap || slot.fresh || (slot.published && Date.parse(slot.at) - Date.parse(slot.published) < 24 * 36e5);
  if (/posted \[N\] (minutes|hours) ago/i.test(t.skeleton || '') && !young) return 'a "posted N minutes ago" line on an article that is not new';
  return null;
}

export const SHAPE_FAMILY = Object.freeze({ who: 'Must-Read', beg: 'Must-Read', must: 'Must-Read', internalize: 'Authority Frame', quote: 'Context Add', insight: 'Context Add', question: 'Curiosity Gap' });

/** PURE. What an article can back in a QRT (the rubric's step 1): a pulled quote, figures, a list, and its story. */
export function articleBacksOf(slot, body) {
  const st = structureOf(body);
  const has = ['story'];
  if ((slot.quotes || []).length || /["“][^"”\n]{25,}["”]/.test(String(body || ''))) has.push('quote');
  if (st.figures >= 1 || /\d/.test(String(slot.title || ''))) has.push('number');
  if (st.named >= 3 || st.numbered >= 3) has.push('list');
  return has;
}

/** PURE. A slot's family: its planned template's, else its written line's opening. */
export function familyOf(slot, catalog = null) {
  if (slot.family) return slot.family;
  const t = slot.template && catalog?.templates?.find((x) => x.id === slot.template);
  if (t) return t.family;
  return slot.text ? SHAPE_FAMILY[shapeOf(slot.text)] || null : null;
}

/** PURE. Plan a template for every unwritten slot, by time. `bodyOf(slot)` is the article body; `usedOn(slot)` is the
 *  set of templates already on that article; `recent` is [{ id, at }] of templates the lane used before this slate;
 *  `groupUses` is [{ id, at }] of the templates the page's group (its other pages' slates) planned. */
export function planTemplates(slots, { catalog, bodyOf = () => '', usedOn = () => new Set(), recent = [], groupUses = [] }) {
  const byTime = [...slots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const count = {};
  for (const x of byTime) if (x.text) { const f = familyOf(x, catalog); if (f) count[f] = (count[f] || 0) + 1; }
  const cap = Math.max(2, Math.ceil(byTime.length * FAMILY_SHARE));
  const planned = [...recent];
  byTime.forEach((x, i) => {
    if (x.text) { x.family = familyOf(x, catalog); if (x.template) planned.push({ id: x.template, at: x.at }); return; }
    const near = new Set([byTime[i - 1], byTime[i + 1]].filter(Boolean).map((y) => familyOf(y, catalog)).filter(Boolean));
    const cooling = new Set([...planned.filter((u) => Math.abs(Date.parse(x.at) - Date.parse(u.at)) < TEMPLATE_COOLDOWN_DAYS * 864e5),
      ...groupUses.filter((u) => Math.abs(Date.parse(x.at) - Date.parse(u.at)) < GROUP_TEMPLATE_HOURS * 36e5)].map((u) => u.id));
    const used = usedOn(x);
    const { ranked } = rubricPick(catalog, { kind: 'article', whose: 'other', has: articleBacksOf(x, bodyOf(x)), used });
    const ok = ranked.filter((c) => c.s.total >= MIN_TEMPLATE_SCORE && !cooling.has(c.t.id) && !used.has(c.t.id) && !c.t.retired && !coldGateOf(c.t, x));
    const scoreOf = (c) => c.s.total + (count[c.t.family] ? 0 : COVERAGE_BONUS);
    const fits = (c) => !near.has(c.t.family) && (count[c.t.family] || 0) < cap;
    const pool = (ok.some(fits) ? ok.filter(fits) : ok).sort((a, b) => scoreOf(b) - scoreOf(a));
    if (!pool.length) return;
    const top = pool[0];
    const opts = [top, ...pool.filter((c) => c.t.family !== top.t.family).filter((c, k, arr) => arr.findIndex((d) => d.t.family === c.t.family) === k).slice(0, 2)];
    x.template = top.t.id;
    x.family = top.t.family;
    x.templates = opts.map((c) => ({ id: c.t.id, family: c.t.family, score: +c.s.total.toFixed(3), skeleton: c.t.skeleton, donor: c.t.donor?.url || null }));
    count[top.t.family] = (count[top.t.family] || 0) + 1;
    planned.push({ id: top.t.id, at: x.at });
  });
  return slots;
}

/** PURE. Why a slot's family breaks the plan inside its slate: the family of the cold QRT right before or after it,
 *  or its family over FAMILY_SHARE of the week's written lines. */
export function familyFails(slots, slot, catalog = null) {
  const fam = familyOf(slot, catalog);
  if (!fam || !slot.text) return [];
  const byTime = [...slots].filter((x) => x.text).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const i = byTime.indexOf(slot);
  const out = [];
  const near = [byTime[i - 1], byTime[i + 1]].filter(Boolean).filter((x) => familyOf(x, catalog) === fam);
  if (near.length) out.push(`the same family (${fam}) as the cold QRT ${near.map((x) => x.at.slice(0, 16).replace('T', ' ')).join(' and ')}Z`);
  const same = byTime.filter((x) => familyOf(x, catalog) === fam).length;
  const cap = Math.max(2, Math.ceil(byTime.length * FAMILY_SHARE));
  if (same > cap) out.push(`${same} of ${byTime.length} lines this week are ${fam} (at most ${cap})`);
  return out;
}

// ─── Visuals: one diagram of the article's big idea, only where it earns it ──────────────────────
// The operator, 2026-09-29: "we should add in visual engine where we think it's highly needed to summarize and
// visualize a big idea from the article." The AIGuide study says media usually costs a QRT (image QRTs medianed 5.7K;
// all eight of their 100K+ QRTs had none), so a visual is the exception, not a default. It goes only where the article's
// big idea IS a structure a picture carries better than a line: named levels, layers or steps, a numbered model, or a
// run of figures. It is typed for it (a framework, market analysis, explainer or prediction), and it is capped at
// VISUALS_PER_WEEK, at most one a day, so the lane can compare them against its text-only lines.
//
// The picture is a house chart in the article register (chart-shot.mjs), or for an idea with no numbers the engraved
// diagram (cover-gen.mjs --diagram), both square (VISUAL_SIZE).
// Its labels are words from the article. The scene line is written in the chat, like all copy, and a slot with a
// visual never auto-passes: an image asserts things the saver cannot read, so it waits for the operator's Approve.
export const VISUAL_TYPES = new Set(['Framework', 'Market Analysis', 'Explainer', 'Prediction']);
export const VISUALS_PER_WEEK = 2;
// Square (operator 2026-09-29: "for Cold QRT visual, let's have them as square proportion instead of horizontal").
export const VISUAL_SIZE = Object.freeze({ width: 1200, height: 1200, aspect: '1:1' });
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|\\d+';

/** PURE. The structure in an article body a diagram could carry: named levels/layers/steps, numbered items, figures. */
export function structureOf(body) {
  const t = String(body || '');
  const named = new Set([...t.matchAll(new RegExp(`\\b(level|layer|stage|step|phase|tier|rule|law|principle|pillar)\\s+(${NUMBER_WORDS})\\b`, 'gi'))].map((m) => `${m[1]} ${m[2]}`.toLowerCase()));
  const numbered = (t.match(/^\s*\d+[.)]\s+\S/gm) || []).length;
  const figures = (t.match(/\$\d|\d[\d,.]*\s?(%|percent|billion|million|trillion|x\b)/gi) || []).length;
  return { named: named.size, numbered, figures, score: named.size * 2 + Math.min(numbered, 10) + Math.min(figures, 12) / 2 };
}

/** PURE. Whether a slot's article earns a visual: its type, and a structure a picture carries. */
export function visualFitOf(slot, body) {
  const st = structureOf(body);
  const why = [];
  if (st.named >= 3) why.push(`${st.named} named levels, layers or steps`);
  if (st.numbered >= 3) why.push(`a numbered model (${st.numbered} items)`);
  if (st.figures >= 6) why.push(`${st.figures} figures`);
  // A partner (a16z) slot has no content type in the tracker: judge it on its structure alone.
  if (slot.type && slot.type !== 'a16z' && !VISUAL_TYPES.has(slot.type)) return { fit: false, score: 0, why: [`a ${slot.type || 'untyped'} piece: the line carries it`] };
  return { fit: why.length > 0, score: why.length ? st.score : 0, why: why.length ? why : ['no structure a picture carries better than a line'] };
}

/** PURE. Mark the slots that should carry a visual: the best-fitting unposted ones, at most one a day and
 *  VISUALS_PER_WEEK a slate (slots that already have one count). `bodyOf(slot)` gives the article body. */
export function planVisuals(slots, bodyOf, { now = 0 } = {}) {
  const have = slots.filter((x) => x.media);
  const days = new Set(have.map((x) => x.at.slice(0, 10)));
  const open = slots.filter((x) => !x.media && Date.parse(x.at) > now)
    .map((x) => ({ x, f: visualFitOf(x, bodyOf(x)) })).filter((c) => c.f.fit).sort((a, b) => b.f.score - a.f.score);
  for (const x of slots) if (!x.media) delete x.visual;
  let n = have.length;
  for (const { x, f } of open) {
    if (n >= VISUALS_PER_WEEK) break;
    if (days.has(x.at.slice(0, 10))) continue;
    x.visual = { suggested: true, why: f.why };
    days.add(x.at.slice(0, 10));
    n++;
  }
  return slots;
}

// ─── The a16z fast lane ─────────────────────────────────────────────────────────────────────────
// The operator, 2026-09-29: "A16Z clients's articles —> QT and fire asap." docs/a16z-qt-playbook.md: the firm's own
// first QT lands a median 19 minutes after a partner's article and the outsider peak runs 6–24 hours, so waiting for
// the weekly pick or the daily scout misses it. `a16z` searches the whole network (Users {a16z Network}, and anything
// @a16z quotes, which finds the third of pushed pieces the roster lacks) for X Articles from the last few hours, and
// puts each new one on an ASAP slot 20 minutes out, with its key quotes mined. It then runs like any slot: the line
// is written in the chat, `check` (a low-risk line auto-passes), `draft`, `schedule`, which moves an ASAP slot whose
// time has gone by to 5 minutes out.
export const A16Z_HOURS = 6;
// The routine runs hourly from 15:00 to 01:00 ICT (operator 2026-09-29: "only check for a16z-network articles between
// 3pm - 1am Vietnam time — most don't post outside the window"). The first run of the day looks back to 01:00 ICT, so
// the rare overnight piece is still caught.
export const A16Z_WINDOW_ICT = Object.freeze([15, 1]);
/** PURE. The look-back for a run at `now`: back to 01:00 ICT on the day's first run, else A16Z_HOURS. */
export const a16zHoursAt = (now = Date.now()) => { const h = new Date(now + 7 * 36e5).getUTCHours(); return h === A16Z_WINDOW_ICT[0] ? Math.max(A16Z_HOURS, h - A16Z_WINDOW_ICT[1] + 1) : A16Z_HOURS; };
export const ASAP_LEAD_MIN = 20;
/** PURE. The ASAP time for a new slot: `lead` minutes from `now`, on the next 5-minute mark, UTC ISO. */
export const asapAt = (now = Date.now(), lead = ASAP_LEAD_MIN) => new Date(Math.ceil((now + lead * 60000) / 300000) * 300000).toISOString().replace('.000Z', 'Z');

/** PURE. Every X Article in a twitter241 payload, from a post that is one or a post it quotes:
 *  [{ tid, handle, title, created, views, quotedBy }]. */
export function articlesIn(payload) {
  const out = new Map();
  const author = (t) => t?.core?.user_results?.result?.core?.screen_name || t?.core?.user_results?.result?.legacy?.screen_name || null;
  const visit = (t, quotedBy = null) => {
    if (!t || typeof t !== 'object') return;
    const tw = t.tweet || t;
    const art = tw.article?.article_results?.result;
    if (art && tw.rest_id && !out.has(tw.rest_id)) out.set(tw.rest_id, { tid: tw.rest_id, handle: author(tw), title: art.title || '', created: tw.legacy?.created_at ? new Date(tw.legacy.created_at).toISOString() : null, views: Number(tw.views?.count || 0), quotedBy });
    const q = tw.quoted_status_result?.result;
    if (q) visit(q, author(tw));
  };
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (o.rest_id && o.legacy) visit(o); for (const v of Object.values(o)) walk(v); };
  walk(payload);
  return [...out.values()];
}

// ─── Auto-pass: a proven structure, kept ────────────────────────────────────────────────────────
// The operator, 2026-09-29: "QRT that are low risk (high score of following structure — should auto pass)". Then, after
// the saver had cut "This article should have 100M views." and "MUST … MUST READ" on support and honesty and the lanes
// filled up with TL;DRs: "I don't think the honesty or support is that important … Overselling and unsupported claims
// are okay … This is more about just getting the structure with high confidence … If there's the underlying structure,
// then I have the certainty, and you have the certainty that it would perform well."
//
// So a line auto-passes on structure, not on anyone's reading of it: its planned template has a proven record on
// articles (AUTO.proven), the line keeps that template's frame almost exactly (AUTO.structure), and it clears the hard
// stops (no quote put in someone's mouth, the house bans) and the lane rules, with no visual. Anything else waits for
// the operator's Approve in the batch.
export const AUTO = Object.freeze({ structure: 0.9, proven: 0.4 });

/** PURE. Whether a checked line auto-passes: { ok, why }. */
export function autoPassOf({ text, template = null, structure = null, proven = null, media = false }) {
  const why = [];
  // A meme from the template's own donors (qrt-meme.mjs) is part of the proven structure, not a visual we made.
  if (media && media !== 'meme' && media?.kind !== 'meme') why.push('carries a visual: needs your Approve');
  if (!template) why.push('no planned template, so its structure can\'t be measured');
  else {
    if (!(structure >= AUTO.structure)) why.push(`structure ${structure ?? '?'} < ${AUTO.structure}: keep ${template}'s frame closer`);
    if (!(proven >= AUTO.proven)) why.push(`${template}'s record on articles is ${proven ?? '?'} (< ${AUTO.proven})`);
  }
  why.push(...laneFails(text));
  return { ok: !why.length, why };
}

/** PURE. The saver's numbers from its one-line verdict ("PASS 0.67 · supported 0.74 · … · honest 0.85"). */
export const saverAnswersOf = (line) => Object.fromEntries([...String(line || '').matchAll(/(supported|shape|stop|click|honest) ([0-9.]+)/g)].map((m) => [m[1], +m[2]]));

// ─── Spacing ─────────────────────────────────────────────────────────────────────────────────────
// The operator, 2026-09-29: "remember to space the posts — i see like 6 posts on saturday". Two cold slots a day on
// top of a hub, a thread, a second article and the promo QRTs put six GTX posts inside 14:00–18:00, half an hour
// apart. `space` keeps every other post where it is and moves only the cold ones: to the time in the operator's window
// farthest from everything else, at least MIN_GAP_MIN away, and when the window is full, into the evening band.
export const MIN_GAP_MIN = 45;
export const WINDOWS = Object.freeze([['14:00', '18:00'], ['19:00', '22:00']]); // Saigon; the second only when the first is full
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** PURE. A day's times for the cold slots: `fixed` are the day's other posts (UTC ms), `n` cold slots to place, `day`
 *  YYYY-MM-DD. Candidates are every 15 minutes inside the windows; each slot takes the one farthest from everything
 *  placed so far, preferring the first window, and never closer than `gap` minutes unless nothing is left
 *  (then `crowded`). Returns [{ at, crowded }]. */
export function placeDay(fixed, n, day, { gap = MIN_GAP_MIN, windows = WINDOWS, now = 0 } = {}) {
  const base = Date.parse(`${day}T00:00:00Z`) - 7 * HOUR; // Saigon midnight in UTC
  const taken = [...fixed];
  const out = [];
  for (let k = 0; k < n; k++) {
    let best = null;
    windows.forEach(([a, b], w) => {
      for (let m = minutesOf(a); m <= minutesOf(b); m += 15) {
        const t = base + m * 60000;
        if (t <= now) continue;
        const dist = taken.length ? Math.min(...taken.map((x) => Math.abs(x - t))) / 60000 : Infinity;
        const ok = dist >= gap;
        // First fit: a clear time in an earlier window beats anything later; then the most room.
        const rank = [ok ? 0 : 1, ok ? w : 0, -Math.min(dist, 600)];
        const better = !best || rank.findIndex((v, i) => v !== best.rank[i]) === -1 ? false : rank[rank.findIndex((v, i) => v !== best.rank[i])] < best.rank[rank.findIndex((v, i) => v !== best.rank[i])];
        if (!best || better) best = { t, rank, ok };
      }
    });
    if (!best) break;
    taken.push(best.t);
    out.push({ at: new Date(best.t).toISOString().replace('.000Z', 'Z'), crowded: !best.ok });
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

// ─── The batch ───────────────────────────────────────────────────────────────────────────────────
/** PURE. The run piece key of a slot. */
// The 16:30 slot keeps the key it had when the lane ran once a day; any other slot adds its Saigon time.
export const saigonOf = (at) => { const d = new Date(Date.parse(at) + 7 * HOUR); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
export const pieceKeyOf = (slot) => { if (slot.key) return slot.key; const d = new Date(slot.at); const onSlot = [SLOT, LEGACY_SLOTS[1]].some((x) => d.getUTCHours() === x.utcHour && d.getUTCMinutes() === x.utcMinute); return onSlot ? `cold-${slot.at.slice(0, 10)}` : `cold-${slot.at.slice(0, 10)}-${saigonOf(slot.at).replace(':', '')}`; };

/** PURE. A slot's X post for Typefully: the line, the quoted article, and its visual when it has one. */
export const postOf = (s) => ({ text: String(s.text || '').trim(), quote_post_url: s.url, ...(s.media?.id ? { media_ids: [s.media.id] } : {}) });

// ─── Approval (PI) ───────────────────────────────────────────────────────────────────────────────
// Genius files every drafted slot into its run's Notion batch and reads the operator's Approve back from the run. PI has
// no such batch for QRTs yet, so the owner's approval lives on the slot: `approve` records their words with the exact line
// (and media) they approved. A later rewrite needs a new approval, like Genius's re-review of a rewritten piece.
// A meme from the template's own donors is part of the proven structure (qrt-meme.mjs), and `draft` attaches it after
// the approval, so only media we made (a visual) is part of what the owner approved.
const madeMediaOf = (slot) => (slot.media && slot.media.kind !== 'meme' ? slot.media.id || null : null);

/** PURE. Whether a slot may be scheduled: it auto-passed (autoPassOf), or the owner approved this exact line. */
export function approvedIn(slot) {
  if (slot.check?.pass && slot.check?.auto?.ok) return { ok: true, auto: true };
  if (!slot.check?.pass) return { ok: false, why: 'its check has not passed (cold-qrt.mjs check)' };
  const a = slot.approved;
  if (!a?.words) return { ok: false, why: 'waiting on the owner\'s approval (cold-qrt.mjs approve --slate … --slot <at> --words "<their words>")' };
  if (a.text !== String(slot.text || '').trim() || (a.media || null) !== madeMediaOf(slot)) return { ok: false, why: 'the owner approved an earlier version of this line: approve the new one' };
  return { ok: true };
}

/** PURE. The owner's approval of a slot as `approve` records it. */
export const approvalOf = (slot, words, at = new Date().toISOString()) => ({ by: 'owner', words: String(words), at, text: String(slot.text || '').trim(), media: madeMediaOf(slot) });

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const USAGE = 'usage: node cold-qrt.mjs pick --account <page> --from YYYY-MM-DD [--skip <tid,…>] [--show N] | fresh --account <page> [--apply] | plan|check|draft|schedule --slate qrts/cold/<page>/W<date>.json [--dry] | approve --slate <file> --slot <at|all> --words "<owner\'s words>" | space --slate <file> [--apply]';
const writeJson = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const slateFilesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^W\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => path.join(dir, f)) : []);
const slateFiles = () => slateFilesIn(PAGE.dir);
/** PURE. PI: `t` (ms) moved forward, a minute at a time, until it is `gapMin` from every time in `booked` (slots.mjs
 *  MIN_SLOT_GAP_MIN: two posts booked closer can publish in the same minute). */
export function clearOf(t, booked = [], gapMin = 5) {
  let x = Math.ceil(t / 60000) * 60000;
  for (let i = 0; i < 120 && booked.some((b) => Math.abs(b - x) < gapMin * 60000); i++) x += 60000;
  return x;
}
/** PI: every scheduled minute on the fleet's posting pages (run-occupancy.mjs postingAccounts), for a group page. */
async function fleetMinutes(tf) {
  const { postingAccounts } = await import('./scripts/run-occupancy.mjs');
  const out = [];
  for (const { socialSetId } of postingAccounts()) for (const d of await tf.listAll(`/social-sets/${socialSetId}/drafts?status=scheduled`)) {
    const t = Date.parse(d.scheduled_date || d.publish_at || ''); if (Number.isFinite(t)) out.push(t);
  }
  return out;
}
/** PI: what the page's group (the boosters) already quotes, day by day: { 'YYYY-MM-DD|tid' } from the other pages' slates. */
export function groupBlocked(slates = []) {
  const out = new Set();
  for (const s of slates) for (const x of s.slots || []) if (x.tid && x.at) out.add(`${String(x.at).slice(0, 10)}|${x.tid}`);
  return out;
}
const groupSlates = () => (PAGE.group ? coldPages().filter((k) => k !== PAGE.key && boxOf(k).qrt.cold.group === PAGE.group)
  .flatMap((k) => slateFilesIn(path.join(DIR, k))).map(readJson) : []);

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const DRY = argv.includes('--dry');
  // PI: every command works for one page, named with --account or read off the slate; usePage refuses a page whose cold
  // lane is off (qrt-boxes.mjs), which is every page until the owner's spec turns one on.
  const slateArg = arg('--slate');
  const account = arg('--account') || (slateArg && fs.existsSync(slateArg) ? readJson(slateArg).account : null);
  if (!account) { console.error(USAGE); process.exit(1); }
  usePage(account);
  const { loadEnv, requireEnv, airtable, typefully } = await import('./lib.mjs');
  const env = loadEnv();
  // The rubric's context for the template planner: the catalog, every template already on an article (runs and
  // slates), and what the lane used lately.
  const { loadCatalog, loadRuns: loadAllRuns, usedOn: usedOnRuns } = await import('./qrt-pick.mjs');
  const bodyAt = (x) => (x.material && fs.existsSync(path.join(HERE, x.material)) ? fs.readFileSync(path.join(HERE, x.material), 'utf8') : '');
  const tctx = (() => {
    const catalog = loadCatalog();
    const runs = loadAllRuns();
    const uses = slateFiles().map(readJson).flatMap((sl) => (sl.slots || []).filter((x) => x.template && x.url).map((x) => ({ url: x.url, id: x.template, at: x.at })));
    const usedOn = (x) => new Set([...usedOnRuns(runs, [x.url, x.tid].filter(Boolean)), ...uses.filter((u) => u.url === x.url && u.at !== x.at).map((u) => u.id)]);
    const recentOf = (slots) => uses.filter((u) => !slots.some((y) => y.at === u.at && y.url === u.url)).map(({ id, at }) => ({ id, at }));
    const groupUses = groupSlates().flatMap((sl) => (sl.slots || []).filter((x) => x.template && x.at).map((x) => ({ id: x.template, at: x.at })));
    return { catalog, plan: (slots) => planTemplates(slots, { catalog, bodyOf: bodyAt, usedOn, recent: recentOf(slots), groupUses }) };
  })();

  if (cmd === 'pick') {
    requireEnv(env, ['AIRTABLE_PAT']);
    const from = arg('--from');
    const days = Number(arg('--days', 7));
    const file = path.join(PAGE.dir,`W${from}.json`);
    const others = slateFiles().filter((f) => path.resolve(f) !== path.resolve(file)).map(readJson);
    const used = usedOf(others, from);
    const at = airtable(env, env.XDB_BASE_ID || 'app7vXbBugWeCGctD');
    const rows = (await at.listAll(ARTICLES, {})).map((x) => rowOf(x.fields));
    const times = slotsOf(from, days);
    // A re-pick keeps every slot that is drafted or holds a fresh swap exactly as it is (pinned), and the copy of any
    // other slot whose article survived it.
    const prev = fs.existsSync(file) ? readJson(file) : null;
    const prevAt = new Map((prev?.slots || []).map((x) => [x.at, x]));
    const byTid = new Map(rows.map((r) => [r.tid, r]));
    const pinned = {};
    times.forEach((t, i) => { const x = prevAt.get(t); if (x && (x.draft || x.fresh)) pinned[i] = byTid.get(x.tid) || { tid: x.tid, handle: x.handle, title: x.title, url: x.url, views: x.views, bookmarks: x.bookmarks, type: x.type, niche: x.niche, floor: x.floor, published: '', body: '' }; });
    const { picks, pool } = pickSlate(rows, { used, n: times.length, from, pinned, perDay: PAGE.perDay || PER_DAY, blocked: groupBlocked(groupSlates()), skip: String(arg('--skip', '')).split(',').filter(Boolean) });
    const kept = new Map((prev?.slots || []).map((x) => [`${x.at}|${x.tid}`, x]));
    fs.mkdirSync(path.join(PAGE.dir,'articles'), { recursive: true });
    const slots = picks.map((r, i) => {
      const k = kept.get(`${times[i]}|${r.tid}`) || {};
      if (pinned[i]) return k;
      const material = path.relative(HERE, path.join(PAGE.dir,'articles', `${r.tid}.md`));
      fs.writeFileSync(path.join(HERE, material), materialOf(r));
      // Quoted before (an earlier day this week or an earlier week): the writer owes it a new line, not a repeat.
      const lastQuoted = [...Object.entries(used), ...picks.slice(0, i).map((p, j) => [p.tid, times[j].slice(0, 10)])]
        .filter(([t]) => t === r.tid).map(([, d]) => d).sort().pop() || null;
      return { at: times[i], saigon: slotDefOf(times[i]).saigon, lane: slotDefOf(times[i]).kind, tid: r.tid, url: r.url, handle: r.handle, title: r.title, type: r.type,
        niche: r.niche, floor: r.floor, views: r.views, bookmarks: r.bookmarks, score: +scoreOf(r).toFixed(4), lastQuoted, material,
        quotes: keyQuotesOf(r.body || '', { n: 3 }).map((q) => q.text),
        text: k.text || '', why: k.why || '', check: k.check || null, draft: k.draft || null };
    });
    planShapes(slots);
    tctx.plan(slots);
    if (PAGE.visuals) planVisuals(slots, (x) => byTid.get(x.tid)?.body || ''); // PI: no page has visuals yet
    writeJson(file, { lane: 'cold-qrt', account: PAGE.key, week: from, slot: (PAGE.slots || SLOTS).map((x) => `${x.saigon} (${x.kind})`).join(' + ') + ' Saigon daily', slots });
    console.log(`${path.relative(HERE, file)} · ${slots.length} of ${times.length} slots · ${pool.length} articles eligible · ${Object.keys(used).length} quoted before${Object.keys(pinned).length ? ` · ${Object.keys(pinned).length} kept as they were` : ''}`);
    for (const x of slots) console.log(`  ${x.at.slice(0, 10)} ${x.saigon}  @${String(x.handle).padEnd(16)} ${(x.views / 1e6).toFixed(2)}M · ${x.bookmarks} bm · ${x.type} · ${x.niche || '?'}${x.floor === PARTNER_TIER ? ' · a16z' : ''}${x.fresh ? ' · fresh' : ''} · ${x.title}${x.lastQuoted ? `  (last quoted ${x.lastQuoted}: write a new line)` : ''}\n      ${x.template ? `template: ${x.template} (${x.family}) · ${(x.templates?.[0]?.skeleton || '').replace(/\n+/g, ' / ').slice(0, 90)}` : `shape: ${x.shape} · ${SHAPES[x.shape] || ''}`}${x.visual ? `\n      visual: yes (${x.visual.why.join('; ')})` : ''}`);
    const show = Number(arg('--show', 0));
    if (show) {
      console.log('\nalternates (swap with --skip <tid>):');
      for (const r of pool.filter((r) => !picks.includes(r)).slice(0, show)) console.log(`  ${r.tid}  @${r.handle.padEnd(16)} ${(r.views / 1e6).toFixed(1)}M · ${r.bookmarks} bm · ${r.type} · ${r.title}`);
    }
    return;
  }

  if (cmd === 'fresh') {
    // The newest articles the scout filed, onto the next open 15:30 slot. Dry by default; --apply writes the swap.
    requireEnv(env, ['AIRTABLE_PAT']);
    const now = Date.now();
    const hours = Number(arg('--hours', FRESH_HOURS));
    const slates = slateFiles().map((f) => ({ file: f, slate: readJson(f) }));
    const quoted = new Set(slates.flatMap(({ slate }) => (slate.slots || []).map((x) => x.tid)));
    const at = airtable(env, env.XDB_BASE_ID || 'app7vXbBugWeCGctD');
    const rows = (await at.listAll(ARTICLES, {})).map((x) => rowOf(x.fields));
    const cands = freshPool(rows, { now, hours, quoted });
    const target = nextFreshSlot(slates, { now });
    console.log(`${cands.length} fresh article(s) from the last ${hours}h, never quoted by the lane:`);
    for (const r of cands.slice(0, 8)) console.log(`  ${r.tid}  @${r.handle.padEnd(16)} ${Math.round(velocityOf(r, now)).toLocaleString('en-US')} views/h · ${(r.views / 1e3).toFixed(0)}K · ${r.bookmarks} bm · ${r.type} · ${r.niche || '?'} · ${Math.round((now - Date.parse(r.published)) / 3600000)}h old · ${r.title}`);
    if (!target) { console.log('\nno open 15:30 slot ahead (pick the next week first: cold-qrt.mjs pick --from <monday>)'); return; }
    const day = target.slot.at.slice(0, 10);
    const pickR = cands.find((r) => placeable(slates, r.tid, day, { except: target.slot }));
    console.log(`\nnext open fresh slot: ${target.slot.at} (${slotDefOf(target.slot.at).saigon} Saigon) in ${path.relative(HERE, target.file)}, now @${target.slot.handle} "${target.slot.title}"`);
    if (!pickR) { console.log('nothing fresh can take it without breaking the two-days rule; the slot keeps its pick'); return; }
    console.log(`→ @${pickR.handle} "${pickR.title}"`);
    if (!argv.includes('--apply')) { console.log('(dry run: --apply swaps it in)'); return; }
    const material = path.relative(HERE, path.join(PAGE.dir,'articles', `${pickR.tid}.md`));
    fs.mkdirSync(path.join(PAGE.dir,'articles'), { recursive: true });
    fs.writeFileSync(path.join(HERE, material), materialOf(pickR));
    const slate = readJson(target.file);
    const old = slate.slots[target.index];
    slate.slots[target.index] = { at: old.at, saigon: old.saigon, tid: pickR.tid, url: pickR.url, handle: pickR.handle, title: pickR.title, type: pickR.type,
      niche: pickR.niche, floor: pickR.floor, views: pickR.views, bookmarks: pickR.bookmarks, score: +scoreOf(pickR).toFixed(4), lastQuoted: null, material,
      quotes: keyQuotesOf(pickR.body || '', { n: 3 }).map((q) => q.text),
      text: '', why: '', check: null, draft: null, fresh: true, published: pickR.published, velocity: Math.round(velocityOf(pickR, now)), replaced: { tid: old.tid, handle: old.handle, title: old.title } };
    planShapes(slate.slots);
    tctx.plan(slate.slots);
    { const x = slate.slots[target.index]; console.log(x.template ? `template: ${x.template} (${x.family}) · ${x.templates[0].skeleton.replace(/\n+/g, ' / ')}` : `shape: ${x.shape} · ${SHAPES[x.shape]}`); }
    writeJson(target.file, slate);
    console.log(`swapped into ${path.relative(HERE, target.file)}. Next: write its line in the chat, then check → draft (it joins the batch) → your Approve → schedule.`);
    return;
  }

  if (cmd === 'a16z') { console.error('the partner ASAP lane is Genius\'s (the a16z network); no PI page has a partner network, so it is not ported'); process.exit(1); }

  if (cmd === 'space') {
    // Every GTX post already on the calendar stays put; the slate's cold slots move (spacing above). Dry by default.
    requireEnv(env, ['TYPEFULLY_API_KEY']);
    const tf = typefully(env);
    const file = arg('--slate');
    const slate = readJson(file);
    const now = Date.now();
    const mine = new Set(slate.slots.map((x) => String(x.draft || '')).filter(Boolean));
    const fixed = [];
    for (let off = 0; off < 500; off += 50) {
      const r = await tf.get(`/social-sets/${PAGE.socialSetId}/drafts?status=scheduled&limit=50&offset=${off}`);
      const res = r.results || r.data || [];
      for (const d of res) if (d.scheduled_date && !mine.has(String(d.id))) fixed.push({ t: Date.parse(d.scheduled_date), what: d.draft_title || String(d.preview || '').slice(0, 40), id: String(d.id) });
      if (res.length < 50) break;
    }
    // (Genius also counts the promo QRTs its runs have dated; PI has none.)
    const movable = (x) => !x.asap && !x.posted && Date.parse(x.at) > now + 30 * 60000 && x.tid;
    const days = [...new Set(slate.slots.filter(movable).map((x) => new Date(Date.parse(x.at) + 7 * HOUR).toISOString().slice(0, 10)))];
    const changes = [];
    for (const day of days) {
      const dayOf = (t) => new Date(t + 7 * HOUR).toISOString().slice(0, 10);
      const cold = slate.slots.filter((x) => movable(x) && dayOf(Date.parse(x.at)) === day).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const others = [...fixed.filter((f) => dayOf(f.t) === day).map((f) => f.t), ...slate.slots.filter((x) => !movable(x) && dayOf(Date.parse(x.at)) === day).map((x) => Date.parse(x.at))];
      const times = placeDay(others, cold.length, day, { now: now + 30 * 60000 });
      cold.forEach((x, i) => { if (times[i] && times[i].at !== x.at) changes.push({ slot: x, from: x.at, to: times[i].at, crowded: times[i].crowded }); });
      const all = [...others.map((t) => ({ t, cold: false })), ...cold.map((x, i) => ({ t: Date.parse(times[i]?.at || x.at), cold: true }))].sort((a, b) => a.t - b.t);
      console.log(`${day}: ${all.map((a) => `${saigonOf(new Date(a.t).toISOString())}${a.cold ? '*' : ''}`).join(' · ')}   (* cold)`);
    }
    for (const c of changes) console.log(`  ${c.slot.handle}: ${saigonOf(c.from)} → ${saigonOf(c.to)} Saigon${c.crowded ? ' (still under the gap: the day is full)' : ''}`);
    if (!argv.includes('--apply') || !changes.length) { if (changes.length) console.log('(dry run: --apply moves them, in Typefully too)'); return; }
    for (const c of changes) {
      if (!c.slot.key) c.slot.key = pieceKeyOf(c.slot); // keep the Notion row it was filed under
      c.slot.at = c.to; c.slot.saigon = saigonOf(c.to);
      if (c.slot.scheduled && c.slot.draft) { await tf.patchDraft(PAGE.socialSetId, c.slot.draft, { publish_at: c.to }); c.slot.scheduled = c.to; }
    }
    slate.slots.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    writeJson(file, slate);
    console.log(`moved ${changes.length} cold slot(s)${changes.some((c) => c.slot.scheduled) ? ', Typefully updated' : ''}`);
    return;
  }

  const file = arg('--slate');
  if (!file || !fs.existsSync(file)) { console.error(USAGE); process.exit(1); }
  const slate = readJson(file);

  if (cmd === 'plan') {
    // (Re)plan templates for the slate's unwritten slots and show the week's families. Dry unless --apply.
    tctx.plan(slate.slots);
    const fams = {};
    for (const x of [...slate.slots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const f = familyOf(x, tctx.catalog); if (f) fams[f] = (fams[f] || 0) + 1;
      console.log(`${x.text ? 'written ' : 'planned '}${x.at.slice(0, 16)} @${String(x.handle).padEnd(16)} ${String(f || '?').padEnd(18)} ${x.template || ''}${!x.text && x.templates ? ` · ${x.templates[0].skeleton.replace(/\n+/g, ' / ').slice(0, 80)}` : ''}`);
    }
    console.log(`\nfamilies: ${Object.entries(fams).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(' · ')}`);
    if (argv.includes('--apply')) writeJson(file, slate);
    return;
  }

  if (cmd === 'visuals' || cmd === 'visual') { console.error('visuals are not ported: Genius renders the GTX house chart (chart-shot.mjs), and PI has no chart style for a QRT yet (qrt-boxes.mjs cold.visuals)'); process.exit(1); }

  if (cmd === 'check') {
    // Structure first (operator 2026-09-29: "This is more about just getting the structure with high confidence"). A line
    // fails on the hard stops only: the lane and variety rules, a quote put in someone's mouth that isn't word for word
    // in the article, the house bans, and a line off its planned template (structure under 0.8). Jev's reading is
    // advice, asked with --read. It auto-passes on a proven template kept almost exactly (autoPassOf).
    let bad = 0;
    const now = Date.now();
    for (const s of slate.slots) {
      // A drafted slot was checked before it was drafted (a rewrite clears its check), and a past one can't ship:
      // re-read them only with --all.
      if (((s.draft && s.check) || Date.parse(s.at) <= now) && !argv.includes('--all')) continue;
      if (!s.text) { console.log(`- ${s.at.slice(0, 10)} ${s.saigon} @${s.handle}: no copy yet`); bad++; continue; }
      const tpl = s.template ? tctx.catalog.templates.find((t) => t.id === s.template) : null;
      const mat = pieceMaterialOf(bodyAt(s), s.material || '');
      const fit = tpl ? templateFit(tpl.skeleton, s.text) : null;
      const fails = [
        ...laneFails(s.text), ...shapeFails(slate.slots, s), ...familyFails(slate.slots, s, tctx.catalog),
        ...codeChecks(s.text, mat, { template: tpl?.skeleton || '' }),
        ...(fit && fit.fit < STRUCTURE_MIN ? [`off ${s.template} (structure ${fit.fit}, needs ${STRUCTURE_MIN}+): keep the frame, change only the slots`] : []),
      ];
      const hours = s.published ? Math.max(0.1, (Date.now() - Date.parse(s.published)) / 36e5) : null;
      const virality = tpl ? viralityOf({ template: tpl, catalog: tctx.catalog, kind: 'article', text: s.text, fit: fit.fit, views: s.views ?? null, hours }) : null;
      s.check = { fails, pass: !fails.length, fit, virality, at: new Date().toISOString() };
      if (argv.includes('--read')) s.check.advice = 'not read: Jev\'s advisory reading (Genius qrt-fill.mjs) is not ported';
      s.check.auto = s.check.pass ? autoPassOf({ text: s.text, template: s.template || null, structure: fit?.fit ?? null, proven: virality?.parts.proven ?? null, media: s.media ? (s.media.kind === 'meme' ? 'meme' : true) : false }) : { ok: false, why: ['did not pass'] };
      if (!s.check.pass) bad++;
      console.log(`${s.check.pass ? (s.check.auto.ok ? 'AUTO' : 'PASS') : 'FAIL'} ${s.at.slice(0, 10)} ${s.saigon} @${s.handle} (${s.text.length} chars)${fit ? ` · ${s.template} structure ${fit.fit} · added ${Math.round(fit.added * 100)}% · virality ${virality.score}` : ' · no template'}${fails.length ? `\n  ${fails.join('; ')}` : ''}${s.check.pass && !s.check.auto.ok ? `\n  needs your Approve: ${s.check.auto.why.join('; ')}` : ''}${s.check.advice ? `\n  advice: ${s.check.advice}` : ''}${isMemeTemplate(s.template) ? `\n  meme: ${s.media?.kind === 'meme' ? `${s.template}'s clip ${s.media.tid} attached` : `draft attaches ${s.template}'s clip (${MEME_TEMPLATES[s.template].look})`}` : ''}`);
    }
    writeJson(file, slate);
    console.log(bad ? `\n${bad} slot(s) not ready.` : '\nall slots pass.');
    process.exitCode = bad ? 1 : 0;
    return;
  }

  if (cmd === 'draft') {
    requireEnv(env, ['TYPEFULLY_API_KEY']);
    const tf = DRY ? null : typefully(env);
    const scratchOf = (s) => [
      `Quoting: ${s.url}`,
      `Cold QRT lane (cold-qrt.mjs, ${path.basename(file)}). Slot ${s.at} = ${s.saigon} Saigon. NOT scheduled.`,
      `Article: "${s.title}" by @${s.handle} · ${s.type} · ${s.views.toLocaleString('en-US')} views · ${s.bookmarks.toLocaleString('en-US')} bookmarks.`,
      ...(s.why ? [`Why this line: ${s.why}`] : []),
      `Checks: ${s.check.saver || (s.check.fit ? `${s.template} structure ${s.check.fit.fit} · virality ${s.check.virality?.score}` : 'hard stops only')}${s.check.auto?.ok ? ' · auto-passed' : ''}`,
    ].join('\n');
    for (const s of slate.slots) {
      // A meme template goes out with its meme (operator 2026-09-30: "part of the reason why the QRT works is because of
      // the meme/gif"): the next clip from its donors, uploaded once and kept on the slot.
      if (isMemeTemplate(s.template) && !s.media && s.check?.pass && !(s.scheduled && Date.parse(s.scheduled) <= Date.now())) {
        if (DRY) console.log(`[dry] ${s.at.slice(0, 10)} @${s.handle}: would attach ${s.template}'s meme (${MEME_TEMPLATES[s.template].look})`);
        else {
          const { mediaId, clip } = await uploadMeme(tf, PAGE.socialSetId, s.template, { account: PAGE.key, draft: s.draft || null });
          s.media = { id: mediaId, kind: 'meme', template: s.template, tid: clip.tid, donor: clip.url, at: new Date().toISOString() };
          writeJson(file, slate);
          console.log(`  ${s.at.slice(0, 10)} @${s.handle}: ${s.template}'s meme ${clip.tid} (@${clip.handle}) attached`);
        }
      }
      // A rewritten slot (its text differs from what was drafted; a draft from before `draftedText` existed needs
      // `rewrite: true`) updates its draft in place, unless it is already scheduled or its new copy hasn't passed.
      const rewritten = !!s.draft && ((s.draftedText !== undefined ? s.text !== s.draftedText : !!s.rewrite) || (s.media?.id || null) !== (s.draftedMedia || null));
      if (s.draft && !rewritten) { console.log(`= ${s.at.slice(0, 10)} @${s.handle}: draft ${s.draft} already exists`); continue; }
      if (!s.check?.pass) { console.log(`! ${s.at.slice(0, 10)} @${s.handle}: not drafted, the check has not passed (run check)`); continue; }
      if (rewritten) {
        // A scheduled slot takes its rewrite only when the new line may ship on its own (it auto-passed, or it carries
        // your Approve); the draft keeps its publish time.
        if (s.scheduled && !approvedIn(s).ok) { console.log(`! ${s.at.slice(0, 10)} @${s.handle}: already scheduled and the rewrite needs the owner's approval, so it is not pushed`); continue; }
        if (DRY) { console.log(`[dry] ${s.at.slice(0, 10)} @${s.handle}: draft ${s.draft} would become\n---\n${s.text.trim()}\n---`); continue; }
        await tf.patchDraft(PAGE.socialSetId, s.draft, { platforms: { x: { enabled: true, posts: [postOf(s)] } }, scratchpad_text: scratchOf(s) });
        s.draftedText = s.text;
        s.draftedMedia = s.media?.id || null;
        delete s.rewrite;
        writeJson(file, slate);
        console.log(`~ ${s.at.slice(0, 10)} @${s.handle}: draft ${s.draft} rewritten${s.scheduled ? ` · still scheduled for ${s.scheduled}` : ' · not scheduled'}`);
        continue;
      }
      const body = {
        platforms: { x: { enabled: true, posts: [postOf(s)] } },
        draft_title: `Cold QRT · ${s.at.slice(0, 10)} · @${s.handle}`,
        scratchpad_text: scratchOf(s),
        share: false,
      };
      if (DRY) { console.log(`[dry] ${s.at.slice(0, 10)} @${s.handle} quoting ${s.url}\n---\n${s.text.trim()}\n---`); continue; }
      const d = await tf.createDraft(PAGE.socialSetId, body);
      s.draft = d.id;
      s.draftedText = s.text;
      s.draftedMedia = s.media?.id || null;
      writeJson(file, slate);
      console.log(`+ ${s.at.slice(0, 10)} @${s.handle}: draft ${d.id} · https://typefully.com/?d=${d.id}&a=${PAGE.socialSetId} · not scheduled`);
    }
    return;
  }

  if (cmd === 'batch') { console.error('PI has no review batch for QRTs yet (Genius files them into its runs): record the owner\'s approval with `approve`'); process.exit(1); }

  if (cmd === 'approve') {
    // The owner's approval of a line, in their words (PI's stand-in for Genius's Approve in the run batch). Only a slot
    // whose check passed can be approved, and the approval holds for this exact line and media.
    const at = arg('--slot'), words = arg('--words');
    if (!at || !words) { console.error('usage: node cold-qrt.mjs approve --slate <file> --slot <at prefix, or all> --words "<the owner\'s words>"'); process.exit(1); }
    const targets = slate.slots.filter((x) => (at === 'all' ? x.check?.pass && !x.check?.auto?.ok : x.at.startsWith(at)));
    if (!targets.length) { console.error(`no slot matches ${at}`); process.exit(1); }
    for (const x of targets) {
      if (!x.check?.pass) { console.log(`! ${x.at.slice(0, 16)} @${x.handle}: not approved, its check has not passed`); continue; }
      x.approved = approvalOf(x, words);
      console.log(`approved ${x.at.slice(0, 16)} @${x.handle}: "${x.approved.text.replace(/\n+/g, ' / ').slice(0, 90)}"`);
    }
    writeJson(file, slate);
    return;
  }

  if (cmd === 'schedule') {
    // Only on the operator's word for this slate (geniusrun "Never": never schedule unless the operator says so).
    requireEnv(env, ['TYPEFULLY_API_KEY']);
    const tf = DRY ? null : typefully(env);
    // PI: a group page (the boosters) keeps the fleet's spacing: 5 minutes from any post on any fleet page.
    const fleet = PAGE.group ? await fleetMinutes(typefully(env)) : null;
    for (const s of slate.slots) {
      if (!s.draft) { console.log(`! ${s.at.slice(0, 10)} @${s.handle}: no draft`); continue; }
      if (s.scheduled) { console.log(`= ${s.at.slice(0, 10)} @${s.handle}: already scheduled`); continue; }
      const ok = approvedIn(s);
      if (!ok.ok) { console.log(`! ${s.at.slice(0, 10)} @${s.handle}: ${ok.why}`); continue; }
      if (s.asap && Date.parse(s.at) <= Date.now() + 120000) { s.at = asapAt(Date.now(), 5); s.saigon = saigonOf(s.at); }
      if (Date.parse(s.at) <= Date.now()) { console.log(`! ${s.at.slice(0, 10)} @${s.handle}: slot already passed, left unscheduled`); continue; }
      if (fleet) {
        const t = clearOf(Date.parse(s.at), fleet);
        if (t !== Date.parse(s.at)) { console.log(`  ${s.at.slice(0, 16)} @${s.handle}: moved +${Math.round((t - Date.parse(s.at)) / 60000)} min for the fleet's 5-minute spacing`); s.at = new Date(t).toISOString().replace('.000Z', 'Z'); s.saigon = saigonOf(s.at); }
        fleet.push(Date.parse(s.at));
      }
      if (DRY) { console.log(`[dry] draft ${s.draft} → publish_at ${s.at}`); continue; }
      await tf.patchDraft(PAGE.socialSetId, s.draft, { publish_at: s.at });
      s.scheduled = s.at;
      writeJson(file, slate);
      console.log(`scheduled draft ${s.draft} for ${s.at} (${s.saigon} Saigon)`);
    }
    return;
  }
  console.error(`unknown command ${JSON.stringify(cmd)}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
