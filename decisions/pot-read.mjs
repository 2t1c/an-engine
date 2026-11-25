// decisions/pot-read.mjs — the owner's pot and seed hook rules, read by Jev (plan v7 N4, I `/pot` and
// `/seed-mint`; owner, 2026-09-23: "become jev native").
//
// /pot and /seed-mint check a hook against rules the owner wrote while striking real pots (pot SKILL
// 2d no imagery, 2e one subject, 2g nothing harsh, and "the reader knows their own answer"). The agent
// read them in prose. Jev reads them; the skill asks for a rewrite of whatever it flags. Advice to the
// writer, never a gate: pot-gate.mjs and the drafts stop still decide what ships.
//
// Input: { hook }.
import { noul } from '../jev.mjs';

export const name = 'pot-read';
export const ACTIONS = Object.freeze(['ok', 'rewrite']);
export const HOLD = 'rewrite';
export const safety = false;

export const QUESTIONS = {
  imagery: noul('Does `hook` use a metaphor or visual imagery where it could name the thing plainly ("stairs stopped being an event", "my body was running on fumes")?', {
    true: 'It uses a figure of speech or an image instead of naming the thing.',
    false: 'It names things plainly and specifically.' }),
  subject_switch: noul('Does a sentence in `hook` switch its grammatical subject midway, so the reader has to re-orient ("I was 52, and 2 flights of stairs left me holding the rail")?', {
    true: 'A sentence starts about one subject and ends about another.',
    false: 'Each sentence keeps one subject.' }),
  harsh: noul('Does `hook` borrow a medical emergency, a family member in danger, or a scare for its stakes (an ambulance, a hospital night, a collapse)?', {
    true: 'It uses an emergency, a family member in trouble or a scare.',
    false: 'Its stakes are everyday: a symptom, a goal, a habit.' }),
  reader_answers: noul('Would a reader know their own answer to `hook` straight away, without thinking (is it about them, in words they use)?', {
    true: 'A reader instantly knows whether it is about them.',
    false: 'A reader has to work out what it means or whether it applies to them.' }),
};

export function stateOf(input = {}) {
  const hook = String(input.hook ?? '').trim().slice(0, 600);
  if (!hook) throw new Error('pot-read: no hook');
  return { hook };
}

/** No code incumbent: these rules were read in prose. */
export async function incumbent() { return { action: 'ok' }; }

/** Pure. thresholds: { flagAt }. rewrite when a failure noul reaches flagAt, or reader_answers falls below 1 - flagAt. */
export function policy(answers, thresholds) {
  const at = thresholds?.flagAt;
  if (!Number.isFinite(at)) throw new Error('pot-read: thresholds.flagAt is required');
  const n = (k) => answers?.[k]?.noul;
  if (!Object.keys(QUESTIONS).every((k) => Number.isFinite(n(k)))) throw new Error('pot-read: no answers');
  const reasons = [
    ...(n('imagery') >= at ? [`imagery instead of naming (${n('imagery').toFixed(2)})`] : []),
    ...(n('subject_switch') >= at ? [`a sentence switches subject (${n('subject_switch').toFixed(2)})`] : []),
    ...(n('harsh') >= at ? [`harsh or family-in-danger stakes (${n('harsh').toFixed(2)})`] : []),
    ...(n('reader_answers') < 1 - at ? [`a reader cannot answer it at once (${n('reader_answers').toFixed(2)})`] : []),
  ];
  return { action: reasons.length ? 'rewrite' : 'ok', confidence: +(reasons.length ? Math.max(n('imagery'), n('subject_switch'), n('harsh'), 1 - n('reader_answers')) : 1 - Math.max(n('imagery'), n('subject_switch'), n('harsh'), 1 - n('reader_answers'))).toFixed(4), reasons };
}
