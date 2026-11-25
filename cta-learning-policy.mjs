// A report can select only approved slots in the currently selected skeleton. It never supplies
// prose to the renderer and never changes the protocol, month, or outcome of an account.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeCtaRecipeText, safeCtaLearningRecipe } from './cta-learning-core.mjs';
import { patternScore } from './cta-patterns.mjs';

export const CTA_LEARNING_POLICY_PATH = new URL('./learnings/cta-performance.json', import.meta.url);

function validPolicy(policy, now) {
  const time = new Date(now).getTime();
  if (!policy || policy.schemaVersion !== 1 || !Array.isArray(policy.preferences)
      || typeof policy.generatedAt !== 'string' || typeof policy.expiresAt !== 'string') return false;
  const generated = Date.parse(policy.generatedAt), expires = Date.parse(policy.expiresAt);
  return Number.isFinite(time) && Number.isFinite(generated) && Number.isFinite(expires)
    && generated <= time && time < expires && generated < expires
    && expires - generated <= 14 * 24 * 60 * 60 * 1000;
}

export function loadCtaLearningPolicy({ path = CTA_LEARNING_POLICY_PATH, now = new Date(),
  enabled = process.env.CTA_LEARNING_ENABLED !== 'false' } = {}) {
  if (!enabled || process.env.CTA_LEARNING_ENABLED === 'false') return null;
  try {
    const policy = JSON.parse(readFileSync(path, 'utf8'));
    return validPolicy(policy, now) ? policy : null;
  } catch { return null; }
}

function weekOf(now) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
const hash = (key) => createHash('sha256').update(key).digest().readUInt32BE(0);

function safeSlotChange(criterion, cta, baselineCta) {
  // An existing account's baseline closer can stay, but learning cannot introduce another
  // speaker's use/client/family claim. Apply the core's criterion gate in both cases.
  const unchangedCta = normalizeCtaRecipeText(cta) === normalizeCtaRecipeText(baselineCta);
  return safeCtaLearningRecipe({ criterion, cta: unchangedCta ? 'I recommend' : cta });
}

/** Pure selection when policy, now and enabled are supplied. Exact strings stay library-owned. */
export function selectLearnedSkeletonSlots({ podId, asin, accountKey, variant, role = 'heavy', policy = null,
  now = new Date(), selectionKey, alt = 0, enabled = process.env.CTA_LEARNING_ENABLED !== 'false' } = {}) {
  const sk = variant?.plug || {};
  const criteria = role === 'light' && variant?.light?.opener?.length ? variant.light.opener : sk.criterion;
  const ctas = role === 'light' && variant?.light?.cta?.length ? variant.light.cta : sk.cta;
  // Preserve the existing alt indexing, including separate clamping for the two arrays.
  const pick = (arr) => arr?.length ? arr[Math.min(alt, arr.length - 1)] : '';
  const base = { criterion: pick(criteria), cta: pick(ctas),
    metadata: { arm: alt > 0 ? 'manual' : 'default', role, podId } };
  if (alt !== 0 || !enabled || !validPolicy(policy, now)
      || !['heavy', 'light'].includes(role) || !Array.isArray(criteria) || !Array.isArray(ctas)) return base;
  const preference = policy.preferences.find((p) => p && p.podId === podId && p.role === role
    && typeof asin === 'string' && asin.length > 0 && p.asin === asin
    && p.status === 'proven' && p.evidence?.promoted === true && typeof p.recipeId === 'string' && p.recipeId.length > 0
    && typeof p.criterion === 'string' && typeof p.cta === 'string'
    && criteria.includes(p.criterion) && ctas.includes(p.cta)
    && safeSlotChange(p.criterion, p.cta, ctas[0]));
  // No exact-wording winner: fall back to slot patterns (cta-patterns.mjs). The library pair whose
  // opening and closer carry the most proven-better (and fewest proven-worse) patterns becomes the
  // preferred arm, only when it scores strictly above the default pair. Strings stay library-owned.
  const patterns = Array.isArray(policy.patterns) ? policy.patterns.filter((x) => x && (x.status === 'better' || x.status === 'worse')) : [];
  let chosen = preference ? { criterion: preference.criterion, cta: preference.cta, recipeId: preference.recipeId, source: 'recipe' } : null;
  if (!chosen && patterns.length) {
    const baseScore = patternScore(criteria[0], ctas[0], patterns);
    let best = null;
    for (const c of criteria) for (const t of ctas) {
      if (typeof c !== 'string' || typeof t !== 'string' || !safeSlotChange(c, t, ctas[0])) continue;
      const score = patternScore(c, t, patterns);
      if (score > baseScore + 1e-9 && (!best || score > best.score)) best = { criterion: c, cta: t, score };
    }
    if (best) chosen = { criterion: best.criterion, cta: best.cta, recipeId: `pattern:${criteria.indexOf(best.criterion)}:${ctas.indexOf(best.cta)}`, source: 'pattern' };
  }
  if (!chosen) return base;
  const week = weekOf(now);
  const day = new Date(now).toISOString().slice(0, 10);
  const allocationUnit = selectionKey == null ? 'account-pod-role-utc-day' : 'selection-key-pod-role-utc-week';
  // Daily default assignment allows each account to contribute control and challenger evidence
  // within a matched week. Callers with an explicit selection key retain a stable weekly choice.
  const key = JSON.stringify([selectionKey ?? accountKey ?? '', podId, role, selectionKey == null ? day : week]);
  const bucket = hash(key) % 100;
  const arm = bucket < 70 ? 'winner' : bucket < 90 ? 'baseline' : 'exploration';
  let criterion = criteria[0], cta = ctas[0];
  if (arm === 'winner') {
    // Resolve the exact live entries again, rather than returning report text.
    criterion = criteria[criteria.indexOf(chosen.criterion)];
    cta = ctas[ctas.indexOf(chosen.cta)];
  } else if (arm === 'exploration') {
    const alternatives = criteria.flatMap((c) => ctas.map((t) => [c, t]))
      .filter(([c, t]) => typeof c === 'string' && typeof t === 'string'
        && safeSlotChange(c, t, ctas[0])
        && !(c === criteria[0] && t === ctas[0])
        && !(c === chosen.criterion && t === chosen.cta));
    if (alternatives.length) [criterion, cta] = alternatives[hash(`${key}|explore`) % alternatives.length];
  }
  return { criterion, cta, metadata: { arm, role, podId, week, bucket, allocationUnit,
    allocationPeriod: selectionKey == null ? day : week,
    recipeId: arm === 'winner' ? chosen.recipeId : null, source: chosen.source,
    preferredRecipeId: chosen.recipeId, generatedAt: policy.generatedAt } };
}
