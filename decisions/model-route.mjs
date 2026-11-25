// decisions/model-route.mjs — which writer model does this task need? (owner, 2026-09-24: "setup jev
// to handle ai model selection for specific tasks. Not everything needs the highest model, so you can
// functionally switch between models to save time and money.")
//
// Jev reads the task (its role and its instructions) and says how hard it is; model-router.mjs maps
// that to a tier (fast / standard / strong, models in laws.json modelRouting.tiers) and clamps it to
// the role's floor and ceiling. Jev never writes and never picks a model id: code owns the ids, the
// prices and the limits. An unread task gets the role's default tier.
//
// Input: { role, brief } — brief is the task's instructions (system + user), clipped.
import { noul, score } from '../jev.mjs';

export const name = 'model-route';
export const ACTIONS = Object.freeze(['fast', 'standard', 'strong']);
export const HOLD = 'standard';
export const safety = false;

export const MAX_BRIEF_CHARS = 3000;

export const QUESTIONS = {
  difficulty: score('How hard is the writing or reasoning `task` asks for?', [
    'Mechanical: reformat, renumber, fix a length, extract or classify, fill a template, or a short rewrite with the answer spelled out.',
    'Moderate: rewrite or write a few tweets inside clear rules, where the content is given and the words are ours.',
    'Hard: original persuasive writing where voice and nuance decide whether it works, many rules to hold at once, or long multi-step reasoning such as finding a root cause.',
  ]),
  voice_critical: noul('Will the output be published as copy whose tone and persuasion decide whether it earns (a hook, a plug, a thread people read)?', {
    true: 'It is copy readers will see, and how it sounds matters.',
    false: 'It is internal (a classification, a report, a plan) or a mechanical fix.' }),
  many_constraints: noul('Does `task` ask the writer to hold five or more separate rules at the same time?', {
    true: 'Many rules must all hold at once.',
    false: 'A few rules at most.' }),
};

export function stateOf(input = {}) {
  const brief = String(input.brief ?? '').trim();
  if (!brief) throw new Error('model-route: no task brief');
  return { task: { role: String(input.role || 'unknown'), instructions: brief.slice(0, MAX_BRIEF_CHARS) } };
}

/** The code's answer: the role's default tier (model-router passes it). */
export async function incumbent(input = {}) {
  return { action: ACTIONS.includes(input.defaultTier) ? input.defaultTier : 'standard' };
}

/**
 * Pure. thresholds: { fastBelow, strongAt, bumpAt }. difficulty (0-2) below fastBelow is fast, at or
 * above strongAt strong, else standard; voice-critical or many-constraint copy is never fast.
 */
export function policy(answers, thresholds) {
  const d = answers?.difficulty?.score, v = answers?.voice_critical?.noul, m = answers?.many_constraints?.noul;
  for (const k of ['fastBelow', 'strongAt', 'bumpAt']) if (!Number.isFinite(thresholds?.[k])) throw new Error(`model-route: thresholds.${k} is required`);
  if (!Number.isFinite(d)) throw new Error('model-route: no answers');
  let tier = d < thresholds.fastBelow ? 'fast' : d >= thresholds.strongAt ? 'strong' : 'standard';
  const reasons = [`difficulty ${d.toFixed(2)} of 2`];
  if (tier === 'fast' && ((Number.isFinite(v) && v >= thresholds.bumpAt) || (Number.isFinite(m) && m >= thresholds.bumpAt))) {
    tier = 'standard';
    reasons.push('published copy or many rules: not the fast tier');
  }
  return { action: tier, confidence: +(answers.difficulty.confidence ?? 0.5).toFixed(4), difficulty: +d.toFixed(3), reasons };
}
