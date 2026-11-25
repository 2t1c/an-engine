#!/usr/bin/env node
// Read-only review packets for the collaborative /run hooks and drafts stages.
// The existing hook and thread gates supply verdicts; owner approval remains in run-studio.
// A run walks five stops by default: the drafts stop binds to the approved PRODUCTS row and runs the
// hook-fidelity gate itself, because there is no hooks stop in front of it (run-studio MERGED_FLOW).
// A six-stop run (init --with-hooks) keeps the separate hooks stop, and drafts bind to it as before.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHook } from '../hooks-check.mjs';
import { gateThread } from '../gate-thread.mjs';
import { coverTicketIssues, coverBodyIssues } from '../pot-gate.mjs';
import { isCraftGateIssue } from '../craft-gates.mjs';
import { jevTwinsFor, rowRuleIssues, runAcceptedTwins, runContentRules, runPins, runTwinIssues } from './run-rules.mjs';
import { jevLines, readingsFor } from './run-jev.mjs';
import { checkRow, flowOf } from './run-studio.mjs';
import { approvedCalendar, slotBinding } from './run-calendar.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { laneOf } from '../lanes.mjs';
import { decisionConfig } from '../jev-decide.mjs';
import { LAWS } from '../laws.mjs';
import { closingTexts, disclaimerTexts } from '../content/text-shape.mjs';
import { editsPolicyOf, normalizedCopySha256, spacingCopySha256 } from '../copy-change.mjs';
import { leadLine, listOf, swapBack, swapToFront } from '../lead-item.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROOT = realpathSync(ROOT);
const SHA = value => createHash('sha256').update(value).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const text = value => String(value ?? '').trim();
const q = value => JSON.stringify(value ?? '');
// The page sign-off is not the body. /attempt repairs it on a cross-page repost (the gate demands the
// target page's own closing and disclaimer last), so trailing closing/disclaimer/site lines of ANY page
// are dropped before the word-for-word comparison; everything above them must still match exactly.
const SIGN_OFF = new Set(Object.values(ACCOUNTS).flatMap(a => [...closingTexts(a), ...disclaimerTexts(a), a?.siteCta])
  .filter(Boolean).map(t => String(t).trim()));
export function withoutSignOff(tweets) {
  const out = [...tweets];
  while (out.length && SIGN_OFF.has(String(out.at(-1)).trim())) out.pop();
  return out;
}
const neutralLinks = tweet => String(tweet)
  .replace(/https?:\/\/(?:www\.)?lvnta\.com\/lv_[A-Za-z0-9]+/gi, '<TRACKING_LINK>')
  .replace(/\{\{LINK\d*\}\}/g, '<TRACKING_LINK>');
/** How much of a harvest body changed, in words (laws.json farm.harvestEditMax says how the owner's
 *  "less than 5%" is measured). Tracking links are neutral, the page sign-off is left out, and a tweet
 *  break is a word, so moving text between tweets counts as change. */
export function harvestEdit(sourceTweets, tweets) {
  const words = list => withoutSignOff(list).map(neutralLinks)
    .flatMap((tweet, i) => [...(i ? ['¶'] : []), ...tweet.split(/\s+/).filter(Boolean)]);
  const a = words(sourceTweets), b = words(tweets);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  const changed = prev[b.length];
  return { changed, sourceWords: a.length, share: changed / Math.max(1, a.length),
    hookSame: neutralLinks(sourceTweets[0] ?? '') === neutralLinks(tweets[0] ?? '') };
}
/** The source a verbatim harvest is measured against. When the drafts step moved the lead item
 *  (scripts/run-lead-item.mjs; owner, 2026-09-28: "every numbered first tweet should have it
 *  implemented."), the source is swapped the same way, so a reorder that keeps every word is not an edit:
 *  the item that moved is found by its old number, and its name must still match. */
export function leadSource(sourceTweets, lead) {
  if (!lead?.moved || !Number.isFinite(lead.from)) return sourceTweets;
  const list = listOf(sourceTweets);
  const index = list.items ? list.items.findIndex((it) => it.n === lead.from) : -1;
  if (index < 1) return sourceTweets;
  const words = (s) => new Set(String(s).toLowerCase().split(/\W+/).filter(Boolean));
  const a = words(list.items[index].name), b = words(lead.name);
  const shared = [...a].filter((w) => b.has(w)).length;
  if (shared / Math.max(1, Math.max(a.size, b.size)) < 0.6) return sourceTweets;
  return swapToFront(sourceTweets, list, index, { keepFirstLink: false }) || sourceTweets;
}
const HARVEST_EDIT_MAX = LAWS.farm?.harvestEditMax ?? 0;
/** The owner's harvest rule as holds and reviews: identical (links and sign-off aside) passes; an edit
 *  under the bar with the hook unchanged is put to the owner with its size; anything more is held. */
function harvestEditIssues(sourceTweets, tweets, against = 'the source') {
  const edit = harvestEdit(sourceTweets, tweets);
  if (!edit.changed) return { holds: [], reviews: [] };
  const pct = (edit.share * 100).toFixed(1), max = +(HARVEST_EDIT_MAX * 100).toFixed(1);
  if (!edit.hookSame) return { holds: [`Harvest hook differs from ${against}; a harvest keeps its hook (an edited hook makes it a variation)`], reviews: [] };
  if (edit.share >= HARVEST_EDIT_MAX) return { holds: [`Harvest body differs from ${against} by ${pct}% of words (${edit.changed} of ${edit.sourceWords}); a harvest may change less than ${max}%`], reviews: [] };
  return { holds: [], reviews: [`Harvest edit: ${pct}% of words changed (${edit.changed} of ${edit.sourceWords}, under ${max}%), hook unchanged; confirm the edit`] };
}
const normalizedVerbatim = tweets => SHA(JSON.stringify(withoutSignOff(tweets).map(tweet => String(tweet)
  .replace(/https?:\/\/(?:www\.)?lvnta\.com\/lv_[A-Za-z0-9]+/gi, '<TRACKING_LINK>')
  .replace(/\{\{LINK\d*\}\}/g, '<TRACKING_LINK>'))));

function projectedRealPath(target) {
  let anchor = resolve(target);
  const tail = [];
  while (!existsSync(anchor)) {
    const parent = dirname(anchor);
    if (parent === anchor) throw new Error(`No existing path ancestor for ${target}`);
    tail.unshift(anchor.slice(parent === sep ? 1 : parent.length + 1));
    anchor = parent;
  }
  return resolve(realpathSync(anchor), ...tail);
}
function outsideRepo(target) {
  const actual = projectedRealPath(target);
  if (actual === REAL_ROOT || actual.startsWith(REAL_ROOT + sep)) {
    throw new Error('Private review artifacts must be outside the repository');
  }
  return resolve(target);
}
function requireRows(input) {
  if (!Array.isArray(input?.rows) || !input.rows.length || input.rows.length > 1000) throw new Error('Input needs 1–1000 rows');
  const ids = input.rows.map(row => row?.id);
  if (ids.some(id => !ID.test(id || '') || Object.prototype.hasOwnProperty.call(Object.prototype, id))
    || new Set(ids).size !== ids.length) throw new Error('Rows need unique safe stable IDs');
  if (input.expectedRows != null && (!Number.isSafeInteger(input.expectedRows) || input.expectedRows < ids.length)) throw new Error('expectedRows must cover all supplied rows');
  return input.rows;
}
function base(row) {
  return [`- Account/date/lane: ${text(row.account) || '(missing)'} · ${text(row.date) || '(missing)'} · ${text(row.lane) || '(missing)'}`,
    `- Source ID/URL: ${text(row.source?.id) || '(none)'} · ${text(row.source?.url) || '(none)'}`];
}
function issueStatus(holds, reviews) { return holds.length ? 'hold' : reviews.length ? 'review_needed' : 'ready_for_owner_review'; }

export function buildHookRows(input, { approvedProducts = new Map() } = {}) {
  return requireRows(input).map(row => {
    const holds = [], reviews = [];
    const lane = laneOf(row.lane);
    const original = text(row.source?.hook), proposed = text(row.hook?.proposed);
    if (!text(row.account) || !text(row.date) || !lane) holds.push('Missing account, date or lane');
    if (!proposed) holds.push('Missing proposed hook');
    if (lane === 'cover' && !original) holds.push('Cover needs the verified source hook');
    if (lane === 'seed' && !text(row.source?.contractVersion)) holds.push('Seed (pot) needs its approved contract version');
    if (lane === 'harvest' && !text(row.source?.harvestOf)) holds.push('Harvest needs its source lineage');
    const sourceTweets = Array.isArray(row.source?.tweets) ? row.source.tweets : [];
    if (lane === 'harvest' && row.source?.variation !== true && !sourceTweets.length) holds.push('Verbatim harvest needs source tweets for owner review');
    if (lane === 'harvest' && row.source?.variation === true && !text(row.source?.variationReason)) holds.push('Harvest variation needs an explicit reason and separate lane review');
    if (lane === 'harvest' && row.source?.variation !== true && original && proposed !== original) holds.push('Verbatim harvest hook differs from the source');
    if (!text(row.hook?.structure)) holds.push('Explain the preserved hook structure and each meaningful change');
    if (!text(row.hook?.outline)) holds.push('Missing thread outline and hook payoff');
    if (!text(row.hook?.tailValue)) holds.push('Missing worthwhile material after the commercial section');
    const opportunities = Array.isArray(row.hook?.ctaOpportunities) ? row.hook.ctaOpportunities : [];
    const productsApproval = approvedProducts.get(row.id);
    if (!productsApproval || row.approvedProductsRevision !== productsApproval.revision) holds.push('Approved products row revision is missing or mismatched');
    else if (JSON.stringify(opportunities.map(item => text(item?.productAsin)).filter(Boolean)) !== JSON.stringify(productsApproval.productAsins)) {
      holds.push('CTA products differ from the approved products row');
    }
    if (productsApproval && (productsApproval.account !== row.account || productsApproval.date !== row.date || laneOf(productsApproval.lane) !== lane
      || productsApproval.sourceId !== text(row.source?.id)
      || text(productsApproval.contractVersion) !== text(row.source?.contractVersion)
      || text(productsApproval.harvestOf) !== text(row.source?.harvestOf))) holds.push('Account/date/lane/source/contract differs from the approved products row');
    if (opportunities.length < 2) reviews.push('Fewer than two earned CTA opportunities; explain the honest constraint before drafting');
    for (const [index, item] of opportunities.entries()) {
      if (!text(item?.need) || !text(item?.transition)) holds.push(`CTA opportunity ${index + 1} lacks a distinct need or topic-aware transition`);
    }
    const hookCheck = original && proposed ? checkHook(proposed, original, {
      lane: lane === 'cover' ? 'cover' : lane,
      hookDrift: row.hook?.hookDrift || null,
      swapPromise: !!row.hook?.swapPromise,
    }) : null;
    if (lane === 'cover' && hookCheck && !hookCheck.ok) holds.push(`Canonical hook gate: ${hookCheck.issue}`);
    if (lane !== 'cover' && lane !== 'seed' && lane !== 'harvest' && lane !== 'remix') reviews.push(`Confirm ${lane || 'unknown'} lane hook contract`);
    const status = issueStatus(holds, reviews);
    const content = [`# ${row.id} · Hook and direction`, '', ...base(row),
      `- Status: ${status}`,
      `- Original hook: ${q(original)}`, `- Proposed hook: ${q(proposed)}`,
      `- Structure and changes: ${text(row.hook?.structure) || '(missing)'}`,
      `- Canonical hook check: ${hookCheck ? q(hookCheck) : '(not measurable; source missing)'}`,
      '', '## Thread promise and outline', text(row.hook?.outline) || '(missing)',
      '', '## Earned CTA opportunities',
      ...(opportunities.length ? opportunities.map((item, index) => `${index + 1}. Need: ${text(item.need) || '(missing)'}; transition from prior thought: ${text(item.transition) || '(missing)'}; product: ${text(item.productAsin) || '(not selected)'}`) : ['(none)']),
      '', '## Value after the asks', text(row.hook?.tailValue) || '(missing)',
      ...(lane === 'harvest' && row.source?.variation !== true ? ['', '## Source body for verbatim comparison', ...sourceTweets.flatMap((tweet, index) => [`### Source ${index + 1}`, String(tweet), ''])] : []),
      '', '## Review findings',
      ...(holds.length ? holds.map(x => `- HOLD: ${x}`) : []),
      ...(reviews.length ? reviews.map(x => `- OWNER REVIEW: ${x}`) : []),
      ...(!holds.length && !reviews.length ? ['- No packet-level issues; review the direction and exact hook.'] : []),
      '', status === 'hold' ? 'Resolve the holds and resubmit before owner approval.' : 'Owner decision: approve this exact row, request revision, or hold it.',
      `<!-- PI_RUN_HOOK_V1 ${JSON.stringify({ proposed, productAsins: opportunities.map(item => text(item?.productAsin)).filter(Boolean), sourceId: text(row.source?.id), contractVersion: text(row.source?.contractVersion), account: row.account, date: row.date, lane, harvestOf: text(row.source?.harvestOf), variation: row.source?.variation === true, sourceBodyHash: sourceTweets.length ? normalizedVerbatim(sourceTweets) : null })} -->`, ''].join('\n');
    return { id: row.id, status, holds, reviews, content };
  });
}

/** PURE. The same approved products, in order, counting a product listed once per plug once: a harvest
 *  that plugs one product twice lists it twice (the 21kg body, R2026-09-27), and that is still the one
 *  product the owner approved. */
export function sameProducts(asins = [], approvedAsins = []) {
  const once = (xs) => (xs || []).map(text).filter((x, i, all) => x && all.indexOf(x) === i);
  return JSON.stringify(once(asins)) === JSON.stringify(once(approvedAsins));
}

export function draftCopyDigest(tweets) { return SHA(JSON.stringify(tweets)); }

// When laws.json puts editorial-prescore at decide (or enforce), Jev's editorial reading of this exact copy
// sits in the drafts gate: its safety pointers hold, its craft pointers are notes while laws.json
// jev.craftHolds is "advisory" (owner, 2026-10-06; AGENTS.md), and a missing, stale, unread or
// shadow-mode reading is a hold, never a pass.
const ACTING = new Set(['decide', 'enforce']);
export const jevEditorialGate = (laws) => ACTING.has(decisionConfig('editorial-prescore', laws).mode);
export function jevEditorialIssues(reading, digest, { repairs = 0, loops = LAWS.jev?.repairLoops ?? 1, craftAdvisory = LAWS.jev?.craftHolds === 'advisory' } = {}) {
  const pre = reading?.prescore;
  const run = 'run `node scripts/run-jev.mjs --stage drafts --run-dir RUN_DIR --input SPEC.json` and rebuild this packet';
  if (!reading || reading.copySha256 !== digest || !pre) return { holds: [`Jev editorial decision is missing or not bound to this exact copy: ${run}`], reviews: [] };
  if (pre.status !== 'read') return { holds: [`Jev editorial decision not read (${text(pre.reason) || pre.status}): ${run}`], reviews: [] };
  if (!ACTING.has(pre.mode)) return { holds: [`Jev editorial reading ran in ${pre.mode} mode, so it is not a decision (a model or question-set change drops it to shadow): recalibrate, then ${run}`], reviews: [] };
  const notes = (level) => (pre.pointers || []).filter(p => (level === 'hold' ? p.level === 'hold' : p.level !== 'hold')).map(p => p.note);
  // REPAIR ONCE, THEN SHIP (owner, 2026-09-28, on a Jev editorial hold at drafts; safety holds still stop).
  // Once the row has had its repair loop(s), a hold that is craft through and through is a note the row
  // ships with; one safety pointer, or anything that is not craft, keeps the hold.
  // CRAFT IS ADVISORY (owner, 2026-10-06, laws.json jev.craftHolds): across R2026-10-03 and -04 Jev flagged
  // 116 of 116 draft reads and the owner approved all 116, so a craft-only hold is a note from the first
  // read. Safety pointers, anything not craft, and a missing or unread reading still hold.
  const held = (pre.pointers || []).filter(p => p.level === 'hold');
  if (pre.action === 'hold' && craftAdvisory && held.length && held.every(p => p.kind === 'craft')) {
    return { holds: [], reviews: [`Jev craft note (advisory): ${notes('hold').join('; ')}`] };
  }
  if (pre.action === 'hold' && repairs >= loops && held.length && held.every(p => p.kind === 'craft')) {
    return { holds: [], reviews: [`Jev editorial hold after ${repairs} repair${repairs === 1 ? '' : 's'}, shipped under your rule "Repair once, then ship": ${notes('hold').join('; ')}`] };
  }
  if (pre.action === 'hold') return { holds: [`Jev editorial decision holds this copy: ${notes('hold').join('; ')}`], reviews: [] };
  if (pre.action === 'review_needed') return { holds: [], reviews: [`Jev editorial decision: check ${notes('review').join('; ')}`] };
  return { holds: [], reviews: [] };
}

// CRAFT GATES: JEV SETTLES THEM (plan v7 N3; owner 2026-09-23, "become jev native", default 1: "Jev's
// reading settles a craft regex hit; safety stays regex OR Jev; a 15% audit"). These canonical-gate
// messages judge how a thread READS (a thin bridge, a cold plug, a criterion after its plug, a generic
// sign-off, a dangling lead-in, an argued substance left unsold) with word tests; RUN-2's 52 of 62
// false blockers were this class. When Jev's editorial decision for this exact copy is acting and read
// and points at no craft problem, such a hit becomes a review line ("code saw X; Jev read it as fine").
// Anything else (no reading, a shadow reading, a Jev craft pointer) keeps the code's hold. Safety,
// structure, links, counts and numbering are never in this list. A deterministic ~15% of settled rows
// are an AUDIT sample: the line says to read it, so the miss rate stays measurable (plan invariant 10).
export { CRAFT_GATE_PATTERNS, isCraftGateIssue, craftKey } from '../craft-gates.mjs';
export const AUDIT_SHARE = 0.15;
const auditPick = (id, digest) => parseInt(SHA(`${id}|${digest}`).slice(0, 8), 16) / 0xffffffff < AUDIT_SHARE;

/** PURE. Split a canonical gate's issues: { holds, settled } where settled are craft hits Jev read as fine. */
export function settleCraftGates(issues, reading, digest, { id = '', laws } = {}) {
  const pre = reading?.prescore;
  const acting = reading && reading.copySha256 === digest && pre?.status === 'read' && ACTING.has(pre.mode)
    && jevEditorialGate(laws);
  const jevCraft = acting ? (pre.pointers || []).filter((p) => p.kind === 'craft' && (p.level === 'review' || p.level === 'hold')) : [];
  if (!acting || jevCraft.length) return { holds: [...issues], raw: [], settled: [] };
  const holds = [], settled = [];
  for (const issue of issues) (isCraftGateIssue(issue) ? settled : holds).push(issue);
  const audit = settled.length > 0 && auditPick(id, digest);
  return { holds, raw: settled, settled: settled.map((x) => `Code gate saw "${String(x).slice(0, 160)}"; Jev's editorial read found no craft problem${audit ? ' — AUDIT SAMPLE: read this row in full' : ''}`) };
}

/** An editorial verdict is worth the lines it read. The review quotes the copy its verdict rests on,
 *  and every quote must be in THIS copy: a reviewer that judged another draft, or paraphrased this
 *  one, is held here instead of being recorded as a pass. Whitespace is collapsed on both sides, so a
 *  quote taken across a line break still matches. Returns the holds; none when the evidence stands. */
export const EDITORIAL_QUOTE_MIN = 12;
export function editorialEvidenceIssues(evidence, tweets = []) {
  const flat = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const quotes = (Array.isArray(evidence) ? evidence : []).map(flat).filter(Boolean);
  if (!quotes.length) return ['Independent editorial review quotes no line of this copy; ask the reviewer for the exact lines its verdict rests on'];
  const copy = flat(tweets.join('\n\n'));
  const short = quotes.filter(quote => quote.length < EDITORIAL_QUOTE_MIN);
  const absent = quotes.filter(quote => quote.length >= EDITORIAL_QUOTE_MIN && !copy.includes(quote));
  return [
    ...(absent.length ? [`Editorial review quotes text that is not in this copy: ${absent.map(quote => q(quote.slice(0, 80))).join('; ')}`] : []),
    ...(short.length ? [`Editorial evidence is too short to pin a line (under ${EDITORIAL_QUOTE_MIN} characters): ${short.map(quote => q(quote)).join('; ')}`] : []),
  ];
}

/**
 * `merged: true` is the five-stop flow: no hooks stop exists, so each row binds to its approved
 * PRODUCTS row and this packet carries what the hooks packet used to: the donor hook beside tweet 1,
 * the canonical hook gate (a cover below the floor or above the duplicate edge is held here), the
 * explanation of what changed, and a verbatim harvest's source body. Otherwise rows bind to the
 * approved hooks row of a six-stop run.
 */
export function buildDraftRows(input, { approvedHooks = new Map(), approvedProducts = new Map(), merged = false, rules = null, calendar = null, edits = 'words', jevReadings = null, jevTwins = [], pinned = [], acceptedTwins = [], laws = LAWS } = {}) {
  // The run's content rules (scripts/run-rules.mjs), decided at the intake: null for an older run.
  const twins = runTwinIssues(requireRows(input), rules, undefined, { jevTwins, pinned, accepted: acceptedTwins });
  return requireRows(input).map(row => {
    const holds = [], reviews = [];
    const tweets = Array.isArray(row.draft?.tweets) ? row.draft.tweets.map(x => String(x)) : [];
    const digest = draftCopyDigest(tweets);
    // What would publish (copy-change.mjs publishCopy, the reflow publish-thread applies): equal
    // normalized digests prove no published word changed, which is what the change classifier reads.
    const plugLinks = (Array.isArray(row.draft?.products) ? row.draft.products : []).map(p => text(p?.link)).filter(Boolean);
    const normalizedDigest = normalizedCopySha256(tweets, { plugLinks, account: ACCOUNTS[row.account] || null });
    const binding = slotBinding(calendar, row);
    if (binding.hold) holds.push(binding.hold);
    const lane = laneOf(row.lane);
    const verbatimHarvest = lane === 'harvest' && row.source?.variation !== true;
    const sourceTweets = Array.isArray(row.source?.tweets) ? row.source.tweets.map(x => String(x)) : [];
    if (!text(row.account) || !text(row.date) || !lane) holds.push('Missing account, date or lane');
    if (tweets.length < 3) holds.push('Missing complete numbered thread body');
    if (lane === 'seed' && !text(row.source?.contractVersion)) holds.push('Seed (pot) contract version is missing');
    if (lane === 'harvest' && !text(row.source?.harvestOf)) holds.push('Harvest source lineage is missing');
    if (lane === 'harvest' && row.source?.variation === true && !text(row.source?.variationReason)) holds.push('Harvest variation needs an explicit reason');
    // Every cover is a pot of its donor's unnamed seed (laws.json farm.$coverAsPot, owner 2026-10-12): a
    // cover without its dials ticket is held here, the one stop every run row passes.
    if (lane === 'cover') for (const issue of coverTicketIssues(row, laws.farm?.coverAsPot)) holds.push(`Cover-as-pot ticket: ${issue}`);
    // ...and its items are new: the body is read against the donor's (laws.json farm.$coverBodyMax).
    if (lane === 'cover') for (const issue of coverBodyIssues(tweets, sourceTweets, laws.farm?.coverAsPot)) holds.push(`Cover-as-pot body: ${issue}`);
    const products = Array.isArray(row.draft?.products) ? row.draft.products : [];
    let hookCheck = null;
    const original = text(row.source?.hook);
    if (merged) {
      if (lane === 'cover' && !original) holds.push('Cover needs the verified source hook');
      if (!text(row.hook?.structure)) holds.push('Explain the preserved hook structure and each meaningful change');
      if (verbatimHarvest && !sourceTweets.length) holds.push('Verbatim harvest needs source tweets for owner review');
      else if (verbatimHarvest) { const edit = harvestEditIssues(leadSource(sourceTweets, row.draft?.leadItem), tweets); holds.push(...edit.holds); reviews.push(...edit.reviews); }
      hookCheck = original && tweets[0] ? checkHook(tweets[0], original, {
        lane, hookDrift: row.hook?.hookDrift || null, swapPromise: !!row.hook?.swapPromise,
      }) : null;
      if (lane === 'cover' && hookCheck && !hookCheck.ok) holds.push(`Canonical hook gate: ${hookCheck.issue}`);
      // No hooks stop saw these first, so the owner is asked about them here, explicitly.
      if (lane === 'harvest' && row.source?.variation === true) reviews.push('Harvest variation: confirm this rewrite; it is no longer a verbatim attempt');
      if (!['cover', 'seed', 'harvest', 'remix'].includes(lane)) reviews.push(`Confirm ${lane || 'unknown'} lane hook contract`);
      const approved = approvedProducts.get(row.id);
      if (!approved || !text(approved.revision) || row.approvedProductsRevision !== approved.revision) holds.push('Approved products row revision is missing or mismatched');
      else {
        if (!sameProducts(products.map(p => text(p?.asin)), approved.productAsins)) holds.push('Product ASINs differ from the approved products row');
        if (text(row.source?.id) !== text(approved.sourceId) || text(row.source?.contractVersion) !== text(approved.contractVersion)) holds.push('Source or seed contract differs from the approved products row');
        if (row.account !== approved.account || row.date !== approved.date || lane !== laneOf(approved.lane)
          || text(row.source?.harvestOf) !== text(approved.harvestOf)) holds.push('Account/date/lane/harvest lineage differs from the approved products row');
      }
    } else {
      if (verbatimHarvest && !approvedHooks.get(row.id)?.sourceBodyHash) holds.push('Approved harvest hook packet lacks source body');
      if (verbatimHarvest && approvedHooks.get(row.id)?.sourceBodyHash) {
        // The approved packet stored only the source hash: the row's own source must still be that
        // body, and the copy is then measured against it under the owner's harvest edit rule.
        if (!sourceTweets.length || approvedHooks.get(row.id).sourceBodyHash !== normalizedVerbatim(sourceTweets)) {
          const unswapped = swapBack(tweets, row.draft?.leadItem) || tweets;   // a lead swap is not an edit
          if (approvedHooks.get(row.id).sourceBodyHash !== normalizedVerbatim(unswapped)) holds.push('Harvest body differs from approved source beyond tracking-link replacement');
        } else { const edit = harvestEditIssues(leadSource(sourceTweets, row.draft?.leadItem), tweets, 'the approved source'); holds.push(...edit.holds); reviews.push(...edit.reviews); }
      }
      // A moved lead item changes only tweet 1's item line (scripts/run-lead-item.mjs): the approved hook is
      // everything above it.
      const hookLinesOf = (t) => String(t).split(/\n[ \t]*1[.)][ \t]/)[0].trim();
      const itemLineOf = (t) => (String(t).match(/\n[ \t]*1[.)][ \t]+(.+)\s*$/) || [])[1]?.trim().toLowerCase() || null;
      const lead = row.draft?.leadItem;
      const leadSwap = lead?.moved && hookLinesOf(tweets[0]) === hookLinesOf(row.hook?.proposed) && itemLineOf(tweets[0]) === String(lead.name).toLowerCase();
      if (text(row.hook?.proposed) && tweets[0] !== row.hook.proposed && !leadSwap) holds.push('First tweet differs from the approved hook proposal');
      if (!text(row.hook?.proposed)) holds.push('Missing approved hook proposal for copy comparison');
      const approved = approvedHooks.get(row.id);
      if (!approved || !text(approved.revision) || row.approvedHookRevision !== approved.revision) holds.push('Approved hooks row revision is missing or mismatched');
      else {
        if (row.hook?.proposed !== approved.proposed || tweets[0] !== approved.proposed) holds.push('Hook differs from the approved hooks row');
        if (!sameProducts(products.map(p => text(p?.asin)), approved.productAsins)) holds.push('Product ASINs differ from the approved hooks row');
        if (text(row.source?.id) !== approved.sourceId || text(row.source?.contractVersion) !== approved.contractVersion) holds.push('Source or seed contract differs from the approved hooks row');
        if (row.account !== approved.account || row.date !== approved.date || lane !== laneOf(approved.lane)
          || text(row.source?.harvestOf) !== approved.harvestOf || (row.source?.variation === true) !== approved.variation) {
          holds.push('Account/date/lane/harvest lineage differs from the approved hooks row');
        }
      }
    }
    for (const [index, product] of products.entries()) {
      if (!/^[A-Z0-9]{10}$/.test(text(product?.asin)) || !text(product?.title)) holds.push(`Product ${index + 1} needs its exact ASIN and name`);
    }
    const gate = tweets.length >= 3 ? gateThread({ account: row.account, tweets, products,
      ctaDepth: row.draft?.ctaDepth, allowUnsold: row.draft?.allowUnsold,
      shape: row.draft?.shape, firstPlugAt: row.draft?.firstPlugAt, arm: row.draft?.arm || null }) : null;
    if (gate && !gate.ok) {
      if (gate.fatal) holds.push(`Canonical thread gate: ${gate.fatal}`);
      else {
        const craft = settleCraftGates(gate.issues || [], jevReadings?.get(row.id), digest, { id: row.id, laws });
        if (craft.holds.length) holds.push(`Canonical thread gate: ${craft.holds.join('; ')}`);
        reviews.push(...craft.settled);
      }
    }
    const ruled = rowRuleIssues({ tweets, products, sources: row.draft?.sources, plugsAt: gate?.plugsAt || [], verbatim: verbatimHarvest }, rules);
    holds.push(...(twins.get(row.id) || []).map(x => `Run rule: ${x}`), ...ruled.holds.map(x => `Run rule: ${x}`));
    reviews.push(...ruled.reviews.map(x => `Run rule: ${x}`));
    const checks = Array.isArray(row.draft?.laneChecks) ? row.draft.laneChecks : [];
    if (!checks.length) holds.push('Missing actual lane-check evidence');
    for (const check of checks) if (!check?.passed || !text(check.evidence)) holds.push(`Lane check ${text(check?.name) || '(unnamed)'} failed or lacks evidence`);
    const editorial = row.draft?.editorialReview;
    const jevGate = jevEditorialGate(laws);
    if (jevGate) { const decided = jevEditorialIssues(jevReadings?.get(row.id), digest, { repairs: (row.repairs || []).length, loops: laws.jev?.repairLoops ?? 1 }); holds.push(...decided.holds); reviews.push(...decided.reviews); }
    // Under the intake's edits='words' a review of the same published words still stands after a
    // spacing or formatting edit: the reviewer may bind to the normalized digest instead of the exact one.
    const reviewBound = editorial && (editorial.contentSha256 === digest
      || (edits === 'words' && editorial.normalizedCopySha256 === normalizedDigest));
    if (jevGate) { /* Jev decided above; a subagent review, if any, is not a gate */ } else if (!editorial || !text(editorial.reviewer) || !reviewBound
      || !['pass', 'hold'].includes(editorial.verdict) || !text(editorial.notes)) {
      holds.push('Independent editorial review is missing or is not bound to this exact copy digest');
    } else {
      holds.push(...editorialEvidenceIssues(editorial.evidence, tweets));
      if (editorial.verdict !== 'pass') holds.push(`Editorial review holds this copy: ${editorial.notes}`);
    }
    if (!text(row.draft?.valueAfterSale)) reviews.push('Explain what non-buyers still get after the CTA block');
    const mediaItems = Array.isArray(row.draft?.media) ? row.draft.media : [];
    for (const [index, item] of mediaItems.entries()) {
      if (!Number.isSafeInteger(item?.tweet) || item.tweet < 1 || item.tweet > tweets.length || !text(item?.source)) {
        holds.push(`Media item ${index + 1} needs a valid tweet number and source`);
      }
    }
    if (!mediaItems.length && !text(row.draft?.noMediaReason)) reviews.push('Media mapping or an explicit no-media reason is missing');
    const status = issueStatus(holds, reviews);
    const media = Array.isArray(row.draft?.media) ? row.draft.media : [];
    // Everything but the copy that an approval covers: a change here always re-opens the row.
    const bindingSha256 = SHA(JSON.stringify({ account: row.account ?? null, date: row.date ?? null, lane,
      source: { id: text(row.source?.id), harvestOf: text(row.source?.harvestOf), contractVersion: text(row.source?.contractVersion), variation: row.source?.variation === true },
      products: products.map(p => [text(p?.asin), text(p?.title), text(p?.link)]),
      media: media.map(m => [m?.tweet ?? null, text(m?.source)]), noMediaReason: text(row.draft?.noMediaReason),
      valueAfterSale: text(row.draft?.valueAfterSale), status }));
    const content = [`# ${row.id} · Complete draft`, '', ...base(row), ...(binding.line ? [binding.line] : []),
      `- Status: ${status}`, `- Exact copy SHA-256: ${digest}`, `- Published-copy SHA-256 (after the publisher's reflow): ${normalizedDigest}`,
      ...(merged ? [
        `- Original hook: ${q(original)}`,
        // A donor recreated in English (donor-routes.mjs translationOf): source.hook is the English translation
        // the hook gate reads, and the original-language hook is shown beside it.
        ...(text(row.source?.originalHook) ? [`- Original hook (${text(row.source?.translatedFrom) || 'original language'}): ${q(row.source.originalHook)}`] : []),
        `- New hook (tweet 1): ${q(tweets[0])}`,
        `- Structure and changes: ${text(row.hook?.structure) || '(missing)'}`,
        `- Canonical hook check: ${hookCheck ? q(hookCheck) : '(not measurable; source missing)'}`,
        ...(lane === 'cover' && laws.farm?.coverAsPot?.on ? [`- Dials turned from the donor: ${Array.isArray(row.dials) && row.dials.length ? row.dials.map(d => `${d?.dial}: ${d?.from} → ${d?.to}`).join(' · ') : '(no ticket)'}`] : []),
        ...(lane === 'harvest' ? [`- Harvest mode: ${verbatimHarvest ? 'verbatim' : `variation · ${text(row.source?.variationReason) || '(no reason)'}`}`] : []),
      ] : [`- Approved hook proposal: ${q(row.hook?.proposed)}`]),
      `- Canonical thread gate: ${gate ? q(gate) : '(not run: incomplete thread)'}`,
      // The lead item (scripts/run-lead-item.mjs; owner, 2026-09-28: "every numbered first tweet should have it
      // implemented."): shown, not a review. A swap keeps every word and is the owner's own rule.
      ...(row.draft?.leadItem ? [`- Lead item: ${leadLine(row.draft.leadItem)}${row.draft.leadItem.moved ? '; every word kept' : ''}`] : []),
      `- Run rules: ${rules ? `${rules.ctaMax === null ? 'no run cap on' : `at most ${rules.ctaMax}`} calls to action and ${rules.productsMax} product(s); sources ${rules.sources}; twins ${rules.twins} · rules ${rules.rulesSha256.slice(0, 12)}` : '(this run has no intake content rules)'}`,
      `- Lane checks: ${checks.length ? checks.map(c => `${text(c.name)} ${c.passed ? 'passed' : 'failed'} (${text(c.evidence) || 'no evidence'})`).join('; ') : '(none)'}`,
      ...(jevGate ? [`- Editorial decision: Jev (owner rule 2026-09-23); see the Jev lines below`] : []),
      `- Independent editorial review: ${editorial ? `${text(editorial.reviewer)} · ${text(editorial.verdict)} · ${text(editorial.notes)} · digest ${text(editorial.contentSha256)}` : '(none)'}`,
      ...(Array.isArray(editorial?.evidence) ? editorial.evidence.map(line => `  - Quoted: ${q(text(line))}`) : []),
      // Report-only (scripts/run-jev.mjs): where to look first. It never changes this row's status.
      ...(jevReadings ? jevLines(jevReadings.get(row.id), tweets, products) : []),
      '', '## Exact numbered tweets',
      ...tweets.flatMap((tweet, index) => [`### ${index + 1}`, tweet, '']),
      '## Product and CTA mapping',
      ...(products.length ? products.map((p, i) => `${i + 1}. ${text(p.asin) || '(missing ASIN)'} · ${text(p.title) || '(missing title)'} · ${text(p.link) || '(unminted)'}`) : ['(none)']),
      '', '## Media mapping',
      ...(media.length ? media.map(m => `- Tweet ${m.tweet}: ${text(m.source) || '(missing source)'}`) : [text(row.draft?.noMediaReason) || '(none)']),
      '', '## Value after the commercial section', text(row.draft?.valueAfterSale) || '(missing)',
      ...(merged && verbatimHarvest ? ['', '## Source body for verbatim comparison', ...sourceTweets.flatMap((tweet, index) => [`### Source ${index + 1}`, tweet, ''])] : []),
      '', '## Review findings',
      ...(holds.length ? holds.map(x => `- HOLD: ${x}`) : []),
      ...(reviews.length ? reviews.map(x => `- OWNER REVIEW: ${x}`) : []),
      ...(!holds.length && !reviews.length ? ['- Packet complete; owner must review the exact copy.'] : []),
      '', status === 'hold' ? 'Resolve the holds and resubmit before owner approval.' : 'Owner decision: approve this exact copy, request revision, or hold it.',
      `<!-- PI_RUN_DRAFT_V1 ${JSON.stringify({ slotId: row.id, copySha256: digest, spacingCopySha256: spacingCopySha256(tweets), normalizedCopySha256: normalizedDigest, bindingSha256 })} -->`, ''].join('\n');
    return { id: row.id, status, holds, reviews, content, contentSha256: digest, normalizedCopySha256: normalizedDigest };
  });
}

export function packetsForStage(stage, rows, chunkSize = 8, expectedRows = rows.length) {
  if (!['hooks', 'drafts'].includes(stage)) throw new Error('Stage must be hooks or drafts');
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 20) throw new Error('chunkSize must be 1–20');
  if (!Number.isSafeInteger(expectedRows) || expectedRows < rows.length) throw new Error('expectedRows must cover supplied rows');
  const eligible = rows.filter(row => row.status !== 'hold');
  const packets = [];
  for (let i = 0; i < eligible.length; i += chunkSize) {
    packets.push({ batchId: `${stage}-${SHA(JSON.stringify(eligible.slice(i, i + chunkSize).map(row => row.id))).slice(0, 12)}`,
      expectedRows,
      rows: eligible.slice(i, i + chunkSize).map(row => ({ id: row.id, content: row.content })) });
  }
  return packets;
}

function approvedRowMetadata(runDir, stage, ids) {
  if (!runDir) return new Map();
  const state = JSON.parse(readFileSync(join(resolve(runDir), 'state.json'), 'utf8'));
  const approved = new Map();
  for (const id of ids) {
    let current;
    try { current = checkRow(runDir, stage, id); } catch { continue; }
    if (!current?.revision) continue;
    const entry = state.rowStages?.[stage]?.rows?.[id];
    if (!entry || entry.revision !== current.revision) continue;
    const body = readFileSync(join(resolve(runDir), 'reviews', entry.snapshot), 'utf8');
    const marker = stage === 'hooks' ? 'PI_RUN_HOOK_V1' : 'PI_RUN_PRODUCTS_V1';
    const markerLine = body.trimEnd().split('\n').at(-1);
    const match = markerLine?.match(new RegExp(`^<!-- ${marker} (\\{[^\\n]*\\}) -->$`));
    if (!match || body.split(`<!-- ${marker} `).length !== 2) continue;
    try { approved.set(id, { ...JSON.parse(match[1]), revision: current.revision }); } catch { /* hold the row */ }
  }
  return approved;
}

function arg(name) { const at = process.argv.indexOf(`--${name}`); return at < 0 ? null : process.argv[at + 1]; }
function main() {
  const stage = arg('stage'), runDir = arg('run-dir'), inputPath = arg('input'), outputPath = arg('output'), reviewDir = arg('review-dir');
  if (!stage || !runDir || !inputPath || !outputPath || !reviewDir) throw new Error('Usage: run-content-packets.mjs --stage drafts|hooks --run-dir RUN_DIR --input SPEC.json --output PLAN.json --review-dir DIR [--chunk-size N]');
  if (!['hooks', 'drafts'].includes(stage)) throw new Error('Stage must be hooks or drafts');
  const output = outsideRepo(outputPath), folder = outsideRepo(reviewDir);
  const raw = readFileSync(inputPath);
  const input = JSON.parse(raw);
  // The stop in front of this one, from the run's own flow: products for drafts in a five-stop run.
  const flow = flowOf(runDir);
  if (!flow.includes(stage)) throw new Error(`This run has no ${stage} stop (its stops are ${flow.join(' → ')}).`);
  const upstreamStage = flow[flow.indexOf(stage) - 1];
  const runState = JSON.parse(readFileSync(join(resolve(runDir), 'state.json'), 'utf8'));
  const expectedRows = runState.rowStages?.[upstreamStage]?.expectedRows;
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || (input.expectedRows != null && input.expectedRows !== expectedRows)) {
    throw new Error(`${stage} expectedRows must match the declared run-wide ${upstreamStage} row count`);
  }
  const ids = Array.isArray(input.rows) ? input.rows.map(row => row.id) : [];
  const rules = runContentRules(runDir);
  // A brief approved with a calendar binds every drafts row to its slot; an older brief adds nothing.
  // What re-opens approval is the intake's `edits` answer (words unless the owner said any).
  const calendar = stage === 'drafts' ? approvedCalendar(runDir) : null;
  const edits = editsPolicyOf({ content: rules });
  const jevReadings = readingsFor(runDir, 'drafts');
  const rows = stage === 'hooks'
    ? buildHookRows(input, { approvedProducts: approvedRowMetadata(runDir, 'products', ids) })
    : upstreamStage === 'products'
      ? buildDraftRows(input, { merged: true, rules, jevReadings, jevTwins: jevTwinsFor(runDir), pinned: runPins(runDir), acceptedTwins: runAcceptedTwins(runDir), approvedProducts: approvedRowMetadata(runDir, 'products', ids), calendar, edits })
      : buildDraftRows(input, { rules, jevReadings, jevTwins: jevTwinsFor(runDir), pinned: runPins(runDir), acceptedTwins: runAcceptedTwins(runDir), approvedHooks: approvedRowMetadata(runDir, 'hooks', ids), calendar, edits });
  const packets = packetsForStage(stage, rows, Number(arg('chunk-size') || rules?.batchSize || 8), expectedRows);
  const files = packets.map(packet => join(folder, `${packet.batchId}.json`));
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  if (files.some(existsSync)) throw new Error('A review packet already exists; choose a new output directory');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const plan = { schema: 'run-content-packets-v1', stage, generatedAt: new Date().toISOString(),
    inputSha256: SHA(raw), rows: rows.map(({ content, ...row }) => row), reviewPackets: files,
    counts: Object.fromEntries(['ready_for_owner_review', 'review_needed', 'hold'].map(status => [status, rows.filter(row => row.status === status).length])) };
  writeFileSync(output, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
  packets.forEach((packet, index) => writeFileSync(files[index], JSON.stringify(packet, null, 2), { flag: 'wx', mode: 0o600 }));
  console.log(`${stage}: ${rows.length} rows · ${plan.counts.hold} held · ${plan.counts.review_needed} need revision · ${packets.length} submit-ready review batches`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
