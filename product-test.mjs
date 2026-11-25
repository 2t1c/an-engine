#!/usr/bin/env node
// product-test.mjs — three hearts per unjudged product, a kill floor, and a verdict at the bar.
//
// The board has 310 products and 276 of them sit under the 100-click judging bar (2026-09-02), 248
// at zero clicks. The bar is right — under it an EPC is noise — but nothing sends traffic to a new
// product any more: the explore rhythm lived in the retired engine lanes, and the cover flow picks
// products by the donor's substances, so the same proven ASINs recur forever. This is the deliberate
// test slot that replaces the lottery (operator 2026-09-02, laws.json product.$test):
//
//   heart   = the product rides as the LIGHT plug on testCoversPerHeart covers in one run
//             (preflight.mjs commitSlateProducts `testProduct`), ~winnerMinClicks clicks in a week.
//             The heavy plug stays judged, so the thread's money is never bet on the unknown.
//   floor   = testKillMinClicks clicks at EPC < testKillEpcMultiple x fleet -> Killed, at any heart.
//   bar     = at winnerMinClicks clicks: < loserEpcMultiple x fleet -> Retired,
//             >= winnerEpcMultiple x fleet -> Promoted, between -> another heart,
//             testHearts spent without a promotion -> Parked (usable where it fits, not pushed).
//
// State lives in two places on purpose: the Products table (Test Status / Hearts / Batch / Note /
// Judged At — the operator's view) and keep-asins.json's `experiment` list (the picker's view: an
// experiment product passes the allowlist gate and shows as 🧪, and a promotion moves it to `allow`,
// a kill to `deny`). Figures come from learnings/product-board.json, the same lifetime per-ASIN
// numbers every other product rule reads.
//
//   node product-test.mjs                      # judge every Testing product (writes verdicts)
//   node product-test.mjs --queue              # the operator's standing queue, in run order
//   node product-test.mjs --candidates [n]     # the queue, then NEW products ranked by network EPC
//   node product-test.mjs --spend B0XXXXXXXX --batch R2026-09-04   # a heart goes out
//   node product-test.mjs --judge --dry        # verdicts to console, nothing written
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR, opsLog, telegram, report, esc, logRun } from './lib.mjs';
import { LAWS } from './laws.mjs';
import { productPerf, fleetEpc } from './pick-product.mjs';
import { topicsOfCatalog, swapVerdict, payoutPerSale } from './product-swap.mjs';
import { KEEP_ASINS, ALLOW_ASINS, DENY_ASINS, EXPERIMENT_ASINS, PHYSICAL_ASINS } from './checks.mjs';
import { readProductQueue, resolveQueue } from './product-queue.mjs';
import { selectPod } from './outline.mjs';

const P = LAWS.product;
const args = process.argv.slice(2);
const flag = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const DRY = args.includes('--dry');
export const TEST_FIELDS = ['ASIN', 'Name', 'Tier', 'Lifetime Clicks', 'EPC', 'Test Status', 'Test Hearts', 'Test Batch', 'Test Note', 'Test Judged At'];

/** Pure. One product's verdict from its lifetime figures and the hearts already spent. */
export function productTestVerdict({ clicks = 0, epc = null, hearts = 0 } = {}, { fleetEpc: fe, laws: base = P, physical = false } = {}) {
  // Physical products are judged on their own bar and floor (laws.product.$winnerMinClicksPhysical).
  const laws = physical ? { ...base, winnerMinClicks: base.winnerMinClicksPhysical ?? base.winnerMinClicks,
    testKillMinClicks: base.testKillMinClicksPhysical ?? base.testKillMinClicks } : base;
  const c = Number(clicks) || 0;
  const e = epc == null || epc === '' ? null : Number(epc);
  const h = Number(hearts) || 0;
  if (!(fe > 0)) return { verdict: 'continue', why: 'no fleet EPC on the board yet — nothing to judge against' };
  const x = (m) => `$${(m * fe).toFixed(3)}`;
  if (c >= laws.testKillMinClicks && e != null && e < laws.testKillEpcMultiple * fe) {
    return { verdict: 'kill', why: `${c} clicks at $${e.toFixed(3)}/click — under ${laws.testKillEpcMultiple}x fleet (${x(laws.testKillEpcMultiple)}); the floor, no more hearts` };
  }
  if (c < laws.winnerMinClicks) {
    return h >= laws.testHearts
      ? { verdict: 'park', why: `${laws.testHearts} hearts spent and only ${c}/${laws.winnerMinClicks} clicks — the light plug never drew enough to judge` }
      : { verdict: 'continue', why: `${c}/${laws.winnerMinClicks} clicks — under the bar, not judged` };
  }
  if (e == null) return { verdict: 'continue', why: `${c} clicks but no EPC on the board — wait for the next board build` };
  const ratio = e / fe;
  if (e >= laws.winnerEpcMultiple * fe) return { verdict: 'promote', why: `$${e.toFixed(3)}/click over ${c} clicks — ${ratio.toFixed(2)}x fleet, at or above the ${laws.winnerEpcMultiple}x winner line` };
  if (e < laws.loserEpcMultiple * fe) return { verdict: 'retire', why: `$${e.toFixed(3)}/click over ${c} clicks — ${ratio.toFixed(2)}x fleet, under the ${laws.loserEpcMultiple}x loser line` };
  return h >= laws.testHearts
    ? { verdict: 'park', why: `${ratio.toFixed(2)}x fleet over ${c} clicks after ${laws.testHearts} hearts — a middling earner: usable where it fits, not pushed` }
    : { verdict: 'continue', why: `${ratio.toFixed(2)}x fleet over ${c} clicks — between the lines, spend another heart` };
}
export const STATUS_OF = { kill: 'Killed', retire: 'Retired', promote: 'Promoted', park: 'Parked', continue: 'Testing' };

/** Pure. Candidates ranked by EPC FIRST (owner 2026-11-04: "Retire the 8$ floor ... Go for EPC as
 *  primary choosing option"): Levanta's network EPC already folds in conversion, so a $17 bottle that
 *  converts at 25% outranks a $90 one nobody buys. The old order (headroom = a FLAT 1.2% peer CVR over
 *  the breakeven) was payout per sale in disguise, which put every cheap high-converter last
 *  (Sports Research D3+K2: network EPC $5.25, ~$4.24 a sale, never queued). Headroom and payout stay
 *  on the row as tiebreaks and context. Products with no EPC on file sort after every product that has one. `board` rows are {asin, clicks, epc}; `status` maps ASIN ->
 *  Test Status. A product already judged (any status but Untested/Testing) never comes back. */
export function rankCandidates(products, perf, { status = new Map(), minClicks = P.winnerMinClicks } = {}) {
  const topics = topicsOfCatalog(products);
  const topicOf = new Map();
  for (const [key, t] of Object.entries(topics)) for (const m of t.members) topicOf.set(m.asin, { key, t });
  const out = [];
  for (const p of products) {
    if (!p.price || !p.commission) continue;
    if (KEEP_ASINS.has(p.asin) || ALLOW_ASINS.has(p.asin) || DENY_ASINS.has(p.asin)) continue;
    const st = status.get(p.asin) || 'Untested';
    if (!['Untested', 'Testing'].includes(st)) continue;
    const clicks = perf[p.asin]?.clicks || 0;
    if (clicks >= minClicks) continue; // judged by the board already — not a test candidate
    const tp = topicOf.get(p.asin);
    let incumbent = null;
    if (tp) {
      const ranked = tp.t.members.filter((m) => m.asin !== p.asin && (perf[m.asin]?.clicks || 0) >= minClicks)
        .sort((a, b) => (perf[b.asin]?.clicks || 0) - (perf[a.asin]?.clicks || 0));
      incumbent = ranked[0] || null;
    }
    const v = incumbent ? swapVerdict(incumbent, p, perf, { minClicks }) : null;
    out.push({
      asin: p.asin, title: String(p.title || ''), topic: tp?.key || null, payout: payoutPerSale(p), epc: networkEpc(p),
      breakeven: v?.breakeven ?? null, upside: v?.upside ?? null, clicks, status: st,
      incumbent: incumbent ? { asin: incumbent.asin, epc: perf[incumbent.asin]?.epc ?? null } : null,
    });
  }
  return out.sort((a, b) => (b.epc ?? -1) - (a.epc ?? -1) || (b.upside ?? -1) - (a.upside ?? -1) || (b.payout || 0) - (a.payout || 0));
}
/** Pure. Levanta's network EPC from products.json (a string there), or null when none is on file. */
export const networkEpc = (p) => { const e = parseFloat(p?.epc); return Number.isFinite(e) && e > 0 ? e : null; };

// ---- keep-asins.json: the picker's view of the test ------------------------------------------
const POLICY = join(HERE_DIR, 'keep-asins.json');
export function movePolicy(policy, asin, { to, note, topic = null }) {
  const p = JSON.parse(JSON.stringify(policy));
  // physical:true decides which EPC floor judges the product (laws.product.minEpcFloorPhysical), so
  // it must survive the move — a promoted heating pad is still a heating pad.
  const physical = ['experiment', 'allow', 'deny', 'keep'].some((l) => (p[l] || []).some((e) => e.asin === asin && e.physical));
  for (const list of ['experiment', 'allow', 'deny']) p[list] = (p[list] || []).filter((e) => e.asin !== asin);
  if (to) (p[to] = p[to] || []).push({ asin, ...(topic ? { topic } : {}), note, ...(physical ? { physical: true } : {}) });
  return p;
}
function readPolicy() { const raw = readFileSync(POLICY, 'utf8'); return { policy: JSON.parse(raw), indent: (raw.match(/\n( +)"/) || [, '  '])[1] }; }
function writePolicy(policy, indent) { writeFileSync(POLICY, JSON.stringify(policy, null, indent) + '\n'); }

// ---- the run ----------------------------------------------------------------------------------
async function main() {
  const env = loadEnv();
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const perf = productPerf();
  const fe = fleetEpc(perf);
  const at = env.AIRTABLE_PAT && env.REGISTRY_BASE_ID ? airtable(env, env.REGISTRY_BASE_ID) : null;
  const rowsByAsin = new Map();
  if (at) for (const r of await at.listAll('Products', { fields: TEST_FIELDS })) if (r.fields.ASIN) rowsByAsin.set(String(r.fields.ASIN).toUpperCase(), r);
  const statusOf = new Map([...rowsByAsin].map(([a, r]) => [a, r.fields['Test Status'] || 'Untested']));

  // --queue / --candidates: both open with the operator's queue, because it is the half of the answer
  // the ranking below CANNOT contain — rankCandidates skips every keep/allow/deny ASIN by design, so a
  // product we already stock and simply never pick shows up in no ranking anywhere.
  const printQueue = () => {
    const resolved = resolveQueue(readProductQueue().queue, { products, status: statusOf, hasPod: (p) => !!selectPod(p, {})?.pod });
    if (!resolved.length) { console.log('PRODUCT QUEUE — empty (queues/product-queue.json)\n'); return resolved; }
    console.log(`PRODUCT QUEUE — queues/product-queue.json · top ${P.testProductsPerRun} ride each run · heavy cap ${P.testHeavyCovers} cover(s)\n`);
    console.log('    asin        slot    $/sale  breakeven  clicks  status    title');
    for (const q of resolved) {
      const cat = products.find((x) => x.asin === q.asin);
      const pay = cat ? payoutPerSale(cat) : 0;
      const clicks = perf[q.asin]?.clicks || 0;
      const mark = q.riding ? (q.slot === 'heavy' ? ' 💰 ' : ' 🧪 ') : ' ⏭ ';
      console.log(`${mark} ${q.asin}  ${(q.riding ? q.slot : '-').padEnd(6)} ${('$' + pay.toFixed(2)).padStart(7)}  ${pay > 0 ? ((fe / pay) * 100).toFixed(2) + '%' : '   -  '}    ${String(clicks).padStart(5)}   ${q.status.padEnd(8)}  ${q.title.slice(0, 44)}`);
      if (q.reason) console.log(`      ↳ ${q.reason}`);
    }
    console.log('');
    return resolved;
  };
  if (args.includes('--queue')) { printQueue(); return; }

  // --candidates: what to test next
  if (flag('candidates') != null) {
    const n = Number(flag('candidates')) || 12;
    printQueue();
    const ranked = rankCandidates(products, perf, { status: statusOf });
    console.log(`NEW-PRODUCT CANDIDATES — fleet EPC $${fe.toFixed(3)} · bar ${P.winnerMinClicks} clicks · ${P.testHearts} hearts · floor ${P.testKillMinClicks} clicks under ${P.testKillEpcMultiple}x`);
    console.log('(never includes a stocked product: keep/allow/deny ASINs are skipped here on purpose — queue those above instead)\n');
    console.log('asin        topic            net EPC   $/sale   breakeven  headroom  clicks  hearts  status    title');
    for (const c of ranked.slice(0, n)) {
      const r = rowsByAsin.get(c.asin);
      console.log(`${c.asin}  ${String(c.topic || '-').padEnd(16)} ${(c.epc != null ? '$' + c.epc.toFixed(2) : '-').padStart(7)}  ${('$' + c.payout.toFixed(2)).padStart(7)}  ${c.breakeven != null ? (c.breakeven * 100).toFixed(2) + '%' : '   -  '}     ${c.upside != null ? c.upside.toFixed(1) + 'x' : '  - '}    ${String(c.clicks).padStart(4)}   ${String(r?.fields['Test Hearts'] || 0).padStart(3)}    ${c.status.padEnd(8)}  ${c.title.slice(0, 48)}`);
    }
    console.log(`\n${ranked.length} untested candidate(s). Ranked by network EPC; headroom (a peer's 1.2% CVR over the breakeven) and payout only break ties. Price is a ceiling, never a floor.`);
    console.log(`Spend a heart: node product-test.mjs --spend <ASIN> --batch R<run date>`);
    console.log(`The run reads the queue on its own — preflight needs --test-product only to OVERRIDE it.`);
    return;
  }

  // --spend: a heart goes out
  const spend = flag('spend');
  if (spend && spend !== true) {
    requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
    const asin = String(spend).toUpperCase();
    const batch = flag('batch') && flag('batch') !== true ? String(flag('batch')) : `R${new Date().toISOString().slice(0, 10)}`;
    const cat = products.find((p) => p.asin === asin);
    if (!cat) throw new Error(`${asin} is not in products.json — a test needs a catalogue entry (price, commission, title)`);
    if (DENY_ASINS.has(asin)) throw new Error(`${asin} is on the deny list — not testable`);
    const row = rowsByAsin.get(asin);
    if (!row) throw new Error(`${asin} has no Products row — run products-sync first`);
    const hearts = Number(row.fields['Test Hearts'] || 0);
    const st = row.fields['Test Status'] || 'Untested';
    if (!['Untested', 'Testing'].includes(st)) throw new Error(`${asin} is ${st} — no hearts left to spend`);
    if (hearts >= P.testHearts) throw new Error(`${asin} already spent ${hearts}/${P.testHearts} hearts — judge it (node product-test.mjs) before spending more`);
    const note = `heart ${hearts + 1}/${P.testHearts} · ${batch} · ${new Date().toISOString().slice(0, 10)}`;
    console.log(`🧪 ${asin} ${cat.title.slice(0, 50)} — ${note}${DRY ? ' (dry)' : ''}`);
    if (DRY) return;
    await at.update('Products', [{ id: row.id, fields: { 'Test Status': 'Testing', 'Test Hearts': hearts + 1, 'Test Batch': batch, 'Test Note': `${row.fields['Test Note'] ? row.fields['Test Note'] + '\n' : ''}${note}` } }]);
    const { policy, indent } = readPolicy();
    const topic = rankCandidates([cat], perf)[0]?.topic || null;
    // A product already on allow or keep stays there: moving it back to experiment would take a
    // BRIDGE target off the allow menu (checks.mjs requires every target there) for no gain, since
    // allow and keep products are already pickable.
    const listed = ['allow', 'keep'].some((l) => (policy[l] || []).some((e) => e.asin === asin));
    if (!listed) writePolicy(movePolicy(policy, asin, { to: 'experiment', topic, note: `product test ${note} — ${cat.title.slice(0, 60)}` }), indent);
    await opsLog(env, { source: 'product-test', level: 'action', event: `heart ${hearts + 1}/${P.testHearts} spent on ${asin}`, detail: { asin, batch, title: cat.title } });
    console.log(`  ✓ Products row updated · ${listed ? 'keep-asins.json unchanged (already on allow/keep)' : `keep-asins.json experiment += ${asin} (commit it with the run)`}`);
    return;
  }

  // default / --judge: every Testing product against the floor and the bar
  const testing = [...rowsByAsin.values()].filter((r) => r.fields['Test Status'] === 'Testing');
  const stats = { testing: testing.length, promoted: 0, retired: 0, killed: 0, parked: 0, continuing: 0 };
  const lines = [];
  const updates = [];
  let { policy, indent } = at ? readPolicy() : { policy: null, indent: '  ' };
  for (const r of testing) {
    const asin = String(r.fields.ASIN).toUpperCase();
    const pf = perf[asin] || {};
    const hearts = Number(r.fields['Test Hearts'] || 0);
    const v = productTestVerdict({ clicks: pf.clicks || 0, epc: pf.epc ?? null, hearts }, { fleetEpc: fe, physical: PHYSICAL_ASINS.has(asin) });
    const status = STATUS_OF[v.verdict];
    const label = `${asin} ${String(r.fields.Name || '').slice(0, 40)} · hearts ${hearts}/${P.testHearts}`;
    if (v.verdict === 'continue') { stats.continuing++; console.log(`  · ${label} — ${v.why}`); continue; }
    stats[{ kill: 'killed', retire: 'retired', promote: 'promoted', park: 'parked' }[v.verdict]]++;
    const icon = { kill: '💀', retire: '⬇', promote: '⬆', park: '⏸' }[v.verdict];
    console.log(`  ${icon} ${label} → ${status}: ${v.why}`);
    lines.push(`${icon} <b>${esc(status)}</b> · ${esc(asin)} ${esc(String(r.fields.Name || '').slice(0, 40))}\n   ${esc(v.why)}`);
    updates.push({ id: r.id, fields: { 'Test Status': status, 'Test Judged At': new Date().toISOString(), 'Test Note': `${r.fields['Test Note'] ? r.fields['Test Note'] + '\n' : ''}${status}: ${v.why}` } });
    if (policy) {
      const cat = products.find((p) => p.asin === asin);
      const topic = cat ? (rankCandidates([cat], perf)[0]?.topic || null) : null;
      policy = v.verdict === 'promote' ? movePolicy(policy, asin, { to: 'allow', topic, note: `PROMOTED by product-test ${new Date().toISOString().slice(0, 10)}: ${v.why}` })
        : v.verdict === 'kill' ? movePolicy(policy, asin, { to: 'deny', note: `KILLED by product-test ${new Date().toISOString().slice(0, 10)}: ${v.why}` })
        : movePolicy(policy, asin, { to: null, note: '' });
    }
  }
  console.log(`product-test: ${stats.testing} testing · ${stats.promoted} promoted · ${stats.retired} retired · ${stats.killed} killed · ${stats.parked} parked · ${stats.continuing} continuing${DRY ? ' (dry)' : ''}`);
  if (DRY || !at) return;
  if (updates.length) {
    await at.update('Products', updates);
    writePolicy(policy, indent);
    for (const u of updates) await opsLog(env, { source: 'product-test', level: 'action', event: `product test verdict: ${u.fields['Test Status']}`, detail: { record: u.id, note: u.fields['Test Note'].split('\n').pop() } });
    const out = report({ emoji: '🧪', title: 'Product test', scope: `${stats.testing} product(s) under test`, status: `${stats.promoted} promoted · ${stats.retired} retired · ${stats.killed} killed · ${stats.parked} parked`, sections: [{ label: 'VERDICTS', body: lines.join('\n\n') }], action: stats.promoted ? 'Promoted products now sit on the allow list — pods and BRIDGE may want an entry.' : 'Nothing to do; the next heart goes out with the next /run.' });
    await telegram(env, out);
  }
  logRun('product-test', stats);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'product-test');
