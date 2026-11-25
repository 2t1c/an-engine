// clip-judge.mjs — Jev's clip judgments and the rules that turn them into decisions (docs/typesafe-jev.md
// "Clip judgments"). Two directions over one set of questions:
//
//   MINE   passage -> is this a clip worth cutting?   CLIP_QUESTIONS, one Jev call per candidate passage.
//   MATCH  tweet   -> which passage or stored clip proves it?   SUPPORT_QUESTIONS, one call per pair,
//          after a lexical shortlist in code (the TypeSafe re-ranking pattern). Stored clips
//          (clip-library.mjs) and fresh passages compete in the same ranking; a stored clip wins when it
//          fits nearly as well, because it is already cut.
//
// Jev never picks timestamps and never writes text: code cuts the candidate windows, Jev answers typed
// questions about each, and the named rules below decide. Questions and thresholds live here, in one
// place, so a human can review them (AGENTS.md). The thresholds are FIRST GUESSES, not calibrated: tune
// them on labelled passages before any decision here ships a post on its own.
//
// Transcript fetching and cutting are deliberately out of scope: the input is timestamped segments
// ({start, end?, text, speaker?}, seconds), from wherever the podcast pool gets them.
import { choice, noul, score } from './jev.mjs';
import { breakerReason, questionSetHash } from './swipe-classify.mjs';

// ---- The questions (edit wording => the hash changes => stored scores are no longer comparable) ------
export const CLIP_QUESTIONS = {
  claim: noul('Does the speaker in `passage` state one specific claim that could open an X post written as "[Speaker] says [claim]"?', {
    true: 'The speaker commits to a specific claim: it contains a number, or names a specific thing (a nutrient, food, drug, disease, body part, study, person or company), or takes a position that some people would argue against.',
    false: 'There is no such claim: small talk, a story with no point, a question, a vague generality such as "health matters", thanks, or a sponsor read.',
  }),
  arguable: score('How strongly would the main claim in `passage` make a reader stop scrolling?', [
    'There is no claim, or it is common knowledge most readers already accept, such as "exercise is good for you".',
    'A useful, specific claim that most readers would find reasonable and expected.',
    'A surprising, counter-intuitive or contrarian claim, or a striking number, that many readers would want to argue with or share.',
  ]),
  self_contained: score('Can a viewer who has not seen the rest of the podcast follow `passage` on its own?', [
    'No: it depends on earlier context, such as "that", "it" or "he" with nothing in `passage` saying what they refer to, or it answers a question that is not in `passage`.',
    'Mostly: the point is clear, but one reference or term is left unexplained.',
    'Yes: everything needed to understand the point is inside `passage`.',
  ]),
  clean_start: noul('Does `passage` begin at the start of a sentence that opens a point?', {
    true: 'The first words start a sentence and begin the point being made (a short question from the host that sets up the point also counts).',
    false: 'It begins partway through a sentence, or partway through an argument that started earlier.',
  }),
  clean_end: noul('Does `passage` end after the speaker has finished the point?', {
    true: 'The last sentence is complete and the point has landed.',
    false: 'It stops partway through a sentence, or just before the conclusion or the payoff.',
  }),
  single_point: noul('Does `passage` make one main point, rather than moving between several unrelated topics?', {
    true: 'Everything in `passage` builds one main point or one claim, with its explanation or example.',
    false: 'It moves between two or more unrelated topics, so no single post could describe the whole clip.',
  }),
  ad_read: noul('Is any part of `passage` a sponsor message or an advertisement read?', {
    true: 'It contains a sponsor read: "brought to you by", a promo code, a discount, or a pitch for a product the show is paid to mention.',
    false: 'No part of it is a sponsor or advertisement read.',
  }),
};

/** An optional topic gate for a run (for example the fleet's health niche). Its hash covers this template. */
export const focusQuestion = (focus) => noul(`Is the main claim in \`passage\` about ${focus}?`, {
  true: `The main point the speaker makes is about ${focus}.`,
  false: `The main point is about something else; ${focus} is absent or only a passing mention.`,
});

export const SUPPORT_QUESTIONS = {
  support: choice('How does what the speaker says in `passage` relate to the claim made in `tweet`?', {
    direct: 'The speaker states the same specific claim as `tweet`: the same fact, number, mechanism or recommendation. A clip of `passage` would prove `tweet`.',
    partial: 'The speaker is on the same topic and backs part of `tweet`, but not its specific point, number or recommendation.',
    unrelated: '`passage` does not address the claim in `tweet`.',
    contradicts: 'The speaker says the opposite of `tweet`, or disputes it.',
  }),
};

// THE HOOK'S MAIN IDEA (owner, 2026-09-28: "maybe cause the hook may have said a lot that the clip specifically
// didn't mention, but if it meets the requirements and does mention the main idea then we can let it through
// (in a way lower the gate)"). Asked only for the hook, and only of on-point candidates the high bar held
// (CLIP_RULES.mainIdea). SUPPORT reads a hook that claims more than a passage says as `partial`, whatever the
// passage's point: a "10,000 steps" aside and the hook's own mechanism both read about 0.1 direct / 0.9 partial.
export const MAIN_IDEA_QUESTIONS = {
  main_idea: noul('Does the speaker in `passage` state the main idea of `tweet`, even if `tweet` adds details, numbers or examples that `passage` does not mention?', {
    true: 'The speaker makes the same central point as `tweet`. Details, numbers or list items `tweet` adds beyond that point do not matter.',
    false: 'The speaker is on a related topic but does not make the central point of `tweet`, or makes only a side point or one list item from it.',
  }),
};

// REELS (owner 2026-10-19, the IG Run's health reels for RM and LR: "choose better snippets — shocking or high
// value, etc... and then clip must be complete. It can be longer than 60s — I guess just under 2 minutes is
// fine. We want to make sure we convey our point completely."). The same passage questions, minus the X-post
// claim framing, plus the two pulls (shock, value) and a completeness check; REEL_RULES weighs them.
export const REEL_QUESTIONS = {
  shock: score('How surprising or alarming would `passage` be to an ordinary person who cares about their health?', [
    'Not surprising: common advice or something most people already know, such as "sleep matters".',
    'Somewhat surprising: a specific fact or mechanism many people have not heard.',
    'Shocking: a striking number, a danger in something people do every day, or a claim that overturns common belief.',
  ]),
  value: score('How useful is `passage` to a viewer who wants to improve their health?', [
    'Not useful: opinion, story or chit-chat with nothing the viewer can learn or do.',
    'Useful: explains how something in the body works, or gives a general recommendation.',
    'Very useful: a specific thing to do, eat, avoid or measure, with the reason or the amount.',
  ]),
  complete: noul('Does `passage` convey its point completely, so a viewer who sees only this clip gets the whole idea?', {
    true: 'It sets up the point, explains it and lands it: the claim and its reason or example are all inside `passage`, and nothing important is cut off at either end.',
    false: 'The point is unfinished: the setup, the explanation or the payoff is missing, or the speaker is still building to it when `passage` ends.',
  }),
  self_contained: CLIP_QUESTIONS.self_contained,
  clean_start: CLIP_QUESTIONS.clean_start,
  clean_end: CLIP_QUESTIONS.clean_end,
  single_point: CLIP_QUESTIONS.single_point,
  ad_read: CLIP_QUESTIONS.ad_read,
};
export const REEL_QUESTIONS_HASH = questionSetHash(REEL_QUESTIONS);

/**
 * The reel bars. Windows run 15-115 s (just under 2 minutes, owner), one around 30 s and one around 75 s from each
 * start (owner 2026-10-20: "If the reel is 15 or 30 seconds, or under a minute long, it's still completely fine as
 * long as … the argument … is complete"; until then they started at 45 s and grew to 75 s); units are short
 * (12 s at most) so a boundary can move by a sentence, and refinement moves each edge up to 2 units, so a
 * window that stops before the payoff can grow into it. pull = the stronger of shock and value: a reel
 * needs one of them, not both. First guesses: tune them on the reels the owner keeps or drops.
 */
export const REEL_RULES = {
  window: { minS: 15, maxS: 115, targetS: [30, 75], strideS: 12 },
  maxUnitS: 12,
  weights: { pull: 0.35, complete: 0.2, self_contained: 0.15, single_point: 0.1, clean_start: 0.1, clean_end: 0.1 },
  gates: { adRead: 0.5, minPull: 0.35, minFocus: 0.5 },
  reel: { minPull: 0.6, minComplete: 0.6, minSelfContained: 0.55, minSinglePoint: 0.5, minCleanStart: 0.5, minCleanEnd: 0.6, minRank: 0.65 },
  refine: { top: 2, maxShiftUnits: 2 },
};

/** Jev's reel answers for one passage -> scores, rank, verdict ('reel' | 'maybe' | 'skip') and why. Pure. */
export function reelDecision(answers = {}, { rules = REEL_RULES, hasFocus = false } = {}) {
  const sc = (k) => (Number.isFinite(answers[k]?.score) ? answers[k].score / 2 : null);
  const nl = (k) => num(answers[k]?.noul);
  const s = { shock: sc('shock'), value: sc('value'), complete: nl('complete'), self_contained: sc('self_contained'), clean_start: nl('clean_start'),
    clean_end: nl('clean_end'), single_point: nl('single_point'), ad_read: nl('ad_read'), focus: hasFocus ? nl('focus') : null };
  s.pull = s.shock == null || s.value == null ? null : Math.max(s.shock, s.value);
  s.kind = s.pull == null ? null : s.shock >= s.value ? 'shock' : 'value';
  if (Object.keys(rules.weights).some((k) => s[k] == null) || s.ad_read == null || (hasFocus && s.focus == null)) {
    return { scores: s, rank: null, verdict: null, reasons: ['incomplete answers'] };
  }
  const rank = Object.entries(rules.weights).reduce((sum, [k, w]) => sum + w * s[k], 0);
  const reasons = [];
  if (s.ad_read >= rules.gates.adRead) reasons.push('sponsor read');
  if (s.pull < rules.gates.minPull) reasons.push('neither shocking nor useful');
  if (hasFocus && s.focus < rules.gates.minFocus) reasons.push('off focus');
  if (reasons.length) return { scores: s, rank, verdict: 'skip', reasons };
  const r = rules.reel;
  const checks = [[s.pull >= r.minPull, 'not strong enough'], [s.complete >= r.minComplete, 'point not complete'], [s.self_contained >= r.minSelfContained, 'needs context'],
    [s.single_point >= r.minSinglePoint, 'several topics'], [s.clean_start >= r.minCleanStart, 'starts mid-thought'], [s.clean_end >= r.minCleanEnd, 'cut off at the end'], [rank >= r.minRank, 'ranks low']];
  for (const [ok, why] of checks) if (!ok) reasons.push(why);
  return { scores: s, rank, verdict: reasons.length ? 'maybe' : 'reel', reasons };
}

// THE REEL PICK (owner 2026-10-19: "optimize our clip selection and idea selection"). MINE finds complete, strong
// passages, but its ranks bunch up (most of the 272 mined reels sat between 0.81 and 0.91) and nothing in it reads
// the first three seconds, which decide whether anyone watches. This second read is asked of every mined reel, and of
// the same reel opened one or two sentences later (the lead-in trimmed), with `opening` the reel's first words:
// the hook, the payoff and how many people it is for rank the reels; the topic spreads the week's ideas.
export const REEL_TOPICS = {
  sleep: 'Sleep, rest, naps, circadian rhythm, insomnia.',
  food: 'Food, diet, sugar, fasting, specific foods or drinks (not alcohol or caffeine).',
  gut: 'The gut, digestion, the microbiome, fibre.',
  metabolism: 'Weight, fat loss, insulin, blood sugar, diabetes, metabolism.',
  heart: 'The heart, blood pressure, cholesterol, arteries, strokes.',
  brain: 'The brain, memory, focus, dementia, mood, mental health, stress hormones.',
  hormones: 'Sex hormones, testosterone, oestrogen, fertility, menopause, the thyroid.',
  exercise: 'Exercise, strength, muscle, cardio, steps, movement, posture.',
  supplements: 'Supplements and vitamins: creatine, magnesium, vitamin D, protein powders.',
  substances: 'Alcohol, caffeine, nicotine, drugs, medicines.',
  aging: 'Ageing, longevity, cancer, the immune system, skin, toxins and the environment.',
  other: 'None of the above.',
};
export const REEL_PICK_QUESTIONS = {
  // owner 2026-10-20: "make sure the intro is not mid sentence — superlative or high controversal is also a good
  // standard to grade the hooks"
  hook: score('A viewer scrolling Instagram hears only `opening`, the first three seconds of a health reel. How likely are they to stop and keep watching?', [
    'Unlikely: filler, a lead-in, words that start in the middle of a sentence, or a flat statement that needs what comes after to mean anything ("So, the thing is…", "And that is why…").',
    'Somewhat: on a clear health topic, but no question, stakes or surprise yet.',
    'Very likely: a superlative ("the No. 1…", "the worst…", "the most dangerous…"), a controversial claim that goes against what most people believe, a question the viewer wants answered, a striking number, or a danger in something they do every day.',
  ]),
  payoff: score('How clearly does `passage` land its point by the end: something the viewer will remember, repeat or do?', [
    'Weakly: it trails off, or ends on a story, a qualification or a new question.',
    'Clearly: the point is made, though the viewer has to work out what to take away.',
    'Strongly: it ends on a memorable takeaway, a specific thing to do, or a reveal that answers the opening.',
  ]),
  broad: score('How many adults would feel `passage` is about them?', [
    'Few: a niche group, a rare condition, athletes, or a technical detail.',
    'Many: a large group, such as coffee drinkers, people who struggle to sleep, or women over 40.',
    'Almost everyone: something nearly every adult does, eats or worries about.',
  ]),
  topic: choice('Which health topic is `passage` mainly about?', { ...REEL_TOPICS }),
  self_contained: REEL_QUESTIONS.self_contained,
  complete: REEL_QUESTIONS.complete,
};
export const REEL_PICK_QUESTIONS_HASH = questionSetHash(REEL_PICK_QUESTIONS);

/**
 * The pick's weights and bars: first guesses, to tune on the reels the owner keeps or drops. `rank` is MINE's own
 * rank (pull, completeness, clean edges); a trimmed opening is kept only when it hooks better and the reel still
 * stands on its own and stays complete.
 */
export const REEL_PICK_RULES = {
  // signal: the opening's simple signals (hookSignals; owner 2026-10-20, after SupoClip: "I like the idea of using
  // simple signals"), a small weight beside Jev's own reading of the hook
  weights: { hook: 0.35, rank: 0.2, payoff: 0.2, broad: 0.15, signal: 0.1 },
  keep: { minSelfContained: 0.55, minComplete: 0.6 },
  trim: { maxSentences: 2, minS: 40, minGain: 0.1 },
  // owner 2026-10-20: "make sure that we're not over-prioritizing long reels. If the reel is 15 or 30 seconds, or
  // under a minute long, it's still completely fine as long as we make sure the argument that we're making is
  // complete … longer reels … may be more diluted". The reel is also read ended early, at a sentence end near each
  // of `targets` seconds; the shortest cut that lands its point as well as the full reel (payoff and completeness
  // within the slack, still ok) is kept.
  cut: { minS: 15, targets: [20, 35, 55], payoffSlack: 0.05, completeSlack: 0.1 },
};

/** Jev's pick answers for one reel (or one trimmed opening of it) -> the pick's scores and its pickRank. Pure. */
export function reelPick(answers = {}, { mineRank = 0, signal = 0, rules = REEL_PICK_RULES } = {}) {
  const sc = (k) => (Number.isFinite(answers[k]?.score) ? answers[k].score / 2 : null);
  const p = answers.topic?.probabilities || {};
  const topic = answers.topic?.choice ?? (Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] || null);
  const s = { hook: sc('hook'), payoff: sc('payoff'), broad: sc('broad'), self_contained: sc('self_contained'), complete: num(answers.complete?.noul), topic, rank: mineRank, signal };
  if (['hook', 'payoff', 'broad', 'self_contained', 'complete'].some((k) => s[k] == null)) return { ...s, pickRank: null, ok: false };
  const pickRank = Object.entries(rules.weights).reduce((sum, [k, w]) => sum + w * (s[k] ?? 0), 0);
  const ok = s.self_contained >= rules.keep.minSelfContained && s.complete >= rules.keep.minComplete;
  return { ...s, pickRank: Math.round(pickRank * 1000) / 1000, ok };
}

/**
 * Simple signals in a reel's opening, read in code (no model, free): the idea is SupoClip's (trigger words, questions,
 * story turns as hints beside the model's reading); the lists are ours, tuned to health reels and the owner's hook
 * rules (superlatives and claims against what most people believe grade top, 2026-10-20). `score` is 0-1. Pure.
 */
export const HOOK_SIGNALS = [
  ['superlative', 2, /\b(no\.? ?1|number one|#1|the (best|worst|most|biggest|single|only|first)|deadliest|healthiest|unhealthiest)\b/i],
  ['against the grain', 2, /\b(myths?|lies?|lied|wrong|actually|stop|never|nobody|no one|most people|everyone thinks|you(?:'ve| have) been (?:told|sold)|the truth|isn'?t healthy|not healthy)\b/i],
  ['stakes', 1.5, /\b(cancer|heart attacks?|strokes?|dementia|alzheimer'?s|die|dying|death|deadly|kills?|killing|toxic|dangerous|damages?|disease|diabetes|obes(?:e|ity)|inflammation)\b/i],
  ['number', 1.5, /\b\d+(?:\.\d+)?\s?(?:%|percent|times|x|fold|years?|days?|hours?|minutes?|grams?|mg)\b|\b(?:half|double|triple|twice|tenfold)\b/i],
  ['question', 1.5, /\?/],
  ['story turn', 1, /\b(?:i|we) (?:thought|realized|found|learned|discovered|noticed|was shocked)\b/i],
  ['to the viewer', 0.5, /\b(?:you|your)\b/i],
];
export const HOOK_SIGNAL_FULL = 5; // points for a full score: two strong signals and a third, or one of each kind
export function hookSignals(opening) {
  const t = String(opening || '').trim();
  if (!t) return { score: 0, reasons: [] };
  const hits = HOOK_SIGNALS.filter(([, , re]) => re.test(t));
  const points = hits.reduce((n, [, w]) => n + w, 0);
  return { score: Math.round(Math.min(1, points / HOOK_SIGNAL_FULL) * 100) / 100, reasons: hits.map(([name]) => name) };
}

/** The opening to keep: the full reel unless a trimmed one hooks clearly better and is still ok. Pure. */
export function bestOpening(variants, { rules = REEL_PICK_RULES } = {}) {
  const full = variants.find((v) => !v.trimmed) || variants[0];
  if (!full) return null;
  const better = variants.filter((v) => v.trimmed && v.pick?.ok && v.pick.pickRank != null && full.pick?.pickRank != null
    && v.pick.hook - full.pick.hook >= rules.trim.minGain && v.pick.pickRank > full.pick.pickRank)
    .sort((a, b) => b.pick.pickRank - a.pick.pickRank)[0];
  return better || full;
}

/**
 * The ending to keep: the shortest cut that is still ok and lands its point as well as the full reel (its payoff
 * and completeness no more than the slack below the full reel's), else the full reel. `full` and `cuts` carry
 * `start`, `end` and `pick`. Pure.
 */
export function bestEnding(full, cuts, { rules = REEL_PICK_RULES } = {}) {
  if (!full?.pick || full.pick.pickRank == null) return full || null;
  const c = rules.cut, f = full.pick;
  const lands = (v) => v.pick?.ok && v.pick.pickRank != null && v.end - v.start >= c.minS
    && v.pick.payoff >= f.payoff - c.payoffSlack && v.pick.complete >= Math.max(rules.keep.minComplete, f.complete - c.completeSlack);
  return cuts.filter(lands).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || full;
}

export const CLIP_QUESTIONS_HASH = questionSetHash(CLIP_QUESTIONS);
export const SUPPORT_QUESTIONS_HASH = questionSetHash(SUPPORT_QUESTIONS);
export const MAIN_IDEA_QUESTIONS_HASH = questionSetHash(MAIN_IDEA_QUESTIONS);

// ---- The decision rules: every number a human might tune --------------------------------------------
export const CLIP_RULES = {
  model: 'jev-1.13', // pinned; never jev-latest
  window: { minS: 20, maxS: 60, targetS: 35, strideS: 8 },
  // MINE: rank = weighted sum of the answers, each scaled to 0..1.
  weights: { claim: 0.35, arguable: 0.2, self_contained: 0.15, single_point: 0.15, clean_start: 0.075, clean_end: 0.075 },
  gates: { adRead: 0.5, minClaim: 0.35, minFocus: 0.5 },
  clip: { minClaim: 0.6, minSelfContained: 1.0, minSinglePoint: 0.5, minCleanStart: 0.3, minCleanEnd: 0.3, minRank: 0.6 }, // all => verdict 'clip', else 'maybe'
  refine: { top: 3, maxShiftUnits: 1 }, // boundary variants are tried for top*N chosen windows
  // MATCH: fit = P(direct) + partialCredit*P(partial) - P(contradicts).
  partialCredit: 0.3,
  // => 'attach': P(contradicts) <= maxContradicts and EITHER P(direct) >= minDirect OR fit >= minFit.
  // minFit (operator 2026-09-24: 'as long as it's on the same line of thought, that's good enough'): a
  // passage Jev reads as mostly partial support now attaches from fit 0.55, where 0.6 direct held
  // 0.55-0.6 picks like 'take berberine with your biggest meals' vs Huberman taking it before carb meals.
  // The hook and the first tweet of a CTA keep their higher bars (highBarRules / strictMatchRules).
  attach: { minDirect: 0.6, minFit: 0.55, maxContradicts: 0.2 },
  review: { minDirectPlusPartial: 0.5 }, // => 'review', else 'none'
  reuseMargin: 0.1, // a stored clip is chosen over a fresh passage whose fit is at most this much higher
  // The first tweet of a CTA (operator 2026-09-24): a clip there must run 30 s or less and clear a higher
  // bar than attach. First guesses, like attach.
  // Strict tweets are matched on their own short windows (a fresh window is otherwise 35-60 s), so both the
  // choice and the boundary refinement happen under these rules (strictMatchRules).
  // The higher bar (the hook; the first tweet of a CTA) asks Jev to be SURE the clip is on the tweet's point,
  // not that it is the exact claim (operator 2026-09-24: 'if it's making a similar point then that's more
  // than enough'): P(direct) + P(partial) >= minOnPoint, P(direct) >= minDirect (the ordinary attach
  // bar: mostly the claim), P(contradicts) <= maxContradicts. A P(direct) bar alone measured exactness:
  // the teeth hook's remineralization clip read direct 0.66 / partial 0.34 / unrelated 0 and was held.
  strict: { maxS: 30, minDirect: 0.6, minOnPoint: 0.9, maxContradicts: 0.1, window: { minS: 15, targetS: 24, maxS: 30, strideS: 6 }, maxUnitS: 12 },
  // Videos per thread (owner, 2026-10-03: "add a max of 3 videos per thread limit when applying clipping —
  // prioritize higher jev score clips"). A clip is always a video, and so is a swipe video, so the /run media
  // pass spends ONE budget across the hook clip, the original hook video, the body clips and swipe videos
  // (scripts/run-media.mjs videoBudget). Over the cap the hook keeps first claim (operator 2026-09-24), then
  // the highest Jev fit wins (capClips).
  perThread: { maxVideos: 3 },
  // The hook's main-idea rescue (owner 2026-09-28, MAIN_IDEA_QUESTIONS): a hook candidate the high bar held
  // still attaches when Jev reads that it states the hook's main idea (P >= min), stays on the hook's point
  // (P(direct)+P(partial) >= minOnPoint) and does not dispute it (P(contradicts) <= maxContradicts). Only the
  // `top` on-point candidates by P(direct) are asked. Set on R2026-09-27's held hooks, read in full: at 0.6 it
  // passed 9 of 12 clips that state the hook's point and 0 of 5 that do not; the direct bar passed none of
  // them, and a lower direct bar (0.45) passed 3 right and 2 wrong. Three of the four nitric oxide hooks, all
  // held at direct 0.14-0.54, read 0.72-0.83 here.
  mainIdea: { min: 0.6, minOnPoint: 0.9, maxContradicts: 0.1, top: 3 },
  shortlist: 20, // lexical candidates per tweet sent to Jev, fresh passages
  libraryShortlist: 10, // and stored clips, ranked separately so long fresh windows never crowd them out
  workers: 12,
  deadlineMs: 20_000,
};

// ---- Candidate passages (code, not Jev) -------------------------------------------------------------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Timestamped segments -> units no longer than maxS/2, each with {start, end, text, speaker}. A segment's
 * end is its own `end`, else the next segment's start. A long segment is split at word counts, its time
 * shared out in proportion (paragraph transcripts carry one timestamp per paragraph). Pure.
 */
export function unitsFromSegments(segments, { maxUnitS = CLIP_RULES.window.maxS / 2 } = {}) {
  const segs = (segments || []).map((s) => ({ start: Number(s.start), end: s.end != null ? Number(s.end) : null, text: clean(s.text), speaker: s.speaker ?? null }))
    .filter((s) => Number.isFinite(s.start) && s.text).sort((a, b) => a.start - b.start);
  const units = [];
  segs.forEach((s, i) => {
    const end = Number.isFinite(s.end) && s.end > s.start ? s.end : i + 1 < segs.length ? segs[i + 1].start : s.start + s.text.split(' ').length / 2.5;
    const words = s.text.split(' ');
    const parts = Math.max(1, Math.ceil((end - s.start) / maxUnitS));
    const per = Math.ceil(words.length / parts);
    for (let p = 0; p < parts; p++) {
      const w = words.slice(p * per, (p + 1) * per);
      if (!w.length) continue;
      const a = s.start + ((end - s.start) * p * per) / words.length;
      const b = s.start + ((end - s.start) * Math.min(words.length, (p + 1) * per)) / words.length;
      units.push({ start: a, end: b, text: w.join(' '), speaker: s.speaker });
    }
  });
  return units;
}

/** Units i..j as one window: {start, end, text, speaker (most words), speakerShare, ui, uj}. Pure. */
export function makeWindow(units, i, j) {
  const span = units.slice(i, j + 1);
  const words = {};
  for (const u of span) words[u.speaker ?? '?'] = (words[u.speaker ?? '?'] || 0) + u.text.split(' ').length;
  const [speaker, n] = Object.entries(words).sort((a, b) => b[1] - a[1])[0];
  const total = Object.values(words).reduce((a, b) => a + b, 0);
  return { start: units[i].start, end: units[j].end, text: span.map((u) => u.text).join(' '),
    speaker: speaker === '?' ? null : speaker, speakerShare: n / total, ui: i, uj: j };
}

/**
 * Candidate windows: start on a unit, add units until targetS, never past maxS, never under minS. `targetS` may be
 * a list (one window per target from the same start: a short and a long telling of the same point). Starts are at
 * least strideS apart, so neighbouring windows overlap but do not repeat. Pure.
 */
export function candidateWindows(units, { minS, maxS, targetS, strideS } = CLIP_RULES.window) {
  const out = [];
  const targets = [].concat(targetS);
  let lastStart = -Infinity;
  for (let i = 0; i < units.length; i++) {
    if (units[i].start - lastStart < strideS) continue;
    const ends = new Set();
    for (const target of targets) {
      let j = i;
      while (j + 1 < units.length && units[j].end - units[i].start < target && units[j + 1].end - units[i].start <= maxS) j++;
      const len = units[j].end - units[i].start;
      if (len < minS || len > maxS || ends.has(j)) continue;
      ends.add(j);
      out.push(makeWindow(units, i, j));
    }
    if (ends.size) lastStart = units[i].start;
  }
  return out;
}

/** The same window with its start and end moved by up to `shift` units each, within minS..maxS. Pure. */
export function boundaryVariants(units, w, { shift = CLIP_RULES.refine.maxShiftUnits, minS = CLIP_RULES.window.minS, maxS = CLIP_RULES.window.maxS } = {}) {
  const out = [];
  for (let di = -shift; di <= shift; di++) {
    for (let dj = -shift; dj <= shift; dj++) {
      if (!di && !dj) continue;
      const i = w.ui + di, j = w.uj + dj;
      if (i < 0 || j >= units.length || j < i) continue;
      const len = units[j].end - units[i].start;
      if (len >= minS && len <= maxS) out.push(makeWindow(units, i, j));
    }
  }
  return out;
}

// ---- Lexical shortlist (fast search before Jev re-ranks) ---------------------------------------------
const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its just like more most my no not of on or our so than that the their them then there these they this to up was we what when which who why will with you your'.split(' '));
export const tokens = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];

/** BM25 over the candidates' texts; returns candidate indices, best first. Pure. */
// `weights` (token -> multiplier) lets a caller weight some query terms over others; unlisted terms count 1.
export function shortlist(query, texts, k = CLIP_RULES.shortlist, { k1 = 1.2, b = 0.75, weights = null } = {}) {
  const docs = texts.map(tokens);
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const q = [...new Set(tokens(query))];
  const scored = docs.map((d, i) => {
    const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += (weights?.get(w) ?? 1) * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return [i, s];
  });
  return scored.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
}

// ---- Reading answers + decisions (pure) --------------------------------------------------------------
const num = (x) => (Number.isFinite(x) ? x : null);

/** Jev's answers for one passage -> the clip's scores, rank and verdict. */
export function clipDecision(answers = {}, { rules = CLIP_RULES, hasFocus = false } = {}) {
  const s = {
    claim: num(answers.claim?.noul), arguable: num(answers.arguable?.score), self_contained: num(answers.self_contained?.score),
    clean_start: num(answers.clean_start?.noul), clean_end: num(answers.clean_end?.noul), single_point: num(answers.single_point?.noul), ad_read: num(answers.ad_read?.noul),
    focus: hasFocus ? num(answers.focus?.noul) : null,
  };
  const scaled = { claim: s.claim, arguable: s.arguable == null ? null : s.arguable / 2, self_contained: s.self_contained == null ? null : s.self_contained / 2,
    clean_start: s.clean_start, clean_end: s.clean_end, single_point: s.single_point };
  if (Object.keys(rules.weights).some((k) => scaled[k] == null) || s.ad_read == null || (hasFocus && s.focus == null)) {
    return { scores: s, rank: null, verdict: null, reasons: ['incomplete answers'] };
  }
  const rank = Object.entries(rules.weights).reduce((sum, [k, w]) => sum + w * scaled[k], 0);
  const reasons = [];
  if (s.ad_read >= rules.gates.adRead) reasons.push('sponsor read');
  if (s.claim < rules.gates.minClaim) reasons.push('no quotable claim');
  if (hasFocus && s.focus < rules.gates.minFocus) reasons.push('off focus');
  if (reasons.length) return { scores: s, rank, verdict: 'skip', reasons };
  const c = rules.clip;
  const verdict = s.claim >= c.minClaim && s.self_contained >= c.minSelfContained && s.single_point >= c.minSinglePoint
    && s.clean_start >= c.minCleanStart && s.clean_end >= c.minCleanEnd && rank >= c.minRank ? 'clip' : 'maybe';
  if (verdict === 'maybe') {
    if (s.claim < c.minClaim) reasons.push('claim unclear');
    if (s.self_contained < c.minSelfContained) reasons.push('needs context');
    if (s.single_point < c.minSinglePoint) reasons.push('several topics');
    if (s.clean_start < c.minCleanStart) reasons.push('starts mid-thought');
    if (s.clean_end < c.minCleanEnd) reasons.push('cut off at the end');
    if (rank < c.minRank) reasons.push('ranks low');
  }
  return { scores: s, rank, verdict, reasons };
}

/** Jev's support answer for one (tweet, passage) pair -> fit and verdict. */
export function supportDecision(answers = {}, { rules = CLIP_RULES } = {}) {
  const p = answers.support?.probabilities;
  if (!p) return { fit: null, verdict: null, support: null };
  const P = (k) => Number(p[k] ?? 0);
  const support = { direct: P('direct'), partial: P('partial'), unrelated: P('unrelated'), contradicts: P('contradicts'), choice: answers.support.choice ?? null, confidence: answers.support.confidence ?? null };
  const fit = support.direct + rules.partialCredit * support.partial - support.contradicts;
  const a = rules.attach;
  const supported = support.direct >= a.minDirect || (a.minFit != null && fit >= a.minFit);
  const verdict = supported && support.contradicts <= a.maxContradicts
    && (a.minOnPoint == null || support.direct + support.partial >= a.minOnPoint) ? 'attach'
    : support.direct + support.partial >= rules.review.minDirectPlusPartial ? 'review' : 'none';
  return { fit, verdict, support };
}

/**
 * One tweet's candidates (each {kind: 'library'|'fresh', fit, verdict, ...}) -> the decision. The best
 * candidate by fit wins, except that a stored clip within reuseMargin of it wins instead (no cut, no
 * upload). Only 'attach' candidates can be chosen; 'review' ones are surfaced, never used. Pure.
 */
export function chooseForTweet(candidates, { rules = CLIP_RULES } = {}) {
  const ranked = [...candidates].filter((c) => c.fit != null).sort((a, b) => b.fit - a.fit);
  const attachable = ranked.filter((c) => c.verdict === 'attach');
  if (!attachable.length) return { action: ranked.some((c) => c.verdict === 'review') ? 'review' : 'none', pick: null, ranked };
  const best = attachable[0];
  const stored = attachable.find((c) => c.kind === 'library' && c.fit >= best.fit - rules.reuseMargin);
  const pick = stored || best;
  return { action: pick.kind === 'library' ? 'reuse' : 'cut', pick, ranked };
}

/** The hook's main-idea candidates (CLIP_RULES.mainIdea): on the hook's point and not disputing it, best P(direct) first. Pure. */
export function mainIdeaCandidates(ranked, { rules = CLIP_RULES } = {}) {
  const m = rules.mainIdea;
  return (ranked || []).filter((c) => c.support && c.support.direct + c.support.partial >= m.minOnPoint && c.support.contradicts <= m.maxContradicts)
    .sort((a, b) => b.support.direct - a.support.direct).slice(0, m.top);
}

/** MATCH rules for a high-bar tweet (the hook, operator 2026-09-24): the strict bar, ordinary windows. Pure. */
export const highBarRules = (rules = CLIP_RULES) => ({ ...rules, attach: { minDirect: rules.strict.minDirect, minOnPoint: rules.strict.minOnPoint, maxContradicts: rules.strict.maxContradicts } });

/** MATCH rules for a strict tweet: short windows, and the strict bar as the attach bar. Pure. */
export const strictMatchRules = (rules = CLIP_RULES) => ({ ...rules, window: { ...rules.window, ...rules.strict.window },
  attach: { minDirect: rules.strict.minDirect, minOnPoint: rules.strict.minOnPoint, maxContradicts: rules.strict.maxContradicts } });

/**
 * The strict guard on a decision (CLIP_RULES.strict: the first tweet of a CTA): only a clip of at most
 * maxS seconds, P(direct) >= minDirect, P(direct)+P(partial) >= minOnPoint, P(contradicts) <= maxContradicts. The decision's own pick
 * (refined under strictMatchRules) wins when it passes; otherwise the best passing ranked candidate. Pure.
 */
export function strictChoice(decision, { rules = CLIP_RULES, maxS = rules.strict.maxS } = {}) {
  const s = rules.strict;
  const ok = (c) => c && c.verdict === 'attach' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start <= maxS + 0.5
    && (c.support?.direct ?? 0) >= s.minDirect && (c.support?.direct ?? 0) + (c.support?.partial ?? 0) >= s.minOnPoint
    && (c.support?.contradicts ?? 1) <= s.maxContradicts;
  if (ok(decision?.pick)) return { action: decision.action, pick: decision.pick, strict: 'met' };
  // The hook only (no length cap): a pick matchTweets rescued on the main-idea reading (CLIP_RULES.mainIdea).
  if (decision?.rescued === 'main-idea' && decision.pick && !Number.isFinite(maxS)) {
    return { action: decision.action, pick: decision.pick, strict: `main idea ${Number(decision.pick.mainIdea).toFixed(2)}` };
  }
  const pool = (decision?.ranked || []).filter(ok);
  if (!pool.length) return { action: 'none', pick: null, strict: Number.isFinite(maxS) ? `no clip of ${maxS}s or less at the strict bar` : 'no clip at the high bar' };
  const best = [...pool].sort((a, b) => b.fit - a.fit)[0];
  const stored = pool.find((c) => c.kind === 'library' && c.fit >= best.fit - rules.reuseMargin);
  const pick = stored || best;
  return { action: pick.kind === 'library' ? 'reuse' : 'cut', pick, strict: 'met' };
}

/**
 * The per-thread video cap on MATCH decisions (CLIP_RULES.perThread). Keeps at most `max` placing decisions
 * (reuse / cut): the hook first when it has one (`hookAt`, the decision index of tweet 1, operator 2026-09-24:
 * hooks get first claim), then the highest Jev fit, ties to the earlier tweet. The rest become action
 * 'capped', pick kept so the report shows what the cap declined. Pure.
 */
export function capClips(decisions, max, { hookAt = null } = {}) {
  if (!Number.isFinite(max)) return decisions;
  const placing = (d) => d?.pick && ['reuse', 'cut'].includes(d.action);
  const order = decisions.map((d, i) => ({ d, i })).filter(({ d }) => placing(d))
    .sort((a, b) => (b.i === hookAt) - (a.i === hookAt) || (b.d.pick.fit ?? 0) - (a.d.pick.fit ?? 0) || a.i - b.i);
  const keep = new Set(order.slice(0, Math.max(0, max)).map(({ i }) => i));
  return decisions.map((d, i) => (placing(d) && !keep.has(i) ? { ...d, action: 'capped' } : d));
}

/** Best non-overlapping clips from a scored list (per source), highest rank first. Pure. */
export function pickTop(scored, n, { verdicts = ['clip'] } = {}) {
  const kept = [];
  for (const c of [...scored].filter((x) => verdicts.includes(x.verdict)).sort((a, b) => b.rank - a.rank)) {
    if (kept.some((k) => (k.sourceId ?? null) === (c.sourceId ?? null) && k.start < c.end && c.start < k.end)) continue;
    kept.push(c);
    if (kept.length >= n) break;
  }
  return kept;
}

// ---- Jev calls ---------------------------------------------------------------------------------------
export const passageState = (w) => ({ passage: w.text, speaker: w.speaker ?? null });

/**
 * Ask one question set over many states with a worker pool. An auth or model error opens the breaker and
 * stops the run (every later call would fail the same way); any other error marks that item only.
 * Returns [{ ok, answers?, model?, error? }] in input order, plus the breaker.
 */
// `questions`: one set for every state, or a function of the state's index.
// `reading`: the registered Jev reading (decisions/readings.mjs) to ask through the one door (decide():
// log, breaker, pinned model, deadline, template hash lock). Every ask goes through it; MINE's is
// 'clip-mine-read' (plan v7 N1: the last raw clip ask, closed 2026-09-25).
export async function askAll(client, states, questions, { workers = CLIP_RULES.workers, role = 'clip-judge', reading = 'clip-mine-read' } = {}) {
  const { askThrough: door } = await import('./jev-decide.mjs');
  const out = new Array(states.length);
  const breaker = { open: false, reason: null };
  let next = 0;
  const work = async () => {
    while (!breaker.open && next < states.length) {
      const i = next++;
      try {
        const qs = typeof questions === 'function' ? questions(i) : questions;
        const r = await door(reading, client, { state: states[i], questions: qs }, { role });
        out[i] = { ok: true, answers: r.answers, model: r.model };
      } catch (error) {
        const trip = breakerReason(error);
        if (trip) { breaker.open = true; breaker.reason = trip; }
        out[i] = { ok: false, error: error.code || 'client_error' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, states.length)) }, work));
  return { results: out.map((r) => r ?? { ok: false, error: 'not_run' }), breaker };
}

/** MINE: judge every candidate window; returns them with scores, rank, verdict and the answering build. */
// `kind: 'reel'` asks REEL_QUESTIONS through 'reel-mine-read' and decides with reelDecision (rules = REEL_RULES).
export async function judgeWindows(client, windows, { focus = null, rules = CLIP_RULES, kind = 'clip', ...opts } = {}) {
  const base = kind === 'reel' ? REEL_QUESTIONS : CLIP_QUESTIONS;
  const decide = kind === 'reel' ? reelDecision : clipDecision;
  const questions = focus ? { ...base, focus: focusQuestion(focus) } : base;
  const { results, breaker } = await askAll(client, windows.map(passageState), questions, { ...opts, reading: kind === 'reel' ? 'reel-mine-read' : 'clip-mine-read' });
  const judged = windows.map((w, i) => {
    const r = results[i];
    if (!r.ok) return { ...w, error: r.error, verdict: null, rank: null };
    return { ...w, ...decide(r.answers, { rules, hasFocus: Boolean(focus) }), model: r.model };
  });
  return { judged, breaker, questionSetHash: questionSetHash(questions) };
}

/**
 * MINE, end to end: candidate windows per source -> judge all -> for the best top*refine.top, judge
 * their boundary variants and keep each one's best version -> the top non-overlapping clips.
 * `sources` are [{ source: {id, title, url}, segments }].
 */
export async function mineClips(client, sources, { focus = null, top = 12, rules = CLIP_RULES, kind = 'clip', ...opts } = {}) {
  const best = kind === 'reel' ? 'reel' : 'clip';
  opts = { ...opts, kind };
  const unitsBy = new Map(sources.map(({ source, segments }) => [source.id, unitsFromSegments(segments, rules.maxUnitS ? { maxUnitS: rules.maxUnitS } : {})]));
  const meta = (source) => ({ sourceId: source.id, title: source.title ?? null, url: source.url ?? null });
  const windows = sources.flatMap(({ source }) => candidateWindows(unitsBy.get(source.id), rules.window).map((w) => ({ ...w, ...meta(source) })));
  const first = await judgeWindows(client, windows, { focus, rules, ...opts });
  if (first.breaker.open) return { ...first, chosen: [], windows: windows.length, variants: 0 };
  const seeds = pickTop(first.judged, top * rules.refine.top, { verdicts: [best, 'maybe'] });
  const variants = seeds.flatMap((w, k) => boundaryVariants(unitsBy.get(w.sourceId), w, { shift: rules.refine.maxShiftUnits, minS: rules.window.minS, maxS: rules.window.maxS })
    .map((v) => ({ ...v, sourceId: w.sourceId, title: w.title, url: w.url, seed: k })));
  const second = await judgeWindows(client, variants, { focus, rules, ...opts });
  const refined = seeds.map((w, k) => [w, ...second.judged.filter((v) => v.seed === k)]
    .filter((x) => x.rank != null)
    .sort((a, b) => (b.verdict === best) - (a.verdict === best) || b.rank - a.rank)[0]);
  const chosen = pickTop(refined, top, { verdicts: [best] });
  return { judged: first.judged, chosen, breaker: second.breaker, questionSetHash: first.questionSetHash, windows: windows.length, variants: variants.length };
}

/** The boundary questions asked beside SUPPORT when a fresh pick is refined (same wording, same meaning). */
export const BOUNDARY_QUESTIONS = { clean_start: CLIP_QUESTIONS.clean_start, clean_end: CLIP_QUESTIONS.clean_end, self_contained: CLIP_QUESTIONS.self_contained };

/** A refined variant's order: it must still be 'attach'; then fit plus how cleanly it starts and ends. Pure. */
export function variantScore(v) {
  if (v.verdict !== 'attach') return -Infinity;
  const b = v.boundary || {};
  return v.fit + 0.25 * ((b.clean_start ?? 0) + (b.clean_end ?? 0)) + 0.05 * (b.self_contained ?? 0);
}

/**
 * A rescued hook pick's variant order (CLIP_RULES.mainIdea). It was held at the attach bar by design, so a variant
 * need not reach it; it must still state the hook's main idea on its OWN reading (a trimmed edge can drop the
 * sentence that carried it), stay on the hook's point and not dispute it, then fit plus clean edges. Pure.
 */
export function rescuedVariantScore(v, { rules = CLIP_RULES } = {}) {
  const m = rules.mainIdea, s = v.support || {};
  if (!(Number.isFinite(v.mainIdea) && v.mainIdea >= m.min)) return -Infinity;
  if (!((s.direct ?? 0) + (s.partial ?? 0) >= m.minOnPoint && (s.contradicts ?? 1) <= m.maxContradicts)) return -Infinity;
  const b = v.boundary || {};
  return v.fit + 0.25 * ((b.clean_start ?? 0) + (b.clean_end ?? 0)) + 0.05 * (b.self_contained ?? 0);
}

/**
 * MATCH: for each tweet, shortlist candidates lexically (fresh windows and stored clips together), ask
 * Jev the support question for each pair, and decide. `candidates` are {kind, text, ...}. With `unitsBy`
 * (sourceId -> units), a fresh pick is refined: its boundary variants are asked SUPPORT and the boundary
 * questions together, and the best one that still attaches replaces it. With `mainIdea` (the hook only), a
 * tweet the rules held asks MAIN_IDEA_QUESTIONS of its top on-point candidates first (CLIP_RULES.mainIdea).
 */
export async function matchTweets(client, tweets, candidates, { rules = CLIP_RULES, unitsBy = null, mainIdea = false, ...opts } = {}) {
  // Stored clips and fresh passages are shortlisted separately: BM25 favours longer windows that repeat
  // the query terms, and a stored clip left off the shortlist can never be reused.
  const idx = { library: [], fresh: [] };
  candidates.forEach((c, i) => idx[c.kind === 'library' ? 'library' : 'fresh'].push(i));
  const pairs = [];
  tweets.forEach((tweet, t) => {
    for (const [kind, k] of [['library', rules.libraryShortlist], ['fresh', rules.shortlist]]) {
      const pool = idx[kind];
      for (const j of shortlist(tweet, pool.map((i) => candidates[i].text), k)) pairs.push({ t, i: pool[j] });
    }
  });
  const { results, breaker } = await askAll(client, pairs.map(({ t, i }) => ({ tweet: tweets[t], passage: candidates[i].text })), SUPPORT_QUESTIONS, { ...opts, reading: 'clip-support-read' });
  const perTweet = tweets.map(() => []);
  pairs.forEach(({ t, i }, k) => {
    const r = results[k];
    perTweet[t].push({ ...candidates[i], ...(r.ok ? { ...supportDecision(r.answers, { rules }), model: r.model } : { fit: null, verdict: null, error: r.error }) });
  });
  const decisions = tweets.map((tweet, t) => ({ tweet, ...chooseForTweet(perTweet[t], { rules }) }));
  // THE HOOK'S MAIN IDEA (owner 2026-09-28): a held tweet's best on-point candidate that states its main idea is
  // picked, before refinement, so a rescued cut still gets clean edges. A failed read is never a pass.
  let rescueBreaker = { open: false, reason: null }, rescued = 0;
  if (mainIdea && !breaker.open) {
    const asks = [];
    decisions.forEach((d, t) => {
      if (d.action === 'cut' || d.action === 'reuse') return;
      for (const c of mainIdeaCandidates(d.ranked, { rules })) asks.push({ t, c });
    });
    if (asks.length) {
      const third = await askAll(client, asks.map(({ t, c }) => ({ tweet: tweets[t], passage: c.text })), MAIN_IDEA_QUESTIONS, { ...opts, reading: 'clip-main-idea-read' });
      rescueBreaker = third.breaker;
      const best = new Map();
      asks.forEach(({ t, c }, k) => {
        const r = third.results[k];
        const p = r.ok ? r.answers.main_idea?.noul : null;
        if (!Number.isFinite(p) || p < rules.mainIdea.min) return;
        if (!best.has(t) || p > best.get(t).mainIdea) best.set(t, { ...c, mainIdea: p });
      });
      for (const [t, pick] of best) { decisions[t] = { ...decisions[t], action: pick.kind === 'library' ? 'reuse' : 'cut', pick, rescued: 'main-idea' }; rescued++; }
    }
  }
  const brk = breaker.open ? breaker : rescueBreaker;
  let refined = 0;
  if (unitsBy && !brk.open) {
    const jobs = [];
    decisions.forEach((d, t) => {
      if (d.action !== 'cut' || d.pick.ui == null || !unitsBy.get(d.pick.sourceId)) return;
      const units = unitsBy.get(d.pick.sourceId);
      for (const v of [makeWindow(units, d.pick.ui, d.pick.uj), ...boundaryVariants(units, d.pick, { shift: rules.refine.maxShiftUnits, minS: rules.window.minS, maxS: rules.window.maxS })]) {
        jobs.push({ t, v: { ...d.pick, ...v } });
      }
    });
    const q = { ...SUPPORT_QUESTIONS, ...BOUNDARY_QUESTIONS };
    const second = await askAll(client, jobs.map(({ t, v }) => ({ tweet: tweets[t], passage: v.text })), q, { ...opts, reading: 'clip-boundary-read' });
    refined = jobs.length;
    // A rescued pick's variants are asked the main idea again, so a trim that drops the sentence carrying it loses.
    const rescuedJobs = jobs.map((j, k) => ({ ...j, k })).filter(({ t }) => decisions[t].rescued);
    const mainOf = new Map();
    if (rescuedJobs.length) {
      const again = await askAll(client, rescuedJobs.map(({ t, v }) => ({ tweet: tweets[t], passage: v.text })), MAIN_IDEA_QUESTIONS, { ...opts, reading: 'clip-main-idea-read' });
      rescuedJobs.forEach(({ k }, n) => { const r = again.results[n]; const p = r.ok ? r.answers.main_idea?.noul : null; if (Number.isFinite(p)) mainOf.set(k, p); });
    }
    const byTweet = new Map();
    const scoreOf = (t, c) => (decisions[t].rescued ? rescuedVariantScore(c, { rules }) : variantScore(c));
    jobs.forEach(({ t, v }, k) => {
      const r = second.results[k];
      if (!r.ok) return;
      const a = r.answers;
      const cand = { ...v, ...supportDecision(a, { rules }), model: r.model,
        boundary: { clean_start: a.clean_start?.noul ?? null, clean_end: a.clean_end?.noul ?? null, self_contained: a.self_contained?.score == null ? null : a.self_contained.score / 2 },
        ...(decisions[t].rescued ? { mainIdea: mainOf.get(k) ?? null } : {}) };
      if (!byTweet.has(t) || scoreOf(t, cand) > scoreOf(t, byTweet.get(t))) byTweet.set(t, cand);
    });
    // No variant that keeps the main idea: a rescued pick stays the window it was rescued on.
    for (const [t, best] of byTweet) if (scoreOf(t, best) > -Infinity) decisions[t] = { ...decisions[t], pick: best };
  }
  return { decisions, breaker: brk, pairs: pairs.length, refined, rescued };
}
