// decisions/article-format.mjs — which of the ten X Article formats fits this source? (plan v7 N4:
// "write-article: `article-format` choice"; owner, 2026-09-23: "become jev native".)
//
// write-article §2 picked the format in prose ("Pick one of the ten … GTX pieces from a podcast idea are
// usually Explainer with a Prediction spine"); the classifier it once cited was never committed. The
// option texts are style/article-patterns.md §2's own openings, one line each (existing definitions
// first). Below the floor the answer is 'unsure' and the writer picks as before. ADVISORY: the skill
// shows the pick; nothing is written on it.
//
// Input: { source } — the source post's text or the podcast idea/transcript excerpt (first 4,000 chars).
import { choice } from '../jev.mjs';

export const name = 'article-format';
export const safety = false;

export const FORMATS = Object.freeze({
  'How-To / System': 'teaches a named system the reader follows step by step, with steps as headings and money or time math',
  'Tool Tutorial': 'teaches one tool: opens on a proof number about it, then steps, use cases and copy-paste prompts',
  Listicle: 'a numbered list of items grouped into parts, with the shortest preamble and a recap',
  'Contrarian Thesis': 'opens on a dated event, names what most people are getting wrong about it, then argues a narrower claim',
  Explainer: 'explains one idea through authority quotes or a failed personal experiment, using one borrowed mechanism as the lens',
  Framework: 'tells the origin story of a named framework, then one section per step of it',
  Prediction: 'argues what stays true as things change, as numbered ideas, and hands the decision back to the reader',
  Story: 'opens in a scene or a person\'s life, with named chapters; the mechanism arrives late',
  Letter: 'first-person lessons from a life (age and scars), each heading a one-sentence lesson',
  'Market Analysis': 'an event, its date and the reader\'s deadline, heavy on numbers, with findings as headings',
});
export const UNSURE = 'unsure';
export const ACTIONS = Object.freeze(['pick', UNSURE]);
export const HOLD = UNSURE;

export const QUESTIONS = Object.freeze({
  format: choice('Which X Article format fits `source` best: the piece a writer should build from this material?', { ...FORMATS }),
});

export function stateOf(input = {}) {
  const source = String(input.source ?? '').trim().slice(0, 4000);
  if (!source) throw new Error('article-format: no source');
  return { source };
}

/** No code incumbent: the writer picked in prose. */
export async function incumbent() { return { action: UNSURE }; }

/** Pure. thresholds: { floor }. Returns { action, confidence, format }. */
export function policy(answers, thresholds) {
  if (!Number.isFinite(thresholds?.floor)) throw new Error('article-format: thresholds.floor is required');
  const a = answers?.format;
  if (typeof a?.choice !== 'string') throw new Error('article-format: no answer');
  const sure = Object.hasOwn(FORMATS, a.choice) && a.confidence >= thresholds.floor;
  return { action: sure ? 'pick' : UNSURE, confidence: +(a.confidence ?? 0).toFixed(4), format: sure ? a.choice : null };
}
