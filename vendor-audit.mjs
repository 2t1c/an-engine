// vendor-audit.mjs — which RT vendor actually earns its price? Read-only, like pod-coverage:
// nothing here fires, bills, or edits — it MEASURES, weekly, so the ladder can be pruned on
// evidence instead of vibes ($3.2k/mo of fuel deserves at least that).
//
// Three reads join into one table per vendor:
//   1. FIRES  — Fuel Log `Tier Breakdown` lines (vendor, price, timestamp per fire) + the new
//               `Skipped Vendor` / `Holdout` stamps (leave-one-out + 1-in-10 control, live since
//               the 2026-08-24 measurement layer).
//   2. LIFT   — Growth Log view snapshots around each fire: velocity in the window after the fire
//               minus velocity just before it. Co-fired vendors share a post's lift by spend split
//               and are FLAGGED as such — until the rotation separates them, identical numbers
//               mean "not separable yet", never "equally good".
//   3. MONEY  — facts.jsonl (the truth table): commission of the posts each vendor fired on,
//               attributed by spend share. Money per fuel dollar is the keep/cut number.
//
//   node vendor-audit.mjs            # table + Telegram digest (performance topic)
//   node vendor-audit.mjs --dry      # console only
import { GROWTH, growthBase } from './config.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, telegram, esc, report, logRun, HERE_DIR, runMain } from './lib.mjs';
import { parseTierBreakdown, tweetId } from './facts-build.mjs';
import { TBL } from './config.mjs';

const DRY = process.argv.includes('--dry');
const GROWTH_LOG = GROWTH.table, FUEL_LOG = TBL.fuelLog;
const P = (s) => Date.parse(s);

/** Velocity lift for one fire: views/hr over (last pre-fire -> first post-fire sample) minus
 *  views/hr across the last two pre-fire samples. null when the snapshots don't bracket the fire.
 *  snaps: [{at, views}] sorted ascending; windows in ms. Pure — the tests pin it. */
export function velocityLift(snaps, fireAt, { preWindow = 8 * 36e5, postWindow = 8 * 36e5 } = {}) {
  const t = P(fireAt);
  const pre = snaps.filter((s) => P(s.at) <= t && P(s.at) >= t - preWindow);
  const post = snaps.filter((s) => P(s.at) > t && P(s.at) <= t + postWindow);
  if (pre.length < 2 || !post.length) return null;
  const [a, b] = pre.slice(-2);
  const c = post[0];
  const hPre = (P(b.at) - P(a.at)) / 36e5, hPost = (P(c.at) - P(b.at)) / 36e5;
  if (hPre <= 0 || hPost <= 0) return null;
  return (c.views - b.views) / hPost - (b.views - a.views) / hPre;
}

/** Per-vendor aggregation over fuel rows + growth snapshots + facts money. Pure. */
export function vendorTable(fuelRows, snapsByTid, factsByTid) {
  const V = new Map();
  const get = (name) => { if (!V.has(name)) V.set(name, { fires: 0, spend: 0, lifts: [], joined: 0, comm: 0, spendJoined: 0, posts: new Set(), coFired: 0, skips: 0 }); return V.get(name); };
  let holdouts = 0;
  for (const r of fuelRows) {
    const tid = tweetId(r['X URL']);
    if (r.Holdout) { holdouts++; continue; }
    const fires = parseTierBreakdown(r['Tier Breakdown']);
    if (r['Skipped Vendor']) get(r['Skipped Vendor']).skips++;
    const fact = factsByTid?.get(tid);
    const rowSpend = fires.reduce((s, e) => s + e.price, 0) || 1;
    // Co-fired = another vendor hit the SAME post within 2h (separate ledger lines, same volley) —
    // their lift numbers are shared by construction until the leave-one-out rotation splits them.
    const coAt = (e) => fires.some((o) => o !== e && P(o.at) >= P(e.at) - 72e5 && P(o.at) <= P(e.at) + 72e5 && o.vendors.join() !== e.vendors.join());
    for (const e of fires) {
      const share = e.vendors.length || 1;
      for (const vendor of (e.vendors.length ? e.vendors : ['(unnamed)'])) {
        const v = get(vendor);
        v.fires++; v.spend += e.price / share; v.posts.add(tid);
        if (e.vendors.length > 1 || coAt(e)) v.coFired++;
        const lift = snapsByTid?.has(tid) ? velocityLift(snapsByTid.get(tid), e.at) : null;
        if (lift != null) { v.lifts.push({ lift, price: e.price / share }); }
        if (fact) { v.joined++; v.comm += (fact.commission || 0) * (e.price / share) / rowSpend; v.spendJoined += e.price / share; }
      }
    }
  }
  const rows = [...V.entries()].map(([vendor, v]) => {
    const med = v.lifts.length ? [...v.lifts].sort((a, b) => a.lift - b.lift)[v.lifts.length >> 1].lift : null;
    return {
      vendor, fires: v.fires, spend: +v.spend.toFixed(2), posts: v.posts.size,
      medianLift: med == null ? null : Math.round(med),
      liftN: v.lifts.length,
      commPerDollar: v.spendJoined ? +(v.comm / v.spendJoined).toFixed(2) : null,
      coFiredShare: v.fires ? +(v.coFired / v.fires).toFixed(2) : 0,
      skips: v.skips,
    };
  }).sort((a, b) => b.spend - a.spend);
  return { rows, holdouts };
}

async function pull(env, table, fields = null, base = env.REGISTRY_BASE_ID) {
  const out = []; let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    if (fields) for (const f of fields) qs.append('fields[]', f);
    const r = await fetch(`https://api.airtable.com/v0/${base}/${table}?${qs}`, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`${table} -> ${r.status}`);
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
    const [fuel, growth] = await Promise.all([
      pull(env, FUEL_LOG),
      pull(env, GROWTH_LOG, ['X URL', 'At', 'Views'], growthBase(env)),
    ]);
    const snapsByTid = new Map();
    for (const g of growth) {
      const k = tweetId(g['X URL']);
      if (k && g.At && g.Views != null) { if (!snapsByTid.has(k)) snapsByTid.set(k, []); snapsByTid.get(k).push({ at: g.At, views: g.Views }); }
    }
    for (const arr of snapsByTid.values()) arr.sort((a, b) => P(a.at) - P(b.at));
    const factsByTid = new Map();
    const fp = join(HERE_DIR, 'facts.jsonl');
    if (existsSync(fp)) for (const line of readFileSync(fp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const f = JSON.parse(line); const k = tweetId(f.xUrl);
      if (k) factsByTid.set(k, f);
    }
    const { rows, holdouts } = vendorTable(fuel, snapsByTid, factsByTid);
    console.log(`vendor audit — ${fuel.length} fuel rows · ${holdouts} holdout(s) recorded so far\n`);
    console.log(`${'vendor'.padEnd(26)} ${'fires'.padStart(5)} ${'spend'.padStart(8)} ${'medLift/hr'.padStart(10)} ${'n'.padStart(4)} ${'comm/$'.padStart(7)} ${'co-fired'.padStart(8)} ${'sat out'.padStart(7)}`);
    for (const r of rows) {
      console.log(`${r.vendor.slice(0, 26).padEnd(26)} ${String(r.fires).padStart(5)} ${('$' + r.spend.toFixed(0)).padStart(8)} ${(r.medianLift == null ? '—' : (r.medianLift > 0 ? '+' : '') + r.medianLift).padStart(10)} ${String(r.liftN).padStart(4)} ${(r.commPerDollar == null ? '—' : '$' + r.commPerDollar.toFixed(2)).padStart(7)} ${(Math.round(r.coFiredShare * 100) + '%').padStart(8)} ${String(r.skips).padStart(7)}`);
    }
    console.log('\nreading rules: co-fired near 100% = numbers are shared, not solo (the rotation separates them over ~3-4 weeks); comm/$ under $1.00 with a real n = paying more for boosts than they return.');
    if (!DRY) {
      const top = rows.filter((r) => r.liftN >= 3).slice(0, 8);
      const msg = report({
        emoji: '🚀', title: 'Vendor lift audit', scope: `${fuel.length} boosted posts · ${holdouts} holdouts`,
        status: `${rows.length} vendors measured`,
        sections: [{ label: 'PER VENDOR (spend · median lift · commission per fuel $)', body: top.map((r) => `• ${esc(r.vendor)} — $${r.spend.toFixed(0)} · ${r.medianLift == null ? '—' : (r.medianLift > 0 ? '+' : '') + r.medianLift}/hr (n=${r.liftN}) · ${r.commPerDollar == null ? '—' : '$' + r.commPerDollar.toFixed(2)}/$${r.coFiredShare > 0.8 ? ' · co-fired' : ''}`).join('\n') || 'no vendor has 3+ measured fires yet' }],
        action: 'Under $1 back per fuel $ with real n = cut candidate; co-fired rows separate as the leave-one-out rotation accumulates.',
      });
      await telegram(env, msg, 'performance').catch((e) => console.error('telegram:', e.message));
    }
    logRun('vendor-audit', { vendors: rows.length, holdouts, fuelRows: fuel.length });
  }, 'vendor-audit');
}
