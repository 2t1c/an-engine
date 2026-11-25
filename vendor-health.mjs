// vendor-health.mjs — the checks that were done by hand on 2026-09-05, daily: is the Vendor Bot still
// inside every active vendor group, is exactly one T0 arrangement active, does every active tier row
// carry a chat id / price / reach, is the roster wired. Findings only; nothing is changed.
//
//   node vendor-health.mjs                 # print
//   node vendor-health.mjs --send          # post to the Fuel topic ONLY when there are findings
//   node vendor-health.mjs --no-telegram   # skip the getChatMember calls (lint only)
import { loadEnv, requireEnv, telegram, report, logRun, runMain } from './lib.mjs';
const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
import { lintConfig, lintMembership, formatFindings } from './fuel-ops-core.mjs';
import { configRows, accountRows, membership } from './fuel-ops-io.mjs';

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
  const [cfg, accounts] = await Promise.all([configRows(env), accountRows(env)]);
  const findings = lintConfig(cfg, accounts);
  let checked = 0;
  if (!process.argv.includes('--no-telegram')) {
    const chats = cfg.map((r) => r.fields || r)
      .filter((f) => f.Active && /^Vendor\s[–-]\s/.test(String(f.Name || '')) && String(f['Chat ID'] || '').trim())
      .map((f) => ({ name: f.Name, chatId: String(f['Chat ID']).trim() }));
    const results = await membership(cfg, chats);
    checked = results.length;
    findings.push(...lintMembership(results));
  }
  const text = report({ emoji: findings.some((f) => f.level === 'error') ? '🛑' : findings.length ? '⚠️' : '✅', title: 'Vendor health', scope: `${checked} group${checked === 1 ? '' : 's'} checked`, sections: [{ body: formatFindings(findings) }] });
  if (process.argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else console.log(plain(text));
  if (process.argv.includes('--send') && findings.length) await telegram(env, text, 'fuel');
  await logRun('vendor-health', { checked, errors: findings.filter((f) => f.level === 'error').length, warnings: findings.filter((f) => f.level === 'warn').length });
}, 'vendor-health');
