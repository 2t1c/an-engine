// decisions/plug-anchor.mjs — after which tweet does this product's plug read as the natural next step?
// (plan A2 "Plug insertion anchor" + W1 "skeleton before words"; owner, 2026-09-23: "implement: 2,3,4, 6 first".)
//
// pod-place.mjs placePods computes the LEGAL fresh-insert positions (plugSlots: non-adjacent, clear of
// the donor's funnel tail) and picks the one nearest tweet 3. The off-by-one that shipped the criterion
// after the plug in 20 of 26 threads came from choosing a position by number rather than by what the
// tweet before it says. Jev reads the tweet before each legal position; scripts/row-skeleton.mjs takes
// the earliest one Jev anchors. Jev never adds a position the code did not compute.
//
// Input: { hook, before, product: { title, criterion? } }.
import { noul } from '../jev.mjs';

export const name = 'plug-anchor';
export const ACTIONS = Object.freeze(['anchor', 'skip']);
export const HOLD = 'skip';
export const safety = false;

export const QUESTIONS = {
  raises_need: noul('Does `before` leave the reader with a need, a problem or a question that `product` answers?', {
    true: 'The reader has just met a problem or a goal that this product is a direct answer to.',
    false: 'Nothing in it makes this product the answer; a product tweet here would change the subject.' }),
  natural_next: noul('Would a tweet about `product` read as the natural next step after `before`, inside what `hook` promised?', {
    true: 'It continues the same subject and stays inside the hook\'s promise.',
    false: 'It would interrupt the thread or leave the hook\'s promise.' }),
};

const clip = (x, n = 600) => String(x ?? '').trim().slice(0, n);

export function stateOf(input = {}) {
  const before = clip(input.before), title = clip(input.product?.title, 200);
  if (!before) throw new Error('plug-anchor: no tweet before the position');
  if (!title) throw new Error('plug-anchor: no product');
  return { hook: clip(input.hook), before, product: { title, what_to_look_for: clip(input.product?.criterion, 300) } };
}

/** The code's answer: placePods' nearest-to-tweet-3 pick (input.codeSpot === input.spot). */
export async function incumbent(input = {}) {
  return { action: input.codeSpot != null && input.codeSpot === input.spot ? 'anchor' : 'skip' };
}

/** Pure. thresholds: { anchorAt }. fit is the mean of the two nouls; anchor at anchorAt or above. */
export function policy(answers, thresholds) {
  const at = thresholds?.anchorAt;
  if (!Number.isFinite(at)) throw new Error('plug-anchor: thresholds.anchorAt is required');
  const r = answers?.raises_need?.noul, n = answers?.natural_next?.noul;
  if (!Number.isFinite(r) || !Number.isFinite(n)) throw new Error('plug-anchor: no answers');
  const fit = (r + n) / 2;
  return { action: fit >= at ? 'anchor' : 'skip', confidence: +(fit >= at ? fit : 1 - fit).toFixed(4), fit: +fit.toFixed(4) };
}
