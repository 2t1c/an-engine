// clip-lanes.mjs — which clip pool a clip script works on. The health fleet's pool (CLIPS_BASE) is the
// default; `--lane gtx` points the same scripts at the GTX & AI pool (GTX_CLIPS_BASE), with its own focus
// and its own, lower mining bars.
//
// WHY A SECOND POOL (operator 2026-10-09): "can we setup something similar for GTX and the Ai accounts —
// Our topics are wider — so maybe more videos and score doesn't need to be too high for rating". GTX and
// the AI pages post founders, investing, AI, history and psychology, so the focus is wide, an episode
// enters on a lower fit, and a passage becomes a clip on a lower bar. Only MINE is loosened: MATCH (which
// clip proves which tweet) keeps the health bars, because a clip on the wrong point is worse than none.
//
// The lane's base has the same tables under its own ids; laneTables() maps the health ids the code is
// written against onto them, so no call site changes.
import { CLIP_RULES } from './clip-judge.mjs';
import { CLIPS_BASE, GTX_CLIPS_BASE, GTX_CLIP_TABLES, TABLES } from './config.mjs';

export const FLEET_FOCUS = "the listener's own health: the body, sleep, nutrition, supplements, hormones, fitness or mental health";
export const GTX_FOCUS = 'business, startups, founders, investing, money, AI and technology, science, history, psychology, or how successful people think, decide and work';

/** The GTX & AI mining bars: every CLIP_RULES number not named here is the health one. */
export const GTX_CLIP_RULES = {
  ...CLIP_RULES,
  gates: { ...CLIP_RULES.gates, minClaim: 0.25, minFocus: 0.35 },
  clip: { ...CLIP_RULES.clip, minClaim: 0.5, minSelfContained: 0.5, minRank: 0.5 },
};

export const LANES = {
  health: { name: 'health', base: CLIPS_BASE, tables: null, focus: FLEET_FOCUS, rules: CLIP_RULES, pool: { minFit: 0.5, top: 12 } },
  gtx: { name: 'gtx', base: GTX_CLIPS_BASE, tables: GTX_CLIP_TABLES, focus: GTX_FOCUS, rules: GTX_CLIP_RULES, pool: { minFit: 0.3, top: 20 } },
};

/** `--lane <name>` (default health). An unknown name throws, so a typo never mines into the health pool. */
export function clipLaneOf(name) {
  const key = String(name || 'health').trim().toLowerCase();
  if (!LANES[key]) throw new Error(`unknown clip lane "${name}" (known: ${Object.keys(LANES).join(', ')})`);
  return LANES[key];
}

/** The lane's base id. CLIPS_BASE_ID in the env still overrides the health lane only (tests, a copy base). */
export const laneBase = (lane, env = {}) => (lane.name === 'health' ? String(env.CLIPS_BASE_ID || lane.base).trim() : lane.base);

/**
 * An Airtable client whose calls name the health table ids, sent to the lane's own ids. A first argument
 * that is not one of the three clip tables passes through untouched. Pure wrapper.
 */
export function laneTables(at, lane) {
  if (!lane?.tables) return at;
  const map = new Map(Object.entries(lane.tables).map(([k, id]) => [TABLES[k], id]));
  return new Proxy(at, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function') return v;
      return (first, ...rest) => v.call(target, map.has(first) ? map.get(first) : first, ...rest);
    },
  });
}
