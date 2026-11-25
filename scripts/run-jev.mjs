#!/usr/bin/env node
// Jev reads every /run row once, in about a second for the whole run, and says where the owner
// should look. REPORT-ONLY: it never changes a row's status, and a failed read is "not read", never a
// pass (plan invariant 1). Code decides every flag from the answers; Jev only answers questions.
//
// Why (R2026-09-23 post-mortem, owner 2026-09-23): half the run's extra work was late catches —
// marcos's plug still led in to CoQ10 after the product became NAD+, a study was misreported and only
// the final reviewer caught it, reviews took 3-11 minutes a row and re-ran on every copy change. Each
// question below is one of those catches, asked at the stop where the problem is born.
//
//   drafts     per row: does each plug lead to the product linked there; which tweets make a claim
//              that needs a source; does the thread keep its promise without the purchase tweets;
//              which seam reads worst; the safety battery; the owner's own intake answers as checks.
//   selection  per donor: the safety battery, the owner's intake answers, and the sensitive topics.
//   drafts, also  the editorial pre-score (decisions/editorial-prescore.mjs, plan Track A) through
//              jev-decide.mjs decide() in shadow: glue.md's five questions one by one, roles computed in
//              code, pointers quoted by code. Its action (pass / review_needed / hold) is printed beside
//              the incumbent (the subagent's verdict) and logged; it never changes the row.
//
//   node scripts/run-jev.mjs --stage drafts|selection --run-dir RUN_DIR --input SPEC.json
//   node scripts/run-jev.mjs --stage plugs --run-dir RUN_DIR --input SPEC.json [--rows C01,C02]
//              products changed after drafting (a swap): re-asks only the plug questions for those rows.
//
// Writes RUN_DIR/jev/<stage>.json (keeping earlier readings of rows this call did not read, so a
// rolling batch never wipes the last one's), which must be outside Git: each flag quotes up to 80 characters of
// the tweet it points at, and unpublished copy never enters the repo (the CLI refuses a RUN_DIR inside
// it). It prints one line per flagged row. The drafts packet prints the reading of a row
// whose copy digest still matches.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { choice, jev, noul, score } from '../jev.mjs';
import { linkTweets, runContentRules } from './run-rules.mjs';
import { INTENT_DIMENSIONS, INTENT_QUESTIONS, intentVerdict, plugZone, WE_SELL } from '../donor-intent.mjs';
import { askThrough, chunkedClient, createDecisionLog, decide, decisionConfig, planChunks } from '../jev-decide.mjs';
import { LAWS } from '../laws.mjs';

// Pinned (plan invariant 5): a reading is only comparable across runs on one model build.
export const RUN_JEV_MODEL = 'jev-1.13';
export const FLAG_AT = 0.7;      // a yes this strong is flagged to the owner
export const PLUG_OK_AT = 0.5;   // below this a plug may not lead to its linked product
export const MAX_TWEETS = 40; // longer threads are read to T40 and say so (a plug past it is never silently skipped)
const text = (value) => String(value ?? '').trim();
const sha = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const copyDigest = (tweets) => sha(JSON.stringify(tweets));
// The products a plug check read against (plan Track S: "every products change re-runs a check that each
// plug's lead-in names the product linked there"). A swap that leaves the copy alone changes only this.
// Identity only (ASIN and label): minting or re-minting a link for the same product is not a change.
export const productsDigest = (products) => sha(JSON.stringify((Array.isArray(products) ? products : [])
  .map((p) => [text(p?.asin), text(p?.label || p?.substance || p?.title)])));

// The owner's content-policy lines are read, never loosened (plan §6 item 11): these only ADD flags.
export const SAFETY_QUESTIONS = {
  explicit: noul('Is this thread sexually explicit or crude?', {
    true: 'It describes sex acts, porn or genitals graphically, or is crude about sex.',
    false: 'It is not explicit. Hormones, libido, testosterone and sex drive discussed as health topics are NOT explicit.' }),
  sexual_behaviour: noul('Is this thread mainly about a sexual behaviour (for example masturbation, porn use or sexual performance habits)?', {
    true: 'A sexual behaviour is the main subject of the thread.',
    false: 'Sexual behaviour is absent or only a passing mention; hormone or libido health alone does not count.' }),
  about_cancer: noul('Is cancer (its causes, prevention, treatment or cure) a subject of this thread, beyond a passing mention?'),
  rx_drug: noul('Does this thread recommend that the reader take, stop or change a prescription drug?', {
    true: 'It tells the reader to start, stop or swap a prescription medicine.',
    false: 'Prescription drugs are absent, only mentioned, or the reader is told to ask a doctor.' }),
  contrarian_medicine: noul('Does this thread tell the reader that mainstream medical advice is wrong or dangerous (for example against sunscreen, vaccines, statins or seed oils)?'),
  named_quote: noul('Does this thread attribute a quote or a claim to a named real person?'),
  off_brand: noul('Is this thread mainly about politics, religion or breaking news rather than the reader’s own life?'),
};

/** The owner's free-text intake answer, split into checks Jev can read ("no seed oils; avoid Ozempic"). */
export function ownerClauses(other) {
  return text(other).split(/[;\n]|\.\s/).map((c) => c.trim().replace(/\.$/, '')).filter((c) => c.length >= 4).slice(0, 8);
}
function ownerQuestions(clauses) {
  return Object.fromEntries(clauses.map((clause, i) => [`owner_${i}`, noul(
    `The owner set this rule for the run: "${clause}". Does this thread break that rule, or touch the topic it names?`,
    { true: 'The thread goes against the rule or is about the topic it names.', false: 'The thread has nothing to do with the rule.' })]));
}

/** Tweets named T1..Tn: Jev points by name and code quotes, so evidence always exists in the copy. */
export function named(tweets) {
  return Object.fromEntries(tweets.slice(0, MAX_TWEETS).map((t, i) => [`T${i + 1}`, String(t)]));
}

/** Which product each plug tweet links: {{LINK}} is product 1, {{LINK2}} product 2 (gate-thread.mjs). */
export function plugMap(tweets, products = []) {
  const out = [];
  tweets.forEach((tweet, index) => {
    const t = String(tweet);
    const slots = [...t.matchAll(/\{\{LINK(\d*)\}\}/g)].map((m) => (m[1] ? Number(m[1]) : 1) - 1);
    // A minted link counts only as a whole token, so ".../a" never matches a tweet carrying ".../ab".
    const tokens = new Set(t.split(/\s+/).map((w) => w.replace(/[.,;:!?)\]]+$/, '')));
    const minted = products.map((p, i) => (text(p?.link) && !/\{\{LINK\d*\}\}/.test(p.link) && tokens.has(text(p.link)) ? i : null)).filter((i) => i != null);
    for (const i of new Set([...slots, ...minted])) if (products[i]) out.push({ tweet: index + 1, product: i, label: text(products[i].label || products[i].title || products[i].asin) });
  });
  return out;
}

export function draftQuestions(row, clauses = []) {
  const tweets = row.tweets.slice(0, MAX_TWEETS);
  const plugs = plugMap(tweets, row.products);
  const q = { ...SAFETY_QUESTIONS, ...ownerQuestions(clauses) };
  plugs.forEach((p, i) => {
    q[`plug_${i}`] = noul(`Does tweet T${p.tweet} lead the reader to ${p.label}, the product linked in that tweet, rather than to a different product or substance?`, {
      true: `T${p.tweet} and the tweet before it build the need that ${p.label} answers, and name it or its substance.`,
      false: `T${p.tweet} argues for, names or leads in to a different product or substance than ${p.label}.` });
  });
  tweets.forEach((_, i) => {
    q[`claim_${i + 1}`] = noul(`Does T${i + 1} state a statistic, a study or trial result, or a specific health outcome as fact?`, {
      true: 'It gives a number, cites research, or promises a specific health result as established fact.',
      false: 'It gives advice, an opinion, a mechanism in general terms, or a call to action, with no specific factual claim.' });
  });
  q.promise_kept = score('If the reader skips every tweet that asks them to buy something, does the rest of the thread still deliver what T1 promises?', [
    'No: the promise is only paid off inside the purchase tweets, or not at all.',
    'Partly: some of the promise is delivered outside the purchase tweets.',
    'Yes: a reader who buys nothing still gets everything T1 promised.' ]);
  if (tweets.length >= 3) q.weakest_seam = choice('Which tweet follows least naturally from the tweet before it?', {
    ...Object.fromEntries(tweets.slice(1).map((_, i) => [`T${i + 2}`, null])),
    none: 'Every tweet follows naturally from the one before it.' });
  return { questions: q, plugs };
}

// At selection the same call also reads the donor's buyer intent (the /funnel rubric, donor-intent.mjs),
// once per run, so products, drafts and the note reuse it instead of re-reasoning it in prose (plan W6).
export function selectionQuestions(clauses = []) {
  return { ...SAFETY_QUESTIONS, ...ownerQuestions(clauses), ...INTENT_QUESTIONS };
}

/** Pure: the intent scores, their total and the rubric's own band; a "swap" band is flagged. */
export function intentReading(answers) {
  const dims = Object.fromEntries(INTENT_DIMENSIONS.map((k) => [k, answers[k]?.score ?? null]));
  const vals = Object.values(dims);
  const total = vals.every((v) => v != null) ? +vals.reduce((a, b) => a + b, 0).toFixed(2) : null;
  return { dims, total, verdict: intentVerdict(total) };
}

/** Pure: answers -> flags for the owner. The copy's own numbers pick the words; Jev never writes them. */
export function draftFlags(answers, { tweets, plugs, clauses = [], sources = [], rules = null }) {
  const flags = [];
  const quote = (n) => `"${String(tweets[n - 1] ?? '').slice(0, 80)}"`;
  plugs.forEach((p, i) => {
    const y = answers[`plug_${i}`]?.noul;
    if (y != null && y < PLUG_OK_AT) flags.push({ kind: 'plug', tweet: p.tweet, p: y, note: `T${p.tweet} may not lead to ${p.label}, the product linked there (${y.toFixed(2)}) ${quote(p.tweet)}` });
  });
  const sourced = new Set((sources || []).filter((s) => text(s?.source)).map((s) => Number(s.tweet)));
  tweets.slice(0, MAX_TWEETS).forEach((_, i) => {
    const y = answers[`claim_${i + 1}`]?.noul;
    if (y != null && y >= FLAG_AT && !sourced.has(i + 1)) flags.push({ kind: 'claim', tweet: i + 1, p: y, note: `T${i + 1} makes a claim with no named source (${y.toFixed(2)}) ${quote(i + 1)}` });
  });
  const kept = answers.promise_kept?.score;
  if (kept != null && kept < 1.2) flags.push({ kind: 'promise', p: kept, note: `A reader who buys nothing may not get what T1 promises (${kept.toFixed(2)} of 2)` });
  const seam = answers.weakest_seam;
  if (seam?.choice && seam.choice !== 'none' && seam.confidence >= 0.6) {
    const n = Number(seam.choice.slice(1));
    flags.push({ kind: 'seam', tweet: n, p: seam.confidence, note: `Weakest seam: T${n - 1} → T${n} ${quote(n)}` });
  }
  flags.push(...safetyFlags(answers, { clauses, rules }));
  return flags;
}

export function safetyFlags(answers, { clauses = [], rules = null } = {}) {
  const flags = [];
  const sensitive = new Set(['sexual_behaviour', 'contrarian_medicine', 'named_quote']);
  const allowed = new Set(LAWS.jev?.allowedSafetyClasses || []); // owner, 2026-09-23: "quoting is fine"
  for (const key of Object.keys(SAFETY_QUESTIONS)) {
    const y = answers[key]?.noul;
    if (y == null || y < FLAG_AT || allowed.has(key)) continue;
    const exclude = sensitive.has(key) && rules?.sensitive === 'exclude';
    flags.push({ kind: 'safety', key, p: y, note: `${key.replace(/_/g, ' ')} (${y.toFixed(2)})${exclude ? ' — this run excludes it: swap at selection' : ''}` });
  }
  clauses.forEach((clause, i) => {
    const y = answers[`owner_${i}`]?.noul;
    if (y != null && y >= FLAG_AT) flags.push({ kind: 'owner-rule', p: y, note: `Your rule "${clause}" (${y.toFixed(2)})` });
  });
  return flags;
}

/** Keys Jev was asked but did not answer. Any gap means the row was not fully read, never "clean". */
export function missingAnswers(questions, answers = {}) {
  return Object.keys(questions).filter((k) => {
    const a = answers[k];
    return !a || (a.noul == null && a.score == null && a.choice == null);
  });
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// The editorial pre-score (decisions/editorial-prescore.mjs, plan Track A): run through decide() under
// its laws.json mode (shadow), so the incumbent's action is what decide() returns and Jev's reading is
// only reported. The registry is imported lazily: the decision module imports this file.
export const PRESCORE = 'editorial-prescore';

/** Pure: the decision's input from a drafts row. The incumbent is the subagent's recorded verdict. */
export function prescoreInput(row, tweets) {
  return { tweets: tweets.map(String), products: row.draft?.products || [], account: row.account, ctaDepth: row.draft?.ctaDepth,
    donorHook: row.source?.hook, sources: row.draft?.sources, editorialVerdict: row.draft?.editorialReview?.verdict ?? null };
}

/**
 * One pre-score per row. REPORT-ONLY: the result is stored in the reading and printed; it never touches
 * the row's status. `log` defaults to none (a library or test caller); main() passes the batched file
 * log, which keeps hashes and short ids only. A failure of any kind is "not read", never a pass.
 */
export async function editorialPrescore(row, tweets, { client, laws = LAWS, log = null, cache, registry = null } = {}) {
  try {
    const reg = registry || (await import('../decisions/index.mjs')).DECISIONS;
    const decision = reg[PRESCORE];
    const input = prescoreInput(row, tweets);
    let calls = null;
    try { calls = planChunks(decision.questions(decision.stateOf(input)), { max: decision.MAX_QUESTIONS_PER_CALL, groupOf: decision.groupOf }).map((c) => c.length); } catch { /* decide() reports it */ }
    const chunked = client ? chunkedClient(client, { max: decision.MAX_QUESTIONS_PER_CALL, groupOf: decision.groupOf }) : null;
    const r = await decide(PRESCORE, input, { client: chunked, registry: reg, laws, log, ...(cache ? { cache } : {}), ...(row?.id != null ? { subject: `row:${row.id}` } : {}) });
    const base = { mode: r.mode, incumbent: r.incumbentAction, questionSetHash: r.questionSetHash.slice(0, 12), calls };
    if (r.mode === 'off') return { ...base, status: 'off' };
    if (r.source === 'fallback' || !r.answers) return { ...base, status: 'not read', reason: r.fallback || 'not read' };
    const verdict = decision.policy(r.answers, decisionConfig(PRESCORE, laws).thresholds, { input, state: decision.stateOf(input) });
    return { ...base, status: 'read', model: r.model, action: verdict.action, confidence: verdict.confidence,
      pointers: verdict.pointers.map(({ kind, level, tweet, note }) => ({ kind, level, tweet: tweet ?? null, note })),
      claims: verdict.claims.map(({ tweet, line, kind, note }) => ({ tweet, line, kind, note })) };
  } catch (error) {
    return { status: 'not read', reason: `${error?.message || 'error'}`.slice(0, 160) };
  }
}

async function readDraft(row, tweets, base, started, { client, rules, clauses, log = null }) {
  try {
    const products = (row.draft?.products || []).map((p) => ({ ...p, label: text(p.label || p.substance || p.title || p.asin).slice(0, 80) }));
    const { questions, plugs } = draftQuestions({ tweets: tweets.map(String), products }, clauses);
    const result = await askThrough('drafts-read', client, { state: { hook: String(tweets[0]), tweets: named(tweets) }, questions }, { log, role: 'run-jev-drafts', ...(row?.id != null ? { subject: `row:${row.id}` } : {}) });
    const gaps = missingAnswers(questions, result.answers);
    if (gaps.length) return { ...base, status: 'not read', reason: `Jev left ${gaps.length} question(s) unanswered (${gaps.slice(0, 4).join(', ')})` };
    const flags = draftFlags(result.answers, { tweets: tweets.map(String), plugs, clauses, sources: row.draft?.sources, rules });
    if (tweets.length > MAX_TWEETS) flags.push({ kind: 'partial', note: `Read to T${MAX_TWEETS} of ${tweets.length}: read T${MAX_TWEETS + 1} onward in full` });
    return { ...base, status: 'read', model: result.model, ms: Date.now() - started, plugs: plugs.map(({ tweet, label }) => ({ tweet, label })),
      links: linkTweets(tweets.map(String), row.draft?.sources), flags };
  } catch (error) {
    return { ...base, status: 'not read', reason: `${error?.details?.code || error?.message || 'error'}`.slice(0, 160) };
  }
}

/** Read every row once. `client` is jev(env) or a test fake with the same `ask`. `prescore` holds the
 *  editorial pre-score's options ({ log, laws, cache, registry }), or false to skip it. */
export async function readRows(stage, rows, { client, rules = null, other = '', concurrency = 12, model = RUN_JEV_MODEL, prescore = {} } = {}) {
  const clauses = ownerClauses(other);
  return pool(rows, concurrency, async (row) => {
    const started = Date.now();
    // A seed pot has no donor: at selection its copy is the greenhouse body in row.draft.
    const tweets = (stage === 'drafts' ? row.draft?.tweets : (row.source?.tweets || row.draft?.tweets)) || [];
    const base = { id: row.id, copySha256: copyDigest(tweets.map(String)), ...(stage === 'drafts' ? { productsSha256: productsDigest(row.draft?.products) } : {}) };
    if (!tweets.length) return { ...base, status: 'not read', reason: 'no tweets to read' };
    if (stage === 'drafts') {
      const reading = await readDraft(row, tweets, base, started, { client, rules, clauses, log: prescore?.log ?? null });
      if (prescore === false) return reading;
      return { ...reading, prescore: await editorialPrescore(row, tweets, { client, ...prescore }) };
    }
    try {
      const list = tweets.slice(0, MAX_TWEETS).map(String);
      const state = { hook: String(tweets[0]), tweets: list, we_sell: WE_SELL, plug_zone: plugZone(list) };
      const questions = selectionQuestions(clauses);
      const result = await askThrough('selection-read', client, { state, questions }, { log: prescore?.log ?? null, role: 'run-jev-selection' });
      const gaps = missingAnswers(questions, result.answers);
      if (gaps.length) return { ...base, status: 'not read', reason: `Jev left ${gaps.length} question(s) unanswered (${gaps.slice(0, 4).join(', ')})` };
      const intent = intentReading(result.answers);
      const flags = safetyFlags(result.answers, { clauses, rules });
      if (intent.verdict === 'swap') flags.push({ kind: 'intent', p: intent.total, note: `low buyer intent (${intent.total} of 10: the /funnel rubric says swap)` });
      return { ...base, status: 'read', model: result.model, ms: Date.now() - started, intent, flags };
    } catch (error) {
      return { ...base, status: 'not read', reason: `${error?.details?.code || error?.message || 'error'}`.slice(0, 160) };
    }
  });
}

/** The lines for a row whose products changed since the drafts read: the recheck, or how to run it. */
export function plugRecheckLines(reading, tweets, products) {
  if (!reading || reading.productsSha256 == null || reading.productsSha256 === productsDigest(products)) return [];
  const recheck = reading.plugRecheck;
  if (!recheck || recheck.copySha256 !== copyDigest(tweets.map(String)) || recheck.productsSha256 !== productsDigest(products)) {
    return ['- Jev plug check: products changed since the drafts read, so its plug lines are stale. Run `node scripts/run-jev.mjs --stage plugs --run-dir RUN_DIR --input SPEC.json` and rebuild this packet'];
  }
  if (recheck.status !== 'read') return [`- Jev plug check (products changed): NOT READ (${recheck.reason}) — check each plug's lead-in names its linked product`];
  if (!recheck.flags.length) return [`- Jev plug check (products changed, report-only · ${recheck.model || 'no plug links a product'}): every plug leads to its linked product`];
  return [`- Jev plug check (products changed, report-only · ${recheck.model || 'no plug links a product'}): look at ${recheck.flags.length} thing(s)`, ...recheck.flags.map((f) => `  - ${f.note}`)];
}

// Phase 3a donor selection (decisions/donor-*.mjs): account fit, writeability and the pick-time screen,
// each through decide() in its laws.json mode (shadow). REPORT-ONLY: it adds `reading.donor` and
// returns print lines; it never touches a reading's status or flags, the selection, or an approval.
// A failed or partial read is "not read". Donor rows only: a verbatim harvest or a pot has no donor.
export const DONOR_DECISIONS = Object.freeze(['donor-account-fit', 'donor-writeability', 'donor-screen']);
const DONOR_LANES = new Set(['', 'cover', 'remix']);

export async function donorDecisions(readings, specRows = [], { client, laws = LAWS, log = null, cache, registry = null, accountOf = null, pods = null } = {}) {
  let reg, checks, podList;
  try {
    reg = registry || (await import('../decisions/index.mjs')).DECISIONS;
    checks = await import('../checks.mjs');
    podList = pods || (await import('../pods.mjs')).PODS;
  } catch (error) { return [`  donor decisions: NOT READ (${String(error?.message || 'error').slice(0, 160)}) — read the donors in full`]; }
  const account = accountOf || (async (name) => (await import('../accounts.mjs')).getAccount(name));
  const byId = new Map(specRows.map((r) => [r.id, r]));
  const one = async (decisionName, input) => {
    try {
      const r = await decide(decisionName, input, { client, registry: reg, laws, log, ...(cache ? { cache } : {}) });
      const out = { mode: r.mode, incumbent: r.incumbentAction };
      if (r.mode === 'off') return { ...out, status: 'off' };
      if (r.source === 'fallback' || !r.answers) return { ...out, status: 'not read', reason: r.fallback || 'not read' };
      const d = reg[decisionName];
      const v = d.policy(r.answers, decisionConfig(decisionName, laws).thresholds, { input, state: d.stateOf(input) });
      return { ...out, status: 'read', model: r.model, action: v.action, confidence: v.confidence ?? null, reasons: v.reasons || [], notes: v.notes || [], bestPod: v.bestPod ?? null };
    } catch (error) { return { status: 'not read', reason: `${error?.message || 'error'}`.slice(0, 160) }; }
  };
  const lines = new Map();
  // 4 rows x 3 decisions = 12 calls in flight, the same ceiling readRows keeps.
  await pool(readings, 4, async (reading) => {
    const row = byId.get(reading.id) || {};
    const tweets = (Array.isArray(row.source?.tweets) ? row.source.tweets : []).map(String);
    if (!DONOR_LANES.has(text(row.lane).toLowerCase()) || !tweets.length) return;
    const donor = { hook: text(row.source?.hook) || tweets[0], tweets, topic: row.source?.topic || null };
    const notRead = (error) => ({ status: 'not read', reason: String(error?.message || error || 'error').slice(0, 160) });
    let page = null;
    try { page = row.account ? await account(row.account) : null; } catch { /* reported as not read below */ }
    const [fit, writeability, screen] = await Promise.all([
      page ? one('donor-account-fit', { ...donor, account: page }) : notRead(`no account ${text(row.account) || '(missing)'}`),
      Promise.resolve().then(() => reg['donor-writeability'].eligiblePods(`${donor.hook}\n${tweets.join('\n')}`, podList, checks))
        .then((eligible) => one('donor-writeability', { ...donor, pods: eligible }), notRead),
      Promise.resolve().then(() => reg['donor-screen'].incumbentReasons(donor))
        .then((incumbentReasons) => one('donor-screen', { ...donor, incumbentReasons }), notRead),
    ]);
    reading.donor = { fit, writeability, screen };
    lines.set(reading.id, `  ${reading.id}: ${donorLine(reading.donor)}`);
  });
  return readings.map((r) => lines.get(r.id)).filter(Boolean);
}

/**
 * Premise twins across the run (decisions/premise-twin.mjs): one decide() per pair from
 * run-rules.mjs jevTwinPairs. Returns [{ a, b, status, action, reasons, confidence, mode }]; a failed
 * read is "not read" (the code's overlap check still holds what it holds).
 */
export async function premiseTwins(specRows = [], { client, laws = LAWS, log = null, cache, registry = null, concurrency = 12 } = {}) {
  const { jevTwinPairs } = await import('./run-rules.mjs');
  const reg = registry || (await import('../decisions/index.mjs')).DECISIONS;
  const pairs = jevTwinPairs(specRows);
  return pool(pairs, concurrency, async ({ a, b, input }) => {
    try {
      const r = await decide('premise-twin', input, { client, registry: reg, laws, log, ...(cache ? { cache } : {}) });
      if (r.mode === 'off') return { a, b, status: 'off' };
      if (r.source === 'fallback' || !r.answers) return { a, b, status: 'not read', reason: r.fallback || 'not read', mode: r.mode };
      const v = reg['premise-twin'].policy(r.answers, decisionConfig('premise-twin', laws).thresholds);
      // Shadow mode reports; only an acting mode's twin reaches the selection hold.
      const acting = ['decide', 'enforce'].includes(r.mode);
      return { a, b, status: 'read', mode: r.mode, action: acting ? v.action : 'distinct', jevAction: v.action, reasons: v.reasons, confidence: v.confidence };
    } catch (error) { return { a, b, status: 'not read', reason: String(error?.message || 'error').slice(0, 160) }; }
  });
}

/** Pure: one print line for a row's donor decisions, Jev's action beside the incumbent's. */
export function donorLine({ fit, writeability, screen } = {}) {
  const part = (label, r) => {
    if (!r) return `${label} (not run)`;
    if (r.status === 'off') return `${label} off`;
    if (r.status !== 'read') return `${label} NOT READ (${r.reason})`;
    const why = [...(r.reasons || []), ...(r.notes || []).map((n) => `note ${n}`), ...(r.bestPod ? [`pod ${r.bestPod}`] : [])];
    const conf = Number.isFinite(r.confidence) ? `, ${r.confidence.toFixed(2)}` : '';
    return `${label} ${r.action}${why.length ? `: ${why.join(', ')}` : ''} (incumbent ${r.incumbent}${conf})`;
  };
  const mode = [...new Set([fit, writeability, screen].map((r) => r?.mode).filter(Boolean))].join('/') || 'shadow';
  return `donor (${mode} · report-only) ${part('fit', fit)} · ${part('writeability', writeability)} · ${part('screen', screen)}`;
}

/** The lines a packet prints for one row: only when the reading is for this exact copy. */
export function jevLines(reading, tweets, products) {
  if (!reading) return ['- Jev read: (not run for this row)'];
  if (reading.copySha256 !== copyDigest(tweets.map(String))) return ['- Jev read: stale (the copy changed since it was read); re-run scripts/run-jev.mjs'];
  // Products changed since the read (a swap): its plug flags are for the old products, so they give way
  // to the recheck's lines. Without `products` (an older caller) nothing changes.
  const recheck = products === undefined ? [] : plugRecheckLines(reading, tweets, products);
  const flags = recheck.length ? (reading.flags || []).filter((f) => f.kind !== 'plug') : reading.flags;
  const read = reading.status !== 'read' ? [`- Jev read: NOT READ (${reading.reason}) — read this row in full`]
    : !flags.length ? [`- Jev read: nothing flagged (report-only · ${reading.model})`]
      : [`- Jev read (report-only · ${reading.model}): look at ${flags.length} thing(s)`, ...flags.map((f) => `  - ${f.note}`)];
  return [...read, ...recheck, ...prescoreLines(reading.prescore)];
}

/** The editorial pre-score's lines: Jev's action beside the incumbent's, then the tweets it points at. */
export function prescoreLines(p) {
  if (!p) return [];
  // At decide the reading IS the drafts gate (owner rule 2026-09-23); in shadow it is only reported.
  const acting = p.mode === 'decide' || p.mode === 'enforce';
  const where = acting ? `${p.mode} · the editorial decision` : p.mode ? `${p.mode} · report-only` : 'report-only';
  if (p.status === 'off') return [`- Jev editorial pre-score: off (${where})`];
  if (p.status !== 'read') return [`- Jev editorial pre-score: NOT READ (${p.reason}) — ${acting ? 'the row is held until Jev reads it' : 'the editorial review reads this row in full'}`];
  const craft = p.pointers.filter((x) => x.kind === 'craft');
  const safety = p.pointers.filter((x) => x.kind === 'safety');
  return [`- Jev editorial pre-score (${where} · ${p.model}): ${p.action} · incumbent ${p.incumbent} · ${safety.length} safety · ${craft.length} craft · ${p.claims.length} claim line(s)`,
    ...safety.map((x) => `  - ${x.level === 'hold' ? 'HOLD (safety)' : 'safety'}: ${x.note}`),
    ...craft.map((x) => `  - ${x.level === 'hold' ? 'HOLD (craft)' : x.level === 'review' ? 'check' : 'uncertain'}: ${x.note}`),
    ...p.claims.map((c) => `  - claim: ${c.note}`)];
}

/** RUN_DIR must be outside Git: every reading quotes unpublished copy. Returns the resolved path. */
export function assertRunDirOutsideRepo(runDir) {
  const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const target = resolve(runDir);
  if (target === REPO || target.startsWith(`${REPO}/`)) throw new Error('RUN_DIR must be outside the repository: Jev readings quote unpublished copy');
  return target;
}
/** Write RUN_DIR/jev/<stage>.json, owner-only. */
export function writeReadings(runDir, stage, out) {
  const dir = join(assertRunDirOutsideRepo(runDir), 'jev');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${stage}.json`), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
}
/** Pure: this call's readings plus the earlier ones for rows it did not read. Batches roll, so a drafts
 *  read of batch 2 must not wipe batch 1's readings, which the run card still triages from. A row read
 *  again replaces its old reading; each reading still counts only for the copy digest it carries. */
export function mergeReadings(previous = [], rows = []) {
  const fresh = new Set(rows.map((r) => r.id));
  return [...previous.filter((r) => r && !fresh.has(r.id)), ...rows];
}

export function readingsFor(runDir, stage) {
  if (!runDir) return new Map();
  try {
    const file = JSON.parse(readFileSync(join(resolve(runDir), 'jev', `${stage}.json`), 'utf8'));
    const map = new Map((file.rows || []).map((r) => [r.id, r]));
    // A drafts reading carries the latest products-change recheck for its row (plugs.json), if any.
    if (stage === 'drafts') for (const [id, recheck] of readingsFor(runDir, 'plugs')) if (map.has(id)) map.set(id, { ...map.get(id), plugRecheck: recheck });
    return map;
  } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const stage = flag('stage'), runDir = flag('run-dir'), input = flag('input');
  if (stage === 'plugs' && runDir && input) return (await import('./run-jev-plugs.mjs')).plugsMain({ runDir, input, only: flag('rows') });
  if (!['drafts', 'selection'].includes(stage) || !runDir || !input) throw new Error('Usage: run-jev.mjs --stage drafts|selection --run-dir RUN_DIR --input SPEC.json');
  // Refuse a RUN_DIR inside the repo before any Jev call is paid for (the readings quote unpublished copy).
  const target = assertRunDirOutsideRepo(runDir);
  const spec = JSON.parse(readFileSync(resolve(input), 'utf8'));
  let intake = {};
  try { intake = JSON.parse(readFileSync(join(resolve(runDir), 'intake.json'), 'utf8')); } catch { /* an older run: no owner answers to read */ }
  const { loadEnv } = await import('../lib.mjs');
  const client = jev(loadEnv());
  const started = Date.now();
  // The decision log (learnings/jev-decisions/<month>.jsonl) keeps hashes and short ids, never copy.
  const decisionLog = createDecisionLog();
  let rows, twins = null;
  try {
    rows = await readRows(stage, spec.rows || [], { client, rules: runContentRules(runDir), other: intake.other || '', prescore: { log: decisionLog } });
    if (stage === 'selection') {
      for (const line of await donorDecisions(rows, spec.rows || [], { client, log: decisionLog })) console.log(line);
      twins = await premiseTwins(spec.rows || [], { client, log: decisionLog });
    }
  } finally { decisionLog.flush(); }
  let previous = [];
  try { previous = [...readingsFor(target, stage).values()]; } catch { /* an unreadable old file is replaced */ }
  const all = mergeReadings(previous, rows);
  const out = { schema: 'run-jev-v1', stage, model: RUN_JEV_MODEL, readAt: new Date().toISOString(), ms: Date.now() - started,
    counts: { rows: rows.length, read: rows.filter((r) => r.status === 'read').length, flagged: rows.filter((r) => r.flags?.length).length,
      notRead: rows.filter((r) => r.status !== 'read').length, kept: all.length - rows.length }, rows: all,
    ...(twins ? { twins } : {}) };
  writeReadings(target, stage, out);
  console.log(`${stage}: ${out.counts.read}/${rows.length} read in ${(out.ms / 1000).toFixed(1)}s · ${out.counts.flagged} flagged · ${out.counts.notRead} not read (read those in full)`);
  if (twins) {
    const found = twins.filter((t) => t.action === 'twin'), unread = twins.filter((t) => t.status !== 'read');
    console.log(`premise twins: ${twins.length} pair(s) read · ${found.length} twin(s)${unread.length ? ` · ${unread.length} not read (the code check still ran)` : ''}`);
    for (const t of found) console.log(`  ${t.b} is the same idea as ${t.a}: ${t.reasons.join('; ')} — swap one`);
  }
  for (const r of rows) if (r.status !== 'read' || r.flags.length) console.log(`  ${r.id}: ${r.status !== 'read' ? `NOT READ (${r.reason})` : r.flags.map((f) => f.note).join(' | ')}`);
  if (stage === 'drafts') {
    const pre = rows.map((r) => r.prescore).filter(Boolean);
    const count = (s) => pre.filter((p) => p.status === 'read' && p.action === s).length;
    console.log(`editorial pre-score (shadow, report-only): ${pre.filter((p) => p.status === 'read').length}/${pre.length} read · ${count('hold')} hold · ${count('review_needed')} review_needed · ${count('pass')} pass · ${pre.filter((p) => p.status === 'not read').length} not read`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
