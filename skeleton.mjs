// skeleton.mjs — the "keep the viral FORM, replace the CONTENT" core of skeleton-variation mode.
//
// X's 2026-07 creator-program enforcement down-ranks copied text with light edits at ~3x the old
// detection rate, redirects monetized impressions to the original uploader, and escalates repeat
// offenders. Our recreation engine is detectable BY CONSTRUCTION (a same-mold hook + a ~85%-
// faithful body). This module instead extracts a source thread's *skeleton* — the syntactic /
// psychological SHAPE that made it spread — so a brand-new thread on a product-fit topic can be built
// in that shape with entirely new substance. It is PURE DATA + one LLM extraction: it never writes a
// draft (recreate.mjs does), so it is safe to import and unit-test in isolation.
//
//   - shapeMetrics(srcTweets)            -> deterministic { itemCount, avgTweetLen, lineBreakDensity, format }
//   - extractSkeleton(env, tweets, src)  -> the above + LLM form fields (hookFirstLine, hookPattern,
//                                           promiseShape, itemShape, escalation, closerShape, styleNotes)
//   - loadSkeletons() / saveSkeleton()   -> append-only library skeletons.jsonl (dedup by sourceRecId)
//   - pickFactPool(env, topic, opts)     -> top swipe-DB threads whose hook classifies to `topic`, with
//                                           full child-tweet text, so every generated claim can come
//                                           from a real on-topic thread (never invented).
//
// THE HOOK RULE (operator, 2026-07-17): the hook's FIRST LINE is held TIGHTER than anything else —
// ~95% structural clone of the source's opener (same clause skeleton, rhythm, length, shock), with only
// the load-bearing nouns/numbers/verbs swapped for the new topic's key information. Everything after
// line 1 (hook line 2 + body) keeps the same SHAPE (itemCount, itemShape, escalation, sentence style)
// but is freely reworded from new substance. The 95% is STRUCTURAL, never lexical — checks.mjs's
// sharedNgramIssue still guarantees no verbatim run is shared with any source.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { anthropic, FLEET_MODEL, airtable, HERE_DIR } from './lib.mjs';
import { leadingNumbers } from './checks.mjs';
import { classifyTopic } from './pick-product.mjs';
import { TABLES, swipeNiches } from './config.mjs';

const THREADS = TABLES.swipe;
const LIB = join(HERE_DIR, 'skeletons.jsonl');

// ---- deterministic shape metrics (never trust the LLM for a number we can count) ----
export function shapeMetrics(srcTweets) {
  const tweets = (srcTweets || []).filter(Boolean).map(String);
  const itemCount = tweets.flatMap(leadingNumbers).length;
  const lens = tweets.map((t) => t.length);
  const avgTweetLen = lens.length ? Math.round(lens.reduce((s, n) => s + n, 0) / lens.length) : 0;
  const breaks = tweets.map((t) => (t.match(/\n/g) || []).length);
  const lineBreakDensity = tweets.length ? Math.round((breaks.reduce((s, n) => s + n, 0) / tweets.length) * 10) / 10 : 0;
  const format = itemCount >= 3 ? 'listicle' : 'narrative';
  // Item PACKING density: how the donor distributes its numbered items across tweets. A donor that packs
  // several one-sentence items into ONE tweet (AskCoachKev: 39 items across ~14 tweets, ~2.8/tweet) MUST
  // be reproduced that way — the default "one item per tweet" body path (prompts.mjs STRUCTURE rule +
  // splitMergedItems) otherwise inflates a 17-tweet donor into a 40+ tweet thread. itemsPerTweet is the
  // per-tweet marker count for every tweet that carries at least one item.
  const itemsPerTweet = tweets.map((t) => leadingNumbers(t).length).filter((k) => k > 0);
  const bodyItemTweets = itemsPerTweet.length;
  const avgItemsPerTweet = bodyItemTweets ? Math.round((itemCount / bodyItemTweets) * 10) / 10 : 0;
  const maxItemsPerTweet = itemsPerTweet.length ? Math.max(...itemsPerTweet) : 0;
  // "packed" only when it's a listicle AND the donor clearly groups items (avg >= 1.6/tweet); a clean
  // one-item-per-tweet donor (avg ~1.0) keeps the default path untouched.
  const packed = format === 'listicle' && avgItemsPerTweet >= 1.6;
  // Length of the source hook's FIRST LINE — the mold gate (hookMoldIssue) holds the variation's line 1
  // to this ±20%, so the clone visibly matches the donor's rhythm, not just its clause order.
  const hookLine1Len = (tweets[0] || '').split('\n')[0].trim().length;
  // Donor tweet count — the pacing target for NARRATIVE donors (no numbered items to count against).
  const tweetCount = tweets.length;
  // Does the donor pack its FIRST item's marker line into tweet 1 (hook line + "1. <name>." together,
  // elaboration in tweet 2)? The generation must mirror that two-block tweet-1 grouping (Austin 2026-07-20).
  const t1blocks = (tweets[0] || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const hook1AttachesItem = t1blocks.length >= 2 && !/^\d+[.)]\s/.test(t1blocks[0]) && t1blocks.slice(1).some((b) => /^\d+[.)]\s/.test(b));
  return { itemCount, avgTweetLen, lineBreakDensity, format, hookLine1Len, tweetCount, hook1AttachesItem, itemsPerTweet, bodyItemTweets, avgItemsPerTweet, maxItemsPerTweet, packed };
}

// ---- LLM extraction: FORM only, never a topic-specific fact ----
// Deterministic metrics ALWAYS win over anything the model guesses about counts/shape.
const FORM_KEYS = ['hookFirstLine', 'hookPattern', 'promiseShape', 'itemShape', 'escalation', 'closerShape', 'styleNotes', 'itemCategory', 'principles'];
export async function extractSkeleton(env, srcTweets, src = {}) {
  const metrics = shapeMetrics(srcTweets);
  const prompt = `You are a viral-thread STRUCTURE analyst. Below is a thread that went viral (${(src.impressions || src.views || 0).toLocaleString()} views). Extract its reusable SKELETON — the SHAPE that made it spread — so a DIFFERENT thread on a DIFFERENT topic can be written in the same shape. Describe FORM ONLY; capture NOTHING topic-specific as a fact.

Return ONLY strict JSON with these keys:
- "hookFirstLine": the EXACT opening line rewritten as a fill-in-the-blank TEMPLATE, with every load-bearing noun/number/verb replaced by an ALL-CAPS slot marker but ALL connective/structural words kept verbatim, e.g. "<SUBJECT> is <HARM-VERB>ing your <OBJECT> <COMPARATIVE> than <FAMILIAR VICE>." This line is reused at ~95% structural fidelity — same clause skeleton, rhythm, length, and shock — so keep its scaffold intact and mark ONLY what must change.
- "hookPattern": the hook's SECOND line / promise line as a template (e.g. "<N> signs <BODY STATE>:"), or "" if the hook is a single line.
- "promiseShape": what the hook promises the reader, in one clause (e.g. "N numbered signs of a hidden problem").
- "itemShape": the structure of ONE body item (e.g. "number. a second-person symptom, then one short mechanism line").
- "escalation": how items are ordered (e.g. "mild -> alarming", "setup -> turning point -> payoff", "none/flat").
- "closerShape": how the final tweet lands (e.g. "restates the stakes + a one-line challenge").
- "styleNotes": sentence rhythm, person (1st/2nd), line-break usage, capitalization, formatting mechanics — FORM only.
- "itemCategory": if EVERY body item is an instance of ONE concrete category of interchangeable things (e.g. a stack thread listing supplements, or foods, exercises, habits, signs), that ONE category word in lowercase plural (e.g. "supplements"); else "". The category IS part of the form — a supplements-stack thread stays a supplements-stack thread when varied.
- "principles": the 2-4 FOUNDATIONAL PRINCIPLES that made this thread spread — the psychological mechanisms, not the surface words — as one semicolon-separated string (e.g. "familiar-vice comparison makes an invisible harm feel urgent; countdown list promises a complete payoff; each item names a symptom the reader can self-diagnose right now"). These are what any future remix of this structure must preserve even when the hook wording and topic change.

INSPIRATION THREAD:
${(srcTweets || []).map((t, i) => `[${i === 0 ? 'HOOK' : 'tweet ' + (i + 1)}]\n${t}`).join('\n\n')}

Reply with ONLY the JSON object.`;
  const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
  let j;
  try { j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch { throw new Error('extractSkeleton: no valid JSON from the model'); }
  const form = {};
  for (const k of FORM_KEYS) form[k] = typeof j[k] === 'string' ? j[k].trim() : '';
  // Normalize slot markers: the prompt asks for <ANGLE-BRACKETED> ALL-CAPS slots, but the model
  // sometimes emits bare ALL-CAPS runs ("High NOUN is VERB-ing ...") — wrap those so downstream
  // consumers (hookMoldIssue's scaffold parser, the generation prompt) see one consistent format.
  form.hookFirstLine = form.hookFirstLine.replace(/(?<!<)\b([A-Z][A-Z-]{1,}(?:\s+[A-Z][A-Z-]{1,})*)\b(?!>)/g, '<$1>');
  return { ...form, ...metrics };
}

// ---- append-only library (committed like ledger.jsonl) ----
export function loadSkeletons() {
  if (!existsSync(LIB)) return [];
  const out = [];
  for (const line of readFileSync(LIB, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
// Dedup by sourceRecId: one skeleton per source thread (re-extracting is wasted + non-deterministic).
// Returns true if written, false if the source is already in the library.
export function saveSkeleton(entry) {
  if (entry?.sourceRecId && loadSkeletons().some((s) => s.sourceRecId === entry.sourceRecId)) return false;
  appendFileSync(LIB, JSON.stringify(entry) + '\n');
  return true;
}
export function getSkeleton(id) { return loadSkeletons().find((s) => s.id === id) || null; }

// ---- FORM PORTFOLIO (audit #4, operator 2026-07-21): reuse PROVEN skeletons, ranked by results ----
// mode-compare.mjs writes learnings/skeleton-lift.json — per-skeleton REALIZED performance
// (views/post, rev/1k, sorted best-first). This is the consumer side: pick the best proven form whose
// library entry still exists, so a production slot stuck with a stale fallback donor can generate from
// a form that already demonstrated it spreads, instead of a years-old donor. Fail-open: no lift file,
// an empty cohort, or nothing above the floor returns null and the caller keeps its donor.
const LIFT = join(HERE_DIR, 'learnings', 'skeleton-lift.json');
export function loadSkeletonLift() {
  try { return existsSync(LIFT) ? (JSON.parse(readFileSync(LIFT, 'utf8')).skeletons || []) : []; } catch { return []; }
}
// RANKED ON CONVERSION (2026-08-16, engine v2): "best-performing form" now means best realized
// revenue per 1k views, with a small views floor kept only to filter statistical noise — a form
// measured on 3k views is not measured. The old order was viewsPerPost, which made a $0-earning
// viral the "best" form in the portfolio.
export function pickProvenSkeleton({ skeletons = loadSkeletons(), lift = loadSkeletonLift(), minViewsPerPost = 50_000, exclude = new Set() } = {}) {
  const ranked = [...lift].sort((a, b) => (b.revPer1k || 0) - (a.revPer1k || 0));
  for (const perf of ranked) {
    if ((perf.viewsPerPost || 0) < minViewsPerPost) continue;
    const entry = skeletons.find((s) => s.id === perf.skeletonId);
    if (!entry?.sourceRecId || exclude.has(entry.sourceRecId)) continue;
    return { skeletonId: entry.id, sourceRecId: entry.sourceRecId, viewsPerPost: perf.viewsPerPost || 0, revPer1k: perf.revPer1k || 0 };
  }
  return null;
}

// ---- STRUCTURE × TOPIC grid (operator rule 2026-07-22, fleet-prep) --------------------------------
// One proven structure may serve MANY pages — but "same form + same topic" within a short window is
// a reworded copy fleet-wide (the duplicate class X flags), while "same form + different topic" is
// the safe multiplication the whole skeleton system exists for. This grid tracks which (structure,
// topic) pairs the FLEET has used recently, keyed by the donor's sourceRecId (stable across auto
// re-extraction and the proven-form portfolio). recreate stamps it atomically with draft creation;
// daily-winners consults it before committing a slot's topic. State is committed like the other
// queues so every runner sees the fleet's history. Pure/injectable for tests.
const STRUCT_ROT = join(HERE_DIR, 'queues', 'skeleton-rotation.json');
export function loadStructureUse() {
  try { return existsSync(STRUCT_ROT) ? JSON.parse(readFileSync(STRUCT_ROT, 'utf8')) : {}; } catch { return {}; }
}
// Stamp format: { [sourceRecId]: { [topic]: { last: iso, byAccount: { [account]: iso } } } }.
// (A bare ISO string is also accepted by the readers — the grid's first-day format.)
export function recordStructureUse(sourceRecId, topic, account, when) {
  if (!sourceRecId || !topic) return;
  const state = loadStructureUse();
  const iso = (when ? new Date(when) : new Date()).toISOString();
  const cell = state?.[sourceRecId]?.[topic];
  const prev = typeof cell === 'object' && cell ? cell : (typeof cell === 'string' ? { last: cell, byAccount: {} } : { byAccount: {} });
  prev.last = iso;
  if (account) (prev.byAccount ||= {})[account] = iso;
  (state[sourceRecId] ||= {})[topic] = prev;
  try { writeFileSync(STRUCT_ROT, JSON.stringify(state, null, 1) + '\n'); } catch {}
}
const cellTimes = (cell) => {
  if (!cell) return { last: NaN, byAccount: {} };
  if (typeof cell === 'string') return { last: Date.parse(cell), byAccount: {} };
  return { last: Date.parse(cell.last), byAccount: cell.byAccount || {} };
};
// Is this (structure, topic) pair available for THIS slot? Two regimes (operator model 2026-07-22):
//   EXPLORATION (default): the pair is fleet-exclusive for `windowDays` — one page runs it, everyone
//   else keeps off it. Prevents accidental near-twins while a form+topic is unproven.
//   FAN-OUT (`fanout: true` — the structure is PROVEN or operator-approved): the pair deliberately
//   rolls across MANY pages: blocked only if this ACCOUNT already ran it within `windowDays`, or ANY
//   account ran it within the last `staggerDays` (rollout spacing, mirrors the sibling stagger).
//   Copies still diverge hard: fan-out reuse forces the principled hook remix + per-run fact pools.
// Unknown structures/topics are fresh (fail-open — the grid is a guard, never a hard dependency).
export function structureTopicFresh(sourceRecId, topic, { state = loadStructureUse(), now = Date.now(), windowDays = 30, account = null, fanout = false, staggerDays = 2 } = {}) {
  const { last, byAccount } = cellTimes(state?.[sourceRecId]?.[topic]);
  if (!Number.isFinite(last)) return true; // never used anywhere
  if (!fanout) return (now - last) >= windowDays * 864e5;
  const mine = Date.parse(account ? byAccount[account] : undefined);
  if (Number.isFinite(mine) && (now - mine) < windowDays * 864e5) return false; // an account never repeats the pair
  return (now - last) >= staggerDays * 864e5; // rollout spacing between accounts
}
// A structure earns the FAN-OUT regime by RESULTS (realized views/post from the weekly skeleton-lift
// join) or by OPERATOR APPROVAL (queues/fanout-approved.json — add the donor recId with a note).
// FANOUT_MIN_REV_PER_1K tunes the automatic bar; the approval file is the same-day manual lever for "this
// is working, multiply it NOW" without waiting for the weekly lift refresh.
const FANOUT_APPROVED = join(HERE_DIR, 'queues', 'fanout-approved.json');
export function loadFanoutApproved() {
  try { return existsSync(FANOUT_APPROVED) ? (JSON.parse(readFileSync(FANOUT_APPROVED, 'utf8')).approved || {}) : {}; } catch { return {}; }
}
// RE-GATED ON CONVERSION (operator 2026-08-16, engine v2). "Proven" used to mean viewsPerPost >=
// FANOUT_MIN_VIEWS (350k) — a REACH bar. That is exactly the confusion the redesign removes: a
// skeleton with 1.78M views/post but $0.049/1k realized cleared the old gate while earning a third
// of the $0.15/1k promotion floor. A structure is proven when it EARNS, so the gate now reads the
// revPer1k that learn.mjs already computes into skeleton-lift.json. The operator's manual approval
// file still overrides in both directions of doubt.
export function structureProven(sourceRecId, { lift = loadSkeletonLift(), skeletons = loadSkeletons(), approved = loadFanoutApproved(), minRevPer1k = Number(process.env.FANOUT_MIN_REV_PER_1K ?? 0.15) } = {}) {
  if (approved[sourceRecId]) return true;
  for (const perf of lift) {
    if ((perf.revPer1k || 0) < minRevPer1k) continue;
    const entry = skeletons.find((sk) => sk.id === perf.skeletonId);
    if (entry?.sourceRecId === sourceRecId) return true;
  }
  return false;
}
// Has this structure produced ANY variation before (any topic, ever)? First use keeps the strict
// hook mold (prove the form as-is); reuse unlocks the principled hook remix (see prompts.mjs).
export function structureUsedBefore(sourceRecId, state = loadStructureUse()) {
  return Object.keys(state?.[sourceRecId] || {}).length > 0;
}

// ---- hook bank: the PROVEN winner hooks that hookStrength (checks.mjs) scores against -------------
// learnings/hook-bank.json is written by refresh-hook-bank.mjs (weekly Actions cron) and committed, so
// every generation run has it in its checkout. Lazy + defensive: a missing/garbled bank returns [] and
// callers skip the strength gate (fail-open — the bank is an enhancement, never a hard dependency).
const HOOK_BANK = join(HERE_DIR, 'learnings', 'hook-bank.json');
export function loadHookBank() {
  try { return existsSync(HOOK_BANK) ? (JSON.parse(readFileSync(HOOK_BANK, 'utf8')).hooks || []) : []; } catch { return []; }
}

// ---- fact pool: real on-topic threads whose claims the generator must draw from ----
// Mirrors daily-winners' swipe-DB pool query (same fields/filters) but selects by TOPIC (classifyTopic
// over the head text, in memory — there is no stored Airtable topic field) rather than by recreatability.
// Returns up to `k` threads (highest-views first) each with its ordered child-tweet text, so the
// generator can build every body claim from a genuine same-topic thread instead of inventing facts.
async function loadThreadTexts(at, headRec) {
  const ids = headRec.fields.Tweets || [];
  const rows = [];
  for (const id of ids) { const f = (await at.getRecord(THREADS, id)).fields; rows.push({ n: f['Tweet Number'] || 0, text: f.Text || '' }); }
  rows.sort((a, b) => a.n - b.n);
  return rows.map((r) => r.text).filter(Boolean);
}
export async function pickFactPool(env, topic, { niches = [], exclude = [], floorViews = 100000, k = 3, collectDays = null } = {}) {
  const at = airtable(env);
  const nicheOr = niches.length ? 'OR(' + swipeNiches(niches).map((n) => `{Niche}="${String(n).replace(/"/g, '')}"`).join(',') + ')' : 'TRUE()';
  const recency = collectDays ? `,IS_AFTER({Created time},DATEADD(NOW(),-${collectDays},"days"))` : '';
  const formula = `AND({Tweet Number}=1,{Thread Length}>=3,NOT({Quoted Junk}),NOT({Single Tweet}),{Impressions}>=${floorViews},${nicheOr}${recency})`;
  const recs = await at.list(THREADS, { formula, sort: [{ field: 'Impressions', direction: 'desc' }], fields: ['Text', 'Impressions', 'Niche', 'Tweet URL', 'Tweets'], pageSize: 100 });
  const ex = new Set((exclude || []).filter(Boolean));
  const matches = recs.filter((r) => !ex.has(r.id) && classifyTopic((r.fields.Text || '').split('\n')[0]) === topic).slice(0, k);
  const pool = [];
  for (const r of matches) {
    const tweets = await loadThreadTexts(at, r);
    if (tweets.length) pool.push({ recId: r.id, url: r.fields['Tweet URL'], views: r.fields.Impressions || 0, niche: r.fields.Niche, tweets });
  }
  return pool;
}
