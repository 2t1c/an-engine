// plan-week.mjs — the WEEKLY PLANNER (engine v2, part D, step 1). Composes the whole fleet's week
// in one pass: per active monetized account, 7 slots = 5 MOLD (from molds.json x the opener rotation
// x the product allowlist) + 2 COVER (bridge-gated donor threads ranked on selectionScore).
//
// THIS FILE NEVER WRITES ANYTHING EXTERNAL. No Typefully, no Airtable mutations, no cron. It emits:
//   queues/week-plan-<YYYY-MM-DD>.json   (machine plan — generation consumes it in step 3)
//   a human review report on stdout       (the operator's "one shot, get the whole batch right")
// The old daily/weekly engines keep running untouched; this runs ALONGSIDE them for the parity week
// (plan step 2). Cutover is a separate, operator-approved change.
//
//   node plan-week.mjs                 # plan next week from Monday, print report, write JSON
//   node plan-week.mjs --dry           # print only, no JSON file
//   node plan-week.mjs --start 2026-08-18
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { MOLDS, MOLD_THRESHOLDS, provenMolds, experimentalMolds, selectionScore, donorAgeDays, bridgeableProducts, intentFactor, ALLOW_ASINS, DENY_ASINS, listicleKind, bannedTopicIssue, tweetsFromRollup } from './checks.mjs';
import { classifyTopic, candidates, productPerf, fleetEpc } from './pick-product.mjs';
import { selectPod } from './outline.mjs';
import { LAWS } from './laws.mjs';
import { donorSlots } from './pod-place.mjs';
import { TABLES } from './config.mjs';
import { sameLane } from './lanes.mjs';

const DRY = process.argv.includes('--dry');
const START = (() => {
  const i = process.argv.indexOf('--start');
  if (i > 0) return new Date(`${process.argv[i + 1]}T00:00:00Z`);
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); // next Monday
  return d;
})();

// Slot budget per account per week comes from laws.json scale.* (operator 2026-08-25: 5 mold +
// 4 viral + 2 harvest = 11 planned, ~1 auto-repost rides the daily-winners cron -> 12/wk). Growing
// the fleet or the mix is a laws edit, never a code edit.
const MOLD_SLOTS = LAWS.scale.moldSlots, VIRAL_SLOTS = LAWS.scale.viralSlots;

// Deterministic shuffle: same seed string -> same order, forever. Fisher-Yates over mulberry32.
// Exported pure so the "randomized but reviewable" property is pinned by tests.
export function seededShuffle(arr, seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^= h >>> 16) >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// ---- pure slate composition (unit-tested) --------------------------------------------------------
// One account's 5 mold picks for the week: proven molds rotated fleet-wide with a per-account offset
// (adjacent accounts draw different mold sequences; WHICH DAY each lands on is the seeded shuffle's
// job below), at most ONE experimental mold per
// account per week (the library grows without any page becoming the guinea pig), and no mold twice
// for the same account inside a week.
// Which proven mold earns a second slot. Ranked on the operator's yardstick — store-side clicks per
// 100k views, not revenue (2026-08-25: "we don't track the dollar earned, since that could be
// wrong"). A mold must clear minPosts to be eligible, or one lucky thread takes over the fleet's
// whole mold lane on a sample of two. Returns null when nothing has earned it, and the rotation
// stays exactly as it was.
export function topMoldByConversion(proven = provenMolds(), { minPosts = MOLD_THRESHOLDS.minPosts } = {}) {
  const eligible = proven
    .map((m) => ({ m, n: Number(m.measured?.posts || 0), cp100k: Number(m.measured?.clicksPer100k || 0) }))
    .filter((x) => x.n >= minPosts && x.cp100k > 0)
    .sort((a, b) => b.cp100k - a.cp100k || String(a.m.id).localeCompare(String(b.m.id)));
  return eligible.length ? eligible[0].m : null;
}

export function composeMoldWeek({ accountIndex = 0, weekIndex = 0, proven = provenMolds(), experimental = experimentalMolds(), slots = MOLD_SLOTS, topExtra = LAWS.scale.topMoldExtraSlots } = {}) {
  const picks = [];
  const rot = (list, k) => list.length ? list[(accountIndex + weekIndex + k) % list.length] : null;
  // The best converter goes in FIRST and may repeat (operator 2026-08-25). Without this the lane
  // could not express a preference at all: with 4 proven molds and 4 proven slots every account ran
  // all four every week, so "prioritise the high converters" was arithmetically a no-op. Giving the
  // top mold a second slot is what displaces the weakest one.
  const top = topExtra > 0 ? topMoldByConversion(proven) : null;
  if (top) for (let n = 0; n < 1 + topExtra && picks.length < slots - 1; n++) picks.push(top);
  // slots 1..4 from proven, rotated; the last slot is the experiment (if any exist)
  for (let k = 0; picks.length < Math.min(slots - 1, proven.length + (top ? topExtra : 0)) ; k++) {
    const m = rot(proven, k);
    if (m && !picks.some((p) => p.id === m.id)) picks.push(m);
    if (k > proven.length * 2) break;
  }
  const exp = rot(experimental, 0);
  if (exp && picks.length < slots) picks.push(exp);
  // backfill from proven if experimental was empty or the proven list is short
  for (let k = proven.length; picks.length < slots && k < proven.length * 3; k++) {
    const m = rot(proven, k);
    if (m && !picks.some((p) => p.id === m.id)) picks.push(m);
  }
  return picks.slice(0, slots);
}

// Pure: which donors has each account already run — the planner's cross-week MEMORY (operator
// 2026-08-25: it read only the n8n-written Drafted flag before, so the same donor could be planned
// twice in consecutive weeks). Per-account PERMANENT: an account never recreates its own donor
// again. Cross-account is deliberately unlimited — winners spread fleet-wide, paced by the same-day
// source cap, never blocked outright.
export function donorMemory(ledgerLines) {
  const m = new Map();
  for (const line of ledgerLines || []) {
    try {
      const e = JSON.parse(line);
      if (e.recId && e.account) { if (!m.has(e.account)) m.set(e.account, new Set()); m.get(e.account).add(e.recId); }
    } catch {}
  }
  return m;
}

// Pure: this week's harvest picks for one account, from the specs harvest.mjs emitted. Click-gated
// (the operator's metric — a parent that never pulled a click is not worth a rerun), rotation-spaced
// (no new hook on a body this account ran inside bodyRotationDays), capped per (parent, account).
export function pickHarvest(specs, accountName, { slots = LAWS.scale.harvestSlots, ledger = [], rotationDays = LAWS.scale.bodyRotationDays, maxPerParent = 2, now = Date.now() } = {}) {
  const key = String(accountName).toLowerCase().split(' ')[0];
  const mine = (ledger || []).filter((e) => e.harvestOf && e.account === accountName);
  const recent = new Set(mine.filter((e) => now - new Date(e.ts || 0).getTime() < rotationDays * 864e5).map((e) => String(e.harvestOf)));
  const count = {};
  for (const e of mine) count[String(e.harvestOf)] = (count[String(e.harvestOf)] || 0) + 1;
  return (specs || [])
    .filter((s) => s.account === key)
    // BANNED TOPICS NEVER REACH THE HARVEST BENCH EITHER (2026-08-28). The VIRAL pool was hardened
    // against this on 08-27 and the harvest lane was not, which is a hole rather than an oversight
    // you can shrug at: a harvest slot regenerates a NEW hook on a proven PARENT body, so a banned
    // parent produces a banned child every time it is picked, forever. Found by a --limit 3 run:
    // Julian's slot for 2026-08-28 was a radiologist-on-cancer parent, and 3 of the 63 specs on the
    // bench carry one. Filtering here rather than at generation means the slot goes to a usable
    // parent instead of being spent and then rejected.
    .filter((s) => !(bannedTopicIssue([s.parentHook || s.hook, ...((s.parentTweets && s.parentTweets.length) ? s.parentTweets : (s.tweets || []))].filter(Boolean)) || (s.hook ? bannedTopicIssue(s.hook) : '')))
    .filter((s) => (s.parentStats?.clicks || 0) > 0)
    .filter((s) => !recent.has(String(s.harvestOf)) && (count[String(s.harvestOf)] || 0) < maxPerParent)
    .sort((a, b) => (b.parentStats?.clicks || 0) - (a.parentStats?.clicks || 0))
    .slice(0, slots);
}

// PER-DAY VIRAL FILL (operator 2026-08-27). The ONLY fleet constraint on a donor is that two
// accounts may not run it on the SAME DAY. Everything else is allowed: the same thread can go to all
// nine accounts across nine different days, the same author can supply the whole fleet, and a donor
// is never consumed by being used.
//
// assignViral below was 7x stricter than that — it held one fleet-wide `used` Set for the whole
// WEEK, so 9 accounts x 4 slots could only ever draw 36 distinct donors and the pool looked
// exhausted at 36 when it actually held 107. That made the viral lane look supply-bound and is why
// the mold lane grew to carry the gap.
//
// This runs AFTER days are assigned, which is the only order that can enforce a per-DAY rule: the
// old function picked donors before the shuffle decided which day each slot landed on, so it could
// not have known. Accounts are walked in a rotated order per day so the same page does not always
// take the top-ranked donor.
export function fillViralByDay(plan, cands, { memory = new Map(), commit = null } = {}) {
  const days = [...new Set(plan.flatMap((p) => p.slots.map((s) => s.day)))].sort();
  const usedOnDay = new Map();
  let filled = 0, starved = 0;
  days.forEach((day, di) => {
    const taken = usedOnDay.get(day) || new Set();
    usedOnDay.set(day, taken);
    // Rotate which account picks first, so rank 1 does not always land on the same page.
    const order = plan.map((_, i) => plan[(i + di) % plan.length]);
    for (const p of order) {
      for (const slot of p.slots) {
        if (slot.day !== day || !sameLane(slot.lane, 'cover')) continue;
        // ONE RULE, and this line is all of it (operator 2026-08-27, twice: "literally the ONLY
        // constraint is 2 accounts don't post the same source on one day"). Per-account memory was
        // removed after the first cut -- an account MAY run a source it has run before, so `memory`
        // is accepted for signature compatibility and deliberately not consulted.
        const pick = cands.find((c) => !taken.has(c.recId));
        if (!pick) { starved++; continue; }
        taken.add(pick.recId);
        Object.assign(slot, { recId: pick.recId, url: pick.url, views: pick.views, bridges: pick.bridges,
          topic: pick.topic, hook: pick.hook, listicle: pick.listicle || false, convertTo: pick.convertible || null, sellSlots: pick.sellSlots || [] });
        // AND THE PRODUCTS HAVE TO FOLLOW THE DONOR THAT ACTUALLY LANDS (2026-08-28).
        //
        // The slot arrived here already carrying products, committed upstream against a DIFFERENT
        // candidate. This line then replaces the donor and used to leave `products` untouched, so
        // every viral slot in every plan shipped a product pair chosen for a thread it is not
        // running. That is the root of the unsoldSubstanceIssue failures the first end-to-end engine
        // run died on three times over: the writer follows this donor, the plug follows that one.
        //
        // Overlap between committed products and what the donor argues was 22% before this, with 47
        // of 77 slots selling nothing their own thread mentions.
        if (commit) slot.products = commit(pick);
        filled++;
      }
    }
  });
  return { filled, starved };
}

// Distinct viral sources per account, best selectionScore first, fleet-deduped in-week (a source
// goes to ONE account per week; other accounts pick it up in LATER weeks — memory allows it, the
// day cap paces it). SUPERSEDED by fillViralByDay above; kept for its tests and for the
// supplement-share steer, which the per-day fill does not yet reproduce.
export function assignViral(cands, accounts, perAccount = VIRAL_SLOTS, { supplementShare = 0.5, memory = new Map() } = {}) {
  const out = new Map(accounts.map((a) => [a.name, []]));
  const used = new Set();
  const seen = (a, c) => memory.get(a.name)?.has(c.recId); // this account already ran it — never again
  // The 50% steer: at least `supplementShare` of each account's viral slots go to donors that
  // CONVERT to a supplement-native shape (roundup or deep dive), when such donors exist in the
  // pool. Rank order still decides WHICH convertible donor — the steer changes the mix, never the
  // quality bar, and when the pool has too few convertible donors the remaining slots fall back to
  // the plain ranking rather than starving.
  for (const a of accounts) {
    const mine = out.get(a.name);
    const wantConvertible = Math.ceil(perAccount * supplementShare);
    for (const c of cands) {
      if (mine.length >= wantConvertible) break;
      if (used.has(c.recId) || seen(a, c) || !c.convertible) continue;
      used.add(c.recId); mine.push(c);
    }
    for (const c of cands) {
      if (mine.length >= perAccount) break;
      if (used.has(c.recId) || seen(a, c)) continue;
      used.add(c.recId); mine.push(c);
    }
  }
  return out;
}

// ---- same-day source cap -------------------------------------------------------------------------
// OPERATOR RULE 2026-08-22: at most TWO accounts may post from the same source on the same day.
// Three is the number that reads as a coordinated push rather than a coincidence, and the whole
// reason the backlog got archived was that duplication footprint. The viral lane already over-
// satisfies this (assignViral hands a recId to ONE account per week), so every breach comes from the
// mold lane: composeMoldWeek gives adjacent accounts different mold ORDERS, then each account's
// seededShuffle picks days independently, and nothing stops three of those landing the same mold on
// the same day. Week 2026-08-24 shipped exactly one such breach (M1 on three accounts on the 24th).
//
// The repair is a SWAP, never a drop: an over-cap slot trades days with another slot inside the SAME
// account, so every account keeps its seven slots on seven distinct days and the week's composition
// is untouched. Only the calendar moves.
export function slotKey(s) {
  if (s.hookId) return `HOOK:${s.hookId}`;          // once hooks are planned, they are the identity
  if (s.lane === 'harvest') return `HARV:${s.harvestOf}`; // same parent body = same identity fleet-wide
  return sameLane(s.lane, 'seed') ? `SEED:${s.moldId}` : `SRC:${s.recId}`;
}

export function capSameDaySource(plan, max = LAWS.scale.sameDaySourceCap) {
  const count = new Map();                           // `${day}|${key}` -> n
  const bump = (day, key, d) => {
    const k = `${day}|${key}`;
    const n = (count.get(k) || 0) + d;
    if (n <= 0) count.delete(k); else count.set(k, n);
  };
  const at = (day, key) => count.get(`${day}|${key}`) || 0;
  for (const p of plan) for (const s of p.slots) bump(s.day, slotKey(s), 1);

  const swaps = [];
  // Deterministic order: accounts as given, slots by day. A swap changes counts, so re-scan until
  // a full pass makes no move (bounded — each swap strictly reduces the number of over-cap cells).
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (const p of plan) {
      const slots = [...p.slots].sort((a, b) => a.day.localeCompare(b.day));
      for (const s1 of slots) {
        const k1 = slotKey(s1);
        if (at(s1.day, k1) <= max) continue;
        const target = slots.find((s2) => {
          if (s2 === s1) return false;
          const k2 = slotKey(s2);
          if (k2 === k1) return false;               // same key: swapping changes nothing
          return at(s2.day, k1) < max && at(s1.day, k2) < max;
        });
        if (!target) continue;                       // no legal partner; leave it and report
        const k2 = slotKey(target);
        bump(s1.day, k1, -1); bump(target.day, k2, -1);
        const [d1, d2] = [s1.day, target.day];
        s1.day = d2; target.day = d1;
        bump(s1.day, k1, 1); bump(target.day, k2, 1);
        swaps.push({ account: p.account, key: k1, from: d1, to: d2 });
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const p of plan) p.slots.sort((a, b) => a.day.localeCompare(b.day));
  // Anything still over cap could not be repaired by swapping — surfaced, never silently shipped.
  const unresolved = [];
  for (const [k, n] of count) if (n > max) unresolved.push({ cell: k, n });
  return { swaps, unresolved };
}

// Pure-ish: the plan's PRODUCT COMMITMENT. Deterministic by design — `candidates` ranks on realized
// EPC with a commission prior, so taking the top two distinct entries gives a choice that can be
// reproduced, reviewed and argued with. The LLM refinement that run-plan used to apply is what made
// the shipped product differ from the reviewed one; it is not needed to pick from a ranked list.
// The operator's 100-click rule, in one place: under this many LIFETIME clicks a product has no
// verdict, so nothing may demote it for the numbers it has not had a chance to earn yet.
export const JUDGE_MIN_CLICKS = Number(process.env.PRODUCT_JUDGE_MIN_CLICKS ?? LAWS.product?.winnerMinClicks ?? 100);

export function commitProducts(text, products, used = {}, cap = 3, report = null, { prefer = [] } = {}) {
  try {
    const pool = candidates(text, products, { bodyText: text });
    // TWO FILTERS THE PLANNER USED TO LEAVE FOR A HUMAN (2026-08-27), in the order they bind.
    //
    // POD COVERAGE comes first and is the harder of the two, because the CTA law says the plug copy
    // comes from pods.json and nowhere else. A product selectPod cannot answer has no CTA available,
    // so committing it plans a slot that cannot be written — the build either improvises a plug,
    // which is the thing the law forbids, or stalls. The 2026-08-28 slate had four such products
    // (focus gum, a second D3+K2, a vitamin C SERUM, glucosamine) and two of them were Rafael's only
    // two products across two consecutive days.
    //
    // FLEET EPC comes second and only ever demotes a product that has EARNED a verdict. The first
    // cut of this filter compared every candidate's EPC against the bar, which treated "measured
    // below" and "no data yet" as the same thing and was wrong twice over. It dropped B07S424N6V,
    // the nitric-oxide bottle the operator deliberately funded without waiting for 100 clicks, for
    // the crime of having the zero data that decision guarantees. And it dropped B09SFFJP1P — beet
    // root, 4,052 measured clicks — for landing 1.7 cents under the line. Between them the two
    // mistakes took the plan's catalogue from 26 distinct products to 13.
    //
    // So the demotion needs the operator's own 100-click rule: nothing is judged under 100 lifetime
    // clicks. Below that a product is UNJUDGED, keeps its place in the ranking, and is exactly the
    // explorer traffic that finds the next $0.60 earner — 247 of 291 kept products have never taken
    // a click, and a bar that reads silence as failure freezes the catalogue to the few that have.
    //
    // NEITHER filter may starve a slot: each falls back to the wider pool and says so in `report`,
    // because a silently empty slot reads as "no product fits" when the truth is "we filtered it out".
    const perf = productPerf();
    const bar = fleetEpc(perf);
    const podded = pool.filter((p) => { try { return !!selectPod(p).pod; } catch { return false; } });
    if (report) report.noPod += pool.length - podded.length;
    const base = podded.length ? podded : pool;
    if (report && !podded.length && pool.length) report.podStarved++;
    const judgedLoser = (p) => {
      const row = perf[p.asin];
      return !!row && (row.clicks ?? 0) >= JUDGE_MIN_CLICKS && (row.epc ?? 0) < bar;
    };
    const above = base.filter((p) => !judgedLoser(p));
    if (report) report.demoted += base.length - above.length;
    if (report && !above.length && base.length) report.epcStarved++;
    // SPREAD ACROSS THE PLAN. Without this the ranked pool hands every slot the same top two and the
    // week ships one product 63 times — the first run committed B079K32QB6 + B0DK61GRD2 to both of
    // Julian's viral slots before this existed. Prefer entries under the cap, but never starve a slot:
    // if nothing is under it, fall back to the ranked order rather than returning nothing.
    // A hard cap does not spread anything: once most of a thin pool is over it the fallback re-picks
    // the top of the ranking, and the first run still put one ASIN in 25 of 63 slots. Instead, pick
    // the LEAST-USED product among the top few ranked candidates — quality is preserved because the
    // shortlist is still rank-ordered, and spread happens because usage breaks the tie.
    // RELEVANCE FIRST (2026-08-28, found by the first end-to-end engine run). Everything above ranks
    // on TOPIC, via candidates() -> PRODUCT_RE. That is right when a POD brings its own point and
    // bridge and argues the substance in OUR copy. It is wrong when the donor already argues a
    // substance, because the writer follows the donor and the plug follows the plan, and the two
    // then disagree. Live proof: Julian's viral slot committed ubiquinol + CoQ10 to a donor whose
    // own words argue magnesium, ashwagandha and collagen — zero overlap — and all three slots in
    // the run died on unsoldSubstanceIssue, "argues magnesium across 10 tweets but never sells it".
    //
    // `prefer` is the donor's bridged ASINs. Relevance is already PROVEN for those by the donor's
    // text, so they go to the front of the shortlist; the topical pool still fills anything left,
    // which is what keeps the mold lane (no bridges at all) working exactly as before.
    //
    // AND REORDERING THE TOPICAL POOL IS NOT ENOUGH — that was the first cut of this fix and it
    // only moved overlap to 22%, leaving 47 of 77 slots still selling nothing the donor argues.
    // `pool` came from candidates(), which is TOPIC-filtered, so a bridged ASIN the topic classifier
    // never surfaced cannot be reordered into view. The preferred set has to be built from the FULL
    // catalogue instead, because its relevance is already proven by the donor's own words. What it
    // still has to pass is everything else: not denied, on the allowlist, purchasable, pod-covered.
    const wanted = new Set(prefer || []);
    const preferred = wanted.size
      ? products.filter((p) => wanted.has(p.asin) && !DENY_ASINS.has(p.asin) && !p.unavailable
          && (!ALLOW_ASINS.size || ALLOW_ASINS.has(p.asin))
          && (() => { try { return !!selectPod(p).pod; } catch { return false; } })())
      : [];
    const ranked = above.length ? above : base;
    const rest = ranked.filter((p) => !wanted.has(p.asin));
    const shortlist = [...preferred, ...rest].slice(0, Math.max(cap * 2, 8));
    const unjudged = (p) => ((perf[p.asin]?.clicks ?? 0) < JUDGE_MIN_CLICKS);
    const out = [];
    for (let n = 0; n < 2; n++) {
      let avail = shortlist.filter((p) => !out.some((x) => x.asin === p.asin));
      if (!avail.length) break;
      const availAll = avail;   // pre-filter, so the relevance clamp below can reach past the three narrowings
      // THE FIRST PLUG IS ALWAYS MEASURED; EXPLORATION RIDES THE SECOND.
      //
      // Unjudged products belong in the ranking — that is how the next $0.60 earner gets found — but
      // two things went wrong when they were simply left there. A thread came out with BOTH plugs
      // zero-data (3 of 27 in the 2026-08-28 dry run), which is not exploring, it is a slot with no
      // measured earner in it at all. And the spread tiebreak below sorts on least-used, which an
      // explorer wins by construction — it has never been used — so exploration got amplified
      // rather than allowanced, reaching 8 of 27 slots against a laws budget of 2.
      //
      // Ordering fixes both at once. Plug 1 takes a judged product whenever the shortlist holds one,
      // so every thread carries a measured earner in its prime position. Plug 2 is free, so the
      // explorer still ships on the light slot and still gets its clicks. Neither is a hard bar:
      // when nothing judged fits the text, plug 1 explores rather than leaving the slot empty.
      const judged = avail.filter((pp) => !unjudged(pp));
      if (n === 0 && judged.length) avail = judged;
      if (n > 0 && out.some((x) => x.unjudged) && judged.length) avail = judged;
      // AND THE EXPLORER ALLOWANCE IS A BUDGET, NOT A SIDE EFFECT. The spread tiebreak below sorts
      // on least-used, which an unjudged product wins by construction — it has never been used — so
      // exploration compounded instead of being allowanced: 19 of 54 plugs in the 2026-08-28 dry
      // run, against a laws budget of exploreSlots x accounts. The budget is spent here, across the
      // whole plan rather than per slot, so an early account cannot eat the fleet's whole allowance
      // and a late one cannot be starved of a measured product for lack of one.
      if (report && report.exploreSpent >= report.exploreBudget && judged.length) avail = judged;
      // RELEVANCE OUTRANKS BOTH OF THOSE, AND IT IS LAST SO IT WINS (2026-08-28, second engine run).
      // The three rules above all filter to `judged`, and a donor's own substance is often UNJUDGED
      // precisely because we only just started selling it. Rafael's live slot is the whole argument:
      // his donor argues nitric oxide across 5 tweets, B07S424N6V is allowlisted, pod-covered and not
      // denied, and it lost every one of those three filters for having zero clicks. The plan sold him
      // magnesium instead and the draft died on unsoldSubstanceIssue at publish.
      //
      // The two costs are not comparable. An unjudged plug 1 is a thread that EXPLORES; a thread that
      // argues a substance and sells another is a thread that CANNOT SHIP, and it is also the reader
      // being walked to one thing and handed a different one. So when the donor's own bridged products
      // survive every hard filter, plug 1 takes one of them — the measured one first, if there is one.
      // AND IT APPLIES TO BOTH PLUGS, not only the heavy one. The gate fires on ANY substance the body
      // argues across 3+ tweets, so a donor arguing magnesium, ashwagandha and collagen needs two of
      // the three sold before the plug budget runs out — covering only the heavy one leaves the other
      // two to fail at publish. Where the donor argues fewer things than we have plugs, the leftover
      // slot falls through to the ranking exactly as before, which is what keeps the mold lane (no
      // bridges at all) untouched.
      const relevant = availAll.filter((p) => wanted.has(p.asin));
      if (relevant.length) {
        const relJudged = relevant.filter((pp) => !unjudged(pp));
        avail = relJudged.length ? relJudged : relevant;
      }
      avail.sort((a, b) => ((used[a.asin] || 0) - (used[b.asin] || 0)) || (shortlist.indexOf(a) - shortlist.indexOf(b)));
      const p = avail[0];
      // FULL TITLE, never truncated (2026-08-26). This used to store slice(0, 70), and on
      // 2026-08-26 that cut "Active Form of CoQ10" off the Nutricost ubiquinol -- so the stored row
      // no longer named its own substance, podFitsProduct stopped matching, and Julian and Rafael
      // both lost pod coverage on a product they still sell. The title is the only description of
      // the bottle that travels with the plan, and every downstream substance check reads it. Cut it
      // for DISPLAY at the point of display; never in the data.
      out.push({ asin: p.asin, title: String(p.title || ''), commission: p.commission, unjudged: unjudged(p) });
      if (report && unjudged(p)) report.exploreSpent++;
      used[p.asin] = (used[p.asin] || 0) + 1;
    }
    return out;
  } catch { return []; }
}

async function main() {
  const allProducts = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  // What the two commitProducts filters actually dropped this run. Printed, never silent: a plan
  // that quietly narrowed its own catalogue is indistinguishable from a thin catalogue.
  const filterReport = { noPod: 0, podStarved: 0, epcStarved: 0, demoted: 0, exploreSpent: 0, exploreBudget: 0 };
  const planUse = {}; // ASIN -> how many slots this week's plan has already committed it to
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const at = airtable(env);

  const accounts = Object.values(ACCOUNTS).filter((a) => !a.paused && a.plugHeavyExample && a.socialSetId);
  // Set once the roster is known: the allowance is fleet-wide, so growing the fleet grows it.
  filterReport.exploreBudget = accounts.length * (LAWS.product?.exploreSlots ?? 2);
  const weekIndex = Math.floor(START.getTime() / (7 * 864e5));

  // Viral pool: bridge-gated swipe head rows inside the freshness window, ranked on selectionScore.
  // 21 -> LAWS.selection.viralWindowDays (operator 2026-08-25). The window is only half the fix: it
  // is binary, so INSIDE it age counted for nothing and a three-week-old thread with good numbers
  // beat yesterday's every time. selectionScore now carries recencyFactor, which needs the date —
  // and `Published Date` was filtered on but never FETCHED, so nothing downstream could read it.
  const recs = await at.list(TABLES.swipe, {
    formula: `AND({Tweet Number}=1,{Thread Length}>=3,NOT({Quoted Junk}),NOT({Single Tweet}),NOT({Drafted}),{Impressions}>=250000,IS_AFTER({Published Date},DATEADD(NOW(),-${LAWS.selection.viralWindowDays},"days")))`,
    fields: ['Text', 'Impressions', 'Retweet Rate', 'Comments', 'Thread Retention', 'Full Thread Text', 'Tweet URL', 'Niche', 'Published Date'],
    // The whole window, not the first page. Capped at 100 the pool could never grow, however wide
    // the window got — 21 days and 30 days both returned exactly 100 donors.
    max: 2000,
    pageSize: 100,
  });
  // BANNED TOPICS NEVER REACH THE POOL (2026-08-27). bannedTopicIssue already blocks these at
  // publish, which sounds like enough and is not: a slot committed to a donor that can never be
  // written is a slot the account loses. The 2026-08-27 plan carried three (two cancer hooks for
  // Lorenzo, a 96-hour-fasting "tumors" hook for Rafael) and Rafael lost a day to it. The check runs
  // on the hook AND the full thread body, because the banned word is more often in an item than the
  // headline. Filtering here rather than at scoring keeps the count honest in the pool line below.
  const bannedRecs = [];
  const cleanRecs = recs.filter((r) => {
    const issue = bannedTopicIssue(`${r.fields.Text || ''}\n${r.fields['Full Thread Text'] || ''}`);
    if (issue) bannedRecs.push({ hook: (r.fields.Text || '').split('\n')[0].slice(0, 66), why: issue });
    return !issue;
  });
  const viralPool = cleanRecs.map((r) => {
    const body = `${r.fields.Text || ''}\n${r.fields['Full Thread Text'] || ''}`;
    const bridges = [...bridgeableProducts(body)];
    // THE DONOR'S OWN SELL SLOT (operator: "yes fix this", 2026-08-27; built 2026-08-28). pod-place
    // has known how to find these since it was written, but the PLANNER did not, so a donor whose
    // creator had ALREADY monetized it ranked exactly the same as one that had not. That is the most
    // valuable signal in the pool: their sell tweet marks the position they optimized for conversion,
    // and our plug replaces theirs in place instead of being invented somewhere colder.
    const donorTweets = tweetsFromRollup(r.fields['Full Thread Text']);
    const sellSlots = donorTweets.length >= 3
      ? donorSlots(donorTweets).filter((s) => s.tier === 'sell' && s.asin)
      : [];
    return {
      sellSlots: sellSlots.map((s) => ({ at: s.at, substance: s.substance, asin: s.asin })),
      recId: r.id, url: r.fields['Tweet URL'], views: r.fields.Impressions || 0,
      body,   // was never stored, so `v.body` at the commit call was undefined and the picker saw only the hook
      ageDays: donorAgeDays(r.fields),
      hook: (r.fields.Text || '').split('\n')[0].slice(0, 90),
      // LISTICLE PRIORITY (operator 2026-08-25, data-confirmed ~2x clicks per 100k views): numbered
      // items are ready-made plug slots (the ITEM-SWAP path), so listicle-hooked donors outrank
      // equal-score prose donors by the laws knob.
      listicle: !!listicleKind(r.fields.Text || ''),
      score: selectionScore(r.fields, body) * intentFactor(classifyTopic(r.fields.Text || ''))
        * (listicleKind(r.fields.Text || '') ? LAWS.scale.listicleBoost : 1)
        * (sellSlots.length ? (LAWS.scale.sellSlotBoost ?? 1) : 1)
        * (bridges.length >= 3 ? (LAWS.scale.roundupBoost ?? 1) : 1),
      bridges,
      // SUPPLEMENT-NATIVE STEER (phase 4, operator target: 50%+ of published threads). The outline
      // decides the SHAPE per donor; the planner's job is the MIX. Measured over 45 days:
      // supplement-native threads earn 2.3x per post at identical median reach — they lose only the
      // reach lottery's tail, and followers are explicitly not a goal. 3+ bridgeable substances
      // means the donor converts honestly to a roundup; exactly one strong one is a deep dive.
      convertible: bridges.length >= 3 ? 'roundup' : bridges.length === 1 ? 'deepDive' : null,
      topic: classifyTopic(r.fields.Text || ''),
    };
  }).filter((c) => c.bridges.length >= 1).sort((a, b) => b.score - a.score);

  // The planner's memory and the harvest bench, both from the ledger — read once.
  const ledLines = existsSync(join(HERE_DIR, 'ledger.jsonl')) ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean) : [];
  const memory = donorMemory(ledLines);
  const ledger = ledLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const specDir = join(HERE_DIR, 'queues', 'harvest');
  const specs = existsSync(specDir)
    ? readdirSync(specDir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(specDir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
    : [];

  const viralByAccount = assignViral(viralPool, accounts, VIRAL_SLOTS, { memory });

  // Compose the week per account.
  // Harvest products come from the PARENT's ledger row, and rows written before 2026-08-26 stored a
  // title truncated at 70 characters. Resolve through the catalogue by ASIN so the plan carries the
  // real product name: 21 of 41 harvest product entries in the 2026-08-31 plan were truncated.
  const catTitle = new Map(allProducts.map((p) => [p.asin, p.title]));
  const days = Array.from({ length: 7 }, (_, i) => new Date(START.getTime() + i * 864e5).toISOString().slice(0, 10));
  const plan = [];
  accounts.forEach((acc, ai) => {
    const molds = composeMoldWeek({ accountIndex: ai, weekIndex });
    const viral = viralByAccount.get(acc.name) || [];
    // LANE ORDER IS SHUFFLED ACROSS THE WEEK (operator ruling 2026-08-17): no weekday/weekend split —
    // "I don't think there's any correlation there." The shuffle is SEEDED on (week, account) so the
    // same week always produces the same plan: reviewable, diffable, re-runnable — random in shape,
    // deterministic in fact. Different accounts get different orders, so the fleet never posts its
    // viral slots in unison.
    const entries = [
      // COMMIT the product, do not merely list candidates (operator 2026-08-17). Until now a viral
      // slot recorded `bridges` — the substances the donor COULD host — and a mold slot recorded
      // nothing at all, so the plan the operator reviews on Monday named no product and the engine
      // decided at run time. That makes the weekly review a forecast rather than an approval.
      // The choice here is DETERMINISTIC (the ranked candidate pool, money-ordered, no LLM) so the
      // plan is reproducible and reviewable; run-plan honours it and logs loudly if it must override.
      ...molds.map((m) => ({ lane: 'seed', moldId: m.id, mold: m.name, status: m.status, hookShape: m.hook.split('\n')[0].slice(0, 80), products: commitProducts(m.hook, allProducts, planUse, 3, filterReport) })),
      ...viral.map((v) => ({ lane: 'cover', recId: v.recId, url: v.url, views: v.views, bridges: v.bridges, topic: v.topic, hook: v.hook, listicle: v.listicle || false, convertTo: v.convertible || null, sellSlots: v.sellSlots || [], products: commitProducts(`${v.hook}\n${v.body || ''}`, allProducts, planUse, 3, filterReport, { prefer: v.bridges || [] }) })),
      // HARVEST lane (operator 2026-08-25): proven bodies re-hooked. The writing happens in-session
      // (the Tuesday batch) against the queued spec — the plan allocates the slot and the day.
      ...pickHarvest(specs, acc.name, { ledger }).map((h) => ({ lane: 'harvest', harvestOf: String(h.harvestOf), parentHook: String(h.parentHook || '').replace(/\s+/g, ' ').slice(0, 80), parentUrl: h.parentUrl || null, parentStats: h.parentStats || {}, products: (h.products || []).map((x) => ({ ...x, title: catTitle.get(x.asin) || x.title })) })),
    ];
    // ONE SLOT PER LANE PER DAY (2026-08-27). The old line shuffled all 14 entries together and
    // spread them k % 7, which was right when there was ONE posting window a day and a second entry
    // on a day meant an alternate to choose between. Under two lanes it books two posts, and each
    // lane has exactly one window per account, so two viral entries on one day resolve to the SAME
    // timestamp and double-book the slot. The 2026-08-31 plan had 12 of these before the fix.
    //
    // Shuffling each lane separately and pairing by index gives the shape the week is meant to have:
    // day k holds viral[k] and harvest[k]. The seed still varies per lane so the two lanes are not
    // locked into the same order, and it still varies per account so the fleet never posts in unison.
    const byLane = (lane) => seededShuffle(entries.filter((e) => sameLane(e.lane, lane)), `${days[0]}|${acc.name}|${lane}`);
    const slots = [];
    for (const lane of ['cover', 'harvest', 'seed']) {
      // A lane with more entries than days wraps, which can only happen if a slot count is raised
      // above 7; the same-lane collision that creates is real, so say so rather than shipping it.
      const list = byLane(lane);
      if (list.length > days.length) console.warn(`⚠ ${acc.name}: ${list.length} ${lane} entries for ${days.length} days — two will share a slot time`);
      list.forEach((e, k) => slots.push({ day: days[k % days.length], ...e }));
    }
    slots.sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? -1 : 1));
    plan.push({ account: acc.name, handle: acc.handle, socialSetId: acc.socialSetId, slots });
  });

  // Enforce the operator's max-2-accounts-per-source-per-day rule before anything is reported or
  // written. Runs on the assembled plan (not per account) because the breach is only visible fleet-wide.
  const { swaps, unresolved } = capSameDaySource(plan);

  // RE-FILL every viral slot under the per-day rule (operator 2026-08-27: "ONLY constraint is not
  // reusing the same thread in the same day across more than 1 account"). assignViral above already
  // placed a donor in each slot; this overwrites those with picks drawn against the whole pool
  // rather than a week-wide reservation, which is what unlocks the other ~70 donors.
  //
  // ORDER MATTERS AND COST A BUG. This ran BEFORE capSameDaySource on the first cut, and the cap
  // SWAPS SLOT DAYS to break up mold collisions — so a viral slot filled for one day was moved to
  // another and landed on a donor that day already had. The 2026-08-28 plan shipped exactly that:
  // Julian and Magnus both on rec4xVIMpQL5FAFTy. A per-day invariant can only be established after
  // the days have stopped moving, so the fill goes last.
  const viralFill = fillViralByDay(plan, viralPool, {
    memory,
    commit: (pick) => commitProducts(`${pick.hook}\n${pick.body || ''}`, allProducts, planUse, 3, filterReport, { prefer: pick.bridges || [] }),
  });

  // SELF-CHECK, because the bug above was an ORDERING bug and a unit test on fillViralByDay could
  // never have caught it — the function was correct, it just ran too early. This asserts the
  // invariant on the finished plan, where it is actually meaningful, so any future step inserted
  // between the fill and the write announces itself instead of quietly double-booking a day.
  const dayDupes = [];
  for (const day of [...new Set(plan.flatMap((p) => p.slots.map((s) => s.day)))]) {
    const seen = new Map();
    for (const p of plan) for (const s of p.slots) {
      if (s.day !== day || !sameLane(s.lane, 'cover') || !s.recId) continue;
      if (seen.has(s.recId)) dayDupes.push(`${day} ${s.recId}: ${seen.get(s.recId)} + ${p.account}`);
      else seen.set(s.recId, p.account);
    }
  }

  // ---- review report -----------------------------------------------------------------------------
  const week = days[0];
  const harvestPlanned = plan.flatMap((p) => p.slots).filter((s) => s.lane === 'harvest').length;
  console.log(`WEEK PLAN ${week} — ${accounts.length} accounts x ${MOLD_SLOTS}+${VIRAL_SLOTS}+${LAWS.scale.harvestSlots} slots (${plan.reduce((n, p) => n + p.slots.length, 0)} planned; ~1 auto-repost/account rides the daily-winners cron)`);
  console.log(`viral pool: ${viralPool.length} bridge-gated candidates (${viralPool.filter((c) => c.listicle).length} listicle-boosted, from ${recs.length} raw) · harvest bench filled ${harvestPlanned}/${accounts.length * LAWS.scale.harvestSlots} slot(s)`);
  const viralRecIds = plan.flatMap((p) => p.slots).filter((s) => sameLane(s.lane, 'cover')).map((s) => s.recId);
  console.log(`viral fill: ${viralFill.filled} slot(s) placed per-day${viralFill.starved ? `, ${viralFill.starved} STARVED (pool too small for a day)` : ''} · ${new Set(viralRecIds).size} distinct donors across ${viralRecIds.length} slots`);
  if (dayDupes.length) {
    console.log(`\n⛔ SAME-DAY DONOR REUSE — the one rule this lane has, broken ${dayDupes.length}x:`);
    for (const d of dayDupes) console.log(`   ${d}`);
    console.log('   (a step now runs between fillViralByDay and the write, and it moves days)');
    process.exitCode = 1;
  }
  if (bannedRecs.length) {
    console.log(`banned topics: ${bannedRecs.length} donor(s) dropped before scoring`);
    for (const b of bannedRecs) console.log(`   ⛔ ${b.hook}`);
  }
  console.log(`product filters: ${filterReport.noPod} candidate(s) had no pod and could not carry a CTA`
    + ` · ${filterReport.demoted} demoted as judged losers (>=${JUDGE_MIN_CLICKS} clicks, under $${fleetEpc().toFixed(3)})`
    + ` · explorers ${filterReport.exploreSpent}/${filterReport.exploreBudget}`
    + (filterReport.podStarved ? ` · ${filterReport.podStarved} slot(s) fell back because NOTHING in range had a pod` : '')
    + (filterReport.epcStarved ? ` · ${filterReport.epcStarved} slot(s) took a below-fleet product because nothing measured fit` : ''));
  console.log('');
  if (swaps.length) console.log(`same-day cap: moved ${swaps.length} slot(s) — ${swaps.map((s) => `${s.account} ${s.key} ${s.from}->${s.to}`).join(' · ')}`);
  if (unresolved.length) console.log(`⚠ same-day cap UNRESOLVED (no legal swap): ${unresolved.map((u) => `${u.cell} x${u.n}`).join(', ')}`);
  if (swaps.length || unresolved.length) console.log('');
  for (const p of plan) {
    console.log(`■ ${p.account}`);
    for (const s of p.slots) {
      if (sameLane(s.lane, 'seed')) console.log(`  ${s.day} SEED  ${s.moldId} ${s.status === 'experimental' ? '🧪' : '  '} ${String(s.mold).padEnd(34)} → ${(s.products || []).map((p) => p.asin).join(',') || '(none)'}`);
      else if (s.lane === 'harvest') console.log(`  ${s.day} HARV  ${((s.parentStats.impressions || 0) / 1e6).toFixed(1)}M ${String(s.parentStats.clicks || 0).padStart(4)}clk (harvest-build vs queues/harvest/${s.harvestOf}.json) | ${s.parentHook}`);
      // SELL@n says the creator monetized their own thread at that tweet, so our plug replaces
      // theirs in place rather than being invented somewhere colder. It is the highest-value mark
      // on the line and it belongs where the operator reads the plan, not only in the score.
      else console.log(`  ${s.day} VIRAL ${(s.views / 1e6).toFixed(1)}M ${s.listicle ? 'LIST ' : '     '}${s.convertTo === 'roundup' ? '⇒ROUNDUP ' : s.convertTo === 'deepDive' ? '⇒DEEP    ' : '         '}${(s.sellSlots || []).length ? `SELL@${s.sellSlots.map((x) => x.at).join(',')} ` : ''}→ ${(s.products || []).map((p) => p.asin).join(',') || '(none)'} | ${s.hook}`);
    }
  }
  const moldMix = plan.flatMap((p) => p.slots).filter((s) => sameLane(s.lane, 'seed')).reduce((m, s) => (m[s.moldId] = (m[s.moldId] || 0) + 1, m), {});
  console.log(`\nmold mix: ${Object.entries(moldMix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(' ')}`);
  const shortfall = plan.filter((p) => p.slots.filter((s) => sameLane(s.lane, 'cover')).length < VIRAL_SLOTS);
  if (shortfall.length) console.log(`⚠ viral shortfall on: ${shortfall.map((p) => p.account).join(', ')} — pool too small after the bridge gate`);

  if (DRY) { console.log('\n(dry — no plan file written)'); return; }
  mkdirSync(join(HERE_DIR, 'queues'), { recursive: true });
  const file = join(HERE_DIR, 'queues', `week-plan-${week}.json`);
  writeFileSync(file, JSON.stringify({ week, generated: new Date().toISOString(), accounts: plan }, null, 1) + '\n');
  console.log(`\nplan → ${file} (nothing scheduled; generation consumes this in cutover step 3)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'plan-week');
