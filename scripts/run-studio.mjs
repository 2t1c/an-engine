#!/usr/bin/env node
// Local review bookkeeping only. An approval message records actual owner consent;
// this is not authentication and must never be invented by an agent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyDigests, editsPolicyOf, keepsApproval } from '../copy-change.mjs';
import { LAWS } from '../laws.mjs';
import { parseSlotsMarker } from './run-calendar.mjs';

// Every stop a run can have. Which of them a given run walks is its FLOW, recorded at init.
export const STAGES = ['brief', 'selection', 'products', 'hooks', 'drafts', 'schedule'];
// Owner 2026-09-22: "We should merge 4 and 5 ... there is no difference." Once every thread lives in its
// own review draft, the hook and the finished thread are reviewed in the same place, and the drafts
// stop reviews batches as they are written, so the first batch catches a wrong hook direction as early
// as the hooks stop did. New runs therefore skip the hooks stop; the drafts stop then binds to the
// approved products row and runs the hook-fidelity gate itself. The six-stop flow stays for runs
// begun before this change (a state file without `flow`) and for any run that asks for it at init.
export const MERGED_FLOW = ['brief', 'selection', 'products', 'drafts', 'schedule'];
export const DEFAULT_FLOW = MERGED_FLOW;
const FLOWS = [STAGES, MERGED_FLOW];
// Owner, 2026-09-26, on the scheduled run: "the only thing I need to see is the inital selection,
// everything else until the final revision can and should be automated." A run initialised with
// --scheduled may record that standing consent (laws.json run.scheduled.standingConsent, verbatim) at
// the stops it names. These stops always take the owner's own reply, whatever laws.json lists: the
// selection, and the final revision (drafts, or hooks in a six-stop run) with the schedule behind it.
export const LIVE_ONLY = Object.freeze(['selection', 'hooks', 'drafts', 'schedule']);
const sameFlow = (a, b) => Array.isArray(a) && a.length === b.length && a.every((stage, i) => stage === b[i]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validIdentifier = value => typeof value === 'string' && identifier.test(value) && !Object.prototype.hasOwnProperty.call(Object.prototype, value);
const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = message => { throw new Error(message); };
function stageIndex(stage, flow = STAGES) {
  if (!STAGES.includes(stage)) fail(`Unknown stage: ${stage}`);
  const index = flow.indexOf(stage);
  if (index < 0) fail(`This run has no ${stage} stop (its stops are ${flow.join(' → ')}).`);
  return index;
}
const rowStagesOf = flow => flow.slice(1);
/** The stops a run walks. Exported so the phase helpers bind to the run's actual predecessor stop. */
export function flowOf(directory) {
  return load(runRoot(directory)).flow;
}
function regular(file) {
  if (!fs.lstatSync(file).isFile()) fail(`Expected a regular file, not a symlink: ${file}`);
}
function runRoot(directory) {
  const resolved = path.resolve(directory);
  if (!fs.lstatSync(resolved).isDirectory()) fail('Run directory must be a directory, not a symlink.');
  return fs.realpathSync(resolved);
}
function child(root, name) {
  const file = path.join(root, name);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail(`Symlink is not allowed: ${name}`);
  return file;
}
function writeAtomic(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function locked(root, fn) {
  const lock = path.join(root, '.run-studio.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('Run is locked. Wait for the other process; inspect a stale lock before removing it.'); throw error; }
  try { fs.writeFileSync(fd, `${process.pid}\n`); return fn(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function load(root) {
  const file = child(root, 'state.json'); regular(file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schema !== 1 || !state.stages || typeof state.stages !== 'object') fail('Unsupported or invalid run state.');
  if (state.flow === undefined) state.flow = [...STAGES];   // a run begun before flows existed walks all six
  if (!FLOWS.some(flow => sameFlow(state.flow, flow))) fail('Invalid run flow.');
  if (state.mode !== undefined && state.mode !== 'scheduled') fail('Invalid run mode.');
  for (const [stage, entry] of Object.entries(state.stages)) {
    stageIndex(stage, state.flow);
    if (!/^[a-f0-9]{64}$/.test(entry.revision) || entry.snapshot !== `${stage}-${entry.revision}.md`) fail('Invalid snapshot path or revision.');
  }
  if (state.rowStages === undefined) state.rowStages = {};
  if (!state.rowStages || typeof state.rowStages !== 'object' || Array.isArray(state.rowStages)) fail('Invalid row-stage state.');
  for (const [stage, group] of Object.entries(state.rowStages)) {
    if (!rowStagesOf(state.flow).includes(stage) || state.stages[stage]) fail('Invalid row-stage mode.');
    if (!Number.isSafeInteger(group.expectedRows) || group.expectedRows < 1 || !group.rows || !group.batches) fail('Invalid row-stage roster.');
    for (const [id, entry] of Object.entries(group.rows)) {
      if (!validIdentifier(id) || !/^[a-f0-9]{64}$/.test(entry.revision) || entry.snapshot !== `${stage}-row-${id}-${entry.revision}.md`) fail('Invalid row snapshot path or revision.');
    }
    for (const [id, batch] of Object.entries(group.batches)) {
      if (!validIdentifier(id) || !Array.isArray(batch.rowIds) || batch.rowIds.some(rowId => !validIdentifier(rowId) || !group.rows[rowId]?.batchId || group.rows[rowId].batchId !== id)) fail('Invalid batch roster.');
    }
  }
  if (state.history === undefined) state.history = [{ sequence: 1, at: new Date().toISOString(), type: 'imported-state', stages: structuredClone(state.stages) }];
  if (!Array.isArray(state.history)) fail('Invalid run history.');
  return state;
}
function save(root, state) { writeAtomic(child(root, 'state.json'), JSON.stringify(state, null, 2) + '\n'); }
// Label capture (owner, 2026-09-23): the run directory lives outside the repo and is cleaned up after
// a run, so every owner verdict was lost with it. The CLI appends one row per verdict to a repo log —
// the verdict, the revision it applies to and a hash of the owner's words, never the copy — so verdicts become the labels
// Jev's decisions are measured against. Library callers (tests) opt in with setVerdictLog.
const VERDICT_TYPES = { approved: 'approve', 'row-approved': 'approve', 'row-held': null, 'row-inherited': 'inherit' };
let verdictLog = null;
export function setVerdictLog(file) { verdictLog = file || null; }
export const DEFAULT_VERDICT_LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'learnings', 'run-verdicts.jsonl');
/** Jev's reading for a row at the moment of a verdict: { jev: { stage, status, action, copy } } or {}. */
export function jevAtVerdict(root, stage, id) {
  if (!id || !['selection', 'drafts'].includes(stage)) return {};
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'jev', `${stage}.json`), 'utf8'));
    const r = (doc.rows || []).find((x) => x.id === id);
    if (!r) return {};
    const pre = r.prescore;
    return { jev: { stage, status: r.status, action: stage === 'drafts' ? (pre?.status === 'read' ? pre.action : 'not read') : (r.flags?.length ? 'flagged' : r.status === 'read' ? 'clean' : 'not read'),
      mode: pre?.mode ?? null, copy: String(r.copySha256 || '').slice(0, 16) } };
  } catch { return {}; }
}
function logVerdict(root, event, at) {
  if (!verdictLog || !(event.type in VERDICT_TYPES)) return;
  const consent = event.approval ?? event.hold ?? {};
  // Standing consent (a scheduled run's brief and products, and the slots inherited from that brief) is
  // not a verdict: the owner did not read this revision, so it is no label for Jev's decisions.
  if (consent.standing) return;
  const row = { at, run: path.basename(root), stage: event.stage, rowId: event.id ?? null, batchId: event.batchId ?? null,
    verdict: VERDICT_TYPES[event.type] ?? consent.kind ?? 'hold', revision: consent.revision ?? null,
    // The owner's words can quote unpublished copy, which never enters Git: the repo keeps their hash
    // and length, and the words themselves stay in the run's state.json.
    messageSha256: createHash('sha256').update(String(consent.message ?? '')).digest('hex'),
    messageChars: String(consent.message ?? '').length, recordedAt: consent.recordedAt ?? at,
    // What Jev had decided for this row when the owner ruled (plan v7 N6), so each verdict is a label
    // for that decision: its action and the copy hash it read. Absent when no reading exists.
    ...jevAtVerdict(root, event.stage, event.id) };
  try { fs.mkdirSync(path.dirname(verdictLog), { recursive: true }); fs.appendFileSync(verdictLog, `${JSON.stringify(row)}\n`); }
  catch (error) { console.error(`verdict log not written (${error.message}); the run's state.json still holds it`); }
}
function record(state, event, root = null) {
  const at = new Date().toISOString();
  state.history.push({ sequence: state.history.length + 1, at, ...structuredClone(event) });
  if (root) logVerdict(root, event, at);
}
function snapshot(root, entry) {
  const directory = child(root, 'reviews');
  if (!fs.lstatSync(directory).isDirectory()) fail('Reviews must be a directory.');
  const file = child(directory, entry.snapshot); regular(file);
  return fs.readFileSync(file);
}
function inspect(root, state) {
  let upstreamApproved = true;
  const dependencies = {};
  return state.flow.map(stage => {
    const entry = state.stages[stage];
    let reason = null;
    if (entry) {
      try {
        const content = snapshot(root, entry);
        if (hash(content) !== entry.contentSha256) reason = 'Review snapshot changed since submission.';
        else if (JSON.stringify(entry.dependencies) !== JSON.stringify(dependencies)) reason = 'Upstream revisions changed.';
        else if (hash(JSON.stringify({ stage, contentSha256: entry.contentSha256, dependencies })) !== entry.revision) reason = 'Revision binding is invalid.';
        else if (!upstreamApproved) reason = 'An upstream stage is not approved.';
        else if (entry.approval && (entry.approval.revision !== entry.revision || !entry.approval.message?.trim())) reason = 'Approval record is invalid.';
      } catch (error) { reason = error.message; }
    }
    const status = reason ? 'stale' : entry?.approval ? 'approved' : entry ? 'awaiting approval' : upstreamApproved ? 'ready to prepare' : 'blocked';
    const result = { stage, status, revision: entry?.revision ?? null, reason };
    upstreamApproved = upstreamApproved && status === 'approved';
    if (entry) dependencies[stage] = entry.revision;
    return result;
  });
}

function rowDependencies(root, state, stage, id) {
  const index = stageIndex(stage, state.flow);
  if (index === 1) {
    const brief = inspect(root, state)[0];
    return brief.status === 'approved' ? { brief: brief.revision } : null;
  }
  const parent = inspectRow(root, state, state.flow[index - 1], id);
  return parent?.status === 'approved' ? { [parent.stage]: parent.revision } : null;
}
function inspectRow(root, state, stage, id) {
  const entry = state.rowStages[stage]?.rows[id];
  if (!entry) return null;
  let reason = null;
  try {
    const content = snapshot(root, entry);
    const dependencies = rowDependencies(root, state, stage, id);
    if (hash(content) !== entry.contentSha256) reason = 'Review snapshot changed since submission.';
    else if (!dependencies) reason = 'The same row in the previous stage is not approved.';
    else if (JSON.stringify(entry.dependencies) !== JSON.stringify(dependencies)) reason = 'Upstream row revision changed.';
    else if (hash(JSON.stringify({ stage, id, contentSha256: entry.contentSha256, dependencies })) !== entry.revision) reason = 'Row revision binding is invalid.';
    else if (entry.approval && (entry.approval.revision !== entry.revision || !entry.approval.message?.trim())) reason = 'Row approval record is invalid.';
    else if (entry.approval?.inherited?.from === 'brief' && briefRevisionOf(root, state) !== entry.approval.inherited.briefRevision) reason = 'The brief this slot approval was inherited from was resubmitted; the slot needs a fresh check.';
    else if (entry.hold && (entry.hold.revision !== entry.revision || !entry.hold.message?.trim())) reason = 'Row hold record is invalid.';
  } catch (error) { reason = error.message; }
  return { stage, id, batchId: entry.batchId, status: reason ? 'stale' : entry.hold ? 'held' : entry.approval ? 'approved' : 'awaiting approval', revision: entry.revision, reason, contentSha256: entry.contentSha256 };
}
function briefRevisionOf(root, state) {
  const brief = inspect(root, state)[0];
  return brief.status === 'approved' ? brief.revision : null;
}
// A row's machine marker: the last line of its review content, `<!-- NAME {json} -->`, exactly once.
export function rowMarker(content, name) {
  const body = String(content ?? '');
  const line = body.trimEnd().split('\n').at(-1);
  const match = line?.match(new RegExp(`^<!-- ${name} (\\{[^\\n]*\\}) -->$`));
  if (!match || body.split(`<!-- ${name} `).length !== 2) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
/** The owner's intake answer on what re-opens approval ('words' unless the run's intake.json says 'any'). */
function editsPolicy(root) {
  const file = child(root, 'intake.json');
  if (!fs.existsSync(file)) return 'words';
  try { regular(file); return editsPolicyOf(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return 'any'; }
}
/**
 * CHANGE CLASSIFIER (owner, 2026-09-23: "only content re-opens review and approval"). A drafts row whose
 * new content differs from its approved revision only in spacing or formatting (the reflow the
 * publisher applies anyway, proven by equal normalized digests in the PI_RUN_DRAFT_V1 marker) keeps
 * its approval, recorded as inherited with the classification. Anything that changes a published
 * word, the slot, the products, media or lineage (the marker's bindingSha256) re-opens it. The
 * intake answer edits='any' turns this off. Returns the inherited approval or null.
 */
function carriedApproval(root, state, stage, id, prior, next, content) {
  if (!prior?.approval || prior.hold || JSON.stringify(prior.dependencies) !== JSON.stringify(next.dependencies)) return null;
  if (inspectRow(root, state, stage, id)?.status !== 'approved') return null;
  const revision = next.revision;
  let before;
  try { before = rowMarker(snapshot(root, prior).toString('utf8'), 'PI_RUN_DRAFT_V1'); } catch { return null; }
  const after = rowMarker(content.toString('utf8'), 'PI_RUN_DRAFT_V1');
  if (!before || !after || before.slotId !== after.slotId || !before.bindingSha256 || before.bindingSha256 !== after.bindingSha256) return null;
  const classification = classifyDigests(before, after);
  const policy = editsPolicy(root);
  if (classification === 'none' || !keepsApproval(classification, policy)) return null;
  return { revision, message: prior.approval.message, recordedAt: new Date().toISOString(),
    inherited: { from: 'row', priorRevision: prior.revision, classification, policy } };
}
function batchRevision(stage, batchId, group) {
  const rowIds = group.batches[batchId].rowIds;
  return hash(JSON.stringify({ stage, batchId, rows: rowIds.map(id => [id, group.rows[id].revision]) }));
}
function inspectRowStage(root, state, stage) {
  const group = state.rowStages[stage];
  if (!group) return null;
  const rows = Object.keys(group.rows).map(id => inspectRow(root, state, stage, id));
  const counts = Object.fromEntries(['approved', 'awaiting approval', 'held', 'stale'].map(status => [status, rows.filter(row => row.status === status).length]));
  const complete = rows.length === group.expectedRows;
  const status = counts.stale ? 'stale' : !complete ? 'awaiting batches' : counts['awaiting approval'] ? 'awaiting approval' : counts.held ? 'partially approved' : counts.approved ? 'approved' : 'blocked';
  const batches = Object.entries(group.batches).map(([id, batch]) => ({ id, revision: batchRevision(stage, id, group), rows: batch.rowIds.map(rowId => rows.find(row => row.id === rowId)) }));
  return { stage, status, mode: 'rows', expectedRows: group.expectedRows, submittedRows: rows.length, counts, batches, rows };
}
function inspectAll(root, state) {
  const whole = inspect(root, state);
  return whole.map((row, index) => {
    const rowStage = inspectRowStage(root, state, row.stage);
    if (rowStage) return rowStage;
    if (!state.stages[row.stage] && index > 1 && state.rowStages[state.flow[index - 1]]) {
      const predecessor = inspectRowStage(root, state, state.flow[index - 1]);
      if (predecessor.counts.approved) return { stage: row.stage, status: 'ready for approved rows', mode: 'rows' };
    }
    return row;
  });
}

export function init(directory, { flow = DEFAULT_FLOW, scheduled = false } = {}) {
  if (!FLOWS.some(allowed => sameFlow(flow, allowed))) fail(`Unsupported flow; use ${MERGED_FLOW.join(' → ')} (default) or ${STAGES.join(' → ')}.`);
  fs.mkdirSync(path.resolve(directory), { recursive: true });
  const root = runRoot(directory);
  return locked(root, () => {
    if (fs.existsSync(child(root, 'state.json'))) fail('Run already exists; use status to resume.');
    fs.mkdirSync(child(root, 'reviews'), { recursive: true });
    save(root, { schema: 1, createdAt: new Date().toISOString(), flow: [...flow], ...(scheduled ? { mode: 'scheduled' } : {}), stages: {}, rowStages: {}, history: [] });
    return status(root);
  });
}
/** 'scheduled' for a run the routine started from its Notion page (init --scheduled), else 'attended'. */
export function modeOf(directory) {
  return load(runRoot(directory)).mode || 'attended';
}
/** The owner's standing consent for scheduled runs, from laws.json, refused if it names a stop that
 *  must take the owner's own reply. The message is the owner's words, verbatim, with who and when. */
export function standingConsent(laws = LAWS) {
  const consent = laws.run?.scheduled?.standingConsent;
  if (!consent?.quote?.trim() || !consent.on || !Array.isArray(consent.stages) || !consent.stages.length) fail('No standing consent is recorded (laws.json run.scheduled.standingConsent).');
  const refused = consent.stages.filter(stage => !STAGES.includes(stage) || LIVE_ONLY.includes(stage));
  if (refused.length) fail(`Standing consent cannot cover ${refused.join(', ')}: the selection and the final revision take the owner's own reply.`);
  return { stages: [...consent.stages], message: `Standing consent (${consent.by || 'owner'}, ${consent.on}): "${consent.quote.trim()}"` };
}
export function status(directory) {
  const root = runRoot(directory);
  const state = load(root);
  return inspectAll(root, state);
}
export function submit(directory, stage, artifact) {
  stageIndex(stage); const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), rows = inspect(root, state), index = stageIndex(stage, state.flow);
    if (state.rowStages[stage] || state.flow.slice(0, index).some(name => state.rowStages[name])) fail('This stage uses row batches; use submit-batch for each approved row instead.');
    if (rows.slice(0, index).some(row => row.status !== 'approved')) fail('Approve every prior stage before submitting this stage.');
    const source = path.resolve(artifact); regular(source);
    if (path.extname(source).toLowerCase() !== '.md') fail('Submit a Markdown (.md) review artifact.');
    const content = fs.readFileSync(source);
    if (!content.toString('utf8').trim()) fail('Review artifact must not be empty.');
    const dependencies = Object.fromEntries(state.flow.slice(0, index).map(name => [name, state.stages[name].revision]));
    const contentSha256 = hash(content), revision = hash(JSON.stringify({ stage, contentSha256, dependencies }));
    const entry = { revision, contentSha256, dependencies, snapshot: `${stage}-${revision}.md`, submittedAt: new Date().toISOString() };
    const reviews = child(root, 'reviews');
    if (!fs.lstatSync(reviews).isDirectory()) fail('Reviews must be a directory.');
    const target = child(reviews, entry.snapshot);
    if (fs.existsSync(target)) { regular(target); if (hash(fs.readFileSync(target)) !== contentSha256) fail('Archived snapshot was tampered with; restore it before resubmitting.'); }
    else fs.writeFileSync(target, content, { flag: 'wx', mode: 0o444 });
    if (state.stages[stage]?.revision === revision) return { stage, revision, snapshot: target, status: rows[index].status, unchanged: true };
    for (const name of state.flow.slice(index)) {
      if (state.stages[name]) record(state, { type: 'invalidated', stage: name, causedBy: stage, entry: state.stages[name] });
      delete state.stages[name];
    }
    state.stages[stage] = entry;
    record(state, { type: 'submitted', stage, entry }); save(root, state);
    return { stage, revision, snapshot: target, status: 'awaiting approval' };
  });
}
export function submitBatch(directory, stage, artifact, { rowOnly = false } = {}) {
  if (!rowStagesOf(STAGES).includes(stage)) fail('Row batches are supported from selection through schedule.');
  const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root);
    stageIndex(stage, state.flow);
    if (state.stages[stage]) fail('This stage already uses whole-stage review; do not mix modes.');
    const source = path.resolve(artifact); regular(source);
    if (path.extname(source).toLowerCase() !== '.json') fail('Submit a JSON (.json) batch artifact.');
    const packet = JSON.parse(fs.readFileSync(source, 'utf8'));
    const { batchId, expectedRows, rows } = packet;
    if (!validIdentifier(batchId)) fail('Batch ID must be a safe identifier containing only letters, digits, hyphens or underscores.');
    if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > 1000) fail('expectedRows must be a positive integer no greater than 1000.');
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) fail('A batch must contain 1–20 rows. Split larger review packets.');
    const rowIds = rows.map(row => row?.id);
    if (rowIds.some(id => !validIdentifier(id)) || new Set(rowIds).size !== rowIds.length) fail('Row IDs must be unique safe identifiers containing only letters, digits, hyphens or underscores.');
    if (rows.some(row => typeof row.content !== 'string' || !row.content.trim())) fail('Every row needs its full nonempty Markdown review content.');
    const group = state.rowStages[stage] ?? { expectedRows, rows: {}, batches: {} };
    if (group.expectedRows !== expectedRows) fail('expectedRows must match this stage’s original roster size.');
    const existingBatch = group.batches[batchId];
    if (rowOnly && (!existingBatch || rowIds.length !== 1 || !existingBatch.rowIds.includes(rowIds[0]))) fail('A row revision must name one row of its existing batch.');
    if (!rowOnly && existingBatch && JSON.stringify(existingBatch.rowIds) !== JSON.stringify(rowIds)) fail('A submitted batch has a fixed row roster. Revise row content without silently adding or removing rows.');
    for (const id of rowIds) {
      if (group.rows[id] && group.rows[id].batchId !== batchId) fail(`Row ${id} already belongs to another batch.`);
    }
    if (Object.keys(group.rows).length + rowIds.filter(id => !group.rows[id]).length > expectedRows) fail('Batch exceeds expectedRows for this stage.');
    const reviews = child(root, 'reviews');
    if (!fs.lstatSync(reviews).isDirectory()) fail('Reviews must be a directory.');
    const prepared = rows.map(row => {
      const content = Buffer.from(row.content, 'utf8');
      const contentSha256 = hash(content), dependencies = rowDependencies(root, state, stage, row.id);
      const prior = group.rows[row.id];
      if (!dependencies && (!prior || prior.contentSha256 !== contentSha256)) fail(`Cannot submit ${row.id}: approve its matching row in the previous stage first.`);
      const revision = dependencies ? hash(JSON.stringify({ stage, id: row.id, contentSha256, dependencies })) : prior.revision;
      const entry = dependencies ? { batchId, revision, contentSha256, dependencies, snapshot: `${stage}-row-${row.id}-${revision}.md`, submittedAt: new Date().toISOString() } : prior;
      const target = child(reviews, entry.snapshot);
      if (fs.existsSync(target)) { regular(target); if (hash(fs.readFileSync(target)) !== contentSha256) fail('Archived row snapshot was tampered with; restore it before resubmitting.'); }
      return { id: row.id, content, entry, target };
    });
    for (const item of prepared) if (!fs.existsSync(item.target)) fs.writeFileSync(item.target, item.content, { flag: 'wx', mode: 0o444 });
    let changed = false;
    for (const item of prepared) {
      const prior = group.rows[item.id];
      if (prior?.revision === item.entry.revision) continue;
      const carried = prior && item.entry !== prior ? carriedApproval(root, state, stage, item.id, prior, item.entry, item.content) : null;
      if (prior && !carried) record(state, { type: 'row-invalidated', stage, id: item.id, causedBy: stage, entry: prior });
      group.rows[item.id] = carried ? { ...item.entry, approval: carried } : item.entry;
      record(state, { type: 'row-submitted', stage, id: item.id, entry: group.rows[item.id] });
      if (carried) record(state, { type: 'row-inherited', stage, id: item.id, approval: carried }, root);
      changed = true;
    }
    if (!existingBatch) {
      group.batches[batchId] = { rowIds, submittedAt: new Date().toISOString() };
      record(state, { type: 'batch-created', stage, batchId, rowIds });
      changed = true;
    }
    state.rowStages[stage] = group;
    if (changed) save(root, state);
    return { stage, batchId, revision: batchRevision(stage, batchId, group), rows: rowIds.map(id => ({ id, revision: group.rows[id].revision, status: inspectRow(root, state, stage, id).status })), unchanged: !changed };
  });
}
/**
 * Revise ONE row inside its existing batch (owner, 2026-09-23: "one tweak forced a whole-batch
 * resubmit"). The rest of the batch keeps its revisions and approvals untouched; only this row is
 * re-submitted, and it keeps its approval when the change classifier says no published word moved.
 */
export function submitRow(directory, stage, id, artifact) {
  if (!validIdentifier(id)) fail('Row ID must be a safe identifier.');
  const root = runRoot(directory);
  const source = path.resolve(artifact); regular(source);
  if (path.extname(source).toLowerCase() !== '.md') fail('Submit a Markdown (.md) row revision.');
  const content = fs.readFileSync(source, 'utf8');
  if (!content.trim()) fail('Row content must not be empty.');
  const group = load(root).rowStages[stage];
  const prior = group?.rows[id];
  if (!prior) fail(`${stage}/${id} has not been submitted in a batch yet; use submit-batch.`);
  const temporary = child(root, `.row-${randomUUID()}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ batchId: prior.batchId, expectedRows: group.expectedRows, rows: [{ id, content }] }), { flag: 'wx', mode: 0o600 });
    return submitBatch(directory, stage, temporary, { rowOnly: true });
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
/**
 * Stop 5 for a slot that did not move (R1, owner 2026-09-23). The brief approved the calendar; a
 * schedule row whose slot, minute and platforms are exactly the approved slot inherits that approval.
 * There is no --message: the owner's recorded brief words are copied verbatim, and the approval goes
 * stale the moment the brief is resubmitted. A changed slot is refused and goes to the owner.
 */
export function inheritRow(directory, stage, id, revision) {
  if (stage !== 'schedule') fail('Only schedule rows inherit the brief calendar approval.');
  const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), row = inspectRow(root, state, stage, id);
    if (!row || row.revision !== revision) fail('Revision does not match the current row submission.');
    if (row.status !== 'awaiting approval') fail(`Cannot inherit: ${row.reason ?? row.status}`);
    const brief = inspect(root, state)[0];
    if (brief.status !== 'approved') fail('The brief is not approved; nothing to inherit.');
    let calendar;
    try { calendar = parseSlotsMarker(snapshot(root, state.stages.brief).toString('utf8')); } catch (error) { fail(`Brief calendar is unreadable: ${error.message}`); }
    if (!calendar) fail('The approved brief carries no calendar (PI_RUN_SLOTS_V1); ask the owner at stop 5 as before.');
    const entry = state.rowStages[stage].rows[id];
    const proposed = rowMarker(snapshot(root, entry).toString('utf8'), 'PI_RUN_SCHEDULE_V1');
    if (!proposed) fail('Schedule row carries no PI_RUN_SCHEDULE_V1 marker.');
    const slot = calendar.slots.find(s => s.slotId === id);
    const samePlatforms = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
    if (!slot || slot.status !== 'open') fail(`${id} is not an open slot of the approved calendar; ask the owner.`);
    if (proposed.slotId !== id || proposed.account !== slot.account || proposed.utc !== slot.utc || !samePlatforms(proposed.platforms, slot.platforms)) {
      fail(`Slot changed since the brief: approved ${slot.utc} ${slot.platforms.join('+')} -> proposed ${proposed.utc} ${(proposed.platforms || []).join('+')}; ask the owner.`);
    }
    entry.approval = { revision, message: state.stages.brief.approval.message, recordedAt: new Date().toISOString(),
      ...(state.stages.brief.approval.standing ? { standing: true } : {}),
      inherited: { from: 'brief', briefRevision: brief.revision, slotSha256: slot.sha256 } };
    delete entry.hold;
    record(state, { type: 'row-inherited', stage, id, approval: entry.approval }, root); save(root, state);
    return inspectRow(root, state, stage, id);
  });
}
function requireApprovalMessage(message) {
  if (!message?.trim()) fail('Supply the exact actual user approval with --message; agents must not self-approve.');
}
export function approveRow(directory, stage, id, revision, message) {
  requireApprovalMessage(message); const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), row = inspectRow(root, state, stage, id);
    if (!row || row.revision !== revision) fail('Approval revision does not match the current row submission.');
    if (!['awaiting approval', 'approved', 'held'].includes(row.status)) fail(`Cannot approve: ${row.reason ?? row.status}`);
    const entry = state.rowStages[stage].rows[id];
    delete entry.hold;
    entry.approval = { revision, message, recordedAt: new Date().toISOString() };
    record(state, { type: 'row-approved', stage, id, approval: entry.approval }, root); save(root, state);
    return inspectRow(root, state, stage, id);
  });
}
// A hold records WHY the owner stopped a row: a plain hold, a revision request or a swap. All three
// keep the row out of execution exactly as before; the kind is the label.
export const HOLD_KINDS = ['hold', 'revise', 'swap'];
export function holdRow(directory, stage, id, revision, message, kind = 'hold') {
  requireApprovalMessage(message); const root = runRoot(directory);
  if (!HOLD_KINDS.includes(kind)) fail(`Hold kind must be one of ${HOLD_KINDS.join(', ')}.`);
  return locked(root, () => {
    const state = load(root), row = inspectRow(root, state, stage, id);
    if (!row || row.revision !== revision) fail('Hold revision does not match the current row submission.');
    if (!['awaiting approval', 'approved', 'held'].includes(row.status)) fail(`Cannot hold: ${row.reason ?? row.status}`);
    const entry = state.rowStages[stage].rows[id];
    delete entry.approval;
    entry.hold = { revision, message, kind, recordedAt: new Date().toISOString() };
    record(state, { type: 'row-held', stage, id, hold: entry.hold }, root); save(root, state);
    return inspectRow(root, state, stage, id);
  });
}
export function approveBatch(directory, stage, batchId, revision, message) {
  requireApprovalMessage(message);
  return approveBatchWith(directory, stage, batchId, revision, message);
}
function approveBatchWith(directory, stage, batchId, revision, message, { standing = false } = {}) {
  const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), group = state.rowStages[stage];
    if (!group?.batches[batchId] || batchRevision(stage, batchId, group) !== revision) fail('Batch revision does not match the current submission.');
    const inspected = group.batches[batchId].rowIds.map(id => inspectRow(root, state, stage, id));
    const eligible = inspected.filter(row => ['awaiting approval', 'approved'].includes(row.status));
    if (!eligible.length) fail('No approvable rows in this batch.');
    for (const row of eligible) {
      const entry = group.rows[row.id];
      entry.approval = { revision: row.revision, message, ...(standing ? { standing: true } : {}), recordedAt: new Date().toISOString() };
      record(state, { type: standing ? 'row-standing-approved' : 'row-approved', stage, id: row.id, batchId, approval: entry.approval }, root);
    }
    save(root, state);
    return { stage, batchId, revision, approved: eligible.map(row => row.id), skipped: inspected.filter(row => !eligible.includes(row)).map(row => ({ id: row.id, status: row.status, reason: row.reason })) };
  });
}
/**
 * Approve an exact set of rows, each bound to the revision the owner was shown (scripts/approve-clean.mjs:
 * "approve clean"). All or nothing: if any listed row changed or is no longer awaiting, nothing is recorded.
 */
export function approveRowSet(directory, stage, rows, message) {
  requireApprovalMessage(message); const root = runRoot(directory);
  if (!Array.isArray(rows) || !rows.length) fail('No rows to approve.');
  return locked(root, () => {
    const state = load(root), group = state.rowStages[stage];
    if (!group) fail(`${stage} has no row batches.`);
    const inspected = rows.map(({ id, revision }) => ({ want: revision, row: inspectRow(root, state, stage, id), id }));
    const bad = inspected.filter(({ row, want }) => !row || row.revision !== want || row.status !== 'awaiting approval');
    if (bad.length) fail(`Nothing recorded: ${bad.map(({ id, row }) => `${id} (${row ? (row.status !== 'awaiting approval' ? row.status : 'copy changed') : 'not submitted'})`).join(', ')}.`);
    const recordedAt = new Date().toISOString();
    for (const { row } of inspected) {
      const entry = group.rows[row.id];
      entry.approval = { revision: row.revision, message, recordedAt };
      record(state, { type: 'row-approved', stage, id: row.id, batchId: entry.batchId, approval: entry.approval }, root);
    }
    save(root, state);
    return { stage, approved: inspected.map(({ id }) => id) };
  });
}
export function checkRow(directory, stage, id) {
  if (!rowStagesOf(STAGES).includes(stage)) fail('Unknown row stage.');
  const root = runRoot(directory), state = load(root);
  stageIndex(stage, state.flow);
  const row = inspectRow(root, state, stage, id);
  if (!row || row.status !== 'approved') fail(`${stage}/${id}: ${row?.reason ?? row?.status ?? 'not submitted'}`);
  return row;
}
export function approve(directory, stage, revision, message) {
  stageIndex(stage);
  if (!message?.trim()) fail('Supply the exact actual user approval with --message; agents must not self-approve.');
  return approveWhole(directory, stage, revision, message);
}
function approveWhole(directory, stage, revision, message, { standing = false } = {}) {
  const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), row = inspect(root, state).find(row => row.stage === stage);
    if (!row.revision || row.revision !== revision) fail('Approval revision does not match the current submission.');
    if (!['awaiting approval', 'approved'].includes(row.status)) fail(`Cannot approve: ${row.reason ?? row.status}`);
    state.stages[stage].approval = { revision, message, ...(standing ? { standing: true } : {}), recordedAt: new Date().toISOString() };
    record(state, { type: standing ? 'standing-approved' : 'approved', stage, approval: state.stages[stage].approval }, root);
    save(root, state);
    return { stage, status: 'approved', revision, ...(standing ? { standing: true } : {}), next: state.flow[stageIndex(stage, state.flow) + 1] ?? 'Run review complete; scheduling is a separate operation.' };
  });
}
/**
 * The owner's standing consent at a stop they delegated to a scheduled run (laws.json
 * run.scheduled.standingConsent): the brief, or one products batch, of a run initialised with
 * --scheduled. The message is the owner's recorded words, verbatim and marked standing, never an
 * agent's; it is not logged as an owner verdict, because the owner did not read this revision.
 */
export function approveStanding(directory, stage, { revision, batchId = null } = {}, consent = standingConsent()) {
  stageIndex(stage);
  if (LIVE_ONLY.includes(stage) || !consent.stages.includes(stage)) fail(`${stage}: not covered by the owner's standing consent (${consent.stages.filter(s => !LIVE_ONLY.includes(s)).join(', ')}); it needs the owner's own reply.`);
  if (modeOf(directory) !== 'scheduled') fail('Standing consent applies only to a scheduled run (run-studio init --scheduled).');
  if (!consent.message?.trim()) fail('Standing consent carries no words.');
  return batchId ? approveBatchWith(directory, stage, batchId, revision, consent.message, { standing: true })
    : approveWhole(directory, stage, revision, consent.message, { standing: true });
}
/**
 * The owner's veto consent for scheduled runs (laws.json run.scheduled.vetoConsent; owner, 2026-09-28:
 * "Build the ship-if-no-answer approval model"): the selection proceeds once shown, and a finished thread
 * ships once its deadline passes with no hold. The messages are the owner's recorded words, verbatim.
 */
export function vetoConsent(laws = LAWS) {
  const v = laws.run?.scheduled?.vetoConsent;
  if (!v?.on || !v.quote?.trim() || !v.selection?.trim() || !v.drafts?.trim() || !(Number(v.deadlineHours) > 0)) fail('No veto consent is recorded (laws.json run.scheduled.vetoConsent).');
  const who = `${v.by || 'owner'}, ${v.on}`, hours = Number(v.deadlineHours);
  return {
    deadlineHours: hours,
    message: {
      selection: `Veto consent (${who}): "${v.quote.trim()}"; at selection: "${v.selection.trim()}". The row proceeds unless the owner holds or swaps it before it is written.`,
      drafts: `Veto consent (${who}): "${v.quote.trim()}"; final revision: "${v.drafts.trim()}"${v.unanswered?.trim() ? `, unanswered: "${v.unanswered.trim()}"` : ''}. Approved at its deadline, ${hours} h before its slot, with no hold from the owner.`,
    },
  };
}
/**
 * One batch under the owner's veto consent, on a run initialised --scheduled only.
 *   selection: every row still awaiting approval, now.
 *   drafts:    only rows whose deadline (the approved slot minus deadlineHours) has passed at `now`.
 * A row the owner held, swapped or asked to revise is 'held' and never touched. A row whose packet holds it
 * ("Status: held: …" at selection, such as the account-fit review; "Status: hold" at drafts) is refused, since
 * consent never clears a hold, and so is a drafts row with no approved slot: its deadline is never guessed.
 * The slot comes from the approved brief's calendar, read under the lock as inheritRow reads it; no caller
 * supplies it. The approval is marked standing, so it is never an owner verdict. The CLI takes no time
 * argument: the deadline is the clock's.
 */
export function approveVeto(directory, stage, batchId, revision, { now = Date.now() } = {}, consent = vetoConsent()) {
  if (!['selection', 'drafts'].includes(stage)) fail(`${stage}: veto consent covers the selection and the drafts stop (the final revision) only.`);
  if (modeOf(directory) !== 'scheduled') fail('Veto consent applies only to a scheduled run (run-studio init --scheduled).');
  if (!consent?.message?.[stage]?.trim()) fail('Veto consent carries no words.');
  const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), group = state.rowStages[stage];
    if (!group?.batches[batchId] || batchRevision(stage, batchId, group) !== revision) fail('Batch revision does not match the current submission.');
    const slots = new Map();
    if (stage === 'drafts') {
      if (inspect(root, state)[0].status !== 'approved') fail('The brief is not approved, so no slot has a deadline.');
      let calendar;
      try { calendar = parseSlotsMarker(snapshot(root, state.stages.brief).toString('utf8')); } catch (error) { fail(`Brief calendar is unreadable: ${error.message}`); }
      for (const s of calendar?.slots || []) if (s.status === 'open') slots.set(s.slotId, s);
    }
    const approved = [], waiting = [], refused = [], skipped = [];
    for (const id of group.batches[batchId].rowIds) {
      const row = inspectRow(root, state, stage, id);
      if (row.status !== 'awaiting approval') { skipped.push({ id, status: row.status, ...(row.reason ? { reason: row.reason } : {}) }); continue; }
      // A selection row says "- Status: held: …" (cover-selection.mjs), a drafts row "- Status: hold".
      const held = snapshot(root, group.rows[id]).toString('utf8').match(/^- Status: (hold|held\b.*)$/m)?.[1];
      if (held) { refused.push({ id, reason: `its packet holds it (${held})` }); continue; }
      if (stage === 'drafts') {
        const slot = Date.parse(slots.get(id)?.utc ?? '');
        if (!Number.isFinite(slot)) { refused.push({ id, reason: 'no approved slot, so no deadline' }); continue; }
        const deadline = slot - consent.deadlineHours * 3600e3;
        if (now < deadline) { waiting.push({ id, deadline: new Date(deadline).toISOString() }); continue; }
      }
      const entry = group.rows[id];
      entry.approval = { revision: row.revision, message: consent.message[stage], standing: true, veto: true, recordedAt: new Date(now).toISOString() };
      record(state, { type: 'row-standing-approved', stage, id, batchId, approval: entry.approval }, root);
      approved.push(id);
    }
    if (approved.length) save(root, state);
    return { stage, batchId, revision, approved, waiting, refused, skipped, nextDeadline: waiting.map(w => w.deadline).sort()[0] ?? null };
  });
}
export function check(directory, stage) {
  stageIndex(stage, flowOf(directory));
  const row = status(directory).find(row => row.stage === stage);
  if (row.status !== 'approved') fail(`${stage}: ${row.reason ?? row.status}`);
  return row;
}
/**
 * The rows the owner saw at a stop, for the reply-intent guard (scripts/reply-guard.mjs): ids, their
 * position in the batch and a label of account, date and lane from the row's marker. Never copy. A
 * whole-stage stop is one row named for the stage. Read-only: no lock, no write.
 */
export function replyRows(directory, stage, { id = null, batchId = null } = {}) {
  const root = runRoot(directory), state = load(root);
  stageIndex(stage, state.flow);
  const group = state.rowStages[stage];
  if (!group) {
    if (id || batchId) fail(`${stage} is reviewed as a whole stage; it has no rows.`);
    return [{ id: stage, label: `the ${stage} stop`, position: 1 }];
  }
  const bid = batchId ?? (id && Object.hasOwn(group.rows, id) ? group.rows[id].batchId : null);
  if (!bid || !Object.hasOwn(group.batches, bid)) fail(`${stage}: no batch holds ${id ?? batchId}.`);
  return group.batches[bid].rowIds.map((rowId, index) => ({ id: rowId, position: index + 1, label: `${rowLabel(root, state, stage, rowId)} · ${bid}` }));
}
const LABEL_MARKERS = ['PI_RUN_SCHEDULE_V1', 'PI_RUN_PRODUCTS_V1', 'PI_RUN_HOOK_V1', 'PI_RUN_SELECTION_V1'];
// Account, day and lane from the row's own marker; a drafts row (PI_RUN_DRAFT_V1 carries hashes only)
// borrows them from the same row id at the nearest earlier stop.
function rowLabel(root, state, stage, id) {
  const stops = state.flow.slice(1, state.flow.indexOf(stage) + 1).reverse();
  for (const stop of stops) {
    const rows = state.rowStages[stop]?.rows;
    if (!rows || !Object.hasOwn(rows, id)) continue;
    const entry = rows[id];
    let content;
    try { content = snapshot(root, entry).toString('utf8'); } catch { continue; }
    for (const name of LABEL_MARKERS) {
      const marker = rowMarker(content, name);
      if (marker?.account) return [id, marker.account, marker.date ?? marker.utc, marker.lane].filter(value => typeof value === 'string' && value && value.length <= 40).join(' · ');
    }
  }
  return id;
}
export function render(directory) {
  const root = runRoot(directory);
  return locked(root, () => {
    const state = load(root), rows = inspectAll(root, state);
    const sections = rows.map(row => {
      if (row.mode === 'rows' && state.rowStages[row.stage]) {
        const group = state.rowStages[row.stage];
        const batches = row.batches.map((batch, index) => {
          const cards = batch.rows.map(item => {
            const entry = group.rows[item.id]; let content = '';
            try { content = snapshot(root, entry).toString('utf8'); } catch (error) { content = error.message; }
            const decision = entry.hold ? `Owner hold: ${entry.hold.message}` : entry.approval ? `Owner approval: ${entry.approval.message}` : 'Awaiting owner review.';
            return `<article id="${escape(row.stage)}-${escape(item.id)}"><h4>${escape(item.id)} · ${escape(item.status)}</h4>${item.reason ? `<p>${escape(item.reason)}</p>` : ''}<p>Row revision: <code>${escape(item.revision)}</code></p><pre>${escape(content)}</pre><p>${escape(decision)}</p></article>`;
          }).join('');
          return `<details ${index === 0 ? 'open' : ''}><summary>${escape(batch.id)} · ${batch.rows.length} rows · <code>${escape(batch.revision)}</code></summary>${cards}</details>`;
        }).join('');
        return `<section><h2>${escape(row.stage)} — ${escape(row.status)}</h2><p>${row.submittedRows}/${row.expectedRows} rows submitted · ${row.counts.approved} approved · ${row.counts.held} held · ${row.counts['awaiting approval']} awaiting · ${row.counts.stale} stale</p>${batches}</section>`;
      }
      const entry = state.stages[row.stage]; let text = '';
      if (entry) { try { text = snapshot(root, entry).toString('utf8'); } catch (error) { text = error.message; } }
      return `<section><h2>${escape(row.stage)} — ${escape(row.status)}</h2>${row.reason ? `<p>${escape(row.reason)}</p>` : ''}${entry ? `<p>Revision: <code>${escape(row.revision)}</code></p><pre>${escape(text)}</pre>${entry.approval ? `<p>Owner approval: ${escape(entry.approval.message)}</p>` : '<p>Stop here for owner review. Approve this exact revision before advancing.</p>'}` : ''}</section>`;
    }).join('\n');
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Run review board</title><style>body{font:16px system-ui;background:#f5f4ef;color:#212821;max-width:1000px;margin:40px auto;padding:0 24px}section{background:white;padding:24px;margin:20px 0;border-radius:12px}details{border:1px solid #d8ded7;border-radius:8px;margin:12px 0;padding:12px}summary{cursor:pointer;font-weight:600}article{border-top:1px solid #d8ded7;margin-top:14px;padding-top:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 system-ui}code{overflow-wrap:anywhere}</style><h1>Run review</h1><p>${escape(state.flow.map(stage => stage[0].toUpperCase() + stage.slice(1)).join(' → '))}</p><p>Local review record. No content is published by this tool. This board is a snapshot; rerender after changes.</p>${sections}</html>`;
    const file = child(root, 'board.html'); writeAtomic(file, html); return { board: file };
  });
}
function main(args) {
  const [command, directory, stage, ...rest] = args;
  if (!directory) fail('Usage: run-studio.mjs init RUN_DIR [--with-hooks] [--scheduled]; status|render RUN_DIR; submit RUN_DIR STAGE FILE.md; submit-batch RUN_DIR STAGE FILE.json; submit-row RUN_DIR STAGE ID FILE.md; inherit-row RUN_DIR schedule ID --revision DIGEST; approve|approve-row|approve-batch|hold-row|revise-row|swap-row RUN_DIR STAGE [ID] --revision DIGEST --message "exact user reply"; approve-standing RUN_DIR brief|products [BATCH_ID] --revision DIGEST (a scheduled run only; the owner\'s recorded words, no --message); approve-veto RUN_DIR selection|drafts BATCH_ID --revision DIGEST (a scheduled run only; the owner\'s veto consent: the selection at once, a draft once its deadline has passed); check|check-row RUN_DIR STAGE [ID]; check-reply RUN_DIR STAGE [ID | --batch BATCH_ID] --message "exact user reply" (report-only)');
  // A new run merges hooks into drafts; --with-hooks keeps the separate hooks stop for a run that wants it.
  // --scheduled marks a run the routine started from its Notion page (standing consent may apply).
  if (command === 'init') {
    const flags = [stage, ...rest].filter(Boolean);
    if (flags.some(flag => !['--with-hooks', '--scheduled'].includes(flag)) || new Set(flags).size !== flags.length) fail('Unexpected argument.');
    return init(directory, { flow: flags.includes('--with-hooks') ? STAGES : DEFAULT_FLOW, scheduled: flags.includes('--scheduled') });
  }
  // No --message on purpose: the words are the owner's standing consent, read from laws.json.
  if (command === 'approve-standing') {
    if (rest.length === 2 && rest[0] === '--revision') return approveStanding(directory, stage, { revision: rest[1] });
    if (rest.length === 3 && rest[1] === '--revision') return approveStanding(directory, stage, { batchId: rest[0], revision: rest[2] });
    fail('Usage: approve-standing RUN_DIR brief|products [BATCH_ID] --revision DIGEST');
  }
  if (['status', 'render'].includes(command)) { if (stage) fail('Unexpected argument.'); return ({ status, render })[command](directory); }
  if (command === 'submit' && rest.length === 1) return submit(directory, stage, rest[0]);
  if (command === 'submit-batch' && rest.length === 1) return submitBatch(directory, stage, rest[0]);
  if (command === 'submit-row' && rest.length === 2) return submitRow(directory, stage, rest[0], rest[1]);
  // No --message on purpose: the owner's recorded brief words are copied verbatim.
  if (command === 'inherit-row' && rest.length === 3 && rest[1] === '--revision') return inheritRow(directory, stage, rest[0], rest[2]);
  if (command === 'check' && rest.length === 0) return check(directory, stage);
  if (command === 'check-row' && rest.length === 1) return checkRow(directory, stage, rest[0]);
  if (command === 'approve' && rest.length === 4 && rest[0] === '--revision' && rest[2] === '--message') return approve(directory, stage, rest[1], rest[3]);
  if (command === 'approve-row' && rest.length === 5 && rest[1] === '--revision' && rest[3] === '--message') return approveRow(directory, stage, rest[0], rest[2], rest[4]);
  const holdKind = { 'hold-row': 'hold', 'revise-row': 'revise', 'swap-row': 'swap' }[command];
  if (holdKind && rest.length === 5 && rest[1] === '--revision' && rest[3] === '--message') return holdRow(directory, stage, rest[0], rest[2], rest[4], holdKind);
  if (command === 'approve-batch' && rest.length === 5 && rest[1] === '--revision' && rest[3] === '--message') return approveBatch(directory, stage, rest[0], rest[2], rest[4]);
  fail('Unknown command or invalid arguments. Approval requires --revision DIGEST --message "exact user approval".');
}
// ---- Reply-intent guard (plan Track J, Phase 7a): report-only; it never records, alters or blocks. -----
const GUARDED = { approve: 'stage', 'approve-row': 'row', 'approve-batch': 'batch' };
const loadGuard = () => import('./reply-guard.mjs');
async function guardRecordedApproval(args, result) {
  const [command, directory, stage, ...rest] = args;
  if (!Object.hasOwn(GUARDED, command)) return;
  try {
    const { guardMode, runGuard } = await loadGuard();
    if (guardMode() === 'off') return;
    const kind = GUARDED[command];
    const rows = kind === 'stage' ? replyRows(directory, stage) : replyRows(directory, stage, kind === 'row' ? { id: rest[0] } : { batchId: rest[0] });
    const targets = kind === 'stage' ? [stage] : kind === 'row' ? [rest[0]] : result.approved;
    await runGuard({ reply: rest.at(-1), rows, targets }, { recorded: true });
  } catch {
    console.error('Jev: reply not read (guard_error); the approval above is recorded as given, exactly as before.');
  }
}
/** approve-veto RUN_DIR selection|drafts BATCH_ID --revision DIGEST: the owner's veto consent, on the clock's time.
 *  No --message (the words are the owner's, from laws.json) and no time argument (the deadline is the clock's). */
function approveVetoCommand(args) {
  const [, directory, stage, batchId, flag, revision, ...more] = args;
  if (!directory || !stage || !batchId || flag !== '--revision' || !revision || more.length) fail('Usage: approve-veto RUN_DIR selection|drafts BATCH_ID --revision DIGEST');
  return approveVeto(directory, stage, batchId, revision, { now: Date.now() });
}
/** check-reply RUN_DIR STAGE [ID | --batch BATCH_ID] --message "…": the guard before anything is recorded. */
async function checkReplyCommand(args) {
  const [, directory, stage, ...rest] = args;
  const at = rest.indexOf('--message');
  const message = at >= 0 ? rest[at + 1] : undefined;
  const target = at >= 0 ? rest.slice(0, at) : rest;
  const shapeOk = target.length === 0 || (target.length === 1 && !target[0].startsWith('--')) || (target.length === 2 && target[0] === '--batch');
  if (!directory || !stage || at < 0 || rest.length !== at + 2 || !message?.trim() || !shapeOk) {
    fail('Usage: check-reply RUN_DIR STAGE [ID | --batch BATCH_ID] --message "exact user reply"');
  }
  const id = target.length === 1 ? target[0] : null, batchId = target.length === 2 ? target[1] : null;
  const rows = replyRows(directory, stage, { id, batchId });
  let targets = [stage];
  if (id) targets = [id];
  else if (batchId) {
    // The rows approve-batch would record: awaiting approval or already approved (as approveBatch).
    targets = (status(directory).find(entry => entry.stage === stage)?.rows ?? [])
      .filter(row => row.batchId === batchId && ['awaiting approval', 'approved'].includes(row.status)).map(row => row.id);
    if (!targets.length) fail('No approvable rows in this batch.');
  }
  const { guardMode, readReply } = await loadGuard();
  if (guardMode() === 'off') return { verdict: 'off', line: 'Reply guard is off (PI_RUN_REPLY_GUARD=off).', rows, targets };
  const read = await readReply({ reply: message, rows, targets }, { recorded: false });
  return { ...read, rows, targets, note: "Report-only. Record the owner's words with approve or hold as before; this reading never approves." };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setVerdictLog(process.env.PI_RUN_VERDICT_LOG === 'off' ? null : (process.env.PI_RUN_VERDICT_LOG || DEFAULT_VERDICT_LOG));
  const args = process.argv.slice(2);
  if (args[0] === 'check-reply') {
    try { console.log(JSON.stringify(await checkReplyCommand(args), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (args[0] === 'approve-veto') {
    try { console.log(JSON.stringify(approveVetoCommand(args), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else {
    let result = null;
    try { result = main(args); console.log(JSON.stringify(result, null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    // Only after the approval is recorded, verbatim, exactly as before: the guard prints one line to
    // stderr and can change neither the record, the printed result nor the exit code.
    if (result) {
      try { await guardRecordedApproval(args, result); }
      catch { /* guardRecordedApproval already prints "not read"; nothing may escape into the exit code */ }
    }
  }
}
