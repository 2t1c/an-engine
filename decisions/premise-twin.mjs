// decisions/premise-twin.mjs — are two rows of one run the same idea? (plan §S "Catch rows early":
// "kim and magnus pots with near-identical text; magnus dropped at scheduling -> Selection:
// premise-twin check across the run's rows, code 4-gram overlap + Jev 'same idea' score".)
//
// Owner, 2026-09-23, approving it ("implement: 2,3,4, 6 first"). The code check (run-rules.mjs
// runTwinIssues) catches near-identical WORDS; Run 5 showed an identical-premise pair at 3.8% overlap
// passing it. Jev reads the two threads and answers whether a reader who saw both would feel they read
// the same thread twice. Monotone: a Jev twin can add a hold, never clear the code's.
//
// Input: { a: { hook, tweets }, b: { hook, tweets }, incumbentOverlap? }.
import { noul, score } from '../jev.mjs';

export const name = 'premise-twin';
export const ACTIONS = Object.freeze(['twin', 'distinct']);
export const HOLD = 'twin';
export const safety = false;

export const MAX_TWEETS = 16; // a reordered copy must be seen whole: at 8, a reversed 14-tweet twin read as distinct
export const MAX_TWEET_CHARS = 400;

export const QUESTIONS = {
  same_idea: score('How close are the ideas of `thread_a` and `thread_b` (their promise, their argument and what the reader is told to do)?', [
    'Different ideas: a different subject, or the same broad subject argued to a different end.',
    'The same subject, but a different premise, list or protocol: a reader would learn something new from the second.',
    'The same premise: the same promise and the same argument, only reworded or reordered.',
  ]),
  read_twice: noul('Would a reader who saw both threads on the same day feel they had read the same thread twice?', {
    true: 'Yes: the second gives the reader nothing the first did not.',
    false: 'No: the second gives the reader a different idea, list or protocol.' }),
};

const side = (x = {}) => {
  const tweets = (Array.isArray(x.tweets) ? x.tweets : []).map((t) => String(t ?? '').slice(0, MAX_TWEET_CHARS)).slice(0, MAX_TWEETS);
  const hook = String(x.hook ?? tweets[0] ?? '').slice(0, MAX_TWEET_CHARS);
  if (!hook && !tweets.length) throw new Error('premise-twin: a side has no text');
  return { hook, tweets };
};

export function stateOf(input = {}) {
  return { thread_a: side(input.a), thread_b: side(input.b) };
}

/** The code's answer: word 4-gram overlap at laws.json selection.donorOverlapWarn (run-rules.mjs). */
export async function incumbent(input = {}) {
  if (Number.isFinite(input.incumbentOverlap)) {
    const { LAWS } = await import('../laws.mjs');
    return { action: input.incumbentOverlap >= LAWS.selection.donorOverlapWarn ? 'twin' : 'distinct', overlap: input.incumbentOverlap };
  }
  const { bodyOverlap } = await import('../checks.mjs');
  const a = stateOf(input).thread_a.tweets, b = stateOf(input).thread_b.tweets;
  const overlap = Math.max(bodyOverlap(a, b), bodyOverlap(b, a));
  const { LAWS } = await import('../laws.mjs');
  return { action: overlap >= LAWS.selection.donorOverlapWarn ? 'twin' : 'distinct', overlap };
}

const need = (t, k) => {
  if (!Number.isFinite(t?.[k])) throw new Error(`premise-twin: thresholds.${k} is required`);
  return t[k];
};

/**
 * Pure. thresholds: { twinScoreAt, readTwiceAt }. A twin when the premise score reaches twinScoreAt or
 * read_twice reaches readTwiceAt. The score is already the probability-weighted level, so no separate
 * confidence floor: a reordered copy scored 1.59 at confidence 0.38 (P(same premise) 0.59) and a floor
 * of 0.6 would have passed it.
 */
export function policy(answers, thresholds) {
  const at = need(thresholds, 'twinScoreAt'), twiceAt = need(thresholds, 'readTwiceAt');
  const s = answers?.same_idea, t = answers?.read_twice;
  if (!Number.isFinite(s?.score) && !Number.isFinite(t?.noul)) throw new Error('premise-twin: no answers');
  const byScore = Number.isFinite(s?.score) && s.score >= at;
  const byTwice = Number.isFinite(t?.noul) && t.noul >= twiceAt;
  const twin = byScore || byTwice;
  const reasons = [
    ...(byScore ? [`same premise (${s.score.toFixed(2)} of 2)`] : []),
    ...(byTwice ? [`a reader would read it twice (${t.noul.toFixed(2)})`] : []),
  ];
  const confidence = twin ? Math.max(byTwice ? t.noul : 0, byScore ? s.score / 2 : 0) : 1 - Math.max(Number.isFinite(t?.noul) ? t.noul : 0, Number.isFinite(s?.score) ? s.score / 2 : 0);
  return { action: twin ? 'twin' : 'distinct', confidence: +confidence.toFixed(4), reasons };
}
