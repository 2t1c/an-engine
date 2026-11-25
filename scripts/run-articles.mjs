#!/usr/bin/env node
// scripts/run-articles.mjs — the /run article lane: one native X Article per Premium page per run.
//
// Owner, R2026-10-03: "Every account should do ≥2 articles a week starting next week" (built into the codebase
// for the next run). Two a week is one per run (Sun fills Mon-Thu, Thu fills Fri-Sun; laws.json `articles`).
// The lane is the one scoped in docs/article-lane.md, on the owner's 2026-09-29/30 words: a self-improvement
// article whose problem shows up as a symptom, replicating ONE viral source's title skeleton, format and cover
// style, the supplement as one of its steps (the third protocol), numbered when a listicle, and the fleet gated
// `article-gate.mjs --loose`. Articles are additive: the page's thread that day is untouched.
//
//   node scripts/run-articles.mjs plan     --run-dir RUN --dates 2026-10-05,2026-10-06,... [--pages a,b] [--no-jev]
//   node scripts/run-articles.mjs check    --run-dir RUN [--rows A1006-julian,...]
//   node scripts/run-articles.mjs cover    --run-dir RUN [--rows ...] [--dry]
//   node scripts/run-articles.mjs craft    --run-dir RUN          (an earlier plan, put under the craft rules)
//   node scripts/run-articles.mjs media    --run-dir RUN [--rows ...] [--max-cuts N] [--force] [--dry]
//   node scripts/run-articles.mjs push     --run-dir RUN [--rows ...] [--dry]
//   node scripts/run-articles.mjs approve  --run-dir RUN --rows ... --message "<the owner's exact words>"
//   node scripts/run-articles.mjs hold     --run-dir RUN --rows ... --message "<the owner's exact words>"
//   node scripts/run-articles.mjs veto     --run-dir RUN          (a scheduled run: rows past their deadline)
//   node scripts/run-articles.mjs schedule --run-dir RUN [--rows ...] [--dry]
//   node scripts/run-articles.mjs status   --run-dir RUN
//
// Everything lands in RUN/articles/ (outside the repo: it quotes unpublished copy):
//   plan.json · briefs/<id>.json (the writer's brief) · answers/<id>.md (the writer's package) ·
//   checks.json · covers.json · media.json · review-drafts.json · state.json · schedule.json
// Craft (owner, 2026-10-07; scripts/article-craft.mjs): the plan assigns each article a cover look and a title
// skeleton, rotating across the run; the writer marks {{CLIP: …}} / {{IMAGE: …}} media breaks, which `media`
// fills from the podcast pool and the cover's look before `push`.
// The article is written in the main chat (AGENTS.md); this script only plans, checks and pushes.
// Each article carries its page's three quote-posts (qrt1..qrt3), which scripts/article-qrts.mjs schedules once the
// article is live (owner, R2026-10-03: "each article would have 3 QRTs").
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qrtBlock, qrtIssues } from './article-qrts.mjs';
import { slotIssues } from './run-calendar.mjs';
import { score as scoreTitle } from '../title-score.mjs';
import { COVER_LOOKS, TITLE_RULES, assignArticleModes, assignCoverLooks, modeBrief, topicCap, assignTitleSkeletons, fillMedia, mediaIssues, mediaSlots, skeletonBrief, stripMediaSlots, titleIssues, titlesBlock } from './article-craft.mjs';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 }); };

// ---- pure ---------------------------------------------------------------------------------------

/** The reader problems a page writes for, in order, from its persona line and niches. Config, not judgement:
 *  Jev's article-fit read decides each source's problem; this only says which problems a page carries. */
export const PAGE_PROBLEM_WORDS = Object.freeze([
  [/sleep|circadian|recovery/i, ['sleep', 'fatigue']],
  [/stress|calm|nervous|anxiety|mental health|mood/i, ['stress', 'low_mood']],
  [/cognit|brain|focus|memory|mind/i, ['brain_fog', 'memory']],
  [/habit|consisten|discipline|motivation|fundamentals/i, ['low_drive']],
  [/energy|fatigue|metabolic|gut/i, ['fatigue']],
  [/testosterone|men's|strength|performance|training|gym|recomposition/i, ['low_drive', 'body_decline']],
  [/longevity|aging|ageing|heart|after 35|women's|hormone/i, ['body_decline', 'fatigue']],
]);
export const DEFAULT_PROBLEMS = Object.freeze(['fatigue', 'low_drive', 'stress']);
export function pageProblems(account = {}) {
  const text = [String(account.voice || '').split('\n')[0], ...(account.niches || [])].join(' · ');
  const out = [];
  for (const [re, problems] of PAGE_PROBLEM_WORDS) if (re.test(text)) for (const p of problems) if (!out.includes(p)) out.push(p);
  for (const p of DEFAULT_PROBLEMS) if (!out.includes(p)) out.push(p);
  return out;
}

/** A1006-julian: the article slot id (a thread slot is S1006-julian). */
export const articleRowId = (date, key) => `A${String(date).slice(5, 7)}${String(date).slice(8, 10)}-${key}`;

/** PURE. The run's dates spread across pages: page i takes dates[i % n], so no day carries every article. */
export const articleDate = (dates, i) => dates[i % dates.length];

const ICT = 7 * 3600e3;
const saigonDay = (iso) => new Date(Date.parse(iso) + ICT).toISOString().slice(0, 10);
const ictMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
/** PURE. The article's minute: `gapHours` away from the page's thread that day, inside the ICT window; a page
 *  with no thread that day takes the default minute. Returns an ISO UTC string. */
export function articleSlotUtc({ date, threadUtc = null }, law) {
  const [lo, hi] = (law.windowIct || ['11:00', '23:00']).map(ictMinutes);
  const gap = Number(law.gapHoursFromThread ?? 6) * 60;
  let minutes;
  if (threadUtc) {
    const t = Date.parse(threadUtc) + ICT;
    const thread = new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();
    minutes = thread - gap >= lo ? thread - gap : thread + gap;
    if (minutes > hi) minutes = lo;
  } else minutes = ictMinutes(law.defaultIct || '11:07');
  const day = Date.parse(`${date}T00:00:00Z`) - ICT;
  return new Date(day + minutes * 60e3).toISOString().replace(/\.\d{3}Z$/, ':00Z').replace(/:00:00Z$/, ':00Z');
}

/** PURE. The first legal minute at or after `slotUtc` for this page's article, by run-calendar's own rules
 *  (slotIssues: inside a live posting block, clear of the poller guard, 5 minutes from every fleet booking, one
 *  article per page-day). `bookings` are run-occupancy bookings; the article's own review draft is never one.
 *  Returns { slotUtc, shiftMin } or { slotUtc: null, issues } when nothing in `maxShiftMin` is legal. */
export function legalArticleSlot(slotUtc, key, bookings = [], { nowMs = Date.now(), maxShiftMin = 240, draftId = null } = {}) {
  const others = bookings.filter((b) => !(draftId && String(b.draftId) === String(draftId)))
    .map((b) => ({ account: b.account, lane: b.lane, ms: Date.parse(b.publishAtUtc), draftId: String(b.draftId), label: `${b.account} ${b.lane} ${b.publishAtUtc}` }));
  const start = Date.parse(slotUtc);
  for (let m = 0; m <= maxShiftMin; m++) {
    const post = { account: key, lane: 'article', ms: start + m * 60e3 };
    if (!slotIssues(post, { nowMs, others }).length) return { slotUtc: new Date(post.ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), shiftMin: m };
  }
  return { slotUtc: null, issues: slotIssues({ account: key, lane: 'article', ms: start }, { nowMs, others }) };
}

/** PURE. Why a plug does not fit this page's article, or null: the selection checks' own rules
 *  (scripts/product-allocation.mjs), a proven loser under the EPC floor (pick-product.mjs floorVerdict,
 *  the bar the /run products stop holds a thread's free picks to; a floorExempt product passes), a
 *  product titled for the other sex than the page, or a laws.json product.safetyClash substance on a
 *  source that argues that organ. `rules` = { productSex, safetyClashOf, floorVerdict }; without
 *  floorVerdict the floor is not judged. */
export function articlePlugRefusal({ asin, product, account = {}, source = null }, { productSex, safetyClashOf, floorVerdict = null }) {
  const floor = floorVerdict ? floorVerdict({ ...product, asin }) : null;
  if (floor?.loser) return `proven loser: EPC $${floor.epc.toFixed(3)} on ${floor.clicks} clicks, under the $${floor.floor.toFixed(2)} floor`;
  const own = productSex(product?.title);
  if (['m', 'f'].includes(account.sex) && own && own !== account.sex) return `titled for ${own === 'm' ? 'men' : 'women'} on a ${account.sex === 'm' ? 'male' : 'female'} page`;
  const c = source ? safetyClashOf(asin, { hook: source.title || '', text: source.state?.article || source.text || '' }) : null;
  return c ? `${c.substance} on a ${c.match} article (${c.why})` : null;
}

/** PURE. Rank the Articles-table rows a page could replicate: Jev reads them as the game (fit 'as written' or
 *  'tilted'), their problem is one the page carries, not used in sourceReuseDays and not taken this run.
 *  Topic spread (owner, 2026-10-07: "increase the diversity for the article topics"): fourteen of sixteen pages
 *  list stress first, so ranking by the page's order alone wrote a run of stress articles. `runCount` is how many
 *  articles this run already took per problem: a problem at `topicCap` is left out while the page carries another
 *  with a source, and the least-taken problem comes first, the page's own order breaking ties. */
export function rankSources(rows, { problems = [], used = new Set(), taken = new Set(), runCount = {}, cap = Infinity } = {}) {
  const ok = rows.filter((r) => ['as written', 'tilted'].includes(r.fit) && !used.has(r.tweetId) && !taken.has(r.tweetId));
  const prob = (r) => r.answers?.problem?.choice || null;
  const score = (r) => {
    const i = problems.indexOf(prob(r));
    const problemRank = i < 0 ? problems.length + 1 : i;
    const save = r.views ? r.bookmarks / r.views : 0;
    const n = runCount[prob(r)] || 0;
    return [n >= cap ? 1 : 0, n, problemRank, r.fit === 'as written' ? 0 : 1, -Math.log10(1 + r.views) - 200 * save];
  };
  const cmp = (a, b) => { for (let k = 0; k < a.s.length; k++) if (a.s[k] !== b.s[k]) return a.s[k] - b.s[k]; return 0; };
  return ok.filter((r) => problems.includes(prob(r)))
    .map((r) => ({ r, s: score(r) }))
    .sort(cmp)
    .map(({ r }) => r);
}

/** Article sources come from two pools (owner, 2026-10-08: "split between choosing from existing Article database
 *  and then it can choose from the X Swipe of Threads and instead of cover -> then it's an article format"):
 *  `article`, the Articles table; `thread`, a viral thread from the X Swipe Database written up as an article.
 *  PURE. Which pool each of a run's n articles draws from first: `share` of them threads, spread evenly. */
export function sourceKinds(n, share = 0.5) {
  const s = Math.min(1, Math.max(0, Number(share) || 0));
  return Array.from({ length: n }, (_, i) => (Math.floor((i + 1) * s) > Math.floor(i * s) ? 'thread' : 'article'));
}

/** PURE. A swipe thread record as an Articles-table record, so the same Jev read and ranking take it: the hook is
 *  the title, the whole thread the body. The handle comes from the tweet URL. */
export function swipeAsArticle(rec) {
  const f = rec.fields || {};
  const url = String(f['Tweet URL'] || '');
  const hook = String(f.Text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return { id: rec.id, fields: { Title: hook.slice(0, 200), 'Body Text': String(f['Full Thread Text'] || f.Text || ''), Handle: (url.match(/(?:x|twitter)\.com\/([^/]+)\/status/) || [])[1] || '',
    Impressions: f.Impressions, Bookmarks: 0, 'Article Type': 'Thread', Niche: f.Niche, 'Published Date': f['Published Date'],
    'Tweet URL': url, TweetID: (url.match(/status\/(\d+)/) || [])[1] || rec.id } };
}

/** The brief line that turns a thread source into an article. */
export const THREAD_SOURCE_RULE = 'Source is a viral X thread, not an article (owner, 2026-10-08: "instead of cover -> then it\'s an article format"). Its hook and its points, in the thread\'s order, are the material: the opening carries the hook\'s promise, each tweet that makes a point becomes a section built out with what to do, why it works and how you will know, and the thread\'s list (if it has one) becomes the numbered protocols. Never copy its tweets: every sentence is ours.';

/** PURE. The plugs for a problem: the first sellable products from laws `articles.problemProducts`, never a
 *  product the page's product-fit rules refuse (`refuse(asin)` returns a reason or null). */
export function pickProducts(problem, law, catalog, { refuse = () => null, max = law.plugsMax ?? 2 } = {}) {
  const out = [], skipped = [];
  for (const asin of law.problemProducts?.[problem] || []) {
    const p = catalog.get(asin);
    if (!p || p.unavailable) { skipped.push(`${asin}: not sellable`); continue; }
    const why = refuse(asin, p);
    if (why) { skipped.push(`${asin}: ${why}`); continue; }
    out.push({ asin, title: p.title });
    if (out.length >= max) break;
  }
  return { products: out, skipped };
}

/** PURE. The writer's package: `---` front matter (id, title, scene, listicle, source), then the article
 *  markdown "# Title …", then `---` and the disclaimer. Returns { meta, markdown, body, disclaimer }. */
export function parsePackage(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('package needs --- front matter --- then the article');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  meta.listicle = /^(true|yes)$/i.test(meta.listicle || '');
  const markdown = m[2].trim();
  const cut = markdown.lastIndexOf('\n---\n');
  const body = cut > -1 ? markdown.slice(0, cut).trim() : markdown;
  const disclaimer = cut > -1 ? markdown.slice(cut + 5).trim() : '';
  return { meta, markdown, body, disclaimer };
}

const TOKEN = (i) => (i === 0 ? '{{LINK}}' : `{{LINK${i + 1}}}`);
/** PURE. Plug and footer problems in a package (docs/article-lane.md, "Products inside"). */
export function packageIssues({ meta, body, disclaimer }, { products = [], account = {}, words = [1200, 2000] } = {}) {
  const issues = [];
  const h1 = body.match(/^# (.+)$/m)?.[1] || '';
  if (!h1) issues.push('no "# Title" line');
  if (meta.title && h1 && meta.title !== h1) issues.push('front-matter title differs from the # title');
  if (!meta.scene) issues.push('no cover scene in the front matter');
  const lines = body.split('\n');
  for (const [i, p] of products.entries()) {
    const at = lines.map((l, n) => (l.trim() === TOKEN(i) ? n : -1)).filter((n) => n >= 0);
    if (at.length !== 1) { issues.push(`${TOKEN(i)} (${p.asin}) must sit alone on exactly one line (found ${at.length})`); continue; }
    const before = lines.slice(0, at[0]).join(' ');
    if (before.split(/\s+/).filter(Boolean).length < 300) issues.push(`${TOKEN(i)} sits in the first 300 words`);
    const ask = lines.slice(Math.max(0, at[0] - 3), at[0]).join(' ');
    if (!/\(#ad\)/.test(ask)) issues.push(`${TOKEN(i)}: the ask before it carries no (#ad)`);
  }
  if (/\{\{LINK\d*\}\}/.test(body.replace(/^\{\{LINK\d*\}\}$/gm, ''))) issues.push('a link token sits inside a sentence');
  const stray = (body.match(/\{\{LINK(\d*)\}\}/g) || []).filter((t) => !products.some((_, i) => TOKEN(i) === t));
  if (stray.length) issues.push(`tokens with no product: ${[...new Set(stray)].join(', ')}`);
  if (account.disclaimer && disclaimer !== String(account.disclaimer).trim()) issues.push('the footer is not the page disclaimer verbatim');
  // The page's own three quote-posts of this article (owner, R2026-10-03: "each article would have 3 QRTs").
  for (const k of ['qrt1', 'qrt2', 'qrt3']) for (const why of qrtIssues(meta[k])) issues.push(`${k}: ${why}`);
  const wc = stripMediaSlots(body).replace(/^#.*$/gm, '').split(/\s+/).filter(Boolean).length;
  if (wc < words[0] || wc > words[1] + 200) issues.push(`body is ${wc} words (lane: ${words[0]}–${words[1]})`);
  return issues;
}

/** PURE. x-article-<key>-<product slugs>-<mmdd>, then -b, -c… per later product (the Jasper precedent). */
export function articleSubids(key, products, date) {
  const slug = (t) => String(t || '').toLowerCase().replace(/^(nutricost|sports research®?|why not natural|physician's choice|healthy origins)\s+/i, '')
    .split(/[^a-z0-9]+/).filter(Boolean)[0] || 'p';
  const base = `x-article-${key}-${products.map((p) => slug(p.title).slice(0, 5)).join('-')}-${String(date).slice(5, 7)}${String(date).slice(8, 10)}`;
  return products.map((_, i) => (i === 0 ? base : `${base}-${String.fromCharCode(97 + i)}`));
}

/** PURE. Put each minted link in its token's place; refuse rather than half-fill. */
export function substituteLinks(markdown, products) {
  let out = String(markdown);
  for (const [i, p] of products.entries()) {
    if (!String(p.link || '').startsWith('https://')) return { markdown: null, error: `${p.asin} has no minted link` };
    out = out.split(TOKEN(i)).join(p.link);
  }
  if (/\{\{LINK\d*\}\}/.test(out)) return { markdown: null, error: 'a token is left after substitution' };
  return { markdown: out, error: null };
}

export const REVIEW_PREFIX = '[REVIEW]';
export const reviewTitle = (runId, id, key, title) => `${REVIEW_PREFIX} ${runId} · ${id} · ${key} · article — ${String(title).slice(0, 70)}`;
export const finalTitle = (account, date, title) => `[Article] ${account.name || account.key} · ${String(date).slice(5)} · ${String(title).slice(0, 60)}`;
export const articlePlatforms = (markdown, coverMediaId = null) => ({ x_article: { content_markdown: markdown, ...(coverMediaId ? { cover_media_id: coverMediaId } : {}) } });

/** PURE. A row's deadline: deadlineHours (laws run.scheduled.vetoConsent) before its slot. */
export const deadlineOf = (slotUtc, hours) => new Date(Date.parse(slotUtc) - hours * 3600e3).toISOString();

// ---- io -----------------------------------------------------------------------------------------

function outsideRepo(dir) {
  const real = resolve(dir);
  if (real === ROOT || real.startsWith(ROOT + sep)) throw new Error('RUN_DIR must be outside the repository: it holds unpublished copy');
  return real;
}
const paths = (runDir) => {
  const a = join(outsideRepo(runDir), 'articles');
  return { a, plan: join(a, 'plan.json'), briefs: join(a, 'briefs'), answers: join(a, 'answers'), gate: join(a, 'gate'), media: join(a, 'media.json'),
    checks: join(a, 'checks.json'), covers: join(a, 'covers.json'), drafts: join(a, 'review-drafts.json'), state: join(a, 'state.json'), schedule: join(a, 'schedule.json'),
    sourcesLog: join(ROOT, 'learnings', 'article-sources.jsonl') };
};
const flag = (argv, n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
const rowsFlag = (argv) => (flag(argv, 'rows') ? new Set(flag(argv, 'rows').split(',').map((s) => s.trim()).filter(Boolean)) : null);
const runIdOf = (runDir) => resolve(runDir).split(sep).pop();

async function loadCatalog() {
  const p = JSON.parse(readFileSync(join(ROOT, 'products.json'), 'utf8'));
  const list = Array.isArray(p) ? p : (p.products || Object.entries(p).map(([asin, v]) => ({ asin, ...v })));
  const deny = new Set((JSON.parse(readFileSync(join(ROOT, 'keep-asins.json'), 'utf8')).deny || []).map((d) => d.asin));
  return new Map(list.filter((x) => !deny.has(x.asin)).map((x) => [x.asin, x]));
}

/** The product-fit refusal for an article plug: the selection checks' rules (sellable menu, proven-loser
 *  floor, sex, safety clash). The floor reads learnings/product-board.json the way the /run products stop
 *  does (scripts/plan-product-review.mjs), so an article plug and a thread plug are judged on one set of
 *  numbers; an unreadable board stops the plan rather than letting every product through. */
async function refuser(account, catalog) {
  const [rules, { floorVerdict }] = await Promise.all([import('./product-allocation.mjs'), import('../pick-product.mjs')]);
  const sellable = rules.sellableFor([...catalog.values()]);
  const { perf } = rules.placementContext({ board: JSON.parse(readFileSync(join(ROOT, 'learnings', 'product-board.json'), 'utf8')) });
  const check = { productSex: rules.productSex, safetyClashOf: rules.safetyClashOf, floorVerdict: (p) => floorVerdict(p, perf) };
  return (asin, product, source) => (sellable(asin) ? articlePlugRefusal({ asin, product, account, source }, check) : 'not on the sellable menu (allow list, experiment list, pod)');
}

/** Craft (owner, 2026-10-07): the cover look and the title skeleton are assigned across the whole run, so no look
 *  or skeleton crowds it out, and no page repeats its previous article's look (scripts/article-craft.mjs). Rows that
 *  already carry a look keep it; `briefs` are rewritten with the craft rules. */
function applyCraft(plan, briefs, P) {
  const planned = plan.rows.filter((r) => r.status === 'planned');
  const lastLook = {};
  for (const e of existsSync(P.sourcesLog) ? readFileSync(P.sourcesLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) if (e.look) lastLook[e.page] = e.look;
  const looks = assignCoverLooks(planned, { lastLook });
  const modes = assignArticleModes(planned);
  planned.forEach((r, i) => { r.mode ||= modes[i]; });
  const skeletons = assignTitleSkeletons(planned.map((r) => ({ ...r, listicle: /listicle/i.test(String(r.source?.type || '')) })));
  planned.forEach((r, i) => { r.look ||= looks[i]; r.skeleton ||= skeletons[i]; });
  plan.craft = 'article-craft-v1';
  for (const b of briefs) {
    const r = planned.find((x) => x.id === b.id);
    if (!r) continue;
    const look = COVER_LOOKS.find((l) => l.id === r.look);
    b.craft = { look: r.look, skeleton: r.skeleton, mode: r.mode };
    b.rules = (b.rules || []).filter((x) => !/^(Title \(style\/title-templates|Cover look: |Media breaks \(|Mode: )/.test(x));
    b.rules.push(
      modeBrief(r.mode),
      `Title (style/title-templates.md; the plan assigned this skeleton so the run spreads across the framework): ${skeletonBrief(r.skeleton)} Fill it for this article, sentence case, 36 to 63 characters, no proper noun, never "isn't X. It's Y." in any costume. It must classify as ${r.skeleton} and score ${TITLE_RULES.minScore}/10 or more (node title-score.mjs "<title>"). Then fill at least ${TITLE_RULES.alternates} more titles across at least ${TITLE_RULES.alternateSkeletons} skeletons from node title-score.mjs --for <format>, scored, as the alternates.`,
      `Cover look: ${r.look} (style/cover-graphic-styles.md, "${r.look}"), for ${look.fits}. Write the scene as one visual sentence in that look's grammar, about this article's idea. Never describe the source's cover, a screenshot, a page of text or a word.`,
      'Media breaks (owner, 2026-10-07: "Clipping from the podcast, adding them in … Split the content up to make it more readable"): 3 to 5 lines that each hold only {{CLIP: <one claim, in a sentence, that a podcast clip should prove>}} or {{IMAGE: <one scene, in the cover look, that shows this section\'s idea>}}, at least 2 of them clips. Put each after the paragraph it proves, at least 150 words apart, none in the first 120 words, never beside a plug. `run-articles.mjs media` finds the clip in the podcast pool and draws the image; a slot it cannot fill is dropped.',
    );
    writeJson(join(P.briefs, `${b.id}.json`), b);
  }
}

/** `craft`: put an earlier plan (before 2026-10-07) under the craft rules, for a rewrite of its articles. */
function craftCmd(argv) {
  const P = paths(flag(argv, 'run-dir'));
  const plan = readJson(P.plan); if (!plan) throw new Error('no plan');
  const briefs = plan.rows.filter((r) => r.status === 'planned').map((r) => readJson(join(P.briefs, `${r.id}.json`))).filter(Boolean);
  applyCraft(plan, briefs, P);
  writeJson(P.plan, plan);
  for (const r of plan.rows.filter((x) => x.status === 'planned')) console.log(`  ${r.id.padEnd(16)} ${r.look.padEnd(10)} ${r.skeleton}`);
}

async function planCmd(argv) {
  const runDir = flag(argv, 'run-dir'), dates = String(flag(argv, 'dates') || '').split(',').filter(Boolean);
  if (!runDir || !dates.length) throw new Error('plan needs --run-dir RUN --dates YYYY-MM-DD,...');
  const P = paths(runDir);
  if (existsSync(P.plan)) throw new Error(`${P.plan} exists: the plan is written once per run (delete it by hand to replan)`);
  const { LAWS } = await import('../laws.mjs');
  const law = LAWS.articles;
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { readPremium, premiumFresh } = await import('./x-premium.mjs');
  const { VOICE_BLOCKS_ON } = await import('../laws.mjs');
  const premium = readPremium();
  if (!premium || !premiumFresh(premium, law.premiumMaxAgeDays)) throw new Error('queues/x-premium.json is missing or stale: run `node scripts/x-premium.mjs` first');
  let calendar = null;
  try { calendar = (await import('./run-calendar.mjs')).approvedCalendar(runDir); } catch { /* no approved brief: default minutes */ }
  const threadPages = calendar ? new Set(calendar.slots.map((s) => s.account || String(s.slotId).split('-').slice(1).join('-'))) : null;
  const only = flag(argv, 'pages') ? new Set(flag(argv, 'pages').split(',')) : null;
  const pages = Object.entries(ACCOUNTS).filter(([k, a]) => a.handle && a.socialSetId && !a.paused && !a.burner && !a.client && !a.external
    && (!threadPages || threadPages.has(k)) && (!only || only.has(k)));
  const skipped = pages.filter(([k]) => premium.pages[k] !== true).map(([k]) => `${k}: ${premium.pages[k] === false ? 'no X Premium' : 'X Premium unknown'}`);
  const eligible = pages.filter(([k]) => premium.pages[k] === true);

  // The source pool: the Articles table, read by Jev (article-fit-read, cached in learnings/article-reads.jsonl).
  const research = await import('./article-research.mjs');
  const { loadEnv, airtable } = await import('../lib.mjs');
  const env = loadEnv();
  const records = await airtable(env, env.XDB_BASE_ID || 'app7vXbBugWeCGctD').listAll(research.ARTICLES_TABLE,
    { fields: ['Title', 'Body Text', 'Preview Text', 'Handle', 'Impressions', 'Bookmarks', 'Quotes', 'Likes', 'Article Type', 'Niche', 'Published Date', 'Tweet URL', 'TweetID', 'Cover Image', 'Cover Palette', 'Word Count', 'Subheads'] });
  const recById = new Map(records.map((r) => [r.id, r]));
  const rows = [];
  for (const rec of records) { try { rows.push(research.toRow(rec)); } catch { /* no text */ } }
  let cache = research.parseReads(existsSync(research.READS) ? readFileSync(research.READS, 'utf8') : '');
  if (!argv.includes('--no-jev')) {
    const [{ jev }, { askThrough }] = await Promise.all([import('../jev.mjs'), import('../jev-decide.mjs')]);
    ({ cache } = await research.readArticles(rows, { client: jev(env), ask: askThrough, cache }));
  }
  // The second pool: viral threads from the X Swipe Database (laws.json articles.swipeShare of the run), the cover
  // picker's own floor. A thread this run covers, or covered lately, stays a cover; one taken here is held from
  // the cover picker (pick-donors.mjs reads the sources log). The most-viewed swipeReadMax are read by Jev.
  const share = Number(flag(argv, 'swipe-share') ?? law.swipeShare ?? 0);
  if (share > 0) {
    const { TABLES } = await import('../config.mjs');
    const { loadBurnLedger, isBurned } = await import('../donor-burn.mjs');
    const burn = loadBurnLedger(join(ROOT, 'queues'));
    const swipe = await airtable(env, env.XDB_BASE_ID || 'app7vXbBugWeCGctD').listAll(TABLES.swipe, {
      formula: `AND({Tweet Number}=1,{Thread Length}>=${law.swipeMinLength ?? 5},NOT({Quoted Junk}),NOT({Single Tweet}),NOT({Drafted}),{Impressions}>=${law.swipeMinViews ?? 250000},{Niche}='Health',IS_AFTER({Published Date},DATEADD(NOW(),-${law.swipeMaxAgeDays ?? 365},"days")))`,
      fields: ['Text', 'Full Thread Text', 'Impressions', 'Published Date', 'Tweet URL', 'Niche', 'Thread Length'], pageSize: 100 });
    // The cover picker's own donor screen (preflight.mjs screenDonor): banned topics, explicit or off-niche hooks,
    // prescription drugs, threads that are mostly someone else's funnel.
    const { screenDonor } = await import('../preflight.mjs');
    const products = JSON.parse(readFileSync(join(ROOT, 'products.json'), 'utf8')).products;
    const fresh = swipe.filter((r) => screenDonor({ ...r.fields, recId: r.id }, { products }).usable && !isBurned(r.id, burn, { window: 2, burnDays: law.swipeCoverDays ?? 30, maxUses: 0 }))
      .sort((a, b) => (Number(b.fields.Impressions) || 0) - (Number(a.fields.Impressions) || 0)).slice(0, law.swipeReadMax ?? 80);
    for (const rec of fresh.map(swipeAsArticle)) {
      recById.set(rec.id, rec);
      try { rows.push({ ...research.toRow(rec), kind: 'thread' }); } catch { /* no text */ }
    }
    console.log(`swipe pool: ${swipe.length} health threads; the ${fresh.length} most viewed that pass the donor screen and were not covered lately go to the ranking`);
  }
  if (!argv.includes('--no-jev')) {
    const [{ jev }, { askThrough }] = await Promise.all([import('../jev.mjs'), import('../jev-decide.mjs')]);
    ({ cache } = await research.readArticles(rows.filter((r) => r.kind === 'thread'), { client: jev(env), ask: askThrough, cache }));
  }
  const annotated = research.annotate(rows, cache).map((r) => ({ ...r, kind: r.kind || 'article', tweetId: String(recById.get(r.id)?.fields?.TweetID || r.id) }));
  const kinds = sourceKinds(eligible.length, share);
  const usedSince = Date.now() - law.sourceReuseDays * 864e5;
  const used = new Set((existsSync(P.sourcesLog) ? readFileSync(P.sourcesLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e) => Date.parse(e.at) >= usedSince).map((e) => String(e.tweetId)));

  const catalog = await loadCatalog();
  const taken = new Set();
  const runCount = {}; // articles this run per problem (topic spread)
  const cap = topicCap(eligible.length);
  const briefs = [];
  const plan = { schema: 'run-articles-plan-v1', runId: runIdOf(runDir), dates, builtAt: new Date().toISOString(), law, skipped, rows: [] };
  for (const [i, [key, account]] of eligible.entries()) {
    const date = articleDate(dates, i);
    const thread = calendar?.slots.find((s) => s.date === date && (s.account === key || String(s.slotId).endsWith(`-${key}`)));
    const slotUtc = articleSlotUtc({ date, threadUtc: thread?.utc || null }, law);
    const problems = pageProblems(account);
    const refuse = await refuser({ ...account, key }, catalog);
    let picked = null, products = null, why = [];
    const first = kinds[i], pools = [annotated.filter((r) => r.kind === first), annotated.filter((r) => r.kind !== first)];
    for (const src of pools.flatMap((pool) => rankSources(pool, { problems, used, taken, runCount, cap }))) {
      const pick = pickProducts(src.answers?.problem?.choice, law, catalog, { refuse: (asin, p) => refuse(asin, p, src) });
      if (pick.products.length) { picked = src; products = pick.products; break; }
      why.push(`${src.tweetId}: ${pick.skipped.join('; ')}`);
    }
    const id = articleRowId(date, key);
    if (!picked) { plan.rows.push({ id, key, date, slotUtc, status: 'held', reason: `no source the page can carry with a sellable plug (${problems.join(', ')})`, tried: why.slice(0, 5) }); continue; }
    taken.add(picked.tweetId);
    runCount[picked.answers?.problem?.choice] = (runCount[picked.answers?.problem?.choice] || 0) + 1;
    const rec = recById.get(picked.id)?.fields || {};
    const row = { id, key, account: account.name, date, slotUtc, status: 'planned', problems, problem: picked.answers?.problem?.choice,
      source: { kind: picked.kind, ...(picked.kind === 'thread' ? { swipeRec: picked.id } : {}), tweetId: picked.tweetId, url: rec['Tweet URL'] || null, title: picked.title, handle: picked.handle, type: picked.type, niche: picked.niche,
        views: picked.views, bookmarks: picked.bookmarks, fit: picked.fit, cover: rec['Cover Image']?.[0]?.url || null, palette: rec['Cover Palette'] || null,
        words: rec['Word Count'] || null, subheads: rec.Subheads || null },
      products };
    plan.rows.push(row);
    briefs.push({
      id, account: key, page: { name: account.name, handle: account.handle, persona: VOICE_BLOCKS_ON ? String(account.voice || '') : '', disclaimer: account.disclaimer, plugExample: account.plugHeavyExample || null },
      source: { ...row.source, body: String(rec['Body Text'] || rec['Preview Text'] || '').slice(0, 24000) },
      problem: row.problem, products,
      rules: [
        row.source.kind === 'thread' ? THREAD_SOURCE_RULE : 'Replica (docs/article-lane.md section 3): the source\'s format and section order, in our own words. Never copy its sentences. The title and the cover follow the craft block below, not the source.',
        'The owner\'s structure (2026-09-29): a short intro naming the problems, one section per protocol (what to do, why it works, how you will know), the supplement as the THIRD protocol with its plug, then a wrap-up with the whole plan as steps. A listicle numbers every item (**1. …**), the intro says how many, and the TLDR repeats the numbers.',
        'The tilt is one section: the symptom, the deficiency that can sit behind it, and what to check. Never a cure, treat or prevent claim; no banned topics; no absolute superlatives.',
        `Body ${law.words[0]}–${law.words[1]} words, in the page's persona voice, first person where the persona speaks.`,
        'Each plug sits inside the section that argues its step, as four one-sentence paragraphs: the criterion question; the routine with a since-month and one literal outcome; the possessive CTA carrying (#ad); then the link token alone on its own line ({{LINK}} for the first product, {{LINK2}} for the second). Never in the first 300 words, never the last paragraph of a section.',
        'End with a line holding only ---, then the page disclaimer verbatim.',
        'Three quote-posts of this article from the page (owner, R2026-10-03: "each article would have 3 QRTs"), posted one a day from the day after it publishes: qrt1 is a claim-free urge to read it; qrt2 quotes one line from it; qrt3 gives one takeaway or the number of steps. Each at most 280 characters, no link (the quoted article is the link), the page voice, no cure/treat/prevent claim. Write a line break as \\n.',
        'Output RUN/articles/answers/<id>.md: front matter (--- id, title, titles (the alternates, separated by " | "), look (the assigned cover look), scene (one sentence: the cover scene in that look\'s grammar; no words in the image), listicle (true|false), source (url), qrt1, qrt2, qrt3 ---), then the article starting "# <title>".',
      ] });
  }
  applyCraft(plan, briefs, P);
  writeJson(P.plan, plan);
  // A thread taken here is held from the cover picker from now, not from schedule: covers may be picked after this.
  const held = plan.rows.filter((r) => r.source?.swipeRec);
  if (held.length) writeFileSync(P.sourcesLog, held.map((r) => `${JSON.stringify({ at: new Date().toISOString(), tweetId: r.source.tweetId, page: r.key, runId: plan.runId, articleDraft: null, planned: r.id, kind: 'thread', swipeRec: r.source.swipeRec })}\n`).join(''), { flag: 'a' });
  for (const r of plan.rows) console.log(`  ${r.id.padEnd(16)} ${r.status.padEnd(8)} ${r.slotUtc}  ${r.source ? `${r.problem} · ${r.source.title.slice(0, 60)} (${Math.round(r.source.views / 1000)}K) · ${r.products.map((p) => p.asin).join('+')} · ${r.source.kind} · ${r.look} · ${r.skeleton} · ${r.mode}` : r.reason}`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  console.log(`articles: ${plan.rows.filter((r) => r.status === 'planned').length} planned · ${plan.rows.filter((r) => r.status === 'held').length} held · ${skipped.length} skipped → ${P.plan}`);
}

function selected(plan, argv) { const only = rowsFlag(argv); return plan.rows.filter((r) => r.status !== 'held' && (!only || only.has(r.id))); }

async function checkCmd(argv) {
  const runDir = flag(argv, 'run-dir'); const P = paths(runDir);
  const plan = readJson(P.plan); if (!plan) throw new Error('no plan: run plan first');
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { bannedTopicIssue, hardHealthClaimMatch, absoluteSuperlativeIssue } = await import('../checks.mjs');
  const checks = readJson(P.checks, {});
  for (const row of selected(plan, argv)) {
    const file = join(P.answers, `${row.id}.md`);
    if (!existsSync(file)) { checks[row.id] = { ok: false, issues: ['no package written yet'] }; console.log(`  ✗ ${row.id.padEnd(16)} no package`); continue; }
    const text = readFileSync(file, 'utf8');
    let pkg; try { pkg = parsePackage(text); } catch (e) { checks[row.id] = { ok: false, issues: [e.message] }; console.log(`  ✗ ${row.id} ${e.message}`); continue; }
    const account = ACCOUNTS[row.key];
    const issues = packageIssues(pkg, { products: row.products, account, words: plan.law.words });
    const banned = bannedTopicIssue(pkg.body); if (banned) issues.push(`banned topic: ${banned}`);
    for (const para of pkg.body.split(/\n\s*\n/)) {
      const claim = hardHealthClaimMatch(para); if (claim) issues.push(`hard health claim: "${claim}"`);
      const sup = absoluteSuperlativeIssue(para); if (sup) issues.push(`superlative: ${sup}`);
    }
    // The gate reads "# Title … body", stopping at the footer's ---.
    mkdirSync(P.gate, { recursive: true });
    const gateFile = join(P.gate, `${row.id}.md`); writeFileSync(gateFile, `${stripMediaSlots(pkg.body)}\n\n---\n\n${pkg.disclaimer}\n`, { mode: 0o600 });
    let gate;
    try {
      const out = execFileSync('node', [join(ROOT, 'article-gate.mjs'), gateFile, '--json', '--loose', '--min', String(plan.law.words[0]), '--max', String(plan.law.words[1]), ...(pkg.meta.listicle ? ['--listicle'] : [])], { encoding: 'utf8', cwd: ROOT });
      gate = JSON.parse(out);
    } catch (e) { try { gate = JSON.parse(e.stdout || '{}'); } catch { gate = { error: String(e.stderr || e.message).slice(0, 200) }; } }
    const gateFails = gate?.error ? [gate.error] : (Array.isArray(gate?.checks) ? gate.checks.filter((c) => c && c.ok === false && !c.advisory).map((c) => `gate: ${c.name}${c.value != null ? ` ${c.value}` : ''}${c.target ? ` (target ${c.target})` : ''}`)
      : ['gate: no checks read from article-gate --json']);
    issues.push(...gateFails);
    const titleScore = pkg.meta.title ? scoreTitle(pkg.meta.title).score : null;
    // Craft (owner, 2026-10-07): the assigned skeleton, the title framework's bar and alternates, the assigned
    // cover look, and the media breaks (scripts/article-craft.mjs).
    // A plan written before the craft rules (no plan.craft) is checked as it was; `craft` puts it under them.
    if (plan.craft) {
      issues.push(...titleIssues(pkg.meta, { skeleton: row.skeleton || null }));
      if (row.look && pkg.meta.look !== row.look) issues.push(`cover look is ${pkg.meta.look || 'unset'}; the plan assigned ${row.look}`);
      issues.push(...mediaIssues(pkg.body));
    } else if (titleScore != null && titleScore < 8) issues.push(`title-score ${titleScore}/10 (8 or more)`);
    checks[row.id] = { ok: !issues.length, issues, revision: sha(text), titleScore, gate: Array.isArray(gate?.checks) ? `${gate.passed}/${gate.total}` : null, at: new Date().toISOString() };
    console.log(`  ${issues.length ? '✗' : '✓'} ${row.id.padEnd(16)} ${issues.length ? issues.slice(0, 4).join(' · ') : `clean · title ${titleScore ?? '?'}/10`}`);
  }
  writeJson(P.checks, checks);
}

async function coverCmd(argv) {
  const runDir = flag(argv, 'run-dir'); const P = paths(runDir); const dry = argv.includes('--dry');
  const plan = readJson(P.plan); const checks = readJson(P.checks, {}); const covers = readJson(P.covers, {});
  for (const row of selected(plan, argv)) {
    if (!checks[row.id]?.ok) { console.log(`  · ${row.id} not clean yet: no cover`); continue; }
    if (covers[row.id]?.mediaId && covers[row.id]?.revision === checks[row.id].revision) { console.log(`  · ${row.id} cover ${covers[row.id].mediaId}`); continue; }
    const { meta } = parsePackage(readFileSync(join(P.answers, `${row.id}.md`), 'utf8'));
    // The article lane's eight graphic looks, one per article as the plan assigned them (owner, 2026-10-07: "we have
    // set a few formats that we can choose from"). No --ref to the source's cover: copying it drew screenshots,
    // book pages and words into R2026-10-08's covers, and pulled half of them into the same ink medium.
    const look = row.look || meta.look || 'concept';
    const args = [join(ROOT, 'cover-gen.mjs'), '--style', 'graphic', '--look', look, '--scene', meta.scene, '--crop', '5:2', '--upload', row.key, '--out', join(P.a, 'covers', `${row.id}.png`)];
    if (dry) { console.log(`  · ${row.id} would run: node ${args.slice(0).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`); continue; }
    mkdirSync(join(P.a, 'covers'), { recursive: true });
    let out = '';
    try { out = execFileSync('node', args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 }); } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
    const mediaId = out.match(/media id (\S+)/)?.[1] || null;
    covers[row.id] = { mediaId, revision: checks[row.id].revision, at: new Date().toISOString(), ...(mediaId ? {} : { error: out.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200) }) };
    console.log(`  ${mediaId ? '✓' : '✗'} ${row.id.padEnd(16)} ${mediaId || covers[row.id].error}`);
    writeJson(P.covers, covers);
  }
  writeJson(P.covers, covers);
}

/** The media pass (owner, 2026-10-07: "Clipping from the podcast, adding them in … Split the content up"). Each
 *  {{CLIP: claim}} is matched by Jev against the Clip Library and every podcast in the pool (scripts/clip-find.mjs,
 *  the thread lane's matcher), cut and uploaded to the page; each {{IMAGE: scene}} is drawn in the article's cover
 *  look. media.json records, per row and copy revision, which slot got which media id; push embeds them and drops
 *  a slot that found nothing. A row whose copy is unchanged since its pass is skipped (--force redoes it). */
async function mediaCmd(argv) {
  const runDir = flag(argv, 'run-dir'); const P = paths(runDir); const dry = argv.includes('--dry');
  const plan = readJson(P.plan); const checks = readJson(P.checks, {}); const media = readJson(P.media, {});
  let cutsLeft = Number(flag(argv, 'max-cuts') ?? 16);
  const tmp = join(P.a, 'media-tmp'); mkdirSync(tmp, { recursive: true });
  for (const row of selected(plan, argv)) {
    if (!checks[row.id]?.ok) { console.log(`  · ${row.id} not clean yet: no media`); continue; }
    if (!argv.includes('--force') && media[row.id]?.revision === checks[row.id].revision) { console.log(`  · ${row.id} media done for this copy`); continue; }
    const { body, meta } = parsePackage(readFileSync(join(P.answers, `${row.id}.md`), 'utf8'));
    const slots = mediaSlots(body).map((x) => ({ line: x.line, kind: x.kind, text: x.text, mediaId: null, why: null }));
    const clips = slots.filter((x) => x.kind === 'clip');
    if (clips.length) {
      const out = join(tmp, `${row.id}-clips.json`);
      const args = [join(ROOT, 'scripts', 'clip-find.mjs'), ...clips.flatMap((x) => ['--tweet', x.text]), '--pool', '--account', row.key, '--out', out,
        ...(dry ? [] : ['--cut', '--upload-only', '--use-label', `article:${plan.runId}:${row.id}`, '--max-cuts', String(Math.max(0, cutsLeft))])];
      try { execFileSync('node', args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { console.log(`  ✗ ${row.id} clip-find: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-1)[0]}`); }
      const report = readJson(out, {});
      (report.decisions || []).forEach((d, i) => {
        clips[i].why = d.pick ? `${d.action} · ${d.pick.title || d.pick.sourceId} · fit ${Number(d.pick.fit || 0).toFixed(2)}` : `${d.action}: no passage proves it`;
      });
      for (const a of report.placed?.attached || []) if (clips[a.index]) {
        clips[a.index].mediaId = a.mediaId;
        if (report.decisions?.[a.index]?.action === 'cut') cutsLeft--; // a fresh cut; a stored clip costs none
      }
    }
    for (const x of slots.filter((y) => y.kind === 'image')) {
      const args = [join(ROOT, 'cover-gen.mjs'), '--style', 'graphic', '--look', row.look || meta.look || 'concept', '--scene', x.text, '--upload', row.key, '--out', join(tmp, `${row.id}-L${x.line}.png`)];
      if (dry) { x.why = 'dry: not drawn'; continue; }
      let o = ''; try { o = execFileSync('node', args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 }); } catch (e) { o = `${e.stdout || ''}${e.stderr || ''}`; }
      x.mediaId = o.match(/media id (\S+)/)?.[1] || null;
      x.why = x.mediaId ? `image · ${row.look || meta.look}` : `image failed: ${o.split('\n').filter(Boolean).slice(-1)[0] || 'no output'}`.slice(0, 200);
    }
    const placed = slots.filter((x) => x.mediaId).length;
    if (!dry) media[row.id] = { revision: checks[row.id].revision, slots, at: new Date().toISOString() };
    console.log(`  ${placed >= 2 ? '✓' : '✗'} ${row.id.padEnd(16)} ${placed}/${slots.length} media · ${slots.map((x) => `${x.kind}:${x.mediaId ? 'ok' : (x.why || 'none').split(':')[0]}`).join(' ')}`);
    if (!dry) writeJson(P.media, media);
  }
}

async function findReviewDraft(tf, set, prefix) {
  const out = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const j = await tf.get(`/social-sets/${set}/drafts?status=draft&limit=50&offset=${offset}`);
    const results = j?.results || j?.drafts || [];
    out.push(...results.filter((d) => String(d.draft_title || '').startsWith(prefix)));
    if (results.length < 50) break;
  }
  return out;
}

async function pushCmd(argv) {
  const runDir = flag(argv, 'run-dir'); const P = paths(runDir); const dry = argv.includes('--dry');
  const plan = readJson(P.plan); const checks = readJson(P.checks, {}); const covers = readJson(P.covers, {}); const ledger = readJson(P.drafts, {});
  const media = readJson(P.media, {});
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { loadEnv, typefully } = await import('../lib.mjs');
  const tf = dry ? null : typefully(loadEnv());
  for (const row of selected(plan, argv)) {
    if (!checks[row.id]?.ok) { console.log(`  · ${row.id} not clean: not pushed`); continue; }
    const text = readFileSync(join(P.answers, `${row.id}.md`), 'utf8');
    if (sha(text) !== checks[row.id].revision) { console.log(`  ✗ ${row.id} the package changed since its check: re-run check`); continue; }
    // The media pass must have run on this copy (owner, 2026-10-07); --no-media pushes the text alone, slots dropped.
    if (plan.craft && media[row.id]?.revision !== checks[row.id].revision && !argv.includes('--no-media')) { console.log(`  ✗ ${row.id} no media pass on this copy: run media (or push --no-media)`); continue; }
    const slots = media[row.id]?.revision === checks[row.id].revision ? media[row.id].slots : [];
    const { meta, markdown: raw } = parsePackage(text);
    const markdown = fillMedia(raw, slots);
    const set = ACCOUNTS[row.key].socialSetId;
    const prefix = `${REVIEW_PREFIX} ${plan.runId} · ${row.id} ·`;
    const body = { draft_title: reviewTitle(plan.runId, row.id, row.key, meta.title), platforms: articlePlatforms(markdown, covers[row.id]?.mediaId || null),
      scratchpad_text: `Article ${row.id} · replica of ${row.source.url || row.source.tweetId} ("${row.source.title}", ${row.source.views} views) · problem ${row.problem} · plugs ${row.products.map((p) => p.asin).join(', ')} · slot ${row.slotUtc} · cover look ${row.look || meta.look || '?'}\n\n${titlesBlock(meta)}\n\n${qrtBlock([meta.qrt1, meta.qrt2, meta.qrt3])}` };
    if (dry) { console.log(`  · ${row.id} would ${ledger[row.id]?.draftId ? 'update' : 'create'} "${body.draft_title}"`); continue; }
    const found = await findReviewDraft(tf, set, prefix);
    if (found.length > 1) { console.log(`  ✗ ${row.id}: ${found.length} review drafts share its title; delete the extras in Typefully`); continue; }
    let id = found[0]?.id || null;
    if (id) {
      const cur = await tf.getDraft(set, id);
      if (cur.scheduled_date || cur.publish_at || String(cur.status) !== 'draft') { console.log(`  ✗ ${row.id}: review draft ${id} is ${cur.status}; not touched`); continue; }
      const live = cur?.platforms?.x_article?.content_markdown ?? null;
      if (ledger[row.id]?.pushedSha && live != null && sha(live) !== ledger[row.id].pushedSha && sha(live) !== sha(markdown)) {
        console.log(`  ✗ ${row.id}: owner-edited in Typefully; not overwritten (pull the live copy into answers/${row.id}.md and re-check)`); continue;
      }
      await tf.patchDraft(set, id, body);
    } else id = (await tf.createDraft(set, { ...body, share: false }))?.id;
    const back = await tf.getDraft(set, id);
    const ok = back?.platforms?.x_article?.content_markdown === markdown && !back.scheduled_date && !back.publish_at;
    ledger[row.id] = { draftId: String(id), socialSetId: set, shareUrl: back?.share_url || null, pushedSha: sha(markdown), revision: checks[row.id].revision, media: slots.map(({ line, mediaId }) => ({ line, mediaId })), at: new Date().toISOString(), verified: ok };
    console.log(`  ${ok ? '✓' : '✗'} ${row.id.padEnd(16)} draft ${id}${ok ? '' : ' · READBACK DIFFERS'}`);
    writeJson(P.drafts, ledger);
  }
  writeJson(P.drafts, ledger);
}

async function verdictCmd(argv, kind) {
  const runDir = flag(argv, 'run-dir'); const P = paths(runDir);
  const plan = readJson(P.plan); const checks = readJson(P.checks, {}); const state = readJson(P.state, { rows: {} });
  const only = rowsFlag(argv);
  if (kind !== 'veto' && (!only || !String(flag(argv, 'message') || '').trim())) throw new Error(`${kind} needs --rows and --message "<the owner's exact words>"`);
  const { LAWS } = await import('../laws.mjs');
  const veto = LAWS.run?.scheduled?.vetoConsent;
  if (kind === 'veto') {
    const { modeOf } = await import('./run-studio.mjs');
    if (modeOf(runDir) !== 'scheduled') throw new Error('Veto consent applies only to a scheduled run (run-studio init --scheduled).');
  }
  const drafts = readJson(P.drafts, {});
  for (const row of plan.rows.filter((r) => r.status !== 'held' && (!only || only.has(r.id)))) {
    const revision = checks[row.id]?.revision;
    if (!revision || !checks[row.id].ok) { console.log(`  ✗ ${row.id}: not clean, nothing recorded`); continue; }
    const prev = state.rows[row.id] || {};
    if (kind === 'veto') {
      if (prev.hold && prev.hold.revision === revision) { console.log(`  · ${row.id} held by the owner`); continue; }
      if (prev.approval?.revision === revision) continue;
      if (!drafts[row.id]?.verified || drafts[row.id].revision !== revision) { console.log(`  · ${row.id} never pushed on this copy: the owner has not seen it, no veto consent`); continue; }
      const deadline = deadlineOf(row.slotUtc, veto?.deadlineHours ?? 12);
      if (Date.now() < Date.parse(deadline)) { console.log(`  · ${row.id} waiting until ${deadline}`); continue; }
      state.rows[row.id] = { ...prev, approval: { revision, kind: 'veto', message: `Veto consent (${veto?.by}, ${veto?.on}): "${String(veto?.quote || '').trim()}"`, at: new Date().toISOString() } };
    } else if (kind === 'approve') state.rows[row.id] = { approval: { revision, kind: 'owner', message: flag(argv, 'message'), at: new Date().toISOString() } };
    else state.rows[row.id] = { ...prev, approval: null, hold: { revision, message: flag(argv, 'message'), at: new Date().toISOString() } };
    console.log(`  ✓ ${row.id.padEnd(16)} ${kind}`);
  }
  writeJson(P.state, state);
}

async function scheduleCmd(argv) {
  const runDir = flag(argv, 'run-dir'); const P = paths(runDir); const dry = argv.includes('--dry');
  const plan = readJson(P.plan); const checks = readJson(P.checks, {}); const state = readJson(P.state, { rows: {} }); const drafts = readJson(P.drafts, {}); const covers = readJson(P.covers, {});
  const sched = readJson(P.schedule, {});
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { loadEnv, typefully } = await import('../lib.mjs');
  const { mintedSoFar, mintKey } = await import('../batch-mint.mjs');
  const { appendLedgerEventSync, stateOperationKey } = await import('../state/ledger-store.mjs');
  const reader = typefully(loadEnv());
  const tf = dry ? null : reader;
  // Every article minute is checked against the whole fleet's queue first (run-calendar's rules), so an article
  // never lands inside another post's 5 minutes or outside a live block. An unread page means unknown: nothing goes.
  const rows = selected(plan, argv);
  const { readOccupancy, postingAccounts } = await import('./run-occupancy.mjs');
  const occ = await readOccupancy({ client: reader, accounts: postingAccounts(ACCOUNTS), dates: [...new Set(rows.map((r) => r.date))] });
  if (!occ.complete) { console.log(`  ✗ fleet queues not read for ${occ.failedAccounts.join(', ')}: slot legality unknown, nothing scheduled`); process.exitCode = 1; return; }
  for (const row of rows) {
    const st = state.rows[row.id];
    const text = existsSync(join(P.answers, `${row.id}.md`)) ? readFileSync(join(P.answers, `${row.id}.md`), 'utf8') : '';
    if (!st?.approval || st.approval.revision !== sha(text) || checks[row.id]?.revision !== sha(text)) { console.log(`  · ${row.id} not approved on this copy`); continue; }
    if (!drafts[row.id]?.draftId) { console.log(`  ✗ ${row.id} no review draft: run push`); continue; }
    if (sched[row.id]?.verified) { console.log(`  · ${row.id} already scheduled ${sched[row.id].at}`); continue; }
    const account = ACCOUNTS[row.key];
    const subids = articleSubids(row.key, row.products, row.date);
    const products = row.products.map((p, i) => ({ ...p, subid1: subids[i] }));
    const ledgerPath = join(ROOT, 'ledger.jsonl');
    let minted = mintedSoFar(readFileSync(ledgerPath, 'utf8'));
    const jobs = products.filter((p) => !minted.has(mintKey(p.subid1, p.asin))).map((p) => ({ asin: p.asin, subid: p.subid1 }));
    if (jobs.length && !dry) {
      try { execFileSync('node', [join(ROOT, 'mint-batch.mjs'), '--jobs', JSON.stringify(jobs)], { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 }); } catch (e) { console.log(`  ✗ ${row.id} mint: ${String(e.stdout || e.message).split('\n').filter(Boolean).slice(-1)[0]}`); }
      minted = mintedSoFar(readFileSync(ledgerPath, 'utf8'));
    }
    // A dry run mints nothing: a placeholder stands in so the rest of the path (slot legality) is rehearsed.
    for (const p of products) p.link = minted.get(mintKey(p.subid1, p.asin)) || (dry ? `https://dry-run.invalid/${p.subid1}` : null);
    // The media embedded at push, so the shipped article is the one the owner reviewed.
    const final = substituteLinks(fillMedia(parsePackage(text).markdown, drafts[row.id].media || []), products);
    if (final.error) { console.log(`  ✗ ${row.id} ${dry ? '(dry) ' : ''}${final.error}`); continue; }
    // The page's own thread that day, as booked now: the plan may not have seen it (a page-day booked before the
    // run carries no calendar minute), and the article stays gapHoursFromThread away from it.
    const own = occ.bookings.find((b) => b.account === row.key && !['article', 'single'].includes(b.lane) && saigonDay(b.publishAtUtc) === row.date);
    const planned = own && Math.abs(Date.parse(own.publishAtUtc) - Date.parse(row.slotUtc)) < (plan.law.gapHoursFromThread ?? 6) * 3600e3
      ? articleSlotUtc({ date: row.date, threadUtc: own.publishAtUtc }, plan.law) : row.slotUtc;
    const legal = legalArticleSlot(planned, row.key, occ.bookings, { draftId: drafts[row.id].draftId });
    if (!legal.slotUtc) { console.log(`  ✗ ${row.id}: no legal minute within 4h of ${row.slotUtc}: ${legal.issues.join('; ')}`); continue; }
    if (legal.slotUtc !== row.slotUtc) console.log(`  · ${row.id}: ${row.slotUtc} moved to ${legal.slotUtc} (the page's thread, a fleet gap or a block edge)`);
    const slotUtc = legal.slotUtc;
    const body = { draft_title: finalTitle(account, row.date, parsePackage(text).meta.title), platforms: articlePlatforms(final.markdown, covers[row.id]?.mediaId || null), publish_at: slotUtc };
    if (dry) { console.log(`  · ${row.id} would schedule ${slotUtc} with ${products.map((p) => p.link).join(', ')}`); occ.bookings.push({ account: row.key, lane: 'article', publishAtUtc: slotUtc, draftId: `dry-${row.id}` }); continue; }
    const set = account.socialSetId, id = drafts[row.id].draftId;
    const cur = await tf.getDraft(set, id);
    if (cur.scheduled_date || String(cur.status) !== 'draft') { console.log(`  ✗ ${row.id}: draft ${id} is ${cur.status}; read it in Typefully before retrying`); continue; }
    if (sha(cur?.platforms?.x_article?.content_markdown ?? '') !== drafts[row.id].pushedSha) { console.log(`  ✗ ${row.id}: the review draft was edited after push; pull it, re-check and re-approve`); continue; }
    await tf.patchDraft(set, id, body);
    const back = await tf.getDraft(set, id);
    const at = back?.scheduled_date || back?.publish_at || null;
    const live = back?.platforms?.x_article?.content_markdown || '';
    const verified = !!at && Date.parse(at) === Date.parse(slotUtc) && live === final.markdown && !/\{\{LINK\d*\}\}/.test(live);
    if (at) occ.bookings.push({ account: row.key, lane: 'article', publishAtUtc: new Date(Date.parse(at)).toISOString(), draftId: String(id) });
    for (const [i, p] of products.entries()) {
      appendLedgerEventSync(ledgerPath, { ts: new Date().toISOString(), account: account.name, recId: null, draftId: Number(id), mode: 'monetized', writerLane: 'chat',
        contentLane: 'article', articleOf: String(row.source.tweetId), sourceUrl: row.source.url, topic: row.problem, ...(i ? { attributionOnly: true } : {}),
        subid1: p.subid1, asin: p.asin, product: p.title, link: p.link, runId: plan.runId },
      { operationKey: stateOperationKey('article:schedule', [plan.runId, row.id, p.subid1]), source: 'run-articles', runId: plan.runId });
    }
    sched[row.id] = { draftId: id, at, verified, links: products.map((p) => p.link), ...(legal.slotUtc !== row.slotUtc ? { plannedAt: row.slotUtc } : {}) };
    writeJson(P.schedule, sched);
    mkdirSync(dirname(paths(runDir).sourcesLog), { recursive: true });
    writeFileSync(paths(runDir).sourcesLog, `${JSON.stringify({ at: new Date().toISOString(), tweetId: row.source.tweetId, page: row.key, runId: plan.runId, articleDraft: id, look: row.look || null, skeleton: row.skeleton || null, mode: row.mode || null, problem: row.problem || null, kind: row.source.kind || 'article', ...(row.source.swipeRec ? { swipeRec: row.source.swipeRec } : {}) })}\n`, { flag: 'a' });
    console.log(`  ${verified ? '✓' : '✗'} ${row.id.padEnd(16)} ${id} ${at || 'NOT SCHEDULED'}${verified ? ' · read back' : ' · READBACK DIFFERS'}`);
  }
  writeJson(P.schedule, sched);
}

function statusCmd(argv) {
  const P = paths(flag(argv, 'run-dir'));
  const plan = readJson(P.plan); if (!plan) { console.log('no plan'); return; }
  const checks = readJson(P.checks, {}), covers = readJson(P.covers, {}), media = readJson(P.media, {}), drafts = readJson(P.drafts, {}), state = readJson(P.state, { rows: {} }), sched = readJson(P.schedule, {});
  for (const r of plan.rows) {
    const s = r.status === 'held' ? `held: ${r.reason}` : [
      existsSync(join(P.answers, `${r.id}.md`)) ? 'written' : 'to write',
      checks[r.id] ? (checks[r.id].ok ? 'clean' : `${checks[r.id].issues.length} issue(s)`) : 'unchecked',
      covers[r.id]?.mediaId ? 'cover' : 'no cover',
      media[r.id] ? `${media[r.id].slots.filter((x) => x.mediaId).length}/${media[r.id].slots.length} media` : 'no media pass',
      drafts[r.id]?.draftId ? `draft ${drafts[r.id].draftId}` : 'not pushed',
      state.rows[r.id]?.hold ? 'HELD' : state.rows[r.id]?.approval ? `approved (${state.rows[r.id].approval.kind})` : 'awaiting',
      sched[r.id]?.verified ? `scheduled ${sched[r.id].at}` : '',
    ].filter(Boolean).join(' · ');
    console.log(`  ${r.id.padEnd(16)} ${r.slotUtc}  ${s}`);
  }
}

async function main(argv) {
  const [cmd] = argv; const rest = argv.slice(1);
  if (cmd === 'plan') return planCmd(rest);
  if (cmd === 'check') return checkCmd(rest);
  if (cmd === 'cover') return coverCmd(rest);
  if (cmd === 'media') return mediaCmd(rest);
  if (cmd === 'craft') return craftCmd(rest);
  if (cmd === 'push') return pushCmd(rest);
  if (cmd === 'approve' || cmd === 'hold' || cmd === 'veto') return verdictCmd(rest, cmd);
  if (cmd === 'schedule') return scheduleCmd(rest);
  if (cmd === 'status') return statusCmd(rest);
  throw new Error('usage: run-articles.mjs plan|craft|check|cover|media|push|approve|hold|veto|schedule|status --run-dir RUN [...] (see the header)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 2; });
}
