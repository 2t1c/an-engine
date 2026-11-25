#!/usr/bin/env node
// manifest-day.mjs <plan.json> <YYYY-MM-DD> [--send] [--note "..."]... — the receipt for one run day.
//
// One message per shipped day, at ship time, on the Telegram ops route: every cover, pot and attempt
// with its slot, page, arm, donor, pair, pods, hook band and draft, then the day's notes. Run 2 sent
// these at the end of the run from a scratchpad script, so Monday's receipt arrived after Monday's
// covers were live and the operator read four days at once. ship-day.mjs calls renderManifest as its
// last stage; this file is the same thing by hand, for a re-send or a day shipped some other way.
//
//   node manifest-day.mjs queues/run-2026-09-08.json 2026-09-11          # print
//   node manifest-day.mjs queues/run-2026-09-08.json 2026-09-11 --send   # print and send to ops
//   node manifest-day.mjs <plan> <day> --note "product test unspent" --note "..."
//
// Everything comes from files the run already writes: the plan rows, the specs they point at, the
// thread records (queues/threads) and the ledger. Nothing is fetched, nothing is typed twice.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, telegram, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { RECORDS_DIR, productCode } from './thread-record.mjs';
import { weekdayOf } from './plan-check.mjs';

const name = (k) => ACCOUNTS[k]?.name || k;
const code = (asin, products = []) => { const p = products.find((x) => x.asin === asin); return p ? productCode(p) : (asin || '?'); };

/** PURE. The weld sentence a cover spec's note carries, when it carries one. */
export function weldOf(note) {
  const s = String(note || '').replace(/\s+/g, ' ');
  const m1 = s.match(/sequence:\s*([^)]+)\)/i);
  if (m1 && m1[1].trim().length >= 30) return m1[1].trim().slice(0, 220);
  const m2 = s.match(/Pair (.+?)\.\s*Weld at T\d/);
  if (m2) return m2[1].trim().slice(0, 220);
  const m3 = s.match(/Pair ([^.]+)\./);
  return m3 ? m3[1].trim().slice(0, 220) : '';
}
/** PURE. "VAULT donor (dr_ericberg, 4.45M views, 605d; …)" -> "dr_ericberg, 4.45M views, 605d". */
export const donorOf = (note) => { const m = String(note || '').match(/donor \(([^;)]+)/i); return m ? m[1] : ''; };
/** PURE. "Run 2, Sep 7-11 2026 (Mon-Fri), …" -> "Run 2". */
export const runLabel = (plan = {}) => String(plan.run || '').split(',')[0].trim() || String(plan.batch || 'run');

/** PURE. The day's receipt as text.
 *  plan     — the run plan (batch, run, grid, days)
 *  day      — YYYY-MM-DD, a key of plan.days
 *  specs    — { [row.spec path]: parsed spec }
 *  records  — thread records (queues/threads), any order
 *  ledger   — parsed ledger rows, any order
 *  notes    — extra day-level lines (strings) */
export function renderManifest({ plan, day, specs = {}, records = [], ledger = [], notes = [] }) {
  const rows = plan?.days?.[day] || [];
  const grid = plan?.grid || {};
  const slot = (r) => r.slot ? String(r.slot).replace(/Z$/, '') : (grid[r.account] || '--:--');
  const bySlot = (a, b) => slot(a).localeCompare(slot(b));
  const covers = rows.filter((r) => r.bucket === 'cover').sort(bySlot);
  const pots = rows.filter((r) => r.bucket === 'pot').sort(bySlot);
  const harvests = rows.filter((r) => r.bucket === 'harvest');
  const recByDraft = (id) => records.find((r) => String(r?.thread?.draftId) === String(id));
  const ledgerRow = (id) => ledger.filter((l) => String(l.draftId) === String(id) && l.hookSim != null).pop() || ledger.filter((l) => String(l.draftId) === String(id)).pop();
  const L = [];
  L.push(`${runLabel(plan).toUpperCase()} · ${plan?.batch || ''} · ${weekdayOf(day) || '?'} ${day} · ${rows.length} slots = ${covers.length} cover / ${harvests.length} harvest / ${pots.length} pot`);
  L.push('');
  L.push('COVERS (slot UTC · page · arm · donor · heavy→light · plugs · hook · draft)');
  const heavyCount = {};
  for (const r of covers) {
    const spec = specs[r.spec] || {};
    heavyCount[r.heavy] = (heavyCount[r.heavy] || 0) + 1;
    const pods = (spec.pods || []).length ? `pods ${spec.pods.join('+')} pasted` : 'fresh skeleton';
    const vault = /VAULT/i.test(r.note || '') ? 'VAULT ' : '';
    const row = ledgerRow(r.draftId);
    const hook = row?.hookSim != null ? ` · hook ${row.hookSim}%` : '';
    const drift = spec.hookDrift?.class ? ` (${spec.hookDrift.class})` : '';
    L.push(`${slot(r)} ${name(r.account)} · ${r.cta || '?'} · ${vault}${donorOf(r.note) || r.donor || '?'} · ${code(r.heavy, spec.products)}→${code(r.light, spec.products)} · ${pods}${hook}${drift} · #${r.draftId || 'NOT SHIPPED'}${r.shareUrl ? ` ${r.shareUrl}` : ''}`);
    const w = weldOf(spec.note); if (w) L.push(`   weld: ${w}`);
  }
  if (!covers.length) L.push('(none)');
  L.push('');
  L.push('POTS (slot · page · arm · family · products · draft)');
  for (const r of pots) {
    const spec = specs[r.spec] || {};
    const prods = (spec.products || []).map((p) => productCode(p)).join('+') || `${code(r.heavy)}+${code(r.light)}`;
    const family = spec.potOf ? `${spec.potOf}${spec.seedVersion != null ? ` v${spec.seedVersion}` : ''}` : String(r.note || '').split(' · ')[0];
    L.push(`${slot(r)} ${name(r.account)} · ${r.cta || '?'} · ${family} · ${prods} · #${r.draftId || 'NOT SHIPPED'}${r.shareUrl ? ` ${r.shareUrl}` : ''}`);
  }
  if (!pots.length) L.push('(none)');
  L.push('');
  L.push('HARVESTS (slot UTC the evening before · page · body · heart · draft)');
  const hs = [];
  for (const r of harvests) {
    const row = ledger.filter((l) => String(l.draftId) === String(r.draftId) && l.publishAt).pop();
    const rec = recByDraft(r.draftId);
    const heart = String(rec?.built?.how || '').match(/heart\s*#?\s*(\d+)/i)?.[1];
    const when = row?.publishAt || null;
    const at = when ? new Date(when).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : (r.slot || '?');
    const title = rec?.thread?.title || '';
    const body = title.split(' — ')[1] || title.replace(/^\[Harvest\]\s*/, '') || r.body || '?';
    const swap = /swap/i.test(r.note || '') ? ` · SWAP: ${String(r.note).split(' · ')[0].slice(0, 120)}` : '';
    hs.push({ at, line: `${at} ${name(r.account)} · ${String(body).slice(0, 60)} · heart ${heart || '?'} · #${r.draftId || 'NOT CREATED'}${swap}` });
  }
  hs.sort((a, b) => a.at.localeCompare(b.at));
  for (const h of hs) L.push(h.line);
  if (!hs.length) L.push('(none)');
  L.push('');
  const money = rows.filter((r) => r.bucket !== 'harvest');
  const arms = money.reduce((m, r) => { const k = r.cta || '?'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const conc = Object.entries(heavyCount).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${code(a, Object.values(specs).flatMap((s) => s.products || []))} ${n}`).join(', ');
  L.push('DAY NOTES');
  L.push(`· arms across covers+pots: ${Object.entries(arms).map(([k, v]) => `${k} ${v}`).join(' / ') || 'none'}`);
  if (conc) L.push(`· heavy ASIN spread on covers: ${conc}`);
  const missing = money.filter((r) => !r.draftId);
  if (missing.length) L.push(`· NOT SHIPPED: ${missing.map((r) => `${name(r.account)} ${r.bucket}`).join(', ')}`);
  for (const n of (plan?.dayNotes?.[day] || [])) L.push(`· ${n}`);
  for (const n of notes) L.push(`· ${n}`);
  return L.join('\n');
}

/** Everything renderManifest needs, from the repo's own files. */
export function loadInputs(plan, day, root = HERE_DIR) {
  const specs = {};
  for (const r of plan?.days?.[day] || []) {
    if (!r.spec || specs[r.spec]) continue;
    const p = join(root, r.spec);
    if (existsSync(p)) { try { specs[r.spec] = JSON.parse(readFileSync(p, 'utf8')); } catch { /* an unreadable spec is a missing spec */ } }
  }
  const records = existsSync(RECORDS_DIR) ? readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(RECORDS_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean) : [];
  const lp = join(root, 'ledger.jsonl');
  const ledger = existsSync(lp) ? readFileSync(lp, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  return { specs, records, ledger };
}

async function main() {
  const [file, day] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !process.argv[process.argv.indexOf(a) - 1]?.startsWith('--note'));
  if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) { console.error('usage: node manifest-day.mjs <plan.json> <YYYY-MM-DD> [--send] [--note "..."]...'); process.exit(2); }
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  if (!plan.days?.[day]) throw new Error(`${file} has no day ${day}`);
  const notes = process.argv.flatMap((a, i) => (a === '--note' && process.argv[i + 1] ? [process.argv[i + 1]] : []));
  const text = renderManifest({ plan, day, ...loadInputs(plan, day), notes });
  console.log(text);
  console.log(`\n(${text.length} chars)`);
  if (process.argv.includes('--send')) { await telegram(loadEnv(), text, 'ops'); console.log('sent to ops'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'manifest-day');
