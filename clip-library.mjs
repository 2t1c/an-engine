// clip-library.mjs — the store of clips we have found or cut, so a later thread can reuse one instead of
// cutting again (clip-judge.mjs MATCH ranks stored clips beside fresh passages).
//
// One JSON object per line. A record keeps what a match needs (the spoken text, the source and window)
// and what reuse needs (the Typefully media id per social set, and every use). Typefully media ids belong
// to one social set, so reuse on another account means re-cutting the same window: still no search, no
// Jev spend. Local JSONL for now; the record shape is the contract a future Airtable table would take.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const LIBRARY_RULES = {
  cooldownDays: 30, // the same clip is not reused on the same social set within this many days
};

/** Stable id: the same source and window (to the tenth of a second) is the same clip. Pure. */
export function clipId({ sourceId, start, end }) {
  return 'clip_' + createHash('sha256').update(`${sourceId}|${Number(start).toFixed(1)}|${Number(end).toFixed(1)}`).digest('hex').slice(0, 16);
}

/** A judged window -> a library record. Pure. */
export function toRecord(clip, { source, questionSetHash = null, now = new Date() } = {}) {
  if (!source?.id) throw new Error('toRecord needs source.id (the video id or url of the podcast)');
  return {
    id: clipId({ sourceId: source.id, start: clip.start, end: clip.end }),
    source: { id: source.id, title: source.title ?? null, url: source.url ?? null },
    start: clip.start, end: clip.end, speaker: clip.speaker ?? null, text: clip.text,
    scores: clip.scores ?? null, rank: clip.rank ?? null, verdict: clip.verdict ?? null,
    model: clip.model ?? null, questionSetHash, addedAt: now.toISOString(),
    media: {}, // socialSetId -> Typefully media id, filled when a clip is cut and uploaded
    uses: [], // { socialSetId, draftId, tweet, at }
  };
}

export function loadLibrary(path) {
  if (!existsSync(path)) return [];
  const byId = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    byId.set(r.id, byId.has(r.id) ? mergeRecord(byId.get(r.id), r) : r); // later lines update earlier ones
  }
  return [...byId.values()];
}

/**
 * Same clip seen twice: keep the first record's identity and addedAt, take the newer value of any field
 * the newer record actually carries (null/undefined never erases a stored value, so a placement that
 * knows no scores cannot wipe the mined ones), and union media and uses. Pure.
 */
export function mergeRecord(a, b) {
  const uses = [...(a.uses || [])];
  for (const u of b.uses || []) if (!uses.some((x) => String(x.socialSetId) === String(u.socialSetId) && x.draftId === u.draftId && x.tweet === u.tweet)) uses.push(u);
  const defined = Object.fromEntries(Object.entries(b).filter(([, v]) => v != null));
  return { ...a, ...defined, addedAt: a.addedAt ?? b.addedAt, media: { ...(a.media || {}), ...(b.media || {}) }, uses };
}

/** Append records; an id already in the file is merged on the next load, never duplicated in use. */
export function addToLibrary(path, records) {
  if (!records.length) return 0;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return records.length;
}

/** Rewrite the file compacted (one line per id). */
export function saveLibrary(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

/**
 * May this stored clip go on a draft of this social set now? Returns { ok, reason, mediaId }. A clip
 * without media for the set is reusable but must be re-cut (mediaId null). Pure.
 */
/** Uses that count: a review copy (`review: true`) never publishes, so it is kept for the record only. Pure. */
export const liveUses = (uses) => (uses || []).filter((u) => !u.review);

export function reuseCheck(record, { socialSetId, now = new Date(), rules = LIBRARY_RULES } = {}) {
  const key = String(socialSetId);
  const last = liveUses(record.uses).filter((u) => String(u.socialSetId) === key).map((u) => Date.parse(u.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (last && now.getTime() - last < rules.cooldownDays * 86_400_000) {
    return { ok: false, reason: `used on this account ${Math.floor((now.getTime() - last) / 86_400_000)}d ago (cooldown ${rules.cooldownDays}d)`, mediaId: null };
  }
  const mediaId = record.media?.[key] ?? null;
  return { ok: true, reason: mediaId ? 'media ready on this account' : 'needs a re-cut for this account', mediaId };
}

/** Library records as MATCH candidates, minus any in cooldown for the target account. Pure. */
export function libraryCandidates(records, { socialSetId = null, now = new Date(), rules = LIBRARY_RULES } = {}) {
  return records.map((r) => ({ r, check: socialSetId == null ? { ok: true, reason: null, mediaId: null } : reuseCheck(r, { socialSetId, now, rules }) }))
    .filter(({ check }) => check.ok)
    .map(({ r, check }) => ({ kind: 'library', id: r.id, sourceId: r.source.id, title: r.source.title, url: r.source.url, start: r.start, end: r.end, speaker: r.speaker, text: r.text, mediaId: check.mediaId, reuse: check.reason }));
}

/** The record with a Typefully media id for one social set (what a cut produces). Pure. */
export const withMedia = (record, socialSetId, mediaId) => ({ ...record, media: { ...(record.media || {}), [String(socialSetId)]: mediaId } });

/** The record with one more use (a clip placed on a draft's tweet). Pure. */
export const withUse = (record, use) => ({ ...record, uses: [...(record.uses || []), { ...use, socialSetId: String(use.socialSetId) }] });
