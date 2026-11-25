// pod-place.mjs — the placement brain: sense the donor thread, claim the perfect plug positions,
// choose the pod and the CTA shape (operator 2026-08-25: "learn to sense what's going on in the
// original thread and plug where it's relevant... which shape of the product CTA we should use").
//
// This is the ADVISORY half of the money layer: it reads a raw donor thread and prints a
// paste-ready placement brief. It never writes a draft, never mints, never touches the ledger —
// publish-thread.mjs stays the only door, and its gates rule on whatever the writer ships.
//
// The slot ladder (operator round 4), claimed in this order:
//   A  SELL  — the creator's own ask (donorPlugSlots). Their span is replaced; never left standing.
//   A2 IMPLY — first-person usage naming a substance without an ask ("I take X every night").
//              donorPlugSlots deliberately calls this testimony and skips it; here it is a slot,
//              because a dangling product mention reads as a plug with no link.
//   B  ITEM-SWAP — in a listicle, remove one whole numbered item and paste the pod AS that item
//              (1-for-1: the hook's promised count and every other number stay untouched). The
//              operator's recommended path: "so much easier and cleaner".
//   C  FRESH INSERT — the tweet-3 law, non-adjacent, clear of the donor's funnel tail.
//
// CTA depth follows what the thread already gives the reader: their run-up hands a buying
// criterion -> 1 tweet (CTA-only) · names the substance only -> 2 tweets (bridge + plug) ·
// cold -> the pod's full 3 tweets (2 in a roundup, where the item tweet IS the point).
//
// POSITION SPACE: everything in and out of placePods speaks 1-based DONOR positions; the assembled
// preview (what the writer actually pastes) carries each plug's final 1-based position too. Every
// plug also quotes its anchor tweet — trust the quote over the number, numbers drift, quotes don't.
// (The plan sketched reusing planPlugs' writer-space remap here; the round-4 ITEM-SWAP ruling made
// replacement-in-place the primary move, which planPlugs cannot express — so positions are chosen
// on the assembled thread directly and the gate preview rules on the real result.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { donorPlugSlots, podFrame, selectPod, selectAltPod, chooseShape } from './outline.mjs';
import { PODS, renderPod, variantFor } from './pods.mjs';
import {
  BRIDGE, SUBSTANCE_WORDS, substanceTermsFor, bridgeableProducts, plugBudget, looksLikeCriterion,
  runUpIssue, discriminationIssue, criterionOrderIssue, effLen, leadingNumbers, listicleKind,
} from './checks.mjs';
import { bridgeRoute, foreignCtaIssue, plugSlots } from './retrofit-brief.mjs';
import { classifyProduct } from './pod-coverage.mjs';
import { recentAsinUse, classifyTopic } from './pick-product.mjs';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term) => new RegExp(`\\b${esc(term)}\\b`, 'i');

// A2: first-person usage that stops short of an ask. Deliberately narrow — plain topic talk
// ("magnesium helps sleep") is content, not a slot.
export const IMPLY_RE = /\bi (?:take|use|started taking|switched to) \S|\bi(?:'ve| have) been (?:taking|using)\b|\bworks for me\b/i;

// ---- STEP 1: what does the thread offer? ---------------------------------------------------------
/** Pure: every BRIDGE term the donor names, with evidence positions (1-based) and the allowlist
 *  product it routes to. SUBSTANCE_WORDS-only hits are reported sellable:false — the thread names
 *  them, the allowlist cannot answer them. */
export function senseSubstances(tweets, { products = [] } = {}) {
  const byAsin = new Map((products || []).map((p) => [p.asin, p]));
  const out = [];
  for (const [term, asin] of Object.entries(BRIDGE)) {
    const re = wordRe(term);
    const hits = (tweets || []).flatMap((t, i) => (re.test(String(t)) ? [i + 1] : []));
    if (hits.length) out.push({ term, asin, product: byAsin.get(asin) || null, tweets: hits, sellable: byAsin.has(asin) });
  }
  const covered = new Set(out.map((s) => s.term));
  for (const w of SUBSTANCE_WORDS) {
    if (covered.has(w) || BRIDGE[w]) continue;
    const re = wordRe(w);
    const hits = (tweets || []).flatMap((t, i) => (re.test(String(t)) ? [i + 1] : []));
    if (hits.length) out.push({ term: w, asin: null, product: null, tweets: hits, sellable: false });
  }
  // Most-discussed first: evidence count is the fit signal (the product follows the THREAD).
  return out.sort((a, b) => b.tweets.length - a.tweets.length);
}

// ---- STEP 2a: the donor's own slots (sell + imply) -----------------------------------------------
/** Pure: donorPlugSlots' sell spans converted to 1-based, then a second IMPLY scan over tweets no
 *  sell span already claims. An imply slot spans just its own tweet. */
export function donorSlots(tweets) {
  const sell = donorPlugSlots(tweets).map((s) => ({ ...s, at: s.at + 1, start: s.start + 1, tier: 'sell' }));
  const claimed = new Set(sell.flatMap((s) => Array.from({ length: s.at - s.start + 1 }, (_, k) => s.start + k)));
  const imply = [];
  for (let i = 1; i < (tweets || []).length; i++) {
    const n = i + 1;
    if (claimed.has(n) || !IMPLY_RE.test(String(tweets[i])) || leadingNumbers(String(tweets[i])).length) continue;
    let substance = null, asin = null;
    for (let back = i; back >= Math.max(0, i - 2) && !substance; back--) {
      const lc = String(tweets[back]).toLowerCase();
      for (const [term, a] of Object.entries(BRIDGE)) if (lc.includes(term)) { substance = term; asin = a; break; }
    }
    if (!substance) continue; // testimony about nothing sellable — content, not a slot
    imply.push({ at: n, start: n, substance, asin, evidence: (String(tweets[i]).match(IMPLY_RE) || [''])[0], tier: 'imply' });
  }
  return [...sell, ...imply].sort((a, b) => a.start - b.start);
}

// ---- STEP 2b: item-swap targets ------------------------------------------------------------------
/** Pure: which numbered item should give up its seat? Ranked: (1) the item already naming our
 *  substance, (2) the item whose text can bridge to it, (3) everything else, writer's choice.
 *  Item 1 is demoted below rank 1 — it shapes the hook's promise (firstItemFormIssue territory). */
export function itemSwapCandidates(tweets, itemAt, product) {
  const terms = substanceTermsFor(product);
  return (itemAt || []).map((at) => {
    const text = String(tweets[at - 1] || '');
    const number = Number(leadingNumbers(text)[0]) || null;
    let rank = 3, why = 'no topical tie — writer\'s choice';
    if (terms.some((t) => text.toLowerCase().includes(t))) { rank = 1; why = 'this item already names the substance — the pod IS this item done better'; }
    else if ([...bridgeableProducts(text)].includes(product.asin)) { rank = 2; why = 'on-topic item — the pod replaces it without bending the list'; }
    if (number === 1 && rank > 1) rank = 4; // item 1 belongs to the promise; swap it only on a direct hit
    return { at, number, text, rank, why };
  }).sort((a, b) => a.rank - b.rank || a.at - b.at);
}

// ---- STEP 3: CTA depth ---------------------------------------------------------------------------
/** Pure: how many tweets should this plug be? Donor slots read the DONOR's surviving run-up with
 *  the same detector the warm-slot gates use, so the chooser and the gate can never disagree. */
export function depthFor({ kind, span, tweets, product, shape, pod, account }) {
  if (kind === 'donor-slot') {
    const runUp = (tweets || []).slice(Math.max(0, span.start - 1 - 3), span.start - 1).map(String);
    const terms = substanceTermsFor(product);
    // Identity terms only (the discriminationIssue:2392 idiom): "cortisol" is a symptom term, and a
    // criterion-shaped line about someone ELSE's item (the cold-exposure tweet on the real cortisol
    // donor) must not warm this slot. The criterion has to be about the substance BY NAME.
    const title = String(product?.title || '').toLowerCase();
    const nameTerms = terms.filter((t) => title.includes(t));
    const idTerms = nameTerms.length ? nameTerms : terms;
    const names = runUp.some((t) => idTerms.some((x) => t.toLowerCase().includes(x)));
    const criterion = runUp.some((t) => looksLikeCriterion(t, product) && idTerms.some((x) => t.toLowerCase().includes(x)));
    if (names && criterion) return { depth: 1, why: 'their run-up names the substance AND hands a buying criterion — CTA-only, literally one tweet' };
    if (names) return { depth: 2, why: 'their run-up names the substance but hands no criterion — our bridge supplies it, then the plug' };
    return { depth: 2, why: 'slot claimed but their surviving run-up never names the substance — bridge + plug; the gate preview says if even that arrives cold' };
  }
  if (shape === 'roundup') return { depth: 2, why: 'roundup — the item tweet is the POINT, a 3-tweet pod would say it twice' };
  if (!String(variantFor(pod, account)?.point || '').trim()) return { depth: 2, why: 'this variant is a native 2-tweet pod (no point)' };
  return { depth: 3, why: kind === 'item-swap' ? 'the pod takes the item\'s seat with its own point + bridge + plug' : 'cold insert — the pod carries its own point + bridge + plug' };
}

const previewLink = (i) => `https://lvnta.com/lv_prevw${i + 1}`;

// ---- the core ------------------------------------------------------------------------------------
// `choose` (scripts/row-skeleton.mjs, Jev): { spot(asin), swapAt(asin), depth(asin) } return a preferred
// fresh-insert position, item-swap target or donor-slot depth. Each is honoured only when it is one of
// the options the code computed as legal here; anything else falls back to the code's own pick. Every
// plug records its options (legalSpots, swapCandidates, runUp) so the chooser can read them.
export function placePods(donorTweets, { account = '', products = [], pods = PODS, recentMoves = [], occupied = [], choose = {} } = {}) {
  const tweets = (donorTweets || []).map((t) => String(t || ''));
  const hook = tweets[0] || '';
  const warnings = [], orders = [];
  const byAsin = new Map(products.map((p) => [p.asin, p]));

  const senses = senseSubstances(tweets, { products });
  const sellable = senses.filter((s) => s.sellable);
  const itemAt = tweets.flatMap((t, i) => (i > 0 && leadingNumbers(t).length ? [i + 1] : []));
  const shapeInfo = chooseShape(tweets, { bridgeable: sellable.map((s) => s.asin), itemCount: itemAt.length });
  const frame = podFrame(hook);
  const budget = Math.max(2, plugBudget(tweets.length, { products: new Set(sellable.map((s) => s.asin)).size }));

  // The donor's funnel tail: plugs never land inside it (their audience, their CTA, our loss).
  const foreign = foreignCtaIssue(tweets, {});
  let lastGood = tweets.length;
  while (lastGood > 1 && foreign.some((f) => f.tweet === lastGood)) lastGood--;

  // -- claim the donor's own slots first (every sell slot, even past budget: never left standing) --
  const slots = donorSlots(tweets);
  const usedMoves = [...(recentMoves || [])], usedPods = [], claimedAsins = new Set();
  const plugs = [];
  const slotRows = [];
  for (const s of slots) {
    const product = s.asin ? byAsin.get(s.asin) : null;
    const row = { ...s, product: product || null, unsupplied: !product, retarget: null };
    if (!product) {
      // Their ask, but nothing we can supply in reach: widen the scan; else order the span stripped.
      const near = [...sellable].reverse().find((x) => x.tweets.some((n) => n < s.start));
      if (s.asin) warnings.push(`BRIDGE routes "${s.substance}" to ${s.asin} but it is not in products.json — allowlist drift`);
      if (near) row.retarget = { term: near.term, asin: near.asin, tweet: Math.max(...near.tweets.filter((n) => n < s.start)) };
      orders.push(row.retarget
        ? `donor ${s.tier} at tweet ${s.start}${s.at > s.start ? `-${s.at}` : ''} sells "${s.substance || '?'}" we cannot supply — RETARGET: re-point the span at ${row.retarget.term} (named back at tweet ${row.retarget.tweet}) or strip it`
        : `donor ${s.tier} at tweet ${s.start}${s.at > s.start ? `-${s.at}` : ''} has no bridgeable substance — STRIP the span; never leave their ask standing`);
      slotRows.push(row); continue;
    }
    slotRows.push(row);
    if (s.tier === 'sell' || plugs.length < budget) {
      const { pod, via } = selectPod(product, { account, frame, pods, excludeMoves: usedMoves, excludeIds: usedPods });
      const code = depthFor({ kind: 'donor-slot', span: s, tweets, product, shape: shapeInfo.shape, pod, account });
      const want = choose.depth?.(product.asin);
      const d = [1, 2, 3].includes(want?.depth) ? { depth: want.depth, why: `${want.why || 'chosen'} (Jev${want.depth === code.depth ? '' : `; code said ${code.depth}`})` } : code;
      const runUp = tweets.slice(Math.max(0, s.start - 1 - 3), s.start - 1).map(String);
      plugs.push({ kind: 'donor-slot', tier: s.tier, span: { start: s.start, end: s.at }, product, pod, via, depth: d.depth, depthWhy: d.why, runUp });
      claimedAsins.add(product.asin);
      if (pod) { usedPods.push(pod.id); if (pod.move) usedMoves.push(pod.move); }
    }
  }
  if (plugs.length > budget) warnings.push(`donor slots (${plugs.length}) exceed the length budget (${budget}) — every ask still gets claimed; trim elsewhere if the thread runs long`);

  // -- fill the remaining budget: item-swap in a listicle, fresh inserts otherwise ----------------
  // Dedupe by ASIN (two BRIDGE terms often route to one product: "omega" and "omega-3"), merging
  // evidence counts so the fit signal stays honest.
  const evidenceByAsin = new Map();
  for (const s of sellable) evidenceByAsin.set(s.asin, (evidenceByAsin.get(s.asin) || 0) + s.tweets.length);
  const productQueue = [...evidenceByAsin.keys()]
    .filter((asin) => !claimedAsins.has(asin))
    .sort((a, b) => evidenceByAsin.get(b) - evidenceByAsin.get(a)
      || (byAsin.get(b)?.commission ?? 0) - (byAsin.get(a)?.commission ?? 0));
  const swappedAt = new Set();
  const claimedSpans = plugs.filter((p) => p.span).map((p) => p.span);
  const inSpan = (n) => claimedSpans.some((sp) => n >= sp.start && n <= sp.end);
  while (plugs.length < budget) {
    let next = productQueue.shift();
    while (next && claimedAsins.has(next)) next = productQueue.shift();
    let product = byAsin.get(next);
    let pod = null, via = null;
    if (!product && plugs.length && plugs[0].product) {
      // Single-substance thread: the second plug reuses the product on a DIFFERENT pod + move.
      product = plugs[0].product;
      const alt = selectAltPod(product, plugs[0].pod, { account, frame, pods, excludeMoves: usedMoves });
      if (!alt) {
        warnings.push(plugs.length < 2
          ? 'minimum-2 unmet: one substance, and no second pod for it is usable — either none exists on a different move, or the one that does repeats the first pod\'s copy too closely to paste twice — write the second plug by hand'
          : `budget ${budget} partly unfilled at ${plugs.length} plug(s): no further pod with a fresh move for this product`);
        break;
      }
      pod = alt; via = 'alt';
      warnings.push('same product twice — measured ~3x weaker than two distinct substances; a point rewrite toward a second substance is worth it');
    } else if (!product) { warnings.push(`budget ${budget} unfilled: the thread offers no further allowlist substance`); break; }
    if (!pod) ({ pod, via } = selectPod(product, { account, frame, pods, excludeMoves: usedMoves, excludeIds: usedPods }));

    // A swap DESTROYS the donor item, so it is only allowed when a renderable pod takes the seat —
    // a pod-less product degrades to an insert the writer fills, never to a hole in the list. An
    // alt-pod plug (same product again) never swaps either: one substance cannot be two list members.
    const isListicle = itemAt.length >= 3 && !!pod && !!variantFor(pod, account) && via !== 'alt';
    const candidates = isListicle
      ? itemSwapCandidates(tweets, itemAt.filter((n) => !swappedAt.has(n) && !inSpan(n) && n <= lastGood), product).filter((c) => c.rank <= 3)
      : [];
    const wantAt = choose.swapAt?.(product.asin);
    const chosen = wantAt === null ? null : candidates.find((c) => c.at === wantAt);
    const target = wantAt === null ? null : chosen ? { ...chosen, why: `${chosen.why} (Jev)` } : candidates[0];
    if (target) {
      const d = depthFor({ kind: 'item-swap', tweets, product, shape: shapeInfo.shape, pod, account });
      plugs.push({ kind: 'item-swap', at: target.at, itemNumber: target.number, swapWhy: target.why, product, pod, via, depth: d.depth, depthWhy: d.why,
        swapCandidates: candidates.map((c) => ({ at: c.at, number: c.number, rank: c.rank })) });
      swappedAt.add(target.at);
    } else {
      const d = depthFor({ kind: 'fresh-insert', tweets, product, shape: shapeInfo.shape, pod, account });
      plugs.push({ kind: 'fresh-insert', product, pod, via, depth: d.depth, depthWhy: d.why });
    }
    claimedAsins.add(product.asin);
    if (pod) { usedPods.push(pod.id); if (pod.move) usedMoves.push(pod.move); }
  }

  // -- render each plug's paste and stamp shared fields -------------------------------------------
  plugs.forEach((p, i) => {
    p.frame = frame;
    p.frameCovered = !!p.pod && (p.pod.variants || []).some((v) => v.entryLines?.[frame]);
    p.requiresHostMention = !!p.pod?.requiresHostMention;
    p.move = p.pod?.move || null;
    if (p.pod && !p.frameCovered) warnings.push(`${p.pod.id}: no entry line for the "${frame}" frame — it will open in its own framing ('answer' / 'bonus' are the unnumbered aside frames)`);
    if (!p.pod) {
      const c = p.product ? classifyProduct(p.product, account, { pods }) : null;
      p.paste = null;
      p.depthWhy += ` — NO POD in the library (${c?.kind || 'unknown gap'}): write this plug by hand per money-thread SKILL.md`;
      return;
    }
    const rendered = renderPod(p.pod, account, previewLink(i), {
      frame,
      itemNumber: p.kind === 'item-swap' ? p.itemNumber : null,
      compact: p.depth === 2,
      ctaOnly: p.depth === 1,
    });
    p.paste = rendered ? rendered.tweets : null;
    if (!p.paste) { p.depthWhy += ' — pod has no variant this account can render'; }
  });

  // -- assemble the preview: spans and swaps first (descending), then fresh inserts by the law ----
  let out = [...tweets];
  const anchored = plugs.filter((p) => p.span || p.at).sort((a, b) => (b.span?.start || b.at) - (a.span?.start || a.at));
  for (const p of anchored) {
    const paste = p.paste || [`{{WRITE: ${p.product?.asin || '?'} plug here}}`];
    if (p.span) out.splice(p.span.start - 1, p.span.end - p.span.start + 1, ...paste);
    else out.splice(p.at - 1, 1, ...paste);
  }
  for (const p of plugs.filter((x) => x.kind === 'fresh-insert')) {
    const paste = p.paste || [`{{WRITE: ${p.product?.asin || '?'} plug here}}`];
    const { legal } = plugSlots(out, {});
    let tail = out.length;
    while (tail > 1 && foreignCtaIssue([out[tail - 1]], {}).length) tail--;
    const open = legal.filter((n) => n <= tail && !(occupied || []).some((o) => Math.abs(o - n) < 2));
    p.legalSpots = open.map((n) => ({ spot: n, before: String(out[n - 2] || '') }));
    const want = choose.spot?.(p.product?.asin);
    const spot = open.includes(want) ? want : open.slice().sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3))[0];
    if (open.includes(want)) p.spotBy = 'jev';
    if (!spot) { warnings.push(`no legal position left for the ${p.product?.asin} insert — thread too crowded`); p.afterTweet = null; continue; }
    p.afterTweet = spot - 1;
    out.splice(spot - 1, 0, ...paste);
  }

  // -- final positions + the gate-advisory preview ------------------------------------------------
  plugs.forEach((p, i) => {
    const link = previewLink(i);
    const idx = out.findIndex((t) => t.includes(link) || t.includes(`{{WRITE: ${p.product?.asin}`));
    p.finalAt = idx + 1;
    p.anchorQuote = String(out[Math.max(0, idx - 1)] || '').split('\n')[0].slice(0, 60);
    p.route = p.kind === 'fresh-insert' && p.finalAt > 1 && p.product ? bridgeRoute(out, p.finalAt, p.product) : null;
    p.preview = { advisories: [] };
    if (idx < 1 || !p.product) return;
    // A pod plug carries its own reviewed run-up (see runUpIssue's `pod` exemption): four of the five
    // frames withhold the substance from the first tweet on purpose and hand off with "↓".
    const opts = { donorSlot: p.kind === 'donor-slot', pod: !!p.pod };
    for (const [gate, msg] of [
      ['runUp', runUpIssue(out, idx, p.product, { ...opts, shape: shapeInfo.shape === 'roundup' ? 'roundup' : null })],
      ['discrimination', discriminationIssue(out, idx, p.product, opts)],
      ['criterionOrder', criterionOrderIssue(out, idx, p.product, opts)],
    ]) if (msg) p.preview.advisories.push({ gate, msg, hard: gate === 'criterionOrder' });
  });

  return {
    frame, shape: shapeInfo.shape, kind: shapeInfo.kind, why: shapeInfo.why, budget,
    topic: classifyTopic(hook), itemAt, lastGood,
    senses, donorSlots: slotRows, orders, plugs, preview: out, foreign, warnings,
  };
}

// ---- CLI -----------------------------------------------------------------------------------------
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

function parseFile(path) {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw);
  // Tweets carry internal blank lines, so an explicit --- separator wins when present.
  if (/^---\s*$/m.test(raw)) return raw.split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
  return raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const HERE = new URL('.', import.meta.url).pathname;
  const account = String(arg('account', '')).toLowerCase();
  if (!account) throw new Error('pass --account <key>');
  const products = JSON.parse(readFileSync(join(HERE, 'products.json'), 'utf8')).products;

  let tweets, donorRecId = null, donorUrl = null;
  if (arg('rec')) {
    const { loadEnv, requireEnv, airtable } = await import('./lib.mjs');
    const { TABLES } = await import('./config.mjs');
    const env = loadEnv(); requireEnv(env, ['AIRTABLE_PAT']);
    const at = airtable(env);
    donorRecId = arg('rec');
    const head = await at.getRecord(TABLES.swipe, donorRecId);
    donorUrl = head.fields['Tweet URL'] || null;
    const rows = [];
    for (const tid of (head.fields.Tweets || [])) {
      const f = (await at.getRecord(TABLES.swipe, tid)).fields;
      rows.push({ n: f['Tweet Number'] || 0, text: f.Text || '' });
    }
    tweets = rows.sort((a, b) => a.n - b.n).map((r) => r.text).filter(Boolean);
    if (!tweets.length) tweets = [head.fields.Text || ''];
  } else if (arg('file')) {
    tweets = parseFile(arg('file'));
  } else throw new Error('pass --rec <recId> or --file <path>');

  const { ACCOUNTS } = await import('./accounts.mjs');
  if (!ACCOUNTS[account]) throw new Error(`unknown account "${account}"`);
  const plan = placePods(tweets, { account, products, recentMoves: [] });

  if (process.argv.includes('--json')) { console.log(JSON.stringify({ donorRecId, donorUrl, ...plan }, null, 1)); return; }

  const used = recentAsinUse(ACCOUNTS[account].name);
  console.log(`POD PLACEMENT — ${account} · ${donorRecId || arg('file')} · ${tweets.length} tweets · shape ${plan.shape} (${plan.why}) · frame ${plan.frame} · topic ${plan.topic}`);
  console.log('  positions are 1-based; "final" numbers refer to the assembled draft below. Anchors are quoted — trust the quote over the number.\n');

  console.log('0. THE THREAD  (▸ = donor sell/imply span · ✗ = donor funnel line)');
  const spanned = new Set(plan.donorSlots.flatMap((s) => Array.from({ length: s.at - s.start + 1 }, (_, k) => s.start + k)));
  tweets.forEach((t, i) => {
    const n = i + 1;
    const mark = spanned.has(n) ? '▸' : plan.foreign.some((f) => f.tweet === n) ? '✗' : ' ';
    console.log(`  ${mark}[${String(n).padStart(2)}] ${String(effLen(t)).padStart(3)}c  ${t.replace(/\n/g, ' ⏎ ').slice(0, 130)}`);
  });

  console.log(`\n1. WHAT THE THREAD OFFERS  (the product follows the THREAD, never the account)`);
  if (!plan.senses.length) console.log('   (nothing — no allowlist substance and no known substance word)');
  for (const s of plan.senses.slice(0, 8)) {
    console.log(`   ${s.sellable ? '●' : '○'} ${s.term.padEnd(14)} ${s.asin || '(no allowlist route)'}  tweets ${s.tweets.join(',')}${s.product ? `  ${String(s.product.commission)}%  ${String(s.product.title).slice(0, 44)}` : ''}${s.asin && used[s.asin] ? `  ⚠ used ${used[s.asin]}x/7d` : ''}`);
  }

  console.log(`\n2. DONOR SLOTS  (claimed FIRST — never leave their ask standing)`);
  if (!plan.donorSlots.length) console.log('   (none — the creator never sells or implies; all plugs are ours to place)');
  for (const s of plan.donorSlots) {
    console.log(`   ${s.tier.toUpperCase().padEnd(5)} tweets ${s.start}${s.at > s.start ? `-${s.at}` : ''} · "${s.evidence}" · ${s.substance || 'NO SUBSTANCE'}${s.asin ? ` → ${s.asin}` : ''}${s.unsupplied ? '  ⚠ UNSUPPLIED' : ''}`);
  }
  for (const o of plan.orders) console.log(`   ✗ ORDER: ${o}`);

  console.log(`\n3. THE PLAN  (budget ${plan.budget} · minimum 2)`);
  for (const [i, p] of plan.plugs.entries()) {
    const where = p.span ? `REPLACES donor tweets ${p.span.start}${p.span.end > p.span.start ? `-${p.span.end}` : ''}`
      : p.at ? `SWAPS OUT item at donor tweet ${p.at}${p.itemNumber ? ` (item ${p.itemNumber} keeps its number)` : ''}`
        : p.afterTweet ? `INSERT after assembled tweet ${p.afterTweet}` : 'UNPLACED';
    console.log(`   PLUG ${i + 1} [${p.kind}${p.tier ? `:${p.tier}` : ''}] ${where} → final tweet ${p.finalAt}`);
    console.log(`     after: "${p.anchorQuote}"`);
    console.log(`     ${p.product?.asin || '?'} · pod ${p.pod?.id || 'NONE'}${p.move ? ` (${p.move})` : ''} · depth ${p.depth} — ${p.depthWhy}`);
    if (p.kind === 'item-swap') console.log(`     swap: ${p.swapWhy}`);
    if (p.route) console.log(`     route: ${p.route.route.toUpperCase()} — ${p.route.why}`);
    for (const a of p.preview.advisories) console.log(`     ADVISORY${a.hard ? ' (hard ERROR at publish-thread)' : ''}: ${a.gate}: ${a.msg}`);
    if (!p.preview.advisories.length && p.paste) console.log('     gates: clean');
    if (p.paste) p.paste.forEach((t, k) => console.log(`     [${k + 1}/${p.paste.length}] ${t.replace(/\n/g, ' ⏎ ').slice(0, 150)}`));
  }

  console.log(`\n4. NEXT`);
  console.log(`   moves this plan: ${plan.plugs.map((p) => p.move).filter(Boolean).join(', ') || '(none)'} · recent on account: ${Object.entries(used).map(([a, n]) => `${a} ${n}x`).join(' ') || '(none)'} (context, not a veto)`);
  console.log(`   subid stem: x-thread-${account}-${String(tweets[0] || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 46)}-${String(donorRecId || '').slice(-4)}-pp`);
  console.log('   mint per product (Money · Mint link) → swap {{preview links}} for real mints → publish-thread with "donorSlot": true on donor-slot products (stamps ledger warmSlot) → --dry first, always.');
  for (const w of plan.warnings) console.log(`   ⚠ ${w}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runMain } = await import('./lib.mjs');
  await runMain(main, 'pod-place');
}
