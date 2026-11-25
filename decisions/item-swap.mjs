// decisions/item-swap.mjs — may this numbered item give its seat to the product's pod?
// (plan A2 "Item-swap target"; W1 "skeleton before words"; owner, 2026-09-23.)
//
// In a listicle, placePods swaps one whole numbered item for the pod (1-for-1, every number kept).
// itemSwapCandidates ranks the legal items by words: names the substance (1), a BRIDGE hit (2), or
// "no topical tie — writer's choice" (3). A word match cannot tell an item the list is ABOUT from one
// that happens to name the substance, and rank 3 swaps an item nothing ties to the product. Jev reads
// each legal item; scripts/row-skeleton.mjs swaps the one that best argues the product and is not
// essential, or inserts instead when none does. Jev never swaps an item the code did not offer.
//
// Input: { hook, item, product: { title } }.
import { noul } from '../jev.mjs';

export const name = 'item-swap';
export const ACTIONS = Object.freeze(['swap', 'keep']);
export const HOLD = 'keep';
export const safety = false;

export const QUESTIONS = {
  argues_product: noul('Is `item` about `product` or about the exact need `product` answers, so the product could take its place in the list?', {
    true: 'The item already talks about this substance or the need it answers.',
    false: 'The item is about something else.' }),
  essential: noul('Is `item` one the list cannot lose: the example `hook` names, or the item the whole list builds to?', {
    true: 'Removing it would break what the hook promised.',
    false: 'The list keeps its promise without this exact item.' }),
};

const clip = (x, n = 600) => String(x ?? '').trim().slice(0, n);

export function stateOf(input = {}) {
  const item = clip(input.item), title = clip(input.product?.title, 200);
  if (!item) throw new Error('item-swap: no item');
  if (!title) throw new Error('item-swap: no product');
  return { hook: clip(input.hook), item, product: title };
}

/** The code's answer: itemSwapCandidates rank 1-2 swaps; rank 3 is "writer's choice". */
export async function incumbent(input = {}) {
  return { action: Number(input.rank) <= 2 ? 'swap' : 'keep' };
}

/** Pure. thresholds: { arguesAt, essentialAt }. swap when it argues the product and is not essential. */
export function policy(answers, thresholds) {
  const a = answers?.argues_product?.noul, e = answers?.essential?.noul;
  if (!Number.isFinite(thresholds?.arguesAt) || !Number.isFinite(thresholds?.essentialAt)) throw new Error('item-swap: thresholds.arguesAt and essentialAt are required');
  if (!Number.isFinite(a) || !Number.isFinite(e)) throw new Error('item-swap: no answers');
  const swap = a >= thresholds.arguesAt && e < thresholds.essentialAt;
  return { action: swap ? 'swap' : 'keep', confidence: +(swap ? Math.min(a, 1 - e) : Math.max(1 - a, e)).toFixed(4), argues: +a.toFixed(4) };
}
