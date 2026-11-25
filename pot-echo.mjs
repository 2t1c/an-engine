// pot-echo.mjs — the two per-line reads a pot owes its origin: SHAPE at T1, and ECHO across the body.
//
// Resolves a pot's seed -> Source Harvest -> Origin Draft ID, pulls the origin's tweets, and runs
// both checks against them. Caches each origin body under queues/origins/ so a re-check is offline.
//
//   node pot-echo.mjs queues/pots/clover-stress.greenhouse.json
//   node pot-echo.mjs --all            # every greenhouse pot and every planted spec
//
// FOUR CHECKS, AND THE FIRST TWO PULL IN OPPOSITE DIRECTIONS — the point of running them together:
//   · hookShapeIssue  — the hook must still LOOK like its origin. Line count, register, markers,
//     parentheticals. Fires when the shape that earned the views has drifted.
//   · originEchoIssue — the body must not BE its origin. Fires when a family has drifted into
//     re-posting the thread it came from.
//   · sharedNgramIssue — the same direction as echo, at a finer grain. Echo counts whole SENTENCES,
//     so it cannot see a lifted clause: maple-desk measured 11% echo while carrying eight runs of
//     7+ words, one of them an 18-word tweet that was its origin's entire text with a single word
//     dropped (2026-09-11). recreate.mjs has run this gate on the cover lane since it was written;
//     the pot lane never had it, because gate-thread has no way to know the origin and this script
//     is the only place that resolves one. ADVISORY, not a failure: a rule's own claim line and a
//     seed's NEVER-CHANGE device are supposed to repeat, so a human reads the list and decides.
//   · rhythmIssues    — sentence length, paragraph count, vertical bullets. The operator's 2026-09-13
//     line-break rulings, thresholds fixed 2026-09-15 against their own finished remix. They lived
//     only in the remix skill's prose, which bound the operator writing by hand and bound the pot
//     lane not at all. ADVISORY for the same reason as the ngram read: they grade taste.
// A pot passes when it is the origin's shape carrying different words. Either check alone can be
// satisfied by the failure the other one names, so neither is meaningful without the other.
//
// EXIT CODE: 1 if any pot has a HARD hook-shape finding, else 0. Echo never fails the run — it is a
// measurement (a 30% echo can be correct work), and a routine that blocked on it would block on the
// families that are supposed to repeat their seed's NEVER CHANGE beats.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, typefully, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { originEchoIssue, hookShapeIssue, sharedNgramIssue, rhythmIssues, hookDeviceIssue, hookClauseIssue } from './checks.mjs';

const CACHE_DIR = join(HERE_DIR, 'queues', 'origins');

async function originFor(env, at, tf, seedRecId) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, `${seedRecId}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')).tweets;

  const seed = (await at.listAll('Seeds', {})).find((r) => r.id === seedRecId);
  if (!seed) return null;
  const harvestId = (seed.fields['Source Harvest'] || [])[0];
  if (!harvestId) return null;
  const harvest = (await at.listAll('Harvests', {})).find((r) => r.id === harvestId);
  if (!harvest) return null;

  const key = String(harvest.fields['Origin Account'] || '').trim().split(/\s+/)[0].toLowerCase();
  let account; try { account = getAccount(key); } catch { return null; }
  const d = await tf.getDraft(account.socialSetId, String(harvest.fields['Origin Draft ID']));
  const tweets = (d.platforms?.x?.posts || []).map((p) => p.text);
  writeFileSync(cached, JSON.stringify({ seedRecId, seed: seed.fields.Name, harvestId, tweets }, null, 1) + '\n');
  return tweets;
}

// Every spec that carries a seedRecId, pots and planted threads alike. A planted spec is the one
// that actually shipped, so leaving it out would mean the check never saw what went live.
function allSpecs() {
  const out = [];
  for (const dir of ['pots', 'threads']) {
    const abs = join(HERE_DIR, 'queues', dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).filter((x) => x.endsWith('.json')).sort()) out.push(join('queues', dir, f));
  }
  return out;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY', 'REGISTRY_BASE_ID']);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const tf = typefully(env);

  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const files = process.argv.includes('--all') ? allSpecs() : args;
  if (!files.length) throw new Error('Pass a pot spec, or --all');

  let echoFlagged = 0, hardHooks = 0, softHooks = 0, ngramFlagged = 0, rhythmFlagged = 0, checked = 0;
  let deviceHard = 0, deviceSoft = 0;
  for (const f of files) {
    let spec; try { spec = JSON.parse(readFileSync(join(HERE_DIR, f), 'utf8')); } catch { continue; }
    if (!spec.seedRecId || !Array.isArray(spec.tweets)) continue;
    const origin = await originFor(env, at, tf, spec.seedRecId);
    const name = f.split('/').pop().replace(/\.json$/, '');
    if (!origin) { console.log(`?  ${name.padEnd(38)} origin not resolvable (no Source Harvest)`); continue; }
    checked++;

    // SHAPE FIRST. A drifted hook is a defect in the most-read tweet of the thread; an echo number is
    // context. Printing them the other way round buries the finding that has to be acted on.
    const shape = hookShapeIssue(spec.tweets, origin);
    const hard = shape.filter((s) => !s.advisory), soft = shape.filter((s) => s.advisory);
    hardHooks += hard.length; softHooks += soft.length;

    const issue = originEchoIssue(spec.tweets, origin);
    if (issue && /ceiling/.test(issue)) echoFlagged++;

    // Per-tweet so the report names WHERE to rewrite, not just that something was lifted.
    const runs = spec.tweets.flatMap((t, i) => (sharedNgramIssue([t], origin) ? [i + 1] : []));
    ngramFlagged += runs.length;

    // Rhythm is measured against the pot itself, not the origin — it is a house style, not a
    // relationship to a donor. The account carries the garden text, so pass it and keep boilerplate out.
    const rhythm = rhythmIssues(spec.tweets, spec.account || null);
    rhythmFlagged += rhythm.length;

    // The family's own hook GRAMMAR. hookShapeIssue reads the layout between lines; this reads the
    // form inside one. beet's doctor listing passed every layout check while 3 of 8 pots had already
    // dissolved it, which is why this exists rather than living on as prose.
    const device = [
      ...hookDeviceIssue(spec.tweets, spec.potOf || null),
      // Family-independent: the promise lands on a noun or it does not, whatever seed it came from.
      ...hookClauseIssue(spec.tweets),
    ];
    const devHard = device.filter((d) => !d.advisory), devSoft = device.filter((d) => d.advisory);
    deviceHard += devHard.length; deviceSoft += devSoft.length;

    const mark = hard.length || devHard.length ? '✗' : soft.length || devSoft.length || issue || runs.length || rhythm.length ? '·' : '✓';
    console.log(`${mark}  ${name.padEnd(38)} hook ${hard.length ? `${hard.length} HARD` : soft.length ? `${soft.length} advisory` : 'in shape'} | ${issue ? issue.split(' — ')[0] : 'echo under 25%'}`);
    for (const s of hard) console.log(`     ✗ ${s.msg}`);
    for (const s of devHard) console.log(`     ✗ ${s.msg}`);
    for (const s of soft) console.log(`     · ${s.msg}`);
    for (const s of devSoft) console.log(`     · ${s.msg}`);
    if (issue && /ceiling/.test(issue)) console.log(`     · ${issue.split(' — ')[1]}`);
    if (runs.length) console.log(`     · verbatim run of 7+ words shared with the origin at tweet ${runs.join(', ')} — read each: a rule's claim line may repeat, a mechanism sentence should not`);
    for (const r of rhythm) console.log(`     · ${r.msg}`);
  }

  console.log(`\n${checked} pot(s) checked · ${hardHooks} hard hook-shape finding(s) · ${softHooks} advisory · ${deviceHard} hook-device break(s) · ${deviceSoft} device advisory · ${echoFlagged} over the echo ceiling · ${ngramFlagged} tweet(s) with a 7+ word verbatim run · ${rhythmFlagged} rhythm finding(s).`);
  if (hardHooks) {
    console.log('A hard finding means the hook no longer has its origin\'s shape. Fix the pot, or write down');
    console.log('in the seed why this family departs — a shape change without a measured reason is drift.');
  }
  process.exit(hardHooks || deviceHard ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
