// decisions/donor-writeability.mjs — can we write a cover from this donor? (plan Track A2 row
// "Donor writeability": 7 of 11 donors were replaced mid-write on 2026-08-31.)
//
// Report-only: laws.json `jev.decisions.donor-writeability.mode` is `shadow`, so decide() returns the
// incumbent (today's regex screens) and logs Jev's reading beside it.
//
// Input: { hook, tweets, pods: [{ id, substance, criterion }] } — the eligible pods, from
// eligiblePods() over pods.json. Jev answers nouls; the SWAP RULE stays in code (policy below):
//   swap  when the thread only works with its media or poll, when it cannot be rewritten as text,
//         or when no eligible pod's criterion is the natural next question (or none is eligible);
//   keep  otherwise. One buyer need instead of two is a note, never a swap: the second opportunity
//         is the writer's to earn (glue.md G1; plan §1.3 "donor-owned dims decide swap").
//
// Wording lifted from: preflight.mjs UNRECREATABLE ("points at a video, asks for a reply, or promises
// photographs"), swipe-classify media_dependent (with the poll the A2 row names), glue.md G1 ("two
// products doing the same job") and cta-spec.md's bridge rule ("the natural next question is, 'Okay,
// so what is the right one?'"). Pods are named by letter in the state; Jev is not asked to count.
import { noul } from '../jev.mjs';
import { donorState } from './donor-screen.mjs';

export const name = 'donor-writeability';
export const ACTIONS = Object.freeze(['keep', 'swap']);
export const safety = false;

export const MAX_PODS = 6;
export const POD_KEYS = Object.freeze('abcdef'.split(''));
const MAX_CRITERION_CHARS = 240;

export const BASE_QUESTIONS = {
  media_or_poll: noul('Does this thread only make sense while looking at its attached images, video or poll?', {
    true: 'The text points at media or a poll ("look at this", "watch", "this chart", "vote below") and says little without it.',
    false: 'The text carries its meaning on its own.' }),
  recreatable: noul('Can this thread be rewritten as a text-only thread that keeps what `hook` promises?', {
    true: 'Its value is in its words: points, steps or a story that a text thread can carry.',
    false: 'Its value is a video, photographs, a reply prompt, or a hook that asks for something instead of promising something.' }),
  two_needs: noul('Does this thread build two distinct buyer needs, each of which a different product could answer?', {
    true: 'It builds two separate needs, each with its own reason (for example poor sleep and stiff joints).',
    false: 'It builds one need, or two needs that are the same decision: the same problem or the same outcome.' }),
};

export function podQuestion(key) {
  return noul(`After reading this thread, is the buying criterion in \`pods.${key}\` the natural next question a reader would ask?`, {
    true: 'The thread builds the need that criterion answers, so the reader arrives asking "okay, so which one is the right one?"',
    false: 'The criterion answers a need the thread does not build, or builds only in passing.' });
}
export const QUESTION_TEMPLATE = { ...BASE_QUESTIONS, pod_a: podQuestion('a') };

/**
 * Pure. The live pods a donor could carry: its text names the pod's substance (substanceTerms) or
 * routes to the pod's ASIN (bridgeableProducts), the same substance screen preflight runs. At most
 * MAX_PODS, the most-mentioned substance first (pods.json order on ties), so a thread's main subject
 * is never cut by pods that sit earlier in the file; `checks` = { substanceTerms, bridgeableProducts }.
 */
export function eligiblePods(text, pods, { substanceTerms, bridgeableProducts }) {
  const terms = substanceTerms(text);
  const asins = bridgeableProducts(text);
  const lower = String(text || '').toLowerCase();
  const mentions = (substance) => {
    const k = String(substance || '').toLowerCase();
    return k ? lower.split(k).length - 1 : 0;
  };
  return (pods || []).filter((p) => p && p.status !== 'retired' && p.criterion
    && (asins.has(p.asin) || terms.has(String(p.substance || '').toLowerCase())))
    .map((p, i) => ({ p, i, n: mentions(p.substance) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, MAX_PODS).map(({ p }) => ({ id: p.id, substance: p.substance, criterion: p.criterion }));
}

const podsOf = (input = {}) => (Array.isArray(input.pods) ? input.pods : []).slice(0, MAX_PODS);

export function stateOf(input = {}) {
  const s = donorState(input);
  const pods = Object.fromEntries(podsOf(input).map((p, i) => [POD_KEYS[i], `${String(p.criterion).slice(0, MAX_CRITERION_CHARS)} (${p.substance})`]));
  return { ...s, pods };
}

export function questions(state) {
  return { ...BASE_QUESTIONS, ...Object.fromEntries(Object.keys(state.pods || {}).map((k) => [`pod_${k}`, podQuestion(k)])) };
}

// ---- Incumbent: today's regex screens (preflight.mjs screenDonor) -------------------------------------
export async function incumbentReasons(input = {}) {
  const [{ UNRECREATABLE }, { bridgeableProducts }] = await Promise.all([import('../preflight.mjs'), import('../checks.mjs')]);
  const tweets = (Array.isArray(input.tweets) ? input.tweets : []).map(String);
  const hook = String(input.hook ?? tweets[0] ?? '');
  const reasons = [];
  if (tweets.length < 3) reasons.push('not_a_thread');
  if (UNRECREATABLE.test(hook)) reasons.push('unrecreatable_hook');
  if (!bridgeableProducts(`${hook}\n${tweets.join('\n')}`).size) reasons.push('no_substance');
  return reasons;
}

export async function incumbent(input = {}) {
  const reasons = Array.isArray(input.incumbentReasons) ? input.incumbentReasons : await incumbentReasons(input);
  return { action: reasons.length ? 'swap' : 'keep', reasons };
}

// ---- Policy: the swap rule (pure) ------------------------------------------------------------------
const need = (t, k) => {
  if (!Number.isFinite(t?.[k])) throw new Error(`donor-writeability: thresholds.${k} is required`);
  return t[k];
};

/**
 * thresholds: { flagAt, recreatableLow, podFit, twoNeeds }. Returns { action, confidence, reasons,
 * notes, bestPod }. Confidence: a swap is as sure as its strongest trigger; a keep only as sure as its
 * weakest check.
 */
export function policy(answers, thresholds, { input } = {}) {
  const flagAt = need(thresholds, 'flagAt'), low = need(thresholds, 'recreatableLow');
  const podFit = need(thresholds, 'podFit'), twoNeeds = need(thresholds, 'twoNeeds');
  const dist = (x, th) => (x >= th ? (x - th) / Math.max(1 - th, 1e-9) : (th - x) / Math.max(th, 1e-9));
  const pods = podsOf(input).map((p, i) => ({ id: p.id, p: answers?.[`pod_${POD_KEYS[i]}`]?.noul })).filter((x) => Number.isFinite(x.p));
  const best = pods.sort((a, b) => b.p - a.p)[0] || null;
  const media = answers?.media_or_poll?.noul, rec = answers?.recreatable?.noul, two = answers?.two_needs?.noul;
  const checks = [];
  if (Number.isFinite(media)) checks.push({ reason: 'media_or_poll', fires: media >= flagAt, strength: dist(media, flagAt) });
  if (Number.isFinite(rec)) checks.push({ reason: 'not_recreatable', fires: rec < low, strength: dist(rec, low) });
  if (best) checks.push({ reason: 'no_natural_pod', fires: best.p < podFit, strength: dist(best.p, podFit) });
  else checks.push({ reason: 'no_eligible_pod', fires: true, strength: 1 });
  const fired = checks.filter((c) => c.fires);
  const notes = Number.isFinite(two) && two < twoNeeds ? ['one_need'] : [];
  const bestPod = best && best.p >= podFit ? best.id : null;
  const confidence = fired.length ? Math.max(...fired.map((c) => c.strength)) : Math.min(...checks.map((c) => c.strength));
  return { action: fired.length ? 'swap' : 'keep', confidence: Math.min(1, +confidence.toFixed(6)), reasons: fired.map((c) => c.reason), notes, bestPod };
}

// ---- Eval adapter (scripts/jev-eval.mjs) ---------------------------------------------------------------
/**
 * Labels: evals/jev/donor-writeability.jsonl (scripts/donor-labels.mjs), one donor per row, hash only.
 * Field `swap` (binary): the policy's action. Its sweep score is the strongest swap trigger (media noul,
 * 1 − recreatable, 1 − best pod noul; 1 with no eligible pod): a ranking, not a probability. Pods are
 * chosen the way scripts/run-jev.mjs donorDecisions does (eligiblePods over pods.json).
 */
export const EVAL = Object.freeze({
  labels: 'donor-writeability',
  batchSize: 1,
  fields: Object.freeze({ swap: { type: 'binary', score: 'swapScore' } }),
  loadItem: async (row, ctx) => (await import('../scripts/donor-labels.mjs')).loadDonorItem(row, ctx),
  async toInput([it]) {
    const [checks, { PODS }] = await Promise.all([import('../checks.mjs'), import('../pods.mjs')]);
    return { hook: it.hook, tweets: it.tweets, pods: eligiblePods(`${it.hook}\n${it.tweets.join('\n')}`, PODS, checks) };
  },
  predict(answers, thresholds, input) {
    const v = policy(answers, thresholds, { input });
    const n = (k) => answers?.[k]?.noul;
    const pods = podsOf(input).map((_, i) => n(`pod_${POD_KEYS[i]}`)).filter(Number.isFinite);
    const rec = n('recreatable');
    const parts = [n('media_or_poll'), Number.isFinite(rec) ? 1 - rec : null, pods.length ? 1 - Math.max(...pods) : 1].filter(Number.isFinite);
    return [{ swap: { value: v.action === 'swap', prob: Math.max(...parts) } }];
  },
  async incumbent(input) { return [{ swap: { value: (await incumbent(input)).action === 'swap' } }]; },
});
