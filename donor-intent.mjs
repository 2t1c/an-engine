// donor-intent.mjs — the /funnel rubric (.claude/skills/funnel/SKILL.md) as Jev questions. The rubric
// is the operator's, unchanged: five dimensions scored 0-2, total 0-10, verdict bands 8-10 write ·
// 5-7 write with a repair · <=4 swap. What changes is who scores it: Jev, in one call per donor, with
// the per-dimension trail persisted so it can be calibrated against measured $/1k (the rubric asks
// for exactly that trail). Report-only (swipe-classify.mjs call 2 records it; the bands are
// uncalibrated) until a backtest against measured $/1k says it earns more.
//
// plug_slot reads `plug_zone`, the third and fourth tweets joined in code. jev-1.13 reads literally
// and cannot be trusted to index into an array, so the location is computed, not asked for.
//
// Level wording is lifted from the skill. jev-1.13 reads literally (docs/typesafe-jev.md), so every
// level names its boundary instead of leaning on "good" or "strong".
import { BRIDGE, SYMPTOM_GATED, tweetsFromRollup } from './checks.mjs';
import { score } from './jev.mjs';

export const INTENT_DIMENSIONS = ['problem_hook', 'product_bridge', 'prescriptive', 'plug_slot', 'audience'];

export const INTENT_QUESTIONS = {
  problem_hook: score('Does `hook` name a problem the reader has, rather than a spectacle?', [
    'Spectacle, celebrity, a stunt, outrage or curiosity ("this is insane"); no problem the reader has is named.',
    'Touches a problem the reader might have, but indirectly or alongside a spectacle.',
    'Names a problem the reader has, such as "your belly fat", "can\'t sleep past 3am" or "resting heart rate".',
  ]),
  product_bridge: score('Does the argument in `tweets` naturally arrive at one of the substances in `we_sell`?', [
    'No substance in `we_sell` is part of the argument; reaching one would need a swerve away from the topic.',
    'A substance in `we_sell` is mentioned or loosely connected, but the argument does not lead to it.',
    'The argument naturally arrives at a substance in `we_sell`: taking it is where the thread\'s own reasoning goes.',
  ]),
  prescriptive: score('Does `tweets` tell the reader what to do, or only inform them?', [
    'Descriptive only: it informs, explains or entertains and never tells the reader what to do.',
    'Some advice, but vague or secondary to the information.',
    'Prescriptive: it tells the reader what to do, such as "take X in the morning" or "fix Y first".',
  ]),
  plug_slot: score('Is `plug_zone` (the third and fourth tweets of the thread) a natural place for a product recommendation?', [
    '`plug_zone` is empty, or a product recommendation there would have no connection to what it says.',
    'A recommendation could fit in `plug_zone`, but it would interrupt the argument.',
    '`plug_zone` already recommends a product, or naturally raises "which one do I take?".',
  ]),
  audience: score('Would a reader of this thread plausibly buy supplements?', [
    'Meme, outrage or curiosity traffic with no health worry.',
    'A general-interest audience; some readers have a health worry.',
    'Health-worried or self-improvement readers, the kind who buy supplements.',
  ]),
};

/** The rubric's own bands, in code. */
export function intentVerdict(total) {
  if (total == null) return null;
  return total >= 8 ? 'write' : total >= 5 ? 'repair' : 'swap';
}

// What we sell, as generic substance words (BRIDGE keys minus symptom words), for the bridge question.
export const WE_SELL = [...new Set(Object.keys(BRIDGE).filter((k) => !SYMPTOM_GATED.has(k)))].sort();

/** Tweets 3-4 (indices 2-3) joined: where a cover's plug sits. Empty for a thread shorter than 3. */
export function plugZone(tweets = []) {
  return tweets.slice(2, 4).map((t) => String(t || '').trim()).filter(Boolean).join('\n\n');
}

export function intentState({ hook = '', body = '' } = {}) {
  const tweets = tweetsFromRollup(String(body || ''));
  const list = (tweets.length ? tweets : [String(body || '')]).slice(0, 25);
  return { hook: String(hook || '').split('\n')[0], tweets: list, we_sell: WE_SELL, plug_zone: plugZone(list) };
}

/** One Jev call per donor: five scores, their total and the rubric's verdict. */
export async function scoreDonorIntent(client, donor, { role = 'donor-intent' } = {}) {
  const started = Date.now();
  const result = await client.ask({ state: intentState(donor), questions: INTENT_QUESTIONS, role });
  const dims = INTENT_DIMENSIONS.map((k) => result.answers[k]?.score ?? null);
  const total = dims.every((d) => d != null) ? +dims.reduce((a, b) => a + b, 0).toFixed(2) : null;
  return { model: result.model, ms: Date.now() - started, dims, total, verdict: intentVerdict(total),
    confidence: INTENT_DIMENSIONS.map((k) => result.answers[k]?.confidence ?? null), usage: result.usage };
}
