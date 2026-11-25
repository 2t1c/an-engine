// ---------------------------------------------------------------------------------------------
// paypal-sync — pull the PayPal account's activity into the same shape books.mjs already
// understands. PayPal is where most vendor spend actually happens (docs/quickbooks-setup.md §5),
// and its QuickBooks bank feed already exists — this is the categorisation + reconciliation side,
// so a boost payment to a vendor lands in `Content Boost Spend` by rule and the month's vendor
// total can be checked against facts.jsonl.
//
//   node paypal-sync.mjs --month 2026-09                 # fetch, summarise, write paypal-2026-09.csv
//   node paypal-sync.mjs --month 2026-09 --out pp.csv    # choose the output path
//   node paypal-sync.mjs --month 2026-09 --all-currencies
//
// Source: the Transaction Search API (GET /v1/reporting/transactions, up to 31 days per call — a
// month fits). Needs PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET from a LIVE REST app in
// developer.paypal.com with the "Transaction Search" feature ticked; PayPal lags real activity by
// a few hours. Read-only: an OAuth token and GETs, never a write.
//
// Every transaction carries an EVENT CODE (T0006 = express checkout, T0400 = bank withdrawal…)
// and the two-digit family is what the books need. It becomes the [tag] on each row:
//
//   [payment]              T00xx  money to or from another PayPal account — a vendor paid, a client paying you
//   [fee]                  T01xx  PayPal's own non-payment fees; per-transaction fees are their own [fee] rows too
//   [currency_conversion]  T02xx  one leg each side of a conversion — own money, a transfer
//   [bank_deposit]         T03xx  money in from a bank — a transfer
//   [bank_withdrawal]      T04xx  money out to a bank — a transfer (Payoneer = owner draw on that side)
//   [card]                 T05xx–T07xx  PayPal debit/credit card spend — a vendor, by name
//   [reversal]             T11xx  a refund or chargeback, either direction
//   [adjustment]           T12xx  PayPal corrections
//   [funds_transfer]       T20xx/T22xx  between PayPal accounts you own
//
// Authorisations (T13xx) and holds (T15xx) are not money moving and are skipped, as is anything
// not in status S (successful): pending, denied and reversed entries are counted, not booked.
// Rows come out in USD by default; other currencies are counted and left out unless
// --all-currencies, because books.mjs sums the Amount column as one currency.
// ---------------------------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, cliArg, runMain } from './lib.mjs';
import { monthWindow, toCsv } from './stripe-sync.mjs';

const API = 'https://api-m.paypal.com';

/** Event-code family (the two digits after the T) -> books tag. Unknown families keep their code. */
export const EVENT_FAMILIES = {
  '00': 'payment', '01': 'fee', '02': 'currency_conversion', '03': 'bank_deposit', '04': 'bank_withdrawal',
  '05': 'card', '06': 'card', '07': 'card', '08': 'bonus', '09': 'incentive', '10': 'bill_pay',
  '11': 'reversal', '12': 'adjustment', '13': 'authorization', '14': 'dividend', '15': 'hold',
  '16': 'buyer_credit', '17': 'non_bank_withdrawal', '18': 'buyer_credit_payment', '19': 'account_correction',
  '20': 'funds_transfer', '21': 'reserves', '22': 'funds_transfer', '30': 'generic',
};
export const NOT_MONEY = new Set(['authorization', 'hold']);

export function eventTag(code) {
  const m = /^T(\d{2})\d{2}$/i.exec(String(code || '').trim());
  return m ? (EVENT_FAMILIES[m[1]] || `paypal_t${m[1]}`) : 'unknown';
}

/** Who is on the other side: PayPal's alternate full name, else given+surname, else the email. */
export function counterparty(d) {
  const p = d.payer_info || {};
  const n = p.payer_name || {};
  return n.alternate_full_name || [n.given_name, n.surname].filter(Boolean).join(' ').trim() || p.email_address || '';
}

/**
 * Transaction Search `transaction_details` -> rows. Amounts are already signed from the account's
 * point of view (money out negative) and fees arrive negative, which is what the importer wants.
 */
export function normalizePaypal(details, { currency = 'USD', allCurrencies = false } = {}) {
  const rows = [];
  const skipped = {};
  const bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  for (const d of details) {
    const info = d.transaction_info || {};
    const tag = eventTag(info.transaction_event_code);
    if (NOT_MONEY.has(tag)) { bump(tag); continue; }
    const status = info.transaction_status || '?';
    if (status !== 'S') { bump({ P: 'pending', D: 'denied', V: 'reversed' }[status] || status); continue; }
    const cur = info.transaction_amount?.currency_code || currency;
    if (!allCurrencies && cur !== currency) { bump(`other_currency:${cur}`); continue; }
    const amount = Number(info.transaction_amount?.value);
    if (!Number.isFinite(amount)) throw new Error(`PayPal ${info.transaction_id || '(no id)'} has no usable amount (${JSON.stringify(info.transaction_amount)})`);
    const when = info.transaction_initiation_date || info.transaction_updated_date;
    const date = String(when || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`PayPal ${info.transaction_id || '(no id)'} has no usable date (${JSON.stringify(when)})`);
    const items = (d.cart_info?.item_details || []).map((i) => i.item_name).filter(Boolean).join(', ');
    const subject = (info.transaction_subject || info.transaction_note || items || '').trim();
    const who = counterparty(d);
    let text = [subject, who].filter(Boolean).join(' · ') || tag;
    if (cur !== 'USD') text += ` (${cur})`;
    rows.push({ date, description: `${text} [${tag}]`, amount, flowType: tag, currency: cur });
    const fee = Number(info.fee_amount?.value || 0);
    if (!Number.isFinite(fee)) throw new Error(`PayPal ${info.transaction_id || '(no id)'} has an unreadable fee (${JSON.stringify(info.fee_amount)})`);
    if (fee) rows.push({ date, description: `PayPal fee on ${text} [fee]`, amount: fee, flowType: 'fee', currency: cur });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, skipped };
}

/** PayPal wants RFC 3339 without milliseconds. */
const stamp = (iso) => iso.replace(/\.\d{3}Z$/, 'Z');

async function token(env) {
  const base = env.PAYPAL_API_BASE || API;
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal OAuth ${res.status}: ${body.error_description || body.error || res.statusText}\n  (is this a LIVE app's client id + secret, in .env as PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET?)`);
  return body.access_token;
}

/** The month's transactions, every page. Throws with PayPal's own message and the usual cause. */
export async function fetchPaypal(env, month, opts = {}) {
  requireEnv(env, ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
  const base = env.PAYPAL_API_BASE || API;
  const w = monthWindow(month);
  const bearer = await token(env);
  const details = [];
  for (let page = 1; page <= 50; page++) {
    const qs = new URLSearchParams({
      start_date: stamp(w.gte), end_date: stamp(new Date(w.ltSec * 1000 - 1000).toISOString()),
      fields: 'all', page_size: '500', page: String(page),
    });
    const res = await fetch(`${base}/v1/reporting/transactions?${qs}`, { headers: { Authorization: `Bearer ${bearer}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const m = body.message || body.name || res.statusText;
      const hint = res.status === 403 ? '\n  (the REST app needs the "Transaction Search" feature ticked in developer.paypal.com, then a few minutes)' : '';
      throw new Error(`PayPal ${res.status}: ${m}${hint}`);
    }
    details.push(...(body.transaction_details || []));
    if (page >= Number(body.total_pages || 1)) break;
  }
  return { month, details, ...normalizePaypal(details, opts) };
}

async function main() {
  const env = loadEnv();
  const month = cliArg('month', new Date().toISOString().slice(0, 7));
  const allCurrencies = process.argv.includes('--all-currencies');
  const { rows, skipped, details } = await fetchPaypal(env, month, { allCurrencies });

  console.log(`\n=== PAYPAL · ${month} ===\n`);
  if (!rows.length) {
    console.log(`  No successful USD transactions in this month.${details.length ? ` (${details.length} entries: ${JSON.stringify(skipped)})` : ''}\n`);
    return;
  }
  const by = new Map();
  for (const r of rows) { const e = by.get(r.flowType) || { n: 0, total: 0 }; e.n++; e.total += r.amount; by.set(r.flowType, e); }
  console.log('BY FLOW TYPE — from the event code, which a CSV export flattens away\n');
  for (const [tag, e] of [...by.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${tag.padEnd(22)} ${String(e.n).padStart(3)} row  ${e.total.toFixed(2).padStart(12)}`);
  }
  if (Object.keys(skipped).length) console.log(`\n  not booked: ${JSON.stringify(skipped)}`);
  const out = cliArg('out', `paypal-${month}.csv`);
  writeFileSync(out, toCsv(rows));
  console.log(`\n  ${rows.length} rows -> ${out}`);
  console.log(`\n  Next: node books.mjs --month ${month} --import ${out}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'paypal-sync');
