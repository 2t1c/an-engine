// funnel-watch.mjs — 🚨 daily funnel anomaly watchdog: flags when the money machine is leaking
// WITHOUT the operator having to go look. Born from the Aug 5 post-mortem: 1,122 clicks earned $0
// and nothing said a word — the link-sentinel money canary only fires at absolute fleet $0, so a
// "suspiciously low" day (the expensive kind of silent) sailed past every guard.
//
// Five detectors, each judged against OUR OWN trailing baseline (no static thresholds to rot):
//   A. EPC COLLAPSE — clicks are flowing but earning far less than these clicks normally earn.
//      Window D-5..D-3 (matured: Amazon attribution lags days, so judging yesterday would false-
//      alarm daily) vs baseline D-33..D-6. Catches: attribution breaks, product-CVR collapse,
//      the NAD+/repost class of leak. Quantifies the $ gap so the alert says what it's worth.
//   B. VIRAL-BUT-CLICKLESS — a post with big views and ~no link clicks. Views prove the audience
//      came; no clicks means the plug is missing/dead/unrendered. Judged per POST (D-3..D-2, old
//      enough that clicks have synced) so one broken banger can't hide inside a healthy fleet avg.
//   C. CLICK-VOLUME COLLAPSE — a posting day whose fleet clicks crater vs the 28d median. Clicks
//      are destination-measured with no lag, so this fires FAST (a day after breakage) even
//      before commission data matures enough for A.
//   D. PHANTOM CLICKS — clicks are recorded but never ARRIVE: Levanta bills a click at its own
//      redirect, while `detailPageViews` only counts a real landing on the Amazon product page.
//      Healthy traffic runs ~1 DPV per click (Jul 3-Aug 28: every single day sat at 100-110%,
//      never once below 100). Born from the 2026-08-29 incident: 1,995 clicks came in at 12.5%
//      DPV/click, 96% of them on ten links from one mint batch, and fleet EPC "fell" 73% ($0.69
//      -> $0.19). Most of that turned out to be INGESTION, not loss — see THE PATIENCE RULE below:
//      the same day later backfilled to Aug-28-level commission while being watched. D therefore
//      judges only days the rule calls settled; on settled data the arrival floor is hard (100.9%
//      min over 43 days) and a real repeat of the signature stays unmissable. A/B/C were all
//      structurally blind to it — A averages a 3-day window so the healthy neighbours diluted the
//      ratio to 0.85 (threshold 0.5), B needs ~no clicks and these had hundreds, C needs clicks to
//      CRATER and these DOUBLED. Cheap: detailPageViews already rides in the rows A and C pull.
//   E. REDIRECT SURVIVAL COLLAPSE — the hop BEFORE D's. D watches Levanta -> Amazon; nothing
//      watched X -> lvnta.com, where Levanta's full-page "Open in Amazon?" tap gate sits. The
//      reader already said yes and still never arrived. `Redirect Survival %` has measured that
//      hop since 2026-08-17 and NOTHING consumed it — weekly-metrics and two docs were the only
//      readers — so a thread bleeding 90% of its taps raised nothing. Judged per POST (like B),
//      on settled days only (like D: same Levanta feed, same patience rule). Tuned to breakage,
//      not to the soft band: survival predicts money 3x across its range, but that gradient is
//      traffic quality the operator steers with copy, while a thread under 30% of fleet normal is
//      a broken hop. Two false-positive classes are refused in the verdict itself — stale stored
//      readings and the direct-link rail — both measured on the live registry, both documented there.
//
// Zero-noise: healthy days send NOTHING (alerts topic = needs attention, per the watchdog
// convention). Any firing detector sends ONE message to the alerts topic. logRun on every real run,
// never on --dry: a dry run writes nothing (no Telegram, no logs/ file, no Ops Log line).
//
// CLICK METHODOLOGY (hard-won 2026-08-08): Levanta /reports returns one row per (date, link, ASIN)
// and REPEATS the link's click count on every halo-ASIN row — clicks MUST be deduped as
// max-per-(date,link) then summed (same rule as registry-sync/link-sentinel). Commission IS
// per-row additive. Summing clicks naively over-counts ~6x and would bury every EPC signal.
//
//   node funnel-watch.mjs          # check; alert to Telegram 'alerts' topic only if abnormal
//   node funnel-watch.mjs --dry    # console only: no Telegram, no logs/ file, no Ops Log line
// Env floors (all optional): FW_EPC_MIN_CLICKS=150 FW_EPC_RATIO=0.35 FW_VIRAL_VIEWS=200000
//                            FW_VIRAL_MAX_CLICKS=10 FW_CLICKS_RATIO=0.30
//                            FW_SURVIVAL_RATIO=0.30 FW_SURVIVAL_MIN_CLICKS=100
import { isStandalonePost } from './monitoring-scope.mjs';
import { loadEnv, requireEnv, airtable, levanta, telegram, esc, report, logRun, dashLink } from './lib.mjs';
import { REGISTRY_TABLE } from './config.mjs';

const DRY = process.argv.includes('--dry');
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const EPC_MIN_CLICKS = num(process.env.FW_EPC_MIN_CLICKS, 150); // window volume before A may judge
const EPC_RATIO = num(process.env.FW_EPC_RATIO, 0.5);           // window EPC below this × baseline = collapse.
// Calibrated 0.35 -> 0.5 against history (2026-08-08 forensic audit): the worst real leak week
// (wk Jul 20: 3,303 clicks at $0.176 vs $0.42 baseline = ratio 0.42, NAD+ eating 57% of clicks)
// would have slipped past 0.35, while every healthy week sits at ratio >= 0.65 — 0.5 splits them.
const VIRAL_VIEWS = num(process.env.FW_VIRAL_VIEWS, 200_000);   // a post this big MUST show click flow
const VIRAL_MAX_CLICKS = num(process.env.FW_VIRAL_MAX_CLICKS, 10);
const CLICKS_RATIO = num(process.env.FW_CLICKS_RATIO, 0.30);    // day clicks below this × median = collapse
// D's floors. Baseline DPV/click has never dropped below 1.00 in two months of history and the
// 08-29 incident landed at 0.125, so 0.5 × baseline sits with ~2x margin on the healthy side and
// ~4x on the anomaly side — wide enough that ordinary daily wobble can never reach it.
const PHANTOM_RATIO = num(process.env.FW_PHANTOM_RATIO, 0.5);        // day DPV/click below this × baseline = phantom
const PHANTOM_MIN_CLICKS = num(process.env.FW_PHANTOM_MIN_CLICKS, 150); // day volume before D may judge
// E's floors. Measured 2026-09-18 over 422 threads >10k impressions since Aug 1: survival bands
// predict money hard — under 35% earns $0.085/1k impressions and 75%+ earns $0.236, and the gap is
// NOT only the missing clicks, because $/AFFILIATE CLICK rises across the same bands too ($0.287 ->
// $0.522). Low survival is a traffic-quality signal as much as a toll, which is why E is tuned to
// catch BREAKAGE and deliberately ignores the soft band: a thread at 35% is a copy/audience problem
// the operator steers with writing, not an alarm.
//
// The multiplier sits in a real gap rather than on a judgement call. Over 90 days of rows with
// >=100 link clicks, sweeping 0.25 -> 0.40 x the trailing median fires on the SAME 12 threads —
// nothing at all lives between 17.9% and 30.9%. 0.30 is the middle of that empty band, so neither
// edge is load-bearing and ordinary drift cannot walk a thread across it. At 0.55 the count jumps
// to 19 (0.40/day since the directLink A/B ended) by reaching into the soft band; at 0.30 it is
// 0.07/day — two threads in the last 30 days, both of which lost ~90% of their taps.
const SURVIVAL_RATIO = num(process.env.FW_SURVIVAL_RATIO, 0.30);       // post survival below this x fleet median = collapse
const SURVIVAL_MIN_CLICKS = num(process.env.FW_SURVIVAL_MIN_CLICKS, 100); // link clicks before E may judge

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(Date.now() - n * 864e5);
const money = (n) => `$${(n || 0).toFixed(2)}`;
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---- Pure verdicts (exported for test-scaffolds, same pattern as canaryVerdict/dailyRunStatus) ----

/** A: clicks flowed but earned far below what these clicks normally earn. Needs a real baseline
 *  (>= $20 realized) and real window volume, so a quiet store or thin day can never false-alarm. */
export function epcCollapseVerdict({ winClicks, winComm, baseClicks, baseComm, minClicks = EPC_MIN_CLICKS, ratio = EPC_RATIO, minBaseComm = 20 }) {
  const baseEpc = baseClicks > 0 ? baseComm / baseClicks : 0;
  const winEpc = winClicks > 0 ? winComm / winClicks : 0;
  const fire = winClicks >= minClicks && baseComm >= minBaseComm && baseEpc > 0 && winEpc < baseEpc * ratio;
  return { fire, winEpc, baseEpc, atRisk: fire ? (baseEpc - winEpc) * winClicks : 0 };
}

/** B: a single post with viral views and ~no link clicks — the plug is missing, dead, or unrendered. */
export function viralClicklessVerdict({ views, clicks, minViews = VIRAL_VIEWS, maxClicks = VIRAL_MAX_CLICKS }) {
  return (views || 0) >= minViews && (clicks || 0) <= maxClicks;
}

/** C: a day that posted normally but whose fleet clicks cratered vs the trailing median. minMedian
 *  keeps a naturally tiny store from alarming on noise; minPosted keeps no-post days (outages have
 *  their own alerts) from double-alarming here. */
export function clickCollapseVerdict({ dayClicks, medClicks, postedCount, ratio = CLICKS_RATIO, minMedian = 30, minPosted = 2 }) {
  return postedCount >= minPosted && medClicks >= minMedian && dayClicks < medClicks * ratio;
}

// ---- THE PATIENCE RULE (2026-08-31, measured the expensive way) --------------------------------
// Levanta's /v1/reports is NOT co-temporal per row and takes ~2 days to finish a date:
//   - a date's first rows appear ~5h after the day ends (UTC); before that the day reads as zero
//   - commission/orders: ~80% in at 24h, 100% by ~46h (every settled day Jul 3-Aug 28 was done <46h)
//   - clicks keep climbing past 26h; detailPageViews lag clicks HARDEST — 2026-08-29 read 12.5%
//     arrival mid-ingestion and $375 of commission, then backfilled to ~105%-track and $658 while
//     we watched. The row's `final` flag does not mean data-final (false on 10-day-old rows).
// So: NO verdict of any kind on a day younger than 48h past its UTC day end. A missing or ugly
// number inside that window is ingestion, not an incident. The 08-29 false alarm (a retracted
// "~$690 leak", a held PR) is what this rule costs when it does not exist.
export const LEV_SETTLE_HOURS = 48;

/** Pure: is this UTC day old enough that its Levanta numbers may be judged at all? */
export const levDaySettled = (day, now = Date.now()) =>
  now - Date.parse(`${day}T23:59:59.999Z`) >= LEV_SETTLE_HOURS * 3600e3;

/** D: clicks recorded that never landed on the product page. Judged per DAY (not a multi-day
 *  window like A) precisely because averaging is what hid the 08-29 incident: one phantom day
 *  beside two healthy ones reads as merely soft. `phantom` estimates how many of the day's clicks
 *  never arrived, by scaling the day's DPV back up at the baseline's own arrival rate — that count,
 *  not the raw click total, is what the operator needs to discount the day's EPC by. */
export function phantomClickVerdict({ dayClicks, dayDpv, baseClicks, baseDpv, minClicks = PHANTOM_MIN_CLICKS, ratio = PHANTOM_RATIO, minBaseClicks = 300 }) {
  const baseRate = baseClicks > 0 ? baseDpv / baseClicks : 0;
  const dayRate = dayClicks > 0 ? dayDpv / dayClicks : 0;
  const fire = dayClicks >= minClicks && baseClicks >= minBaseClicks && baseRate > 0 && dayRate < baseRate * ratio;
  return { fire, dayRate, baseRate, phantom: fire ? Math.max(0, Math.round(dayClicks - dayDpv / baseRate)) : 0 };
}

/** E: clicks that never made it OFF X. D watches the Levanta->Amazon hop (detailPageViews per
 *  click); nothing watched the hop before it — X -> lvnta.com, where Levanta's interstitial tap
 *  gate sits. `Redirect Survival %` has measured that hop all along (metrics.mjs redirectSurvival,
 *  Levanta clicks / Typefully clicks, already null on a sick sensor) and NOTHING consumed it: the
 *  only readers were weekly-metrics and two docs, so a thread bleeding 60% of its taps produced no
 *  alert at any point.
 *
 *  Judged per POST, like B and for the same reason — the fleet median is a healthy ~60%, so one
 *  thread at 30% averages away to nothing. Judged against the fleet's OWN trailing median rather
 *  than a fixed floor, like every other detector here.
 *
 *  AGE IS THE TRAP. Measured 2026-09-18: survival reads 33.4% pooled at 0-1 days old and 63.8% at
 *  2-3 days, because X's click sensor is instant and Levanta's lags. Its numerator is Levanta
 *  clicks — the same feed D watches — so E is bound by THE PATIENCE RULE exactly like D: no
 *  verdict on a day younger than 48h. The three worst-looking rows on the live registry today
 *  (0.0% survival on 125-189 clicks) are all D-2/D-1 and all just un-ingested.
 *
 *  TWO FALSE-POSITIVE CLASSES, both measured rather than imagined, both refused here:
 *
 *  1. FOSSILS. `Redirect Survival %` is written by registry-sync as lifetime-Levanta / Typefully
 *     clicks, and redirectSurvival() nulls the pair when the numerator overtakes the denominator.
 *     A null OMITS the key, so the last pre-crossing reading stands forever. 13 of 230 rows with
 *     >=100 clicks are provably too low that way, 5 of them frozen at 0.0% on rows that have since
 *     banked real money (Magnus 2026-08-17: 888 clicks, $186.84, stored 0.0%). The row disproves
 *     itself: `Link Clicks` is MAX(Typefully, Levanta) and therefore >= the honest denominator, so
 *     affiliate/link is a LOWER BOUND on true survival. A stored value under that bound is stale,
 *     not a leak. One-sided, so this can only ever suppress an alert, never invent one.
 *
 *  2. THE DIRECT RAIL. A directLink account ships the raw Amazon URL, so Levanta counts 0 clicks
 *     BY CONSTRUCTION while Amazon still pays (accounts.mjs: the A/B ran on Magnus and ended
 *     2026-08-18). Commission with no affiliate click is proof the destination works — it is the
 *     one reading that cannot mean a broken hop. */
export function survivalCollapseVerdict({ survival, linkClicks, affClicks, commission = 0, baseSurvival, minClicks = SURVIVAL_MIN_CLICKS, ratio = SURVIVAL_RATIO, minBase = 0.3 }) {
  if (!Number.isFinite(survival) || !Number.isFinite(linkClicks) || !Number.isFinite(baseSurvival)) return { fire: false };
  // Guard 1: the row's own click columns put a floor under true survival that the stored value breaks.
  const bound = Number.isFinite(affClicks) && linkClicks > 0 ? Math.min(1, affClicks / linkClicks) : 0;
  if (survival < bound - 0.02) return { fire: false, stale: true, survival, bound };
  // Guard 2: it earned without the redirect, so the redirect is not what is missing.
  if ((commission || 0) > 0 && affClicks === 0) return { fire: false, directRail: true, survival };
  const fire = linkClicks >= minClicks && baseSurvival >= minBase && survival < baseSurvival * ratio;
  // What the gap is worth in clicks: taps this post won on X that a normal thread would have
  // delivered to the destination and this one did not.
  return { fire, survival, baseSurvival, lostClicks: fire ? Math.max(0, Math.round(linkClicks * (baseSurvival - survival))) : 0 };
}

// ---- IO ------------------------------------------------------------------------------------------

// Levanta D-33..D-1 in one pull: per-day deduped clicks + per-day commission + per-day deduped
// detail-page-views. detailPageViews is a LINK-level figure restated on every halo-ASIN row exactly
// like clicks, so it takes the same max-per-(date,link) dedupe — summing it would inflate the
// arrival rate and mask the very gap D exists to see. sourceId is kept so D can name the threads.
async function levantaDaily(env) {
  const rows = await levanta(env).listReports({ start: daysAgo(33), end: daysAgo(1) });
  const clickMax = new Map(); // `${day}|${link}` -> max clicks across halo rows
  const dpvMax = new Map();   // `${day}|${link}` -> max detailPageViews across halo rows
  const commByDay = new Map();
  const sourceOf = new Map(); // link id -> its subid, for the offender list
  for (const r of rows) {
    const id = r.link?.id; const day = String(r.date || '').slice(0, 10);
    if (!id || !day) continue;
    const k = `${day}|${id}`;
    const c = Number(r.clicks) || 0;
    if (c) { if (c > (clickMax.get(k) || 0)) clickMax.set(k, c); }
    const d = Number(r.detailPageViews) || 0;
    if (d > (dpvMax.get(k) || 0)) dpvMax.set(k, d);
    if (r.link?.sourceId && !sourceOf.has(id)) sourceOf.set(id, r.link.sourceId);
    commByDay.set(day, (commByDay.get(day) || 0) + (Number(r.commissionEarned) || 0));
  }
  const clicksByDay = new Map(), dpvByDay = new Map();
  for (const [k, c] of clickMax) { const day = k.slice(0, 10); clicksByDay.set(day, (clicksByDay.get(day) || 0) + c); }
  for (const [k, d] of dpvMax) { const day = k.slice(0, 10); dpvByDay.set(day, (dpvByDay.get(day) || 0) + d); }
  // Per-link view of one day, worst arrival rate first — what turns "the day is wrong" into "pull these threads".
  const linksOn = (day) => [...clickMax].filter(([k]) => k.slice(0, 10) === day)
    .map(([k, c]) => { const id = k.slice(11); return { id, clicks: c, dpv: dpvMax.get(k) || 0, source: sourceOf.get(id) || id }; })
    .sort((a, b) => (a.dpv / (a.clicks || 1)) - (b.dpv / (b.clicks || 1)) || b.clicks - a.clicks);
  const winSum = (map, from, to) => { let s = 0; for (const [d, v] of map) if (d >= from && d <= to) s += v; return s; };
  return { clicksByDay, commByDay, dpvByDay, linksOn, winSum };
}

// Registry: posted-class rows from the last 4 days (feeds B's per-post view and C's posted-count).
async function recentPosts(env) {
  const base = env.REGISTRY_BASE_ID;
  const posted = ['Posted', 'Winner', 'Repost Candidate', 'Reposted'];
  const formula = `AND(OR(${posted.map((s) => `{Status}='${s}'`).join(',')}),IS_AFTER({Posted Date},DATEADD(NOW(),-4,'days')))`;
  // PAGINATED (2026-08-30). This took one page and stopped — a hard 100-row cap on the input to the
  // daily money-leak alarm. Four days of fleet output sits under that today, so it has not bitten
  // yet, but "the leak detector silently samples the first 100 rows" is not a property to leave to
  // posting volume. listAll retries and throws rather than returning a short read.
  return (await airtable(env, base).listAll(REGISTRY_TABLE, {
    formula, fields: SURVIVAL_FIELDS.concat(['Impressions', 'X URL']),
  })).filter(r => !isStandalonePost(r)).map(mapPost);
}

// The columns E needs on a row, shared by the judged pull and the baseline pull below.
const SURVIVAL_FIELDS = ['Type', 'Post', 'Account', 'Lifetime Clicks', 'Affiliate Clicks', 'Posted Date', 'Redirect Survival %', 'Link Clicks', 'Lifetime Commission', 'Commission'];

const mapPost = (x) => ({
  id: x.id,
  account: x.fields.Account || '?', hook: String(x.fields.Post || '').split('\n')[0].slice(0, 48),
  // The paying clicks, not MAX(Typefully, Levanta) over every link (docs/money-columns.md).
  // Nothing has decayed at four days old, but a leak alarm that compares views to clicks has to
  // count the clicks that could have earned, or a thread full of non-affiliate links reads clean.
  views: x.fields.Impressions || 0, clicks: x.fields['Lifetime Clicks'] ?? x.fields['Affiliate Clicks'] ?? 0,
  url: x.fields['X URL'] || '', day: String(x.fields['Posted Date'] || '').slice(0, 10),
  // E's pair. `Link Clicks` is MAX(Typefully, Levanta) and is the denominator survival was
  // computed over, so it is the right volume floor for judging that ratio — unlike the money
  // columns above, which deliberately count only the paying clicks. Commission rides along for
  // the direct-rail guard: earnings with no affiliate click prove the destination works.
  survival: Number.isFinite(Number(x.fields['Redirect Survival %'])) ? Number(x.fields['Redirect Survival %']) : null,
  linkClicks: x.fields['Link Clicks'] || 0,
  affClicks: x.fields['Lifetime Clicks'] ?? x.fields['Affiliate Clicks'] ?? null,
  commission: Number(x.fields['Lifetime Commission'] ?? x.fields.Commission ?? 0) || 0,
});

// E's baseline: the fleet's own trailing median survival over D-33..D-6 — the same window every
// other detector here takes its norm from, and far enough back that registry-sync has finished
// with every row in it. Fossils (guard 1) are excluded from the median as well as from judgement:
// 13 stale rows drag it 70.5% -> 71.1%, which is small, but a baseline built from readings the
// detector itself refuses to trust is not a baseline.
async function fleetSurvival(env) {
  const posted = ['Posted', 'Winner', 'Repost Candidate', 'Reposted'];
  const formula = `AND(OR(${posted.map((s) => `{Status}='${s}'`).join(',')}),` +
    `IS_AFTER({Posted Date},DATEADD(NOW(),-34,'days')),IS_BEFORE({Posted Date},DATEADD(NOW(),-5,'days')))`;
  const rows = (await airtable(env, env.REGISTRY_BASE_ID).listAll(REGISTRY_TABLE, { formula, fields: SURVIVAL_FIELDS })).filter(r => !isStandalonePost(r)).map(mapPost);
  const vals = rows.filter((r) => r.survival != null && r.linkClicks >= SURVIVAL_MIN_CLICKS
    && !((v) => v.stale || v.directRail)(survivalCollapseVerdict({ ...r, baseSurvival: 1 }))).map((r) => r.survival);
  return { base: median(vals), n: vals.length };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY', 'AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'XDB_BASE_ID']);
  const lv = await levantaDaily(env);
  const [posts, fleetSurv] = await Promise.all([recentPosts(env), fleetSurvival(env)]);
  const sections = [];

  // A — EPC collapse over the matured window
  const winA = { from: daysAgo(5), to: daysAgo(3) }, baseA = { from: daysAgo(33), to: daysAgo(6) };
  const a = epcCollapseVerdict({
    winClicks: lv.winSum(lv.clicksByDay, winA.from, winA.to), winComm: lv.winSum(lv.commByDay, winA.from, winA.to),
    baseClicks: lv.winSum(lv.clicksByDay, baseA.from, baseA.to), baseComm: lv.winSum(lv.commByDay, baseA.from, baseA.to),
  });
  if (a.fire) sections.push({ label: 'EPC COLLAPSE (clicks earning far below normal)', body:
    `${winA.from}→${winA.to}: <b>${money(a.winEpc)}</b>/click vs <b>${money(a.baseEpc)}</b>/click normal (28d) — ` +
    `≈ <b>${money(a.atRisk)}</b> below normal for these clicks.\n` +
    `Check: product CVR (pick-product losers), repost attribution, Levanta account/link health.` });

  // B — viral posts with no click flow (judged D-3..D-2 so registry clicks have synced)
  const bFrom = daysAgo(3), bTo = daysAgo(2);
  const clickless = posts.filter((p) => p.day >= bFrom && p.day <= bTo && viralClicklessVerdict(p));
  if (clickless.length) sections.push({ label: 'VIRAL POST, NO CLICK FLOW (plug missing/dead?)', body:
    clickless.map((p) => {
      const stats = dashLink(env, `/reports?post=${p.id}`);
      return `• <b>${esc(p.account)}</b> — ${esc(p.hook)}\n   ${(p.views / 1000).toFixed(0)}k views · <b>${p.clicks} clicks</b>${p.url ? ` · <a href="${p.url}">post</a>` : ''}${stats ? ` · <a href="${stats}">stats</a>` : ''}`;
    }).join('\n') });

  // C — click-volume collapse on D-3..D-2. NOT D-1: Levanta's daily rollup can lag ~a day, so
  // "yesterday: 0 clicks" is routinely just not-yet-ingested — judging it would cry wolf (the first
  // dry run did exactly that). A real collapse alerts one day later instead, still fast enough.
  const medC = median([...lv.clicksByDay.entries()].filter(([d]) => d >= daysAgo(33) && d <= daysAgo(6)).map(([, c]) => c));
  const collapsed = [];
  for (let n = 3; n >= 2; n--) {
    const day = daysAgo(n);
    const dayClicks = lv.clicksByDay.get(day) || 0;
    const postedCount = posts.filter((p) => p.day === day).length;
    if (clickCollapseVerdict({ dayClicks, medClicks: medC, postedCount })) collapsed.push({ day, dayClicks, postedCount });
  }
  if (collapsed.length) sections.push({ label: 'CLICK VOLUME COLLAPSE (posts out, clicks gone)', body:
    collapsed.map((c) => `• ${c.day}: <b>${c.dayClicks} clicks</b> vs ${Math.round(medC)}/day normal, with ${c.postedCount} post(s) live.`).join('\n') +
    `\nCheck: link-sentinel dead links, Typefully publish failures, X link suppression.` });

  // D — phantom clicks, judged one day at a time so a healthy neighbour cannot average the anomaly
  // away — but ONLY on days the patience rule calls settled (>=48h past UTC day end). detailPageViews
  // is the slowest column in the feed: judging it younger produced the 2026-08-29 false alarm, and a
  // fresh day reading 12% arrival is ingestion, not a leak. At the 06:40 UTC run this means D-3 and
  // older; D-2 (~31h old) is deliberately left to tomorrow's run. Baseline excludes unsettled days
  // for the same reason — an immature tail would drag the norm down and hide a real repeat.
  const baseD = { from: daysAgo(33), to: daysAgo(6) };
  const settledSum = (map) => { let s = 0; for (const [d, v] of map) if (d >= baseD.from && d <= baseD.to && levDaySettled(d)) s += v; return s; };
  const baseDClicks = settledSum(lv.clicksByDay), baseDDpv = settledSum(lv.dpvByDay);
  const phantom = [];
  for (let n = 4; n >= 2; n--) {
    const day = daysAgo(n);
    if (!levDaySettled(day)) continue; // patience: this day's numbers are still arriving
    const v = phantomClickVerdict({ dayClicks: lv.clicksByDay.get(day) || 0, dayDpv: lv.dpvByDay.get(day) || 0, baseClicks: baseDClicks, baseDpv: baseDDpv });
    if (v.fire) phantom.push({ day, ...v, worst: lv.linksOn(day).filter((l) => l.clicks >= 20).slice(0, 5) });
  }
  if (phantom.length) sections.push({ label: 'PHANTOM CLICKS (clicks recorded, never reached the store)', body:
    phantom.map((p) => `• ${p.day}: <b>${(100 * p.dayRate).toFixed(1)}% of clicks reached a product page</b> vs ${(100 * p.baseRate).toFixed(0)}% normal — ` +
      `≈ <b>${p.phantom}</b> real clicks never landed on the product page. Treat this as money leaving, not a bad metric: ` +
      `readers tapped normally and were lost after the redirect.\n` +
      (p.worst.length ? p.worst.map((l) => `   ◦ ${esc(l.source)} — ${l.clicks} clicks, ${l.dpv} page view${l.dpv === 1 ? '' : 's'}`).join('\n') + '\n' : '')).join('') +
    `Check: resolve those links (check-links.mjs) — if they land correctly, the loss is downstream of our redirect and belongs with Levanta.` });

  // E — redirect survival: taps that never made it off X. Judged per POST like B, on the same
  // settled days as D (both read the Levanta click feed, so both owe it the patience rule) —
  // without that, the three ugliest rows on the registry today all turn out to be D-2/D-1 days
  // that simply have not ingested. The verdict refuses the two measured false-positive classes
  // itself; see its note. Silent when the baseline is thin: a median over a handful of threads is
  // not a fleet norm, and E would rather say nothing than judge against noise.
  const survived = [];
  if (fleetSurv.n >= 20) for (const p of posts) {
    if (p.survival == null || !levDaySettled(p.day)) continue;
    const v = survivalCollapseVerdict({ ...p, baseSurvival: fleetSurv.base });
    if (v.fire) survived.push({ ...p, ...v });
  }
  if (survived.length) sections.push({ label: 'CLICKS DYING AT THE REDIRECT (tapped on X, never arrived)', body:
    survived.sort((a, b) => a.survival - b.survival).map((p) => {
      const stats = dashLink(env, `/reports?post=${p.id}`);
      return `• <b>${esc(p.account)}</b> — ${esc(p.hook)}\n` +
        `   <b>${(100 * p.survival).toFixed(0)}% of taps reached the store</b> vs ${(100 * p.baseSurvival).toFixed(0)}% normal — ` +
        `${p.linkClicks} tapped, <b>≈${p.lostClicks} lost</b> at the lvnta.com gate` +
        `${p.url ? ` · <a href="${p.url}">post</a>` : ''}${stats ? ` · <a href="${stats}">stats</a>` : ''}`;
    }).join('\n') +
    `\nThese readers already said yes — they tapped. Check: resolve the thread's links ` +
    `(check-links.mjs), then the plug tweet itself on mobile. A survival this low is the redirect ` +
    `failing or the link being wrong, not weak copy — the soft band E ignores is the copy one.` });

  // NOT ON A DRY RUN (2026-09-06). logRun writes logs/funnel-watch-<date>.json — a tracked file the
  // retro reads as the record of what the watchdog actually did — and mirrors a run line to the Ops
  // Log. Unguarded, --dry produced a log indistinguishable from the 06:40 cron's: same shape, same
  // date-keyed filename, no marker. A manual rehearsal then read back as a real run, and the cron's
  // own commit later that day either clobbered it or conflicted with it. Gated like the Telegram
  // send below, the only other side effect here; the console verdict still prints on --dry.
  if (!DRY) logRun('funnel-watch', {
    epc: { fire: a.fire, winEpc: Number(a.winEpc.toFixed(4)), baseEpc: Number(a.baseEpc.toFixed(4)), atRisk: Number(a.atRisk.toFixed(2)) },
    viralClickless: clickless.length, clickCollapseDays: collapsed.length, medianDayClicks: Math.round(medC),
    phantomDays: phantom.length, phantomClicks: phantom.reduce((s, p) => s + p.phantom, 0),
    dpvPerClick: baseDClicks ? Number((baseDDpv / baseDClicks).toFixed(3)) : null,
    survivalPosts: survived.length, survivalLostClicks: survived.reduce((s, p) => s + p.lostClicks, 0),
    fleetSurvival: fleetSurv.n ? Number(fleetSurv.base.toFixed(3)) : null, fleetSurvivalN: fleetSurv.n,
    clean: sections.length === 0,
  });

  if (!sections.length) { console.log(`✅ funnel normal — EPC ${money(a.winEpc)} vs ${money(a.baseEpc)} baseline · median ${Math.round(medC)} clicks/day · no clickless virals · clicks arriving at ${(100 * (baseDClicks ? baseDDpv / baseDClicks : 0)).toFixed(0)}% · ${(100 * fleetSurv.base).toFixed(0)}% surviving the redirect (n=${fleetSurv.n}). Nothing sent.`); return; }
  const msg = report({
    emoji: '🚨', title: 'Funnel watch — money leak suspected', scope: `checked ${daysAgo(5)}→${daysAgo(1)}`,
    status: `⚠️ ${sections.length} anomal${sections.length === 1 ? 'y' : 'ies'} — this is the "silent $1,500" alarm`,
    sections, action: 'None of this self-heals. Diagnose today: each section names its first check.',
  });
  console.log(msg.replace(/<[^>]+>/g, ''));
  if (!DRY) { await telegram(env, msg, 'alerts'); console.log('\n✓ sent to alerts topic'); }
}
// Guard (same pattern as link-sentinel): test-scaffolds imports the pure verdicts above — importing
// this module must NEVER run the watchdog (loadEnv + live APIs + a possible Telegram send in a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
