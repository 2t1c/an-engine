// harvest-record.mjs — the RECORD for a harvest attempt (one heart), in the same shape as every
// other lane's: [Harvest] title, then a scratchpad that opens on the SOURCE (our own post, its hook,
// its X link, the parent draft, the Harvests row), then THIS THREAD (which heart, which repairs,
// which gates), SELLS and HISTORY. Durable copy lands in queues/threads/ like a cover's.
//
// WHY (operator 2026-09-06, three messages in a row). The attempts republish.mjs created carried a
// four-line "EVERGREEN REPOST of draft N" note and an [Evergreen] title, while the Aug-28 harvest
// in the operator's screenshot carried the full record. "What happened to all the details in the
// scratchpad?" and "Do not call it [Evergreen] — it's just seed, harvest and cover." A heart is a
// harvest; the title says so and the note answers where it came from without opening anything else.
//
//   node harvest-record.mjs <draftId> --account <key> [--from <sourceKey>] [--harvest <rec>] [--apply]
//
// Without --apply it prints the title and the scratchpad it would write. republish.mjs calls
// harvestRecord() directly at create, so a new attempt never needs this CLI.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRecord, renderScratchpad, writeRecord, threadTitle } from './thread-record.mjs';
import { loadEnv, requireEnv, airtable, typefully, HERE_DIR } from './lib.mjs';
import { ACCOUNTS, getAccount, defaultAccountKey } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { loadRepair } from './harvest-repair.mjs';

/** Every ledger row that is an attempt of this origin body, oldest first by reader time. */
export function attemptsOf(rows, origId) {
  return (rows || []).filter((r) => r && r.mode === 'evergreen' && !r.attributionOnly && String(r.sourceDraftId) === String(origId))
    .sort((a, b) => Date.parse(a.publishAt || a.ts || 0) - Date.parse(b.publishAt || b.ts || 0));
}

/** The heart's ordinal among this body's attempts (1 = the first heart ever spent on it). */
export function heartNumber(rows, origId, draftId) {
  const all = attemptsOf(rows, origId);
  const i = all.findIndex((r) => String(r.draftId) === String(draftId));
  return i >= 0 ? i + 1 : all.length + 1;
}

const short = (s) => String(s || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * harvestRecord — the record object for one heart. Pure given its inputs; republish and the CLI
 * both call it. `origin` is the source draft (its first tweet is the hook the heart re-posts).
 */
export function harvestRecord({ account, sourceAccount = null, origin = {}, origId, originUrl = null, harvestRecId = null, heart = null,
  batch = null, products = [], tweets = [], draftId = null, shareUrl = null, repair = null, applied = [], unrepairable = [], gates = null, at = null, baseId = null, harvestsTable = null, what = 'first ship' }) {
  const originPosts = origin?.platforms?.x?.posts || [];
  const hook = String(originPosts[0]?.text || origin?.hook || '');
  const originDate = origin?.published_at || origin?.scheduled_date || origin?.date || null;
  const repairMoves = (repair?.moves || []).map((m) => (m.from && m.to ? `ask T${m.from.join('+T')}→T${m.to.join('+T')}` : m.move ? `${m.move}@T${m.at}` : null)).filter(Boolean);
  const createMoves = (applied || []).map((a) => `${a.move}@T${a.at}${a.pod ? ` (${a.pod})` : ''}`);
  const how = [
    `harvest heart${heart ? ` #${heart}` : ''} on ${harvestRecId ? `Harvests ${harvestRecId}` : 'no Harvests row (pre-farm repost)'}`,
    `body verbatim from ${sourceAccount?.name || account?.name || '?'} draft ${origId}${originDate ? ` (posted ${String(originDate).slice(0, 10)})` : ''}, links re-minted to this row`,
    repair ? `repaired body (${repair.repairedAt?.slice(0, 10) || '?'}): ${repairMoves.join(', ') || 'recorded'}${repair.geometryChanged ? ' — ask geometry changed' : ''}` : null,
    createMoves.length ? `repairs at create: ${createMoves.join(', ')}` : 'no repairs needed at create',
    unrepairable?.length ? `beyond repair: ${unrepairable.join('; ')}` : null,
  ].filter(Boolean).join(' · ');
  const record = buildRecord({
    spec: { account: account.name, tweets, products, harvestOf: String(origId), batch, harvestRecId, contentLane: 'harvest' },
    source: { kind: 'our own post', hook, url: originUrl, parentDraftId: String(origId), author: sourceAccount?.handle || sourceAccount?.name || null, capturedAt: originDate },
    draftId, shareUrl, lane: 'Harvest', contentLane: 'harvest', at,
    built: { writerLane: 'chat', by: 'republish (verbatim heart)', how, gates: gates || 'deepRepostRepairs then validateDraft clean at create', what },
    baseId,
  });
  // The card that opens is the HARVESTS row, not a swipe card — this source has no donor.
  if (harvestRecId && baseId && harvestsTable) record.source.airtableCard = `https://airtable.com/${baseId}/${harvestsTable}/${harvestRecId}`;
  record.source.harvestRecId = harvestRecId;
  record.source.heart = heart;
  // Title: [Harvest] Account · <origin date> · CODES — hook. The origin's date, because that is what
  // identifies the body in a list (the Aug-28 harvest reads "· 08-28 ·" to this day).
  record.thread.title = threadTitle({ lane: 'Harvest', account: account.name, date: originDate || at || undefined, products, hook: tweets[0] || hook });
  return record;
}

/** Name → account, for the source name a title carries ("[Evergreen] Julian — Marko Silva · ..."). */
export function accountByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return Object.values(ACCOUNTS).find((a) => String(a.name || '').toLowerCase() === n) || null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(`--${k}`); return i > -1 ? args[i + 1] : null; };
  const draftId = args.find((a) => /^\d{6,}$/.test(a));
  if (!draftId) throw new Error('usage: node harvest-record.mjs <draftId> --account <key> [--from <sourceKey>] [--harvest <rec>] [--apply]');
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const account = getAccount(flag('account') || defaultAccountKey());
  const draft = await tf.getDraft(account.socialSetId, draftId);
  const tweets = (draft.platforms?.x?.posts || []).map((p) => String(p.text || ''));
  const rows = existsSync(join(HERE_DIR, 'ledger.jsonl'))
    ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  // An attempt's row is mode 'evergreen' (republish); the pre-farm repost lane wrote mode 'monetized'
  // rows carrying harvestOf. Both are hearts.
  const row = rows.find((r) => String(r.draftId) === String(draftId) && !r.attributionOnly && (r.mode === 'evergreen' || r.harvestOf));
  if (!row) throw new Error(`no harvest ledger row for draft ${draftId} — not a harvest attempt this repo created`);
  const origId = String(row.sourceDraftId || row.harvestOf);
  // The source page: --from, else the name the current title carries after the first " — ".
  const title = String(draft.draft_title || '');
  const namePart = title.replace(/^\[[^\]]+\]\s*/, '').split(' — ')[1] || '';
  const sourceAccount = flag('from') ? getAccount(flag('from')) : (accountByName(namePart.split(' · ')[0]) || account);
  let origin = null;
  try { origin = await tf.getDraft(sourceAccount.socialSetId, origId); } catch { origin = null; }
  const products = [
    row.asin ? { asin: row.asin, title: row.product, link: row.link, subid1: row.subid1 } : null,
    row.asin2 ? { asin: row.asin2, title: row.product2, link: row.link2, subid1: row.subid1b } : null,
    ...rows.filter((r) => String(r.draftId) === String(draftId) && r.attributionOnly && !r.platform).map((r) => ({ asin: r.asin, title: r.product, link: r.link, subid1: r.subid1 })),
  ].filter(Boolean);
  // Harvests row + the origin's X URL from the registry (Published Content), when the env has it.
  let harvestRecId = flag('harvest');
  let originUrl = null;
  if (env.REGISTRY_BASE_ID && env.AIRTABLE_PAT) {
    try {
      const reg = airtable(env, env.REGISTRY_BASE_ID);
      if (!harvestRecId) {
        const mine = await reg.listAll(REGISTRY_TABLE, { formula: `{Draft ID}="${draftId}"`, fields: ['Harvest'] });
        harvestRecId = mine[0]?.fields?.Harvest?.[0] || null;
      }
      const theirs = await reg.listAll(REGISTRY_TABLE, { formula: `{Draft ID}="${origId}"`, fields: ['X URL'] });
      originUrl = theirs[0]?.fields?.['X URL'] || null;
    } catch (e) { console.log(`  ⚠ registry lookup skipped: ${String(e.message).slice(0, 80)}`); }
  }
  const repair = harvestRecId ? loadRepair(harvestRecId) : null;
  const record = harvestRecord({
    account, sourceAccount, origin: origin || {}, origId, originUrl, harvestRecId, heart: heartNumber(rows, origId, draftId), batch: flag('batch') || null,
    products, tweets, draftId: String(draftId), shareUrl: draft.share_url || null, repair, applied: [], gates: 'validateDraft clean at create',
    at: row.ts || null, baseId: env.XDB_BASE_ID || null, harvestsTable: env.HARVESTS_TABLE || null,
  });
  // --what "<note>": the draft was changed after it shipped (a repair, a retime). History appends
  // rather than rewrites: v1 stays the first ship at the ledger's time, v2 is now.
  if (flag('what')) record.history.push({ v: 2, at: new Date().toISOString(), draftId: String(draftId), what: flag('what') });
  const note = renderScratchpad(record);
  console.log(`\n${record.thread.title}\n\n${note}\n`);
  if (!args.includes('--apply')) { console.log('(dry — pass --apply to write the title, the scratchpad and the record file)'); return; }
  // Re-read the schedule immediately before the write: never patch inside the 15-minute window.
  const fresh = await tf.getDraft(account.socialSetId, draftId);
  const when = Date.parse(fresh.scheduled_date || fresh.published_at || 0);
  if (fresh.published_at) throw new Error(`draft ${draftId} is already published — the record file is written, the draft is not touched`);
  if (when && when - Date.now() < 15 * 60e3) throw new Error(`draft ${draftId} posts in ${Math.round((when - Date.now()) / 60e3)} min — inside the 15-minute no-patch window`);
  await tf.patchDraft(account.socialSetId, draftId, { draft_title: record.thread.title, scratchpad_text: note });
  const file = writeRecord(record);
  console.log(`✓ ${account.name} draft ${draftId}: title + scratchpad written · record ${file.replace(HERE_DIR + '/', '')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
