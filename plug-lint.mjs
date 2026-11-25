#!/usr/bin/env node
// plug-lint.mjs — one gate for every locked plugging rule, run on the thread as it will ship.
//
// Owner, 2026-11-20: "Build strong railgaurd for strogner plugging logic." Every plug rule since the
// 2026-11-14 CTA workshop lived in docs (cta-templates.md, cta-spec.md §0a) and in memory, and was
// checked by eye at drafts. Only two pieces were machine-checked: the point frame (point-frame.mjs,
// numbering + title names the product) and the brief's plan (plug-plan.mjs). The read of the 10
// threads scheduled on 2026-11-19 found a rule broken in every one of them (no duration, retired
// "This is the one" lines, a criterion with no break after its first sentence, a light CTA two items
// after the heavy one). This file is those rules as code, in one place, with the owner's words beside
// each, so a draft that breaks one is held before it is scheduled.
//
//   plugLint(tweets, ctx) -> [{ rule, level: 'hard'|'warn', tweet, msg }]
//
// `tweets` is the thread as it will ship: {{LINK}} placeholders or real links, no #ad appended (the
// pot-gate's #ad is a gate-time stand-in, never shipped). `ctx`:
//   asins       the products in plug order (heavy, light, extras); checked against the shelf
//   products    products.json (the shelf); loaded from disk by the CLI, optional in tests
//   kind        'cover' (workshop CTA, every rule) | 'sep' (the September CTA test side: its own
//               wording, #ad included) | 'pot' (a seed's structure, kept word for word by the origin
//               lock). sep and pots get the universal rules only, never the workshop template rules.
//   aboutText   the page's master about-me tweet; when given it must be second to last
//   prior       "account|asin" -> duration this page used before (plug-plan.mjs priorDurations)
//   account     the page, for `prior`
//   pointFrame  false to skip point-frame.mjs (pot-gate already ran it)
//
//   node plug-lint.mjs WORK [--date YYYY-MM-DD]     every row in WORK/rows.json; exit 1 on any hard finding
//   node plug-lint.mjs --posts FILE                 [{ acct, posts: [text] }] (a Typefully read-back)
//
// Hard findings hold a row (hand-run check/prepare, and ship refuses to schedule it). Warnings are
// printed for the writer; they need a person's read, not a block. Pure apart from main().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { styleOf, firstLine, has, aliasGroup, pointFrameIssues, nonNativeFrame } from './point-frame.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LINK = /\{\{LINK\d?\}\}|https?:\/\/\S+/;
const WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|over|almost|nearly';
// "for two years now", "for over three years now", "for eight months now"
export const DURATION = new RegExp(`\\bfor ((?:(?:${WORDS})\\s+)+(?:months?|years?)) now\\b`, 'i');
const BAD_DURATION = /\bfor\s+(?:\d+|a few|several|(?:(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:days?|weeks?))\b[^.]*\bnow\b/i;
const norm = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const paras = (t) => String(t || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const sentences = (p) => String(p || '').match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];

// ---- the rules, each with where it comes from --------------------------------------------------
// Owner 2026-11-19: "Remove this sort of sentence from our first CTA tweets" (the 2026-11-17 I-lines).
export const RETIRED_LINES = [
  /\bthis is the one\b/i, /\bhere'?s mine\b/i, /\balways on my kitchen counter\b/i,
  /\bthe one i'?d keep\b/i, /\bthe one supplement i never skip\b/i, /\bi never skip\b/i,
];
// Heavy close (cta-templates.md H3). Owner 2026-11-20: "Give the last line more weight", approved
// closes 1, 2, 6, 9 and 10 (1 and 2 the default). The older three stay valid. Omega-3 takes any of them
// (the 2026-11-13 lock to "The one I recommend:" is lifted by that approval).
const NOUN = "[a-z0-9+\\- ]{2,30}";
export const CLOSES = [
  /^The one I recommend:$/,
  new RegExp(`^This is my (?:favorite )?${NOUN}:$`, 'i'),
  new RegExp(`^This is the ${NOUN} I take every (?:night|morning|day):$`, 'i'),
  new RegExp(`^This is the ${NOUN} I recommend to everyone:$`, 'i'),
  new RegExp(`^If I could keep only one ${NOUN}, it's this one:$`, 'i'),
  new RegExp(`^This is the one ${NOUN} I never let run out:$`, 'i'),
  new RegExp(`^The ${NOUN} I buy my (?:dad|mom|mum|father|mother|wife|husband|parents):$`, 'i'),
];
export const isClose = (l) => CLOSES.some((re) => re.test(String(l).trim()));
export const OMEGA_CLOSE = 'The one I recommend:';
// No promo or code line in any plug (owner 2026-11-14 14:05Z on omega: "Remove it"; cta-spec 290).
const PROMO = /\b(?:promo|coupon|code\s+[A-Z0-9]{4,}|discount|\d{1,2}\s?% off|subscribe\s*&\s*save|deal ends|limited time|black friday|sale price)\b/i;
// A colon with words on both sides (cta-spec §7 LAW). Times (4:30) and ratios (2:1) are fine, and so
// is a line that ends on its colon (the close, "Here's ... to check: ↓").
export function midColon(line) {
  const l = String(line || '').replace(/\b\d+:\d+\b/g, '').replace(/^\s*(?:(?:rule|step|day)\s+\d{1,2}|#\d{1,2})\s*:\s*/i, '');
  return /[^\s:]:\s*\S/.test(l.replace(/:\s*↓?\s*$/, ''));
}
// Standing product rules a plan or a draft can break (plug-plan.mjs re-exports these as RULES).
export const TOPIC_RULES = [
  { id: 'no-creatine-on-stress', why: 'creatine reads as gym bros on a cortisol, stress or signs thread (owner 2026-11-19)',
    topic: /cortisol|stress|anxi|signs?\b|symptom/i, product: /creatine/i },
  { id: 'no-magnesium-on-kidneys', why: 'kidney threads carry no magnesium (kidney safety)',
    topic: /kidney|renal/i, product: /magnes|glycinate|magtein|threonate/i },
];

/** "account|asin" -> last logged duration, from CTA log rows that carry one. */
export function priorDurations(rows) {
  const out = {};
  for (const r of [...(rows || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (r.duration && r.account && r.heavyAsin) out[`${r.account}|${r.heavyAsin}`] = r.duration;
  }
  return out;
}

/** Shelf findings for a product list (heavy first): off the shelf, retired, unavailable, not Prime. */
export function productIssues(asins = [], products = null) {
  const out = [];
  const shelf = products ? new Map([...(products.products || [])].map((p) => [p.asin, p])) : null;
  const retired = products ? new Set([...(products.retired || [])].map((p) => p.asin)) : null;
  asins.forEach((a, i) => {
    if (!a) return;
    const role = i === 0 ? 'heavy' : i === 1 ? 'light' : `product ${i + 1}`;
    if (NOT_PRIME[a]) out.push({ rule: 'prime-only', msg: `${role} ${a} is not Prime: ${NOT_PRIME[a]}` });
    if (!shelf) return;
    if (retired.has(a)) out.push({ rule: 'shelf', msg: `${role} ${a} is retired from the shelf` });
    else if (!shelf.has(a)) out.push({ rule: 'shelf', msg: `${role} ${a} is not on the shelf (products.json)` });
    else if (shelf.get(a).unavailable) out.push({ rule: 'shelf', msg: `${role} ${a} is marked unavailable` });
  });
  return out;
}

// Known non-Prime (merchant-fulfilled) listings. Owner 2026-11-07: Buy Box must be Prime/Ships from
// Amazon before a product is plugged.
export const NOT_PRIME = {
  B01JN8WWQ4: 'Nutricost potassium, shipped by eSupplements (owner 2026-11-07)',
  B01HQVRA30: 'Nutricost L-citrulline 3-pack, shipped by eSupplements (owner 2026-11-08)',
  B079K5VQL5: 'KSM-66 2-pack, shipped by eSupplements (owner 2026-11-19); use B079K32QB6',
};
const isOmega = (t) => /\bomega|fish oil|\bepa\b|\bdha\b/i.test(String(t || ''));
const isD3K2 = (p) => /D3 ?& ?K2|D3 \+ K2|D3 with K2/i.test(`${p?.category || ''} ${p?.title || ''}`);
const payout = (p) => (p ? Number(p.price) * Number(p.commission) : NaN);
const isCriterion = (t) => /\bbut most\b|on the back|↓\s*$/i.test(String(t || ''));
// A product title ("3. Magnesium glycinate", "3. Take creatine, every morning") must open "I take" /
// "I add". A problem or sign title ("3. Too little omega-3", "2. Running low on B12") may stay as it is
// (owner 2026-11-19, cta-templates.md: "Problem or sign titles stay as they are"), so it only warns.
export function productTitle(title) {
  const t = String(title || '').replace(/^\s*(?:(?:rule|step|day)\s+\d{1,2}|#?\d{1,2})\s*[.):/]?\s*/i, '').replace(/^take\s+/i, '');
  const g = aliasGroup(t);
  return !!g && g.some((w) => new RegExp(`^${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t));
}
// Non-native frame (owner 2026-11-21: Kim's diabetes-signs thread shipped "3. I take magnesium glycinate,
// after dinner" as a sign). On a signs / symptoms / avoid / worst / causes / "can't cope" list every item is a
// sign, so the product item opens on its sign as a question: "3. Awake at 3am? I take magnesium glycinate before
// bed" (cta-templates.md "How to change the type"). A bare "N. I take X" there is a hold.
// NON_NATIVE_HOOK and nonNativeFrame live in point-frame.mjs (it reads the signs shape too); re-exported here.
export { nonNativeFrame };
// Number optional: CTA points carry no list number since owner 2026-11-22, older drafts still do.
export const bareProductTitle = (title) => /^\s*(?:\d{1,2}[.)]\s*)?I (?:take|add)\b/i.test(String(title || ''));
// Signs-list point shape (owner 2026-11-22, three passes). 02:31Z: "before we jump to I take..., there should be
// a sentence explaining the mechanism and then our substance is the solution". 02:40Z: "Why is sign list title a
// question? It should be a sign." 02:46Z: "remove the last opener sentence and replace with that's why I take X at
// Y time". So on a non-native frame the CTA point reads:
//   the sign itself as the title, a statement like the list's other items ("Waking up at 3 or 4 AM");
//   the mechanism in plain words (why the sign happens);
//   "That's why I take {product}, {when}." as the last line (light: "That's why I add ..."), in place of the
//   "But only if it actually gets into your body…" open loop.
export const SIGNS_CLOSE = /^That(?:'|’)s why I (?:take|add)\b/i;
export function signsPointIssues(text, verb, group = []) {
  const ps = paras(text);
  const title = firstLine(text);
  const out = [];
  const when = verb === 'I take' ? 'That\'s why I take' : 'That\'s why I add';
  if (/\bI (?:take|add)\b/i.test(title)) out.push({ rule: 'title-frame', msg: `the title "${title.slice(0, 50)}" jumps to "${verb}"; on a signs list the title is the sign itself ("Waking up at 3 or 4 AM"), then the mechanism (owner 2026-11-22)` });
  else if (/\?\s*$/.test(title)) out.push({ rule: 'title-frame', msg: `the title "${title.slice(0, 50)}" is a question; on a signs list the title is the sign itself, a statement like the other items ("Waking up at 3 or 4 AM") (owner 2026-11-22)` });
  const body = ps.slice(1);
  const last = body[body.length - 1] || '';
  if (!SIGNS_CLOSE.test(last)) out.push({ rule: 'signs-close', msg: `the point ends "${when} {product}, {when you take it}." after the mechanism, in place of "But only if it actually gets into your body…" (owner 2026-11-22)` });
  else if (group.length && !group.some((w) => has(last, w))) out.push({ rule: 'signs-close', msg: `"${last.slice(0, 50)}" does not name ${group[0]}` });
  const mid = body.slice(0, SIGNS_CLOSE.test(last) ? -1 : body.length);
  if (mid.some((p) => /(?:^|[.!?]\s+)I (?:take|add)\b/i.test(p) || SIGNS_CLOSE.test(p))) out.push({ rule: 'signs-answer', msg: `one "${verb}" line only, the "${when} ..." close; the mechanism above it explains, it does not sell (owner 2026-11-22)` });
  if (!mid.length) out.push({ rule: 'signs-mechanism', msg: 'the point has no mechanism; explain in plain words why the sign happens before "That\'s why I take ..." (owner 2026-11-22)' });
  return out;
}
const isDisclosure = (t) => /affiliate|commission/i.test(String(t || ''));

/** Where the plugs and their points sit. Index-based (0 = hook). */
export function anatomy(tweets) {
  const T = (tweets || []).map((t) => String(t ?? ''));
  const plugs = T.map((t, i) => (LINK.test(t) && !isDisclosure(t) ? i : -1)).filter((i) => i >= 0);
  const heavy = plugs[0] ?? -1;
  const light = plugs.find((i) => i > heavy && /^\s*If you(?:'|’)re looking to\b/i.test(T[i])) ?? (plugs.length > 1 ? plugs[plugs.length - 1] : -1);
  let criterion = -1, heavyPoint = -1;
  if (heavy >= 1) {
    if (heavy >= 2 && isCriterion(T[heavy - 1]) && !styleOf(firstLine(T[heavy - 1]))) { criterion = heavy - 1; heavyPoint = heavy - 2; } else heavyPoint = heavy - 1;
  }
  const lightPoint = light >= 1 ? light - 1 : -1;
  const items = [];
  T.forEach((t, i) => { for (const l of lines(t)) { const s = styleOf(l); if (s) { items.push({ ...s, tweet: i, title: l }); break; } } });
  return { T, plugs, heavy, light, criterion, heavyPoint, lightPoint, items };
}

export function plugLint(tweets, ctx = {}) {
  const { asins = [], products = null, kind = 'cover', aboutText = null, prior = {}, account = null, pointFrame = true, singleCta = false } = ctx;
  const A = anatomy(tweets);
  const { T, plugs, heavy, light, criterion, heavyPoint, lightPoint, items } = A;
  const out = [];
  const add = (rule, level, tweet, msg) => out.push({ rule, level, tweet: tweet >= 0 ? tweet + 1 : null, msg });
  const cover = kind === 'cover';
  const shelf = products ? new Map([...(products.products || [])].map((p) => [p.asin, p])) : null;
  const P = asins.map((a) => shelf?.get(a) || null);
  const hook = T[0] || '';

  // --- products: shelf, Prime, payout order, D3+K2 --------------------------------------------
  for (const f of productIssues(asins, products)) add(f.rule, 'hard', -1, f.msg);
  if (P[0] && isD3K2(P[0])) add('d3k2-light-only', 'hard', -1, 'SR D3+K2 is plugged light only, never heavy (owner 2026-11-19: "just plug it less")');
  if (P[1] && isD3K2(P[1]) && !/vitamin d|\bbones?\b|winter|sunlight/i.test(hook)) add('d3k2-light-only', 'hard', -1, 'SR D3+K2 light plug only on a vitamin D, bone or winter thread');
  if (P[0] && P[1] && payout(P[1]) > payout(P[0]) * 1.15) add('payout-first', 'warn', -1, `light ${asins[1]} pays ~$${payout(P[1]).toFixed(2)} a sale vs heavy ${asins[0]} ~$${payout(P[0]).toFixed(2)}; heavy goes to the higher payout that fits the hook (owner 2026-11-19 "go hard")`);

  // --- topic rules (plug-plan.mjs RULES): creatine on stress/signs, magnesium on kidneys ----------
  const productText = (i) => [P[i]?.title, i === 0 ? T[heavy] : i === 1 ? T[light] : ''].filter(Boolean).join(' ');
  for (const r of TOPIC_RULES) for (const i of [0, 1]) {
    if ((i === 0 ? heavy : light) < 0 && !P[i]) continue;
    if (r.topic.test(hook) && r.product.test(productText(i))) add(r.id, 'hard', i === 0 ? heavy : light, `${i === 0 ? 'heavy' : 'light'} plug: ${r.why}`);
  }

  // --- universal copy rules (every kind) ---------------------------------------------------------
  for (const i of plugs) {
    if (PROMO.test(T[i])) add('no-promo', 'hard', i, 'plug carries a promo/code/discount line; end on the close (owner 2026-11-14)');
    if (cover && /#ad\b/i.test(T[i])) add('no-ad', 'hard', i, '#ad is off on every workshop plug (owner 2026-11-13 "keep it off"); only the September test side and old-CTA pots carry it');
    for (const l of lines(T[i])) if (!LINK.test(l) && midColon(l)) add('no-mid-colon', 'hard', i, `mid-sentence colon in the plug: "${l.slice(0, 70)}"; make two sentences or use a comma`);
  }
  if (!cover && /#ad\b/i.test(T.filter((_, i) => !plugs.includes(i)).join('\n'))) add('no-ad', 'hard', -1, '#ad outside a plug tweet');
  if (cover && T.some((t, i) => !plugs.includes(i) && /#ad\b/i.test(t))) add('no-ad', 'hard', -1, '#ad in the thread');
  for (const [i, t0] of T.entries()) for (const re of RETIRED_LINES) {
    const t = lines(t0).filter((l) => !isClose(l)).join('\n'); // an approved close may say "This is the one ..."
    if (kind === 'sep' && plugs.includes(i)) continue; // the September close is that test's wording
    if (re.test(t)) { add('retired-i-line', 'hard', i, `retired personal line "${(t.match(re) || [''])[0]}" (owner 2026-11-19: "Remove this sort of sentence"); the personal touch is the "I take X" title`); break; }
  }
  // Omega-3: the close is locked, no promo (above).
  for (const i of plugs) {
    const pIdx = plugs.indexOf(i);
    const omega = isOmega(P[pIdx]?.title) || (!P[pIdx] && isOmega((T[i].match(/^\s*Which\s+([^?]+)\?/) || [])[1] || (T[i].match(/look for\s+([^,.\n]+)/i) || [])[1]));
    if (!omega || kind === 'sep') continue;
    const close = lines(T[i]).filter((l) => !LINK.test(l)).pop() || '';
    if (!isClose(close)) add('omega-close', 'hard', i, `omega-3 plug closes "${close.length > 50 ? `…${close.slice(-48)}` : close}"; use an approved close (default "This is the omega-3 I take every morning:" or "This is the omega-3 I recommend to everyone:", owner 2026-11-20)`);
  }
  // About-me second to last, disclosure last (owner 2026-11-08, standing).
  if (aboutText) {
    if (T.at(-2) !== aboutText) add('about-me', 'hard', T.length - 2, 'the master about-me tweet is not second to last');
    if (!isDisclosure(T.at(-1))) add('about-me', 'hard', T.length - 1, 'the last tweet is not the affiliate disclosure');
  }

  // The criterion tweet stacks (owner 2026-11-20, on Julian's lotus pot: "some lines should stack on each
  // other, I don't like how it splits into so many lines"): a break after the first sentence, then the rest
  // in at most two paragraphs. Pots too: the lotus skeleton's one-line-per-risk T5 is what he saw.
  if (kind !== 'sep' && heavy >= 2) {
    const C = T[heavy - 1];
    if (/\bbut most\b/i.test(C) && !styleOf(firstLine(C)) && paras(C).length > 3) {
      add('criterion-stack', 'hard', heavy - 1, `criterion runs to ${paras(C).length} paragraphs; keep it to 3: first sentence / "But most" + the risks together / the last line (owner 2026-11-20)`);
    }
  }
  if (kind !== 'cover') return out;

  // --- workshop CTA: the shape (cta-templates.md H1-H3, L1-L2, cta-spec §0a) ----------------------
  // singleCta: a brand-lane page with one Prime-verified product (brand-lanes.mjs singleCtaLane) has no light
  // product to plug, so one plug is the whole CTA there; zero plugs still fails.
  if (plugs.length < (singleCta ? 1 : 2)) add('two-ctas', 'hard', -1, `${plugs.length} plug(s); every thread carries a heavy and a light CTA (owner 2026-11-14)`);
  if (heavy < 0) return out;
  if (pointFrame) for (const f of pointFrameIssues(T)) add('point-frame', 'hard', f.tweet - 1, f.msg);

  const H = T[heavy];
  const which = H.match(/^\s*Which\s+([^?]{2,40})\?/);
  if (!which) add('heavy-plug-shape', 'hard', heavy, 'heavy plug must open "Which {noun}? {form}, {credential}. Not {wrong form}." (H3)');
  else if (!/\bNot\s+[^.]{2,40}\./.test(paras(H)[0] || '')) add('heavy-plug-shape', 'hard', heavy, 'heavy plug line 1 has no "Not {wrong form}." sentence (H3)');
  if (DURATION.test(H)) {
    const d = H.match(DURATION)[1].toLowerCase();
    const was = account && asins[0] ? prior[`${account}|${asins[0]}`] : null;
    if (was && norm(was) !== norm(d) && !/^\d+[my]$/.test(was)) add('duration-consistent', 'hard', heavy, `says "for ${d} now" but this page said "${was}" for this product before; keep one duration per page and product`);
  } else if (BAD_DURATION.test(H)) add('heavy-duration', 'hard', heavy, 'duration in days, weeks or digits; months or years in words ("for two years now")');
  else add('heavy-duration', 'hard', heavy, 'heavy plug line 2 names no duration: "I take it {when}, every {day|night}, for {two years} now." (owner 2026-11-19, PR #1005)');
  const personal = paras(H)[1] || '';
  if (!/^(?:I take|Mine goes down|I have|I've taken|I mix|I put)/i.test(personal)) add('heavy-personal-line', 'warn', heavy, 'line 2 should open in the first person ("I take it ..." / "Mine goes down ...")');
  if (!/\bIt helps with\b/i.test(H)) add('heavy-helps-with', 'hard', heavy, 'heavy plug has no "It helps with X, Y and Z." (H3)');
  const closeOk = (t) => { const L = lines(t); const k = L.findIndex((l) => LINK.test(l)); return k >= 1 && CLOSES.some((re) => re.test(L[k - 1])); };
  for (const i of plugs) if (!closeOk(T[i])) add('close', 'hard', i, `close must be its own line right before the link, one of the approved closes (default "This is the {noun} I take every night:" or "This is the {noun} I recommend to everyone:", owner 2026-11-20)`);

  // Criterion (H2): "But most", a break after the first sentence, ends ": ↓".
  if (criterion < 0) add('criterion', 'hard', heavy - 1, 'no criterion tweet between the heavy point and the plug (point / criterion / plug)');
  else {
    const C = T[criterion];
    if (!/\bbut most\b/i.test(C)) add('criterion', 'hard', criterion, 'criterion has no "But most ..." sentence');
    if (sentences(paras(C)[0]).length > 1) add('criterion-break', 'hard', criterion, 'criterion breaks after its first sentence (owner 2026-11-19); put a blank line after it');
    if (!/:\s*↓\s*$/.test(C.trim())) add('criterion', 'hard', criterion, 'criterion ends "Here\'s the {number|word|ingredient list} on the back to check: ↓" (H2)');
    for (const l of lines(C)) if (midColon(l)) add('no-mid-colon', 'hard', criterion, `mid-sentence colon in the criterion: "${l.slice(0, 70)}"`);
  }

  // Heavy point (H1): "N. I take X", ends on the open loop, no mid colon; the hand-off before it.
  const hp = heavyPoint;
  if (hp >= 1) {
    const title = firstLine(T[hp]);
    const hookItem = !styleOf(title) && items.length && items.every((it) => it.tweet === 0);
    const signs = !hookItem && nonNativeFrame(T[0]);
    if (signs) for (const f of signsPointIssues(T[hp], 'I take', aliasGroup(which?.[1] || P[0]?.title || '') || [])) add(f.rule, 'hard', hp, `heavy ${f.msg}`);
    if (!hookItem && !signs && !/\bI take\b/i.test(title)) add('heavy-title', productTitle(title) ? 'hard' : 'warn', hp, `heavy point title "${title.slice(0, 50)}" should be "I take {product}, {when}", no list number (owner 2026-11-19/22; a question first is fine)`);
    if (!signs && !/But only if it actually gets into your body(?:…|\.\.\.)\s*$/.test(T[hp].trim())) add('heavy-open-loop', 'hard', hp, 'heavy point ends "But only if it actually gets into your body…" (H1)');
    for (const l of lines(T[hp])) if (midColon(l)) add('no-mid-colon', 'hard', hp, `mid-sentence colon in the heavy point: "${l.slice(0, 70)}"`);
    // The point carries no number now (owner 2026-11-22), so its place is read from the list items before it.
    const pos = styleOf(title)?.n ?? (items.some((it) => it.tweet > 0) ? items.filter((it) => it.tweet < hp).length + 1 : null);
    if (pos && pos > 3) add('heavy-early', 'hard', hp, `heavy point is item ${pos}; it sits on item 1-3 (Aug-Oct 1.18x clicks there)`);
    // Hand-off (owner 2026-11-19 "I like the hand off", PR #1009): the tweet before ends on the problem
    // and names the product as its answer. Not when the tweet before is the hook.
    if (hp >= 2 && !hookItem) {
      const group = aliasGroup(which?.[1] || P[0]?.title || '') || [];
      const last = sentences(paras(T[hp - 1]).pop()).pop() || '';
      if (group.length && !group.some((w) => has(last, w))) add('handoff', 'hard', hp - 1, `the tweet before the heavy point should end on the problem and name ${group[0]} as its answer (like "...the mineral your body needs to switch off, magnesium.")`);
      if (midColon(last)) add('no-mid-colon', 'hard', hp - 1, `hand-off has a mid-sentence colon: "${last.slice(0, 70)}"; use a comma`);
    }
  }

  // Light CTA (L1 point "N. I add X", L2 plug "If you're looking to {one outcome}, look for {form}, {credential}.").
  if (light >= 0) {
    const L = T[light];
    const l1 = paras(L)[0] || '';
    if (!/^If you(?:'|’)re looking to [^,]{3,60}, look for [^.]{3,}\.$/i.test(l1)) add('light-plug-shape', 'hard', light, 'light plug line 1 must be "If you\'re looking to {one outcome}, look for {form}, {credential}." (L2)');
    else if (/\band skip\b|;|,\s*not\b|\bnot\s+(?:oxide|ethyl|cyano)/i.test(l1)) add('light-line-1', 'hard', light, 'light line 1 stops at the credential: no "and skip ...", "not ..." or ";" tail (owner 2026-11-18, PR #992)');
    if (lightPoint >= 1 && lightPoint !== hp) {
      const title = firstLine(T[lightPoint]);
      const signs = nonNativeFrame(T[0]);
      if (signs) for (const f of signsPointIssues(T[lightPoint], 'I add', aliasGroup((L.match(/look for\s+([^,.\n]{2,60})/i) || [])[1] || '') || [])) add(f.rule, 'hard', lightPoint, `light ${f.msg}`);
      if (!signs && !/\bI add\b/i.test(title)) add('light-title', productTitle(title) ? 'hard' : 'warn', lightPoint, `light point title "${title.slice(0, 50)}" should be "I add {product}, {when}", no list number (owner 2026-11-19/22)`);
      for (const l of lines(T[lightPoint])) if (midColon(l)) add('no-mid-colon', 'hard', lightPoint, `mid-sentence colon in the light point: "${l.slice(0, 70)}"`);
    }
  }

  // Listicle placement (owner 2026-11-19, PR #996/#999): in a list of signs/habits/foods the heavy keeps
  // its early slot, then 3+ real points with no plug, then the light on one of the last two items.
  // In a product listicle every shelf-product item carries its own plug.
  const listItems = items.filter((it) => it.tweet > 0 || items.length > 1);
  const productItems = listItems.filter((it) => aliasGroup(it.title.replace(/\bI (?:take|add)\b/i, '')));
  const productList = listItems.length >= 3 && productItems.length >= Math.ceil(listItems.length * 0.75) && productItems.length >= 3;
  if (productList) {
    for (const it of productItems) {
      const next = listItems.find((x) => x.tweet > it.tweet)?.tweet ?? T.length;
      if (!plugs.some((p) => p >= it.tweet && p < next)) add('listicle-plug-every-item', 'hard', it.tweet, `product listicle: item "${it.title.slice(0, 40)}" has no plug; plug every shelf item or swap it for one (owner 2026-11-19)`);
    }
  } else if (light >= 0 && listItems.length >= 4) {
    const itemAt = (tw) => [...listItems].reverse().find((it) => it.tweet <= tw);
    const h = itemAt(hp), l = itemAt(lightPoint), maxN = Math.max(...listItems.map((it) => it.n));
    if (h && l && l.key === h.key && l.n > h.n) {
      if (l.n - h.n - 1 < 3) add('listicle-placement', 'hard', lightPoint, `only ${l.n - h.n - 1} point(s) between the heavy (item ${h.n}) and the light (item ${l.n}); run at least three real points between them (owner 2026-11-19)`);
      if (l.n < maxN - 1) add('listicle-placement', 'hard', lightPoint, `light CTA is on item ${l.n} of ${maxN}; put it on one of the last two points (owner 2026-11-19)`);
    }
  }
  // No em dashes anywhere in the CTA (cta-spec §7 LAW): hand-off, points, criterion, plugs.
  const cta = new Set([hp - 1, hp, criterion, lightPoint, ...plugs].filter((i) => i >= 1));
  for (const i of [...cta].sort((a, b) => a - b)) if (/—/.test(T[i])) add('no-em-dash', 'hard', i, 'em dash in the CTA (cta-spec §7); use a comma or a full stop');
  return out;
}

export const hard = (findings) => findings.filter((f) => f.level === 'hard');
export const format = (f) => `${f.level === 'hard' ? 'HOLD' : 'warn'} ${f.tweet ? `T${f.tweet} ` : ''}[${f.rule}] ${f.msg}`;

/** The row's kind: a pot keeps its seed's structure, the September side its own wording. */
export function kindOf(row = {}) {
  if (row.potOf || row.lane === 'pot') return 'pot';
  if (row.variant === 'sep' || row.group === 'sep') return 'sep';
  return 'cover';
}

export function loadProducts(file = path.join(HERE, 'products.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function loadPrior(file = '/mnt/project-files/plug-score/cta-split-2026-11.json') {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return priorDurations(Array.isArray(j) ? j : j.rows || []); } catch { return {}; }
}

function main() {
  const argv = process.argv.slice(2);
  const products = loadProducts(), prior = loadPrior();
  const pi = argv.indexOf('--posts');
  let threads;
  if (pi >= 0) {
    threads = JSON.parse(fs.readFileSync(argv[pi + 1], 'utf8')).map((x) => ({ id: `${x.acct}${x.id ? ` ${x.id}` : ''}`, account: x.acct, tweets: x.posts, asins: x.asins || [], kind: kindOf(x) }));
  } else if (argv[0]) {
    const rows = JSON.parse(fs.readFileSync(path.join(argv[0], 'rows.json'), 'utf8'));
    threads = Object.entries(rows).map(([account, r]) => ({ id: account, account, tweets: r.tweets, asins: r.asins || [], kind: kindOf(r) }));
  } else { console.error('usage: node plug-lint.mjs WORK | --posts FILE'); process.exit(2); }
  let bad = 0;
  for (const t of threads) {
    const f = plugLint(t.tweets, { asins: t.asins, products, kind: t.kind, prior, account: t.account });
    const h = hard(f).length;
    if (h) bad++;
    console.log(`${h ? '✗' : '✓'} ${t.id} (${t.kind}) · ${h} hold · ${f.length - h} warn`);
    for (const x of f) console.log(`    ${format(x)}`);
  }
  console.log(`${threads.length - bad} of ${threads.length} clean`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
