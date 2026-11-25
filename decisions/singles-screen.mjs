// decisions/singles-screen.mjs — may this health single post on a supplement-education page?
// (plan Track E "Singles gates", I `/week-singles`; owner, 2026-09-23: "implement: 2,3,4, 6 first".)
//
// plan-singles.mjs rejectReason() judges meaning with about twenty regexes: on topic (a keyword list),
// off niche, commerce, smear, remedy clickbait, sexual, Rx drug, inherited claim, fabricated biography.
// A regex matches words, so it both misses (curly apostrophes disarmed 52 of 294 posts on 2026-09-14)
// and over-fires (a trusted creator's list post reads as "anonymous remedy"). Jev reads the post.
//
// How the two combine (singlesVerdict in plan-singles.mjs):
//   mechanical gates (link, mention, funnel, English, clipped, dangling, stale year) stay code, always
//   safety classes are MONOTONE: a regex hit or a Jev flag rejects; Jev never clears a safety regex
//   topic classes (on topic, off niche, commerce): Jev decides; the regex hit is kept as context
//   an unread post keeps the regex's answer
//
// Input: { text, regexReason? }.
import { noul } from '../jev.mjs';

export const name = 'singles-screen';
export const ACTIONS = Object.freeze(['post', 'reject']);
export const HOLD = 'reject';
export const safety = false; // the monotone OR is applied per class in plan-singles singlesVerdict

export const MAX_CHARS = 1500;

/** Classes Jev can only ADD (a regex hit stands whatever Jev reads). */
export const SAFETY_CLASSES = Object.freeze(['sexual', 'smear', 'rx_drug', 'claim', 'remedy', 'biography']);
/** Classes Jev decides; a regex hit is context. */
export const TOPIC_CLASSES = Object.freeze(['off_topic', 'off_niche', 'commerce']);

export const QUESTIONS = {
  health_post: noul('Would a follower of a health and fitness page see `post` as belonging there: the reader\'s health, body or mind, food, supplements, sleep, training, weight, energy, stress or mood, healthy habits, or the value of being fit and healthy?', {
    true: 'It belongs on a health and fitness page, including a motivational line or aphorism about fitness, health or healthy living.',
    false: 'It is about something else: sport results, gadgets, money, religion, politics, animals, stunts, or life advice with no health angle.' }),
  off_niche: noul('Is `post` about politics, government, news events, violence, crime, war or culture-war topics?', {
    true: 'It takes up a political, news, violent or culture-war subject, even to make a health point.',
    false: 'None of those subjects are its topic.' }),
  commerce: noul('Is `post` mainly selling or pricing a product: a deal, a price, a drop, a gadget or shoe release?', {
    true: 'Its point is a product to buy or its price.',
    false: 'It does not sell; naming a food or a supplement while teaching is not selling.' }),
  sexual: noul('Does `post` give sexual-behaviour advice (masturbation, porn, ejaculation, semen retention) or use manosphere framing (alpha or beta males, red pill)?', {
    true: 'It does.',
    false: 'It does not; hormones, libido and testosterone as health topics are fine.' }),
  smear: noul('Does `post` call a named brand or product poison, or say the drug industry or "they" hide a cure or the truth?', {
    true: 'It smears a brand or pushes a suppression story.',
    false: 'It does not.' }),
  rx_drug: noul('Does `post` present a prescription drug or research peptide (for example metformin, rapamycin, semaglutide, BPC-157) as something to take?', {
    true: 'It recommends or lists one to take.',
    false: 'It does not, or it argues against taking one.' }),
  claim: noul('Does `post` state that something cures, treats, reverses or prevents a disease (cancer, diabetes, dementia and the like), or give a dose or a study result as settled fact?', {
    true: 'It makes a medical claim of that kind.',
    false: 'It gives general health advice without a disease cure, a dose or a study result stated as fact.' }),
  remedy: noul('Does `post` hide its remedy behind "this" or "these" (eat this, drink this, replace X with this) while promising a result in the body, without saying what the remedy is?', {
    true: 'The remedy is hidden and the body result is promised.',
    false: 'It names its remedy or makes no such promise.' }),
  biography: noul('Does `post` tell a first-person life story: the writer\'s family, clients or patients, a place they lived or visited, their age, their routine, or a change they made in their own life?', {
    true: 'It narrates the writer\'s own life, which a page reposting it could not have lived.',
    false: 'It gives advice or a stance without narrating the writer\'s own life.' }),
};

export function stateOf(input = {}) {
  const post = String(input.text ?? '').trim().slice(0, MAX_CHARS);
  if (!post) throw new Error('singles-screen: no text');
  return { post };
}

/** The code's answer: rejectReason() already ran; its reason is passed in. */
export async function incumbent(input = {}) {
  return { action: input.regexReason ? 'reject' : 'post', reason: input.regexReason || null };
}

/**
 * Pure. thresholds: { flagAt, onTopicAt }. The classes Jev reads: every safety noul at flagAt or above,
 * off_niche and commerce at flagAt or above, and off_topic when health_post is below onTopicAt.
 * Returns { action, confidence, classes }; plan-singles singlesVerdict combines it with the regex.
 */
export function policy(answers, thresholds) {
  const flagAt = thresholds?.flagAt, onTopicAt = thresholds?.onTopicAt;
  if (!Number.isFinite(flagAt) || !Number.isFinite(onTopicAt)) throw new Error('singles-screen: thresholds.flagAt and onTopicAt are required');
  const n = (k) => answers?.[k]?.noul;
  if (!Object.keys(QUESTIONS).some((k) => Number.isFinite(n(k)))) throw new Error('singles-screen: no answers');
  const classes = [];
  for (const k of [...SAFETY_CLASSES, 'off_niche', 'commerce']) if (Number.isFinite(n(k)) && n(k) >= flagAt) classes.push(k);
  if (Number.isFinite(n('health_post')) && n('health_post') < onTopicAt) classes.push('off_topic');
  const unread = Object.keys(QUESTIONS).filter((k) => !Number.isFinite(n(k)));
  const worst = Math.max(0, ...[...SAFETY_CLASSES, 'off_niche', 'commerce'].map((k) => (Number.isFinite(n(k)) ? n(k) : 0)),
    Number.isFinite(n('health_post')) ? 1 - n('health_post') : 0);
  const action = classes.length ? 'reject' : 'post';
  return { action, confidence: +(action === 'reject' ? worst : 1 - worst).toFixed(4), classes, unread };
}
