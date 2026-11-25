// integrity-sentinel.mjs — the audit that found this week's silent failures, as a standing check.
//
// Every defect the 2026-08-17 audit surfaced had been true for weeks and announced itself to no
// one: per-tweet coverage sat at 18% because a window closed quietly; the engine's Winner rule and
// the Airtable Verdict formula drifted apart and disagreed on 23 posts; Growth Log rows were
// stranded unlinked by a scan bound to the wrong clock. Each was found by a human reading 15,000
// rows. This job is that reading, weekly, with three assertions — and it TELEGRAMS ONLY ON BREACH,
// because a green report every Sunday trains the operator to stop reading.
//
//   1. COVERAGE FLOORS   tracked fields must hold their level on fleet posts old enough to have
//                        data. Floors sit ~5-7 points under the audited highs: they catch decay,
//                        not noise.
//   2. SENSOR AGREEMENT  a live X read of recent threads must still reconcile with the stored
//                        curve totals (audited median 1.01x). Drift means one sensor is lying.
//                        Skipped loudly when RAPIDAPI_KEY is absent.
//   3. LINK INTEGRITY    fleet Growth Log rows older than the grace window must be linked to
//                        their post. Stranded rows were exactly the bug fixed on 2026-08-17;
//                        recurrence means the relink regressed.
//
// VERDICT PARITY (the old check 2) retired 2026-09-02 with the Winner status: Status is lifecycle
// only now, so there is no engine-written winner flag left to drift from the rule — the rule
// itself moved to laws.json farm.* and harvest-gate.mjs, and the invariant that survives it is
// registry-sync's monotonic lifetime commission/clicks guard.
//
//   node integrity-sentinel.mjs          # live: checks + Telegram on breach
//   node integrity-sentinel.mjs --dry    # checks + report, no Telegram
//
// Env: AIRTABLE_PAT, REGISTRY_BASE_ID; RAPIDAPI_KEY optional (check 3);
//      TELEGRAM_BOT_TOKEN/CHAT_ID optional (alert delivery).
import { isStandalonePost, isThreadRow } from './monitoring-scope.mjs';
import { loadEnv, requireEnv, telegram, esc, report, logRun } from './lib.mjs';
import { lastLog, alertDelta } from './alert-delta.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { parseThreadPayload, tweetIdOf, handleOf } from './scrape-freeze.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');


// ---- pure verdicts (imported by test-scaffolds) --------------------------------------------------

/** Floors sit under the audited 2026-08-18 highs (87/70/61/87) by enough to ignore noise. */
export const COVERAGE_FLOORS = {
  'Tweet Views': 0.8,
  'Hook ID': 0.6,
  'Plug Exposure %': 0.5,
  'Read-Through %': 0.8,
};

/**
 * rows: fleet published posts old enough that every sensor had its chance (age > graceDays).
 * Returns breaches: [{field, have, floor, n}] — have as a fraction of eligible rows.
 */
export function coverageVerdict(rows, { floors = COVERAGE_FLOORS, minRows = 30 } = {}) {
  if (rows.length < minRows) return { breaches: [], eligible: rows.length, skipped: true };
  const breaches = [];
  const shares = {};
  for (const [field, floor] of Object.entries(floors)) {
    const have = rows.filter((r) => r[field] != null && r[field] !== '').length / rows.length;
    shares[field] = have;
    if (have < floor) breaches.push({ field, have: Number(have.toFixed(3)), floor, n: rows.length });
  }
  return { breaches, shares, eligible: rows.length, skipped: false };
}

/**
 * samples: [{stored, live}] thread-view totals per post. The audited baseline is live/stored
 * ~= 1.01 (live reads slightly higher: post-boundary tail growth + replies Typefully never saw).
 * Alarm when the MEDIAN leaves [0.9, 1.2] — a low median means the live read collapsed (sensor
 * broken or account shadow-limited); a high one means stored curves are badly stale.
 */
export function sensorVerdict(samples, { lo = 0.9, hi = 1.2, minSamples = 5 } = {}) {
  const ratios = samples.filter((s) => s.stored > 0 && Number.isFinite(s.live)).map((s) => s.live / s.stored).sort((a, b) => a - b);
  if (ratios.length < minSamples) return { ok: true, median: null, n: ratios.length, skipped: true };
  const median = ratios[Math.floor(ratios.length / 2)];
  return { ok: median >= lo && median <= hi, median: Number(median.toFixed(3)), n: ratios.length, lo, hi, skipped: false };
}

/**
 * growthRows: [{linked, ageDays, tid}], registryTids: tweet ids present in Published Content.
 * An orphan is a row that is LINKABLE and unlinked: its tweet exists in the registry, the relink
 * has had graceDays to act, and the Post link is still missing — the exact 2026-08-17 bug class
 * (267 rows stranded by a date-bound scan). Rows whose tweet is NOT in the registry are excluded
 * no matter whose handle they carry: manual posts on fleet handles and the external accounts are
 * unlinkable BY DESIGN, and counting them (159 on first live run) would alarm forever and teach
 * the operator to ignore the alarm.
 */
export function orphanVerdict(growthRows, registryTids, { graceDays = 3, maxOrphans = 25 } = {}) {
  const orphans = growthRows.filter((r) => !r.linked && r.ageDays > graceDays && r.tid && registryTids.has(r.tid));
  return { ok: orphans.length <= maxOrphans, orphans: orphans.length, maxOrphans };
}

/**
 * records: Published Content rows. The fleet's published THREADS, which checks 1 and 2 judge: every
 * field they read is a per-tweet thread sensor. A native X Article (owner, R2026-10-03: articles are
 * additive) has no tweet curve, plug funnel or read-through by design, so counting one would read as
 * a sensor that stopped filling. Check 3 still reads every non-single row: registry-sync relinks
 * Growth Log rows to articles too, so an unlinked one is a real orphan.
 */
export function publishedFleetThreads(records, fleetHandles) {
  // Retired Winner spellings tolerated on read until the orphan cleanup rewrites/deletes them.
  return records.filter((r) => isThreadRow(r) && fleetHandles.has(handleOf(r.fields['X URL']).toLowerCase())
    && ['Posted', 'Reposted', 'Winner', 'Repost Candidate'].includes(r.fields.Status));
}

// ---- I/O -----------------------------------------------------------------------------------------

async function listAll(env, table, fields) {
  const base = env.REGISTRY_BASE_ID, h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const out = []; let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize', '100'); if (offset) u.searchParams.set('offset', offset);
    for (const f of fields) u.searchParams.append('fields[]', f);
    const r = await fetch(u, { headers: h });
    if (!r.ok) throw new Error(`${table} read -> ${r.status}`);
    const j = await r.json();
    out.push(...j.records); offset = j.offset;
  } while (offset);
  return out;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const fleetHandles = new Set(Object.values(ACCOUNTS).filter((a) => !a.external && a.handle).map((a) => a.handle.toLowerCase()));
  const sections = [];

  const pc = (await listAll(env, REGISTRY_TABLE, ['Type', 'Post', 'X URL', 'Status', 'Link Clicks', 'Commission', 'Posted Date', 'Tweet Views', 'Hook ID', 'Plug Exposure %', 'Read-Through %', 'Account', 'Impressions'])).filter(r => !isStandalonePost(r));
  const now = Date.now();
  const published = publishedFleetThreads(pc, fleetHandles);

  // 1. coverage — posts older than 2 days, so every sensor had its chance
  const eligible = published
    .filter((r) => r.fields['Posted Date'] && (now - new Date(r.fields['Posted Date']).getTime()) / 864e5 > 2)
    .map((r) => r.fields);
  const cov = coverageVerdict(eligible);
  if (cov.breaches.length) sections.push({
    label: 'COVERAGE BELOW FLOOR (a sensor stopped filling a field)',
    body: cov.breaches.map((b) => `• <b>${esc(b.field)}</b>: ${(b.have * 100).toFixed(1)}% of ${b.n} posts (floor ${b.floor * 100}%)`).join('\n') +
      '\nFirst check: registry-sync per-tweet pull errors, then scrape-freeze run logs.',
  });

  // 2. sensor agreement — the 12 most recent posts with a stored curve; live-read each
  let sensor = { skipped: true, n: 0 };
  if (env.RAPIDAPI_KEY) {
    const withCurve = published
      .filter((r) => r.fields['Tweet Views'] && (r.fields.Impressions ?? 0) > 500)
      .sort((a, b) => String(b.fields['Posted Date']).localeCompare(String(a.fields['Posted Date'])))
      .slice(0, 12);
    const samples = [];
    for (const r of withCurve) {
      const pid = tweetIdOf(r.fields['X URL']);
      try {
        const res = await fetch(`https://twitter241.p.rapidapi.com/tweet?pid=${pid}`, { headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': 'twitter241.p.rapidapi.com' } });
        if (!res.ok) continue;
        const parsed = parseThreadPayload(await res.json(), pid);
        if (parsed.error) continue;
        const live = parsed.tweets.map((t) => t.views).filter(Number.isFinite).reduce((a, b) => a + b, 0);
        const stored = JSON.parse(r.fields['Tweet Views']).reduce((a, t) => a + (t.v || 0), 0);
        samples.push({ stored, live });
      } catch { /* one bad sample must not kill the check */ }
      await new Promise((s) => setTimeout(s, 150));
    }
    sensor = sensorVerdict(samples);
    if (!sensor.skipped && !sensor.ok) sections.push({
      label: 'SENSORS DISAGREE (live X read vs stored curves)',
      body: `• median live/stored = <b>${sensor.median}</b> over ${sensor.n} recent posts (healthy band ${sensor.lo}–${sensor.hi}; audited baseline 1.01).\nLow = live read collapsed (API/shadow-limit); high = stored curves stale. Check scrape-freeze + registry-sync logs.`,
    });
  } else console.log('sensor check skipped: RAPIDAPI_KEY not set');

  // 3. link integrity: RETIRED 2026-11-25. The Growth Log moved to its own base (config.mjs GROWTH) and a
  // link can't cross bases, so its rows carry no Post link any more; readers match by {X URL}.
  const orphan = { ok: true, orphans: 0 };

  const summary = {
    coverage: cov.shares ? Object.fromEntries(Object.entries(cov.shares).map(([k, v]) => [k, Number((v * 100).toFixed(1))])) : null,
    sensorMedian: sensor.median ?? null,
    orphans: orphan.orphans,
    breaches: sections.length,
    clean: sections.length === 0,
    breachLabels: sections.map((s) => s.label).sort(),
  };
  // Since 2026-10-06 a breach that stood at the last run is not re-sent (alert-delta.mjs): the same two
  // breaches went out every week for five weeks. A new breach, or --always, sends the full report.
  const delta = alertDelta(lastLog('integrity-sentinel')?.breachLabels, summary.breachLabels);
  await logRun('integrity-sentinel', summary);

  if (!sections.length) { console.log(`✅ integrity clean — coverage ${JSON.stringify(summary.coverage)} · sensor ${sensor.median ?? 'skipped'} · orphans ${orphan.orphans}. Nothing sent.`); return; }
  const msg = report({
    emoji: '🧪', title: 'Integrity sentinel — a data guarantee broke', scope: `${published.length} fleet posts checked`,
    status: `⚠️ ${sections.length} breach${sections.length === 1 ? '' : 'es'} — these decayed silently for weeks last time`,
    sections, action: 'Each section names its first check. None of this self-heals.',
  });
  console.log(msg.replace(/<[^>]+>/g, ''));
  if (!DRY && (delta.changed || process.argv.includes('--always'))) { await telegram(env, msg, 'alerts'); console.log('\n✓ sent to alerts topic'); }
  else if (!DRY) console.log(`\n(same breach${sections.length === 1 ? '' : 'es'} as last run — nothing sent; --always to resend)`);
}

// Import guard: test-scaffolds imports the pure verdicts — importing this module must never
// run live checks or send a Telegram.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
