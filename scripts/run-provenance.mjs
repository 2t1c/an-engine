#!/usr/bin/env node
// Assemble one `thread-provenance-v1` object per /run row, OFFLINE, from what the run directory
// already holds: the run-studio approvals (state.json), the cover selection plan and its picker
// snapshots, the products plan (with the Jev product-fit readings when it was built with --jev), the
// drafts spec and packet plan, the review-drafts ledger and, once the calendar exists, the slot.
// thread-note.mjs renders it into the note on the [REVIEW] draft and, at adoption, the shipped one.
//
// No network, no provider, no model. Anything that cannot be read becomes
// { status: 'not read', reason } — never a zero, never an empty list that looks complete.
//
// The output holds the donor's full text (the note shows it), so like every private /run artifact
// it must live OUTSIDE the repository; the CLI refuses a path inside it. The repo itself only ever
// keeps tweet numbers and shas of donor text (scripts/cover-source-breadth.mjs:1-3).
//
//   node scripts/run-provenance.mjs --run-dir RUN_DIR --run-id R2026-09-25 --input /outside/drafts-spec.json \
//     [--selection-plan P] [--products-plan P] [--drafts-plan P] [--slots P] [--output RUN_DIR/provenance.json]
import { existsSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tweetsFromRollup, substanceTermsFor } from '../checks.mjs';
import { checkHook } from '../hooks-check.mjs';
import { handleFromUrl, notRead, PROVENANCE_SCHEMA } from '../thread-note.mjs';
import { status as studioStatus } from './run-studio.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWIPE_TABLE = 'tblS9wU39UjUVSsvl';      // config.mjs TABLES.swipe
const HARVESTS_TABLE = 'tblOtEftJl2p43o6M';   // greenhouse-draft.mjs TABLES.Harvests
const SEEDS_TABLE = 'tblk4GH77DQPh2AFq';      // greenhouse-draft.mjs TABLES.Seeds
const POTS_TABLE = 'tblJg81qkmj1t3eRi';       // greenhouse-draft.mjs TABLES.Pots
const text = (v) => (v == null ? '' : String(v).trim());
const card = (baseId, table, recId) => (recId ? (baseId ? `https://airtable.com/${baseId}/${table}/${recId}` : null) : null);

/** Every stop's verdict for one row, from run-studio's own verification (stale snapshots show as
 *  stale). The owner's words are never copied — only the verdict, when and which revision. */
export function approvalsFor(runDir, rowId) {
  let rows;
  try { rows = studioStatus(runDir); } catch (error) { return notRead(`run-studio state unreadable: ${error.message}`); }
  let raw = {};
  try { raw = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')); } catch { /* recordedAt stays null */ }
  return rows.map((stage) => {
    if (stage.mode === 'rows') {
      const row = (stage.rows || []).find((r) => r.id === rowId);
      if (!row) return { stage: stage.stage, status: stage.rows ? 'not submitted' : stage.status };
      const entry = raw.rowStages?.[stage.stage]?.rows?.[rowId] || {};
      const consent = entry.approval || entry.hold || null;
      return { stage: stage.stage, status: row.status === 'held' && entry.hold?.kind ? `held (${entry.hold.kind})` : row.status,
        revision: row.revision || null, recordedAt: consent?.recordedAt || null, ...(row.reason ? { reason: row.reason } : {}) };
    }
    return { stage: stage.stage, status: stage.status, revision: stage.revision || null,
      recordedAt: raw.stages?.[stage.stage]?.approval?.recordedAt || null, ...(stage.reason ? { reason: stage.reason } : {}) };
  });
}

/** The donor's tweets for a cover: the drafts spec wins, then the verified picker snapshot. */
function donorTweetsFor(row, selected, snapshotRecords) {
  if (Array.isArray(row.source?.donorTweets) && row.source.donorTweets.length) return { tweets: row.source.donorTweets.map(String) };
  if (Array.isArray(row.donor?.tweets) && row.donor.tweets.length) return { tweets: row.donor.tweets.map(String) };
  const recId = text(selected?.recId || row.source?.id);
  if (!snapshotRecords) return notRead('no selection plan snapshot supplied');
  const record = recId ? snapshotRecords.get(recId) : null;
  if (!record) return notRead(recId ? `donor ${recId} is not in the selection snapshot` : 'no donor record id on the row');
  const tweets = tweetsFromRollup(record.fields?.['Full Thread Text']);
  return tweets.length ? { tweets } : notRead(`donor ${recId} has no Full Thread Text in the snapshot`);
}

function sourceFor(row, selected, { baseId }) {
  const lane = text(row.lane).toLowerCase();
  const s = row.source || {};
  if (lane === 'pot' || lane === 'seed' || s.potOf || row.potOf) {
    const seedRecId = text(s.seedRecId || row.seedRecId) || null, potRecId = text(s.potRecId || row.potRecId) || null;
    return { kind: 'seed pot', seed: { family: text(s.potOf || row.potOf) || null, version: s.seedVersion ?? row.seedVersion ?? s.contractVersion ?? null,
      recId: seedRecId, card: card(baseId, SEEDS_TABLE, seedRecId) }, potRecId, potCard: card(baseId, POTS_TABLE, potRecId),
      greenhouseDraft: text(s.greenhouseDraft || row.greenhouseDraft) || null,
      origin: text(s.originPost || s.url) || notRead('no origin post on the row; the seed row holds it') };
  }
  if (lane === 'harvest' || s.harvestOf || s.variationOf) {
    const harvestRecId = text(s.harvestRecId || s.id) || null;
    const variation = s.variation === true || !!s.variationOf;
    return { kind: 'our own post', url: text(s.url) || null, handle: handleFromUrl(s.url),
      parentDraftId: text(s.variationOf || s.harvestOf) || null,
      ...(variation ? { variationOf: text(s.variationOf || s.harvestOf) || null } : { harvestOf: text(s.harvestOf) || null }),
      harvestRecId, card: card(baseId, HARVESTS_TABLE, harvestRecId), hook: text(s.hook) || null };
  }
  const url = text(s.url || selected?.url) || null;
  const recId = text(s.id || selected?.recId) || null;
  return { kind: lane === 'remix' ? 'remix donor' : 'swipe donor', url, ...(url ? {} : { urlReason: 'neither the drafts spec nor the selection row names the donor URL' }),
    handle: text(selected?.sourceCreator) || handleFromUrl(url), recId, card: card(baseId, SWIPE_TABLE, recId),
    views: selected?.views ?? null, publishedDate: selected?.publishedDate || null, hook: text(s.hook || selected?.hook) || null };
}

function productsFor(row, productsRow, products) {
  const drafted = Array.isArray(row.draft?.products) ? row.draft.products : null;
  if (!drafted && !productsRow) return notRead('neither the drafts spec nor the products plan lists products');
  const placements = productsRow?.placements || [];
  const pods = Array.isArray(row.draft?.pods) ? row.draft.pods : Array.isArray(row.pods) ? row.pods : [];
  const catalog = new Map((products || []).map((p) => [p.asin, p]));
  const list = drafted || placements.map((p) => ({ asin: p.asin, title: p.title }));
  const jevCandidates = productsRow?.jev?.status === 'ok' ? productsRow.jev.candidates || [] : [];
  return list.map((p, i) => {
    const placed = placements.find((x) => x.asin === p.asin) || null;
    const title = text(p.title || placed?.title || catalog.get(p.asin)?.title) || null;
    const pod = pods[i] ? (typeof pods[i] === 'string' ? pods[i] : pods[i].id || null) : null;
    return { placement: placed?.placement || (i === 0 ? 'heavy' : i === 1 ? 'light' : `extra-${i + 1}`), asin: p.asin || null, title,
      link: text(p.link) || null, subid1: text(p.subid1) || null, pod,
      ...(Number.isSafeInteger(p.plugTweet) ? { plugTweet: p.plugTweet } : {}), ...(Number.isSafeInteger(p.bridgeTweet) ? { bridgeTweet: p.bridgeTweet } : {}),
      epc: placed?.epc ? { status: placed.epc.status, value: placed.epc.value, clicks: placed.epc.clicks, orders: placed.epc.orders, window: placed.epc.window }
        : notRead(productsRow ? `${p.asin} is not a placement in the products plan` : 'no products plan supplied'),
      why: text(placed?.need || p.need || p.why) || null,
      label: jevCandidates.find((c) => c.asin === p.asin)?.label || null,
      terms: substanceTermsFor({ asin: p.asin, title: title || '' }) };
  });
}

function jevFor(productsRow) {
  if (!productsRow) return notRead('no products plan supplied');
  if (!productsRow.jev) return notRead('the products plan was built without --jev');
  const j = productsRow.jev;
  if (j.status !== 'ok') return { status: j.status, reason: j.reason || j.code || 'unavailable' };
  return { status: 'ok', model: j.model || null, anySupplement: j.anySupplement ?? null, agrees: !!j.agrees, notes: j.notes || [],
    candidates: (j.candidates || []).map((c) => ({ asin: c.asin, label: c.label, noul: c.noul ?? null,
      ...(Number.isSafeInteger(c.pointer) ? { pointer: c.pointer } : {}) })) };
}

function hookFor(row, source, tweets) {
  const original = text(row.source?.hook || source?.hook);
  if (!tweets[0]) return notRead('no copy to measure');
  if (!original) return { check: notRead('no donor hook to measure against'), structure: text(row.hook?.structure) || null };
  let check;
  try {
    const c = checkHook(tweets[0], original, { lane: text(row.lane).toLowerCase() || 'cover', hookDrift: row.hook?.hookDrift || null, swapPromise: !!row.hook?.swapPromise });
    check = { sim: c.sim, ok: c.ok, band: c.band || null, issue: c.issue || null };
  } catch (error) { check = notRead(`hook check failed: ${error.message}`); }
  return { check, structure: text(row.hook?.structure) || null };
}

/**
 * PURE (given its inputs). One row → thread-provenance-v1. `stops` comes from approvalsFor; the
 * plan rows are the matching rows of each plan file, or null when that file was not supplied.
 */
export function assembleProvenance({ runId, row, stops = null, selectionRow = null, productsRow = null, draftsPlanRow = null,
  ledgerEntry = null, slot = null, snapshotRecords = null, products = [], baseId = null } = {}) {
  if (!row?.id) throw new Error('row.id is required');
  const tweets = Array.isArray(row.draft?.tweets) ? row.draft.tweets.map(String) : [];
  const selected = selectionRow?.selected || null;
  const source = sourceFor(row, selected, { baseId });
  const lane = text(row.lane).toLowerCase();
  const donor = source.kind === 'swipe donor' || source.kind === 'remix donor'
    ? donorTweetsFor(row, selected, snapshotRecords)
    : Array.isArray(row.source?.tweets) && row.source.tweets.length ? { tweets: row.source.tweets.map(String) }
      : notRead(source.kind === 'seed pot' ? 'a pot has no donor thread; its seed origin is above' : 'no source body on the row');
  const editorial = row.draft?.editorialReview;
  const media = Array.isArray(row.draft?.media) && row.draft.media.length
    ? { items: row.draft.media.map((m) => ({ tweet: m.tweet, source: text(m.source) })) }
    : row.draft?.noMediaReason ? { items: [], noMediaReason: text(row.draft.noMediaReason) } : notRead('no media mapping or no-media reason on the row');
  return {
    schema: PROVENANCE_SCHEMA, runId: runId || null, rowId: row.id, account: row.account || null, lane: lane || null, date: row.date || null,
    source, donor, products: productsFor(row, productsRow, products), jev: jevFor(productsRow),
    slot: slot || null,
    hook: hookFor(row, source, tweets),
    claims: Array.isArray(row.draft?.claims) ? row.draft.claims : [],
    media,
    review: {
      stops: Array.isArray(stops) ? stops : [],
      ...(stops && !Array.isArray(stops) ? { stopsNotRead: stops } : {}),
      packet: draftsPlanRow ? { status: draftsPlanRow.status, holds: draftsPlanRow.holds || [], reviews: draftsPlanRow.reviews || [], contentSha256: draftsPlanRow.contentSha256 || null }
        : notRead('no drafts packet plan supplied'),
      editorial: editorial ? { reviewer: text(editorial.reviewer), verdict: text(editorial.verdict), contentSha256: text(editorial.contentSha256), notes: text(editorial.notes) }
        : notRead('no editorial review on the row'),
    },
    history: Array.isArray(ledgerEntry?.history) ? ledgerEntry.history : [],
  };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
function snapshotRecordsOf(selectionPath, selection) {
  if (!selection?.sources?.length) return null;
  const records = new Map();
  for (const source of selection.sources) {
    try {
      const snap = readJson(resolve(dirname(selectionPath), source.path));
      for (const r of snap.records || []) records.set(r.id, r);
    } catch { /* a missing snapshot leaves its donors "not read" */ }
  }
  return records;
}

/** Everything for a run, read from files. Plans are optional; each missing one is "not read". */
export function provenanceFromRunDir({ runDir, runId, spec, selectionPlan = null, productsPlan = null, draftsPlan = null, slots = null,
  products = null, baseId = null }) {
  const byId = (plan) => new Map((plan?.rows || []).map((r) => [r.id, r]));
  const selection = selectionPlan ? readJson(selectionPlan) : null;
  const selectionRows = byId(selection);
  const productRows = byId(productsPlan ? readJson(productsPlan) : null);
  const draftRows = byId(draftsPlan ? readJson(draftsPlan) : null);
  const slotMap = slots ? readJson(slots) : {};
  const ledgerFile = join(runDir, 'review-drafts.json');
  const ledger = existsSync(ledgerFile) ? readJson(ledgerFile) : {};
  const records = selection ? snapshotRecordsOf(selectionPlan, selection) : null;
  const catalog = products || (existsSync(join(ROOT, 'products.json')) ? readJson(join(ROOT, 'products.json')).products : []);
  const out = {};
  for (const row of spec.rows || []) {
    const slotRow = slotMap?.[row.id] || row.slot || null;
    out[row.id] = assembleProvenance({ runId, row, stops: approvalsFor(runDir, row.id), selectionRow: selectionRows.get(row.id) || null,
      productsRow: productRows.get(row.id) || null, draftsPlanRow: draftRows.get(row.id) || null, ledgerEntry: ledger[row.id] || null,
      slot: slotRow, snapshotRecords: records, products: catalog, baseId });
  }
  return out;
}

function outsideRepo(target) {
  let anchor = resolve(target);
  while (!existsSync(anchor)) anchor = dirname(anchor);
  const real = realpathSync(anchor), root = realpathSync(ROOT);
  if (real === root || real.startsWith(root + sep)) throw new Error('provenance holds donor text and belongs outside the repository');
  return resolve(target);
}

function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const runDir = flag('run-dir'), runId = flag('run-id'), input = flag('input');
  if (!runDir || !runId || !input) throw new Error('Usage: run-provenance.mjs --run-dir DIR --run-id ID --input drafts-spec.json [--selection-plan P] [--products-plan P] [--drafts-plan P] [--slots P] [--output P]');
  const output = outsideRepo(flag('output') || join(runDir, 'provenance.json'));
  const all = provenanceFromRunDir({ runDir: resolve(runDir), runId, spec: readJson(resolve(input)),
    selectionPlan: flag('selection-plan') && resolve(flag('selection-plan')), productsPlan: flag('products-plan') && resolve(flag('products-plan')),
    draftsPlan: flag('drafts-plan') && resolve(flag('drafts-plan')), slots: flag('slots') && resolve(flag('slots')),
    baseId: process.env.XDB_BASE_ID || null });
  const temp = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schema: 'run-provenance-v1', runId, rows: all }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, output);
  const notReadCount = Object.values(all).reduce((n, p) => n + Object.values(p).filter((v) => v?.status === 'not read').length, 0);
  return { output, rows: Object.keys(all).length, notRead: notReadCount };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
