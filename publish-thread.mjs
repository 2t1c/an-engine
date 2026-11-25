// publish-thread.mjs — ship a HAND-WRITTEN thread (skill: write-thread) through the same gates and
// bookkeeping the engine uses. No LLM calls: validate -> Typefully draft (UNSCHEDULED) -> media pass
// -> ledger row. If validation fails it writes NOTHING and prints why.
//
// Input file (JSON):
// {
//   "account": "lorenzo",                  // ACCOUNTS key
//   "recId":   "recXXXXXXXX",              // donor record (attribution + media source)
//   "moldId":  "M1",                       // optional — stamps the mold lane for mold-promote
//   "tweets":  ["hook", "...", "..."],     // full thread, plugs already in place, links inline
//   "products": [                          // heavy first, then light; links already minted
//     { "asin": "B09SFFJP1P", "title": "...", "link": "https://lvnta.com/lv_x", "subid1": "x-thread-..." }
//   ],
//   "ctaStyle": "payoff",                  // ledger stamp for the split-test readout
//   "reviewDraftId": "12345"               // optional — the [REVIEW] draft a collaborative /run
//                                          // already wrote in THIS account's set. Given it, shipping
//                                          // rewrites that draft instead of creating a second one.
// }
//
//   node publish-thread.mjs --file draft.json           # validate + publish
//   node publish-thread.mjs --file draft.json --dry     # validate only
//   node publish-thread.mjs --dir queues/pending --dry   # gate a whole batch in one process
//   node publish-thread.mjs --dir queues/pending         # ship every spec in the folder
//   node publish-thread.mjs --file draft.json --at 2026-08-30T14:00:00Z   # schedule instead
import { buildPlatforms } from './platforms.mjs';
import { publishCopy, trackingNeutral } from './copy-change.mjs';
import { liveTweets, tweetsSha256 } from './scripts/run-review-drafts.mjs';
import { crossPostLinks, crossPostLedgerRows } from './cross-post-links.mjs';
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { withProcessResult } from './process-result.mjs';
import { promisify } from 'node:util';
import { loadEnv, requireEnv, typefully, airtable, runMain, HERE_DIR } from './lib.mjs';
import { REGISTRY_TABLE, REVIEW_PREFIX, ATTACH_MEDIA } from './config.mjs';
import { farmStampRow } from './harvest-gate.mjs';
import { ACCOUNTS, resolveAccountKey } from './accounts.mjs';
import { validateDraft, checkThread, effLen, hookSimilarity, hookBodyText } from './checks.mjs';
import { linkGate, scheduledLinks } from './link-sentinel.mjs';
import { splitJevSettled } from './craft-gates.mjs';
import { buildRecord, renderScratchpad, writeRecord, fetchSource } from './thread-record.mjs';
import { isNotRead, noteCheck, redactProvenance, refreshNote, renderNote } from './thread-note.mjs';
import { classifyTopic } from './pick-product.mjs';
import { LAWS } from './laws.mjs';
import { laneOf } from './lanes.mjs';
import { ctaSystemOf } from './lint-cover.mjs';
import { hookGate } from './hooks-check.mjs';
import { styleArmIssues } from './style-pilot.mjs';

// H5 (operator 2026-08-25): rotation pacing for recycled bodies. Pure so tests pin it. The planner
// ENFORCES these at pick time; here they only WARN — a deliberate operator override on a proven
// body should never be blocked by a pacing rule.
export function rotationWarnings(ledgerRows, { account, harvestOf, now = Date.now(), rotationDays = LAWS.scale.bodyRotationDays, maxPerWeek = LAWS.scale.maxFamilyPerAccountPerWeek } = {}) {
  if (!harvestOf) return [];
  const mine = (ledgerRows || []).filter((e) => e.account === account && String(e.harvestOf) === String(harvestOf) && e.ts);
  const out = [];
  const days = (e) => (now - new Date(e.ts).getTime()) / 864e5;
  const recent = mine.filter((e) => days(e) < rotationDays);
  if (recent.length) out.push(`same body ran on ${account} ${days(recent[0]).toFixed(1)}d ago — inside the ${rotationDays}-day rotation window`);
  const week = mine.filter((e) => days(e) < 7).length;
  if (week >= maxPerWeek) out.push(`family cap: ${week} thread(s) from this parent on ${account} in 7 days (max ${maxPerWeek})`);
  return out;
}

// THE OPERATOR-EDIT RULE (operator 2026-09-23: "after the operator did the editing, it means the hook
// is ready and the structure is okay. Other than those two, you can still make edits"). The hook floor
// and the structure laws exist to stop a WRITER's thread before the operator reads it; they never
// overrule the operator's own edit of it. A spec carrying `operatorEdit: { message, at }`, the
// operator's words, ships through exactly two classes of finding, logged and stamped on the ledger row:
//   - the hook floor: a cover hook under 85% of its donor, declared drift or not. The duplicate edge
//     stays hard (above it the hook is a copy of someone else's post), and so does an unmeasured donor.
//   - the structure laws below: where the ask opens, the criterion before the ask, the heavy ask's own
//     bridge tweet, the bridge landing on the plugged substance, a one-sentence bridge, an argued
//     substance left unsold, and adjacent plugs.
// Everything else still blocks: 280, placeholders, banned topics, em dashes, compliance, links and
// disclosures, the disclaimer and sign-off, the plug budget, and readability. Sentences stacked in a
// bridge are a small fix the operator lets us make without asking, so fix them and ship.
export const OPERATOR_EDIT_STRUCTURE = [
  /^first (?:ask opens|plug) at tweet \d+/,
  /^plug #\d+ SELLS BEFORE IT JUSTIFIES/,
  /^the heavy ask is ONE tweet/,
  /^plug bridge missing:/,
  /^one-sentence bridge above the plug/,
  /^thread argues .* but never sells it/,
  /^plugs are adjacent/,
];
/** PURE. The operator's edit declaration, or null when the spec carries none a person could have written. */
/** PURE. The account the copy reflow sees. A spec may opt out of the own-site line with
 *  `noSiteCta: true`: on a one-CTA cover the site line is a second ask (owner, R2026-09-26: clara's
 *  was deleted in Typefully and "1 CTA per thread ONLY"), and publishCopy would put it back. */
export const copyAccount = (spec = {}, acc = {}) => (spec.noSiteCta ? { ...acc, siteCta: null } : acc);

export function operatorEditOf(spec) {
  const e = spec?.operatorEdit;
  const message = String(e?.message || '').trim();
  return message.length >= 10 ? { message, at: e.at ? String(e.at) : null } : null;
}
/** PURE. Split validateDraft issues into what still blocks and the structure findings the operator's edit settles. */
export function splitOperatorEdit(issues = []) {
  const structural = (s) => OPERATOR_EDIT_STRUCTURE.some((re) => re.test(String(s)));
  return { issues: issues.filter((i) => !structural(i)), waived: issues.filter(structural) };
}
/** PURE. Whether the operator's edit settles a failed hook verdict: measured, and not above the duplicate edge. */
export function operatorEditSettlesHook(verdict, sim, H = LAWS.hook) {
  return !!verdict && !verdict.ok && !verdict.unmeasured && sim != null && Number.isFinite(Number(sim)) && Number(sim) <= H.gateMax;
}

/** A rewritten winner retains provenance without spending a verbatim harvest attempt. */
export function publicationLineage(spec = {}) {
  if (spec.harvestOf && spec.variationOf) throw new Error('choose harvestOf (verbatim attempt) or variationOf (rewritten body), not both');
  return spec.variationOf ? { variationOf: String(spec.variationOf) }
    : spec.harvestOf ? { harvestOf: String(spec.harvestOf) } : {};
}

/**
 * The spec's provenance as an object: inline, or by reference — { file, rowId } naming the run's
 * provenance.json (scripts/run-provenance.mjs) OUTSIDE the repo, which is how the donor thread
 * reaches the shipped note without its text ever sitting in a tracked spec. An unreadable reference
 * is a warning and ships the record note; it never stops the ship.
 */
export function resolveProvenance(spec, { read = (f) => readFileSync(f, 'utf8') } = {}) {
  const p = spec?.provenance;
  if (!p || typeof p !== 'object') return { provenance: null, warning: null };
  if (!p.file) return { provenance: p, warning: null };
  try {
    const doc = JSON.parse(read(String(p.file)));
    const row = doc?.rows ? doc.rows[p.rowId] : doc;
    return row ? { provenance: row, warning: null } : { provenance: null, warning: `provenance file has no row ${p.rowId}` };
  } catch (e) { return { provenance: null, warning: `provenance file unreadable (${e.message})` }; }
}

/**
 * PURE. The shipped note for a spec that carries a /run provenance (thread-note.mjs), or null for a
 * spec without one — that spec keeps the record note (renderScratchpad) byte for byte. The header
 * turns SHIPPED with its time, and the review HISTORY carries over with the ship appended.
 */
export function shippedNote(spec, { tweets, title, publishAt = null, shippedAt, provenance: resolved = undefined }) {
  const given = resolved !== undefined ? resolved : spec?.provenance && typeof spec.provenance === 'object' && !spec.provenance.file ? spec.provenance : null;
  if (!given) return null;
  const history = [...(Array.isArray(given.history) ? given.history : []),
    { at: shippedAt, what: `shipped as ${title}${publishAt ? '' : ' (unscheduled)'}` }];
  // The spec's products are what actually ships (minted after the provenance was assembled), so
  // their links and subids win; the provenance keeps the WHY, EPC, pod and Jev reading. Spec order
  // is heavy first, which keeps the first Product:/Link:/Subid1: on the heavy product.
  const shipped = (spec.products || []).filter((p) => p?.asin);
  const known = Array.isArray(given.products) ? given.products : [];
  const products = shipped.length
    ? shipped.map((p, i) => ({ ...(known.find((k) => k?.asin === p.asin) || { placement: i === 0 ? 'heavy' : i === 1 ? 'light' : `extra-${i + 1}` }),
      asin: p.asin, title: p.title || known.find((k) => k?.asin === p.asin)?.title || null, link: p.link || null, subid1: p.subid1 || null }))
    : known;
  const provenance = { ...given, products: shipped.length || Array.isArray(given.products) ? products : given.products };
  return {
    render: (existing = '', { draftId = null, shareUrl = null } = {}) => refreshNote(existing, renderNote(provenance,
      { tweets, state: 'shipped', shippedAt, publishAt, title, draftId, shareUrl, runId: provenance.runId, rowId: provenance.rowId, history })),
    check: { state: 'shipped', asins: products.map((p) => p?.asin).filter(Boolean),
      needsSource: !!provenance.source && !isNotRead(provenance.source) },
  };
}

export const publicationContentLane = (spec = {}) => laneOf(spec.contentLane) || ((spec.harvestOf || spec.variationOf) ? 'harvest' : (spec.moldId || spec.potOf) ? 'seed' : 'cover');

// The ledger's ctaStyle stamp: the spec's declared style, or null. It used to default to 'payoff',
// which put every undeclared hand-written thread into the payoff cohort of the CTA split test
// (registry 'CTA Style') and polluted the readout. Null reads as "not declared" everywhere the
// stamp is consumed (facts-build, registry-sync, recreate's alternation all skip it).
export const ledgerCtaStyle = (spec = {}) => spec.ctaStyle || null;

/**
 * Turn the /run review draft the owner approved INTO the shipped draft, in place.
 *
 * The copy the owner read already sits in this page's own set as `[REVIEW] …`; shipping rewrites it
 * with the final title, scratchpad, cross-post copy and publish time. Every refusal below exists
 * because the alternative is worse than stopping: this call OVERWRITES a draft, so it must be
 * certain the draft is the one the run wrote, and it must never fall back to creating a second copy
 * — that duplicate in a live queue is exactly what the single-draft rule removes.
 */
/**
 * PURE. The adopt body with the review draft's media carried over, tweet by tweet. The /run media pass
 * (scripts/run-media.mjs) puts Jev-picked media on the [REVIEW] draft, and the owner approves the thread
 * with its media there; the ship body is rebuilt from the approved copy, which has none, so without this
 * the adoption PATCH would strip every picture and clip. Only called once the copy check has passed (same
 * tweets, same order). A platform the review draft lacks takes the X media when its post count matches X's.
 */
export function carryReviewMedia(body, before) {
  if (!body?.platforms) return body;
  const plats = body.platforms;
  const src = before?.platforms || {};
  const xMedia = (src.x?.posts || []).map((p) => p?.media_ids || []);
  const out = {};
  for (const [key, plat] of Object.entries(plats)) {
    const posts = plat?.posts;
    if (!Array.isArray(posts)) { out[key] = plat; continue; }
    const from = Array.isArray(src[key]?.posts) && src[key].posts.length === posts.length ? src[key].posts.map((p) => p?.media_ids || [])
      : posts.length === xMedia.length ? xMedia : null;
    out[key] = from ? { ...plat, posts: posts.map((p, i) => ((p.media_ids || []).length || !from[i]?.length ? p : { ...p, media_ids: [...from[i]] })) } : plat;
  }
  return { ...body, platforms: out };
}

// COPY AND MINUTE GUARD (R1, 2026-09-23). The review draft is a live object the owner can edit, and
// the approved copy is what was reviewed: adoption refuses unless the draft's posts still hash to the
// approved digest (or to what the run last pushed), and the readback minute must equal publish_at.
export async function adoptReviewDraft(tf, acc, draftId, body, { note = null, approvedSha256 = null, pushedSha256 = null, approvedTweets = null } = {}) {
  const id = String(draftId);
  const before = await tf.getDraft(acc.socialSetId, id);
  if (!before?.id) throw new Error(`review draft ${id} is not in ${acc.name}'s set (${acc.socialSetId}) — do not ship until you know which draft the run wrote`);
  const title = String(before.draft_title || '');
  if (!title.startsWith(REVIEW_PREFIX)) throw new Error(`draft ${id} is titled ${JSON.stringify(title)}, not a ${REVIEW_PREFIX} draft — refusing to overwrite a draft this run did not write`);
  if (String(before.status || '') !== 'draft' || before.scheduled_date || before.publish_at) {
    throw new Error(`review draft ${id} is already ${before.status}${before.scheduled_date ? ` for ${before.scheduled_date}` : ''} — inspect it in Typefully before shipping this thread`);
  }
  const accepted = [approvedSha256, pushedSha256].filter(Boolean);
  if (!accepted.length && !Array.isArray(approvedTweets)) throw new Error(`review draft ${id}: no approved copy digest was supplied — adoption must be bound to the copy the owner approved`);
  const live = liveTweets(before);
  const liveSha = tweetsSha256(live);
  // The review draft is written before minting, so it may carry {{LINK}} tokens where the ship copy
  // carries the minted links: compared as approved tweets, only the tracking links may differ.
  const sameWords = Array.isArray(approvedTweets) && tweetsSha256(trackingNeutral(live)) === tweetsSha256(trackingNeutral(approvedTweets));
  if (!accepted.includes(liveSha) && !sameWords) {
    throw new Error(`review draft ${id}'s copy differs from the approved copy (live ${liveSha.slice(0, 12)}) — it was edited in Typefully; re-run the drafts review before shipping`);
  }
  // THE NOTE (plan R2). With a provenance note, the shipped note is rendered INTO the review draft's
  // own note, so the owner's text around the machine block and the review history both carry over.
  if (note?.render) body = { ...body, scratchpad_text: note.render(before.scratchpad_text || '') };
  // The media the owner approved on the review draft ships with it (the /run media pass).
  body = carryReviewMedia(body, before);
  await tf.patchDraft(acc.socialSetId, id, body);
  const after = await tf.getDraft(acc.socialSetId, id);
  // Report-only (plan §6 item 15): a note that did not land is a warning on the receipt, never a
  // reason to stop a thread that is otherwise correctly adopted.
  if (note?.check && after) after.noteCheck = noteCheck(after.scratchpad_text, note.check);
  // Read back what actually landed. A patch that silently kept the review title would leave the
  // thread invisible to registry-sync and the queue jobs, which read titles to decide what is ours.
  if (String(after?.draft_title || '').startsWith(REVIEW_PREFIX)) {
    throw new Error(`draft ${id} still carries the ${REVIEW_PREFIX} title after the update — it is not a published thread; fix it in Typefully before retrying`);
  }
  if (body.publish_at && !(after?.scheduled_date || after?.publish_at)) {
    throw new Error(`draft ${id} was not scheduled for ${body.publish_at}; read its state in Typefully before retrying`);
  }
  if (body.publish_at) {
    const minute = (v) => Math.floor(Date.parse(v) / 60_000);
    const landed = after.scheduled_date || after.publish_at;
    if (!Number.isFinite(minute(landed)) || minute(landed) !== minute(body.publish_at)) {
      throw new Error(`draft ${id} was scheduled for ${landed}, not the approved ${body.publish_at}; fix it in Typefully before anything else ships`);
    }
  }
  return after;
}

const pExecFile = promisify(execFile);
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const BURNER = process.argv.includes('--burner');

async function main(filePath = arg('file'), resultChannel = null) {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const spec = JSON.parse(readFileSync(filePath, 'utf8'));
  const lineage = publicationLineage(spec); // reject contradictory identity before provider writes
  // BURNER LANE (operator 2026-08-23): --burner posts to the GeniusGTX Threads staging page.
  // Finished threads AND fragments are both welcome, so the monetization requirements (products,
  // minted links, the full engine gate set, the ledger row) do not apply — only the per-tweet laws
  // that protect any timeline: 280, no placeholders, no banned topics, no em dashes.
  const acc = BURNER ? ACCOUNTS.burner : ACCOUNTS[resolveAccountKey(spec.account)];
  if (!acc) throw new Error(`unknown account "${spec.account}"`);
  const products = (spec.products || []).filter((p) => p?.link);
  if (!products.length && !BURNER) throw new Error('no products with minted links — mint first (Actions → Money · Mint link)');

  // Canonical spacing on plugs (same normalizer the engine ships), em-dash sweep everywhere, and the
  // account's own-site line before the sign-off (no-op without siteCta). copy-change.mjs owns this
  // reflow so the /run change classifier hashes exactly what ships.
  const plugLinks = products.map((p) => p.link);
  const tweets = publishCopy(spec.tweets, { plugLinks, account: copyAccount(spec, acc) });

  // The SAME gates the engine runs, including the substance-bridge law. The burner keeps only the
  // per-tweet laws — a fragment has no hook to gate and possibly no plug to structure.
  const operatorEdit = BURNER ? null : operatorEditOf(spec);
  const gateIssues = BURNER ? [] : validateDraft(tweets, plugLinks, acc, true, products,
    // shape/firstPlugAt only ever LOOSEN the first-plug window, for a deep dive whose buying
    // criterion cannot honestly be stated by tweet 4. Neither can push past LAWS.plugs.warnWindowMax.
    { allowUnsold: spec.allowUnsold || [], shape: spec.shape || null, firstPlugAt: spec.firstPlugAt ?? null,
      // ctaDepth = tweets the first ask occupies. 3 (point + bridge + plug) is the operator's
      // default; declare it or the gate judges the link tweet as the whole CTA.
      ctaDepth: spec.ctaDepth ?? 1 });
  const qc = BURNER
    ? checkThread(tweets, { account: acc, link: plugLinks[0], monetized: false }).filter((i) => i.severity === 'error' && /280|placeholder|banned|em.dash/i.test(i.code + i.msg))
    : checkThread(tweets, { account: acc, link: plugLinks[0], monetized: true, arm: spec.arm || null }).filter((i) => i.severity === 'error');
  tweets.forEach((t, i) => { const l = effLen(t); if (l > 280) gateIssues.push(`tweet #${i + 1} over 280 (${l})`); });
  // The style pilot's build tag has to be one the readout can join on (style-pilot.mjs).
  if (!BURNER) gateIssues.push(...styleArmIssues(spec));
  // The operator-edit rule settles structure findings only; everything else in gateIssues still blocks.
  const afterOwner = operatorEdit ? splitOperatorEdit(gateIssues) : { issues: gateIssues, waived: [] };
  // Craft findings Jev's editorial read settled for this row (run-row shipSpecFor -> jevSettled, v7 N3).
  const jevSplit = BURNER ? { issues: afterOwner.issues, settled: [] } : splitJevSettled(afterOwner.issues, spec.jevSettled);
  const issues = jevSplit.issues, waived = afterOwner.waived, jevWaived = jevSplit.settled;
  if (issues.length || qc.length) {
    console.log(`✗ ${issues.length + qc.length} issue(s) — nothing written:`);
    for (const i of issues) console.log(`   · ${i}`);
    for (const i of qc) console.log(`   · [${i.code}] ${i.msg}`);
    process.exitCode = 1;
    return;
  }
  if (spec.harvestOf && !BURNER) {
    const led = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const w of rotationWarnings(led, { account: acc.name, harvestOf: spec.harvestOf })) console.warn(`  ⚠ ${w}`);
  }
  console.log(`✓ validation passed — ${tweets.length} tweets, ${plugLinks.length} product(s)`);
  if (jevWaived.length) {
    console.log(`  ⚠ Jev settled ${jevWaived.length} craft finding(s) (editorial read found no craft problem):`);
    for (const w of jevWaived) console.log(`     · ${w}`);
  }
  if (waived.length) {
    console.log(`  ⚠ operator edit — ${waived.length} structure finding(s) ship as the operator edited them:`);
    for (const w of waived) console.log(`     · ${w}`);
  }
  // HOOK GATE (operator 2026-09-06: "floor should be a lot higher... 85%+ when possible"). The hook
  // is the ONE part of a cover we do not invent: it is the sentence that already earned the views.
  // This block used to be a readout — a WARN, because "the drift is sometimes correct and the
  // publisher cannot adjudicate it". Then the Sep 4-6 posts were measured: 37 of 47 covers sat
  // below the old 0.72 floor and their median was 79K views against 1.43M for hooks in band, an
  // 18x gap on the same pages and the same fuel, and the drift got worse with every day of the
  // batch (7 of 16, then 12 of 13, then 13 of 13). The four cases where drift IS correct are now a
  // declaration on the spec (hookDrift: { class, note }), so the publisher no longer has to
  // adjudicate: a cover ships at coverFloor, or between gateMin and coverFloor with the class
  // named, or not at all. hookGate in hooks-check.mjs is the rule; this is the door.
  //
  // Read the donor from the swipe row, not from what the author pasted: the spec's own source block
  // wins where given, Airtable fills the rest. Fetched HERE, above the dry return, because --dry is
  // exactly when a writer wants to see the number. Harvests (verbatim bodies), pots and seeds (no
  // donor) and the burner are exempt; a cover whose donor cannot be measured passes with a warning,
  // because the refusal is for a hook that drifted, never for a spec missing a field.
  //
  // Fetched whenever the spec is missing EITHER half — the hook or the URL. It used to be gated on
  // the hook alone, so a spec that pasted its donor's hook but not its link fetched nothing, and the
  // ledger's `sourceUrl` fell back to null. registry-sync writes `Source Thread` from that field and
  // from nothing else, so the donor vanished from the registry: every cover from 2026-09-04 to 09-07
  // (77 rows) has no donor recorded, which silently took donor-arm, the archive-arm readout and any
  // "is the batch repeating itself" question offline. The spec always carries `recId` because media
  // resolution needs it, so deriving the URL from the record is the version that cannot be forgotten.
  const fetched = (spec.source?.hook && spec.sourceUrl) ? null : await fetchSource(spec.recId, env);
  const donorHook = spec.donorHook || fetched?.hook || null;
  const donorUrl = spec.sourceUrl || fetched?.url || null;
  //
  // REMIX IS ITS OWN LANE (operator 2026-09-17, planning Run 5's 20/20 cover-remix split). A remix
  // keeps the donor's SHAPE and throws the subject away — that is the whole definition in
  // .claude/skills/remix-thread: layer 1 is the promise mechanic, layer 3 is every word of the
  // topic, and layer 3 is written fresh. So a remix hook is SUPPOSED to share almost nothing with
  // its donor's wording, and measuring it against coverFloor refuses the lane by construction.
  //
  // The lane fell through to 'cover' here until now, and the only remixes that ever shipped did so
  // by leaving `recId` blank on the burner: with no recId there is no donor to fetch, hookSim comes
  // back null, and the gate passes it as "unmeasured". That is a gate disabled by an empty field,
  // which is the same failure mode as a run pointed at a phase that does not exist. Naming the lane
  // is the honest version, and it also lets a remix keep its recId — Run 5 needs that, because its
  // cover and its remix of the SAME donor are the comparison the split exists to make.
  //
  // Measured, recorded, not refused: hookSim is still computed for a remix and still rides the
  // ledger row, so the next autopsy can ask what remix fidelity actually does to reach. It simply
  // does not decide whether the thread ships.
  const hookLane = BURNER ? 'burner' : spec.potOf ? 'pot' : spec.variationOf ? 'variation' : spec.harvestOf ? 'harvest' : spec.moldId ? 'seed' : spec.lane === 'remix' ? 'remix' : 'cover';
  let hookSim = null;
  if (donorHook && (hookLane === 'cover' || hookLane === 'remix')) {
    // Measure the hook BODY, excluding the attached "1. <item>" line — item 1 belongs to the outline,
    // not the donor, so counting it drags an in-band hook below target (measured live: 86% body read
    // as 76% whole-tweet on the first harvest, purely because item 1 differed as designed).
    const att = /(^|\n)\s*\d+[.)]\s/.test(donorHook);
    hookSim = Math.round(hookSimilarity(hookBodyText(tweets[0], att), hookBodyText(donorHook, att)) * 100);
  }
  // `recId` decides whether an unmeasured cover is a pass or a refusal: a spec naming a donor whose
  // hook we could not read has not been checked, and three Run 5 covers took that branch straight
  // past the duplicate edge. A spec with no donor at all has nothing to check and still passes.
  const hookVerdict = hookGate({ sim: hookSim == null ? null : hookSim / 100, lane: hookLane, hookDrift: spec.hookDrift || null, recId: spec.recId || null });
  if (hookLane === 'remix' && hookSim != null) {
    console.log(`  hook fidelity: ${hookSim}% of the donor — remix, recorded not gated (the shape is kept, the subject is not)`);
  }
  if (hookLane === 'cover') {
    if (hookSim == null) console.log(`  ${hookVerdict.ok ? '⚠' : '✗'} hook fidelity ${hookVerdict.why}`);
    else console.log(`  hook fidelity: ${hookSim}% of the donor${hookVerdict.ok ? (hookVerdict.why ? ` — ${hookVerdict.why}` : hookSim > Math.round(LAWS.hook.targetMax * 100) ? ' — in band, tight' : ' — on target') : ''}`);
    // The operator's edit settles a hook under the floor; never the duplicate edge or an unmeasured donor.
    if (!hookVerdict.ok && operatorEdit && operatorEditSettlesHook(hookVerdict, hookSim == null ? null : hookSim / 100)) {
      waived.push(`hook ${hookSim}% of the donor, under the ${Math.round(LAWS.hook.coverFloor * 100)}% floor`);
      console.log(`  ⚠ operator edit — the hook ships as the operator wrote it (${hookSim}% of the donor)`);
    } else if (!hookVerdict.ok) { console.log(`✗ hook gate — nothing written:\n   · ${hookVerdict.why}`); process.exitCode = 1; return; }
  }
  tweets.forEach((t, i) => console.log(`  [${i + 1}] ${effLen(t)} chars${plugLinks.some((l) => t.includes(l)) ? ' PLUG' : ''}`));
  if (DRY) { resultChannel?.validated(); console.log('\n(dry — nothing written)'); return; }

  const at = arg('at'); // omit => UNSCHEDULED review draft
  const tf = typefully(env);
  // THE RECORD (operator 2026-08-25). The draft's scratchpad is where a human actually looks, so it
  // carries the whole provenance with the SOURCE FIRST — donor hook, its link, its Airtable card —
  // and a durable copy lands in queues/threads/ because a Typefully note cannot be grepped a month
  // from now. spec.source is optional; whatever the author knows gets recorded, the rest reads as
  // "(none recorded)" rather than silently looking complete.
  // [Cover] replaced [Infinity] for NEW skill-written work on 2026-09-02 (the farm's naming);
  // existing [Infinity] titles are never rewritten and stay schedulable. A pot names its seed
  // family in the token itself — [Pot·mango] — so spec.potOf (the fruit slug) is the switch.
  const lane = BURNER ? 'BURNER' : spec.potOf ? 'Pot' : (spec.harvestOf || spec.variationOf) ? 'Harvest' : 'Cover';
  // Read the donor from the swipe row, not from what the author pasted: the spec's own source block
  // wins where given, Airtable fills the rest. A spec that names no recId simply gets no fetch.
  const record = buildRecord({
    // acc.name, not the spec's account KEY: the record and the draft title are read by humans, so
    // they carry "Tina De Jong" rather than "tina".
    // The record is committed (queues/threads), so an inline provenance goes in without the donor's
    // text: its tweet count and shas only (redactProvenance).
    spec: { ...spec, account: acc.name, ...(spec.provenance ? { provenance: redactProvenance(spec.provenance) } : {}) }, source: { ...(fetched || {}), ...(spec.source || {}) }, lane, version: Number(spec.version) || 1,
    // Canonical since 2026-08-29 (lanes.mjs): cover / harvest / seed. Older records carry the
    // spellings these replaced — swipe, repost, mold, viral — and laneOf maps them on read; none
    // of them is rewritten, because the ledger joins revenue on rows that already shipped.
    contentLane: publicationContentLane(spec),
    baseId: env.XDB_BASE_ID,
    built: {
      writerLane: spec.writerLane || 'chat', by: spec.builtBy || 'chat (hand-written)', model: spec.model || null,
      // The "how" line carries what the writer decided (operator 2026-09-06, "what happened to all
      // the details"): the CTA arm, the pods pasted, the hook's fidelity, and the spec's own note —
      // the intent score, the pair and the weld sentence — so the draft explains itself.
      how: spec.builtHow || [
        spec.cta ? `${spec.cta} arm` : null,
        [].concat(spec.pods || []).length ? `pods ${[].concat(spec.pods).join('+')} pasted` : (spec.cta ? 'no pod pasted' : null),
        hookSim != null ? `hook ${hookSim}% of the donor${spec.hookDrift?.class ? ` (${spec.hookDrift.class} drift declared)` : ''}` : null,
        spec.note ? String(spec.note).trim() : null,
      ].filter(Boolean).join(' · ') || 'skill: write-thread / money-thread',
      gates: waived.length ? `operator-edit rule, ${waived.length} hook/structure finding(s) shipped as edited: ${operatorEdit.message}` : 'validateDraft clean at publish',
      what: spec.changeNote || 'first ship',
    },
  });
  // PER-PLATFORM LINKS (operator 2026-08-27, "turn on for every Threads cross post"). Levanta
  // reports on subids and never on referrers, so a cross-post that carries X's links is physically
  // unmeasurable — which is exactly why "how many clicks came from Threads" had no answer. Each
  // enabled platform now gets its own mint, subid + "-th". Fails soft: a mint failure falls back to
  // X's links, losing the split rather than the post.
  const xPosts = tweets.map((t) => ({ text: t }));
  const { platformPosts, minted: xpMinted } = await crossPostLinks(env, acc, xPosts, products);
  // THE LINK CHECK BEFORE ANYTHING IS SCHEDULED (owner, 2026-09-24: "link sentinel should be part of
  // the final check before publish too. That way we are sure the links work."). Every tracked link
  // on every platform, judged the way link-sentinel judges it: it must land on a product page, and
  // it is dead only if dead twice, a pause apart. One dead link and nothing is written.
  if (at && !BURNER) {
    const urls = scheduledLinks(xPosts, platformPosts);
    const gate = await linkGate(urls);
    if (gate.dead.length) {
      console.log(`✗ ${gate.dead.length} dead link(s) — nothing written, nothing scheduled:`);
      for (const d of gate.dead) console.log(`   · ${d.url} — ${d.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ links live — ${gate.checked} tracked link(s) resolve to product pages${gate.flaky.length ? ` (${gate.flaky.length} passed on the recheck)` : ''}`);
  }
  // A /run spec carries its provenance and ships with the source note; any other spec keeps the
  // record note exactly as before.
  const resolved = BURNER ? { provenance: null, warning: null } : resolveProvenance(spec);
  if (resolved.warning) console.warn(`  ⚠ ${resolved.warning} — shipping with the record note`);
  const note = resolved.provenance ? shippedNote(spec, { tweets, title: record.thread.title, publishAt: at, shippedAt: new Date().toISOString(), provenance: resolved.provenance }) : null;
  const body = {
    draft_title: record.thread.title,
    scratchpad_text: note ? note.render('') : renderScratchpad(record),
    share: true,
    platforms: buildPlatforms(xPosts, { account: acc, platformPosts }),
    ...(at ? { publish_at: at } : {}),
  };
  // ONE DRAFT PER THREAD (operator 2026-09-22: "it's the same draft. Every thread should only ever
  // have one draft and it sits exactly on the accounts it is going to publish for"). A collaborative
  // /run has already written this thread into this page's own set as a [REVIEW] draft for the owner
  // to read; spec.reviewDraftId names it, and shipping REWRITES that draft rather than creating a
  // second copy of the same thread in the same queue. Without the field nothing changes.
  // The review draft must still hold the approved copy: spec.approvedCopySha256 when the run supplies
  // it (the drafts packet's exact copy digest), or the spec's own tweets, which are the approved copy
  // (tracking links aside: the review draft may predate minting).
  const draft = spec.reviewDraftId && !BURNER
    ? await adoptReviewDraft(tf, acc, spec.reviewDraftId, body, { note,
      approvedSha256: spec.approvedCopySha256 || null, pushedSha256: spec.reviewPushedSha256 || null,
      approvedTweets: spec.tweets.map(String) })
    : await tf.createDraft(acc.socialSetId, body);
  const shareUrl = draft.share_url || `https://typefully.com/?d=${draft.id}`;
  resultChannel?.confirm(draft.id, shareUrl);
  console.log(`\n✓ Draft ${spec.reviewDraftId && !BURNER ? 'adopted' : 'created'}: ${draft.id}${at ? ` (scheduled ${at})` : ' (UNSCHEDULED — review before it can post)'}\n  ${shareUrl}`);
  if (draft.noteCheck) console.log(draft.noteCheck.ok ? '  ✓ note read back: SHIPPED header, source line and every ASIN'
    : `  ⚠ note readback: missing ${draft.noteCheck.missing.join(', ')} — the thread is adopted; fix the note in Typefully`);
  else if (spec.reviewDraftId && !BURNER && !note) console.log('  ⚠ no provenance on this spec — the adopted draft carries the record note, not the /run source note');
  // The draft id and share url only exist AFTER creation, so the record is completed and the note
  // rewritten here — one PATCH, so the scratchpad the operator opens carries its own draft link.
  record.thread.draftId = String(draft.id);
  record.thread.shareUrl = shareUrl;
  record.history[record.history.length - 1].draftId = String(draft.id);
  try {
    const file = writeRecord(record);
    await tf.patchDraft(acc.socialSetId, draft.id, { scratchpad_text: note
      ? note.render(draft.scratchpad_text ?? body.scratchpad_text, { draftId: String(draft.id), shareUrl })
      : renderScratchpad(record) });
    console.log(`  record: ${file.replace(HERE_DIR + '/', '')}`);
  } catch (e) { console.log(`  ⚠ record not written: ${e.message}`); } // never fail a shipped thread over bookkeeping

  // LEDGER BEFORE MEDIA — this order is load-bearing, not stylistic. media.mjs resolves a draft's
  // donor by looking up its draftId in ledger.jsonl; running it first means the lookup finds
  // nothing, it exits 0 having done nothing, and the thread ships with no media while the log
  // still says "media pass done". Every hand-written thread went out bare until 2026-08-17.
  if (BURNER) {
    console.log('  (burner — no ledger row, no media pass: this is a preview, not a shipped thread)');
    return;
  }
  const [heavy, light, ...extra] = products;
  appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), account: acc.name, recId: spec.recId || null, draftId: draft.id,
    mode: 'monetized', ...(spec.moldId ? { moldId: spec.moldId } : {}), handWritten: true,
    // writerLane / writerModel: the join that makes "which writer converts better" a query instead
    // of archaeology. Absent from all 810 rows before 2026-08-25, which is why it was unanswerable.
    writerLane: record.writer.lane, ...(record.writer.model ? { writerModel: record.writer.model } : {}),
    // harvestOf is a verbatim attempt; variationOf records a rewritten body's parent without a heart.
    ...lineage,
    // potOf = the seed family (fruit slug) a pot was filled from; batch = the generation run.
    // These join a pot to its Seeds row (harvest-gate backfill path) even if the PC stamp fails.
    ...(spec.potOf ? { potOf: String(spec.potOf), ...(spec.seedVersion != null ? { seedVersion: spec.seedVersion } : {}) } : {}),
    ...(spec.batch ? { batch: String(spec.batch) } : {}),
    ...(spec.retrofit ? { retrofit: true, ...(spec.retrofitOf ? { retrofitOf: String(spec.retrofitOf) } : {}) } : {}),
    // warmSlot: this thread's plug stands in the donor's own sell slot (spec sets donorSlot on the
    // product row) — the stamp that lets revenue of warm-slot plugs be compared to standard pods.
    ...(products.some((p) => p.donorSlot) ? { warmSlot: true } : {}),
    subid1: heavy.subid1, asin: heavy.asin, product: heavy.title, link: heavy.link,
    ctaStyle: ledgerCtaStyle(spec),
    // ctaSystem (operator 2026-09-06: backline is the main active system): read off the text, never
    // declared — 'backline' when every plug's bridge and plug carry the template's fixed lines, else
    // 'fresh'. The ledger is how the two are compared; without this the 0-of-275 drift was invisible.
    ...(ctaSystemOf(tweets) ? { ctaSystem: ctaSystemOf(tweets) } : {}),
    // hookSim (0-100) and the declared drift class, so the next autopsy joins views to fidelity
    // without re-fetching every donor.
    ...(hookSim != null ? { hookSim } : {}), ...(spec.hookDrift?.class ? { hookDrift: spec.hookDrift.class } : {}),
    // dials: a cover-pot's ticket (laws.json farm.$coverAsPot), so a 48h read is attributed to the change it names.
    ...(spec.lane !== 'remix' && Array.isArray(spec.dials) && spec.dials.length ? { dials: spec.dials.map((d) => `${d.dial}:${d.to}`) } : {}),
    // styleArm: the style pilot's build (wil / pb; absent = control), so the readout joins on what shipped.
    ...(spec.styleArm ? { styleArm: spec.styleArm } : {}),
    // pods: the pod ids the writer PASTED (spec.pods, e.g. ["BE1","BR1"]). The engine stamps podsUsed
    // itself; a hand-written spec has to say so, or a pasted pod and a fresh write on the same
    // template are indistinguishable in the ledger, which is exactly the split the run needs to read.
    ...(Array.isArray(spec.pods) && spec.pods.length ? { pods: spec.pods.map((id) => (typeof id === 'string' ? { id } : id)) } : {}),
    ...(light ? { asin2: light.asin, product2: light.title, link2: light.link, subid1b: light.subid1 } : {}),
    // brandLane: the plugs carry a brand's own link (brand-lanes.mjs), not a Levanta mint; revenue comes
    // from the brand's dashboard, so a Levanta readout must leave these rows out.
    ...(products.some((p) => p.linkMode === 'brand') ? { brandLane: products.find((p) => p.brandLane)?.brandLane || true } : {}),
    ...(spec.plugMoves ? { plugMoves: spec.plugMoves } : {}),
    // operatorEdit: the operator's words and each hook/structure finding it shipped through, so a read
    // of what shipped can tell an operator-edited thread from one the gate passed clean.
    ...(operatorEdit ? { operatorEdit: { ...operatorEdit, waived } } : {}),
    ...(jevWaived.length ? { jevSettled: { by: spec.jevSettled?.by || 'editorial-prescore', waived: jevWaived } } : {}),
    sourceUrl: donorUrl, topic: classifyTopic(tweets[0] || '', tweets.join(' ')),
  }) + '\n');
  // A roundup can plug more than two products, and the ledger row only carries two (subid1 +
  // subid1b). Each additional product gets its OWN attribution row against the same draft — the
  // shape revenue.mjs already joins on, so nothing downstream needs to learn a new format.
  for (const p of extra) {
    appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), account: acc.name, recId: spec.recId || null, draftId: draft.id,
      mode: 'monetized', attributionOnly: true, handWritten: true,
      subid1: p.subid1, asin: p.asin, product: p.title, link: p.link,
      ctaStyle: ledgerCtaStyle(spec), ...(ctaSystemOf(tweets) ? { ctaSystem: ctaSystemOf(tweets) } : {}), sourceUrl: donorUrl,
      topic: classifyTopic(tweets[0] || '', tweets.join(' ')),
    }) + '\n');
  }
  // Each cross-posted platform's own link needs its own attribution row, or its clicks arrive at
  // Levanta under a subid the ledger has never heard of and land in the unattributed pile.
  for (const row of crossPostLedgerRows(xpMinted, { account: acc.name, draftId: draft.id, recId: spec.recId || null })) {
    appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(row) + '\n');
  }
  console.log(`✓ Ledger: 1 row + ${extra.length} attribution row(s)${xpMinted.length ? ` + ${xpMinted.length} cross-post row(s)` : ''} — revenue joins on each subid`);

  // FARM STAMP (2026-09-02): a pot (or any batch-tagged draft) pre-links its own PC row at
  // creation — Seed link, Seed Version, Batch, verdict Pending — so the gate's 48h clock starts
  // from a linked row. Stamp-at-creation, gate-backfill-on-failure: the ledger's potOf/batch
  // fields above are the fallback join, so a failed stamp costs one sync of lag, never the link.
  if (spec.potOf || spec.batch) {
    try {
      await airtable(env, env.REGISTRY_BASE_ID).upsert(REGISTRY_TABLE, 'Draft ID',
        [farmStampRow({ draftId: draft.id, seedRecId: spec.seedRecId || null, potRecId: spec.potRecId || null, seedVersion: spec.seedVersion ?? null, batch: spec.batch || null, verdict: spec.potOf ? 'Pending' : null })]);
      console.log(`  ✓ farm stamp: ${spec.potOf ? `pot of ${spec.potOf}` : 'batch'}${spec.batch ? ` · ${spec.batch}` : ''}`);
    } catch (e) { console.log(`  ⚠ farm stamp failed (the gate backfills from the ledger): ${String(e.message).slice(0, 80)}`); }
  }

  // Source media (operator rule: a thread pulled from a viral source carries its media). Runs AFTER
  // the ledger row and the farm stamp exist, so the resolver has something to read. "0 media item(s)"
  // is reported rather than swallowed — a bare thread should be a visible outcome, not a silent one.
  //
  // TWO LANES, ONE PASS. A recreation follows its DONOR (media.mjs, via the Airtable swipe row). A
  // PLANT has no donor — it descends from a seed — so it follows its seed's ORIGIN (seed-media.mjs,
  // via the registry stamp written just above). Every plant this farm shipped before 2026-09-06 went
  // out text-only, not by decision but because media.mjs resolved null on them and exited 0. The
  // spec's own seedRecId is passed through so the pass never depends on the stamp having landed.
  if (!ATTACH_MEDIA) { console.log('  media: off (config.mjs ATTACH_MEDIA, owner 2026-09-23: no old media until the new system)'); return; }
  const seedLane = !!(spec.seedRecId || spec.potOf);
  const mediaArgs = seedLane
    ? [join(HERE_DIR, 'seed-media.mjs'), String(draft.id), '--account', String(spec.account).toLowerCase(), ...(spec.seedRecId ? ['--seed', String(spec.seedRecId)] : [])]
    : [join(HERE_DIR, 'media.mjs'), String(draft.id), '--account', String(spec.account).toLowerCase()];
  try {
    const { stdout } = await pExecFile('node', mediaArgs, { encoding: 'utf8', timeout: 300000 });
    const attached = (String(stdout).match(/^ {2}✓ uploaded /gm) || []).length;
    const textOnly = /is text-only — nothing to carry|Reference is text-only/.test(String(stdout));
    const from = seedLane ? "the seed's origin" : 'the donor';
    if (attached) console.log(`✓ media pass: ${attached} item(s) carried from ${from}`);
    else if (textOnly) console.log(`✓ media pass: ${from} is text-only — nothing to carry (this is a normal outcome)`);
    else console.log(`⚠ media pass ran but attached NOTHING — check ${from} has media that maps`);
  } catch (e) { console.warn(`⚠ media pass skipped: ${((e.stderr || e.message) || '').slice(0, 140)}`); }
}

// --dir: gate (or ship) a whole batch in ONE process. Per-thread invocation is correct for a
// one-off and wasteful for a slate: 22 threads cost 44 launches and ~18 seconds of pure Node
// startup, and the pass/fail picture arrives scattered across 44 blocks of output instead of as one
// table you can act on.
//
// Order inside the loop is deliberate. Specs run sorted by filename so a batch is reproducible, and
// a spec that throws is CAUGHT rather than allowed to abort the run — one malformed file must not
// cost the other 21 their ship. The exit code is still 1 if anything failed, so a workflow step can
// gate on it.
export async function runDir(dir, { dry = DRY, run = main, files: given = null } = {}) {
  const files = given || readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results = [];
  for (const f of files) {
    const path = join(dir, f);
    process.exitCode = 0;                       // main() sets 1 on gate failure; read it per file
    let err = null;
    console.log(`\n──── ${f}`);
    try { await run(path); } catch (e) { err = (e.message || String(e)).slice(0, 120); }
    results.push({ file: f, ok: !err && process.exitCode !== 1, why: err || (process.exitCode === 1 ? 'gate' : null) });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${'═'.repeat(60)}\n${dry ? 'GATE' : 'SHIP'} — ${results.length - bad.length}/${results.length} clean\n`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.file}${r.why ? `   ${r.why}` : ''}`);
  if (bad.length) console.log(`\n${bad.length} need fixing before ${dry ? 'shipping' : 'the next run'}.`);
  process.exitCode = bad.length ? 1 : 0;
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = arg('dir');
  await runMain(dir ? () => {
    if (arg('result-file')) throw new Error('Result-file mode requires a single publish spec');
    return runDir(dir);
  } : () => withProcessResult(channel => main(undefined, channel)), 'publish-thread');
}
