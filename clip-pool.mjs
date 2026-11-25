// clip-pool.mjs — the podcast pool and the clip library, stored in their OWN Airtable base (operator
// 2026-09-23: "a separated Base"). Jev-native from the start: a podcast enters the pool with its
// transcript attached and a Jev fit score; mining writes every Jev answer as its own field on each
// clip, with the question-set hash and the answering build, so a clip is a stored judgment that
// MATCH can re-rank and an operator can label.
//
//   Podcasts  one row per episode: identity, the transcript (a JSON attachment), fit, mining stats.
//   Clips     one row per clip: window, text, every Jev score, verdict, media per account, uses,
//             and an Operator Label, the ground truth that calibrates CLIP_RULES.
//
// The questions and rules live in clip-judge.mjs; this file is the storage and the transcript.
// CLIP_BASE_SCHEMA is the reviewable definition of the base; `node scripts/clip-pool.mjs setup`
// creates exactly this and nothing else.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choice, noul } from './jev.mjs';
import { questionSetHash } from './swipe-classify.mjs';
import { CLIPS_BASE, TABLES } from './config.mjs';
import { liveUses, mergeRecord } from './clip-library.mjs';

// ---- Schema -----------------------------------------------------------------------------------------
const num = (precision) => ({ type: 'number', options: { precision } });
const when = { type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } };
const select = (...names) => ({ type: 'singleSelect', options: { choices: names.map((name) => ({ name })) } });
const text = { type: 'singleLineText' };
const long = { type: 'multilineText' };

// 'In Pool' = transcript attached, searchable by every MATCH and open to more mining; a podcast is never
// "done" (operator 2026-09-24). Mining is recorded in Mined At / Clips Found, not in the status.
export const PODCAST_STATUS = ['New', 'In Pool', 'Error'];
export const IN_POOL = new Set(['In Pool', 'Transcribed', 'Mined']); // the two older statuses read as In Pool
export const OPERATOR_LABELS = ['Good', 'Bad start', 'Bad end', 'Weak claim', 'Off topic', 'Needs context'];

export const CLIP_BASE_SCHEMA = {
  name: 'Clip Library',
  tables: [
    { name: 'Podcasts', description: 'The podcast pool: one row per episode, transcript attached, mined by Jev (clip-pool.mjs).', fields: [
      { name: 'Video ID', ...text },
      { name: 'Title', ...text },
      { name: 'Channel', ...text },
      { name: 'URL', type: 'url' },
      { name: 'Length Sec', ...num(0) },
      { name: 'Status', ...select(...PODCAST_STATUS) },
      { name: 'Fit', ...num(2), description: 'Jev: P(this episode is about the focus), from title, channel and description' },
      { name: 'Focus', ...long },
      { name: 'Transcript', type: 'multipleAttachments', options: { isReversed: false } },
      { name: 'Caption Track', ...text },
      { name: 'Segments', ...num(0) },
      { name: 'Windows Judged', ...num(0) },
      { name: 'Clips Found', ...num(0) },
      { name: 'Question Set Hash', ...text },
      { name: 'Model', ...text },
      { name: 'Added At', ...when },
      { name: 'Mined At', ...when },
      { name: 'Error', ...long },
    ] },
    { name: 'Clips', description: 'Clips Jev found, each a stored judgment (clip-judge.mjs CLIP_QUESTIONS). Label them to calibrate.', fields: [
      { name: 'Clip ID', ...text },
      { name: 'Source Title', ...text },
      { name: 'Watch URL', type: 'url' },
      { name: 'Start', ...num(1) },
      { name: 'End', ...num(1) },
      { name: 'Duration', ...num(1) },
      // Single select so it filters and groups (operator 2026-09-24); writes typecast, so a new name adds its option.
      { name: 'Speaker', type: 'singleSelect', options: { choices: [] } },
      { name: 'Text', ...long },
      { name: 'Verdict', ...select('clip', 'maybe') },
      { name: 'Rank', ...num(2) },
      { name: 'Claim', ...num(2) },
      { name: 'Arguable', ...num(2) },
      { name: 'Self Contained', ...num(2) },
      { name: 'Single Point', ...num(2) },
      { name: 'Clean Start', ...num(2) },
      { name: 'Clean End', ...num(2) },
      { name: 'Ad Read', ...num(2) },
      { name: 'Focus', ...num(2) },
      { name: 'Question Set Hash', ...text },
      { name: 'Model', ...text },
      { name: 'Added At', ...when },
      { name: 'Media', ...long, description: 'JSON: Typefully social set id -> media id' },
      { name: 'Clip File', type: 'multipleAttachments', options: { isReversed: false }, description: 'The cut mp4, stored at the first cut: later placements upload this file instead of re-cutting' },
      { name: 'Uses', ...long, description: 'JSON: [{socialSetId, draftId, tweet, at}]' },
      { name: 'Times Used', ...num(0) },
      { name: 'Last Used', ...when },
      { name: 'Operator Label', ...select(...OPERATOR_LABELS) },
      { name: 'Notes', ...long },
    ] },
    { name: 'Swipe Media', description: 'Swipe-DB media placed on our drafts by scripts/media-find.mjs (swipe-media.mjs). One row per swipe tweet whose media we used.', fields: [
      { name: 'Swipe Rec ID', ...text },
      { name: 'Media Key', ...text, description: 'The media file itself (reposts share it): the 30-day block applies per key' },
      { name: 'Tweet URL', type: 'url' },
      { name: 'Text', ...long },
      { name: 'Media Type', ...select('video', 'images') },
      { name: 'Items', ...num(0) },
      { name: 'Same Point', ...num(2), description: 'Jev P(same point) at the last placement' },
      { name: 'Media', ...long, description: 'JSON: Typefully social set id -> media id(s)' },
      { name: 'Uses', ...long, description: 'JSON: [{socialSetId, draftId, tweet, at}]' },
      { name: 'Times Used', ...num(0) },
      { name: 'Last Used', ...when },
      { name: 'Operator Label', ...select('Good', 'Wrong topic', 'Low quality', 'Meme') },
      { name: 'Notes', ...long },
    ] },
  ],
  // Added after both tables exist (a link needs the other table's id).
  links: [{ table: 'Clips', name: 'Podcast', linkedTable: 'Podcasts' }],
};

// ---- Transcript: YouTube caption events -> sentence segments ---------------------------------------
const eventText = (e) => (e.segs || []).map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();

/**
 * Caption events (YouTube json3) -> sentence-like segments {start, end, text}, in seconds. Consecutive
 * events are joined until a sentence ends ([.?!]), the speech pauses (gapS), or a segment reaches maxS.
 * Manual captions carry punctuation and break cleanly; auto captions fall back to pauses and maxS. A
 * leading "- " (the caption convention for a new speaker) always starts a new segment. Pure.
 */
export function segmentsFromCaptionEvents(events, { gapS = 1.5, maxS = 20 } = {}) {
  const out = [];
  let cur = null;
  for (const e of events || []) {
    const t = eventText(e);
    if (e.tStartMs == null || !t) continue;
    const start = e.tStartMs / 1000, end = (e.tStartMs + (e.dDurationMs || 0)) / 1000;
    const newSpeaker = /^-\s/.test(t);
    if (cur && (newSpeaker || start - cur.end > gapS || end - cur.start > maxS)) { out.push(cur); cur = null; }
    const clean = t.replace(/^-\s+/, '');
    if (!cur) cur = { start, end, text: clean };
    else { cur.end = Math.max(cur.end, end); cur.text += ' ' + clean; }
    if (/[.?!]["”']?$/.test(clean)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

/** What the Transcript attachment holds: identity plus the raw caption events (word timings kept). Pure. */
export function transcriptFile({ videoId, title, lengthSeconds, track, events }) {
  return { v: 1, videoId, title, lengthSeconds, track, events: (events || []).filter((e) => e.segs?.length)
    .map((e) => ({ tStartMs: e.tStartMs, dDurationMs: e.dDurationMs || 0, segs: e.segs.map((s) => ({ utf8: s.utf8, ...(s.tOffsetMs ? { tOffsetMs: s.tOffsetMs } : {}) })) })) };
}

// ---- Jev at the door: does this episode fit the focus? ---------------------------------------------
export const poolFitQuestions = (focus) => ({
  fit: noul(`Judging by \`title\`, \`channel\` and \`description\`, is this podcast episode likely to contain substantial discussion of ${focus}?`, {
    true: `A meaningful part of the episode is plausibly about ${focus}: the guest, the title or the description points to it.`,
    false: `The episode is mainly about something else; ${focus} is absent or only a passing mention.`,
  }),
  format: choice('What kind of video is this?', {
    conversation: 'A podcast or interview: two or more people talking at length.',
    monologue: 'One person speaking at length: a lecture, solo episode or talk.',
    other: 'Something else: a short clip, compilation, music, news segment or trailer.',
  }),
});
export const poolState = ({ title, channel, description }) => ({ title, channel, description: String(description || '').slice(0, 1500) });
export const poolFitHash = (focus) => questionSetHash(poolFitQuestions(focus));

// ---- Clip rows <-> library records (clip-library.mjs shape) ------------------------------------------
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** A library record -> Clips row fields. Pure. */
export function clipFields(rec) {
  const s = rec.scores || {};
  const uses = rec.uses || [];
  const last = uses.map((u) => u.at).filter(Boolean).sort().pop() || null;
  return {
    'Clip ID': rec.id, ...(rec.source.id ? { Podcast: [rec.source.id] } : {}), 'Source Title': rec.source.title ?? null,
    'Watch URL': rec.source.url ? `${rec.source.url}${rec.source.url.includes('?') ? '&' : '?'}t=${Math.floor(rec.start)}s` : null,
    Start: Math.round(rec.start * 10) / 10, End: Math.round(rec.end * 10) / 10, Duration: Math.round((rec.end - rec.start) * 10) / 10,
    Speaker: rec.speaker ?? null, Text: rec.text, Verdict: rec.verdict ?? null, Rank: r2(rec.rank),
    Claim: r2(s.claim), Arguable: r2(s.arguable), 'Self Contained': r2(s.self_contained), 'Single Point': r2(s.single_point),
    'Clean Start': r2(s.clean_start), 'Clean End': r2(s.clean_end), 'Ad Read': r2(s.ad_read), Focus: r2(s.focus),
    'Question Set Hash': rec.questionSetHash ?? null, Model: rec.model ?? null, 'Added At': rec.addedAt ?? null,
    Media: JSON.stringify(rec.media || {}), Uses: JSON.stringify(uses), 'Times Used': uses.length, 'Last Used': last,
  };
}

/** A Clips row -> a library record. Pure. */
export function recordFromRow(row) {
  const f = row.fields || {};
  const url = f['Watch URL'] ? String(f['Watch URL']).replace(/[?&]t=\d+s?$/, '') : null;
  const n = (k) => (typeof f[k] === 'number' ? f[k] : null);
  return {
    id: f['Clip ID'], rowId: row.id,
    // The video id lives in the Podcast link and the Watch URL (the Video ID column was dropped 2026-09-24).
    source: { id: videoIdOf(url) ?? f['Video ID'] ?? null, title: f['Source Title'] ?? null, url },
    start: f.Start, end: f.End, speaker: f.Speaker ?? null, text: f.Text ?? '',
    scores: { claim: n('Claim'), arguable: n('Arguable'), self_contained: n('Self Contained'), single_point: n('Single Point'),
      clean_start: n('Clean Start'), clean_end: n('Clean End'), ad_read: n('Ad Read'), focus: n('Focus') },
    rank: n('Rank'), verdict: f.Verdict ?? null, model: f.Model ?? null, questionSetHash: f['Question Set Hash'] ?? null,
    addedAt: f['Added At'] ?? null, media: parseJson(f.Media, {}), uses: parseJson(f.Uses, []),
    label: f['Operator Label'] ?? null,
    file: f['Clip File']?.[0] ? { url: f['Clip File'][0].url, filename: f['Clip File'][0].filename, size: f['Clip File'][0].size ?? null } : null,
  };
}

// ---- Airtable I/O -----------------------------------------------------------------------------------
export const clipBaseId = (env) => String(env.CLIPS_BASE_ID || CLIPS_BASE).trim();

/** Create the base (both tables) and the link. Returns { baseId, tables: {name: id} }. */
export async function createClipBase(env, workspaceId, { fetchImpl = fetch, schema = CLIP_BASE_SCHEMA } = {}) {
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
  const r = await fetchImpl('https://api.airtable.com/v0/meta/bases', { method: 'POST', headers: h,
    body: JSON.stringify({ name: schema.name, workspaceId, tables: schema.tables }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`create base -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const tables = Object.fromEntries(j.tables.map((t) => [t.name, t.id]));
  for (const l of schema.links) {
    const lr = await fetchImpl(`https://api.airtable.com/v0/meta/bases/${j.id}/tables/${tables[l.table]}/fields`, { method: 'POST', headers: h,
      body: JSON.stringify({ name: l.name, type: 'multipleRecordLinks', options: { linkedTableId: tables[l.linkedTable] } }) });
    if (!lr.ok) throw new Error(`link ${l.table}.${l.name} -> ${lr.status}: ${(await lr.text()).slice(0, 300)}`);
  }
  return { baseId: j.id, tables };
}

/**
 * Bring the base up to CLIP_BASE_SCHEMA: create every missing table, every missing field on an existing
 * table, and every missing link. Never renames, retypes or deletes. Returns what it created.
 */
export async function ensureTables(env, baseId, { fetchImpl = fetch, schema = CLIP_BASE_SCHEMA } = {}) {
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
  const meta = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
  const post = async (url, body, what) => {
    const r = await fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${what} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const r = await fetchImpl(meta, { headers: h });
  if (!r.ok) throw new Error(`read schema -> ${r.status}`);
  const have = new Map((await r.json()).tables.map((t) => [t.name, { id: t.id, fields: new Set(t.fields.map((f) => f.name)) }]));
  const created = [];
  for (const t of schema.tables) {
    if (!have.has(t.name)) {
      const j = await post(meta, t, `create table ${t.name}`);
      have.set(t.name, { id: j.id, fields: new Set(t.fields.map((f) => f.name)) });
      created.push(t.name);
      continue;
    }
    const cur = have.get(t.name);
    for (const f of t.fields) {
      if (cur.fields.has(f.name)) continue;
      await post(`${meta}/${cur.id}/fields`, f, `create field ${t.name}.${f.name}`);
      cur.fields.add(f.name);
      created.push(`${t.name}.${f.name}`);
    }
  }
  for (const l of schema.links || []) {
    const cur = have.get(l.table);
    if (cur.fields.has(l.name)) continue;
    await post(`${meta}/${cur.id}/fields`, { name: l.name, type: 'multipleRecordLinks', options: { linkedTableId: have.get(l.linkedTable).id } }, `link ${l.table}.${l.name}`);
    created.push(`${l.table}.${l.name}`);
  }
  return { created, tables: Object.fromEntries([...have].map(([k, v]) => [k, v.id])) };
}

/** Attach a JSON file to a record's attachment field (Airtable content upload, 5 MB cap). */
export async function uploadJsonAttachment(env, baseId, recordId, field, filename, value, { fetchImpl = fetch } = {}) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 5 * 1024 * 1024) throw new Error(`${filename} is ${(body.length / 1e6).toFixed(1)} MB; Airtable uploads cap at 5 MB`);
  const r = await fetchImpl(`https://content.airtable.com/v0/${baseId}/${recordId}/${encodeURIComponent(field)}/uploadAttachment`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'application/json', filename, file: body.toString('base64') }),
  });
  if (!r.ok) throw new Error(`upload ${filename} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return body.length;
}

/** The transcript file of a Podcasts row (attachment URLs are short-lived: read, never store). */
// A transcript attachment never changes under its id (a re-add attaches a new one), so a read is cached on
// disk by attachment id: a /run's media pass reads every pool transcript twice per row, and with 20
// podcasts that was ~1,700 Airtable downloads a run. `cacheDir: null` turns it off.
const TRANSCRIPT_CACHE = join(tmpdir(), 'pi-clip-transcripts');
export async function readTranscript(row, { fetchImpl = fetch, cacheDir = TRANSCRIPT_CACHE } = {}) {
  const a = (row.fields?.Transcript || [])[0];
  if (!a?.url) return null;
  const file = cacheDir && a.id && /^att[A-Za-z0-9]+$/.test(a.id) ? join(cacheDir, `${a.id}.json`) : null;
  if (file && existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt: re-read */ } }
  const r = await fetchImpl(a.url);
  if (!r.ok) throw new Error(`transcript ${row.fields['Video ID']} -> ${r.status}`);
  const json = await r.json();
  if (file) { try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify(json)); } catch { /* cache is best-effort */ } }
  return json;
}

/**
 * Put the cut mp4 on its Clips row (Clip ID). Airtable copies the file from `url` into its own storage, so
 * the served URL only has to live until then. Never part of clipFields: an ordinary save leaves it alone.
 */
export async function storeClipFile(at, clipIdValue, { url, filename }) {
  return at.upsert(TABLES.clips, 'Clip ID', [{ 'Clip ID': clipIdValue, 'Clip File': [{ url, filename }] }]);
}

/** The row's Clip File with a fresh URL (Airtable's attachment URLs expire): read just before a download. */
export async function freshClipFile(at, clipIdValue) {
  const row = (await at.listAll(TABLES.clips, { formula: `{Clip ID}='${String(clipIdValue).replace(/'/g, "\\'")}'`, fields: ['Clip ID', 'Clip File'] }))[0];
  return row ? recordFromRow(row).file : null;
}

/** Every stored clip as a library record. */
export async function loadClipLibrary(at) {
  return (await at.listAll(TABLES.clips)).map(recordFromRow).filter((r) => r.id);
}

/**
 * Upsert library records by Clip ID (the Podcast link resolves by Video ID through typecast). Each is
 * merged with its stored row first: media and uses are unioned and a missing value never erases a
 * stored one, so re-mining an episode or placing a clip keeps its history. Operator Label is not a
 * clipFields column, so a save never touches it.
 */
export async function saveClipRecords(at, records) {
  if (!records.length) return 0;
  const stored = new Map();
  const ids = [...new Set(records.map((r) => r.id))];
  for (let i = 0; i < ids.length; i += 40) {
    const formula = `OR(${ids.slice(i, i + 40).map((id) => `{Clip ID}='${String(id).replace(/'/g, '')}'`).join(',')})`;
    for (const row of await at.listAll(TABLES.clips, { formula })) stored.set(row.fields['Clip ID'], recordFromRow(row));
  }
  const merged = new Map();
  for (const r of records) {
    const prev = merged.get(r.id) ?? stored.get(r.id);
    merged.set(r.id, prev ? mergeRecord(prev, r) : r);
  }
  return at.upsert(TABLES.clips, 'Clip ID', [...merged.values()].map(clipFields));
}

export const videoIdOf = (s) => { const m = String(s ?? '').match(/(?:v=|youtu\.be\/|shorts\/|^)([A-Za-z0-9_-]{11})(?:[?&#]|$)/); return m ? m[1] : null; };

// ---- Swipe Media: which swipe media we placed, where (same media/uses shape as a clip record) --------
/** A Swipe Media record -> row fields. Pure. */
export function swipeMediaFields(rec) {
  const uses = rec.uses || [];
  const live = liveUses(uses);
  return {
    'Swipe Rec ID': rec.id, 'Media Key': rec.key ?? null, 'Tweet URL': rec.tweetUrl ?? null, Text: rec.text ?? null, 'Media Type': rec.kind ?? null, Items: rec.count ?? null,
    'Same Point': r2(rec.same), Media: JSON.stringify(rec.media || {}), Uses: JSON.stringify(uses), 'Times Used': live.length,
    'Last Used': live.map((u) => u.at).filter(Boolean).sort().pop() || null,
  };
}
/** A Swipe Media row -> record. Pure. */
export function swipeMediaFromRow(row) {
  const f = row.fields || {};
  return { id: f['Swipe Rec ID'], key: f['Media Key'] ?? null, tweetUrl: f['Tweet URL'] ?? null, text: f.Text ?? null, kind: f['Media Type'] ?? null, count: f.Items ?? null,
    same: f['Same Point'] ?? null, media: parseJson(f.Media, {}), uses: parseJson(f.Uses, []), label: f['Operator Label'] ?? null };
}
export async function loadSwipeMedia(at) {
  return (await at.listAll(TABLES.swipeMedia)).map(swipeMediaFromRow).filter((r) => r.id);
}
/** Upsert by Swipe Rec ID, merged with any stored row (media and uses unioned; nulls never erase). */
export async function saveSwipeMedia(at, records) {
  if (!records.length) return 0;
  const ids = [...new Set(records.map((r) => r.id))];
  const stored = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const formula = `OR(${ids.slice(i, i + 40).map((id) => `{Swipe Rec ID}='${String(id).replace(/'/g, '')}'`).join(',')})`;
    for (const row of await at.listAll(TABLES.swipeMedia, { formula })) stored.set(row.fields['Swipe Rec ID'], swipeMediaFromRow(row));
  }
  const merged = new Map();
  for (const r of records) { const prev = merged.get(r.id) ?? stored.get(r.id); merged.set(r.id, prev ? mergeRecord(prev, r) : r); }
  return at.upsert(TABLES.swipeMedia, 'Swipe Rec ID', [...merged.values()].map(swipeMediaFields));
}
