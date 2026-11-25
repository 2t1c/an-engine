#!/usr/bin/env node
// competitor-bodies.mjs [--dry] [--limit N] [--refresh-days D] [--account Handle] — give every
// Competitor Threads head its full body: one row per tweet (Tweet Number, Tweet Retention, media),
// linked from the head's `Tweets` field so Thread Length / Thread Retention / Full Thread Text roll
// up exactly as they do in the swipe file. Same parser as the n8n Get Thread flow (competitor-thread.mjs).
//
// Default pass: heads with no Tweets link yet. --refresh-days D: also re-fetch heads posted in the
// last D days (numbers settle for ~48h). One RapidAPI call per head; ~2 calls/s.
import { loadEnv, requireEnv } from './lib.mjs';
import { parseThread, bodyFields } from './competitor-thread.mjs';
import { TBL } from './config.mjs';
const SWIPE = process.env.XDB_BASE_ID || '', USERS = TBL.swipeUsers, COMP = TBL.competitorThreads;
const args = process.argv.slice(2); const DRY = args.includes('--dry'); const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const LIMIT = Number(flag('limit', 100000)); const REFRESH = Number(flag('refresh-days', 0)); const ONLY = flag('account', null);
const env = loadEnv(); requireEnv(env, ['AIRTABLE_PAT', 'RAPIDAPI_KEY']);
const H = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
const RH = { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': 'twitter241.p.rapidapi.com' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function at(method, path, body, attempt = 0) { const r = await fetch(`https://api.airtable.com/v0/${SWIPE}/${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); if ((r.status === 429 || r.status >= 500) && attempt < 5) { await sleep(1500 * (attempt + 1)); return at(method, path, body, attempt + 1); } if (!r.ok) throw new Error(`airtable ${method} ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); }
async function listAll(table, params = {}) { const out = []; let offset; do { const u = new URLSearchParams({ pageSize: '100', ...(offset ? { offset } : {}) }); for (const f of params.fields || []) u.append('fields[]', f); if (params.formula) u.set('filterByFormula', params.formula); const j = await at('GET', `${table}?${u}`); out.push(...j.records); offset = j.offset; await sleep(210); } while (offset); return out; }
async function tweet(pid, attempt = 0) { const r = await fetch(`https://twitter241.p.rapidapi.com/tweet?pid=${pid}`, { headers: RH }); if (r.status === 429 && attempt < 4) { await sleep(2500 * (attempt + 1)); return tweet(pid, attempt + 1); } if (!r.ok) return { error: `http-${r.status}` }; return r.json(); }

const users = await listAll(USERS, { fields: ['Handle', 'RestID', 'Cohort'], formula: `{Cohort}='Direct Competitor'` });
const byRest = new Map(users.map((u) => [String(u.fields.RestID), u]));
const rows = await listAll(COMP, { fields: ['TweetID', 'Handle', 'User RestID', 'Tweet Number', 'Tweets', 'Published Date', 'Impressions', 'User'] });
const cutoff = Date.now() - REFRESH * 864e5;
let heads = rows.filter((r) => r.fields.TweetID && (!r.fields['Tweet Number'] || r.fields['Tweet Number'] === 1) && (!ONLY || r.fields.Handle === ONLY)
  && (!(r.fields.Tweets || []).length || (REFRESH && Date.parse(r.fields['Published Date'] || 0) >= cutoff)));
heads.sort((a, b) => (b.fields['Published Date'] || '') < (a.fields['Published Date'] || '') ? -1 : 1).splice(LIMIT);
console.log(`competitor heads: ${rows.filter((r) => !r.fields['Tweet Number'] || r.fields['Tweet Number'] === 1).length} · to fetch now: ${heads.length}${DRY ? ' · DRY' : ''}`);
if (DRY) process.exit(0);
const stats = { done: 0, single: 0, gone: 0, foreign: 0, rows: 0, lengths: [] };
for (const h of heads) {
  const pid = String(h.fields.TweetID); const handle = h.fields.Handle || byRest.get(String(h.fields['User RestID']))?.fields.Handle || '';
  const j = await tweet(pid); await sleep(450);
  const p = j.error ? { ok: false } : parseThread(j, pid, handle);
  if (!p.ok) { stats.gone++; await at('PATCH', COMP, { typecast: true, records: [{ id: h.id, fields: { 'Quoted Junk': true } }] }).catch(() => {}); continue; }
  // Foreign = a different ACCOUNT, not a different handle: LevelUpPrime renamed itself Solo_LevelUp_,
  // and its old rows are still its own threads.
  const rowRest = String(h.fields['User RestID'] || byRest.get(String(h.fields['User RestID']))?.fields.RestID || '');
  if (p.author && p.author.RestID && rowRest && String(p.author.RestID) !== rowRest) { stats.foreign++; console.log(`  foreign author on ${handle} ${pid}: ${p.author.Handle} — flagged Quoted Junk`); await at('PATCH', COMP, { typecast: true, records: [{ id: h.id, fields: { 'Quoted Junk': true } }] }).catch(() => {}); continue; }
  const userRec = h.fields.User?.[0] || byRest.get(String(h.fields['User RestID']))?.id;
  const body = p.thread.slice(1); const ids = [];
  for (let i = 0; i < body.length; i += 10) { const res = await at('PATCH', COMP, { typecast: true, performUpsert: { fieldsToMergeOn: ['TweetID'] }, records: body.slice(i, i + 10).map((r) => ({ fields: bodyFields(r, { handle, restId: String(h.fields['User RestID'] || p.author.RestID), userRecId: userRec, source: 'backfill' }) })) }); ids.push(...res.records.map((r) => r.id)); await sleep(220); }
  // THREADS ONLY (operator 2026-09-28: "delete all single tweet (thread length=1) from his
  // database"). A head with no self-replies is a single post, not a thread: remove its row rather
  // than keep it flagged. The n8n capture cannot tell at head time, so this pass is the filter.
  if (body.length === 0) { await at('DELETE', `${COMP}?records[]=${h.id}`).catch(() => {}); stats.single++; await sleep(220); continue; }
  const hd = p.head; const ctr = body.length && hd.impressions ? body[0].impressions / hd.impressions : undefined;
  await at('PATCH', COMP, { typecast: true, records: [{ id: h.id, fields: { Tweets: [h.id, ...ids], 'Tweet Number': 1, 'Tweet Retention': 1, Impressions: hd.impressions, Likes: hd.likes, Comments: hd.comments, Bookmarks: hd.bookmarks, Retweets: hd.retweets, Quotes: hd.quotes, ...(ctr != null ? { CTR: ctr } : {}), ...(hd.media.length ? { Media: hd.media } : {}), ...(hd.media_type ? { 'Media Type': hd.media_type } : {}), ...(hd.video_url ? { 'Video URL': hd.video_url } : {}) } }] });
  stats.done++; stats.rows += body.length; stats.lengths.push(p.thread.length);
  if (stats.done % 50 === 0) console.log(`  ${stats.done}/${heads.length} · ${stats.rows} body rows · singles ${stats.single} · gone ${stats.gone} · foreign ${stats.foreign}`);
  await sleep(220);
}
const L = stats.lengths.sort((a, b) => a - b);
console.log(`done: ${stats.done} threads · ${stats.rows} body rows · single posts deleted ${stats.single} · gone/deleted ${stats.gone} · foreign-author ${stats.foreign} · median length ${L[L.length >> 1] || 0}`);
