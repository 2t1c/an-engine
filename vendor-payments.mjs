// vendor-payments.mjs — turn the vendor deals into a payment schedule that tracks consumption.
//
// The failure mode this exists to prevent: four packages and two retainers all coming due inside the
// same fortnight, which on 2026-09-06 was $7,379 of it. Nothing about that is unaffordable; it is
// unaffordable ON ONE DAY. So the rule here is pay-as-we-consume — an installment covers roughly one
// month of that vendor's actual burn, which is also the easiest thing to justify to the vendor: we
// are not asking for credit, we are asking to pay monthly for something we consume monthly.
//
// MONTHS OF SUPPLY is the number that decides everything. A pack worth 15 months of our sending is
// bad cash management however cheap the per-post price looks, because that money is dead on a shelf.
// A pack worth a week is bad too — it renews constantly and every renewal is a negotiation.
// The sweet spot is 1-3 months, and the report flags both ends.
//
// Demand is planningDemand from fuel-ops-core.mjs — the same figure the supply board uses: measured
// history × fleet growth × viral buffer (see vendor-supply.mjs; --fleet --base --buffer --window).
//
//   node vendor-payments.mjs              # the schedule
//   node vendor-payments.mjs --apply      # also write Next Payment into the RT Usage tracker
import { readFileSync } from 'node:fs';
import { loadEnv, requireEnv, airtable, logRun, runMain } from './lib.mjs';
import { ledgerLines, planningDemand } from './fuel-ops-core.mjs';
import { demandOptions, describeModel } from './fleet-roster.mjs';

const money = (n) => `$${Number(n).toFixed(2)}`;
const day = (n, from = Date.now()) => new Date(from + n * 864e5).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

/** How many installments a renewal should carry: one per month of supply it buys, 1..4.
 *  One month of consumption per payment is the pitch — it is defensible, and it keeps the outflow
 *  flat instead of spiky. Capped at 4 because past that a vendor stops calling it a payment plan. */
export function installmentsFor(monthsOfSupply) {
  if (!Number.isFinite(monthsOfSupply) || monthsOfSupply <= 1) return 1;
  return Math.max(1, Math.min(4, Math.round(monthsOfSupply)));
}

/** Verdict on a pack size, in cash terms rather than price terms. */
export function supplyVerdict(months) {
  if (!Number.isFinite(months)) return 'no send history';
  if (months < 0.5) return 'TOO SMALL — renews weekly, ask for a bigger pack at volume price';
  if (months > 6) return 'TOO BIG — months of cash dead on a shelf, ask for a smaller pack';
  return 'well sized';
}

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const deals = JSON.parse(readFileSync(new URL('./vendor-credits.json', import.meta.url), 'utf8'));
  const lines = ledgerLines(await airtable(env, env.REGISTRY_BASE_ID).listAll('Fuel Log'));
  const { window, fleet, base, buffer, roster } = await demandOptions(env);
  const now = Date.now();

  const items = [];
  let model = null;
  for (const v of deals.vendors) {
    if (v.deal === 'unlimited') {
      if (v.monthlyRetainer) items.push({ name: v.name, kind: 'retainer', amount: v.monthlyRetainer, everyDays: 30, dueIn: 0 });
      continue;
    }
    const p = planningDemand(lines, v.name, { window, now, fleet, base, buffer });
    model ||= p;
    const left = v.total - v.used, r = p.demand;
    const dueIn = r > 0 ? left / r : Infinity;
    const posts = v.renewalOffer ? v.renewalOffer.posts : v.total;
    const price = v.renewalOffer ? v.renewalOffer.price : v.total * v.perPost;
    const newPerPost = price / posts;
    const months = r > 0 ? posts / (r * 30) : Infinity;
    items.push({ name: v.name, kind: v.unpaid ? 'owed' : 'renewal', left, measured: p.measured, rate: r, dueIn,
      posts, price, newPerPost, oldPerPost: v.perPost, months,
      offer: !!v.renewalOffer, verdict: supplyVerdict(months) });
  }
  console.log(describeModel(model, roster) + '\n');

  console.log('=== WHAT EACH RENEWAL ACTUALLY BUYS ===\n');
  console.log('vendor              pack    price   $/post  vs now   plan/d   months supply   verdict');
  for (const i of items.filter((x) => x.kind !== 'retainer').sort((a, b) => a.dueIn - b.dueIn)) {
    const delta = i.newPerPost - i.oldPerPost;
    const arrow = Math.abs(delta) < 0.005 ? 'same' : (delta > 0 ? `+${money(delta)}` : `-${money(-delta)}`);
    console.log(i.name.padEnd(20) + String(i.posts).padStart(4) + money(i.price).padStart(9) + money(i.newPerPost).padStart(9)
      + arrow.padStart(8) + i.rate.toFixed(2).padStart(9) + (Number.isFinite(i.months) ? i.months.toFixed(1) : '—').padStart(11) + '     ' + i.verdict);
  }

  // schedule: urgent first, one installment per month of supply, staggered so two do not share a week
  console.log('\n=== PAYMENT SCHEDULE ===\n');
  const sched = [];
  let stagger = 0;
  for (const i of items.filter((x) => x.kind !== 'retainer').sort((a, b) => a.dueIn - b.dueIn)) {
    const n = installmentsFor(i.months);
    const each = round2(i.price / n);
    const start = Number.isFinite(i.dueIn) ? Math.max(0, Math.round(i.dueIn) - 2) : 30;   // pay just before it runs dry
    for (let k = 0; k < n; k++) sched.push({ when: day(start + stagger + k * 30), name: i.name, amount: each, note: `${k + 1}/${n}${i.kind === 'owed' ? ' (already delivered)' : ''}` });
    stagger += 2;                                    // nudge each vendor a couple of days apart
  }
  for (const rt of items.filter((x) => x.kind === 'retainer')) for (let k = 0; k < 3; k++) sched.push({ when: day(k * 30 + 1), name: rt.name, amount: rt.amount, note: 'retainer' });
  sched.sort((a, b) => a.when.localeCompare(b.when));
  for (const s of sched) console.log('  ' + s.when + '  ' + s.name.padEnd(20) + money(s.amount).padStart(9) + '   ' + s.note);

  console.log('\n=== CASH OUT BY MONTH ===');
  const byMonth = {};
  for (const s of sched) { const m = s.when.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + s.amount; }
  for (const m of Object.keys(byMonth).sort()) console.log('  ' + m + '   ' + money(byMonth[m]).padStart(10));
  const tot = Object.values(byMonth).reduce((a, b) => a + b, 0);
  console.log('  ' + '-'.repeat(22) + '\n  total  ' + money(tot).padStart(12));

  // ---- SUBSCRIPTION MODEL (operator 2026-09-06) ------------------------------------------------
  // "we can also set up a subscription... so we just keep on using our package and never have to
  // worry about running out." Strictly better than buying packs: a pack is a bet on how much you
  // will send in the next N months, and every bet we placed above is wrong in one direction or the
  // other — five packs carry over six months of dead cash, one carries a week. A monthly top-up
  // sized to real burn ends the guessing, flattens the outflow completely, and removes the run-dry
  // risk that cost us tiers all week.
  //
  // Sized at the PLANNING demand — measured burn × fleet growth × the viral buffer — which is the
  // allowance for above-average weeks; a flat 20% headroom used to sit here and would now count the
  // same risk twice. Unused posts must roll over: that is the one term to insist on, and an easy ask
  // since it costs the vendor nothing. Each subscription STARTS when the current pack runs out, so
  // the $9,374 of inventory we already own gets consumed first rather than paid for twice.
  console.log('\n=== SUBSCRIPTION ALTERNATIVE — monthly top-up sized to planned demand ===\n');
  console.log('vendor              posts/mo   $/post    monthly    biweekly   starts');
  let subTotal = 0;
  const subs = items.filter((x) => x.kind !== 'retainer' && Number.isFinite(x.rate) && x.rate > 0)
    .sort((a, b) => b.rate * b.oldPerPost - a.rate * a.oldPerPost);
  for (const i of subs) {
    const perMo = Math.ceil(i.rate * 30);
    const price = i.offer && i.newPerPost < i.oldPerPost ? i.newPerPost : i.oldPerPost;   // take their better rate if offered
    const monthly = round2(perMo * price);
    subTotal += monthly;
    console.log(i.name.padEnd(20) + String(perMo).padStart(6) + money(price).padStart(9) + money(monthly).padStart(11)
      + money(monthly / 2).padStart(11) + '   ' + (Number.isFinite(i.dueIn) ? day(Math.round(i.dueIn)) : 'now'));
  }
  const retainers = items.filter((x) => x.kind === 'retainer').reduce((s, r) => s + r.amount, 0);
  console.log('  ' + '-'.repeat(62));
  console.log('retainers (Lewin + VOPE)'.padEnd(46) + money(retainers).padStart(11));
  console.log('STEADY-STATE MONTHLY'.padEnd(46) + money(subTotal + retainers).padStart(11));
  console.log('                    biweekly equivalent'.padEnd(46) + money((subTotal + retainers) / 2).padStart(11));
  console.log('\nvs the pack schedule above, which peaks at ' + money(Math.max(...Object.values(byMonth))) + ' in one month.');

  if (process.argv.includes('--apply')) {
    const first = {};
    for (const s of sched) if (!first[s.name]) first[s.name] = s.when;
    const rows = Object.entries(first).map(([Vendor, d]) => ({ Vendor, 'Next Payment': d }));
    await airtable(env, env.REGISTRY_BASE_ID).upsert('RT Usage', 'Vendor', rows);
    console.log(`\nwrote Next Payment for ${rows.length} vendors into RT Usage`);
  } else console.log('\n(no --apply — nothing written to Airtable)');
  await logRun('vendor-payments', { vendors: items.length, payments: sched.length, total: round2(tot), fleet: model ? model.fleet : null, buffer: model ? model.buffer : null });
}, 'vendor-payments');
