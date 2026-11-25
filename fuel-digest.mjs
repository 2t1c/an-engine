// fuel-digest.mjs — one note a day in the Fuel topic: what the fleet bought, by tier and by network,
// the bot's vendor runway, and a one-line health verdict. Built 2026-09-05, the day T0 went direct
// and the ladder went v2: the per-network ledger is only useful if someone reads it daily.
//
//   node fuel-digest.mjs                 # the Saigon day being wrapped up, print only
//                                        (before 04:00 Saigon that is YESTERDAY — a late cron is
//                                         finishing the day that ended, not opening the new one)
//   node fuel-digest.mjs --day 2026-09-05
//   node fuel-digest.mjs --send          # post to the Fuel topic
//   node fuel-digest.mjs --json
import { loadEnv, requireEnv, telegram, report, logRun, runMain, cliArg } from './lib.mjs';
import { SEND_STATE_DIGESTS } from './config.mjs';
const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
import { digest, formatDigest, runway, vendorRate, lintConfig, digestDay } from './fuel-ops-core.mjs';
import { fuelRows, configRows, accountRows, botStatus } from './fuel-ops-io.mjs';

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID']);
  const day = cliArg('day', digestDay());
  const [fuel, cfg, accounts] = await Promise.all([fuelRows(env), configRows(env), accountRows(env)]);
  const d = digest(fuel, { day });
  const { status, note } = await botStatus(cfg);
  const rw = runway(status, vendorRate(fuel));
  const health = lintConfig(cfg, accounts);
  const text = report({ emoji: '🧾', title: 'Fuel digest', scope: `${day} (Saigon)`, sections: [{ body: formatDigest(d, { runway: rw, health, botNote: note }) }] });
  if (process.argv.includes('--json')) console.log(JSON.stringify({ digest: d, runway: rw, botNote: note, health }, null, 2));
  else console.log(plain(text));
  // A state digest, quiet since 2026-10-06 like revenue's (the today-card already shows RT spend): it is
  // sent only when SEND_STATE_DIGESTS is on, or when it carries something to act on — a config error or
  // an unreachable bot.
  const actionable = health.some((f) => f.level === 'error') || !status;
  if (process.argv.includes('--send') && (SEND_STATE_DIGESTS || actionable)) await telegram(env, text, 'fuel');
  else if (process.argv.includes('--send')) console.log('(quiet: state digest, nothing to act on. SEND_STATE_DIGESTS in config.mjs turns it back on)');
  await logRun('fuel-digest', { day, threads: d.threads, spend: d.spend, fires: d.lines, healthErrors: health.filter((f) => f.level === 'error').length, bot: status ? 'ok' : note });
}, 'fuel-digest');
