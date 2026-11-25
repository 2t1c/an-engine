#!/usr/bin/env node
// business-context.mjs [--named] [--days N] — the business, as an outside advisor needs it.
//
// Pasting the operation into a general-purpose advisor (Acquisition.com's bot, 2026-09-06) went
// wrong twice in one session, both times for the same reason: the advisor was reasoning off a
// hand-typed form. It read a blank paid-spend field as "$0 marketing spend" and concluded the fleet
// had infinite ROAS; it read a placeholder 4% churn and concluded there was a retention machine to
// build on. Both are the opposite of true — ~$5.4K/mo goes out the door in retweet fuel, and churn
// is 100% because Amazon owns every buyer. A hand-maintained context doc decays the day after it is
// written, and the numbers here move weekly.
//
// So this generates the doc instead. Everything below is read from committed data — levanta-days
// (revenue), facts (per-thread performance + fuel), vendors.json (the cost model), laws.json (the
// gates). No network, no env, no secrets: it runs offline and can be pasted anywhere.
//
//   node business-context.mjs                  # anonymized vendors — the safe default
//   node business-context.mjs --named          # real vendor names, for internal use only
//   node business-context.mjs --days 30        # revenue window (default 7 settled days)
//
// Vendors are anonymized by default deliberately. Their per-post rates are commercially sensitive
// to THEM, not just to us, and an advisor's answer on concentration and marginal ROAS is identical
// either way — it never needs the names.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE_DIR } from './lib.mjs';
import { levDaySettled } from './funnel-watch.mjs';
import { LAWS } from './laws.mjs';
import { measurementConfidence } from './measurement-confidence.mjs';

const sign = (n) => (Number(n) < 0 ? '-' : '');
const money = (n) => `${sign(n)}$${Math.abs(Number(n || 0)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const money2 = (n) => `${sign(n)}$${Math.abs(Number(n || 0)).toFixed(2)}`;
const pct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;
const div = (a, b) => (b ? a / b : 0);

/** PURE-ish. Parse a .jsonl, skipping unparseable lines; [] when the file is absent. */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** PURE. Levanta rows -> Map<'YYYY-MM-DD', {c,s,o,k}>. c=commission s=sales o=orders k=clicks. */
export function dayAggregates(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const d = by.get(r.d) || { c: 0, s: 0, o: 0, k: 0 };
    d.c += r.c || 0; d.s += r.s || 0; d.o += r.o || 0; d.k += r.k || 0;
    by.set(r.d, d);
  }
  return by;
}

/** PURE. The last `n` SETTLED days, summed with the ratios an advisor actually asks for.
 *  Unsettled days are dropped rather than averaged in — a day inside the 48h window undercounts,
 *  and quoting it as a decline is the exact false alarm LEV_SETTLE_HOURS exists to prevent. */
export function settledWindow(byDay, n = 7, now = Date.now()) {
  const days = [...byDay.keys()].sort().filter((d) => levDaySettled(d, now));
  const win = days.slice(-n);
  const t = { c: 0, s: 0, o: 0, k: 0 };
  for (const d of win) { const v = byDay.get(d); t.c += v.c; t.s += v.s; t.o += v.o; t.k += v.k; }
  return {
    ...t, days: win.length, from: win[0] || null, to: win[win.length - 1] || null,
    perDay: div(t.c, win.length), monthly: div(t.c, win.length) * 30, gmvMonthly: div(t.s, win.length) * 30,
    epc: div(t.c, t.k), cvr: div(t.o, t.k), aov: div(t.s, t.o), rate: div(t.c, t.s), perOrder: div(t.c, t.o),
  };
}

/** PURE. Calendar-month totals, for the growth curve. Partial months are labelled, not hidden. */
export function monthlyTotals(byDay) {
  const by = new Map();
  for (const [d, v] of byDay) {
    const m = d.slice(0, 7);
    const t = by.get(m) || { c: 0, s: 0, o: 0, k: 0, days: 0 };
    t.c += v.c; t.s += v.s; t.o += v.o; t.k += v.k; t.days++;
    by.set(m, t);
  }
  return [...by].sort().map(([m, t]) => ({ month: m, ...t, perDay: div(t.c, t.days) }));
}

const spendOf = (r) => Number(r?.fuel?.spend) || 0;
const commOf = (r) => Number(r?.commission) || 0;

/** PURE. Roll a set of posts into the shape every fuel question needs. */
export function postStats(posts) {
  const n = posts.length;
  const s = posts.reduce((a, r) => a + spendOf(r), 0);
  const c = posts.reduce((a, r) => a + commOf(r), 0);
  const v = posts.reduce((a, r) => a + (Number(r.views) || 0), 0);
  const earners = posts.filter((r) => commOf(r) > 0).length;
  const sorted = posts.map(commOf).sort((a, b) => a - b);
  return {
    n, spend: s, comm: c, views: v,
    roas: div(c, s), netPerPost: div(c - s, n), commPerPost: div(c, n), spendPerPost: div(s, n),
    viewsPerPost: div(v, n), median: n ? sorted[Math.floor(n / 2)] : 0, earnRate: div(earners, n),
  };
}

/** PURE. Fuelled vs unfuelled — the comparison that decides whether paid reach does anything. */
export function fuelSplit(facts) {
  const pub = facts.filter((r) => (Number(r.views) || 0) > 0 || commOf(r) > 0);
  return { fuelled: postStats(pub.filter((r) => spendOf(r) > 0)), unfuelled: postStats(pub.filter((r) => spendOf(r) === 0)) };
}

/** PURE. Fuelled posts grouped by their tier stack, biggest spend first. */
export function byTier(facts, minPosts = 3) {
  const by = new Map();
  for (const r of facts) {
    if (spendOf(r) <= 0) continue;
    const t = String(r.fuel.tiers || '?');
    by.set(t, [...(by.get(t) || []), r]);
  }
  return [...by].map(([tier, posts]) => ({ tier, ...postStats(posts) }))
    .filter((x) => x.n >= minPosts).sort((a, b) => b.spend - a.spend);
}

const BANDS = [[0.01, 10], [10, 20], [20, 35], [35, 60], [60, Infinity]];

/** PURE. Fuelled posts grouped by dollars spent on them — the dose-response curve. */
export function bySpendBand(facts) {
  return BANDS.map(([lo, hi]) => {
    const posts = facts.filter((r) => spendOf(r) >= lo && spendOf(r) < hi);
    return { band: hi === Infinity ? `$${lo}+` : `$${lo}-${hi}`, ...postStats(posts) };
  }).filter((x) => x.n > 0);
}

/** PURE. The vendor cost model, anonymized unless `named`. Order is by reach so the labels are
 *  stable across runs — "Vendor A" means the same network tomorrow as it does today. */
export function vendorEconomics(doc, { named = false } = {}) {
  const list = [...(doc?.vendors || [])].sort((a, b) => (b.nominalReach || 0) - (a.nominalReach || 0));
  const label = (v, i) => (named ? v.title || v.key : `Vendor ${String.fromCharCode(65 + i)}`);
  const rows = list.map((v, i) => ({
    name: label(v, i), reach: v.nominalReach || 0, accounts: v.accounts || 0,
    perPost: v.cost?.perPost || 0, retainer: v.cost?.monthlyRetainer || 0,
    model: v.cost?.model || '-', inT0: !!v.inT0Bundle,
  }));
  const t0 = doc?.bundles?.t0 || {};
  const memberKeys = new Set(t0.members || []);
  const t0Members = list.map((v, i) => ({ key: v.key, name: label(v, i) })).filter((x) => memberKeys.has(x.key));
  return {
    rows, count: rows.length,
    handles: list.reduce((a, v) => a + (v.handles?.length || 0), 0),
    reach: rows.reduce((a, r) => a + r.reach, 0),
    retainerTotal: rows.reduce((a, r) => a + r.retainer, 0),
    retainerCount: rows.filter((r) => r.retainer > 0).length,
    t0: { price: t0.price || 0, members: t0Members, spend: t0.spendToDate?.spend || 0, fires: t0.spendToDate?.fires || 0,
      retainersInside: t0Members.filter((m) => rows.find((r) => r.name === m.name)?.retainer > 0) },
  };
}

/** PURE. Total metered fuel spend, and the most recent complete month of it. */
export function fuelSpend(facts) {
  const by = new Map();
  let total = 0;
  for (const r of facts) {
    const c = spendOf(r); if (!c) continue;
    total += c;
    const m = String(r.postedAt || r.scheduledFor || '').slice(0, 7); if (!m) continue;
    const v = by.get(m) || { spend: 0, posts: 0 };
    v.spend += c; v.posts++; by.set(m, v);
  }
  const months = [...by].sort();
  return { total, months: months.map(([month, v]) => ({ month, ...v, perPost: div(v.spend, v.posts) })) };
}

/** PURE. Build the whole markdown document. Kept separate from IO so it is testable. */
export function renderContext({ win, months, split, tiers, bands, vendors, fuel, laws, confidence = { status: 'incomplete', reasons: ['not-supplied'] }, now = new Date() }) {
  const L = [];
  const p = (s = '') => L.push(s);
  const lastFull = fuel.months.length > 1 ? fuel.months[fuel.months.length - 2] : fuel.months[0];
  const monthlyFuel = (lastFull?.spend || 0) + vendors.retainerTotal;
  const grossProfit = win.monthly - monthlyFuel;
  // CAC must divide one period's spend by THAT period's orders. Pairing last month's fuel with the
  // current run rate's orders understates it by a third — the run rate is well above last month.
  const cacMonth = months.find((m) => m.month === lastFull?.month);
  const cac = div(monthlyFuel, cacMonth?.o || 0);

  p(`# Business context — generated ${now.toISOString().slice(0, 10)}`);
  p();
  p(`**Decision confidence: ${confidence.status}.**${confidence.status === 'decision-grade' ? '' : ' This snapshot is monitoring context and must not drive scaling or rankings until the attribution audit is resolved.'}`);
  if (confidence.reasons?.length) p(`Unresolved evidence: ${confidence.reasons.join(', ')}.`);
  p();
  p(`The figures below come from committed data for the stated windows. Audit evaluated: ${confidence.evaluated_at || 'unknown'}; newest source record: ${confidence.newest_source_at || 'unknown'}; end-to-end coverage: ${confidence.coverage?.end_to_end_percent ?? 'unknown'}%.`);
  p('Revenue calculations exclude days inside the documented 48-hour settling window. Decision use remains blocked while confidence is incomplete.');
  p();

  p('## 1. What the business is');
  p();
  p('Amazon affiliate content. One operator, no employees. I run a fleet of X (Twitter) accounts —');
  p('each a distinct named health/fitness persona with its own voice, boilerplate and product menu.');
  p('I own no product and hold no inventory. I write long-form threads recommending supplements and');
  p('earn a commission when a reader clicks through and buys on Amazon, via the Levanta network at a');
  p(`${pct(win.rate)} effective commission rate.`);
  p();
  p('I never see the buyer. Amazon owns the customer, the data and any repeat purchase. There is no');
  p('email list, no owned website, no checkout of my own, and no way to contact anyone who has bought.');
  p();

  p('## 2. Unit economics');
  p();
  p('| Metric | Value |');
  p('|---|---|');
  p(`| Revenue (my commission), monthly run rate | ${money(win.monthly)} |`);
  p(`| Gross merchandise value driven, monthly | ${money(win.gmvMonthly)} |`);
  p(`| Effective commission rate | ${pct(win.rate)} |`);
  p(`| Average order value (customer's basket) | ${money2(win.aov)} |`);
  p(`| My commission per order | ${money2(win.perOrder)} |`);
  p(`| Earnings per click | ${money2(win.epc)} |`);
  p(`| Click-to-order conversion | ${pct(win.cvr)} |`);
  p(`| Clicks, monthly | ${Math.round(div(win.k, win.days) * 30).toLocaleString()} |`);
  p(`| Orders (new customers), monthly | ${Math.round(div(win.o, win.days) * 30).toLocaleString()} |`);
  p(`| Customer acquisition cost | ${money2(cac)} (${cacMonth?.month || 'n/a'}: fuel ÷ that month's orders) |`);
  p(`| Customer lifetime value | ${money2(win.perOrder)} — one order, then they are Amazon's |`);
  p(`| Monthly churn | 100% by structure |`);
  p();
  p(`Window: ${win.days} settled days (${win.from} to ${win.to}).`);
  p();

  p('## 3. Growth');
  p();
  p('| Month | Commission | $/day | Orders | Clicks |');
  p('|---|---|---|---|---|');
  for (const m of months) p(`| ${m.month}${m.days < 28 ? ` (${m.days}d partial)` : ''} | ${money(m.c)} | ${money(m.perDay)} | ${m.o.toLocaleString()} | ${m.k.toLocaleString()} |`);
  p();
  p('This is TRANSACTIONAL revenue, not recurring. There are no subscriptions, contracts or renewals —');
  p('every month restarts at zero. Any "MRR growth" figure means month-over-month revenue growth and');
  p('implies no compounding base.');
  p();

  p('## 4. Paid distribution — my only marketing spend');
  p();
  p(`I buy retweet amplification from ${vendors.count} vendor networks (${vendors.handles} X accounts,`);
  p(`${(vendors.reach / 1e6).toFixed(1)}M nominal combined reach). There is no other paid acquisition —`);
  p('no Meta, no Google, no influencer fees.');
  p();
  p(`Spend: ${money(lastFull?.spend || 0)} in the last full month across ${lastFull?.posts || 0} posts`);
  p(`(${money2(lastFull?.perPost || 0)}/post), plus ${money(vendors.retainerTotal)}/month in retainers on`);
  p(`${vendors.retainerCount} vendors. Total ~${money(monthlyFuel)}/month. Lifetime fuel spend ${money(fuel.total)}.`);
  p();
  p('**How tier is chosen — this is not a judgement call.** An automated job polls each live post\'s');
  p('view velocity hourly and escalates it up the vendor tier ladder as it crosses thresholds. A post');
  p('that takes off accumulates expensive fuel; a flat one stays on the cheap baseline. So any');
  p('correlation between heavy fuel and high revenue is contaminated by REVERSE CAUSALITY: posts get');
  p('the expensive tier because they were already winning.');
  p();
  p('### Fuelled vs unfuelled posts');
  p();
  p('| | Posts | Spend | Commission | ROAS | Net/post | Median | % earning >$0 | Views/post |');
  p('|---|---|---|---|---|---|---|---|---|');
  for (const [lbl, x] of [['Fuelled', split.fuelled], ['Unfuelled', split.unfuelled]])
    p(`| ${lbl} | ${x.n} | ${money(x.spend)} | ${money(x.comm)} | ${x.roas.toFixed(2)}x | ${money2(x.netPerPost)} | ${money2(x.median)} | ${pct(x.earnRate)} | ${Math.round(x.viewsPerPost).toLocaleString()} |`);
  p();
  p('### By tier stack');
  p();
  p('| Tier stack | Posts | Spend | Commission | ROAS | Net/post | Views/post |');
  p('|---|---|---|---|---|---|---|');
  for (const t of tiers)
    p(`| ${t.tier} | ${t.n} | ${money(t.spend)} | ${money(t.comm)} | ${t.roas.toFixed(2)}x | ${money2(t.netPerPost)} | ${Math.round(t.viewsPerPost).toLocaleString()} |`);
  p();
  p('### Dose-response: by dollars spent per post');
  p();
  p('| Spend band | Posts | Spend | Commission | ROAS | Net/post |');
  p('|---|---|---|---|---|---|');
  for (const b of bands)
    p(`| ${b.band} | ${b.n} | ${money(b.spend)} | ${money(b.comm)} | ${b.roas.toFixed(2)}x | ${money2(b.netPerPost)} |`);
  p();
  if (vendors.t0.price) {
    p(`**The baseline bundle.** Every post fires a ${money2(vendors.t0.price)} brokered bundle across`);
    p(`${vendors.t0.members.length} networks. ${money(vendors.t0.spend)} spent over ${vendors.t0.fires} fires.`);
    p('Nothing anywhere confirms those networks actually retweet — no delivery confirms, no verification,');
    p('no lift measurement. Every other tier reports velocity lift; this one gets a charge and no receipt.');
    if (vendors.t0.retainersInside.length) {
      p();
      p(`**Dependency:** ${vendors.t0.retainersInside.length} of those bundle members ARE my monthly-retainer`);
      p('vendors. They are free at the margin inside the bundle only because the retainer is already paid,');
      p('so the retainers and the bundle cannot be evaluated independently — cancelling one changes the other.');
    }
    p();
  }

  p('## 5. How content gets made');
  p();
  p('A four-stage model, produced in two batch runs a week:');
  p();
  p('1. **Cover** — I find another creator\'s proven viral thread and recreate it in my own words with');
  p('   my own products. This is the bet, and the bulk of output.');
  p('2. **Harvest** — when one of MY threads clears the winner bar, its body enters a pool and can be');
  p('   reposted verbatim on a different account with a fresh link. Each pool body gets a fixed number');
  p('   of reuses before expiring.');
  p('3. **Seed** — a body that performs repeatedly is templatized into a reusable skeleton.');
  p('4. **Pot** — a child thread filled from an approved skeleton.');
  p();
  p(`Winner bar: ${Number(laws?.farm?.gateViews || 0).toLocaleString()} views + ${money(laws?.farm?.gateCommission)},`);
  p(`or ${Number(laws?.farm?.gateViews || 0).toLocaleString()} views + ${laws?.farm?.gateClicks} clicks,`);
  p(`or ${money(laws?.farm?.gateStraightCommission)} outright.`);
  p();
  p('Every thread passes an automated gate before publishing: affiliate disclosure, no hard health');
  p('claims, link integrity, structure, and hook fidelity against the source. Zero errors or it does');
  p('not ship. Threads are 13-15 tweets with affiliate links at fixed positions. One monetized thread');
  p('per account per day, staggered so no two accounts post in the same minute.');
  p();

  p('## 6. Costs and margin');
  p();
  p('| Line | Monthly |');
  p('|---|---|');
  p(`| Revenue (commission) | ${money(win.monthly)} |`);
  p(`| Retweet fuel (variable, scales per post) | -${money(lastFull?.spend || 0)} |`);
  p(`| Vendor retainers (fixed) | -${money(vendors.retainerTotal)} |`);
  p(`| **Gross profit** | **${money(grossProfit)}** (${pct(div(grossProfit, win.monthly))}) |`);
  p();
  p('Fuel is ~100% of cost of revenue. There is no inventory, no COGS, no fulfilment cost, no payroll.');
  p('Tooling and subscriptions sit below this line and are small by comparison.');
  p();
  p('**Margin excludes any founder salary.** I take no wage, so this is cash margin, not economic');
  p('margin. My own review time is both uncosted and the binding constraint on growth — at a market');
  p('rate for the operator role, true margin would be materially lower. That gap matters for any');
  p('hire-versus-automate decision.');
  p();

  p('## 7. Constraints and risks');
  p();
  p('- **My review time is the hard ceiling.** One person gates every thread before it ships.');
  p('- **Fuel does not compound.** It costs a flat rate per post with no volume discount, so growth in');
  p('  throughput costs cash proportionally and forever.');
  p('- **Rented distribution.** I own no audience. Reach is bought per post from third-party networks.');
  p('- **Single points of failure everywhere:** one affiliate network, one retailer, one social');
  p('  platform, and a retweet layer I do not control.');
  p('- **No customer asset.** Roughly ' + Math.round(div(win.o, win.days) * 30).toLocaleString() + ' buyers a month, none of them retained, contactable or resellable.');
  p();

  p('## 8. What this document does not know');
  p();
  p('State these as unknown rather than assuming a value:');
  p();
  p('- Tooling and subscription costs (hosting, scheduling, AI, per-account platform fees).');
  p('- Cash on hand, personal runway, and tax position.');
  p('- Return and refund rates — Amazon does not report them back to me.');
  p('- Anything about buyer identity, satisfaction or repeat behaviour. No NPS, no survey, no contact.');
  p('- Whether the baseline retweet bundle delivers at all (see section 4).');
  p();
  return L.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const named = argv.includes('--named');
  const di = argv.indexOf('--days');
  const days = di > -1 ? Number(argv[di + 1]) || 7 : 7;
  const root = HERE_DIR;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return null; } };

  const byDay = dayAggregates(readJsonl(path.join(root, 'levanta-days.jsonl')));
  const facts = readJsonl(path.join(root, 'facts.jsonl'));
  const vendorsDoc = readJson('vendors.json');

  const out = renderContext({
    win: settledWindow(byDay, days),
    months: monthlyTotals(byDay),
    split: fuelSplit(facts),
    tiers: byTier(facts),
    bands: bySpendBand(facts),
    vendors: vendorEconomics(vendorsDoc, { named }),
    fuel: fuelSpend(facts),
    laws: LAWS,
    confidence: measurementConfidence(),
  });
  console.log(out);
  if (!named) console.error('\n[vendors anonymized — pass --named for real names, internal use only]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
