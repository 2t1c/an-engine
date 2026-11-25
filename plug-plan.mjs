#!/usr/bin/env node
// plug-plan.mjs: the plug is decided on the brief, checked there, and the draft follows it.
//
// Owner, 2026-11-19: "How can we improve plugging logic and have it built in to the brief so we don't
// waste effort going back and forth" ... "Yes." ... "the brief can and should include as much preparation
// as possible so our work later is streamlined". On R2026-11-19 every plug fix came after the brief was
// approved: Julian's creatine on a signs thread (held at 13:00 Saigon), four hand-off rewrites, Magnus's
// unnumbered light point. Each of those is a choice that can be made, and checked, before the brief goes out.
//
// The work dir holds plug-plan.json, one entry per page, written at brief time:
//   {
//     "kim": {
//       "angle": "belly + 3am + puffy face = one hormone",
//       "hook": "Belly fat that won't move...",                 // the hook as it will ship (optional)
//       "type": "flip", "flip": "signs -> signs + fix",          // or "native"
//       "outline": ["1. Belly fat that won't move", "2. ...", "Awake at 3am? I take magnesium glycinate, an hour before bed", "3. ...", ...],
//       "fit": "The hook promises one hormone behind belly, 3am and puffy face. Magnesium helps that by letting cortisol come down at night.",
//       "heavy": { "product": "magnesium glycinate", "asin": "B0GT2JKMYZ", "item": 3,
//                  "title": "Awake at 3am? I take magnesium glycinate, an hour before bed",   // no list number (owner 2026-11-22)
//                  "handoff": "...drains the mineral your body needs to switch off, magnesium.",
//                  "risks": ["oxide", "fillers", "underdosed"], "duration": "two years" },
//       "light": { "product": "ashwagandha KSM-66", "asin": "B079K5VQL5", "item": 7, "title": "I add ashwagandha KSM-66, with dinner" },
//       // signs / avoid lists (owner 2026-11-22): "title" is the sign itself ("Waking up at 3 or 4 AM"), plus
//       // "mechanism": why it happens, in plain words, and "close": "That's why I take magnesium glycinate, an hour before bed."
//       "media": "donor hook video",
//       "body": "guide"   // which proven body the thread is written on (docs/substance-hook-body.md, owner 2026-11-25)
//     }
//   }
//
//   node plug-plan.mjs check WORK [--log FILE]   every plan's findings; exit 1 when any
//   node plug-plan.mjs brief WORK                the brief's "Plug plan" block (Markdown)
//
// planIssues() checks a plan on its own (before the brief). planMatchIssues() checks a written draft
// against its approved plan (hand-run check). Both are pure.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleOf, firstLine, has, aliasGroup } from './point-frame.mjs';
import { TOPIC_RULES, priorDurations, productIssues, loadProducts, nonNativeFrame } from './plug-lint.mjs';
import { laneIssues, loadLanes } from './brand-lanes.mjs';

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const DURATION_RE = new RegExp(`^(?:${WORDS.join('|')}|a)\\s+(?:months?|years?)$`, 'i');
// A colon with words on both sides is the "mid-sentence colon" the owner rejected (2026-11-19).
const MID_COLON = /[A-Za-z0-9)]:\s+\S/;
// The list marker in front of a title ("3.", "Day 3:", "#3") is not a mid-sentence colon.
const body = (t) => String(t || '').replace(/^\s*(?:(?:rule|step|day)\s+\d{1,2}|#?\d{1,2})\s*[.):/]?\s*/i, '');
const norm = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9?' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const groupOf = (product) => aliasGroup(product) || [String(product || '').toLowerCase()].filter(Boolean);
const names = (text, product) => groupOf(product).some((w) => has(text, w));

// Standing product rules a plan can break before any copy exists (they live in plug-lint.mjs, the one
// place every plugging rule is written, so the brief and the draft gate cannot drift apart).
export const RULES = TOPIC_RULES;

// The proven bodies a substance-hook thread is written on, best first (docs/substance-hook-body.md; owner
// 2026-11-25: "high converting bodies should be prioritize"). "donor" = the donor's own body, kept.
export const BODIES = ['stack-chain', 'guide', 'diary', 'molecule', 'donor'];

/** Findings for one page's plan. `prior` maps "account|asin" -> the duration logged before. */
export function planIssues(account, plan, { prior = {}, products = null, lanes = null } = {}) {
  const out = [];
  // Shelf and Prime first (owner 2026-11-07: Prime only), so an off-shelf product never reaches a draft.
  for (const f of productIssues([plan?.heavy?.asin, plan?.light?.asin], products)) out.push(f.msg);
  // A brand-lane page plugs only its brand (owner 2026-11-21, brand-lanes.mjs).
  for (const m of laneIssues(account, [plan?.heavy?.asin, plan?.light?.asin], lanes)) out.push(m);
  const P = plan || {};
  const H = P.heavy || {}, L = P.light || {};
  const topic = `${P.angle || ''}\n${P.hook || ''}`;
  if (!P.type || !['native', 'flip'].includes(P.type)) out.push('type: say "native" or "flip"');
  if (P.type === 'flip' && !String(P.flip || '').includes('->')) out.push('type flip: write it as "from -> to" ("signs -> signs + fix")');
  if (P.body !== undefined && !BODIES.includes(P.body)) out.push(`body "${P.body}": use one of ${BODIES.join(', ')} (docs/substance-hook-body.md)`);
  const fit = String(P.fit || '').match(/^\s*The hook promises\s+(.{6,}?)\.\s+(.+?)\s+helps that by\s+(.+?)\.?\s*$/i);
  if (!fit) out.push('fit line missing or not in the form "The hook promises ___. [Product] helps that by ___."');
  else if (fit[3].split(/\s+/).length < 3) out.push(`fit line: "helps that by ${fit[3]}" is too thin to show the product answers the hook`);
  else if (!names(fit[2], H.product)) out.push(`fit line names "${fit[2]}", not the heavy product (${H.product})`);

  for (const [kind, X] of [['heavy', H], ['light', L]]) {
    if (!X.product) { out.push(`${kind}: no product`); continue; }
    if (!X.asin) out.push(`${kind}: no ASIN`);
    if (!Number.isInteger(X.item) || X.item < 1) { out.push(`${kind}: give the item number the point sits at`); continue; }
    const title = String(X.title || '');
    if (!title) { out.push(`${kind}: no point title`); continue; }
    // CTA points carry no list number (owner 2026-11-22); `item` is where the point sits in the outline.
    if (styleOf(title)) out.push(`${kind} title "${title}" is numbered; CTA points carry no list number, drop it (owner 2026-11-22)`);
    const verb = kind === 'heavy' ? 'I take' : 'I add';
    if (MID_COLON.test(body(title))) out.push(`${kind} title has a colon mid-sentence; use a comma, or a question mark`);
    if (nonNativeFrame(topic)) {
      // Signs / avoid list (owner 2026-11-22): the title is the sign itself, a statement like the other items
      // ("Waking up at 3 or 4 AM"), the mechanism under it explains why it happens, and the point ends
      // "That's why I take {product}, {when}." (light "I add") in place of the open loop.
      if (new RegExp(`\\bI (?:take|add)\\b`, 'i').test(title)) out.push(`${kind} title "${title}" jumps to "${verb}"; on a signs/avoid list the title is the sign itself ("Waking up at 3 or 4 AM") (owner 2026-11-22)`);
      else if (/\?\s*$/.test(title)) out.push(`${kind} title "${title}" is a question; on a signs/avoid list the title is the sign itself, a statement (owner 2026-11-22)`);
      const mech = String(X.mechanism || '').trim();
      if (!mech) out.push(`${kind}: write the mechanism: why the sign happens, in plain words (owner 2026-11-22)`);
      else {
        if (MID_COLON.test(mech)) out.push(`${kind} mechanism has a colon mid-sentence; use a comma`);
        if (/(^|[.!?]\s+)I (?:take|add)\b/i.test(mech)) out.push(`${kind} mechanism has an "${verb}" sentence; the only one is the "That's why ${verb} ..." close (owner 2026-11-22)`);
      }
      const close = String(X.close || '').trim();
      const want = `That's why ${verb}`;
      if (!close) out.push(`${kind}: write the close "${want} ${X.product}, {when}." that ends the point (owner 2026-11-22)`);
      else {
        if (!new RegExp(`^That(?:'|’)s why ${verb}\\b`, 'i').test(close)) out.push(`${kind} close should open "${want} ${X.product}"`);
        if (!names(close, X.product)) out.push(`${kind} close "${close}" does not name ${X.product}`);
      }
    } else {
      if (!names(title, X.product)) out.push(`${kind} title "${title}" does not name ${X.product}`);
      if (!new RegExp(`\\b${verb}\\b`, 'i').test(title)) out.push(`${kind} title should open "${verb} ${X.product}"`);
    }
    for (const r of RULES) if (r.topic.test(topic) && r.product.test(X.product)) out.push(`${kind} ${X.product}: ${r.why}`);
  }
  if (Number.isInteger(H.item) && H.item > 3) out.push(`heavy point at item ${H.item}; put it at item 2 or 3 (Aug-Oct: 1.18x clicks there)`);
  if (Number.isInteger(H.item) && Number.isInteger(L.item) && L.item <= H.item) out.push(`light point (item ${L.item}) must come after the heavy point (item ${H.item})`);
  if (H.product && L.product && norm(H.product) === norm(L.product)) out.push('heavy and light are the same product');

  const handoff = String(H.handoff || '');
  if (!handoff) out.push('hand-off: write how the tweet before the heavy point ends (the problem, then the product as the answer)');
  else {
    if (H.product && !names(handoff, H.product)) out.push(`hand-off "${handoff.slice(0, 50)}" does not name ${H.product}`);
    if (MID_COLON.test(handoff)) out.push('hand-off has a colon mid-sentence; use a comma');
  }
  if (!Array.isArray(H.risks) || H.risks.length < 3) out.push('criterion: name the three specific risks the "But most" tweet will list');

  const d = String(H.duration || '').trim();
  if (!d) out.push('duration: name how long the persona has taken the heavy product ("two years")');
  else if (!DURATION_RE.test(d)) out.push(`duration "${d}": months or years in words ("eight months", "two years"), never days or weeks`);
  const was = prior[`${account}|${H.asin}`];
  if (d && was && norm(was) !== norm(d)) out.push(`duration "${d}" differs from the "${was}" this page used before for this product; keep "${was}"`);

  const O = P.outline;
  if (O != null) {
    if (!Array.isArray(O) || !O.length) out.push('outline: list every item title in order');
    else {
      // The outline lists every beat in order. The CTA points (at the heavy and light `item`) carry no
      // number (owner 2026-11-22); the list's own items keep theirs, counting 1, 2, 3 past the CTAs.
      const cta = new Set([H.item, L.item].filter(Number.isInteger));
      const st = O.map(styleOf);
      const own = st.map((x, i) => ({ x, i })).filter(({ i }) => !cta.has(i + 1));
      if (own.some(({ x }) => !x)) out.push(`outline item ${own.find(({ x }) => !x).i + 1} is not numbered like the rest`);
      else {
        if (new Set(own.map(({ x }) => x.key)).size > 1) out.push('outline mixes list styles');
        own.forEach(({ x, i }, k) => { if (x.n !== k + 1) out.push(`outline item ${i + 1} is numbered ${x.n}; the list's own items count ${k + 1} here (CTA points are not counted)`); });
      }
      for (const [kind, X] of [['heavy', H], ['light', L]]) {
        if (Number.isInteger(X.item) && X.title && norm(O[X.item - 1]) !== norm(X.title)) out.push(`outline item ${X.item} is not the ${kind} title`);
      }
      O.forEach((t, i) => { if (MID_COLON.test(body(t))) out.push(`outline item ${i + 1} has a colon mid-sentence`); });
    }
  }
  return out;
}

const tweetWithTitle = (T, title) => T.findIndex((t) => norm(firstLine(t)) === norm(title));

/** Findings for a written draft against its approved plan: the points and the hand-off as approved. */
export function planMatchIssues(tweets, plan) {
  const T = (tweets || []).map((t) => String(t ?? ''));
  const out = [];
  const H = plan?.heavy || {}, L = plan?.light || {};
  const h = H.title ? tweetWithTitle(T, H.title) : -1;
  if (H.title && h < 0) out.push(`heavy point title is not "${H.title}" as approved on the brief`);
  const inPoint = (i, X, kind) => {
    if (i < 0) return;
    if (X.mechanism && !norm(T[i]).includes(norm(X.mechanism))) out.push(`${kind} point does not carry the approved mechanism ("${X.mechanism.slice(0, 50)}")`);
    if (X.close && !norm(T[i]).includes(norm(X.close))) out.push(`${kind} point does not end on the approved close ("${X.close.slice(0, 50)}")`);
  };
  inPoint(h, H, 'heavy');
  if (h > 0 && H.handoff) {
    const tail = norm(H.handoff.replace(/^\s*(?:\.\.\.|…)/, ''));
    if (!norm(T[h - 1]).endsWith(tail)) out.push(`the tweet before the heavy point does not end on the approved hand-off ("${H.handoff.slice(0, 60)}")`);
  }
  if (H.duration && !T.some((t) => norm(t).includes(`for ${norm(H.duration)} now`))) out.push(`heavy plug does not say "for ${H.duration} now" as approved`);
  if (L.title) {
    const l = tweetWithTitle(T, L.title);
    if (l < 0) out.push(`light point title is not "${L.title}" as approved on the brief`);
    else if (h >= 0 && l < h) out.push('light point sits before the heavy point');
    inPoint(l, L, 'light');
  }
  return out;
}

/** The "Plug plan" block for the brief, one short block per page. */
export function planMarkdown(plans, issues = {}) {
  const lines = ['## Plug plan', ''];
  for (const [account, P] of Object.entries(plans || {})) {
    const H = P.heavy || {}, L = P.light || {};
    const bad = issues[account] || [];
    lines.push(`**${account}** · ${P.type === 'flip' ? `type flip ${P.flip}` : 'native'}${P.body ? ` · body ${P.body}` : ''}${bad.length ? ` · ✗ ${bad.length} to fix` : ' · ✓'}`);
    lines.push(`- Fit: ${P.fit || '(missing)'}`);
    lines.push(`- Heavy ${H.product || '?'}: "${H.title || '?'}" · hand-off "${H.handoff || '?'}" · risks ${(H.risks || []).join(', ') || '?'} · ${H.duration || '?'}`);
    lines.push(`- Light ${L.product || '?'}: "${L.title || '?'}"`);
    if (Array.isArray(P.outline)) lines.push(`- Outline: ${P.outline.map((t) => t.replace(/\s+/g, ' ')).join(' / ')}`);
    if (P.media) lines.push(`- Media: ${P.media}`);
    for (const b of bad) lines.push(`  - ✗ ${b}`);
    lines.push('');
  }
  return lines.join('\n');
}

export { priorDurations };

export const DEFAULT_LOG = '/mnt/project-files/plug-score/cta-split-2026-11.json';
export function loadPlans(work) {
  const file = path.join(work, 'plug-plan.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function main() {
  const [cmd, work] = process.argv.slice(2);
  const i = process.argv.indexOf('--log');
  const logFile = i > 0 ? process.argv[i + 1] : DEFAULT_LOG;
  if (!['check', 'brief'].includes(cmd) || !work) {
    console.error('usage: node plug-plan.mjs check|brief WORK [--log FILE]');
    process.exit(2);
  }
  const plans = loadPlans(work);
  if (!plans) { console.error(`no ${path.join(work, 'plug-plan.json')}`); process.exit(2); }
  let rows = [];
  try { const j = JSON.parse(fs.readFileSync(logFile, 'utf8')); rows = Array.isArray(j) ? j : j.rows || []; } catch { console.error(`CTA log not read (${logFile}); durations unchecked against earlier threads`); }
  const prior = priorDurations(rows);
  const products = loadProducts();
  const lanes = loadLanes();
  const issues = Object.fromEntries(Object.entries(plans).map(([a, p]) => [a, planIssues(a, p, { prior, products, lanes })]));
  if (cmd === 'brief') { console.log(planMarkdown(plans, issues)); return; }
  let bad = 0;
  for (const [a, is] of Object.entries(issues)) {
    console.log(`${is.length ? '✗' : '✓'} ${a}`);
    for (const m of is) console.log(`    ${m}`);
    if (is.length) bad++;
  }
  console.log(`${Object.keys(issues).length - bad} of ${Object.keys(issues).length} plans clean`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
