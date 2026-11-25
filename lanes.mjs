// lanes.mjs — the canonical names for what a thread IS, and every historical spelling of them.
//
// Named 2026-08-29. Before this file the same lane answered to five different words: the week plan
// said `viral`, the thread record said `swipe`, the prose said "recreation", the script was called
// `recreate.mjs`, and the operator called it "the repost lane". Worse, `repost` was already taken —
// publish-thread stamps `contentLane: 'repost'` for a HARVEST, so the operator's word for one lane
// was the data's word for a different one. Six committed records carry it in that older sense.
//
// The three lanes are named for WHAT THEY DRAW ON, which is the only thing that actually separates
// them:
//
//   cover     another creator's thread. Keep the composition — the hook's shape, the item count,
//             the order, the numbering, everything LAW 5 and LAW 6 require you preserve — and
//             replace the performance: our words, our voice, our products. A cover version.
//   harvest   one of OUR published winners. The body is reused verbatim and only the hook is new.
//   seed      one of our own templates. One shape, many threads, across different subjects. It
//             replaces `mold`, whose stamping metaphor implied identical output, which is the
//             opposite of the intent and is the failure it kept producing.
//
// NOTHING IS REWRITTEN IN PLACE. Every plan file, every ledger row and all 64 records in
// queues/threads keep the value they shipped with; `laneOf` maps them forward on read. A migration
// that rewrites committed history to make a rename look tidy destroys the audit trail that makes
// revenue joinable, and the rename is not worth that.

/** The canonical three. Emit these; accept anything in ALIASES. */
export const LANES = Object.freeze(['cover', 'harvest', 'seed']);

/**
 * Every spelling that has ever meant one of the three, and what it means now.
 *
 * `repost -> harvest` is the one that must never be dropped: it is the ONLY meaning `repost` has
 * ever carried in this codebase (publish-thread's contentLane, daily-winners' REPOST_DOW bucket),
 * and reading it as `cover` would silently reclassify six shipped threads as somebody else's work.
 */
export const LANE_ALIASES = Object.freeze({
  viral: 'cover',      // the week plan's lane field
  swipe: 'cover',      // the thread record's contentLane, 44 records
  recreate: 'cover',   // recreate.mjs, and the prose that called this "a recreation"
  recreation: 'cover',
  mold: 'seed',
  pot: 'seed',         // the operator's word for a thread planted from a seed (/pot, the /run products stop)
  repost: 'harvest',   // publish-thread contentLane for a harvest, 6 records
  evergreen: 'harvest', // daily-winners' self-repost bucket
});

/** Normalise any historical lane spelling to its canonical name. Unknown values pass through
 *  lowercased rather than throwing: `blitz` is a real contentLane on three records and is not one
 *  of the three, and a namer should not break a reader. */
export function laneOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  return LANE_ALIASES[v] || v;
}

/** True when two lane names mean the same lane, whichever spelling each uses. */
export const sameLane = (a, b) => laneOf(a) === laneOf(b);

/** Display label for a lane — the spelling Airtable selects and dashboards show: 'Cover',
 *  'Harvest', 'Seed'. Non-lane values capitalize rather than throw ('blitz' -> 'Blitz'): three
 *  shipped records carry it, and a labeller must not break a reader any more than laneOf may. */
export const laneLabel = (value) => { const v = laneOf(value); return v ? v[0].toUpperCase() + v.slice(1) : ''; };

/** True for the three we actually plan and write. */
export const isKnownLane = (value) => LANES.includes(laneOf(value));

// ARTICLES (owner, R2026-10-03: "Every account should do ≥2 articles a week starting next week, built
// into the codebase for the next run"). A native X Article is a lane of its own, `article`, but not a
// fourth farm lane: like a single it posts BESIDE a page-day's money thread and never counts as it,
// and it stays out of the cover/harvest/seed mix (plan-check MIX, laws.json farm.phases). So it is
// deliberately not in LANES, and isKnownLane stays the farm's three.
export const ARTICLE_LANE = 'article';

// QUOTE POSTS (owner, 2026-10-03: every fleet thread quotes itself at +3h, +6h and +9h; the boosters
// quote fleet threads and Article-DB pieces). A QRT is one post that quotes another post, so it is never
// the page-day's money thread: like a single or an article it posts BESIDE it and holds only its
// minute. Before this lane existed here, the /run's occupancy read found no lane in an [Echo QRT] title,
// fell back to `cover`, and on 2026-10-05 held eleven pages' threads because each had an echo of the
// previous day's thread just after midnight Saigon.
export const QRT_LANE = 'qrt';
/** True for the titles the QRT lanes write: [Echo QRT], [Booster QRT], [QRT] (article-qrts), Cold QRT · (cold-qrt), QRT · (qrt-draft). */
export const isQrtTitle = (title) => /^\s*(?:\[(?:echo |booster )?qrt\]|(?:cold )?qrt\s*·)/i.test(String(title || ''));
/** Lanes that post beside a page-day's money thread without being it. */
export const ADDITIVE_LANES = Object.freeze(['single', ARTICLE_LANE, QRT_LANE]);
