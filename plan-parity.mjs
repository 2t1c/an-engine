// plan-parity.mjs — engine v2, part D STEP 2: the read-only comparator for the parity week.
//
// While the OLD engines keep shipping, this joins the reviewed week plan against what actually
// shipped (ledger rows in the plan's window) and answers the operator's cutover question:
// "would the planner's slate have been at least as good, and could it even have been fulfilled?"
//   - overlap: sources BOTH systems chose (agreement is a good sign, not a requirement)
//   - fulfillment: planned cover sources that are already Drafted in the swipe DB by the time you
//     look (the old engines eat the same pool — a plan slot that got eaten would have FAILED)
//   - volume: 63 planned slots vs threads the old engines actually shipped that week
// READ-ONLY: prints a report, writes nothing, changes nothing.
//
//   node plan-parity.mjs                 # latest queues/week-plan-*.json vs the ledger
//   node plan-parity.mjs --week 2026-08-24
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { TABLES } from './config.mjs';
import { latestPlanFile } from './plan-publish.mjs';
import { sameLane } from './lanes.mjs';

// Pure core: plan JSON + ledger rows -> per-account parity + fleet summary. Ledger rows outside
// the plan's 7-day window are ignored here so callers can pass the whole file unfiltered.
export function comparePlanToShipped(plan, ledgerRows) {
  const w0 = Date.parse(`${plan.week}T00:00:00Z`);
  const w1 = w0 + 7 * 864e5;
  const inWeek = (ledgerRows || []).filter((r) => {
    const t = Date.parse(r.ts || '');
    return Number.isFinite(t) && t >= w0 && t < w1 && r.account && r.draftId;
  });
  const shippedBy = new Map();
  for (const r of inWeek) {
    const a = shippedBy.get(r.account) || { recIds: new Set(), days: new Set(), rows: 0 };
    if (r.recId) a.recIds.add(r.recId);
    a.days.add(String(r.ts).slice(0, 10));
    a.rows++;
    shippedBy.set(r.account, a);
  }
  const byAccount = (plan.accounts || []).map((acc) => {
    const viral = acc.slots.filter((s) => sameLane(s.lane, 'cover'));
    const s = shippedBy.get(acc.account) || { recIds: new Set(), days: new Set(), rows: 0 };
    const overlap = viral.filter((v) => s.recIds.has(v.recId)).map((v) => v.recId);
    return {
      account: acc.account,
      plannedSlots: acc.slots.length,
      plannedViral: viral.map((v) => v.recId),
      shippedThreads: s.rows,
      shippedDays: s.days.size,
      overlap,
    };
  });
  return {
    week: plan.week,
    byAccount,
    planned: byAccount.reduce((n, a) => n + a.plannedSlots, 0),
    shipped: inWeek.length,
    overlapTotal: byAccount.reduce((n, a) => n + a.overlap.length, 0),
  };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const at = airtable(env);

  const wi = process.argv.indexOf('--week');
  const file = wi > 0 ? `week-plan-${process.argv[wi + 1]}.json` : latestPlanFile(readdirSync(join(HERE_DIR, 'queues')));
  if (!file) throw new Error('no queues/week-plan-*.json found');
  const plan = JSON.parse(readFileSync(join(HERE_DIR, 'queues', file), 'utf8'));

  const ledger = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const cmp = comparePlanToShipped(plan, ledger);

  // Fulfillment: would the plan's viral slots still be available? The old engines draft from the
  // same swipe pool, so anything they (or a hand run) took is a slot the plan could not have filled.
  const plannedRecIds = [...new Set(cmp.byAccount.flatMap((a) => a.plannedViral))];
  const eaten = [];
  for (const recId of plannedRecIds) {
    try {
      const rec = await at.getRecord(TABLES.swipe, recId);
      if (rec?.fields?.Drafted) eaten.push({ recId, hook: (rec.fields.Text || '').split('\n')[0].slice(0, 60) });
    } catch { eaten.push({ recId, hook: '(record fetch failed)' }); }
  }

  console.log(`PARITY ${cmp.week} — plan ${cmp.planned} slots vs shipped ${cmp.shipped} threads (so far)\n`);
  for (const a of cmp.byAccount) {
    console.log(`■ ${a.account.padEnd(16)} shipped ${String(a.shippedThreads).padStart(2)} threads on ${a.shippedDays}d · planned ${a.plannedSlots} · cover overlap ${a.overlap.length}/${a.plannedViral.length}${a.overlap.length ? ` (${a.overlap.join(',')})` : ''}`);
  }
  console.log(`\nagreement: ${cmp.overlapTotal} planned cover sources were ALSO chosen by the old engines`);
  if (eaten.length) {
    console.log(`⚠ fulfillment: ${eaten.length}/${plannedRecIds.length} planned cover sources are already Drafted — those slots would have needed re-picks:`);
    for (const e of eaten) console.log(`   ${e.recId} ${e.hook}`);
  } else {
    console.log(`fulfillment: all ${plannedRecIds.length} planned cover sources still available`);
  }
  console.log('\n(read-only — nothing written; run again any day of the parity week)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'plan-parity');
