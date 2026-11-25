// product-queue.mjs — the operator's standing product queue: what the next run must push, in order.
//
// The test slot used to take exactly one ASIN, named by hand on the command line at plan time, and
// the only ranking that suggested one (product-test --candidates) skips every ASIN on keep/allow/deny
// by design — it hunts NEW products. So a product we already stock and simply never pick appeared in
// no list anywhere: four of the six Healthy Origins SKUs sat at zero clicks for months, including a
// $64-a-sale bottle, and the only way to surface one was for someone to remember it (2026-09-09).
//
// The queue is that memory, checked in. It is operator-owned data in queues/product-queue.json, read
// by product-test --candidates (printed ABOVE the computed ranking) and by preflight, which places
// its top entries on the slate without anyone typing an ASIN. Being stocked is not a reason to be
// skipped here — that was the whole blind spot.
//
// Each entry declares the slot it wants:
//   heavy — plug index 0, the thread's money. ~25% more clicks than light (measured 2026-09-09 over
//           1,020 slate links: 15 vs 12 median first-week clicks, 67.5 vs 53.9 mean). `heavyCovers`
//           says how many of the entry's covers take it, default 1, and laws.product.testHeavyCovers
//           caps the fleet-wide total — an unjudged heavy is real revenue at risk.
//   light — plug index 1, the original heart. Costs nothing but the slot.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';
import { LAWS } from './laws.mjs';
import { DENY_ASINS } from './checks.mjs';

export const QUEUE_PATH = join(HERE_DIR, 'queues', 'product-queue.json');
export const SLOTS = ['heavy', 'light'];

/** Read the queue file. A missing file is an empty queue — the run still works, it just has no
 *  operator priority. A malformed one throws: silently ignoring a typo'd queue is how a product
 *  the operator asked for goes another week without traffic. */
export function readProductQueue(path = QUEUE_PATH) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return { meta: {}, queue: [] }; }
  const parsed = JSON.parse(raw);
  const queue = parsed.queue || [];
  for (const [i, e] of queue.entries()) {
    if (!e || typeof e.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(e.asin)) throw new Error(`product-queue.json entry ${i}: "asin" must be a 10-character ASIN (got ${JSON.stringify(e?.asin)})`);
    if (e.slot != null && !SLOTS.includes(e.slot)) throw new Error(`product-queue.json ${e.asin}: "slot" must be ${SLOTS.join(' or ')} (got ${JSON.stringify(e.slot)})`);
    if (e.heavyCovers != null && !(Number.isInteger(e.heavyCovers) && e.heavyCovers >= 0)) throw new Error(`product-queue.json ${e.asin}: "heavyCovers" must be a non-negative integer (got ${JSON.stringify(e.heavyCovers)})`);
    if (e.oneRunOnly != null && typeof e.oneRunOnly !== 'boolean') throw new Error(`product-queue.json ${e.asin}: "oneRunOnly" must be a boolean (got ${JSON.stringify(e.oneRunOnly)})`);
    if (e.expiresAt != null && !Number.isFinite(Date.parse(e.expiresAt))) throw new Error(`product-queue.json ${e.asin}: "expiresAt" must be an ISO timestamp (got ${JSON.stringify(e.expiresAt)})`);
    if (e.forced != null && typeof e.forced !== 'boolean') throw new Error(`product-queue.json ${e.asin}: "forced" must be a boolean (got ${JSON.stringify(e.forced)})`);
    if (e.topics != null && !(Array.isArray(e.topics) && e.topics.every((t) => typeof t === 'string' && t))) throw new Error(`product-queue.json ${e.asin}: "topics" must be a list of topic names`);
    if (e.forced && !(Array.isArray(e.topics) && e.topics.length)) throw new Error(`product-queue.json ${e.asin}: a forced entry names the topics it may land on`);
    if (!e.why) throw new Error(`product-queue.json ${e.asin}: every entry needs a "why" — a queue without reasons is a list nobody can audit`);
  }
  return { meta: parsed.meta || {}, queue };
}

/** PURE. The queue as the run can actually use it: entries in order, each marked rideable or not and
 *  told which slot it gets. `products` is products.json's array, `status` maps ASIN -> Test Status.
 *
 *  One cap here: `testProductsPerRun` entries ride at all. The heavy cap is NOT applied here — it
 *  counts cover PLACEMENTS, not products, so commitSlateProducts is the only place that can spend it
 *  (it is the only code that knows how many rows a product actually lands on). An entry that asks for
 *  heavy after that cap runs out still rides, as light; it is never dropped. */
export function resolveQueue(queue, { products = [], status = new Map(), laws = LAWS.product, denied = DENY_ASINS, hasPod = () => true, now = Date.now() } = {}) {
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const perRun = Number(laws.testProductsPerRun ?? 1);
  const out = [];
  let riding = 0;
  for (const e of queue) {
    const cat = byAsin.get(e.asin);
    const st = status.get(e.asin) || 'Untested';
    const want = e.slot || 'light';
    const covers = Number(e.covers ?? laws.testCoversPerHeart ?? 3);
    const heavyCovers = want === 'heavy' ? Number(e.heavyCovers ?? 1) : 0;
    const row = { asin: e.asin, why: e.why, added: e.added || null, want, covers, heavyCovers, oneRunOnly: !!e.oneRunOnly, expiresAt: e.expiresAt || null,
      forced: !!e.forced, topics: e.topics || [], title: String(cat?.title || ''), status: st };
    // Order matters: the blocking reasons first, cheapest and most certain to check.
    if (denied.has(e.asin)) { out.push({ ...row, riding: false, slot: null, reason: 'on the deny list' }); continue; }
    if (e.expiresAt && Date.parse(e.expiresAt) <= now) { out.push({ ...row, riding: false, slot: null, reason: `expired at ${e.expiresAt} — remove the one-run override` }); continue; }
    if (!cat) { out.push({ ...row, riding: false, slot: null, reason: 'not in products.json — no price, no commission, nothing to mint' }); continue; }
    if (cat.unavailable) { out.push({ ...row, riding: false, slot: null, reason: 'flagged unavailable by the last product-health sync' }); continue; }
    // HOLD UNTIL THE RATE LANDS (2026-09-20). An entry may be queued on a commission we have been
    // PROMISED rather than one we are paid, and riding it early measures the bottle at a rate we
    // are about to stop paying — the same defect rate-moves.mjs exists to correct in reverse, where
    // the picker ranks a product on a rate it no longer earns. The condition is data, not a date:
    // product-health refreshes products.json commission on every weekly sync, so this clears itself
    // the week the rate moves and needs no second edit. Absent holdUntilRate, nothing changes.
    if (e.holdUntilRate != null && Number(cat.commission || 0) + 1e-9 < Number(e.holdUntilRate)) {
      out.push({ ...row, riding: false, slot: null,
        reason: `held until the rate reaches ${(Number(e.holdUntilRate) * 100).toFixed(0)}% — products.json still shows ${(Number(cat.commission || 0) * 100).toFixed(0)}%` });
      continue;
    }
    // A product no pod covers has no CTA that can legally be written for it, so commitSlateProducts
    // filters it out and the queue entry would sit there looking scheduled while nothing shipped.
    // Say it here, at plan time, where someone can write the pod.
    if (!hasPod(cat)) { out.push({ ...row, riding: false, slot: null, reason: 'no pod covers it — write one in pods.json first, or no CTA can be written and the picker will skip it' }); continue; }
    // A FORCED entry is the owner's exact allocation (2026-09-28, the multivitamin: "Force it on 6
    // covers"), so it rides outside the per-run test limit rather than bumping a standing test.
    if (!e.forced && riding >= perRun) { out.push({ ...row, riding: false, slot: null, reason: `past this run's ${perRun}-product limit — next run` }); continue; }
    if (!e.forced) riding++;
    out.push({ ...row, riding: true, slot: want, reason: null });
  }
  return out;
}

/** The shape preflight's commitSlateProducts wants: one entry per rideable product. */
export const testProductsFor = (resolved) => resolved.filter((r) => r.riding).map((r) => ({ asin: r.asin, slot: r.slot, max: r.covers, heavyCovers: r.heavyCovers, oneRunOnly: r.oneRunOnly,
  ...(r.forced ? { forced: true, topics: r.topics } : {}) }));
