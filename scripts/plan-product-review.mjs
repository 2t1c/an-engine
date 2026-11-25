#!/usr/bin/env node
// Opt-in, read-only /run products review. All output stays outside the repository.
// node scripts/plan-product-review.mjs --run-dir /outside/run-reviews/RUN-ID --input /outside/products-spec.json \
//   --output /outside/products-plan.json --review-dir /outside/products-batches
// Spec: {selectionPlan:"/outside/selection-plan.json", rows:[
//   {id:"C01",lane:"cover",account:"julian",date:"2026-09-23",needs:["...","..."]},
//   {id:"H01",lane:"harvest",account:"jasper",date:"2026-09-23",sourceId:"harvest-record-id",
//    harvestOf:"published-source-id",contractProducts:["B01IQB2UYS"],contractSource:"verbatim pool body ID",needs:["..."]},
//   {id:"P01",lane:"seed",account:"jasper",date:"2026-09-23",sourceId:"seed-MV1",
//    contractVersion:"v1",contractProducts:["B07NXW4GW7"],contractSource:"approved seed/pot ID"}], chunkSize:8,
//   privateRates:{ASIN:{commission:0.45,source:"owner-confirmed private deal",verifiedAt:"ISO"}},
//   runPlan:"/outside/full-run-plan.json" (optional; checkPlan remains deferred otherwise)}
// --jev adds a REPORT-ONLY Jev reading per cover row (product-fit.mjs): which candidates the donor
// itself argues for, beside the canonical pick. It never changes a placement, status or flag. It also
// runs the registered decisions product-fit-heavy and product-second-earned (product-decisions.mjs)
// through decide() in shadow; a cover spec row may carry `bridges: [lineA, lineB]` for the second.
import { createHash } from 'node:crypto';
import { laneOf, sameLane } from '../lanes.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProductQueue } from '../product-queue.mjs';
import { checkPlan } from '../plan-check.mjs';
import { checkRow } from './run-studio.mjs';
import { runContentRules } from './run-rules.mjs';
import { approvedCalendar, slotBinding } from './run-calendar.mjs';
import { FIT_REVIEW_HOLD } from './cover-selection.mjs';
import { autoResolveRow, misfitFor, placementContext, planProductAllocation, productReviewPackets, resolveJevProductDecisions, sellableFor, triageRow } from './product-allocation.mjs';
import { attachProductFit } from '../product-fit.mjs';
import { attachProductDecisions, productDecisionsActing } from '../product-decisions.mjs';
import { createDecisionLog } from '../jev-decide.mjs';
import { jev } from '../jev.mjs';
import { loadEnv } from '../lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRoot = realpathSync(root);
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const resolveFrom = (base, path) => isAbsolute(path) ? path : resolve(dirname(base), path);
const projectedRealPath = (target) => {
  let anchor = resolve(target);
  const tail = [];
  while (!existsSync(anchor)) { tail.unshift(anchor.slice(dirname(anchor).length + 1)); anchor = dirname(anchor); }
  return resolve(realpathSync(anchor), ...tail);
};
const insideRepo = (target) => {
  const actual = projectedRealPath(target);
  return actual === realRoot || actual.startsWith(realRoot + sep);
};

function approvedSelection(runDir, row) {
  const current = checkRow(runDir, 'selection', row.id);
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const entry = state.rowStages?.selection?.rows?.[row.id];
  if (!entry || entry.revision !== current.revision) throw new Error(`${row.id}: selection approval changed during read`);
  const body = readFileSync(join(runDir, 'reviews', entry.snapshot), 'utf8');
  if (row.lane !== 'cover') {
    const marker = body.trimEnd().split('\n').at(-1)?.match(/^<!-- PI_RUN_SELECTION_V1 (\{[^\n]*\}) -->$/);
    if (!marker || body.split('<!-- PI_RUN_SELECTION_V1 ').length !== 2) throw new Error(`${row.id}: approved non-cover selection needs one trailing PI_RUN_SELECTION_V1 contract marker`);
    let selected;
    try { selected = JSON.parse(marker[1]); } catch { throw new Error(`${row.id}: invalid approved non-cover selection marker`); }
    const asins = (row.contractProducts || []).map(product => typeof product === 'string' ? product : product?.asin);
    if (!row.sourceId || !row.contractSource || !asins.length || (laneOf(row.lane) === 'seed' && !row.contractVersion)
      || (row.lane === 'harvest' && !row.harvestOf)
      || selected.account !== row.account || selected.date !== row.date || !sameLane(selected.lane, row.lane)
      || selected.sourceId !== row.sourceId || selected.contractSource !== row.contractSource
      || selected.contractVersion !== (row.contractVersion || '') || selected.harvestOf !== (row.harvestOf || '')
      || JSON.stringify(selected.contractProducts) !== JSON.stringify(asins)) {
      throw new Error(`${row.id}: non-cover source or product contract differs from approved selection row`);
    }
    return { revision: current.revision };
  }
  const accountDate = body.match(/^- Account\/date: ([^\n]+) · (\d{4}-\d\d-\d\d)$/m);
  const donorSection = body.match(/^## Proposed donor\n([\s\S]*?)(?=^## Screened swap candidates|$(?![\s\S]))/m);
  const donorId = donorSection?.[1]?.match(/^- Donor: (rec[A-Za-z0-9]+) ·/m)?.[1];
  const snapshotHash = body.match(/^- Complete picker snapshot SHA-256: ([a-f0-9]{64})$/m)?.[1];
  // The account-fit hold (plan-cover-selection.mjs) exists to put an out-of-niche match in front of the
  // owner; their approval of that exact row is the review it asked for. Every other hold still refuses.
  if (!accountDate || accountDate[1] !== row.account || accountDate[2] !== row.date || !donorId || !snapshotHash
    || new RegExp(`^- Status: held(?!: ${FIT_REVIEW_HOLD.slice('held: '.length)}$)`, 'm').test(body)) throw new Error(`${row.id}: approved selection row lacks an exact usable donor/account/date/snapshot`);
  return { donorId, snapshotHash, revision: current.revision };
}

// --preview (owner 2026-09-28: "Product check and holds and reselect should be in selection build"): the
// same plan, built from the selection plan BEFORE the owner approves it, so the selection message can show
// each row's product. It writes the plan only: no packets, no ledger, and it never counts as approval.
const PREVIEW = process.argv.includes('--preview');

function donorRows(spec, inputPath, runDir) {
  const selectionPath = spec.selectionPlan ? resolveFrom(inputPath, spec.selectionPlan) : null;
  const selection = selectionPath ? JSON.parse(readFileSync(selectionPath, 'utf8')) : null;
  if (selection && selection.schema !== 'cover-selection-plan-v1') throw new Error('selectionPlan is not a cover-selection-plan-v1');
  const selectionRows = new Map((selection?.rows || []).map((r) => [r.id, r]));
  const snapshotDonors = new Map();
  for (const source of selection?.sources || []) {
    const path = resolveFrom(selectionPath, source.path);
    const raw = readFileSync(path);
    const hash = createHash('sha256').update(raw).digest('hex');
    if (hash !== source.sha256) throw new Error(`selection snapshot changed: ${path}`);
    const snap = JSON.parse(raw);
    if (!snap.complete || snap.schema !== 'cover-picker-snapshot-v1' || snap.date !== source.date) throw new Error(`${path}: incomplete or mismatched picker snapshot`);
    for (const donor of snap.selected || []) snapshotDonors.set(`${source.date}:${donor.recId}`, donor);
  }
  const rows = spec.rows || (selection?.rows || []).map((r) => ({ id: r.id, account: r.account, date: r.date, lane: 'cover' }));
  if (!rows.length) throw new Error('spec needs rows[] or a selectionPlan with cover rows');
  return rows.map((row) => {
    if (!runDir) throw new Error('An approved run-studio selection is required; pass --run-dir RUN_DIR');
    const approved = PREVIEW ? null : approvedSelection(runDir, row);
    if (row.lane !== 'cover') return row;
    if (!selection) throw new Error(`${row.id}: cover rows require a verified selectionPlan`);
    const sourceRow = selectionRows.get(row.id);
    if (!sourceRow || sourceRow.account !== row.account || sourceRow.date !== row.date) throw new Error(`${row.id}: account/date mismatch with selectionPlan`);
    const selectedId = sourceRow.selected?.recId;
    const expectedHash = selection.sources.find((source) => source.date === row.date)?.sha256;
    if (approved && (approved.donorId !== selectedId || approved.snapshotHash !== expectedHash)) throw new Error(`${row.id}: product donor or snapshot differs from approved selection row`);
    const donor = selectedId ? snapshotDonors.get(`${row.date}:${selectedId}`) : null;
    if (selectedId && !donor) throw new Error(`${row.id}: canonical selected donor ${selectedId} absent from verified snapshot`);
    const selectionStatus = sourceRow.status === FIT_REVIEW_HOLD ? 'proposed (account fit approved by the owner)' : sourceRow.status;
    return { ...row, donor: donor ? { ...donor } : null, selectionStatus };
  });
}

// A held row gets no packet, so its reasons (a proven loser's EPC and clicks among them) are printed for
// the owner rather than left inside the plan file. A product-fit hold (owner R2026-10-03: "be extra careful
// with selection so there is no need to reconsider after plugging") also names the donors to reselect.
function printHeld(rows) {
  const held = rows.filter((r) => r.status === 'held');
  for (const row of held) console.log(`  held ${row.id} (${row.account} · ${row.date} · ${row.lane}): ${row.reasons.join('; ')}`);
  const reselect = held.filter((r) => r.lane === 'cover' && r.sourceId && r.reasons.some((x) => /^product fit: .*: reselect/.test(x)));
  for (const date of [...new Set(reselect.map((r) => r.date))].sort()) {
    console.log(`  reselect: re-run pick-donors with --exclude ${reselect.filter((r) => r.date === date).map((r) => r.sourceId).join(',')} for ${date}, then plan-cover-selection`);
  }
}

function attachPlanCheck(plan, runPlanPath, options = {}) {
  if (!runPlanPath) return { status: 'deferred', reason: 'full run plan not supplied; do not run plan-check on a partial product-free selection' };
  const runPlan = JSON.parse(readFileSync(runPlanPath, 'utf8'));
  const check = checkPlan(runPlan, { phase: options.phase || 1, mix: options.mix || null });
  const byId = new Map(Object.values(runPlan.days || {}).flat().filter((r) => r.id).map((r) => [r.id, r]));
  const parity = [], unverifiedContracts = [];
  for (const row of plan.rows) {
    const p = byId.get(row.id);
    if (!p) { parity.push(`${row.id}: full run plan has no matching stable ID`); continue; }
    if (row.lane !== 'cover' && p.heavy == null && p.light == null) {
      unverifiedContracts.push(`${row.id}: full plan does not expose pot/harvest product contract; verify against source body`);
      continue;
    }
    const heavy = row.placements[0]?.asin || null, light = row.placements[1]?.asin || null;
    if ((p.heavy || null) !== heavy || (p.light || null) !== light) parity.push(`${row.id}: full plan products differ from review proposal`);
  }
  return { status: check.errors.length || parity.length ? 'failed' : unverifiedContracts.length ? 'partial' : 'passed',
    errors: check.errors, warnings: check.warnings, parity, unverifiedContracts, summary: check.summary };
}

const input = arg('input'), output = arg('output'), reviewDir = arg('review-dir'), runDir = arg('run-dir');
if (!input || !output || !runDir) { console.error('usage: plan-product-review.mjs --run-dir RUN_DIR --input SPEC.json --output PLAN.json [--review-dir DIR] [--jev]'); process.exitCode = 2; }
else {
  try {
    const inputPath = resolve(input), outputPath = resolve(output), packetDir = reviewDir ? resolve(reviewDir) : null;
    if (insideRepo(outputPath) || (packetDir && insideRepo(packetDir))) throw new Error('Product review output must be outside the repository');
    if (existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
    const spec = JSON.parse(readFileSync(inputPath, 'utf8'));
    const runState = JSON.parse(readFileSync(join(resolve(runDir), 'state.json'), 'utf8'));
    const expectedRows = PREVIEW ? (spec.expectedRows ?? (spec.rows || []).length) : runState.rowStages?.selection?.expectedRows;
    if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || (spec.expectedRows != null && spec.expectedRows !== expectedRows)) {
      throw new Error('Product expectedRows must match the declared run-wide selection row count');
    }
    const catalog = JSON.parse(readFileSync(join(root, 'products.json'), 'utf8'));
    const board = JSON.parse(readFileSync(join(root, 'learnings/product-board.json'), 'utf8'));
    const queue = readProductQueue().queue;
    const rows = donorRows(spec, inputPath, resolve(runDir));
    const plan = planProductAllocation({ rows, expectedRows, products: catalog.products, board, queue,
      privateRates: spec.privateRates || {}, catalogRefreshed: catalog.meta?.refreshed || null,
      productsMax: runContentRules(resolve(runDir))?.productsMax ?? null });
    // Owner rule 2026-09-23: when the product decisions act, Jev always reads (no --jev needed).
    if (process.argv.includes('--jev') || productDecisionsActing()) {
      let client = null, unavailableReason = null;
      try { client = jev(loadEnv()); } catch (error) { unavailableReason = error.message; }
      await attachProductFit(plan, rows, catalog.products, client, { unavailableReason });
      console.log(`Jev product fit (report-only): read ${plan.jevFit.read}/${plan.jevFit.rows}, agrees ${plan.jevFit.agrees}, unavailable ${plan.jevFit.unavailable}`);
      // The registered decisions (product-fit-heavy, product-second-earned) through decide(), shadow and
      // report-only. The decision log keeps hashes and short ids only, never donor copy.
      const decisionLog = createDecisionLog();
      try { await attachProductDecisions(plan, rows, catalog.products, client, { log: decisionLog, unavailableReason }); }
      finally { decisionLog.flush(); }
      // Owner 2026-09-28, "Keep donor, sell anyway": Jev's reading resolves the row (the donor's own argued
      // product takes the heavy, an unargued heavy gets an explicit bridge, an unearned second is dropped).
      const ctx = placementContext({ products: catalog.products, board, privateRates: spec.privateRates || {}, catalogRefreshed: catalog.meta?.refreshed || null });
      const sellable = sellableFor(catalog.products);
      // The donor's rival takes the heavy only when it fits this page and this thread (R2026-10-03).
      const source = new Map(rows.map((r) => [r.id, r]));
      for (const row of plan.rows) {
        const misfit = misfitFor(source.get(row.id) || row);
        resolveJevProductDecisions(row, ctx, { sellable: (asin) => sellable(asin) && !misfit({ asin, title: ctx.catalog.get(asin)?.title }) });
      }
      const d = plan.jevDecisions;
      console.log(`Jev product decisions (${productDecisionsActing() ? 'decide: they resolve rows at this stop' : 'shadow, report-only'}): heavy read ${d.heavy.read}/${d.rows}, would filter ${d.heavy.wouldFilter}; second read ${d.second.read}, not earned ${d.second.flagged}; not read ${d.heavy.notRead + d.second.notRead}`);
    }
    // Owner 2026-09-28, "auto-resolve all": the holds that have a safe resolution resolve here, each one
    // written into the row for the packet and the receipt. What has none still holds.
    const productsMax = runContentRules(resolve(runDir))?.productsMax ?? null;
    for (const row of plan.rows) autoResolveRow(row, { productsMax });
    // R1: rows bound to the brief's approved calendar carry their slot line; a row off its slot is held.
    const calendar = approvedCalendar(resolve(runDir));
    for (const row of plan.rows) {
      const binding = slotBinding(calendar, row);
      row.slotLine = binding.line;
      if (binding.hold) { row.status = 'held'; row.reasons.push(binding.hold); row.triage = triageRow(row); }
    }
    // A slot hold can move a row to held after the planner counted it: recount so the summary matches.
    const by = (s) => plan.rows.filter((r) => r.status === s);
    Object.assign(plan.summary, { held: by('held').length, reviewNeeded: by('review_needed').length, proposed: by('proposed').length,
      reviewNeededInformationalOnly: by('review_needed').filter((r) => !r.triage.blocking.length).length });
    plan.input = { selectionPlan: spec.selectionPlan || null, rowIds: rows.map((r) => r.id) };
    plan.planCheck = attachPlanCheck(plan, spec.runPlan ? resolveFrom(inputPath, spec.runPlan) : null,
      { phase: spec.phase, mix: spec.mix });
    plan.generatedAt = new Date().toISOString();
    if (PREVIEW) {
      writeFileSync(outputPath, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(`${outputPath}: PREVIEW of ${plan.rows.length} rows (not a packet, not an approval)`);
      for (const row of plan.rows) console.log(`  ${row.id.padEnd(16)} ${row.status.padEnd(13)} ${row.placements.map((p) => `${p.placement} ${p.asin} ${String(p.title || '').slice(0, 40)}${p.needsBridge ? ' (bridge)' : ''}`).join(' | ') || '(no product)'}${row.resolutions?.length ? ` · resolved: ${row.resolutions.length}` : ''}`);
      printHeld(plan.rows);
      process.exit(0);
    }
    const packets = productReviewPackets(plan, spec.chunkSize ?? 8);
    plan.reviewPackets = packetDir ? packets.map((p) => join(packetDir, `${p.batchId}.json`)) : [];
    if (packetDir) {
      mkdirSync(packetDir, { recursive: true, mode: 0o700 });
      for (const file of plan.reviewPackets) if (existsSync(file)) throw new Error(`Review packet already exists: ${file}`);
    }
    writeFileSync(outputPath, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
    if (packetDir) for (let i = 0; i < packets.length; i++) writeFileSync(plan.reviewPackets[i], JSON.stringify(packets[i], null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`${outputPath}: ${plan.summary.rows} rows in ${packets.length} review batches; ${plan.summary.held} held, ${plan.summary.reviewNeeded} need evidence/review; plan gate ${plan.planCheck.status}`);
    printHeld(plan.rows);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
