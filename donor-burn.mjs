// donor-burn.mjs — which donors we have already covered, and how recently.
//
// OFF BY DEFAULT SINCE 2026-09-28 (owner: "remove the burn screen rule — so that's why I don't see many
// of the recent viral posts"). pick-donors.mjs and scripts/run-intake.mjs pass 0 for all three clocks
// unless a run asks for a reuse limit; this file stays for that case and for the ledger report below.
//
// WHY THIS EXISTS (operator, 2026-09-17: "I want a higher variety of freshness in our Cover section.
// I have seen too many of the same origin source over the last few runs").
//
// The machinery to prevent that was already there and already dead. Four pool queries — pick-donors,
// preflight, plan-week, and plan-parity's fulfilment check — filter on `NOT({Drafted})`, a swipe-DB
// checkbox whose whole job is to retire a covered donor. Nothing in this repository writes it. The
// n8n engine lanes did, and those lanes were retired when /run replaced them (plan-week.mjs:98 still
// records the handover). So the filter has passed every donor ever since.
//
// THE LEDGER IS THE RECORD, AND THE FIRST VERSION OF THIS FILE GOT THAT WRONG (operator, same day:
// "That old donor was used by us COUNTLESS times tbh. you just didn't find it properly."). It read
// only `queues/run-*.json` — five files, 2026-09-04 onward — and reported a donor published on Kim
// on 08-28 as never covered. Measured after the correction:
//
//   donors visible in run-*.json            104
//   donors the LEDGER records as published  350
//   blind to                                257, or 73% of the real history
//
// Five of the fifteen donors picked for Run 5 under the broken screen had in fact been published
// before, one of them on five different pages. The run plans only ever described the /run era; the
// retired lanes wrote queues/week-plan-*.json, and neither file type is the authority. The LEDGER is:
// every published thread writes a row carrying `recId`, whatever lane produced it, so it is the one
// source that cannot go stale when a lane is retired.
//
// The plans are still read, because they carry something the ledger does not — the RUN a donor
// belonged to, which is what the run-window rule below counts. A donor that is in a plan but not yet
// in the ledger is scheduled and unpublished, and that still burns it for the next run.
//
// A USE COUNT, NOT A BAN (operator 2026-09-17: "it is allowed to reuse them again ... If they have
// been used less than 4 times, we can use them again. It's fine."). The first corrected version
// burned on `burnDays: 120` against a 94-day archive, so every donor we had ever published was out.
// That is not freshness, it is amnesia: it threw away the one set of shapes we have direct evidence
// worked, and the farm is bottlenecked on harvest precisely because too few proven covers reach it.
//
// Measured on the ledger the day the rule changed, 350 distinct donors published:
//
//   1x 182 · 2x 54 · 3x 40   -> 276 donors RETURN under the <4 rule
//   4x 18 · 5x 28 · 6x+ 28   ->  74 stay out, the worst at 24 publishes across 6 pages
//
// THREE CLOCKS, ANY OF WHICH BURNS IT. `maxUses` is the operator's rule and the one that decides.
// `burnDays` is now only a COOLING guard — a donor published last week is spent whatever its count —
// so it is short by design. `window` reads the run plans and catches what the ledger cannot yet: a
// donor allocated to a plan that has not shipped.
//
// WHAT THIS STILL CANNOT SEE (operator, rejecting a donor every screen passed): niche SATURATION. A
// shape can be everywhere in the category and read as fresh here, because this only knows what WE
// ran. No file in this repository knows what the rest of the niche is doing, so the donor table goes
// to the operator before a run and their eye is the last screen.
//
// PURE, EXCEPT FOR THE READS. Everything below takes rows as data so the rules are testable.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isThreadRow } from './monitoring-scope.mjs';

/** Run plan filenames, oldest first. The date in the name IS the run order. */
export const runPlanFiles = (dir) =>
  readdirSync(dir).filter((f) => /^run-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

/**
 * PURE. Donor -> burn record, given plans oldest-first as [{ run, days }].
 *
 * `runsAgo` is 0 for the most recent run in the list, 1 for the one before it, and so on, counted on
 * the donor's LAST use. That is the number the exclusion window reads, because what matters is how
 * long ago a reader could have seen this shape, not how many times in total.
 */
export function burnLedger(plans) {
  const out = new Map();
  const total = plans.length;
  plans.forEach((plan, i) => {
    const runsAgo = total - 1 - i;
    for (const rows of Object.values(plan?.days || {})) {
      for (const r of rows || []) {
        if (!r?.donor) continue;
        const prev = out.get(r.donor);
        // Rows within one run count separately, but the run only sets `runsAgo` once — a donor used
        // twice in one run is not "more recent" than one used once in it.
        out.set(r.donor, {
          count: (prev?.count || 0) + 1,
          runs: prev && prev.lastRun === plan.run ? prev.runs : (prev?.runs || 0) + 1,
          lastRun: plan.run,
          runsAgo,
        });
      }
    }
  });
  return out;
}

/**
 * PURE. Donor -> publish record, from ledger rows. `mode: "monetized"` is a published thread; a
 * `mint` row only means a link was cut, which happens for drafts that never shipped, so it is
 * counted separately and never on its own treated as a cover.
 */
export function publishLedger(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r?.recId) continue;
    const e = out.get(r.recId) || { publishes: 0, mints: 0, accounts: new Set(), lastPublished: null, days: [] };
    if (r.mode === 'monetized') {
      e.publishes += 1;
      if (r.account) e.accounts.add(r.account);
      const day = String(r.ts || '').slice(0, 10);
      if (day) e.days.push(day);
      if (day && (!e.lastPublished || day > e.lastPublished)) e.lastPublished = day;
    } else if (r.mode === 'mint') e.mints += 1;
    out.set(r.recId, e);
  }
  return out;
}

/** Parse ledger.jsonl, skipping unparseable lines rather than throwing on one bad row. */
export function readLedgerRows(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a truncated tail line is not a reason to fail */ }
  }
  return rows;
}

/**
 * PURE. Merge the run-plan view (which knows RUNS) with the ledger view (which knows PUBLISHES and
 * DATES) into the one record every caller reads.
 */
export function mergeBurn(plans, published) {
  const out = new Map(plans);
  for (const [id, p] of published) {
    const e = out.get(id) || { count: 0, runs: 0, lastRun: null, runsAgo: Infinity };
    out.set(id, { ...e, publishes: p.publishes, mints: p.mints,
      accounts: [...p.accounts], lastPublished: p.lastPublished, days: [...(p.days || [])].sort() });
  }
  for (const [, e] of out) { e.publishes ??= 0; e.mints ??= 0; e.accounts ??= []; e.lastPublished ??= null; e.days ??= []; }
  return out;
}

/**
 * Read BOTH sources off disk: the run plans in `dir`, and the ledger beside them.
 *
 * `exclude` drops one run from the plan side, and screening a run against itself is exactly why it
 * exists. The plan being built lives in the same folder as its predecessors, so without this every
 * donor in it comes back "allocated 0 runs ago" — which is true, trivially, and tells you nothing.
 * Pass the batch being planned (or its filename date) whenever you are choosing donors FOR that run.
 */
export function loadBurnLedger(dir, { ledger = join(dir, '..', 'ledger.jsonl'), exclude = null } = {}) {
  const skip = new Set([exclude].filter(Boolean).map(String));
  const plans = burnLedger(runPlanFiles(dir)
    .filter((f) => !skip.has(f) && !skip.has(f.slice(4, 14)))
    .map((f) => {
      const plan = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { run: plan.batch || f.slice(4, 14), days: plan.days || {} };
    })
    .filter((p) => !skip.has(p.run)));
  let published = new Map();
  try { published = publishLedger(readLedgerRows(ledger)); }
  catch { /* no ledger reachable: fall back to plans alone, and say so at the call site */ }
  return mergeBurn(plans, published);
}

/** Whole days between two YYYY-MM-DD strings. */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * PURE. Is this donor spent for the run being planned?
 *
 * TWO CLOCKS, EITHER OF WHICH BURNS IT.
 *
 * `burnDays` reads the LEDGER: a donor we actually published inside that many days is out, whatever
 * lane shipped it. This is the one that matters, because it is the only view that survives a lane
 * being retired — and it is the check whose absence let five already-published donors into Run 5.
 *
 * `window` reads the RUN PLANS and is counted in runs, not days, because fleet exposure is per run:
 * two runs a week makes four runs a fortnight. It catches what the ledger cannot yet — a donor
 * allocated to a plan that has not shipped.
 *
 * Outside both, a donor returns, ranked DOWN rather than level (see `freshnessFactor`). The swipe
 * file is finite and a permanent ban eventually starves the lane, which is the failure the vault arm
 * exists to avoid. `window: 0, burnDays: 0` disables the screen.
 */
export function isBurned(recId, ledger, { window = 4, burnDays = 30, maxUses = 4, today = null } = {}) {
  const b = ledger.get(recId);
  if (!b) return false;
  // THE OPERATOR'S RULE, and the one that decides. Exposure counts PUBLISHES, not plan rows: a
  // donor allocated twice in one run has been seen once per page that actually shipped it.
  if (maxUses > 0 && (b.publishes || 0) >= maxUses) return true;
  if (window > 0 && b.runsAgo < window) return true;
  if (burnDays > 0 && b.lastPublished) {
    const now = today || new Date().toISOString().slice(0, 10);
    if (daysBetween(b.lastPublished, now) <= burnDays) return true;
  }
  return false;
}

/**
 * PURE. The owner's reuse rule (2026-09-28, laws.json selection.reuse), which replaced the burn screen:
 * "if we have covered more than 3 times in the last 30 days, then we can drop it, but that only applies
 * if the score is not high enough", where the score is "our covers did over 200K view once".
 *
 * `record` is this donor's merged burn record (its `days` are the ledger's monetized rows, so a cover
 * scheduled but not yet posted counts). `best` is the most impressions any of our posts from this donor
 * reached (the registry's Published Content), or null when that read failed: an unknown is never taken
 * as "not a winner", so the rule then drops nothing. Returns { covers, best, winner, spent }.
 */
export function reuseVerdict(record, { coversMax = 3, days = 30, winnerViews = 200000, best = null, today = null } = {}) {
  const now = today || new Date().toISOString().slice(0, 10);
  // A cover scheduled after `today` is inside the window too: it is already committed to a reader.
  const covers = (record?.days || []).filter((d) => daysBetween(d, now) <= days).length;
  const known = Number.isFinite(best);
  const winner = known && best >= winnerViews;
  return { covers, best: known ? best : null, winner, spent: known && !winner && covers > coversMax };
}

/**
 * PURE. The `best` reuseVerdict reads, for every donor at once: tweet id -> the most impressions any of
 * our covers of it reached, from Published Content records (Type, Source Thread, Impressions). THREADS
 * ONLY: the rule is about our covers, and a native X Article (owner, R2026-10-03: articles are additive)
 * carries the article it replicated as its Source Thread, so its views never make a donor a winner.
 */
export function coverBestViews(records) {
  const best = new Map();
  for (const r of records || []) {
    if (!isThreadRow(r)) continue;
    const id = (String(r.fields?.['Source Thread'] || '').match(/status\/(\d+)/) || [])[1];
    if (id) best.set(id, Math.max(best.get(id) || 0, Number(r.fields?.Impressions) || 0));
  }
  return best;
}

/**
 * PURE. A rank multiplier in (0, 1] expressing how tired a donor is.
 *
 * Never touched -> 1. Otherwise it falls with each RUN that carried it and each PAGE that published
 * it, because a donor run once on five pages is five times as worn to a reader as one run once on
 * one — and the first version of this file could not see the pages at all.
 *
 * 1/(1+n) RATHER THAN 1/2^n, changed with the <4 rule. Halving hit the 0.25 floor at two uses, so
 * once reuse became legal the three legal counts — once, twice, three times — all scored identically
 * and the ranking could not tell a donor used once from one used three times. That flat spot is
 * exactly where the operator wants the grading: "keep some of the ones that have been used before".
 * 1/(1+n) gives 0.50 · 0.33 · 0.25 across the legal range, monotonic, and still floored so an
 * excellent old donor is outranked rather than erased.
 */
export function freshnessFactor(recId, ledger, { floor = 0.25 } = {}) {
  const b = ledger.get(recId);
  if (!b) return 1;
  const exposure = (b.runs || 0) + (b.publishes || 0);
  if (!exposure) return 1;
  return Math.max(floor, 1 / (1 + exposure));
}

/** PURE. Split a shortlist into what may ship and what is spent, with the reason for each. */
export function screenForFreshness(recIds, ledger, opts = {}) {
  const fresh = [], burned = [];
  for (const id of recIds) {
    if (!isBurned(id, ledger, opts)) { fresh.push(id); continue; }
    const b = ledger.get(id);
    const cap = opts.maxUses ?? 4;
    const why = (cap > 0 && b.publishes >= cap)
      ? `spent: published ${b.publishes}x${b.accounts.length ? ` on ${b.accounts.join(', ')}` : ''}, over the ${cap}-use cap`
      : b.publishes
        ? `too soon: published ${b.publishes}x${b.accounts.length ? ` on ${b.accounts.join(', ')}` : ''}, last ${b.lastPublished}`
        : `allocated in ${b.lastRun}, ${b.runsAgo} run(s) ago`;
    burned.push({ recId: id, ...b, why });
  }
  return { fresh, burned };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dir = join(process.cwd(), 'queues');
  const ledger = loadBurnLedger(dir);
  const arg = (k, d) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1]);
  const window = arg('window', 4), burnDays = arg('burn-days', 30), maxUses = arg('max-uses', 4);
  const rows = [...ledger.entries()].sort((a, b) => (b[1].publishes - a[1].publishes) || (b[1].count - a[1].count));
  const published = rows.filter(([, b]) => b.publishes > 0).length;
  console.log(`DONOR BURN — ${runPlanFiles(dir).length} run plan(s) + ledger · ${ledger.size} donor(s) touched · ${published} PUBLISHED · window ${window} run(s), ${burnDays}d\n`);
  console.log('  pub  runs  pages  last-published  recId');
  for (const [id, b] of rows.slice(0, 25)) {
    console.log(`  ${String(b.publishes).padStart(3)}  ${String(b.runs).padStart(4)}  ${String(b.accounts.length).padStart(5)}  ${String(b.lastPublished || '-').padEnd(14)}  ${id}${isBurned(id, ledger, { window, burnDays, maxUses }) ? '  ⛔' : ''}`);
  }
  const blocked = rows.filter(([id]) => isBurned(id, ledger, { window, burnDays, maxUses })).length;
  console.log(`\n${blocked} donor(s) blocked; ${ledger.size - blocked} may return, ranked down.`);
}
