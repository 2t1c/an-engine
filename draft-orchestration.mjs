import { mayRetryBeforeEffect } from './process-result.mjs';

export async function runSafeDraftAttempts(run, maxAttempts = 2) {
  let outcome = null;
  let llmCost = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    outcome = await run(attempt);
    llmCost += outcome.llmCost;
    if (!mayRetryBeforeEffect(outcome)) break;
  }
  return { ...outcome, llmCost };
}

export const mayFallbackDonor = (outcome, skeleton) => Boolean(skeleton && mayRetryBeforeEffect(outcome));
export const budgetReached = (spent, budget) => Boolean(budget && spent >= budget);
export const advanceDraftSpend = (spent, budget, outcome) =>
  (budget && outcome.phase === 'unknown' ? Math.max(spent, budget) : spent) + outcome.llmCost;

export async function finalizeSkeletonCreate(outcome, { faithful, attachMedia }) {
  let media = false;
  if (outcome.ok && outcome.result?.draftId && faithful) {
    try { await attachMedia(outcome.result.draftId); media = true; } catch {}
  }
  return { outcome, media, reconciliation: outcome.evidencePath || null };
}
