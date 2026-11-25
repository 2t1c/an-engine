// weekly-metrics.mjs — the north-star ledger. Every Monday (from weekly-growth.yml, after the WoW
// report) this writes ONE row per (week, account) + a Fleet row into the "Weekly Metrics" table:
//
//   1. GOALS.md's power law as a tracked series — profit = shots × hit-rate × $/hit. The registry
//      always held the ingredients (posted counts, winners, commission); nothing composed them into
//      the three factors the whole strategy is priced in, so "is hit-rate up or is volume up?" was
//      never answerable from a chart. Now it is, weekly, per account.
//   2. Unit economics per week: Σ gen cost, Σ fuel spend, cost per winner.
//   3. Audience: follower delta across the week (Account Metrics daily series).
//   4. Funnel health medians: plug exposure, true plug CTR, redirect survival (aggregate ratio,
//      never a mean of ratios — same rule as the dashboard's aggregate ROAS).
//   5. Growth-curve shape from the Growth Log's hourly snapshots: half-life, peak-rise hour, share
//      of views after h12 — the numbers the X-ALGORITHM notes cite as one-off findings ("44% after
//      h12, peak ~h9.8"), recomputed weekly so a shift in the curve is seen, not remembered.
//   6. Revenue per HOOK (ledger hookId ⨯ Levanta 28d) -> learnings/hook-perf.json — closes the
//      winner-factory loop: "log which hook is on which body, so a winner is attributable to the
//      hook and not to luck".
//
// Both the just-finished week AND the one before are recomputed each run: winners mature for days
// (clicks/commission accrue), so last week's row hardens one week later instead of freezing soft.
//
// Dashboard-first: no Telegram send (alert philosophy — a scheduled job says nothing unless a human
// is needed). The dashboard reads the table; logs/ keeps the run metrics for the retro.
//
//   node weekly-metrics.mjs             # compute + upsert both weeks
//   node weekly-metrics.mjs --dry       # compute + print, no writes
//   node weekly-metrics.mjs --week 2026-08-04   # backfill a specific Monday
// Env: AIRTABLE_PAT, REGISTRY_BASE_ID, LEVANTA_API_KEY (hook rollup; skipped without it)
import { isThreadRow } from './monitoring-scope.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, levanta, logRun, HERE_DIR, lvIdOf } from './lib.mjs';
import { REGISTRY_TABLE, GROWTH, growthBase } from './config.mjs';
import { median, growthShape, lastCompleteWeek } from './metrics.mjs';
import { evaluateEntryGate } from './harvest-gate.mjs';

/** Pure (H4): pair every shipped harvest/blitz variation with its parent and compare what the
 *  operator actually optimizes — views and LEVANTA clicks. A ratio over 1 means the child beat
 *  the original. Exported for tests. */
export function harvestReadback(facts) {
  const byId = new Map((facts || []).filter((f) => f.draftId).map((f) => [String(f.draftId), f]));
  const clk = (x) => x.lifetimeClicks ?? x.affClicks ?? 0;
  const pairs = [];
  for (const f of facts || []) {
    if (!f.harvestOf) continue;
    const parent = byId.get(String(f.harvestOf));
    if (!parent) continue;
    pairs.push({
      child: String(f.draftId), parent: String(f.harvestOf), account: f.account || null,
      viewsRatio: (parent.views || 0) > 0 ? Number(((f.views || 0) / parent.views).toFixed(2)) : null,
      clicksRatio: clk(parent) > 0 ? Number((clk(f) / clk(parent)).toFixed(2)) : null,
      childViews: f.views || 0, childClicks: clk(f),
    });
  }
  return pairs;
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const WEEKLY_TABLE = 'Weekly Metrics';
const ACCOUNT_METRICS_TABLE = 'Account Metrics';
const GROWTH_LOG = GROWTH.table; // own base since 2026-11-25 (config.mjs GROWTH)
const HOOK_WINDOW_DAYS = 28;            // hook revenue rollup window (Levanta caps ranges at 60d)

const ymdSaigon = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon' }).format(d);
const isoDay = (d) => d.toISOString().slice(0, 10);
const shiftDay = (ymd, days) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const tweetId = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || '';
const r4 = (x) => (x == null ? undefined : Math.round(x * 1e4) / 1e4);
const r2 = (x) => (x == null ? undefined : Math.round(x * 100) / 100);
const isPublished = (s) => s === 'Posted' || s === 'Reposted' || s === 'Winner' || s === 'Repost Candidate'; // Reposted sticky since 2026-09-02; old winner spellings tolerated on read until cleanup
// A "winner" is a FARM GATE crosser since 2026-09-02: the Winner/Repost Candidate statuses retired
// with the farm (nothing writes them; the first lifecycle-only sync rewrote every live row), so a
// status-based count would silently zero this table's Winners/Hit Rate — and Monday's two-week
// recompute would overwrite the prior week's recorded values with those zeros. Judging rows against
// the same entry gate the referee uses keeps the north-star columns (shots x hit-rate x $/hit)
// meaningful AND marks the discontinuity honestly: the bar moved from scale.winClicks/winRevenue
// (500/500) to farm.* on this date, exactly the 2026-08-25 class of change.
const isWinner = (f) => evaluateEntryGate({
  views: f['Impressions'] || 0,
  commission: f['Lifetime Commission'] ?? f['Commission'] ?? 0,
  clicks: f['Lifetime Clicks'] ?? f['Affiliate Clicks'] ?? 0,
}).passes;

async function listAll(env, table, { fields, formula, base = env.REGISTRY_BASE_ID } = {}) {
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const out = []; let offset;
  do {
    const p = new URLSearchParams({ pageSize: '100' });
    if (formula) p.set('filterByFormula', formula);
    (fields || []).forEach((f) => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?${p}`, { headers: h });
    if (!r.ok) throw new Error(`Airtable list ${table} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    out.push(...d.records);
    offset = d.offset;
  } while (offset);
  return out;
}

// Batching + 429 retry live in lib's client now (2026-08-30); this was a fifth hand-rolled copy of
// the same loop, and the only one of the five that had no retry.
const upsert = (env, table, mergeOn, rows) => airtable(env, env.REGISTRY_BASE_ID).upsert(table, mergeOn, rows);

// One week's rows (per account + Fleet) from the already-joined registry columns.
// Type 'Threads' rows are Meta Threads cross-posts (the threads×3 lane): no X views exist for them,
// so counting them as X shots put 228 zero-view rows into the week of 2026-09-14 (Shots 353, Median
// Views 0) and diluted hit rate. They are left out of every X-side weekly number.
export function weekRows(week, pcRows, growthByTid = new Map(), followerRows = []) {
  const inWeek = pcRows.filter((r) => {
    const f = r.fields;
    if (!isThreadRow(f) || !isPublished(f['Status']) || f['Type'] === 'Threads') return false;
    const posted = f['Posted Date'] ? ymdSaigon(new Date(f['Posted Date'])) : null;
    return posted && posted >= week.start && posted <= week.end;
  });
  const byAccount = new Map();
  for (const r of inWeek) {
    const a = r.fields['Account'] || '?';
    if (!byAccount.has(a)) byAccount.set(a, []);
    byAccount.get(a).push(r.fields);
  }

  // follower delta per account across the week: last in-window value minus first
  const folByAccount = new Map();
  for (const r of followerRows) {
    const f = r.fields;
    if (!f['Date'] || f['Date'] < week.start || f['Date'] > week.end || !Number.isFinite(f['Followers'])) continue;
    const a = f['Account'];
    if (!folByAccount.has(a)) folByAccount.set(a, []);
    folByAccount.get(a).push({ date: f['Date'], followers: f['Followers'] });
  }
  const folDelta = (a) => {
    const s = (folByAccount.get(a) || []).sort((x, y) => (x.date < y.date ? -1 : 1));
    return s.length >= 2 ? s[s.length - 1].followers - s[0].followers : null;
  };

  const build = (account, posts) => {
    const shots = posts.length;
    const winners = posts.filter((f) => isWinner(f)).length;
    // Lifetime, matching isWinner above (docs/money-columns.md). The windowed `Commission` is
    // right for the two weeks this normally recomputes and wrong for any `--week` backfill older
    // than the 59-day window, which would have written a too-small revenue into a permanent row.
    const revenue = posts.reduce((s, f) => s + (f['Lifetime Commission'] ?? f['Commission'] ?? 0), 0);
    const genCost = posts.reduce((s, f) => s + (f['Gen Cost'] || 0), 0);
    const fuel = posts.reduce((s, f) => s + (f['Fuel Spend'] || 0), 0);
    // Redirect survival, reconstructed exactly: each post's stored ratio came from aff/tf, so
    // tf = aff/ratio — summing those recovers Σaff/Σtf (aggregate ratio, never a mean of ratios).
    // A post whose ratio is 0 (aff 0, tf healthy) contributes its Link Clicks as tf (= max(tf, 0)).
    //
    // `aff` MUST be the same numerator registry-sync divided by, which became `Lifetime Clicks` on
    // 2026-09-08. Reading the windowed `Affiliate Clicks` against a lifetime-derived ratio recovers
    // windowedAff x tf / lifetimeAff, which is not tf and not anything else either.
    let affSum = 0, tfSum = 0;
    for (const f of posts) {
      const s = f['Redirect Survival %'], aff = f['Lifetime Clicks'] ?? f['Affiliate Clicks'];
      if (s == null || !Number.isFinite(aff)) continue;
      if (s > 0) { affSum += aff; tfSum += aff / s; }
      else if (f['Link Clicks'] > 0) tfSum += f['Link Clicks'];
    }
    const shape = posts.map((f) => growthByTid.get(tweetId(f['X URL']))).filter(Boolean);
    const med = (key) => median(posts.map((f) => f[key]).filter((x) => Number.isFinite(x)));
    return {
      'Key': `${week.start} · ${account}`, 'Week Start': week.start, 'Account': account,
      'Shots': shots, 'Winners': winners,
      ...(shots ? { 'Hit Rate': r4(winners / shots) } : {}),
      'Revenue': r2(revenue),
      ...(winners ? { 'Per Hit': r2(revenue / winners), 'Cost Per Winner': r2((genCost + fuel) / winners) } : {}),
      ...(shots ? { 'Rev Per Post': r2(revenue / shots), 'Median Views': Math.round(median(posts.map((f) => f['Impressions'] || 0)) ?? 0) } : {}),
      'Gen Cost': r2(genCost), 'Fuel Spend': r2(fuel),
      ...(folDelta(account) != null ? { 'Follower Delta': folDelta(account) } : {}),
      ...(tfSum > 0 ? { 'Redirect Survival %': r4(affSum / tfSum) } : {}),
      ...(med('Plug Exposure %') != null ? { 'Plug Exposure Med %': r4(med('Plug Exposure %')) } : {}),
      ...(med('True Plug CTR %') != null ? { 'True Plug CTR Med %': r4(med('True Plug CTR %')) } : {}),
      ...(median(shape.map((s) => s.halfLifeH).filter((x) => x != null)) != null ? { 'Half-Life h': r2(median(shape.map((s) => s.halfLifeH).filter((x) => x != null))) } : {}),
      ...(median(shape.map((s) => s.peakRiseH).filter((x) => x != null)) != null ? { 'Peak Rise h': r2(median(shape.map((s) => s.peakRiseH).filter((x) => x != null))) } : {}),
      ...(median(shape.map((s) => s.shareAfter12).filter((x) => x != null)) != null ? { 'Views After 12h %': r4(median(shape.map((s) => s.shareAfter12).filter((x) => x != null))) } : {}),
    };
  };

  const rows = [...byAccount.entries()].map(([a, posts]) => build(a, posts));
  // Fleet row = every account's posts together; follower delta = sum of the per-account deltas
  const fleetPosts = inWeek.map((r) => r.fields);
  const fleet = build('Fleet', fleetPosts);
  const deltas = [...folByAccount.keys()].map(folDelta).filter((d) => d != null);
  if (deltas.length) fleet['Follower Delta'] = deltas.reduce((s, d) => s + d, 0);
  rows.push(fleet);
  return rows;
}

// Revenue per hook: ledger hookId (the SHIPPED tweet 1) and hookFamily/sourceUrl (the donor) joined
// to Levanta commission by minted link id over the trailing window. Grouping only becomes dense as
// hookId-stamped rows accumulate (stamping started 2026-08-17) — an empty rollup is expected early.
async function hookRollup(env, until) {
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (!existsSync(f)) return { hooks: 0, top: [] };
  const byLvId = new Map(); // link id -> {hookId, family, account, draftId} (last line wins, like revenue.mjs)
  for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (!e.hookId) continue;
      const family = e.hookFamily || e.sourceUrl || e.hookId;
      for (const l of [e.link, e.link2]) { const k = lvIdOf(l); if (k) byLvId.set(k, { hookId: e.hookId, family, account: e.account, draftId: e.draftId }); }
    } catch {}
  }
  if (!byLvId.size) return { hooks: 0, top: [] };
  const start = isoDay(new Date(Date.parse(until) - HOOK_WINDOW_DAYS * 864e5));
  const groups = new Map(); // hookId -> {family, accounts:Set, threads:Set, clicks, commission}
  const clickMax = new Map(); // per (date, link) click dedup — Levanta repeats link clicks on halo-ASIN rows
  for (const r of await levanta(env).listReports({ start, end: until })) {
    const id = r.link?.id, led = id && byLvId.get(id);
    if (!led) continue;
    const g = groups.get(led.hookId) || { family: led.family, accounts: new Set(), threads: new Set(), clicks: 0, commission: 0 };
    g.accounts.add(led.account); g.threads.add(led.draftId);
    g.commission += Number(r.commissionEarned) || 0;
    const dayKey = `${String(r.date || '').slice(0, 10)}|${id}`;
    const rowClicks = Number(r.clicks) || 0, seen = clickMax.get(dayKey) || 0;
    if (rowClicks > seen) { g.clicks += rowClicks - seen; clickMax.set(dayKey, rowClicks); }
    groups.set(led.hookId, g);
  }
  const top = [...groups.entries()]
    .map(([hookId, g]) => ({ hookId, family: g.family, threads: g.threads.size, accounts: [...g.accounts], clicks: g.clicks, commission: Number(g.commission.toFixed(2)), epc: g.clicks ? Number((g.commission / g.clicks).toFixed(3)) : null }))
    .sort((a, b) => b.commission - a.commission);
  return { hooks: groups.size, top };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const wk = flag('week') ? { start: flag('week'), end: shiftDay(flag('week'), 6) } : lastCompleteWeek();
  const wkPrev = { start: shiftDay(wk.start, -7), end: shiftDay(wk.start, -1) };
  console.log(`weeks: ${wkPrev.start}..${wkPrev.end} (hardening) + ${wk.start}..${wk.end} (fresh)`);

  const pcRows = await listAll(env, REGISTRY_TABLE, { fields: ['Type', 'Post', 'Account', 'Status', 'Posted Date', 'Impressions', 'Link Clicks', 'Affiliate Clicks', 'Commission', 'Lifetime Commission', 'Lifetime Clicks', 'Gen Cost', 'Fuel Spend', 'X URL', 'Plug Exposure %', 'True Plug CTR %', 'Redirect Survival %'] });
  const growthRaw = await listAll(env, GROWTH_LOG, { base: growthBase(env), fields: ['X URL', 'Views', 'Rise/hr', 'Age (h)', 'At'], formula: `IS_AFTER({At}, "${shiftDay(wkPrev.start, -1)}")` })
    .catch((e) => { console.warn(`growth log read failed (shape stats skipped): ${e.message}`); return []; });
  const byTidSamples = new Map();
  for (const r of growthRaw) {
    const k = tweetId(r.fields['X URL']); if (!k) continue;
    // Fuel tracks to 48h since R2026-10-03; the shape stats were defined on a 24h curve ("final" = the
    // h24 count). Clip, so half-life and "Views After 12h %" stay comparable with every earlier week.
    if (Number(r.fields['Age (h)']) > 24.5) continue;
    if (!byTidSamples.has(k)) byTidSamples.set(k, []);
    byTidSamples.get(k).push({ age: r.fields['Age (h)'], views: r.fields['Views'], rise: r.fields['Rise/hr'] });
  }
  const growthByTid = new Map([...byTidSamples.entries()].map(([k, s]) => [k, growthShape(s)]));
  const followerRows = await listAll(env, ACCOUNT_METRICS_TABLE, { fields: ['Date', 'Account', 'Followers'], formula: `IS_AFTER({Date}, "${shiftDay(wkPrev.start, -1)}")` })
    .catch((e) => { console.warn(`account metrics read failed (follower deltas skipped): ${e.message}`); return []; });

  const rows = [...weekRows(wkPrev, pcRows, growthByTid, followerRows), ...weekRows(wk, pcRows, growthByTid, followerRows)];
  for (const r of rows.filter((x) => x['Week Start'] === wk.start)) {
    console.log(`  ${r.Account}: ${r.Shots} shots · ${r.Winners} win (${r['Hit Rate'] != null ? Math.round(r['Hit Rate'] * 100) + '%' : '—'}) · $${(r.Revenue || 0).toFixed(2)}${r['Per Hit'] != null ? ` · $${r['Per Hit'].toFixed(2)}/hit` : ''}${r['Follower Delta'] != null ? ` · ${r['Follower Delta'] >= 0 ? '+' : ''}${r['Follower Delta']} followers` : ''}`);
  }

  // hook revenue rollup (needs Levanta; skipped without the key so the table write never blocks on it)
  let hooks = { hooks: 0, top: [] };
  if (env.LEVANTA_API_KEY) {
    try { hooks = await hookRollup(env, isoDay(new Date())); }
    catch (e) { console.warn(`hook rollup failed (non-fatal): ${e.message}`); }
  }
  if (hooks.hooks) {
    console.log(`  hooks earning (28d): ${hooks.hooks} — top: ${hooks.top.slice(0, 3).map((h) => `${h.hookId} $${h.commission}`).join(' · ')}`);
  } else console.log('  hook rollup: no hookId-stamped ledger rows earning yet (stamping began 2026-08-17)');

  // H4 readback: did the rotation beat the original? harvestOf was stamped for months and read by
  // nothing — every variation shipped into a void. One line a week answers it.
  let readback = [];
  try {
    const facts = readFileSync(join(HERE_DIR, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    readback = harvestReadback(facts);
    if (readback.length) {
      const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
      console.log(`  harvest readback: ${readback.length} variation(s) · median child/parent views ${med(readback.map((p) => p.viewsRatio)) ?? '—'} · clicks ${med(readback.map((p) => p.clicksRatio)) ?? '—'}`);
      for (const p of readback.slice(0, 4)) console.log(`    ${p.child} vs ${p.parent} (${p.account}): views x${p.viewsRatio ?? '—'} · lev clicks x${p.clicksRatio ?? '—'}`);
    } else console.log('  harvest readback: no shipped variations with a known parent yet');
  } catch { /* facts.jsonl absent on a fresh checkout — the readback is a report, never a blocker */ }

  logRun('weekly-metrics', {
    week: wk.start,
    fleet: rows.find((r) => r.Account === 'Fleet' && r['Week Start'] === wk.start) || null,
    accounts: rows.filter((r) => r['Week Start'] === wk.start).length - 1,
    hookGroups: hooks.hooks,
    harvestPairs: readback.length,
  });
  if (DRY) { console.log('(dry — no writes)'); return; }
  await upsert(env, WEEKLY_TABLE, 'Key', rows);
  console.log(`✓ Upserted ${rows.length} rows into "${WEEKLY_TABLE}".`);
  writeFileSync(join(HERE_DIR, 'learnings', 'hook-perf.json'),
    JSON.stringify({ ts: new Date().toISOString(), windowDays: HOOK_WINDOW_DAYS, hooks: hooks.top.slice(0, 50) }, null, 1) + '\n');
  console.log('✓ learnings/hook-perf.json refreshed.');
}
// Only run when INVOKED, never when imported (same guard + reason as learn.mjs / product-audit):
// importing this module for its pure helpers must not fire a live Airtable+Levanta run — bare
// main() here crashed CI the moment a test imported the file (PR #228's harvest-readback test).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
