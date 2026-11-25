#!/usr/bin/env node
// The final-copy Jev read (plan R1 "Final-copy Jev read (report-only) inside the automatic stage",
// §1.3 "Safety re-read on the final digest"). The owner edits drafts in Typefully after review (9 of 15
// on R2026-09-23), and nothing re-read that final text for safety before it shipped; Fuel T0 fires
// seconds after publish, so scheduling is the last moment to read the thread.
//
// ONE Jev call per row over the exact copy Typefully holds now: run-jev's whole safety battery
// (SAFETY_QUESTIONS: explicit, sexual behaviour, cancer, Rx, contrarian medicine, named quote,
// off-brand) with the tweet each class sits in, the owner's intake rules and the per-tweet claim
// pointers. The questions are run-jev's own (draftQuestions), never a second copy of them.
//
// REPORT-ONLY (plan §1.2 invariants 1, 2, 8): it never changes a row's status, holds or approval, and
// never writes to Typefully or Airtable (its one provider call is a GET). A failed or partial answer is
// "not read", never clean. It can only add a warning line.
//
//   node scripts/run-jev-final.mjs --run-dir RUN_DIR --input SCHEDULE_SPEC.json [--offline]
//
// The spec is the one scripts/plan-run-schedule.mjs reads. By default each row's copy is read live from
// its Typefully draft (the final text, owner edits included; one GET per row); --offline reads the
// spec's providerCopy and says so. Writes RUN_DIR/jev/final-copy.json (RUN_DIR must be outside Git: it
// quotes unpublished copy). plan-run-schedule.mjs prints it into each schedule packet as a
// `JEV final-copy:` line, and lists it for every row, held ones included (an owner edit holds a row).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { choice, jev } from '../jev.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { classifyCopyChange, copySha256, trackingNeutral } from '../copy-change.mjs';
import {
  assertRunDirOutsideRepo, draftFlags, draftQuestions, MAX_TWEETS, missingAnswers, named, ownerClauses, pool,
  RUN_JEV_MODEL, SAFETY_QUESTIONS, writeReadings,
} from './run-jev.mjs';
import { stripCommentMarkers } from './run-review-drafts.mjs';
import { runContentRules } from './run-rules.mjs';

export const FINAL_COPY_STAGE = 'final-copy';
export const FINAL_SAFETY_KEYS = Object.keys(SAFETY_QUESTIONS);
export const POINT_AT = 0.5; // a "which tweet" answer this sure names the tweet on the line
// "Which tweet …" for each class of the battery, so a flag says where to look.
const WHERE = {
  explicit: 'Which tweet is the most sexually explicit or crude?',
  sexual_behaviour: 'Which tweet is most about a sexual behaviour (for example masturbation, porn use or sexual performance habits)?',
  about_cancer: 'Which tweet is most about cancer (its causes, prevention, treatment or cure)?',
  rx_drug: 'Which tweet comes closest to telling the reader to take, stop or change a prescription drug?',
  contrarian_medicine: 'Which tweet most tells the reader that mainstream medical advice is wrong or dangerous?',
  named_quote: 'Which tweet attributes a quote or a claim to a named real person?',
  off_brand: 'Which tweet is most about politics, religion or breaking news?',
};
export const REREAD = 'read this copy in full before it ships';

/** The platform whose copy is read: X when the row posts there, else its first platform. */
export const primaryPlatform = (platforms) => (Array.isArray(platforms) && platforms.length ? (platforms.includes('x') ? 'x' : platforms[0]) : 'x');

/** Questions for one final copy: run-jev's battery, owner rules, claim pointers, and where each safety class sits. */
export function finalCopyQuestions(tweets, clauses = []) {
  const { questions: all } = draftQuestions({ tweets: tweets.map(String), products: [] }, clauses);
  const keep = (k) => FINAL_SAFETY_KEYS.includes(k) || /^owner_\d+$/.test(k) || /^claim_\d+$/.test(k);
  const q = Object.fromEntries(Object.entries(all).filter(([k]) => keep(k)));
  const options = Object.fromEntries(tweets.slice(0, MAX_TWEETS).map((_, i) => [`T${i + 1}`, null]));
  for (const key of FINAL_SAFETY_KEYS) q[`where_${key}`] = choice(WHERE[key], { ...options, none: 'No tweet does.' });
  return q;
}

/**
 * Pure: how the provider copy relates to the copy the owner approved.
 *   none         the provider copy is the approved copy
 *   spacing/formatting  the published words are the same (copy-change.mjs's one reflow definition)
 *   links        only the tracking links differ
 *   words        an owner edit: the text Jev read is newer than the reviewed text
 *   unknown      no approved copy or digest was supplied, so an edit cannot be ruled out
 */
export function ownerEdit(tweets, { approvedTweets = null, approvedSha256 = null } = {}) {
  const approved = Array.isArray(approvedTweets) ? approvedTweets.map(String) : null;
  const sha = approvedSha256 || (approved ? copySha256(approved) : null);
  if (!sha) return { kind: 'unknown' };
  if (sha === copySha256(tweets)) return { kind: 'none' };
  if (!approved) return { kind: 'words', digestOnly: true };
  const { kind } = classifyCopyChange(approved, tweets);
  if (kind === 'words' && copySha256(trackingNeutral(approved)) === copySha256(trackingNeutral(tweets))) return { kind: 'links' };
  return { kind };
}

/** A reader over the schedule spec's providerCopy ({ x: [{ text, mediaIds }] }): offline, and says so. */
export async function specCopy(row) {
  const copy = {};
  for (const [platform, posts] of Object.entries(row?.providerCopy || {})) copy[platform] = (posts || []).map((p) => String(p?.text ?? ''));
  return { copy, source: 'spec providerCopy, not re-read live' };
}

/** A reader over the live Typefully draft: GET only. The roster, never the spec, names the social set. */
export function typefullyCopy(tf, { accounts = ACCOUNTS, strip = stripCommentMarkers } = {}) {
  return async (row) => {
    const set = accounts[row?.account]?.socialSetId;
    if (!set) throw new Error(`${row?.account} has no social set in the roster`);
    if (row?.draft?.socialSetId != null && String(row.draft.socialSetId) !== String(set)) throw new Error('draft social set does not match the roster');
    if (!row?.draft?.id) throw new Error('no Typefully draft id');
    const draft = await tf.getDraft(set, row.draft.id);
    if (String(draft?.id ?? '') !== String(row.draft.id)) throw new Error(`draft ${row.draft.id} was not found in ${row.account}'s set`);
    const platforms = Array.isArray(row.platforms) && row.platforms.length ? row.platforms : ['x'];
    const copy = {};
    for (const p of platforms) copy[p] = (draft?.platforms?.[p]?.posts || []).map((post) => strip(post?.text));
    return { copy, source: 'Typefully, read live' };
  };
}

const reasonOf = (error) => `${error?.details?.code || error?.message || 'error'}`.slice(0, 160);
const digests = (copy) => Object.fromEntries(Object.entries(copy || {}).map(([p, t]) => [p, copySha256((t || []).map(String))]));

/**
 * One reading per row. `client` is jev(env) or a test fake with the same `ask`; `readCopy(row)`
 * returns { copy: { platform: [text] }, source }. Nothing here writes anywhere or touches the row.
 */
export async function readFinalCopy(rows, { client, readCopy = specCopy, other = '', rules = null, model = RUN_JEV_MODEL, concurrency = 6 } = {}) {
  const clauses = ownerClauses(other);
  return pool(rows, concurrency, async (row) => {
    const started = Date.now();
    const platform = primaryPlatform(row.platforms);
    const base = { id: row.id, platform };
    let got;
    try { got = await readCopy(row); } catch (error) { return { ...base, status: 'not read', reason: `provider copy not read: ${reasonOf(error)}` }; }
    const tweets = (got?.copy?.[platform] || []).map(String);
    const approvedTweets = Array.isArray(row.approvedCopy?.[platform]) ? row.approvedCopy[platform].map((p) => String(p?.text ?? '')) : null;
    const edit = ownerEdit(tweets, { approvedTweets, approvedSha256: row.approvedCopySha256 || null });
    // copySha256 binds the reading to the primary copy; copyDigests to every platform's copy it saw.
    const reading = { ...base, copySource: got?.source || 'unknown', copySha256: copySha256(tweets), copyDigests: digests(got?.copy), edit };
    // Another platform whose words differ from the one read was NOT read: the line says so.
    reading.unread = Object.entries(got?.copy || {}).filter(([p, t]) => p !== platform
      && copySha256(trackingNeutral(t)) !== copySha256(trackingNeutral(tweets))).map(([p]) => p);
    if (!tweets.length || tweets.every((t) => !t.trim())) return { ...reading, status: 'not read', reason: `no ${platform} copy to read` };
    try {
      const questions = finalCopyQuestions(tweets, clauses);
      const { askThrough } = await import('../jev-decide.mjs');
      const result = await askThrough('final-read', client, { state: { hook: tweets[0], tweets: named(tweets) }, questions }, { role: 'run-jev-final-copy' });
      const answers = result?.answers || {};
      const gaps = missingAnswers(questions, answers);
      if (gaps.length) return { ...reading, status: 'not read', reason: `Jev left ${gaps.length} question(s) unanswered (${gaps.slice(0, 4).join(', ')})` };
      // Sources are numbered against the reviewed copy: after a word edit the numbers may point at other
      // tweets, so every claim is reported as unsourced (monotone: an edit can only add warnings).
      const sources = edit.kind === 'none' || edit.kind === 'spacing' || edit.kind === 'formatting' || edit.kind === 'links' ? (row.sources || row.draft?.sources || []) : [];
      const flags = draftFlags(answers, { tweets, plugs: [], clauses, sources, rules }).map((f) => {
        if (f.kind !== 'safety') return f;
        const where = answers[`where_${f.key}`];
        const n = where?.choice && where.choice !== 'none' && where.confidence >= POINT_AT ? Number(where.choice.slice(1)) : null;
        return n ? { ...f, tweet: n } : f;
      });
      return { ...reading, status: 'read', model: result.model, ms: Date.now() - started, readTo: Math.min(tweets.length, MAX_TWEETS), tweets: tweets.length, flags };
    } catch (error) {
      return { ...reading, status: 'not read', reason: reasonOf(error) };
    }
  });
}

function editNote(edit) {
  switch (edit?.kind) {
    case 'words': return edit.digestOnly
      ? 'OWNER-EDITED: the Typefully copy differs from the approved digest, so Jev read text newer than the reviewed text'
      : 'OWNER-EDITED after review (words changed): Jev read the Typefully copy, newer than the reviewed text';
    case 'links': return 'tracking links differ from the approved copy';
    case 'spacing': case 'formatting': return `edited after review (${edit.kind} only: the published words are the approved ones)`;
    case 'unknown': return 'no approved copy supplied: an owner edit cannot be ruled out';
    default: return null;
  }
}

/** The one line for a reading, e.g. "JEV final-copy: about_cancer 0.91 (T4) · OWNER-EDITED …". */
export function finalCopyLine(r) {
  if (!r) return `JEV final-copy: not read (no final-copy read for this row; run scripts/run-jev-final.mjs) — ${REREAD}`;
  const tail = [editNote(r.edit), ...(r.unread || []).map((p) => `the ${p} copy differs and was not read`)].filter(Boolean);
  if (r.status !== 'read') return `JEV final-copy: not read (${r.reason})${tail.length ? ` · ${tail.join(' · ')}` : ''} — ${REREAD}`;
  const safety = r.flags.filter((f) => f.kind === 'safety').map((f) => `${f.key} ${f.p.toFixed(2)}${f.tweet ? ` (T${f.tweet})` : ''}${/excludes it/.test(f.note) ? ' [this run excludes it]' : ''}`);
  const rules = r.flags.filter((f) => f.kind === 'owner-rule').map((f) => f.note);
  const claims = r.flags.filter((f) => f.kind === 'claim').map((f) => `T${f.tweet} ${f.p.toFixed(2)}`);
  const head = [...safety, ...rules];
  const partial = r.tweets > r.readTo ? [`read to T${r.readTo} of ${r.tweets}: T${r.readTo + 1} onward NOT read`] : [];
  const verdict = head.length ? head.join(' · ') : partial.length ? `clean to T${r.readTo}` : 'clean';
  const extra = [...partial, ...(claims.length ? [`claims with no named source: ${claims.join(', ')}`] : []), ...tail];
  return `JEV final-copy: ${verdict}${extra.length ? ` · ${extra.join(' · ')}` : ''} (report-only · ${r.model} · ${r.copySource})`;
}

/**
 * The packet line, only for the exact copy the packet shows (`copy` is { platform: [text] }): a reading
 * of any other copy, on any platform, is not a read of this one.
 */
export function finalCopyLines(reading, copy) {
  if (!reading) return [`- ${finalCopyLine(null)}`];
  const shown = copy && typeof copy === 'object' && !Array.isArray(copy) ? digests(copy) : null;
  if (!shown || !shown[reading.platform]) return [`- JEV final-copy: not read (this row carries no provider copy to bind the reading to) — ${REREAD}`];
  const seen = reading.copyDigests || { [reading.platform]: reading.copySha256 };
  const drift = Object.keys(shown).filter((p) => shown[p] !== seen[p]);
  if (drift.length) return [`- JEV final-copy: not read (stale: Jev read a different ${drift.join('/')} copy than this packet shows; re-run scripts/run-jev-final.mjs) — ${REREAD}`];
  return [`- ${finalCopyLine(reading)}`];
}

/** The owner's intake answers. Only a missing file (an older run) reads as "no rules"; anything else fails. */
function readIntake(runDir) {
  try { return JSON.parse(readFileSync(join(resolve(runDir), 'intake.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`intake.json could not be read (${error.message}): the owner's rules would be silently skipped`); }
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const runDir = flag('run-dir'), input = flag('input'), offline = argv.includes('--offline');
  if (!runDir || !input) throw new Error('Usage: run-jev-final.mjs --run-dir RUN_DIR --input SCHEDULE_SPEC.json [--offline]');
  assertRunDirOutsideRepo(runDir); // refuse before any provider call, not after
  const spec = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const intake = readIntake(runDir);
  const { llmSpendSummary, loadEnv, typefully } = await import('../lib.mjs');
  const env = loadEnv();
  const readCopy = offline ? specCopy : typefullyCopy(typefully(env));
  const started = Date.now();
  const rows = await readFinalCopy(spec.rows || [], { client: jev(env), readCopy, other: intake.other || '', rules: runContentRules(runDir) });
  const out = { schema: 'run-jev-final-v1', stage: FINAL_COPY_STAGE, model: RUN_JEV_MODEL, readAt: new Date().toISOString(), ms: Date.now() - started,
    counts: { rows: rows.length, read: rows.filter((r) => r.status === 'read').length,
      flagged: rows.filter((r) => r.flags?.some((f) => f.kind !== 'claim')).length, notRead: rows.filter((r) => r.status !== 'read').length,
      ownerEdited: rows.filter((r) => r.edit?.kind === 'words').length }, rows };
  writeReadings(runDir, FINAL_COPY_STAGE, out);
  console.log(`final-copy: ${out.counts.read}/${rows.length} read in ${(out.ms / 1000).toFixed(1)}s · ${out.counts.flagged} flagged · ${out.counts.ownerEdited} owner-edited · ${out.counts.notRead} not read (read those in full) · report-only`);
  for (const r of rows) console.log(`  ${r.id}: ${finalCopyLine(r)}`);
  const spend = llmSpendSummary();
  console.log(`Jev spend: ${spend.calls} call(s) · $${spend.costUsd} (${spend.basis})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
