// decisions/donor-intent.mjs — the /funnel rubric as a registered decision (plan v7 N4; owner,
// 2026-09-23: "become jev native": skills stop judging in prose).
//
// The questions are donor-intent.mjs INTENT_QUESTIONS (the operator's rubric, byte for byte); the
// verdict bands are its intentVerdict (8-10 write · 5-7 repair · <=4 swap). /funnel and /run call it
// through jev-ask instead of scoring the five dimensions in prose. The offline backtest (2026-09-23)
// found the total does not predict $/1k better than the formula, so it stays advice on a donor, never
// a gate: nothing reads its action except the agent choosing among donors it already has.
//
// Input: { hook, body }.
import { INTENT_DIMENSIONS, INTENT_QUESTIONS, intentState, intentVerdict } from '../donor-intent.mjs';

export const name = 'donor-intent';
export const ACTIONS = Object.freeze(['write', 'repair', 'swap']);
export const HOLD = 'swap';
export const safety = false;
export const QUESTIONS = INTENT_QUESTIONS;

export function stateOf(input = {}) {
  if (!String(input.hook ?? '').trim() && !String(input.body ?? '').trim()) throw new Error('donor-intent: no hook or body');
  return intentState({ hook: input.hook, body: input.body });
}

/** No code incumbent: the rubric was scored in prose. */
export async function incumbent() { return { action: 'repair' }; }

/** Pure. The rubric's own bands over the five scores; the per-dimension trail rides along. */
export function policy(answers) {
  const scores = Object.fromEntries(INTENT_DIMENSIONS.map((d) => [d, answers?.[d]?.score]));
  if (!Object.values(scores).every(Number.isFinite)) throw new Error('donor-intent: no answers');
  const total = +Object.values(scores).reduce((s, x) => s + x, 0).toFixed(2);
  const conf = INTENT_DIMENSIONS.map((d) => answers[d].confidence).filter(Number.isFinite);
  return { action: intentVerdict(total), confidence: conf.length ? +Math.min(...conf).toFixed(4) : 0.5, total, scores };
}
