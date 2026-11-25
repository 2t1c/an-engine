// donor-runway.mjs — how many weeks of fresh donors are left at the current burn? (H3)
//
// Nothing counted this: SCALING.md guessed "~6 a night", thread-molds.md said "1,526 bridgeable
// candidates", and they disagree because both were done by hand. This computes the number weekly:
//   stock   = engine-grade UNUSED swipe heads (the planner's own quality gates, fleet niches,
//             any age — the planner's 21-day window is a freshness preference, not the reserve)
//   burn    = fresh donors FIRST-consumed per week (14-day ledger window)
//   runway  = stock / burn -> needs-you warns under 8 weeks.
//
//   node donor-runway.mjs [--dry]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, runMain, logRun, HERE_DIR } from './lib.mjs';
import { TABLES } from './config.mjs';

const DRY = process.argv.includes('--dry');

export function runwayVerdict({ stock = 0, burnPerWeek = 0 } = {}) {
  const weeks = burnPerWeek > 0 ? Number((stock / burnPerWeek).toFixed(1)) : null;
  return { weeks, low: weeks !== null && weeks < 8 };
}

/** Pure: fresh-donor burn per week — recIds whose FIRST ledger use falls inside the window.
 *  Re-use of an already-consumed donor (cross-account spread, harvest, blitz) burns nothing. */
export function freshBurn(entries, { days = 14, now = Date.now() } = {}) {
  const first = new Map();
  for (const e of entries || []) {
    if (!e?.recId || !e.ts) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (!first.has(e.recId) || t < first.get(e.recId)) first.set(e.recId, t);
  }
  const cut = now - days * 864e5;
  const fresh = [...first.values()].filter((t) => t >= cut).length;
  return Number((fresh / (days / 7)).toFixed(1));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runMain(async () => {
    const env = loadEnv();
    requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
    // Hand-paginated: lib's airtable.list returns ONE page, and a one-page "stock" of exactly 100
    // is how a fuel gauge lies (first dry run reported 2 weeks of runway on a truncated count).
    const H = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
    const formula = `AND({Tweet Number}=1,{Thread Length}>=3,NOT({Quoted Junk}),NOT({Single Tweet}),{Impressions}>=250000,OR({Niche}="Health",{Niche}="Fitness",{Niche}="Mental Health"))`;
    const heads = [];
    let offset;
    do {
      const p = new URLSearchParams({ pageSize: '100', filterByFormula: formula });
      p.append('fields[]', 'Impressions');
      if (offset) p.set('offset', offset);
      const r = await fetch(`https://api.airtable.com/v0/${env.XDB_BASE_ID}/${TABLES.swipe}?${p}`, { headers: H });
      const d = await r.json();
      if (d.error) throw new Error(JSON.stringify(d.error));
      heads.push(...(d.records || []));
      offset = d.offset;
    } while (offset);
    const entries = existsSync(join(HERE_DIR, 'ledger.jsonl'))
      ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const used = new Set(entries.filter((e) => e.recId).map((e) => e.recId));
    const stock = heads.filter((h) => !used.has(h.id)).length;
    const burnPerWeek = freshBurn(entries);
    const { weeks, low } = runwayVerdict({ stock, burnPerWeek });

    console.log(`DONOR RUNWAY — ${stock} engine-grade unused donors (of ${heads.length} qualifying; ${used.size} ever consumed)`);
    console.log(`burn: ${burnPerWeek} fresh donor(s)/week (14d window) → runway ${weeks === null ? '∞ (no recent burn)' : `~${weeks} week(s)`}${low ? '  ⚠ UNDER 8 WEEKS' : ''}`);

    if (!DRY) {
      writeFileSync(join(HERE_DIR, 'queues', 'donor-runway.json'), JSON.stringify({
        updatedAt: new Date().toISOString(), stock, qualifying: heads.length, usedEver: used.size, burnPerWeek, weeks,
      }, null, 1) + '\n');
    }
    logRun('donor-runway', { stock, qualifying: heads.length, usedEver: used.size, burnPerWeek, weeks, low });
  }, 'donor-runway');
}
