#!/usr/bin/env node
// The run's CONTENT rules: what the owner decides once, at the intake, and every stop then checks.
//
// Owner, 2026-09-23, after R2026-09-23 shipped threads with up to five calls to action: "Ask me more
// questions in advance so you know exactly what I'm looking for, so the run becomes easier and we
// avoid these issues ... There won't be any halfway split or halfway point where we have to change
// the things completely." The run's own post-mortem found the same thing: about half the extra work
// was late catches (a 1-plug thread dropped at drafts, near-identical pots caught at scheduling, a
// misreported study caught by the final reviewer) and re-approvals of tiny edits.
//
// So each answer here is a RULE with a named check, not a note for the writer. The intake
// (scripts/run-intake.mjs) asks the questions and resolves the answers into `intake.content`; the
// selection check (`--stage selection`) and the drafts packet (scripts/run-content-packets.mjs) run
// the checks below on every row, so a row that breaks a rule is held at the first stop that can see
// it, never after the owner has read it. An answer only ever TIGHTENS a laws.json gate: the CTA cap
// is min(laws plugBudget, answer), and nothing here can pass a row the canonical gate holds.
//
// The answers are fixed for the run: the resolved intake is written once (`wx`) into RUN_DIR, and
// the brief shows `rulesSha256`, so every stop checks against the same rules the owner approved.
//
//   node scripts/run-rules.mjs --stage selection --run-dir RUN_DIR --input SELECTION.json
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyOverlap } from '../checks.mjs';
import { LAWS } from '../laws.mjs';
import { laneOf } from '../lanes.mjs';

const fail = (message) => { throw new Error(message); };
const text = (value) => String(value ?? '').trim();

/** The content questions, in the order they are asked, each with its safe default and its check. */
export function contentQuestions(laws = LAWS) {
  const B = laws.plugs;
  const lawMax = Math.max(B.budget.longPlugs, B.roundupCap);
  return [
    { id: 'ctaMax', ask: 'At most how many calls to action in one thread?', default: 3,
      options: [1, 2, 3, 4, { id: 'law', label: 'No run cap', note: 'Only the laws.json budget applies' }],
      source: `laws.json plugs.budget allows ${B.budget.shortPlugs}/${B.budget.midPlugs}/${B.budget.longPlugs} by length and up to ${B.roundupCap} in a roundup; R2026-09-23 shipped threads with ${lawMax}, which the owner called too many`,
      check: 'Every tweet that carries a link counts, the page’s own site-link tweet included; a link cited as a source (draft.sources) does not. The writer’s budget is the smaller of the laws.json budget and this cap; the drafts packet holds a thread over it, and a verbatim repost over it is held at selection (a verbatim body cannot be trimmed).' },
    { id: 'productsMax', ask: 'At most how many different products in one thread?', default: 2,
      options: [1, 2, 3],
      source: 'the heavy + light pair is the standard cover; 3+ makes a roundup',
      check: 'Counted as distinct ASINs in the drafts packet, and at selection for any row that already names its products.' },
    { id: 'sources', ask: 'Numbers, percentages and studies in the copy?', default: 'review',
      options: [
        { id: 'hold', label: 'Hold', note: 'A statistic or study line without a named source is held' },
        { id: 'review', label: 'Flag', note: 'It reaches you marked, with the line quoted' },
        { id: 'off', label: 'No check', note: 'Only the editorial review reads them' },
      ],
      source: 'docs/claim-safety.md: claim gates caught 0 of 1,110 tweets; R2026-09-23 misreported a study that only the final reviewer caught',
      check: 'Each tweet with a percentage, a study, a trial or research needs an entry in draft.sources ({tweet, source}); the drafts packet applies this answer.' },
    { id: 'twins', ask: 'Two threads on the same idea in one run?', default: 'run',
      options: [
        { id: 'run', label: 'Never in this run', note: 'Near-identical source bodies are held anywhere in the run, not only on the same day' },
        { id: 'day', label: 'Not on the same day', note: 'The standing calendar rule only' },
      ],
      source: `laws.json selection.donorOverlapWarn (${Math.round(laws.selection.donorOverlapWarn * 100)}% word-4-gram overlap); R2026-09-23 caught kim/magnus only at scheduling`,
      check: 'Selection and the drafts packet compare every pair of rows in the run: covers, remixes and harvests by donor and source body, pots by their written copy (pots of one seed share a donor by design).' },
    { id: 'reposts', ask: 'Old reposts (verbatim harvests)?', default: 'recheck',
      options: [
        { id: 'recheck', label: 'Re-check first', note: 'Each repost is checked against this run’s rules before selection' },
        { id: 'none', label: 'None this run', note: 'No verbatim harvests' },
      ],
      source: 'R2026-09-23 held 7 old reposts late (missing safety lines, previously corrected lines, a wrong-product tweet)',
      check: 'Verbatim harvest bodies go through the CTA, product and source checks at selection, where a swap is still cheap.' },
    { id: 'sensitive', ask: 'Sexual-behaviour topics, contrarian medicine, named-person quotes?', default: 'review',
      options: [
        { id: 'exclude', label: 'Exclude', note: 'Rows on these topics are dropped at selection' },
        { id: 'review', label: 'Flag', note: 'They reach you marked' },
      ],
      source: 'plan §6 item 16: a "stopped masturbating" donor passed the safety read; the cancer, explicit and off-brand rules stay as they are either way',
      check: 'Read by Jev at selection and drafts (scripts/run-jev.mjs, report-only): a matching row is flagged, and under "exclude" flagged for a swap; the owner decides.' },
    { id: 'edits', ask: 'Which edits re-open review and approval?', default: 'words',
      options: [
        { id: 'words', label: 'Only word changes', note: 'Spacing and formatting never re-open approval; neither does the publisher’s own reflow' },
        { id: 'any', label: 'Any change', note: 'Today’s behaviour' },
      ],
      source: 'R2026-09-23: a trailing space held a thread; one tweak forced a whole-batch resubmit',
      check: 'The change classifier (spacing / formatting / words) at the drafts and calendar stops; a row-level revision never re-opens the rest of its batch.' },
    { id: 'batchSize', ask: 'How many threads per review batch?', default: 8, options: [4, 6, 8, 12],
      source: 'scripts/run-content-packets.mjs --chunk-size default',
      check: 'The drafts and hooks packets split review batches at this size.' },
  ];
}

const CHOICE = { sources: ['hold', 'review', 'off'], twins: ['run', 'day'], reposts: ['recheck', 'none'],
  sensitive: ['exclude', 'review'], edits: ['words', 'any'] };

/** Answers -> the run's content rules. Unanswered questions take their default, and the result says which. */
export function resolveContentRules(answers = {}, laws = LAWS) {
  const questions = contentQuestions(laws);
  const defaultsUsed = [];
  const rules = {};
  for (const q of questions) {
    const value = answers[q.id];
    if (value === undefined || value === null || value === 'default') { defaultsUsed.push(q.id); rules[q.id] = q.default; }
    else rules[q.id] = value;
  }
  const lawMax = Math.max(laws.plugs.budget.longPlugs, laws.plugs.roundupCap);
  // "law" means no run cap: the canonical gate's own budget is the only limit.
  if (rules.ctaMax === 'law') rules.ctaMax = null;
  if (rules.ctaMax !== null && (!Number.isInteger(rules.ctaMax) || rules.ctaMax < 1 || rules.ctaMax > lawMax)) fail(`ctaMax must be a whole number from 1 to ${lawMax}, or "law"`);
  if (!Number.isInteger(rules.productsMax) || rules.productsMax < 1 || rules.productsMax > laws.plugs.roundupCap) fail(`productsMax must be a whole number from 1 to ${laws.plugs.roundupCap}`);
  if (rules.ctaMax !== null && rules.productsMax > rules.ctaMax) fail('productsMax cannot exceed ctaMax: every product needs its own call to action');
  for (const [id, allowed] of Object.entries(CHOICE)) if (!allowed.includes(rules[id])) fail(`${id} must be one of: ${allowed.join(', ')}`);
  if (!Number.isInteger(rules.batchSize) || rules.batchSize < 1 || rules.batchSize > 20) fail('batchSize must be a whole number from 1 to 20');
  const rulesSha256 = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  return { ...rules, rulesSha256, defaultsUsed };
}

// A link in a tweet is a call to action: a product link, a shortened link, the page's own site, or
// a {{LINK}}/{{LINK2}} placeholder (drafts are gated before any link is minted, gate-thread.mjs).
const LINK = /\{\{LINK\d*\}\}|\bhttps?:\/\/\S+|\b(?:amzn\.to|a\.co|lvnta\.com|levanta\.io)\/\S+/i;
const URLS = /\bhttps?:\/\/[^\s)]+/gi;
const SHORT = /\b(?:amzn\.to|a\.co|lvnta\.com|levanta\.io)\//i;
/** Tweets carrying a call-to-action link. A URL the row cites as a source is evidence, not an ask,
 *  so a tweet whose only links are cited sources does not count. */
export function linkTweets(tweets = [], sources = []) {
  const cited = new Set((Array.isArray(sources) ? sources : []).flatMap((s) => String(s?.source || '').match(URLS) || []));
  return tweets.map((tweet, index) => {
    const t = String(tweet);
    if (!LINK.test(t)) return null;
    const urls = t.match(URLS) || [];
    const onlyCited = !/\{\{LINK\d*\}\}/.test(t) && urls.length > 0 && urls.every((u) => cited.has(u)) && !SHORT.test(t.replace(URLS, ''));
    return onlyCited ? null : index + 1;
  }).filter(Boolean);
}

// Lines the reader would take as evidence. Deliberately broad: a miss ships a claim, a false flag
// costs the owner one glance (and `review` only marks it). The Jev line pointer replaces this list.
const EVIDENCE = /\d+(?:\.\d+)?\s?%|\b(?:stud(?:y|ies)|trials?|research(?:ers)?|meta-analys[ie]s|scientists|journal)\b/i;
// A paper-style citation in the copy: "(Sutton et al., 2018)", "(Donga, 2010)", "Malik et al.". The owner
// wants sources where they carry a claim, not on every line (laws.json tweet.$citationTweetsMax).
const CITATION = /\bet al\b|\([^()]*\b(?:19|20)\d{2}\)/i;
export function citationTweets(tweets = []) {
  return tweets.map((tweet, index) => (CITATION.test(String(tweet)) ? index + 1 : null)).filter(Boolean);
}
export function evidenceTweets(tweets = []) {
  return tweets.map((tweet, index) => (EVIDENCE.test(String(tweet)) ? index + 1 : null)).filter(Boolean);
}

/**
 * One row against the run's content rules. `plugsAt` is the canonical gate's plug positions when
 * it ran; the count is the larger of those and the link-carrying tweets, so neither can hide a CTA.
 * `verbatim` rows cannot be rewritten, so what would be a repair elsewhere is a hold there.
 */
export function rowRuleIssues({ tweets = [], products = [], sources = [], plugsAt = [], verbatim = false } = {}, rules) {
  const holds = [], reviews = [];
  if (!rules) return { holds, reviews };
  const ctas = Math.max(plugsAt.length, linkTweets(tweets, sources).length);
  if (rules.ctaMax !== null && ctas > rules.ctaMax) {
    holds.push(`${ctas} calls to action; this run allows at most ${rules.ctaMax}${verbatim ? ' (verbatim body: swap it, a repost cannot be trimmed)' : ''}`);
  }
  // A product is an ASIN string or an {asin} object (the contractProducts shapes product-allocation takes);
  // counting only objects let a plain ASIN list slip past the cap.
  const asins = new Set(products.map((p) => text(typeof p === 'string' ? p : p?.asin)).filter(Boolean));
  if (asins.size > rules.productsMax) holds.push(`${asins.size} different products; this run allows at most ${rules.productsMax}`);
  if (rules.sources !== 'off') {
    const sourced = new Set((Array.isArray(sources) ? sources : []).filter((s) => text(s?.source)).map((s) => Number(s.tweet)));
    const missing = evidenceTweets(tweets).filter((n) => !sourced.has(n));
    if (missing.length) {
      const quoted = missing.map((n) => `T${n} "${String(tweets[n - 1]).slice(0, 90)}"`).join('; ');
      (rules.sources === 'hold' ? holds : reviews).push(`Statistic or study without a named source: ${quoted}. Record it in draft.sources (the note shows it); the copy needs no citation`);
    }
  }
  // Sources support the writing, never crowd it (owner 2026-09-23): too many paper-style citations in
  // the copy is flagged, never held, and never on a verbatim body (its words are what earned).
  const cited = citationTweets(tweets);
  const cap = LAWS.tweet?.citationTweetsMax;
  if (!verbatim && Number.isInteger(cap) && cited.length > cap) {
    reviews.push(`Citations crowd the copy: ${cited.length} tweets carry a paper-style citation (T${cited.join(', T')}); keep at most ${cap} where the claim leans on it and move the rest to draft.sources`);
  }
  return { holds, reviews };
}

/** Each row's comparable body. Pots of one seed share its donor and origin body BY DESIGN (a seed-dial
 *  cell needs 2-4 of them), so a pot is compared by its own written copy, never by donor. The
 *  R2026-09-23 kim/magnus twins were exactly that: two pots whose copy came out near-identical. */
export function twinBodies(rows = []) {
  return rows.map((row) => {
    const pot = laneOf(row.lane) === 'seed';
    const tweets = pot ? (Array.isArray(row.draft?.tweets) ? row.draft.tweets : []) : (Array.isArray(row.source?.tweets) ? row.source.tweets : []);
    return { id: row.id, pot, tweets: tweets.map(String), donor: pot ? '' : text(row.source?.donorId || row.source?.id) };
  });
}

/** The pairs Jev reads for premise twins (decisions/premise-twin.mjs): every pair with text on both
 *  sides, except the same donor (the code already holds it) and pot with pot (one seed's pots share
 *  a premise by design; the code's copy overlap still reads them). */
export function jevTwinPairs(rows = []) {
  const bodies = twinBodies(rows), pairs = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (!a.tweets.length || !b.tweets.length || (a.donor && a.donor === b.donor) || (a.pot && b.pot)) continue;
      pairs.push({ a: a.id, b: b.id, input: { a: { hook: a.tweets[0], tweets: a.tweets }, b: { hook: b.tweets[0], tweets: b.tweets } } });
    }
  }
  return pairs;
}

/** Near-identical source bodies anywhere in the run (twins = 'run'). Returns id -> [issue]. `jevTwins`
 *  (RUN_DIR/jev/selection.json twins) adds Jev's same-idea pairs; it can only add a hold. `accepted`
 *  (runAcceptedTwins) names the pairs the owner accepted in their words; only those pairs are cleared. */
export function runTwinIssues(rows = [], rules, warn = LAWS.selection.donorOverlapWarn, { jevTwins = [], pinned = [], accepted = [] } = {}) {
  const out = new Map();
  if (!rules || rules.twins !== 'run') return out;
  const bodies = twinBodies(rows);
  // A pair the owner accepted in their own words (RUN_DIR/twins-accepted.json, runAcceptedTwins; owner
  // R2026-10-03: "accept") is not held for being twins of each other. Against other rows each one is
  // compared like any row, and a pair with no recorded words is never cleared.
  const okPair = new Set(accepted.filter((p) => p?.a && p?.b && String(p.message || '').trim()).flatMap((p) => [`${p.a}\u0000${p.b}`, `${p.b}\u0000${p.a}`]));
  // A donor the owner pinned to several pages (donor-pins.mjs, owner 2026-09-28: "Cover it on 3 pages")
  // is the same donor on purpose: its copies are not twins of each other. Against other rows it is
  // compared like any row.
  const pins = new Set(pinned);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (a.donor && a.donor === b.donor && pins.has(a.donor)) continue;
      if (okPair.has(`${a.id}\u0000${b.id}`)) continue;
      let why = null;
      if (a.donor && a.donor === b.donor) why = 'same donor';
      else if (a.pot === b.pot && a.tweets.length && b.tweets.length) {
        const overlap = Math.max(bodyOverlap(a.tweets, b.tweets), bodyOverlap(b.tweets, a.tweets));
        if (overlap >= warn) why = `near-identical ${a.pot ? 'copy' : 'source'} (${Math.round(overlap * 100)}% overlap)`;
      }
      if (!why) {
        const jevSaid = jevTwins.find((t) => t.action === 'twin' && ((t.a === a.id && t.b === b.id) || (t.a === b.id && t.b === a.id)));
        if (jevSaid) why = `the same idea (Jev: ${(jevSaid.reasons || []).join('; ') || 'twin'})`;
      }
      if (!why) continue;
      // The later row is the one held: the earlier keeps its place, the later is the swap.
      out.set(b.id, [...(out.get(b.id) || []), `${why} with ${a.id} in this run; swap one of them`]);
    }
  }
  return out;
}

/** The selection check: every row against the rules that can already be read before any writing. */
export function selectionIssues(rows = [], rules, { jevTwins = [], pinned = [], accepted = [] } = {}) {
  const twins = runTwinIssues(rows, rules, undefined, { jevTwins, pinned, accepted });
  return rows.map((row) => {
    const holds = [...(twins.get(row.id) || [])], reviews = [];
    const lane = text(row.lane).toLowerCase();
    const verbatim = lane === 'harvest' && row.source?.variation !== true;
    const named = Array.isArray(row.products) ? row.products : [];
    if (!verbatim && named.length) holds.push(...rowRuleIssues({ products: named }, rules).holds);
    if (verbatim && rules?.reposts === 'none') holds.push('Verbatim reposts are off for this run');
    else if (verbatim) {
      const tweets = Array.isArray(row.source?.tweets) ? row.source.tweets.map(String) : [];
      if (!tweets.length) holds.push('Repost body is missing, so it cannot be re-checked against this run’s rules');
      const checked = rowRuleIssues({ tweets, products: row.products || [], sources: row.source?.sources || [], verbatim: true }, rules);
      holds.push(...checked.holds); reviews.push(...checked.reviews);
    }
    return { id: row.id, status: holds.length ? 'hold' : reviews.length ? 'review_needed' : 'ok', holds, reviews };
  });
}

/** The resolved content rules for a run, or null for a run whose intake predates them. */
export function runContentRules(runDir) {
  if (!runDir) return null;
  let intake;
  try { intake = JSON.parse(readFileSync(join(resolve(runDir), 'intake.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return intake.content || null;
}

/** The donors the owner pinned to several pages in this run (intake.coverSelection.pins, from
 *  queues/donor-pins.json at intake time); [] for a run without them. */
export function runPins(runDir) {
  if (!runDir) return [];
  try { return (JSON.parse(readFileSync(join(resolve(runDir), 'intake.json'), 'utf8')).coverSelection?.pins || []).map((p) => p.recId).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * The twin pairs the owner accepted for this run, from RUN_DIR/twins-accepted.json:
 * { "pairs": [{ "a": "S1003-lorenzo", "b": "S1003-tina", "message": "<the owner's exact words>", "at": "ISO" }] }.
 * [] when the file is missing. A malformed file throws rather than silently clearing nothing (or everything).
 */
export function runAcceptedTwins(runDir) {
  if (!runDir) return [];
  let raw;
  try { raw = readFileSync(join(resolve(runDir), 'twins-accepted.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const pairs = JSON.parse(raw).pairs;
  if (!Array.isArray(pairs)) throw new Error('twins-accepted.json needs a "pairs" array');
  for (const p of pairs) {
    if (!p?.a || !p?.b || !String(p.message || '').trim()) throw new Error('twins-accepted.json: every pair needs a, b and the owner\'s words in message');
  }
  return pairs;
}

/** Jev's premise-twin verdicts for this run (run-jev --stage selection), [] when not read yet. */
export function jevTwinsFor(runDir) {
  try { return JSON.parse(readFileSync(join(resolve(runDir), 'jev', 'selection.json'), 'utf8')).twins || []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  if (flag('stage') !== 'selection' || !flag('run-dir') || !flag('input')) fail('Usage: run-rules.mjs --stage selection --run-dir RUN_DIR --input SELECTION.json');
  const rules = runContentRules(flag('run-dir'));
  if (!rules) fail('This run has no content rules: resolve the intake (scripts/run-intake.mjs) into RUN_DIR/intake.json first');
  const input = JSON.parse(readFileSync(resolve(flag('input')), 'utf8'));
  const rows = selectionIssues(Array.isArray(input.rows) ? input.rows : [], rules, { jevTwins: jevTwinsFor(flag('run-dir')), pinned: runPins(flag('run-dir')), accepted: runAcceptedTwins(flag('run-dir')) });
  const counts = Object.fromEntries(['ok', 'review_needed', 'hold'].map((s) => [s, rows.filter((r) => r.status === s).length]));
  return { schema: 'run-rules-selection-v1', rulesSha256: rules.rulesSha256, counts, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = main(process.argv.slice(2));
    console.log(JSON.stringify(out, null, 2));
    if (out.counts.hold) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
