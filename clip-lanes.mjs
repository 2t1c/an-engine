// clip-lanes.mjs: the clip pool every clip script mines and stores into. One lane, health, on the
// clips base (config/airtable.json bases.clips, or CLIPS_BASE_ID).
import { CLIP_RULES } from './clip-judge.mjs';
import { CLIPS_BASE, TABLES } from './config.mjs';

export const FLEET_FOCUS = "the listener's own health: the body, sleep, nutrition, supplements, hormones, fitness or mental health";


export const LANES = {
  health: { name: 'health', base: CLIPS_BASE, tables: null, focus: FLEET_FOCUS, rules: CLIP_RULES, pool: { minFit: 0.5, top: 12 } },
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
