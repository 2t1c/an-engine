// outline.mjs — decide the SHAPE of a thread before a word of it is written.
//
// This is the missing step. Today the body is written blind to the product, then plugs are bolted
// on by a second call and the run-ups patched by a third, because nobody ever decided where the
// plugs go or what the tweets around them are FOR. The outline decides all of it up front, so the
// writer can be handed the product and write the thread once.
//
// It is deliberately PURE — no LLM, no network, no writes. Every decision here is a rule we can
// state, and a rule we can state is a rule we can test. That matters more than usual: the outline
// is upstream of everything, so a defect here is a defect in every thread.
//
//   node outline.mjs --donor <recId>        (CLI wrapper lives in thread-brief; this file is the brain)
import { pathToFileURL } from 'node:url';
import {
  listicleKind, bridgeableProducts, substanceTermsFor, plugBudget, leadingNumbers, isStack, BRIDGE, hookSimilarity,
} from './checks.mjs';
import { LAWS, SIGN_OFF_ON } from './laws.mjs';
import { PODS, renderPod, variantFor, podFitsProduct, podById, POD_VARIANT_MAX, resolveFrame, UNNUMBERED_FRAMES } from './pods.mjs';

// ---- shape ---------------------------------------------------------------------------------------
// The single highest-leverage decision, because it sets the plug budget, the run-up length and
// whether item 1 can be the product at all. Measured over 45 days: a roundup earns $54.56 a post, a
// single-substance deep dive converts ~3x harder per impression, and a thread that merely name-drops
// substances without being FRAMED as a supplement list is the worst of both.
// Beat counts live in laws.json (runUpBeats) — the prompt's ramp text is derived from the same
// numbers, which is what keeps "the outline plans one beat" and "the prompt demands two" from ever
// disagreeing again (that exact fight shipped 82% of a batch with the criterion after the plug).
export const SHAPES = {
  roundup: { plugsPerProduct: 1, runUp: LAWS.runUpBeats.roundup, note: 'hook already primed the reader — item names substance + why, then CTA' },
  deepDive: { plugsPerProduct: 1, runUp: LAWS.runUpBeats.deepDive, note: 'whole thread is the run-up — benefits delivered, then criterion, then CTA' },
  diagnostic: { plugsPerProduct: 1, runUp: LAWS.runUpBeats.diagnostic, note: 'item 1 is an observation — introduce the substance, then the criterion, then CTA' },
  conceptual: { plugsPerProduct: 1, runUp: LAWS.runUpBeats.conceptual, note: 'concept, explain + tie, explain the tie, criterion, CTA' },
  prescriptive: { plugsPerProduct: 1, runUp: LAWS.runUpBeats.prescriptive, note: 'item may BE the substance — benefit, criterion, CTA' },
};

/**
 * Pure: which shape should this donor become? `bridgeable` is the set of allowlist ASINs the donor's
 * own words can host — the count is what decides whether we convert the topic to supplements at all.
 * Exported for tests.
 */
export function chooseShape(donorTweets, { bridgeable = [], moldId = null, itemCount = 0 } = {}) {
  const hook = String(donorTweets?.[0] || '');
  const kind = listicleKind(hook);
  const supplementNative = /\b(supplements?|vitamins?|minerals?|nutrients?)\b/i.test(hook);

  // Already a supplement list: it IS a roundup, and the hook has done the agitation itself.
  if (supplementNative && bridgeable.length >= 3) return { shape: 'roundup', kind, supplementNative, why: 'hook already promises supplements and the thread can host 3+' };
  // Convertible: enough distinct substances in the donor's own words to swap the noun honestly.
  if (bridgeable.length >= 3 && itemCount >= 3) return { shape: 'roundup', kind, supplementNative, why: `donor hosts ${bridgeable.length} allowlist substances — swap the promise noun to "supplements"` };
  // One substance carries the whole thread.
  if (bridgeable.length === 1 && itemCount <= 4) return { shape: 'deepDive', kind, supplementNative, why: 'one substance and a short donor — the whole thread is the run-up' };
  // Otherwise the shape follows the hook's own promise.
  if (kind === 'diagnostic') return { shape: 'diagnostic', kind, supplementNative, why: 'hook promises signs/reasons — item 1 must be the observation' };
  if (kind === 'prescriptive') return { shape: 'prescriptive', kind, supplementNative, why: 'hook promises ways/things — item 1 may be the substance' };
  return { shape: 'conceptual', kind, supplementNative, why: kind ? `hook promises ${kind}` : 'no listicle noun — treat as a concept thread' };
}

// ---- item 1 --------------------------------------------------------------------------------------
/**
 * Pure: what FORM must item 1 take, and can it be the product? The hook promises a type of thing and
 * item 1 has to be one of them — a supplement is not a sign. Exported for tests.
 */
export function planFirstItem(shape, kind, product, { faithful = false } = {}) {
  const name = product ? (substanceTermsFor(product)[0] || 'the substance') : null;
  // FAITHFUL RECREATION (operator catch, first OUTLINE_MODE batch 2026-08-17): on an AS-IS viral
  // slot the donor's items ARE the asset — the Lorenzo run made item 1 "Collagen, 10g" on a "5
  // habits" donor and the writer, anchored on the product from tweet 1, rewrote every habit into
  // collagen facts. The body was abolished. Item 1 may only BE the product when the thread is being
  // CONVERTED (roundup/deep-dive) or built from a mold — never when the job is recreating a winner.
  if (faithful) {
    return { form: 'donor-item', canBeProduct: false, asin: null,
      guidance: "Item 1 is the DONOR'S OWN first item, lightly reworded — the body is the asset. Plugs are INSERTED between items as marker lines; no item's content ever becomes product copy." };
  }
  if (shape === 'roundup' || shape === 'deepDive' || kind === 'prescriptive') {
    return { form: 'substance', canBeProduct: true, asin: product?.asin ?? null,
      guidance: name ? `Item 1 IS the product: "1. ${name}, <dose/timing>."` : 'Item 1 is the substance itself.' };
  }
  if (kind === 'diagnostic') {
    return { form: 'observation', canBeProduct: false, asin: null,
      guidance: 'Item 1 is the OBSERVATION the reader recognises in themselves ("1. Waking up at 3-4 AM"). The substance arrives in the run-up, not the hook.' };
  }
  if (kind === 'catalog') {
    return { form: 'category-member', canBeProduct: false, asin: null,
      guidance: 'Item 1 must be a member of the category the hook named (a food, a herb). A capsule is not a food.' };
  }
  return { form: 'concept', canBeProduct: false, asin: null, guidance: 'Item 1 is the concept the donor opens on.' };
}

// ---- plug placement --------------------------------------------------------------------------------
/**
 * Pure: where do the plugs go, and what is each surrounding tweet FOR?
 *
 * `bodyLen` is the number of tweets before plugs are spliced in. Returns one block per product, each
 * naming its plug position and the role of every run-up tweet, so the writer is never guessing what a
 * tweet is doing. Positions are 1-based tweet numbers in the FINAL thread.
 *
 * Placement law: never adjacent, never the hook, first one early (tweet 3 is the proven spot), last
 * one clear of the sign-off. Budgeted against the funnel — only ~5-12% of hook readers reach the plug
 * at all, so every run-up beat is paid for in audience.
 */
export function planPlugs(donorTweets, products, shape, { itemAt = [] } = {}) {
  const spec = SHAPES[shape] || SHAPES.prescriptive;
  const bodyLen = donorTweets.length;
  const budget = plugBudget(bodyLen, { products: products.length });
  const wanted = Math.min(products.length, budget);
  if (!wanted) return { budget, blocks: [] };

  // Anchors are DONOR positions (1-based). Splicing a plug lengthens the thread, so a donor anchor
  // maps to a final tweet number only after counting the plugs inserted before it — the first version
  // computed everything against the donor's own length and put two plugs on the same tweet.
  const anchors = [];
  const anchorFixed = []; // own-item roundup anchors are facts about the donor, like donor-ad slots
  if (shape === 'roundup' && itemAt.length >= wanted) {
    // One plug per product, each immediately after ITS OWN item. The hook already agitated, so the
    // item tweet does the introducing and the criterion in one breath.
    // Never anchor on tweet 1. A roundup's first item rides IN the hook ("...only 5 are worth your
    // money: 1. Magnesium glycinate"), so anchoring on it put the plug at tweet 2 with no criterion
    // beat between them at all — the exact cold sell the whole run-up rule exists to stop.
    // Spread the products ACROSS the items rather than stacking them on the first few. With 5 items
    // and 2 products the old line anchored both on items 1 and 2, and after the +1 they landed at
    // tweets 3 and 4 — adjacent, which is the one placement the law names outright. M0's own
    // requirement ("plugs at T3 and T6") is a spread, not a cluster.
    const stride = Math.max(1, Math.floor(itemAt.length / wanted));
    // MATCH THE PRODUCT TO ITS OWN ITEM first (2026-08-23, found by simulation): the stride spread
    // put an ashwagandha plug after the vitamin-D item, three tweets from the item that introduced
    // it. A pod is self-contained so the gates pass — but the reader converts at the item that just
    // made the case. So each product claims the item whose donor tweet names its substance, and the
    // stride is only the fallback for products with no matching item.
    const itemFor = (prod) => {
      const terms = substanceTermsFor(prod);
      return itemAt.find((pos) => { const lc = String(donorTweets[pos - 1] || '').toLowerCase(); return terms.some((t) => lc.includes(t)); }) || null;
    };
    for (let i = 0; i < wanted; i++) {
      const own = itemFor(products[i]);
      const want = Math.max(2, own || itemAt[Math.min(itemAt.length - 1, i * stride)]);
      // Never the SAME anchor as the previous plug (that is the one true adjacency: two link tweets
      // touching). An OWN-ITEM anchor may sit on the very next item — the item tweet itself stands
      // between the two plug blocks — while stride-placed anchors keep the wider +2 spread.
      const a = anchors.length ? Math.max(want, anchors[anchors.length - 1] + (own ? 1 : 2)) : want;
      anchorFixed.push(!!own && a === want);
      // The non-roundup branch has always guarded with `if (a > last) break`; this one never did, so
      // spreading the products could push the final plug onto the sign-off's own tweet. A plug must
      // leave at least one donor tweet after it before the closer.
      if (a > bodyLen - 1) break;
      anchors.push(a);
    }
  } else {
    // Everything else: the first plug as early as the run-up allows, then evenly spaced with at
    // least a full run-up between them so no plug is adjacent to another's criterion beat.
    //
    // OFF-BY-ONE (fixed 2026-08-18). `anchors` means different things in the two branches: in the
    // roundup branch above it is THE ITEM THE PLUG FOLLOWS, and `plugAt = anchor + inserted + 1`
    // correctly places the plug after it. Here it was being set to the plug's OWN intended position
    // and then passed through the same `+ 1`, pushing every first plug from tweet 3 to tweet 4.
    //
    // That one tweet caused the whole criterion inversion. Every other surface in the system says
    // the first plug belongs at tweet 3 — LAW 2, learned-rules, the skill, the brief, and the audit's
    // own scoring band. So the writer got the outline's "marker at tweet 4" and the law's "tweet 3",
    // obeyed the law (louder, repeated in five places), and put the marker at 3 — one slot ABOVE the
    // item the outline had loaded the criterion into. The criterion then shipped in the item AFTER
    // the plug, in 20 of 26 threads, always by exactly one tweet.
    //
    // Two orders competing for one slot, again. Subtracting the 1 makes the outline agree with the
    // law instead of fighting it: the anchor is the tweet the plug FOLLOWS in both branches.
    const first = spec.runUp;
    const last = bodyLen;
    const gap = Math.max(spec.runUp + 1, wanted > 1 ? Math.floor((last - first) / (wanted - 1)) : 0);
    for (let i = 0; i < wanted; i++) {
      const a = first + i * gap;
      if (a > last) break;
      anchors.push(a);
    }
  }

  // In a NUMBERED LISTICLE the body is not free real estate. Every tweet between the hook and the
  // recap already belongs to an item, so telling the writer "spend tweet 9 naming the substance and
  // tweet 10 on the criterion" collides head-on with "keep all 7 items, in order, one per tweet".
  // The writer resolves that collision by keeping the items and pushing the criterion PAST the plug —
  // which is exactly how magnus 10373119 and rafael 10373096 both shipped a plug at tweet 10 whose
  // justification sat at tweet 12. Same donor, same contradiction, same defect, twice.
  //
  // So map which FINAL tweet numbers are spoken for, and fold the run-up INTO those items instead of
  // pretending they are empty. A donor tweet at position p lands at p + (plugs anchored above it).
  // DONOR AD SLOTS (operator 2026-08-23: "if they're plugging something, we should leverage that").
  // When the donor carries its own sell tweet for a substance WE sell, that position outranks the
  // generic spacing math: the creator spent their run-up building to an ask at that exact beat, and
  // the audience that made the thread viral accepted an ask there. The override swaps the ANCHOR —
  // the tweet the plug follows — so the shift/itemFinal bookkeeping (two off-by-ones deep in this
  // file's history) is untouched. The donor's ad tweet itself is rewritten as OUR criterion beat:
  // never recreated as their ad, never dropped (dropping would shift every later item's number).
  const donorSlots = donorPlugSlots(donorTweets);
  const claimedSlots = new Set();
  const ordered = anchors.map((anchor, i) => ({ anchor, prodIdx: i, donorAd: false, fixed: !!anchorFixed[i] }));
  for (const o of ordered) {
    const d = donorSlots.find((x) => x.asin === products[o.prodIdx].asin && !claimedSlots.has(x.at)
      && x.at + 1 >= 2 && x.at + 1 <= bodyLen - 1);
    // REPLACEMENT, not addition (operator 2026-08-23: "ballooned too many tweets before plug — it
    // is not truly hijacking"). The donor's whole ad span is dropped from the recreation and the
    // marker stands in its place, so our ask sits exactly where theirs sat and the thread does not
    // grow a second wind-up on top of the creator's own.
    if (d) { claimedSlots.add(d.at); o.donorAd = true; o.span = { start: d.start + 1, end: d.at + 1 }; }
  }
  // Writer-space remap: donor positions after a removed span slide back by the span's length. Spans
  // never contain numbered items (the span walk stops at them), so itemAt entries are always safe
  // to remap. rem(p) counts span tweets strictly BEFORE donor position p.
  const spans = ordered.filter((o) => o.span).map((o) => o.span).sort((a, b) => a.start - b.start);
  const rem = (p) => spans.reduce((n, sp) => n + (sp.end < p ? sp.end - sp.start + 1 : 0), 0);
  for (const o of ordered) {
    if (o.span) o.anchor = Math.max(1, (o.span.start - 1) - rem(o.span.start - 1));
    else o.anchor -= rem(o.anchor);
  }
  const itemAtW = itemAt.map((p) => p - rem(p));
  ordered.sort((a, b) => a.anchor - b.anchor);
  // Re-assert non-adjacency after the overrides, nudging only the GENERIC anchors — a donor ad slot
  // is a fact about the donor and does not move.
  for (let i = 1; i < ordered.length; i++) {
    const minGap = ordered[i].fixed || ordered[i - 1].fixed ? 1 : 2; // an own-item anchor's item tweet already separates the plug blocks
    if (!ordered[i].donorAd && !ordered[i].fixed && ordered[i].anchor < ordered[i - 1].anchor + minGap) ordered[i].anchor = Math.min(bodyLen - 1, ordered[i - 1].anchor + minGap);
  }
  const finalAnchors = ordered.map((o) => o.anchor);
  const shift = (p) => p + finalAnchors.filter((a) => a < p).length;
  const itemFinal = new Map(itemAtW.map((p, idx) => [shift(p), idx + 1]));

  const blocks = [];
  ordered.forEach(({ anchor, prodIdx, donorAd, span }, i) => {
    const inserted = i;                                   // plugs already spliced above this one
    // Every plug is guaranteed at least ONE beat between it and the hook, whatever the anchor math
    // produced: a plug at tweet 2 has nowhere to put its criterion.
    const plugAt = Math.max(3, anchor + inserted + 1);
    const subject = substanceTermsFor(products[prodIdx])[0] || 'the substance';
    const runUp = [];
    for (let r = spec.runUp; r >= 1; r--) {
      const n = plugAt - r;
      // A beat that lands on tweet 1 is carried BY THE HOOK, not dropped. In a numbered listicle the
      // hook already states item 1 ("...only 5 work: 1. Magnesium glycinate"), so it genuinely does
      // the introducing — but saying so out loud is what stops the writer thinking a beat went
      // missing and re-inserting it lower down, on top of the criterion's slot.
      if (n < 1) continue;
      if (n === 1) {
        runUp.push({ tweet: 1, role: 'introduced-by-hook', carriedBy: null, carrier: 'hook',
          must: `the hook already names ${subject} as item 1 — that IS this beat, do not spend another tweet on it` });
        continue;
      }
      const item = itemFinal.get(n) || null;
      const role = r === 1 ? 'criterion' : (r === spec.runUp ? 'item' : 'explain');
      if (r === 1 && donorAd && span) {
        // The marker REPLACES the donor's whole ad span. The tweet before it is the donor's own
        // run-up — the wind-up that made 790k people accept an ask right here — so it is kept, and
        // its only job is to land on our substance.
        runUp.push({ tweet: n, role, carriedBy: item ? `item ${item}` : null,
          must: `donor tweets ${span.start}-${span.end} are the creator's OWN AD for ${subject} — do NOT recreate any of them; the marker stands in their place. THIS tweet is the donor's own run-up into that ask: keep it, and land its final line on ${subject}` });
        continue;
      }
      runUp.push({
        tweet: n, role, carriedBy: item ? `item ${item}` : null,
        // Two wordings for one job. When the slot is free the beat IS the tweet; when the slot is a
        // numbered item the beat RIDES the item — keep the item, land it on the substance. Never an
        // instruction to overwrite content the recreation is required to preserve.
        must: item
          ? (r === 1
            ? `this tweet IS numbered item ${item} — keep that item intact and END it on what separates real ${subject} from the shelf junk (form, dose, what to avoid), so the plug answers a question already in the reader's head`
            : `this tweet IS numbered item ${item} — keep that item intact and work ${subject} into it by name, so the criterion beat has something to land on`)
          : (r === 1
            ? `say what separates real ${subject} from the shelf junk (the form, the standardisation, what to avoid) — and this may NOT be ${subject}'s first appearance`
            : `name ${subject} here, so the criterion has something to land on`),
      });
    }
    blocks.push({ product: { asin: products[prodIdx].asin, title: products[prodIdx].title }, plugAt, path: shape, runUp, note: spec.note, ...(donorAd ? { donorAd: true } : {}), ...(span ? { donorAdSpan: span } : {}) });
  });
  return { budget, blocks, removedDonorTweets: spans.reduce((n, sp) => n + (sp.end - sp.start + 1), 0) };
}

// ---- assembly ---------------------------------------------------------------------------------------
/** Pure: the whole outline. This is what gets handed to the writer. Exported for tests. */
// ---- pod selection at OUTLINE time ---------------------------------------------------------------
// OPERATOR 2026-08-22: "this selection should happen during the outline, so by the time we generate
// the thread, it knows exactly that we need to paste these in."
//
// This is the whole point of the pod library. Until now pods.json was written, validated and read by
// nobody: no generation path imported it, so every thread still wrote its selling half from scratch
// and re-rolled a solved problem. Choosing here — in the pure, no-LLM, no-network step — means the
// writer is handed finished tweets instead of instructions for producing them.
//
// FRAME. A pod carries one entry line per host framing, because the HOST thread decides what its
// numbered items are. listicleKind already sorts hooks into prescriptive/diagnostic/catalog, but that
// is coarser than we need: "7 signs" and "7 reasons" are both diagnostic while one wants a symptom
// line and the other a cause. So the promise noun is read directly, falling back to substance, which
// is the framing that reads acceptably in the widest range of threads.
const FRAME_NOUNS = [
  ['symptom', /\b(signs?|symptoms?|red flags?|warning signs?)\b/i],
  ['cause', /\b(reasons?|causes?|why|culprits?)\b/i],
  ['substance', /\b(supplements?|vitamins?|minerals?|nutrients?|herbs?|foods?|ingredients?)\b/i],
  ['action', /\b(ways?|things?|habits?|steps?|rules?|tips?|protocols?|hacks?|moves?|fixes|changes?|swaps?|mistakes?)\b/i],
];

/** Pure: which pod entry line fits this host hook? 'substance' | 'symptom' | 'action' | 'cause'. */
/**
 * donorPlugSlots(donorTweets) -> [{ at, substance, asin, evidence }]
 *
 * Donors PLUG TOO (operator 2026-08-23: "if they're plugging something, we should leverage that").
 * Every big donor recreated today carried its own ad break — "This is the one I use because...",
 * "Check it out now (thank me later)👇", "Get it here (Made in USA):" — and those tweets are the
 * single best place to put OUR pod: the creator already spent their run-up building to an ask, the
 * audience that made the thread viral already accepted an ask at that exact beat, and the tweets
 * BEFORE it already name the substance. Which is also why a slot found here takes the 2-TWEET pod
 * (bridge + plug): the donor supplies the POINT, and requiresHostMention is satisfied by
 * construction rather than by hope.
 *
 * Detection is two independent signals, both required:
 *   1. SELL LANGUAGE — a first-person recommendation or a buy-nudge phrase. One alone is not
 *      enough ("I use it before training" is testimony, not an ask).
 *   2. A SUBSTANCE — the tweet or its run-up (up to 2 tweets back) names a BRIDGE term, which maps
 *      the slot to the product WE would sell there. A sell with no bridgeable substance is reported
 *      with substance:null so the caller can see the donor asked for something we cannot supply
 *      (the gut donor's bare "Here's what I use for balance, immunity, and digestion:").
 */
// Extended 2026-08-25 (pod-place smoke on the cortisol donor): "I found these organic Ashwagandha
// capsules... If you want to try it, here's a credible source: #ad" is a full ad break that matched
// nothing here. A bare #ad in a DONOR thread is unambiguous — donors only ever carry it on an ask.
const SELL_RE = /\bthis is the one i\b|\bthis (?:is|became) my favou?rite\b|\bthe (?:one|best \w+) i (?:still )?(?:use|take|buy|found|settled on)\b|\bcheck it out\b|\bthank me later\b|\bget it here\b|\btry it now\b|\bhere'?s (?:what|the \w[\w -]*) i (?:use|take|buy|(?:'ve |have )?been using)\b|\brecommend it to all\b|\blink below\b|\bi'?ll share the\b|\bi found (?:these|this) [\w -]*(?:capsules?|gummies|softgels?|powders?|supplements?)\b|\bhere'?s a (?:credible|trusted|good) (?:source|link|option)\b|\bif you want to try (?:it|them)\b|(?:^|\s)#ad\b/i;
// The WIND-UP a creator writes on the way into their ad — first-person shopping language that is
// not itself the ask. Extending the span over these is what makes a hijack a replacement instead of
// an addition (operator 2026-08-23: "ballooned too many tweets before plug — it is not truly
// hijacking"). Deliberately narrow: a criterion tweet ("A lot of creatine is NOT created equal")
// stays content, because it is the donor's own run-up and it is exactly what our pod wants before it.
const AD_LEAD_RE = /\bthis is why i (?:look for|buy|choose|went with)\b|\bafter (?:days|hours|weeks) of research\b|\bi (?:actually )?did hours of research\b|\bi finally found\b|\bdecided on which brand\b|\bnow it'?s my cheat code\b|\bi'?m going to share\b|\bwhat made a difference\b/i;
export function donorPlugSlots(donorTweets) {
  const tweets = (donorTweets || []).map((t) => String(t || ''));
  const out = [];
  for (let i = 0; i < tweets.length; i++) {
    if (!SELL_RE.test(tweets[i])) continue;
    // A sell tweet often spans two ("This is why I look for Creapure..." then "Try it now") — fold a
    // consecutive sell into the slot already open instead of reporting the same ask twice.
    const prev = out[out.length - 1];
    if (prev && i - prev.at <= 1 && SELL_RE.test(tweets[prev.at])) { prev.at = i; continue; }
    let substance = null, asin = null;
    for (let back = i; back >= Math.max(0, i - 2) && !substance; back--) {
      const lc = tweets[back].toLowerCase();
      for (const [term, a] of Object.entries(BRIDGE)) {
        if (lc.includes(term)) { substance = term; asin = a; break; }
      }
    }
    // Walk BACK over the wind-up to find where the ad really starts. Never across a numbered item
    // (items are content the recreation must keep) and never onto the hook.
    let start = i;
    while (start - 1 >= 1 && !leadingNumbers(tweets[start - 1]).length
      && (AD_LEAD_RE.test(tweets[start - 1]) || SELL_RE.test(tweets[start - 1]))) start--;
    out.push({ at: i, start, substance, asin, evidence: (tweets[i].match(SELL_RE) || [''])[0] });
  }
  // Folded sells keep their own start; make each span's start honest after folding.
  for (const o of out) {
    while (o.start - 1 >= 1 && !leadingNumbers(tweets[o.start - 1]).length
      && (AD_LEAD_RE.test(tweets[o.start - 1]) || SELL_RE.test(tweets[o.start - 1]))) o.start--;
  }
  return out;
}

export function podFrame(hook) {
  const s = String(hook || '');
  for (const [frame, re] of FRAME_NOUNS) if (re.test(s)) return frame;
  return 'substance';
}

/**
 * Pure: attach a ready-to-paste pod to every plug block that has one.
 *
 * A block whose product has no pod is left exactly as it was — it still carries the runUp
 * instructions the writer needs, so an uncovered substance degrades to today's behaviour rather than
 * failing. The link is left as a {{LINK}} placeholder: minting is per account + subid and happens on
 * a runner, long after the outline is drawn.
 */
/**
 * numberPastedPods (operator 2026-08-23: "cta 1 didn't have the numbering"): in a NUMBERED listicle
 * a pasted pod's entry line joins the list as its own numbered member — "2. Stairs feel like a
 * report card" — and every later item renumbers around it, because an unnumbered interruption
 * between "1." and "2." reads as an ad break, which is the exact pattern pods exist to avoid.
 *
 * Deliberate non-cases: the 'answer' frame never takes a number (the operator's own causal-handoff
 * rule — it enters as a consequence, not a list member); a ROUNDUP pod elaborates the item ABOVE it
 * rather than adding a member, so the caller simply does not pass those heads; and a host with
 * fewer than 3 numbered items is not a listicle at all.
 *
 * The hook's promised count moves with the list: "7 weird signs" + 2 numbered pods = "9 weird
 * signs" — swapped only when the hook carries the old total exactly once, so a hook that never
 * counts (or counts something else) is left alone. The hook tweet itself is never renumbered; a
 * tease-hook's trailing "1. <item>" stays 1, which matches the body's first item.
 *
 * heads: [{ at, frame }] — 1-based positions of pod HEAD tweets in `tweets`, with the pod's frame.
 */
export function numberPastedPods(tweets, heads = []) {
  const out = [...tweets];
  const numbered = out.flatMap((t, i) => (i > 0 && leadingNumbers(t).length ? [i] : []));
  if (numbered.length < 3) return { tweets: out, added: 0 };
  const headAt = new Map(heads.filter((h) => !UNNUMBERED_FRAMES.has(h.frame)).map((h) => [h.at - 1, h]));
  // WHERE THE COUNTER STARTS DEPENDS ON THE DONOR'S HOOK SHAPE (2026-08-28, sixth engine run).
  // A tease hook carries a trailing "N. <item>", and there are two shapes behind that:
  //   CONTINUE — the hook holds item 1 and the body picks up at 2 (this donor: "1. Don't go pee at
  //              3 AM" in the hook, "2. Stop breathing through your mouth" in the body).
  //   REPEAT   — the hook previews item 1 and the body restates it as 1.
  // Starting at 0 is only right for REPEAT. On a CONTINUE donor it hands the first pasted pod the
  // number 1, which the hook is already using, and the thread ships with two item 1s and a list that
  // runs past what the hook promised. Rafael's live draft 10527365 did exactly that: 1,1,2,3,4,5,6,7.
  const hookMarker = leadingNumbers(out[0]).slice(-1)[0] ?? 0;
  const firstBodyMarker = leadingNumbers(out[numbered[0]])[0] ?? 0;
  const seed = hookMarker && firstBodyMarker > hookMarker ? hookMarker : 0;
  let counter = seed, added = 0;
  for (let i = 1; i < out.length; i++) {
    if (headAt.has(i)) {
      counter++; added++;
      out[i] = `${counter}. ${out[i]}`;
    } else if (leadingNumbers(out[i]).length) {
      counter++;
      out[i] = out[i].replace(/(^|\n)([ \t]*)\d{1,3}([.)])\s/, `$1$2${counter}$3 `);
    }
  }
  if (added) {
    const oldTotal = counter - added;
    const re = new RegExp(`\\b${oldTotal}\\b`, 'g');
    const hits = (out[0].match(re) || []).length;
    if (hits === 1) out[0] = out[0].replace(re, String(counter));
  }
  return { tweets: out, added };
}

/**
 * Pick THE pod for one product. Exact-ASIN pods first; when none exists, fall back to any pod whose
 * substance+forms are TRUE of this product (podFitsProduct) — the Physician's Choice KSM-66 bottle
 * takes the ashwagandha pod even though the pod is pinned to the Nutricost listing.
 *
 * PRECEDENCE (reordered 2026-08-23, and the first rule is the paste mandate speaking): a pod this
 * account can actually RENDER (own variant or shared pool) beats everything, because an
 * unrenderable pod is worth zero — the old chain could select a fits-but-unrenderable pod and the
 * block shipped un-pasted even though another eligible pod had the account's variant. Then:
 * exact-ASIN > carries an entry line for THIS frame > avoids an already-used opener move
 * (LAW 12c: two plugs may not open on the same move — preferred, never required) > proven > first.
 */
export function selectPod(product, { account = '', frame = 'substance', pods = PODS, excludeMoves = [], excludeIds = [] } = {}) {
  const live = pods.filter((p) => p.status !== 'retired' && !excludeIds.includes(p.id));
  const exact = live.filter((p) => p.asin === product?.asin);
  const candidates = exact.length ? exact : live.filter((p) => podFitsProduct(p, product));
  if (!candidates.length) return { pod: null, via: null };
  const renderable = candidates.filter((p) => variantFor(p, account));
  const pool = renderable.length ? renderable : candidates;
  // A variant fits a frame it can RESOLVE, not only one it literally carries: a backline pod answers
  // an `action` host from its merged substance frame and an `answer` host from its bonus frame.
  const fits = (p) => (p.variants || []).some((v) => v.entryLines?.[resolveFrame(v, frame)]);
  const score = (p) => (p.asin === product?.asin ? 8 : 0) + (fits(p) ? 4 : 0)
    + (excludeMoves.includes(p.move) ? 0 : 2) + (p.status === 'proven' ? 1 : 0);
  const pod = pool.reduce((a, b) => (score(b) > score(a) ? b : a));
  return { pod, via: pod.asin === product?.asin ? 'asin' : 'substance' };
}

/**
 * The SECOND pod for a single-product thread. Same product twice with the same copy measured 1.2%
 * CVR against 3.5% for two distinct arguments, and the first live smoke (2026-08-23) showed exactly
 * why: the pasted pod sold the product properly, then the writer improvised a second ask for the
 * same bottle, cold and hypey. When the library holds ANOTHER pod for this product — magnesium has
 * three, each a different argument on a different opener move — the second ask pastes too. HARD
 * requirements, not preferences: a different pod, a different move (LAW 12c names same-move plugs
 * outright). Returns null when no such pod exists, and the writer varies the second ask as before.
 */
export function selectAltPod(product, firstPod, { account = '', frame = 'substance', pods = PODS } = {}) {
  if (!firstPod) return null;
  const { pod } = selectPod(product, { account, frame, pods, excludeIds: [firstPod.id], excludeMoves: [firstPod.move] });
  if (!pod || pod.id === firstPod.id || pod.move === firstPod.move) return null;
  // DIFFERENT MOVE IS NOT DIFFERENT COPY (2026-08-30). A distinct `move` was the only test, and the
  // 2026-08-30 rewrite made it insufficient: P1 (sourcing-question) and M2 (failure-mode) are separate
  // pods on the same ASIN whose bridges came back WORD FOR WORD identical, and all three magnesium
  // pods now share an opener. Paired by this function they would paste the same ad twice in one
  // thread — the exact duplication the second ask exists to avoid, and worse than no second ask.
  // Compared on the same Dice measure and ceiling the within-pod variant rule uses, so the library
  // and the picker cannot disagree about what counts as too similar.
  const a = podById(firstPod.id);
  if (a) {
    const av = variantFor(a, account) || (a.variants || [])[0];
    const bv = variantFor(pod, account) || (pod.variants || [])[0];
    const text = (v) => [v?.bridge, v?.opener, v?.middle, v?.cta].filter(Boolean).join(' ');
    if (av && bv && hookSimilarity(text(av), text(bv)) >= POD_VARIANT_MAX) return null;
  }
  return pod;
}

export function assignPods(blocks, { hook = '', account = '', pods = PODS, link = '{{LINK}}' } = {}) {
  const frame = podFrame(hook);
  const warnings = [];
  const usedMoves = [];
  const out = blocks.map((b) => {
    const { pod, via } = selectPod(b.product, { account, frame, pods, excludeMoves: usedMoves });
    if (!pod) { warnings.push(`${b.product?.asin}: no pod — the writer composes this plug from scratch`); return b; }
    if (!(pod.variants || []).some((v) => v.entryLines?.[resolveFrame(v, frame)])) {
      warnings.push(`${pod.id}: no "${frame}" entry line — it will open in its own framing inside a ${frame}-framed thread`);
    }
    // A donor-ad hijack pastes CTA-ONLY: the replaced span was the creator's own sell and their
    // surviving run-up already carries mechanism + criterion (operator 2026-08-23, review round 2).
    const rendered = renderPod(pod, account, link, { frame, compact: b.path === 'roundup', ctaOnly: !!b.donorAdSpan });
    if (!rendered) { warnings.push(`${pod.id}: no ${account} variant — the writer composes this plug from scratch`); return b; }
    usedMoves.push(pod.move);
    if (via === 'substance') {
      // The copy came from a pod pinned to a DIFFERENT listing of the same substance+form. The link
      // is still the block's own product — the pod only donates words — but a dose or count baked
      // into the prose ("2,400mg", "180 capsules") may describe the other bottle, so it gets a
      // named warning a human can check in five seconds.
      warnings.push(`${pod.id}: substance-matched to ${b.product?.asin} (pod pinned to ${pod.asin}) — link stays the block's product`);
      const prose = rendered.tweets.join(' ');
      if (/\d[\d,.]*\s?(mg|mcg|iu|g|ct|billion)\b/i.test(prose)) {
        warnings.push(`${pod.id}: pod prose carries a dose/count — verify it is true of "${String(b.product?.title || '').slice(0, 50)}"`);
      }
    }
    // requiresHostMention is the 2-tweet pod's honest small print: with one tweet before the plug the
    // run-up guarantee has to come from the host thread, so the runUp instructions stay in force.
    // AND-ed with THIS render's shape (2026-09-09): the flag is one field on the pod, but a pod may
    // carry variants of different shapes across systems — NA1's framed and classic arms are 2-tweet,
    // its backline arm is a full three. Passing the bare flag made a 3-tweet placement demand a host
    // mention it supplies itself, and recreate reads the same field to decide the pod is not
    // self-contained. What matters is what THIS placement puts before the plug.
    return { ...b, pod: { id: pod.id, frame, twoTweet: rendered.twoTweet, ...(rendered.ctaOnly ? { ctaOnly: true } : {}), tweets: rendered.tweets, requiresHostMention: !!pod.requiresHostMention && rendered.twoTweet, via, move: pod.move } };
  });
  return { blocks: out, warnings, frame };
}

/** Replace the {{LINK}} placeholder in a pod's tweets with the BLOCK product's minted link. The pod
 *  only donates words; the money link always belongs to the product in the slot. */
export const podFill = (podTweets, link) => (podTweets || []).map((t) => String(t).replaceAll('{{LINK}}', String(link || '').trim()));

export function buildOutline({ donorTweets = [], products = [], account = {}, moldId = null, donorText = '', convertTo = null } = {}) {
  const text = donorText || donorTweets.join('\n');
  // Symptom words route only when the donor keeps saying them after the hook (checks.mjs
  // SYMPTOM_GATED). Passing the first tweet is what turns that gate on; without it a word dropped
  // once into a hook list still claims a plug, which is the 4M-view / $52 thread.
  const bridgeable = [...bridgeableProducts(text, { hook: donorTweets[0] || '' })];
  const itemCount = donorTweets.flatMap(leadingNumbers).length;
  // The PLAN may have committed a shape conversion (phase 4's 50% steer). Honour it when the donor
  // still qualifies; fall back to the derived shape when it does not — the plan was drawn against
  // last week's swipe data, and the donor's own text is the ground truth.
  let { shape, kind, supplementNative, why } = chooseShape(donorTweets, { bridgeable, moldId, itemCount });
  // An as-is slot may not silently convert itself: chooseShape's roundup/deepDive picks are
  // suggestions for the PLANNER, but at generation time only an explicit convertTo (or a mold)
  // changes the thread's shape. Without one, a faithful recreation keeps the donor's own kind.
  if (!convertTo && !moldId && !supplementNative && (shape === 'roundup' || shape === 'deepDive')) {
    shape = kind || 'conceptual';
    why = `faithful as-is recreation — donor shape kept (${why})`;
  }
  if (convertTo === 'roundup' && bridgeable.length >= 3) { shape = 'roundup'; why = 'plan committed a roundup conversion and the donor still hosts 3+'; }
  else if (convertTo === 'deepDive' && bridgeable.length >= 1) { shape = 'deepDive'; why = 'plan committed a deep-dive conversion'; }
  else if (convertTo) why += ` (plan asked for ${convertTo} but the donor no longer qualifies — using the derived shape)`;
  // A thread with no numbered items has no "item 1" to point at the product — the deep-dive and
  // conceptual shapes carry the substance in prose instead.
  // Faithful = an as-is recreation: no conversion in force and not a mold build. There the donor's
  // structure outranks every monetization preference.
  const faithful = !convertTo && !moldId && !supplementNative;
  const firstItem = itemCount > 0
    ? planFirstItem(shape, kind, products[0], { faithful })
    : { form: 'none', canBeProduct: false, asin: null, guidance: 'No numbered items — the substance is carried in prose, and the criterion beat before the plug does the work.' };

  // Body length: the donor's own tweet count, plus the account's closing and disclaimer.
  const itemAt = donorTweets.map((t, i) => (leadingNumbers(t).length ? i + 1 : 0)).filter(Boolean);
  const { budget, blocks: rawBlocks, removedDonorTweets = 0 } = planPlugs(donorTweets, products, shape, { itemAt });
  // Pods are chosen HERE so generation pastes rather than writes. Uncovered products fall through
  // with their runUp instructions intact, so this can never make a thread worse than it was.
  const { blocks, warnings: podWarnings, frame: podFrameUsed } = assignPods(rawBlocks, {
    hook: donorTweets[0] || '', account: String(account?.key || account?.name || '').toLowerCase(),
  });
  // TWO POSITION SPACES (2026-08-23, learned by simulating the Magnus M0 slot twice). plugAt and
  // every runUp tweet number are WRITER-SPACE: the writer emits ONE marker line per plug, so its
  // tweet numbering counts each plug as one tweet, and these numbers must keep doing the same —
  // "corrected" final-space numbers here made the writer place markers two tweets late. The paste
  // expands markers afterwards; only totals that describe the FINAL thread (signOffAt, the
  // maxThread warning) count a pod's real tweet size.
  const extraTweets = blocks.reduce((n, b) => n + (b.pod ? b.pod.tweets.length - 1 : 0), 0);
  const signOffAt = donorTweets.length - removedDonorTweets + blocks.length + extraTweets + 1;

  const warnings = [...podWarnings];
  // A 3-tweet pod inserts 3 tweets where the classic path inserted 1, so a long donor can push the
  // assembled thread past the platform ceiling (laws.json: tweet.maxThread). Warned here so the
  // planner/operator trims ITEM_TARGET before generation rather than the gate failing after it.
  // + the disclaimer, + the sign-off while laws.json signOff is on.
  const assembled = donorTweets.length - removedDonorTweets + blocks.length + extraTweets + (SIGN_OFF_ON ? 2 : 1);
  if (assembled > LAWS.tweet.maxThread) {
    warnings.push(`assembled length ~${assembled} tweets exceeds maxThread ${LAWS.tweet.maxThread} — trim items or use 2-tweet pods`);
  }
  if (!products.length) warnings.push('no products — this thread cannot be monetized as outlined');
  if (products.length > budget) warnings.push(`${products.length} products but the budget is ${budget} — the extras will not be plugged`);
  for (const p of products) {
    // A stack is fine (Heart of Steel is one and it wins). A CATEGORY mismatch is not: the criterion
    // beat would describe something the reader does not find on the landing page.
    const terms = substanceTermsFor(p);
    const hay = String(p.title || '').toLowerCase();
    if (terms.length && !terms.some((t) => hay.includes(t))) {
      warnings.push(`${p.asin} does not carry its own substance in the title — check the criterion beat will still be true on the landing page`);
    } else if (isStack(p)) {
      warnings.push(`${p.asin} is multi-ingredient — fine when the thread's promise matches the product's category, wrong when it does not`);
    }
  }
  if (shape === 'roundup' && products.length < 3) warnings.push('roundup shape with fewer than 3 products — the hook promises a list it cannot deliver');

  return {
    shape, listicleKind: kind, why, itemCount, bridgeable, budget, podFrame: podFrameUsed,
    firstItem,
    plugs: blocks,
    media: donorTweets.map((_, i) => i + 1).filter((n) => n === 1),
    signOffAt,
    warnings,
  };
}

/** Human-readable render — this is what the operator reads before a thread is written. */
export function renderOutline(o) {
  const L = [];
  L.push(`SHAPE: ${o.shape}${o.listicleKind ? ` (hook promises ${o.listicleKind})` : ''} — ${o.why}`);
  L.push(`${o.itemCount} items · ${o.bridgeable.length} bridgeable substance(s) · plug budget ${o.budget}`);
  L.push('');
  L.push(`ITEM 1 [${o.firstItem.form}]: ${o.firstItem.guidance}`);
  L.push('');
  for (const b of o.plugs) {
    L.push(`PLUG @ tweet ${b.plugAt} — ${b.product.title.slice(0, 52)}`);
    // Positions are stated RELATIVE TO THE MARKER, not as absolute tweet numbers. Absolute numbers
    // drift the moment the writer's output is a tweet longer or shorter than the donor, and then the
    // criterion instruction lands on the wrong item — which is how a batch shipped 82% of its plugs
    // with the criterion one tweet late. "The tweet immediately before the marker" cannot drift.
    const rel = ['the tweet IMMEDIATELY BEFORE the marker', 'two tweets BEFORE the marker', 'three tweets BEFORE the marker'];
    b.runUp.forEach((r, k) => {
      const back = b.runUp.length - k;            // 1 = adjacent to the marker
      L.push(`   ${rel[back - 1] || `${back} tweets BEFORE the marker`} [${r.role}${r.carriedBy ? ` · rides ${r.carriedBy}` : ''}] ${r.must}`);
    });
    L.push(`   THE MARKER {{PLUG:${b.product.asin}}} — three beats, opener move chosen on fit, disclosure in the closing line`);
    L.push('   (nothing after the marker may justify this product — if a criterion ends up there, the marker moved too early)');
    L.push('');
  }
  if (o.warnings.length) { L.push('WARNINGS'); for (const w of o.warnings) L.push(`   ⚠ ${w}`); }
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('outline.mjs is a pure library — use thread-brief.mjs for the CLI, or import buildOutline().');
}

// ---- the skeleton compiler --------------------------------------------------------------------
// The root fix behind SLOT_MODE (operator 2026-08-18: "start with them now"). Every defect in the
// two measured overnight batches was a PLACEMENT decision made by the writer — where the plug goes,
// which item carries the criterion, how many beats, where the blank lines fall. All of it is fully
// determined by mold + donor + products, so none of it belongs to a language model. The compiler
// turns the outline into an explicit per-tweet slot list; the writer FILLS slots and decides
// nothing. A placement bug is now a compiler bug: deterministic, testable, fixed once.

/**
 * Pure: mold + donor + products -> one slot per final tweet.
 * Slot kinds: hook | body (donorIndex, item, job) | plug (asin, fields) | signoff | disclaimer.
 * The signoff/disclaimer slots are PLANS, not fills — the engine appends the account's own literal
 * closing lines; the writer never touches them. Exported for tests.
 */
export function compileSkeleton({ donorTweets = [], products = [], account = {}, moldId = null, donorText = '', convertTo = null } = {}) {
  const outline = buildOutline({ donorTweets, products, account, moldId, donorText, convertTo });
  const plugsByAt = new Map(outline.plugs.map((b) => [b.plugAt, b]));
  // Run-up jobs keyed by the FINAL tweet number they ride, so each body slot states what its tail owes.
  const jobs = new Map();
  for (const b of outline.plugs) {
    for (const r of b.runUp) {
      // The criterion beat is NO LONGER a rider on a body slot — it is a FIELD of the plug slot,
      // placed by the assembler (2026-08-18). Four batches proved the rider always loses: the
      // criterion was the only load-bearing beat without its own slot, so under any tension the
      // writer put it where it topically belongs — the substance's item, AFTER the plug. Keeping
      // the intro/explain jobs preserves the first-appearance ramp; dropping the criterion job
      // stops the writer double-writing a beat code now owns.
      if (r.tweet >= 2 && r.role !== 'criterion') jobs.set(r.tweet, { role: r.role, must: r.must });
    }
  }
  const total = donorTweets.length + outline.plugs.length;
  const slots = [];
  let d = 0;
  for (let n = 1; n <= total; n++) {
    const plug = plugsByAt.get(n);
    if (plug) {
      // THE POD (operator, 2026-08-18): in a listicle lane the substance gets its OWN TWEET between
      // the item and the plug — benefits, agitation, then what to look for. The welded criterion
      // line was the compressed version and it read as rushed ("you're missing one"). A roundup
      // keeps the weld instead: its item already IS the substance and M0's documented plug slots
      // (T3/T6) leave no room for an extra tweet.
      if (outline.shape !== 'roundup') {
        slots.push({ n, kind: 'substance', asin: plug.product.asin, title: plug.product.title });
      }
      slots.push({
        n: n + 1, kind: 'plug', asin: plug.product.asin, title: plug.product.title,
        fields: outline.shape === 'roundup' ? ['criterion', ...LAWS.plugs.beats] : LAWS.plugs.beats.slice(),
        note: plug.note,
      });
      continue;
    }
    d += 1;
    const src = String(donorTweets[d - 1] || '');
    const item = leadingNumbers(src)[0] ?? null;
    const job = jobs.get(n) || null;
    slots.push({
      n, kind: d === 1 ? 'hook' : 'body', donorIndex: d, item,
      ...(job ? { role: job.role, job: job.must } : {}),
    });
  }
  // Substance insertions shifted everything below them — renumber sequentially so slot.n is always
  // the FINAL tweet number, which is the whole point of a compiled skeleton.
  slots.forEach((sl, i) => { sl.n = i + 1; });
  // The item tweet right before each substance slot carries the HINT — the one-line first
  // appearance that makes the substance tweet land on a primed reader instead of a cold one.
  slots.forEach((sl, i) => {
    if (sl.kind !== 'substance') return;
    const prev = slots[i - 1];
    if (prev && (prev.kind === 'body' || prev.kind === 'hook')) {
      const name = substanceTermsFor({ title: sl.title })[0] || sl.title;
      prev.job = `END this tweet on ONE line hinting that ${name} helps here — name it plainly; the NEXT tweet develops it. Keep the item's own content first.`;
      prev.role = 'hint';
    }
  });
  const fillable = slots.length;
  // The sign-off slot exists only while laws.json signOff is on (owner R2026-09-26: content, then the
  // disclaimer). Off, the last fillable slot is the thread's close.
  if (SIGN_OFF_ON) slots.push({ n: slots.length + 1, kind: 'signoff' });
  slots.push({ n: slots.length + 1, kind: 'disclaimer' });
  return { ...outline, slots, bodyCount: donorTweets.length, totalFillable: fillable };
}

/** Writer-facing rendering: every slot, its job, nothing about placement left to decide. */
export function renderSkeleton(sk) {
  const L = [`THREAD SKELETON — ${sk.totalFillable} slots to fill (${SIGN_OFF_ON ? 'the sign-off and disclaimer are appended by code; do not write them' : 'the disclaimer is appended by code; do not write it, and do not write a sign-off: the last slot closes the thread on content'}).`,
    `Shape: ${sk.shape}. Placement is DECIDED. Do not move, merge, add or drop slots — fill each one.`];
  for (const s of sk.slots) {
    if (s.kind === 'signoff' || s.kind === 'disclaimer') continue;
    if (s.kind === 'hook') {
      // "Paraphrase" was the wrong word and it cost a whole batch: the writer synonym-swapped every
      // line (piss->pee, crashing->dipping, "It's not the water"->"The water isn't it") and produced
      // an editorially faithful hook that measured 59% — the band is WORD overlap, and its
      // ${'85-90%'} target arithmetically means nine of ten donor words survive verbatim. Say that.
      L.push(`[${s.n}] HOOK — START from donor tweet 1 VERBATIM, then change only ${100 - Math.round(LAWS.hook.targetMax * 100)}-${100 - Math.round(LAWS.hook.targetMin * 100)}% of the words: a verb here, a noun there, fix a typo, drop an em dash. Keep every sentence, every line break, every number, the promise and the rhythm. At least ${Math.round(LAWS.hook.targetMin * 100)}% of the donor's own words must survive unchanged — rewording every sentence FAILS the gate even when it reads well. SPREAD the changes: touch EVERY sentence at least once (one small word swap per sentence is enough) — a sentence left byte-identical fails the per-sentence check, and concentrating all the edits in one sentence fails it too.`);
    } else if (s.kind === 'substance') {
      L.push(`[${s.n}] SUBSTANCE TWEET for ${s.title || s.asin} — its OWN tweet, not the plug: 2-3 short lines. (1) why this substance is the lever here, hedged; (2) the agitation — why most people get nothing from it (underdosed shelf versions, wrong form); (3) END on what to look for: the form or standard that separates the real thing from junk. Name the substance plainly. NO ask, NO link, NO brand.`);
    } else if (s.kind === 'plug') {
      const weld = s.fields.includes('criterion') ? ' The "criterion" is ONE sentence code will attach to the END of the tweet before this plug — what separates the version that works from the shelf junk.' : '';
      L.push(`[${s.n}] PLUG for ${s.title || s.asin} (${s.asin}) — return an OBJECT with fields ${s.fields.map((f) => `"${f}"`).join(', ')}.${weld} No URL anywhere in the fields; code appends the link. ${s.note || ''}`.trim());
    } else {
      const itemBit = s.item != null ? `donor item ${s.item} — keep its number, order and meaning` : `donor tweet ${s.donorIndex}, rewritten in the account's voice`;
      L.push(`[${s.n}] BODY — ${itemBit}.${s.job ? ` THIS SLOT'S TAIL: ${s.job}` : ''}`);
    }
  }
  return L.join('\n');
}
