// decisions/aie-lane.mjs — is this Hail Mary backlog post really about AI? (Owner, 2026-09-24: wire Jev
// into ai-evo-weekly.) The AI Evolution page is filled every Sunday from the backlog. Code admits a
// row to the AI lane with a keyword list (ai-evo-weekly.mjs isAiLane): "compute", "chips", "agents",
// "automation", "Optimus", "Cursor"… match posts about travel agents, potato chips and a car's cursor,
// which is how a devotional post and a Starlink post with a "summary by Grok" footer got in.
//
//   code   admits the row (isAiLane: topics, niche, format, off-lane words, the keyword hit)
//   Jev    reads the post: is it mainly about AI?
//   code   keeps the row only when Jev reads it at laneAt or above; below, the row is skipped and the
//          slot goes to the next candidate. Jev only removes: a row the keywords refused is never read.
//          Unread: the keyword admission stands, as before.
//
// Input: { text }.
import { noul } from '../jev.mjs';

export const name = 'aie-lane';
export const ACTIONS = Object.freeze(['in', 'out']);
export const HOLD = 'out';
// Monotone: Jev can take a post out of the lane, never put one in. A wrong "out" costs one backlog
// row (the next candidate takes the slot); a wrong "in" puts off-topic content on the page.
export const safety = true;
const MAX_CHARS = 2000;

export function stateOf(input = {}) {
  const post = String(input.text ?? '').trim().slice(0, MAX_CHARS);
  if (!post) throw new Error('aie-lane: no text');
  return { post };
}

export const QUESTIONS = Object.freeze({
  about_ai: noul('Is `post` mainly about artificial intelligence: AI models, AI tools and products, AI companies and research, robots and self-driving, the chips and data centres AI runs on, or the people building AI?', {
    true: 'AI or the AI industry is the subject: the post informs, argues or shows something about it.',
    false: 'The subject is something else (travel, food, space flight, business, religion, a meme, a person\'s life) and AI is absent or only a passing mention, a tool credit or a footer.',
  }),
});

/** The code's answer today: the keyword admission stands. */
export async function incumbent() {
  return { action: 'in' };
}

/** Pure. thresholds: { laneAt }. In at laneAt or above; out below, with confidence 1 − p. */
export function policy(answers, thresholds) {
  const laneAt = thresholds?.laneAt;
  if (!Number.isFinite(laneAt)) throw new Error('aie-lane: thresholds.laneAt is required');
  const p = answers?.about_ai?.noul;
  if (!Number.isFinite(p)) throw new Error('aie-lane: no answer');
  return p >= laneAt ? { action: 'in', confidence: +p.toFixed(4), p } : { action: 'out', confidence: +(1 - p).toFixed(4), p };
}
