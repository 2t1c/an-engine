// plan-publish.mjs — RETIRED 2026-09-02 (farm surgery): the Week Plan table is archived and the
// /run manifest replaced the planning calendar, so this writer has nothing live to write to.
// Kept for the planning-era history and its pure planToRows tests; do not wire it into anything
// new. Original header follows.
//
// Pushes a reviewed week plan to the registry's Week Plan table, which the
// dashboard's Plan calendar reads. The planner (plan-week.mjs) stays pure and writes only the JSON;
// THIS is the one deliberate external write, run after the operator has reviewed the plan.
//
// Upserts on Slot ("day · account") via Airtable's performUpsert, then deletes stale rows for the
// same week (a re-planned week fully replaces itself; other weeks are never touched). Planning data
// only — nothing here schedules or publishes content.
//
//   node plan-publish.mjs                # publish the newest queues/week-plan-*.json
//   node plan-publish.mjs --week 2026-08-24
//   node plan-publish.mjs --dry          # print the row diff, write nothing
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, runMain, HERE_DIR } from './lib.mjs';
import { laneOf, sameLane } from './lanes.mjs';

const DRY = process.argv.includes('--dry');
const TABLE = 'Week Plan';

// Pure: plan JSON -> Airtable rows. One row per slot; Slot is the upsert key and must stay
// byte-stable across republish (day · account is unique — one slot per account per day).
export function planToRows(plan) {
  const rows = [];
  for (const acc of plan.accounts || []) {
    for (const s of acc.slots || []) {
      const base = {
        Slot: `${s.day} · ${acc.account}`,
        Week: plan.week,
        Day: s.day,
        Account: acc.account,
        'Generated At': plan.generated,
      };
      // Canonical lane names since 2026-08-29 (lanes.mjs): the Airtable select options and the
      // Seed ID/Name/Status columns were renamed in the same change — writing the old spellings
      // here would re-mint 'Mold'/'Viral' options via typecast and miss the renamed columns.
      if (sameLane(s.lane, 'seed')) {
        rows.push({ ...base, Lane: 'Seed', 'Seed ID': s.moldId, 'Seed Name': s.mold, 'Seed Status': s.status, Hook: s.hookShape || '' });
      } else {
        rows.push({ ...base, Lane: 'Cover', Hook: s.hook || '', Views: s.views || 0, Bridges: (s.bridges || []).join(','), Topic: s.topic || '', 'Source URL': s.url || '' });
      }
    }
  }
  return rows;
}

export function latestPlanFile(names) {
  return names.filter((n) => /^week-plan-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1) || null;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const base = env.REGISTRY_BASE_ID || 'app4Orfi56ghELGix';
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(TABLE)}`;

  const wi = process.argv.indexOf('--week');
  const file = wi > 0 ? `week-plan-${process.argv[wi + 1]}.json` : latestPlanFile(readdirSync(join(HERE_DIR, 'queues')));
  if (!file) throw new Error('no queues/week-plan-*.json found');
  const plan = JSON.parse(readFileSync(join(HERE_DIR, 'queues', file), 'utf8'));
  const rows = planToRows(plan);
  console.log(`${file}: ${rows.length} slots (week ${plan.week})`);

  // Existing rows for THIS week only — the delete scope. Other weeks stay history.
  const existing = [];
  let offset;
  do {
    const u = `${url}?pageSize=100&filterByFormula=${encodeURIComponent(`{Week}='${plan.week}'`)}${offset ? `&offset=${offset}` : ''}`;
    const r = await fetch(u, { headers: h });
    if (!r.ok) throw new Error(`${TABLE} list -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    existing.push(...j.records);
    offset = j.offset;
  } while (offset);
  const wanted = new Set(rows.map((r) => r.Slot));
  const stale = existing.filter((r) => !wanted.has(r.fields.Slot));
  console.log(`existing rows this week: ${existing.length} · stale after republish: ${stale.length}`);
  if (DRY) { console.log('(dry — nothing written)'); return; }

  for (let i = 0; i < rows.length; i += 10) {
    const r = await fetch(url, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['Slot'] }, typecast: true, records: rows.slice(i, i + 10).map((fields) => ({ fields })) }),
    });
    if (!r.ok) throw new Error(`${TABLE} upsert -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  for (let i = 0; i < stale.length; i += 10) {
    const q = stale.slice(i, i + 10).map((r) => `records[]=${r.id}`).join('&');
    const r = await fetch(`${url}?${q}`, { method: 'DELETE', headers: h });
    if (!r.ok) throw new Error(`${TABLE} delete -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  console.log(`→ upserted ${rows.length}, deleted ${stale.length} stale — Week Plan table is current for ${plan.week}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'plan-publish');
