// checks.mjs — single source of truth for "is this thread up to standard?"
// Deterministic, side-effect-free structural checks shared by:
//   - recreate.mjs  (generation gate — catch issues before a draft is created)
//   - qc.mjs        (4:30pm final QC pass — last line of defense before posts go live)
// Subjective judgments (CTA bridges the prior tweet? sounds personal? hook strong?)
// are LLM calls and live in qc.mjs. This file stays pure so it is trivially testable.
// The human-readable companion is style/thread-checklist.md — keep the two in sync.
import { closingTexts, disclaimerTexts, isBoilerplate, sharedWordRun, effLen, hasUrl, plugTextLen, effLenMinted, normalizeLineBreaks, respaceWall, splitLongTweet as splitText } from './content/text-shape.mjs';
export { closingTexts, disclaimerTexts, isBoilerplate, sharedWordRun, effLen, hasUrl, plugTextLen, effLenMinted, normalizeLineBreaks, respaceWall };
export { joinNumberedHeadings } from './content/text-shape.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DISCLOSURE, DISCLOSURE_RE, DISCLOSURE_LINE_RE, discloseBlock, isDisclosed } from './disclosure.mjs';
import { SELF_QRT_ECHO_PREFIX } from './self-qrt.mjs'; // one-way: self-qrt never imports checks
import { LAWS, signOffOf } from './laws.mjs'; // the single source of numeric law — gates READ it, never restate it
import { CROSS_POST_PLATFORMS } from './platforms.mjs'; // one-way: platforms never imports checks
import { lvIdOf } from './lib.mjs'; // the canonical link-id reader — never a local copy (see the grep-guard)

export const TWEET_LIMIT = LAWS.tweet.limit;
export const PLUG_LIMIT = LAWS.tweet.plugTextLimit; // plug text EXCLUDING the link URL (limit + 23-char link < tweet limit)

// ---- Product policy (single source of truth for pick-product, swap-product, smoke-test) ----
// The curated lists are DATA, not code: they live in keep-asins.json (asin + topic + note per entry) so
// the bi-weekly product-audit can propose add/drop as a reviewable data-only PR (--propose) and the
// operator can edit without touching code. Loaded once here and re-exported as the same Sets every
// consumer has always imported, so callers are unchanged. A missing/garbled file THROWS rather than
// yielding empty Sets: an empty KEEP legitimately means "no restriction" (back-compat rule below), so
// a silent load failure would quietly disable curation — fail loud instead.
let _policy;
try { _policy = JSON.parse(readFileSync(new URL('./keep-asins.json', import.meta.url), 'utf8')); }
catch (e) { throw new Error(`keep-asins.json unreadable (${e.message}) — the curated product policy must load`); }
export const DENY_ASINS = new Set((_policy.deny || []).map((d) => d.asin));
// A product is a STACK (not a single) if its title/category names a multi-ingredient formula OR a kitchen-sink
// fat-loss TYPE (appetite suppressant / fat burner / diet pill / thermogenic) — those are always blends.
// A focused single-PURPOSE formula that lists a few synergistic actives (e.g. Heart of Steel nitric-oxide) is
// allowed, which is why we match stack words + product TYPES, not raw ingredient count.
// "self obsessed" / "night before" are house multi-ingredient brands — EVERY SKU is a 10-in-1 / bundle
// (titles vary: "10-in-1", "A + B + C", "x Bundle"), so match the brand to catch all variants at once.
export const STACK_RE = /\d+[-\s]?in[-\s]?1|all[-\s]?in[-\s]?one|\bcomplex\b|\bblend\b|\bstack\b|multivitamin|multi[-\s]?mineral|\s[x×]\s|appetite suppressant|fat ?burner|diet pills?|thermogenic|self ?obsessed|night before/i;
export const isStack = (p) => STACK_RE.test(typeof p === 'string' ? p : `${p?.title || ''} ${p?.category || ''}`);

// NOVELTY: the gadget class, excluded from any review-count ranking. Amazon's best-sellers in our
// niches are full of waist trimmers, scales, seat cushions, massagers and whitening kits — high
// review counts, wrong product type — so ranking on reviews without this puts gadgets at the top of
// every list.
// Lives here beside STACK_RE rather than privately in browse-catalog.mjs, where it was defined:
// the storefront builder needs the SAME exclusion, and a second copy is exactly how two lanes drift
// (see the virality-score note below for the last time that happened).
export const NOVELTY_RE = /waist trimmer|trainer|\bscale\b|cushion|massager|whitening|\bstrips?\b|shaker|water bottle|\bl ?e ?d\b|machine|\bdevice\b|sauna|foam roller|yoga|resistance band|\bmat\b|pillow|blanket|serum|cream|moistur/i;
export const isNovelty = (p) => NOVELTY_RE.test(typeof p === 'string' ? p : `${p?.title || ''} ${p?.category || ''}`);

// ---- Source-thread virality score (shared by the source-selection paths) ----------------------------
// Lives here, not duplicated in both engines: this used to be an identical one-liner in each file and
// daily-winners' copy had silently gone DEAD (defined, never called — it sorted on raw views), so the
// two lanes were ranking sources by different rules. One definition, both lanes.
//
// REPLY WEIGHT (operator 2026-08-14): a source thread's REPLY rate is the best available predictor
// that our recreation of it will also earn replies, and a reply is weighted 5.0 in X's ranker against
// 0.5 for a like — ten likes' worth, and the most valuable signal we can actually influence
// (X-ALGORITHM-NOTES.md §1). The swipe DB has no reply-rate field, so it is derived from
// Comments/Impressions; callers MUST include 'Comments' in their Airtable `fields` list or the term
// silently reads 0.
//
// Coefficient sizing, measured against the live health pool (n=42 heads, >50k impressions, 2026-08-14):
//   retweet rate  p10 6.4e-5  median 4.5e-4  p90 1.3e-3  p99 5.3e-3
//   reply   rate  p10 1.6e-5  median 5.0e-5  p90 1.7e-4  p99 6.9e-4   <- ~9x SMALLER than retweet rate
// Because reply rate runs an order of magnitude smaller, it needs its own much larger coefficient to
// register at all; reusing the retweet coefficient (8) would contribute ~0.0004 and do nothing.
// At REPLY_W=5000 a median source gains +0.25 and a p90 source +0.84, so a heavily-replied thread
// outranks a median one by ~1.5x and a p99 outlier by ~3.5x. Raise to sharpen, lower to soften.
// (Known, deliberately unchanged: the retweet term `8 * rate` contributes <1% even at p99 — it is
// effectively a tiebreak, not a factor. Left alone so this change moves exactly one variable.)
export const REPLY_W = 5000;
export const replyRate = (f) => (f?.Impressions ? (f.Comments || 0) / f.Impressions : 0);
export const sourceScore = (f) =>
  (f?.Impressions || 0) * (1 + 8 * (f?.['Retweet Rate'] || 0) + REPLY_W * replyRate(f));

// ---- CONVERSION-AWARE SOURCE SELECTION (operator 2026-08-16) -------------------------------------
// sourceScore above is a pure REACH estimate: impressions weighted by engagement. Conversion appears
// nowhere in it, which is how a 5M-view thread on a topic we cannot plug outranked a 400k thread that
// sells itself. The fix is deliberately multiplicative and kept SEPARATE, so the well-tested reach
// half is untouched and each half can be read on its own:
//
//     selectionScore = sourceScore(reach) x conversionFactor(what it can sell)
//
// BRIDGE: the substance a thread teaches -> the allowlist product that answers it. This is LAW 14
// applied at SELECTION time: if a thread's own content cannot host a native plug, no amount of views
// makes it worth recreating. Keys are matched with word boundaries against hook + body.
// A BRIDGE target may not be a proven loser — test-scaffolds pins that, and it is the rule that keeps
// us from routing traffic to something measured not to convert. This set is the deliberate exception,
// and it is deliberately hard to add to.
//
// B07S424N6V (arginine + citrulline) crossed the floor on 2026-09-04: 158 clicks, ONE conversion,
// $10.75, EPC $0.068 against a beet root earning $0.430 on 5,815 clicks arguing the same nitric-oxide
// mechanism. It was priced to clear at 3.1% CVR and measures 0.63%.
//
// The operator's call was to keep testing rather than retire, with one condition applied the same
// day: NO THREAD PLUGS IT AS THE HEAVY. Rafael 2026-09-04 and Marcos 2026-09-05 were rewritten onto
// beet root and re-patched live; it keeps riding as the LIGHT plug on Camila and Marko, which is
// cheap exposure that goes on gathering data. Revisit when the click count roughly doubles.
//
// The test also asserts every ASIN in here IS currently a proven loser, so a stale exemption fails
// loudly instead of quietly whitelisting a product that recovered or was retired.
export const BRIDGE_LOSER_EXEMPT = new Set(['B07S424N6V']);

export const BRIDGE = {
  magnesium: 'B0GT2JKMYZ', glycinate: 'B0GT2JKMYZ', 'magnesium glycinate': 'B0GT2JKMYZ',
  'l-threonate': 'B09QFSDLL5', threonate: 'B09QFSDLL5', magtein: 'B09QFSDLL5',
  ashwagandha: 'B079K32QB6', 'ksm-66': 'B079K32QB6',
  omega: 'B07DX89ZHN', 'omega-3': 'B07DX89ZHN', 'fish oil': 'B07DX89ZHN', epa: 'B07DX89ZHN', dha: 'B07DX89ZHN',
  // SYMPTOM WORDS, restored 2026-08-26 and now GATED — see SYMPTOM_TERMS. Removing them outright
  // cost 19 of 194 threads their plug entirely (measured on everything posted since 1 August), and
  // every one was a thread whose whole subject was the symptom: "High cortisol ages you faster",
  // "Cortisol = thinning hair". Those are not mismatches, they are exactly what ashwagandha answers.
  // The real defect was narrower: a symptom word appearing ONCE, in a hook list, in a thread about
  // something else. So the word routes again, but only when the thread keeps talking about it after
  // the hook. bridgeableProducts enforces that; the words below are declared in SYMPTOM_TERMS.
  cortisol: 'B079K32QB6', adaptogen: 'B079K32QB6',
  'brain fog': 'B09QFSDLL5',
  inflammation: 'B07DX89ZHN',
  'blood pressure': 'B09SFFJP1P', 'blood flow': 'B09SFFJP1P',
  // RENPHO BP monitor B08J7XWM75 (added 2026-10-02) is OFF the bridge since 2026-11-10: the owner
  // paused physical products on 2026-11-04 ("supplements only"), and the 2026-11-07 board measures it
  // at EPC $0.137 (0.29x fleet, 1,430 clicks), which fails the no-loser bridge invariant. Restore the
  // four device keys ('blood pressure monitor', 'blood pressure cuff', 'bp monitor', 'home blood
  // pressure') here if physical products come back. See docs/physical-products-plan.md.
  // Creatine re-pointed 2026-08-26 to the Sports Research bottle. The 2026-08-23 cut ("860 clicks ->
  // $24") measured the NUTRICOST creatine, B0CDFDDRCF, which sits at EPC $0.277 against a $0.348
  // fleet. B0DXR7MPNV is a different SKU and a different verdict: EPC $0.418, CVR 5.8% on 291
  // lifetime clicks. Creatine was never the problem; that bottle was. Whey stays the muscle-lane
  // neighbour for protein-teaching donors, it just no longer stands in for creatine.
  creatine: 'B0DXR7MPNV',
  // Nitric-oxide vocabulary routed to FF Heart of Steel from 2026-08-17. RE-POINTED 2026-08-25: the
  // ENTIRE Formulation Factory catalog now 404s at Levanta ("Product not found"), verified against 8
  // distinct FF ASINs in one session while every non-FF ASIN minted normally. A BRIDGE key pointing
  // at an unmintable product is worse than no key — the thread gets written, the slot gets claimed,
  // and the failure only surfaces at mint time with the copy already built around it.
  // The lane re-points to the Nutricost beet root (operator 2026-08-25: "especially the old beetroot
  // that we were using, it was converting very well with 50% commission"). Beet root is dietary
  // nitrate, the body's other road to nitric oxide, so NO/BP/blood-flow prose is honest over it via
  // pod BR1. citrulline and arginine name a molecule it does not contain: neighbor, not native — the
  // plug pivots to nitrate and never resells citrulline. HumanN SuperBeets (B0DLPGZTBL, 25%) is the
  // live alternate when beet is over-exposed. Restore these to FF the day it mints again.
  // NITRIC OXIDE LANE -> Havasu, 2026-08-26 (operator: "let's just do it, no need to wait for 100
  // clicks"). citrulline and arginine had their routing removed hours earlier because beet root is
  // dietary nitrate and contains NEITHER molecule -- selling beet against a citrulline thread is the
  // same substance mismatch as selling ubiquinol against a NAD thread. This bottle contains both, so
  // the words finally have an honest home and the lane leader is the product the copy describes.
  // The rate is our lowest band at 25%, but PRICE carries it: $11.25/sale against beet's $7.47, so
  // it clears fleet EPC at 3.1% CVR where beet needs 4.7%. Zero of our own data yet -- this is a
  // funded test the operator chose not to gate. Watch it on `node product-board.mjs`.
  //
  // `beet` deliberately STAYS on the beet root: a thread that teaches beet root must sell beet root,
  // and B09SFFJP1P is a measured $0.331 earner with its own live pod (BR1).
  'nitric oxide': 'B07S424N6V', citrulline: 'B07S424N6V', arginine: 'B07S424N6V',
  'l-citrulline': 'B07S424N6V', 'l-arginine': 'B07S424N6V',
  beet: 'B09SFFJP1P',
  'magnesium l-threonate': 'B09QFSDLL5',
  // NAD+ the PRODUCT was cut 2026-08-23 ($0 on 40+ clicks, clean-CTA week). The concept reroutes to
  // Heart of Steel (operator choice 2026-08-23, over beet): a NAD thread is a cellular-energy/aging
  // thread, and HoS carries CoQ10 + resveratrol — the longevity ingredients that audience already
  // knows — at $0.62/click vs beet's $0.20. Neighbor, not native: the plug pivots to blood-flow/
  // CoQ10 energy, it never resells NAD. RE-POINTED 2026-08-25 (FF dead at Levanta, see above) to the
  // ubiquinol row: the reroute was always for the CoQ10/cellular-energy half of Heart of Steel, and
  // that half is now its own live product — a closer neighbor than the blood-flow one.
  // NAD -> the NAD product, 2026-08-27. This route spent two days pointing at ubiquinol because the
  // native product was retired and a neighbour was the best available home. That premise is gone:
  // B0DVFD5Q65 is reinstated on measured lifetime data (2,603 clicks, 126 orders, EPC $0.418, 1.11x
  // fleet; $0.349 direct with every halo order stripped), after its kill turned out to rest on a
  // windowed read showing 14 conversions where there are 126.
  //
  // A neighbour route was always a compromise: NAD and CoQ10 are both mitochondrial cofactors, but
  // they are different molecules, so the plug had to pivot to CoQ10 cellular energy and never resell
  // what the thread actually argued. With a live native product the compromise is unnecessary, and
  // routing a substance to itself is what every other line in this table does.
  nad: 'B0DVFD5Q65', 'nad+': 'B0DVFD5Q65', nicotinamide: 'B0DVFD5Q65',
  //
  // Collagen re-pointed 2026-08-26: REVO Collagen Jelly (B0DQVPL4F9) earned EPC $0.065 across 262
  // clicks while B06XK15VXJ, the Nutricost hydrolysate, sat unrouted at $0.671 — the best $/click we
  // hold. Joint/cartilage moved off glucosamine (B074759LBV, EPC $0.151) to omega-3 ($0.456) as an
  // honest stopgap — omega is a joint substance, but a thread about knees still had to sell fish oil.
  //
  // JOINT LANE GETS A NATIVE PRODUCT (2026-08-31). Healthy Origins NEM Eggshell Membrane
  // (B00FS89FWI): 50%, $21.00/sale, platform EPC 3.34 — the highest high-commission single in the
  // full 9,081-product sweep, 22x glucosamine's measured $0.151 — and NEM is what the joint prose
  // actually argues, so the plug stops pivoting. Mint-verified before routing (the FF lesson).
  collagen: 'B06XK15VXJ',
  'joint pain': 'B00FS89FWI', cartilage: 'B00FS89FWI',
  'eggshell membrane': 'B00FS89FWI', nem: 'B00FS89FWI',
  // D-Mannose (2026-08-31): stocked since the snapshot began — 50%, EPC 0.96, 2,428 rev — and never
  // routed; the definition of a sleeper. Opens the bladder-comfort lane, which suits the incoming
  // female personas. No banned-topics conflict (checked: no urinary/appetite entries).
  'd-mannose': 'B076R2HX2V', mannose: 'B076R2HX2V',
  // ELECTROLYTES ROUTE NOWHERE (2026-08-29). B0DBXVC5FV was HELD under the 100-click rule at 98
  // clicks; the fresher Levanta data that came in with main puts it at 181 clicks, 0 conversions,
  // $0.00. That is no longer an unjudged product, it is a measured zero, and the invariant test
  // "no BRIDGE target is a proven loser" caught it the moment the numbers landed.
  //
  // Not repointed, deliberately. The catalogue holds 14 electrolyte and potassium siblings and NONE
  // are on the allowlist, so swapping would trade a measured loser for an unmeasured one of the same
  // substance — and it is the SUBSTANCE that has failed to convert across 181 clicks, not the bottle.
  // A thread that mentions hydration now simply carries no electrolyte plug, which is the honest
  // outcome when we hold nothing worth selling for it.
  // UBIQUINOL LANE. Routed to Healthy Origins Kaneka QH on 2026-08-26 as a deliberate PRICE bet:
  // same substance, bigger bottle, $26.00/sale list against Nutricost's $14.35. That note set its own
  // falsification test — "break-even to MATCH the incumbent's measured $0.373 is 2.6% CVR; the lane
  // runs 4.66%, so conversion can fall 44% before this is a mistake."
  //
  // RE-POINTED 2026-08-30, because that test has now been run and the bet lost. Four days of traffic
  // put Healthy Origins at EPC $0.124 on 97 clicks. The predicted floor was $0.373; it is sitting 67%
  // below it, well past the 44% the bet allowed itself. Meanwhile B0C87VT8CW — same molecule, same
  // 100mg dose — is at $0.366 on 1,496 clicks, fifteen times the evidence, and was carrying 50
  // shipped pods with nothing routed to it.
  //
  // The price lever was sound reasoning; a higher $/sale only pays if the page still converts, and on
  // this listing it did not. Same substance either way, so this is a listing decision and no pod copy
  // changes. Healthy Origins stays allowlisted, so candidates() can rank it back in on fit, and if its
  // rate recovers on more clicks this is worth revisiting.
  coq10: 'B0GTS6GGSK', ubiquinol: 'B0GTS6GGSK', mitochondria: 'B0GTS6GGSK', // DR ubiquinol from 2026-11-19 (owner: higher payout); was Nutricost B0C87VT8CW
  whey: 'B01KITQG0A', 'protein powder': 'B01KITQG0A',
  // ---- THREE LANES OPENED 2026-08-30 -----------------------------------------------------------
  // All three sell already. Zinc has 25 shipped pods, berberine 31, B12 six — they were plugged
  // through the engine's own ranking, which is not gated on this table. What none of them had was a
  // BRIDGE key, so nothing a writer read could route a thread to them, and the hand lane could not
  // reach them at all. That is why the 2026-09-01 slate put magnesium in 7 of 11 threads: the
  // vocabulary reached 13 listings, not because the donors demanded it.
  //
  // Each is native, never a neighbour: the word routes to a bottle that contains that molecule.
  // All three clear provenLoser on live data at the time of writing.
  //
  // ZINC. $0.389/click on 1,325 clicks, the best-evidenced product we hold with no route. Terms stay
  // narrow and native — 'zinc' itself plus the two chelated forms the label names. Deliberately NOT
  // routing symptom words like 'immune' or 'testosterone': those are a dozen substances' territory,
  // and the symptom-word mistake is already documented above the cortisol row.
  zinc: 'B0CLYQ9KX2', picolinate: 'B0CLYQ9KX2', bisglycinate: 'B0CLYQ9KX2',
  // BERBERINE. $0.347/click on 284. The account voice is already written for it — Marcos's
  // plugHeavyExample in accounts.mjs is a berberine plug — so the copy existed before the route did.
  // 'blood sugar' and 'insulin' are NOT routed here: they are the most common words in this fleet's
  // donor pool and would hijack every metabolic thread. The molecule and its usual pairing only.
  berberine: 'B0CZMDPWG5', 'berberine hcl': 'B0CZMDPWG5',
  // B12. $0.529/click, the highest rate of the three, on the thinnest evidence at 198 clicks. Routed
  // on the strength of the rate, flagged as the one to re-read first. Methylcobalamin is the form the
  // bottle sells, so it earns its own key; 'fatigue' and 'energy' are left unrouted for the same
  // reason 'immune' is.
  'b12': 'B01IQB2UYS', 'vitamin b12': 'B01IQB2UYS', methylcobalamin: 'B01IQB2UYS',
  'vitamin d': 'B07NXW4GW7', d3: 'B07NXW4GW7', k2: 'B07NXW4GW7',
  // Added 2026-08-23 once FF Gut Intellect joined the allowlist. Until then the gut lane was
  // unroutable: SUBSTANCE_WORDS could READ these terms, so the checks stopped mis-firing on them,
  // but nothing could be SOLD against 27 plugs' worth of demand. "bloating" is routed the same way
  // "cortisol" routes to ashwagandha — the symptom a reader arrives with, not the substance.
  //
  // THE WHOLE GUT LANE IS ONE BOTTLE AGAIN (2026-09-06, operator: "yep reroute"). Re-pointed
  // 2026-08-25 off FF Gut Intellect (the Formulation Factory catalog 404s at Levanta) to the
  // Physician's Choice synbiotic; re-pointed 2026-08-31 to the Healthy Origins 8-strain on its
  // commission — 60% pays $25.79/sale against the synbiotic's $9.59, at a PROJECTED EPC of 0.82
  // vs 0.36. That projection is now measured and it went the other way: HO ran to 456 clicks for
  // ONE sale, EPC $0.057, CVR 0.22%, which crossed the proven-loser floor and made the BRIDGE
  // invariant fail — red CI on main for every PR until this line changed.
  //
  // Commission per sale is not EPC. A 60% bottle that nobody buys pays less per click than a 30%
  // bottle that converts, and the 08-31 call read the first number as if it were the second.
  //
  // Everything comes back to the Physician's Choice synbiotic, which measures $0.130 EPC on 74
  // clicks. That is UNJUDGED rather than proven — under the 100-click floor — so this is a return
  // to the last thing that worked, not a bet on a winner. The split that sent "prebiotic" here
  // alone is gone with it: this bottle is a multi-strain probiotic AND a prebiotic, so it is the
  // honest answer to every word in the lane rather than to one of them.
  probiotic: 'B0BRTJ7BJ1', probiotics: 'B0BRTJ7BJ1', microbiome: 'B0BRTJ7BJ1',
  'gut health': 'B0BRTJ7BJ1', bloating: 'B0BRTJ7BJ1',
  prebiotic: 'B0BRTJ7BJ1',
  // "flora" and "gut bacteria" are how creators actually say it mid-thread ("rebalance your flora",
  // "feed the bacteria in your gut") — the 1.13M gut donor used both and matched none of the six
  // terms above, so donorPlugSlots resolved its sell tweet to cortisol from two tweets back.
  flora: 'B0BRTJ7BJ1', 'gut bacteria': 'B0BRTJ7BJ1',
};

/**
 * Substance words the checks can RECOGNISE, independent of anything we sell.
 *
 * BRIDGE does two jobs at once: it is a vocabulary ("does this text mention magnesium?") AND a
 * routing table ("magnesium selects asin B0CV2SXX5M"). Those are different jobs, and conflating them
 * cost us in both directions. Routing requires every key to point at an allowlisted asin — an
 * invariant with its own test — so a substance we can name but do not currently stock simply cannot
 * be added. That is how probiotics, B12, berberine, turmeric, saffron and colostrum ended up
 * unnameable: substanceTermsFor returned [] for them, `[].some()` is false, and the archive audit
 * fired "the body never names this substance" 123 times against threads that named it perfectly
 * well. A missing word became a confident wrong verdict about someone else's writing.
 *
 * So recognition lives here, as words only, matched on the title. Routing stays in BRIDGE. Adding a
 * word teaches the checks to READ; it never makes anything sellable, and it cannot violate the
 * allowlist because it names no asin at all.
 */
/**
 * SYMPTOM TERMS: words a reader arrives with, mapped to the product that answers them — for
 * RECOGNITION ONLY. Split out of BRIDGE 2026-08-26.
 *
 * These lived in BRIDGE and did two incompatible jobs. As routing they were the fleet's most
 * expensive defect: they fire on threads about a PROBLEM rather than about the thing being sold, so
 * one word in a hook list pulled a full plug. Jasper's blood-sugar thread said "reduces nitric
 * oxide" once, in a list, in the hook; that single word pulled in both a NAD+ plug and a beet plug,
 * reached 4M views, took 2,137 clicks and returned $52 at 0.3% conversion. Beet root sits at EPC
 * $0.331 against a $0.348 fleet, and the measurement in docs/unit-economics.md puts it above fleet
 * at $0.363 once that one placement is gone.
 *
 * As RECOGNITION they are load-bearing and must not be lost. substanceTermsFor feeds
 * plugSubstanceBridgeIssue, the hard gate that the tweet before a plug lands on the plugged
 * substance — and a cortisol tweet before an ashwagandha plug is a perfectly good bridge. Deleting
 * the word outright would fail threads that bridge correctly, which is the same class of mistake as
 * the 123 false "the body never names this substance" verdicts that produced SUBSTANCE_WORDS.
 *
 * SECOND JOB (2026-08-26). These words are also the GATED set. They live in BRIDGE again, because
 * deleting them cost 19 of 194 threads their plug, but bridgeableProducts will only route on one of
 * them when it appears somewhere other than the hook. A word that is the thread's subject repeats;
 * a word dropped once into a hook list does not. That distinction is the whole defect, and it is
 * cheaper to measure than to legislate word by word.
 */
// THE LINE: you cannot buy a mechanism. Every word here names a symptom, a hormone, an organelle or
// a gas — something the body does, not something on a shelf. Those are the words that fire on
// threads about a PROBLEM. A purchasable substance (ashwagandha, magnesium, citrulline, beet) is
// not gated, because a thread that says it is almost always about it.
export const SYMPTOM_TERMS = {
  B079K32QB6: ['cortisol', 'adaptogen'],                                 // ashwagandha
  B09QFSDLL5: ['brain fog'],                                             // magnesium l-threonate
  B07DX89ZHN: ['inflammation'],                                          // omega-3
  B09SFFJP1P: ['blood pressure', 'blood flow'],                          // beet root
  // nitric oxide is a GAS and mitochondria are an ORGANELLE. "reduces nitric oxide", dropped once
  // into the hook list of Jasper's blood-sugar thread, is the exact placement this whole gate was
  // built for: 4M views, 2,137 clicks, $52, both plugs converting at 0.3%.
  B07S424N6V: ['nitric oxide'],                                          // arginine + citrulline
  B00B0YQ7JI: ['mitochondria'],                                          // ubiquinol
};

/** Flat set of every symptom-gated word, derived so the two can never drift apart. */
export const SYMPTOM_GATED = new Set(Object.values(SYMPTOM_TERMS).flat());

export const SUBSTANCE_WORDS = [
  'probiotic', 'probiotics', 'prebiotic', 'microbiome', 'gut health', 'bloating', 'flora', 'gut bacteria',
  // NAD vocabulary, recognition-only since the route was deleted 2026-08-26. We stock nothing that
  // answers a NAD thread, and the checks must still be able to read one.
  'nad', 'nad+', 'nicotinamide', 'nmn', 'nr',
  // citrulline / arginine were briefly parked here on 2026-08-26 while nothing we stocked contained
  // them. They now ROUTE to Havasu, which does, so they belong in BRIDGE and would be duplicated
  // here. Left as a note rather than a list entry so the reasoning survives the next reader.
  'b12', 'vitamin b12', 'methylcobalamin', 'berberine', 'turmeric', 'curcumin', 'bioperine',
  'saffron', 'colostrum', 'beef liver', 'nattokinase', 'fibrin', 'l-theanine', 'theanine',
  'melatonin', 'taurine', 'glycine', 'zinc', 'vitamin c', 'biotin', 'iron', 'iodine',
  'lions mane', "lion's mane", 'rhodiola', 'quercetin', 'resveratrol', 'spermidine', 'glutathione',
  'apigenin', 'inositol', 'psyllium', 'digestive enzyme', 'digestive enzymes', 'shilajit',
  // Multivitamin, added 2026-09-20 with the Sports Research 23-micronutrient bottle. RECOGNITION-
  // ONLY, and deliberately NOT a BRIDGE key, for a reason specific to this word: five live pods
  // argue "oxide is the cheap version found in most multivitamins" to SELL magnesium glycinate.
  // Routing the word would let a thread that just called multivitamins cheap filler bridge to one,
  // which is the neighbour-not-native swap BRIDGE exists to prevent — in its most embarrassing
  // form, since the thread's own argument is the counter-argument. Recognition is safe: the word
  // appears ONCE per pod bridge and unsoldSubstanceIssue needs UNSOLD_MIN_TWEETS (3) body tweets,
  // so no magnesium thread is newly refused. What this buys is that a plug SELLING the bottle can
  // name what it sells and plugSubstanceBridgeIssue can read it.
  'multivitamin', 'multivitamins', 'micronutrient', 'micronutrients',
  // Astaxanthin, added 2026-09-11 with the three Sports Research bottles. RECOGNITION-ONLY, and
  // deliberately not a BRIDGE key: nothing in the catalog should be REROUTED to astaxanthin, and a
  // thread arriving on skin or recovery already has homes. What this word buys is the other half —
  // without it substanceTermsFor returns nothing for a bottle whose whole title is "Astaxanthin
  // 12mg", so a thread that argues astaxanthin for ten tweets reads to runUpIssue as a product the
  // body never named, and the pod's own fit verdict falls through to the loose forms-only branch.
  'astaxanthin',
];

/**
 * The catalog's brands, so a plug can be checked for naming one. Kept next to BRIDGE because it is
 * the same kind of thing: a vocabulary the checks read, not an inventory.
 */
export const BRANDS = [
  'nutricost', 'formulation factory', 'sports research', 'sweet sweat', "physician's choice",
  'physicians choice', 'truskin', 'why not natural', 'mind bodhi', 'auraglow', 'ryve', 'timeline',
  'plantvital', 'ultimate health solutions', 'nurturly', 'revomadic', 'revo', 'designs for health',
  // product LINE names read as brands to a reader and are the ones the writer actually reaches for
  'heart of steel', 'the night before', 'self obsessed', 'primal power', 'melt mode', 'cellguard',
];

/**
 * ERROR: the plug OPENS on the brand name.
 *
 * Read the scope here carefully, because the first cut of this function got it backwards and the
 * mistake is instructive. Naming the brand is FINE — both the writer prompt and the write-thread
 * skill say so in as many words, and for the same reason: "the Nutricost glycinate is the one I
 * stayed on" reads more honest than a coy "the one I use", and the reader is about to see the name
 * on the link card anyway. What fails is OPENING on it. A plug whose first words are a brand reads
 * as a paid placement before the reader has any reason to care.
 *
 * The first version failed any brand mention anywhere in the copy, because it was written from a
 * stale copy of the skill that still carried a "never name the brand" line the operator has since
 * repealed. That stale text also went into the rules handed to the blind readers, so they flagged
 * eight brand mentions that are not defects at all. Worth remembering: an outdated rule in a test
 * harness manufactures findings, and they look exactly like real ones.
 *
 * Only the COPY is searched, and only its opening: the tracked URL carries brand strings of its own
 * and is not prose.
 */
export function brandOpenerIssue(tweet, product = {}) {
  const copy = String(tweet).replace(/https?:\/\/\S+/g, ' ').trim();
  const opener = (copy.split(/\n{2,}/)[0] || '').toLowerCase();
  const head = opener.split(/\s+/).slice(0, 7).join(' ');
  const own = String(product.brand || '').toLowerCase().trim();
  const hit = [...BRANDS, ...(own ? [own] : [])].find((b) => b.length > 3 && head.includes(b));
  return hit ? `opens on the brand "${hit}" — naming it later is fine, leading with it reads as a paid placement` : null;
}

/**
 * ERROR: two plugs in one thread point at the SAME tracked link.
 *
 * Worse than the "same product twice" warning it used to hide behind. One link means one subid,
 * so the second plug's clicks and any sale it drives are indistinguishable from the first's: the
 * thread cannot tell us which position earned. It also shows the reader the identical product card
 * twice, usually under two different descriptions. Found on lorenzo 10373108, where both plugs were
 * lv_JVJDtrn76eeTAVVFdF and a fully pre-sold second substance sat unplugged in the body.
 */
export function duplicateLinkIssue(tweets = []) {
  const seen = new Map();
  const out = [];
  (tweets || []).forEach((t, i) => {
    for (const l of String(t).match(/https?:\/\/\S+/g) || []) {
      if (!isTrackedLink(l)) continue;
      const clean = l.replace(/[),.]+$/, '');
      if (seen.has(clean)) out.push(`tweets ${seen.get(clean) + 1} and ${i + 1} share ONE tracked link — the second plug earns no attribution of its own and shows the reader the same card twice`);
      else seen.set(clean, i);
    }
  });
  return out;
}
// Word-boundary containment, shared by every place that asks "does this text name this term". Kept
// next to _bridgeRes because it is the same escaping rule: a term may carry regex metacharacters
// ("omega-3", "ksm-66", "nad+") and a bare `includes` matches inside longer words.
export const wordIn = (text, term) => new RegExp(`\\b${String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(text || ''));

const _bridgeRes = Object.entries(BRIDGE).map(([k, asin]) => [new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), asin, SYMPTOM_GATED.has(k), k]);

// The DISTINCT allowlist products a thread's text could plug natively. Distinct matters: two distinct
// products measured 3.5% CVR / $0.229 EPC versus 1.2% / $0.120 for the same product twice, so a
// source that can host two different plugs is worth materially more than one that can host two of one.
// `hook` is OPT-IN. Pass the thread's first tweet and symptom words (SYMPTOM_GATED) must appear
// somewhere OTHER than it; omit it and every word matches anywhere, which is the behaviour every
// caller had before 2026-08-26. Callers that already pass body-only text are correct as they are —
// their text excludes the hook by construction.
//
// The failure this gates: Jasper's blood-sugar thread said "reduces nitric oxide" once, in a list,
// in the hook. That single word pulled in two full plugs, reached 4M views, took 2,137 clicks and
// returned $52 at 0.3% conversion. The opposite case — "High cortisol ages you faster", where the
// symptom IS the subject and recurs all through the body — must keep its plug, and 19 of 194 threads
// lost theirs when the words were simply deleted.
export function bridgeableProducts(text, { hook = null } = {}) {
  const t = String(text || '');
  const gatedText = hook == null ? t : stripFirst(t, String(hook));
  const out = new Set();
  for (const [re, asin, gated] of _bridgeRes) if (re.test(gated ? gatedText : t)) out.add(asin);
  return out;
}

/**
 * The SUBSTANCES a text names, as words rather than as the one product each word routes to.
 *
 * `bridgeableProducts` answers "what may this thread plug", and its answer is a set of ASINs because
 * BRIDGE is term -> ONE product. That collapse is correct for plug selection and wrong for every
 * question of the form "is this product the same substance as that one": a text arguing ubiquinol
 * yields exactly B0C87VT8CW, so asking whether it argues B00B0YQ7JI — the same molecule in a
 * different bottle — answers no. Symptom words are excluded outright: "cortisol" is what a thread is
 * ABOUT, never what it sells, and admitting it here would make every stress thread a carrier for
 * every stress product.
 */
export function substanceTerms(text) {
  const t = String(text || '');
  const out = new Set();
  for (const [re, , gated, key] of _bridgeRes) if (!gated && re.test(t)) out.add(key);
  return out;
}

/**
 * The ASINs a donor may be arguing that `product` is an honest swap for — itself always included.
 *
 * THE BUG THIS EXISTS TO FIX (found 2026-09-09 by dry-running Run 3's preflight). A product test may
 * only ride a cover whose donor already argues its substance, and that test was written as exact
 * ASIN identity: `donor.substances.includes(testAsin)`. But `substances` are BRIDGE targets, and
 * BRIDGE points each term at ONE product. So a queued product that is not itself a BRIDGE target can
 * never be bridged by anything, on any slate, however the donors are sourced — it is UNSPENDABLE
 * forever rather than unlucky today. All four top entries of the operator's product queue were in
 * that state: `ubiquinol` and `coq10` route to Nutricost's bottle, `nad` to Nutricost's NAD+, and
 * nothing at all routes to the Healthy Origins SKUs the queue was built to finally test. That is the
 * mechanical reason those four sat at zero clicks for months — the queue could name them and the
 * bridge could never admit them.
 *
 * Substance identity is read off the product's OWN title, so it states a fact about the bottle
 * rather than a preference: "Healthy Origins Ubiquinol CoQ10 100 mg" is ubiquinol and coq10, and a
 * donor that argued either is arguing this product's substance no matter which bottle BRIDGE would
 * have reached for by default. Which brand's bottle the reader is handed is a commercial choice and
 * always was; the donor's words are what has to be honest.
 *
 * A product whose title names no substance we carry gets back only itself, so the caller falls
 * through to the exact-ASIN behaviour it had before.
 */
export function bridgeEquivalents(product) {
  const asin = String(product?.asin ?? product ?? '').toUpperCase();
  const out = new Set(asin ? [asin] : []);
  const mine = substanceTerms(product?.title || '');
  if (!mine.size) return out;
  for (const [, target, gated, key] of _bridgeRes) if (!gated && mine.has(key)) out.add(target);
  return out;
}

/** Remove the first occurrence of `hook` from `text`. Pure; returns `text` unchanged if absent. */
function stripFirst(text, hook) {
  const h = hook.trim();
  if (!h) return text;
  const i = text.indexOf(h);
  return i < 0 ? text : text.slice(0, i) + ' ' + text.slice(i + h.length);
}

// 1.0 = nothing pluggable. Up to ~5.8 = substance-led with three or more distinct native products.
// The ceiling is calibrated to a measurement, not taste: substance-led threads earned $0.232 per 1k
// views against $0.040 for generic ones, i.e. ~6x. Retention then swings it +/-30%, because retention
// is literally "does anyone reach the deep plug" and plug #2 sits at 60-90% depth. Retention is a
// PERCENT field that has been observed corrupt (>1, e.g. 886275%) — anything out of range is treated
// as unknown and scores neutral rather than being allowed to dominate the ranking.
export function conversionFactor(fields = {}, text = '') {
  // The hook is the first line of the swipe record's Text, so symptom words are gated here too —
  // otherwise a donor scores as monetizable on a word it only says once, up top, and the selector
  // ranks it into a slot it cannot actually sell against.
  const full = text || fields.Text || '';
  const n = Math.min(bridgeableProducts(full, { hook: String(full).split('\n')[0] }).size, 3);
  const bridge = 1 + 1.6 * n;
  const r = Number(fields['Thread Retention']);
  const ret = Number.isFinite(r) && r >= 0 && r <= 1 ? 0.7 + 0.6 * r : 1;
  return bridge * ret;
}

// What daily/weekly selection should actually sort on.
// ---- DONOR FRESHNESS (operator 2026-08-25) -------------------------------------------------------
// Recency carried ZERO weight: selectionScore was reach x conversion, so a three-week-old thread with
// good numbers outranked yesterday's every time. The only control was the pool's date window, and a
// window is binary — inside it, age counted for nothing at all, which is how a 27.8-day-old donor got
// picked while fresher bridgeable ones sat unused.
//
// Same shape as intentFactor: a BOUNDED multiplier, kept multiplicative and separate so the reach and
// conversion halves stay readable on their own. Half-life decay rather than a cliff, floored so an
// old-but-excellent donor is outranked rather than erased. At the default 14-day half-life a donor
// two weeks old needs roughly twice the reach-and-conversion of a fresh one to win the same slot.
//
// A missing or unparseable date scores exactly 1 — neutral. Being unmeasured is not a penalty, the
// same rule intentFactor follows for an untracked topic.
export function recencyFactor(f = {}, { now = Date.now(), halfLifeDays = LAWS.selection.recencyHalfLifeDays, floor = LAWS.selection.recencyFloor } = {}) {
  const raw = f?.['Published Date'] ?? f?.publishedDate ?? null;
  if (!raw) return 1;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (now - t) / 864e5);
  return Math.max(floor, 0.5 ** (ageDays / Math.max(1, halfLifeDays)));
}

/**
 * SPREAD TILT (2026-08-29) — the product-side twin of recencyFactor.
 *
 * Diversity was supposed to be handled by `used` in commitSlateProducts, but it sat in the sort as
 * a TIEBREAKER after EPC: `(b.epc - a.epc) || (used[a] - used[b])`. Realised EPC is a float and two
 * products effectively never tie, so the tiebreaker never fired and the highest-EPC product simply
 * won every slot it was eligible for. The 2026-08-31 slate is what that looks like in practice:
 * magnesium glycinate on 8 of 11 threads and KSM-66 on 6, against an asinCap of 0.3 that only
 * assignSlate consults and that the hand lane never passes through at all.
 *
 * So usage stops being a tiebreaker and becomes a multiplier on the score, exactly as age already
 * is for donors. A product keeps its full EPC the first time it is picked in a batch and decays by
 * half every `halfLife` picks after that. The floor exists for the same reason recencyFloor does:
 * a floor that binds early flattens the tilt it is meant to soften, and a genuinely dominant
 * product should be outranked after a few uses, never zeroed.
 *
 * This ORDERS, it never excludes. A slate with one honest substance still fills; relevance is
 * decided before this runs and is not negotiable.
 */
export function spreadFactor(uses = 0, { halfLife = LAWS.product?.spreadHalfLife ?? 2, floor = LAWS.product?.spreadFloor ?? 0.15 } = {}) {
  const n = Math.max(0, Number(uses) || 0);
  if (!n) return 1;
  return Math.max(floor, 0.5 ** (n / Math.max(0.5, halfLife)));
}

// Age in days, for the briefs and the planner's own logging. null when there is no usable date.
/**
 * Split a `Full Thread Text` rollup back into its tweets. Lives here rather than in a caller because
 * both the planner and preflight need it, and having them import each other would be a cycle.
 *
 * TWO SEPARATORS, BOTH ACCEPTED (2026-08-28). The rollup has always joined on a 44-dash rule, which
 * reads as a wall of punctuation in the Airtable record view. The operator wants plain whitespace
 * instead, so this now also splits on a BLANK-LINE GAP — and it has to tolerate both, because 3,453
 * existing rows carry the dashes and a rollup separator changes for every row at once.
 *
 * The gap has to be TWO blank lines, never one. Verified against the live table: inside a tweet the
 * paragraph separator is exactly one blank line, every time, and that is also our own airy-spacing
 * law. Splitting on a single blank line would shatter every tweet into its paragraphs and quietly
 * wreck everything downstream that counts tweets — sell-slot detection, the roundup boost, the
 * 3-tweet substance rule, the item-count gate. Three or more newlines cannot occur inside a tweet,
 * so it is the one unambiguous marker.
 *
 * Falling back to the whole string keeps a donor usable if the separator ever changes again.
 */
export function tweetsFromRollup(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const parts = s.split(/\n*-{10,}\n*|\n{3,}/).map((t) => t.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [s];
}

export function donorAgeDays(f = {}, { now = Date.now() } = {}) {
  const raw = f?.['Published Date'] ?? f?.publishedDate ?? null;
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, (now - t) / 864e5) : null;
}
export const selectionScore = (f = {}, text = '', opts = {}) =>
  sourceScore(f) * conversionFactor(f, text) * recencyFactor(f, opts);

// ---- TOPIC INTENT (operator 2026-08-17) ----------------------------------------------------------
// Realized ORDERS PER CLICK by topic (learnings/topic-intent.json, built by topic-intent.mjs).
// The purest intent signal we have: it strips product price and commission out and asks only "did
// the readers this topic attracted actually buy". Measured spread on 184 monetized threads: stress
// 5.47% vs testosterone 0.50% — an 11x gap selection was blind to. Session baskets make it richer
// still: a buy-mode click pays beyond the plugged product (Jul 30-Aug 2: 25 conversions across ~20
// ASINs, most never plugged by us).
// intentFactor(topic) is a BOUNDED multiplier on topic's opc relative to the fleet rate: clamped to
// [0.7, 1.4] so intent tilts the ranking but can never drown reach or the bridge gate. Topics below
// the click floor, 'general', unknown topics, and a missing file all score exactly 1 — neutral,
// never a penalty for being unmeasured.
let _intent;
export function intentTable() {
  if (_intent !== undefined) return _intent;
  try {
    const f = new URL('./learnings/topic-intent.json', import.meta.url);
    _intent = JSON.parse(readFileSync(f, 'utf8'));
  } catch { _intent = null; }
  return _intent;
}
export function intentFactor(topic, table = intentTable()) {
  if (!table?.fleet || !topic || topic === 'general') return 1;
  const t = table.topics?.[topic];
  if (!t || !t.measured) return 1;
  return Math.max(0.7, Math.min(1.4, t.opc / table.fleet));
}

// ---- THE MOLD LIBRARY (molds.json — operator 2026-08-16) -----------------------------------------
// Single machine-readable source of truth for thread formats, replacing the split brain where
// docs/thread-molds.md (prose, conversion-gated) and the skeleton library (view-gated) did not know
// about each other. status is DATA: 'proven' means a measured revenue result of OURS, 'experimental'
// means mined numbers that are someone else's. The promotion pipeline flips status on measurement.
// Loaded once, like keep-asins.json above; a missing file throws — generation must not silently run
// with zero molds.
let _molds;
try { _molds = JSON.parse(readFileSync(new URL('./molds.json', import.meta.url), 'utf8')); }
catch (e) { throw new Error(`molds.json unreadable (${e.message}) — the mold library must load`); }
export const MOLDS = _molds.molds;
export const MOLD_THRESHOLDS = {
  promote: Number(_molds.meta.promote_rev_per_1k),
  demote: Number(_molds.meta.demote_rev_per_1k),
  minPosts: Number(_molds.meta.min_posts),
};
export const moldById = (id) => MOLDS.find((m) => m.id === id) || null;
export const provenMolds = () => MOLDS.filter((m) => m.status === 'proven');
export const experimentalMolds = () => MOLDS.filter((m) => m.status === 'experimental');

// The promotion decision, pure so it is testable and so learn.mjs and any report agree byte-for-byte:
// given a mold's realized outcomes (posts with revenue + views), does its status change?
//   'promote'  — experimental that cleared the bar over enough posts
//   'demote'   — proven that decayed below the floor over enough posts
//   null       — stays as it is (insufficient data always stays)
export function moldStatusChange(mold, outcomes = []) {
  const n = outcomes.length;
  if (!mold || n < MOLD_THRESHOLDS.minPosts) return null;
  const views = outcomes.reduce((s, o) => s + (Number(o.views) || 0), 0);
  if (!views) return null;
  const revPer1k = outcomes.reduce((s, o) => s + (Number(o.revenue) || 0), 0) / (views / 1000);
  if (mold.status === 'experimental' && revPer1k >= MOLD_THRESHOLDS.promote) return 'promote';
  if (mold.status === 'proven' && revPer1k < MOLD_THRESHOLDS.demote) return 'demote';
  return null;
}

// ---- Curated product allowlist (the ~20 we actually stock) ---------------------------------------
// Entries + per-product rationale live in keep-asins.json. KEEP is the single source of truth for
// "what we promote"; the bi-weekly product-curation audit (product-audit.mjs) re-checks it against
// fresh sales and proposes add/drop. An explicitly-kept ASIN overrides the STACK_RE singles-only
// auto-block (operator has vetted it), but DENY still wins. Empty KEEP = no restriction (back-compat);
// a non-empty KEEP is enforced by pick-product.
export const KEEP_ASINS = new Set((_policy.keep || []).map((k) => k.asin));
// The high-commission bets (bet:true in keep-asins.json), tracked as their own cohort so the audit
// judges them on earnings, not blended CVR.
export const KEEP_BETS = new Set((_policy.keep || []).filter((k) => k.bet).map((k) => k.asin));
// Products the operator has explicitly vetted to stay pickable BELOW the absolute EPC floor
// (laws.product.minEpcFloor). Read by pick-product's provenLoser. Each entry carries its own
// floorExemptWhy in keep-asins.json — see that file's floorExempt_2026_09_19 note for the rules.
export const FLOOR_EXEMPT_ASINS = new Set((_policy.keep || []).filter((k) => k.floorExempt).map((k) => k.asin));
// Physical products (devices, tools, gear — not supplements), marked physical:true on any keep / allow /
// experiment entry. pick-product judges them on laws.product.minEpcFloorPhysical instead of the
// supplement-era minEpcFloor (operator 2026-10-02: "for physical product lower floor to 0.35 EPC").
export const PHYSICAL_ASINS = new Set([...(_policy.keep || []), ...(_policy.allow || []), ...(_policy.experiment || [])]
  .filter((k) => k.physical).map((k) => k.asin));
// MERGED MENU (operator 2026-08-23: "expand the allowlist — maybe it should merge so we don't have
// to manually update like this all the time"). The engine's selection menu is KEEP ∪ allow: ONE
// curated list, and the bi-weekly product-audit maintains it — merging its one-click PR (add the
// proven, drop the dead) now updates the menu with no second hand-edit. `allow` survives only as a
// slot for temporary extras not yet promoted into keep. Since KEEP is never empty, the exploration
// off-switch is PRODUCT_ALLOWLIST=0 (pick-product), no longer "empty the allow array".
export const ALLOW_ASINS = new Set([...(_policy.keep || []), ...(_policy.allow || [])].map((k) => k.asin));
// EXPERIMENT bucket (operator 2026-08-17). The sprint allowlist exists to restrict selection to
// PROVEN converters, and adding an untested product to it would dilute exactly what it protects.
// But a product can only prove itself if it ships, and every EPC we hold was earned behind the old
// CTA — so "unproven" currently means "never given a fair run". This is the third state: eligible
// for a bounded share of slots so it gathers data under the rebuilt CTA, without being treated as
// proven. Selection reads it alongside `allow`; ranking still puts realized EPC first.
export const EXPERIMENT_ASINS = new Set((_policy.experiment || []).map((k) => k.asin));

// Compatibility entry point: the numeric policy still comes only from laws.json.
export function splitLongTweet(text, { limit = TWEET_LIMIT, minTail = 40 } = {}) {
  return splitText(text, { limit, minTail });
}

// plugFingerprint(prior, plug) — stable identity for a judge-approved (prior tweet, plug) PAIR. The
// CTA judge's verdict depends on BOTH texts (the bridge rule in cta.mjs), so the pair — not the plug
// alone — is the unit of approval. recreate.mjs records fingerprints of pairs the judge actually
// PASSED onto the draft's ledger.jsonl line; qc.mjs then skips re-judging a byte-identical pair
// (identical inputs ⇒ identical verdict), killing the duplicate nightly judge calls and their
// nondeterministic rewrite cascades. Any mutation to either text (QC tighten, manual Typefully edit,
// swap-product) changes the hash → the judge runs again. Fail-safe by construction: a missing or
// stale fingerprint only ever costs one redundant LLM call, never a skipped check.
export const plugFingerprint = (prior, plug) =>
  createHash('sha256').update(`${String(prior).trim()}\u0000${String(plug).trim()}`).digest('hex').slice(0, 24);

// shortName(title) — collapse a long Amazon product title to the short, recognizable name a buyer
// would actually say (brand + the few distinctive words), for use INSIDE a plug's recommendation
// phrase. Full marketing titles ("...Sleep Aid, 10-in-1 ... with Melatonin 4mg ... 120 Capsules")
// read as ad copy and burn the 255-char budget. Heuristic: take the text before the first comma,
// drop a trailing "(Bundle)"/"(6 Month Supply...)" paren and any size/count tail, and cap at ~42
// chars on a word boundary. The generator/judge prompts also instruct the LLM to pick the cleanest
// recognizable form; this is the deterministic hint + the fallback qc.mjs uses when it regenerates.
// One numbered item per tweet (operator rule 2026-08-08): the count gates verify only the TOTAL, so
// packed "2.\n3.\n4." one-liner tweets passed every gate — the crammed-listicle class (held drafts
// 10231015/10231025). >=2 leading item markers in one tweet = packed. Deterministic backstop behind
// splitMergedItems; plug/closer tweets carry no leading markers, so only true packing trips it.
export function packedItemsIssue(tweets) {
  const packed = [];
  (tweets || []).forEach((t, i) => {
    const n = (String(t).match(/^\s{0,3}\d{1,3}[.)]\s/gm) || []).length;
    if (n >= 2) packed.push(`tweet ${i + 1} holds ${n} items`);
  });
  return packed.length ? `packed items (each numbered item must start its OWN tweet): ${packed.join('; ')}` : null;
}

export function shortName(title = '') {
  let s = String(title).split(',')[0].trim();                              // drop the comma marketing tail
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();                           // drop a trailing "(Bundle)"/"(6 Month...)"
  s = s.replace(/\s+\d+[\s-]*(?:capsules?|count|ct|caps?|gummies|mg|g|servings?|pack|supply)\b.*$/i, '').trim(); // size tail
  s = s.replace(/\s+(?:x|×|&|\+|with|and|for|plus)\s*$/i, '').trim();      // drop a trailing dangling connector
  if (s.length <= 42) return s;
  const cut = s.slice(0, 42);
  const sp = cut.lastIndexOf(' ');
  return (sp > 12 ? cut.slice(0, sp) : cut).replace(/\s+(?:x|×|&|\+|with|and|for|plus)$/i, '').trim(); // word boundary
}

// Untracked-money-link detector for the auto-remediation path (fix-untracked.mjs). Returns a
// Gumroad URL in this tweet that is missing its ?ref attribution tag (a sale about to post with no
// way to attribute it), else null. A link that ALREADY carries ref= is tracked -> null (idempotent:
// re-running never re-tags). Levanta short links encode their subid server-side so the URL can't
// reveal whether they're tracked — those are reported, never auto-tagged. Pure + testable; trailing
// sentence punctuation is trimmed so "...gumroad.com/l/x." doesn't capture the period.
export function untrackedGumroad(text) {
  const m = String(text).match(/https?:\/\/\S*gumroad\.com\/\S+/i);
  if (!m) return null;
  const url = m[0].replace(/[.,;:)\]]+$/, '');
  return /[?&]ref=/.test(url) ? null : url;
}

// Malformed-tracked-link detector (IMPROVEMENTS 2026-07-26, "Knox Callahan monetization dark").
// untrackedGumroad above catches a Gumroad link missing its ?ref; NOTHING caught the twin failure on
// the Levanta rail — a plug whose lvnta.com URL carries no path slug at all. The old shape test was a
// bare /lvnta\.com\//, so "https://lvnta.com/" (empty slug, e.g. a link-mint that returned an empty id
// or a truncated paste) satisfied both the generation gate and QC, counted as a plug, and shipped a
// thread that earns $0 forever. Returns the offending URL string, else null. Pure + testable.
// A real Levanta short link is lvnta.com/<slug> with an opaque alphanumeric slug. The rule is
// deliberately only "slug is present and URL-shaped" — no minimum length, since slug length is
// Levanta's to choose and inventing a floor here would reject valid live links. Query/fragment and
// trailing sentence punctuation are stripped first so ".../abc." and ".../abc?x=1" both read as "abc".
// A domain with no slash at all ("https://lvnta.com") is caught too: same dead link, one less char.
export function malformedLevanta(text) {
  const m = String(text).match(/https?:\/\/\S*lvnta\.com(?:\/\S*)?/i);
  if (!m) return null;
  const url = m[0].replace(/[.,;:)\]]+$/, '');
  const slug = url.replace(/^https?:\/\/\S*?lvnta\.com\/?/i, '').split(/[?#]/)[0];
  return /^[A-Za-z0-9_-]+$/.test(slug) ? null : url;
}

// Bare-commerce-link detector (IMPROVEMENTS 2026-07-31, "deterministic tracking pre-flight").
// The third rail in the same family as untrackedGumroad / malformedLevanta: a RAW retailer URL sitting
// in the thread. Every tracked plug this pipeline mints is an lvnta.com short link (its subid lives
// server-side, so tracking is never visible in the URL) or a gumroad.com link carrying ?ref — so an
// amazon.<tld>/... or amzn.to/... URL in the text is untracked BY CONSTRUCTION: it can convert and the
// commission attributes to nobody. It is invisible to every existing gate: the plug tests count plugs by
// lvnta/gumroad presence, so a bare Amazon link is not a plug and its thread still passes plug-count.
// Returns the offending URL string, else null. Pure + testable. Deliberately narrow — it requires a full
// http(s) URL on an Amazon retail host, so prose that merely NAMES Amazon is never flagged.
//
// EXCEPTION — the Amazon Attribution rail (2026-08-17): Levanta's mint API now returns DIRECT Amazon
// URLs carrying its tracking (`maas=maas_adg_api_…` and/or `aa_adgroupid=lv_…`) instead of an
// lvnta.com short link. Those ARE tracked — registry-sync attributes them by subid, and the
// aa_adgroupid form even carries the lv_ id — so flagging them as "untracked" is wrong and blocks a
// perfectly good draft (live: every runner-minted link today). Only a link with NO tracking marker
// is the defect this gate exists for.
export const AMAZON_ATTR_RE = /(?:maas=maas_adg_api|aa_adgroupid=lv_|aa_campaignid=lv_)/i;
// A geni.us short link wrapping a minted Amazon Attribution URL (docs/geniuslink.md). It is a plug
// link for every gate here. That it really wraps OUR link is proved by the ledger's `glink` field and
// by following it (check-links.mjs), never by the host alone.
export const GENIUS_RE = /geni\.us\/[A-Za-z0-9_-]+/i;
export const isTrackedLink = (url = '') => /lvnta|levanta/i.test(url) || /gumroad/i.test(url) || AMAZON_ATTR_RE.test(url) || GENIUS_RE.test(url);
export function bareCommerceLink(text) {
  const m = String(text).match(/https?:\/\/(?:[\w-]+\.)*(?:amazon\.[a-z.]{2,6}|amzn\.to)\/\S*/i);
  if (!m) return null;
  const url = m[0].replace(/[.,;:)\]]+$/, '');
  return AMAZON_ATTR_RE.test(url) ? null : url;
}

// ---- BANNED TOPICS (operator 2026-08-21) --------------------------------------------------------
// Subjects this fleet does not write about at all. This is NOT the health-claim detector below and
// must never be merged into it: HEALTH_CLAIM_RE asks "does this sentence promise a cure?", which a
// careful writer can always avoid. This asks "is this thread ABOUT the subject?", which no amount of
// hedging changes. "Here is what I would do if I had cancer" claims nothing and is still a cancer
// thread; it was sitting in Julian's drain queue in four near-identical variants when the ban landed.
//
// Table lives in banned-topics.json so a topic can be added without touching code.
const BANNED_TOPICS = JSON.parse(readFileSync(new URL('./banned-topics.json', import.meta.url), 'utf8')).topics;
// One matcher set per topic, built once. Word boundaries so "cancer" does not fire inside a longer word,
// and the phrase list is matched with flexible internal whitespace ("stage 4", "stage  4").
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => `\\b${escRe(w)}\\b`;
const phraseRe = (w) => escRe(w).replace(/\s+/g, '\\s+');
const anyOf = (parts) => (parts.length ? new RegExp(parts.join('|'), 'i') : null);

// CLAIMS ABOUT A BANNED SUBJECT (owner 2026-09-29: "we avoid making claims about curing cancers or any
// shit like that"). Only a topic with "claims": true. hardHealthClaim below catches "cures"/"reverses"
// and "treats|prevents|heals|fixes|eliminates cancer" and is a QC WARN; it misses "lowers your cancer
// risk", "fights tumors", "anti-cancer", "kills cancer cells". Once a passing mention is allowed, those
// are the sentences that must still fail, so this reads each SENTENCE that holds a subject word and
// blocks it when it pairs the word with a claim verb. A verb must sit within 28 characters of the word
// ("kills cancer cells", "destroys harmful cells (like cancer)"), and never across a "than", so
// "heart disease kills more people than cancer" is not read as a claim; a risk claim may span a little
// further ("reduces the risk of colon cancer", "22% lower colorectal cancer risk"). Causation
// ("processed meat is a carcinogen", "alcohol raises cancer risk") is not a claim to treat or prevent,
// so it passes. Found on real donors 2026-09-29: "Destroys harmful cells (like cancer)" sat 20
// characters from the word and a 14-character window let four threads through.
const CLAIM_ACT = 'cure[sd]?|curing|treat\\w*|therap\\w+|prevent\\w*|protect\\w*|fight\\w*|combat\\w*|kill\\w*|destroy\\w*|shrink\\w*|beat\\w*|defeat\\w*|heal\\w*|eliminat\\w+|eradicat\\w+|starv\\w+|suppress\\w*|inhibit\\w*|dissolv\\w+|melt\\w*|flush\\w*|burn\\w*|clear\\w*|attack\\w*|target\\w*|stop\\w*|slow\\w*|revers\\w+|ward\\w*|eat\\w*\\s+up|get\\w*\\s+rid\\s+of|rid\\s+of|turn\\w*\\s+off|switch\\w*\\s+off';
const CLAIM_AFTER = 'shrink\\w*|die|dies|dying|disappear\\w*|vanish\\w*|melt\\w*|dissolv\\w+|regress\\w*|go\\w*\\s+away|goes\\s+away|starv\\w+|stops?\\s+growing|stops?\\s+spreading';
const CLAIM_LOWER = 'lower\\w*|reduc\\w+|cut\\w*|decreas\\w+|slash\\w*|minimi[sz]\\w+|drop\\w*|halv\\w+|less|fewer';
const CLAIM_RISK = 'risk|chance|chances|odds|incidence|rates?|mortality|deaths?';
const CLAIM_DROP = 'lower|lowers|lowered|reduced|reduces|drops?|dropped|falls?|fell|halved|down|cut';
const claimRes = (termAlt) => [
  new RegExp(`\\b(?:${CLAIM_ACT})\\b(?:(?!\\bthan\\b)[^.!?\\n]){0,28}\\b(?:${termAlt})\\b`, 'i'),
  new RegExp(`\\b(?:${CLAIM_ACT})\\b[^.!?\\n]{0,30}\\b(?:from|against|off)\\b[^.!?\\n]{0,15}\\b(?:${termAlt})\\b`, 'i'),
  new RegExp(`\\b(?:${termAlt})\\b[^.!?\\n]{0,14}\\b(?:${CLAIM_AFTER})\\b`, 'i'),
  new RegExp(`\\b(?:${CLAIM_LOWER})\\b[^.!?\\n]{0,25}\\b(?:${termAlt})\\b[^.!?\\n]{0,15}\\b(?:${CLAIM_RISK})\\b`, 'i'),
  new RegExp(`\\b(?:${CLAIM_LOWER})\\b[^.!?\\n]{0,30}\\b(?:${CLAIM_RISK})\\b[^.!?\\n]{0,30}\\b(?:${termAlt})\\b`, 'i'),
  new RegExp(`\\b(?:${termAlt})\\b[^.!?\\n]{0,30}\\b(?:${CLAIM_RISK})\\b[^.!?\\n]{0,25}\\b(?:${CLAIM_DROP})\\b`, 'i'),
  /\banti-?(?:cancer|tumou?r|carcinogen\w*)\b|\b(?:cancer|tumou?r)-(?:fighting|killing|preventing|protective)\b/i,
];
const BANNED_TOPIC_RES = BANNED_TOPICS.map((t) => {
  const focus = t.mode === 'focus';
  const termParts = (t.terms || []).map(wordRe);
  const alwaysParts = [...(focus ? [] : termParts), ...(t.alwaysTerms || []).map(wordRe), ...(t.phrases || []).map(phraseRe)];
  return {
    id: t.id,
    label: t.label,
    focus,
    // Blocks anywhere: every term of an 'always' topic; only the treatment / patient-journey wording of a focus topic.
    always: anyOf(alwaysParts),
    // A focus topic's subject words: blocks only as the post's subject (hook, or dense through the thread).
    subject: focus ? anyOf(termParts) : null,
    hook: t.focus?.hook !== false,
    minTweets: Number(t.focus?.minTweets) || 3,
    minShare: Number(t.focus?.minShare) || 0.25,
    claims: focus && t.claims ? claimRes(termParts.join('|')) : null,
    // Any word of the topic, for the claim guard's sentence filter.
    any: anyOf([...termParts, ...alwaysParts]),
  };
});

/**
 * bannedTopicFinding(textOrTweets) -> null | { message, tweet }   (tweet is 1-based, or 0 for "no single tweet")
 *
 * A STRING is read as a hook (a draft title, a donor's first tweet): any word of the topic blocks it.
 * A LIST is read as a thread, index 0 being the hook. For an 'always' topic any term anywhere blocks, as
 * it always did. For a 'focus' topic (cancer, since 2026-09-29) a thread is blocked when:
 *   1. treatment / patient-journey wording ("chemo", "stage 4", "in remission") appears anywhere;
 *   2. the HOOK names it, because the hook is what the post says it is about;
 *   3. it runs through the thread: in at least max(minTweets, minShare of the tweets) tweets, which is
 *      the post's main subject even when the hook is a euphemism ("the No. 1 killer of men under 50");
 *   4. any sentence pairs it with a claim to treat, cure, prevent or lower the risk of it (claimRes).
 * A single body tweet that mentions it in passing passes rules 2 and 3 on purpose (owner 2026-09-29).
 * Pure + testable.
 */
export function bannedTopicFinding(textOrTweets) {
  const isList = Array.isArray(textOrTweets);
  const list = (isList ? textOrTweets : [textOrTweets]).map((x) => String(x ?? ''));
  const where = (i) => (isList ? ` in tweet ${i + 1}` : '');
  for (const t of BANNED_TOPIC_RES) {
    if (t.always) {
      for (let i = 0; i < list.length; i++) {
        const hit = list[i].match(t.always);
        if (hit) return { tweet: isList ? i + 1 : 0, message: `${t.label} is a BANNED topic: "${hit[0]}"${where(i)} — this fleet does not write about it at all (banned-topics.json)` };
      }
    }
    if (!t.focus) continue;
    const at = list.map((s, i) => (t.subject.test(s) ? i : -1)).filter((i) => i >= 0);
    if (at.length && t.hook && at[0] === 0) {
      const term = list[0].match(t.subject)[0];
      return { tweet: isList ? 1 : 0, message: `${t.label} is a BANNED topic: "${term}"${isList ? ' in the hook (tweet 1)' : ' in the hook'} — the hook says what the post is about; a passing mention inside a body is allowed (banned-topics.json)` };
    }
    const need = Math.max(t.minTweets, Math.ceil(t.minShare * list.length));
    if (isList && at.length >= need) {
      const term = list[at[0]].match(t.subject)[0];
      return { tweet: at[0] + 1, message: `${t.label} is a BANNED topic: "${term}" runs through ${at.length} of ${list.length} tweets (${at.map((i) => i + 1).join(', ')}) — that is the post's main subject, not a passing mention (banned-topics.json)` };
    }
    if (t.claims) {
      for (let i = 0; i < list.length; i++) {
        for (const sentence of list[i].split(/(?<=[.!?])\s+|\n+/)) {
          if (!t.any.test(sentence) || !t.claims.some((re) => re.test(sentence))) continue;
          return { tweet: isList ? i + 1 : 0, message: `${t.label}: a claim about treating, curing, preventing or lowering the risk of it${where(i)} ("${sentence.trim().slice(0, 90)}") — this fleet makes no such claims, wherever they sit (banned-topics.json)` };
        }
      }
    }
  }
  return null;
}

/** '' | the finding's message. Accepts a string (read as a hook) or a list of tweets (read as a thread). */
export function bannedTopicIssue(textOrTweets) {
  return bannedTopicFinding(textOrTweets)?.message || '';
}

/**
 * bannedTopicTweetIssue(text) -> '' | message: only the findings that do not depend on WHERE the tweet sits in
 * a thread (treatment wording, and claims about it). For a caller that judges one tweet at a time and has no
 * thread to read focus from; pair it with bannedTopicIssue(tweets) for the whole thread.
 */
export function bannedTopicTweetIssue(text) {
  const only = String(text ?? '');
  for (const t of BANNED_TOPIC_RES) {
    const hit = t.always && only.match(t.always);
    if (hit) return `${t.label} is a BANNED topic: "${hit[0]}" — this fleet does not write about it at all (banned-topics.json)`;
    if (!t.claims) continue;
    for (const sentence of only.split(/(?<=[.!?])\s+|\n+/)) {
      if (t.any.test(sentence) && t.claims.some((re) => re.test(sentence))) return `${t.label}: a claim about treating, curing, preventing or lowering the risk of it ("${sentence.trim().slice(0, 90)}") — this fleet makes no such claims, wherever they sit (banned-topics.json)`;
    }
  }
  return '';
}

// True if any banned topic appears. For selection paths that want a boolean filter.
export const hasBannedTopic = (textOrTweets) => !!bannedTopicIssue(textOrTweets);

// Hard health-claim detector — single source of truth shared by checkThread's QC warn AND
// recreate.mjs's generation BLOCK (a curative claim is an account-suspension risk, so it must
// fail the draft at generation, not just get flagged post-hoc). Disease-adjacent curative verbs
// (treat/prevent/heal/fix/eliminate) only fire next to a condition word so benign uses ("treat your
// RHR as a metric", "fix your sleep") don't trip it; "cure(s/d)"/"reverse(s)"/"guarantee(s/d)" are
// curative enough to flag standalone. Pure + testable. Callers exclude the legal disclaimer/closing.
// "guaranteeS" was the one inflection this detector missed until 2026-08-03: only the past participle
// ("guaranteed") was listed, so an active-voice promise ("magnesium guarantees deeper sleep") passed
// BOTH the QC warn and recreate's generation-time compliance BLOCK. EVIDENCE_VERB_RE catches
// "guarantees" only inside a plug's evidence line, so a body tweet making the same promise shipped
// ungated. The bare noun ("no guarantee") stays exempt — it is a hedge, not a claim.
// (IMPROVEMENTS 2026-08-02, QC final pass.)
const HEALTH_CLAIM_RE = /\b(?:cure[sd]?|reverses?|guarantee[sd])\b|\b(?:treats?|prevents?|heals?|fixes?|eliminates?)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:disease|illness|cancer|diabetes|anxiety|depression|insomnia|condition|disorder)\b/i;
export const hardHealthClaim = (text) => HEALTH_CLAIM_RE.test(String(text));
// isSignedTweet — does this tweet close the thread in the persona's voice? The account's exact
// `closing` counts, and so does any tweet whose final line is the persona's name. Matching only the
// FULL account name was too narrow: these personas sign with a first name ("Tina.", not
// "Tina De Jong."), so real sign-offs read as missing and callers appended a second one.
// Pure + testable.
export function isSignedTweet(text, account = {}) {
  const t = String(text || '');
  if (closingTexts(account).includes(t)) return true;
  const names = new Set();
  if (account.name) { names.add(String(account.name)); names.add(String(account.name).split(/\s+/)[0]); }
  // The closing's own last line is the ground truth for how this persona signs.
  const closeTail = String(account.closing || '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (closeTail) names.add(closeTail.replace(/[.!,]+$/, ''));
  for (const n of names) {
    if (!n || n.length < 2) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\n)\\s*${esc}[.!]?\\s*$`, 'm').test(t)) return true;
  }
  return false;
}

// The exact phrase that tripped the detector — named in the repair prompt so the model knows WHAT to
// remove (test-2 finding 2026-07-20: "sells cortisol cures by the thousand" survived two blind repairs
// because the rewrite prompt never said which wording was flagged).
export const hardHealthClaimMatch = (text) => (String(text).match(HEALTH_CLAIM_RE) || [])[0] || '';

// Map a free-text CTA judge reason (from cta.mjs judgePlug, <=6 words) to a STABLE sub-reason slug so
// the QC tally can split the opaque single 'cta' bucket into named counts the retro can target
// (spacing vs absolute-superlative vs cold-open ...), instead of collapsing 8 distinct CTA defects into
// one ambiguous counter every night. Keyword order = priority (most specific first). Pure + testable;
// an unrecognized reason falls back to 'other' so it still counts, never silently dropped. The slugs
// mirror the judge's own REJECT vocabulary in cta.mjs / style/thread-checklist.md §4.
export function ctaSubReason(reason = '') {
  const s = String(reason).toLowerCase();
  const rules = [
    ['disclosure-stack',      /disclosure|aff ?link|bare label|full title|\blabel\b/],
    ['spacing',               /stack|blank line|same line|one line|two sentences|own line|line break|scannab/],
    ['absolute-superlative',  /absolute|not hedged|unhedged|#1|\bno\.?\s?1\b|nothing beats|\bthe best\b/],
    ['evidence-verb',         /prove|guarantee|\bcure|\btreat|\bprevent|disease|health claim/],
    ['evidence-flow',         /benefit|line 2|continue.*concept|doesn'?t flow|jumps?\b/],
    ['lead-concept',          /lead concept|missing concept|no concept|substance|symptom/],
    ['cold-open',             /cold open|no bridge|\bbridge\b|new topic|doesn'?t continue|off.?topic/],
    ['generic',               /generic|no superlative|\bweak\b|\bvague\b|\bbland\b/],
    ['echo',                  /\becho|repeat|duplicate|identical/],
    ['placement',             /placement|adjacent|position|wrong tweet|too close/],
    ['standalone-ad',         /standalone ad|reads as (?:an )?ad|\bad\b/],
  ];
  for (const [slug, re] of rules) if (re.test(s)) return slug;
  return 'other';
}

// dailyRunStatus({ shipped, planned, poolSize, freshStarved }) — pure classifier for the daily engine's
// run outcome. Lifted out of the daily engine, retired 2026-10-06 (IMPROVEMENTS 2026-08-01, daily retro) because the single
// `NO_SCHEDULE` label conflated two OPPOSITE conditions, and nothing downstream could tell them apart:
//   planned 0, shipped 0 => nothing was ever planned: every slot was already occupied. Benign.
//   planned N, shipped 0 => N slots WERE planned and EVERY generation FAILED. Critical — yet the retro
//                           guidance described this exact shape as "every slot was already full — also
//                           healthy" (the literal 2026-07-31 run: byTier {T3:8}, scheduled 0).
// That conflation is the ROOT CAUSE of the two 2026-08-01 proposals which blamed the stagger/fan-out
// rules for a day whose plan was simply empty — a reader defect misread as a scheduler defect. Splitting
// the label is the fix at source: it changes NOTHING about which threads get selected or scheduled.
//   'ok'         — shipped, majority fresh/carried winners
//   'degraded'   — shipped, but the majority of slots came from the stale all-time FILL pool
//   'NO_WINNERS' — the source pool itself was empty (dead/broken feed or over-tight gates)
//   'NO_SLOTS'   — pool had sources but no slot was open to plan into (benign; the quiet path)
//   'ALL_FAILED' — slots were planned and every single generation failed (loud; revenue-zero defect)
export function dailyRunStatus({ shipped = 0, planned = 0, poolSize = 0, freshStarved = false } = {}) {
  if (shipped > 0) return freshStarved ? 'degraded' : 'ok';
  if (!poolSize) return 'NO_WINNERS';
  return planned > 0 ? 'ALL_FAILED' : 'NO_SLOTS';
}

// normalizeRunStatus(log) — the READER half of the NO_SCHEDULE split above (IMPROVEMENTS 2026-08-03,
// daily retro). Splitting the label at the EMITTER fixed every run from 2026-08-02 on, but retro.mjs
// reads the last four run logs, so the two pre-split logs (07-31, 08-01) kept handing the model a
// literal `status=NO_SCHEDULE` — and it dutifully re-proposed the already-shipped split as a fresh
// critical defect. The label is dead: re-derive it on read so no consumer ever sees it again.
//   `planned` did not exist before the split either, but `byTier` is built FROM the plan
//   (in the retired daily engine), so its values sum to exactly plan.length — the true planned count.
//   That derivation reproduces the two real runs: 07-31 (byTier {T3:8}, scheduled 0, sources 117)
//   => ALL_FAILED, and 08-01 (byTier {}, scheduled 0, sources 115) => NO_SLOTS.
// Pure: returns the input untouched unless it carries the legacy label, and never mutates it.
export function normalizeRunStatus(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return log;
  if (log.status !== 'NO_SCHEDULE') return log;
  const tiers = log.byTier && typeof log.byTier === 'object' && !Array.isArray(log.byTier) ? Object.values(log.byTier) : [];
  const planned = typeof log.planned === 'number'
    ? log.planned
    : tiers.reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0);
  const shipped = typeof log.scheduled === 'number' ? log.scheduled : 0;
  const poolSize = typeof log.sources === 'number' ? log.sources : 0;
  return { ...log, planned, status: dailyRunStatus({ shipped, planned, poolSize }), legacyStatus: 'NO_SCHEDULE' };
}

// accountHealth(byAccount, opts) — pure per-account + fleet health diagnostics for the registry retro.
// Reads ONLY the aggregate counts registry-sync already computes onto its byAccount map (posted /
// draft / scheduled / revenue) — NO money math, NO selection, NO I/O — and surfaces the named
// failure modes the retro currently lacks, so a whole-account stall or a dark attribution join can't hide
// behind a green "clean" flag. Three per-account flags + two fleet flags:
//   - phase 'ramping' : posted < rampMinPosted — too few shots to judge a page yet (the ramp gate
//                       new pages like Rafael/Knox lacked; keeps a quiet new page from reading as a bad page).
//   - stall           : draft >= draftBacklog AND scheduled === 0 — content generated but nothing queued to
//                       post (the AI-Evolution "47 drafts rotting, 0 scheduled" class the clean flag masked).
//   - staleDrafts     : a MATURE account still scheduling (so `stall`, which needs scheduled===0, misses it)
//                       whose drafts exceed staleDraftBacklog OR whose postedRate is below minPostedRate —
//                       drafts piling up faster than they ship (generation capacity spent on rows that rot).
//   - zeroRevenue     : a page that HAS shipped enough to earn (posted >= zeroRevMinPosted) yet shows $0 revenue
//                       WHILE the rest of the fleet is earning (fleetRevenue > 0) — a genuine per-account
//                       monetization break (dead CTA / wrong link / mismatched product), not a dark join. Gated on
//                       fleetRevenue > 0 so it never double-fires with attributionDark (whole-fleet $0 = dark join,
//                       reported once below). Pure comparison on the count registry-sync already computed — no money math.
//   - attributionDark : FLEET-level — total revenue === 0 across darkMinPosted+ published rows, i.e. the
//                       Levanta/Gumroad join is almost certainly returning empty rather than a true zero (flies
//                       the retro blind on $/post, the #1 lever). Pure detector only — never touches the join.
//   - fleet draft backlog : FLEET-level — total unposted drafts across the fleet exceed fleetDraftBacklog, so
//                       aging/unshipped generation is a first-class flush-or-cut signal, not buried per-account.
// Returns { alarms, perAccount: {name:{phase,stall,staleDrafts,zeroRevenue}}, attributionDark, fleetDrafts }.
// (lowHitRate/bestWinRate retired 2026-09-02 with the Winner status: hit-rate divergence was
// computed off winner counts, and performance judgment moved to the farm gate. attributionDark
// stayed but re-keyed — see below.)
// `exclude` (Phase 7b): account names left out of every alarm AND every fleet total — the burner
// staging page, whose 235 unqueued drafts are its purpose, not a stall (they also made up 235 of the
// fleet backlog's 319).
export function accountHealth(byAccount = {}, { rampMinPosted = 30, draftBacklog = 20, staleDraftBacklog = 5, minPostedRate = 0.8, fleetDraftBacklog = 30, zeroRevMinPosted = 10, darkMinPosted = 30, exclude = [] } = {}) {
  const skip = new Set(exclude);
  const names = Object.keys(byAccount || {}).filter((n) => !skip.has(n));
  const perAccount = {}, alarms = [];
  let fleetPosted = 0, fleetRevenue = 0, fleetDrafts = 0;
  for (const n of names) { const a = byAccount[n] || {}; fleetPosted += a.posted || 0; fleetRevenue += a.revenue || 0; fleetDrafts += a.draft || 0; }
  // A per-account $0 flag is only meaningful when SOME account IS earning (fleetRevenue > 0); a whole-fleet $0 is
  // the dark-join case reported once via attributionDark below, so gate on this to avoid double-firing on every page.
  const fleetEarns = fleetRevenue > 0;
  for (const n of names) {
    const a = byAccount[n] || {};
    const posted = a.posted || 0, draft = a.draft || 0, scheduled = a.scheduled || 0, revenue = a.revenue || 0;
    const postedRate = a.postedRate; // may be absent on synthetic inputs — guarded below, never coerced to 0
    const ramping = posted < rampMinPosted;
    const stall = draft >= draftBacklog && scheduled === 0;
    // Stale-draft rot: catches the account that IS still queueing (scheduled>0, so `stall` can't see it) yet
    // keeps accumulating unposted drafts. postedRate is only consulted when present (real registry runs set it).
    const staleDrafts = !ramping && !stall && (draft > staleDraftBacklog || (postedRate != null && postedRate < minPostedRate));
    // Monetization break: shipping enough to earn but $0 while peers earn (dead CTA/link/product), not a ramp.
    const zeroRevenue = fleetEarns && posted >= zeroRevMinPosted && revenue === 0;
    perAccount[n] = { phase: ramping ? 'ramping' : 'mature', stall, staleDrafts, zeroRevenue };
    if (stall) alarms.push(`${n}: publishing stall — ${draft} drafts, 0 scheduled (generated but never queued to post)`);
    // The alarm carries its own REMEDY (IMPROVEMENTS 2026-07-31 queue-capacity item): the DETECTION
    // this run's backlog asks for already fired, but the operator was left to infer the lever. The lever
    // already exists and is one line — `paused: true` in accounts.mjs, which every generation path honours
    // before it spends a slot. Automating the skip is the human-gated half and stays unshipped.
    if (staleDrafts) alarms.push(`${n}: draft backlog rotting — ${draft} unposted draft(s)${postedRate != null ? `, postedRate ${postedRate}` : ''} (generating faster than it ships) → APPLY BACKPRESSURE: flush or schedule the stale drafts, or set \`paused: true\` for this account in accounts.mjs to skip it next cycle until the queue drains`);
    if (zeroRevenue) alarms.push(`${n}: monetization dark — ${posted} posted, $0 revenue while the fleet earns (CTA/link/product likely broken)`);
  }
  // Dark join, fleet-level. Used to key on "revenue $0 while winners > 0" — winners implied earnings,
  // so the contradiction proved the join broke. With winner counts retired the equivalent proof is
  // volume: a fleet with darkMinPosted+ published registry rows earning $0 TOTAL is a join returning
  // empty, not a true zero (the fleet has never had 30 published posts and no commission anywhere).
  const attributionDark = fleetRevenue === 0 && fleetPosted >= darkMinPosted;
  if (attributionDark) alarms.push(`attribution dark — fleet revenue $0 across ${fleetPosted} published post(s); the Levanta/Gumroad join is likely returning empty, not a true zero`);
  // Fleet-level draft-backlog signal: aging/unshipped drafts summed across the fleet become a first-class
  // number instead of being buried in per-account counts, so a flush-or-cut decision is actionable each run.
  if (fleetDrafts > fleetDraftBacklog) alarms.push(`fleet draft backlog — ${fleetDrafts} unposted draft(s) fleet-wide exceed ${fleetDraftBacklog}; flush or cut stale generation before it burns more slots`);
  return { alarms, perAccount, attributionDark, fleetDrafts };
}

// Leading list numbers ("1. ", "2) ") in document order within one tweet.
export const leadingNumbers = (t) =>
  (String(t).match(/(?:^|\n)[ \t]*(\d{1,3})[.)]\s/g) || []).map((m) => parseInt(m.replace(/\D/g, ''), 10));

// Compress [1,2,3,5,6,24] -> "1-3, 5-6, 24" for readable messages.
function ranges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = []; let i = 0;
  while (i < s.length) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`); i = j + 1;
  }
  return out.join(', ');
}

// Numbering integrity: if the thread is a numbered list, the leading numbers across all
// tweets in posting order must be exactly 1..N, contiguous and in order. This is the check
// that was MISSING when draft 9469443 shipped with numbers on only half its tweets.
// Returns a message if broken, else null. (< 3 numbers total = not a numbered list, skip.)
/**
 * A number used twice in the SAME list. Pure.
 *
 * numberingIssue walks the body and passes a clean 1..N, which is exactly what it saw on Rafael's
 * live draft 10527365 — the hook carried "1. Don't get up to pee at 3 AM" and the body ran
 * 1,2,3,4,5,6,7, so the thread shipped with two item 1s and nothing complained. The reader counts;
 * the gate has to count the same way, hook included.
 *
 * The one legal repeat is the TEASE hook: a hook previewing "1. <item>" whose body then restates it
 * as 1. That is a real donor shape, so a hook marker equal to the FIRST body marker is allowed and
 * nothing else is.
 */
export function duplicateMarkerIssue(tweets = []) {
  const list = (tweets || []).map((t) => String(t || ''));
  if (!list.length) return '';
  const hook = leadingNumbers(list[0]);
  const body = list.slice(1).flatMap(leadingNumbers);
  if (body.length < 3) return '';
  const all = [...hook, ...body];
  // Drop the legal tease repeat — but only when it IS one. A matching number is not enough: Rafael's
  // draft had the hook holding item 1 and a pasted pod holding a second item 1, which looks identical
  // in the numbers alone. What separates them is the TEXT: a tease restates its item, so the two read
  // as the same item; a stolen number reads as two different ones. Compared on vocabulary overlap,
  // with a low bar, so a loosely reworded restatement still counts as a restatement.
  const firstBodyIdx = list.findIndex((t, i) => i > 0 && leadingNumbers(t).length);
  const stripMarker = (t) => String(t).replace(/(^|\n)[ \t]*\d{1,3}[.)]\s*/, '$1').trim().split('\n')[0];
  if (hook.length && body.length && hook[hook.length - 1] === body[0]) {
    const a = stripMarker(String(list[0]).split('\n').filter(Boolean).slice(-1)[0] || '');
    const b = stripMarker(list[firstBodyIdx] || '');
    if (hookSimilarity(a, b) >= 0.35) all.splice(hook.length - 1, 1);   // a genuine restatement
  }
  const seen = new Set(), dupes = new Set();
  for (const n of all) { if (seen.has(n)) dupes.add(n); seen.add(n); }
  if (!dupes.size) return '';
  return `item number${dupes.size > 1 ? 's' : ''} used twice: ${[...dupes].sort((a, b) => a - b).join(', ')} `
    + `(the list reads ${all.join(', ')}) — the reader counts, so every number appears once`;
}

/** PURE. A list marker fused to its text: "2.Dr. Nathan Bryan" instead of "2. Dr. Nathan Bryan".
 *  leadingNumbers requires whitespace after the marker, so a fused one is INVISIBLE to it — the item
 *  then reads as missing and the thread is refused for a gap that is really a missing space. Lorenzo
 *  10653126 shipped that way and the numbering gate blamed the wrong thing. A digit after the marker
 *  is never counted ("2.5g", "1.5x"): only a letter or an opening quote starts an item title. */
export const fusedMarkers = (tweets) => (tweets || []).flatMap((t, i) =>
  (String(t).match(/(?:^|\n)[ \t]*\d{1,2}[.)](?=[A-Za-z"'\u201c])/g) || []).map((m) => ({ tweet: i + 1, marker: m.trim() })));

export function numberingIssue(tweets) {
  // Say what is actually wrong FIRST. Reporting "missing 2" when the text reads "2.Dr." sends the
  // reader looking for an item that is right there.
  const fused = fusedMarkers(tweets);
  if (fused.length) return `list marker with no space after it: ${fused.map((f) => `"${f.marker}" in tweet ${f.tweet}`).join(', ')} — the numbering gate cannot see it, so the item reads as missing`;
  let nums = tweets.flatMap(leadingNumbers);
  if (nums.length < 3) return null;
  const clean = (ns) => ns.every((n, i) => n === i + 1);
  if (clean(nums)) return null;
  // TEASE HOOKS. A proven donor shape ends the hook on item one and then delivers it again as the
  // first body tweet: "Foods that destroy belly fat specifically.\n\n1. Green tea" -> "1. GREEN TEA".
  // (@phresh_arrow, 2.38M views.) The hook's number is a teaser, not a list entry, so counting it
  // reported "1,1,2,3,4,5,6" as broken on a thread whose body numbering is perfect. Drop the hook's
  // contribution ONLY when doing so makes the rest a clean 1..N — a hook with a genuinely wrong
  // number still fails, because removing it would not repair the sequence.
  const hookNums = leadingNumbers(tweets[0] || '');
  if (hookNums.length && clean(nums.slice(hookNums.length))) return null;
  const max = Math.max(...nums);
  const present = new Set(nums);
  const missing = []; for (let k = 1; k <= max; k++) if (!present.has(k)) missing.push(k);
  if (missing.length) return `numbering broken — present ${ranges(nums)}, missing ${ranges(missing)} (need continuous 1-${max})`;
  return `numbering out of order — got ${nums.join(',')}`;
}

// ---- THE HOOK'S PROMISE (operator 2026-09-15) ---------------------------------------------------
// numberingIssue proves the markers run 1..N with no gap. It says nothing about whether the items
// are what the HOOK SAID they would be, and that is the half a reader notices first.
//
// Live proof, peak's 2026-09-17 remix. The hook read "The supplements you need to keep your stamina
// after 35:" and the five items were NAD+, "The dose on the front is rarely the dose that lands",
// "Sleep, and it is not negotiable", nitrate, and "Salt, and most men over-correct the wrong way".
// Two supplements and three habits, sold as five supplements. Every gate passed it — numbering,
// rhythm, the backline pod, plugSubstanceBridge — because each of them reads a different question.
// The close even admitted it in as many words ("5 things. 2 you buy, 3 you decide") and nothing
// cared. The operator caught it by reading the thread, which is the only reader this had left.
//
// So the hook is read as a PROMISE and the body is checked against it, on the two things a
// deterministic check can actually settle:
//
//   COUNT     the hook says "3 things" / "9 signs" / "5 kinds" and the body delivers a different
//             number of distinct numbered items.
//   CATEGORY  the hook's promise noun names a SUBSTANCE CLASS (supplements, vitamins, minerals,
//             nutrients, pills) and an item's own header line names no substance.
//
// It deliberately does NOT judge an open promise noun. "3 things that stop it" admits a training
// rule, a food and a supplement in one list — julian's thread is exactly that and is correct — and a
// checker that guessed at the boundary would manufacture findings faster than it caught them. Only a
// promise that narrows the item type to a class we hold vocabulary for gets the category read.

// The nouns a count can attach to. The point of a CLOSED set is that the other numbers in a hook
// never read as a count: "lost 6kg of muscle at 44", "1 in 3 over 60", "a 15-minute window",
// "90 days" — kg, years, windows and days are not things you enumerate 1..N.
const PROMISE_SUBSTANCE_NOUNS = ['supplement', 'vitamin', 'mineral', 'nutrient', 'pill', 'capsule', 'powder'];
const PROMISE_OPEN_NOUNS = [
  'thing', 'sign', 'symptom', 'reason', 'rule', 'way', 'step', 'habit', 'mistake', 'change',
  'move', 'lever', 'lesson', 'tip', 'question', 'food', 'swap', 'fix', 'kind', 'type', 'item',
  'red flag', 'warning sign', 'exercise', 'marker', 'trait', 'stage', 'phase',
];
const PROMISE_NOUNS = [...PROMISE_SUBSTANCE_NOUNS, ...PROMISE_OPEN_NOUNS];
const _esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "<N> <up to two words> <list noun>" — "7 early signs", "3 things", "5 kinds", "9 things your body".
// Three deliberate narrowings, each one a false positive it produced on the live slate:
//   · the digit must be followed by a SPACE, which keeps "15-minute" and the leading marker
//     "1. Creatine" out — neither has one;
//   · the separator is [ \t], never \s, so a count never reaches ACROSS A LINE BREAK. Julian's hook
//     ends one line on "it started at 35" and opens the next on "3 things that stop it", and \s
//     read that as a promise of 35 items;
//   · a filler word may not itself be a number, so "1 in 3 over 60" cannot bind 1 to a noun two
//     numbers away;
//   · the noun must be PLURAL. A list of N is always "3 things", never "3 thing", so the plural is
//     free to demand — and demanding it is what separates a count from a MEASUREMENT wearing the
//     same shape. Clara's live hook, "there is a 40 second thing you can do about it", read as a
//     promise of forty items until the s was required.
const PROMISE_COUNT_RE = new RegExp(`\\b(\\d{1,2})[ \\t]+(?:(?!\\d)[\\w'’-]+[ \\t]+){0,2}(${PROMISE_NOUNS.map(_esc).join('|')})s\\b`, 'i');
// The promise noun on its own, for a hook that names the class without counting it — peak's
// "The supplements you need to keep your stamina after 35:" is the whole live case.
const PROMISE_CLASS_RE = new RegExp(`\\b(${PROMISE_SUBSTANCE_NOUNS.map(_esc).join('|')})s\\b`, 'i');
// A class noun inside a NEGATION is the opposite of a promise. Camila's live hook — "He named 5
// everyday things quietly costing you 15 years. The one that matters most has nothing to do with
// food, training or supplements:" — says the list is not supplements, and the first cut of this
// gate read that sentence as promising them. Checked over the words leading up to the noun.
const PROMISE_NEGATED_RE = /\b(?:nothing to do with|not(?:hing)?|no|never|without|besides|beyond|other than|aside from|forget|skip)\b[^.!?\n]{0,60}$/i;

// Recognition vocabulary, this gate's own. BRIDGE is a ROUTING table — it carries symptom words
// (cortisol, brain fog, inflammation) that are not substances at all — so the symptom-gated half is
// subtracted, and SUBSTANCE_WORDS is added because it exists for exactly this: reading a substance
// we do not necessarily sell. The extras below are substances our copy argues that neither list
// holds; they live here rather than in SUBSTANCE_WORDS because that list feeds substanceTermsFor,
// where a new word changes which PRODUCT a plug is allowed to claim, and this gate only needs to
// recognise a word on a page.
const PROMISE_EXTRA_SUBSTANCES = [
  'nitrate', 'electrolyte', 'electrolytes', 'sodium', 'potassium', 'calcium', 'selenium',
  'magnesium citrate', 'amino acid', 'amino acids', 'eaa', 'bcaa', 'fibre', 'fiber', 'psyllium husk',
  'folate', 'vitamin k', 'vitamin e', 'vitamin a', 'choline', 'carnitine', 'l-carnitine', 'creatine monohydrate',
  // The six the backfill sweep found firing on GOOD threads: alpha-GPC and the multivitamin are
  // plainly supplements and were simply absent from both lists.
  'alpha-gpc', 'alpha gpc', 'multivitamin', 'multi-vitamin',
  // The CLASS nouns count as naming a substance, because a tease is a legitimate item header:
  // "4. Sleep, and the mineral that fixes it" and "3. The nutrient that tells the body to do the
  // repair" both name a substance to the reader without naming WHICH, and both shipped as written.
  ...PROMISE_SUBSTANCE_NOUNS,
];
let _promiseSubstanceRes = null;
const promiseSubstanceRes = () => {
  if (_promiseSubstanceRes) return _promiseSubstanceRes;
  const words = new Set([
    ...Object.keys(BRIDGE).filter((k) => !SYMPTOM_GATED.has(k)),
    ...SUBSTANCE_WORDS,
    ...PROMISE_EXTRA_SUBSTANCES,
  ]);
  _promiseSubstanceRes = [...words].map((w) => new RegExp(`\\b${_esc(w)}\\b`, 'i'));
  return _promiseSubstanceRes;
};
export const namesSubstance = (text) => promiseSubstanceRes().some((re) => re.test(String(text || '')));

/** Every numbered item as { n, header } — the marker's OWN line, never the tweet around it.
 *  That distinction is the gate: peak's "3. Sleep, and it is not negotiable" is followed by
 *  "No supplement outruns 5 hours a night", so reading the whole tweet would pass the very item
 *  the hook is lying about. Duplicates keep the FIRST line seen, so a tease hook that repeats
 *  item 1 in the body does not count twice. */
export function numberedItems(tweets = []) {
  const out = new Map();
  for (const t of tweets || []) {
    for (const line of String(t ?? '').split('\n')) {
      const m = line.match(/^\s*(\d{1,3})[.)]\s+(\S.*)$/);
      if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), m[2].trim());
    }
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([n, header]) => ({ n, header }));
}

/**
 * ERROR: the body does not deliver what the hook promised.
 * `allowItems` waives a numbered item the operator has declared deliberate.
 */
export function hookPromiseIssue(tweets = [], { allowItems = [] } = {}) {
  const list = (tweets || []).map((t) => String(t ?? ''));
  const items = numberedItems(list);
  if (items.length < 2) return ''; // not a numbered list — nothing was promised
  const hook = list[0] || '';
  const waived = new Set((allowItems || []).map(Number));
  const out = [];

  const counted = hook.match(PROMISE_COUNT_RE);
  if (counted) {
    const promised = Number(counted[1]);
    if (promised !== items.length) {
      out.push(`hook promises ${promised} ("${counted[0]}") but the body numbers ${items.length} item${items.length === 1 ? '' : 's'}`);
    }
  }

  // The category read fires on a counted substance promise ("5 supplements") and on a bare one
  // ("The supplements you need to…") alike — the count is not what makes the promise narrow.
  //
  // But a count that landed on an OPEN noun settles the question: "5 everyday things" promises five
  // things, and whatever else the hook goes on to say about supplements is commentary, not the
  // promise. Only a hook with no count of its own falls through to the bare class read, and then
  // only outside a negation.
  let classNoun = null;
  if (counted) {
    if (PROMISE_SUBSTANCE_NOUNS.includes(String(counted[2]).toLowerCase())) classNoun = `${counted[2]}s`;
  } else {
    const bare = PROMISE_CLASS_RE.exec(hook);
    if (bare && !PROMISE_NEGATED_RE.test(hook.slice(0, bare.index))) classNoun = bare[0];
  }
  if (classNoun) {
    const strays = items.filter((it) => !waived.has(it.n) && !namesSubstance(it.header));
    if (strays.length) {
      out.push(`hook promises ${classNoun.toLowerCase()} but ${strays.length} item${strays.length === 1 ? ' names' : 's name'} none: `
        + strays.map((it) => `${it.n}. "${it.header.slice(0, 48)}"`).join(', ')
        + ' — make the item a substance, widen the hook to what the list actually is, or waive it with allowItems');
    }
  }
  return out.join(' · ');
}

// Deterministic numbering scaffold: rewrite every leading list marker ("3.", "7)") to a contiguous
// 1..N sequence in posting order, so a mis-numbered draft (the recurring "missing 6" class) can't fail
// the numbering gate over a cosmetic slip. It only touches the leading MARKER, never the prose, and is
// a no-op on a non-list thread (< 3 markers). It does NOT change the COUNT of markers, so a genuinely
// dropped item still trips the separate dropped-vs-source gate — fidelity is preserved, only renumbering
// is automated. Used by recreate.mjs before validation.
export function renumberLeadingMarkers(tweets) {
  if (tweets.flatMap(leadingNumbers).length < 3) return tweets; // not a numbered list — leave untouched
  let n = 0;
  return tweets.map((t) =>
    String(t).replace(/((?:^|\n)[ \t]*)\d{1,3}([.)]\s)/g, (_, pre, post) => `${pre}${++n}${post}`));
}

// Deterministic last-resort plug trimmer: GUARANTEE a plug's text (excl link) fits PLUG_LIMIT when the
// stochastic LLM tighten passes couldn't. Drops trailing whole sentences from the longest prose beat —
// never the link, never the "Aff link" disclosure line — so a valid, tracked revenue plug ships instead
// of the whole slot dying on a length miss (shipping nothing = $0; a slightly shorter plug still converts).
// Only a fallback; recreate.mjs logs when it fires, so chronic over-length stays visible. Pure + testable.
export function hardTrimPlug(tweet, limit = PLUG_LIMIT) {
  if (plugTextLen(tweet) <= limit) return tweet;
  const link = (tweet.match(/https?:\/\/\S+/) || [''])[0];
  const isProtected = (b) => (link && b.includes(link)) || /aff\s*link|#ad|affiliate/i.test(b);
  const isRec = (b) => /:\s*$/.test(b.trim()); // the recommendation line ends on a colon into the link; it carries the product name
  const splitSentences = (b) => b.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  const over = (bs) => plugTextLen(bs.join('\n\n')) > limit;
  let beats = String(tweet).split(/\n{2,}/).map((b) => b.replace(/\s+$/, '')).filter((b) => b.length);
  // Pass 1: shed the longest BRIDGE/LIVED beat (never the recommendation, never disclosure/link).
  // Multi-sentence beat -> drop its trailing sentence; single-sentence beat -> drop the whole line
  // (keeps the rest grammatical, cleaner than a truncated fragment). The recommendation survives.
  let guard = 0;
  while (over(beats) && guard++ < 80) {
    const pool = beats.map((b, i) => ({ b, i })).filter(({ b }) => !isProtected(b) && !isRec(b));
    if (!pool.length) break; // only the recommendation + disclosure + link remain
    pool.sort((x, y) => y.b.trim().length - x.b.trim().length);
    const { i } = pool[0];
    const sents = splitSentences(beats[i]);
    if (sents && sents.length > 1) beats[i] = sents.slice(0, -1).join('').trimEnd();
    else beats.splice(i, 1);
    beats = beats.filter((b) => b.trim().length);
  }
  // Pass 2 (absolute last resort): the recommendation line alone is still over budget — word-trim it
  // rather than drop it, so the product name is the very last thing sacrificed.
  guard = 0;
  while (over(beats) && guard++ < 200) {
    const i = beats.findIndex((b) => !isProtected(b));
    if (i < 0) break;
    const words = beats[i].trim().split(/\s+/);
    if (words.length <= 1) { beats.splice(i, 1); beats = beats.filter((b) => b.trim().length); continue; }
    beats[i] = words.slice(0, -1).join(' ');
  }
  return beats.join('\n\n');
}

// normalizePlugStructure(tweet) — SAFE, mechanical-only cleanup of a plug's SHAPE (never its claims),
// run at generation BEFORE the structural gate so the deterministic layer ships a canonically-spaced plug
// instead of leaking a cosmetic defect (a leaked bullet marker, a triple blank line, the disclosure stacked
// onto the link) into the nightly QC 'spacing'/'disclosure-stack' signal — the loudest recurring family.
// It ONLY:
//   - strips a single line-leading bullet/decoration marker the model sometimes prefixes (•, ‣, ·, ▪, ●, *, "- ")
//   - trims trailing whitespace per line
//   - respaces an "Aff link"-style disclosure so it reads "Aff link:" on its own line, ONE blank line, then the link
//   - expands a SINGLE line break between two sentence/slot lines into the canonical blank-line-between, so a plug
//     whose sentences were emitted stacked with one "\n" (the recurring 'spacing'/merged-lines CTA defect) ships
//     one-thought-per-line + a blank line between, mirroring recreate.mjs's content-tweet spacer
//   - collapses any run of 3+ newlines to exactly two (the canonical blank-line-between)
// It NEVER edits words, claims, superlatives, or the product name — those stay with the LLM + judgePlug — and
// is a no-op on an already-clean plug. Pure + testable.
export function normalizePlugStructure(tweet) {
  let s = String(tweet);
  const link = (s.match(/https?:\/\/\S+/) || [''])[0];
  s = s
    .split('\n')
    .map((ln) => ln
      .replace(/[ \t]+$/, '')
      .replace(/^[ \t]*[•‣·▪●∙*\-]+[ \t]+/, '')   // one leading bullet + its space
      .replace(/^[ \t]*\(?\d{1,3}[.)][ \t]+/, ''))  // …and a leading list NUMBER ("1. ", "2) ", "(3) ") — see PLUG_NUMBERED_RE
    .join('\n');
  // DM-style CTA "Get it here (aff link):" is ONE ATOMIC label (prompts.mjs dmCta) — it must be
  // canonicalized FIRST, or the two classic rewrites below each grab their half and explode it into
  // "Get it here:\n\n(Aff link:\n\n):" — the live Lucas typo, 2026-08-10. Parenthetical content
  // (e.g. a US-store note) is preserved.
  if (link && /get it here\s*\(\s*aff\s*link[^)]*\)/i.test(s)) {
    s = s.replace(/get it here\s*\(\s*(aff\s*link[^)]*?)\s*\)\s*:?[ \t]*\n?\s*/i, (m, inner) => `Get it here (${inner.replace(/\s+/g, ' ').trim()}):\n\n`);
  } else if (link && /\(\s*aff\s*link[^)]*\)/i.test(s)) {
    // ANY parenthetical label ("Lorenzo's pick (Aff link):", "Still the one I buy (aff link):") is
    // ONE atomic closer — same protection the dm branch above gets. Without this, the bare rewrite
    // below breaks INSIDE the parens and ships the live "(Aff link:\n\n):" mangle (Lorenzo A-to-Z
    // smoke, 2026-08-17). [^)] spans newlines, so this also REPAIRS an already-mangled input.
    s = s.replace(/\(\s*(aff\s*link[^)]*?)\s*\)\s*:?[ \t]*\n?\s*/i, (m, inner) => `(${inner.replace(/\s+/g, ' ').replace(/:+$/, '').trim()}):\n\n`);
  } else {
    // Canonicalize the affiliate disclosure -> link block: "Aff link:" alone, one blank line, then the link.
    // Only fires when an "Aff link"-style token is present (never rewrites a "#ad"/"Affiliate:" disclosure).
    if (link && /aff\s*link/i.test(s)) s = s.replace(/aff\s*link\s*:?[ \t]*\n?\s*/i, `${DISCLOSURE}\n\n`);
    // Own-product CTA ("Get it here:" — gumroad ebook) gets the same canonical block treatment.
    if (link && /get it here/i.test(s)) s = s.replace(/get it here\s*:?[ \t]*\n?\s*/i, 'Get it here:\n\n');
  }
  // Blank-line-between enforcement: a lone "\n" between two lines becomes a blank-line break (every
  // sentence on its own line, one blank line between — checklist §4), then any 3+ run collapses to two.
  s = s.replace(/(?<!\n)\n(?!\n)/g, '\n\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  // Final pass: the three defects the 2026-08-17/18 batches shipped through this normalizer are all
  // BEAT-STRUCTURE defects it never looked at — it canonicalized tokens and line breaks, then
  // returned whatever beat count it was handed. 25 of 35 audited threads had a plug whose beats
  // were fused, doubled or stacked. repairPlugBeats owns that layer now.
  return repairPlugBeats(s);
}

/**
 * Deterministic beat-structure repair for a PLUG tweet. Three live defects, measured 2026-08-18
 * (merged-lines on 25 of 35 audited threads, the rest a handful each):
 *
 *   MERGED BEATS      opener and middle fused into one blank-line block ("only 1 line before the
 *                     CTA"). The writer typed real sentences; only the blank line between them is
 *                     missing. Split the first multi-sentence beat at its FIRST sentence boundary,
 *                     repeating until the shape's own count is met (bare "Aff link:" disclosure
 *                     needs 3 beats before it, a CTA-carrying disclosure needs 2 — mirrors
 *                     plugStructure exactly).
 *   DOUBLED DISCLOSURE "Aff link:" canonicalized and a bare "#ad:" left standing right behind it
 *                     (magnus 10373119). Two disclosure beats, one of them saying nothing — the
 *                     bare "#ad" beat is dropped when any other disclosure beat exists.
 *   STACKED LINK      the URL riding the disclosure line instead of its own (lucas 10380549). The
 *                     URL moves to its own beat after the disclosure.
 *
 * Pure, idempotent, and a no-op on anything already canonical — the slot-mode assembler's output
 * passes through unchanged. Exported for tests.
 */
export function repairPlugBeats(tweet) {
  let s = String(tweet);
  const url = (s.match(/https?:\/\/\S+/) || [''])[0];
  if (!url) return s; // not a plug — beat law does not apply
  const own = /gumroad\.com/i.test(url);
  const isDisc = (b) => /aff\s*link|#ad\b|affiliate|commission/i.test(b) || (own && /get it here/i.test(b));
  const bareAd = (b) => /^#ad\s*:?$/i.test(b.trim());
  const SPLIT_AT = /(?<=[.!?])\s+(?=[A-Z0-9"'])/;

  for (let pass = 0; pass < 4; pass++) {
    const beats = s.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const discIdx = beats.findIndex(isDisc);
    if (discIdx < 0) return s;

    // DOUBLED: a bare "#ad" beat is noise whenever any OTHER beat already discloses.
    const dupAd = beats.findIndex((b, i) => bareAd(b) && beats.some((x, j) => j !== i && isDisc(x)));
    if (dupAd >= 0) { beats.splice(dupAd, 1); s = beats.join('\n\n'); continue; }

    // STACKED: the URL must sit alone on the last beat, never on the disclosure line.
    if (beats[discIdx].includes(url) && beats[discIdx].replace(url, '').trim()) {
      beats[discIdx] = beats[discIdx].replace(url, '').replace(/[ \t]+$/, '').trim();
      beats.splice(discIdx + 1, 0, url);
      s = beats.join('\n\n');
      continue;
    }

    // MERGED: split multi-sentence beats until this shape's own count is met.
    // Mirrors plugStructure's bare test EXACTLY: strip only the disclosure TOKEN and see whether
    // words remain. "Aff link:" reduces to nothing (bare). "Get it here (aff link):" keeps its CTA
    // words (not bare) — stripping those too is what briefly folded the atomic DM label into the
    // beat above it.
    const bare = !beats[discIdx].replace(/\(?\s*aff\s*link\s*\)?|#ad\b|affiliate|commission/gi, '').replace(/[():.,!\s]/g, '').length;
    const need = bare ? 3 : 2;
    const before = beats.slice(0, discIdx).filter((b) => b.replace(url, '').trim().length);
    if (before.length >= need) return s;
    // A bare disclosure whose prior beat does NOT end in a colon is the CTA line missing its
    // hand-off. Under the retired "(Aff link)" law the fix was to FOLD the token up into that beat;
    // `#ad` is a hashtag and cannot live inside a sentence, so it keeps its own beat and only the
    // CTA line is repaired. The colon is what makes the disclosure + link read as that line's
    // payoff instead of a stray tag. Own-product plugs carry no disclosure, so they are excluded.
    // (2026-08-21: the splice that used to remove the folded beat was briefly left in place here
    // while the fold itself was removed — which silently DELETED the disclosure. Do not reinstate.)
    if (bare && !own && discIdx > 0 && !beats[discIdx - 1].includes(url) && !/:\s*$/.test(beats[discIdx - 1])) {
      beats[discIdx - 1] = beats[discIdx - 1].replace(/[.!]?\s*$/, '') + ':';
      s = beats.join('\n\n');
      continue;
    }
    const k = beats.findIndex((b, i) => i < discIdx && !b.includes(url) && SPLIT_AT.test(b));
    if (k < 0) return s; // nothing splittable — the writer genuinely under-delivered; the gate decides
    const [head, ...rest] = beats[k].split(SPLIT_AT);
    beats.splice(k, 1, head.trim(), rest.join(' ').trim());
    s = beats.join('\n\n');
  }
  return s;
}

// absoluteSuperlativeIssue(tweet) — deterministic detector for an UNHEDGED absolute-ranking superlative in a
// plug ("#1", "no. 1", "the best", "the ultimate", "unbeatable", "nothing beats it") — the exact claim style
// style/thread-checklist.md §4 forbids on line 3 (which must be first-person + hedged) and the defect
// ctaSubReason buckets as 'absolute-superlative'. It is a deterministic BACKSTOP to the LLM judgePlug:
// judgePlug returns {ok:true} on ANY judge exception (API overload etc.), so an "#1"/"the best"/"nothing beats
// it" plug could otherwise sail through ungated. Only ever runs on PLUG tweets (checkThread/validate apply it
// to plugIdx only), where "the best X" is essentially always a product-ranking absolute — so the false-positive
// surface a body lesson would create ("the best sleep of my life") never applies. Two exemptions keep it from
// flagging legitimate hedged copy: (1) the SUPERLATIVE_HEDGE_RE first-person hedge ("one of the best I've
// found", "the best-absorbing one I've tried"); (2) an EARNED hyphenated differentiator ("best-absorbing",
// "top-rated") — the "the (best|top)" alternative uses a (?!-) lookahead so the compound never trips. A miss
// still costs $0 (the judge catches subtler cases) and a hit only forces a regeneration, never a shipped post.
// Returns a short message or null. Pure + testable. (IMPROVEMENTS 2026-07-19, QC final pass.)
// "number one" SPELLED OUT was the one phrase style/learned-rules.md names but this backstop missed:
// the digit forms ("#1", "no. 1") were covered, so a plug that wrote it in words slipped past the
// deterministic gate and relied entirely on judgePlug — which then failed OPEN on any API exception (fail-safe since 2026-09-23, #571).
// (IMPROVEMENTS 2026-07-28, QC final pass.)
// SYNONYM BYPASS: the model learned to route around "the best"/"the top" with semantically identical
// absolutes the gate never listed — "the perfect magnesium", "the greatest sleep aid". Same forbidden
// claim shape, different adjective, so the deterministic backstop passed it to the then fail-open judge.
// The added adjectives are product-RANKING absolutes only; deliberately NOT added are "the most
// powerful"/"the strongest"/"the biggest"/"the latest", which are legitimate elsewhere (the live corpus
// carries hooks like "Sleep is the most powerful medicine on Earth") — this check is plug-scoped, but
// the set stays unambiguous on purpose, matching the scoping note above. The shared (?!-) lookahead
// keeps EARNED hyphenated differentiators exempt ("the finest-milled one I've tried").
// (IMPROVEMENTS 2026-08-11, QC final pass — "Reject Unsupported Superlative Variants".)
const ABSOLUTE_SUPERLATIVE_RE = /#\s?1\b|\bno\.?\s?1\b|\bnumber one\b|nothing (?:beats|compares|else comes close)|\bunbeatable\b|\bthe ultimate\b|\bthe (?:best|top|perfect|greatest|finest|purest|cleanest)\b(?!-)/i;
const SUPERLATIVE_HEDGE_RE = /\bI(?:'ve| have)?\s+(?:tried|found|used|use|trust|take|switched)|\bone of the best\b|\bmy (?:favou?rite|go[- ]?to)\b|\bthe only one I\b/i;
// plugNumberedLineIssue(tweets, { plugLinks }) — a plug line must NEVER open with a list marker
// ("1. Magnesium is …"). X renders no markdown, so the marker ships as literal noise at the top of the
// CTA, and it is invisible to every existing gate: numberingIssue only fires when the thread carries
// >=3 markers total, and when it DOES, renumberLeadingMarkers sweeps the plug's stray "1." into the
// BODY's 1..N sequence — silently corrupting the item numbering to hide the defect. Root cause is
// upstream in prompts.mjs, whose plug checklist itself was written as "1. BIG IDEA / 2. EVIDENCE / …"
// and the model mirrored its own instruction format into the output; that checklist is now lettered.
// normalizePlugStructure strips the marker deterministically (pure shape, same as the bullet strip it
// sits beside), so at generation this is a BACKSTOP; at QC — where nothing normalizes an already-live
// post — it is the only thing that sees it. Returns a short message or ''. Pure + testable.
export const PLUG_NUMBERED_RE = /(?:^|\n)[ \t]*\(?\d{1,3}[.)][ \t]+/;
export function plugNumberedLineIssue(tweets, { plugLinks = [] } = {}) {
  const isPlug = (s) => plugLinks.some((l) => l && s.includes(l)) || /lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(s);
  const hits = (tweets || [])
    .map((t, i) => (isPlug(String(t)) && PLUG_NUMBERED_RE.test(String(t)) ? i + 1 : 0))
    .filter(Boolean);
  if (!hits.length) return '';
  return `plug ${hits.join(', ')} opens a line with a list marker ("1.", "2)") — a CTA is plain prose lines, never a numbered list`;
}

// plugBridgeIssue(tweets, {plugLinks, skip}) — deterministic backstop for the CTA's BRIDGE rule
// (cta.mjs line 17: line 1 "continues the idea of the tweet right before it (reuse one of its words)";
// REJECT list: "a cold open / no bridge"). That rule's only enforcement is judgePlug, which returns
// {ok:true} on ANY judge exception — so on an API blip a plug that cold-opens on a brand-new topic
// ships as a standalone ad, the shape that depresses CTA conversion. Same backstop pattern
// absoluteSuperlativeIssue plays for the superlative rule. (IMPROVEMENTS 2026-08-02, QC final pass.)
//
// Scoped to the UNAMBIGUOUS failure on purpose. A legitimate bridge can paraphrase ("cortisol" ->
// "that stress hormone"), so demanding overlap with the immediately-prior tweet alone would warn on
// copy judgePlug rightly passes — and a noisy warn corrupts the nightly QC signal the retro reads.
// Instead it looks back over the LAST 3 non-plug tweets and fires only when line 1 shares no content
// word with ANY of them: a true cold open, not a paraphrase. WARN-only, and QC-only (never wired into
// validateDraft) so it can never spin a generation retry loop on a plug the judge already approved.
// Returns a short message or ''. Pure + testable.
const BRIDGE_LOOKBACK = 3;
// Length floor is 3, not 4 (fixed 2026-08-18). At 4 the tokenizer could not see NAD, EPA, DHA, D3
// or K2 — so a plug whose line 1 said "That's why I care about NAD", one tweet after "that is where
// nad comes in", was reported as a COLD OPEN. Measured on the live backlog: of 20 drafts this check
// flagged, the substance-too-short case and the paraphrase case below accounted for nearly all of
// them. A gate whose failures are mostly false makes its own signal unreadable, and "fixing" the
// copy to satisfy it would have meant deleting deliberate writing.
// minLen is a parameter because the two callers want different floors. MATCHING (below) needs 3 so a
// short substance name counts; bridgeAnchors feeds words into a PROMPT and keeps 4, because a 3-letter
// token is a useless thing to hand a writer as an anchor.
// A floor of 3 still hid D3 and K2 (fixed 2026-09-23): 2 characters, dropped here before the
// SHORT_SUBSTANCES check below ever saw them, so a D3+K2 plug one tweet after "That's D3 season." was
// reported as a cold open. MATCHING passes SHORT_SUBSTANCES as `keep`, the tokens exempt from the floor.
const bridgeWords = (text, minLen = 4, keep = null) => String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((w) => (w.length >= minLen || keep?.has(w)) && !HOOK_ITEM_STOPWORDS.has(w));

// The second false-positive class is a DELIBERATE paraphrase: line 1 names the category, the thread
// named the member. "not on a mineral I was low on" after four tweets about magnesium is the writer
// withholding the noun for one more beat, which is craft, not a cold open. Bridging on the category
// word only counts when the prior tweets actually instantiate it — "mineral" bridges to a thread
// about magnesium, and to nothing in a thread about fish oil.
// The only tokens under 4 characters worth bridging on: substance names the 4-char floor used to hide.
// Anything else short is a preposition or a fragment, and must not count.
const SHORT_SUBSTANCES = new Set(['nad', 'epa', 'dha', 'k2', 'd3', 'b12', 'coq', 'mct', 'zma', 'nmn', 'gaba', 'hmb']);

const BRIDGE_CATEGORIES = [
  [/\bminerals?\b/, /\b(magnesium|zinc|potassium|calcium|iron|selenium|electrolytes?|glycinate|threonate|citrate)\b/],
  [/\b(circulation|circulatory)\b/, /\b(blood|flow|nitric|oxide|vessels?|vascular|citrulline|arginine|beet)\b/],
  [/\b(forms?|versions?|labels?|bottles?|capsules?|softgels?|doses?|servings?)\b/,
   /\b(glycinate|oxide|citrate|threonate|monohydrate|picolinate|ubiquinol|ubiquinone|coq10|triglyceride|ester|ksm|standardi[sz]ed|withanolides?)\b/],
  [/\b(fish\s*oils?|omegas?)\b/, /\b(epa|dha|omega|fish)\b/],
];
const categoryBridge = (line1, priorText) =>
  BRIDGE_CATEGORIES.some(([cat, members]) => cat.test(line1) && members.test(priorText));
export function plugBridgeIssue(tweets, { plugLinks = [], skip = [] } = {}) {
  const arr = (tweets || []).map((t) => String(t || ''));
  const isPlug = (t) => /lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(t) || plugLinks.some((l) => l && t.includes(l));
  const skipSet = new Set(skip.filter(Boolean));
  for (let i = 0; i < arr.length; i++) {
    if (!isPlug(arr[i])) continue;
    // Line 1 = the plug's first slot, i.e. everything before the disclosure/link.
    const line1 = arr[i].split(/\n{2,}/).map((b) => b.trim())
      .find((b) => b && !/^(?:aff\s*link|#ad|affiliate)/i.test(b) && !/https?:\/\//.test(b));
    const mine = line1 ? bridgeWords(line1, 3, SHORT_SUBSTANCES) : [];
    if (!mine.length) continue;                               // nothing to compare — fail open
    const prior = [];
    for (let k = i - 1, seen = 0; k >= 0 && seen < BRIDGE_LOOKBACK; k--) {
      if (isPlug(arr[k]) || skipSet.has(arr[k])) continue;     // other plugs + boilerplate are not context
      prior.push(...bridgeWords(arr[k], 3, SHORT_SUBSTANCES));
      seen++;                                                  // count TWEETS looked back, not words collected
    }
    if (!prior.length) continue;                              // no preceding content (plug leads the thread)
    // Substring matching is what lets "magnesium" bridge "magnesium's" and "form" bridge "forms".
    // At 3 characters it stops being useful and starts being noise ("low" inside "lower"), so a
    // short token has to match a prior token EXACTLY, and only when it is a real substance name.
    const matches = (w) => prior.some((p) => (w.length < 4
      ? (SHORT_SUBSTANCES.has(w) && p === w)
      : (p.includes(w) || w.includes(p))));
    // Third escape hatch, and the most principled one: the pod law says the HAND-OFF lives in the
    // tweet before the plug ("...and that is where collagen comes in."). When the prior tweet's last
    // sentence already names what the plug sells, the reader arrives holding the substance and line 1
    // is free to open on a symptom, an objection, or a memory. That is craft, not a cold open — this
    // check exists to catch a plug that arrives from nowhere, not one that arrives from the sentence
    // immediately above it.
    const prevTweet = arr.slice(0, i).reverse().find((t) => !isPlug(t) && !skipSet.has(t)) || '';
    const lastSentence = (prevTweet.split(/(?<=[.!?])\s+/).filter(Boolean).pop() || '');
    const plugWords = bridgeWords(arr[i], 4);
    const handedOff = bridgeWords(lastSentence, 4).some((w) => plugWords.includes(w));
    const bridged = mine.some(matches) || categoryBridge(line1.toLowerCase(), prior.join(' ')) || handedOff;
    if (!bridged) return `plug ${i + 1} cold-opens — line 1 shares no concept word with the ${BRIDGE_LOOKBACK} tweets before it (a CTA must bridge, never read as a standalone ad)`;
  }
  return '';
}

// bridgeAnchors(text, limit) — the CONCRETE words a plug's line 1 can bridge from, extracted from the
// tweet it will be spliced after. Deliberately the SAME tokenizer plugBridgeIssue tests with, so the
// generator is handed the exact token set the deterministic checker looks for rather than being left to
// re-derive it (IMPROVEMENTS 2026-08-05, QC final pass: cold opens are attention drift over a long
// context, not a missing rule — the plug prompt already carries the bridge rule and the prior tweet in
// full, so more words cannot fix it; the anchor has to be surfaced next to the instruction).
//
// The FINAL sentence leads (that is the line the plug reads off), then the rest of the tweet follows as
// backup so a short or pronoun-only closing sentence still yields a usable hint. Returns [] when there
// is nothing concrete to anchor on — callers emit no hint at all rather than a misleading one.
// Pure + testable. HINT-ONLY: it never gates or rewrites anything, so a thin extraction costs nothing.
export function bridgeAnchors(text, limit = 6) {
  const s = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const sentences = s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const ordered = [...bridgeWords(sentences[sentences.length - 1] || ''), ...bridgeWords(s)];
  const out = [];
  for (const w of ordered) if (!out.includes(w)) out.push(w);
  return out.slice(0, limit);
}

export function absoluteSuperlativeIssue(tweet) {
  const s = String(tweet);
  if (!ABSOLUTE_SUPERLATIVE_RE.test(s)) return null;
  if (SUPERLATIVE_HEDGE_RE.test(s)) return null; // a first-person hedge is present -> allow
  return 'absolute (non-hedged) superlative in plug';
}

// strayPlugFragmentIssue(tweets, {plugLinks}) — deterministic backstop for the "5-line CTA block
// fragmented" defect (IMPROVEMENTS 2026-07-23, QC final pass): when the generator loses track of the
// plug's shape it occasionally emits a plug SENTENCE line — the evidence line ("Research links X to
// Y...") or the hedged-superlative line ("...one I've tried:") — as its OWN standalone tweet, detached
// from the "Aff link:"+URL tweet. A well-formed plug carries all five lines inside ONE tweet, so this
// only ever runs on NON-plug, url-less tweets and fires on two unambiguous leaked-line shapes:
//   • a hedged-superlative line ending in a colon ("... the best-absorbing one I've tried:") — a body
//     tweet is never a first-person "best … I've tried/found" clause dangling a colon, so this fires
//     wherever it appears;
//   • an evidence line ("Research links …") sitting IMMEDIATELY BEFORE a plug tweet that lacks its own
//     evidence line — i.e. the plug's line 2 truly leaked out. Gating on the adjacent plug missing its
//     evidence line keeps a legitimate mid-body "Research links …" point (whose neighbouring plug still
//     carries its own evidence line) from ever tripping it.
// Returns a short message or null. Pure + testable; wired as an ERROR in checkThread (QC blocks/pulls)
// and validateDraft (generation regenerates) — so the malformed thread is rebuilt, never auto-patched.
const EVIDENCE_FRAGMENT_RE = /^\s*research links\b/i;        // the orphan tweet IS the evidence line
const EVIDENCE_LINE_RE = /(^|\n)[ \t]*research links\b/i;    // a plug carrying its own evidence line (any line)
const SUPERLATIVE_FRAGMENT_RE = /\bbest\b[^\n]*\bI(?:'ve| have)?\s+(?:tried|found|used|use|switched)\b[^\n]*:\s*$/i;
export function strayPlugFragmentIssue(tweets, { plugLinks = [] } = {}) {
  const arr = tweets || [];
  const isPlug = (t) => /lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(t) || (plugLinks || []).some((l) => l && String(t).includes(l));
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i] || '');
    if (isPlug(t) || hasUrl(t)) continue; // the plug tweet itself is fine — a leaked fragment carries no URL
    if (SUPERLATIVE_FRAGMENT_RE.test(t))
      return `tweet ${i + 1} is a stray plug fragment — a hedged-superlative line ("...I've tried:") detached from its Aff link block`;
    // Evidence line leaked out only if the ADJACENT plug is missing its own "Research links" line.
    const nextPlug = i + 1 < arr.length && isPlug(String(arr[i + 1] || '')) ? String(arr[i + 1]) : '';
    if (EVIDENCE_FRAGMENT_RE.test(t) && nextPlug && !EVIDENCE_LINE_RE.test(nextPlug))
      return `tweet ${i + 1} is a stray plug fragment — an evidence line ("Research links...") detached from its Aff link block`;
  }
  return null;
}

// plugStructure(tweet) — deterministic 5-slot structural fingerprint of a plug, so the nightly QC CTA
// classifier can NAME the concrete structural defect instead of dropping an unrecognized judge reason
// into the opaque 'cta:other/unclassified' bucket (IMPROVEMENTS 2026-07-09, QC final pass). The canonical
// plug is exactly five slots, each on its own line, blank-line separated (mirrors regenPlug in qc.mjs +
// normalizePlugStructure above):
//   [1 lead idea] / [2 evidence] / [3 hedged superlative ending ':'] / 'Aff link:' / [bare URL]
// Returns {ok:true} for a well-formed plug, else {ok:false, failed:'<slot>', detail} naming the FIRST
// slot that breaks (link / disclosure / link-placement / merged-lines / extra-slot / missing-colon).
// Pure + testable; CLASSIFY-ONLY — it never gates a post, so a misread only mislabels a retro signal,
// never blocks a revenue plug. The block is located from its 'Aff link:'/#ad disclosure pivot: the
// sentence lines precede it, the URL sits at/after it.
export function plugStructure(tweet) {
  const s = String(tweet).replace(/\s+$/, '');
  const url = (s.match(/https?:\/\/\S+/) || [''])[0];
  if (!url) return { ok: false, failed: 'link', detail: 'no affiliate URL present' };
  const beats = s.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean); // blank-line-separated slots
  // Own-shop Gumroad (our ebook): "Get it here:" is the CTA slot — same structural position as the
  // affiliate disclosure, no aff wording required (first-party product, operator ebook test 2026-08-08).
  const own = /gumroad\.com/i.test(url);
  const discIdx = beats.findIndex((b) => /aff\s*link|#ad|affiliate|commission/i.test(b) || (own && /get it here/i.test(b)));
  if (discIdx < 0) return { ok: false, failed: 'disclosure', detail: own ? 'no CTA line ("Get it here:")' : 'no affiliate disclosure line' };
  const urlIdx = beats.findIndex((b) => b.includes(url));
  if (urlIdx >= 0 && urlIdx < discIdx) return { ok: false, failed: 'link-placement', detail: 'link appears before the disclosure' };
  // Slot 4 must be the disclosure ALONE — "Aff link:" on its own line, blank line, then the bare URL.
  // The stacked variant ("Aff link: https://lvnta.com/...") used to read as ok:true here, so a real
  // shape defect landed in the retro's opaque 'cta:other' bucket instead of earning a named signal
  // (IMPROVEMENTS 2026-08-04, registry pipeline). normalizePlugStructure already REPAIRS the
  // "aff link"-token form at generation, so this fires almost exclusively on live/legacy drafts QC
  // re-reads — and on the one form normalize deliberately leaves alone (a "#ad"-style disclosure).
  if (urlIdx >= 0 && urlIdx === discIdx) return { ok: false, failed: 'disclosure-stacked', detail: 'the affiliate link sits on the disclosure line instead of its own' };
  // The three sentence lines are the non-empty beats BEFORE the disclosure, excluding a beat that is only
  // the URL. Fewer than 3 = two elements collapsed onto one line (the disclosure-stack/merged-lines defect);
  // more than 3 = an extra slot the shape doesn't allow.
  const sentences = beats.slice(0, discIdx).filter((b) => b.replace(url, '').trim().length);
  // Short-CTA styles: when the disclosure line ALSO carries the call to action, the classic
  // exactly-3-plus-colon rule relaxes to 2-3 beats with no beat-3 colon requirement.
  //
  // This used to match a hard-coded phrase list (`get it here|check it out|pick \(aff`), which
  // quietly made those three phrasings the ONLY legal short CTAs — every new style had to adopt
  // someone else's marketing words to pass. Measured cost (2026-08-15): June's winning plugs used
  // 12 distinct CTA lines across 15 plugs ("Affiliate, but worth every dollar.", "Been testing this
  // for months. Aff link below, I use it daily:", "...mixes clean, and this is the one I buy:");
  // August's formula era used 2 shapes across 16. The winning era was the varied one.
  //
  // The real distinction is STRUCTURAL, not lexical: strip the disclosure token itself and see
  // whether any words remain. "Aff link:" reduces to nothing -> it is a bare disclosure, so the
  // classic 3-beat shape applies. "Julian's magnesium pick (aff link):" or "Been testing this for
  // months. Aff link below:" still carries a sentence -> the line IS the CTA, so 2-3 beats. Any
  // fresh wording an author invents now passes on its own merits.
  const ctaCarrying = beats[discIdx]
    .replace(/\(?\s*(aff(iliate)?\s*link|#ad|commission)s?\s*\)?/ig, ' ')
    .replace(/[^a-z0-9]+/ig, '')
    .length > 0;
  if (ctaCarrying) {
    if (sentences.length < 2) return { ok: false, failed: 'merged-lines', detail: `only ${sentences.length} line(s) before the CTA (need 2-3, one per line)` };
    if (sentences.length > 3) return { ok: false, failed: 'extra-slot', detail: `${sentences.length} lines before the CTA (max 3)` };
    return { ok: true };
  }
  if (sentences.length < 3) return { ok: false, failed: 'merged-lines', detail: `only ${sentences.length} sentence line(s) before the disclosure (need 3, one per line)` };
  if (sentences.length > 3) return { ok: false, failed: 'extra-slot', detail: `${sentences.length} sentence lines before the disclosure (need exactly 3)` };
  if (!/:$/.test(sentences[2])) return { ok: false, failed: 'missing-colon', detail: 'line 3 (hedged superlative) does not end in a colon' };
  return { ok: true };
}

// plugEchoIssue(heavy, light, {style}) — the two plugs must not read as the same ad twice.
//
// Live evidence (clara, 2026-08-12): both plugs opened on cortisol, both ran "Research links ... to
// lower cortisol, ..., and ... sleep", and both closed "... I've tried:". Four tweets apart, same
// link. The prompt already forbids this ("a DIFFERENT lead concept on line 1 AND a DIFFERENT
// superlative form on line 3") and the model complied in name only — which is the exact situation
// the engine answers with a deterministic check rather than louder prompt wording.
//
// SHAPE, not content: the two plugs usually promote the SAME product, so sharing the substance noun
// is legitimate and must never trip this. What is checked is the mold —
//   • the closing bigram of the last claim line ("...I've tried:" twice), and
//   • the opening bigram of line 1 (skipped for 'narrative', whose prompt MANDATES both plugs open
//     "I used to ...", and for 'classic' line 2, whose "Research links" opener is likewise dictated
//     by the template — only line 1 and the superlative tail are the model's own choices).
// Returns a short reason or null. Pure + testable. ADVISORY: recreate re-rolls once and ships
// anyway, because a slightly echoey plug still earns and a blocked draft earns nothing.
const ECHO_STOP = new Set(['the', 'a', 'an', 'and', 'to', 'of', 'is', 'it', 'this', 'that', 'my', 'i']);

function echoLines(plug) {
  const url = (String(plug).match(/https?:\/\/\S+/) || [''])[0];
  return String(plug)
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => !(url && b.includes(url)))
    // Drop the CTA/disclosure line in every style, so what gets compared is always the last CLAIM
    // line. Missing a CTA form here silently compares a boilerplate line instead and the gate stops
    // catching anything (the "Check it out now (aff link)" form did exactly that).
    .filter((b) => !/^(aff\s*link|#ad)/i.test(b) && !/get it here|check it out|pick \(aff/i.test(b));
}

const words = (line) => String(line).toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
const openBigram = (line) => words(line).slice(0, 2).join(' ');
const closeBigram = (line) => words(line).slice(-2).join(' ');

export function plugEchoIssue(heavy, light, { style = 'classic' } = {}) {
  const a = echoLines(heavy);
  const b = echoLines(light);
  if (!a.length || !b.length) return null;
  // The superlative/payoff tail is the model's own phrasing in every style — the strongest signal
  // that it reached for the same mold twice.
  const tailA = closeBigram(a[a.length - 1]);
  const tailB = closeBigram(b[b.length - 1]);
  if (tailA && tailA === tailB && !tailA.split(' ').every((w) => ECHO_STOP.has(w))) {
    return `both plugs close on "${tailA}"`;
  }
  // Line 1's opener is dictated by the template in narrative ("I used to ...") and lean ("This is
  // the ..."), so it is only the model's own choice — and only worth judging — elsewhere.
  if (style !== 'narrative' && style !== 'lean') {
    const openA = openBigram(a[0]);
    const openB = openBigram(b[0]);
    if (openA && openA === openB && !openA.split(' ').every((w) => ECHO_STOP.has(w))) {
      return `both plugs open on "${openA}"`;
    }
  }
  return null;
}

// plugShapeIssue(tweets, {plugLinks}) — the GATE half of plugStructure (IMPROVEMENTS 2026-08-08 +
// 2026-08-09, QC final pass: "hard-code CTA structural validation" / "disclosure stacking validator").
// plugStructure itself stays CLASSIFY-ONLY on purpose — it names five failure classes and a misread on
// any of the three prose slots (merged-lines / extra-slot / missing-colon) would hard-fail a shippable
// monetized draft, which is why the classifier was deliberately kept off the ship path.
//
// So this gates only the two classes that are UNAMBIGUOUS and DETERMINISTICALLY REPAIRABLE:
//   • disclosure-stacked — "Aff link: https://lvnta.com/..." on ONE line. Never a legitimate shape, and
//     normalizePlugStructure already rewrites exactly this form into "Aff link:" + blank line + URL.
//   • link-placement — the URL sits ABOVE the disclosure, so the reader meets the link before the
//     required affiliate disclosure. A compliance defect, not a taste call.
// Both are what normalizePlugStructure repairs, so this fires only on a path that skipped normalization
// (a judge rewrite, --tweets-file) — the same "backstop only" role plugNumberedLineIssue plays. The
// three prose-slot classes stay classify-only, unchanged.
// Returns a short message naming the first offending plug, or null. Pure + testable.
const GATED_PLUG_SHAPES = new Set(['disclosure-stacked', 'link-placement']);
export function plugShapeIssue(tweets, { plugLinks = [] } = {}) {
  const arr = tweets || [];
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i] || '');
    if (!(plugLinks || []).some((l) => l && t.includes(l))) continue; // plug tweets only (link-bearing)
    const s = plugStructure(t);
    if (!s.ok && GATED_PLUG_SHAPES.has(s.failed)) return `plug shape (${s.failed}) in #${i + 1}: ${s.detail}`;
  }
  return null;
}

// sharedNgramIssue(tweets, sourceTexts, { n = 7, allow }) — deterministic anti-duplication gate for
// SKELETON-VARIATION mode (keep the viral FORM, replace the CONTENT). X's 2026-07 creator-program
// enforcement down-ranks "copied text with light edits" at ~3x the old detection rate, and our own
// recreation engine is detectable by construction (a same-mold hook + a ~85%-faithful body). This
// flags the failure it must never re-introduce: any run of >= n consecutive words our thread shares
// VERBATIM with a source (the skeleton's own source OR a fact-pool thread we drew facts from).
//
// Legitimate shared runs are exempt by treating them as run BOUNDARIES rather than content: a bare
// number/dosage/count ("400", "3") and every occurrence of an `allow` phrase (product names, the
// affiliate disclaimer) split the token stream, so an n-gram never spans one. A plug that names the
// same product, or a shared "400 mg", therefore can't trip the gate — only an uninterrupted run of n
// genuine PROSE words can. Pure + testable. Returns a short message naming the first offending tweet +
// the lifted phrase, or null. Repairable via the existing targeted-repair loop ("re-say tweet #k").
const ngTokens = (text) => String(text).replace(/https?:\/\/\S+/g, ' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
function ngBoundaryMask(tokens, allowPhrases) {
  const mask = tokens.map((t) => /^\d+$/.test(t)); // bare numbers are always run boundaries (dosages, list markers, counts)
  for (const phrase of allowPhrases) {
    const A = ngTokens(phrase); if (!A.length) continue;
    for (let i = 0; i + A.length <= tokens.length; i++) {
      let hit = true; for (let j = 0; j < A.length; j++) if (tokens[i + j] !== A[j]) { hit = false; break; }
      if (hit) for (let j = 0; j < A.length; j++) mask[i + j] = true;
    }
  }
  return mask;
}
function ngSegments(tokens, mask) {
  const segs = []; let cur = [];
  for (let i = 0; i < tokens.length; i++) { if (mask[i]) { if (cur.length) segs.push(cur); cur = []; } else cur.push(tokens[i]); }
  if (cur.length) segs.push(cur);
  return segs;
}
export function sharedNgramIssue(tweets, sourceTexts, { n = 7, allow = [] } = {}) {
  const allowPhrases = (allow || []).filter(Boolean);
  const gramsOf = (text) => { const toks = ngTokens(text); const segs = ngSegments(toks, ngBoundaryMask(toks, allowPhrases)); const out = []; for (const s of segs) for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n).join(' ')); return out; };
  const srcGrams = new Set();
  for (const s of (Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts])) for (const g of gramsOf(s)) srcGrams.add(g);
  if (!srcGrams.size) return null;
  const tw = Array.isArray(tweets) ? tweets : [tweets];
  for (let ti = 0; ti < tw.length; ti++) {
    for (const g of gramsOf(tw[ti])) if (srcGrams.has(g)) return `tweet ${ti + 1} shares a ${n}-word run verbatim with a source: "${g}"`;
  }
  return null;
}

// ---- hookStrength: deterministic hook scoring by similarity to PROVEN winner hooks -----------------
// Operator rule (2026-07-17): hook "strength" = similarity in VOCAB, PHRASING and STRUCTURE to existing
// data — the bank of hooks that actually went viral in our niches (learnings/hook-bank.json, refreshed
// weekly by refresh-hook-bank.mjs). No LLM judge: three pure similarity measures over the bank.
//   - vocab:     fraction of the hook's content words that recur across bank hooks (df >= 2) — are we
//                using the words winners use, weighted toward the corpus's common vocabulary.
//   - phrasing:  fraction of the hook's word bigrams/trigrams that appear verbatim in ANY bank hook —
//                short shared patterns ("than you think", "is silently") without long lifts.
//   - structure: agreement with the bank's structural norms over a fixed feature set (leads with a
//                number, second person, comparison, negation, authority cue, question, promise colon,
//                multi-line, length band, ...): matching a common feature scores its prevalence,
//                lacking a rare one scores its absence.
// Complements (never replaces) sharedNgramIssue: that gate caps similarity ABOVE (no >= 7-word verbatim
// runs); this floor requires similarity BELOW it. dupRisk flags a hook that near-verbatim clones a bank
// hook (>= 7-word shared run) — high "similarity" of exactly the kind X's duplicate enforcement punishes.
// Pure + deterministic. Returns { score 0-100, vocab, phrasing, structure, dupRisk } or null when the
// bank is missing/too small to be meaningful (< 10 hooks) — callers must treat null as "cannot score".
const HOOK_STOP = new Set(('a an the is are was were be been being of to in on for with at by from as and or but if than then that this these those it its you your yours i my me we our us they them their he she his her will would can could should do does did have has had not no so up out about into over after before more most less very just only own same what when why how all any each'
).split(' '));
const hookFeatures = (text) => {
  const t = String(text || '');
  const words = ngTokens(t);
  return {
    startsNumber: /^\d/.test(t.trim()),
    hasDigit: /\d/.test(t),
    secondPerson: /\b(you|your)\b/i.test(t),
    question: /\?/.test(t),
    promiseColon: /:\s*$/m.test(t),
    comparison: /\bthan\b/i.test(t),
    negation: /\b(no|not|never|stop|without|don'?t|won'?t|can'?t)\b/i.test(t),
    timeFrame: /\b\d+\s*(days?|weeks?|months?|years?|minutes?|hours?|seconds?)\b|\b(daily|overnight|every (day|night|morning))\b/i.test(t),
    authority: /\b(scien(?:ce|tists?)|research(?:ers)?|stud(?:y|ies)|doctors?|harvard|stanford|experts?)\b/i.test(t),
    collective: /\b(everyone|everybody|nobody|no one|most (people|men|women)|99%|9 out of 10)\b/i.test(t),
    alarm: /\b(warning|danger(?:ous)?|destroy(?:s|ing)?|ruin(?:s|ing)?|wreck(?:s|ing)?|kill(?:s|ing)?|silently|secretly|mistakes?|wrong|aging|failing)\b/i.test(t),
    multiLine: /\n/.test(t),
    lengthBand: words.length >= 5 && words.length <= 28,
  };
};
export function hookStrength(hook, bank) {
  const hooks = (Array.isArray(bank) ? bank : []).map((b) => (typeof b === 'string' ? b : b?.h)).filter(Boolean);
  if (hooks.length < 10 || !String(hook || '').trim()) return null;
  // corpus stats (recomputed per call — banks are ~150 one-liners, cost is negligible; keeps this pure)
  const df = new Map(); const bi = new Set(); const tri = new Set();
  const featCount = {}; const featKeys = Object.keys(hookFeatures(''));
  for (const h of hooks) {
    for (const w of new Set(ngTokens(h).filter((w) => !HOOK_STOP.has(w) && w.length > 2 && !/^\d+$/.test(w)))) df.set(w, (df.get(w) || 0) + 1);
    const toks = ngTokens(h);
    for (let i = 0; i + 2 <= toks.length; i++) bi.add(toks.slice(i, i + 2).join(' '));
    for (let i = 0; i + 3 <= toks.length; i++) tri.add(toks.slice(i, i + 3).join(' '));
    const f = hookFeatures(h);
    for (const k of featKeys) featCount[k] = (featCount[k] || 0) + (f[k] ? 1 : 0);
  }
  // vocab: mean per-word corpus recurrence (df>=2 counts fully; df=1 half — one winner used it once)
  const content = ngTokens(hook).filter((w) => !HOOK_STOP.has(w) && w.length > 2 && !/^\d+$/.test(w));
  const vocab = content.length ? content.reduce((s, w) => s + ((df.get(w) || 0) >= 2 ? 1 : (df.get(w) ? 0.5 : 0)), 0) / content.length : 0;
  // phrasing: shared short-pattern coverage
  const toks = ngTokens(hook);
  const bis = []; for (let i = 0; i + 2 <= toks.length; i++) bis.push(toks.slice(i, i + 2).join(' '));
  const tris = []; for (let i = 0; i + 3 <= toks.length; i++) tris.push(toks.slice(i, i + 3).join(' '));
  const phrasing = (bis.length ? 0.6 * (bis.filter((g) => bi.has(g)).length / bis.length) : 0)
    + (tris.length ? 0.4 * (tris.filter((g) => tri.has(g)).length / tris.length) : 0);
  // structure: agreement with corpus norms (have a common feature -> its prevalence; lack a rare one -> its absence)
  const f = hookFeatures(hook);
  const structure = featKeys.reduce((s, k) => { const p = (featCount[k] || 0) / hooks.length; return s + (f[k] ? p : 1 - p); }, 0) / featKeys.length;
  const score = Math.round(100 * (0.35 * Math.min(1, vocab) + 0.30 * Math.min(1, phrasing) + 0.35 * structure));
  const dupRisk = !!sharedNgramIssue([hook], hooks, { n: 7 });
  const r2 = (x) => Math.round(x * 100) / 100;
  return { score, vocab: r2(vocab), phrasing: r2(phrasing), structure: r2(structure), dupRisk };
}

// Canonical plug positions, computed by CODE (never by the model):
//   HEAVY = right after the FIRST numbered point (operator rule 2026-07-20: the reader gets real value
//   — point 1 — before the first ad; a plug between the hook/promise and item 1 reads as a bait-and-
//   switch). When the hook itself carries "1." (classic faithful shape), fall back to the old position
//   rule: after the first body tweet, so the CTA lands at tweet #3.
//   NARRATIVE (no numbered items — operator rule 2026-07-20, Jake-thread review): the story must earn
//   the ad — the plug lands after the 3rd or 4th tweet depending on the narrative. Deterministically:
//   the first tweet at index 2-4 that does NOT end on a cliffhanger (":", "...", "…" — an ad right
//   after a cliffhanger kills the payoff it just promised); all-cliffhanger runs settle after the 4th.
//   LIGHT = right before the SECOND-TO-LAST numbered lesson (2026-09-02; it was the final one until
//   then). Clamp keeps the two plugs non-adjacent on tiny threads.
export function plugPositions(tweets) {
  const nums = tweets.map((t, i) => ({ n: (leadingNumbers(t) || [])[0], i })).filter((x) => x.n != null);
  const bodyNums = nums.filter((x) => x.i > 0); // numbered tweets AFTER the hook = the real points
  const cliffhanger = (t) => /(?::|\.\.\.|…)\s*$/.test(String(t || '').trim());
  // HEAVY CTA lands AFTER numbered point 1 — i.e. immediately before the tweet that begins point 2
  // (operator rule 2026-08-15: moved back UP from after-point-3, reverting the 2026-08-01 rule).
  // Measured on 358 posts with real plug positions: plug at tweet 3 vs 4 is a wash on clicks/1k
  // views AND organic virality (r = -0.05), but the after-point-3 rule DRIFTED — long intros and
  // narrative formats landed 61% of August's plugs at tweet 5+, where $/1k HALVES (CVR 0.7% vs
  // 2.5-2.9%). The June winners (8-12% CVR) all plugged at tweet 3. A point can span multiple
  // tweets (its "N." marker + unnumbered continuation), so inserting before the "2." tweet lands
  // the ad after ALL of point 1. Keys on the ACTUAL leading number, so it holds even when a donor
  // embeds "1." inside the hook (the attach rule) or numbering starts at 2.
  const AFTER_POINT = 1;
  const nextMarker = nums.find((x) => x.i > 0 && x.n === AFTER_POINT + 1); // the "2." tweet
  // HARD CAP (same ruling): whatever the numbering says, the plug is inserted no later than after
  // index 2 — plug tweet <= 4 — and no earlier than after index 1 — plug tweet >= 3, so the hook
  // still breathes. This is what actually kills the tweet-5+ drift on every format, numbered or not.
  const clampHeavy = (i) => Math.max(1, Math.min(2, i, tweets.length - 2));
  let heavyAfter;
  if (nextMarker) heavyAfter = clampHeavy(nextMarker.i - 1);              // after point 1, before point 2
  else if (bodyNums.length) heavyAfter = clampHeavy(bodyNums[0].i);       // markers but no "2.": after the first
  else if (tweets.length >= 5) {                                         // unnumbered thread: tweet 3, skip a cliffhanger
    const cands = [1, 2].filter((k) => k <= tweets.length - 2);
    heavyAfter = cands.find((k) => !cliffhanger(tweets[k])) ?? Math.min(2, tweets.length - 2);
  } else heavyAfter = Math.min(2, tweets.length - 2);                     // tiny thread fallback
  // LIGHT CTA lands before the SECOND-TO-LAST numbered point (operator 2026-09-02), one point
  // earlier than the last-item placement it replaces. Measured on the 463 two-product threads where
  // subid1b tags the light plug separately: it converts exactly like the heavy (EPC $0.384 vs
  // $0.381, CVR 5.30% vs 5.31%) on 55% of the clicks. The gap is REACH, not persuasion — so the
  // clicks a point of retention buys back convert at the heavy's rate, which is what makes moving it
  // earlier close to free. Two items now follow the ask instead of one, so the thread still does not
  // end on a sale. The never-adjacent clamp is unchanged: on a thread too short for the second-to-
  // last point to clear the heavy plug, the light is pushed back to heavyAfter + 2 as before.
  //
  // OPEN: this may be far too small a step. A separate measurement (2026-08-30, 601 threads, reach
  // read from tweet 2) puts T13 at 37.7% of the thread's real audience against 83.7% at T5 — so on
  // our 14-tweet median, one point earlier moves the light plug from ~37% reach to ~40%, while the
  // room it is aimed at is more than twice as full five tweets up. That branch proposed a fixed
  // target instead (nearest numbered marker to tweet 8, clamped the same way), which is a much
  // bigger move on the same thread. Both readings agree on the direction and disagree on the size,
  // and the size is the operator's call, so the conservative live rule stands until they make it.
  const lastTwo = bodyNums.length >= 2 ? bodyNums[bodyNums.length - 2].i
    : (bodyNums.length ? bodyNums[bodyNums.length - 1].i : tweets.length - 1);
  const lightBefore = (lastTwo <= heavyAfter + 1) ? Math.min(heavyAfter + 2, tweets.length - 1) : lastTwo;
  return { heavyAfter, lightBefore, extra: extraPlugSlots(tweets, heavyAfter, lightBefore) };
}

// ---- THE BONUS SLOT (operator 2026-09-02) ---------------------------------------------------------
// backline's fourth frame is "Bonus: Take X (dose, timing)" — unnumbered, sitting OUTSIDE the list by
// definition, which is what makes it the light plug's easy frame: it fits any host without having to
// be a sign, a cause or a list member. Two situations call for it automatically:
//   (a) a NARRATIVE host — no numbered items at all. A numbered entry line ("7. Take magnesium...")
//       cannot join a thread that has no list; "Bonus:" can follow any story.
//   (b) the never-adjacent clamp already pushed the light plug onto (or past) the LAST numbered
//       item, so the retention this morning's earlier slot buys is gone anyway — and a Bonus AFTER
//       the last item reads better than a numbered item wedged before it.
// In either case the plug lands right after the body's last item and before the closing tweet
// (the reply-bait question), never after the sign-off, which code appends later.
export function wantsBonus(tweets, { lightBefore } = {}) {
  const numbered = tweets.map((t, i) => ({ n: (leadingNumbers(t) || [])[0], i })).filter((x) => x.n != null && x.i > 0);
  if (!numbered.length) return true;                       // (a) narrative host
  const lastNum = numbered[numbered.length - 1].i;
  return lightBefore != null && lightBefore >= lastNum;   // (b) the clamp already put it at the end
}
export function bonusSlot(tweets) {
  const n = tweets.length;
  if (n < 2) return n;
  // The final tweet is the closer/reply-bait when it carries no item number; the Bonus goes just
  // before it. If the thread ends on a numbered item (no closer yet), the Bonus goes after it.
  const last = tweets[n - 1];
  return (leadingNumbers(last) || []).length ? n : n - 1;
}

// ---- FIRST-PLUG POSITION, the GATE (operator 2026-08-25) ----------------------------------------
// plugPositions above decides where the engine PUTS the first plug, and cta-audit has SCORED the
// same law post-hoc since August. Neither one blocks. So the hand-written lane, which has produced
// every thread for the last several runs, drifted with nothing complaining: all nine of 2026-08-26's
// drafts shipped with the first plug at tweet 4-8, seven of them at tweet 5 or later.
//
// Tweet 5 is where the money stops. Measured on 358 posts with real plug positions (the note on
// plugPositions carries the working): tweet 3 vs 4 is a wash on clicks and on organic reach, but
// 61% of August's plugs landed at tweet 5+ and $/1k HALVES there — CVR 0.7% against 2.5-2.9%. So
// the audit's "warn" band is really a fail band, and this is the check that says so while the draft
// can still be fixed instead of after it has spent its impressions.
//
// Too EARLY fails as well. A plug at tweet 2 has the verbatim hook as its only run-up, which is why
// bridgeWallIssue skips i < 2 outright — nothing has been given yet, so there is no criterion beat
// to arrive on and nothing has earned the ask.
//
// MEASURE THE ASK, NOT THE LINK (corrected 2026-08-25, same day, operator caught it). The first cut
// of this gate keyed on the tweet carrying the URL. But a CTA is a POD, and renderPod emits up to
// three tweets — POINT, BRIDGE, PLUG — with the link on the last of them. plugPositions splices that
// pod at heavyAfter + 1, so a full 3-tweet pod starting at the proven tweet 3 puts its LINK on tweet
// 5. Keyed on the link, this gate rejected the engine's own default shape, and the only way to pass
// it was to collapse the CTA to a lone plug tweet — which is `ctaOnly`, a shape reserved for donor-ad
// hijacks where the creator's surviving run-up already did the teaching.
//
// So the law is about where the ask BEGINS. ctaDepth is how many tweets the CTA occupies (3 = full
// pod, 2 = compact, 1 = ctaOnly); the block starts at link - (depth - 1), and THAT is what must land
// in the window. Depth then costs nothing, which is the point: the operator's default is 3.
//
// ctaDepth defaults to 1 deliberately. An unknown depth is judged as if the link tweet were the whole
// CTA, which is the strict reading — a caller that renders a deeper pod says so and is given the room.
//
// A shape may declare a later start: 'conceptual' plans a four-beat run-up, and a spec or mold may set
// firstPlugAt for a deep dive whose buying criterion genuinely cannot be stated earlier (M4's forms
// comparison IS its buying guide). A declaration only ever LOOSENS, never past warnWindowMax.
export function firstPlugIssue(tweets = [], plugIdx = [], { shape = null, firstPlugAt = null, ctaDepth = 1 } = {}) {
  if (!plugIdx.length) return null;                       // "no plugs at all" is its own, louder issue
  const link = plugIdx[0] + 1;
  const depth = Math.max(1, Math.floor(Number(ctaDepth)) || 1);
  const start = Math.max(1, link - (depth - 1));          // the tweet the ASK begins on
  const where = depth > 1 ? `first ask opens at tweet ${start} (link on ${link}, ${depth}-tweet CTA)` : `first plug at tweet ${start}`;
  if (start < LAWS.plugs.firstAt) {
    return `${where} — too early to have earned it, and there is no room for a criterion beat `
      + `between the hook and the ask (the ask belongs at tweet ${LAWS.plugs.firstAt}).`;
  }
  const shapeMax = shape === 'conceptual' ? LAWS.plugs.conceptualOkMax : LAWS.plugs.okWindowMax;
  const declared = Number.isFinite(Number(firstPlugAt)) && firstPlugAt != null
    ? Math.min(Number(firstPlugAt), LAWS.plugs.warnWindowMax) : 0;
  const max = Math.max(shapeMax, declared);
  if (start <= max) return null;
  const why = start > LAWS.plugs.warnWindowMax
    ? 'deep in the thread where $/1k roughly halves'
    : 'past the proven window, and every tweet of delay costs audience';
  return `${where} — ${why} (the ask must open by tweet ${max}${declared > shapeMax ? ', declared by the spec' : ''}). `
    + `The proven spot is tweet ${LAWS.plugs.firstAt}: move the CTA up, and make the tweet before it `
    + `end on that plug's substance so it is not a cold open.`;
}

// ---- REPOST REPAIRS (operator 2026-08-25) ------------------------------------------------------
// republish.mjs re-publishes a past winner verbatim with a fresh link, and never ran a gate. Measured
// the night this was written: NINE of our best-earning threads, replayed through validateDraft, and
// not one passed. Old disclaimers that trip the compliance regex, plugs with no bridge, asks fused
// into a numbered item, a hook naming a banned topic. The repost lane was the one route to publication
// with no standards attached, and it runs on a cron.
//
// Most of that is repairable without touching the copy that made the thread win, and this does the
// two repairs that carried the most weight — after them, five of the nine passed:
//
//   1. BOILERPLATE belongs to the account as it is NOW. These bodies are weeks old and the closings
//      and disclaimers have been rewritten since; the old ones do not match the strict-equality
//      checks and their wording trips hardHealthClaim. Legacy sign-offs carry none of the disclosure
//      words, so they are matched by shape too ("Stay well," and friends) or they strand above the
//      new pair.
//   2. PLUGS written before the bridge law carry their own lead-in — the sentence naming the
//      substance sits INSIDE the plug tweet. Lifting it out into its own tweet satisfies the bridge
//      rule, the heavy-ask floor and the ask-position rule in one move, because all three were only
//      ever describing that missing tweet.
//
// Returns a NEW array. What it cannot repair (a banned topic, a criterion that genuinely sits after
// the ask) is left for validateDraft to refuse, which is the point: repair what is mechanical, refuse
// the rest, and never publish either one unexamined.
const LEGACY_SIGNOFF = /^(stay well|repost the first tweet|follow me|share this)\b/i;
/**
 * Is this tweet OUR boilerplate — the sign-off or the legal fine print — whether or not it matches
 * the account's current copy exactly?
 *
 * The exact-match test (`isBoilerplate`) answers "is this the canonical string". This answers the
 * question a repair actually has: "is this tweet occupying the boilerplate slot", which a REWORDED
 * disclaimer also does. Marcos 10548021 shipped "Disclaimer: Some of these links are affiliate
 * links..." where the roster says "Straight up: some of these links..."; an indexOf-based repair
 * could not see it and appended a second disclaimer under the first.
 *
 * `source` widens the pop set for a cross-account repost, which arrives wearing the SOURCE
 * persona's sign-off. What gets APPENDED is always the target account's own copy, never this.
 */
export const boilerish = (t, account, source = null) => {
  const known = new Set([
    ...closingTexts(account), account?.disclaimer, account?.siteCta,
    ...(source ? [...closingTexts(source), source.disclaimer, source.siteCta] : []),
  ].filter(Boolean));
  const s = String(t);
  return known.has(s) || LEGACY_SIGNOFF.test(s.trim())
    || (!/https?:\/\//.test(s) && /affiliate link|not medical advice|FDA|commission/i.test(s));
};

// THE SKELETON'S SINCE-MONTH (docs/cta-spec.md §0b). The single strongest feature measured across
// 513 plug tweets — present in 60% of the 2%+ CTR winners against 23% of the rest — and the one
// beat that tells a skeleton plug from a backline one, because §0's template RETIRED the
// middle-beat time stamp. Exported so the rule has one home: lint-cover stamps the ledger arm with
// it and repostRepairs below refuses to take a skeleton plug apart with it.
export const SKELETON_SINCE_RE = /\bsince (?:january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|winter|20\d\d)\b/i;

/** PURE. Is this plug tweet written on the SKELETON — criterion first, then a protocol line
 *  carrying its since-month? The criterion IS the plug's first paragraph by construction, so it is
 *  not a fused lead-in and must never be lifted out of the tweet. `paras` is the plug split on
 *  blank lines. */
export const skeletonPlugParas = (paras = []) => paras.length >= 3 && paras.slice(1).some((b) => SKELETON_SINCE_RE.test(String(b)));

export function repostRepairs(tweets = [], account = null, products = [], { source = null } = {}) {
  let out = [...tweets].map((t) => String(t ?? ''));
  const links = (products || []).map((p) => p?.link).filter(Boolean);
  const isPlug = (t) => links.some((l) => t.includes(l));

  // 1. lift a fused lead-in out of every plug, last plug first so earlier indices stay valid
  //
  // A REPAIR MUST NEVER MAKE A PLUG WORSE. The paragraph-count guard below is not sufficient on its
  // own: a HEALTHY plug is five paragraphs (opener, middle, CTA, disclosure, link) and its opener
  // names the substance almost by definition, so it cleared the guard and got its opener lifted,
  // leaving two beats where the shape needs three. Measured on the 46-thread bench: this took 77
  // well-formed plugs and broke 59 of them into `merged-lines`, and because republish.mjs gates
  // AFTER repairing, the repost cron would have refused nearly every winner it picked up.
  //
  // So the lift now proves itself. It is a repair for a legacy plug that fused its bridge inside the
  // tweet; where the plug already passes plugStructure and the lift would break it, the plug is left
  // exactly as its author wrote it.
  for (let i = out.length - 1; i >= 1; i--) {
    if (!isPlug(out[i])) continue;
    const paras = out[i].split(/\n\n+/).map((x) => x.trim()).filter(Boolean);
    if (paras.length < 3) continue;                        // any less and lifting one guts the plug
    const prod = (products || []).find((pr) => pr?.link && out[i].includes(pr.link));
    const terms = substanceTermsFor(prod || {});
    if (!terms.some((tm) => paras[0].toLowerCase().includes(tm))) continue;
    // NEVER LEAVE ONE SENTENCE STANDING ABOVE THE ASK (operator 2026-09-06: "where did this type of
    // 1 sentence bridge creep back in from?"). Lifting a single-sentence lead-in manufactures exactly
    // that tweet — "Silent inflammation was the hidden factor in those sudden heart attacks." alone
    // above the plug — which thinBridgeIssue now refuses at every gate. A one-sentence lead-in stays
    // inside the plug; repost-repair's MOVE 4 gives the cold plug the library's three-line bridge.
    if (sentenceCount(paras[0]) < 2) continue;
    // A SKELETON PLUG IS NOT A FUSED LEAD-IN (2026-09-18). On the skeleton (§0b, the writing default
    // since 2026-09-13) the plug is ONE tweet and its first paragraph is the buying criterion —
    // "Which B12 works? Methylcobalamin, the form your body uses as it arrives." — with the
    // since-month protocol below it. plugStructure cannot tell that apart from a legacy fused
    // bridge: it allows 2-3 beats before the disclosure, so both the plug and what would be left of
    // it pass, the guard above never fires, and the lift runs on a plug nobody asked it to touch.
    //
    // The cost is a tweet inserted ABOVE the first ask. peach-nerve (3.54M impressions, $1,217, the
    // pool's densest nerve body) opens its ask at tweet 3 as its author wrote it and at tweet 5
    // after this lift plus the bridge repost-repair then inserts into the gap — and firstPlugIssue
    // refuses it for a delay no human introduced. Three of the five winning pot bodies the pool
    // holds were blocked this way on 2026-09-18, all three of them peach, all three clean when
    // gated as written.
    if (skeletonPlugParas(paras)) continue;
    const rest = paras.slice(1).join('\n\n');
    if (plugStructure(out[i]).ok && !plugStructure(rest).ok) continue; // healthy plug, refuse to gut it
    out[i] = rest;
    out.splice(i, 0, paras[0]);
  }
  // 2. no two full sentences stacked (never on the hook, which is the donor's words, and never
  // inside a skeleton plug, whose criterion beat is a question and its answer ON ONE LINE by
  // specification — §0b: `Which [substance] is worth it? The one [form criterion], [why].`).
  // Unstacking it splits the beat in two, the plug then reads as an extra slot, and MOVE 5 replaces
  // the author's proven copy with the pod library's. That is how peach-nerve's magnesium plug —
  // "Threonate is the form that gets in. Oxide is the cheap one in most multivitamins." — came back
  // from a repost of a 3.54M thread rewritten into generic library wording nobody approved.
  out = out.map((t, i) => {
    if (i === 0) return t;
    if (isPlug(t) && skeletonPlugParas(t.split(/\n\n+/).map((x) => x.trim()).filter(Boolean))) return t;
    const u = unstackParagraphs(t);
    return effLen(u) <= LAWS.tweet.limit ? u : t;
  });
  // 3. the account's CURRENT closing tweets, appended after the unstack so strict equality holds. The
  // sign-off is one of them only while laws.json signOff is on: with it off, a repost's old sign-off is
  // popped below with the rest of the boilerplate and not put back (owner R2026-09-26).
  if (account) {
    // A CROSS-ACCOUNT repost (fleet-wide harvest pool, operator 2026-08-27) arrives wearing the
    // SOURCE persona's sign-off, and the pop-loop below only knew the TARGET's texts — so Julian's
    // "With the deepest respect and love, Julian." survived one tweet under Lorenzo's appended
    // closer: a double sign-off carrying the wrong name. The source's boilerplate joins the pop set;
    // what gets APPENDED is unchanged — always the target account's own current texts.
    // The predicate is exported (above) rather than a closure here, because repair-drafts needs
    // exactly this test and had its own weaker one — an indexOf against the canonical string, which
    // a reworded disclaimer walks straight past.
    while (out.length && boilerish(out[out.length - 1], account, source)) out.pop();
    out.push(...[signOffOf(account), account.siteCta, account.disclaimer].filter(Boolean));
  }
  return out;
}

// ---- THE HEAVY ASK IS NEVER ONE TWEET (operator 2026-08-25) ------------------------------------
// "At least the heavy plug should follow the two structure. The light plug can be one or two tweets."
//
// A lone plug tweet is renderPod's `ctaOnly`, and that shape exists for exactly one situation: a
// donor-ad HIJACK, where the replaced span was the creator's own sell and their surviving run-up
// already taught the mechanism and the form criterion, so pasting our bridge would say it a third
// time. Everywhere else the first ask needs its own bridge tweet.
//
// This gate exists because collapsing to ctaOnly is the CHEAPEST way to satisfy the position rule.
// Chasing a link onto tweet 3 flattened all nine of 2026-08-26's drafts to a lone plug, twice in one
// day, and both times the operator caught it by eye rather than the suite.
//
// The test is STRUCTURAL rather than a declared depth, so no caller has to be trusted: on a numbered
// thread a fused bridge is visible, because the tweet before the plug still carries its item marker.
// A dedicated bridge tweet has no marker. Unnumbered prose threads are not checked — there is no
// list to fuse into, so there is nothing to detect. The LIGHT plug is deliberately never checked:
// one or two tweets are both correct there.
export function thinAskIssue(tweets = [], plugIdx = [], product = null) {
  if (!plugIdx.length) return '';
  const i = plugIdx[0];
  if (i < 1) return '';                        // a plug on tweet 1 is the position gate's business, not this one
  if (product?.donorSlot) return '';           // standing in the donor's own sell slot: ctaOnly is the right shape
  const n = (leadingNumbers(String(tweets[i - 1] || '')) || [])[0];
  if (n == null) return '';                    // its own bridge tweet, or prose — either way not fused
  if (twoBeatAsk(tweets[i - 1], tweets[i], product)) return '';   // the listicle 2-beat (below): not fused
  return `the heavy ask is ONE tweet — #${i} is numbered item ${n}, so its bridge is fused into the `
    + 'list instead of standing on its own. The heavy ask is bridge + plug (the light plug may be one).';
}

// ---- THE LISTICLE 2-BEAT IS NOT A FUSED ASK (owner 2026-11-03) ----------------------------------
// "I want the CTA formats with the best EPC." Across 1,505 Aug-Oct plugs the best earners per click
// and per view were a numbered point NAMED after the substance ("2. Creatine monohydrate") that ends
// on the trap, then ONE plug tweet that opens "Which X?" and answers it in the same tweet: criterion,
// dose and since when, one result, "This is my X: #ad" (style/cover-shape.md, "Default for a
// listicle: the 2-beat"). That is not the bolted-on bridge thinAskIssue exists to stop: the point IS
// the teaching beat and the plug carries its own criterion. Owner 2026-11-03 picked this fix ("C").
// Both halves must be there: the item's header names the plugged substance, and the plug's first
// line asks "Which X?". Anything else still needs its own bridge tweet.
const TWO_BEAT_OPEN_RE = /^\s*which\s+([a-z0-9][a-z0-9-]*)/i;
const wordsOf = (s) => String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
export function twoBeatAsk(point, plug, product = null) {
  const first = String(plug || '').split(/\n/)[0];
  const m = first.match(TWO_BEAT_OPEN_RE);
  if (!m || !first.includes('?')) return false;
  const head = String(point || '').split(/\n/)[0].replace(/^\s*\d+\s*[.)]\s*/, '').toLowerCase();
  if (!head) return false;
  const x = m[1].toLowerCase();
  if (wordsOf(head).includes(x)) return true;
  // "Which CoQ10?" under "3. Ubiquinol (active CoQ10)" reads by the word; "Which fish oil?" under
  // "Omega-3" reads by the product title the two share.
  const title = new Set(wordsOf(product?.title).filter((w) => w.length >= 4));
  return title.has(x) && wordsOf(head).some((w) => w.length >= 4 && title.has(w));
}

// Pure: give a fused bridge its own tweet. The ENGINE's non-pod path writes the bridge INTO the item
// above the plug — the model does it, and appendSubstanceBridge's deterministic fallback does it too
// — which is precisely the one-tweet ask thinAskIssue now rejects. Rather than fail those threads,
// lift the bridge out of the item and stand it between the two.
//
// The bridge is the LAST paragraph of the item that names the substance: the item's own point comes
// first, the handoff comes last, which is the shape the bridge law asks for anyway. No-ops (returns
// the same contents) when the prior is not a numbered item, when no paragraph names the substance,
// when the whole tweet IS the bridge with no item left behind, or when the thread has no room.
export function unfuseBridge(tweets = [], plugIdx = 0, terms = [], { maxThread = LAWS.tweet.maxThread } = {}) {
  const out = [...tweets];
  const i = plugIdx - 1;
  if (i < 1 || !out[i] || out.length >= maxThread) return out;
  if (!(leadingNumbers(out[i]) || []).length) return out;
  const terms0 = (terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!terms0.length) return out;
  const paras = String(out[i]).split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const k = [...paras.keys()].reverse().find((n) => n > 0 && terms0.some((t) => paras[n].toLowerCase().includes(t)));
  if (k == null) return out;
  const item = paras.slice(0, k).join('\n\n');
  if (!item.trim()) return out;
  out[i] = item;
  out.splice(i + 1, 0, paras.slice(k).join('\n\n'));
  return out;
}

// ---- plug OPENER MOVES (LAW 12c, operator 2026-08-16) -------------------------------------------
// The operator's own best plugs share a fixed skeleton and never repeat a rhetorical MOVE. The move
// is classified from the emitted text rather than declared by the writer, so this works on
// hand-written plugs and on everything already in the ledger, and needs no change to writePlugs'
// {heavy, light} contract. Order is semantic: first match wins, and the two FAILING moves are tested
// first so a spec- or brand-led opener is never mistaken for a good one that happens to also match.
export const PLUG_OPENER_MOVES = [
  // --- the two we are trying to eliminate ---
  // spec-led: opens on a dose, count or percentage. A product label, not a person talking.
  ['spec-led', /^\s*[\d,]+\s*(mg|mcg|g|iu|capsules?|softgels?|servings?|count|ct|%)\b/i],
  // brand-led: names the brand inside the first sentence. The Amazon card already shows it; putting
  // it in the first six words is what flips a tweet from a recommendation to a placement.
  ['brand-led', /^[^.!?\n]{0,80}\b(nutricost|sports research|physician'?s choice|why not natural|humann|neurogum|truskin|revo|ketologic)\b/i],
  // --- the good moves, rotate through these ---
  ['personal-limit', /\b(the one thing i (could ?n'?t|couldn't|never could)|i gave up on|i had no answer for)\b/i],
  ['admission', /\b(the mistake i made|i was wrong|i wasted|i spent (years|months|a year)|i ignored|i kept buying|i assumed|i took the cheap|for (years|two years|a year) i)\b/i],
  ['objection', /\b(the hardest part|isn'?t a (steroid|drug|gym)|it'?s not a|convincing (them|him|her)|everyone thinks|people think)\b/i],
  ['failure-mode', /\b(people (quit|give up|stop)|most people (quit|never|give up)|quit .{0,30} over the)\b/i],
  ['conditional-usage', /\b(the one i (add|reach for|use) when|i keep it separate|for the days|when the work)\b/i],
  ['form-declaration', /\b(the (right )?form|which form|the form (is|matters)|starts with the right|is the whole game)\b/i],
  // sourcing-question (operator 2026-08-17): the reader is already sold on WHAT by the rewritten
  // prior tweet; the plug opens by asking WHICH/WHERE and answering it.
  ['sourcing-question', /^\s*(so\s+)?(which|where)\b[^\n]{0,80}\?/i],
];

// Returns the opener move key for a plug tweet, or 'other' when nothing matches. Classifies on the
// FIRST beat only — the opener is the line that sets the plug's register.
export function classifyPlugMove(text) {
  const first = String(text || '').split(/\n{2,}/)[0].trim();
  if (!first) return 'other';
  for (const [key, re] of PLUG_OPENER_MOVES) if (re.test(first)) return key;
  return 'other';
}

// The moves we actively want; 'other' is allowed (a fresh move nobody has named yet).
// 'brand-led' left the ban list on 2026-08-17 (operator: "we can name the brand, removing it
// completely isn't good") — a named brand reads more honest than a coy "the one I use", and the
// card shows it anyway. Opening ON the brand is still discouraged in the prompt, but it is a taste
// call now, not a deterministic failure. 'spec-led' stays banned: a dose/count opener is a label,
// never a person.
export const BAD_PLUG_MOVES = new Set(['spec-led']);

// ---- plugBudget: how many plugs a thread of THIS length may carry -------------------------------
// Operator rule 2026-08-16. Plug count scales with the BASE thread length — the content tweets,
// counted BEFORE any plug is inserted — because a longer thread gives more away and can therefore
// ask more often without breaking the give-to-ask ratio. Two plugs in a 20-tweet thread wastes the
// reach we paid for; two plugs in an 8-tweet thread is already the ceiling.
export function plugBudget(baseLen, { products = 0 } = {}) {
  // ROUNDUP EXCEPTION (operator 2026-08-17: "we're promoting 5 supplements, let's have five
  // different plugs"). When the thread IS a product list — every item names a distinct product the
  // reader is meant to buy — the ask density argument inverts: each plug answers the item the
  // reader just read, so the budget is one per product (capped at 5), not one per N tweets. Only
  // applies at 3+ DISTINCT products; two products on a short thread is the normal length table.
  const p = Number(products) || 0;
  const B = LAWS.plugs;
  if (p >= B.roundupMinProducts) return Math.min(B.roundupCap, p);
  const n = Number(baseLen) || 0;
  if (n <= B.budget.shortMaxBody) return B.budget.shortPlugs;
  if (n <= B.budget.midMaxBody) return B.budget.midPlugs;
  return B.budget.longPlugs;
}

// ---- extraPlugSlots: positions for plugs 3..N -----------------------------------------------------
// Placed between the heavy (early) and light (deep) plugs, biased EARLY: a plug at 40% depth is seen
// by far more readers than one at 80%, and revenue per view falls off with depth. Never adjacent to
// another plug — the gap of >= 2 content tweets is what stops a thread reading as an ad break.
export function extraPlugSlots(tweets, heavyAfter, lightBefore, budget = plugBudget(tweets.length)) {
  const want = Math.max(0, budget - 2); // heavy + light are already allocated
  if (want <= 0) return [];
  const nums = tweets.map((t, i) => ({ n: (leadingNumbers(t) || [])[0], i })).filter((x) => x.n != null && x.i > heavyAfter + 1);
  const out = [];
  // Candidate insertion points = just before a numbered item, so a plug never splits a point.
  // The window used to stop short of the light plug (i < lightBefore - 1). Once the light moved one
  // point earlier (2026-09-02) that upper bound started costing a whole tracked plug on longer
  // threads — a bigger loss than the retention the move buys. It was always redundant anyway: the
  // >= 2 clear tweets check below already enforces spacing from EVERY placed plug, light included,
  // and it does so in both directions. So candidates run to the end of the body and the separation
  // rule decides, which restores the slot count the move would otherwise have given up.
  const cands = nums.map((x) => x.i - 1).filter((i) => i > heavyAfter + 1);
  for (const c of cands) {
    if (out.length >= want) break;
    // >= 2 clear tweets from every plug already placed (no two plugs adjacent, and no near-misses).
    if (![heavyAfter, lightBefore, ...out].some((p) => Math.abs(p - c) < 2)) out.push(c);
  }
  // Bias early: when more candidates exist than slots, the loop above already took the earliest.
  return out.sort((a, b) => a - b);
}

// ---- splitMergedItems: an item marker line always BEGINS its own tweet ----------------------------
// Live failure 2026-07-20: the model ended the hook/promise tweet with "1. Drop your bedroom
// temperature..." — point 1's marker fused onto the promise, its explanation orphaned in the next
// element, and the plug placement (which keys on numbered tweets) landed mid-point. Deterministic fix
// at the RAW stage (before plugs are spliced): any line that starts a numbered item ("N." / "N)") but
// is NOT the first content line of its tweet splits the tweet there. Pure; preserves blank-line
// spacing inside both halves; multiple fused markers in one tweet split repeatedly.
export function splitMergedItems(tweets) {
  const out = [];
  for (const t of tweets || []) {
    const lines = String(t).split('\n');
    let cur = [];
    for (let i = 0; i < lines.length; i++) {
      // A marker with text ("1. Do this") or BARE at end of line ("1." — live 2026-07-20 test-1 case:
      // the promise tweet ended with a lone dangling marker) both start a new element.
      if (i > 0 && /^\d+[.)](\s|$)/.test(lines[i].trim()) && cur.some((l) => l.trim())) {
        out.push(cur.join('\n').replace(/^\n+|\n+$/g, ''));
        cur = [];
      }
      cur.push(lines[i]);
    }
    out.push(cur.join('\n').replace(/^\n+|\n+$/g, ''));
  }
  // A BARE-marker element ("1." with no content) is the model dangling the number away from its point:
  // re-attach it as the prefix of the NEXT element (restoring "1. <point text>"); if the next element
  // already carries its own marker (or nothing follows), the bare marker is noise — drop it.
  const cleaned = [];
  const els = out.filter((t) => t.trim());
  for (let i = 0; i < els.length; i++) {
    const bare = els[i].trim().match(/^(\d+[.)])$/);
    if (bare && i + 1 < els.length && !/^\d+[.)](\s|$)/.test(els[i + 1].trim())) { els[i + 1] = `${bare[1]} ${els[i + 1].replace(/^\s+/, '')}`; continue; }
    if (bare) continue;
    // A bare marker HEADING its own element ("1.\n\ntext...") reads as a different style than the
    // inline items around it ("2. text") — collapse onto the first content line for consistency.
    cleaned.push(els[i].replace(/^(\d+[.)])\s*\n+\s*/, '$1 '));
  }
  return cleaned;
}

// ---- packItems: reproduce a PACKED donor's density (several one-sentence items per tweet) -----------
// The INVERSE of splitLongTweet. Some viral listicles pack multiple terse one-sentence items into ONE
// tweet (AskCoachKev: 39 items across ~14 tweets); the body pipeline otherwise renders one item per
// tweet (prompts.mjs STRUCTURE rule + splitMergedItems), inflating a 17-tweet donor into a 40+ tweet
// thread. In skeleton PACKED mode this GROUPS consecutive SIMPLE item tweets back into packed tweets of
// ~perTweet items, each kept under `limit` chars, items joined by a single newline (the "no blank line
// between bullets" convention). Only a "simple" item merges — exactly ONE leading marker, a single
// line, no elaboration block, no link/plug — so an elaborated item, a plug, or the closer always breaks
// the run and passes through untouched. Skips the hook (index 0). Marker numbers are preserved (renumber
// runs before this), so numbering stays 1..N. Pure + testable; a no-op when nothing is packable.
export function packItems(tweets, { perTweet = 3, limit = 250, startIndex = 1 } = {}) {
  const cap = Math.max(2, perTweet);
  const isSimple = (t) => {
    const s = String(t).trim();
    if (leadingNumbers(s).length !== 1) return false;         // not a lone item (already packed, or none)
    if (!/^\d{1,3}[.)]\s/.test(s)) return false;              // the marker must lead the tweet
    if (/\n\s*\n/.test(s)) return false;                      // has an elaboration block (blank line) — leave it
    if (/https?:\/\//i.test(s) || DISCLOSURE_LINE_RE.test(s)) return false;  // plug-ish — never merge
    return true;
  };
  const out = [];
  let group = [];
  const flush = () => { if (group.length) { out.push(group.join('\n')); group = []; } };
  for (let i = 0; i < (tweets || []).length; i++) {
    const t = tweets[i];
    if (i < startIndex || !isSimple(t)) { flush(); out.push(t); continue; }
    const line = String(t).trim();
    if (group.length && (group.length >= cap || (group.join('\n') + '\n' + line).length > limit)) flush();
    group.push(line);
  }
  flush();
  return out;
}

// ---- hook-block grouping: the donor's WHOLE first tweet is ONE tweet -------------------------------
// Live failure 2026-07-20 (LORWEN + Jake reviews): donors that pack hook line + authority context +
// promise into a single first tweet ending ":" kept coming back fragmented across our tweets 1-3 —
// nothing measured the donor's tweet-1 grouping. Deterministic pair, both pure + testable:
//   hookBlockIssue: when the DONOR's tweet 1 ends ":" (a packed hook block), OUR tweet 1 must too.
//   If instead a tweet within the first three ends ":" (and nothing before it is a numbered item or a
//   plug), the hook block leaked across tweets. Fails open when the donor's tweet 1 doesn't end ":".
//   mergeHookBlock: the repair — fold tweets 0..k into ONE, and while it overflows 280 drop middle
//   paragraphs starting from the one nearest the promise (tail paragraphs are usually a teaser
//   restating the promise; the earliest context carries the authority). Hook line 1 and the promise
//   line are never dropped. Returns the new tweets array, or null when even the 2-paragraph core
//   can't fit (falls to the outer retry).
const endsColon = (t) => /:\s*$/.test(String(t || '').trim());
function hookBlockEnd(tweets, plugLinks) {
  for (let k = 1; k <= 2 && k < tweets.length; k++) {
    const t = String(tweets[k] || '');
    if ((leadingNumbers(t) || []).length || (plugLinks || []).some((l) => l && t.includes(l))) return -1;
    if (endsColon(t)) return k;
  }
  return -1;
}
export function hookBlockIssue(tweets, { srcEndsColon = false, plugLinks = [] } = {}) {
  if (!srcEndsColon || !tweets?.length || endsColon(tweets[0])) return '';
  const k = hookBlockEnd(tweets, plugLinks);
  return k > 0 ? `hook block split across ${k + 1} tweets (the donor packs hook + context + promise into ONE first tweet ending ":")` : '';
}
export function mergeHookBlock(tweets, { plugLinks = [] } = {}) {
  if (!tweets?.length || endsColon(tweets[0])) return null;
  const k = hookBlockEnd(tweets, plugLinks);
  if (k < 1) return null;
  const paras = tweets.slice(0, k + 1).flatMap((t) => String(t).split(/\n{2,}/)).map((p) => p.trim()).filter(Boolean);
  while (paras.length > 2 && effLen(paras.join('\n\n')) > 280) paras.splice(paras.length - 2, 1);
  const merged = paras.join('\n\n');
  return effLen(merged) <= 280 ? [merged, ...tweets.slice(k + 1)] : null;
}

// ---- plugSubstanceMismatch: the plug's COPY must sell the product its LINK goes to -----------------
// Live 2026-07-21 (published sleep thread 7Coxfv8): plug 1 said "Research links ashwagandha to lower
// cortisol... Sports Research ashwagandha is one of the best" while its lvnta link went to Sports
// Research OMEGA-3 — the link was minted correctly for the assigned product; the plug WRITER drifted
// substance. A reader clicks expecting what the copy sold and lands on something else: conversion and
// trust both die. Deterministic, two signals, fail-open when the title has no recognizable substance:
//   1. the plug text must mention at least one substance token from the linked product's title;
//   2. the evidence line's claimed substance ("Research links X to ...") must belong to that product.
const SUBSTANCES = ['ashwagandha', 'ksm-66', 'magnesium', 'glycinate', 'omega-3', 'fish oil', 'collagen', 'berberine', 'l-theanine', 'theanine', 'zinc', 'shilajit', 'creatine', 'melatonin', 'vitamin d', ' d3', 'k2', 'nad+', 'nicotinamide', 'riboside', 'turmeric', 'curcumin', 'probiotic', 'phosphatidylserine', 'apigenin', 'glycine', 'taurine', 'ginseng', 'rhodiola', 'maca', 'tongkat', 'boron', 'b12', 'biotin', 'astaxanthin'];
export function titleSubstances(title) {
  const t = ` ${String(title || '').toLowerCase()} `;
  return SUBSTANCES.filter((s) => t.includes(s)).map((s) => s.trim());
}
export function plugSubstanceMismatch(plugText, productTitle) {
  const subs = titleSubstances(productTitle);
  if (!subs.length) return ''; // unrecognized product class — cannot judge, fail open
  const p = String(plugText || '').toLowerCase();
  if (!subs.some((s) => p.includes(s))) return `plug never names the linked product's substance (${subs[0]})`;
  const ev = p.match(/(?:research|studies|trials)\s+(?:links?|ties?)\s+([a-z0-9+\-\s]{3,40}?)\s+to\s/i);
  if (ev) {
    const claimed = ev[1].trim();
    const claimedKnown = SUBSTANCES.map((s) => s.trim()).filter((s) => claimed.includes(s));
    if (claimedKnown.length && !claimedKnown.some((c) => subs.some((ts) => ts.includes(c) || c.includes(ts)))) {
      return `plug's evidence line claims "${claimed}" but the link goes to ${subs[0]}`;
    }
  }
  return '';
}

// ---- numeralizeBulletItems: a numbered donor's list must come back numbered -------------------------
// The model sometimes mimics a source's structural quirks and renders the body as "- item" / "• item"
// bullets instead of the house "N." Arabic numerals. leadingNumbers then counts 0 items, the
// faithfulness gate fires 'dropped N item(s) vs reference', and a whole generation is burned on a purely
// COSMETIC defect. This recovers it deterministically at the RAW stage instead.
// Narrow by construction — it fires ONLY when the donor genuinely is a numbered list (srcItemCount >= 3)
// AND our draft lost essentially all numerals (< 3 leading numbers), so a narrative donor, a packed
// donor, and any already-numbered draft are all untouched. Per tweet it converts a marker only when the
// tweet holds EXACTLY ONE leading bullet line (the house one-item-per-tweet body shape); a packed block
// of >= 2 bullet lines is left alone, which is what keeps it off bulletizeRecapList's recap blocks — the
// one place bullets are deliberately CORRECT (they exist to stop a recap inflating the item count).
// Plug/link tweets, the account closing and the disclaimer are skipped. renumberLeadingMarkers runs
// downstream and forces contiguous 1..N regardless, so this only has to restore the marker SHAPE.
const BULLET_LEAD_RE = /^[ \t]*[-*•‣·▪●∙][ \t]+(?=\S)/;
export function numeralizeBulletItems(tweets, { srcItemCount = 0, account = {}, plugLinks = [], startIndex = 1 } = {}) {
  const list = tweets || [];
  if (srcItemCount < 3) return list;                              // donor isn't a numbered list — nothing to restore
  if (list.flatMap(leadingNumbers).length >= 3) return list;      // already numbered — never re-mark
  let n = 0;
  const out = list.map((t, i) => {
    const s = String(t);
    if (i < startIndex) return s;
    if (isBoilerplate(account, s)) return s;
    if (plugLinks.some((l) => l && s.includes(l))) return s;
    if (/https?:\/\//i.test(s) || DISCLOSURE_LINE_RE.test(s)) return s;
    const lines = s.split('\n');
    const bulletIdx = lines.map((ln, li) => (BULLET_LEAD_RE.test(ln) ? li : -1)).filter((li) => li >= 0);
    if (bulletIdx.length !== 1) return s;                         // 0 = not an item; >= 2 = packed/recap block
    if (lines.slice(0, bulletIdx[0]).some((ln) => ln.trim())) return s; // marker must LEAD the tweet
    n += 1;
    lines[bulletIdx[0]] = lines[bulletIdx[0]].replace(BULLET_LEAD_RE, `${n}. `);
    return lines.join('\n');
  });
  return n >= 3 ? out : list; // fewer than 3 recovered = not really a list; leave the draft untouched
}

// ---- genericSignoffIssue: engagement-bait sign-offs are the LLM's, not the account's ---------------
// style/learned-rules.md forbids appending a generic sign-off ("Follow for more", "Thanks for reading")
// but that is a PROMPT rule, and the recurring QC 'plus sign-off' signal proves the model treats the end
// of a thread as a conversational conclusion and appends one anyway. This is the deterministic backstop.
// Deliberately NOT the "hard-trim the final tweet" the retro proposed: the final tweet is ALWAYS the
// legal disclaimer and the one before it is the account's OWN closing (which checkThread REQUIRES via
// 'missing sign-off'), so trimming there would delete mandatory boilerplate. Instead it flags a generic
// bait sign-off wherever it appears in the BODY, and the existing repair/retry loop rewrites that tweet.
// Exempt by construction: the account closing, the disclaimer, any persona-signed tweet ("...\nJulian."),
// and plug tweets (a link-bearing CTA is a different, separately-gated shape). The phrase list is tight
// on purpose — bare "repost"/"retweet" is NOT matched, because every account closing opens with
// "Repost the first tweet ..."; only the engagement-bait framings are.
const GENERIC_SIGNOFF_RE = /\b(?:follow(?:\s+me)?\s+for\b|hit\s+(?:the\s+)?follow\b|smash\s+(?:that|the)\b|drop\s+a\s+like\b|like\s+and\s+(?:retweet|repost|share)\b|(?:retweet|repost|share)\s+if\s+you\b|thanks?\s+for\s+(?:reading|following|watching)\b|that'?s\s+a\s+wrap\b|turn\s+on\s+notifications\b)/i;
export function genericSignoffIssue(tweets, { account = {}, plugLinks = [] } = {}) {
  const personaRe = account.name ? new RegExp(`(^|\\n)\\s*${account.name}[.!]?\\s*$`, 'm') : null;
  const hits = (tweets || []).map((t, i) => {
    const s = String(t);
    if (isBoilerplate(account, s)) return 0;   // the account's own boilerplate (current or legacy)
    if (personaRe && personaRe.test(s)) return 0;                      // a legitimate custom persona sign-off
    if (plugLinks.some((l) => l && s.includes(l))) return 0;           // plug tweets are gated elsewhere
    return GENERIC_SIGNOFF_RE.test(s) ? i + 1 : 0;
  }).filter(Boolean);
  if (!hits.length) return '';
  return `generic engagement-bait sign-off in tweet ${hits.join(', ')} — end on substance, not "follow for more"`;
}

// stripGenericSignoff(tweet, {account}) — the deterministic REPAIR half of genericSignoffIssue
// (IMPROVEMENTS 2026-08-04, QC final pass). Detection alone already ships as a hard ERROR on both
// rails, which is right at GENERATION (the loop rewrites the tweet). At QC it is a dead end: the
// draft is already scheduled, so the error blocks the patch and qc.mjs pulls the post off the
// calendar — a whole revenue thread lost to one appended "Follow for more". This removes just that
// sentence so the thread ships clean.
//
// Mechanical only, and deliberately narrow — it deletes the offending SENTENCE and nothing else, so
// it can never touch a claim, a superlative, a product name or a link:
//   - every exemption genericSignoffIssue carves out is re-checked here (account closing, the legal
//     disclaimer, a persona-signed tweet, any link-bearing tweet), so mandatory boilerplate and the
//     separately-gated plug shape are untouchable;
//   - a sentence is kept unless GENERIC_SIGNOFF_RE matches it, and the trailing fragment (bait
//     frequently arrives with no terminal punctuation — "Follow for more") is treated as a sentence
//     so it strips too, leaving the tweet ending on the preceding punctuation mark;
//   - it FAILS CLOSED: null whenever the strip would gut the tweet (< 4 words left), leave bait
//     behind, or change nothing — and the existing hard error then blocks exactly as it does today.
// Pure + testable. Returns the repaired text, or null when there is no safe strip.
const SIGNOFF_MIN_WORDS = 4;
export function stripGenericSignoff(tweet, { account = {} } = {}) {
  const s = String(tweet);
  if (!GENERIC_SIGNOFF_RE.test(s)) return null;
  if (isBoilerplate(account, s)) return null;  // the account's own boilerplate (current or legacy)
  if (hasUrl(s)) return null;                                          // plug/link tweets are gated elsewhere
  const personaRe = account.name ? new RegExp(`(^|\\n)\\s*${account.name}[.!]?\\s*$`, 'm') : null;
  if (personaRe && personaRe.test(s)) return null;                     // a legitimate custom persona sign-off
  const sentencesOf = (line) => {
    const out = []; const re = /[^.!?]+[.!?]+[ \t]*/g; let m, last = 0;
    while ((m = re.exec(line))) { out.push(m[0]); last = re.lastIndex; }
    if (last < line.length) out.push(line.slice(last));                // trailing fragment ("Follow for more")
    return out;
  };
  const out = s.split('\n')
    .map((line) => {
      if (!GENERIC_SIGNOFF_RE.test(line)) return line;
      const kept = sentencesOf(line).filter((x) => !GENERIC_SIGNOFF_RE.test(x));
      return kept.join('').replace(/\s+$/, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
  if (!out || out === s) return null;
  if (GENERIC_SIGNOFF_RE.test(out)) return null;                       // bait survived — leave it to the gate
  if (out.split(/\s+/).filter(Boolean).length < SIGNOFF_MIN_WORDS) return null; // strip gutted the tweet
  return out;
}

// ---- evidenceClaimIssue: the plug's evidence line must ASSOCIATE, never PROMISE -------------------
// style/learned-rules.md:17, style/thread-checklist.md §4 and cta.mjs's own REJECT list all say the
// same thing four times over: plug line 2 is "Research links {substance} to {benefit}, ..." with an
// ASSOCIATION verb (links / ties / is linked to / associates with) and NEVER "proves", "guarantees",
// "cures", "treats" or "prevents". Until now that rule had NO deterministic enforcement — the only
// gate was cta.mjs's LLM judgePlug, which returns ok on ANY judge exception, so a promised
// physiological outcome could ship on a judge timeout. Recurring 'cta:evidence-*' QC signals are the
// symptom. This is the deterministic backstop, same shape as genericSignoffIssue above.
//
// Deliberately NARROW — it inspects ONLY the evidence line, not the whole plug, so line 3's marketing
// copy ("eliminates the guesswork") can't false-trip it. The evidence line is resolved two ways and
// the union is checked: (a) any claim line that opens "Research ..." (the mandated form), and (b) the
// SECOND claim line, but only in a well-formed 3-sentence plug where line 2 is the evidence beat by
// contract. A malformed plug with fewer than 3 claim lines is left to plugStructure's merged-lines
// gate rather than guessed at. Claim lines = everything before the "Aff link" disclosure, minus the
// bare-URL beat. Splits on ANY newline run so an un-normalized (single-newline) live post is read the
// same as a generated one. The legal disclaimer — which literally reads "prevent, diagnose, or treat
// disease" — and the account closing are exempt by construction. Complements HEALTH_CLAIM_RE rather
// than duplicating it: that one is a fleet-wide disease-claim block, this one is the plug-local
// association-verb contract ("proves"/"guarantees"/a bare "prevents" are invisible to it).
// Pure + testable. Returns a message naming the offending tweet + the exact verb, or ''.
const EVIDENCE_VERB_RE = /\b(?:proves?|proven|guarantees?|cures?|treats?|prevents?|eliminates?)\b/i;
export function evidenceLines(plugTweet) {
  const s = String(plugTweet);
  const url = (s.match(/https?:\/\/\S+/) || [''])[0];
  const lines = s.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const discIdx = lines.findIndex((l) => /aff\s*link|#ad|affiliate|commission/i.test(l));
  const claims = lines.slice(0, discIdx < 0 ? lines.length : discIdx)
    .filter((l) => (url ? l.replace(url, '').trim().length : l.length));
  const out = claims.filter((l) => /^research\b/i.test(l));
  if (claims.length >= 3 && !out.includes(claims[1])) out.push(claims[1]);
  return out;
}
export function evidenceClaimIssue(tweets, { account = {}, plugLinks = [] } = {}) {
  const isPlug = (s) => plugLinks.some((l) => l && s.includes(l)) || /lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(s);
  const hits = [];
  (tweets || []).forEach((t, i) => {
    const s = String(t);
    if (isBoilerplate(account, s)) return; // our own legal boilerplate (current or legacy)
    if (!isPlug(s)) return;
    for (const line of evidenceLines(s)) {
      const m = line.match(EVIDENCE_VERB_RE);
      if (m) { hits.push(`#${i + 1}("${m[0]}")`); break; }
    }
  });
  if (!hits.length) return '';
  return `plug evidence line promises an outcome instead of an association ${hits.join(', ')} — use "Research links X to ..." (links/ties/is linked to), never proves/guarantees/cures/treats/prevents`;
}

// ---- placeholder + hallucinated-plug detectors (audit 2026-07-20, finding #2) ----------------------
// A live scheduled draft carried two "Aff link:\n\n[LINK]" pseudo-plugs: the raw-body guard only drops
// http-bearing tweets, and plug detection counts by link presence — so a plug-shaped tweet with a bare
// template token was invisible to every gate. These two detectors close that class in both recreate's
// validate() and QC's checkThread().
export const PLACEHOLDER_RE = /\[(?:LINK|URL|PRODUCT|AFF[ _-]?LINK)\]|\{(?:LINK|URL|PRODUCT)\}|\{\{PLUG:[^}]*\}\}/i;
export function placeholderIssue(tweets) {
  const hits = (tweets || []).map((t, i) => (PLACEHOLDER_RE.test(String(t)) ? i + 1 : 0)).filter(Boolean);
  return hits.length ? `unfilled placeholder token ([LINK]/{PRODUCT}-style) in tweet ${hits.join(', ')}` : '';
}
// The LEGAL DISCLAIMER is not a plug. It says "this thread may contain affiliate links" and carries
// no URL by design, so it looks exactly like a hallucinated plug to a disclosure-word detector.
// This bit on 2026-08-21: widening the detector from /aff\s*link/ (which "affiliate" does NOT match)
// to the shared DISCLOSURE_LINE_RE (which it does) made every thread in the fleet report a fake plug
// on its final tweet. Caught reviewing four drafts before they were scheduled.
const BOILERPLATE_RE = /^\s*(?:DISCLAIMER|LEGAL)\s*:/i;
export function fakePlugIssue(tweets, account = null) {
  const skip = new Set([...disclaimerTexts(account), ...closingTexts(account)]);
  const hits = (tweets || []).map((t, i) => {
    const s = String(t);
    if (skip.has(s) || BOILERPLATE_RE.test(s)) return 0;     // account boilerplate, never a plug
    if (/https?:\/\//i.test(s)) return 0;                     // a tweet carrying its link is a real plug
    // TWO SHAPES OF LINKLESS PLUG. The first is ours: a disclosure line with no URL under it.
    // The second is the DONOR'S, and it shipped live in Julian's draft 10527440 (2026-08-28) —
    // the recreation copied the creator's own funnel tweet, "Here's the exact routine I lean on...
    // You can check it out here:", and there is nothing to check out. The reader is told to click
    // and handed nothing. Anchored on the instruction plus a trailing colon or arrow, so ordinary
    // prose that happens to say "here" cannot fire it.
    return (DISCLOSURE_LINE_RE.test(s) || DANGLING_CTA_RE.test(s)) ? i + 1 : 0;
  }).filter(Boolean);
  return hits.length ? `plug-shaped tweet with NO link (hallucinated plug) at tweet ${hits.join(', ')}` : '';
}
// A click instruction with nowhere to click. Must end the tweet (colon, arrow or nothing after it),
// which is what separates "you can check it out here:" from "the study is worth reading here and it
// says the opposite". Exported for tests.
export const DANGLING_CTA_RE = new RegExp(
  '(?:you can |go )?(?:check (?:it|them) out|grab (?:it|yours)|get (?:it|yours)|find (?:it|them)|see (?:it|them)|shop (?:it|them))'
  + '\\s*(?:here|below)?\\s*[:\u2193\u{1F447}]?\\s*$'
  + '|link(?:ed)? (?:is )?(?:below|here)\\s*[:\u2193\u{1F447}]?\\s*$'
  + '|(?:here|below) (?:it|they) (?:is|are)\\s*[:\u2193\u{1F447}]?\\s*$',
  'imu');

// ---- prose-placeholder detectors (hardening 2026-08-17) --------------------------------------------
// PLACEHOLDER_RE catches bracket tokens, but three LIVE defects shipped as plain prose: an all-caps
// stage direction ("NITRIC OXIDE PRODUCT PLUG"), an unfilled enumeration ("benefit 1 / benefit 2 /
// benefit 3"), and a thread whose last tweet was a colon lead-in whose payoff was never written
// (jasper 2026-08-16: "we go deeper on joe and rogan:"). Each shape is mechanically certain — no
// intended thread looks like this — so each BLOCKS in validateDraft and errors in checkThread.
// Anything fuzzier (a weak question stub, thin prose) stays the LLM QC pass's job.
export function stageDirectionIssue(tweets) {
  const KEY = /\b(PLUG|PRODUCT|INSERT|PLACEHOLDER|TBD|TODO|XXX|FILL[ _-]?IN|GOES?\s+HERE)\b/;
  const hits = [];
  (tweets || []).forEach((t, i) => {
    for (const line of String(t).split('\n')) {
      const s = line.trim();
      if (!s || !KEY.test(s)) continue;
      const letters = s.replace(/[^a-zA-Z]/g, '');
      // >=8 letters, zero lowercase: emphasis caps ("DO THIS") stay short, stage directions don't.
      if (letters.length >= 8 && letters === letters.toUpperCase()) { hits.push(`#${i + 1}("${s.slice(0, 40)}")`); break; }
    }
  });
  return hits.length ? `all-caps stage direction left in copy ${hits.join(', ')} — a writer's note shipped instead of the content` : '';
}
export function unfilledEnumIssue(tweets) {
  // A BARE token is a line (or slash-separated segment) that is nothing but "<word> <n>" — "Step 1:
  // take magnesium" has content after the number and never matches. Two or more bare tokens in one
  // tweet = an unfilled skeleton.
  const BARE = /^\s*(?:[-•*]\s*)?(?:benefit|point|item|tip|reason|step|example)\s+\d+\s*[.)]?\s*$/i;
  const hits = [];
  (tweets || []).forEach((t, i) => {
    const parts = String(t).split('\n').flatMap((l) => (l.includes('/') ? l.split('/') : [l]));
    if (parts.filter((p) => BARE.test(p)).length >= 2) hits.push(i + 1);
  });
  return hits.length ? `unfilled enumeration (bare "benefit 1 / benefit 2" skeleton) in tweet ${hits.join(', ')}` : '';
}
// ---- plug substance bridge (operator law 2026-08-17) -----------------------------------------------
// "The tweet before the CTA is always talking about that one specific substance." The plug writer now
// rewrites each prior tweet to land on the substance; this is the deterministic gate that makes the
// law unskippable. Substance vocabulary comes from the BRIDGE map (keys mapping to the product's ASIN,
// plus any BRIDGE key present in the product title) — a product with no known vocabulary scores
// neutral rather than guessing from title tokens.
export function substanceTermsFor(product = {}) {
  const asin = product.asin || '';
  const title = String(product.title || '').toLowerCase();
  const terms = new Set();
  // Word boundaries on the TITLE arm, the same idiom _bridgeRes uses. Plain `includes` matched "dha"
  // inside "ashwagan-dha", so substanceTermsFor(ashwagandha) carried an omega-3 term and an omega
  // run-up satisfied the hard bridge gate before an ashwagandha plug. The asin arm needs no
  // boundary: it is an equality check, not a text search.
  for (const [sub, a] of Object.entries(BRIDGE)) if (a === asin || wordIn(title, sub)) terms.add(sub);
  // The symptom words this product answers. Keyed on the ASIN, exactly as the BRIDGE arm above is,
  // because that is the job they used to do here — they were removed from BRIDGE so they can no
  // longer ROUTE, and reinstated here so a correct bridge ("your 3am cortisol spike" -> ashwagandha)
  // still reads as one. See SYMPTOM_TERMS.
  for (const w of SYMPTOM_TERMS[asin] || []) terms.add(w);
  // Recognition-only vocabulary: matched on the TITLE alone, never on the asin, because these words
  // carry no routing meaning. Without them a product we stock but cannot name reads as a product the
  // body never argued for. See SUBSTANCE_WORDS.
  for (const w of SUBSTANCE_WORDS) if (wordIn(title, w)) terms.add(w);
  return [...terms];
}
/**
 * ERROR: a plug points at an ASIN on the DENY list.
 *
 * DENY existed and was not enforced anywhere a plug is actually built. Measured 2026-08-26: five
 * denied ASINs took 32 plugs since 1 August, drawing 3,219 clicks for $425 — EPC $0.132 against a
 * $0.348 fleet, so roughly $1,059 of the gap. B0CV2RSRFX alone took 19 plugs while sitting on the
 * list, and NAD+ took 10.
 *
 * The bypass is structural rather than a single missing line: pick-product filters DENY when it
 * CHOOSES a product, but the pod path, hand-written specs and repost re-mints all arrive carrying an
 * ASIN somebody already picked, so nothing on those paths ever consults the list. The fix is to
 * check where every lane converges instead of at each entry: validateDraft (nothing ships) and the
 * mint scripts (nothing is even created). A denied ASIN with no link cannot become a plug.
 */
export function denyIssue(products = []) {
  const hits = (products || []).map((p) => p?.asin).filter((a) => a && DENY_ASINS.has(a));
  if (!hits.length) return '';
  const why = [...new Set(hits)].map((a) => {
    const note = (_policy.deny || []).find((d) => d.asin === a)?.note;
    return note ? `${a} (${String(note).slice(0, 90)})` : a;
  });
  return `DENY-listed product in the plug: ${why.join(', ')} — this ASIN is on the never-link list in keep-asins.json, swap it before shipping`;
}

export function plugSubstanceBridgeIssue(tweets, products = []) {
  const hits = [];
  for (const p of products) {
    if (!p?.link) continue;
    const i = (tweets || []).findIndex((t) => String(t).includes(p.link));
    if (i <= 0) continue; // no plug tweet for this product, or it IS tweet 1 (nothing prior to bridge)
    const terms = substanceTermsFor(p);
    if (!terms.length) continue;
    const prior = String(tweets[i - 1]).toLowerCase();
    if (!terms.some((s) => prior.includes(s))) hits.push(`#${i + 1} (prior tweet never names ${terms[0]})`);
  }
  return hits.length ? `plug bridge missing: ${hits.join(', ')} — the tweet BEFORE a plug must land on the plugged substance` : '';
}

// THE THREAD'S OWN SUBJECT MUST BE THE THING WE SELL (operator 2026-08-25).
//
// The failure this exists for, in full, because the shape repeats. Jasper's resting-heart-rate thread
// carried "2. Restore nitric oxide" and five more tweets of nitric-oxide argument, including the
// donor's own sell slot. pod-place read all of it correctly and made nitric oxide PLUG 1. Then its
// ASIN 404'd at mint, the substance was swapped instead of the LISTING, and the thread shipped
// selling magnesium next to an item about nitric oxide. Every individual gate passed: the plug had a
// bridge, the bridge named magnesium, the criterion was in order. Nothing was watching the thread as
// a whole, so a planned plug could disappear and no check could tell.
//
// The rule: if a thread argues a substance HARD and we have a live route to it, that substance has to
// be one of the things the thread sells. "Hard" is deliberately a high bar — a passing mention is not
// a promise, and the point is to catch abandonment, not to force a plug into every noun.
export const UNSOLD_MIN_TWEETS = 3;
/**
 * Substances a SOLD product legitimately answers beyond the BRIDGE keys that route to it.
 *
 * The family map below joins BRIDGE keys that share a route ASIN, which covers "we stock three
 * bottles of the same thing". It cannot cover the other real case: two DIFFERENT molecules where one
 * is the body's road to the other. Live on 2026-08-28, fifth engine run — Rafael's thread taught beet
 * root, plugged beet root, and said so in its own words ("Beet root is the densest food source of
 * dietary nitrate, which your body turns into nitric oxide"), and the gate failed it for arguing
 * nitric oxide without selling it. The thread was right and the gate was wrong.
 *
 * BRIDGE's own note already records the ruling (2026-08-25): beet root is dietary nitrate, "the
 * body's other road to nitric oxide, so NO/BP/blood-flow prose is honest over it via pod BR1".
 * Citrulline and arginine deliberately stay OFF that list — the same note calls them "neighbor, not
 * native", a molecule beet does not contain — so a citrulline thread selling beet still fails, which
 * is exactly the substance-swap this gate exists to catch.
 */
export const SOLD_ALSO_SATISFIES = {
  B09SFFJP1P: ['nitric oxide'],                                        // beet root -> nitrate -> NO
  B07S424N6V: ['nitric oxide', 'blood flow', 'blood pressure'],        // arginine/citrulline, native
};

export function unsoldSubstanceIssue(tweets = [], products = [], { allowUnsold = [] } = {}) {
  const list = (tweets || []).map((t) => String(t || ''));
  if (!list.length) return '';
  const plugIdx = list.map((t, i) => (/lvnta\.com|amazon\.com\/dp\/|geni\.us\//i.test(t) ? i : -1)).filter((i) => i >= 0);
  if (!plugIdx.length) return ''; // an unmonetized thread promises nothing — not this gate's business
  // What the thread sells, by FAMILY rather than by ASIN. A BRIDGE key routes to one canonical row,
  // but we stock several bottles of most substances, and selling a different one is not abandoning
  // the argument. Live case: Rafael argues "inflammation" (routes to the fish-oil omega) and plugs
  // the ALGAE omega — same family, different ASIN. Matching on the asin alone called that a defect.
  // Family = every BRIDGE key sharing a route, so a plugged product naming any of them sells all of
  // them: the algae bottle's title carries "omega-3" and "fish oil", which is the family.
  const familyOf = new Map(); // bridge key -> the set of keys sharing its route
  {
    const byRoute = new Map();
    for (const [k, asin] of Object.entries(BRIDGE)) { if (!byRoute.has(asin)) byRoute.set(asin, new Set()); byRoute.get(asin).add(k); }
    for (const [k, asin] of Object.entries(BRIDGE)) familyOf.set(k, byRoute.get(asin));
  }
  const sold = new Set();
  for (const p of products || []) {
    if (!p?.link || !list.some((t) => t.includes(p.link))) continue;
    for (const s of substanceTermsFor(p)) { sold.add(s); for (const sib of familyOf.get(s) || []) sold.add(sib); }
    // ...plus the substances this bottle answers that its own title never names (see the map above).
    // These are added LITERALLY, never family-expanded: 'nitric oxide' shares a route with citrulline
    // and arginine, so expanding it would let beet root satisfy a citrulline thread — the exact
    // neighbour-not-native swap the map's own note rules out.
    for (const s of SOLD_ALSO_SATISFIES[p.asin] || []) sold.add(s);
  }
  const waived = new Set((allowUnsold || []).map((s) => String(s).toLowerCase()));
  // What the thread argues: BRIDGE vocabulary, counted per tweet, ignoring the plug tweets themselves
  // (a plug naming its own substance is not the body making a case for it).
  const body = list.filter((_, i) => !plugIdx.includes(i));
  const hits = [];
  for (const [rx, asin] of _bridgeRes) {
    const term = String(rx.source).replace(/\\b/g, '').replace(/\\/g, '');
    if (sold.has(term) || waived.has(term)) continue;
    const where = body.map((t, i) => (rx.test(t) ? i : -1)).filter((i) => i >= 0);
    if (where.length >= UNSOLD_MIN_TWEETS) hits.push({ term, asin, n: where.length });
  }
  if (!hits.length) return '';
  // One substance, one complaint: several BRIDGE keys share an ASIN (nitric oxide / citrulline /
  // arginine all route to the beet root), and reporting each separately reads as three defects.
  const byAsin = new Map();
  for (const h of hits.sort((a, b) => b.n - a.n)) if (!byAsin.has(h.asin)) byAsin.set(h.asin, h);
  const worst = [...byAsin.values()].sort((a, b) => b.n - a.n);
  return `thread argues ${worst.map((h) => `"${h.term}" across ${h.n} tweets (route ${h.asin})`).join(', ')} but never sells it — `
    + 'the reader was walked to that substance and handed a different one. Plug it, or drop the argument, '
    + 'or declare it deliberate with allowUnsold on the spec.';
}

// ONE SENTENCE PER LINE IN A BRIDGE (operator 2026-08-25, third time asked). The bridge is the tweet
// the reader is on when they decide whether to click. Two sentences glued into one paragraph read as
// a block and get skimmed — and the contrast that IS the bridge ("glycinate absorbs / oxide passes
// through") is exactly the pair that gets glued. The general no-walls rule allows a pair; a bridge
// does not. SENTENCE_SPLIT's [^0-9] lookbehind keeps a numbered item header whole ("3. Recharge the
// cell engine" is one line, not two) and leaves decimals alone.
export const SENTENCE_SPLIT = /(?<=[^0-9][.!?])\s+(?=["“'(]?[A-Z])/;
// airyParagraphs — the deterministic fixer, shared by the pod library and the live-draft repair so
// the gate and the fix can never disagree. Idempotent: airy text in, same text out.
export function airyParagraphs(text) {
  return String(text || '')
    .split(/\n\n+/)
    .map((p) => p.replace(/[ \t]+$/gm, '').trim())
    .filter(Boolean)
    // A paragraph already carrying a line break is a deliberate list block — never re-flow it.
    .map((p) => (/\n/.test(p) ? p : p.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean).join('\n\n')))
    .join('\n\n');
}
// glued paragraphs = the ones airyParagraphs would break apart. Callers decide the severity.
export function gluedParagraphs(text) {
  return String(text || '')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p && !/\n/.test(p) && !TITLE_FRAME_LINE.test(p) && p.split(SENTENCE_SPLIT).filter((s) => s.trim()).length >= 2);
}
// A numbered point title in the signs-list frame (owner 2026-11-21, plug-lint title-frame):
// "3. Short, broken sleep? I take Magtein, an hour before bed". The "?" is part of ONE title line,
// not two glued sentences; splitting it would break the frame the title-frame rule asks for.
export const TITLE_FRAME_LINE = /^(?:\d+[.)]\s+)?[^\n?]{2,90}\?\s+I (?:take|add)\b[^\n.?!]*$/;
// ---- STACKED SENTENCES (operator 2026-08-25) ----------------------------------------------------
// "Overall we don't want to stack 2 sentences together. If staccato then it's fine."
//
// airyParagraphs splits EVERY multi-sentence paragraph. That is right for a bridge and wrong
// everywhere else: it would turn "Sounds gross. Looks weirder." into two orphan lines and kill the
// voice. What separates the two cases is LENGTH. Two full sentences stacked in one block is a wall
// the eye slides off; a run of short beats is rhythm and belongs together.
//
// So these split only a paragraph whose every sentence clears stackedMin. The bar is 30, not 40:
// "Hydrolyzed peptides daily since spring." is 38 characters and is plainly prose, while real
// staccato runs well under 25 ("Sounds gross." 13, "Just today." 11, "Pause." 6). 40 let six walls
// through on the 2026-08-26 slate, five of them plug middles. Measured on the
// 2026-08-26 slate: 46 glued paragraphs, of which 16 were prose runs (10 of them plug middles, the
// shape the plug skill itself prescribes) and 30 were staccato. The engine's own respacer misses
// both classes, because it skips plug tweets outright and only fires on a tweet carrying no line
// break at all — a stacked pair inside an already-spaced tweet sails past it.
export const STACKED_MIN = LAWS.tweet.stackedMin;
const longSentences = (p, min) => {
  const parts = String(p).split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 && parts.every((s) => s.length >= min) ? parts : null;
};
export function stackedParagraphs(text, { min = STACKED_MIN } = {}) {
  return String(text || '').split(/\n\n+/).map((p) => p.trim())
    // a paragraph already carrying a line break is a deliberate list block — same rule as airyParagraphs
    .filter((p) => p && !/\n/.test(p) && longSentences(p, min));
}
// The fixer. Idempotent, and it leaves every staccato run exactly as written.
export function unstackParagraphs(text, { min = STACKED_MIN } = {}) {
  return String(text || '').split(/\n\n+/).map((p) => p.replace(/[ \t]+$/gm, '').trim()).filter(Boolean)
    .map((p) => { if (/\n/.test(p)) return p; const parts = longSentences(p, min); return parts ? parts.join('\n\n') : p; })
    .join('\n\n');
}
// Gate. The HOOK is exempt: it is copied from the donor word for word and its shape is not ours to
// fix. Account boilerplate is exempt for the same reason — it is matched by strict equality
// elsewhere, so re-spacing it would break the closing/disclaimer checks.
export function stackedSentenceIssue(tweets = [], account = null) {
  const hits = [];
  (tweets || []).forEach((t, i) => {
    if (i === 0) return;
    if (account && isBoilerplate(account, t)) return;
    const st = stackedParagraphs(t);
    if (st.length) hits.push(`#${i + 1} ("${st[0].slice(0, 52)}...")`);
  });
  return hits.length
    ? `stacked sentences: ${hits.join(', ')} — two full sentences in one paragraph reads as a wall. `
      + 'One per line (a run of short staccato beats may stay together).'
    : '';
}
// ---- RHYTHM (operator 2026-09-13, writing the first remix by hand) -----------------------------
// "make sure none of our sentences are too long. Goal is to make it skimmable, so spacing + variety
// in sentence length." · "bar the listicle, I want no more than 4 paragraphs. Ideally it's between
// 3 - 4." · bullets run inline on one line, not one per line.
//
// These lived only in the remix skill's prose, so they bound the operator writing by hand and bound
// nothing else: recreate.mjs and /pot could violate all three silently. Advisory by design, like
// the backline lint above — a regex that grades taste rejects good writing — but measurable, named
// per tweet, and printed on every lane rather than only the one that happened to be hand-written.
//
// The STACKING axis is NOT re-litigated here. stackedSentenceIssue (operator 2026-08-25) owns it,
// and the two rulings already agree through STACKED_MIN: a run of short beats is rhythm and passes,
// two long sentences glued in one block is a wall and fails.
export const RHYTHM_MAX_WORDS = LAWS.tweet.maxSentenceWords;
export const RHYTHM_MAX_PARAS = LAWS.tweet.maxParagraphs;

// A SENTENCE, for this gate, is a segment that ends in terminal punctuation. That is exactly the
// operator's carve-out — "the title line of an item is not a sentence" — and it also spares the
// inline bullet row and the CTA line, neither of which is prose and neither of which reads long.
const RHYTHM_SENTENCES = (text) => String(text || '')
  .split(/\n+/)
  .flatMap((line) => line.split(SENTENCE_SPLIT))
  .map((s) => s.trim())
  .filter((s) => /[.!?…]["'’)]?$/.test(s));

const rhythmWords = (s) => String(s).replace(/^\s*[\d•\-*]+[.):]?\s*/, '').split(/\s+/).filter(Boolean).length;

// Skip what is not ours to shape: the hook is the donor's words, boilerplate is matched by strict
// equality elsewhere, and a bare link line is not writing.
//
// The COMPLIANCE tweet needs its own test rather than isBoilerplate alone. isBoilerplate is exact
// equality against the account's registered closing/disclaimer, and an account can have none on
// file — disclaimerTexts('burner') is [], so the burner's own disclosure tweet ("...a few links
// above are affiliate links... the FDA has not reviewed these statements") read as a 20-word prose
// sentence and got flagged. It is fixed legal text, not writing, on every account that carries it.
//
// The test is deliberately narrow, because DISCLOSURE_RE alone would swallow every plug: a plug
// carries "#ad" AND its link, so requiring NO url excludes plugs by construction, and requiring the
// medical notice as well excludes a body tweet that merely says "affiliate" or "commission" (words
// disclosure.mjs itself warns appear in ordinary copy).
const MEDICAL_NOTICE_RE = /\bFDA\b|medical advice|not (?:a )?doctor|your doctor|healthcare provider|consult/i;
const isComplianceTweet = (t) => {
  const s = String(t || '');
  return !hasUrl(s) && DISCLOSURE_LINE_RE.test(s) && MEDICAL_NOTICE_RE.test(s);
};

const rhythmSkip = (t, i, account) => i === 0
  || (account && isBoilerplate(account, t))
  || isComplianceTweet(t)
  || /^\s*(?:https?:\/\/\S+|\{\{LINK\d*\}\})\s*$/.test(String(t));

export function longSentenceIssue(tweets = [], account = null, { max = RHYTHM_MAX_WORDS } = {}) {
  const hits = [];
  (tweets || []).forEach((t, i) => {
    if (rhythmSkip(t, i, account)) return;
    for (const s of RHYTHM_SENTENCES(t)) {
      const n = rhythmWords(s);
      if (n > max) { hits.push(`#${i + 1} ${n}w ("${s.slice(0, 48)}...")`); break; }
    }
  });
  return hits.length
    ? `long sentences: ${hits.join(', ')} — over ${max} words reads as prose, not as something scanned. `
      + 'Cut it or split it; vary the lengths so a short line sits next to a long one.'
    : '';
}

// "bar the listicle" — a numbered item carries its title line plus its body and is allowed to run
// longer. Everything else holds at four blocks, counting a bullet block as one and the link as one.
export function paragraphCapIssue(tweets = [], account = null, { max = RHYTHM_MAX_PARAS } = {}) {
  const hits = [];
  (tweets || []).forEach((t, i) => {
    if (rhythmSkip(t, i, account)) return;
    if ((leadingNumbers(t) || []).length) return;
    const paras = String(t).split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    if (paras.length > max) hits.push(`#${i + 1} (${paras.length})`);
  });
  return hits.length
    ? `over ${max} paragraphs: ${hits.join(', ')} — stack two short sentences to bring it down, `
      + 'except above a plug, where the bridge trims a line instead (bridgeWallIssue forbids the stack there).'
    : '';
}

// "Bullets run inline on one line" — `• Sardines • Organ meats • Peanuts`, not three lines for three
// words. Two or more consecutive bullet lines inside one tweet is the vertical list.
const BULLET_LINE = /^\s*[•·▪‣]\s*\S/;
export function verticalBulletIssue(tweets = [], account = null) {
  const hits = [];
  (tweets || []).forEach((t, i) => {
    if (rhythmSkip(t, i, account)) return;
    const lines = String(t).split(/\n/).map((l) => l.trim());
    let run = 0;
    for (const l of lines) {
      if (BULLET_LINE.test(l)) { run += 1; if (run >= 2) { hits.push(`#${i + 1}`); break; } } else run = 0;
    }
  });
  return hits.length
    ? `vertical bullets: ${hits.join(', ')} — run them inline on one line `
      + '(• Sardines • Organ meats • Peanuts), so the agitate and the caution keep their own paragraphs.'
    : '';
}

/** All three, as {kind, msg} rows. Advisory: callers print, they do not refuse. */
export function rhythmIssues(tweets = [], account = null) {
  return [
    ['long-sentence', longSentenceIssue(tweets, account)],
    ['paragraph-cap', paragraphCapIssue(tweets, account)],
    ['vertical-bullets', verticalBulletIssue(tweets, account)],
  ].filter(([, msg]) => msg).map(([kind, msg]) => ({ kind, msg }));
}

// ---- THE ONE-SENTENCE BRIDGE (operator 2026-09-06) --------------------------------------------
// "Where did this type of 1 sentence bridge creep back in from? ... this will just waste our money."
// A bridge is three lines: the wrong form, what it costs, "So this is what I look for ↓". A lone
// sentence standing above the ask ("Vitamin D is the real driver here, not just zinc.") is the
// pre-2026-08-25 shape, and it came back through the harvest lane two ways: Julian's Aug-26 origin
// carried one and was reposted verbatim, and the repair lifts (repostRepairs move 1 above,
// repost-repair MOVE 3.5) manufactured four more by carving a plug's first sentence into its own
// tweet to satisfy the bridge law. Both lifts now refuse to leave a single sentence behind, and
// this gate refuses whatever still arrives that way, on every path, so the shape cannot ship again.
//
// Structural, not lexical: the tweet immediately above a plug, carrying no link of its own, that
// holds ONE sentence. A numbered marker on its own line is not a sentence. Bullet lines count as
// sentences, because a bulleted point above the ask is a point, not a lone line.
export const sentenceCount = (t) => String(t || '').replace(/^\s*\d+[.)]\s*/, '')
  .split(/\n+|(?<=[.!?…])\s+/).map((s) => s.trim()).filter((s) => s && !/^\d+[.)]$/.test(s)).length;
export function thinBridgeIssue(tweets = [], products = []) {
  const links = (products || []).map((p) => p?.link).filter(Boolean);
  const isPlug = (t) => links.some((l) => String(t).includes(l)) || /lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(String(t));
  const arr = (tweets || []).map((t) => String(t ?? ''));
  for (let i = 1; i < arr.length; i++) {
    if (!isPlug(arr[i]) || isPlug(arr[i - 1])) continue;
    if (sentenceCount(arr[i - 1]) >= 2) continue;
    // A numbered ITEM above the ask is a fused bridge, which thinAskIssue already names for the
    // heavy plug; this gate is for the unnumbered lone sentence the operator pointed at.
    if ((leadingNumbers(arr[i - 1]) || []).length) continue;
    const quoted = arr[i - 1].replace(/\s+/g, ' ').trim().slice(0, 70);
    return `one-sentence bridge above the plug at #${i + 1} — tweet ${i} is a single sentence ("${quoted}"); a bridge is three lines: the wrong form, what it costs, "So this is what I look for ↓"`;
  }
  return '';
}

// The heavy 3-beat criterion (owner 2026-11-16, cta-spec §0a): setup + "But most ..." in paragraph 1,
// the agitation + "Here's the {thing} on the back to check: ↓" in paragraph 2. At most 3 paragraphs.
export function isStackedCriterion(text) {
  const t = String(text || '').trim();
  if (!/\bBut most\b/.test(t) || !/:\s*↓$/.test(t)) return false;
  return t.split(/\n\n+/).filter((p) => p.trim()).length <= 3;
}

export function bridgeWallIssue(tweets, products = []) {
  const hits = [];
  for (const p of products) {
    if (!p?.link) continue;
    // EVERY occurrence, not the first. findIndex checked only the first tweet carrying a link, so a
    // product plugged twice had its second bridge silently unchecked — two glued bridges shipped
    // past this gate on 2026-08-26's slate before the end-to-end audit caught them.
    for (let i = 0; i < (tweets || []).length; i++) {
      if (!String(tweets[i]).includes(p.link)) continue;
      // i < 2, not i < 1: a plug at tweet 2 would make the HOOK its bridge, and the hook is copied
      // verbatim from a donor that already earned its views — re-spacing it is never the right fix.
      if (i < 2) continue;
      // The heavy CRITERION tweet is stacked on purpose (owner 2026-11-16): two short paragraphs,
      // "But most ..." agitated, ending "Here's the X on the back to check: ↓". Exempt that shape only;
      // every other bridge (the light point included) stays one sentence per line.
      if (isStackedCriterion(tweets[i - 1])) continue;
      const glued = gluedParagraphs(tweets[i - 1]);
      if (glued.length) hits.push(`#${i} ("${glued[0].slice(0, 60)}...")`);
    }
  }
  return hits.length
    ? `bridge stacks sentences in one paragraph: ${hits.join(', ')} — one sentence per line, blank line between`
    : '';
}

// appendSubstanceBridge — the DETERMINISTIC guarantee behind the bridge law. The LLM pass writes the
// good version; this is what runs when it has failed its retries (live: three consecutive runs where
// the rewrite simply never contained the required word, on two different models). One plain sentence,
// appended as the item's own final beat, only when it actually fits under 280. Pure + testable.
// Returns the tweet unchanged when a term is already present or nothing fits.
export function appendSubstanceBridge(tweet, terms = [], limit = 280) {
  const orig = String(tweet || '');
  if (!orig.trim() || !terms.length) return orig;
  const lower = orig.toLowerCase();
  if (terms.some((t) => lower.includes(String(t).toLowerCase()))) return orig;
  const line = `That is where ${terms[0]} comes in.`;
  // These item tweets routinely run 240-270 chars, so "append if it fits" no-ops exactly when it is
  // needed (live: three runs where the fallback silently did nothing). The bridge OUTRANKS the
  // item's last aside — a plug with no bridge is worth less than an item one line shorter — so shed
  // trailing sentences/list lines until the bridge fits, never below a readable floor.
  let body = orig.replace(/\s+$/, '');
  for (let guard = 0; guard < 12; guard++) {
    const out = `${body}\n\n${line}`;
    if (effLen(out) <= limit) return out;
    const cut = body.replace(/\s*[^.!?\n]+[.!?]*\s*$/, '').trim();
    if (!cut || cut === body || cut.length < 60) break;
    body = cut;
  }
  return orig;
}

// hookIdenticalIssue — the 90-95% hook rule's deterministic floor (operator 2026-08-17: "let's take
// it to 90-95%, not 100%, since X can identify our posts"). Keeping the donor's shape is the whole
// point; shipping a BYTE-IDENTICAL hook against a post with millions of views is the one version
// that hands X an exact-match string. Normalizes whitespace, case and smart punctuation so a
// cosmetic difference does not count as a rewrite. Returns a message or ''. Pure + testable.
export function hookIdenticalIssue(ourHook, donorHook) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'"%+.,:?!\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(ourHook), b = norm(donorHook);
  if (!a || !b) return '';
  return a === b ? 'hook is byte-identical to the donor hook — change two or three non-load-bearing words (90-95%, never 100%)' : '';
}

export function danglingLeadInIssue(tweets) {
  const last = String((tweets || []).at(-1) || '').trim();
  if (!/:$/.test(last)) return '';
  // The self-QRT echo legitimately ends on ":" — its payoff is the NATIVE quote card the posts
  // builder attaches by prefix match (self-qrt.mjs). Anything else ending on a colon lost its payoff.
  if (last.startsWith(SELF_QRT_ECHO_PREFIX)) return '';
  return `thread ends on a colon lead-in ("${last.slice(-60)}") — the payoff tweet is missing`;
}

// ---- bulletizeRecapList: a packed RECAP block is not a fresh run of items --------------------------
// Live failure 2026-07-20 (matthew_labosco): a 14-item thread closed with a recap that re-listed every
// item as ONE packed block numbered 15..28 (continuing the sequence). leadingNumbers then counted 28
// items (14 real + 14 phantom recap) and the block ran 432 chars. A real item is ONE marker per tweet;
// a tweet holding >=3 leading-number lines is ALWAYS a summary/recap block. Convert its markers to
// bullets so it reads as a clean checklist and stops inflating the item count, then split it at line
// boundaries if the bulletized block still exceeds 280. Pure + deterministic.
export function bulletizeRecapList(tweets) {
  const out = [];
  for (const t of (tweets || [])) {
    const s = String(t);
    const lines = s.split('\n');
    const markerLines = lines.filter((l) => /^[ \t]*\d+[.)]\s/.test(l)).length;
    if (markerLines < 3) { out.push(t); continue; }        // not a packed list — a real item is 1 marker/tweet
    const bulleted = lines.map((l) => l.replace(/^([ \t]*)\d+[.)]\s+/, '$1• ')).join('\n');
    if (effLen(bulleted) <= 280) { out.push(bulleted); continue; }
    let cur = '';                                          // too long -> split at line boundaries, packing <=280
    for (const l of bulleted.split('\n')) {
      const cand = cur ? `${cur}\n${l}` : l;
      if (effLen(cand) <= 280) cur = cand;
      else { if (cur) out.push(cur); cur = l; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// ---- attachFirstItemToHook: some donors pack the FIRST item's marker line into tweet 1 -------------
// Live failure 2026-07-20 (Austin supplements review): the donor's tweet 1 is TWO blocks — the hook
// line AND the first item's marker line ("The supplements you need...:\n\n1. Zinc in the morning.") —
// with that item's elaboration in tweet 2. Our thread split the marker into its own tweet, so tweet 1
// was a lone hook sentence, not the donor's two-block group. This is a DISTINCT shape from the colon
// hook block (that tweet 1 ends ":"; this one ends on the item line), so hookBlockIssue never caught it.
// tweetAttachesItem: does this tweet carry a numbered marker in a LATER block (a hook line first, then
// a "N. ..." block)? — the signature of the attached-first-item shape. A tweet whose FIRST block is the
// marker (the classic faithful "hook IS item 1" shape) is deliberately excluded.
const tweetAttachesItem = (t) => {
  const blocks = String(t || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.length >= 2 && !/^\d+[.)]\s/.test(blocks[0]) && blocks.slice(1).some((b) => /^\d+[.)]\s/.test(b));
};
// Does the DONOR's first tweet attach its first item? (same test — used to decide whether ours must too.)
export function srcTweet1AttachesItem(srcTweet1) { return tweetAttachesItem(srcTweet1); }
/**
 * attachRuleApplies(srcTweet1, {skelMode, format}) — does the attach rule hold for THIS donor?
 *
 * Two donor-derived rules can contradict, and shapeMetrics carries both facts side by side
 * (`format` and `hook1AttachesItem`):
 *   - a NARRATIVE donor has no list, so recreate.mjs strips every "N." marker from our thread
 *     (skeleton.mjs: itemCount < 3 => 'narrative', deliberately loose so a stray marker or two
 *     still reads as narrative),
 *   - an ATTACHING donor requires tweet 1 to CARRY the first item's "N." marker.
 * Both at once means one repair deletes the exact token the other demands: attachFirstItemToHook
 * finds no marker to fold, returns the thread untouched, and hookAttachIssue vetoes every roll
 * with a defect nothing in the pipeline can fix.
 *
 * Live 2026-08-13 (marcos smoke run): donor tweet 1 was "What 200g of protein actually looks like
 * in a day.\n\n1. Breakfast" and then abandoned numbering for the rest of the thread — the exact
 * stray-marker shape the strip exists for. Both validate-repair passes were silent no-ops and the
 * draft was vetoed after paying for the full generation.
 *
 * FORMAT WINS: no markers means no attach rule. Pure + testable.
 */
export function attachRuleApplies(srcTweet1, { skelMode = false, format = '' } = {}) {
  if (!srcTweet1AttachesItem(srcTweet1)) return false;
  return !(skelMode && format === 'narrative');
}
// Gate: when the donor attaches the first item to tweet 1, ours must too. Fails open otherwise.
export function hookAttachIssue(tweets, { srcAttaches = false } = {}) {
  if (!srcAttaches || !tweets?.length) return '';
  return tweetAttachesItem(tweets[0]) ? '' : `hook tweet omits the first item marker (the donor packs its first item's "N." line into tweet 1)`;
}
// Repair/reshaper: fold the first item's MARKER LINE (only) up into the hook tweet, mirroring the donor.
// The item's elaboration stays its own tweet (the donor puts it in tweet 2). Deterministic + pure. If
// the merge would exceed 280 it is left split — the gate fires and the outer retry regenerates.
export function attachFirstItemToHook(tweets, { srcAttaches = false } = {}) {
  if (!srcAttaches || !Array.isArray(tweets) || tweets.length < 2) return tweets;
  if (tweetAttachesItem(tweets[0])) return tweets;                 // hook already carries the first item
  if (/^\d+[.)]\s/.test(String(tweets[0]).trim())) return tweets;  // hook IS item 1 (classic) — never touch
  // Find the FIRST marker-headed tweet, scanning up to 3 tweets in (live 2026-07-20 labosco miss: the
  // model put a context/promise tweet between the hook and "1. ...", so a tweets[1]-only check whiffed
  // and the gate fell through to a full re-roll). Bounded: item 1 further than tweets[3] means the
  // shape is structurally off — leave it for the gate/outer retry rather than guess.
  let k = -1;
  for (let i = 1; i <= 3 && i < tweets.length; i++) {
    if (/^[ \t]*\d+[.)]\s/.test(String(tweets[i]))) { k = i; break; }
  }
  if (k < 0) return tweets;                                        // no early numbered item — nothing to attach
  const t1 = String(tweets[k]);
  const mk = t1.match(/^[ \t]*\d+[.)]\s[^\n]+/);                   // the first item's marker line at the head of that tweet
  if (!mk) return tweets;
  // The donor packs hook + first item into ONE compact tweet — so an over-stuffed hook (live labosco
  // 2026-07-20: a 279-char, 3-block hook left no room for the 28-char marker line, the attach bailed,
  // and the gate ping-ponged the roll to death) is itself off-mold. Make room the way the donor does:
  // drop the LONGEST middle flavor block (never line 1, never the final promise line) until the marker
  // fits. What gets dropped is exactly the padding the donor's compact tweet 1 never had.
  const hookBlocks = String(tweets[0]).trim().split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  let merged = `${hookBlocks.join('\n\n')}\n\n${mk[0].trim()}`;
  while (effLen(merged) > 280 && hookBlocks.length > 2) {
    let drop = 1;
    for (let i = 1; i < hookBlocks.length - 1; i++) if (hookBlocks[i].length > hookBlocks[drop].length) drop = i;
    hookBlocks.splice(drop, 1);
    merged = `${hookBlocks.join('\n\n')}\n\n${mk[0].trim()}`;
  }
  if (effLen(merged) > 280) return tweets;                        // still won't fit — leave split for the gate/retry
  const rest = t1.slice(mk[0].length).replace(/^\n+/, '').trim(); // elaboration packed after the marker line, if any
  const between = tweets.slice(1, k);                             // intermediate context tweets stay in order
  const tail = rest ? [rest, ...tweets.slice(k + 1)] : tweets.slice(k + 1);
  return [merged, ...between, ...tail];
}

// ---- realignPosts: map a deterministically reshaped TEXT array back onto Typefully post objects ---
// A reshaper like attachFirstItemToHook returns plain strings, but a SCHEDULED draft's posts carry
// media_ids — and the reshaper may fold one tweet's whole text into another, shrinking the array. Naive
// index assignment would therefore slide every image onto the wrong tweet, or drop one entirely. This
// walks the two lists in order and pairs each surviving text with the post it came from (a post whose
// text was absorbed is skipped, and only if it carries NO media). It returns null — decline, change
// nothing — on any ambiguity: a text it cannot place, a post left over at the end, or an absorbed post
// that had media. Callers treat null as "leave the draft exactly as it is". Pure + testable.
export function realignPosts(posts, after) {
  if (!Array.isArray(posts) || !Array.isArray(after) || !posts.length || !after.length) return null;
  const out = [{ ...posts[0], text: after[0] }];
  let i = 1;
  for (let j = 1; j < after.length; j++) {
    while (i < posts.length) {
      const t = String(posts[i].text || '').trim();
      if (t === after[j] || t.endsWith(after[j])) break;             // same tweet (whole, or minus a lifted line)
      if ((posts[i].media_ids || []).length) return null;            // an absorbed tweet carried media — decline
      i++;
    }
    if (i >= posts.length) return null;                              // alignment lost — decline
    out.push({ ...posts[i], text: after[j] });
    i++;
  }
  return i === posts.length ? out : null;                            // no post may be left unaccounted for
}

// ---- hookFirstItemIssue: the recreation must KEEP the donor's first item -------------------------
// prompts.mjs:230 makes it a hard rule for FAITHFUL mode ("Keep the same first item"), and the nightly
// QC signals show the model breaking it anyway ("hook: first item changed carb/.", "hook: missing
// biphasic sleep first item" — IMPROVEMENTS 2026-08-02, QC final pass). Until now the ONLY thing
// watching that rule was qc.mjs's judgeHook, an LLM call wrapped in `catch { return null }` — it fails
// OPEN on any API exception, so a drifted first item can ship completely ungated. This is its
// deterministic twin, the same backstop pattern absoluteSuperlativeIssue plays for judgePlug.
//
// Deliberately LENIENT, because a faithful recreation is "same mold, different words": it passes when
// our hook (or the tweet right after it, where the elaboration lands) reuses ANY ONE distinctive
// content word from the donor's first item. So "1. Carb cycling." -> "1. Carb backloading." passes,
// while a wholesale swap to a different substance fails. It fails OPEN wherever it cannot know the
// answer — donor with no "N." first item, or a first item made only of stopwords/short words.
// Substring matching (not token equality) absorbs plurals and inflections ("carb" in "carbs").
// FAITHFUL mode only — skeleton mode's hook is a deliberate NEW-topic variation, so callers gate on it.
// Returns a short message or ''. Pure + testable.
const HOOK_ITEM_STOPWORDS = new Set(['your', 'their', 'this', 'that', 'these', 'those', 'with', 'from', 'into', 'more', 'most', 'less', 'than', 'then', 'when', 'what', 'which', 'while', 'about', 'every', 'each', 'some', 'they', 'them', 'have', 'has', 'been', 'will', 'just', 'only', 'also', 'even', 'like', 'very', 'much', 'many', 'first', 'best', 'good', 'thing', 'things', 'stuff', 'people', 'daily', 'never', 'always']);
const firstItemText = (hook) => {
  const m = String(hook || '').match(/(?:^|\n)[ \t]*1[.)]\s*([^\n]+)/);
  return m ? m[1].trim() : '';
};
export function hookFirstItemIssue(srcHook, ourHook, nextTweet = '') {
  const src = firstItemText(srcHook);
  if (!src) return '';                                   // donor has no numbered first item — nothing to keep
  // Words the donor's own HOOK LINE already uses are FRAME words, not item-distinctive ones, and a
  // faithful recreation keeps the frame by design — so they'd match no matter what the item became.
  // ("5 sleep fixes: / 1. Biphasic sleep." -> anchor on "biphasic", never on "sleep".)
  const frame = String(srcHook || '').replace(/(?:^|\n)[ \t]*\d+[.)][^\n]*/g, ' ').toLowerCase();
  const words = src.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !HOOK_ITEM_STOPWORDS.has(w) && !frame.includes(w));
  if (!words.length) return '';                          // no distinctive word to anchor on — fail open
  const ours = `${ourHook || ''}\n${nextTweet || ''}`.toLowerCase();
  if (words.some((w) => ours.includes(w))) return '';
  return `first item drifted from the source's ("${src.slice(0, 48)}") — the recreation must keep the donor's first item`;
}

// ---- hook length fidelity: the rewrite must not read LONGER than the donor's hook -----------------
// Fear (operator 2026-07-24): faithful rewrites rephrase the hook LONGER than the donor's, so it reads
// clumsy and hard to scan ("If I could be 25 again" -> "If I could talk to my 25 year old self"). The
// skeleton mold gate enforced a ±20% line-1 band; FAITHFUL mode had no length gate at all. hookBodyText
// measures the hook MINUS any attached "N." first-item line (that item is a separate concern, and it
// inflates the count unevenly). hookTooLong is ONE-SIDED — only bloat trips it; a tighter hook is fine.
export function hookBodyText(tweet, srcAttaches = false) {
  let t = String(tweet || '').trim();
  if (srcAttaches) {
    const blocks = t.split(/\n{2,}/);
    if (blocks.length >= 2 && /^\s*\d+[.)]\s/.test(blocks[blocks.length - 1])) { blocks.pop(); t = blocks.join('\n\n').trim(); }
  }
  return t;
}
// ---- hookFidelity: the 85-90% band (operator 2026-08-17, superseding the 90-95% rule) -------------
// The rule changed shape, not just its number. Word-swapping ("on shelves" -> "on the shelf") kept the
// hook so close to the donor that X can match it as a near-duplicate string, and it made the rewrite
// read like a find-and-replace. Paraphrase WITHIN each sentence is now allowed; what must survive is
// the hook's SHAPE — same sentence count, same order, each sentence about as long as its counterpart.
// So the gate measures three separate things, because "85-90% similar" alone is not checkable:
//   1. shape   — sentence count matches, and each sentence is within tolerance of the donor's length
//   2. fidelity— Dice overlap on words sits inside the band (too high = matchable; too low = we threw
//                away the proven hook and are shipping an original, which is not what this lane is for)
// The hook's attached "N." first-item line is EXCLUDED from all of it: the outline now assigns item 1,
// so that line legitimately differs from the donor's and must never count against fidelity.
const hookWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9'%$.\s]/g, ' ').split(/\s+/).filter(Boolean);
// A numbered-item marker at a line start ("1. Eggs", or a donor's unspaced "1.Eggs") is one marker,
// never a sentence of its own: both spellings fold to "1) " before any split (2026-11-10, donors
// CoachDanCole_ 2119653599911506322 and TheFastedState 2119387481254797374 wrote "1.Eggs", and no
// spelling of ours could pass). A decimal ("2.5 mg") is untouched: the marker needs a letter after it.
export const foldListMarkers = (s) => String(s || '').replace(/(^|\n)([ \t]*)(\d{1,2})[.)][ \t]*(?=[A-Za-z"'“(])/g, '$1$2$3) ');
const hookSentences = (s) => foldListMarkers(s).split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/** Dice coefficient on the two hooks' word bags. 1 = identical vocabulary, 0 = disjoint. Pure. */
export function hookSimilarity(ourHook, donorHook) {
  const a = hookWords(ourHook), b = hookWords(donorHook);
  if (!a.length || !b.length) return 0;
  const bag = new Map();
  for (const w of b) bag.set(w, (bag.get(w) || 0) + 1);
  let shared = 0;
  for (const w of a) { const n = bag.get(w) || 0; if (n > 0) { shared++; bag.set(w, n - 1); } }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Gate the rewritten hook against the donor's. Returns a message or ''.
 * `band` is the acceptable Dice range; the PROMPT aims at 0.85-0.90, the gate is wider so a good
 * hook is never rejected for landing at 0.83. Pure + testable.
 */
export function hookFidelityIssue(ourHook, donorHook, { srcAttaches = false, band = [LAWS.hook.gateMin, LAWS.hook.gateMax], sentenceTolerance = LAWS.hook.sentenceTolerance, swapPromise = false } = {}) {
  const our = hookBodyText(ourHook, srcAttaches), donor = hookBodyText(donorHook, srcAttaches);
  if (!our || !donor) return '';
  // PROMISE SWAP (operator's roundup conversion, 2026-08-17). Converting a thread to a supplement
  // roundup REQUIRES rewriting the hook's promise sentence ("Here are 16 things..." -> "...the 5
  // supplements..."), and holding that sentence to the 85-90% band makes the two laws fight — the
  // first live OUTLINE_MODE run failed at 62% for exactly this reason. With swapPromise the promise
  // sentence (the one carrying the count) is EXCLUDED from the word-overlap measure; its length and
  // position still count, and every other sentence stays in the band.
  const dropPromise = (text) => {
    if (!swapPromise) return text;
    const sents = hookSentences(text);
    const pi = sents.findIndex((x) => /\b\d+\b/.test(x) && /\b(here|these|below)\b/i.test(x));
    return (pi >= 0 ? sents.filter((_, i) => i !== pi) : sents).join(' ');
  };
  const sim = hookSimilarity(dropPromise(our), dropPromise(donor));
  if (sim >= 0.995) return 'hook is byte-identical to the donor hook — paraphrase inside each sentence (target 85-90%, never 100%)';
  // WHOLE-HOOK band first, then PER SENTENCE (operator 2026-08-17). A whole-hook average hides the
  // failure that actually happens: one sentence left untouched and one rewritten past recognition
  // average out to a healthy 87% while neither sentence is right. The rewrite must be DISTRIBUTED.
  if (sim > band[1]) return `hook is ${Math.round(sim * 100)}% of the donor (max ${Math.round(band[1] * 100)}%) — paraphrase more inside the sentences, X can match a near-identical string`;
  if (sim < band[0]) return `hook is only ${Math.round(sim * 100)}% of the donor (min ${Math.round(band[0] * 100)}%) — the proven hook is the asset, keep its wording closer`;
  const os = hookSentences(our), ds = hookSentences(donor);
  if (os.length !== ds.length) return `hook shape broken: ${os.length} sentences vs the donor's ${ds.length} — keep the same count and order`;
  for (let i = 0; i < ds.length; i++) {
    const a = effLen(os[i]), b = effLen(ds[i]);
    if (b) {
      const drift = Math.abs(a - b) / b;
      if (drift > sentenceTolerance) return `hook sentence ${i + 1} is ${a} chars vs the donor's ${b} (${Math.round(drift * 100)}% off, keep within ${Math.round(sentenceTolerance * 100)}%)`;
    }
    // Per-sentence band, WIDER than the whole-hook one and length-aware: a 5-word line moves ~17
    // points of Dice per word changed, so a tight band there would reject any honest paraphrase.
    // Short lines therefore get an upper bound only — they still may not be left verbatim, but how
    // far they travel is not something a percentage can judge fairly.
    const isPromise = swapPromise && /\b\d+\b/.test(ds[i]) && /\b(here|these|below)\b/i.test(ds[i]);
    const words = Math.min(hookWords(os[i]).length, hookWords(ds[i]).length);
    const ss = hookSimilarity(os[i], ds[i]);
    if (ss > 0.97 && words >= 4 && !isPromise) return `hook sentence ${i + 1} is untouched — the rewrite must be spread across EVERY sentence, not concentrated in one`;
    if (words >= 8 && ss < 0.60 && !isPromise) return `hook sentence ${i + 1} is only ${Math.round(ss * 100)}% of the donor's — that sentence lost the original, rewrite it closer`;
  }
  return '';
}

/**
 * Which WAY a hook missed the band. Pure, and it exists because the repair path has to know: the
 * gate fails in two opposite directions and there are two opposite prompts to fix it with. Sending
 * a hook that is already under the floor to the diverge-harder prompt pushes it further out on
 * every retry, which is exactly how a live slot reached 46% against a 72% floor.
 *   'far'   — too little of the donor survived; pull it BACK toward the parent
 *   'close' — too much survived; X can match it as a duplicate string, so diverge
 *   null    — not a fidelity issue (shape, sentence length, byte-identical)
 */
export function hookDriftDirection(issue) {
  const s = String(issue || '');
  if (/hook is only \d+% of the donor|hook sentence \d+ is only \d+% of the donor's/.test(s)) return 'far';
  if (/hook is \d+% of the donor \(max|hook sentence \d+ is untouched/.test(s)) return 'close';
  return null;
}

// ---- HOOK EDIT WINDOWS (2026-08-29) ------------------------------------------------------------
// hookFidelityIssue enforces two things at once and reports them ONE AT A TIME, in a fixed order:
// the whole-hook Dice band first, then per-sentence length, then per-sentence "untouched". A writer
// working blind therefore learns the constraints serially — edit a sentence, learn it is 31% off,
// fix the length, learn the whole hook has now fallen under the floor, repeat. Kim's nine-sentence
// hook took five rounds that way on 2026-08-29 and Lorenzo's six-line hook took four.
//
// None of that search is necessary: every per-sentence bound is a pure function of the DONOR's own
// sentence lengths, so the budget can be stated before the first edit. This returns it. It does not
// judge anything — hookFidelityIssue stays the only gate — it just prints the room you have.
//
// `mustTouch` marks the sentences the "untouched" rule actually applies to: that check only fires at
// >=4 words, so a two-word line may legitimately survive verbatim and a writer should not burn edits
// widening it.
export function hookWindows(donorHook, { srcAttaches = false, tolerance = LAWS.hook.sentenceTolerance } = {}) {
  return hookSentences(hookBodyText(donorHook, srcAttaches)).map((s, i) => {
    const len = effLen(s);
    return {
      n: i + 1,
      donor: s,
      len,
      min: Math.ceil(len * (1 - tolerance)),
      max: Math.floor(len * (1 + tolerance)),
      mustTouch: hookWords(s).length >= 4,
    };
  });
}

// ---- DONOR SCREEN: fabrication (2026-08-29) -----------------------------------------------------
// Three donors on the 08-31 slate had to be thrown away AFTER writing had started, for things that
// were visible in their text from the first read: a hook attributing a false mechanism to "a Stanford
// neuroscientist", a body citing a "Dr. Sarah Chen", a fabricated case study quoting sleep
// percentages, and a direct quote put in a named living person's mouth that did not check out.
//
// bannedTopicIssue already blocks a SUBJECT and DRUG_RE a prescription name. Neither looks for
// borrowed authority, which is the shape that keeps arriving, so this does. It is deliberately a
// REPORT and not a gate: an institution or a percentage can be perfectly legitimate, and the caller
// is a human who can see the sentence. What it removes is the discovery cost.
export const FABRICATION_PATTERNS = [
  // severity 'note' — a convention of the genre, not a defect. Every viral health thread borrows an
  // unnamed authority and quotes a percentage; treating those as disqualifying threw away good
  // donors and starved the pool. Reported so a writer can see what the donor is leaning on, and
  // hedge or drop it per LAW 7 when writing, but never a reason to reject the donor.
  ['borrowed authority', 'note', /\b(?:a|an|one)\s+(?:stanford|harvard|yale|oxford|cambridge|mit|nasa|johns\s+hopkins|mayo)\b[^.\n]{0,48}?\b(?:neuroscientist|scientist|doctor|physician|researcher|study|group|team)\b/i],
  ['unnamed expert', 'note', /\b(?:a|an|one)\s+(?:biology|nutrition|sleep|heart|longevity)?\s*(?:professor|cardiologist|neurologist|dietitian|surgeon)\b/i],
  ['named expert', 'note', /\bDr\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+/],
  ['precise statistic', 'note', /\b\d{1,3}(?:\.\d+)?%/],
  ['x-out-of-y claim', 'note', /\b\d+\s+(?:out\s+of|in)\s+\d+\b/i],
  ['case study', 'note', /\bcase\s+stud(?:y|ies)\b/i],

  // severity 'flag' — the one that is different in kind. Putting a specific quote in a specific
  // living person's mouth is not borrowing credibility from a vague institution, it is attributing
  // words to someone identifiable who did not say them. The donor that prompted this quoted "Jim
  // Carrey" and got his age wrong in the same breath. Still only REPORTED — this file never blocks —
  // but it is the one worth a second look before republishing under our own name.
  ['quote attributed to a named person', 'flag', /\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:said|admitted|confessed|revealed|told)\b/],
];

/** The severities that should keep a donor out of a slate. Deliberately narrow: on 2026-08-29 the
 *  screen was excluding on every pattern, which cut the usable pool from 84 to 46 and filled a day
 *  with 6-18 day donors under the belief that supply was short. It was not. */
export const BLOCKING_FABRICATION = new Set(['flag']);

export function fabricationFlags(tweets = []) {
  const list = Array.isArray(tweets) ? tweets : [tweets];
  const hits = [];
  list.forEach((t, i) => {
    for (const [kind, severity, re] of FABRICATION_PATTERNS) {
      const m = String(t || '').match(re);
      if (m) hits.push({ kind, severity, tweet: i + 1, match: m[0].slice(0, 64) });
    }
  });
  return hits;
}

// ---- DONOR SCREEN: body overlap (2026-08-29) ----------------------------------------------------
// Creators recycle each other's threads, and two accounts posting the same body on the same day is
// the duplicate case /money-thread's rescue check exists to stop. On the 08-31 slate the planner
// handed Rafael and Lucas the same recycled nitric-oxide thread — two byte-identical tweet bodies,
// 263 and 225 characters — and it was caught only because Lucas was written second and read oddly.
// Clara's replacement then shared its explainer with Rafael AND its opener with Magnus.
//
// Word-level 4-grams rather than whole tweets: a creator who reorders or retypes a paragraph still
// scores, where an exact-match check reads it as original. Asymmetric on purpose — the question is
// "how much of THIS donor already exists in what we shipped", so it divides by A.
export function bodyOverlap(a = [], b = [], { n = 4 } = {}) {
  const shingles = (tweets) => {
    const out = new Set();
    for (const t of (Array.isArray(tweets) ? tweets : [tweets])) {
      const w = String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
      for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
    }
    return out;
  };
  const A = shingles(a);
  if (!A.size) return 0;
  const B = shingles(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}

// ---- discriminationIssue: the beat before every CTA hands over a buying criterion ------------------
// The single rule that survives all four plug paths (operator 2026-08-17). Whatever the thread shape,
// the tweet immediately before the plug does the same job: it tells the reader what SEPARATES the
// version that works from the junk on the shelf. "Most ashwagandha on the shelf is raw root powder at
// a dose no study ever used." "Glycinate absorbs cleanly, oxide mostly passes through." "High-EPA
// triglyceride form, not the cheap ester capsules."
//
// That beat is doing three jobs at once, which is why it replaces the older one-line bridge rule:
//   - it NAMES the substance, so the plug is never cold (the original bridge law)
//   - it hands over a spec the reader can go and verify, so the CTA answers a question they now hold
//     rather than making a claim they have to trust
//   - on a deep dive, where every tweet is already about the substance and there is nothing to bridge
//     FROM, it is the only thing that can function as the run-up at all
//
// Pure + testable. Returns a message or ''.
const FORM_WORDS = /\b(glycinate|oxide|citrate|threonate|malate|taurate|bisglycinate|ksm-?66|sensoril|withanolides|monohydrate|micronized|creapure|triglyceride|ethyl ester|epa|dha|ubiquinol|ubiquinone|methylated|methylcobalamin|liposomal|chelated|standardi[sz]ed|extract|full[- ]spectrum|grass[- ]fed|hydroly[sz]ed|k2|mk-?7|d3)\b/i;
// Widened after the first real example failed by one character: "Most ashwagandha on the shelf is
// raw root powder at a dose no study ever used" is the criterion beat we are trying to REWARD, and a
// 24-char window between "most" and its verb was not enough to reach past the noun phrase.
const CONTRAST = new RegExp([
  'not the', 'not a', 'never the', 'instead of', 'rather than', 'look for', 'avoid', 'the catch',
  'the difference', 'what separates', 'watch out', 'skip the', "don'?t buy", 'cheap(er)?', 'junk',
  'useless', 'matters more than', 'no study', 'never used', 'raw root', 'under[- ]?dosed',
  'most [^.!?]{0,60}\\b(is|are|was|were)\\b',
  '\\b(label|form|dose|potency|purity|extract)\\b[^.!?]{0,40}\\b(matters|is what|is the|to look)\\b',
].join('|'), 'i');
const SPEC_NUM = /\d+\s?(%|mg|mcg|iu|g)\b/i;

/**
 * The ALTERNATIVES a buyer might pick instead — the losing side of a criterion.
 *
 * A buying criterion is fundamentally a DISCRIMINATION: this version works, that one does not. The
 * detector used to find that only through FORM_WORDS (after stripping the substance's own name) or
 * through CONTRAST phrasing. Both miss the most natural way to write one, which is to simply name
 * the inferior option:
 *
 *   "EPA and DHA are what the research actually uses. Flax and chia give you ALA, and the body
 *    converts very little of it."
 *
 * That is a correct, well-written criterion sitting before its plug. But 'epa' and 'dha' are the
 * product's OWN substance terms, so residual() strips them, 'ala' was in no vocabulary, and none of
 * the CONTRAST phrasings matched — so criterionOrderIssue declared the thread inverted and pointed at
 * a redundant second criterion further down. Measured on the 2026-08-17 batches, this class inflated
 * criterion-inverted substantially: the defect was real in some threads and invented in others, and
 * the report could not tell them apart.
 *
 * These are deliberately the LOSING options, not every form word: naming what a reader should avoid
 * is what makes a sentence a criterion rather than a description.
 */
const ALTERNATIVES = new RegExp('\\b(' + [
  'ala', 'flax', 'chia', 'ethyl ester', 'ubiquinone', 'arginine', 'mk-?4', 'oxide', 'citrate',
  'gelatin', 'raw root', 'root powder', 'whole protein', 'ester', 'magnesium oxide',
  'sweetened', 'proprietary blend', 'blend', 'juice', 'gummies', 'gummy', 'gum[m]?ies',
  'gelatine', 'gel caps', 'gelcaps', 'gel[- ]?tabs', 'gel[- ]?capsules',
].join('|') + ')\\b', 'i');

// POD (operator 2026-08-30): the `pod` flag has the same standing here as donorSlot. A pod's own
// first tweet withholds the substance on four of its five frames and hands off with "↓", so the
// bridge is the substance's first mention and the same-breath arm fires on every podded plug — an
// advisory that always fires is an advisory nobody reads. A LIGHT pod goes further and drops the
// bridge entirely, because it is the SECOND ask in a thread whose heavy pod already named the
// substance and handed over the criterion; its prior tweet is by design a hand-off, not a run-up.
// Both arms relax, exactly as they do under donorSlot; podIssues holds the pod to its own gates.
export function discriminationIssue(tweets, plugIndex, product, { strict = false, donorSlot = false, pod = false, look = 3 } = {}) {
  if (plugIndex < 1) return '';
  const prior = String((tweets || [])[plugIndex - 1] || '');
  if (!prior && !donorSlot) return '';
  const terms = substanceTermsFor(product);
  // DONOR SLOT (operator 2026-08-25): the plug stands where the creator's own ask stood, so the
  // run-up is THEIR surviving tweets and their criterion may sit 2-3 back (their item tweet often
  // stands between it and a CTA-only replace). The window widens ONLY under the flag, and it is
  // judged with looksLikeCriterion — the same detector the placement depth rule uses, so the
  // chooser and the gate can never disagree about one seam.
  const windowT = donorSlot ? (tweets || []).slice(Math.max(0, plugIndex - look), plugIndex).map((t) => String(t || '')) : [prior];
  const namesIt = !terms.length || windowT.some((w) => terms.some((t) => w.toLowerCase().includes(t)));
  // Identity terms for the donor-slot criterion test: a criterion-shaped line about someone ELSE's
  // item (cold exposure on the cortisol donor) must not warm this slot — "cortisol" is a symptom
  // term, not a name. Same idiom as the ordering check below; same rule as pod-place's depth chooser.
  const titleLc = String(product?.title || '').toLowerCase();
  const idTerms0 = terms.filter((t) => titleLc.includes(t));
  const idTermsW = idTerms0.length ? idTerms0 : terms;
  // Same substance-name blind spot as criterionOrderIssue: "oxide" in "nitric oxide" is the product's
  // name, not a form contrast. Strip the terms before testing form words.
  const residualPrior = terms.reduce((x, t) => x.split(t).join(' '), prior.toLowerCase());
  const discriminates = donorSlot
    ? windowT.some((w) => looksLikeCriterion(w, product) && (!idTermsW.length || idTermsW.some((t) => w.toLowerCase().includes(t))))
    : (FORM_WORDS.test(residualPrior) || CONTRAST.test(prior) || (strict ? false : SPEC_NUM.test(prior)));

  // ORDERING (operator 2026-08-17): a criterion only works on a reader who already knows what the
  // substance IS. "Most ashwagandha on the shelf is raw root powder" lands on nothing if this is the
  // first time ashwagandha has been mentioned — you are answering a question nobody has asked yet.
  // So the criterion beat may not be the substance's first appearance... UNLESS the hook already
  // primed the reader by promising supplements, which is exactly what a ROUNDUP hook does ("out of
  // 50,000 products only 5 work"). There, the item tweet introduces and discriminates in one breath
  // and the reader is ready for it, which is why a roundup runs 2 tweets per product and not 3.
  // Under donorSlot the same-breath check is skipped entirely: the donor's own build-up IS the
  // priming — their audience already accepted an ask at this exact beat.
  if (terms.length && namesIt && !donorSlot) {
    // "Has the reader MET this substance yet" must key on the substance's own NAME, not on the
    // symptom words the bridge map also carries. substanceTermsFor(ashwagandha) includes "cortisol",
    // so a tweet about a 3am cortisol spike counted as an introduction to ashwagandha and the
    // ordering check silently passed. Keep only the terms that appear in the product's own title.
    const title = String(product?.title || '').toLowerCase();
    const nameTerms = terms.filter((t) => title.includes(t));
    const idTerms = nameTerms.length ? nameTerms : terms;
    const firstMention = (tweets || []).findIndex((t) => idTerms.some((x) => String(t).toLowerCase().includes(x)));
    const primed = listicleKind(String((tweets || [])[0] || '')) === 'prescriptive'
      || /\b(supplements?|vitamins?|minerals?)\b/i.test(String((tweets || [])[0] || ''));
    if (firstMention === plugIndex - 1 && !primed && !pod) {
      return `plug #${plugIndex + 1} introduces ${idTerms[0]} and sells it in the same breath — the criterion needs a reader who already knows what it is. Introduce it one tweet earlier, THEN say what to look for.`;
    }
  }
  if (pod) return ''; // reviewed copy: podIssues already required a named substance + a criterion
  if (!namesIt && !discriminates) return `the tweet before plug #${plugIndex + 1} neither names the substance nor says what to look for — the reader arrives at the link holding nothing`;
  if (!discriminates) return `the tweet before plug #${plugIndex + 1} names the substance but gives no buying criterion — say what separates the real thing from the shelf junk (the form, the standardisation, what to avoid), so the CTA answers a question instead of making a claim`;
  return '';
}

// ---- runUpIssue: two beats before the ask, not one -------------------------------------------------
// The bridge law says the tweet BEFORE a plug must land on the substance. On a diagnostic listicle
// that is not enough, because item 1 cannot BE the product (a supplement is not a sign) and the
// substance therefore has to be introduced inside the body instead. Introducing it and asking for
// the click in consecutive tweets is a cold sell. The operator's shape (2026-08-17):
//
//   Hook            -> "7 signs your cortisol is wrecking you: 1. Waking up at 3-4 AM."
//   EXPLAIN + NAME  -> why the 3am wake-up happens, and the substance named for the first time
//   AGITATE         -> the cost of leaving it, why the usual fix misses, closing on the substance
//   CTA             -> the plug
//
// So the substance gets TWO beats before the ask: one to arrive, one to matter. This gate checks the
// run-up carries it twice rather than appearing cold one line above the link. Pure + testable.
export function runUpIssue(tweets, plugIndex, product, { need = 2, look = 3, shape = null, donorSlot = false, pod = false } = {}) {
  // A ROUNDUP plans ONE run-up beat by design: its item tweet IS the substance and the hook already
  // agitated, which is why the shape runs two tweets per product instead of three. Demanding two
  // beats there is structurally impossible — the three tweets before plug k are item k-1, plug k-1,
  // item k — so every roundup plug came back flagged, and the only way to silence it was to pad the
  // thread into the "five products times five tweets is not a thread" failure the doc forbids.
  // discriminationIssue already got this exemption; its sibling gate never did.
  if (shape === 'roundup') need = 1;
  // DONOR SLOT (operator 2026-08-25): the plug REPLACED the creator's own ask, so the run-up is the
  // donor's surviving wind-up — the beats that made the source viral. Their one named beat is the
  // audience's own proof; demanding OUR two re-litigates a slot the donor already won.
  if (donorSlot) need = 1;
  // POD (operator 2026-08-30). A pod's first tweet is deliberately written NOT to name the substance
  // on four of its five frames: the symptom, action, cause and answer framings agitate the PROBLEM in
  // the reader's own words and hand off with an explicit "↓" ("You wake up with a headache... A sachet
  // can help, but the right one ↓"). Naming the substance there would answer the question the frame
  // exists to raise, and on the action frame it would replace the reader's word with jargon ("Salt
  // your first glass of water" -> "Take electrolytes"). Measured on the 19 approved pods: 15 of 95
  // frames withhold the substance by design, every one of them ending on the handoff.
  //
  // The law's purpose survives intact, because a pod supplies the two beats in a different currency:
  // the first tweet ARRIVES (the problem, its mechanism, and an explicit promise of the category),
  // and the bridge MATTERS (the substance, named twice, plus the buying rule). What it cannot supply
  // is the same WORD twice, and word-counting was only ever the proxy. podIssues independently
  // guarantees the bridge names the substance and hands over a criterion, so a pod's run-up is
  // reviewed copy rather than a model's guess — a stronger warrant than the count this replaces.
  // Same scoping as roundup and donorSlot above: opt-in, never a blanket loosening.
  if (pod) need = 1;
  const terms = substanceTermsFor(product);
  if (!terms.length || plugIndex < 1) return '';
  const start = Math.max(0, plugIndex - look);
  const runUp = (tweets || []).slice(start, plugIndex);
  const hits = runUp.filter((t) => terms.some((x) => String(t).toLowerCase().includes(x))).length;
  if (hits >= need) return '';
  if (hits === 0) return `plug #${plugIndex + 1} arrives cold — no tweet in the ${runUp.length} before it names ${terms[0]}`;
  return `plug #${plugIndex + 1} has only ONE run-up beat naming ${terms[0]} — the shape is explain-and-name, then agitate, THEN ask. One beat is a cold sell.`;
}

// ---- criterionOrderIssue: the criterion must come BEFORE the ask, never after --------------------
// Caught by the operator on the first OUTLINE_MODE draft the gates passed (Jasper 10373101): tweet 3
// was the plug, tweet 4 was "Nitric oxide is where most people buy wrong... Look for L-citrulline
// dosed near 1000mg" — the ad first, the justification second. Nothing flagged it, because the
// criterion law lived only as a console.warn inside recreate: warn-only by design (a regex cannot
// recognise every good criterion, so a MISSING one must not block a revenue plug), and no check at
// all looked AFTER the plug.
//
// The inversion is different from the missing case, and it is gateable: when a criterion-shaped
// beat for the plug's own substance demonstrably EXISTS in the tweets right after the plug while the
// beat before it carried none, the thread positively contains the right material in the wrong order.
// No judgement call, no regex generosity — presence after + absence before = inverted. ERROR.
/**
 * Does this text actually DISCRIMINATE — separate the version that works from the shelf junk?
 * The same three-way test criterionOrderIssue uses internally, exported because the criterion is
 * now a FIELD the assembler places (2026-08-18): a field needs a content gate, or "it's great"
 * ships as a criterion. Substance terms are stripped first so a name that contains a form word
 * (nitric OXIDE) can never satisfy the test by itself.
 */
export function looksLikeCriterion(text, product = {}) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const terms = substanceTermsFor(product);
  const residual = terms.reduce((x, term) => x.split(term).join(' '), t.toLowerCase());
  return FORM_WORDS.test(residual) || CONTRAST.test(t) || ALTERNATIVES.test(residual);
}

export function criterionOrderIssue(tweets, plugIndex, product, { look = 2, donorSlot = false, lookBack = 3 } = {}) {
  if (plugIndex < 1) return '';
  const terms = substanceTermsFor(product);
  const aboutSubstance = (t) => !terms.length || terms.some((x) => String(t).toLowerCase().includes(x));
  // A form word that is part of the substance's OWN NAME is not a criterion — "nitric oxide" made
  // every bare mention of the product read as a buying criterion ("oxide" is a form word), which is
  // how the first inverted draft sailed past this gate AND past discriminationIssue. Strip the
  // substance terms first; whatever form/contrast language survives is the actual criterion.
  const residual = (t) => terms.reduce((x, term) => x.split(term).join(' '), String(t).toLowerCase());
  // A criterion discriminates. It can do that three ways: name a FORM that survives the substance
  // strip, use CONTRAST phrasing, or simply name the ALTERNATIVE the reader should not buy. The third
  // was missing and it is the most natural way to write one — see ALTERNATIVES.
  const isCriterion = (t) => (FORM_WORDS.test(residual(t)) || CONTRAST.test(String(t)) || ALTERNATIVES.test(residual(t))) && aboutSubstance(t);
  // DONOR SLOT (operator 2026-08-25): the criterion may be the donor's own, 2-3 tweets back behind
  // their item tweet. Only the right-order arm widens; presence-after + absence-before is still an
  // inversion — the flag never blinds the gate. The widened arm demands the substance's NAME
  // (identity terms), so a criterion about a different list item cannot satisfy the order.
  const titleLc = String(product?.title || '').toLowerCase();
  const idT = terms.filter((t) => titleLc.includes(t));
  const idTermsB = idT.length ? idT : terms;
  const beforeOk = donorSlot
    ? (tweets || []).slice(Math.max(0, plugIndex - lookBack), plugIndex).some((t) => isCriterion(String(t || '')) && (!idTermsB.length || idTermsB.some((x) => String(t).toLowerCase().includes(x))))
    : isCriterion(String((tweets || [])[plugIndex - 1] || ''));
  if (beforeOk) return ''; // right order — nothing to say
  for (let k = 1; k <= look; k++) {
    const after = String((tweets || [])[plugIndex + k] || '');
    if (!after || hasUrl(after)) break; // the next plug's territory is its own problem
    if (isCriterion(after)) {
      return `plug #${plugIndex + 1} SELLS BEFORE IT JUSTIFIES — the buying criterion sits ${k} tweet(s) AFTER the CTA ("${after.split('\n')[0].slice(0, 56)}"). Move that beat to before the plug: the reader must arrive holding the question the link answers.`;
    }
  }
  return '';
}

// ---- firstItemFormIssue: the listicle promises a TYPE, and item 1 must be one -----------------------
// The outline now points item 1 at the substance we are selling (operator 2026-08-17). That is right
// for a listicle whose noun admits a product, and a category error for one whose noun does not:
// "Here are 7 SIGNS your cortisol is wrecking you: 1. KSM-66 ashwagandha, 600mg" is incoherent —
// a supplement is not a sign. The hook's own noun decides which FORM item 1 has to take:
//   PRESCRIPTIVE (ways, things, supplements, habits, steps, rules, tips) -> the item may BE the product
//   DIAGNOSTIC   (signs, symptoms, reasons, causes, mistakes, red flags) -> the item must be the
//                 OBSERVATION the reader recognises; the substance arrives in the bridge instead
//   CATALOG      (foods, drinks, exercises, herbs)                       -> the item must be a member
//                 of that category, so a capsule only fits when the category is supplements
const LISTICLE_NOUNS = {
  prescriptive: /\b(ways?|things?|supplements?|habits?|steps?|rules?|tips?|protocols?|hacks?|moves?|fixes|changes?|swaps?)\b/i,
  diagnostic: /\b(signs?|symptoms?|reasons?|causes?|mistakes?|red flags?|myths?|lies|truths?)\b/i,
  catalog: /\b(foods?|drinks?|exercises?|herbs?|vitamins?|minerals?|nutrients?|ingredients?|books?)\b/i,
};
/** Pure: which kind of list does this hook promise? Returns 'prescriptive' | 'diagnostic' | 'catalog' | ''. */
export function listicleKind(hook) {
  // Scan from the END. The promise ("Here are 7 signs ...") is the hook's last line, and the setup
  // above it routinely carries both a number and a stray verb — a forward scan matched "your kids
  // are grown (especially after 40)" as the promise and classified the list as nothing at all.
  const sents = hookSentences(hookBodyText(hook, false));
  for (let i = sents.length - 1; i >= 0; i--) {
    for (const [kind, re] of Object.entries(LISTICLE_NOUNS)) if (re.test(sents[i])) return kind;
  }
  return '';
}
/** Conservative cover-selection signal: a numbered promise of at least three list items. */
export function numberedListiclePromise(hook) {
  const text = hookBodyText(hook, false);
  const number = /\b(?:[3-9]|[12]\d|30|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;
  for (const match of text.matchAll(number)) {
    const words = text.slice(match.index + match[0].length).trimStart().split(/\s+/).slice(0, 3);
    for (let i = 1; i <= words.length; i++) {
      if (Object.values(LISTICLE_NOUNS).some((re) => re.test(words.slice(0, i).join(' ')))) return true;
    }
  }
  return false;
}
/** Pure: does item 1 fit the promised type? Returns a message or ''. */
export function firstItemFormIssue(hook, firstItem, { products = [] } = {}) {
  const kind = listicleKind(hook);
  const item = String(firstItem || '').replace(/^\s*\d+[.)]\s*/, '').trim();
  if (!kind || !item) return '';
  // Does the line read as a bare product? A substance term plus a dose, and no observation about the
  // READER (no "you/your", no verb describing something happening to them).
  const terms = products.flatMap((p) => substanceTermsFor(p));
  const namesSubstance = terms.some((t) => item.toLowerCase().includes(t))
    || Object.keys(BRIDGE).some((t) => t.length > 4 && item.toLowerCase().includes(t));
  const hasDose = /\d+\s?(mg|mcg|g|iu|ml)\b/i.test(item);
  const aboutReader = /\b(you|your|waking|feeling|losing|craving|can'?t|won'?t)\b/i.test(item);
  const bareProduct = namesSubstance && (hasDose || !aboutReader);
  if (kind === 'diagnostic' && bareProduct) {
    return `item 1 is a product but the hook promises SIGNS/REASONS — a supplement is not a sign. Make item 1 the OBSERVATION the reader recognises ("Waking up at 3-4 AM"), and let the bridge name the substance.`;
  }
  if (kind === 'catalog' && bareProduct && !/\b(supplements?|vitamins?|minerals?|nutrients?|herbs?)\b/i.test(hook)) {
    return `item 1 is a supplement but the hook promises a category of ${(hook.match(LISTICLE_NOUNS.catalog) || [''])[0]} — item 1 must be a member of that category.`;
  }
  return '';
}

export function hookTooLong(ourTweet1, donorTweet1, { srcAttaches = false, tolerance = 0.2 } = {}) {
  const our = effLen(hookBodyText(ourTweet1, srcAttaches));
  const donor = effLen(hookBodyText(donorTweet1, srcAttaches));
  if (!our || !donor) return '';
  const over = (our - donor) / donor;
  return over > tolerance
    ? `hook too long: ${our} chars vs donor ${donor} (+${Math.round(over * 100)}%, keep within +${Math.round(tolerance * 100)}%)`
    : '';
}

// ---- duplicate-item detection + cut (demo-3 class, 2026-07-21) -------------------------------------
// Live failure: the model wrote "1. Magnesium glycinate" AND "2. Magnesium glycinate" (5 items for a
// 4-item donor); the tail-cap then cut item 5 — the wrong one — and a count-valid thread shipped with
// the same supplement twice. Key = the item NAME line's first 4 content words; two items sharing a key
// are the same item. cutDuplicateItem removes the LATER duplicate's span (marker tweet + unnumbered
// continuations, stopping at the next numbered tweet, any plug/link tweet, or the final element).
const itemNameKey = (line) => String(line).replace(/^[ \t]*\d+[.)]\s*/, '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
export function duplicateItemIssue(tweets) {
  const seen = new Map();
  for (const t of (tweets || [])) for (const l of String(t).split('\n')) {
    if (!/^[ \t]*\d+[.)]\s/.test(l)) continue;
    const k = itemNameKey(l); if (!k) continue;
    const n = (l.match(/\d+/) || [])[0];
    if (seen.has(k)) return `items ${seen.get(k)} and ${n} share the same name ("${k}") — duplicated item`;
    seen.set(k, n);
  }
  return '';
}
export function cutDuplicateItem(tweets) {
  const keyAt = new Map(); let dupIdx = -1;
  outer: for (let i = 0; i < (tweets || []).length; i++) {
    for (const l of String(tweets[i]).split('\n')) {
      if (!/^[ \t]*\d+[.)]\s/.test(l)) continue;
      const k = itemNameKey(l); if (!k) continue;
      if (keyAt.has(k)) { dupIdx = i; break outer; }
      keyAt.set(k, i);
    }
  }
  if (dupIdx <= 0) return tweets;                                        // no dup, or dup inside the hook tweet
  if (!/^[ \t]*\d+[.)]\s/.test(String(tweets[dupIdx]).trim())) return tweets; // marker mid-tweet — too odd to cut blind
  const isPluggy = (t) => /https?:\/\//i.test(t) || DISCLOSURE_LINE_RE.test(t);
  let end = dupIdx + 1;
  while (end < tweets.length - 1 && !leadingNumbers(tweets[end]).length && !isPluggy(tweets[end])) end++;
  return [...tweets.slice(0, dupIdx), ...tweets.slice(end)];
}

// ---- capItemCount: deterministic last-resort for GENUINE item over-generation ---------------------
// Live failure 2026-07-20 (CoachDanCole, twice): the model wrote 5 distinct supplements for a 4-item
// donor and — even when the repair pass told it to delete one — refused to drop real content. The
// over-count gate then killed the roll. This cap is the deterministic fallback AFTER the LLM repair
// passes: cut the surplus TAIL item(s) — the marker tweet holding item maxN+1 and everything after it
// except the final element (the closer, which the generation prompt makes the last element). Keeping
// items 1..maxN preserves the donor's escalation order and needs no renumbering. Bounded: a surplus
// beyond `surplusLimit` is not a near-miss but a structurally different thread — outer retry instead.
export function capItemCount(tweets, maxN, { surplusLimit = 2 } = {}) {
  if (!Array.isArray(tweets) || maxN < 3) return tweets;
  const ourN = tweets.flatMap(leadingNumbers).length;
  if (ourN <= maxN || ourN - maxN > surplusLimit) return tweets;
  let seen = 0, cut = -1;                                          // tweet holding marker maxN+1 (assumes contiguous 1..ourN post-renumber)
  for (let i = 0; i < tweets.length && cut < 0; i++) {
    seen += leadingNumbers(tweets[i]).length;
    if (seen >= maxN + 1) cut = i;
  }
  if (cut <= 0) return tweets;                                     // surplus marker in the hook tweet — too odd to cut blind
  const keepCloser = cut < tweets.length - 1 ? [tweets[tweets.length - 1]] : [];
  return [...tweets.slice(0, cut), ...keepCloser];
}

// ---- stripItemMarkers: a NARRATIVE thread never carries list numbering -----------------------------
// Live failure 2026-07-20 (Jake thread): a narrative draft (skeleton itemCount 0) shipped one beat as
// "7. Dr. Robert Sapolsky reframed this for me." — a stray marker invents a listicle that doesn't
// exist. Called at the RAW stage only when the reference has no numbered items.
// Strips EVERY line's leading marker, not just the tweet's first line: the model leaks its own
// itemization into a multi-line beat too ("He tried everything.\n\n2. Then the doctor called."), and a
// mid-tweet stray survived the old first-line-only strip all the way to a live narrative thread — the
// leaked-enumeration class the QC retro re-proposes (IMPROVEMENTS 2026-08-08, QC final pass). Safe to
// widen precisely because this only ever runs on a NARRATIVE donor, where no legitimate list exists.
// Bounded to 1-2 digits so a line that opens on a YEAR ("1984. That was the year…") is never mistaken
// for an item marker — real item markers never reach 100, so the bound only removes false positives.
const STRAY_MARKER_RE = /^[ \t]*\d{1,2}[.)][ \t]+/gm;
export function stripItemMarkers(tweets) {
  return (tweets || []).map((t) => String(t).replace(STRAY_MARKER_RE, ''));
}

// ---- hookMoldIssue: the "same mold" gate for skeleton-variation hooks -----------------------------
// Operator rule (2026-07-19): hold the new hook and the inspiration hook side by side and they must
// visibly come from the SAME MOLD — similar line-1 character count, same clause scaffold. The ~95%
// structural-clone instruction was prompt-only; this makes it a deterministic, repairable gate:
//   1. LENGTH: line 1 stays within ±tolerance (default 20%) of the source hook's line-1 length.
//   2. SCAFFOLD: the non-<SLOT> words of the skeleton's hookFirstLine template (the connective frame,
//      e.g. "... is ...ing you faster than ...") must appear IN ORDER in line 1 (>= 70% of them) —
//      slots may change, the frame may not.
// Pure + testable. Returns a short message naming the failure, or null. Skips a check whose reference
// is missing (old library skeletons without hookLine1Len; an all-slot template) — never false-flags.
export function hookMoldIssue(hookTweet, { template = '', srcLine1 = '', srcLine1Len = 0, tolerance = 0.2 } = {}) {
  const line1 = String(hookTweet || '').split('\n')[0].trim();
  if (!line1) return null;
  const refLen = srcLine1Len || String(srcLine1).trim().length;
  if (refLen > 0) {
    const dev = Math.abs(line1.length - refLen) / refLen;
    if (dev > tolerance) return `hook mold: line 1 is ${line1.length} chars vs source ${refLen} (±${Math.round(tolerance * 100)}% band)`;
  }
  // Scaffold — the connective frame the clone must keep, in order. PREFERRED source: the donor's REAL
  // first line, whose FUNCTION WORDS (your/is/while/than/its/own/...) form a deterministic frame; the
  // content words are exactly what the variation swaps out. The LLM-extracted template proved format-
  // unstable across runs (<CAPS>, bare CAPS, lowercase "does/doing" placeholders — three dialects in
  // three extractions, 2026-07-20), so it is only the FALLBACK when the donor line isn't available.
  let scaffold;
  if (String(srcLine1).trim()) {
    scaffold = String(srcLine1).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/)
      .filter((w) => HOOK_STOP.has(w) || HOOK_FUNC.has(w));
  } else {
    scaffold = String(template)
      .replace(/[A-Za-z'-]*<[^>]*>[A-Za-z'-]*/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z']/g, ''))
      .filter((w) => w.length >= 2 && (w.match(/[A-Z]/g) || []).length < 2)
      .map((w) => w.toLowerCase());
  }
  if (scaffold.length >= 3) {
    const ours = line1.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
    let hit = 0, j = 0;
    for (const w of scaffold) { const k = ours.indexOf(w, j); if (k >= 0) { hit++; j = k + 1; } } // ordered subsequence
    if (hit / scaffold.length < 0.7) return `hook mold: line 1 keeps only ${hit}/${scaffold.length} scaffold words in order ("${scaffold.join(' ')}")`;
  }
  return null;
}
// Connective words that carry a hook's FRAME beyond the shared stopword list (mold scaffold only).
const HOOK_FUNC = new Set(['while', 'when', 'before', 'after', 'because', 'but', 'so', 'still', 'even', 'every', 'until', 'without', 'against', 'like']);

// Full deterministic check. tweets: string[]. Returns [{severity:'error'|'warn', code, msg, tweet?}].
// `arm` names a running EXPERIMENT the thread belongs to, and it may only ever relax a law it was
// designed to test. 'single-cta' (2026-09-07) is the one-ask arm of the CTA experiment: the fleet
// standard is heavy + light, and the question is whether the second ask costs reach, so the two-plug
// minimum is the one rule that has to yield. Everything else stays live on the arm — placement,
// spacing, the bridge, disclosure, tracked links — because an experiment that quietly suspends the
// other laws stops measuring the variable and starts measuring the mess.
export function checkThread(tweets, { account, link, monetized, arm = null }) {
  const issues = [];
  const add = (severity, code, msg, tweet = null) => issues.push({ severity, code, msg, tweet });

  // EVERY tweet, plugs included. This rule used to read `!hasUrl(t) && ...`, which exempted the one
  // tweet shape that always carries a URL, so a plug could never be length-errored at all. The only
  // guard left was plug-length, a WARN at plugTextLen > 255 — and plugTextLen collapses \n{2,} to a
  // single \n, so it discards the blank line between every pair of paragraphs. A five-paragraph plug
  // therefore passes 255 and still exceeds 280. magnus 10527598 was patched on 2026-09-03 at 284
  // effective characters and checkThread reported no error whatsoever; only gate-thread's own pass
  // caught it. X truncates or refuses that post.
  tweets.forEach((t, i) => { const n = effLenMinted(t); if (n > TWEET_LIMIT) add('error', 'length', `tweet ${i + 1} over ${TWEET_LIMIT} (${n})`, i + 1); });
  tweets.forEach((t, i) => { if (/[—–]/.test(t)) add('warn', 'emdash', `tweet ${i + 1} has an em/en dash`, i + 1); });
  const ni = numberingIssue(tweets); if (ni) add('error', 'numbering', ni);
  // Unfilled placeholder — any mode (audit 2026-07-20: a live scheduled draft carried two "Aff link:
  // [LINK]" pseudo-plugs). A draft with template tokens must NEVER post.
  const ph = placeholderIssue(tweets); if (ph) add('error', 'placeholder', ph);
  // Prose placeholders (2026-08-17): stage directions, bare enumerations, dangling final lead-in —
  // the placeholder classes that shipped live because they carry no bracket token.
  const sd = stageDirectionIssue(tweets); if (sd) add('error', 'stage-direction', sd);
  const ue = unfilledEnumIssue(tweets); if (ue) add('error', 'unfilled-enum', ue);
  const dl = danglingLeadInIssue(tweets); if (dl) add('error', 'dangling-lead-in', dl);

  // Engagement-bait sign-off: a defect in BOTH modes (it is a content rule, not a monetization one),
  // so it sits above the lightweight-mode early return.
  const gso = genericSignoffIssue(tweets, { account, plugLinks: [link].filter(Boolean) });
  if (gso) add('error', 'signoff-bait', gso);
  if (!monetized) return issues; // lightweight client mode: no plug/disclosure/disclaimer requirements

  // Hallucinated plug: a plug-shaped tweet (an "Aff link" disclosure) carrying NO URL at all — the
  // generation invented an extra ad the plug-splicer never wrote. Invisible to the plug-count check
  // (which counts by link presence), so it needs its own gate.
  const fp = fakePlugIssue(tweets, account); if (fp) add('error', 'fake-plug', fp);
  // GHOST PLUG (2026-09-02, docs/glue.md LAW G6). unlinkedSellIssue has existed since the CTA audit
  // was written but only cta-audit.mjs ever called it, so it never ran at the publish gate — which is
  // how Julian 10537749 sat on the shelf selling magnesium over two tweets, closing on "here's what I
  // use.", with no link anywhere. An ask with nothing to click is worse than no ask: it spends the
  // tweet and the trust, and is invisible to every tool here, all of which find plugs by link.
  //
  // A WARN, deliberately, and the split is principled. fakePlugIssue above stays an ERROR because
  // its two shapes are unambiguous: a disclosure token with no URL, and "you can check it out here:"
  // pointing at nothing. THESE shapes are a judgment call — the first sweep across the shelf flagged
  // "If B vitamins have never done anything for you, this is the first thing I would change", which
  // is advice, not an ask. Telling those apart is taste, and docs/glue.md's own rule is that a
  // regex which tries to grade taste rejects good writing. Surface it; let the writer decide.
  for (const u of unlinkedSellIssue(tweets)) add('warn', 'ghost-plug', u);
  // The other half: a product argued across the thread and never asked for at all. A warn — a thread
  // may legitimately discuss a substance it does not sell, and the writer makes that call.
  for (const o of orphanSubstanceIssue(tweets)) add('warn', 'orphan-substance', o);
  for (const w of weldIssue(tweets)) add('warn', 'no-weld', w);
  // A packed numbered block (>=3 marker lines in ONE tweet) is a recap that should be bullets — it
  // reads badly and inflates item counts downstream (labosco 15..28 case).
  tweets.forEach((t, i) => {
    const m = String(t).split('\n').filter((l) => /^[ \t]*\d+[.)]\s/.test(l)).length;
    if (m >= 3) add('warn', 'packed-list', `tweet ${i + 1} packs ${m} numbered lines (recap should be bullets)`, i + 1);
  });

  // A plug = any tweet carrying an affiliate/product link (lvnta or gumroad). Counting by link-presence
  // (not one specific product link) supports multi-product roundups + harvest formats, not just the
  // standard 2-plugs-same-product recreation. (link param kept for back-compat.)
  // Also recognizes the Amazon Attribution rail (2026-08-17): Levanta's mint API now returns direct
  // amazon.com/dp/… URLs carrying `maas=…`/`aa_adgroupid=lv_…` instead of an lvnta.com short link.
  // Without this, a fully-tracked two-plug thread counts as ONE plug and fails plug-count.
  const isPlug = (t) => /lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(t) || AMAZON_ATTR_RE.test(String(t)) || (link && t.includes(link));
  const plugIdx = tweets.map((t, i) => (isPlug(t) ? i : -1)).filter((i) => i >= 0);
  // The one-ask experiment arm is allowed a single plug, and NOTHING else about plugs changes. A
  // control thread that lost a plug by accident still fails here, because the exemption is keyed on
  // the declared arm rather than on the count it produces.
  const minPlugs = arm === 'single-cta' ? 1 : 2;
  if (plugIdx.length < minPlugs) add('error', 'plug-count', `expected >=${minPlugs} plug${minPlugs > 1 ? 's' : ''}, found ${plugIdx.length}${arm ? ` (arm ${arm})` : ''}`);
  for (let k = 1; k < plugIdx.length; k++) if (plugIdx[k] - plugIdx[k - 1] <= 1) { add('error', 'plug-adjacent', 'two plugs are adjacent (need a content tweet between them)'); break; }
  plugIdx.forEach((i) => { if (plugTextLen(tweets[i]) > PLUG_LIMIT) add('warn', 'plug-length', `plug ${i + 1} text over ${PLUG_LIMIT} excl link (${plugTextLen(tweets[i])})`, i + 1); });
  // Own-shop Gumroad links (our ebook) are FIRST-PARTY — no affiliate relationship, so "Get it here:"
  // is the accepted CTA line instead of an affiliate disclosure (operator ebook test 2026-08-08).
  plugIdx.forEach((i) => { const own = /gumroad\.com/i.test(tweets[i]); if (!isDisclosed(tweets[i], { own })) add('error', 'disclosure', `plug ${i + 1} missing ${own ? 'CTA line ("Get it here:")' : 'affiliate disclosure'}`, i + 1); });
  plugIdx.forEach((i) => { if (absoluteSuperlativeIssue(tweets[i])) add('error', 'plug-superlative', `plug ${i + 1} uses an absolute (non-hedged) superlative`, i + 1); });
  // Evidence line must ASSOCIATE, never PROMISE — the deterministic twin of cta.mjs's judge rule
  // (which failed open on any judge exception until #571, so a "proves"/"guarantees" line could ship).
  const evc = evidenceClaimIssue(tweets, { account, plugLinks: [link].filter(Boolean) });
  if (evc) add('error', 'evidence-verb', evc);
  // A CTA is plain prose lines — a leading "1."/"2)" is markdown drift mirrored off the prompt's own
  // checklist. At QC nothing has normalized the post, so this is the only gate that sees it.
  const pnl = plugNumberedLineIssue(tweets, { plugLinks: [link].filter(Boolean) });
  if (pnl) add('error', 'plug-numbered', pnl);
  // Untracked money link (IMPROVEMENTS 2026-07-25): a Gumroad plug whose URL carries no ?ref tag ships a
  // sale we can never attribute — pure margin lost the moment it posts. fix-untracked.mjs already repairs
  // these POST-hoc; this is the PRE-publish gate so an untracked plug never ships in the first place.
  // Levanta short links are exempt by construction (their subid is encoded server-side, so the URL can't
  // reveal tracking) and the generator never mints Gumroad links — this only fires on own-product plugs.
  plugIdx.forEach((i) => { const u = untrackedGumroad(tweets[i]); if (u) add('error', 'untracked-link', `plug ${i + 1} Gumroad link carries no ?ref attribution tag (${u})`, i + 1); });
  // Twin of the above on the Levanta rail: a slug-less lvnta.com URL is a dead link that still reads as
  // a plug, so the thread ships and earns $0 forever (the Knox Callahan monetization-dark signature).
  plugIdx.forEach((i) => { const u = malformedLevanta(tweets[i]); if (u) add('error', 'malformed-link', `plug ${i + 1} Levanta link has no valid slug (${u}) — thread would ship unmonetized`, i + 1); });
  // Third rail of the same family, and the only one that can hide OUTSIDE a plug: a raw retailer URL.
  // Scanned over EVERY tweet, because a bare amazon.com link is not counted as a plug (plugs are found by
  // lvnta/gumroad presence), so it sails past plug-count, disclosure and both link gates while earning $0.
  tweets.forEach((t, i) => { const u = bareCommerceLink(t); if (u) add('error', 'bare-commerce-link', `tweet ${i + 1} carries an untracked retailer link (${u}) — clicks convert but attribute to nobody`, i + 1); });
  const strayFrag = strayPlugFragmentIssue(tweets, { plugLinks: [link].filter(Boolean) }); if (strayFrag) add('error', 'stray-plug-fragment', strayFrag);
  // Cold-open CTA (deterministic twin of cta.mjs's bridge rule, which judgePlug enforces; before #571 it failed OPEN
  // on). WARN, and QC-only — generation already has the judge, and a false positive here must cost an
  // operator line, never a regeneration loop on a revenue plug.
  const bridge = plugBridgeIssue(tweets, { plugLinks: [link].filter(Boolean), skip: [...closingTexts(account), ...disclaimerTexts(account)] });
  if (bridge) add('warn', 'cta-cold-open', bridge);
  // A lone sentence above the ask is the pre-backline shape and it is refused, not warned about
  // (operator 2026-09-06: "this will just waste our money"). Same check validateDraft runs.
  const thin = thinBridgeIssue(tweets, link ? [{ link }] : []); if (thin) add('error', 'thin-bridge', thin);

  if (account.disclaimer && !disclaimerTexts(account).includes(tweets[tweets.length - 1])) add('error', 'disclaimer', `last tweet is not the disclaimer${expected(account.disclaimer, tweets[tweets.length - 1])}`);
  const signoffs = tweets.filter((t) => isSignedTweet(t, account));
  // Required only while laws.json signOff is on. Off (owner R2026-09-26), a thread ends on content and
  // then the disclaimer, so a thread without the sign-off is the shape, not a defect.
  if (signOffOf(account) && !signoffs.length) add('error', 'closing', `missing sign-off${expected(account.closing, tweets[tweets.length - 2])}`);
  // Two sign-offs is a real defect the old detector could not see, because it only matched the FULL
  // account name: a thread closing "With warmth,\n\nTina." did not register, so anything appending
  // the canonical closing stacked a second one right after it. Warn, not error — a shipped thread
  // with a doubled sign-off is embarrassing, not unsafe.
  if (signoffs.length > 1) add('warn', 'double-signoff', `thread signs off ${signoffs.length} times — the persona says goodbye twice`);

  // Hard-claim detector (shared HEALTH_CLAIM_RE via hardHealthClaim). QC keeps this a warn for
  // post-hoc visibility; recreate.mjs's validate() uses the same helper as a generation-time BLOCK.
  tweets.forEach((t, i) => {
    if (isBoilerplate(account, t)) return; // the disclaimer literally says "treat disease" — don't flag our own boilerplate (current or legacy)
    // NAME THE WORD (2026-09-03). "may contain a hard health claim" sends the reader back through the
    // whole tweet guessing which of forty words tripped a regex they cannot see; hardHealthClaimMatch
    // already knows, and the repair prompt has quoted it since 2026-07-20. Costing a session four
    // blind round trips on one tweet whose only sin was "reverse" is what finally moved it here.
    const hm = hardHealthClaimMatch(t);   // boilerplate already returned above
    if (hm) add('warn', 'safety', `tweet ${i + 1} may contain a hard health claim: "${hm}"`, i + 1);
  });
  // A banned TOPIC is an error, never a warn: a hedged cancer thread is still a cancer thread, and
  // QC's job here is to stop it shipping rather than to note it. Read ONCE over the whole thread, because
  // whether a topic is the post's subject (or only a passing idea in a body) is a property of the
  // thread, not of one tweet (owner 2026-09-29; banned-topics.json).
  const btf = bannedTopicFinding(tweets);
  if (btf) add('error', 'banned-topic', btf.tweet ? `tweet ${btf.tweet}: ${btf.message}` : btf.message, btf.tweet || null);
  return issues;
}

// ---- Generation-time draft validation (moved verbatim from recreate.mjs, 2026-07-21 split) ---------
// stripDashes: deterministic dash normalizer — em- AND en-dash both violate the house no-dash rule,
// but a bare character replace would mangle numeric ranges ("5–10" -> "5, 10"), so a range dash
// becomes a hyphen first; only word-separator dashes collapse to a comma. This is the shared core
// qc/cta/swap-product import (previously three byte-identical local copies).
export const stripDashes = (t) => String(t)
  .replace(/(\d[\d.,kKmMbB%]*)\s*[–—]\s*(\d)/g, '$1-$2')  // numeric range (5–10, 500k–1M, 30%–40%) -> hyphen, never a comma
  .replace(/\s*—\s*/g, ', ')                 // em dash between words -> comma
  .replace(/\s*–\s*/g, ', ')                 // en dash between words -> comma
  .replace(/, ,/g, ',');
// stripEmDash: the generation-path variant — dash normalize PLUS strip leading markdown blockquote
// markers ("> ") the model sometimes prefixes onto a line; mid-line comparisons ("x > y") and ">50%"
// (no following space) are untouched. The QC/judge paths deliberately keep the dash-only stripDashes
// (their inputs are existing posts, not fresh LLM output).
export const stripEmDash = (t) => stripDashes(t)
  .replace(/(^|\n)>[ \t]+/g, '$1');
export function ensureDisclosure(tweets, link) {
  const own = /gumroad\.com/i.test(link || ''); // first-party shop: CTA label, not an affiliate disclosure
  return tweets.map((t) => {
    if (!t.includes(link)) return t;
    if (own) return isDisclosed(t, { own: true }) ? t : t.replace(link, `Get it here:\n\n${link}`);
    // The accept side reads BOTH tokens: this branch missed #ad until 2026-08-21 and would have
    // stacked a second disclosure onto every correctly-disclosed new plug.
    return isDisclosed(t) ? t : t.replace(link, discloseBlock(link));
  });
}

// validateDraft (recreate's generation-time BLOCK layer; QC's post-hoc twin is checkThread above).
// Every rule here fails the draft before creation -> the caller repairs or retries, never ships it.
// An error that names the string it wanted (2026-08-29). "last tweet is not the disclaimer" is true
// and useless: the writer has to go back to thread-brief and grep the voice block to find out what
// the disclaimer actually is, which cost a re-run on the 08-31 slate. Quote the expected text and
// what arrived instead, truncated so a 280-char disclaimer does not bury the rest of the report.
const expected = (want, got, n = 72) => {
  const q = (x) => JSON.stringify(String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n));
  return ` — expected ${q(want)}, got ${q(got) || '(nothing)'}`;
};

export function validateDraft(tweets, plugLinks, account, monetized, products = [], { allowUnsold = [], shape = null, firstPlugAt = null, ctaDepth = 1 } = {}) {
  const issues = [];
  // Banned topic first: nothing else about the draft matters if the SUBJECT is off-limits, and a
  // long issue list would bury it.
  const bt = bannedTopicIssue(tweets); if (bt) issues.push(bt);
  // Criterion ORDER is a hard error in both lanes (engine and hand). The missing-criterion case
  // stays a warn elsewhere — a regex cannot recognise every good criterion — but the inverted case
  // is positively detected and never a false positive worth shipping.
  for (const p of (products || [])) {
    if (!p?.link) continue;
    const pi = (tweets || []).findIndex((t) => String(t).includes(p.link));
    // p.donorSlot rides the product row (set by recreate's outline path or a hand-written spec):
    // a plug standing in the donor's own ad slot is judged on THEIR surviving run-up.
    if (pi > 0) { const co = criterionOrderIssue(tweets, pi, p, { donorSlot: !!p.donorSlot }); if (co) issues.push(co); }
  }
  // Thread-length ceiling: raised 20 -> 23 (operator 2026-08-18). The 20 made mold M5 unshippable at
  // its own documented size — "16-20 items", one item per tweet, plus two plugs, reply-bait, sign-off
  // and disclaimer lands at 21-25, so a mold-lane M5 write was rejected before a word of it existed.
  // 23 buys M5 up to 18 items; a 20-item M5 still does not fit and M5's range says so now.
  // The original note stands for everything else (operator 2026-08-10): long threads are punished and usually
  // means the trim/packing rules failed upstream — reject so the retry regenerates shorter. Ideal is
  // 7-13; the FAITHFUL_MAX_ITEMS/SKEL_MAX_ITEMS caps keep normal output well under this backstop.
  const MAX_THREAD_TWEETS = Number(process.env.MAX_THREAD_TWEETS ?? LAWS.tweet.maxThread);
  if (tweets.length > MAX_THREAD_TWEETS) issues.push(`thread too long: ${tweets.length} tweets (max ${MAX_THREAD_TWEETS}) — trim to the strongest items`);
  const over = tweets.map((t, i) => [i, effLen(t)]).filter(([, l]) => l > 280);
  if (over.length) issues.push(`over 280: ${over.map(([i, l]) => `#${i + 1}(${l})`).join(', ')}`);
  if (tweets.some((t) => /[—–]/.test(t))) issues.push('contains em/en dash');
  // Compliance BLOCK (both modes): a curative/disease health claim is an account-suspension risk, so
  // fail the draft at generation (-> run-weekly auto-retry) instead of shipping it for a post-hoc QC warn.
  // Each hit carries the WORD that tripped it — see the QC warn above for why a bare index is not enough.
  const claimy = tweets.map((t, i) => [hardHealthClaimMatch(isBoilerplate(account, t) ? '' : t), i]).filter(([m]) => m);
  if (claimy.length) issues.push(`hard health claim (compliance): ${claimy.map(([m, i]) => `#${i + 1} ("${m}")`).join(', ')}`);
  const ni = numberingIssue(tweets); // the gate that was missing when 9469443 shipped half-numbered
  if (ni) issues.push(ni);
  const dmi = duplicateMarkerIssue(tweets); if (dmi) issues.push(dmi);
  // Unfilled placeholder / hallucinated plug (audit 2026-07-20 #2): template tokens and link-less
  // "Aff link" tweets must never ship — the RAW-stage filter drops them, this is the backstop for
  // anything a later stage (plug writer, judge rewrite) reintroduces.
  const phv = placeholderIssue(tweets); if (phv) issues.push(phv);
  // Prose placeholders (2026-08-17): the classes that evaded the bracket-token regex and shipped
  // live ("NITRIC OXIDE PRODUCT PLUG", "benefit 1 / benefit 2 / benefit 3", a final colon lead-in
  // with no payoff). Mechanically certain shapes only — fail the draft, the caller regenerates.
  const sdv = stageDirectionIssue(tweets); if (sdv) issues.push(sdv);
  const uev = unfilledEnumIssue(tweets); if (uev) issues.push(uev);
  const dlv = danglingLeadInIssue(tweets); if (dlv) issues.push(dlv);
  // Engagement-bait sign-off ("Follow for more") — a content rule, so it gates both modes. Fails the
  // draft -> the caller's repair/retry rewrites that tweet, rather than shipping it for a post-hoc QC flag.
  const gso = genericSignoffIssue(tweets, { account, plugLinks }); if (gso) issues.push(gso);
  // Readability (operator 2026-08-25): no two full sentences stacked in one paragraph.
  //
  // COMMENTED OUT 2026-08-26 on the operator's instruction. The new CTA pod copy
  // (claude/cta-prompt-templates-ps8crz) writes beat 2 as two SPOKEN sentences in one paragraph on
  // purpose — the operator's target shape is "I use X for Y. Now X, Y, Z." — and this gate rejects
  // exactly that. Measured across that branch: 80 of 90 rendered pod-by-frame combinations fail
  // here, 89%. The branch's own podIssues passes them, so the two validators disagreed and its CI
  // could not have warned anyone; it would have surfaced only when a thread tried to publish.
  //
  // stackedSentenceIssue and stackedParagraphs are LEFT IN PLACE and still exported: qc.mjs uses
  // respaceWall to repair spacing, and gate-thread imports stackedParagraphs. Only the hard block
  // is off, so restoring the rule is uncommenting one line.
  //
  // Restore it once the plug's middle beat is exempted rather than the whole thread — that is the
  // narrow fix this replaces, and the sentence-per-line rule is still right everywhere else.
  // const ssi = stackedSentenceIssue(tweets, account); if (ssi) issues.push(ssi);
  if (!monetized) return issues; // client/lightweight mode: no plug/disclosure/disclaimer requirements
  const fpv = fakePlugIssue(tweets, account); if (fpv) issues.push(fpv);
  // A plug is any tweet bearing a tracked plug link — one product appears on two tweets, two products
  // appear on one tweet each; both shapes yield exactly two plug tweets.
  const plugIdx = tweets.map((t, i) => (plugLinks.some((l) => l && t.includes(l)) ? i : -1)).filter((i) => i >= 0);
  // Plug count is budget-driven, not fixed at 2 (operator 2026-08-17: a 5-product roundup plugs
  // all five). Budget = the length table, or one-per-product on a 3+ product roundup.
  const distinctProducts = new Set(products.map((p) => p?.asin).filter(Boolean)).size;
  const budget = plugBudget(tweets.length - plugIdx.length, { products: distinctProducts });
  if (plugIdx.length < 1) issues.push('no plugs — a monetized thread must ask at least once');
  if (plugIdx.length > budget) issues.push(`${plugIdx.length} plugs exceeds the budget of ${budget}`);
  // Never two asks back to back: the reader must get a give between them, at any plug count.
  for (let k = 1; k < plugIdx.length; k++) if (plugIdx[k] - plugIdx[k - 1] <= 1) issues.push(`plugs are adjacent (#${plugIdx[k - 1] + 1} and #${plugIdx[k] + 1})`);
  // ...and the FIRST ask must land in the proven early window (operator 2026-08-25). The engine lane
  // clamps here via plugPositions; the hand lane had no check at all, which is how nine drafts in a
  // row shipped with the plug at tweet 5+.
  const fpi = firstPlugIssue(tweets, plugIdx, { shape, firstPlugAt, ctaDepth }); if (fpi) issues.push(fpi);
  // ...and the heavy ask carries its own bridge tweet (operator 2026-08-25).
  const heavyP = (products || []).find((p) => p?.link && String(tweets[plugIdx[0]] || '').includes(p.link)) || null;
  const tai = thinAskIssue(tweets, plugIdx, heavyP); if (tai) issues.push(tai);
  // Operator law 2026-08-17: the tweet before each plug must land on that plug's substance.
  // NEVER-LINK LIST, checked where every lane converges. pick-product filters DENY when it CHOOSES,
  // but the pod path, hand specs and repost re-mints all arrive holding an ASIN somebody already
  // picked, so nothing on those paths consulted the list — 32 plugs on 5 denied ASINs since 1 Aug.
  const dny = denyIssue(products); if (dny) issues.push(dny);
  const psb = plugSubstanceBridgeIssue(tweets, products); if (psb) issues.push(psb);
  // ...and it must be READABLE when they get there: one sentence per line (operator 2026-08-25).
  const bwi = bridgeWallIssue(tweets, products); if (bwi) issues.push(bwi);
  // ...and it must be a BRIDGE, not a lone sentence (operator 2026-09-06). Hard on every path.
  const tbi = thinBridgeIssue(tweets, products); if (tbi) issues.push(tbi);
  // ...and the thread as a WHOLE must sell what it spent its tweets arguing (operator 2026-08-25).
  // Every per-plug gate above can pass while the substance the thread was built around quietly went
  // missing; this is the only check that reads the thread rather than the seam.
  const usi = unsoldSubstanceIssue(tweets, products, { allowUnsold }); if (usi) issues.push(usi);
  // Readability: each plug's text EXCLUDING the link must stay under 255 so the key point lands fast.
  const fatPlug = plugIdx.filter((i) => plugTextLen(tweets[i]) > PLUG_LIMIT);
  if (fatPlug.length) issues.push(`plug text over ${PLUG_LIMIT} (excl link): ${fatPlug.map((i) => `#${i + 1}(${plugTextLen(tweets[i])})`).join(', ')}`);
  // First-party (gumroad ebook) plugs use "Get it here:" — the same label ensureDisclosure applies —
  // an affiliate disclosure would be WRONG there (it's our own product). Mirror that here so
  // validateDraft and ensureDisclosure can't disagree (2026-08-10: Marcos/Jasper ebook drafts failed
  // every slot on 'plug missing affiliate disclosure' for a correctly-labeled own-product plug).
  const disclosed = plugIdx.every((i) => isDisclosed(tweets[i], { own: /gumroad\.com/i.test(tweets[i]) }));
  if (plugIdx.length && !disclosed) issues.push('plug missing affiliate disclosure');
  // Deterministic backstop to judgePlug (which returns ok on any judge exception): an unhedged absolute
  // superlative ("#1", "nothing beats it") fails the draft -> caller regenerates, never ships it.
  const absSup = plugIdx.filter((i) => absoluteSuperlativeIssue(tweets[i]));
  if (absSup.length) issues.push(`absolute (non-hedged) superlative in plug: ${absSup.map((i) => `#${i + 1}`).join(', ')}`);
  // Same deterministic backstop at GENERATION: an evidence line that promises an outcome ("proves",
  // "guarantees", a bare "prevents") fails the draft -> the caller's plug-rewrite/retry redoes that
  // CTA, instead of relying on the LLM judge (fail-open until #571; an unread judge is now a flag).
  const evc = evidenceClaimIssue(tweets, { account, plugLinks });
  if (evc) issues.push(evc);
  // Backstop only — normalizePlugStructure has already stripped the marker by the time a draft reaches
  // here. If one survives (a rewrite path that skipped normalization), fail rather than ship the noise.
  const pnl = plugNumberedLineIssue(tweets, { plugLinks });
  if (pnl) issues.push(pnl);
  // Dead-link BLOCK: a slug-less lvnta.com URL passes the plug-count/link-presence tests but earns $0.
  // Fail at generation -> caller repairs/retries, rather than discovering it as a dark account weeks later.
  const badLink = plugIdx.map((i) => [i, malformedLevanta(tweets[i])]).filter(([, u]) => u);
  if (badLink.length) issues.push(`malformed Levanta link (no slug): ${badLink.map(([i, u]) => `#${i + 1}(${u})`).join(', ')}`);
  // Generation backstop for the raw-retailer-URL leak. The RAW-body filter already drops every URL-bearing
  // tweet pre-splice, so this can only fire on a path that reintroduced one (a judge rewrite, --tweets-file).
  // Phrased with the existing "untracked product link" prefix ON PURPOSE: that is recreate.mjs's
  // `unrepairable` class, so this falls straight through to a clean retry — the repair loop must never be
  // handed a link to rewrite.
  const bareIdx = tweets.map((t, i) => [i, bareCommerceLink(t)]).filter(([, u]) => u);
  if (bareIdx.length) issues.push(`untracked product link (retailer URL): ${bareIdx.map(([i, u]) => `#${i + 1}(${u})`).join(', ')}`);
  // Fragmented plug: an evidence/superlative sentence line emitted as its OWN tweet, detached from the
  // Aff link block. Fail the draft -> caller regenerates, never ships the broken 5-line CTA.
  const strayFrag = strayPlugFragmentIssue(tweets, { plugLinks });
  if (strayFrag) issues.push(strayFrag);
  // Structural backstop for the two unambiguous plug shapes (link stacked onto the disclosure line, link
  // above the disclosure). normalizePlugStructure repairs both, so this only fires on a path that skipped
  // it — and the repair loop re-applies the normalizer rather than burning a fresh generation.
  const psh = plugShapeIssue(tweets, { plugLinks });
  if (psh) issues.push(psh);
  if (account.disclaimer && !disclaimerTexts(account).includes(tweets[tweets.length - 1])) issues.push(`last tweet is not the disclaimer${expected(account.disclaimer, tweets[tweets.length - 1])}`);
  if (signOffOf(account) && !tweets.some((t) => closingTexts(account).includes(t))) issues.push(`missing sign-off${expected(account.closing, tweets[tweets.length - 2])}`);
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Five defect classes found on 2026-08-17 by adversarial readers that were forbidden from opening
// this file. All five survived a checker score of 82-94 and ok=true. They are here because a gate a
// regex can satisfy is not judgement, and every one of these cost real money or real credibility.
// ---------------------------------------------------------------------------------------------

/**
 * ERROR: a commercial ask with NO link in it.
 *
 * lucas 10366631 shipped THREE plug-shaped tweets and only two carried a URL. The third read
 * "This is the NAC I've trusted for years... Get it here:" and then simply stopped. Every tool we
 * own locates plugs by scanning for tracked links, so a sell with no link is not a weak plug — it
 * is INVISIBLE. It spends the reader's attention and the thread's credibility, earns nothing, and
 * no audit, ledger row or revenue join will ever mention it. The repair agent working on that draft
 * counted two plugs for the same reason.
 */
// The wording of a commercial ask, shared by unlinkedSellIssue and the slot assembler — the first
// slot batch shipped a body slot selling with "Get it here:" and no link, and the assembler's
// sell-in-body check missed it because it only knew the DISCLOSURE tokens, not the ask itself.
// "this is the \\w+" alone matched editorial superlatives — "This is the most important mineral you
// carry" was flagged as an unlinked SELL twice (clara 10380964, lucas 10381392), and once the same
// pattern moved into the assembler it would have REJECTED legitimate body prose. An ask needs a
// possessive ("this is my magnesium") or an ownership clause ("this is the NAC I've trusted");
// a bare "this is the <superlative>" is a writer making a point, not a sale.
// THE RECOMMENDATION SHAPES were added 2026-09-02 after two unpublished drafts were found selling a
// product in full and asking for nothing. Julian 10537749 closed two tweets of magnesium copy with
// "Since you'll ask anyway, here's what I use." and no link under it — a sell that spends the tweet,
// the attention and the reader's trust, and cannot earn, because every plug-finding tool in this repo
// locates plugs by scanning for tracked links. None of the shapes above matched it: they were all
// written from the "this is my X" era. These cover the current CTA law's own vocabulary (an "I" plus
// a verb a person would say, docs/thread-laws.md LAW 4), which is exactly what a writer reaches for
// when they mean to plug and then forget the link. They only ever fire on a tweet with NO tracked
// link, so the legitimate closer "this is the one I'm using (#ad):" above a URL is never touched.
const ASK_VERB = 'use|using|take|taking|buy|buying|keep|keeping|run|running|trust|trusting|order|ordering|restock|restocking|reach for|swear by|stick with|go back to';
export const COMMERCIAL_ASK_RE = new RegExp(
  '\\b(get it here|grab it here|this is my\\s+\\w+|this is the\\s+\\w+(?:\\s+\\w+)?\\s+I(?:\'ve| have)?\\s+\\w+|link below|i keep repurchasing|shop it|check it out here'
  + `|here(?:'s| is) what i (?:${ASK_VERB})`
  + `|this is what i (?:${ASK_VERB})`
  + `|(?:this|here) is the one i(?:'m| am)?\\s*(?:${ASK_VERB})`
  + `|the one i(?:'m| am)?\\s*(?:${ASK_VERB})\\s*[:\\u2193]\\s*$`
  + ')\\b', 'i');

export function unlinkedSellIssue(tweets = []) {
  const out = [];
  const ASK = COMMERCIAL_ASK_RE;
  (tweets || []).forEach((t, i) => {
    const s = String(t);
    if ((s.match(/https?:\/\/\S+/g) || []).some(isTrackedLink)) return;   // a real plug, judged elsewhere
    if (/https?:\/\/\S+/.test(s)) return;                                  // some other link, not our business
    // An UNFILLED PLACEHOLDER is a draft waiting for its mint, not a ghost. The whole cover flow
    // writes {{LINK}} and gates BEFORE minting (day-cover §4-5), so firing here would flag every
    // pre-mint draft in the pipeline. placeholderIssue owns the "it shipped with a token still in
    // it" case and reports it far more precisely.
    if (/\{\{[^}]+\}\}/.test(s)) return;
    if (ASK.test(s) || /aff\s*link|#ad\b/i.test(s)) {
      out.push(`tweet ${i + 1} makes a commercial ask with NO link — it sells, costs a tweet, and earns exactly nothing; every plug-finding tool in the repo is blind to it`);
    }
  });
  return out;
}

/**
 * WARN: a substance we sell is ARGUED across the thread and never asked for anywhere near it.
 *
 * The other half of the 2026-09-02 finding (docs/glue.md LAW G6). `unlinkedSellIssue` catches a
 * tweet SHAPED like an ask; this catches the case with no ask shape at all — two or more tweets
 * building the case for a product, and not one of them carrying its link. The thread reads as
 * though it is about to sell and then never does.
 *
 * Deliberately a WARN, and deliberately narrow:
 *  - Symptom-gated terms are excluded outright (SYMPTOM_GATED). "cortisol" and "brain fog" are what
 *    a health thread is ABOUT; treating them as product mentions would fire on nearly everything.
 *  - It needs TWO tweets. One mention is a thread discussing a substance, which is allowed and
 *    common; two is a case being built.
 *  - If ANY tweet naming the substance carries a tracked link, it is asked for and this is silent —
 *    including the case where the ask sits several tweets from the argument, which is a structural
 *    defect the glue pass fixes and a regex would only guess at.
 *
 * Pure. `tweets` in, list of warnings out.
 */
export function orphanSubstanceIssue(tweets = []) {
  const arr = (tweets || []).map((t) => String(t));
  // GROUPED BY ASIN, NEVER BY TERM. BRIDGE maps many words onto one product — magnesium, glycinate
  // and "magnesium glycinate" are all B0CV2SXX5M — and a thread naturally argues in one word and
  // closes in another: three tweets saying "magnesium", then a plug whose criterion line says
  // "glycinate". Per-term this reads as an orphan and fires on a perfectly good thread, which is
  // exactly what it did on its first live run (2026-09-02, on the glue pass's own output).
  const byAsin = new Map();
  for (const [re, asin, gated] of _bridgeRes) {
    if (gated) continue;                       // symptom words are subject matter, not product mentions
    if (!byAsin.has(asin)) byAsin.set(asin, { hits: new Set(), asked: false });
    const rec = byAsin.get(asin);
    arr.forEach((s, i) => {
      if (!re.test(s)) return;
      rec.hits.add(i + 1);
      if ((s.match(/https?:\/\/\S+/g) || []).some(isTrackedLink)) rec.asked = true;
    });
  }
  const out = [];
  for (const [asin, { hits, asked }] of byAsin) {
    if (hits.size < 2 || asked) continue;
    out.push(`${asin}: argued across tweets ${[...hits].sort((a, b) => a - b).join(', ')} and never asked for — give it the ask or cut it to one mention (docs/glue.md LAW G6)`);
  }
  return out;
}

/**
 * WARN: two products are sold and nothing in the thread joins them — the pair has no WELD.
 *
 * docs/glue.md LAW G1 and G5. A pod knows what it sells; it cannot know what thread it landed in, so
 * the tissue between two pods is the one thing no pod can carry and the one thing that decides
 * whether a reader meets one page or a body with two ads in it.
 *
 * WHAT THIS CAN AND CANNOT PROVE, because the difference was paid for. The first version asserted
 * that some tweet between the plugs NAMES BOTH products. Measured against four hand-glued drafts it
 * failed two of them, and clara 10538699 shows why the failure was the check's and not the writing's:
 *
 *     "Clearing it out is only half the job. You just flushed the bad bacteria and the good ones
 *      together, and whatever grows back first decides how the next month feels. That is what a
 *      probiotic is actually for."
 *
 * That IS the weld. It names the probiotic and carries the magnesium by mechanism — "clearing it
 * out", "you just flushed" — which is better than re-naming a product the reader met one tweet ago,
 * and is exactly the restatement the rest of this file forbids. glue.md says a regex grading a
 * handoff would reject good writing; that version did, on the second try.
 *
 * So this checks the one thing that needs no taste: whether the span between two plugs does ANY
 * product work at all. A tweet mentioning either substance — by name, by form, by symptom — clears
 * it. Only a span where NEITHER product appears fires, and that is not a weak weld, it is two ads
 * with the donor's untouched filler between them. Whether a weld is GOOD stays a judgment call, and
 * glue.md is where it is judged.
 *
 * WARN, never error. Measured on the live shelf before shipping — see the test.
 *
 * Skips: fewer than two plugs, two plugs selling the SAME product (not a pair), and adjacent plugs
 * (plug-adjacent already errors on those, and a second complaint about one defect is noise).
 *
 * Pure. `tweets` in, list of warnings out.
 */
export function weldIssue(tweets = []) {
  const arr = (tweets || []).map((t) => String(t));
  const asinsIn = (s) => {
    const out = new Set();
    for (const [re, asin] of _bridgeRes) if (re.test(s)) out.add(asin);   // gated terms COUNT here:
    return out;                                                          // "cortisol" is how a weld
  };                                                                     // names ashwagandha's job
  // A PLACEHOLDER PLUG STILL SEGMENTS THE THREAD. The cover flow gates BEFORE minting, so a plug
  // mid-pipeline carries {{LINK}} rather than a URL. Counting only minted plugs made this read
  // julian 10537749 as one span from tweet 5 to tweet 13 — skipping straight over the unminted plug
  // at 8 that divides it into two ordinary pairs — and report a missing weld on a thread that was
  // glued by hand. Found on the live shelf before this shipped, which is the only reason it is not
  // in the gate that way.
  const plugs = [];
  arr.forEach((s, i) => {
    const minted = (s.match(/https?:\/\/\S+/g) || []).some(isTrackedLink);
    if (!minted && !/\{\{[A-Z_0-9]+\}\}/.test(s)) return;
    plugs.push({ i, asins: asinsIn(s) });
  });
  const out = [];
  for (let k = 1; k < plugs.length; k++) {
    const a = plugs[k - 1], b = plugs[k];
    if (b.i - a.i <= 1) continue;                                  // adjacent: plug-adjacent owns it
    const A = [...a.asins].filter((x) => !b.asins.has(x));
    const B = [...b.asins].filter((x) => !a.asins.has(x));
    if (!A.length || !B.length) continue;                          // same product, or unidentifiable
    const pair = new Set([...A, ...B]);
    const works = arr.slice(a.i + 1, b.i).some((s) => [...asinsIn(s)].some((x) => pair.has(x)));
    if (!works) out.push(`plugs ${a.i + 1} and ${b.i + 1} sell ${A[0]} and ${B[0]}, and not one tweet between them mentions either — that span is the donor's filler, so the two plugs read as two ads (docs/glue.md LAW G1)`);
  }
  return out;
}

/**
 * ERROR: the tweet was cut off mid-sentence.
 *
 * clara 10297330 shipped two numbered items ending "...so you get the compound without the" (277)
 * and "...keeps your nervous system from staying stuck in" (279). Both are UNDER the 280 limit, so
 * every length check passed them. Truncation is not a length violation, it is a length violation's
 * corpse: something trimmed the text to fit and left the sentence open. Ending on a function word
 * with no terminal punctuation, close to the cap, is the signature.
 */
export function truncationIssue(tweet) {
  const s = String(tweet).replace(/https?:\/\/\S+/g, '').trim();
  if (!s) return null;
  if (effLen(tweet) < 240) return null;                 // only a near-cap tweet can be a trim victim
  if (/[.!?:;)"'\]]$/.test(s)) return null;             // properly closed
  const last = (s.split(/\s+/).pop() || '').toLowerCase().replace(/[^a-z-]/g, '');
  const DANGLING = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
    'without', 'from', 'that', 'which', 'your', 'my', 'their', 'is', 'are', 'was', 'were', 'be', 'been',
    'as', 'at', 'by', 'into', 'than', 'then', 'so', 'if', 'when', 'while', 'you', 'it', 'its']);
  return DANGLING.has(last)
    ? `ends mid-sentence on "${last}" at ${effLen(tweet)} chars — under the cap, so no length check fires, but the sentence never closes`
    : null;
}

/**
 * WARN: two plugs that a classifier calls different moves but a reader experiences as one template.
 *
 * julian 10354608's openers classified as admission and objection, so the different-moves rule
 * passed. Read side by side they are one sentence stamped twice: "I kept buying beet powders that
 * tasted like candy and wondered why nothing changed" / "The hardest part was accepting the cheap
 * bottle I had rebought for years was the wrong form." Same confession, same arc, different props.
 * Move LABELS are not the unit a reader perceives; wording is. Measured with the same dice
 * coefficient the hook band uses.
 */
export function openerTwinIssue(tweets = [], plugIdx = [], { limit = 0.34 } = {}) {
  const openers = plugIdx.map((i) => String(tweets[i] || '').replace(/https?:\/\/\S+/g, '').split(/\n{2,}/)[0] || '');
  const out = [];
  for (let a = 0; a < openers.length; a++) {
    for (let b = a + 1; b < openers.length; b++) {
      const sim = hookSimilarity(openers[a], openers[b]);
      if (sim >= limit) {
        out.push(`plugs ${plugIdx[a] + 1} and ${plugIdx[b] + 1} open on the SAME TEMPLATE (${Math.round(sim * 100)}% shared wording) — the move labels differ but a reader meets one sentence twice`);
      }
    }
  }
  return out;
}

/**
 * ERROR: the plug sells a different FORM of the substance than the body argued for.
 *
 * knox 9803814's body makes the case for magnesium GLYCINATE and the plug sells the CITRATE. The
 * substance matches, so every bridge and body-argues check passes happily — and the thread has
 * spent its whole run-up telling the reader to buy something other than the thing behind the link.
 * clara 10297330 managed the inverse: its criterion called raw root powder a lottery while body
 * item 7 told the reader to stir raw root powder into oatmeal.
 *
 * Only forms of the SAME substance are compared; a thread may obviously discuss several substances.
 */
export function formContradictionIssue(tweets = [], plugIndex = -1, product = {}) {
  const plug = String(tweets[plugIndex] || '');
  const body = (tweets || []).filter((_, i) => i !== plugIndex).join('\n');

  // Families whose members are mutually exclusive CHOICES a buyer makes. Each is tied to the
  // SUBSTANCE it belongs to, because a form word alone means nothing: "oxide" is a magnesium form
  // AND half of "nitric oxide", so an untied match reads a citrulline plug as a magnesium plug
  // selling the wrong form. That mistake flagged 5 of 26 threads on the 2026-08-17 batches — the
  // FOURTH time a substance whose name contains a form word has broken a check in this file.
  const RIVALS = [
    { of: ['magnesium'], forms: ['glycinate', 'bisglycinate', 'citrate', 'oxide', 'threonate', 'malate', 'taurate'] },
    { of: ['coq10', 'coenzyme q10'], forms: ['ubiquinol', 'ubiquinone'] },
    { of: ['omega', 'fish oil', 'epa', 'dha'], forms: ['triglyceride', 'ethylester'] },
    { of: ['ashwagandha'], forms: ['ksm66', 'sensoril'] },
    { of: ['vitamin k', 'k2'], forms: ['mk7', 'mk4'] },
    { of: ['collagen'], forms: ['hydrolyzed', 'hydrolysed', 'gelatin'] },
  ];
  // A compound substance name that CONTAINS a form word is masked before anything is matched, so the
  // name can never be read as a form declaration.
  const mask = (t) => String(t).toLowerCase()
    .replace(/nitric\s+oxide/g, ' NITRICOXIDE ').replace(/zinc\s+oxide/g, ' ZINCOXIDE ');
  const formsIn = (s2, forms) => {
    const t = mask(s2).replace(/-/g, '');
    return forms.filter((f) => new RegExp(`\\b${f}\\b`, 'i').test(t));
  };
  const mentions = (s2, names) => names.some((n) => mask(s2).includes(n.replace(/-/g, '')));

  // OPERATOR RULING 2026-08-18: a product carries several forms and descriptors at once, so the test
  // is not "does anything in this thread disagree" but "does the plug match WHAT WE ARE SELLING". If
  // any form named in the plug matches the product's own title, the plug is honest and the check is
  // done — whatever else the body discusses. Only when the plug names a form the product does NOT
  // have is the reader being handed something other than what they were sold.
  const title = String(product.title || '');
  for (const fam of RIVALS) {
    if (!mentions(plug, fam.of) && !mentions(title, fam.of)) continue;
    const inPlug = formsIn(plug, fam.forms);
    const inTitle = formsIn(title, fam.forms);
    if (inPlug.length && inTitle.length && inPlug.some((f) => inTitle.includes(f))) continue; // one subset matches — good enough
    const inBody = formsIn(body, fam.forms).filter((f) => !inPlug.includes(f));
    if (!inPlug.length || !inBody.length) continue;
    // The body may legitimately name the rival in order to REJECT it — that is the criterion beat
    // doing its job, not a contradiction. So may the plug.
    const rejected = (txt, f) => new RegExp(`(not|skip|avoid|instead of|rather than|versus|vs\\.?|cheap|wrong|barely|mostly passes)[^.]{0,40}${f}|${f}[^.]{0,40}(mostly passes|barely absorbs|is the wrong|does not|is cheap)`, 'i').test(txt);
    const live = inBody.filter((f) => !rejected(body, f) && !rejected(plug, f));
    if (live.length) {
      return `sells the ${inPlug[0]} while the body argues for ${live[0]} — same substance, rival form; the run-up talked the reader into a different purchase than the link`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// originEchoIssue(potTweets, originTweets, opts) — how much of a POT is its origin body, verbatim.
//
// WHY (2026-09-04). A pot is a filled skeleton, so some echo is correct and some is the point: the
// beats a seed's Mechanics marks NEVER CHANGE are supposed to survive word for word. But nothing
// measured it. Asked how similar the first ten pots were, the answer had to be computed by hand:
// 2-24% of sentences verbatim, and one clover pot reused five of its origin's eight items nearly
// whole. Three such pots running in one week is something a reader could notice, and no gate in the
// pipeline looks at it — they check length, plugs, criteria, bridges and numbering, and would pass
// a pot that was 80% its origin.
//
// Counts SENTENCES rather than words, because a sentence is the unit a reader recognises. Short
// fragments (<4 words) are ignored — "Every single day." is shared vocabulary, not a lifted beat.
// Pure and offline: the caller supplies the origin text.
export function originEchoIssue(potTweets = [], originTweets = [], { maxPct = 35, warnPct = 25 } = {}) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = (arr) => (arr || [])
    .flatMap((t) => String(t).split(/\n+/))
    .flatMap((l) => l.split(/(?<=[.?!])\s+/))
    .map((x) => x.trim())
    .filter((x) => norm(x).split(' ').filter(Boolean).length >= 4);

  const mine = sentences(potTweets);
  if (!mine.length) return null;
  const theirs = new Set(sentences(originTweets).map(norm));
  if (!theirs.size) return null;

  const echoed = mine.filter((x) => theirs.has(norm(x)));
  const pct = Math.round((echoed.length / mine.length) * 100);
  if (pct < warnPct) return null;
  const sample = echoed.slice(0, 3).map((x) => `"${x.slice(0, 56)}"`).join(', ');
  return pct >= maxPct
    ? `pot is ${pct}% its origin verbatim (${echoed.length}/${mine.length} sentences, ceiling ${maxPct}%) — rewrite the free beats: ${sample}`
    : `pot is ${pct}% its origin verbatim (${echoed.length}/${mine.length} sentences) — under the ${maxPct}% ceiling but worth a look: ${sample}`;
}

// ---------------------------------------------------------------------------------------------
// hookShapeIssue(potTweets, originTweets, opts) — does a pot's HOOK still have its origin's shape?
//
// WHY (operator, 2026-09-05: "make sure our new hooks are relatively similar to the original —
// follow the gates and similarity check per line"). T1 is the most load-bearing tweet a body has:
// Kim's took 2,474,448 views, and roughly 95% of everyone who ever sees the thread sees only it.
// The seed's job is to carry that shape forward, and twice in one day the shape drifted without a
// single gate noticing, because a wrong-but-legal hook passes every existing check:
//   · sage v1 opened on a problem reframe in sentence case, where the origin opens on a PROMISE in
//     full caps followed by a caps parenthetical.
//   · clover v1 grew a fourth line the origin never had.
// Both were caught by the operator reading them, which is exactly the review this replaces.
//
// MEASURES SHAPE, NOT WORDS. A pot must differ from its origin in content — different substances,
// different authority, different angle — so word overlap is the wrong instrument and would punish
// correct work (originEchoIssue already guards the opposite direction). What has to survive is the
// STRUCTURE: how many lines, the register of each, whether a line is a parenthetical aside, whether
// the numbered item marker is there.
//
// HARD findings (returned): line count, caps register, marker presence, parenthetical presence.
// ADVISORY (returned with `advisory: true`): gross per-line sentence-count and length deltas.
// STATED LIMIT: this does NOT catch a dropped clause. olive v1 lost its origin's three-step
// escalation and the fixed version has the same sentence count as the broken one, so any threshold
// that "caught" it would fire just as loudly on correct work. Semantic beats are a reader's job —
// what this guarantees is that line count, register, markers and parentheticals cannot drift
// unnoticed, which is what happened to sage and clover.
const capsRatio = (s) => {
  const letters = String(s).replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return null;               // too short to have a register
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
};
const lineSig = (line) => ({
  caps: capsRatio(line),
  paren: /^\s*\(.*\)\s*$/.test(String(line).trim()),
  marker: /^\s*\d{1,2}[.)](\s|(?=[A-Za-z"'“(]))/.test(String(line)),
  sentences: foldListMarkers(line).split(/(?<=[.?!])\s+/).filter((x) => x.trim()).length,
  len: String(line).trim().length,
});

// ── hookClauseIssue — the promise resolves to a NOUN, not to a scene ─────────────────────────
//
// Operator, 2026-09-19, on a live clover pot: "the 8 things that decide whether you need a coffee
// to finish the day" → "the 8 things that decide your cellular energy and happiness".
//
//   "It's clearer, more outcome focused, and NOT the visual metaphor that people have to envision.
//    More straightforward is better."
//
// Both point at the same thing; only one states it. A `whether…` clause hands the reader a little
// film to run — a coffee, a staircase, a month — and they have to decode it back into the thing
// they actually want before they know the thread is for them. The hook is the one tweet that
// cannot afford that step.
//
// This is family-independent, which is why it is not in hookDeviceIssue: any hook that promises
// "the N things that decide X" can fill X with either a noun or a clause, whatever seed it came
// from. Four clover v3 pots shipped the clause form — afternoon, breath, february, strength —
// because clover's {DOMAIN} slot said nothing about its grammar (clover v4 now does).
//
// WIDENED 2026-09-19, same day, on the operator's second reading: "avoid this type of drifting and
// metaphorical visual writing — what we want is the doctor-diagnosis type. Specific, concise, and
// naming the problem, benefits, solution clearly."
//
// `whether`/`if` was only the shape that happened to ship. A census of all 907 hooks in queues/
// found 48 carrying a promise verb, and the split falls exactly along the operator's own test:
//
//   SCENE, opens with a subordinator — 10 distinct, 24 uses     NOUN — 6 distinct, 24 uses
//     how well you age                        7x                  your quality of life          8x
//     how sharp you are at 60                 3x                  your energy, focus, and mood  4x
//     how much stress you actually carry      3x                  your winter energy and mood   3x
//     whether you keep your muscle after 50   2x                  your cellular energy …        3x
//     who is still well at eighty             1x                  your strength and indep…      3x
//     how you sleep: · how often you get sick: · whether … (×3 more)
//
// Every one on the left fails "I want ___" and every one on the right passes it. So the rule is not
// about the word `whether` — it is that the promise must land on a NOUN. A subordinator opening the
// filler is a finite clause behind it, which is a scene the reader has to run and decode back into
// the thing they wanted.
//
// STILL NARROW. It reads only the filler that follows a promise verb, so 24 of 907 hooks (2.6%)
// fire — not the "most of them" that turns a gate into noise. A subordinator anywhere else in the
// hook is untouched, because clover's own item 4 is legitimately "Whether anything you do in a week
// is actually hard".
//
// POT AND SEED ONLY — do NOT call this from a cover or harvest gate. Of the 24, seventeen are
// clover pots and one is a seed skeleton: ours, and the defect. The other six are not ours to
// change. Four are one harvest body's own hook ("how well you age"), and a harvest is a VERBATIM
// re-run of a body that already earned — rewording it is the one thing that lane forbids. Two are
// covers, where the 85-90% law makes the donor's hook shape the asset being bought. Its only caller
// is pot-echo, which is why the scoping holds today; widening the caller list breaks it.
const HOOK_CLAUSE_RE = /\b(decides?|decided|determines?|controls?|predicts?|dictates?)\s+(whether|if|how|why|what|who|where|when|that)\b/i;

/** PURE. Advisory. The hook's promise must land on the outcome itself, not on a scene that implies
 *  it. Returns [] or one finding naming the clause and the test that settles it. */
export function hookClauseIssue(tweets = []) {
  const t1 = String((tweets || [])[0] || '');
  const m = t1.match(HOOK_CLAUSE_RE);
  if (!m) return [];
  const at = t1.indexOf(m[0]);
  const clause = t1.slice(at, at + 90).split('\n')[0].replace(/\s+/g, ' ').trim();
  return [{
    advisory: true,
    msg: `the promise resolves to a clause, not the outcome: "…${clause}…" — name the thing the `
      + `reader wants as a NOUN, the way a diagnosis names it. Test it: it has to follow `
      + `"I want ___". "I want my strength and independence after 50" reads; "I want whether I keep `
      + `my muscle" and "I want how well you age" do not.`,
  }];
}

// ── platformHookDriftIssue — the cross-posted copy is a SECOND place the hook lives ──────────
//
// A draft's platform copies are built once, from one spec: buildPlatforms takes the same posts and
// swaps only the links, so at CREATE time X and Threads carry a byte-identical hook. They can only
// diverge later, and later is where every repair happens.
//
// 2026-09-19, the day the clause rule landed. The four clover pots were repaired on
// `platforms.x.posts` alone, because that is the array every tool in this repo reads. Five drafts
// kept the struck hook on Threads — one of them scheduled and 6 hours out — and nothing reported
// it, because nothing here had ever looked at a cross-posted copy. `hookClauseIssue` was clean on
// all five: the SPEC was right, and the spec is not what ships.
//
// So this checks an invariant rather than a sentence. Whatever the hook says, every enabled
// platform has to say the same thing — that is true of the clause rule, of the device rule, and of
// every writing rule that will ever be added, which is why it is worth a check of its own.
//
// LINKS ARE EXEMPT BY DESIGN. Each platform gets its own minted "-th"/"-li" subid twin
// (cross-post-links.mjs), so a raw URL comparison would fire on every correctly cross-posted money
// thread. URLs are masked to their platform-independent shape before comparing; nothing else is.
//
// HARD, not advisory. A hook that differs between platforms is never a writing call someone made —
// it is half a repair.
//
// MEASURED 2026-09-19 over every live and published draft the fleet holds: 869 of 1098 are
// cross-posted and 43 of those have drifted — 4.9%, across pot (7), cover (17), harvest (12),
// single (6) and cta1 (1). Low enough to be signal rather than the permanent-dirty noise this file
// keeps refusing, and spread across every lane, so it is not one tool's bug.
//
// It is one gap, though. `rebuildCrossPosts` (platforms.mjs) was written on 2026-08-31 to carry a
// repaired X copy onto the cross-post keeping each platform's own links, and it has NO production
// caller — seven repair tools still patch with `{ existing }` alone: qc, fix-draft, swap-product,
// repair-drafts, fix-untracked, self-qrt-topup, sync-cta-drafts. Until they are wired, this check is
// what makes the drift they leave visible.
const maskLinks = (s) => String(s || '').replace(/https:\/\/\S+/g, '«link»').replace(/\s+/g, ' ').trim();

/** PURE. Every enabled cross-post platform must carry X's hook verbatim, links aside. Takes a
 *  Typefully draft's `platforms` object. Returns [] or one finding per drifted platform. */
export function platformHookDriftIssue(platformsObj = {}) {
  const x = platformsObj?.x;
  if (!x?.enabled || !Array.isArray(x.posts) || !x.posts.length) return [];
  const want = maskLinks(x.posts[0]?.text);
  if (!want) return [];
  const out = [];
  for (const p of CROSS_POST_PLATFORMS) {
    const cfg = platformsObj?.[p];
    if (!cfg?.enabled || !Array.isArray(cfg.posts) || !cfg.posts.length) continue;
    const got = maskLinks(cfg.posts[0]?.text);
    if (got === want) continue;
    out.push({
      platform: p,
      msg: `the ${p} copy's hook has drifted from X's — a repair touched one platform and not the `
        + `other.\n       x      : ${want.slice(0, 160)}\n       ${p.padEnd(7)}: ${got.slice(0, 160)}`,
    });
  }
  return out;
}

// ── hookDeviceIssue — the FAMILY'S OWN hook grammar, which hookShapeIssue cannot see ─────────
//
// hookShapeIssue compares a pot's T1 to its origin on line count, caps register, numbered markers
// and parentheticals. All four are properties of the LAYOUT. A hook can match every one of them
// and still have thrown away the sentence form the family converts on, because that form lives
// inside a line rather than between them.
//
// Measured 2026-09-17, when the operator named beet's device: 3 of the 8 beet pots had already
// broken it and every one had passed hookShapeIssue clean. The rule had been written into beet's
// Mechanics, its skeleton, its NEVER CHANGE list and the pot skill — four places, all prose, all
// unenforced. That is the third time in one session a writing rule reached the pot lane as prose
// and was broken anyway (see pot/SKILL.md 2c, 2e). Prose binds whoever reads it; this binds the lane.
//
// ADDING A FAMILY: only declare a form that is (a) written into that seed and (b) mechanically
// decidable. A check that fires on most existing pots is not a gate, it is noise that teaches
// people to ignore the runner — maple's hook is ONE sentence in the origin and TWO in 10 of its
// 11 pots, so that reading is deliberately NOT here.
const DEVICE_PICTURE_VERBS = /\b(tanks?|tanked|fades?|faded|flattens?|flattened|sinks?|climbs?|plummets?|crashes?|melts?|spirals?)\b/i;

export function hookDeviceIssue(tweets = [], family = null) {
  const fam = String(family || '').toLowerCase();
  const t1 = String((tweets || [])[0] || '');
  if (!t1 || !fam) return [];
  const out = [];

  // beet — A DOCTOR LISTING. Operator, 2026-09-17: each {SCARY_n} is "your {part} {verb}".
  // The possessive is the device: it makes the line a diagnosis OF THE READER rather than a
  // description of their day. beet v3 carries the definition; this enforces it.
  if (fam === 'beet') {
    const m = t1.match(/Without it,\s*([^"\n]+?)\.\s*"/);
    if (m) {
      const clauses = m[1].split(/,\s*(?:and\s+)?/).map((c) => c.trim()).filter(Boolean);
      const bare = clauses.filter((c) => !/^your\s/i.test(c));
      if (bare.length) {
        out.push({ advisory: false, msg: `the run is a doctor listing — every clause is "your {part} {verb}", but ${bare.length} of ${clauses.length} names no owner: ${bare.map((c) => `"${c}"`).join(', ')}. Without the possessive it is a description of the reader's day, not a diagnosis of their body.` });
      }
      const pics = clauses.filter((c) => DEVICE_PICTURE_VERBS.test(c));
      if (pics.length) {
        out.push({ advisory: true, msg: `picture verb in the run: ${pics.map((c) => c.match(DEVICE_PICTURE_VERBS)[0]).join(', ')} — {verb} is present tense and plain (thins, aches, slips, drops, breaks). An hour or a number rides inside the clause instead.` });
      }
    }
  }

  // maple — the before-state is a list of predicates on "I", then the target. The origin spends
  // exactly ONE list-level "and", the one that introduces the goal. A second makes the reader
  // hit what sounds like the end of the sentence and then get another clause. Fires on none of
  // the 11 existing pots and on every rewrite the operator called hard to read.
  if (fam === 'maple') {
    const line1 = t1.split('\n')[0];
    const ands = (line1.match(/,\s+and\s+/g) || []).length;
    if (ands > 1) {
      out.push({ advisory: false, msg: `the hook spends ${ands} list-level ", and" — the origin spends one, the one that introduces the target. Use commas for the before-state list and save "and" for the goal.` });
    }
  }

  return out;
}

export function hookShapeIssue(potTweets = [], originTweets = [], { capsDelta = 0.35 } = {}) {
  const mine = String((potTweets || [])[0] || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const theirs = String((originTweets || [])[0] || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!mine.length || !theirs.length) return [];
  const out = [];

  if (mine.length !== theirs.length) {
    out.push({ line: null, advisory: false,
      msg: `hook has ${mine.length} line(s), its origin has ${theirs.length} — the hook's shape is the beat that earned; add or drop a line only for a measured reason` });
  }

  for (let i = 0; i < Math.min(mine.length, theirs.length); i++) {
    const a = lineSig(mine[i]), b = lineSig(theirs[i]);
    if (a.caps !== null && b.caps !== null && Math.abs(a.caps - b.caps) > capsDelta) {
      out.push({ line: i + 1, advisory: false,
        msg: `line ${i + 1} register differs: ${Math.round(a.caps * 100)}% caps vs the origin's ${Math.round(b.caps * 100)}% — caps are part of the shape` });
    }
    if (a.marker !== b.marker) {
      out.push({ line: i + 1, advisory: false,
        msg: `line ${i + 1} ${a.marker ? 'adds' : 'drops'} the numbered item marker the origin ${b.marker ? 'has' : 'does not have'}` });
    }
    if (a.paren !== b.paren) {
      out.push({ line: i + 1, advisory: false,
        msg: `line ${i + 1} ${a.paren ? 'adds' : 'drops'} the parenthetical aside the origin ${b.paren ? 'has' : 'does not have'}` });
    }
    // Threshold 2, not 1, and the message claims nothing about semantic beats. A first cut fired on
    // a delta of 1 and "caught" olive's dropped escalation — but it fired IDENTICALLY on the fixed
    // version, so it carried no information about the thing it named. A per-line count cannot see a
    // dropped CLAUSE; only a reader can. This speaks now only when a line has grossly gained or lost
    // structure, and says just that.
    if (Math.abs(a.sentences - b.sentences) >= 2) {
      out.push({ line: i + 1, advisory: true,
        msg: `line ${i + 1} has ${a.sentences} sentence(s) against the origin's ${b.sentences}` });
    }
    if (b.len > 0 && (a.len / b.len < 0.4 || a.len / b.len > 2.2)) {
      out.push({ line: i + 1, advisory: true,
        msg: `line ${i + 1} is ${a.len} chars against the origin's ${b.len}` });
    }
  }
  return out;
}

// ---- CROSS-POST INTEGRITY -----------------------------------------------------------------------
// Nothing in the repo has ever inspected a cross-posted copy: qc, link-sentinel, validate-thread,
// audit-drafts and check-links are all X-only. That was survivable while Threads was decorative. It
// is not survivable now that Levanta "-th" clicks are the ONLY signal the channel has — with the
// Meta insights API deliberately out of scope, a copy that quietly stops being separable takes the
// whole measurement with it and looks exactly like a healthy one in every report.
//
// Three faults, in descending order of how silent they are:
//   collapsed   — an lv_ id present in BOTH X and the copy. The split is gone: those clicks merge
//                 into X and no report can ever separate them again. This is the regression alarm
//                 for every repair path that patches with `{ existing }`.
//   diverged    — the copy has a different number of posts from X, so a repair reshaped one and not
//                 the other. Julian's 10243320 PUBLISHED 11 posts on X and 9 on Threads.
//   undisclosed — a plug on the copy carrying an affiliate link without the disclosure. qc inserts
//                 that disclosure into X only, so the copy can go out non-compliant. This one is a
//                 legal exposure rather than a measurement one.
//
// Pure and report-only: it names faults, it never repairs. Reuses isDisclosed rather than adding a
// second matcher for the same rule.
export function crossPostIntegrity(platforms, { own = false } = {}) {
  const xPosts = platforms?.x?.posts;
  if (!Array.isArray(xPosts)) return [];
  // Through lib's canonical reader, never a local regex: a tracked link can carry its real id in
  // ?aa_adgroupid=, and reading the first lv_ in the string picks up the campaign instead — the bug
  // the grep-guard in the scaffolds exists to stop shipping an eleventh time.
  const idsOf = (posts) => (posts || [])
    .flatMap((p) => String(p?.text ?? '').match(/https?:\/\/\S+/g) || [])
    .map((u) => lvIdOf(u))
    .filter(Boolean);
  const xIds = new Set(idsOf(xPosts));
  const issues = [];
  for (const name of CROSS_POST_PLATFORMS) {
    const pf = platforms?.[name];
    if (!pf?.enabled || !Array.isArray(pf.posts)) continue;
    const shared = [...new Set(idsOf(pf.posts))].filter((id) => xIds.has(id));
    if (shared.length) issues.push({ platform: name, kind: 'collapsed', ids: shared });
    if (pf.posts.length !== xPosts.length) issues.push({ platform: name, kind: 'diverged', x: xPosts.length, had: pf.posts.length });
    const bare = [];
    pf.posts.forEach((t, i) => {
      const text = String(t?.text ?? '');
      if (!/lvnta\.com|gumroad\.com|levanta|geni\.us\//i.test(text)) return;   // only affiliate rails need it
      if (!isDisclosed(text, { own })) bare.push(i + 1);
    });
    if (bare.length) issues.push({ platform: name, kind: 'undisclosed', posts: bare });
  }
  return issues;
}
