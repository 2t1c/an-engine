#!/usr/bin/env node
// cta-lab.mjs: the CTA research loop. Score, judge, queue the next hypothesis, assign pages.
//
// Owner, 2026-11-08: "a small portion to test new CTA style/hypotheses", one variable at a time, on
// rotating pages, and "winner moves into control". Owner, 2026-11-10: the 2 and 3 beat CTA "is probably
// the best place to test with auto research in mind", and "move faster, more accounts available to test".
// Until now the scoreboard was read by hand and the next test was picked by hand. This is the loop:
//
//   node scripts/cta-lab.mjs status --lab LAB --scores DIR [--log LOG]            every variant against the champion
//   node scripts/cta-lab.mjs judge  --lab LAB --scores DIR [--log LOG] [--write]  promote, retire, start the next
//   node scripts/cta-lab.mjs assign --lab LAB --date YYYY-MM-DD --pages kim:t0,lucas:ladder,... [--log LOG]
//
// LAB is the registry (a JSON file kept outside the repository): the champion, the variants on test, the
// backlog in order, the rules and the history. DIR holds scoreboard.mjs output. `judge` without --write
// prints what it would do and changes nothing. The script never writes copy and never calls a model: a
// variant is one sentence saying what changes, and the writer writes it into the day's threads.
//
// The rule is a rule of thumb, not a significance test. A day is 3 to 4 threads a variant and views differ
// a hundredfold between threads, so a variant must win on the pooled rate AND the median rate, over at
// least two days, against the champion's threads from THE SAME days.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = {
  minThreads: 6,        // threads past the click clock before any verdict
  minDays: 2,           // on at least this many days, so one hot day cannot decide
  minPlugViews: 20000,  // plug-tweet views across those threads
  minChampion: 3,       // champion threads on the same days
  maxThreads: 12,       // a variant that has not won by here is retired
  lift: 1.15,           // win = at least 15% above the champion, pooled and median
  ordersFloor: 0.75,    // and orders per plug view not under 75% of the champion's ...
  minOrders: 5,         // ... judged only when the two sides have this many orders between them
  perVariant: 3,        // pages a challenger gets in one run
  maxActive: 4,         // challengers on test at once
};

// ---- pure helpers (tests/cta-lab.test.mjs) -------------------------------------------------------
/** Which variant a logged thread ran. An explicit `variant` wins; a test group other than base is the
 *  variant; otherwise the CTA arm is. */
export function variantOf(row = {}) {
  if (row.variant) return row.variant;
  if (row.group && row.group !== 'base') return row.group;
  return row.arm ?? null;
}

/** One row per draft from several scoreboard files: the newest read of each thread. */
export function latestRows(boards = []) {
  const by = new Map();
  for (const b of boards.slice().sort((x, y) => String(x.at).localeCompare(String(y.at)))) for (const r of b.rows || []) by.set(String(r.draftId), { ...r, readAt: b.at });
  return [...by.values()];
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const round = (x, d = 2) => (x == null ? null : +x.toFixed(d));
function side(rows) {
  const plugViews = rows.reduce((n, r) => n + r.plugViews, 0);
  const settled = rows.filter((r) => r.ordersFinal && r.orders != null);
  const orderViews = settled.reduce((n, r) => n + r.plugViews, 0);
  const orders = settled.reduce((n, r) => n + r.orders, 0);
  return {
    threads: rows.length, plugViews,
    pooled: plugViews ? round((rows.reduce((n, r) => n + r.heavyClicks, 0) / plugViews) * 1000) : null,
    median: round(median(rows.map((r) => r.heavyPer1k))),
    orders: settled.length ? orders : null, orderThreads: settled.length,
    ordersPer1k: settled.length && orderViews ? round((orders / orderViews) * 1000, 3) : null,
  };
}

/**
 * A variant's evidence against the champion. Only threads past the click clock with their plug views and
 * heavy clicks read count, and the champion is measured on the same days only: a variant that ran on a
 * strong day is compared with the champion's threads from that strong day.
 */
export function evidence(rows = [], variant, champion) {
  // Pots are left out on both sides: a pot's result is its seed's, and old-CTA pots are a separate read
  // (owner 2026-11-19), so counting them would mix the seed test into the CTA test.
  const usable = rows.filter((r) => r.lane !== 'pot' && r.clicksFinal && r.plugViews != null && r.heavyClicks != null && r.plugViews > 0);
  const mine = usable.filter((r) => variantOf(r) === variant);
  const days = [...new Set(mine.map((r) => r.date))].sort();
  const theirs = usable.filter((r) => variantOf(r) === champion && days.includes(r.date));
  let dayWins = 0, dayPairs = 0;
  for (const d of days) {
    const a = side(mine.filter((r) => r.date === d)), b = side(theirs.filter((r) => r.date === d));
    if (a.pooled != null && b.pooled != null) { dayPairs++; if (a.pooled > b.pooled) dayWins++; }
  }
  const pending = rows.filter((r) => variantOf(r) === variant && !r.clicksFinal).length;
  return { variant, champion, days, pending, dayWins, dayPairs, ...side(mine), champ: side(theirs) };
}

/** promote, retire or keep, with the reason in plain words. */
export function verdict(ev, rules = RULES) {
  const R = { ...RULES, ...rules };
  const short = [];
  if (ev.threads < R.minThreads) short.push(`${ev.threads} of ${R.minThreads} threads`);
  if (ev.days.length < R.minDays) short.push(`${ev.days.length} of ${R.minDays} days`);
  if (ev.plugViews < R.minPlugViews) short.push(`${ev.plugViews} of ${R.minPlugViews} plug-tweet views`);
  if (ev.champ.threads < R.minChampion) short.push(`${ev.champ.threads} of ${R.minChampion} champion threads on the same days`);
  if (short.length && ev.threads < R.maxThreads) return { action: 'keep', why: `not enough yet: ${short.join(', ')}` };
  if (short.length) return { action: 'retire', why: `${ev.threads} threads and still not enough to judge (${short.join(', ')})` };
  const up = (a, b) => a != null && b != null && a >= b * R.lift;
  const clicksWin = up(ev.pooled, ev.champ.pooled) && up(ev.median, ev.champ.median);
  const ordersKnown = ev.orders != null && ev.champ.orders != null && ev.orders + ev.champ.orders >= R.minOrders;
  const ordersOk = !ordersKnown || ev.ordersPer1k >= ev.champ.ordersPer1k * R.ordersFloor;
  const clicks = `${ev.pooled} against ${ev.champ.pooled} heavy clicks per 1k plug-tweet views (median ${ev.median} against ${ev.champ.median}), won ${ev.dayWins} of ${ev.dayPairs} days`;
  const orders = ordersKnown ? `orders ${ev.ordersPer1k} against ${ev.champ.ordersPer1k} per 1k` : 'orders too thin to judge';
  if (clicksWin && ordersOk) return { action: 'promote', why: `${clicks}; ${orders}` };
  if (ev.threads >= R.maxThreads) return { action: 'retire', why: `no clear win after ${ev.threads} threads: ${clicks}; ${orders}` };
  if (clicksWin && !ordersOk) return { action: 'keep', why: `wins clicks but loses orders: ${clicks}; ${orders}` };
  if (ev.pooled < ev.champ.pooled && ev.median < ev.champ.median) return { action: 'retire', why: `behind on both rates: ${clicks}; ${orders}` };
  return { action: 'keep', why: `mixed: ${clicks}; ${orders}` };
}

const testing = (lab) => Object.entries(lab.variants || {}).filter(([, v]) => v.status === 'testing').map(([id]) => id);

/**
 * The registry after the verdicts. One promotion at most per pass (the best pooled lift): the others were
 * measured against the old champion, so they stay on test against the new one. Freed slots are filled
 * from the backlog in its order. Pure: returns a new registry and the list of changes.
 */
export function applyVerdicts(lab, verdicts = {}, { date, rules = RULES } = {}) {
  const R = { ...RULES, ...(lab.rules || {}), ...rules };
  const next = structuredClone(lab); const changes = [];
  const promos = Object.entries(verdicts).filter(([id, v]) => v.action === 'promote' && next.variants[id]?.status === 'testing')
    .sort((a, b) => (b[1].lift ?? 0) - (a[1].lift ?? 0));
  for (const [id, v] of Object.entries(verdicts)) {
    if (v.action !== 'retire' || next.variants[id]?.status !== 'testing') continue;
    Object.assign(next.variants[id], { status: 'retired', ended: date, verdict: v.why }); changes.push({ id, action: 'retire', why: v.why });
  }
  if (promos.length) {
    const [id, v] = promos[0]; const old = next.champion;
    if (next.variants[old]) Object.assign(next.variants[old], { status: 'former-champion', ended: date });
    Object.assign(next.variants[id], { status: 'champion', ended: date, verdict: v.why }); next.champion = id;
    changes.push({ id, action: 'promote', why: v.why, replaced: old });
    for (const [other] of promos.slice(1)) changes.push({ id: other, action: 'keep', why: `also beat ${old}; stays on test against the new champion ${id}` });
  }
  const free = R.maxActive - testing(next).length;
  for (const id of (next.backlog || []).slice(0, Math.max(0, free))) {
    next.backlog = next.backlog.filter((x) => x !== id);
    if (!next.variants[id]) continue;
    Object.assign(next.variants[id], { status: 'testing', started: date }); changes.push({ id, action: 'start', why: next.variants[id].change || '' });
  }
  next.history = [...(next.history || []), ...changes.map((c) => ({ date, ...c }))];
  return { lab: next, changes };
}

// A fixed order that differs by day, so the same pages do not always land in the same variant.
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * Pages for the next run. Each challenger gets `perVariant` pages, split across the boost kinds so a
 * boost difference cannot pass for a CTA difference, and never a page that ran the same challenger the
 * day before. The champion keeps at least `perVariant` pages as the same-day control; when there are too
 * few pages for every challenger, the last ones in the list wait.
 */
export function assign({ pages = [], champion, challengers = [], perVariant = RULES.perVariant, yesterday = {}, date = '' } = {}) {
  const order = pages.slice().sort((a, b) => hash(`${date}|${a.account}`) - hash(`${date}|${b.account}`));
  const room = Math.max(0, Math.floor((pages.length - perVariant) / perVariant));
  const run = challengers.slice(0, room), waiting = challengers.slice(room);
  const out = {}; const left = new Set(order.map((p) => p.account));
  const boosts = [...new Set(order.map((p) => p.boost ?? null))];
  for (const id of run) {
    const picked = [];
    for (let i = 0; picked.length < perVariant && i < perVariant * boosts.length * 2; i++) {
      const want = boosts[i % boosts.length];
      const pool = order.filter((p) => left.has(p.account) && (p.boost ?? null) === want);
      const p = pool.find((x) => yesterday[x.account] !== id) || null;
      if (p) { picked.push(p); left.delete(p.account); }
    }
    for (const p of order) { if (picked.length >= perVariant) break; if (left.has(p.account)) { picked.push(p); left.delete(p.account); } }
    for (const p of picked) out[p.account] = id;
  }
  for (const p of order) if (left.has(p.account)) out[p.account] = champion;
  return { assignment: out, waiting };
}

// ---- wiring --------------------------------------------------------------------------------------
const arg = (argv, k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const boardsIn = (dir) => fs.readdirSync(dir).filter((n) => /^scoreboard-.*\.json$/.test(n)).map((n) => readJson(path.join(dir, n)));

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0], labFile = arg(argv, 'lab');
  if (!['status', 'judge', 'assign'].includes(cmd) || !labFile) { console.error('usage: node scripts/cta-lab.mjs status|judge --lab LAB --scores DIR [--log LOG] [--write] | assign --lab LAB --date YYYY-MM-DD --pages a:t0,b:ladder [--log LOG]'); return 2; }
  const lab = readJson(labFile); const rules = { ...RULES, ...(lab.rules || {}) };
  if (cmd === 'assign') {
    const date = arg(argv, 'date'), pages = String(arg(argv, 'pages') || '').split(',').filter(Boolean).map((s) => { const [account, boost] = s.split(':'); return { account, boost: boost || null }; });
    if (!date || !pages.length) { console.error('assign needs --date and --pages'); return 2; }
    const yesterday = {}; const logFile = arg(argv, 'log');
    if (logFile) { const prev = new Date(Date.parse(`${date}T00:00:00Z`) - 864e5).toISOString().slice(0, 10); for (const r of readJson(logFile).rows.filter((x) => x.date === prev)) yesterday[r.account] = variantOf(r); }
    const { assignment, waiting } = assign({ pages, champion: lab.champion, challengers: testing(lab), perVariant: rules.perVariant, yesterday, date });
    console.log(`${date}: champion ${lab.champion}, on test ${testing(lab).join(', ') || 'nothing'}`);
    for (const p of pages) console.log(`${p.account} | ${p.boost ?? '-'} | ${assignment[p.account]}${yesterday[p.account] ? ` | yesterday ${yesterday[p.account]}` : ''}`);
    for (const id of new Set(Object.values(assignment))) console.log(`  ${id}: ${lab.variants[id]?.change || ''}`);
    if (waiting.length) console.log(`waiting for pages: ${waiting.join(', ')}`);
    return 0;
  }
  const scores = arg(argv, 'scores'); if (!scores) { console.error(`${cmd} needs --scores DIR`); return 2; }
  // The log is the record of which variant a thread ran: a tag added after a scoreboard was written still counts.
  const logFile = arg(argv, 'log'); const tags = new Map(logFile ? readJson(logFile).rows.map((r) => [String(r.draftId), r]) : []);
  const rows = latestRows(boardsIn(scores)).map((r) => { const t = tags.get(String(r.draftId)); return t ? { ...r, variant: t.variant ?? null, group: t.group ?? null, arm: t.arm ?? null, lane: t.lane ?? r.lane ?? 'cover' } : r; });
  const verdicts = {};
  console.log(`champion: ${lab.champion} (${lab.variants[lab.champion]?.change || ''}) · ${rows.length} threads read`);
  console.log('| variant | threads | days | plug-tweet views | heavy clicks / 1k | champion same days | median | champion | days won | verdict |\n|---|---|---|---|---|---|---|---|---|---|');
  for (const id of testing(lab)) {
    const ev = evidence(rows, id, lab.champion); const v = verdict(ev, rules);
    verdicts[id] = { ...v, lift: ev.pooled != null && ev.champ.pooled ? ev.pooled / ev.champ.pooled : null };
    console.log(`| ${id} | ${ev.threads}${ev.pending ? ` (+${ev.pending} under 24h)` : ''} | ${ev.days.length} | ${ev.plugViews} | ${ev.pooled ?? 'unread'} | ${ev.champ.pooled ?? 'unread'} | ${ev.median ?? 'unread'} | ${ev.champ.median ?? 'unread'} | ${ev.dayWins} of ${ev.dayPairs} | ${v.action}: ${v.why} |`);
  }
  if (cmd === 'status') return 0;
  const date = new Date().toISOString().slice(0, 10);
  const { lab: next, changes } = applyVerdicts(lab, verdicts, { date, rules });
  for (const c of changes) console.log(`${c.action.toUpperCase()} ${c.id}: ${c.why}`);
  if (!changes.length) console.log('no change');
  if (argv.includes('--write') && changes.length) { fs.copyFileSync(labFile, `${labFile}.bak-${date}`); fs.writeFileSync(labFile, JSON.stringify(next, null, 1)); console.log(`written: ${labFile} (previous kept as .bak-${date})`); }
  else if (changes.length) console.log('nothing written (add --write)');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
