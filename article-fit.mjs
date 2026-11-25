// article-fit.mjs — which viral X Articles fit the fleet's article lane (owner, 2026-09-29).
//
// The owner: "it's very hard to go viral specifically with a supplement article… I think what we can do is
// more of a self-improvement angle, and then we write a very good self-improvement piece. Inside of that, we
// have links to our supplement and our products." And the game, the same day: "Self improvement articles +
// Supplements — We can skew the topics to slightly make it more related to symptoms of certain deficiency and
// then supplement happens to be one of the plug in the article."
//
// Jev reads each article in the XDB Articles table once (article-fit-read, through the one door): the life
// area it improves, the reader's problem, whether that problem is also a deficiency symptom, whether the topic
// can tilt toward the body without breaking its argument, whether a supplement fits as one step, and what a
// quote-post funnel needs (evergreen, quotable). Code joins the answers to reach and saves. Research only:
// nothing ranks, gates or writes on it. scripts/article-research.mjs runs it.
import { choice, noul } from './jev.mjs';

export const AREAS = Object.freeze({
  body: 'Physical energy, sleep, food, fitness, weight or aging: the body.',
  focus: 'Focus, attention, memory, learning or thinking clearly.',
  mood: 'Stress, anxiety, mood, burnout or emotional control.',
  discipline: 'Discipline, habits, routines, motivation, dopamine or willpower.',
  purpose: 'Purpose, identity, meaning, reinvention or the direction of a life.',
  people: 'Relationships, social skills, confidence with people or how to communicate.',
  money: 'Career, business, making money or investing.',
  tech: 'Using AI, software or a tool, or the technology industry itself.',
  world: 'History, economics, politics, markets or society: how the world works, not how the reader lives.',
  other: 'None of the above.',
});

export const PROBLEMS = Object.freeze({
  fatigue: 'Tiredness, low energy or afternoon crashes.',
  brain_fog: 'Brain fog, poor focus or scattered attention.',
  memory: 'Forgetting things, poor recall or slow learning.',
  sleep: 'Bad sleep, waking at night or not recovering.',
  stress: 'Stress, anxiety, overthinking or burnout.',
  low_mood: 'Low mood, flatness or a lack of joy.',
  low_drive: 'Low motivation, procrastination, no discipline or no drive.',
  body_decline: 'Aging, weight, weakness or physical decline.',
  none: 'None of these: the problem is a skill, a strategy, money, a tool or the world.',
});

export const ARTICLE_FIT_QUESTIONS = Object.freeze({
  area: choice('Which ONE area of the reader\'s life does `article` mainly help them improve?', AREAS),
  problem: choice('Which ONE problem of the reader\'s does `article` mainly help fix?', PROBLEMS),
  self_improvement: noul('Is `article` mainly about how the reader can improve their own life, mind or body, rather than about a technology, a market, a company or world events?', {
    true: 'It is about the reader changing something in themselves: how they think, feel, work, sleep, eat or live.',
    false: 'It is about something outside the reader: a tool, a market, a company, a policy, history.' }),
  deficiency_symptom: noul('Does `article` describe the reader\'s problem through symptoms a missing nutrient can also cause, such as tiredness, brain fog, bad sleep, low mood, anxiety or a poor memory?', {
    true: 'The reader\'s problem shows up as one of those symptoms, whatever cause the article gives for it.',
    false: 'The problem is a skill, a strategy, money, a tool or a belief, not something the reader feels in their body or mind.' }),
  tilts_to_body: noul('Could `article` be tilted slightly toward the body, so that one section explains a nutrient deficiency behind the reader\'s problem, without changing its main argument?', {
    true: 'One added section on a missing nutrient would fit, and the rest of the article would stand as it is.',
    false: 'A nutrient angle would change what the article is about, or would read as forced.' }),
  product_slot: noul('Would a supplement such as magnesium, vitamin D, omega-3 or B12 fit naturally as one of the steps `article` tells the reader to take?', {
    true: 'The advice already covers what the reader does with their body or their day (sleep, food, energy, a routine), so a supplement reads as one more step.',
    false: 'The advice is about a skill, a tool, money or ideas, so a supplement would be off topic.' }),
  protocol: noul('Does `article` give the reader a concrete routine, protocol or steps to follow?', {
    true: 'The reader leaves with steps, a routine, a schedule or a checklist to do.',
    false: 'It argues, explains or tells a story, but gives nothing specific to do.' }),
  body_science: noul('Does `article` use how the body or brain works (hormones, neuroscience, sleep, nutrition, biology) to make its point?', {
    true: 'A mechanism in the body or brain carries part of the argument.',
    false: 'The argument is about mindset, strategy, markets or tools; the body plays no part.' }),
  health_reader: noul('Would an adult over 35 who follows health and wellness accounts want to read `article`?', {
    true: 'The topic touches what that reader cares about: energy, sleep, focus, mood, aging, habits, a better life.',
    false: 'The topic is for another audience: developers, investors, founders, AI users.' }),
  evergreen: noul('Would `article` be just as useful to read a year from now?', {
    true: 'Its advice or idea does not depend on a news event, a launch, a price or this year\'s tools.',
    false: 'It is tied to a moment: a release, a market, an election, a tool that will change.' }),
  quotable: noul('Does `article` contain lines a reader would want to quote or repost on their own?', {
    true: 'It has short, striking lines or ideas that stand alone out of context.',
    false: 'Its value is in the whole; no single line stands on its own.' }),
  first_person: noul('Is `article` told through the author\'s own experience or change?', {
    true: 'The author\'s own story, failure or transformation carries the piece.',
    false: 'It is written from outside: explanation, research or instruction without the author\'s story.' }),
  medical_claim: noul('Does `article` claim that something cures, treats or prevents a disease?', {
    true: 'A disease is named as cured, treated, reversed or prevented by something.',
    false: 'No disease claim; any health talk is about how the reader feels or functions.' }),
});

export const FIT_AT = 0.5;
export const BODY_CHARS = 12000;
export const TRAITS = Object.freeze(Object.keys(ARTICLE_FIT_QUESTIONS).filter((k) => !['area', 'problem'].includes(k)));

/** PURE. The state Jev reads: the title as a heading, then the body's first BODY_CHARS characters. */
export function articleState(row, { bodyChars = BODY_CHARS } = {}) {
  const title = String(row.Title || '').trim();
  const body = String(row['Body Text'] || row['Preview Text'] || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, bodyChars);
  if (!title && !body) throw new Error('article-fit: no text');
  return { article: `# ${title}\n\n${body}` };
}

/** PURE. The yes/no traits at FIT_AT; an unread answer is no trait. */
export function traitsOf(answers, at = FIT_AT) {
  const t = {};
  for (const k of TRAITS) t[k] = Number(answers?.[k]?.noul) >= at;
  return t;
}

/**
 * PURE. Where an article sits against the owner's game (a self-improvement piece, tilted toward a deficiency
 * symptom, with the supplement as one of its steps):
 *   'as written'  already there: the reader's problem shows up as a symptom and a supplement fits as a step
 *   'tilted'      one hook into the body is there (a symptom, a topic that can lean toward the body, or a
 *                 supplement step), so the tilt is one section, not a new article
 *   'mind only'   self-improvement with no hook into the body
 *   'claims'      self-improvement that claims to cure, treat or prevent a disease (never ours to copy)
 *   'off lane'    not about the reader improving themselves
 */
export function fitOf(answers, at = FIT_AT) {
  const t = traitsOf(answers, at);
  if (!t.self_improvement) return 'off lane';
  if (t.medical_claim) return 'claims';
  if (t.deficiency_symptom && t.product_slot) return 'as written';
  return t.deficiency_symptom || t.tilts_to_body || t.product_slot ? 'tilted' : 'mind only';
}

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
export { median };

/** PURE. Each row's reach over its author's median in the corpus (log), for authors with `min` or more articles. */
export function withLift(rows, { min = 3 } = {}) {
  const by = new Map();
  for (const r of rows) if (r.views > 0) (by.get(r.handle) || by.set(r.handle, []).get(r.handle)).push(r.views);
  return rows.map((r) => {
    const own = by.get(r.handle) || [];
    return { ...r, lift: own.length >= min && r.views > 0 ? Math.log(r.views / median(own)) : null };
  });
}

/** PURE. One group's numbers: count, median views, median lift (as a multiple), saves per 1K views, quotes per 100K. */
export function summarize(rows) {
  const lifts = rows.map((r) => r.lift).filter((x) => x != null);
  return {
    n: rows.length,
    views: median(rows.map((r) => r.views)),
    lift: lifts.length ? Math.exp(median(lifts)) : NaN,
    liftN: lifts.length,
    saves: median(rows.map((r) => (1000 * r.bookmarks) / Math.max(1, r.views))),
    quotes: median(rows.map((r) => (1e5 * r.quotes) / Math.max(1, r.views))),
  };
}

/** PURE. Rows grouped by `keyOf`, each group summarized, biggest first. */
export function groupBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (k == null) continue; (m.get(k) || m.set(k, []).get(k)).push(r); }
  return [...m].map(([k, rs]) => ({ key: k, rows: rs, ...summarize(rs) })).sort((a, b) => b.n - a.n);
}

/**
 * PURE. A bootstrap 95% range for the ratio of median lift, group a over group b (as multiples). `rand` is
 * injectable so a test is deterministic. Null when either side has fewer than 5 lifts.
 */
export function liftRatioRange(a, b, { draws = 2000, rand = Math.random } = {}) {
  const la = a.map((r) => r.lift).filter((x) => x != null), lb = b.map((r) => r.lift).filter((x) => x != null);
  if (la.length < 5 || lb.length < 5) return null;
  const pick = (xs) => Array.from(xs, () => xs[Math.floor(rand() * xs.length)]);
  const out = [];
  for (let i = 0; i < draws; i++) out.push(Math.exp(median(pick(la)) - median(pick(lb))));
  out.sort((x, y) => x - y);
  return { ratio: Math.exp(median(la) - median(lb)), lo: out[Math.floor(draws * 0.025)], hi: out[Math.floor(draws * 0.975)] };
}
