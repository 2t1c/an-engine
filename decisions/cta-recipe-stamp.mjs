// decisions/cta-recipe-stamp.mjs — back-stamp decision (plan Track G, Phase 5 "Learning loops"): which
// library CTA recipe does a shipped plug tweet use? SHADOW ONLY.
//
// Why: cta-learn keys a plug on the sha of its exact first and last paragraphs (cta-learning-core.mjs
// ctaRecipeId), so a chat-written plug that says a library recipe's question and recommendation in its
// own words is a new recipe, and `recipe_not_in_library` held 478 of 487 candidates on 2026-09-21. This
// asks Jev whether the plug carries a library recipe's MEANING.
//
// VERSION 2 (2026-09-23). v1 asked one `choice` over every recipe on the ASIN (both roles) plus 'none';
// it mapped 50 of the 478 candidates at p >= 0.7 and a hand-read of 8 found about half right. v2 asks
// ONE yes/no noul per library recipe of the plug's own role (heavy: plug.criterion x plug.cta; light:
// light.opener x light.cta), and the policy, not Jev, picks: the highest noul at or above the floor,
// and only when it beats the runner-up by `margin`; otherwise 'none'. Both numbers are laws.json
// `jev.decisions.cta-recipe-stamp.thresholds` (stampFloor, margin).
//
// The options are the pods.json skeleton recipes for the plug's ASIN and role, exactly the set
// buildCtaLearning approves, each keyed by its ctaRecipeId. The incumbent is cta-learn's own
// exact-text identity: the recipe id of the plug's first and last paragraphs when that id is in the
// library, else 'none'.
//
// Input: { asin, role: 'heavy'|'light', text } (text = the plug tweet). State: { role, plug } with the
// link removed. Stamps hold the recipe id only, never the copy.
import { readFileSync } from 'node:fs';
import { noul } from '../jev.mjs';
import { ctaRecipeId, recipeFromText } from '../cta-learning-core.mjs';

export const name = 'cta-recipe-stamp';
export const safety = false;
export const NONE = 'none';

const PODS = JSON.parse(readFileSync(new URL('../pods.json', import.meta.url), 'utf8')).pods;

/**
 * The approved library, the same loop buildCtaLearning runs (skeleton variants only, both roles, every
 * criterion x every cta), keyed by ctaRecipeId. `retired` pods are left out, as cta-learn's pod
 * lookup leaves them out. tests/backstamp.test.mjs pins this set to buildCtaLearning's `approved`.
 */
export function libraryRecipes(pods = PODS) {
  const out = [];
  for (const pod of pods) {
    if (pod.status === 'retired') continue;
    for (const variant of (pod.variants || []).filter((v) => v.system === 'skeleton')) for (const role of ['heavy', 'light']) {
      const criteria = role === 'heavy' ? variant.plug?.criterion : variant.light?.opener;
      const ctas = role === 'heavy' ? variant.plug?.cta : variant.light?.cta;
      if (!Array.isArray(criteria) || !Array.isArray(ctas)) continue;
      for (const criterion of criteria) for (const cta of ctas) {
        if (typeof criterion !== 'string' || typeof cta !== 'string') continue;
        const recipe = { podId: pod.id, asin: pod.asin, role, criterion, cta };
        out.push({ id: ctaRecipeId(recipe), ...recipe });
      }
    }
  }
  return [...new Map(out.map((r) => [r.id, r])).values()];
}

const LIBRARY = libraryRecipes();
export const VERSION = 2;
export const recipesForAsin = (asin, library = LIBRARY) => library.filter((r) => r.asin === asin);
export const recipesFor = (asin, role, library = LIBRARY) => recipesForAsin(asin, library).filter((r) => r.role === role);
export const ACTIONS = Object.freeze([...LIBRARY.map((r) => r.id), NONE]);

// ---- Questions (the reviewable set) -----------------------------------------------------------------
// One noul per candidate recipe, keyed `r_<recipe id>`. The move description names both halves a
// cta-learn recipe is made of (the opening point and the recommendation), because cta-learn's id
// carries both: a plug that makes the recipe's point but recommends another way is a different recipe.
export const QUESTION_PREFIX = 'r_';
const OPENING = { heavy: 'opens on the buying criterion', light: 'opens on the point' };
export const moveOf = (r) => `it ${OPENING[r.role] || 'opens on'} "${r.criterion}", then recommends the product as "${r.cta}"`;
export const RECIPE_CRITERIA = Object.freeze({
  true: 'Both halves carry the same meaning in `plug`, even in other words: the same buying point, and the same way of recommending the product. Dose, timing, months and personal results in between do not matter.',
  false: 'Either half differs in meaning: `plug` makes another buying point, or recommends the product in another way, or does only one of the two.',
});
const recipeQuestion = (r) => noul(`Does \`plug\` follow this recipe's move: ${moveOf(r)}?`, RECIPE_CRITERIA);

/** Dynamic set: one noul per recipe given (the caller passes the plug's role only). */
export function questionsFor(recipes) {
  return Object.fromEntries(recipes.map((r) => [`${QUESTION_PREFIX}${r.id}`, recipeQuestion(r)]));
}
export const QUESTION_TEMPLATE = questionsFor([
  { id: 'HEAVY_RECIPE_ID', role: 'heavy', criterion: '{criterion}', cta: '{cta}' },
  { id: 'LIGHT_RECIPE_ID', role: 'light', criterion: '{opener}', cta: '{cta}' },
]);
export function questions(_state, input) {
  return questionsFor(recipesFor(input.asin, input.role));
}

const LINK = /https?:\/\/\S+|\{\{LINK\d*\}\}/g;
export function stateOf(input = {}) {
  if (!recipesFor(input.asin, input.role).length) throw new Error('cta-recipe-stamp: no library recipes for this ASIN and role');
  const plug = String(input.text || '').replace(LINK, '').trim();
  if (!plug) throw new Error('cta-recipe-stamp: empty plug');
  return { role: input.role, plug };
}

/**
 * Pure. thresholds = laws.json `jev.decisions.cta-recipe-stamp.thresholds` ({ stampFloor, margin }).
 * The recipe with the highest noul stands when that noul is at or above `stampFloor` AND beats the
 * runner-up (0 when it is the only candidate) by at least `margin`; its confidence is its noul.
 * Otherwise 'none', at confidence 1 - the top noul: high when nothing came close, below the floor when
 * a recipe cleared it but lost on the margin (so the resolver ignores that 'none').
 */
export function policy(answers, thresholds = {}) {
  const { stampFloor, margin } = thresholds;
  if (!Number.isFinite(stampFloor) || !Number.isFinite(margin)) throw new Error('cta-recipe-stamp: thresholds.stampFloor and thresholds.margin are required');
  const scored = Object.entries(answers || {}).filter(([k]) => k.startsWith(QUESTION_PREFIX)).map(([k, a]) => ({ id: k.slice(QUESTION_PREFIX.length), n: a?.noul }));
  if (!scored.length) throw new Error('cta-recipe-stamp: no recipe answers');
  for (const s of scored) {
    if (!ACTIONS.includes(s.id)) throw new Error(`cta-recipe-stamp: unknown recipe ${s.id}`);
    if (!Number.isFinite(s.n)) throw new Error(`cta-recipe-stamp: no noul for ${s.id}`);
  }
  scored.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const [top, second] = scored;
  const runnerUp = second ? second.n : 0;
  if (top.n < stampFloor) return { action: NONE, confidence: 1 - top.n, route: 'below_floor', top: top.n, runnerUp };
  // 1e-9 of float slack: 0.85 - 0.7 is not exactly 0.15.
  if (top.n - runnerUp < margin - 1e-9) return { action: NONE, confidence: 1 - top.n, route: 'ambiguous', top: top.n, runnerUp };
  return { action: top.id, confidence: top.n, route: 'mapped', top: top.n, runnerUp };
}

export { recipeFromText }; // cta-learn's own paragraph split, imported so the identity cannot drift

/** cta-learn's exact-text identity on any of this ASIN's pods. */
export function incumbent(input = {}) {
  const { criterion, cta } = recipeFromText(input.text);
  const ids = new Set(recipesFor(input.asin, input.role).map((r) => r.id));
  const pods = [...new Set(recipesFor(input.asin, input.role).map((r) => r.podId))];
  for (const podId of pods) {
    const id = ctaRecipeId({ podId, role: input.role, criterion, cta });
    if (ids.has(id)) return { action: id };
  }
  return { action: NONE };
}
