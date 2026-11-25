// clip-thread.mjs — clip a podcast into a thread (skill: /clip-thread).
//
// Given a Typefully draft and a YouTube podcast: read the podcast's own captions as a timestamped
// transcript, choose up to 3 windows of 20-60s that each SUPPORT one tweet (tweet 1 always), cut them,
// upload them to Typefully, and attach each to its tweet. The thread's TEXT is never touched, and the
// draft's schedule is preserved. Clips carry PI captions (Style A box, larger, <=4-word chunks) and the page
// handle top-left as a watermark (operator 2026-11-19; --no-watermark to leave it off). Plug tweets (#ad, {LINK}), the closing and the disclaimer never get a clip.
//
//   node clip-thread.mjs --draft <typefully.com/t/… | ?d=…&a=… | draft id> --video <youtube url>
//        [--account <key>]         social set owner, only needed for a bare draft id that neither the
//                                  fleet roster nor the Typefully social-set list resolves
//        [--clips 3]               min-max clips (default 3); "2-3" allows fewer. Never more than the
//                                  per-thread video cap, CLIP_RULES.perThread.maxVideos (owner, 2026-10-03)
//        [--engine service|local|filmcraft]
//                                  service   = the Railway clipper (CLIPPER_URL + CLIPPER_SERVICE_KEY);
//                                  local     = yt-dlp + ffmpeg on THIS machine — a laptop's home IP
//                                              works where datacenter IPs hit "confirm you're not a bot".
//                                  filmcraft = the clipper service fetches the raw window (its RapidAPI
//                                              stream, no captions), else yt-dlp; `filmcraft-cli clip` burns
//                                              the captions and formats the mp4 (FILMCRAFT_CLI, else PATH).
//                                  Default: service when configured, else local. Never falls back.
//        [--caption-words N]       filmcraft only: N words per caption (1-2 = one pulse per spoken word)
//        [--caption-max-chars N] [--caption-max-seconds S]   filmcraft only: caption block limits
//        [--caption-preset NAME]   filmcraft only: a FilmCraft caption preset (look, place, words per caption)
//                                  from filmcraft-caption-presets.json, the user's shared FilmCraft presets
//                                  or FilmCraft's built-ins. Without it: Style A.
//        [--caption-presets FILE]  filmcraft only: another preset file (default filmcraft-caption-presets.json)
//        [--plan plan.json]        skip the LLM pick, use these windows (the file --dry writes)
//        [--dry]                   pick + validate + print + write the plan; cut nothing
//        [--no-captions] [--watermark '@handle' | --no-watermark (default: the page's @handle)] [--replace] [--min 20] [--max 60] [--no-anchor]
//
// Two engines, one contract: a clip is an exact-window 1080p h264/aac mp4 with the original English
// audio track. The service path is the operator-hosted cloud cutter (the clipper service); the local path is
// the same recipe run here (yt-dlp fetches ONLY the window's bytes, ffmpeg burns the captions).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEnv, requireEnv, typefully, anthropic, HERE_DIR, cliArg } from './lib.mjs';
import { buildPlatforms, CROSS_POST_PLATFORMS } from './platforms.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { CLIP_RULES } from './clip-judge.mjs';

const pExecFile = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pure helpers (exported for tests)

export const toSec = (t) => {
  if (typeof t === 'number') return t;
  const s = String(t ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((p) => Number.isNaN(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};
export const fmtHMS = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
/** HH:MM:SS with a tenth of a second when there is one — the pre-roll needs sub-second cuts, and
 *  both yt-dlp's section syntax and the clipper's parser accept the fraction. */
export const fmtHMSf = (sec) => {
  let whole = Math.floor(Math.max(0, sec));
  let tenths = Math.round((Math.max(0, sec) - whole) * 10);
  if (tenths === 10) { whole += 1; tenths = 0; }
  return tenths ? `${fmtHMS(whole)}.${tenths}` : fmtHMS(whole);
};

/** A Typefully draft reference in any of the three forms an operator pastes. */
export function parseDraftRef(ref) {
  const s = String(ref ?? '').trim();
  let m = s.match(/typefully\.com\/t\/([A-Za-z0-9_-]+)/);
  if (m) return { share: m[1] };
  m = s.match(/[?&]d=(\d+)/);
  if (m) { const a = s.match(/[?&]a=(\d+)/); return { draftId: Number(m[1]), ...(a ? { socialSetId: Number(a[1]) } : {}) }; }
  if (/^\d{6,}$/.test(s)) return { draftId: Number(s) };
  return null;
}

export const videoIdOf = (url) => { const m = String(url ?? '').match(/[a-zA-Z0-9_-]{11}/g); return m ? m[m.length - 1] : null; };

/** YouTube json3 caption events -> "[HH:MM:SS] text" lines, roll-up duplicates collapsed. */
export function transcriptLines(events) {
  const out = [];
  for (const e of events || []) {
    if (e.tStartMs == null || !e.segs) continue;
    const t = e.segs.map((g) => g.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (out.length && out[out.length - 1].endsWith(t)) continue;
    out.push(`[${fmtHMS(e.tStartMs / 1000)}] ${t}`);
  }
  return out;
}

/** Tweets that must never carry a clip: plugs, placeholders, sign-offs. */
export const isPlugTweet = (text) =>
  /#ad\b|\{LINK\d*\}|\{CLOSING|\{DISCLAIMER|\bAff(?:iliate)? link\b|lvnta\.com|amzn\.to|amazon\.com\/|gumroad\.com|geni\.us/i.test(String(text ?? ''));

export function eligibleTweets(posts, account = null) {
  const out = [];
  posts.forEach((p, i) => {
    const t = String(p.text ?? '').trim();
    if (!t || isPlugTweet(t)) return;
    if (account?.closing && t === account.closing) return;
    if (account?.disclaimer && t === account.disclaimer) return;
    out.push(i + 1);
  });
  return out;
}

/** First balanced {...} object in an LLM reply, with or without fences/prose. */
export function extractJson(text) {
  const s = String(text ?? '').replace(/^```(?:json)?/im, '').replace(/```\s*$/m, '');
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { start = -1; } } }
  }
  throw new Error(`no JSON object in reply: ${s.slice(0, 160)}`);
}

const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/**
 * Normalize + judge a plan against the thread. Returns { clips, errors, notes }.
 * A clip is { tweet (1-based), start, end, quote?, why?, slug }. Windows outside 20-60s are
 * clamped (noted), everything else that breaks a rule is an error — the caller decides whether to
 * stop. Pure.
 */
export function validatePlan(plan, { posts, account = null, lengthS = Infinity, min = 3, max = CLIP_RULES.perThread.maxVideos, minS = 20, maxS = 60, videoId = 'clip' } = {}) {
  const errors = [], notes = [];
  const eligible = new Set(eligibleTweets(posts, account));
  const seen = new Set();
  const clips = [];
  for (const raw of (plan?.clips || plan || [])) {
    const tweet = Number(raw.tweet ?? raw.post ?? raw.index);
    if (!Number.isInteger(tweet) || tweet < 1 || tweet > posts.length) { errors.push(`clip on tweet ${raw.tweet}: no such tweet (thread has ${posts.length})`); continue; }
    if (!eligible.has(tweet)) { errors.push(`clip on tweet ${tweet}: not eligible (plug, closing, disclaimer or empty)`); continue; }
    if (seen.has(tweet)) { errors.push(`tweet ${tweet}: two clips planned, one video per tweet`); continue; }
    let start = toSec(raw.start), end = toSec(raw.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { errors.push(`tweet ${tweet}: bad window ${raw.start}..${raw.end}`); continue; }
    if (start >= lengthS) { errors.push(`tweet ${tweet}: window starts after the video ends`); continue; }
    if (end - start > maxS) { notes.push(`tweet ${tweet}: window ${Math.round(end - start)}s trimmed to ${maxS}s`); end = start + maxS; }
    if (end - start < minS) { notes.push(`tweet ${tweet}: window ${Math.round(end - start)}s extended to ${minS}s`); end = Math.min(start + minS, lengthS); }
    if (end - start < minS) { errors.push(`tweet ${tweet}: window cannot reach ${minS}s before the video ends`); continue; }
    seen.add(tweet);
    clips.push({ tweet, start: fmtHMS(start), end: fmtHMS(end), startS: start, endS: end,
      quote: raw.quote || '', why: raw.why || '',
      slug: raw.slug || `${videoId}-t${tweet}-${slugify(raw.quote || raw.why || 'clip') || 'clip'}` });
  }
  clips.sort((a, b) => a.tweet - b.tweet);
  for (let i = 1; i < clips.length; i++) {
    const prev = clips.slice(0, i).find((c) => c.startS < clips[i].endS && clips[i].startS < c.endS);
    if (prev) errors.push(`tweet ${clips[i].tweet} and tweet ${prev.tweet}: windows overlap`);
  }
  if (!clips.some((c) => c.tweet === 1)) errors.push('tweet 1 (the hook) has no clip — it must have one');
  if (clips.length < min) errors.push(`${clips.length} clip(s) planned, need at least ${min}`);
  if (clips.length > max) { notes.push(`${clips.length} clips planned, keeping the first ${max} by tweet order`); clips.splice(max); }
  return { clips, errors, notes };
}

// ---------------------------------------------------------------- quote anchoring + pre-roll

const normWords = (t) => String(t ?? '').toLowerCase().replace(/[\u2019\u2018]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim()
  .split(/\s+/).filter(Boolean).map((w) => w.replace(/'/g, ''));

/** Every spoken word with its time, from json3 events (segs carry per-word offsets). Pure. */
export function wordTimeline(events) {
  const words = [];
  for (const e of events || []) {
    if (e.tStartMs == null || !e.segs) continue;
    for (const g of e.segs) {
      const t = (e.tStartMs + (g.tOffsetMs || 0)) / 1000;
      for (const w of normWords(g.utf8)) words.push({ w, t });
    }
  }
  return words;
}
function findSeq(hay, needle, from = 0) {
  if (!needle.length) return -1;
  outer: for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
/**
 * Where a quoted passage is spoken: the first 3-7 words locate the start, the last 3-7 words the
 * end (an ellipsis inside the quote splits it; the head of the first part and the tail of the last
 * part are what matter). Returns { start, end } in seconds or null when the words are not in the
 * captions — a paraphrase, or a quote from somewhere else. Pure.
 */
export function findQuoteSpan(words, quote, from = 0) {
  const parts = String(quote).split(/\s*(?:\.\.\.|\u2026)\s*/).map(normWords).filter((p) => p.length >= 3);
  if (!parts.length) return null;
  const hay = words.map((x) => x.w);
  const head = parts[0], tail = parts[parts.length - 1];
  let si = -1;
  for (let n = Math.min(7, head.length); n >= 3 && si < 0; n--) si = findSeq(hay, head.slice(0, n), from);
  if (si < 0) return null;
  let ei = -1, m = 0;
  for (let k = Math.min(7, tail.length); k >= 3 && ei < 0; k--) { ei = findSeq(hay, tail.slice(-k), si); m = k; }
  const lastIdx = ei >= 0 ? ei + m - 1 : Math.min(si + head.length - 1, words.length - 1);
  const start = words[si].t;
  const end = Math.max(words[Math.min(lastIdx + 1, words.length - 1)].t, words[lastIdx].t + 0.6);
  return { start, end, complete: ei >= 0 };
}

/**
 * Snap each window to the words the tweet quotes, then add the pre-roll and the tail. Laws:
 * - a tweet that quotes the speaker in quotation marks gets a window that CONTAINS those words:
 *   a planned window that already covers them keeps its bounds; one that does not is moved to
 *   the quote (2s lead, 1s tail), because a clip that does not show the quoted words is wrong
 *   however good the passage.
 * - start 0.3s early so the first syllable is never clipped; end no closer than 0.35s after the
 *   last spoken word inside the window so the last one is not cut off either.
 * - then the 20-60s clamp again, and no overlaps.
 * Pure. Windows for tweets without quotes only get the pre-roll and the tail.
 */
export function anchorPlan(clips, posts, events, { preRoll = 0.3, tailMin = 0.35, minS = 20, maxS = 60, lengthS = Infinity } = {}) {
  const words = wordTimeline(events);
  const notes = [], errors = [];
  const out = clips.map((c) => {
    let startS = c.startS, endS = c.endS, anchored = false;
    const text = String(posts[c.tweet - 1]?.text ?? '');
    const quotes = [...text.matchAll(/["\u201c]([^"\u201d]+)["\u201d]/g)].map((m) => m[1]).filter((q) => normWords(q).length >= 4);
    const spans = quotes.map((q) => findQuoteSpan(words, q)).filter(Boolean);
    if (quotes.length && !spans.length) notes.push(`tweet ${c.tweet}: its quoted words are not in the captions (paraphrase or another source) — window kept as planned`);
    if (spans.length) {
      anchored = true;
      const qs = Math.min(...spans.map((x) => x.start)), qe = Math.max(...spans.map((x) => x.end));
      if (qe - qs > maxS) {
        notes.push(`tweet ${c.tweet}: quoted words span ${Math.round(qe - qs)}s, more than ${maxS}s — window anchored to the first quote only`);
        startS = qs - 2; endS = qs - 2 + maxS;
      } else if (startS <= qs && endS >= qe) {
        // planned window already shows every quoted word: keep the editor's bounds
      } else {
        notes.push(`tweet ${c.tweet}: window moved to the quoted words (${fmtHMS(qs)}–${fmtHMS(qe)})`);
        startS = qs - 2; endS = qe + 1;
      }
    }
    startS = Math.max(0, startS - preRoll);
    let lastT = -1;
    for (let i = words.length - 1; i >= 0; i--) if (words[i].t < endS) { lastT = words[i].t; break; }
    if (lastT >= 0 && endS - lastT < tailMin) endS = lastT + tailMin;
    if (endS - startS > maxS) { notes.push(`tweet ${c.tweet}: window trimmed to ${maxS}s after anchoring`); endS = startS + maxS; }
    if (endS - startS < minS) endS = Math.min(startS + minS, lengthS);
    return { ...c, startS, endS, start: fmtHMSf(startS), end: fmtHMSf(endS), anchored };
  });
  out.sort((a, b) => a.tweet - b.tweet);
  for (let i = 1; i < out.length; i++) {
    const prev = out.slice(0, i).find((p) => p.startS < out[i].endS && out[i].startS < p.endS);
    if (prev) errors.push(`tweet ${out[i].tweet} and tweet ${prev.tweet}: windows overlap after anchoring — move one in the plan`);
  }
  return { clips: out, notes, errors };
}

const POST_FIELDS = ['text', 'media_ids', 'quote_post_url', 'hide_link_preview', 'made_with_ai', 'paid_partnership', 'subscribers_only'];
/**
 * Attach uploaded media to the planned tweets. Returns { posts, skipped }. Every post is carried
 * through with all its fields (Typefully's PATCH replaces post objects wholesale); only media_ids on
 * a target changes. A tweet that already has media keeps it unless `replace` — a video posts alone,
 * so appending would produce a rejected mixed tweet. Pure.
 */
export function attachPlanToPosts(posts, attached, { replace = false } = {}) {
  const skipped = [];
  const out = posts.map((p) => {
    const o = {};
    for (const k of POST_FIELDS) if (p[k] !== undefined && p[k] !== null) o[k] = Array.isArray(p[k]) ? [...p[k]] : p[k];
    o.text = p.text; o.media_ids = [...(p.media_ids || [])];
    return o;
  });
  for (const a of attached) {
    const t = out[a.index];
    if (!t) { skipped.push(`tweet ${a.index + 1}: not in draft`); continue; }
    if (t.media_ids.length && !replace) { skipped.push(`tweet ${a.index + 1}: already has media (use --replace)`); continue; }
    t.media_ids = [a.mediaId];
  }
  return { posts: out, skipped };
}

/** Same media on every cross-posted platform whose post count matches X (media.mjs rule). Pure. */
export function mediaAcrossPlatforms(posts, existing) {
  const out = {};
  for (const p of CROSS_POST_PLATFORMS) {
    const pf = existing?.[p];
    if (!pf?.enabled || !Array.isArray(pf.posts) || pf.posts.length !== posts.length) continue;
    out[p] = pf.posts.map((t, i) => ({ ...t, media_ids: [...(posts[i].media_ids || [])] }));
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- Style A captions (mirrors the clipper service)

/** Auto-caption hygiene for the burn: drop sound tags and speaker marks, fillers, stutters. Pure. */
export function cleanCaption(text) {
  return String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')                         // [Music] [Applause] [clears throat]
    .replace(/>>\s*/g, ' ')                               // speaker-change marks
    .replace(/(^|[\s,])(?:uh+|um+|erm|mm+|hmm+)(?=$|[\s,.!?])/gi, '$1')   // fillers
    .replace(/\b([a-z]+(?:'[a-z]+)?)(?:[\s,]+\1\b)+/gi, '$1')            // "it's it's a" -> "it's a"
    .replace(/\s+([,.!?])/g, '$1').replace(/\s+/g, ' ').trim()
    .replace(/^[,.;:\s-]+/, '');
}
/** Sentence capitalization across cues (auto-captions are lowercase) and the pronoun I. Pure. */
export function capitalizeCues(cues) {
  let sentenceStart = true;
  for (const c of cues) {
    let t = c.text;
    if (sentenceStart && t) t = t[0].toUpperCase() + t.slice(1);
    t = t.replace(/([.!?]["\u201d]?\s+)([a-z])/g, (m, p, ch) => p + ch.toUpperCase());
    t = t.replace(/\bi\b/g, 'I').replace(/\bi'(m|ve|d|ll)\b/g, (m, x) => "I'" + x);
    c.text = t;
    sentenceStart = /[.!?]["\u201d]?$/.test(t);
  }
  return cues;
}
export function buildCues(events, startS, endS) {
  const t0 = startS * 1000, t1 = endS * 1000;
  const cues = [];
  for (const e of events || []) {
    const s = e.tStartMs, d = e.dDurationMs || 0;
    if (s == null || !e.segs || s + d <= t0 || s >= t1) continue;
    const text = cleanCaption(e.segs.map((g) => g.utf8 || '').join(''));
    if (!text) continue;
    cues.push({ start: Math.max(s, t0) - t0, end: Math.min(s + d, t1) - t0, text });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  return capitalizeCues(cues.filter((c) => c.end - c.start > 120));
}
const msToAss = (ms) => `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms / 10) % 100).padStart(2, '0')}`;
export function buildAss(cues) {
  const header = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Caption,Montserrat ExtraBold,58,&H00FFFFFF,&H00FFFFFF,&H48000000,&H48000000,0,0,0,0,100,100,0,0,3,10,0,2,180,180,80,1', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'].join('\n');
  return header + '\n' + cues.map((c) => `Dialogue: 0,${msToAss(c.start)},${msToAss(c.end)},Caption,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`).join('\n') + '\n';
}

// ---------------------------------------------------------------- transcript

export async function fetchVideoDetails(env, videoId) {
  const host = env.RAPIDAPI_YT_HOST || 'youtube-media-downloader.p.rapidapi.com';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`https://${host}/v2/video/details?videoId=${videoId}`, { headers: { 'x-rapidapi-host': host, 'x-rapidapi-key': env.RAPIDAPI_KEY } });
    if (r.status === 429 && attempt < 4) { await sleep(1500 * attempt); continue; }
    const d = await r.json();
    if (!r.ok || d.errorId !== 'Success') throw new Error(`RapidAPI details failed (HTTP ${r.status}): ${JSON.stringify(d).slice(0, 200)}`);
    return d;
  }
}
export async function fetchCaptionEvents(details, lang = 'en') {
  const items = details?.subtitles?.items || [];
  const sub = items.find((s) => new RegExp('^' + lang, 'i').test(s.code || s.languageCode || ''));
  if (!sub) throw new Error(`no ${lang} subtitle track on ${details?.title || 'video'} (tracks: ${items.map((s) => s.code || s.languageCode).join(',') || 'none'})`);
  let u = String(sub.url).replace(/([?&])fmt=[^&]*/g, '$1').replace(/([?&])&+/g, '$1').replace(/[?&]$/, '');
  u += (u.includes('?') ? '&' : '?') + 'fmt=json3';
  const r = await fetch(u);
  if (!r.ok) throw new Error(`caption fetch HTTP ${r.status}`);
  return ((await r.json()).events || []).filter((e) => e.segs && e.segs.length);
}

// Captions WITHOUT the paid RapidAPI: yt-dlp pulls YouTube's own timed text (json3) with no stream
// fetch at all. Also reports duration + title, so RapidAPI is optional end to end.
// A cloud IP gets "Sign in to confirm you're not a bot" from yt-dlp's default client (checked from a
// Claude Code web container 2026-09-24), while the embedded and mobile-web clients still hand over the
// caption tracks. They list no downloadable formats there, so --ignore-no-formats-error keeps a
// captions-only read from failing on the format pick. --ignore-errors keeps the tracks that did land
// when YouTube throttles another one (the auto-translated `en` copy 429s while `en-orig` downloads).
// The default client stays last, for a laptop.
export const YTDLP_CAPTION_CLIENTS = ['web_embedded', 'mweb', null];

export function ytdlpCaptionArgs(env, videoId, base, { lang = 'en', client = null } = {}) {
  return ['--no-warnings', '--no-playlist', '--skip-download', '--no-simulate', '--ignore-no-formats-error', '--ignore-errors', '--write-subs', '--write-auto-subs',
    '--sub-langs', `${lang}.*,${lang}`, '--sub-format', 'json3', '--print', '%(.{duration,title,channel,description})j',
    ...(client ? ['--extractor-args', `youtube:player_client=${client}`] : []),
    ...(env.CLIP_YTDLP_COOKIES ? ['--cookies', env.CLIP_YTDLP_COOKIES] : []),
    ...(env.CLIP_YTDLP_PROXY ? ['--proxy', env.CLIP_YTDLP_PROXY] : []),
    '-o', join(base, '%(id)s'), `https://www.youtube.com/watch?v=${videoId}`];
}

/** Captions and the episode's details via yt-dlp: {events, lengthS, title, channel, description, client}. */
export async function captionsViaYtdlp(env, videoId, workDir, lang = 'en', { clients = YTDLP_CAPTION_CLIENTS, run = pExecFile } = {}) {
  const errors = [];
  for (const client of clients) {
    const base = join(workDir, `subs-${client || 'default'}`);
    mkdirSync(base, { recursive: true });
    let stdout, stderr;
    try { ({ stdout, stderr } = await run('yt-dlp', ytdlpCaptionArgs(env, videoId, base, { lang, client }), { timeout: 120000, maxBuffer: 1 << 24 })); }
    catch (e) { errors.push(`${client || 'default'}: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 160)}`); continue; }
    let meta = {};
    try { meta = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {}
    const files = readdirSync(base).filter((n) => n.endsWith('.json3'));
    // Prefer the track named exactly for the language (a manual or the primary auto track) over en-orig etc.
    const f = files.find((n) => n.endsWith(`.${lang}.json3`)) || files[0];
    if (!f) { errors.push(`${client || 'default'}: ${String(stderr || '').trim().split('\n').pop().slice(0, 160) || `no ${lang} caption track`}`); continue; }
    const events = (JSON.parse(readFileSync(join(base, f), 'utf8')).events || []).filter((e) => e.segs && e.segs.length);
    return { events, lengthS: parseFloat(meta.duration) || Infinity, title: meta.title || videoId, channel: meta.channel ?? null, description: meta.description ?? null, client };
  }
  throw new Error(`yt-dlp could not read ${lang} captions for ${videoId} (${errors.join('; ')})`);
}

// ---------------------------------------------------------------- the pick (LLM)

const PICK_SYSTEM = `You are the clip editor for a monetized X thread. You receive the thread's tweets (numbered) and a timestamped auto-transcript of the podcast the thread draws on. Choose the video windows that will be cut and attached to specific tweets.

RULES
- Return between MIN and MAX clips. Tweet 1 (the hook) MUST get one: the single most arresting passage where the speaker makes the hook's claim in their own words.
- Every other clip goes on the tweet whose SPECIFIC claim it most directly supports: the number, the mechanism, the named expert saying the thing. If nothing in the transcript supports a tweet, that tweet gets nothing. Never stretch.
- Only tweets in the ELIGIBLE list may receive a clip. Never a plug tweet, a closing, a disclaimer, or a question-to-the-reader. One clip per tweet.
- A window is ONE continuous passage of 20 to 60 seconds where the point is made cleanly: start on the first words of a sentence (or the host's short question right before it), end at the end of a sentence, never mid-thought. Windows must not overlap. Prefer the guest over the host. Prefer passages whose captions read cleanly, because they are burned in as subtitles.
- Timestamps come from the transcript lines ([HH:MM:SS]); never invent or round them. A window may start at one line's stamp and end at a later line's stamp.
- When a tweet quotes the speaker in quotation marks, the window must contain the passage where those exact words are spoken.

OUTPUT: JSON only, no prose, no fences:
{"clips":[{"tweet":1,"start":"HH:MM:SS","end":"HH:MM:SS","quote":"the first 6-10 words spoken at start","why":"one line: which claim of that tweet this proves"}]}`;

async function pickWindows(env, { posts, eligible, transcript, lengthS, min, max, title }) {
  const thread = posts.map((p, i) => `[${i + 1}]${eligible.includes(i + 1) ? '' : ' (not eligible)'}\n${p.text}`).join('\n\n');
  const user = `MIN ${min}, MAX ${max} clips.\nELIGIBLE TWEETS: ${eligible.join(', ')}\n\nTHREAD:\n${thread}\n\nPODCAST: ${title || ''} (${Math.round(lengthS / 60)} min)\nTRANSCRIPT (HH:MM:SS from the video start):\n${transcript}`;
  const r = await anthropic(env, { role: 'aux', max_tokens: 2500, system: PICK_SYSTEM, messages: [{ role: 'user', content: user }] });
  const text = typeof r === 'string' ? r
    : (r?.text ?? (Array.isArray(r?.content) ? r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : r?.choices?.[0]?.message?.content ?? ''));
  return extractJson(text);
}

// ---------------------------------------------------------------- cutting

export async function cutViaService(env, { url, clip, socialSetId, captions, watermark, captionStyle = 'pi' }) {
  const base = String(env.CLIPPER_URL).replace(/\/+$/, '');
  const r = await fetch(`${base}/clip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.CLIPPER_SERVICE_KEY || '' },
    body: JSON.stringify({ url, start: clip.start, end: clip.end, slug: clip.slug, minHeight: 1080, audioLang: 'en',
      upload: 'typefully', socialSetId: String(socialSetId), captions, captionStyle, watermark }),
    signal: AbortSignal.timeout(11 * 60 * 1000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !j.media_id) throw new Error(`clipper ${r.status}: ${j.error || JSON.stringify(j).slice(0, 200)}`);
  return { mediaId: j.media_id, quality: j.quality, warning: j.warning, source: j.stream_source };
}

/**
 * Cut on the service but keep the file: it is served on the service's /files URL (about 6h), long enough
 * for Airtable to copy it into the Clips row and for Typefully to take it. One RapidAPI call, as before.
 */
/** How long one service cut may take. 11 min by default; a run's media pass sets CLIPPER_TIMEOUT_S lower, because a
 *  clipper that cannot reach YouTube hangs every cut to the full timeout (R2026-11-21: 9 cuts, 25 min, 0 clips). */
export const serviceTimeoutMs = (envVars = process.env) => {
  const s = Number(envVars.CLIPPER_TIMEOUT_S);
  return Number.isFinite(s) && s >= 30 ? Math.round(s * 1000) : 11 * 60 * 1000;
};

export async function cutViaServiceToUrl(env, { url, clip, captions, watermark, captionStyle = 'pi' }, { fetch: fetchF = fetch, retryWaitMs = 20_000, timeoutMs = serviceTimeoutMs() } = {}) {
  const base = String(env.CLIPPER_URL).replace(/\/+$/, '');
  const call = () => fetchF(`${base}/clip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.CLIPPER_SERVICE_KEY || '' },
    body: JSON.stringify({ url, start: clip.start, end: clip.end, slug: clip.slug, minHeight: 1080, audioLang: 'en', upload: 'url', captions, captionStyle, watermark }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let r = await call();
  // a gateway error (502/503/504) is the service restarting or overloaded, not the clip: one retry after a pause
  // (IG2026-10-23 batch 1 lost a reel to a single 502)
  if ([502, 503, 504].includes(r.status)) { await new Promise((ok) => setTimeout(ok, retryWaitMs)); r = await call(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !j.file_url) throw new Error(`clipper ${r.status}: ${j.error || JSON.stringify(j).slice(0, 200)}`);
  return { fileUrl: j.file_url, fileName: j.file_name, bytes: j.bytes, quality: j.quality, warning: j.warning, source: j.stream_source };
}

/** A locally cut file onto the service's /files URL (single-use grant), so Airtable can copy it. */
export async function storeViaService(env, filePath, slug) {
  const base = String(env.CLIPPER_URL).replace(/\/+$/, '');
  const g = await fetch(`${base}/store-grant`, { method: 'POST', headers: { 'X-Service-Key': env.CLIPPER_SERVICE_KEY || '' }, signal: AbortSignal.timeout(30_000) }).then((x) => x.json()).catch(() => ({}));
  if (!g.ok || !g.token) throw new Error(`clipper store-grant: ${g.error || 'no token'}`);
  const r = await fetch(`${base}/store?token=${g.token}&slug=${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: readFileSync(filePath), signal: AbortSignal.timeout(5 * 60 * 1000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !j.file_url) throw new Error(`clipper store ${r.status}: ${j.error || 'no file_url'}`);
  return j.file_url;
}

/** Download a clip (a served cut, or a stored Clip File) and upload it to Typefully: reuse without a re-cut. */
export async function uploadFromUrl(tf, socialSetId, fileName, url, timeoutS = 600) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`download ${fileName} -> ${res.status}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !ct.startsWith('video') && !ct.includes('octet-stream')) throw new Error(`${fileName}: expected a video, got "${ct}"`);
  return uploadBytes(tf, socialSetId, fileName, Buffer.from(await res.arrayBuffer()), timeoutS);
}

export async function haveTool(bin) { try { await pExecFile(bin, ['-version']); return true; } catch { try { await pExecFile(bin, ['--version']); return true; } catch { return false; } } }

const isBotCheck = (msg) => /Sign in to confirm|not a bot|429|Too Many Requests/i.test(String(msg));

/** yt-dlp: ONLY the window's bytes (--download-sections), original English audio. Shared by the local and
 *  FilmCraft engines. `anyCodec` (FilmCraft) also accepts vp9/av1 + opus in webm when no h264 mp4 exists. */
export const YTDLP_WINDOW_FORMAT = 'bv[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a][language^=en]/bv[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]';
export const YTDLP_WINDOW_FORMAT_ANY = `${YTDLP_WINDOW_FORMAT}/bv*[height<=1080]+ba[language^=en]/bv*[height<=1080]+ba/b`;

export function ytdlpWindowArgs(env, { url, clip, out, client, anyCodec = false }) {
  return ['--no-warnings', '--no-playlist', '--no-simulate', '-q',
    ...(env.CLIP_YTDLP_COOKIES ? ['--cookies', env.CLIP_YTDLP_COOKIES] : []),
    ...(env.CLIP_YTDLP_PROXY ? ['--proxy', env.CLIP_YTDLP_PROXY] : []),
    '--extractor-args', `youtube:player_client=${client}`, '-f', anyCodec ? YTDLP_WINDOW_FORMAT_ANY : YTDLP_WINDOW_FORMAT,
    '--download-sections', `*${clip.start}-${clip.end}`, '--force-keyframes-at-cuts', ...(anyCodec ? [] : ['--merge-output-format', 'mp4']),
    '--print', 'lang=%(requested_formats.1.language)s', '-o', out, url];
}

/** Fetch the window into workDir: { raw, audioLang }. `run` is injectable (tests). */
export async function fetchWindow(env, { url, clip, workDir, anyCodec = false }, { run = pExecFile, wait = sleep } = {}) {
  const clients = (env.CLIP_YTDLP_CLIENTS || 'tv_embedded;default').split(';').map((s) => s.trim()).filter(Boolean);
  const stem = `${clip.slug}.raw`;
  const out = join(workDir, anyCodec ? `${stem}.%(ext)s` : `${stem}.mp4`);
  const found = () => (!anyCodec ? (existsSync(out) && statSync(out).size ? out : null) : readdirSync(workDir).filter((n) => n.startsWith(`${stem}.`) && !n.endsWith('.part') && statSync(join(workDir, n)).size > 0).map((n) => join(workDir, n))[0] || null);
  const clear = () => { for (const n of readdirSync(workDir)) if (n.startsWith(`${stem}.`)) rmSync(join(workDir, n), { force: true }); };
  const errors = [];
  for (const c of clients) {
    clear();
    try {
      const { stdout } = await run('yt-dlp', ytdlpWindowArgs(env, { url, clip, out, client: c, anyCodec }), { timeout: 5 * 60 * 1000, maxBuffer: 1 << 24 });
      const raw = found();
      if (!raw) throw new Error('yt-dlp produced no file');
      return { raw, audioLang: (String(stdout).match(/lang=(\S+)/) || [])[1] || '?' };
    } catch (e) {
      const msg = String(e.stderr || e.message).trim().split('\n').pop();
      errors.push(`${c}: ${msg}`);
      if (isBotCheck(msg)) { console.log(`  ⏳ YouTube bot-check on client ${c} — waiting 20s before the next client`); await wait(20000); }
    }
  }
  throw new Error(`yt-dlp could not fetch the window [${errors.join(' | ')}]`);
}

export async function cutLocal(env, { url, clip, events, captions, watermark, workDir }) {
  const { raw, audioLang } = await fetchWindow(env, { url, clip, workDir });

  const filters = [];
  let assPath = null;
  if (captions) {
    const cues = buildCues(events, clip.startS, clip.endS);
    if (cues.length) { assPath = join(workDir, `${clip.slug}.ass`); writeFileSync(assPath, buildAss(cues)); filters.push(`subtitles=filename='${assPath}':fontsdir='${join(HERE_DIR, 'fonts')}'`); }
    else console.log('  ⚠️ no caption text inside the window — clip ships uncaptioned');
  }
  if (watermark) filters.push(`drawtext=fontfile='${join(HERE_DIR, 'fonts', 'Montserrat-ExtraBold.ttf')}':text='${String(watermark).replace(/[\\':%]/g, (m) => '\\' + m)}':fontcolor=white@0.40:fontsize=44:borderw=2:bordercolor=black@0.25:x=48:y=40`);
  const out = join(workDir, `${clip.slug}.mp4`);
  if (filters.length) {
    await pExecFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { timeout: 8 * 60 * 1000 });
  } else {
    await pExecFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c', 'copy', '-movflags', '+faststart', out], { timeout: 60 * 1000 });
  }
  const { stdout: probe } = await pExecFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt:format=duration', '-of', 'csv=p=0', out]);
  if (!/h264/.test(probe) || !/aac/.test(probe) || !/yuv420p/.test(probe)) throw new Error(`format guard failed: ${probe.replace(/\n/g, ' ')}`);
  const dur = parseFloat((probe.match(/(\d+\.\d+)\s*$/) || [])[1] || '0');
  return { file: out, audioLang, height: parseInt((probe.match(/h264,\d+,(\d+)/) || [])[1] || '0', 10), durationS: dur };
}

// ---------------------------------------------------------------- FilmCraft engine (filmcraft-cli clip)
//
// The clipper service fetches the window when it is configured (its RapidAPI stream URLs are bound to the
// IP that asked for them, so only the service can download them), else yt-dlp; `filmcraft-cli clip
// <recipe.json>` does what ffmpeg + ffprobe did: burns
// the captions and the watermark, writes H.264/AAC yuv420p fast-start mp4, and reports the format. With
// word timings (YouTube auto-captions carry them) it can group 1-2 words per cue, on each spoken word.

/** The binary: FILMCRAFT_CLI, else `filmcraft-cli` on PATH. */
export const filmcraftBin = (env = {}) => env.FILMCRAFT_CLI || 'filmcraft-cli';

/** Absolute path of the FilmCraft CLI, or null when it is not there (no spawn: the CLI has no --version). */
export function findFilmcraft(env = {}, path = process.env.PATH || '') {
  const bin = filmcraftBin(env);
  const usable = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  if (/[\\/]/.test(bin)) return usable(bin) ? bin : null;
  for (const dir of String(path).split(delimiter).filter(Boolean)) if (usable(join(dir, bin))) return join(dir, bin);
  return null;
}

/** Style A, as buildAss draws it (PlayResY 1080), in FilmCraft's terms. Mirrors the ASS line exactly:
 *  Montserrat ExtraBold 58, white, box &H48000000 (black, ASS alpha 0x48 = transparency → #000000b7),
 *  bottom centre, MarginV 80 of 1080. */
export const FILMCRAFT_CAPTION_STYLE = Object.freeze({
  font: 'Montserrat ExtraBold', size: 58, color: '#ffffff', background: true,
  backgroundColor: '#000000' + (255 - 0x48).toString(16).padStart(2, '0'), outline: 0, anchor: 'bottom', margin: Math.round((80 / 1080) * 1000) / 1000,
});
/** The local drawtext watermark (white@0.40, 44px, top left: the page handle, operator 2026-11-19) in FilmCraft's terms. */
export const FILMCRAFT_WATERMARK_STYLE = Object.freeze({ font: 'Montserrat ExtraBold', size: 44, opacity: 0.4, position: 'topLeft', margin: 44 });

/** The watermark a PI clip carries: an explicit --watermark wins, --no-watermark clears it, else the page's
 *  own @handle so a reposted clip still names us (operator 2026-11-19). Pure. */
export function pageWatermark(explicit, handle, off = false) {
  if (off) return '';
  if (String(explicit || '').trim()) return String(explicit);
  const h = String(handle || '').replace(/^@/, '').trim();
  return h ? '@' + h : '';
}

/** True when the json3 events inside [startS, endS) carry per-word timings (auto-captions: several segs
 *  with tOffsetMs). Manual tracks put a whole line in one seg with no offset. Pure. */
export function hasWordTimings(events, startS = 0, endS = Infinity) {
  const t0 = startS * 1000, t1 = endS * 1000;
  return (events || []).some((e) => e.tStartMs != null && e.tStartMs < t1 && e.tStartMs + (e.dDurationMs || 0) > t0
    && (e.segs || []).some((g, i) => i > 0 && g.tOffsetMs != null));
}

const wordKey = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * Spoken words inside the window, in seconds relative to the window start (the downloaded file's 0),
 * cleaned and capitalised the way the ASS path cleans its cues: sound tags, speaker marks, fillers and
 * stutters go; sentence capitals and the pronoun I come back. A word ends where the next one starts,
 * never after its caption event ends. Pure.
 */
export function buildWords(events, startS, endS) {
  const raw = [];
  for (const e of events || []) {
    if (e.tStartMs == null || !e.segs) continue;
    const eventEnd = e.tStartMs + (e.dDurationMs || 0);
    for (const g of e.segs) {
      const at = e.tStartMs + (g.tOffsetMs || 0);
      const text = String(g.utf8 || '').replace(/\[[^\]]*\]/g, ' ');
      for (const tok of text.split(/\s+/).filter(Boolean)) raw.push({ at, eventEnd, tok });
    }
  }
  raw.sort((a, b) => a.at - b.at);
  const t0 = startS * 1000, t1 = endS * 1000;
  const words = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r.at < t0 || r.at >= t1) continue;
    const text = cleanCaption(r.tok);
    if (!text || !/[A-Za-z0-9]/.test(text)) continue;
    let j = i + 1;
    while (j < raw.length && raw[j].at <= r.at) j++;
    const next = raw[j];
    let end = Math.min(next ? next.at : r.eventEnd, r.eventEnd > r.at ? r.eventEnd : Infinity, t1);
    if (!Number.isFinite(end) || end <= r.at) end = r.at + 300;
    const prev = words[words.length - 1];
    // "never never sleep" -> "never sleep": one word, shown for both
    if (prev && wordKey(prev.text) === wordKey(text) && !/[.!?,]$/.test(prev.text)) { prev.text = text; prev.end = (end - t0) / 1000; continue; }
    words.push({ start: (r.at - t0) / 1000, end: (end - t0) / 1000, text });
  }
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    if (w.end > words[i + 1].start) w.end = words[i + 1].start;
    if (w.end <= w.start) w.end = w.start + 0.01; // two tokens on one offset: keep both, shortest span
  }
  for (const w of words) { w.start = Math.round(w.start * 1000) / 1000; w.end = Math.round(w.end * 1000) / 1000; }
  return capitalizeCues(words);
}

/** --caption-words N, --caption-max-chars N, --caption-max-seconds S → recipe caption fields. Pure. */
export function captionOptsFromArgs(val) {
  const out = {};
  const num = (name, key, { int = false, min = 0 } = {}) => {
    const v = val(name);
    if (v == null || v === '' || v === true) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= min || (int && !Number.isInteger(n))) throw new Error(`--${name} must be ${int ? 'a whole number' : 'a number'} above ${min} (got ${v})`);
    out[key] = n;
  };
  num('caption-words', 'wordsPerCue', { int: true });
  num('caption-max-chars', 'maxChars', { int: true });
  num('caption-max-seconds', 'maxSeconds');
  const text = (name, key) => {
    const v = val(name);
    if (v == null || v === '') return;
    if (v === true || !String(v).trim()) throw new Error(`--${name} needs a value`);
    out[key] = String(v).trim();
  };
  text('caption-preset', 'preset');
  text('caption-presets', 'presetsFile');
  if (out.presetsFile && !out.preset) throw new Error('--caption-presets needs --caption-preset NAME (which preset to use)');
  return out;
}
export const FILMCRAFT_ONLY_FLAGS = ['caption-words', 'caption-max-chars', 'caption-max-seconds', 'caption-preset', 'caption-presets'];
/** The project's FilmCraft caption presets (one per kind of video; `filmcraft-cli exec captionPresets.list` shows all). */
export const CAPTION_PRESETS_FILE = join(HERE_DIR, 'filmcraft-caption-presets.json');

/**
 * The `filmcraft-cli clip` recipe for one downloaded window. `source` is the raw window file (its 0 is
 * clip.startS); captions are words when the captions carry word timings, else today's cues; `transcribe`
 * asks FilmCraft's own Whisper when the caller has no timings at all (segment transcripts). `words`, when the
 * caller heard them in the window's own audio ({start, end, text}, seconds from the file's 0), win over both. Pure.
 */
/**
 * How far heard captions lead the voice, in seconds. Whisper's word starts land about 0.1 s after the voice begins
 * (median over LR-2026-10-26-2: +0.12 s, most between -0.1 and +0.3 s; owner 2026-10-23 "Is our caption appearing
 * exactly when it is spoken yet?"), and captions read best a touch before the word, so each word starts this much
 * earlier. Ends stay, so a caption never clears before its last word is said.
 */
export const CAPTION_LEAD_S = 0.1;

/** Heard words starting `lead` seconds earlier (never before 0). Pure. */
export const leadWords = (words, lead = CAPTION_LEAD_S) =>
  words.map((w) => ({ ...w, start: Math.max(0, Math.round((Number(w.start) - lead) * 1000) / 1000) }));

export function buildFilmcraftRecipe({ source, out, clip, events = [], captions = true, transcribe = false, watermark = '', captionOpts = {}, fontsDir = join(HERE_DIR, 'fonts'), presetsFile = CAPTION_PRESETS_FILE, vertical = false, words: heard = null }) {
  const { presetsFile: givenPresets, ...capOpts } = captionOpts;
  // The file's 0 is where yt-dlp cut: the section string, which is the window rounded to a tenth.
  const t0 = Number.isFinite(toSec(clip.start)) ? toSec(clip.start) : clip.startS;
  const t1 = Number.isFinite(toSec(clip.end)) ? toSec(clip.end) : clip.endS;
  const dur = Math.round((t1 - t0) * 1000) / 1000;
  const recipe = { source, start: 0, end: dur, out, fonts: [fontsDir] };
  let mode = 'none';
  if (captions) {
    let cap = null;
    if (heard?.length) { cap = { words: leadWords(heard) }; mode = 'heard'; }
    if (!cap && hasWordTimings(events, t0, t1)) {
      const words = buildWords(events, t0, t1);
      if (words.length) { cap = { words }; mode = 'words'; }
    }
    if (!cap) {
      const cues = buildCues(events, t0, t1).map((c) => ({ start: c.start / 1000, end: c.end / 1000, text: c.text }));
      if (cues.length) { cap = { cues }; mode = 'cues'; }
    }
    if (!cap && transcribe) { cap = { transcribe: true }; mode = 'transcribe'; }
    // a preset brings its own look and place; without one, Style A
    if (cap) recipe.captions = capOpts.preset ? { ...cap, ...capOpts } : { ...cap, ...capOpts, style: { ...FILMCRAFT_CAPTION_STYLE } };
    if (cap && capOpts.preset) {
      const file = givenPresets || presetsFile;
      if (file && (givenPresets || existsSync(file))) recipe.captionPresets = file;
    }
  }
  // a string takes the house style (top right); an object ({text, position, size, opacity, …}) overrides it
  if (watermark && typeof watermark === 'object') { if (String(watermark.text || '').trim()) recipe.watermark = { ...FILMCRAFT_WATERMARK_STYLE, ...watermark, text: String(watermark.text) }; }
  else if (watermark) recipe.watermark = { text: String(watermark), ...FILMCRAFT_WATERMARK_STYLE };
  recipe.vertical = vertical; // false keeps the source frame; "speaker" reframes to 9:16 on whoever talks (IG reels)
  return { recipe, mode };
}

/** Run `filmcraft-cli clip <recipe>` and hold its result to the format guard. Pure of side effects
 *  beyond the run; `run` is injectable. */
export async function runFilmcraftClip(env, recipePath, { run = pExecFile } = {}) {
  // CLIPS_ON=modal: the same FilmCraft renders on Modal (tools/clipgpu); any failure there falls back to the
  // local binary, so a batch never waits on the cloud
  if (env.CLIPS_ON === 'modal') {
    try {
      const { stdout } = await run('python3', [join(HERE_DIR, 'tools/clipgpu/clipgpu.py'), 'clip', recipePath],
        { timeout: 20 * 60 * 1000, maxBuffer: 1 << 26, env: { ...process.env, ...env } });
      const text = String(stdout).trim();
      return JSON.parse(text.slice(Math.max(0, text.search(/^\{/m))));
    } catch (e) {
      console.log(`  ⚠️ FilmCraft on Modal failed (${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200)}) — rendering here`);
    }
  }
  const bin = filmcraftBin(env);
  let stdout;
  try { ({ stdout } = await run(bin, ['clip', recipePath], { timeout: 10 * 60 * 1000, maxBuffer: 1 << 24 })); }
  catch (e) {
    const why = e.code === 'ENOENT' ? `${bin} not found (set FILMCRAFT_CLI or put filmcraft-cli on PATH)`
      : `exit ${e.code ?? '?'}${e.code === 2 ? ' (bad usage)' : ''}: ${String(e.stderr || String(e.message).replace(/^Command failed: [^\n]*\n?/, '')).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`;
    throw new Error(`filmcraft-cli clip failed — ${why}`);
  }
  let result;
  // filmcraft-cli pretty-prints its result; a single-line result after log lines works too
  const text = String(stdout).trim();
  try { result = JSON.parse(text.slice(Math.max(0, text.search(/^\{/m)))); }
  catch { throw new Error(`filmcraft-cli clip printed no JSON result: ${String(stdout).slice(0, 200)}`); }
  return result;
}

/** The FilmCraft result against the clip contract (what ffprobe checked on the local path). Pure. */
export function filmcraftFormatGuard(r) {
  const bad = [];
  if (r?.video !== 'h264') bad.push(`video ${r?.video}`);
  if (r?.audio !== 'aac') bad.push(`audio ${r?.audio}`);
  if (r?.pixelFormat !== 'yuv420p') bad.push(`pixel format ${r?.pixelFormat}`);
  if (r?.fastStart !== true) bad.push('not fast start');
  if (!r?.path) bad.push('no path');
  if (bad.length) throw new Error(`format guard failed: ${bad.join(', ')}`);
}

const isServiceReady = (env) => !!(env.CLIPPER_URL && env.CLIPPER_SERVICE_KEY);

/** The raw window from the clipper service: no captions, no watermark (FilmCraft adds both), downloaded
 *  from its /files URL into the work dir. Same contract as fetchWindow ({raw, audioLang}). */
export async function fetchWindowViaService(env, { url, clip, workDir }, { fetch: fetchF = fetch, retryWaitMs } = {}) {
  const r = await cutViaServiceToUrl(env, { url, clip, captions: false, watermark: '' }, { fetch: fetchF, retryWaitMs });
  const res = await fetchF(r.fileUrl, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`clipper file download -> ${res.status}`);
  const raw = join(workDir, `${clip.slug}.raw.mp4`);
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  if (!statSync(raw).size) throw new Error('clipper served an empty file');
  if (r.warning) console.log(`  ⚠️ ${r.warning}`);
  return { raw, audioLang: 'en', source: `service ${r.source || ''}`.trim() };
}

/** The FilmCraft engine's window: the clipper service first when it is configured, yt-dlp when it is not
 *  or when the service fails and yt-dlp is installed. */
export async function fetchFilmcraftWindow(env, opts, { run = pExecFile, fetch: fetchF = fetch, have = haveTool, retryWaitMs } = {}) {
  if (isServiceReady(env)) {
    try { return await fetchWindowViaService(env, opts, { fetch: fetchF, retryWaitMs }); }
    catch (e) {
      if (!(await have('yt-dlp'))) throw e;
      console.log(`  ✗ clipper service fetch failed (${String(e.message).slice(0, 160)}) — trying yt-dlp`);
    }
  }
  return fetchWindow(env, { ...opts, anyCodec: true }, { run });
}

/**
 * The FilmCraft engine: the service (or yt-dlp) fetches the window, FilmCraft burns and formats it. Same contract as
 * cutLocal ({file, audioLang, height, durationS}) plus captions (cue count) and mode (words|cues|…).
 */
// `prepare(raw) -> path`: a step on the fetched window before FilmCraft cuts it (the IG Run's shot-by-shot reframe).
export async function cutFilmcraft(env, { url, clip, events, captions, transcribe = false, watermark, workDir, captionOpts = {}, vertical = false, prepare = null, hear = null }, { run = pExecFile, fetch: fetchW = fetchFilmcraftWindow } = {}) {
  const fetched = await fetchW(env, { url, clip, workDir, anyCodec: true }, { run });
  const { audioLang } = fetched;
  // `hear(raw)` -> word timings heard in the window's audio (or null): runs beside `prepare`, on the fetched file
  const [raw, words] = await Promise.all([prepare ? prepare(fetched.raw) : fetched.raw, captions && hear ? hear(fetched.raw) : null]);
  const out = join(workDir, `${clip.slug}.mp4`);
  const { recipe, mode } = buildFilmcraftRecipe({ source: raw, out, clip, events, captions, transcribe, watermark, captionOpts, vertical, words });
  if (captions && mode === 'none') console.log('  ⚠️ no caption text inside the window — clip ships uncaptioned');
  if (mode === 'cues' && captionOpts.wordsPerCue) console.log('  ⚠️ these captions have no word timings (a manual track) — --caption-words cannot apply, captions use the track\'s own lines');
  const recipePath = join(workDir, `${clip.slug}.recipe.json`);
  writeFileSync(recipePath, JSON.stringify(recipe, null, 1));
  const r = await runFilmcraftClip(env, recipePath, { run });
  filmcraftFormatGuard(r);
  if (!existsSync(r.path) || !statSync(r.path).size) throw new Error(`filmcraft-cli reported ${r.path} but there is no file`);
  return { file: r.path, audioLang, height: Number(r.height) || 0, durationS: Number(r.durationS) || 0, captions: r.captions ?? 0, mode };
}

/** What --engine filmcraft needs, as one clear error (null when ready). With the clipper service set, the
 *  service fetches and yt-dlp is optional; without it, yt-dlp's --download-sections runs ffmpeg to fetch
 *  only the window, so ffmpeg stays a downloader dependency. */
export async function filmcraftMissing(env, { have = haveTool, find = findFilmcraft } = {}) {
  const miss = [];
  if (!find(env)) miss.push(`the FilmCraft CLI (${filmcraftBin(env)}: set FILMCRAFT_CLI or put filmcraft-cli on PATH)`);
  if (isServiceReady(env)) { /* the service fetches */ }
  else if (!(await have('yt-dlp'))) miss.push('yt-dlp (brew install yt-dlp), or CLIPPER_URL + CLIPPER_SERVICE_KEY so the clipper service fetches');
  else if (!(await have('ffmpeg'))) miss.push('ffmpeg (yt-dlp needs it to fetch only the window: brew install ffmpeg)');
  return miss.length ? `--engine filmcraft needs ${miss.join(' and ')}` : null;
}

export async function uploadAndWait(tf, socialSetId, fileName, filePath, timeoutS = 600) {
  return uploadBytes(tf, socialSetId, fileName, readFileSync(filePath), timeoutS);
}
/** Bytes -> a Typefully upload session -> PUT -> ready. The one upload path for local and stored files. */
export async function uploadBytes(tf, socialSetId, fileName, bytes, timeoutS = 600) {
  const { media_id, upload_url } = await tf.createMediaUpload(socialSetId, fileName);
  const put = await fetch(upload_url, { method: 'PUT', body: bytes, signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!(put.status === 200 || put.status === 204)) throw new Error(`S3 PUT -> ${put.status}`);
  return waitReady(tf, socialSetId, media_id, timeoutS);
}
export async function waitReady(tf, socialSetId, mediaId, timeoutS = 600) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const st = String((await tf.getMediaStatus(socialSetId, mediaId)).status || '').toLowerCase();
    if (st === 'ready') return mediaId;
    if (st === 'failed' || st === 'error') throw new Error(`media ${mediaId} failed processing`);
    await sleep(5000);
  }
  throw new Error(`media ${mediaId} not ready after ${timeoutS}s`);
}

// ---------------------------------------------------------------- draft resolution

export async function resolveDraft(env, tf, ref, accountKey) {
  const parsed = parseDraftRef(ref);
  if (!parsed) throw new Error(`cannot read a draft from "${ref}" (want typefully.com/t/…, ?d=…&a=…, or a draft id)`);
  let draftId = parsed.draftId, socialSetId = parsed.socialSetId, username = null;
  if (parsed.share) {
    const html = await (await fetch(`https://typefully.com/t/${parsed.share}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    draftId = Number((html.match(/"draft_id":(\d+)/) || html.match(/"id":(\d{6,10})/) || [])[1]);
    username = (html.match(/"username":"([^"]+)"/) || [])[1] || null;
    if (!draftId) throw new Error(`share page ${parsed.share} did not expose a draft id (is the share link live?)`);
  }
  if (accountKey) socialSetId = (ACCOUNTS[accountKey] || {}).socialSetId || socialSetId;
  if (!socialSetId && username) {
    const acc = Object.values(ACCOUNTS).find((a) => String(a.handle || '').toLowerCase() === username.toLowerCase());
    if (acc) socialSetId = acc.socialSetId;
  }
  if (!socialSetId && username) { // not a fleet account: ask Typefully which social set carries that handle
    for (let offset = 0; offset < 500; offset += 50) {
      const page = await tf.get(`/social-sets?limit=50&offset=${offset}`);
      const hit = (page.results || []).find((s) => String(s.username || '').toLowerCase() === username.toLowerCase());
      if (hit) { socialSetId = hit.id; break; }
      if (!page.next) break;
    }
  }
  if (!socialSetId) throw new Error(`cannot tell which social set owns draft ${draftId} — pass --account <key>`);
  const account = Object.values(ACCOUNTS).find((a) => a.socialSetId === Number(socialSetId)) || null;
  return { draftId, socialSetId: Number(socialSetId), username, account };
}

// ---------------------------------------------------------------- main

export const ENGINES = ['service', 'local', 'filmcraft'];
/** The caption flags drive FilmCraft's cue builder; the other engines would silently ignore them. */
export function assertFilmcraftFlags(engine, captionOpts) {
  if (engine !== 'filmcraft' && Object.keys(captionOpts || {}).length) {
    throw new Error(`--${FILMCRAFT_ONLY_FLAGS.join(', --')} work with --engine filmcraft only (this run uses ${engine})`);
  }
}

export async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const draftRef = cliArg('draft'), video = cliArg('video');
  if (!draftRef || !video) throw new Error('usage: node clip-thread.mjs --draft <typefully link|id> --video <youtube url> [--dry]');
  const DRY = process.argv.includes('--dry');
  const captions = !process.argv.includes('--no-captions');
  const replace = process.argv.includes('--replace');
  const cap = CLIP_RULES.perThread.maxVideos;
  const [minC, maxC] = (() => { const s = String(cliArg('clips', String(cap))); const m = s.match(/^(\d+)(?:-(\d+))?$/); return m ? [Number(m[1]), Number(m[2] || m[1])] : [cap, cap]; })();
  if (maxC > cap) throw new Error(`--clips ${minC}-${maxC}: a thread carries at most ${cap} videos (CLIP_RULES.perThread.maxVideos)`);
  const minS = Number(cliArg('min', 20)), maxS = Number(cliArg('max', 60));
  const serviceReady = !!(env.CLIPPER_URL && env.CLIPPER_SERVICE_KEY);
  let engine = cliArg('engine', serviceReady ? 'service' : 'local');
  if (!ENGINES.includes(engine)) throw new Error(`--engine ${engine}: one of ${ENGINES.join(', ')}`);
  if (engine === 'service' && !serviceReady) throw new Error('--engine service needs CLIPPER_URL and CLIPPER_SERVICE_KEY in .env');
  const captionOpts = captionOptsFromArgs((name) => cliArg(name));
  assertFilmcraftFlags(engine, captionOpts);
  const tf = typefully(env);

  const videoId = videoIdOf(video);
  if (!videoId) throw new Error(`no YouTube video id in ${video}`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const { draftId, socialSetId, username, account } = await resolveDraft(env, tf, draftRef, cliArg('account'));
  const watermark = pageWatermark(cliArg('watermark', ''), account?.handle || username, process.argv.includes('--no-watermark'));
  const draft = await tf.getDraft(socialSetId, draftId);
  const posts = draft?.platforms?.x?.posts || [];
  if (!posts.length) throw new Error(`draft ${draftId} has no X posts`);
  console.log(`Draft ${draftId} (${username || account?.handle || socialSetId}): ${posts.length} tweets, status ${draft.status}${draft.scheduled_date ? ' @ ' + draft.scheduled_date : ''}`);

  const workDir = join(tmpdir(), `clip-thread-${draftId}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  // Transcript: RapidAPI when a key exists (one call, cached 4h on their side), else yt-dlp's own
  // caption pull — the paid API is optional, not required.
  let details = null, events, lengthS = Infinity, title = videoId;
  if (env.RAPIDAPI_KEY) {
    try { details = await fetchVideoDetails(env, videoId); }
    catch (e) { console.log(`  ⚠️ RapidAPI details failed (${String(e.message).slice(0, 120)}) — reading captions with yt-dlp`); }
  }
  if (details) {
    lengthS = Number(details.lengthSeconds) || Infinity; title = details.title || videoId;
    try { events = await fetchCaptionEvents(details, 'en'); }
    catch (e) { console.log(`  ⚠️ ${String(e.message).slice(0, 120)} — trying yt-dlp for captions`); }
  }
  if (!events) {
    if (!(await haveTool('yt-dlp'))) throw new Error('no usable RAPIDAPI_KEY and no yt-dlp on PATH — cannot read the podcast captions');
    ({ events, lengthS, title } = await captionsViaYtdlp(env, videoId, workDir));
  }
  const lines = transcriptLines(events);
  console.log(`Podcast: ${title} — ${Number.isFinite(lengthS) ? Math.round(lengthS / 60) + ' min' : 'length unknown'}, ${lines.length} caption lines`);

  const eligible = eligibleTweets(posts, account);
  let plan;
  const planFile = cliArg('plan');
  if (planFile) plan = JSON.parse(readFileSync(planFile, 'utf8'));
  else {
    console.log(`Picking ${minC}-${maxC} windows (eligible tweets: ${eligible.join(', ')})…`);
    plan = await pickWindows(env, { posts, eligible, transcript: lines.join('\n'), lengthS, min: minC, max: maxC, title });
  }
  const checked = validatePlan(plan, { posts, account, lengthS, min: minC, max: maxC, minS, maxS, videoId });
  const anchoredPlan = process.argv.includes('--no-anchor')
    ? { clips: checked.clips, notes: [], errors: [] }
    : anchorPlan(checked.clips, posts, events, { minS, maxS, lengthS });
  const clips = anchoredPlan.clips;
  const errors = [...checked.errors, ...anchoredPlan.errors], notes = [...checked.notes, ...anchoredPlan.notes];
  for (const n of notes) console.log(`  ℹ️ ${n}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log('\nPLAN');
  for (const c of clips) console.log(`  tweet ${c.tweet}  ${c.start}–${c.end} (${Math.round(c.endS - c.startS)}s)${c.anchored ? '  ⚓ quote' : ''}  ${c.why || c.quote}`);
  const planPath = join(tmpdir(), `clip-thread-${draftId}.plan.json`);
  writeFileSync(planPath, JSON.stringify({ draft: draftRef, video: url, clips: clips.map(({ tweet, start, end, quote, why, slug }) => ({ tweet, start, end, quote, why, slug })) }, null, 2));
  console.log(`  plan written to ${planPath} (edit it and re-run with --plan)`);
  if (errors.length) throw new Error(`plan rejected: ${errors.join('; ')}`);
  if (DRY) { rmSync(workDir, { recursive: true, force: true }); console.log('(dry run — nothing cut)'); return; }

  if (engine === 'local' && !(await haveTool('yt-dlp') && await haveTool('ffmpeg'))) throw new Error('local engine needs yt-dlp and ffmpeg on PATH (brew install yt-dlp ffmpeg)');
  if (engine === 'filmcraft') { const miss = await filmcraftMissing(env); if (miss) throw new Error(miss); }

  const attached = [];
  for (const [i, clip] of clips.entries()) {
    if (i) await sleep(3000); // one download at a time, with a gap — a burst trips YouTube's bot check
    console.log(`\n▶ tweet ${clip.tweet}: ${clip.start}–${clip.end} via ${engine}`);
    let mediaId;
    try {
      if (engine === 'service') {
        const r = await cutViaService(env, { url, clip, socialSetId, captions, watermark });
        if (r.warning) console.log(`  ⚠️ ${r.warning}`);
        mediaId = await waitReady(tf, socialSetId, r.mediaId);
        console.log(`  ✓ ${r.quality || ''} ${r.source || ''} → media ${mediaId.slice(0, 8)}…`);
      } else if (engine === 'filmcraft') {
        const r = await cutFilmcraft(env, { url, clip, events, captions, watermark, workDir, captionOpts });
        console.log(`  ✓ FilmCraft ${r.height}p, ${r.durationS.toFixed(1)}s, audio ${r.audioLang}, ${r.captions} caption cue(s) from ${r.mode} — uploading`);
        mediaId = await uploadAndWait(tf, socialSetId, `${clip.slug}.mp4`, r.file);
        console.log(`  ✓ media ${mediaId.slice(0, 8)}… ready`);
      } else {
        const r = await cutLocal(env, { url, clip, events, captions, watermark, workDir });
        console.log(`  ✓ cut ${r.height}p, ${r.durationS.toFixed(1)}s, audio ${r.audioLang} — uploading`);
        mediaId = await uploadAndWait(tf, socialSetId, `${clip.slug}.mp4`, r.file);
        console.log(`  ✓ media ${mediaId.slice(0, 8)}… ready`);
      }
    } catch (e) {
      if (engine === 'service' && await haveTool('yt-dlp') && await haveTool('ffmpeg')) {
        console.log(`  ✗ service failed (${String(e.message).slice(0, 160)}) — falling back to the local engine for the rest`);
        engine = 'local';
        const r = await cutLocal(env, { url, clip, events, captions, watermark, workDir });
        mediaId = await uploadAndWait(tf, socialSetId, `${clip.slug}.mp4`, r.file);
        console.log(`  ✓ media ${mediaId.slice(0, 8)}… ready (local)`);
      } else throw e;
    }
    attached.push({ index: clip.tweet - 1, mediaId, clip });
  }

  const fresh = await tf.getDraft(socialSetId, draftId); // re-read: the operator may have edited text meanwhile
  const { posts: patched, skipped } = attachPlanToPosts(fresh.platforms.x.posts, attached, { replace });
  for (const s of skipped) console.log(`  ⚠️ ${s}`);
  const platformPosts = mediaAcrossPlatforms(patched, fresh.platforms);
  await tf.patchDraft(socialSetId, draftId, { platforms: buildPlatforms(patched, { existing: fresh.platforms, account, platformPosts }) });
  rmSync(workDir, { recursive: true, force: true });
  console.log(`\n✓ ${attached.length - skipped.length} clip(s) attached to draft ${draftId} — ${fresh.share_url || draft.share_url || ''}`);
  for (const a of attached) console.log(`  tweet ${a.clip.tweet}: ${a.clip.start}–${a.clip.end}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
