// mode-compare.mjs — 🎭 the skeleton-vs-faithful cohort verdict. THE consumer of the ledger's `mode`
// field (written since the skeleton-variation launch, 2026-07-17): joins every tracked thread to its
// realized outcomes and answers the question the whole variation bet rides on — do skeleton variations
// (new content in a proven form) earn the views/clicks/revenue that faithful recreations do?
//
// Per-thread join (per draft):
//   ledger draftId -> published-drafts list (its head tweet) -> X's own views (twitter241, x-views.mjs)
//   ledger link/link2 (lv_ id) -> Levanta v1 daily reports (clicks, conversions, commission)
// Clicks per thread = Levanta's, deduped per (day, link). Until 2026-10-02 views and a second click
// count came from Typefully's /analytics/x/posts; it answers 404 since 2026-09-30, and this script
// caught the 404, counted every draft as "pending" and still sent its verdict and wrote
// skeleton-lift.json. It now refuses when a source cannot be read, and a post whose X views were not
// read is "unmeasured": left out of view totals and rev/1k, never counted as 0 views.
//
// Outputs:
//   - console + Telegram (performance): cohort table (posts, views/post, clicks, revenue, rev/1k views),
//     plus per-topic and per-skeleton breakdowns of the skeleton cohort.
//   - learnings/skeleton-lift.json: per-skeleton realized performance — the reuse signal a future
//     donor-selection boost reads (skeletonId was write-only before this; now it feeds back).
//
//   node mode-compare.mjs             # 30-day window -> report + json + Telegram
//   node mode-compare.mjs --dry       # console only (no file write, no Telegram)
//   node mode-compare.mjs --days 60
// Env: TYPEFULLY_API_KEY, RAPIDAPI_KEY, LEVANTA_API_KEY (+ AIRTABLE for Telegram routing unless --dry).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, levanta, typefully, telegram, esc, report, logRun, runMain, HERE_DIR, lvIdOf, aggregateLevReports } from './lib.mjs';
import { publishedDrafts, statusIdOf, xViews } from './x-views.mjs';
import { pathToFileURL } from 'node:url';
import { ACCOUNTS } from './accounts.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const WINDOW = parseInt(flag('days', '30'), 10);

const money = (n) => (n == null ? '$?' : `$${(n || 0).toFixed(2)}`);
const fmtK = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n || 0)}`);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// One account's published drafts since sinceMs -> Map(draftId -> { views }), views X's own count for
// the head tweet or null when it was not read. A failed drafts read throws: a short list would move
// posts into "pending" and shift both cohorts.
export async function draftStats(tf, xv, acc, sinceMs) {
  const drafts = await publishedDrafts(tf, acc.socialSetId, { sinceMs });
  const ids = drafts.map((d) => statusIdOf(d.x_published_url)).filter(Boolean);
  const read = ids.length ? await xv.lookup(ids, { handle: acc.handle, sinceMs }) : { views: new Map() };
  const out = new Map();
  for (const d of drafts) out.set(String(d.id), { views: read.views.get(statusIdOf(d.x_published_url))?.views ?? null });
  return out;
}

// Cohort rollup. Views, median and rev/1k use MEASURED posts only; `unmeasured` counts the rest.
export function agg(rs) {
  const m = rs.filter((r) => r.views != null);
  return {
    posts: rs.length,
    unmeasured: rs.length - m.length,
    views: m.length ? m.reduce((s, r) => s + r.views, 0) : null,
    medViews: m.length ? Math.round(median(m.map((r) => r.views))) : null,
    clicks: rs.reduce((s, r) => s + r.clicks, 0),
    conv: rs.reduce((s, r) => s + r.conv, 0),
    commission: rs.reduce((s, r) => s + r.commission, 0),
    measuredCommission: m.reduce((s, r) => s + r.commission, 0),
  };
}
export const per1k = (a) => (a.views ? a.measuredCommission / (a.views / 1000) : null); // null: no measured views

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'RAPIDAPI_KEY', 'LEVANTA_API_KEY', ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const sinceMs = Date.now() - WINDOW * 864e5;
  const start = new Date(sinceMs).toISOString().slice(0, 10), end = new Date().toISOString().slice(0, 10);

  // Ledger: every tracked thread in-window that reached a draft. Paused accounts stay INCLUDED — a
  // paused page can't generate, but its already-posted threads keep accruing and must keep counting.
  const entries = [];
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (e.draftId && e.ts && Date.parse(e.ts) >= sinceMs && e.mode !== 'lightweight') entries.push(e); } catch {}
  }

  // Per-draft X views (only the accounts that actually appear in-window). Any failed read stops the
  // run: a verdict over part of the fleet reads as a measured result.
  const tf = typefully(env), xv = xViews(env);
  const accOf = new Map(Object.values(ACCOUNTS).filter((a) => a.socialSetId).map((a) => [a.name, a]));
  const tfBySet = new Map();
  for (const acc of new Set(entries.map((e) => accOf.get(e.account)).filter(Boolean))) {
    tfBySet.set(acc.socialSetId, await draftStats(tf, xv, acc, sinceMs));
  }
  // Levanta per-link revenue and clicks, clicks deduped per (day, link) — raw rows repeat a link's
  // clicks on every halo-ASIN row. A failed read throws: $0 revenue is a result, an unread one is not.
  const { byLink: lvByLink } = aggregateLevReports(await levanta(env).listReports({ start, end }));
  const byLink = new Map([...lvByLink].map(([id, g]) => [id, { clicks: g.clicks, conv: g.orders, commission: g.commission }]));

  // Per-thread join. A draft not in the published list (scheduled/unposted/deleted) has no audience
  // outcome — count it as pending, not as a zero-view post that would drag its cohort's averages down.
  const rows = []; let pending = 0;
  for (const e of entries) {
    const tf = tfBySet.get(accOf.get(e.account)?.socialSetId)?.get(String(e.draftId));
    let lvClicks = 0, conv = 0, commission = 0;
    for (const l of [e.link, e.link2]) { const m = byLink.get(lvIdOf(l)); if (m) { lvClicks += m.clicks; conv += m.conv; commission += m.commission; } }
    if (!tf) { pending++; if (!commission) continue; } // revenue on a draft not in the published list still counts
    rows.push({ mode: e.mode === 'skeleton' ? 'skeleton' : 'faithful', account: e.account, topic: e.topic || '?', skeletonId: e.skeletonId || null, hookScore: e.hookScore ?? null, sourceUrl: e.sourceUrl, views: tf?.views ?? null, clicks: lvClicks, conv, commission });
  }

  const line = (label, a) => `  <b>${label}</b> · ${a.posts} post(s) · ${fmtK(a.views)} views (med ${fmtK(a.medViews)}/post${a.unmeasured ? `, ${a.unmeasured} unmeasured` : ''}) · ${a.clicks} clicks · ${a.conv} conv · ${money(a.commission)} (${money(per1k(a))}/1k views)`;
  const skel = agg(rows.filter((r) => r.mode === 'skeleton'));
  const faith = agg(rows.filter((r) => r.mode === 'faithful'));

  // Per-skeleton lift -> learnings/skeleton-lift.json (the donor-reuse feedback signal).
  const bySkel = new Map();
  for (const r of rows.filter((r) => r.mode === 'skeleton' && r.skeletonId)) {
    const g = bySkel.get(r.skeletonId) || { skeletonId: r.skeletonId, sourceUrl: r.sourceUrl, posts: 0, measuredPosts: 0, views: 0, clicks: 0, conv: 0, commission: 0, measuredCommission: 0, topics: [], hookScores: [] };
    g.posts++; g.clicks += r.clicks; g.conv += r.conv; g.commission += r.commission;
    if (r.views != null) { g.measuredPosts++; g.views += r.views; g.measuredCommission += r.commission; }
    if (r.topic && !g.topics.includes(r.topic)) g.topics.push(r.topic);
    if (r.hookScore != null) g.hookScores.push(r.hookScore);
    bySkel.set(r.skeletonId, g);
  }
  const lift = [...bySkel.values()].map((g) => ({ ...g, viewsPerPost: g.measuredPosts ? Math.round(g.views / g.measuredPosts) : null, revPer1k: g.views ? +(g.measuredCommission / (g.views / 1000)).toFixed(3) : null, avgHookScore: g.hookScores.length ? Math.round(g.hookScores.reduce((s, x) => s + x, 0) / g.hookScores.length) : null, hookScores: undefined }))
    .sort((a, b) => (b.viewsPerPost ?? -1) - (a.viewsPerPost ?? -1));
  if (!DRY) {
    const dir = join(HERE_DIR, 'learnings');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skeleton-lift.json'), JSON.stringify({ ts: new Date().toISOString(), windowDays: WINDOW, skeletons: lift }, null, 1) + '\n');
  }

  // Per-topic rollup of the skeleton cohort — which variation TOPICS earn (feeds the operator's read on
  // the value-weighted rotation; the rotation itself reads learn.mjs's product-topic.json).
  const byTopic = new Map();
  for (const r of rows.filter((r) => r.mode === 'skeleton')) {
    const g = byTopic.get(r.topic) || { posts: 0, unmeasured: 0, views: 0, clicks: 0, commission: 0 };
    g.posts++; g.clicks += r.clicks; g.commission += r.commission; byTopic.set(r.topic, g);
    if (r.views == null) g.unmeasured++; else g.views += r.views; // views: measured posts only
  }

  const sections = [
    { label: 'COHORTS', body: [line('skeleton', skel), line('faithful', faith)].join('\n') + (skel.posts ? '' : '\n  <i>no posted skeleton threads in window yet — verdict pending (staged 2026-07-17)</i>') },
  ];
  if (byTopic.size) sections.push({ label: 'SKELETON TOPICS', body: [...byTopic.entries()].sort((a, b) => b[1].commission - a[1].commission || b[1].views - a[1].views).map(([t, g]) => `  ${esc(t)} · ${g.posts} post(s) · ${g.unmeasured === g.posts ? '?' : fmtK(g.views)} views${g.unmeasured ? ` (${g.unmeasured} unmeasured)` : ''} · ${g.clicks} clicks · ${money(g.commission)}`).join('\n') });
  if (lift.length) sections.push({ label: 'TOP SKELETONS (reuse candidates)', body: lift.slice(0, 5).map((g) => `  ${esc(g.skeletonId)} · ${g.posts} post(s) · ${g.viewsPerPost == null ? '?' : fmtK(g.viewsPerPost)} views/post · ${money(g.commission)}${g.avgHookScore != null ? ` · hook ${g.avgHookScore}` : ''}${g.sourceUrl ? ` · <a href="${g.sourceUrl}">form</a>` : ''}`).join('\n') });

  const verdict = skel.posts && faith.posts
    ? `skeleton ${fmtK(skel.medViews)} vs faithful ${fmtK(faith.medViews)} median views/post · ${money(per1k(skel))} vs ${money(per1k(faith))} rev/1k`
    : `${rows.length} joined thread(s) · skeleton cohort ${skel.posts ? 'live' : 'EMPTY'}`;
  const out = report({
    emoji: '🎭',
    title: 'Mode compare — skeleton vs faithful',
    scope: `${start} → ${end}${pending ? ` · ${pending} draft(s) not yet published` : ''}`,
    status: `${skel.posts ? '✅' : 'ℹ️'} ${verdict}`,
    sections,
    action: skel.posts ? 'Variation cohort is measured — winning skeletons/topics are in learnings/skeleton-lift.json.' : 'Cohort fills as variation-mode accounts post; re-run after a week of skeleton drafts.',
  });
  console.log(out.replace(/<[^>]+>/g, ''));
  logRun('mode-compare', { window: WINDOW, joined: rows.length, pending, skeleton: { ...skel, revPer1k: per1k(skel) == null ? null : +per1k(skel).toFixed(3) }, faithful: { ...faith, revPer1k: per1k(faith) == null ? null : +per1k(faith).toFixed(3) }, skeletons: lift.length });
  if (!DRY) { await telegram(env, out, 'performance'); console.log('\n✓ sent to performance topic + wrote learnings/skeleton-lift.json'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main, 'mode-compare'); // crash-alert wrapper (audit 2026-07-21): telegrams ops on the way down
