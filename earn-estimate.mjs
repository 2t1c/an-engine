// earn-estimate.mjs — what a post just published is going to be WORTH, before the money lands.
//
// THE PROBLEM. The morning brief shows the top posts of the last 48h, and at that age the money
// column is a lie by omission: clicks arrive within minutes, Amazon reports conversions with a lag
// of days, and Levanta under-reports anything inside a 48-hour window (docs/unit-economics.md is
// explicit about this, and it is the same lag that got NAD+ killed on 2026-08-25 for looking like a
// loser at the exact moment it looked worst). So the operator reads "2.1M views · 340 clicks" with
// no dollar figure at all, on precisely the posts they most want to judge.
//
// WHAT THIS ESTIMATES FROM, and why in this order.
//
//   1. CLICKS x EPC — the primary. Measured on 553 settled posts, predicting a post's commission
//      from its clicks lands within a median 43% of the truth; predicting from views lands within
//      66%. Clicks are the tighter signal because they have already survived the step that varies
//      most between threads — whether the reader wanted the product at all. A viral thread about a
//      symptom and a viral thread about a substance pull wildly different click rates from the same
//      reach (the 2026-09-01 leaky-virals autopsy: $0.016/1k views against $0.164/1k at IDENTICAL
//      read-through), and a click has already priced that in.
//
//   2. VIEWS x band rate — the fallback, for a post so fresh it has views and no clicks yet.
//      Deliberately BANDED rather than flat: $/1k view holds near $0.14 up to about 2M views and
//      then falls to about $0.05 above it, because a thread that big is reaching past the audience
//      that buys. A flat multiplier would over-state every breakout post by roughly 3x — which is
//      the one error that would make this number worse than no number.
//
// Both rates are MEASURED at call time from facts.jsonl rather than hardcoded, for the same reason
// every floor in pick-product is a multiple of fleet EPC: a constant stops meaning what it meant.
// EPC has sat at $0.447-$0.454 across every window from 30 days to lifetime, so this is stable —
// but stable is a thing to re-measure, not a thing to freeze.
//
// AN ESTIMATE IS NOT A MEASUREMENT. Every caller must render it as such. It carries a median error
// near 43% and it is a central tendency across a skewed distribution: two thirds of posts earn
// nothing at all, so this number answers "what is a post like this worth" and never "what did this
// post make". Where the real figure exists, show the real figure.

/** Posts old enough that their commission has actually landed. */
const SETTLE_DAYS = 14;

/** The view bands, and nothing between them. Wide on purpose: the shape being captured is one
 *  breakpoint near 2M, not a curve, and narrow bands would fit noise. */
export const VIEW_BANDS = [
  { upTo: 100e3, label: '<100k' },
  { upTo: 500e3, label: '100k-500k' },
  { upTo: 2e6, label: '500k-2M' },
  { upTo: Infinity, label: '2M+' },
];

const num = (x) => Number(x) || 0;
const commissionOf = (r) => num(r?.lifetimeCommission) || num(r?.commission);
const clicksOf = (r) => num(r?.lifetimeClicks) || num(r?.affClicks);

/**
 * PURE. Measure the two rates from settled history.
 *
 * `settleDays` is the quarantine: a post inside it is still reporting and would drag both rates
 * down, which would make the estimator pessimistic in exactly the way the lag already is.
 */
export function measureRates(facts, { now = Date.now(), settleDays = SETTLE_DAYS, windowDays = 90, minViews = 1000 } = {}) {
  const hi = new Date(now - settleDays * 864e5).toISOString();
  const lo = new Date(now - (settleDays + windowDays) * 864e5).toISOString();
  const settled = (facts || []).filter((r) => {
    const at = String(r?.postedAt || '');
    return num(r?.views) >= minViews && at >= lo && at < hi;
  });
  let clicks = 0, commission = 0;
  const bands = VIEW_BANDS.map((b) => ({ ...b, views: 0, commission: 0, n: 0 }));
  for (const r of settled) {
    clicks += clicksOf(r); commission += commissionOf(r);
    const band = bands.find((b) => num(r.views) < b.upTo);
    if (band) { band.views += num(r.views); band.commission += commissionOf(r); band.n++; }
  }
  return {
    n: settled.length,
    epc: clicks > 0 ? commission / clicks : 0,
    bands: bands.map((b) => ({ upTo: b.upTo, label: b.label, n: b.n, per1k: b.views > 0 ? (b.commission / b.views) * 1000 : 0 })),
  };
}

/** PURE. The $/1k-view rate for a post of this size, falling back to the widest band that has data
 *  so a thin band never returns zero and silently estimates nothing. */
export function bandRate(views, rates) {
  const bands = rates?.bands || [];
  const hit = bands.find((b) => num(views) < b.upTo && b.per1k > 0 && b.n >= 5);
  if (hit) return hit.per1k;
  const any = bands.filter((b) => b.per1k > 0);
  return any.length ? any.reduce((a, b) => a + b.per1k, 0) / any.length : 0;
}

/**
 * PURE. What this post is on track to earn.
 *
 * Returns `{ value, basis, rate }` — `basis` is 'clicks' or 'views', so a caller can say which
 * signal it used, and null when there is nothing to estimate from. Never invents a number from an
 * empty rate table: no measured history means no estimate, not a zero dressed up as one.
 */
export function estimateEarnings({ views = 0, clicks = 0 } = {}, rates) {
  if (!rates || !rates.n) return null;
  if (num(clicks) > 0 && rates.epc > 0) return { value: num(clicks) * rates.epc, basis: 'clicks', rate: rates.epc };
  const per1k = bandRate(views, rates);
  if (num(views) > 0 && per1k > 0) return { value: (num(views) / 1000) * per1k, basis: 'views', rate: per1k };
  return null;
}
