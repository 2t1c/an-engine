// reconcile-revenue.mjs — the HONEST unclaimed number, with every dollar named.
//
// The dashboard's "unclaimed / −30% vs Levanta" tile compared 30 days of store commission (by
// TRANSACTION date) against posts PUBLISHED in 30 days — evergreen earnings could never appear on
// the attributed side, so the tile read ~90% phantom. This report keeps the store side exactly as
// Levanta pays it (transaction-dated) and resolves EVERY earning link id through the ledger, so
// what remains unclaimed is real and each dollar carries a name: lv_id → draft → account.
//
// Buckets per earning link id:
//   attributed         — claimed by a draft the registry knows (facts.jsonl row exists)
//   ledger-no-registry — claimed by a draft the ledger knows but the registry does not
//                        (fan-out duplicates, deleted drafts — the claimant-guard casualty class)
//   minted-unattached  — a mint-only ledger row (no draftId yet): a hand mint waiting for its thread
//   purged-account     — claimed by a row whose account left the roster (the Knox class); the money
//                        is real, the page is gone — deactivate the links at Levanta to stop it
//   UNKNOWN            — in no ledger structure at all: the genuine leak
//
// honest unclaimed = UNKNOWN + minted-unattached + purged-account.
//
// Gumroad rider: sales count, tagged count, url_parameters key histogram AND ?ref length histogram
// — the instrument for the "long refs get truncated" hypothesis behind the 100% Gumroad blackout.
//
//   node reconcile-revenue.mjs [--days 30] [--dry]
//
// DASHBOARD DATA CONTRACT: the Ops Log row this writes (Source='reconcile') carries the full
// summary in Detail as JSON: { window, storeCommission, attributed, honestUnclaimed,
// buckets: {<name>: {commission, count}}, unknownTop: [{lvId, commission}], gumRefLengths }.
// The dashboard's "unclaimed" tile should render THAT, not its own post-date arithmetic.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, levanta, gumroad, logRun, runMain, HERE_DIR, loadLedger, aggregateLevReports, lvIdOf, nextDay } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';

const DRY = process.argv.includes('--dry');
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const isoDay = (d) => d.toISOString().slice(0, 10);
const money = (n) => `$${(n || 0).toFixed(2)}`;

/** Pure bucket classifier — tests pin it. byLink: Map<lvId,{commission,...}>; ledger: lib's
 *  loadLedger shape; factsByDraft: Map<draftId, factsRow>; accountNames: Set of live roster names. */
export function classifyEarnings({ byLink, ledger, factsByDraft, accountNames }) {
  const mk = () => ({ commission: 0, count: 0, top: [] });
  const buckets = { attributed: mk(), 'ledger-no-registry': mk(), 'minted-unattached': mk(), 'purged-account': mk(), UNKNOWN: mk() };
  const orphanByLv = new Map();
  for (const o of ledger.orphans || []) for (const l of [o.link, o.link2]) { const k = lvIdOf(l); if (k) orphanByLv.set(k, o); }
  for (const [lvId, g] of byLink) {
    const commission = g.commission || 0;
    if (commission <= 0) continue;
    const claimant = ledger.byLvId.get(lvId);
    let name = 'UNKNOWN', row = null;
    if (claimant) {
      row = ledger.byDraft.get(String(claimant)) || null;
      if (row?.account && accountNames && !accountNames.has(row.account)) name = 'purged-account';
      else if (factsByDraft?.has(String(claimant))) name = 'attributed';
      else name = 'ledger-no-registry';
    } else if (orphanByLv.has(lvId)) {
      name = 'minted-unattached'; row = orphanByLv.get(lvId);
    }
    const b = buckets[name];
    b.commission += commission; b.count++;
    b.top.push({ lvId, commission: Number(commission.toFixed(2)), draftId: claimant || null, account: row?.account || null, product: (row?.product || '').slice(0, 44) || null });
  }
  for (const b of Object.values(buckets)) { b.top.sort((a, x) => x.commission - a.commission); b.top = b.top.slice(0, 10); b.commission = Number(b.commission.toFixed(2)); }
  const honestUnclaimed = Number((buckets.UNKNOWN.commission + buckets['minted-unattached'].commission + buckets['purged-account'].commission).toFixed(2));
  return { buckets, honestUnclaimed };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await runMain(async () => {
    const env = loadEnv();
    requireEnv(env, ['LEVANTA_API_KEY', 'GUMROAD_ACCESS_TOKEN']);
    const DAYS = Number(flag('days', 30));
    const since = isoDay(new Date(Date.now() - DAYS * 864e5)), until = isoDay(new Date());

    const reports = await levanta(env).listReports({ start: since, end: until });
    const { byLink } = aggregateLevReports(reports);
    const storeCommission = Number(reports.reduce((a, r) => a + (Number(r.commissionEarned) || 0), 0).toFixed(2));

    const ledger = loadLedger();
    const factsByDraft = new Map();
    const fp = join(HERE_DIR, 'facts.jsonl');
    if (existsSync(fp)) for (const line of readFileSync(fp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const f = JSON.parse(line); if (f.draftId) factsByDraft.set(String(f.draftId), f); } catch {}
    }
    const accountNames = new Set(Object.values(ACCOUNTS).map((a) => a.name));

    const { buckets, honestUnclaimed } = classifyEarnings({ byLink, ledger, factsByDraft, accountNames });

    console.log(`reconcile — ${since} → ${until} (transaction-dated) · store commission ${money(storeCommission)}`);
    console.log(`HONEST UNCLAIMED: ${money(honestUnclaimed)}  (UNKNOWN + minted-unattached + purged-account)\n`);
    for (const [name, b] of Object.entries(buckets)) {
      console.log(`${name.padEnd(20)} ${money(b.commission).padStart(10)} on ${String(b.count).padStart(3)} link(s)`);
      for (const t of b.top.slice(0, name === 'attributed' ? 3 : 10)) {
        console.log(`    ${money(t.commission).padStart(9)}  ${t.lvId}  →  ${t.draftId ? `draft ${t.draftId}` : '(no draft)'}${t.account ? ` · ${t.account}` : ''}${t.product ? ` · ${t.product}` : ''}`);
      }
    }

    // Gumroad rider — the truncation-hypothesis instrument. If url_parameters is empty on ALL
    // sales regardless of ref length, the blackout is not a length problem and the short-ref fix
    // should NOT be built.
    const sales = await gumroad(env).listSales({ after: since, before: nextDay(until) });
    const keys = {}, refLengths = {};
    let tagged = 0, net = 0;
    for (const s of sales) {
      net += (s.price - (s.gumroad_fee || 0)) / 100;
      for (const k of Object.keys(s.url_parameters || {})) keys[k] = (keys[k] || 0) + 1;
      const ref = s.url_parameters && (s.url_parameters.ref || s.url_parameters.subid1);
      if (ref) { tagged++; const bucket = ref.length <= 20 ? '<=20' : ref.length <= 50 ? '21-50' : '51+'; refLengths[bucket] = (refLengths[bucket] || 0) + 1; }
    }
    console.log(`\ngumroad: ${sales.length} sale(s) · ${money(net)} net · ${tagged} tagged · url_parameters keys ${JSON.stringify(keys)} · ref lengths ${JSON.stringify(refLengths)}`);

    // Untracked virals (the B10 class): published, unmonetized, real reach — Julian's 442k-view
    // thread carried 718 clicks and NO link at all. No retro-edit is possible on live tweets; the
    // rescue is a plug follow-up (self-QRT lane), so these are surfaced, never auto-touched.
    const untrackedVirals = [...factsByDraft.values()]
      .filter((f) => ['Posted', 'Reposted', 'Winner', 'Repost Candidate'].includes(f.status) && !f.subid1 && !f.asin && (f.views || 0) > 50000 && f.type !== 'Manual')
      .sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 8)
      .map((f) => ({ draftId: f.draftId, account: f.account, views: f.views || 0, linkClicks: f.linkClicks || 0, title: String(f.title || '').slice(0, 50) }));
    if (untrackedVirals.length) {
      console.log('\nUNTRACKED VIRALS (published, no link, >50k views — rescue via plug follow-up):');
      for (const v of untrackedVirals) console.log(`    ${String(v.views).padStart(9)} views · ${v.linkClicks} clicks · ${v.account} · draft ${v.draftId} · ${v.title}`);
    }

    if (!DRY) {
      writeFileSync(join(HERE_DIR, 'queues', 'unclaimed-revenue.json'), JSON.stringify({
        updatedAt: new Date().toISOString(), honestUnclaimed, count: buckets.UNKNOWN.count + buckets['minted-unattached'].count + buckets['purged-account'].count,
        top: [...buckets.UNKNOWN.top, ...buckets['purged-account'].top].sort((a, b) => b.commission - a.commission).slice(0, 8),
        untrackedVirals,
      }, null, 1) + '\n');
    }
    logRun('reconcile', {
      window: `${since}→${until}`, storeCommission, attributed: buckets.attributed.commission, honestUnclaimed,
      buckets: Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, { commission: b.commission, count: b.count }])),
      unknownTop: buckets.UNKNOWN.top.slice(0, 5).map(({ lvId, commission }) => ({ lvId, commission })),
      untrackedVirals: untrackedVirals.length,
      gumSales: sales.length, gumTagged: tagged, gumNet: Number(net.toFixed(2)), gumUrlParamKeys: keys, gumRefLengths: refLengths,
    });
  }, 'reconcile');
}
