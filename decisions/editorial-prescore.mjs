// decisions/editorial-prescore.mjs — the editorial decision (plan Track A, "Editorial review — flagship").
//
// One Jev reading per drafts row. Jev answers the glue.md / thread-craft questions one by one; code
// decides the action and quotes the tweets Jev points at. Jev never emits pass/hold and never writes text.
//
// Owner, 2026-09-23: "Make it a rule that everything related to decision making & gate must be made by
// Jev from now on. Use subagent only for tasks like writing, otherwise Jev got everything covered."
// So laws.json `jev.decisions.editorial-prescore.mode` is `decide`: Jev's verdict IS the drafts gate
// (scripts/run-content-packets.mjs), replacing the fresh-reader subagent. In shadow (an older laws.json)
// decide() returns the incumbent (the subagent's recorded verdict) and logs Jev's beside it.
//
// Verdict rule (plan §1.2 invariant 8):
//   hold           a safety class (Jev's battery OR the banned-topic regex: monotone, Jev can add a block,
//                  never clear one), and, with thresholds.craftHolds, a confident craft failure.
//   review_needed  an answer in the uncertain band, and any sensitive-but-not-banned safety class.
//   pass           otherwise.
// Claim lines (LAW 4b/7) are routing only: first-person to the persona facts, statistics and studies to a
// source check, quotes to a verbatim check, health outcomes to a compliance read. Jev never judges truth,
// so a claim line never changes the action on its own.
//
// Input: { tweets, products, account, ctaDepth, donorHook, sources, editorialVerdict }.
// Positions, roles and counts are computed here in code (gate-thread.mjs plugsAt), never asked of Jev.
import { choice, noul, score } from '../jev.mjs';
import { gateThread } from '../gate-thread.mjs';
import { getAccount } from '../accounts.mjs';
import { bannedTopicIssue, closingTexts, disclaimerTexts, leadingNumbers } from '../checks.mjs';
import { SAFETY_QUESTIONS, plugMap } from '../scripts/run-jev.mjs';
import { LAWS } from '../laws.mjs';

export const name = 'editorial-prescore';
export const ACTIONS = Object.freeze(['pass', 'review_needed', 'hold']);
export const HOLD = 'hold';
export const safety = true;

export const MAX_TWEETS = 40;
export const MAX_LINES = 60;
export const MIN_LINE_CHARS = 12;
/** At most this many questions go in one Jev call; the set is split by group (jev-decide chunkedClient). */
export const MAX_QUESTIONS_PER_CALL = 60;

// The owner's banned subjects and the drug rule hold; the sensitive classes go to the owner as
// review_needed (§6 item 16: sexual behaviour is review_needed, never a block, until the owner rules).
export const HOLD_CLASSES = Object.freeze(['explicit', 'about_cancer', 'rx_drug']);
export const REVIEW_CLASSES = Object.freeze(['sexual_behaviour', 'contrarian_medicine', 'off_brand']);
// Owner, 2026-09-23: "quoting is fine." Classes in laws.json jev.allowedSafetyClasses are still asked
// (the question set is unchanged) but never routed.
export const ALLOWED_CLASSES = Object.freeze([...(LAWS.jev?.allowedSafetyClasses || [])]);

const T = (i) => `T${i + 1}`;
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const URL_ONLY = /^(?:https?:\/\/\S+|\{\{LINK\d*\}\})$/;

function accountOf(key) {
  try { return getAccount(key) || null; } catch { return null; }
}

/**
 * Pure: the thread's roles from its copy. Plug positions come from gateThread's plugsAt (the fleet's
 * own publish gate), or from the {{LINK}} tokens and minted links when the gate cannot run (an unknown
 * account). Returns 0-based indices; stateOf turns them into T# names.
 */
export function rolesOf(input = {}) {
  const tweets = (input.tweets || []).map(String).slice(0, MAX_TWEETS);
  const products = input.products || [];
  const account = accountOf(input.account);
  const n = tweets.length;
  const disclaimers = new Set(account ? disclaimerTexts(account) : []);
  const closings = new Set(account ? closingTexts(account) : []);
  const disclaimer = n && disclaimers.has(tweets[n - 1]) ? n - 1 : null;
  const closingAt = disclaimer != null ? n - 2 : n - 1;
  const closing = closingAt >= 1 && closings.has(tweets[closingAt]) ? closingAt : null;
  const boiler = new Set([disclaimer, closing].filter((x) => x != null));

  let plugsAt = null;
  if (n >= 3) {
    const gate = gateThread({ account: input.account, tweets, products, ctaDepth: input.ctaDepth });
    if (!gate.fatal && Array.isArray(gate.plugsAt)) plugsAt = gate.plugsAt.map((p) => p - 1);
  }
  if (!plugsAt) plugsAt = [...new Set(plugMap(tweets, products).map((p) => p.tweet - 1))];
  const plugs = plugsAt.filter((i) => i >= 1 && !boiler.has(i)).sort((a, b) => a - b);

  // No declared ctaDepth: leave point/bridge unassigned rather than guess. Guessing 3 (the gate
  // assumes 1) put the wrong tweets in those roles, so the pointers named real tweets under wrong jobs.
  const depth = [1, 2, 3].includes(Number(input.ctaDepth)) ? Number(input.ctaDepth) : 1;
  const p1 = plugs[0] ?? null;
  const p2 = plugs[1] ?? null;
  const cta1Bridge = p1 != null && depth >= 3 && p1 - 1 >= 1 ? p1 - 1 : null;
  const cta1Point = p1 != null && depth >= 2 && p1 - (depth - 1) >= 1 ? p1 - (depth - 1) : null;
  const weld = p2 != null && p2 - 1 > p1 ? p2 - 1 : null;
  const lastBody = [...Array(n).keys()].filter((i) => !boiler.has(i)).pop() ?? -1;
  const lastPlug = plugs.length ? plugs[plugs.length - 1] : null;
  const tail = lastPlug == null ? [] : [...Array(n).keys()].filter((i) => i > lastPlug && i <= lastBody);
  const asks = new Set([cta1Point, cta1Bridge, ...plugs].filter((x) => x != null));
  const withoutAsks = [...Array(n).keys()].filter((i) => !asks.has(i) && !boiler.has(i));
  const body = [...Array(n).keys()].filter((i) => i >= 1 && i <= lastBody);
  const steps = body.filter((i) => leadingNumbers(tweets[i]).length > 0);

  // Which product each plug links, so the state names the heavy and the light by label.
  const linked = plugMap(tweets, products.map((p) => ({ ...p, label: flat(p?.label || p?.substance || p?.title || p?.asin).slice(0, 80) })));
  const productRoles = products.map((p, i) => {
    const at = linked.filter((l) => l.product === i).map((l) => l.tweet - 1).sort((a, b) => a - b)[0];
    const slot = at == null ? 'unplugged' : at === p1 ? 'heavy' : at === p2 ? 'light' : 'extra';
    return { slot, label: flat(p?.label || p?.substance || p?.title || p?.asin).slice(0, 80), plug: at ?? null };
  });

  return { tweets, n, plugs, cta1Point, cta1Bridge, cta1Plug: p1, weld, cta2Plug: p2, tail, ending: tail.length ? tail[tail.length - 1] : null,
    closing, disclaimer, withoutAsks, body, steps, lastBody, products: productRoles, depth };
}

/** Pure: the lines the claims pointer reads (boilerplate, link-only and very short lines left out). */
export function linesOf(tweets, roles) {
  const skip = new Set([roles.closing, roles.disclaimer].filter((x) => x != null));
  const out = [];
  tweets.forEach((t, i) => {
    if (skip.has(i)) return;
    for (const raw of String(t).split('\n')) {
      const line = raw.trim();
      if (line.length < MIN_LINE_CHARS || URL_ONLY.test(line)) continue;
      if (out.length < MAX_LINES) out.push({ id: `L${out.length + 1}`, tweet: T(i), text: line });
    }
  });
  return out;
}

/** The state Jev reads. Every position is a name computed here; Jev is never asked to count. */
export function stateOf(input = {}) {
  const r = rolesOf(input);
  if (r.n < 3) throw new Error('editorial-prescore: a thread needs at least three tweets');
  const nm = (i) => (i == null ? null : T(i));
  const tweets = Object.fromEntries(r.tweets.map((t, i) => [T(i), t]));
  return {
    donor_hook: flat(input.donorHook) || null,
    hook: r.tweets[0],
    tweets,
    roles: {
      cta1_point: nm(r.cta1Point), cta1_bridge: nm(r.cta1Bridge), cta1_plug: nm(r.cta1Plug),
      weld: nm(r.weld), cta2_plug: nm(r.cta2Plug), tail: r.tail.map(T), ending: nm(r.ending),
      closing: nm(r.closing), disclaimer: nm(r.disclaimer),
    },
    body: r.body.map(T),
    numbered_steps: r.steps.map(T),
    products: r.products.map((p) => ({ slot: p.slot, label: p.label, plug: nm(p.plug) })),
    tweets_without_asks: Object.fromEntries(r.withoutAsks.map((i) => [T(i), r.tweets[i]])),
    lines: Object.fromEntries(linesOf(r.tweets, r).map((l) => [l.id, { tweet: l.tweet, text: l.text }])),
  };
}

// ---- The questions (lifted from docs/glue.md G1–G6 and its five questions, docs/thread-craft.md,
// docs/cta-spec.md). Keep the wording here, in one place; a wording edit changes the hash and resets
// the decision to shadow (plan invariant 9). Positions are named state keys (`tweets.T5`), never counts.
const SEAM = {
  generic: {
    true: 'It picks up the thought the tweet before it ended on, or opens a new list item that is a natural next step.',
    false: 'It changes subject, or a generic connecting phrase covers a jump to an unrelated thought.' },
  point_bridge: {
    true: 'The point ends on a useful observation or an unresolved choice, and the bridge opens on why that distinction matters.',
    false: 'The bridge restarts a generic sales argument or answers a question the point never raised.' },
  bridge_plug: {
    true: 'The bridge gives a reason to choose, and the plug opens by applying that criterion to its recommendation.',
    false: 'The plug opens on a criterion or benefit the bridge never argued for, or re-diagnoses the problem.' },
  point_plug: {
    true: 'The point makes a relevant need or choice concrete, and the plug opens by answering it with its buying criterion.',
    false: 'The plug answers a need the point never raised.' },
  plug_next: {
    true: 'The ask is finished, and the tweet after the plug opens a substantive list item that resumes the hook’s argument.',
    false: 'The tweet after the plug keeps selling, repeats the plug’s benefits, or is sales setup rather than a real item.' },
  weld_light: {
    true: 'The numbered point ends with a brief hint at, or the name of, the next substance, and the light plug follows directly from it.',
    false: 'The light plug arrives with no hint in the point before it, or after a separate setup that stretches the ask.' },
};

export const EDITORIAL_QUESTIONS = {
  // Q1: every numbered step does something.
  step: (t) => noul(`Does the numbered step in \`tweets.${t}\` do something for the reader, beyond naming or introducing a product?`, {
    true: 'It gives an action, a test, a comparison or a mechanism the reader can use on its own.',
    false: 'It only names or introduces a product, or restates its heading with nothing the reader can use.' }),
  // Q2: each beat follows the previous thought (FOLLOWS) and adds understanding or a next decision (ADDS).
  follows: (a, b, kind) => noul(`Does \`tweets.${b}\` follow from the thought that \`tweets.${a}\` ends on?`, SEAM[kind] || SEAM.generic),
  adds: (a, b) => noul(`Does \`tweets.${b}\` add useful understanding or a next decision beyond what \`tweets.${a}\` already gave?`, {
    true: 'The reader knows or can do something new after it.',
    false: 'It restates, pads, or only postpones the answer.' }),
  repeats: (t) => noul(`Does \`tweets.${t}\` mainly repeat a point, benefit or phrase that an earlier tweet already made?`, {
    true: 'Its substance is already in an earlier tweet, reworded.',
    false: 'It makes a point no earlier tweet made.' }),
  // G3: the CTA entry continues the preceding thought and stays within the hook's promise.
  entry_continues: noul('Does the tweet named by `roles.cta1_point` continue the topic and angle of the tweet just before it?', {
    true: 'It takes the preceding thought further before any product is considered.',
    false: 'It changes subject to set up a sale; connecting words cover the jump.' }),
  entry_in_promise: noul('Does the tweet named by `roles.cta1_point` stay within what `hook` promises the reader?', {
    true: 'It serves the hook’s promise.', false: 'It leaves the hook’s promise to set up a product.' }),
  weld_continues: noul('Does the numbered point named by `roles.weld` resume the thread’s argument with a useful point of its own?', {
    true: 'It is a substantive item that would be worth reading without the light plug after it.',
    false: 'It is mostly sales setup for the next product.' }),
  weld_in_promise: noul('Does the numbered point named by `roles.weld` stay within what `hook` promises the reader?', {
    true: 'It serves the hook’s promise.', false: 'It leaves the hook’s promise to set up a product.' }),
  // Q3a (G2): the point makes the next decision concrete.
  point_concrete: score('Does the point named by `roles.cta1_point` make the reader’s next decision concrete?', [
    'No: it is generic, or it only builds a problem to sell into (an invented deficiency, urgency or penalty).',
    'Partly: it is relevant but leaves the decision vague.',
    'Yes: it gives a useful observation, comparison or practical test that follows from the tweet before it and leaves a real decision for the next beat.' ]),
  // Q3b: the bridge earns the criterion; the plug answers it.
  bridge_distinction: noul('Does the bridge named by `roles.cta1_bridge` explain a specific distinction, shortcut or consequence that bears on the choice?', {
    true: 'It names what distinguishes the options or why a shortcut misleads.', false: 'It is generic, such as be careful what you buy.' }),
  bridge_criterion: noul('Does the buying criterion in the plug named by `roles.cta1_plug` follow from the bridge’s reasoning and resolve the choice the point raised?', {
    true: 'The criterion applies what the bridge argued.', false: 'The criterion appears from nowhere or answers a different choice.' }),
  bridge_repeats_point: noul('Does the bridge named by `roles.cta1_bridge` mostly repeat the point in different words instead of advancing to its application?', {
    true: 'It re-teaches the point’s lesson.', false: 'It builds on the point and moves toward the criterion.' }),
  // Q5 (thread-craft): the ask-free copy.
  ask_free: score('Read only `tweets_without_asks`: if the reader skips both purchases and their setup, does the thread still deliver what `hook` promised?', [
    'No: the promise is paid off only inside the purchase tweets and their setup, or not at all.',
    'Partly: some of the promise is delivered without the purchases.',
    'Yes: a reader who buys nothing still gets the whole promise.' ]),
  // The free tail and the ending.
  tail: (t) => noul(`Does \`tweets.${t}\`, in the free tail after the purchases, deliver a useful point that stands on its own?`, {
    true: 'A reader who bought nothing gets something useful from it.', false: 'It is filler, a recap, a tease, or steers back to the products.' }),
  ending_lands: noul('Does the tweet named by `roles.ending` land: resolve or organize what the thread taught, rather than just stop?', {
    true: 'The reader ends with a clear priority, application or payoff.', false: 'It stops, teases, or repeats a closing question.' }),
  // G1: the pair.
  g1_distinct_jobs: noul('Do the products in `products` do different jobs for the reader, rather than two versions of the same fix?', {
    true: 'Each product answers a different need or step.', false: 'Two products do the same job for the same outcome.' }),
  g1_both_bridged: noul('Do the thread’s own words give the reader a reason for each product in `products`?', {
    true: 'Each product is bridged to by the thread’s argument.', false: 'One product is bolted on with no reason in the thread.' }),
  // LAW 4b/7: the line-level claims pointer. Routing only: Jev classifies, never judges truth.
  claim: (l) => choice(`Which kind of claim does \`lines.${l}\` make?`, {
    first_person: 'The writer claims their own use, habit, experience or result.',
    statistic: 'It states a number as fact: a percentage, a count, a rate or a dose effect.',
    study: 'It cites a study, trial, paper, institution or research finding.',
    quote: 'It quotes a named person or attributes a claim to one.',
    health_outcome: 'It asserts a specific health result from a food, habit or product.',
    none: 'Advice, opinion, a general mechanism, a question or a call to action, with none of the claims above.' }),
};

/** Which call a question rides in: the per-item and per-seam sets are batched together. */
export function groupOf(id) {
  if (/^(follows|adds|repeats)_/.test(id)) return 'seams';
  if (id.startsWith('claim_')) return 'claims';
  if (id.startsWith('step_')) return 'steps';
  return 'thread';
}

function seamKind(a, b, roles) {
  const r = roles;
  if (a === r.cta1_point && b === r.cta1_bridge) return 'point_bridge';
  if (a === r.cta1_bridge && b === r.cta1_plug) return 'bridge_plug';
  if (a === r.cta1_point && b === r.cta1_plug) return 'point_plug';
  if (a === r.weld && b === r.cta2_plug) return 'weld_light';
  if (a === r.cta1_plug) return 'plug_next';
  return 'generic';
}

/** The seams read: every adjacent pair from the hook to the last body tweet. */
export function seamsOf(state) {
  const seq = ['T1', ...state.body];
  return seq.slice(1).map((b, i) => ({ a: seq[i], b, kind: seamKind(seq[i], b, state.roles) }));
}

/** Dynamic set, built from the state alone. */
export function questions(state) {
  const Q = EDITORIAL_QUESTIONS;
  const r = state.roles;
  const plugs = new Set([r.cta1_plug, r.cta2_plug, ...state.products.map((p) => p.plug)].filter(Boolean));
  const q = {};
  for (const [key, question] of Object.entries(SAFETY_QUESTIONS)) q[`safety_${key}`] = question;
  if (r.cta1_point) { q.entry_continues = Q.entry_continues; q.entry_in_promise = Q.entry_in_promise; q.point_concrete = Q.point_concrete; }
  if (r.cta1_bridge) { q.bridge_distinction = Q.bridge_distinction; q.bridge_criterion = Q.bridge_criterion; q.bridge_repeats_point = Q.bridge_repeats_point; }
  if (r.weld) { q.weld_continues = Q.weld_continues; q.weld_in_promise = Q.weld_in_promise; }
  if (r.cta1_plug) q.ask_free = Q.ask_free;
  if (state.products.filter((p) => p.plug).length >= 2) { q.g1_distinct_jobs = Q.g1_distinct_jobs; q.g1_both_bridged = Q.g1_both_bridged; }
  for (const t of r.tail) q[`tail_${t}`] = Q.tail(t);
  if (r.ending) q.ending_lands = Q.ending_lands;
  for (const t of state.numbered_steps) q[`step_${t}`] = Q.step(t);
  for (const { a, b, kind } of seamsOf(state)) {
    q[`follows_${b}`] = Q.follows(a, b, kind);
    q[`adds_${b}`] = Q.adds(a, b);
  }
  // Plugs are templated by design (the CTA skeleton system), so they are never asked about repeating.
  for (const t of state.body.slice(1)) if (!plugs.has(t)) q[`repeats_${t}`] = Q.repeats(t);
  for (const l of Object.keys(state.lines)) q[`claim_${l}`] = Q.claim(l);
  return q;
}

// The template the hash lock covers: one of every question and every seam kind.
const TEMPLATE_STATE = {
  donor_hook: '{donor_hook}', hook: '{hook}',
  tweets: {}, roles: { cta1_point: 'T3', cta1_bridge: 'T4', cta1_plug: 'T5', weld: 'T6', cta2_plug: 'T7', tail: ['T8'], ending: 'T8', closing: null, disclaimer: null },
  body: ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'], numbered_steps: ['T2'],
  products: [{ slot: 'heavy', label: '{heavy}', plug: 'T5' }, { slot: 'light', label: '{light}', plug: 'T7' }],
  tweets_without_asks: {}, lines: { L1: { tweet: 'T2', text: '{line}' } },
};
export const QUESTION_TEMPLATE = Object.freeze({ ...questions(TEMPLATE_STATE), point_plug_seam: EDITORIAL_QUESTIONS.follows('T3', 'T4', 'point_plug') });

// ---- Policy -------------------------------------------------------------------------------------------

const CLAIM_ROUTE = {
  first_person: 'check against the persona facts', statistic: 'needs a named source', study: 'needs a named source',
  quote: 'verify the quote verbatim', health_outcome: 'compliance read',
};
const REQUIRED = ['safetyHoldAt', 'safetyReviewAt', 'craftLow', 'craftHigh', 'scoreLow', 'scoreReview', 'confidenceFloor', 'claimConfidence'];

/**
 * Pure. thresholds = laws.json `jev.decisions.editorial-prescore.thresholds`. Returns
 * { action, confidence, reasons, pointers, claims }: each pointer names the tweet Jev pointed at and
 * quotes it from the state, so the evidence is in the copy by construction.
 */
export function policy(answers, thresholds, { input, state } = {}) {
  for (const k of REQUIRED) if (!Number.isFinite(thresholds?.[k])) throw new Error(`editorial-prescore: thresholds.${k} is required`);
  const th = thresholds;
  const st = state || stateOf(input);
  const quote = (t) => (t && st.tweets[t] != null ? ` "${flat(st.tweets[t]).slice(0, 80)}"` : '');
  const pointers = [];
  const certainties = [];
  const add = (p) => pointers.push(p);

  // Safety: Jev's battery OR the banned-topic regex. Hold classes hold; the rest go to the owner.
  for (const key of Object.keys(SAFETY_QUESTIONS)) {
    if (ALLOWED_CLASSES.includes(key)) continue;
    const y = answers[`safety_${key}`]?.noul;
    if (!Number.isFinite(y)) continue;
    const label = key.replace(/_/g, ' ');
    if (HOLD_CLASSES.includes(key) && y >= th.safetyHoldAt) add({ kind: 'safety', level: 'hold', key, p: y, note: `${label} (${y.toFixed(2)})` });
    else if (y >= th.safetyReviewAt) add({ kind: 'safety', level: 'review', key, p: y, note: `${label} (${y.toFixed(2)})` });
    else if (y >= th.craftLow && y < th.safetyReviewAt) add({ kind: 'safety', level: 'uncertain', key, p: y, note: `${label} uncertain (${y.toFixed(2)})` });
  }
  const tweets = Object.values(st.tweets);
  const banned = bannedTopicIssue(tweets);
  if (banned) add({ kind: 'safety', level: 'hold', key: 'banned_topic_regex', p: 1, note: `banned topic (regex): ${banned.slice(0, 120)}` });

  // Craft: a noul that should be high (bad when low) or should be low (bad when high).
  const good = (id, tweet, what) => {
    const y = answers[id]?.noul;
    if (!Number.isFinite(y)) return;
    certainties.push(Math.abs(y - 0.5) * 2);
    if (y < th.craftLow) add({ kind: 'craft', level: 'review', id, tweet, p: y, note: `${tweet ? `${tweet}: ` : ''}${what} (${y.toFixed(2)})${quote(tweet)}` });
    else if (y < th.craftHigh) add({ kind: 'craft', level: 'uncertain', id, tweet, p: y, note: `${tweet ? `${tweet}: ` : ''}${what}, uncertain (${y.toFixed(2)})${quote(tweet)}` });
  };
  const bad = (id, tweet, what) => {
    const y = answers[id]?.noul;
    if (!Number.isFinite(y)) return;
    certainties.push(Math.abs(y - 0.5) * 2);
    if (y >= th.craftHigh) add({ kind: 'craft', level: 'review', id, tweet, p: y, note: `${tweet}: ${what} (${y.toFixed(2)})${quote(tweet)}` });
    else if (y >= th.craftLow) add({ kind: 'craft', level: 'uncertain', id, tweet, p: y, note: `${tweet}: ${what}, uncertain (${y.toFixed(2)})${quote(tweet)}` });
  };
  const scored = (id, tweet, what) => {
    const a = answers[id];
    if (!Number.isFinite(a?.score)) return;
    const lowConf = Number.isFinite(a.confidence) && a.confidence < th.confidenceFloor;
    // Below the confidence floor a low score is uncertain, never a finding: with craftHolds on, a 'review'
    // level holds the row, and Jev saying it is not sure must not hold anything (mock run: 0.70 of 2 at
    // confidence 0.00 held a clean row).
    const level = a.score < th.scoreLow && !lowConf ? 'review' : a.score < th.scoreReview || lowConf ? 'uncertain' : null;
    if (level) add({ kind: 'craft', level, id, tweet, p: a.score, note: `${tweet ? `${tweet}: ` : ''}${what} (${a.score.toFixed(2)} of 2${lowConf ? `, confidence ${a.confidence.toFixed(2)}` : ''})${quote(tweet)}` });
  };
  const r = st.roles;
  for (const t of st.numbered_steps) good(`step_${t}`, t, 'numbered step may only name a product (Q1)');
  for (const { a, b } of seamsOf(st)) {
    good(`follows_${b}`, b, `${a} → ${b} may not follow (Q2 seam)`);
    good(`adds_${b}`, b, `may add nothing beyond ${a} (Q2)`);
    bad(`repeats_${b}`, b, 'repeats an earlier tweet (Q2)');
  }
  good('entry_continues', r.cta1_point, 'CTA entry may change the subject (G3)');
  good('entry_in_promise', r.cta1_point, 'CTA entry may leave the hook’s promise (G3)');
  good('weld_continues', r.weld, 'the weld may be sales setup, not a point (G4)');
  good('weld_in_promise', r.weld, 'the weld may leave the hook’s promise (G3)');
  scored('point_concrete', r.cta1_point, 'the point may not make the decision concrete (Q3a)');
  good('bridge_distinction', r.cta1_bridge, 'the bridge may not earn a distinction (Q3b)');
  good('bridge_criterion', r.cta1_plug, 'the criterion may not follow from the bridge (Q3b)');
  bad('bridge_repeats_point', r.cta1_bridge, 'the bridge repeats the point (Q3b)');
  scored('ask_free', null, 'a reader who skips both purchases may not get the hook’s promise (Q5)');
  // Owner, 2026-09-23: "keep the sign off pls." A short closing question to the reader (the house
  // sign-off: "Be honest, which of the five would you drop first?") is not asked to stand alone or to
  // resolve the thread. laws.json jev.signOffMaxChars bounds it; a link makes it an ask, not a sign-off.
  const signOff = (t) => {
    const x = flat(st.tweets[t] ?? '');
    return t === r.ending && /\?$/.test(x) && x.length <= (LAWS.jev?.signOffMaxChars ?? 0) && !/https?:\/\/|\{\{LINK/.test(x);
  };
  for (const t of r.tail) if (!signOff(t)) good(`tail_${t}`, t, 'tail tweet may not stand on its own');
  if (!signOff(r.ending)) good('ending_lands', r.ending, 'the ending may not land');
  // ONE PRODUCT LINKED TWICE is one decision, not two (the 21kg harvest body, R2026-09-27: its two plugs
  // carry the same ASIN, so "two products doing the same job" was true by construction and held three rows
  // the owner then released, "1 do a override jev"). G1 judges two DIFFERENT products only.
  const asins = (input?.products || []).map((p) => flat(p?.asin)).filter(Boolean);
  if (!(asins.length >= 2 && new Set(asins).size === 1)) {
    good('g1_distinct_jobs', null, 'the two products may do the same job (G1)');
    good('g1_both_bridged', null, 'a product may be bolted on (G1)');
  }

  // Claims: routing only (never an action on their own).
  const sourced = new Set((input?.sources || []).filter((s) => flat(s?.source)).map((s) => `T${Number(s.tweet)}`));
  const claims = [];
  for (const [l, line] of Object.entries(st.lines || {})) {
    const a = answers[`claim_${l}`];
    if (!a || typeof a.choice !== 'string' || a.choice === 'none') continue;
    if (Number.isFinite(a.confidence) && a.confidence < th.claimConfidence) continue;
    const route = CLAIM_ROUTE[a.choice] || 'check';
    claims.push({ line: l, tweet: line.tweet, kind: a.choice, p: a.confidence ?? null,
      note: `${line.tweet} ${l} ${a.choice.replace(/_/g, ' ')}: ${route}${sourced.has(line.tweet) && /source/.test(route) ? ' (a source is recorded)' : ''} "${flat(line.text).slice(0, 80)}"` });
  }

  // Owner, 2026-09-23: "everything related to decision making & gate must be made by Jev". With
  // thresholds.craftHolds on (laws.json), a confident craft failure holds the row, as the fresh-reader
  // subagent's verdict did; an uncertain answer still goes to the owner as review_needed.
  if (th.craftHolds === true) for (const p of pointers) if (p.kind === 'craft' && p.level === 'review') p.level = 'hold';
  const holds = pointers.filter((p) => p.level === 'hold');
  const reviews = pointers.filter((p) => p.level !== 'hold');
  const action = holds.length ? 'hold' : reviews.length ? 'review_needed' : 'pass';
  const strength = (p) => (p.kind === 'safety' ? p.p : Math.abs(p.p - 0.5) * 2);
  const confidence = holds.length ? Math.max(...holds.map((p) => p.p))
    : reviews.length ? Math.max(...reviews.filter((p) => p.level === 'review').map(strength), 0)
      : certainties.length ? Math.min(...certainties) : null;
  const reasons = [...new Set(pointers.map((p) => p.key || p.id?.replace(/_T\d+$/, '')))];
  return { action, confidence: confidence == null ? null : +Math.min(1, confidence).toFixed(6), reasons, pointers, claims };
}

/** The incumbent is the fresh-reader subagent's recorded verdict when there is one, else pass. Once the
 *  decision acts (mode decide), Jev's verdict is the gate and this is only logged beside it. */
export function incumbent(input = {}) {
  return { action: input.editorialVerdict === 'hold' ? 'hold' : 'pass' };
}
