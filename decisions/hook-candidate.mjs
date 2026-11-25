// decisions/hook-candidate.mjs — is this candidate hook a faithful, strong cover of the donor's?
// (plan W3 "N candidates, Jev picks"; D. Hook track H1 fidelity + H2 strength.)
//
// Owner, 2026-09-23, approving it ("implement: 2,3,4, 6 first"). scripts/hook-pick.mjs has the writer
// draft several hooks in one call; code keeps only the ones inside the hook gate (checkHook: the
// coverFloor..gateMax similarity band) with the promised count intact; Jev reads each survivor against
// the donor hook. H1 (fidelity) can DROP a candidate the code let through; it never rescues one the
// code refused. H2 (strength) only ranks the kept ones. Jev never writes the hook and never scores
// similarity: that stays hookSimilarity.
//
// Input: { donorHook, hook, sim? }.
import { noul, score } from '../jev.mjs';

export const name = 'hook-candidate';
export const ACTIONS = Object.freeze(['keep', 'drop']);
export const HOLD = 'drop';
export const safety = false;

export const MAX_HOOK_CHARS = 600;

export const QUESTIONS = {
  same_promise: noul('Does `candidate` make the same promise to the same reader as `donor_hook`: the same subject, the same payoff and the same kind of list or answer?', {
    true: 'A reader of either would expect the same thread.',
    false: 'The subject, the payoff, the audience or the kind of list changed.' }),
  new_claim: noul('Does `candidate` state a health result, cure, number or fact that `donor_hook` does not state?', {
    true: 'It adds or strengthens a claim: a new result, a cure, a bigger number, a certainty the donor did not give.',
    false: 'Every claim in it is already in `donor_hook`, in the same strength or softer.' }),
  reads_as_ad: noul('Does `candidate` sell: name a product, a brand or a price, or tell the reader to buy, click or shop?', {
    true: 'It names or pushes something to buy.',
    false: 'It names no product, brand or price and asks for no purchase; a list of foods, habits or signs is not selling.' }),
  specific: score('How specific is `candidate`?', [
    'Vague: a general topic the reader has seen a hundred times.',
    'Somewhat specific: a clear topic, but no detail the reader can picture.',
    'Specific: it names a symptom, a number, a moment or a situation the reader recognises in their own life.',
  ]),
  pull: score('How strongly does `candidate` make its reader want to open the thread now?', [
    'Weak: nothing is at stake and nothing is left open.',
    'Moderate: a reason to read, but it could wait.',
    'Strong: it names something the reader has or wants and leaves the answer open, so they read on.',
  ]),
};

const text = (x) => String(x ?? '').slice(0, MAX_HOOK_CHARS);

export function stateOf(input = {}) {
  const candidate = text(input.hook).trim(), donor = text(input.donorHook).trim();
  if (!candidate) throw new Error('hook-candidate: no candidate hook');
  if (!donor) throw new Error('hook-candidate: no donor hook');
  return { donor_hook: donor, candidate };
}

/** The code's answer: the hook gate alone (hooks-check.mjs checkHook, the same measurement as the door). */
export async function incumbent(input = {}) {
  const { checkHook } = await import('../hooks-check.mjs');
  const c = checkHook(input.hook, input.donorHook);
  return { action: c.ok ? 'keep' : 'drop', sim: c.sim };
}

const need = (t, k) => {
  if (!Number.isFinite(t?.[k])) throw new Error(`hook-candidate: thresholds.${k} is required`);
  return t[k];
};

/**
 * Pure. thresholds: { promiseAt, newClaimAt, adAt }. DROP when the promise changed (same_promise below
 * promiseAt), a claim was added (new_claim at newClaimAt or above) or it reads as an ad (reads_as_ad at
 * adAt or above). `strength` (0-1) is the mean of the two scores and only ranks kept candidates. An
 * unread fidelity noul is a drop: a candidate Jev could not read is not a faithful one.
 */
export function policy(answers, thresholds) {
  const promiseAt = need(thresholds, 'promiseAt'), claimAt = need(thresholds, 'newClaimAt'), adAt = need(thresholds, 'adAt');
  const p = answers?.same_promise?.noul, c = answers?.new_claim?.noul, a = answers?.reads_as_ad?.noul;
  if (![p, c, a].some(Number.isFinite)) throw new Error('hook-candidate: no answers');
  const reasons = [
    ...(!Number.isFinite(p) ? ['promise not read'] : p < promiseAt ? [`changes the promise (${p.toFixed(2)})`] : []),
    ...(!Number.isFinite(c) ? ['claims not read'] : c >= claimAt ? [`adds a claim (${c.toFixed(2)})`] : []),
    ...(!Number.isFinite(a) ? ['ad read not read'] : a >= adAt ? [`reads as an ad (${a.toFixed(2)})`] : []),
  ];
  const scores = [answers?.specific?.score, answers?.pull?.score].filter(Number.isFinite);
  const strength = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length / 2 : null;
  const keep = !reasons.length;
  const confidence = keep ? Math.min(p, 1 - c, 1 - a) : Math.max(Number.isFinite(p) ? 1 - p : 0, Number.isFinite(c) ? c : 0, Number.isFinite(a) ? a : 0, reasons.some((r) => /not read/.test(r)) ? 1 : 0);
  return { action: keep ? 'keep' : 'drop', confidence: +confidence.toFixed(4), strength: strength == null ? null : +strength.toFixed(4), reasons };
}
