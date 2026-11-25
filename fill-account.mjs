// fill-account.mjs — one-off: fill an account's next N days (its post-hour slot) from a custom
// recId list (e.g. a hand-picked mix of all-time bangers + recent viral). Mirrors run-weekly's inner
// loop (pickProduct -> recreate -> media) but on consecutive days with sources you choose.
//   node fill-account.mjs --account lorenzo --recids rec1,rec2,rec3 [--dry]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, LLM_KEYS, airtable, fmtSaigon, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { pickProduct } from './pick-product.mjs';
import { takenSlots, openSlots, accountSlots, fleetSlotKeys } from './slots.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { TABLES } from './config.mjs';
import { processOperationKey, runResultChild } from './process-result.mjs';
import { runSafeDraftAttempts } from './draft-orchestration.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const KEY = flag('account', 'lorenzo');
const ACCOUNT = getAccount(KEY);
const recids = flag('recids', '').split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', LLM_KEYS, 'TYPEFULLY_API_KEY', 'LEVANTA_API_KEY']);
  if (!recids.length) throw new Error('pass --recids rec1,rec2,...');
  const at = airtable(env);
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;

  // The account's own daily slots (both posting windows), skipping any already filled. Same
  // accountSlots() the daily and weekly engines call, so a hand-filled day sits on the identical
  // clock as an engine-filled one. Two fields used to duplicate this truth locally (`postHour`,
  // then a `recreateSlots?.[0] ?? {h:11}` fallback) and BOTH silently drifted to a time no queue
  // used any more — hence no local copy: openSlots owns the day-walking too.
  const SLOTS = accountSlots(KEY, fleetSlotKeys(ACCOUNTS));
  const dates = openSlots(await takenSlots(env, ACCOUNT.socialSetId, SLOTS), recids.length, 30, SLOTS);
  if (dates.length < recids.length) throw new Error(`only ${dates.length} open slot(s) in the next 30 days for ${recids.length} recIds — free some up or pass fewer`);

  const usedAsins = {}, PRODUCT_CAP = 2; // no single product more than twice across the fill
  const plan = [];
  for (let k = 0; k < recids.length; k++) {
    const f = (await at.getRecord(TABLES.swipe, recids[k])).fields;
    const slot = { recId: recids[k], hook: (f.Text || '').split('\n')[0].slice(0, 80), niche: f.Niche, views: f.Impressions || 0 };
    const prod = await pickProduct(env, slot, products, [ACCOUNT.defaultProduct, ...(ACCOUNT.altProducts || [])], { usedAsins, cap: PRODUCT_CAP, mode: ACCOUNT.selectionMode });
    if (prod.asin) usedAsins[prod.asin] = (usedAsins[prod.asin] || 0) + 1;
    plan.push({ slot, at: dates[k], prod });
    console.log(`${k + 1}. ${fmtSaigon(dates[k], true)} | ${(slot.views).toLocaleString()} views | ${slot.hook}`);
    console.log(`   -> ${prod.title.slice(0, 60)}${prod.commission ? ` (${Math.round(prod.commission * 100)}%)` : ''}`);
  }
  if (DRY) { console.log('\n(dry run — nothing created)'); return; }

  const results = [];
  for (const p of plan) {
    let entry = { ...p, ok: false };
    const outcome = await runSafeDraftAttempts(() => runResultChild(join(HERE_DIR, 'recreate.mjs'),
        [p.slot.recId, '--asin', p.prod.asin, '--product', p.prod.title, '--at', p.at, '--create', '--account', KEY], {
          operationKey: processOperationKey('fill-account-draft', [p.at, KEY, p.slot.recId]),
          cwd: HERE_DIR, timeout: 480000, resultRoot: join(HERE_DIR, '.process-results'),
        }));
    entry = { ...p, draftId: outcome.result?.draftId, shareUrl: outcome.result?.shareUrl,
      ok: outcome.ok, phase: outcome.phase, llmCost: outcome.llmCost,
      err: outcome.ok ? null : `${outcome.phase}: ${outcome.error}`,
      ...(outcome.evidencePath ? { evidencePath: outcome.evidencePath } : {}) };
    if (entry.ok && entry.draftId) { try { execFileSync('node', [join(HERE_DIR, 'media.mjs'), entry.draftId, '--account', KEY], { encoding: 'utf8', timeout: 300000 }); entry.media = true; } catch {} }
    results.push(entry);
    console.log(`${entry.ok ? '✓' : '✗'} ${fmtSaigon(p.at)}: ${entry.ok ? `draft ${entry.draftId}${entry.media ? ' +media' : ''}` : 'FAILED — ' + (entry.err || '')}`);
  }
  console.log(`\nDone: ${results.filter((r) => r.ok).length}/${plan.length} scheduled for ${ACCOUNT.name}.`);
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
