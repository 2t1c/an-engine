// registry-sync.mjs — the content registry. Typefully is the spine: every draft/post
// for each account becomes one row in Airtable "Published Content", joined to:
//   - ledger.jsonl  -> source thread, product, subid, type (recreations)
//   - X's own counts (twitter241, x-views.mjs) -> impressions (X views), likes, bookmarks, for posts
//     published in the last VIEWS_DAYS. Until 2026-09-30 these, plus engagement and link clicks, came
//     from Typefully's /analytics/x/posts, which answers 404 since — see readAccountViews.
//   - Levanta v1 reports (by minted link id) + Gumroad sales (by ?ref subid) -> commission, sales, orders, EPC
// Status is LIFECYCLE ONLY (Draft/Scheduled/Posted/Reposted) — the old Winner/Repost Candidate
// auto-flags retired 2026-09-02 with the farm (gate truth lives on the Harvests table). Upsert
// keyed by Draft ID (idempotent).
//   node registry-sync.mjs              # sync all accounts -> Airtable
//   node registry-sync.mjs --dry        # compute + print, no writes
//   node registry-sync.mjs --since 2026-05-01
//   node registry-sync.mjs --full       # rewrite every row, ignoring the unchanged-row hashes
//   node registry-sync.mjs --views-days 60   # widen the X views window for one run (default 21 with --full, else 3)
//   node registry-sync.mjs --allow-invariant-breach   # override the pre-write abort — ONLY when a
//     deliberate laws.json threshold change is what moved the numbers (the 2026-08-25 class, where
//     winners legitimately went 160 -> 17). Never in the workflow; never to get past a red run.
// Env: AIRTABLE_PAT, XDB_BASE_ID, TYPEFULLY_API_KEY, LEVANTA_API_KEY, GUMROAD_ACCESS_TOKEN, RAPIDAPI_KEY
//   (GUMROAD_ACCESS_TOKEN is OPTIONAL since 2026-11-02, owner: "Gumroad optional". Without it the
//   Gumroad fetch is skipped and every row that earns through a Gumroad ?ref is HELD — not written —
//   so its stored commission is never overwritten with 0. The run says how many it held.)
//   (RAPIDAPI_KEY: follower counts and view counts from X. Missing: rows still sync, views and
//   Account Metrics are left unwritten — never 0 — and the run says so)
import { isStandalonePost, isArticleDraft, monitoredPreviousCount, hasThreadEvidence, classifyMonitoringDrafts, standaloneRecordUpdates, registryMonitoringCandidate } from './monitoring-scope.mjs';
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, typefully, levanta, gumroad, telegram, esc, report, logRun, opsLog, HERE_DIR, lvIdOf, nextDay, aggregateLevReports, loadLedger, resolveClaimants } from './lib.mjs';
import { laneLabel, laneOf, ARTICLE_LANE } from './lanes.mjs';
import { checkRegistrySchema } from './airtable-schema.mjs';
import { mergeLevDays, lifetimeByLink, LEV_DAYS_FILE } from './lev-days.mjs';
import { LAWS } from './laws.mjs';
import { accountHealth } from './checks.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { tweetSeries, plugFunnel, plugTweetIndices, redirectSurvival } from './metrics.mjs';
import { xFollowers, historyByAccount, followerRow, doubtfulCount } from './x-followers.mjs'; // follower counts from X (Typefully's follower series is gone)
import { xViews, publishedAtOf, statusIdOf } from './x-views.mjs';
import { indexLinksByPlatform } from './platform-clicks.mjs'; // platform of a minted link — the ledger's own stamp
import { inspectRegistryQuality, renderQualityMarkdown } from './registry-quality.mjs';
import { planRegistryReconciliation, executeRegistryReconciliation } from './registry-reconcile.mjs';
import { buildLevantaIndex, saveLevantaCatalog } from './link-resolve.mjs'; // the ASIN behind a plug link, cached for republish

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NOTIFY = !args.includes('--no-notify');
const runQuality = { status: 'running', runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  startedAt: new Date().toISOString(), stages: [], warnings: [] };
// A FAILED STAGE SAYS WHY (2026-10-03). `failed(name)` used to record details: '' — so the runs
// that skipped every account on Typefully's 404 left 27 identical "account-read: failed" lines in
// logs/registry-latest.json and no reason anywhere but the Actions log. The error text is kept now,
// whitespace-collapsed, capped, and with anything credential-shaped (an env secret's value, a
// Bearer header, a key= query param, a long opaque token) redacted. The Markdown summary still
// never interpolates it (renderQualityMarkdown); this is the JSON record only.
export function stageDetail(error, secrets = []) {
  if (error == null || error === '') return '';
  let s = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
  for (const v of secrets) if (typeof v === 'string' && v.length >= 8) s = s.split(v).join('[redacted]');
  s = s.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/([?&](?:access_token|api[_-]?key|key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_\-.]{40,}/g, '[redacted]');
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}
const SECRET_VALUES = Object.entries(process.env).filter(([k, v]) => /(KEY|TOKEN|SECRET|PASSWORD)$|_PAT$/.test(k) && v && v.length >= 8).map(([, v]) => v);
const stage = (name, status, details = '') => runQuality.stages.push({ name, status, details: stageDetail(details, SECRET_VALUES) });
const failed = (name, error = '') => stage(name, 'failed', error);
function persistQuality(error = null) {
  if (DRY) return;
  runQuality.completedAt = new Date().toISOString();
  runQuality.status = error || runQuality.stages.some(s => s.status === 'failed') || runQuality.audit?.hardFailure
    ? 'failed' : (runQuality.warnings.length || runQuality.audit?.warnings?.length ? 'degraded' : 'completed');
  if (error) {
    runQuality.error = 'Registry sync did not complete; inspect the failed stage in the run log.';
    runQuality.errorDetail = stageDetail(error, SECRET_VALUES); // what stopped the run (2026-10-03: it was nowhere)
  }
  mkdirSync(join(HERE_DIR, 'logs'), { recursive: true });
  writeFileSync(join(HERE_DIR, 'logs', 'registry-latest.json'), JSON.stringify(runQuality, null, 2) + '\n');
  const markdown = renderQualityMarkdown(runQuality);
  writeFileSync(join(HERE_DIR, 'logs', 'registry-latest.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const TABLE = REGISTRY_TABLE;
// The Winner/Repost Candidate thresholds (laws.json scale.winClicks/winRevenue) are no longer read
// here: Status stopped encoding performance on 2026-09-02. What replaced them is the farm gate
// (laws.json farm.*, refereed by harvest-gate.mjs against the Harvests table) — this file's job is
// the SENSOR side only: fresh, correct lifetime figures per row.
const STALL_DAYS = 2;        // an engine draft with nothing scheduled to publish it for this long is stalled
const FOLLOWER_LOOKBACK_DAYS = 9; // Account Metrics rows read per run: today's 7d delta needs the row from exactly 7 days back
// X views are read for posts published in the last VIEWS_DAYS: their numbers still move, and the farm
// gate's 48h verdicts and the weekly metrics read them. An older row keeps its last value (the
// Typefully reading as of 2026-09-30, or an earlier X reading). ~1 RapidAPI search page per 20 tweets
// per account per run, plus one lookup per post the search misses. --views-days widens one run.
// THE QUOTA (2026-10-03): the fleet's RapidAPI plan is already at its sustainable daily rate (Fuel the
// Fire reads every live post hourly), and running it dry reads every view as 0 and stops all Fuel
// buying. So the 21-day window runs once a day (the 06:00 UTC --full run); the other runs read the
// last 3 days, which is all the farm gate's 48h verdicts need: about 27 search pages a run, not ~190.
const VIEWS_DAYS = Number(flag('views-days', args.includes('--full') ? 21 : 3));
const ACCOUNT_METRICS_TABLE = 'Account Metrics'; // REGISTRY_BASE_ID, by name like Ops Log
const isoDay = (d) => d.toISOString().slice(0, 10);
const r4 = (x) => (x == null ? undefined : Math.round(x * 1e4) / 1e4); // percent fields carry fractions; 4dp keeps the JSON payload clean

// Ledger loading lives in lib.mjs (parseLedger/loadLedger) — this file's version was lifted
// there verbatim on 2026-08-24 so revenue/reconcile/diagnose read the SAME maps.

// Every Airtable call in this file now goes through lib's airtable() client, which retries 429/5xx
// with backoff and THROWS rather than returning what it managed to read. Before 2026-08-30 they were
// bare fetches: the four paginated reads did `if (!r.ok) break`, and the upsert had no retry at all.
const registryAt = (env) => airtable(env, env.REGISTRY_BASE_ID);

// Draft id -> lane, from queues/threads records (publish-thread / the writing skills stamp
// thread.contentLane there). The LEDGER predates lanes and carries no lane at all, so without this
// every engine draft was labelled 'Recreation' — including the six harvests and seven seeds, whose
// whole point is that they are NOT recreations of someone else's thread. laneOf (inside laneLabel)
// maps the historical spellings (swipe/viral/mold/repost) forward on read, per lanes.mjs.
export function loadThreadLanes(dir = join(HERE_DIR, 'queues', 'threads')) {
  const lanes = new Map();
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return lanes; }
  for (const f of files) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8'))?.thread;
      if (t?.draftId && t?.contentLane) lanes.set(String(t.draftId), String(t.contentLane));
    } catch { /* one unreadable record must not hide the rest */ }
  }
  return lanes;
}
const airtableUpsertTable = (env, table, mergeOn, rows) => registryAt(env).upsert(table, mergeOn, rows);
const airtableUpsert = (env, rows) => airtableUpsertTable(env, TABLE, 'Draft ID', rows);

// Daily follower snapshot -> Account Metrics (one row per day per account, idempotent upsert on
// Key). Source since 2026-10-03: X itself, through twitter241 (x-followers.mjs). Typefully's
// /analytics/x/followers — a daily series this used to re-write a week of — answers 404, and X gives
// only the CURRENT count. So each run writes TODAY's row (the 4h cadence converges it to the day's last
// read), and the deltas are looked up by exact date in the rows the table already holds: a missing day
// gives a blank delta, never a wrong subtraction. A count that was not read writes no row — never a 0.
// The follow is the ranker's highest-leverage compounding action (weight 4.0; every follower escapes
// the 0.75 out-of-network discount). Paused pages stay included — their series continuity is the point.
// Cost: one RapidAPI request per page per run, plus any 429/5xx retry (the run log prints the count).
// Exported with its I/O injectable (tests/x-followers.test.mjs drives it offline).
export async function syncFollowers(env, { accounts = Object.values(ACCOUNTS), xf = xFollowers(env), at = registryAt(env), now = Date.now() } = {}) {
  const pages = accounts.filter((acc) => !acc.external && acc.socialSetId);
  if (!xf.available) return { rows: 0, failed: pages.map((acc) => acc.name), noSource: true, calls: 0 };
  const today = isoDay(new Date(now));
  // The history every delta is looked up in. A failed read THROWS: the caller writes nothing rather
  // than compute a delta against rows it did not see.
  const since = isoDay(new Date(now - FOLLOWER_LOOKBACK_DAYS * 864e5));
  const history = historyByAccount(await at.listAll(ACCOUNT_METRICS_TABLE, { fields: ['Account', 'Date', 'Followers'], formula: `IS_AFTER({Date}, "${since}")` }));
  const rows = []; const failed = [];
  for (const acc of pages) {
    const r = await xf.read(acc.xHandle || acc.handle);
    let past = history.get(acc.name) || [];
    // A 0 with no earlier row in the window is judged against the page's whole record: after a long
    // gap, a degraded 0 must not pass because the established count it contradicts is old.
    if (r.followers === 0 && !past.some((h) => h.date < today)) {
      try { past = [...past, ...(historyByAccount(await at.listAll(ACCOUNT_METRICS_TABLE, { fields: ['Account', 'Date', 'Followers'], formula: `{Account} = "${acc.name.replace(/"/g, '\\"')}"` })).get(acc.name) || [])]; }
      catch (e) { failed.push(acc.name); console.warn(`  followers ${acc.name}: X says 0 and its earlier rows could not be read (${e.message}) — no row written`); continue; }
    }
    const why = r.followers == null ? r.error : doubtfulCount(r.followers, past, today);
    if (why) { failed.push(acc.name); console.warn(`  followers ${acc.name} (@${acc.xHandle || acc.handle || '?'}): ${why} — no row written`); continue; }
    rows.push(followerRow({ account: acc.name, date: today, followers: r.followers, history: past }));
  }
  if (rows.length) await at.upsert(ACCOUNT_METRICS_TABLE, 'Key', rows);
  return { rows: rows.length, failed, calls: xf.calls };
}

// Fuel the Fire writes these tables (same PI base). We denormalize their spend onto
// Published Content + backfill Post links here, because PC lags the live fuel candidates
// by ~a day — so the link can only resolve once PC has caught up. (Fix for PR #10 review.)
const FUEL_LOG = 'tblNSMxxTggWNndI7', GROWTH_LOG = 'tblh6tv1dzZxh1Apn', BOOST_EVENTS = 'tblptuzRPLTAYhbxq';
const tweetId = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || '';

async function loadFuelLog(env) {
  // tweetId -> { spend, tiers, reach } for denormalizing onto Published Content
  const map = new Map();
  for (const rec of await registryAt(env).listAll(FUEL_LOG)) {
    const k = tweetId(rec.fields['X URL']); if (!k) continue;
    // Per-vendor detail for the FACTS layer: fire count + distinct vendor names, parsed from the
    // shared Tier Breakdown ledger lines ("T1 · Pammy · $12.00 · 380000 reach · <ts>").
    const lines = String(rec.fields['Tier Breakdown'] || '').split('\n').map((l) => l.match(/^(?:T\d+(?:\+T\d+)*|T\?)\s*·\s*(.*?)\s*·\s*\$/)).filter(Boolean);
    const vendors = [...new Set(lines.flatMap((m) => m[1].split(', ').filter(Boolean)))];
    map.set(k, { spend: rec.fields['Total Spend'] || 0, tiers: rec.fields['Tiers Used'] || '', reach: rec.fields['Reach'] || 0, vendors: vendors.join(', '), fires: lines.length });
  }
  return map;
}

async function reconcileLinks(env) {
  // After PC is synced, attach Fuel Log / Growth Log rows to their now-present PC card by tweet id.
  const at = registryAt(env);
  const pc = new Map();
  for (const rec of await at.listAll(TABLE, { fields: ['X URL', 'Type', 'Post'] })) { if (isStandalonePost(rec)) continue; const k = tweetId(rec.fields['X URL']); if (k) pc.set(k, rec.id); }
  if (!pc.size) return { fuel: 0, growth: 0, boost: 0 };
  const patchLinks = async (table, filterFormula) => {
    const updates = [];
    for (const rec of await at.listAll(table, filterFormula ? { formula: filterFormula } : {})) {
      if (rec.fields['Post'] && rec.fields['Post'].length) continue; // already linked
      const pid = pc.get(tweetId(rec.fields['X URL'])); if (pid) updates.push({ id: rec.id, fields: { Post: [pid] } });
    }
    await at.update(table, updates);
    return updates.length;
  };
  const since14 = isoDay(new Date(Date.now() - 14 * 864e5));
  const since45 = isoDay(new Date(Date.now() - 45 * 864e5));
  // Growth Log is the one high-volume table here (~14k rows), so the scan has to be narrowed — but
  // narrowing it by DATE ALONE silently strands rows forever: the window is anchored to when the
  // snapshot was taken, while the link only becomes possible once Published Content catches up. Any
  // post whose PC row lands after the window closes never gets linked, and nothing retries it.
  // Audit 2026-08-17 found 267 such rows (13 posts, 2026-06-29→07-07) permanently orphaned this way.
  // So: filter on {Post} = BLANK() (the rows that actually need work), widen the window to 45 days,
  // and restrict to handles the engine owns. Rows for the manual/organic accounts (GeniusGTX, Toan —
  // Fuel Watch only, no Engine Key, so they never get a Published Content row) are unlinkable BY
  // DESIGN and made up 6,278 of the 6,545 unlinked rows; excluding them keeps the scan small enough
  // that the wider window costs nothing.
  const handles = Object.values(ACCOUNTS).map((a) => a.handle).filter(Boolean);
  const mine = `OR(${handles.map((h) => `{Account}='${h}'`).join(',')})`;
  // Growth Log moved to its own base on 2026-11-25: a link can't cross bases, so it is no longer linked
  // (its readers match by {X URL}). `mine`/`since45` still scope the other tables below.
  const growth = 0; void mine;
  const fuel = await patchLinks(FUEL_LOG, null);                               // small (one row per fueled post)
  // Boost Events ALWAYS lands unlinked: the RT Bridge writes the row within a second of the tweet
  // publishing, but Published Content is created by this sync on its own schedule, so the node's
  // FIND("<tid>", {X URL}) lookup has nothing to match yet. Verified live 2026-08-15: the first two
  // rows (23:04, 23:05) found no post row because the previous sync ran at 20:31. The row is correct
  // in every other respect, so the link is simply reconciled here on the next pass — same pattern,
  // same bounded window, as Growth Log.
  const boost = await patchLinks(BOOST_EVENTS, `IS_AFTER({Sent At}, "${since14}")`);
  return { fuel, growth, boost };
}

// Identity of a fleet-health alarm, for telling a NEW alarm from one the operator already saw.
// Keys on account + KIND, never the sentence: the text carries live numbers ("21 unposted draft(s)",
// "postedRate 0.841") that move every run, so keying on the text would mark every alarm new forever
// and rebuild exactly the always-red channel this replaces. Fleet-wide alarms have no account
// prefix, so they key on the kind alone rather than colliding under a shared bucket.
export function healthAlarmKey(m) {
  const s = String(m ?? '');
  const kind = /backlog rotting/.test(s) ? 'staleDrafts'
    : /publishing stall/.test(s) ? 'stall'
    : /monetization dark/.test(s) ? 'zeroRevenue'
    : /attribution dark/.test(s) ? 'attributionDark'
    : /fleet draft backlog/.test(s) ? 'fleetBacklog'
    : 'other';
  // The two fleet alarms are not "<account>: ..." sentences; anything before a colon on those is
  // prose, not a name.
  if (kind === 'attributionDark' || kind === 'fleetBacklog') return `fleet·${kind}`;
  const who = s.includes(':') ? s.split(':')[0].trim() : 'fleet';
  return `${who}·${kind}`;
}

// PRE-WRITE INVARIANTS. Pure. Things that can only mean a bug, checked against the registry's own
// current contents before a single row is written.
//
// Every corruption this file documents was caught by a human reading rows weeks or months after the
// fact. Each of these would have caught one within minutes:
//   - lifetime commission dropping -> the 59-day-window decay, and any join that silently breaks
//   - lifetime CLICKS dropping     -> the claimant regression (24 published posts fell to $0) from
//     the clicks side. This check replaced the "post lost Winner status" breach in the SAME commit
//     that retired the Winner status (2026-09-02): that breach only ever fired when a join loss
//     dragged a row below the winner bar, so guarding both monotonic money figures directly covers
//     the same class without needing Status to encode performance.
//   - the row count collapsing     -> a truncated read reaching the write path
//
// Lifetime figures are monotonic BY CONSTRUCTION: levanta-days.jsonl freezes out-of-window days, so
// a decrease is not "sales aged out", it is the join losing keys. A small epsilon absorbs genuine
// Levanta reversals (a refunded order) without absorbing a structural loss.
//
// EXCEPT a refund bigger than the epsilon (2026-08-31: draft 10382342, $12.71 -> $5.23, one $7.48
// order returned). That single row froze EVERY row's writes for seven straight runs — the registry
// sat 31h stale while the guard re-sent the same ⛔ twice a cluster. The discriminator the guard was
// missing is WHERE the decrease originated, and `lifetimeBefore` supplies it: the same join computed
// over YESTERDAY'S day-file. If yesterday's file still reproduces Airtable's number (join intact)
// and today's fresh Levanta read is what lowered it, Levanta is being authoritative about its own
// money — a reversal. Recorded into `reversalsOut` and written as the new truth, never silently: the
// caller logs each one to the Ops Log. If yesterday's file does NOT reproduce Airtable's number, the
// JOIN moved — the 24-winners-to-$0 class — and the hard abort stands. A run with more than
// `maxReversalRows` reversals aborts too: refunds arrive one customer at a time; a batch reads as
// upstream data loss.
export function checkInvariants(rows, lifetimeRows, existing, { maxRowDropPct = 2, epsilon = 1, clickEpsilon = 5, prevBuiltCount = null, lifetimeBefore = null, clicksBefore = null, maxReversalRows = 5, maxRefundPct = 0.15, reversalsOut = null } = {}) {
  const breaches = [];
  // COMPARE LIKE WITH LIKE. This first compared against existing.size — the number of rows Airtable
  // HOLDS — which is a different population from the number this run BUILDS, and always larger:
  // the upsert never deletes, so a draft deleted in Typefully, an account since removed, or a row
  // older than the analytics window all linger in the table forever. Measured against the live base
  // on 2026-08-30: Published Content held 958 rows while the last run built 674, so the check read a
  // 29.6% "drop" and would have hard-aborted the sync on its very first run after this branch.
  //
  // The meaningful comparison is run-over-run: this run's built count against the previous run's,
  // which queues/registry-row-hashes.json already persists (and only after a successful write). Null
  // on a first run, where there is nothing to regress from.
  if (prevBuiltCount != null && prevBuiltCount > 0) {
    const dropPct = ((prevBuiltCount - rows.length) / prevBuiltCount) * 100;
    if (dropPct > maxRowDropPct) breaches.push(`built ${dropPct.toFixed(1)}% fewer rows than the last run (${prevBuiltCount} -> ${rows.length}) — a read that came back short must never reach the write`);
  }
  // Both lifetime money figures get the same guard: a drop is a join loss (abort) unless
  // yesterday's day-file join still reproduces the stored number AND today's fresh read is what
  // lowered it — then the platform is being authoritative about its own data (a refund on the
  // commission side; a click revision, rare but Levanta's call, on the clicks side) and the drop
  // is absorbed as a recorded reversal. Clicks use a wider epsilon than dollars: integer counters
  // that jitter by a click or two on re-reads must not read as corruption.
  const shrunk = [];
  const clickDrops = [];
  const reversals = [];
  for (const lr of lifetimeRows) {
    const prev = existing.get(String(lr['Draft ID']));
    const before = prev?.lifetimeCommission;
    const now = lr['Lifetime Commission'];
    if (before != null && now < before - epsilon) {
      const prevJoin = lifetimeBefore?.get?.(String(lr['Draft ID']));
      // A PARTIAL drop (still above zero, within maxRefundPct of the stored figure) is a refund's
      // shape even when yesterday's day-file already shows it: a reversal that landed on a day the
      // run aborted for another reason (row drop) was never absorbed, and from the next day on the
      // day-file no longer reproduced the stored number, so the same three refunds ($6.20, $8.38,
      // $2.99) hard-aborted registry-sync every day from 2026-11-08. A join loss takes a thread's
      // money to $0 or most of it away (the 24-winners-to-$0 class) — that still aborts.
      const partialRefund = now > 0 && (before - now) <= before * maxRefundPct;
      if ((prevJoin != null && Math.abs(prevJoin - before) <= epsilon && now < prevJoin) || partialRefund) {
        reversals.push({ draftId: String(lr['Draft ID']), kind: 'commission', before, after: now });
      } else shrunk.push(`${lr['Draft ID']} ($${before} -> $${now})`);
    }
    const cBefore = prev?.lifetimeClicks;
    const cNow = lr['Lifetime Clicks'];
    if (cBefore != null && cNow != null && cNow < cBefore - clickEpsilon) {
      const cPrevJoin = clicksBefore?.get?.(String(lr['Draft ID']));
      if (cPrevJoin != null && Math.abs(cPrevJoin - cBefore) <= clickEpsilon && cNow < cPrevJoin) {
        reversals.push({ draftId: String(lr['Draft ID']), kind: 'clicks', before: cBefore, after: cNow });
      } else clickDrops.push(`${lr['Draft ID']} (${cBefore} -> ${cNow} clicks)`);
    }
  }
  if (shrunk.length) breaches.push(`${shrunk.length} row(s) LOST lifetime commission: ${shrunk.slice(0, 5).join(', ')}${shrunk.length > 5 ? ` +${shrunk.length - 5} more` : ''}`);
  if (clickDrops.length) breaches.push(`${clickDrops.length} row(s) LOST lifetime clicks: ${clickDrops.slice(0, 5).join(', ')}${clickDrops.length > 5 ? ` +${clickDrops.length - 5} more` : ''} — clicks are monotonic by construction; a decrease means the link join lost keys`);
  if (reversals.length > maxReversalRows) {
    breaches.push(`${reversals.length} Levanta reversals in ONE run (cap ${maxReversalRows}): ${reversals.slice(0, 3).map((r) => `${r.draftId} (${r.kind} ${r.before} -> ${r.after})`).join(', ')}… — refunds arrive one customer at a time; a batch this size reads as upstream data loss`);
  } else if (reversalsOut) reversalsOut.push(...reversals);
  return breaches;
}

// Identity of a row's CONTENT, for skipping writes that would change nothing. Airtable's upsert is
// idempotent on Draft ID, so not sending an unchanged row is invisible to the table.
//
// 'Last Synced' is deliberately excluded. It is new Date().toISOString() on every row on every run,
// so including it would make every payload differ every time and detect nothing — the whole feature
// would silently no-op.
//
// The undefined/null distinction is LOAD-BEARING and must survive hashing. buildRow uses them to
// mean different things: `'Scheduled For': d.scheduled_date || null` sends null to CLEAR a stale
// slot, while the frozen plug-funnel keys are OMITTED so a value computed while the post was young
// survives untouched. JSON.stringify drops undefined keys and keeps null, which is exactly the
// distinction we want — but only if key ORDER is stable, so sort them.
export function rowHash(row) {
  const stable = {};
  for (const k of Object.keys(row).sort()) { if (k !== 'Last Synced') stable[k] = row[k]; }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/**
 * Split rows into what must be written and what can be skipped.
 *
 * A stored hash says "Airtable already holds this exact content" — which is only true if the write
 * that set it succeeded, so hashes are persisted AFTER a successful write, never before. Drift is
 * still possible (a hand edit in the Airtable UI), so this falls back to writing EVERYTHING when the
 * stored map is missing or stale: no row goes more than FULL_WRITE_HOURS without being rewritten
 * from source, which bounds how long a hand edit can linger to well under a day.
 */
export function selectChangedRows(rows, stored, { fullWriteHours = 20, now = Date.now(), force = false } = {}) {
  // Delta writes must not postpone the full reconciliation indefinitely.
  const ageMs = stored?.fullWrittenAt ? now - Date.parse(stored.fullWrittenAt) : Infinity;
  const full = force || !stored?.hashes || !Number.isFinite(ageMs) || ageMs > fullWriteHours * 3600e3;
  const hashes = {};
  for (const r of rows) hashes[String(r['Draft ID'])] = rowHash(r);
  if (full) return { write: rows, skipped: 0, full: true, reason: force ? 'forced' : (stored?.hashes ? 'stale' : 'no prior hashes'), hashes };
  const write = rows.filter((r) => stored.hashes[String(r['Draft ID'])] !== hashes[String(r['Draft ID'])]);
  return { write, skipped: rows.length - write.length, full: false, reason: 'delta', hashes };
}

// ---- LEAK SLOs ---------------------------------------------------------------------------------
// untracked, stalled and manualPublished are durable worklists — the right shape — but nothing owned
// draining them, so they only ever grew: manualPublished went 36 -> 60 in eleven days, stalled has
// held 39-48 for a fortnight, untracked bounces 0-9 and back. Reporting a LEVEL every run taught the
// operator to scroll past it, which is the same failure as the always-red heartbeat.
//
// So judge them on the two things a level cannot express: how LONG a leak has been open, and whether
// it is getting WORSE. A count that is high but shrinking needs no alarm; a small one that has been
// open four days does.
export const LEAK_SLOS = {
  untrackedMaxHours: 24,   // an attribution leak is money publishing untracked — same-day or it is a breach
  stalledMaxDays: 14,      // a finished, monetized, link-minted thread idle a fortnight is inventory rotting
  manualGrowthRuns: 3,     // three consecutive runs of growth is a trend, not noise
  historyCap: 24,          // ~4 days at six runs a day
};

/**
 * Pure. Returns the breaches plus the history to persist. `now` is injected so this is testable.
 */
export function evaluateLeakSlos(counts, prevHistory = [], { now = Date.now(), slos = LEAK_SLOS } = {}) {
  const history = [...(Array.isArray(prevHistory) ? prevHistory : []),
    { at: new Date(now).toISOString(), untracked: counts.untracked, stalled: counts.stalled, manualPublished: counts.manualPublished }
  ].slice(-slos.historyCap);
  const breaches = [];

  // How long has untracked been continuously non-zero? Walk back to the last observation that was 0.
  if (counts.untracked > 0) {
    let openSince = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].untracked > 0) openSince = history[i].at; else break;
    }
    const hours = openSince ? (now - Date.parse(openSince)) / 3600e3 : 0;
    if (hours > slos.untrackedMaxHours) breaches.push(`${counts.untracked} untracked post(s) have been unresolved for ${Math.round(hours)}h (SLO ${slos.untrackedMaxHours}h) — posts are publishing with no attribution`);
  }

  // Oldest stalled draft, from the worklist's own per-draft age.
  const oldest = counts.oldestStalledDays || 0;
  if (oldest > slos.stalledMaxDays) breaches.push(`a finished, monetized thread has sat unscheduled for ${Math.round(oldest)}d (SLO ${slos.stalledMaxDays}d) — ${counts.stalled} stalled in total`);

  // manualPublished only ever climbs; alarm on a sustained climb, not on the level.
  const tail = history.slice(-(slos.manualGrowthRuns + 1)).map((h) => h.manualPublished);
  if (tail.length === slos.manualGrowthRuns + 1 && tail.every((v, i) => i === 0 || v > tail[i - 1])) {
    breaches.push(`posts published outside the workflow grew ${slos.manualGrowthRuns} runs running (${tail.join(' → ')}) — the registry is falling behind the fleet`);
  }
  return { breaches, history };
}

// Which fleet-health alarms are NEW, which CLEARED, and is this worth saying out loud? Pure.
//
// `prevKeys` is null on a bootstrap run (no state file yet) — distinct from an empty array, which
// genuinely means "last run saw nothing". On a bootstrap nothing is new and nothing pings, or the
// first run after this ships would announce every standing alarm at once.
//
// shouldPing is TRANSITION-ONLY by design: it is false whenever the set of open alarms is unchanged,
// however many are open. That is what makes it safe to send on the same channel the old level-based
// heartbeat made unreadable.
export function healthTransitions(alarms, prevKeys) {
  const live = (alarms || []).map((m) => ({ key: healthAlarmKey(m), text: m }));
  const seen = new Set(live.map((a) => a.key));
  const prev = prevKeys == null ? null : new Set(prevKeys);
  const bootstrapped = prev == null;
  const annotated = live.map((a) => ({ ...a, isNew: bootstrapped ? false : !prev.has(a.key) }));
  const cleared = bootstrapped ? [] : [...prev].filter((k) => !seen.has(k));
  const fresh = annotated.filter((a) => a.isNew);
  return { annotated, fresh, cleared, keys: [...seen], bootstrapped,
           shouldPing: !bootstrapped && (fresh.length > 0 || cleared.length > 0) };
}

// 'Winner'/'Repost Candidate' retired 2026-09-02 but stay accepted on READ: rows the sync no
// longer builds (deleted drafts, removed accounts) hold them until the orphan cleanup, and a
// predicate that suddenly called those rows unpublished would bend every historical count.
export const isPublished = (s) => s === 'Posted' || s === 'Reposted' || s === 'Winner' || s === 'Repost Candidate';

// Per-account EFFECTIVENESS, pure and exported so the money rules here are testable without a
// network. Winner counts and winRate left with the Winner status (2026-09-02) — hit-rate is the
// farm gate's judgment now (harvest-gate.mjs over the Harvests table), not a per-row flag.
export function aggregateByAccount(rows) {
  const byAccount = {};
  for (const r of rows) {
    const a = byAccount[r.Account] || (byAccount[r.Account] = { rows: 0, posted: 0, revenue: 0, grossSales: 0, draft: 0, scheduled: 0 });
    a.rows++;
    if (isPublished(r.Status)) a.posted++;
    if (r.Status === 'Draft') a.draft++;         // generated but never scheduled — draft-mortality proxy (QC-failed / abandoned)
    if (r.Status === 'Scheduled') a.scheduled++; // queued (will post) — in-flight, not yet a leak
    // COMMISSION ONLY (2026-08-30). This was `commission + Sales`, contradicting the house rule this
    // same file states above the Winner test: "Sales is GROSS ORDER VALUE — the customer's spend, not
    // ours — and the house rule is that it never counts as earnings." The 2026-08-17 audit removed
    // gross sales from the WINNER rule and left it here, so every `revenue`/`revPerPost` figure in
    // the run logs has been inflated since. Not merely a display error: accountHealth's zeroRevenue
    // and attributionDark alarms fire on `revenue === 0`, so gross order value the business never
    // received could mask an account that genuinely earns nothing — the alarm silenced by the very
    // number it exists to catch. Gross sales are kept, just no longer mislabelled as earnings.
    a.revenue = Number((a.revenue + (r.Commission || 0)).toFixed(2));
    a.grossSales = Number((a.grossSales + (r.Sales || 0)).toFixed(2));
  }
  for (const a of Object.values(byAccount)) {
    a.revPerPost = a.posted ? Number((a.revenue / a.posted).toFixed(2)) : 0;
    // Draft mortality: what share of generated rows actually reached posted. A low postedRate with a
    // high `draft` count = a generation/QC leak (rows generated but stuck as drafts, never
    // scheduled) — the retro reads this per account to tell a real bottleneck from a healthy
    // in-flight queue. Pure counting.
    a.postedRate = a.rows ? Number((a.posted / a.rows).toFixed(3)) : 0;
  }
  return byAccount;
}


/**
 * Every draft Typefully holds for one social set, in ONE paginated pass, deduped by id.
 *
 * NEVER enumerate statuses here. The first cut asked for status=draft, then scheduled, then
 * published, which assumed those three are all Typefully has. A publish that FAILS leaves the
 * draft in status `error` (`publishing` exists too), so such a draft answered none of the three
 * queries and vanished from the fleet inventory entirely — 32 of them on 2026-09-16. A row the
 * inventory cannot see reads to the lifecycle reconciler as MISSING, and two of those 32 still
 * carried farm links (a spent heart and a pot, both failed publishes), which set staleFarmLinks,
 * which set blockFarm, which wrote metricsComplete:false, which made harvest-gate refuse to judge
 * anything at all. One unenumerated status string halted every verdict in the system.
 *
 * Offset paging over a list that can change mid-scan may also hand the same draft back twice, and
 * two rows sharing a Draft ID is exactly the duplicate the reconciler blocks the farm for — so
 * first-seen wins and repeats are dropped rather than built into rows.
 */
export async function readAccountDrafts(tf, socialSetId) {
  const drafts = [];
  const seen = new Set();
  for (let offset = 0; ; offset += 50) { // drafts endpoint caps limit at 50
    const j = await tf.get(`/social-sets/${socialSetId}/drafts?limit=50&offset=${offset}`);
    for (const d of (j.results || [])) {
      const id = String(d.id);
      if (seen.has(id)) continue;
      seen.add(id);
      drafts.push(d);
    }
    if (!j.next || !(j.results || []).length) break;
  }
  return drafts;
}

/**
 * PURE. Whether a registry draft is a native X Article (owner, R2026-10-03: "Every account should do
 * ≥2 articles a week"): the draft says so (monitoring-scope isArticleDraft: an x_article platform, its
 * article URL, an [Article] title), or its ledger rows do (contentLane `article`, or an `x-article-`
 * subid, both stamped by scripts/run-articles.mjs). Every subid is checked, not only the merged
 * row's, because a later attribution row replaces the merged entry outright (lib.mjs parseLedger).
 */
export function isArticleRow(d, { byDraft, subidsByDraft } = {}) {
  if (isArticleDraft(d)) return true;
  const id = String(d?.id);
  const led = byDraft?.get(id);
  if (laneOf(led?.contentLane) === ARTICLE_LANE) return true;
  return [led?.subid1, ...(subidsByDraft?.get(id) || [])].some((s) => String(s || '').startsWith('x-article-'));
}

/** PURE. The post's X URL: a thread's x_published_url, else an article's x_article_published_url. */
export const xUrlOf = (d) => d?.x_published_url || d?.x_article_published_url || null;

/**
 * A published article's tweet is on the FULL draft only: x_published_url stays null and the list
 * carries no x_article_published_url. The gtx-registry.mjs pattern: a URL the registry already holds
 * for that Draft ID answers it, otherwise the draft is read once (on the run's detail-read budget).
 * A failed or skipped read leaves the URL missing, so the row keeps its previous X URL: never wrong.
 */
export async function fillArticleUrls(tf, setId, drafts, { isArticle = isArticleDraft, knownUrls = new Map(), budget = { remaining: 100 } } = {}) {
  let failed = 0;
  for (const d of drafts) {
    if (d.status !== 'published' || xUrlOf(d) || !isArticle(d)) continue;
    const known = knownUrls.get(String(d.id));
    if (known) { d.x_article_published_url = known; continue; }
    if (budget.remaining <= 0) continue;
    budget.remaining--;
    try {
      const full = await tf.getDraft(setId, d.id);
      if (full?.x_article_published_url) d.x_article_published_url = full.x_article_published_url;
    } catch { failed++; }
  }
  return { failed };
}

/** The X handle the account's newest published post actually went out under, when it differs from
 *  accounts.mjs `xHandle || handle` (case-insensitive) — else null. X renames do not reach Typefully's username,
 *  and a stale handle fails the follower read every run: @mind_and_beauty -> @thelorenzorosi turned
 *  every sync red from 2026-10-04 and skipped the vendor, Today-card and product-test steps behind it. */
export function handleDrift(acc, drafts) {
  let newest = null;
  for (const d of drafts) {
    const at = publishedAtOf(d);
    if (d.status === 'published' && Number.isFinite(at) && /x\.com\/[^/]+\/status\//.test(d.x_published_url || '') && (!newest || at > newest.at)) newest = { at, url: d.x_published_url };
  }
  const live = newest && (newest.url.match(/x\.com\/([^/]+)\/status\//) || [])[1];
  const known = acc.xHandle || acc.handle;
  if (!live || !known || live.toLowerCase() === String(known).toLowerCase()) return null;
  return live;
}

/**
 * Head metrics for one account's recent posts, from X (2026-10-03). Map(draftId -> { impressions,
 * likes, bookmarks }).
 *
 * Until 2026-09-30 every account read here also paged Typefully's /analytics/x/posts for impressions,
 * likes, bookmarks, engagement and link clicks. That endpoint has answered 404 since, and because it
 * sat inside the account read, EVERY account was skipped on every run: 0 rows built, the pre-write
 * invariant aborted (1778 -> 0), nothing was written, and ~50 posts published since never reached
 * the registry. The replacement is the one the other nine readers moved to (x-views.mjs):
 *   - WHICH posts went out, and when: the drafts list this file already reads in full
 *     (readAccountDrafts — x_published_url, published_at). No second drafts read is needed.
 *   - VIEWS (+ likes, bookmarks): X's own counts through twitter241. A count X did not return is
 *     ABSENT from the map, never 0; the row then keeps its last value.
 *   - Engagement total and on-platform link clicks have no replacement and are not written.
 * Only posts published at or after sinceMs are asked for. `xv` is x-views.mjs xViews() or a fake.
 */
export async function readAccountViews(xv, acc, drafts, { sinceMs } = {}) {
  if (!Number.isFinite(sinceMs)) throw new Error('readAccountViews needs sinceMs');
  const byTweet = new Map(); // tweet id -> draft ids carrying it
  for (const d of drafts) {
    const tid = statusIdOf(xUrlOf(d)); // a thread's tweet, or an article's when its URL is a status URL
    const at = publishedAtOf(d);
    if (d.status !== 'published' || !tid || !Number.isFinite(at) || at < sinceMs) continue;
    byTweet.set(tid, [...(byTweet.get(tid) || []), String(d.id)]);
  }
  const views = new Map();
  if (!byTweet.size) return { views, asked: 0, unread: 0, failures: 0 };
  const read = await xv.lookup([...byTweet.keys()], { handle: acc.xHandle || acc.handle || null, sinceMs });
  let unread = 0;
  for (const [tid, ids] of byTweet) {
    const m = read.views.get(tid);
    if (m?.views == null || !Number.isFinite(Number(m.views))) { unread++; continue; }
    for (const id of ids) views.set(id, { impressions: Number(m.views), likes: m.likes ?? null, bookmarks: m.bookmarks ?? null });
  }
  return { views, asked: byTweet.size, unread, failures: read.failures || 0 };
}

// ONE DRAFT -> ONE REGISTRY ROW. Pure: every input arrives in `ctx`, nothing is fetched, nothing is
// mutated outside the returned object. Extracted from main() on 2026-08-30 as a verbatim move.
//
// This ~200 lines is where every silent money bug this file documents actually lived — 5.1x click
// inflation from summing a per-link figure across ASIN rows, 23 winners qualifying on gross sales,
// $0 commission from a dead v2 endpoint, a re-minted draft losing every link but its last pair, 24
// published posts earning $0 because a deleted twin held the claim. Each was found by a human
// reading rows weeks or months later, because welded inside main() next to the network calls it
// could not be tested at all. Now it can.
//
// Returns a discriminated result rather than pushing into six arrays:
//   { kind: 'untracked' | 'manualPublished' | 'skip' }        nothing enters the registry
//   { kind: 'row', row, lifetimeRow, stalled, hasSeries, untracked }  stalled/untracked null unless set
export function buildRow(d, ctx) {
  const article = isArticleRow(d, ctx);
  if (!article && isStandalonePost(d)) return { kind: 'skip' };
  const { acc, analytics, perTweet, byDraft, linksByDraft, subidsByDraft, byLvId, bySubid,
          levByLink, lifeByLink, lifeByLinkPrev, threadLanes, gum, gumLife, existingPosted, fuelByTid,
          asinsByDraft = new Map(), productRecByAsin = new Map(), productStats = null, linkPlatform,
          gumroadOff = false } = ctx;
  const id = String(d.id);
  const led = byDraft.get(id);
  // A missing provider row is not a measured zero (older posts may be outside its window).
  // Preserve last-known head metrics; the quality report separately exposes coverage gaps.
  // `analytics` holds this run's X reading (readAccountViews); a field it lacks falls back to the
  // row's stored value, and one known to neither is left UNWRITTEN — never 0 (2026-10-03).
  const fresh = analytics.get(id), last = existingPosted.get(id);
  const a = fresh ?? last?.analytics;
  const head = (k) => fresh?.[k] ?? last?.analytics?.[k] ?? undefined;
  let untrackedRide = null;   // set for a scheduled Manual draft: warn on the worklist AND write the row
  let manualPublishedRide = null;
  const subid = led?.subid1;
  // Products link (2026-09-02): every ASIN the draft ever plugged (asinsByDraft — the accumulated
  // set, never the merged row's asin/asin2), in ledger order, matched to the Products board by
  // ASIN. An unknown ASIN is a board gap (products-sync), counted for the run report, never fatal.
  const productIds = [];
  for (const asin of asinsByDraft.get(id) || []) {
    const rec = productRecByAsin.get(String(asin).toUpperCase());
    if (rec) { if (!productIds.includes(rec)) productIds.push(rec); }
    else productStats?.unknown?.add(String(asin).toUpperCase());
  }
  // Levanta joins by minted link id — BOTH products (link + link2), and Gumroad by ?ref subid
  // (subid1 + subid1b), mirroring revenue.mjs's per-thread sum so product-2 earnings don't read
  // as $0. CLAIMANT GUARD: each revenue key pays out only on the row the ledger's byLvId/bySubid
  // claimant map points at — a retried thread's duplicate drafts share the minted link, and the
  // per-key aggregate must never be handed to every duplicate (2-3x multi-count; see loadLedger).
  // ALL of the draft's keys, from linksByDraft/subidsByDraft — the accumulated per-draft sets —
  // never from the merged row's link/link2. The merge replaces attribution outright, so a draft
  // whose plugs were minted across several ledger rows (a repair, a re-mint, a 3rd product) kept
  // only the LAST pair here, and every earlier link's clicks and commission silently vanished:
  // Marcos 10380538 reported 333 of its 1,225 lifetime clicks, and two qualifying threads were
  // missing from the harvest pool entirely. The claimant guard is unchanged — a key still pays
  // out only on the draft the resolver points at, so duplicate drafts cannot double-count.
  const lvIds = [...(linksByDraft.get(id) || [])].filter((k) => byLvId.get(k) === id);
  // THREADS IS SPLIT OUT, NOT SUBTRACTED (2026-08-31). A cross-post row carries the parent's
  // draftId, so lvIds already includes the "-th" links and every figure below is a TOTAL across
  // platforms. That is the right definition to keep: historically every click WAS X's, so narrowing
  // these columns now would silently drop the numbers on cross-posted drafts and could strip the
  // Winner flag from a thread that genuinely earned it on Threads. Instead the Threads portion is
  // reported ALONGSIDE, and X-only is total minus Threads for anyone who wants it.
  //
  // Not academic: Julian 10520755 earned 53 clicks and $8.73 on 2026-08-29, ALL of it from Threads,
  // and until now the row credited every one of them to the X post with no column saying so.
  const thIds = lvIds.filter((k) => (linkPlatform?.get(k)?.platform || 'x') !== 'x');
  const thParts = thIds.map((k) => levByLink.get(k)).filter(Boolean);
  const thClicks = thIds.reduce((s, k) => s + (levByLink.get(k)?.clicks || 0), 0);
  const thCommission = thParts.reduce((s, p) => s + p.commission, 0);
  const thOrders = thParts.reduce((s, p) => s + p.orders, 0);
  const gumIds = [...(subidsByDraft.get(id) || [])].filter((s) => String(bySubid.get(s)?.draftId) === id);
  // No Gumroad read this run: a row that earns through Gumroad would be written with that part at 0.
  // Hold it instead (its stored figures stay as they were).
  // gumIds holds every subid the draft claims (Levanta ones too); only a subid whose ledger link is a
  // gumroad.com link can earn there.
  const gumroadRef = (sid) => { const r = bySubid.get(sid); return [r?.link, r?.link2].some((l) => /gumroad\.com/.test(String(l || '')) && String(l).includes(sid)); };
  if (gumroadOff && gumIds.some(gumroadRef)) return { kind: 'gumroadHeld' };
  const levParts = lvIds.map((k) => levByLink.get(k)).filter(Boolean);
  const parts = [...levParts, ...gumIds.map((s) => gum.get(s))].filter(Boolean);
  const levCommission = levParts.reduce((s, p) => s + p.commission, 0);
  const rev = parts.length ? {
    commission: parts.reduce((s, p) => s + p.commission, 0),
    sales: parts.reduce((s, p) => s + p.sales, 0),
    orders: parts.reduce((s, p) => s + p.orders, 0),
  } : null;
  // Link Clicks: Typefully's engagement.link_clicks went DEAD upstream on 2026-06-29, then came
  // back HALF-ALIVE (2026-07-16 diagnosis: 36 of 2,443 posts nonzero, reporting a fraction of
  // real traffic — Rafael's viral thread showed 1,240 vs Levanta's 4,793). The old "prefer
  // Typefully whenever nonzero" rule therefore undercounted EXACTLY the biggest posts: a low-but-
  // nonzero sensor reading beat Levanta's destination-measured truth (fleet: 8,220 vs 16,820 over
  // 14d). Take the MAX of the two sensors instead — undercount-proof under a flaky upstream, and
  // still lets the richer all-links Typefully metric win if it ever fully revives (it reads >=
  // Levanta when healthy, since it counts every link in the thread).
  const levClicks = lvIds.reduce((s, k) => s + (levByLink.get(k)?.clicks || 0), 0);
  // Typefully side of the MAX: for posts inside the per-tweet window, the all-tweets click sum
  // replaces the head-row sensor (which structurally misses every click on tweets 2..N — i.e.
  // the plug tweets, where the money clicks are). This is the "richer all-links Typefully
  // metric" the MAX rule below was always waiting for; MAX semantics are unchanged.
  const pt = perTweet.get(id);
  const series = pt && pt.length >= 2 ? tweetSeries(pt) : null;
  // NO LIVE TYPEFULLY SENSOR SINCE 2026-09-30 (its /analytics/x/posts answers 404), and X's public
  // counts carry no clicks. tfClicks is therefore null unless a reading that carries clicks exists,
  // and the row's stored Link Clicks — which already folds in every figure Typefully measured — is
  // the floor, so a click count is never lost and a post nobody measured is never written as 0.
  const tfClicks = (fresh?.clicks != null || series) ? Math.max(fresh?.clicks || 0, series ? series.reduce((s, t) => s + t.c, 0) : 0) : null;
  const clickParts = [tfClicks, last?.linkClicks, lvIds.length ? levClicks : null].filter((v) => Number.isFinite(v));
  const clicks = clickParts.length ? Math.max(...clickParts) : undefined;
  const commission = rev?.commission || 0, sales = rev?.sales || 0;
  // Lifetime across the same claimant-guarded keys. Falls back to the windowed number when the
  // day-file has no history yet (first runs), so lifetime figures can only widen, never shrink.
  const lifeParts = [...lvIds.map((k) => lifeByLink.get(k)), ...gumIds.map((g2) => gumLife.get(g2))].filter(Boolean);
  const lifetimeCommission = lifeParts.length ? lifeParts.reduce((s2, p) => s2 + p.commission, 0) : commission;
  const lifetimeSales = lifeParts.length ? lifeParts.reduce((s2, p) => s2 + p.sales, 0) : sales;
  const lifetimeOrders = lifeParts.length ? lifeParts.reduce((s2, p) => s2 + p.orders, 0) : (rev?.orders || 0);
  // The same join over YESTERDAY'S day-file, so the invariant below can tell a Levanta reversal
  // (the day-file itself went down for this draft's keys — authoritative, write the truth) from a
  // join losing keys (the day-file still holds the money but this draft no longer claims it — the
  // bug class the abort exists for). Same keys, same fallback shape as lifetimeCommission.
  const lifePartsPrev = lifeByLinkPrev ? [...lvIds.map((k) => lifeByLinkPrev.get(k)), ...gumIds.map((g2) => gumLife.get(g2))].filter(Boolean) : [];
  const lifetimeCommissionPrev = lifePartsPrev.length ? lifePartsPrev.reduce((s2, p) => s2 + p.commission, 0) : commission;
  // Lane label, best source first: the thread record knows its lane outright; a title marker
  // ([Harvest]/[Evergreen] both mean harvest, per lanes.mjs ALIASES) beats the ledger because
  // publish-thread stamps markers precisely; a bare ledger row is the nightly engine = a cover.
  // Before lanes.mjs every led row was labelled 'Recreation' regardless of lane — see loadThreadLanes.
  // A Threads-only post (threads-x3-ship.mjs: X switched off, another page's body reposted on Meta
  // Threads) is no lane at all, so it is checked first. It used to fall through to `led ? 'Cover'`:
  // found 2026-10-02, 228 of them read as Posted X covers with no X URL and no views, inflating
  // every covers-per-day, harvests-per-100-covers and hit-rate figure built on Type = Cover.
  const title = d.draft_title || '';
  const type = (led?.mode === 'threads-x3' || /^\[threads×3[\s\]]/i.test(title)) ? 'Threads'
    : article ? laneLabel(ARTICLE_LANE) // a native X Article is never a thread (owner, R2026-10-03)
    : threadLanes?.get(id) ? laneLabel(threadLanes.get(id))
    : /\[(harvest|evergreen)\]/i.test(title) ? 'Harvest'
    : /\[pot(?:·[a-z0-9-]+)?\]/i.test(title) ? 'Seed' // a pot is seed-lane content; its family rides the token (farm, 2026-09-02)
    : /\[inspiration\]/i.test(title) ? 'Inspiration'
    : /\[cover\]/i.test(title) ? 'Cover'
    : led ? 'Cover'
    : 'Manual';
  // Once a manual post has a registry row (e.g. it was scheduled), keep refreshing it
  // after publication. Otherwise it remains falsely Scheduled forever.
  if (type === 'Manual' && !acc.trackAll) {
    // Untracked-post guard: a manual draft that is SCHEDULED will post with no registry
    // tracking (no subid, no revenue attribution) — surface it instead of staying silent.
    // (Client accounts with trackAll keep ALL their posts in the registry, so they skip this.)
    // A SCHEDULED manual draft still gets a REGISTRY ROW (2026-08-30). Returning early here left 19
    // of the fleet's 65 queued threads invisible in Airtable, so every forward-looking readout
    // under-reported the day. They are monetized; what they lack is the ledger row that joins money
    // back to the draft, which is exactly what the untracked worklist is for. So: warn AND record.
    // The entry rides along on the row result and the caller pushes both.
    if (d.status === 'scheduled') {
      untrackedRide = { name: acc.name, title: (d.draft_title || 'untitled ' + d.id).slice(0, 60), when: d.scheduled_date, link: d.share_url || `https://typefully.com/?d=${d.id}&a=${acc.socialSetId}` };
      // deliberately NO return: fall through and build the row too
    // A manual post that is ALREADY PUBLISHED is past the point the warning above can help, so
    // it used to just vanish: `continue` with nothing recorded anywhere. That made the registry
    // quietly smaller than reality — audit 2026-08-17 found 36 live fleet threads in this state,
    // and no number on any dashboard said so. Still not written as a row (the registry holds
    // workflow content by design), but now COUNTED, so "how many threads have we actually
    // shipped" has an answer instead of a silence.
    } else if (d.status === 'published') {
      manualPublishedRide = { name: acc.name, id: String(d.id), when: d.published_at || d.scheduled_date || null };
      if (!existingPosted.has(id)) return { kind: 'manualPublished', manualPublished: manualPublishedRide };
    } else {
      if (!existingPosted.has(id)) return { kind: 'skip' }; // keep existing lifecycle rows current
    }
  }
  // Status is LIFECYCLE ONLY (2026-09-02): Draft -> Scheduled -> Posted -> Reposted. The
  // Winner/Repost Candidate promotion that lived here retired with the farm — performance
  // judgment moved to harvest-gate.mjs over the Harvests table, where it belongs, instead of
  // mutating a row's lifecycle every time a threshold in laws.json moved.
  // 'Reposted' is stamped by republish.mjs directly on the source row and must SURVIVE the sync:
  // before this rule the next run clobbered it (back to Posted, or under the old promotion to
  // Winner/Repost Candidate), so the registry disagreed with reality about every reposted body.
  // Repost Count > 0 also decides it (2026-09-01 review finding): a stamp landing while a sync is
  // mid-flight loses the race — the sync's existingPosted snapshot predates it, so the upsert wrote
  // 'Posted' back and every later run agreed. The count survives (the sync only seeds it when
  // absent), so deriving Reposted from it makes one lost race self-heal on the next run.
  const prevSeen = existingPosted.get(id);
  let status = d.status === 'published' ? ((prevSeen?.status === 'Reposted' || (prevSeen?.repost || 0) > 0) ? 'Reposted' : 'Posted')
    : d.status === 'scheduled' ? 'Scheduled' : 'Draft';
  // The clicks figure is LEVANTA-ONLY and lifetime (operator 2026-08-25: "levanta stats" — the
  // store-side counter is the aim; Typefully's sensor went half-dead 2026-06-29 and its
  // MAX-repaired number still measures a different thing). Falls back to the windowed Levanta
  // number before the day-file has history, so the figure can only widen. The farm gate reads it
  // off the row's 'Lifetime Clicks' column; commission stays commission-only (Sales is gross
  // order value, never earnings — the 2026-08-17 audit rule).
  const lifetimeLevClicks = lifeParts.length ? lifeParts.reduce((s2, p) => s2 + (p.clicks || 0), 0) : levClicks;
  // Yesterday's-join twin for clicks, exactly as lifetimeCommissionPrev above: the invariant's
  // reversal discriminator needs to know whether a clicks drop originated in Levanta's own
  // day-file (authoritative revision) or in this run's join (the abort class).
  const lifetimeLevClicksPrev = lifePartsPrev.length ? lifePartsPrev.reduce((s2, p) => s2 + (p.clicks || 0), 0) : levClicks;

  // Posted Date: published -> actual published time; scheduled -> seed once, then Airtable owns it.
  const postedDate = d.status === 'published'
    ? (d.x_post_published_at || d.published_at || d.scheduled_date || undefined)
    : (existingPosted.has(id) ? undefined : (d.scheduled_date || undefined));

  // STALL DETECTION. Posted Date above is a PLAN: seeded once, then owned by Airtable so an
  // operator drag survives (reschedule-sync pushes Airtable -> Typefully). That is right for a
  // post still on its way, but it means a draft that WAS scheduled and later fell out of the
  // queue keeps its old date forever while Status flips to Draft — so an abandoned thread reads
  // exactly like one that simply missed its slot, and nothing ever notices. Observed 2026-07-26:
  // 15 finished threads on ACTIVE accounts, products picked and Levanta links minted, sat
  // unscheduled for up to 3 weeks with the registry still showing their original intended slot.
  //
  // So record Typefully's ACTUAL state alongside the plan. `Scheduled For` is written every run
  // and explicitly nulled when Typefully has nothing queued (null clears in the PATCH; undefined
  // would silently leave a stale value). `Draft Created` is the age anchor — Posted Date cannot
  // be, precisely because it may hold a slot that was never applied.
  const draftAgeDays = d.created_at ? (Date.now() - new Date(d.created_at)) / 864e5 : 0;
  // SCOPE. A stall is only worth a human's attention on a page that actually earns and is actually
  // running: an unmonetized page has no revenue sitting idle, and a paused page's drafts are dormant
  // BY DESIGN (Knox contributed 2 of the first 25 purely because it is paused). Narrow here rather
  // than at each consumer, so the ops ping, the JSON worklist and the Morning Brief can never
  // disagree about what counts.
  //
  // And never flag a draft the operator parked deliberately — unscheduling something and leaving it
  // in Draft is an editorial call, not a fault. `[parked]` anywhere in the title is the opt-out,
  // following the existing [harvest]/[inspiration] title-marker convention rather than inventing a
  // new field: it is set in Typefully, where the decision to unschedule is already being made.
  const parked = /\[parked\]/i.test(d.draft_title || '');
  const stallEligible = !!acc.levantaSubidPrefix && !acc.paused && !parked;
  const isStalled = stallEligible && status === 'Draft' && !d.scheduled_date && type !== 'Manual' && draftAgeDays >= STALL_DAYS;
  const stalled = !isStalled ? null : ({
    name: acc.name,
    title: (d.draft_title || `untitled ${id}`).replace(/^\[(Infinity|Inspiration|Harvest|Evergreen)\][^—]*—\s*/i, '').slice(0, 60),
    days: Math.floor(draftAgeDays),
    product: led?.product || null,
    link: d.share_url || `https://typefully.com/?d=${id}&a=${acc.socialSetId}`,
  });
  const xUrl = xUrlOf(d);
  const fuel = xUrl ? fuelByTid.get(tweetId(xUrl)) : null;

  // Plug funnel + redirect survival (2026-08-17). Plug positions: DETECT from the published
  // per-tweet text (the "aff link" disclosure survives into every plug tweet; the URL itself
  // becomes an opaque t.co, which is why detection keys on the disclosure) — the ledger's
  // plugTweets stamp is the fallback for the truncation edge, not the primary, because QC can
  // reshape a draft after stamping and shift the indices. Survival = destination-measured
  // Levanta clicks / on-platform Typefully clicks — the lvnta.com interstitial loss, and the
  // primary readout for the directLink A/B (metrics.mjs nulls it when the Typefully sensor
  // reads below Levanta: a ratio over an undercounting denominator is not a measurement).
  const detected = series ? plugTweetIndices(series.map((t) => t.text)) : [];
  const stamped = Array.isArray(led?.plugTweets) ? led.plugTweets.filter((p) => p >= 1 && p <= (series?.length || 0)) : [];
  const plugIdx = detected.length ? detected : stamped;
  const funnel = series ? plugFunnel(series, plugIdx) : null;
  // `hasSeries` below replaces the perTweetPosts++ the caller used to bump here.
  // LIFETIME on top, not the 59-day window (2026-09-08). `levClicks` decays out of the window while
  // `tfClicks` comes from Typefully analytics and does not, so this ratio fell toward 0 on its own as
  // a post aged: measured on the live registry, the six posts in the 59-90 day band read 0.9% where
  // the honest figure is 62.6%. It is the same lifetime-over-windowed rule as every other money
  // column (docs/money-columns.md), and it is the one metric the 2026-09-02 pass missed because it
  // is a funnel ratio rather than a money one. redirectSurvival still nulls the pair when the
  // numerator exceeds the denominator, which is what an undercounting Typefully sensor looks like.
  const survival = lvIds.length ? redirectSurvival(lifetimeLevClicks, tfClicks) : null;

  const lifetimeRow = ({ 'Draft ID': id, 'Lifetime Commission': Number(lifetimeCommission.toFixed(2)), 'Lifetime Sales': Number(lifetimeSales.toFixed(2)), 'Lifetime Orders': lifetimeOrders, 'Lifetime Clicks': lifetimeLevClicks });
  const row = ({
    'Post': (d.draft_title || '').replace(/^\[(Infinity|Cover|Inspiration|Harvest|Evergreen|Pot(?:·[a-z0-9-]+)?)\][^—]*—\s*/i, '').slice(0, 90) || `Draft ${id}`,
    'Account': acc.name, 'Status': status, 'Type': type, 'Draft ID': id,
    'X URL': xUrl || undefined,
    // The PUBLIC typefully.com/t/<slug> link — the one anyone can open without a Typefully login.
    // The 'Typefully Link' formula prefers this field and only falls back to the members-only
    // ?d= URL when it is blank. null (not undefined) so a revoked share clears honestly.
    'Share Link': d.share_url || null,
    ...(fuel ? { 'Fuel Spend': fuel.spend, 'Fuel Tiers': fuel.tiers, 'Fuel Reach': fuel.reach, 'Fuel Vendors': fuel.vendors || '', 'Fuel Fires': fuel.fires || 0 } : {}),
    ...(postedDate ? { 'Posted Date': postedDate } : {}),
    // Truth from Typefully, not the plan. null (not undefined) so an unscheduled draft CLEARS
    // the column instead of keeping whatever was there when it was last queued.
    'Scheduled For': d.scheduled_date || null,
    'Draft Created': d.created_at || undefined,
    'Source Thread': led?.sourceUrl || undefined,
    'Product': led?.product || undefined, 'Subid': subid || undefined,
    // The link twin of 'Product': both (all) products, as Products-table record ids. undefined
    // leaves a row with no ledger entry untouched — there is no ASIN on record to link.
    'Products': productIds.length ? productIds : undefined,
    // Impressions are X's view count since 2026-10-03 (Typefully's impressions ran 1-8% under X on
    // settled posts). Each of these four is omitted when unknown — Airtable keeps its value.
    'Impressions': head('impressions'), 'Link Clicks': clicks, 'Likes': head('likes'), 'Bookmarks': head('bookmarks'),
    // The Levanta half of that MAX, kept separately. `Link Clicks` is deliberately the max of two
    // sensors (see the note above it) and therefore counts EVERY link in the thread whenever
    // Typefully's sensor is healthy — right for reach, wrong as the denominator of an AFFILIATE
    // earnings-per-click.
    //
    // The gap is REAL, not theoretical — measured 2026-08-15 over a 30d window:
    //   "[Evergreen] Magnus — No mat…"   Link 250 vs affiliate 114   (2.2x)
    //   "Cardio is a scam for fat loss"  Link 237 vs affiliate  36   (6.6x)
    //   "The only 3 supplements…"        Link 853 vs affiliate 780   (EPC $0.193 -> $0.211)
    // Typefully wins the max more often than expected, so EPC over `Link Clicks` is diluted by
    // clicks that never touched an affiliate link. Divide by THIS field for affiliate EPC.
    //
    // Blank (not 0) when the thread has no tracked link at all, so "unmonetized" never reads as
    // "measured zero clicks" — same rule EPC follows on the next line.
    'Affiliate Clicks': lvIds.length ? levClicks : null,
    // The Threads slice of the totals above. Blank, never 0, when the draft carries no Threads link
    // — the same rule Affiliate Clicks follows, and for the same reason: "not cross-posted" must
    // never read as "measured zero clicks on Threads".
    'Threads URL': d.threads_published_url || undefined,
    'Threads Clicks': thIds.length ? thClicks : null,
    'Threads Commission': thIds.length ? Number(thCommission.toFixed(2)) : null,
    'Threads Orders': thIds.length ? thOrders : null,
    // Needs Typefully's engagement total, which X's public counts do not replace: written only from
    // a reading that carries it (the stored row's own), otherwise left as it is.
    'Engagement Rate': a?.eng == null ? undefined : (a.impressions ? (a.eng / a.impressions) : 0),
    'Commission': commission, 'Sales': sales, 'Orders': rev?.orders || 0,
    // EPC IS NO LONGER WRITTEN HERE (2026-09-02). It is the `Earnings / Click` FORMULA field:
    // {Lifetime Commission} / {Lifetime Clicks}. The stored version divided the WINDOWED pair, and
    // both sides of that pair are capped to this file's 59-day Levanta range — so past ~60 days the
    // clicks aged out while commission had not yet, and the column reported things like $33.71 a
    // click (one surviving click against real commission). A metric derived from two stored columns
    // does not need a third stored column and a nightly job to keep it true: the formula recomputes
    // the moment either input moves, including on rows this sync never touches.
    'Niche': led?.niche || undefined,
    // CTA split-test cohort (recreate.mjs stamps ctaStyle into the ledger since 2026-08-08:
    // 'classic' | 'dm' | 'narrative'). Hydrated here because the dashboard reads Airtable, not
    // git — its GitHub token is deliberately Actions-only and must never read repo files.
    // undefined (not '') so pre-test rows stay blank instead of minting an empty cohort.
    'CTA Style': led?.ctaStyle || undefined,
    // What the thread cost to MAKE (recreate.mjs stamps its process's LLM spend into the ledger
    // since 2026-08-10). Next to Revenue, this is per-post unit economics: made-for vs earned.
    // undefined keeps pre-metering rows blank — a blank means "not measured", never "$0".
    'Gen Cost': led?.llmCost ?? undefined,
    // Hook identity + the plug funnel (2026-08-17). Every key below is OMITTED (never nulled)
    // when not computable this run, so a value computed while the post was young — inside the
    // 21-day per-tweet window — survives later syncs untouched: compute-young, then frozen. (The
    // per-tweet source died with /analytics/x/posts on 2026-09-30, so all of these are frozen now.)
    'Hook ID': led?.hookId || undefined,
    ...(plugIdx.length ? { 'Plug Tweets': plugIdx.join(',') } : {}),
    ...(funnel?.plugExposure != null ? { 'Plug Exposure %': r4(funnel.plugExposure) } : {}),
    ...(funnel?.truePlugCtr != null ? { 'True Plug CTR %': r4(funnel.truePlugCtr) } : {}),
    ...(funnel?.postPlugDrop != null ? { 'Post-Plug Drop %': r4(funnel.postPlugDrop) } : {}),
    ...(funnel?.readThrough != null ? { 'Read-Through %': r4(funnel.readThrough) } : {}),
    // NOT frozen like its neighbours above, and it never was — this is the one key in this block
    // that does not depend on `series`. redirectSurvival() is recomputed on EVERY sync for as long
    // as the thread has a Levanta link, so there is no compute-young value here to protect, and its
    // only nulls are the two "this cannot be measured" cases: a Typefully sensor under 10 clicks,
    // or a numerator that has overtaken its denominator (a ratio over an undercount is not a
    // measurement). Omitting the key on those left the last reading standing FOREVER — a fossil of
    // the moment before the sensors crossed. Measured 2026-09-18 over 230 rows with >=100 clicks:
    // 13 were provably too low, 5 of them frozen at 0.0% on threads that have since banked real
    // money (2026-08-17 Magnus: 888 clicks, $186.84, stored 0.0%).
    //
    // That was never cosmetic. weekly-metrics reconstructs the fleet ratio as aff/s per post and
    // treats s === 0 as "0 affiliate clicks out of Link Clicks", so each of those five added
    // hundreds of clicks to the denominator and nothing to the numerator — the weekly figure has
    // been reading low because of it. A null here makes that loop skip the post instead.
    //
    // So: null CLEARS the cell (lib.mjs upsert, and rowHash keeps null distinct from undefined).
    // Blank is the honest rendering of a ratio we cannot compute. The key is still omitted outright
    // when the thread has no Levanta link at all, because then nothing ever wrote it.
    // SINCE 2026-09-30 there is no denominator at all: it is a LIVE Typefully click reading, and that
    // sensor is gone (tfClicks null). Then the key is omitted, so the value the last live run wrote —
    // a real measurement, or the blank the rule above set — stands. Recomputing over the stored Link
    // Clicks floor would divide by a number that is not an on-platform reading; clearing every row
    // would erase measurements that were right when taken.
    ...(lvIds.length && tfClicks != null ? { 'Redirect Survival %': survival != null ? r4(survival) : null } : {}),
    ...(funnel ? { 'Tweet Views': JSON.stringify(funnel.curve) } : {}),
    // seed once; repost workflow owns increments afterward
    ...(existingPosted.get(id)?.repost === undefined ? { 'Repost Count': 0 } : {}),
    'Last Synced': new Date().toISOString(),
  });
  return { kind: 'row', row, lifetimeRow, lifetimeBefore: Number(lifetimeCommissionPrev.toFixed(2)), clicksBefore: lifetimeLevClicksPrev, stalled, hasSeries: !!series, untracked: untrackedRide, manualPublished: manualPublishedRide };
}

async function main() {
  // PER-PHASE TIMING (2026-08-30). logRun records one `runSeconds` from process.uptime(), which said
  // this sync grew 147s -> 200s over 12 days and nothing about WHERE. These marks attribute it, and
  // are also how the changed-row write below proves its saving.
  const PHASE = {};
  let _t0 = Date.now();
  const mark = (name) => { PHASE[name] = Math.round((Date.now() - _t0) / 100) / 10; _t0 = Date.now(); };
  const env = loadEnv();
  // GUMROAD IS OPTIONAL (owner 2026-11-02: "Gumroad optional"). It was REQUIRED because a bare `if`
  // once let a rotated-away secret silently zero every Gumroad-monetized post's commission while the
  // run stayed green — and the token is not on Railway, so every run since the move failed here and
  // the whole registry froze. Now a missing token skips the Gumroad fetch and HOLDS (does not write)
  // each row that earns through a Gumroad ?ref, so no stored commission is ever zeroed, and the run
  // reports how many it held.
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'TYPEFULLY_API_KEY', 'LEVANTA_API_KEY']);
  const gumroadOff = !String(env.GUMROAD_ACCESS_TOKEN || '').trim();
  if (gumroadOff) console.warn('  ⚠️ GUMROAD_ACCESS_TOKEN not set — Gumroad sales skipped; rows earning through Gumroad are held, not written');
  const since = flag('since', isoDay(new Date(Date.now() - 59 * 864e5))); // Levanta caps ranges at 60 days
  if (!(VIEWS_DAYS > 0)) throw new Error(`--views-days must be a positive number of days, got ${flag('views-days')}`);
  const viewsSinceMs = Date.now() - VIEWS_DAYS * 864e5; // X views window (readAccountViews)
  const until = isoDay(new Date());
  const tf = typefully(env);
  const { byDraft, bySubid, byLvId, byLvIdCandidates, bySubidCandidates, linksByDraft, subidsByDraft, asinsByDraft } = loadLedger();
  // Products link (2026-09-02): the per-ASIN board's record ids, so every row can link the products
  // it plugged. A board miss is reported, not fatal — the row still gets everything else.
  const productRecByAsin = new Map();
  const productStats = { linked: 0, unknown: new Set() };
  try {
    for (const r of await registryAt(env).listAll('Products', { fields: ['ASIN'] })) if (r.fields?.ASIN) productRecByAsin.set(String(r.fields.ASIN).toUpperCase(), r.id);
  } catch (e) { failed('products-read', e); console.warn(`Products board unreadable (${e.message}) — Products links skipped this run`); }
  // Which platform minted each link. parseLedger drops `platform` (a cross-post row is
  // attributionOnly and never becomes a draft's merged entry), so this reads the raw file — the one
  // place the stamp survives. Never inferred from the subid string: a hand-edited subid ending in
  // "-th" is not evidence a Threads link was minted.
  const ledgerFile = join(HERE_DIR, 'ledger.jsonl');
  const linkPlatform = indexLinksByPlatform(existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '');
  const fuelByTid = await loadFuelLog(env); // tweet id -> {spend,tiers,reach} to denormalize onto Published Content
  mark('ledger+fuel');

  // Revenue maps (once, shared across accounts).
  // Levanta: v1 daily performance per link, keyed by the minted link id (lv_XXX) — the SAME working
  // join revenue.mjs / learn.mjs / tracking-smoke.mjs already use. This sync previously read the v2
  // /reports/conversions endpoint keyed by subid1, which returns EMPTY for this account (see the
  // listReports note in lib.mjs) — that dead rail is why every registry row carried Commission $0
  // and accountHealth flagged the fleet attribution-dark while revenue.mjs reported real money on
  // the identical period. Verify live with `node revenue.mjs --probe` before/after any join change.
  // CLICKS ARE NOT PER-ROW. Levanta's /reports returns one row per (date, link, ASIN).
  // commissionEarned/sales/conversions are genuinely per-ASIN and must be summed — that is why the
  // money here has always reconciled. `clicks` is a LINK-level figure repeated verbatim on every
  // ASIN row for that link, so `g.clicks += r.clicks` multiplied it by however many ASINs the link
  // touched. Measured 2026-07-26 over a 31-day window: 62,184 summed against Levanta's own reported
  // 12,157, i.e. 5.1x.
  //
  // This mattered more here than on the dashboard, because clicks are not merely displayed — they
  // decide Status: `isWin = clicks >= WIN_CLICKS(50)`. A 5x inflation promoted posts that had ~10
  // real clicks to Winner, which then flowed into winRate, the Reports hit-rate table, the repost
  // pipeline and every "top winners" digest. Wrong inputs, not just a wrong readout.
  //
  // Kept as a running MAX per (date, link) rather than a first-write-wins: when the ASIN rows for a
  // link disagree, the link-level total is the largest of them. Adding only the increment keeps the
  // aggregate correct in one pass without buffering every row.
  const levReports = await levanta(env).listReports({ start: since, end: until });
  mark('levanta');
  const { byLink: levByLink } = aggregateLevReports(levReports); // one implementation, tested in lib
  // LINK CATALOG (2026-09-17). Every report row carries its link object inline, so the ASIN behind
  // every link we ever minted is already in hand right here — including the 231 ids no ledger row
  // ever recorded, because the ledger has exactly two link slots per draft and our densest threads
  // plug three to five products. republish needs precisely that to re-mint such a body, and it must
  // never block a repost on a live API call, so the answer is cached to disk here and read offline
  // there. saveLevantaCatalog merges rather than replaces: a link Levanta has stopped reporting on
  // still has to be re-mintable, because a body posted months ago still carries it. Pure recompute
  // from a read already paid for, and a failure must never take the sync down.
  if (!DRY) {
    try { saveLevantaCatalog(buildLevantaIndex(levReports)); }
    catch (e) { failed('levanta-link-catalog', e); console.log(`  (levanta link catalog refresh skipped: ${e.message})`); }
  }
  // LIFETIME (2026-08-24): the 59d window + overwrite-on-every-run silently decayed a post's
  // Commission to $0 as sales aged out. levanta-days.jsonl keeps per-(date,link) history — in-window
  // days replaced by this fresh read (records reversals), older days frozen — and lifetime fields
  // are derived from it, so history no longer depends on the window.
  const levDaysPath = join(HERE_DIR, LEV_DAYS_FILE);
  const levDaysPrevText = existsSync(levDaysPath) ? readFileSync(levDaysPath, 'utf8') : '';
  const levDaysText = mergeLevDays(levDaysPrevText, levReports, { windowStart: since });
  if (!DRY) writeFileSync(levDaysPath, levDaysText);
  const lifeByLink = lifetimeByLink(levDaysText);
  // Yesterday's totals per link, kept alongside today's: the reversal discriminator in
  // checkInvariants compares the same join over both files — see the note above that function.
  const lifeByLinkPrev = lifetimeByLink(levDaysPrevText);
  // The per-ASIN board rides the same write. pick-product ranks on it (productPerf prefers the
  // board over learn.mjs's product-perf.json, which under-counts split-row clicks), so refreshing
  // it 6x daily here rather than Mon+Thu with learn is what keeps selection current. Pure recompute
  // from files we just wrote — no extra API call, and a failure must never take the sync down.
  if (!DRY) {
    try {
      const { loadBoard, refreshGeniLinks } = await import('./product-board.mjs');
      // Which links ride geni.us decides the board's click unit (laws.product.$geniClickFactor).
      // Read-only on Geniuslink; without keys or on a failure the committed map stays as it is.
      if (env.GENIUSLINK_API_KEY) {
        try { console.log(`  geni-links: ${await refreshGeniLinks(env)} geni-routed links`); }
        catch (e) { console.log(`  (geni-links refresh skipped: ${e.message})`); }
      }
      const board = loadBoard();
      writeFileSync(join(HERE_DIR, 'learnings', 'product-board.json'), JSON.stringify(board, null, 1) + '\n');
    } catch (e) { failed('product-board', e); console.log(`  (product-board refresh skipped: ${e.message})`); }
  }
  // One WIDE Gumroad fetch (volume is tiny, no 60d cap): windowed map for the period fields,
  // lifetime map for the lifetime fields. `before` is date-EXCLUSIVE — bare `until` dropped
  // today's sales on every one of 6 daily runs.
  const gum = new Map(), gumLife = new Map();
  for (const s of gumroadOff ? [] : await gumroad(env).listSales({ after: '2026-06-01', before: nextDay(until) })) {
    const ref = s.url_parameters && (s.url_parameters.ref || s.url_parameters.subid1); if (!ref) continue;
    const add = (m) => { const g = m.get(ref) || { commission: 0, sales: 0, orders: 0 };
      g.commission += (s.price - (s.gumroad_fee || 0)) / 100; g.sales += s.price / 100; g.orders += 1; m.set(ref, g); };
    add(gumLife);
    if (String(s.created_at || '').slice(0, 10) >= since) add(gum);
  }

  // Existing Posted Date per row — Airtable owns the *plan* for scheduled posts, so we
  // seed Posted Date once and never overwrite a drag afterward (reschedule-sync pushes
  // Airtable changes to Typefully). Published posts get the actual published time.
  //
  // THIS READ MUST BE COMPLETE OR THE RUN MUST NOT WRITE. It was a bare fetch with `if (!r.ok) break`
  // — the same pattern the Typefully note below calls "the one outcome that must not reach the
  // registry", left un-converted on the Airtable side. A truncated map does not degrade gracefully,
  // it CORRUPTS: rows past the cut look new, so `Posted Date` is re-seeded from Typefully's
  // scheduled_date (overwriting an operator's drag, which reschedule-sync then pushes back INTO the
  // live Typefully queue) and `Repost Count` is reset to 0. listAll throws instead, and the throw is
  // deliberately NOT caught here — a run that cannot read the existing state has no business
  // writing over it, and the next cron picks it up cleanly.
  const HASH_FILE = join(HERE_DIR, 'queues', 'registry-row-hashes.json');
  let storedHashes = null;
  try { if (existsSync(HASH_FILE)) storedHashes = JSON.parse(readFileSync(HASH_FILE, 'utf8')); }
  catch (e) { console.warn(`  (row-hash file unreadable, writing everything: ${e.message})`); }
  const postKinds = storedHashes?.postKinds || {};
  // Draft detail reads per run. 100 was sized for six runs a day; since 2026-11-01 the sync runs once a
  // day (Railway, RapidAPI budget), and a busy posting day needs more than 100 (2026-11-20: 173). The
  // 73 left over were deferred, which marks the metrics incomplete and defers the whole farm gate.
  const DETAIL_READ_BUDGET = 400;
  const classificationBudget = { remaining: DETAIL_READ_BUDGET };
  const deferredMonitoring = new Set();
  const existingPosted = new Map();
  // Status and Lifetime Commission ride along for the pre-write invariants below — same request,
  // same page count, no extra API cost.
  const rawExistingRecords = await registryAt(env).listAll(REGISTRY_TABLE);
  const excludedSingles = new Set(rawExistingRecords.filter(r => isStandalonePost(r) && r.fields['Draft ID'] != null && String(r.fields['Draft ID']).trim()).map(r => String(r.fields['Draft ID'])));
  const existingRecords = rawExistingRecords.filter(r => !isStandalonePost(r));
  for (const rec of existingRecords) {
    if (rec.fields['Draft ID'] && existingPosted.has(String(rec.fields['Draft ID']))) throw new Error('Duplicate registry Draft ID: refusing ambiguous upsert');
    if (rec.fields['Draft ID']) existingPosted.set(String(rec.fields['Draft ID']), {
      posted: rec.fields['Posted Date'] || null, repost: rec.fields['Repost Count'],
      status: rec.fields['Status'] || null, lifetimeCommission: rec.fields['Lifetime Commission'] ?? null,
      lifetimeClicks: rec.fields['Lifetime Clicks'] ?? null,
      linkClicks: rec.fields['Link Clicks'] ?? null, // buildRow's floor for Link Clicks, independent of Impressions
      // A blank stored cell stays null here (2026-10-03), so buildRow leaves it blank rather than
      // writing 0: rows created since carry X views but no Likes/Engagement Rate until read.
      analytics: typeof rec.fields.Impressions === 'number' ? {
        impressions: rec.fields.Impressions, clicks: rec.fields['Link Clicks'] || 0,
        likes: rec.fields.Likes ?? null, bookmarks: rec.fields.Bookmarks ?? null,
        eng: rec.fields['Engagement Rate'] == null ? null : rec.fields['Engagement Rate'] * rec.fields.Impressions,
      } : undefined,
    });
  }
  mark('gumroad+existing');

  const rows = [];
  const lifetimeRows = []; // second-pass upsert: Draft ID + the 3 Lifetime fields (non-fatal if the fields are missing)
  let perTweetPosts = 0; // posts with a per-tweet series this run (plug-funnel coverage)
  const untracked = []; // manual drafts scheduled in Typefully (outside the workflow)
  const manualPublished = []; // manual drafts ALREADY LIVE — skipped by the registry, but countable
  const stalled = [];   // OUR drafts that are finished but have nothing scheduled to publish them
  const failedAccounts = []; // Typefully read failed after retries — skipped, NOT written with partial data
  // TWO PASSES (2026-08-24). Claimant resolution needs the FULL fleet's draft statuses before any
  // row is built: last-line-wins handed a shared lv_ id to whichever fan-out duplicate was ledgered
  // last — 24 PUBLISHED posts earned $0 while deleted/stalled twins held the claim. Pass 1 only
  // fetches; between passes resolveClaimants re-points every shared key at the draft that actually
  // published; pass 2 builds rows exactly as before.
  const threadLanes = loadThreadLanes();
  const fetched = [];
  const articleUrls = new Map(existingRecords.filter((r) => r.fields['Draft ID'] && r.fields['X URL']).map((r) => [String(r.fields['Draft ID']), r.fields['X URL']]));
  // X views (readAccountViews). Without RAPIDAPI_KEY the rows still sync — only views go unread — but
  // the stage fails so the gap is loud rather than silently stale.
  const xv = xViews(env);
  const xStats = { asked: 0, read: 0, unread: 0, failures: 0, days: VIEWS_DAYS };
  const xViewsBroken = []; // accounts whose X read threw — the farm must not judge on their views
  if (!xv.available) { failed('x-views', 'RAPIDAPI_KEY not set — X views unread this run; rows keep their last views (never 0)'); console.warn('⚠️ RAPIDAPI_KEY not set — X views unread this run'); }
  const monitoringAccounts = Object.values(ACCOUNTS);
  const startAccount = (storedHashes?.monitoringAccountOffset || 0) % monitoringAccounts.length;
  const monitoringAccountOffset = (startAccount + 1) % monitoringAccounts.length;
  const orderedAccounts = [...monitoringAccounts.slice(startAccount), ...monitoringAccounts.slice(0, startAccount)];
  for (const acc of orderedAccounts) {
    if (acc.external) continue; // client account (RT bridge only) — never in our registry, reports, or health alarms
    // spine: every draft (all statuses) for the account
    // COMPLETENESS. The paginated reads here used raw fetch with `if (!res.ok) break`, which is
    // indistinguishable from "no more pages": one transient 429 truncated the account mid-scan and the
    // run carried on reporting success over partial data. A short draft list is not a harmless gap — it
    // reads as an account with fewer posts, so impressions, hit-rate and stall counts all shift, and
    // nothing in the log says why. tf.get retries transient failures and throws when it genuinely
    // cannot read; an account that throws is SKIPPED entirely rather than half-written, which leaves
    // its existing Airtable rows untouched (the upsert only touches rows it was handed) until a later
    // run reads it cleanly. Partial truth is the one outcome that must not reach the registry.
    // The draft read is readAccountDrafts, which asks for EVERY draft rather than naming statuses
    // — see the scar in its docblock: three named statuses hid 32 of them and froze the farm.
    let drafts = [], inventoryDrafts = [];
    const analytics = new Map();
    const perTweet = new Map(); // draftId -> per-tweet analytics rows: no source since 2026-09-30, so empty
    try {
      drafts = await readAccountDrafts(tf, acc.socialSetId);
      inventoryDrafts = drafts;
      for (const d of drafts) if (isStandalonePost(d) && !isArticleRow(d, { byDraft, subidsByDraft })) excludedSingles.add(String(d.id));
      drafts = drafts.filter(d => !excludedSingles.has(String(d.id)) && registryMonitoringCandidate(d, {
        existingIds: new Set(existingPosted.keys()), ledgerIds: new Set(byDraft.keys()), laneIds: new Set(threadLanes.keys()), trackAll: !!acc.trackAll,
      }));
      const knownUrls = new Map(existingRecords.filter(hasThreadEvidence).map(r => [String(r.fields['Draft ID']), r.fields['X URL']]));
      const scope = await classifyMonitoringDrafts(tf, acc.socialSetId, drafts, {
        cache: postKinds, budget: classificationBudget, isArticle: (d) => isArticleRow(d, { byDraft, subidsByDraft }),
        knownThreads: new Set(drafts.filter(d => d.x_published_url && knownUrls.get(String(d.id)) === d.x_published_url).map(d => String(d.id))),
      });
      drafts = scope.included;
      for (const id of scope.excluded) excludedSingles.add(id);
      for (const id of scope.deferred) deferredMonitoring.add(id);
      // Cache successful reads even if a later account or provider fails. This
      // does not certify metrics or replace the last successful row hashes.
      if (!DRY) writeFileSync(HASH_FILE, JSON.stringify({ ...storedHashes, postKinds, monitoringAccountOffset }) + '\n');
      for (const id of excludedSingles) existingPosted.delete(id);
      // HEAD METRICS + PER-TWEET ROWS came from Typefully's /analytics/x/posts until 2026-09-30, read
      // right here inside this try — so its 404 skipped every account on every run (see
      // readAccountViews). Views now come from X in their own try below; the per-tweet rows (plug
      // funnel, Tweet Views) have no source, so `perTweet` stays empty and those keys stay frozen at
      // their last values, as rebuild-plug-tweets.mjs already says.
    } catch (e) {
      // Skip the whole account rather than write what we managed to read. Loud on stderr, carried
      // into the heartbeat and the run log, and it flips the sync off green — a truncated read that
      // reports success is exactly the failure this replaces.
      failedAccounts.push({ name: acc.name, error: e.message });
      failed('account-read', `${acc.name}: ${e.message}`);
      console.error(`✗ ${acc.name}: Typefully read failed after retries — SKIPPING (its rows keep their previous values): ${e.message}`);
      continue;
    }
    // Articles' X URLs. Uses nothing the analytics reads above produce; a failed read leaves a URL missing.
    const articleReads = await fillArticleUrls(tf, acc.socialSetId, drafts, {
      isArticle: (d) => isArticleRow(d, { byDraft, subidsByDraft }), knownUrls: articleUrls, budget: classificationBudget });
    if (articleReads.failed) runQuality.warnings.push({ code: 'article-url-read-failed', count: articleReads.failed });
    // VIEWS: their own try, OUTSIDE the account read. A view count nobody read is left unwritten (the
    // row keeps its last value), so a RapidAPI failure is a failed stage, never a skipped account.
    if (xv.available) {
      try {
        const r = await readAccountViews(xv, acc, drafts, { sinceMs: viewsSinceMs });
        for (const [id, m] of r.views) analytics.set(id, m);
        xStats.asked += r.asked; xStats.read += r.views.size; xStats.unread += r.unread; xStats.failures += r.failures;
      } catch (e) {
        xViewsBroken.push(acc.name);
        failed('x-views', `${acc.name}: ${e.message}`);
        console.warn(`  X views ${acc.name} (non-fatal — its rows keep their last views): ${e.message}`);
      }
    }
    const renamed = handleDrift(acc, inventoryDrafts);
    if (renamed) {
      runQuality.warnings.push({ code: 'x-handle-drift', count: 1 });
      console.warn(`  ⚠️ ${acc.name}: posts go out as @${renamed} but accounts.mjs says @${acc.xHandle || acc.handle} — set its xHandle (follower reads fail until then)`);
    }
    fetched.push({ acc, drafts, inventoryDrafts, analytics, perTweet });
  }

  runQuality.monitoringScope = { excludedSingles: excludedSingles.size, deferredDrafts: deferredMonitoring.size, detailReads: DETAIL_READ_BUDGET - classificationBudget.remaining };
  if (xStats.unread) runQuality.warnings.push({ code: 'x-views-unread', count: xStats.unread });
  console.log(xv.available
    ? `  X views (last ${VIEWS_DAYS}d): ${xStats.read} draft(s) read, ${xStats.unread} of ${xStats.asked} post(s) not returned by X — left unwritten, never 0${xStats.failures ? ` · ${xStats.failures} failed RapidAPI read(s)` : ''}`
    : `  X views: not read (no RAPIDAPI_KEY) — every row keeps its last views`);
  mark('typefully');

  // Claimant resolution over the whole fleet's statuses (see the two-pass note above).
  {
    const published = new Set(), known = new Set();
    for (const { inventoryDrafts } of fetched) for (const d of inventoryDrafts) { known.add(String(d.id)); if (d.status === 'published') published.add(String(d.id)); }
    for (const [k, cands] of byLvIdCandidates) byLvId.set(k, resolveClaimants(cands, { published, known }));
    for (const [sub, cands] of bySubidCandidates) {
      const win = resolveClaimants(cands, { published, known });
      const e = bySubid.get(sub);
      if (e && String(e.draftId) !== String(win)) bySubid.set(sub, { ...e, draftId: win });
    }
  }

  // SHARE BACKFILL. Every draft the engine creates asks for share:true (lib.mjs createDraft), so a
  // live public typefully.com/t/<slug> URL exists for all recent work — but drafts from before that
  // default carry none, and their registry rows can only ever show the members-only ?d= URL that
  // 404s for anyone else (the exact complaint behind the 'Share Link' field). Repair forward: PATCH
  // share:true onto ENGINE drafts (ledgered, lane-recorded, or [Infinity]/[Evergreen]/[Harvest]/
  // [Inspiration]-titled) that lack a share_url, capped per run so a bad day can't hammer the API.
  // Manual drafts are NEVER auto-shared — a hand-written draft may be private on purpose. If the
  // endpoint rejects the field once with a non-retryable error, stop trying for the whole run.
  const SHARE_BACKFILL_MAX = 40;   // successes per run — a marathon, not a sprint; the field lands regardless on the next pass
  const SHARE_BACKFILL_STRIKES = 3; // failures before giving up for the run — tolerates one status the endpoint refuses without hammering 40 times
  let shareBackfilled = 0, shareBackfillStrikes = (DRY || args.includes('--no-share-backfill')) ? SHARE_BACKFILL_STRIKES : 0;
  const engineDraft = (d) => byDraft.has(String(d.id)) || threadLanes.has(String(d.id)) || /\[(infinity|cover|evergreen|harvest|inspiration|pot(?:·[a-z0-9-]+)?)\]/i.test(d.draft_title || '');
  const lifetimeBeforeById = new Map();
  const clicksBeforeById = new Map();
  let gumroadHeld = 0;
  for (const { acc, drafts, analytics, perTweet } of fetched) {
    const ctx = { acc, analytics, perTweet, byDraft, linksByDraft, subidsByDraft, byLvId, bySubid,
                  levByLink, lifeByLink, lifeByLinkPrev, threadLanes, gum, gumLife, existingPosted, fuelByTid,
                  asinsByDraft, productRecByAsin, productStats, linkPlatform, gumroadOff };
    for (const d of drafts) {
      if (!d.share_url && shareBackfillStrikes < SHARE_BACKFILL_STRIKES && shareBackfilled < SHARE_BACKFILL_MAX && engineDraft(d)) {
        try {
          const patched = await tf.patchDraft(acc.socialSetId, d.id, { share: true });
          d.share_url = patched?.share_url || (await tf.getDraft(acc.socialSetId, d.id))?.share_url || null;
          if (d.share_url) shareBackfilled++;
          else { shareBackfillStrikes++; runQuality.warnings.push({ code: 'optional-share-backfill-unconfirmed', count: 1 }); }
        } catch (e) {
          shareBackfillStrikes++;
          runQuality.warnings.push({ code: 'optional-share-backfill-failed', count: 1 });
          console.warn(`  share backfill miss (${acc.name} ${d.id}${shareBackfillStrikes >= SHARE_BACKFILL_STRIKES ? ' — giving up for this run' : ''}): ${e.message}`);
        }
      }
      const res = buildRow(d, ctx);
      if (res.kind === 'untracked') { untracked.push(res.untracked); continue; }
      if (res.kind === 'manualPublished') { manualPublished.push(res.manualPublished); continue; }
      if (res.kind === 'skip') continue;
      if (res.kind === 'gumroadHeld') { gumroadHeld++; continue; }
      // A scheduled Manual draft rides BOTH lists: it gets a registry row and stays on the
      // untracked worklist, because the row does not give it the ledger join it is missing.
      if (res.untracked) untracked.push(res.untracked);
      if (res.manualPublished) manualPublished.push(res.manualPublished);
      if (res.stalled) stalled.push(res.stalled);
      if (res.row?.Products) productStats.linked++;
      if (res.hasSeries) perTweetPosts++;
      lifetimeRows.push(res.lifetimeRow);
      lifetimeBeforeById.set(String(res.row['Draft ID']), res.lifetimeBefore);
      clicksBeforeById.set(String(res.row['Draft ID']), res.clicksBefore);
      rows.push(res.row);
    }
  }
  if (gumroadHeld) console.warn(`  ⏸️ ${gumroadHeld} Gumroad-earning row(s) held unwritten (no GUMROAD_ACCESS_TOKEN)`);
  if (shareBackfilled) console.log(`  🔗 share backfill: ${shareBackfilled} draft(s) now carry a public share URL`);
  if (productStats.unknown.size) console.warn(`  🧾 Products board is missing ${productStats.unknown.size} ledgered ASIN(s) — those rows link nothing until products-sync adds them: ${[...productStats.unknown].slice(0, 8).join(', ')}${productStats.unknown.size > 8 ? ', …' : ''}`);

  // Per-account EFFECTIVENESS, not just raw shots: rows/published + attributed revenue + revPerPost,
  // so the retro can redirect generation budget toward the voices that actually convert instead of
  // scaling every page's row count uniformly. Pure aggregation of values already fetched onto each
  // row — no money math, just summing the commission+sales already joined above. Winner counts and
  // winRate retired with the Winner status (2026-09-02): hit-rate judgment is the farm gate's.
  const byAccount = aggregateByAccount(rows);
  // Fleet-health diagnostics (pure, defensive): surface per-account stalls / hit-rate drift / dark
  // attribution the raw counts hide. Folded into `clean` so a green heartbeat can't mask a whole-account
  // publishing stall (the AI-Evolution "47 drafts, 0 scheduled" case). Never throws -> never fails the sync.
  let health = { alarms: [], perAccount: {}, attributionDark: false };
  // The burner (accounts.mjs `burner: true`) is a staging page: its drafts are never meant to queue.
  const healthExclude = Object.values(ACCOUNTS).filter((a) => a.burner).map((a) => a.name);
  try { health = accountHealth(byAccount, { exclude: healthExclude }); } catch (e) { failed('health-calculation', e); console.warn('⚠️ health calc failed:', e.message); }
  // ---- WRITE ONLY WHAT CHANGED ----------------------------------------------------------------
  // Reads stay whole — they are the source of truth, and the cron cadence is mirrored by a pinned
  // constant in the ops dashboard (infinity-ops-view SyncStatus.tsx REGISTRY_CRONS), so the schedule
  // is not ours to change here. The WRITE is the rate-limited half and the one that grew: 674 rows =
  // 68 sequential PATCHes, six times a day, almost all of them re-sending bytes Airtable already has.
  //
  // 'Last Synced' therefore becomes LAST CHANGED on a delta run. That is the honest reading of the
  // field and the more useful one; per-RUN freshness was never really this column's job — the Ops Log
  // heartbeat (logRun -> opsLog) is what the dashboard derives "did it run" from. The stale-hash
  // fallback also rewrites every row at least daily, so no row's timestamp drifts far regardless.
  // Commit lifecycle, windowed metrics and lifetime metrics together. Lifetime-only changes
  // must invalidate the hash, and a failed write must stop the farm from judging stale money.
  const lifetimeByDraft = new Map(lifetimeRows.map((r) => [String(r['Draft ID']), r]));
  const completeRows = rows.map((r) => ({ ...r, ...lifetimeByDraft.get(String(r['Draft ID'])) }));
  const sel = selectChangedRows(completeRows, storedHashes, { force: args.includes('--full') });
  console.log(`→ writing ${sel.write.length}/${rows.length} rows (${sel.full ? `FULL: ${sel.reason}` : `delta — ${sel.skipped} unchanged`})`);
  mark('build');
  // FIELD ORDER IS LOAD-BEARING. retro-core.mjs feeds this file to the LLM as
  // JSON.stringify(...).slice(0, 3000). Measured on logs/registry-2026-08-29.json (5644 chars):
  // byAccount spanned offsets 246->2412, eating 2166 of the budget, so `health` got ~588 chars —
  // about two of six alarm strings — and runSeconds at offset 5625 never arrived at all. The retro
  // was being asked to diagnose a run whose diagnosis had been truncated away. Small
  // decision-relevant fields first; byAccount, the bulk, LAST.
  //
  // `rules` stamps the thresholds that produced these numbers, because laws.json carries no
  // version: the 2026-08-25 lesson was that a threshold change (winClicks/winRevenue -> 500 took
  // the fleet from 160 winners to 17) left 77 days of logs with nothing marking the discontinuity.
  // The winner thresholds themselves retired 2026-09-02; stallDays is what still shapes a count.
  //
  // `coverage` keeps the denominators honest. manualPublished posts are counted but `continue`
  // before rows.push, so winRate = winners/posted and postedRate = posted/rows are computed over
  // REGISTRY rows only — 60 live fleet threads sit outside them. Stating the excluded count next to
  // the rates stops either being read as fleet-wide.
  // NOT ON A DRY RUN (2026-08-31). logRun writes logs/registry-<date>.json, a tracked file the retro
  // loop reads as the record of what the pipeline actually did. An unguarded call meant `--dry`
  // produced a log indistinguishable from a real run — same shape, same rowsWritten, no marker —
  // which would then be committed and read back as history for writes that never happened. Every
  // other side effect in this file is already gated the same way (levDays at :649, Airtable at :655).
  const registryLog = {
    rows: rows.length,
    posted: rows.filter((r) => r.Status === 'Posted').length,
    reposted: rows.filter((r) => r.Status === 'Reposted').length,
    untracked: untracked.length,
    manualPublished: manualPublished.length,
    alarms: health.alarms.length,
    stalled: stalled.length,
    failedAccounts,
    perTweetPosts,
    xViews: xStats, // X views coverage: asked/read/unread/failures over the last `days`
    rowsWritten: sel.write.length,
    rowsSkipped: sel.skipped,
    fullWrite: sel.full,
    shareBackfilled,
    monitoringScope: runQuality.monitoringScope,
    // Products link: rows that carry it, and ASINs the board did not know (products-sync is behind).
    productsLinked: productStats.linked,
    productsUnknown: productStats.unknown.size,
    clean: untracked.length === 0 && health.alarms.length === 0 && failedAccounts.length === 0,
    rules: { stallDays: STALL_DAYS },
    // `orphans` = rows Airtable holds that this run did not build: drafts deleted in Typefully,
    // accounts since removed, anything the spine no longer returns. The upsert never deletes, so
    // they are permanent — frozen analytics and revenue, indistinguishable in the table from a live
    // row, and silently inflating any count read off it. Measured against the live base 2026-08-30:
    // 958 held vs 674 built, and exactly 284 rows with a Last Synced older than three days. Reported
    // rather than deleted: pruning live rows is the operator's call, not the sync's. (The daily full
    // rewrite keeps every BUILT row's Last Synced fresh, so staleness stays a reliable way to spot
    // these even though delta runs no longer touch unchanged rows.)
    coverage: {
      registryRows: rows.length, airtableRows: existingPosted.size,
      orphans: Math.max(0, existingPosted.size - rows.length),
      manualPublishedExcluded: manualPublished.length,
      accountsRead: fetched.length, accountsSkipped: failedAccounts.length,
    },
    phases: PHASE,
    health,
    byAccount,
  };
  // ---- Legacy "🧵 Posts" seen-set -------------------------------------------------------------
  // Individual live pings were merged into the editable Today card. This block retains only the
  // seen-set as rollback memory; its send branch is intentionally disabled below.
  // State is a committed seen-set of tweet ids. The first run (no file) SEEDS silently, and a
  // burst of >25 "new" posts reseeds silently too — that shape is a bootstrap or a backfill,
  // and blasting history into the topic would kill it on day one, the machine-room way.
  const POSTED_SEEN = join(HERE_DIR, 'queues', 'posted-seen.json');
  try {
    const isLive = (st) => isPublished(st); // old Winner spellings tolerated on read until the orphan cleanup
    const seen = existsSync(POSTED_SEEN)
      ? new Set(JSON.parse(readFileSync(POSTED_SEEN, 'utf8')).tids || [])
      : null;
    const liveNow = rows
      .filter((r) => isLive(r.Status) && tweetId(r['X URL']))
      .map((r) => ({ r, tid: tweetId(r['X URL']) }));
    // The editable Today card replaced individual post pings. Keep this seen-set warm solely so a
    // rollback can safely restore the old stream without replaying history.
    if (false && seen && !DRY) {
      const fresh = liveNow.filter((x) => !seen.has(x.tid));
      if (fresh.length && fresh.length <= 25) {
        const fmtT = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
        const lines = fresh.slice(0, 10).map(({ r }) => {
          const led = byDraft.get(String(r['Draft ID']));
          const hook = String(r.Post || '').split('\n')[0].slice(0, 64);
          const bits = [
            led?.topic ? esc(String(led.topic).slice(0, 40)) : null,
            r['Posted Date'] ? `${fmtT(r['Posted Date'])} Saigon` : null,
            `<a href="${r['X URL']}">view</a>`,
          ].filter(Boolean).join(' · ');
          return `🧵 <b>${esc(r.Account || '?')}</b> — ${esc(hook)}\n     ${bits}`;
        });
        const extra = fresh.length > 10 ? `\n\n…and ${fresh.length - 10} more.` : '';
        await telegram(env, lines.join('\n\n') + extra, 'posted');
        console.log(`🧵 posted pings sent: ${fresh.length}`);
      } else if (fresh.length > 25) {
        console.log(`🧵 posted pings skipped: ${fresh.length} at once reads as backfill — reseeding silently`);
      }
    } else if (!seen) console.log('🧵 posted-seen bootstrapped silently (no pings on first run)');
    if (!DRY) writeFileSync(POSTED_SEEN, JSON.stringify({ updatedAt: new Date().toISOString(), tids: liveNow.map((x) => x.tid) }, null, 1) + '\n');
  } catch (e) { failed('posted-state', e); console.warn('posted pings failed:', e.message); }

  console.log(`${rows.length} content rows | ${rows.filter((r) => r.Status === 'Posted').length} posted | ${rows.filter((r) => r.Status === 'Reposted').length} reposted`);
  if (manualPublished.length) {
    const byAcc = manualPublished.reduce((m, p) => (m[p.name] = (m[p.name] || 0) + 1, m), {});
    console.log(`ℹ️ ${manualPublished.length} manual post(s) already LIVE and not in the registry — ${Object.entries(byAcc).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (untracked.length) {
    console.log(`⚠️ ${untracked.length} scheduled post(s) OUTSIDE the workflow (no tracking/revenue attribution):`);
    untracked.forEach((u) => console.log('   ' + u.name + ': ' + u.title + ' → ' + u.when));
  }
  if (health.alarms.length) {
    console.log(`⚠️ ${health.alarms.length} fleet-health alarm(s):`);
    health.alarms.forEach((m) => console.log('   ' + m));
  }
  if (stalled.length) {
    console.log(`⚠️ ${stalled.length} stalled draft(s) — finished, monetized, nothing scheduled to publish them:`);
    for (const t of [...stalled].sort((a, b) => b.days - a.days).slice(0, 10)) {
      console.log(`   ${t.days}d  ${t.name} — ${t.title}${t.product ? ` (${t.product.slice(0, 40)})` : ''}`);
    }
  }
  // ---- PRE-WRITE INVARIANTS — HARD ABORT (operator ruling 2026-08-30) -------------------------
  // A breach here can only mean a bug, so the run refuses to write and leaves the registry at its
  // last good state rather than committing a regression. This is deliberately the strict choice:
  // the alternative (write, then alert) means the corruption is already in the table by the time
  // anyone reads the alert, and the whole point is that this file's history is corruption nobody
  // noticed for weeks.
  //
  // THE ESCAPE HATCH IS REAL AND NECESSARY. A deliberate operator action moves these numbers
  // legitimately — a bulk archive of stalled Typefully drafts shrinks the built count past the 2%
  // drop guard by design (the 2026-08-25 class was the same shape: a threshold edit, 160 winners
  // -> 17). That is why --allow-invariant-breach exists. The workflow must never pass it by
  // default: it is a human saying "yes, I moved the goalposts", not a way to get past a red run.
  // prevBuiltCount comes from the row-hash file, which is written only after a successful write and
  // therefore records what the last GOOD run actually built.
  const reversals = [];
  const breaches = checkInvariants(rows, lifetimeRows, existingPosted, { prevBuiltCount: monitoredPreviousCount(storedHashes, new Set([...excludedSingles, ...deferredMonitoring])), lifetimeBefore: lifetimeBeforeById, clicksBefore: clicksBeforeById, reversalsOut: reversals });
  // Absorbed reversals are written as the new truth but NEVER silently: one action-level Ops Log
  // entry each, so the dashboard's stream shows the money moving and when. This is the line between
  // "the guard let a refund through" and "the guard stopped guarding".
  for (const rv of reversals) {
    const unit = rv.kind === 'clicks' ? ` clicks` : '', sym = rv.kind === 'clicks' ? '' : '$';
    console.warn(`  ↩️ Levanta reversal absorbed: draft ${rv.draftId} lifetime ${sym}${rv.before}${unit} -> ${sym}${rv.after}${unit}`);
    if (!DRY) await opsLog(env, { source: 'registry', level: 'action', event: `Levanta reversal absorbed: draft ${rv.draftId} ${sym}${rv.before}${unit} -> ${sym}${rv.after}${unit}`, detail: `Lifetime ${rv.kind === 'clicks' ? 'clicks' : 'commission'} fell because Levanta's own fresh report revised a past day down (${rv.kind === 'clicks' ? 'a click revision' : 'refund/return'}). The join is intact — yesterday's day-file still reproduced the old figure — so the new lower figure is written as truth instead of freezing the registry (the 2026-08-31 failure mode: one $7.48 refund aborted every row's writes for 7 straight runs).` });
  }
  if (breaches.length) {
    const allow = args.includes('--allow-invariant-breach');
    console.error(`${allow ? '⚠️' : '⛔'} ${breaches.length} pre-write invariant breach(es):`);
    breaches.forEach((b) => console.error(`   • ${b}`));
    // A --dry run REPORTS the breach (that is how you preview one) but must not ping anyone or exit
    // non-zero: dry means no side effects, and its own `return` below is the no-write guarantee.
    if (!allow && DRY) console.error('   (dry — would ABORT the write here)');
    if (!allow && !DRY) {
      if (NOTIFY) await telegram(env, report({
        emoji: '⛔', title: 'Registry sync ABORTED — invariant breach', scope: `${rows.length} rows built, none written`,
        status: `🛑 the registry is UNCHANGED at its last good state`,
        sections: [
          { label: 'BREACHES', body: breaches.map((b) => `• ${esc(b)}`).join('\n') },
        ],
        action: 'If you just made a deliberate change (bulk draft archive, laws.json edit), this is expected — re-run with --allow-invariant-breach. Otherwise something broke: do NOT override.',
      }), 'ops');
      throw new Error(`pre-write invariant breach (${breaches.length}) — refusing to write; re-run with --allow-invariant-breach if a laws.json change is responsible`);
    }
    console.error('   --allow-invariant-breach given — writing anyway.');
  }
  if (DRY) { console.log('(dry — no Airtable writes)'); return; }
  // Standalone farm invocations must not trust an earlier successful stamp while a
  // new write is in progress or has only partially landed. Preserve hashes for retry.
  writeFileSync(HASH_FILE, JSON.stringify({ ...storedHashes, postKinds, metricsComplete: false }) + '\n');
  const singleLabels = standaloneRecordUpdates(rawExistingRecords, excludedSingles);
  if (singleLabels.length) await registryAt(env).update(REGISTRY_TABLE, singleLabels);
  runQuality.monitoringScope.existingSinglesLabelled = singleLabels.length;
  await airtableUpsert(env, sel.write);
  stage('content-write', 'completed');
  let actualRecords = (await registryAt(env).listAll(REGISTRY_TABLE)).filter(r => !isStandalonePost(r) && !excludedSingles.has(String(r.fields['Draft ID'])) && !deferredMonitoring.has(String(r.fields['Draft ID'])));
  // The local hash cannot detect operator edits or external corruption in Airtable. Verify
  // every authoritative row, including skipped delta rows, before farm judgment.
  const expectedRows = completeRows.map(({ 'Last Synced': lastSynced, ...row }) => row);
  let writtenRows = [...sel.write];
  const inspect = () => inspectRegistryQuality({ completeRows, expectedRows, writtenRows, actualRecords,
    levantaByLink: levByLink, byLvId, existingRecords: existingRecords.filter(r => !excludedSingles.has(String(r.fields['Draft ID'])) && !deferredMonitoring.has(String(r.fields['Draft ID']))),
    inventoryDraftIds: fetched.flatMap(({drafts}) => drafts.map(d => String(d.id))),
    analyticsDraftIds: new Set(fetched.flatMap(({analytics}) => [...analytics.keys()])),
    analyticsSinceMs: viewsSinceMs,
    inventoryComplete: failedAccounts.length === 0,
    inventoryCounts: { expectedAccounts: Object.values(ACCOUNTS).filter(a => !a.external).length, accountsRead: fetched.length, accountsSkipped: failedAccounts.length },
    stages: runQuality.stages });
  runQuality.audit = inspect();
  if (runQuality.audit.hardFailure && !runQuality.audit.duplicateDraftIds.length) {
    const driftIds = new Set(runQuality.audit.writeMismatches.map(r => r.draftId));
    const repairs = completeRows.filter(r => driftIds.has(String(r['Draft ID'])));
    if (repairs.length) {
      await airtableUpsert(env, repairs);
      writtenRows = [...new Map([...writtenRows, ...repairs].map(r => [String(r['Draft ID']), r])).values()];
      actualRecords = (await registryAt(env).listAll(REGISTRY_TABLE)).filter(r => !isStandalonePost(r) && !excludedSingles.has(String(r.fields['Draft ID'])) && !deferredMonitoring.has(String(r.fields['Draft ID'])));
      runQuality.audit = inspect();
      runQuality.repairs = { authoritativeRowsRepaired: repairs.length };
    }
  }
  if (runQuality.audit.hardFailure) {
    writeFileSync(HASH_FILE, JSON.stringify({ metricsComplete: false, hashes: {}, postKinds }) + '\n');
    throw new Error('Registry read-back verification failed; farm judgment withheld');
  }
  stage('read-back', 'completed');
  if (!DRY) logRun('registry', { ...registryLog, clean: false, phase: 'content-verified-followups-pending' });
  let reconciliationBlocksFarm = false;
  try {
    const statePath = join(HERE_DIR, 'queues', 'registry-reconciliation.json');
    const previousState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
    const at = registryAt(env);
    const plan = planRegistryReconciliation({ inventory: fetched, expectedAccounts: Object.values(ACCOUNTS).filter(a => !a.external),
      records: actualRecords, harvests: await at.listAll('Harvests'), seeds: await at.listAll('Seeds'),
      previousState, complete: failedAccounts.length === 0,
      convertedNames: Object.values(ACCOUNTS).flatMap(a => a.formerNames || []) });
    const result = await executeRegistryReconciliation({ plan, at, tf, dry: false,
      saveState: state => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n') });
    reconciliationBlocksFarm = result.blockFarm;
    runQuality.reconciliation = result;
    if (result.diagnostics?.length) runQuality.warnings.push({ code: 'lifecycle-unresolved', count: result.diagnostics.length });
    stage('lifecycle-reconciliation', reconciliationBlocksFarm ? 'failed' : 'completed',
      reconciliationBlocksFarm ? `blocks farm judgment; diagnostics: ${[...new Set((result.diagnostics || []).map((x) => x.kind || 'unknown'))].slice(0, 5).join(', ') || 'none recorded'}` : '');
  } catch (e) { reconciliationBlocksFarm = true; failed('lifecycle-reconciliation', e); console.warn('Lifecycle reconciliation failed:', e.message); }
  // Only AFTER the write succeeded: a hash written first would tell the next run that a row Airtable
  // never received is already up to date, and that row would then never be retried.
  try { writeFileSync(HASH_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), metricsComplete: failedAccounts.length === 0 && !reconciliationBlocksFarm && deferredMonitoring.size === 0 && xv.available && !xViewsBroken.length, fullWrittenAt: sel.full ? new Date().toISOString() : storedHashes.fullWrittenAt, count: Object.keys(sel.hashes).length, hashes: sel.hashes, postKinds, monitoringAccountOffset }, null, 0) + '\n'); }
  catch (e) { failed('row-hash', e); console.warn('⚠️ row-hash persist failed (next run writes everything):', e.message); }
  console.log(`✓ Upserted ${sel.write.length} row(s) into "${TABLE}" (${sel.skipped} unchanged, skipped).`);
  // Non-fatal: the core PC upsert is already committed; a transient hiccup in the link
  // backfill must not fail the sync (which would also skip performance.mjs + the heartbeat).
  // The idempotency guard (skip already-linked rows) finishes the backfill on the next run.
  let linked = { fuel: 0, growth: 0, boost: 0 };
  try { linked = await reconcileLinks(env); }
  catch (e) { failed('post-links', e); console.warn('⚠️ link reconcile failed (non-fatal, retried next run):', e.message); }
  console.log(`✓ Reconciled Post links: ${linked.fuel} Fuel Log, ${linked.growth} Growth Log, ${linked.boost} Boost Events.`);
  // THE FARM GATE (2026-09-02) — the referee to this file's sensor. Runs on the rows just written
  // (it re-reads the base itself, so it always judges what Airtable actually holds): inducts bodies
  // that crossed the entry gate, judges attempt/pot verdicts at the 48h mark, moves machine states
  // (Potential -> In Pool -> Seed-Eligible / Retired), flags dormant seeds, and sends the three
  // human-action signals. Same non-fatal isolation as reconcileLinks: a gate hiccup must never take
  // the registry down, and every action it plans is idempotent so the next run simply retries.
  try {
    const { runFarmGate } = await import('./harvest-gate.mjs');
    if (failedAccounts.length) throw new Error(`Farm judgment deferred: incomplete account reads (${failedAccounts.map((a) => a.name).join(', ')})`);
    if (reconciliationBlocksFarm) throw new Error('Farm judgment deferred: unresolved lifecycle records');
    // The gate judges on Impressions (harvest-gate reads a blank as 0): with the X read missing or
    // broken this run, recent posts carry no views, so a 48h verdict would judge a post on nothing.
    // metricsComplete above is false for the same reason, so a standalone gate run defers too.
    if (!xv.available) throw new Error('Farm judgment deferred: X views unread this run (no RAPIDAPI_KEY)');
    if (xViewsBroken.length) throw new Error(`Farm judgment deferred: X views read failed (${xViewsBroken.join(', ')})`);
    await runFarmGate(env, { notify: NOTIFY });
    stage('farm', 'completed');
  } catch (e) { failed('farm', e); console.warn('⚠️ farm gate failed (retried next run):', e.message); }
  // SCHEMA DRIFT WATCH — the forward-sync mechanism the base never had. The repo is the source of
  // truth for naming (lanes.mjs: cover/harvest/seed since 2026-08-29), but nothing ever carried a
  // rename INTO Airtable: 'Recreation' select options, 'Mold ID' columns and a members-only
  // Typefully Link formula all sat there for weeks because no process owned noticing. This compares
  // the live schema against airtable-schema.mjs's manifest and logs any drift as an Ops Log warn —
  // visible on the dashboard's Ops stream — with the exact click-path to fix what the API cannot
  // rename (select option labels, formulas). Never fatal, never auto-renames: the accounts-sync
  // 'Active' lesson is that an engine silently reverting operator edits is its own bug class.
  try {
    const drift = await checkRegistrySchema(env);
    if (drift.length) {
      runQuality.warnings.push({ code: 'schema-drift', count: drift.length });
      console.warn(`⚠️ Airtable schema drift (${drift.length}):`);
      drift.forEach((s) => console.warn(`   • ${s}`));
      await opsLog(env, { source: 'registry', level: 'warn', event: `Airtable schema drifted from repo conventions (${drift.length} finding${drift.length > 1 ? 's' : ''})`, detail: drift.join('\n') });
    }
  } catch (e) { failed('schema-check', e); console.warn(`  (schema drift check skipped: ${e.message})`); }
  // Daily audience snapshot — idempotent (upsert on Key), so the 4h cadence just converges each
  // day's row to its end-of-day value. Non-fatal: a followers hiccup must never take the registry
  // down. X has no history, so a day no run could read stays a gap (its neighbours' deltas go blank).
  // No RAPIDAPI_KEY: nothing is written and the run says so (followers-no-source), never a 0.
  // --no-followers (owner 2026-11-01, RapidAPI budget: Twttr API Basic is 1,000 requests/month): the
  // scheduled run passes it on every day but Monday, so the audience snapshot is weekly. The days
  // between stay gaps (unknown, never 0), exactly as a day no run could read.
  let followers = { rows: 0, failed: [], calls: 0, skipped: args.includes('--no-followers') };
  if (followers.skipped) console.log('  followers: skipped (--no-followers; weekly on Mondays to stay inside the RapidAPI budget)');
  else {
    try { followers = await syncFollowers(env); }
    catch (e) { failed('followers', e); console.warn('⚠️ follower snapshot failed (non-fatal, retried next run):', e.message); }
  }
  if (followers.noSource) runQuality.warnings.push({ code: 'followers-no-source', count: followers.failed.length });
  else if (followers.failed.length) failed('follower-accounts', `unread: ${followers.failed.join(', ')}`);
  if (!followers.skipped) console.log(followers.noSource
    ? `⚠️ Followers: RAPIDAPI_KEY not set — "${ACCOUNT_METRICS_TABLE}" left unwritten for ${followers.failed.length} pages (unknown, not 0).`
    : `✓ Followers: ${followers.rows} day-rows upserted into "${ACCOUNT_METRICS_TABLE}" from X (${followers.calls} twitter241 calls)${followers.failed.length ? ` (unread, no row: ${followers.failed.join(', ')})` : ''}.`);
  // Durable follow-up worklist: persist untracked posts so they are a list a human/retro can drain to
  // zero, not just a transient ping. Cleared to [] when none remain. (IMPROVEMENTS #388/#271 — surfacing
  // half; auto-minting a backfill subid stays human-gated since it touches the subid/publish path.)
  writeFileSync(join(HERE_DIR, 'queues', 'untracked-followups.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), count: untracked.length, posts: untracked }, null, 1) + '\n');
  // FLEET-HEALTH ALARMS — a memory, and a ping only when the picture CHANGES (2026-08-30).
  // These used to ride the sync's Telegram heartbeat, where they fired on every one of six daily runs
  // and never cleared — the same "Julian: draft backlog rotting" line twelve days running, which is
  // how `clean` came to be false for 55 days and the one channel that must be able to say THE SYNC IS
  // BROKEN went permanently red.
  //
  // They were first moved to the Morning Brief alone. That was wrong on a fact I had not checked:
  // brief.yml is state=disabled_manually (since 2026-07-27), so the alarms reached nobody at all. The
  // brief still renders them (brief.mjs fleetHealth) for whenever it comes back; this adds a second,
  // independent outlet that does not depend on it.
  //
  // TRANSITIONS ONLY, never level. A ping fires when an alarm APPEARS or CLEARS and at no other time,
  // so a stable fleet is silent and a standing alarm never re-shouts. That is what makes this safe to
  // put back on the same channel the level-based version poisoned.
  //
  // State semantics copied from posted-seen.json below: a MISSING file bootstraps silently (nothing
  // is "new" on the first run, which would otherwise flag every standing alarm at once), an empty one
  // genuinely means nothing was seen, and the set is REWRITTEN rather than unioned each run — so an
  // alarm that clears and later returns is correctly new again. Non-fatal throughout: a corrupt state
  // file must never fail the sync, and must never cost it a ping it would otherwise have sent.
  let healthDelta = { fresh: [], cleared: [], bootstrapped: false, shouldPing: false };
  try {
    const HEALTH_STATE = join(HERE_DIR, 'queues', 'health-alarm-state.json');
    const prevKeys = existsSync(HEALTH_STATE) ? (JSON.parse(readFileSync(HEALTH_STATE, 'utf8')).keys || []) : null;
    healthDelta = healthTransitions(health.alarms, prevKeys);
    if (!DRY) writeFileSync(HEALTH_STATE, JSON.stringify({
      updatedAt: new Date().toISOString(), bootstrapped: healthDelta.bootstrapped,
      count: healthDelta.annotated.length, newCount: healthDelta.fresh.length,
      cleared: healthDelta.cleared, alarms: healthDelta.annotated, keys: healthDelta.keys,
    }, null, 1) + '\n');
    if (healthDelta.bootstrapped) console.log('🩺 health-alarm state bootstrapped silently (nothing marked new on the first run)');
  } catch (e) { failed('health-state', e); console.warn('⚠️ health-alarm state skipped:', e.message); }
  // Leak SLOs: judge the three worklists on duration and trend, not level (see evaluateLeakSlos).
  // Non-fatal like every other state file here.
  let leaks = { breaches: [], history: [] };
  try {
    const LEAK_STATE = join(HERE_DIR, 'queues', 'leak-slo-state.json');
    const prev = existsSync(LEAK_STATE) ? JSON.parse(readFileSync(LEAK_STATE, 'utf8')).history : [];
    leaks = evaluateLeakSlos({
      untracked: untracked.length, stalled: stalled.length, manualPublished: manualPublished.length,
      oldestStalledDays: stalled.reduce((m, t) => Math.max(m, t.days || 0), 0),
    }, prev);
    if (!DRY) writeFileSync(LEAK_STATE, JSON.stringify({
      updatedAt: new Date().toISOString(), slos: LEAK_SLOS,
      breaches: leaks.breaches, history: leaks.history,
    }, null, 1) + '\n');
    if (leaks.breaches.length) { console.log(`⚠️ ${leaks.breaches.length} leak SLO breach(es):`); leaks.breaches.forEach((b) => console.log('   • ' + b)); }
  } catch (e) { failed('leak-state', e); console.warn('⚠️ leak SLO check skipped:', e.message); }
  // Same treatment for stalls: a durable list a human or the retro can drain to zero, rather than a
  // ping that scrolls away. These are recoverable — the drafts still exist with their links live, so
  // this is inventory to schedule, not waste to write off.
  writeFileSync(join(HERE_DIR, 'queues', 'stalled-drafts.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), count: stalled.length, stallDays: STALL_DAYS, drafts: stalled.sort((a, b) => b.days - a.days) }, null, 1) + '\n');
  // Quiet-mode heartbeat: a HEALTHY sync stays silent — the ☀️ Morning Brief (brief.mjs, 9am Saigon)
  // is the daily "it ran" signal now, so this only speaks when something is off (untracked posts /
  // health alarms). `--loud` forces a send for manual runs.
  const cnt = (st) => rows.filter((r) => r.Status === st).length;
  // INTEGRITY, NOT FLEET HEALTH (2026-08-30). This gate used to be
  //   untracked || health.alarms || stalled || failedAccounts
  // which mixed "did I read and write everything correctly" with "is the content team keeping up".
  // The second half is never zero, so the first half could never be heard: `clean` last went true on
  // 2026-07-05 and the heartbeat has shipped ⚠️ on every run for the eight weeks since, carrying the
  // identical "draft backlog rotting" line for twelve days straight. A channel that is always red
  // carries no information, and this is the channel that has to be able to say THE SYNC IS BROKEN.
  //
  // So the heartbeat now speaks only for the sync's own correctness: an account it could not read,
  // and posts publishing with no attribution. Draft backlogs, hit-rate drift and stalled inventory
  // are real, but they are the operator's morning reading, not a pager — brief.mjs carries them now
  // (see healthAlarmState below, which marks them new vs ongoing so a standing alarm stops shouting).
  const integrity = failedAccounts.length || untracked.length;
  if (NOTIFY && (integrity || process.argv.includes('--loud'))) await telegram(env, report({
    emoji: '🩺', title: 'Registry Synced', scope: 'all accounts',
    status: `${integrity ? '⚠️' : '✅'} <b>${rows.length}</b> posts indexed${failedAccounts.length ? ` · ⛔ ${failedAccounts.length} account(s) UNREAD` : ''}${untracked.length ? ` · ${untracked.length} untracked (attribution leak)` : ''}`,
    sections: [
      ...(failedAccounts.length ? [{ label: 'INCOMPLETE — ACCOUNTS NOT READ', body:
        failedAccounts.map((f) => `• <b>${esc(f.name)}</b>: ${esc(f.error.slice(0, 120))}`).join('\n')
        + '\n<i>Skipped rather than half-written, so their rows still hold the last good read. Every count below excludes them.</i>' }] : []),
      { label: 'STATE', body:
        `${cnt('Scheduled')} scheduled · ${cnt('Posted')} posted · ${cnt('Reposted')} reposted · ${cnt('Draft')} draft${untracked.length ? ` · ⚠️ ${untracked.length} untracked` : ''}` },
    ],
  }), 'ops');
  else console.log(`quiet: sync integrity clean — ${health.alarms.length} fleet-health alarm(s), ${stalled.length} stalled draft(s)`);

  // ---- FLEET HEALTH: one ping per CHANGE, and never otherwise ---------------------------------
  // Deliberately a SEPARATE message from the integrity heartbeat above, which stays about the sync's
  // own correctness. This one is about the fleet, fires only on a transition, and is silent on a
  // bootstrap run (where "new" would mean every standing alarm at once).
  //
  // Routed to 'ops', not 'alerts': a page is for something that needs hands NOW, and a page that also
  // carries backlog drift is the thing this branch removed. fix-untracked draws the same line with
  // `needsHuman ? 'alerts' : 'ops'`.
  //
  // NOT re-notified while an alarm stands open. That is the explicit trade for putting fleet health
  // back on this channel at all: a standing alarm is visible in the run log, in
  // queues/health-alarm-state.json and on the dashboard, and shouting about it on a schedule is
  // exactly what made the old heartbeat unreadable. A weekly nudge would be a small addition here if
  // that silence ever proves too quiet.
  if (!DRY && NOTIFY && healthDelta.shouldPing) {
    const short = (m) => esc(String(m).split('→')[0].trim().slice(0, 150)); // drop the "→ DO THIS" tail; the log has it in full
    await telegram(env, report({
      emoji: '🩺', title: 'Fleet health changed', scope: `${health.alarms.length} alarm(s) open`,
      status: `${healthDelta.fresh.length ? `🆕 <b>${healthDelta.fresh.length}</b> new` : ''}${healthDelta.fresh.length && healthDelta.cleared.length ? ' · ' : ''}${healthDelta.cleared.length ? `✅ <b>${healthDelta.cleared.length}</b> cleared` : ''}`,
      sections: [
        ...(healthDelta.fresh.length ? [{ label: 'NEW', body: healthDelta.fresh.map((a) => `• ${short(a.text)}`).join('\n') }] : []),
        ...(healthDelta.cleared.length ? [{ label: 'CLEARED', body: healthDelta.cleared.map((k) => `• ${esc(k)}`).join('\n') }] : []),
      ],
    }), 'ops');
    console.log(`🩺 fleet health changed: ${healthDelta.fresh.length} new, ${healthDelta.cleared.length} cleared — pinged ops`);
  }
  // NB: no separate "Untracked Posts" alert here anymore — fix-untracked.mjs runs right after this
  // sync (same workflow) and sends ONE problem→auto-fixed→left-for-you story to the needs-you topic,
  // so the user never sees a bare problem and a fix as two disconnected pings. The Morning Brief's
  // NEEDS YOU section reads untracked-followups.json as the daily backstop if that step ever fails.
  if (untracked.length) console.log(`${untracked.length} untracked -> fix-untracked.mjs (next step) reports the merged story`);
  const qualityStatus = runQuality.stages.some(s => s.status === 'failed') ? 'failed'
    : (runQuality.warnings.length || runQuality.audit?.warnings?.length ? 'degraded' : 'completed');
  if (!DRY) logRun('registry', { ...registryLog, phase: 'finished', clean: registryLog.clean && qualityStatus === 'completed',
    qualityStatus, stages: runQuality.stages });
  if (runQuality.stages.some(s => s.status === 'failed')) throw new Error('Registry completed with failed stages; see registry-latest.json');
}
// Entry guard (2026-08-30): this module now EXPORTS pure helpers (aggregateByAccount, buildRow) so
// they can be unit-tested offline. Without the guard, importing it to reach those would execute the
// whole live sync. Same idiom as backlog-triage.mjs and a dozen others here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => persistQuality()).catch((e) => {
    console.error('ERROR:', e.stack || e.message);
    try { persistQuality(e); } catch { console.error('Unable to persist registry quality report'); }
    process.exitCode = 1;
  });
}
