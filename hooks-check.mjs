// hooks-check.mjs — the HOOKS stage. Between generate and gate, over the whole batch at once.
//
// The hook is the one part of a thread we do not invent: it is the donor's, paraphrased to 85-90%,
// because it is the sentence that already earned the views. Everything else in the pipeline is
// checked per draft at publish time, but nothing ever looked at a BATCH of hooks against the donors
// they came from — `hookFidelityIssue` exists and only the generator calls it, so a hand-written
// thread's hook was never measured at all.
//
// Two ways that costs money, and both are silent:
//   TOO LOW   the paraphrase drifted far enough that the proven asset is gone. We kept the donor's
//             topic and threw away the thing that made it travel.
//   TOO HIGH  at 0.995+ it is byte-identical, which is a duplicate post rather than our thread.
//
// Reads a folder of specs (or the committed records), fetches each donor's real hook from the swipe
// database in ONE call, and prints the band. Read only: it writes nothing and touches no draft.
//
//   node hooks-check.mjs --dir queues/pending
//   node hooks-check.mjs --records 2026-08-28        the committed records for a date
//   node hooks-check.mjs --dir queues/pending --json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { TABLES } from './config.mjs';
import { LAWS } from './laws.mjs';
import { hookFidelityIssue, hookSimilarity, hookBodyText } from './checks.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

/** PURE. One hook against its donor — THE SAME MEASUREMENT AS THE DOOR.
 *
 *  publish-thread measures the hook body: when the donor's hook carries an attached "N." item line,
 *  both hooks are read without it; when the donor attaches none, our whole first tweet counts, item
 *  line included. Until 2026-09-07 this file measured the whole texts either way, so its number and
 *  the door's disagreed exactly when a donor attached an item — three rewrite loops on Run 2's
 *  Thursday were spent on that difference. `measured` names the case so nobody has to guess again.
 *
 *  `ok` is the door's verdict (hookGate) and nothing stricter. The engine's per-sentence rule
 *  (hookFidelityIssue: same sentence count, each sentence near its counterpart's length, none left
 *  verbatim) was written for the LLM rewrite lane and is reported here as `shape`, an advisory
 *  note — Run 2 shipped nine covers that carried one, every one of them inside the band, because
 *  the door never looked at it. A note that is not the law must not print as a refusal. */
export function checkHook(ourHook, donorHook, { swapPromise = false, hookDrift = null, lane = 'cover' } = {}) {
  if (!String(donorHook || '').trim()) return { sim: 0, ok: true, onTarget: false, band: 'no donor', issue: null, shape: null, measured: 'no donor' };
  const att = /(^|\n)\s*\d+[.)]\s/.test(String(donorHook));
  const sim = hookSimilarity(hookBodyText(String(ourHook || ''), att), hookBodyText(String(donorHook), att));
  const [lo, hi] = [LAWS.hook.gateMin, LAWS.hook.gateMax];
  const [tLo, tHi] = [LAWS.hook.targetMin, LAWS.hook.targetMax];
  const gate = hookGate({ sim, lane, hookDrift });
  // band [0, 1]: the whole-hook band is the gate's job above; only the shape and per-sentence notes are wanted here.
  const shape = gate.ok ? (hookFidelityIssue(ourHook, donorHook, { swapPromise, srcAttaches: att, band: [0, 1] }) || null) : null;
  return {
    sim: Number(sim.toFixed(3)),
    ok: gate.ok,
    onTarget: sim >= tLo && sim <= tHi,
    band: sim < lo ? 'DRIFTED' : sim > hi ? 'TOO CLOSE' : sim < LAWS.hook.coverFloor ? 'BELOW FLOOR' : sim > tHi ? 'tight' : 'on target',
    issue: gate.ok ? null : gate.why,
    shape,
    measured: att ? 'item line excluded — the donor attaches one' : 'whole first tweet — the donor attaches no item line',
  };
}

/** PURE. The publish gate on a hook (operator 2026-09-06: "floor should be a lot higher, 85%+ when
 *  possible"). Measured on the Sep 4-6 posts: 37 of 47 covers sat below the old 0.72 floor and
 *  their median was 79K views against 1.43M for hooks in band, an 18x gap on the same pages and
 *  the same fuel. A COVER ships at coverFloor or above. Between gateMin and coverFloor it ships
 *  only when the spec declares one of the four legitimate drift classes with a note (the donor
 *  quotes a named person, makes a first-person claim untrue of the persona, shouts in caps, or
 *  states the premise the account exists to reject). Below gateMin nothing ships, declared or not;
 *  above gateMax it is a duplicate post. Harvests, pots, seeds and the burner have no donor hook
 *  to keep and are exempt. An unmeasured cover (no donor) passes with a warning: the refusal is for
 *  a hook that drifted, not for a spec missing a field. `sim` is 0-1. */
export function hookGate({ sim, lane = 'cover', hookDrift = null, recId = null } = {}) {
  const H = LAWS.hook, pct = (x) => Math.round(x * 100);
  // A REMIX IS EXEMPT FOR THE OPPOSITE REASON to a harvest. A harvest has no donor hook at all; a
  // remix has one and deliberately keeps only its SHAPE, rewriting the subject and therefore nearly
  // every word (remix-thread, layers 1-3). Holding it to coverFloor would refuse the lane by
  // construction, so the similarity is measured and recorded and never gates.
  if (lane === 'remix') return { ok: true, floor: null, why: 'remix: the donor shape is kept, its wording is not' };
  if (lane !== 'cover') return { ok: true, floor: null, why: `${lane}: no donor hook to keep` };
  // AN UNMEASURED COVER WITH A DONOR IS A REFUSAL, NOT A PASS (2026-09-17). The escape below was
  // written for a spec that genuinely has no donor to compare against. It was being used by specs
  // that HAVE one: three of Run 5's fifteen covers carried no hookSim, and measuring them found
  // 1.000, 1.000 and 0.967 — two byte-identical to their donor once case is normalised, all three
  // above the duplicate edge and all three about to ship as a copy of someone else's post. That is
  // the same shape as the remix defect this run already fixed, a gate switched off by an empty
  // field, and it is worse here because nothing downstream looks at a hook again.
  //
  // So the distinction is whether the measurement was POSSIBLE. With a recId the donor hook is one
  // fetch away and a blank field means nobody checked; without one there is nothing to check.
  if (sim == null || Number.isNaN(Number(sim))) {
    if (recId) return { ok: false, floor: H.coverFloor, unmeasured: true, why: `unmeasured, but the spec names donor ${recId}: fetch its hook and record hookSim. A blank field is not a pass — three Run 5 covers reached this branch and all three were above the ${pct(H.gateMax)}% duplicate edge.` };
    return { ok: true, floor: H.coverFloor, unmeasured: true, why: `unmeasured: no donor hook on the spec and none fetched by recId, so the ${pct(H.coverFloor)}% floor could not be checked` };
  }
  if (sim > H.gateMax) return { ok: false, floor: H.coverFloor, why: `hook is ${pct(sim)}% of the donor, above the ${pct(H.gateMax)}% edge: a duplicate post, not our thread. Paraphrase inside the sentences.` };
  if (sim >= H.coverFloor) return { ok: true, floor: H.coverFloor, why: null };
  const cls = hookDrift?.class, note = String(hookDrift?.note || '').trim();
  const declared = (H.driftClasses || []).includes(cls) && note.length >= 10;
  if (sim >= H.gateMin && declared) return { ok: true, floor: H.gateMin, why: `declared drift (${cls}): ${note}` };
  const escape = sim >= H.gateMin
    ? ` A deliberate drift ships only with "hookDrift": { "class": "${(H.driftClasses || []).join('" | "')}", "note": "why" } on the spec.`
    : ` Below ${pct(H.gateMin)}% nothing ships, declared or not.`;
  return { ok: false, floor: H.coverFloor, why: `hook is ${pct(sim)}% of the donor; a cover ships at ${pct(H.coverFloor)}% or above. The donor's wording is the asset: keep its shape, its contractions and numerals, and its trigger word.${escape}` };
}

/** PURE. Load specs from a folder, or from the committed records for a date prefix. */
export function loadSpecs({ dir = null, records = null } = {}) {
  if (dir) {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => ({ file: f, spec: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
  }
  const rdir = join(HERE_DIR, 'queues', 'threads');
  if (!existsSync(rdir)) return [];
  return readdirSync(rdir).filter((f) => f.endsWith('.json') && (!records || f.startsWith(records))).sort()
    .map((f) => { const r = JSON.parse(readFileSync(join(rdir, f), 'utf8')); return { file: f, spec: r.spec, record: r }; });
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const at = airtable(env);
  const specs = loadSpecs({ dir: arg('dir'), records: arg('records') });
  if (!specs.length) { console.log('no specs found — pass --dir <folder> or --records <YYYY-MM-DD>'); return; }

  // Every donor hook in ONE read. Fetching them per thread is what makes this too slow to run often,
  // and a check nobody runs is not a check.
  const ids = [...new Set(specs.map((s) => s.spec?.recId).filter(Boolean))];
  const donors = new Map();
  if (ids.length) {
    const formula = `OR(${ids.map((i) => `RECORD_ID()="${i}"`).join(',')})`;
    for (const r of await at.list(TABLES.swipe, { formula, fields: ['Text'], max: 500, pageSize: 100 })) {
      donors.set(r.id, String(r.fields.Text || ''));
    }
  }

  const rows = specs.map(({ file, spec }) => {
    const donor = donors.get(spec?.recId);
    if (!donor) return { file, account: spec?.account, sim: null, band: 'no donor', ok: true, issue: null, shape: null, measured: 'no donor' };
    return { file, account: spec?.account, ...checkHook(spec?.tweets?.[0], donor, { swapPromise: !!spec?.swapPromise, hookDrift: spec?.hookDrift || null, lane: spec?.potOf ? 'pot' : spec?.harvestOf ? 'harvest' : spec?.moldId ? 'seed' : 'cover' }) };
  });

  if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }

  const bad = rows.filter((r) => !r.ok);
  const off = rows.filter((r) => r.ok && r.sim !== null && !r.onTarget);
  const shaped = rows.filter((r) => r.ok && r.shape);
  console.log(`\nHOOKS — ${rows.length} thread(s), floor ${LAWS.hook.coverFloor} (${LAWS.hook.gateMin} with a declared drift), edge ${LAWS.hook.gateMax}, target ${LAWS.hook.targetMin}-${LAWS.hook.targetMax}\n`);
  for (const r of rows.sort((a, b) => (a.sim ?? 9) - (b.sim ?? 9))) {
    const mark = !r.ok ? '✗' : r.onTarget ? '✓' : '·';
    const how = r.measured === 'no donor' ? '' : r.measured?.startsWith('item') ? '  (item line excluded)' : '  (whole first tweet)';
    console.log(`  ${mark} ${String(r.sim ?? '  —').padStart(5)}  ${String(r.band).padEnd(10)} ${String(r.account || '').padEnd(16)} ${r.file}${how}`);
    if (r.issue) console.log(`        ${r.issue.slice(0, 160)}`);
    if (r.ok && r.shape) console.log(`        shape (advisory): ${r.shape.slice(0, 140)}`);
  }
  console.log(`\n  ${rows.length - bad.length - off.length} on target · ${off.length} inside the band but off target · ${bad.length} failing · ${shaped.length} shape note(s), advisory`);
  console.log('  measured the way publish-thread measures: the item line is excluded only when the donor attaches one.');
  if (bad.length) { console.log('\n✗ fix the failing hooks before the gate stage.'); process.exitCode = 1; }
  else console.log('\n✓ every hook clears the door.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'hooks-check');
