// harvest-gate.mjs — the farm's referee. registry-sync is the SENSOR (fresh lifetime figures per
// row); this file is the only thing that JUDGES them: who crosses the Harvest entry gate, what an
// attempt's verdict is, when a body becomes Seed-Eligible, when a seed goes Dormant. Airtable
// stores the state and never computes it; every threshold comes from laws.json farm.* and nothing
// here restates a number.
//
// Built 2026-09-02 as the surgery's referee half (operator doc + session 2026-09-01). The design
// carries three scars from this codebase's own history:
//   - UPSERT, NEVER BLIND POST. Harvests rows are created by upsert on Origin Draft ID, so a crash
//     between compute and write can never double-induct a body (the vendor-snapshot duplicate-row
//     lesson, encoded in lib's airtable client).
//   - FROM-SET GUARDS on every machine transition. The gate moves machine states only (Potential /
//     In Pool -> Seed-Eligible / Retired; Active/Approved -> Dormant) and never touches a row the
//     operator has taken over (Seeded, Evergreen, overrides, notes) — accounts-sync's 'Active'
//     master-switch lesson: an engine that reverts operator edits silently is its own bug class.
//   - MONOTONIC VERDICTS. An attempt is judged once its provisional window closes and Judged At is
//     blank; after that the only legal flip is Missed -> Performed (lifetime accrual can promote,
//     never demote). Re-running the gate on unchanged data produces zero patches.
//
//   node harvest-gate.mjs --dry     # plan against live data, print everything, write nothing
//   node harvest-gate.mjs           # standalone live run (registry-sync also runs this per-sync)
//
// Env: AIRTABLE_PAT, REGISTRY_BASE_ID (+ Telegram vars for the signal pings).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, telegram, esc, report, opsLog, loadLedger, HERE_DIR } from './lib.mjs';
import { LAWS } from './laws.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE, topicFor } from './config.mjs';
import { classifyCover } from './harvest-classify.mjs';

const STATE_FILE = join(HERE_DIR, 'queues', 'farm-gate-state.json');
const HARVESTS = 'Harvests';
const SEEDS = 'Seeds';

// ---- pure verdicts (unit-tested offline, like buildRow/checkInvariants) --------------------------

/**
 * The entry gate, on LIFETIME figures (clicks = Levanta lifetime, never Typefully's). Three paths,
 * any one admits: views+commission, views+clicks, or straight commission with no view floor.
 * Returns { passes, path, potential } — potential means "not passing, but past the watchlist
 * floor". factor scales every threshold (the pot gate is this at farm.potGateFactor).
 */
export function evaluateEntryGate({ views = 0, commission = 0, clicks = 0, linkClicks = 0 } = {}, farm = LAWS.farm, factor = 1, floors = null) {
  // floors replace the scaled bars when a lane has its own (the pot gate: farm.potGateViews and
  // farm.potGateCommission). Everything not named in floors still scales by factor.
  const own = (v, scaled) => (Number.isFinite(v) && v > 0 ? v : scaled);
  const viewBar = own(floors?.views, farm.gateViews * factor);
  const commissionBar = own(floors?.commission, farm.gateCommission * factor);
  const path = views >= viewBar && commission >= commissionBar ? 'views+commission'
    : views >= viewBar && clicks >= farm.gateClicks * factor ? 'views+clicks'
    // FOURTH PATH (2026-09-16), on the same-day sensor. The three paths above all wait on Levanta,
    // which settles ~3% on the day a body crosses and measures only clicks that REACHED a tracked
    // destination — so a body whose attribution is broken is invisible to the farm no matter how
    // it performed. 21 posts past the view floor carry real Typefully clicks and zero Levanta.
    // ADDITIVE by construction: it admits, it never rejects, so nothing the clicks path already
    // catches is lost to it. The bar is derived in laws.json's $gateTypefullyClicks.
    : views >= viewBar && linkClicks >= (farm.gateTypefullyClicks ?? Infinity) * factor ? 'views+tfclicks'
    : commission >= farm.gateStraightCommission * factor ? 'straight'
    : null;
  return { passes: !!path, path, potential: !path && commission >= farm.potentialFloor };
}

/** The pot gate: the same paths at farm.potGateFactor (0.8x), except the two bars the owner set
 *  for pots on 2026-11-19: views at farm.potGateViews and the views+commission money at
 *  farm.potGateCommission. Without a key, that bar scales by potGateFactor as before. */
export const evaluatePotGate = (stats, farm = LAWS.farm) => evaluateEntryGate(stats, farm, farm.potGateFactor,
  { views: farm.potGateViews, commission: farm.potGateCommission });

/** Harvest repeats qualify at 70% of the standard entry thresholds; origins still use 100%. */
export const evaluateAttemptGate = (stats, farm = LAWS.farm) => evaluateEntryGate(stats, farm, farm.attemptGateFactor ?? 1);

/** Tier by settled tracked commission. Below tier1Min = Untiered (a clicks-path entrant whose
 *  money has not settled yet — it holds a pool seat, it just is not ranked). */
export function tierOf(commission = 0, farm = LAWS.farm) {
  return commission >= farm.tier3Min ? 'T3' : commission >= farm.tier2Min ? 'T2' : commission >= farm.tier1Min ? 'T1' : 'Untiered';
}

/** The statuses the MACHINE still owns — every one of them set by this file, none of them taken
 *  by the operator yet. Past these the body is the operator's (Seeded, Evergreen) or history
 *  (Retired, Expired), and its origin figures are final. Seed-Eligible belongs on THIS side of the
 *  line: the row sits there until /seed-mint copies its origin figures into a Seed, so freezing it
 *  at the flag would mint the seed's provenance from the same half-settled money the pool ranked on. */
export const MACHINE_OWNED = new Set(['In Pool', 'Potential', 'Seed-Eligible']);

/**
 * KEEP THE ORIGIN FIGURES SETTLING while the machine still owns the row. Returns only the fields
 * that actually move, so an unchanged body still plans zero patches.
 *
 * The first cut froze all three origin figures at induction. That was right for views and wrong
 * for money. The entry gate's views+clicks path exists to admit a body the day after it posts —
 * and on that day Levanta has ingested ~98% of its views but ~3% of its commission. The pool then
 * ranked on $/1k (the operator's stated selection metric, 2026-09-02) by dividing a censored
 * numerator into a complete denominator, so the densest shapes sank to the bottom of the very list
 * that decides where hearts go. Measured on the live pool 2026-09-16: 34 of 41 bodies understated,
 * the worst by 30x ($0.00/1k printed for a body holding $712.70), five of the true top ten sitting
 * at ranks 20-30 with every heart unspent, and 54 of 68 spent hearts aimed outside the true top 8.
 *
 * The number stops moving when the body leaves machine ownership — that is when it becomes the
 * record a seed is minted from. MONOTONIC, like the verdicts one screen up: lifetime figures
 * accrue, so a refresh may only raise, and a late Levanta reversal can no more un-earn a body's
 * tier than it can un-Perform an attempt. Tier is derived from the SAME refreshed figure, so the
 * two can never again contradict each other on one row (T3 beside $0.00 was the visible symptom).
 */
export function settleOrigin(fields = {}, { views = 0, commission = 0, clicks = 0 } = {}, farm = LAWS.farm) {
  const wasV = Number(fields['Origin Views'] || 0);
  const wasC = Number(fields['Origin Commission'] || 0);
  const wasK = Number(fields['Origin Clicks'] || 0);
  const v = Math.max(wasV, Number(views) || 0);
  const c = Number(Math.max(wasC, Number(commission) || 0).toFixed(2));
  const k = Math.max(wasK, Number(clicks) || 0);
  const out = {};
  if (v !== wasV) out['Origin Views'] = v;
  if (c !== wasC) out['Origin Commission'] = c;
  if (k !== wasK) out['Origin Clicks'] = k;
  const tier = tierOf(c, farm);
  if (fields.Tier !== tier) out.Tier = tier;
  return out;
}

/**
 * One attempt's (or pot's) verdict. Judged against its OWN row's lifetime figures — the same
 * absolute gate per attempt, any account (operator: "Julian's winner can run on Tina's page";
 * small pages same bar, with Account Size At Origin logged so data can arbitrate later).
 *   - not yet published, or younger than the provisional window -> 'Pending'
 *   - window closed, never judged -> 'Performed' / 'Missed' (first judgment; caller stamps Judged At)
 *   - already 'Missed' -> re-judged every run; lifetime accrual may flip it to 'Performed'
 *   - already 'Performed' -> immutable
 * Returns the verdict the row SHOULD carry; the caller diffs against what it does carry.
 */
export function attemptVerdict({ postedAt, stats, verdict, isPot = false }, now = Date.now(), farm = LAWS.farm) {
  if (verdict === 'Performed') return 'Performed';
  const gate = () => (isPot ? evaluatePotGate(stats, farm) : evaluateAttemptGate(stats, farm)).passes;
  if (verdict === 'Missed') return gate() ? 'Performed' : 'Missed';
  const posted = postedAt ? new Date(postedAt).getTime() : null;
  if (!posted || now - posted < farm.verdictProvisionalHours * 3600e3) return 'Pending';
  if (gate()) return 'Performed';
  // A low number at 48h after publication may still be an incomplete transaction day.
  // Allow the publication day's UTC close + ingestion lag before recording a miss.
  const dayEnd = Date.parse(new Date(posted).toISOString().slice(0, 10)) + 864e5;
  if (now < dayEnd + (farm.reportSettlementHours ?? 0) * 3600e3) return 'Pending';
  return 'Missed';
}

/** The one PC-field literal every farm writer shares (republish --harvest, /pot, the gate's own
 *  patches). CI scans this file's quoted keys against docs/registry-schema.json, so a typo fails
 *  the build instead of 422-killing a whole PATCH batch in production. */
export function farmStampRow({ draftId, harvestRecId = null, seedRecId = null, potRecId = null, seedVersion = null, batch = null, verdict = null, judgedAt = null } = {}) {
  return {
    'Draft ID': String(draftId),
    ...(harvestRecId ? { 'Harvest': [harvestRecId] } : {}),
    ...(seedRecId ? { 'Seed': [seedRecId] } : {}),
    // Pot (2026-09-02): the Pots row this plant was shipped from — Seed → Pots → Plants.
    ...(potRecId ? { 'Pot': [potRecId] } : {}),
    ...(seedVersion != null ? { 'Seed Version': seedVersion } : {}),
    ...(batch ? { 'Batch': batch } : {}),
    ...(verdict ? { 'Attempt Verdict': verdict } : {}),
    ...(judgedAt ? { 'Judged At': judgedAt } : {}),
  };
}

/**
 * The whole run, planned purely: registry state in, writes + pings out. Nothing here fetches.
 *
 *   pcRows       [{ draftId, recId, post, account, title, status, postedAt, xUrl, views,
 *                   commission, clicks, harvestIds[], seedIds[], verdict, judgedAt, archived, type }]
 *   harvestRecs  raw Airtable records [{ id, fields }] from Harvests
 *   seedRecs     raw Airtable records from Seeds
 *   variationByDraft Map draftId -> rewritten parent; provenance only, never a parent attempt
 *   sourceByDraft  Map draftId -> parent draftId (evergreen sourceDraftId / harvestOf) — a re-run
 *                  or variation of one of our own drafts must NEVER be inducted as its own body
 *   followersByAccount  Map account name -> current follower count (best-effort; null ok)
 *   excludedAccounts    Set of account NAMES barred from induction (burner, clients, external)
 *   state        parsed queues/farm-gate-state.json, or null on a bootstrap run
 *
 * Returns { harvestCreates, harvestPatches, seedPatches, pcPatches, pings, nextState, summary }.
 *   harvestCreates -> upsert on 'Origin Draft ID' (origin figures start here and keep SETTLING
 *                     while the row is machine-owned; see settleOrigin)
 *   harvestPatches / seedPatches -> update by record id, machine states only
 *   pcPatches      -> upsert on 'Draft ID'
 */
export function planFarmActions({ pcRows = [], harvestRecs = [], seedRecs = [], sourceByDraft = new Map(), variationByDraft = new Map(), potSeedByDraft = new Map(), sourceUrlByDraft = new Map(), followersByAccount = new Map(), excludedAccounts = new Set(), state = null, now = Date.now(), farm = LAWS.farm } = {}) {
  const draftIds = new Set();
  for (const r of pcRows) {
    const id = String(r.draftId || '');
    if (!id) continue;
    if (draftIds.has(id)) throw new Error(`Duplicate registry Draft ID ${id}; reconcile before judging the farm`);
    draftIds.add(id);
  }
  const nowIso = new Date(now).toISOString();
  const excludeTitle = new RegExp(farm.excludeTitle);
  const published = (r) => r.status === 'Posted' || r.status === 'Reposted' || r.status === 'Winner' || r.status === 'Repost Candidate';
  const stats = (r) => ({ views: r.views || 0, commission: r.commission || 0, clicks: r.clicks || 0, linkClicks: r.typefullyClicks || 0 });

  const harvestByOrigin = new Map(harvestRecs.map((h) => [String(h.fields['Origin Draft ID'] || ''), h]));
  const seedByName = new Map(seedRecs.map((s) => [String(s.fields.Name || '').toLowerCase(), s]));
  const harvestCreates = [];
  const harvestPatches = [];
  const seedPatches = [];
  const pcPatches = [];
  const pings = [];
  const judged = [];

  // ---- 1. verdicts (attempts + pots), and the Harvest-link backfill --------------------------
  // An attempt normally arrives already linked (republish --harvest stamps it at creation); when
  // the stamp failed, the ledger's parent join recovers it — backfill ONLY a blank link, the
  // reconcileLinks idempotency pattern.
  const attemptsByHarvest = new Map(); // harvest rec id -> [{ row, finalVerdict }]
  const potsBySeed = new Map();        // seed rec id -> [{ row, finalVerdict }]
  for (const r of pcRows) {
    if (r.archived || variationByDraft.has(String(r.draftId))) continue;
    let hIds = (r.harvestIds || []).filter((id) => {
      const h = harvestRecs.find((h) => h.id === id);
      return h && String(h.fields['Origin Draft ID'] || '') !== String(r.draftId);
    });
    let backfilledH = null;
    if (!hIds.length && sourceByDraft.has(String(r.draftId))) {
      const parent = harvestByOrigin.get(String(sourceByDraft.get(String(r.draftId))));
      // ONLY POST-INDUCTION RE-RUNS ARE ATTEMPTS. The ledger's sourceDraftId/harvestOf joins reach
      // back through the whole evergreen-lane era, and the first live run (2026-09-01 20:23) linked
      // 15 pre-farm reposts as spent hearts — Rafael's best body opened its audition 4/7 down for
      // history that predates the farm. The operator's law is the opposite: hearts are FRESH at
      // induction, and a later re-cross is a fresh audition. So the backfill (which exists for
      // stamp failures of NEW /attempt runs) requires the row to have published on or after the
      // body's Inducted At; older re-runs stay data in the registry, never hearts.
      const inductedAt = parent?.fields['Inducted At'] ? Date.parse(parent.fields['Inducted At']) : null;
      const postedTs = r.postedAt ? Date.parse(r.postedAt) : null;
      if (parent && inductedAt != null && postedTs != null && postedTs >= inductedAt) { backfilledH = parent.id; hIds = [parent.id]; }
    }
    let sIds = r.seedIds || [];
    let backfilledS = null;
    if (!sIds.length && potSeedByDraft.has(String(r.draftId))) {
      const seed = seedByName.get(String(potSeedByDraft.get(String(r.draftId))).toLowerCase());
      if (seed) { backfilledS = seed.id; sIds = [seed.id]; }
    }
    const isAttempt = hIds.length > 0;
    const isPot = !isAttempt && sIds.length > 0;
    if (!isAttempt && !isPot) continue;
    const want = attemptVerdict({ postedAt: published(r) ? r.postedAt : null, stats: stats(r), verdict: r.verdict || null, isPot }, now, farm);
    const firstJudgment = want !== 'Pending' && !r.judgedAt;
    const changed = want !== (r.verdict || null);
    if (changed || backfilledH || backfilledS) {
      pcPatches.push(farmStampRow({
        draftId: r.draftId,
        harvestRecId: backfilledH,
        seedRecId: backfilledS,
        verdict: changed ? want : null,
        judgedAt: firstJudgment ? nowIso : null,
      }));
    }
    if (changed && (want === 'Performed' || want === 'Missed')) judged.push({ row: r, verdict: want, flip: r.verdict === 'Missed' });
    const finalVerdict = want;
    for (const hid of hIds) { if (!attemptsByHarvest.has(hid)) attemptsByHarvest.set(hid, []); attemptsByHarvest.get(hid).push({ row: r, finalVerdict }); }
    for (const sid of sIds) { if (!potsBySeed.has(sid)) potsBySeed.set(sid, []); potsBySeed.get(sid).push({ row: r, finalVerdict }); }
  }

  // ---- 2. induction: covers (and pots clearing the FULL gate) enter the pool -----------------
  const inducted = [];
  // Tier, and the money Tier is read from, keep following settlement for as long as the machine
  // owns the row — no-op on a body that has stopped moving, silent on one the operator has taken.
  const settle = (existing, r) => {
    if (!MACHINE_OWNED.has(existing.fields.Status)) return;
    const fields = settleOrigin(existing.fields, stats(r), farm);
    if (Object.keys(fields).length) harvestPatches.push({ id: existing.id, fields });
  };
  // WHAT THE POOL ALREADY HOLDS, for the duplicate check below. Post text and donor url per body,
  // so a cover can be recognised as another run of a body rather than inducted as a new one.
  const postByDraft = new Map(pcRows.map((r) => [String(r.draftId), String(r.post || r.title || '')]));
  const knownBodies = harvestRecs.map((h) => {
    const d = String(h.fields['Origin Draft ID'] || '');
    return { id: h.id, draftId: d, post: postByDraft.get(d) || h.fields.Body || '', variationOf: variationByDraft.get(d) || null, sourceUrl: sourceUrlByDraft.get(d) || null, status: h.fields.Status };
  });
  const matchedToExisting = [];
  for (const r of pcRows) {
    if (r.archived || !published(r)) continue;
    // A rewritten body may qualify independently; an old link must not turn it into an attempt.
    if ((r.harvestIds || []).length && !variationByDraft.has(String(r.draftId))) continue;
    if (sourceByDraft.has(String(r.draftId))) continue;              // legacy re-run — the parent is the body
    if (excludedAccounts.has(r.account)) continue;                   // burner + client + external accounts, by roster rule
    if (excludeTitle.test(r.title || '')) continue;                  // reference/parked drafts, by title rule
    if (r.type === 'Article') continue;                              // a native X Article is not a thread body (owner, R2026-10-03: articles are additive)
    const g = evaluateEntryGate(stats(r), farm);
    const existing = harvestByOrigin.get(String(r.draftId));
    // IS THIS A NEW BODY, OR ANOTHER RUN OF ONE WE HOLD? (2026-09-16, operator.) Two accounts
    // covering the same donor both cross the gate, and the pool used to take two rows for one
    // body — each auditing alone on its own 7 hearts, each needing its own 2 performs, so a shape
    // that performed once under Rafael and once under Clara read as two bodies that never became
    // seed-eligible. Only the DONOR signal links unattended: it is definitional. Hook similarity
    // is reported by harvest-classify.mjs and merged by hand, because the Post field is a
    // truncated hook and cannot prove two threads are the same thread.
    const twin = !existing && g.passes ? classifyCover({ draftId: r.draftId, variationOf: variationByDraft.get(String(r.draftId)) || null, post: r.post || r.title, sourceUrl: sourceUrlByDraft.get(String(r.draftId)) }, knownBodies) : null;
    if (twin?.confident) {
      // A body the OPERATOR owns is never written to; the duplicate is simply not created, and the
      // match is reported so they can decide what the re-run means for a seed they already minted.
      if (MACHINE_OWNED.has(twin.match.status)) pcPatches.push(farmStampRow({ draftId: r.draftId, harvestRecId: twin.match.id }));
      matchedToExisting.push({ row: r, body: twin.match, via: twin.via, why: twin.why, linked: MACHINE_OWNED.has(twin.match.status) });
      continue;
    }
    if (g.passes) {
      if (!existing) {
        harvestCreates.push({
          'Origin Draft ID': String(r.draftId),
          'Body': String(r.post || r.title || '').split('\n')[0].slice(0, 60),
          ...(r.xUrl ? { 'Origin X URL': r.xUrl } : {}),
          'Origin Account': r.account,
          'Status': 'In Pool',
          'Tier': tierOf(r.commission || 0, farm),
          'Inducted At': nowIso,
          'Origin Views': r.views || 0,
          'Origin Commission': Number((r.commission || 0).toFixed(2)),
          'Origin Clicks': r.clicks || 0,
          ...(followersByAccount.get(r.account) != null ? { 'Account Size At Origin': followersByAccount.get(r.account) } : {}),
          ...(r.recId ? { 'Origin Post': [r.recId] } : {}),
        });
        inducted.push({ row: r, path: g.path, to: 'In Pool' });
      } else if (existing.fields.Status === 'Potential') {
        // The watchlist promotion: hearts start NOW. The figures are whatever has settled by the
        // crossing — kept current below while the row waited — and are stamped through the same
        // monotonic path, so a late revision can never lower what the body already proved.
        harvestPatches.push({ id: existing.id, fields: {
          'Status': 'In Pool', 'Inducted At': nowIso,
          ...settleOrigin(existing.fields, stats(r), farm),
          ...(followersByAccount.get(r.account) != null ? { 'Account Size At Origin': followersByAccount.get(r.account) } : {}),
        } });
        inducted.push({ row: r, path: g.path, to: 'In Pool', promoted: true });
      } else {
        settle(existing, r);
      }
    } else if (existing) {
      // Not gate-passing today, but the row may still be settling: a watchlist body whose money is
      // still landing, or — should Levanta ever revise views down under an inducted one — a body
      // that no longer clears on its own. It never has to again; its hearts are already running.
      settle(existing, r);
    } else if (g.potential) {
      harvestCreates.push({
        'Origin Draft ID': String(r.draftId),
        'Body': String(r.post || r.title || '').split('\n')[0].slice(0, 60),
        ...(r.xUrl ? { 'Origin X URL': r.xUrl } : {}),
        'Origin Account': r.account,
        'Status': 'Potential',
        'Tier': 'Untiered',
        'Origin Views': r.views || 0,
        'Origin Commission': Number((r.commission || 0).toFixed(2)),
        'Origin Clicks': r.clicks || 0,
        ...(r.recId ? { 'Origin Post': [r.recId] } : {}),
      });
      inducted.push({ row: r, path: 'potential', to: 'Potential' });
    }
  }

  // ---- 3. body transitions: Seed-Eligible / Retired / expiry warnings ------------------------
  // Performs are counted LIVE off this run's verdicts (the Airtable rollup lags our own PC patch
  // by one sync, and a sacred event should not wait a cycle).
  const sacred = [];
  const expiring = [];
  const sacredPinged = new Set(state?.sacredPinged || []);
  const expiryWarned = new Set(state?.expiryWarned || []);
  for (const h of harvestRecs) {
    // Sacred CATCH-UP (2026-09-01 review finding): the transition below fires exactly once, so if
    // that run's Telegram send failed, the row sat Seed-Eligible with its ping unsendable forever
    // (the status is no longer In Pool, so the transition never re-plans). A Seed-Eligible row the
    // state does not remember as pinged gets its ping re-planned here; runFarmGate un-persists a
    // failed ping's ids so this branch is exactly the retry path.
    if (h.fields.Status === 'Seed-Eligible' && !sacredPinged.has(h.id)) {
      const performs = (attemptsByHarvest.get(h.id) || []).filter((a) => a.finalVerdict === 'Performed').length;
      sacred.push({ h, performs: performs || farm.performsToSeed });
      sacredPinged.add(h.id);
    }
    if (h.fields.Status !== 'In Pool') continue;                     // machine moves machine states only
    const attempts = attemptsByHarvest.get(h.id) || [];
    const performs = attempts.filter((a) => a.finalVerdict === 'Performed').length;
    const pending = attempts.filter((a) => a.finalVerdict === 'Pending').length;
    if (performs >= farm.performsToSeed) {
      harvestPatches.push({ id: h.id, fields: { 'Status': 'Seed-Eligible' } });
      if (!sacredPinged.has(h.id)) { sacred.push({ h, performs }); sacredPinged.add(h.id); }
      continue;
    }
    if (attempts.length >= farm.hearts && pending === 0) {
      harvestPatches.push({ id: h.id, fields: { 'Status': 'Retired' } });
      continue;
    }
    const expiresAt = h.fields['Expires At'] ? new Date(h.fields['Expires At']).getTime() : null;
    if (expiresAt && now >= expiresAt - 7 * 864e5 && !expiryWarned.has(h.id)) {
      expiring.push({ h, expiresAt });
      expiryWarned.add(h.id);
    }
  }

  // ---- 4. seed judgment: 3 consecutive failed pots -> Dormant, or the owner's call --------------------------------
  // Consecutive = the most recent JUDGED pots by posted date; a dead seed never kills a living
  // body (nothing here touches Harvests), and the operator revives or expires a Dormant seed.
  const dormant = [];
  const dormantFlagged = { ...(state?.dormantFlagged || {}) };
  for (const s of seedRecs) {
    const potsJudged = (potsBySeed.get(s.id) || [])
      .filter((p) => p.finalVerdict === 'Performed' || p.finalVerdict === 'Missed')
      .sort((a, b) => String(b.row.postedAt || '').localeCompare(String(a.row.postedAt || '')));
    const recent = potsJudged.slice(0, farm.potFailsToDormant);
    const failing = recent.length >= farm.potFailsToDormant && recent.every((p) => p.finalVerdict === 'Missed');
    const setKey = recent.map((p) => String(p.row.draftId)).sort().join(',');
    // A sleeping seed's plants keep being judged, so its failing set moves on after it was flagged.
    // Remember the latest one, or a revival is re-flagged by misses that landed while it slept
    // (olive, peach and beet, 2026-10-07).
    if (s.fields.Status === 'Dormant') { if (failing) dormantFlagged[s.id] = setKey; continue; }
    if (!['Active', 'Approved'].includes(s.fields.Status)) continue;
    if (failing) {
      // ONE-SHOT PER FAILURE SET (2026-09-01 review finding): without this, an operator revival
      // (Status -> Active) was re-flagged Dormant on the very next sync by the SAME three stale
      // misses, forever — the machine fighting the operator, the accounts-sync 'Active' lesson in
      // new clothes. The state remembers WHICH pot set flagged the seed; only a DIFFERENT set (a
      // new judged miss) may flag it again, so a revival stands until new evidence arrives.
      if (dormantFlagged[s.id] !== setKey) {
        // farm.potFailsAutoDormant false (owner 2026-11-19): the seed's status is the owner's call.
        // The failing set is still recorded and returned, so it is reported once and never patched.
        const auto = farm.potFailsAutoDormant !== false;
        if (auto) seedPatches.push({ id: s.id, fields: { 'Status': 'Dormant' } });
        dormant.push({ s, fails: recent.length, ownerCall: !auto });
        dormantFlagged[s.id] = setKey;
      }
    }
  }

  // ---- 5. the signals — thin, deduped, silent on bootstrap -----------------------------------
  const bootstrap = state == null;
  if (!bootstrap) {
    if (judged.length) {
      const lines = judged.slice(0, 12).map(({ row, verdict, flip }) =>
        `${verdict === 'Performed' ? '💚' : '💔'} <b>${esc(row.account || '?')}</b> — ${esc(String(row.post || row.title || '').slice(0, 56))}${flip ? ' <i>(late flip: Missed → Performed)</i>' : ''}`);
      pings.push({ kind: 'verdicts', text: report({
        emoji: '⏱️', title: 'Farm verdicts', scope: `${judged.length} attempt(s) judged at ${farm.verdictProvisionalHours}h`,
        status: `💚 ${judged.filter((j) => j.verdict === 'Performed').length} performed · 💔 ${judged.filter((j) => j.verdict === 'Missed').length} missed (provisional — lifetime accrual can still flip a miss)`,
        sections: [{ label: 'VERDICTS', body: lines.join('\n') + (judged.length > 12 ? `\n…and ${judged.length - 12} more.` : '') }],
      }) });
    }
    for (const { h, performs } of sacred) pings.push({ kind: 'sacred', text: report({
      emoji: '🌱', title: 'SEED-ELIGIBLE — a body earned its name', scope: esc(String(h.fields.Body || '').slice(0, 60)),
      status: `💚 ${performs} performs of ${farm.hearts} hearts — the gate says this body repeats`,
      sections: [{ label: 'THE SACRED EVENT', body: `Origin: <b>${esc(h.fields['Origin Account'] || '?')}</b> · Tier ${esc(h.fields.Tier || '?')}${h.fields['Origin X URL'] ? ` · <a href="${h.fields['Origin X URL']}">post</a>` : ''}\nRun /seed-mint to templatize it and pick its fruit name — the row waits for YOUR approval, the machine goes no further.` }],
    }) });
    if (expiring.length) pings.push({ kind: 'expiry', text: report({
      emoji: '⌛', title: 'Hearts expiring', scope: `${expiring.length} body(ies) near the ${farm.heartsExpiryDays}-day mark`,
      status: 'Operator call: extend the audition or retire the body — the machine will not decide this.',
      sections: [{ label: 'EXPIRING', body: expiring.map(({ h, expiresAt }) => `• ${esc(String(h.fields.Body || '').slice(0, 56))} — expires ${new Date(expiresAt).toISOString().slice(0, 10)}`).join('\n') }],
    }) });
  }

  const nextState = { updatedAt: nowIso, sacredPinged: [...sacredPinged], expiryWarned: [...expiryWarned], dormantFlagged };
  const summary = `${harvestCreates.length} induction(s) [${inducted.filter((i) => i.to === 'In Pool').length} pool / ${inducted.filter((i) => i.to === 'Potential').length} potential]${matchedToExisting.length ? `, ${matchedToExisting.length} matched to a body we already hold` : ''}, ${judged.length} verdict(s), ${sacred.length} seed-eligible, ${dormant.length} ${dormant.some((d) => d.ownerCall) ? `seed(s) with ${farm.potFailsToDormant} missed pots (owner's call)` : 'dormant seed(s)'}, ${expiring.length} expiry warning(s)${bootstrap ? ' — bootstrap (pings suppressed)' : ''}`;
  return { matchedToExisting, harvestCreates, harvestPatches, seedPatches, pcPatches, pings, nextState, summary, inducted, judged, sacred, dormant, expiring };
}

// ---- I/O runner ----------------------------------------------------------------------------------

/** Latest follower count per account name, from the Account Metrics daily snapshots. Best-effort:
 *  a failure returns an empty map — Account Size At Origin is instrumentation, never a blocker. */
async function latestFollowers(at) {
  const map = new Map();
  try {
    for (const rec of await at.listAll('Account Metrics', { fields: ['Account', 'Date', 'Followers'] })) {
      const f = rec.fields;
      if (!f.Account || f.Followers == null) continue;
      const prev = map.get(f.Account);
      if (!prev || String(f.Date || '') > prev.date) map.set(f.Account, { date: String(f.Date || ''), n: f.Followers });
    }
  } catch { return new Map(); }
  return new Map([...map].map(([k, v]) => [k, v.n]));
}

const CORRECTIONS_FILE = join(HERE_DIR, 'farm-lineage-corrections.json');

/** Measured lineage corrections (farm-lineage-corrections.json): reposts ledgered as variationOf whose
 *  shipped copy is the source body under farm.harvestEditMax with the hook unchanged. Only rows that
 *  still clear the law are returned, so the file can never turn a real rewrite into a heart. */
export function loadLineageCorrections(raw = existsSync(CORRECTIONS_FILE) ? readFileSync(CORRECTIONS_FILE, 'utf8') : null, farm = LAWS.farm) {
  const out = new Map();
  if (!raw) return out;
  for (const c of JSON.parse(raw).corrections || []) {
    const share = Number(c.editShare);
    if (!c.draftId || !c.harvestOf || c.hookSame !== true || !Number.isFinite(share) || share >= (farm.harvestEditMax ?? 0)) continue;
    out.set(String(c.draftId), String(c.harvestOf));
  }
  return out;
}

/** Ledger lineage separates rewritten bodies from actual attempts. Explicit variation wins over stale
 *  aliases, unless a measured correction shows the "variation" shipped the source body. */
export function farmLineageFromLedger(byDraft, corrections = new Map()) {
  const sourceByDraft = new Map(), variationByDraft = new Map(), potSeedByDraft = new Map(), sourceUrlByDraft = new Map();
  for (const [id, e] of byDraft) {
    const corrected = corrections.get(String(id));
    if (corrected && (!e.variationOf || String(e.variationOf) === corrected)) sourceByDraft.set(String(id), corrected);
    else if (e.variationOf) variationByDraft.set(String(id), String(e.variationOf));
    else {
      const parent = e.sourceDraftId || e.harvestOf;
      if (parent) sourceByDraft.set(String(id), String(parent));
    }
    if (e.potOf) potSeedByDraft.set(String(id), String(e.potOf));
    if (e.sourceUrl) sourceUrlByDraft.set(String(id), String(e.sourceUrl));
  }
  return { sourceByDraft, variationByDraft, potSeedByDraft, sourceUrlByDraft };
}

/**
 * One full gate pass against the live base. Called by registry-sync after reconcileLinks (non-fatal
 * there) and runnable standalone. Reads everything it needs itself so a partial caller context can
 * never feed it stale rows. State is persisted only AFTER the Airtable writes succeed, so a torn
 * run re-plans (idempotently) rather than losing pings.
 */
export async function runFarmGate(env, { dry = false, notify = true } = {}) {
  const metricsPath = join(HERE_DIR, 'queues', 'registry-row-hashes.json');
  const metrics = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, 'utf8')) : null;
  if (!metrics?.metricsComplete || !Number.isFinite(Date.parse(metrics.updatedAt)) || Date.now() - Date.parse(metrics.updatedAt) > 8 * 3600e3) {
    throw new Error('Farm judgment deferred: run a complete registry metrics sync within the last 8 hours first');
  }
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const pcRecs = await at.listAll(REGISTRY_TABLE, { fields: [
    'Draft ID', 'Post', 'Account', 'Status', 'Posted Date', 'X URL', 'Impressions',
    'Lifetime Commission', 'Lifetime Clicks', 'Commission', 'Affiliate Clicks', 'Link Clicks',
    'Harvest', 'Seed', 'Attempt Verdict', 'Judged At', 'Archived', 'Type',
  ] });
  const harvestRecs = await at.listAll(HARVESTS);
  const seedRecs = await at.listAll(SEEDS);
  const { byDraft } = loadLedger();
  const { sourceByDraft, variationByDraft, potSeedByDraft, sourceUrlByDraft } = farmLineageFromLedger(byDraft, loadLineageCorrections());
  // Titles: the PC 'Post' column is already marker-stripped, so the exclusion regex needs the raw
  // draft title — which lives only in Typefully. The LOCKED/[CTA]/[parked] population never earns
  // (reference drafts, no minted links), so testing the stripped Post text is belt-and-braces; the
  // roster exclusion below is the load-bearing half (burner owns every [CTA] draft).
  const excludedAccounts = new Set(Object.values(ACCOUNTS).filter((a) => a.burner || a.external || a.trackAll).map((a) => a.name));
  const followersByAccount = await latestFollowers(at);
  let state = null;
  try { if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { state = null; }

  const pcRows = pcRecs.map((rec) => ({
    draftId: String(rec.fields['Draft ID'] || ''),
    recId: rec.id,
    post: rec.fields.Post || '',
    title: rec.fields.Post || '',
    account: rec.fields.Account || '',
    status: rec.fields.Status || '',
    postedAt: rec.fields['Posted Date'] || null,
    xUrl: rec.fields['X URL'] || null,
    views: rec.fields.Impressions || 0,
    commission: rec.fields['Lifetime Commission'] ?? rec.fields.Commission ?? 0,
    clicks: rec.fields['Lifetime Clicks'] ?? rec.fields['Affiliate Clicks'] ?? 0,
    // THE TYPEFULLY SENSOR, and only when the column provably IS it. `Link Clicks` is
    // MAX(Typefully, Levanta) over every link in the thread, which is why this repo fences it off
    // from money math — but where it EXCEEDS Lifetime Clicks the max can only have come from the
    // Typefully side, so that value is the Typefully figure exactly. Where the two tie, Typefully
    // is unknown and no larger than Levanta, and the fourth path simply does not fire: it can
    // never admit on a Levanta number the clicks path already judged. Nothing here divides money
    // by it; it is a click threshold, which is the whole reason the column is trustworthy for this
    // and not for EPC.
    typefullyClicks: Math.max(0, (rec.fields['Link Clicks'] ?? 0) > (rec.fields['Lifetime Clicks'] ?? 0) ? rec.fields['Link Clicks'] : 0),
    harvestIds: rec.fields.Harvest || [],
    seedIds: rec.fields.Seed || [],
    verdict: rec.fields['Attempt Verdict'] || null,
    judgedAt: rec.fields['Judged At'] || null,
    archived: !!rec.fields.Archived,
    type: rec.fields.Type || '',
  })).filter((r) => r.draftId);

  const plan = planFarmActions({ pcRows, harvestRecs, seedRecs, sourceByDraft, variationByDraft, potSeedByDraft, sourceUrlByDraft, followersByAccount, excludedAccounts, state, now: Date.now() });

  if (dry) {
    console.log(`(dry) farm gate plan: ${plan.summary}`);
    for (const i of plan.inducted) console.log(`  → ${i.to}${i.promoted ? ' (promoted from Potential)' : ''} [${i.path}] ${i.row.account}: ${String(i.row.post).slice(0, 60)}`);
    for (const m of plan.matchedToExisting) console.log(`  ⇉ ${m.linked ? 'heart on an existing body' : 'duplicate suppressed (body past the pool)'} [${m.via}] ${m.row.account}: ${String(m.row.post).slice(0, 48)} — ${m.why}`);
    for (const j of plan.judged) console.log(`  ⏱ ${j.verdict}${j.flip ? ' (flip)' : ''}: ${j.row.account} draft ${j.row.draftId}`);
    for (const p of plan.harvestPatches) console.log(`  ✎ harvest ${p.id}: ${JSON.stringify(p.fields)}`);
    for (const p of plan.seedPatches) console.log(`  ✎ seed ${p.id}: ${JSON.stringify(p.fields)}`);
    console.log(`  (${plan.pcPatches.length} PC patch(es), ${plan.pings.length} ping(s) — nothing written)`);
    return plan;
  }

  // Writes, upsert-first so a crash mid-run can only ever under-apply, never duplicate.
  if (plan.harvestCreates.length) await at.upsert(HARVESTS, 'Origin Draft ID', plan.harvestCreates);
  if (plan.harvestPatches.length) await at.update(HARVESTS, plan.harvestPatches);
  if (plan.seedPatches.length) await at.update(SEEDS, plan.seedPatches);
  if (plan.pcPatches.length) await at.upsert(REGISTRY_TABLE, 'Draft ID', plan.pcPatches);

  // PINGS BEFORE THE STATE PERSISTS THEIR DEDUP (2026-09-01 review finding). The old order wrote
  // sacredPinged/expiryWarned to disk and THEN tried Telegram, so one 5xx dropped the sacred signal
  // forever — the transition had already flipped the row past In Pool, and the state already said
  // "pinged". Now a failed kind's additions are UN-persisted: the next run's catch-up branch
  // (Seed-Eligible + not in sacredPinged) or the expiry re-check re-plans and re-sends. The
  // verdicts digest is deliberately not retried — the verdicts themselves live on the rows and in
  // /farm, and re-deriving "what changed last run" would need its own ledger for a nice-to-have.
  const failedKinds = new Set();
  for (const p of plan.pings) {
    if (!notify) { failedKinds.add(p.kind); continue; }
    try { await telegram(env, p.text, topicFor(`farm-${p.kind}`)); } catch (e) { failedKinds.add(p.kind); console.warn(`  ⚠️ farm ping (${p.kind}) failed — will re-send next run: ${e.message}`); }
  }
  const persist = { ...plan.nextState };
  if (failedKinds.has('sacred')) persist.sacredPinged = state?.sacredPinged || [];
  if (failedKinds.has('expiry')) persist.expiryWarned = state?.expiryWarned || [];
  try { writeFileSync(STATE_FILE, JSON.stringify(persist, null, 1) + '\n'); }
  catch (e) { console.warn(`  ⚠️ farm state persist failed (pings may repeat next run): ${e.message}`); }
  if (plan.inducted.length) {
    await opsLog(env, { source: 'farm', level: 'action', event: `Harvest gate: ${plan.harvestCreates.length} induction(s)`, detail: plan.inducted.map((i) => `${i.to}${i.promoted ? ' (promoted)' : ''} [${i.path}] ${i.row.account}: ${String(i.row.post).slice(0, 70)}`).join('\n') }).catch(() => {});
  }
  console.log(`✓ farm gate: ${plan.summary}`);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  runFarmGate(env, { dry: process.argv.includes('--dry') }).catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
