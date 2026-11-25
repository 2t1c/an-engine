// qrt-boxes.mjs — each page's QRT settings, in the shape cold-qrt.mjs and qrt-queue.mjs read.
//
// Owner, 2026-10-02: "port into PI" (the cold QRT lane from 2t1c/genius, where a page's settings are its boxes.mjs
// `qrt` block, docs/toolkit.md there), and "No cadence yet — I want you to understand the structure and how it works".
// So every page starts from QRT_TEMPLATE with its cold lane OFF. A value the owner hasn't decided stays null and is
// listed in OPEN, never guessed (the toolkit's rule). Turning a page on is one entry in PAGES: `cold.on`, its
// `niches`, and whatever else the owner sets for it.
//
// What PI adds to Genius's settings, all read by cold-qrt.mjs fitOf:
//   - onlyNiches: a page quotes only articles in its own niches (GTX weighs niches but quotes any; a health page
//     quoting an AI tutorial would be off-brand under its name);
//   - neverQuote: handles a page never quotes (the roster also holds authors we track but would not put under our name);
//   - partner: null for every PI page (GTX's a16z network has no PI counterpart), so partner-tier rows are ineligible.
import { ACCOUNTS } from './accounts.mjs';
import { BOOSTERS, boosterDay } from './boosters.mjs';

export const QRT_TEMPLATE = Object.freeze({
  cold: Object.freeze({
    on: false,
    perDay: 2, // cold-qrt.mjs SLOTS: the NEW lane at 10:00 AM ET, the OLD lane at 3:00 PM ET (Genius's times)
    niches: null, // { 'Self Improvement': 1.5, … }: the page's topics and their weights (Articles {Niche} values)
    onlyNiches: true,
    offTypes: Object.freeze(['Tool Tutorial', 'Listicle']), // Genius's GTX filter; listicles are an open question for PI
    neverQuote: Object.freeze([]),
    partner: null,
    visuals: null, // Genius renders the GTX house chart; PI has no chart style for a QRT yet
  }),
  // qrt-queue.mjs spread: at most `max` QRTs a day, `minGapHours` apart, `postGapMin` from any other post. `windows`
  // null falls back to qrt-queue's default (14:00–18:00 and 19:00–22:00 Saigon) until the owner sets the page's own.
  daily: Object.freeze({ max: 2, minGapHours: 3, postGapMin: 45, windows: null }),
});

// THE BOOSTER PAGES (owner, 2026-10-03: "3 QRTs from the Article database" a day each; "go with the booster defaults";
// docs/booster-lane.md). Health topics lead; Psychology and Self Improvement were added on 2026-10-04 (owner: "yes we
// should"), weighted below them, because the health niches alone held 62 articles and none from the last 7 days.
// Their slots are the A times of their zig-zag day (boosters.mjs), the first one the NEW lane, and the boosters share one
// `group`: no two of them quote the same article on the same day. A line ships on its own only when it auto-passes
// (cold-qrt.mjs check); anything else waits for the owner's `approve`.
export const BOOSTER_NICHES = Object.freeze({ Health: 1.5, Fitness: 1.3, 'Mental Health': 1.2, Psychology: 1.1, 'Self Improvement': 1.0 });
const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
/** PURE. A booster's three cold slots, in cold-qrt.mjs SLOTS' shape. */
export function boosterColdSlots(key) {
  return boosterDay(key, '2026-01-05').filter((s) => s.kind === 'A').map((s, i) => {
    const d = new Date(s.at), h = d.getUTCHours(), m = d.getUTCMinutes();
    return Object.freeze({ saigon: hm((h + 7) % 24, m), utcHour: h, utcMinute: m, kind: i === 0 ? 'new' : 'old' });
  });
}

// Per-page settings over the template: every booster page (boosters.mjs; ten since 2026-10-06).
export const PAGES = Object.freeze(Object.fromEntries(BOOSTERS.map((k) => [k, Object.freeze({
  cold: Object.freeze({ on: true, perDay: 3, niches: BOOSTER_NICHES, group: 'boosters', slots: Object.freeze(boosterColdSlots(k)) }),
  daily: Object.freeze({ max: 3, minGapHours: 1, postGapMin: 5, windows: null }),
})])));

// What the owner's spec has to settle before a page's lane goes on (2026-10-02, the questions raised with the port).
// Per-page niches are not one of them: owner, 2026-10-07, "retire the concept of niche per page". A page that turns the
// cold lane on takes the fleet's topics (BOOSTER_NICHES), as the boosters do.
export const OPEN = Object.freeze([
  'which pages besides the boosters run the cold lane, and their cadence (owner 2026-10-02: "No cadence yet")',
  'whether listicles are quotable for our pages (cold.offTypes)',
  'the authors no page quotes (cold.neverQuote): the 14 held from the Article Watch roster on 2026-09-30 are still undecided',
  'each page\'s QRT windows and daily cap (daily)',
]);

const mergeCold = (over = {}) => ({ ...QRT_TEMPLATE.cold, ...over });
const mergeDaily = (over = {}) => ({ ...QRT_TEMPLATE.daily, ...over });

/** The account key for a key, display name or handle; null when none matches. */
export function keyOf(name) {
  const n = String(name || '').replace(/^@/, '').toLowerCase();
  return Object.keys(ACCOUNTS).find((k) => k.toLowerCase() === n || String(ACCOUNTS[k].handle || '').toLowerCase() === n || String(ACCOUNTS[k].name || '').toLowerCase() === n) || null;
}

/** A page's QRT box: { account, identity: { handle, xHandle, socialSetId, name }, qrt: { cold, daily }, open }. Throws
 *  for an unknown page. `pages` is for tests. */
export function boxOf(key, { pages = PAGES } = {}) {
  const k = keyOf(key);
  if (!k) throw new Error(`qrt-boxes: no page "${key}" in accounts.mjs`);
  const a = ACCOUNTS[k];
  const p = pages[k] || {};
  return {
    account: k,
    identity: { handle: a.handle, xHandle: a.handle, socialSetId: a.socialSetId, name: a.name },
    qrt: { cold: mergeCold(p.cold), daily: mergeDaily(p.daily) },
    open: [...OPEN],
  };
}

/** Every page whose cold lane is on (the booster pages: five since 2026-10-03, ten since 2026-10-06). */
export const coldPages = ({ pages = PAGES } = {}) => Object.keys(pages).filter((k) => pages[k]?.cold?.on && keyOf(k));
