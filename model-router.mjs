// model-router.mjs — Jev picks the writer model per task (owner, 2026-09-24: "Not everything needs the
// highest model, so you can functionally switch between models to save time and money").
//
//   decisions/model-route.mjs   Jev reads the task: difficulty, voice-critical, many rules -> a tier
//   laws.json modelRouting      the tiers' models (native id + the in-session agent name), each role's
//                               floor / ceiling / default, and which roles are routed at all
//   this file                   clamps Jev's tier to the role's limits, caches per task, and hands
//                               lib.mjs anthropic() a model; escalateTier() is the one-step-up retry
//
// Precedence (lib.mjs resolveModel): MODEL_<ROLE> and LLM_MODEL, the operator's explicit word, still
// win; a caller's explicit `model` wins; a pinNative call is never routed. A role not listed in
// modelRouting.roles keeps its call default. Jev unread -> the role's default tier.
import { createHash } from 'node:crypto';
import { LAWS } from './laws.mjs';

export const TIERS = Object.freeze(['fast', 'standard', 'strong']);
const CACHE = new Map();
const rank = (t) => TIERS.indexOf(t);

export function routingConfig(laws = LAWS) {
  const r = laws.modelRouting || {};
  return { enabled: r.enabled !== false, tiers: r.tiers || {}, roles: r.roles || {} };
}

/** PURE. Clamp a tier to a role's { min, max }. */
export function clampTier(tier, { min = 'fast', max = 'strong' } = {}) {
  const t = Math.min(Math.max(rank(tier) < 0 ? rank('standard') : rank(tier), rank(min)), rank(max));
  return TIERS[t];
}

/** PURE. The next tier up within the role's ceiling, or null when already there. */
export function escalateTier(tier, { max = 'strong' } = {}) {
  const i = rank(tier);
  return i >= 0 && i < rank(max) ? TIERS[i + 1] : null;
}

const briefOf = (system, messages) => [system || '', ...(messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))].join('\n\n');

/**
 * The route for one call: { tier, model, agent, by, reasons } or null when the role is not routed.
 * `client` is jev(env) (made lazily when omitted); `log` is the decision log (none by default).
 */
export async function routeModel(env, { role, system, messages, client = null, laws = LAWS, log = null } = {}) {
  const cfg = routingConfig(laws);
  const roleCfg = cfg.roles[role];
  if (!cfg.enabled || !roleCfg) return null;
  const def = clampTier(roleCfg.default || 'standard', roleCfg);
  const brief = briefOf(system, messages);
  const key = createHash('sha256').update(`${role}\n${brief}`).digest('hex');
  if (CACHE.has(key)) return CACHE.get(key);
  let tier = def, by = 'default', reasons = [];
  if (roleCfg.min !== roleCfg.max) {
    try {
      const { decide, decisionConfig } = await import('./jev-decide.mjs');
      const { DECISIONS } = await import('./decisions/index.mjs');
      const jevClient = client || (await import('./jev.mjs')).jev(env);
      const r = await decide('model-route', { role, brief, defaultTier: def }, { client: jevClient, registry: DECISIONS, laws, log, cache: null });
      if (r.source !== 'fallback' && r.answers) {
        const v = DECISIONS['model-route'].policy(r.answers, decisionConfig('model-route', laws).thresholds);
        tier = clampTier(v.action, roleCfg); by = 'jev'; reasons = v.reasons;
        if (tier !== v.action) reasons.push(`clamped to ${role}'s ${tier === roleCfg.min ? 'floor' : 'ceiling'}`);
      } else reasons = [`Jev not read (${r.fallback || 'unread'}): ${role}'s default`];
    } catch (e) { reasons = [`Jev not read (${String(e.message).slice(0, 60)}): ${role}'s default`]; }
  } else reasons = [`${role} is fixed at ${def}`];
  const t = cfg.tiers[tier] || {};
  const out = { tier, model: t.model || null, agent: t.agent || null, by, reasons };
  CACHE.set(key, out);
  return out;
}

/** The model for a given tier (escalation), or null. */
export function modelForTier(tier, laws = LAWS) {
  return routingConfig(laws).tiers[tier]?.model || null;
}

export const _clearRouteCache = () => CACHE.clear();
