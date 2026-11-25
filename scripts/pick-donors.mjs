#!/usr/bin/env node
// pick-donors.mjs <YYYY-MM-DD> [--need N] [--warn 0.2] [--out /outside/repo/RUNDIR] [--snapshot-out FILE]
//   --out DIR: the run's work folder. The snapshot goes to DIR/picker-<DAY>.json unless --snapshot-out names
//   another file, and each pick's full thread text to DIR/donors/<recId>.txt, so a run never re-runs the
//   picker just to get the bodies (2026-11-18). Both paths are checked before the slow reads start.
//   [--prior-snapshot /outside/repo/earlier-day.json]... [--source-handle-cap 1]
//   [--exclude recA,recB]...
//
// Returns donors that can ship TOGETHER on one day. The ranking is the easy half and
// preflight.mjs already owns it; the half that matters is the overlap screen, because the swipe
// pool is full of near-twins — several tracked creators run the same thread within days of each
// other, so the top of the ranking routinely contains two versions of one idea.
//
// Screens each candidate against: everything already scheduled on the target day, the days either
// side (a near-identical thread 24h apart on two accounts reads as a repeat even though the
// same-day rule permits it), and every other candidate. Greedy keep in rank order.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { loadEnv, airtable, typefully, HERE_DIR } from '../lib.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { TABLES } from '../config.mjs';
import { LAWS } from '../laws.mjs';
import { screenDonor, rankDonors, topicMemory, hotTopics, jointFloorArms } from '../preflight.mjs';
import { loadBurnLedger, isBurned, freshnessFactor, reuseVerdict, coverBestViews } from '../donor-burn.mjs';
import { readDonorPins, pinsForDay, freshWinners } from '../donor-pins.mjs';
import { routePick, routeTopic, topicPods, translationOf, offNicheException } from '../donor-routes.mjs';
import { sellableFor } from '../scripts/product-allocation.mjs';
import { productPerf } from '../pick-product.mjs';
import { tweetsFromRollup, bodyOverlap, fabricationFlags } from '../checks.mjs';
import { priorSourceContexts, sourceBreadthConflict, sourceHandle } from '../scripts/cover-source-breadth.mjs';
import { createDecisionLog, decide, decisionConfig } from '../jev-decide.mjs';
import { jev } from '../jev.mjs';

// OWNER RULE, 2026-09-23: "everything related to decision making & gate must be made by Jev from now on".
// With laws.json donor-screen at decide, every donor the picker is about to keep gets one Jev screen
// (language, retweet, reply-bait, quote compilation, named-person quote). A flag rejects it; a read that
// fails rejects it too (never a pass). The mock run's first two re-picks were a Spanish explicit thread and
// a hook with a censored swear word: the language is Jev's call, the censored word is a plain code check
// (docs/claim-safety.md: "[a-z]*[a-z]" reads as deliberate filter evasion).
const SCREEN = 'donor-screen';
const SCREEN_ACTING = ['decide', 'enforce'].includes(decisionConfig(SCREEN).mode);
const CENSORED = /[a-z]\*+[a-z]/i;
let screenClient = null, screenReg = null, screenLog = null;

const DAY = process.argv[2];
if (!/^\d{4}-\d\d-\d\d$/.test(String(DAY))) { console.error('usage: pick-donors.mjs <YYYY-MM-DD> [--need N]'); process.exit(2); }
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NEED = Number(arg('need', 11));
const WARN = Number(arg('warn', LAWS.selection?.donorOverlapWarn ?? 0.2));
const HANDLE_CAP = Number(arg('source-handle-cap', 0));
if (!Number.isInteger(HANDLE_CAP) || HANDLE_CAP < 0) throw new Error('--source-handle-cap must be a non-negative integer');
const priorPaths = process.argv.flatMap((a, i) => a === '--prior-snapshot' ? [process.argv[i + 1]] : []);
if (priorPaths.some((p) => !p || p.startsWith('--'))) throw new Error('--prior-snapshot needs a path');
// DONORS THE OWNER REFUSED (mock run 2026-09-23: a swap re-ran the picker and it returned the same
// refused donor). --exclude takes swipe record ids, comma-separated and repeatable; an excluded donor
// is never picked and is listed in REJECTED so the swap is visible. A malformed id fails loudly, since
// a typo that silently excluded nothing would re-offer the donor the owner just turned down.
const EXCLUDE = new Set(process.argv.flatMap((a, i) => a === '--exclude' ? String(process.argv[i + 1] ?? '').split(',') : [])
  .map((x) => x.trim()));
for (const id of EXCLUDE) if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new Error(`--exclude needs swipe record ids (rec + 14 chars); got "${id}"`);
// Output paths, checked up front: a bad path used to fail only after every read had run.
const OUT_DIR = arg('out', null);
const insideRepo = (p) => { let d = resolve(p); while (!existsSync(d)) d = dirname(d);
  const real = realpathSync(d), root = realpathSync(HERE_DIR); return real === root || real.startsWith(root + sep); };
if (OUT_DIR && insideRepo(OUT_DIR)) throw new Error('--out must be outside the repository: it holds unpublished bodies');
let snapshotOut = arg('snapshot-out', null);
if (!snapshotOut && OUT_DIR) {
  snapshotOut = join(OUT_DIR, `picker-${DAY}.json`);
  // A second pick the same day keeps the first snapshot: the brief may already cite it.
  if (existsSync(snapshotOut)) snapshotOut = join(OUT_DIR, `picker-${DAY}-${new Date().toISOString().slice(11, 16).replace(':', '')}.json`);
}
if (snapshotOut && insideRepo(snapshotOut)) throw new Error('--snapshot-out must be outside the repository: it includes unpublished Typefully bodies');
if (snapshotOut && existsSync(snapshotOut)) throw new Error(`--snapshot-out ${snapshotOut} already exists (it is never overwritten)`);
const priorSnapshots = priorPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
const priorSources = priorSourceContexts(priorSnapshots, DAY);
const env = loadEnv(); const at = airtable(env); const tf = typefully(env);
const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
const win = LAWS.selection?.viralWindowDays ?? 30;

// What is already committed on the target day and its neighbours
const shipped = [];
const keys = Object.entries(ACCOUNTS).filter(([, a]) => a.plugHeavyExample).map(([k]) => k);
const sets = new Map(); for (const k of keys) if (!sets.has(ACCOUNTS[k].socialSetId)) sets.set(ACCOUNTS[k].socialSetId, k);
const lo = Date.parse(`${DAY}T00:00:00+07:00`) - 864e5, hi = lo + 3 * 864e5;
for (const [sid] of sets) {
  for (let o = 0; ; o += 50) {
    // Retrying read that THROWS. A bare fetch with `if (!r.ok) break` is indistinguishable
    // from "no more pages": one transient 429 truncates the scan and a TAKEN slot reports FREE.
    // Same defect main fixed in slots.mjs; a caller that cannot see the queue must fail, not guess.
    const j = await tf.get(`/social-sets/${sid}/drafts?status=scheduled&limit=50&offset=${o}`);
    for (const d of (j.results || [])) {
      const t = d.scheduled_date ? Date.parse(d.scheduled_date) : 0;
      if (t < lo || t >= hi) continue;
      const full = await tf.getDraft(sid, d.id);
      shipped.push((full?.platforms?.x?.posts || []).map((p) => String(p.text || '')));
    }
    if (!j.next || !(j.results || []).length) break;
  }
}

// THE VAULT ARM (operator 2026-09-08). The fresh window holds 122 in-niche donors; the whole swipe
// DB holds 1,690. That 13.9x is the selection we are not using, and a pool of 122 against ~40 covers
// a week is what makes a batch start repeating itself — which is the thing that stops new harvest
// bodies appearing, because we keep testing the same shapes.
//
// So a share of each day's picks is drawn from donors OLDER than the window, and the fresh lane is
// left alone as the control. Nothing is stamped on the draft: a cover's arm is recoverable later
// from its Source Thread and the swipe row's Published Date, which is how donor-arm.mjs reads it.
const ARCHIVE_SHARE = Number(arg('archive-share', LAWS.selection?.archiveShare ?? 0));
// THE EVERGREEN ARM (operator 2026-09-17: "a great blend between what is trending ... but we are
// also resurfacing evergreen posts from before. We know, fundamentally, they have something that
// helped them go viral before"). `archive` alone could not carry that bet: it spanned 31-365 days,
// and because merit inside it always favours the near end the arm filled itself out of 31-60d
// donors and the old band stayed untested — n=7 across the whole of 91-365d. This reserves slots
// past archiveStepDays specifically, which is the only way the blend gets measured.
const EVERGREEN_SHARE = Number(arg('evergreen-share', LAWS.selection?.evergreenShare ?? 0));
// THE OG ARM (operator 2026-09-17, lifting the 365-day bound: "OG means written over 365 days ago").
// Until this run the bound made the band unpickable, which is why the writers the operator asked for
// by name never appeared — @bensmithlive has nothing newer than 500 days, so 100% of him was out.
const OG_SHARE = Number(arg('og-share', LAWS.selection?.ogShare ?? 0));
const ARCHIVE_MAX = Number(arg('archive-max-age', LAWS.selection?.archiveMaxAgeDays ?? 365));
const FLOOR = Number(arg('min-views', LAWS.selection?.viewFloor ?? 250000));
const wantArchive = Math.round(NEED * ARCHIVE_SHARE);
const wantEvergreen = Math.round(NEED * EVERGREEN_SHARE);
const wantOg = Math.round(NEED * OG_SHARE);
// THE RECENT FLOOR (owner 2026-09-28: "I think 60% — then within the OG we would divide into 30 - 90 days
// (15%), 90 - 365 days (15%) and 365 days+ (10%)"). The old arms' shares were floors under merit, so the
// recent share was whatever merit and the burn screen left: R2026-09-27 shipped 9 recent covers of 77.
// This reserves the recent share exactly as the vault floors reserve theirs; with fresh + archive = 1
// every slot is bound. A day the pool cannot fill is a quota miss, filled by merit and reported.
const FRESH_SHARE = Number(arg('fresh-share', LAWS.selection?.freshShare ?? 0));
const wantFresh = Math.round(NEED * FRESH_SHARE);

// A head's stored {Thread Length} / {Full Thread Text} are filled from the "(live)" rollups by swipe-fold's
// daily SYNC. When that job lags, every new thread has empty stored fields and drops out of the pool: on
// 2026-10-31 the newest pooled donor was Oct 18 while the table held 1M+ threads up to Oct 30. So the
// pool also takes the live rollup, and a head missing its stored copy is read from it.
const BASE = `{Tweet Number}=1,OR({Thread Length}>=3,{Thread Length (live)}>=3),NOT({Quoted Junk}),NOT({Single Tweet}),NOT({Drafted}),{Impressions}>=${FLOOR}`;
const liveFallback = (r) => {
  const f = r.fields;
  if (f['Thread Length'] == null && f['Thread Length (live)'] != null) f['Thread Length'] = Array.isArray(f['Thread Length (live)']) ? f['Thread Length (live)'][0] : f['Thread Length (live)'];
  if (!f['Full Thread Text'] && f['Full Thread Text (live)'] != null) f['Full Thread Text'] = [].concat(f['Full Thread Text (live)']).join('');
  delete f['Thread Length (live)']; delete f['Full Thread Text (live)'];
  return r;
};
const fetchPool = async (formula) => (await at.listAll(TABLES.swipe, {
  formula,
  fields: ['Text', 'Impressions', 'Published Date', 'Thread Length', 'Full Thread Text', 'Thread Length (live)', 'Full Thread Text (live)', 'Tweet URL', 'Niche'], pageSize: 100,
})).map(liveFallback);
// ONE POOL, ONE RANKING. This is only honest because the decay curve was fitted (2026-09-08): under
// the old `max(0.12, 0.5^(age/7))` every donor past ~25 days sat at the floor, so merging the lanes
// would have buried the whole vault below the whole fresh window and the arm would never have fired.
// At half-life 14 with a 0.33 plateau a 45-day 2M donor with a sell slot scores 1.06 against a
// 3-day 300k one's 1.38 — close enough that merit decides, which is what the measurement says.
const POOL_FORMULA = `AND(${BASE},IS_AFTER({Published Date},DATEADD(NOW(),-${ARCHIVE_MAX},"days")))`;
const pool = await fetchPool(POOL_FORMULA);
const byId = new Map(pool.map((r) => [r.id, r]));
const screened = pool.map((r) => screenDonor({ ...r.fields, recId: r.id }, { products }));
// The swipe DB's calibrated niche tag (tag-niche.mjs: Health merges Health, Fitness and Mental Health).
const nicheOf = (recId) => String(byId.get(recId)?.fields?.Niche ?? '');
// TOPIC NOVELTY NOW HAS A MEMORY (operator 2026-09-09, "widen this lane"). It used to count only
// what the DAY already argues, and that scope is what made it toothless: the tally started empty
// every run, so each run reopened with every topic at full novelty, took the money topics first
// because they carry the intent multiplier, and reproduced the same mix. Measured over the 20 days
// to 09-09: sleep 33%, stress 15%, heart 10%, fitness 10%, bloodsugar 6% — 74% in five buckets,
// while skin (55 plug-able products) took 5% and joint (33) took 2%.
//
// Seeded from the ledger's own topic stamp, half-life decayed, then incremented per pick exactly as
// before. The tilt stays bounded by topicSpreadFloor so the five leaders are outranked, never
// banned — the operator's rule is that they keep their common use.
const ledgerRows = (() => {
  try {
    return readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }   // no ledger = no memory, which is the old behaviour, not a crash
})();
const memory = topicMemory(ledgerRows);
const HOT = hotTopics(memory);
const topicUses = { ...memory };
// THE FLOOR under the tilt. A share of the day's picks is reserved for COLD topics — anything
// outside the leaders — so exploration happens on a day when the leaders would otherwise take every
// slot. Same shape as the archive arm below: it never outranks merit, it only guarantees the rows
// exist. Every one of the 13 topics has plug-able products, so a cold slot can always be monetized.
const EXPLORE_SHARE = Number(arg('explore-share', LAWS.selection?.explorationShare ?? 0));
const wantExplore = Math.round(NEED * EXPLORE_SHARE);
const body = (id) => tweetsFromRollup(String(byId.get(id)?.fields['Full Thread Text'] || ''));
const handle = (id) => sourceHandle(byId.get(id)?.fields['Tweet URL']);
const worst = (a, b) => Math.max(bodyOverlap(a, b), bodyOverlap(b, a));
// A quote put in a named living person's mouth is the one fabrication class worth dropping a donor
// over — everything else is genre convention and LAW 7 handles it at writing time.
const HARD = new Set(['quote attributed to a named person']);

// NO NAMED SUPPLEMENT, STILL HEALTH (donor-routes.mjs; owner 2026-09-28: "Yes to jev picks and Off niche is
// defined as completely outside of the health niche"). A recent thread the niche tag calls Health, whose
// words name nothing we sell, is offered its topic's pods; Jev's donor-writeability decision picks the one
// whose criterion is the natural next question. The product rides as needsBridge (the writer builds the
// bridge). A read that fails, a swap, or no pod leaves the donor out, as before. --no-jev-route turns it off.
const jevRouted = new Map(), jevRouteMisses = [];
const OFF_NICHE_OK = LAWS.selection?.offNicheExceptions || [];
if (!process.argv.includes('--no-jev-route') && decisionConfig('donor-writeability').mode === 'decide') {
  const podList = JSON.parse(readFileSync(join(HERE_DIR, 'pods.json'), 'utf8')).pods || [];
  const perfNow = productPerf();
  const sellable = sellableFor(products);
  screenReg ||= (await import('../decisions/index.mjs')).DECISIONS;
  screenLog ||= createDecisionLog();
  try { screenClient ||= jev(env); } catch { /* decide() reads a null client as not read */ }
  for (const d of screened) {
    // Health only, except the owner's off-niche exceptions (laws.json selection.offNicheExceptions, owner
    // 2026-09-28: "we accept BebetterMan as he is an exception to the rule"), whatever their niche tag.
    const exception = offNicheException(byId.get(d.recId)?.fields?.['Tweet URL'], OFF_NICHE_OK);
    if (d.usable || d.reject !== 'no substance we can sell' || !(d.age <= win) || (nicheOf(d.recId) !== 'Health' && !exception)) continue;
    const b = body(d.recId);
    const pods = topicPods(podList, routeTopic(d.topic, b[0], b.join('\n')), { sellable, epcOf: (a) => Number(perfNow[a]?.epc ?? 0) });
    if (!pods.length || b.length < 3) continue;
    const input = { hook: b[0], tweets: b, pods };
    const r = await decide('donor-writeability', input, { client: screenClient, registry: screenReg, log: screenLog });
    if (r.source === 'fallback' || !r.answers) { jevRouteMisses.push([d.recId, `not read (${r.fallback || 'no answers'})`]); continue; }
    // The route's own rule on Jev's answers (donor-routes.mjs JEV_ROUTE): the top pod when it clears podFloor.
    const { pod, reason } = routePick(r.answers, pods, decisionConfig('donor-writeability').thresholds);
    if (!pod) { jevRouteMisses.push([d.recId, reason]); continue; }
    Object.assign(d, { usable: true, reject: null, substances: [pod.asin], jevPod: pod.id, jevBridged: [pod.asin] });
    jevRouted.set(d.recId, pod);
  }
}

// THE BURN SCREEN IS OFF BY DEFAULT (owner 2026-09-28: "remove the burn screen rule — so that's why I
// don't see many of the recent viral posts"). R2026-09-27 measured what it cost: of the 71 usable
// donors under 30 days old, it held back 46 because we had covered them in the last 4 runs or 30 days,
// and the run shipped 9 recent covers out of 77. A donor still never goes out twice in one run (the
// source-breadth check below) or next to a day already carrying its body (the day screen).
//
// History, for a run that asks for the screen explicitly (--burn-window / --max-uses / --burn-days, or
// the Balanced and Strict novelty presets in scripts/run-intake.mjs): operator 2026-09-17, "I have seen
// too many of the same origin source over the last few runs", then "If they have been used less than 4
// times, we can use them again. It's fine." A donor inside the window is dropped; outside it, one we
// have published is ranked down by freshnessFactor. With all three at 0, the ranking is merit alone.
const BURN_WINDOW = Number(arg('burn-window', 0));
const MAX_USES = Number(arg('max-uses', 0));
const BURN_DAYS = Number(arg('burn-days', 0));
const burnOpts = { window: BURN_WINDOW, maxUses: MAX_USES, burnDays: BURN_DAYS };
const burn = loadBurnLedger(join(HERE_DIR, 'queues'));
const burnedOut = [];

// THE REUSE RULE (owner 2026-09-28; laws.json selection.reuse; donor-burn.mjs reuseVerdict): a donor we
// covered more than 3 times in the last 30 days sits out, unless one of our covers of it passed 200K
// views ("our covers did over 200K view once"): a winner keeps being reused. Our views come from the
// registry's Published Content, joined to the donor by its tweet URL. A failed read drops nothing (an
// unknown is never "not a winner") and the log says the rule was not applied. --no-reuse-rule turns it off.
const statusOf = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || null;
const REUSE = LAWS.selection?.reuse || null;
let bestViews = new Map();
let reuseRead = !REUSE || process.argv.includes('--no-reuse-rule') ? 'off' : null;
if (!reuseRead) {
  try {
    const reg = airtable(env, env.REGISTRY_BASE_ID);
    // Our covers only (donor-burn coverBestViews): an article's views never make a donor a winner.
    bestViews = coverBestViews(await reg.listAll('Published Content', { fields: ['Type', 'Source Thread', 'Impressions'] }));
    reuseRead = 'read';
  } catch (error) { reuseRead = `not read (${String(error?.message || error).slice(0, 80)})`; }
}
const reuseOf = (recId) => reuseVerdict(burn.get(recId), { ...(REUSE || {}), today: DAY,
  best: reuseRead === 'read' ? (bestViews.get(statusOf(byId.get(recId)?.fields?.['Tweet URL'])) ?? 0) : null });
const reuseHeld = new Set(reuseRead === 'read' ? screened.filter((d) => d.usable && reuseOf(d.recId).spent).map((d) => d.recId) : []);
const reuseWinners = reuseRead === 'read' ? screened.filter((d) => d.usable && reuseOf(d.recId).covers > (REUSE?.coversMax ?? 3) && reuseOf(d.recId).winner).length : 0;

// PICK ONE AT A TIME, RE-RANKING AS WE GO. Novelty is a property of the batch being built, not of
// the pool, so a topic's tilt has to update the moment a donor arguing it is kept — exactly how
// product spread works inside a slate. Ranking once up front would let the top six picks all be
// stress threads and only tilt the seventh.
const keep = [], rejected = [], seen = new Set(EXCLUDE);
for (const id of EXCLUDE) rejected.push([id, 'excluded by --exclude (owner refused this donor)']);
// A swipe thread the article lane took (owner, 2026-10-08: "instead of cover -> then it's an article format") is
// that run's article, not a cover: held for laws.json articles.sourceReuseDays (learnings/article-sources.jsonl).
{
  const log = join(HERE_DIR, 'learnings', 'article-sources.jsonl');
  const since = Date.now() - (LAWS.articles?.sourceReuseDays ?? 60) * 864e5;
  let lines = [];
  try { lines = readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { /* no article taken a thread yet */ }
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e.swipeRec || Date.parse(e.at) < since || seen.has(e.swipeRec)) continue;
    seen.add(e.swipeRec); rejected.push([e.swipeRec, `taken as an article (${e.articleDraft || e.runId || 'article lane'})`]);
  }
}
let poolSize = 0;

// Every screen a donor passes once merit has chosen it. A pinned donor skips only the run's
// one-donor-once rule (source breadth), because covering it on several pages is the owner's request.
async function vet(d, { pinned = false } = {}) {
  const b = body(d.recId);
  let translate = null;
  if (b.length < 3) return { reason: null };
  if (fabricationFlags(b).some((f) => HARD.has(f.kind))) return { reason: 'quote attributed to a named person' };
  if (b.some((t) => CENSORED.test(t))) return { reason: 'censored swear word (filter evasion, docs/claim-safety.md)' };
  if (SCREEN_ACTING) {
    screenReg ||= (await import('../decisions/index.mjs')).DECISIONS;
    screenLog ||= createDecisionLog();
    try { screenClient ||= jev(env); } catch { /* decide() reads a null client as not read */ }
    const input = { hook: b[0], tweets: b };
    const r = await decide(SCREEN, input, { client: screenClient, registry: screenReg, log: screenLog });
    if (r.source === 'fallback' || !r.answers) return { reason: `Jev donor screen not read (${r.fallback || 'no answers'}): a failed read is never a pass` };
    if (r.action === 'flag') {
      const v = screenReg[SCREEN].policy(r.answers, decisionConfig(SCREEN).thresholds, { input });
      // A Health thread flagged ONLY for its language is recreated in English (owner 2026-09-28, the
      // Spanish health threads: "Yes, health ones"); anything else the screen flags still rejects.
      translate = translationOf(v.reasons || [], nicheOf(d.recId));
      if (!translate) return { reason: `Jev donor screen: ${(v.reasons || []).join(', ') || 'flagged'}` };
    }
  }
  const vsDay = Math.max(0, ...shipped.map((s) => worst(b, s)));
  if (vsDay >= WARN) return { reason: `${(vsDay * 100).toFixed(0)}% vs something already on the day` };
  const candidate = { ...d, body: b, handle: handle(d.recId), ...(pinned ? { pinned: true } : {}), ...(translate ? { translate } : {}),
    ...(d.jevPod ? { jevPod: d.jevPod, jevBridged: d.jevBridged } : {}),
    // Any off-niche donor from an owner exception page carries the stamp, routed or already naming a
    // product, so the slot allocator does not hold it for account-fit review.
    ...(nicheOf(d.recId) !== 'Health' && offNicheException(byId.get(d.recId)?.fields?.['Tweet URL'], OFF_NICHE_OK)
      ? { offNicheException: offNicheException(byId.get(d.recId)?.fields?.['Tweet URL'], OFF_NICHE_OK) } : {}) };
  if (!pinned) {
    const breadthConflict = sourceBreadthConflict(candidate, [...priorSources, ...keep], { warn: WARN, handleCap: HANDLE_CAP });
    if (breadthConflict) return { reason: breadthConflict };
  }
  return { candidate };
}

// PINNED DONORS FIRST (donor-pins.mjs; owner 2026-09-28: "Cover it on 3 pages and mint a seed"). Each
// active pin lands on up to its `pages` of the run's days, one a day; the slot allocator keeps it off a
// page that already has it. It skips the reuse rule and the burn screen too, and nothing else.
const pinned = [], pinMisses = [];
for (const pin of pinsForDay(readDonorPins(), { day: DAY, prior: priorSnapshots })) {
  if (keep.length >= NEED) break;
  const d = screened.find((x) => x.recId === pin.recId);
  const miss = (why) => { pinMisses.push([pin.recId, why]); rejected.push([pin.recId, `pinned, not placed: ${why}`]); };
  if (EXCLUDE.has(pin.recId)) { miss('excluded by --exclude'); continue; }
  if (!d) { miss('not in the pool (under the view floor, outside the age bound, or not a thread)'); continue; }
  if (!d.usable) { miss(d.reject || 'not usable'); continue; }
  seen.add(d.recId);
  const v = await vet(rankDonors([d], { topicUses })[0], { pinned: true });
  if (!v.candidate) { miss(v.reason || 'body too short'); continue; }
  keep.push(v.candidate);
  pinned.push(pin.recId);
  topicUses[v.candidate.topic] = (topicUses[v.candidate.topic] || 0) + 1;
}

// HIS FRESH WINNERS NEXT (donor-pins.mjs freshWinners; laws.json selection.freshWinner; owner 2026-09-28:
// "yes. build this into selection"). A Direct Competitor thread under three days old whose estimated day
// one clears 500k is placed before merit, highest first. Unlike a pin it runs on ONE page: every screen
// still applies, source breadth included, so a winner an earlier day of the run placed is not placed
// again. A failed cohort read places nothing and says so (a priority, not a gate: merit still fills).
const FW = LAWS.selection?.freshWinner || null;
const fwPlaced = [], fwMisses = [];
let fwRead = !FW || process.argv.includes('--no-fresh-winners') ? 'off' : null;
if (!fwRead) {
  let handles = [];
  try {
    const cohort = String(FW.cohort || 'Direct Competitor').replace(/'/g, "\\'");
    handles = (await at.listAll(TABLES.swipeUsers, { formula: `{Cohort}='${cohort}'`, fields: ['Handle'] }))
      .map((u) => u.fields?.Handle).filter(Boolean);
    fwRead = 'read';
  } catch (error) { fwRead = `not read (${String(error?.message || error).slice(0, 80)})`; }
  for (const w of fwRead === 'read' ? freshWinners(pool, { ...FW, handles }) : []) {
    if (keep.length >= NEED) break;
    const miss = (why) => { fwMisses.push([w.recId, why]); rejected.push([w.recId, `fresh winner, not placed: ${why}`]); };
    if (keep.some((k) => k.recId === w.recId)) continue;
    if (EXCLUDE.has(w.recId)) { miss('excluded by --exclude'); continue; }
    const d = screened.find((x) => x.recId === w.recId);
    if (!d?.usable) { miss(d?.reject || 'not usable'); continue; }
    if (reuseHeld.has(d.recId)) { miss('held by the reuse rule'); continue; }
    seen.add(d.recId);
    const v = await vet(rankDonors([d], { topicUses })[0]);
    if (!v.candidate) { miss(v.reason || 'body too short'); continue; }
    keep.push({ ...v.candidate, freshWinner: { handle: w.handle, ageHours: w.ageHours, dayOne: w.dayOne } });
    fwPlaced.push(w.recId);
    topicUses[v.candidate.topic] = (topicUses[v.candidate.topic] || 0) + 1;
  }
}

while (keep.length < NEED) {
  const left = screened.filter((d) => d.usable && !seen.has(d.recId)
    && !isBurned(d.recId, burn, burnOpts) && !reuseHeld.has(d.recId));
  if (!left.length) break;
  // Merit first, then tiredness. rankDonors owns the score; this only reorders what it returned, so
  // a donor never gains from having been covered and the ranking stays the one thing that decides.
  let order = (BURN_WINDOW > 0 || MAX_USES > 0 || BURN_DAYS > 0)
    ? rankDonors(left, { topicUses })
      .map((d) => ({ d, f: freshnessFactor(d.recId, burn) }))
      .sort((a, b) => (b.d.score * b.f) - (a.d.score * a.f))
      .map((x) => x.d)
    : rankDonors(left, { topicUses });
  if (!poolSize) poolSize = order.length;
  // THE ARM'S FLOOR, not its ceiling. Merit decides the ranking; this only guarantees the archive
  // lane produces enough rows to read. Without it a quiet week of fresh donors could return an
  // all-fresh batch and the experiment would silently record nothing.
  // `archive` now means 31-90d only, so the vault target counts BOTH old arms: the 0.33 share was
  // fitted when one bucket held everything past 30 days, and reading it as the near band alone would
  // quietly widen the vault by whatever evergreen also takes.
  const archiveKept = keep.filter((k) => k.arm !== 'fresh').length;
  const evergreenKept = keep.filter((k) => k.arm === 'evergreen' || k.arm === 'og').length;
  const ogKept = keep.filter((k) => k.arm === 'og').length;
  const exploreKept = keep.filter((k) => !HOT.has(k.topic)).length;
  const freshKept = keep.filter((k) => k.arm === 'fresh').length;
  const slotsLeft = NEED - keep.length;
  // Both floors bind the same way: only once the slots remaining are exactly what the target still
  // needs, so merit owns every pick until the arm would otherwise miss. When BOTH are binding, take
  // the intersection — a donor that is old AND on a cold topic satisfies them at once. An empty
  // intersection means no such donor exists, so fall back to the archive arm alone rather than
  // narrowing to nothing: the vault is the older, measured arm and exploration can catch up on the
  // next run, where an empty `order` would end the batch a slot short.
  const needOg = ogKept < wantOg && (wantOg - ogKept) >= slotsLeft;
  const needEvergreen = evergreenKept < wantEvergreen && (wantEvergreen - evergreenKept) >= slotsLeft;
  const needArchive = archiveKept < wantArchive && (wantArchive - archiveKept) >= slotsLeft;
  const needExplore = exploreKept < wantExplore && (wantExplore - exploreKept) >= slotsLeft;
  const needFresh = freshKept < wantFresh && (wantFresh - freshKept) >= slotsLeft;
  // EVERGREEN BINDS FIRST when both vault floors are live, because an evergreen donor satisfies the
  // archive target too while the reverse is false — taking a 45-day donor here would fill the wider
  // target and leave the narrower one one slot further from ever being met.
  // Together, too (preflight jointFloorArms): once the recent and old deficits fill the slots left, a
  // donor that shrinks neither would cost one of them its target.
  const joint = jointFloorArms({ fresh: freshKept, archive: archiveKept, evergreen: evergreenKept, og: ogKept },
    { fresh: wantFresh, archive: wantArchive, evergreen: wantEvergreen, og: wantOg }, slotsLeft);
  if (needOg || needEvergreen || needArchive || needFresh || needExplore || joint) {
    // Narrowest floor first, because an OG donor satisfies every wider target and none of them
    // satisfies it — filling a wider one with a near-band donor leaves the narrowest further away.
    const og = order.filter((d) => d.arm === 'og');
    const ever = order.filter((d) => d.arm === 'evergreen' || d.arm === 'og');
    const arch = order.filter((d) => d.arm !== 'fresh');
    const cold = order.filter((d) => !HOT.has(d.topic));
    const fresh = order.filter((d) => d.arm === 'fresh');
    // The recent floor binds after the old ones (they are the narrower bands); with no recent donor
    // left it cannot bind at all, and merit fills the slot: the miss is reported, never hidden.
    const base = needOg ? (og.length ? og : ever.length ? ever : arch)
      : needEvergreen ? (ever.length ? ever : arch) : needArchive ? arch
        : needFresh ? (fresh.length ? fresh : order)
          : joint ? (() => { const j = order.filter((d) => joint.includes(d.arm)); return j.length ? j : order; })() : cold;
    // An empty intersection means no donor satisfies both, so fall back to the age floor alone
    // rather than narrowing to nothing — exploration can catch up next run, an empty `order` cannot.
    const both = needExplore ? base.filter((d) => !HOT.has(d.topic)) : base;
    const pick = both.length ? both : (base.length ? base : cold);
    if (pick.length) order = pick;
  }
  let took = null;
  for (const d of order) {
    seen.add(d.recId);
    const v = await vet(d);
    if (v.candidate) { took = v.candidate; break; }
    if (v.reason) rejected.push([d.recId, v.reason]);
  }
  if (!took) break;
  keep.push(took);
  topicUses[took.topic] = (topicUses[took.topic] || 0) + 1;
}
const nArchive = keep.filter((k) => k.arm === 'archive').length;
const nEvergreen = keep.filter((k) => k.arm === 'evergreen').length;
const nOg = keep.filter((k) => k.arm === 'og').length;
const nCold = keep.filter((k) => !HOT.has(k.topic)).length;
const nFresh = keep.filter((k) => k.arm === 'fresh').length;
const quotaMisses = {
  fresh: Math.max(0, wantFresh - nFresh),
  vault: Math.max(0, wantArchive - nArchive - nEvergreen - nOg),
  evergreen: Math.max(0, wantEvergreen - nEvergreen - nOg),
  og: Math.max(0, wantOg - nOg),
  coldTopic: Math.max(0, wantExplore - nCold),
};
// What this BATCH argues, not the seeded history — the seed is decimals over 21 days of covers and
// printing it buries the six numbers that matter. The memory it came from is one line below.
const batchTopics = {};
for (const k of keep) batchTopics[k.topic] = (batchTopics[k.topic] || 0) + 1;
// A complete, reproducible read-only snapshot for the collaborative /run desk. listAll throws on
// a pagination error/cap, so `complete: true` is an observed property rather than an assumption.
// The existing picker still owns every screen and quota; downstream account assignment can propose
// which page receives each picked donor without quietly replacing its canonical source set.
screenLog?.flush();
if (snapshotOut) mkdirSync(dirname(resolve(snapshotOut)), { recursive: true });
if (snapshotOut) writeFileSync(snapshotOut, JSON.stringify({
  schema: 'cover-picker-snapshot-v1', complete: true, source: 'Airtable Swipe Database',
  date: DAY, fetchedAt: new Date().toISOString(), poolCount: pool.length,
  query: { table: TABLES.swipe, formula: POOL_FORMULA,
    fields: ['Text', 'Impressions', 'Published Date', 'Thread Length', 'Full Thread Text', 'Tweet URL'],
    pagination: 'listAll to exhaustion or throw' },
  command: process.argv.slice(1),
  repoHead: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE_DIR, encoding: 'utf8' }).trim(); } catch { return null; } })(),
  controls: {
    need: NEED, warn: WARN, floor: FLOOR, archiveMaxAge: ARCHIVE_MAX,
    archiveTarget: wantArchive, evergreenTarget: wantEvergreen, ogTarget: wantOg,
    exploreTarget: wantExplore, hotTopics: [...HOT], burnWindow: BURN_WINDOW,
    maxUses: MAX_USES, burnDays: BURN_DAYS, sourceHandleCap: HANDLE_CAP,
    excluded: [...EXCLUDE], donorScreen: SCREEN_ACTING ? 'jev decide' : 'off (shadow)',
    freshTarget: wantFresh, reuse: { ...(REUSE || {}), read: reuseRead }, pinned, pinMisses,
    freshWinners: { ...(FW || {}), read: fwRead, placed: fwPlaced, misses: fwMisses },
    jevRouted: Object.fromEntries([...jevRouted].map(([id, pod]) => [id, pod.id])), jevRouteMisses,
  },
  sourceBreadth: { priorDates: priorSnapshots.map((s) => s.date), priorSelected: priorSources.length,
    uniqueHandles: new Set([...priorSources, ...keep].map((s) => s.handle).filter(Boolean)).size,
    rejected: rejected.filter(([, why]) => why.includes('source ') || why.startsWith('@')).map(([id, why]) => ({ id, reason: why })) },
  quotaMisses,
  productAsins: products.map((p) => p.asin),
  topicUses: memory,
  records: pool,
  burnedIds: screened.filter((d) => d.usable && isBurned(d.recId, burn, burnOpts)).map((d) => d.recId),
  reuseHeldIds: [...reuseHeld],
  selectedIds: keep.map((d) => d.recId),
  selected: keep,
  shipped,
}, null, 2), { flag: 'wx', mode: 0o600 });
const fmtMem = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([t, w]) => `${t} ${w.toFixed(1)}`).join(' · ');
console.log(`\n${DAY} · pool ${poolSize} · ${shipped.length} thread(s) already on this day or its neighbours · overlap warn ${WARN}`);
console.log(`source breadth: ${priorSources.length} pick(s) from ${priorSnapshots.length} earlier snapshot(s) · ${HANDLE_CAP ? `max ${HANDLE_CAP} per known X handle` : 'no creator cap'} · ${new Set([...priorSources, ...keep].map((s) => s.handle).filter(Boolean)).size} distinct handles · ${rejected.filter(([, why]) => why.includes('source ') || why.startsWith('@')).length} breadth rejection(s)`);
console.log(`arms: ${nFresh} fresh (target ${wantFresh}) · ${nArchive} archive 31-${LAWS.selection?.archiveStepDays ?? 90}d · ${nEvergreen} evergreen (target ${wantEvergreen}) · ${nOg} OG (target ${wantOg}) · vault ${nArchive + nEvergreen + nOg}/${wantArchive} · ${nCold} cold-topic (target ${wantExplore})`);
if (Object.values(quotaMisses).some(Boolean)) console.log(`QUOTA MISSES: ${JSON.stringify(quotaMisses)} — review the source pool; do not fill by relaxing a target silently`);
if (BURN_WINDOW > 0 || MAX_USES > 0 || BURN_DAYS > 0) {
  const blocked = screened.filter((d) => d.usable && isBurned(d.recId, burn, burnOpts));
  const reused = keep.filter((k) => (burn.get(k.recId)?.publishes || 0) > 0).length;
  console.log(`burn screen: ${blocked.length} usable donor(s) held back (cap ${MAX_USES} use(s) · ${BURN_WINDOW} run(s) · ${BURN_DAYS}d cooling) · ${burn.size} covered all-time · ${reused} of this batch is a deliberate reuse`);
} else {
  const reused = keep.filter((k) => (burn.get(k.recId)?.publishes || 0) > 0).length;
  console.log(`burn screen: off (owner 2026-09-28) · ${reused} of this batch we have covered before`);
}
console.log(reuseRead === 'read'
  ? `reuse rule: ${reuseHeld.size} donor(s) held back (${(REUSE?.coversMax ?? 3) + 1}+ covers in ${REUSE?.days ?? 30} days, none of ours over ${(REUSE?.winnerViews ?? 200000).toLocaleString()} views) · ${reuseWinners} winner(s) kept despite that`
  : `reuse rule: ${reuseRead === 'off' ? 'off' : `NOT APPLIED, registry ${reuseRead} (unverified: nothing was held back)`}`);
console.log(`jev route (no named supplement, Health): ${jevRouted.size} donor(s) given a product by Jev${jevRouteMisses.length ? ` · ${jevRouteMisses.length} left out` : ''}${keep.filter((k) => k.translate).length ? ` · ${keep.filter((k) => k.translate).length} to recreate in English` : ''}`);
console.log(fwRead === 'read'
  ? `his fresh winners (≤${FW.maxAgeDays ?? 3}d, est. day one ≥${(FW.views ?? 500000).toLocaleString()}): ${fwPlaced.length} placed first${fwMisses.length ? ` · NOT PLACED: ${fwMisses.map(([id, why]) => `${id} (${why})`).join('; ')}` : ''}`
  : `his fresh winners: ${fwRead === 'off' ? 'off' : `NOT APPLIED, cohort ${fwRead} (unverified: merit filled every slot)`}`);
if (pinned.length || pinMisses.length) console.log(`pinned: ${pinned.join(', ') || 'none placed'}${pinMisses.length ? ` · NOT PLACED: ${pinMisses.map(([id, why]) => `${id} (${why})`).join('; ')}` : ''}`);
console.log(`topics this batch: ${JSON.stringify(batchTopics)}`);
console.log(`hot (last ${LAWS.selection?.topicMemoryDays ?? 21}d): ${[...HOT].join(', ') || '—'}`);
console.log(`memory: ${fmtMem(memory) || '(empty — no ledger history, every topic reads as new)'}\n`);
console.log('SHIPPABLE TOGETHER');
console.log('  recId               arm       age   score   views     ×reach ×rec ×int ×nov  topic       handle             hook');
for (const d of keep) {
  const f = byId.get(d.recId)?.fields || {};
  console.log(`  ${d.recId}  ${d.arm.padEnd(8)} ${String(d.age).padStart(5)}d ${String(d.score).padStart(6)}  ${String(f.Impressions || 0).padStart(9)}`
    + `  ${String(d.reach).padStart(4)} ${String(d.recency).padStart(4)} ${String(d.intent).padStart(4)} ${String(d.novelty).padStart(4)}`
    + `  ${String(d.topic).padEnd(11)} @${(handle(d.recId) || '?').padEnd(17)} ${JSON.stringify(String(f.Text || '').replace(/\s+/g, ' ').slice(0, 44))}`);
}
console.log('\n  tweet URLs');
for (const d of keep) console.log(`  ${d.recId}  ${byId.get(d.recId)?.fields?.['Tweet URL'] || '(no Tweet URL on the swipe row)'}`);
if (OUT_DIR) {
  mkdirSync(join(OUT_DIR, 'donors'), { recursive: true, mode: 0o700 });
  for (const d of keep) {
    const f = byId.get(d.recId)?.fields || {};
    writeFileSync(join(OUT_DIR, 'donors', `${d.recId}.txt`), `${f['Tweet URL'] || ''}\n\n${f['Full Thread Text (live)'] || f['Full Thread Text'] || f.Text || ''}\n`, { mode: 0o600 });
  }
  console.log(`\n  ${keep.length} donor bod${keep.length === 1 ? 'y' : 'ies'} → ${join(OUT_DIR, 'donors')}${snapshotOut ? ` · snapshot → ${snapshotOut}` : ''}`);
}
if (keep.length < NEED) console.log(`\n  only ${keep.length} of ${NEED} clear the screen — say so rather than shipping a near-twin`);
if (rejected.length) {
  console.log(`\nREJECTED (${rejected.length})`);
  for (const [id, why] of rejected.slice(0, 12)) console.log(`  ${id}  ${why}`);
}
