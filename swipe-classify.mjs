// swipe-classify.mjs — the swipe DB's Niche question sets and the pure rules that turn Jev's answers
// into a Niche change (plan Appendix A, "swipe DB reclassification v1", operator 2026-09-23).
//
// Operator rulings this encodes: (1) overwrite Niche where Jev is confident; (2) Health, Fitness and
// Mental Health are ONE niche, `Health`; (3) Health first — no row ever moves between two non-Health
// niches; (4) only Niche is written, everything else (topic, battery, intent) is report-only.
//
// TWO CALLS PER ROW:
//   call 1  NICHE_QUESTIONS  over exactly {hook, tweets}. Byte-identical to the calibration run
//           (all 4,489 heads, 2026-09-23). NICHE_QUESTIONS_HASH pins it: the dry run refuses when the
//           hash differs, so any wording edit means recalibrating before a write.
//   call 2  INTAKE_QUESTIONS over {hook, tweets, we_sell, plug_zone}. Report-only; its only effect on a
//           write is the safety skip (explicit / off_brand / about_cancer can hold a move INTO Health).
//
// scripts/swipe-reclassify.mjs runs it; docs/typesafe-jev.md "Swipe classification" is the runbook.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tweetsFromRollup } from './checks.mjs';
import { INTENT_DIMENSIONS, INTENT_QUESTIONS, WE_SELL, intentVerdict, plugZone } from './donor-intent.mjs';
import { choice, noul } from './jev.mjs';

// ---- Call 1: the calibrated question set, VERBATIM (do not edit; see NICHE_QUESTIONS_HASH) ----------
const HEALTH_DEF = "the reader's own health and body or mind: physical health, nutrition, supplements, sleep, hormones, gut, longevity, disease or symptom education, fitness and training, exercise, body composition, fat loss, or mental health (anxiety, stress, burnout, mood, the nervous system)";
const OTHERS = {
  'AI': 'artificial intelligence: AI tools, models, AI companies',
  'Art': 'art, artists, design, music or film as a craft',
  'Authority Figure': "a thread built around one famous expert or leader and their advice or story, where the subject is not the reader's health",
  'Business': 'companies, startups, entrepreneurship, marketing, sales',
  'Finance': 'money, investing, markets, personal finance, economics',
  'Genius': 'exceptional minds, prodigies and their methods',
  'History': 'historical events, figures and eras',
  'Politics': 'government, elections, politicians, political news',
  'Productivity': 'getting more done: focus systems, time management, tools, workflows',
  'Psychology': 'how the mind and behaviour work: persuasion, influence, habits, human nature (not mental-health care)',
  'Science': 'scientific discoveries and research outside health, space, physics, technology that is not AI',
  'Life Lessons': 'general life wisdom, relationships, dating; sex as relationships rather than the body',
  'Self Improvement': 'discipline, motivation, routines and becoming a better person, without being mainly about the body or mental health',
};
export const NICHE_QUESTIONS = {
  health: noul(`Is this thread substantially about Health: ${HEALTH_DEF}?`, {
    true: 'A large part of the thread teaches or argues about the reader\'s physical health, fitness or mental health.',
    false: 'Health, fitness and mental health are absent or only a passing mention; sports careers, self-defense stories, sex as relationships, and general motivation are not Health.' }),
  primary: choice('Which ONE niche is this X thread mainly about (judge `hook` and `tweets` together)?',
    { Health: HEALTH_DEF, ...OTHERS, Other: 'fits none of the niches above even loosely' }),
};
// ------------------------------------------------------------------------------------------------------

/** The niches call 1 can answer, in order: Health, the unchanged niches, Other. */
export const MERGED_NICHES = Object.freeze(['Health', ...Object.keys(OTHERS), 'Other']);
/** Labels retired as write targets by the merge (the Airtable options stay; deleting them is a schema change). */
export const RETIRED_NICHES = Object.freeze(['Fitness', 'Mental Health']);

// Canonical JSON: object keys sorted at every depth, arrays kept in order. The hash therefore changes
// on any wording, criteria or question-id edit, and not on incidental key order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export function questionSetHash(questions) {
  return createHash('sha256').update(JSON.stringify(canonical(questions))).digest('hex');
}
// Recorded from the first computation of the verbatim block above (2026-09-23).
export const NICHE_QUESTIONS_HASH = '2f2686cf66585115612f20610ee722d9ae74eaa8b4c8c30fd75d95b835729ddd';

// ---- Call 2: intake battery + buyer intent (report-only) --------------------------------------------
const TOPICS = JSON.parse(readFileSync(new URL('./topics.json', import.meta.url), 'utf8')).topics;
// One plain-words description per topics.json key (jev-1.13 reads literally, so the hook regexes are
// not usable as criteria). tests/swipe-reclassify.test.mjs fails if this drifts from topics.json.
export const TOPIC_LABELS = {
  sleep: 'sleep, insomnia, waking at night, melatonin, magnesium for sleep',
  stress: 'stress, cortisol, anxiety, burnout, calming the nervous system',
  heart: 'the heart and circulation: blood pressure, cholesterol, arteries, blood flow',
  omega: 'omega-3 and fish oil',
  testosterone: "testosterone and men's hormones, libido, erectile health",
  gut: 'gut health and digestion: bloating, the microbiome, fiber, probiotics',
  joint: 'joints and inflammation: knees, arthritis, joint pain, turmeric',
  brain: 'the brain: memory, focus, cognition, dementia, nootropics',
  bloodsugar: 'blood sugar and metabolism: insulin, glucose, diabetes, fatty liver',
  energy: 'energy and fatigue: tiredness, mitochondria, NAD, vitamin D',
  liver: 'the liver and detox',
  skin: 'skin, hair and visible aging: collagen, wrinkles, the face and jaw',
  fitness: 'training and body composition: the gym, muscle, fat loss, protein, creatine',
  general: 'none of the topics above; a health thread on another subject, or not about health',
};
export const TOPIC_KEYS = Object.freeze([...TOPICS.map((t) => t.key), 'general']);

export const BATTERY_QUESTIONS = {
  quote_compilation: noul('Is this thread a compilation of quotes, sayings or one-liners from famous people rather than an argument?', {
    true: 'Most tweets are separate quotes or sayings attributed to people, strung together.',
    false: 'The thread makes its own argument or tells one story; quotes, if any, support it.' }),
  media_dependent: noul('Does this thread only make sense if the reader sees attached images or video?', {
    true: 'The text points at media ("look at this", "watch", "this chart") and says little without it.',
    false: 'The text carries its meaning on its own.' }),
  reply_bait: noul('Does `hook` ask readers to reply, comment or retweet instead of making a claim?', {
    true: 'The hook asks for replies, comments, a keyword or a retweet ("comment X and I will send it").',
    false: 'The hook makes a claim or promise and asks for nothing.' }),
  off_brand: noul('Is this thread off-brand for a health page: politics, religion, celebrity gossip, outrage, crude humour or crime?', {
    true: 'Its subject is politics, religion, celebrity gossip, outrage, crude humour or crime.',
    false: 'A health page could post it without looking out of place.' }),
  explicit: noul('Is this thread sexually explicit or adult content?', {
    true: 'It describes sex acts, porn or sexual content for arousal or shock.',
    false: 'Not sexual, or it treats hormones, libido or sex drive as health topics; those are NOT explicit.' }),
  health_side: noul('Does this thread have a health angle a health page could use, even if its main subject is something else?', {
    true: 'Part of the thread is about the body, food, sleep, exercise or mental health in a way a health page could build on.',
    false: 'Nothing in it touches the reader\'s health.' }),
  about_cancer: noul('Is this thread about cancer: its causes, prevention, treatment or a cancer story?', {
    true: 'Cancer or a tumour is the subject or a main part of the thread.',
    false: 'Cancer is absent or named once in passing.' }),
  rx_drug: noul('Is this thread about a prescription drug, such as Ozempic, statins, antidepressants or TRT?', {
    true: 'A prescription medicine is a main subject of the thread.',
    false: 'No prescription medicine is a main subject; supplements and foods are not prescription drugs.' }),
  named_quote: noul('Is this thread built on something a named real person said?', {
    true: 'The thread centres on a quote or claim attributed to a named person ("Dr Huberman says...").',
    false: 'The thread speaks in its own voice.' }),
  dangling: noul('Does this thread refer to something that is missing from it, such as "this video", "the list below" or an earlier tweet?', {
    true: 'It points at content that is not in `hook` or `tweets`.',
    false: 'Everything it refers to is in the text.' }),
  english: noul('Is this thread written in English?', {
    true: 'The thread is in English.',
    false: 'Most of the thread is in another language.' }),
  retweet: noul('Is this a retweet or repost of someone else\'s post rather than an original thread?', {
    true: 'It starts with "RT @" or is plainly someone else\'s post shared as-is.',
    false: 'It is the author\'s own post.' }),
};

export const INTAKE_QUESTIONS = {
  topic: choice('Which ONE health topic is this X thread mainly about (judge `hook` and `tweets` together)?', TOPIC_LABELS),
  ...BATTERY_QUESTIONS,
  ...INTENT_QUESTIONS,
};

// ---- Thresholds (the calibration's own, plus the A'' middle band) -------------------------------------
export const SWIPE_RULES = Object.freeze({
  model: 'jev-1.13', // passed explicitly on every call; never jev-latest
  calibratedBuild: 'typesafe/jev-1.13-20260917', // any other answering build is refused
  aHealth: 0.50, // A: retired row -> Health when primary=Health or health >= this
  aPrimeHealth: 0.30, // A': retired row with health below this and primary != Health -> primary, any confidence
  aDoublePrimeConf: 0.60, // A'': middle band -> primary at this confidence, else Health
  bHealth: 0.85, bConf: 0.85, // B: other niche -> Health
  cHealth: 0.15, cConf: 0.85, // C: Health -> primary
  dConf: 0.85, // D: blank -> primary (also tag-niche's floor)
  safety: 0.70, // B/D never move INTO Health when explicit, off_brand or about_cancer reads >= this
  maxErrorRate: 0.01,
  tolerance: 0.15, // dry-run stop: a rule more than this fraction off its expectation
  expected: Object.freeze({ A: 322, 'A′': 46, 'A″': 1, B: 81, C: 45, D: 126 }),
  // The population each expectation was calibrated on (2026-09-23, 4,489 heads): Fitness + Mental
  // Health 369, other non-blank niches 2,225, Health 1,745, blank 150. The dry-run check scales each
  // expectation to the population it actually reads: the table keeps changing (Maintenance fills
  // blanks every day), and a fixed count would stop a run whose per-row behaviour is identical.
  calibratedOn: Object.freeze({ A: 369, 'A′': 369, 'A″': 369, B: 2225, C: 1745, D: 150 }),
  minTolerance: 3, // rows: a tiny expectation (A″ ≈ 1) is judged by rows, not by percent
});
export const RULE_KEYS = Object.freeze(['A', 'A′', 'A″', 'B', 'C', 'D']);
export const SAFETY_FLAGS = Object.freeze(['explicit', 'off_brand', 'about_cancer']);
/** The call-2 subset that can hold a move INTO Health (tag-niche asks only these). */
export const SAFETY_QUESTIONS = Object.fromEntries(SAFETY_FLAGS.map((k) => [k, BATTERY_QUESTIONS[k]]));

/**
 * Pure: which safety flags hold a move into Health. A missing reading holds too — Jev can only add
 * caution here, so an unread flag is never taken as "safe".
 */
export function heldFlags(flags, rules = SWIPE_RULES) {
  if (!flags) return ['intake unread'];
  return SAFETY_FLAGS.filter((f) => !Number.isFinite(flags[f]) || flags[f] >= rules.safety)
    .map((f) => (Number.isFinite(flags[f]) ? f : `${f} unread`));
}

/** The run stops on the first auth failure or a 400 about the model (every later call would fail too). */
export function breakerReason(error) {
  const status = error?.status ?? null;
  if (status === 401 || status === 403) return `http_${status}`;
  if (status === 400 && /model/i.test(String(error?.safeExcerpt || error?.message || ''))) return 'http_400 (model)';
  return null;
}

const blankToNull = (v) => (v == null || String(v).trim() === '' ? null : String(v));
export const isHealthSide = (n) => n === 'Health' || RETIRED_NICHES.includes(n);

/**
 * Pure. row = { oldNiche }, niche = { health, primary, primaryConf }, intake = { flags } | null.
 * Returns { oldNiche, newNiche, rule } — rule null means no change; rule 'safety' means B or D would
 * have moved the row into Health and a call-2 flag held it (see `held`).
 */
export function planChange(row, niche, intake, rules = SWIPE_RULES) {
  const oldNiche = blankToNull(row?.oldNiche);
  const { health, primary, primaryConf } = niche || {};
  const keep = { oldNiche, newNiche: oldNiche, rule: null };
  if (!Number.isFinite(health) || !primary || !Number.isFinite(primaryConf)) return keep;
  const move = (newNiche, rule) => {
    if (newNiche === oldNiche) return keep;
    if (RETIRED_NICHES.includes(newNiche)) throw new Error(`planChange: ${newNiche} is retired as a write target`);
    if (oldNiche && !isHealthSide(oldNiche) && newNiche !== 'Health') throw new Error(`planChange: ${oldNiche} -> ${newNiche} moves between two non-Health niches`);
    return { oldNiche, newNiche, rule };
  };
  const intoHealth = (rule) => {
    const hit = heldFlags(intake?.flags, rules);
    if (hit.length) return { ...keep, rule: 'safety', held: { rule, newNiche: 'Health', flags: hit } };
    return move('Health', rule);
  };

  if (RETIRED_NICHES.includes(oldNiche)) {
    if (primary === 'Health' || health >= rules.aHealth) return move('Health', 'A');
    if (health < rules.aPrimeHealth) return move(primary, 'A′');
    return move(primaryConf >= rules.aDoublePrimeConf ? primary : 'Health', 'A″');
  }
  if (oldNiche === 'Health') {
    if (health <= rules.cHealth && primary !== 'Health' && primaryConf >= rules.cConf) return move(primary, 'C');
    return keep;
  }
  if (oldNiche == null) {
    if (primaryConf < rules.dConf) return keep;
    return primary === 'Health' ? intoHealth('D') : move(primary, 'D');
  }
  if (health >= rules.bHealth && primary === 'Health' && primaryConf >= rules.bConf) return intoHealth('B');
  return keep;
}

// ---- State --------------------------------------------------------------------------------------------
export const MAX_TWEETS = 12;
export const MAX_TWEET_CHARS = 500;

/** Call-1 state from a swipe head: {hook, tweets}. An empty body sends the hook alone as the only tweet. */
export function nicheState(fields = {}) {
  const text = String(fields.Text || '');
  const hook = text.split('\n')[0].trim();
  const tweets = tweetsFromRollup(fields['Full Thread Text']).slice(0, MAX_TWEETS).map((t) => t.slice(0, MAX_TWEET_CHARS));
  return { hook, tweets: tweets.length ? tweets : [text.slice(0, MAX_TWEET_CHARS)] };
}

/** Call-2 state: call 1's state plus what we sell and the code-computed plug zone (tweets 3-4). */
export function intakeState(fields = {}) {
  const s = nicheState(fields);
  return { ...s, we_sell: WE_SELL, plug_zone: plugZone(s.tweets) };
}

export function readNiche(answers = {}) {
  return { health: answers.health?.noul ?? null, primary: answers.primary?.choice ?? null, primaryConf: answers.primary?.confidence ?? null };
}

export function readIntake(answers = {}) {
  const flags = Object.fromEntries(Object.keys(BATTERY_QUESTIONS).map((k) => [k, answers[k]?.noul ?? null]));
  const dims = Object.fromEntries(INTENT_DIMENSIONS.map((k) => [k, answers[k]?.score ?? null]));
  const vals = Object.values(dims);
  const total = vals.every((v) => v != null) ? +vals.reduce((a, b) => a + b, 0).toFixed(2) : null;
  return { topic: answers.topic?.choice ?? null, topicConf: answers.topic?.confidence ?? null, flags, intent: { ...dims, total, verdict: intentVerdict(total) } };
}

/**
 * Both calls for one head. `options` is passed to the client per call (e.g. { signal } for the
 * deadline). Call 2 only runs when call 1 succeeded; a call-2 failure is recorded, not thrown, because
 * the niche answer stands on its own (planChange then holds any move INTO Health for safety).
 */
export async function classifySwipeHead(client, fields, { optionsFor = () => undefined, model = SWIPE_RULES.model } = {}) {
  const r1 = await client.ask({ state: nicheState(fields), questions: NICHE_QUESTIONS, model, role: 'swipe-niche' }, optionsFor());
  let intake = null;
  let intakeError = null;
  let build2 = null;
  try {
    const r2 = await client.ask({ state: intakeState(fields), questions: INTAKE_QUESTIONS, model, role: 'swipe-intake' }, optionsFor());
    intake = readIntake(r2.answers);
    build2 = r2.model;
  } catch (error) { intakeError = error; }
  return { build: r1.model, build2, niche: readNiche(r1.answers), intake, intakeError };
}
