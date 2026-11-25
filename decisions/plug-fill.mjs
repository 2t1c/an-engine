// decisions/plug-fill.mjs — which product does a [LINK] placeholder sell? (Owner, 2026-09-24: wire Jev
// into automint.) The automint lane fills a draft's [LINK] with a freshly minted link. Code walks back
// from the plug to the first tweet naming a substance and keeps the sellable products for it (the
// curated menu, never DENY, pod-covered, never a proven loser, not already used in this draft); until
// now the highest-EPC one simply won. That is a keyword match: the same substance can come in the
// wrong form, dose or brand for what the words say, and a word in the lead-in can pull in a product
// the plug never recommends (the nitric-oxide thread that shipped selling magnesium).
//
//   code   builds the shortlist (resolveSlot in automint.mjs), highest EPC first
//   Jev    reads the plug tweet and its lead-in against each candidate: is this a product the text
//          recommends, with nothing it says about it untrue?
//   code   fills with the candidate Jev reads highest, at matchAt or above; none clears -> `decline`,
//          and automint mints nothing and tags the draft mint-failed, exactly as for an unresolved
//          slot. Unread (no key, breaker, error) -> the incumbent: the highest-EPC candidate, as before.
//
// Input: { plug, leadIn?, candidates: [{ asin, title }] }. The words are never changed.
import { noul } from '../jev.mjs';

export const name = 'plug-fill';
export const ACTIONS = Object.freeze(['fill', 'decline']);
export const HOLD = 'decline';
export const safety = false;
export const MAX_CANDIDATES = 6;
const MAX_CHARS = 1500;
const clip = (v) => String(v ?? '').trim().slice(0, MAX_CHARS);

export function stateOf(input = {}) {
  const plug = clip(input.plug);
  if (!plug) throw new Error('plug-fill: no plug tweet');
  if (!input.candidates?.length) throw new Error('plug-fill: no candidates');
  return { plug, lead_in: clip(input.leadIn) };
}

// Dynamic set: one noul per candidate. The hash lock covers the wording through the template.
export function questions(_state, input = {}) {
  const out = {};
  (input.candidates || []).slice(0, MAX_CANDIDATES).forEach((c, i) => {
    out[`matches_${i}`] = noul(`The [LINK] in \`plug\` will point to this product: ${clip(c.title)}. Is it a product \`plug\` and \`lead_in\` recommend, with nothing they say about it untrue?`, {
      true: 'The text recommends this kind of product, and every brand, product name, form, dose, strength or count it gives for the recommended product holds for this one.',
      false: 'The text recommends something else, or names a different brand, product name, form, dose, strength or count than this product has, so the link would sell the reader the wrong thing.',
    });
  });
  return out;
}
export const QUESTION_TEMPLATE = questions(null, { candidates: [{ title: '{candidate title}' }] });

/** The code's answer today: the first candidate (highest realised EPC). */
export async function incumbent(input = {}) {
  const first = input.candidates?.[0];
  return first ? { action: 'fill', asin: first.asin } : { action: 'decline' };
}

/**
 * Pure. thresholds: { matchAt }. The highest-reading candidate at matchAt or above; ties keep the
 * code's order (highest EPC first). A decline's confidence is 1 − the best reading, so only a clear
 * "none of these" beats the incumbent at the confidence floor. Returns { action, asin, confidence, readings }.
 */
export function policy(answers, thresholds, { input } = {}) {
  const matchAt = thresholds?.matchAt;
  if (!Number.isFinite(matchAt)) throw new Error('plug-fill: thresholds.matchAt is required');
  const candidates = (input?.candidates || []).slice(0, MAX_CANDIDATES);
  const readings = candidates.map((c, i) => ({ asin: c.asin, noul: answers?.[`matches_${i}`]?.noul }));
  if (!readings.some((r) => Number.isFinite(r.noul))) throw new Error('plug-fill: no answers');
  let best = null;
  for (const r of readings) if (Number.isFinite(r.noul) && r.noul >= matchAt && (!best || r.noul > best.noul)) best = r;
  if (!best) {
    const top = Math.max(0, ...readings.map((r) => (Number.isFinite(r.noul) ? r.noul : 0)));
    return { action: 'decline', asin: null, confidence: +(1 - top).toFixed(4), readings };
  }
  return { action: 'fill', asin: best.asin, confidence: +best.noul.toFixed(4), readings };
}
