#!/usr/bin/env node
// scripts/article-research.mjs — which viral X Articles fit the fleet's article lane (owner, 2026-09-29:
// "use Jev, and find the type of articles that you think would fit very well with what we do"; the game:
// "Self improvement articles + Supplements … skew the topics to slightly make it more related to symptoms of
// certain deficiency and then supplement happens to be one of the plug in the article").
//
//   1. corpus  the XDB Articles table (n8n-x-pipeline's scout: viral native X Articles from the creator roster)
//   2. read    Jev reads each article once (article-fit-read, article-fit.mjs), cached by record and text
//   3. join    reach over the author's own median (so a 4M-follower author does not decide), saves and quotes
//              per 1K views, by where each article sits against the game, its life area, the reader's
//              problem, its format, and each trait
//   4. write   learnings/article-fit.md; the answers (no article text) cached in learnings/article-reads.jsonl (gitignored)
//
//   node scripts/article-research.mjs [--from FILE] [--no-jev] [--out FILE]
//     --from FILE  a saved pull of the table (Airtable records, JSON array); default: read it live
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE_DIR, cliArg, loadEnv, airtable, runMain } from '../lib.mjs';
import {
  ARTICLE_FIT_QUESTIONS, AREAS, PROBLEMS, TRAITS, articleState, fitOf, groupBy, liftRatioRange, summarize, traitsOf, withLift,
} from '../article-fit.mjs';
import { questionSetHash } from '../swipe-classify.mjs';

export const ARTICLES_TABLE = 'tblnvV3IusVkEX6jg';
export const READS = join(HERE_DIR, 'learnings', 'article-reads.jsonl');
export const REPORT = join(HERE_DIR, 'learnings', 'article-fit.md');
// The question set the saved answers were read with: a line read with another set is not reused, so an
// edited or added question re-reads every article instead of reporting stale answers.
export const QSET = questionSetHash(ARTICLE_FIT_QUESTIONS).slice(0, 16);
const FIELDS = ['Title', 'Body Text', 'Preview Text', 'Handle', 'Impressions', 'Bookmarks', 'Quotes', 'Likes', 'Article Type', 'Niche', 'Published Date'];

/** PURE. One table record as the research row. */
export function toRow(rec) {
  const f = rec.fields || {};
  const state = articleState(f);
  return {
    id: rec.id, title: String(f.Title || '').trim(), handle: String(f.Handle || '').trim(), type: f['Article Type'] || 'Other',
    niche: f.Niche || 'Other', views: Number(f.Impressions) || 0, bookmarks: Number(f.Bookmarks) || 0, quotes: Number(f.Quotes) || 0,
    published: f['Published Date'] || null, state, key: createHash('sha256').update(state.article).digest('hex').slice(0, 16),
  };
}

/** PURE. The answers kept on disk: each noul's probability and each choice with its confidence. */
export function digest(answers) {
  const out = {};
  for (const [k, a] of Object.entries(answers || {})) {
    if (a && Number.isFinite(a.noul)) out[k] = { noul: +a.noul.toFixed(4) };
    else if (a && typeof a.choice === 'string') out[k] = { choice: a.choice, confidence: +(a.confidence ?? 0).toFixed(4) };
  }
  return out;
}

/** PURE. The saved answers read with question set `qset`, by record and text. */
export function parseReads(text, qset = QSET) {
  const m = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.qset === qset) m.set(`${r.id}:${r.key}`, r.answers); } catch { /* a torn last line is re-read */ }
  }
  return m;
}
const loadReads = () => parseReads(existsSync(READS) ? readFileSync(READS, 'utf8') : '');

/** Reads every row whose record and text are not cached yet. `ask` is askThrough (tests pass a fake). */
export async function readArticles(rows, { client, ask, concurrency = 12, cache = loadReads(), append = (l) => appendFileSync(READS, l) } = {}) {
  const todo = rows.filter((r) => !cache.has(`${r.id}:${r.key}`));
  let read = 0, failed = 0;
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async (r) => {
      try {
        const res = await ask('article-fit-read', client, { state: r.state, questions: ARTICLE_FIT_QUESTIONS });
        const answers = digest(res.answers);
        cache.set(`${r.id}:${r.key}`, answers); read++;
        append(JSON.stringify({ id: r.id, key: r.key, qset: QSET, answers }) + '\n');
      } catch { failed++; }
    }));
  }
  return { cache, read, failed };
}

const M = (n) => (!Number.isFinite(n) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const X = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}×` : '—');
const D = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const P = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : '—');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const HEAD = '| n | median views | reach vs author | saves /1K | quotes /100K |';
const cells = (s) => `${s.n} | ${M(s.views)} | ${X(s.lift)} | ${D(s.saves)} | ${D(s.quotes)}`;
const GAME = (r) => r.fit === 'as written' || r.fit === 'tilted';

/** PURE. The report, in words and tables. `rows` carry `answers`, `fit`, `traits` and `lift`. */
export function report(rows, { read = 0, failed = 0, cached = 0, builtAt = new Date().toISOString(), rand } = {}) {
  const L = [];
  const readRows = rows.filter((r) => r.answers);
  const dates = rows.map((r) => r.published).filter(Boolean).sort();
  L.push('# Which viral X Articles fit our article lane', '');
  L.push('Owner, 2026-09-29: "use Jev, and find the type of articles that you think would fit very well with what we do." The game,');
  L.push('the same day: "Self improvement articles + Supplements — We can skew the topics to slightly make it more related to symptoms of');
  L.push('certain deficiency and then supplement happens to be one of the plug in the article."', '');
  L.push(`Corpus: the XDB Articles table, ${rows.length} viral native X Articles (${String(dates[0] || '').slice(0, 10)} to ${String(dates.at(-1) || '').slice(0, 10)}). Jev read ${readRows.length}`);
  L.push(`(${read} new, ${cached} cached, ${failed} not read) with article-fit-read (article-fit.mjs). Reach is each article's views over its author's`);
  L.push(`median in the table, for authors with 3+ articles, so a big account does not decide. Built ${builtAt.slice(0, 16).replace('T', ' ')} UTC by scripts/article-research.mjs.`, '');
  L.push('**Caveats.** Every row already cleared a viral floor, so each number reads "among articles that went viral". The roster the scout');
  L.push('watches is mostly AI, tech and business writers, so a topic missing here was mostly never scouted, not proven to fail. Jev\'s');
  L.push('answers are one read each, not calibrated against labels of ours.', '');

  L.push('## 1. Where the viral articles sit against the game', '');
  L.push(`| Group | ${HEAD.slice(2)}`, '|:--|--:|--:|--:|--:|--:|');
  const order = ['as written', 'tilted', 'mind only', 'claims', 'off lane'];
  const say = { 'as written': 'Already there: the problem is a symptom and a supplement fits as a step', tilted: 'One hook into the body: tilt one section toward a deficiency', 'mind only': 'Self-improvement with no hook into the body', claims: 'Self-improvement that claims to treat a disease', 'off lane': 'Not self-improvement (AI, markets, the world)' };
  for (const k of order) { const rs = readRows.filter((r) => r.fit === k); if (rs.length) L.push(`| ${say[k]} | ${cells(summarize(rs))} |`); }
  const game = readRows.filter(GAME), off = readRows.filter((r) => r.fit === 'off lane'), mind = readRows.filter((r) => r.fit === 'mind only');
  const vsOff = liftRatioRange(game, off, { rand }), vsMind = liftRatioRange(game, mind, { rand });
  L.push('');
  if (vsOff) L.push(`Game-fit articles reach ${X(vsOff.ratio)} the off-lane ones against their own authors (95% range ${X(vsOff.lo)} to ${X(vsOff.hi)}).`);
  if (vsMind) L.push(`Against self-improvement pieces with no hook into the body: ${X(vsMind.ratio)} (95% range ${X(vsMind.lo)} to ${X(vsMind.hi)}).`);
  L.push('');

  L.push('## 2. By life area (Jev)', '');
  L.push(`| Area | ${HEAD.slice(2)} fits the game |`, '|:--|--:|--:|--:|--:|--:|--:|');
  for (const g of groupBy(readRows, (r) => r.answers.area?.choice)) L.push(`| ${g.key}: ${cut(AREAS[g.key] || '', 60)} | ${cells(g)} | ${P(g.rows.filter(GAME).length, g.n)} |`);
  L.push('');

  const self = readRows.filter((r) => r.traits.self_improvement);
  L.push(`## 3. The reader's problem, in the ${self.length} self-improvement articles (Jev)`, '');
  L.push(`| Problem | ${HEAD.slice(2)} deficiency symptom | fits the game |`, '|:--|--:|--:|--:|--:|--:|--:|--:|');
  for (const g of groupBy(self, (r) => r.answers.problem?.choice)) {
    L.push(`| ${g.key}: ${cut(PROBLEMS[g.key] || '', 50)} | ${cells(g)} | ${P(g.rows.filter((r) => r.traits.deficiency_symptom).length, g.n)} | ${P(g.rows.filter(GAME).length, g.n)} |`);
  }
  L.push('');

  L.push(`## 4. Formats of the ${game.length} game-fit articles (the table's Article Type)`, '');
  L.push(`| Format | ${HEAD.slice(2)}`, '|:--|--:|--:|--:|--:|--:|');
  for (const g of groupBy(game, (r) => r.type)) L.push(`| ${g.key} | ${cells(g)} |`);
  L.push('');

  L.push(`## 5. What travels inside the ${self.length} self-improvement articles`, '');
  L.push('Each trait at Jev ≥ 0.5, with against without. Medians, so one giant does not decide.', '');
  L.push('| Trait | with | without | views with / without | reach with / without | saves /1K with / without | quotes /100K with / without |', '|:--|--:|--:|--:|--:|--:|--:|');
  for (const t of TRAITS.filter((k) => k !== 'self_improvement')) {
    const a = summarize(self.filter((r) => r.traits[t])), b = summarize(self.filter((r) => !r.traits[t]));
    if (a.n < 3 || b.n < 3) continue;
    L.push(`| ${t.replace(/_/g, ' ')} | ${a.n} | ${b.n} | ${M(a.views)} / ${M(b.views)} | ${X(a.lift)} / ${X(b.lift)} | ${D(a.saves)} / ${D(b.saves)} | ${D(a.quotes)} / ${D(b.quotes)} |`);
  }
  L.push('');

  L.push('## 6. The models: game-fit articles by views', '');
  L.push('| Title | Author | Format | Problem | Fit | Views | Reach vs author | Saves /1K |', '|:--|:--|:--|:--|:--|--:|--:|--:|');
  for (const r of [...game].sort((a, b) => b.views - a.views).slice(0, 25)) {
    L.push(`| ${cut(r.title.replace(/\|/g, '/'), 70)} | @${r.handle} | ${r.type} | ${r.answers.problem?.choice || '—'} | ${r.fit} | ${M(r.views)} | ${r.lift == null ? '—' : X(Math.exp(r.lift))} | ${D((1000 * r.bookmarks) / Math.max(1, r.views))} |`);
  }
  L.push('');
  L.push('## 7. The biggest self-improvement articles with no hook into the body', '');
  L.push('What a heavier tilt would start from: the title skeleton and the format carry over, the topic would have to move.', '');
  L.push('| Title | Author | Format | Area / problem | Views | Saves /1K |', '|:--|:--|:--|:--|--:|--:|');
  for (const r of readRows.filter((x) => x.fit === 'mind only').sort((a, b) => b.views - a.views).slice(0, 12)) {
    L.push(`| ${cut(r.title.replace(/\|/g, '/'), 70)} | @${r.handle} | ${r.type} | ${r.answers.area?.choice} / ${r.answers.problem?.choice} | ${M(r.views)} | ${D((1000 * r.bookmarks) / Math.max(1, r.views))} |`);
  }
  L.push('');
  return L.join('\n');
}

/** PURE. Rows with their answers, traits, fit and lift. */
export function annotate(rows, cache) {
  return withLift(rows).map((r) => {
    const answers = cache.get(`${r.id}:${r.key}`) || null;
    return { ...r, answers, traits: answers ? traitsOf(answers) : {}, fit: answers ? fitOf(answers) : null };
  });
}

async function main() {
  const env = loadEnv();
  const from = cliArg('from', null);
  const records = from ? JSON.parse(readFileSync(from, 'utf8'))
    : await airtable(env, env.XDB_BASE_ID || 'app7vXbBugWeCGctD').listAll(ARTICLES_TABLE, { fields: FIELDS });
  const rows = [];
  for (const rec of records) { try { rows.push(toRow(rec)); } catch { /* a row with no text is skipped */ } }
  let cache = loadReads(), read = 0, failed = 0;
  const cached = rows.filter((r) => cache.has(`${r.id}:${r.key}`)).length;
  if (!process.argv.includes('--no-jev')) {
    const [{ jev }, { askThrough }] = await Promise.all([import('../jev.mjs'), import('../jev-decide.mjs')]); // optional-import
    ({ cache, read, failed } = await readArticles(rows, { client: jev(env), ask: askThrough, cache }));
  }
  const out = cliArg('out', REPORT);
  writeFileSync(out, report(annotate(rows, cache), { read, failed, cached }) + '\n');
  console.log(`article-fit: ${rows.length} articles · ${read} read · ${cached} cached · ${failed} not read → ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runMain(main, 'article-research');
