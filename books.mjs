// books.mjs — the monthly BOOKS: what the business earned, what it spent, and what that means for
// cash. Read-only and fully OFFLINE — it reads the three files the pipeline already writes and
// never calls Levanta, Airtable, Typefully or Stripe.
//
// Why this exists. Every other report in this repo prices a THREAD (unit economics, EPC, $/1k
// views). None of them price the BUSINESS. A bank feed can't either: Levanta pays one lump sum on
// the 2nd-3rd of month M+2 with no per-account detail, and the boost vendors are separate small
// payments through the month. QuickBooks alone would show a deposit and a pile of transfers. This
// turns the pipeline's own data into the two numbers the feed cannot produce:
//
//   1. REVENUE EARNED in a month  (accrual) — vs the cash that shows up ~33 days after month end.
//   2. COST INCURRED in a month, by vendor — the reconciliation target for the feed.
//
// The accounting rule this file is built around, stated once because getting it wrong
// double-counts everything:
//
//   * Revenue is ACCRUED here as a journal entry (DR Accounts Receivable — Levanta / CR income),
//     because no bank feed can see commission that hasn't been paid yet. When Levanta's payout
//     later lands (through Stripe, into the Treasury account), the feed categorises that deposit
//     AGAINST the receivable — clearing it, not booking new income.
//   * Costs are NOT journalled here. Boost vendors and API bills are paid from Treasury/PayPal and
//     WILL arrive through the bank feed on their own. Journalling them too would book every dollar
//     of cost twice. What this file gives you for costs is the TARGET: "the feed should show
//     ~$X of vendor spend this month, split across these vendors." If the feed disagrees, one of
//     the two is wrong and you want to know which.
//
// Sources, and why each one:
//   levanta-days.jsonl  revenue. The SETTLED per-(date, link) file — docs/unit-economics.md is
//                       explicit that this is truth and Airtable trails the store by ~25%.
//   facts.jsonl         costs. `fuel.fires[]` carries a per-vendor price AND its own timestamp,
//                       so a boost is booked in the month it FIRED, not the month its thread
//                       posted (a thread posted 31 Jul and boosted 2 Aug is an August cost).
//   books-manual.json   everything this repo cannot see — Stripe (RT bot), ghostwriting, SaaS
//                       subscriptions, contractors. Optional; see books-manual.example.json.
//
//   node books.mjs                      # last complete month
//   node books.mjs --month 2026-08      # a specific month
//   node books.mjs --months 6           # trailing 6-month table
//   node books.mjs --csv                # + write books/qbo-journal-<month>.csv
//   node books.mjs --telegram           # + send the digest (needs AIRTABLE_PAT/XDB_BASE_ID)
//   node books.mjs --import bank.csv    # categorise a statement + reconcile it against the pipeline
//   node books.mjs --cashflow --cash N  # forward cash forecast, the trough, and what moves it
//     ... --vendor-terms 30            # model net-30 from the boost vendors (the one real lever)
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, telegram, esc, report, cliArg, HERE_DIR, runMain } from './lib.mjs';

const args = process.argv.slice(2);
const WRITE_CSV = args.includes('--csv');
const SEND = args.includes('--telegram');
const TRAILING = Number(cliArg('months', '0'));

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

// ---------------------------------------------------------------------------------------------
// Chart of accounts. These strings are the QuickBooks account NAMES — they must match the accounts
// you create in QBO exactly, or the CSV import will fail on an unknown account. Keep this block
// and docs/quickbooks-setup.md in sync; the doc is the human copy of this list.
// ---------------------------------------------------------------------------------------------
export const COA = {
  arLevanta: 'Accounts Receivable - Levanta',
  incAffiliate: 'Affiliate Commission - Levanta',
  incRt: 'RT Service Revenue',
  incGhostwriting: 'Ghostwriting Revenue',
  incDigital: 'Digital Product Sales',
  cogsBoost: 'Content Boost Spend',
  cogsRtVendor: 'RT Vendor Costs - Client Delivery',
  cogsRtRetainer: 'RT Vendor Retainers',
  cogsLlm: 'AI / LLM API Costs',
  opexSoftware: 'Software & Subscriptions',
  opexFees: 'Payment Processing Fees',
  opexContractors: 'Contractors & VA',
};

// ---------------------------------------------------------------------------------------------
// Loaders. Every one tolerates a missing or half-written file: this runs on a runner mid-sync and
// a truncated last line must not take the month's books down.
// ---------------------------------------------------------------------------------------------
const readJsonl = (name) => {
  const p = join(HERE_DIR, name);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* truncated tail — skip, don't throw */ }
  }
  return out;
};

const monthOf = (iso) => String(iso || '').slice(0, 7);

/** Affiliate commission EARNED per month, from the settled day file. */
export function affiliateByMonth(rows) {
  const by = new Map();
  for (const r of rows) {
    const m = monthOf(r.d);
    if (!m) continue;
    const g = by.get(m) || { commission: 0, sales: 0, orders: 0, clicks: 0 };
    g.commission += Number(r.c) || 0;
    g.sales += Number(r.s) || 0;
    g.orders += Number(r.o) || 0;
    g.clicks += Number(r.k) || 0;
    by.set(m, g);
  }
  return by;
}

/**
 * Boost spend per month, per vendor — keyed on each FIRE's own timestamp, not the thread's post
 * date. A thread posted 31 Jul and boosted 2 Aug is an August cost, and booking it to July would
 * misstate both months. Threads whose fuel has a `spend` but no itemised `fires[]` (older rows,
 * before the per-fire ledger landed) fall back to the thread's post month under "(unitemised)" so
 * the total stays honest rather than silently shrinking.
 */
export function boostByMonth(facts) {
  const by = new Map();
  const bump = (m, vendor, amt) => {
    if (!m || !amt) return;
    const g = by.get(m) || { total: 0, vendors: new Map() };
    g.total += amt;
    g.vendors.set(vendor, (g.vendors.get(vendor) || 0) + amt);
    by.set(m, g);
  };
  for (const f of facts) {
    const fuel = f.fuel;
    if (!fuel || typeof fuel !== 'object') continue;
    const fires = Array.isArray(fuel.fires) ? fuel.fires : [];
    if (fires.length) {
      for (const fire of fires) {
        const price = Number(fire.price) || 0;
        if (!price) continue;
        const vendors = Array.isArray(fire.vendors) && fire.vendors.length ? fire.vendors : ['(unnamed vendor)'];
        // A fire's price is the price of THAT send; when it names several vendors the price is the
        // line total for them, so split it rather than counting it once per vendor.
        const each = price / vendors.length;
        for (const v of vendors) bump(monthOf(fire.at), v, each);
      }
    } else if (Number(fuel.spend)) {
      bump(monthOf(f.postedAt || f.scheduledFor), '(unitemised)', Number(fuel.spend));
    }
  }
  return by;
}

/**
 * LLM generation cost per month. Stamped per-thread on the ledger as `genCost`; the authoritative
 * figure is the Airtable "LLM Spend" table, which this file cannot reach offline. Reported as a
 * FLOOR for that reason — see the caveat printed under the P&L.
 */
export function llmByMonth(facts) {
  const by = new Map();
  for (const f of facts) {
    const c = Number(f.genCost) || 0;
    if (!c) continue;
    const m = monthOf(f.postedAt || f.scheduledFor);
    if (m) by.set(m, (by.get(m) || 0) + c);
  }
  return by;
}

/** Off-repo streams (Stripe / ghostwriting / SaaS). Shape documented in the example file. */
export function loadManual() {
  const p = join(HERE_DIR, 'books-manual.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    console.error(`⚠️  books-manual.json is not valid JSON (${e.message}) — off-repo lines omitted.`);
    return {};
  }
}

const manualMonth = (manual, month) => {
  const m = manual?.[month] || {};
  const num = (k) => Number(m[k]) || 0;
  return {
    rtRevenue: num('rtRevenue'),
    ghostwriting: num('ghostwriting'),
    digital: num('digital'),
    rtVendorCost: num('rtVendorCost'),
    rtRetainers: num('rtRetainers'),
    software: num('software'),
    processingFees: num('processingFees'),
    contractors: num('contractors'),
    deferredRevenueDelta: Number(m.deferredRevenueDelta) || 0,
    note: m.note || '',
  };
};

// ---------------------------------------------------------------------------------------------
// The month's books.
// ---------------------------------------------------------------------------------------------
export function buildMonth(month, { affiliate, boost, llm, manual }) {
  const aff = affiliate.get(month) || { commission: 0, sales: 0, orders: 0, clicks: 0 };
  const bst = boost.get(month) || { total: 0, vendors: new Map() };
  const gen = llm.get(month) || 0;
  const man = manualMonth(manual, month);

  const income = aff.commission + man.rtRevenue + man.ghostwriting + man.digital;
  const cogs = bst.total + gen + man.rtVendorCost + man.rtRetainers;
  const opex = man.software + man.processingFees + man.contractors;
  const gross = income - cogs;
  const net = gross - opex;

  return {
    month, aff, boost: bst, llm: gen, manual: man,
    income, cogs, opex, gross, net,
    grossPct: income ? (gross / income) * 100 : 0,
    netPct: income ? (net / income) * 100 : 0,
  };
}

/**
 * The single journal entry to key into QuickBooks for the month.
 *
 * Revenue ONLY, and deliberately so. Levanta commission is earned in the month the orders ship but
 * paid as one lump 33 days later, on the 2nd-3rd of month M+2 (subject to the brand paying
 * Levanta), so no bank feed can see it in the month it belongs to — this entry is the only way it
 * lands in the right month. Costs are excluded because they are paid from Treasury/PayPal and
 * arrive through the feed on their own; journalling them here as well would book them twice.
 */
export function journalEntry(bk) {
  const lines = [];
  const add = (account, debit, credit, description) =>
    lines.push({ account, debit: debit || 0, credit: credit || 0, description });

  if (bk.aff.commission) {
    add(COA.arLevanta, bk.aff.commission, 0, `Levanta commission earned ${bk.month} (${bk.aff.orders} orders)`);
    add(COA.incAffiliate, 0, bk.aff.commission, `Affiliate commission earned ${bk.month}`);
  }
  // A rise in unearned RT credits is cash already received for posts not yet delivered — income
  // the month has not earned. Moving it to a liability is what keeps a big prepayment month from
  // reading as a great month.
  if (bk.manual.deferredRevenueDelta) {
    const d = bk.manual.deferredRevenueDelta;
    if (d > 0) { add(COA.incRt, d, 0, `Defer unearned RT credits ${bk.month}`); add('Deferred Revenue - RT Credits', 0, d, `Unearned RT credits ${bk.month}`); }
    else { add('Deferred Revenue - RT Credits', -d, 0, `Release RT credits delivered ${bk.month}`); add(COA.incRt, 0, -d, `RT credits earned ${bk.month}`); }
  }
  return lines;
}

export function journalCsv(bk, lines) {
  const head = 'JournalNo,JournalDate,AccountName,Debits,Credits,Description';
  const no = `PI-${bk.month}`;
  // Last day of the month — the entry belongs to the period it closes, not to today.
  const [y, m] = bk.month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const esc0 = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = lines.map((l) => [no, date, esc0(l.account), l.debit ? l.debit.toFixed(2) : '', l.credit ? l.credit.toFixed(2) : '', esc0(l.description)].join(','));
  return [head, ...rows].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Statement import — the other half of the picture.
//
// Everything above is what the PIPELINE believes happened. This is what the BANK says happened.
// Neither is complete on its own: the pipeline can't see a subscription renewal or a card swipe,
// and the bank can't see which account a boost was bought for. Run both and the difference between
// them is the only number that tells you something is wrong.
//
// Deliberately provider-agnostic — it parses a CSV, not an API. That covers the two real cases:
// a Stripe Treasury financial account that may not surface as a QBO bank feed, and the one-time
// pre-cutover Payoneer back-fill (docs/quickbooks-setup.md §5a). Every provider exports a CSV,
// so one importer covers Treasury today and whatever replaces it later.
// ---------------------------------------------------------------------------------------------

/** Minimal RFC-4180 CSV: handles quoted fields, embedded commas, doubled quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = text.replace(/^﻿/, ''); // strip BOM — Excel exports carry one
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const NUM = (v) => {
  const t = String(v ?? '').replace(/[^0-9.\-()]/g, '').replace(/^\((.*)\)$/, '-$1'); // (12.34) = -12.34
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Find the date / description / amount columns by header name. Providers disagree on all three,
 * and some split money into separate credit and debit columns instead of signing one — both
 * shapes are handled, because guessing wrong silently inverts every expense.
 */
export function detectColumns(headers) {
  const h = headers.map((x) => String(x).trim().toLowerCase());
  const find = (...pats) => h.findIndex((x) => pats.some((p) => x.includes(p)));
  const date = find('date', 'time', 'created');
  const desc = find('description', 'details', 'merchant', 'payee', 'narrative', 'reference', 'memo', 'target name', 'counterparty');
  const credit = find('credit', 'money in', 'paid in', 'received');
  const debit = find('debit', 'money out', 'paid out', 'spent');
  // An "Amount" column only counts if it is not the credit/debit column already found. Payoneer
  // exports "Credit Amount"/"Debit Amount", both of which contain "amount" — taking the first
  // match would read the credit column as the signed total and silently zero every expense.
  const amount = h.map((x, i) => (x.includes('amount') ? i : -1)).find((i) => i >= 0 && i !== credit && i !== debit) ?? -1;
  return { date, desc, amount, credit, debit };
}

export function loadRules() {
  const p = join(HERE_DIR, 'books-rules.json');
  if (!existsSync(p)) return [];
  try { return (JSON.parse(readFileSync(p, 'utf8')).rules || []).map((r) => ({ ...r, re: new RegExp(r.match, 'i') })); }
  catch (e) { console.error(`⚠️  books-rules.json unreadable (${e.message}) — everything will import uncategorised.`); return []; }
}

export function importStatement(csvText, rules, month) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { txns: [], cols: null };
  const cols = detectColumns(rows[0]);
  const txns = [];
  for (const r of rows.slice(1)) {
    const date = cols.date >= 0 ? String(r[cols.date] || '').trim() : '';
    const desc = cols.desc >= 0 ? String(r[cols.desc] || '').trim() : '';
    // A signed Amount column wins; otherwise credit minus debit.
    let amt = cols.amount >= 0 ? NUM(r[cols.amount]) : 0;
    if (cols.amount < 0) amt = NUM(cols.credit >= 0 ? r[cols.credit] : 0) - NUM(cols.debit >= 0 ? r[cols.debit] : 0);
    if (!date && !desc && !amt) continue;
    // Normalise the many date shapes to YYYY-MM so month filtering works: ISO passes through,
    // anything else goes via Date.parse, and an unparseable date keeps the row (unfiltered)
    // rather than dropping money on the floor.
    let ym = '';
    const iso = date.match(/^(\d{4})-(\d{2})/);
    if (iso) ym = `${iso[1]}-${iso[2]}`;
    else { const d = Date.parse(date); if (Number.isFinite(d)) ym = new Date(d).toISOString().slice(0, 7); }
    if (month && ym && ym !== month) continue;
    const rule = rules.find((x) => x.re.test(desc));
    txns.push({ date, ym, desc, amt, account: rule ? rule.account : null, class: rule?.class || '', note: rule?.note || '' });
  }
  return { txns, cols };
}

function printImport(txns, cols, bk, month) {
  if (!txns.length) { console.log(`\n⚠️  No transactions parsed${month ? ` for ${month}` : ''}. Check the CSV has a header row.\n`); return; }
  const transfers = txns.filter((t) => t.account === 'TRANSFER');
  const real = txns.filter((t) => t.account !== 'TRANSFER');
  const moneyIn = real.filter((t) => t.amt > 0).reduce((a, t) => a + t.amt, 0);
  const moneyOut = real.filter((t) => t.amt < 0).reduce((a, t) => a + t.amt, 0);

  console.log(`\n=== STATEMENT · ${txns.length} transactions${month ? ` · ${month}` : ''} ===\n`);
  if (cols.desc < 0) console.log('⚠️  No description column found — nothing can be categorised. Check the CSV header.\n');
  console.log(`  ${pad('Money in', 34)}${rpad(money(moneyIn), 12)}`);
  console.log(`  ${pad('Money out', 34)}${rpad(money(moneyOut), 12)}`);
  console.log(`  ${pad('Net movement', 34)}${rpad(money(moneyIn + moneyOut), 12)}`);
  if (transfers.length) console.log(`  ${pad(`Transfers excluded (${transfers.length})`, 34)}${rpad(money(transfers.reduce((a, t) => a + t.amt, 0)), 12)}   own money moving`);

  const byAcct = new Map();
  for (const t of real) {
    const k = t.account || '❓ UNCATEGORISED';
    const g = byAcct.get(k) || { total: 0, n: 0 };
    g.total += t.amt; g.n++; byAcct.set(k, g);
  }
  console.log(`\nBY ACCOUNT`);
  for (const [k, g] of [...byAcct.entries()].sort((a, b) => a[1].total - b[1].total)) {
    console.log(`  ${pad(k, 40)}${rpad(money(g.total), 12)}  ${g.n} txn`);
  }

  const unc = real.filter((t) => !t.account);
  if (unc.length) {
    console.log(`\n❓ UNCATEGORISED — ${unc.length} txn, ${money(unc.reduce((a, t) => a + t.amt, 0))}. Add a pattern to books-rules.json:`);
    const byDesc = new Map();
    for (const t of unc) { const k = t.desc.slice(0, 46) || '(no description)'; const g = byDesc.get(k) || { total: 0, n: 0 }; g.total += t.amt; g.n++; byDesc.set(k, g); }
    for (const [k, g] of [...byDesc.entries()].sort((a, b) => a[1].total - b[1].total).slice(0, 20)) {
      console.log(`  ${pad(k, 48)}${rpad(money(g.total), 12)}${g.n > 1 ? `  ×${g.n}` : ''}`);
    }
  }

  // The reconciliation — the reason both halves exist.
  if (bk && bk.boost.total) {
    const boostSeen = -real.filter((t) => t.account === 'Content Boost Spend' || t.account === 'RT Vendor Costs - Client Delivery')
      .reduce((a, t) => a + t.amt, 0);
    const gap = bk.boost.total - boostSeen;
    console.log(`\nRECONCILIATION — boost spend`);
    console.log(`  ${pad('Pipeline says (facts.jsonl)', 34)}${rpad(money(bk.boost.total), 12)}`);
    console.log(`  ${pad('Statement says', 34)}${rpad(money(boostSeen), 12)}`);
    console.log(`  ${pad('Gap', 34)}${rpad(money(gap), 12)}   ${Math.abs(gap) < 50 ? '✅ within tolerance' : '⚠️  investigate'}`);
    if (Math.abs(gap) >= 50) console.log(`     A gap means a fire was logged but not paid, a payment was made off-pipeline,\n     or a vendor name in the statement has no rule yet. Usually the third.`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------------------------
// Cash forecast — the question the P&L can't answer.
//
// This business consumes cash precisely BECAUSE it is growing. Boost spend is paid the week it
// fires; the commission it generates arrives 30-60+ days later. So every month of growth widens
// the hole before it fills it, and the constraint on scaling boost spend is cash on hand, not
// profitability. A month can be 70% gross margin and still be the month the account runs dry.
//
// The model is deliberately crude and legible rather than clever: revenue earned in a month is
// collected `lag` days after that month ends; boost spend is paid inside the month it fires;
// everything is month-granular. It is a planning tool, not a forecast to bet the company on —
// the assumptions print above the table so they can be argued with.
// ---------------------------------------------------------------------------------------------

const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * Spread one month's earnings across the months they're actually collected in.
 *
 * Revenue accrues day by day through a month, so collecting it `lag` days later normally straddles
 * two months. Modelling it as a single lump landing `lag` days after month END is what an earlier
 * version did, and it produced a fake crisis: at a 60-day lag, November's month-end lands 29 Jan
 * and December's lands 1 Mar, so February collected NOTHING and the forecast showed the company
 * running dry in a month that is unremarkable. Uniform daily accrual removes the artifact — no
 * month is ever skipped, and a lag change moves the money smoothly instead of in jumps.
 */
export function spreadCollections(ym, amount, lagDays) {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const perDay = amount / days;
  const out = new Map();
  for (let d = 1; d <= days; d++) {
    const land = new Date(Date.UTC(y, m - 1, d) + lagDays * 864e5).toISOString().slice(0, 7);
    out.set(land, (out.get(land) || 0) + perDay);
  }
  return out;
}

export function forecast({ affiliate, boost, openingCash, lagDays, growth, horizon, opexMonthly, vendorTermsDays = 0 }) {
  const hist = [...affiliate.keys()].sort();
  const lastActual = hist[hist.length - 1];
  // September is 2 days old in the sample data — a partial month would read as a collapse and
  // poison the base. Use the last month that actually looks complete.
  const base = hist.length > 1 && (affiliate.get(lastActual)?.commission || 0) < (affiliate.get(hist[hist.length - 2])?.commission || 0) * 0.5
    ? hist[hist.length - 2] : lastActual;
  const baseRev = affiliate.get(base)?.commission || 0;
  const baseBoost = boost.get(base)?.total || 0;
  const boostRatio = baseRev ? baseBoost / baseRev : 0.3;

  // Earned revenue per month: actuals, then projected forward. Projected PAST the horizon by the
  // collection lag — otherwise the last months of the table show no collections simply because
  // the revenue that funds them was never generated, and the forecast ends on a fake cliff.
  const overrun = Math.ceil(lagDays / 30) + 1;
  const earned = new Map();
  for (const m of hist) earned.set(m, affiliate.get(m).commission);
  for (let i = 1; i <= horizon + overrun; i++) earned.set(addMonths(base, i), baseRev * Math.pow(growth, i));

  // Boost paid per month: actuals, then a constant share of the revenue it generates.
  const spend = new Map();
  for (const m of [...boost.keys()]) spend.set(m, boost.get(m).total);
  for (let i = 1; i <= horizon + overrun; i++) { const m = addMonths(base, i); spend.set(m, (earned.get(m) || 0) * boostRatio); }

  // Walk forward from the month after the base. Everything before it is already history and its
  // cash has landed or not — the opening balance is where that history left you.
  // Pre-spread both sides across the months they actually move cash in.
  const cashIn = new Map(), cashOut = new Map();
  const accrue = (target, src, lag) => {
    for (const [ym, amt] of src) for (const [land, part] of spreadCollections(ym, amt, lag)) target.set(land, (target.get(land) || 0) + part);
  };
  accrue(cashIn, earned, lagDays);
  accrue(cashOut, spend, vendorTermsDays);

  const rows = [];
  let cash = openingCash;
  for (let i = 1; i <= horizon; i++) {
    const m = addMonths(base, i);
    const collected = cashIn.get(m) || 0;
    const paid = cashOut.get(m) || 0;
    const net = collected - paid - opexMonthly;
    cash += net;
    rows.push({ month: m, earned: earned.get(m) || 0, collected, paid, opex: opexMonthly, net, cash });
  }
  return { rows, base, baseRev, baseBoost, boostRatio };
}

function printCashflow(fc, opts) {
  const { rows, base, boostRatio } = fc;
  console.log(`\n=== CASH FORECAST ===\n`);
  console.log(`  base month ${base} · revenue ${money(fc.baseRev)} · boost ${money(fc.baseBoost)} (${(boostRatio * 100).toFixed(0)}% of revenue)`);
  console.log(`  opening cash ${money(opts.openingCash)} · collection lag ${opts.lagDays}d · growth ${((opts.growth - 1) * 100).toFixed(0)}%/mo · opex ${money(opts.opexMonthly)}/mo`);
  console.log(`  vendor terms ${opts.vendorTermsDays === 0 ? 'paid on the spot' : `net-${opts.vendorTermsDays}`}\n`);

  console.log(`  ${pad('month', 9)}${rpad('earned', 11)}${rpad('collected', 12)}${rpad('boost out', 12)}${rpad('opex', 9)}${rpad('net', 11)}${rpad('cash', 12)}`);
  for (const r of rows) {
    const flag = r.cash < 0 ? '  ❌' : r.cash < r.paid ? '  ⚠️' : '';
    console.log(`  ${pad(r.month, 9)}${rpad(money(r.earned), 11)}${rpad(money(r.collected), 12)}${rpad(money(-r.paid), 12)}${rpad(money(-r.opex), 9)}${rpad(money(r.net), 11)}${rpad(money(r.cash), 12)}${flag}`);
  }

  const trough = rows.reduce((a, r) => (r.cash < a.cash ? r : a), rows[0]);
  console.log(`\n  TROUGH  ${money(trough.cash)} in ${trough.month}`);
  if (trough.cash < 0) {
    console.log(`  ❌ You run out of money in ${trough.month}. Minimum extra cash needed today: ${money(-trough.cash)}.`);
  } else if (trough.cash < trough.paid) {
    console.log(`  ⚠️  Survives, but the trough is under one month of boost spend — no room for a late payment.`);
  } else {
    console.log(`  ✅ Stays solvent across the horizon.`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------
const lastCompleteMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

function printMonth(bk, { itemisedFloor }) {
  const L = (label, v, indent = '  ') => console.log(`${indent}${pad(label, 34)}${rpad(money(v), 12)}`);
  console.log(`\n=== BOOKS · ${bk.month} ===\n`);
  console.log('INCOME');
  L('Affiliate commission (Levanta)', bk.aff.commission);
  if (bk.manual.rtRevenue) L('RT service revenue', bk.manual.rtRevenue);
  if (bk.manual.ghostwriting) L('Ghostwriting', bk.manual.ghostwriting);
  if (bk.manual.digital) L('Digital products', bk.manual.digital);
  L('Total income', bk.income, '  → ');

  console.log('\nCOST OF REVENUE');
  L('Content boost spend', bk.boost.total);
  L('AI / LLM API', bk.llm);
  if (bk.manual.rtVendorCost) L('RT vendor costs (client)', bk.manual.rtVendorCost);
  if (bk.manual.rtRetainers) L('RT vendor retainers', bk.manual.rtRetainers);
  L('Total cost of revenue', bk.cogs, '  → ');
  console.log(`\n  GROSS PROFIT                      ${rpad(money(bk.gross), 12)}   ${bk.grossPct.toFixed(1)}%`);

  if (bk.opex) {
    console.log('\nOPERATING EXPENSES');
    if (bk.manual.software) L('Software & subscriptions', bk.manual.software);
    if (bk.manual.processingFees) L('Payment processing fees', bk.manual.processingFees);
    if (bk.manual.contractors) L('Contractors & VA', bk.manual.contractors);
    L('Total operating expenses', bk.opex, '  → ');
  }
  console.log(`\n  NET PROFIT                        ${rpad(money(bk.net), 12)}   ${bk.netPct.toFixed(1)}%\n`);

  // Cash timing — the whole reason a profitable month can still feel tight.
  // Levanta's calendar is FIXED and measured, not assumed: commission is invoiced at month end and
  // paid as one lump on the 2nd-3rd of month M+2 (June -> 2 Aug, July -> 2 Sep, Aug -> 3 Oct).
  // ~33 days after the month closes. It does not trickle in and it does not come earlier on request.
  const [y, m] = bk.month.split('-').map(Number);
  const expected = new Date(Date.UTC(y, m + 1, 3)).toISOString().slice(0, 10);
  console.log('CASH TIMING');
  console.log(`  ${pad('Earned this month', 34)}${rpad(money(bk.aff.commission), 12)}  (Levanta)`);
  console.log(`  ${pad('Cash expected (one lump)', 34)}${rpad(expected, 12)}  2nd-3rd of M+2, IF the brands paid Levanta in full`);
  console.log(`  ${pad('Costs paid inside the month', 34)}${rpad(money(bk.boost.total + bk.llm), 12)}  boost + API, paid up front\n`);

  if (bk.boost.vendors.size) {
    console.log(`VENDOR SPEND — reconcile against the Treasury/PayPal feed (${bk.boost.vendors.size} vendors)`);
    const sorted = [...bk.boost.vendors.entries()].sort((a, b) => b[1] - a[1]);
    for (const [v, amt] of sorted.slice(0, 15)) console.log(`  ${pad(String(v).slice(0, 40), 42)}${rpad(money(amt), 10)}`);
    if (sorted.length > 15) console.log(`  ${pad(`… ${sorted.length - 15} more`, 42)}${rpad(money(sorted.slice(15).reduce((a, x) => a + x[1], 0)), 10)}`);
    console.log('');
  }

  if (itemisedFloor) console.log(`⚠️  LLM cost ${money(bk.llm)} is a FLOOR — only threads carrying a genCost stamp are counted.\n    The authoritative figure is the "LLM Spend" table in the registry base; enter the difference\n    as a manual line if the provider invoice is materially higher.\n`);
  if (!bk.manual.rtRevenue && !bk.manual.ghostwriting) console.log(`ℹ️  No off-repo lines for ${bk.month}. RT service revenue (Stripe), ghostwriting and SaaS costs\n    live outside this repo — add them to books-manual.json for a complete P&L.\n`);
}

function printTrailing(months, ctx) {
  console.log(`\n=== BOOKS · trailing ${months.length} months ===\n`);
  console.log(`  ${pad('month', 9)}${rpad('income', 12)}${rpad('cogs', 12)}${rpad('gross', 12)}${rpad('margin', 9)}${rpad('net', 12)}`);
  for (const m of months) {
    const bk = buildMonth(m, ctx);
    console.log(`  ${pad(bk.month, 9)}${rpad(money(bk.income), 12)}${rpad(money(bk.cogs), 12)}${rpad(money(bk.gross), 12)}${rpad(bk.grossPct.toFixed(1) + '%', 9)}${rpad(money(bk.net), 12)}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const affiliate = affiliateByMonth(readJsonl('levanta-days.jsonl'));
  const facts = readJsonl('facts.jsonl');
  const boost = boostByMonth(facts);
  const llm = llmByMonth(facts);
  const manual = loadManual();
  const ctx = { affiliate, boost, llm, manual };

  if (TRAILING > 0) {
    const all = [...new Set([...affiliate.keys(), ...boost.keys()])].sort();
    printTrailing(all.slice(-TRAILING), ctx);
    return;
  }

  const month = cliArg('month', lastCompleteMonth());
  const bk = buildMonth(month, ctx);

  if (args.includes('--cashflow')) {
    const opts = {
      openingCash: Number(cliArg('cash', '0')),
      lagDays: Number(cliArg('lag', '33')),           // MEASURED, not assumed: Levanta invoices at month end and pays
                                                      // one lump on the 2nd-3rd of month M+2 (Jun->2 Aug, Jul->2 Sep,
                                                      // Aug->3 Oct). Fixed constraint, not a negotiable lever.
      growth: Number(cliArg('growth', '1')),          // 1 = flat. Growth makes the hole DEEPER, not shallower.
      horizon: Number(cliArg('horizon', '6')),
      opexMonthly: Number(cliArg('opex', '0')),
      vendorTermsDays: Number(cliArg('vendor-terms', '0')),
    };
    printCashflow(forecast({ affiliate, boost, ...opts }), opts);

    // Sensitivity — the two levers, priced. Everything else is noise next to these.
    console.log('SENSITIVITY — trough by collection lag (the risk you do not control)');
    for (const lag of [30, 45, 60, 90]) {
      const f = forecast({ affiliate, boost, ...opts, lagDays: lag });
      const t = f.rows.reduce((a, r) => (r.cash < a.cash ? r : a), f.rows[0]);
      console.log(`  lag ${String(lag).padStart(2)}d   trough ${rpad(money(t.cash), 12)} in ${t.month}${t.cash < 0 ? '   ❌' : ''}`);
    }
    console.log('\nSENSITIVITY — trough by vendor payment terms (the lever you DO control)');
    for (const vt of [0, 15, 30, 45]) {
      const f = forecast({ affiliate, boost, ...opts, vendorTermsDays: vt });
      const t = f.rows.reduce((a, r) => (r.cash < a.cash ? r : a), f.rows[0]);
      console.log(`  ${vt === 0 ? 'on the spot' : `net-${vt}`.padEnd(11)}   trough ${rpad(money(t.cash), 12)} in ${t.month}${t.cash < 0 ? '   ❌' : ''}`);
    }
    console.log('');
    return;
  }

  const csvPath = cliArg('import', null);
  if (csvPath) {
    const p = csvPath.startsWith('/') ? csvPath : join(process.cwd(), csvPath);
    if (!existsSync(p)) { console.error(`❌ no such file: ${p}`); process.exit(1); }
    const { txns, cols } = importStatement(readFileSync(p, 'utf8'), loadRules(), args.includes('--all-months') ? null : month);
    printImport(txns, cols, bk, args.includes('--all-months') ? null : month);
    return;
  }

  const itemisedFloor = bk.llm > 0 && bk.llm < bk.income * 0.01; // stamped cost implausibly small vs revenue
  printMonth(bk, { itemisedFloor });

  const lines = journalEntry(bk);
  if (lines.length) {
    console.log('JOURNAL ENTRY — key this into QuickBooks (revenue accrual only; costs come through the feed)');
    console.log(`  ${pad('account', 40)}${rpad('debit', 12)}${rpad('credit', 12)}`);
    for (const l of lines) console.log(`  ${pad(l.account, 40)}${rpad(l.debit ? money(l.debit) : '', 12)}${rpad(l.credit ? money(l.credit) : '', 12)}`);
    const dr = lines.reduce((a, l) => a + l.debit, 0), cr = lines.reduce((a, l) => a + l.credit, 0);
    console.log(`  ${pad('', 40)}${rpad(money(dr), 12)}${rpad(money(cr), 12)}   ${Math.abs(dr - cr) < 0.005 ? '✅ balanced' : '❌ OUT OF BALANCE'}\n`);

    if (WRITE_CSV) {
      const dir = join(HERE_DIR, 'books');
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `qbo-journal-${bk.month}.csv`);
      writeFileSync(p, journalCsv(bk, lines));
      console.log(`📄 wrote ${p}\n`);
    }
  }

  if (SEND) {
    const env = loadEnv();
    requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
    const top = [...bk.boost.vendors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([v, a]) => `  ${esc(String(v).slice(0, 28))} ${money(a)}`).join('\n');
    await telegram(env, report({
      emoji: '📒', title: 'Monthly books', scope: bk.month,
      status: `${money(bk.income)} income · ${money(bk.cogs)} cost · <b>${money(bk.net)} net</b> (${bk.netPct.toFixed(0)}%)`,
      sections: [
        { label: 'Income', body: `Affiliate ${money(bk.aff.commission)}${bk.manual.rtRevenue ? `\nRT service ${money(bk.manual.rtRevenue)}` : ''}${bk.manual.ghostwriting ? `\nGhostwriting ${money(bk.manual.ghostwriting)}` : ''}` },
        { label: 'Cost of revenue', body: `Boost ${money(bk.boost.total)}\nLLM ${money(bk.llm)}` },
        top ? { label: 'Top vendors', body: top } : null,
      ].filter(Boolean),
      action: 'Post the journal entry, then reconcile vendor spend against the feed.',
    }), 'books');
    console.log('📨 digest sent.\n');
  }
}

// Guarded so the module can be imported for its exports without running the CLI —
// tests/books-rules.test.mjs relies on this.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'books');
