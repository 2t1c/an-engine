// decisions/cta-depth.mjs — how much of the plug does the creator's own run-up already carry?
// (plan A2 "CTA depth 1/2/3"; W1 "skeleton before words"; owner, 2026-09-23.)
//
// On a donor slot (the creator's own ask, which we replace), pod-place.mjs depthFor reads the three
// tweets before it: names the substance AND hands a buying criterion -> 1 tweet (CTA only); names it
// only -> 2 (bridge + plug); cold -> 2. It finds the criterion with looksLikeCriterion, a word test.
// Jev reads the run-up; the mapping to 1/2 stays code (depthFor's own table).
//
// Input: { runUp: [tweet], product: { title } }.
import { noul } from '../jev.mjs';

export const name = 'cta-depth';
export const ACTIONS = Object.freeze(['1', '2']);
export const HOLD = '2';
export const safety = false;

export const QUESTIONS = {
  names_product: noul('Does `run_up` name the substance in `product` by name?', {
    true: 'The substance is named in these tweets.',
    false: 'The substance is not named, or only its effect is described.' }),
  gives_criterion: noul('Does `run_up` tell the reader what to look for when buying that substance: a form, a dose, a standard, or what separates a good version from a bad one?', {
    true: 'The reader already knows how to choose a good version.',
    false: 'No buying criterion is given.' }),
};

export function stateOf(input = {}) {
  const runUp = (Array.isArray(input.runUp) ? input.runUp : []).map((t) => String(t ?? '').slice(0, 500)).filter(Boolean);
  const title = String(input.product?.title ?? '').trim().slice(0, 200);
  if (!runUp.length) throw new Error('cta-depth: no run-up');
  if (!title) throw new Error('cta-depth: no product');
  return { run_up: runUp, product: title };
}

/** The code's answer: depthFor's depth, passed in as input.codeDepth. */
export async function incumbent(input = {}) {
  return { action: String(input.codeDepth === 1 ? 1 : 2) };
}

/** Pure. thresholds: { namesAt, criterionAt }. Depth 1 only when both are read as present. */
export function policy(answers, thresholds) {
  const n = answers?.names_product?.noul, c = answers?.gives_criterion?.noul;
  if (!Number.isFinite(thresholds?.namesAt) || !Number.isFinite(thresholds?.criterionAt)) throw new Error('cta-depth: thresholds.namesAt and criterionAt are required');
  if (!Number.isFinite(n) || !Number.isFinite(c)) throw new Error('cta-depth: no answers');
  const one = n >= thresholds.namesAt && c >= thresholds.criterionAt;
  return {
    action: one ? '1' : '2', confidence: +(one ? Math.min(n, c) : Math.max(1 - n, 1 - c)).toFixed(4),
    why: one ? 'their run-up names the substance and hands a buying criterion: CTA only' : n >= thresholds.namesAt ? 'their run-up names the substance but gives no buying criterion: bridge + plug' : 'their run-up never names the substance: bridge + plug',
  };
}
