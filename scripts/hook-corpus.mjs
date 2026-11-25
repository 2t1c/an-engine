// scripts/hook-corpus.mjs — our own recent hooks with their reach: the baseline the hook fingerprint
// learns from (owner, 2026-09-24: "only look at the data from the last 30 days — at most 90 days.
// Everything prior is noise and the algo changed maybe. Virality has been low so let's just dial in on
// our virality first.").
//
// Two sources (owner, 2026-09-24: "source is both the airtable database and our registry"):
//   ours   the registry (Published Content): every thread we posted in the window;
//   swipe  the swipe database: every creator thread head (Tweet Number 1, 3+ tweets) published in the
//          window, with its Impressions. Each creator is compared with its own median, as each of our
//          pages is, so the model learns what lifts a post above its author's normal.
//
// Read-only. The registry (Published Content) gives every thread we posted in the window with its
// Impressions; its `Post` field is a truncated preview, so tweet 1 is read in full from the Typefully
// draft (fxtwitter by X URL when the draft is gone). Published copy only — nothing unpublished enters
// the repo. The corpus is cached in learnings/hook-corpus.jsonl by draft id, so a re-run re-reads
// reach but fetches only new hooks.
//
// Lanes: threads only (Cover, Harvest, Seed, Remix, Blitz). Singles and Manual posts are another lane
// with another shape; they would teach the thread hook the wrong fingerprint.
//
//   node scripts/hook-corpus.mjs [--days 30]      (clamped to 90)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, typefully, runMain, cliArg, HERE_DIR } from '../lib.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { REGISTRY_TABLE, TABLES } from '../config.mjs';

export const CORPUS = join(HERE_DIR, 'learnings', 'hook-corpus.jsonl');
export const MAX_DAYS = 90;
export const DEFAULT_DAYS = 30;
export const THREAD_LANES = new Set(['Cover', 'Harvest', 'Seed', 'Remix', 'Blitz']);

/** PURE. The window the owner allows: default 30 days, never more than 90, never less than 7. */
export const windowDays = (v) => Math.min(MAX_DAYS, Math.max(7, Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : DEFAULT_DAYS));

/** PURE. Registry row -> corpus row (without the hook text), or null when it is not a thread we can learn from. */
export function corpusRow(rec) {
  const f = rec?.fields || {};
  if (!THREAD_LANES.has(f.Type) || f.Status !== 'Posted') return null;
  const views = Number(f.Impressions);
  if (!Number.isFinite(views) || views <= 0 || !f['Posted Date']) return null;
  return {
    origin: 'ours', draftId: String(f['Draft ID'] || ''), account: String(f.Account || ''), lane: f.Type, postedAt: f['Posted Date'],
    views, likes: Number(f.Likes) || 0, bookmarks: Number(f.Bookmarks) || 0, xUrl: f['X URL'] || null, preview: String(f.Post || ''),
  };
}

/** PURE. Swipe head -> corpus row (hook text included), or null. The creator is the handle in the URL. */
export function swipeRow(rec) {
  const f = rec?.fields || {};
  const views = Number(f.Impressions);
  const handle = String(f['Tweet URL'] || '').match(/x\.com\/([^/?#]+)/i)?.[1];
  const hook = String(f.Text || '').trim();
  if (!handle || !hook || !Number.isFinite(views) || views <= 0 || !f['Published Date']) return null;
  return { origin: 'swipe', draftId: rec.id, account: `@${handle.toLowerCase()}`, lane: 'Swipe', postedAt: f['Published Date'], views, xUrl: f['Tweet URL'], hook, source: 'swipe' };
}

export const readCorpus = (file = CORPUS) => (existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : []);

async function hookText(tf, acc, row) {
  if (acc?.socialSetId && /^\d+$/.test(row.draftId)) {
    try {
      const d = await tf.getDraft(acc.socialSetId, row.draftId);
      const t = d?.platforms?.x?.posts?.[0]?.text;
      if (t) return { text: String(t), source: 'typefully' };
    } catch { /* fall through */ }
  }
  const id = String(row.xUrl || '').match(/status\/(\d+)/)?.[1];
  if (id) {
    try {
      const r = await fetch(`https://api.fxtwitter.com/i/status/${id}`, { signal: AbortSignal.timeout(12000) });
      const t = (await r.json())?.tweet?.text;
      if (t) return { text: String(t), source: 'x' };
    } catch { /* unread */ }
  }
  return null;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'XDB_BASE_ID', 'TYPEFULLY_API_KEY']);
  const days = windowDays(cliArg('days', DEFAULT_DAYS));
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const raw = await at.listAll(REGISTRY_TABLE, {
    formula: `IS_AFTER({Posted Date}, DATEADD(TODAY(), -${days}, 'days'))`,
    fields: ['Draft ID', 'Account', 'Posted Date', 'Impressions', 'Likes', 'Bookmarks', 'Type', 'Status', 'X URL', 'Post'],
  });
  const rows = (Array.isArray(raw) ? raw : raw.items || []).map(corpusRow).filter((r) => r?.draftId);
  const byName = new Map(Object.values(ACCOUNTS).map((a) => [a.name, a]));
  const cached = new Map(readCorpus().filter((r) => r.origin !== 'swipe').map((r) => [r.draftId, r]));
  const tf = typefully(env);
  const out = []; let fetched = 0, unread = 0;
  for (let i = 0; i < rows.length; i += 8) {
    await Promise.all(rows.slice(i, i + 8).map(async (r) => {
      const prev = cached.get(r.draftId);
      let hook = prev?.hook, source = prev?.source;
      if (!hook) { const h = await hookText(tf, byName.get(r.account), r); if (h) { hook = h.text; source = h.source; fetched++; } }
      if (!hook) { unread++; return; }
      out.push({ ...r, hook, source });
    }));
  }
  const swipe = await airtable(env).list(TABLES.swipe, {
    formula: `AND({Tweet Number}=1,{Thread Length}>=3,IS_AFTER({Published Date},DATEADD(NOW(),-${days},"days")))`,
    fields: ['Text', 'Impressions', 'Published Date', 'Tweet URL'], max: 20000, pageSize: 100,
  });
  const swipeRows = swipe.map(swipeRow).filter(Boolean);
  out.push(...swipeRows);
  out.sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  writeFileSync(CORPUS, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`hook corpus: ${days}d · ours: ${rows.length} thread(s) posted, ${out.length - swipeRows.length} with tweet 1 (${fetched} newly read, ${unread} unread and left out) · swipe: ${swipeRows.length} creator thread head(s) → ${CORPUS}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await runMain(main, 'hook-corpus');
