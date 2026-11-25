// ---------------------------------------------------------------------------------------------
// stripe-sync — pull Stripe's two ledgers into the same shape books.mjs already understands.
//
//   node stripe-sync.mjs --month 2026-09             the FINANCIAL ACCOUNT  -> QuickBooks "Stripe Treasury" (a bank)
//   node stripe-sync.mjs --balance --month 2026-09   the PAYMENTS BALANCE   -> QuickBooks "Stripe Balance" (a clearing account)
//
// WHY THIS EXISTS, given that a bank feed would be less work:
//
// QuickBooks cannot connect a bank feed to a Stripe financial account through any API — feed
// connection is a UI-only handshake — so the fallback was always a CSV export. But the export is
// strictly worse than the API for the one question that matters most here.
//
// Two revenue streams were expected to arrive through Stripe and look alike once flattened into
// Date/Description/Amount: Levanta's affiliate commission, and RT bot client billing. Mis-sort them
// and a Levanta lump gets booked as income, double-counting revenue books.mjs already journalled
// against the receivable (docs/quickbooks-setup.md §4, §6a).
//
// THE FINANCIAL ACCOUNT. Every transaction carries a `category` — the v2 name for what the v1
// Treasury API called `flow_type`:
//
//   received_credit       money arriving from OUTSIDE (an ACH/wire into this account)
//   received_debit        money pulled OUT by an outside party (an ACH debit, or Stripe's own sweep)
//   inbound_transfer      money pulled in from an account you own -> from the Stripe payments balance
//   outbound_transfer     money out to an account you own -> the Payoneer draw
//   outbound_payment      money out to a third party -> vendor payment
//   return / adjustment   money coming back, or a Stripe-initiated correction
//
// THE PAYMENTS BALANCE is where the money actually is today (2026-09-07: the financial account has
// carried $15 in its life). RT invoices settle here as charges, Gumroad orders arrive as Connect
// charges, Stripe bills its fees here, and payouts leave from here. `--balance` reads
// /v1/balance_transactions and emits every entry GROSS, with each fee component as its own [fee]
// row, tagged with Stripe's own `reporting_category`:
//
//   [charge]              a sale — RT client billing, or a Gumroad order (the gumroad rule wins first)
//   [refund] [dispute]    a sale undone — reworded to name the sale, so the same vendor rule catches it
//   [fee]                 Stripe processing fees, Gumroad's application fee, dispute fees, tax on Stripe's bill
//   [payout]              money leaving for the payout bank — a transfer, never revenue
//   [topup]               money arriving from the financial account — a transfer
//
// Minimum-balance hold/release pairs are skipped: Stripe reserving money inside the same balance,
// nothing moves. The rows must net to Stripe's own `net` for the month, or nothing is written.
//
// Either way the tag survives into the emitted description, so books-rules.json can sort on
// mechanism instead of guessing from a date. A CSV export cannot carry it.
//
// WHICH STRIPE API (2026-09-07). This account was never onboarded to Treasury v1: every
// /v1/treasury/* call answers `400 Unrecognized request URL`. Its one financial account is a v2
// money-management `storage` FinancialAccount, readable only under a v2-capable Stripe-Version
// (see STRIPE_VERSION, sent for /v2/ calls only). Shape differences from v1: `created` is an ISO
// string, `amount` is {value, currency}, the mechanism is `category` (with `flow.type` as the
// fallback), unsettled rows are `pending` rather than `open` — all absorbed in
// normalizeTransactions — and lists page with `next_page_url` (getAll) instead of
// `has_more`/`starting_after` (getAllV1, still what /v1/balance_transactions speaks).
//
// WHAT THE FIRST LIVE RUN SHOWED (2026-09-07). RT client billing lands on the payments balance and
// pays out to the external bank; Levanta pays a separate Stripe Express account. Neither stream
// reaches the financial account until payouts are re-pointed at it (§5). So the [received_credit]
// rule in books-rules.json has no real data behind it yet — the only received_credit on record is
// an internal balance transfer, now caught by its own rule.
//
// USAGE
//   node stripe-sync.mjs --month 2026-09                     # financial account: fetch, summarise, write CSV
//   node stripe-sync.mjs --balance --month 2026-09           # payments balance: same, gross + [fee] rows
//   node stripe-sync.mjs --month 2026-09 --out fa.csv        # choose the output path
//   node stripe-sync.mjs --month 2026-09 --account fa_…      # pick a financial account
//   node stripe-sync.mjs --accounts                          # list financial accounts and exit
//
// Default output names follow the QuickBooks account each ledger belongs to:
// stripe-treasury-YYYY-MM.csv and stripe-balance-YYYY-MM.csv (both gitignored — real financials).
// The CSV is accepted BOTH by `books.mjs --import` and by QuickBooks' Transactions -> Bank
// transactions -> Upload from file (bank accounts only, so the balance CSV is for books.mjs and a
// journal entry — §5b). Needs STRIPE_SECRET_KEY in .env or the environment; a restricted key with
// read-only financial-account, transaction, balance and charge scopes is enough. Read-only against
// Stripe: it issues GETs and never writes.
// ---------------------------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, cliArg, runMain } from './lib.mjs';

const API = 'https://api.stripe.com';

/**
 * The v2 money-management namespace only answers under a v2-capable API version; without this
 * header the same key gets the account's pinned version and a 400. Proven against the live
 * account on 2026-09-07. Sent for /v2/ calls only, so v1 responses keep their known shape.
 */
export const STRIPE_VERSION = '2026-08-26.preview';

/** What each tag means for the books. Description only — the rules file decides. */
export const FLOW_MEANING = {
  // financial account
  received_credit: 'money in from OUTSIDE — an ACH/wire into this account (an internal balance transfer lands here too)',
  received_debit: 'money pulled OUT by an outside party — an ACH debit, or Stripe sweeping the balance back to payments',
  inbound_transfer: 'money pulled in from your own external account',
  outbound_transfer: 'money out to your own external account — the Payoneer draw',
  outbound_payment: 'money out to a third party — vendor payment',
  issuing_authorization: 'card spend',
  return: 'money coming back from a failed outbound payment or transfer',
  adjustment: 'a Stripe-initiated correction',
  credit_reversal: 'a reversal of money in',
  debit_reversal: 'a reversal of money out',
  // payments balance
  charge: 'a sale settling on the payments balance — RT client billing, or a Gumroad order — gross',
  refund: 'a sale refunded — reworded to name the sale it undoes',
  dispute: 'a chargeback — reworded to name the sale it undoes; the dispute fee is its own [fee] row',
  fee: 'Stripe processing fees, Gumroad application fees, dispute fees, sales tax on Stripe\'s own bill',
  payout: 'money leaving for the payout bank — a transfer, never revenue',
  topup: 'money arriving from the financial account — a transfer',
};

/**
 * The financial-account tag. v2 `category` first: it is the transaction's own classification, so
 * a returned vendor payment reads [return] rather than inheriting [outbound_payment] from the flow
 * that spawned it — and a positive amount tagged as an outbound payment is exactly the kind of
 * row that gets mis-sorted. `flow.type` is the fallback; v1's `flow_type` is kept so the older
 * shape still normalises.
 */
export function flowTypeOf(t) {
  return t.category || t.flow?.type || t.flow_type || 'unknown';
}

/**
 * Minor units, whichever shape Stripe sends: v2 `{value, currency}` or v1's bare integer. Anything
 * unreadable throws — a NaN would otherwise sail into the CSV's Amount column as a corrupt row.
 */
export function minorAmount(t) {
  const raw = t.amount && typeof t.amount === 'object' ? t.amount.value : t.amount;
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(n)) {
    throw new Error(`transaction ${t.id || '(no id)'} has no usable amount (${JSON.stringify(t.amount)}) — refusing to write a corrupt row`);
  }
  return n;
}

/** YYYY-MM-DD from v2's ISO timestamp or v1's epoch seconds. */
export function isoDate(created) {
  const d = typeof created === 'number' ? new Date(created * 1000) : new Date(created);
  if (Number.isNaN(d.getTime())) throw new Error(`unreadable created timestamp: ${JSON.stringify(created)}`);
  return d.toISOString().slice(0, 10);
}

/**
 * The month as a half-open window [first instant, first instant of next month). The upper bound is
 * EXCLUSIVE on purpose: v2 `created` carries milliseconds, so a `created_lte` cut at 23:59:59 would
 * lose a transaction stamped in the last fraction of a second — to this month and to the next.
 */
export function monthWindow(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month));
  const y = m && Number(m[1]), mo = m && Number(m[2]);
  if (!m || mo < 1 || mo > 12) throw new Error(`--month wants YYYY-MM, got "${month}"`);
  const start = new Date(Date.UTC(y, mo - 1, 1)), next = new Date(Date.UTC(y, mo, 1));
  return { gte: start.toISOString(), lt: next.toISOString(), gteSec: Math.floor(start.getTime() / 1000), ltSec: Math.floor(next.getTime() / 1000) };
}

/** An absolute URL from a path or a `next_page_url`, with params appended to whatever query is already there. */
export function joinUrl(pathOrUrl, params = {}) {
  const base = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${API}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
}

/**
 * Financial-account Transaction objects -> the flat {date, description, amount} rows that
 * books.mjs --import and QuickBooks' file upload both accept.
 *
 * Only `posted` transactions count. A `pending` one (v1 called it `open`) has not settled and a
 * `void` one never will, so booking either would put money in the ledger that no bank ever moved.
 * Amounts arrive in the currency's minor unit and signed from the account's point of view, which
 * is already the convention the importer wants (money out negative).
 */
export function normalizeTransactions(txns) {
  const rows = [];
  const skipped = {};
  for (const t of txns) {
    if (t.status !== 'posted') { skipped[t.status] = (skipped[t.status] || 0) + 1; continue; }
    const flowType = flowTypeOf(t);
    const text = (t.description || '').trim() || flowType;
    rows.push({
      date: isoDate(t.created),
      // The tag is the whole point: it survives into the CSV so a rule can match the mechanism.
      // Leading text stays first so existing vendor-name patterns still hit.
      description: `${text} [${flowType}]`,
      amount: minorAmount(t) / 100,
      flowType,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, skipped };
}

// ---------------------------------------------------------------------------------------------
// The payments balance.
// ---------------------------------------------------------------------------------------------

/** Stripe reserving money inside the same balance around a payout. Nothing leaves; nothing to book. */
const RESERVATIONS = new Set(['payout_minimum_balance_hold', 'payout_minimum_balance_release']);

const idOf = (s) => (s && typeof s === 'object' ? s.id : s) || null;

/**
 * The words a balance row leads with: Stripe's description, plus who paid when it was a sale
 * (a "Payment for Invoice" row says nothing else), and for a refund or chargeback the sale it
 * undoes — so the same vendor rule catches both sides. `charges` maps a charge id to the charge's
 * own balance transaction (or a stand-in built from a fetched Charge); unresolvable ones keep
 * Stripe's text, and the tag still routes them.
 */
export function balanceText(t, charges = new Map(), customers = new Map()) {
  const cat = t.reporting_category || t.type || 'unknown';
  const src = t.source && typeof t.source === 'object' ? t.source : null;
  let text = (t.description || src?.description || '').trim() || cat;
  if (cat === 'charge') {
    // A card-holder name is on the charge; an invoice paid by Link or wallet often has none, and
    // then the Customer record (fetched once per customer by the caller) is what names the client.
    const cust = customers.get(idOf(src?.customer)) || {};
    const who = src?.billing_details?.name || cust.name || src?.billing_details?.email || src?.receipt_email || cust.email || '';
    if (who) text = `${text} · ${who}`;
  }
  if (cat === 'refund' || cat === 'dispute') {
    const orig = charges.get(idOf(src?.charge));
    if (orig) text = `${cat === 'dispute' ? 'Chargeback' : 'Refund'} of ${balanceText(orig, charges, customers)}`;
  }
  return text;
}

/**
 * The tag for a balance row. A refund or chargeback whose sale could NOT be read (the charge lookup
 * failed) is tagged `unresolved_<category>`: no rule matches it, so it lands in the importer's
 * uncategorised list where a human sees it — rather than sliding through `[dispute]` into RT
 * revenue when it was really a Gumroad order. Stripe's own text still names the sale when it can.
 */
export function balanceTag(t, charges = new Map(), unresolved = new Set()) {
  const cat = t.reporting_category || t.type || 'unknown';
  if (cat !== 'refund' && cat !== 'dispute') return cat;
  const chargeId = idOf((t.source && typeof t.source === 'object' ? t.source : null)?.charge);
  return chargeId && !charges.has(chargeId) && unresolved.has(chargeId) ? `unresolved_${cat}` : cat;
}

/**
 * Balance transactions -> rows, GROSS, with every fee component as its own [fee] row. Charges,
 * refunds, disputes, Stripe's own fee bills, payouts and top-ups all come through; only the
 * minimum-balance reservations are dropped. `pending` here means "not yet available for payout",
 * not "not yet real", so those rows are kept and counted. Returns Stripe's own net for the month
 * so the caller can refuse to write rows that do not tie to it.
 */
export function normalizeBalanceTransactions(txns, { charges = new Map(), customers = new Map(), unresolved = new Set() } = {}) {
  const known = new Map(charges);
  for (const t of txns) if (t.reporting_category === 'charge' && idOf(t.source)) known.set(idOf(t.source), t);
  const rows = [];
  const skipped = { reservations: 0 };
  let pending = 0, ledgerNet = 0;
  for (const t of txns) {
    const cat = balanceTag(t, known, unresolved);
    if (RESERVATIONS.has(cat)) { skipped.reservations++; continue; }
    if (t.status === 'pending') pending++;
    const gross = minorAmount(t);
    const fees = (t.fee_details || []).map((f) => {
      const fee = Number(f.amount);
      if (!Number.isFinite(fee)) throw new Error(`transaction ${t.id || '(no id)'} has an unreadable fee (${JSON.stringify(f)})`);
      return { fee, label: f.description || f.type || 'Fee' };
    });
    ledgerNet += Number.isFinite(Number(t.net)) && t.net !== null ? Number(t.net) : gross - fees.reduce((a, f) => a + f.fee, 0);
    const date = isoDate(t.created);
    const text = balanceText(t, known, customers);
    rows.push({ date, description: `${text} [${cat}]`, amount: gross / 100, flowType: cat });
    for (const f of fees) {
      if (!f.fee) continue;
      rows.push({ date, description: `${f.label} on ${text} [fee]`, amount: -f.fee / 100, flowType: 'fee' });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, skipped, pending, ledgerNet: ledgerNet / 100 };
}

/** Date,Description,Amount — the shape books.mjs --import and QuickBooks both read. */
export function toCsv(rows) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return ['Date,Description,Amount', ...rows.map((r) => `${r.date},${esc(r.description)},${r.amount.toFixed(2)}`)].join('\n') + '\n';
}

/** GET one Stripe page. Kept deliberately thin — everything worth testing lives above this line. */
async function get(key, pathOrUrl, params = {}) {
  const url = joinUrl(pathOrUrl, params);
  const headers = { Authorization: `Bearer ${key}` };
  if (url.includes('/v2/')) headers['Stripe-Version'] = STRIPE_VERSION;
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = body?.error?.message || res.statusText;
    const hint = res.status === 401 ? 'is STRIPE_SECRET_KEY the key itself (sk_live_/rk_live_) rather than its dashboard ID?'
      : res.status === 403 ? 'restricted key? it needs read access to financial accounts, transactions, balance transactions, charges and customers'
      : res.status === 404 ? 'no such object on this account — a mistyped --account, or a key for a different Stripe account?'
      : /Unrecognized request URL/i.test(m) ? `the v2 money-management namespace needs Stripe-Version ${STRIPE_VERSION}; is this a live key on the right account?`
      : '';
    const err = new Error(`Stripe ${res.status}: ${m}${hint ? `\n  (${hint})` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * Page through a v2 list: Stripe hands back `next_page_url` until there is nothing more. v2 lists
 * cap `limit` at 20 (v1 allowed 100), so the page budget is sized for a busy month, not a busy day.
 */
async function getAll(key, path, params) {
  const out = [];
  let next = null;
  for (let page = 0; page < 500; page++) {
    const body = next ? await get(key, next) : await get(key, path, { ...params, limit: '20' });
    out.push(...(body.data || []));
    next = body.next_page_url || null;
    if (!next) break;
  }
  return out;
}

/** Page through a v1 list: `has_more` + `starting_after`, 100 per page. */
async function getAllV1(key, path, params) {
  const out = [];
  let starting_after;
  for (let page = 0; page < 200; page++) {
    const body = await get(key, path, { ...params, limit: '100', ...(starting_after ? { starting_after } : {}) });
    out.push(...(body.data || []));
    if (!body.has_more || !body.data?.length) break;
    starting_after = body.data[body.data.length - 1].id;
  }
  return out;
}

function printByTag(rows, heading) {
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.flowType) || { n: 0, total: 0 };
    e.n++; e.total += r.amount; by.set(r.flowType, e);
  }
  console.log(`${heading}\n`);
  for (const [tag, e] of [...by.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${tag.padEnd(22)} ${String(e.n).padStart(3)} row  ${e.total.toFixed(2).padStart(12)}`);
    console.log(`  ${' '.repeat(22)}     ${FLOW_MEANING[tag] || ''}`);
  }
}

/**
 * The payments balance for one month, ready for the books: rows, the tie-out against Stripe's own
 * net, and what the key could and could not read. No printing, no file — the CLI below and
 * books-weekly.mjs both build on this.
 */
export async function fetchBalance(key, month) {
  const w = monthWindow(month);
  const window = { 'created[gte]': String(w.gteSec), 'created[lt]': String(w.ltSec) };
  // Expanding the source is what puts a customer name on a "Payment for Invoice" row and lets a
  // refund or chargeback find its sale. A key without charge scope still gets the ledger.
  let txns, expanded = true;
  try { txns = await getAllV1(key, '/v1/balance_transactions', { ...window, 'expand[]': 'data.source' }); }
  catch (e) {
    if (e.status !== 403 && !/expand|permission/i.test(e.message)) throw e;
    expanded = false;
    txns = await getAllV1(key, '/v1/balance_transactions', window);
  }
  // A refund or chargeback of a sale from an earlier month: fetch that charge once so the row can
  // still name it. Any failure keeps Stripe's own text; the tag routes it regardless.
  const charges = new Map();
  const unresolved = new Set();
  if (expanded) {
    const inMonth = new Set(txns.filter((t) => t.reporting_category === 'charge').map((t) => idOf(t.source)));
    const missing = [...new Set(txns.filter((t) => t.reporting_category === 'refund' || t.reporting_category === 'dispute')
      .map((t) => idOf(t.source?.charge)).filter((id) => id && !inMonth.has(id)))];
    for (const id of missing) {
      try { const c = await get(key, `/v1/charges/${id}`); charges.set(id, { reporting_category: 'charge', description: c.description, source: c }); }
      catch (e) { unresolved.add(id); console.warn(`charge ${id} could not be read (${e.message.split('\n')[0]}) — its refund/chargeback is tagged unresolved_* and will surface as uncategorised`); }
    }
  }
  // A charge with no card-holder name still knows its Customer. One fetch per customer names the
  // client on every row; the first permission failure stops the lookups rather than repeating them.
  const customers = new Map();
  let customerLookup = expanded ? 'ok' : 'skipped';
  if (expanded) {
    const wanted = [...new Set(txns.filter((t) => t.reporting_category === 'charge' && !t.source?.billing_details?.name)
      .map((t) => idOf(t.source?.customer)).filter(Boolean))];
    for (const id of wanted) {
      try { const c = await get(key, `/v1/customers/${id}`); customers.set(id, { name: c.name || '', email: c.email || '' }); }
      catch (e) { customerLookup = e.status === 403 ? 'forbidden' : 'failed'; if (e.status === 403) break; }
    }
  }
  const { rows, skipped, pending, ledgerNet } = normalizeBalanceTransactions(txns, { charges, customers, unresolved });
  const rowsNet = rows.reduce((a, r) => a + r.amount, 0);
  return { month, rows, skipped, pending, ledgerNet, rowsNet, ties: Math.abs(rowsNet - ledgerNet) < 0.005, expanded, customerLookup, unresolvedCharges: unresolved.size };
}

/** The financial account for one month: which account, and its posted rows. No printing, no file. */
export async function fetchFinancialAccount(key, month, account) {
  const accounts = await getAll(key, '/v2/money_management/financial_accounts', {});
  if (!accounts.length) throw new Error('No financial accounts on this Stripe account.');
  const fa = account || accounts[0].id;
  const w = monthWindow(month);
  const txns = await getAll(key, '/v2/money_management/transactions', { financial_account: fa, created_gte: w.gte, created_lt: w.lt });
  const { rows, skipped } = normalizeTransactions(txns);
  return { month, fa, accounts, txns, rows, skipped };
}

async function balanceMonth(key, month) {
  const b = await fetchBalance(key, month);
  console.log(`\n=== STRIPE PAYMENTS BALANCE · ${month} ===\n`);
  if (!b.expanded) console.log('  (this key cannot read charge details — rows keep Stripe\'s own text, without customer names)\n');
  else if (b.customerLookup === 'forbidden') console.log('  (this key cannot read customers — unnamed invoice payments stay unnamed; add Customers: read to the restricted key)\n');
  if (b.unresolvedCharges) console.log(`  ⚠️  ${b.unresolvedCharges} refund/chargeback sale(s) could not be read — those rows are tagged unresolved_* and will show as uncategorised\n`);
  if (!b.rows.length) { console.log('  No balance transactions in this month.\n'); return; }

  printByTag(b.rows, 'BY FLOW TYPE — gross, every fee its own [fee] row');
  console.log(`\n  rows net ${b.rowsNet.toFixed(2).padStart(12)}   Stripe's own net ${b.ledgerNet.toFixed(2).padStart(12)}   ${b.ties ? '✅ ties out' : '❌ DOES NOT TIE'}`);
  if (b.skipped.reservations) console.log(`  skipped ${b.skipped.reservations} minimum-balance hold/release entries — money never leaves the balance`);
  if (b.pending) console.log(`  ${b.pending} still pending payout availability — real money, included`);
  if (!b.ties) throw new Error(`rows net ${b.rowsNet.toFixed(2)} but Stripe says ${b.ledgerNet.toFixed(2)} for ${month} — not writing a CSV that would not reconcile`);

  const out = cliArg('out', `stripe-balance-${month}.csv`);
  writeFileSync(out, toCsv(b.rows));
  console.log(`\n  ${b.rows.length} rows -> ${out}`);
  console.log(`\n  Next: node books.mjs --month ${month} --import ${out}`);
  console.log('  In QuickBooks this ledger is the Stripe Balance clearing account — a journal entry or the Stripe feed, not a file upload (§5b).\n');
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['STRIPE_SECRET_KEY']);
  const key = env.STRIPE_SECRET_KEY;
  const args = process.argv.slice(2);
  const month = cliArg('month', new Date().toISOString().slice(0, 7));

  if (args.includes('--balance')) return balanceMonth(key, month);

  if (args.includes('--accounts')) {
    const accounts = await getAll(key, '/v2/money_management/financial_accounts', {});
    if (!accounts.length) throw new Error('No financial accounts on this Stripe account.');
    const usd = (bal) => ((bal?.usd?.value ?? 0) / 100).toFixed(2);
    console.log('\nSTRIPE FINANCIAL ACCOUNTS (v2 money management)\n');
    for (const a of accounts) {
      console.log(`  ${a.id}${a.display_name ? `   "${a.display_name}"` : ''}`);
      console.log(`    type ${(a.type || '?').padEnd(8)} status ${(a.status || '?').padEnd(8)} available ${usd(a.balance?.available)} USD   inbound pending ${usd(a.balance?.inbound_pending)}   outbound pending ${usd(a.balance?.outbound_pending)}`);
    }
    console.log('');
    return;
  }

  const { fa, txns, rows, skipped } = await fetchFinancialAccount(key, month, cliArg('account', null));
  console.log(`\n=== STRIPE FINANCIAL ACCOUNT · ${month} · ${fa} ===\n`);
  if (!rows.length) {
    console.log('  No posted transactions in this month.\n');
    if (txns.length) console.log(`  (${txns.length} unposted: ${JSON.stringify(skipped)})\n`);
    return;
  }

  // The category breakdown is the useful part on screen: it answers §6a's open question outright.
  printByTag(rows, 'BY FLOW TYPE — this is what a CSV export cannot tell you');

  const out = cliArg('out', `stripe-treasury-${month}.csv`);
  writeFileSync(out, toCsv(rows));
  console.log(`\n  ${rows.length} posted rows -> ${out}`);
  if (Object.keys(skipped).length) console.log(`  skipped unposted: ${JSON.stringify(skipped)}`);
  console.log(`\n  Next: node books.mjs --month ${month} --import ${out}`);
  console.log('  Or upload it to QuickBooks under Transactions -> Bank transactions -> Stripe Treasury.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'stripe-sync');
