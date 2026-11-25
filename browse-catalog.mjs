// browse-catalog.mjs — read-only Levanta catalog explorer. Answers "which products should we actually
// stock?" by pulling the FULL partnered catalog (not the pre-filtered products.json snapshot) and
// cross-referencing it against our OWN realized sales, so we choose on proven demand + commission rather
// than a guess. Runs on an Actions runner (Levanta is egress-blocked from the sandbox). Writes nothing.
//
//   node browse-catalog.mjs --lookup B0DLPGZTBL,B082TPDTM2 --days 90 --top 60
//
// Output blocks:
//   0) FIELD DISCOVERY  — raw keys + 2 sample product objects, so we see exactly what Levanta exposes
//      (rating / reviewCount / salesRank / epc), then a raw dump of every --lookup ASIN.
//   1) BEST SINGLES     — singles-only (stacks/deny excluded), ranked by commission, EPC, and review count
//      (Amazon review count is the best in-catalog proxy for units sold). NEW = not already in our 337.
//   2) BEST SELLERS     — the same singles re-ranked by the sales proxy alone, to surface high-demand SKUs.
//   3) PER TOPIC        — top single per classifyTopic bucket, for coverage gaps.
//   4) REALIZED SALES   — our actual Levanta conversions/commission over --days, aggregated by product
//      (the truest "lots of sales" signal — what has already sold through our own links).
import { loadEnv, requireEnv, levanta, cliArg, commissionFraction } from './lib.mjs';
import { STACK_RE, DENY_ASINS, isNovelty } from './checks.mjs';
import { classifyTopic } from './pick-product.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const env = loadEnv();
requireEnv(env, ['LEVANTA_API_KEY']);
const arg = cliArg; // shared getter (lib.mjs, audit 2026-07-21 dedup)
const LOOKUP = (arg('lookup', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const DAYS = Number(arg('days', '90'));
const TOP = Number(arg('top', '60'));
const GREP = (arg('grep', '') || '').toLowerCase();
const lev = levanta(env);

// asins already in our filtered snapshot (to flag what's NEW)
const have = new Set();
try { for (const p of JSON.parse(readFileSync(join(process.cwd(), 'products.json'), 'utf8')).products) have.add(p.asin); } catch {}

// Defensive field normalizer — Levanta's product preview shape isn't fully documented, so read every
// plausible field name and keep the raw object for discovery.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const norm = (p) => ({
  asin: p.primaryId || p.asin || p.id || p.productId,
  title: p.title || p.name || '',
  brand: p.brand || p.brandName || '',
  category: p.category || p.categoryName || p.productCategory || '',
  // Levanta nests these: price:{value}, commission:{totalCommission}, and platformEpc at top level.
  price: num(p.price?.value ?? p.price ?? p.buyBoxPrice ?? p.listPrice),
  commission: num(p.commission?.totalCommission ?? p.commission?.sellerCommission ?? p.commissionRate ?? p.commission),
  epc: num(p.platformEpc ?? p.epc ?? p.earningsPerClick ?? p.estimatedEpc),
  rating: num(p.rating ?? p.starRating ?? p.averageRating) || null,
  reviews: num(p.ratingsTotal ?? p.reviewCount ?? p.numReviews ?? p.reviews ?? p.totalReviews),
  rank: p.salesRank ?? p.bestSellersRank ?? p.bsr ?? null,
  raw: p,
});
// Commission may arrive as a fraction (0.8) or a percent (80) — display consistently as a percent.
const pctOf = (c) => Math.round(commissionFraction(c) * 100);
const isStack = (p) => STACK_RE.test(`${p.title} ${p.category}`);
// isNovelty (the device/cosmetic exclusion for the SUPPLEMENT ranking) now comes from checks.mjs
// beside STACK_RE. It was defined privately here, and the storefront builder needs the identical
// exclusion — two copies of one regex is the drift this repo keeps paying for.
const line = (p, extra = '') => `${have.has(p.asin) ? '   ' : 'NEW'} ${p.asin} | ${pctOf(p.commission)}% | $${p.price || '?'} | EPC ${p.epc || '-'} | ${p.reviews ? p.reviews + ' rev' : 'rev ?'}${p.rating ? ' ' + p.rating + '★' : ''}${extra ? ' | ' + extra : ''}\n       ${(p.title || '').slice(0, 82)}`;

// ---- pull the full catalog (pagination lives in lib's listAllProducts; dedup + normalize here) ----
async function fullCatalog() {
  const out = []; const seen = new Set();
  for (const it of await lev.listAllProducts({ access: true })) {
    const n = norm(it);
    if (n.asin && !seen.has(n.asin)) { seen.add(n.asin); out.push(n); }
  }
  return out;
}

// ---- our realized sales over the window (Levanta caps 60-day spans → chunk) ----
async function realized() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const wins = []; let end = new Date(); let rem = DAYS;
  while (rem > 0) { const span = Math.min(60, rem); const start = new Date(end.getTime() - span * 864e5); wins.push({ start: iso(start), end: iso(end) }); end = new Date(start.getTime() - 864e5); rem -= span; }
  const rows = [];
  for (const w of wins) { try { rows.push(...await lev.listReports(w)); } catch (e) { console.warn(`reports ${w.start}..${w.end}: ${e.message}`); } }
  return rows;
}

const catalog = await fullCatalog();
console.log(`\n================ LEVANTA CATALOG BROWSE ================`);
console.log(`Pulled ${catalog.length} accessible products. Our snapshot has ${have.size}. Window for realized sales: ${DAYS}d.\n`);

// ---- 0) field discovery ----
console.log(`---- 0) FIELD DISCOVERY (what Levanta actually exposes) ----`);
if (catalog.length) {
  console.log(`raw keys: ${Object.keys(catalog[0].raw).join(', ')}`);
  console.log(`\nsample #1:\n${JSON.stringify(catalog[0].raw, null, 1)}`);
  console.log(`\nsample #2:\n${JSON.stringify((catalog[1] || catalog[0]).raw, null, 1)}`);
}
if (LOOKUP.length) {
  console.log(`\n---- your ${LOOKUP.length} suggested ASINs ----`);
  for (const a of LOOKUP) {
    const p = catalog.find((x) => x.asin === a);
    if (p) console.log(`\n${a}${have.has(a) ? ' (already in our 337)' : ' (NOT in our 337)'}:\n${JSON.stringify(p.raw, null, 1)}`);
    else console.log(`\n${a}: not found in the accessible catalog (out of stock / not partnered / not access:true).`);
  }
}

const singles = catalog.filter((p) => !isStack(p) && !isNovelty(p) && !DENY_ASINS.has(p.asin));
// --grep: name-search the FULL catalog (stacks included) and stop — the fast path for "do we even
// carry X?" (first use: the operator's nattokinase mint, 2026-08-18).
// Several terms in one run: separate with "|" ("mouth tape|nasal strip"). Each hit prints the full
// line (commission, price, platform EPC, reviews) so a product-type scan needs no second --lookup pass.
if (GREP) {
  for (const term of GREP.split('|').map((s) => s.trim()).filter(Boolean)) {
    const hits = catalog.filter((p) => String(p.title || p.name || '').toLowerCase().includes(term))
      .sort((a, b) => b.epc - a.epc || b.reviews - a.reviews);
    console.log(`\nGREP "${term}" -> ${hits.length} hit(s) in the partnered catalog`);
    for (const p of hits.slice(0, 20)) console.log(line(p, p.category));
  }
  process.exit(0);
}
console.log(`\n---- 1) BEST SINGLES (commission → EPC → reviews); ${singles.length} singles of ${catalog.length} ----`);
for (const p of [...singles].sort((a, b) => pctOf(b.commission) - pctOf(a.commission) || b.epc - a.epc || b.reviews - a.reviews).slice(0, TOP)) console.log(line(p));

console.log(`\n---- 2) BEST SELLERS (by review count = units-sold proxy) ----`);
for (const p of [...singles].sort((a, b) => b.reviews - a.reviews || b.epc - a.epc).slice(0, 30)) console.log(line(p));

console.log(`\n---- 3) TOP SINGLE PER TOPIC (coverage) ----`);
const byTopic = {};
for (const p of singles) { const t = classifyTopic(`${p.title} ${p.category}`); (byTopic[t] ||= []).push(p); }
for (const [t, ps] of Object.entries(byTopic)) {
  const best = ps.sort((a, b) => (b.epc - a.epc) || (pctOf(b.commission) - pctOf(a.commission)) || (b.reviews - a.reviews))[0];
  console.log(`[${t}] ${line(best).trim()}`);
}

// ---- 4) realized sales by product ----
console.log(`\n---- 4) REALIZED SALES (our own Levanta conversions over ${DAYS}d) ----`);
const rows = await realized();
if (rows.length) console.log(`sample report row keys: ${Object.keys(rows[0]).join(', ')}\nsample row: ${JSON.stringify(rows[0])}`);
const agg = new Map();
for (const r of rows) {
  const asin = r.link?.product?.primaryId || r.link?.product?.asin || r.link?.asin || r.product?.primaryId || r.product?.asin || r.asin || null;
  const key = asin || `link:${r.link?.id || r.linkId || '?'}`;
  const a = agg.get(key) || { asin, clicks: 0, conversions: 0, commission: 0 };
  a.clicks += num(r.clicks); a.conversions += num(r.conversions); a.commission += num(r.commissionEarned ?? r.commission);
  agg.set(key, a);
}
const sold = [...agg.values()].filter((a) => a.conversions > 0 || a.commission > 0).sort((a, b) => b.commission - a.commission);
console.log(`\n${sold.length} products/links with realized sales in ${DAYS}d (by commission $):`);
for (const a of sold.slice(0, 40)) {
  const cat = a.asin ? catalog.find((p) => p.asin === a.asin) : null;
  console.log(`  $${a.commission.toFixed(2)} | ${a.conversions} conv | ${a.clicks} clk | ${a.asin || '(unmapped link)'}${cat ? ` | ${pctOf(cat.commission)}% | ${cat.title.slice(0, 50)}` : ''}`);
}
// products.json-schema entries for the --lookup ASINs, printed LAST so they're easy to lift from the log
// tail and paste straight into products.json (the curated-list wiring needs KEEP products present there).
if (LOOKUP.length) {
  const entries = LOOKUP.map((a) => catalog.find((p) => p.asin === a)).filter(Boolean).map((p) => ({
    asin: p.asin, title: p.title, brand: p.brand || '', category: p.category || '-',
    price: String(p.price || ''), commission: commissionFraction(p.commission), epc: String(p.epc || ''),
  }));
  console.log(`\n---- PRODUCTS.JSON ENTRIES (paste into products.json "products") ----`);
  console.log(JSON.stringify(entries, null, 1));
}
console.log(`\n================ END ================`);
