#!/usr/bin/env node
// cross-post-backfill.mjs --account a,b [--platform threads] [--apply] — put a page's ALREADY
// SCHEDULED drafts onto a platform its profile was connected to after they were written.
//
// A draft's target platforms are fixed the moment it is created. `buildPlatforms` consults the
// account's crossPost list on a CREATE and never on an EDIT, because every repair tool patches with
// `{ existing }` and reading the account there would let the media pass, QC or a link swap silently
// flip a platform. Correct, and it leaves a gap: connect Threads on Wednesday and Tuesday's booked
// drafts target X alone forever. Marcos and Lucas hit exactly that on 2026-09-07, and four other
// pages carry a smaller version of it — their singles were written about 21 hours before the commit
// that gave them the config.
//
// This is the deliberate other door, and the only caller that passes `enable`.
//
//   node cross-post-backfill.mjs --account marcos,lucas --dry     # what would change, mints nothing
//   node cross-post-backfill.mjs --account marcos,lucas --apply
//   node cross-post-backfill.mjs --account marcos --only 10653835 --apply
//
// A MONEY THREAD GETS ITS OWN LINKS. Levanta reports on subids, never on referrers, so a Threads
// copy carrying X's URLs is indistinguishable from X in every report we have. crossPostLinks mints
// the "-th" twin per product and fails soft: a mint that fails leaves that platform on X's links
// rather than blocking the cross-post, because an unmeasurable post beats no post.
//
// A SINGLE HAS NO LINKS, so it is a straight copy — same text, nothing to mint, nothing to split.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, typefully, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { buildPlatforms, CROSS_POST_PLATFORMS } from './platforms.mjs';
import { crossPostLinks, crossPostLedgerRows } from './cross-post-links.mjs';

const isSingle = (t) => /^\[single\]/i.test(String(t || ''));
const isWarmup = (t) => /^\[warmup\]/i.test(String(t || ''));

/** PURE. The products a draft's links belong to, from the ledger rows for that draft. Both plugs of
 *  a roundup row count, and a link is only usable when it carries the asin and subid a mint needs. */
export function productsOf(ledgerRows, posts) {
  const text = posts.map((p) => String(p.text || '')).join('\n');
  const out = [];
  for (const r of ledgerRows || []) {
    for (const [link, asin, product, subid1] of [[r.link, r.asin, r.product, r.subid1], [r.link2, r.asin2, r.product2, r.subid1b]]) {
      if (!link || !asin || !subid1) continue;
      if (!text.includes(link)) continue;                 // the draft no longer carries it
      if (out.some((p) => p.link === link)) continue;
      out.push({ link, asin, title: product || '', subid1 });
    }
  }
  return out;
}

const TRACKED = /https:\/\/lvnta\.com\/\S+|https:\/\/gumroad\.com\/\S+/g;
const linksIn = (posts) => (posts || []).flatMap((p) => String(p.text || '').match(TRACKED) || []);

/** PURE. What this draft needs: a copy with its own links, a plain copy, a repair, or nothing.
 *
 *  A PARTIAL SPLIT IS A REPAIR, NOT A SKIP. A thread already on the platform can still be sharing
 *  one of X's links, which happens when a mint covered some products and not all — and a half-split
 *  is worse than none, because the report reads as complete while part of it silently merges into
 *  X's numbers. Marcos's three-plug pot landed exactly there on the first backfill run: two twins
 *  and one shared URL, because a roundup's third plug lives in an `attributionOnly` ledger row that
 *  the caller was filtering out. Detecting it here means a re-run heals it instead of skipping past. */
export function classify(draft, platform) {
  const title = String(draft?.draft_title || '');
  const xPosts = draft?.platforms?.x?.posts || [];
  const posts = xPosts.map((p) => String(p.text || ''));
  if (!posts.length) return { do: 'skip', why: 'no x posts' };
  if (isWarmup(title)) return { do: 'skip', why: 'warm-up: X only by design' };
  const tracked = linksIn(xPosts);
  if (draft?.platforms?.[platform]?.enabled) {
    const shared = linksIn(draft.platforms[platform].posts).filter((u) => tracked.includes(u));
    if (!shared.length) return { do: 'skip', why: `already on ${platform}` };
    return { do: 'mint', why: `on ${platform} but ${shared.length} link(s) still shared with X — partial split` };
  }
  if (isSingle(title) || !tracked.length) return { do: 'copy', why: 'no tracked link — a plain copy' };
  return { do: 'mint', why: `${tracked.length} tracked link(s) need their own twin` };
}

async function main() {
  const keys = (cliArg('account', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!keys.length) { console.error('usage: node cross-post-backfill.mjs --account a,b [--platform threads] [--only <id,...>] [--apply]'); process.exit(2); }
  const platform = cliArg('platform', 'threads');
  if (!CROSS_POST_PLATFORMS.includes(platform)) throw new Error(`${platform} is not a cross-post platform (${CROSS_POST_PLATFORMS.join(', ')})`);
  const APPLY = process.argv.includes('--apply');
  const only = new Set((cliArg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const env = loadEnv(); const tf = typefully(env);

  const lp = join(HERE_DIR, 'ledger.jsonl');
  const ledger = existsSync(lp) ? readFileSync(lp, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  // Every row this draft's links came from, EXCLUDING the cross-post twins we ourselves append.
  // Not `!attributionOnly`: a roundup's third and later plugs are written as attributionOnly rows
  // (crossPostLedgerRows names that shape), so filtering on it drops exactly the products a
  // three-plug thread needs and produces the partial split classify() now catches.
  const rowsFor = (id) => ledger.filter((r) => String(r.draftId) === String(id) && r.mode !== 'cross-post');

  let minted = 0, copied = 0, skipped = 0, failed = 0;
  for (const key of keys) {
    const acc = getAccount(key);
    if (!(acc.crossPost || []).includes(platform)) console.log(`⚠ ${key}: accounts.mjs does not list ${platform} — backfilling anyway, but new drafts will not carry it until it does\n`);
    const heads = [];
    for (let o = 0; ; o += 50) {
      const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=scheduled&limit=50&offset=${o}`);
      for (const d of (j.results || [])) heads.push(d);
      if (!j.next || !(j.results || []).length) break;
    }
    const todo = heads.filter((h) => !only.size || only.has(String(h.id)));
    console.log(`${acc.name} — ${todo.length} scheduled draft(s)`);
    for (const h of todo) {
      const draft = await tf.getDraft(acc.socialSetId, h.id);
      const what = classify(draft, platform);
      const label = `  ${String(h.id).padEnd(9)} ${isSingle(h.draft_title) ? 'single ' : 'thread '}`;
      if (what.do === 'skip') { console.log(`${label} · ${what.why}`); skipped++; continue; }
      if (draft.published_at) { console.log(`${label} ✗ already published — left alone`); skipped++; continue; }
      const when = Date.parse(draft.scheduled_date || 0);
      if (when && when - Date.now() < 15 * 60e3) { console.log(`${label} ✗ inside the 15-minute window — left alone`); skipped++; continue; }

      const posts = (draft.platforms.x.posts || []).map((p) => ({ text: String(p.text || ''), media_ids: [...(p.media_ids || [])] }));
      let platformPosts = null, mintedRows = [];
      if (what.do === 'mint') {
        const products = productsOf(rowsFor(h.id), posts);
        if (!products.length) { console.log(`${label} ✗ ${what.why}, but the ledger has no product for them — left alone`); failed++; continue; }
        if (APPLY) {
          const r = await crossPostLinks(env, acc, posts, products, { platforms: [platform] });
          platformPosts = r.platformPosts; mintedRows = r.minted;
          if (!platformPosts) { console.log(`${label} ✗ no ${platform} link minted — left alone rather than shipped with X's links`); failed++; continue; }
        }
      }
      if (!APPLY) { console.log(`${label} · would ${what.do}: ${what.why}`); what.do === 'mint' ? minted++ : copied++; continue; }
      const r = await tf.patchDraft(acc.socialSetId, h.id, {
        platforms: buildPlatforms(posts, { existing: draft.platforms, account: acc, platformPosts, enable: [platform] }),
      });
      const on = !!r?.platforms?.[platform]?.enabled;
      for (const row of crossPostLedgerRows(mintedRows, { account: acc.name, draftId: h.id, recId: rowsFor(h.id)[0]?.recId || null })) {
        appendFileSync(lp, JSON.stringify(row) + '\n');
      }
      console.log(`${label} ${on ? '✓' : '✗'} ${platform}${mintedRows.length ? ` · ${mintedRows.length} own link(s)` : ' · copy'}`);
      if (!on) failed++; else what.do === 'mint' ? minted++ : copied++;
    }
    console.log('');
  }
  console.log(`${minted} with their own links · ${copied} plain copies · ${skipped} skipped · ${failed} failed${APPLY ? '' : '  (dry — pass --apply)'}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'cross-post-backfill');
