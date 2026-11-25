// revenue.mjs — per-thread revenue across BOTH rails:
//   Levanta (affiliate)  -> conversions grouped by subid1
//   Gumroad (own ebooks) -> sales grouped by url_parameters.ref (the ?ref= tag)
// Joins each to the recreation ledger (subid1 -> thread/draft) so every thread
// reports what it earned. Ends "post and hope."
//   node revenue.mjs               # last 30 days -> Telegram + console
//   node revenue.mjs --since 2026-06-01 --dry
// Env: LEVANTA_API_KEY, GUMROAD_ACCESS_TOKEN (optional), AIRTABLE_PAT/XDB_BASE_ID (Telegram).
import { loadEnv, requireEnv, levanta, gumroad, telegram, esc, logRun, report, lvIdOf, railOf, nextDay, loadLedger, aggregateLevReports } from './lib.mjs';
import { SEND_STATE_DIGESTS } from './config.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DAILY = args.includes('--daily'); // compact totals-only digest (Levanta + Gumroad), no per-thread list
const PROBE = args.includes('--probe'); // read-only join diagnostic (raw rows + key coverage), no Telegram — run live to verify the v1-vs-v2 rails
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const isoDay = (d) => d.toISOString().slice(0, 10);
const money = (n) => `$${n.toFixed(2)}`;

// Ledger loading + join keys come from lib.mjs. The old local loader indexed by subid1 ONLY,
// which dropped 54 rows outright (incl. the fleet #1 earner, Julian 9410902 / $667.48 — a
// mode:'backfill' row with links but no subid) and last-wins-collapsed 86 more. lib's loader
// merges per draftId and keeps everything joinable by lv_ id.

// --- PROBE: read-only diagnostic for the Levanta/Gumroad attribution join. Dumps raw rows + the
// exact join keys from BOTH Levanta endpoints, then measures ledger intersection coverage, so a
// human can verify live which rail carries money and whether the keys line up. Never writes, never
// telegrams. (The sandbox that authored the join fix cannot reach app.levanta.io — run this where
// egress works, BEFORE and AFTER trusting any join change.)
//   node revenue.mjs --probe [--since 2026-05-10]
async function probe(env, since, until, ledger) {
  const out = { window: { since, until } };
  let v1rows = [];
  // A) v1 /reports — the rail revenue.mjs/learn.mjs/tracking-smoke.mjs/registry-sync join on (link.id).
  try {
    const rows = v1rows = await levanta(env).listReports({ start: since, end: until });
    const subidish = rows.length ? ['subid1', 'subid2', 'subids'].filter((k) => rows.some((r) => r[k] != null || r.link?.[k] != null)) : [];
    out.v1_reports = {
      rowCount: rows.length,
      rowKeys: rows.length ? Object.keys(rows[0]) : [],
      linkKeys: rows.length && rows[0].link ? Object.keys(rows[0].link) : [],
      distinctLinkIds: new Set(rows.map((r) => r.link?.id).filter(Boolean)).size,
      totals: rows.reduce((a, r) => ({ commission: a.commission + (Number(r.commissionEarned) || 0), sales: a.sales + (Number(r.sales) || 0), orders: a.orders + (Number(r.conversions) || 0), clicks: a.clicks + (Number(r.clicks) || 0) }), { commission: 0, sales: 0, orders: 0, clicks: 0 }),
      subidFieldsPresent: subidish, // do v1 rows ever carry subids? (they shouldn't need to — we join by link.id)
      sample: rows.slice(0, 3),
    };
  } catch (e) { out.v1_reports = { error: e.message }; }
  // B) v2 /reports/conversions — the rail registry-sync USED to join on (subid1); documented-empty.
  // Distinct statuses settle "truly empty" vs "all rows pending/unapproved and status-filtered".
  try {
    const conv = await levanta(env).listConversions({ start: since, end: until });
    const count = (arr) => arr.reduce((m, k) => ((m[k ?? '(none)'] = (m[k ?? '(none)'] || 0) + 1), m), {});
    out.v2_conversions = {
      rowCount: conv.length,
      distinctSubid1: count(conv.map((c) => c.subid1)),
      distinctStatus: count(conv.map((c) => c.status)),
      sample: conv.slice(0, 3),
    };
  } catch (e) { out.v2_conversions = { error: e.message }; }
  // C) Ledger intersection — the two join-coverage ratios that pinpoint any residual mismatch.
  const ledgerLvIds = new Set(ledger.flatMap((e) => [lvIdOf(e.link), lvIdOf(e.link2)]).filter(Boolean));
  const reportIds = new Set(v1rows.map((r) => r.link?.id).filter(Boolean));
  const convSubids = new Set(Object.keys(out.v2_conversions?.distinctSubid1 || {}).filter((k) => k !== '(none)'));
  const ledgerSubids = new Set(ledger.map((e) => e.subid1).filter(Boolean));
  out.ledger = {
    tracked: ledger.length,
    sampleKeys: ledger.slice(0, 10).map((e) => ({ subid1: e.subid1, lvId: lvIdOf(e.link) })),
    v1Coverage: reportIds.size ? `${[...reportIds].filter((id) => ledgerLvIds.has(id)).length}/${reportIds.size} report link.ids found in ledger` : 'no v1 rows',
    v2Coverage: convSubids.size ? `${[...convSubids].filter((s) => ledgerSubids.has(s)).length}/${convSubids.size} conversion subid1s found in ledger` : 'no v2 rows',
  };
  // D) Gumroad — which url_parameters keys actually arrive on sales (is ?ref surviving checkout?).
  if (env.GUMROAD_ACCESS_TOKEN) {
    try {
      const sales = await gumroad(env).listSales({ after: since, before: nextDay(until) });
      const keys = {};
      for (const s of sales) for (const k of Object.keys(s.url_parameters || {})) keys[k] = (keys[k] || 0) + 1;
      out.gumroad = { salesCount: sales.length, taggedCount: sales.filter((s) => s.url_parameters && (s.url_parameters.ref || s.url_parameters.subid1)).length, urlParameterKeys: keys };
    } catch (e) { out.gumroad = { error: e.message }; }
  }
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY', ...((DRY || PROBE) ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const since = flag('since', isoDay(new Date(Date.now() - (DAILY ? 1 : 30) * 864e5)));
  const until = isoDay(new Date());
  const L = loadLedger();
  const ledger = L.entries; // one merged row per draft — no-subid backfill rows included
  if (PROBE) return probe(env, since, until, [...L.entries, ...L.orphans]);

  // --- Levanta: v1 daily performance per link (commissionEarned/sales/conversions). Joined to the
  // ledger by the minted link id (lv_XXX) since each thread mints its own link. (The v2
  // /reports/conversions endpoint returns empty for this account — v1 /reports has the real money.) ---
  const levReports = await levanta(env).listReports({ start: since, end: until });
  const { byLink: levByLink } = aggregateLevReports(levReports);

  // --- Gumroad: sales grouped by url_parameters.ref tag (+ store summary) ---
  let gum = new Map(), gumStore = null;
  if (env.GUMROAD_ACCESS_TOKEN) {
    const sales = await gumroad(env).listSales({ after: since, before: nextDay(until) }); // `before` is date-EXCLUSIVE — bare `until` drops today's sales
    const byProduct = {}; let totalNet = 0, tagged = 0;
    for (const s of sales) {
      const net = (s.price - (s.gumroad_fee || 0)) / 100;
      totalNet += net;
      byProduct[s.product_name] = (byProduct[s.product_name] || 0) + net;
      const ref = s.url_parameters && (s.url_parameters.ref || s.url_parameters.subid1);
      if (ref) {
        tagged++;
        const g = gum.get(ref) || { orders: 0, sales: 0, net: 0 };
        g.orders += 1; g.sales += s.price / 100; g.net += net; gum.set(ref, g);
      }
    }
    gumStore = { count: sales.length, totalNet, tagged, byProduct };
  }

  // --- DAILY: compact totals digest (no per-thread). Used when attribution is $0 but we still want
  // a daily pulse of total sales across both rails. ---
  if (DAILY) {
    const levT = levReports.reduce((a, r) => ({ orders: a.orders + (Number(r.conversions) || 0), sales: a.sales + (Number(r.sales) || 0), commission: a.commission + (Number(r.commissionEarned) || 0) }), { orders: 0, sales: 0, commission: 0 });
    const grand = levT.commission + (gumStore?.totalNet || 0);
    // "Is that good?" — every money number carries a vs-normal: compare against the average day over
    // the prior 7 days on the SAME two rails. Trend failures never block the digest itself.
    let arrow = '';
    try {
      const pStart = isoDay(new Date(Date.parse(since) - 7 * 864e5)), pEnd = isoDay(new Date(Date.parse(since) - 864e5));
      const pLev = (await levanta(env).listReports({ start: pStart, end: pEnd })).reduce((a, r) => a + (Number(r.commissionEarned) || 0), 0);
      let pGum = 0;
      // Gumroad's `before` is date-EXCLUSIVE -> the upper bound is `since` itself (covers through pEnd 23:59).
      if (env.GUMROAD_ACCESS_TOKEN) for (const s of await gumroad(env).listSales({ after: pStart, before: since })) pGum += (s.price - (s.gumroad_fee || 0)) / 100;
      const avg = (pLev + pGum) / 7;
      if (avg >= 0.5) {
        const pct = Math.round(((grand - avg) / avg) * 100);
        arrow = pct >= 5 ? ` ▲ +${pct}% vs 7-day avg` : pct <= -5 ? ` ▼ ${pct}% vs 7-day avg` : ' • flat vs 7-day avg';
      }
    } catch (e) { console.warn(`trend skipped: ${e.message}`); }
    const out = report({
      emoji: '💵', title: 'Daily Sales', scope: `${since} → ${until}`,
      status: `💰 <b>${money(grand)}</b> total${arrow} · ${levT.orders + (gumStore?.count || 0)} sale(s)`,
      sections: [{ label: 'BREAKDOWN', body:
        `🔗 Levanta (affiliate): ${money(levT.commission)} commission · ${levT.orders} order(s) · ${money(levT.sales)} sales\n`
        + (gumStore
          ? `🏪 Gumroad (own ebooks): ${money(gumStore.totalNet)} net · ${gumStore.count} sale(s)`
          : `🏪 <i>Gumroad not connected (set GUMROAD_ACCESS_TOKEN)</i>`) }],
    });
    console.log(out);
    logRun('revenue-daily', { levCommission: Number(levT.commission.toFixed(2)), levOrders: levT.orders, gumNet: gumStore ? Number(gumStore.totalNet.toFixed(2)) : null });
    if (!DRY && SEND_STATE_DIGESTS) { await telegram(env, out, 'revenue'); console.log('\n✓ Sent daily sales'); }
    else if (!DRY) console.log('\n(quiet: state digest — the dashboard renders this. SEND_STATE_DIGESTS in config.mjs restores it.)');
    return;
  }

  // --- Per-thread rows from the ledger. A thread may carry a SECOND product (link2/subid1b), so a
  // thread's revenue is the SUM across both products' links — else product-2 earnings read as $0. ---
  // CLAIMANT GUARD (mirrors registry-sync): a shared lv_ id / subid pays out on exactly ONE draft,
  // or duplicated fan-out rows would multi-count the same aggregate. amazon-attr is a Levanta-rail
  // join too — its aa_adgroupid IS the report's link id (classifying it 'other' earned $0 forever).
  const claimedLvIds = new Set();
  const revFor = (link, subid, draftId) => {
    const rail = railOf(link);
    if (rail === 'levanta' || rail === 'amazon-attr') {
      const key = lvIdOf(link);
      const claimed = key && String(L.byLvId.get(key)) === String(draftId);
      if (claimed) claimedLvIds.add(key);
      const m = claimed ? levByLink.get(key) : null;
      return { rail, m, revenue: m?.commission || 0, orders: m?.orders || 0 };
    }
    const m = rail === 'gumroad' && subid && String(L.bySubid.get(subid)?.draftId) === String(draftId) ? gum.get(subid) : null;
    return { rail, m, revenue: m?.net || 0, orders: m?.orders || 0 };
  };
  const rows = ledger.map((e) => {
    const parts = [revFor(e.link, e.subid1, e.draftId), ...(e.link2 ? [revFor(e.link2, e.subid1b, e.draftId)] : [])];
    const revenue = parts.reduce((s, p) => s + p.revenue, 0);
    const orders = parts.reduce((s, p) => s + p.orders, 0);
    return { e, rail: parts[0].rail, m: parts[0].m, revenue, orders };
  }).sort((a, b) => b.revenue - a.revenue);

  const total = rows.reduce((s, r) => s + r.revenue, 0);
  // Store-vs-threads delta (named for the first time): commission the store earned on links the
  // ledger cannot claim — orphaned links, purged accounts (Knox), pre-ledger mints. This is the
  // honest version of the dashboard's "unclaimed" tile; reconcile-revenue.mjs names each dollar.
  const storeCommission = levReports.reduce((a, r) => a + (Number(r.commissionEarned) || 0), 0);
  const unattributedIds = [...levByLink.keys()].filter((k) => !claimedLvIds.has(k) && (levByLink.get(k)?.commission || 0) > 0);
  const unattributedCommission = unattributedIds.reduce((a, k) => a + levByLink.get(k).commission, 0);
  const earners = rows.filter((r) => r.revenue > 0); // only list threads that actually earned — $0 rows bloat the message past Telegram's cap
  const lines = earners.slice(0, 25).map(({ e, rail, revenue, orders }) => {
    const detail = `<b>${money(revenue)}</b> ${rail === 'levanta' ? 'commission' : 'net'} · ${orders} order(s)`;
    const name = esc(((e.product || e.subid1) + (e.product2 ? ` + ${e.product2}` : '')).slice(0, 44));
    const label = e.sourceUrl ? `<a href="${e.sourceUrl}">${name}</a>` : name;
    return `💰 ${detail} <i>(${rail})</i>\n      ${esc(e.account)}: ${label}`;
  });

  const sections = [];
  // Attribution-gap guard: real store revenue but nothing tagged => the per-thread join is
  // blind (no ?ref links live yet, or broken plumbing). Shout it so $X never reads as a quiet $0.
  const attributionGap = gumStore && gumStore.totalNet > 0 && gumStore.tagged === 0;
  // Revenue-blackout guard: $0 tracked across enough threads is NOT a quiet success — it means
  // nothing converted yet OR attribution is broken. Goal #1 is revenue-per-thread, so surface it.
  const blackout = ledger.length >= 3 && total === 0;
  // Leading ⚠️ warning sections (blackout first, then attribution gap — matches the original unshift order).
  if (blackout) {
    sections.push({ label: 'REVENUE BLACKOUT', body:
      `⚠️ $0 tracked across ${ledger.length} thread(s) over ${since}→${until}. Either nothing converted yet or attribution is broken. Spot-check one thread's link actually carries its subid1.` });
  }
  if (attributionGap) {
    sections.push({ label: 'ATTRIBUTION GAP', body:
      `⚠️ ${money(gumStore.totalNet)} Gumroad net but <b>0</b> sales tagged with ?ref. Real money is flowing untracked — confirm tagged links are live (url_parameters / subid plumbing).` });
  }
  if (unattributedCommission >= 1) {
    sections.push({ label: 'UNATTRIBUTED \u2014 store minus threads', body:
      `\u26a0\ufe0f ${money(unattributedCommission)} commission on <b>${unattributedIds.length}</b> link(s) the ledger cannot claim (orphaned/pre-ledger/purged accounts). The weekly reconcile names each one.` });
  }
  sections.push({ label: 'BY THREAD', body: lines.length
    ? [...lines, ...(earners.length > 25 ? [`<i>…and ${earners.length - 25} more earning thread(s)</i>`] : [])].join('\n')
    : `<i>No thread has earned yet — per-thread attribution starts once tagged conversions flow.</i>` });
  if (gumStore) {
    const store = [
      `<b>${money(gumStore.totalNet)}</b> net · ${gumStore.count} sale(s) · ${gumStore.tagged} tagged with ?ref`,
      ...Object.entries(gumStore.byProduct).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `  ${money(n)} — ${esc(p.slice(0, 46))}`),
    ];
    if (gumStore.tagged === 0) store.push(`  ⚠️ <i>0 tagged sales yet — per-thread attribution starts once tagged links go live.</i>`);
    sections.push({ label: 'GUMROAD STORE', body: store.join('\n') });
  }
  // Per-account + top-thread revenue for the retro signal (read-only — summarized from the per-thread
  // rows already built above; never recomputes commission). Surfaces WHICH pages/threads earn so the
  // retro can optimize on $-per-thread instead of only the aggregate total. (IMPROVEMENTS #462.)
  const byAccount = {};
  for (const r of rows) if (r.revenue > 0) byAccount[r.e.account] = Number(((byAccount[r.e.account] || 0) + r.revenue).toFixed(2));
  const topThreads = earners.slice(0, 5).map(({ e, rail, revenue }) => ({ account: e.account, label: (e.product || e.subid1 || '').slice(0, 44), rail, revenue: Number(revenue.toFixed(2)) }));
  logRun('revenue', { threads: ledger.length, total: Number(total.toFixed(2)), withRevenue: earners.length, zeroRevThreads: ledger.length - earners.length, byAccount, topThreads, blackout, storeCommission: Number(storeCommission.toFixed(2)), unattributedCommission: Number(unattributedCommission.toFixed(2)), unattributedLinks: unattributedIds.length, gumroadNet: gumStore ? Number(gumStore.totalNet.toFixed(2)) : null, gumroadTagged: gumStore?.tagged ?? null });
  const out = report({
    emoji: '💵', title: 'Revenue — per thread', scope: `${since} → ${until}`,
    status: `${blackout || attributionGap ? '⚠️' : total > 0 ? '✅' : 'ℹ️'} <b>${money(total)}</b> · ${earners.length}/${ledger.length} tracked thread(s) earning`,
    sections,
  });
  console.log(out);
  if (!DRY && SEND_STATE_DIGESTS) { await telegram(env, out, 'revenue'); console.log('\n✓ Sent to Telegram'); }
  else if (!DRY) console.log('\n(quiet: state digest — the dashboard renders this. SEND_STATE_DIGESTS in config.mjs restores it.)');
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
