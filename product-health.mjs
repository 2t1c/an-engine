// product-health.mjs — 🩺 weekly LIVE catalog sync for products.json. The snapshot was hand-pulled
// 2026-07-17 and then never re-checked: a product that goes out of stock or loses its partnership
// keeps getting picked and plugged (dead-link risk), and commission/price/EPC drift silently
// mis-ranks the picker (tier + valueOf both read these fields). This pulls the full accessible
// Levanta catalog and:
//   - marks snapshot products missing from the live catalog `unavailable: true` — candidates() and
//     keepProductForTopic() then skip them. Marked, never deleted, so the weekly diff is reviewable
//     and a restock auto-clears the flag on the next run.
//   - refreshes price / commission / epc from live values (products.json conventions preserved:
//     price/epc strings, commission a fraction — normally 0..1, ABOVE 1 on a launch promo; the
//     scale split lives in lib.mjs commissionFraction and its comment says why that matters).
//   - alerts LOUDLY (performance topic, every run until resolved) when a curated KEEP product is
//     unavailable — the curated list is operator-owned, so this script NEVER edits keep-asins.json.
// Runs weekly on an Actions runner (Levanta is egress-blocked from the sandbox); the workflow
// commits the refreshed products.json.
//   node product-health.mjs          # sync + write + Telegram
//   node product-health.mjs --dry    # print only: no write, no Telegram
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, levanta, telegram, esc, report, logRun, runMain, HERE_DIR, commissionFraction } from './lib.mjs';
import { RATE_MOVES_FILE } from './rate-moves.mjs';
import { KEEP_ASINS } from './checks.mjs';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Same defensive field mapping as browse-catalog's norm(): Levanta nests price:{value} and
// commission:{totalCommission}, with platformEpc at the top level.
export const normLive = (p) => ({
  asin: p.primaryId || p.asin || p.id || p.productId,
  title: p.title || p.name || '',
  price: num(p.price?.value ?? p.price ?? p.buyBoxPrice ?? p.listPrice),
  commission: num(p.commission?.totalCommission ?? p.commission?.sellerCommission ?? p.commissionRate ?? p.commission),
  epc: num(p.platformEpc ?? p.epc ?? p.earningsPerClick ?? p.estimatedEpc),
  // Levanta reports stock per product and we were throwing it away. Being IN the accessible catalog
  // is not the same as being BUYABLE: on 2026-09-19, 2,882 of 8,631 accessible products came back
  // OUT_OF_STOCK, so `unavailable` was only ever catching products whose partnership had ended and
  // never one that was merely sold out. Absent/unknown is treated as in stock, because a field
  // Levanta stops sending must not silently retire the whole shelf.
  availability: p.availability ?? null,
});
export const outOfStock = (live) => live?.availability === 'OUT_OF_STOCK';

// Pure core (testable): snapshot products vs live-by-asin map -> updated products + change summary.
// `keep` = curated ASINs; a curated product absent from the live catalog lands in keepGone EVERY run
// (already-flagged ones too), so the alert repeats until the operator resolves it.
export function syncProducts(products, liveByAsin, { keep = new Set() } = {}) {
  const ch = { gone: [], outOfStock: [], recovered: [], keepGone: [], commissionMoves: [], refreshed: 0 };
  const out = products.map((p) => {
    const live = liveByAsin.get(p.asin);
    if (!live) {
      if (keep.has(p.asin)) ch.keepGone.push(p.asin);
      if (p.unavailable) return p;
      ch.gone.push(p.asin);
      return { ...p, unavailable: true };
    }
    // In the catalog but sold out — same consequence for us as gone (never link what can't be
    // bought), and reversible the moment it restocks, so it rides the same `unavailable` flag.
    if (outOfStock(live)) {
      if (keep.has(p.asin)) ch.keepGone.push(p.asin);
      if (p.unavailable) return p;
      ch.outOfStock.push(p.asin);
      return { ...p, unavailable: true };
    }
    const next = { ...p };
    if (next.unavailable) { delete next.unavailable; ch.recovered.push(p.asin); }
    const frac = commissionFraction(live.commission);
    if (frac && Math.abs(frac - num(p.commission)) >= 0.005) ch.commissionMoves.push({ asin: p.asin, from: num(p.commission), to: frac });
    if (live.price) next.price = String(live.price);
    if (frac) next.commission = frac;
    if (live.epc) next.epc = String(live.epc);
    if (JSON.stringify(next) !== JSON.stringify(p)) ch.refreshed++;
    return next;
  });
  return { products: out, changes: ch };
}

async function main() {
  const DRY = process.argv.includes('--dry');
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY', ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const lev = levanta(env);
  const file = join(HERE_DIR, 'products.json');
  const snap = JSON.parse(readFileSync(file, 'utf8'));

  const liveByAsin = new Map();
  for (const it of await lev.listAllProducts({ access: true })) {
    const n = normLive(it);
    if (n.asin && !liveByAsin.has(n.asin)) liveByAsin.set(n.asin, n);
  }
  console.log(`live catalog: ${liveByAsin.size} accessible products · snapshot: ${snap.products.length}`);
  // Anomaly guard: a truncated/hiccuping API response must not mass-flag the snapshot. The accessible
  // catalog is normally 10x our 341-product snapshot — anything smaller than half of it is an outage.
  if (liveByAsin.size < snap.products.length * 0.5) {
    throw new Error(`live catalog suspiciously small (${liveByAsin.size} < half of ${snap.products.length}) — refusing to mark the snapshot unavailable on an API hiccup`);
  }

  const { products, changes } = syncProducts(snap.products, liveByAsin, { keep: KEEP_ASINS });
  const unavailable = products.filter((p) => p.unavailable).length;
  const next = { ...snap, meta: { ...snap.meta, refreshed: new Date().toISOString().slice(0, 10), live_accessible: liveByAsin.size, unavailable }, products };

  const nameOf = (asin) => (products.find((x) => x.asin === asin)?.title || asin).slice(0, 52);
  const pct = (f) => `${Math.round(f * 100)}%`;
  const listOf = (asins, cap = 15) => asins.slice(0, cap).map((a) => `• ${a} — ${esc(nameOf(a))}`).join('\n') + (asins.length > cap ? `\n… +${asins.length - cap} more` : '');
  const sections = [
    { label: '🛑 CURATED (KEEP) UNAVAILABLE — picker now skips these; affected accounts fall back to defaults', body: changes.keepGone.length ? listOf(changes.keepGone) : '' },
    { label: `WENT UNAVAILABLE this week (of ${unavailable} total flagged)`, body: changes.gone.length ? listOf(changes.gone) : '' },
    { label: 'WENT OUT OF STOCK this week (in the catalog, not buyable)', body: changes.outOfStock.length ? listOf(changes.outOfStock) : '' },
    { label: 'RECOVERED (back in the live catalog — flag cleared)', body: changes.recovered.length ? listOf(changes.recovered) : '' },
    { label: 'COMMISSION MOVES (≥0.5pt)', body: changes.commissionMoves.length ? changes.commissionMoves.slice(0, 15).map((m) => `• ${pct(m.from)} → <b>${pct(m.to)}</b> — ${esc(nameOf(m.asin))}`).join('\n') : '' },
  ];
  const glyph = changes.keepGone.length ? '🛑' : (changes.gone.length || changes.outOfStock.length ? '⚠️' : '✅');
  const status = `${glyph} ${liveByAsin.size} live · ${snap.products.length} snapshot · ${unavailable} unavailable (${changes.gone.length} delisted, ${changes.outOfStock.length} out of stock, ${changes.recovered.length} recovered) · ${changes.refreshed} refreshed · ${changes.keepGone.length} KEEP gone`;
  const msg = report({
    emoji: '🩺', title: 'Product health', scope: 'weekly live-catalog sync', status, sections,
    action: changes.keepGone.length
      ? 'A curated KEEP product is gone from the live catalog — replace or restock it in keep-asins.json (this script never edits the curated list).'
      : (changes.gone.length ? 'Review the newly-unavailable list; non-curated losses need no action.' : 'no action'),
  });
  console.log('\n' + msg.replace(/<[^>]+>/g, ''));

  if (!DRY) {
    writeFileSync(file, JSON.stringify(next, null, 1) + '\n');
    console.log('\n✓ products.json refreshed');
    // RECORD THE RATE MOVES (2026-09-11). This sync has always computed commissionMoves and thrown
    // them away after the digest, which cost the picker the one fact it needs to stop ranking a
    // product at a rate we no longer pay: what the rate USED to be, and from when. Appending them
    // lets rate-moves.mjs restate a measured EPC at today's terms. Append-only, one line per move,
    // written only on a real sync — a dry run reports and records nothing.
    if (changes.commissionMoves.length) {
      const day = next.meta.refreshed;
      appendFileSync(RATE_MOVES_FILE, changes.commissionMoves.map((m) => JSON.stringify({ d: day, a: m.asin, from: m.from, to: m.to })).join('\n') + '\n');
      console.log(`✓ ${changes.commissionMoves.length} rate move(s) appended to learnings/rate-moves.jsonl`);
    }
  }
  logRun('product-health', { live: liveByAsin.size, snapshot: snap.products.length, unavailable, gone: changes.gone.length, outOfStock: changes.outOfStock.length, recovered: changes.recovered.length, refreshed: changes.refreshed, keepGone: changes.keepGone, dry: DRY });
  if (!DRY) { await telegram(env, msg, 'performance'); console.log('✓ sent to performance topic'); }
}

// Import-safe: test-scaffolds imports the pure helpers above without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'product-health');
