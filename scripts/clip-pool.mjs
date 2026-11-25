#!/usr/bin/env node
// scripts/clip-pool.mjs — the podcast pool, Jev-native from the start (clip-pool.mjs: storage and
// transcript; clip-judge.mjs: the questions and rules). Everything lives in the Clip Library base.
//
//   node scripts/clip-pool.mjs add    --video <url|id> [--video …] [--focus "…"]   transcript + Jev fit
//   node scripts/clip-pool.mjs mine   [--video <id> …] [--focus "…"] [--top 12] [--min-fit 0.5]
//   node scripts/clip-pool.mjs ingest --video <url|id> [--video …]                 add, then mine
//   node scripts/clip-pool.mjs list
//   node scripts/clip-pool.mjs setup  --workspace <wsp…>                            a NEW Clip Library base
//
// --lane      the clip pool (clip-lanes.mjs); health is the only lane.
//
// add     reads the video's details and English captions (RapidAPI: one call per video, from the free
//         plan's monthly quota; when that fails, yt-dlp's embedded client), upserts the Podcasts row,
//         attaches transcript.json, and asks Jev whether the episode fits the focus. Status -> In Pool.
//         A row that already has a transcript is skipped unless --refresh.
// mine    for each In Pool podcast not mined yet (--refresh: every one; --video: those) with Fit >=
//         --min-fit: reads the transcript, cuts sentence windows in code, runs Jev (clip-judge.mjs
//         mineClips), and upserts the chosen clips into Clips with every score. The podcast stays In
//         Pool: mine it again with another --focus any time; Mined At and Clips Found record the pass.
// Transcripts are never fetched at match time: MATCH (scripts/clip-find.mjs --pool) reads the attachment.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIP_RULES, mineClips } from '../clip-judge.mjs';
import { toRecord } from '../clip-library.mjs';
import { IN_POOL,
  CLIP_BASE_SCHEMA, clipBaseId, createClipBase, poolFitHash, poolFitQuestions, poolState, readTranscript, saveClipRecords,
  segmentsFromCaptionEvents, transcriptFile, uploadJsonAttachment, videoIdOf,
} from '../clip-pool.mjs';
import { TABLES } from '../config.mjs';
import { FLEET_FOCUS, LANES, laneBase, clipLaneOf, laneTables } from '../clip-lanes.mjs';

export { FLEET_FOCUS };
export const POOL_RULES = LANES.health.pool;

export { videoIdOf };
export function allArgs(argv, name) {
  const out = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1] != null) out.push(argv[i + 1]); });
  return out;
}
const now = () => new Date().toISOString();

async function add({ env, at, client, videos, focus, refresh, base: baseId }) {
  const { fetchVideoDetails, fetchCaptionEvents, captionsViaYtdlp } = await import('../clip-thread.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  let rapidDown = !env.RAPIDAPI_KEY;
  const base = baseId || clipBaseId(env);
  const existing = new Map((await at.listAll(TABLES.podcasts, { fields: ['Video ID', 'Transcript', 'Status'] })).map((r) => [r.fields['Video ID'], r]));
  const questions = poolFitQuestions(focus);
  for (const v of videos) {
    const id = videoIdOf(v);
    if (!id) { console.log(`✗ ${v}: no YouTube video id`); continue; }
    const had = existing.get(id);
    if (had?.fields?.Transcript?.length && !refresh) { console.log(`· ${id}: already in the pool (${had.fields.Status}) — skipped (--refresh to redo)`); continue; }
    let rowId = had?.id;
    try {
      // RapidAPI first (one call); when it fails (the monthly quota, 2026-09-24) yt-dlp reads the same
      // captions and details, and every later video in this batch skips RapidAPI.
      let d = null, events = null, via = 'rapidapi';
      if (!rapidDown) {
        try { d = await fetchVideoDetails(env, id); events = await fetchCaptionEvents(d, 'en'); }
        catch (e) { if (/RapidAPI/.test(e.message)) rapidDown = true; console.log(`  ⚠️ ${id}: ${String(e.message).slice(0, 120)} — reading with yt-dlp`); d = null; events = null; }
      }
      if (!events) {
        const y = await captionsViaYtdlp(env, id, mkdtempSync(join(tmpdir(), 'clip-pool-')));
        d = { title: y.title, channel: { name: y.channel }, description: y.description, lengthSeconds: Number.isFinite(y.lengthS) ? Math.round(y.lengthS) : null };
        events = y.events; via = `yt-dlp ${y.client || 'default'}`;
      }
      const segments = segmentsFromCaptionEvents(events);
      const channel = d.channel?.name ?? null;
      const url = `https://www.youtube.com/watch?v=${id}`;
      // Through the one door (plan v7 N1): the pinned model, deadline, breaker and template hash lock.
      const { askThrough } = await import('../jev-decide.mjs'); // optional-import
      const fit = await askThrough('clip-pool-read', client, { state: poolState({ title: d.title, channel, description: d.description }), questions }, { role: 'clip-pool' });
      const fields = {
        'Video ID': id, Title: d.title ?? null, Channel: channel, URL: url, 'Length Sec': Number(d.lengthSeconds) || null,
        Status: 'In Pool', Fit: Math.round((fit.answers.fit?.noul ?? 0) * 100) / 100, Focus: focus,
        'Caption Track': 'en', Segments: segments.length, Model: fit.model, 'Added At': now(), Error: null,
      };
      if (rowId) await at.update(TABLES.podcasts, [{ id: rowId, fields }]);
      else { await at.create(TABLES.podcasts, [{ fields }], { typecast: true }); rowId = (await at.listAll(TABLES.podcasts, { formula: `{Video ID}='${id}'`, fields: ['Video ID'] }))[0]?.id; }
      const bytes = await uploadJsonAttachment(env, base, rowId, 'Transcript', `${id}.transcript.json`, transcriptFile({ videoId: id, title: d.title, lengthSeconds: Number(d.lengthSeconds) || null, track: 'en', events }));
      console.log(`✓ ${id} · ${String(d.title).slice(0, 60)} · ${Math.round((Number(d.lengthSeconds) || 0) / 60)} min · ${segments.length} sentences · fit ${fields.Fit} (${fit.answers.format?.choice}) · transcript ${(bytes / 1024).toFixed(0)} KB · via ${via}`);
    } catch (e) {
      console.log(`✗ ${id}: ${e.message}`);
      const fields = { 'Video ID': id, Status: 'Error', Error: String(e.message).slice(0, 1000) };
      if (rowId) await at.update(TABLES.podcasts, [{ id: rowId, fields }]); else await at.create(TABLES.podcasts, [{ fields }], { typecast: true });
    }
  }
  return { fitHash: poolFitHash(focus) };
}

async function mine({ at, client, videos, focus, top, minFit, refresh, rules = CLIP_RULES }) {
  const rows = await at.listAll(TABLES.podcasts);
  const ids = new Set(videos.map(videoIdOf).filter(Boolean));
  const todo = rows.filter((r) => (ids.size ? ids.has(r.fields['Video ID']) : IN_POOL.has(r.fields.Status) && (refresh || !r.fields['Mined At'])))
    .filter((r) => r.fields.Transcript?.length);
  if (!todo.length) { console.log('Nothing new to mine (every In Pool podcast has been mined; --refresh or --video to mine again).'); return; }
  for (const r of todo) {
    const f = r.fields;
    if (!ids.size && (f.Fit ?? 0) < minFit) { console.log(`· ${f['Video ID']}: fit ${f.Fit} below ${minFit} — not mined`); continue; }
    const t0 = Date.now();
    const file = await readTranscript(r);
    const source = { id: f['Video ID'], title: f.Title ?? null, url: f.URL ?? null };
    const segments = segmentsFromCaptionEvents(file.events);
    const res = await mineClips(client, [{ source, segments }], { focus, top, rules });
    if (res.breaker.open) throw new Error(`Jev breaker open: ${res.breaker.reason}`);
    const records = res.chosen.map((c) => toRecord(c, { source, questionSetHash: res.questionSetHash }));
    await saveClipRecords(at, records);
    await at.update(TABLES.podcasts, [{ id: r.id, fields: { Status: 'In Pool', 'Windows Judged': res.windows + res.variants, 'Clips Found': records.length,
      'Question Set Hash': res.questionSetHash, Model: res.chosen[0]?.model ?? f.Model ?? null, 'Mined At': now(), Focus: focus } }]);
    console.log(`✓ ${source.id} · ${String(source.title).slice(0, 50)} · ${res.windows} windows + ${res.variants} variants in ${Math.round((Date.now() - t0) / 1000)}s → ${records.length} clips`);
    for (const c of res.chosen) console.log(`    ${new Date(c.start * 1000).toISOString().slice(11, 19)} ${Math.round(c.end - c.start)}s · rank ${c.rank.toFixed(2)} · ${String(c.text).slice(0, 90)}…`);
  }
}

async function list({ at }) {
  const rows = await at.listAll(TABLES.podcasts);
  const clips = (await at.listAll(TABLES.clips, { fields: ['Watch URL', 'Times Used', 'Operator Label'] })).map((c) => ({ ...c, videoId: videoIdOf(c.fields['Watch URL'] || '') }));
  console.log(`| Video | Title | Status | Fit | Clips | Used | Labelled |\n|---|---|---|--:|--:|--:|--:|`);
  for (const r of rows) {
    const f = r.fields, mine = clips.filter((c) => c.videoId === f['Video ID']);
    console.log(`| ${f['Video ID']} | ${String(f.Title || '').slice(0, 50)} | ${f.Status} | ${f.Fit ?? ''} | ${mine.length} | ${mine.filter((c) => c.fields['Times Used']).length} | ${mine.filter((c) => c.fields['Operator Label']).length} |`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] != null ? argv[i + 1] : d; };
  const { loadEnv, airtable, flushLlmSpend } = await import('../lib.mjs');
  const env = loadEnv();
  if (cmd === 'setup') {
    const ws = val('workspace');
    if (!ws) throw new Error('setup needs --workspace <wsp…> (it creates a NEW base; the live one is CLIPS_BASE in config.mjs)');
    console.log(JSON.stringify(await createClipBase(env, ws, { schema: CLIP_BASE_SCHEMA })));
    return;
  }
  const lane = clipLaneOf(val('lane'));
  const base = laneBase(lane, env);
  const at = laneTables(airtable(env, base), lane);
  if (lane.name !== 'health') console.log(`lane ${lane.name} · base ${base}`);
  if (cmd === 'list') return list({ at });
  const { jev } = await import('../jev.mjs');
  const client = jev({ ...env, TYPESAFE_DEFAULT_MODEL: CLIP_RULES.model });
  const videos = allArgs(argv, 'video');
  const focus = val('focus', lane.focus);
  const opts = { env, at, client, videos, focus, base, rules: lane.rules, refresh: argv.includes('--refresh'), top: Number(val('top', lane.pool.top)), minFit: Number(val('min-fit', lane.pool.minFit)) };
  try {
    if (cmd === 'add') await add(opts);
    else if (cmd === 'mine') await mine(opts);
    else if (cmd === 'ingest') { if (!videos.length) throw new Error('ingest needs --video'); await add(opts); await mine(opts); }
    else throw new Error('usage: clip-pool.mjs add|mine|ingest|list|setup (see the header)');
  } finally {
    await flushLlmSpend(env, 'clip-pool', cmd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
