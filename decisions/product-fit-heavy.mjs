// decisions/product-fit-heavy.mjs — the example decision (plan Phase 0): "does the donor argue for the
// heavy placement the picker chose?", on product-fit.mjs's own question set, unchanged.
//
// Report-only: laws.json `jev.decisions.product-fit-heavy.mode` is `shadow`, so decide() returns the
// incumbent's action (`keep`: the canonical picker's heavy stands) and logs Jev's reading beside it for
// jev-report.mjs. Nothing calls it live yet; product-fit.mjs and its callers are untouched.
//
// Input: { donorText, products, placements: [{ asin, placement: 'heavy'|'light'|…, needsBridge }] }.
// Actions: `keep` (the heavy is argued) or `flag` (the operator should look at the heavy). Reason codes
// only; the product-fit packet keeps the human wording.
import { fitCandidates, productFitQuestions } from '../product-fit.mjs';

export const name = 'product-fit-heavy';
export const ACTIONS = Object.freeze(['keep', 'flag']);
export const safety = false;

// product-fit.mjs slices the donor to this many characters (its STATE_MAX_CHARS, not exported).
export const STATE_MAX_CHARS = 20000;

/** The candidates product-fit.mjs would ask about, proposed placements first. */
export function candidatesOf(input = {}) {
  const placements = input.placements || [];
  return fitCandidates(input.donorText, input.products || [], placements.map((p) => p.asin));
}

export function stateOf(input = {}) {
  return String(input.donorText || '').slice(0, STATE_MAX_CHARS);
}

// Dynamic set: one noul per candidate. The hash lock covers the wording through the template.
export function questions(_state, input) {
  return productFitQuestions(candidatesOf(input));
}
export const QUESTION_TEMPLATE = productFitQuestions([{ asin: 'TEMPLATE', label: '{candidate}' }]);

/**
 * Pure. thresholds = laws.json `jev.decisions.product-fit-heavy.thresholds` ({ fit, margin }).
 * Mirrors fitVerdict's heavy rules: a weakly argued heavy, a stronger unproposed rival, or no product
 * recommended at all flags the row. Confidence is how far the heavy's noul sits from undecided (0.5).
 */
export function policy(answers, thresholds, { input } = {}) {
  const { fit, margin } = thresholds;
  if (!Number.isFinite(fit) || !Number.isFinite(margin)) throw new Error('product-fit-heavy: thresholds.fit and thresholds.margin are required');
  const placements = input?.placements || [];
  const nouls = candidatesOf(input).map((c, i) => ({ asin: c.asin, noul: answers[`fit_${i}`]?.noul ?? null }));
  const proposed = new Set(placements.map((p) => p.asin));
  const heavyAsin = placements.find((p) => p.placement === 'heavy')?.asin;
  const heavy = nouls.find((c) => c.asin === heavyAsin);
  if (!heavy || !Number.isFinite(heavy.noul)) return { action: 'keep', confidence: null, reasons: ['no_heavy'] };
  const any = answers.any_supplement?.noul;
  const rival = nouls.filter((c) => !proposed.has(c.asin) && Number.isFinite(c.noul)).sort((a, b) => b.noul - a.noul)[0];
  // Each check: whether it fires (the same rules as fitVerdict), and how far its reading sits from
  // its threshold, scaled to [0, 1]. A check with nothing to read abstains.
  const dist = (x) => (x < fit ? (fit - x) / Math.max(fit, 1e-9) : (x - fit) / Math.max(1 - fit, 1e-9));
  const checks = [{ reason: 'heavy_weak', fires: heavy.noul < fit, strength: dist(heavy.noul) }];
  if (Number.isFinite(any)) checks.push({ reason: 'no_product', fires: any < fit, strength: dist(any) });
  if (rival && rival.noul >= fit) {
    const gap = rival.noul - heavy.noul;
    checks.push({ reason: 'rival_beats_heavy', fires: gap >= margin, strength: Math.abs(gap - margin) / Math.max(margin, 1 - margin) });
  }
  const fired = checks.filter((c) => c.fires);
  // Flag: as sure as its strongest trigger. Keep: only as sure as its weakest check.
  const confidence = fired.length ? Math.max(...fired.map((c) => c.strength)) : Math.min(...checks.map((c) => c.strength));
  return { action: fired.length ? 'flag' : 'keep', confidence: Math.min(1, +confidence.toFixed(6)), reasons: fired.map((c) => c.reason) };
}

/** The canonical picker already placed the heavy; its action is to keep it. */
export function incumbent() {
  return { action: 'keep' };
}
