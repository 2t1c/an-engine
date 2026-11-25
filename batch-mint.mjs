#!/usr/bin/env node
// batch-mint.mjs <dir> [--dry] — mint every link a folder of publish-thread specs needs, in ONE job,
// then write the links into the specs and substitute the {{LINK}} / {{LINK2}} tokens in the tweets.
//
// mint-batch.mjs already mints many links in one dispatch; what was missing was everything around it.
// Shipping 42 threads on 2026-09-03 meant deriving 84 subids, calling mint-batch, parsing its MINTED
// lines back into the right product of the right spec, and substituting tokens — done from throwaway
// scratchpad scripts that died with the container. This is that pass, kept.
//
//   node batch-mint.mjs queues/batch/2026-09-04
//   node batch-mint.mjs queues/batch/2026-09-04 --dry     # derive + report, mint nothing
//
// Three properties worth the file:
//   DETERMINISTIC   subids come from slateSubid(accountKey, hook, recId, index) — the same spec always
//                   yields the same subid, so a re-run is free rather than a second set of links.
//                   A cover's slug also carries its DAY (coverDayTag), so the same page covering the
//                   same donor on another day mints afresh instead of inheriting the first cover's links.
//   RESUMABLE       a subid already carrying a `mode: "mint"` row in the ledger is REUSED, never
//                   re-minted. Interrupt this halfway and run it again; it costs nothing.
//   ALL OR NOTHING PER SPEC  a spec whose links did not all mint keeps its tokens and is named at the
//                   end. A half-substituted thread must never reach publish-thread.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HERE_DIR } from './lib.mjs';
import { resolveAccountKey } from './accounts.mjs';
import { slateSubid } from './preflight.mjs';
import { brandLinkFor, loadLanes } from './brand-lanes.mjs';

const TOKEN = (i) => (i === 0 ? '{{LINK}}' : `{{LINK${i + 1}}}`);

/** PURE. The key a minted link is found under: the subid AND the product it was minted for.
 *
 *  WHY (2026-11-01). A subid is account + day + hook slug + index; it never names the ASIN. When the
 *  owner swapped a product on a row that had already minted (Eleanor Nov 2: BP monitor -> beet root,
 *  Camila Nov 3: second magnesium plug -> D3/K2), the subid came out the same, the ledger answered
 *  "already minted", and the new product's tweet carried the OLD product's link. Looking a link up by
 *  subid + ASIN makes a swapped product mint its own link under the same subid (the ledger keeps both
 *  rows), while an unchanged product still reuses its link. */
export const mintKey = (subid, asin) => `${subid}\t${String(asin || '').toUpperCase()}`;

/** PURE. Every mint row the ledger already holds, as mintKey(subid, asin) -> url. A later row for the
 *  same pair wins. Look links up with mintKey, never by bare subid (see mintKey for why). */
export function mintedSoFar(ledgerText) {
  const out = new Map();
  for (const line of String(ledgerText || '').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.mode === 'mint' && r.subid1 && r.link && r.asin) out.set(mintKey(r.subid1, r.asin), r.link);
  }
  return out;
}

/** PURE. What a POT plants under, in place of the donor recId a cover carries.
 *
 *  WHY (2026-09-10). slateSubid's tail is the donor recId's last 6, and a pot has no donor: its
 *  recId is undefined, so the subid reduced to a pure function of account + hook. A pot's body is
 *  the greenhouse copy VERBATIM by design, so a REPLANT on the same page reproduced the first
 *  plant's subids byte for byte, batch-mint found them in the ledger, and the second plant silently
 *  inherited the first's links. Caught on Marko's peach-muscle before it shipped: all three subids
 *  came back already minted against draft 10653344 from 2026-09-06, and the mint stage reported it
 *  as "3 already in the ledger", which reads like a saving rather than a collision.
 *
 *  A pot's verdict is measured on its own lifetime figures, so sharing a link with the previous
 *  plant makes the chance unreadable — the same reason /attempt refuses to spend a heart on a body
 *  that cannot re-mint. The day is the discriminator because a page takes at most one thread a day
 *  (laws.farm.postsPerAccountPerDay), so pot + page + day is unique per plant while staying
 *  deterministic: the same plant always derives the same subid, which is what lets the slate emit
 *  it, mint against it and paste it without drift. */
export const potPlantId = (spec) =>
  `${String(spec.potRecId || spec.potOf || 'pot')}${String(spec.day || '').replace(/-/g, '')}`;

/** PURE. The day tag a COVER carries at the head of its slug (YYMMDD), so a second cover of the same
 *  donor on the same page derives its own subids. Run 4, lorenzo 2026-09-17: the page had covered
 *  the same donor on 2026-09-06 with a different pair, account + hook + recId came out byte for byte
 *  the same, the mint stage reported "2 already in the ledger", and the -b link shipped selling the
 *  Sep-6 product. The pot branch solved the same collision with potPlantId; a cover cannot take the
 *  day in its TAIL because tracking-smoke and the archive key on the donor recId's last 6, so the
 *  day goes first in the slug instead. A page takes at most one thread a day, so page + donor + day
 *  is unique per cover while staying deterministic. No day (a hand spec) keeps the old shape. */
export const coverDayTag = (spec) => { const m = String(spec.day || '').match(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/); return m ? `${m[1]}${m[2]}${m[3]}` : ''; };

/** PURE. The subid each product of a spec will carry. Index order IS plug order: heavy first.
 *  A cover passes its donor recId through unchanged (plus the day tag above); a pot takes the plant id. */
export function subidsFor(spec) {
  const key = resolveAccountKey(spec.account);
  const hook = (spec.tweets || [])[0] || '';
  const id = spec.recId || (spec.potOf ? potPlantId(spec) : spec.recId);
  const tag = spec.recId ? coverDayTag(spec) : '';
  return (spec.products || []).map((_, i) => slateSubid(key, tag ? `${tag} ${hook}` : hook, id, i));
}

/** PURE. Substitute the tokens, and REFUSE rather than half-fill: returns { tweets, error }. */
export function substitute(tweets, products) {
  let out = (tweets || []).map(String);
  for (const [i, p] of (products || []).entries()) {
    if (!String(p.link || '').startsWith('https://')) return { tweets: null, error: `product ${i + 1} (${p.asin}) has no minted link` };
    out = out.map((t) => t.split(TOKEN(i)).join(p.link));
  }
  const left = out.filter((t) => /\{\{LINK\d*\}\}/.test(t));
  if (left.length) return { tweets: null, error: `${left.length} tweet(s) still carry a token after substitution` };
  for (const [i, p] of (products || []).entries()) {
    const n = out.filter((t) => t.includes(p.link)).length;
    if (n !== 1) return { tweets: null, error: `${p.asin} appears on ${n} tweet(s), expected exactly 1` };
  }
  return { tweets: out, error: null };
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node batch-mint.mjs <dir> [--dry]'); process.exit(2); }
  const dry = process.argv.includes('--dry');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const specs = [];
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!spec.account || !Array.isArray(spec.tweets)) continue;
    spec.products = spec.products || [];
    subidsFor(spec).forEach((s, i) => { spec.products[i].subid1 = s; });
    specs.push({ f, spec });
  }
  const ledgerPath = join(HERE_DIR, 'ledger.jsonl');
  const minted = mintedSoFar(readFileSync(ledgerPath, 'utf8'));
  // Brand-lane pages carry the brand's own link, never a Levanta mint (owner 2026-11-21, brand-lanes.mjs).
  const lanes = loadLanes();
  for (const { spec } of specs) for (const p of spec.products) {
    const b = brandLinkFor(spec.account, p.asin, lanes);
    if (b) { p.link = b.link; p.linkMode = 'brand'; p.brandLane = b.lane; }
  }
  const jobs = [];
  for (const { spec } of specs) for (const p of spec.products) if (p.linkMode !== 'brand' && !minted.has(mintKey(p.subid1, p.asin))) jobs.push({ asin: p.asin, subid: p.subid1 });
  const need = specs.reduce((n, s) => n + s.spec.products.length, 0);
  const brand = specs.reduce((n, s) => n + s.spec.products.filter((p) => p.linkMode === 'brand').length, 0);
  console.log(`${specs.length} spec(s) · ${need} link(s) · ${brand} brand link(s) · ${need - jobs.length - brand} already in the ledger · ${jobs.length} to mint`);

  if (jobs.length && !dry) {
    let out = '';
    try { out = execFileSync('node', [join(HERE_DIR, 'mint-batch.mjs'), '--jobs', JSON.stringify(jobs)], { encoding: 'utf8', cwd: HERE_DIR, maxBuffer: 1 << 24 }); }
    catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    for (const l of out.split('\n')) {
      const m = l.match(/^MINTED\t(\S+)\t(\S+)\t(\S+)/);
      if (m) minted.set(mintKey(m[2], m[1]), m[3]);
      else if (/^(FAILED|REFUSED)/.test(l) || /^ {2}(KEEP THE SUBSTANCE|No live listing)/.test(l)) console.log('  ' + l.trim());
    }
  }

  const stuck = [];
  for (const { f, spec } of specs) {
    for (const p of spec.products) { if (p.linkMode === 'brand') continue; const u = minted.get(mintKey(p.subid1, p.asin)); if (u) p.link = u; }
    const { tweets, error } = substitute(spec.tweets, spec.products);
    if (error) { stuck.push(`${basename(f)}: ${error}`); continue; }
    if (!dry) writeFileSync(join(dir, f), JSON.stringify({ ...spec, tweets }, null, 1));
    console.log(`  ${dry ? '·' : '✓'} ${basename(f).padEnd(28)} ${spec.products.map((p) => `${p.asin} ${p.link}`).join('  |  ')}`);
  }
  if (stuck.length) {
    console.log(`\n✗ ${stuck.length} spec(s) NOT ready — tokens left in place, do not publish these:`);
    for (const s of stuck) console.log(`   ${s}`);
    process.exitCode = 1;
  } else console.log(`\n✓ every spec carries live links${dry ? ' (dry — nothing written)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
