#!/usr/bin/env node
// scripts/run-media.mjs — the /run media pass: Jev picks media for each row's [REVIEW] draft, so the owner
// approves the thread and its media together at the drafts stop.
//
//   node scripts/run-media.mjs --run-dir RUN [--input SPEC] [--rows a,b] [--clips cut|reuse|off] [--max-cuts N] [--parallel N] [--no-original] [--no-swipe] [--hook-only] [--force] [--dry]
//
// Per [REVIEW] draft in RUN/review-drafts.json (unscheduled, in the page's own set):
//   PHASE 1, THE HOOK (every row first, so hooks get first claim on the cut budget; operator 2026-09-24):
//     a. Jev reads tweet 1 against the Clip Library and every In Pool podcast transcript and the best
//        passage that makes the hook's claim is clipped onto it (scripts/clip-find.mjs --only 1).
//     b. The ORIGINAL hook's media (the donor swipe row, SPEC row source.id) goes on the hook only when no
//        new clip landed there: the new media wins (owner, 2026-09-28). --no-original skips it.
//   PHASE 2, THE BODY (skipped by --hook-only; owner, 2026-11-01: "maybe just the hook" after the
//   competitor read showed his best threads carry no body media):
//     c. Clips (clip-find --pool --cut) for each eligible tweet still bare.
//     d. Swipe media (scripts/media-find.mjs --attach) for the tweets still bare: Jev names each tweet's
//        subject, matches the swipe DB, and decides each image from a vision model's description. A bare
//        hook only ever takes a video.
// --clips cut (default) recuts every clip, stored ones too (clip-find --no-stored, a 0.2-0.8 s start jitter): the
// same file on several pages is what the owner ruled out (2026-10-13). A cut costs one RapidAPI call, capped
// run-wide by --max-cuts (default RUN_MEDIA_RULES.maxCuts). --clips reuse: stored files only, never on a run.
// VIDEO CAP (owner, 2026-10-03: "a max of 3 videos per thread ... prioritize higher jev score clips"): a thread
// carries at most CLIP_RULES.perThread.maxVideos videos. The hook clip and the original hook video spend it
// first; the body clips get what is left (clip-find --max-clips, highest Jev fit first), and swipe videos the
// remainder (media-find --max-videos; at 0 the swipe pass places images only).
// PLACEMENT (operator 2026-09-24; placementRules): no video on the tweet before a plug, on a bridge or on
// the weld (images only there), and the first tweet of a CTA takes a video only of 30 s or less at higher
// bars (CLIP_RULES.strict, MEDIA_RULES.strict).
// Every decision is Jev's; code proposes candidates, counts and places. Plug, closing and disclaimer
// tweets are never touched, and neither is a tweet that already has media.
// The draft is then read back and RUN/media.json records, per row, which tweet carries what and why, bound
// to the copy digest the review draft had. A row whose copy is unchanged since its pass is skipped (a
// re-run never pays twice); --force redoes it. A copy change at the drafts stop re-pushes the draft
// without media, so the next pass redoes that row.
// Schedule: publish-thread.mjs carries the review draft's media into the shipped thread, and
// run-row.mjs schedule reads back that the shipped draft carries exactly that media.
// --dry: both matchers run dry (Jev decides, nothing is cut, uploaded or attached); media.json untouched.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// parallel: rows in flight at once (owner, 2026-09-28: "Why is the media pass taking so long"). Each row's own
// steps stay in order, because they patch the same draft; rows touch different drafts. bodyCutsPerRow: the
// fresh cuts one row's body pass may reserve while others run, so the run-wide cap holds exactly.
export const RUN_MEDIA_RULES = { clips: 'cut', maxCuts: 12, parallel: 4, bodyCutsPerRow: 2 };
const REVIEW_PREFIX = '[REVIEW]';

// ---- pure -----------------------------------------------------------------------------------------

/**
 * PURE. The rows to pass: every review draft in the ledger (or the --rows ones), minus rows whose media
 * pass already ran on the same copy (media.json contentSha256 equals the ledger's), unless force.
 */
export function mediaTodo(reviewLedger = {}, mediaLedger = {}, { rows = null, force = false } = {}) {
  const want = rows ? new Set(rows) : null;
  const todo = [], skipped = [];
  for (const [id, r] of Object.entries(reviewLedger)) {
    if (want && !want.has(id)) continue;
    if (!r?.draftId || !r?.socialSetId) { skipped.push({ id, reason: 'no review draft in the ledger' }); continue; }
    const done = mediaLedger[id];
    if (!force && done && done.draftId === String(r.draftId) && done.contentSha256 && done.contentSha256 === r.contentSha256) {
      skipped.push({ id, reason: 'media already picked for this copy (--force to redo)' }); continue;
    }
    todo.push({ id, draftId: String(r.draftId), socialSetId: r.socialSetId, account: r.account ?? null, contentSha256: r.contentSha256 ?? null });
  }
  for (const id of want || []) if (!reviewLedger[id]) skipped.push({ id, reason: 'not in review-drafts.json' });
  return { todo, skipped };
}

/**
 * PURE. Whether tweet 1 has new media, so the donor's original stays off it. The new media wins (owner,
 * 2026-09-28: "from now always override to priorities the new media"): the original goes on the hook only
 * when this is false. New media is a clip this pass attached to tweet 1, or media the hook already carried
 * before the pass that is not the recorded original (an earlier pass's clip: clip-find skips a tweet that
 * has media, so a re-run attaches nothing there). A dry pass attaches nothing, so there the clip Jev picked
 * for tweet 1 counts.
 */
export function hookHasNewMedia({ reports = [], live = [], original = [], dry = false } = {}) {
  if ((live || []).some((id) => !(original || []).includes(id))) return true;
  return (reports || []).some((report) => (report?.placed?.attached || []).some((a) => a?.index === 0 && a?.mediaId)
    || (dry && (report?.decisions || []).some((d) => d?.pick && !['none', 'capped'].includes(d?.action))));
}

/**
 * PURE. Videos a row's thread may still take, against the per-thread cap: what the cap leaves after the videos
 * an earlier pass placed on this draft (a re-run never removes media), the clips this pass placed so far,
 * and the original hook media when this pass added it and it is a video.
 */
export function videoBudget({ cap, earlierVideos = 0, placedClips = 0, originalVideo = false } = {}) {
  return Math.max(0, cap - earlierVideos - placedClips - (originalVideo ? 1 : 0));
}

/** PURE. Clips clip-find reports placed: the attached ones, or in a dry run the ones it would place. */
export const clipsPlaced = (reports = [], { dry = false } = {}) => (reports || []).reduce((n, r) => n + (dry
  ? (r?.decisions || []).filter((d) => d?.pick && ['reuse', 'cut'].includes(d.action)).length
  : (r?.placed?.attached || []).filter((a) => a?.mediaId).length), 0);

/** PURE. Videos an earlier pass left on the draft, from its media.json entry (entries from before the video
 *  cap carry no `videos`: their clips are the floor). 0 when the entry is for another draft. */
export const earlierVideos = (entry, draftId) => (entry && String(entry.draftId) === String(draftId) ? Number(entry.videos ?? entry.clips ?? 0) || 0 : 0);

/** PURE. Why a draft may not take a media pass: it must be an unscheduled [REVIEW] draft. null = fine. */
export function reviewDraftRefusal(draft) {
  if (!draft?.id) return 'draft not found in its set';
  if (!String(draft.draft_title || '').startsWith(REVIEW_PREFIX)) return `not a ${REVIEW_PREFIX} draft (${JSON.stringify(String(draft.draft_title || '').slice(0, 40))})`;
  if (draft.status !== 'draft' || draft.scheduled_date || draft.publish_at) return `already ${draft.status}${draft.scheduled_date ? ` for ${draft.scheduled_date}` : ''}`;
  return null;
}

/**
 * PURE. The row's media, read back from its review draft: per X post, the media count and where it came
 * from (a clip from clip-find's report, a swipe pick from media-find's), with the reason Jev gave.
 */
export function mediaSummary(draft, { clipReports = [], swipeReport = null, original = null } = {}) {
  const posts = draft?.platforms?.x?.posts || [];
  const clipBy = new Map(clipReports.flatMap((c) => c?.placed?.attached || []).map((a) => [a.index + 1, a]));
  const clipWhy = new Map();
  clipReports.flatMap((c) => c?.decisions || []).forEach((d) => { if (d?.pick) clipWhy.set(d.tweet, d.pick); });
  const swipeBy = new Map((swipeReport?.tweets || []).filter((t) => t.placed).map((t) => [t.tweet, t]));
  const tweets = posts.map((p, i) => {
    const n = i + 1, media = p?.media_ids?.length || 0;
    const clip = clipBy.get(n), swipe = swipeBy.get(n);
    const pick = clip ? clipWhy.get(p.text) : null;
    const orig = n === 1 && original?.count ? original : null;
    const parts = [
      clip && `clip ${clip.recordId}${pick ? ` · ${Math.round(pick.start)}–${Math.round(pick.end)}s · fit ${Number(pick.fit).toFixed(2)}` : ''}`,
      orig && (orig.kept ? `original hook media ×${orig.count} (${orig.recId || `live ${orig.tweetId}`}, from the earlier pass)` : `original hook media ${orig.kind} ×${orig.count} (${orig.recId || `live ${orig.tweetId}`})`),
      swipe && `swipe ${swipe.pick?.kind} ×${swipe.pick?.count} · «${swipe.subject ?? '?'}» · same ${Number(swipe.pick?.same).toFixed(2)} · ${swipe.pick?.tweetUrl || swipe.pick?.swipeId}`,
    ].filter(Boolean);
    const source = !media ? null : [clip && 'clip', orig && 'original', swipe && 'swipe'].filter(Boolean).join('+') || 'other';
    // A video this pipeline placed (a clip, the original hook video, a swipe video): what the per-thread cap counts.
    const video = Boolean(clip || orig?.kind === 'video' || swipe?.pick?.kind === 'video');
    return { tweet: n, media, source, why: parts.join(' | ') || (media ? 'already on the draft' : null), ref: clip ? clip.recordId : swipe ? swipe.pick?.swipeId ?? null : orig ? (orig.recId || orig.tweetId) : null, video };
  });
  const has = (k) => tweets.filter((t) => String(t.source || '').split('+').includes(k)).length;
  return { tweets, withMedia: tweets.filter((t) => t.media).length, clips: has('clip'), swipe: has('swipe'), videos: tweets.filter((t) => t.video).length, hook: tweets[0]?.source ?? null };
}

/**
 * PURE. A re-run (after a failure, or --force) places nothing on a tweet that already has media, so its
 * reports cannot say where that media came from: a tweet whose media count is unchanged and that this pass
 * did not newly attribute keeps the earlier pass's record.
 */
export function withEarlier(summary, earlier) {
  const before = new Map((earlier?.tweets || []).map((t) => [t.tweet, t]));
  const tweets = summary.tweets.map((t) => {
    const e = before.get(t.tweet);
    const fresh = t.source && !['other', 'original'].includes(t.source);
    return e && e.media === t.media && t.media && !fresh ? e : t;
  });
  const has = (k) => tweets.filter((t) => String(t.source || '').split('+').includes(k)).length;
  return { ...summary, tweets, clips: has('clip'), swipe: has('swipe'), videos: tweets.filter((t) => t.video).length, hook: tweets[0]?.source ?? null };
}

/** PURE. A tweet that carries a product link (minted, or the {{LINK}} token before minting): a plug. The
 *  disclaimer and closing lines are not plugs, so '#ad' and 'affiliate link' wording never counts here. */
export const isLinkTweet = (text) => /\{\{?LINK\d*\}?\}|lvnta\.com|amzn\.to|amazon\.com\/|gumroad\.com|geni\.us/i.test(String(text ?? ''));

/**
 * PURE. Where video may go in one thread (operator 2026-09-24), as 1-based tweet numbers:
 *   noVideo: the tweet right before every plug (at CTA depth 3 that is the bridge, and before the light
 *            plug it is the weld), plus the bridge and the weld by role: images only there.
 *   strict:  the first tweet of a CTA (its point, when the CTA has one): a video there runs 30 s or less
 *            and clears the higher bars. A first tweet that is also right before a plug stays noVideo.
 * roles: decisions/editorial-prescore.mjs rolesOf (0-based) when the row's spec is known; else only the
 * plugs, found in the draft's own copy (`isPlug`), so the before-a-plug rule still holds.
 */
export function placementRules({ tweets = [], roles = null, isPlug = () => false } = {}) {
  // The plugs the roles name AND the ones the copy shows: a role reading that missed a plug never lifts the rule.
  const plugs = [...new Set([...(roles?.plugs || []), ...tweets.map((t, i) => (isPlug(t) ? i : null)).filter((i) => i != null)])];
  const noVideo = new Set(plugs.map((p) => p - 1).filter((i) => i >= 1));
  for (const i of [roles?.cta1Bridge, roles?.weld]) if (i != null && i >= 1) noVideo.add(i);
  const strict = [roles?.cta1Point].filter((i) => i != null && i >= 1 && !noVideo.has(i) && !plugs.includes(i));
  const n = (xs) => [...xs].map((i) => i + 1).sort((a, b) => a - b);
  // The hook (tweet 1) always takes the higher bars, with no length cap (operator 2026-09-24).
  return { noVideo: n(noVideo), strict: n(strict), highBar: [1], from: roles ? 'roles' : 'plugs' };
}

/** PURE. Fresh cuts a clip-find run spent: one "▶ cutting" line per cut. */
export const cutsIn = (stdout) => (String(stdout).match(/^▶ cutting /gm) || []).length;
/** The run-wide clip breaker: once the cutter has failed twice in this pass with no cut landing, every later row skips
 *  its cut and falls straight back to the donor's original hook media (R2026-11-21: 9 cuts hung ~10.5 min each, 0 clips). */
export const cutBreaker = ({ trips = 2 } = {}) => {
  let failed = 0, landed = 0, reason = '';
  return {
    open: () => landed === 0 && failed >= trips,
    reason: () => reason,
    record: ({ ok, cutting, line = '' }) => {
      if (ok) { if (cutting) landed++; return; }
      if (cutting) { failed++; reason = line; }
    },
  };
};
/** Hook cuts in a run pass wait at most this long (a working cut lands in 1-3 min). */
export const RUN_CUT_TIMEOUT_S = 300;

/** PURE (state in the closure). The run-wide cut budget shared by rows in flight: a row reserves before its
 *  clip-find starts and passes the reservation as --max-cuts, then gives back what it did not spend, so the
 *  cuts spent never exceed the budget however many rows run at once. */
export function cutPool(total = 0) {
  let left = Math.max(0, total);
  return {
    reserve: (want) => { const n = Math.max(0, Math.min(want, left)); left -= n; return n; },
    settle: (reserved, spent) => { left = Math.max(0, left + reserved - Math.max(0, spent)); },
    left: () => left,
  };
}

/** Run fn over items with at most `limit` in flight, results in item order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`);

/** PURE. The donor tweet id of a spec row's source: a status URL, or the id itself. */
export function donorTweetId(source = {}) {
  const m = String(source?.url || '').match(/status(?:es)?\/(\d{10,})/);
  if (m) return m[1];
  return /^\d{10,}$/.test(String(source?.id || '')) ? String(source.id) : null;
}

/**
 * PURE. The files to upload for a donor tweet's own media (a twitter241 tweet object): up to 4 photos at
 * large size, or its one video/GIF as the highest-bitrate mp4. [] for a text-only tweet.
 */
export function donorMediaFiles(tweet, name = 'hook') {
  const media = ((tweet?.legacy?.extended_entities || tweet?.legacy?.entities || {}).media) || [];
  const video = media.find((m) => m.type === 'video' || m.type === 'animated_gif');
  if (video) {
    const mp4 = (video.video_info?.variants || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return mp4 ? [{ url: mp4.url, name: `${name}.mp4`, kind: 'video' }] : [];
  }
  return media.filter((m) => m.media_url_https).slice(0, 4).map((m, i) => ({ url: `${m.media_url_https}?name=large`, name: `${name}-${i}.jpg`, kind: 'image' }));
}

// ---- CLI ------------------------------------------------------------------------------------------

// A child process, awaited: rows in flight each run their own clip-find and media-find.
function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60 * 1000);
    child.on('close', (status) => { clearTimeout(timer); done({ out, err, status }); });
    child.on('error', (e) => { clearTimeout(timer); done({ out, err: `${err}${e.message}`, status: 1 }); });
  });
}
const lastLine = (r) => `${r.err}\n${r.out}`.split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l)).at(-1)?.slice(0, 160) || '';
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);

/**
 * The ORIGINAL hook's media (the donor swipe row) appended to tweet 1 of the review draft, beside whatever
 * the hook pass put there: the owner sees both and keeps one. Returns { recId, kind, count } or a reason.
 */
async function appendOriginalHookMedia(env, tf, row, recId, { already = [] } = {}) {
  const { airtable } = await import('../lib.mjs');
  const { uploadPick } = await import('./media-find.mjs');
  const { buildPlatforms } = await import('../platforms.mjs');
  const { mediaAcrossPlatforms } = await import('../media-map.mjs');
  const { mediaOf } = await import('../swipe-media.mjs');
  const { TABLES } = await import('../config.mjs');
  const xdb = airtable(env);
  // Added by an earlier pass and still on the hook (a re-run after a failure, or --force): never twice.
  const hook = (await tf.getDraft(row.socialSetId, row.draftId))?.platforms?.x?.posts?.[0]?.media_ids || [];
  if (already.length && already.some((id) => hook.includes(id))) return { recId, kind: 'kept', count: already.length, ids: already, kept: true };
  // A text-only original is the normal case: nothing to add, and not a failure.
  if (!mediaOf((await xdb.getRecord(TABLES.swipe, recId))?.fields || {})) return { recId, kind: null, count: 0 };
  const up = await uploadPick(env, { at: xdb, tf, pick: { id: recId }, socialSetId: row.socialSetId });
  const fresh = await tf.getDraft(row.socialSetId, row.draftId);
  const refusal = reviewDraftRefusal(fresh);
  if (refusal) throw new Error(refusal);
  const posts = fresh.platforms.x.posts.map((p) => ({ ...p, media_ids: [...(p.media_ids || [])] }));
  posts[0].media_ids = [...posts[0].media_ids, ...up.ids];
  await tf.patchDraft(row.socialSetId, row.draftId, { platforms: buildPlatforms(posts, { existing: fresh.platforms, platformPosts: mediaAcrossPlatforms(posts, fresh.platforms) }) });
  const back = await tf.getDraft(row.socialSetId, row.draftId);
  const landed = up.ids.every((id) => (back?.platforms?.x?.posts?.[0]?.media_ids || []).includes(id));
  if (!landed) throw new Error('the original media did not read back on the hook');
  return { recId, kind: up.kind, count: up.ids.length, ids: up.ids };
}

/**
 * The donor's own hook media read LIVE from X (twitter241), for a donor with no swipe row or a swipe row with
 * no media: hot-list heads and pool reruns are not in the swipe table, and the swipe pass returned nothing on
 * them silently (2026-11-18: 9 of 15 hooks bare). Uploaded and appended to tweet 1 like the swipe original.
 */
async function appendLiveHookMedia(env, tf, row, tweetId, { already = [] } = {}) {
  const { collectAllTweets } = await import('../competitor-thread.mjs');
  const { buildPlatforms } = await import('../platforms.mjs');
  const { mediaAcrossPlatforms } = await import('../media-map.mjs');
  const hook = (await tf.getDraft(row.socialSetId, row.draftId))?.platforms?.x?.posts?.[0]?.media_ids || [];
  if (already.length && already.some((id) => hook.includes(id))) return { tweetId, from: 'live', kind: 'kept', count: already.length, ids: already, kept: true };
  let res;
  for (let tries = 0; tries < 3; tries++) {
    res = await fetch(`https://twitter241.p.rapidapi.com/tweet?pid=${tweetId}`, { headers: { 'x-rapidapi-host': 'twitter241.p.rapidapi.com', 'x-rapidapi-key': env.RAPIDAPI_KEY } });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1500 * (tries + 1)));
  }
  if (!res.ok) throw new Error(`twitter241 HTTP ${res.status}`);
  const tweet = collectAllTweets(await res.json()).find((t) => t.rest_id === tweetId);
  if (!tweet) throw new Error('the donor tweet is not in the payload (deleted?)');
  const files = donorMediaFiles(tweet, row.id);
  if (!files.length) return { tweetId, from: 'live', kind: null, count: 0 };
  const ids = [];
  for (const f of files) {
    const got = await fetch(f.url);
    if (!got.ok) throw new Error(`download HTTP ${got.status}`);
    if (f.kind === 'video' && !String(got.headers.get('content-type') || '').startsWith('video')) throw new Error('the donor video did not download as a video');
    ids.push(await tf.uploadMedia(row.socialSetId, f.name, Buffer.from(await got.arrayBuffer())));
  }
  const fresh = await tf.getDraft(row.socialSetId, row.draftId);
  const refusal = reviewDraftRefusal(fresh);
  if (refusal) throw new Error(refusal);
  const posts = fresh.platforms.x.posts.map((p) => ({ ...p, media_ids: [...(p.media_ids || [])] }));
  posts[0].media_ids = [...posts[0].media_ids, ...ids];
  await tf.patchDraft(row.socialSetId, row.draftId, { platforms: buildPlatforms(posts, { existing: fresh.platforms, platformPosts: mediaAcrossPlatforms(posts, fresh.platforms) }) });
  const back = await tf.getDraft(row.socialSetId, row.draftId);
  if (!ids.every((id) => (back?.platforms?.x?.posts?.[0]?.media_ids || []).includes(id))) throw new Error('the live original did not read back on the hook');
  return { tweetId, from: 'live', kind: files[0].kind, count: ids.length, ids };
}

async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const runDir = flag('run-dir') && resolve(flag('run-dir'));
  if (!runDir) throw new Error('Usage: run-media.mjs --run-dir RUN [--input SPEC] [--rows a,b] [--clips cut|reuse|off] [--max-cuts N] [--parallel N] [--no-original] [--no-swipe] [--hook-only] [--force] [--dry]');
  if (runDir === ROOT || runDir.startsWith(`${ROOT}/`)) throw new Error('RUN_DIR must be outside the repository: it quotes unpublished copy');
  const clips = flag('clips') || RUN_MEDIA_RULES.clips;
  if (!['cut', 'reuse', 'off'].includes(clips)) throw new Error('--clips must be cut, reuse or off');
  const maxCuts = Number(flag('max-cuts') ?? RUN_MEDIA_RULES.maxCuts);
  if (!Number.isInteger(maxCuts) || maxCuts < 0) throw new Error('--max-cuts must be a whole number (0 or more)');
  const pool = cutPool(clips === 'cut' ? maxCuts : 0);
  const parallel = Number(flag('parallel') ?? RUN_MEDIA_RULES.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error('--parallel must be a whole number (1 or more)');
  const dry = argv.includes('--dry'), swipe = !argv.includes('--no-swipe'), withOriginal = !argv.includes('--no-original'), hookOnly = argv.includes('--hook-only');
  const spec = flag('input') ? readJson(resolve(flag('input'))) : null;
  const sourceOf = new Map((spec?.rows || []).map((r) => [r.id, String(r.source?.id || '')]));
  const specRow = new Map((spec?.rows || []).map((r) => [r.id, r]));
  const { rolesOf } = await import('../decisions/editorial-prescore.mjs');
  const ledgerFile = join(runDir, 'media.json');
  const media = readJson(ledgerFile) || {};
  const { todo, skipped } = mediaTodo(readJson(join(runDir, 'review-drafts.json')) || {}, media,
    { rows: flag('rows') ? flag('rows').split(',').map((s) => s.trim()).filter(Boolean) : null, force: argv.includes('--force') });
  const dir = join(runDir, 'media');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { loadEnv, typefully } = await import('../lib.mjs');
  const env = loadEnv();
  const tf = typefully(env);
  console.log(`media · ${todo.length} row(s), ${parallel} at a time · clips ${clips}${clips === 'cut' ? ` (≤${pool.left()} fresh cuts, hooks first)` : ''} · original hook media ${withOriginal ? 'on' : 'off'} · swipe ${swipe ? 'on' : 'off'}${dry ? ' · DRY' : ''}`);
  for (const s of skipped) console.log(`  · ${s.id.padEnd(16)} ${s.reason}`);
  const state = new Map();
  const ruleArgs = (st) => [...(st.rules?.noVideo?.length ? ['--no-video', st.rules.noVideo.join(',')] : []), ...(st.rules?.strict?.length ? ['--strict', st.rules.strict.join(',')] : []),
    ...(st.rules?.highBar?.length ? ['--high-bar', st.rules.highBar.join(',')] : [])];
  const clipArgs = (row, out, cuts, extra = []) => ['scripts/clip-find.mjs', '--draft', row.draftId, ...(row.account ? ['--account', row.account] : []), '--pool', '--out', out, ...ruleArgs(state.get(row.id)), ...extra,
    ...(dry || clips === 'off' ? [] : ['--cut', '--max-cuts', String(cuts)]), ...(clips === 'cut' ? ['--no-stored'] : [])];
  // A clip-find with its reservation from the run-wide pool; a paid cut counts even when the run failed after it.
  if (!process.env.CLIPPER_TIMEOUT_S) process.env.CLIPPER_TIMEOUT_S = String(RUN_CUT_TIMEOUT_S);
  const breaker = cutBreaker();
  const clipRun = async (row, out, want, extra = []) => {
    if (!dry && breaker.open()) return { status: 1, skipped: true, out: '', err: `clip cut skipped: the cutter failed twice this pass (${breaker.reason().slice(0, 90)})` };
    const reserved = dry ? 0 : pool.reserve(want);
    const r = await run(clipArgs(row, out, reserved, extra));
    const cut = cutsIn(r.out);
    pool.settle(reserved, cut);
    breaker.record({ ok: r.status === 0, cutting: cut > 0, line: lastLine(r) });
    return r;
  };
  const timing = { rows: new Map() };
  const clock = (id, key, ms) => { const t = timing.rows.get(id) || {}; t[key] = (t[key] || 0) + ms; timing.rows.set(id, t); };

  // PHASE 1: the hook of every row, `parallel` rows at a time (each hook reserves at most its one cut).
  let t0 = Date.now();
  await mapLimit(todo, parallel, async (row) => {
    const started = Date.now();
    const st = { notes: [], clipReports: [], swipeReport: null, original: null, refused: null };
    state.set(row.id, st);
    const draft0 = await tf.getDraft(row.socialSetId, row.draftId).catch(() => null);
    st.refused = reviewDraftRefusal(draft0);
    if (st.refused) return;
    // Placement rules from the thread's roles: the spec's copy when it is the draft's copy, else its plugs.
    const live = (draft0.platforms?.x?.posts || []).map((p) => String(p.text || ''));
    const s = specRow.get(row.id);
    let roles = null;
    if (s?.draft?.tweets?.length === live.length) {
      try { roles = rolesOf({ tweets: s.draft.tweets, products: s.draft.products || [], account: s.account, ctaDepth: s.draft.ctaDepth }); } catch { roles = null; }
    }
    st.rules = placementRules({ tweets: live, roles, isPlug: isLinkTweet });
    if (clips !== 'off') {
      const out = join(dir, `${row.id}.hook.json`);
      const r = await clipRun(row, out, 1, ['--only', '1']);
      if (r.skipped) st.notes.push(r.err);
      else if (r.status !== 0) st.notes.push(`hook clip failed: ${lastLine(r)}`);
      else st.clipReports.push(readJson(out));
    }
    const recId = sourceOf.get(row.id);
    // The new clip wins: the original is the fallback for a hook no new clip reached.
    const newMedia = hookHasNewMedia({ reports: st.clipReports, live: draft0.platforms?.x?.posts?.[0]?.media_ids || [],
      original: media[row.id]?.original?.ids || [], dry });
    const tweetId = donorTweetId(specRow.get(row.id)?.source);
    if (withOriginal && !newMedia && (/^rec[A-Za-z0-9]{14}$/.test(recId || '') || tweetId)) {
      if (dry) st.original = { recId, tweetId, kind: '?', count: 0, dry: true };
      else {
        const already = media[row.id]?.original?.ids || [];
        if (/^rec[A-Za-z0-9]{14}$/.test(recId || '')) {
          try { st.original = await appendOriginalHookMedia(env, tf, row, recId, { already }); }
          catch (e) { st.notes.push(`original hook media (swipe) not added: ${String(e.message).slice(0, 100)}`); }
        }
        // No swipe row, or one with no media: read the donor tweet itself.
        if (!st.original?.count && tweetId) {
          try { st.original = await appendLiveHookMedia(env, tf, row, tweetId, { already }); }
          catch (e) { st.notes.push(`original hook media (live) not added: ${String(e.message).slice(0, 100)}`); }
        }
      }
    }
    clock(row.id, 'hook', Date.now() - started);
  });
  const hookMs = Date.now() - t0;
  // PHASE 2: the body, then swipe media for whatever is still bare; in order within a row, rows in parallel.
  t0 = Date.now();
  const { CLIP_RULES: VIDEO_RULES } = await import('../clip-judge.mjs');
  await mapLimit(todo, parallel, async (row) => {
    const st = state.get(row.id);
    if (st.refused) return;
    if (hookOnly) return;   // --hook-only: the body stays bare
    // The video cap: an earlier pass on this same draft left its videos there; the hook spent its share.
    const earlier = earlierVideos(media[row.id], row.draftId);
    const budget = () => videoBudget({ cap: VIDEO_RULES.perThread.maxVideos, earlierVideos: earlier, placedClips: clipsPlaced(st.clipReports, { dry }), originalVideo: st.original?.kind === 'video' });
    st.videoCap = { cap: VIDEO_RULES.perThread.maxVideos, beforeBody: budget() };
    if (clips !== 'off' && budget() > 0) {
      const started = Date.now();
      const out = join(dir, `${row.id}.clips.json`);
      const r = await clipRun(row, out, RUN_MEDIA_RULES.bodyCutsPerRow, ['--max-clips', String(budget())]);
      if (r.skipped) st.notes.push(r.err);
      else if (r.status !== 0) st.notes.push(`clips failed: ${lastLine(r)}`);
      else st.clipReports.push(readJson(out));
      clock(row.id, 'clips', Date.now() - started);
    }
    st.videoCap.forSwipe = budget();
    if (swipe) {
      const started = Date.now();
      const out = join(dir, `${row.id}.swipe.json`);
      const r = await run(['scripts/media-find.mjs', '--draft', row.draftId, ...(row.account ? ['--account', row.account] : []), ...ruleArgs(st), '--max-videos', String(st.videoCap.forSwipe), '--json', out, ...(dry ? [] : ['--attach'])]);
      if (r.status !== 0) st.notes.push(`swipe failed: ${lastLine(r)}`);
      else st.swipeReport = readJson(out);
      clock(row.id, 'swipe', Date.now() - started);
    }
  });
  const bodyMs = Date.now() - t0;
  const lines = [];
  const { CLIP_RULES } = await import('../clip-judge.mjs');
  const rulesLine = (st) => (st.rules ? `      rules (${st.rules.from}): no video on ${st.rules.noVideo.map((n) => `t${n}`).join(', ') || '—'} · strict (≤${CLIP_RULES.strict.maxS}s, higher bar) on ${st.rules.strict.map((n) => `t${n}`).join(', ') || '—'} · higher bar, any length, on ${st.rules.highBar.map((n) => `t${n}`).join(', ')}` : null);
  for (const row of todo) {
    const st = state.get(row.id);
    const note = st.notes.length ? ` · ${st.notes.join(' · ')}` : '';
    if (st.refused) { lines.push(`  ✗ ${row.id.padEnd(16)} ${st.refused} — skipped`); continue; }
    if (dry) {
      const clipPicks = st.clipReports.flatMap((c) => c?.decisions || []).filter((d) => ['reuse', 'cut'].includes(d.action)).length;
      const swipePicks = (st.swipeReport?.tweets || []).filter((t) => t.pick).length;
      lines.push(`  · ${row.id.padEnd(16)} would place ${clipPicks} clip(s)${st.original ? ` + the original hook media (${st.original.recId || st.original.tweetId})` : ''}, ${swipePicks} swipe pick(s)${note}`);
      if (rulesLine(st)) lines.push(rulesLine(st));
      continue;
    }
    const after = await tf.getDraft(row.socialSetId, row.draftId).catch(() => null);
    if (!after) { lines.push(`  ✗ ${row.id.padEnd(16)} unverified: the review draft could not be read back${note}`); continue; }
    const summary = withEarlier(mediaSummary(after, { clipReports: st.clipReports, swipeReport: st.swipeReport, original: st.original }), media[row.id]);
    // A failed matcher leaves the row open for the next pass (no copy digest recorded).
    media[row.id] = { draftId: row.draftId, socialSetId: row.socialSetId, account: row.account, contentSha256: st.notes.length ? null : row.contentSha256,
      at: new Date().toISOString(), ...summary, original: st.original, placement: st.rules, notes: st.notes };
    lines.push(`  ${st.notes.length ? '⚠️' : '✓'} ${row.id.padEnd(16)} ${summary.withMedia} tweet(s) with media · hook ${summary.hook || 'none'}${st.original && !st.original.count ? ' (original hook is text-only)' : ''} · ${summary.clips} clip · ${summary.swipe} swipe${st.videoCap ? ` · video cap ${st.videoCap.cap} (body ${st.videoCap.beforeBody}, swipe ${st.videoCap.forSwipe} left)` : ''}${note}`);
    if (rulesLine(st)) lines.push(rulesLine(st));
    for (const t of summary.tweets.filter((x) => x.media && x.source !== 'other')) lines.push(`      t${t.tweet}${t.media > 1 ? ` (${t.media} items: keep one)` : ''}: ${t.why}`);
  }
  console.log(lines.join('\n'));
  if (!dry && todo.length) writeFileSync(ledgerFile, JSON.stringify(media, null, 1), { mode: 0o600 });
  if (clips === 'cut') console.log(`  fresh cuts left in this pass: ${pool.left()}`);
  // Where the time went (the owner asked why the pass is slow): each phase's wall clock, and the slowest rows.
  const slow = [...timing.rows].map(([id, t]) => [id, (t.hook || 0) + (t.clips || 0) + (t.swipe || 0), t]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`  time: hooks ${secs(hookMs)} · body ${secs(bodyMs)} (${parallel} rows at a time)${slow.length ? ` · slowest ${slow.map(([id, ms, t]) => `${id} ${secs(ms)} (hook ${secs(t.hook || 0)}, clips ${secs(t.clips || 0)}, swipe ${secs(t.swipe || 0)})`).join('; ')}` : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
