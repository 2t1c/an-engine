#!/usr/bin/env node
// product-board.mjs — what every ASIN actually earns, from the settled file, on one page.
//
// WHY THIS EXISTS. Every per-ASIN number in the repo came from a LIVE windowed Levanta API read
// (learn.mjs, product-audit.mjs). Those reads dedup clicks by taking a running MAX per (date, link),
// because /reports rows are per-(date, link, ASIN) and repeat the link-level click count on every
// halo-ASIN row. That rule is right when clicks repeat and WRONG when a link's clicks arrive split
// across rows — then MAX keeps one row and discards the rest. Measured 2026-08-26:
//
//     NAD+ B0DVFD5Q65   learnings/product-perf.json: 734 clicks, EPC $0.239
//                       levanta-days.jsonl:        2,334 clicks, EPC $0.092
//
// The picker ranks on that file (pick-product.mjs valueOf), so the fleet's worst product looked
// merely average and kept winning slots. levanta-days.jsonl is the settled per-(date, link) history
// with a verified zero-duplicate guarantee, so summing it is safe and it is the honest source.
//
// The board is keyed on the PLUGGED asin — the one routing controls, and the only one this file can
// see: levanta-days.jsonl carries no asin column, only (date, link). Levanta itself pays on the asin
// PURCHASED, which routinely differs because Amazon pays on anything in the session, and
// product-audit.mjs:70 learned that the hard way when the fleet's third-best earner hit a drop list
// under the plugged key alone. So: never RETIRE a product on this board by itself. Cross-check the
// bought key with `node product-audit.mjs` (live API) before cutting anything. Re-POINTING a bridge
// word is safe here, because that is a decision about where to send clicks, not about what a bottle
// is worth.
//
//   node product-board.mjs                 # the board, sorted by realized EPC
//   node product-board.mjs --report        # + the reallocation section (what the misroutes cost)
//   node product-board.mjs --json          # machine-readable
//   node product-board.mjs --write         # refresh learnings/product-board.json
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lifetimeByLink, LEV_DAYS_FILE } from './lev-days.mjs';
import { lvIdOf, HERE_DIR, runMain } from './lib.mjs';
import { linkMetaFrom } from './lev-days.mjs';
import { LAWS } from './laws.mjs';

const flag = (k) => process.argv.includes(`--${k}`);

// The operator's own bar: nothing is judged under this many lifetime clicks. At 70 clicks a
// zero-order product is 95% conclusive, at 100 it is 98.6% — so 100 is where a verdict becomes
// honest rather than an impression. Everything thinner is `unjudged` and must be HELD, not cut.
const MIN_CLICKS = LAWS.product?.winnerMinClicks ?? 100;
// Both floors are MULTIPLES of the measured fleet EPC, never absolute dollars: the fleet average
// moves as the mix improves, and a hardcoded floor silently stops meaning what it meant.
const LOSER_MULT = LAWS.product?.loserEpcMultiple ?? 0.35;
// The click unit (laws.product.$geniClickFactor): a geni.us-routed link's Levanta clicks count at this
// factor, so every EPC here is in plain-link dollars. And the newest settleDays days are left out of the
// judging until their orders have posted.
const GENI_FACTOR = LAWS.product?.geniClickFactor ?? 1;
const SETTLE_DAYS = LAWS.product?.settleDays ?? 0;
export const GENI_LINKS_FILE = join('learnings', 'geni-links.json');

/** The lv_ ids routed through geni.us, from learnings/geni-links.json ({ links: { lv_x: {...} } }). */
export function loadGeniLinks(path = join(HERE_DIR, GENI_LINKS_FILE)) {
  try { return new Set(Object.keys(JSON.parse(readFileSync(path, 'utf8')).links || {})); } catch { return new Set(); }
}

/**
 * levanta-days text with the unsettled days dropped and geni-routed clicks rescaled. Each kept row
 * carries `k` in plain-link units and `kRaw` as measured. Pure.
 */
export function judgedDays(levText, { geniLinks = new Set(), geniFactor = 1, settleDays = 0 } = {}) {
  const rows = [];
  let through = '';
  for (const line of String(levText || '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.lv && r.d) { rows.push(r); if (r.d > through) through = r.d; } } catch {}
  }
  // settleDays 2 on a file through Nov 7 leaves out Nov 6 and Nov 7.
  const cutoff = through && settleDays > 0
    ? new Date(Date.parse(`${through}T00:00:00Z`) - (settleDays - 1) * 86_400_000).toISOString().slice(0, 10)
    : null;
  const kept = [];
  const droppedDays = new Set();
  let dClicks = 0, dComm = 0;
  for (const r of rows) {
    if (cutoff && r.d >= cutoff) { droppedDays.add(r.d); dClicks += r.k || 0; dComm += r.c || 0; continue; }
    const f = geniLinks.has(r.lv) ? geniFactor : 1;
    kept.push({ ...r, kRaw: r.k || 0, k: (r.k || 0) * f });
  }
  const dropped = { days: droppedDays.size, clicks: dClicks, commission: +dComm.toFixed(2), from: cutoff };
  return { text: kept.map((r) => JSON.stringify(r)).join('\n'), rows: kept, through, dropped };
}

/** One row per PLUGGED asin, plus fleet totals. Pure — every input is passed in. */
export function boardFrom(levText, ledgerRows, products = [], { minClicks = MIN_CLICKS, loserMult = LOSER_MULT, geniLinks = new Set(), geniFactor = 1, settleDays = 0 } = {}) {
  const judged = judgedDays(levText, { geniLinks, geniFactor, settleDays });
  const byLink = lifetimeByLink(judged.text);
  const rawByLink = new Map();
  for (const r of judged.rows) rawByLink.set(r.lv, (rawByLink.get(r.lv) || 0) + r.kRaw);
  const cat = new Map((products || []).map((p) => [p.asin, p]));

  // link id -> plugged asin. Both product slots, positional: (link, asin) and (link2, asin2) —
  // the same pairing click-check.mjs:67 and learn.mjs:148 use. Rows arrive in FILE order and the
  // last write wins, so a deliberate re-point (6 links carry more than one asin across their life)
  // resolves to what the link most recently sold. Read raw lines, NOT parseLedger's byDraft view:
  // that merges per draftId and a metadata-only append can overlay away the very link/asin pair
  // this join needs.
  const asinOf = new Map();
  for (const r of ledgerRows || []) {
    for (const [u, a] of [[r.link, r.asin], [r.link2, r.asin2]]) {
      const id = u && lvIdOf(u);
      if (id && a) asinOf.set(id, a);
    }
  }
  // Second tier: Levanta's OWN record of what the link points at (the /dp/ ASIN in its URL),
  // persisted into levanta-days.jsonl. This is the authoritative answer to "which product did this
  // click travel to", it needs no ledger row, and it closes both gaps at once: re-mints the ledger
  // never learned about, and multi-plug threads whose 3rd, 4th and 5th plugs were minted but never
  // written down. Kept second so the ledger stays the primary record of what we MEANT to plug; the
  // two agree on 723 of 724 slot-exact pairings, so this only ever fills a genuine hole.
  //
  // A SUBID TIER WAS TRIED HERE AND IS WRONG. It looks right — a subid names the thread — but the
  // stem is derived from the hook slug, so a re-run after a dead-product swap mints the SAME subid
  // against a DIFFERENT product. Keying asin off subid moved 375 clicks onto B0BCCQVY8M whose link
  // actually pointed at B0DZ33GTQ2, and manufactured a $1.54 EPC "winner" out of the mismatch.
  const meta = linkMetaFrom(levText);

  const agg = new Map();
  let unjoined = { clicks: 0, commission: 0, links: 0 };
  const via = { link: 0, levanta: 0 };
  for (const [id, t] of byLink) {
    const m = meta.get(id) || {};
    let asin = asinOf.get(id);
    if (asin) via.link++;
    if (!asin && m.asin) { asin = m.asin; via.levanta++; }
    if (!asin) { unjoined.links++; unjoined.clicks += t.clicks; unjoined.commission += t.commission; continue; }
    const g = agg.get(asin) || { asin, clicks: 0, rawClicks: 0, geniLinks: 0, orders: 0, commission: 0, sales: 0, links: 0 };
    g.clicks += t.clicks; g.rawClicks += rawByLink.get(id) || 0; g.orders += t.orders; g.commission += t.commission; g.sales += t.sales; g.links++;
    if (geniLinks.has(id)) g.geniLinks++;
    agg.set(asin, g);
  }

  const rows = [...agg.values()];
  const fleetClicks = rows.reduce((n, r) => n + r.clicks, 0);
  const fleetComm = rows.reduce((n, r) => n + r.commission, 0);
  const fleetOrders = rows.reduce((n, r) => n + r.orders, 0);
  const fleet = {
    clicks: Math.round(fleetClicks),
    rawClicks: rows.reduce((n, r) => n + r.rawClicks, 0),
    orders: fleetOrders,
    commission: +fleetComm.toFixed(2),
    sales: +rows.reduce((n, r) => n + r.sales, 0).toFixed(2),
    epc: fleetClicks ? +(fleetComm / fleetClicks).toFixed(4) : 0,
    cvr: fleetClicks ? +(fleetOrders / fleetClicks).toFixed(4) : 0,
  };

  for (const r of rows) {
    const p = cat.get(r.asin) || {};
    r.clicks = Math.round(r.clicks); // plain-link units (geni clicks x geniFactor); rawClicks is Levanta's own count
    r.epc = r.clicks ? +(r.commission / r.clicks).toFixed(4) : 0;
    r.cvr = r.clicks ? +(r.orders / r.clicks).toFixed(4) : 0;
    r.aov = r.orders ? +(r.sales / r.orders).toFixed(2) : null;
    r.commission = +r.commission.toFixed(2);
    r.sales = +r.sales.toFixed(2);
    r.brand = p.brand || null;
    r.title = p.title || null;
    r.rate = p.commission ?? null;
    r.price = p.price ?? null;
    r.vsFleet = fleet.epc ? +(r.epc / fleet.epc).toFixed(2) : null;
    r.tier = r.clicks < minClicks ? 'unjudged'
      : r.epc >= fleet.epc ? 'winner'
      : r.epc < fleet.epc * loserMult ? 'loser'
      : 'mid';
  }
  rows.sort((a, b) => b.epc - a.epc || b.clicks - a.clicks);
  unjoined = { ...unjoined, commission: +unjoined.commission.toFixed(2) };
  unjoined.clicks = Math.round(unjoined.clicks);
  const clickUnit = { geniFactor, geniLinks: geniLinks.size, settleDays, unsettled: judged.dropped };
  return { fleet, rows, unjoined, via, minClicks, loserMult, clickUnit, generated: null };
}

/** What the below-fleet clicks would have earned in the winners basket. Pure. */
export function reallocation(board) {
  const judged = board.rows.filter((r) => r.tier !== 'unjudged');
  const winners = judged.filter((r) => r.epc >= board.fleet.epc);
  const below = judged.filter((r) => r.epc < board.fleet.epc);
  const wClicks = winners.reduce((n, r) => n + r.clicks, 0);
  const wComm = winners.reduce((n, r) => n + r.commission, 0);
  const basketEpc = wClicks ? wComm / wClicks : board.fleet.epc;
  const bClicks = below.reduce((n, r) => n + r.clicks, 0);
  const bComm = below.reduce((n, r) => n + r.commission, 0);
  const offenders = below
    .map((r) => ({ ...r, waste: +(r.clicks * (basketEpc - r.epc)).toFixed(2) }))
    .sort((a, b) => b.waste - a.waste);
  return {
    basketEpc: +basketEpc.toFixed(4),
    winners: { n: winners.length, clicks: wClicks, commission: +wComm.toFixed(2) },
    below: { n: below.length, clicks: bClicks, commission: +bComm.toFixed(2), epc: bClicks ? +(bComm / bClicks).toFixed(4) : 0 },
    prize: +(bClicks * basketEpc - bComm).toFixed(2),
    offenders,
  };
}

export function loadBoard(opts) {
  const levText = readFileSync(join(HERE_DIR, LEV_DAYS_FILE), 'utf8');
  const rows = [];
  for (const line of readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || [];
  const board = boardFrom(levText, rows, products, { geniLinks: loadGeniLinks(), geniFactor: GENI_FACTOR, settleDays: SETTLE_DAYS, ...opts });
  const days = levText.trim().split('\n');
  board.generated = { through: days.length ? JSON.parse(days[days.length - 1]).d : null, rows: days.length };
  return board;
}

/** Write learnings/geni-links.json from the Geniuslink API: every short link's lv_ adgroup id. Read-only on Geniuslink. */
export async function refreshGeniLinks(env) {
  const { geniuslink } = await import('./lib.mjs');
  const links = await geniuslink(env).listAllLinks({ includeArchived: true });
  const out = {};
  for (const l of links || []) {
    const u = decodeURIComponent(String(l.destinationUrl || '') + ' ' + String(l.productUrl || ''));
    const id = (u.match(/aa_adgroupid=(lv_[A-Za-z0-9]+)/) || [])[1];
    if (id) out[id] = { code: l.shortUrlCode || null };
  }
  const doc = { $: 'lv_ ids routed through geni.us (product-board.mjs --refresh-geni). The board counts their clicks at laws.product.geniClickFactor.', refreshed: new Date().toISOString(), links: out };
  writeFileSync(join(HERE_DIR, GENI_LINKS_FILE), JSON.stringify(doc, null, 1) + '\n');
  return Object.keys(out).length;
}

async function main() {
  if (flag('refresh-geni')) {
    const { loadEnv } = await import('./lib.mjs');
    console.log(`wrote ${GENI_LINKS_FILE}: ${await refreshGeniLinks(loadEnv())} geni-routed links`);
  }
  const board = loadBoard();
  if (flag('json')) { console.log(JSON.stringify(board, null, 1)); return; }

  const f = board.fleet;
  console.log(`\nPRODUCT BOARD — lifetime through ${board.generated.through} (${LEV_DAYS_FILE}, ${board.generated.rows} rows)`);
  console.log(`FLEET  ${f.clicks.toLocaleString()} clicks · ${f.orders} orders · $${f.commission.toFixed(2)} · EPC $${f.epc.toFixed(3)} · CVR ${(f.cvr * 100).toFixed(2)}%`);
  const cu = board.clickUnit;
  console.log(`Click unit: ${cu.geniLinks} geni-routed links count at x${cu.geniFactor}; raw Levanta clicks ${f.rawClicks.toLocaleString()}. Unsettled: ${cu.unsettled.days} day(s) from ${cu.unsettled.from || '-'} left out (${cu.unsettled.clicks} clicks, $${cu.unsettled.commission}).`);
  console.log(`Judged at >=${board.minClicks} clicks. loser floor = ${board.loserMult} x fleet = $${(f.epc * board.loserMult).toFixed(3)}/click.\n`);

  const mark = { winner: '✓', mid: ' ', loser: '✗', unjudged: '·' };
  console.log('   asin        clicks  ord     comm   CVR%     EPC   xfleet  brand / product');
  for (const r of board.rows) {
    console.log(` ${mark[r.tier]} ${r.asin}  ${String(r.clicks).padStart(6)} ${String(r.orders).padStart(4)} `
      + `$${r.commission.toFixed(0).padStart(6)} ${(r.cvr * 100).toFixed(1).padStart(6)} $${r.epc.toFixed(3)} `
      + `${String(r.vsFleet ?? '—').padStart(6)}x  ${String(r.brand || '?').slice(0, 17).padEnd(17)} ${String(r.title || '').slice(0, 32)}`);
  }
  const n = (t) => board.rows.filter((r) => r.tier === t).length;
  console.log(`\n  ✓ ${n('winner')} winners · ${n('mid')} mid · ✗ ${n('loser')} losers · · ${n('unjudged')} unjudged (held — under the ${board.minClicks}-click rule)`);
  console.log(`  joined via: ledger link ${board.via.link} · Levanta's own link record ${board.via.levanta}`);
  if (board.unjoined.links) {
    console.log(`  ${board.unjoined.links} links (${board.unjoined.clicks} clicks, $${board.unjoined.commission}) carry no ledger row — unattributable, not lost.`);
  }

  if (flag('report')) {
    const R = reallocation(board);
    console.log(`\nREALLOCATION — what the misroutes cost`);
    console.log(`  winners basket: ${R.winners.n} ASINs, ${R.winners.clicks.toLocaleString()} clicks, EPC $${R.basketEpc.toFixed(3)}`);
    console.log(`  below fleet:    ${R.below.n} ASINs, ${R.below.clicks.toLocaleString()} clicks, EPC $${R.below.epc.toFixed(3)}`);
    console.log(`  those clicks in the winners basket: $${(R.below.clicks * R.basketEpc).toFixed(0)} vs $${R.below.commission.toFixed(0)} actual  =>  +$${R.prize.toFixed(0)}`);
    console.log(`\n  worst offenders (clicks x EPC gap):`);
    for (const o of R.offenders.slice(0, 8)) {
      console.log(`    ${o.asin}  ${String(o.clicks).padStart(5)} clicks  EPC $${o.epc.toFixed(3)}  wasting $${o.waste.toFixed(0)}  ${String(o.title || '').slice(0, 40)}`);
    }
  }

  if (flag('write')) {
    const dir = join(HERE_DIR, 'learnings');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'product-board.json'), JSON.stringify(board, null, 1) + '\n');
    console.log(`\nwrote learnings/product-board.json (${board.rows.length} ASINs)`);
  }
  console.log('');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) await runMain(main, 'product-board');
