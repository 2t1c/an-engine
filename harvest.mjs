// harvest.mjs — recycle our own winners: same proven body, a different hook, a FRESH subid.
//
// The old harvest engine shipped 15 variations that pulled 2.9M impressions and 1,718 clicks — and
// earned $0.00, because not one of them carried a subid or a product. The format out-clicked fresh
// content; it was never monetized. This is the rebuild, and the money layer is the point.
//
// What it does per breakout:
//   1. Find own-page winners in the registry (>= MIN_VIEWS; flat floor, operator 2026-08-25).
//   2. Pull the winning draft's tweets and its ledger row (products, moldId, source).
//   3. Emit a VARIATION SPEC: the body verbatim, the parent hook, and the target hook treatment —
//      the writing itself happens in-session (operator law: threads are written here, not by API).
//   4. publish-thread ships it with a FRESH subid per variation and `harvestOf` in the ledger.
//
// Two laws, both attribution-critical:
//   RE-MINT, ALWAYS. Same body + same link merges the child's revenue into the parent's subid and
//   we never learn which hook won — which is the entire point of running variations.
//   THE 85-90% BAND APPLIES AGAINST THE PARENT, not just the original donor. Three near-identical
//   hooks across three accounts is a duplicate-detection risk we would be creating ourselves.
//
//   node harvest.mjs                    # list breakouts + emit variation specs
//   node harvest.mjs --account magnus
//   node harvest.mjs --min-views 300000
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { LAWS } from './laws.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { isThreadRow } from './monitoring-scope.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MIN_VIEWS = Number(arg('min-views', LAWS.scale.breakoutViews));

/** PURE. The registry rows breakouts are found among: published THREADS. A harvest re-runs a thread
 *  body, so a single or a native X Article (owner, R2026-10-03: articles are additive) is never a
 *  breakout to harvest; harvest-gate.mjs keeps articles out of the pool on the same rule, and the
 *  sweep's harvest-supply check reads its rows through this. Needs each record's Type. */
export function harvestRows(records) {
  return records.filter((r) => isThreadRow(r)).map((r) => ({
    account: r.fields.Account, draftId: String(r.fields['Draft ID'] || ''), title: r.fields.Post || '',
    impressions: r.fields.Impressions || 0,
    clicks: r.fields['Lifetime Clicks'] ?? r.fields['Affiliate Clicks'] ?? 0,
    commission: r.fields['Lifetime Commission'] ?? r.fields.Commission ?? 0,
    postedAt: r.fields['Posted Date'], url: r.fields['X URL'],
  })).filter((r) => r.draftId);
}

// Pure: which published posts are breakouts? A flat views floor, full stop (operator 2026-08-25:
// the >=3x-account-median requirement is REMOVED — a 500k post is worth recycling whoever posted
// it; big accounts' routine winners were being filtered out of their own harvest). The account
// median still rides along as context so the report can say how unusual the post was for its page.
export function findBreakouts(rows, { minViews = MIN_VIEWS } = {}) {
  const byAccount = {};
  for (const r of rows) if (r.impressions > 0) (byAccount[r.account] ||= []).push(r);
  const out = [];
  for (const [account, list] of Object.entries(byAccount)) {
    const sorted = list.map((r) => r.impressions).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    for (const r of list) {
      if (r.impressions >= minViews) {
        out.push({ ...r, accountMedian: median, multiple: median ? r.impressions / median : null });
      }
    }
  }
  return out.sort((a, b) => b.impressions - a.impressions);
}

// Pure: has this parent already been harvested, and how many times? A winner gets at most
// MAX_VARIATIONS children, spaced — the goal is a second bite, not a feed of reruns.
export function harvestCount(ledgerRows, parentDraftId) {
  return ledgerRows.filter((e) => String(e.harvestOf) === String(parentDraftId)).length;
}

export const MAX_VARIATIONS = 2;

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'TYPEFULLY_API_KEY']);
  const only = arg('account');

  // Registry: published posts with real impressions.
  const H = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  // Lifetime money columns (docs/money-columns.md). Breakouts are chosen on views, so this does
  // not change which posts are harvested, but the clicks and dollars printed here and frozen into
  // each harvest spec's `parentStats` were decaying to nothing on any parent older than 59 days.
  const fields = ['Type', 'Post', 'Account', 'Draft ID', 'Impressions', 'Lifetime Clicks', 'Affiliate Clicks', 'Lifetime Commission', 'Commission', 'Posted Date', 'X URL'];
  let recs = [], offset;
  do {
    const p = new URLSearchParams({ pageSize: '100' });
    if (offset) p.set('offset', offset);
    p.set('filterByFormula', `AND(OR({Status}="Posted",{Status}="Reposted",{Status}="Winner",{Status}="Repost Candidate"), {Impressions}>0)`);
    fields.forEach((f) => p.append('fields[]', f));
    const r = await fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(REGISTRY_TABLE)}?${p}`, { headers: H });
    const d = await r.json();
    if (d.error) throw new Error(JSON.stringify(d.error));
    recs.push(...d.records); offset = d.offset;
  } while (offset);

  const rows = harvestRows(recs).filter((r) => !only || String(r.account).toLowerCase().includes(only.toLowerCase()));

  const led = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ledByDraft = new Map(led.filter((e) => e.draftId).map((e) => [String(e.draftId), e]));

  const breakouts = findBreakouts(rows);
  console.log(`HARVEST — ${breakouts.length} breakout(s) (>=${(MIN_VIEWS / 1e3).toFixed(0)}k views, flat floor)\n`);

  const tf = typefully(env);
  const specDir = join(HERE_DIR, 'queues', 'harvest');
  if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });
  let emitted = 0;

  for (const b of breakouts) {
    const prior = harvestCount(led, b.draftId);
    const parentLed = ledByDraft.get(b.draftId);
    const flag = prior >= MAX_VARIATIONS ? `⏹ already harvested ${prior}x (max ${MAX_VARIATIONS})` : parentLed ? '' : '⚠ no ledger row (untracked parent — products unknown, still harvestable but pick products fresh)';
    console.log(`■ ${b.account.padEnd(15)} ${(b.impressions / 1e6).toFixed(2)}M (${b.multiple ? b.multiple.toFixed(1) + 'x median' : 'no median'}) · ${b.clicks} clicks · $${(b.commission || 0).toFixed(0)}  ${flag}`);
    console.log(`   ${b.title.slice(0, 86)}`);
    if (prior >= MAX_VARIATIONS) continue;

    // Pull the parent's tweets so the spec is complete without another lookup.
    const acc = Object.values(ACCOUNTS).find((a) => a.name === b.account);
    if (!acc) continue;
    let full; try { full = await tf.getDraft(acc.socialSetId, Number(b.draftId)); } catch { console.log('   ↳ draft unreadable, skipped\n'); continue; }
    const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
    if (tweets.length < 3) continue;

    const spec = {
      harvestOf: b.draftId,
      account: acc.name.toLowerCase().split(' ')[0],
      parentHook: tweets[0],
      parentUrl: b.url || null,
      parentStats: { impressions: b.impressions, clicks: b.clicks, commission: b.commission || 0 },
      bodyTweets: tweets.slice(1),
      products: parentLed ? [
        ...(parentLed.asin ? [{ asin: parentLed.asin, title: parentLed.product }] : []),
        ...(parentLed.asin2 ? [{ asin: parentLed.asin2, title: parentLed.product2 }] : []),
      ] : [],
      rules: [
        'Write a NEW hook in the 85-90% band against the PARENT hook — same shape, paraphrased inside every sentence.',
        'RE-MINT every link with a fresh subid. Never reuse the parent\'s. Same link = the child\'s revenue merges into the parent and the hook test is unreadable.',
        `Stamp harvestOf: "${b.draftId}" in the publish spec — it is what makes "did variation 2 beat the original" answerable.`,
        'Ship UNSCHEDULED via publish-thread.mjs, same as every hand-written thread.',
      ],
    };
    const file = join(specDir, `${b.draftId}.json`);
    writeFileSync(file, JSON.stringify(spec, null, 1));
    emitted++;
    console.log(`   ↳ spec: queues/harvest/${b.draftId}.json (${prior} prior variation(s))\n`);
  }
  console.log(`${emitted} spec(s) emitted. Write each variation in-session (/write-thread against the spec), then publish-thread with a fresh subid and harvestOf.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'harvest');
