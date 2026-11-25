// decisions/donor-account-fit.mjs — does this donor fit this page? (plan Track B "Account fit",
// A3 "Selection": a `choice` that replaces the string tiers, because "most profiles have broad,
// similar niche lists", so the niche list alone cannot separate tina's page from peak's.)
//
// Report-only: laws.json `jev.decisions.donor-account-fit.mode` is `shadow`. The incumbent is
// scripts/cover-selection.mjs accountFit()'s tier (topic regex against the account's niches and
// variationTopics); decide() returns it and logs Jev's tier beside it. Selection is unchanged.
//
// Input: { hook, tweets, topic?, account: { niches, variationTopics, voice } } — the page block from
// accounts.mjs. The state carries the page's niche list, its topic focus and its persona (the first
// line of its voice), read from accounts.mjs, never typed here.
// Options are the three tiers, worded from accountFit's own reasons.
import { choice } from '../jev.mjs';
import { donorState } from './donor-screen.mjs';

export const name = 'donor-account-fit';
export const TIERS = Object.freeze(['specific', 'compatible', 'review']);
export const ACTIONS = TIERS;
export const safety = false;

export const QUESTIONS = {
  fit: choice("Where does this donor thread's subject sit against the X page in `page` (its niches, its topic focus and its persona's reader)?", {
    specific: "The thread's subject is in the page's stated topic focus, or speaks directly to its persona's reader.",
    compatible: "The thread's subject fits the page's stated niches, but not its specific focus or its persona's reader.",
    review: "The thread's subject is outside the page's stated niches or persona; the owner should review.",
  }),
};

const list = (xs) => (Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean) : []);

/** The page as the state shows it: niches, topic focus (variationTopics) and the persona line. */
export function pageOf(account = {}) {
  const persona = String(account.voice || '').split('\n')[0].trim().slice(0, 300);
  return { niches: list(account.niches), topic_focus: list(account.variationTopics), persona: persona || 'not stated' };
}

export function stateOf(input = {}) {
  if (!input.account || !list(input.account.niches).length) throw new Error('donor-account-fit: no account niches');
  return { ...donorState(input), page: pageOf(input.account) };
}

// ---- Incumbent: accountFit's tier (lazy: cover-selection.mjs loads preflight and the roster) --------
export async function incumbent(input = {}) {
  if (TIERS.includes(input.incumbentTier)) return { action: input.incumbentTier };
  const [{ accountFit }, { classifyTopic }] = await Promise.all([import('../scripts/cover-selection.mjs'), import('../pick-product.mjs')]);
  const tweets = (Array.isArray(input.tweets) ? input.tweets : []).map(String);
  const hook = String(input.hook ?? tweets[0] ?? '');
  const topic = input.topic || classifyTopic(hook.split('\n')[0], `${hook}\n${tweets.join('\n')}`);
  const fit = accountFit(input.account || {}, { topic });
  return { action: fit.tier, topic, reason: fit.reason };
}

/** Pure. Jev's tier, as sure as its choice. No thresholds: the floor lives in decide(). */
export function policy(answers) {
  const a = answers?.fit;
  if (!a || !TIERS.includes(a.choice)) throw new Error('donor-account-fit: no tier');
  const p = a.probabilities?.[a.choice] ?? a.distribution?.[a.choice];
  const confidence = Number.isFinite(a.confidence) ? a.confidence : Number.isFinite(p) ? p : null;
  return { action: a.choice, confidence };
}

// ---- Eval adapter (scripts/jev-eval.mjs) ---------------------------------------------------------------
/**
 * Labels: evals/jev/donor-account-fit.jsonl (scripts/donor-labels.mjs), one (donor, page) per row, hash
 * only. The operator's verdicts say whether a donor is right for THIS page (the 2026-09-11 voice swaps),
 * not which of three tiers it is, so the one field is binary: `specific` (Jev picked `specific`; its
 * probability of `specific` is the sweep's score). The donor text is read from Airtable at eval time.
 */
export const EVAL = Object.freeze({
  labels: 'donor-account-fit',
  batchSize: 1,
  fields: Object.freeze({ specific: { type: 'binary' } }),
  loadItem: async (row, ctx) => (await import('../scripts/donor-labels.mjs')).loadDonorItem(row, { ...ctx, needAccount: true }),
  toInput: ([it]) => ({ hook: it.hook, tweets: it.tweets, account: it.account }),
  predict(answers) {
    const a = answers?.fit;
    const p = a?.probabilities?.specific ?? a?.distribution?.specific;
    return [{ specific: { value: a ? a.choice === 'specific' : null, prob: Number.isFinite(p) ? p : null } }];
  },
  async incumbent(input) { return [{ specific: { value: (await incumbent(input)).action === 'specific' } }]; },
});
