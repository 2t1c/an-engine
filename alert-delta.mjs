// alert-delta.mjs — send a standing alert only when it changes (owner, 2026-10-06: "smoothen out our admin").
// The vendor reorder alert went out 30 of 30 days and vendor-reconcile flagged drift nearly every day with
// the same content, so the owner learned to skip the Fuel topic. A script logs the keys of what it would
// alert on (logRun, committed by its workflow); the next run compares against the last log and sends only
// what is new. A first run with no prior keys sends everything.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';

/** The most recent logs/<pipeline>-<date>.json, or null. Read it before this run's logRun overwrites today's. */
export function lastLog(pipeline, dir = join(HERE_DIR, 'logs')) {
  if (!existsSync(dir)) return null;
  const re = new RegExp(`^${pipeline}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
  const file = readdirSync(dir).filter((f) => re.test(f)).sort().pop();
  if (!file) return null;
  try { return JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { return null; }
}

/** PURE. { fresh, cleared, changed, first } between the last run's alert keys and this run's. */
export function alertDelta(prevKeys, keys) {
  const first = !Array.isArray(prevKeys);
  const before = new Set(first ? [] : prevKeys), now = new Set(keys);
  const fresh = [...now].filter((k) => !before.has(k)), cleared = [...before].filter((k) => !now.has(k));
  return { fresh, cleared, changed: first ? now.size > 0 : fresh.length > 0, first };
}
