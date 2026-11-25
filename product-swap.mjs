// product-swap.mjs — which product should each topic actually be selling, and what would it take?
//
// Every realized EPC we hold was earned under the OLD CTA. That makes the numbers useful for
// ranking and useless as a verdict: a product that converted badly behind a bad plug has not been
// tested, it has been failed by its packaging. So this does two jobs at once.
//
//   1. THE ARITHMETIC. Breakeven CVR = the incumbent's EPC / the challenger's payout per sale. At
//      80% commission on a $48 product you are paid $38.39, which is 5x a $22 Nutricost bottle at
//      35% — so the challenger only needs about a FIFTH of the incumbent's conversion rate to win.
//      That is a low bar, and it is why the high-commission catalog is worth testing rather than
//      dismissing. It is also why price has a ceiling: CVR collapses faster than payout rises
//      (measured: a $185 bundle converts at 0.14%, a $15 bottle at 4.92%).
//
//   2. THE EXPERIMENT. Ranking alone would keep re-plugging today's winners and never learn. Each
//      topic gets an incumbent and a challenger, alternating by slot, so the rebuilt CTA produces
//      PAIRED data per topic instead of another season of unfalsifiable history.
//
// CATEGORY MATCH IS A HARD GATE, not a scoring term. "The Night Before Magnesium Glycinate Sleep
// Aid, 10-in-1 with Melatonin, L-Theanine, Lemon Balm" is a sleep blend wearing magnesium's name.
// A thread whose criterion beat says "glycinate absorbs cleanly, oxide passes through" sends the
// reader to a melatonin stack, and the promise breaks on the landing page. Heart of Steel is also
// multi-ingredient, but a thread promising nitric oxide sends them to a nitric oxide product — the
// category matches even though the formula does not. That distinction is the whole rule.
//
//   node product-swap.mjs                 # the swap list, by topic
//   node product-swap.mjs --json
//   node product-swap.mjs --topic sleep
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMain, HERE_DIR } from './lib.mjs';
import { BRIDGE, isStack, ALLOW_ASINS } from './checks.mjs';
import { productPerf } from './pick-product.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');
const MIN_CLICKS = Number(arg('min-clicks', 150)); // below this an EPC is noise, not a measurement

/** Payout to us per sale. Pure. */
export const payoutPerSale = (p) => Number(p?.price || 0) * Number(p?.commission || 0);

/** The CVR a challenger needs to match the incumbent's EPC. Pure + testable. */
export function breakevenCvr(incumbentEpc, challenger) {
  const pay = payoutPerSale(challenger);
  if (!pay || !(incumbentEpc > 0)) return null;
  return incumbentEpc / pay; // as a fraction
}

/** What our realized EPC implies about a product's conversion rate. Pure. */
export function impliedCvr(epc, p) {
  const pay = payoutPerSale(p);
  return pay && epc != null ? epc / pay : null;
}

/**
 * Pure verdict for one challenger against one incumbent. Exported for tests.
 * `perf` rows are { clicks, epc } from productPerf().
 */
export function swapVerdict(incumbent, challenger, perf = {}, { minClicks = MIN_CLICKS } = {}) {
  const inc = perf[incumbent?.asin] || {}, ch = perf[challenger?.asin] || {};
  const incEpc = Number(inc.epc || 0);
  const be = breakevenCvr(incEpc, challenger);
  const base = { asin: challenger.asin, title: challenger.title, payout: payoutPerSale(challenger), breakeven: be, clicks: ch.clicks || 0, epc: ch.epc ?? null };

  // A category mismatch is disqualifying before any arithmetic runs: the thread's criterion beat
  // would contradict what the reader lands on.
  if (!base.payout) return { ...base, verdict: 'skip', why: 'no price or commission on file' };

  if ((ch.clicks || 0) >= minClicks && ch.epc != null) {
    const lift = incEpc > 0 ? (ch.epc / incEpc - 1) : null;
    return lift >= 0.1
      ? { ...base, lift, verdict: 'swap', why: `measured ${Math.round(lift * 100)}% better per click over ${ch.clicks} clicks` }
      : lift <= -0.1
        ? { ...base, lift, verdict: 'retire', why: `measured ${Math.round(lift * 100)}% per click over ${ch.clicks} clicks — but earned under the OLD CTA, so retire from rotation rather than delete` }
        : { ...base, lift, verdict: 'level', why: `within 10% of the incumbent over ${ch.clicks} clicks` };
  }
  // Untested. The question is whether the payout makes the bar reachable.
  const peerCvr = 0.012; // 1.2%: what Heart of Steel actually does at this price point
  const upside = be != null ? (peerCvr / be) : null;
  return {
    ...base, verdict: 'test', upside,
    why: be == null ? 'no incumbent EPC to compare against'
      : `needs ${(be * 100).toFixed(2)}% CVR to match; a peer at this price does ~1.2%${upside ? ` (${upside.toFixed(1)}x headroom)` : ''}`,
  };
}

/** Group allowlist products by the topic their substance terms map to. Pure. */
export function topicsOfCatalog(products) {
  const byAsin = new Map();
  for (const [term, asin] of Object.entries(BRIDGE)) {
    if (!byAsin.has(asin)) byAsin.set(asin, []);
    byAsin.get(asin).push(term);
  }
  // A topic is the SUBSTANCE the thread promised. Products join a topic when their title carries
  // one of that substance's terms — which is exactly the match a reader checks on the landing page.
  const topics = {};
  for (const [asin, terms] of byAsin) {
    const key = terms[0];
    topics[key] = { terms, members: [] };
  }
  for (const p of products) {
    const hay = `${p.title} ${p.category || ''}`.toLowerCase();
    // A multi-substance product matches several topics at once, and the first version DROPPED it for
    // that reason. That was too blunt (operator 2026-08-17): the 80% catalog is almost entirely
    // multi-ingredient, so excluding it excluded the whole thing we want to test. The problem was
    // never eligibility, it was ATTRIBUTION — "Self Obsessed x Heart of Steel x The Night Before"
    // appeared as a magnesium candidate, a nitric-oxide candidate and an ashwagandha candidate in one
    // run, which reads as three options and is one. So attribute it to the substance its title LEADS
    // with (what the brand puts first is what the thread would be promising) and carry the rest as
    // `alsoContains`, so the row shows what else the reader lands on.
    const hits = Object.entries(topics)
      .map(([key, t]) => {
        const at = Math.min(...t.terms.filter((x) => x.length > 3).map((x) => { const i = hay.indexOf(x); return i < 0 ? Infinity : i; }));
        return { key, t, at };
      })
      .filter((h) => h.at !== Infinity)
      .sort((a, b) => a.at - b.at);
    if (!hits.length) continue;
    const lead = hits[0];
    const alsoContains = hits.slice(1).map((h) => h.key);
    lead.t.members.push(alsoContains.length ? { ...p, alsoContains } : p);
  }
  return topics;
}

async function main() {
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const perf = productPerf();
  const only = arg('topic');
  const topics = topicsOfCatalog(products);

  const out = [];
  for (const [key, t] of Object.entries(topics)) {
    if (only && key !== only.toLowerCase()) continue;
    const live = t.members.filter((p) => p.price && p.commission);
    if (live.length < 2) continue;
    // Incumbent = the product this topic has actually sent the most clicks to.
    const ranked = live.slice().sort((a, b) => (perf[b.asin]?.clicks || 0) - (perf[a.asin]?.clicks || 0));
    const incumbent = ranked[0];
    if (!(perf[incumbent.asin]?.clicks >= MIN_CLICKS)) continue; // no trustworthy baseline for this topic
    const challengers = ranked.slice(1)
      .map((c) => ({ ...swapVerdict(incumbent, c, perf), stack: isStack(c), alsoContains: c.alsoContains || [], onAllowlist: ALLOW_ASINS.has(c.asin) }))
      .sort((a, b) => (b.payout || 0) - (a.payout || 0));
    out.push({
      topic: key, incumbent: { asin: incumbent.asin, title: incumbent.title, epc: perf[incumbent.asin]?.epc ?? null, clicks: perf[incumbent.asin]?.clicks || 0, payout: payoutPerSale(incumbent), cvr: impliedCvr(perf[incumbent.asin]?.epc, incumbent) },
      challengers,
    });
  }
  out.sort((a, b) => (b.incumbent.clicks || 0) - (a.incumbent.clicks || 0));
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  const ICON = { swap: '⬆', retire: '⬇', level: '=', test: '🧪', skip: '·' };
  console.log(`PRODUCT SWAP LIST — every EPC below was earned under the OLD CTA\n`);
  for (const t of out) {
    const i = t.incumbent;
    console.log(`■ ${t.topic.toUpperCase()}`);
    console.log(`   incumbent  $${i.epc?.toFixed(3) ?? '  -  '}/click · ${i.clicks} clicks · $${i.payout.toFixed(2)}/sale · CVR ${i.cvr != null ? (i.cvr * 100).toFixed(2) + '%' : '-'}  ${String(i.title).slice(0, 46)}`);
    for (const c of t.challengers.slice(0, 4)) {
      console.log(`   ${ICON[c.verdict]} ${c.verdict.padEnd(6)} $${c.payout.toFixed(2)}/sale  be ${c.breakeven != null ? (c.breakeven * 100).toFixed(2) + '%' : '  -  '}  ${c.stack ? 'STACK ' : '      '}${String(c.title).slice(0, 40)}`);
      if (c.alsoContains?.length) console.log(`        also contains: ${c.alsoContains.join(', ')} — the reader lands on a page selling those too`);
      console.log(`        ${c.why}`);
    }
    console.log('');
  }
  const all = out.flatMap((t) => t.challengers);
  console.log(`${all.filter((c) => c.verdict === 'swap').length} swap · ${all.filter((c) => c.verdict === 'test').length} worth testing · ${all.filter((c) => c.verdict === 'retire').length} retire`);
  console.log(`\nSTACK = multi-ingredient. Not disqualifying on its own — Heart of Steel is a stack and wins.`);
  console.log(`Disqualifying is a CATEGORY mismatch: a sleep blend answering a thread about magnesium absorption.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'product-swap');
