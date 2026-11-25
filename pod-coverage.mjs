// pod-coverage.mjs — the pod library SCOREBOARD (read-only, writes nothing anywhere).
//
// The whole pod build is judged by one number: of the monetized slots in a committed week plan,
// how many would ship with EVERY plug pasted from the library, versus written live by the API?
// This script computes that number against any week-plan json, so each library change moves a
// visible score instead of a feeling. It measures the REAL selection path — it calls assignPods,
// the same function generation consults — never a re-implementation, so when selection gains a
// substance-level fallback this report picks it up without being touched.
//
//   node pod-coverage.mjs                                # newest queues/week-plan-*.json
//   node pod-coverage.mjs queues/week-plan-2026-08-24.json --verbose
//   node pod-coverage.mjs --min 0.9                      # exit 2 below 90% fully covered (CI gate)
//
// Vocabulary (per slot): COVERED = every product resolved to a pasteable pod (this account's
// variant included) · PARTIAL = at least one did · UNCOVERED = none did. Each unpasteable product
// is also classified prospectively so the gap names its own fix:
//   fixed-by-fallback — a pod for this substance+form exists WITH this account's variant; only
//                       ASIN-exact matching hides it (step-4 fallback converts these for free)
//   needs-variant     — a pod matches but no variant exists for this account (step-7 writing)
//   needs-new-pod     — no pod sells this substance at all (step-5 authoring)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR, runMain } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { PODS, variantFor, podFitsProduct } from './pods.mjs';
export { podFitsProduct };
import { assignPods } from './outline.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const VERBOSE = process.argv.includes('--verbose');
const ACCEPTANCE = process.argv.includes('--acceptance');

// Display name -> account key. Plans store "Marcos Romano"; code keys are "marcos". Exact
// display-name match first (the run-plan convention), then lowercase-first-word as a warned
// fallback so a renamed account degrades to a warning rather than silently zeroing its coverage.
export function accountKeyFor(name, accounts = ACCOUNTS) {
  const byName = new Map(Object.entries(accounts).map(([k, a]) => [a.name, k]));
  if (byName.has(name)) return { key: byName.get(name), warning: null };
  const first = String(name || '').trim().toLowerCase().split(/\s+/)[0];
  if (accounts[first]) return { key: first, warning: `account "${name}" matched by first word -> "${first}"` };
  return { key: null, warning: `account "${name}" matches no ACCOUNTS entry — its slots read as uncovered` };
}

/** Prospective gap classification for one (product, account) pair that assignPods left unpasted. */
export function classifyProduct(product, accountKey, { pods = PODS } = {}) {
  const live = pods.filter((p) => p.status !== 'retired');
  const matches = live.filter((p) => p.asin === product?.asin || podFitsProduct(p, product));
  if (!matches.length) return { kind: 'needs-new-pod' };
  const withVariant = matches.find((p) => variantFor(p, accountKey));
  if (withVariant) return { kind: 'fixed-by-fallback', podId: withVariant.id };
  return { kind: 'needs-variant', podId: matches[0].id, substance: matches[0].substance };
}

/** Pure: score one plan object. Returns totals + the ranked gap tables. */
export function coverWeekPlan(plan, { pods = PODS, accounts = ACCOUNTS } = {}) {
  const warnings = [];
  const slots = [];
  const noPodDemand = new Map();      // asin -> { title, slots }
  const missingVariant = new Map();   // `${account}×${substance}` -> count
  const split = { 'fixed-by-fallback': 0, 'needs-variant': 0, 'needs-new-pod': 0 };

  for (const acc of plan?.accounts || []) {
    const { key, warning } = accountKeyFor(acc.account, accounts);
    if (warning) warnings.push(warning);
    for (const s of acc.slots || []) {
      const products = (s.products || []).filter((p) => p?.asin);
      if (!products.length) { warnings.push(`${acc.account} ${s.day}: no products on slot — skipped`); continue; }
      const blocks = products.map((p) => ({ product: { asin: p.asin, title: p.title || '' } }));
      // THE REAL PATH: a product counts as pasteable only when assignPods attaches a rendered pod
      // for this account — exactly the condition generation will consult.
      const { blocks: out } = key ? assignPods(blocks, { hook: s.hook || '', account: key, pods }) : { blocks };
      const per = out.map((b, i) => {
        if (b.pod) return { pasted: true, podId: b.pod.id };
        const c = classifyProduct(products[i], key, { pods });
        split[c.kind]++;
        if (c.kind === 'needs-new-pod') {
          const row = noPodDemand.get(products[i].asin) || { title: products[i].title || products[i].asin, slots: 0 };
          row.slots++; noPodDemand.set(products[i].asin, row);
        }
        if (c.kind === 'needs-variant') {
          const k2 = `${key || acc.account} × ${c.substance}`;
          missingVariant.set(k2, (missingVariant.get(k2) || 0) + 1);
        }
        return { pasted: false, ...c };
      });
      const n = per.filter((x) => x.pasted).length;
      slots.push({
        account: key || acc.account, day: s.day, lane: s.lane, products: per,
        state: n === per.length ? 'covered' : n ? 'partial' : 'uncovered',
      });
    }
  }
  const total = slots.length;
  const covered = slots.filter((s) => s.state === 'covered').length;
  const partial = slots.filter((s) => s.state === 'partial').length;
  return {
    total, covered, partial, uncovered: total - covered - partial,
    ratio: total ? covered / total : 0, split, slots, warnings,
    noPodDemand: [...noPodDemand.entries()].sort((a, b) => b[1].slots - a[1].slots),
    missingVariant: [...missingVariant.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * The five-number GO/NO-GO readout the operator flips automation on. Numbers 1-4 compute offline
 * here; number 5 (a smoke recreate per path whose log shows PASTED and zero plug-writer calls) needs
 * the API, so the readout prints the exact commands instead of pretending.
 */
export async function acceptance(plan, { pods = PODS, accounts = ACCOUNTS } = {}) {
  const { libraryIssues, variantSpread, POD_VARIANT_MAX } = await import('./pods.mjs');
  const lib = libraryIssues();
  const keys = Object.keys(accounts).filter((k) => !accounts[k].paused && accounts[k].levantaSubidPrefix);
  const unrenderable = [];
  let worst = { v: 0, id: null };
  for (const p of pods.filter((x) => x.status !== 'retired')) {
    for (const k of keys) if (!variantFor(p, k)) unrenderable.push(`${p.id}×${k}`);
    const sp = variantSpread(p);
    if (sp.worst > worst.v) worst = { v: sp.worst, id: p.id };
  }
  const cov = coverWeekPlan(plan, { pods, accounts });
  return {
    checks: [
      { name: 'library validates clean', pass: lib.length === 0, detail: lib.length ? `${lib.length} issue(s)` : 'libraryIssues() === []' },
      { name: 'every pod renders for every live account, divergence under ceiling', pass: unrenderable.length === 0 && worst.v < POD_VARIANT_MAX, detail: unrenderable.length ? `unrenderable: ${unrenderable.slice(0, 6).join(', ')}${unrenderable.length > 6 ? '…' : ''}` : `worst pair ${(worst.v * 100).toFixed(0)}% (${worst.id}), ceiling ${POD_VARIANT_MAX * 100}%` },
      { name: 'week plan ≥90% fully covered, zero uncovered', pass: cov.ratio >= 0.9 && cov.uncovered === 0, detail: `${cov.covered}/${cov.total} covered, ${cov.uncovered} uncovered` },
      { name: 'offline acceptance threads green (suite section)', pass: null, detail: 'LIVE_ROSTER=0 node test-scaffolds.mjs — the "pods: offline acceptance" section' },
      { name: 'smoke recreate per path shows PASTED, zero plug-writer calls', pass: null, detail: 'node recreate.mjs <recId> --account <k> --asin <asin> --product "<title>"  ·  and once with OUTLINE_MODE=1 — grep the log for "PASTED from pod"' },
    ],
    coverage: cov,
  };
}

export function latestPlanPath(dir = join(HERE_DIR, 'queues')) {
  const plans = readdirSync(dir).filter((f) => /^week-plan-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return plans.length ? join(dir, plans[plans.length - 1]) : null;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await runMain(async () => {
    const path = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== arg('min') ) || latestPlanPath();
    if (!path) throw new Error('no week-plan json found — pass a path');
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    const r = coverWeekPlan(plan);
    console.log(`pod coverage — ${path.split('/').pop()}`);
    console.log(`  slots: ${r.total} = ${r.covered} covered · ${r.partial} partial · ${r.uncovered} uncovered  (${(r.ratio * 100).toFixed(0)}% fully covered)`);
    console.log(`  unpasted plugs by fix: fallback ${r.split['fixed-by-fallback']} · needs-variant ${r.split['needs-variant']} · needs-new-pod ${r.split['needs-new-pod']}`);
    if (r.noPodDemand.length) {
      console.log('\n  no pod sells these (write a pod — step 5):');
      for (const [asin, d] of r.noPodDemand) console.log(`    ${asin}  ${String(d.slots).padStart(2)} slot(s)  ${d.title.slice(0, 60)}`);
    }
    if (r.missingVariant.length) {
      console.log('\n  pod exists, voice missing (write variants — step 7):');
      for (const [k, n] of r.missingVariant) console.log(`    ${String(n).padStart(2)}×  ${k}`);
    }
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    if (VERBOSE) for (const s of r.slots) {
      console.log(`  ${s.state.padEnd(9)} ${s.account.padEnd(8)} ${s.day} ${s.lane}  ${s.products.map((p) => p.pasted ? `✓${p.podId}` : `✗${p.kind}`).join(' · ')}`);
    }
    if (ACCEPTANCE) {
      const a = await acceptance(plan);
      console.log('\n  ACCEPTANCE — automation flips only when all five are green (operator act):');
      for (const c of a.checks) console.log(`  ${c.pass === null ? '·' : c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    }
    const min = parseFloat(arg('min', ''));
    if (Number.isFinite(min) && r.ratio < min) {
      console.log(`\n✗ below --min ${min}: ${(r.ratio * 100).toFixed(0)}% fully covered`);
      process.exit(2);
    }
  }, 'pod-coverage');
}
