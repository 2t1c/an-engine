// ---------------------------------------------------------------------------------------------
// books-weekly — the Monday books pulse and the 2nd-of-month close, for the 📒 Books topic.
//
// Pulls every ledger this repo can read — the Stripe payments balance (RT invoices, Gumroad, fees,
// payouts), the Stripe financial account, and PayPal when its keys exist — categorises each through
// the SAME path as `books.mjs --import` (rows -> CSV -> importStatement, so the digest can never
// disagree with the CLI). Default and --close emit one monthly card; --weekly emits the previous
// complete Monday–Sunday UTC period and refreshes the current month-to-date card. Compact cards
// link to this run's detailed per-ledger checks and CSV evidence.
//
// The CSVs land in books/ (gitignored) for the QuickBooks journal; the workflow attaches them to
// the run. Nothing here writes to Stripe, PayPal, QuickBooks or Airtable except the Ops Log line.
//
//   node books-weekly.mjs                     # this month so far, printed (dry)
//   node books-weekly.mjs --month 2026-08     # a specific month
//   node books-weekly.mjs --weekly           # last completed UTC week + month to date
//   node books-weekly.mjs --weekly --week-start 2026-08-31 # completed-week backfill + current MTD
//   node books-weekly.mjs --close             # the month that just ended (the 2nd-of-month run)
//   node books-weekly.mjs --send              # post to Telegram — what the cron does
// ---------------------------------------------------------------------------------------------
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, runMain, telegramCard, report, esc, anthropic, logRun, HERE_DIR } from './lib.mjs';
import { COMMAND_CENTER_CHAT_ID } from './config.mjs';
import { fetchBalance, fetchFinancialAccount, toCsv } from './stripe-sync.mjs';
import { fetchPaypal } from './paypal-sync.mjs';
import { importStatement, loadRules, boostByMonth } from './books.mjs';
import { composeBooksCard, parseChart, DEFAULT_CHART } from './books-card.mjs';
export { composeBooksCard } from './books-card.mjs';

/** The chart with account types (income / cost / balance sheet), so the card books every account. */
export function chartWithTypes() {
  const p = join(HERE_DIR, 'books-chart-of-accounts.csv');
  try { const chart = parseChart(readFileSync(p, 'utf8')); return chart.length ? chart : DEFAULT_CHART; } catch { return DEFAULT_CHART; }
}

/**
 * Levanta commission EARNED in [start, endExclusive) from the settled day file (books.mjs's accrual
 * source). Report days within the last 2 days are still landing: counted, and reported separately.
 * null when the file was not read: unknown, never zero. Pure.
 */
export function affiliateFor(levDays, { start, endExclusive }, now = new Date()) {
  if (!Array.isArray(levDays)) return null;
  const cutoff = new Date(new Date(now).getTime() - 2 * 86400000).toISOString().slice(0, 10);
  let settled = 0, landing = 0, orders = 0;
  for (const r of levDays) {
    const d = String(r?.d || '');
    if (!(d >= start && d < endExclusive)) continue;
    const c = Number(r.c) || 0;
    if (d >= cutoff) landing += c; else settled += c;
    orders += Number(r.o) || 0;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { commission: r2(settled), landing: r2(landing), orders, available: true };
}
const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, endExclusive: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
};

/** The month to run: --month wins; --close is the month that just ended; otherwise this month. */
export function pickMonth({ month, close = false, now = new Date() } = {}) {
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`--month wants YYYY-MM, got "${month}"`);
    return month;
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (close ? 1 : 0), 1));
  return d.toISOString().slice(0, 7);
}

export const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rows -> the importer's categorised transactions, through the CSV so the CLI and the digest agree. */
export function categorise(rows, rules, month) {
  return importStatement(toCsv(rows), rules, month).txns;
}

/** What the importer prints, as data: account totals, transfers, and the rows with no rule. */
export function summarise(txns) {
  const real = txns.filter((t) => t.account !== 'TRANSFER');
  const transfers = txns.filter((t) => t.account === 'TRANSFER');
  const by = new Map();
  for (const t of real) {
    const k = t.account || null;
    const g = by.get(k) || { account: k, total: 0, n: 0 };
    g.total += t.amt; g.n++; by.set(k, g);
  }
  const byAccount = [...by.values()].filter((g) => g.account).sort((a, b) => b.total - a.total);
  const uncategorised = real.filter((t) => !t.account).map((t) => ({ desc: t.desc, amt: t.amt, date: t.date }));
  return {
    byAccount, uncategorised,
    transfers: { n: transfers.length, total: transfers.reduce((a, t) => a + t.amt, 0) },
    moneyIn: real.filter((t) => t.amt > 0).reduce((a, t) => a + t.amt, 0),
    moneyOut: real.filter((t) => t.amt < 0).reduce((a, t) => a + t.amt, 0),
    account: (name) => by.get(name)?.total || 0,
  };
}

/** RT revenue per client, from the "· Name" the balance rows carry. Refunds and chargebacks count against the client. */
export function rtByClient(txns) {
  const out = new Map();
  for (const t of txns) {
    if (t.account !== 'RT Service Revenue') continue;
    const m = /· ([^\[]+?) \[[a-z_]+\]$/.exec(t.desc);
    const who = m ? m[1].trim() : '(unnamed)';
    out.set(who, (out.get(who) || 0) + t.amt);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

/** A pattern for books-rules.json from a row nobody has a rule for: the tag when the text IS the tag, else the leading vendor words. */
export function suggestPattern(desc) {
  const tag = /\[([a-z_]+)\]\s*$/.exec(desc)?.[1];
  const text = desc.replace(/\s*\[[a-z_]+\]\s*$/, '').split(' · ')[0].trim();
  if (!text || (tag && text === tag)) return tag ? `\\[${tag}\\]` : '';
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1).slice(0, 2);
  return words.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Chart of accounts, as QuickBooks knows it — the list an LLM may pick from. */
export function chartOfAccounts() {
  const p = join(HERE_DIR, 'books-chart-of-accounts.csv');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').slice(1).map((l) => l.split(',')[0].trim()).filter(Boolean);
}

/**
 * Ask the LLM which account each uncategorised row belongs to. Advisory only — the digest shows the
 * suggestion next to the row; a human puts it in books-rules.json. No key, no call; any failure,
 * no suggestion. Never lets the model invent an account: anything off the chart becomes "?".
 */
export async function suggestAccounts(env, uncat, coa, { client = null } = {}) {
  const out = new Map();
  if (!uncat.length || !coa.length) return out;
  // Jev decides (decisions/books-category.mjs, v7 N2): one choice per row over the chart. A row Jev
  // could not read falls back to the LLM below; a row it read stays Jev's, "?" included.
  if (client || env.OPENROUTER_API_KEY || env.TYPESAFE_API_KEY) {
    try {
      const { decide, decisionConfig } = await import('./jev-decide.mjs');
      const { DECISIONS } = await import('./decisions/index.mjs');
      const jevClient = client || (await import('./jev.mjs')).jev(env);
      const th = decisionConfig('books-category').thresholds;
      await Promise.all(uncat.slice(0, 25).map(async (u) => {
        const r = await decide('books-category', { description: u.desc, accounts: coa }, { client: jevClient, registry: DECISIONS, log: null });
        if (r.source === 'fallback' || !r.answers) return;
        const v = DECISIONS['books-category'].policy(r.answers, th);
        out.set(u.desc, { account: v.account, why: `Jev ${v.confidence.toFixed(2)}` });
      }));
    } catch (e) { console.warn(`suggestAccounts: Jev not read (${e.message.split('\n')[0]})`); }
    if (uncat.slice(0, 25).every((u) => out.has(u.desc))) return out;
  }
  if (!(env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || env.LLM_API_KEY)) return out;
  uncat = uncat.filter((u) => !out.has(u.desc));
  const system = [
    'You categorise bank-statement rows for a small US media business: X/Twitter growth pages earning affiliate commission (Levanta),',
    'an RT (retweet) service billed to clients through Stripe, Gumroad ebooks, boost vendors paid per post, LLM API bills, SaaS subscriptions.',
    'Each row ends with a [tag] naming the mechanism. Pick exactly ONE account per row from this chart, or "?" if none fits:',
    ...coa.map((a) => `- ${a}`),
    '- TRANSFER  (not an account: the business moving its OWN money between its own accounts — a payout, a sweep, a top-up, a currency conversion leg. Excluded from the P&L.)',
    'Reply with ONLY a JSON array, one object per row, same order: [{"description": "<as given>", "account": "<account or ?>", "why": "<12 words max>"}]',
  ].join('\n');
  try {
    const text = await anthropic(env, { role: 'aux', max_tokens: 1500, system, messages: [{ role: 'user', content: JSON.stringify(uncat.slice(0, 25).map((u) => u.desc)) }] });
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    for (const s of JSON.parse(json)) {
      if (!s || typeof s.description !== 'string') continue;
      if (!out.has(s.description)) out.set(s.description, { account: coa.includes(s.account) || s.account === 'TRANSFER' ? s.account : '?', why: String(s.why || '').slice(0, 80) });
    }
  } catch (e) { console.warn(`suggestAccounts: ${e.message.split('\n')[0]} — no LLM suggestions this run`); }
  return out;
}

const line = (label, amount, n) => `${esc(label).padEnd(30)} ${money(amount).padStart(11)}${n != null ? `  <i>${n}</i>` : ''}`;

/**
 * The message. `ledgers` are { key, name, rows, summary, note, error } — a ledger with an error or
 * a `skip` reason still gets a line, because a silent ledger is the failure mode this repo hates.
 */
export function composeDigest({ month, close, ledgers, clients, suggestions, boost, period }) {
  const all = ledgers.filter((l) => l.summary);
  const sum = (acct) => all.reduce((a, l) => a + l.summary.account(acct), 0);
  const uncat = all.flatMap((l) => l.summary.uncategorised.map((u) => ({ ...u, ledger: l.name })));
  const failed = ledgers.filter((l) => l.error);
  const rt = sum('RT Service Revenue'), digital = sum('Digital Product Sales'), fees = sum('Payment Processing Fees');
  const glyph = failed.length ? '🛑' : uncat.length ? '⚠️' : '✅';
  const status = `${glyph} <b>${money(rt)} RT</b> · ${money(digital)} digital · ${money(fees)} fees` +
    (uncat.length ? ` · <b>${uncat.length} row${uncat.length === 1 ? '' : 's'} without a rule</b>` : ' · every row has a rule') +
    (failed.length ? ` · ${failed.map((l) => esc(l.name)).join(', ')} FAILED` : '');

  const sections = [];
  for (const l of ledgers) {
    if ((l.error || l.skip) && !l.summary) { sections.push({ label: l.name, body: [l.error ? `🛑 ${esc(l.error)}` : `💤 ${esc(l.skip)}`, l.note ? esc(l.note) : ''].filter(Boolean).join('\n') }); continue; }
    const s = l.summary;
    const body = [];
    if (l.error || l.skip) body.push(`PARTIAL — known rows only: ${esc(l.error || l.skip)}`);
    if (!l.rows.length) body.push('💤 no activity');
    for (const g of s.byAccount) body.push(line(g.account, g.total, g.n));
    if (s.uncategorised.length) body.push(line('❓ no rule yet', s.uncategorised.reduce((a, u) => a + u.amt, 0), s.uncategorised.length));
    if (s.transfers.n) body.push(line('transfers excluded', s.transfers.total, s.transfers.n));
    if (l.note) body.push(esc(l.note));
    sections.push({ label: `${l.name} · ${l.rows.length} rows`, body: `<pre>${body.join('\n')}</pre>` });
  }
  if (clients?.length) {
    sections.push({ label: 'RT by client', body: `<pre>${clients.slice(0, 12).map(([who, amt]) => line(who.slice(0, 28), amt)).join('\n')}</pre>` });
  }
  // The [received_credit] rule is provisional: anything arriving at the financial account from
  // outside clears the Levanta receivable. Show every row it caught, so a mis-sort is seen the
  // week it happens rather than at the close.
  const cleared = all.flatMap((l) => l.txns.filter((x) => x.account === 'Accounts Receivable - Levanta').map((x) => ({ ...x, ledger: l.name })));
  if (cleared.length) {
    sections.push({ label: 'Levanta receivable cleared · confirm each is Levanta', body: `<pre>${cleared.map((x) => `${money(x.amt).padStart(11)}  ${esc(x.desc.slice(0, 44))}`).join('\n')}</pre>` });
  }
  if (uncat.length) {
    const rows = uncat.slice(0, 25).map((u) => {
      const s = suggestions?.get(u.desc);
      const rule = { match: suggestPattern(u.desc), account: s?.account || '?', class: '' };
      return `${money(u.amt).padStart(11)}  ${esc(u.desc)}  <i>(${esc(u.ledger)})</i>\n      → ${esc(JSON.stringify(rule))}${s?.why ? `  <i>${esc(s.why)}</i>` : ''}`;
    });
    sections.push({ label: `Uncategorised · ${uncat.length}`, body: rows.join('\n') + (uncat.length > 25 ? `\n… and ${uncat.length - 25} more` : '') });
  }
  if (boost && boost.target && boost.complete !== false && ledgers.every(l => l.summary && !l.error && !l.skip)) {
    const seen = -all.reduce((a, l) => a + l.summary.account('Content Boost Spend') + l.summary.account('RT Vendor Costs - Client Delivery'), 0);
    const gap = boost.target - seen;
    // RT is paid from the existing balance (owner, 2026-10-04: "rt paid with existing balance"): the gap is what the
    // period drew from it (or topped up), never a payment to chase.
    sections.push({ label: 'Boost spend', body: `<pre>${line(`fired (${boost.source || 'facts.jsonl'})`, boost.target)}\n${line('paid via Stripe/PayPal', seen)}\n${line(gap >= 0 ? 'from the RT balance' : 'topped up', Math.abs(gap))}</pre>` });
  }
  if (boost?.note) sections.push({ label: 'RT coverage', body: esc(boost.note) });
  if (boost?.target != null && (boost.complete === false || ledgers.some(l => l.error || l.skip || !l.summary))) sections.push({ label: 'Boost reconciliation unavailable', body: `Reported pipeline ${money(boost.target)}; incomplete coverage, no full gap comparison.` });
  const action = uncat.length
    ? 'Paste the suggested rules into books-rules.json (or tell Claude the account), then re-run.'
    : close ? 'Close the month: key the BY ACCOUNT totals as the journal entry (docs §5b); CSVs are on the run.' : 'No action — CSVs are attached to the run for the QuickBooks journal.';
  return report({ emoji: '📒', title: close ? 'Monthly close' : period ? 'Weekly books' : 'Books pulse', scope: period ? `${period.start} → ${new Date(Date.parse(period.endExclusive + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)} UTC` : `${month}${close ? '' : ' to date'}`, status, sections, action });
}

/** Resolve periods before any provider or advisory call. Weeks are completed Monday–Sunday UTC. */
export function planBooksRun({ weekly = false, weekStart, month, close = false, now = new Date() } = {}) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Books now must be a valid timestamp');
  if (weekStart && !weekly) throw new Error('--week-start requires --weekly');
  if (weekly && (close || month)) throw new Error('--weekly cannot be combined with --close or --month');
  const selectedMonth = pickMonth({ month, close, now });
  const plans = [];
  if (weekly) {
    let start;
    if (weekStart) {
      start = new Date(weekStart + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== weekStart) throw new Error('--week-start wants a valid YYYY-MM-DD Monday');
    } else {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7 - 7);
    }
    if (start.getUTCDay() !== 1) throw new Error('--week-start must be a Monday');
    const end = new Date(start.getTime() + 7 * 86400000);
    if (end > now) throw new Error('--week-start must select a completed week, not a future or current week');
    const period = { kind: 'week', start: start.toISOString().slice(0, 10), endExclusive: end.toISOString().slice(0, 10) };
    const months = [...new Set([period.start.slice(0, 7), new Date(end.getTime() - 1).toISOString().slice(0, 7)])];
    plans.push({ key: `books:week:${period.start}`, month: selectedMonth, close: false, period, months });
  }
  plans.push({ key: `books:${selectedMonth}`, month: selectedMonth, close, period: null, months: [selectedMonth] });
  return { asOf: now, plans, months: [...new Set(plans.flatMap(p => p.months))] };
}

/** Provider contracts and categorisation are unchanged; cache these whole-month results per run. */
export async function fetchMonthLedgers({ env, month, rules, providers = {}, saveCsv = () => {} }) {
  const balance = providers.fetchBalance || fetchBalance;
  const treasury = providers.fetchFinancialAccount || fetchFinancialAccount;
  const paypal = providers.fetchPaypal || fetchPaypal;
  const ledgers = [];
  const keep = (l) => {
    const txns = categorise(l.rows, rules, month);
    if (l.rows.length) saveCsv(`${l.file}-${month}.csv`, l.rows);
    ledgers.push({ ...l, txns, summary: summarise(txns) });
  };
  try {
    const b = await balance(env.STRIPE_SECRET_KEY, month);
    const note = [b.rows.length ? `${b.ties ? 'ties out' : 'DOES NOT TIE'}: rows ${money(b.rowsNet)} vs Stripe ${money(b.ledgerNet)}` : '',
      b.pending ? `${b.pending} pending payout availability` : '', b.customerLookup === 'forbidden' ? 'key cannot read customers' : ''].filter(Boolean).join(' · ');
    if (!b.ties && b.rows.length) throw new Error(`rows net ${money(b.rowsNet)} but Stripe says ${money(b.ledgerNet)}`);
    keep({ key: 'balance', file: 'stripe-balance', name: 'Stripe payments balance', rows: b.rows, note });
  } catch (e) { ledgers.push({ key: 'balance', name: 'Stripe payments balance', error: e.message.split('\n')[0] }); }
  try {
    const f = await treasury(env.STRIPE_SECRET_KEY, month, null);
    keep({ key: 'treasury', file: 'stripe-treasury', name: 'Stripe financial account', rows: f.rows, note: Object.keys(f.skipped).length ? `unposted: ${JSON.stringify(f.skipped)}` : '' });
  } catch (e) { ledgers.push({ key: 'treasury', name: 'Stripe financial account', error: e.message.split('\n')[0] }); }
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    try {
      const p = await paypal(env, month);
      const other = Object.entries(p.skipped).filter(([k]) => k.startsWith('other_currency')).map(([k, n]) => `${n} ${k.slice(15)}`).join(', ');
      keep({ key: 'paypal', file: 'paypal', name: 'PayPal', rows: p.rows, note: other ? `left out: ${other} rows (not USD)` : '' });
    } catch (e) { ledgers.push({ key: 'paypal', name: 'PayPal', error: e.message.split('\n')[0] }); }
  } else ledgers.push({ key: 'paypal', name: 'PayPal', skip: 'no keys yet — add PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET (Live app, Transaction Search) to .env and push' });
  return ledgers;
}

/** Whole-month tie-outs establish source coverage, not a weekly balance reconciliation. */
export function weeklyLedgers(cache, plan) {
  const inWeek = row => row.date >= plan.period.start && row.date < plan.period.endExclusive;
  return ['balance', 'treasury', 'paypal'].map(key => {
    const sources = plan.months.map(month => ({ month, ledger: cache.get(month)?.find(l => l.key === key) }));
    const first = sources.find(s => s.ledger)?.ledger || { key, name: key };
    const rows = sources.flatMap(s => s.ledger?.rows || []).filter(inWeek);
    const txns = sources.flatMap(s => s.ledger?.txns || []).filter(inWeek);
    const errors = sources.filter(s => !s.ledger || s.ledger.error || (!s.ledger.skip && !s.ledger.summary)).map(s => `${s.month}: ${s.ledger?.error || 'ledger data unavailable'}`);
    const skipped = sources.filter(s => s.ledger?.skip).map(s => `${s.month}: ${s.ledger.skip}`);
    return { key, name: first.name, file: sources.find(s => s.ledger?.file)?.ledger.file || { balance: 'stripe-balance', treasury: 'stripe-treasury', paypal: 'paypal' }[key], rows, txns,
      ...(sources.some(s => s.ledger?.summary) ? { summary: summarise(txns) } : {}),
      ...(errors.length ? { error: errors.join('; ') } : {}), ...(skipped.length ? { skip: skipped.join('; ') } : {}),
      note: sources.map(s => `Source month ${s.month}: ${s.ledger?.note || (s.ledger?.summary ? 'loaded' : 'unavailable')}`).join(' · ') + ' · Source checks cover whole months, not a weekly tie-out.' };
  });
}

/** Never assign legacy unitemised spend to a week using its post date. */
export function weeklyBoost(facts, period) {
  if (!Array.isArray(facts)) return { target: null, complete: false, note: 'facts.jsonl unavailable; weekly RT timing cannot be checked.' };
  let target = 0, unknown = 0, dated = 0;
  const start = Date.parse(period.start + 'T00:00:00Z'), end = Date.parse(period.endExclusive + 'T00:00:00Z');
  for (const fact of facts) {
    const fuel = fact.fuel;
    if (!fuel || typeof fuel !== 'object') continue;
    const fires = Array.isArray(fuel.fires) ? fuel.fires : [];
    if (!fires.length) { if (fuel.spend == null || !Number.isFinite(Number(fuel.spend)) || Number(fuel.spend)) unknown++; continue; }
    let fireTotal = 0;
    for (const fire of fires) {
      const price = Number(fire.price), at = Date.parse(fire.at);
      if (fire.price == null || (typeof fire.price === 'string' && !fire.price.trim()) || !Number.isFinite(price)) { unknown++; continue; }
      fireTotal += price;
      if (!Number.isFinite(at)) { unknown++; continue; }
      dated++;
      if (at >= start && at < end) target += price;
    }
    if (fuel.spend != null && (!Number.isFinite(Number(fuel.spend)) || Math.abs(Number(fuel.spend) - fireTotal) > 0.005)) unknown++;
  }
  return { target, complete: unknown === 0 && dated > 0, note: unknown
    ? `${unknown} logged spend entries have incomplete amounts or timing across the source history; they cannot be assigned to this week. Reported amount includes timestamped fires only; no full weekly gap can be calculated.`
    : dated ? 'Timestamped fuel fires within the UTC week; not thread publication dates.' : 'No timestamped fuel fire evidence in the source history; a complete weekly RT total cannot be confirmed.' };
}

// Boosts as fired come from the live Fuel Log: Fuel the Fire writes one ledger line per send to each post's Tier
// Breakdown (`T1 · Vendor · $12.00 · 380000 reach · <ISO>`, timestamped since 2026-07-25). facts.jsonl copies
// those fires but lags new posts and misses posts outside the pipeline (September 2026: $285.85 short), so it is
// only the fallback: for a post with no ledger line (pre-ledger) and when the Fuel Log cannot be read.
export const FUEL_LOG = Object.freeze({ base: 'app4Orfi56ghELGix', table: 'tblNSMxxTggWNndI7' });
const LEDGER_LINE = /^(T\d+(?:\+T\d+)*|T\?)\s*·\s*(.*?)\s*·\s*\$([\d.]+)\s*·\s*(\d+)\s*reach\s*·\s*(.+)$/;
const tweetIdOf = (url) => (String(url || '').match(/status\/(\d+)/) || [])[1] || null;
const cents = (x) => Math.round(x * 100) / 100;

/** PURE. A Fuel Log row's ledger lines as facts.jsonl-shaped fires; null when it has none. */
export function ledgerFires(tierBreakdown) {
  const fires = [];
  for (const line of String(tierBreakdown || '').split('\n')) {
    const m = line.trim().match(LEDGER_LINE), at = m && Date.parse(m[5]);
    if (!m || !Number.isFinite(at)) continue;
    fires.push({ tiers: m[1].split('+'), vendors: [m[2]], price: Number(m[3]), reach: Number(m[4]), at: new Date(at).toISOString() });
  }
  return fires.length ? fires : null;
}

/**
 * PURE. The boost evidence the books use: each post's fires from the Fuel Log ledger where it has any (replacing
 * facts.jsonl's copy, never adding to it), facts.jsonl where it has none, and ledger posts facts.jsonl lacks.
 * `fuelRows` = [{ xUrl, tierBreakdown }].
 */
export function mergeFuelLedger(facts, fuelRows) {
  const ledger = new Map();
  for (const r of fuelRows) {
    const id = tweetIdOf(r.xUrl), fires = ledgerFires(r.tierBreakdown);
    if (id && fires) ledger.set(id, { xUrl: r.xUrl, fires: [...(ledger.get(id)?.fires || []), ...fires] });
  }
  const spendOf = (fires) => cents(fires.reduce((s, f) => s + f.price, 0));
  const taken = new Set();
  const merged = (Array.isArray(facts) ? facts : []).map((f) => {
    const id = tweetIdOf(f?.xUrl), hit = id && ledger.get(id);
    if (!hit) return f;
    if (taken.has(id)) { const { fuel: _dropped, ...rest } = f; return rest; }   // the post's fires already sit on its first entry
    taken.add(id);
    return { ...f, fuel: { ...(f.fuel || {}), fires: hit.fires, spend: spendOf(hit.fires) } };
  });
  for (const [id, { xUrl, fires }] of ledger) if (!taken.has(id)) merged.push({ xUrl, fuel: { fires, spend: spendOf(fires) } });
  return merged;
}

/**
 * Every Fuel Log row's URL and ledger (read-only). A read that fails is never an empty ledger: it says why (`warn`,
 * the workflow log) and returns null, the caller falls back to facts.jsonl and the card says the Fuel Log was not read.
 */
export async function readFuelLog(env, { fetchFn = fetch, warn = (m) => console.log(m) } = {}) {
  const fallBack = (why) => { warn(`⚠️ Fuel Log not read (${why}); boosts fall back to facts.jsonl.`); return null; };
  if (!env.AIRTABLE_PAT) return fallBack('no AIRTABLE_PAT');
  try {
    const rows = []; let offset;
    do {
      const u = new URL(`https://api.airtable.com/v0/${FUEL_LOG.base}/${FUEL_LOG.table}`);
      u.searchParams.set('pageSize', '100');
      for (const f of ['X URL', 'Tier Breakdown']) u.searchParams.append('fields[]', f);
      if (offset) u.searchParams.set('offset', offset);
      const r = await fetchFn(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      for (const rec of j.records || []) rows.push({ xUrl: rec.fields?.['X URL'], tierBreakdown: rec.fields?.['Tier Breakdown'] });
      offset = j.offset;
    } while (offset);
    return rows;
  } catch (e) { return fallBack(String(e?.message || e).slice(0, 120)); }
}

/** Injectable orchestration: one fetch/categorisation per month and one advisory pass per run. */
export async function prepareBooksRun({ options = {}, env = {}, rules, facts = null, boostSource = 'facts.jsonl', levDays = null, chart = chartWithTypes(), providers = {}, saveCsv = () => {}, suggest = suggestAccounts, coa = chartOfAccounts() } = {}) {
  const plan = planBooksRun(options); // Validate before providers or advisory models.
  const cache = new Map();
  for (const month of plan.months) cache.set(month, await fetchMonthLedgers({ env, month, rules, providers, saveCsv }));
  const selected = plan.plans.map(p => ({ ...p, ledgers: p.period ? weeklyLedgers(cache, p) : cache.get(p.month) }));
  const uniqueUncat = [...new Map(selected.flatMap(p => p.ledgers.flatMap(l => l.summary?.uncategorised || [])).map(u => [u.desc, u])).values()];
  const suggestions = await suggest(env, uniqueUncat, coa);
  const monthlyBoost = Array.isArray(facts) ? boostByMonth(facts) : new Map();
  const cards = selected.map(p => {
    const { ledgers } = p;
    if (p.period) for (const l of ledgers) if (l.rows.length) saveCsv(`${l.file}-week-${p.period.start}.csv`, l.rows);
    const bm = monthlyBoost.get(p.month);
    const found = p.period ? weeklyBoost(facts, p.period) : bm?.total ? { target: bm.total, complete: true } : null;
    const boost = found && { ...found, source: boostSource };
    const clients = rtByClient(ledgers.flatMap(l => l.txns || []));
    const affiliate = affiliateFor(levDays, p.period || monthRange(p.month), plan.asOf);
    const model = { ...p, ledgers, clients, suggestions, boost, affiliate, chart, asOf: plan.asOf, evidenceUrl: env.BOOKS_RUN_URL };
    return { ...model, text: composeDigest(model), card: composeBooksCard(model) };
  });
  return { ...plan, cache, cards, uniqueUncat };
}

/** Pin a card in the Command Center (best effort: a missing pin right never fails the books run). */
export async function pinCard(env, messageId, { fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_CEO_BOT_TOKEN}/pinChatMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: COMMAND_CENTER_CHAT_ID, message_id: messageId, disable_notification: true }) });
    return r.ok ? { pinned: true } : { pinned: false, error: `${r.status}` };
  } catch (e) { return { pinned: false, error: String(e.message || e).slice(0, 120) }; }
}

/**
 * Persist immediately after each successful card, before attempting the next one. A month card that is
 * new (each month's first run) is pinned, so the topic's pinned bar is always the current month.
 */
export async function sendBooksCards({ env, cards, state, sendCard = telegramCard, persist, pin = pinCard }) {
  const results = [];
  for (const card of cards) {
    const result = await sendCard(env, card.card, 'books', card.key, { state });
    await persist(state);
    let pinned;
    if (/^books:\d{4}-\d{2}$/.test(card.key) && ['created', 'recreated'].includes(result.action) && result.messageId) {
      pinned = await pin(env, result.messageId);
      if (pinned.pinned && state.cards?.[card.key]) { state.cards[card.key].pinned = true; await persist(state); }
    }
    results.push({ key: card.key, ...result, ...(pinned ? { pin: pinned } : {}) });
  }
  return results;
}

export async function main() {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(`--${name}`); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`--${name} requires a value`); return v; };
  const options = { weekly: args.includes('--weekly'), weekStart: value('week-start'), month: value('month'), close: args.includes('--close'), now: new Date() };
  planBooksRun(options);
  const env = loadEnv();
  requireEnv(env, ['STRIPE_SECRET_KEY']);
  const send = args.includes('--send') && !args.includes('--dry');
  const outDir = join(HERE_DIR, 'books'); mkdirSync(outDir, { recursive: true });
  let facts = null;
  try { facts = readFileSync(join(HERE_DIR, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* Keep unavailable distinct from a valid empty ledger. */ }
  let levDays = null;
  try { levDays = readFileSync(join(HERE_DIR, 'levanta-days.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* Unknown commission is flagged, never zero. */ }
  const fuelRows = await readFuelLog(env);
  const boostFacts = fuelRows ? mergeFuelLedger(facts, fuelRows) : facts;
  const run = await prepareBooksRun({ options, env, rules: loadRules(), facts: boostFacts, boostSource: fuelRows ? 'Fuel Log' : 'facts.jsonl', levDays, saveCsv: (name, rows) => writeFileSync(join(outDir, name), toCsv(rows)) });
  for (const card of run.cards) console.log(`\n${card.text.replace(/<\/?(b|i|pre)>/g, '')}\n`);
  if (send) {
    const stateFile = join(HERE_DIR, 'queues', 'telegram-books-card.json');
    let state = { cards: {} }; try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
    const results = await sendBooksCards({ env, cards: run.cards, state, persist: state => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n') });
    for (const r of results) console.log(`📨 ${r.key} card ${r.action}${r.pin ? (r.pin.pinned ? ' · pinned' : ` · pin failed (${r.pin.error})`) : ''}.`);
  } else {
    // A dry run shows the exact cards it would send (tags stripped), so a change can be checked on live ledgers first.
    for (const card of run.cards) console.log(`\n--- card ${card.key} (dry)\n${card.card.replace(/<\/?(b|i|blockquote[^>]*|a[^>]*)>/g, '')}`);
    console.log('(dry — pass --send to post)');
  }
  const monthlyLedgers = run.cards.at(-1).ledgers;
  const metrics = { month: run.plans.at(-1).month, close: options.close, weekly: options.weekly, sent: send, uncategorised: monthlyLedgers.flatMap(l => l.summary?.uncategorised || []).length, rt: monthlyLedgers.reduce((sum, l) => sum + (l.summary?.account('RT Service Revenue') || 0), 0), cards: run.cards.map(c => ({ key: c.key, period: c.period })) };
  for (const l of monthlyLedgers) metrics[l.key] = l.error ? { error: l.error } : l.skip ? { skipped: true } : { rows: l.rows.length };
  for (const [month, ledgers] of run.cache) for (const l of ledgers) metrics[`${month}:${l.key}`] = l.error ? { error: l.error } : l.skip ? { skipped: true } : { rows: l.rows.length };
  await logRun('books-weekly', metrics);
  const errors = [...run.cache].flatMap(([month, ls]) => ls.filter(l => l.error).map(l => `${month} ${l.name}: ${l.error}`));
  if (errors.length) throw new Error(`a ledger failed: ${errors.join('; ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'books-weekly');
