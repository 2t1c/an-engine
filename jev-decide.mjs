// jev-decide.mjs — the decision platform's runtime (plan §1.1 "decide() runtime", Phase 0).
//
// decide(name, input, { client, registry, laws, log, now }) runs ONE registered decision
// (decisions/<name>.mjs) under the mode laws.json `jev.decisions.<name>.mode` gives it:
//
//   off      the incumbent only; Jev is not called.
//   shadow   Jev and the incumbent both run; the incumbent's action is returned. Report-only.
//   propose  Jev's action is returned, marked `proposal: true`; the caller shows it, a person acts.
//   decide   Jev's action is returned when its confidence clears the floor, else the incumbent's.
//   enforce  as decide; the caller applies it with no operator stop (the caller's contract, not ours).
//
// Invariants (plan §1.2), each enforced here and tested in tests/jev-decide.test.mjs:
//   - Fail safe, never fail open: any Jev error (transport, deadline, breaker, a partial answer set,
//     a policy that throws) runs the incumbent path, source 'fallback', logged as not read.
//   - Monotone safety: for a decision declared `safety: true`, the action is the decision's HOLD when
//     the incumbent OR Jev says hold. Jev can add a block, never clear one.
//   - Pinned model: decide/enforce with an unpinned model (jev-latest) are refused and run as shadow.
//     An answering build other than the calibrated one downgrades propose/decide/enforce to shadow.
//   - Wording is part of the model: a question set whose hash differs from the recorded one runs as
//     shadow at most.
//   - The breaker opens for the whole process on the first 401, 403 or model-400.
//
// No network happens here: the Jev client is injected (jev.mjs `jev(env)` in production, a fake in
// tests). Spend is metered by that client's ask() (meterLlmCall), so decide() never meters twice; the
// caller's CLI flushes spend the way every other CLI does (lib.mjs flushLlmSpend).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LAWS } from './laws.mjs';
import { HERE_DIR, priceUsage } from './lib.mjs';
import { JEV_MODEL } from './jev.mjs';
import { breakerReason, questionSetHash } from './swipe-classify.mjs';

export { questionSetHash };

export const MODES = Object.freeze(['off', 'shadow', 'propose', 'decide', 'enforce']);
const ACTING = new Set(['decide', 'enforce']);
const ABOVE_SHADOW = new Set(['propose', 'decide', 'enforce']);
export const SOURCES = Object.freeze(['jev', 'incumbent', 'fallback']);
export const DEFAULT_DEADLINE_MS = 20000;
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;
// JEV_DECISION_LOG_DIR redirects the log (tests that spawn a real script point it at a temp dir, so a
// test run never appends fixture rows to the committed learnings log).
export const DECISION_LOG_DIR = process.env.JEV_DECISION_LOG_DIR || join(HERE_DIR, 'learnings', 'jev-decisions');

/** A model id is pinned when it names a version, not a moving alias. */
export function isPinned(model) {
  const m = String(model || '').trim();
  return Boolean(m) && !/latest/i.test(m) && !m.startsWith('~');
}

// ---- Registry contract ------------------------------------------------------------------------------

/** The question set a decision is hashed on: its static QUESTIONS, or the template of a dynamic set. */
export function decisionQuestions(decision) {
  return decision.QUESTIONS ?? decision.QUESTION_TEMPLATE;
}
export function decisionHash(decision) {
  return questionSetHash(decisionQuestions(decision));
}

/** Throws on a module that does not meet the decisions/<name>.mjs contract. */
export function validateDecision(decision) {
  const problems = [];
  if (!decision || typeof decision !== 'object') throw new Error('decision: not a module');
  if (!decision.name || typeof decision.name !== 'string') problems.push('name');
  for (const fn of ['stateOf', 'policy', 'incumbent']) if (typeof decision[fn] !== 'function') problems.push(fn);
  if (!decision.QUESTIONS && typeof decision.questions !== 'function') problems.push('QUESTIONS or questions()');
  if (!decision.QUESTIONS && !decision.QUESTION_TEMPLATE) problems.push('QUESTION_TEMPLATE (a dynamic set hashes its template)');
  if (!Array.isArray(decision.ACTIONS) || !decision.ACTIONS.length) problems.push('ACTIONS');
  if (decision.safety && !decision.ACTIONS?.includes(decision.HOLD ?? 'hold')) problems.push('a safety decision lists its HOLD action in ACTIONS');
  if (problems.length) throw new Error(`decision ${decision.name || '?'}: missing or bad ${problems.join(', ')}`);
  return decision;
}

/**
 * The hash lock (plan invariant 9, "wording is part of the model"): every decision configured above
 * shadow whose current question-set hash differs from laws.json's recorded one. Off and shadow may
 * run a reworded set; anything that acts may not.
 */
export function hashLockViolations(registry, laws = LAWS) {
  const entries = registry instanceof Map ? [...registry.entries()] : Object.entries(registry || {});
  return entries.map(([name, decision]) => {
    const cfg = decisionConfig(name, laws);
    return { name, mode: cfg.mode, current: decisionHash(decision), recorded: cfg.questionSetHash };
  }).filter((v) => v.mode !== 'off' && v.mode !== 'shadow' && v.current !== v.recorded);
}

// ---- Configuration (laws.json `jev`) ----------------------------------------------------------------

const withoutRationale = (o = {}) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('$')));

export function decisionConfig(name, laws = LAWS) {
  const j = laws?.jev || {};
  const d = j.decisions?.[name] || {};
  const thresholds = withoutRationale(d.thresholds);
  return {
    mode: MODES.includes(d.mode) ? d.mode : 'off', // an unknown or missing mode is off: fail safe
    model: d.model || j.model || JEV_MODEL,
    calibratedBuild: d.calibratedBuild || j.calibratedBuild || null,
    questionSetHash: d.questionSetHash || null,
    thresholds,
    confidenceFloor: Number.isFinite(thresholds.confidenceFloor) ? thresholds.confidenceFloor
      : Number.isFinite(j.confidenceFloor) ? j.confidenceFloor : DEFAULT_CONFIDENCE_FLOOR,
    deadlineMs: Number.isFinite(d.deadlineMs) ? d.deadlineMs : Number.isFinite(j.deadlineMs) ? j.deadlineMs : DEFAULT_DEADLINE_MS,
  };
}

// ---- Breaker (process-wide) -------------------------------------------------------------------------

const BREAKER = { open: false, reason: null };
export const breakerState = () => ({ ...BREAKER });
export function resetBreaker() { BREAKER.open = false; BREAKER.reason = null; }

// ---- Cache ------------------------------------------------------------------------------------------

/**
 * In-memory answer cache, plus an optional JSONL file ({k, v} per line). Keys are hashes; values are
 * the answering build, the typed answers and usage, never state text. A file cache only takes answers
 * from a pinned model, because an alias's answers can change under the same key.
 */
export function createDecisionCache({ file = null } = {}) {
  const memory = new Map();
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const { k, v } = JSON.parse(line); if (k && v) memory.set(k, v); } catch { /* a torn line is skipped */ }
    }
  }
  return {
    get: (key) => memory.get(key),
    set(key, value, { persist = true } = {}) {
      memory.set(key, value);
      if (file && persist) {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`);
      }
    },
    get size() { return memory.size; },
  };
}
const DEFAULT_CACHE = createDecisionCache();

/** sha256 over (name, model, question-set hash, canonical state). */
export function cacheKey({ name, model, questionSetHash: qsHash, state }) {
  return questionSetHash([name, model, qsHash, state]);
}

// ---- Decision log -----------------------------------------------------------------------------------

/** Compact answers: the typed value and its confidence only. Distributions and text never leave. */
export function answersDigest(answers = {}) {
  const r = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
  const out = {};
  for (const [k, a] of Object.entries(answers || {})) {
    if (!a || typeof a !== 'object') continue;
    if (Number.isFinite(a.noul)) out[k] = { n: r(a.noul) };
    else if (Number.isFinite(a.score)) out[k] = { s: r(a.score), c: r(a.confidence) };
    // Only a short option id is logged. A longer or free-text choice (e.g. a hook candidate) is hashed,
    // so unpublished copy can never reach the git-tracked log.
    else if (typeof a.choice === 'string') out[k] = { ch: /^[\w .′″+-]{1,32}$/.test(a.choice) ? a.choice : `sha:${questionSetHash(a.choice).slice(0, 12)}`, c: r(a.confidence) };
  }
  return out;
}

const monthOf = (ts) => String(ts).slice(0, 7);

/**
 * Batched monthly JSONL log: rows buffer in memory and are appended per month shard
 * (<dir>/<YYYY-MM>.jsonl) once `batchSize` rows are waiting, on flush(), and at process exit.
 * The directory is created on first write, so no placeholder file is ever committed.
 */
export function createDecisionLog({ dir = DECISION_LOG_DIR, batchSize = 50, flushOnExit = true } = {}) {
  let buffer = [];
  const log = {
    get pending() { return buffer.length; },
    append(row) {
      buffer.push(row);
      if (buffer.length >= batchSize) log.flush();
    },
    flush() {
      if (!buffer.length) return 0;
      const rows = buffer;
      buffer = [];
      const byMonth = new Map();
      for (const row of rows) {
        const m = monthOf(row.ts);
        if (!byMonth.has(m)) byMonth.set(m, []);
        byMonth.get(m).push(JSON.stringify(row));
      }
      mkdirSync(dir, { recursive: true });
      for (const [m, lines] of byMonth) appendFileSync(join(dir, `${m}.jsonl`), `${lines.join('\n')}\n`);
      return rows.length;
    },
  };
  if (flushOnExit) process.once('exit', () => { try { log.flush(); } catch { /* exit must not throw */ } });
  return log;
}

/** A log that keeps rows in memory (tests, dry runs). */
export function createMemoryLog() {
  const rows = [];
  return { rows, append: (row) => rows.push(row), flush: () => 0, get pending() { return 0; } };
}

// The default log flushes at a normal exit only: Node fires no 'exit' on SIGINT/SIGTERM, and a
// library must not install signal handlers under its caller. A CLI that runs decisions calls
// flushDecisionLog() in its finally, beside flushLlmSpend.
let DEFAULT_LOG = null;
const defaultLog = () => (DEFAULT_LOG ||= createDecisionLog());
export function flushDecisionLog() { return DEFAULT_LOG ? DEFAULT_LOG.flush() : 0; }

// ---- Jev call ---------------------------------------------------------------------------------------

class DecisionError extends Error {
  constructor(code, message = code) { super(message); this.name = 'DecisionError'; this.code = code; }
}

function missingAnswers(questions, answers = {}) {
  return Object.entries(questions).filter(([id, q]) => {
    const a = answers?.[id];
    if (!a || typeof a !== 'object') return true;
    if (q.type === 'noul') return !Number.isFinite(a.noul);
    if (q.type === 'score') return !Number.isFinite(a.score);
    if (q.type === 'choice') return typeof a.choice !== 'string';
    return false;
  }).map(([id]) => id);
}

/** One deadline-bounded ask. The race holds the deadline even for a client that ignores the signal. */
// The timer is a plain (ref'd) setTimeout, cleared on settle, rather than AbortSignal.timeout: that
// one is unref'd, so a process whose only pending work is a hung call would exit mid-deadline.
async function askWithDeadline(client, request, deadlineMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DecisionError('deadline', `deadline ${deadlineMs}ms`));
      reject(new DecisionError('deadline', `deadline ${deadlineMs}ms`));
    }, deadlineMs);
  });
  const call = Promise.resolve().then(() => client.ask(request, { signal: controller.signal }));
  call.catch(() => {}); // a late rejection after the deadline is not an unhandled rejection
  try { return await Promise.race([call, deadline]); }
  finally { clearTimeout(timer); }
}

const errorCode = (error) => String(error?.code || 'client_error').slice(0, 48);

// ---- Chunked client (one decision, several calls) ---------------------------------------------------

/**
 * Pure. Split a question map into calls of at most `max` questions, keeping each group (groupOf(id))
 * together where it fits and splitting only a group larger than `max`. Returns [[id, …], …] in order.
 */
export function planChunks(questions, { max = 60, groupOf = () => 'all' } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new Error('planChunks: max must be a positive integer');
  const groups = new Map();
  for (const id of Object.keys(questions || {})) {
    const g = groupOf(id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(id);
  }
  const chunks = [];
  let current = [];
  for (const ids of groups.values()) {
    if (current.length + ids.length <= max) { current.push(...ids); continue; }
    if (current.length) chunks.push(current);
    current = [];
    for (let i = 0; i < ids.length; i += max) {
      const slice = ids.slice(i, i + max);
      if (slice.length === max) chunks.push(slice); else current = slice;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const addUsage = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) if (Number.isFinite(v)) out[k] = (Number.isFinite(out[k]) ? out[k] : 0) + v;
  return out;
};

/**
 * Wrap a Jev client so ONE decision's question set goes out as several calls of at most `max`
 * questions each, on the same state, in parallel, and comes back as one result: answers merged, usage
 * summed. decide() still sees one ask, so the deadline, the partial-answer check, the breaker and the
 * log row cover the whole set. Any failed call fails the whole ask (not read, never half a reading),
 * and calls answered by different builds are refused ('mixed_builds'), because a reading is only
 * comparable on one build. Each underlying call is metered by the wrapped client's own ask().
 */
export function chunkedClient(client, { max = 60, groupOf } = {}) {
  return {
    async ask(request, options) {
      const chunks = planChunks(request.questions, { max, groupOf });
      if (chunks.length <= 1) return client.ask(request, options);
      const results = await Promise.all(chunks.map((ids) => client.ask({
        ...request, questions: Object.fromEntries(ids.map((id) => [id, request.questions[id]])),
      }, options)));
      const models = [...new Set(results.map((r) => r?.model ?? null))];
      if (models.length > 1) throw new DecisionError('mixed_builds', `calls answered by ${models.join(', ')}`);
      return {
        model: models[0],
        answers: Object.assign({}, ...results.map((r) => r?.answers || {})),
        usage: results.reduce((sum, r) => addUsage(sum, r?.usage), {}),
        chunks: chunks.map((ids) => ids.length),
      };
    },
  };
}

// ---- decide() ---------------------------------------------------------------------------------------

async function defaultRegistry() {
  const { DECISIONS } = await import('./decisions/index.mjs');
  return DECISIONS;
}
const lookup = (registry, name) => (registry instanceof Map ? registry.get(name) : registry?.[name]);

/**
 * Run one decision. Returns
 * { action, answers, confidence, source, fallback, mode, model, ms, questionSetHash,
 *   configuredMode, proposal, jevAction, incumbentAction, reason, cached, detail }.
 * `detail` is the rest of the policy's verdict (everything but action and confidence) when Jev was read.
 * It is returned to the caller only and never logged.
 * `fallback` is the not-read code when source is 'fallback', else null. `reason` explains a refusal
 * or a downgrade. An unknown decision name or a broken module throws (a programming error, not Jev's),
 * and so does the incumbent: it is the caller's existing path and its failure is never masked.
 * `log` defaults to the batched file log; pass null for none, or createMemoryLog() in tests.
 */
export async function decide(name, input, {
  client = null, registry = null, laws = LAWS, log, now = Date.now, cache = DEFAULT_CACHE, role, subject = null,
} = {}) {
  const decision = lookup(registry ?? await defaultRegistry(), name);
  if (!decision) throw new Error(`decide: no decision named ${name}`);
  validateDecision(decision);
  const cfg = decisionConfig(name, laws);
  const HOLD = decision.HOLD ?? 'hold';
  const started = now();
  const currentHash = decisionHash(decision);

  const incumbent = await decision.incumbent(input);
  const incumbentAction = incumbent?.action ?? null;

  let mode = cfg.mode;
  const reasons = [];
  if (ACTING.has(mode) && !isPinned(cfg.model)) {
    reasons.push(`refused: ${mode} needs a pinned model, got ${cfg.model}`);
    mode = 'shadow';
  }
  if (ABOVE_SHADOW.has(mode) && currentHash !== cfg.questionSetHash) {
    reasons.push(`downgraded: question-set hash ${currentHash.slice(0, 12)} is not the recorded ${String(cfg.questionSetHash).slice(0, 12)}`);
    mode = 'shadow';
  }

  let state = null;
  let inputHash = null;
  try { state = decision.stateOf(input); inputHash = questionSetHash(state); } catch { /* read below as state_error */ }

  const out = {
    action: incumbentAction, answers: null, confidence: null, source: 'incumbent', fallback: null,
    mode, configuredMode: cfg.mode, model: cfg.model, ms: 0, questionSetHash: currentHash,
    proposal: false, jevAction: null, incumbentAction, reason: null, cached: false, detail: null,
  };
  let cost = null;

  if (mode !== 'off') {
    let jevResult = null;
    try {
      if (state == null) throw new DecisionError('state_error');
      if (!client) throw new DecisionError('no_client');
      if (BREAKER.open) throw new DecisionError('breaker_open', BREAKER.reason);
      let questions;
      try { questions = decision.QUESTIONS ?? decision.questions(state, input); }
      catch { throw new DecisionError('questions_error'); }
      const key = cacheKey({ name, model: cfg.model, questionSetHash: questionSetHash(questions), state });
      let hit = cache?.get(key);
      // A cached answer from a build other than the calibrated one is a miss: the provider can move the
      // build behind a pinned id, and serving the old build's answers would hide that drift.
      if (hit && cfg.calibratedBuild && hit.model !== cfg.calibratedBuild) hit = null;
      if (hit) { out.cached = true; cost = 0; }
      else {
        let result;
        try {
          result = await askWithDeadline(client, { state, questions, model: cfg.model, role: role || `decide:${name}` }, cfg.deadlineMs);
        } catch (error) {
          // 401/403/model-400 (swipe-classify), plus 404: the model or route is gone (plan: breaker table).
          const trip = breakerReason(error) || ((error?.status ?? error?.details?.status) === 404 ? 'http_404' : null);
          if (trip && !BREAKER.open) { BREAKER.open = true; BREAKER.reason = `${trip} (${name})`; }
          throw error;
        }
        // Priced before validation: a partial answer set was still billed. (A call that lands after the
        // deadline is billed too and its cost is unknown here; the metered LLM Spend row still has it.)
        cost = Number.isFinite(result?.usage?.cost) ? result.usage.cost : priceUsage(result?.model, result?.usage || {});
        const missing = missingAnswers(questions, result?.answers);
        if (missing.length) throw new DecisionError('partial_answers', `Jev left ${missing.length} question(s) unanswered (${missing.slice(0, 4).join(', ')})`);
        hit = { model: result.model ?? null, answers: result.answers, usage: result.usage ?? null };
        cache?.set(key, hit, { persist: isPinned(cfg.model) });
      }
      let verdict;
      try { verdict = decision.policy(hit.answers, { ...cfg.thresholds }, { input, state }); }
      catch { throw new DecisionError('policy_error'); }
      if (!verdict || !decision.ACTIONS.includes(verdict.action)) throw new DecisionError('policy_action');
      const { action: _a, confidence: _c, ...detail } = verdict;
      jevResult = { ...hit, action: verdict.action, confidence: Number.isFinite(verdict.confidence) ? verdict.confidence : null,
        detail: Object.keys(detail).length ? detail : null };
    } catch (error) {
      out.source = 'fallback';
      out.fallback = `not read: ${errorCode(error)}`;
      // The underlying reason, for a reading's caller (askThrough); never logged.
      out.error = error instanceof DecisionError ? { message: error.message } : { message: String(error?.message || 'error').slice(0, 200), code: error?.details?.code ?? null, status: error?.status ?? error?.details?.status ?? null };
    }

    if (jevResult) {
      out.answers = jevResult.answers;
      out.usage = jevResult.usage ?? null;
      out.model = jevResult.model || cfg.model;
      out.jevAction = jevResult.action;
      out.confidence = jevResult.confidence;
      out.detail = jevResult.detail;
      if (ABOVE_SHADOW.has(mode) && (!cfg.calibratedBuild || !jevResult.model || jevResult.model !== cfg.calibratedBuild)) {
        reasons.push(`downgraded: answering build ${jevResult.model} is not the calibrated ${cfg.calibratedBuild}`);
        mode = 'shadow';
      }
      if (mode === 'propose') {
        out.action = jevResult.action; out.source = 'jev'; out.proposal = true;
      } else if (ACTING.has(mode)) {
        if (jevResult.confidence != null && jevResult.confidence >= cfg.confidenceFloor) { out.action = jevResult.action; out.source = 'jev'; }
        else reasons.push(`below floor: confidence ${jevResult.confidence ?? 'n/a'} < ${cfg.confidenceFloor}`);
      }
      // Monotone safety: in any mode that can act on Jev, a hold from either side stands.
      if (decision.safety && ABOVE_SHADOW.has(mode) && out.action !== HOLD) {
        if (incumbentAction === HOLD) { out.action = HOLD; out.source = 'incumbent'; }
        else if (jevResult.action === HOLD) { out.action = HOLD; out.source = 'jev'; }
      }
    }
  }
  out.mode = mode;
  out.reason = reasons.length ? reasons.join('; ') : null;
  out.ms = Math.max(0, now() - started);

  const sink = log === undefined ? defaultLog() : log;
  // Log size (plan v7 N1: 3.4 KB a read, mostly the pre-score's 60-question digest). The full digest is
  // kept only where it teaches something: Jev and the incumbent disagree, a fallback, or a confidence
  // under the floor. Everywhere else a short hash of it stands in, enough to spot a changed answer.
  const digest = answersDigest(out.answers);
  const keep = out.jevAction !== incumbentAction || out.fallback || (out.confidence != null && out.confidence < cfg.confidenceFloor);
  sink?.append({
    ts: new Date(now()).toISOString(), name, inputHash,
    ...(keep || !out.answers ? { answersDigest: digest } : { answersSha: questionSetHash(digest).slice(0, 16) }),
    incumbent: incumbentAction, jev: out.jevAction, action: out.action, source: out.source, mode: out.mode,
    configuredMode: cfg.mode, model: out.model, ms: out.ms, cost, cached: out.cached,
    fallback: out.fallback, reason: out.reason, questionSetHash: currentHash,
    // The thread / draft / row the read was for (an id, never copy), so jev-report can price a thread.
    ...(subject != null ? { subject: String(subject).slice(0, 80) } : {}),
  });
  return out;
}

/**
 * The one door for a Jev READING (decisions/readings.mjs): the caller keeps building its questions and
 * reading the answers, but the ask runs through decide(), so it is logged, deadlined, breaker-guarded,
 * pinned and hash-locked. Returns { answers, model } like client.ask. A fallback throws, with `status`
 * set to the breaker's HTTP status when the breaker opened, so a caller's own breaker test still fires.
 */
export async function askThrough(name, client, { state, questions }, opts = {}) {
  // No cache and no log by default: a reading is taken once per copy (a shared cache would hand one
  // caller's answers to another asking the same state), and a caller that wants the git-tracked log
  // passes it, as run-jev main() does; otherwise a library or test call would write to learnings/.
  const { READING_REGISTRY } = await import('./decisions/readings.mjs');
  const r = await decide(name, { state, questions }, { client, cache: null, log: null, registry: READING_REGISTRY, ...opts });
  if (r.source === 'fallback' || !r.answers) {
    // The caller sees the underlying error as if it had asked itself: its message, its details.code and
    // its HTTP status, so its own "not read (reason)" lines and breaker test are unchanged.
    const e = new Error(r.error?.message || r.fallback || 'not read');
    e.code = String(r.fallback || 'not read').replace(/^not read: /, '');
    if (r.error?.code) e.details = { code: r.error.code };
    if (Number.isFinite(r.error?.status)) e.status = r.error.status;
    throw e;
  }
  return { answers: r.answers, model: r.model, usage: r.usage ?? null };
}
