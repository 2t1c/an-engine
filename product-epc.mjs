#!/usr/bin/env node
// product-epc.mjs — MEASURED earnings per click, per product, from levanta-days.jsonl. Read-only.
//
// Exists because the number is easy to get wrong and expensive to get wrong. Choosing a pot's pair
// on EPC means the EPC has to be right, and a first attempt at this aggregation read the columns as
// (clicks, sales) and reported "EPC" of $3-5 a click — sales per click, an order of magnitude out,
// and confidently wrong in the direction that flatters every product.
//
// THE COLUMN MAPPING, and how it is known rather than assumed:
//   d = date · lv = link id · k = CLICKS · c = COMMISSION earned · s = gross SALES · o = ORDERS
// keep-asins.json records B0CKTQH4XM as "392 clicks, 4 orders, $32.95, EPC $0.084, CVR 1.0%", and
// only this mapping reproduces those four numbers exactly. --verify re-runs that check on every call,
// so a future change to the file format fails loudly here instead of quietly mis-ranking the board.
//
//   node product-epc.mjs                 # judged, mintable products by EPC
//   node product-epc.mjs --all           # include the unjudged and the unmintable, marked
//   node product-epc.mjs --asin B07...   # one product
//   node product-epc.mjs --json
//
// JUDGED means past the 100-click bar (operator's rule): below it a number means nothing either way.
// UNMINTABLE means no accessible Levanta product — Formulation Factory has none, so those ASINs 404
// on mint however well they read on this board. They are excluded by default for that reason alone.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE_DIR } from './lib.mjs';
import { DENY_ASINS } from './checks.mjs';

export const CLICK_BAR = 100;

/** PURE. Rows in, per-ASIN totals out. Exported so the mapping is testable without the file. */
export function aggregateDays(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r?.a) continue;
    const g = by.get(r.a) || { clicks: 0, commission: 0, sales: 0, orders: 0 };
    g.clicks += Number(r.k) || 0;
    g.commission += Number(r.c) || 0;
    g.sales += Number(r.s) || 0;
    g.orders += Number(r.o) || 0;
    by.set(r.a, g);
  }
  for (const g of by.values()) {
    g.epc = g.clicks ? g.commission / g.clicks : 0;
    g.cvr = g.clicks ? (g.orders / g.clicks) * 100 : 0;
  }
  return by;
}

/** The self-check. Returns null when the mapping still holds, else a description of the drift.
 *
 *  THE CANARY IS A FLOOR, NOT AN EQUALITY (2026-09-18). It was pinned to exact figures, and on
 *  2026-09-18 it refused the whole tool because B0CKTQH4XM had 393 clicks against a pinned 392 —
 *  one more click, earned after the pin was written. Nothing about the column mapping had moved;
 *  Levanta had simply kept ingesting, which is the one thing this file's input is guaranteed to do.
 *  A guard that fires on its subject succeeding is a guard that gets deleted, and it took
 *  `product-epc` — step 3c of /seed-mint, the standing "best pairing, EPC and glue wise" rule —
 *  offline until someone noticed.
 *
 *  What the pin is actually for is catching a COLUMN SWAP: reading orders where clicks were, or a
 *  different ASIN's row. Those do not look like "one more click". They land at a different
 *  magnitude, and usually a smaller one. So each figure must be at least what was measured and no
 *  more than a few times it — a band wide enough for a year of settlement and far too narrow for a
 *  mis-mapped column. `pinnedAt` records when the floor was taken, so a later reader can tell
 *  growth from drift. */
const MAPPING_PIN = { asin: 'B0CKTQH4XM', pinnedAt: '2026-09-15', clicks: 392, orders: 4, commission: 32.95 };
const PIN_CEILING = 4;
export function verifyMapping(by, pin = MAPPING_PIN, { ceiling = PIN_CEILING } = {}) {
  const g = by.get(pin.asin);
  if (!g) return `${pin.asin} has no rows — the fixture this mapping is pinned to is gone`;
  const bad = [];
  const band = (name, got, floor) => {
    if (got < floor - 0.01) bad.push(`${name} ${typeof got === 'number' ? Number(got.toFixed(2)) : got} is BELOW the ${pin.pinnedAt} floor of ${floor} — settled figures never shrink, so a column moved`);
    else if (got > floor * ceiling) bad.push(`${name} ${Number(got.toFixed(2))} is over ${ceiling}x the ${pin.pinnedAt} floor of ${floor} — that is a different column, not ${Math.round((Date.now() - Date.parse(pin.pinnedAt)) / 864e5)} days of ingestion`);
  };
  band('clicks', Math.round(g.clicks), pin.clicks);
  band('orders', g.orders, pin.orders);
  band('commission', g.commission, pin.commission);
  return bad.length ? `column mapping no longer reproduces keep-asins' figures for ${pin.asin}: ${bad.join(', ')}` : null;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(`--${k}`); return i > -1 ? argv[i + 1] : null; };
  const ALL = argv.includes('--all');
  const JSON_OUT = argv.includes('--json');
  const ONE = arg('asin');

  const rows = readFileSync(join(HERE_DIR, 'levanta-days.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const by = aggregateDays(rows);

  const drift = verifyMapping(by);
  if (drift) { console.error(`REFUSING: ${drift}`); process.exit(2); }

  const catalog = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8'));
  const arr = Array.isArray(catalog) ? catalog : (catalog.products || Object.values(catalog));
  const meta = (a) => arr.find((x) => x.asin === a) || {};
  // No catalogue row means nothing routes to it and mint would 404 — Formulation Factory's whole
  // shelf reads this way, and two of its ASINs otherwise top the table.
  const mintable = (a) => Boolean(meta(a).title) && !meta(a).unavailable;

  let out = [...by.entries()].map(([asin, g]) => ({
    asin, ...g, title: meta(asin).title || '', judged: g.clicks >= CLICK_BAR,
    mintable: mintable(asin), denied: DENY_ASINS.has(asin),
  }));
  if (ONE) out = out.filter((x) => x.asin === ONE);
  else if (!ALL) out = out.filter((x) => x.judged && x.mintable && !x.denied);
  out.sort((a, b) => b.epc - a.epc);

  const tot = out.reduce((s, x) => ({ c: s.c + x.clicks, m: s.m + x.commission }), { c: 0, m: 0 });
  const fleet = tot.c ? tot.m / tot.c : 0;

  if (JSON_OUT) { console.log(JSON.stringify({ fleetEpc: fleet, products: out }, null, 1)); return; }
  console.log(`\nMEASURED EPC — commission / deduped clicks, from levanta-days.jsonl`);
  console.log(`${out.length} product(s)${ALL || ONE ? '' : ` past the ${CLICK_BAR}-click bar, mintable, not denied`} · fleet EPC $${fleet.toFixed(3)}\n`);
  console.log('ASIN         clicks   comm$     EPC    CVR%   product');
  for (const x of out) {
    const flag = x.denied ? ' DENIED' : !x.mintable ? ' UNMINTABLE' : !x.judged ? ' unjudged' : '';
    console.log(`${x.asin} ${String(Math.round(x.clicks)).padStart(6)} ${x.commission.toFixed(0).padStart(7)}  ${x.epc.toFixed(3).padStart(6)} ${x.cvr.toFixed(2).padStart(6)}   ${(x.title || '(no catalogue row)').slice(0, 44)}${flag}`);
  }
  console.log('\nPick the HEAVY from the top of this list, then check the pair actually earns its place:');
  console.log('both opportunities serve the same promise, each with a supported reason (docs/glue.md LAW G1).');
  console.log('Cofactors, levers and sequences are pairing IDEAS, not proof one product requires another.');
  console.log('Two high-EPC products the thread never bridges to are still two ads, not a thread.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
