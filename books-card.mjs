// Compact Books presentation only. Callers own ledger fetching, period filtering,
// detailed workflow logs and CSV evidence; this renderer never contacts services.
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The business chart (books-chart-of-accounts.csv): the card books EVERY income and cost account the
// accountant workflow books, not a subset (owner, 2026-10-03: "book is everything not just PIs — it's based
// on our gtx accountant workflow and the apis"). Balance-sheet accounts are never income or cost.
export const DEFAULT_CHART = [
  ['Affiliate Commission - Levanta', 'Income'], ['RT Service Revenue', 'Income'], ['Ghostwriting Revenue', 'Income'],
  ['Digital Product Sales', 'Income'], ['Cashback Rewards', 'Other Income'],
  ['Content Boost Spend', 'Cost of Goods Sold'], ['RT Vendor Costs - Client Delivery', 'Cost of Goods Sold'],
  ['RT Vendor Retainers', 'Cost of Goods Sold'], ['AI / LLM API Costs', 'Cost of Goods Sold'],
  ['Software & Subscriptions', 'Expense'], ['Payment Processing Fees', 'Expense'], ['Contractors & VA', 'Expense'],
  ['Legal & professional services', 'Expense'],
  ['Stripe Treasury', 'Bank'], ['Vo Song Huong - PayPal', 'Bank'], ['Stripe Balance', 'Other Current Asset'],
  ['Accounts Receivable - Levanta', 'Other Current Asset'], ['Deferred Revenue - RT Credits', 'Other Current Liability'], ['Owner draws', 'Equity'],
].map(([name, type]) => ({ name, type }));
/** books-chart-of-accounts.csv -> [{ name, type }]. */
export const parseChart = (csv) => String(csv || '').split('\n').slice(1).map((l) => l.split(',')).filter((c) => c[0]?.trim()).map((c) => ({ name: c[0].trim(), type: (c[1] || '').trim() }));
const INCOME = new Set(['Income', 'Other Income']), COST = new Set(['Cost of Goods Sold', 'Expense', 'Other Expense']);
const AFFILIATE = 'Affiliate Commission - Levanta', BOOSTS = 'Content Boost Spend', CLIENT_RT = 'RT Vendor Costs - Client Delivery';
const LABEL = { [AFFILIATE]: '🤝 Levanta', 'RT Service Revenue': '🔁 RT service', 'Ghostwriting Revenue': '✍️ Ghostwriting', 'Digital Product Sales': '📚 Digital',
  'Cashback Rewards': '🎁 Cashback', [BOOSTS]: '🚀 Boosts', [CLIENT_RT]: '🧾 Client RTs', 'RT Vendor Retainers': '📌 Retainers', 'AI / LLM API Costs': '🤖 AI',
  'Software & Subscriptions': '💻 Software', 'Payment Processing Fees': '💳 Fees', 'Contractors & VA': '👥 Contractors', 'Legal & professional services': '⚖️ Legal' };
const labelOf = (name) => LABEL[name] || `• ${name}`;
const cents = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100
  ? Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-8) : null;
const money = value => `${value < 0 ? '-' : ''}$${(Math.abs(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateOnly = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('Books period requires valid YYYY-MM-DD dates');
  return Date.parse(value + 'T00:00:00Z');
};
const stamp = date => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ICT`;
};
function scope(month, close, period, now) {
  if (period != null) {
    if (period.kind !== 'week' || close) throw new Error('Books weekly period cannot be combined with monthly close');
    const start = dateOnly(period.start), end = dateOnly(period.endExclusive);
    if (end <= start || (end - start) % 86400000 !== 0) throw new Error('Books weekly period must end after it starts');
    const first = new Date(start), last = new Date(end - 86400000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
    const firstLabel = sameYear && first.getUTCMonth() === last.getUTCMonth() ? first.getUTCDate()
      : `${first.getUTCDate()} ${months[first.getUTCMonth()]}${sameYear ? '' : ` ${first.getUTCFullYear()}`}`;
    return `Weekly · ${firstLabel}–${last.getUTCDate()} ${months[last.getUTCMonth()]} ${last.getUTCFullYear()} UTC`;
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('Books month requires YYYY-MM');
  return close ? `Monthly close review · ${month}` : `${month}${month === now.toISOString().slice(0, 7) ? ' month to date' : ''}`;
}
function evidenceLink(value) {
  try {
    const url = new URL(value);
    if (url.href.length <= 500 && url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && /^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/?$/.test(url.pathname)) return `<a href="${escape(url.href)}">Full checks and CSVs</a>`;
  } catch { /* A missing/invalid URL must never create an invented evidence link. */ }
  return 'Full checks and CSVs: workflow run log and attachments.';
}
function ledgerState(ledger, names) {
  if (ledger.skip) return { ...ledger, state: 'skipped' };
  const unavailableState = ledger.error ? 'failed' : 'unavailable';
  if (typeof ledger.summary?.account !== 'function') return { ...ledger, state: unavailableState };
  try {
    const amounts = Object.fromEntries(names.map(account => [account, cents(ledger.summary.account(account))]));
    if (Object.values(amounts).some(value => value == null)) return { ...ledger, state: unavailableState };
    // Cross-month weekly reads can have one successful source month and another
    // failed month. Keep known totals, while preserving the incomplete-ledger flag.
    return { ...ledger, state: ledger.error ? 'partial' : 'loaded', amounts };
  } catch { return { ...ledger, state: unavailableState }; }
}

/**
 * The whole business's books for a period, as an ACCRUAL P&L (books.mjs's own rule): Levanta commission as
 * earned (`affiliate`, from levanta-days.jsonl; a Levanta payout only clears the receivable), boosts as fired
 * (`boost.target` from `boost.source`: the live Fuel Log ledger, or facts.jsonl when it could not be read; their
 * Stripe/PayPal payments settle them), every other
 * income and cost account as booked from the ledgers by books-rules.json. Ledger amounts must already be
 * filtered to the period by the caller. Missing ledgers, commission or boost data are never zeros.
 */
export function composeBooksCard({ month, close = false, ledgers = [], boost, affiliate = null, chart = DEFAULT_CHART, period = null, asOf = new Date(), evidenceUrl } = {}) {
  const now = new Date(asOf);
  if (!Number.isFinite(now.getTime())) throw new Error('Books asOf must be a valid timestamp');
  const label = scope(month, close, period, now);
  const names = [...new Set([...chart.map(a => a.name), AFFILIATE, BOOSTS, CLIENT_RT, 'Accounts Receivable - Levanta', 'Owner draws'])];
  const typeOf = new Map(chart.map(a => [a.name, a.type]));
  typeOf.set(AFFILIATE, typeOf.get(AFFILIATE) || 'Income'); typeOf.set(BOOSTS, typeOf.get(BOOSTS) || 'Cost of Goods Sold'); typeOf.set(CLIENT_RT, typeOf.get(CLIENT_RT) || 'Cost of Goods Sold');
  const states = ledgers.map(l => ledgerState(l, names)), loaded = states.filter(l => l.state === 'loaded' || l.state === 'partial');
  const partial = states.filter(l => l.state === 'partial');
  const failed = states.filter(l => l.state === 'failed' || l.state === 'partial'), skipped = states.filter(l => l.state === 'skipped'), unavailable = states.filter(l => l.state === 'unavailable');
  const completeLedgers = states.length > 0 && states.every(l => l.state === 'loaded');
  const booked = Object.fromEntries(names.map(n => [n, loaded.reduce((sum, l) => sum + l.amounts[n], 0)]));
  if (Object.values(booked).some(value => !Number.isSafeInteger(value))) throw new Error('Books totals exceed safe currency precision');
  // Accrual lines. A ledger that books Levanta as income directly keeps that (never counted twice).
  const aff = affiliate && affiliate.available !== false && cents(affiliate.commission) != null ? { earned: cents(affiliate.commission) + (cents(affiliate.landing) ?? 0), landing: cents(affiliate.landing) ?? 0 } : null;
  const affiliateLine = booked[AFFILIATE] ? { amount: booked[AFFILIATE], how: 'booked from the ledgers' } : aff ? { amount: aff.earned, how: 'earned (accrual)' } : null;
  const fired = cents(boost?.target);
  const paidBoosts = -booked[BOOSTS];
  const boostLine = fired != null ? { amount: fired, how: 'fired' } : { amount: paidBoosts, how: 'paid through the ledgers (fired total unavailable)' };
  const lines = [];
  for (const { name } of chart.filter(a => INCOME.has(typeOf.get(a.name)) || COST.has(typeOf.get(a.name)))) {
    const income = INCOME.has(typeOf.get(name));
    const amount = name === AFFILIATE ? affiliateLine?.amount ?? null : name === BOOSTS ? boostLine.amount : income ? booked[name] : -booked[name];
    lines.push({ name, income, amount });
  }
  if (!chart.some(a => a.name === AFFILIATE)) lines.unshift({ name: AFFILIATE, income: true, amount: affiliateLine?.amount ?? null });
  if (!chart.some(a => a.name === BOOSTS)) lines.push({ name: BOOSTS, income: false, amount: boostLine.amount });
  const known = lines.filter(l => l.amount != null);
  const income = known.filter(l => l.income).reduce((s, l) => s + l.amount, 0), costs = known.filter(l => !l.income).reduce((s, l) => s + l.amount, 0), net = income - costs;
  if (![income, costs, net].every(Number.isSafeInteger)) throw new Error('Books subtotal exceeds safe currency precision');
  // Rows no rule booked are outside the P&L until categorized: show what is at stake, not just a count.
  const uncatRows = loaded.flatMap(l => Array.isArray(l.summary.uncategorised) ? l.summary.uncategorised : []);
  const uncatIn = uncatRows.reduce((s, r) => s + Math.max(0, cents(Number(r.amt)) ?? 0), 0), uncatOut = uncatRows.reduce((s, r) => s - Math.min(0, cents(Number(r.amt)) ?? 0), 0);
  const target = fired;
  const pipelineComplete = target != null && boost?.complete !== false && boost?.available !== false && boost?.unavailable !== true;
  const comparable = completeLedgers && pipelineComplete;
  const statementRt = paidBoosts + -booked[CLIENT_RT], gap = comparable ? target - statementRt : null;
  if (!Number.isSafeInteger(statementRt) || (gap != null && !Number.isSafeInteger(gap))) throw new Error('Books reconciliation exceeds safe currency precision');
  const actions = [];
  if (uncatRows.length) actions.push(`categorize ${uncatRows.length} transaction${uncatRows.length === 1 ? '' : 's'} (${money(uncatIn)} in · ${money(uncatOut)} out not yet booked)`);
  // No action for the gap: boosts are paid from the existing RT balance (owner, 2026-10-04: "rt paid with existing
  // balance"), so fired minus paid-through-statements is the balance drawn down (or topped up), not a missing payment.
  if (failed.length) actions.push(`fix ${failed.length} failed ledger${failed.length === 1 ? '' : 's'}`);
  if (skipped.length) actions.push(`connect ${skipped.length} skipped ledger${skipped.length === 1 ? '' : 's'}`);
  if (unavailable.length || !states.length) actions.push('check unavailable ledger data');
  if (!affiliateLine) actions.push('Levanta commission unavailable: check levanta-days.jsonl');
  if (close) actions.push('review CSVs before posting the monthly journal');
  const provisional = !completeLedgers || uncatRows.length || !affiliateLine || fired == null;
  const head = [`${close ? '🔒' : '📒'} <b>Books · ${escape(label)}</b>`];
  if (loaded.length) {
    const shown = (wantIncome) => known.filter(l => l.income === wantIncome && l.amount !== 0).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .map(l => `${labelOf(l.name)} ${money(l.amount)}`).join(' · ');
    head.push(`💰 <b>${money(net)} net income</b> · accrual${provisional ? ' · provisional' : ''}${completeLedgers ? '' : ' · known ledgers only'}`,
      `📈 Income <b>${money(income)}</b> · 📉 Costs <b>${money(costs)}</b>`);
    const inLine = shown(true), outLine = shown(false);
    if (inLine) head.push(inLine);
    if (outLine) head.push(outLine);
  } else head.push('⚠️ <b>Totals unavailable</b>', '⚠️ No loaded ledger totals; missing data is not zero.');
  if (actions.length) head.push(`👉 <b>Needs you:</b> ${escape(actions.join('; '))}.`);
  const core = [
    `🕒 As of ${stamp(now)}`,
    `ℹ️ Whole business, accrual: Levanta commission as earned (settled report days), boosts as fired (${boost?.source === 'facts.jsonl' ? 'facts.jsonl: the live Fuel Log could not be read' : 'Fuel Log'}), every other income and cost as booked from Stripe and PayPal by books-rules.json. A Levanta payout clears the receivable, and transfers and owner draws are neither income nor cost. QuickBooks books boosts as they are paid, so its P&L can differ by the boost payments below.`,
    affiliateLine ? `🤝 Levanta ${money(affiliateLine.amount)} ${affiliateLine.how}${aff?.landing && affiliateLine.how.startsWith('earned') ? ` · ${money(aff.landing)} of it from the last 2 days, still landing` : ''}.` : '⚠️ Levanta commission unavailable (levanta-days.jsonl not read); income is understated, not zero.',
    fired != null ? `🚀 Boosts ${money(fired)} fired · ${money(paidBoosts)} paid through Stripe/PayPal${fired - paidBoosts ? ` · ${fired > paidBoosts ? `${money(fired - paidBoosts)} from the existing RT balance` : `${money(paidBoosts - fired)} topped up`}` : ''}.` : `⚠️ Boosts fired total unavailable; costs use the ${money(paidBoosts)} paid through Stripe/PayPal.`,
    `🏦 Balance sheet: Levanta payouts received ${money(booked['Accounts Receivable - Levanta'])} · owner draws ${money(-booked['Owner draws'])}${loaded.some(l => l.summary?.transfers?.n) ? ` · ${loaded.reduce((n, l) => n + (l.summary.transfers?.n || 0), 0)} transfers between accounts` : ''}.`,
    `🔎 Coverage: ${loaded.length}/${states.length} ledgers ${partial.length ? `with available totals; ${partial.length} partial` : 'loaded'}${completeLedgers ? '' : '; incomplete'}.`,
  ];
  if (comparable) core.push(`🧾 RT: fired ${money(target)} · paid through Stripe/PayPal ${money(statementRt)} · ${gap >= 0 ? `${money(gap)} drawn from the RT balance` : `${money(-gap)} topped up into the RT balance`}.`);
  else {
    core.push(`⚠️ RT reconciliation unavailable: ${!completeLedgers ? 'ledger coverage incomplete' : 'pipeline coverage unavailable or incomplete'}.`);
    if (target != null) core.push(`⚠️ Reported pipeline RT ${money(target)}${pipelineComplete ? '' : ' (coverage incomplete)'}${loaded.length ? ` · ${completeLedgers ? '' : 'known '}statement RT ${money(statementRt)}` : ''}; no gap comparison.`);
  }
  if (known.some(l => l.amount < 0)) core.push('ℹ️ Signed amounts retained: negative income can include refunds; negative costs can include refunds/credits.');
  const detail = states.map(l => {
    const name = String(l.name || l.key || 'Ledger');
    const status = l.state === 'loaded' ? `loaded${Array.isArray(l.rows) ? `, ${l.rows.length} rows` : ''}` : l.state === 'partial' ? `PARTIAL: ${l.error}`
      : l.state === 'failed' ? `FAILED: ${l.error}` : l.state === 'skipped' ? `not included: ${l.skip}` : 'account totals unavailable';
    return `${l.state === 'loaded' ? '✅' : '⚠️'} ${name}: ${status}${l.note ? ` · ${l.note}` : ''}`;
  });
  if (boost?.note) detail.push(`ℹ️ RT coverage note: ${boost.note}`);
  const link = `📎 ${evidenceLink(evidenceUrl)}`;
  const render = (lines, omitted = 0) => head.join('\n') + '\n<blockquote expandable>'
    + [...core, ...lines, ...(omitted ? [`ℹ️ ${omitted} supporting detail${omitted === 1 ? '' : 's'} omitted from this card; read the full workflow checks.`] : [])].map(line => escape(line.replace(/\s+/g, ' ').trim())).join('\n')
    + '\n' + link + '</blockquote>';
  const full = render(detail);
  if (full.length <= 3900) return full;
  // Retain complete escaped entries only. Reserve the largest omission notice up
  // front, so neither HTML nor a partial note can be cut by Telegram's limit.
  const kept = [];
  for (const item of detail) if (render([...kept, item], detail.length).length <= 3900) kept.push(item);
  const result = render(kept, detail.length - kept.length);
  if (result.length > 3900) throw new Error('Books summary exceeds Telegram limit; full evidence is in the workflow log');
  return result;
}
