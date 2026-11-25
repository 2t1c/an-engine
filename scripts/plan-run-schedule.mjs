#!/usr/bin/env node
// Read-only, opt-in staged /run schedule proposal. No provider calls or writes.
// node scripts/plan-run-schedule.mjs --input /outside/repo/spec.json \
//   --output /outside/repo/plan.json --review-dir /outside/repo/schedule-packets
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRow } from './run-studio.mjs';
import { planRunSchedule } from './run-schedule-preflight.mjs';
import { approvedCalendar } from './run-calendar.mjs';
import { readingsFor } from './run-jev.mjs';
import { FINAL_COPY_STAGE, finalCopyLines, REREAD } from './run-jev-final.mjs';

// The final-copy Jev read (scripts/run-jev-final.mjs, report-only): each packet prints the reading of
// the exact provider copy it shows, or says it was not read. It never changes a hold or a status.
function jevFinalCopy(runDir) {
  let readings = null, problem = null;
  try { readings = readingsFor(runDir, FINAL_COPY_STAGE); } catch (error) { problem = `jev/${FINAL_COPY_STAGE}.json unreadable: ${error.message}`.slice(0, 120); }
  const memo = new Map();
  return row => {
    if (problem) return [`- JEV final-copy: not read (${problem}) — ${REREAD}`];
    if (!memo.has(row.id)) {
      const copy = row.providerCopy && Object.fromEntries(Object.entries(row.providerCopy).map(([p, posts]) => [p, posts.map(post => post.text)]));
      memo.set(row.id, finalCopyLines(readings.get(row.id), copy));
    }
    return memo.get(row.id);
  };
}

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
function projectedRealPath(target) {
  let anchor = resolve(target);
  const tail = [];
  while (!existsSync(anchor)) { tail.unshift(anchor.slice(dirname(anchor).length + 1)); anchor = dirname(anchor); }
  return resolve(realpathSync(anchor), ...tail);
}
function assertOutsideRepo(target) {
  const path = projectedRealPath(target);
  if (path === repo || path.startsWith(repo + sep)) throw new Error('Output/review packets must be outside the repository because they include unpublished copy');
}

const input = arg('input'), output = arg('output'), reviewDir = arg('review-dir');
if (!input || !output || !reviewDir) {
  console.error('usage: plan-run-schedule.mjs --input <spec.json> --output <plan.json> --review-dir <empty-dir>');
  process.exitCode = 2;
} else {
  try {
    const inputPath = resolve(input), outputPath = resolve(output), packetDir = resolve(reviewDir);
    assertOutsideRepo(outputPath); assertOutsideRepo(packetDir);
    if (existsSync(outputPath)) throw new Error('Output already exists; use a new path for a fresh occupancy snapshot');
    if (existsSync(packetDir) && readdirSync(packetDir).length) throw new Error('Review directory must be empty to avoid stale schedule packets');
    const spec = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (!spec.runDir || !isAbsolute(spec.runDir)) throw new Error('runDir must name the absolute staged /run directory');
    const runState = JSON.parse(readFileSync(join(spec.runDir, 'state.json'), 'utf8'));
    if (!Number.isSafeInteger(runState.rowStages?.drafts?.expectedRows)
      || spec.expectedRows !== runState.rowStages.drafts.expectedRows) {
      throw new Error('Schedule expectedRows must match the declared run-wide drafts row count');
    }
    // A brief approved with a calendar (PI_RUN_SLOTS_V1) turns on calendar mode; an older brief keeps
    // today's stop 5 unchanged (approvedCalendar returns null).
    const jevLines = jevFinalCopy(spec.runDir);
    const result = planRunSchedule(spec, {
      checkDraftApproval: id => checkRow(spec.runDir, 'drafts', id).revision,
      calendar: approvedCalendar(spec.runDir),
      finalCopyLines: jevLines,
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    mkdirSync(packetDir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify({ ...result, batches: undefined }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    result.batches.forEach(batch => writeFileSync(join(packetDir, `${batch.batchId}.json`), JSON.stringify(batch, null, 2) + '\n', { flag: 'wx', mode: 0o600 }));
    console.log(JSON.stringify({ status: result.status, output: outputPath, reviewDir: packetDir, summary: result.summary, calendar: result.rows.filter(row => row.calendar).map(row => ({ id: row.id, ...row.calendar })), held: result.rows.filter(row => row.status === 'hold').map(row => ({ id: row.id, reasons: row.holds })),
      // Every row, held ones included: an owner-edited row is held here, and its final-copy read is what the owner needs to see.
      jevFinalCopy: result.rows.map(row => ({ id: row.id, lines: jevLines(row).map(line => line.replace(/^- /, '')) })) }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
