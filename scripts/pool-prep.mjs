#!/usr/bin/env node
// scripts/pool-prep.mjs — prepare the harvest and pot pools between runs, so selection offers bodies
// that are already read.
//
// Owner, 2026-09-23: "a new routine where, before something is added to the database, it would go
// through a brief rewrite, or we add some flags to it … when we're not creating the run … we can use
// that to prepare the harvest, prepare the seed, and do just the preparations that can help us make
// the run smoother and more efficient."
//
// Every In Pool harvest body (its published origin copy) and every greenhouse pot gets the SAME Jev read
// the drafts stop gives (run-jev readRows 'drafts': safety, plug fit, the editorial decision). Code turns
// the reading into one readiness per body:
//   ready       Jev passes it, or only its uncertain band speaks
//   light-edit  Jev points at tweets a light edit can fix (never a harvest hook). These are edited
//               without the owner (owner, 2026-09-23: "pool prep should auto edit too - it shouldn't
//               need me. the default is that all of them should be ready for our run") by the writer IN
//               THE CHAT, never through a model API (owner, 2026-09-26: "Remember to use claude chat
//               token NOT Api"). A pass writes one brief per body to --brief-dir (scripts/run-repair.mjs
//               repairBrief; the writer's instructions in _writer.md; _briefs.json records the pass and,
//               per body, the copy and flagged tweets its brief was written against). The session's
//               writer saves each answer beside its brief as <id>.json. `--answers DIR` (that brief
//               directory) applies an answer only while its body's copy and flagged tweets are still the
//               ones its brief showed (applyRepair: links kept, a harvest keeps its hook and changes <
//               farm.harvestEditMax), and Jev reads the edit again. Briefs for the next pass are written
//               after that, only for bodies still flagged, and none after jev.poolRepairPasses passes. Only a
//               body that comes back ready is kept:
//                 harvest -> queues/harvest-repairs/<rec>.json (class LIGHT_EDIT; republish ships it
//                            and pool-probe re-gates it; a body the gate refuses is restored)
//                 pot     -> its greenhouse file's tweets, with a prepEdits record
//               Without --answers (or with --no-edit) it only reports.
//   owner       safety, a harvest hook, or a hold no tweet rewrite settles
//   blocked     pool-probe's gate or re-mint refuses the harvest (from its cache)
//   unread      the copy or Jev could not be read (never counted as ready)
//
//   node scripts/pool-prep.mjs [--lane harvest|pot|all] [--limit N] [--brief-dir DIR] [--answers DIR] [--no-edit] [--json]
//
// queues/pool-prep.json keeps ids, copy hashes, tweet numbers and finding labels; never copy. Briefs and
// answers quote copy, so --brief-dir and --answers must be outside the repository.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairTargets, repairBrief, applyRepair } from './run-repair.mjs';
import { LAWS as POOL_LAWS } from '../laws.mjs';
// The prep's own bound (laws.json jev.poolRepairPasses). The run's drafts loop went to one on 2026-09-28
// ("Repair once, then ship"); the evening prep repairs pool bodies before anyone waits on them, so it keeps
// its two passes.
const POOL_PASSES = POOL_LAWS.jev?.poolRepairPasses ?? 2;
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PREP_FILE = join(ROOT, 'queues', 'pool-prep.json');
const POTS = join(ROOT, 'queues', 'pots');
const PROBE = join(ROOT, 'queues', 'pool-probe.json');

/** PURE. A finding as a label with no copy in it: the note up to its quoted excerpt. */
export const label = (note) => String(note || '').replace(/\s+"[^"]*"?\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 140);

/**
 * PURE. One body's readiness from its Jev drafts reading. `probe` is the pool-probe verdict for a
 * harvest ({ clean, remintOk, reason }), when one is cached.
 */
export function readiness(reading, { lane, probe = null } = {}) {
  if (probe && (probe.clean === false || probe.remintOk === false)) {
    return { readiness: 'blocked', tweets: [], why: [String(probe.remintOk === false ? `attribution ${probe.remint || ''}` : probe.reason || 'gate refused').slice(0, 140)] };
  }
  if (!reading || reading.status !== 'read' || reading.prescore?.status !== 'read') {
    return { readiness: 'unread', tweets: [], why: [label(reading?.reason || reading?.prescore?.reason || 'not read')] };
  }
  const action = reading.prescore.action;
  // Readiness follows the DECISION: the editorial read, safety included. The drafts reading's own flags
  // (safety battery, plug fit, promise, owner rules) are report-only at the drafts stop too, so here they
  // are notes, not verdicts: an owner-approved pot is not sent back because it quotes a named doctor.
  const targets = repairTargets({ reading: { ...reading, flags: [] }, planRow: {}, specRow: { lane } });
  const notes = (reading.flags || []).filter((f) => f.kind !== 'seam').map((f) => label(f.note));
  const decisionOwner = targets.owner;
  if (decisionOwner.length) return { readiness: 'owner', tweets: targets.rewrite.map((r) => r.tweet), why: [...decisionOwner.map(label), ...notes], action };
  if (targets.rewrite.length) return { readiness: 'light-edit', tweets: targets.rewrite.map((r) => r.tweet), why: [...targets.rewrite.flatMap((r) => r.why).map(label), ...notes], action, targets };
  if (action === 'hold') return { readiness: 'owner', tweets: [], why: ['Jev holds it with no tweet to point at', ...notes], action };
  return { readiness: 'ready', tweets: [], why: [...notes, ...targets.uncertain.slice(0, 3).map(label)], action };
}

/** PURE. The summary line per readiness. */
export function counts(bodies) {
  const out = { ready: 0, 'light-edit': 0, owner: 0, blocked: 0, unread: 0 };
  for (const b of bodies) out[b.readiness] = (out[b.readiness] || 0) + 1;
  return out;
}

/** PURE. The prepared entry for a pool row, or null when the copy changed since it was prepared. */
export function preparedFor(prep, id, copySha256 = null) {
  const b = (prep?.bodies || []).find((x) => x.id === id);
  if (!b) return null;
  return copySha256 && b.copySha256 !== copySha256 ? null : b;
}

/** PURE. The indent a JSON file was written with (spaces before its first key), default 1. */
export const indentOf = (raw) => (String(raw).match(/^\{\r?\n( +)"/) || [, ' '])[1].length;

/** PURE. The writer's JSON answer out of its reply (a fenced block or the first {...}); null if none. */
export function parseAnswer(textOut) {
  const t = String(textOut || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  try { const j = JSON.parse(raw); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

/** PURE. The harvest-repair record a light edit leaves: the prior repair (if any) with the new tweets
 *  and a LIGHT_EDIT class appended, so republish ships it and a verdict is never read as the origin's. */
export function lightEditRepair(prev, { recId, draftId, account, body, products = [], tweets, changed, why, at }) {
  const base = prev || { harvestRecId: recId, originDraftId: draftId, originAccount: account, body, products, classes: [], moves: [], geometryChanged: false };
  return { ...base, repairedAt: at, tweets,
    classes: [...(base.classes || []), { class: 'LIGHT_EDIT', finding: `pool-prep rewrote T${changed.join(', T')}: ${why.join('; ').slice(0, 300)}` }] };
}

/** PURE. What a brief was written against: the body's copy and the tweets Jev flagged in it. */
export const briefKey = (copySha256, targets) => ({ copySha256: copySha256 || null,
  rewrite: (targets?.rewrite || []).map((r) => r.tweet).sort((a, b) => a - b) });

/** PURE. Why an answer written against `entry` (a _briefs.json body) may not be applied to the body as it
 *  reads now, or null when it may. A writer never edits copy or tweets its brief did not show. */
export function staleBrief(entry, now) {
  if (!entry) return 'that pass wrote no brief for it';
  if (entry.copySha256 !== now.copySha256) return 'its copy changed since the brief';
  if (JSON.stringify(entry.rewrite) !== JSON.stringify(now.rewrite)) return 'Jev flags different tweets now';
  return null;
}

/** The briefs a pass wrote (_briefs.json in its directory). */
function readBriefs(dir) {
  const file = join(dir, '_briefs.json');
  if (!existsSync(file)) throw new Error(`--answers ${dir} has no _briefs.json: pass the brief directory the answers were saved in`);
  const briefs = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isInteger(briefs?.pass) || briefs.pass < 1 || !briefs.bodies || typeof briefs.bodies !== 'object') throw new Error(`${file} is not a pool-prep brief record`);
  return briefs;
}

/** The writer's instructions, written beside the briefs as _writer.md for the writer in the chat. */
export const WRITER_SYSTEM = [
  'You are the writer in a repair loop for X threads. You only write; a classifier decides afterwards.',
  'Follow the brief exactly: rewrite only the listed tweets, keep every other tweet as it is, keep each link token in its tweet,',
  'match the voice of the surrounding tweets (plain, short lines, no hype), never invent a source or a statistic.',
  'Every tweet stays at or under 280 characters, one sentence per line with a blank line between, and a numbered item keeps its number.',
  'Reply with the JSON answer only, in the shape the brief gives.',
].join(' ');

// ---- CLI ------------------------------------------------------------------------------------------

function potRows(limit) {
  if (!existsSync(POTS)) return [];
  return readdirSync(POTS).filter((f) => f.endsWith('.greenhouse.json')).sort().slice(0, limit).map((f) => {
    const g = JSON.parse(readFileSync(join(POTS, f), 'utf8'));
    return { kind: 'pot', id: f.replace(/\.greenhouse\.json$/, ''), lane: 'seed', account: g.account, ref: g.potRecId || null,
      draft: { tweets: (g.tweets || []).map(String), products: g.products || [] } };
  });
}

async function harvestRows(limit) {
  const { loadEnv, requireEnv, airtable, typefully } = await import('../lib.mjs');
  const { ACCOUNTS, resolveAccountKey } = await import('../accounts.mjs');
  const { productsForDraft, loadRepair } = await import('../harvest-repair.mjs');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY', 'REGISTRY_BASE_ID']);
  const pool = (await airtable(env, env.REGISTRY_BASE_ID).listAll('Harvests', {})).filter((r) => (r.fields.Status || '') === 'In Pool').slice(0, limit);
  const tf = typefully(env);
  const rows = [];
  for (const r of pool) {
    const draftId = String(r.fields['Origin Draft ID'] || '');
    const key = resolveAccountKey(String(r.fields['Origin Account'] || '').trim().split(/\s+/)[0].toLowerCase());
    const base = { kind: 'harvest', id: r.id, lane: 'harvest', account: key, accountName: String(r.fields['Origin Account'] || ''), ref: draftId };
    if (!draftId || !ACCOUNTS[key]?.socialSetId) { rows.push({ ...base, draft: { tweets: [], products: [] }, unreadWhy: 'no origin draft or account' }); continue; }
    try {
      const d = await tf.getDraft(ACCOUNTS[key].socialSetId, draftId);
      // What ships is the repaired body when harvest-repair (or an earlier prep) wrote one.
      const repair = loadRepair(r.id);
      const tweets = repair?.tweets?.length ? repair.tweets.map(String) : (d?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
      rows.push({ ...base, body: r.fields.Body, repaired: !!repair, draft: { tweets, products: productsForDraft(draftId).map(({ asin, title }) => ({ asin, title })) } });
    } catch (e) {
      rows.push({ ...base, draft: { tweets: [], products: [] }, unreadWhy: `origin copy not read: ${String(e.message).slice(0, 80)}` });
    }
  }
  return rows;
}

/**
 * One light-edit body, edited by the writer in the chat: its answer to this pass's brief is applied, Jev
 * reads the edit again, and the body is persisted only when it comes back ready (a harvest also has to
 * pass republish's gate). Returns the fields to merge into its prep entry. A body still flagged is left
 * as it was: the next pass reads it again and writes a fresh brief, up to jev.poolRepairPasses passes.
 */
async function applyChatEdit(row, entry, answer, { read, loop = 1 }) {
  if (!answer) return { editNote: 'the chat writer’s answer is not JSON: not applied' };
  const spec = { id: row.id, lane: row.lane, draft: { ...row.draft }, ...(row.lane === 'harvest' ? { source: { tweets: row.draft.tweets } } : {}) };
  const applied = applyRepair(spec, { ...answer, id: row.id }, entry.targets, { loop });
  if (applied.issues.length) return { editNote: `edit refused: ${applied.issues.join('; ').slice(0, 140)}` };
  const tweets = applied.row.draft.tweets;
  const changed = [...applied.changed].sort((a, b) => a - b);
  const why = entry.targets.rewrite.flatMap((r) => r.why).map(label);
  const [reading] = await read([{ ...row, draft: { ...row.draft, tweets } }]);
  const again = readiness(reading, { lane: row.lane });
  if (again.readiness === 'ready') {
    const kept = await persistEdit(row, tweets, changed, why);
    if (!kept.ok) return { editNote: kept.note };
    return { readiness: 'ready', tweets: [], why: again.why, edited: changed, copySha256: reading.copySha256, editNote: kept.note };
  }
  return { editNote: `after the chat writer’s edit Jev reads it as ${again.readiness}: not kept${again.readiness === 'light-edit' ? ' (the next pass writes a fresh brief)' : ''}` };
}

/** Keep a ready edit where the run will ship it from. A harvest is re-gated by republish itself and
 *  the previous repair file is put back byte for byte when the gate refuses. */
async function persistEdit(row, tweets, changed, why) {
  const at = new Date().toISOString();
  if (row.kind === 'pot') {
    const f = join(POTS, `${row.id}.greenhouse.json`);
    const raw = readFileSync(f, 'utf8');
    const g = JSON.parse(raw);
    // The greenhouse gate (pot-gate.mjs, the publish gate as a garden sees it): the edit may add no
    // error or hard finding the pot did not already have. Mock pass 2026-09-23: 4 of 37 edits broke
    // the 280 limit, numbering or one-sentence-per-line, all of which Jev does not read.
    const { gatePot } = await import('../pot-gate.mjs');
    const was = gatePot(g), now = gatePot({ ...g, tweets });
    const known = new Set([...was.errors, ...was.hard]);
    const added = [...now.errors, ...now.hard].filter((e) => !known.has(e));
    if (added.length) return { ok: false, note: `pot gate refused the edit: ${added[0].slice(0, 100)}` };
    g.tweets = tweets;
    g.prepEdits = [...(g.prepEdits || []), { at, tweets: changed, why: why.slice(0, 4) }];
    writeFileSync(f, `${JSON.stringify(g, null, indentOf(raw))}\n`); // keep the file's own indent: a clean diff
    return { ok: true, note: `greenhouse updated (T${changed.join(' T')})` };
  }
  const { loadRepair, repairPath } = await import('../harvest-repair.mjs');
  const path = repairPath(row.id);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const record = lightEditRepair(loadRepair(row.id), { recId: row.id, draftId: row.ref, account: row.accountName || row.account, body: row.body, products: row.draft.products.map((p) => p.asin), tweets, changed, why, at });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 1)}\n`);
  let out = '';
  try {
    out = (await promisify(execFile)('node', [join(ROOT, 'republish.mjs'), String(row.ref), '--account', row.account, '--from', row.account, '--harvest', row.id, '--gate-only'], { encoding: 'utf8', timeout: 200000 })).stdout;
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  if (/gates clean/.test(out)) return { ok: true, note: `repair file written, gate clean (T${changed.join(' T')})` };
  if (before == null) rmSync(path, { force: true }); else writeFileSync(path, before);
  return { ok: false, note: 'the gate refused the edited body: previous repair state restored' };
}

async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const lane = flag('lane') || 'all', limit = Number(flag('limit')) || Infinity;
  const briefDir = flag('brief-dir') && resolve(flag('brief-dir'));
  const answersDir = flag('answers') && resolve(flag('answers'));
  if (!['harvest', 'pot', 'all'].includes(lane)) throw new Error('Usage: pool-prep.mjs [--lane harvest|pot|all] [--limit N] [--brief-dir DIR] [--answers DIR] [--no-edit] [--json]');
  const inRepo = (dir) => dir && (dir === ROOT || dir.startsWith(`${ROOT}/`));
  if (inRepo(briefDir)) throw new Error('--brief-dir must be outside the repository: briefs quote copy');
  if (inRepo(answersDir)) throw new Error('--answers must be outside the repository: answers quote copy');
  if (answersDir && !existsSync(answersDir)) throw new Error(`--answers ${answersDir} does not exist`);
  const briefsIn = answersDir ? readBriefs(answersDir) : null;
  const pass = briefsIn ? briefsIn.pass + 1 : 1;   // the pass any new briefs are for
  const started = Date.now();
  const rows = [...(lane !== 'pot' ? await harvestRows(limit) : []), ...(lane !== 'harvest' ? potRows(limit) : [])];

  const { jev } = await import('../jev.mjs');
  const { loadEnv } = await import('../lib.mjs');
  const { createDecisionLog } = await import('../jev-decide.mjs');
  const { readRows } = await import('./run-jev.mjs');
  const env = loadEnv();
  const client = jev(env);
  const decisionLog = createDecisionLog();
  const read = (list) => readRows('drafts', list, { client, prescore: { log: decisionLog } });
  let readings;
  try { readings = await read(rows); } finally { decisionLog.flush(); }

  const probes = existsSync(PROBE) ? JSON.parse(readFileSync(PROBE, 'utf8')).results || [] : [];
  // The writer is the chat (owner, 2026-09-26: "Remember to use claude chat token NOT Api"): edits are
  // applied only from the answers it saved beside a pass's briefs, never generated here.
  const edit = !!briefsIn && !argv.includes('--no-edit');
  const bodies = rows.map((row, i) => {
    const reading = row.unreadWhy ? { status: 'not read', reason: row.unreadWhy } : readings[i];
    const r = readiness(reading, { lane: row.lane, probe: row.kind === 'harvest' ? probes.find((p) => p.rec === row.id) : null });
    return { kind: row.kind, id: row.id, ref: row.ref, account: row.account, copySha256: readings[i]?.copySha256 || null,
      readiness: r.readiness, tweets: r.tweets, why: r.why, action: r.action || null, model: readings[i]?.model || null, targets: r.targets };
  });
  if (edit) {
    try {
      for (const b of bodies.filter((x) => x.readiness === 'light-edit')) {
        const stale = staleBrief(briefsIn.bodies[b.id], briefKey(b.copySha256, b.targets));
        if (stale) { b.editNote = `${stale}: its pass ${briefsIn.pass} answer is not applied`; continue; }
        const file = join(answersDir, `${b.id}.json`);
        if (!existsSync(file)) { b.editNote = 'no answer from the chat writer yet'; continue; }
        const row = rows.find((x) => x.id === b.id);
        Object.assign(b, await applyChatEdit(row, b, parseAnswer(readFileSync(file, 'utf8')), { read, loop: briefsIn.pass }));
      }
    } finally { decisionLog.flush(); }
  }
  // Briefs for the next pass, after this pass's edits: only bodies still flagged, and none past the cap.
  if (briefDir) {
    mkdirSync(briefDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(briefDir, '_writer.md'), `${WRITER_SYSTEM}\n\nAnswer each <id>.md brief with its JSON answer, saved beside it as <id>.json.\n`, { mode: 0o600 });
    const briefs = { pass, preparedAt: new Date().toISOString(), bodies: {} };
    for (const b of bodies.filter((x) => x.readiness === 'light-edit')) {
      if (pass > POOL_PASSES) { b.editNote = [b.editNote, `still flagged after ${POOL_PASSES} passes: left as it is, for the owner`].filter(Boolean).join('; '); continue; }
      const row = rows.find((x) => x.id === b.id);
      writeFileSync(join(briefDir, `${b.id}.md`), repairBrief({ id: row.id, lane: row.lane, draft: row.draft }, b.targets, { loop: pass, cap: POOL_PASSES }), { mode: 0o600 });
      briefs.bodies[b.id] = briefKey(b.copySha256, b.targets);
    }
    writeFileSync(join(briefDir, '_briefs.json'), `${JSON.stringify(briefs, null, 1)}\n`, { mode: 0o600 });
  }
  for (const b of bodies) delete b.targets;
  const out = { preparedAt: new Date().toISOString(), lane, ms: Date.now() - started, counts: counts(bodies), bodies };
  // A partial prep (one lane, or --limit) merges into the file rather than dropping the other lane's rows.
  const prev = existsSync(PREP_FILE) ? JSON.parse(readFileSync(PREP_FILE, 'utf8')) : { bodies: [] };
  const merged = [...(prev.bodies || []).filter((b) => !bodies.some((x) => x.id === b.id)), ...bodies];
  writeFileSync(PREP_FILE, `${JSON.stringify({ ...out, counts: counts(merged), bodies: merged }, null, 1)}\n`);
  if (argv.includes('--json')) return console.log(JSON.stringify(out, null, 1));
  const c = out.counts;
  console.log(`pool prep · ${bodies.length} bodies in ${(out.ms / 1000).toFixed(1)}s · ready ${c.ready} · light-edit ${c['light-edit']} · owner ${c.owner} · blocked ${c.blocked} · unread ${c.unread}`);
  const edited = bodies.filter((b) => b.edited);
  if (edit) console.log(`  edited to ready by the chat writer: ${edited.length}${edited.length ? ` (${edited.map((b) => `${b.id} T${b.edited.join(' T')}`).join(' · ')})` : ''}`);
  for (const b of bodies.filter((x) => x.readiness !== 'ready')) {
    console.log(`  ${b.kind.padEnd(7)} ${String(b.id).padEnd(20)} ${b.readiness.padEnd(10)} ${b.tweets.length ? `T${b.tweets.join(' T')} · ` : ''}${(b.why[0] || '').slice(0, 100)}`);
  }
  if (briefDir && c['light-edit']) console.log(`  pass ${pass} briefs for the light edits: ${briefDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
