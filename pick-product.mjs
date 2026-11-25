// pick-product.mjs — thematic Levanta product selection, shared by run-weekly + daily-winners.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { anthropic, FLEET_MODEL, HERE_DIR } from './lib.mjs';
import { LAWS } from './laws.mjs';
import { STACK_RE, DENY_ASINS as DENY, KEEP_ASINS as KEEP, ALLOW_ASINS as ALLOW, EXPERIMENT_ASINS as EXPERIMENT, FLOOR_EXEMPT_ASINS, PHYSICAL_ASINS } from './checks.mjs'; // singles-only policy + curated allowlist + sprint allowlist (data: keep-asins.json, loaded once by checks.mjs)
import { restatedEpc } from './rate-moves.mjs'; // realized EPC, restated at today's commission (data: learnings/rate-moves.jsonl)

// ---- Topic taxonomy (topics.json — data, not code; 2026-07-21) --------------------------------------
// Hook regexes, product-fit regexes, and adjacency per topic live in topics.json so taxonomy edits are
// reviewable data-only diffs. ARRAY ORDER IS SEMANTIC there (classifyTopic = first hook match).
// Compiled once here; every other module keeps importing from this file. 'general' stays the implicit
// no-match fallback — deliberately absent from the file (no product regex → no selection path can
// exploit it; generation falls back to the account default). A missing/garbled file THROWS: silently
// empty maps would classify everything 'general' and quietly route all slots to default products.
let _tax;
try { _tax = JSON.parse(readFileSync(new URL('./topics.json', import.meta.url), 'utf8')).topics; }
catch (e) { throw new Error(`topics.json unreadable (${e.message}) — the topic taxonomy must load`); }
const TOPICS = Object.fromEntries(_tax.map((t) => [t.key, new RegExp(t.hook, 'i')]));
const PRODUCT_RE = Object.fromEntries(_tax.map((t) => [t.key, new RegExp(t.product, 'i')]));
// Every topic bucket, in classification order — shared so consumers (curation audit's coverage math)
// stop hand-maintaining their own copy of the list.
export const TOPIC_KEYS = _tax.map((t) => t.key);

// Performance-driven (Amazon Attribution report): proven earners get a rank boost; dead-traffic
// products (high clicks, zero conversions) are denied entirely so the picker never links them.
// REBUILT 2026-08-26 from learnings/product-board.json (levanta-days.jsonl, lifetime). The previous
// table was hand-maintained against a live 90d window and had drifted badly: it boosted two
// Formulation Factory ASINs whose entire catalog now 404s at Levanta, and quoted B07NXW4GW7 at
// "EPC 0.309" against a measured $0.602 and B0CV2RSRFX at "6,026 clicks / EPC 0.068" against 1,075
// / $0.242. Boost = 3 for at least twice fleet EPC, 2 for above fleet, on >= 100 lifetime clicks.
// Only a LIGHT tiebreak — valueOf already ranks on realized EPC and we still want to test.
// This is the one place a human number remains: refresh it from `node product-board.mjs` and never
// from memory. Dead-link brands are excluded no matter what they earned.
// 2026-11-19 (owner: "choose higher commission products across the board... go hard and make the most money";
// "SR D3 + K2: just plug it less than other products"): the tiebreak now favours the top payout per sale
// (DR mag glycinate ~$22.49, Magtein $22.48, DR ubiquinol $22.39) and SR D3+K2 (25%) drops to the bottom.
const PROVEN = { B0GT2JKMYZ: 3, B09QFSDLL5: 3, B0GTS6GGSK: 3, B0DXR7MPNV: 2, B07DX89ZHN: 2, B01IQB2UYS: 1, B079K32QB6: 2, B0CV2SXX5M: 1, B0C87VT8CW: 1, B0CZMDPWG5: 2, B0CLYQ9KX2: 2, B07NXW4GW7: 0 };
// DENY + STACK_RE imported from checks.mjs (shared singles-only policy).

// Multi-ingredient "stacks"/bundles (10-in-1 complexes, "A x B x C" combos, blends) carry the fattest
// commission but are pricey and convert worse — a single, cheaper product converts higher. Rank
// cheap singles > pricey singles > stacks; the LLM still picks for thematic fit within that order.
const PRICE_CAP = 70; // above this a single is "expensive" and mildly deprioritized (tunable). This is the
// ONLY price rule: price is a CEILING, never a floor (owner 2026-11-04: "expensive is the ceiling not too
// cheap as the floor"). A cheap single that converts is ranked on its EPC like anything else.
// A KEEP entry is the operator's vetting, so a curated hero stack (The Night Before) skips the
// stack penalty — same override the singles filter in candidates() applies. Without this the tier
// sort buried a vetted bundle below every single no matter what it realized per click.
// EXPORTED with an injectable keep set (2026-09-19). The vetted-stack override is a RULE about how a
// curated bundle sorts, but it could only ever be tested through whichever stack happened to be
// curated that day — and when the last one (The Night Before) left the menu for stock, the test
// died with it and told us nothing about the rule. `keep` defaults to the live set, so production
// behaviour is byte-identical; a caller may pass its own to assert the ordering on its own terms.
export const tier = (p, keep = KEEP) => (STACK_RE.test(`${p.title} ${p.category || ''}`) && !keep.has(p.asin) ? 2 : 0) + (Number(p.price) >= PRICE_CAP ? 1 : 0);

// EPC-weighted value: EPC (real $ earned per click) is the truest signal, so within a tier we rank on
// it when we have it (high commission on a non-converter = $0, the 763-clicks lesson). When a product
// has no EPC yet, fall back to a commission-based PRIOR (price x commission x an assumed conversion
// rate) so unproven products slot in sensibly by expected value instead of always sorting last.
const ASSUMED_CVR = 0.02; // prior conversion rate used to express commission% in EPC ($/click) terms
// Exploration allowance: how many NON-curated "explorer" products ride alongside the curated KEEP set in
// each candidate list, so a genuinely better-fitting or newly-worth-testing product can still surface and
// the curated list never becomes a hard wall. Tunable via env; 0 = curated-only (when KEEP has a match).
const EXPLORE_N = Number(process.env.PRODUCT_EXPLORE ?? LAWS.product?.exploreSlots ?? 2);
// REALIZED per-ASIN performance (learnings/product-perf.json, written by learn.mjs from real Levanta
// outcomes — audit 2026-07-21). Our own $/click beats both the static catalog epc (null on 107/341
// products) and the ASSUMED_CVR prior — but only once a product has enough clicks for the number to
// mean something (below the floor a single lucky/unlucky day would whipsaw the ranking).
const REAL_EPC_MIN_CLICKS = Number(process.env.REAL_EPC_MIN_CLICKS ?? 20);
let _perf, _fleetEpc;
// SOURCE ORDER (2026-08-26). learnings/product-board.json is preferred over product-perf.json for
// two reasons. It is more ACCURATE: perf comes from a live 90d Levanta window whose MAX-per-(date,
// link) click dedup under-counts any link whose clicks arrive split across halo-ASIN rows rather
// than repeated, and it under-counted NAD+ at 734 clicks / EPC $0.239 against the settled file's
// 2,334 / $0.092 — so the fleet's worst product ranked as merely average and kept winning slots.
// And it is FRESHER: the board rides registry-sync (6x daily) while learn.mjs runs Mon+Thu.
// perf stays the fallback so a checkout without a board still ranks on realized data.
export function productPerf() {
  if (_perf !== undefined) return _perf;
  _perf = {}; _fleetEpc = null;
  try {
    const b = join(HERE_DIR, 'learnings', 'product-board.json');
    if (existsSync(b)) {
      const board = JSON.parse(readFileSync(b, 'utf8'));
      for (const r of board.rows || []) _perf[r.asin] = { clicks: r.clicks, conv: r.orders, commission: r.commission, epc: r.epc, cvr: r.cvr, product: r.title || r.asin, updated: board.generated?.through || null };
      _fleetEpc = board.fleet?.epc ?? null;
    }
  } catch { _perf = {}; }
  if (Object.keys(_perf).length) return _perf;
  try { const f = join(HERE_DIR, 'learnings', 'product-perf.json'); _perf = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; } catch { _perf = {}; }
  return _perf;
}

// Fleet EPC, measured. Every floor below is a MULTIPLE of it rather than an absolute dollar figure:
// the fleet average moves as the mix improves, and a hardcoded floor silently stops meaning what it
// meant. Computed from `perf` when the board is absent so tests can inject.
export function fleetEpc(perf = productPerf()) {
  if (perf === _perf && _fleetEpc != null) return _fleetEpc;
  let c = 0, k = 0;
  for (const r of Object.values(perf || {})) {
    const clicks = Number(r?.clicks) || 0;
    k += clicks;
    // commission when the row carries it, else reconstruct from epc — a perf map assembled by hand
    // (or by an older writer) may hold only $/click, and dropping those rows would compute the
    // fleet average over a subset and quietly make every floor too low.
    c += Number.isFinite(Number(r?.commission)) ? Number(r.commission) : clicks * (Number(r?.epc) || 0);
  }
  return k ? c / k : FLEET_EPC_FALLBACK;
}
// Used only when there is no data at all — a fresh checkout, or a test with an empty perf map.
// Measured 2026-08-26 across 35,336 lifetime clicks.
const FLEET_EPC_FALLBACK = 0.348;
// Value ladder: REALIZED epc (>= REAL_EPC_MIN_CLICKS clicks) > static catalog epc > commission prior.
// `perf` injectable for tests.
// CATALOG-EPC CALIBRATION (2026-08-08 forensic audit): Levanta's platform EPC is measured on warm,
// established-affiliate audiences and runs 4-10x ABOVE what the same product earns on our cold tweet
// traffic (8 products with >=100 realized clicks: ours = 0-24% of catalog, median ~15%). Trusting it
// raw is how stacks/bad fits ranked INTO rotation and burned their first few hundred clicks. Until a
// product has REAL_EPC_MIN_CLICKS of our own data, its catalog EPC is discounted to this fraction.
// RE-MEASURED 2026-11-04 and raised 0.2 -> 0.9 (owner 2026-11-04: "Go for EPC as primary choosing
// option ... always have room for testing"). Across the 26 products with 300+ of our own clicks, our
// realized EPC is ~0.93x Levanta's network EPC under the rebuilt CTA. The 0.2 haircut was fitted on
// the old CTA and buried every untested high-EPC product (D3+K2 at network $5.25 ranked as $1.05,
// below proven $0.6 earners once spread and tiers applied), so nothing new ever got its first plug.
const CATALOG_EPC_CAL = Number(process.env.PRODUCT_CATALOG_EPC_CAL ?? 0.9);
/**
 * The realized EPC a ranking decision should USE, which is not always the one we measured.
 *
 * EPC is CVR x payout x RATE. The first two are measurements of the product; the third is a term of
 * the deal, and Levanta rates move. A product whose rate was raised has a measured EPC earned under
 * terms that no longer exist, and ranking on it keeps the product competing at the old rate until
 * enough new clicks drag a lifetime average up — thousands of clicks, on anything with history.
 * rate-moves.mjs restates the measured commission day by day at today's rate; see its header for
 * the two cheaper approximations that were measured and rejected. Products whose rate never moved
 * come back untouched, which on the 2026-09-11 board is 80 of 88 rows.
 */
export const realizedEpc = (asin, r, currentRate = null) =>
  (r?.epc == null ? null : restatedEpc(asin, Number(r.epc), currentRate));

export const valueOf = (p, perf = productPerf()) => {
  const r = perf?.[p.asin];
  if (r && Number(r.clicks) >= REAL_EPC_MIN_CLICKS && r.epc != null) return realizedEpc(p.asin, r, p.commission);
  const e = parseFloat(p.epc || 0) * CATALOG_EPC_CAL; // platform number, haircut to our observed reality
  return e > 0 ? e : Number(p.price || 0) * Number(p.commission || 0) * ASSUMED_CVR;
};

// PROVEN-LOSER FLOOR (2026-08-08). valueOf RANKS by realized EPC, but a proven loser still stays in the
// candidate set — and the final LLM pick chooses on topic-FIT (⭐/💰 are only tiebreaks), so a product
// with enough clicks to KNOW it doesn't convert can still be plugged. That includes a curated KEEP
// product that has DECAYED, which would otherwise keep getting plugged until the bi-weekly audit drops
// it. This is the real-time floor: >= LOSER_MIN_CLICKS realized clicks at < LOSER_EPC $/click = never
// plug (same $0.03 floor product-audit uses for its efficiency DROP, so pick-time and the audit agree).
// candidates() only applies it when converters remain — a topic is never starved into no plug at all.
//
// RAISED 2026-08-26. The old floor was 300 clicks at a flat $0.03, and it never fired: NAD+ ran to
// 2,334 clicks at EPC $0.092 — the single worst product on the board, 8.4% of fleet clicks for 0.6%
// of the money — and sailed past it. A floor that cannot catch the worst product is not a floor.
// It is now 100 clicks (the operator's own judging bar) at LOSER_MULT x the MEASURED fleet EPC, so
// it keeps meaning "conspicuously worse than average" as the mix moves instead of drifting into
// irrelevance. The 18 catalog ASINs under 100 clicks stay unjudged and keep their run.
const LOSER_MIN_CLICKS = Number(process.env.PRODUCT_LOSER_MIN_CLICKS ?? LAWS.product?.winnerMinClicks ?? 100);
// Physical products are judged at their own bar (laws.product.$winnerMinClicksPhysical, operator
// 2026-10-06: 200 clicks) — the same bar product-test.mjs uses, so the picker cannot retire what the
// test is still collecting data on.
const LOSER_MIN_CLICKS_PHYSICAL = Number(process.env.PRODUCT_LOSER_MIN_CLICKS_PHYSICAL ?? LAWS.product?.winnerMinClicksPhysical ?? LOSER_MIN_CLICKS);
export const loserMinClicks = (asin) => (PHYSICAL_ASINS.has(asin) ? LOSER_MIN_CLICKS_PHYSICAL : LOSER_MIN_CLICKS);
const LOSER_MULT = Number(process.env.PRODUCT_LOSER_EPC_MULT ?? LAWS.product?.loserEpcMultiple ?? 0.35);
// ABSOLUTE floor (operator 2026-09-19: "raise the floor of performance to epc 0.45"). The relative
// floor above answers "is this product worse than our average?"; this one answers "is a click on it
// worth having at all?". They are combined with max() rather than swapped, so the relative floor
// resumes control by itself once the fleet average passes MIN_EPC / LOSER_MULT — no second edit and
// no dead constant left behind. See laws.json product.$minEpcFloor.
// Read at CALL time, not module load, for the same reason PRODUCT_LOSER_EPC is: the relative-floor
// unit tests inject their own fleet and need to switch the absolute floor off to exercise the
// mechanism they were written for. A load-time constant cannot be overridden after import.
export const minEpcFloor = () => Number(process.env.PRODUCT_MIN_EPC ?? LAWS.product?.minEpcFloor ?? 0);
// PHYSICAL products (keep-asins.json physical:true) take their own absolute bar (operator 2026-10-02:
// "for physical product lower floor to 0.35 EPC"). See laws.json product.$minEpcFloorPhysical.
export const minEpcFloorPhysical = () =>
  Number(process.env.PRODUCT_MIN_EPC_PHYSICAL ?? LAWS.product?.minEpcFloorPhysical ?? minEpcFloor());
/** The floor in dollars, from measurement. Exported so reports can print what is being enforced.
 *  Pass the ASIN to get that product's floor: a physical product swaps the absolute bar. */
export const loserEpcFloor = (perf = productPerf(), asin = null) =>
  Number(process.env.PRODUCT_LOSER_EPC ?? Math.max(fleetEpc(perf) * LOSER_MULT,
    PHYSICAL_ASINS.has(asin) ? minEpcFloorPhysical() : minEpcFloor()));
// BRIDGE ROUTES ARE NOT DISCRETIONARY, so they are judged on the RELATIVE floor alone (2026-09-19).
//
// provenLoser answers "may the picker CHOOSE this?", and since the operator raised the absolute bar
// to $0.45 the answer is no for a lot more of the shelf. A BRIDGE is a different question: the
// thread has ALREADY argued the substance, and the route decides what it sells. Applying the
// absolute bar there does not stop us plugging a weak product — it strands the thread, and
// gate-thread then refuses it outright under LAW G6 ("argues X across N tweets but never sells
// it"). On the 2026-09-19 board that is five lanes, two of which (blood sugar, gut) have no other
// stocked product at all, so the strict reading closes them rather than improving them.
//
// So the absolute floor governs every FREE choice, and the relative floor — "conspicuously worse
// than our own average", which is what this invariant was written against — governs the routes a
// thread has already committed to. This is deliberately NOT done by growing BRIDGE_LOSER_EXEMPT:
// that set is a per-product decision and its size guard exists to keep it one.
export const bridgeUnsellable = (asin, perf = productPerf()) => {
  const r = perf?.[asin];
  const e = realizedEpc(asin, r, null);
  const relFloor = Number(process.env.PRODUCT_LOSER_EPC ?? fleetEpc(perf) * LOSER_MULT);
  return !!(r && Number(r.clicks) >= LOSER_MIN_CLICKS && e != null && e < relFloor);
};

export const provenLoser = (p, perf = productPerf()) => {
  // The operator's per-product override on the absolute floor (keep-asins.json floorExempt). It
  // only ever lets a product back IN, and only one the operator named, so it cannot hide a product
  // nobody vetted. Stock is not waived by it: an exempt product that is unbuyable is still skipped
  // upstream, because a dead link is a different failure from a weak one.
  if (FLOOR_EXEMPT_ASINS.has(p?.asin)) return false;
  const r = perf?.[p.asin];
  // Judged on the RESTATED EPC, for the same reason valueOf ranks on it: condemning a product for
  // what it earned at a rate we no longer pay is condemning it for the old deal. The correction can
  // only raise an EPC here, so this can never newly exclude a product — it only stops excluding one.
  const e = realizedEpc(p.asin, r, p.commission);
  return !!(r && Number(r.clicks) >= loserMinClicks(p.asin) && e != null && e < loserEpcFloor(perf, p.asin));
};

/** provenLoser's verdict with its numbers, for a stop that has to SHOW the owner why (the /run
 *  products stop, 2026-09-26). `loser` is provenLoser exactly; `underFloor` is the same test with
 *  the floorExempt override set aside, so an exempt product can pass with a note, not silently. */
export const floorVerdict = (p, perf = productPerf()) => {
  const r = perf?.[p?.asin];
  const clicks = r ? Number(r.clicks) : null;
  const epc = realizedEpc(p?.asin, r, p?.commission);
  const floor = loserEpcFloor(perf, p?.asin);
  const exempt = FLOOR_EXEMPT_ASINS.has(p?.asin);
  const minClicks = loserMinClicks(p?.asin);
  const underFloor = !!(r && clicks >= minClicks && epc != null && epc < floor);
  return { epc, clicks, floor, minClicks, exempt, underFloor, loser: underFloor && !exempt };
};

// PROVEN WINNER + RAISED DIVERSITY CAP (operator ruling 2026-08-11). The flat 7-day cap of 2
// plugs/ASIN/account protects against audience fatigue, but it also throttled our best converters:
// the Aug-11 decomposition showed Nutricost Magnesium HOLDING 10.9% CVR while losing 86% of its
// click volume, i.e. the cap was fighting revenue concentration. Operator's call: raise the cap for
// proven winners, don't remove it — so no single product can ever dominate a page's voice.
// Winner = enough of OUR OWN realized data (>= WINNER_MIN_CLICKS) at or above the MEASURED fleet
// EPC. Was a flat $0.30 "just under the ~$0.34 fleet average" — the same drift problem as the loser
// floor, so it is now WINNER_MULT x fleet and the phrase "measurably above average" stays true by
// construction rather than by a comment that ages.
const WINNER_MIN_CLICKS = Number(process.env.PRODUCT_WINNER_MIN_CLICKS ?? LAWS.product?.winnerMinClicks ?? 100);
const WINNER_MULT = Number(process.env.PRODUCT_WINNER_EPC_MULT ?? LAWS.product?.winnerEpcMultiple ?? 1.0);
export const winnerEpcFloor = (perf = productPerf()) => Number(process.env.PRODUCT_WINNER_EPC ?? fleetEpc(perf) * WINNER_MULT);
export const PLUG_CAP_DEFAULT = Number(process.env.PLUG_CAP_DEFAULT ?? 2);
export const PLUG_CAP_WINNER = Number(process.env.PLUG_CAP_WINNER ?? 4);
export const provenWinner = (asin, perf = productPerf()) => {
  const r = perf?.[asin];
  // Restated too, so a rate rise reaches the DIVERSITY CAP and not only the ranking. This is the one
  // place the correction hands out something rather than merely reordering — 4 plugs per account per
  // 7 days instead of 2 — so it stays bounded by the same ceiling every other winner lives under.
  // Callers here hold an ASIN and not the catalog row, so the log's own latest rate stands in.
  const e = realizedEpc(asin, r);
  return !!(r && Number(r.clicks) >= WINNER_MIN_CLICKS && e != null && e >= winnerEpcFloor(perf));
};
/** Per-ASIN 7-day plug cap: proven winners get the raised ceiling, everything else the default. */
export const plugCapFor = (asin, perf = productPerf()) => (provenWinner(asin, perf) ? PLUG_CAP_WINNER : PLUG_CAP_DEFAULT);

// PERMANENT EXPLORE RHYTHM (2026-08-08, operator request): EVERY account gets product-explore
// periods, not just young pages — "highest commission × highest conversion = highest ROI" is found
// by TESTING, and defaulting to the same 1-2 proven options forever can't find it. On EXPLORE_DOW
// Saigon weekdays (default Tue+Sat — fresh-content days, clear of the Mon/Wed/Fri repost lane) every
// slot picks in explore mode: 3x non-curated explorer candidates, learned-converter pin off. The
// other fresh days exploit what the testing has proven. Safety rails that make permanent exploration
// cheap: the 0.2x catalog-EPC haircut (explorers rank realistically), the proven-loser floor (a bad
// explorer exits after 300 clicks), the 7-day diversity spread, and learn.mjs folding every result
// back into the per-topic converter pins. EXPLORE_DOW='' disables (account-mode only).
const EXPLORE_DOW = new Set((process.env.EXPLORE_DOW ?? '2,6').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
export function slotSelectionMode(accountMode, dow, { exploreDow = EXPLORE_DOW } = {}) {
  if (accountMode === 'explore') return 'explore'; // young / explicitly-exploring pages explore every day
  return exploreDow.has(dow) ? 'explore' : 'exploit';
}

// PLUG-DIVERSITY MEMORY (2026-08-08, operator request): how often each ASIN was plugged by ONE
// account in the trailing window, straight from the ledger (asin + asin2 per created draft). Fed as
// `usedAsins` into pickProduct/pickProductPair's existing spread filter — the weekly batch already
// capped repeats WITHIN a batch, but the daily path (the main path since 2026-07-12) had NO
// cross-day memory: an account could plug the same SKU every single day (fatigue + never giving new
// curated products a chance). The filter stays SOFT (only applies when >=2 candidates remain), so a
// thin topic still gets its best-fit plug rather than none. `lines` injectable for tests.
export function recentAsinUse(accountName, { days = 7, now = Date.now(), lines } = {}) {
  const use = {};
  try {
    const src = lines ?? (existsSync(join(HERE_DIR, 'ledger.jsonl')) ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean) : []);
    const cutoff = now - days * 864e5;
    for (const line of src) {
      try {
        const e = typeof line === 'string' ? JSON.parse(line) : line;
        if (e.account !== accountName || !e.ts || Date.parse(e.ts) < cutoff) continue;
        for (const a of [e.asin, e.asin2]) if (a) use[a] = (use[a] || 0) + 1;
      } catch {}
    }
  } catch {}
  return use;
}

// Topic adjacency for STRICTER thematic fit: when a thread's direct topic pool is thin, broaden to
// the RELATED topics declared in topics.json before giving up — never to an arbitrary high-commission
// slice (which plugs an off-topic product). If even adjacency finds nothing, candidates() returns
// empty and the caller falls back to the account's on-brand default product.
const ADJACENT = Object.fromEntries(_tax.filter((t) => t.adjacent?.length).map((t) => [t.key, t.adjacent]));

// Topic of a thread = the first TOPICS bucket its hook matches. Shared with learn.mjs so the feedback
// loop aggregates revenue by the SAME topic the picker selects on.
//
// `general` IS NOT A TOPIC, IT IS A MISS (operator 2026-09-17, on a 7.97M donor this returned
// `general` for: "There is always a way to plug into a thread, you can't just reject it ... I think
// there's just some issue with the classification here"). The hook was "Scientists just cracked the
// multiple sclerosis code after decades of searching." Nothing in it matches a bucket regex, so the
// donor came back untopiced — and untopiced costs it twice over, because intentFactor returns 1 for
// `general` and the novelty tilt files every miss into one ever-growing bucket, so the fleet's four
// most-repeated covers and its genuinely unclassifiable ones tilt each other.
//
// So: hook first, and when the hook alone says `general`, read the BODY rather than give up. The
// body is a fallback and never an override, because reading it first is a defect this file already
// had — see the note on rankDonors, where feeding whole threads labelled 8 of 11 donors `sleep`.
// Two things make the fallback safe where the original was not. It only ever runs on a hook that
// classified as nothing, so there is no classification for body noise to overwrite. And it counts
// MATCHES instead of taking the first bucket in taxonomy order, which is what made `sleep` — index 0
// — swallow every long body that mentioned a night's rest in passing.
export function classifyTopic(text = '', body = null) {
  for (const [t, re] of Object.entries(TOPICS)) if (re.test(text)) return t;
  if (!body) return 'general';
  const hay = String(body);
  let best = null, bestN = 0;
  for (const [t, re] of Object.entries(TOPICS)) {
    const n = (hay.match(new RegExp(re.source, 'gi')) || []).length;
    if (n > bestN) { best = t; bestN = n; }
  }
  return best || 'general';
}

// topicsForProduct(product) — every TOPIC bucket a PRODUCT fits, via PRODUCT_RE (which knows ingredient
// names: "ashwagandha" -> stress, "beet" -> heart), NOT classifyTopic (that is tuned for thread HOOKS and
// doesn't know ingredients). An explicit product.topics array overrides the derivation. Accepts a product
// object or a raw title/category string. Shared by the curation audit (coverage) and skeleton-mode topic
// rotation. Returns [] if nothing matches.
export function topicsForProduct(product) {
  if (product && Array.isArray(product.topics) && product.topics.length) return product.topics.filter((t) => Object.prototype.hasOwnProperty.call(PRODUCT_RE, t));
  const hay = typeof product === 'string' ? product : `${product?.title || ''} ${product?.category || ''}`;
  return Object.keys(PRODUCT_RE).filter((t) => PRODUCT_RE[t].test(hay));
}

// ---- Skeleton-variation topic rotation (product-fit topic, VALUE-weighted, no-repeat window) ---------
// In skeleton-variation mode the PRODUCT is chosen first, then the TOPIC is chosen to fit it — inverting
// today's hook->product flow and fixing the retro-flagged revenue bottleneck. nextTopic picks among the
// topics this product fits (topicsForProduct), honoring a hard `windowDays` no-repeat window per account.
// CLOSED LOOP (2026-07-17): among ELIGIBLE topics (outside the window) the rotation is no longer blind
// LRU — topics with PROVEN realized revenue (learnings/product-topic.json, written by learn.mjs from real
// sales) lead, so a page's turns go to converting subjects first; LRU breaks ties, which is also where
// unproven topics get their exploration turns (a proven topic re-enters the window after each use, handing
// the next ~windowDays of turns to the rest). The window fallback (every fit-topic used recently) stays
// pure-LRU: when we must repeat early, recency matters more than value. Pure: state/now/learned are all
// injectable, so it is deterministic + testable.
export function nextTopic(account, product, { state = {}, now = Date.now(), windowDays = 14, learned } = {}) {
  const topics = topicsForProduct(product);
  if (!topics.length) return null;
  const L = learned === undefined ? learnedWinners() : (learned || {});
  const value = (t) => { const w = L[t]; return w ? (Number(w.commission) || 0) : 0; }; // decayed realized $ for this topic route
  const used = (state && state[account]) || {}; // { topic: lastUsedISO }
  const cutoff = now - windowDays * 864e5;
  const lastUsed = (t) => { const ms = Date.parse(used[t]); return Number.isFinite(ms) ? ms : -Infinity; }; // never-used sorts first
  const eligible = topics.filter((t) => lastUsed(t) < cutoff);
  if (eligible.length) return eligible.sort((a, b) => value(b) - value(a) || lastUsed(a) - lastUsed(b) || topics.indexOf(a) - topics.indexOf(b))[0];
  return topics.slice().sort((a, b) => lastUsed(a) - lastUsed(b) || topics.indexOf(a) - topics.indexOf(b))[0];
}

// Rotation state persistence (queues/topic-rotation.json): { account: { topic: lastUsedISO } }. Lazy +
// defensive — a missing/garbled file never breaks generation. recordTopicUse stamps a pick so the next
// nextTopic() sees it; `when` is injectable for tests (defaults to now).
const ROTATION_FILE = join(HERE_DIR, 'queues', 'topic-rotation.json');
export function loadRotation() {
  try { return existsSync(ROTATION_FILE) ? JSON.parse(readFileSync(ROTATION_FILE, 'utf8')) : {}; } catch { return {}; }
}
// Concurrency note (2026-07-21 scaling audit follow-up): this read-modify-write is fully
// SYNCHRONOUS, so concurrent runSlot chains in one process cannot interleave it (single-threaded
// event loop) — no mutex needed. The only writer processes are the engines' main loops; recreate
// children never call it.
export function recordTopicUse(account, topic, when) {
  const state = loadRotation();
  (state[account] ||= {})[topic] = (when instanceof Date ? when : (when ? new Date(when) : new Date())).toISOString();
  try { mkdirSync(dirname(ROTATION_FILE), { recursive: true }); writeFileSync(ROTATION_FILE, JSON.stringify(state, null, 1) + '\n'); } catch {}
  return state;
}

// Named-substance detector: a thread that names an ingredient we actually sell is the tightest product
// fit (best conversion). Tunable — extend as the catalog grows.
const SUBSTANCE = /\b(magnesium|glycinate|melatonin|zinc|iron|calcium|potassium|selenium|iodine|chromium|boron|vitamin|b12|biotin|omega|fish oil|krill|creatine|collagen|whey|protein|bcaa|glycine|taurine|theanine|tyrosine|glutathione|glutamine|carnitine|nac|nad\+?|nmn|coq10|ubiquinol|resveratrol|spermidine|quercetin|fisetin|ashwagandha|ashwaganda|rhodiola|ginseng|ginkgo|tongkat|citrulline|nitric oxide|glucosamine|turmeric|curcumin|berberine|saffron|reishi|cordyceps|lion.?s mane|probiotic|prebiotic|milk thistle|electrolyte|inositol|choline|psyllium|adaptogen|nootropic)\b/i;
// Monetizability tier (higher = tighter product fit = better conversions): 2 = names a substance we sell,
// 1 = maps to a product TOPIC (classifyTopic) but names no substance, 0 = topicless. The selectors
// (daily-winners + weekly select) rank on this so plug-native content fills slots first. ONE shared rule.
export function monetizabilityTier(text = '') { return SUBSTANCE.test(text) ? 2 : (classifyTopic(text) !== 'general' ? 1 : 0); }

// Learned per-topic converters (written by learn.mjs from real sales: time-decayed + explore/exploit gated).
// Lazy + defensive: a missing or garbled file must never break generation.
let _learned;
function learnedWinners() {
  if (_learned !== undefined) return _learned;
  try { const f = join(HERE_DIR, 'learnings', 'product-topic.json'); _learned = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; }
  catch { _learned = {}; }
  return _learned;
}
// ASIN that converts best for this hook's topic — only when the loop is confident enough to EXPLOIT it
// (else null = keep exploring via thematic ranking). A light boost, never a hard override.
export function learnedWinnerFor(text) { const w = learnedWinners()[classifyTopic(text)]; return w && w.confident ? w.asin : null; }
// Same signal keyed DIRECTLY by topic (skeleton-variation mode already knows its topic — no hook to
// classify). Returns { asin, title } only for a CONFIDENT route (>= MIN_CONV real conversions) that isn't
// deny-listed; callers decide their own curation policy (e.g. daily-winners additionally requires KEEP).
// `learned` is injectable for tests.
export function learnedProductForTopic(topic, learned) {
  const w = (learned === undefined ? learnedWinners() : (learned || {}))[topic];
  return w && w.confident && w.asin && !DENY.has(w.asin) ? { asin: w.asin, title: w.product || w.asin } : null;
}

// keepProductForTopic(topic, products) — the PRODUCT for a variation slot once its topic is chosen
// (skeleton mode inverts product->topic; with a per-account topic universe the topic can now range
// beyond the default product's fit, so the product must follow the topic). Priority: the topic's
// CONFIDENT learned converter when it's curated (real sales beat everything), else the highest-value
// curated KEEP product that fits the topic (PRODUCT_RE), else null (caller keeps the account default).
export function keepProductForTopic(topic, products = [], learned, { mode = 'exploit' } = {}) {
  const lw = learnedProductForTopic(topic, learned);
  // TOPIC-FIT GUARD (audit 2026-07-21, live bug): the learned converter must actually FIT the topic.
  // "sleep" had learned Omega-3 fish oil — not because fish oil sells sleep, but because it was
  // historically PLUGGED on sleep threads (learn.mjs keys by topic-of-hook × asin-plugged), and this
  // return path skipped PRODUCT_RE entirely. The off-topic product then forced the plug writer to
  // bridge fish oil into a sleep thread — the published substance-drift class. A learned winner that
  // doesn't fit the topic falls through to the curated fit below; ADJACENT topics count as fitting
  // (a stress converter on a sleep night is a legitimate neighbor, not drift).
  const fitsTopic = (title) => {
    const hay = String(title || '');
    return PRODUCT_RE[topic]?.test(hay) || (ADJACENT[topic] || []).some((t) => PRODUCT_RE[t]?.test(hay));
  };
  // Availability guard: product-health stamps `unavailable` on snapshot products gone from the live
  // catalog. An ASIN the snapshot doesn't know stays eligible (fail-open — the learned converter may
  // predate the snapshot).
  const byAsin = new Map((products || []).map((p) => [p.asin, p]));
  const gone = (asin) => byAsin.get(asin)?.unavailable === true;
  // EXPLORE mode (per-account Selection Mode, 2026-07-28): skip the learned-converter fast path so
  // the account keeps testing instead of converging — the value sort below still picks a sane fit.
  if (mode !== 'explore' && lw && KEEP.has(lw.asin) && fitsTopic(lw.title) && !gone(lw.asin)) return { ...lw, why: 'learned converter' };
  const fits = (products || []).filter((p) => KEEP.has(p.asin) && !DENY.has(p.asin) && !p.unavailable && PRODUCT_RE[topic]?.test(`${p.title} ${p.category || ''}`));
  if (!fits.length) return null;
  const best = fits.slice().sort((a, b) => valueOf(b) - valueOf(a))[0];
  return { asin: best.asin, title: best.title, why: 'best curated fit' };
}

export function candidates(hookText, products, { mode = 'exploit', perf = productPerf(), bodyText = '' } = {}) {
  // NATIVE FIT (operator rule 2026-08-08): classify on the WHOLE thread, not just the hook — a
  // generic hook ("A radiologist told me:") on a NAD+ thread read as 'general' and fell through to
  // the account default (collagen on a 1.4M-view NAD thread). The body carries the real subject.
  const classText = bodyText ? `${hookText}\n${bodyText}` : hookText;
  const hit = Object.entries(TOPICS).filter(([, re]) => re.test(classText)).map(([t]) => t);
  const learnAsin = learnedWinnerFor(classText);
  // `unavailable` is stamped by the weekly product-health sync when a product vanishes from the live
  // Levanta catalog (out of stock / partnership ended) — never link what can't be bought.
  // SPRINT ALLOWLIST (operator 2026-08-15): when keep-asins.json carries a non-empty `allow`,
  // selection is restricted to those proven converters — realized 5-7% CVR vs 0.2-1.5% for the rest,
  // with 66% of August's clicks having gone to the losing bucket. Restricting HERE (before topic
  // matching) keeps native-fit intact within the menu; the caller's off-list account-default
  // fallback is closed below instead of by starving the pool. PRODUCT_ALLOWLIST=0 disables the gate
  // (same kill-switch pattern as CTA_SPLIT=0) — the instant off-lever, no data edit needed.
  const allowActive = ALLOW.size > 0 && process.env.PRODUCT_ALLOWLIST !== '0';
  // EXPERIMENT products pass the allowlist gate but are NOT treated as proven — they are here to be
  // given a fair run under the rebuilt CTA, which nothing in the catalog has had yet. The ranking
  // below still sorts on realized EPC, so an experiment product wins a slot on fit, not on novelty.
  const eligible = (a) => !allowActive || ALLOW.has(a) || EXPERIMENT.has(a);
  const live = products.filter((p) => !DENY.has(p.asin) && !p.unavailable && eligible(p.asin));
  const matchTopics = (topics) => live.filter((p) => topics.some((t) => PRODUCT_RE[t]?.test(p.title + ' ' + p.category)));
  let pool = matchTopics(hit);
  // STRICTER FIT: a thin direct pool broadens to ADJACENT topics (sleep<->stress, heart<->energy, ...),
  // NEVER to an arbitrary top-by-commission slice — an off-topic plug converts worse than the on-brand
  // default. If even adjacency finds nothing, pool stays empty and the caller uses the account default.
  if (pool.length < 5) {
    const adj = [...new Set(hit.flatMap((t) => ADJACENT[t] || []))].filter((t) => !hit.includes(t));
    if (adj.length) pool = [...new Set([...pool, ...matchTopics(adj)])];
  }
  // With the allowlist active, "no topical fit" must NEVER fall through to the caller's off-list
  // account default — a proven converter slightly off-topic beats a proven loser on-topic (that is
  // the point of the menu). The ranking below still prefers whatever topical fit exists.
  if (!pool.length && allowActive) pool = live;
  // SINGLES ONLY — but an explicitly CURATED product (KEEP) overrides the auto-block (operator vetted it),
  // so curated hero-ingredient stacks like The Night Before still surface. Non-curated stacks are dropped
  // only when a real single exists for the theme.
  const singles = pool.filter((p) => !STACK_RE.test(`${p.title} ${p.category || ''}`) || KEEP.has(p.asin));
  if (singles.length) pool = singles;
  // PROVEN-LOSER FLOOR: drop products realized-proven not to convert — but ONLY when converters remain,
  // so a topic is never starved (a weak on-topic single still beats the account's off-topic default).
  const converters = pool.filter((p) => !provenLoser(p, perf));
  if (converters.length) pool = converters;
  const ranked = pool.sort((a, b) =>
    tier(a) - tier(b)                                     // singles first (cheap single > pricey single > stack)
    || valueOf(b, perf) - valueOf(a, perf)                // EPC-weighted value: real $/click when known, else a commission-based prior (the caller's perf, not the global file — they differ in tests and in any fresh-data pass)
    || ((b.asin === learnAsin ? 1 : 0) - (a.asin === learnAsin ? 1 : 0)) // learned per-topic converter (explore/exploit gated)
    || (PROVEN[b.asin] || 0) - (PROVEN[a.asin] || 0)      // proven converters are only a LIGHT tiebreak — we still want to TEST for new winners
    || Number(a.price || 1e9) - Number(b.price || 1e9)
  );
  // CURATED PREFERENCE (KEEP): curated products lead; a bounded number of non-curated "explorers" ride
  // along so a better-fitting or newly-worth-testing product can still be chosen (flexibility). When the
  // topic has NO curated product, fall back to the full ranked pool so coverage never breaks.
  if (KEEP.size) {
    const kept = ranked.filter((p) => KEEP.has(p.asin));
    // EXPLORE mode (per-account Selection Mode, 2026-07-28): triple the explorer allowance so an
    // account still hunting for its winners actively tests non-curated products instead of
    // re-plugging the curated set. Exploit (default) keeps the tight allowance.
    const exploreN = mode === 'explore' ? EXPLORE_N * 3 : EXPLORE_N;
    if (kept.length) return [...kept, ...ranked.filter((p) => !KEEP.has(p.asin)).slice(0, exploreN)].slice(0, 18);
  }
  return ranked.slice(0, 18);
}

// Fallback rotation (2026-08-08): the no-thematic-fit path used to hard-pin ONE default ASIN, which
// the per-batch spread cap never touched — a generic-hook week shipped the same SKU on every fallback
// slot (Julian 2x, Rafael 3x in one plan) and the 1/day engine could repeat it daily. `fallback` may
// now be a POOL (accounts.mjs: [defaultProduct, ...altProducts]): rotate the starting pick by day so
// consecutive days differ, then advance within a batch once usedAsins hits the cap. Commission is
// looked up live so digests stop reporting the fallback's placeholder 80%. Non-array callers keep
// the old single-default behavior.
export function pickFallback(fallback, products, usedAsins = {}, cap = Infinity, perf = productPerf()) {
  // NO ACCOUNT LANES (operator 2026-08-16). Product choice follows the THREAD — its idea and the
  // specific points it makes — never the account writing it. The per-account defaultProduct /
  // altProducts pools encoded a "lane" per page (Jasper=brain, Marcos=metabolic, Tina=women's), so
  // two accounts writing the SAME topic fell back to different products for no reason other than
  // whose name was on it. When the sprint allowlist is active it IS the fallback pool, fleet-wide;
  // the account's own pool is only used when no allowlist is set.
  const allowActive = ALLOW.size > 0 && process.env.PRODUCT_ALLOWLIST !== '0';
  const fromAllow = allowActive
    ? [...ALLOW].map((asin) => products.find((p) => p.asin === asin)).filter(Boolean)
    : [];
  const declared = fromAllow.length
    ? fromAllow
    : (Array.isArray(fallback) ? fallback : [fallback]).filter(Boolean);
  // THE FLOOR APPLIES HERE TOO (operator 2026-09-20: "product selection should be thread based").
  // This was the ONE selection path that never consulted it. candidates() drops proven losers before
  // it ranks; the no-thematic-fit fallback rotated its pool blind, because it has no thread to judge
  // fit against and nothing else was judging anything. The sprint allowlist masks the hole — every
  // allow entry clears the bar — so it only shows with PRODUCT_ALLOWLIST=0, which the comment above
  // advertises as "the instant off-lever, no data edit needed". Flipping it made eleanor's pool ship
  // B089P4LGW3: $0.00 on 453 clicks, the only product in the fleet to reach the kill floor having
  // never once converted. An off-lever for the ALLOWLIST should not also be an off-lever for the FLOOR.
  // Resolved against the live catalogue first so the restated EPC applies (accounts.mjs entries carry
  // no commission). Same never-starve shape as candidates(): losers go only while converters remain,
  // so a pool that is entirely below the bar still ships rather than returning nothing.
  const liveOf = (p) => products.find((q) => q.asin === p.asin) || p;
  const converters = declared.filter((p) => !provenLoser(liveOf(p), perf));
  const pool = converters.length ? converters : declared;
  const day = Math.floor(Date.now() / 864e5);
  const capOf = typeof cap === 'function' ? cap : () => cap; // accepts the per-ASIN cap (plugCapFor)
  const pick = pool.map((_, i) => pool[(day + i) % pool.length]).find((p) => (usedAsins[p.asin] || 0) < capOf(p.asin)) || pool[day % pool.length];
  const live = products.find((p) => p.asin === pick.asin);
  return { asin: pick.asin, title: pick.title, commission: live?.commission ?? 0.8 };
}

// Returns { asin, title, why, commission }. Falls back to the account's default pool (rotated).
// opts.usedAsins / opts.cap enable ASIN-aware spread across a batch so one SKU can't dominate a slate.
export async function pickProduct(env, slot, products, fallback, opts = {}) {
  const { usedAsins = {}, cap = Infinity, mode = 'exploit' } = opts;
  // `cap` may be a number OR a per-ASIN function (proven winners get a raised ceiling — plugCapFor).
  const capOf = typeof cap === 'function' ? cap : () => cap;
  let cands = candidates(slot.hook, products, { mode, bodyText: slot.bodyText });
  // EXPLORE mode: no 💰 pin — the LLM ranks purely on thematic fit, so the account keeps testing.
  const learnWin = mode === 'explore' ? null : learnedWinnerFor(slot.bodyText ? `${slot.hook}\n${slot.bodyText}` : slot.hook); // our best converter for this topic (only if the loop is confident)
  // Prefer products not yet at the per-batch cap — but only when real thematic choice remains, so we
  // never force a worse-fitting product just for diversity.
  const under = cands.filter((c) => (usedAsins[c.asin] || 0) < capOf(c.asin));
  if (under.length >= 2) cands = under;
  // PINNED (2026-08-17). This call chooses WHAT WE SELL, and it was silently running on the fleet's
  // cheapest model: it is hardcoded to sonnet with role 'aux', but resolveModel checks MODEL_<ROLE>
  // then LLM_MODEL then the call's own model — MODEL_AUX is empty and LLM_MODEL is set to a cheap
  // gateway model, so the gateway won every time. pinNative forces the call's own model. One call
  // per thread; the cost is a rounding error against a 7x spread in earnings per click.
  const out = await anthropic(env, { role: 'aux', pinNative: true,
    model: process.env.MODEL_PRODUCT || FLEET_MODEL, max_tokens: 300,
    messages: [{ role: 'user', content: `Pick the ONE product from this list that will EARN THE MOST. Every product below has already passed a thematic filter, so fit is a floor here, not the goal — re-optimising for fit throws away the earnings signal for work that is already done.
NATIVE FIT (hard, and the one thing that outranks earnings): when the THREAD CONTENT teaches a specific substance (NAD+, magnesium, creatine, collagen, ...), pick THAT substance's product if one is listed. A loosely-fitting category staple is WRONG there — this rule exists because a 1.4M-view NAD+ thread once plugged collagen. Among products that satisfy it, take the highest expected earnings.
HARD RULE: a SINGLE product, never a multi-ingredient stack/complex/blend or an "A x B x C" bundle, UNLESS the list marks it 🧪 (a deliberate experiment) or 💰.
A 💰 marks the product that converts BEST for this topic in OUR own sales data — prefer it. A ⭐ marks one that has converted before. A 🧪 marks a product we are deliberately testing under the rebuilt CTA: it has no fair history yet, so pick it when the fit is genuinely equal, and never merely because it is unfamiliar. The list is ordered by expected earnings, so a tie goes to the higher entry.\n\nHOOK: ${slot.hook}\nNICHE: ${slot.niche}\nTHREAD CONTENT (what it actually teaches — the plug must read as ITS natural next step):\n${String(slot.bodyText || '(hook only — no body available)').slice(0, 1100)}\n\nPRODUCTS:\n${cands.map((p) => `${PROVEN[p.asin] ? '⭐ ' : ''}${p.asin === learnWin ? '💰 ' : ''}${EXPERIMENT.has(p.asin) ? '🧪 ' : ''}${p.asin} | ${Math.round(p.commission * 100)}% | $${p.price} | ~$${(Number(p.price || 0) * Number(p.commission || 0)).toFixed(2)}/sale | ${p.title.slice(0, 70)}`).join('\n')}\n\nReply ONLY with JSON: {"asin":"...","why":"<10 words"}` }],
  });
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    const p = cands.find((c) => c.asin === j.asin);
    if (p) return { asin: p.asin, title: p.title, why: j.why, commission: p.commission };
  } catch {}
  return { ...pickFallback(fallback, products, usedAsins, cap), why: 'fallback default' };
}

// Pick TWO distinct best-fit singles for one thread: [heavy, light]. The HEAVY plug sits right after
// lesson 2 (the prominent slot) so it gets the strongest/truest fit; the LIGHT plug near the end gets a
// DIFFERENT on-topic single for variety. Returns a 1-element array when the topic only has one good
// single (recreate then plugs that one product twice — today's behaviour). opts.usedAsins/cap honour the
// per-batch ASIN spread across BOTH picks. Used by run-weekly + daily-winners.
export async function pickProductPair(env, slot, products, fallback, opts = {}) {
  const { usedAsins = {}, cap = Infinity, mode = 'exploit' } = opts;
  // `cap` may be a number OR a per-ASIN function (proven winners get a raised ceiling — plugCapFor).
  const capOf = typeof cap === 'function' ? cap : () => cap;
  let cands = candidates(slot.hook, products, { mode, bodyText: slot.bodyText });
  const learnWin = mode === 'explore' ? null : learnedWinnerFor(slot.bodyText ? `${slot.hook}\n${slot.bodyText}` : slot.hook); // explore: no 💰 pin (see pickProduct)
  const under = cands.filter((c) => (usedAsins[c.asin] || 0) < capOf(c.asin));
  if (under.length >= 2) cands = under;
  if (cands.length < 2) return [await pickProduct(env, slot, products, fallback, opts)]; // only one good fit -> single
  // PINNED (2026-08-17). This call chooses WHAT WE SELL, and it was silently running on the fleet's
  // cheapest model: it is hardcoded to sonnet with role 'aux', but resolveModel checks MODEL_<ROLE>
  // then LLM_MODEL then the call's own model — MODEL_AUX is empty and LLM_MODEL is set to a cheap
  // gateway model, so the gateway won every time. pinNative forces the call's own model. One call
  // per thread; the cost is a rounding error against a 7x spread in earnings per click.
  const out = await anthropic(env, { role: 'aux', pinNative: true,
    model: process.env.MODEL_PRODUCT || FLEET_MODEL, max_tokens: 300,
    messages: [{ role: 'user', content: `Pick the TWO products from this list that will EARN THE MOST as a COMPLEMENTARY PAIR. Every product below has already passed a thematic filter, so fit is a floor, not the goal.
The HEAVY plug sits right after the second tweet, the most-read position in the thread — give it the highest expected earnings among the products that genuinely fit. The LIGHT plug sits near the end: a DIFFERENT product on a different angle or mechanism, NEVER the same ASIN as heavy.
NATIVE FIT (hard, and the one thing that outranks earnings): when the thread teaches a specific substance, one of the two must BE that substance's product.
HARD RULE: no "A x B x C" bundle, and no multi-ingredient stack UNLESS marked 🧪 or 💰. 💰 = our best converter for this topic. ⭐ = has converted before. 🧪 = deliberately being tested under the rebuilt CTA, so it has no fair history — pick it on equal fit, never on novelty. The list is ordered by expected earnings; a tie goes to the higher entry.\n\nHOOK: ${slot.hook}\nNICHE: ${slot.niche}\nTHREAD CONTENT (what it actually teaches — the plug must read as ITS natural next step):\n${String(slot.bodyText || '(hook only — no body available)').slice(0, 1100)}\n\nPRODUCTS:\n${cands.map((p) => `${PROVEN[p.asin] ? '⭐ ' : ''}${p.asin === learnWin ? '💰 ' : ''}${EXPERIMENT.has(p.asin) ? '🧪 ' : ''}${p.asin} | ${Math.round(p.commission * 100)}% | $${p.price} | ~$${(Number(p.price || 0) * Number(p.commission || 0)).toFixed(2)}/sale | ${p.title.slice(0, 70)}`).join('\n')}\n\nReply ONLY with JSON: {"heavy":{"asin":"...","why":"<10 words"},"light":{"asin":"...","why":"<10 words"}}` }],
  });
  const pick = (sel) => { const p = cands.find((c) => c.asin === sel?.asin); return p ? { asin: p.asin, title: p.title, why: sel.why, commission: p.commission } : null; };
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    const h = pick(j.heavy);
    const l = j.light?.asin && j.light.asin !== j.heavy?.asin ? pick(j.light) : null;
    if (h && l) return [h, l];
    if (h) return [h];
  } catch {}
  // Deterministic fallback: top-2 distinct from the ranked candidates.
  return cands.slice(0, 2).map((p) => ({ asin: p.asin, title: p.title, why: 'top thematic fit', commission: p.commission }));
}
