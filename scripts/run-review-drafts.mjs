#!/usr/bin/env node
// Put every thread of a collaborative /run in its own UNSCHEDULED Typefully draft from stop 4 onward,
// so the owner reviews the run in Typefully rather than in text packets.
//
// Owner, 2026-09-22: "from step 4, we already want ALL the tweets to be in their own typefully draft
// already." In a five-stop run (the default) stop 4 is drafts: each batch of complete threads lands in
// its own drafts as soon as it is written, so the owner reviews batch 1 while batch 2 is being written.
// In a six-stop run (init --with-hooks) stop 4 is hooks: the draft holds the proposed hook and the
// approved outline, beat by beat, and the drafts stop rewrites the same draft with the complete thread.
//
// WHERE THEY LIVE: the page's OWN Typefully set — the account the thread will publish from.
// Owner 2026-09-22: "it's the same draft. Every thread should only ever have one draft and it sits
// exactly on the accounts it is going to publish for." This draft is therefore not a preview of the
// real one: at the calendar stop publish-thread.mjs ADOPTS it — patching in the final copy, the
// workflow title and the publish time — instead of creating a second draft beside it.
//
// That leaves an unapproved thread sitting in a LIVE queue, so these are the rails that keep it
// from posting, and none of them may be relaxed without the owner:
//   - Nothing here ever sends a publish time, and every write is read back: a review draft found
//     scheduled stops the pass immediately.
//   - The [REVIEW] title prefix (config.mjs) sits outside fill-queue.mjs's WORKFLOW pattern, so the
//     queue filler cannot schedule one, and outside registry-sync.mjs's engineDraft pattern, so it
//     is never counted as published output. tests/run-review-drafts.test.mjs reads both patterns
//     out of their own source, so widening either one fails there rather than in production.
//   - calendar.mjs and qc.mjs only ever look at drafts that already carry a scheduled_date.
//   - archive-drafts.mjs treats [REVIEW] as reference material that is never deleted, so a run in
//     progress cannot be tidied away underneath the owner.
//
// SAFETY, in order of importance:
//   1. No request ever carries a publish time. The readback after each write must show an
//      unscheduled draft or the run stops.
//   2. A row is written only if its previous stage is approved in run-studio.
//   3. A row is written only into the set of the account it names, resolved from accounts.mjs.
//   4. Find by title BEFORE creating, so a rerun updates rather than duplicates. A create that fails
//      ambiguously is re-read before anything else; the Typefully client never replays writes.
//   5. One write at a time.
//
// THE NOTE (plan R2). Every review draft carries the thread's source note (thread-note.mjs) in its
// scratchpad, rendered from the row's thread-provenance-v1 (row.provenance, else RUN_DIR/provenance.json
// from scripts/run-provenance.mjs; a row with neither gets a minimal note that says so). Three writes:
//   - only the note changed          → a note-only PATCH { scratchpad_text } that never sends posts;
//   - the copy changed, and the live copy is still what we last pushed → posts and note together;
//   - the owner edited the copy      → the copy is left alone and the note is re-rendered ON THE LIVE
//     copy with "COPY EDITED IN TYPEFULLY — review and gates must re-run".
// Every note write is read back; the result carries noteVerified.
//
//   node scripts/run-review-drafts.mjs --stage drafts --run-dir DIR --run-id R2026-09-25 --input drafts-spec.json [--dry]
//   node scripts/run-review-drafts.mjs --stage hooks  --run-dir DIR --run-id R2026-09-25 --input hooks-spec.json [--dry]   (six-stop runs only)
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS } from '../accounts.mjs';
import { REVIEW_PREFIX } from '../config.mjs';
import { loadEnv, typefully } from '../lib.mjs';
import { buildPlatforms } from '../platforms.mjs';
import { ensureTags } from '../greenhouse-draft.mjs';
import { checkRow, flowOf } from './run-studio.mjs';
import { refreshNote, renderNote, sameNote } from '../thread-note.mjs';
import { approvedCalendar, slotWhen } from './run-calendar.mjs';

export { REVIEW_PREFIX };
export const REVIEW_TAG = 'review';
// A draft names its tags by slug, and Typefully's slugs are lowercase: the tag created as
// "R2026-09-23" is stored as r2026-09-23, and a draft that carried "R2026-09-23" was refused with
// a 400 on the first live create of that run (2026-09-23). Every other tag in the repo is already
// lowercase, which is why only the run tag ever hit it. Create and carry the slug form.
export const runTag = (runId) => String(runId).toLowerCase();
const REVIEW_STAGES = ['hooks', 'drafts'];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OWNER_EDIT_LOG = join(REPO, 'learnings', 'owner-edits.jsonl');

// Typefully returns inline comment anchors inside post text; they are not copy.
export const stripCommentMarkers = (text) => String(text || '').replace(/<\/?typ:comment-thread[^>]*>/g, '');
export const liveTweets = (draft) => (draft?.platforms?.x?.posts || []).map((p) => stripCommentMarkers(p.text));
export const tweetsSha256 = (tweets) => sha256(JSON.stringify(tweets));

/**
 * PURE. The posts a copy update sends, with the media the draft already carries (R2026-11-01: minting
 * links re-pushed the copy and silently dropped every hook clip the media pass had placed, so the mint
 * had to be ordered before media by hand). Media stays on a tweet only when that tweet's words are
 * unchanged apart from its links (a minted link replacing its {{LINK}} token), and only when the thread
 * keeps its length: a reworded tweet may no longer fit its clip, so it goes back to the media pass bare.
 */
const sansLinks = (t) => String(t ?? '').replace(/\{\{LINK\d*\}\}|https?:\/\/\S+/g, '<link>').trim();
export function postsKeepingMedia(tweets, current) {
  const live = current?.platforms?.x?.posts || [];
  const keep = live.length === tweets.length;
  return tweets.map((text, i) => {
    const same = keep && sansLinks(stripCommentMarkers(live[i]?.text)) === sansLinks(text);
    const ids = same ? (live[i]?.media_ids || []).map(String) : [];
    return ids.length ? { text, media_ids: ids } : { text };
  });
}

/**
 * Owner-edit guard (owner, 2026-09-23: 9 of 15 R2026-09-23 threads were edited in Typefully after
 * review). A re-sync may overwrite a review draft only when its live copy is still exactly what this
 * tool last pushed (the ledger's contentSha256) or already equals the new copy. Anything else is the
 * owner's work: never overwritten, captured as the editorial reviewer's best label instead.
 */
export function ownerEditVerdict({ live, next, pushedSha256 }) {
  const liveSha = tweetsSha256(live);
  if (liveSha === tweetsSha256(next)) return { edited: false, liveSha };
  if (pushedSha256 && liveSha === pushedSha256) return { edited: false, liveSha };
  return { edited: true, liveSha, reason: pushedSha256
    ? 'the live copy was edited in Typefully since the last push'
    : 'no record of what was last pushed, so an owner edit cannot be ruled out' };
}

/** The provenance for a row: the row's own, else the run's provenance.json (run-provenance.mjs). */
export function provenanceLoader(runDir) {
  let rows = null;
  return (row) => {
    if (row?.provenance) return row.provenance;
    if (rows === null) {
      const file = join(runDir, 'provenance.json');
      // A provenance.json that exists but cannot be parsed is an error, not "no provenance": silently
      // reading it as empty would replace every full note with the minimal one and still verify.
      if (!existsSync(file)) rows = {};
      else {
        try { rows = JSON.parse(readFileSync(file, 'utf8')).rows || {}; }
        catch (error) { throw new Error(`${file} could not be read (${error.message}); fix or re-run scripts/run-provenance.mjs`); }
      }
    }
    return rows[row?.id] || null;
  };
}

/** The note a row's draft should carry. Owner text outside the machine block is kept. */
export function reviewNote({ existing = '', provenance = null, tweets, state = 'review', runId, row, history = [] }) {
  return refreshNote(existing, renderNote(provenance, { tweets, state, runId, rowId: row.id, history }));
}

// HISTORY records copy events only (a note refresh is not one), so re-syncing an unchanged row
// renders the same note and writes nothing.
const withEvent = (history, event) => [...(Array.isArray(history) ? history : []), event];

/** Full copy stays in the run directory (unpublished copy never enters Git); the repo log is hash-only. */
function captureOwnerEdit({ runDir, runId, row, draftId, account, live, pushedSha256, liveSha, reason, logFile }) {
  const at = new Date().toISOString();
  const dir = join(runDir, 'owner-edits');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${row.id}.json`), `${JSON.stringify({ runId, rowId: row.id, draftId, account, at, reason, live, proposed: row.draft?.tweets ?? null }, null, 2)}\n`, { mode: 0o600 });
  if (!logFile) return;
  const proposed = Array.isArray(row.draft?.tweets) ? row.draft.tweets.map(String) : [];
  const changed = live.map((t, i) => (t === proposed[i] ? null : i + 1)).filter(Boolean);
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify({ at, runId, rowId: row.id, draftId, account, pushedSha256: pushedSha256 || null,
    liveSha256: liveSha, liveTweets: live.length, proposedTweets: proposed.length, changedTweets: changed })}\n`);
}

export const reviewKey = (runId, rowId) => `${REVIEW_PREFIX} ${runId} · ${rowId} ·`;
/** `slot` is the row's approved calendar slot (R1): the title then ends with its time, "· Thu 12:10 ICT". */
export function reviewTitle(runId, row, hook, slot = null) {
  const short = String(hook || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const when = slotWhen(slot);
  return `${reviewKey(runId, row.id)} ${row.account} · ${row.lane}${short ? ` — ${short}` : ''}${when ? ` · ${when}` : ''}`;
}

/** Split an outline into beats: blank-line paragraphs, or one numbered line per beat. */
function beats(outline) {
  const text = String(outline || '').trim();
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** What the draft holds at each stop. At hooks the body does not exist yet, so everything after the
 *  hook is labelled as outline: it is there to be read, never mistaken for the thread. */
export function reviewTweets(stage, row) {
  if (stage === 'drafts') {
    const tweets = Array.isArray(row.draft?.tweets) ? row.draft.tweets.map(String).filter((t) => t.trim()) : [];
    if (!tweets.length) fail(`${row.id}: drafts stage needs draft.tweets`);
    return tweets;
  }
  const hook = String(row.hook?.proposed || '').trim();
  if (!hook) fail(`${row.id}: hooks stage needs hook.proposed`);
  const out = [hook];
  const outline = beats(row.hook?.outline);
  outline.forEach((beat, i) => out.push(`▸ OUTLINE ${i + 1}/${outline.length} (review only, not the thread)\n\n${beat}`));
  (row.hook?.ctaOpportunities || []).forEach((cta, i) => out.push(`▸ CTA ${i + 1}\n\n${typeof cta === 'string' ? cta : JSON.stringify(cta)}`));
  if (row.hook?.tailValue) out.push(`▸ AFTER THE ASKS\n\n${String(row.hook.tailValue).trim()}`);
  return out;
}

/** The set a row's draft belongs in: the page it will publish from. Resolved against the supplied
 *  roster (not a module global) so a test can hand in its own accounts. */
export function socialSetOf(row, accounts = ACCOUNTS) {
  const raw = String(row?.account ?? '').trim();
  const lower = raw.toLowerCase();
  const key = accounts[raw] ? raw : accounts[lower] ? lower
    : Object.keys(accounts).find((name) => String(accounts[name]?.name || '').toLowerCase() === lower);
  const account = key ? accounts[key] : null;
  if (!account) fail(`${row?.id ?? '(row)'}: unknown account ${JSON.stringify(row?.account ?? null)}; a review draft goes to the page that will publish it`);
  if (!account.socialSetId) fail(`${row.id}: account ${key} has no socialSetId`);
  return { key, name: account.name || key, socialSetId: account.socialSetId };
}

async function readReviewDrafts(tf, socialSetId, runId) {
  // Every status, not just `draft`: a review draft that somehow became scheduled is precisely the
  // thing this tool must see and refuse, and a draft-only listing would hide it.
  const all = await tf.listAll(`/social-sets/${socialSetId}/drafts`);
  return all.filter((d) => String(d.draft_title || '').startsWith(`${REVIEW_PREFIX} ${runId} ·`));
}

function assertUnscheduled(draft, rowId) {
  if (!draft || String(draft.status || '') !== 'draft' || draft.scheduled_date || draft.publish_at) {
    fail(`${rowId}: review draft ${draft?.id ?? '(unknown)'} is not an unscheduled draft (status ${draft?.status}, scheduled ${draft?.scheduled_date ?? 'none'}). Stop and inspect it in Typefully before anything else runs.`);
  }
}

function writeLedger(file, ledger) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, file);
}

/** The link the owner opens: the public share link if Typefully issued one, else the in-app draft. */
export const draftLink = (draftId, socialSetId, shareUrl = null) =>
  shareUrl || (draftId ? `https://typefully.com/?d=${encodeURIComponent(draftId)}&a=${encodeURIComponent(socialSetId)}` : null);

/**
 * Create or update one review draft per approved row. Everything provider-side goes through `tf`
 * so tests run with a fake; nothing here can schedule. The stop that must be approved first comes
 * from the run's own flow: products before drafts in a five-stop run, hooks in a six-stop one.
 */
export async function syncReviewDrafts({ tf, rows, stage, runDir, runId, dry = false, accounts = ACCOUNTS,
  flow = null, approvedIn = (dir, s, id) => checkRow(dir, s, id), log = () => {}, ownerEditLog = OWNER_EDIT_LOG,
  provenanceOf = null, now = () => new Date().toISOString(), slotOf = () => null }) {
  if (!REVIEW_STAGES.includes(stage)) fail('stage must be drafts or hooks');
  if (!RUN_ID.test(String(runId || ''))) fail('run-id must be a short safe identifier, e.g. R2026-09-25');
  if (!Array.isArray(rows) || !rows.length) fail('rows[] is required');
  const stops = flow ?? flowOf(runDir);
  if (!stops.includes(stage)) fail(`This run has no ${stage} stop (its stops are ${stops.join(' → ')}).`);
  const previous = stops[stops.indexOf(stage) - 1];
  const ledgerFile = join(runDir, 'review-drafts.json');
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : {};
  // Each row lives in its own page's set now, so the "what is already there" read is per set and
  // happens once per set, not once per run.
  const bySet = new Map();
  const readSet = async (id) => {
    if (!bySet.has(id)) bySet.set(id, await readReviewDrafts(tf, id, runId));
    return bySet.get(id);
  };
  const results = [];
  const provenanceFor = provenanceOf || provenanceLoader(runDir);

  for (const row of rows) {
    const result = { id: row.id, action: null, account: null, socialSetId: null, draftId: null, shareUrl: null, reason: null, noteVerified: null };
    results.push(result);
    let target;
    try { target = socialSetOf(row, accounts); }
    catch (error) { Object.assign(result, { action: 'skipped', reason: error.message }); continue; }
    const set = target.socialSetId;
    Object.assign(result, { account: target.key, socialSetId: set });
    try {
      approvedIn(runDir, previous, row.id);
    } catch (error) {
      Object.assign(result, { action: 'skipped', reason: `${previous} not approved: ${error.message}` });
      continue;
    }
    const existing = await readSet(set);
    let tweets;
    try { tweets = reviewTweets(stage, row); }
    catch (error) { Object.assign(result, { action: 'skipped', reason: error.message }); continue; }

    const title = reviewTitle(runId, row, stage === 'hooks' ? row.hook?.proposed : row.draft?.tweets?.[0], slotOf(row.id));
    const contentSha256 = sha256(JSON.stringify(tweets));
    const matches = existing.filter((d) => String(d.draft_title || '').startsWith(reviewKey(runId, row.id)));
    if (matches.length > 1) {
      Object.assign(result, { action: 'refused', reason: `${matches.length} review drafts share ${reviewKey(runId, row.id)} (${matches.map((d) => d.id).join(', ')}); delete the extras in Typefully first` });
      continue;
    }
    const body = { draft_title: title, tags: [REVIEW_TAG, runTag(runId)], platforms: buildPlatforms(tweets.map((text) => ({ text }))) };
    const provenance = provenanceFor(row);
    const prior = ledger[row.id] || {};
    let history = Array.isArray(prior.history) ? prior.history : [];
    let note;

    if (matches.length === 1) {
      const current = await tf.getDraft(set, matches[0].id);
      assertUnscheduled(current, row.id);
      const same = liveTweets(current);
      const guard = ownerEditVerdict({ live: same, next: tweets, pushedSha256: prior.contentSha256 });
      if (guard.edited) {
        Object.assign(result, { action: 'owner-edited', draftId: String(current.id), shareUrl: current.share_url || null,
          reason: `${guard.reason}; not overwritten. Pull the live copy into the row and re-run review and gates.` });
        // The owner's copy stands. The note is re-rendered on THAT copy, never on ours, and says the
        // review and gates no longer cover what is in the draft. One history event per edited copy.
        if (history.at(-1)?.liveSha256 !== guard.liveSha) {
          history = withEvent(history, { at: now(), what: 'copy edited in Typefully — not overwritten; review and gates must re-run', liveSha256: guard.liveSha });
        }
        note = reviewNote({ existing: current.scratchpad_text, provenance, tweets: same, state: 'edited', runId, row, history });
        if (!dry) {
          captureOwnerEdit({ runDir, runId, row, draftId: String(current.id), account: target.key, live: same,
            pushedSha256: prior.contentSha256, liveSha: guard.liveSha, reason: guard.reason, logFile: ownerEditLog });
          if (!sameNote(current.scratchpad_text, note)) {
            await tf.patchDraft(set, current.id, { scratchpad_text: note });
            const back = await tf.getDraft(set, current.id);
            assertUnscheduled(back, row.id);
            result.noteVerified = sameNote(back?.scratchpad_text, note);
          } else result.noteVerified = true;
          // contentSha256 stays what WE last pushed: the owner's copy is not ours to claim.
          if (ledger[row.id]) ledger[row.id] = { ...prior, history, noteSha256: sha256(note), updatedAt: now() };
        }
        log(`owner-ed  ${row.id} ${result.shareUrl || result.draftId}${result.noteVerified === false ? ' · NOTE NOT VERIFIED' : ''}`);
        continue;
      }
      const copySame = same.length === tweets.length && same.every((t, i) => t === tweets[i]);
      if (!copySame) history = withEvent(history, { at: now(), what: stage === 'hooks' ? 'hook and outline updated' : 'copy updated' });
      note = reviewNote({ existing: current.scratchpad_text, provenance, tweets, runId, row, history });
      if (copySame && current.draft_title === title && sameNote(current.scratchpad_text, note)) {
        Object.assign(result, { action: 'unchanged', draftId: String(current.id), shareUrl: current.share_url || null, noteVerified: true });
      } else if (dry) {
        Object.assign(result, { action: copySame ? 'would-update-note' : 'would-update', draftId: String(current.id), shareUrl: current.share_url || null });
        continue;
      } else if (copySame) {
        // NOTE-ONLY. The draft already holds the row's copy, so posts and platforms are never sent:
        // a note refresh cannot overwrite a word of the thread.
        await tf.patchDraft(set, current.id, { ...(current.draft_title === title ? {} : { draft_title: title }), scratchpad_text: note });
        const back = await tf.getDraft(set, current.id);
        assertUnscheduled(back, row.id);
        Object.assign(result, { action: 'note-updated', draftId: String(back.id), shareUrl: back.share_url || null,
          noteVerified: sameNote(back.scratchpad_text, note) });
      } else {
        // The copy changed, and the guard above proved the live copy is still our last push. Media the
        // draft carries stays on its tweet (postsKeepingMedia).
        await ensureTags(tf, body.tags, set);
        const kept = postsKeepingMedia(tweets, current);
        await tf.patchDraft(set, current.id, { ...body, platforms: buildPlatforms(kept), scratchpad_text: note });
        const back = await tf.getDraft(set, current.id);
        assertUnscheduled(back, row.id);
        Object.assign(result, { action: 'updated', draftId: String(back.id), shareUrl: back.share_url || null,
          noteVerified: sameNote(back.scratchpad_text, note) });
      }
    } else if (dry) {
      Object.assign(result, { action: 'would-create' });
      continue;
    } else {
      let made;
      history = withEvent(history, { at: now(), what: `review draft created at the ${stage} stop` });
      note = reviewNote({ existing: '', provenance, tweets, runId, row, history });
      // A tag must exist on the set before a draft carries it; the run tag is new every run.
      await ensureTags(tf, body.tags, set);
      try {
        made = await tf.createDraft(set, { ...body, scratchpad_text: note });
      } catch (error) {
        // An ambiguous failure may have landed. Re-read before anything else; never re-send blind.
        const landed = (await readReviewDrafts(tf, set, runId)).filter((d) => String(d.draft_title || '').startsWith(reviewKey(runId, row.id)));
        if (landed.length !== 1) {
          Object.assign(result, { action: 'uncertain', reason: `create failed (${error.message}) and ${landed.length} matching draft(s) exist; inspect before rerunning` });
          break;   // stop the whole pass: the next write should not race an unknown state
        }
        made = landed[0];
      }
      const back = await tf.getDraft(set, made.id);
      assertUnscheduled(back, row.id);
      existing.push(back);
      Object.assign(result, { action: 'created', draftId: String(back.id), shareUrl: back.share_url || null,
        noteVerified: sameNote(back.scratchpad_text, note) });
    }
    // account/lane/date/title let the run card (scripts/run-card.mjs) name and link each draft, and
    // draftId is what publish-thread.mjs adopts at the calendar stop instead of creating a new one.
    ledger[row.id] = { stage, socialSetId: set, draftId: result.draftId, shareUrl: result.shareUrl,
      url: draftLink(result.draftId, set, result.shareUrl), title, account: target.key, lane: row.lane ?? null,
      date: row.date ?? null, contentSha256, noteSha256: sha256(note), history, updatedAt: now() };
    log(`${result.action.padEnd(9)} ${row.id} ${result.shareUrl || result.draftId || ''}${result.noteVerified === false ? ' · NOTE NOT VERIFIED' : ''}`);
  }
  if (!dry) writeLedger(ledgerFile, ledger);
  return { stage, runId, socialSets: [...new Set(results.map((r) => r.socialSetId).filter(Boolean))], results,
    summary: Object.fromEntries(['created', 'updated', 'note-updated', 'unchanged', 'would-create', 'would-update', 'would-update-note', 'owner-edited', 'skipped', 'refused', 'uncertain']
      .map((k) => [k, results.filter((r) => r.action === k).length]).filter(([, n]) => n)),
    // A result's noteVerified is null when no note was written or read back for it.
    noteVerified: { verified: results.filter((r) => r.noteVerified === true).length,
      failed: results.filter((r) => r.noteVerified === false).map((r) => r.id) } };
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const stage = flag('stage'), runDir = flag('run-dir'), runId = flag('run-id'), input = flag('input');
  if (!stage || !runDir || !runId || !input) fail('Usage: run-review-drafts.mjs --stage drafts|hooks --run-dir DIR --run-id ID --input SPEC.json [--dry]');
  const spec = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const env = loadEnv();
  if (!env.TYPEFULLY_API_KEY) fail('TYPEFULLY_API_KEY is not set');
  // A brief approved with a calendar puts each row's approved time in its [REVIEW] title.
  let calendar = null;
  try { calendar = approvedCalendar(resolve(runDir)); } catch { calendar = null; }
  return syncReviewDrafts({ tf: typefully(env), rows: spec.rows, stage, runDir: resolve(runDir), runId,
    slotOf: (id) => calendar?.bySlot.get(id) ?? null,
    dry: argv.includes('--dry'), log: (line) => console.error(line) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = await main(process.argv.slice(2));
    console.log(JSON.stringify(out, null, 2));
    // A note that did not read back as written is a failure the caller must see, not just a log line.
    if (out?.noteVerified?.failed?.length) { console.error(`note not verified: ${out.noteVerified.failed.join(', ')}`); process.exitCode = 3; }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
