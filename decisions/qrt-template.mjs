// decisions/qrt-template.mjs — which QRT shelf templates can this quoted post carry? (plan v7 N4 and
// Track I: "/qrt: nine quoted-post signals → nouls"; owner, 2026-09-23: "become jev native".)
//
// The qrt skill (§1) reads a quoted post for nine signals and each signal unlocks named templates; "if a
// signal is absent, the template that needs it is out". Jev reads the eight text signals as yes/no; the
// clip signal is a fact the caller passes (`hasClip`), not a reading. Code maps the signals to the
// skill's own table (UNLOCKS, copied verbatim) and returns the shortlist; "Nothing special" templates are
// the shortlist only when no signal holds. A signal in the uncertain band is not counted, and the answer
// says so. ADVISORY: the writer still ranks, picks the mix and fills the slots.
//
// Input: { post, hasClip? } — the quoted post's text (first 2,000 chars).
import { noul } from '../jev.mjs';

export const name = 'qrt-template';
export const safety = false;
export const ACTIONS = Object.freeze(['shortlist', 'unsure']);
export const HOLD = 'unsure';

// .claude/skills/qrt/SKILL.md §1, the signal table, unchanged.
export const UNLOCKS = Object.freeze({
  authority: ['S12', 'S13'],
  step_count: ['S4', 'S13'],
  one_promise: ['S2', 'S3', 'O16'],
  price_contrast: ['S15'],
  capabilities: ['O18'],
  counterintuitive: ['S16', 'O15'],
  read_time: ['S10'],
});
// The clip unlocks "every template whose {Shelf Use} says 'wants the clip'"; the shelf lives outside this
// repo (qrt SKILL.md §0), so the answer flags it for the writer instead of naming ids it cannot see.
export const CLIP_NOTE = 'plus every shelf template whose {Shelf Use} says "wants the clip"';
export const NOTHING_SPECIAL = Object.freeze(['S1', 'S14', 'O3', 'O5', 'O11']);

const yes = (q, t, f) => noul(q, { true: t, false: f });
export const QUESTIONS = Object.freeze({
  authority: yes('Does `post` quote a named person saying a real, quotable line?', 'A named person (expert, founder, author) and a line they actually said.', 'No named person, or only a paraphrase or a vague "experts say".'),
  step_count: yes('Does `post` lay out a numbered method or a stated number of steps?', 'A method with numbered steps, or "N steps / N ways" that it then delivers.', 'No method with a count.'),
  one_promise: yes('Does `post` make one clean promise or outcome the reader gets?', 'One outcome stated plainly ("sleep through the night", "cut your bill in half").', 'Several outcomes, or none.'),
  price_contrast: yes('Does `post` contrast a price or cost (cheap vs expensive, free vs paid)?', 'Two prices or costs set against each other.', 'No price contrast.'),
  capabilities: yes('Does `post` show several distinct capabilities of one thing at once?', 'One product, tool or person shown doing several different things.', 'One capability or none.'),
  counterintuitive: yes('Does `post` state a rule that runs against what most readers believe?', 'A rule most readers would expect to be the other way round.', 'Advice most readers already accept.'),
  read_time: yes('Does `post` state how long it takes to read or watch?', 'A stated read or watch time ("a 6-minute read").', 'No stated time.'),
});

export function stateOf(input = {}) {
  const post = String(input.post ?? '').trim().slice(0, 2000);
  if (!post) throw new Error('qrt-template: no post');
  return { post };
}

/** No code incumbent: the writer read the signals in prose. */
export async function incumbent() { return { action: 'unsure' }; }

/**
 * Pure. thresholds: { signalAt, clearAt }. A signal counts at noul >= signalAt; one between clearAt and
 * signalAt is uncertain (listed, not counted). Returns { action, confidence, signals, uncertain, templates, clip? }.
 */
export function policy(answers, thresholds, { input = {} } = {}) {
  const { signalAt, clearAt } = thresholds || {};
  if (!Number.isFinite(signalAt) || !Number.isFinite(clearAt)) throw new Error('qrt-template: thresholds.signalAt and clearAt are required');
  const p = (k) => answers?.[k]?.noul;
  if (Object.keys(QUESTIONS).some((k) => !Number.isFinite(p(k)))) throw new Error('qrt-template: no answer');
  const signals = Object.keys(UNLOCKS).filter((k) => p(k) >= signalAt);
  const uncertain = Object.keys(UNLOCKS).filter((k) => p(k) > clearAt && p(k) < signalAt);
  const templates = [...new Set(signals.flatMap((k) => UNLOCKS[k]))];
  const shortlist = templates.length ? templates : [...NOTHING_SPECIAL];
  // Confidence follows the bands, not distance from 0.5: a clear yes (>= signalAt) or a clear no
  // (<= clearAt) is certain, so the answer is sure (1) unless a signal sits in the uncertain band (0.5,
  // under decide()'s floor, with the signal named in `uncertain`).
  return {
    action: uncertain.length ? 'unsure' : 'shortlist', confidence: uncertain.length ? 0.5 : 1,
    signals: input.hasClip ? [...signals, 'clip'] : signals, uncertain, templates: shortlist,
    ...(input.hasClip ? { clip: CLIP_NOTE } : {}),
  };
}
