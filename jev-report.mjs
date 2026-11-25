// jev-report.mjs — the decision log, per decision, as markdown (plan §1.1 "Report", Phase 0).
//
//   node jev-report.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dir learnings/jev-decisions]
//
// Reads the monthly shards jev-decide.mjs writes (learnings/jev-decisions/<YYYY-MM>.jsonl) and prints,
// per decision: rows, the source split (jev / incumbent / fallback), fallbacks, agreement with the
// incumbent in shadow, p50/p95 ms and total cost. Read-only and offline: it makes no model call, so
// there is no spend to flush (the CLIs that call flushLlmSpend are the ones that spend).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_LOG_DIR } from './jev-decide.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Month shards overlapping [from, to] (inclusive days), in order. */
export function shardsFor(dir, { from = null, to = null } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()
    .filter((f) => (!from || f.slice(0, 7) >= from.slice(0, 7)) && (!to || f.slice(0, 7) <= to.slice(0, 7)))
    .map((f) => join(dir, f));
}

/** Rows in [from, to] (inclusive days, by ts). A torn line is counted, not fatal. */
export function readRows(dir, range = {}) {
  const rows = [];
  let torn = 0;
  for (const file of shardsFor(dir, range)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { torn++; continue; }
      const day = String(row.ts || '').slice(0, 10);
      if (range.from && day < range.from) continue;
      if (range.to && day > range.to) continue;
      rows.push(row);
    }
  }
  return { rows, torn };
}

export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];
}

/** Pure: per-decision summary. Agreement counts shadow rows where Jev was read (jev set). */
export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.name)) by.set(r.name, []);
    by.get(r.name).push(r);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, rs]) => {
    const source = { jev: 0, incumbent: 0, fallback: 0 };
    for (const r of rs) if (r.source in source) source[r.source]++;
    const shadowRead = rs.filter((r) => r.mode === 'shadow' && r.jev != null);
    const agree = shadowRead.filter((r) => r.jev === r.incumbent).length;
    const costs = rs.map((r) => r.cost).filter(Number.isFinite);
    const modes = [...new Set(rs.map((r) => r.mode))].sort();
    // Latency is Jev's: off rows never call it and would drag the percentiles toward zero.
    const timed = rs.filter((r) => r.mode !== 'off').map((r) => r.ms);
    return {
      name, n: rs.length, source, fallbacks: source.fallback, modes,
      shadow: { read: shadowRead.length, agree, rate: shadowRead.length ? agree / shadowRead.length : null },
      p50: percentile(timed, 50), p95: percentile(timed, 95),
      cost: costs.reduce((a, b) => a + b, 0), unpriced: rs.filter((r) => r.source !== 'fallback' && r.jev != null && !Number.isFinite(r.cost)).length,
    };
  });
}

/**
 * Pure: Jev's bill per thread (owner, 2026-09-24: "track the bill per completed task"). Rows carry a
 * `subject` (the draft, run row or backlog id) where the caller knew it; rows without one are counted
 * as unattributed, never spread across threads.
 */
export function costBySubject(rows) {
  const by = new Map();
  let unattributed = 0, unattributedCost = 0;
  for (const r of rows) {
    const c = Number.isFinite(r.cost) ? r.cost : 0;
    if (!r.subject) { unattributed++; unattributedCost += c; continue; }
    const e = by.get(r.subject) || { subject: r.subject, reads: 0, cost: 0, decisions: new Set() };
    e.reads++; e.cost += c; e.decisions.add(r.name);
    by.set(r.subject, e);
  }
  const subjects = [...by.values()].map((e) => ({ ...e, decisions: [...e.decisions].sort() })).sort((a, b) => b.cost - a.cost);
  const costs = subjects.map((e) => e.cost);
  return { subjects, n: subjects.length, total: costs.reduce((a, b) => a + b, 0), median: percentile(costs, 50), p95: percentile(costs, 95), unattributed, unattributedCost };
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const ms = (x) => (x == null ? 'n/a' : `${Math.round(x)}`);

export function renderCostPerThread(c, { top = 10 } = {}) {
  const usd = (x) => `$${(x ?? 0).toFixed(6)}`;
  const lines = ['## Jev cost per thread', ''];
  if (!c.n) return [...lines, `No read carries a thread id yet (${c.unattributed} unattributed, ${usd(c.unattributedCost)}).`, ''].join('\n');
  lines.push(`${c.n} thread(s) · total ${usd(c.total)} · median ${usd(c.median)} · p95 ${usd(c.p95)} per thread · ${c.unattributed} read(s) without a thread id (${usd(c.unattributedCost)})`, '');
  lines.push('| Thread | Reads | Cost USD | Decisions |', '|:--|--:|--:|:--|');
  for (const e of c.subjects.slice(0, top)) lines.push(`| ${e.subject} | ${e.reads} | ${e.cost.toFixed(6)} | ${e.decisions.join(', ')} |`);
  lines.push('');
  return lines.join('\n');
}

export function renderMarkdown(summary, { from = null, to = null, torn = 0 } = {}) {
  const lines = [`# Jev decisions${from || to ? ` · ${from || '…'} → ${to || '…'}` : ''}`, ''];
  if (!summary.length) return [...lines, 'No decision rows in range.', ''].join('\n');
  lines.push('| Decision | Modes | n | Jev | Incumbent | Fallback | Shadow agreement | p50 ms | p95 ms | Cost USD |');
  lines.push('|:--|:--|--:|--:|--:|--:|:--|--:|--:|--:|');
  for (const s of summary) {
    lines.push(`| ${s.name} | ${s.modes.join(', ')} | ${s.n} | ${s.source.jev} | ${s.source.incumbent} | ${s.fallbacks} | ${s.shadow.read ? `${s.shadow.agree}/${s.shadow.read} (${pct(s.shadow.rate)})` : 'n/a'} | ${ms(s.p50)} | ${ms(s.p95)} | ${s.cost.toFixed(6)}${s.unpriced ? ` (+${s.unpriced} unpriced)` : ''} |`);
  }
  lines.push('');
  if (torn) lines.push(`- ${torn} unreadable log line(s) skipped.`, '');
  return lines.join('\n');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? null : process.argv[i + 1] ?? null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = arg('from'), to = arg('to');
  for (const [k, v] of [['from', from], ['to', to]]) {
    if (v != null && !DAY.test(v)) { console.error(`--${k} must be YYYY-MM-DD`); process.exit(1); }
  }
  const dir = resolve(arg('dir') || DECISION_LOG_DIR);
  const { rows, torn } = readRows(dir, { from, to });
  console.log(renderMarkdown(summarize(rows), { from, to, torn }));
  console.log(renderCostPerThread(costBySubject(rows)));
}
