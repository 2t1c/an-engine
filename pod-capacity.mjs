// pod-capacity.mjs — can the pod library carry the CURRENT roster, and the one we are scaling to?
//
// THE CAPACITY MODEL (operator 2026-08-31: "we're scaling to 20 accounts very soon... build
// capacity for yourself"). Every account that lacks its own named variant of a pod draws from the
// shared * pool, hash-picked deterministically. So the number that decides duplicate-content
// exposure is FEEDS PER WORDING: how many accounts end up posting the same plug text for one pod.
// Pool depth divides the roster; the roster grows and the pool does not, so capacity is a moving
// ratio, not a fact — which is why this is a CHECK that reads the live roster, not a report written
// once. Adding accounts to accounts.mjs trips it with no other change.
//
//   node pod-capacity.mjs                    # report, live roster, both systems
//   node pod-capacity.mjs --accounts 20      # simulate the roster grown to N (synthetic keys
//                                            # hash-pick exactly like real new accounts would)
//   node pod-capacity.mjs --check            # exit 1 if any CLASSIC wording lands on more than
//   node pod-capacity.mjs --max-shared 4     #   --max-shared feeds (default 4)
//
// FRAMED is reported but never failed: one shared template per product is a recorded operator
// ruling (pods.json meta.oneVariantPerAccount — threads are recreations, so a repeated CTA is not a
// new duplicate-content risk). Under that ruling framed's feeds-per-wording IS the roster size, by
// design; the number is printed so the ruling can be revisited with eyes open, not enforced against.
//
// THE CEILING FOLLOWS THE LIVE SYSTEM (operator 2026-09-19). It used to be pinned to `classic`,
// which stopped being what production serves when skeleton became the default on 2026-09-13 —
// POD_SYSTEM is set in no workflow, so classic has been a dormant A/B arm ever since. Onboarding
// the 23rd account tipped 15 classic pods from 4 feeds per wording to 5 and failed the build, and
// the remedy on offer was ~2,000 words of selling copy for an arm nothing runs.
//
// So two conditions now gate a failure, and a system must meet both:
//   LIVE   — it is DEFAULT_POD_SYSTEM, i.e. what a thread would actually ship with.
//   DEEP   — some pod of it carries more than one `*` wording, so a deeper pool could spread the
//            load. A one-template-per-pod system CANNOT be spread thinner: its feeds-per-wording
//            is the roster size by construction, which is precisely why framed and backline are
//            reported and not failed. Enforcing there fails every pod on day one and says nothing.
//
// TODAY THAT MEANS NOTHING FAILS, and that is the honest cost of the change: skeleton is live but
// one-template-deep, classic is deep but dormant. The protection is not deleted, it is armed — set
// POD_SYSTEM=classic and classic is both live and deep again, so the ceiling bites on the same run
// that starts serving it. The numbers stay printed for every system either way.
import { pathToFileURL } from 'node:url';
import { ACCOUNTS } from './accounts.mjs';
import { PODS, variantFor, POD_SYSTEMS, DEFAULT_POD_SYSTEM } from './pods.mjs';

export const monetizedKeys = () =>
  Object.values(ACCOUNTS).filter((a) => !a.paused && a.socialSetId && a.levantaSubidPrefix).map((a) => a.key);

/**
 * Pure. For a roster of account keys: per live pod and system, how the wordings spread.
 * Returns rows { id, system, accounts, distinct, maxShared, poolSize, poolNeeded } where poolNeeded
 * is the * pool depth that would hold maxShared <= ceiling for THIS roster (named variants pull
 * their owners out of the pool draw first).
 */
export function capacityReport(keys, { ceiling = 4 } = {}) {
  const rows = [];
  for (const pod of PODS.filter((p) => p.status !== 'retired')) {
    for (const system of POD_SYSTEMS) {
      const byWording = new Map();
      let named = 0, poolDrawers = 0;
      for (const key of keys) {
        const v = variantFor(pod, key, { system, roster: keys });
        if (!v) continue;
        if (v.account === key) named++; else poolDrawers++;
        const w = [v.opener, v.middle, v.cta].join(' ');
        byWording.set(w, (byWording.get(w) || 0) + 1);
      }
      if (!byWording.size) continue; // pod absent from this system (documented systemGap)
      // SYSTEM-NEUTRAL pods (no variant carries a system tag) are new pods shipping ONE reviewed
      // wording by design, before either arm has earned them pool depth — the same standing as
      // framed's single template: reported, never failed. They graduate into the ceiling the day
      // their variants get tagged and pooled.
      const neutral = !(pod.variants || []).some((v) => v.system);
      const poolSize = (pod.variants || []).filter((v) => (v.system || 'framed') === system && v.account === '*').length;
      rows.push({
        id: pod.id, system, neutral, accounts: named + poolDrawers, named, poolDrawers, poolSize,
        distinct: byWording.size,
        maxShared: Math.max(...byWording.values()),
        poolNeeded: Math.ceil(poolDrawers / ceiling) || 0,
      });
    }
  }
  return rows;
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const CHECK = process.argv.includes('--check');
  const N = Number(arg('accounts', 0));
  const CEILING = Number(arg('max-shared', 4));

  const real = monetizedKeys();
  const keys = [...real];
  // Synthetic keys stand in for accounts that do not exist yet. They draw from the pool by the same
  // hash a real key would, so the SPREAD is realistic even though the specific assignments will
  // differ once the real handles exist. Named-variant coverage cannot be simulated at all — a new
  // account has no persona to have copy in yet — so a simulated roster is pool-only beyond the
  // real names, which is exactly what launch day looks like.
  for (let i = keys.length; i < N; i++) keys.push(`newacct${String(i).padStart(2, '0')}`);
  console.log(`roster: ${real.length} live monetized account(s)${keys.length > real.length ? ` + ${keys.length - real.length} simulated = ${keys.length}` : ''} · ceiling: ${CEILING} feeds per wording\n`);

  const rows = capacityReport(keys, { ceiling: CEILING });
  // LIVE and DEEP, per the ruling in the header. `enforcing` is false when the served system has no
  // pool to deepen, which is the state that makes a ceiling meaningless rather than merely unmet.
  const ENFORCED = DEFAULT_POD_SYSTEM;
  const enforcing = rows.some((r) => r.system === ENFORCED && !r.neutral && r.poolSize > 1);
  let worstClassic = 0, failures = 0;
  console.log('pod   system    accounts  named  pool  distinct  maxShared  poolNeeded');
  for (const r of rows.sort((a, b) => a.system.localeCompare(b.system) || b.maxShared - a.maxShared)) {
    const over = enforcing && r.system === ENFORCED && !r.neutral && r.maxShared > CEILING;
    if (over) failures++;
    if (r.system === 'classic' && !r.neutral) worstClassic = Math.max(worstClassic, r.maxShared);
    console.log(`  ${r.id.padEnd(5)}${r.system.padEnd(9)}${String(r.accounts).padStart(7)}${String(r.named).padStart(7)}${String(r.poolSize).padStart(6)}${String(r.distinct).padStart(9)}${String(r.maxShared).padStart(10)}${String(r.poolNeeded).padStart(11)}${over ? '   ✗ over ceiling' : ''}`);
  }
  const classic = rows.filter((r) => r.system === 'classic');
  const framedMax = Math.max(...rows.filter((r) => r.system === 'framed').map((r) => r.maxShared), 0);
  const backlineMax = Math.max(...rows.filter((r) => r.system === 'backline').map((r) => r.maxShared), 0);
  const deepest = Math.max(...classic.map((r) => r.poolNeeded), 0);
  console.log(`\nclassic: worst feeds-per-wording ${worstClassic} (ceiling ${CEILING}) · pool depth this roster needs: ${deepest}`);
  console.log(`backline: ${backlineMax} feeds share each wording by DESIGN (one reviewed template per product, the same ruling as framed — reported, not failed)`);
  console.log(`framed:   ${framedMax} feeds share each wording by DESIGN (meta.oneVariantPerAccount, a recorded ruling — reported, not failed)`);
  console.log(`enforced: \`${ENFORCED}\` is the live system${enforcing
    ? ` and carries a * pool deeper than one wording, so the ceiling of ${CEILING} is enforced against it`
    : ` but is one template per pod, so there is no pool to deepen and the ceiling is REPORTED, not enforced (see the ruling at the head of this file)`}`);
  if (CHECK && failures) {
    console.error(`\n✗ ${failures} ${ENFORCED} pod(s) put one wording on more than ${CEILING} feeds. Deepen the * pool (poolNeeded column) or add named variants before adding accounts.`);
    process.exit(1);
  }
  if (CHECK) {
    console.log(enforcing
      ? `\n✓ ${ENFORCED} capacity holds for this roster`
      : `\n✓ nothing to enforce: the live system has one template per pod. Numbers above are the record.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
