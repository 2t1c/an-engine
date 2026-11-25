// diagnose-clicks.mjs — read-only three-way comparison of affiliate-click sources over one window:
//   1) LEVANTA v1 daily reports (the dashboard's own numbers — ground truth for affiliate clicks)
//   2) TYPEFULLY analytics engagement.link_clicks — GONE: /analytics/x/posts has answered 404 since
//      2026-09-30. The column prints "n/a" (not read), never 0; before 2026-10-02 the 404 crashed the run.
//   3) AIRTABLE Published Content "Link Clicks" (what registry-sync wrote; what the morning brief reads)
// Prints per-account and fleet totals side by side so a sync/sensor gap is visible at a glance.
// Writes nothing.
//
//   node diagnose-clicks.mjs --days 14
import { loadEnv, requireEnv, levanta, HERE_DIR, lvIdOf, aggregateLevReports } from './lib.mjs';
import { ANALYTICS_GONE } from './x-views.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = HERE_DIR;
const env = loadEnv();
requireEnv(env, ['LEVANTA_API_KEY', 'AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
const DAYS = Number((process.argv.find((a, i) => process.argv[i - 1] === '--days')) || 14);
const isoDay = (d) => d.toISOString().slice(0, 10);
const start = isoDay(new Date(Date.now() - DAYS * 864e5));
const end = isoDay(new Date());

// ledger: minted link id -> account (claimant = last line wins, same as registry-sync)
const byLvId = new Map();
{
  const f = join(HERE, 'ledger.jsonl');
  if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); for (const l of [e.link, e.link2]) { const k = lvIdOf(l); if (k && e.account) byLvId.set(k, e.account); } } catch {}
  }
}

// ---- 1) Levanta: per-day per-link clicks in window ----
// Deduped per (date, link) like every other consumer: raw v1 rows repeat the LINK-level click
// figure on each halo-ASIN row, and summing them inflated this script's "ground truth" ~5x —
// the audit tool disagreed with the pipeline it audits by construction.
const { byLink, clickByDayLink } = aggregateLevReports(await levanta(env).listReports({ start, end }));
const lev = { total: 0, byAccount: {}, unattributed: 0, days: {} };
for (const [dayKey, clicks] of clickByDayLink) {
  const day = dayKey.slice(0, 10);
  if (day.trim()) lev.days[day] = (lev.days[day] || 0) + clicks;
}
for (const [id, g] of byLink) {
  lev.total += g.clicks;
  const acct = byLvId.get(id);
  if (acct) lev.byAccount[acct] = (lev.byAccount[acct] || 0) + g.clicks;
  else lev.unattributed += g.clicks;
}

// ---- 2) Typefully link_clicks: no source since 2026-09-30 ----
// This read used to page /analytics/x/posts per account. The endpoint is gone and nothing else
// carries per-post link clicks, so the column is unknown — printed "n/a", never summed as 0.

// ---- 3) Airtable Published Content: Link Clicks for posts with Posted Date in window ----
const at = { total: 0, byAccount: {}, rows: 0, zeroRows: 0 };
{
  const formula = encodeURIComponent(`AND(IS_AFTER({Posted Date}, "${start}"), {Status}!="Draft", {Status}!="Scheduled")`);
  let offset;
  do {
    let u = `https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent('Published Content')}?pageSize=100&filterByFormula=${formula}` + (offset ? `&offset=${offset}` : '');
    ['Account', 'Link Clicks', 'Commission'].forEach((f) => { u += `&fields%5B%5D=${encodeURIComponent(f)}`; });
    const r = await fetch(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`Airtable -> ${r.status}`);
    const j = await r.json();
    for (const rec of j.records) {
      const c = rec.fields['Link Clicks'] || 0;
      at.rows++; if (!c) at.zeroRows++;
      at.total += c;
      const acct = rec.fields['Account'] || '?';
      at.byAccount[acct] = (at.byAccount[acct] || 0) + c;
    }
    offset = j.offset;
  } while (offset);
}

// ---- report ----
console.log(`Click-source comparison — posts/clicks in the last ${DAYS}d (${start} → ${end})\n`);
console.log(`LEVANTA (ground truth):   ${lev.total} clicks  (${lev.unattributed} on links not in the ledger)`);
console.log(`TYPEFULLY link_clicks:    n/a — not read (${ANALYTICS_GONE})`);
console.log(`AIRTABLE Published Cont.: ${at.total} clicks  (${at.zeroRows}/${at.rows} rows at zero)\n`);
const accounts = [...new Set([...Object.keys(lev.byAccount), ...Object.keys(at.byAccount)])].sort();
console.log('per account            levanta   typefully   airtable');
for (const a of accounts) {
  console.log(`  ${a.padEnd(20)} ${String(lev.byAccount[a] || 0).padStart(7)}   ${'n/a'.padStart(9)}   ${String(at.byAccount[a] || 0).padStart(8)}`);
}
console.log('\nLevanta clicks by day (sanity):');
for (const d of Object.keys(lev.days).sort()) console.log(`  ${d}: ${lev.days[d]}`);
console.log(`\nDIAGNOSIS SIGNALS:
- typefully: n/a        -> no on-platform click source exists now; Levanta is the only click count.
- airtable  << levanta  -> registry-sync fallback not covering everything (frozen pre-Jun-29 counts win over Levanta, or unledgered links).
- unattributed > 0      -> clicks on links the ledger can't map to an account (manual mints / old threads).`);

// ---- --verify-direct: prove the direct rail's subid attribution with PUBLISHED data -------------
// The operator's question (2026-08-18): direct Amazon links show clicks but conversions lag — is
// the aa_adgroupid -> subid mapping broken, or is it only the 24-48h Amazon Attribution reporting
// delay? The decisive test needs no waiting: CLICKS attribute through the same join conversions
// will use, and clicks through the lag horizon are already published. If Levanta's per-link report
// shows our direct links' clicks — and the conversions endpoint accepts their subids — the rail is
// wired end to end and the lag is the whole story.
if (process.argv.includes('--verify-direct')) {
  // Temporary rider (2026-08-18): CATALOG_GREP env names a substance to search the partnered
  // catalog for. Lives here because this workflow is the one proven dispatchable on a branch —
  // browse-catalog's new input 422s (dispatch validates inputs against MAIN's yml copy).
  if (process.env.CATALOG_GREP) {
    const g = process.env.CATALOG_GREP.toLowerCase();
    const cat = await levanta(env).listAllProducts({ access: true });
    const hits = cat.filter((pd) => String(pd.title || pd.name || '').toLowerCase().includes(g));
    console.log(`\nCATALOG GREP "${g}" -> ${hits.length} hit(s)`);
    for (const pd of hits.slice(0, 20)) console.log(`  ${pd.asin || pd.primary_id || '?'}  ${pd.commission != null ? pd.commission + '%' : '?'}  ${String(pd.title || pd.name || '').slice(0, 90)}`);
  }
  const led2 = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const direct = led2.filter((r) => r.link && /amazon\.com.*maas/.test(r.link) && r.ts >= '2026-08-15');
  const rows = direct.map((r) => ({
    account: r.account, day: r.ts.slice(0, 10), draftId: r.draftId, subid: r.subid1,
    adgroup: (r.link.match(/aa_adgroupid=([^&]+)/) || [])[1] || '(none)',
  }));
  console.log(`\nDIRECT-RAIL VERIFICATION — ${rows.length} direct link rows since 2026-08-15 (${new Set(rows.map((x) => x.adgroup)).size} adgroups)`);

  // 1. per-link clicks from the v1 performance report over the PUBLISHED window
  const lv = levanta(env);
  const reps = await lv.listReports({ start: '2026-08-14', end: end });
  const key = (u) => String(u || '').replace(/[?#].*$/, '');
  const byLink = new Map(); const bySub = new Map();
  for (const rp of reps) {
    const u = rp.link || rp.url || rp.trackingLink || '';
    if (u) byLink.set(key(u), (byLink.get(key(u)) || 0) + (rp.clicks || 0));
    const sid = rp.subid1 || rp.subId1 || rp.subid || null;
    if (sid) bySub.set(sid, (bySub.get(sid) || 0) + (rp.clicks || 0));
  }
  console.log(`report rows: ${reps.length} | rows carrying a subid field: ${[...bySub.keys()].length}`);

  let proven = 0, silent = 0;
  for (const x of rows) {
    const dRow = direct.find((r) => r.subid1 === x.subid);
    const linkClicks = byLink.get(key(dRow.link)) ?? null;
    const subClicks = bySub.get(x.subid) ?? null;
    const verdict = (subClicks > 0 || linkClicks > 0) ? 'ATTRIBUTING' : 'no clicks published yet';
    if (verdict === 'ATTRIBUTING') proven++; else silent++;
    console.log(`  ${x.day} ${String(x.account).padEnd(16)} ${String(x.draftId).padEnd(9)} ${x.adgroup.slice(0, 24).padEnd(26)} link:${linkClicks ?? '-'}  subid:${subClicks ?? '-'}  ${verdict}`);
  }

  // 2. the conversions endpoint must ACCEPT the direct subids (shape check, zero rows expected inside lag)
  const probe = rows.slice(0, 3);
  for (const x of probe) {
    try {
      const conv = await lv.listConversions({ start: '2026-08-14', end: end, subid1: x.subid });
      console.log(`  conversions endpoint accepts subid "${x.subid.slice(0, 44)}..." -> ${conv.length} row(s)`);
    } catch (e) { console.log(`  conversions probe FAILED for ${x.subid.slice(0, 34)}: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`\nVERDICT: ${proven} link(s) already attributing clicks, ${silent} silent (inside the publish lag or genuinely unclicked).`);
  console.log('If links with heavy Typefully clicks stay silent here after 48h, THEN the mapping is suspect.');
}
