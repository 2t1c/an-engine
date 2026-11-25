// decisions/rule-proposal.mjs — is a retro "rule" worth a place in the review queue?
// (plan v7 N2; owner, 2026-09-23: "scope a plan and implement plan to become jev native".)
//
// retro-core.mjs has an LLM propose root-cause fixes after a run and appends its "rule" proposals to
// style/learned-rules.md, a queue a human promotes from (it is no longer injected into generation,
// operator 2026-09-02: 40 accumulated bullets, 14 describing a CTA shape retired months earlier). The
// dedupe was the first 50 normalised characters, so a restatement in other words got in. The LLM
// still WRITES the proposal; Jev decides whether it enters the queue: not a restatement of a rule
// already there, specific enough to check, and it would have prevented the failure it cites. A
// refused proposal is still logged to IMPROVEMENTS.md, marked with Jev's reason.
//
// Input: { rule, rootCause, existingRules: [string] }.
import { noul } from '../jev.mjs';

export const name = 'rule-proposal';
export const ACTIONS = Object.freeze(['queue', 'refuse']);
export const HOLD = 'refuse';
export const safety = false;

export const MAX_EXISTING = 60;

export const QUESTIONS = {
  duplicate: noul('Does `existing_rules` already contain a rule that says what `rule` says, in any wording?', {
    true: 'An existing rule already forbids or requires the same thing.',
    false: 'No existing rule covers it.' }),
  checkable: noul('Is `rule` specific enough that a reader could check a thread against it and say whether it was followed?', {
    true: 'It names a concrete thing to do or avoid.',
    false: 'It is vague advice ("be more engaging", "improve quality") that no one could check.' }),
  prevents: noul('Would following `rule` have prevented the failure described in `root_cause`?', {
    true: 'Yes: the failure could not have happened under this rule.',
    false: 'No: the rule is about something else, or only restates the symptom.' }),
};

export function stateOf(input = {}) {
  const rule = String(input.rule ?? '').trim().slice(0, 600);
  if (!rule) throw new Error('rule-proposal: no rule');
  const existing = (Array.isArray(input.existingRules) ? input.existingRules : []).map((r) => String(r).slice(0, 300)).slice(-MAX_EXISTING);
  return { rule, root_cause: String(input.rootCause ?? '').slice(0, 800), existing_rules: existing.length ? existing : ['(none)'] };
}

/** The code's answer: the 50-character normalised-prefix dedupe retro-core has always used. */
export async function incumbent(input = {}) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const dup = (input.existingRules || []).some((r) => norm(r) === norm(input.rule));
  return { action: dup ? 'refuse' : 'queue' };
}

/** Pure. thresholds: { duplicateAt, checkableAt, preventsAt }. Queue only when all three hold. */
export function policy(answers, thresholds) {
  const d = answers?.duplicate?.noul, c = answers?.checkable?.noul, p = answers?.prevents?.noul;
  for (const k of ['duplicateAt', 'checkableAt', 'preventsAt']) if (!Number.isFinite(thresholds?.[k])) throw new Error(`rule-proposal: thresholds.${k} is required`);
  if (![d, c, p].every(Number.isFinite)) throw new Error('rule-proposal: no answers');
  const reasons = [
    ...(d >= thresholds.duplicateAt ? [`restates an existing rule (${d.toFixed(2)})`] : []),
    ...(c < thresholds.checkableAt ? [`too vague to check (${c.toFixed(2)})`] : []),
    ...(p < thresholds.preventsAt ? [`would not have prevented the cited failure (${p.toFixed(2)})`] : []),
  ];
  const queue = !reasons.length;
  return { action: queue ? 'queue' : 'refuse', confidence: +(queue ? Math.min(1 - d, c, p) : Math.max(d, 1 - c, 1 - p)).toFixed(4), reasons };
}
