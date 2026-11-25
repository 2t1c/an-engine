// decisions/claims-battery.mjs — the per-tweet claims battery (plan Track E "Guardrails & compliance").
//
// Report-only: laws.json `jev.decisions.claims-battery.mode` is `shadow`, so decide() returns the
// incumbent regex's action and logs Jev's reading beside it. No gate in checks.mjs changes, and nothing
// calls this live yet; scripts/jev-eval.mjs measures it against evals/jev/claims.jsonl.
//
// Input: one BATCH of tweets, { tweets: [string], plug?: [boolean] } (at most MAX_BATCH). Each tweet
// gets its own key in the state (`tweets.a`, `tweets.b`, …) and its own five questions, so one call
// reads several tweets and every answer points at exactly one tweet. A thread longer than MAX_BATCH is
// read in several decide() calls (batchTweets()).
//
// Actions: `pass` or `hold` (HOLD). `safety: true`, so decide() applies monotone safety in any mode
// above shadow; the policy below is ALSO monotone on its own (plan §1.2 invariant 8): a tweet holds
// when Jev crosses a threshold OR the incumbent regex holds, so Jev can add a block and never clear one.
//
// Wording is lifted from docs/claim-safety.md (the 2026-08-31 audit), LAW 4(b) and LAW 7
// (docs/thread-laws.md) and the checks.mjs comments on evidenceClaimIssue / absoluteSuperlativeIssue.
// Numbers live in laws.json `jev.decisions.claims-battery.thresholds`.
import { absoluteSuperlativeIssue, bannedTopicIssue, bannedTopicTweetIssue, evidenceClaimIssue, hardHealthClaim } from '../checks.mjs';
import { choice, noul, score } from '../jev.mjs';

export const name = 'claims-battery';
export const ACTIONS = Object.freeze(['pass', 'hold']);
export const HOLD = 'hold';
export const safety = true;

/** Tweets per call. Five questions per tweet, so a full batch is sixty questions. */
export const MAX_BATCH = 12;
export const DEFAULT_BATCH = 8;
/** Per-tweet keys in the state. Letters, never digits: Jev is not asked to count (jev-lint.mjs). */
export const TWEET_KEYS = Object.freeze('abcdefghijkl'.split(''));
export const MAX_TWEET_CHARS = 600;

export const CLASSES = Object.freeze(['none', 'hedged_association', 'results_testimonial', 'disease_treatment']);
/** Classes that hold on their own once Jev's probability crosses thresholds.holdClass. */
export const HOLD_CLASSES = Object.freeze(['results_testimonial', 'disease_treatment']);
/** The three nouls, by the label name the eval set uses. */
export const NOULS = Object.freeze(['unsourced_statistic', 'absolute_superlative', 'stated_as_proven']);
/** The laws.json threshold key for each noul. */
export const NOUL_THRESHOLD_KEY = Object.freeze({
  unsourced_statistic: 'unsourcedStatistic', absolute_superlative: 'absoluteSuperlative', stated_as_proven: 'statedAsProven',
});
const SEVERITY_LEVELS = 4;

// ---- The questions (one reviewable place) ------------------------------------------------------------
/** The five questions for the tweet under `tweets.<key>`. */
export function tweetQuestions(key) {
  const at = `\`tweets.${key}\``;
  return {
    [`${key}_class`]: choice(`Which kind of health claim does the tweet at ${at} make? Read only that tweet; the other tweets are context.`, {
      none: 'No health claim: advice, a story, an opinion, a call to action, a product description or sourcing criterion, or a mechanism in general terms with no promised result.',
      hedged_association: 'Links a substance, food or habit to a health effect with hedged wording (linked to, associated with, may help, research suggests) and promises no result.',
      results_testimonial: 'The speaker reports a change in their own body, sleep, mood, energy or performance after using something (for example what changed was, stopped feeling like, no longer wake up).',
      disease_treatment: 'Says something cures, treats, prevents, reverses or heals a disease or a medical condition.',
    }),
    [`${key}_unsourced_statistic`]: noul(`Does the tweet at ${at} state a statistic (a percentage, a share of people, a count of studies or reactions, or a multiplier) without naming where it comes from?`, {
      true: 'It gives a figure as fact and names no study, journal, institution or source for it.',
      false: 'It gives no figure, only a dose, a time, a price or a list count, or it names the source of its figure.',
    }),
    [`${key}_absolute_superlative`]: noul(`Does the tweet at ${at} rank a product or substance as the best, number one, the ultimate, or unbeatable, without a first-person hedge?`, {
      true: 'An absolute ranking such as the best, number one, the ultimate or nothing beats it, stated as fact.',
      false: 'No ranking, or a hedged one such as one of the best, my favourite, or the best I have tried.',
    }),
    [`${key}_stated_as_proven`]: noul(`Does the tweet at ${at} state a health effect as proven or guaranteed rather than as an association?`, {
      true: 'It says research proves, it is proven, it guarantees, or states the effect as certain fact.',
      false: 'It associates (linked to, may help, research suggests), gives no health effect, or reports an opinion.',
    }),
    [`${key}_severity`]: score(`How serious is the strongest health claim in the tweet at ${at}, for a compliance reviewer of an affiliate account?`, [
      'No health claim: advice, a story, an opinion, a call to action, or a product description.',
      'A hedged claim: an association or a possibility with no promised result.',
      'A specific claim the reviewer would want sourced or softened: a figure, a study result, or a firm health effect stated as fact.',
      'A claim that must not ship: a personal results testimonial, a disease cured, treated or prevented, or an outcome stated as proven or guaranteed.',
    ]),
  };
}

/** The hash-locked template: the wording of one tweet's questions (the key is the only variable). */
export const QUESTION_TEMPLATE = tweetQuestions('a');

// ---- State ------------------------------------------------------------------------------------------
const LINK_RE = /https?:\/\/\S+|\{\{LINK\d*\}\}/g;
const PLUG_LINK_RE = /(?:https?:\/\/)?(?:[\w-]+\.)*(?:lvnta\.com|gumroad\.com)\/\S*|\{\{LINK\d*\}\}/i;
const cleanTweet = (t) => String(t ?? '').replace(LINK_RE, '[link]').slice(0, MAX_TWEET_CHARS);

function tweetsOf(input = {}) {
  const tweets = Array.isArray(input.tweets) ? input.tweets.map((t) => String(t ?? '')) : [];
  if (!tweets.length) throw new Error('claims-battery: no tweets');
  if (tweets.length > MAX_BATCH) throw new Error(`claims-battery: ${tweets.length} tweets > MAX_BATCH ${MAX_BATCH}; split with batchTweets()`);
  return tweets;
}

/** { tweets: { a: text, b: text, … } }. Links become [link]; the text is data, never instructions. */
export function stateOf(input = {}) {
  return { tweets: Object.fromEntries(tweetsOf(input).map((t, i) => [TWEET_KEYS[i], cleanTweet(t)])) };
}

export function questions(_state, input = {}) {
  return Object.assign({}, ...tweetsOf(input).map((_, i) => tweetQuestions(TWEET_KEYS[i])));
}

/** Split a thread into decide() inputs of at most `size` tweets, keeping each tweet's plug flag (null = detect from its link). */
export function batchTweets(tweets = [], { size = DEFAULT_BATCH, plug = [] } = {}) {
  const n = Math.max(1, Math.min(MAX_BATCH, size));
  const out = [];
  for (let i = 0; i < tweets.length; i += n) out.push({ tweets: tweets.slice(i, i + n), plug: tweets.slice(i, i + n).map((_, j) => (plug[i + j] == null ? null : Boolean(plug[i + j]))) });
  return out;
}

// ---- Incumbent: the regex gates that exist today (checks.mjs), per tweet ------------------------------
const isPlugTweet = (text, flag) => (flag == null ? PLUG_LINK_RE.test(text) : Boolean(flag));

/**
 * What today's regexes say about one tweet, mapped onto the battery's labels. Scopes follow checks.mjs:
 * hardHealthClaim and bannedTopicIssue read every tweet; evidenceClaimIssue and absoluteSuperlativeIssue
 * read plug tweets only. Nothing today reads testimonials or unsourced statistics (docs/claim-safety.md).
 */
export function incumbentTweet(text, { plug = null } = {}) {
  const s = String(text ?? '');
  const isPlug = isPlugTweet(s, plug);
  const link = isPlug ? (s.match(PLUG_LINK_RE)?.[0] || s) : null;
  const disease = hardHealthClaim(s);
  const proven = isPlug && Boolean(evidenceClaimIssue([s], { plugLinks: [link] }));
  const superlative = isPlug && Boolean(absoluteSuperlativeIssue(s));
  // One tweet has no thread to read focus from, so only the position-independent findings (treatment wording,
  // claims about a banned subject) count here; incumbent() below adds the whole-thread read.
  const banned = Boolean(bannedTopicTweetIssue(s));
  return {
    class: disease ? 'disease_treatment' : 'none',
    unsourced_statistic: false,
    absolute_superlative: superlative,
    stated_as_proven: proven,
    banned,
    hold: disease || proven || superlative || banned,
  };
}

/** The incumbent's action for a batch: hold when any tweet's regex holds. */
export function incumbent(input = {}) {
  const tweets = Array.isArray(input.tweets) ? input.tweets : [];
  const plug = input.plug || [];
  return { action: tweets.some((t, i) => incumbentTweet(t, { plug: plug[i] }).hold) || bannedTopicIssue(tweets) ? HOLD : 'pass' };
}

// ---- Policy (pure) -----------------------------------------------------------------------------------
const need = (t, k) => {
  if (!Number.isFinite(t?.[k])) throw new Error(`claims-battery: thresholds.${k} is required`);
  return t[k];
};

/** A choice's probability for one option: the distribution when present, else the chosen option's confidence. */
export function classProb(answer, cls) {
  const p = answer?.probabilities?.[cls] ?? answer?.distribution?.[cls];
  if (Number.isFinite(p)) return p;
  return answer?.choice === cls && Number.isFinite(answer?.confidence) ? answer.confidence : 0;
}

/**
 * Per-tweet readings. Each: { key, class, classConfidence, classProbs, nouls, severity (0..1),
 * jevHold, incumbentHold, hold, reasons }. `hold` is jevHold OR incumbentHold (monotone).
 * thresholds: { severity, holdClass, unsourcedStatistic, absoluteSuperlative, statedAsProven }.
 */
export function readTweets(answers, thresholds, input = {}) {
  const tweets = tweetsOf(input);
  const plug = input.plug || [];
  const t = {
    severity: need(thresholds, 'severity'), holdClass: need(thresholds, 'holdClass'),
    ...Object.fromEntries(NOULS.map((n) => [NOUL_THRESHOLD_KEY[n], need(thresholds, NOUL_THRESHOLD_KEY[n])])),
  };
  return tweets.map((text, i) => {
    const key = TWEET_KEYS[i];
    const cls = answers?.[`${key}_class`];
    const classProbs = Object.fromEntries(CLASSES.map((c) => [c, classProb(cls, c)]));
    const nouls = Object.fromEntries(NOULS.map((n) => [n, answers?.[`${key}_${n}`]?.noul ?? null]));
    const sevRaw = answers?.[`${key}_severity`]?.score;
    const severity = Number.isFinite(sevRaw) ? sevRaw / (SEVERITY_LEVELS - 1) : null;
    const checks = [];
    const dist = (x, th) => (x >= th ? (x - th) / Math.max(1 - th, 1e-9) : (th - x) / Math.max(th, 1e-9));
    if (severity != null) checks.push({ reason: 'severity', fires: severity >= t.severity, strength: dist(severity, t.severity) });
    for (const c of HOLD_CLASSES) checks.push({ reason: c, fires: classProbs[c] >= t.holdClass, strength: dist(classProbs[c], t.holdClass) });
    for (const n of NOULS) if (Number.isFinite(nouls[n])) checks.push({ reason: n, fires: nouls[n] >= t[NOUL_THRESHOLD_KEY[n]], strength: dist(nouls[n], t[NOUL_THRESHOLD_KEY[n]]) });
    const inc = incumbentTweet(text, { plug: plug[i] });
    const fired = checks.filter((c) => c.fires);
    const jevHold = fired.length > 0;
    return {
      key, class: cls?.choice ?? null, classConfidence: Number.isFinite(cls?.confidence) ? cls.confidence : null, classProbs, nouls, severity,
      jevHold, incumbentHold: inc.hold, hold: jevHold || inc.hold,
      reasons: [...fired.map((c) => c.reason), ...(inc.hold ? ['incumbent'] : [])],
      strength: jevHold ? Math.max(...fired.map((c) => c.strength)) : checks.length ? Math.min(...checks.map((c) => c.strength)) : 0,
    };
  });
}

/**
 * Pure. Hold when any tweet holds: Jev's severity or a hold class or a noul crosses its threshold, OR
 * the incumbent regex holds on that tweet (monotone: Jev never clears a regex hold). Confidence: a
 * regex hold is certain (1); a Jev hold is as sure as its strongest trigger; a pass only as sure as
 * the weakest check across the batch.
 */
export function policy(answers, thresholds, { input } = {}) {
  const tweets = readTweets(answers, thresholds, input);
  const held = tweets.filter((r) => r.hold);
  if (held.length) {
    const confidence = held.some((r) => r.incumbentHold) ? 1 : Math.max(...held.map((r) => r.strength));
    return { action: HOLD, confidence: Math.min(1, +confidence.toFixed(6)), reasons: [...new Set(held.flatMap((r) => r.reasons))], held: held.map((r) => r.key) };
  }
  const confidence = Math.min(...tweets.map((r) => r.strength));
  return { action: 'pass', confidence: Math.min(1, +confidence.toFixed(6)), reasons: [], held: [] };
}

// ---- Eval adapter (scripts/jev-eval.mjs) ---------------------------------------------------------------
/**
 * How the eval harness reads this decision. An item is one labelled tweet: { id, text, plug }.
 * Label fields: `class` (choice over CLASSES), the three nouls and `hold` (binary).
 */
export const EVAL = Object.freeze({
  labels: 'claims', // evals/jev/claims.jsonl
  batchSize: DEFAULT_BATCH,
  fields: Object.freeze({
    class: { type: 'choice', options: CLASSES },
    unsourced_statistic: { type: 'binary', thresholdKey: 'unsourcedStatistic' },
    absolute_superlative: { type: 'binary', thresholdKey: 'absoluteSuperlative' },
    stated_as_proven: { type: 'binary', thresholdKey: 'statedAsProven' },
    hold: { type: 'binary', score: 'holdScore' },
  }),
  toInput: (items) => ({ tweets: items.map((it) => it.text), plug: items.map((it) => (it.plug == null ? null : Boolean(it.plug))) }),
  /** Per item: Jev's prediction for every field, as { value, prob, confidence }. */
  predict(answers, thresholds, input) {
    return readTweets(answers, thresholds, input).map((r) => ({
      class: { value: r.class, confidence: r.classConfidence, probs: r.classProbs },
      ...Object.fromEntries(NOULS.map((n) => [n, { prob: r.nouls[n], value: Number.isFinite(r.nouls[n]) ? r.nouls[n] >= thresholds[NOUL_THRESHOLD_KEY[n]] : null }])),
      // hold: the policy's own OR; holdScore is Jev's strongest risk signal, for the threshold sweep.
      hold: { value: r.hold, jevOnly: r.jevHold, prob: Math.max(r.severity ?? 0, ...HOLD_CLASSES.map((c) => r.classProbs[c]), ...NOULS.map((n) => r.nouls[n] ?? 0)) },
    }));
  },
  /** Per item: the incumbent regex's prediction for the same fields. */
  incumbent(input) {
    const plug = input.plug || [];
    return input.tweets.map((t, i) => {
      const r = incumbentTweet(t, { plug: plug[i] });
      return {
        class: { value: r.class }, unsourced_statistic: { value: r.unsourced_statistic },
        absolute_superlative: { value: r.absolute_superlative }, stated_as_proven: { value: r.stated_as_proven }, hold: { value: r.hold },
      };
    });
  },
});
