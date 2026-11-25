// decisions/plug-replacement.mjs — a scheduled thread's product died: which product can take its link
// without the plug saying anything untrue? (Owner, 2026-09-24: "A scheduled thread's product dies —
// Jev picks a replacement product that fits what the thread argues, so it can stay on schedule.")
//
// link-sentinel.mjs first re-mints the SAME product; this decision runs only when that fails (the
// product itself is dead: the fresh link also falls back to a non-product page). The plug tweet names
// its product in words ("Nutricost's gives 600mg a serving", "Sports Research's EPA and DHA add up to
// 950mg"), and only the link is swapped, never the words. So a replacement is honest only when every
// claim the plug makes about the product it recommends is true of the replacement.
//
//   code   shortlists candidates: the curated menu (KEEP ∪ allow), never DENY, never the dead ASIN,
//          sharing a substance with the dead product; same brand first
//   Jev    reads the plug tweet (and the tweet before it) against each candidate's title: does
//          everything the plug says about the product it recommends hold for this one?
//   code   picks the candidate Jev reads highest, at matchAt or above; none clears -> `none`, and
//          the sentinel unschedules exactly as before. An unread candidate never qualifies.
//
// Input: { plug, before?, dead: { asin, title }, candidates: [{ asin, title, brand? }] }.
import { noul } from '../jev.mjs';

export const name = 'plug-replacement';
export const ACTIONS = Object.freeze(['replace', 'none']);
export const HOLD = 'none';
export const safety = false;
export const MAX_CANDIDATES = 6;
const MAX_CHARS = 1200;
const clip = (v) => String(v ?? '').trim().slice(0, MAX_CHARS);

export function stateOf(input = {}) {
  const plug = clip(input.plug);
  if (!plug) throw new Error('plug-replacement: no plug tweet');
  if (!input.candidates?.length) throw new Error('plug-replacement: no candidates');
  return { plug, tweet_before: clip(input.before), product_that_died: clip(input.dead?.title || input.dead?.asin) };
}

// Dynamic set: one noul per candidate. The hash lock covers the wording through the template.
export function questions(_state, input = {}) {
  const out = {};
  (input.candidates || []).slice(0, MAX_CANDIDATES).forEach((c, i) => {
    out[`matches_${i}`] = noul(`\`plug\` recommends a product (\`product_that_died\` was its link). Is everything \`plug\` and \`tweet_before\` say about that product true of this one: ${clip(c.title)}?`, {
      true: 'Every brand, product name, form, dose, strength or count the text gives for the recommended product holds for this product, so the link could point here without the text saying anything untrue.',
      false: 'The text names a different brand, product name, form, dose, strength or count than this product has, so pointing the link here would describe it wrongly.',
    });
  });
  return out;
}
export const QUESTION_TEMPLATE = questions(null, { candidates: [{ title: '{candidate title}' }] });

/** The code's answer today: no replacement; the sentinel unschedules the thread. */
export async function incumbent() {
  return { action: 'none' };
}

/**
 * Pure. thresholds: { matchAt }. The highest-reading candidate at matchAt or above; ties keep the
 * code's order (same brand first). Returns { action, asin, confidence, readings }.
 */
export function policy(answers, thresholds, { input } = {}) {
  const matchAt = thresholds?.matchAt;
  if (!Number.isFinite(matchAt)) throw new Error('plug-replacement: thresholds.matchAt is required');
  const candidates = (input?.candidates || []).slice(0, MAX_CANDIDATES);
  const readings = candidates.map((c, i) => ({ asin: c.asin, noul: answers?.[`matches_${i}`]?.noul }));
  if (!readings.some((r) => Number.isFinite(r.noul))) throw new Error('plug-replacement: no answers');
  let best = null;
  for (const r of readings) if (Number.isFinite(r.noul) && r.noul >= matchAt && (!best || r.noul > best.noul)) best = r;
  if (!best) {
    const top = Math.max(0, ...readings.map((r) => (Number.isFinite(r.noul) ? r.noul : 0)));
    return { action: 'none', asin: null, confidence: +(1 - top).toFixed(4), readings };
  }
  return { action: 'replace', asin: best.asin, confidence: +best.noul.toFixed(4), readings };
}
