#!/usr/bin/env node
// lifepad.mjs: the Lifepad lane. A partner's pages post OUR threads at $5 a post.
//
// Owner, 2026-11-12 (thread "Set up Lifepad posting path"): "we'll have LifePad's pages post our
// threads on their pages ... he agrees to $5 per post". Up to 10 threads a day, two kinds:
//   70%  HIS threads with our plug inside: of those, 70% his best threads reposted with our links
//        ('his') and 30% seeds written from his past threads ('seed').
//   30%  OUR best threads, reposted on his pages as covers with a lightly rewritten body ('ours').
// Every Lifepad thread: our 2-beat CTA, plain Levanta links (no Geniuslink), NO #ad, NO about-me
// tweet, NO closing disclaimer, his media kept, same product rules as our pages. He posts them
// himself from the burner Typefully set and drops each link in the Lifepad Telegram group, where the
// RT bot counts 1 thread = 1 credit once it passes 20k views (genius-rt-bot /posterdeal).
//
//   node scripts/lifepad.mjs pool  --work DIR [--n 10] [--days 30] [--min 500000]
//   node scripts/lifepad.mjs check --work DIR
//   node scripts/lifepad.mjs ship  --work DIR [--dry]
//   node scripts/lifepad.mjs queue --work DIR
//   node scripts/lifepad.mjs link  --work DIR [--dry]
//   node scripts/lifepad.mjs learn [--dry]
//
// THE TYPEFULLY SIDE (owner, 2026-11-12 16:04Z): every Lifepad thread lives in the "The Healthy Man"
// set (219883, LifePad Threads workspace). Two tags: "Need Link" = a thread waiting for us, "Ready to
// Post" = plugged and linked, he posts it. Three kinds of thread land there: his old threads, his newly
// written threads (he adds both, tagged Need Link) and our best threads (we add them, Ready to Post).
//
// queue  reads only: every draft tagged Need Link, with its tweets, into DIR/queue.json.
// link   for each draft in DIR/plugs.json ({ "<draftId>": { "after": N, "beats": ["point...", "Which X
//        works? ... {{LINK}}"], "asin": "B0.." } }) inserts our 2 beats after tweet N, mints the link
//        (subid x-lifepad-d<draftId>), keeps every existing tweet and its media, swaps the tag to Ready
//        to Post, and reads the draft back. --dry writes nothing.
//
// pool   reads only. His threads (swipe Users cohort "Lifepad", bodies in Competitor Threads) at or
//        over --min views (default 500k: owner 2026-11-13, "the most viral ones available. 500k+ minimum") in the last --days, and our best earners (facts.jsonl lifetime commission),
//        minus anything in the ledger. Writes DIR/pool.json (sources with every tweet's text and
//        media) and prints the day's mix for --n threads.
// check  reads only: every rule above, on DIR/rows.json, plus overlap between the day's threads.
// ship   check, then mint each {{LINK}} (subid x-lifepad-<row>-<suffix>), create an UNSCHEDULED
//        "[LIFEPAD]" draft in the burner set with his media re-uploaded, read it back, and append the
//        ledger. --dry writes nothing.
//
// learn  reads the RT bot's GET /poster-posts (RT_BOT_URL + RT_BOT_WEBHOOK_SECRET): every page Lifepad
//        has dropped a link from. A page not yet in swipe Users is added with Cohort = Lifepad and Track
//        User on; an existing row is re-tagged only when it has no cohort. He runs ~35 pages and we only
//        have their display names, so his own links are how the tracker learns the handles.
//
// DIR/rows.json is what the writer (Claude, in chat) produced from pool.json:
//   { "<row id>": { "kind": "his"|"seed"|"ours", "source": "<x url>", "asins": ["B0..", ...],
//                   "tweets": [ { "text": "...{{LINK}}...", "media": ["https://..."] }, ... ] } }
// The script never writes copy and never calls a model.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crossOverlap } from './hand-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const LIFEPAD_SET = 219883; // "The Healthy Man", LifePad Threads workspace
export const TAG_NEED = 'need-link', TAG_READY = 'ready-to-post';
export const BURNER_SET = LIFEPAD_SET; // ship() writes here too (kept name for the media helper)
export const LEDGER = '/mnt/project-files/lifepad/ledger.jsonl';
export const MIX = { his: 0.7 * 0.7, seed: 0.7 * 0.3, ours: 0.3 };
export const MAX_PER_DAY = 10;
export const CROSS_MAX = 0.10;
const LINK_RE = /\{\{LINK\d?\}\}/g;
const SUFFIX = ['', '-b', '-c', '-d'];
const SWIPE = 'app7vXbBugWeCGctD', USERS = 'tblEbIfYqCpxf1yMu', COMP = 'tblP4xywLyi2PZx3b';

// ---- pure helpers (tests/lifepad.test.mjs) -------------------------------------------------------
/** How many of each kind for n threads: 'ours' gets 30% rounded, 'seed' 30% of the rest, 'his' the rest. */
export function mixFor(n) {
  const total = Math.max(0, Math.min(MAX_PER_DAY, Math.floor(Number(n) || 0)));
  const ours = Math.round(total * 0.3);
  const seed = Math.round((total - ours) * 0.3);
  return { his: total - ours - seed, seed, ours, total };
}

const AD_RE = /#ad\b|\(#ad\)|#affiliate|\bas an amazon associate\b|affiliate link|i earn (a )?commission/i;
const ABOUT_RE = /\bfollow (me|@)|\bwho am i\b|\babout me\b/i;
const GENI_RE = /geni\.us/i;

/** Every rule a Lifepad row must meet. Returns a list of findings; empty means it can ship. */
export function rowIssues(id, row = {}) {
  const out = [];
  const tw = Array.isArray(row.tweets) ? row.tweets : [];
  if (!['his', 'new', 'seed', 'ours'].includes(row.kind)) out.push(`${id}: kind must be his, new, seed or ours`);
  if (!row.source) out.push(`${id}: no source url`);
  if (tw.length < 3) out.push(`${id}: ${tw.length} tweet(s), a thread needs at least 3`);
  const texts = tw.map((t) => String(t?.text ?? t ?? ''));
  const links = texts.join('\n').match(LINK_RE) || [];
  const asins = Array.isArray(row.asins) ? row.asins : [];
  if (!links.length) out.push(`${id}: no {{LINK}} placeholder (the 2-beat CTA carries our link)`);
  const distinct = [...new Set(links)];
  if (distinct.length > asins.length) out.push(`${id}: ${distinct.length} link slot(s) but ${asins.length} ASIN(s)`);
  texts.forEach((t, i) => {
    if (AD_RE.test(t)) out.push(`${id}: tweet ${i + 1} has #ad / an affiliate disclosure (Lifepad threads drop it)`);
    if (GENI_RE.test(t)) out.push(`${id}: tweet ${i + 1} has a Geniuslink (Lifepad uses plain Levanta)`);
    if (/https?:\/\/(lvnta\.com|amzn\.|amazon\.)/i.test(t)) out.push(`${id}: tweet ${i + 1} has a hard-coded product link; use {{LINK}}`);
    if (t.length > 4000) out.push(`${id}: tweet ${i + 1} is ${t.length} chars`);
  });
  const last = texts[texts.length - 1] || '';
  if (ABOUT_RE.test(last) && texts.length > 3) out.push(`${id}: the last tweet reads like an about-me / follow tweet (Lifepad threads have none)`);
  return out;
}

/** Ledger rows -> the set of source urls already used, by kind. Pure. */
export function usedSources(lines = []) {
  const used = new Set();
  for (const l of lines) if (l && l.source) used.add(String(l.source).replace(/\?.*$/, '').toLowerCase());
  return used;
}

const textsOf = (row) => (row.tweets || []).map((t) => String(t?.text ?? t ?? ''));

/** The posts of a draft with our two beats inserted after tweet `after` (1-based). Existing tweets
 *  and their media are kept as they are. Pure. */
export function insertBeats(posts = [], after, beats = []) {
  const n = Math.max(1, Math.min(Number(after) || 0, posts.length));
  return [...posts.slice(0, n), ...beats.map((text) => ({ text })), ...posts.slice(n)];
}

/** The distinct pages in a /poster-posts payload, lowercased, junk dropped. Pure. */
export function pagesFromPosterPosts(payload = {}) {
  const out = new Set();
  for (const d of Object.values(payload?.deals || {})) for (const p of d?.posts || []) {
    const h = String(p?.page || '').replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9_]{1,15}$/.test(h) && h !== 'i') out.add(h);
  }
  return [...out].sort();
}

// ---- io ------------------------------------------------------------------------------------------
async function env() {
  const lib = await import(pathToFileURL(path.join(ROOT, 'lib.mjs')).href);
  return { lib, env: lib.loadEnv() };
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function atList(pat, table, { formula, fields = [], max = 5000 } = {}) {
  const out = []; let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${SWIPE}/${table}`);
    u.searchParams.set('pageSize', '100');
    if (formula) u.searchParams.set('filterByFormula', formula);
    for (const f of fields) u.searchParams.append('fields[]', f);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${pat}` } });
    if (!r.ok) throw new Error(`airtable ${table} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...j.records); offset = j.offset;
  } while (offset && out.length < max);
  return out;
}

async function pool(work, { n, days, min }) {
  const { env: E } = await env();
  const used = usedSources(readLedger());
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const users = await atList(E.AIRTABLE_PAT, USERS, { formula: `{Cohort}='Lifepad'`, fields: ['Handle'] });
  const handles = users.map((u) => String(u.fields.Handle || '').toLowerCase()).filter(Boolean);
  if (!handles.length) throw new Error('no swipe Users rows with Cohort = Lifepad');
  const who = `OR(${handles.map((h) => `LOWER({Handle})='${h}'`).join(',')})`;
  const heads = await atList(E.AIRTABLE_PAT, COMP, {
    formula: `AND(${who},{Tweet Number}=1,IS_AFTER({Published Date},'${since}'),{Impressions}>=${min})`,
    fields: ['Handle', 'TweetID', 'Impressions', 'Published Date', 'Tweets', 'Thread Length (live)', 'Tweet URL'],
  });
  const his = [];
  for (const h of heads.sort((a, b) => (b.fields.Impressions || 0) - (a.fields.Impressions || 0))) {
    const f = h.fields;
    const url = `https://x.com/${f.Handle}/status/${f.TweetID}`;
    if (used.has(url.toLowerCase()) || (f['Thread Length (live)'] || 0) < 3) continue;
    const ids = f.Tweets || [];
    const body = ids.length ? await atList(E.AIRTABLE_PAT, COMP, {
      formula: `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(',')})`, fields: ['Tweet Number', 'Text', 'Media', 'Video URL'],
    }) : [];
    const tweets = body.map((b) => b.fields).sort((a, b) => (a['Tweet Number'] || 0) - (b['Tweet Number'] || 0))
      .map((b) => ({ n: b['Tweet Number'], text: b.Text || '', media: [...(b['Video URL'] ? [b['Video URL']] : []), ...(b['Video URL'] ? [] : (b.Media || []).map((m) => m.url))] }));
    his.push({ source: url, handle: f.Handle, views: f.Impressions, posted: f['Published Date'], length: f['Thread Length (live)'], tweets });
  }
  const facts = fs.readFileSync(path.join(ROOT, 'facts.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ours = facts.filter((f) => f.xUrl && f.postedAt && !used.has(String(f.xUrl).replace(/\?.*$/, '').toLowerCase()))
    .map((f) => ({ source: f.xUrl, account: f.account, draftId: f.draftId, views: f.views, commission: Number(f.lifetimeCommission || f.commission || 0), asin: f.asin, asin2: f.asin2, title: f.title, posted: f.postedAt }))
    .filter((f) => f.commission > 0).sort((a, b) => b.commission - a.commission).slice(0, 40);
  fs.mkdirSync(work, { recursive: true });
  const mix = mixFor(n);
  fs.writeFileSync(path.join(work, 'pool.json'), JSON.stringify({ at: new Date().toISOString(), mix, min, days, his, ours }, null, 1));
  console.log(`Lifepad pool · ${handles.length} pages · his threads >= ${min.toLocaleString()} views since ${since}: ${his.length} · our earners: ${ours.length}`);
  console.log(`mix for ${mix.total}: his ${mix.his} · seed ${mix.seed} · ours ${mix.ours}`);
  for (const h of his.slice(0, 15)) console.log(`  his  ${String(h.views).padStart(9)}  @${h.handle}  ${h.length}t  ${h.source}  ${String(h.tweets[0]?.text || '').replace(/\n/g, ' ').slice(0, 60)}`);
  for (const o of ours.slice(0, 10)) console.log(`  ours $${o.commission.toFixed(0).padStart(5)}  ${o.account}  ${o.source}  ${String(o.title || '').slice(0, 50)}`);
  console.log(`wrote ${path.join(work, 'pool.json')}`);
}

function check(work) {
  const rows = JSON.parse(fs.readFileSync(path.join(work, 'rows.json'), 'utf8'));
  const ids = Object.keys(rows);
  const issues = [];
  if (ids.length > MAX_PER_DAY) issues.push(`${ids.length} rows: the owner's cap is ${MAX_PER_DAY} a day`);
  for (const id of ids) issues.push(...rowIssues(id, rows[id]));
  const used = usedSources(readLedger());
  for (const id of ids) if (used.has(String(rows[id].source || '').replace(/\?.*$/, '').toLowerCase()) && rows[id].kind !== 'seed') issues.push(`${id}: source already shipped (ledger)`);
  // The cross check reads tweets 2..n-1; Lifepad threads have no disclaimer, so pad one empty tweet.
  const cross = crossOverlap(Object.fromEntries(ids.map((id) => [id, [...textsOf(rows[id]), '']])));
  for (const [id, share] of Object.entries(cross)) if (share > CROSS_MAX) issues.push(`${id}: ${(share * 100).toFixed(0)}% of its body repeats another thread today (max ${CROSS_MAX * 100}%)`);
  const kinds = ids.reduce((m, id) => ({ ...m, [rows[id].kind]: (m[rows[id].kind] || 0) + 1 }), {});
  console.log(`check · ${ids.length} rows · ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  for (const i of issues) console.log(`  ✗ ${i}`);
  if (!issues.length) console.log('  ✓ clean');
  return { rows, issues };
}

async function mediaId(tf, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`media ${url} -> ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const ext = (url.match(/\.(mp4|jpg|jpeg|png|gif|webp)(\?|$)/i) || [, 'jpg'])[1].toLowerCase();
  return tf.uploadMedia(BURNER_SET, `lifepad-${Date.now()}.${ext}`, bytes);
}

async function ship(work, { dry }) {
  const { rows, issues } = check(work);
  if (issues.length) { console.log('not shipping: fix the findings above'); process.exitCode = 1; return; }
  const { lib, env: E } = await env();
  const tf = lib.typefully(E);
  const today = new Date().toISOString().slice(0, 10);
  const stateFile = path.join(work, 'ship.json');
  const done = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  for (const [id, row] of Object.entries(rows)) {
    if (done[id]?.draftId) { console.log(`  = ${id} already shipped (draft ${done[id].draftId})`); continue; }
    const slots = [...new Set(textsOf(row).join('\n').match(LINK_RE) || [])];
    const links = done[id]?.links || {};
    for (const [i, slot] of slots.entries()) {
      if (links[slot]) continue;
      const subid = `x-lifepad-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${SUFFIX[i] || `-${i}`}`.slice(0, 48);
      if (dry) { links[slot] = `https://lvnta.com/DRY-${row.asins[i]}`; continue; }
      const r = spawnSync('node', ['mint-link.mjs', '--asin', row.asins[i], '--subid', subid], { cwd: ROOT, encoding: 'utf8' });
      const m = (r.stdout || '').match(/MINTED\t\S+\t\S+\t(\S+)/);
      if (!m) throw new Error(`${id}: mint failed for ${row.asins[i]}: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      links[slot] = m[1];
    }
    done[id] = { ...(done[id] || {}), links };
    if (!dry) fs.writeFileSync(stateFile, JSON.stringify(done, null, 1));
    const posts = [];
    for (const t of row.tweets) {
      const text = String(t?.text ?? t).replace(LINK_RE, (s) => links[s]);
      const media = [];
      if (!dry) for (const u of (t?.media || [])) media.push(await mediaId(tf, u));
      posts.push({ text, ...(media.length ? { media_ids: media } : {}) });
    }
    if (dry) { console.log(`  [dry] ${id} · ${row.kind} · ${posts.length} tweets · links ${Object.values(links).join(' ')}`); continue; }
    const d = await tf.createDraft(BURNER_SET, {
      platforms: { x: { enabled: true, posts } },
      draft_title: `[LIFEPAD] ${today} ${id} · ${row.kind}`,
      tags: [TAG_READY],
    });
    const back = await tf.getDraft(BURNER_SET, d.id);
    const got = (back?.platforms?.x?.posts || []).map((p) => p.text);
    const ok = got.length === posts.length && got.every((t, i) => t === posts[i].text);
    done[id] = { ...done[id], draftId: d.id, url: d.share_url || `https://typefully.com/?d=${d.id}`, readBack: ok };
    fs.writeFileSync(stateFile, JSON.stringify(done, null, 1));
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), day: today, row: id, kind: row.kind, source: row.source, asins: row.asins, links: Object.values(links), draftId: d.id }) + '\n');
    console.log(`  ${ok ? '✓' : '✗ READ-BACK MISMATCH'} ${id} · ${row.kind} · draft ${d.id} ${done[id].url || ''}`);
  }
}

async function learn({ dry }) {
  const { env: E } = await env();
  if (!E.RT_BOT_URL || !E.RT_BOT_WEBHOOK_SECRET) { console.log('learn: RT_BOT_URL / RT_BOT_WEBHOOK_SECRET unset, skipped'); return; }
  const r = await fetch(`${E.RT_BOT_URL.replace(/\/$/, '')}/poster-posts`, { headers: { Authorization: `Bearer ${E.RT_BOT_WEBHOOK_SECRET}` } });
  if (!r.ok) throw new Error(`poster-posts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const pages = pagesFromPosterPosts(await r.json());
  const users = await atList(E.AIRTABLE_PAT, USERS, { fields: ['Handle', 'Cohort'] });
  const byHandle = new Map(users.map((u) => [String(u.fields.Handle || '').toLowerCase(), u]));
  const H = { Authorization: `Bearer ${E.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
  let added = 0, tagged = 0;
  for (const h of pages) {
    const u = byHandle.get(h);
    if (u && u.fields.Cohort) continue;
    let rid = null, followers = null, name = null, handle = h;
    if (E.RAPIDAPI_KEY) {
      const j = await (await fetch(`https://twitter241.p.rapidapi.com/user?username=${h}`, { headers: { 'x-rapidapi-host': 'twitter241.p.rapidapi.com', 'x-rapidapi-key': E.RAPIDAPI_KEY } })).json().catch(() => null);
      const res = j?.result?.data?.user?.result;
      rid = res?.rest_id || null; followers = res?.legacy?.followers_count ?? null; name = res?.core?.name || res?.legacy?.name || null;
      handle = res?.core?.screen_name || res?.legacy?.screen_name || h;
    }
    const fields = { Handle: handle, Cohort: 'Lifepad', 'Track User': 'True', ...(rid ? { RestID: rid } : {}), ...(followers != null ? { Followers: followers } : {}) };
    console.log(`  ${u ? 'tag' : 'add'} @${handle}${rid ? '' : ' (no RestID: backfill skips it until one is set)'}`);
    if (dry) continue;
    const url = `https://api.airtable.com/v0/${SWIPE}/${USERS}${u ? `/${u.id}` : ''}`;
    const body = u ? { fields, typecast: true } : { fields: { ...fields, ...(name ? { Name: name } : {}), 'Profile URL': `https://x.com/${handle}` }, typecast: true };
    const w = await fetch(url, { method: u ? 'PATCH' : 'POST', headers: H, body: JSON.stringify(body) });
    if (!w.ok) throw new Error(`airtable ${handle} ${w.status}: ${(await w.text()).slice(0, 200)}`);
    if (u) tagged++; else added++;
  }
  console.log(`learn · ${pages.length} page(s) on the deal · ${added} added · ${tagged} tagged${dry ? ' · DRY' : ''}`);
}

async function queue(work) {
  const { lib, env: E } = await env();
  const tf = lib.typefully(E);
  const all = await tf.listAll(`/social-sets/${LIFEPAD_SET}/drafts?status=draft`);
  const want = all.filter((d) => (d.tags || []).includes(TAG_NEED));
  const out = {};
  for (const d of want) {
    const full = await tf.getDraft(LIFEPAD_SET, d.id);
    out[d.id] = { title: full.draft_title || null, tweets: (full.platforms?.x?.posts || []).map((p) => p.text), media: (full.platforms?.x?.posts || []).map((p) => (p.media_ids || []).length) };
  }
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify(out, null, 1));
  console.log(`queue · ${all.length} draft(s) in The Healthy Man · ${want.length} tagged Need Link -> ${path.join(work, 'queue.json')}`);
  for (const [id, q] of Object.entries(out)) console.log(`  ${id}  ${q.tweets.length}t  ${String(q.tweets[0] || '').replace(/\n/g, ' ').slice(0, 70)}`);
}

async function link(work, { dry }) {
  const plugs = JSON.parse(fs.readFileSync(path.join(work, 'plugs.json'), 'utf8'));
  const { lib, env: E } = await env();
  const tf = lib.typefully(E);
  const stateFile = path.join(work, 'link.json');
  const done = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  for (const [id, plug] of Object.entries(plugs)) {
    if (done[id]?.ok) { console.log(`  = ${id} already linked`); continue; }
    const d = await tf.getDraft(LIFEPAD_SET, id);
    if (!(d.tags || []).includes(TAG_NEED)) { console.log(`  ! ${id} is not tagged Need Link any more, skipped`); continue; }
    const posts = (d.platforms?.x?.posts || []).map((p) => ({ text: p.text, ...((p.media_ids || []).length ? { media_ids: p.media_ids } : {}) }));
    const next = insertBeats(posts, plug.after, plug.beats || []);
    const issues = rowIssues(id, { kind: 'his', source: `typefully:${id}`, asins: [plug.asin].filter(Boolean), tweets: next.map((p) => ({ text: p.text })) });
    if ((plug.beats || []).length !== 2) issues.push(`${id}: a Lifepad plug is exactly 2 beats`);
    if (issues.length) { for (const i of issues) console.log(`  ✗ ${i}`); process.exitCode = 1; continue; }
    let url = done[id]?.link;
    if (!url && !dry) {
      const r = spawnSync('node', ['mint-link.mjs', '--asin', plug.asin, '--subid', `x-lifepad-d${id}`], { cwd: ROOT, encoding: 'utf8' });
      const m = (r.stdout || '').match(/MINTED\t\S+\t\S+\t(\S+)/);
      if (!m) throw new Error(`${id}: mint failed for ${plug.asin}: ${(r.stderr || r.stdout || '').slice(0, 300)}`);
      url = m[1];
      done[id] = { link: url };
      fs.writeFileSync(stateFile, JSON.stringify(done, null, 1));
    }
    const final = next.map((p) => ({ ...p, text: p.text.replace(LINK_RE, url || `https://lvnta.com/DRY-${plug.asin}`) }));
    if (dry) { console.log(`  [dry] ${id} · ${posts.length} -> ${final.length} tweets · plug after tweet ${plug.after}`); continue; }
    await tf.patchDraft(LIFEPAD_SET, id, { platforms: { x: { enabled: true, posts: final } }, tags: [...(d.tags || []).filter((t) => t !== TAG_NEED), TAG_READY] });
    const back = await tf.getDraft(LIFEPAD_SET, id);
    const got = (back.platforms?.x?.posts || []).map((p) => p.text);
    const ok = got.length === final.length && got.every((t, i) => t === final[i].text) && (back.tags || []).includes(TAG_READY) && !(back.tags || []).includes(TAG_NEED);
    done[id] = { link: url, ok };
    fs.writeFileSync(stateFile, JSON.stringify(done, null, 1));
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), row: `d${id}`, kind: 'linked', source: `typefully:${id}`, asins: [plug.asin], links: [url], draftId: id }) + '\n');
    console.log(`  ${ok ? '✓' : '✗ READ-BACK MISMATCH'} ${id} · plug after tweet ${plug.after} · ${url} · Ready to Post`);
  }
}

// ---- cli -----------------------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd] = process.argv.slice(2);
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const work = arg('work');
  if ((!work && cmd !== 'learn') || !['pool', 'check', 'ship', 'queue', 'link', 'learn'].includes(cmd)) {
    console.error('usage: node scripts/lifepad.mjs pool|check|ship|queue|link --work DIR [--n 10] [--days 30] [--min 500000] [--dry] · learn [--dry]');
    process.exit(2);
  }
  const run = cmd === 'learn' ? learn({ dry: process.argv.includes('--dry') })
    : cmd === 'queue' ? queue(work) : cmd === 'link' ? link(work, { dry: process.argv.includes('--dry') }) : cmd === 'pool' ? pool(work, { n: Number(arg('n', 10)), days: Number(arg('days', 30)), min: Number(arg('min', 500000)) })
    : cmd === 'check' ? Promise.resolve(check(work)).then((r) => { if (r.issues.length) process.exitCode = 1; })
      : ship(work, { dry: process.argv.includes('--dry') });
  run.catch((e) => { console.error(e.message || e); process.exit(1); });
}
