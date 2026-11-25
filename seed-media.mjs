#!/usr/bin/env node
// seed-media.mjs — a PLANT carries the media of the body its seed was minted from.
//
// WHY (operator 2026-09-06: "let's pull media for seeds too once they turn into plant ready to go").
// media.mjs has carried a recreation's media since July, but it resolves its source through
// ledger.jsonl -> recId -> the Airtable SWIPE row, which is someone else's thread. A pot has no such
// donor: it descends from a seed, which descends from one of OUR harvested bodies. So every plant
// this farm has shipped went out text-only — not by decision, but because the resolver returned null
// and the run printed "No source thread resolvable" and exited 0.
//
// The chain this file walks instead:
//   plant draft -> ledger.jsonl seedRecId -> Seeds -> Source Harvest -> Harvests
//               -> Origin Account + Origin Draft ID -> that draft's own media_ids
//
// Media ids are scoped to a social set, so the origin's ids mean nothing on the target account.
// Each item is downloaded from its media_urls.original and re-uploaded to the plant's set. That is
// also why this is not a two-line addition to media.mjs: one lane reads bytes out of Airtable
// attachments, the other out of Typefully. They meet again at media-map.mjs, which decides WHERE
// each item lands, so the mapping is shared and only the resolution differs.
//
//   node seed-media.mjs <draftId> --account irana
//   node seed-media.mjs <draftId> --account irana --dry        # plan only, nothing uploaded
//   node seed-media.mjs <draftId> --account irana --seed recXXXXXXXX   # skip ledger resolution
//   node seed-media.mjs <draftId> --account irana --wipe        # rebuild clean
//
// Exits 0 when the origin is text-only. A seed whose origin carried nothing is a normal, common
// outcome (beet's origin has no media at all) and must not read as a failure.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, typefully, HERE_DIR } from './lib.mjs';
import { getAccount, defaultAccountKey } from './accounts.mjs';
import { buildPlatforms, CROSS_POST_PLATFORMS } from './platforms.mjs';
import { ATTACH_MEDIA, REGISTRY_TABLE } from './config.mjs';
import { lessonNum, cleanName, mapItem, fallbackIndex, mediaAcrossPlatforms } from './media-map.mjs';

/**
 * What the LEDGER knows about a draft's seed: { seedRecId, potOf }.
 *
 * Pure so the resolution is testable without a ledger on disk. Reads the LAST matching row rather
 * than the first: a re-published draft appends, and the newest row describes what is live.
 *
 * BOTH fields matter, and neither is guaranteed. publish-thread.mjs writes the record id only into
 * the REGISTRY (the farm stamp) — the ledger row it writes alongside carries `potOf`, the seed's
 * NAME, and nothing else. Every plant shipped so far therefore has a ledger row with no record id
 * at all, which is exactly how this file's first live run resolved nothing on a real plant. The
 * name is a legitimate fallback: seed names are unique in the registry and stable across versions.
 */
export function seedOfDraft(lines, draftId) {
  const out = { seedRecId: null, potOf: null };
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (String(e.draftId) !== String(draftId)) continue;
      if (e.seedRecId) out.seedRecId = e.seedRecId;
      if (e.potOf) out.potOf = e.potOf;
    } catch {}
  }
  return out;
}

/**
 * The origin's media items, in the shape media-map.mjs expects: { n, kind, lesson, ... }.
 *
 * `n` is the origin's 1-based tweet number and `lesson` its leading "N." marker, which is what makes
 * hook->hook and item-N->item-N work across two bodies that share a skeleton but not a word. KIND
 * COMES FROM THE MIME, never from the file name: a poster frame saved as video-1.mp4 would otherwise
 * be planned as a video and post alone on a tweet that should have carried an image.
 */
export function originItems(posts, statuses, originVoice = {}) {
  const out = [];
  const signoff = fallbackIndex(posts, originVoice);
  posts.forEach((p, i) => {
    for (const id of p.media_ids || []) {
      const st = statuses.get(id);
      if (!st) continue;
      const url = st.media_urls?.original;
      if (!url) continue;                                    // no full-size source — a resized copy is not what the origin posted
      const mime = String(st.mime || '');
      const kind = mime.startsWith('video') ? 'video' : 'image';
      // SIGN-OFF IS A NAMED SLOT, not a fallback. Magnus's origin carries all four of its images on
      // "Repost the first tweet to help someone add healthy years" — his garden's sign-off at the
      // time — and under hook/item-N mapping alone those four resolve to nothing and reach our
      // sign-off by accident, down the same path that catches a genuinely unmappable mid-body image.
      // Same destination today, but the log would call a correct match a failure, and the accident
      // stops the day a body's sign-off moves. Recognise the slot instead.
      const closing = i === signoff;
      // `text` is the origin tweet itself: the mapping checks that our item N is ABOUT what the
      // origin's item N was about, not merely that both are numbered N (media-map.mjs sharesTopic).
      out.push({ n: i + 1, kind, url, mime, closing, lesson: lessonNum(p.text), text: p.text || '', name: cleanName(st.file_name, kind === 'video' ? 'mp4' : 'jpg') });
    }
  });
  return out;
}

/**
 * Which item goes on which of our tweets, honoring X's rule (a video alone, at most 4 images, never
 * mixed) and never putting an unmapped item on a plug.
 *
 * Pure: takes the posts' CURRENT media counts and returns the plan, so a dry run and a real run make
 * the same decisions. Returns { plan, skipped } — skipped is reported, never swallowed, because a
 * dropped item is a silent difference from the body that earned the seed.
 */
export function planAttachments(items, posts, voice = {}) {
  const plan = [], skipped = [];
  const fbIdx = fallbackIndex(posts, voice);
  const imgs = (i) => (posts[i].media_ids || []).length + plan.filter((p) => p.idx === i && p.kind === 'image').length;
  const hasVideo = (i) => plan.some((p) => p.idx === i && p.kind === 'video');
  for (const item of items) {
    // Three confident slots and nothing else: hook -> hook, item N -> item N, sign-off -> sign-off.
    //
    // NO FALLBACK PARKING, and this is where the seed lane deliberately parts from media.mjs. There,
    // an unmappable image is appended to the sign-off so the DONOR's visual parity survives — right,
    // because a recreation runs the donor's own subject. A pot does not: the whole point of the seed
    // is that the family's shape carries DIFFERENT products, so an unplaceable image from the origin
    // is very often a photograph of something this thread does not sell. Rafael's olive origin puts a
    // creatine tub on its item-1 tweet; the pot grown from it opens on protein powder. Parking that
    // image anywhere in our body shows a reader a product we are not selling them. Skipping is the
    // conservative loss and the log names every one.
    const m = item.closing ? { idx: fbIdx, why: 'sign-off' } : mapItem(item, posts);
    const idx = m.idx;
    if (idx < 0) { skipped.push({ ...item, why: `${m.why} (hook / item N by topic / sign-off are the only slots)` }); continue; }
    if (item.kind === 'video' && ((posts[idx].media_ids || []).length || imgs(idx) || hasVideo(idx))) { skipped.push({ ...item, idx, why: `tweet ${idx + 1} already carries media (a video posts alone)` }); continue; }
    if (item.kind === 'image' && hasVideo(idx)) { skipped.push({ ...item, idx, why: `tweet ${idx + 1} is planned as a video (never mixed)` }); continue; }
    if (item.kind === 'image' && imgs(idx) >= 4) { skipped.push({ ...item, idx, why: `tweet ${idx + 1} already holds 4 images` }); continue; }
    plan.push({ ...item, idx });
  }
  return { plan, skipped };
}

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };

async function main() {
  if (!ATTACH_MEDIA) { console.log('seed-media: ATTACH_MEDIA=false (config.mjs) — feature disabled, exiting as a no-op'); return; }
  const draftId = args.find((a) => /^\d{6,}$/.test(a));
  if (!draftId) throw new Error('Pass a Typefully draft id');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY', 'REGISTRY_BASE_ID']);
  const at = airtable(env, env.REGISTRY_BASE_ID), tf = typefully(env);
  const target = getAccount(flag('account', defaultAccountKey()));
  const DRY = args.includes('--dry');

  // --- resolve the seed -------------------------------------------------------------------------
  // Three sources, most authoritative first. The registry's farm stamp is the real link and the one
  // the gate reads; the ledger is the fallback for a draft stamped before the Seed field existed or
  // whose stamp failed (publish-thread treats a failed stamp as one sync of lag, not an error).
  const seeds = await at.listAll('Seeds', {});
  let seedRecId = flag('seed'), how = 'the --seed flag';
  if (!seedRecId) {
    const pc = await at.list(REGISTRY_TABLE, { formula: `{Draft ID}="${draftId}"`, pageSize: 1 });
    seedRecId = (pc[0]?.fields?.Seed || [])[0] || null;
    if (seedRecId) how = 'the registry farm stamp';
  }
  if (!seedRecId) {
    const f = join(HERE_DIR, 'ledger.jsonl');
    const led = existsSync(f) ? seedOfDraft(readFileSync(f, 'utf8').split('\n').filter(Boolean), draftId) : { seedRecId: null, potOf: null };
    seedRecId = led.seedRecId || (led.potOf ? seeds.find((r) => r.fields.Name === led.potOf)?.id : null) || null;
    if (seedRecId) how = led.seedRecId ? 'the ledger' : `the ledger's potOf "${led.potOf}"`;
  }
  if (!seedRecId) { console.log('No seed on this draft (not a plant) — media.mjs owns the donor lane. Nothing to do.'); return; }

  const seed = seeds.find((r) => r.id === seedRecId);
  if (!seed) { console.log(`Seed ${seedRecId} not in the registry — leaving media as-is.`); return; }
  console.log(`seed resolved via ${how}`);
  const harvestId = (seed.fields['Source Harvest'] || [])[0];
  if (!harvestId) { console.log(`Seed "${seed.fields.Name}" has no Source Harvest — nothing to follow.`); return; }
  const harvest = (await at.listAll('Harvests', {})).find((r) => r.id === harvestId);
  const originKey = String(harvest?.fields?.['Origin Account'] || '').trim().split(/\s+/)[0].toLowerCase();
  let origin; try { origin = getAccount(originKey); } catch { console.log(`Harvest's Origin Account "${originKey}" is not a known garden — leaving media as-is.`); return; }
  const originDraftId = String(harvest.fields['Origin Draft ID'] || '');
  if (!originDraftId) { console.log('Harvest has no Origin Draft ID — nothing to follow.'); return; }

  // --- read both bodies -------------------------------------------------------------------------
  const draft = await tf.getDraft(target.socialSetId, draftId);
  const posts = draft.platforms.x.posts.map((p) => ({ text: p.text, media_ids: [...(p.media_ids || [])] }));
  if (args.includes('--wipe')) posts.forEach((p) => { p.media_ids = []; });
  if (posts.some((p) => p.media_ids.length) && !args.includes('--force')) {
    console.log('Draft already has media — refusing to re-run (use --wipe to rebuild clean, --force to add anyway).');
    return;
  }

  const originDraft = await tf.getDraft(origin.socialSetId, originDraftId);
  const originPosts = originDraft.platforms?.x?.posts || [];
  const ids = originPosts.flatMap((p) => p.media_ids || []);
  console.log(`seed "${seed.fields.Name}" -> ${origin.name || originKey} draft ${originDraftId}: ${originPosts.length} tweets, ${ids.length} media item(s)`);
  if (!ids.length) { console.log('Origin is text-only — nothing to carry. ✓ (follows the origin)'); return; }

  const statuses = new Map();
  for (const id of ids) { try { statuses.set(id, await tf.getMediaStatus(origin.socialSetId, id)); } catch (e) { console.log(`  ⚠ media ${id.slice(0, 8)}… unreadable on the origin set: ${String(e.message).slice(0, 80)}`); } }
  const items = originItems(originPosts, statuses, origin);
  const { plan, skipped } = planAttachments(items, posts, target);
  for (const p of plan) console.log(`  ${p.kind} (origin T${p.n} ${p.closing ? 'sign-off' : p.n === 1 ? 'hook' : 'item ' + p.lesson}) -> our tweet ${p.idx + 1}`);
  for (const s of skipped) console.log(`  ⚠ origin T${s.n} (${s.kind}): ${s.why} — skipped`);
  if (DRY || !plan.length) { console.log(DRY ? '(dry run — nothing uploaded)' : 'Nothing attachable.'); return; }

  // --- carry the bytes across -------------------------------------------------------------------
  for (const p of plan) {
    const res = await fetch(p.url);
    if (!res.ok) { console.log(`  ✗ download failed (${res.status}) for origin T${p.n}`); continue; }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // The origin's mime already decided the kind; this only catches a CDN serving something else
    // entirely. A binary/octet-stream is what CloudFront returns for an mp4 and is expected.
    if (p.kind === 'image' && ct.startsWith('video')) { console.log(`  ⚠ origin T${p.n}: registered image but the CDN served video — skipped`); continue; }
    const bytes = Buffer.from(await res.arrayBuffer());
    const mediaId = await tf.uploadMedia(target.socialSetId, p.name, bytes);
    posts[p.idx].media_ids.push(mediaId);
    console.log(`  ✓ uploaded ${p.kind} (${(bytes.length / 1e6).toFixed(1)}MB) -> tweet ${p.idx + 1} (${mediaId.slice(0, 8)}…)`);
  }

  const platformPosts = mediaAcrossPlatforms(posts, draft?.platforms);
  for (const p of CROSS_POST_PLATFORMS) {
    if (!draft?.platforms?.[p]?.enabled) continue;
    if (platformPosts?.[p]) console.log(`  ↳ ${p}: media mirrored onto ${platformPosts[p].filter((t) => t.media_ids.length).length} post(s), links untouched`);
    else console.log(`  ⚠ ${p}: post count differs from X — media NOT mirrored (would misalign)`);
  }
  await tf.patchDraft(target.socialSetId, draftId, { platforms: buildPlatforms(posts, { existing: draft?.platforms, account: target, platformPosts }) });
  console.log(`✓ Draft ${draftId} updated with the origin's media (schedule preserved: ${draft.scheduled_date || 'unscheduled'})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
