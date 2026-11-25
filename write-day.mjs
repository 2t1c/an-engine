#!/usr/bin/env node
// write-day.mjs <sheet.json> [--out <dir>] [--force] [--dry] — a day's publish-thread specs from one sheet.
//
// The last step of a run that still came out of a scratchpad. Run 2's four days were written by
// tue-specs.mjs, wed-specs.mjs and thu-specs.mjs — three near-identical throwaway files that each
// re-implemented the same five things (paste the account's closing and disclaimer, render a backline
// pod's beats into the body, copy the product titles, keep every tweet under 280, write the spec
// JSON), lived in /tmp, and died with the container. Anything they got wrong, they got wrong three
// times, and the next run started by copying the last one.
//
// So the DAY is the input and the specs are the output. The sheet carries only what changes between
// days: which page, which donor, which pods, which products, and the body's tweets.
//
//   node write-day.mjs queues/sheets/2026-09-15.json --dry     # render + check, write nothing
//   node write-day.mjs queues/sheets/2026-09-15.json           # write the specs
//
// SHEET (one object; `rows` is the day):
//   { "day": "2026-09-15", "batch": "R2026-09-15", "out": "queues/batch/2026-09-15/2026-09-15",
//     "rows": [
//       { "key": "marko", "recId": "recXXXX", "cta": "backline", "ctaDepth": 3, "note": "…",
//         "pods": ["J2","B1"], "beats": ["J2","symptom","B1"],     // optional: render the pod beats
//         "products": ["B07NXW4GW7", "B01IQB2UYS"],                 // heavy first; titles come from products.json
//         "tweets": ["hook…", "T3", "T4", "T5", "…"] },             // "T3"/"T4"/"T5"/"T7"/"T8" are filled by `beats`
//       { "key": "julian", "pot": "peach-energy", "note": "…" }     // a pot: body from queues/pots/<name>.greenhouse.json
//     ] }
//
// What it guarantees, every time, for every row:
//   · the account's own closing and disclaimer are the last two tweets, pasted from accounts.mjs
//   · a pot's body is the greenhouse copy VERBATIM, with its pot/seed ids and its gate declarations
//     (firstPlugAt, shape, allowUnsold) carried onto the spec
//   · product titles come from products.json, never retyped
//   · every tweet is under 280 with a minted link counted at its real length, carries no em dash,
//     no unrendered beat marker and no leftover placeholder beyond the {{LINK}} tokens
//   · a spec that already exists is NEVER overwritten without --force: on a run day the file on disk
//     may already have shipped, and rewriting it silently is how a thread gets published twice.
// It writes files and nothing else: no network, no Typefully, no minting. batch-mint fills the
// tokens, ship-day runs the day.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliArg, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS, resolveAccountKey } from './accounts.mjs';
import { closingTail } from './laws.mjs';
import { styleArmIssues } from './style-pilot.mjs';
import { PODS, renderPod, variantFor } from './pods.mjs';
import { effLen } from './checks.mjs';
import { ctaSystemOf } from './lint-cover.mjs';
import { redactProvenance } from './thread-note.mjs';

export const BEAT_KEYS = ['T3', 'T4', 'T5', 'T7', 'T8'];
const LINK_TOKEN = /\{\{LINK\d?\}\}/g;

/** PURE. A tweet's length as X will count it, whether its links are still tokens or already minted.
 *  A token stands in for a real URL, and effLen counts every URL as X's fixed 23 — measuring the raw
 *  string instead reports a shipped 265-character tweet as 281 and refuses copy that is already live. */
export const specLen = (t) => effLen(String(t || '').replace(LINK_TOKEN, 'https://lvnta.com/lv_000000000000000000'));

/** PURE. Everything cheap that can be wrong with a rendered body. Same rules lint-cover enforces,
 *  run HERE so a spec is never written broken (lint-cover then has nothing to find). */
export function checkBody(tweets = []) {
  const bad = [];
  tweets.forEach((t, i) => {
    const n = specLen(t);
    if (n > 280) bad.push(`T${i + 1} is ${n} characters`);
    if (/[—–]/.test(t)) bad.push(`T${i + 1} carries an em or en dash`);
    if (/^\s*T\d\s*$/.test(t)) bad.push(`T${i + 1} is an unrendered beat marker`);
    // The {{LINK}} tokens are the ONE placeholder a spec is supposed to carry (batch-mint fills them),
    // so they come out before the leftover-placeholder test — otherwise the inner braces of {{LINK}}
    // match {LINK} and every correct pot body reads as broken.
    if (/\{[A-Z_]+\}|\[LINK\]|\[MINT\]|\{PRODUCT\}/.test(String(t).replace(LINK_TOKEN, ''))) bad.push(`T${i + 1} still carries a placeholder token`);
  });
  const links = tweets.join('\n').match(/\{\{LINK\d?\}\}/g) || [];
  return { ok: !bad.length, bad, linkTokens: [...new Set(links)] };
}

const podById = (id) => PODS.find((p) => p.id === id) || null;

/** PURE. products.json holds the full Amazon title ("Sports Research Vitamin D3 with K2 Softgels -
 *  Plant Based K2 & Vegan D3 5000iu with Coconut MCT Oil - Vegan Certified, Soy & Gluten Free - 120
 *  Count"). The spec's title is read by a human in the day's receipt, so it keeps the first clause
 *  and nothing else. Trimming never INVENTS: it only cuts, so what remains is still the label. */
export function shortTitle(title, max = 64) {
  const first = String(title || '').split(/\s+[-–—]\s+|,\s/)[0].trim();
  return (first.length > max ? first.slice(0, max).replace(/\s+\S*$/, '') : first) || String(title || '').slice(0, max);
}

/** The five beats a backline pair renders into a cover body: the heavy pod's point, bridge and plug,
 *  then the light pod's bridge and compact plug. THROWS when a pod cannot speak on this page — that
 *  is pool-probe's `pairFit` failing at write time, and it must stop the write, not degrade it. */
export function beats(key, heavyPod, frame, lightPod, ctaOverride = null, { system = 'backline' } = {}) {
  const a = renderPod(podById(heavyPod), key, '{{LINK}}', { frame, itemNumber: 2, system });
  const v = variantFor(podById(lightPod), key, { system });
  if (!a?.point || !a.bridge || !a.plug) throw new Error(`pod ${heavyPod} has no ${system} beats for ${key}`);
  if (!v?.bridge || !v?.light) throw new Error(`pod ${lightPod} has no ${system} light variant for ${key}`);
  const cta = `${String(ctaOverride || v.light.cta).replace(/:\s*$/, '')}:`;
  return { T3: a.point, T4: a.bridge, T5: a.plug, T7: v.bridge, T8: `${v.light.opener}\n\n${v.light.middle}\n\n${cta}\n\n{{LINK2}}` };
}

/** PURE. The lineage a sheet row carries through to its spec, only where the row names it. */
export function lineageFields(row = {}) {
  const out = {};
  // A spec is committed under queues/batch, so an inline provenance loses the donor's text here; pass
  // { file, rowId } (the run's provenance.json, outside the repo) to keep the donor thread in the note.
  if (row.provenance && typeof row.provenance === 'object') out.provenance = redactProvenance(row.provenance);
  // The donor's own text never reaches a committed spec: only tweet counts and hashes survive.
  if (row.source && typeof row.source === 'object') {
    if (!Object.hasOwn(row.source, 'donorTweets')) out.source = row.source;
    else {
      const { donorTweets, ...source } = row.source;
      out.source = { ...source, donorTweetCount: Array.isArray(donorTweets) ? donorTweets.length : 0 };
    }
  }
  for (const k of ['sourceUrl', 'reviewDraftId', 'variationOf', 'harvestOf', 'contentLane']) if (row[k] != null && row[k] !== '') out[k] = String(row[k]);
  return out;
}

/** PURE. One sheet row -> the publish-thread spec, or throws with the row named.
 *  `titles` is asin -> title (products.json), `pot` the greenhouse body when the row is a pot. */
export function buildSpec(row = {}, { day, batch, account, titles = {}, pot = null } = {}) {
  const key = resolveAccountKey(row.key) || row.key;
  if (!account) throw new Error(`${key}: not an account in accounts.mjs`);
  // The style pilot's build (style-pilot.mjs): a known build, on a cover, and the full build sells one product.
  const style = styleArmIssues({ styleArm: row.styleArm, arm: row.arm, potOf: pot ? (pot.potOf || row.pot) : null, harvestOf: row.harvestOf });
  if (style.length) throw new Error(`${key}: ${style.join('; ')}`);
  if (pot) {
    // The close is the account's, never the body's: the disclaimer, plus the sign-off only while
    // laws.json signOff is on (owner R2026-09-26: "Content, then the disclaimer").
    const tweets = [...(pot.tweets || []), ...closingTail(account)];
    return {
      day, key, account: key, batch, potOf: pot.potOf, seedRecId: pot.seedRecId, potRecId: pot.potRecId,
      seedVersion: pot.seedVersion, ctaDepth: pot.ctaDepth ?? 2,
      greenhouseDraft: pot.greenhouseDraft ? String(pot.greenhouseDraft) : null,
      // A POT KEEPS THE SHEET'S LABEL. Its body is the greenhouse copy verbatim and its CTA is the
      // seed's, so there is no writer choosing a system here for the derivation below to check.
      ...(row.cta ? { cta: row.cta } : {}),
      // THE BODY'S GATE DECLARATIONS RIDE WITH IT (2026-09-23). publish-thread and gate-thread read
      // firstPlugAt/shape/allowUnsold off the SPEC, and firstPlugAt and shape are the only things that
      // loosen the first-plug window. Every yarrow body declares firstPlugAt 5 (the origin's first paid
      // instruction plugs there), so dropping it here refused a body that passes every gate — the
      // R2026-09-23 yarrow spec had to be patched by hand outside the repo to ship.
      ...(pot.firstPlugAt != null ? { firstPlugAt: pot.firstPlugAt } : {}),
      ...(pot.shape ? { shape: pot.shape } : {}),
      ...(pot.allowUnsold ? { allowUnsold: pot.allowUnsold } : {}),
      ...(pot.originPost ? { originPost: String(pot.originPost) } : {}),
      ...lineageFields(row),
      note: row.note || `Pot planted from the greenhouse body ${row.pot}. Text is the greenhouse copy verbatim; the account, its closing tweets and fresh links are the only additions.`,
      products: (pot.products || []).map((p) => ({ asin: p.asin, title: p.title })),
      tweets,
    };
  }
  const asins = row.products || [];
  // A one-CTA cover (arm 'single-cta', owner R2026-09-26: "1 CTA per thread ONLY") carries one
  // product and no light slot; every other cover still needs both.
  if (asins.length < 2 && row.arm !== 'single-cta') throw new Error(`${key}: a cover needs a heavy and a light product`);
  const products = asins.map((asin) => {
    const title = titles[asin];
    if (!title) throw new Error(`${key}: ${asin} is not in products.json — add it or fix the sheet`);
    return { asin, title: shortTitle(title) };
  });
  let body = [...(row.tweets || [])];
  if (row.beats) {
    const b = beats(key, row.beats[0], row.beats[1], row.beats[2], row.beats[3]);
    body = body.map((t) => (b[String(t).trim()] ? b[String(t).trim()] : t));
  }
  const tweets = [...body, ...closingTail(account)];
  return {
    day, key, account: key, recId: row.recId || null, batch, ctaDepth: row.ctaDepth ?? 3,
    // THE LABEL IS DERIVED, NEVER DECLARED (2026-09-18). `cta` used to be whatever the sheet row
    // typed, checked against nothing, so a spec could claim one system while its plugs were written
    // in another — ten of Run 5's specs carried exactly that drift after their CTAs were converted.
    // publish-thread has always stamped the LEDGER from the text (ctaSystemOf), so the spec now
    // agrees with the ledger by construction. The row's label survives only for a body with no plug
    // for ctaSystemOf to read, where there is nothing to derive from.
    cta: ctaSystemOf(tweets) || row.cta || 'fresh',
    note: row.note || '',
    ...(row.hookDrift ? { hookDrift: row.hookDrift } : {}),
    ...(row.allowUnsold ? { allowUnsold: row.allowUnsold } : {}),
    ...(row.swapPromise ? { swapPromise: true } : {}),
    // CARRIED THROUGH, because publish-thread and the linters read them off the SPEC and this is the
    // only thing that writes one. `lane` is the load-bearing one: publish-thread derives its hook
    // lane from `spec.lane === 'remix'`, so a dropped lane silently demotes all fifteen of Run 5's
    // remixes to covers and refuses them on coverFloor — a lane that cannot ship through the only
    // supported spec writer. `hookSim` matters for the opposite reason: a blank one on a cover is now
    // a refusal rather than a warning, so losing it here would turn every cover into one.
    ...(row.lane ? { lane: row.lane } : {}),
    ...(row.remixOf ? { remixOf: row.remixOf } : {}),
    ...(row.hookSim != null ? { hookSim: row.hookSim } : {}),
    // The cover-as-pot ticket (laws.json farm.$coverAsPot): which dials this cover turned away from its donor.
    ...(Array.isArray(row.dials) ? { dials: row.dials } : {}),
    ...(Array.isArray(row.allowItems) && row.allowItems.length ? { allowItems: row.allowItems } : {}),
    ...(row.weld ? { weld: row.weld } : {}),
    ...(row.podNote ? { podNote: row.podNote } : {}),
    ...(row.productTest ? { productTest: row.productTest } : {}),
    // /run lineage (plan R2): publish-thread renders the source note from `provenance`, adopts the
    // [REVIEW] draft named by `reviewDraftId`, and reads donor/lineage/lane off the spec. A sheet
    // row that drops them ships a second draft with no note, or a harvest recorded as a cover.
    ...lineageFields(row),
    pods: row.pods || [],
    heavy: products[0].asin, light: products[1]?.asin ?? null, heavyTitle: products[0].title, lightTitle: products[1]?.title ?? null, ...(row.arm ? { arm: row.arm } : {}),
    ...(row.styleArm ? { styleArm: row.styleArm } : {}),
    products, tweets,
  };
}

/** PURE. Where a row's spec belongs: <out>/<key>.json, or <key>-pot.json for a pot. */
export const specPath = (row, outDir) => join(outDir, `${resolveAccountKey(row.key) || row.key}${row.pot ? '-pot' : ''}.json`);

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node write-day.mjs <sheet.json> [--out <dir>] [--force] [--dry]'); process.exit(2); }
  const DRY = process.argv.includes('--dry'), FORCE = process.argv.includes('--force');
  const sheet = JSON.parse(readFileSync(file, 'utf8'));
  const day = sheet.day, batch = sheet.batch;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error(`${file}: "day" must be YYYY-MM-DD`);
  if (!batch) throw new Error(`${file}: "batch" is required (R<YYYY-MM-DD>) — it stamps every thread's record`);
  const outDir = resolve(HERE_DIR, cliArg('out', null) || sheet.out || join('queues', 'batch', String(batch).replace(/^R/, ''), day));
  const titles = Object.fromEntries((JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || []).map((p) => [p.asin, p.title]));

  console.log(`${file} — ${day} · ${batch} · ${(sheet.rows || []).length} row(s) -> ${outDir.replace(HERE_DIR + '/', '')}${DRY ? ' (dry)' : ''}`);
  const written = [], skipped = [], failed = [];
  for (const row of sheet.rows || []) {
    const key = resolveAccountKey(row.key) || row.key;
    try {
      const pot = row.pot ? JSON.parse(readFileSync(join(HERE_DIR, 'queues', 'pots', `${row.pot}.greenhouse.json`), 'utf8')) : null;
      const spec = buildSpec(row, { day, batch, account: ACCOUNTS[key], titles, pot });
      const check = checkBody(spec.tweets);
      const path = specPath(row, outDir);
      const rel = path.replace(HERE_DIR + '/', '');
      if (!check.ok) { failed.push({ key, why: check.bad.join(' · ') }); console.log(`  ✗ ${key.padEnd(9)} ${check.bad.join(' · ')}`); continue; }
      if (existsSync(path) && !FORCE) { skipped.push(key); console.log(`  · ${key.padEnd(9)} ${rel} exists — not overwritten (it may already have shipped; --force to replace)`); continue; }
      const longest = Math.max(...spec.tweets.map(specLen));
      console.log(`  ${DRY ? '·' : '✓'} ${key.padEnd(9)} ${String(spec.tweets.length).padStart(2)} tweets · longest ${longest} · ${check.linkTokens.join('+') || 'no link token'} · ${spec.potOf ? `pot ${spec.potOf}` : `${spec.heavy}→${spec.light}`}`);
      if (!DRY) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(spec, null, 1) + '\n'); }
      written.push(key);
    } catch (e) { failed.push({ key, why: e.message }); console.log(`  ✗ ${key.padEnd(9)} ${e.message}`); }
  }
  console.log(`\n${written.length} ${DRY ? 'would be written' : 'written'} · ${skipped.length} left alone · ${failed.length} failed`);
  if (failed.length) { console.log('fix the sheet and run again — nothing partial was written for a failed row.'); process.exitCode = 1; return; }
  if (!DRY && written.length) console.log(`next: node batch-mint.mjs ${outDir.replace(HERE_DIR + '/', '')} && node ship-day.mjs <plan> ${day}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'write-day');
