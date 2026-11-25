// preflight.mjs — the pre-create checklist. Run this BEFORE writing or generating anything.
//
// WHY THIS EXISTS (2026-08-28). The 22-thread batch on 08-28 was built by hand, donor by donor:
// pick one, read its whole body a tweet at a time, discover a disqualifier, throw it away, pick
// another. 21 donors were read to ship 11. Eight of the ten dead reads were rejected for reasons a
// keyword scan catches without reading anything — banned topic, foreign funnel, no sellable
// substance, no body rows. Four accounts were then reassigned mid-flight because the greedy pick
// had already spent their product.
//
// None of that was a hard problem. It was a MISSING PASS. Everything this file needs was already
// in the repo: `Full Thread Text` is a rollup that returns the entire body in the list call, and
// bannedTopicIssue / bridgeableProducts / foreignCtaIssue / donorSlots all existed. They were just
// never run together, before the work, over the whole pool at once.
//
// So: one bulk read, every screen, then a per-account slate and a GO / NO-GO. It is READ ONLY —
// it writes nothing, mints nothing, and touches no draft. If it says NO-GO, fixing what it names
// is cheaper than discovering the same thing 40 minutes into writing.
//
//   node preflight.mjs                 the whole roster, one day of slots
//   node preflight.mjs --days 2        two threads per account
//   node preflight.mjs --account tina  one account
//   node preflight.mjs --json          machine-readable, for a workflow step
//   node preflight.mjs --test-product B0B18YBN2X   rank donors that bridge the test substance FIRST,
//                                      and say at PLAN TIME whether the heart can be spent at all
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { TABLES } from './config.mjs';
import { ACCOUNTS, getAccount } from './accounts.mjs';
import { LAWS } from './laws.mjs';
import { readProductQueue, resolveQueue, testProductsFor } from './product-queue.mjs';
import { bannedTopicIssue, bridgeableProducts, bridgeEquivalents, donorAgeDays, numberedListiclePromise, plugBudget, tweetsFromRollup, spreadFactor, intentFactor, BRIDGE, DENY_ASINS, ALLOW_ASINS, EXPERIMENT_ASINS } from './checks.mjs';
import { productPerf, fleetEpc, classifyTopic } from './pick-product.mjs';
import { selectPod } from './outline.mjs';
import { foreignCtaIssue } from './retrofit-brief.mjs';
import { donorSlots } from './pod-place.mjs';
import { donorMemory, commitProducts } from './plan-week.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

// A prescription drug at the donor's sell slot is not a product we can swap into — it is a slot we
// have to strip. Kept separate from the funnel list because the remedy differs: a funnel gets cut,
// a drug slot means the whole item has to be rewritten or the donor dropped.
export const DRUG_RE = /\bglp[\s-]?1s?\b|semaglutide|tirzepatide|retatrutide|ozempic|wegovy|mounjaro|\bpeptides?\b|\bTRT\b|testosterone replacement/i;

// TWO GUARDS THE LIVE PICKER HAD LOST (found 2026-09-08 by reading its own output: a real batch
// surfaced "What happens if a man doesn't masturbate for 30 days" for a health page). The retired
// weekly selector screened every candidate against both of these; `screenDonor`, which replaced it, only
// ever checked banned topics and drugs — and `bannedTopicIssue` passes that hook cleanly.
//
// This is the same regression class as the missing intentFactor: the engine that replaced the old
// lanes did not inherit all of their screens. Blocking at SELECTION is the one that matters — a
// donor that never enters the pool cannot be rewritten into something off-brand later, and the
// rewrite is exactly where it would survive review, because every individual sentence looks fine.
//
// Adult/dating: the back-catalogue holds relationship threads a keyword scorer happily tags "Self
// Improvement" (its list literally includes "dating"), so a correctly TAGGED row can still be
// off-brand for a health persona. Off-niche: mega-virals about society, politics or religion get
// mis-tagged into a health niche, and a health page posting them is off-brand and against the
// no-politics rule.
// NARROWED to explicit only (operator 2026-09-08). The retired lane's list also caught `sex`,
// `libido`, `erectile`, `dating` and `pleasure`, and restoring it verbatim dropped a clean donor
// from a live batch — "If you wake at 3 AM, it's cortisol. If your belly won't budge, it's
// cortisol. If your sex drive's gone, it's cortisol" — on the word `sex`. For a fleet that sells
// testosterone support that is not off-brand copy, it is the product. Hormone words are allowed;
// explicit acts and anatomy are not.
//
// `in bed with`, not `in bed`: the fleet's biggest topic bucket is sleep, and "8 hours in bed" is
// ordinary copy there. The suggestive phrase is the one worth blocking.
export const ADULT_DENY = /\b(m[a*]sturbat\w*|ejaculat\w*|orgasm\w*|p[u*v]ssy|p[e*]nis|cum)\b|\b(slept with|turn her on|in bed with)\b/i;
export const OFF_NICHE = /\b(society|moral compass|civili[sz]ation|democracy|government|politic|election|communis|capitalis|religion|jesus|christ|the bible|quran|allah)\b/i;

// THE THIRD SCREEN THE LIVE PICKER HAD LOST. A donor whose hook depends on something we cannot
// reproduce as a text thread is not a donor at all: it points at a video, asks for a reply, or
// promises photographs. Both retired lanes screened it and `screenDonor` never did.
//
// The last three alternates are not a quality rule — they are a CRASH. daily-winners added them
// (2026-08-10) because the generate model refuses that class of donor and returns prose instead of
// JSON, which took the run down at recreate:213 rather than skipping one thread.
export const UNRECREATABLE = /this video|watch this|sound on|what'?s a |what is your|reply with|comment below|drop a |am i the only|unpopular opinion\?$|\d+ (pictures|photos|images|memes)|a thread of (videos|photos|pictures)|hitting it right|in the sheets|in bed with/i;

export { tweetsFromRollup };   // re-exported: it lives in checks.mjs so the planner can share it

/** PURE CORE. One donor row in, a verdict out. `products` is the allowlist we can actually sell,
 *  so "no sellable substance" means no substance WE hold, not no substance at all. */
export function screenDonor(fields = {}, { products = [], now = Date.now(), viewFloor = LAWS.selection?.viewFloor ?? 0 } = {}) {
  const hook = String(fields.Text || '');
  const body = String(fields['Full Thread Text'] || '');
  const whole = `${hook}\n${body}`;
  const tweets = tweetsFromRollup(body);
  const views = Number(fields.Impressions || 0);
  const age = Number((donorAgeDays(fields, { now }) || 0).toFixed(1));
  const substances = [...bridgeableProducts(whole)];
  const slots = tweets.length ? donorSlots(tweets) : [];
  const supplied = new Set((products || []).map((p) => p.asin));
  const sellSlots = slots.filter((s) => s.tier === 'sell' && s.asin && supplied.has(s.asin));
  const funnel = tweets.length ? foreignCtaIssue(tweets, {}) : [];
  // A funnel in the LAST three tweets is a tail we cut and lose nothing. One earlier than that sits
  // inside the argument, so cutting it takes an item with it — that is SURGERY, not a trim, and it
  // is not a rejection: three of the 08-28 batch shipped from donors with a buried funnel, stripped
  // by hand. Only a donor that is MOSTLY funnel has nothing left worth rebuilding.
  const tail = funnel.filter((f) => f.tweet > tweets.length - 3);
  const buried = funnel.filter((f) => f.tweet <= tweets.length - 3);
  const funnelHeavy = tweets.length > 0 && funnel.length / tweets.length > 0.35;

  let reject = null;
  // THE VIEW FLOOR (operator 2026-09-10: "floor must be 500k from now"). It lived only in
  // pick-donors, the /day-cover path, so preflight's own slate had NO floor at all — which is how
  // three covers at 426k, 330k and 315k reached a Friday whose floor was supposed to be 500k. The
  // number is laws.selection.viewFloor; this reads it rather than carrying a second copy.
  // The reason is CONSTANT, with no view count interpolated into it. The screen tallies rejects by
  // reason string, so putting the number here made every rejected donor its own bucket and printed
  // sixty one-line entries instead of "61 under the 500k view floor". The count is on `.views`.
  if (viewFloor && views < viewFloor) reject = `under the ${(viewFloor / 1000).toFixed(0)}k view floor`;
  else if (Number(fields['Thread Length'] || 0) < 3 || tweets.length < 3) reject = 'not a thread';
  else if (bannedTopicIssue(hook)) reject = 'BANNED TOPIC in the hook';
  // Screened on the HOOK, which is what the page's followers see and what the rewrite is built from.
  // Body matches are left to the banned-topic pass below: a thread can mention a word in passing
  // without being about it, and dropping on that would cost donors the old lane never dropped.
  else if (ADULT_DENY.test(hook)) reject = 'explicit subject in the hook — off-brand for a health page';
  else if (OFF_NICHE.test(hook)) reject = 'off-niche (society/politics/religion) mega-viral mis-tagged into a health niche';
  else if (UNRECREATABLE.test(hook)) reject = 'not recreatable as a text thread (video/reply-bait/photo hook)';
  // The body reads as a THREAD (a list), so a passing mention of a focus topic (cancer, owner 2026-09-29) is
  // allowed while a thread that keeps returning to it, treatment wording, or a claim about it is not.
  else if (bannedTopicIssue(tweets)) reject = 'banned topic in the body';
  else if (DRUG_RE.test(whole)) reject = 'prescription drug in the thread';
  else if (!substances.length) reject = 'no substance we can sell';
  else if (funnelHeavy) reject = `mostly funnel — ${funnel.length} of ${tweets.length} tweets pitch something of theirs`;

  return {
    recId: fields.recId || null,
    // The whole thread, kept so STAGE 2 can pick products from what the donor actually argues.
    // Product selection is not a writing decision — the substances are fixed by the donor's own
    // words, which we already hold here. That is what makes minting in advance safe.
    text: whole,
    views, age, tweets: tweets.length,
    hook: hook.split('\n')[0].slice(0, 74),
    // WHAT THIS THREAD IS ABOUT, from its FIRST LINE — the same idiom skeleton.mjs uses and the same
    // thing publish-thread stamps on the ledger (`classifyTopic(tweets[0])`). Computed here because
    // `hook` above is truncated to 74 chars for display and `text` is the whole thread: classifying
    // either one answers a different question than the tally it gets compared against.
    // A `general` first line now falls back to the whole thread rather than giving up (2026-09-17).
    // The fallback counts matches instead of taking the first bucket, so it cannot reproduce the
    // 2026-09-09 defect where feeding whole bodies in labelled 8 of 11 donors `sleep`.
    topic: classifyTopic(hook.split('\n')[0], whole),
    substances,
    sellSlots: sellSlots.map((s) => ({ at: s.at, substance: s.substance, asin: s.asin })),
    roundup: substances.length >= 3,
    listicle: numberedListiclePromise(hook),
    budget: plugBudget(tweets.length, { products: new Set(substances).size }),
    stripTail: tail.map((f) => f.tweet),
    surgery: buried.map((f) => ({ tweet: f.tweet, phrase: f.phrase })),
    usable: !reject,
    reject,
  };
}

/** PURE. Rank the survivors. Deliberately NOT views-first: a donor that already carries its own
 *  sell slot converts on a position the creator tested, and a roundup carries one plug per product
 *  instead of two. Both of those beat raw reach, which is why they are worth more than the age
 *  penalty they usually come with. */
/**
 * PURE. The reach PRIORITY multiplier for a donor, from LAWS.selection.reachTiers.
 *
 * Replaces `log10(views)`, which was decorative rather than weighted: it moved 5.40 at 250k to 6.70
 * at 5M, a 1.24x range against recency's 8.3x, so a three-day-old 250k donor outranked a twenty-day
 * -old 5M one by four to one and the view count never decided anything.
 *
 * The tiers are an OPERATOR PREFERENCE, not a measured effect, and `laws.json` carries the numbers
 * that say so — across 387 matured covers no donor virality metric predicts our result (|r| <= 0.26,
 * views itself -0.083). Prioritising 500k+ is a bet worth making explicit and tunable; it is not a
 * finding. The archive arm is the half of this change that can actually be read.
 */
export function reachTier(views, tiers = LAWS.selection?.reachTiers) {
  const t = Array.isArray(tiers) && tiers.length ? tiers : [[0, 1]];
  for (const [min, mult] of t) if ((views || 0) >= min) return mult;
  return 1;
}

/**
 * PURE. How much a donor's AGE should cost it.
 *
 * The old curve was `max(0.12, 0.5^(age/7))`, which floors at about 25 days — so every donor past
 * three and a half weeks carried the same 8.3x handicap against a fresh one. The measurement says
 * that cliff is not there: 30-90 day donors returned 100,165 median impressions, 74 clicks and
 * $51.56 a thread against 14-30 day donors' 107,489 / 64 / $54.79. Equal. `laws.json` carries the
 * full table.
 *
 * So the decay is real but slower and it STOPS: half-life 14 days down to a plateau at 0.33. The
 * one genuine unknown is past `archiveStepDays`, where the current regime has n=4 — that slice
 * takes a declared, conservative step rather than being excluded, because the operator chose the
 * 365-day vault knowing it is unproven and the archive readout is what settles it.
 */
export function decayFactor(age, sel = LAWS.selection || {}) {
  const a = Math.max(0, Number(age) || 0);
  const half = sel.recencyHalfLifeDays ?? 14;
  const floor = sel.recencyFloor ?? 0.33;
  const base = Math.max(floor, Math.pow(0.5, a / half));
  const step = sel.archiveStepDays ?? 90;
  if (a <= step) return base;
  // PAST THE STEP, A SLOPE RATHER THAN A CONSTANT (2026-09-17). The old line returned
  // `min(base, archiveDecay)`, and since base is already at its 0.33 floor by 30 days that was a
  // flat 0.15 for everything from 91 days to the 365-day bound — a 121-day donor and a 360-day one
  // scored identically, so reach was the only thing left that could separate them and the band
  // could never be ordered. It was fitted on seven covers; see laws.json $archiveDecay20260917.
  // Continuing the exponential from the step down to `evergreenFloor` keeps the band strictly below
  // every fresh donor while letting age still order it, which is what the evergreen arm needs to
  // pick the best of a band rather than an arbitrary member of it.
  const top = sel.archiveDecay ?? 0.15;
  const evergreen = Math.min(top, sel.evergreenFloor ?? 0.1);
  // PAST THE OG STEP the curve continues down to its own, lower plateau rather than stopping. The
  // band was un-pickable until 2026-09-17 and it is now reachable but still the weakest evidence we
  // have, so it ranks below every evergreen donor and gets shipped by ogShare, not by merit.
  const ogStep = sel.ogStepDays ?? 365;
  if (a <= ogStep) return Math.max(evergreen, top * Math.pow(0.5, (a - step) / (half * 8)));
  const ogFloor = Math.min(evergreen, sel.ogFloor ?? 0.06);
  return Math.max(ogFloor, evergreen * Math.pow(0.5, (a - ogStep) / (half * 20)));
}

/**
 * WHAT THE FLEET HAS BEEN ARGUING LATELY, as a { topic: weight } tally to seed `topicUses` with.
 *
 * The novelty tilt was built to count only what the DAY already argues, and that scope is what made
 * it toothless: `topicUses` started empty on every run, so each run reopened with every topic at
 * full novelty, picked the money topics first because they carry the intent multiplier, and
 * reproduced the same mix. Measured over the 20 days to 2026-09-09: sleep 33%, stress 15%, heart
 * 10%, fitness 10%, bloodsugar 6% — 74% of covers in five buckets, while `skin` (55 plug-able
 * products) took 5% and `joint` (33) took 2%. Halving every six covers inside one batch cannot fix
 * a bias that resets daily.
 *
 * Weight is a HALF-LIFE DECAYED count, not a raw one: a topic worked hard last week should still
 * cost something today, but less than one worked hard this morning, and a bounded window keeps the
 * tally from ossifying around whatever the fleet did a month ago. Reads the ledger's own `topic`
 * stamp (publish-thread writes it on every cover; 99% coverage over the last 20 days) rather than
 * re-classifying text, so this agrees with the picker by construction.
 *
 * PURE over injected rows and clock, like every other pacing helper here.
 */
export function topicMemory(ledgerRows, { now = Date.now(),
  days = LAWS.selection?.topicMemoryDays ?? 21,
  halfLifeDays = LAWS.selection?.topicMemoryHalfLifeDays ?? 7 } = {}) {
  const out = {};
  for (const e of ledgerRows || []) {
    // Covers only, and only rows that ARE a thread: an attributionOnly satellite is one more link on
    // a thread already counted, so counting it would weight roundups double.
    if (!e || e.attributionOnly || e.mode !== 'monetized' || !e.topic || !e.ts) continue;
    const age = (now - Date.parse(e.ts)) / 864e5;
    if (!Number.isFinite(age) || age < 0 || age > days) continue;
    out[e.topic] = (out[e.topic] || 0) + Math.pow(0.5, age / halfLifeDays);
  }
  return out;
}

/**
 * The topics carrying the most recent weight — "the five main topics", derived rather than listed
 * so the definition follows the mix instead of ossifying. Everything outside this set is COLD, and
 * the exploration floor in pick-donors reserves slots for it.
 */
export function hotTopics(memory, n = LAWS.selection?.hotTopicCount ?? 5) {
  return new Set(Object.entries(memory || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t));
}

/**
 * PURE. The age floors TOGETHER (2026-09-28). The picker binds its floors one at a time, once a single
 * floor's deficit fills the slots left. With fresh + archive = 1 every slot belongs to one of them, and
 * the old floors nest (og inside evergreen inside the vault), so a 31-90d donor shrinks only the widest.
 * Checked alone, merit took 9 of those where the vault had room for 6 (16 vault slots, 10 of them for
 * 90d+), the evergreen floor then claimed the last 10 slots, and the recent arm missed 3 of 24 at
 * --need 40 while recent donors went unused. So once the recent deficit plus the widest old deficit
 * fills the slots left, merit may only choose a donor that shrinks one of them: a recent one, or one
 * from the narrowest old band at that widest deficit. Counts are cumulative, as the picker keeps them:
 * `archive` is every kept donor past 30 days, `evergreen` past 90, `og` past 365. Returns the arms, or
 * null while there is slack.
 */
export function jointFloorArms(kept = {}, want = {}, slotsLeft = 0) {
  const n = (x) => Number(x) || 0;
  const short = { og: n(want.og) - n(kept.og), evergreen: n(want.evergreen) - n(kept.evergreen), archive: n(want.archive) - n(kept.archive) };
  const oldNeed = Math.max(short.og, short.evergreen, short.archive, 0);
  const freshNeed = Math.max(n(want.fresh) - n(kept.fresh), 0);
  if (!(freshNeed > 0 && oldNeed > 0 && freshNeed + oldNeed >= slotsLeft)) return null;
  const old = short.og === oldNeed ? ['og'] : short.evergreen === oldNeed ? ['evergreen', 'og'] : ['archive', 'evergreen', 'og'];
  return ['fresh', ...old];
}

/**
 * `topicUses` is a { topic: count } tally the caller supplies — how much the fleet already argues
 * this subject, seeded from `topicMemory` and then incremented per pick. Kept an argument rather
 * than a read for the same reason `headroom` does it: one function then answers both "what
 * happened" and "what would happen".
 */
export function rankDonors(screened, { now = Date.now(), testAsin = null, testAsins = null, topicUses = {} } = {}) {
  // testAsin (one) or testAsins (several, 2026-09-09). A donor that bridges ANY product under test
  // ranks first: the run now carries up to laws.product.testProductsPerRun of them.
  // An entry may be a bare ASIN or the product itself. bridgeEquivalents turns it into every ASIN a
  // donor could be arguing that this product honestly answers; for a bare ASIN that is only itself,
  // which is the exact-identity behaviour every earlier caller had.
  const want = new Set();
  for (const t of [...(testAsins || []), ...(testAsin ? [testAsin] : [])]) for (const a of bridgeEquivalents(t)) want.add(a);
  const spread = { halfLife: LAWS.selection?.topicSpreadHalfLife ?? 6, floor: LAWS.selection?.topicSpreadFloor ?? 0.4 };
  return (screened || []).filter((d) => d.usable).map((d) => {
    const recency = decayFactor(d.age);
    const reach = reachTier(d.views);
    // INTENT, restored to the live path. The retired daily-winners engine multiplied its selection
    // score by intentFactor(classifyTopic(hook)) and the picker that replaced it dropped the term,
    // so the one signal with a MEASURED effect stopped ordering anything: the 2026-09-01 leaky-viral
    // autopsy put $0.016/1k against $0.164/1k on identical read-through, a 10x spread on topic
    // alone, which is an order of magnitude more than donor size explains. Bounded [0.7, 1.4] by
    // intentFactor itself, and 1 for any topic with no measured sample — it can only reorder
    // donors the screen already admitted.
    // THE HOOK, NOT THE BODY (fixed 2026-09-09, found dry-running Run 3). classifyTopic returns the
    // FIRST bucket in TOPIC_KEYS order that matches anywhere in the text, and `sleep` is index 0 — so
    // feeding it a whole thread labelled 8 of 11 donors `sleep` whatever they were actually about,
    // while their hooks classified as bloodsugar, stress, skin, fitness and general. pick-product's
    // own comment says the function is "tuned for thread HOOKS".
    //
    // It made both halves of the diversity work inert. The novelty tilt looks a donor's topic up in
    // topicMemory's tally, and that tally is built from the ledger's `topic` stamp, which
    // publish-thread writes from the HOOK — so the tilt was reading body-topics out of a hook-topic
    // table. And because nearly every long body matched `sleep`, the multiplier came back as the same
    // 0.4 floor on eight of eleven donors, and a constant cannot reorder anything.
    const topic = d.topic || classifyTopic(String(d.hook || ''), String(d.text || ''));
    const intent = intentFactor(topic);
    // NOVELTY. 85% of what the fleet shipped in the current regime landed in five topic buckets,
    // and a funnel can only find what it tests — repetition at that rate is what stops new harvest
    // bodies appearing. Same tilt product diversity already uses, so there is ONE idiom for "picked
    // enough lately", and gentle by construction: halving every six covers leaves the money topics
    // leading and buys two or three exploratory slots a run.
    const novelty = spreadFactor(topicUses[topic] || 0, spread);
    // THE PRODUCT TEST RIDES A DONOR OR IT DOES NOT RIDE (Run 2: the B0B18YBN2X heart went unspent
    // across four days and 84 threads). A test product may only be the LIGHT plug on a cover whose
    // donor already argues its substance — commitSlateProducts enforces that — so if no such donor
    // is ON the slate the heart cannot be spent at all, and nobody learns that until the run is over.
    // The donors that CAN carry it are known here, from the donor's own words: rank them first.
    const bridgesTest = want.size > 0 && (d.substances || []).some((a) => want.has(a));
    // FOUR FACTORS, FOUR QUESTIONS (operator 2026-09-08, objective: money per thread). The old chain
    // mixed them, and because recency swung 8.3x against reach's 1.24x it was effectively a recency
    // sort with decoration. Now:
    //   worth   — will it make money?  intent (the one measured 10x effect) x the shape boosts
    //   proof   — did it actually work?  reachTier, the operator's 500k+ priority
    //   recency — is it still going to land?  fitted, not assumed
    //   novelty — have we worn this subject out?
    const worth = intent
      * (d.sellSlots.length ? 1.6 : 1)     // the creator already picked the converting position
      * (d.roundup ? 1.5 : 1)              // one plug per product instead of two
      * (d.listicle ? LAWS.selection?.listicleBoost ?? LAWS.scale?.listicleBoost ?? 1.15 : 1);
    const score = worth * reach * recency * novelty
      * (bridgesTest ? 2 : 1);             // ordering only: it never admits a donor the screen rejected
    return {
      ...d,
      recency: Number(recency.toFixed(3)),
      reach, topic, novelty: Number(novelty.toFixed(3)),
      intent: Number(intent.toFixed(3)),
      // Which lane this donor came from. Derived from age alone, so the readout can split published
      // covers by arm months later with nothing stamped on the draft: donor age at post time is
      // recoverable from Source Thread plus the swipe row's Published Date.
      // THREE ARMS (2026-09-17). `archive` used to mean everything past 30 days, which lumped a
      // 45-day donor in with a 300-day one — and those two bands measure nothing like each other
      // (31-60d $58.19 a thread, 91-365d $9.61-$24.65 on n=7). Splitting them at archiveStepDays is
      // what lets evergreenShare reserve slots for the old band without the vault arm silently
      // filling its own quota out of the near band and calling the bet tested.
      arm: (d.age || 0) > (LAWS.selection?.ogStepDays ?? 365) ? 'og'
        : (d.age || 0) > (LAWS.selection?.archiveStepDays ?? 90) ? 'evergreen'
        : (d.age || 0) > (LAWS.selection?.viralWindowDays ?? 30) ? 'archive' : 'fresh',
      bridgesTest,
      score: Number(score.toFixed(3)),
    };
  }).sort((a, b) => b.score - a.score);
}

/** PURE. Can this batch actually spend the test heart? The slate's donors are the whole answer:
 *  a test product ships only as the light plug on a cover whose donor bridges its substance. */
export function testSlotReport(slate = [], test = null, { max = LAWS.product?.testCoversPerHeart ?? 3, slot = 'light' } = {}) {
  if (!test) return { asin: null, carriers: [], spendable: 0, slot, problem: null };
  const want = String(test?.asin ?? test).toUpperCase();
  // SUBSTANCE, NOT IDENTITY. `substances` are BRIDGE targets, and BRIDGE points each term at one
  // product, so asking whether a donor argues this exact ASIN says no for every product that is not
  // itself a BRIDGE target — permanently, on every slate. Pass the product (not just its ASIN) and a
  // donor arguing ubiquinol carries any ubiquinol bottle we stock.
  const bridges = bridgeEquivalents(test);
  const carriers = (slate || []).filter((s) => s.donor && (s.donor.substances || []).some((a) => bridges.has(a))).map((s) => ({ account: s.name || s.account, day: s.day, recId: s.donor.recId }));
  const spendable = Math.min(carriers.length, max);
  return { asin: want, carriers, spendable, slot,
    problem: spendable ? null : `product test ${want} is UNSPENDABLE on this slate — no donor argues its substance, so the heart would go out unspent (pick a donor that bridges it, or spend the heart on another run)` };
}

/** PURE. Every product under test, reported the same way. One UNSPENDABLE product is one problem —
 *  the run still goes, it just carries fewer tests than the queue asked for. */
export function testSlotReports(slate = [], tests = []) {
  // `t`, not `t.asin`: the product's title is what carries its substance identity, and handing this
  // a bare ASIN is what made the whole queue report UNSPENDABLE while placement was working.
  return tests.map((t) => testSlotReport(slate, t, { max: t.max ?? LAWS.product?.testCoversPerHeart ?? 3, slot: t.slot || 'light' }));
}

/** PURE. Hand each account a donor it has not used, spreading products as we go so no single ASIN
 *  runs away with the batch. This is the pass whose absence caused four mid-flight reassignments. */
export function assignSlate(ranked, accounts, { perAccount = 1, memory = new Map(), asinCap = 0.3 } = {}) {
  const slate = [];
  const asinUse = new Map();
  const mine = new Map();                 // account key -> bodies this BATCH has already given it
  const total = accounts.length * perAccount;
  const cap = Math.max(2, Math.ceil(total * asinCap));
  for (let round = 0; round < perAccount; round++) {
    // ONE DAY, ONE BODY (operator 2026-09-03). The exclusion is per DAY, never per batch. Two pages
    // recreating the same donor on the same day is the thing readers notice; the same body running
    // again two days later on a different page is how the pool is MEANT to be spent, and the swipe
    // file is finite. Holding `taken` across every round — which is what this did until now — quietly
    // made a 3-day run cost 42 donors where 28 would have done, against a stock of ~1300 and a burn
    // of ~34 a week. That is a third of the runway, given away for an editorial gain of nothing.
    //
    // What DOES survive the whole batch is `mine`: one account never runs the same body twice in a
    // run, which the old batch-wide set enforced as a side effect and which is worth keeping on purpose.
    const takenToday = new Set();
    for (const acc of accounts) {
      const used = memory.get(acc.name) || memory.get(acc.key) || new Set();
      const own = mine.get(acc.key) || new Set();
      const free = (d) => !takenToday.has(d.recId) && !used.has?.(d.recId) && !own.has(d.recId);
      const pick = ranked.find((d) => {
        if (!free(d)) return false;
        // Would this donor push an already-hot ASIN past its share of the batch?
        const heavy = d.substances.some((a) => (asinUse.get(a) || 0) >= cap);
        return !heavy;
      }) || ranked.find(free);
      if (!pick) { slate.push({ account: acc.key, name: acc.name, donor: null, why: 'no unused donor left in the pool' }); continue; }
      takenToday.add(pick.recId);
      if (!mine.has(acc.key)) mine.set(acc.key, new Set());
      mine.get(acc.key).add(pick.recId);
      for (const a of pick.substances.slice(0, pick.budget)) asinUse.set(a, (asinUse.get(a) || 0) + 1);
      slate.push({ account: acc.key, name: acc.name, day: round + 1, donor: pick, why: null });
    }
  }
  return { slate, asinUse };
}

/** PURE. The subid a thread's link will carry. Deterministic — no random suffix — so the slate can
 *  emit it, mint against it, and the writer can paste it without the two ever drifting apart.
 *  Ends with the donor recId's last 6 (tracking-smoke checks for that); a second product takes -b,
 *  a third -c, matching how every draft in the archive is built. Capped at 50 characters. */
export function slateSubid(accountKey, hook, recId, index = 0) {
  const tail = String(recId || '').slice(-6);
  const suffix = index > 0 ? `-${String.fromCharCode(97 + index)}` : '';
  const room = 50 - `x-thread-${accountKey}-`.length - tail.length - 1 - suffix.length;
  const slug = String(hook || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, Math.max(4, room)).replace(/-$/, '');
  return `x-thread-${accountKey}-${slug}-${tail}${suffix}`;
}

/** STAGE 2. Pick the products for every slate row, before a word is written.
 *
 *  This reuses the PLANNER's own picker rather than a second one, deliberately. commitProducts
 *  already carries every principle that matters and each was paid for: pod coverage first (a
 *  product selectPod cannot answer has no CTA available, so committing it plans a slot that cannot
 *  legally be written), then the fleet-EPC demotion gated on the operator's 100-click rule (an
 *  unjudged product keeps its place — that is the explorer traffic that finds the next $0.60
 *  earner), then a spread tiebreak on least-used across the WHOLE batch, not per slot.
 *
 *  `used` is shared across every row on purpose. That shared counter is the thing whose absence
 *  made one ASIN take 11 of 46 plugs on 2026-08-28: picking greedily per thread cannot see the
 *  batch, so it cannot spread across it. */
export function commitSlateProducts(slate, allProducts, { exploreBudget = 22, testProduct = null, testProducts = null } = {}) {
  const used = {};
  const perf = productPerf();
  // PRODUCT TEST SLOTS (operator 2026-09-02, widened 2026-09-09; laws.json product.$test). Products
  // under test ride on rows whose donor already argues their substance — never on a row the donor does
  // not bridge to, because the substance law still decides relevance. Each takes up to `max` rows;
  // that is one "heart".
  //
  // The slot each one gets comes from the operator's queue. LIGHT is plug index 1, the original shape.
  // HEAVY is index 0 and SWAPS rather than replaces: the judged product that held the money slot drops
  // to light instead of leaving the thread, so the cost of a heavy test is the ~1.25x traffic
  // difference between the slots and not the whole plug. testHeavyCovers caps heavy placements
  // fleet-wide; past it a heavy test keeps riding, as light.
  const tests = (Array.isArray(testProducts) && testProducts.length ? testProducts : (testProduct ? [testProduct] : []))
    .map((t) => ({
      asin: t.asin,
      slot: t.slot === 'heavy' ? 'heavy' : 'light',
      max: Number(t.max ?? LAWS.product?.testCoversPerHeart ?? 3),
      // How many of THIS product's covers take the money slot. One by default, so three queued
      // products get one heavy cover each rather than the first one draining the whole budget.
      heavyCovers: t.slot === 'heavy' ? Number(t.heavyCovers ?? 1) : 0,
      // A dated one-run priority is an exact allocation, not merely an extra test insertion. Keep it
      // out of the normal picker so natural ranking cannot silently exceed its cover/heavy caps.
      oneRunOnly: !!t.oneRunOnly,
      // FORCED BY TOPIC (owner 2026-09-28, the multivitamin: "Force it on 6 covers"). A product no donor
      // names by substance can never be placed by the substance law below, so a forced entry also lands
      // on rows whose topic it lists, as the heavy, marked needsBridge: the writer builds the bridge. Its
      // heavy placements are the owner's exact allocation, so they do not spend testHeavyCovers.
      topics: Array.isArray(t.topics) ? t.topics : [],
      forced: !!t.forced,
      entry: allProducts.find((p) => p.asin === t.asin) || null,
      placed: 0,
      heavyPlaced: 0,
    }))
    .filter((t) => t.entry && !DENY_ASINS.has(t.asin))
    // Which of a donor's BRIDGE targets count as arguing THIS product's substance, read off the
    // product's own title once. Without it a queued product that is not itself a BRIDGE target can
    // never be placed on any row — see bridgeEquivalents.
    .map((t) => ({ ...t, bridges: bridgeEquivalents(t.entry) }));
  const exclusiveAsins = new Set(tests.filter((t) => t.oneRunOnly).map((t) => t.asin));
  let heavyBudget = Number(LAWS.product?.testHeavyCovers ?? 0);
  const report = { noPod: 0, podStarved: 0, epcStarved: 0, demoted: 0, exploreSpent: 0, exploreBudget, testPlaced: 0, testHeavyPlaced: 0, testAsin: tests[0]?.asin || null, tests: [] };
  for (const row of slate) {
    if (!row.donor) continue;
    const text = row.donor.text || row.donor.hook || '';
    const budget = row.donor.budget || 2;

    // RELEVANCE FIRST, AND IT IS NOT NEGOTIABLE. commitProducts ranks on TOPIC — a thread that
    // classifies as "energy" can host B12 whether or not the donor ever says B12 — which is right
    // for the ENGINE, where a pod brings its own point and bridge and argues the substance in our
    // copy. It is wrong for a slate that mints in advance: run unrestricted it handed Julian's
    // hair-regrowth donor a B12 link and Rafael's nitric-oxide donor a D3+K2 one. Shipping those is
    // the exact failure the substance law exists to stop — walk the reader to one thing, hand them
    // another.
    //
    // So the picker runs TWICE. First over only the ASINs the donor's own words bridge to, which is
    // what makes a link safe to mint before the copy exists and what lets a plug claim the donor's
    // sell slot. Only if that cannot fill the budget does it top up from the wider topical pool, and
    // those are marked needsBridge: the writer must build a point and a bridge for them, and they
    // may never take a sell slot.
    const bridged = new Set(row.donor.substances);   // bridgeableProducts returns ASINs, not terms
    // THE HOOK'S OWN SUBSTANCE COMES FIRST (R2026-09-27): "Magnesium = Testosterone" (3.5M views) was
    // handed beet root as its heavy because magnesium had already been spent on earlier rows and spread
    // halved its score; Jev then read the donor as arguing another product and the donor was swapped
    // out. Spread still orders everything else, and it never takes a thread's hook product away from it.
    const hookBridged = bridgeableProducts(String(row.donor.hook || ''));
    // A product Jev picked for a donor that names no supplement (donor-routes.mjs, owner 2026-09-28) is the
    // row's own route, but the donor never argued it: the writer builds that bridge.
    const jevBridged = new Set(row.donor.jevBridged || []);
    // A bridged product's relevance is PROVEN by the donor's own words, so it does not also have to
    // satisfy the topic matcher — running it through commitProducts returned nothing, because the
    // topic classifier and the BRIDGE table disagree about what a thread is "about". What a bridged
    // product still has to pass is the rest: not denied, on the allowlist, actually purchasable, and
    // covered by a pod so a CTA can legally be written for it. Then rank on realised EPC, which is
    // the selection metric everywhere else in the system.
    const primary = allProducts
      // EXPERIMENT products pass the allowlist gate here exactly as they do in pick-product's
      // `eligible`: a product under test has to be able to ship, or it can never be judged.
      .filter((p) => !exclusiveAsins.has(p.asin) && bridged.has(p.asin) && !DENY_ASINS.has(p.asin) && !p.unavailable
        && (!ALLOW_ASINS.size || ALLOW_ASINS.has(p.asin) || EXPERIMENT_ASINS.has(p.asin)) && !!selectPod(p, { account: row.account })?.pod)
      .map((p) => ({ ...p, epc: Number(perf[p.asin]?.epc ?? 0) }))
      // SPREAD (2026-08-29). This sort used to read `(b.epc - a.epc) || (used[a] - used[b])`, which
      // put diversity behind EPC as a tiebreaker — and realised EPC is a float, so the tie never
      // happened and the top product took every slot it was eligible for. The 08-31 slate ran
      // magnesium on 8 of its 11 threads and KSM-66 on 6. Usage is now a MULTIPLIER on the score,
      // halving it every LAWS.product.spreadHalfLife picks, the same shape recencyFactor already
      // uses to tilt donors by age. It orders and never excludes.
      .sort((a, b) => (Number(hookBridged.has(b.asin)) - Number(hookBridged.has(a.asin)))
        || (b.epc * spreadFactor(used[b.asin] || 0)) - (a.epc * spreadFactor(used[a.asin] || 0)))
      .slice(0, budget)
      .map((p) => ({ asin: p.asin, title: String(p.title || ''), unjudged: (perf[p.asin]?.clicks ?? 0) < 100 }));
    for (const p of primary) used[p.asin] = (used[p.asin] || 0) + 1;
    const shortBy = budget - primary.length;
    const filler = shortBy > 0
      ? commitProducts(text, allProducts, used, budget, report).filter((p) => !exclusiveAsins.has(p.asin) && !primary.some((x) => x.asin === p.asin)).slice(0, shortBy)
      : [];
    let picked = [...primary, ...filler];
    // ONE test per row, and only where the donor bridges to it: two unjudged products in one thread
    // confounds both. Queue order decides which — the operator's first choice fills its rows first.
    const topicFit = (x) => x.forced && x.topics.includes(row.donor.topic);
    const t = picked.length >= 1
      ? tests.find((x) => x.placed < x.max && ([...x.bridges].some((a) => bridged.has(a)) || topicFit(x)) && !picked.some((p) => p.asin === x.asin))
      : null;
    let testIndex = -1;
    if (t) {
      const entry = { asin: t.asin, title: String(t.entry.title || ''), unjudged: (perf[t.asin]?.clicks ?? 0) < 100 };
      const goHeavy = t.slot === 'heavy' && t.heavyPlaced < t.heavyCovers && (t.forced || heavyBudget > 0);
      const rest = picked.slice(1).filter((p) => p.asin !== t.asin);
      // HEAVY: [test, the judged pick that was heavy, …rest]. LIGHT: [heavy pick, test, …rest].
      picked = goHeavy ? [entry, picked[0], ...rest] : [picked[0], entry, ...rest];
      picked = picked.slice(0, Math.max(budget, 2));
      testIndex = goHeavy ? 0 : 1;
      // Math.max(budget, 2) is what keeps the demoted judged pick on the thread: a budget of 1 would
      // otherwise slice it straight back off and a heavy test WOULD replace rather than swap.
      if (goHeavy) { if (!t.forced) heavyBudget--; t.heavyPlaced++; report.testHeavyPlaced++; }
      used[t.asin] = (used[t.asin] || 0) + 1;
      t.placed++;
      report.testPlaced++;
    }
    row.products = picked.map((p, i) => ({
      asin: p.asin,
      title: p.title,
      unjudged: !!p.unjudged,
      needsBridge: !bridged.has(p.asin) || jevBridged.has(p.asin),
      ...(i === testIndex ? { test: true, testSlot: testIndex === 0 ? 'heavy' : 'light', ...(t?.forced ? { forced: true } : {}) } : {}),
      subid: slateSubid(row.account, row.donor.hook, row.donor.recId, i),
    }));
    // A thread the picker could not fill to the floor cannot ship: the plug budget has a minimum of
    // two, and finding that out at the gate costs a rewrite. Say it here instead.
    row.thin = row.products.length < 2 ? `only ${row.products.length} product(s) fit — budget floor is 2` : null;
  }
  report.tests = tests.map((t) => ({ asin: t.asin, slot: t.slot, placed: t.placed, heavyPlaced: t.heavyPlaced, max: t.max, heavyCovers: t.heavyCovers }));
  return { used, report };
}

/** PURE. Every mint the batch needs, in one array, ready for mint-batch.mjs. */
export function mintJobs(slate) {
  return slate.flatMap((r) => (r.products || []).map((p) => ({ asin: p.asin, subid: p.subid })));
}

const ok = (b) => (b ? '✓' : '✗');

async function main() {
  const DAYS = Math.max(1, Number(arg('days', 1)));
  const ONE = arg('account', null);
  const JSON_OUT = process.argv.includes('--json');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const at = airtable(env);
  const problems = [];

  // ---- 1. environment -----------------------------------------------------------------------
  const boardPath = join(HERE_DIR, 'learnings', 'product-board.json');
  const boardAge = existsSync(boardPath) ? (Date.now() - statSync(boardPath).mtimeMs) / 864e5 : null;
  const hasLLM = !!(env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY);
  const envRows = [
    ['AIRTABLE_PAT', !!env.AIRTABLE_PAT, 'required'],
    ['TYPEFULLY_API_KEY', !!env.TYPEFULLY_API_KEY, 'required to create drafts'],
    ['LEVANTA creds', !!(env.LEVANTA_API_KEY || env.LEVANTA_TOKEN), 'required to mint links'],
    ['LLM key', hasLLM, hasLLM ? 'engine can generate' : 'HAND-WRITE MODE — recreate.mjs cannot run here'],
    ['product board', boardAge !== null && boardAge < 7, boardAge === null ? 'MISSING' : `${boardAge.toFixed(1)}d old`],
  ];
  for (const [k, good, note] of envRows) if (!good && /required|MISSING/.test(note)) problems.push(`env: ${k} — ${note}`);

  // ---- 2. roster ----------------------------------------------------------------------------
  const roster = Object.values(ACCOUNTS)
    .filter((a) => !a.paused && a.socialSetId && a.plugHeavyExample)
    .filter((a) => !ONE || a.key === ONE || a.name.toLowerCase().includes(String(ONE).toLowerCase()));
  const rosterIssues = [];
  for (const a of roster) {
    const miss = ['closing', 'disclaimer', 'voice', 'socialSetId'].filter((f) => !a[f]);
    if (miss.length) rosterIssues.push(`${a.name}: missing ${miss.join(', ')}`);
  }
  if (!roster.length) problems.push('roster: no active accounts matched');
  rosterIssues.forEach((r) => problems.push(`roster: ${r}`));

  // ---- 3. donor pool — ONE read, whole bodies included --------------------------------------
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || [];
  const window = LAWS.selection?.viralWindowDays ?? 21;
  const t0 = Date.now();
  const recs = await at.list(TABLES.swipe, {
    formula: `AND({Tweet Number}=1,{Thread Length}>=3,NOT({Quoted Junk}),NOT({Single Tweet}),NOT({Drafted}),{Impressions}>=${LAWS.selection?.minImpressions ?? 250000},IS_AFTER({Published Date},DATEADD(NOW(),-${window},"days")))`,
    fields: ['Text', 'Impressions', 'Published Date', 'Thread Length', 'Full Thread Text', 'Tweet URL', 'Niche'],
    max: 2000, pageSize: 100,
  });
  const readMs = Date.now() - t0;
  const screened = recs.map((r) => screenDonor({ ...r.fields, recId: r.id }, { products }));
  const usable = screened.filter((d) => d.usable);
  const rejected = screened.filter((d) => !d.usable);
  const byReason = {};
  for (const d of rejected) byReason[d.reject.replace(/ at tweet \d+.*/, '')] = (byReason[d.reject.replace(/ at tweet \d+.*/, '')] || 0) + 1;

  // ---- 4. the slate -------------------------------------------------------------------------
  const ledPath = join(HERE_DIR, 'ledger.jsonl');
  const ledLines = existsSync(ledPath) ? readFileSync(ledPath, 'utf8').split('\n').filter(Boolean) : [];
  const memory = donorMemory(ledLines);
  // WHAT RIDES AS A TEST. --test-product takes one ASIN or a comma list and wins outright; with no
  // flag the run reads the operator's standing queue (queues/product-queue.json) instead of nobody
  // remembering to name one. Run 2 shipped 84 threads and spent no heart at all because naming the
  // product was a step a human had to remember.
  const TEST_FLAG = arg('test-product', null);
  const flagAsins = TEST_FLAG ? String(TEST_FLAG).toUpperCase().split(',').map((a) => a.trim()).filter(Boolean) : [];
  const queueResolved = flagAsins.length ? [] : resolveQueue(readProductQueue().queue, { products, status: new Map(), hasPod: (p) => !!selectPod(p, {})?.pod });
  // Carry the title: substance equivalence is read off the product's own label, so a list of bare
  // ASINs would fall back to exact identity and report the queue UNSPENDABLE again.
  const testList = (flagAsins.length
    ? flagAsins.map((asin) => ({ asin, slot: 'light', max: LAWS.product?.testCoversPerHeart ?? 3 }))
    : testProductsFor(queueResolved)
  ).map((t) => ({ ...t, title: t.title || products.find((p) => p.asin === t.asin)?.title || '' }));
  const TEST_ASIN = testList[0]?.asin || null;   // kept: the single-product callers and --json readers
  // SEEDED THE SAME WAY pick-donors seeds it, or this tool lies. It used to call rankDonors with no
  // topicUses at all, so every donor scored novelty 1.0 and the slate printed here was NOT the slate
  // the run would choose — which is the one job a pre-flight has. The batch increment is still
  // pick-donors' (it re-ranks per pick); this is the history both start from.
  const topicUses = topicMemory(ledLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  const ranked = rankDonors(usable, { testAsins: testList, topicUses });
  const { slate } = assignSlate(ranked, roster, { perAccount: DAYS, memory });
  // STAGE 2 — products, before a word is written, so every link can be minted in one batch.
  const { used: asinUse2, report: prodReport } = commitSlateProducts(slate, products, {
    exploreBudget: roster.length * (LAWS.product?.exploreSlots ?? 2),
    testProducts: testList,
  });
  // The test slots are answered HERE, at plan time, not discovered unspent after the run.
  const testSlots = testSlotReports(slate, testList);
  const testSlot = testSlots[0] || { asin: null, carriers: [], spendable: 0, problem: null };
  for (const t of testSlots) if (t.problem) problems.push(t.problem);
  const asinUse = new Map(Object.entries(asinUse2));
  const jobs = mintJobs(slate);
  const thin = slate.filter((s) => s.donor && s.thin);
  thin.forEach((s) => problems.push(`products: ${s.name} d${s.day} — ${s.thin}`));
  const unfilled = slate.filter((s) => !s.donor);
  if (unfilled.length) problems.push(`supply: ${unfilled.length} slot(s) have no unused donor — ${unfilled.map((s) => s.name).join(', ')}`);
  const need = roster.length * DAYS;
  if (ranked.length < need) problems.push(`supply: ${ranked.length} usable donors for ${need} slots`);

  if (process.argv.includes('--mint-jobs')) { console.log(JSON.stringify(jobs)); return; }
  if (JSON_OUT) {
    console.log(JSON.stringify({ go: !problems.length, problems, pool: { raw: recs.length, usable: usable.length, byReason }, testSlot, testSlots, productQueue: queueResolved, slate, mintJobs: jobs }, null, 2));
    return;
  }

  // ---- report -------------------------------------------------------------------------------
  console.log(`\nPREFLIGHT — ${roster.length} account(s) × ${DAYS} day(s) = ${need} slot(s)\n`);

  console.log('ENVIRONMENT');
  for (const [k, good, note] of envRows) console.log(`  ${ok(good)} ${k.padEnd(20)} ${note}`);

  console.log('\nROSTER');
  console.log(`  ${ok(!rosterIssues.length)} ${roster.length} active account(s): ${roster.map((a) => a.name).join(', ')}`);
  rosterIssues.forEach((r) => console.log(`    ✗ ${r}`));

  console.log('\nDONOR POOL   (one call, full bodies, ' + (readMs / 1000).toFixed(1) + 's)');
  console.log(`  ${recs.length} in the ${window}-day window past Airtable's own gates`);
  console.log(`  ${ok(usable.length >= need)} ${usable.length} usable, ${rejected.length} screened out`);
  for (const [why, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(3)}  ${why}`);
  const withSlot = usable.filter((d) => d.sellSlots.length).length;
  const rounds = usable.filter((d) => d.roundup).length;
  console.log(`  of the usable: ${withSlot} carry the creator's own sell slot, ${rounds} are roundups (3+ substances)`);

  console.log('\nSLATE');
  for (const s of slate) {
    if (!s.donor) { console.log(`  ✗ ${s.name.padEnd(16)} ${s.why}`); continue; }
    const d = s.donor;
    const marks = [
      d.sellSlots.length ? `SELL@${d.sellSlots.map((x) => x.at).join(',')}` : null,
      d.roundup ? 'ROUNDUP' : null,
      d.stripTail.length ? `strip tail t${d.stripTail.join(',')}` : null,
      d.surgery.length ? `SURGERY t${d.surgery.map((x) => x.tweet).join(',')}` : null,
    ].filter(Boolean).join(' · ');
    console.log(`  ${ok(true)} ${s.name.padEnd(16)} d${s.day}  ${String(d.views).padStart(8)}  ${String(d.age).padStart(5)}d  n${String(d.tweets).padEnd(3)} ${d.budget} plug  ${d.recId}`);
    console.log(`      ${d.hook}`);
    console.log(`      ${d.substances.slice(0, 5).join(', ')}${marks ? `   [${marks}]` : ''}`);
    for (const p of s.products || []) {
      const tag = [p.unjudged ? 'unjudged' : null, p.needsBridge ? 'NEEDS BRIDGE' : 'donor argues it'].filter(Boolean).join(', ');
      console.log(`      → ${p.asin}  ${String(p.title).slice(0, 38).padEnd(40)} ${p.subid}`);
      console.log(`        ${tag}`);
    }
    if (s.thin) console.log(`      ✗ ${s.thin}`);
  }

  if (asinUse.size) {
    console.log('\nPRODUCT SPREAD (forecast)');
    for (const [a, n] of [...asinUse].sort((x, y) => y[1] - x[1])) {
      const t = products.find((p) => p.asin === a);
      console.log(`  ${String(n).padStart(2)}x  ${a}  ${String(t?.title || '').slice(0, 50)}`);
    }
  }

  console.log(`\nMINT — ${jobs.length} link(s), one batch, run this before writing:`);
  console.log(`  node mint-batch.mjs --jobs '${JSON.stringify(jobs.slice(0, 2))}'   ...${jobs.length} jobs`);
  console.log(`  (full array: node preflight.mjs --days ${DAYS} --mint-jobs)`);
  if (prodReport.noPod || prodReport.demoted) {
    console.log(`  picker: ${prodReport.noPod} candidate(s) had no pod · ${prodReport.demoted} demoted as judged losers · explorers ${prodReport.exploreSpent}/${prodReport.exploreBudget}${prodReport.testAsin ? ` · 🧪 test ${prodReport.testAsin} placed on ${prodReport.testPlaced} row(s)${prodReport.testPlaced === 0 ? ' — no donor in this batch bridges to it' : ''}` : ''}`);
  }

  if (testSlots.length) {
    console.log(`\nPRODUCT TEST — ${testSlots.length} product(s)${flagAsins.length ? ' (--test-product)' : ' from queues/product-queue.json'}, heavy cap ${LAWS.product?.testHeavyCovers ?? 0} cover(s)`);
    for (const t of testSlots) {
      const placed = prodReport.tests.find((x) => x.asin === t.asin);
      console.log(`  ${t.slot === 'heavy' ? '💰 heavy' : '  light'} ${t.asin}: ${t.spendable ? `${t.spendable} cover(s) can carry it — ${t.carriers.slice(0, 4).map((c) => `${c.account} d${c.day}`).join(', ')}` : 'UNSPENDABLE on this slate (no donor argues its substance)'}${placed ? ` · placed ${placed.placed}/${placed.max}${placed.heavyPlaced ? ` (${placed.heavyPlaced} heavy)` : ''}` : ''}`);
    }
    const skipped = queueResolved.filter((q) => !q.riding);
    for (const q of skipped) console.log(`  ⏭ ${q.asin}: ${q.reason}`);
  }
  console.log(`\n${problems.length ? '✗ NO-GO — fix these first:' : '✓ GO — nothing blocking'}`);
  problems.forEach((p) => console.log(`   · ${p}`));
  console.log('');
  if (problems.length) process.exitCode = 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) await runMain(main, 'preflight');
