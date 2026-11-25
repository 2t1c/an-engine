#!/usr/bin/env node
// scripts/swipe-reclassify.mjs — swipe DB Niche reclassification v1 (plan Appendix A; operator
// 2026-09-23: Health, Fitness and Mental Health are one niche, `Health`; overwrite Niche where Jev is
// confident; Health first). Questions and rules live in swipe-classify.mjs; this file is the I/O.
//
//   node scripts/swipe-reclassify.mjs [--dry] [--limit N] [--ids recA,recB]   # default: read-only plan
//   node scripts/swipe-reclassify.mjs --apply learnings/jev/swipe-reclass-<date>.jsonl
//   node scripts/swipe-reclassify.mjs --rollback learnings/jev/swipe-reclass-<date>.jsonl
//
// --dry     reads every head ({Tweet Number}=1) of the swipe table, asks Jev two questions sets per head
//           (12 workers, 20 s deadline per call, pinned `jev-1.13`), and writes the plan JSONL plus a
//           {recId, Niche} snapshot of every head read. Nothing is written to Airtable. Prints the stop
//           checks and the operator's sample report. THE OPERATOR STOP follows it: --apply runs only on
//           the operator's recorded "go".
// --apply   reads the plan and never re-classifies. Batches of <=10: re-read current Niche, skip rows
//           changed since the dry run, write ONLY Niche with typecast:false, append ids to a progress
//           file (resume-safe), stop on the first write error and re-read those ids.
// --rollback restores oldNiche (null for blanks) only where the current value still equals newNiche.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES } from '../config.mjs';
import {
  NICHE_QUESTIONS, NICHE_QUESTIONS_HASH, RETIRED_NICHES, RULE_KEYS, SWIPE_RULES, breakerReason, classifySwipeHead, isHealthSide, planChange, questionSetHash,
} from '../swipe-classify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SWIPE_FIELDS = ['Text', 'Full Thread Text', 'Niche', 'Impressions', 'Single Tweet', 'Thread Length'];
export const WORKERS = 12;
export const DEADLINE_MS = 20_000;
const REC_ID = /^rec[A-Za-z0-9]{14}$/;
const blankToNull = (v) => (v == null || String(v).trim() === '' ? null : String(v));
const isChange = (r) => RULE_KEYS.includes(r.rule) && r.newNiche !== r.oldNiche;

export { breakerReason }; // lives in swipe-classify.mjs so tag-niche.mjs shares it

// ---- Schema (Meta API, the airtable-schema.mjs pattern) ------------------------------------------------
/** Pure: the Niche select options of the swipe table from a Meta API table list; null when absent. */
export function nicheOptionsFrom(tables, tableId = TABLES.swipe, fieldName = 'Niche') {
  const t = (tables || []).find((x) => x.id === tableId || x.name === tableId);
  const f = t?.fields?.find((x) => x.name === fieldName);
  return f ? (f.options?.choices || []).map((c) => c.name) : null;
}

/** Live read; throws on failure. The caller treats a throw as "could not check", never as "no drift". */
export async function fetchNicheOptions(env, fetchImpl = fetch) {
  const r = await fetchImpl(`https://api.airtable.com/v0/meta/bases/${env.XDB_BASE_ID}/tables`, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
  if (r.status === 403) throw new Error('PAT lacks schema.bases:read — the option check cannot run');
  if (!r.ok) throw new Error(`meta tables -> ${r.status}`);
  const options = nicheOptionsFrom((await r.json()).tables);
  if (!options) throw new Error('swipe table or its Niche field not found in the Meta API response');
  return options;
}

// ---- Reads --------------------------------------------------------------------------------------------
const idsFormula = (ids) => {
  for (const id of ids) if (!REC_ID.test(id)) throw new Error(`not a record id: ${JSON.stringify(id)}`);
  return `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
};

export async function readHeads(at, { limit = null, ids = null } = {}) {
  const heads = '{Tweet Number}=1';
  const formula = ids?.length ? `AND(${heads},${idsFormula(ids)})` : heads;
  if (limit) return (await at.listUpTo(TABLES.swipe, { formula, fields: SWIPE_FIELDS, sort: [{ field: 'Impressions', direction: 'desc' }], pageSize: 100, max: limit })).records;
  return at.listAll(TABLES.swipe, { formula, fields: SWIPE_FIELDS });
}

/** Current Niche for up to 10 ids: Map recId -> value (null for blank). Missing ids are absent. */
export async function readCurrent(at, ids) {
  const recs = await at.listAll(TABLES.swipe, { formula: idsFormula(ids), fields: ['Niche'] });
  return new Map(recs.map((r) => [r.id, blankToNull(r.fields?.Niche)]));
}

// ---- Dry run ------------------------------------------------------------------------------------------
/** Worker pool with a breaker. Returns one result per head, in input order. */
export async function classifyAll(client, heads, { workers = WORKERS, deadlineMs = DEADLINE_MS, calibratedBuild = SWIPE_RULES.calibratedBuild, log = () => {} } = {}) {
  const out = new Array(heads.length);
  const breaker = { open: false, reason: null };
  let next = 0;
  let done = 0;
  const optionsFor = () => ({ signal: AbortSignal.timeout(deadlineMs) });
  const work = async () => {
    while (!breaker.open && next < heads.length) {
      const i = next++;
      const head = heads[i];
      try {
        const r = await classifySwipeHead(client, head.fields || {}, { optionsFor });
        const trip = breakerReason(r.intakeError);
        if (trip) { breaker.open = true; breaker.reason = `${trip} on call 2 (${head.id})`; }
        const wrongBuild = [r.build, r.build2].find((b) => b && b !== calibratedBuild);
        if (wrongBuild) { breaker.open = true; breaker.reason = `answering build ${wrongBuild} is not the calibrated ${calibratedBuild}`; }
        out[i] = { ok: true, ...r, intakeError: r.intakeError ? (r.intakeError.code || 'client_error') : null };
      } catch (error) {
        const trip = breakerReason(error);
        if (trip) { breaker.open = true; breaker.reason = `${trip} on call 1 (${head.id})`; }
        out[i] = { ok: false, error: error.code || 'client_error' };
      }
      if (++done % 250 === 0) log(`  ${done}/${heads.length} read`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, heads.length)) }, work));
  return { results: out, breaker };
}

/** Plan rows (one per head read) from heads + classification results. Pure. */
export function buildPlanRows(heads, results, { ts = new Date().toISOString(), hash = NICHE_QUESTIONS_HASH } = {}) {
  return heads.map((h, i) => {
    const f = h.fields || {};
    const base = { recId: h.id, hook: String(f.Text || '').split('\n')[0].slice(0, 100), views: f.Impressions || 0, oldNiche: blankToNull(f.Niche) };
    const r = results[i];
    if (!r) return { ...base, newNiche: base.oldNiche, rule: null, error: 'not_read', ts };
    if (!r.ok) return { ...base, newNiche: base.oldNiche, rule: null, error: r.error, ts };
    const change = planChange({ oldNiche: base.oldNiche }, r.niche, r.intake);
    return {
      ...base, newNiche: change.newNiche, rule: change.rule, ...(change.held ? { held: change.held } : {}),
      health: r.niche.health, primary: r.niche.primary, primaryConf: r.niche.primaryConf,
      topic: r.intake?.topic ?? null, topicConf: r.intake?.topicConf ?? null, flags: r.intake?.flags ?? null, intent: r.intake?.intent ?? null,
      ...(r.intakeError ? { intakeError: r.intakeError } : {}),
      model: r.build, questionSetHash: hash, ts,
    };
  });
}

export function ruleCounts(rows) {
  const counts = Object.fromEntries([...RULE_KEYS, 'safety', 'unchanged', 'error'].map((k) => [k, 0]));
  const heldBy = { B: 0, D: 0 };
  for (const r of rows) {
    if (r.error) counts.error++;
    else if (r.rule === 'safety') { counts.safety++; heldBy[r.held?.rule] = (heldBy[r.held?.rule] || 0) + 1; }
    else if (isChange(r)) counts[r.rule]++;
    else counts.unchanged++;
  }
  return { ...counts, heldBy };
}

/** The population each rule acts on, as read in this run (errored rows excluded). */
export function populations(rows) {
  const read = rows.filter((r) => !r.error);
  const retired = read.filter((r) => RETIRED_NICHES.includes(r.oldNiche)).length;
  return { A: retired, 'A′': retired, 'A″': retired, C: read.filter((r) => r.oldNiche === 'Health').length,
    D: read.filter((r) => r.oldNiche == null).length,
    B: read.filter((r) => r.oldNiche != null && r.oldNiche !== 'Health' && !RETIRED_NICHES.includes(r.oldNiche)).length };
}

/** Each calibrated expectation scaled to the population read now (rate × population, rounded). */
export function scaledExpectations(rows, rules = SWIPE_RULES) {
  const pop = populations(rows);
  return Object.fromEntries(RULE_KEYS.map((k) => {
    const base = rules.calibratedOn?.[k];
    return [k, base ? Math.round((rules.expected[k] / base) * pop[k]) : rules.expected[k]];
  }));
}

/** The Appendix A step-6 stop checks. Returns a list of reasons; empty = the run may go to the operator. */
export function stopChecks(rows, { options = null, breaker = null, partial = false, rules = SWIPE_RULES } = {}) {
  const stops = [];
  const c = ruleCounts(rows);
  if (breaker?.open) stops.push(`breaker open: ${breaker.reason}`);
  const errorRate = rows.length ? c.error / rows.length : 0;
  if (errorRate > rules.maxErrorRate) stops.push(`Jev errors ${c.error}/${rows.length} (${(errorRate * 100).toFixed(1)}%) exceed ${(rules.maxErrorRate * 100).toFixed(0)}%`);
  // "Read" = answered: an errored retired row is already counted by the error-rate check above, so
  // counting it here too would stop every full run on its first timeout.
  const retiredRead = rows.filter((r) => !r.error && RETIRED_NICHES.includes(r.oldNiche)).length;
  const aSum = c.A + c['A′'] + c['A″'];
  if (aSum !== retiredRead) stops.push(`A + A′ + A″ = ${aSum} but ${retiredRead} Fitness/Mental Health rows were read`);
  if (!partial) {
    const expect = scaledExpectations(rows, rules);
    for (const k of RULE_KEYS) {
      const expected = expect[k];
      // B's and D's expectations come from a calibration with no safety pass, so held rows count too.
      const actual = k === 'B' || k === 'D' ? c[k] + (c.heldBy[k] || 0) : c[k];
      // Tiny expectations (A″ ≈ 1) get a row floor, or any count but the exact one would stop.
      if (Math.abs(actual - expected) > Math.max(rules.minTolerance ?? 1, expected * rules.tolerance)) stops.push(`rule ${k}: ${actual} vs expected ≈${expected} (more than ${rules.tolerance * 100}% off)`);
    }
  }
  const crossed = rows.filter((r) => isChange(r) && r.oldNiche && !isHealthSide(r.oldNiche) && r.newNiche !== 'Health');
  if (crossed.length) stops.push(`${crossed.length} row(s) would move between two non-Health niches: ${crossed.slice(0, 5).map((r) => r.recId).join(', ')}`);
  if (!options) stops.push('Niche options could not be read from the Meta API (unverified) — every target must be an existing option');
  else {
    const missing = [...new Set(rows.filter(isChange).map((r) => r.newNiche).filter((n) => !options.includes(n)))];
    if (missing.length) stops.push(`target value(s) not an existing Niche option: ${missing.join(', ')}`);
  }
  return stops;
}

const fmt = (x, d = 2) => (x == null ? 'n/a' : Number(x).toFixed(d));
const line = (r) => `${JSON.stringify(String(r.hook || '').slice(0, 70))} · ${r.oldNiche ?? '(blank)'} → ${r.newNiche ?? '(blank)'} · health ${fmt(r.health)} · ${r.primary}/${fmt(r.primaryConf)} · ${Number(r.views || 0).toLocaleString('en-US')} views`;
const byViews = (a, b) => (b.views || 0) - (a.views || 0);

/** The operator's step-7 packet: counts vs expectation, the stratified sample, the kept-Health doubts, the safety holds. */
export function sampleReport(rows, { perRule = 10, oversample = 20, rules = SWIPE_RULES, partial = false } = {}) {
  const c = ruleCounts(rows);
  const out = ['## Counts per rule', '', '| Rule | Rows | Expected |', '|:--|--:|--:|'];
  const expect = scaledExpectations(rows, rules);
  for (const k of RULE_KEYS) out.push(`| ${k} | ${c[k]}${(k === 'B' || k === 'D') && c.heldBy[k] ? ` (+${c.heldBy[k]} held)` : ''} | ${partial ? 'n/a (partial run)' : `≈${expect[k]} (calibrated ${rules.expected[k]})`} |`);
  const writes = RULE_KEYS.reduce((s, k) => s + c[k], 0);
  out.push(`| **Writes** | **${writes}** | ${partial ? 'n/a' : `≈${Object.values(expect).reduce((a, b) => a + b, 0)}`} |`, '');
  // Call-2 failures are not errors (the niche answer stands) but they hold every B/D move into Health.
  const intakeErrors = rows.filter((r) => r.intakeError).length;
  out.push(`Held for safety: ${c.safety} · unchanged: ${c.unchanged} · errors: ${c.error} · call-2 unread: ${intakeErrors} · read: ${rows.length}`, '');
  out.push('## Stratified sample (highest views first)', '');
  for (const k of RULE_KEYS) {
    let pool = rows.filter((r) => isChange(r) && r.rule === k).sort(byViews);
    // A′ is listed in full (each with its confidence, per the plan); C is oversampled.
    const n = k === 'A′' ? pool.length : k === 'C' ? oversample : perRule;
    if (k === 'D') {
      const nonHealth = pool.filter((r) => r.newNiche !== 'Health');
      pool = [...nonHealth.slice(0, oversample), ...pool.filter((r) => r.newNiche === 'Health').slice(0, perRule)].sort(byViews);
      out.push(`### D (${c.D}; blank → non-Health oversampled)`);
      out.push(...pool.map((r) => `- ${line(r)}`), '');
      continue;
    }
    out.push(`### ${k} (${c[k]})`);
    out.push(...pool.slice(0, n).map((r) => `- ${line(r)}`), '');
  }
  const doubts = rows.filter((r) => !r.error && r.oldNiche === 'Health' && r.newNiche === 'Health' && r.health != null && r.health < 0.5).sort(byViews);
  out.push(`## Current-Health rows with health < 0.50 that stay Health (${doubts.length})`, '', ...doubts.map((r) => `- ${line(r)}`), '');
  const held = rows.filter((r) => r.rule === 'safety').sort(byViews);
  out.push(`## Held for safety — B/D would have moved these into Health (${held.length})`, '', ...held.map((r) => `- ${line({ ...r, newNiche: `Health (held: ${r.held.flags.join(', ')})` })}`), '');
  const flagNames = ['about_cancer', 'explicit', 'named_quote', 'quote_compilation', 'retweet', 'dangling'];
  const flagged = flagNames.map((f) => `${f} ${rows.filter((r) => (r.flags?.[f] ?? 0) >= rules.safety).length}`);
  flagged.push(`non-English ${rows.filter((r) => r.flags && r.flags.english != null && r.flags.english < 1 - rules.safety).length}`);
  out.push(`## Call-2 flags at ≥ ${rules.safety} (report-only, not written)`, '', flagged.join(' · '), '');
  return out.join('\n');
}

// Timestamped and written with 'wx': a second dry run (even a --ids spot check) must never replace
// the plan or snapshot a later --apply or --rollback depends on.
export function planPaths(outDir, ts) {
  const stamp = String(ts).replace(/[:.]/g, '-');
  return { plan: join(outDir, `swipe-reclass-${stamp}.jsonl`), snapshot: join(outDir, `swipe-reclass-${stamp}-snapshot.json`),
    verdict: join(outDir, `swipe-reclass-${stamp}.verdict.json`) };
}

export async function runDry({ at, client, getOptions, limit = null, ids = null, outDir = join(ROOT, 'learnings', 'jev'), now = () => new Date(), log = console.log, workers = WORKERS, deadlineMs = DEADLINE_MS }) {
  const hash = questionSetHash(NICHE_QUESTIONS);
  if (hash !== NICHE_QUESTIONS_HASH) throw new Error(`NICHE_QUESTIONS changed (hash ${hash.slice(0, 12)} ≠ calibrated ${NICHE_QUESTIONS_HASH.slice(0, 12)}): recalibrate before any dry run`);
  const partial = Boolean(limit || ids?.length);
  const heads = await readHeads(at, { limit, ids });
  log(`Read ${heads.length} head(s)${partial ? ' (partial run: rule expectations not checked)' : ''}. Classifying with ${SWIPE_RULES.model}, ${workers} workers…`);
  const started = Date.now();
  const { results, breaker } = await classifyAll(client, heads, { workers, deadlineMs, log });
  const ts = now().toISOString();
  const rows = buildPlanRows(heads, results, { ts, hash });
  let options = null;
  try { options = await getOptions(); } catch (error) { log(`⚠️ Niche options unread: ${error.message}`); }
  const stops = stopChecks(rows, { options, breaker, partial });
  mkdirSync(outDir, { recursive: true });
  const paths = planPaths(outDir, ts);
  writeFileSync(paths.plan, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
  writeFileSync(paths.snapshot, JSON.stringify(heads.map((h) => ({ recId: h.id, Niche: blankToNull(h.fields?.Niche) })), null, 0) + '\n', { flag: 'wx' });
  // --apply reads this: only a FULL dry run whose stop checks all passed may be applied.
  writeFileSync(paths.verdict, JSON.stringify({ ts, partial, stops, breaker: breaker?.open ? breaker.reason : null, rows: rows.length }) + '\n', { flag: 'wx' });
  log(sampleReport(rows, { partial }));
  log(`Plan: ${paths.plan}\nSnapshot: ${paths.snapshot}\nWall time: ${Math.round((Date.now() - started) / 1000)} s`);
  log(stops.length ? `\n⛔ STOP — do not apply:\n${stops.map((s) => `  - ${s}`).join('\n')}` : '\n✅ Stop checks pass. OPERATOR STOP: --apply runs only on the operator\'s recorded go.');
  return { rows, stops, paths, breaker, partial };
}

// ---- Apply / rollback ---------------------------------------------------------------------------------
export function loadPlan(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export const progressPathFor = (planPath) => planPath.replace(/\.jsonl$/, '') + '.progress';
// Rows this plan actually wrote (not rows found already at newNiche): the only rows --rollback reverts.
export const appliedPathFor = (planPath) => planPath.replace(/\.jsonl$/, '') + '.applied';

/** Refusal reasons for applying a plan (empty = may apply). Pure. */
export function applyRefusals(changes, { options, rules = SWIPE_RULES, hash = NICHE_QUESTIONS_HASH } = {}) {
  const out = [];
  const badBuild = changes.filter((r) => r.model !== rules.calibratedBuild);
  if (badBuild.length) out.push(`${badBuild.length} row(s) answered by a build other than ${rules.calibratedBuild}`);
  const badHash = changes.filter((r) => r.questionSetHash !== hash);
  if (badHash.length) out.push(`${badHash.length} row(s) carry a different questionSetHash`);
  if (!options) out.push('Niche options could not be read from the Meta API');
  else {
    const missing = [...new Set(changes.map((r) => r.newNiche).filter((n) => n != null && !options.includes(n)))];
    if (missing.length) out.push(`target value(s) not an existing Niche option: ${missing.join(', ')}`);
  }
  const retired = changes.filter((r) => RETIRED_NICHES.includes(r.newNiche));
  if (retired.length) out.push(`${retired.length} row(s) target a retired label`);
  const crossed = changes.filter((r) => r.oldNiche && !isHealthSide(r.oldNiche) && r.newNiche !== 'Health');
  if (crossed.length) out.push(`${crossed.length} row(s) move between two non-Health niches`);
  return out;
}

export const verdictPathFor = (planPath) => planPath.replace(/\.jsonl$/, '') + '.verdict.json';

/** The dry run's own verdict: a partial run, an open breaker or any stop check refuses the plan. */
export function dryRunRefusals(planPath) {
  const path = verdictPathFor(planPath);
  if (!existsSync(path)) return [`no dry-run verdict beside the plan (${path}); re-run the full --dry`];
  const v = JSON.parse(readFileSync(path, 'utf8'));
  const out = [];
  if (v.partial) out.push('the plan comes from a partial dry run (--limit/--ids)');
  if (v.breaker) out.push(`the dry run's breaker opened: ${v.breaker}`);
  if (v.stops?.length) out.push(...v.stops.map((s) => `dry-run stop check: ${s}`));
  return out;
}

export async function runApply({ at, planPath, getOptions, log = console.log, batchSize = 10, except = [] }) {
  // --except: rows the operator's go excluded by id. They are never written, and are reported as such.
  const excluded = new Set(except);
  const all = loadPlan(planPath).filter(isChange);
  const unknown = [...excluded].filter((id) => !all.some((r) => r.recId === id));
  if (unknown.length) { log(`⛔ --except names row(s) that are not planned changes: ${unknown.join(', ')}`); return { ok: false, refusals: [`unknown --except ids: ${unknown.join(', ')}`] }; }
  const changes = all.filter((r) => !excluded.has(r.recId));
  if (excluded.size) log(`Excluded by the operator's go: ${excluded.size} row(s) (${[...excluded].join(', ')}).`);
  let options = null;
  try { options = await getOptions(); } catch (error) { log(`⚠️ Niche options unread: ${error.message}`); }
  const refusals = [...dryRunRefusals(planPath), ...applyRefusals(changes, { options })];
  if (refusals.length) { log(`⛔ Refusing to apply:\n${refusals.map((r) => `  - ${r}`).join('\n')}`); return { ok: false, refusals }; }
  const progressPath = progressPathFor(planPath);
  const done = new Set(existsSync(progressPath) ? readFileSync(progressPath, 'utf8').split('\n').filter(Boolean) : []);
  const todo = changes.filter((r) => !done.has(r.recId));
  const summary = { ok: true, planned: changes.length, resumedPast: changes.length - todo.length, applied: 0, already: 0, skipped: [], failed: null };
  log(`Applying ${todo.length} change(s) (${summary.resumedPast} already in ${progressPath}).`);
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const current = await readCurrent(at, batch.map((r) => r.recId));
    const write = [];
    const settled = [];
    for (const r of batch) {
      const now = current.has(r.recId) ? current.get(r.recId) : undefined;
      if (now === r.newNiche) { summary.already++; settled.push(r.recId); } else if (now !== r.oldNiche) summary.skipped.push({ recId: r.recId, planned: r.oldNiche, current: now === undefined ? '(missing)' : now });
      else write.push(r);
    }
    if (write.length) {
      try {
        await at.update(TABLES.swipe, write.map((r) => ({ id: r.recId, fields: { Niche: r.newNiche } })), { typecast: false });
      } catch (error) {
        const after = await readCurrent(at, write.map((r) => r.recId)).catch(() => null);
        summary.ok = false;
        summary.failed = { error: error.code || error.message, ids: write.map((r) => ({ recId: r.recId, current: after ? (after.get(r.recId) ?? null) : 'unverified' })) };
        if (settled.length) appendFileSync(progressPath, settled.join('\n') + '\n');
        log(`⛔ Write failed (${summary.failed.error}); stopped. Re-read: ${JSON.stringify(summary.failed.ids)}`);
        return summary;
      }
      summary.applied += write.length;
      appendFileSync(appliedPathFor(planPath), write.map((r) => r.recId).join('\n') + '\n');
      settled.push(...write.map((r) => r.recId));
    }
    if (settled.length) appendFileSync(progressPath, settled.join('\n') + '\n');
  }
  log(`Applied ${summary.applied} · already set ${summary.already} · skipped (changed since the dry run) ${summary.skipped.length}`);
  for (const s of summary.skipped) log(`  skipped ${s.recId}: planned from ${s.planned ?? '(blank)'}, now ${s.current ?? '(blank)'}`);
  return summary;
}

export async function runRollback({ at, planPath, log = console.log, batchSize = 10 }) {
  // Only rows this plan's --apply wrote (its .applied file): a row that reached newNiche some other way
  // (tag-niche, the normalizer, n8n) is not ours to revert. No .applied file = nothing was written.
  const appliedPath = appliedPathFor(planPath);
  const wrote = new Set(existsSync(appliedPath) ? readFileSync(appliedPath, 'utf8').split('\n').filter(Boolean) : []);
  const changes = loadPlan(planPath).filter(isChange).filter((r) => wrote.has(r.recId));
  const summary = { restored: [], skipped: [] };
  for (let i = 0; i < changes.length; i += batchSize) {
    const batch = changes.slice(i, i + batchSize);
    const current = await readCurrent(at, batch.map((r) => r.recId));
    const restore = [];
    for (const r of batch) {
      const now = current.has(r.recId) ? current.get(r.recId) : undefined;
      if (now === r.newNiche) restore.push(r); else summary.skipped.push({ recId: r.recId, current: now === undefined ? '(missing)' : now, planned: r.newNiche });
    }
    if (restore.length) {
      await at.update(TABLES.swipe, restore.map((r) => ({ id: r.recId, fields: { Niche: r.oldNiche ?? null } })), { typecast: false });
      summary.restored.push(...restore.map((r) => ({ recId: r.recId, from: r.newNiche, to: r.oldNiche ?? null })));
    }
  }
  log(`Restored ${summary.restored.length} · skipped ${summary.skipped.length} (current value is no longer the planned newNiche)`);
  for (const s of summary.skipped) log(`  skipped ${s.recId}: now ${s.current ?? '(blank)'}, plan wrote ${s.planned}`);
  return summary;
}

// ---- CLI ----------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const val = (n) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : null; };
  const apply = val('apply');
  const rollback = val('rollback');
  if (apply && rollback) throw new Error('--apply and --rollback are exclusive');
  if ((argv.includes('--apply') && !apply) || (argv.includes('--rollback') && !rollback)) throw new Error('--apply/--rollback need a plan file');
  const limit = val('limit') ? parseInt(val('limit'), 10) : null;
  if (limit != null && !(limit > 0)) throw new Error('--limit must be a positive integer');
  const ids = val('ids') ? val('ids').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const except = val('except') ? val('except').split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (except.length && !apply) throw new Error('--except only applies to --apply');
  if (except.some((id) => !/^rec[A-Za-z0-9]{14}$/.test(id))) throw new Error('--except takes record ids (recXXXXXXXXXXXXXX)');
  return { mode: apply ? 'apply' : rollback ? 'rollback' : 'dry', planPath: apply || rollback, limit, ids, ...(except.length ? { except } : {}) };
}

async function main() {
  const { loadEnv, requireEnv, airtable, flushLlmSpend } = await import('../lib.mjs');
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
  const at = airtable(env); // XDB base only; the healthTweets base is never touched
  const getOptions = () => fetchNicheOptions(env);
  if (args.mode === 'apply') { const s = await runApply({ at, planPath: resolve(args.planPath), getOptions, except: args.except || [] }); if (!s.ok) process.exit(1); return; }
  if (args.mode === 'rollback') { await runRollback({ at, planPath: resolve(args.planPath) }); return; }
  const { jev } = await import('../jev.mjs');
  const client = jev({ ...env, TYPESAFE_DEFAULT_MODEL: SWIPE_RULES.model });
  try {
    const { stops } = await runDry({ at, client, getOptions, limit: args.limit, ids: args.ids });
    if (stops.length) process.exitCode = 2;
  } finally {
    await flushLlmSpend(env, 'swipe-reclassify', 'dry');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
