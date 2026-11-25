// decisions/topic-stamp.mjs — back-stamp decision (plan Track G, Phase 5 "Learning loops"): which topic
// is a shipped thread about? SHADOW ONLY. The incumbent is classifyTopic (pick-product.mjs), the regex
// every reader uses today; Jev's reading is written as an append-only stamp (scripts/backstamp.mjs) and
// read back only through stamps.mjs. No existing reader switches to it here.
//
// 'general' is split explicitly. A plain Jev topic choice GROWS general (swipe shadow 2026-09-23: 28%
// against the regex's 16%), so the choice offers two general labels instead of one — `general_health`
// (a health subject outside the thirteen buckets) and `not_health` — and a battery of multi-topic nouls
// (`also_<topic>`, one per bucket) lets the policy route a general_health thread to a named topic when
// one of the buckets is still a substantial part of it. What is left in general_health is the real
// remainder, named as such.
//
// Input: { draftId, tweets: [string] } (the thread's spec.tweets). State: { hook, tweets } with links
// removed. Actions: the topics.json keys, 'general' (the incumbent's miss), 'general_health', 'not_health'.
import { classifyTopic } from '../pick-product.mjs';
import { choice, noul } from '../jev.mjs';
import { TOPIC_KEYS as SWIPE_TOPIC_KEYS, TOPIC_LABELS } from '../swipe-classify.mjs';

export const name = 'topic-stamp';
export const safety = false;

// topics.json order, as swipe-classify reads it; its trailing 'general' is the catch-all this splits.
export const TOPIC_KEYS = Object.freeze(SWIPE_TOPIC_KEYS.filter((k) => k !== 'general'));
export const GENERAL_LABELS = Object.freeze({
  general_health: 'a health thread whose main subject is none of the topics above, such as longevity, immunity, eyesight, hydration, posture, cancer or one disease',
  not_health: 'not mainly about the reader\'s body or mental health: money, history, motivation, relationships or news',
});
export const ACTIONS = Object.freeze([...TOPIC_KEYS, 'general', ...Object.keys(GENERAL_LABELS)]);

// ---- Questions (the reviewable set) -----------------------------------------------------------------
// Topic wording is swipe-classify's TOPIC_LABELS, unchanged (existing definitions first); only its
// catch-all 'general' is replaced by the two named halves above.
const NAMED = Object.fromEntries(TOPIC_KEYS.map((k) => [k, TOPIC_LABELS[k]]));
export const QUESTIONS = Object.freeze({
  topic: choice('Which ONE health topic is this X thread mainly about (judge `hook` and `tweets` together)?', { ...NAMED, ...GENERAL_LABELS }),
  ...Object.fromEntries(TOPIC_KEYS.map((k) => [`also_${k}`, noul(`Does a substantial part of this X thread teach or argue about ${TOPIC_LABELS[k]}?`, {
    true: 'Several tweets are about it, or the thread\'s advice depends on it.',
    false: 'It is absent or named only in passing, for example in a product recommendation.',
  })])),
});

const LINK = /https?:\/\/\S+|\{\{LINK\d*\}\}/g;
const clean = (s) => String(s || '').replace(LINK, '').replace(/[ \t]+\n/g, '\n').trim();
export const STATE_MAX_CHARS = 12000;

export function stateOf(input = {}) {
  const tweets = (input.tweets || []).map(clean).filter(Boolean);
  if (!tweets.length) throw new Error('topic-stamp: no tweets');
  let rest = tweets.slice(1);
  // Keep the state bounded; the hook is never cut.
  while (rest.join('\n\n').length > STATE_MAX_CHARS && rest.length > 1) rest = rest.slice(0, -1);
  return { hook: tweets[0], tweets: rest };
}

/**
 * Pure. thresholds = laws.json `jev.decisions.topic-stamp.thresholds` ({ namedRoute }).
 * A named primary stands at its choice confidence. A general primary is routed to the named topic
 * with the strongest `also_` noul when that noul clears `namedRoute` (the split); otherwise the
 * general label stands. Returns `multi`: every topic whose noul clears `namedRoute`, strongest first.
 */
export function policy(answers, thresholds = {}) {
  const { namedRoute } = thresholds;
  if (!Number.isFinite(namedRoute)) throw new Error('topic-stamp: thresholds.namedRoute is required');
  const primary = answers.topic?.choice;
  const conf = answers.topic?.confidence;
  if (!ACTIONS.includes(primary)) throw new Error(`topic-stamp: unknown label ${primary}`);
  const also = TOPIC_KEYS.map((k) => ({ k, n: answers[`also_${k}`]?.noul })).filter((x) => Number.isFinite(x.n)).sort((a, b) => b.n - a.n);
  const multi = also.filter((x) => x.n >= namedRoute).map((x) => x.k);
  if (TOPIC_KEYS.includes(primary)) return { action: primary, confidence: conf, multi, route: 'primary' };
  if (primary === 'general_health' && also[0] && also[0].n >= namedRoute) {
    return { action: also[0].k, confidence: also[0].n, multi, route: 'split' };
  }
  return { action: primary, confidence: conf, multi, route: 'general' };
}

/** The regex every reader uses today: hook first, the body only when the hook misses. */
export function incumbent(input = {}) {
  const tweets = (input.tweets || []).map(clean);
  return { action: classifyTopic(tweets[0] || '', tweets.slice(1).join('\n\n') || null) };
}
