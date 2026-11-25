// rt-usage-sync.mjs — refresh the Airtable "RT Usage" tracker (registry base): one row per
// vendor with where the deal stands, what it costs, how fast we burn it and when it renews.
// Operator, 2026-09-05: "very simple, updated every day."
//
// SYNCED (overwritten daily): Used, Package Size (when the bot's ledger tracks the vendor), Rate
// (posts/day), Cost per Post (config), Active, Tier, Paused on Bot, Used Source, Last Updated.
// YOURS (seeded once, then never touched): Deal Type, Package Cost, Monthly Retainer, Package Start,
// Next Payment, Notes. Remaining / Cost per Post / Days Left / Renew By / Monthly Spend are formulas
// on the table itself.
//
//   node rt-usage-sync.mjs           # dry: print the plan, write nothing
//   node rt-usage-sync.mjs --apply   # upsert (the fuel-ops cron does this daily)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, logRun, runMain, HERE_DIR } from './lib.mjs';
import { usagePlan, formatUsagePlan, RT_USAGE_TABLE } from './fuel-ops-core.mjs';
import { fuelRows, configRows, botStatus } from './fuel-ops-io.mjs';

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID']);
  const reg = airtable(env, env.REGISTRY_BASE_ID);
  const [fuel, cfg, existing] = await Promise.all([fuelRows(env), configRows(env), reg.listAll(RT_USAGE_TABLE)]);
  const { status, note } = await botStatus(cfg);
  const vendors = JSON.parse(readFileSync(join(HERE_DIR, 'vendors.json'), 'utf8')).vendors || [];
  const plan = usagePlan({ config: cfg, vendors, fuelRows: fuel, botStatus: status, existing });
  console.log(formatUsagePlan(plan));
  console.log(`\n${plan.length} vendors · ${existing.length} rows already in ${RT_USAGE_TABLE} · bot ledger: ${status ? 'ok' : note}`);
  if (process.argv.includes('--apply')) {
    await reg.upsert(RT_USAGE_TABLE, 'Vendor', plan);
    console.log(`upserted ${plan.length} rows`);
  } else console.log('dry run — pass --apply to write');
  await logRun('rt-usage-sync', { vendors: plan.length, applied: process.argv.includes('--apply'), bot: status ? 'ok' : note, fromBot: plan.filter((r) => r['Used Source'] === 'bot').length });
}, 'rt-usage-sync');
