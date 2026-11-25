// thread-brief.mjs — the OPERATOR-IN-THE-LOOP writing brief (skill: write-thread).
//
// Everything a writer needs for ONE slot of the week plan, gathered in one call: the donor thread
// verbatim, the bridge-gated product candidates, the account's voice, the plug budget, and the
// cross-thread memory (which ASINs and which opener moves this account used recently). The writing
// itself is done by a human/agent in the session — this script never calls an LLM.
//
//   node thread-brief.mjs --account lorenzo --lane viral
//   node thread-brief.mjs --account clara --lane mold --day 2026-08-26
//   node thread-brief.mjs --account julian --lane viral --json   # machine-readable
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { moldById, bridgeableProducts, substanceTermsFor, plugBudget, BRIDGE, donorAgeDays, recencyFactor,
  numberingIssue, fabricationFlags, bodyOverlap, hookWindows, tweetsFromRollup } from './checks.mjs';
import { LAWS, signOffOf } from './laws.mjs';
import { recentAsinUse } from './pick-product.mjs';
import { statusIdOf } from './self-qrt.mjs';
import { TABLES } from './config.mjs';
import { planFileFor } from './run-plan.mjs';
import { slateSubid } from './preflight.mjs';
import { depthFor } from './pod-place.mjs';
import { laneOf, sameLane } from './lanes.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');

// Suggested subids, one per plug in READING ORDER.
//
// This used to build its own: it capped the slug at 46 characters with no budget left for the
// `x-thread-<account>-` prefix, so the suggestion routinely blew past the 50-character limit
// tracking-smoke warns at, and it appended four random characters, which made the subid impossible
// to re-derive. Both cost real work on the 08-31 slate — every subid was hand-written instead, and
// when one thread's plugs were reordered the already-minted pair no longer matched reading order
// and had to be re-minted, orphaning two links in the ledger.
//
// slateSubid is the planner's own builder and has neither problem: it reserves room for the prefix
// and it is a pure function of (account, hook, recId, index). Reading order IS the index, so the
// first plug takes the bare stem and the second `-b`, and reordering plugs regenerates rather than
// invalidates. One builder, so the hand lane and the engine cannot drift apart.
export const suggestSubid = (accountKey, hook, recId, index = 0) => slateSubid(accountKey, hook, recId, index);

// The harvest brief. Same job as the viral one — everything needed for ONE slot, in one call — but
// the source is queues/harvest/<harvestOf>.json rather than the swipe DB, and the fidelity band is
// measured against the PARENT hook (harvest.mjs: "the 85-90% band applies against the parent, not
// just the original donor. Three near-identical hooks across three accounts is a duplicate-detection
// risk we would be creating ourselves").
export function harvestBrief({ acc, key, plan, file, slot }) {
  const id = slot.harvestOf;
  if (!id) throw new Error(`${acc.name}'s harvest slot on ${slot.day} carries no harvestOf`);
  const specPath = join(HERE_DIR, 'queues', 'harvest', `${id}.json`);
  if (!existsSync(specPath)) throw new Error(`no harvest spec at queues/harvest/${id}.json — run: node harvest.mjs --account ${key}`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const body = spec.bodyTweets || [];
  const products = spec.products || [];
  const links = body.flatMap((t) => String(t).match(/https?:\/\/\S+/g) || []).filter((u) => /lvnta\.com|amazon\.com/.test(u));
  const windows = hookWindows(spec.parentHook || '');

  const out = {
    week: plan.week, file, slot, lane: 'harvest',
    account: { key, name: acc.name, handle: acc.handle, socialSetId: acc.socialSetId },
    harvestOf: String(id), parentHook: spec.parentHook, parentUrl: spec.parentUrl,
    parentStats: spec.parentStats || {}, bodyTweets: body, products,
    linkCount: links.length, buildable: links.length === products.length && links.length > 0,
    hookWindows: windows,
    voice: { disclaimer: acc.disclaimer || null, closing: signOffOf(acc) || null },
  };
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  console.log(`HARVEST BRIEF — ${acc.name} (@${acc.handle}) · ${slot.day} · from ${file}`);
  console.log('LAWS: docs/thread-laws.md — read it there. Do not work from a restatement of it.');
  console.log(`PARENT ${id} ${spec.parentUrl || ''}`);
  const st = spec.parentStats || {};
  console.log(`  ${(st.impressions || 0).toLocaleString()} views · ${st.clicks || 0} clicks · $${(st.commission || 0).toFixed(0)} · ${body.length} body tweets`);

  // The build invariant, stated here so it is known before the hook is written rather than at the
  // moment harvest-build refuses. Same comparison harvest-build enforces.
  if (!out.buildable) {
    console.log('\n✗ THIS SLOT WILL NOT BUILD AS IT STANDS');
    if (!links.length) {
      console.log(`  The parent carries no tracked link, so a harvest of it ships with no plug and earns nothing.`);
      console.log('  Give the BODY a plug with /money-thread first; a hook variation cannot add one.');
    } else if (links.length > products.length) {
      console.log(`  ${links.length} link(s) in the body but ${products.length} product(s) on the spec — the extras would keep`);
      console.log("  the PARENT's URL and pay the parent's subid, so the variation could never be measured.");
    } else {
      console.log(`  ${products.length} product(s) but only ${links.length} link position(s); the surplus would be dropped silently.`);
    }
    console.log(`  Fix queues/harvest/${id}.json, then re-run this brief.\n`);
  }

  console.log('\n=== WHAT YOU WRITE: THE HOOK, AND ONLY THE HOOK ===');
  console.log('The body below is reused VERBATIM — it is a proven winner and rewriting it throws the asset');
  console.log('away. Target 85-90% against the PARENT hook, not against any original donor.');
  if (windows.length > 1) {
    console.log(`\nPER-SENTENCE BUDGET (tolerance ${Math.round(LAWS.hook.sentenceTolerance * 100)}%):`);
    for (const w of windows) {
      console.log(`  s${w.n}  ${String(w.len).padStart(3)}ch -> ${String(w.min + '-' + w.max).padStart(7)}   ${w.mustTouch ? 'MUST be reworded' : 'may stay as-is '}   ${JSON.stringify(w.donor.slice(0, 42))}`);
    }
  }
  console.log(`\nPARENT HOOK:\n${spec.parentHook}\n`);
  console.log('=== BODY (reused verbatim, links get re-minted) ===');
  body.forEach((t, i) => console.log(`[${i + 1}]\n${t}\n`));
  console.log('=== PRODUCTS ON THE SPEC ===');
  if (!products.length) console.log('  (none)');
  for (const p of products) console.log(`  ${p.asin}  ${(p.title || '').slice(0, 70)}`);
  console.log(`\nvoice — closing: ${JSON.stringify(out.voice.closing)}\n       disclaimer: ${JSON.stringify(out.voice.disclaimer)}`);
  console.log(`\nNEXT: node harvest-build.mjs ${id} --account ${key}            # writes 3 hooks, ranks them, mints nothing`);
  console.log(`      node harvest-build.mjs ${id} --account ${key} --create   # mint + publish UNSCHEDULED`);
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const at = airtable(env);

  const key = String(arg('account', '')).toLowerCase();
  const acc = ACCOUNTS[key];
  if (!acc) throw new Error(`unknown account "${arg('account')}" — one of: ${Object.keys(ACCOUNTS).join(', ')}`);
  // laneOf accepts the old spellings too, so --lane viral and --lane mold still work on the plans
  // and muscle memory that predate the 2026-08-29 rename.
  const lane = laneOf(arg('lane', 'cover'));
  if (!['cover', 'seed', 'harvest'].includes(lane)) throw new Error('--lane must be cover, seed or harvest (viral/mold still accepted)');

  // Same trap run-plan fell into: "newest plan wins" hands you NEXT week's file for a day it does
  // not contain, and the brief dies with "no mold slot" on a slot that exists.
  const file = arg('week') ? `week-plan-${arg('week')}.json`
    : planFileFor(arg('day'), readdirSync(join(HERE_DIR, 'queues')));
  const plan = JSON.parse(readFileSync(join(HERE_DIR, 'queues', file), 'utf8'));
  const mine = (plan.accounts || []).find((a) => a.account === acc.name);
  if (!mine) throw new Error(`${acc.name} has no slots in ${file}`);
  const day = arg('day');
  // sameLane, not ===: the plan files on disk still say `viral` and `mold`, and rewriting committed
  // plans to match a rename would be the wrong trade. lanes.mjs maps them forward on read instead.
  const slots = mine.slots.filter((s) => sameLane(s.lane, lane) && (!day || s.day === day));
  if (!slots.length) throw new Error(`no ${lane} slot for ${acc.name}${day ? ` on ${day}` : ''} in ${file}`);
  const slot = slots[0];

  // HARVEST is a different shape and always was: the slot carries `harvestOf`, not a donor recId,
  // because the body is one of OUR winners rather than a creator's thread. Routing it through the
  // donor path below would fetch a swipe record that does not exist, which is why this lane simply
  // threw "--lane must be viral or mold" until 2026-08-29 and the hand lane could not work a
  // harvest slot at all. Eight of the nineteen slots on the 08-31 slate were harvest.
  if (lane === 'harvest') return harvestBrief({ acc, key, plan, file, slot });

  // Resolve the donor record.
  let recId = slot.recId, mold = null;
  if (lane === 'seed') {
    mold = moldById(slot.moldId);
    const sid = statusIdOf(mold?.sourceUrl || '');
    const found = await at.list(TABLES.swipe, { formula: `AND({Tweet Number}=1,FIND("${sid}",{Tweet URL}))`, fields: ['Text'], pageSize: 1 });
    if (!found.length) throw new Error(`mold ${slot.moldId}: donor ${sid} not in the swipe DB`);
    recId = found[0].id;
  }
  const head = await at.getRecord(TABLES.swipe, recId);
  const rows = [];
  for (const tid of (head.fields.Tweets || [])) {
    const f = (await at.getRecord(TABLES.swipe, tid)).fields;
    rows.push({ n: f['Tweet Number'] || 0, text: f.Text || '' });
  }
  const donor = rows.sort((a, b) => a.n - b.n).map((r) => r.text).filter(Boolean);
  if (!donor.length) donor.push(head.fields.Text || '');
  const body = donor.join('\n');

  // Bridge-gated candidates: substances the donor ALREADY discusses -> allowlist ASINs.
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const bridges = [...bridgeableProducts(body)];
  const substancesFor = (asin) => Object.entries(BRIDGE).filter(([, a]) => a === asin).map(([s]) => s);
  const cands = bridges.map((asin) => ({
    asin, substances: substancesFor(asin),
    title: byAsin.get(asin)?.title || '(not in products.json)',
    commission: byAsin.get(asin)?.commission ?? null,
  }));
  const used = recentAsinUse(acc.name);

  // Recent opener moves for this account (cross-thread variety memory).
  const moves = [];
  for (const l of readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-400).reverse()) {
    try { const e = JSON.parse(l); if (e.account === acc.name && Array.isArray(e.plugMoves)) { moves.push(...e.plugMoves); if (moves.length >= 8) break; } } catch {}
  }

  // ---- DONOR SCREEN (2026-08-29) ---------------------------------------------------------------
  // Everything below was learned the expensive way on the 08-31 slate: seven of eleven donors had to
  // be replaced, and every reason was visible in the donor's own text before a word was written. The
  // cost was not the swap, it was discovering it mid-write and starting the thread again.
  //
  // None of these BLOCK. A number, an institution, or a shared mechanism can all be legitimate; the
  // reader of this brief is a person who can look at the sentence. What they remove is the search.
  const numbering = numberingIssue(donor);
  const fabrications = fabricationFlags(donor);
  // Overlap is measured against the OTHER SLOTS ON THE SAME DAY, not against what has already been
  // written, so a collision surfaces before either thread exists rather than when the second one
  // reads oddly. One list call for the lot: a getRecord per slot would triple this brief's latency.
  let overlaps = [];
  try {
    const sameDay = (plan.accounts || []).flatMap((a) => (a.slots || [])
      .filter((x) => x.day === slot.day && x.recId && x.recId !== recId)
      .map((x) => ({ account: a.account, recId: x.recId })));
    if (sameDay.length) {
      const rows = await at.list(TABLES.swipe, {
        formula: `OR(${sameDay.map((x) => `RECORD_ID()='${x.recId}'`).join(',')})`,
        fields: ['Full Thread Text'], max: sameDay.length, pageSize: 100,
      });
      const text = new Map(rows.map((r) => [r.id, tweetsFromRollup(String(r.fields['Full Thread Text'] || ''))]));
      overlaps = sameDay
        .map((x) => ({ ...x, share: bodyOverlap(donor, text.get(x.recId) || []) }))
        .filter((x) => x.share >= (LAWS.selection?.donorOverlapWarn ?? 0.2))
        .sort((a, b) => b.share - a.share);
    }
  } catch { overlaps = []; } // a screen that fails must never take the brief down with it
  const windows = hookWindows(donor[0] || '', { srcAttaches: /(^|\n)\s*\d+[.)]\s/.test(donor[0] || '') });

  // EARNED CTA DEPTH (2026-08-29). The 08-31 slate declared ctaDepth 3 on all eleven threads,
  // including the eight where a plug claimed the donor's own sell slot — the exact case the law says
  // can compress. A three-tweet ask re-does beats the donor already paid for, and every tweet the
  // link sits later costs readers: past tweet 6 the money roughly halves.
  //
  // depthFor is pod-place's, not a second copy: it reads the donor's surviving run-up with the same
  // detector the warm-slot gates use, so the suggestion here and the gate at publish can never
  // disagree. Compressing is safe to try — discriminationIssue blocks the one-tweet form when the
  // run-up does not really carry a criterion, so the floor is enforced rather than trusted.
  const depths = (slot.sellSlots || []).map((ss) => {
    const product = byAsin.get(ss.asin) || { asin: ss.asin, title: ss.substance };
    try {
      const d = depthFor({ kind: 'donor-slot', span: { start: ss.at, end: ss.at }, tweets: donor, product, shape: slot.convertTo || null });
      return { at: ss.at, substance: ss.substance, asin: ss.asin, ...d };
    } catch { return null; }
  }).filter(Boolean);

  const out = {
    week: plan.week, file, slot, screen: { numbering, fabrications, overlaps, hookWindows: windows, ctaDepths: depths }, account: { key, name: acc.name, handle: acc.handle, socialSetId: acc.socialSetId },
    donorRecId: recId, donorUrl: head.fields['Tweet URL'], donorViews: head.fields.Impressions,
    // AGE (operator 2026-08-25). The planner has a freshness window; this lane never had one, which
    // is how a 27.8-day-old donor got hand-picked while fresher bridgeable ones sat unused. It stays
    // a WARNING rather than a block — an old donor is sometimes the right call, it just has to be one.
    donorAgeDays: donorAgeDays(head.fields), donorRecencyFactor: recencyFactor(head.fields),
    donorTweets: donor, mold, candidates: cands, recentAsinUse: used, recentMoves: moves.slice(0, 6),
    suggestedSubids: Array.from({ length: plugBudget(donor.length) }, (_, i) => suggestSubid(key, donor[0], recId, i)),
    plugBudgetForDonorLength: plugBudget(donor.length),
    voice: { disclaimer: acc.disclaimer || null, closing: signOffOf(acc) || null, plugHeavyExample: acc.plugHeavyExample || null },
  };
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  console.log(`WRITING BRIEF — ${acc.name} (@${acc.handle}) · ${lane.toUpperCase()} · ${slot.day} · from ${file}`);
  // One canonical statement of the laws, read rather than retyped. Five findings on 2026-08-17 were
  // manufactured by a RESTATEMENT of a law — a stale skill copy, a stale brief line, an unsatisfiable
  // prompt pair, and a review harness that turned a two-tweet ramp into three. Every one looked like
  // a real defect. Point writers and reviewers at the file; never paraphrase it into a prompt.
  console.log('LAWS: docs/thread-laws.md — read it there. Do not work from a restatement of it.');
  if (mold) console.log(`MOLD ${mold.id} "${mold.name}" — ${mold.job}\n  requirements: ${(mold.requirements || []).join(' | ')}`);
  const age = out.donorAgeDays;
  const ageStr = age == null ? 'no published date' : `${age.toFixed(1)}d old, recency x${out.donorRecencyFactor.toFixed(2)}`;
  console.log(`DONOR ${recId} ${out.donorUrl || ''} (${(out.donorViews || 0).toLocaleString()} views, ${donor.length} tweets, ${ageStr})`);
  if (age != null && age > LAWS.selection.viralWindowDays) {
    console.log(`⚠️  STALE DONOR — ${age.toFixed(1)} days old, past the ${LAWS.selection.viralWindowDays}-day window. The planner would not have picked this one. Use it only if you mean to.`);
  }
  console.log(`PLUG BUDGET at that length: ${out.plugBudgetForDonorLength} (never adjacent, first one early, last clear of the closer)`);
  if (out.screen.ctaDepths.length) {
    console.log('\nCTA DEPTH THIS DONOR HAS EARNED (do not default to 3 — the donor may have paid for a beat already):');
    for (const d of out.screen.ctaDepths) {
      console.log(`  donor sells ${d.substance} at T${d.at} -> ctaDepth ${d.depth}   link lands T${d.at}, ask opens T${d.at - (d.depth - 1)}`);
      console.log(`     ${d.why}`);
    }
    console.log('  Compressing is safe to try: discriminationIssue rejects a 1-tweet ask whose run-up carries no criterion.');
  }
  console.log('');
  // The hook instruction here is a PROMPT, and it was out of sync with the gate for long enough to
  // cost us. It read "hook is VERBATIM" — the old law — while hookFidelityIssue has since required
  // 85-90% with paraphrase INSIDE the sentences, so a writer following the brief exactly produced a
  // hook the gate flagged, and a reviewer reading the brief penalised a correctly paraphrased one
  // (2026-08-17). Third instance of a stale instruction fighting a live check in two days; the
  // instruction now states the band it is actually judged against.
  // The screen prints BEFORE the donor text, because its whole purpose is to be read first. Buried
  // under twelve tweets it would be found after the writing had already started, which is the exact
  // failure it exists to prevent.
  const scr = out.screen;
  if (scr.numbering || scr.fabrications.length || scr.overlaps.length) {
    console.log('=== DONOR SCREEN — read before writing ===');
    if (scr.numbering) {
      console.log(`  NUMBERING  ${scr.numbering}`);
      console.log('             the gate needs a continuous 1..N. Donors routinely run two sequences or repeat a');
      console.log('             number; decide the renumbering now, not at the dry run.');
    }
    for (const o of scr.overlaps) {
      console.log(`  OVERLAP    ${(o.share * 100).toFixed(1)}% of this donor's phrasing also appears in ${o.account}'s donor (${o.recId})`);
    }
    if (scr.overlaps.length) {
      console.log('             two accounts posting the same body on one day is the duplicate case the rescue');
      console.log('             check exists to stop. Swap one of them, or confirm the shared part is not what');
      console.log('             either thread is actually about.');
    }
    const flags = scr.fabrications.filter((f) => f.severity === 'flag');
    const notes = scr.fabrications.filter((f) => f.severity !== 'flag');
    for (const f of flags) console.log(`  CLAIM      T${f.tweet} [${f.kind}] ${JSON.stringify(f.match)}`);
    if (flags.length) {
      console.log('             A specific quote in a specific living person\'s mouth is not the same as borrowing');
      console.log('             an unnamed authority. Check it is real before republishing it under our name.');
    }
    if (notes.length) {
      console.log(`  LEANS ON   ${notes.map((f) => `T${f.tweet} ${f.kind}`).join(' · ')}`);
      console.log('             Genre convention, not a defect, and NOT a reason to drop the donor. It is what the');
      console.log('             thread is resting its authority on, so LAW 7 still applies when you WRITE it:');
      console.log('             hedge an inherited statistic or drop it, rather than restating it as our claim.');
    }
    console.log('');
  }
  console.log('=== DONOR THREAD ===');
  console.log('HOOK: keep the promise, the structure and the specifics; PARAPHRASE INSIDE the sentences.');
  console.log('      Target 85-90% similarity to the donor. Above ~93% is a near-duplicate, below ~72% throws');
  console.log('      the proven asset away. Item 1 belongs to the outline, not the donor. BODY gets rewritten.');
  // The per-sentence budget, stated up front. hookFidelityIssue reports its constraints one at a
  // time in a fixed order, so a writer who does not know the lengths in advance searches for them:
  // Kim's nine-sentence hook cost five rounds on 2026-08-29, Lorenzo's six-line hook four. Every
  // bound here is derived from the donor's own sentences, so none of that search was ever needed.
  if (out.screen.hookWindows.length > 1) {
    console.log(`\n      PER-SENTENCE BUDGET (tolerance ${Math.round((LAWS.hook.sentenceTolerance) * 100)}%). Keep each rewritten sentence inside its range:`);
    for (const w of out.screen.hookWindows) {
      console.log(`        s${w.n}  ${String(w.len).padStart(3)}ch -> ${String(w.min + '-' + w.max).padStart(7)}   ${w.mustTouch ? 'MUST be reworded' : 'may stay as-is '}   ${JSON.stringify(w.donor.slice(0, 42))}`);
    }
    console.log('      "may stay as-is" is not a suggestion to leave it — the untouched check only fires at 4+');
    console.log('      words, so short lines are where you should NOT spend your similarity budget.');
  }
  console.log('');
  donor.forEach((t, i) => console.log(`[${i + 1}]\n${t}\n`));
  console.log('=== BRIDGE-GATED PRODUCT CANDIDATES (substances this thread already discusses) ===');
  if (!cands.length) console.log('  (none — this donor cannot host an allowlist product; pick another slot)');
  for (const c of cands) console.log(`  ${c.asin}  [${c.substances.join(', ')}]  ${c.commission != null ? `${c.commission}%` : '?'}  ${c.title.slice(0, 70)}${used[c.asin] ? `   ⚠ used ${used[c.asin]}x in last 7d` : ''}`);
  // "DO NOT REUSE" was the old law and it made writers discard the best-fitting move for a worse
  // one — the exact failure the engine prompt and both skills were rewritten to stop (operator
  // 2026-08-17: fit beats rotation). This is the same print block whose hook line carried a stale
  // instruction; the moves line was missed in that pass.
  console.log(`\nrecent opener moves on this account (CONTEXT, not a veto — prefer a fresh move when two fit equally, take a used one when it is clearly better and word it differently): ${out.recentMoves.join(', ') || '(none recorded)'}`);
  console.log('suggested subids (READING ORDER — the first plug in the thread takes the bare stem):');
  out.suggestedSubids.forEach((sid, i) => console.log(`  plug ${i + 1}${i ? '' : ' (heavy)'}  ${sid}${sid.length > 50 ? `   ⚠ ${sid.length} chars, over the 50 tracking-smoke warns at` : ''}`));
  console.log(`\nvoice — closing: ${JSON.stringify(out.voice.closing)}\n       disclaimer: ${JSON.stringify(out.voice.disclaimer)}`);
  // GATE BEFORE YOU MINT (2026-08-30). This line used to read "mint a link per product, write the
  // thread, then publish" — the mint FIRST. Three other places say the opposite and always have:
  // gate-thread.mjs's own header, money-thread §4 ("links stay as {{LINK}} placeholders, mint only
  // when the operator says ship") and remix-thread §6 ("mint only what passes"). The brief is the
  // one of the four a writer actually reads at the end of every brief, so its order is the one that
  // gets followed: the 2026-09-01 slate minted 24 links before a single thread had been gated.
  // Nothing was wasted that run because every thread eventually passed, which is exactly why a
  // wrong order survives — it only bills you on the run where a bridge fails or an ASIN is delisted,
  // and by then the subid is spent and the link is loose in the ledger.
  console.log(`\nNEXT: write the thread with {{LINK}} / {{LINK2}} placeholders in the plugs, then:
  node gate-thread.mjs --file <draft>.json     # every publish gate, no network, mints nothing
  ...mint only what passes (Actions → Money · Mint link, asin + subid), swap the links in, then:
  node publish-thread.mjs --file <draft>.json --dry
  node publish-thread.mjs --file <draft>.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'thread-brief');
