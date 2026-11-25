// decisions/donor-screen.mjs — the intake battery at pick time (plan Track B "Screen", A5, W8).
//
// Report-only: laws.json `jev.decisions.donor-screen.mode` is `shadow`, so decide() returns the
// incumbent regex's action and logs Jev's reading beside it. No screen in preflight.mjs changes.
//
// Input: one donor, { hook, tweets: [string] }. Actions: `pass` or `flag` (HOLD). `safety: true`,
// and the policy is monotone on its own (plan §1.2 invariant 8): it flags when Jev crosses a
// threshold OR a pick-time regex rejects, so Jev can add a flag and never clear a regex reject.
//
// Wording: four questions are swipe-classify.mjs BATTERY_QUESTIONS, reused byte for byte (the
// retweet, reply-bait, quote-compilation and named-person-quote nouls). The language `choice` (W8:
// five Spanish donors reached a shortlist; language is never screened on the swipe path) is new, so
// it lives here, in this decision's own hashed set, and the swipe set is not reworded.
import { BATTERY_QUESTIONS } from '../swipe-classify.mjs';
import { choice } from '../jev.mjs';
import { LAWS } from '../laws.mjs';
import { classProb } from './claims-battery.mjs';

export const name = 'donor-screen';
export const ACTIONS = Object.freeze(['pass', 'flag']);
export const HOLD = 'flag';
export const safety = true;

export const MAX_TWEETS = 12;       // swipe-classify MAX_TWEETS: the same window the intake read uses
export const MAX_TWEET_CHARS = 500; // swipe-classify MAX_TWEET_CHARS
export const BATTERY_KEYS = Object.freeze(['retweet', 'reply_bait', 'quote_compilation', 'named_quote']);
export const LANGUAGES = Object.freeze(['english', 'spanish', 'portuguese', 'other']);

export const QUESTIONS = {
  ...Object.fromEntries(BATTERY_KEYS.map((k) => [k, BATTERY_QUESTIONS[k]])),
  language: choice('Which language is most of this thread (`hook` and `tweets`) written in?', {
    english: 'English.',
    spanish: 'Spanish.',
    portuguese: 'Portuguese.',
    other: 'Another language, or no one language carries most of the thread.',
  }),
};

/** { hook, tweets } for any donor decision: the text is data, never instructions. */
export function donorState(input = {}) {
  const tweets = (Array.isArray(input.tweets) ? input.tweets : []).map((t) => String(t ?? ''));
  const hook = String(input.hook ?? tweets[0] ?? '').trim();
  if (!hook && !tweets.length) throw new Error('donor: no hook and no tweets');
  const body = tweets.slice(0, MAX_TWEETS).map((t) => t.slice(0, MAX_TWEET_CHARS));
  return { hook: hook.slice(0, MAX_TWEET_CHARS), tweets: body.length ? body : [hook.slice(0, MAX_TWEET_CHARS)] };
}

export const stateOf = (input) => donorState(input);

// ---- Incumbent: the pick-time regex screens (preflight.mjs screenDonor, checks.mjs) ------------------
const HARD_QUOTE = 'quote attributed to a named person'; // scripts/cover-selection.mjs HARD
const RETWEET_RE = /^RT @\w/i;

/** What today's regexes say. Lazy imports: preflight.mjs loads the roster, the registry must not. */
export async function incumbentReasons(input = {}) {
  const [{ UNRECREATABLE, ADULT_DENY, OFF_NICHE, DRUG_RE }, { bannedTopicIssue, fabricationFlags }] = await Promise.all([
    import('../preflight.mjs'), import('../checks.mjs')]);
  const tweets = (Array.isArray(input.tweets) ? input.tweets : []).map(String);
  const hook = String(input.hook ?? tweets[0] ?? '');
  const whole = `${hook}\n${tweets.join('\n')}`;
  const reasons = [];
  if (RETWEET_RE.test(hook.trim())) reasons.push('retweet');
  if (UNRECREATABLE.test(hook)) reasons.push('unrecreatable_hook');
  if (fabricationFlags([hook, ...tweets]).some((f) => f.kind === HARD_QUOTE)) reasons.push('named_quote');
  if (ADULT_DENY.test(hook) || OFF_NICHE.test(hook) || bannedTopicIssue(hook) || bannedTopicIssue(tweets.length ? tweets : [hook]) || DRUG_RE.test(whole)) reasons.push('regex_reject');
  return reasons;
}

/** The caller may pass `input.incumbentReasons` (computed once, so the policy can OR it in). */
export async function incumbent(input = {}) {
  const reasons = Array.isArray(input.incumbentReasons) ? input.incumbentReasons : await incumbentReasons(input);
  return { action: reasons.length ? HOLD : 'pass', reasons };
}

// ---- Policy (pure) -----------------------------------------------------------------------------------
const need = (t, k) => {
  if (!Number.isFinite(t?.[k])) throw new Error(`donor-screen: thresholds.${k} is required`);
  return t[k];
};

/**
 * Probability the thread is NOT English: from the distribution when present, else the choice's
 * confidence. A pick with no confidence at all is taken at face value (1), never read as 0: a bare
 * `english` is English and a bare `spanish` is not.
 */
export function nonEnglish(answer) {
  if (!answer || typeof answer.choice !== 'string') return null;
  const dist = answer.probabilities || answer.distribution;
  if (dist && Number.isFinite(dist.english)) return 1 - dist.english;
  const p = Number.isFinite(answer.confidence) ? answer.confidence : classProb(answer, answer.choice);
  const c = Number.isFinite(answer.confidence) || Number.isFinite(dist?.[answer.choice]) ? p : 1;
  return answer.choice === 'english' ? 1 - c : c;
}

/** The language a fired check names: the pick when it is not English, else the likeliest other class. */
function languageLabel(answer) {
  if (answer.choice !== 'english') return answer.choice;
  const dist = answer.probabilities || answer.distribution || {};
  const other = LANGUAGES.filter((l) => l !== 'english' && Number.isFinite(dist[l])).sort((a, b) => dist[b] - dist[a])[0];
  return other || 'not_english';
}

/**
 * Pure. thresholds: { flagAt, nonEnglishAt }. `input.incumbentReasons` (computed by the caller or by
 * readScreen) keeps the regex side monotone: any regex reason flags whatever Jev says.
 */
export function policy(answers, thresholds, { input } = {}) {
  const flagAt = need(thresholds, 'flagAt');
  const langAt = need(thresholds, 'nonEnglishAt');
  const dist = (x, th) => (x >= th ? (x - th) / Math.max(1 - th, 1e-9) : (th - x) / Math.max(th, 1e-9));
  // laws.json jev.allowedSafetyClasses (owner, 2026-09-23: "quoting is fine"): asked, never flagged by Jev.
  // The regex fabrication screen in incumbentReasons still runs.
  const allowed = new Set(LAWS.jev?.allowedSafetyClasses || []);
  const checks = BATTERY_KEYS.filter((k) => !allowed.has(k)).map((k) => ({ reason: k, x: answers?.[k]?.noul, th: flagAt }));
  checks.push({ reason: 'language', x: nonEnglish(answers?.language), th: langAt });
  const read = checks.filter((c) => Number.isFinite(c.x)).map((c) => ({ ...c, fires: c.x >= c.th, strength: dist(c.x, c.th) }));
  const fired = read.filter((c) => c.fires);
  const regex = Array.isArray(input?.incumbentReasons) ? input.incumbentReasons : [];
  const reasons = [...fired.map((c) => (c.reason === 'language' ? `language:${languageLabel(answers.language)}` : c.reason)), ...regex.map((r) => `regex:${r}`)];
  if (regex.length) return { action: HOLD, confidence: 1, reasons };
  if (fired.length) return { action: HOLD, confidence: Math.min(1, +Math.max(...fired.map((c) => c.strength)).toFixed(6)), reasons };
  const confidence = read.length ? Math.min(...read.map((c) => c.strength)) : 0;
  return { action: 'pass', confidence: Math.min(1, +confidence.toFixed(6)), reasons: [] };
}

// ---- Eval adapter (scripts/jev-eval.mjs) ---------------------------------------------------------------
/**
 * Labels: evals/jev/donor-screen.jsonl (scripts/donor-labels.mjs), one donor per row, hash only. Field
 * `flag` (binary): the policy's action (Jev OR regex, monotone), with `jevOnly` for Jev alone. Its sweep
 * score is Jev's strongest signal (the battery nouls and P(not English)), not a probability. The
 * operator's off-niche drops are labels here, but no question in this set asks about niche: only the
 * incumbent's OFF_NICHE regex can catch one.
 */
export const EVAL = Object.freeze({
  labels: 'donor-screen',
  batchSize: 1,
  fields: Object.freeze({ flag: { type: 'binary', score: 'flagScore' } }),
  loadItem: async (row, ctx) => (await import('../scripts/donor-labels.mjs')).loadDonorItem(row, ctx),
  async toInput([it]) {
    const donor = { hook: it.hook, tweets: it.tweets };
    return { ...donor, incumbentReasons: await incumbentReasons(donor) };
  },
  predict(answers, thresholds, input) {
    const v = policy(answers, thresholds, { input });
    const alone = policy(answers, thresholds, { input: { ...input, incumbentReasons: [] } });
    const parts = [...BATTERY_KEYS.map((k) => answers?.[k]?.noul), nonEnglish(answers?.language)].filter(Number.isFinite);
    return [{ flag: { value: v.action === HOLD, jevOnly: alone.action === HOLD, prob: parts.length ? Math.max(...parts) : null } }];
  },
  async incumbent(input) { return [{ flag: { value: (await incumbent(input)).action === HOLD } }]; },
});
