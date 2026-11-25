// swipe-freshness.mjs — EXTERNAL watchdog for the scraping pipeline (the "secret sauce"). The n8n
// scrapers write new viral threads to the swipe DB; when they break silently (deleted credential, API
// quota, n8n offline) nothing new lands and — as June 22–24 proved — we don't notice for days. This
// polls the swipe DB's newest thread and alerts if it's gone stale. Decoupled from n8n, so it catches
// ANY cause, even n8n being completely down.
//
// DOWN vs DRY (2026-07-08): a stale DB has two very different causes and the old single alert
// misdiagnosed both as an outage (July 7 false alarm: the scout ran fine, the creators were just
// quiet). The n8n daily scout now stamps Config."Last Scout Run" on EVERY successful scan — even
// zero-new days — so this watchdog can tell them apart:
//   - heartbeat STALE  -> 🛑 DOWN: the scraper really isn't running — page immediately (old behavior).
//   - heartbeat FRESH  -> 🟡 DRY:  scraper healthy, no new qualifying threads. At ~2-4 finds/day zero
//     days are NORMAL variance, so a drought only alerts after 2 consecutive dry scans (> 2x threshold)
//     and reads as a supply signal (grow creators / check floors), not an infra page.
//   - heartbeat MISSING (field empty — n8n heartbeat not deployed yet) -> legacy behavior: hard alert.
//   node swipe-freshness.mjs            # alert if stale: DOWN -> Needs You, DRY -> Machine Room (config.mjs MESSAGE_TOPICS)
//   node swipe-freshness.mjs --dry      # check only, no alert
//   node swipe-freshness.mjs --hours 26 # staleness threshold (default 26h)
import { loadEnv, requireEnv, airtable, telegram, logRun, report } from './lib.mjs';
import { TABLES, CONFIG_RECORD, topicFor } from './config.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const MAX_HOURS = parseInt(flag('hours', '26'), 10); // daily scraper cadence + buffer; >this = something's wrong

const env = loadEnv();
requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
const at = airtable(env);

const newestRows = await at.list(TABLES.swipe, { sort: [{ field: 'Created time', direction: 'desc' }], fields: ['Created time'], pageSize: 1 });
const newest = newestRows[0]?.fields['Created time'];
const ageH = newest ? (Date.now() - new Date(newest).getTime()) / 36e5 : Infinity;
const dayAgo = new Date(Date.now() - 24 * 36e5).toISOString();
const last24 = await at.list(TABLES.swipe, { formula: `IS_AFTER({Created time},"${dayAgo}")`, fields: ['Created time'], pageSize: 100 });
const stale = ageH > MAX_HOURS;

// Scout heartbeat (Config."Last Scout Run", stamped by the n8n daily scout every successful scan).
let scoutAgeH = null;
try {
  const hb = (await at.getRecord(TABLES.config, CONFIG_RECORD))?.fields?.['Last Scout Run'];
  if (hb) scoutAgeH = (Date.now() - new Date(hb).getTime()) / 36e5;
} catch {} // unreadable Config -> treat as no heartbeat (legacy hard-alert path)
const scoutAlive = scoutAgeH != null && scoutAgeH <= MAX_HOURS;
const mode = !stale ? 'fresh' : scoutAlive ? 'dry' : 'down';

console.log(`${stale ? '⚠️ STALE' : '✅ fresh'}: newest thread ${ageH === Infinity ? 'NEVER' : ageH.toFixed(1) + 'h ago'} · ${last24.length}${last24.length === 100 ? '+' : ''} added in last 24h (threshold ${MAX_HOURS}h) · scout heartbeat ${scoutAgeH == null ? 'none recorded' : scoutAgeH.toFixed(1) + 'h ago'} -> ${mode.toUpperCase()}`);
logRun('swipe-freshness', { ageHours: ageH === Infinity ? null : Number(ageH.toFixed(1)), last24h: last24.length, stale, scoutAgeHours: scoutAgeH == null ? null : Number(scoutAgeH.toFixed(1)), mode });

if (mode === 'down' && !DRY) {
  await telegram(env, report({
    emoji: '🛑', title: 'Scraping Stalled', scope: `threshold ${MAX_HOURS}h`,
    status: `🛑 <b>Scraper DOWN</b> — newest thread <b>${ageH === Infinity ? 'older than any record' : ageH.toFixed(0) + 'h'}</b> old and the scout heartbeat is ${scoutAgeH == null ? 'missing (n8n heartbeat not deployed?)' : `<b>${scoutAgeH.toFixed(0)}h</b> stale`}`,
    sections: [{ label: 'DIAGNOSIS', body:
      `Only ${last24.length} added in 24h AND the daily scout did not complete a scan.\n\n`
      + `Likely causes: deleted/expired Airtable or RapidAPI credential in n8n, API quota, or n8n offline.` }],
    action: 'Check n8n executions for "Track Users Timelines (241)" + the Airtable/RapidAPI credentials.',
  }), topicFor('swipe-down'));
  console.log(`✓ Alerted DOWN (${topicFor('swipe-down')})`);
} else if (mode === 'dry' && ageH > 2 * MAX_HOURS && !DRY) {
  // 2+ consecutive dry scans — a supply drought worth a nudge, not an infra page.
  await telegram(env, report({
    emoji: '🟡', title: 'Discovery Dry', scope: `${ageH.toFixed(0)}h without a new thread`,
    status: `🟡 <b>Scraper healthy, discovery dry</b> — scout last scanned ${scoutAgeH.toFixed(0)}h ago and found nothing new for ${ageH.toFixed(0)}h`,
    sections: [{ label: 'WHAT THIS MEANS', body:
      `The tracked creators simply haven't produced a new qualifying thread. No infra action needed.\n\n`
      + `Supply levers: allowlist more health creators (Users table), or check the scout's view floor.` }],
    action: 'Consider growing the tracked-creator pool — discovery is the binding constraint.',
  }), topicFor('swipe-dry'));
  console.log(`✓ Alerted DRY (${topicFor('swipe-dry')})`);
}
process.exit(mode === 'down' ? 1 : 0);
