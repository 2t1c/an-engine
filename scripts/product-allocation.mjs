// Read-only product review for a collaborative /run. Canonical preflight chooses cover products;
// this module adds evidence and fleet checks without changing approved seed/harvest contracts.
import { createHash } from 'node:crypto';
import { LANES, laneOf } from '../lanes.mjs';
import { commitSlateProducts } from '../preflight.mjs';
import { resolveQueue, testProductsFor } from '../product-queue.mjs';
import { selectPod } from '../outline.mjs';
import { ALLOW_ASINS, DENY_ASINS, EXPERIMENT_ASINS } from '../checks.mjs';
import { plugCapFor, floorVerdict, bridgeUnsellable } from '../pick-product.mjs';
import { productFitLines } from '../product-fit.mjs';
import { productDecisionLines } from '../product-decisions.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { LAWS } from '../laws.mjs';

const ASIN = /^[A-Z0-9]{10}$/;
const dateDays = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5;
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// Products-stop triage (plan A3): `review_needed` still fires on every flag and reason it fired on before;
// this only says which of them need the owner's decision before approval (blocking) and which are context
// the owner can read past (informational: evidence freshness and missing measurements, and instructions
// for the writer). Anything not listed here is blocking, so a new flag is never quietly demoted.
export const INFORMATIONAL = Object.freeze([
  /^catalog commission missing$/,
  /^catalog refresh date missing$/,
  /^catalog rate \d+ days old; refresh before minting$/,
  /^our EPC measurement missing$/,
  /^our EPC is unjudged \(/,
  /^EPC measurement window missing$/,
  /^EPC board \d+ days old; refresh before relying on it$/,
  /^selector says writer must build an explicit bridge$/,
  /^floorExempt: /,
]);
export const flagKind = (flag) => (INFORMATIONAL.some((re) => re.test(String(flag))) ? 'informational' : 'blocking');

/** Pure: a row's reasons and placement flags split by kind. Placement flags are prefixed by placement. */
export function triageRow(row) {
  const all = [...(row.reasons || []), ...(row.placements || []).flatMap((p) => p.flags.map((f) => `${p.placement}: ${f}`))];
  const kindOf = (item) => flagKind(item.replace(/^(heavy|light|extra-\d+): /, ''));
  return { blocking: all.filter((x) => kindOf(x) === 'blocking'), informational: all.filter((x) => kindOf(x) === 'informational') };
}

export function productEvidence(asin, catalog, board, privateRates = {}) {
  const p = catalog.get(asin);
  const measurement = board?.rows?.find((r) => r.asin === asin);
  const privateRate = privateRates[asin] || null;
  const through = board?.generated?.through || null;
  const clicks = measurement?.clicks ?? null;
  return {
    asin, title: p?.title || null, available: !!p && !p.unavailable,
    rate: {
      catalog: p?.commission != null && Number.isFinite(Number(p.commission)) ? Number(p.commission) : null,
      catalogAsOf: p?.catalogAsOf || null,
      private: privateRate ? { commission: Number(privateRate.commission), source: privateRate.source,
        verifiedAt: privateRate.verifiedAt } : null,
    },
    epc: {
      value: measurement?.epc ?? null, clicks, orders: measurement?.orders ?? null,
      status: !measurement || measurement.epc == null ? 'missing' : clicks < (board?.minClicks ?? 100) ? 'unjudged' : 'measured',
      window: through ? `lifetime through ${through}` : null,
      source: through ? 'learnings/product-board.json, settled Levanta link attribution' : null,
    },
  };
}

/** The board's rows in productPerf()'s shape, so the floor reads the numbers the packet prints. */
const perfOf = (board) => Object.fromEntries((board?.rows || []).map((r) => [r.asin,
  { clicks: r.clicks, conv: r.orders, commission: r.commission, epc: r.epc }]));

/** What a placement needs besides its slot: the catalog, our EPC board and how old each is. */
export function placementContext({ products = [], board = null, privateRates = {}, catalogRefreshed = null, now = Date.now() } = {}) {
  const catalog = new Map(products.map((p) => [p.asin, { ...p, catalogAsOf: catalogRefreshed }]));
  const ageDays = (date) => typeof date === 'string' && !Number.isNaN(Date.parse(date))
    ? Math.floor((now - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 864e5) : null;
  return { catalog, board, privateRates, perf: perfOf(board), catalogAgeDays: ageDays(catalogRefreshed),
    boardAgeDays: ageDays(board?.generated?.through), freshnessReviewAfterDays: 7 }; // review prompt, not a content-policy cutoff
}

/** Whether a product can be placed on a thread at all: in the catalog and available, on the selection
 *  menu (keep or allow, or an experiment), not denied, and covered by a pod so a CTA can be written. */
export function sellableFor(products = []) {
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  return (asin) => {
    const p = byAsin.get(asin);
    return !!p && !p.unavailable && !DENY_ASINS.has(asin)
      && (!ALLOW_ASINS.size || ALLOW_ASINS.has(asin) || EXPERIMENT_ASINS.has(asin)) && !!selectPod(p, {})?.pod;
  };
}

/** The reasons that hold a row, and the status they give it. */
const HOLD_RE = /source selection|no canonical|returned no|kept product|contract products missing|invalid or unavailable|same ASIN|this run allows at most|is a proven loser|^product fit: /;
export const rowStatus = (reasons, placements) => (reasons.some((x) => HOLD_RE.test(x)) ? 'held'
  : reasons.length || placements.some((p) => p.flags.length) ? 'review_needed' : 'proposed');
const relabel = (placements) => placements.map((p, i) => ({ ...p, placement: i === 0 ? 'heavy' : i === 1 ? 'light' : `extra-${i + 1}` }));
const settle = (row, placements, reasons, resolutions) => {
  row.placements = relabel(placements); row.reasons = reasons; row.resolutions = resolutions;
  row.status = rowStatus(reasons, row.placements); row.triage = triageRow(row);
  return row;
};

// PRODUCT FIT AT SELECTION (owner, R2026-10-03: "I think in future run we should be extra careful with
// selection so there is no need to reconsider after plugging"). That run changed four covers' products
// after their threads were written: a product titled for men on a women's page and the reverse,
// ashwagandha on a failing-liver thread, caffeine gum on a kidney thread. Caught here, in the selection
// build: a misfit beside another product is dropped (the next one leads); alone, it holds the row so the
// donor is reselected. A donor that recommends no product holds in resolveJevProductDecisions.
const BOTH_SEXES = /\bunisex\b|\b(?:men|male)(?:['’]s)?\s*(?:,|and|&|\/)\s*(?:women|female)\b|\b(?:women|female)(?:['’]s)?\s*(?:,|and|&|\/)\s*(?:men|male)\b/i;
const FOR_MEN = /\b(?:for men|men['’]s|male)\b/i, FOR_WOMEN = /\b(?:for women|women['’]s|female)\b/i;
/** Pure: 'm' or 'f' when a product's title names one sex, else null (neither, or both). */
export function productSex(title) {
  const t = String(title || '');
  if (BOTH_SEXES.test(t)) return null;
  const m = FOR_MEN.test(t), f = FOR_WOMEN.test(t);
  return m === f ? null : m ? 'm' : 'f';
}

/** Pure: the laws.json product.safetyClash entry a product hits on this donor, with what matched, or null. */
export function safetyClashOf(asin, donor, clashes = LAWS.product?.safetyClash || []) {
  if (!donor) return null;
  const text = `${donor.hook || ''}\n${donor.text || ''}`;
  for (const c of clashes) {
    if (!(c.asins || []).includes(asin)) continue;
    if (donor.topic && (c.topics || []).includes(donor.topic)) return { ...c, match: donor.topic };
    for (const word of c.donorWords || []) {
      const hit = text.match(new RegExp(`\\b(?:${word})\\w*`, 'i'));
      if (hit) return { ...c, match: hit[0].toLowerCase() };
    }
  }
  return null;
}

/** The row's misfit test: (placement) -> { drop, hold } lines when the product does not fit the page
 *  (accounts.mjs `sex`; a page without one is not checked) or the donor's thread, else null. */
export function misfitFor(row, { accounts = ACCOUNTS, clashes } = {}) {
  const sex = ['m', 'f'].includes(accounts[row?.account]?.sex) ? accounts[row.account].sex : null;
  return (p) => {
    const own = productSex(p.title);
    if (sex && own && own !== sex) {
      const titled = `titled for ${own === 'm' ? 'men' : 'women'}`;
      return { drop: `dropped ${p.asin} (${titled}) on a ${sex === 'm' ? 'male' : 'female'} page`, hold: `${p.asin} is ${titled}; this page is ${sex}: reselect` };
    }
    const c = safetyClashOf(p.asin, row?.donor, clashes);
    if (!c) return null;
    const thread = `on a ${c.match} thread (${c.why})`;
    return { drop: `dropped ${p.asin}, ${c.substance} ${thread}`, hold: `${c.substance} (${p.asin}) ${thread}: reselect` };
  };
}

/**
 * AUTO-RESOLVE A COVER'S PRODUCT HOLDS (owner 2026-09-28: rows waiting on the owner at selection,
 * "Nothing: auto-resolve all", and "Product check and holds and reselect should be in selection build").
 * Each resolution is written into `row.resolutions` for the packet and the receipt. A pot's or a harvest's
 * products are its contract and are never touched; a hold with no safe resolution stays a hold.
 *   the same product twice      -> kept once
 *   a proven loser beside another product -> dropped; the next product moves up (the $0.45 floor stands)
 *   more products than the run allows      -> the first ones are kept
 *   a kept product the selector did not propose -> the selector's first product stands
 */
export function autoResolveRow(row, { productsMax = null } = {}) {
  if (row.lane !== 'cover' || !row.placements?.length) return row;
  const resolutions = [...(row.resolutions || [])];
  let placements = [...row.placements], reasons = [...row.reasons];
  const drop = (re) => { reasons = reasons.filter((x) => !re.test(x)); };
  if (reasons.some((x) => /same ASIN appears twice/.test(x))) {
    const seen = new Set();
    placements = placements.filter((p) => !seen.has(p.asin) && seen.add(p.asin));
    drop(/same ASIN appears twice/); resolutions.push('the same product was placed twice: kept once');
  }
  const losers = placements.filter((p) => !p.forced && p.flags.some((f) => f.startsWith('proven loser: ')));
  if (losers.length && losers.length < placements.length) {
    placements = placements.filter((p) => !losers.includes(p));
    drop(/is a proven loser/);
    for (const p of losers) resolutions.push(`${p.asin} is a proven loser (${p.flags.find((f) => f.startsWith('proven loser: ')).slice('proven loser: '.length)}): dropped, ${placements[0].asin} leads`);
  }
  const keep = Array.isArray(row.keep) ? row.keep : [];
  if (reasons.some((x) => /^kept product .* is not among/.test(x))) {
    drop(/^kept product .* is not among/);
    placements = placements.slice(0, Math.max(1, keep.length));
    resolutions.push(`the kept product ${keep.join(', ')} is not among the selector's candidates: its first product stands`);
  }
  const cap = Number.isInteger(productsMax) ? productsMax : null;
  if (cap && new Set(placements.map((p) => p.asin)).size > cap) {
    const cut = placements.slice(cap).map((p) => p.asin);
    placements = placements.slice(0, cap);
    resolutions.push(`over this run's ${cap}-product limit: kept the first ${cap}, dropped ${cut.join(', ')}`);
  }
  drop(/this run allows at most/);
  if (placements.length <= 2) drop(/review all beyond the first two separately/);
  return settle(row, placements, reasons, resolutions);
}

/**
 * JEV'S PRODUCT DECISIONS RESOLVE THE ROW; THEY NO LONGER HOLD IT (owner 2026-09-28, asked what to do
 * when the donor does not argue the proposed product: "Keep donor, sell anyway"). R2026-09-27 held 27
 * covers on these decisions and swapped every donor, recent winners included. Now, per decision:
 *   the donor argues an unproposed product more (rival_beats_heavy), and we can sell it
 *        -> that product becomes the heavy (the donor's own argument carries it)
 *   the donor does not argue the heavy (or the thread may recommend nothing)
 *        -> the heavy stays, marked for an explicit bridge the writer builds
 *   the donor recommends no product, and the heavy is all but unargued (laws.json product.selectionFit)
 *        -> the row holds, and the donor is reselected (R2026-10-03), even under a forced heavy
 *   the second product is not earned -> it is dropped: one product, one call to action
 *   not read -> the selector's products stand, and the row says so
 * A product the owner forced onto the row is never replaced: it keeps its bridge.
 * `sellable(asin)` says whether a product can be placed at all (catalog, menu, a pod).
 */
export function resolveJevProductDecisions(row, ctx, { sellable = () => false, threshold = 0.5, margin = 0.2,
  noProduct = LAWS.product?.selectionFit?.noProduct || {} } = {}) {
  const d = row.jevDecisions;
  if (row.lane !== 'cover' || !d || !row.placements?.length) return row;
  const resolutions = [...(row.resolutions || [])];
  let placements = [...row.placements];
  let reasons = [...row.reasons];
  const heavy = placements[0], h = d.heavy, s = d.second;
  if (h?.status === 'read' && h.jevAction === 'flag') {
    const why = h.reasons || [];
    const fit = row.jev?.status === 'ok' ? row.jev : null;
    const heavyNoul = fit?.candidates?.find((c) => c.asin === heavy.asin)?.noul ?? null;
    const rival = (fit?.candidates || []).filter((c) => !placements.some((p) => p.asin === c.asin) && Number.isFinite(c.noul))
      .sort((a, b) => b.noul - a.noul)[0] || null;
    const rivalWins = rival && rival.noul >= threshold && (heavyNoul == null || rival.noul - heavyNoul >= margin);
    // THE DONOR RECOMMENDS NO PRODUCT (owner R2026-10-03, "be extra careful with selection"): no bridge sells
    // a product into a thread that recommends none (S1003-marcos, caffeine gum on a kidney thread, Jev any
    // 0.04, fit 0.01). The row holds for a reselect, a forced heavy too; laws.json product.selectionFit.
    const any = fit?.anySupplement;
    if (why.includes('no_product') && Number.isFinite(any) && Number.isFinite(heavyNoul)
      && any < noProduct.anySupplementBelow && heavyNoul < noProduct.heavyFitBelow) {
      reasons.push(`product fit: the donor recommends no product (Jev any ${any.toFixed(2)}, heavy fit ${heavyNoul.toFixed(2)}): reselect the donor`);
    } else if (!heavy.forced && why.includes('rival_beats_heavy') && rivalWins && sellable(rival.asin)) {
      const picked = placementFor({ asin: rival.asin, needsBridge: false }, 0, { row, ...ctx });
      // The heavy's CTA need is the slot's, not the product's: it carries over to the product taking it.
      const swapped = heavy.need ? { ...picked, need: heavy.need, flags: picked.flags.filter((f) => f !== 'distinct CTA need not yet supplied') } : picked;
      placements = [swapped, ...placements.slice(1).filter((p) => p.asin !== rival.asin)];
      // A product-fit hold on the replaced heavy goes with it; one on a product still placed stands.
      reasons = reasons.filter((x) => !(x.startsWith('product fit: ') && x.includes(heavy.asin)));
      resolutions.push(`Jev: the donor argues ${rival.label || rival.asin} (${rival.asin}) more than ${heavy.asin}: it is the heavy now`);
    } else {
      placements[0] = { ...heavy, needsBridge: true, flags: [...new Set([...heavy.flags, 'selector says writer must build an explicit bridge'])] };
      resolutions.push(heavy.forced
        ? `Jev: the donor does not argue ${heavy.asin}; it stays (the owner forced it) and the writer builds the bridge`
        : `Jev: the donor does not argue ${heavy.asin}; kept, and the writer builds an explicit bridge ("Keep donor, sell anyway")`);
    }
  } else if (h?.status === 'not read') resolutions.push(`Jev's heavy check was not read (${h.reason}): the selector's product stands`);
  if (s?.status === 'read' && s.jevAction === 'flag' && placements[1] && !placements[1].forced
    && !(s.bridgeExpected && (s.reasons || []).every((r) => r === 'second_unsupported'))) {
    resolutions.push(`Jev: the second product ${placements[1].asin} is not earned: dropped, one product`);
    placements = placements.filter((_, i) => i !== 1);
  } else if (s?.status === 'not read') resolutions.push(`Jev's second-product check was not read (${s.reason}): the selector's products stand`);
  return settle(row, placements, reasons, resolutions);
}

/** One placement with its evidence and flags: the selector's slot, or a product the products stop
 *  reselected for the row (the donor's own argued product). */
function placementFor(slot, i, { row, catalog, board, privateRates, perf, catalogAgeDays, boardAgeDays, freshnessReviewAfterDays }) {
  const asin = slot.asin;
  const evidence = productEvidence(asin, catalog, board, privateRates);
  const flags = [];
  if (!ASIN.test(asin || '')) flags.push('invalid ASIN');
  if (!catalog.has(asin)) flags.push('ASIN missing from catalog');
  else if (catalog.get(asin).unavailable) flags.push('catalog flags unavailable');
  if (evidence.rate.catalog == null) flags.push('catalog commission missing');
  if (catalogAgeDays == null) flags.push('catalog refresh date missing');
  else if (catalogAgeDays > freshnessReviewAfterDays) flags.push(`catalog rate ${catalogAgeDays} days old; refresh before minting`);
  if (evidence.epc.status === 'missing') flags.push('our EPC measurement missing');
  else if (evidence.epc.status === 'unjudged') flags.push(`our EPC is unjudged (${evidence.epc.clicks} clicks)`);
  if (!evidence.epc.window) flags.push('EPC measurement window missing');
  if (boardAgeDays != null && boardAgeDays > freshnessReviewAfterDays) flags.push(`EPC board ${boardAgeDays} days old; refresh before relying on it`);
  if (evidence.rate.private && evidence.rate.catalog !== evidence.rate.private.commission) flags.push('private rate differs from catalog; verify before minting');
  if (slot.needsBridge) flags.push('selector says writer must build an explicit bridge');
  // THE $0.45 FLOOR AT THE STOP THAT SEES THE PRODUCT (R2026-09-26). The selector lets a proven
  // loser through when nothing else in the topic converts, and this run approved a probiotic
  // (B0BRTJ7BJ1) and the zinc drops (B0CLYQ9KX2) under the floor with their numbers on the packet
  // and nothing saying so. A proven loser now holds its row; a floorExempt product passes with a
  // note.
  const floor = floorVerdict(catalog.get(asin) || { asin }, perf);
  const measured = floor.underFloor ? `EPC $${floor.epc.toFixed(3)} on ${floor.clicks} clicks, under the $${floor.floor.toFixed(2)} floor` : '';
  // A COMMITTED ROUTE IS SHOWN, NOT HELD. A cover product the donor itself argues (no bridge for the
  // writer to build) is the route the thread has already committed to, and pick-product governs
  // those by the RELATIVE floor on purpose (bridgeUnsellable, 2026-09-19): holding them on the
  // absolute bar strands the thread under LAW G6. The owner still sees the number here.
  const committed = row.lane === 'cover' && !slot.needsBridge;
  if (floor.loser && committed && !bridgeUnsellable(asin, perf)) flags.push(`under the floor on a committed route: ${measured}; shown, not held (the donor argues it)`);
  else if (floor.loser) flags.push(`proven loser: ${measured}`);
  else if (floor.underFloor) flags.push(`floorExempt: ${measured}; passes on the owner's exemption (keep-asins.json)`);
  const need = row.needs?.[i] || null;
  if (!need) flags.push('distinct CTA need not yet supplied');
  return { placement: i === 0 ? 'heavy' : i === 1 ? 'light' : `extra-${i + 1}`,
    ...evidence, need, needsBridge: !!slot.needsBridge,
    test: !!slot.test, testSlot: slot.testSlot || null, ...(slot.forced ? { forced: true } : {}), flags };
}

/** Input rows have stable IDs; cover donors come from a SHA-verified selection snapshot in the CLI. */
export function planProductAllocation({ rows, expectedRows = rows?.length, products, board, queue = [], privateRates = {}, productsMax = null,
  catalogRefreshed = null, now = Date.now(), selector = commitSlateProducts } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows[] must contain at least one run slot');
  if (!Number.isSafeInteger(expectedRows) || expectedRows < rows.length) throw new Error('expectedRows must cover every supplied row');
  if (!Array.isArray(products)) throw new Error('products[] catalog is required');
  const ids = new Set();
  for (const row of rows) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.id || '') || ids.has(row.id)) throw new Error(`duplicate or invalid row ID: ${row.id}`);
    ids.add(row.id);
    row.lane = laneOf(row.lane);
    if (!LANES.includes(row.lane) || !row.account || !validDate(row.date)) throw new Error(`${row.id}: account, ISO date, and cover/harvest/seed lane required (a pot is the seed lane)`);
    if (row.needs != null && (!Array.isArray(row.needs) || row.needs.some((need) => typeof need !== 'string'))) {
      throw new Error(`${row.id}: needs must be an array of CTA-need strings`);
    }
  }
  for (const [asin, override] of Object.entries(privateRates)) {
    if (!ASIN.test(asin) || !override || !Number.isFinite(Number(override.commission))
      || Number(override.commission) < 0 || Number(override.commission) > 1 || !override.source
      || !override.verifiedAt || Number.isNaN(Date.parse(override.verifiedAt))) {
      throw new Error(`${asin}: private rate requires commission 0–1, source and verifiedAt`);
    }
  }
  const { catalog, perf, catalogAgeDays, boardAgeDays, freshnessReviewAfterDays } = placementContext({ products, board, privateRates, catalogRefreshed, now });
  const resolvedQueue = resolveQueue(queue, { products, status: new Map(),
    hasPod: (p) => !!selectPod(p, {})?.pod, now });
  const tests = testProductsFor(resolvedQueue).map((t) => ({ ...t,
    title: catalog.get(t.asin)?.title || '' }));
  const covers = rows.filter((r) => r.lane === 'cover').sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const slate = covers.map((r) => ({ account: r.account, donor: r.donor ? { ...r.donor } : null }));
  const selection = selector(slate, products, { testProducts: tests });
  const picked = new Map(covers.map((r, i) => [r.id, slate[i]]));
  const proposals = rows.map((row) => {
    const reasons = [];
    if (row.selectionStatus?.startsWith('held')) reasons.push(`source selection ${row.selectionStatus}`);
    // A one-CTA cover carries one product, and `keep` names it: the candidate its donor argues (Jev's
    // product fit). It narrows the canonical selector's own candidates, in the order given, and can
    // never add a product the selector did not propose.
    const keep = row.lane === 'cover' && Array.isArray(row.keep) ? row.keep.filter(Boolean) : [];
    let slots;
    if (row.lane === 'cover') {
      if (!row.donor) reasons.push('no canonical donor/source');
      slots = picked.get(row.id)?.products || [];
      if (!slots.length) reasons.push('canonical cover selector returned no sellable product');
      const missing = keep.filter((asin) => !slots.some((slot) => slot.asin === asin));
      if (slots.length && missing.length) reasons.push(`kept product ${missing.join(', ')} is not among the canonical selector's candidates`);
      else if (slots.length && keep.length) {
        // A product the owner FORCED onto this row (product-queue.json `forced`, the multivitamin, 2026-09-28)
        // stays: it is the owner's allocation, not a candidate for keep to narrow away. On a one-CTA cover
        // it is the one product.
        const forced = slots.filter((slot) => slot.forced);
        const kept = keep.map((asin) => slots.find((slot) => slot.asin === asin)).filter((slot) => !slot.forced);
        slots = [...forced, ...kept].slice(0, Math.max(keep.length, forced.length));
      }
    } else {
      // A pot or verbatim harvest already has its product contract. Never send it through a picker.
      if (!Array.isArray(row.contractProducts) || !row.contractProducts.length) reasons.push(`${row.lane} contract products missing`);
      if (!row.contractSource) reasons.push(`${row.lane} contract source not supplied; verify original body before approval`);
      slots = (row.contractProducts || []).map((p) => typeof p === 'string' ? { asin: p } : p);
    }
    if (slots.length > 2) reasons.push(`selector/contract provides ${slots.length} placements; review all beyond the first two separately`);
    // The run's content rules (intake productsMax, owner 2026-09-23) cap distinct products per thread. The
    // selector does not know the cap, so a row over it is HELD here, the first stop that sees its products.
    const distinct = new Set(slots.map((slot) => slot.asin)).size;
    if (Number.isInteger(productsMax) && distinct > productsMax) reasons.push(`${distinct} products; this run allows at most ${productsMax}: choose which to keep`);
    if (slots.length === 1 && !keep.length) reasons.push('only one natural product placement; owner should decide whether a second honestly fits');
    let placements = slots.map((slot, i) => placementFor(slot, i, { row, catalog, board, privateRates, perf, catalogAgeDays, boardAgeDays, freshnessReviewAfterDays }));
    // Product fit at selection (R2026-10-03): a misfit beside another product is dropped, as a proven
    // loser is (the next one leads); a row of misfits holds for a reselect. A forced product is checked
    // too: the owner's allocation does not override the page or the thread (a short queue shows in conflicts).
    const resolutions = [];
    if (row.lane === 'cover') {
      const misfit = misfitFor(row);
      const found = placements.map((p) => [p, misfit(p)]).filter(([, why]) => why);
      const kept = placements.filter((p) => !found.some(([q]) => q === p));
      if (found.length && kept.length) {
        // A dropped heavy hands its CTA need to the product that now leads (the Jev rival swap does the same).
        const heavy = placements[0];
        if (found.some(([p]) => p === heavy) && heavy.need && kept[0].need !== heavy.need) kept[0] = { ...kept[0], need: heavy.need, flags: kept[0].flags.filter((f) => f !== 'distinct CTA need not yet supplied') };
        placements = relabel(kept);
        for (const [, why] of found) resolutions.push(`product fit: ${why.drop}; ${kept[0].asin} leads`);
      } else for (const [, why] of found) reasons.push(`product fit: ${why.hold}`);
    }
    if (placements.length >= 2 && placements[0].need && placements[1].need && placements[0].asin !== placements[1].asin
      && placements[0].need.trim().toLowerCase() === placements[1].need.trim().toLowerCase()) {
      reasons.push('heavy and light CTA needs are identical; review the distinct reader decisions');
    }
    if (placements.some((p) => p.flags.some((f) => /invalid ASIN|missing from catalog|flags unavailable/.test(f)))) {
      reasons.push('invalid or unavailable product in proposed placement');
    }
    // A pot or harvest contract may list one product once per plug (the 21kg body plugs the same product at
    // T4 and T16, R2026-09-27): that is the body's own contract. From the selector, a repeat is a mistake.
    if (row.lane === 'cover' && new Set(placements.map((p) => p.asin)).size !== placements.length) reasons.push('same ASIN appears twice in one thread');
    for (const p of placements) {
      const loser = p.flags.find((f) => f.startsWith('proven loser: '));
      if (loser) reasons.push(`${p.placement} ${p.asin} is a ${loser.replace(': ', ', ')}. Owner decides: another product, or a floorExempt entry in keep-asins.json`);
    }
    const status = rowStatus(reasons, placements);
    return { id: row.id, account: row.account, date: row.date, lane: row.lane, ...(keep.length ? { keep } : {}),
      sourceId: row.donor?.recId || row.sourceId || row.contractSource || null, status, reasons,
      placements, ...(resolutions.length ? { resolutions } : {}), contractSource: row.contractSource || null,
      contractVersion: row.contractVersion || '', harvestOf: row.harvestOf || '',
      contractUnchangedByPlanner: row.lane !== 'cover' };
  });
  for (const row of proposals) row.triage = triageRow(row);
  const allPlacements = proposals.flatMap((row) => row.placements.map((p) => ({ ...p, row })));
  const byAsin = new Map();
  for (const p of allPlacements) {
    const x = byAsin.get(p.asin) || { asin: p.asin, placements: 0, rows: new Set(), accounts: new Set(), heavy: 0 };
    x.placements++; x.rows.add(p.row.id); x.accounts.add(p.row.account); x.heavy += Number(p.placement === 'heavy');
    byAsin.set(p.asin, x);
  }
  const concentration = [...byAsin.values()].map((x) => ({ asin: x.asin, placements: x.placements,
    share: allPlacements.length ? +(x.placements / allPlacements.length).toFixed(4) : 0,
    rows: [...x.rows].sort(), accounts: [...x.accounts].sort(), heavy: x.heavy }))
    .sort((a, b) => b.placements - a.placements || a.asin.localeCompare(b.asin));
  const conflicts = [];
  for (const q of resolvedQueue.filter((q) => q.riding)) {
    const actual = allPlacements.filter((p) => p.asin === q.asin);
    if (actual.length < q.covers) conflicts.push(`queue ${q.asin}: ${actual.length}/${q.covers} requested placements; donor/substance supply may be short`);
    if (q.oneRunOnly && actual.length > q.covers) conflicts.push(`queue ${q.asin}: ${actual.length} placements exceed one-run cap ${q.covers}`);
    if (q.oneRunOnly && actual.filter((p) => p.placement === 'heavy').length > q.heavyCovers) {
      conflicts.push(`queue ${q.asin}: heavy placements exceed one-run cap ${q.heavyCovers}`);
    }
  }
  for (const x of concentration) {
    const matches = allPlacements.filter((p) => p.asin === x.asin);
    for (const account of x.accounts) {
      const dated = matches.filter((p) => p.row.account === account).sort((a, b) => a.row.date.localeCompare(b.row.date));
      for (let i = 0; i < dated.length; i++) {
        const windowCount = dated.filter((p) => dateDays(p.row.date, dated[i].row.date) <= 6).length;
        const cap = plugCapFor(x.asin);
        if (windowCount > cap) { conflicts.push(`${account} ${x.asin}: ${windowCount} proposed placements in seven days exceed cap ${cap} (prior published use not included)`); break; }
      }
    }
  }
  return { schema: 'product-review-plan-v1', expectedRows, authority: 'canonical preflight cover selector + operator queue; pot/harvest contracts unchanged',
    controls: { held: 'Do not approve or advance a held row. Resolve the source/product/contract issue and resubmit that row.',
      reviewNeeded: 'Supply distinct CTA needs; explicitly review missing, unjudged or stale economics. Resubmit only when review content changes.',
      execution: 'This planner is read-only; run-studio records review and does not intercept publisher commands.' },
    evidence: { catalogRefreshed, catalogAgeDays, boardThrough: board?.generated?.through || null,
      boardAgeDays, freshnessReviewAfterDays,
      boardWindow: board?.generated?.through ? `lifetime through ${board.generated.through}` : 'missing',
      queueEntries: queue.length, existingSevenDayUse: 'not checked; refresh against ledger before schedule' },
    selectionReport: selection?.report || null, queue: resolvedQueue,
    rows: proposals, concentration, conflicts,
    summary: { rows: proposals.length, held: proposals.filter((r) => r.status === 'held').length,
      reviewNeeded: proposals.filter((r) => r.status === 'review_needed').length,
      proposed: proposals.filter((r) => r.status === 'proposed').length,
      reviewNeededInformationalOnly: proposals.filter((r) => r.status === 'review_needed' && !r.triage.blocking.length).length,
      placementCount: allPlacements.length },
  };
}

export function productReviewPackets(plan, chunkSize = 8) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 20) throw new Error('chunkSize must be 1–20 for run-studio submit-batch');
  const packets = [];
  const eligible = plan.rows.filter(row => row.status !== 'held');
  for (let i = 0; i < eligible.length; i += chunkSize) {
    const group = eligible.slice(i, i + chunkSize);
    const batchId = `products-${createHash('sha256').update(JSON.stringify(group.map(row => row.id))).digest('hex').slice(0, 12)}`;
    packets.push({ batchId, expectedRows: plan.expectedRows ?? plan.rows.length, rows: group.map((r) => ({ id: r.id, content: [
      `# Products · ${r.id}`, '', `- Account/date/lane: ${r.account} · ${r.date} · ${r.lane}`, ...(r.slotLine ? [r.slotLine] : []),
      `- Status: ${r.status}`, `- Source: ${r.sourceId || 'contract/none'}`,
      `- Selector authority: ${plan.authority}`, `- Contract unchanged by planner: ${r.contractUnchangedByPlanner}`,
      `- Contract source for independent verification: ${r.contractSource || 'not supplied'}`,
      `- Catalog refreshed: ${plan.evidence.catalogRefreshed || 'missing'}`,
      `- EPC window: ${plan.evidence.boardWindow}`, '',
      ...r.placements.flatMap((p) => [`## ${p.placement}: ${p.title || '(missing title)'} (${p.asin || 'missing ASIN'})`,
        `- Need: ${p.need || 'missing; writer/owner must specify the distinct reason this fits'}`,
        `- Catalog rate: ${p.rate.catalog ?? 'missing'} · private rate: ${p.rate.private ? `${p.rate.private.commission} (${p.rate.private.source}, verified ${p.rate.private.verifiedAt})` : 'none supplied'}`,
        `- Our EPC: ${p.epc.value ?? 'missing'} · ${p.epc.clicks ?? 'missing'} clicks · ${p.epc.orders ?? 'missing'} orders · ${p.epc.status} · ${p.epc.window || 'window missing'}`,
        `- Bridge: ${p.needsBridge ? 'must be written explicitly' : 'source/contract supplies it'}`,
        `- Flags: ${p.flags.join('; ') || 'none'}`, '']),
      ...productFitLines(r.jev),
      ...productDecisionLines(r.jevDecisions, r.placements),
      ...(r.resolutions?.length ? ['## Resolved automatically (owner 2026-09-28: "Keep donor, sell anyway"; "auto-resolve all")', ...r.resolutions.map((x) => `- ${x}`), ''] : []),
      `- Row reasons: ${r.reasons.join('; ') || 'none'}`,
      ...((t) => [`- Triage (status unchanged): ${t.blocking.length} blocking · ${t.informational.length} informational`,
        `  - Blocking: ${t.blocking.join('; ') || 'none'}`,
        `  - Informational (read past): ${t.informational.join('; ') || 'none'}`])(triageRow(r)),
      r.status === 'held'
        ? '- Owner decision: HOLD. Resolve the source/product/contract issue and resubmit this row; do not approve or advance it.'
        : r.status === 'review_needed'
          ? '- Owner decision: supply distinct CTA needs; explicitly review missing, unjudged or stale economics. Resubmit if this row changes, or hold it.'
          : '- Owner decision: approve these exact placements and distinct needs, revise, or hold this row.',
      `<!-- PI_RUN_PRODUCTS_V1 ${JSON.stringify({ productAsins: r.placements.map(p => p.asin), sourceId: r.sourceId || '', account: r.account, date: r.date, lane: r.lane, contractVersion: r.contractVersion, harvestOf: r.harvestOf })} -->`, ''
    ].join('\n') })) });
  }
  return packets;
}
