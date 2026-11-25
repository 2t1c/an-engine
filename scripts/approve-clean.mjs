#!/usr/bin/env node
// scripts/approve-clean.mjs — "approve clean": one word for the rows nothing flagged (owner, 2026-09-24,
// "go on #4").
//
// A waiting drafts batch splits in two:
//   CLEAN  every one of these holds: the packet's own status is ready_for_owner_review (no code hold, no
//          review line), Jev read this exact copy and flagged nothing (run-card triage "likely fine"),
//          and the row is not one of the ~15% audit sample
//   LOOK   everything else, each with its one hint line; an audit row says it is the audit
//
// The owner answers "approve clean" and then reads only LOOK. The approval is bound to what was shown:
// `preview` prints a sha over the clean rows and their revisions, and `approve` refuses unless the batch
// still splits to that same sha, so a row whose copy changed after the preview is never approved by it.
// Nothing here ever decides for the owner: without their words (--message) nothing is recorded.
//
//   node scripts/approve-clean.mjs preview --run-dir DIR --batch BATCH_ID
//   node scripts/approve-clean.mjs approve --run-dir DIR --batch BATCH_ID --sha SHA --message "exact user reply"
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardModel } from './run-card.mjs';
import { approveRowSet, status } from './run-studio.mjs';
import { AUDIT_SHARE } from './run-content-packets.mjs';

const STAGE = 'drafts';
const sha = (v) => createHash('sha256').update(v).digest('hex');

/** PURE. The deterministic audit sample, keyed on the row and the exact revision shown. */
export const auditPick = (id, revision, share = AUDIT_SHARE) => parseInt(sha(`audit|${id}|${revision}`).slice(0, 8), 16) / 0xffffffff < share;

/**
 * PURE. Split one waiting batch. `rows`: [{ id, revision, packetStatus, triage }] in card order.
 * Returns { clean: [{ id, revision }], look: [{ id, why }], sha }.
 */
export function splitBatch(rows, { share = AUDIT_SHARE } = {}) {
  const clean = [], look = [];
  for (const r of rows) {
    if (r.packetStatus !== 'ready_for_owner_review') look.push({ id: r.id, why: `packet: ${r.packetStatus || 'status not read'}` });
    else if (!r.triage) look.push({ id: r.id, why: 'Jev has not triaged this batch; read it in full' });
    else if (r.triage.group !== 'likely fine') look.push({ id: r.id, why: r.triage.hint });
    else if (!r.revision) look.push({ id: r.id, why: 'no revision to bind to' });
    else if (auditPick(r.id, r.revision, share)) look.push({ id: r.id, why: 'audit sample: Jev found nothing; read it in full so the miss rate stays measured' });
    else clean.push({ id: r.id, revision: r.revision });
  }
  return { clean, look, sha: sha(JSON.stringify(clean)).slice(0, 16) };
}

/** Reads the run: the batch's waiting rows with their packet status, revision and Jev triage. */
export function batchRows(runDir, batchId) {
  const dir = resolve(runDir);
  const model = cardModel({ runDir: dir });
  const ask = model.waiting.find((a) => a.stop.key === STAGE && a.batch?.id === batchId);
  if (!ask) throw new Error(`No drafts batch ${batchId} is waiting on the owner.`);
  const stage = status(dir).find((s) => s.stage === STAGE);
  const revisions = new Map((stage?.rows || []).map((r) => [r.id, r.revision]));
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  return ask.rows.map((r) => {
    let packetStatus = null;
    try {
      const body = readFileSync(join(dir, 'reviews', state.rowStages[STAGE].rows[r.id].snapshot), 'utf8');
      packetStatus = body.match(/^- Status: (\S+)/m)?.[1] || null;
    } catch { /* stays null: the row goes to LOOK */ }
    return { id: r.id, revision: revisions.get(r.id) || null, packetStatus, triage: ask.triage ? r.triage : null };
  });
}

function main(argv) {
  const [command, ...rest] = argv;
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i < 0 ? null : rest[i + 1]; };
  const runDir = flag('run-dir'), batch = flag('batch');
  if (!['preview', 'approve'].includes(command) || !runDir || !batch) throw new Error('Usage: approve-clean.mjs preview|approve --run-dir DIR --batch BATCH_ID [--sha SHA --message "exact user reply"]');
  const split = splitBatch(batchRows(runDir, batch));
  if (command === 'preview') return { batch, clean: split.clean.map((r) => r.id), look: split.look, sha: split.sha };
  const want = flag('sha'), message = flag('message');
  if (!want || !message) throw new Error('approve needs --sha from the preview and --message with the owner\'s exact words.');
  if (want !== split.sha) throw new Error(`Nothing recorded: the clean rows changed since the preview (now ${split.sha}). Preview again and show the owner.`);
  if (!split.clean.length) throw new Error('Nothing recorded: no clean rows in this batch.');
  return { batch, ...approveRowSet(resolve(runDir), STAGE, split.clean, message), stillToRead: split.look };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
