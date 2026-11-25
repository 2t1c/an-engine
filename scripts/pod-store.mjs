#!/usr/bin/env node
// scripts/pod-store.mjs — download a podcast ONCE (on the Mac: a home IP passes YouTube's checks) and store it in
// Cloudflare R2 through the clipper service, so every later cut of that episode is a range read of the stored
// file: no RapidAPI call, no YouTube fetch, seconds per cut (gtx-clipper-service README "Stored episodes first").
//
//   node scripts/pod-store.mjs <videoId|url> [...]        # these episodes
//   node scripts/pod-store.mjs --clips [--days 60]         # every episode a stored clip of the Clip Library uses
//   node scripts/pod-store.mjs --pool [--limit 20]         # the health pool's Podcasts table
//   --dry        list what would be stored, download nothing
//   --keep       keep the local mp4 after the upload (default: deleted)
//   --dir <d>    work folder (default ./target/pod-store)
//
// Stores episodes/<id>.mp4 (<=1080p H.264 + AAC, faststart) and episodes/<id>.en.json3 (YouTube's captions).
// An episode already in R2 is skipped. The R2 keys stay on the service: this script only asks it for a
// presigned PUT (POST /episode-upload). Env: CLIPPER_URL, CLIPPER_SERVICE_KEY; AIRTABLE_PAT for --clips/--pool;
// YTDLP_PATH to pin a yt-dlp (else Homebrew's, else the one on PATH).
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pExec = promisify(execFile);

// <=1080p H.264 over plain https + m4a. The protocol filter keeps out YouTube's Premium HLS ladder (616),
// which yt-dlp otherwise picks and which crawls at ~5 KB/s and stops early (seen 2026-11-19).
export const FORMAT = 'bv*[height<=1080][vcodec^=avc1][protocol^=https]+ba[ext=m4a][protocol^=https]/'
  + 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][height<=1080]';

/** yt-dlp args for one episode: video + captions, merged to a faststart mp4. Pure. */
export function downloadArgs(videoId, dir, { lang = 'en' } = {}) {
  return ['--no-warnings', '--no-playlist', '-f', FORMAT, '--merge-output-format', 'mp4',
    '--postprocessor-args', 'Merger+ffmpeg_o:-movflags +faststart',
    '--write-subs', '--write-auto-subs', '--sub-langs', `${lang}.*,${lang}`, '--sub-format', 'json3',
    '-o', join(dir, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${videoId}`];
}

export const videoIdOf = (s) => { const m = String(s ?? '').match(/(?:v=|youtu\.be\/|shorts\/|^)([A-Za-z0-9_-]{11})(?:[?&#]|$)/); return m ? m[1] : null; };

/** Homebrew's yt-dlp first: an old pip copy can sit earlier on PATH (seen on the Mac 2026-11-19). */
export function pickYtdlp(env, exists = existsSync) {
  if (env.YTDLP_PATH) return env.YTDLP_PATH;
  return ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp'].find((p) => exists(p)) || 'yt-dlp';
}

/** The caption file yt-dlp wrote for `lang`, preferring the exact track over en-orig etc. Pure. */
export function pickCaptionFile(names, videoId, lang = 'en') {
  const subs = names.filter((n) => n.startsWith(videoId) && n.endsWith('.json3'));
  return subs.find((n) => n === `${videoId}.${lang}.json3`) || subs[0] || null;
}

function clipper(env) {
  const base = String(env.CLIPPER_URL || '').replace(/\/+$/, '');
  if (!base || !env.CLIPPER_SERVICE_KEY) throw new Error('needs CLIPPER_URL and CLIPPER_SERVICE_KEY');
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.CLIPPER_SERVICE_KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`clipper ${method} ${path} -> ${r.status}: ${j.error || ''}`);
    return j;
  };
  return { status: (id) => call('GET', `/episodes/${id}`), uploadUrl: (videoId, kind) => call('POST', '/episode-upload', { videoId, kind }) };
}

async function putFile(url, file, contentType) {
  const size = statSync(file).size;
  const r = await fetch(url, { method: 'PUT', body: createReadStream(file), duplex: 'half', headers: { 'Content-Type': contentType, 'Content-Length': String(size) }, signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!r.ok) throw new Error(`R2 PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return size;
}

async function idsFromAirtable(env, { clips, pool, days, limit }) {
  const { airtable } = await import('../lib.mjs');
  const { clipBaseId, loadClipLibrary } = await import('../clip-pool.mjs');
  const { TABLES } = await import('../config.mjs');
  const at = airtable(env, clipBaseId(env));
  const ids = new Set();
  if (clips) {
    const since = Date.now() - days * 86400000;
    for (const r of await loadClipLibrary(at)) {
      const recent = (r.uses || []).some((u) => Date.parse(u.at) >= since) || Date.parse(r.addedAt) >= since;
      const id = videoIdOf(r.source?.url) || videoIdOf(r.source?.id);
      if (recent && id) ids.add(id);
    }
  }
  if (pool) for (const row of await at.listAll(TABLES.podcasts, {})) { const id = videoIdOf(row.fields['Video ID']) || videoIdOf(row.fields.URL); if (id) ids.add(id); }
  return [...ids].slice(0, limit || Infinity);
}

async function main(argv) {
  const { loadEnv } = await import('../lib.mjs');
  const env = loadEnv();
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
  const flagsWithValue = new Set(['--days', '--limit', '--dir']);
  const loose = argv.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(argv[i - 1]));
  let ids = loose.map(videoIdOf).filter(Boolean);
  if (has('--clips') || has('--pool')) ids.push(...await idsFromAirtable(env, { clips: has('--clips'), pool: has('--pool'), days: Number(val('--days', 60)), limit: Number(val('--limit', 0)) }));
  ids = [...new Set(ids)];
  if (!ids.length) { console.log('No episodes given (ids/urls, --clips or --pool).'); return 1; }
  const svc = clipper(env);
  const dir = resolve(val('--dir', 'target/pod-store'));
  mkdirSync(dir, { recursive: true });
  const ytdlp = pickYtdlp(env);
  let stored = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      const st = await svc.status(id);
      if (st.stored) { skipped++; console.log(`= ${id} already stored (${(st.bytes / 1e9).toFixed(2)} GB${st.captions ? ', captions' : ''})`); continue; }
      if (has('--dry')) { console.log(`· ${id} would be stored`); continue; }
      console.log(`▶ ${id} downloading…`);
      const t0 = Date.now();
      await pExec(ytdlp, downloadArgs(id, dir), { timeout: 2 * 60 * 60 * 1000, maxBuffer: 1 << 26 });
      const mp4 = join(dir, `${id}.mp4`);
      if (!existsSync(mp4) || !statSync(mp4).size) throw new Error('yt-dlp produced no mp4');
      const bytes = await putFile((await svc.uploadUrl(id, 'mp4')).url, mp4, 'video/mp4');
      const sub = pickCaptionFile(readdirSync(dir), id, 'en');
      if (sub) await putFile((await svc.uploadUrl(id, 'en.json3')).url, join(dir, sub), 'application/json');
      const back = await svc.status(id);
      if (!back.stored || back.bytes !== bytes) throw new Error(`read-back mismatch (stored ${back.stored}, ${back.bytes} vs ${bytes} bytes)`);
      stored++;
      console.log(`✓ ${id} stored ${(bytes / 1e9).toFixed(2)} GB${sub ? ' + captions' : ' (no en captions)'} in ${Math.round((Date.now() - t0) / 1000)}s`);
      if (!has('--keep')) for (const n of readdirSync(dir)) if (n.startsWith(id)) rmSync(join(dir, n), { force: true });
    } catch (e) {
      failed++;
      console.log(`✗ ${id}: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 240)}`);
    }
  }
  console.log(`\n${stored} stored · ${skipped} already there · ${failed} failed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
