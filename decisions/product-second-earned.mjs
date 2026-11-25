// decisions/product-second-earned.mjs — plan Track C / A3 "Products": is the SECOND product (the light
// placement) earned? Two nouls, both lifted from docs/glue.md LAW G1 ("Never: two products doing the same
// job ... or a second product the thread's own words never bridge to"):
//   second_supported  the donor (and the second product's bridge line, when one is written) honestly
//                     supports recommending the second product;
//   same_decision     the reader's need for the first and the need for the second are the same decision.
//
// SHADOW (laws.json `jev.decisions.product-second-earned.mode`): report-only at the products stop. The
// incumbent is today's only code check on the pair, product-allocation.mjs's "heavy and light CTA needs
// are identical" (a case-insensitive string match), so decide() returns that action and logs Jev's
// reading beside it. Nothing here changes a pick, a status or an approval.
//
// Input: { donorText, products: [first, second] (catalog rows: asin/title/category), needs?: [a, b],
//          bridges?: [lineA, lineB] }. State: the donor and both products by substance label, plus the
// needs and bridge lines only when present. Actions: `keep` (the second is earned) or `flag`.
import { candidateLabel } from '../product-fit.mjs';
import { noul } from '../jev.mjs';

export const name = 'product-second-earned';
export const ACTIONS = Object.freeze(['keep', 'flag']);
export const safety = false;
export const STATE_MAX_CHARS = 20000; // as product-fit.mjs: well inside jev-1.13's state budget
const LINE_MAX_CHARS = 400;

// The reviewable set. Static: the products are named in the state, so a new pair never changes the hash.
export const QUESTIONS = Object.freeze({
  second_supported: noul('Does the thread in `donor` (read with `second_bridge` when it is given) honestly support recommending `second_product` to its reader, beside `first_product`?', {
    true: 'The donor argues for `second_product` or its substance, or explains how it helps with the problem the thread is about, or `second_bridge` connects it to a point the donor itself makes.',
    false: '`second_product` is not argued by the donor, is only named in passing or in a list, or the bridge invents a need or a dependency the donor never raises.',
  }),
  same_decision: noul('Are the reader\'s reason to buy `first_product` and reason to buy `second_product` the same decision (use `first_need` and `second_need` when they are given)?', {
    true: 'Both products do the same job for the same outcome, for example two forms of magnesium for sleep, so a reader who buys one has no separate reason to buy the other.',
    false: 'Each product answers a different need or a different lever that serves the thread\'s promise, so the reader makes two separate decisions.',
  }),
});

const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/** Throws without a donor or without two products: there is no second to judge (decide(): not read). */
export function stateOf(input = {}) {
  const donor = clip(input.donorText, STATE_MAX_CHARS);
  const [first, second] = input.products || [];
  if (!donor) throw new Error('product-second-earned: no donor text');
  if (!first?.asin || !second?.asin) throw new Error('product-second-earned: two products are required');
  const state = { donor, first_product: candidateLabel(first), second_product: candidateLabel(second) };
  const [needA, needB] = input.needs || [];
  const [bridgeA, bridgeB] = input.bridges || [];
  if (clip(needA, LINE_MAX_CHARS)) state.first_need = clip(needA, LINE_MAX_CHARS);
  if (clip(needB, LINE_MAX_CHARS)) state.second_need = clip(needB, LINE_MAX_CHARS);
  if (clip(bridgeA, LINE_MAX_CHARS)) state.first_bridge = clip(bridgeA, LINE_MAX_CHARS);
  if (clip(bridgeB, LINE_MAX_CHARS)) state.second_bridge = clip(bridgeB, LINE_MAX_CHARS);
  return state;
}

/**
 * Pure. thresholds = laws.json `jev.decisions.product-second-earned.thresholds` ({ supported, same }).
 * Flags `second_unsupported` when second_supported < supported, `same_decision` when same_decision >=
 * same. Confidence as product-fit-heavy: a flag is as sure as its strongest trigger, a keep only as sure
 * as its weakest check, each scaled by its distance from the threshold.
 */
export function policy(answers, thresholds) {
  const { supported, same } = thresholds;
  if (!Number.isFinite(supported) || !Number.isFinite(same)) throw new Error('product-second-earned: thresholds.supported and thresholds.same are required');
  const s = answers.second_supported?.noul;
  const d = answers.same_decision?.noul;
  if (!Number.isFinite(s) || !Number.isFinite(d)) throw new Error('product-second-earned: both nouls are required');
  const dist = (x, t) => (x < t ? (t - x) / Math.max(t, 1e-9) : (x - t) / Math.max(1 - t, 1e-9));
  const checks = [
    { reason: 'second_unsupported', fires: s < supported, strength: dist(s, supported) },
    { reason: 'same_decision', fires: d >= same, strength: dist(d, same) },
  ];
  const fired = checks.filter((c) => c.fires);
  const confidence = fired.length ? Math.max(...fired.map((c) => c.strength)) : Math.min(...checks.map((c) => c.strength));
  return { action: fired.length ? 'flag' : 'keep', confidence: Math.min(1, +confidence.toFixed(6)), reasons: fired.map((c) => c.reason),
    supported: s, sameDecision: d };
}

/** Today's code: product-allocation.mjs flags a pair whose two CTA needs are the identical string. */
export function incumbent(input = {}) {
  const [a, b] = (input.needs || []).map((n) => String(n ?? '').trim().toLowerCase());
  return { action: a && b && a === b ? 'flag' : 'keep' };
}
