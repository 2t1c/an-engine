// stamps.mjs — the ONE reader for back-stamps (plan Track G: "append-only stamp rows read through ONE
// resolver every reader uses"). Readers: learn.mjs and topic-intent.mjs take a topic stamp first (plan v7
// N3 consumer switch); with no stamp above the floor they keep the ledger value, then their regex fallback.
//
// A stamp is a row in learnings/stamps/<field>.jsonl, appended by scripts/backstamp.mjs and never
// rewritten: {ts, key, field, value, p, model, questionSetHash}. Ledger rows are never touched; revenue
// joins on them. Keys are the ledger's own join keys:
//   topic, topic-multi   key = draftId                (topic-intent.mjs, mold-promote.mjs join on it)
//   cta-recipe           key = `${draftId}:${role}`   (cta-learn's observation identity, role heavy|light)
//
// resolve(field, key) -> { value, source, p, model } (+ `label`, the raw stamp label, on a stamp):
//   source 'stamp'   the LATEST stamp row for the key, when its p clears the field's floor;
//   source 'ledger'  otherwise the ledger's own value (last ledger row for the draft carrying the field,
//                    the rule topic-intent.mjs uses), when the field exists on the ledger;
//   source 'none'    neither: value null. Unknown is never reported as a value.
// A newer stamp below the floor does not fall back to an older stamp above it: the latest reading wins
// or the ledger does. Only rows under the question-set hash laws.json records for the field's decision
// count (currentStamps): a stamp from a superseded wording is ignored.
//
// Readers' vocabulary: a topic stamp of 'general_health' or 'not_health' (the explicit general split)
// resolves to value 'general', the label readers and topics.json know, with the split kept in `label`.
// A cta-recipe stamp is usable only when it names a recipe in the CURRENT library whose role matches the
// key's role (cta-learn's recipe id carries pod and role), or 'none'; anything else is ignored. The
// question-set hash of a dynamic set covers its template, not pods.json: after a library edit, re-stamp
// under a new hash to re-ask plugs stamped 'none'.
//
// Floors are law (laws.json `jev.decisions.<decision>.thresholds.stampFloor`), read here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAWS } from './laws.mjs';
import { HERE_DIR } from './lib.mjs';
import { parseLedgerRows, readLedgerRows } from './state/ledger-store.mjs';
import { NONE as NO_RECIPE, libraryRecipes } from './decisions/cta-recipe-stamp.mjs';
import { GENERAL_LABELS } from './decisions/topic-stamp.mjs';

export const STAMPS_DIR = join(HERE_DIR, 'learnings', 'stamps');
export const LEDGER_FILE = join(HERE_DIR, 'ledger.jsonl');

/** field -> the decision that stamps it, and the ledger field that holds the declared value (or null). */
export const STAMP_FIELDS = Object.freeze({
  topic: { decision: 'topic-stamp', ledgerField: 'topic' },
  'topic-multi': { decision: 'topic-stamp', ledgerField: null },
  'cta-recipe': { decision: 'cta-recipe-stamp', ledgerField: null },
});
export const STAMP_ROW_KEYS = Object.freeze(['ts', 'key', 'field', 'value', 'p', 'model', 'questionSetHash']);

export function stampFloor(field, laws = LAWS) {
  const spec = STAMP_FIELDS[field];
  if (!spec) throw new Error(`stamps: unknown field ${field}`);
  const floor = laws?.jev?.decisions?.[spec.decision]?.thresholds?.stampFloor;
  if (!Number.isFinite(floor)) throw new Error(`stamps: laws.json jev.decisions.${spec.decision}.thresholds.stampFloor is required`);
  return floor;
}

export const stampFile = (field, dir = STAMPS_DIR) => join(dir, `${field}.jsonl`);

let LIB_CACHE = null;
const LIBRARY = () => (LIB_CACHE ||= new Map(libraryRecipes().map((r) => [r.id, r])));

/** Whether a stamp's value can be used as a reader value for its key. */
export function isUsableStamp(field, key, value, library = null) {
  if (value == null) return false;
  if (field !== 'cta-recipe') return true;
  if (value === NO_RECIPE) return true;
  const recipe = (library || LIBRARY()).get(value);
  return Boolean(recipe) && recipe.role === String(key).split(':')[1];
}

/** A stamp value in the readers' vocabulary: the general split reads as 'general'. */
export function readerValue(field, value) {
  return field === 'topic' && Object.hasOwn(GENERAL_LABELS, value) ? 'general' : value;
}

/** Every row of a field's stamp file, in append order (torn lines skipped). */
export function readStamps(field, { dir = STAMPS_DIR } = {}) {
  const f = stampFile(field, dir);
  return existsSync(f) ? parseLedgerRows(readFileSync(f, 'utf8')) : [];
}

/** key -> latest stamp row (append order: the last row for a key wins). */
export function latestStamps(rows) {
  const m = new Map();
  for (const r of rows) if (r && r.key != null) m.set(String(r.key), r);
  return m;
}

/** The question-set hash laws.json records for the decision that stamps `field` (null when none). */
export function currentHash(field, laws = LAWS) {
  const spec = STAMP_FIELDS[field];
  if (!spec) throw new Error(`stamps: unknown field ${field}`);
  return laws?.jev?.decisions?.[spec.decision]?.questionSetHash || null;
}

/**
 * key -> latest stamp row asked under the CURRENT question set. A row stamped under a superseded
 * wording (cta-recipe v1 beside v2 in the same file) is not a reading of the current set, so it is
 * dropped before "latest wins": a key the current set has not stamped yet reads as unstamped.
 */
export function currentStamps(field, { dir = STAMPS_DIR, laws = LAWS } = {}) {
  const hash = currentHash(field, laws);
  const rows = readStamps(field, { dir });
  return latestStamps(hash ? rows.filter((r) => r?.questionSetHash === hash) : rows);
}

/** draftId -> last ledger value of `ledgerField` (topic-intent.mjs's rule). */
export function ledgerValues(ledgerRows, ledgerField) {
  const m = new Map();
  if (!ledgerField) return m;
  for (const e of ledgerRows) if (e?.draftId && e[ledgerField] != null && e[ledgerField] !== '') m.set(String(e.draftId), e[ledgerField]);
  return m;
}

/**
 * A resolver over one snapshot of the stamp files and the ledger. Build it once per run; resolve() is
 * then a map lookup. `ledgerRows` and `laws` are injectable for tests.
 */
export function createResolver({ dir = STAMPS_DIR, ledgerRows = null, ledgerFile = LEDGER_FILE, laws = LAWS } = {}) {
  const cache = new Map();
  let ledger = ledgerRows;
  const forField = (field) => {
    if (!cache.has(field)) {
      const spec = STAMP_FIELDS[field];
      if (!spec) throw new Error(`stamps: unknown field ${field}`);
      if (spec.ledgerField && !ledger) ledger = readLedgerRows(ledgerFile);
      cache.set(field, { floor: stampFloor(field, laws), stamps: currentStamps(field, { dir, laws }), ledger: ledgerValues(ledger || [], spec.ledgerField) });
    }
    return cache.get(field);
  };
  return {
    resolve(field, key) {
      const { floor, stamps, ledger: fromLedger } = forField(field);
      const k = String(key);
      const s = stamps.get(k);
      if (s && Number.isFinite(s.p) && s.p >= floor && isUsableStamp(field, k, s.value)) {
        return { value: readerValue(field, s.value), label: s.value, source: 'stamp', p: s.p, model: s.model ?? null };
      }
      const draftId = k.split(':')[0];
      if (fromLedger.has(draftId)) return { value: fromLedger.get(draftId), source: 'ledger', p: null, model: null };
      return { value: null, source: 'none', p: null, model: null };
    },
  };
}

let DEFAULT = null;
/** resolve(field, key) over the repo's stamp files and ledger (read once per process). */
export function resolve(field, key) {
  DEFAULT ||= createResolver();
  return DEFAULT.resolve(field, key);
}
