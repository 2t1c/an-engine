// brief.mjs — ☀️ THE Morning Brief. One message at 9am Saigon that answers the only four
// questions that matter, in order:
//   1. How much did we make yesterday — and is that good? (vs the 7-day average)
//   2. What's working right now? (top posts of the last 48h)
//   3. What did the machines already handle for me? (yesterday's run logs, plain English)
//   4. What actually needs ME today? (untracked posts, empty queue — or "nothing 🎉")
// Everything else in the group is drill-down detail; this message IS the business. The routine
// "✅ ran fine" reports (registry sync, QC all-clear, daily-winners idle) went quiet in the same
// change — this brief is their heartbeat now.
//   node brief.mjs --dry   # compose + print only, send nothing
import { isStandalonePost } from './monitoring-scope.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, telegram, report, esc, levanta, gumroad, typefully, HERE_DIR, dashBase, nextDay } from './lib.mjs';
import { needsYou as needsYouItems, renderTelegram, isFresh } from './needs-you.mjs';
import { measureRates, estimateEarnings } from './earn-estimate.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';

const DRY = process.argv.includes('--dry');
const money = (n) => '$' + (n || 0).toFixed(2);
const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n || 0));

// ---- Saigon calendar days (the whole business runs on Saigon time) ----
const ymdSaigon = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const daysAgo = (n) => ymdSaigon(new Date(Date.now() - n * 864e5));
const TODAY = daysAgo(0), YEST = daysAgo(1);
const PRIOR_START = daysAgo(8), PRIOR_END = daysAgo(2); // the 7 full days before yesterday

// Money for a date window: Levanta commission + Gumroad net — the same rails as revenue.mjs --daily.
// Gumroad's `before` is date-EXCLUSIVE (created_at < before 00:00, per Gumroad's own source), so the
// upper bound must be the day AFTER the window end — {after: YEST, before: YEST} is an EMPTY window.
// Levanta's start/end are inclusive (lib.mjs iso() expands end to 23:59:59).
// API failures are FLAGGED, never silently rendered as $0 — a fake "$0 slow day" is worse than no number.
async function moneyFor(env, start, end) {
  let commission = 0, orders = 0, failed = false;
  try {
    for (const r of await levanta(env).listReports({ start, end })) {
      commission += Number(r.commissionEarned) || 0;
      orders += Number(r.conversions) || 0;
    }
  } catch (e) { failed = true; console.warn(`levanta ${start}..${end}: ${e.message}`); }
  let gumNet = 0, gumCount = 0;
  if (env.GUMROAD_ACCESS_TOKEN) {
    try {
      for (const s of await gumroad(env).listSales({ after: start, before: nextDay(end) })) {
        gumNet += (s.price - (s.gumroad_fee || 0)) / 100;
        gumCount++;
      }
    } catch (e) { failed = true; console.warn(`gumroad ${start}..${end}: ${e.message}`); }
  }
  return { total: commission + gumNet, commission, gumNet, sales: orders + gumCount, failed };
}

// ON-TRACK EARNINGS (2026-09-11). The posts in this section are 0-48h old, and at that age the money
// column is a lie by omission: clicks land in minutes, Amazon reports conversions days later, and
// Levanta under-reports anything inside a 48-hour window. So the operator read "2.1M views · 340
// clicks" with no dollar figure at all, on exactly the posts they most want to judge that morning.
// earn-estimate.mjs fills it from measured history — clicks x EPC where clicks exist, a banded
// $/1k-view rate where they do not. Rendered as "~$152 est" and never as money earned; where the
// real figure has started landing it is shown beside it, not instead of it.
let _rates;
const earnRates = () => {
  if (_rates !== undefined) return _rates;
  try {
    const facts = readFileSync(join(HERE_DIR, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    _rates = measureRates(facts);
  } catch { _rates = null; }
  return _rates;
};

// Top posts of the last 48h from the content registry (what registry-sync maintains).
const NO_POSTS = { list: [], windowEst: 0, windowPosts: 0, epc: 0, basis: '' };
async function topPosts(env) {
  if (!env.REGISTRY_BASE_ID) return NO_POSTS;
  try {
    // Actually-POSTED rows only (IS_BEFORE NOW excludes future-dated scheduled cards that would
    // otherwise crowd the unsorted page), newest first so the 48h window can't fall off the page.
    //
    // Retrying read (2026-08-30). `if (!r.ok) return []` rendered a failed read as "quiet 48h — no
    // standout post yet", which is a claim about the fleet, not about the reader. The outer catch
    // still keeps a broken read from taking the brief down; it just no longer lies about why.
    const records = await airtable(env, env.REGISTRY_BASE_ID).list(REGISTRY_TABLE, {
      formula: `AND({Posted Date}, IS_AFTER({Posted Date}, DATEADD(NOW(), -2, 'days')), IS_BEFORE({Posted Date}, NOW()))`,
      sort: [{ field: 'Posted Date', direction: 'desc' }],
      // Lifetime/affiliate clicks, not `Link Clicks` (2026-09-02): this list is SORTED by clicks, so
      // the column decides which two posts the operator reads each morning. `Link Clicks` is
      // MAX(Typefully, Levanta) and Typefully counts every link in the thread, so a post with a busy
      // non-affiliate link outranked one that actually sold.
      fields: ['Type', 'Post', 'Account', 'Impressions', 'Lifetime Clicks', 'Affiliate Clicks', 'Lifetime Commission', 'Commission', 'X URL'], pageSize: 50,
    });
    const rates = earnRates();
    const all = records.filter(r => !isStandalonePost(r))
      .map((x) => ({ post: String(x.fields.Post || ''), acct: String(x.fields.Account || ''), views: x.fields.Impressions || 0, clicks: x.fields['Lifetime Clicks'] ?? x.fields['Affiliate Clicks'] ?? 0, comm: x.fields['Lifetime Commission'] ?? x.fields.Commission ?? 0, url: x.fields['X URL'] }))
      .filter((x) => x.views >= 1000)
      .map((x) => ({ ...x, est: estimateEarnings(x, rates) }));
    // The window total is summed over EVERY post in the 48h, not the two that get printed: the
    // question it answers is "what is last night's output worth", and the other nine posts are
    // most of the answer.
    const windowEst = all.reduce((a, x) => a + (x.est?.value || 0), 0);
    // Name the basis the estimates actually rest on. Clicks are the tighter signal (median error
    // 43% against 66%), so a window that is still all-views is a weaker read and should say so.
    const fromClicks = all.filter((x) => x.est?.basis === 'clicks').length;
    const fromViews = all.filter((x) => x.est?.basis === 'views').length;
    const basis = fromClicks && fromViews ? `${fromClicks} from clicks × $${(rates?.epc || 0).toFixed(2)} EPC, ${fromViews} from views (±40-65%)`
      : fromClicks ? `from clicks × $${(rates?.epc || 0).toFixed(2)} EPC (±40%)`
        : `from views alone — no clicks reported yet, so treat it as a ceiling (±65%)`;
    return {
      list: all.sort((a, b) => (b.clicks - a.clicks) || (b.views - a.views)).slice(0, 2),
      windowEst, windowPosts: all.length, epc: rates?.epc || 0, basis,
    };
  } catch (e) { console.warn(`⚠️ topPosts READ FAILED — the brief will say "quiet 48h", which is about the READER not the fleet: ${e.message}`); return NO_POSTS; }
}

// Yesterday's automation, translated from logs/*.json into plain English one-liners.
// Bucketed by the ranAt timestamp INSIDE each log (with the filename's date as fallback) — never by
// file mtime, which a fresh actions/checkout resets to "now" and would leave this section forever empty.
function handledYesterday() {
  const dir = join(HERE_DIR, 'logs');
  if (!existsSync(dir)) return [];
  const lines = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j; try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const fileDay = (f.match(/(\d{4}-\d{2}-\d{2})\.json$/) || [])[1];
    const ranDay = j.ranAt ? ymdSaigon(new Date(j.ranAt)) : fileDay;
    if (ranDay !== YEST) continue;
    if (f.startsWith('daily-')) lines.push(`🌅 Scheduled <b>${j.scheduled ?? '?'}</b> fresh-winner post(s) across ${j.accounts ?? '?'} account(s)`);
    else if (f.startsWith('weekly-') && j.account) lines.push(`🏭 ${esc(String(j.account))}: <b>${j.ok ?? '?'}</b>/${j.slots ?? '?'} curated post(s) generated`);
    else if (f.startsWith('registry-')) lines.push('🩺 Content registry synced — stats + revenue refreshed');
    else if (f.startsWith('learn-')) lines.push('🧠 Revenue learnings refreshed — feeds the product picker');
    else if (f.startsWith('sweep-')) lines.push(`🧹 Fleet sweep — <b>${j.critical ?? '?'}</b> critical · ${j.warn ?? '?'} warn across ${j.checks ?? '?'} check(s)`);
  }
  return lines.slice(0, 8);
}

// What genuinely needs a human decision.
//
// The DEFINITION now lives in needs-you.mjs, shared with the dashboard's ActionQueue. This function
// only supplies the inputs and renders the result — the two surfaces previously each decided for
// themselves what "needs you" meant, which is a disagreement waiting to happen and the kind you
// cannot spot, because you only ever look at one of them at a time.
// FLEET HEALTH (2026-08-30). These alarms — draft backlogs, hit-rate drift, monetization dark —
// used to ride registry-sync's Telegram heartbeat, where they fired on all six daily runs and never
// cleared, so the one channel that has to be able to say THE SYNC IS BROKEN was permanently red.
// They belong in the once-a-day read instead. NEW is marked separately from ONGOING: a standing
// alarm the operator has already seen should not shout as loudly as one that appeared overnight.
//
// Same freshness gate as every other queue file (needs-you's isFresh): a stale artifact left by a
// failed run must not raise yesterday's warning forever. Unreadable or stale -> no section at all,
// never a false all-clear.
function fleetHealth() {
  const read = (f) => { try { return JSON.parse(readFileSync(join(HERE_DIR, 'queues', f), 'utf8')); } catch { return null; } };
  const st = read('health-alarm-state.json');
  // Leak SLOs ride the same section: they are the same kind of news (something the fleet is doing,
  // not something the sync got wrong) and they are judged on duration and trend, so they belong
  // where the operator already reads about ongoing problems rather than in a channel of their own.
  const leak = read('leak-slo-state.json');
  const slo = isFresh(leak?.updatedAt) && Array.isArray(leak.breaches) ? leak.breaches : [];
  if ((!isFresh(st?.updatedAt) || !Array.isArray(st?.alarms) || !st.alarms.length) && !slo.length) return null;
  if (!isFresh(st?.updatedAt) || !Array.isArray(st?.alarms)) {
    return { label: '🩺 FLEET HEALTH', body: slo.map((b) => `• ⏳ ${esc(String(b).slice(0, 160))}`).join('\n') };
  }
  const fresh = st.alarms.filter((a) => a.isNew), ongoing = st.alarms.filter((a) => !a.isNew);
  const line = (a) => `• ${esc(String(a.text || '').split('→')[0].trim().slice(0, 150))}`;
  return {
    label: '🩺 FLEET HEALTH',
    body: [
      ...(fresh.length ? [`<b>NEW since yesterday</b>`, ...fresh.map(line)] : []),
      ...(ongoing.length ? [`<i>Ongoing (${ongoing.length})</i>`, ...ongoing.slice(0, 4).map(line)] : []),
      ...(ongoing.length > 4 ? [`<i>+${ongoing.length - 4} more</i>`] : []),
      ...(st.cleared?.length ? [`<i>✅ cleared: ${esc(st.cleared.join(', ').slice(0, 120))}</i>`] : []),
      ...(slo.length ? [`<b>SLO BREACHED</b>`, ...slo.map((b) => `• ⏳ ${esc(String(b).slice(0, 160))}`)] : []),
    ].join('\n'),
  };
}

function needsYou(lineupTotal) {
  // Unreadable queue file -> undefined -> NO item. Never an "all clear": a brief that cannot read
  // the stall queue must not therefore report that nothing is stalled.
  const readQueue = (name) => {
    try { return JSON.parse(readFileSync(join(HERE_DIR, 'queues', name), 'utf8')); }
    catch { return undefined; }
  };
  const items = needsYouItems({
    untracked: readQueue('untracked-followups.json'),
    stalled: readQueue('stalled-drafts.json'),
    unclaimed: readQueue('unclaimed-revenue.json'),
    runway: readQueue('donor-runway.json'),
    sweep: readQueue('sweep-findings.json'),
    lineupTotal,
    // staleAccounts is deliberately not supplied here: per-account sync recency is computed by the
    // dashboard's getHealth, and the brief has no equivalent. The shared definition accepts it so
    // both surfaces rank the same way when it IS available, rather than the brief inventing a
    // second, differently-ranked notion of the same problem.
  });
  // dashBase, not the raw variable: the operator pastes the URL from the browser bar, page path
  // and all — needs-you stays dependency-free, so normalization happens here at the seam.
  return renderTelegram(items, dashBase(process.env.DASHBOARD_URL));
}

// Today's lineup: scheduled drafts landing today, per monetized account. An API failure is UNKNOWN
// (total: -1 -> section and ZERO-posts alarm both suppressed), never "zero" — a Typefully outage
// must not fire a false "queue is empty" panic.
async function todayLineup(env) {
  let total = 0, attempted = 0, failedAccts = 0; const per = [];
  if (!env.TYPEFULLY_API_KEY) return { total: -1, per };
  const tf = typefully(env);
  for (const a of Object.values(ACCOUNTS)) {
    if (!a.plugHeavyExample) continue; // lightweight/client accounts aren't part of the daily veto flow
    attempted++;
    try {
      let n = 0;
      const drafts = await tf.listAll(`/social-sets/${a.socialSetId}/drafts?status=scheduled`);
      for (const d of drafts) if (d.scheduled_date && ymdSaigon(new Date(d.scheduled_date)) === TODAY) n++;
      if (n) { total += n; per.push(`${a.name} ${n}`); }
    } catch (e) { failedAccts++; console.warn(`lineup ${a.name}: ${e.message}`); }
  }
  if (attempted > 0 && failedAccts === attempted) return { total: -1, per: [] }; // all reads failed -> unknown, not zero
  return { total, per };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'LEVANTA_API_KEY']);

  const [yest, prior, top, lineup] = await Promise.all([
    moneyFor(env, YEST, YEST),
    moneyFor(env, PRIOR_START, PRIOR_END),
    topPosts(env),
    todayLineup(env),
  ]);
  const handled = handledYesterday();
  const needs = needsYou(lineup.total);

  // Trend vs the 7-day average — the "is that good?" that raw totals never answer. Suppressed when
  // either window's fetch failed: a fabricated "▼ -100% slow day" during an API outage is worse than
  // no verdict at all.
  const avg = prior.total / 7;
  const pct = !yest.failed && !prior.failed && avg >= 0.5 ? Math.round(((yest.total - avg) / avg) * 100) : null;
  const arrow = pct == null ? '' : pct >= 5 ? ` ▲ +${pct}% vs 7-day avg` : pct <= -5 ? ` ▼ ${pct}% vs 7-day avg` : ' • flat vs 7-day avg';
  const verdict = pct == null ? '' : pct >= 30 ? ' — strong day' : pct <= -40 ? ' — slow day' : '';
  const moneyLine = yest.failed
    ? `⚠️ revenue source unreachable — see Daily Sales for the real number`
    : `💰 <b>${money(yest.total)}</b> yesterday${arrow}${verdict} · ${yest.sales} sale(s)`;

  const sections = [
    {
      label: '🏆 WORKING',
      body: top.list.length
        ? [
          ...top.list.map((t) => `• <b>${esc(t.acct)}</b> — ${esc(t.post.slice(0, 48))}\n   ${fmtK(t.views)} views · ${t.clicks} clicks${t.est ? ` · <b>~$${Math.round(t.est.value)}</b> est` : ''}${t.comm ? ` · ${money(t.comm)} booked` : ''}${t.url ? ` · <a href="${t.url}">view</a>` : ''}`),
          // The estimate is a CENTRAL TENDENCY across a skewed distribution (two thirds of posts
          // earn nothing), carrying a median error near 43% from clicks and 66% from views. Saying
          // so in one line is what keeps it a planning number rather than one someone later quotes
          // as revenue — and the line names the basis it ACTUALLY used, because a footer claiming
          // "clicks × EPC" over a window where every post still reads 0 clicks is its own small lie.
          ...(top.windowEst > 0 ? [`<i>All ${top.windowPosts} post(s) in 48h: ~$${Math.round(top.windowEst)} on track, ${top.basis}. The money itself lands over the next few days.</i>`] : []),
        ].join('\n')
        : '<i>Quiet 48h — no standout post yet.</i>',
    },
    ...(lineup.total > 0 ? [{ label: '🗓 TODAY', body: `${lineup.total} post(s) go live (${lineup.per.join(' · ')}) — veto window open until the 6pm slot.` }] : []),
    // One line, not a log dump: the operator checks this topic for the BIG PICTURE, and run
    // detail already lives in the machine-room topic for the rare day it matters.
    { label: '🤖 MACHINES', body: handled.length ? `<i>${handled.length} run(s) finished clean yesterday.</i>` : '<i>No automation runs logged.</i>' },
    ...(fleetHealth() ? [fleetHealth()] : []),
    { label: '👉 NEEDS YOU', body: needs.length ? needs.join('\n') : 'Nothing — all handled 🎉' },
  ];

  const out = report({
    emoji: '☀️', title: 'Morning Brief', scope: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date()),
    status: moneyLine,
    sections,
    action: needs.length ? 'Handle the NEEDS YOU item(s) — everything else is done.' : 'No action needed today.',
  });

  console.log(out.replace(/<[^>]+>/g, ''));
  if (!DRY) { await telegram(env, out, 'brief'); console.log('\n✓ Morning Brief sent'); }
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
