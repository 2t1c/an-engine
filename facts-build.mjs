// facts-build.mjs — THE TRUTH TABLE: one row per post with everything on it (operator 2026-08-24:
// "build this first"). Every question this week — which product earns, which vendor yields, what a
// thread costs — took an hour of joining 3-5 stores by tweet-id/subid/ASIN. This emits facts.jsonl
// (git-tracked, next to ledger.jsonl) so those questions become one grep, with history for free.
//
// One row per Published Content post: identity + state, the money layer (ASINs, pods, moves, links),
// audience numbers (views/clicks/engagement), realized money (commission/orders), generation cost,
// and the fuel story (per-vendor fires parsed from Fuel Log's Tier Breakdown, plus the leave-one-out
// and holdout stamps once those ship). NOT a new Airtable table — Published Content already holds
// most of this; the file is the denormalized, greppable read model of it.
//
// Exceptions are the second output: a monetized posted thread with no ledger row (revenue that can
// never attribute) and fuel spend whose tweet matches no registry post (money with no story). Both
// print — silent orphans are how the joins rotted in the first place.
//
//   node facts-build.mjs           # pull, join, write facts.jsonl, print summary + exceptions
//   node facts-build.mjs --dry     # print only, write nothing
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, HERE_DIR, runMain } from './lib.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { TBL } from './config.mjs';

const FUEL_LOG = TBL.fuelLog;
const DRY = process.argv.includes('--dry');
const OUT = join(HERE_DIR, 'facts.jsonl');

export const tweetId = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || '';

// Mirrors the n8n ledger-line contract (Fuel the Fire "Build Log" / RT Bridge "Build T0 Fuel"):
//   "T1 · Pammy · $12.00 · 380000 reach · 2026-08-20T..."  (also "T1+T2" and the "T?" pre-ledger seed)
const LINE = /^(T\d+(?:\+T\d+)*|T\?)\s*·\s*(.*?)\s*·\s*\$([\d.]+)\s*·\s*(\d+)\s*reach\s*·\s*(.+)$/;
export function parseTierBreakdown(txt) {
  return String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const m = l.match(LINE); return m ? {
      tiers: m[1].split('+'), vendors: m[2] ? m[2].split(', ').filter(Boolean) : [],
      price: Number(m[3]) || 0, reach: Number(m[4]) || 0, at: m[5] } : null; })
    .filter(Boolean);
}

// draftId -> the ledger's merged view of the thread. Later rows win per key (repair passes re-stamp),
// but a key is never LOST to a later partial row — same merge rule the session tooling always used.
export function ledgerIndex(text) {
  const by = new Map();
  for (const line of String(text || '').split('\n')) {
    const t = line.trim(); if (!t) continue;
    let r; try { r = JSON.parse(t); } catch { continue; }
    if (r.draftId == null) continue;
    const cur = by.get(String(r.draftId)) || {};
    for (const k of ['asin', 'asin2', 'product', 'product2', 'subid1', 'subid1b', 'sourceUrl', 'ctaStyle', 'llmCost', 'niche', 'topic', 'mode', 'retrofit', 'retrofitOf', 'handWritten', 'harvestOf', 'warmSlot']) {
      if (r[k] !== undefined && r[k] !== null) cur[k] = r[k];
    }
    if (Array.isArray(r.plugMoves) && r.plugMoves.length) cur.plugMoves = r.plugMoves;
    if (Array.isArray(r.pods) && r.pods.length) cur.pods = r.pods;
    by.set(String(r.draftId), cur);
  }
  return by;
}

// Lifecycle v1, DERIVED — never stored, never hand-advanced, so it can't wedge. 'measured' means a
// money signal arrived or had 48h to; the P5 build formalizes this into a registry column later.
export function deriveState(f) {
  if (f.status === 'Posted' || f.status === 'Reposted' || f.status === 'Winner' || f.status === 'Repost Candidate') {
    const ageDays = f.postedAt ? (Date.now() - Date.parse(f.postedAt)) / 864e5 : 0;
    const measured = (f.commission || 0) > 0 || (f.orders || 0) > 0 || (f.affClicks ?? 0) > 0 || ageDays > 2;
    return measured ? 'measured' : 'posted';
  }
  return f.status === 'Scheduled' ? 'scheduled' : 'draft';
}

/** Pure join: registry rows + fuel rows + ledger index -> { facts, exceptions }.
 *  opts.engineHandles: fuel-without-post only fires for these X handles — growth/manual accounts
 *  (the operator's own) never have registry cards by design, so their fuel is not an orphan.
 *  opts.now: injectable clock; fuel younger than 48h is sync lag (PC lags fuel ~a day), not orphaned. */
export function buildFacts(registry, fuel, ledger, { engineHandles = null, now = Date.now() } = {}) {
  const fuelByTid = new Map();
  for (const r of fuel) { const k = tweetId(r['X URL']); if (k) fuelByTid.set(k, r); }
  const seenTids = new Set();
  const facts = []; const exceptions = [];
  for (const r of registry) {
    const draftId = String(r['Draft ID'] || '');
    const tid = tweetId(r['X URL']);
    if (tid) seenTids.add(tid);
    const led = ledger.get(draftId) || null;
    const fl = tid ? fuelByTid.get(tid) : null;
    const fires = fl ? parseTierBreakdown(fl['Tier Breakdown']) : [];
    const f = {
      draftId, account: r.Account || '', title: (r.Post || '').slice(0, 90),
      status: r.Status || '', type: r.Type || '', verdict: r.Verdict || undefined,
      postedAt: r['Posted Date'] || null, scheduledFor: r['Scheduled For'] || null,
      xUrl: r['X URL'] || null,
      // money layer
      asin: led?.asin || null, asin2: led?.asin2 || null,
      product: led?.product || r.Product || null, product2: led?.product2 || null,
      pods: led?.pods || [], plugMoves: led?.plugMoves || [], ctaStyle: led?.ctaStyle || null,
      subid1: led?.subid1 || r.Subid || null, subid1b: led?.subid1b || null,
      sourceUrl: led?.sourceUrl || r['Source Thread'] || null,
      niche: led?.niche || r.Niche || null,
      retrofit: led?.retrofit || undefined, handWritten: led?.handWritten || undefined,
      // recycling lineage + warm-slot stamp (operator 2026-08-25): harvestOf makes "did the
      // variation beat the parent" answerable; warmSlot marks plugs standing in donor sell slots.
      harvestOf: led?.harvestOf || undefined, warmSlot: led?.warmSlot || undefined,
      // audience
      views: r.Impressions || 0, linkClicks: r['Link Clicks'] || 0,
      // affClicks and every money key below are LIFETIME first (docs/money-columns.md). This file
      // is the join everything else reads, so sourcing them from the 59-day window put decayed
      // numbers under neutral names in every consumer at once: business-context's ROAS and
      // earn-rate, and repost-triage, which triages at the 90-day rotation and therefore never
      // sees a candidate the window has NOT already torn pages out of. The windowed values remain
      // reachable under the `windowed*` keys, and `linkClicks` stays what it always was: reach.
      affClicks: r['Lifetime Clicks'] ?? r['Affiliate Clicks'] ?? null,
      likes: r.Likes || 0, bookmarks: r.Bookmarks || 0,
      engRate: r['Engagement Rate'] || 0,
      // money
      commission: r['Lifetime Commission'] ?? r.Commission ?? 0,
      sales: r['Lifetime Sales'] ?? r.Sales ?? 0,
      orders: r['Lifetime Orders'] ?? r.Orders ?? 0,
      windowedCommission: r.Commission ?? null, windowedSales: r.Sales ?? null, windowedOrders: r.Orders ?? null,
      windowedAffClicks: r['Affiliate Clicks'] ?? null,
      lifetimeCommission: r['Lifetime Commission'] ?? null, // kept: named readers still ask for it by this key
      lifetimeClicks: r['Lifetime Clicks'] ?? null, // LEVANTA clicks, no decay - the Winner/blitz clicks arm
      genCost: r['Gen Cost'] ?? led?.llmCost ?? null,
      // fuel
      fuel: fl ? {
        spend: fl['Total Spend'] || 0, tiers: fl['Tiers Used'] || '', reach: fl.Reach || 0,
        fires, vendors: [...new Set(fires.flatMap((e) => e.vendors))],
        firstFired: fl['First Fired'] || null, lastFired: fl['Last Fired'] || null,
        ...(fl['Skipped Vendor'] ? { skippedVendor: fl['Skipped Vendor'] } : {}),
        ...(fl.Holdout ? { holdout: true } : {}),
      } : null,
    };
    f.state = deriveState(f);
    facts.push(f);
    // A monetized, posted thread the ledger has never heard of can never attribute its revenue.
    if (!led && (f.subid1 || r.Product) && (f.state === 'posted' || f.state === 'measured')) {
      exceptions.push({ kind: 'no-ledger-row', draftId, account: f.account, title: f.title });
    }
  }
  for (const [tid, fl] of fuelByTid) {
    if (seenTids.has(tid)) continue;
    if (engineHandles && !engineHandles.has(String(fl.Account || ''))) continue; // growth/manual: no card by design
    const lastMs = Date.parse(fl['Last Fired'] || fl['First Fired'] || '') || 0;
    if (lastMs && now - lastMs < 48 * 3600000) continue; // registry lags fuel ~a day — not an orphan yet
    exceptions.push({ kind: 'fuel-without-post', tweetId: tid, account: fl.Account || '', spend: fl['Total Spend'] || 0 });
  }
  // Stable order keeps the nightly git diff small: only rows that actually changed move.
  facts.sort((a, b) => String(a.postedAt || '9999').localeCompare(String(b.postedAt || '9999')) || a.draftId.localeCompare(b.draftId));
  return { facts, exceptions };
}

async function pullAll(env, table) {
  const out = []; let offset;
  do {
    const u = `https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`${table} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const d = await r.json();
    out.push(...d.records.map((x) => x.fields));
    offset = d.offset;
  } while (offset);
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await runMain(async () => {
    const env = loadEnv();
    requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
    const [registry, fuel] = await Promise.all([pullAll(env, REGISTRY_TABLE), pullAll(env, FUEL_LOG)]);
    const ledgerPath = join(HERE_DIR, 'ledger.jsonl');
    const ledger = ledgerIndex(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '');
    const { ACCOUNTS } = await import('./accounts.mjs');
    const engineHandles = new Set(Object.values(ACCOUNTS).filter((a) => a.levantaSubidPrefix).map((a) => a.handle));
    const { facts, exceptions } = buildFacts(registry, fuel, ledger, { engineHandles });
    const byState = {};
    for (const f of facts) byState[f.state] = (byState[f.state] || 0) + 1;
    const spend = facts.reduce((s, f) => s + (f.fuel?.spend || 0), 0);
    const comm = facts.reduce((s, f) => s + f.commission, 0);
    console.log(`facts: ${facts.length} posts · ${JSON.stringify(byState)} · $${comm.toFixed(0)} commission · $${spend.toFixed(0)} fuel`);
    for (const e of exceptions.slice(0, 20)) console.log(`  ⚠ ${e.kind}: ${JSON.stringify(e)}`);
    if (exceptions.length > 20) console.log(`  … ${exceptions.length - 20} more exception(s)`);
    if (!DRY) { writeFileSync(OUT, facts.map((f) => JSON.stringify(f)).join('\n') + '\n'); console.log(`✓ wrote ${OUT}`); }
  }, 'facts-build');
}
