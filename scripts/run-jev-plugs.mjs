// scripts/run-jev-plugs.mjs — the products-change recheck (plan Track S: "every products change re-runs a
// check that each plug's lead-in names the product linked there"; R2026-09-23, marcos: the product became
// NAD+ while a CoQ10 lead-in stayed).
//
// When a row's products change after drafting (a swap at drafts, a products-stage rerun), the drafts
// reading's plug flags describe the OLD products, and its copy digest cannot tell, because the copy did
// not change. run-jev.mjs now records `productsSha256` on each drafts reading; this re-asks ONLY the plug
// questions of run-jev's draftQuestions for the rows whose products differ (or the rows named by --rows)
// and merges the result into RUN_DIR/jev/plugs.json. run-jev's readingsFor('drafts') attaches it to the
// row's reading and jevLines prints it in place of the stale plug lines.
//
// REPORT-ONLY, like every run-jev reading: it never changes a row's status, a product or an approval, and
// a failed or partial read is "not read". Pinned to RUN_JEV_MODEL (jev-1.13).
//
//   node scripts/run-jev.mjs --stage plugs --run-dir RUN_DIR --input SPEC.json [--rows C01,C02]
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jev } from '../jev.mjs';
import { RUN_JEV_MODEL, copyDigest, draftFlags, draftQuestions, missingAnswers, named, productsDigest, readingsFor } from './run-jev.mjs';

const text = (value) => String(value ?? '').trim();

/**
 * Pure: the ids to recheck. A row counts when it has a drafts reading that recorded its products
 * (productsSha256) and they differ from the row's products now, unless a recheck of exactly this copy and
 * these products is already attached (readingsFor('drafts') attaches plugs.json as `plugRecheck`), so a
 * rerun never pays twice. A row with no such reading is not rechecked: its packet shows no drafts reading
 * to replace, so `--stage drafts` is the read it needs.
 */
export function productsChanged(rows, draftsReadings = new Map()) {
  return rows.filter((row) => {
    const reading = draftsReadings.get(row.id);
    const now = productsDigest(row.draft?.products);
    if (!reading?.productsSha256 || reading.productsSha256 === now) return false;
    const done = reading.plugRecheck;
    return !(done && done.productsSha256 === now && done.copySha256 === copyDigest((row.draft?.tweets || []).map(String)));
  }).map((row) => row.id);
}

/** The real path of `target`, resolving its nearest existing ancestor (the dir may not exist yet). */
function realTarget(target) {
  let anchor = resolve(target);
  const tail = [];
  while (!existsSync(anchor) && dirname(anchor) !== anchor) { tail.unshift(basename(anchor)); anchor = dirname(anchor); }
  return resolve(realpathSync(anchor), ...tail);
}

/** One row: the plug questions only, on the same state run-jev's drafts read sends. */
export async function recheckPlugs(row, { client, model = RUN_JEV_MODEL } = {}) {
  const tweets = (row.draft?.tweets || []).map(String);
  const base = { id: row.id, copySha256: copyDigest(tweets), productsSha256: productsDigest(row.draft?.products) };
  if (!tweets.length) return { ...base, status: 'not read', reason: 'no tweets to read' };
  try {
    const products = (row.draft?.products || []).map((p) => ({ ...p, label: text(p.label || p.substance || p.title || p.asin).slice(0, 80) }));
    const { questions: all, plugs } = draftQuestions({ tweets, products });
    const questions = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('plug_')));
    // A thread past run-jev's MAX_TWEETS keeps the drafts reading's own "read to T40" flag in the packet.
    if (!plugs.length) return { ...base, status: 'read', model: null, plugs: [], flags: [] };
    const { askThrough } = await import('../jev-decide.mjs');
    const result = await askThrough('plugs-read', client, { state: { hook: tweets[0], tweets: named(tweets) }, questions }, { role: 'run-jev-plugs' });
    const gaps = missingAnswers(questions, result?.answers);
    if (gaps.length) return { ...base, status: 'not read', reason: `Jev left ${gaps.length} question(s) unanswered (${gaps.slice(0, 4).join(', ')})` };
    const flags = draftFlags(result.answers, { tweets, plugs }).filter((f) => f.kind === 'plug');
    return { ...base, status: 'read', model: result.model, plugs: plugs.map(({ tweet, label }) => ({ tweet, label })), flags };
  } catch (error) {
    return { ...base, status: 'not read', reason: `${error?.details?.code || error?.message || 'error'}`.slice(0, 160) };
  }
}

/** Recheck `targets` and merge into RUN_DIR/jev/plugs.json. `client` is jev(env) or a test fake. */
export async function writeRecheck(runDir, targets, { client, concurrency = 12 } = {}) {
  const REPO = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
  const target = realTarget(runDir); // symlinks resolved: a link into the repo is still inside it
  if (target === REPO || target.startsWith(`${REPO}${sep}`)) throw new Error('RUN_DIR must be outside the repository: Jev readings quote unpublished copy');
  const read = new Array(targets.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (next < targets.length) { const i = next++; read[i] = await recheckPlugs(targets[i], { client }); }
  }));
  const merged = new Map([...readingsFor(runDir, 'plugs'), ...read.map((r) => [r.id, r])]);
  const dir = join(target, 'jev');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'plugs.json'), `${JSON.stringify({ schema: 'run-jev-plugs-v1', stage: 'plugs', model: RUN_JEV_MODEL,
    readAt: new Date().toISOString(), rows: [...merged.values()] }, null, 2)}\n`, { mode: 0o600 });
  return read;
}

/** CLI body for `run-jev.mjs --stage plugs`. Without --rows: every row whose products changed. */
export async function plugsMain({ runDir, input, only = null, client = null }) {
  const rows = JSON.parse(readFileSync(resolve(input), 'utf8')).rows || [];
  const ids = only ? new Set(String(only).split(',').map((x) => x.trim()).filter(Boolean)) : new Set(productsChanged(rows, readingsFor(runDir, 'drafts')));
  const targets = rows.filter((row) => ids.has(row.id));
  if (!targets.length) { console.log('plugs: no row\'s products changed since the drafts read; nothing to recheck'); return []; }
  let jevClient = client;
  if (!jevClient) { const { loadEnv } = await import('../lib.mjs'); jevClient = jev(loadEnv()); }
  const read = await writeRecheck(runDir, targets, { client: jevClient });
  console.log(`plugs (products changed, report-only): ${read.filter((r) => r.status === 'read').length}/${read.length} rechecked · ${read.filter((r) => r.flags?.length).length} flagged · ${read.filter((r) => r.status !== 'read').length} not read`);
  for (const r of read) if (r.status !== 'read' || r.flags.length) console.log(`  ${r.id}: ${r.status !== 'read' ? `NOT READ (${r.reason})` : r.flags.map((f) => f.note).join(' | ')}`);
  return read;
}
