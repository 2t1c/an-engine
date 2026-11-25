// thread-record.mjs — every shipped thread leaves a RECORD that answers, without opening anything
// else: where did this come from, what made it, what does it sell, and what has been done to it since.
//
// Why this exists (operator 2026-08-25): "the scratchpad should become the record — so when I or you
// come in to look at it, you know exactly what created it and where it came from." The specs were
// living in the session scratchpad, which is wiped when the session ends, so the provenance of every
// thread we shipped died with the conversation that wrote it. Records go to queues/threads/ instead,
// which is committed.
//
// THE SOURCE BLOCK IS FIRST, DELIBERATELY. Operator: "the most important thing is at the very top —
// show me the original thread you used for inspiration, the link to it, and the Airtable card." JSON
// preserves key order, so opening the file puts the donor in the first screen, every time.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR, airtable } from './lib.mjs';
import { TABLES } from './config.mjs';
import { handleFromUrl } from './thread-note.mjs';

export const RECORDS_DIR = join(HERE_DIR, 'queues', 'threads');

// A card link is only useful if it opens. Airtable deep links need base + table + record, and the
// base id is env-only (it is not a secret, but it is not in the repo either), so a record written
// without it still keeps the recId — the half that never goes stale.
/**
 * fetchSource — read the donor straight from the swipe row rather than trusting whatever the
 * session happened to scrape. Fixed 2026-08-25 (operator: "the scratchpad should show the FULL hook
 * from the original"): three truncations were stacked — the scrape stored a clipped hook, the record
 * kept only its first LINE, and the renderer then capped that at 120 chars. A donor hook is
 * routinely five lines (a bpm ladder, a tricolon), so what survived was rarely the hook at all.
 * The swipe row's Text field IS the whole first tweet. Returns nulls rather than throwing: a record
 * is bookkeeping and must never be the reason a finished thread fails to ship.
 */
export async function fetchSource(recId, env) {
  if (!recId || !env?.AIRTABLE_PAT) return null;
  try {
    const f = (await airtable(env).getRecord(TABLES.swipe, recId))?.fields || {};
    return {
      hook: f.Text || null,
      url: f['Tweet URL'] || null,
      views: f.Impressions ?? null,
      author: f.Author || f.Handle || null,
      capturedAt: f['Published Date'] || null,
      niche: f.Niche || null,
    };
  } catch { return null; }
}

export function airtableCard(recId, baseId) {
  if (!recId) return null;
  return baseId ? `https://airtable.com/${baseId}/${TABLES.swipe}/${recId}` : null;
}

// Harvests table (greenhouse-draft.mjs TABLES.Harvests). A harvest or a variation descends from one
// of OUR posts, so its card is the Harvests row: a swipe card built from its recId opened nothing.
const HARVESTS_TABLE = 'tblOtEftJl2p43o6M';
function sourceCard(spec, source, baseId) {
  if (spec.variationOf || spec.harvestOf) {
    const harvestRecId = source.harvestRecId || spec.harvestRecId || null;
    return harvestRecId && baseId ? `https://airtable.com/${baseId}/${HARVESTS_TABLE}/${harvestRecId}` : null;
  }
  return airtableCard(source.recId || spec.recId, baseId);
}

// Short product codes so the money layer is legible in a filename and a draft title. Explicit map,
// not a slug function: these strings get read at a glance by a human scanning a folder, and
// "MAG+D3K2" only beats "magnesium-glycinate+vitamin-d3-k2" if it is stable and predictable.
const CODES = [
  [/threonate|magtein/i, 'THR'], [/magnesium/i, 'MAG'], [/ashwagandha|ksm-?66/i, 'ASH'],
  [/beet/i, 'BEET'], [/citrulline|nitric/i, 'NO'], [/ubiquinol|coq10/i, 'UBQ'],
  [/omega|fish oil|algae/i, 'OMEGA'], [/d3|vitamin d/i, 'D3K2'], [/zinc/i, 'ZINC'],
  [/berberine/i, 'BERB'], [/probiotic|synbiotic/i, 'PROB'], [/creatine/i, 'CREA'],
  [/collagen/i, 'COLL'], [/whey|protein/i, 'WHEY'], [/electrolyte/i, 'ELEC'],
  [/turmeric|curcumin/i, 'TURM'], [/b12|methylcobalamin/i, 'B12'], [/melatonin/i, 'MEL'],
  [/nad|nicotinamide/i, 'NAD'],
];
export const productCode = (p) => {
  const t = `${p?.title || ''} ${p?.product || ''}`;
  for (const [rx, code] of CODES) if (rx.test(t)) return code;
  return String(t).trim().split(/\s+/)[0]?.slice(0, 5).toUpperCase() || 'NA';
};
export const productCodes = (products = []) => [...new Set(products.map(productCode))].join('+') || 'NOPLUG';

// THE TITLE. The leading [lane] token is LOAD-BEARING: fill-queue only schedules drafts matching
// its WORKFLOW regex, and link-sentinel quarantines a dead-linked draft precisely by prefixing
// [dead-link] to break that match. Never reorder or rename that first token.
// Everything after it is for humans, ordered most-identifying first, because Typefully truncates:
//   [Infinity] Magnus v2 · 08-25 · MAG+D3K2 — A Stanford biology professor once told me
// The exact set fill-queue will schedule (WORKFLOW in fill-queue.mjs), plus the two quarantine
// prefixes other tools apply. Anything else is a typo that silently un-schedules a thread, so it
// throws rather than shipping a draft the queue will never pick up. Live proof this is needed: the
// first run of the record backfill passed the CONTENT lane ('viral' / 'mold' / 'repost') here and
// retitled two drafts to "[mold] …" and "[repost] …", which fill-queue does not match.
//
// Cover + Pot joined 2026-09-02 with the farm: new skill-written covers title [Cover] (old
// [Infinity] titles are never rewritten — the lanes.mjs no-rewrite law — so both stay
// schedulable), and a pot carries its seed's fruit name in the token itself, [Pot·mango], so the
// family is legible in every Typefully list without opening the note. The family is the SEED'S
// stable ID: lowercase slug, validated here for the same reason unknown lanes throw.
export const TITLE_LANES = ['Infinity', 'Cover', 'Harvest', 'Pot', 'Inspiration', 'AI Evo', 'BURNER'];
export function threadTitle({ lane = 'Cover', family = null, account, version = 1, date, products = [], hook = '', styleArm = null } = {}) {
  if (!TITLE_LANES.some((l) => l.toLowerCase() === String(lane).toLowerCase())) {
    throw new Error(`threadTitle: "${lane}" is not a schedulable lane token (${TITLE_LANES.join(' | ')}). The CONTENT lane (viral/mold/repost) goes in the record, never the title prefix.`);
  }
  let token = lane;
  if (String(lane).toLowerCase() === 'pot') {
    if (!/^[a-z0-9-]+$/.test(String(family || ''))) {
      throw new Error(`threadTitle: a Pot title needs its seed family as a lowercase slug (got "${family}") — the fruit name IS the stable ID and rides the token: [Pot·mango]`);
    }
    token = `Pot·${family}`;
  }
  const d = String(date || new Date().toISOString()).slice(5, 10); // MM-DD
  const v = Number(version) > 1 ? ` v${version}` : '';
  const head = String(hook).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 50);
  // The style pilot's build (style-pilot.mjs) rides as a second token, [Cover] [wil], so the lane
  // token every title reader matches stays first and unchanged.
  const style = styleArm ? ` [${styleArm}]` : '';
  return `[${token}]${style} ${account}${v} · ${d} · ${productCodes(products)} — ${head}`;
}

// The record's filename is the same information, so `ls queues/threads` reads like an index.
export const recordName = ({ account, date, products = [], draftId }) =>
  `${String(date || new Date().toISOString()).slice(0, 10)}-${String(account).toLowerCase().replace(/\W+/g, '')}-${productCodes(products).toLowerCase()}-${draftId}.json`;

/**
 * buildRecord — provenance FIRST, then what it is, then what it sells, then what happened to it.
 * `spec` is the publish-thread spec verbatim so the record can rebuild the thread on its own.
 */
export function buildRecord({ spec = {}, source = {}, draftId, shareUrl, lane = 'Infinity', contentLane = null, version = 1, built = {}, at, baseId }) {
  const now = at || new Date().toISOString();
  return {
    // ---- WHERE IT CAME FROM (open the file, see this first) -------------------------------------
    // kind says whose thread this came from at a glance. An outside swipe donor and one of our own
    // proven posts are both "the original", but only one has an Airtable card and only one means
    // we are reposting ourselves — a distinction that was invisible when every source looked alike.
    source: {
      kind: source.kind || (spec.variationOf || spec.harvestOf || spec.retrofitOf ? 'our own post' : spec.recId ? 'swipe donor' : spec.potOf ? 'seed pot' : 'unknown'),
      hook: source.hook || null, // VERBATIM and whole — never split, never sliced
      url: source.url || spec.sourceUrl || null,
      recId: source.recId || spec.recId || null,
      airtableCard: sourceCard(spec, source, baseId),
      // A pot has no donor: its lineage is its seed, its pot row, its greenhouse draft and the seed's
      // origin post (118 of 118 pots read "SOURCE — unknown" before these were recorded).
      ...(spec.potOf ? { seedRecId: spec.seedRecId || null, potRecId: spec.potRecId || null,
        greenhouseDraft: spec.greenhouseDraft ? String(spec.greenhouseDraft) : null, origin: spec.originPost || null } : {}),
      parentDraftId: source.parentDraftId || spec.variationOf || spec.harvestOf || spec.retrofitOf || null,
      views: source.views ?? null,
      author: source.author || null,
      capturedAt: source.capturedAt || null,
    },
    thread: {
      title: threadTitle({ lane, family: spec.potOf || null, account: spec.account, version, date: now, products: spec.products, hook: spec.tweets?.[0], styleArm: spec.styleArm || null }),
      lane, contentLane, account: spec.account, version, draftId: draftId ? String(draftId) : null, shareUrl: shareUrl || null,
      ...(spec.variationOf ? { variationOf: String(spec.variationOf) } : {}),
      moldId: spec.moldId || null, harvestOf: spec.harvestOf || null, retrofitOf: spec.retrofitOf || null, createdAt: now,
      // The farm's identity trio (2026-09-02): which generation shipped it, which seed family a
      // pot belongs to, and the seed skeleton revision it was filled from. Null on non-farm work.
      batch: spec.batch || null, potOf: spec.potOf || null, seedVersion: spec.seedVersion ?? null,
    },
    products: (spec.products || []).map((p) => ({ code: productCode(p), asin: p.asin, title: p.title, link: p.link, subid1: p.subid1 })),
    // ---- WHAT HAPPENED TO IT SINCE (append, never rewrite) --------------------------------------
    history: [{ v: version, at: now, draftId: draftId ? String(draftId) : null, what: built.what || 'first ship' }],
    // WHO WROTE IT (operator 2026-08-25). Not one of 810 ledger rows recorded this, which is exactly
    // why "is chat better than the engine" had no answer. lane is always known; model is the engine's
    // resolved id and stays null on the hand-written lane rather than being guessed.
    // Two different "lanes" and they must not be confused: thread.contentLane is what the thread IS
    // (swipe / mold / repost), writer.lane is who TYPED it (chat / engine). The first draft of this
    // used one field for both and the note read "written by swipe".
    writer: { lane: built.writerLane || (built.by === 'engine' ? 'engine' : 'chat'), model: built.model || null },
    built: { by: built.by || null, how: built.how || null, gates: built.gates || null, moves: spec.plugMoves || null },
    spec,
  };
}

export function writeRecord(record, dir = RECORDS_DIR) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, recordName({ account: record.thread.account, date: record.thread.createdAt, products: record.products, draftId: record.thread.draftId }));
  // A re-ship of the same draft APPENDS to history rather than clobbering it — the point of the
  // record is the trail, and an edit that erases the previous version defeats it.
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'));
      record.history = [...(prev.history || []), ...record.history];
      record.thread.version = record.history.length;
    } catch { /* unreadable prior record — write the fresh one rather than fail the ship */ }
  }
  writeFileSync(file, JSON.stringify(record, null, 1) + '\n');
  return file;
}

/** Every record we hold for one account, newest first — the "what has this page shipped" answer. */
export function listRecords({ account = null, dir = RECORDS_DIR } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
    .filter((f) => !account || f.includes(`-${String(account).toLowerCase().replace(/\W+/g, '')}-`))
    .sort().reverse();
}

// renderScratchpad — the record as the note that travels WITH the draft, inside Typefully, where the
// operator actually opens it. Same information, same order, laid out for eyes rather than parsers.
// Source first and unmissable: the donor hook, its link, and the Airtable card are the first thing
// on screen, because the question this answers most often is "where did this come from".
export function renderScratchpad(record) {
  const r = record || {};
  const rule = (label) => `── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`;
  const L = [];
  const s = r.source || {};
  L.push(rule(`SOURCE — ${s.kind || 'the thread this came from'}`));
  // The hook goes in WHOLE, line breaks intact. The scratchpad is a free-text field with no
  // practical limit, and this is the thing the operator opens the note to read.
  if (s.kind === 'seed pot') {
    // A pot's lineage in the order the owner traces it. No `link:` line: a pot has no donor URL.
    L.push(`  seed:       ${r.thread?.potOf || '(family not recorded)'}${r.thread?.seedVersion != null ? ` v${r.thread.seedVersion}` : ''}${s.seedRecId ? ` · ${s.seedRecId}` : ''}`);
    L.push(`  pot:        ${s.potRecId || '(pot record not recorded)'}`);
    L.push(`  greenhouse: ${s.greenhouseDraft ? `draft ${s.greenhouseDraft}` : '(not recorded)'}`);
    L.push(`  origin:     ${s.origin || '(not recorded — the seed row holds it)'}`);
  } else {
    if (s.hook) for (const line of String(s.hook).split('\n')) L.push(`  │ ${line}`);
    else L.push('  │ (hook not recorded)');
    // The handle comes from the URL when the record has no author (220 of 254 records).
    const handle = s.author || handleFromUrl(s.url);
    const by = [handle && `@${String(handle).replace(/^@/, '')}`, s.views != null && `${Number(s.views).toLocaleString()} views`].filter(Boolean).join(' · ');
    if (by) L.push(`  ${by}`);
    L.push(`  link:     ${s.url || '(none recorded)'}`);
    L.push(`  airtable: ${s.airtableCard || (s.recId ? `(recId ${s.recId} — base id not set in this run)` : '(none — not a swipe donor)')}`);
  }
  if (s.parentDraftId) L.push(`  parent:   draft ${s.parentDraftId} (one of ours)`);
  if (s.recId) L.push(`  recId:    ${s.recId}`);

  const t = r.thread || {};
  L.push('', rule('THIS THREAD'));
  L.push(`  ${t.title || ''}`);
  L.push(`  lane ${t.contentLane || '?'}${t.moldId ? ` · mold ${t.moldId}` : ''}${t.harvestOf ? ` · harvest of ${t.harvestOf}` : ''}${t.variationOf ? ` · variation of ${t.variationOf}` : ''}${t.retrofitOf ? ` · retrofit of ${t.retrofitOf}` : ''}`);
  if (t.batch || t.potOf) L.push(`  ${[t.batch && `batch ${t.batch}`, t.potOf && `family ${t.potOf}${t.seedVersion != null ? ` v${t.seedVersion}` : ''}`].filter(Boolean).join(' · ')}`);
  L.push(`  draft ${t.draftId || '?'}${t.shareUrl ? ` · ${t.shareUrl}` : ''}`);
  const b = r.built || {};
  const w = r.writer || {};
  L.push(`  written by ${w.lane || '?'}${w.model ? ` · model ${w.model}` : ''}`);
  if (b.how) L.push(`  how: ${b.how}`);
  if (b.moves) L.push(`  plug moves: ${[].concat(b.moves).join(', ')}`);
  if (b.gates) L.push(`  gates: ${b.gates}`);

  L.push('', rule('SELLS'));
  (r.products || []).forEach((p, i) => {
    L.push(`  ${i + 1}. ${String(p.code || '').padEnd(5)} ${p.asin || ''}  ${String(p.title || '').slice(0, 58)}`);
    if (p.link) L.push(`     ${p.link}`);
    if (p.subid1) L.push(`     subid ${p.subid1}`);
  });
  if (!(r.products || []).length) L.push('  (no tracked plug)');

  L.push('', rule('HISTORY — newest last, append only'));
  for (const h of r.history || []) L.push(`  v${h.v}  ${String(h.at || '').slice(0, 16).replace('T', ' ')}  ${h.what || ''}${h.draftId && h.draftId !== t.draftId ? ` (draft ${h.draftId})` : ''}`);
  return L.join('\n');
}
