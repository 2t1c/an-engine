#!/usr/bin/env node
// Read-only selection surface for chat-written covers/seeds; never creates a post.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PODS, variantFor } from './pods.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { loadCtaLearningPolicy, selectLearnedSkeletonSlots } from './cta-learning-policy.mjs';
export function recommendCta({ podId, account, role = 'heavy', selectionKey, alt = 0, now = new Date(), policy = loadCtaLearningPolicy({ now }) }) {
  if (!['heavy', 'light'].includes(role)) throw new Error('role must be heavy or light');
  if (!ACCOUNTS[account]) throw new Error('Unknown account key');
  const pod = PODS.find((p) => p.id === podId && p.status !== 'retired');
  if (!pod) throw new Error('Unknown or retired pod');
  if (!Number.isInteger(alt) || alt < 0) throw new Error('alt must be a non-negative integer');
  const variant = variantFor(pod, account, { system: 'skeleton', fallback: false });
  if (!variant) return { podId, account, role, system: 'backline', reason: 'No skeleton variant; use the existing pod fallback without learning.' };
  const choice = selectLearnedSkeletonSlots({ podId, asin: pod.asin, accountKey: account, variant, role, policy, now, selectionKey, alt });
  return { podId, asin: pod.asin, account, role, system: 'skeleton', ...choice,
    instruction: 'Use the selected approved question and direct recommendation within the flexible skeleton. Adapt the first beat to the preceding thought. Keep protocol/outcome personal claims specific to the actual speaker. Preserve the original harvest body and deliberate experiment controls.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), get = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
    console.log(JSON.stringify(recommendCta({ podId: get('--pod'), account: get('--account'), role: get('--role', 'heavy'), selectionKey: get('--key'), alt: Number(get('--alt', 0)) }), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
