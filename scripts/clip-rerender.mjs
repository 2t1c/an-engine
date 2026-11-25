#!/usr/bin/env node
// scripts/clip-rerender.mjs — burn PI captions + the page handle onto a hook clip that is already attached to a
// draft's tweet 1, and swap it in on every platform that carries it (X and Threads). Text and schedule untouched.
//
//   node scripts/clip-rerender.mjs <account> <draftId> <videoId> <windowStartS> [--src <mediaId>] [--lead 0.4] [--dry]
//
//   <windowStartS>  the clip's start in the episode (the Clip Library row's start)
//   --src <id>      re-render from this Typefully media id instead of the one on tweet 1 (use the ORIGINAL clean
//                   cut when tweet 1 already carries a captioned version: never burn captions on captions)
//   --lead S        seconds the cut trimmed off the window start (the Mac cuts use -ss 0.4, the default)
//   --dry           render clip + still into the work folder, upload nothing
//
// Captions come from the episode's json3 transcript in the Podcasts table, chunked by the clipper service's own
// buildWordCues (<=4 words, manual tracks spread per line) so a re-render matches a fresh service cut exactly.
// Needs a gtx-clipper-service checkout: CLIPPER_SRC, else ../gtx-clipper-service beside this repo.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Swap `oldId` for `newId` on post 0 of every enabled platform that carries it. Pure. */
export function swapHookMedia(platforms, oldId, newId) {
  const patch = {};
  for (const [p, v] of Object.entries(platforms || {})) {
    if (!v?.enabled || !v.posts?.length || !(v.posts[0].media_ids || []).includes(oldId)) continue;
    patch[p] = { enabled: true, posts: v.posts.map((q, i) => ({ text: q.text, media_ids: i === 0 ? (q.media_ids || []).map((m) => (m === oldId ? newId : m)) : (q.media_ids || []) })) };
  }
  return patch;
}

/** The PI watermark (operator 2026-11-19): handle top-left, 44px, white@0.40, faint border. Pure. */
export function piWatermarkFilter(font, handle, escape = (s) => String(s).replace(/[\\':%]/g, (m) => '\\' + m)) {
  return `drawtext=fontfile='${font}':text='${escape(handle)}':fontcolor=white@0.40:fontsize=44:borderw=2:bordercolor=black@0.25:x=48:y=40`;
}

async function main(argv) {
  const flag = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
  const [account, draftArg, vid, winStart] = argv.filter((a, i) => !a.startsWith('--') && !['--src', '--lead'].includes(argv[i - 1]));
  if (!account || !draftArg || !vid || winStart == null) { console.log('usage: clip-rerender.mjs <account> <draftId> <videoId> <windowStartS> [--src id] [--lead 0.4] [--dry]'); return 1; }
  const src = resolve(process.env.CLIPPER_SRC || join(ROOT, '..', 'gtx-clipper-service'));
  if (!existsSync(join(src, 'server.js'))) throw new Error(`no gtx-clipper-service checkout at ${src} (set CLIPPER_SRC)`);
  const svc = createRequire(import.meta.url)(join(src, 'server.js'));
  const { loadEnv, typefully, airtable } = await import('../lib.mjs');
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { clipBaseId, readTranscript } = await import('../clip-pool.mjs');
  const { TABLES } = await import('../config.mjs');
  const { uploadAndWait } = await import('../clip-thread.mjs');
  const acc = ACCOUNTS[account];
  if (!acc) throw new Error(`unknown account ${account}`);
  const env = loadEnv(); const tf = typefully(env); const ss = acc.socialSetId; const draftId = Number(draftArg);
  const W = join(tmpdir(), `clip-rerender-${account}-${draftId}`); mkdirSync(W, { recursive: true });

  const d = await tf.getDraft(ss, draftId);
  const oldId = d.platforms?.x?.posts?.[0]?.media_ids?.[0];
  if (!oldId) throw new Error(`draft ${draftId}: tweet 1 has no media to replace`);
  const st = await tf.getMediaStatus(ss, flag('--src', oldId));
  execFileSync('curl', ['-sS', '-o', join(W, 'in.mp4'), st.media_urls.original]);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(W, 'in.mp4')]).toString());

  const at = airtable(env, clipBaseId(env));
  const row = (await at.listAll(TABLES.podcasts, { formula: `{Video ID}='${vid.replace(/'/g, '')}'` }))[0];
  if (!row) throw new Error(`no Podcasts row for ${vid}`);
  const tr = await readTranscript(row);
  const startS = Number(winStart) + Number(flag('--lead', 0.4));
  const cues = svc.buildWordCues(tr.events || [], startS, startS + dur);
  if (!cues.length) throw new Error(`no transcript words inside ${startS}-${startS + dur}s of ${vid}`);
  writeFileSync(join(W, 'c.ass'), svc.buildAss(cues, { fontSize: 70, marginV: 90 }));
  const fonts = join(src, 'fonts');
  const name = `${account}-hook.mp4`, out = join(W, name);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(W, 'in.mp4'),
    '-vf', `subtitles=filename='${join(W, 'c.ass')}':fontsdir='${fonts}',${piWatermarkFilter(join(fonts, 'Montserrat-ExtraBold.ttf'), '@' + acc.handle, svc.escapeDrawtext)}`,
    '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.min(6, dur / 3)), '-i', out, '-frames:v', '1', join(W, 'still.png')]);
  console.log(`${account}: ${cues.length} cues, first ${JSON.stringify(cues.slice(0, 3).map((c) => c.text))}\n  still ${join(W, 'still.png')}`);
  if (argv.includes('--dry')) return 0;

  const mediaId = await uploadAndWait(tf, ss, name, out);
  const fresh = await tf.getDraft(ss, draftId);
  await tf.patchDraft(ss, draftId, { platforms: swapHookMedia(fresh.platforms, oldId, mediaId) });
  const b = await tf.getDraft(ss, draftId);
  const same = JSON.stringify(b.platforms.x.posts.map((p) => p.text)) === JSON.stringify(d.platforms.x.posts.map((p) => p.text));
  const where = Object.entries(b.platforms).filter(([, v]) => v?.enabled).map(([k, v]) => `${k}:${(v.posts[0].media_ids || []).includes(mediaId) ? 'new' : 'OLD'}`).join(' ');
  console.log(`  ${draftId} ${b.status} ${b.scheduled_date || ''} text_same=${same} ${where}`);
  return same && !where.includes('OLD') ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
