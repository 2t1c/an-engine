// slots.mjs — shared open-slot finder. Each account has ordered daily slot TIMES
// (e.g. 9pm primary, 11:30pm emergency-backup). A day's slot is open if no draft is
// already scheduled at that exact HH:MM. Earlier times in the list are preferred.
const DAY = 864e5;
const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

// ---- POSTING WINDOWS (operator 2026-08-19) -------------------------------------------------------
// Replaces the single 6pm-Saigon point slot. Read off the analytics console: the publish grid peaks
// at 15:00 Saigon and the growth clock's three strongest hours are Sat 13:00-15:00, so the evening
// slot was landing well after the audience had already read. Two posts per account per day.
//
//   morning    06:00-07:30 Saigon  =  23:00 UTC (previous day) - 00:30 UTC
//   afternoon  13:00-15:30 Saigon  =  06:00-08:30 UTC
//
// Stored as SIGNED minutes relative to UTC midnight, because the 90-minute morning window (operator
// 2026-08-19) crosses midnight: 06:00 Saigon is 23:00 UTC the day BEFORE. A negative startMin is
// therefore normal, not a bug, and toClock() below is the only place allowed to fold it back onto a
// clock face. openSlots builds its datetime from UTC midnight plus {h,m}, so a 23:00 slot simply
// lands on the next Saigon morning; each account still gets exactly one morning and one afternoon
// slot per day either way.
// TWO LANES, TWO WINDOWS (operator 2026-08-27). The single afternoon window served a one-post day;
// the two-lane week posts twice, and the two lanes want opposite ends of the clock:
//
//   harvest  04:00-07:00 Saigon  =  21:00-00:00 UTC the PREVIOUS day   (startMin -180 .. 0)
//   cover    11:00-17:00 Saigon  =  04:00-10:00 UTC                    (startMin 240 .. 600)
//
// COVER WIDENED 2026-09-07 (operator: "widen from 11am to 17pm"). It was 13:00-15:00, two hours for
// twenty-two pages, which is a 5.7-minute gap — barely above MIN_SLOT_GAP_MIN and tight enough that
// the fleet reads mechanical. Six hours gives 17 minutes.
//
// What the widening is NOT based on: an audience-timing finding. 618 published threads with real
// publish timestamps say later inside the old window did better (13:00-14:00 Saigon median 84,748
// against 131,564 at 15:00-16:00, a 1.55x lead at p 0.06; 1.20x at p 0.16 with the lane held to
// covers only). Neither is significant — at this spread nothing under ~200% would be — and the
// 11:00-12:00 end of the new window is ground the fleet has never posted on at all. The operator
// widened it anyway to get covers out earlier, which is a reach bet, not a measured one. Worth
// re-reading once a few weeks of covers have landed across the full six hours.
//
// The signed-minute representation earns its keep again: harvest crosses midnight UTC, so 04:00
// Saigon on day D is 21:00 UTC on day D-1, which is a NEGATIVE offset from day D's UTC midnight.
// toClock folds it back and reports dayOffset -1; a caller that keys on a UTC date and ignores that
// books the thread 24 hours out. reslot.mjs already handles it, which is why the machinery stayed
// after the morning window was retired.
//
// Ordered CHRONOLOGICALLY (harvest first, at -180). reslot re-times a day's drafts in array order,
// so the array has to read the way the day does.
//
// Width check at 14 accounts, the fleet size the scale plan targets: viral 120 minutes gives a
// 9.2-minute gap and harvest 180 gives 13.8, both clear of MIN_SLOT_GAP_MIN.
import { sameLane } from './lanes.mjs';
import { typefully } from './lib.mjs';
import { isThreadRow } from './monitoring-scope.mjs';

// THE THREAD WINDOWS ARE THE ROUTING BLOCKS (2026-09-09). They were not, and the gap was live: the
// harvest window ran Saigon 04:00-07:00 while Sun ends at 05:00, so two of its three hours generated
// times in no block at all — and every one of the 9 threads found off-block on the 09-10/09-11 queue
// sat in exactly that 05:00-06:51 stretch. The grid was producing the defect the router then had to
// paper over with `meta.defaultBlock`. Cover had the smaller version of the same bug: it ran to
// 17:00 against Cloud's 16:00, so its last hour was off-block too.
//
// Saigon = UTC+7 and these minutes are offsets from UTC midnight, so Saigon hour H is (H - 7) * 60.
// (The ROUTING blocks have moved since: the live "Vendor Routes" row is "Cloud 11:00-17:00 · Moon
// 17:00-23:30", owner 2026-09-26, with Sun off it. This grid keeps its own 2026-09-23 windows below.
// Cloud and Moon route to one ladder, so the grid and the row need not share the 17:00 edge; what
// must hold is that every generated minute falls inside SOME routing block, and
// tests/bridge-routes.test.mjs walks the grid against the live row to pin exactly that.)
// Sun straddles UTC midnight and therefore carries a negative start; clockRanges is what knows that.
//   Sun   01:00-05:00 Saigon = -360 .. -120   (RETIRED 2026-09-13 — resolves, never generates)
//   Cloud 11:00-16:00 Saigon =  240 ..  540
//   Moon  17:00-23:30 Saigon =  600 ..  990   (widened 2026-09-13 to absorb Sun)
//
// A BLOCK CARRIES LANES, PLURAL (operator 2026-09-10: "Moon = sharing the load with Cloud · Cloud =
// Cover, Harvest, Seeds · Sun = prioritize Harvest and Seeds"). Until now `lane` was a single value
// and the mapping was 1:1 — one window, one lane — which is what let windowForUtc read a thread's
// LANE off its posting time. It also left Moon inert: a live routing block with no lane assignment,
// so nothing generated into it and its threads had to be moved there by hand.
//
// `lanes` is ORDERED BY THE BLOCK'S OWN PREFERENCE, so one array says both which lanes a block may
// carry and which it wants first. windowsForLane reads that order back: Sun lists harvest and seed
// ahead of cover, Cloud and Moon lead with cover, and a lane therefore gets its blocks back in the
// order the operator ranked them. Nothing is excluded — a lane can always fall through to a later
// block when its preferred one is full, which is the whole point of Moon sharing Cloud's load.
//
// What makes this safe is the OTHER half of the same instruction: one post per account per DAY,
// across every lane and block. A time no longer implies a lane, so windowForUtc stopped returning
// one — but with a single thread per account-day there is never a second lane to disambiguate, and
// the lane is carried on the draft where it was always known.
// SUN IS RETIRED AS A GENERATIVE BLOCK (operator 2026-09-13: "stop the SUN lane — it's not
// converting well. Rebalance more to the Moon lane"). It keeps its ROW here, with an empty `lanes`,
// and that distinction is the whole of the change:
//
//   - `lanes: []` makes windowsForLane skip it, so nothing is ever GENERATED into Sun again. This is
//     exactly the inert state Moon sat in before 2026-09-10, reached the same way.
//   - staying in POST_WINDOWS keeps windowForUtc able to RESOLVE a 01:00-05:00 Saigon time to a
//     block, which every already-scheduled Sun thread still needs. Deleting the row would make the
//     fleet's own history unreadable — verify-day would call each of those threads off-block, and
//     takenSlots would stop counting them against one-post-per-account-per-day.
//
// MOON RUNS TO 23:30 SAIGON (same instruction: "Moon lane may expand to as late as 11:30pm VN
// time"). 23:30 Saigon = 16:30 UTC = 990. It absorbs Sun's volume, which is why it is the block that
// got wider rather than Cloud.
//
// `share` IS THE DEAL, WIDTH IS ONLY ITS DEFAULT (operator 2026-09-15: "prioritize more in Cloud.
// Reschedule some posts to reflect that"). Until now the two blocks were dealt in proportion to how
// WIDE they are, which handed the majority to Moon purely because Moon is 6.5 hours to Cloud's 5.
// That was the right expression of the 09-13 instruction and it is the wrong expression of this one:
// the operator is asking which block gets the fleet's weight, and that is a judgement about when the
// audience is there, not about how much clock each block happens to own. So the weight is now stated
// outright rather than inferred from geometry. A block with no `share` still falls back to its width,
// which keeps Sun and any future block honest without a number nobody chose.
//
// 0.6/0.4 put 13 of 22 pages in Cloud and 9 in Moon, flipping a 45/55 split to 59/41. That note ended
// "0.6 is the first step, not a ceiling", and the operator took the next step on 2026-09-17: 0.65/0.35.
//
// 0.65/0.35 deals 14 Cloud / 8 Moon. Cloud absorbs the extra page without strain — 14 across its five
// hours sit 12 minutes apart at the early-bias narrowest, still well clear of the 5-minute collision
// floor — and Moon's 8 each gain room again (34 minutes at the narrowest). The direction is the same
// judgement as 09-15: which block gets the fleet's weight is about when the audience is there, not
// about how much clock each block owns, which is why the number is stated here and not inferred from
// the geometry. Moon remains the WIDER block and still takes the smaller half; that inversion is the
// assertion in test-scaffolds that fails if anyone reverts to dealing by width.
//
// 11:00-19:00 ICT IS THE PRIME WINDOW (owner, 2026-09-23: "for our posting schedule prioritize more posts
// posting from 11am to 7pm ICT"). Cloud now runs the whole prime window, 04:00-12:00 UTC (11:00-19:00
// ICT), closing the old 16:00-17:00 ICT gap between the blocks, and takes 0.8 of the fleet; Moon keeps
// the evening after it, 12:05-16:30 UTC (19:05-23:30 ICT), at 0.2. Moon opens five minutes after Cloud
// closes (MIN_SLOT_GAP_MIN) so Cloud's last page (18:59) and Moon's first can never collide.
export const POST_WINDOWS = [
  { name: 'sun', block: 'Sun', startMin: -6 * 60, endMin: -2 * 60, lanes: [] },
  { name: 'cloud', block: 'Cloud', startMin: 4 * 60, endMin: 12 * 60, lanes: ['cover', 'harvest', 'seed'], share: 0.8 },
  { name: 'moon', block: 'Moon', startMin: 12 * 60 + 5, endMin: 16.5 * 60, lanes: ['cover', 'harvest', 'seed'], share: 0.2 },
];
/** The blocks a lane can actually be generated into — POST_WINDOWS minus the retired ones. Sun is
 *  still a member of POST_WINDOWS so its history resolves; it is not a member of this. */
export const GENERATIVE_WINDOWS = POST_WINDOWS.filter((w) => (w.lanes || []).length);
// Derived, not restated: Moon is a member of POST_WINDOWS now, and inMoon/singleSlotIssue still need
// to ask about it by name for the singles-sharing rule.
export const MOON_BLOCK = POST_WINDOWS.find((w) => w.block === 'Moon');

// The SINGLES lane (plan-singles.mjs) posts 3-5 filler singles per account per day and deliberately
// does NOT use the slot grid above: it places times with a PRNG seeded on (account, week), because
// an even spread by alphabetical index reads as automation once it is hundreds of posts a week
// rather than two a day. It lives here anyway so there is ONE definition of the window — the skill
// prose is checked against it — but it stays OUT of POST_WINDOWS on purpose. windowForUtc maps a
// time to a LANE, and this window contains the whole cover window; adding it would make that
// mapping ambiguous for every cover thread.
// TWO singles windows since 2026-09-07 (operator, after Run 2: "a more fixed schedule for the
// single tweets, so it doesn't overlap with your threads"). Run 2 placed singles across
// 13:00-22:00 Saigon, straight over the cover grid, and every day needed a retime pass — 18 singles
// within a minute of a money thread over four days. A single inside a thread window is a verify-day
// defect now, not something to move by hand on the day.
//
// SEPARATION IS ONE HOUR (operator 2026-09-07, set alongside the 11:00-17:00 cover window). It was
// briefly two, which the wider cover lane leaves no room for: two hours of clearance either side of
// a six-hour cover window erases the morning entirely and drops the lane to four slots against a
// 3-5 spec. One hour keeps both windows and six slots. The clearance is measured from the THREAD
// windows above, so these two are derived, not typed:
//
//   harvest ends 07:00 Saigon  ->  +1h  ->  singles am 08:00-10:00  ->  -1h  ->  cover starts 11:00
//   cover   ends 17:00 Saigon  ->  +1h  ->  singles pm 18:00-22:00
// SINGLES KEEP THE EVENING, AND SHARE IT (operator 2026-09-09). Moving the thread windows onto the
// blocks put single-pm (18:00-22:00 Saigon) entirely inside Moon (17:00-22:00), so the 09-07 rule —
// a single is never inside a thread window — could only have been kept by evicting singles to
// 06:00-10:00 plus 23:00-00:00. That is 5 hours against 6, it deletes the evening, and the evening
// is where 20-30 singles a day are actually booked.
//
// So inside MOON ONLY the rule relaxes from "never overlap" to "stay MOON_THREAD_GAP_MIN from any
// thread". Threads still claim their minute first and singles fill around them. Everywhere else the
// original rule is untouched: a single in Sun or Cloud is still a defect.
export const SINGLES_WINDOWS = [
  { name: 'single-am', startMin: 1 * 60, endMin: 3 * 60 },           // 08:00-10:00 Saigon
  { name: 'single-pm', startMin: 12 * 60, endMin: 15 * 60 },         // 19:00-22:00 Saigon (owner 2026-09-23: 11:00-19:00 ICT is the thread prime window)
];
/** Clearance a single must keep from a thread inside Moon, where the two lanes share the window. */
export const MOON_THREAD_GAP_MIN = 30;
/** PURE. Is this UTC clock minute inside the Moon block? */
export const inMoon = (min) => inAnyWindow(min, [MOON_BLOCK]);
/**
 * PURE. Why this single's minute is illegal, or null if it is fine. `threadMins` are the thread
 * minutes already placed on the same Saigon day.
 *
 * The two rules are different on purpose and the reason is the whole point of the 09-09 decision:
 * Sun and Cloud are exclusive because nothing else is booked there, while Moon is shared because
 * the singles were there first and there are hundreds of them.
 */
export function singleSlotIssue(min, threadMins = []) {
  if (!inSinglesWindow(min)) return 'outside both singles windows';
  if (inMoon(min)) {
    const near = (threadMins || []).find((t) => Math.abs(t - min) < MOON_THREAD_GAP_MIN);
    return near == null ? null : `${Math.abs(near - min)}min from a thread in Moon (needs ${MOON_THREAD_GAP_MIN})`;
  }
  return inThreadWindow(min) ? 'inside a thread window' : null;
}
// The ENVELOPE of the singles windows (first start to last end), kept for the callers that only
// bound a day (resync/verify) — anything inside the envelope but outside SINGLES_WINDOWS is the
// cover gap, and inSinglesWindow is the test that knows the difference.
export const SINGLES_WINDOW = { name: 'single', startMin: SINGLES_WINDOWS[0].startMin, endMin: SINGLES_WINDOWS[SINGLES_WINDOWS.length - 1].endMin };
// The first day the window law is enforced by verify-day / verify-singles. Everything already on
// Typefully was planned under the old 13:00-22:00 window and stays exactly as booked (operator
// 2026-09-07: "we will implement from the next run, this time it is fine"). Singles are scheduled
// through 2026-09-22, so the law binds on the 23rd — the first day nothing is booked. Set to the
// 14th when the windows first changed, which was wrong: it would have flagged 302 booked singles,
// 70 of them outside the new windows, on a week nobody was going to re-plan.
export const SINGLES_WINDOWS_FROM = '2026-09-23';
/**
 * PURE. The clock-face range(s) a window occupies, as [lo, hi, dayShift] triples.
 *
 * A window with a NEGATIVE start straddles UTC midnight and therefore has TWO ranges: the
 * pre-midnight part, which sits on the previous clock day and serves the day after it, and the part
 * from 00:00 to endMin, which sits on and serves the target day. Folding both onto one range reports
 * a draft at exactly 00:00 as belonging to the following day.
 *
 * This existed three times — inThreadWindow, windowForUtc and an inlined copy in
 * schedule-warmup.mjs — and only windowForUtc's carried the dayShift. Two of the three therefore
 * answered "is this in a window" correctly while being unable to say WHICH DAY's window, which is
 * the half that books a thread 24 hours out. One definition, and dayShift travels with it.
 */
// THE END IS EXCLUSIVE, because routing.mjs's is: its test pins at('21:59')='Moon' and at('22:00')=''.
// Ranges here are compared with `min <= hi`, so hi is the LAST LEGAL MINUTE — one before the block
// ends. Without this the generator could place a thread at exactly 22:00 Saigon and the router would
// call it off-block: the same generator/router disagreement that put 9 threads in no block at all,
// one minute wide instead of two hours. The constants above stay readable as the operator's hours.
const lastMin = (e) => e - 1;
export function clockRanges(win) {
  const { startMin: s } = win; const e = lastMin(win.endMin);
  if (s >= 0) return [[s, e, 0]];                       // an ordinary same-day window
  // WHOLLY pre-midnight (both ends negative) is ONE range, not two. The old two-range form assumed
  // any negative start straddled midnight, which was true only while the harvest window ended at
  // exactly 0. Sun is -360..-120, and under that assumption it produced [[1080,1439],[0,-120]] — a
  // dead second range and a first that ran to midnight, i.e. Sun reported as 01:00-07:00 Saigon
  // instead of 01:00-05:00. Two of the hours it then claimed are Cloud's morning approach.
  if (e <= 0) return [[1440 + s, 1440 + e, 1]];
  return [[1440 + s, 1439, 1], [0, e, 0]];              // genuinely straddling UTC midnight
}
/** PURE. Is this UTC clock minute inside any of `windows`? Wrap-aware via clockRanges. */
export const inAnyWindow = (min, windows) =>
  (windows || []).some((w) => clockRanges(w).some(([lo, hi]) => min >= lo && min <= hi));
/** PURE. Is this UTC clock minute inside one of the singles windows? */
export const inSinglesWindow = (min) => inAnyWindow(min, SINGLES_WINDOWS);
/** PURE. Is this UTC clock minute inside a THREAD window? Since 2026-09-09 the thread windows ARE
 *  the three routing blocks, so this answers "does a post here draw a block" as well. */
export const inThreadWindow = (min) => inAnyWindow(min, POST_WINDOWS);

// The window a lane posts in. Null lane = every window, which is what the schedulers that place a
// whole day (fill-queue, reslot, daily-winners) want.
// The blocks that carry `lane`, BEST FIRST. Rank is the lane's position in each block's own `lanes`
// list, so Sun leads for harvest and seed while Cloud and Moon lead for cover; ties keep chronological
// order, which is why Cloud comes before Moon when both want a lane equally. Omit `lane` for the
// whole-day view the fill and reslot tools want.
export const windowsForLane = (lane) => {
  // No lane = the whole-day view fill/reslot want. It is GENERATIVE_WINDOWS, not POST_WINDOWS: a
  // retired block must not receive a draft from a tool that simply did not name a lane, which is
  // exactly how Sun would quietly come back to life.
  if (!lane) return GENERATIVE_WINDOWS;
  const rank = (w) => (w.lanes || []).findIndex((l) => sameLane(l, lane));
  return POST_WINDOWS.filter((w) => rank(w) >= 0).sort((a, b) => rank(a) - rank(b));
};

// Fold a signed minute offset onto a UTC clock face. dayOffset is -1 for the pre-midnight part of
// the morning window, 0 otherwise — callers that key on a UTC DATE (not just a time) need it.
export function toClock(min) {
  const dayOffset = Math.floor(min / 1440);
  const inDay = min - dayOffset * 1440;
  return { h: Math.floor(inDay / 60), m: inDay % 60, dayOffset };
}

// Typefully schedules on its own polling tick, so two drafts booked less than ~5 minutes apart can
// land in the same minute. Observed 2026-08-19: three accounts booked 3-5 min apart published
// within 150 seconds of each other, which is the exact pattern the spread exists to avoid.
export const MIN_SLOT_GAP_MIN = 5;

/**
 * PURE. Every pair closer than `gap` minutes: each proposed post against every other proposed post
 * AND against every post already on the day (threads and singles alike — Typefully's polling tick does
 * not care which). Posts are { name, ms }. schedule-day used to check the proposed posts only against
 * each other, so a new thread could land a minute from a single that was already booked.
 */
export function spacingFailures(proposed, existing = [], gap = MIN_SLOT_GAP_MIN) {
  const out = [];
  const sorted = [...proposed].sort((a, b) => a.ms - b.ms);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const d = (sorted[j].ms - sorted[i].ms) / 60e3;
      if (d < gap) out.push(`${sorted[i].name} -> ${sorted[j].name} only ${d}min apart`);
    }
    for (const e of existing) {
      const d = Math.abs(sorted[i].ms - e.ms) / 60e3;
      if (d < gap) out.push(`${sorted[i].name} is ${d}min from ${e.name}, already on the day`);
    }
  }
  return out;
}

// EARLIER IS BETTER INSIDE A WINDOW (operator 2026-09-13: "Prioritize earlier in the windows"),
// which arrived with the instruction that widened Moon to 6.5 hours. An even spread across a window
// that wide puts half the fleet after 20:15 Saigon; the operator wants the mass at the front and the
// tail used only because the volume needs somewhere to go.
//
// The bias is an EXPONENT on each account's fractional position, not a cutoff: position f becomes
// f^EARLY_BIAS, so slots compress toward the start and stretch toward the end while still covering
// the whole window. 1.0 would be the old even spread. At 1.4 the middle account of a 5-hour Cloud
// lands 114 minutes in (12:54 Saigon) instead of 150 (13:30), and the last account still sits at the
// window's end — nothing is bunched into a corner and no slot moves outside its block.
//
// 1.25 is bounded by the WORST case the grid has to survive, which is not the normal one: the
// no-lane whole-day view spreads the ENTIRE fleet across each block on its own, so 23 accounts land
// in Cloud's 5 hours rather than the 9 a real cover day puts there. At 1.25 that worst case still
// opens 9.2 minutes at the front (and the real Run-4 shape, 9 in Cloud and 13 in Moon, gives 22.4
// and 18.6). At 1.4 the same worst case drops to 4.2 and breaches MIN_SLOT_GAP_MIN, which is the
// Typefully same-minute collision this floor exists to prevent. The front-loading is still real:
// the middle account of a Cloud day sits at 13:06 Saigon instead of 13:30, and of a Moon day at
// 19:44 instead of 20:15.
export const EARLY_BIAS = 1.25;

// Pure: spread N accounts across one window, weighted toward its start by EARLY_BIAS. Returns minute
// offsets, and says out loud when the window is too narrow to hold them at MIN_SLOT_GAP_MIN — a
// caller that ignores the warning gets clustered posts, which is worse than a window that is
// honestly too small. `gap` is the NARROWEST actual gap (under a bias the gaps differ, and the
// smallest is the only one that can breach the floor). Exported for tests.
// BLOCK-END CLAMP (2026-09-23). The last page of a block used to land ON endMin, which is exclusive
// (see lastMin below): violet at 16:00 Saigon and tina at 23:30 Saigon sat one minute outside their
// blocks, so any legality check would hold them. The spread still covers the whole block; its last
// slot is now the block's last legal minute (15:59, 23:29).
export function spreadWindow(win, n, bias = EARLY_BIAS) {
  const span = win.endMin - win.startMin;
  if (n <= 1) return { minutes: [win.startMin], gap: span, tight: false };
  const minutes = Array.from({ length: n }, (_, i) => Math.min(lastMin(win.endMin), Math.round(win.startMin + span * ((i / (n - 1)) ** bias))));
  const gap = Math.min(...minutes.slice(1).map((m, i) => m - minutes[i]));
  return { minutes, gap, tight: gap < MIN_SLOT_GAP_MIN, need: Math.ceil((n - 1) * MIN_SLOT_GAP_MIN) };
}

/**
 * PURE. Deal `n` accounts across tied blocks in proportion to each block's stated `share` —
 * its WIDTH when it states none — and return
 * `owner[i]` = the index of the block account i belongs to, plus the final `counts` per block.
 *
 * WHY A WEIGHTED DEAL AND NOT AN EVEN SPLIT (operator 2026-09-13: "Rebalance more to the Moon lane",
 * then 2026-09-15: "prioritize more in Cloud"). The original rule was `i % k` — a straight
 * round-robin that hands Cloud and Moon the same number of pages, which ignored both instructions
 * and split Sun's retired volume down the middle. A weighted deal answers either one by changing a
 * number rather than the algorithm: 09-13 was served by the blocks' widths (Moon is 6.5 hours to
 * Cloud's 5, so Moon took 13 of 22), and 09-15 by the explicit `share` on POST_WINDOWS (Cloud takes
 * 13). Width remains the fallback weight for any block that states no share.
 *
 * WHY NOT A CONTIGUOUS CUT. Slicing the sorted fleet at 43% would put the alphabetically-early pages
 * in Cloud forever. This is the largest-remainder (Webster) deal: at every step the block furthest
 * BELOW its target share takes the next account, so the two blocks interleave down the list the way
 * `i % k` did while still landing on the weighted totals. Deterministic and stable under the same
 * key set, which is what the whole slot grid depends on.
 */
export function dealByShare(blocks, n) {
  const widths = blocks.map((w) => w.endMin - w.startMin);
  const span = widths.reduce((a, b) => a + b, 0);
  // A block states its own share, or inherits its width as one. Normalised either way, so a partial
  // set of shares (or none at all) still deals to exactly n.
  const raw = blocks.map((w, i) => (Number.isFinite(w.share) ? w.share : widths[i] / span));
  const total = raw.reduce((a, b) => a + b, 0);
  const counts = blocks.map(() => 0);
  const owner = [];
  for (let j = 0; j < n; j++) {
    let best = 0; let bestDeficit = -Infinity;
    for (let b = 0; b < blocks.length; b++) {
      const deficit = (raw[b] / total) * (j + 1) - counts[b];
      if (deficit > bestDeficit) { bestDeficit = deficit; best = b; }
    }
    counts[best] += 1;
    owner.push(best);
  }
  return { owner, counts };
}

// The fleet list slot POSITION is computed against. Every caller must pass the SAME list or the
// same account gets different times from different tools: on 2026-08-20 daily-winners passed its
// 9-account HEALTH list while run-weekly passed all 11 keys, so Julian's afternoon slot moved
// depending on which engine scheduled it. Pure (takes ACCOUNTS rather than importing it) so
// slots.mjs stays dependency-free and testable.
//
// The list is every posting account, INCLUDING paused ones. Pausing an account must not shift the
// other eight onto new clock times — an erratic publish clock reads as a bot, which is the exact
// thing the deterministic spread exists to avoid.
export function fleetSlotKeys(accounts) {
  return Object.entries(accounts).filter(([, a]) => a.plugHeavyExample).map(([k]) => k).sort();
}

// The two daily slots for ONE account, as {h,m} UTC. Deterministic on the account's position in the
// fleet list: the same page posts at the same two times every day (an erratic clock reads as a bot)
// while nine pages never share a minute.
// `lane` narrows it to that lane's window — the planner places one slot at a time and has to know
// WHICH window it is filling, because the two are 15 hours apart and one of them is on the previous
// UTC day. Omitting lane returns every window, the whole-day view the fill/reslot tools want.
export function accountSlots(key, keys, lane = null) {
  const list = [...keys].sort();
  const i = Math.max(0, list.indexOf(key));
  const wins = windowsForLane(lane);
  if (!wins.length) return [];
  // SHARING THE LOAD (operator 2026-09-10: "Moon = sharing the load with Cloud"). Two blocks can now
  // want a lane equally — Cloud and Moon both lead with cover — and handing every account the first
  // of them would leave the second empty, which is precisely the state Moon was already in. So for a
  // TIE the fleet is partitioned by account index, and an account spreads only against the share that
  // landed in its own block: 20 covers become 10 in Cloud and 10 in Moon, each spread across its own
  // four or five hours rather than 20 crammed into one. Deterministic and stable under the same key
  // set, exactly like the minute grid it feeds.
  //
  // Blocks that merely ALLOW the lane (Sun for a cover, rank 2) are not part of the tie. They stay in
  // the returned list, after the chosen one, as the overflow a caller walks to when the preferred
  // block is full — spread against the whole fleet, since nothing was partitioned into them.
  const rank = (w) => (w.lanes || []).findIndex((l) => sameLane(l, lane));
  const tied = lane ? wins.filter((w) => rank(w) === rank(wins[0])) : [];
  // The tie is dealt BY SHARE now, not round-robin — see dealByShare. `owner[i]` is this account's
  // block and `counts` is how many pages that block ends up holding, so the spread below is against
  // the block's OWN share rather than the whole fleet.
  const deal = tied.length > 1 ? dealByShare(tied, list.length) : null;
  const mine = deal ? tied[deal.owner[i]] : null;
  const ordered = mine ? [mine, ...wins.filter((w) => w !== mine)] : wins;
  return ordered.map((w) => {
    const isMine = w === mine;
    const share = isMine ? deal.counts[deal.owner[i]] : list.length;
    // Position WITHIN the block: how many earlier accounts the deal put in the same block.
    const pos = isMine ? deal.owner.slice(0, i).filter((o) => o === deal.owner[i]).length : i;
    const m = spreadWindow(w, share).minutes[pos];
    return { ...toClock(m), window: w.name, block: w.block };
  });
}

/**
 * Which posting window a UTC instant belongs to, and which TARGET DAY that window serves.
 *
 * Not the same question as "what date is it". The harvest window runs 21:00-00:00 UTC and serves
 * the NEXT day (its offsets in POST_WINDOWS are negative for exactly this reason), so a draft at
 * 22:00 on the 30th is the 31st's harvest post. A day-level rule that ignored that would let an
 * account take the same lane twice and call it two different days.
 *
 * Returns null for a time in neither window — a hand-placed draft outside both, which still
 * occupies the account's attention but cannot be reasoned about per-lane.
 */
/** PURE. The whole fleet's cover-window grid as key -> "HH:MM" (UTC), spread evenly across the
 *  window and stable under the SAME key set. This is the one definition of what minute a page posts
 *  at, and it exists because a 42-thread run on 2026-09-03 was published against a grid typed out by
 *  hand and carried across three days. That works exactly once: the next writer types a different
 *  one, the same account drifts to a different minute each run, and nothing can tell the drift from
 *  a decision.
 *
 *  Derived, so it is reproducible; written into the run plan, so it is stable even when the key set
 *  changes mid-batch (a page paused on day 2 must not shift everyone else's slot on day 3). Callers
 *  that want stability across a batch should persist the result, not recompute it — which is exactly
 *  what `plan.grid` is for. */
export function coverGrid(keys, lane = 'cover') {
  const list = [...keys].sort();
  const pad = (n) => String(n).padStart(2, '0');
  const out = {};
  for (const k of list) {
    const slot = accountSlots(k, list, lane)[0];
    if (slot) out[k] = `${pad(slot.h)}:${pad(slot.m)}`;
  }
  return out;
}

export function windowForUtc(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const w of POST_WINDOWS) {
    const hit = clockRanges(w).find(([lo, hi]) => min >= lo && min <= hi);
    if (hit) {
      const dayShift = hit[2];
      const target = new Date(d);
      target.setUTCDate(target.getUTCDate() + dayShift);
      return { block: w.block, window: w.name, day: target.toISOString().slice(0, 10) };
    }
  }
  return null;
}

// Set of "YYYY-MM-DD@HH:MM" (UTC) for each of `times` a scheduled draft sits on, or within
// MIN_SLOT_GAP_MIN of (takenKeys).
//
// ALSO returns a "YYYY-MM-DD" key for every scheduled thread, whatever time it sits at (2026-08-29).
// The time-keyed answer alone is the wrong question: asking "is 06:24 free" says nothing about an
// account that already posts at 06:00. Nine accounts were double-booked onto 2026-08-31 that way,
// every one of them reported "free" because the pre-existing draft sat at a different minute of the
// same window.
//
// The key was "YYYY-MM-DD#lane" until 2026-09-10, when the operator made the rule ONE POST PER
// ACCOUNT PER DAY regardless of lane. Dropping the lane from the key is the whole of that change
// here — and it is also what lets a block carry several lanes, since a day now has one thread and
// never needs its lane inferred from the clock. THREADS ONLY: singles keep their own windows and
// their own 3-5 a day, and never pass through takenSlots. A queued single or X Article holds only the
// minutes around it, never the day (owner, R2026-10-03: articles are additive).
export async function takenSlots(env, socialSetId, times) {
  // RETRYING READ THAT THROWS (2026-08-30). This was a bare fetch with `if (!r.ok) break`, i.e. a
  // transient 429 ended the scan early and every unread scheduled draft became invisible — which
  // here means a TAKEN slot reports FREE. That is the same double-booking the note above this
  // function describes, arriving by a different door: nine accounts were double-booked onto
  // 2026-08-31 because the occupancy question was asked the wrong way, and a short read answers it
  // wrongly no matter how well it is phrased. A caller that cannot see the queue must fail, not
  // guess that the queue is empty.
  const tf = typefully(env);
  const drafts = [];
  for (let offset = 0; ; offset += 50) {
    const j = await tf.get(`/social-sets/${socialSetId}/drafts?status=scheduled&limit=50&offset=${offset}`);
    drafts.push(...(j.results || []));
    if (!j.next || !(j.results || []).length) break;
  }
  return takenKeys(drafts, times);
}

/** PURE. takenSlots' answer from the scheduled drafts it read: `YYYY-MM-DD@HH:MM` for each of `times`
 *  within MIN_SLOT_GAP_MIN of a scheduled draft, and the `YYYY-MM-DD` page-day of each scheduled THREAD.
 *  A standalone single or a native X Article is additive (lanes.mjs ADDITIVE_LANES; owner, R2026-10-03:
 *  articles are additive): it keeps the minutes around it, but never takes the page-day's one thread.
 *  The drafts LIST carries no platforms, so only a title says article here: scripts/run-articles.mjs
 *  titles every article it makes ([REVIEW] … · article — under review, [Article] once scheduled). */
export function takenKeys(drafts, times) {
  const taken = new Set();
  for (const d of drafts) {
    const ms = Date.parse(d?.scheduled_date || '');
    if (!Number.isFinite(ms)) continue;
    // Each slot time on the draft's UTC date or either neighbour (23:58 is three minutes from 00:01).
    for (const t of times) for (const shift of [-1, 0, 1]) {
      const slot = new Date(ms);
      slot.setUTCHours(t.h, t.m, 0, 0);
      slot.setUTCDate(slot.getUTCDate() + shift);
      if (Math.abs(slot.getTime() - ms) < MIN_SLOT_GAP_MIN * 60e3) taken.add(`${slot.toISOString().slice(0, 10)}@${hm(t.h, t.m)}`);
    }
    // The DAY, recorded for EVERY scheduled thread rather than only ones landing on a slot time.
    if (!isThreadRow(d)) continue;
    const w = windowForUtc(d.scheduled_date);
    if (w) taken.add(w.day);
  }
  return taken;
}

// Next `n` open slots over maxDays, preferring earlier `times` each day (primary before emergency).
// opts.spread: instead of packing the earliest n slots, sample n slots EVENLY across all the open
// slots in the horizon — leaves gaps between scheduled posts so freshly-viral drafts always have a
// near slot to land in (stops same-batch posts clustering back-to-back).
export function openSlots(taken, n, maxDays, times, opts = {}) {
  const all = [], now = Date.now();
  for (let i = 0; i < maxDays; i++) {
    for (const t of times) {
      const dt = new Date(); dt.setUTCHours(0, 0, 0, 0); dt.setUTCDate(dt.getUTCDate() + i); dt.setUTCHours(t.h, t.m, 0, 0);
      if (dt.getTime() <= now) continue;
      if (taken.has(`${dt.toISOString().slice(0, 10)}@${hm(t.h, t.m)}`)) continue;
      // ONE POST PER ACCOUNT PER DAY (operator 2026-09-10), across every lane and block. It was
      // per-LANE per day from 2026-08-29, which let one account take a harvest and a cover on the
      // same date; the fleet had already settled into one a day in practice, and this makes the
      // invariant the thing the scheduler enforces rather than a pattern it happened to produce.
      // Pass onePerDay:false to place a second thread on a day deliberately.
      if (opts.onePerDay !== false) {
        const w = windowForUtc(dt.toISOString());
        if (w && taken.has(w.day)) continue;
      }
      all.push(dt.toISOString());
    }
  }
  if (!opts.spread || all.length <= n) return all.slice(0, n);
  const step = all.length / n, out = []; // even sampling across the whole horizon
  for (let k = 0; k < n; k++) out.push(all[Math.floor(k * step)]);
  return out;
}
