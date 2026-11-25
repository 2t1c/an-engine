// weekly-growth.mjs — 📈 the week-over-week growth report. One Telegram message (performance topic)
// comparing the last 7 complete Saigon days (W1) against the 7 before (W0), per page and fleet-wide:
// posts, total + median views, link clicks, and revenue. THE progress baseline: every week, last
// week becomes the bar — no static thresholds to re-tune. Fuel the Fire is untouched by this.
//
//   node weekly-growth.mjs          # send to the performance topic
//   node weekly-growth.mjs --dry    # console only
//
// Conventions:
//   - Posts = the page's published drafts (one per publish). Views = X's own count for the head tweet
//     (twitter241, x-views.mjs). Clicks = Levanta's, per page via the ledger.
//     Until 2026-10-02 posts, views and a second click count came from Typefully's /analytics/x/posts,
//     which answers 404 since 2026-09-30 (the run crashed on it). A post whose views were not read is
//     "unread": out of the view totals and medians, counted on the line, never added as 0. When
//     Levanta cannot be read, clicks print "n/a", not 0.
//   - Day bucket = publish time in Asia/Saigon. Windows are complete days (yesterday back).
//   - ACCRUAL: W1's newest posts are still accruing views for ~3-5 days — view deltas are
//     directional; the revenue windows (Levanta/Gumroad, dated server-side) are exact.
import { loadEnv, requireEnv, telegram, esc, report, logRun, levanta, gumroad, typefully, HERE_DIR, lvIdOf } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { measurementConfidence, withCurrentProviderEvidence } from './measurement-confidence.mjs';
import { publishedDrafts, publishedAtOf, statusIdOf, xViews } from './x-views.mjs';
import { pathToFileURL } from 'node:url';

const DRY = process.argv.includes('--dry');
const confidence = measurementConfidence();
const env = loadEnv();
const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) requireEnv(env, ['TYPEFULLY_API_KEY', 'RAPIDAPI_KEY', 'LEVANTA_API_KEY', ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
const tf = typefully(env);
const xv = xViews(env);

const ymdSaigon = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon' }).format(d);
const daysAgo = (n) => ymdSaigon(new Date(Date.now() - n * 864e5));
const nextDay = (ymd) => new Date(Date.parse(ymd) + 864e5).toISOString().slice(0, 10);
const W1 = { start: daysAgo(7), end: daysAgo(1) };  // last 7 complete days (Mon-run => Mon..Sun)
const W0 = { start: daysAgo(14), end: daysAgo(8) }; // the 7 before
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtK = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n || 0)}`);
const medOrNull = (xs) => (xs.length ? median(xs) : null);
const money = (n) => `$${(n || 0).toFixed(2)}`;
const pct = (from, to) => (from == null || to == null ? '—' : from ? `${to >= from ? '▲' : '▼'}${Math.abs(Math.round(((to - from) / from) * 100))}%` : to ? '🆕' : '—');

// Per-account posts from the published-drafts list, each with its head tweet's X views (null = unread).
async function threadsFor(acc, start, end) {
  const sinceMs = Date.parse(`${start}T00:00:00+07:00`), untilMs = Date.parse(`${nextDay(end)}T00:00:00+07:00`);
  const drafts = await publishedDrafts(tf, acc.socialSetId, { sinceMs, untilMs });
  const ids = drafts.map((d) => statusIdOf(d.x_published_url)).filter(Boolean);
  const read = ids.length ? await xv.lookup(ids, { handle: acc.handle, sinceMs }) : { views: new Map() };
  return drafts.map((d) => ({ day: ymdSaigon(new Date(publishedAtOf(d))), views: read.views.get(statusIdOf(d.x_published_url))?.views ?? null }));
}

/** One window's stats. views/med cover posts whose views were read; `unread` counts the rest (never 0 views). */
export const winStats = (threads, w) => {
  const inW = threads.filter((t) => t.day >= w.start && t.day <= w.end);
  const m = inW.filter((t) => t.views != null);
  return { posts: inW.length, unread: inW.length - m.length, views: m.length ? m.reduce((s, t) => s + t.views, 0) : (inW.length ? null : 0), med: m.length ? Math.round(median(m.map((t) => t.views))) : (inW.length ? null : 0), clicks: null };
};

// ---- Levanta clicks per (account, day) — the affiliate-click truth source ----------------------
// Typefully's link_clicks sensor died 2026-06-29 and returned only HALF-ALIVE (36/2,443 posts
// reporting, at a fraction of real traffic), which made this report undercount clicks ~82% vs the
// Levanta dashboard. Levanta's v1 daily reports are destination-measured and dated server-side, so
// they window exactly; the ledger maps each minted lv_ link id to its account. Per-scope we take
// MAX(typefully, levanta) — undercount-proof under a flaky sensor (same rule as registry-sync).
// Levanta days are UTC vs the Saigon day-buckets used for views: edges can skew a few hours, but
// consistently so week-over-week, which is what this report measures.
function ledgerLinkAccounts() {
  const byLvId = new Map();
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); for (const l of [e.link, e.link2]) { const k = lvIdOf(l); if (k && e.account) byLvId.set(k, e.account); } } catch {}
  }
  return byLvId;
}
async function levantaClicks(start, end) {
  const byLvId = ledgerLinkAccounts();
  // CLICKS ARE NOT PER-ROW (2026-08-08 fix): Levanta /reports returns one row per (date, link, ASIN)
  // and REPEATS the link's click count on every halo-ASIN row. Summing r.clicks multiplied clicks by
  // the halo width (~6x observed) — the exact bug registry-sync.mjs documents and dedups with a per-
  // (date, link) MAX. Same rule here now, for real. Commission IS per-row (each halo ASIN earns its
  // own $) and stays additive.
  const clickMax = new Map();   // `${linkId}|${day}` -> max clicks across that link's halo rows
  const earnAcctDay = new Map(); // account -> Map(day -> commission $); '' = unattributed
  try {
    for (const r of await levanta(env).listReports({ start, end })) {
      const id = r.link?.id; if (!id) continue;
      const day = String(r.date || r.day || '').slice(0, 10); if (!day) continue;
      const c = Number(r.clicks) || 0;
      if (c) { const k = `${id}|${day}`; if (c > (clickMax.get(k) || 0)) clickMax.set(k, c); }
      const $ = Number(r.commissionEarned) || 0;
      if ($) {
        const acct = byLvId.get(id) || '';
        if (!earnAcctDay.has(acct)) earnAcctDay.set(acct, new Map());
        const m = earnAcctDay.get(acct);
        m.set(day, (m.get(day) || 0) + $);
      }
    }
  } catch (e) { console.warn(`levanta clicks: ${e.message}`); return null; } // null -> clicks print n/a (no other click source)
  const perAcctDay = new Map(); // account -> Map(day -> deduped clicks); '' = unattributed (fleet-only)
  for (const [k, c] of clickMax) {
    const [id, day] = k.split('|');
    const acct = byLvId.get(id) || '';
    if (!perAcctDay.has(acct)) perAcctDay.set(acct, new Map());
    const m = perAcctDay.get(acct);
    m.set(day, (m.get(day) || 0) + c);
  }
  const winSum = (map, acct, w) => { const m = map.get(acct); let s = 0; if (m) for (const [d, c] of m) if (d >= w.start && d <= w.end) s += c; return s; };
  const sum = (acct, w) => winSum(perAcctDay, acct, w);
  const fleetSum = (w) => { let s = 0; for (const acct of perAcctDay.keys()) s += sum(acct, w); return s; };
  const earn = (acct, w) => winSum(earnAcctDay, acct, w);
  return { sum, fleetSum, earn };
}

// Fleet revenue per window (Levanta commission + Gumroad net) — dated server-side, so exact per window.
async function revenueWindow(w) {
  let commission = 0, sales = 0, failed = false;
  try { for (const r of await levanta(env).listReports({ start: w.start, end: w.end })) { commission += Number(r.commissionEarned) || 0; sales += Number(r.conversions) || 0; } }
  catch (e) { failed = true; console.warn(`levanta ${w.start}..${w.end}: ${e.message}`); }
  if (env.GUMROAD_ACCESS_TOKEN) {
    try { for (const s of await gumroad(env).listSales({ after: w.start, before: nextDay(w.end) })) { commission += (s.price - (s.gumroad_fee || 0)) / 100; sales++; } }
    catch (e) { failed = true; console.warn(`gumroad ${w.start}..${w.end}: ${e.message}`); }
  }
  return { total: commission, sales, failed };
}

if (!IS_MAIN) { /* imported by a test: the pure helpers above are all it needs */ } else {
const pages = Object.values(ACCOUNTS).filter((a) => a.plugHeavyExample && !a.paused && a.socialSetId);
const perPage = [];
const fleet = { w0: { posts: 0, unread: 0, views: 0, clicks: null, meds: [] }, w1: { posts: 0, unread: 0, views: 0, clicks: null, meds: [] } };
const lev = await levantaClicks(W0.start, W1.end); // null if the Levanta call failed
for (const acc of pages) {
  const threads = await threadsFor(acc, W0.start, W1.end);
  const w0 = winStats(threads, W0), w1 = winStats(threads, W1);
  if (lev) { // destination-measured Levanta clicks are the only click count left
    w0.clicks = lev.sum(acc.name, W0);
    w1.clicks = lev.sum(acc.name, W1);
  }
  // Per-account earnings (Levanta commission via the ledger link->account map) — the weekly money
  // trend the operator asked for (2026-08-08). null when the Levanta call failed (line omitted).
  perPage.push({ name: acc.name, w0, w1, earn0: lev ? lev.earn(acc.name, W0) : null, earn1: lev ? lev.earn(acc.name, W1) : null });
  for (const [k, w] of [['w0', w0], ['w1', w1]]) { fleet[k].posts += w.posts; fleet[k].unread += w.unread; fleet[k].views += w.views || 0; if (w.med != null && w.posts) fleet[k].meds.push(w.med); }
}
if (lev) { // fleet totals also cover clicks on links the ledger can't attribute to a page
  fleet.w0.clicks = lev.fleetSum(W0);
  fleet.w1.clicks = lev.fleetSum(W1);
}
for (const k of ['w0', 'w1']) if (fleet[k].posts && fleet[k].unread === fleet[k].posts) fleet[k].views = null; // nothing read: unknown, not 0
const [rev1, rev0] = await Promise.all([revenueWindow(W1), revenueWindow(W0)]);
const decisionConfidence = withCurrentProviderEvidence(confidence, {
  affiliateClicksComplete: lev !== null,
  currentRevenueComplete: !rev0.failed && !rev1.failed,
});

const unreadNote = (w) => (w.unread ? ` (${w.unread} unread)` : '');
const clicksText = (n) => (n == null ? 'n/a' : String(n));
const lines = decisionConfidence.status === 'decision-grade' ? perPage.map(({ name, w0, w1, earn0, earn1 }) =>
  `<b>${esc(name)}</b> · ${w1.posts} post${w1.posts === 1 ? '' : 's'} (${pct(w0.posts, w1.posts)})${earn1 != null ? ` · earned <b>${money(earn1)}</b> (${pct(earn0, earn1)})` : ''}\n` +
  `   views ${fmtK(w1.views)}${unreadNote(w1)} (${pct(w0.views, w1.views)}) · med/post ${fmtK(w1.med)} (${pct(w0.med, w1.med)}) · clicks ${clicksText(w1.clicks)} (${pct(w0.clicks, w1.clicks)})`) : ['Per-page comparisons suppressed until measurement confidence is decision-grade.'];
// Commission on links the ledger can't map to a page (pre-ledger drafts, manual links) — shown so
// per-page $ never silently under-reads vs the fleet revenue line.
const unattr1 = lev ? lev.earn('', W1) : 0;
if (unattr1 >= 0.5) lines.push(`<i>+ ${money(unattr1)} on links not attributed to a page</i>`);
const f0 = fleet.w0, f1 = fleet.w1;
// Lead with a legend state glyph (✅/⚠️) so this reads like every other report; the trend arrow stays
// inside the line as the direction cue.
const status = `${decisionConfidence.status === 'decision-grade' ? (rev1.total >= rev0.total ? '✅ 📈' : '⚠️ 📉') : '⚠️'} revenue <b>${money(rev1.total)}</b> (${pct(rev0.total, rev1.total)}) · views <b>${fmtK(f1.views)}</b>${unreadNote(f1)} (${pct(f0.views, f1.views)}) · ${f1.posts} posts${decisionConfidence.status === 'decision-grade' ? '' : ' · measurement incomplete'}`;
const summary = [
  `posts: ${f0.posts} → <b>${f1.posts}</b> (${pct(f0.posts, f1.posts)})`,
  `total views: ${fmtK(f0.views)}${unreadNote(f0)} → <b>${fmtK(f1.views)}</b>${unreadNote(f1)} (${pct(f0.views, f1.views)})`,
  `median views/post: ${fmtK(medOrNull(f0.meds))} → <b>${fmtK(medOrNull(f1.meds))}</b> (${pct(medOrNull(f0.meds), medOrNull(f1.meds))})`,
  `link clicks (Levanta): ${clicksText(f0.clicks)} → <b>${clicksText(f1.clicks)}</b> (${pct(f0.clicks, f1.clicks)})`,
  `revenue: ${money(rev0.total)} → <b>${money(rev1.total)}</b> (${pct(rev0.total, rev1.total)}) · ${rev1.sales} sale${rev1.sales === 1 ? '' : 's'}${rev1.failed || rev0.failed ? ' ⚠️ partial (a revenue source errored)' : ''}`,
  `decision confidence: <b>${decisionConfidence.status}</b>${decisionConfidence.reasons.length ? ` (${decisionConfidence.reasons.join(', ')})` : ''}`,
  `measurement contract: ${confidence.contract_version || 'unknown'} · audit evaluated: ${confidence.evaluated_at || 'unknown'} · newest ledger record: ${confidence.newest_source_at || 'unknown'} · end-to-end coverage: ${confidence.coverage?.end_to_end_percent ?? 'unknown'}%`,
  // H3: the fuel gauge — computed weekly by donor-runway.mjs (reconcile.yml), never by hand.
  ...(() => {
    try {
      const rw = JSON.parse(readFileSync(join(HERE_DIR, 'queues', 'donor-runway.json'), 'utf8'));
      return rw.weeks != null ? [`fresh-donor runway: <b>~${rw.weeks} wk</b> (${rw.stock} unused · ${rw.burnPerWeek}/wk burn)${rw.weeks < 8 ? ' ⚠️' : ''}`] : [];
    } catch { return []; }
  })(),
].join('\n');

const msg = report({
  emoji: '📈', title: 'Week-over-week', scope: `${W1.start}..${W1.end} vs ${W0.start}..${W0.end}`,
  status,
  sections: [
    { label: 'FLEET', body: summary },
    { label: 'PER PAGE', body: lines.join('\n\n') },
  ],
  action: decisionConfidence.status === 'decision-grade'
    ? 'Newest posts are still accruing views (~3-5d) — view deltas are directional.'
    : 'Treat this as monitoring only; resolve the attribution audit before using it for scaling or ranking.',
});
console.log(msg.replace(/<[^>]+>/g, ''));
logRun('weekly-growth', { w1: { ...f1, meds: undefined, med: medOrNull(f1.meds), revenue: rev1.total }, w0: { ...f0, meds: undefined, med: medOrNull(f0.meds), revenue: rev0.total }, byAccountEarned: Object.fromEntries(perPage.map((p) => [p.name, p.earn1 ?? null])) });
// Operator request 2026-08-08: this ONE weekly message (per-account earnings trend) goes to Telegram
// even while state digests are muted (SEND_STATE_DIGESTS=false, dashboard-first) — it's the weekly
// money pulse the operator asked to receive without asking. Re-mute by restoring the
// `&& SEND_STATE_DIGESTS` guard.
// Owner 2026-11-01 (reporting guideline, docs/telegram-command-center.md § Reporting guideline): the
// weekly growth pulse is a Books message, Monday morning, next to nothing else.
if (!DRY) { await telegram(env, msg, 'books'); console.log('\n✓ sent to Books topic'); }
} // IS_MAIN
