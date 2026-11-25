// run-plan.mjs — engine v2, part D STEP 3: the plan CONSUMER. Reads the reviewed week plan and
// generates one day's slots through the exact same recreate.mjs child invocation daily-winners
// uses — product pair via pickProductPair (conversion + intent aware), spread caps, two attempts.
//
// SAFE BY DEFAULT — three locks, all deliberate:
//   1. Without --execute it only PRINTS the slate (what would generate, from which donor, when).
//   2. --execute additionally requires PLAN_CUTOVER=1 in the environment. Until the operator flips
//      that (cutover, plan D step 3), this file cannot create a draft no matter how it is invoked.
//   3. It NEVER disables or races the old engines — cutover is: enable this in a workflow, turn off
//      daily-winners' cron, keep both dispatchable for rollback.
//
// Lanes:
//   viral — the slot carries the swipe recId; generation is a faithful monetized recreation.
//   mold  — the slot carries moldId; the donor is resolved from molds.json's sourceUrl via the
//           swipe DB, generation passes --mold <id> so the ledger row carries the attribution
//           mold-promote.mjs joins on. A mold whose donor is not in the swipe DB SKIPS LOUDLY —
//           backfill the donor, never improvise a different thread under a mold's name.
//
//   node run-plan.mjs                          # today's slate, print only
//   node run-plan.mjs --day 2026-08-25         # that day's slate, print only
//   PLAN_CUTOVER=1 node run-plan.mjs --day 2026-08-25 --execute
//   node run-plan.mjs --limit 3                    # print just three slots — the small-run shape
//   PLAN_CUTOVER=1 node run-plan.mjs --limit 3 --execute --no-schedule
//   PLAN_CUTOVER=1 node run-plan.mjs --day 2026-08-25 --account lorenzo --execute --no-schedule
//     ^ the A-to-Z smoke shape: one account's slot, draft created UNSCHEDULED for human review
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { runResultChild } from './process-result.mjs';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { pickProductPair, recentAsinUse, plugCapFor } from './pick-product.mjs';
import { moldById, bannedTopicIssue } from './checks.mjs';
import { statusIdOf } from './self-qrt.mjs';
import { accountSlots, fleetSlotKeys } from './slots.mjs';
import { TABLES } from './config.mjs';
import { sameLane, laneOf } from './lanes.mjs';

const pExecFile = promisify(execFile);
const EXECUTE = process.argv.includes('--execute');
const NO_SCHEDULE = process.argv.includes('--no-schedule'); // create drafts WITHOUT publish_at — review inventory, never auto-posts
// PLAN_SLOT_UTC is an override for a one-off run, not the schedule. The real time comes from
// accountSlots per account per LANE — see slotTimeFor below.
const SLOT_UTC = process.env.PLAN_SLOT_UTC || null;

export function planOperationKey({ week, day, account, lane, donor }) {
  return `plan:${createHash('sha256').update(JSON.stringify([week, day, account, lane, String(donor)])).digest('hex')}`;
}

export function processEntry(slot, outcome) {
  return { ...slot, ok: outcome.ok, operationKey: outcome.operationKey, phase: outcome.phase,
    draftId: outcome.result?.draftId, shareUrl: outcome.result?.shareUrl,
    err: outcome.ok ? null : `${outcome.phase}: ${outcome.error}`,
    ...(outcome.evidencePath ? { evidencePath: outcome.evidencePath } : {}) };
}

// Pure: which slots does a given day hold, flattened with their account context. Exported for tests.
// Pure: which week-plan file covers this day? Picking "the newest file" silently loads NEXT week's
// plan for a day it does not contain, finds zero slots, and exits green — the exact silent failure
// this engine keeps producing (observed 2026-08-17: a 5-slot generation run reported success having
// written nothing). Match on the week window first; fall back to newest only when nothing covers it.
// `weekOf` maps a filename to its plan week (files are week-plan-<monday>.json).
export function planFileFor(day, files) {
  const weeks = (files || []).filter((n) => /^week-plan-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  if (!day) return weeks.at(-1) || null;
  const covers = weeks.filter((n) => {
    const monday = n.slice(10, 20);
    const end = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10);
    return day >= monday && day <= end;
  });
  return covers.at(-1) || weeks.at(-1) || null;
}

export function slotsForDay(plan, day) {
  const out = [];
  for (const acc of plan.accounts || []) {
    for (const s of acc.slots || []) if (s.day === day) out.push({ ...s, account: acc.account });
  }
  return out;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const at = airtable(env);

  const di = process.argv.indexOf('--day');
  const DAY = di > 0 ? process.argv[di + 1] : new Date().toISOString().slice(0, 10);
  const wi = process.argv.indexOf('--week');
  const file = wi > 0 ? `week-plan-${process.argv[wi + 1]}.json`
    : planFileFor(DAY, readdirSync(join(HERE_DIR, 'queues')));
  if (!file) throw new Error('no queues/week-plan-*.json found');
  const plan = JSON.parse(readFileSync(join(HERE_DIR, 'queues', file), 'utf8'));

  let slots = slotsForDay(plan, DAY);
  const ai = process.argv.indexOf('--account');
  if (ai > 0) { // filter by key OR display name, case-insensitive (a smoke run targets one account)
    const q = String(process.argv[ai + 1] || '').toLowerCase();
    slots = slots.filter((s) => s.account.toLowerCase().includes(q) || Object.entries(ACCOUNTS).some(([k, a]) => k === q && a.name === s.account));
  }
  // --limit N: take the first N slots of the day. A small deliberate run is how you prove the engine
  // path end to end without spending a whole day's fleet on it, and it is the shape the FIRST
  // cutover run should take — the hand-written path has been exercised repeatedly, recreate.mjs
  // under the current gates has not. Applied AFTER --account so the two compose.
  const li = process.argv.indexOf('--limit');
  if (li > 0) {
    const n = Math.max(1, Number(process.argv[li + 1]) || 1);
    if (slots.length > n) console.log(`--limit ${n}: taking the first ${n} of ${slots.length} slot(s) for this day\n`);
    slots = slots.slice(0, n);
  }

  if (!slots.length) {
    // "Nothing to do" has two very different meanings and they must not share an exit code. If the
    // requested day is not even inside this plan's week, the operator asked for something that does
    // not exist and a green check would hide it. If the day IS in the plan and the account simply
    // has no slot, that is a real, expected answer.
    const inWeek = (plan.accounts || []).some((a) => (a.slots || []).some((s) => s.day === DAY));
    const msg = `${file}: no slots for ${DAY}${ai > 0 ? ` (account filter "${process.argv[ai + 1]}")` : ''}`;
    if (!inWeek) {
      console.error(`✗ ${msg} — that day is not in this plan (week of ${plan.week}). Generate it with \`node plan-week.mjs --start <monday>\` or pass --week.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${msg} — nothing to do`);
    return;
  }
  const keyOf = new Map(Object.entries(ACCOUNTS).map(([k, a]) => [a.name, k]));
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  // THE SLOT TIME IS PER ACCOUNT AND PER LANE (2026-08-27). It used to be one hardcoded 07:15 for
  // everything, which had two faults that only showed up at the cutover: every account posted at the
  // same minute, the exact clustering the deterministic spread exists to prevent, and a harvest slot
  // would have gone out in the viral window 15 hours from where it belongs. accountSlots answers
  // both, and its dayOffset is what keeps a harvest slot on the correct calendar day — harvest runs
  // 21:00-00:00 UTC the day BEFORE the Saigon morning it lands in, so ignoring the offset books it
  // 24 hours out.
  const fleet = fleetSlotKeys(ACCOUNTS);
  const slotTimeFor = (accKey, lane) => {
    if (SLOT_UTC) return `${DAY}T${SLOT_UTC}:00Z`;          // explicit override, unchanged behaviour
    // PASS THE LANE ITSELF (2026-09-10). This read `sameLane(lane, 'harvest') ? 'harvest' : 'cover'`,
    // which quietly collapsed SEED into the cover window — harmless while cover was the only other
    // choice, wrong now that seed prioritises Sun alongside harvest and that accountSlots returns a
    // lane's preferred block first. The ternary would override the operator's own ranking. laneOf
    // normalises the historical spellings; an unrecognised lane still falls back to cover rather than
    // returning no slot at all.
    const [slot] = accountSlots(accKey, fleet, laneOf(lane) || 'cover');
    if (!slot) return `${DAY}T07:15:00Z`;
    const d = new Date(`${DAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (slot.dayOffset || 0));
    d.setUTCHours(slot.h, slot.m, 0, 0);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };

  console.log(`RUN PLAN ${plan.week} → ${DAY}: ${slots.length} slots${EXECUTE ? '' : ' (print only — pass --execute with PLAN_CUTOVER=1 to generate)'}\n`);
  if (EXECUTE && process.env.PLAN_CUTOVER !== '1') {
    throw new Error('--execute is locked: set PLAN_CUTOVER=1 to confirm cutover (plan D step 3 is an operator act)');
  }

  const results = [];
  for (const s of slots) {
    const accKey = keyOf.get(s.account);
    const acc = ACCOUNTS[accKey];
    if (!accKey || !acc) { results.push({ ...s, ok: false, err: `unknown account "${s.account}"` }); continue; }
    const at9 = slotTimeFor(accKey, s.lane);

    // HARVEST IS ITS OWN PATH (operator 2026-08-27, "automate fully"). Everything below this block
    // resolves a donor out of the Airtable swipe file and rebuilds a thread through recreate.mjs. A
    // harvest slot has no swipe donor at all: its body is OUR OWN published winner, already written,
    // and the only new text is the hook. Falling through would have looked up `recId` in the swipe
    // DB, found nothing, and failed every harvest slot — which is why the lane could never run on a
    // schedule before now. harvest-build writes the hooks, mints fresh links and hands the whole
    // thing to publish-thread, so this branch is a dispatch and nothing more.
    if (s.lane === 'harvest') {
      // SECOND LINE OF DEFENCE, and it is not redundant. pickHarvest now keeps banned parents off
      // the bench, but a plan JSON written BEFORE that fix is still on disk and still names one —
      // which is exactly the case that produced this check. A harvest slot regenerates a new hook on
      // a proven PARENT body, so a banned parent yields a banned child every single time it is run.
      // Skip loudly: a lost slot is cheap, a banned thread under our handle is not.
      // The parent is read as a THREAD (hook first, then its tweets) plus the new hook on its own, so a passing
      // mention in a body does not skip the slot but a cancer parent still does (owner 2026-09-29).
      const banned = bannedTopicIssue([s.parentHook || s.hook, ...(s.parentTweets || [])].filter(Boolean)) || (s.hook ? bannedTopicIssue(s.hook) : '');
      if (banned) {
        console.log(`■ ${s.account} HARVEST ${s.harvestOf} — SKIPPED, banned topic in the parent`);
        console.log(`  ${String(s.parentHook || '').slice(0, 78)}`);
        results.push({ ...s, ok: false, skipped: 'banned topic in parent' });
        continue;
      }
      const hArgs = [join(HERE_DIR, 'harvest-build.mjs'), String(s.harvestOf), '--account', accKey,
        ...(EXECUTE ? ['--create'] : []), ...(EXECUTE && !NO_SCHEDULE ? ['--at', at9] : [])];
      if (!EXECUTE) {
        console.log(`■ ${s.account} HARVEST ${s.harvestOf} · ${(s.parentStats?.impressions || 0).toLocaleString()} views, ${s.parentStats?.clicks || 0} clicks`);
        console.log(`  parent: ${String(s.parentHook || '').slice(0, 78)} · at ${at9}`);
        results.push({ ...s, ok: true, dry: true });
        continue;
      }
      const hOutcome = await runResultChild(hArgs[0], hArgs.slice(1), {
        operationKey: planOperationKey({ week: plan.week, day: DAY, account: accKey, lane: s.lane, donor: s.harvestOf }),
        cwd: HERE_DIR, resultRoot: join(HERE_DIR, '.process-results'),
      });
      const hEntry = processEntry(s, hOutcome);
      if (hEntry.evidencePath) console.log(`  reconciliation receipt: ${hEntry.evidencePath}`);
      // No media pass: a harvest reuses its parent's BODY, and publish-thread carries the parent's
      // media with it. No self-QRT either — self-qrt-topup skips anything stamped harvestOf.
      console.log(`${hEntry.ok ? '✓' : '✗'} ${s.account} harvest ${hEntry.ok ? `draft ${hEntry.draftId}${hEntry.shareUrl ? ` ${hEntry.shareUrl}` : ''}${NO_SCHEDULE ? ' (UNSCHEDULED)' : ''}` : hEntry.err}`);
      results.push(hEntry);
      continue;
    }

    // Resolve the donor recId per lane.
    let recId = s.recId || null, moldArgs = [];
    if (sameLane(s.lane, 'seed')) {
      const mold = moldById(s.moldId);
      const sid = statusIdOf(mold?.sourceUrl || '');
      if (!sid) { results.push({ ...s, ok: false, err: `mold ${s.moldId}: no sourceUrl/status id` }); continue; }
      const found = await at.list(TABLES.swipe, { formula: `AND({Tweet Number}=1,FIND("${sid}",{Tweet URL}))`, fields: ['Text'], pageSize: 1 });
      if (!found.length) { results.push({ ...s, ok: false, err: `mold ${s.moldId}: donor ${sid} not in swipe DB — backfill it, do not improvise` }); continue; }
      recId = found[0].id;
      moldArgs = ['--mold', s.moldId];
    }

    // Product pair follows the THREAD (no account lanes): whole-donor body text, spread caps, pair.
    let bodyText = '';
    try {
      const head = await at.getRecord(TABLES.swipe, recId);
      const rows = [];
      for (const tid of (head.fields.Tweets || []).slice(0, 10)) {
        const f = (await at.getRecord(TABLES.swipe, tid)).fields;
        rows.push({ n: f['Tweet Number'] || 0, text: f.Text || '' });
      }
      bodyText = rows.sort((a, b) => a.n - b.n).map((r) => r.text).filter(Boolean).join('\n').slice(0, 1400);
    } catch (e) { console.warn(`  ↳ ${s.account} body fetch (${recId}): ${e.message} — picking on hook only`); }
    const hook = s.hook || s.hookShape || bodyText.split('\n')[0] || '';
    // The pair picker's refinement step needs an LLM key; the print-only slate must not (its job is
    // donor resolution and slate shape — a keyless review box can still verify the whole day).
    let prod = null, prod2 = null, pickNote = null;
    // HONOUR THE PLAN (operator 2026-08-17). The plan now COMMITS a product pair per slot, chosen
    // deterministically so it can be reviewed and argued with. Re-deriving it here — which is what
    // this did, through an LLM-refined picker — meant the product the operator approved on Monday
    // was a forecast and the engine decided again on Thursday, with nothing flagging the difference.
    // So: use the plan's choice. Re-pick ONLY when it has since become unusable, and say so loudly.
    const byAsin = new Map(products.map((p) => [p.asin, p]));
    const planned = (s.products || []).map((x) => byAsin.get(x.asin)).filter(Boolean);
    const usable = planned.filter((p) => !p.unavailable);
    if (usable.length !== planned.length) console.warn(`  ⚠ ${s.account}: plan committed ${planned.length - usable.length} product(s) that are no longer available — re-picking`);
    if (usable.length) {
      prod = usable[0]; prod2 = usable[1] || null;
      pickNote = 'from the plan';
    } else {
      if ((s.products || []).length) console.warn(`  ⚠ ${s.account}: OVERRIDING the plan — none of its committed products resolved (${(s.products || []).map((x) => x.asin).join(',')})`);
      try {
        const pair = await pickProductPair(env, { recId, acc, hook, bodyText }, products,
          [acc.defaultProduct, ...(acc.altProducts || [])],
          { usedAsins: recentAsinUse(acc.name), cap: plugCapFor });
        prod = pair[0]; prod2 = pair[1] || null;
        pickNote = 'picked at run time (plan had none)';
      } catch (e) {
        if (EXECUTE) { results.push({ ...s, ok: false, err: `product pick: ${e.message}`.slice(0, 160) }); continue; }
        pickNote = `(picked at execute time — ${e.message.slice(0, 60)})`;
      }
    }

    if (!EXECUTE) {
      console.log(`■ ${s.account} ${sameLane(s.lane, 'seed') ? `SEED ${s.moldId}` : `COVER ${s.recId}`} donor=${recId}`);
      console.log(`  products: ${prod ? `${prod.title}${prod2 ? ` + ${prod2.title}` : ''} [${pickNote}]` : pickNote} · at ${at9}`);
      results.push({ ...s, ok: true, dry: true });
      continue;
    }
    // The plan's shape conversion rides into the ledger via --convert, so the revenue readout can
    // split "converted to roundup/deep-dive" from "left as-was" — without it phase 4 ships blind.
    const argv = [join(HERE_DIR, 'recreate.mjs'), recId,
      ...(s.convertTo ? ['--convert', s.convertTo] : []),
      ...(prod.link ? ['--link', prod.link] : ['--asin', prod.asin]), '--product', prod.title,
      ...(prod2 ? [...(prod2.link ? ['--link2', prod2.link] : ['--asin2', prod2.asin]), '--product2', prod2.title] : []),
      ...moldArgs, ...(NO_SCHEDULE ? [] : ['--at', at9]), '--create', '--account', accKey];
    // One attempt per intent. Missing receipts and process failures may follow a remote creation;
    // they require reconciliation, never another creation based on missing human log text.
    const outcome = await runResultChild(argv[0], argv.slice(1), {
      operationKey: planOperationKey({ week: plan.week, day: DAY, account: accKey, lane: s.lane, donor: recId }),
      cwd: HERE_DIR, resultRoot: join(HERE_DIR, '.process-results'),
    });
    const entry = processEntry(s, outcome);
    if (entry.evidencePath) console.log(`  reconciliation receipt: ${entry.evidencePath}`);
    // MEDIA PASS (operator rule 2026-08-17: "if you are pulling from the viral source, take the
    // media from it as well"). Same child step daily-winners runs after each faithful draft —
    // run-plan's slots are all faithful recreations, so every successful slot gets it. A donor
    // with no media (the backfilled mold spines) no-ops harmlessly.
    if (entry.ok && entry.draftId) {
      try {
        await pExecFile('node', [join(HERE_DIR, 'media.mjs'), String(entry.draftId), '--account', accKey], { encoding: 'utf8', timeout: 300000 });
        entry.media = true;
        console.log('  ↳ media pass done (source images/video carried over where present)');
      } catch (e) { console.warn(`  ↳ media pass failed (draft still fine, text-only): ${((e.stderr || e.message) || '').slice(0, 120)}`); }
    }
    console.log(`${entry.ok ? '✓' : '✗'} ${s.account} ${s.lane}${s.moldId ? ` ${s.moldId}` : ''} ${entry.ok ? `draft ${entry.draftId}${entry.shareUrl ? ` ${entry.shareUrl}` : ''}${NO_SCHEDULE ? ' (UNSCHEDULED — review before it can post)' : ''}` : entry.err}`);
    results.push(entry);
  }

  // A deliberate SKIP is not a failure and must not read as one. A slot refused on policy (a banned
  // parent) is the system working; a slot that errored is the system broken. Collapsing the two puts
  // "FAILED: Julian(undefined)" on the console and trains everyone to ignore the summary line.
  const skipped = results.filter((r) => r.skipped);
  const bad = results.filter((r) => !r.ok && !r.skipped);
  const parts = [`${results.length - bad.length - skipped.length}/${results.length} slots ok`];
  if (skipped.length) parts.push(`${skipped.length} skipped on policy: ${skipped.map((b) => `${b.account} (${b.skipped})`).join('; ')}`);
  if (bad.length) parts.push(`FAILED: ${bad.map((b) => `${b.account}(${b.err || 'no reason recorded'})`).join('; ')}`);
  console.log(`\n${parts.join(' — ')}`);
  if (EXECUTE && bad.length) process.exitCode = 1; // failure-handler picks this up at cutover
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'run-plan');
