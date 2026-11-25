// decisions/aie-rewrite.mjs — did the paraphrase keep the post's facts? (Owner, 2026-09-24: wire Jev into
// ai-evo-weekly.) Every AI Evolution post is a model's slight paraphrase of a viral original. Code
// checks the rewrite's shape (length, quotes verbatim, no 7-word run copied, emoji, links, hashtags,
// hype words) and nothing about its meaning: a changed number, a swapped company or an invented claim
// passes every one of those checks and ships scheduled under the page's name.
//
//   code   the shape checks (ai-evo-weekly.mjs rewriteIssues)
//   Jev    reads original against rewrite: does the rewrite keep every fact, number, name and claim,
//          and does it add one the original does not make?
//   code   holds the rewrite when it drops or changes facts (keepsAt) or adds one (addsAt). A held
//          rewrite gets the one retry with the reason, then the row is skipped and the next candidate
//          takes the slot, exactly as a rewrite that fails the shape checks. Unread: the shape checks
//          stand, as before.
//
// Input: { original, rewrite }.
import { noul } from '../jev.mjs';

export const name = 'aie-rewrite';
export const ACTIONS = Object.freeze(['ship', 'hold']);
export const HOLD = 'hold';
// Monotone: Jev can hold a rewrite, never pass one the shape checks refused (it is only asked after
// they pass). A wrong hold costs one retry or one backlog row; a wrong pass ships a distorted post.
export const safety = true;
const MAX_CHARS = 2500;
const clip = (v) => String(v ?? '').trim().slice(0, MAX_CHARS);

export function stateOf(input = {}) {
  const original = clip(input.original), rewrite = clip(input.rewrite);
  if (!original || !rewrite) throw new Error('aie-rewrite: original and rewrite are required');
  return { original, rewrite };
}

export const QUESTIONS = Object.freeze({
  keeps_facts: noul('Does `rewrite` keep every fact, number, name and claim that `original` states, with none changed, reversed or dropped?', {
    true: 'Every number, name, date, company, product and claim in the original is in the rewrite and means the same thing; only the wording differs.',
    false: 'A number, name, date, company, product or claim from the original is missing, changed, reversed or made stronger or weaker in the rewrite.',
  }),
  adds_claim: noul('Does `rewrite` state a fact, number, name, claim or quote that `original` does not?', {
    true: 'The rewrite contains something the original never says: a new figure, a new name, a new claim, a new quote or a conclusion the original does not draw.',
    false: 'Everything the rewrite states is already in the original; it only rephrases.',
  }),
});

/** The code's answer today: the shape checks passed, so it ships. */
export async function incumbent() {
  return { action: 'ship' };
}

/**
 * Pure. thresholds: { keepsAt, addsAt }. Hold when keeps_facts < keepsAt or adds_claim ≥ addsAt, with
 * the reasons. Confidence is the margin: a hold's strongest violation, a ship's weakest pass.
 */
export function policy(answers, thresholds) {
  const { keepsAt, addsAt } = thresholds || {};
  if (!Number.isFinite(keepsAt) || !Number.isFinite(addsAt)) throw new Error('aie-rewrite: thresholds.keepsAt and addsAt are required');
  const keeps = answers?.keeps_facts?.noul, adds = answers?.adds_claim?.noul;
  if (!Number.isFinite(keeps) || !Number.isFinite(adds)) throw new Error('aie-rewrite: no answers');
  const reasons = [];
  if (keeps < keepsAt) reasons.push('the rewrite changed or dropped a fact, number, name or claim from the original');
  if (adds >= addsAt) reasons.push('the rewrite states something the original does not');
  if (reasons.length) return { action: 'hold', confidence: +Math.max(keeps < keepsAt ? 1 - keeps : 0, adds >= addsAt ? adds : 0).toFixed(4), reasons, keeps, adds };
  return { action: 'ship', confidence: +Math.min(keeps, 1 - adds).toFixed(4), reasons, keeps, adds };
}
