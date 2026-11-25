// store-catalog.mjs — 🛍️ builds ONE creator's storefront catalogue: store/catalog/<account>.json.
//
// The thread engine plugs 3 products per account (defaultProduct + 2 alts). A storefront is the rest of
// the shelf. This picks that shelf from the live Levanta catalogue, mints one tracked link per product,
// and writes a static JSON the store reads directly — no backend, no live API call from the browser, no
// key in a second place (see docs/STOREFRONT-SPEC.md §2 for why not a database).
//
// SELECTION (operator rule, 2026-08-17). Rank in this order:
//   1. realized conversions over --days (our OWN Levanta sales, aggregated by ASIN — same source as
//      browse-catalog.mjs §4). Demand we have actually observed beats every proxy.
//   2. commission rate.
//   3. review count (best in-catalog proxy for units sold when we have no sales of our own).
// Then cap at --cap. Excluded outright: stacks (STACK_RE), denied ASINs, novelty/devices (NOVELTY_RE),
// anything absent from the accessible catalogue (= out of stock / unpartnered), anything with no image
// (a storefront card with no picture is a dead card).
//
// LANE. Only products matching the account's `storeLane` regex ship. A short store of on-brand products
// converts better than a padded one, so if the lane yields fewer than --cap the store ships SHORT. This
// script will never backfill from outside the lane to hit a number.
//
// PROVEN-ACROSS-THE-PORTFOLIO, NOT PER-ACCOUNT. Realized sales are aggregated across every account's
// links, not just this creator's. A new page has almost no sales history of its own, so a per-account
// gate would rank on noise and effectively disable signal #1. The report prints BOTH figures every run
// so the choice stays visible and can be revisited once a page has its own history. --proven=account
// switches to this creator's own subid1 prefix.
//
// Levanta is egress-blocked from the sandbox, so this runs on an Actions runner (like browse-catalog.mjs
// and product-health.mjs). The workflow commits the JSON.
//
//   node store-catalog.mjs --account clara                 # build + write
//   node store-catalog.mjs --account clara --dry           # print the pick, mint nothing, write nothing
//   node store-catalog.mjs --account clara --cap 20 --days 90 --proven portfolio
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, levanta, logRun, runMain, productImage, cliArg, HERE_DIR } from './lib.mjs';
import { STACK_RE, NOVELTY_RE, DENY_ASINS } from './checks.mjs';
import { getAccount } from './accounts.mjs';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Same defensive field mapping as browse-catalog's norm() / product-health's normLive(), widened with
// the storefront fields (image/rating/reviews/deal). Levanta's preview shape is not fully documented,
// so every plausible key is read rather than assumed.
export const normStore = (p) => ({
  asin: p.primaryId || p.asin || p.id || p.productId,
  title: decodeEntities(p.title || p.name || ''),
  brand: decodeEntities(p.brand || p.brandName || ''),
  category: decodeEntities(p.category || p.categoryName || p.productCategory || ''),
  price: num(p.price?.value ?? p.price ?? p.buyBoxPrice ?? p.listPrice),
  commission: num(p.commission?.totalCommission ?? p.commission?.sellerCommission ?? p.commissionRate ?? p.commission),
  epc: num(p.platformEpc ?? p.epc ?? p.earningsPerClick ?? p.estimatedEpc),
  rating: num(p.rating ?? p.starRating ?? p.averageRating) || null,
  reviews: num(p.ratingsTotal ?? p.reviewCount ?? p.numReviews ?? p.reviews ?? p.totalReviews) || null,
  image: productImage(p),
  // Presence in the access:true catalogue is itself the in-stock signal (product-health.mjs treats
  // absence as `unavailable`). An explicit availability field, when the payload carries one, can only
  // make it FALSE — never true for something the catalogue already dropped.
  available: availabilityOf(p),
  deal: p.deal ?? p.promotion ?? p.discount ?? null,
});

// In-stock test. Levanta sends `availability` as an enum string — confirmed values IN_STOCK and
// OUT_OF_STOCK (live pull 2026-08-17).
// This gate is load-bearing, not defensive decoration: an access:true pull RETURNS out-of-stock
// products (the first sample product in that pull was OUT_OF_STOCK), so presence in the catalogue is
// NOT evidence of availability and a store built without this check would ship dead buy buttons.
// Unknown/absent flag = treat as available, since the product did come back from the catalogue.
export function availabilityOf(p) {
  const flag = p?.availability ?? p?.available ?? p?.inStock ?? p?.in_stock ?? p?.stockStatus ?? null;
  if (flag == null) return true;
  if (typeof flag === 'boolean') return flag;
  return !/out[ _-]?of[ _-]?stock|unavailable|discontinued|back[ _-]?order/i.test(String(flag));
}

// The feed HTML-escapes text ("Detox &amp; Cleanse", "Blended Vitamin &amp; Mineral Supplements"). The
// thread engine never rendered these fields verbatim; a storefront does, so decode or every other card
// shows a literal "&amp;".
export const decodeEntities = (s = '') => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .trim();

// Commission arrives as a fraction (0.8) or a percent (80) depending on the endpoint — normalize to a
// 0..1 fraction, matching the products.json convention.
export const commissionFrac = (c) => (c > 1 ? Math.round(c) / 100 : num(c));

/**
 * THE SELECTION RULE. Pure: catalogue in, chosen shelf out, no network and no clock.
 *
 * @param catalog normalized products (normStore shape)
 * @param lane    RegExp tested against `title category` — the creator's slice
 * @param pinned  ASINs that must appear regardless of rank (the account's defaultProduct + altProducts;
 *                those are what their threads actively plug, so a store that omits them contradicts the
 *                feed). They bypass lane/stack/novelty — an operator choice outranks a heuristic — but
 *                NOT the deny-list, which is a safety rule, nor availability, which would ship a dead
 *                card. A pinned product that cannot ship is reported, never silently dropped.
 * @param sales   Map asin -> { conversions, commission, clicks } over the window
 * @param cap     hard ceiling on shelf size
 * @returns { picked, stats } — picked is already in "creator's pick" order (pins first, then rank)
 */
export function pickShelf(catalog, { lane, exclude = null, pinned = [], sales = new Map(), cap = 20, perFormula = 1, provenOnly = true } = {}) {
  const drop = { unavailable: 0, denied: 0, stack: 0, novelty: 0, noImage: 0, outOfLane: 0, excluded: 0, variant: 0, unproven: 0 };
  const hay = (p) => `${p.title || ''} ${p.category || ''}`;
  const byAsin = new Map(catalog.map((p) => [p.asin, p]));
  const conv = (p) => num(sales.get(p.asin)?.conversions);

  // Hard gates every product must pass, pin or not.
  const shippable = (p) => {
    if (!p.available) { drop.unavailable++; return false; }
    if (DENY_ASINS.has(p.asin)) { drop.denied++; return false; }
    if (!p.image) { drop.noImage++; return false; }
    return true;
  };

  const pins = [];
  const pinConflicts = [];
  for (const asin of pinned) {
    const p = byAsin.get(asin);
    if (!p) { pinConflicts.push({ asin, why: 'not in the accessible catalogue (out of stock or unpartnered)' }); continue; }
    if (!p.available) { pinConflicts.push({ asin, why: 'flagged unavailable' }); continue; }
    if (DENY_ASINS.has(asin)) { pinConflicts.push({ asin, why: 'on the deny-list — deny outranks a pin' }); continue; }
    if (!p.image) { pinConflicts.push({ asin, why: 'no image in the feed' }); continue; }
    pins.push(p);
  }
  const pinnedSet = new Set(pins.map((p) => p.asin));

  const inLane = [];
  for (const p of catalog) {
    if (pinnedSet.has(p.asin)) continue;
    if (!shippable(p)) continue;
    if (STACK_RE.test(hay(p))) { drop.stack++; continue; }
    if (NOVELTY_RE.test(hay(p))) { drop.novelty++; continue; }
    if (lane && !lane.test(hay(p))) { drop.outOfLane++; continue; }
    if (exclude && exclude.test(hay(p))) { drop.excluded++; continue; }
    inLane.push(p);
  }

  // conversions → commission → reviews. Every tie-break is explicit so the order is total and stable.
  const ranked = [...inLane].sort((a, b) =>
    conv(b) - conv(a) ||
    commissionFrac(b.commission) - commissionFrac(a.commission) ||
    num(b.reviews) - num(a.reviews) ||
    num(b.epc) - num(a.epc) ||
    String(a.asin).localeCompare(String(b.asin)));

  // Fill the shelf: pins first, then rank order, skipping a product whose formula is already on it.
  // Pins are never collapsed (an operator choice outranks the heuristic) but they DO claim their
  // formula, so a ranked duplicate of a pinned product cannot follow it onto the shelf.
  const seenFormula = new Map();
  const picked = [...pins];
  for (const p of pins) seenFormula.set(formulaKey(p), 1);
  for (const p of ranked) {
    if (picked.length >= cap) break;
    // "Proven to convert" as membership, not just sort order: once the proven products run out the
    // only thing left to fill a slot with is something we have never sold, so the shelf ends there.
    // Padding the tail is how a curated shelf turns into a catalogue dump.
    if (provenOnly && !conv(p)) { drop.unproven++; continue; }
    if (perFormula > 0) {
      const k = formulaKey(p);
      const n = seenFormula.get(k) || 0;
      if (n >= perFormula) { drop.variant++; continue; }
      seenFormula.set(k, n + 1);
    }
    picked.push(p);
  }
  const proven = (p) => conv(p) > 0;
  return {
    picked,
    stats: {
      catalogSize: catalog.length,
      inLane: inLane.length + pins.length,
      provenInLane: [...inLane, ...pins].filter(proven).length,
      pickedProven: picked.filter(proven).length,
      pinned: pins.map((p) => p.asin),
      pinConflicts,
      short: picked.length < cap,
      distinctFormulas: new Set([...inLane, ...pins].map(formulaKey)).size,
      distinctProvenFormulas: new Set([...inLane, ...pins].filter((p) => conv(p) > 0).map(formulaKey)).size,
      drop,
    },
  };
}

// Actives a wind-down/recovery shelf is actually built from, longest-first so "magnesium l-threonate"
// is recognised before the bare "magnesium" inside it.
const ACTIVES = [
  'magnesium bisglycinate', 'magnesium glycinate', 'magnesium threonate', 'magnesium citrate',
  'magnesium taurate', 'magnesium malate', 'magnesium oxide', 'magnesium chloride', 'magnesium',
  'ashwagandha', 'theanine', 'glycine', 'melatonin', 'valerian', 'chamomile', 'lemon balm',
  'passionflower', 'passion flower', 'tart cherry', '5-htp', 'gaba', 'rhodiola', 'holy basil',
  'tulsi', 'tryptophan', 'saffron', 'magnolia', 'reishi', 'lavender',
];

/**
 * Identity of a product as a FORMULA rather than as a SKU: "<brand>|<primary active>".
 *
 * The catalogue lists the same formula many times over — Nutricost magnesium glycinate alone ships as
 * 360ct, 180ct, 90ct and a powder, and Sports Research' as 180ct, 90ct and two MCT softgel counts.
 * Ranked purely on demand those variants stack up and a 20-slot shelf becomes eleven bottles of
 * magnesium, four of them the same product in different sizes. Grouping on formula lets the shelf show
 * ONE of each and spend the freed slots on the next distinct product.
 *
 * Bisglycinate/l-threonate are spelling variants of the same chelate and normalize together. A product
 * naming no known active groups under its own ASIN, i.e. it is never treated as a duplicate.
 */
export function formulaKey(p) {
  const brand = String(p.brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const title = String(p.title || '').toLowerCase()
    .replace(/bisglycinate/g, 'glycinate')
    .replace(/l[- ]?threonate/g, 'threonate')
    .replace(/l[- ]?theanine/g, 'theanine')
    .replace(/l[- ]?tryptophan/g, 'tryptophan')
    .replace(/5[- ]?htp/g, '5-htp');
  const active = ACTIVES.find((a) => title.includes(a));
  return active ? `${brand}|${active}` : `asin|${p.asin}`;
}

/** Storefront tracking convention (docs/STOREFRONT-SPEC.md §5): store clicks stay separable from
 *  thread clicks at a glance, and revenue.mjs keeps attributing on subid1/subid2 unchanged. */
export const storeSubids = (account, asin) => ({
  subid1: `${account.levantaSubidPrefix}-store-${asin}`,
  subid2: account.levantaSubidPrefix,
});

/** Aggregate realized sales by ASIN over a window. `prefix` restricts to one account's subid1 namespace
 *  (used to MEASURE per-account history, and to rank on it under --proven=account). */
export function aggregateSales(rows, { prefix = null } = {}) {
  const agg = new Map();
  for (const r of rows) {
    // Attribution field, confirmed against a live v1 /reports pull 2026-08-17: the row carries NO
    // subid1/subid2. The minted subid1 comes back as `link.sourceId` (e.g. "x-thread-magnus-…"), with
    // sourceSubId/sourceName empty. Reading `subid1` here would have silently matched nothing and made
    // every per-account figure zero — which is exactly the shape of the answer we are testing for.
    const src = r.link?.sourceId ?? r.sourceId ?? r.subid1 ?? '';
    if (prefix && !String(src).startsWith(prefix)) continue;
    // `asin` is top-level on the report row and is the SOLD product (it can differ from the clicked
    // link's ASIN on a halo sale), which is the one worth ranking demand on.
    const asin = r.asin || r.link?.product?.primaryId || r.link?.product?.asin || r.link?.asin || r.product?.asin || null;
    if (!asin) continue; // an unmapped link cannot be attributed to a product — it must not inflate one
    const a = agg.get(asin) || { conversions: 0, commission: 0, clicks: 0 };
    a.conversions += num(r.conversions);
    a.commission += num(r.commissionEarned ?? r.commission);
    a.clicks += num(r.clicks);
    agg.set(asin, a);
  }
  return agg;
}

// Levanta caps a reports span at 60 days → walk the window in chunks (same as browse-catalog.mjs).
async function realizedRows(lev, days) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const wins = []; let end = new Date(); let rem = days;
  while (rem > 0) { const span = Math.min(60, rem); const start = new Date(end.getTime() - span * 864e5); wins.push({ start: iso(start), end: iso(end) }); end = new Date(start.getTime() - 864e5); rem -= span; }
  const rows = [];
  for (const w of wins) {
    try { rows.push(...await lev.listReports(w)); }
    catch (e) { console.warn(`  ⚠️ reports ${w.start}..${w.end}: ${e.message}`); }
  }
  return rows;
}

async function main() {
  const DRY = process.argv.includes('--dry');
  const key = cliArg('account', 'clara');
  const DAYS = Number(cliArg('days', '90'));
  const CAP = Number(cliArg('cap', '20'));
  const PROVEN = cliArg('proven', 'portfolio'); // portfolio | account
  const PER_FORMULA = Number(cliArg('per-formula', '1')); // 0 disables variant collapsing entirely
  const PROVEN_ONLY = cliArg('proven-only', 'true') !== 'false'; // false = allow unproven tail-fill
  const account = getAccount(key);
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY']);
  const lev = levanta(env);

  console.log(`\n================ STOREFRONT CATALOGUE · ${account.name} ================`);
  console.log(`lane=${account.storeLane ? String(account.storeLane) : '(none — whole catalogue)'}\ncap=${CAP} · window=${DAYS}d · proven-basis=${PROVEN}${DRY ? ' · DRY RUN' : ''}\n`);

  // ---- 1) live catalogue (authoritative for availability) ----
  const seen = new Set(); const catalog = [];
  for (const it of await lev.listAllProducts({ access: true })) {
    const n = normStore(it);
    if (n.asin && !seen.has(n.asin)) { seen.add(n.asin); catalog.push(n); }
  }
  const withImage = catalog.filter((p) => p.image).length;
  console.log(`live catalogue: ${catalog.length} accessible products · ${withImage} carry an image (${Math.round((withImage / Math.max(1, catalog.length)) * 100)}%)`);
  if (!withImage) throw new Error('no product in the live catalogue carries an image — the image field mapping is wrong (productImage in lib.mjs); refusing to ship an imageless storefront');

  // ---- 2) realized sales, measured BOTH ways so the ranking basis is evidenced, not asserted ----
  const rows = await realizedRows(lev, DAYS);
  const portfolioSales = aggregateSales(rows);
  const accountSales = aggregateSales(rows, { prefix: account.levantaSubidPrefix });
  const sumConv = (m) => [...m.values()].reduce((s, a) => s + a.conversions, 0);
  console.log(`\nrealized sales over ${DAYS}d:`);
  console.log(`  portfolio-wide : ${portfolioSales.size} ASINs with sales · ${sumConv(portfolioSales)} conversions`);
  console.log(`  ${account.levantaSubidPrefix}: ${accountSales.size} ASINs with sales · ${sumConv(accountSales)} conversions`);
  if (PROVEN === 'account' && !accountSales.size) console.log(`  ⚠️ --proven=account but this account has NO realized sales in the window — signal #1 is inert; ranking falls through to commission then reviews.`);
  const sales = PROVEN === 'account' ? accountSales : portfolioSales;

  // ---- 3) the pick ----
  const pinned = [account.defaultProduct?.asin, ...(account.altProducts || []).map((p) => p.asin)].filter(Boolean);
  const opts = { lane: account.storeLane, exclude: account.storeExclude, pinned, sales, cap: CAP, provenOnly: PROVEN_ONLY };
  const { picked, stats } = pickShelf(catalog, { ...opts, perFormula: PER_FORMULA });

  console.log(`\n---- SELECTION ----`);
  console.log(`in lane after vetting : ${stats.inLane}`);
  console.log(`  of those, PROVEN converters (>0 conversions in ${DAYS}d): ${stats.provenInLane}`);
  console.log(`  distinct formulas (brand + active): ${stats.distinctFormulas} total · ${stats.distinctProvenFormulas} of them proven`);
  console.log(`  → the shelf can hold at most ${stats.distinctProvenFormulas} products under "proven + one SKU per formula"`);
  console.log(`dropped: ${Object.entries(stats.drop).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (PER_FORMULA > 0) {
    // Show the counterfactual so the variant rule is auditable rather than invisible: this is the shelf
    // the literal rank-and-cap would have produced, and what collapsing size-variants changed about it.
    const flat = pickShelf(catalog, { ...opts, perFormula: 0 });
    const dupes = flat.picked.length - new Set(flat.picked.map(formulaKey)).size;
    console.log(`variant collapse: keeping ${PER_FORMULA} SKU per brand+active. Without it the same shelf would carry ${dupes} duplicate formula(s) (e.g. the same magnesium glycinate in 4 bottle sizes).`);
  }
  console.log(`pinned (account default + alts): ${stats.pinned.join(', ') || '(none shippable)'}`);
  for (const c of stats.pinConflicts) console.log(`  🛑 PINNED PRODUCT CANNOT SHIP — ${c.asin}: ${c.why}`);
  console.log(`\nshipping ${picked.length} of a ${CAP} cap${stats.short ? ` — SHORT by ${CAP - picked.length}. Clara's lane does not contain ${CAP} distinct proven converters; the shelf ends rather than padding with products we have never sold or with off-lane filler.` : ''}`);
  console.log(`  ${stats.pickedProven} of the ${picked.length} have realized conversions.`);

  const pct = (c) => `${Math.round(commissionFrac(c) * 100)}%`;
  console.log(`\n#  ASIN       conv  comm  price   rating/reviews  title`);
  picked.forEach((p, i) => {
    const c = num(sales.get(p.asin)?.conversions);
    console.log(`${String(i + 1).padStart(2)} ${p.asin}  ${String(c).padStart(4)}  ${pct(p.commission).padStart(4)}  $${String(p.price || '?').padStart(6)}  ${String(p.rating ?? '-').padStart(3)}★ ${String(p.reviews ?? '-').padStart(6)}  ${(p.title || '').slice(0, 60)}`);
  });

  // ---- 4) mint one tracked link per product ----
  // Display category for the storefront pills: first matching rule wins, last rule is the catch-all.
  const groupOf = (p) => (account.storeGroups || []).find(([, re]) => re.test(`${p.title} ${p.category}`))?.[0] || 'All';
  const products = [];
  const mintFailed = [];
  for (const p of picked) {
    const { subid1, subid2 } = storeSubids(account, p.asin);
    let url = null; let shortUrl = null; let linkId = null;
    if (DRY) {
      url = null;
    } else {
      // Minting is idempotent per (asin, subid1): the same pair returns the same lv_ link id, and a
      // different subid1 returns a different one — verified 2026-08-17. That is also the proof the
      // subid is recorded server-side, since the minted Amazon URL never spells it out: attribution
      // rides on the aa_adgroupid, which reports return as link.sourceId. So re-running this job
      // refreshes the shelf without littering the account with duplicate links.
      for (let attempt = 1; attempt <= 3 && !url; attempt++) {
        try {
          const res = await lev.mintLink(p.asin, subid1, subid2);
          url = res.url || res.link || res.shortUrl || res.short_url || null;
          shortUrl = res.mobileOptimizedUrl || res.shortUrl || null;
          linkId = res.id || null;
          if (!url) throw new Error(`no url in mint response: ${JSON.stringify(res).slice(0, 200)}`);
        } catch (e) {
          if (attempt === 3) { mintFailed.push({ asin: p.asin, error: e.message }); console.warn(`  ⚠️ mint ${p.asin} failed after 3 attempts: ${e.message}`); }
          else await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      }
    }
    // A card with no link is a card that cannot earn — drop it rather than ship a dead buy button.
    if (!url && !DRY) continue;
    products.push({
      asin: p.asin,
      title: p.title,
      brand: p.brand,
      category: p.category,
      price: p.price || null,
      commission: commissionFrac(p.commission),
      epc: p.epc || null,
      rating: p.rating,
      reviews: p.reviews,
      image: p.image,
      available: p.available,
      group: groupOf(p),
      ...(p.deal ? { deal: p.deal } : {}),
      creatorPick: stats.pinned.includes(p.asin),
      conversions: num(sales.get(p.asin)?.conversions),
      url,
      ...(shortUrl ? { shortUrl } : {}),
      ...(linkId ? { linkId } : {}),
      subid1,
      subid2,
    });
  }
  if (mintFailed.length) console.log(`\n⚠️ ${mintFailed.length} product(s) dropped — link minting failed: ${mintFailed.map((m) => m.asin).join(', ')}`);

  // ---- 5) write ----
  const out = {
    account: key,
    creator: {
      name: account.name,
      handle: account.handle,
      profile: `https://x.com/${account.handle}`,
      // The store's sign-off reuses the voice the threads already close on, so the page reads as hers.
      signoff: 'Rest well, Clara.',
    },
    disclosures: {
      // Both are REQUIRED on the page (docs/STOREFRONT-SPEC.md §6). Kept as two separate strings rather
      // than one paragraph so the store cannot render one and quietly omit the other.
      affiliate: 'As an Amazon Associate, I earn from qualifying purchases. Every product link on this page is an affiliate link, which means I may receive a commission if you buy — at no extra cost to you.',
      medical: 'This page is for general information only. Nothing here is medical advice, and none of these products are intended to diagnose, treat, cure, or prevent any disease. Talk to a licensed practitioner before starting any new supplement, especially if you are pregnant, nursing, taking medication, or managing a health condition.',
    },
    meta: {
      generated: new Date().toISOString(),
      windowDays: DAYS,
      provenBasis: PROVEN,
      provenNote: PROVEN === 'portfolio'
        ? 'Conversions are aggregated across ALL accounts, not just this creator: a recently-activated page has too little history of its own for a per-account gate to mean anything.'
        : `Conversions restricted to subid1 prefix ${account.levantaSubidPrefix}.`,
      lane: String(account.storeLane || ''),
      exclude: String(account.storeExclude || ''),
      perFormula: PER_FORMULA,
      provenOnly: PROVEN_ONLY,
      distinctFormulasInLane: stats.distinctFormulas,
      distinctProvenFormulasInLane: stats.distinctProvenFormulas,
      cap: CAP,
      count: products.length,
      shortOfCap: products.length < CAP,
      provenCount: products.filter((p) => p.conversions > 0).length,
      inLaneCandidates: stats.inLane,
      provenInLane: stats.provenInLane,
      dropped: stats.drop,
      pinConflicts: stats.pinConflicts,
      mintFailed,
    },
    products,
  };

  // TWO files, and the split matters. The internal one carries commission rates, EPC, realized
  // conversion counts and the subids — our margins and our sales figures. The storefront is a PUBLIC
  // page, so it is served the trimmed one: anything a shopper does not need is not shipped to their
  // browser. Publishing per-product commission would hand every competitor our rate card.
  const file = join(HERE_DIR, 'store', 'catalog', `${key}.json`);
  const publicFile = join(HERE_DIR, 'store', 'public', 'catalog', `${key}.json`);
  const publicOut = {
    account: out.account,
    creator: out.creator,
    disclosures: out.disclosures,
    meta: { generated: out.meta.generated, count: out.meta.count },
    products: products.map((p) => ({
      asin: p.asin, title: p.title, brand: p.brand, group: p.group,
      price: p.price, rating: p.rating, reviews: p.reviews, image: p.image,
      creatorPick: p.creatorPick, url: p.url,
    })),
  };
  if (!DRY) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
    mkdirSync(dirname(publicFile), { recursive: true });
    writeFileSync(publicFile, JSON.stringify(publicOut, null, 1) + '\n');
    console.log(`\n✓ wrote store/catalog/${key}.json (internal — commission, EPC, conversions, subids)`);
    console.log(`✓ wrote store/public/catalog/${key}.json (public — ${products.length} products, no commercials)`);
  } else {
    console.log(`\n(dry run: no links minted, nothing written)`);
  }

  logRun('store-catalog', {
    account: key, count: products.length, cap: CAP, short: products.length < CAP,
    inLane: stats.inLane, provenInLane: stats.provenInLane, provenShipped: out.meta.provenCount,
    provenBasis: PROVEN, portfolioAsinsWithSales: portfolioSales.size, accountAsinsWithSales: accountSales.size,
    dropped: stats.drop, pinConflicts: stats.pinConflicts.length, mintFailed: mintFailed.length, dry: DRY,
  });
  console.log(`\n================ END ================`);
}

// Import-safe: test-scaffolds imports the pure helpers above without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'store-catalog');
