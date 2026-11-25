// donor-arm.mjs — did the vault arm work? Splits published covers by the age of the donor they
// were built from, and reports what each arm actually returned.
//
// WHY THERE IS NOTHING STAMPED ON THE DRAFT. A cover's arm is recoverable from what the registry
// already stores: `Source Thread` names the donor, the swipe row carries its `Published Date`, and
// the difference against `Posted Date` is the donor's age at the moment we posted. So this reads
// arms retroactively over every cover ever shipped, including the hundreds written long before the
// arm existed — which is the only reason the 2026-09-08 refit could be argued from evidence at all.
// A title tag would have started the clock at zero.
//
// THE QUESTION IT SETTLES. The 365-day vault is a declared bet: the current regime had n=4 past 90
// days, and the all-time numbers that look catastrophic there ($1.91-$2.32 a thread) are almost
// entirely the retired evergreen lane, whose donors had a median age of 378 days. That lane is the
// artefact that faked TWO findings on 2026-09-08 — a monotone decline with donor size, and an
// archive collapse — so `--since` defaults to the current regime and the lane is excluded by date
// rather than argued about.
//
//   node donor-arm.mjs                      # the arms, current regime
//   node donor-arm.mjs --since 2026-06-01   # widen, and watch the retired lane walk back in
//   node donor-arm.mjs --json
import { loadEnv, requireEnv, airtable, cliArg, runMain, logRun } from './lib.mjs';
import { TABLES } from './config.mjs';
import { LAWS } from './laws.mjs';

// The regime boundary. Covers before this were written under the retired engine lanes, to different
// standards, and mixing them in is what produced both false findings.
export const REGIME_START = '2026-08-20';
// Client rails in other niches — never part of a fleet read.
const EXCLUDE_ACCOUNTS = new Set(['AI Evolution', 'LearningToan']);
const statusId = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || null;

/** PURE. Bucket one cover by the age of its donor when we posted. */
export function armOf(donorAgeDays, sel = LAWS.selection || {}) {
  if (donorAgeDays == null) return null;
  if (donorAgeDays <= (sel.viralWindowDays ?? 30)) return 'fresh';
  if (donorAgeDays <= (sel.archiveStepDays ?? 90)) return 'archive';
  // PAST THE BOUND IS ITS OWN ARM, NOT THE TAIL OF THE ONE BEFORE IT (2026-09-17). Lumping them
  // together is what made the deep band unreadable: 25 covers at $7.90 was seventeen covers past
  // 365 days — which this ranking cannot pick and which returned ZERO median clicks — sitting on top
  // of seven inside it that returned $9.61-$24.65. Those are two different findings and only one of
  // them is about a donor the picker can actually choose.
  return donorAgeDays <= (sel.ogStepDays ?? 365) ? 'evergreen'
    : donorAgeDays <= (sel.archiveMaxAgeDays ?? 1095) ? 'og' : 'past-bound';
}

/** The oldest FRESH donors — the sub-band an archive pick actually displaces. Reported alongside
 *  the arms rather than instead of them, because both comparisons are worth seeing. */
export const isFreshEdge = (age, sel = LAWS.selection || {}) => age > (sel.recencyHalfLifeDays ?? 14) && age <= (sel.viralWindowDays ?? 30);

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * PURE. `covers` are joined rows: { arm, imp, clicks, comm, harvestEligible, donorViews, day }.
 * Reported per arm so the vault can be compared against the lane it is supposed to beat.
 */
export function summarise(covers = []) {
  const arms = {};
  for (const c of covers) {
    if (!c.arm) continue;
    (arms[c.arm] ||= []).push(c);
    // A REPORTING SLICE, not a fourth arm: freshEdge is a subset of fresh, counted twice on purpose
    // so the like-for-like comparison sits next to the lane totals.
    if (c.arm === 'fresh' && isFreshEdge(c.donorAge)) (arms.freshEdge ||= []).push(c);
  }
  const out = {};
  for (const [arm, rows] of Object.entries(arms)) {
    const imp = rows.map((r) => r.imp);
    out[arm] = {
      n: rows.length,
      medImpressions: Math.round(med(imp)),
      medClicks: Math.round(med(rows.map((r) => r.clicks))),
      commissionPerThread: +(sum(rows.map((r) => r.comm)) / rows.length).toFixed(2),
      // THE FUNNEL METRIC, and the reason the vault exists at all: a cover only matters to the farm
      // if it can become a harvest body. Reach and money are how a single thread pays; this is how
      // the machine compounds.
      harvestEligible: rows.filter((r) => r.harvestEligible).length,
      harvestRate: +(100 * rows.filter((r) => r.harvestEligible).length / rows.length).toFixed(1),
      medDonorViews: Math.round(med(rows.map((r) => r.donorViews))),
    };
  }
  return out;
}

/**
 * The verdict — and the comparison it makes is the whole point, because the obvious one is wrong.
 *
 * Against the WHOLE fresh lane the archive arm looks awful: 41% of $/thread on the first real read.
 * But `fresh` spans 0-30 days and is carried by its 0-7d head ($158.66 a thread), and a 0-7d donor
 * is not what an archive pick displaces. The pool inside 30 days holds ~100 usable donors against
 * ~40 covers a week, so the donor an archive pick actually replaces is the BOTTOM of the fresh
 * barrel, not its star. Comparing archive to the whole lane measures how good fresh donors are,
 * which nobody disputed.
 *
 * So the call is made against `edge` — the 14-30 day sub-band, the oldest fresh donors and the
 * closest like-for-like, which is exactly the pair measured at parity on 2026-09-08 (100,165 / 74 /
 * $51.56 against 107,489 / 64 / $54.79). Both figures are reported; only the honest one decides.
 */
export function verdict(s, minPerArm = 8) {
  const arch = s.archive, edge = s.freshEdge, fresh = s.fresh;
  if (!fresh || !arch) return { call: 'NOT ANSWERED', why: 'one arm has no matured covers yet' };
  if (fresh.n < minPerArm || arch.n < minPerArm) {
    return { call: 'NOT ANSWERED', why: `n=${fresh.n} fresh vs ${arch.n} archive — under ${minPerArm} an arm, a null here means "not measured", not "no difference"` };
  }
  const vsAll = arch.commissionPerThread / Math.max(0.01, fresh.commissionPerThread);
  if (!edge || edge.n < minPerArm) {
    return { call: 'NOT ANSWERED', why: `only ${edge?.n ?? 0} covers in the 14-30d band to compare against — archive is at ${(vsAll * 100).toFixed(0)}% of the WHOLE fresh lane, which is not the comparison that decides anything` };
  }
  const r = arch.commissionPerThread / Math.max(0.01, edge.commissionPerThread);
  const tail = `${(r * 100).toFixed(0)}% of the 14-30d band it displaces (${(vsAll * 100).toFixed(0)}% of the whole fresh lane, which includes its 0-7d head)`;
  if (r >= 0.8) return { call: 'VAULT HOLDS', why: `archive returns ${tail} — the window was costing selection for nothing` };
  return { call: 'VAULT COSTS', why: `archive returns ${tail}` };
}

const fmt = (s, v) => {
  const L = ['', 'DONOR ARM — the 365-day vault against the fresh window', ''];
  L.push(`  ${'arm'.padEnd(14)}${'n'.padStart(4)}${'med imp'.padStart(11)}${'med clicks'.padStart(12)}${'$/thread'.padStart(11)}${'harvest-elig'.padStart(14)}${'med donor views'.padStart(17)}`);
  for (const arm of ['fresh', 'freshEdge', 'archive', 'evergreen', 'og', 'past-bound']) {
    const a = s[arm]; if (!a) continue;
    const label = arm === 'freshEdge' ? '  └ 14-30d' : arm;
    L.push(`  ${label.padEnd(14)}${String(a.n).padStart(4)}${a.medImpressions.toLocaleString().padStart(11)}${String(a.medClicks).padStart(12)}${('$' + a.commissionPerThread.toFixed(2)).padStart(11)}${`${a.harvestEligible} (${a.harvestRate}%)`.padStart(14)}${a.medDonorViews.toLocaleString().padStart(17)}`);
  }
  L.push('', `  ${v.call} — ${v.why}`);
  L.push('', '  fresh <=30d, with its oldest 14-30d slice shown separately — that is what an archive pick');
  L.push('  displaces, not a 0-7d donor. archive 31-90d · evergreen 91-365d · og 366d+, the band the');
  L.push('  operator reopened on 2026-09-17. READ THE OG ROW ON IMPRESSIONS, NOT $/thread: those threads');
  L.push('  predate click attribution, and on the days they shipped 12 of 41 other covers logged zero');
  L.push('  clicks too, so the money column is missing data rather than a result. Impressions are not');
  L.push('  attribution-dependent and they still read 11,926 against 119,346 — that is the open question.');
  return L.join('\n');
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await runMain(async () => {
    const env = loadEnv();
    requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID']);
    const since = cliArg('since', REGIME_START);
    const reg = airtable(env, env.REGISTRY_BASE_ID), xdb = airtable(env);

    const [pc, pool] = await Promise.all([
      reg.listAll('Published Content', { fields: ['Account', 'Posted Date', 'Type', 'Impressions', 'Source Thread', 'Lifetime Clicks', 'Commission'] }),
      xdb.listAll(TABLES.swipe, { fields: ['Tweet URL', 'Impressions', 'Published Date'] }),
    ]);
    const donors = new Map();
    for (const r of pool) { const id = statusId((r.fields || {})['Tweet URL']); if (id) donors.set(id, r.fields); }

    // The harvest bar the farm already uses, so this reports the same "eligible" the pool does
    // rather than inventing a second definition of a winner.
    const bar = LAWS.scale?.breakoutViews ?? 500000;
    const covers = [];
    for (const r of pc) {
      const f = r.fields || {};
      if (!f['Posted Date'] || EXCLUDE_ACCOUNTS.has(f.Account)) continue;
      if (String(f.Type || '') !== 'Cover' || !f['Source Thread']) continue;
      const day = String(f['Posted Date']).slice(0, 10);
      if (day < since) continue;
      // A cover younger than 48h has not finished earning; counting it drags its arm down.
      if ((Date.now() - Date.parse(f['Posted Date'])) / 864e5 < 2) continue;
      const d = donors.get(statusId(f['Source Thread']));
      if (!d || !d['Published Date']) continue;
      const age = (Date.parse(f['Posted Date']) - Date.parse(d['Published Date'])) / 864e5;
      if (age < 0) continue;
      covers.push({
        day, arm: armOf(age), donorAge: +age.toFixed(1), donorViews: +d.Impressions || 0,
        // `Lifetime Clicks`, never `Link Clicks`. The latter is MAX(Typefully, Levanta) across every
        // link a draft owns — Threads `-th` twins included — so it mixes two platforms and two
        // measurement sources in one number, and test-scaffolds guards against new readers of it for
        // exactly that reason. Commission carries the same cross-post merge, but arm assignment is
        // donor AGE and which pages carry Threads is unrelated to it, so the merge is noise across
        // the arms rather than a bias in favour of one.
        imp: +f.Impressions || 0, clicks: +f['Lifetime Clicks'] || 0, comm: +f.Commission || 0,
        harvestEligible: (+f.Impressions || 0) >= bar,
      });
    }
    const s = summarise(covers);
    const v = verdict(s);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ since, bar, arms: s, verdict: v, n: covers.length }, null, 2));
    else { console.log(fmt(s, v)); console.log(`  ${covers.length} matured covers since ${since} · harvest bar ${bar.toLocaleString()} views\n`); }
    await logRun('donor-arm', { since, n: covers.length, arms: Object.fromEntries(Object.entries(s).map(([k, a]) => [k, a.n])), call: v.call });
  }, 'donor-arm');
}
