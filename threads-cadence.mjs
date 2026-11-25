// threads-cadence.mjs — how a Threads page's day is SHAPED, as opposed to how many posts it holds.
//
// WHY THIS EXISTS (operator, 2026-09-16: "for Threads safety, we should mix up the posting time and
// then once a week have an intentional rest day, or some other patterns so the page seems more
// natural"). The slot grid that serves X is deliberately the opposite of natural: every page owns one
// fixed minute and posts on it every single day, because an erratic publish clock reads as a bot to
// the operator's own eye and makes the fleet's history unreadable. That trade is right for X, where
// the grid's job is collision-avoidance across 22 pages.
//
// On Threads it is the wrong trade. A page that posts four times a day, every day, at minutes that
// never move is describable in one sentence by anyone looking — and Threads is the platform where the
// fleet has already lost an account's publishing to a silent, unexplained block. So Threads gets its
// own cadence: times that move day to day, and one deliberate day off a week.
//
// SCOPE IS THREADS ONLY (same instruction: "This is only for threads. I think X is fine"). Nothing
// here touches the X grid in slots.mjs, and the X cross-post keeps its grid minute — its Threads copy
// rides the money thread and the money thread does not move.
//
// DETERMINISTIC, NOT RANDOM. Every function here is a pure function of (page, day). The same day
// always computes the same times, because the shipper is resumable and a re-run that moved every post
// would double-book the page. "Mixed up" means unpredictable to a reader, not unpredictable to us.

/** 14:00-23:00 Saigon, in UTC minutes — the window the operator set for Threads on 2026-09-13. */
export const THREADS_WINDOW = [7 * 60, 16 * 60];
/** A page's own posts stay this far apart (operator: "at least 1h30 min apart"). */
export const THREADS_GAP_MIN = 90;
/** Two different pages never publish inside this many minutes of each other — the same collision
 *  floor the X grid keeps, for the same reason: three pages in one minute reads as one operator. */
export const FLEET_GAP_MIN = 5;
/** Times land on this lattice. Finer than a minute buys nothing and makes the search slower. */
export const STEP_MIN = 5;

const DAY_MS = 86400000;

/** PURE. A small deterministic PRNG (mulberry32) seeded from a string. Not for anything security
 *  shaped — it exists so "mix up the times" is reproducible: same page, same day, same answer. */
export function seeded(key) {
  let h = 2166136261;
  for (let i = 0; i < String(key).length; i++) { h ^= String(key).charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Whole days since the epoch for a YYYY-MM-DD string. Pure; no local-timezone reading. */
export const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

/**
 * PURE. Which weekday is this page's Threads rest day in the week containing `day`?
 *
 * SEPARATE PER PAGE (operator: "each page would have a seperate rest day"). A fleet-wide day off is
 * itself a signature — sixteen pages going quiet on the same Sunday is more machine-like than any of
 * them posting. Dealing by the page's index spreads the rest days across the week, so on any given
 * day two or three pages of sixteen are dark and the rest are not.
 *
 * AND IT DRIFTS. A page that is always dark on Tuesday has simply traded a daily pattern for a weekly
 * one, so the rest weekday rotates each week and every weekday eventually gets covered.
 *
 * IT DRIFTS BY THREE, NOT BY ONE. The epoch week rolls on a Thursday, so a +1 rotation can put a
 * page's rest day on the last day of one week and the first day of the next — two dark days in a row,
 * which reads as an abandoned page rather than a day off, and it was doing exactly that to julian and
 * rafael on 09-23/09-24. Three is coprime with seven, so it still visits every weekday, and it never
 * lands adjacent across the boundary.
 */
export function restWeekdayFor(page, pages, day) {
  const list = [...pages].sort();
  const i = list.indexOf(page);
  if (i < 0) return -1;                                   // not a Threads page: it has no rest day
  const week = Math.floor(dayNumber(day) / 7);
  return (i + week * 3) % 7;
}

/** PURE. Is `day` this page's rest day? UTC weekday of the plan's own date string. */
export function isRestDay(page, pages, day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return restWeekdayFor(page, pages, day) === dow;
}

/**
 * PURE. `count` minutes for one page on one day: inside the window, at least THREADS_GAP_MIN from
 * each other and from every `fixed` time (the X cross-post, anything already published), and at least
 * FLEET_GAP_MIN off any minute in `claimed` that another page holds.
 *
 * THE JITTER IS A TARGET, NOT THE ANSWER. The window is cut into `count` bands and the seeded draw
 * picks a target inside each one, so the posts stay spread across the day instead of clustering
 * wherever the RNG happened to land. Each target is then snapped outward to the nearest minute that
 * satisfies every rule. Band-relative jitter is what keeps the shape recognisable (morning, afternoon,
 * evening, night) while the exact minutes move — which is how a person posts, and a fixed grid is not.
 *
 * Returns null when the day genuinely cannot hold `count` posts, so the caller reports a shortfall
 * instead of quietly dropping one.
 */
export function cadenceSlots({ page, day, count, fixed = [], claimed = [], window = THREADS_WINDOW, gap = THREADS_GAP_MIN, earliest = null }) {
  if (count <= 0) return [];
  const lo = Math.max(window[0], earliest == null ? window[0] : earliest), hi = window[1];
  if (lo > hi) return null;
  const rand = seeded(`${page}|${day}`);
  const band = (hi - lo) / count;
  const targets = Array.from({ length: count }, (_, k) => {
    const start = lo + band * k;
    return Math.round((start + rand() * band) / STEP_MIN) * STEP_MIN;
  });
  const chosen = [];
  const legal = (t) => t >= lo && t <= hi
    && fixed.every((f) => Math.abs(t - f) >= gap)
    && chosen.every((c) => Math.abs(t - c) >= gap)
    && !claimed.some((c) => Math.abs(c - t) < FLEET_GAP_MIN);
  for (const target of targets) {
    let pick = null;
    for (let d = 0; d <= hi - lo && pick == null; d += STEP_MIN) {
      if (legal(target + d)) pick = target + d;
      else if (legal(target - d)) pick = target - d;
    }
    if (pick == null) return null;
    chosen.push(pick);
  }
  return chosen.sort((a, b) => a - b);
}

/** PURE. The whole shape of one page's Threads day: its rest state and its minutes. `count` is what
 *  the page would post on a working day; a rest day returns none and says why. */
export function threadsDay({ page, pages, day, count, fixed = [], claimed = [], earliest = null }) {
  if (isRestDay(page, pages, day)) return { rest: true, slots: [], reason: 'rest day' };
  const slots = cadenceSlots({ page, day, count, fixed, claimed, earliest });
  return slots ? { rest: false, slots } : { rest: false, slots: [], reason: `no room for ${count} post(s)` };
}
