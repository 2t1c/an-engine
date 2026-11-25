// pods.mjs — the CONVERSION POD library.
//
// A pod is a self-contained 3-tweet selling unit: POINT -> BRIDGE -> PLUG. It carries its own setup,
// so it can be dropped into any topically-compatible thread and the rest of the thread is free.
//
// Why this exists (operator 2026-08-21). We were writing the selling half of every thread fresh,
// every time, and re-rolling the dice on a solved problem. Worse, the LAW says the bridge must end
// on the plug's substance and hand over a buying criterion — which meant deriving it from whatever
// the host thread happened to say. That is our single biggest defect class (34 drafts repaired for
// exactly it). A pod inverts the dependency: because the POINT tweet introduces the substance and
// the BRIDGE hands over the criterion, the run-up rule ("substance named in 2 of the 3 tweets before
// the plug") is satisfied INSIDE the pod. The gate goes from "hope the thread supports it" to
// "true by construction".
//
// Mirrors molds deliberately: molds.json/mold-promote.mjs shape the THREAD, pods.json/this module
// sell inside it, and both use the same measured promotion loop (experimental -> proven -> retired)
// joined on ledger revenue.
//
// ---- THE THREE ELEMENTS -------------------------------------------------------------------------
//   POINT   tweet A. Names the substance and makes the case for it, ACTIONABLY — the dose, the form,
//           how long before it does anything. "Take 600mg for eight weeks" is a point; "ashwagandha
//           lowers cortisol" is a claim. This is the "point" that used to have to come from the host
//           thread. OPTIONAL: a pod with no point is a 2-TWEET pod (bridge + plug), which is lighter
//           to drop in but gives up the run-up guarantee — see requiresHostMention below.
//   BRIDGE  tweet B. Names the substance and hands over the CRITERION — the buying rule the reader
//           carries into the plug ("look for the glycinate form; oxide mostly passes through").
//           It used to say "ENDS on the substance", which was true of the classic library (9 of 17)
//           and is true of none of the 18 framed bridges: those close on the hand-off instead ("So
//           here's what to look for ↓") and let the PLUG answer with the form to buy. The gate was
//           never the stricter thing — plugSubstanceBridgeIssue asks only that the substance appear
//           SOMEWHERE in the tweet before the plug, and both libraries pass it 100%. Corrected
//           2026-08-30 so the sentence describes what ships.
//   PLUG    tweet C. opener / middle / CTA line ending in a colon / #ad / bare link.
//
// ---- LOCKED vs FREE, and the variation rule -----------------------------------------------------
// Every pod ships ONE argument and MANY renderings of it — one per account. What may vary is the
// point of the whole design, so it is enforced rather than trusted:
//
//   LOCKED  the criterion, the substance, the product (asin + link), the opener move, the beat
//           count, and the #ad + link block. These are what make the pod convert. If they drift,
//           the variants are different pods and should be separate rows.
//   FREE    every other word. The struggle, the time-stamp, the outcomes named, sentence order,
//           connectives, the CTA's phrasing.
//
// The FREE half must be genuinely REWRITTEN, not nudged. A near-duplicate detector — ours included
// — compares word shingles, so a copy with a few synonyms swapped scores as a duplicate: our own
// fill-queue dedup flags anything at Dice >= 0.72 and would catch a lightly-edited sibling. Nine
// pages posting near-identical plug copy AND the identical URL is a stronger duplicate signal than
// the repeated hooks we already refuse to schedule. So variants of one pod must score BELOW
// POD_VARIANT_MAX against each other: same argument, same criterion, same product, different prose.
import { readFileSync } from 'node:fs';
import { hookSimilarity, plugStructure, plugTextLen, PLUG_LIMIT, effLen, bannedTopicIssue, TWEET_LIMIT, BRIDGE, substanceTermsFor, titleSubstances, gluedParagraphs, airyParagraphs, stackedParagraphs, wordIn } from './checks.mjs';
import { DISCLOSURE, DISCLOSURE_LINE_RE } from './disclosure.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { loadCtaLearningPolicy, selectLearnedSkeletonSlots } from './cta-learning-policy.mjs';

// The live monetized roster, the population that actually draws from the shared pools. Loaded here
// because pool assignment became roster-aware on 2026-08-31 (see variantFor): capacity per wording
// is only definable against a roster. accounts.mjs imports nothing of ours, so the edge is acyclic.
const LIVE_ROSTER = Object.values(ACCOUNTS)
  .filter((a) => !a.paused && a.socialSetId && a.levantaSubidPrefix).map((a) => a.key);

// Dice ceiling between any two variants of ONE pod. Set well under fill-queue's DUP_HOOK (0.72) so a
// pod variant can never trip our own near-duplicate guard: if the library itself produced text our
// scheduler would refuse, the library is the bug.
export const POD_VARIANT_MAX = 0.55;

// Recommendation verb required in the CTA line (operator 2026-08-19). Same law as everywhere else;
// imported here rather than re-derived so a change to the CTA law reaches pods too.
export { ctaStyleOf } from './unschedule-old-plugs.mjs';

const RAW = JSON.parse(readFileSync(new URL('./pods.json', import.meta.url), 'utf8'));
export const POD_THRESHOLDS = RAW.meta.thresholds;
export const PODS = RAW.pods;

// THE VOCABULARY THAT COUNTS AS NAMING A SUBSTANCE (2026-08-30).
//
// podIssues used to ask whether the copy contained pod.substance as a raw substring. Production asks
// something different and stricter: plugSubstanceMismatch matches the plug against titleSubstances of
// the LINKED PRODUCT'S TITLE, and runUpIssue matches the run-up against substanceTermsFor(product).
// The two disagreed in both directions on the 2026-08-30 slate — twelve pods were flagged for "never
// names the substance" where only five would actually have been rewritten in production, and O1's
// plug ("EPA and DHA") satisfied the pod's own key while failing the title check that decides.
// A check that is not the one production runs is worse than no check: it costs copy edits that buy
// nothing and hides the five that matter. So resolve the real product and judge by its title.
let CATALOG = null;
export function podProduct(pod) {
  if (!pod?.asin) return null;
  if (!CATALOG) {
    try { CATALOG = new Map((JSON.parse(readFileSync(new URL('./products.json', import.meta.url), 'utf8')).products || []).map((p) => [p.asin, p])); }
    catch { CATALOG = new Map(); }
  }
  return CATALOG.get(pod.asin) || null;
}
/**
 * Every word that counts as naming what this pod sells — the linked product's own title vocabulary
 * (substanceTermsFor, which is what runUpIssue matches), plus the pod's declared substance, forms and
 * ownTerms. Exported so podIssues, the tests and any future caller share ONE definition: a bare
 * `.includes(pod.substance)` reported TH1's bridge as silent because it says "ordinary magnesium"
 * rather than "threonate", and E1's plug because it says "potassium" — both of which production reads
 * as naming the substance.
 */
export function podSubstanceNames(pod) {
  const prod = podProduct(pod);
  return [...new Set([
    ...(prod ? substanceTermsFor(prod) : []),
    pod?.substance, ...(pod?.forms || []), ...(pod?.ownTerms || []),
  ].filter(Boolean).map((x) => String(x).toLowerCase()))];
}

export const podById = (id) => PODS.find((p) => p.id === id) || null;
export const provenPods = () => PODS.filter((p) => p.status === 'proven');
export const experimentalPods = () => PODS.filter((p) => p.status === 'experimental');

// Pods eligible for a host thread on `topic`. A pod is thread-agnostic but NOT topic-agnostic: a
// magnesium pod dropped into a liver thread reads as an ad break however good the copy is.
export function podsForTopic(topic, { status = null } = {}) {
  const t = String(topic || '').toLowerCase();
  return PODS.filter((p) => p.status !== 'retired')
    .filter((p) => !status || p.status === status)
    .filter((p) => (p.topics || []).some((x) => String(x).toLowerCase() === t));
}

// The variant this account should run. Every account gets its own rendering; falling back to another
// account's copy would reintroduce the exact duplication the variants exist to prevent, so this
// returns null rather than borrowing.
// SHARED VARIANTS (operator 2026-08-23: "the client voice would be friction that's unnecessary").
// A variant with account "*" belongs to a shared rotation pool any account may render. The plug is
// 2-3 tweets of a 14-tweet thread — the persona lives in the BODY the writer still writes in-voice,
// so shared plug prose is fine PROVIDED it contains no account-specific scene ("my knees on leg
// day" on nine feeds is the same fabricated life nine times). Shared middles stay first-person but
// generic. An account-specific variant, where one exists, always outranks the pool — flagship
// wording is an override, not a casualty.
//
// The pick from the pool is DETERMINISTIC per (pod, account): one page always posts one wording
// (consistency if a reader scrolls the account), while different accounts spread across the pool —
// which, with the planner's 2-accounts-per-source-per-day cap, is what keeps the same ad off two
// feeds on the same day.
/**
 * Would this pod's copy be TRUE of this product? The gate for substance-level matching: the product
 * must be recognized as the pod's substance (full-title vocabulary, via substanceTermsFor), and its
 * title must carry every declared buy-form word. The forms field exists because substance alone
 * lies: the threonate bottle's title contains "magnesium", and without the forms check the glycinate
 * pod's criterion ("glycinate absorbs, oxide passes through") would ship over a bottle containing
 * neither. Explicit forms, never criterion parsing — the criterion prose names the AVOID-form too.
 */
export function podFitsProduct(pod, product) {
  const sub = String(pod?.substance || '').toLowerCase();
  const title = String(product?.title || '').toLowerCase();
  const forms = (pod?.forms || []).map((f) => String(f).toLowerCase());
  // Every DECLARED form must be on the label, always. This is the half that stops a ubiquinol pod
  // fitting a plain ubiquinone bottle.
  //
  // WORD BOUNDARIES, not substring (2026-08-26). "Bisglycinate" on a ZINC label contains the string
  // "glycinate", so the magnesium-glycinate pod J1 fitted Organic Liquid Zinc Drops — caught by the
  // catalog-wide invariant below, and the same substring class as `dha` matching inside
  // "ashwagandha". A form word like glycinate is shared across minerals; only the whole word means
  // anything.
  if (!forms.every((f) => wordIn(title, f))) return false;
  if (substanceTermsFor(product).includes(sub)) return true;
  // A LABEL THAT NAMES THE BUY-FORM IS A LABEL FOR THE SUBSTANCE (2026-08-26). "Ubiquinol" IS CoQ10;
  // that is what declaring forms means. Until now the substance had to appear literally, and Q1 got
  // away with it only because substanceTermsFor also matches on ASIN and Q1 was pinned to the
  // Nutricost bottle. Re-pointing Q1 to a different ubiquinol removed that crutch and the week
  // planner's stored title — TRUNCATED TO 70 CHARS, cutting "Active Form of CoQ10" off the end —
  // stopped matching. A pod-fit verdict must not depend on where a string happened to be cut.
  // Narrow on purpose: this only fires when the pod DECLARES forms and the label carries all of
  // them, so it cannot resurrect the NA1 failure (a NAD-dosing pod fitting a CoQ10 capsule), which
  // came from a pod with no forms inheriting substance terms through a BRIDGE reroute.
  return forms.length > 0;
}

// ---- THREE SYSTEMS, SIDE BY SIDE ---------------------------------------------------------------
// The library holds three generations of copy at once, because which one converts is an open
// question that only the ledger's pods[].system stamp can answer:
//
//   backline the DEFAULT (operator 2026-09-02). Built from the back: the POINT gets the reader to
//            the bridge, the BRIDGE controls the angle, the PLUG scores. Four first tweets —
//            substance (action merged into it), symptom, cause, and bonus — one reviewed template
//            per product plus a dedicated light plug. The criterion is delivered by the plug's first
//            line, not the bridge; the bridge says only why the wrong form is worse than none.
//   framed   the 2026-08-30 rewrite. FIVE first tweets (substance, symptom, action, cause, answer),
//            criterion in the bridge ("Look for glycinate ↓"). Variety lives between FRAMES.
//   classic  what shipped before either. One body per pod reused under all five labels, a separate
//            wording per ACCOUNT plus a four-deep shared pool. Variety lives between ACCOUNTS.
//
// Selection is a filter on the variant list rather than a second file, so a pod's product facts —
// asin, criterion, forms, measured — stay single-sourced and cannot drift between the systems.
// SKELETON (operator 2026-09-13) is the fourth system and the default. It is not a fourth library
// of finished copy: a skeleton variant carries SLOTS — criterion questions, protocols, since-months,
// literal outcomes, CTA lines — and renderPod assembles the plug from them, so the shape that
// measured best on 513 real plugs (16 Aug → 13 Sep) ships every time while the surface varies per
// account. The three finished-copy systems stay in pods.json untouched ("written in blood, sweat
// and tears") as the backup arm and the A/B control: POD_SYSTEM=backline puts the whole engine back
// on them in one line, and a pod with no skeleton variant yet falls back to its backline copy per
// SYSTEM_FALLBACK, stamped honestly as backline on the ledger (renderPod reports the system it
// actually used).
export const POD_SYSTEMS = ['skeleton', 'backline', 'framed', 'classic'];
export const DEFAULT_POD_SYSTEM = POD_SYSTEMS.includes(process.env.POD_SYSTEM) ? process.env.POD_SYSTEM : 'skeleton';
// Which system serves a pod that has no variant in the requested one. Only skeleton falls back —
// the finished-copy systems keep the 2026-08-31 rule (never silently served from another arm),
// because those three ARE the A/B and crossing them would corrupt it.
export const SYSTEM_FALLBACK = { skeleton: 'backline' };
// An UNTAGGED variant is pre-2026-08-30 copy, i.e. framed's generation. (A pod none of whose
// variants carry a tag is system-NEUTRAL and serves every system — see variantFor.)
export const systemOf = (v) => String(v?.system || 'framed');

// ---- FRAMES, PER SYSTEM --------------------------------------------------------------------------
// backline merged substance+action into one frame ("Take magnesium glycinate (400mg before bed)")
// because 85% of host hooks landed on one of those two anyway (51 prescriptive + 12 catalog + 41
// narrative of 111 archived threads), and replaced `answer` with `bonus` — the unnumbered
// "Bonus: Take X" that fits any list and is the light plug's easy frame. framed and classic keep
// their five. Callers keep asking podFrame()'s fine-grained names; resolveFrame collapses them to
// what the variant actually carries, so a "7 habits" host still gets a backline pod.
export const FRAME_SETS = {
  skeleton: ['substance', 'symptom', 'cause', 'bonus'],   // inherits its point from backline, so backline's frames
  backline: ['substance', 'symptom', 'cause', 'bonus'],
  framed: ['substance', 'symptom', 'action', 'cause', 'answer'],
  classic: ['substance', 'symptom', 'action', 'cause', 'answer'],
};
// Frames that never take an item number: `answer` is a causal handoff, `bonus` sits outside the
// list by definition. Both enter as a consequence, not a list member.
export const UNNUMBERED_FRAMES = new Set(['answer', 'bonus']);
export function resolveFrame(v, frame) {
  const has = (f) => !!v?.entryLines?.[f];
  if (has(frame)) return frame;
  if (frame === 'action' && has('substance')) return 'substance'; // backline: 1 + 3 merged
  if (frame === 'answer' && has('bonus')) return 'bonus';         // backline: 5 became bonus
  if (frame === 'bonus' && has('answer')) return 'answer';        // framed/classic asked for bonus
  return 'substance';
}

// FNV-1a. The old fold hash (a*31 + charCode) clustered hard on real handles: with an 11-account
// roster over Q1's four-deep pool it put SEVEN feeds on one wording where a fair spread caps at
// three — measured by pod-capacity.mjs the day it was built. The pool comment below has always
// stated the intent ("different accounts spread across the pool"); this makes the implementation
// meet it.
const hashKey = (s) => { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
export function variantFor(pod, accountKey, { system = DEFAULT_POD_SYSTEM, roster = LIVE_ROSTER, fallback = true } = {}) {
  const all = pod?.variants || [];
  // A library with nothing tagged is a pre-2026-08-30 library: every variant is in play, exactly as
  // it was before systems existed. Once ANY variant is tagged the filter is real, and a pod with no
  // variant in the requested system is unavailable there — never silently served from the other one,
  // which would put the copy under test back into the arm it was being tested against. The one
  // sanctioned exception is SYSTEM_FALLBACK (skeleton -> backline): a pod the skeleton pass has not
  // reached yet ships its backline copy rather than nothing, and systemOf(the returned variant)
  // tells the caller which arm it actually got.
  const tagged = all.some((v) => v.system);
  const vs = tagged ? all.filter((v) => systemOf(v) === system) : all;
  if (!vs.length) {
    const fb = fallback ? SYSTEM_FALLBACK[system] : null;
    return fb ? variantFor(pod, accountKey, { system: fb, roster, fallback: false }) : null;
  }
  const own = vs.find((v) => v.account === accountKey);
  const picked = own || (() => { const pool = vs.filter((v) => v.account === '*'); return pool.length ? poolPick(pod, accountKey, vs, pool, roster) : null; })();
  // A skeleton variant owns only the plug slots. Hand it back COMPLETE — point, bridge, entry lines
  // and frame bodies inherited from the pod's backline copy — so every reader of `variantFor(...)
  // .bridge` (repost-repair's bridge insert, selectAltPod's same-copy guard, the outline tests)
  // sees a whole variant and never a bag of arrays.
  return picked && systemOf(picked) === 'skeleton' ? skeletonBase(pod, accountKey, picked, { roster }) : picked;
}

// CAPPED RENDEZVOUS pool assignment (2026-08-31, for the 20-account scale-up).
//
// The modulo hash this replaces promised spread and did not deliver it: on the 11-account roster it
// put SEVEN feeds on one Q1 wording where a fair split caps at three. Plain rendezvous hashing
// improved the average but cannot bound the tail — at a simulated 20 accounts one wording still
// drew nine feeds by luck. So the pick is now rendezvous WITH A CAP: every roster account that
// draws from this pod's pool ranks the members by hash, and takes its best-ranked member that still
// has room, where room is ceil(drawers / poolSize). That makes worst-case exposure ARITHMETIC —
// feeds per wording can never exceed the cap — and turns "can we add nine accounts?" into a pool
// depth calculation pod-capacity.mjs prints, instead of a bet on hash luck.
//
// CONTRACT, restated precisely because it shifted: the pick is deterministic per (pod, account,
// ROSTER). Within a fixed roster a page always posts one wording, exactly as before; when the
// roster changes (an operator adds accounts), assignments may reshuffle once. The old contract
// never actually survived roster-relevant change either — deepening the pool reshuffled every
// account under modulo — this one is merely honest about when movement happens, and buys the cap
// with it. Keys OUTSIDE the roster (test probes, the burner, '*' rendering) fall back to plain
// uncapped rendezvous, so pure callers stay pure.
function poolPick(pod, accountKey, systemVariants, pool, roster) {
  const score = (key, v) => hashKey(`${pod.id}|${key}|${v.opener}`);
  if (!roster.includes(accountKey)) {
    let best = null, bestScore = -1;
    for (const v of pool) { const x = score(accountKey, v); if (x > bestScore) { bestScore = x; best = v; } }
    return best;
  }
  // Roster accounts with their OWN variant in this system never draw from the pool.
  const drawers = roster.filter((k) => !systemVariants.some((v) => v.account === k))
    .sort((a, b) => hashKey(`${pod.id}|${a}`) - hashKey(`${pod.id}|${b}`) || (a < b ? -1 : 1));
  const cap = Math.ceil(drawers.length / pool.length);
  const load = new Map(pool.map((v) => [v, 0]));
  for (const key of drawers) {
    const ranked = [...pool].sort((a, b) => score(key, b) - score(key, a));
    const v = ranked.find((x) => load.get(x) < cap) || ranked[0];
    load.set(v, load.get(v) + 1);
    if (key === accountKey) return v;
  }
  return pool[0]; // unreachable for a roster key, kept for safety
}

// ---- SKELETON plug (operator 2026-09-13) ------------------------------------------------------------
// Measured on 513 plug tweets with 1,000+ views (16 Aug → 13 Sep): fleet median CTR 0.82%, pasted
// pods exactly on it; the twenty plugs at 2%+ shared a SINCE-MONTH (60% vs 23%), the form criterion
// posed as a QUESTION answered in the same breath (20% vs 8%), THIRD PERSON where the persona allows
// (1.30% vs 0.65%), and a short possessive CTA with a verb. Dose numbers were rarer in winners. So the
// plug is four paragraphs including the link:
//   [criterion, as "Which X is worth it? The one …"]
//   [protocol] since [month], and [one literal outcome].
//   [The X I <verb> …] (#ad):
//   {{LINK}}
// Conversion first, variety second (operator, same day): criterion[0] and cta[0] are the measured
// best and ship by default; protocol, month and outcome rotate per account so the whole plug is
// never one verbatim block across nine feeds. `alt` picks a later criterion/cta on purpose (an A/B),
// never by accident. Outcomes are LITERAL — what you can now do or stopped doing, with a time, place
// or count; never an image ("stairs stopped being an event" was the operator's example of what not
// to write).
const skeletonRot = (pod, accountKey, slot, arr) => (arr && arr.length ? arr[hashKey(`${pod.id}|${accountKey}|${slot}`) % arr.length] : '');
export function skeletonMiddle(protocol, month, outcome) {
  return `${String(protocol).trim().replace(/[.,]\s*$/, '')} since ${String(month).trim()}, and ${String(outcome).trim().replace(/\.\s*$/, '')}.`;
}
export function skeletonCtaLine(cta) {
  const c = String(cta || '').trim().replace(/:\s*$/, '');
  return DISCLOSURE_LINE_RE.test(c) ? `${c}:` : `${c} (${DISCLOSURE}):`;
}
export function skeletonPlugText(opener, protocol, month, outcome, cta, link) {
  return [String(opener || '').trim(), skeletonMiddle(protocol, month, outcome), skeletonCtaLine(cta), String(link || '').trim()].filter(Boolean).join('\n\n');
}
function skeletonSelection(pod, accountKey, v, { light = false, alt = 0, learningPolicy,
  learningNow = new Date(), selectionKey } = {}) {
  const enabled = process.env.CTA_LEARNING_ENABLED !== 'false';
  const policy = alt === 0 && enabled
    ? (learningPolicy === undefined ? loadCtaLearningPolicy({ now: learningNow }) : learningPolicy) : null;
  return selectLearnedSkeletonSlots({ podId: pod.id, asin: pod.asin, accountKey, variant: v, role: light ? 'light' : 'heavy',
    alt, policy, now: learningNow, selectionKey, enabled });
}
function renderSelectedSkeletonPlug(pod, accountKey, v, link, slots) {
  const sk = v?.plug || {};
  return skeletonPlugText(slots.criterion, skeletonRot(pod, accountKey, 'protocol', sk.protocol), skeletonRot(pod, accountKey, 'month', sk.months), skeletonRot(pod, accountKey, 'outcome', sk.outcome), slots.cta, link);
}
export function renderSkeletonPlug(pod, accountKey, v, link, options = {}) {
  return renderSelectedSkeletonPlug(pod, accountKey, v, link, skeletonSelection(pod, accountKey, v, options));
}
// A skeleton variant owns the PLUG. Its point, bridge and entry lines are the pod's backline copy
// unless the skeleton variant carries its own — the argument is the same, the ask is what changed.
export function skeletonBase(pod, accountKey, v, { roster = LIVE_ROSTER } = {}) {
  const base = variantFor(pod, accountKey, { system: 'backline', roster, fallback: false })
    || variantFor(pod, accountKey, { system: 'framed', roster, fallback: false }) || {};
  const own = {};
  for (const k of ['entryLines', 'framePoints', 'bridge', 'point']) if (v?.[k] != null && String(v[k]).length) own[k] = v[k];
  return { ...base, ...own, account: v.account, system: 'skeleton', plug: v.plug, light: v.light };
}

// A pod variant -> its three tweets, link substituted. `link` is the account's own tracked
// short link for this pod's ASIN (minted per account+subid, never shared).
// Pass learningPolicy (null disables) and learningNow for an entirely reproducible render.
export function renderPod(pod, accountKey, link, { frame: frameReq = 'substance', itemNumber = null, compact = false, ctaOnly = false, light = false, system = DEFAULT_POD_SYSTEM, alt = 0, learningPolicy, learningNow = new Date(), selectionKey } = {}) {
  const picked = variantFor(pod, accountKey, { system });
  if (!picked) return null;
  // Which arm actually answered: the requested one, or SYSTEM_FALLBACK's. Reported on the result
  // so the ledger stamp is the truth and never the caller's assumption.
  const usedSystem = systemOf(picked);
  const skel = usedSystem === 'skeleton' ? picked : null;
  const v = skel ? skeletonBase(pod, accountKey, skel) : picked;
  // The caller names the frame the HOST wants; the variant renders the frame it CARRIES. backline
  // pods have no `action` (merged into substance) and no `answer` (replaced by bonus).
  const frame = resolveFrame(v, frameReq);
  // LIGHT (operator 2026-08-26): the SECOND ask in a thread. It drops the BRIDGE, not the point —
  // the point is what earns the pod its place as a numbered item, while the criterion argument has
  // already been made by the heavy plug earlier in the same thread. Its plug is a separate write
  // (v.light) because the heavy opener ACTS ON the rule the bridge hands over, and in a light
  // placement the reader was never given that rule.
  const plugCopy = (light && v.light && !skel) ? v.light : v;
  // COMPACT (operator ruling 2026-08-23): in a ROUNDUP the item tweet already does the POINT's job —
  // it names the substance and makes its case — so a 3-tweet pod there would say it twice and a
  // 3-5 product roundup would blow the 23-tweet ceiling. Compact renders bridge + plug only; the
  // run-up guarantee is the host item's, exactly like a native 2-tweet pod.
  const twoTweet = compact || !String(v.point || '').trim();
  // ENTRY LINE (operator 2026-08-22). A pod is dropped into a host thread as one of its numbered
  // items, and the host decides what an item IS: a substance ("3/ Magnesium glycinate"), a symptom
  // ("1. Random muscle twitches"), an action ("1. Stop using mouthwash") or a cause ("1. Your blood
  // sugar is crashing at 1am"). All four appear in donors we have already recreated. Dropping a
  // substance-framed pod into a symptom listicle breaks the thread's own pattern and reads as an ad
  // break, so the pod carries one entry line per frame and the caller names the frame it needs.
  // Only the FIRST LINE changes: the body explains a mechanism, which serves every frame equally,
  // so this costs one line rather than a whole variant and never touches the criterion.
  const entry = v.entryLines?.[frame] || v.entryLines?.substance || null;
  // The CTA may carry the disclosure INLINE — "The magnesium glycinate I use (#ad):" — which is the
  // format the operator locked on 2026-08-22 and which the gates and normalizer both accept unchanged.
  // Only append a standalone #ad line when the CTA does not already disclose, so an inline CTA does not
  // get a redundant second disclosure stapled under it.
  const ctaLine = skel ? '' : `${String(plugCopy.cta).replace(/:\s*$/, '')}:`;
  const slots = skel ? skeletonSelection(pod, accountKey, skel, { light, alt, learningPolicy, learningNow, selectionKey }) : null;
  const choice = slots ? { ctaLearning: slots.metadata } : {};
  const plug = skel
    ? renderSelectedSkeletonPlug(pod, accountKey, skel, link, slots)
    : [plugCopy.opener, plugCopy.middle, ctaLine, DISCLOSURE_LINE_RE.test(ctaLine) ? null : DISCLOSURE, String(link || '').trim()]
      .filter(Boolean).join('\n\n');
  // CTA-ONLY (operator ruling 2026-08-23, hijack review round 2: "this tweet is not needed"). In a
  // donor-ad HIJACK the replaced span was the creator's own sell, and their surviving run-up already
  // taught the mechanism and the form criterion — so pasting our bridge says it a third time. The
  // plug tweet stands alone where their ask stood. No entry label either: a bare substance line
  // above a lone CTA reads as leftover scaffolding, and the donor's own build-up is the label.
  if (ctaOnly) return { point: null, bridge: null, plug, twoTweet: true, ctaOnly: true, frame, system: usedSystem, ...choice, tweets: [plug] };
  // The entry line labels the pod's FIRST tweet. On a 3-tweet pod that is the POINT; prefixing the
  // bridge instead would label tweet 2 and leave tweet 1 unlabelled inside a numbered host thread.
  //
  // NUMBERING IS THE CALLER'S JOB. Entry lines are stored WITHOUT an item number, because the number
  // depends entirely on where the pod lands in the host: "3/ Magnesium glycinate" was baked into M2
  // and had to be renumbered by hand in both threads it shipped in. The 'answer' frame never takes a
  // number — it is a causal handoff ("Low magnesium could be the reason.") for hosts whose ladder runs
  // on an axis a substance cannot join, like bpm readings or ages.
  const label = entry && itemNumber && !UNNUMBERED_FRAMES.has(frame) ? `${itemNumber}. ${entry}` : entry;
  // FIVE FIRST TWEETS (operator 2026-08-26). framePoints carries a body per frame, each answering
  // its OWN entry line; v.point remains the substance-frame body for pods not yet migrated.
  const framePoint0 = v.framePoints?.[frame] || v.point;
  // In a LIGHT placement the first tweet IS the tweet before the plug, so it inherits the BRIDGE's
  // stricter spacing: not even a PAIR of sentences in one paragraph (operator 2026-08-25, asked three
  // times; bridgeWallIssue is the hard gate). The heavy rendering keeps the copy as written, where
  // the real bridge sits between the point and the plug and the pair reads fine. Applied here rather
  // than stored pre-split so one body serves both placements and the two can never drift: 19 of the
  // 95 light placements needed it, and airyParagraphs moves line breaks only — never a word.
  const framePoint = light && framePoint0 ? airyParagraphs(framePoint0) : framePoint0;
  const head = (!twoTweet && framePoint) || v.bridge;
  const headed = label ? `${label}\n\n${head}` : head;
  const point = !twoTweet && framePoint ? headed : null;
  const bridge = light ? null : (!twoTweet && framePoint ? v.bridge : headed);
  return { point, bridge, plug, twoTweet: twoTweet || light, light: !!light, frame, system: usedSystem, ...choice,
    tweets: [point, bridge, plug].filter(Boolean) };
}

/**
 * podIssues(pod) -> string[]  — everything wrong with one pod row. Empty means shippable.
 *
 * Checks the LOCKED invariants (which is what makes a pod a pod) and the FREE-half divergence
 * (which is what keeps nine pages from posting the same text). Pure, so the library can be
 * validated in CI without touching Typefully.
 */
// ---- product selection: FF FIRST, but only where FF actually sells the substance ------------------
// OPERATOR RULE 2026-08-22: prefer Formulation Factory whenever possible. The money says so. Measured
// across 120 registry rows: FF converts at 1.86% against the fleet's 3.55%, yet earns $0.358 PER CLICK
// against the fleet's $0.157 — 2.3x — because 80% of a $50-110 product beats 35% of a $25 one. Ranking
// these on CVR is what made FF look like a loser for months; CVR is half a funnel, $/click is the whole one.
//
// THE GUARD IS THE WHOLE POINT. FF's catalogue is 10-in-1 blends, so a naive title match hands a
// COLLAGEN pod a hair-growth supplement that merely lists collagen among its ingredients — the exact
// copy/product mismatch that makes a plug read as a bait. A product only counts as selling a substance
// when the substance appears in the product NAME: the segment before the first comma. So:
//   "The Night Before Magnesium Glycinate Sleep Aid, 10-in-1 ..."      -> sells magnesium      YES
//   "Crown of Glory 10-in-1 Hair Growth Maximizer, ... Collagen ..."   -> does not sell collagen NO
// Substances with no genuine FF product (collagen, creatine, NAD, omega, vitamin D, B12) fall through
// to the best non-FF option rather than being force-fitted.
const ALIASES = {
  magnesium: ['magnesium'], zinc: ['zinc'], collagen: ['collagen'], creatine: ['creatine'],
  omega: ['omega', 'fish oil', 'krill'], ashwagandha: ['ashwagandha', 'ashwaganda'],
  probiotic: ['probiotic', 'microbiome', 'gut'], melatonin: ['melatonin', 'sleep'],
  // beet is DIETARY NITRATE; nitric-oxide boosters are usually the L-arginine/L-citrulline pathway.
  // Aliasing them together made the beet lane resolve to Formulation Factory's Heart of Steel, which
  // contains no beet at all (citrulline, arginine, CoQ10, resveratrol). Same class of error as the FF
  // hair blend answering a collagen query, so they are separate substances now. A nitric-oxide pod is
  // welcome, it just needs its own copy rather than beet copy with a richer link pasted in.
  beet: ['beet'],
  'nitric oxide': ['nitric oxide', 'citrulline', 'arginine'], nad: ['nad', 'nicotinamide', 'nmn'],
  'vitamin d': ['vitamin d', 'd3'], b12: ['b12', 'cobalamin'],
};

/** The product NAME — everything before the first comma. Ingredient lists live after it. */
export const productName = (title) => String(title || '').split(',')[0];

/** Does this product actually SELL the substance, rather than merely contain it? */
export function sellsSubstance(product, substance) {
  const name = productName(product?.title).toLowerCase();
  const terms = ALIASES[String(substance || '').toLowerCase()] || [String(substance || '').toLowerCase()];
  return terms.some((t) => t && name.includes(t));
}

export const isFF = (p) => /formulation factory/i.test(p?.title || '');

// A pod sells ONE substance, so a multi-product bundle can never be its plug: the copy names a form
// and a dose, and "A x B x C (Bundle)" delivers three things the reader did not agree to. pick-product
// already refuses bundles for the same reason; the pod layer has to refuse them too or FF's bundles
// win on EPC every time (the beet lane picked "Self Obsessed x Heart of Steel (Bundle)" at $3.64).
export const isBundle = (p) => /\bbundle\b|\s[x×]\s/i.test(p?.title || '');

// The catalogue is not all supplements. Alongside the 97 categories sit Facial Sunscreens, Toothpaste,
// Toe Separators, Dog Treat Cookies and Desk Calendars — and a title match alone reaches them: the zinc
// lane picked "TruSkin Sunscreen Serum SPF 30" because zinc oxide is in its NAME. A pod plug is always
// something the reader is told to TAKE, so anything not ingestible is disqualified regardless of EPC.
const NOT_INGESTIBLE = /sunscreen|serum|toothpaste|toothbrush|whitening|separator|calendar|\bdog\b|\btoys?\b|accelerator|regrowth treatment|topical|cream|lotion|shampoo|\bpatch/i;
// Devices and apparel are a SECOND kind of non-ingestible, and they need a category-only test.
// "Support" is the giveaway word for a brace or a cushion, but it is also all over supplement titles
// ("Sleep Support", "Immune Support"), so matching it in a title would reject half the catalogue.
// The category is unambiguous: "Lumbar Supports" is a brace, "Herbal Supplements" is not. Added when
// a Sparthos back brace entered the catalogue and passed isIngestible — a pod's third beat says "I
// take 2400mg daily", and you do not take a back brace. Physical products may well convert; they
// just need their own template rather than this one.
const NOT_INGESTIBLE_CATEGORY = /\bsupports?\b|brace|massager|roller|\bbands?\b|sleeve|\bmats?\b|\bscales?\b|cushion|monitor|tracker|apparel|clothing/i;
export const isIngestible = (p) => !NOT_INGESTIBLE.test(p?.category || '') && !NOT_INGESTIBLE.test(p?.title || '')
  && !NOT_INGESTIBLE_CATEGORY.test(p?.category || '');

/**
 * Rank a product pool for one substance: genuine FF first (by EPC), then everything else (by EPC).
 * Never returns a product that only mentions the substance — an unsellable pool returns [].
 */
export function ffFirst(products, substance) {
  const epc = (p) => parseFloat(p?.epc || 0) || 0;
  const eligible = (products || []).filter((p) => sellsSubstance(p, substance) && !isBundle(p) && isIngestible(p));
  const ff = eligible.filter(isFF).sort((a, b) => epc(b) - epc(a));
  const rest = eligible.filter((p) => !isFF(p)).sort((a, b) => epc(b) - epc(a));
  return [...ff, ...rest];
}

/**
 * renderRecoBlock(pods, accountKey, links, { lead, frame }) -> { tweets, entries, issues } | null
 *
 * The RECOMMENDATION BLOCK (operator 2026-08-23). A pod normally enters a thread AS one of its
 * items, which needs the host to have an item a substance can BE. Plenty of proven donors do not:
 * @matthew_labosco's cortisol thread (2.83M views) has seven items and every one is behavioural
 * ("empty your open loops", "measure backwards"). Nothing there bridges, so threads like it were
 * being written off as unmonetizable.
 *
 * The move is to stop bridging item-by-item and let the thread's own CONCLUSION carry it: "if those
 * are the signs, here is what I would actually take", then a short list. The LEAD tweet names every
 * substance, and that is what supplies each pod's run-up mention — so each pod contributes only its
 * BRIDGE and PLUG. Its POINT would repeat the setup the lead just gave.
 *
 * The entry line moves onto the BRIDGE here, because in a reco block the bridge IS the pod's first
 * tweet. Unnumbered on purpose: the host thread already owns 1..N and a second sequence inside it
 * breaks the numbering gate.
 */
export function renderRecoBlock(pods, accountKey, links, { lead, frame = 'substance' } = {}) {
  const list = pods || [];
  const text = String(lead || '').trim();
  if (!list.length || !text) return null;
  const entries = [];
  const issues = [];
  const leadLc = text.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const pod = list[i];
    const v = variantFor(pod, accountKey);
    if (!v) return null;
    const rendered = renderPod(pod, accountKey, (links || [])[i], { frame });
    if (!rendered) return null;
    const entry = v.entryLines?.[frame] || v.entryLines?.substance || null;
    const bridge = entry ? `${entry}\n\n${v.bridge}` : v.bridge;
    // The lead is the ONLY setup these pods get, so it has to name each substance. Without that the
    // reader meets a buying rule for something the thread never introduced, and the run-up rule the
    // pod normally guarantees internally is simply not met.
    const sub = String(pod.substance || '').toLowerCase();
    if (sub && !leadLc.includes(sub)) issues.push(`${pod.id}: lead never names "${pod.substance}" — it is the only run-up these pods get`);
    if (effLen(bridge) > TWEET_LIMIT) issues.push(`${pod.id}/${accountKey}: bridge with "${frame}" entry line is ${effLen(bridge)} chars (max ${TWEET_LIMIT})`);
    entries.push({ id: pod.id, bridge, plug: rendered.plug });
  }
  if (effLen(text) > TWEET_LIMIT) issues.push(`lead is ${effLen(text)} chars (max ${TWEET_LIMIT})`);
  return { tweets: [text, ...entries.flatMap((e) => [e.bridge, e.plug])], entries, issues };
}

// A CTA has to read like a person wrote it (operator 2026-08-23: "I don't like the fact that you're
// starting mid-sentence or having a colon mid-sentence"). The library had drifted into bare noun
// phrases — "The beet root I use (#ad):" — which is a label with a colon stapled on, not a line
// anyone says. Twenty of twenty-nine CTAs were that shape. A natural CTA leads with a subject and a
// verb: "This is the beet root I use", "Here is the one I take", "Magnesium glycinate is what I use".
//
// Deliberately permissive about WHICH opener, because June's winners used twelve distinct CTA lines
// and hard-coding a phrase list is how we ended up with one house style in the first place. It only
// refuses the specific defect: a determiner-led noun phrase with no finite verb driving it.
// Three ways to be a sentence: lead with a subject pronoun ("This is the zinc I use"), lead with a
// named subject and finite verb ("Magnesium glycinate is what I use"), or open on a subordinate
// clause that lands on the subject after a comma — the PRE-EMPTED-DM shape the operator approved
// 2026-08-23, modeled on Clara's 1.06M donor: "Since most of you will DM me asking anyway, this is
// the one I take". The comma is what separates that from a determiner-led noun phrase, which stays
// refused.
const CTA_SENTENCE_RE = /^(?:this|that|these|those|here|it|i)\b|^[\w\s'-]{1,40}\b(?:is|are|was|were)\b|^[\w\s'-]{1,60},\s*(?:this|that|these|those|here|it|i)\b/i;
export const ctaReadsAsSentence = (cta) => CTA_SENTENCE_RE.test(String(cta || '').trim());

// NATURALNESS (operator 2026-08-23: "I don't like ... having a colon mid-sentence. Just write as if
// a normal person is writing"). Plug prose — opener, middle, and the CTA's interior — may not carry
// a colon: "the tell was my appetite: the raids stopped" is list punctuation wearing a sentence's
// clothes. Times and ratios (4:30, 2:1) are stripped before the test. POINT and BRIDGE are exempt
// on purpose — they are the educational tweets, where "Form: picolinate" is native list style.
export const hasMidColon = (s) => /:/.test(String(s || '').replace(/\b\d+:\d+\b/g, ''));

// A CTA the skeleton accepts: an "I <verb>" a person would say ("The B12 I buy him", "The magnesium
// I take nightly") or "This is …". The finished-copy systems keep CTA_SENTENCE_RE; the measured
// winners are determiner-led noun phrases with an embedded first-person clause, which that regex
// refuses and the data (1.30–1.46% pooled vs 0.97% for the house closer) says to keep.
export const SKELETON_CTA_RE = /\bI\s+\w+|^this is\b/i;
const SIMILE_RE = /\b(like a|as if|felt like|feeling like|stopped being an? \w+|fog lifted|wall)\b/i;
export const SKELETON_MONTH_RE = /^(january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|winter|20\d\d)$/i;
/** skeletonIssues(pod, v) -> string[] — everything wrong with one skeleton variant. Renders EVERY slot
 *  combination the rotation can produce and gates each as a tweet, so no account can draw an unshippable plug. */
export function skeletonIssues(pod, v) {
  const out = [];
  const tag = `${pod?.id || '(no id)'}/${v?.account || '?'}/skeleton`;
  const sk = v?.plug || {};
  for (const f of ['criterion', 'protocol', 'months', 'outcome', 'cta']) {
    if (!Array.isArray(sk[f]) || !sk[f].length || sk[f].some((x) => !String(x || '').trim())) out.push(`${tag}: plug.${f} must be a non-empty array of strings`);
  }
  if (out.length) return out;
  const base = skeletonBase(pod, '*', v);
  if (!String(base.bridge || '').trim() || !(base.framePoints || base.point)) out.push(`${tag}: no point/bridge to inherit — the pod needs a backline (or framed) variant, or the skeleton variant must carry its own`);
  const names = podSubstanceNames(pod);
  const namesIt = (t) => names.some((n) => String(t || '').toLowerCase().includes(n));
  for (const c of sk.criterion) {
    if (!namesIt(c)) out.push(`${tag}: criterion "${c.slice(0, 50)}" never names the substance — the first line IS the form criterion`);
    if (hasMidColon(c)) out.push(`${tag}: criterion carries a mid-sentence colon`);
  }
  for (const m of sk.months) if (!SKELETON_MONTH_RE.test(String(m).trim())) out.push(`${tag}: month "${m}" — a month name, a season or a year; the since-month is the slot the winners share`);
  for (const o of sk.outcome) {
    if (SIMILE_RE.test(o)) out.push(`${tag}: outcome "${o.slice(0, 50)}" is an image, not an outcome — say what you can do now or stopped doing, with a time, place or count`);
    if (/[.!?]\s*$/.test(o.trim())) out.push(`${tag}: outcome "${o.slice(0, 40)}" ends on punctuation — the renderer closes the sentence`);
    if (hasMidColon(o)) out.push(`${tag}: outcome carries a mid-sentence colon`);
  }
  for (const c of [...sk.cta, ...(v.light?.cta || [])]) {
    if (!SKELETON_CTA_RE.test(c)) out.push(`${tag}: CTA "${c}" has no "I <verb>" — say what you do with it`);
    if (hasMidColon(c.replace(/:\s*$/, ''))) out.push(`${tag}: CTA carries a mid-sentence colon`);
  }
  const openers = [...sk.criterion, ...(v.light?.opener || [])];
  const ctas = [...sk.cta, ...(v.light?.cta || [])];
  const link = 'https://lvnta.com/lv_probe';
  const seen = new Set();
  for (const op of openers) for (const pr of sk.protocol) for (const mo of sk.months) for (const oc of sk.outcome) for (const ct of ctas) {
    const plug = skeletonPlugText(op, pr, mo, oc, ct, link);
    const key = plug.replace(link, '');
    if (seen.has(key)) continue; seen.add(key);
    const short = `[${op.slice(0, 28)}… / ${pr.slice(0, 20)}… / ${mo} / ${oc.slice(0, 24)}… / ${ct.slice(0, 20)}…]`;
    if (stackedParagraphs(plug).length) { out.push(`${tag}: ${short} stacks two full sentences in one paragraph — keep the question under ${STACKED_MIN_HINT} chars or make it one sentence`); }
    const ps = plugStructure(plug);
    if (!ps.ok) out.push(`${tag}: ${short} fails plugStructure (${ps.failed}: ${ps.detail})`);
    if (plugTextLen(plug) > PLUG_LIMIT) out.push(`${tag}: ${short} plug text ${plugTextLen(plug)} > ${PLUG_LIMIT} excl link`);
    if (effLen(plug) > TWEET_LIMIT) out.push(`${tag}: ${short} is ${effLen(plug)} chars AS A TWEET (max ${TWEET_LIMIT})`);
    const bt = bannedTopicIssue([plug]); if (bt) out.push(`${tag}: ${bt}`);
  }
  // Variety exists so the rotation cannot put one verbatim block on every feed.
  if (sk.protocol.length * sk.months.length * sk.outcome.length < 4) out.push(`${tag}: only ${sk.protocol.length * sk.months.length * sk.outcome.length} protocol×month×outcome combination(s) — give the rotation at least 4`);
  return out;
}
const STACKED_MIN_HINT = 30;

export function podIssues(pod) {
  const out = [];
  const id = pod?.id || '(no id)';
  for (const f of ['id', 'name', 'status', 'substance', 'asin', 'criterion', 'move']) {
    if (!String(pod?.[f] || '').trim()) out.push(`${id}: missing "${f}"`);
  }
  if (!(pod?.topics || []).length) out.push(`${id}: no topics — nothing could ever select it`);
  const variants = pod?.variants || [];
  if (!variants.length) out.push(`${id}: no variants`);

  const substance = String(pod?.substance || '').toLowerCase();
  // What counts as naming this pod's substance, in the same currency production uses: the linked
  // product's own title vocabulary (substanceTermsFor — what runUpIssue matches), plus the pod's
  // declared substance, forms and ownTerms. A bare `.includes(pod.substance)` called TH1's bridge
  // silent because it says "ordinary magnesium" rather than "threonate", and E1's plug silent
  // because it says "potassium" — both of which production reads as naming the substance.
  const prod = podProduct(pod);
  const podNames = podSubstanceNames(pod);
  const namesSubstance = (text) => podNames.some((n) => String(text || '').toLowerCase().includes(n));
  // >3 chars, PLUS any short token carrying a digit (2026-08-30). The bare length filter dropped
  // exactly the words a criterion turns on: J2's criterion is "D3 and K2 belong in the same
  // softgel", and with d3/k2 filtered out the only terms left to match were connective prose
  // (belong, same, softgel, because, directs) — so a bridge saying "K2" four times scored 2/8.
  const critWords = String(pod?.criterion || '').toLowerCase().split(/\W+/)
    .filter((w) => w.length > 3 || (w.length > 1 && /\d/.test(w)));

  // A 2-tweet pod puts only ONE tweet before the plug, so the run-up rule ("substance named in 2 of
  // the 3 prior tweets") can no longer be satisfied inside the pod — the HOST thread has to supply
  // the second mention. That is a genuine trade and the pod has to declare it, because the whole
  // reason pods exist is that the guarantee is internal. Undeclared, it is a silent regression to
  // the thing we were trying to get away from.
  //
  // POD-LEVEL, not per-variant (2026-09-09). requiresHostMention is one flag on the pod, and a pod
  // may now carry variants of different shapes across systems: NA1's framed and classic arms are
  // 2-tweet, its backline arm is not. Checked per variant the two rules contradicted each other and
  // no value of the flag could satisfy both. So the flag answers a question about the pod: does ANY
  // variant put one tweet before the plug? Readers ask the narrower question per RENDER, where
  // rendered.twoTweet says whether THIS placement needs the host.
  // Skeleton variants inherit their point from backline, so a missing `point` there is not a 2-tweet shape.
  const twoTweetVariants = variants.filter((v) => systemOf(v) !== 'skeleton' && !String(v?.point || '').trim());
  if (twoTweetVariants.length && !pod.requiresHostMention) {
    out.push(`${id}: ${twoTweetVariants.map((v) => `${v.account}/${systemOf(v)}`).join(', ')} ${twoTweetVariants.length > 1 ? 'are' : 'is'} 2-tweet (no POINT), so the pod must set "requiresHostMention": true — with one tweet before the plug the run-up guarantee comes from the HOST thread, not the pod`);
  }
  if (!twoTweetVariants.length && pod.requiresHostMention) {
    out.push(`${id}: every variant has a POINT, so no placement needs the host to mention the substance — drop requiresHostMention`);
  }

  for (const v of variants) {
    const tag = `${id}/${v.account}`;
    if (systemOf(v) === 'skeleton') { out.push(...skeletonIssues(pod, v)); continue; }
    const twoTweet = !String(v?.point || '').trim();
    for (const f of ['bridge', 'opener', 'middle', 'cta']) {
      if (!String(v?.[f] || '').trim()) out.push(`${tag}: missing "${f}"`);
    }
    if (String(v?.cta || '').trim() && !ctaReadsAsSentence(v.cta)) {
      out.push(`${tag}: CTA "${v.cta}" is a noun phrase, not a sentence — a colon after a label reads as an ad slug. Lead with a subject and a verb ("This is the ... I take").`);
    }
    for (const [f, val] of [['opener', v.opener], ['middle', v.middle], ['cta', v.cta]]) {
      if (hasMidColon(val)) out.push(`${tag}: "${f}" carries a mid-sentence colon — split it into two sentences (times like 4:30 are fine; POINT/BRIDGE may keep list colons)`);
    }
    // NO WALLS (operator 2026-08-24): a paragraph stacking 3+ sentences reads as a block and gets
    // glanced past. Lead sentence stands alone, contrasts pair up — enforced on every free-text
    // field, because a wall in a proven pod ships nine times.
    for (const [f, val] of [['point', v.point], ['bridge', v.bridge], ['opener', v.opener], ['middle', v.middle]]) {
      for (const para of String(val || '').split(/\n\n+/)) {
        const n = (para.match(/[^.!?]+[.!?]+(?:\s*↓)?|[^.!?]+$/g) || []).filter((x) => x.trim()).length;
        if (n >= 3) { out.push(`${tag}: "${f}" stacks ${n} sentences in one paragraph — break it up (lead alone, pairs after); walls get glanced past`); break; }
      }
    }
    // The BRIDGE is stricter than the rest: not even a pair (operator 2026-08-25, asked three times).
    // It is the tweet the reader is on when they decide to click, and its contrast pair — "glycinate
    // absorbs / oxide passes through" — is precisely what kept getting glued into one block.
    if (gluedParagraphs(v.bridge).length) {
      out.push(`${tag}: "bridge" glues sentences into one paragraph — one sentence per line, blank line between (airyParagraphs fixes it)`);
    }
    // The plug prose must NAME what it sells. Downstream, recreate's plugSubstanceMismatch check
    // reads the plug tweet alone — a pasted pod whose opener/middle/cta never say the substance
    // gets routed into the rewrite branch and the proven copy is overwritten by the API. So the
    // library refuses the shape that triggers its own destruction.
    {
      const prose = [v.opener, v.middle, v.cta].join(' ').toLowerCase();
      // titleSubstances is what plugSubstanceMismatch reads downstream, so ask its question, not a
      // near-miss of it: a plug naming "EPA and DHA" satisfies the pod key "omega" and still gets
      // rewritten, because the bottle's title says "omega-3". Fall back to the pod's own vocabulary
      // only when the ASIN is not in the catalog, where production itself fails open.
      const titleTerms = titleSubstances(prod?.title || '');
      const names = titleTerms.length ? titleTerms : podNames;
      if (names.length && !names.some((n) => prose.includes(n))) {
        out.push(`${tag}: plug prose never names ${titleTerms.length ? `the linked product's substance ("${names[0]}")` : `"${pod.substance}"`} — the repair loop would rewrite this pasted pod`);
      }
    }
    // LOCKED: the substance is named in the point AND the bridge. That is what makes the run-up rule
    // true by construction rather than dependent on the host thread.
    if (substance && !twoTweet && !v.framePoints && !String(v.point || '').toLowerCase().includes(substance)) out.push(`${tag}: POINT never names "${pod.substance}" — the run-up guarantee is what a pod is for`);
    if (substance && !namesSubstance(v.bridge)) out.push(`${tag}: BRIDGE never names "${pod.substance}" (nor any of: ${podNames.join(', ')})`);
    // LOCKED: the bridge carries the criterion. Checked on content words rather than exact string so
    // a variant may phrase it in its own voice — but it must still be the SAME buying rule.
    // Measured across the BRIDGE AND THE PLUG, not the bridge alone (2026-08-30).
    //
    // The old rule wanted half the criterion field's content words inside the bridge. The operator's
    // bridge shape makes that unreachable and deliberately so: the bridge names the WRONG form and
    // what it costs you, then hands off ("So here's what to look for ↓") — and the PLUG answers with
    // the form to buy. That split IS the design ("then the natural next question is, okay, so what is
    // the right one?"), and it is what production's own criterionOrder/discrimination gates measure.
    // Held to the old rule, 7 of 19 reviewed pods failed while every one of them passed the
    // production gate — a proxy outliving the thing it stood in for.
    const carrier = `${v.bridge || ''} ${v.opener || ''} ${v.middle || ''} ${v.cta || ''}`.toLowerCase();
    const carried = critWords.filter((w) => carrier.includes(w)).length;
    if (critWords.length && carried < Math.ceil(critWords.length / 3)) {
      out.push(`${tag}: the criterion ("${pod.criterion}") never reaches the reader — only ${carried}/${critWords.length} of its terms appear across the bridge and the plug`);
    }
    // The writer never writes a link or a disclosure; renderPod appends both.
    for (const [f, val] of [['point', v.point], ['bridge', v.bridge], ['opener', v.opener], ['middle', v.middle], ['cta', v.cta]]) {
      if (/https?:\/\//i.test(String(val))) out.push(`${tag}: "${f}" contains a URL — the link is appended by code`);
      // The CTA is the ONE field allowed to disclose: the operator locked an inline "(#ad)" closing
      // line on 2026-08-22 and renderPod now suppresses the standalone line when it sees one. Every
      // other beat still gets this refusal, because a disclosure buried mid-paragraph is not clear
      // and conspicuous, and the reader meets it after the pitch rather than before the link.
      if (f !== 'cta' && DISCLOSURE_LINE_RE.test(String(val))) out.push(`${tag}: "${f}" writes its own disclosure — "${DISCLOSURE}" is appended by code`);
    }
    // The length check has to run on the ASSEMBLED bridge, once per frame. entryLines are prepended
    // at render time, so checking v.bridge alone passes a pod whose symptom or cause framing is 30
    // chars over — which is exactly what the first entryLines commit did before this existed.
    // Measure whatever renderPod actually heads: the POINT on a 3-tweet pod, the BRIDGE on a 2-tweet
    // one. Assuming the bridge reported 16 false failures on pods whose point carries the label.
    // FRAME BODIES (operator 2026-08-26): framePoints carries one body per frame, each answering its
    // own entry line. Measure the pair that actually renders; the old single-body cross-product would
    // fail a pod for a combination renderPod never emits.
    for (const [f, line] of Object.entries(v.entryLines || {})) {
      const body = v.framePoints?.[f] || v.point || v.bridge;
      const headName = v.framePoints?.[f] ? `framePoints.${f}` : (v.point ? 'point' : 'bridge');
      const assembled = `${line}\n\n${body}`;
      if (effLen(assembled) > TWEET_LIMIT) out.push(`${tag}: ${headName} with its entry line is ${effLen(assembled)} chars (max ${TWEET_LIMIT})`);
      // THE RUN-UP GUARANTEE, PER FRAME (rewritten 2026-08-30).
      //
      // This used to demand the substance in every first tweet. Four of the five frames are written
      // to withhold it: symptom, action, cause and answer agitate the PROBLEM in the reader's own
      // words and hand off with an explicit "↓" or "…" ("You wake up with a headache… A sachet can
      // help, but the right one ↓"). Naming the substance there answers the question the frame
      // exists to raise, and on the action frame it swaps the reader's word for jargon ("Salt your
      // first glass of water" -> "Take electrolytes"). 15 of the 19 approved pods' 95 frames withhold
      // it deliberately; demanding the word would have rewritten the design.
      //
      // What must still hold is that the reader is never dropped. So a first tweet either NAMES the
      // substance or HANDS OFF — and the bridge, which this function separately requires to name the
      // substance and carry a criterion, catches the handoff. runUpIssue's `pod` exemption is the
      // matching relaxation on the production side; the two must move together.
      const namesIt = namesSubstance(assembled);
      const handsOff = /(↓|…|\.\.\.)\s*$/.test(assembled.trim());
      if (substance && v.framePoints && !namesIt && !handsOff) {
        out.push(`${tag}: "${f}" first tweet neither names "${pod.substance}" nor hands off to the bridge — end it on "↓" (or "…") so the reader knows the answer is coming, or name the substance`);
      }
    }

    // Same laws as any other thread. A pod that cannot ship is not a shortcut, it is a liability.
    const bt = bannedTopicIssue([v.point, v.bridge, v.opener, v.middle, v.cta]); if (bt) out.push(`${tag}: ${bt}`);
    for (const [f, val] of [['point', v.point], ['bridge', v.bridge]]) {
      if (val && effLen(String(val)) > TWEET_LIMIT) out.push(`${tag}: "${f}" is ${effLen(String(val))} chars (max ${TWEET_LIMIT})`);
    }
    // Render THIS variant specifically. renderPod(pod, '*') resolves the pool by hash and always
    // lands on one pool member — which let a second pool variant ship unmeasured (found 2026-08-23:
    // A1's DM-stem pool plug rendered at 291 and the gate had never seen it). Pinning the variant
    // under a synthetic account key measures every row.
    if (v.light) {
      for (const [f, val] of [['opener', v.light.opener], ['middle', v.light.middle], ['cta', v.light.cta]]) {
        if (!String(val || '').trim()) out.push(`${tag}: light plug missing "${f}"`);
        else if (hasMidColon(val)) out.push(`${tag}: light "${f}" carries a mid-sentence colon`);
      }
      if (String(v.light.cta || '').trim() && !ctaReadsAsSentence(v.light.cta)) out.push(`${tag}: light CTA "${v.light.cta}" is a noun phrase, not a sentence`);
      const lprose = [v.light.opener, v.light.middle, v.light.cta].join(' ').toLowerCase();
      const ltitle = titleSubstances(prod?.title || '');
      const lnames = ltitle.length ? ltitle : podNames;
      if (lnames.length && !lnames.some((n) => lprose.includes(n))) out.push(`${tag}: light plug prose never names ${ltitle.length ? `the linked product's substance ("${lnames[0]}")` : `"${pod.substance}"`} — the repair loop would rewrite this pasted pod`);
      const lr = renderPod({ ...pod, variants: [{ ...v, account: '__probe__' }] }, '__probe__', 'https://lvnta.com/lv_probe', { light: true, system: systemOf(v) });
      if (lr) {
        if (stackedParagraphs(lr.plug).length) out.push(`${tag}: light plug stacks two full sentences in one paragraph — checkThread refuses it on every tweet but the first, and a plug is never the first`);
        const lps = plugStructure(lr.plug);
        if (!lps.ok) out.push(`${tag}: rendered LIGHT plug fails plugStructure (${lps.failed}: ${lps.detail})`);
        if (plugTextLen(lr.plug) > PLUG_LIMIT) out.push(`${tag}: light plug text ${plugTextLen(lr.plug)} > ${PLUG_LIMIT} excl link`);
        if (effLen(lr.plug) > TWEET_LIMIT) out.push(`${tag}: rendered light plug is ${effLen(lr.plug)} chars AS A TWEET (max ${TWEET_LIMIT})`);
      }
    }
    const rendered = renderPod({ ...pod, variants: [{ ...v, account: '__probe__' }] }, '__probe__', 'https://lvnta.com/lv_probe', { system: systemOf(v) });
    if (rendered) {
      if (stackedParagraphs(rendered.plug).length) out.push(`${tag}: plug stacks two full sentences in one paragraph — checkThread refuses it on every tweet but the first, and a plug is never the first`);
      const ps = plugStructure(rendered.plug);
      if (!ps.ok) out.push(`${tag}: rendered plug fails plugStructure (${ps.failed}: ${ps.detail})`);
      if (plugTextLen(rendered.plug) > PLUG_LIMIT) out.push(`${tag}: plug text ${plugTextLen(rendered.plug)} > ${PLUG_LIMIT} excl link`);
      // PLUG_LIMIT bounds the prose, but the shipped TWEET also carries separators and a 23-char
      // link — and one boundary case (O1 pool, 2026-08-23) passed the prose limit while landing at
      // 281 as a tweet. Measure what actually posts.
      if (effLen(rendered.plug) > TWEET_LIMIT) out.push(`${tag}: rendered plug is ${effLen(rendered.plug)} chars AS A TWEET (max ${TWEET_LIMIT})`);
    }
  }

  // BRIDGE keys are a mix of two things: SUBSTANCES (what a product is) and the SYMPTOMS/MECHANISMS
  // that route a thread to one ("blood pressure", "inflammation", "brain fog"). Only the first kind
  // means "you are naming someone else's product". A magnesium pod listing "high blood pressure"
  // among the symptoms of deficiency is correct copy, and the first version of this check flagged
  // exactly that. The split lives here rather than in checks.mjs because it is a question only pods
  // ask: BRIDGE's job is routing, where a symptom key is a feature.
  // Symptoms and anatomy, not substances. checks.mjs says so itself where it routes them: "'bloating'
  // is routed the same way 'cortisol' routes to ashwagandha — the symptom a reader arrives with, not
  // the substance." cortisol was listed here and its gut-lane siblings were not, so NO1's bridge
  // naming a side effect of arginine ("you get the bloating and loose stools") read as NO1 leaning on
  // the probiotic product. A pod must be free to name the symptom it treats.
  const BRIDGE_CONCEPTS = new Set(['brain fog', 'cortisol', 'inflammation', 'blood pressure', 'blood flow',
    'joint pain', 'cartilage', 'hydration', 'mitochondria', 'adaptogen', 'nitric oxide',
    'bloating', 'gut health', 'gut bacteria', 'flora', 'microbiome']);

  // SELF-CONTAINED: a pod names ITS OWN substance and no other. The first draft of J2 opened
  // "Vitamin D is the real driver here, not just zinc" — lifted verbatim from the winning thread,
  // and broken as a pod, because "zinc" is the HOST thread's substance. Reuse it anywhere else and
  // the opener refers to something the reader was never told about. Checked against the BRIDGE
  // vocabulary, so it catches a catalog substance that belongs to a different product; a substance
  // we do not sell (zinc, creatine before it was listed) still needs a human to notice.
  for (const v of variants) {
    let text = [v.point, ...Object.values(v.framePoints || {}), v.bridge, v.opener, v.middle, v.cta,
      ...(v.light ? [v.light.opener, v.light.middle, v.light.cta] : []),
      ...(v.plug ? Object.values(v.plug).flat() : [])].flat().filter((x) => typeof x === 'string').join(' ').toLowerCase();
    // OWN-KEY MASKING: strip the pod's own BRIDGE vocabulary from the text (longest key first)
    // before scanning for foreign terms. Without this, a compound own-key hides a foreign match
    // inside itself the WRONG way around: "magnesium l-threonate" is the threonate pod's own key,
    // but the bare word "magnesium" inside it belongs to the glycinate product and would flag.
    // The pod's DECLARED substance + forms mask too: when a menu cut reroutes a concept to another
    // product (collagen -> REVO, 2026-08-23), the cut product's own pod must not start reading its
    // own substance as foreign — BRIDGE says where the concept routes NOW, not what this pod sells.
    // ownTerms (operator 2026-08-26): a pod may DECLARE a BRIDGE term that is genuinely its own.
    // TH1 sells Magnesium L-Threonate, so "magnesium" is its own word — but BRIDGE routes the bare
    // term to the glycinate product, and masking only strips substance+forms, leaving "magnesium"
    // to read as a foreign product inside a magnesium pod. Declaring it is narrower than weakening
    // the check: every pod that has not declared a term is still refused for naming it.
    const ownTerms = [pod.substance, ...(pod.forms || []), ...(pod.ownTerms || [])].filter(Boolean).map((s) => String(s).toLowerCase());
    const ownKeys = [...Object.entries(BRIDGE).filter(([, a]) => a === pod.asin).map(([k]) => k), ...ownTerms]
      .sort((a, b) => b.length - a.length);
    for (const k of ownKeys) text = text.replaceAll(k, ' ');
    const foreign = [...new Set(Object.entries(BRIDGE)
      .filter(([term, asin]) => asin !== pod.asin && !BRIDGE_CONCEPTS.has(term) && new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
      .map(([term]) => term))];
    if (foreign.length) out.push(`${id}/${v.account}: names a substance this pod does not sell (${foreign.join(', ')}) — a pod must stand alone, so it cannot lean on the host thread's other products`);
  }

  // FREE: every pair of variants must diverge. Compared on the PLUG PROSE — the beats a reader
  // actually experiences as the ad — not on the point/bridge, which legitimately share vocabulary
  // because they are pinned to the same substance and criterion.
  //
  // WITHIN ONE SYSTEM only (2026-08-31, same rationale as variantSpread): two variants compete only
  // when a reader could meet both, and POD_SYSTEM means a reader only ever meets one system. A
  // framed CTA deliberately written in the classic voice (operator request) must not be reported as
  // a duplicate of the classic line it echoes — the arms are told apart by the ledger, not the text.
  const prose = (v) => [v.opener, v.middle, v.cta].join(' ');
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      if (systemOf(variants[i]) !== systemOf(variants[j])) continue;
      if (systemOf(variants[i]) === 'skeleton') continue; // slots, not prose: skeletonIssues owns their variety
      const sim = hookSimilarity(prose(variants[i]), prose(variants[j]));
      if (sim >= POD_VARIANT_MAX) {
        out.push(`${id}: ${variants[i].account} and ${variants[j].account} (${systemOf(variants[i])}) are ${(sim * 100).toFixed(0)}% similar (ceiling ${POD_VARIANT_MAX * 100}%) — rewrite the prose, do not nudge it; a few swapped synonyms still reads as a duplicate`);
      }
    }
  }
  return out;
}

// Every issue across the whole library. Used by the test suite and by a CI check.
export function libraryIssues() {
  const out = [];
  const seen = new Set();
  for (const p of PODS) {
    if (seen.has(p.id)) out.push(`duplicate pod id "${p.id}"`);
    seen.add(p.id);
    // A retired pod is unreachable (podsForTopic and selectPod both filter it out), and its copy is
    // kept as a record of what was tried. Judging it against the LIVE catalog is what turns a
    // product going away into a red library — the retirement is the fix, not a defect to report.
    if (p.status === 'retired') continue;
    out.push(...podIssues(p));
  }
  return out;
}

// How divergent is this pod's variant set, as one number the operator can read? 0 = identical,
// 1 = nothing shared. Reported so "are these different enough?" has an answer, not an opinion.
export function variantSpread(pod, { system = null } = {}) {
  // WITHIN one system only. A framed template and a classic per-account variant are two generations
  // of the same argument — of course they overlap, and scoring them against each other would report
  // the rewrite as a duplicate of the copy it replaced. Two variants only compete when a reader
  // could see both, and a reader only ever sees one system.
  const all = pod?.variants || [];
  const groups = system ? [all.filter((v) => systemOf(v) === system)] : [...new Set(all.map(systemOf))].map((g) => all.filter((v) => systemOf(v) === g));
  const sims = [];
  const prose = (v) => [v.opener, v.middle, v.cta].join(' ');
  for (const vs of groups) {
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) sims.push(hookSimilarity(prose(vs[i]), prose(vs[j])));
  }
  if (!sims.length) return { pairs: 0, worst: 0, mean: 0 };
  return { pairs: sims.length, worst: Math.max(...sims), mean: sims.reduce((a, b) => a + b, 0) / sims.length };
}
