#!/usr/bin/env node
// scripts/clip-find.mjs — find clips with Jev, both directions (clip-judge.mjs holds the questions and rules,
// clip-library.mjs the store). Without --cut it only judges and decides: the only writes are the library
// file (--save) and the --out report. It never fetches transcripts.
//
//   MINE   node scripts/clip-find.mjs --segments ep.json [--segments ep2.json] [--focus "health …"] [--top 12] [--save]
//   MATCH  node scripts/clip-find.mjs --tweet "…" [--tweet "…"] [--pool] [--segments ep.json] [--library-only] [--account <key>]
//          node scripts/clip-find.mjs --tweets tweets.json            # stored clips only
//
// --segments: {title, videoId|url|id, segments:[{start, end?, text, speaker?}]} or a bare segment array
//             (seconds). Repeat for a pool of episodes.
// --tweets:   a JSON array of strings, or a text file with one tweet per line.
// Store:      the Clips table of the Clip Library base (clip-pool.mjs). --library <file.jsonl> uses a
//             local file instead (tests, offline). MATCH always ranks stored clips beside fresh
//             passages; a stored clip within CLIP_RULES.reuseMargin wins (no cut).
// --pool:     fresh passages also come from every transcript in the Podcasts table (--video <id> to narrow).
// --lane gtx: the GTX & AI pool (clip-lanes.mjs): its base for the store and --pool, its focus and its lower
//             bars for MINE. MATCH keeps the usual attach bars on every lane.
// --account:  a fleet account key; stored clips used on that account inside the cooldown are left out.
// --save:     MINE adds the chosen clips to the library. --out <file> writes the full JSON result.
//
// PLACE (MATCH + --cut): every tweet whose decision is reuse/cut gets its clip, then:
//   --draft <ref>   the tweets ARE the draft's eligible X posts; clips attach to them (existing media kept
//                   unless --replace). The draft's text and schedule are never touched.
//   --new-draft     an UNSCHEDULED draft is created on --account from the --tweet/--tweets text.
// Cuts go through the fleet clipper (CLIPPER_URL), or `--engine local` (yt-dlp + ffmpeg on this machine;
// a home IP passes YouTube's bot check where datacenter IPs fail), or `--engine filmcraft` (yt-dlp fetches the
// window, `filmcraft-cli clip` burns and formats it; FILMCRAFT_CLI, else PATH). No captions
// unless --captions (service, or filmcraft: segment transcripts carry no word timings, so FilmCraft
// transcribes the window itself) / --watermark '@h'. --caption-words N, --caption-max-chars N and
// --caption-max-seconds S shape FilmCraft's captions (filmcraft engine only). A cut failure stops the run
// before anything is placed.
// --max-cuts N caps fresh cuts (RapidAPI calls); stored clips and Clip File reuses never count.
// --max-clips N: at most N clips on the thread this run (default CLIP_RULES.perThread.maxVideos with --draft or
//   --new-draft): the hook first, then the highest Jev fit (capClips); the rest are reported as CAPPED.
// --only 1,3 with --draft: match just those tweet positions. --no-video 5,7: never those (placement rules).
// --strict 4: a clip there must run <= CLIP_RULES.strict.maxS s and clear the strict bar (first tweet of a CTA).
// --high-bar 1: the strict bar without the length cap (the hook).
// --no-stored (with --cut): never place a stored clip's file or media id; every placement is a fresh cut, and a
//   stored window is recut 0.2-0.8 s later (clips-always-recut, owner 2026-10-13). run-media --clips cut passes it.
// --upload-only (with --cut --account): cut and upload each matched clip to the account and report its media id in
//   placed.attached, attaching it nowhere; --use-label names the use in the library (scripts/run-articles.mjs media).
// Each cut's media id and each placement are written back to the library.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIP_RULES, capClips, highBarRules, strictChoice, strictMatchRules, candidateWindows, matchTweets, mineClips, unitsFromSegments,
} from '../clip-judge.mjs';
import { addToLibrary, clipId, libraryCandidates, loadLibrary, reuseCheck, toRecord, withMedia, withUse } from '../clip-library.mjs';
import { clipBaseId, freshClipFile, loadClipLibrary, readTranscript, saveClipRecords, segmentsFromCaptionEvents, storeClipFile, videoIdOf } from '../clip-pool.mjs';
import { TABLES } from '../config.mjs';
import { laneBase, clipLaneOf, laneTables } from '../clip-lanes.mjs';


/** Where clips live: the Clips table by default, a JSONL file with --library. Same record shape either way. */
export function clipStore({ env, airtable, path = null, lane = null }) {
  if (path) return { name: path, load: async () => loadLibrary(path), save: async (records) => addToLibrary(path, records) };
  const at = lane ? laneTables(airtable(env, laneBase(lane, env)), lane) : airtable(env, clipBaseId(env));
  return { name: lane && lane.name !== 'health' ? `Clip Library (${lane.name}) › Clips` : 'Clip Library › Clips', load: () => loadClipLibrary(at), save: (records) => saveClipRecords(at, records), at };
}

/** Every pool transcript (or the --video ones) as MATCH sources. */
async function poolSources(at, videos = []) {
  const ids = videos.map((v) => videoIdOf(v) || v);
  const rows = (await at.listAll(TABLES.podcasts)).filter((r) => r.fields.Transcript?.length && (!ids.length || ids.includes(r.fields['Video ID'])));
  const missing = ids.filter((id) => !rows.some((r) => r.fields['Video ID'] === id));
  if (missing.length) console.log(`⚠️ not in the pool (or no transcript): ${missing.join(', ')} — run clip-pool.mjs add first`);
  const out = [];
  for (const r of rows) {
    const file = await readTranscript(r);
    out.push({ source: { id: r.fields['Video ID'], title: r.fields.Title ?? null, url: r.fields.URL ?? null }, segments: segmentsFromCaptionEvents(file.events) });
  }
  return out;
}

/** Every value of a repeatable flag. Pure. */
export function allArgs(argv, name) {
  const out = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1] != null) out.push(argv[i + 1]); });
  return out;
}

/** A segments file -> { source, segments }. Pure apart from the read. */
export function readSource(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const segments = Array.isArray(raw) ? raw : raw.segments;
  if (!Array.isArray(segments)) throw new Error(`${path}: want {segments:[…]} or a segment array`);
  const id = (!Array.isArray(raw) && (raw.videoId || raw.id || raw.url)) || basename(path).replace(/\.json$/, '');
  return { source: { id, title: raw.title ?? null, url: raw.url ?? (raw.videoId ? `https://www.youtube.com/watch?v=${raw.videoId}` : null) }, segments };
}

export function readTweets(path) {
  const text = readFileSync(path, 'utf8');
  try { const j = JSON.parse(text); if (Array.isArray(j)) return j.map(String).filter((t) => t.trim()); } catch { /* one per line */ }
  return text.split('\n').map((t) => t.trim()).filter(Boolean);
}

const hms = (s) => { const x = Math.max(0, Math.round(s)); return `${String(Math.floor(x / 3600)).padStart(2, '0')}:${String(Math.floor((x % 3600) / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const f2 = (x) => (x == null ? ' n/a' : Number(x).toFixed(2));
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

/** 00:00:12.3 — the clipper accepts tenths. */
const hmsf = (sec) => { const t = Math.max(0, sec); const whole = Math.floor(t); const tenth = Math.floor((t - whole) * 10); return hms(whole) + (tenth ? `.${tenth}` : ''); };

/** 0.2-0.8 s, in tenths: the clipper reads tenths, so a smaller jitter could round to the stored start. */
export const recutJitter = (rand = Math.random) => 0.2 + Math.round(rand() * 6) / 10;

/** Clip every reuse/cut decision, put it on its tweet, and write media + use back to the library. */
async function placeClips({ env, tf, argv, val, decisions, tweetIndex, tweets, socialSetId, account, draft, library, store, sources }) {
  const { pageWatermark, cutViaServiceToUrl, storeViaService, uploadFromUrl, cutLocal, cutFilmcraft, filmcraftMissing, captionOptsFromArgs, assertFilmcraftFlags, ENGINES, uploadAndWait, haveTool, attachPlanToPosts, mediaAcrossPlatforms } = await import('../clip-thread.mjs');
  const { buildPlatforms } = await import('../platforms.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const serviceReady = Boolean(env.CLIPPER_URL && env.CLIPPER_SERVICE_KEY);
  const localReady = async () => (await haveTool('yt-dlp')) && (await haveTool('ffmpeg'));
  let engine = val('engine', serviceReady ? 'service' : 'local');
  if (!ENGINES.includes(engine)) throw new Error(`--engine ${engine}: one of ${ENGINES.join(', ')}`);
  if (engine === 'service' && !serviceReady) throw new Error('--engine service needs CLIPPER_URL and CLIPPER_SERVICE_KEY');
  if (engine === 'local' && !(await localReady())) throw new Error('--engine local needs yt-dlp and ffmpeg on PATH (brew install yt-dlp ffmpeg)');
  const captionOpts = captionOptsFromArgs(val);
  assertFilmcraftFlags(engine, captionOpts);
  if (engine === 'filmcraft') { const miss = await filmcraftMissing(env); if (miss) throw new Error(miss); }
  const workDir = mkdtempSync(join(tmpdir(), 'clip-find-'));
  const captions = argv.includes('--captions');
  // --no-stored: never put a stored clip's file or media id on a post; every placement is a fresh cut with a
  // small start jitter, so each file carries its own metadata (owner, 2026-10-13: "recut everytime").
  const noStored = argv.includes('--no-stored');
  let serviceDown = false;
  // --max-cuts N: fresh cuts cost a RapidAPI call each (free plan: 100 a month); stored clips never count.
  const maxCuts = val('max-cuts') != null ? Number(val('max-cuts')) : Infinity;
  if (maxCuts !== Infinity && !(Number.isInteger(maxCuts) && maxCuts >= 0)) throw new Error('--max-cuts must be a whole number (0 or more)');
  let cuts = 0;
  // The page's own @handle by default (operator 2026-11-19); --no-watermark keeps the cut clean (and storable).
  const watermark = pageWatermark(val('watermark', ''), account?.handle, argv.includes('--no-watermark'));
  const byId = new Map(library.map((r) => [r.id, r]));
  const srcById = new Map(sources.map((s) => [s.source.id, s.source]));
  const attached = [], updates = [];
  const placedIds = new Map(); // one clip goes on one tweet per run
  for (const [i, d] of decisions.entries()) {
    if (!d.pick || !['reuse', 'cut'].includes(d.action)) continue;
    const p = d.pick;
    const key = p.kind === 'library' ? p.id : clipId({ sourceId: p.sourceId, start: p.start, end: p.end });
    if (placedIds.has(key)) { console.log(`\n▶ tweet ${tweetIndex[i] + 1}: its clip is already placed on tweet ${placedIds.get(key)} in this run — skipped`); continue; }
    placedIds.set(key, tweetIndex[i] + 1);
    // A fresh window can be a stored clip under another name (same source and window, same id): use the
    // stored record, so its media, uses and scores carry over, and honour its reuse block.
    const storedRec = byId.get(key);
    if (storedRec && p.kind !== 'library') {
      const check = reuseCheck(storedRec, { socialSetId });
      if (!check.ok) { console.log(`\n▶ tweet ${tweetIndex[i] + 1}: its window is stored clip ${key}, ${check.reason} — skipped`); continue; }
    }
    let record = storedRec ?? toRecord({ ...p, scores: p.scores ?? null }, { source: srcById.get(p.sourceId) || { id: p.sourceId, title: p.title, url: p.url } });
    let mediaId = noStored ? null : (p.mediaId || record.media?.[String(socialSetId)] || null);
    const slug = `${String(p.sourceId).replace(/[^A-Za-z0-9_-]/g, '')}-${Math.round(p.start)}`;
    const hadMedia = Boolean(mediaId);
    // The Clip File is the clean cut (no captions, no watermark), so it is only stored and reused when this
    // run adds neither. Reuse uploads it (URL read fresh: Airtable's expire): no re-cut, no RapidAPI call.
    const clean = !captions && !watermark;
    if (!mediaId && clean && record.file?.url && !noStored) {
      console.log(`\n▶ tweet ${tweetIndex[i] + 1}: stored clip ${record.id} — uploading its stored file (no re-cut)`);
      try {
        const file = (store.at && await freshClipFile(store.at, record.id)) || record.file;
        mediaId = await uploadFromUrl(tf, socialSetId, file.filename || `${slug}.mp4`, file.url);
      } catch (e) { console.log(`  ✗ stored file failed (${String(e.message).slice(0, 140)}) — cutting instead`); }
    }
    if (!mediaId && cuts >= maxCuts) { console.log(`\n▶ tweet ${tweetIndex[i] + 1}: would need a fresh cut, and --max-cuts ${maxCuts} is spent — skipped`); placedIds.delete(key); continue; }
    if (!mediaId) {
      cuts++;
      const url = p.url || record.source.url;
      if (!url) throw new Error(`clip ${record.id}: its source has no video url, cannot cut`);
      // A recut of a stored window starts 0.2-0.8 s later than the stored cut, so no two files match.
      const startS = p.start - 0.3 + (noStored && (storedRec || p.kind === 'library') ? recutJitter() : 0);
      const clip = { start: hmsf(startS), end: hmsf(p.end), slug };
      const fileName = `${slug}.mp4`;
      console.log(`\n▶ cutting ${clip.start}–${clip.end} of ${url} for tweet ${tweetIndex[i] + 1} via ${engine}${captions ? ' (captions)' : ''}`);
      // A clean cut is kept: served on a URL, copied into the row's Clip File, then uploaded to Typefully.
      let fileUrl = null, servedUrl = null, localFile = null;
      const viaLocal = async () => {
        // Local captions need word-timed caption events, which segment transcripts do not carry.
        const r = await cutLocal(env, { url, clip: { ...clip, startS, endS: p.end }, events: [], captions: false, watermark, workDir });
        console.log(`  ✓ cut ${r.height}p, ${r.durationS.toFixed(1)}s, audio ${r.audioLang}`);
        localFile = r.file;
        if (clean && serviceReady && !serviceDown) fileUrl = await storeViaService(env, r.file, slug).catch((e) => { console.log(`  ⚠️ could not stage the file for storage: ${e.message}`); return null; });
      };
      if (engine === 'filmcraft') {
        // Segment transcripts carry no word timings: FilmCraft transcribes the window when captions are on.
        const r = await cutFilmcraft(env, { url, clip: { ...clip, startS, endS: p.end }, events: [], captions, transcribe: captions, watermark, workDir, captionOpts });
        console.log(`  ✓ FilmCraft ${r.height}p, ${r.durationS.toFixed(1)}s, audio ${r.audioLang}${captions ? `, ${r.captions} caption cue(s)` : ''}`);
        localFile = r.file;
        if (clean && serviceReady) fileUrl = await storeViaService(env, r.file, slug).catch((e) => { console.log(`  ⚠️ could not stage the file for storage: ${e.message}`); return null; });
      } else if (engine === 'service') {
        try {
          const r = await cutViaServiceToUrl(env, { url, clip, captions, watermark });
          if (r.warning) console.log(`  ⚠️ ${r.warning}`);
          console.log(`  ✓ ${r.quality || ''} ${r.source || ''} cut, ${Math.round((r.bytes || 0) / 1e5) / 10} MB`);
          fileUrl = servedUrl = r.fileUrl;
        } catch (e) {
          if (!(await localReady())) throw e;
          console.log(`  ✗ service failed (${String(e.message).split('\n')[0].slice(0, 140)}) — using the local engine for the rest`);
          engine = 'local';
          serviceDown = true; // do not stage later local cuts on a service that just failed
          await viaLocal();
        }
      } else await viaLocal();
      await store.save([record]); // the row exists before its file lands on it
      if (!clean) console.log('  · captions/watermark on this cut: served for this placement only, not stored');
      else if (noStored && record.file?.url) console.log('  · recut of a stored clip: the stored Clip File is kept as it is');
      else if (fileUrl && store.at) {
        try {
          await storeClipFile(store.at, record.id, { url: fileUrl, filename: fileName });
          record = { ...record, file: { url: fileUrl, filename: fileName } };
          console.log('  ✓ stored in Clip Library › Clips › Clip File');
        } catch (e) { console.log(`  ⚠️ Clip File not stored: ${e.message}`); }
      } else console.log(`  ⚠️ Clip File not stored (${store.at ? 'no served copy of the file' : 'file library, not Airtable'})`);
      mediaId = localFile ? await uploadAndWait(tf, socialSetId, fileName, localFile) : await uploadFromUrl(tf, socialSetId, fileName, servedUrl);
      console.log(`  ✓ uploaded → media ${String(mediaId).slice(0, 8)}…`);
    }
    if (!hadMedia) {
      record = withMedia(record, socialSetId, mediaId);
      await store.save([record]); // saved now: a later failure must not lose an uploaded clip
    } else console.log(`\n▶ tweet ${tweetIndex[i] + 1}: stored clip ${record.id} already has media on this account`);
    attached.push({ index: tweetIndex[i], mediaId, recordId: record.id });
    updates.push(record);
  }
  rmSync(workDir, { recursive: true, force: true });
  if (!attached.length) { console.log('\nNothing to place.'); return { attached: [] }; }
  let draftId, shareUrl;
  if (argv.includes('--upload-only')) {
    // The caller places the media itself (the article lane embeds each clip in its body: scripts/run-articles.mjs
    // media). The use is recorded under --use-label so the cooldown still holds on this account.
    draftId = val('use-label') || null;
  } else if (draft) {
    const fresh = await tf.getDraft(draft.socialSetId, draft.draftId); // re-read: the text may have changed meanwhile
    const { posts, skipped } = attachPlanToPosts(fresh.platforms.x.posts, attached, { replace: argv.includes('--replace') });
    for (const s of skipped) console.log(`  ⚠️ ${s}`);
    // Only clips that actually landed count as uses; a skipped one stays free for this account.
    for (let k = attached.length - 1; k >= 0; k--) {
      if (!(posts[attached[k].index]?.media_ids || []).includes(attached[k].mediaId)) { attached.splice(k, 1); updates.splice(k, 1); }
    }
    if (!attached.length) { console.log('\nNo clip could be attached; the draft is unchanged.'); return { attached: [] }; }
    await tf.patchDraft(draft.socialSetId, draft.draftId, { platforms: buildPlatforms(posts, { existing: fresh.platforms, account: draft.account, platformPosts: mediaAcrossPlatforms(posts, fresh.platforms) }) });
    draftId = draft.draftId; shareUrl = fresh.share_url;
  } else {
    const posts = tweets.map((text) => ({ text, media_ids: [] }));
    for (const a of attached) posts[a.index].media_ids = [a.mediaId];
    const d = await tf.createDraft(socialSetId, { draft_title: `[clip-find] ${cut(tweets[0], 60)}`, platforms: buildPlatforms(posts, { account }) });
    draftId = d.id; shareUrl = d.share_url;
  }
  const at = new Date().toISOString();
  await store.save(updates.map((r, k) => withUse(r, { socialSetId, draftId, tweet: attached[k].index + 1, at })));
  console.log(`\n✓ ${attached.length} clip(s) on draft ${draftId}${shareUrl ? ` — ${shareUrl}` : ''} · library updated (${store.name})`);
  return { draftId, shareUrl, attached };
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
  const { loadEnv, flushLlmSpend } = await import('../lib.mjs');
  const { jev } = await import('../jev.mjs');
  const env = loadEnv();
  const client = jev({ ...env, TYPESAFE_DEFAULT_MODEL: CLIP_RULES.model });

  const sources = allArgs(argv, 'segments').map(readSource);
  const tweets = [...allArgs(argv, 'tweet'), ...allArgs(argv, 'tweets').flatMap(readTweets)];
  const { airtable } = await import('../lib.mjs');
  const lane = clipLaneOf(val('lane'));
  const store = clipStore({ env, airtable, path: val('library') ? resolve(val('library')) : null, lane });
  if (argv.includes('--pool')) {
    if (!store.at) throw new Error('--pool reads the Podcasts table; drop --library');
    sources.push(...await poolSources(store.at, allArgs(argv, 'video')));
  }
  const focus = val('focus', lane.name === 'health' ? null : lane.focus);
  const top = Number(val('top', lane.name === 'health' ? 12 : lane.pool.top));
  const matchMode = tweets.length > 0 || val('draft') != null; // --draft supplies its own tweets
  const report = { at: new Date().toISOString(), model: CLIP_RULES.model, focus, mode: matchMode ? 'match' : 'mine' };

  // Fresh windows from every source (both modes need them; MATCH with --library-only skips them).
  const windows = argv.includes('--library-only') ? [] : sources.flatMap(({ source, segments }) =>
    candidateWindows(unitsFromSegments(segments)).map((w) => ({ ...w, kind: 'fresh', sourceId: source.id, title: source.title, url: source.url })));

  try {
    if (!matchMode) {
      if (!sources.length) throw new Error('MINE needs --segments <file>; MATCH needs --tweet/--tweets or --draft');
      console.log(`MINE · ${sources.length} source(s), ${windows.length} candidate windows · ${CLIP_RULES.model}${focus ? ` · focus: ${focus}` : ''}`);
      const t0 = Date.now();
      const { judged, chosen, breaker, questionSetHash, variants } = await mineClips(client, sources, { focus, top, rules: lane.rules });
      if (breaker.open) throw new Error(`Jev breaker open: ${breaker.reason}`);
      const counts = judged.reduce((m, w) => ((m[w.verdict ?? 'error'] = (m[w.verdict ?? 'error'] || 0) + 1), m), {});
      console.log(`${Math.round((Date.now() - t0) / 1000)}s · first pass ${JSON.stringify(counts)} · ${variants} boundary variants · top ${chosen.length} non-overlapping:\n`);
      console.log('| # | source | window | speaker | rank | claim | arguable | alone | start/end | says |');
      console.log('|--:|---|---|---|--:|--:|--:|--:|---|---|');
      chosen.forEach((c, i) => console.log(`| ${i + 1} | ${cut(c.title || c.sourceId, 24)} | ${hms(c.start)}–${hms(c.end)} (${Math.round(c.end - c.start)}s) | ${c.speaker ?? '?'} | ${f2(c.rank)} | ${f2(c.scores.claim)} | ${f2(c.scores.arguable)} | ${f2(c.scores.self_contained)} | ${f2(c.scores.clean_start)}/${f2(c.scores.clean_end)} | ${cut(c.text, 110)} |`));
      Object.assign(report, { questionSetHash, counts, chosen, judged });
      if (argv.includes('--save')) {
        const byId = new Map(sources.map((s) => [s.source.id, s.source]));
        const n = await store.save(chosen.map((c) => toRecord(c, { source: byId.get(c.sourceId), questionSetHash })));
        console.log(`\n+${n} clip(s) → ${store.name}`);
      }
    } else {
      const { ACCOUNTS } = await import('../accounts.mjs');
      const place = argv.includes('--cut');
      const nums = (name) => new Set(String(val(name) || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0));
      const noVideo = nums('no-video'), strictAt = nums('strict'), highBarAt = nums('high-bar');
      const draftRef = val('draft');
      let accountKey = val('account');
      let socialSetId = accountKey ? ACCOUNTS[accountKey]?.socialSetId ?? null : null;
      if (accountKey && socialSetId == null) throw new Error(`unknown --account ${accountKey}`);
      let tf = null, draft = null, tweetIndex = tweets.map((_, i) => i);
      if (place || draftRef) {
        const { typefully } = await import('../lib.mjs');
        tf = typefully(env);
      }
      if (draftRef) {
        const { resolveDraft, eligibleTweets } = await import('../clip-thread.mjs');
        const r = await resolveDraft(env, tf, draftRef, accountKey);
        socialSetId = r.socialSetId;
        accountKey = accountKey || Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].socialSetId === socialSetId) || null;
        draft = { ...r, body: await tf.getDraft(r.socialSetId, r.draftId) };
        const posts = draft.body?.platforms?.x?.posts || [];
        // A tweet that already carries media is not matched (--replace to include it): a re-run never pays
        // for a cut it could not place.
        // --only 1,3: just those tweet positions (the /run hook pass matches tweet 1 alone).
        const only = val('only') ? nums('only') : null;
        // --no-video 5,7: tweets that may carry no video (a clip always is one): before a plug, a bridge, the weld.
        tweetIndex = eligibleTweets(posts, r.account).map((n) => n - 1).filter((i) => (!only || only.has(i + 1)) && !noVideo.has(i + 1) && (argv.includes('--replace') || !(posts[i].media_ids || []).length));
        tweets.splice(0, tweets.length, ...tweetIndex.map((i) => posts[i].text));
        console.log(`Draft ${r.draftId} (${r.username || accountKey || socialSetId}): ${posts.length} tweets, ${tweets.length} eligible for a clip`);
        if (!tweets.length) {
          console.log('Every eligible tweet already carries media — nothing to match.');
          if (val('out')) writeFileSync(val('out'), JSON.stringify({ ...report, decisions: [], placed: { attached: [] } }, null, 1));
          return;
        }
      }
      if (place && socialSetId == null) throw new Error('--cut needs --account <key> or --draft <ref> (the clip is uploaded to that social set)');
      if (place && !draftRef && !argv.includes('--new-draft') && !argv.includes('--upload-only')) throw new Error('--cut needs somewhere to put the clips: --draft <ref>, --new-draft or --upload-only');
      const library = await store.load();
      const stored = libraryCandidates(library, { socialSetId });
      const candidates = [...stored, ...windows];
      if (!candidates.length) throw new Error(`nothing to match against: no --segments/--pool and no clips in ${store.name}`);
      console.log(`MATCH · ${tweets.length} tweet(s) × ${stored.length} stored clip(s) + ${windows.length} fresh window(s), shortlist ${CLIP_RULES.shortlist} each`);
      const t0 = Date.now();
      const unitsBy = new Map(sources.map(({ source, segments }) => [source.id, unitsFromSegments(segments)]));
      // Three groups, each matched under its own rules (choice and refinement both):
      //   plain;  --high-bar 1: the hook, at the strict bar on ordinary windows (operator 2026-09-24);
      //   --strict 4: the first tweet of a CTA, at the strict bar on its own short windows and stored clips
      //   short enough (strictMatchRules). Each high-bar or strict pick is guarded again by strictChoice.
      const group = tweetIndex.map((ix) => (strictAt.has(ix + 1) ? 'strict' : highBarAt.has(ix + 1) ? 'high' : 'plain'));
      const none = { decisions: [], breaker: { open: false }, pairs: 0, refined: 0 };
      const runGroup = async (g, cands, opts) => {
        const ts = tweets.filter((_, i) => group[i] === g);
        return ts.length ? matchTweets(client, ts, cands, opts) : none;
      };
      const matched = await runGroup('plain', candidates, { unitsBy });
      const high = matched.breaker.open ? none : await runGroup('high', candidates, { rules: highBarRules(), unitsBy, mainIdea: true });
      let strictMatched = none;
      if (group.includes('strict') && !matched.breaker.open && !high.breaker.open) {
        const sr = strictMatchRules();
        const shortUnits = new Map(sources.map(({ source, segments }) => [source.id, unitsFromSegments(segments, { maxUnitS: CLIP_RULES.strict.maxUnitS })]));
        const shortWindows = argv.includes('--library-only') ? [] : sources.flatMap(({ source }) =>
          candidateWindows(shortUnits.get(source.id), sr.window).map((w) => ({ ...w, kind: 'fresh', sourceId: source.id, title: source.title, url: source.url })));
        const shortStored = stored.filter((c) => c.end - c.start <= CLIP_RULES.strict.maxS + 0.5);
        strictMatched = await runGroup('strict', [...shortStored, ...shortWindows], { rules: sr, unitsBy: shortUnits });
      }
      const parts = [matched, high, strictMatched];
      const breaker = parts.find((p) => p.breaker.open)?.breaker || { open: false };
      const pairs = parts.reduce((n, p) => n + p.pairs, 0), refined = parts.reduce((n, p) => n + p.refined, 0);
      const rescued = parts.reduce((n, p) => n + (p.rescued || 0), 0);
      const next = { plain: 0, high: 0, strict: 0 };
      const matchedDecisions = tweets.map((_, i) => {
        const g = group[i];
        const d = (g === 'plain' ? matched : g === 'high' ? high : strictMatched).decisions[next[g]++];
        if (g === 'plain') return d;
        if (!d) return { tweet: tweets[i], action: 'none', pick: null, ranked: [], strict: 'not matched' };
        return { ...d, ...strictChoice(d, g === 'high' ? { maxS: Infinity } : {}) };
      });
      // The per-thread video cap (owner, 2026-10-03): only when the clips land on a thread. --max-clips N is
      // what is left of it when the caller placed videos already (the /run media pass, after the hook).
      const onThread = Boolean(draftRef || argv.includes('--new-draft'));
      const maxClips = val('max-clips') != null ? Number(val('max-clips')) : onThread ? CLIP_RULES.perThread.maxVideos : Infinity;
      if (!(maxClips === Infinity || (Number.isInteger(maxClips) && maxClips >= 0))) throw new Error('--max-clips must be a whole number (0 or more)');
      const decisions = capClips(matchedDecisions, maxClips, { hookAt: tweetIndex.includes(0) ? tweetIndex.indexOf(0) : null });
      const cappedN = decisions.filter((d) => d.action === 'capped').length;
      if (breaker.open) throw new Error(`Jev breaker open: ${breaker.reason}`);
      console.log(`${pairs} pairs + ${refined} boundary variants judged in ${Math.round((Date.now() - t0) / 1000)}s${rescued ? ` · ${rescued} hook clip(s) rescued on the main idea` : ''}${cappedN ? ` · ${cappedN} clip(s) over the ${maxClips}-video cap left off (lowest Jev fit)` : ''}\n`);
      decisions.forEach((d, i) => {
        console.log(`[${tweetIndex[i] + 1}] ${cut(d.tweet, 100)}`);
        if (d.strict) console.log(`    (${highBarAt.has(tweetIndex[i] + 1) && !strictAt.has(tweetIndex[i] + 1) ? 'hook: high bar' : `first tweet of a CTA: ≤${CLIP_RULES.strict.maxS}s`} · ${d.strict === 'met' ? 'met' : d.strict})`);
        if (d.pick) console.log(`    → ${d.action.toUpperCase()} ${d.pick.kind === 'library' ? d.pick.id : 'fresh'} · ${cut(d.pick.title || d.pick.sourceId, 30)} ${hms(d.pick.start)}–${hms(d.pick.end)} · fit ${f2(d.pick.fit)} (direct ${f2(d.pick.support.direct)})${d.pick.boundary ? ` · start/end ${f2(d.pick.boundary.clean_start)}/${f2(d.pick.boundary.clean_end)}` : ''}${d.pick.reuse ? ` · ${d.pick.reuse}` : ''}\n      "${cut(d.pick.text, 160)}"`);
        else console.log(`    → ${d.action.toUpperCase()}${d.ranked[0] ? ` (best fit ${f2(d.ranked[0].fit)}: "${cut(d.ranked[0].text, 100)}")` : ' (no lexical candidates)'}`);
      });
      Object.assign(report, { decisions: decisions.map(({ tweet, action, pick, ranked, strict, rescued }) => ({ tweet, action, pick, ranked: (ranked || []).slice(0, 5), ...(strict ? { strict } : {}), ...(rescued ? { rescued } : {}) })) });
      if (place && argv.includes('--no-stored')) report.recut = true; // every placement below is a fresh cut
      if (place) report.placed = await placeClips({ env, tf, argv, val, decisions, tweetIndex, tweets, socialSetId, account: ACCOUNTS[accountKey] || draft?.account || null, draft, library, store, sources });
    }
    const out = val('out');
    if (out) { writeFileSync(out, JSON.stringify(report, null, 1)); console.log(`\nreport → ${out}`); }
  } finally {
    await flushLlmSpend(env, 'clip-find', report.mode);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}

