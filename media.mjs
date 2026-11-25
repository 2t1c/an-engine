// media.mjs — "follow the reference" media reuse. For a recreation draft:
//   1. Resolve its source thread (ledger.jsonl by draftId, fallback scratchpad Source URL).
//   2. Read the reference's child tweet rows from Airtable: which tweets carried
//      which images/videos (Media attachments / Video File / Video URL).
//   3. Map each reference position to our draft (hook -> hook, numbered lesson N
//      -> our tweet starting "N."), skipping tweets that already have media.
//   4. Download bytes -> Typefully presigned upload -> attach media_ids via PATCH.
// X rule respected: one video alone OR <=4 images per tweet, never mixed.
//   node media.mjs <draftId> [--account julian] [--dry]
import { fxVideoByNum } from './fx-read.mjs';
import { buildPlatforms, CROSS_POST_PLATFORMS } from './platforms.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, typefully, HERE_DIR } from './lib.mjs';
import { getAccount, defaultAccountKey } from './accounts.mjs';
import { TABLES, ATTACH_MEDIA } from './config.mjs';
import { parseVirtualId } from './thread-fold.mjs';
import { lessonNum, cleanName, mapItem, fallbackIndex, mediaAcrossPlatforms } from './media-map.mjs';
// Re-exported: mediaAcrossPlatforms moved to media-map.mjs (2026-09-06) so seed-media.mjs could use
// it WITHOUT importing this file, whose module top level exits the process when ATTACH_MEDIA is off.
export { mediaAcrossPlatforms };

// FEATURE SWITCH (config.mjs ATTACH_MEDIA, operator 2026-07-21): media attachment is toggleable —
// text-only mode is a deliberate option (retention + no similar-image-ID detection). Guarding here
// makes EVERY caller (daily-winners, run-weekly, fix-scheduled-media, manual) honor the one flag.
// The guard sits in main(), not at module top level: a top-level process.exit(0) also killed any
// process that merely IMPORTED this file (test-scaffolds stopped half-way, exit 0, when it went off).

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const draftId = args.find((a) => /^\d{6,}$/.test(a));
const ACCOUNT = getAccount(flag('account', defaultAccountKey()));
// --as <key>: WHOSE VOICE this draft is written in, when that differs from whose social set holds
// it. A greenhouse preview lives on the burner set but carries another page's closing and
// disclaimer, and conflating the two put four donor images on rasmus 10602249's LEGAL DISCLAIMER —
// the one target the fallback below is explicitly written never to choose, because it matched the
// burner's boilerplate instead of Rasmus's. Defaults to --account, so every existing caller is
// unchanged.
const VOICE = getAccount(flag('as', flag('account', defaultAccountKey())));
const THREADS = TABLES.swipe;

function sourceFor(draftId, scratchpad) {
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try { const e = JSON.parse(line); if (String(e.draftId) === String(draftId)) return { recId: e.recId, url: e.sourceUrl }; } catch {}
    }
  }
  const m = (scratchpad || '').match(/Source:\s*(?:@\S+\s*[—-]\s*)?(https:\/\/x\.com\/\S+?\/status\/\d+)/i);
  return m ? { url: m[1] } : null;
}

async function referenceMedia(at, head) {
  // Evidence-based: trust attachments + mime types over the (often missing) Media Type select.
  const out = [];
  for (const id of head.fields.Tweets || []) {
    const f = (await at.getRecord(THREADS, id)).fields;
    const n = f['Tweet Number'] || 0;
    const lesson = lessonNum(f.Text);
    // VIDEO detection: any signal (rehosted MP4, twimg URL, or Media Type=Video) means the
    // reference is a video — match it. Its Media attachment is only a poster frame, never insert
    // that as an "image". (Bug fix: previously a video hook with no Media Type fell through to its
    // poster and got inserted as an image, mismatching the reference type.)
    const vf = (f['Video File'] || [])[0];
    const videoUrl = vf?.url || f['Video URL'];
    if (videoUrl || f['Media Type'] === 'Video') {
      if (videoUrl) out.push({ n, kind: 'video', url: videoUrl, name: cleanName(vf?.filename || `video-${n}.mp4`, 'mp4'), lesson, text: f.Text || '' });
      // else: a video with no fetchable URL — skip rather than insert its poster image as the wrong type
      continue;
    }
    (f.Media || []).slice(0, 4).forEach((att, i) => {
      const mime = att.type || '';
      // `text` rides along so the mapping can check the TOPIC, not only the item number: Run 2 put a
      // donor's protein chart on our creatine item and a magnesium PubMed shot on a beet item, purely
      // because both were "N.". See media-map.mjs sharesTopic.
      if (mime.startsWith('video')) out.push({ n, kind: 'video', url: att.url, name: cleanName(att.filename || `video-${n}.mp4`, 'mp4'), lesson, text: f.Text || '' });
      else out.push({ n, kind: 'image', url: att.url, name: cleanName(att.filename || `image-${n}-${i}.jpg`, 'jpg'), lesson, text: f.Text || '' });
    });
  }
  return out.sort((a, b) => a.n - b.n);
}

// --- generation self-check: verify each reference item's type against the LIVE source and self-heal ---
function collectTweets(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (obj.rest_id && obj.legacy) acc.push(obj);
  for (const k in obj) if (obj[k] && typeof obj[k] === 'object') collectTweets(obj[k], acc);
  return acc;
}
// Map of reference tweet-number (1-based) -> mp4 URL for tweets that are ACTUALLY videos on X.
// twitter241 first; with no key, or when it refuses (outage since 2026-11-24), FxTwitter's free thread
// read answers. Null only when neither answers (then we trust Airtable + the format guard below).
async function liveVideoByNum(env, hookId) {
  if (!hookId) return null;
  const viaRapid = env.RAPIDAPI_KEY && env.X_READ_FX_ONLY !== '1' ? await liveVideoRapid(env, hookId) : null;
  return viaRapid || fxVideoByNum(hookId);
}
async function liveVideoRapid(env, hookId) {
  try {
    const r = await fetch(`https://twitter241.p.rapidapi.com/tweet?pid=${hookId}`, { headers: { 'x-rapidapi-host': 'twitter241.p.rapidapi.com', 'x-rapidapi-key': env.RAPIDAPI_KEY } });
    if (!r.ok) return null;
    const tweets = collectTweets(await r.json());
    const head = tweets.find((t) => t.rest_id === hookId);
    const uid = head?.legacy?.user_id_str; if (!uid) return null;
    const mine = tweets.filter((t) => t.legacy?.user_id_str === uid).sort((a, b) => (BigInt(a.rest_id) > BigInt(b.rest_id) ? 1 : -1));
    const map = new Map();
    mine.forEach((t, i) => {
      const m = (t.legacy?.extended_entities?.media || [])[0];
      if (m && (m.type === 'video' || m.type === 'animated_gif')) {
        const v = (m.video_info?.variants || []).filter((x) => x.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (v) map.set(i + 1, v.url); // reference tweet number (1-based) -> mp4
      }
    });
    return map;
  } catch { return null; }
}
async function airtableSetVideo(env, recId, url) { // raw PATCH (the shared helper is read-only)
  try { await fetch(`https://api.airtable.com/v0/${env.XDB_BASE_ID}/${TABLES.swipe}`, { method: 'PATCH', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [{ id: recId, fields: { 'Media Type': 'Video', 'Video URL': url } }] }) }); } catch {}
}

async function main() {
  // PI_FORCE_MEDIA=1 runs one pass anyway: the dry-run safety test, or a deliberate manual run.
  if (!ATTACH_MEDIA && process.env.PI_FORCE_MEDIA !== '1') { console.log('media: ATTACH_MEDIA=false (config.mjs) — feature disabled, exiting as a no-op'); return; }
  if (!draftId) throw new Error('Pass a Typefully draft id');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'TYPEFULLY_API_KEY']);
  const at = airtable(env), tf = typefully(env);

  const draft = await tf.getDraft(ACCOUNT.socialSetId, draftId);
  const posts = draft.platforms.x.posts.map((p) => ({ text: p.text, media_ids: [...(p.media_ids || [])] }));

  // --mirror-only: REPAIR a cross-post that X's media never reached, using what X already holds.
  // Every draft built before the mirror shipped (2026-08-31) has this shape: media on X, none on
  // the copy, because the media pass ran once at generation and publishing does not re-run it.
  //
  // It deliberately re-uploads NOTHING. --wipe would rebuild from the source attachments, which is
  // wrong for a repair (a since-deleted source silently returns FEWER images than the draft has),
  // and --force would re-attach over the top, stacking duplicates on any tweet under the 4-image
  // cap. Mirroring what X holds is exact, idempotent, and cannot touch the X copy at all.
  if (args.includes('--mirror-only')) {
    const platformPosts = mediaAcrossPlatforms(posts, draft?.platforms);
    const targets = CROSS_POST_PLATFORMS.filter((p) => draft?.platforms?.[p]?.enabled);
    if (!targets.length) return console.log(`Draft ${draftId} targets no cross-post platform — nothing to mirror.`);
    if (!platformPosts) return console.log(`Draft ${draftId}: post counts differ from X — NOT mirrored (would misalign).`);
    for (const p of targets) console.log(`  ↳ ${p}: ${platformPosts[p].filter((t) => t.media_ids.length).length} post(s) get media, text and links untouched`);
    // --dry HOLDS HERE TOO (2026-09-23). This branch returns before the dry check at the end of
    // main, so `--mirror-only --dry` PATCHed the very draft it had only been asked to preview.
    if (DRY) return console.log('(dry run)');
    await tf.patchDraft(ACCOUNT.socialSetId, draftId, {
      ...(draft.draft_title ? { draft_title: draft.draft_title } : {}),
      ...(draft.scratchpad_text ? { scratchpad_text: draft.scratchpad_text } : {}),
      ...(draft.scheduled_date ? { publish_at: draft.scheduled_date } : {}),
      platforms: buildPlatforms(posts, { existing: draft.platforms, account: ACCOUNT, platformPosts }),
    });
    return console.log(`✓ Draft ${draftId} cross-post media mirrored — no uploads, X untouched.`);
  }
  if (args.includes('--wipe')) posts.forEach((p) => { p.media_ids = []; }); // start clean, then re-attach in this run
  // Double-run guard: re-running stacks duplicate images under the 4-per-tweet cap.
  if (posts.some((p) => p.media_ids.length) && !args.includes('--force')) {
    console.log('Draft already has media — refusing to re-run (use --wipe to rebuild clean, --force to add anyway).');
    return;
  }
  const src = sourceFor(draftId, draft.scratchpad_text);
  if (!src) { console.log('No source thread resolvable (legacy/manual draft) — leaving media as-is.'); return; }

  let head;
  if (src.recId) head = await at.getRecord(THREADS, src.recId);
  else {
    const recs = await at.list(THREADS, { formula: `{Tweet URL}="${src.url}"`, pageSize: 1 });
    if (!recs.length) throw new Error(`No Airtable row for ${src.url}`);
    head = recs[0];
  }

  const media = await referenceMedia(at, head);
  console.log(`${draft.draft_title || draftId}: reference has ${media.length} media item(s)`);
  // SELF-CHECK (video parity): if a reference tweet is truly a video on X but Airtable stored only its
  // poster image, upgrade it to the real MP4 and fix the Airtable row — so our version is a video wherever
  // the reference is. No-op without RAPIDAPI_KEY (then we trust Airtable + the format guard at attach).
  // src.url is absent whenever the spec carried only a recId (every hand-written in-session draft),
  // and .match on null took the whole media pass down. Fall back to the Airtable row's own URL so the
  // video-parity self-check still runs on those drafts instead of being skipped.
  const srcUrl = src.url || head?.fields?.['Tweet URL'] || '';
  const liveVid = await liveVideoByNum(env, (String(srcUrl).match(/status\/(\d+)/) || [])[1]);
  if (liveVid) {
    let healed = 0;
    for (const item of media) {
      const mp4 = liveVid.get(item.n);
      if (!mp4) continue;
      if (item.kind === 'image') { // an image was stored for a tweet that is really a video -> upgrade + fix DB
        item.kind = 'video'; item.url = mp4; item.name = item.name.replace(/\.[a-z0-9]+$/i, '.mp4');
        const recId = (head.fields.Tweets || [])[item.n - 1];
        // A --dry run upgrades the item in memory, so the plan below still shows the video, and
        // leaves the swipe row alone (2026-09-23). This PATCH ran ahead of the dry return, so a dry
        // run with RAPIDAPI_KEY set rewrote Airtable while claiming only to plan.
        // A folded thread's body tweet has no row to fix (thread-fold.mjs): keep the upgrade in memory only.
        if (recId && !DRY && !parseVirtualId(recId)) await airtableSetVideo(env, recId, mp4);
        healed++;
      } else if (item.kind === 'video') {
        item.url = mp4; // RULE: a video MUST carry the real live MP4, never a stale/poster URL
      }
    }
    console.log(healed ? `  🔧 self-check: upgraded ${healed} reference item(s) image -> video (live X)${DRY ? ' — Airtable left alone (dry run)' : ' + fixed Airtable'}` : '  ✓ self-check: media types match the live reference');
  }
  if (!media.length) { console.log('Reference is text-only — nothing to attach. ✓ (follows reference)'); return; }

  const plan = [];
  // Unmapped-media fallback target: the sign-off / closing tweet (never the legal disclaimer). When a
  // reference image can't be confidently mapped to a lesson, append it here instead of dropping it, so
  // the source's visual parity survives. Videos are NOT redirected (a video must post alone).
  const fbIdx = fallbackIndex(posts, VOICE);
  const plannedImgs = (i) => posts[i].media_ids.length + plan.filter((p) => p.idx === i && p.kind === 'image').length;
  const plannedVideo = (i) => plan.some((p) => p.idx === i && p.kind === 'video');
  for (const item of media) {
    const m = mapItem(item, posts);
    let idx = m.idx;
    if (idx < 0) {
      // A TOPIC MISS IS NEVER PARKED. The sign-off fallback exists for an item our body simply does
      // not have; an item whose subject disagrees with the tweet it numbers is a picture of something
      // else, and the sign-off is where a reader would take it for ours.
      const topicMiss = /is about/.test(m.why);
      if (!topicMiss && item.kind === 'image' && fbIdx >= 0 && !plannedVideo(fbIdx) && plannedImgs(fbIdx) < 4) {
        idx = fbIdx;
        console.log(`  ⚠️ ref tweet ${item.n} (image): ${m.why} — appending to closing tweet ${idx + 1} (was dropped before)`);
      } else { console.log(`  ⚠️ ref tweet ${item.n} (${item.kind}): ${m.why} — skipped${topicMiss ? ' (topic mismatch: never parked)' : ' (attach manually if wanted)'}`); continue; }
    }
    const target = posts[idx];
    if (item.kind === 'video' && target.media_ids.length) { console.log(`  ⚠️ tweet ${idx + 1} already has media; video skipped`); continue; }
    if (item.kind === 'image' && target.media_ids.length >= 4) { console.log(`  ⚠️ tweet ${idx + 1} full (4 images)`); continue; }
    plan.push({ ...item, idx });
    console.log(`  ${item.kind} (ref tweet ${item.n}${item.lesson ? ', lesson ' + item.lesson : ''}) -> our tweet ${idx + 1}  [${m.why}]`);
  }
  if (DRY || !plan.length) { console.log(DRY ? '(dry run)' : 'Nothing attachable.'); return; }

  for (const p of plan) {
    const res = await fetch(p.url);
    if (!res.ok) { console.log(`  ✗ download failed (${res.status}) for ref tweet ${p.n}`); continue; }
    // Format guard: the fetched bytes MUST match the intended kind. This is what stops a video's
    // poster frame ever being uploaded as a "video" (or a type mismatch) — verify before inserting.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (p.kind === 'video' && !ct.startsWith('video')) { console.log(`  🚨 RULE: ref tweet ${p.n} is a VIDEO but only a poster ("${ct || 'unknown'}") is available — NOT attaching an image in its place. Fix the source video URL.`); continue; }
    if (p.kind === 'image' && !(ct.startsWith('image') || ct.startsWith('video'))) { console.log(`  ⚠️ skip tweet ${p.idx + 1}: expected an image but got "${ct || 'unknown'}"`); continue; }
    if (p.kind === 'image' && ct.startsWith('video')) { console.log(`  ⚠️ skip tweet ${p.idx + 1}: row tagged image but URL is a video — fix the Airtable Media Type`); continue; }
    const bytes = Buffer.from(await res.arrayBuffer());
    const mediaId = await tf.uploadMedia(ACCOUNT.socialSetId, p.name, bytes);
    posts[p.idx].media_ids.push(mediaId);
    console.log(`  ✓ uploaded ${p.kind} (${(bytes.length / 1e6).toFixed(1)}MB) -> tweet ${p.idx + 1} (${mediaId.slice(0, 8)}…)`);
  }
  // Mirror the media onto every cross-posted platform. Note this also REPAIRS an already-broken
  // draft with no re-upload: `posts` starts as a copy of X's existing media ids, so a --force run
  // that attaches nothing new still carries what X already has across to Threads.
  const platformPosts = mediaAcrossPlatforms(posts, draft?.platforms);
  for (const p of CROSS_POST_PLATFORMS) {
    if (!draft?.platforms?.[p]?.enabled) continue;
    if (platformPosts?.[p]) console.log(`  ↳ ${p}: media mirrored onto ${platformPosts[p].filter((t) => t.media_ids.length).length} post(s), links untouched`);
    else console.log(`  ⚠️ ${p}: post count differs from X — media NOT mirrored (would misalign)`);
  }
  await tf.patchDraft(ACCOUNT.socialSetId, draftId, { platforms: buildPlatforms(posts, { existing: draft?.platforms, account: ACCOUNT, platformPosts }) });
  console.log(`✓ Draft ${draftId} updated with media (schedule preserved: ${draft.scheduled_date || 'unscheduled'})`);
}
// Entry guard so the pure helpers above are importable by the test scaffolds without this file
// running a live draft patch on import. Same shape harvest.mjs:141 uses. Direct invocation
// (`node media.mjs <draftId> --account <key>`, how daily-winners and fill-account call it)
// is unchanged.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
