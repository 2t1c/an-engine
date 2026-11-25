// crosspost-backfill.mjs — give an already-built draft the per-platform tracked links it never got.
//
// WHY (2026-08-31). Per-platform tracking only started minting on 08-28, and only inside the CREATE
// path (recreate / publish-thread / republish). Every draft built before that carries a byte-identical
// cross-post: the same Levanta link on X and on Threads. Levanta reports on subids and never on
// referrers, so a shared link makes the two feeds physically indistinguishable — if such a draft
// publishes, its Threads clicks merge into X's and are unattributable forever. That is exactly the
// dark period that left "does anyone click from Threads" unanswerable, sitting queued to repeat.
//
// The `crossPostIntegrity` sweep found 38 Julian drafts targeting Threads: 16 clean, 22 collapsed,
// 2 diverged — 15 of the faulty ones unpublished. This backfills the ones that can be fixed.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH. A draft with no ledger products is left alone, and that is a
// decision rather than a gap: the Harvest variations (v1/v2/v3) carry the PARENT's links on purpose
// — "it mints nothing: the variations carry the parent's links, so their revenue merges into the
// parent's subid" (n8n-x-pipeline/README.md). Minting for those would fight an intentional design,
// so the sweep will keep reporting them as collapsed. That is correct. Do not "fix" it later.
//
// IT ALSO RESYNCS. crossPostLinks rebuilds the copy from X's CURRENT posts, so a draft whose copy had
// drifted comes back matching X — text, structure and, since the media pass mirrors ids, images too.
// Julian 10381538 (12 posts on X, 13 on Threads) is repaired by the same pass that mints its links.
//
// SAFE BY DEFAULT: dry unless --apply, because this mints REAL Levanta links (irreversible) and
// mutates live drafts. Idempotent — a draft whose copy already has its own links is skipped, so
// re-runs never double-mint.
//   node crosspost-backfill.mjs                     # DRY: what would be minted, and for which drafts
//   node crosspost-backfill.mjs --apply             # LIVE: mint, patch, ledger
//   node crosspost-backfill.mjs --apply --limit 1   # canary a single draft first
//   node crosspost-backfill.mjs --account julian --drafts 10504034,10381538
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { buildPlatforms, crossPostedTo } from './platforms.mjs';
import { crossPostLinks, crossPostLedgerRows } from './cross-post-links.mjs';
import { crossPostIntegrity } from './checks.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };

/**
 * Every X product a draft ever minted, gathered from its RAW ledger rows.
 *
 * Raw rows, not parseLedger's merged `byDraft`: products 3+ live on their own `attributionOnly`
 * rows, and the merged view keeps only one row's link/link2 pair — the same truncation that made
 * registry-sync report 333 of Marcos 10380538's 1,225 lifetime clicks.
 *
 * A row that already carries a `platform` stamp is skipped outright. It IS a per-platform mint, so
 * feeding it back in would mint a link for a "-th-th" subid against a link nobody ever posted.
 *
 * Deduped by subid, because a repair can restate a product it did not mint.
 * Pure. Returns [{ asin, link, subid1, title }] in the shape crossPostLinks expects.
 */
export function productsForDraft(rows) {
  const out = [], seen = new Set();
  for (const r of rows || []) {
    if (r?.platform) continue;
    for (const p of [
      { asin: r?.asin, link: r?.link, subid1: r?.subid1, title: r?.product },
      { asin: r?.asin2, link: r?.link2, subid1: r?.subid1b, title: r?.product2 || r?.product },
    ]) {
      if (!p.asin || !p.link || !p.subid1 || seen.has(p.subid1)) continue;
      seen.add(p.subid1);
      out.push({ asin: p.asin, link: p.link, subid1: p.subid1, title: p.title || '' });
    }
  }
  return out;
}

/** Does this draft's cross-post still share a link with X? The one condition worth minting for —
 *  `diverged` and `undisclosed` are real faults but neither is repaired by minting. Pure. */
export const needsBackfill = (platforms) => crossPostIntegrity(platforms).some((i) => i.kind === 'collapsed');

/** Raw ledger rows for one draft id, from the file text. draftId is written as a number by the
 *  create paths and a string by the cross-post rows, so compare stringified — the mismatch that
 *  made a naive grep miss every parent row. Pure. */
export function rowsForDraft(text, draftId) {
  const want = String(draftId), out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (String(e?.draftId ?? '') === want) out.push(e);
  }
  return out;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'LEVANTA_API_KEY']);
  const acc = getAccount(flag('account', 'julian'));
  if (!acc?.socialSetId) throw new Error('account has no socialSetId');
  const only = (flag('drafts', null) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Number(flag('limit', '0')) || Infinity;
  const tf = typefully(env);
  const ledgerText = (await import('node:fs')).readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8');

  console.log(`\n=== CROSS-POST BACKFILL · ${acc.name} · ${APPLY ? 'APPLY (live)' : 'DRY (no writes)'} ===\n`);

  const list = [];
  for (let o = 0; ; o += 50) {
    const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?limit=50&offset=${o}`);
    list.push(...(j.results || []));
    if (!j.next || !(j.results || []).length) break;
  }
  // PUBLISHED DRAFTS ARE OUT OF SCOPE. Their copy is already live under a shared link; patching the
  // draft changes nothing that was posted and the clicks are lost either way.
  const targets = list.filter((d) => d.threads_post_enabled && d.status !== 'published' && (!only.length || only.includes(String(d.id))));

  let fixed = 0, mints = 0, skippedClean = 0, skippedNoProducts = 0;
  const problems = [];
  for (const d of targets) {
    if (fixed >= limit) break;
    const full = await tf.getDraft(acc.socialSetId, d.id);
    if (!needsBackfill(full.platforms)) { skippedClean++; continue; }

    const rows = rowsForDraft(ledgerText, d.id);
    const products = productsForDraft(rows);
    // recId belongs to the LEDGER, not to Typefully — a draft object has no such field. Taking it
    // from the parent row keeps the cross-post rows joinable to the same swipe source.
    const recId = rows.find((r) => r.recId && !r.platform)?.recId || null;
    const title = String(full.draft_title || `draft ${d.id}`).slice(0, 52);
    if (!products.length) { skippedNoProducts++; console.log(`  – ${d.id}  no ledger products — left alone (Harvest variations share the parent's links by design)  ${title}`); continue; }

    const xPosts = (full.platforms?.x?.posts || []).map((p) => ({ text: p.text, media_ids: [...(p.media_ids || [])] }));
    if (!xPosts.length) { problems.push(`${d.id}: no X posts to rebuild from`); continue; }

    if (!APPLY) {
      console.log(`  → ${d.id}  would mint ${products.length}  [${products.map((p) => p.asin).join(', ')}]  ${title}`);
      mints += products.length; fixed++; continue;
    }

    try {
      const { platformPosts, minted } = await crossPostLinks(env, acc, xPosts, products);
      if (!platformPosts || !minted.length) { problems.push(`${d.id}: mint produced nothing — copy left as it was`); continue; }
      await tf.patchDraft(acc.socialSetId, d.id, {
        // Echo these back or the PATCH nulls them — the trap fix-untracked.mjs:66 already documents.
        ...(full.draft_title ? { draft_title: full.draft_title } : {}),
        ...(full.scratchpad_text ? { scratchpad_text: full.scratchpad_text } : {}),
        ...(d.scheduled_date ? { publish_at: d.scheduled_date } : {}),
        platforms: buildPlatforms(xPosts, { existing: full.platforms, account: acc, platformPosts }),
      });
      for (const row of crossPostLedgerRows(minted, { account: acc.name, draftId: d.id, recId })) {
        appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(row) + '\n');
      }
      // Re-read and re-gate: the only proof that matters is what the draft now actually holds.
      const after = await tf.getDraft(acc.socialSetId, d.id);
      const left = crossPostIntegrity(after.platforms);
      const stillCollapsed = left.some((i) => i.kind === 'collapsed');
      if (stillCollapsed) problems.push(`${d.id}: still collapsed after patch`);
      console.log(`  ${stillCollapsed ? '✗' : '✓'} ${d.id}  minted ${minted.length} → ${crossPostedTo(after.platforms).join(', ')}  ${left.length ? `(remaining: ${left.map((i) => i.kind).join(', ')})` : 'clean'}  ${title}`);
      mints += minted.length; fixed++;
    } catch (e) { problems.push(`${d.id}: ${String(e.message).slice(0, 90)}`); }
  }

  console.log(`\n${APPLY ? 'backfilled' : 'would backfill'}: ${fixed} draft(s), ${mints} mint(s)`);
  console.log(`skipped: ${skippedClean} already split · ${skippedNoProducts} no ledger products (by design)`);
  if (problems.length) { console.log(`\nPROBLEMS (${problems.length}):`); for (const p of problems) console.log(`  ! ${p}`); }
  if (!APPLY) console.log(`\nDRY — nothing minted, nothing written. Re-run with --apply to execute.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
