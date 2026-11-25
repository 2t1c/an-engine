#!/usr/bin/env node
// echo-qrt.mjs — every fleet thread quotes ITSELF at +2h, +4h, +7h and +10h, and 5 BOOSTER pages quote it too (the sister lines).
//
// Owner, 2026-10-03: "Own account: 3 (or 4) QRTs per thread" · "For the main accounts ... they just quote retweet
// themselves to avoid the cross-boost" · "Remember to include the GIF, or what we call the meme, if there's a meme
// attached" · "the key is finding the right format and having a variety of them" · "these would be created during our
// /run". Owner, 2026-10-07, the cadence today: "Self QRTs should happen at 2 - 4 and 7 hours after posting" and "Let's
// make it 4 self QRTs — the last one is stretched to 10hrs after posting" (all four always post; the falling-velocity 4th
// is retired). Sister QRTs, same day: "each thread should get at least 3 QRTs", "have one sister within the first 15
// minutes of posting", "let's make it 5 and the last 2 would be 12 and 16hrs after posting", no niche matching ("retire the concept of niche per page"), and "the 3 sister QRTs should be on
// the Booster pages — not on our posting accounts. Posting accounts do not cross post between each other".
//
// The lane, end to end:
//   1. /run, once a thread's Typefully draft exists: `plan` picks four templates for the page's own lines from the shelf
//      (learnings/qrt/shelf.json, qrt-pick's rubric with whose=self; praise and the third person are fine on the page's
//      own thread, owner 2026-10-05), skipping any template the page used in the cooldown. It also picks the thread's 5
//      sister pages (pickSisters: the booster pages with the fewest sister lines in the batch that day, none quoting the
//      same page twice a day) and a sister frame (whose=sister) for each.
//   2. The run's writer fills each line (the template's fixed words in order, its slots only); `check` applies the
//      house hard stops (qrt-checks), the structure bar (qrt-score ≥ 0.8) and the length; `save` uploads each meme
//      template's meme to the social set of the page that posts it and writes the rows to Airtable "Echo QRTs" as Planned: the
//      page's own four (Account = the thread's page) and the 5 sister lines (Account = the booster page).
//   3. The thread publishes: the Published Feed workflow's "Schedule Echo QRTs" node creates every quote post within
//      seconds (docs/feed-nodes/Schedule-Echo-QRTs.js): the page's own at +2h/+4h/+7h/+10h, the boosters' at about +6
//      minutes (never later than +15), +3h, +5h, +12h and +16h, each on its own page.
//   4. When the publish event never reaches n8n (n8n down, a disabled webhook), the thread's rows stay Planned:
//      `repair` (hourly, .github/workflows/echo-qrts.yml) replays the same scheduler node for every such thread.
//   Rows saved before 2026-10-07 may still carry the old 'falling' slot; the Echo QRT falling check still decides those.
//
//   node echo-qrt.mjs plan  --draft <typefully draft id | share link> --account <key> [--day YYYY-MM-DD] [--out <slate.json>]
//   node echo-qrt.mjs check --slate <slate.json>
//   node echo-qrt.mjs save  --slate <slate.json> [--run-dir RUN_DIR [--row <id>]] [--dry]   # --run-dir: only an approved drafts row saves
//   node echo-qrt.mjs show  --account <key> [--days 3]
//   node echo-qrt.mjs repair [--draft <id>] [--apply]   # replay the scheduler for threads the feed missed (hourly: echo-qrts.yml)
//   node echo-qrt.mjs boost-media [--days 2] [--apply]  # give Planned booster meme lines their meme on every booster page
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCatalog, pick } from './qrt-pick.mjs';
import { isMemeTemplate, memePoolOf } from './qrt-meme.mjs';
import { BOOSTERS } from './boosters.mjs';
import { codeChecks, materialOf } from './qrt-checks.mjs';
import { templateFit, STRUCTURE_MIN, NOTE_FRAMES } from './qrt-score.mjs';

export const BASE = 'app4Orfi56ghELGix';
export const TABLE = 'tblMQbTARdTNffNhe';
export const SLOTS = Object.freeze([
  { slot: '+2h', hours: 2 }, { slot: '+4h', hours: 4 }, { slot: '+7h', hours: 7 }, { slot: '+10h', hours: 10 },
].map(Object.freeze));
// The sister lines (one per booster page): the first inside the thread's first 15 minutes (the scheduler books it at +6
// minutes, or as soon as it can, and skips it past EARLY_BY_MIN), then +3h and +5h between the page's own lines, then
// +12h and +16h to stretch the thread's life past its own last line (owner, 2026-10-07: "let's make it 5 and the last 2
// would be 12 and 16hrs after posting. It's free so why not").
export const SISTER_SLOTS = Object.freeze([
  { slot: 'sister+6m', hours: 0.1 }, { slot: 'sister+3h', hours: 3 }, { slot: 'sister+5h', hours: 5 },
  { slot: 'sister+12h', hours: 12 }, { slot: 'sister+16h', hours: 16 },
].map(Object.freeze));
export const EARLY_BY_MIN = 15;
export const isSisterSlot = (slot) => /^sister/.test(String(slot || ''));
// A page repeats no format inside 3 days (7 until 2026-10-06: the shelf holds about 40 formats and a page posts about four
// echo lines a day, so a week would empty it; the Oct 6-8 rewrite's rule was none twice on one page in its batch).
export const COOLDOWN_DAYS = 3;
export const LENGTH = Object.freeze({ min: 20, max: 280 });

/** PURE. What the thread can back a frame with: a number, a quotable line, a list, a first-person story, media, a clip.
 *  `leadMime` is the mime type of tweet 1's first media (Typefully's media status), when the caller read it. */
export function hasOf(posts = [], { leadMime = null } = {}) {
  const text = posts.map((p) => String(p?.text || '')).join('\n');
  const has = new Set();
  if (/\d/.test(text)) has.add('number');
  if (/["“][^"”\n]{12,}["”]/.test(text)) has.add('quote');
  if ((text.match(/^\s*(\d+[.)]|[-•●▪])\s+\S/gm) || []).length >= 3) has.add('list');
  if (/\b(I|I'm|I've|I was|my|me)\b/.test(String(posts[0]?.text || ''))) has.add('story');
  if (posts.some((p) => (p?.media_ids || []).length)) has.add('media');
  // A video on tweet 1, the post every echo and booster line quotes: X shows it in the quote card, so a "Watch this:"
  // frame (shelf W1) points at it with nothing attached. Media on a later tweet never shows there.
  if ((posts[0]?.media_ids || []).length && /^video\//i.test(String(leadMime || ''))) has.add('clip');
  // For the shelf (learnings/qrt/shelf.json): A1 ("This advice from [expert] should have 200M views.") needs an expert the
  // thread's opening names ("ask your doctor" names none); C3-C5 ("… is the biggest lie everyone believes about …") need a
  // hook that overturns a belief (2026-10-06, on 153 fleet hooks: the 12 it finds all do).
  const opening = posts.slice(0, 2).map((p) => String(p?.text || '')).join('\n').replace(ASK_YOUR, ' ');
  if (EXPERT.test(opening)) has.add('expert');
  if (MYTH.test(String(posts[0]?.text || ''))) has.add('myth');
  return [...has];
}
const EXPERT = /\b(doctors?|dr\.?|(?:cardio|neuro|endocrino|dermato|gastroentero|psycho|bio)?logists?|psychiatrists?|physicians?|surgeons?|nurses?|(?:neuro)?scientists?|researchers?|professors?|nutritionists?|dietitians?|pharmacists?|geneticists?)\b/i;
const ASK_YOUR = /\b(?:ask|see|consult|talk to|speak to|speak with|check with|tell) (?:your|a) (?:doctor|physician|pharmacist|gp)\b/gi;
const MYTH = new RegExp(String.raw`\b(myths?|misconceptions?|the (?:biggest |big )?lie|lied to|(?:is|are) wrong\b(?! with)|(?:doing|eating|taking|using) (?:it|this|them|\w+) wrong`
  + String.raw`|(?:isn['’]t|aren['’]t|is not|are not) (?:only|just|always|really|actually|about|because|caused|what)|the (?:true|real) (?:killer|cause|reason|culprit|problem)`
  + String.raw`|(?:doesn['’]t|don['’]t|does not|do not) (?:need|begin|start|come|mean|cause|work)|not because|everything you (?:know|believe|were told|think)|you['’]ve been (?:told|lied)|truth about)\b`, 'i');

/**
 * PURE. Four templates for a page quoting its own thread, best first: from the owner's shelf, the formats the fleet used
 * least, from at least 3 buckets (the old library: one per family), at most MAX_MEMES meme frames, none the page used in
 * the cooldown (`cooldown` = template ids), families from its last QRTs pushed back (`recentFamilies`).
 */
export const MAX_MEMES = 2;   // the meme is why a meme frame works, but four memes in a row is one format, not variety
// A frame's fixed words that gender the post's author ("one of the most legit guys in …", "follow him") read wrong on a
// page whose persona is the other sex (accounts.mjs `sex`), and the writer may not change fixed words.
const GENDERED = Object.freeze({ m: /\b(guys?|he|him|his|man|men|bro|dude|king|sir)\b/i, f: /\b(she|her|hers|woman|women|girls?|queen|lady|ladies|sis)\b/i });
const fixedOf = (skeleton) => String(skeleton || '').replace(/\[[^\]]*\]/g, ' ');
const BRO = /\b(bro|guys?|dude)\b/i;
/** PURE. True when the template's fixed words (its [slots] removed) gender the author the other way than `sex`. */
export const wrongGender = (skeleton, sex) => sex === 'f' ? GENDERED.m.test(fixedOf(skeleton)) : sex === 'm' ? GENDERED.f.test(fixedOf(skeleton)) : false;
// A frame whose fixed words name another kind of post ("This article should have 100M views") reads wrong on a thread;
// "this video" / "this clip" only fits a thread that carries media.
/** PURE. True when the template's fixed words name a kind of post a thread is not (`has` = hasOf(posts)). */
export const wrongKind = (skeleton, has = []) => /\b(articles?|essays?|newsletters?|podcasts?|episodes?)\b/i.test(fixedOf(skeleton))
  || (!has.includes('media') && /\b(videos?|clips?)\b/i.test(fixedOf(skeleton)));
// What 2026-10-04's 22 slates taught, as rules (every one held a line that passed `check` and still read wrong):
const LIVE_COUNT = /posted \[N\]|\[N\] (likes|views|minutes ago)/i;
// A frame whose fixed words argue with the post it quotes ("completely disagree. [counter-argument]"): every post these
// lanes quote is a fleet thread, so the line would argue with our own thread.
const DISAGREES = /\b(disagree|is wrong|are wrong|nobody (wants|believes|asked for) this)\b/i;
/** PURE. Why a catalog frame can't carry a line about a fleet thread (a page's own or, `whose: 'sister'`, a booster's),
 *  or null: an instruction the scorer reads as words (qrt-score NOTE_FRAMES); no record on a post or an article (a
 *  launch or quote-tweet frame); a live count nobody knows when the line is written; fixed words alone under the length
 *  floor; a frame that argues with the post it quotes; on a booster's, a story it never lived ("Personal Story"). Praise
 *  and the third person are fine on a page's own thread (owner, 2026-10-05). */
export function frameIssue(t, { whose = 'self' } = {}) {
  const fixed = fixedOf(t.skeleton).replace(/\s*\/?\s*\((?:variants?|optional|or)\b[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
  if (NOTE_FRAMES.includes(t.id)) return 'its skeleton carries a format note the structure score reads as words';
  if (!(t.kinds?.post || t.kinds?.article)) return 'no record on a post or an article';
  if (LIVE_COUNT.test(t.skeleton || '')) return 'a live count that is unknown when the line is written';
  if (!/\[/.test(t.skeleton || '') && fixed.length < LENGTH.min) return `its fixed words are under ${LENGTH.min} characters`;
  if (DISAGREES.test(fixed)) return 'it argues with the post it quotes, and the post is our own thread';
  // Praise and the third person are fine on a page's own thread (owner, 2026-10-05: "don't filter out third person —
  // that also works too — and self praise is fine").
  if (whose === 'sister' && t.family === 'Personal Story') return 'a story the booster page never lived';
  return null;
}

// `whose: 'sister'` is a booster page quoting a fleet thread (boosters.mjs): it may vouch for the post. A booster line's
// page is only known when it is booked, so `save` uploads a meme line's meme to every booster page that could take it
// and the booking node attaches that page's copy; a meme line never posts bare (owner, 2026-10-05: "Always, always
// remember to keep and include the meme/gif if it was there in the original"). At most BOOST_MAX_MEMES of a thread's
// booster lines are meme frames. `avoidFamilies` (the thread's other quotes) go last, for variety across one thread.
// `spread` (template id → times the fleet's other slates took it, batchOf) puts the least-taken first, rank breaking
// ties: without it every page with the same kind of thread gets the same four frames on the same day.
//
// THE SHELF (the default; learnings/qrt/shelf.json, owner 2026-10-06: "yes shelve the formats"); `shelf: false` reads the
// old library, one template per family, the page's recent families last. The shelf's seven buckets differ in size (17
// value formats, 2 shock), so one per family would post the small buckets' few formats on every thread (a 30-thread trial,
// 2026-10-06: C4 on 25 of them). On the shelf the formats take turns instead, by the rules of the owner's Oct 6-8 rewrites:
// - the batch's least-used format first (`spread`: this run's other slates); among equals the thread's other families and
//   the page's recent families go back, then the fleet's least used lately (`history`: lines saved in the last 2 days,
//   outside the batch), and rank breaks ties. History only breaks ties: ranked like the batch, a format the last run
//   barely used led every slate until it caught up (2026-10-06: H2 on two slates in a row);
// - a thread's lines come from at least 3 buckets (four lines: one bucket may give two; two lines: two buckets);
// - a controversial line only on a thread that overturns a belief (C3-C5 need `myth`), at most one per thread
//   (`avoidFamilies` brings the page's own lines to the boosters' pick), and controversial, follow and H2 lines within
//   their share of the batch (SHELF_SHARE);
// - a thread carries one meme clip once (five formats ride on Iron Man: `avoidMemes` = the clips its other lines carry)
//   and one "bro" / "this guy" voice (`avoidBro`); a brand page (no persona sex) takes no gendered frame, slots included
//   ("follow [him / her]").
// The shelf is small, so when a page's cooldown leaves too few formats its oldest uses come back first (`cooldown` is
// newest first; the first `keep` entries never come back).
export function chooseTemplates(catalog, opts = {}, n = SLOTS.length) {
  const out = choose(catalog, opts, n), { cooldown = [], keep = 0, shelf = true } = opts;
  if (out.length < n && shelf && cooldown.length > keep) {
    return chooseTemplates(catalog, { ...opts, cooldown: cooldown.slice(0, Math.max(keep, Math.floor(cooldown.length / 2))) }, n);
  }
  return out;
}
function choose(catalog, { has = [], cooldown = [], recentFamilies = [], whose = 'self', maxMemes = MAX_MEMES, avoidFamilies = [], authorSex = null, spread = {}, history = {}, avoidMemes = [], avoidBro = false, shelf = true } = {}, n) {
  const { ranked } = pick(catalog, { kind: 'post', whose, has, used: cooldown, recentFamilies, shelf });
  const avoid = new Set(avoidFamilies), recent = new Set(recentFamilies);
  const batch = shelf ? shelfTally(catalog, spread) : { uses: spread, familyOf: () => null };
  const lately = shelf ? shelfTally(catalog, history).uses : {};
  const taken = (x) => batch.uses[x.t.id] || 0, late = (x) => (recent.has(x.t.family) ? 1 : 0);
  const gendered = (sk) => (shelf && !authorSex ? GENDERED.m.test(sk) || GENDERED.f.test(sk) : wrongGender(sk, authorSex));
  const fits = ranked.filter((x) => !gendered(x.t.skeleton) && !wrongKind(x.t.skeleton, has) && !frameIssue(x.t, { whose }));
  let order;
  if (shelf) {
    const back = (x) => (avoid.has(x.t.family) ? 1 : 0) + late(x), was = (x) => lately[x.t.id] || 0;
    order = fits.sort((a, b) => taken(a) - taken(b) || back(a) - back(b) || was(a) - was(b));   // stable: rank breaks ties
  } else {
    const bySpread = (xs) => xs.sort((a, b) => late(a) - late(b) || taken(a) - taken(b));
    order = [...bySpread(fits.filter((x) => !avoid.has(x.t.family))), ...bySpread(fits.filter((x) => avoid.has(x.t.family)))];
  }
  const share = shelf ? SHELF_SHARE[whose] || {} : {}, lines = Object.values(batch.uses).reduce((s, v) => s + v, 0);
  const usesOf = (key) => Object.entries(batch.uses).reduce((s, [id, c]) => s + (id === key || batch.familyOf(id) === key ? c : 0), 0);
  const full = (key) => share[key] != null && usesOf(key) >= share[key] * (lines + n);
  const doubles = n - Math.min(n, 3);   // on the shelf: four lines, one bucket may give two; fewer lines, all different
  const fam = {}, clips = new Set(avoidMemes), out = [];
  let bro = avoidBro;
  for (const x of order) {
    const f = x.t.family;
    if (shelf) {
      if (fam[f] && (fam[f] >= 2 || Object.values(fam).filter((c) => c > 1).length >= doubles)) continue;
      if (f === 'Controversial' && (fam[f] || avoid.has(f))) continue;
      if (full(f) || full(x.t.id)) continue;
    } else if (fam[f]) continue;
    const clip = x.s.meme ? memePoolOf(x.t.id) : null;
    if (clip && clips.has(clip)) continue;
    const isBro = shelf && BRO.test(fixedOf(x.t.skeleton));
    if (isBro && bro) continue;
    if (x.s.meme && out.filter((o) => o.meme).length >= maxMemes) continue;
    fam[f] = (fam[f] || 0) + 1;
    if (clip) clips.add(clip);
    if (isBro) bro = true;
    out.push({ id: x.t.id, family: f, skeleton: x.t.skeleton, meme: !!x.s.meme, clip, bro: isBro, note: x.t.note || null, score: x.s.total });
    if (out.length === n) break;
  }
  // The rewrites put the strongest line at +3h (the one slot that always posts): the shelf's picks go best first.
  return shelf ? out.sort((a, b) => b.score - a.score) : out;
}
// The Oct 6-8 rewrites' caps (owner-approved briefs, 2026-10-06), as a share of one lane's lines in the batch (`spread`):
// the pages' own lines took controversial 2 in 36 and H2 once ("use at most once", the sheet's note); the boosters' took
// controversial 6 in 59, follow 5 in 59 and H2 once.
export const SHELF_SHARE = Object.freeze({
  self: Object.freeze({ Controversial: 2 / 36, H2: 1 / 36 }),
  sister: Object.freeze({ Controversial: 6 / 59, Follow: 5 / 59, H2: 1 / 59 }),
});
/** PURE. A batch's tally (`spread`) keyed by shelf format: a row written under a format's `as` id (the Oct 6-8 rewrite
 *  wrote the meme's or the source frame's id) counts as that format when only one format has it. */
export function shelfTally(catalog, spread = {}) {
  const ids = new Map(), as = new Map();
  for (const t of catalog.templates) if (t.shelf) { ids.set(t.id, t); if (t.as && t.as !== t.id) as.set(t.as, as.has(t.as) ? null : t); }
  const uses = {};
  for (const [id, c] of Object.entries(spread || {})) { const k = (ids.get(id) || as.get(id))?.id || id; uses[k] = (uses[k] || 0) + c; }
  return { uses, familyOf: (id) => ids.get(id)?.family || null };
}

/**
 * PURE. What a batch's other slates (the slates in the same --out folder: a run's echo/ folder, every day of it) mean for
 * the next one. The same page's picks are out, like its saved rows (its cooldown, which Airtable alone cannot see before
 * `save`); every other page's picks are counted, its own lines (`spread`) and the boosters' lines (`boostSpread`), so the
 * new slate takes the fleet's least-used templates first.
 */
export function batchOf(slates, { account, draftId }) {
  const others = (slates || []).filter((s) => s && String(s.draftId) !== String(draftId));
  const tally = (ids) => ids.reduce((m, id) => (id ? { ...m, [id]: (m[id] || 0) + 1 } : m), {});
  return {
    cooldown: others.filter((s) => s.account === account).flatMap((s) => (s.slots || []).map((x) => x.template)).filter(Boolean),
    spread: tally(others.filter((s) => s.account !== account).flatMap((s) => (s.slots || []).map((x) => x.template))),
    boostSpread: tally(others.flatMap((s) => (s.boost || []).map((x) => x.template))),
    sisterSpread: tally(others.flatMap((s) => (s.sisters || []).map((x) => x.template))),
    sisterTaken: others.filter((s) => s.day).map((s) => ({ day: s.day, account: s.account, sisters: (s.sisters || []).map((x) => x.account) })),
  };
}

/** PURE. The pages that post the sister QRTs: the booster theme pages with a social set, not paused (owner, 2026-10-07:
 *  "the 3 sister QRTs should be on the Booster pages — not on our posting accounts. Posting accounts do not cross post
 *  between each other"). */
export function sisterPages(accounts, boosters = BOOSTERS) {
  return boosters.filter((k) => accounts?.[k] && Number(accounts[k].socialSetId) && !accounts[k].paused);
}

const fnv = (str) => { let h = 2166136261; for (const c of String(str)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
/**
 * PURE. The `n` booster pages that quote `account`'s thread on `day` (owner, 2026-10-07: 5 sister QRTs a thread, from the
 * booster pages). `taken` = the batch's other threads ({ day, account, sisters }, batchOf). First the
 * boosters not already quoting one of `account`'s threads that day, then the fewest sister lines that day (14 threads a
 * day over 10 boosters: 7 each), then a fixed shuffle per thread. No niche match (owner, 2026-10-07: "retire the
 * concept of niche per page").
 */
export function pickSisters({ draftId, account, day, pages = [], taken = [], n = SISTER_SLOTS.length }) {
  const today = taken.filter((t) => t.day === day);
  const load = {};
  for (const t of today) for (const p of t.sisters || []) load[p] = (load[p] || 0) + 1;
  const quotesUs = new Set(today.filter((t) => t.account === account).flatMap((t) => t.sisters || []));
  const again = (p) => (quotesUs.has(p) ? 1 : 0);
  return pages.filter((p) => p !== account)
    .sort((a, b) => again(a) - again(b) || (load[a] || 0) - (load[b] || 0) || fnv(`${draftId}:${a}`) - fnv(`${draftId}:${b}`))
    .slice(0, n);
}

/** PURE. The Saigon calendar day of an instant (the day a thread publishes, for the sister pages' daily rotation). */
export const saigonDay = (at) => new Date(Date.parse(at) + 7 * 3600000).toISOString().slice(0, 10);

/** The slates already in `dir` (a batch's --out folder); anything else there is ignored. */
function slatesIn(dir) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter((s) => s && s.version === 1 && Array.isArray(s.slots) && s.draftId);
}

/** PURE. The slate the writer fills: the thread (the material), one empty line per slot, the sister pages' lines
 *  (`sisters` = [{ account, socialSetId }], one per SISTER_SLOTS entry, with `sisterPicks` their frames) and the
 *  boosters' lines. `day` is the Saigon day the thread publishes. */
export function slateOf({ draftId, account, socialSetId, posts, picks, boostPicks = [], sisters = [], sisterPicks = [], day = null, now = new Date() }) {
  if (picks.length < SLOTS.length) throw new Error(`only ${picks.length} template families fit this thread; need ${SLOTS.length}`);
  if (sisterPicks.length < sisters.length) throw new Error(`only ${sisterPicks.length} sister frames fit this thread; need ${sisters.length}`);
  const line = (p) => ({ template: p.id, family: p.family, skeleton: p.skeleton, meme: !!p.meme, ...(p.note ? { note: p.note } : {}), text: '' });
  return { version: 1, draftId: String(draftId), account, socialSetId: Number(socialSetId), plannedAt: new Date(now).toISOString(), day,
    thread: posts.map((p) => String(p?.text || '')),
    slots: SLOTS.map((s, i) => ({ ...s, ...line(picks[i]), meme: picks[i].meme })),
    sisters: sisters.slice(0, SISTER_SLOTS.length).map((x, i) => ({ ...SISTER_SLOTS[i], account: x.account, socialSetId: Number(x.socialSetId), ...line(sisterPicks[i]) })),
    boost: boostPicks.map((b, i) => ({ line: i + 1, ...line(b) })) };
}

/** PURE. Every line's hard stops (the page's slots, then the boosters' lines): empty, length, link/hashtag, the house
 *  checks, structure under the bar. */
export function checkSlate(slate) {
  const mat = materialOf(slate.thread.join('\n\n'));
  const one = (slot, template, skeleton, raw) => {
    const text = String(raw || '').trim(), fails = [];
    if (!text) fails.push('no text yet');
    else {
      if (text.length < LENGTH.min || text.length > LENGTH.max) fails.push(`length ${text.length} (${LENGTH.min}–${LENGTH.max})`);
      if (/https?:\/\/|(^|\s)#\w/.test(text)) fails.push('no link or hashtag');
      fails.push(...codeChecks(text, mat, { template: skeleton }));
      const fit = templateFit(skeleton, text).fit;
      if (fit < STRUCTURE_MIN) fails.push(`structure ${fit} < ${STRUCTURE_MIN} (keep the template's fixed words, fill only its slots)`);
    }
    return { slot, template, ok: !fails.length, fails };
  };
  return [...slate.slots.map((s) => one(s.slot, s.template, s.skeleton, s.text)),
    ...(slate.sisters || []).map((s) => one(s.slot, s.template, s.skeleton, s.text)),
    ...(slate.boost || []).map((b) => one(`boost-${b.line}`, b.template, b.skeleton, b.text))];
}

/** PURE. The Airtable rows for a checked slate: the page's own lines, then the sister pages' (Account and Social Set
 *  ID = the page that posts the quote). `media` = { [slot]: [mediaId] } for meme templates, uploaded to that page. */
export function rowsOf(slate, media = {}) {
  const row = (s, account, socialSetId) => ({
    Key: `${slate.draftId}:${s.slot}`, 'Draft ID': slate.draftId, Account: account, 'Social Set ID': socialSetId,
    Slot: s.slot, 'Offset Hours': s.hours, Text: String(s.text).trim(), Template: s.template, Family: s.family,
    'Media IDs': (media[s.slot] || []).join(','), Status: 'Planned', 'Planned At': slate.plannedAt,
  });
  return [...slate.slots.map((s) => row(s, slate.account, slate.socialSetId)), ...(slate.sisters || []).map((s) => row(s, s.account, s.socialSetId))];
}

/** PURE. The boosters' lines as Airtable "Booster QRTs" rows, Planned until a booster's slot takes one. `media` =
 *  { [line]: { [booster]: mediaId } } for meme templates: "Media IDs" holds it as JSON for the booking node. */
export const BOOST_TABLE = 'tblrPxmrkdfwh7bR1';
export const BOOST_MAX_MEMES = 1;
export function boostRowsOf(slate, media = {}) {
  return (slate.boost || []).map((b) => ({
    Key: `${slate.draftId}:b${b.line}`, 'Draft ID': slate.draftId, 'Thread Account': slate.account, 'Thread Social Set ID': slate.socialSetId,
    Line: b.line, Text: String(b.text).trim(), Template: b.template, Family: b.family, Status: 'Planned', 'Planned At': slate.plannedAt,
    ...(media[b.line] && Object.keys(media[b.line]).length ? { 'Media IDs': JSON.stringify(media[b.line]) } : {}),
  }));
}

/** PURE. The booster pages that could take a line on `threadAccount`'s thread: every booster but the thread's own page. */
export function boostMemeTargets(threadAccount, accounts, boosters = BOOSTERS) {
  return boosters.filter((k) => k !== threadAccount && Number(accounts?.[k]?.socialSetId)).map((k) => ({ key: k, socialSetId: Number(accounts[k].socialSetId) }));
}

/** PURE. The targets a meme line still lacks a meme for, from its "Media IDs" JSON. Not a meme template: none. */
export function missingMemeTargets(row, accounts, boosters = BOOSTERS) {
  if (!isMemeTemplate(row?.Template)) return [];
  let have = {};
  try { have = JSON.parse(row['Media IDs'] || '{}') || {}; } catch { have = {}; }
  return boostMemeTargets(row['Thread Account'], accounts, boosters).filter((t) => !have[t.key]);
}

/** Upload a meme template's meme to each target page (`upload` = qrt-meme's uploadMeme). A failed upload leaves that page
 *  out, so it never takes the line; it is reported, never fatal. Returns { [booster]: mediaId }. */
export async function uploadBoostMemes(tf, template, targets, upload, log = console.error) {
  const out = {};
  for (const t of targets) {
    try { const { mediaId } = await upload(tf, t.socialSetId, template, { account: t.key }); if (mediaId) out[t.key] = String(mediaId); }
    catch (e) { log(`  ! ${template} meme for ${t.key}: ${String(e?.message || e).slice(0, 160)} (${t.key} will not take this line)`); }
  }
  return out;
}

/** PURE. A row already past Planned (scheduled, skipped, failed) is never overwritten by a re-save. */
export const lockedKeys = (existing = []) => new Set(existing.filter((r) => r.Status && r.Status !== 'Planned').map((r) => r.Key));

/**
 * PURE. The drafts with a row still waiting for its thread to publish (Planned, no Quote URL yet), one per draft. The
 * feed's scheduler stamps the Quote URL on every row it handles within seconds of the publish; a thread published
 * REPAIR_AFTER_MIN ago whose rows are still waiting was missed. A draft found only through sister lines (its own lines
 * already past Planned) is left out: the scheduler has stamped it.
 */
export const REPAIR_AFTER_MIN = 15;
export function waitingDrafts(rows = []) {
  const by = new Map();
  for (const r of rows) {
    const id = String(r['Draft ID'] || '');
    if (r.Status !== 'Planned' || r['Quote URL'] || !/^\d+$/.test(id)) continue;
    const g = by.get(id) || { draftId: id, socialSetId: null, account: '', slots: [] };
    // The thread's page is the one on its own lines; a sister line names the page that quotes it.
    if (!isSisterSlot(r.Slot) && !g.socialSetId) { g.socialSetId = Number(r['Social Set ID']); g.account = r.Account || ''; }
    g.slots.push(r.Slot);
    by.set(id, g);
  }
  return [...by.values()].filter((g) => g.socialSetId);
}

/** n8n's `this.helpers.httpRequest` on fetch: qs, a JSON body, JSON back, and a throw on a bad status, as in n8n. */
export function httpRequestOn(fetchFn = fetch) {
  return async ({ method = 'GET', url, qs, headers = {}, body, json } = {}) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(qs || {})) u.searchParams.set(k, String(v));
    const r = await fetchFn(u, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${u.hostname}${u.pathname} -> ${r.status} ${text.slice(0, 200)}`);
    return json ? (text ? JSON.parse(text) : {}) : text;
  };
}

/** Replay the live "Schedule Echo QRTs" node for one Published Feed row, exactly as the feed workflow runs it. */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export async function replayScheduler({ row, token, env, httpRequest, src = readFileSync(new URL('./docs/feed-nodes/Schedule-Echo-QRTs.js', import.meta.url), 'utf8') }) {
  const nodes = { 'Build Feed Row': [{ json: row }], 'Get Feed Config': [{ json: { Name: 'Typefully', Token: token } }] };
  const $ = (name) => ({ all: () => nodes[name] || [], first: () => (nodes[name] || [])[0] });
  const out = await new AsyncFunction('$', '$env', src).call({ helpers: { httpRequest } }, $, env);
  return (out || []).map((i) => i.json);
}

// ---------------------------------------------------------------------------------------------- CLI
/** Tweet 1's first media's mime type (hasOf `clip`), or null: no media, or a read that failed (a clip frame is then out). */
async function leadMimeOf(tf, socialSetId, posts) {
  const id = posts[0]?.media_ids?.[0];
  if (!id) return null;
  try { return (await tf.getMediaStatus(socialSetId, id))?.mime || null; } catch { return null; }
}

async function airtableRows(env, formula, table = TABLE) {
  const out = []; let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${table}`);
    u.searchParams.set('pageSize', '100'); if (formula) u.searchParams.set('filterByFormula', formula); if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    const j = await r.json(); if (!r.ok) throw new Error(`${table === TABLE ? 'Echo' : 'Booster'} QRTs read ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    out.push(...(j.records || []).map((x) => ({ id: x.id, ...x.fields }))); offset = j.offset;
  } while (offset);
  return out;
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const { loadEnv, requireEnv, typefully, cliArg } = await import('./lib.mjs');
  const env = loadEnv();
  if (cmd === 'plan') {
    requireEnv(env, ['TYPEFULLY_API_KEY', 'AIRTABLE_PAT']);
    const tf = typefully(env);
    const { resolveDraft } = await import('./clip-thread.mjs');
    const ref = cliArg('draft'), accountKey = cliArg('account');
    if (!ref || !accountKey) throw new Error('usage: echo-qrt.mjs plan --draft <id|link> --account <key> [--day YYYY-MM-DD] [--out slate.json]');
    if (cliArg('day') && !/^\d{4}-\d{2}-\d{2}$/.test(cliArg('day'))) throw new Error('--day is YYYY-MM-DD (the Saigon day the thread posts)');
    const r = await resolveDraft(env, tf, ref, accountKey);
    const draft = await tf.getDraft(r.socialSetId, r.draftId);
    const posts = draft?.platforms?.x?.posts || [];
    if (posts.length < 2) throw new Error(`draft ${r.draftId} is not a thread (${posts.length} post)`);
    const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString();
    const recent = (await airtableRows(env, `AND({Account}='${accountKey}', IS_AFTER({Planned At}, '${since}'))`)).sort((a, b) => String(b['Planned At']).localeCompare(String(a['Planned At'])));
    const catalog = loadCatalog(), leadMime = await leadMimeOf(tf, r.socialSetId, posts), has = hasOf(posts, { leadMime });
    const { ACCOUNTS } = await import('./accounts.mjs');
    const authorSex = ACCOUNTS[accountKey]?.sex || null;
    // The batch: the other slates in the --out folder (a run's echo/ folder) and the lines the rest of the fleet saved in
    // the last 2 days (a batch planned elsewhere, once saved), so the fleet's pages do not all take the same frames.
    const outArg = cliArg('out'), siblings = outArg ? slatesIn(dirname(outArg)) : [];
    const batch = batchOf(siblings, { account: accountKey, draftId: r.draftId });
    const inBatch = new Set(siblings.map((s) => String(s.draftId)));
    const fleetLately = (await airtableRows(env, `AND({Account}!='${accountKey}', IS_AFTER({Planned At}, '${new Date(Date.now() - 2 * 86400000).toISOString()}'))`))
      .filter((x) => !inBatch.has(String(x['Draft ID']))).map((x) => x.Template).filter(Boolean);
    const tally = (ids) => ids.reduce((m, id) => ({ ...m, [id]: (m[id] || 0) + 1 }), {});
    // Newest first: when the shelf runs short the page's oldest uses come back first (chooseTemplates).
    const picks = chooseTemplates(catalog, { has, authorSex, spread: batch.spread, history: tally(fleetLately), cooldown: [...batch.cooldown, ...recent.map((x) => x.Template).filter(Boolean)], recentFamilies: recent.slice(0, 3).map((x) => x.Family) });
    // The sister lines: 3 booster pages, rotated across the batch's threads that day (pickSisters), each with a sister
    // frame (at most BOOST_MAX_MEMES meme frames; `save` uploads the meme to that booster's set), none of the page's own
    // lines' formats, clips or second "bro" voice, the formats the boosters took least in the batch and the last 2 days
    // first. They replace the 2 booster lines the slate carried until 2026-10-07 (owner: the sister QRTs are the
    // boosters'), so `boost` stays empty and the boosters' fixed thread-QRT slots have nothing new to book.
    const lately = (await airtableRows(env, `IS_AFTER({Planned At}, '${new Date(Date.now() - 2 * 86400000).toISOString()}')`, BOOST_TABLE))
      .sort((a, b) => String(b['Planned At']).localeCompare(String(a['Planned At'])));
    const boostHistory = tally(lately.filter((x) => !inBatch.has(String(x['Draft ID']))).map((x) => x.Template).filter(Boolean));
    // The day the thread posts: --day (a /run row's date; its [REVIEW] draft is not scheduled yet), else the draft's
    // scheduled time, else today.
    const day = cliArg('day') || saigonDay(draft?.scheduled_date || draft?.publish_at || new Date().toISOString());
    const sisterKeys = pickSisters({ draftId: r.draftId, account: accountKey, day, pages: sisterPages(ACCOUNTS), taken: batch.sisterTaken });
    const sisterPicks = chooseTemplates(catalog, { has, authorSex, whose: 'sister', maxMemes: BOOST_MAX_MEMES, avoidFamilies: picks.map((x) => x.family), spread: batch.sisterSpread, history: boostHistory,
      avoidMemes: picks.map((x) => x.clip).filter(Boolean), avoidBro: picks.some((x) => x.bro),
      cooldown: picks.map((x) => x.id), keep: picks.length, recentFamilies: lately.slice(0, 6).map((x) => x.Family) }, sisterKeys.length);
    const sisters = sisterKeys.map((k) => ({ account: k, socialSetId: ACCOUNTS[k].socialSetId }));
    const slate = slateOf({ draftId: r.draftId, account: accountKey, socialSetId: r.socialSetId, posts, picks, sisters, sisterPicks, day });
    const out = outArg || `/tmp/echo-qrt-${r.draftId}.json`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(slate, null, 2));
    console.log(`Echo QRTs for draft ${r.draftId} (${accountKey}) · thread backs: ${has.join(', ') || 'nothing special'}`
      + ` · batch: ${inBatch.size - (inBatch.has(String(r.draftId)) ? 1 : 0)} other slate(s), ${fleetLately.length} fleet line(s) saved in 2 days`);
    for (const s of slate.slots) console.log(`  ${s.slot.padEnd(8)} ${s.template.padEnd(5)} ${s.family.padEnd(20)} ${s.meme ? '🎞 meme · ' : ''}${s.skeleton.replace(/\n/g, ' / ')}`);
    for (const x of slate.sisters) console.log(`  ${x.slot.padEnd(10)} ${x.template.padEnd(5)} ${x.family.padEnd(20)} ${x.account} · ${x.meme ? '🎞 meme · ' : ''}${x.skeleton.replace(/\n/g, ' / ')}`);
    for (const b of slate.boost) console.log(`  ${`boost-${b.line}`.padEnd(8)} ${b.template.padEnd(5)} ${b.family.padEnd(20)} ${b.meme ? '🎞 meme · ' : ''}${b.skeleton.replace(/\n/g, ' / ')}`);
    console.log(`slate → ${out}  (fill each "text", then: node echo-qrt.mjs check --slate ${out})`);
    return;
  }
  const slatePath = cliArg('slate');
  if (cmd === 'check' || cmd === 'save') {
    if (!slatePath) throw new Error(`usage: echo-qrt.mjs ${cmd} --slate <slate.json>`);
    const slate = JSON.parse(readFileSync(slatePath, 'utf8'));
    const results = checkSlate(slate);
    for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.slot.padEnd(8)} ${r.template.padEnd(5)} ${r.fails.join('; ')}`);
    if (cmd === 'check') { if (results.some((r) => !r.ok)) process.exitCode = 1; return; }
    if (results.some((r) => !r.ok)) throw new Error('fix the failing slots before saving');
    const DRY = process.argv.includes('--dry');
    // In a /run the slate is saved once its thread's drafts row is approved (the slate file is named for the
    // row). With --run-dir the ledger is read here, so the write gate needs no permission prompt for it.
    const runDir = cliArg('run-dir', null);
    if (runDir && !DRY) {
      const { checkRow } = await import('./scripts/run-studio.mjs');
      const rowId = cliArg('row', basename(slatePath, '.json'));
      checkRow(runDir, 'drafts', rowId);
      console.log(`  ledger: drafts/${rowId} approved`);
    }
    requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY']);
    const existing = await airtableRows(env, `{Draft ID}='${slate.draftId}'`);
    const locked = lockedKeys(existing);
    const media = {};
    if (!DRY) {
      const { uploadMeme } = await import('./qrt-meme.mjs');
      const tf = typefully(env);
      for (const s of slate.slots) if (s.meme && !locked.has(`${slate.draftId}:${s.slot}`)) media[s.slot] = [(await uploadMeme(tf, slate.socialSetId, s.template, { account: slate.account })).mediaId].filter(Boolean);
      // A sister line's meme goes to the sister page's own social set: that page posts the quote.
      for (const s of slate.sisters || []) if (isMemeTemplate(s.template) && !locked.has(`${slate.draftId}:${s.slot}`)) media[s.slot] = [(await uploadMeme(tf, s.socialSetId, s.template, { account: s.account })).mediaId].filter(Boolean);
    }
    const rows = rowsOf(slate, media).filter((r) => !locked.has(r.Key));
    // A booster meme line takes its meme to every booster page that could book it; the template decides, so a line
    // re-framed by hand onto a meme template carries its meme too.
    const boostLocked = lockedKeys(await airtableRows(env, `{Draft ID}='${slate.draftId}'`, BOOST_TABLE));
    const memeLines = (slate.boost || []).filter((b) => isMemeTemplate(b.template) && !boostLocked.has(`${slate.draftId}:b${b.line}`));
    const { ACCOUNTS } = await import('./accounts.mjs');
    const memeTargets = boostMemeTargets(slate.account, ACCOUNTS);
    if (DRY) { console.log(`[dry] would upsert ${rows.length} row(s)${locked.size ? `; ${locked.size} already past Planned, left alone` : ''} and ${boostRowsOf(slate).length} booster line(s)${memeLines.length ? `; ${memeLines.length} booster meme line(s) would upload to ${memeTargets.map((t) => t.key).join(', ')}` : ''}`); return; }
    for (let i = 0; i < rows.length; i += 10) {
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}`, { method: 'PATCH', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['Key'] }, typecast: true, records: rows.slice(i, i + 10).map((fields) => ({ fields })) }) });
      if (!r.ok) throw new Error(`Echo QRTs upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    console.log(`✓ ${rows.length} echo QRT(s) planned for draft ${slate.draftId} (${(slate.sisters || []).map((x) => x.account).join(', ') || 'no sister pages'}); they schedule themselves when the thread publishes.`);
    // The boosters' lines: Planned until a booster's thread-QRT slot takes one (docs/booster-lane.md).
    const boostMedia = {};
    if (memeLines.length) {
      const { uploadMeme } = await import('./qrt-meme.mjs');
      const tf = typefully(env);
      for (const b of memeLines) boostMedia[b.line] = await uploadBoostMemes(tf, b.template, memeTargets, uploadMeme);
    }
    const boost = boostRowsOf(slate, boostMedia).filter((r) => !boostLocked.has(r.Key));
    for (let i = 0; i < boost.length; i += 10) {
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${BOOST_TABLE}`, { method: 'PATCH', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['Key'] }, typecast: true, records: boost.slice(i, i + 10).map((fields) => ({ fields })) }) });
      if (!r.ok) throw new Error(`Booster QRTs upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    if (boost.length) console.log(`✓ ${boost.length} booster line(s) ready for the boosters' thread-QRT slots${memeLines.length ? `; ${memeLines.map((b) => `b${b.line} ${b.template} meme on ${Object.keys(boostMedia[b.line] || {}).length}/${memeTargets.length} booster page(s)`).join(', ')}` : ''}${boostLocked.size ? `; ${boostLocked.size} already taken, left alone` : ''}.`);
    return;
  }
  if (cmd === 'repair') {
    requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY']);
    const only = cliArg('draft'), APPLY = process.argv.includes('--apply');
    const waiting = waitingDrafts(await airtableRows(env, `AND({Status}='Planned', NOT({Quote URL})${only ? `, {Draft ID}='${only}'` : ''})`));
    const tf = typefully(env), { feedRow } = await import('./published-feed.mjs');
    let missed = 0, repaired = 0, failed = 0;
    for (const setId of new Set(waiting.map((g) => g.socialSetId))) {
      // One read per page: its latest published drafts. A thread not in them has not published yet.
      const page = await tf.listPage(`/social-sets/${setId}/drafts?status=published&order_by=-published_at`, { limit: 50 });
      const publishedAt = new Map(page.items.map((d) => [String(d.id), Date.parse(d.published_at)]));
      for (const g of waiting.filter((x) => x.socialSetId === setId)) {
        if (!(publishedAt.get(g.draftId) <= Date.now() - REPAIR_AFTER_MIN * 60000)) continue;
        missed++;
        try {
          const row = await feedRow({ draftId: g.draftId, socialSetId: setId, token: env.TYPEFULLY_API_KEY, get: (p) => tf.get(p) });
          if (!row) throw new Error('Typefully no longer reports it published');
          if (!APPLY) { console.log(`(dry) ${g.account} ${g.draftId}: published ${row['Published At']}; ${g.slots.join(', ')} never heard → would replay the scheduler`); continue; }
          for (const o of await replayScheduler({ row, token: env.TYPEFULLY_API_KEY, env, httpRequest: httpRequestOn() })) console.log(`✓ ${o.key}: ${o.action}${o.at ? ` at ${o.at}` : ''}`);
          repaired++;
        } catch (e) { failed++; console.error(`✗ ${g.account} ${g.draftId}: ${String(e.message || e).slice(0, 300)}`); }
      }
    }
    console.log(`${waiting.length} draft(s) waiting · ${missed} published but missed by the feed · ${APPLY ? `${repaired} repaired` : 'dry: pass --apply'}${failed ? ` · ${failed} FAILED` : ''}`);
    if (failed) process.exitCode = 1;
    return;
  }
  if (cmd === 'boost-media') {
    // Booster lines saved before their meme went with them (or a booster page whose upload failed): upload the missing
    // copies and add them to "Media IDs". Until then the booking node skips the line on that page; it never posts bare.
    requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY']);
    const days = Number(cliArg('days', 2)), APPLY = process.argv.includes('--apply');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { ACCOUNTS } = await import('./accounts.mjs');
    const rows = await airtableRows(env, `AND({Status}='Planned', IS_AFTER({Planned At}, '${since}'))`, BOOST_TABLE);
    const need = rows.map((r) => ({ r, targets: missingMemeTargets(r, ACCOUNTS) })).filter((x) => x.targets.length);
    if (!need.length) { console.log(`${rows.length} Planned booster line(s) since ${since.slice(0, 10)}: every meme line has its meme on every booster page.`); return; }
    const { uploadMeme } = await import('./qrt-meme.mjs');
    const tf = typefully(env);
    let fixed = 0;
    for (const { r, targets } of need) {
      const label = `${r['Thread Account']} ${r['Draft ID']} b${r.Line} ${r.Template}`;
      if (!APPLY) { console.log(`(dry) ${label}: would upload its meme to ${targets.map((t) => t.key).join(', ')}`); continue; }
      let have = {}; try { have = JSON.parse(r['Media IDs'] || '{}') || {}; } catch { have = {}; }
      const got = await uploadBoostMemes(tf, r.Template, targets, uploadMeme);
      const res = await fetch(`https://api.airtable.com/v0/${BASE}/${BOOST_TABLE}/${r.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { 'Media IDs': JSON.stringify({ ...have, ...got }) } }) });
      if (!res.ok) throw new Error(`Booster QRTs update ${res.status}: ${(await res.text()).slice(0, 200)}`);
      fixed++;
      console.log(`✓ ${label}: meme on ${Object.keys({ ...have, ...got }).length}/${targets.length + Object.keys(have).length} booster page(s)`);
    }
    console.log(`${need.length} meme line(s) missing a booster page's copy · ${APPLY ? `${fixed} updated` : 'dry: pass --apply'}`);
    return;
  }
  if (cmd === 'show') {
    requireEnv(env, ['AIRTABLE_PAT']);
    const days = Number(cliArg('days', 3)), account = cliArg('account');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await airtableRows(env, `AND(${account ? `{Account}='${account}', ` : ''}IS_AFTER({Planned At}, '${since}'))`);
    for (const r of rows.sort((a, b) => String(a['Draft ID']).localeCompare(String(b['Draft ID'])) || a['Offset Hours'] - b['Offset Hours']))
      console.log(`${r.Account?.padEnd(10)} ${r['Draft ID']} ${String(r.Slot).padEnd(8)} ${String(r.Status).padEnd(10)} ${r['Scheduled For'] || ''} ${r.Template} · ${String(r.Text || '').replace(/\n/g, ' / ').slice(0, 80)}`);
    const boost = await airtableRows(env, `AND(${account ? `OR({Thread Account}='${account}', {Booster}='${account}'), ` : ''}IS_AFTER({Planned At}, '${since}'))`, BOOST_TABLE);
    if (boost.length) console.log(`— booster lines (${boost.length})`);
    for (const r of boost.sort((a, b) => String(a['Draft ID']).localeCompare(String(b['Draft ID'])) || a.Line - b.Line))
      console.log(`${String(r['Thread Account']).padEnd(10)} ${r['Draft ID']} b${r.Line}      ${String(r.Status).padEnd(10)} ${r.Booster ? `${r.Booster} @ ${r['Scheduled For'] || ''}` : ''} ${r.Template} · ${String(r.Text || '').replace(/\n/g, ' / ').slice(0, 70)}`);
    return;
  }
  console.error('usage: node echo-qrt.mjs plan|check|save|show|repair|boost-media …'); process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
