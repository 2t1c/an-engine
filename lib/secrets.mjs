// The secrets contract: every credential the engine reads, who owns it, and which feature needs it.
// Values come only from process.env (Railway variables in production, .env locally).
// Nothing here ever prints or returns a value, only whether it is set.

/** @typedef {{ name: string, owner: 'buyer' | 'operator', feature: string, required: boolean, note: string }} Secret */

/** @type {Secret[]} */
export const SECRETS = [
  // Buyer's own accounts
  { name: 'TYPEFULLY_API_KEY', owner: 'buyer', feature: 'publishing', required: true, note: "The buyer's Typefully API key, with every page connected" },
  { name: 'LEVANTA_API_KEY', owner: 'buyer', feature: 'links', required: true, note: "The buyer's Levanta key: link minting, catalogue and the profit-share count" },
  { name: 'AIRTABLE_PAT', owner: 'buyer', feature: 'data', required: true, note: "Token for the buyer's Airtable account, held by the operator" },
  { name: 'XDB_BASE_ID', owner: 'buyer', feature: 'data', required: true, note: 'Swipe base: competitor and swipe threads (the daily copy lands here)' },
  { name: 'REGISTRY_BASE_ID', owner: 'buyer', feature: 'data', required: true, note: "Registry base: the buyer's own posts, links and runs" },
  { name: 'TELEGRAM_BOT_TOKEN', owner: 'buyer', feature: 'ops', required: true, note: "Bot in the buyer's Telegram group" },
  { name: 'TELEGRAM_CHAT_ID', owner: 'buyer', feature: 'ops', required: true, note: "The buyer's Telegram group" },

  // Operator-hosted services (costs passed through before the profit split)
  { name: 'RAPIDAPI_KEY', owner: 'operator', feature: 'data', required: true, note: 'X reads (views, followers, thread bodies)' },
  { name: 'GH_PUSH_TOKEN', owner: 'operator', feature: 'ops', required: true, note: "Fine-grained token, contents:write on this buyer's clone only; the cron persists run logs with it" },
  { name: 'SWIPE_SOURCE_PAT', owner: 'operator', feature: 'data', required: false, note: "Read-only token for the operator's swipe base, used by the daily swipe copy" },
  { name: 'SWIPE_SOURCE_BASE_ID', owner: 'operator', feature: 'data', required: false, note: "The operator's swipe base the daily copy reads from" },
  { name: 'CLIPPER_URL', owner: 'operator', feature: 'clips', required: false, note: 'Hook clips: the operator-hosted clipper' },
  { name: 'CLIPPER_SERVICE_KEY', owner: 'operator', feature: 'clips', required: false, note: 'Hook clips: key for the clipper' },
  { name: 'RT_BOT_URL', owner: 'operator', feature: 'reach', required: false, note: "RT ladder: this buyer's own RT bot" },
  { name: 'RT_BOT_WEBHOOK_SECRET', owner: 'operator', feature: 'reach', required: false, note: "RT ladder: shared secret for this buyer's RT bot" },
];

/** Secrets that must be set together, or not at all. */
export const PAIRS = [
  ['CLIPPER_URL', 'CLIPPER_SERVICE_KEY'],
  ['RT_BOT_URL', 'RT_BOT_WEBHOOK_SECRET'],
  ['SWIPE_SOURCE_PAT', 'SWIPE_SOURCE_BASE_ID'],
];

const isSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/**
 * PURE. Which secrets are set, never their values.
 * @param {Record<string, string | undefined>} env
 */
export function secretsStatus(env = process.env) {
  const rows = SECRETS.map((s) => ({ name: s.name, owner: s.owner, feature: s.feature, required: s.required, set: isSet(env, s.name) }));
  const missing = rows.filter((r) => r.required && !r.set).map((r) => r.name);
  const halfPairs = PAIRS.filter((pair) => {
    const n = pair.filter((name) => isSet(env, name)).length;
    return n > 0 && n < pair.length;
  });
  return { rows, missing, halfPairs, ok: missing.length === 0 && halfPairs.length === 0 };
}

/**
 * Read one secret. Throws with the secret's name (never a value) when it is not set.
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 */
export function secret(name, env = process.env) {
  if (!SECRETS.some((s) => s.name === name)) throw new Error(`secret ${name} is not in the contract (lib/secrets.mjs)`);
  if (!isSet(env, name)) throw new Error(`secret ${name} is not set`);
  return /** @type {string} */ (env[name]).trim();
}
