#!/usr/bin/env node
// scripts/jev-labels.mjs — the owner's verdicts as labels for Jev's decisions (plan v7 N6; owner,
// 2026-09-23: "become jev native": "every action of yours becomes a label").
//
// run-studio appends one hash-only row per verdict to learnings/run-verdicts.jsonl, with what Jev had
// decided for that row (jevAtVerdict). This joins them: per stage, how often the owner approved what Jev
// passed, and what Jev held or flagged. Numbers only, no copy. The weekly Jev workflow prints it beside
// the decision-log report; a promotion or retune stays the owner's call on this evidence.
//
//   node scripts/jev-labels.mjs [--file learnings/run-verdicts.jsonl] [--since YYYY-MM-DD] [--json]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const VERDICT_FILE = join(ROOT, 'learnings', 'run-verdicts.jsonl');

/** PURE. Verdict rows -> per stage { rows, withJev, table: { jevAction: { approve, hold, other } }, agree, disagree }. */
export function agreement(rows) {
  const out = {};
  for (const r of rows) {
    if (!['selection', 'drafts'].includes(r.stage) || !r.rowId) continue;
    const s = (out[r.stage] ||= { rows: 0, withJev: 0, table: {}, agree: 0, disagree: 0 });
    s.rows++;
    const a = r.jev?.action;
    if (!a) continue;
    s.withJev++;
    const v = r.verdict === 'approve' || r.verdict === 'inherit' ? 'approve' : r.verdict === 'hold' ? 'hold' : 'other';
    const cell = (s.table[a] ||= { approve: 0, hold: 0, other: 0 });
    cell[v]++;
    // Agreement: Jev passed and the owner approved, or Jev held/flagged and the owner held. review_needed
    // is neither: it asks the owner, so either verdict fits it.
    const jevPass = a === 'pass' || a === 'clean', jevStop = a === 'hold' || a === 'flagged';
    if ((jevPass && v === 'approve') || (jevStop && v === 'hold')) s.agree++;
    else if ((jevPass && v === 'hold') || (jevStop && v === 'approve')) s.disagree++;
  }
  return out;
}

export function renderAgreement(byStage, { total = 0 } = {}) {
  const L = ['## Owner verdicts vs Jev', '', `${total} verdict row(s) on file.`, ''];
  const stages = Object.entries(byStage);
  if (!stages.length) return [...L, 'No selection or drafts verdicts yet.'].join('\n');
  for (const [stage, s] of stages) {
    L.push(`### ${stage}: ${s.withJev}/${s.rows} verdicts carry Jev's decision · agree ${s.agree} · disagree ${s.disagree}`);
    L.push('', '| Jev | owner approved | owner held | other |', '|:--|--:|--:|--:|');
    for (const [a, c] of Object.entries(s.table)) L.push(`| ${a} | ${c.approve} | ${c.hold} | ${c.other} |`);
    L.push('');
  }
  return L.join('\n');
}

/**
 * PURE. Labels for the product picks (owner, 2026-09-24: "set the new thresholds against your
 * verdicts"). A Jev pick is a decision-log row for plug-fill (automint) or plug-replacement
 * (link-sentinel) whose source is 'jev' and whose subject is `draft:<id>`. If the draft's product is
 * swapped (a ledger row with mode 'swap' on that draft) within `days` of the pick, the pick counts as
 * overturned; if the window has closed with no swap, it stood. Picks still inside the window are open.
 */
export function productLabels(decisions, ledger, { days = 14, now = Date.now() } = {}) {
  const swaps = new Map();
  for (const l of ledger) if (l?.mode === 'swap' && l.draftId != null) (swaps.get(String(l.draftId)) || swaps.set(String(l.draftId), []).get(String(l.draftId))).push(Date.parse(l.ts));
  const out = {};
  for (const d of decisions) {
    if (!['plug-fill', 'plug-replacement'].includes(d.name) || d.source !== 'jev' || !String(d.subject || '').startsWith('draft:')) continue;
    if (!['fill', 'replace'].includes(d.action)) continue;
    const s = (out[d.name] ||= { picks: 0, stood: 0, overturned: 0, open: 0 });
    s.picks++;
    const at = Date.parse(d.ts), end = at + days * 864e5;
    const hit = (swaps.get(String(d.subject).slice(6)) || []).some((t) => t >= at && t <= end);
    if (hit) s.overturned++; else if (now > end) s.stood++; else s.open++;
  }
  return out;
}

export function renderProductLabels(byName, { days = 14 } = {}) {
  const L = ['## Jev product picks vs later swaps', '', `A pick is overturned when the draft's product is swapped within ${days} days; it stood when the window closed without one.`, ''];
  const names = Object.entries(byName);
  if (!names.length) return [...L, 'No Jev product pick on file yet (plug-fill, plug-replacement).', ''].join('\n');
  L.push('| Decision | Picks | Stood | Overturned | Still open |', '|:--|--:|--:|--:|--:|');
  for (const [n, s] of names) L.push(`| ${n} | ${s.picks} | ${s.stood} | ${s.overturned} | ${s.open} |`);
  L.push('', 'The ai-evo decisions (aie-lane, aie-rewrite) have no label source yet: an owner deletion of a scheduled AI Evolution post is not recorded anywhere this report can read.', '');
  return L.join('\n');
}

async function main() {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const file = arg('file', VERDICT_FILE), since = arg('since');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => !since || String(r.at).slice(0, 10) >= since) : [];
  const byStage = agreement(rows);
  const { readRows } = await import('../jev-report.mjs');
  const { DECISION_LOG_DIR } = await import('../jev-decide.mjs');
  const decisions = readRows(DECISION_LOG_DIR, { from: since }).rows;
  const ledgerFile = join(ROOT, 'ledger.jsonl');
  const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const products = productLabels(decisions, ledger);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ total: rows.length, byStage, products }, null, 2));
  else console.log(`${renderAgreement(byStage, { total: rows.length })}\n\n${renderProductLabels(products)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
