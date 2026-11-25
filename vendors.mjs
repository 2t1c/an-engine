// vendors.mjs — the fleet's RT logistics knowledge: who we can reach, what they cost, and when
// they are actually awake. Reader + pure math over vendors.json.
//
// WHY THIS EXISTS. project-infinity spent $7,532.20 of fuel across 315 posts knowing six fields
// about a vendor (Name/Tier/Price/Network Size/Active/Chat ID, read live from Airtable) while
// the RT bot held twenty-one vendors, 113 per-handle follower counts, a three-branch cost model
// and a measured confirmation history. Every efficiency number the fleet computed was therefore
// computed against a partial roster at a single blended price. vendors.json ends that; this file
// makes it usable.
//
// Everything here is PURE and offline — no Airtable, no network, no env. That is deliberate: the
// cost of a fan-out is arithmetic, and arithmetic that needs a PAT cannot run in CI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';

let _db = null;
/** The parsed vendors.json (memoized). */
export function db() {
  if (!_db) _db = JSON.parse(readFileSync(join(HERE_DIR, 'vendors.json'), 'utf8'));
  return _db;
}
export const vendors = () => db().vendors;
export const bundles = () => db().bundles;

const idx = (f) => new Map(vendors().map((v) => [f(v), v]).filter(([k]) => k != null));
export const byKey = (key) => idx((v) => v.key).get(key) ?? null;
export const byChatId = (id) => idx((v) => String(v.chatId)).get(String(id)) ?? null;
/** Join a Fuel Log `Tier Breakdown` vendor name back to the roster. Falls back to the bot's title,
 *  so a vendor that has never fired still resolves, then to `aliases` so a historical line written
 *  under an old name still lands on the right vendor.
 *
 *  EXACT MATCH ONLY, deliberately. "ME" and "Maven/EM" are different vendors — 7 accounts at $6.30
 *  against 3 at $8.50 — and a substring match would fold one into the other. vendor-audit.mjs joins
 *  spend and lift on this name, so a wrong match misattributes money silently instead of erroring. */
export const byFuelName = (name) =>
  vendors().find((v) => v.fuelLogName === name || v.title === name
    || (v.aliases || []).includes(name)) ?? null;

/** Expand a bundle key ("t0") to its member vendors. A plain vendor key expands to itself, so
 *  callers can pass a mixed list of tiers and vendors without special-casing. */
export function expand(key) {
  const b = bundles()[key];
  if (b) return b.members.map(byKey).filter(Boolean);
  const v = byKey(key);
  return v ? [v] : [];
}

/**
 * What one more send to this vendor costs US, right now.
 *
 * `bundle` matters and is easy to get wrong. A vendor's own `cost.perPost` is what the BOT pays
 * when the bot delivers for a paying client. Inside a bundle the arrangement can differ — T0's
 * $8.60 is a pass-through of what three of its seven members charge, and the other four cost no
 * incremental cash. Costing a T0 fan-out off `cost.perPost` therefore overstates it (it was how an
 * earlier draft of this file reached $12.45 and wrongly concluded that going direct was more
 * expensive than the broker). Pass `bundle: 't0'` and the bundle's own memberCost answers.
 *
 * The three cost models are the other half. A retainer vendor's marginal cost is genuinely $0 — we
 * have already paid for the month — so `marginal` says $0 and `prorated` says what the retainer
 * works out to per send at the volume you pass. vendor-audit.mjs uses marginal cost only, which is
 * why VOPE and Lewin ($1,000/mo between them) score as unmeasurable rather than as good or bad.
 * Compare per_post and retainer vendors on `prorated`, never on `marginal`.
 */
export function costOf(v, { sendsPerMonth = 0, bundle = null } = {}) {
  const c = v.cost;
  const override = bundle ? bundles()[bundle]?.memberCost?.[v.key] : undefined;
  const marginal = override !== undefined ? override
    : c.model === 'per_post' ? c.perPost : 0;
  const prorated = c.model === 'retainer' && sendsPerMonth > 0
    ? c.monthlyRetainer / sendsPerMonth
    : marginal;
  return { model: c.model, marginal, prorated, monthlyRetainer: c.monthlyRetainer, basis: override !== undefined ? `bundle:${bundle}` : 'vendor' };
}

/** Marginal cash cost of firing this set once, plus its nominal and realisation-adjusted reach.
 *  Deduplicates, so expand('t0') mixed with an explicit member never double-charges. A key that
 *  names a bundle costs its members at the BUNDLE's rates — firing t0 costs $8.60, the same as
 *  buying it from the broker, because that price is a pass-through and not a margin. */
export function fanout(keys, { sendsPerMonth = 0 } = {}) {
  const set = new Map();
  for (const k of keys) {
    const isBundle = Boolean(bundles()[k]);
    for (const v of expand(k)) {
      // First key to claim a vendor sets its costing context; a bundle wins over a bare key, so
      // fanout(['partner','t0']) prices the partner as part of T0 rather than at the bot's rate.
      const prev = set.get(v.key);
      if (!prev || (isBundle && !prev.bundle)) set.set(v.key, { v, bundle: isBundle ? k : null });
    }
  }
  const list = [...set.values()];
  const nominalReach = list.reduce((s, { v }) => s + v.nominalReach, 0);
  return {
    vendors: list.map(({ v }) => v),
    marginalCost: +list.reduce((s, { v, bundle }) => s + costOf(v, { sendsPerMonth, bundle }).marginal, 0).toFixed(2),
    proratedCost: +list.reduce((s, { v, bundle }) => s + costOf(v, { sendsPerMonth, bundle }).prorated, 0).toFixed(2),
    // Per-vendor cash, in fan-out order — what t0-direct.mjs writes as one Fuel Log line each,
    // replacing the single bundle line that vendor-audit.mjs cannot separate.
    lines: list.map(({ v, bundle }) => ({ key: v.key, title: v.title, chatId: v.chatId, bundle, ...costOf(v, { sendsPerMonth, bundle }) })),
    nominalReach,
    // Nominal reach is combined follower count. The fleet measured ~19% of it arriving as head
    // views on T1 — use this for any forecast, and nominalReach only for comparing vendors.
    expectedViews: Math.round(nominalReach * db().meta.realisation),
    accounts: list.reduce((s, { v }) => s + v.accounts, 0),
  };
}

/** Cost per thousand expected views — the one number that ranks a per_post vendor against a
 *  retainer one honestly. null when a set is free (our own accounts). */
export function costPerMille(keys, opts) {
  const f = fanout(keys, opts);
  if (!f.expectedViews) return null;
  const c = opts?.prorated ? f.proratedCost : f.marginalCost;
  return c === 0 ? 0 : +((c / f.expectedViews) * 1000).toFixed(4);
}

// ---------------------------------------------------------------------------
// SENDING WINDOWS — in-hour vs off-hour
// ---------------------------------------------------------------------------
// the RT bot holds one vendor-hours window for its paying clients: 07:00-12:00 America/New_York
// (`BUSINESS_START_MIN`/`BUSINESS_END_MIN`). Outside it, a client on `hours` delivery mode does not
// fan out — the bot asks first. project-infinity's Fuel the Fire has no such notion and fires
// hourly, 24/7.
//
// That disagreement is not academic. Every THREAD publish window in slots.mjs falls entirely
// outside the bot's vendor window once converted to ET:
//
//   morning    06:00-07:30 Saigon = 19:00-20:30 ET (prev day)   0% overlap
//   afternoon  13:00-15:30 Saigon = 02:00-04:30 ET              0% overlap
//   harvest    04:00-07:00 Saigon = 17:00-20:00 ET (prev day)   0% overlap
//   viral      13:00-15:00 Saigon = 02:00-04:00 ET              0% overlap
//   singles    13:00-22:00 Saigon = 02:00-11:00 ET             44% overlap
//
// So every T0 ping the fleet has ever fired on a thread landed in a window the bot itself treats as
// off-hours. Neither model is validated: the bot's window is a client-facing policy, not a
// measurement, and the fleet's 24/7 default is not a decision at all. The data that settles it is
// the bot's own per-vendor `reacted_at` history (median time-to-confirm, already computed by
// /vendors) — until a vendor carries a MEASURED window here, `window` stays null and callers get
// `basis: 'unmeasured'` rather than a confident wrong answer.
export const BOT_VENDOR_HOURS = Object.freeze({ tz: 'America/New_York', startMin: 7 * 60, endMin: 12 * 60 });

/** Minutes-since-midnight for `at` in `tz`. */
export function minutesIn(at, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(at).reduce((o, x) => (o[x.type] = x.value, o), {});
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/**
 * Is `at` inside a vendor's reachable window?
 *
 * Prefers a per-vendor MEASURED window (`vendor.window`, set once the confirm-time analysis in
 * Phase 3 lands) and falls back to the bot's fleet-wide 07:00-12:00 ET policy. `basis` always says
 * which one answered, so a caller can refuse to act on a guess.
 */
export function inSendingWindow(at, vendor = null, fallback = BOT_VENDOR_HOURS) {
  const w = vendor?.window ?? fallback;
  const t = minutesIn(at, w.tz);
  // A window may cross midnight (start > end) — 22:00-04:00 is five hours, not negative twenty.
  const inside = w.startMin <= w.endMin
    ? t >= w.startMin && t <= w.endMin
    : t >= w.startMin || t <= w.endMin;
  return { inside, basis: vendor?.window ? 'measured' : 'unmeasured', window: w, minutes: t };
}

/** Split a fan-out by whether each vendor is reachable at `at`. The shape Fuel the Fire needs to
 *  hold an off-hours send instead of firing it into a dead group. */
export function splitByWindow(keys, at = new Date()) {
  const inHour = [], offHour = [];
  for (const v of fanout(keys).vendors) {
    (inSendingWindow(at, v).inside ? inHour : offHour).push(v);
  }
  return { at: at.toISOString(), inHour, offHour };
}
