// decisions/hook-bank-curate.mjs — may this winner hook teach the hook bank?
// (plan I/H6 "Hook bank curation"; v7 N3; owner, 2026-09-23: "become jev native".)
//
// refresh-hook-bank.mjs builds learnings/hook-bank.json, the corpus hookStrength scores our hooks
// against. Two regexes keep junk out: JUNK (video/photo formats) and OFF_STYLE (a word list for
// politics, religion and philosophy prose, plus quote cards). A word list misses the same things in
// other words and cannot see reply-bait. Jev reads each candidate; exclusion is MONOTONE: the regex or
// Jev keeps a hook out, neither lets one in the other refused. An unread hook keeps the regex answer.
//
// Input: { hook }.
import { noul } from '../jev.mjs';

export const name = 'hook-bank-curate';
export const ACTIONS = Object.freeze(['keep', 'exclude']);
export const HOLD = 'exclude';
export const safety = true; // monotone: an exclusion from either side stands

export const QUESTIONS = {
  media_dependent: noul('Does `hook` only make sense while looking at a video, photo or image ("watch this", "look at this", a caption)?', {
    true: 'It points at media the reader has to see.',
    false: 'It stands on its own as text.' }),
  off_style: noul('Is `hook` outside the health-education style of a supplement page: politics, religion, society or philosophy prose, or a quote card attributed to a famous person?', {
    true: 'It is about politics, religion, society or philosophy, or it is a quote card.',
    false: 'It is a hook about the reader\'s health, body, mind or habits.' }),
  reply_bait: noul('Is `hook` mainly a question or prompt that fishes for replies ("what would you add?", "agree?") rather than a promise the thread keeps?', {
    true: 'It asks for replies instead of promising something.',
    false: 'It promises the reader something the thread delivers.' }),
};

export function stateOf(input = {}) {
  const hook = String(input.hook ?? '').trim().slice(0, 500);
  if (!hook) throw new Error('hook-bank-curate: no hook');
  return { hook };
}

/** The code's answer: refresh-hook-bank's JUNK / OFF_STYLE regexes, passed in as input.regexExcluded. */
export async function incumbent(input = {}) {
  return { action: input.regexExcluded ? 'exclude' : 'keep' };
}

/** Pure. thresholds: { excludeAt }. Excluded when any noul reaches it. */
export function policy(answers, thresholds) {
  const at = thresholds?.excludeAt;
  if (!Number.isFinite(at)) throw new Error('hook-bank-curate: thresholds.excludeAt is required');
  const vals = Object.keys(QUESTIONS).map((k) => [k, answers?.[k]?.noul]);
  if (!vals.every(([, v]) => Number.isFinite(v))) throw new Error('hook-bank-curate: no answers');
  const hits = vals.filter(([, v]) => v >= at).map(([k]) => k);
  const worst = Math.max(...vals.map(([, v]) => v));
  return { action: hits.length ? 'exclude' : 'keep', confidence: +(hits.length ? worst : 1 - worst).toFixed(4), reasons: hits };
}
