#!/usr/bin/env node
// ship-day.mjs <plan.json> <YYYY-MM-DD> [--dry] [--from <stage>] [--dir <specs>] [--skip-pots] [--no-telegram]
//
// One tool ships one run day, in the order Run 2 ran by hand eight times a day from a scratchpad:
//
//   plan      the folder and the plan agree: every cover/pot row has a spec, every spec has a row,
//             and plan-check passes at --phase (Run 4 ships --phase 4)
//   lint      lint-cover over the folder — advisory; the gate is the referee
//   hooks     hooks-check --dir — every cover hook inside the band against its real donor
//   gate      gate-thread --file per unshipped spec — the fleet's real publish gates
//   mint      batch-mint — every link, deterministic subids, resumable
//   publish   batch-publish --plan --day — each spec at its grid minute; a row that already carries
//             a draftId is skipped BY NAME, so a re-run never ships twice
//   stamp     the plan rows get draftId · shareUrl · slot · spec from the thread records — the step
//             Run 2 did by hand after every day, and the memory `publish` relies on
//   verify    verify-day on the Saigon date — the day's live state
//   links     check-links on every draft the day has stamped — each tracked link must resolve to
//             the product the ledger says it sells (Run 4: a reused link sold the wrong bottle)
//   pots      each shipped pot: the Pots row → Planted, the greenhouse draft gets the `planted` tag
//   manifest  the day's receipt (manifest-day.mjs) written next to the specs and sent to ops
//
// It stops at the first red stage and prints what to fix and how to resume (--from <stage>).
// `--dry` runs every stage with its writes off: mint and publish validate only, stamp/pots/manifest
// print what they would do. Nothing here talks to Typefully except through the tools it wraps, and
// nothing ships from a scratchpad again.
//
//   node ship-day.mjs queues/run-2026-09-15.json 2026-09-15 --dry      # rehearse
//   node ship-day.mjs queues/run-2026-09-15.json 2026-09-15            # ship
//   node ship-day.mjs queues/run-2026-09-15.json 2026-09-15 --from publish   # resume after a fix
//   node ship-day.mjs queues/run-2026-09-25.json 2026-09-25 --run-dir RUN_DIR  # /run: only approved slots ship
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, airtable, telegram, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS, resolveAccountKey } from './accounts.mjs';
import { RECORDS_DIR } from './thread-record.mjs';
import { noteCheck } from './thread-note.mjs';
import { checkPlan } from './plan-check.mjs';
import { LAWS } from './laws.mjs';
import { bucketOf, publishBatch, gridFromPlan, recordBatchOutcome, writeBatchPlan } from './batch-publish.mjs';
import { renderManifest, loadInputs } from './manifest-day.mjs';
import { slotWriteGuard } from './scripts/run-calendar.mjs';

export const STAGES = ['plan', 'lint', 'hooks', 'gate', 'mint', 'publish', 'stamp', 'verify', 'links', 'pots', 'manifest'];
const MONEY = new Set(['cover', 'pot']);

/** PURE. Match a day's plan rows to the specs in its folder, by account and bucket.
 *  rows  — plan.days[day]; specs — [{ file, spec }].
 *  Harvest rows are not this folder's job (attempts are created by the harvest lane) unless a spec
 *  in the folder says harvestOf. Returns { pairs, held, rowsWithoutSpec, specsWithoutRow }.
 *
 *  HELD vs MISSING (2026-09-10). A money row with no spec is normally the disagreement this stage
 *  exists to catch: something was planned and never written, and shipping the rest would ship a
 *  short day nobody noticed. A RESERVED pot row is the other thing entirely — the slot is held ON
 *  PURPOSE, because a pot's filling is the operator's creative decision and /pot cannot invent one.
 *  Run 3 planned 17 pots of which 16 were reserved pending fillings, and the plan stage refused all
 *  three days over it, including the 14 covers that were written, gated and ready. A row that says
 *  `reserved: true` is therefore HELD: named in the plan stage, counted in the mix (plan-check
 *  still sees it, so the phase shape stays honest), carried into the manifest as NOT SHIPPED, and
 *  never quietly dropped. Clear the flag when the spec lands and the row ships like any other. */
export function reconcile(rows = [], specs = []) {
  const pairs = [], specsWithoutRow = [];
  const taken = new Set();
  for (const { file, spec } of specs) {
    const key = resolveAccountKey(spec?.account) || String(spec?.account || '?');
    const bucket = bucketOf(spec || {});
    const i = rows.findIndex((r, idx) => !taken.has(idx) && r.account === key && r.bucket === bucket);
    if (i < 0) { specsWithoutRow.push({ file, key, bucket }); continue; }
    taken.add(i);
    pairs.push({ row: rows[i], file, key, bucket, spec });
  }
  const unmatched = rows.filter((r, idx) => MONEY.has(r.bucket) && !taken.has(idx));
  const held = unmatched.filter((r) => r.reserved === true);
  const rowsWithoutSpec = unmatched.filter((r) => r.reserved !== true);
  return { pairs, held, rowsWithoutSpec, specsWithoutRow };
}

/** Legacy display parser retained for compatibility. Production consumes publishBatch results. */
export function parseShipped(out = '') {
  const shipped = [], failed = [], skipped = [];
  for (const line of String(out).split('\n')) {
    let m = line.match(/^OK\s+(\S+)\s+(\S+)\s+.*?Draft created: (\d+)/);
    if (m) { shipped.push({ key: m[1], at: m[2], draftId: m[3] }); continue; }
    m = line.match(/^FAIL\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (m) { failed.push({ key: m[1], at: m[2], why: m[3].trim() }); continue; }
    m = line.match(/^SKIP\s+(\S+)\s+(.*)$/);
    if (m) skipped.push({ key: m[1], why: m[2].trim() });
  }
  return { shipped, failed, skipped };
}

/** PURE. A plan row with the shipped draft written in. Never erases what the row already says. */
export function stampRow(row, { draftId, shareUrl = null, slot = null, spec = null } = {}) {
  const out = { ...row };
  if (draftId) out.draftId = Number.isFinite(Number(draftId)) ? Number(draftId) : String(draftId);
  if (shareUrl) out.shareUrl = shareUrl;
  if (slot && !out.slot) out.slot = slot;
  if (spec && !out.spec) out.spec = spec;
  return out;
}

/** The thread record publish-thread wrote for a draft id, or null. */
export function recordFor(draftId, dir = RECORDS_DIR) {
  if (!draftId || !existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => x.endsWith(`-${draftId}.json`));
  if (!f) return null;
  try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; }
}

/**
 * The gate stage's report for one spec, from gate-thread's `--json-out` run. gateThread answers
 * `{ ok, issues: [string] }` or `{ ok: false, fatal }` — every entry in `issues` is a refusal (ok is
 * `issues.length === 0`), so they are the reason lines. This read `v.errors`/`v.warnings` once, which
 * gateThread never emits, and a refused spec printed ✗ with nothing under it. An issue object with
 * `severity: 'warn'` is counted as a warning, not a reason; non-JSON output falls back to its ✗ lines.
 */
export function gateLines(p, r = {}) {
  const out = String(r.out || '');
  let v = null; try { v = JSON.parse(out.split('\n').filter((l) => !l.startsWith('[roster]')).join('\n')); } catch { /* not json */ }
  const ok = v ? v.ok === true : r.code === 0;
  const isWarn = (i) => i && typeof i === 'object' && /^warn/i.test(String(i.severity || i.level || ''));
  const list = v ? [...(v.issues || []), ...(v.errors || [])] : [];
  const warns = v ? [...list.filter(isWarn), ...(v.warnings || [])] : [];
  const errs = v ? [...list.filter((i) => !isWarn(i)), ...(v.fatal ? [v.fatal] : [])] : out.split('\n').filter((l) => /✗/.test(l));
  const lines = [`   ${ok ? '✓' : '✗'} ${String(p.key).padEnd(9)} ${p.file}${warns.length ? `  (${warns.length} warning(s))` : ''}`];
  if (!ok) {
    const shown = errs.length ? errs : [`gate-thread refused with no reason given (exit ${r.code ?? '?'})`];
    for (const e of shown.slice(0, 8)) lines.push(`        · ${String(typeof e === 'string' ? e : e.msg || JSON.stringify(e)).trim().slice(0, 160)}`);
    if (shown.length > 8) lines.push(`        · …and ${shown.length - 8} more`);
  }
  return { ok, lines, errors: errs, warnings: warns };
}

const run = (script, args) => {
  try { return { code: 0, out: execFileSync('node', [join(HERE_DIR, script), ...args], { encoding: 'utf8', cwd: HERE_DIR, timeout: 900000, maxBuffer: 1 << 26 }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};
const show = (out, indent = '   ') => { for (const l of String(out).split('\n')) if (l.trim() && !l.startsWith('[roster]')) console.log(indent + l); };
const hr = (label) => console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 66 - label.length))}`);

async function main() {
  // `phase` joins from/dir here or its VALUE is read as a positional: `--phase 4 plan.json <day>`
  // would otherwise make "4" the plan file. It worked only because --phase was always typed last.
  const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !String(all[i - 1] || '').match(/^--(from|dir|phase|run-dir)$/));
  const [file, DAY] = pos;
  if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(DAY || '')) {
    console.error("usage: node ship-day.mjs <plan.json> <YYYY-MM-DD> --phase <n> [--dry] [--from <stage>] [--dir <specs>] [--run-dir RUN_DIR] [--skip-pots] [--no-telegram]");
    console.error('  e.g. node ship-day.mjs queues/run-2026-09-14.json 2026-09-14 --dry --phase 4');
    process.exit(2);
  }
  const DRY = process.argv.includes('--dry');
  // ONE PHASE FOR THE WHOLE RUN. Defaults to the LAST phase in laws.farm.phases rather than a
  // literal: a new phase is an operator decision recorded in laws.json, and a tool that defaults to
  // an older number silently validates the run against rules the operator has already replaced.
  // Out of range is fatal — plan-check only WARNS on an unknown phase and skips the MIX check
  // entirely, so a typo'd --phase would ship a run with its lane mix never checked at all.
  const PHASES = LAWS.farm?.phases || [];
  const PHASE = Number(cliArg('phase', PHASES.length));
  if (!Number.isInteger(PHASE) || PHASE < 1 || PHASE > PHASES.length) {
    console.error(`--phase must be 1..${PHASES.length} (laws.farm.phases); got "${cliArg('phase', '')}"`);
    process.exit(2);
  }
  const FROM = cliArg('from', 'plan');
  if (!STAGES.includes(FROM)) { console.error(`--from must be one of ${STAGES.join(', ')}`); process.exit(2); }
  const active = (s) => STAGES.indexOf(s) >= STAGES.indexOf(FROM);
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(plan.days?.[DAY])) throw new Error(`${file} has no day ${DAY}`);
  const grid = plan.grid || {};

  // The folder: --dir, else where the day's rows say their specs live, else the batch convention.
  let dir = cliArg('dir', null);
  if (!dir) {
    const dirs = [...new Set(plan.days[DAY].filter((r) => r.spec).map((r) => dirname(r.spec)))];
    if (dirs.length > 1) throw new Error(`the day's rows point at ${dirs.length} folders (${dirs.join(', ')}) — pass --dir`);
    dir = dirs[0] || join('queues', 'batch', String(plan.batch || '').replace(/^R/, ''), DAY);
  }
  const absDir = resolve(HERE_DIR, dir);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) throw new Error(`no spec folder at ${dir} — pass --dir`);
  const relDir = relative(HERE_DIR, absDir);
  const specs = readdirSync(absDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, spec: JSON.parse(readFileSync(join(absDir, f), 'utf8')) })).filter((s) => s.spec?.account && Array.isArray(s.spec?.tweets));
  console.log(`${plan.batch || file} · ${DAY} · ${relDir} · ${specs.length} spec(s)${DRY ? ' · DRY — nothing is written' : ''}${FROM !== 'plan' ? ` · from ${FROM}` : ''}`);

  // ── plan ──────────────────────────────────────────────────────────────────────────────────────
  hr('plan');
  const { pairs, held, rowsWithoutSpec, specsWithoutRow } = reconcile(plan.days[DAY], specs);
  for (const p of pairs) console.log(`   ${p.key.padEnd(9)} ${p.bucket.padEnd(5)} ${p.file.padEnd(22)} ${p.row.draftId ? `shipped as ${p.row.draftId}` : `at ${grid[p.key] || '--:--'}Z`}`);
  for (const r of held) console.log(`   ⏸ ${r.account.padEnd(9)} ${r.bucket.padEnd(5)} HELD — reserved, awaiting a filling; the day ships without it`);
  for (const r of rowsWithoutSpec) console.log(`   ✗ ${r.account.padEnd(9)} ${r.bucket.padEnd(5)} NO SPEC in ${relDir}`);
  for (const s of specsWithoutRow) console.log(`   ✗ ${s.key.padEnd(9)} ${s.bucket.padEnd(5)} ${s.file.padEnd(22)} NOT IN THE PLAN for ${DAY}`);
  const pc = checkPlan(plan, { phase: PHASE });
  for (const w of pc.warnings) console.log(`   · ${w}`);
  for (const e of pc.errors) console.log(`   ✗ plan-check: ${e}`);
  if (rowsWithoutSpec.length || specsWithoutRow.length || pc.errors.length) {
    console.log(`\n✗ plan and folder disagree — fix the plan (or move the spec) before anything ships`);
    process.exitCode = 1; return;
  }
  const unshipped = pairs.filter((p) => !p.row.draftId);
  // WRITE GUARD (R1, 2026-09-23). With --run-dir, a thread is written only at the minute stop 5
  // approved: its plan row names its slot, carries `at`, and run-studio's approved schedule row (the
  // owner's, or inherited from the brief for an unchanged slot) says the same page and minute.
  // run-studio is a review ledger, not a lock; this is where the ledger is read before a write.
  const RUN_DIR = cliArg('run-dir', null);
  // A /run plan row (it names a slot or carries an approved minute) never ships unguarded: without
  // --run-dir, row.at would still override the grid with no check that the owner approved it.
  const slotted = unshipped.filter((p) => p.row.slotId || p.row.at);
  if (!RUN_DIR && slotted.length) {
    console.log(`\n✗ SLOT_NOT_APPROVED — ${slotted.length} row(s) carry a /run slot or time; re-run with --run-dir RUN_DIR so stop 5's approval is checked before anything ships`);
    process.exitCode = 1; return;
  }
  if (RUN_DIR) {
    const guard = slotWriteGuard(unshipped.map((p) => p.row), resolve(RUN_DIR));
    for (const g of guard) console.log(`   ${g.ok ? '✓' : '✗ HOLD SLOT_NOT_APPROVED'} ${String(g.account).padEnd(9)} ${g.slotId || '(no slot)'} ${g.at || '--'}${g.ok ? (g.inherited === 'brief' ? ' · approved at the brief' : ' · approved at stop 5') : ` — ${g.reason}`}`);
    if (guard.some((g) => !g.ok)) {
      console.log(`\n✗ SLOT_NOT_APPROVED — ${guard.filter((g) => !g.ok).length} row(s) are not at an approved minute; nothing ships until stop 5 approves them`);
      process.exitCode = 1; return;
    }
  }
  console.log(`   ✓ ${pairs.length} spec(s) matched · ${unshipped.length} to ship · ${pairs.length - unshipped.length} already shipped${held.length ? ` · ${held.length} reserved slot(s) held` : ''}${pc.summary?.calendar?.length ? ` · ${pc.summary.calendar.join(' · ')}` : ''}`);

  // ── lint (advisory) ───────────────────────────────────────────────────────────────────────────
  if (active('lint')) {
    hr('lint (advisory — gate-thread is the referee)');
    const r = run('lint-cover.mjs', [absDir, '--quiet']);
    show(r.out.split(absDir + '/').join(''));
  }

  // ── hooks ─────────────────────────────────────────────────────────────────────────────────────
  if (active('hooks')) {
    hr('hooks');
    const r = run('hooks-check.mjs', ['--dir', absDir]);
    show(r.out);
    if (r.code) { console.log(`\n✗ hooks — rewrite the failing hook(s), then: --from hooks`); process.exitCode = 1; return; }
  }

  // ── gate ──────────────────────────────────────────────────────────────────────────────────────
  if (active('gate')) {
    hr(`gate (${unshipped.length} unshipped spec(s))`);
    let bad = 0;
    for (const p of unshipped) {
      const r = run('gate-thread.mjs', ['--file', join(absDir, p.file), '--json-out']);
      const g = gateLines(p, r);
      for (const l of g.lines) console.log(l);
      if (!g.ok) bad++;
    }
    if (bad) { console.log(`\n✗ gate — ${bad} spec(s) refused; fix them, then: --from gate`); process.exitCode = 1; return; }
    if (!unshipped.length) console.log('   nothing to gate — every spec already shipped');
  }

  // ── mint ──────────────────────────────────────────────────────────────────────────────────────
  if (active('mint')) {
    hr(`mint${DRY ? ' (dry)' : ''}`);
    const r = run('batch-mint.mjs', [absDir, ...(DRY ? ['--dry'] : [])]);
    show(r.out);
    if (r.code) { console.log(`\n✗ mint — some spec(s) still carry tokens; fix, then: --from mint`); process.exitCode = 1; return; }
  }

  // ── publish ───────────────────────────────────────────────────────────────────────────────────
  let shippedNow = [];
  if (active('publish')) {
    hr(`publish${DRY ? ' (dry — validate only)' : ''}`);
    const result = await publishBatch({ dir: absDir, grid: gridFromPlan(plan), runPlan: plan, day: DAY, dry: DRY,
      onRow: row => {
        recordBatchOutcome(plan, row);
        writeBatchPlan(file, plan); // Preserve started/unknown and confirmed-partial outcomes immediately.
      } });
    const shipped = result.rows.filter(row => row.draftId);
    shippedNow = shipped;
    const failed = result.rows.filter(row => !row.skip && !row.ok);
    if (!result.ok) {
      if (shipped.length && !DRY) stamp(plan, DAY, shipped, pairs, grid, relDir, file, PHASE);
      console.log(`\n✗ publish — ${failed.length} failed or held; ${shipped.length} confirmed drafts recorded. Reconcile unknown outcomes before resuming.`);
      process.exitCode = 1; return;
    }
  }

  // ── stamp ─────────────────────────────────────────────────────────────────────────────────────
  if (active('stamp')) {
    hr(`stamp${DRY ? ' (dry)' : ''}`);
    // A resume (--from stamp) has no publish output: the records know what shipped for these specs.
    const toStamp = shippedNow.length ? shippedNow : latestRecordsFor(unshipped, DAY, plan.batch);
    if (!toStamp.length) console.log('   nothing new to stamp');
    else if (DRY) for (const s of toStamp) console.log(`   would stamp ${s.key} ← draft ${s.draftId}`);
    else stamp(plan, DAY, toStamp, pairs, grid, relDir, file, PHASE);
  }

  // ── verify ────────────────────────────────────────────────────────────────────────────────────
  let dirty = false;
  if (active('verify')) {
    hr('verify');
    const r = run('verify-day.mjs', [DAY, '--json']);
    let v = null; try { v = JSON.parse(r.out.split('\n').filter((l) => !l.startsWith('[roster]')).join('\n')); } catch { /* not json */ }
    if (!v) { show(r.out); console.log('   ⚠ verify-day returned no JSON'); }
    else {
      dirty = !!v.dirty;
      const flagged = v.rows.filter((x) => x.notes.some((n) => n.startsWith('**')));
      console.log(`   ${v.posts} post(s) on ${DAY} Saigon · ${v.accountsPosting}/${v.accountsTotal} pages posting · ${v.twice.length ? `TWICE: ${v.twice.map((t) => `${t.account} x${t.posts}`).join(', ')}` : 'none twice'}${v.minuteClash.length ? ` · MINUTE CLASH ${v.minuteClash.join(', ')}` : ''}`);
      for (const x of flagged) console.log(`   ✗ ${x.saigon} ${x.utc}Z ${x.account.padEnd(16)} ${x.id}  ${x.notes.join(' ')}`);
      for (const m of v.minuteClash) for (const x of v.rows.filter((r) => r.utc === m)) console.log(`   ✗ clash ${x.utc}Z ${x.account.padEnd(16)} ${x.id}  ${x.single ? 'single' : x.warmup ? 'warm-up' : 'thread'}${x.live ? ' (live)' : ''}`);
      for (const t of v.twice) for (const x of v.rows.filter((r) => r.account === t.account && !r.single && !r.warmup)) console.log(`   ✗ twice ${x.utc}Z ${x.account.padEnd(16)} ${x.id}  thread${x.live ? ' (live)' : ''}`);
      console.log(dirty ? '   ✗ day needs attention (see above) — continuing; fix and re-run verify-day' : '   ✓ day is clean');
    }
  }

  // ── links ─────────────────────────────────────────────────────────────────────────────────────
  // check-links on every draft the day has stamped. A link can pass every text gate and still send
  // the reader to the wrong product: Run 4, lorenzo 10746935, batch-mint reused a Sep-6 link on an
  // identical subid and the collagen plug sold B12. The audit that caught it was run by hand on all
  // 22 drafts; here it is a stage, so a wrong bottle fails the ship instead of waiting for eyes.
  // Attempts stamped later re-enter through --from links. Read-only: it resolves, never edits.
  if (active('links')) {
    hr('links');
    const fresh = JSON.parse(readFileSync(file, 'utf8'));
    const stamped = (fresh.days[DAY] || []).filter((r) => r.draftId);
    if (!stamped.length) console.log('   nothing stamped yet — runs after publish + stamp, or --from links once the attempts are in');
    let broken = 0;
    for (const row of stamped) {
      const r = run('check-links.mjs', ['--draft', String(row.draftId)]);
      const clean = (r.out.match(/\d+\/\d+ clean/) || [])[0] || (/no tracked links/.test(r.out) ? 'no tracked links' : 'unreadable');
      const bad = r.code !== 0 || clean === 'unreadable';
      if (bad) broken++;
      console.log(`   ${bad ? '✗' : '✓'} ${String(row.account).padEnd(9)} ${row.bucket.padEnd(7)} draft ${row.draftId}  ${clean}`);
      if (bad) show(r.out.split('\n').filter((l) => /✗|!/.test(l)).join('\n'), '        ');
    }
    if (stamped.length) console.log(broken ? `   ✗ ${broken} draft(s) carry a link that does not sell what the ledger says — fix before post time (mint-link + fix-draft), then --from links` : `   ✓ ${stamped.length} draft(s), every tracked link resolves to its ledger product`);
    if (broken) dirty = true;
    // NOTES (plan R2) — REPORT-ONLY: each stamped draft's note should carry a source line and every
    // ASIN the ledger row sells. A missing note is a line on the receipt, never a failed day.
    if (stamped.length) {
      let tf = null;
      try { tf = typefully(loadEnv()); } catch (e) { console.log(`   · notes not checked (unverified): ${e.message}`); }
      for (const row of tf ? stamped : []) {
        const acc = ACCOUNTS[resolveAccountKey(row.account)];
        let draft = null;
        try { draft = acc?.socialSetId ? await tf.getDraft(acc.socialSetId, String(row.draftId)) : null; } catch { /* reported below */ }
        let asins = [];
        try { asins = (JSON.parse(readFileSync(join(HERE_DIR, row.spec), 'utf8')).products || []).map((p) => p?.asin).filter(Boolean); } catch { /* checked without ASINs */ }
        const c = draft ? noteCheck(draft.scratchpad_text, { asins }) : null;
        const legacy = draft && !c.ok && /^\s*link:\s+https:\/\/x\.com\//m.test(String(draft.scratchpad_text || ''));
        console.log(`   · note ${String(row.account).padEnd(9)} draft ${row.draftId}  ${!draft ? 'unread (unverified)' : c.ok ? 'source note ✓' : legacy ? 'record note (no /run source note)' : `missing ${c.missing.join(', ')}`}`);
      }
    }
  }

  // ── pots ──────────────────────────────────────────────────────────────────────────────────────
  if (active('pots') && !process.argv.includes('--skip-pots')) {
    hr(`pots${DRY ? ' (dry)' : ''}`);
    const potRows = plan.days[DAY].filter((r) => r.bucket === 'pot' && r.draftId);
    const potPairs = pairs.filter((p) => p.bucket === 'pot' && potRows.some((r) => r.account === p.key));
    if (!potPairs.length) console.log('   no shipped pots today');
    else await flipPots(potPairs, plan.days[DAY], { dry: DRY });
  }

  // ── manifest ──────────────────────────────────────────────────────────────────────────────────
  if (active('manifest')) {
    hr(`manifest${DRY || process.argv.includes('--no-telegram') ? ' (print only)' : ''}`);
    const fresh = JSON.parse(readFileSync(file, 'utf8'));
    const text = renderManifest({ plan: fresh, day: DAY, ...loadInputs(fresh, DAY), notes: dirty ? ['verify-day reported the day dirty at ship time — see the run log'] : [] });
    show(text);
    if (!DRY) { writeFileSync(join(absDir, 'manifest.txt'), text + '\n'); console.log(`   written: ${join(relDir, 'manifest.txt')}`); }
    if (!DRY && !process.argv.includes('--no-telegram')) { await telegram(loadEnv(), text, 'ops'); console.log('   sent to ops'); }
  }

  console.log(`\n${dirty ? '✗' : '✓'} ${DAY} ${DRY ? 'rehearsed' : 'shipped'}${dirty ? ' — verify-day or check-links flagged the day' : ''}`);
  if (dirty) process.exitCode = 1;
}

/** Write draftId / shareUrl / slot / spec into the day's rows and save the plan.
 *
 *  `phase` is PASSED IN, not defaulted. It used to be a literal 2 here while the pre-flight check at
 *  the top of the run read --phase, so the two checks could disagree: a run shipped under --phase 4
 *  had its plan validated against phase 4 before publishing and against phase 2 after stamping, and
 *  the post-stamp line would report breaches that were not breaches (or, worse, stay silent about
 *  ones that were). One run, one phase value. */
function stamp(plan, day, shipped, pairs, grid, relDir, file, phase) {
  let n = 0;
  for (const s of shipped) {
    const matches = x => x.key === s.key && (!s.bucket || x.bucket === s.bucket);
    const p = pairs.find(x => matches(x) && !x.row.draftId) || pairs.find(matches);
    if (!p) { console.log(`   ⚠ ${s.key}: shipped draft ${s.draftId} has no plan row to stamp`); continue; }
    const rec = recordFor(s.draftId);
    const i = plan.days[day].indexOf(p.row);
    const slot = s.at ? String(s.at).slice(11, 16) + 'Z' : (grid[s.key] ? `${grid[s.key]}Z` : null);
    const next = stampRow(p.row, { draftId: s.draftId, shareUrl: rec?.thread?.shareUrl || s.shareUrl || null, slot, spec: join(relDir, p.file) });
    plan.days[day][i] = next; p.row = next; n++;
    console.log(`   ✓ ${s.key.padEnd(9)} ${p.bucket.padEnd(5)} draft ${s.draftId} ${next.shareUrl || '(no record yet — share url missing)'}`);
  }
  if (!n) return;
  writeBatchPlan(file, plan);
  const pc = checkPlan(plan, { phase });
  console.log(`   plan written: ${n} row(s) stamped${pc.errors.length ? ` · ⚠ plan-check now reports ${pc.errors.length} breach(es): ${pc.errors[0]}` : ' · plan-check ✓'}`);
}

/** For a resume without publish output: the newest record whose spec is this spec (same page,
 *  bucket, batch and day). */
function latestRecordsFor(pairs, day, batch) {
  if (!existsSync(RECORDS_DIR)) return [];
  const recs = readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(RECORDS_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
  const out = [];
  for (const p of pairs) {
    const hit = recs.filter((r) => resolveAccountKey(r.spec?.account) === p.key && bucketOf(r.spec || {}) === p.bucket
      && (!batch || r.spec?.batch === batch) && (!r.spec?.day || r.spec.day === day) && r.thread?.draftId)
      .sort((a, b) => String(b.thread.createdAt).localeCompare(String(a.thread.createdAt)))[0];
    if (hit) out.push({ key: p.key, draftId: hit.thread.draftId, shareUrl: hit.thread.shareUrl, at: null });
  }
  return out;
}

/** Each shipped pot: Pots row → Planted, `planted` tag on its greenhouse draft. Idempotent.
 *  A spec names its greenhouse draft either by share url (https://typefully.com/t/…) or by draft id;
 *  the Pots row carries the share url. Both are resolved to the draft and compared before a write. */
async function flipPots(potPairs, rows, { dry }) {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'TYPEFULLY_API_KEY']);
  const at = airtable(env, env.REGISTRY_BASE_ID), tf = typefully(env);
  const burner = ACCOUNTS.burner?.socialSetId;
  const norm = (u) => String(u || '').trim().replace(/\/$/, '');
  let greenhouse = null; // share_url -> draft summary, listed once
  const byUrl = async (url) => {
    if (!greenhouse) {
      greenhouse = new Map();
      for (const st of ['draft', 'scheduled', 'published']) for (let o = 0; ; o += 50) {
        const j = await tf.get(`/social-sets/${burner}/drafts?status=${st}&limit=50&offset=${o}`);
        for (const d of (j.results || [])) if (d.share_url) greenhouse.set(norm(d.share_url), d);
        if (!j.next || !(j.results || []).length) break;
      }
    }
    return greenhouse.get(norm(url)) || null;
  };
  const resolveGreenhouse = async (ref) => {
    if (!burner || !ref) return null;
    if (/^\d+$/.test(String(ref))) { try { return await tf.getDraft(burner, String(ref)); } catch { return null; } }
    return byUrl(ref);
  };
  for (const p of potPairs) {
    const row = rows.find((r) => r.account === p.key && r.bucket === 'pot');
    const potRecId = p.spec.potRecId;
    if (!potRecId) { console.log(`   ⚠ ${p.key}: spec has no potRecId — flip the Pots row by hand`); continue; }
    let pot; try { pot = await at.getRecord('Pots', potRecId); } catch (e) { console.log(`   ✗ ${p.key}: Pots ${potRecId} — ${e.message}`); continue; }
    const f = pot.fields || {};
    const ref = p.spec.greenhouseDraft || null;
    const d = await resolveGreenhouse(ref);
    if (ref && !d) { console.log(`   ✗ ${p.key}: greenhouse draft ${ref} not found on the burner set — not touched`); continue; }
    const rowUrl = norm(f['Greenhouse Draft']);
    if (d && rowUrl && norm(d.share_url) !== rowUrl) { console.log(`   ✗ ${p.key}: Pots "${f.Name}" links ${rowUrl}, the spec's greenhouse draft ${d.id} is ${norm(d.share_url)} — not touched`); continue; }
    const status = f.Status === 'Planted' ? 'already Planted' : dry ? `would set Planted (now ${f.Status || '—'})` : null;
    if (!status) await at.update('Pots', [{ id: potRecId, fields: { Status: 'Planted' } }]);
    let tag = 'no greenhouse draft on the spec';
    if (d) {
      const tags = Array.isArray(d.tags) ? d.tags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean) : [];
      if (tags.includes('planted')) tag = `tag already on ${d.id}`;
      else if (dry) tag = `would tag ${d.id} planted`;
      else { await tf.patchDraft(burner, d.id, { tags: [...tags, 'planted'] }); tag = `tagged ${d.id} planted`; }
    }
    console.log(`   ${status?.startsWith('would') || tag.startsWith('would') ? '·' : '✓'} ${p.key.padEnd(9)} ${String(f.Name || potRecId).padEnd(24)} draft ${row?.draftId || '?'} · ${status || 'Status → Planted'} · ${tag}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'ship-day');
