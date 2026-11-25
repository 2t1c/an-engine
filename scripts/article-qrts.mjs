#!/usr/bin/env node
// scripts/article-qrts.mjs — each page's own QRT engine for its articles: three quote-posts of every
// published article, one a day from the next day, from the page that published it.
//
// Owner, R2026-10-03: "Let's build each page's individual own QRT engine to retweet their own post. each article
// would have 3 QRTs." (This lifts the 2026-09-03 "We do not retweet the tweets" rule for articles only;
// docs/operating-decisions.md.) The practice copies Genius's (docs/article-lane.md section 4): the first quote is a
// claim-free urge to read, the later ones quote a line or a takeaway from the article.
//
// The three texts are written with the article (scripts/run-articles.mjs: qrt1..qrt3 in the package, checked there)
// and ride in the article draft's scratchpad as a "QRTS v1" block, so this job needs nothing from the run
// directory. A quote needs the article's live URL, so the quotes are created only once Typefully reports the article
// published. Idempotent: an article whose scratchpad carries "QRTS created" is skipped, and a quote draft already
// titled for its slot is never created twice.
//
//   node scripts/article-qrts.mjs [--pages a,b] [--days 5] [--dry]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QRT_BLOCK = 'QRTS v1';
export const QRT_DONE = 'QRTS created';
export const QRT_GAP_HOURS = [24, 48, 72];

/** PURE. The QRTS v1 block of a scratchpad -> ['text 1', 'text 2', 'text 3'] (null when absent or incomplete). */
export function qrtsFromScratchpad(text) {
  const s = String(text || '');
  const at = s.indexOf(QRT_BLOCK);
  if (at < 0) return null;
  const out = [];
  for (const line of s.slice(at + QRT_BLOCK.length).split('\n')) {
    const m = line.match(/^\s*([123]):\s?(.*)$/);
    if (m) out[Number(m[1]) - 1] = m[2].replace(/\\n/g, '\n').trim();
    else if (out.length && line.trim() === '') continue;
    else if (out.length >= 3) break;
  }
  return [0, 1, 2].every((i) => out[i]) ? out.slice(0, 3) : null;
}

/** PURE. The block run-articles writes into the article draft's scratchpad. */
export function qrtBlock(texts) {
  return `${QRT_BLOCK}\n${texts.map((t, i) => `${i + 1}: ${String(t).replace(/\n/g, '\\n')}`).join('\n')}`;
}

/** PURE. A quote text's problems: length (X counts the quoted post as the link, so the full 280), no links, no tokens. */
export function qrtIssues(text) {
  const t = String(text || '').trim();
  const issues = [];
  if (!t) issues.push('empty');
  if (t.length > 280) issues.push(`${t.length} characters (280 max)`);
  if (/https?:\/\/|\{\{LINK/i.test(t)) issues.push('a quote carries no link: the quoted article is the link');
  return issues;
}

/** PURE. The minute a quote goes out: its planned time when still ahead, else the next free one from `now`
 *  (+30 min, then 3 hours after any quote of the same article already placed this tick), moved forward until
 *  it is 5 minutes from every fleet booking (`taken`, epoch ms). Two quotes of one article never share a minute. */
export function qrtSlot(plannedIso, { now = Date.now(), taken = [], placed = [], gapMin = 5 } = {}) {
  let t = Date.parse(plannedIso);
  if (!Number.isFinite(t) || t <= now + 10 * 60e3) t = Math.max(now + 30 * 60e3, ...placed.map((p) => p + 3 * 3600e3));
  t = Math.ceil(t / 60e3) * 60e3;
  for (let i = 0; i < 240 && taken.some((x) => Math.abs(x - t) < gapMin * 60e3); i++) t += 60e3;
  return new Date(t).toISOString().replace(/\.000Z$/, 'Z');
}

/** PURE. The three publish times: published_at + 24h, 48h, 72h, on the minute. */
export function qrtTimes(publishedAt, gaps = QRT_GAP_HOURS) {
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return null;
  return gaps.map((h) => new Date(Math.floor((t + h * 3600e3) / 60e3) * 60e3).toISOString().replace(/\.000Z$/, 'Z'));
}

/** PURE. A published draft that is an X Article: a run article's title, or (hand-shipped articles keep their own
 *  title) a draft with no post lane on. Only drafts carrying a QRTS v1 block get quotes, so this can stay broad. */
export const isArticleDraft = (d) => String(d?.draft_title || '').startsWith('[Article]')
  || (d?.x_post_enabled === false && !d.threads_post_enabled && !d.linkedin_post_enabled && !d.bluesky_post_enabled
    && !d.mastodon_post_enabled && !d.substack_post_enabled);

export const qrtTitle = (account, articleId, i) => `[QRT] ${account.name || account.key} · article ${articleId} · ${i + 1}/3`;

async function listDrafts(tf, set, status, maxPages = 6) {
  const out = [];
  for (let p = 0; p < maxPages; p++) {
    const j = await tf.get(`/social-sets/${set}/drafts?status=${status}&limit=50&offset=${p * 50}`);
    const rows = j?.results || j?.drafts || [];
    out.push(...rows);
    if (rows.length < 50) break;
  }
  return out;
}

/** Every scheduled minute across the fleet (epoch ms), read once per tick and only when a quote may be placed. */
async function fleetMinutes(tf, accounts) {
  const out = [];
  for (const a of Object.values(accounts)) {
    if (!a.socialSetId || a.paused) continue;
    for (const d of await listDrafts(tf, a.socialSetId, 'scheduled', 4)) { const t = Date.parse(d.scheduled_date || d.publish_at || ''); if (Number.isFinite(t)) out.push(t); }
  }
  return out;
}

async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const dry = argv.includes('--dry');
  const days = Number(flag('days') || 5);
  const only = flag('pages') ? new Set(flag('pages').split(',')) : null;
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { loadEnv, typefully } = await import('../lib.mjs');
  const tf = typefully(loadEnv());
  let created = 0, waiting = 0, problems = 0, taken = null;
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    if (!account.socialSetId || account.paused || account.burner || (only && !only.has(key))) continue;
    let published = [];
    try { published = await listDrafts(tf, account.socialSetId, 'published', 4); } catch (e) { console.log(`  ✗ ${key}: published drafts not read (${String(e.message).slice(0, 80)})`); problems++; continue; }
    const articles = published.filter((d) => isArticleDraft(d)
      && Date.now() - Date.parse(d.published_at || d.updated_at || 0) <= days * 864e5);
    if (!articles.length) continue;
    let scheduled, unsent;
    try {
      [scheduled, unsent] = await Promise.all([listDrafts(tf, account.socialSetId, 'scheduled', 4), listDrafts(tf, account.socialSetId, 'draft', 4)]);
      if (!taken) taken = await fleetMinutes(tf, ACCOUNTS);
    } catch (e) { console.log(`  ✗ ${key}: queues not read, quotes not created this hour (${String(e.message).slice(0, 80)})`); problems++; continue; }
    for (const a of articles) { try {
      const full = await tf.getDraft(account.socialSetId, a.id);
      const pad = String(full.scratchpad_text || '');
      if (pad.includes(QRT_DONE)) continue;
      const texts = qrtsFromScratchpad(pad);
      const url = full.x_article_published_url || full.platforms?.x_article?.published_url || null;
      if (!texts) { console.log(`  · ${key} article ${a.id}: no ${QRT_BLOCK} block (not a run article)`); continue; }
      if (!url) { console.log(`  · ${key} article ${a.id}: published but no article URL yet`); waiting++; continue; }
      const times = qrtTimes(full.published_at || a.published_at);
      if (!times) { console.log(`  · ${key} article ${a.id}: no published time read yet`); waiting++; continue; }
      const ids = [], placed = [];
      for (const [i, text] of texts.entries()) {
        const title = qrtTitle({ ...account, key }, a.id, i);
        const existing = [...scheduled, ...published, ...unsent].find((d) => d.draft_title === title);
        if (existing && unsent.includes(existing)) { console.log(`  ✗ ${key} article ${a.id} quote ${i + 1}: draft ${existing.id} exists but is not scheduled; read it in Typefully`); problems++; continue; }
        if (existing) { ids.push(String(existing.id)); placed.push(Date.parse(existing.scheduled_date || existing.publish_at || existing.published_at || 0)); continue; }
        const bad = qrtIssues(text);
        if (bad.length) { console.log(`  ✗ ${key} article ${a.id} quote ${i + 1}: ${bad.join('; ')}`); problems++; continue; }
        const at = qrtSlot(times[i], { taken, placed });
        placed.push(Date.parse(at)); taken.push(Date.parse(at));
        const body = { draft_title: title, share: false, publish_at: at, platforms: { x: { enabled: true, posts: [{ text, quote_post_url: url }] } } };
        if (dry) { console.log(`  · ${key} would quote ${url} at ${at}: ${text.slice(0, 80)}`); continue; }
        const d = await tf.createDraft(account.socialSetId, body);
        const back = await tf.getDraft(account.socialSetId, d.id);
        const ok = (back.scheduled_date || back.publish_at) && back.platforms?.x?.posts?.[0]?.quote_post_url;
        console.log(`  ${ok ? '✓' : '✗'} ${key} article ${a.id} quote ${i + 1}/3 → draft ${d.id} at ${back.scheduled_date || back.publish_at || 'NOT SCHEDULED'}`);
        if (ok) { ids.push(String(d.id)); created++; } else problems++;
      }
      // Typefully refuses edits to a published draft, so the marker is best-effort; the title match above is what
      // keeps a quote from being created twice.
      if (!dry && ids.length === 3) await tf.patchDraft(account.socialSetId, a.id, { scratchpad_text: `${pad}\n${QRT_DONE}: ${ids.join(', ')} (${new Date().toISOString()})` }).catch(() => {});
    } catch (e) { console.log(`  ✗ ${key} article ${a.id}: ${String(e.message).slice(0, 120)}`); problems++; } }
  }
  console.log(`article-qrts: ${created} quote(s) scheduled · ${waiting} article(s) waiting for a URL · ${problems} problem(s)${dry ? ' · dry' : ''}`);
  if (problems) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 2; });
}
