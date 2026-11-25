#!/usr/bin/env node
// scripts/media-find.mjs — read our tweet, find swipe-DB media that makes the same point, add it
// (swipe-media.mjs holds the questions and rules; the Clip Library base's Swipe Media table records
// every placement). Dry by default: it prints the picks and writes nothing.
//
//   node scripts/media-find.mjs --tweet "…" [--tweet "…"] [--niche Health]          dry: picks per tweet
//   node scripts/media-find.mjs --draft <ref>                                        dry: the draft's tweets
//   node scripts/media-find.mjs --draft <ref> --attach [--uncalibrated]              attach to that draft
//   node scripts/media-find.mjs --draft <ref> --copy-to burner                       review copy, unscheduled
//
// Tweets: a draft's eligible X posts (never a plug, closing or disclaimer) that carry no media yet
// (--replace to include those). Niche: --niche, else the draft account's niches (swipeNiches aliases),
// else the whole DB. A source already placed on the target account inside MEDIA_RULES.cooldownDays is
// skipped (0 for now: reuse is free, operator 2026-09-24).
// --attach changes ONLY media_ids on the chosen tweets; text and schedule are never touched.
// --copy-to <key> creates a NEW unscheduled draft on that account with the source draft's X text and the
// picked media, and the source, score and swipe link per tweet in its notes; the original is untouched.
// A review copy on the burner is marked review and never counts toward the 30-day block; a copy on a
// live account counts. --attach refuses while MEDIA_RULES.calibratedHash is not the current question
// hash, unless the operator passes --uncalibrated.
// The hook (tweet 1) only ever takes a video (operator 2026-09-24). --no-video 5,7: images only on those
// tweets; --strict 4: higher bars and a video of 30 s or less; --high-bar 1: the higher bars only (the hook). Each tweet's main subject is named
// first (code proposes phrases, Jev picks one) and weights the search and the same-subject judgment.
// Every pick passes an image check first: a vision model describes the image (or the video's poster)
// without seeing our tweet, and Jev decides whether it shows the tweet's subject and whether another
// creator's branding is on it (a reject); --no-vision skips it for a text-only dry run.
// Automated pipelines stay behind config.mjs ATTACH_MEDIA; this command is operator-run.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_QUESTIONS_HASH, MEDIA_RULES, loadIndex, matchMedia, mediaOf, visionChecker } from '../swipe-media.mjs';
import { LIBRARY_RULES, reuseCheck, withMedia, withUse } from '../clip-library.mjs';
import { ATTACH_MEDIA, REVIEW_PREFIX, TABLES } from '../config.mjs';

export function allArgs(argv, name) {
  const out = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1] != null) out.push(argv[i + 1]); });
  return out;
}
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const f2 = (x) => (x == null ? 'n/a' : Number(x).toFixed(2));

/** Labels that retire a swipe media everywhere (operator ground truth beats any score). */
export const REJECT_LABELS = new Set(['Wrong topic', 'Low quality', 'Meme']);

/**
 * The per-thread video cap on swipe picks (CLIP_RULES.perThread, owner 2026-10-03: "a max of 3 videos per
 * thread"). Keeps at most `max` video picks: the hook first (`hookAt`, the result index of tweet 1), then the
 * highest Jev fit, ties to the earlier tweet. A capped video pick is dropped (pick null, kept as `capped`), so
 * its tweet stays bare. Image picks are never touched. Pure.
 */
export function capVideoPicks(results, max, { hookAt = null } = {}) {
  if (!Number.isFinite(max)) return results;
  const isVideo = (r) => r?.pick?.kind === 'video';
  const order = results.map((r, i) => ({ r, i })).filter(({ r }) => isVideo(r))
    .sort((a, b) => (b.i === hookAt) - (a.i === hookAt) || (b.r.pick.fit ?? 0) - (a.r.pick.fit ?? 0) || a.i - b.i);
  const keep = new Set(order.slice(0, Math.max(0, max)).map(({ i }) => i));
  return results.map((r, i) => (isVideo(r) && !keep.has(i) ? { ...r, pick: null, capped: r.pick } : r));
}

/**
 * Swipe ids AND media keys blocked: placed on this account inside the cooldown (MEDIA_RULES.cooldownDays;
 * 0 = never), or labelled a reject by
 * the operator (on every account). Pure.
 */
export function blockedFor(records, socialSetId, { now = new Date(), rules = { ...LIBRARY_RULES, cooldownDays: MEDIA_RULES.cooldownDays } } = {}) {
  const out = new Set();
  for (const r of records) {
    const cooling = socialSetId != null && !reuseCheck(r, { socialSetId, now, rules }).ok; // review uses never count
    if (cooling || REJECT_LABELS.has(r.label)) for (const k of [r.id, r.key]) if (k) out.add(k);
  }
  return out;
}

/** The review notes for a copy: per tweet, the named subject, what was picked and from where. Pure. */
export function reviewNotes(results, tweetIndex, { sourceDraft = null } = {}) {
  const lines = [`[media-find] Jev-picked swipe media for review${sourceDraft ? ` · source draft ${sourceDraft}` : ''} · ${MEDIA_QUESTIONS_HASH.slice(0, 8)}`];
  results.forEach((r, i) => {
    const p = r.pick;
    lines.push(p ? `Tweet ${tweetIndex[i] + 1}${r.subject ? ` «${r.subject}»` : ''}: ${p.kind} ×${p.count} · same-point ${f2(p.same)} · ${p.tweetUrl || p.id}\n  "${cut(p.text, 160)}"${p.vision ? `\n  vision: ${p.vision.reason}` : ''}`
      : `Tweet ${tweetIndex[i] + 1}: no media (${r.candidates[0] ? `best same-point ${f2(r.candidates[0].same)}` : 'no candidates'})`);
  });
  return lines.join('\n');
}

/** Download a swipe row's media and upload it to a social set. Returns media ids (all or throws). */
export async function uploadPick(env, { at, tf, pick, socialSetId }) {
  const { cleanName } = await import('../media-map.mjs');
  const row = await at.getRecord(TABLES.swipe, pick.id); // fresh URLs: Airtable's expire
  const m = mediaOf(row.fields || {});
  if (!m) throw new Error(`swipe ${pick.id}: no attachable media any more`);
  const ids = [];
  for (const it of m.items) {
    const res = await fetch(it.url);
    if (!res.ok) throw new Error(`download ${it.name} -> ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (m.kind === 'video' && !ct.startsWith('video')) throw new Error(`swipe ${pick.id}: expected a video, got "${ct || 'unknown'}" (only a poster?)`);
    if (m.kind === 'images' && !ct.startsWith('image')) throw new Error(`swipe ${pick.id}: expected an image, got "${ct || 'unknown'}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = m.kind === 'video' ? 'mp4' : (ct.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    ids.push(await tf.uploadMedia(socialSetId, cleanName(it.name, ext), bytes));
  }
  return { kind: m.kind, ids };
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
  const { loadEnv, airtable, typefully, flushLlmSpend } = await import('../lib.mjs');
  const { jev } = await import('../jev.mjs');
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { clipBaseId, loadSwipeMedia, saveSwipeMedia } = await import('../clip-pool.mjs');
  const env = loadEnv();
  const client = jev({ ...env, TYPESAFE_DEFAULT_MODEL: MEDIA_RULES.model });
  const xdb = airtable(env);
  const lib = airtable(env, clipBaseId(env));
  const attach = argv.includes('--attach'), copyTo = val('copy-to'), replace = argv.includes('--replace');
  if (attach && copyTo) throw new Error('--attach and --copy-to are exclusive');

  let tweets = allArgs(argv, 'tweet'), tweetIndex = tweets.map((_, i) => i), draft = null, tf = null;
  let account = val('account') ? ACCOUNTS[val('account')] : null;
  if (val('draft')) {
    const { resolveDraft, eligibleTweets } = await import('../clip-thread.mjs');
    tf = typefully(env);
    const r = await resolveDraft(env, tf, val('draft'), val('account'));
    const body = await tf.getDraft(r.socialSetId, r.draftId);
    const posts = body?.platforms?.x?.posts || [];
    draft = { ...r, body, posts };
    account = account || r.account;
    tweetIndex = eligibleTweets(posts, r.account).map((n) => n - 1).filter((i) => replace || !(posts[i].media_ids || []).length);
    tweets = tweetIndex.map((i) => posts[i].text);
    console.log(`Draft ${r.draftId} (${r.username || account?.handle || r.socialSetId}) · ${body.status}${body.scheduled_date ? ' @ ' + body.scheduled_date : ''} · ${posts.length} tweets, ${tweets.length} to consider`);
  }
  // A question change leaves the thresholds uncalibrated (AGENTS.md: shadow until recalibrated). Review
  // copies and a /run's unscheduled [REVIEW] drafts still run: the operator sees every pick before it can
  // ship. Placing on any other draft needs the operator's explicit --uncalibrated.
  const reviewDraft = Boolean(draft && String(draft.body?.draft_title || '').startsWith(REVIEW_PREFIX) && draft.body?.status === 'draft' && !draft.body?.scheduled_date);
  if (attach && !reviewDraft && MEDIA_QUESTIONS_HASH !== MEDIA_RULES.calibratedHash && !argv.includes('--uncalibrated')) {
    throw new Error(`questions ${MEDIA_QUESTIONS_HASH.slice(0, 8)} are not calibrated (MEDIA_RULES.calibratedHash): use --copy-to burner and label the picks, attach to a /run [REVIEW] draft, or pass --uncalibrated`);
  }
  if (!tweets.length) {
    if (val('json')) writeFileSync(val('json'), JSON.stringify({ draftId: draft?.draftId ?? null, considered: 0, placed: [] }, null, 2));
    if (draft) { console.log('Every eligible tweet already carries media — nothing to match.'); return; }
    throw new Error('nothing to match: --tweet "…" or --draft <ref> (with tweets that carry no media)');
  }
  if ((attach || copyTo) && !draft) throw new Error('--attach / --copy-to need --draft <ref>');
  const target = copyTo ? ACCOUNTS[copyTo] : account;
  if (copyTo && !target) throw new Error(`unknown --copy-to ${copyTo}`);
  // Only a copy on the burner is sure never to publish; a copy on a live account counts as a use.
  const review = Boolean(copyTo && target.burner);
  // Where the media goes: the copy's account, else the draft's own social set (a draft whose handle is not
  // in ACCOUNTS still has one), else the --account's. Resolved BEFORE Jev runs so the cooldown applies.
  const ss = copyTo ? target.socialSetId : draft?.socialSetId ?? account?.socialSetId ?? null;
  const niche = val('niche') ? [val('niche')] : account?.niches || null;

  try {
    const t0 = Date.now();
    const { entries, cached } = await loadIndex(xdb, { refresh: argv.includes('--refresh'), log: console.log });
    const stored = await loadSwipeMedia(lib);
    const blocked = blockedFor(stored, ss);
    const { meterLlmCall } = await import('../lib.mjs');
    const vision = argv.includes('--no-vision') ? null : visionChecker(env, xdb, { client, meter: meterLlmCall });
    // The hook (the draft's first tweet) takes a video or nothing.
    const videoOnly = new Set(MEDIA_RULES.hookVideoOnly && draft ? tweetIndex.map((ix, i) => (ix === 0 ? i : -1)).filter((i) => i >= 0) : []);
    // Placement rules from the /run media pass (draft tweet numbers): --no-video 5,7 takes images only
    // there (before a plug, a bridge, the weld); --strict 4 raises the bars and caps a video at 30 s (the
    // first tweet of a CTA).
    const positions = (name) => { const want = new Set(String(val(name) || '').split(',').map(Number)); return new Set(tweetIndex.map((ix, i) => (want.has(ix + 1) ? i : -1)).filter((i) => i >= 0)); };
    const imagesOnly = positions('no-video'), strict = positions('strict'), highBar = positions('high-bar');
    // --max-videos N: what the thread's video cap leaves for swipe videos (the /run media pass passes it).
    // 0 means images only, everywhere; otherwise the best video picks keep their place (capVideoPicks).
    const maxVideos = val('max-videos') != null ? Number(val('max-videos')) : Infinity;
    if (!(maxVideos === Infinity || (Number.isInteger(maxVideos) && maxVideos >= 0))) throw new Error('--max-videos must be a whole number (0 or more)');
    if (maxVideos === 0) tweets.forEach((_, i) => imagesOnly.add(i));
    const res = await matchMedia(client, tweets, entries, { niche, blocked, vision, videoOnly, imagesOnly, strict, highBar, thread: draft ? draft.posts[0]?.text ?? null : null });
    res.results = capVideoPicks(res.results, maxVideos, { hookAt: videoOnly.size ? [...videoOnly][0] : null });
    if (res.breaker.open) throw new Error(`Jev breaker open: ${res.breaker.reason}`);
    if (res.subjectsFailed) console.log(`⚠️ ${res.subjectsFailed} subject read(s) failed: those tweets were searched unweighted`);
    console.log(`${entries.length} media tweets${cached ? ' (cached)' : ''} · niche ${niche ? niche.join('/') : 'all'} → ${res.pool} · ${res.pairs} pairs judged · ${Math.round((Date.now() - t0) / 1000)}s${blocked.size ? ` · ${blocked.size} blocked (cooldown or operator label)` : ''}\n`);
    res.results.forEach((r, i) => {
      console.log(`[${tweetIndex[i] + 1}] ${cut(r.tweet, 110)}${r.subject ? `  «${r.subject}»` : ''}${tweetIndex[i] === 0 && MEDIA_RULES.hookVideoOnly && draft ? '  (hook: video only)' : ''}${imagesOnly.has(i) ? '  (no video here)' : ''}${strict.has(i) ? `  (CTA first tweet: strict, video ≤${MEDIA_RULES.strict.maxVideoS}s)` : ''}${highBar.has(i) ? '  (high bar)' : ''}`);
      for (const c of r.candidates.filter((x) => x.vision && x !== r.pick)) console.log(`    ✗ vision rejected same ${f2(c.same)}: ${c.vision.otherBrand ? 'another creator\'s brand · ' : ''}${c.vision.reason}`);
      if (r.pick) console.log(`    → ${r.pick.kind} ×${r.pick.count} · same ${f2(r.pick.same)} · subject ${f2(r.pick.subject)} · fit ${f2(r.pick.fit)} · ${r.pick.tweetUrl || r.pick.id}${r.pick.vision ? `\n      👁 ${r.pick.vision.reason}` : ''}\n      "${cut(r.pick.text, 150)}"`);
      else if (r.capped) console.log(`    → none: its video (${r.capped.tweetUrl || r.capped.id}, fit ${f2(r.capped.fit)}) is over the thread's ${maxVideos}-video cap`);
      else console.log(`    → none${r.candidates[0] ? ` (best same ${f2(r.candidates[0].same)}: "${cut(r.candidates[0].text, 90)}")` : ''}`);
    });
    // --json FILE: what Jev picked and what landed, per tweet (a /run reads this for its drafts packet).
    const landedSet = new Set();
    const writeJson = (draftId = draft?.draftId ?? null) => {
      if (!val('json')) return;
      writeFileSync(val('json'), JSON.stringify({ draftId, considered: tweets.length, questionsHash: MEDIA_QUESTIONS_HASH,
        tweets: res.results.map((r, i) => ({ tweet: tweetIndex[i] + 1, subject: r.subject, placed: landedSet.has(i),
          pick: r.pick ? { swipeId: r.pick.id, kind: r.pick.kind, count: r.pick.count, tweetUrl: r.pick.tweetUrl ?? null, same: r.pick.same, fit: r.pick.fit, image: r.pick.vision?.reason ?? null, text: cut(r.pick.text, 200) } : null })) }, null, 2));
    };
    if (!attach && !copyTo) { writeJson(); console.log('\n(dry run — nothing uploaded or written)'); return; }
    if (!ATTACH_MEDIA) console.log('\nℹ️ config.mjs ATTACH_MEDIA is off: automated pipelines attach nothing; this operator-run command still places media.');

    const placed = [];
    for (const [i, r] of res.results.entries()) {
      if (!r.pick) continue;
      try {
        const up = await uploadPick(env, { at: xdb, tf, pick: r.pick, socialSetId: ss });
        placed.push({ i, index: tweetIndex[i], pick: r.pick, ...up });
        console.log(`  ✓ tweet ${tweetIndex[i] + 1}: ${up.kind} uploaded (${up.ids.length})`);
      } catch (e) { console.log(`  ✗ tweet ${tweetIndex[i] + 1}: ${e.message} — left without media`); }
    }
    if (!placed.length) { writeJson(); console.log('\nNothing placed.'); return; }
    let draftId, shareUrl;
    const { buildPlatforms } = await import('../platforms.mjs');
    const { mediaAcrossPlatforms } = await import('../media-map.mjs');
    if (copyTo) {
      const posts = draft.posts.map((p) => ({ text: p.text, media_ids: [] }));
      for (const p of placed) posts[p.index].media_ids = p.ids;
      const d = await tf.createDraft(ss, { draft_title: `[media-find review] ${draft.account?.handle || draft.socialSetId} ${draft.draftId}`,
        platforms: buildPlatforms(posts, { account: target }), scratchpad_text: reviewNotes(res.results, tweetIndex, { sourceDraft: draft.body.share_url || draft.draftId }) });
      draftId = d.id; shareUrl = d.share_url;
    } else {
      const fresh = await tf.getDraft(draft.socialSetId, draft.draftId); // re-read: text may have changed
      const posts = fresh.platforms.x.posts.map((p) => ({ ...p, media_ids: [...(p.media_ids || [])] }));
      for (const p of placed) {
        // Place by position only if that position still holds the tweet Jev judged: an edit while this ran
        // (a tweet added or removed) must not shift media onto another tweet, a plug or the closing.
        if (posts[p.index]?.text !== tweets[p.i]) { console.log(`  ⚠️ tweet ${p.index + 1} changed since it was matched — skipped`); p.skipped = true; continue; }
        if (posts[p.index].media_ids.length && !replace) { console.log(`  ⚠️ tweet ${p.index + 1} gained media meanwhile — skipped`); p.skipped = true; continue; }
        posts[p.index].media_ids = p.ids;
      }
      if (placed.every((p) => p.skipped)) { writeJson(); console.log('\nNothing placed; the draft is unchanged.'); return; }
      await tf.patchDraft(draft.socialSetId, draft.draftId, { platforms: buildPlatforms(posts, { existing: fresh.platforms, account: draft.account, platformPosts: mediaAcrossPlatforms(posts, fresh.platforms) }) });
      draftId = draft.draftId; shareUrl = fresh.share_url;
    }
    const at = new Date().toISOString();
    const landed = placed.filter((p) => !p.skipped);
    for (const p of landed) landedSet.add(p.i);
    writeJson(draftId);
    await saveSwipeMedia(lib, landed.map((p) => withUse(withMedia({ id: p.pick.id, key: p.pick.key, tweetUrl: p.pick.tweetUrl, text: p.pick.text, kind: p.kind, count: p.ids.length, same: p.pick.same }, ss, p.ids.join(',')),
      { socialSetId: ss, draftId, tweet: p.index + 1, at, ...(review ? { review: true } : {}) })));
    console.log(`\n✓ ${landed.length} tweet(s) got media on draft ${draftId}${shareUrl ? ` — ${shareUrl}` : ''} · recorded in Clip Library › Swipe Media`);
  } finally {
    await flushLlmSpend(env, 'media-find', attach ? 'attach' : copyTo ? 'copy' : 'dry');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
