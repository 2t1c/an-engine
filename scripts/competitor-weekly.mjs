// scripts/competitor-weekly.mjs — the weekly us-vs-him report (owner, 2026-09-28: "I want this into a
// weekly comparison between us — find everything you can, and I want a report on performance and
// differences between us"). "Him" is Willie's network: the Direct Competitor cohort in the swipe base's
// Users table, whose every thread (hook and body, one row per tweet) lands in Competitor Threads.
//
// Two halves, both over the same window (default: the 7 days ending 48h ago, so views have settled):
//   PERFORMANCE  threads, total and median views, hit rates (>=250k, >=1M), per page, week over week,
//                and whether our per-thread reach differs from his (Mann-Whitney, normal approximation).
//                Money is ours alone: his clicks and sales are not visible.
//   WRITING      the same text features for both sides (length, hook shape, plug count and position,
//                stat density, numbering, close), measured on full threads: ours from the Typefully
//                draft (fxtwitter for the hook when the draft is gone), his from Competitor Threads.
// Plus: his >=1M threads in the window and whether we have run that hook in the last 30 days.
//
// Writes learnings/competitor-weekly.md (this week) and appends one line to
// learnings/competitor-weekly.jsonl (the trend). Read-only against Airtable, Typefully and X.
// Standing findings from the first study live in docs/competitor-study.md.
//
//   node scripts/competitor-weekly.mjs [--days 7] [--lag-days 2] [--dry]
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, typefully, runMain, cliArg, HERE_DIR } from '../lib.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { REGISTRY_TABLE, TABLES } from '../config.mjs';
import { TBL } from '../config.mjs';

export const REPORT = join(HERE_DIR, 'learnings', 'competitor-weekly.md');
export const HISTORY = join(HERE_DIR, 'learnings', 'competitor-weekly.jsonl');
const COMPETITOR_THREADS = TBL.competitorThreads;
const THREAD_LANES = new Set(['Cover', 'Harvest', 'Seed', 'Remix', 'Blitz']);

// ---------- pure helpers ----------
export const median = (xs) => { const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return 0; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, f) => (xs.length ? Math.round((100 * xs.filter(f).length) / xs.length) : 0);
const words = (s) => (String(s).match(/\S+/g) || []).length;
const DISCLOSURE = /affiliate|commission|medical advice|\bfda\b/i;
// A plug tweet, ours or his: our link (Levanta, Amazon) or his sell script's fixed lines.
const PLUG = /lvnta\.com|amzn\.to|amazon\.com|aff link|\(#ad\)|#ad\b|#affil|thank me later|check it out now|get it here|premium .{0,30} i found|trusted for years|i use it daily/i;
const AUTHORITY = /(doctor|oncologist|cardiologist|neuroscientist|surgeon|scientist|researcher|professor|physician|harvard|stanford)\b[^\n]{0,40}\b(admitted|said|told|reveal|revealed|confess|confessed|warned)/i;

/** PURE. The writing features of one thread (array of tweet texts). */
export function threadFeatures(tweets) {
  const tw = (tweets || []).map((t) => String(t || ''));
  const n = tw.length; const head = tw[0] || ''; const body = tw.slice(1);
  const lines = head.split('\n').filter((l) => l.trim());
  const plugs = tw.map((s, i) => (i > 0 && PLUG.test(s) && !DISCLOSURE.test(s) ? i + 1 : 0)).filter(Boolean);
  return {
    length: n, hookChars: head.length,
    authorityHook: AUTHORITY.test(head),
    equationHook: lines.filter((l) => /^[^=]{2,40}=/.test(l)).length >= 2,
    itemInHook: /^\s*(1[.)]|rule 1|fix 1|#1)/i.test(lines.at(-1) || ''),
    countPromise: /\b\d+\b[^.\n]{0,30}\b(rules?|signs?|ways?|methods?|things?|types?|habits?|foods?|reasons?|steps?|mistakes?)\b/i.test(head),
    capsLine: lines.some((l) => l.replace(/[^A-Za-z]/g, '').length > 10 && l === l.toUpperCase()),
    plugs: plugs.length, firstPlugAt: plugs.length && n ? plugs[0] / n : null,
    wordsPerTweet: median(body.map(words)),
    statsPerTweet: body.length ? body.reduce((a, s) => a + (s.match(/\d+(\.\d+)?\s?(%|x\b|mg|bpm|times|years?|hours?|kg|lbs?)/gi) || []).length, 0) / body.length : 0,
    numbered: body.length ? body.filter((s) => /^\s*(\d+[.)]|rule \d|fix \d|#\d)/i.test(s)).length / body.length : 0,
    emoji: tw.some((s) => /\p{Extended_Pictographic}/u.test(s)), arrow: tw.some((s) => /👇|↓/.test(s)),
    sources: tw.some((s) => /^(science )?sources?:|^references?:|^studies:/i.test(s.trim())),
    questionClose: tw.slice(-3).some((s) => /\?\s*$/m.test(s)),
    disclosureLast: DISCLOSURE.test(tw[n - 1] || ''),
  };
}

/** PURE. Two-sided Mann-Whitney U, normal approximation with tie correction. */
export function mannWhitney(a, b) {
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
  const N = all.length; if (!a.length || !b.length) return { u: 0, z: 0, p: 1 };
  const ranks = new Array(N); let tie = 0;
  for (let i = 0; i < N;) { let j = i; while (j + 1 < N && all[j + 1][0] === all[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[k] = r; const t = j - i + 1; tie += t ** 3 - t; i = j + 1; }
  const r1 = all.reduce((s, x, i) => s + (x[1] === 0 ? ranks[i] : 0), 0);
  const n1 = a.length, n2 = b.length, u = r1 - (n1 * (n1 + 1)) / 2;
  const sd = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1))));
  const z = sd ? (u - (n1 * n2) / 2) / sd : 0;
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  return { u, z, p: Math.max(0, Math.min(1, 1 - erf(Math.abs(z) / Math.SQRT2))) };
}

/** PURE. Reach summary of a set of threads ({views}). */
export function reach(threads) {
  const v = threads.map((t) => t.views);
  return { threads: v.length, total: v.reduce((a, b) => a + b, 0), median: Math.round(median(v)),
    hit250k: pct(v, (x) => x >= 25e4), viral1M: pct(v, (x) => x >= 1e6), top: Math.max(0, ...v) };
}

/** PURE. The writing profile of a set of threads ({tweets}), as the report's table rows. */
export function profile(threads) {
  const f = threads.map((t) => threadFeatures(t.tweets));
  const firsts = f.filter((x) => x.firstPlugAt != null).map((x) => x.firstPlugAt);
  return {
    n: f.length, length: median(f.map((x) => x.length)), le12: pct(f, (x) => x.length <= 12),
    hookChars: Math.round(median(f.map((x) => x.hookChars))), authority: pct(f, (x) => x.authorityHook), equation: pct(f, (x) => x.equationHook),
    itemInHook: pct(f, (x) => x.itemInHook), countPromise: pct(f, (x) => x.countPromise), caps: pct(f, (x) => x.capsLine),
    plugs: median(f.map((x) => x.plugs)), twoPlugs: pct(f, (x) => x.plugs >= 2), firstPlug: Math.round(100 * median(firsts)),
    wordsPerTweet: Math.round(median(f.map((x) => x.wordsPerTweet))), stats: +(f.reduce((a, x) => a + x.statsPerTweet, 0) / (f.length || 1)).toFixed(2),
    numbered: Math.round(100 * median(f.map((x) => x.numbered))), emoji: pct(f, (x) => x.emoji), arrow: pct(f, (x) => x.arrow),
    sources: pct(f, (x) => x.sources), questionClose: pct(f, (x) => x.questionClose), disclosureLast: pct(f, (x) => x.disclosureLast),
  };
}

/** PURE. The first five words of a hook, normalised: how a cover of one of his hooks is recognised. */
export const hookKey = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');

/** PURE. His Competitor Threads rows -> threads ({handle, views, published, tweets, retention}). */
export function hisThreads(rows, cohortRecIds) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const r of rows) {
    const f = r.fields || {};
    if ((f['Tweet Number'] ?? 1) !== 1 || f['Quoted Junk'] || !(f.User || []).some((u) => cohortRecIds.has(u))) continue;
    const kids = (f.Tweets || []).filter((id) => id !== r.id).map((id) => byId.get(id)).filter(Boolean)
      .sort((a, b) => (a.fields['Tweet Number'] || 0) - (b.fields['Tweet Number'] || 0));
    if (!kids.length) continue; // a single post is not a thread
    out.push({ handle: f.Handle, views: Number(f.Impressions) || 0, published: f['Published Date'], url: f['Tweet URL'],
      tweets: [f.Text || '', ...kids.map((k) => k.fields.Text || '')], retention: kids.map((k) => Number(k.fields['Tweet Retention']) || 0) });
  }
  return out;
}

// ---------- report ----------
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const delta = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round((100 * (a - b)) / b)}%` : 'n/a');

export function renderReport({ window, us, usPrev, him, himPrev, usHooks30, unread = 0, unsynced = { now: 0, prev: 0 }, threadsSide = null }) {
  const R = { us: reach(us), him: reach(him), usPrev: reach(usPrev), himPrev: reach(himPrev) };
  const mw = mannWhitney(us.map((t) => t.views), him.map((t) => t.views));
  const P = { us: profile(us.filter((t) => t.tweets.length >= 3)), him: profile(him), himViral: profile(him.filter((t) => t.views >= 1e6)) };
  const pages = (xs, key) => { const o = {}; for (const t of xs) (o[t[key]] ||= []).push(t); return Object.entries(o).map(([k, v]) => ({ page: k, ...reach(v) })).sort((a, b) => b.total - a.total); };
  const covered = new Set(usHooks30.map(hookKey));
  const hisViral = him.filter((t) => t.views >= 1e6).sort((a, b) => b.views - a.views);
  const money = us.reduce((a, t) => ({ rev: a.rev + (t.revenue || 0), clicks: a.clicks + (t.clicks || 0) }), { rev: 0, clicks: 0 });
  const winner = R.us.median > R.him.median ? 'us' : 'him';
  const L = [];
  L.push(`# Us vs him — week of ${window.from} to ${window.to}`, '');
  L.push(`_Generated ${new Date().toISOString().slice(0, 10)} by scripts/competitor-weekly.mjs. "Him" = the Direct Competitor cohort (Willie's network). Views settle for ${window.lagDays} days before a week is read. Standing findings: docs/competitor-study.md._`, '');
  L.push('## Verdict', '');
  L.push(`- **Per thread: ${winner === 'us' ? 'we lead' : 'he leads'}** — median ${fmt(R.us.median)} (us) vs ${fmt(R.him.median)} (him); ${mw.p < 0.05 ? `**significant** (p=${mw.p.toFixed(4)})` : `not significant (p=${mw.p.toFixed(2)})`}.`);
  L.push(`- **Total reach: ${R.us.total >= R.him.total ? 'we lead' : 'he leads'}** — ${fmt(R.us.total)} (us, ${delta(R.us.total, R.usPrev.total)} WoW) vs ${fmt(R.him.total)} (him, ${delta(R.him.total, R.himPrev.total)} WoW).`);
  L.push(`- **Hits:** ≥1M ${R.us.viral1M}% of our threads vs ${R.him.viral1M}% of his; ≥250k ${R.us.hit250k}% vs ${R.him.hit250k}%.`);
  L.push(`- **His ≥1M threads this week: ${hisViral.length}**, ${hisViral.filter((t) => covered.has(hookKey(t.tweets[0]))).length} already covered by us (hook match, last 30 days).`, '');
  L.push('## Performance', '');
  L.push('| | Us | Him | Us last week | Him last week |', '|---|---|---|---|---|');
  for (const [k, lab, f] of [['threads', 'Threads', String], ['total', 'Total views', fmt], ['median', 'Median views', fmt], ['hit250k', '≥250k', (x) => `${x}%`], ['viral1M', '≥1M', (x) => `${x}%`], ['top', 'Best thread', fmt]]) {
    L.push(`| ${lab} | ${f(R.us[k])} | ${f(R.him[k])} | ${f(R.usPrev[k])} | ${f(R.himPrev[k])} |`);
  }
  L.push('', `Our money this week: $${money.rev.toFixed(0)} revenue from ${money.clicks} affiliate clicks (${R.us.total ? `$${((1000 * money.rev) / R.us.total).toFixed(3)}` : 'n/a'} per 1k views). His is not visible.`, '');
  L.push('### Per page', '', '| Page | Side | Threads | Total | Median | ≥1M |', '|---|---|---|---|---|---|');
  for (const p of [...pages(us, 'account').map((p) => ({ ...p, side: 'us' })), ...pages(him, 'handle').map((p) => ({ ...p, side: 'him' }))].sort((a, b) => b.total - a.total)) {
    L.push(`| ${p.page} | ${p.side} | ${p.threads} | ${fmt(p.total)} | ${fmt(p.median)} | ${Math.round((p.viral1M * p.threads) / 100)} |`);
  }
  const ret = (i) => Math.round(1000 * median(him.filter((t) => t.retention.length > i).map((t) => t.retention[i]))) / 10;
  L.push('', `His read-through (median): tweet 2 ${ret(0)}%, tweet 5 ${ret(3)}%, tweet 10 ${ret(8)}%.`, '');
  L.push('## How we write vs how he writes', '', '| | Us | Him | His ≥1M |', '|---|---|---|---|');
  const rows = [['n', 'Threads measured'], ['length', 'Median length'], ['le12', '≤12 tweets %'], ['hookChars', 'Hook chars'], ['authority', 'Authority hook %'],
    ['equation', '"X = Y" hook %'], ['itemInHook', 'Item #1 in hook %'], ['countPromise', 'Count promise in hook %'], ['caps', 'CAPS line in hook %'],
    ['plugs', 'Plug tweets (median)'], ['twoPlugs', '2+ plug tweets %'], ['firstPlug', 'First plug at (% of thread)'], ['wordsPerTweet', 'Words per tweet'],
    ['stats', 'Stats per tweet'], ['numbered', 'Numbered tweets %'], ['emoji', 'Emoji %'], ['arrow', '👇/↓ %'], ['sources', 'Sources tweet %'],
    ['questionClose', 'Question close %'], ['disclosureLast', 'Disclosure last %']];
  for (const [k, lab] of rows) L.push(`| ${lab} | ${P.us[k]} | ${P.him[k]} | ${P.himViral[k]} |`);
  L.push('', '_Writing features have not been shown to cause reach: in the 2026-09-28 study his hits and flops were written alike. Treat gaps as things to test._', '');
  L.push('## His ≥1M threads this week', '');
  if (!hisViral.length) L.push('None.');
  for (const t of hisViral) L.push(`- ${fmt(t.views)} · @${t.handle} · ${String(t.published).slice(0, 10)} · ${covered.has(hookKey(t.tweets[0])) ? 'covered' : '**not covered**'} · ${t.tweets.length} tweets · "${t.tweets[0].split('\n')[0].slice(0, 70)}" ${t.url || ''}`);
  L.push('', '## Our top threads this week', '');
  for (const t of [...us].sort((a, b) => b.views - a.views).slice(0, 5)) L.push(`- ${fmt(t.views)} · ${t.account} · ${t.lane} · "${String(t.tweets[0] || '').split('\n')[0].slice(0, 70)}"`);
  L.push('', '## Coverage', '', `- Ours: ${us.length} threads with views in the window, ${us.filter((t) => t.tweets.length >= 3).length} with full text${unread ? `, ${unread} unread (views counted, writing not measured)` : ''}.`,
    `- **Unsynced X threads (no views in the registry, left out, unverified):** ${unsynced.now} this week, ${unsynced.prev} last week.${unsynced.now + unsynced.prev ? ' Our totals are a floor, not the real number.' : ''}`,
    ...(threadsSide ? [`- Meta Threads cross-posts (not in any number above): ${threadsSide.posts} this week, ${threadsSide.clicks} Threads clicks. Their views are not available: Typefully reports X analytics only.`] : []),
    `- His: ${him.length} threads with full bodies (single posts are excluded).`);
  return { markdown: L.join('\n') + '\n', summary: { from: window.from, to: window.to, us: R.us, him: R.him, p: +mw.p.toFixed(4), usProfile: P.us, himProfile: P.him, hisViral: hisViral.length, unsynced, threadsSide, hisViralCovered: hisViral.filter((t) => covered.has(hookKey(t.tweets[0]))).length, revenue: +money.rev.toFixed(2), clicks: money.clicks } };
}

// ---------- I/O ----------
async function ourText(tf, acc, row) {
  if (acc?.socialSetId && /^\d+$/.test(row.draftId)) {
    try { const d = await tf.getDraft(acc.socialSetId, row.draftId); const posts = (d?.platforms?.x?.posts || []).map((p) => String(p.text || '')); if (posts.length) return posts; } catch { /* fall through */ }
  }
  const id = String(row.xUrl || '').match(/status\/(\d+)/)?.[1];
  if (id) { try { const r = await fetch(`https://api.fxtwitter.com/i/status/${id}`, { signal: AbortSignal.timeout(12000) }); const t = (await r.json())?.tweet?.text; if (t) return [String(t)]; } catch { /* unread */ } }
  return null;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'XDB_BASE_ID', 'TYPEFULLY_API_KEY']);
  const days = Math.max(1, Number(cliArg('days', 7)) || 7), lagDays = Math.max(0, Number(cliArg('lag-days', 2)) || 0);
  const DAY = 864e5, end = Date.now() - lagDays * DAY, start = end - days * DAY, prevStart = start - days * DAY;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const window = { from: iso(start), to: iso(end - 1), lagDays };
  const reg = airtable(env, env.REGISTRY_BASE_ID);
  const regRows = await reg.listAll(REGISTRY_TABLE, {
    formula: `IS_AFTER({Posted Date}, DATEADD(NOW(), -${days * 2 + lagDays + 30}, 'days'))`,
    fields: ['Draft ID', 'Account', 'Posted Date', 'Impressions', 'Type', 'Status', 'X URL', 'Threads URL', 'Post', 'Revenue', 'Affiliate Clicks', 'Threads Clicks'],
  });
  // X ONLY. The registry also holds the [Threads×3] cross-posts to Meta Threads (X switched off on the
  // draft, a Threads URL and no X URL). Typefully reports X analytics only, so they carry no views and
  // are not X threads: they are counted on their own line, never in the X reach numbers. Found
  // 2026-09-28, when 228 of them read as "unsynced" X threads. Since 2026-10-02 registry-sync types
  // them 'Threads' rather than 'Cover', so that Type is let in here for the Threads line.
  const ours = regRows.map((r) => r.fields || {}).filter((f) => (THREAD_LANES.has(f.Type) || f.Type === 'Threads') && f.Status === 'Posted' && f['Posted Date'])
    .map((f) => ({ draftId: String(f['Draft ID'] || ''), account: String(f.Account || ''), lane: f.Type, posted: Date.parse(f['Posted Date']),
      views: Number(f.Impressions) || 0, xUrl: f['X URL'] || null, threadsUrl: f['Threads URL'] || null, preview: String(f.Post || ''),
      revenue: Number(f.Revenue) || 0, clicks: Number(f['Affiliate Clicks']) || 0, threadsClicks: Number(f['Threads Clicks']) || 0 }));
  const inWin = (t, a, b) => t >= a && t < b;
  const onX = (t) => t.lane !== 'Threads' && (!!t.xUrl || !t.threadsUrl);
  const threadsPosts = ours.filter((t) => !onX(t) && inWin(t.posted, start, end));
  // An X thread with no views in the registry is UNSYNCED, not a flop: it is left out of every reach
  // number and counted in the report's coverage line, never read as zero.
  const usAll = ours.filter((t) => onX(t) && inWin(t.posted, start, end)), usPrevAll = ours.filter((t) => onX(t) && inWin(t.posted, prevStart, start));
  const usNow = usAll.filter((t) => t.views > 0), usPrev = usPrevAll.filter((t) => t.views > 0);
  const unsynced = { now: usAll.length - usNow.length, prev: usPrevAll.length - usPrev.length };
  const threadsSide = { posts: threadsPosts.length, clicks: threadsPosts.reduce((a, t) => a + t.threadsClicks, 0) };
  const byName = new Map(Object.values(ACCOUNTS).map((a) => [a.name, a]));
  const tf = typefully(env); let unread = 0;
  for (let i = 0; i < usNow.length; i += 8) {
    await Promise.all(usNow.slice(i, i + 8).map(async (t) => { const tw = await ourText(tf, byName.get(t.account), t); if (tw) t.tweets = tw; else { t.tweets = [t.preview]; unread++; } }));
  }
  for (const t of usPrev) t.tweets = [t.preview];
  const usHooks30 = ours.filter((t) => onX(t) && t.posted >= end - 30 * DAY).map((t) => (t.tweets?.[0] || t.preview));
  const xdb = airtable(env);
  const cohort = await xdb.listAll(TABLES.swipeUsers, { formula: `{Cohort}='Direct Competitor'`, fields: ['Handle'] });
  const cohortIds = new Set(cohort.map((u) => u.id));
  const since = iso(prevStart - DAY);
  const rows = await xdb.listAll(COMPETITOR_THREADS, {
    formula: `IS_AFTER({Published Date}, '${since}')`,
    fields: ['Text', 'Handle', 'User', 'Tweet Number', 'Tweets', 'Impressions', 'Published Date', 'Tweet URL', 'Tweet Retention', 'Quoted Junk'],
  });
  // Folded threads (thread-fold.mjs): their body tweets come from the client, not from rows.
  const bodies = rows.flatMap((r) => (r.fields.Tweets || []).map((id) => xdb.foldedRecord?.(id)).filter(Boolean));
  const his = hisThreads([...rows, ...bodies], cohortIds);
  const himNow = his.filter((t) => inWin(Date.parse(t.published), start, end)), himPrev = his.filter((t) => inWin(Date.parse(t.published), prevStart, start));
  const { markdown, summary } = renderReport({ window, us: usNow, usPrev, him: himNow, himPrev, usHooks30, unread, unsynced, threadsSide });
  if (process.argv.includes('--dry')) { process.stdout.write(markdown); return; }
  writeFileSync(REPORT, markdown);
  appendFileSync(HISTORY, JSON.stringify(summary) + '\n');
  process.stdout.write(markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await runMain(main, 'competitor-weekly');
