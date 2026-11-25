#!/usr/bin/env node
// scripts/jev-eval.mjs — the generic Jev eval harness (plan §4 "Proof"): one decision, one labelled set,
// Jev against the incumbent on the same items.
//
//   node scripts/jev-eval.mjs <decision> [--labels evals/jev/<EVAL.labels or decision>.jsonl] [--limit N] [--batch N]
//        [--concurrency 8] [--max-usd 1] [--json OUT.json] [--md OUT.md] [--dry]
//
// Labels: evals/jev/<decision>.jsonl, one row per item: { id, labels: { field: value }, source, … } plus
// a reference to the copy, never the copy itself: { path, index, sha256 } (a queue spec's tweet, checked
// against its hash; a changed tweet is counted `stale` and skipped). Airtable-backed rows (the donor
// decisions) carry { recId, sha256 } instead; their EVAL.loadItem reads the swipe record READ-ONLY at eval
// time (scripts/donor-labels.mjs) and skips a row whose hash changed (`staleReasons.sha_changed`).
//
// Adapters: every registered decision (decisions/index.mjs) that exports EVAL, run through decide() in
// shadow with no decision log and a private cache, so the eval reads the same state, questions, pinned
// model and policy the runtime would; plus `niche` (swipe-classify NICHE_QUESTIONS), used when
// evals/jev/niche.jsonl exists.
//
// Metrics, per label field: choice → accuracy, per-class precision/recall/F1 and a confusion matrix;
// binary → precision/recall/F1 at the configured threshold, Brier, ECE (ten equal-width bins) and a
// threshold sweep. The incumbent is scored on every field it predicts. Also: a confidence-vs-accuracy
// table, cost (exact on the OpenRouter route) and p50/p95 latency per call. A batch Jev could not read
// is `notRead` and never counts as a pass or a hit.
//
// Spend: live calls are metered in-process (lib.mjs meterLlmCall) and are NOT flushed to Airtable here;
// --max-usd stops dispatching new calls once the metered spend reaches it. --dry uses no client.
// The JSON output is numbers only (ids, counts, rates); no copy reaches it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MAX_USD = 1;
export const ECE_BINS = 10;
export const SWEEP = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
export const CONF_BINS = Object.freeze([0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]);

const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const div = (a, b) => (b ? a / b : null);

// ---- Metric math (pure) -------------------------------------------------------------------------------

export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];
}

/** Binary P/R/F1 over paired booleans; pairs with a null prediction are skipped (not read). */
export function binaryMetrics(labels, preds) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  labels.forEach((y, i) => {
    const p = preds[i];
    if (p == null || y == null) return;
    if (y && p) tp++; else if (!y && p) fp++; else if (y && !p) fn++; else tn++;
  });
  const precision = div(tp, tp + fp), recall = div(tp, tp + fn);
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : (tp + fp + fn ? 0 : null);
  return { n: tp + fp + fn + tn, tp, fp, fn, tn, precision: round(precision), recall: round(recall), f1: round(f1), accuracy: round(div(tp + tn, tp + fp + fn + tn)) };
}

/** Mean squared error of probabilities against 0/1 labels. */
export function brier(labels, probs) {
  const pairs = labels.map((y, i) => [y, probs[i]]).filter(([y, p]) => y != null && Number.isFinite(p));
  if (!pairs.length) return null;
  return round(pairs.reduce((s, [y, p]) => s + (p - (y ? 1 : 0)) ** 2, 0) / pairs.length);
}

/** Expected calibration error over equal-width bins, plus the reliability table it is built from. */
export function calibration(labels, probs, bins = ECE_BINS) {
  const pairs = labels.map((y, i) => [y, probs[i]]).filter(([y, p]) => y != null && Number.isFinite(p));
  const table = Array.from({ length: bins }, (_, b) => ({ lo: round(b / bins, 2), hi: round((b + 1) / bins, 2), n: 0, meanP: 0, rate: 0 }));
  for (const [y, p] of pairs) {
    const b = Math.min(bins - 1, Math.floor(p * bins));
    table[b].n++; table[b].meanP += p; table[b].rate += y ? 1 : 0;
  }
  let ece = 0;
  for (const row of table) {
    if (!row.n) { row.meanP = null; row.rate = null; continue; }
    row.meanP /= row.n; row.rate /= row.n;
    ece += (row.n / pairs.length) * Math.abs(row.meanP - row.rate);
    row.meanP = round(row.meanP); row.rate = round(row.rate);
  }
  return { ece: pairs.length ? round(ece) : null, n: pairs.length, table: table.filter((r) => r.n) };
}

/** P/R/F1 at each threshold; `orWith` (booleans) is OR-ed in when given (the monotone policy). */
export function thresholdSweep(labels, probs, thresholds = SWEEP, { orWith = null } = {}) {
  return thresholds.map((t) => {
    const preds = probs.map((p, i) => (Number.isFinite(p) ? p >= t || Boolean(orWith?.[i]) : null));
    const m = binaryMetrics(labels, preds);
    return { threshold: t, precision: m.precision, recall: m.recall, f1: m.f1, flagged: m.tp + m.fp };
  });
}

/** Multi-class: accuracy, per-class P/R/F1 (one-vs-rest), macro-F1 and the confusion matrix. */
export function choiceMetrics(labels, preds, classes) {
  const pairs = labels.map((y, i) => [y, preds[i]]).filter(([y, p]) => y != null && p != null);
  const confusion = Object.fromEntries(classes.map((c) => [c, Object.fromEntries(classes.map((d) => [d, 0]))]));
  for (const [y, p] of pairs) if (confusion[y] && p in confusion[y]) confusion[y][p]++;
  const perClass = Object.fromEntries(classes.map((c) => {
    const m = binaryMetrics(pairs.map(([y]) => y === c), pairs.map(([, p]) => p === c));
    return [c, { support: m.tp + m.fn, predicted: m.tp + m.fp, precision: m.precision, recall: m.recall, f1: m.f1 }];
  }));
  const f1s = Object.values(perClass).filter((m) => m.support > 0 && m.f1 != null).map((m) => m.f1);
  return {
    n: pairs.length, accuracy: round(div(pairs.filter(([y, p]) => y === p).length, pairs.length)),
    macroF1: round(f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null), perClass, confusion,
  };
}

/** Accuracy per confidence band: is Jev right as often as it says it is? */
export function confidenceTable(confidences, correct, edges = CONF_BINS) {
  const rows = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const idx = confidences.map((c, i) => (Number.isFinite(c) && c >= edges[b] && c < edges[b + 1] && correct[i] != null ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    rows.push({ lo: edges[b], hi: Math.min(1, edges[b + 1]), n: idx.length, meanConfidence: round(idx.reduce((s, i) => s + confidences[i], 0) / idx.length), accuracy: round(idx.filter((i) => correct[i]).length / idx.length) });
  }
  return rows;
}

// ---- Labels and copy -----------------------------------------------------------------------------------

export function readLabels(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** The copy a row references: a queue spec tweet at { path, index }, verified by sha256. null when stale. */
export function loadTweet(row, root = ROOT, cache = new Map()) {
  if (typeof row.text === 'string') return row.text; // an in-memory fixture (tests); never written to a labels file
  if (!row.path || !Number.isInteger(row.index)) return null;
  const file = resolve(root, row.path);
  if (!file.startsWith(`${root}/`)) return null;
  if (!cache.has(file)) {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); cache.set(file, j.spec?.tweets || j.tweets || []); } catch { cache.set(file, null); }
  }
  const t = cache.get(file)?.[row.index];
  if (typeof t !== 'string') return null;
  return row.sha256 && sha(t) !== row.sha256 ? null : t;
}

// ---- Adapters ------------------------------------------------------------------------------------------

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * An adapter for a registered decision with an EVAL export, run through decide() in shadow. Items come
 * from a queue spec tweet ({path, index, sha256}), or from EVAL.loadItem(row, ctx) when the copy lives
 * elsewhere (the donor decisions read the swipe table by recId, READ-ONLY): it returns the item or
 * { skip: reason } (e.g. sha_changed), counted as stale. `itemContext` reaches loadItem (tests pass fakes).
 * EVAL.toInput and EVAL.incumbent may be async.
 */
export async function decisionAdapter(name, { registry = null, laws = null, itemContext = {} } = {}) {
  const { DECISIONS } = registry ? { DECISIONS: registry } : await import('../decisions/index.mjs');
  const decision = DECISIONS[name];
  if (!decision?.EVAL) return null;
  const jd = await import('../jev-decide.mjs');
  const L = laws || (await import('../laws.mjs')).LAWS;
  const cfg = jd.decisionConfig(name, L);
  const E = decision.EVAL;
  return {
    name, labels: E.labels || name, fields: E.fields, batchSize: E.batchSize || 1, model: cfg.model, thresholds: cfg.thresholds, questionSetHash: jd.decisionHash(decision),
    toItem: E.loadItem
      ? (row, root, cache) => E.loadItem(row, { cache, ...itemContext })
      : (row, root, cache) => { const text = loadTweet(row, root, cache); return text == null ? null : { id: row.id, text, plug: row.plug ?? null }; },
    incumbent: async (items) => E.incumbent(await E.toInput(items)),
    async run(items, { client, now = Date.now }) {
      const input = await E.toInput(items);
      // Forced shadow with no log and a private cache: the eval must not write the decision log or reuse answers.
      const shadowLaws = { ...L, jev: { ...L.jev, decisions: { ...L.jev?.decisions, [name]: { ...L.jev?.decisions?.[name], mode: 'shadow' } } } };
      const log = jd.createMemoryLog();
      const started = now();
      const r = await jd.decide(name, input, { client, registry: DECISIONS, laws: shadowLaws, log, now, cache: jd.createDecisionCache(), role: `eval:${name}` });
      const ms = now() - started;
      const cost = log.rows[0]?.cost ?? null;
      if (r.source === 'fallback' || !r.answers) return { ok: false, reason: r.fallback || 'not read', ms, cost, build: r.model };
      return { ok: true, preds: E.predict(r.answers, { ...cfg.thresholds }, input), ms, cost, build: r.model };
    },
  };
}

/** The niche adapter: swipe-classify NICHE_QUESTIONS, one item per call; labels { niche, health }. */
export async function nicheAdapter() {
  const sc = await import('../swipe-classify.mjs');
  const classes = [...sc.MERGED_NICHES];
  return {
    name: 'niche', labels: 'niche', batchSize: 1, model: sc.SWIPE_RULES.model, thresholds: { health: 0.5 }, questionSetHash: sc.questionSetHash(sc.NICHE_QUESTIONS),
    fields: { niche: { type: 'choice', options: classes }, health: { type: 'binary', thresholdKey: 'health' } },
    toItem: (row, root, cache) => {
      if (row.state?.hook) return { id: row.id, state: row.state };
      const text = loadTweet(row, root, cache);
      return text == null ? null : { id: row.id, state: { hook: text.split('\n')[0], tweets: [text.slice(0, sc.MAX_TWEET_CHARS)] } };
    },
    incumbent: null,
    async run(items, { client, now = Date.now }) {
      const started = now();
      try {
        const res = await client.ask({ state: items[0].state, questions: sc.NICHE_QUESTIONS, model: sc.SWIPE_RULES.model, role: 'eval:niche' });
        const n = sc.readNiche(res.answers);
        if (n.primary == null || n.health == null) return { ok: false, reason: 'partial_answers', ms: now() - started, cost: res.usage?.cost ?? null };
        return { ok: true, ms: now() - started, cost: res.usage?.cost ?? null, build: res.model,
          preds: [{ niche: { value: n.primary, confidence: n.primaryConf }, health: { prob: n.health, value: n.health >= 0.5 } }] };
      } catch (error) { return { ok: false, reason: error?.details?.code || 'client_error', ms: now() - started, cost: null }; }
    },
  };
}

export async function adapterFor(name, opts = {}) {
  if (name === 'niche') return nicheAdapter();
  return decisionAdapter(name, opts);
}

// ---- Evaluation ----------------------------------------------------------------------------------------

/**
 * Run the adapter over labelled rows. Returns the numbers-only result. `client` null + dry: incumbent only.
 * `spent()` reads the metered spend so far; dispatch stops once it reaches maxUsd.
 */
export async function evaluate(adapter, rows, { client = null, root = ROOT, limit = null, batch = null, concurrency = 8, maxUsd = DEFAULT_MAX_USD, spent = () => 0, now = Date.now } = {}) {
  const cache = new Map();
  const picked = limit ? rows.slice(0, limit) : rows;
  const items = [];
  let stale = 0;
  const staleReasons = {};
  for (const row of picked) {
    const item = await adapter.toItem(row, root, cache);
    if (!item || item.skip) { stale++; const k = item?.skip || 'stale'; staleReasons[k] = (staleReasons[k] || 0) + 1; continue; }
    // A source may be "file#key" (a pointer into a committed file); it is counted by file.
    items.push({ item, labels: row.labels || {}, source: row.source ? String(row.source).split('#')[0] : null });
  }
  const size = Math.max(1, batch || adapter.batchSize || 1);
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));

  let budgetStopped = 0;
  const calls = client ? await pool(batches, concurrency, async (b) => {
    if (spent() >= maxUsd) { budgetStopped++; return { ok: false, reason: 'budget', ms: null, cost: null, skipped: true }; }
    try { return await adapter.run(b.map((x) => x.item), { client, now }); }
    catch (error) { return { ok: false, reason: error?.code || 'client_error', ms: null, cost: null }; }
  }) : batches.map(() => ({ ok: false, reason: 'dry', skipped: true }));

  // Flatten to per-item predictions.
  const jev = [], inc = [], labels = [];
  for (const [bi, b] of batches.entries()) {
    const c = calls[bi];
    const incPreds = adapter.incumbent ? await adapter.incumbent(b.map((x) => x.item)) : null;
    b.forEach((x, j) => {
      labels.push(x.labels);
      jev.push(c.ok ? c.preds[j] : null);
      inc.push(incPreds ? incPreds[j] : null);
    });
  }

  const fields = {};
  for (const [field, spec] of Object.entries(adapter.fields)) {
    const y = labels.map((l) => (field in l ? l[field] : null));
    const jp = jev.map((p) => p?.[field] ?? null);
    const ip = inc.map((p) => p?.[field] ?? null);
    const hasInc = ip.some((p) => p != null);
    if (spec.type === 'choice') {
      const read = jp.map((p) => p?.value ?? null);
      const correct = read.map((p, i) => (p == null || y[i] == null ? null : p === y[i]));
      fields[field] = {
        type: 'choice', labelled: y.filter((v) => v != null).length,
        jev: choiceMetrics(y, read, spec.options),
        incumbent: hasInc ? choiceMetrics(y, ip.map((p, i) => (jp[i] == null ? null : p?.value ?? null)), spec.options) : null,
        incumbentAll: hasInc ? choiceMetrics(y, ip.map((p) => p?.value ?? null), spec.options) : null,
        confidenceVsAccuracy: confidenceTable(jp.map((p) => p?.confidence ?? null), correct),
      };
    } else {
      const yb = y.map((v) => (v == null ? null : Boolean(v)));
      const probs = jp.map((p) => (Number.isFinite(p?.prob) ? p.prob : null));
      const incVals = ip.map((p) => (p?.value == null ? null : Boolean(p.value)));
      // A `score` field (e.g. the claims battery's hold, the max of its risk signals) ranks items but is
      // not a probability, so it gets a sweep and no Brier or ECE.
      const isProb = !spec.score;
      const cal = isProb ? calibration(yb, probs) : { ece: null, table: [] };
      const out = {
        type: 'binary', labelled: yb.filter((v) => v != null).length, positives: yb.filter(Boolean).length,
        threshold: spec.thresholdKey ? adapter.thresholds?.[spec.thresholdKey] ?? null : null,
        jev: binaryMetrics(yb, jp.map((p) => (p?.value == null ? null : Boolean(p.value)))),
        incumbent: hasInc ? binaryMetrics(yb, incVals.map((v, i) => (jp[i] == null ? null : v))) : null,
        incumbentAll: hasInc ? binaryMetrics(yb, incVals) : null,
        brier: isProb ? brier(yb, probs) : null, ece: cal.ece, reliability: cal.table, scoreNotProbability: !isProb,
        sweep: thresholdSweep(yb, probs),
      };
      if (jp.some((p) => p && 'jevOnly' in p)) {
        out.jevOnly = binaryMetrics(yb, jp.map((p) => (p == null ? null : Boolean(p.jevOnly))));
        out.sweepMonotone = thresholdSweep(yb, probs, SWEEP, { orWith: incVals });
      }
      fields[field] = out;
    }
  }

  const done = calls.filter((c) => !c.skipped);
  const costs = done.map((c) => c.cost).filter(Number.isFinite);
  const usd = costs.reduce((a, b) => a + b, 0);
  const ms = done.map((c) => c.ms).filter(Number.isFinite);
  const readItems = jev.filter(Boolean).length;
  const sources = {};
  for (const x of items) sources[x.source || 'unknown'] = (sources[x.source || 'unknown'] || 0) + 1;
  return {
    schema: 'jev-eval-v1', decision: adapter.name, model: adapter.model, builds: [...new Set(done.map((c) => c.build).filter(Boolean))],
    questionSetHash: adapter.questionSetHash, thresholds: adapter.thresholds,
    n: { rows: picked.length, items: items.length, stale, ...(stale ? { staleReasons } : {}), read: readItems, notRead: items.length - readItems, batches: batches.length, batchSize: size, budgetStopped },
    labelSources: sources,
    notReadReasons: Object.entries(calls.filter((c) => !c.ok).reduce((m, c) => ({ ...m, [c.reason]: (m[c.reason] || 0) + 1 }), {})).map(([reason, calls]) => ({ reason, calls })),
    cost: { usd: round(usd, 6), pricedCalls: costs.length, calls: done.length, per100Items: round(div(usd * 100, readItems), 6), maxUsd },
    latencyMs: { p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? Math.max(...ms) : null },
    fields,
  };
}

// ---- Report -------------------------------------------------------------------------------------------

const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 3) => (x == null ? '–' : Number(x).toFixed(d));

export function renderMarkdown(r, { date = new Date().toISOString().slice(0, 10), labelsPath = '' } = {}) {
  const L = [];
  L.push(`# Jev eval · ${r.decision} · ${date}`, '');
  L.push(`- **Items:** ${r.n.items} (${r.n.read} read, ${r.n.notRead} not read, ${r.n.stale} stale) in ${r.n.batches} calls of up to ${r.n.batchSize}`);
  L.push(`- **Labels:** ${labelsPath} · sources ${Object.entries(r.labelSources).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push(`- **Model:** ${r.model} · answering build ${r.builds.join(', ') || '–'} · question set ${String(r.questionSetHash).slice(0, 12)}`);
  L.push(`- **Cost:** $${num(r.cost.usd, 4)} over ${r.cost.calls} calls ($${num(r.cost.per100Items, 5)} per 100 items) · **latency** p50 ${r.latencyMs.p50 ?? '–'} ms · p95 ${r.latencyMs.p95 ?? '–'} ms`);
  if (r.n.staleReasons) L.push(`- **Stale:** ${Object.entries(r.n.staleReasons).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  if (r.notReadReasons.length) L.push(`- **Not read:** ${r.notReadReasons.map((x) => `${x.reason} ×${x.calls}`).join(', ')}`);
  L.push('');
  for (const [field, f] of Object.entries(r.fields)) {
    L.push(`## ${field}`, '');
    if (f.type === 'choice') {
      L.push(`Accuracy: Jev ${pct(f.jev.accuracy)} · incumbent ${pct(f.incumbent?.accuracy)} · macro-F1 Jev ${num(f.jev.macroF1)} · incumbent ${num(f.incumbent?.macroF1)}`, '');
      L.push('| Class | Support | Jev P | Jev R | Jev F1 | Regex P | Regex R | Regex F1 |', '|:--|--:|--:|--:|--:|--:|--:|--:|');
      for (const [c, m] of Object.entries(f.jev.perClass)) {
        const i = f.incumbent?.perClass?.[c];
        L.push(`| ${c} | ${m.support} | ${pct(m.precision)} | ${pct(m.recall)} | ${num(m.f1)} | ${pct(i?.precision)} | ${pct(i?.recall)} | ${num(i?.f1)} |`);
      }
      L.push('', 'Confusion (rows = label, columns = Jev):', '', `| | ${Object.keys(f.jev.confusion).join(' | ')} |`, `|:--|${Object.keys(f.jev.confusion).map(() => '--:').join('|')}|`);
      for (const [y, row] of Object.entries(f.jev.confusion)) L.push(`| ${y} | ${Object.values(row).join(' | ')} |`);
      L.push('', 'Confidence vs accuracy:', '', '| Confidence | n | Mean conf | Accuracy |', '|:--|--:|--:|--:|');
      for (const b of f.confidenceVsAccuracy) L.push(`| ${b.lo}–${b.hi} | ${b.n} | ${num(b.meanConfidence)} | ${pct(b.accuracy)} |`);
    } else {
      L.push(`Positives ${f.positives} of ${f.labelled} · threshold ${f.threshold ?? 'policy'} · ${f.scoreNotProbability ? 'sweep over a risk score, not a probability (no Brier/ECE)' : `Brier ${num(f.brier)} · ECE ${num(f.ece)}`}`, '');
      L.push('| Reader | P | R | F1 | TP | FP | FN |', '|:--|--:|--:|--:|--:|--:|--:|');
      const row = (label, m) => m && L.push(`| ${label} | ${pct(m.precision)} | ${pct(m.recall)} | ${num(m.f1)} | ${m.tp} | ${m.fp} | ${m.fn} |`);
      row(f.jevOnly ? 'Jev ∨ regex (policy)' : 'Jev', f.jev);
      if (f.jevOnly) row('Jev alone', f.jevOnly);
      row('Regex (same items)', f.incumbent);
      L.push('', 'Threshold sweep (Jev probability):', '', '| t | P | R | F1 | flagged |', '|--:|--:|--:|--:|--:|');
      for (const s of f.sweep) L.push(`| ${s.threshold} | ${pct(s.precision)} | ${pct(s.recall)} | ${num(s.f1)} | ${s.flagged} |`);
      if (f.sweepMonotone) {
        L.push('', 'Threshold sweep, Jev ∨ regex:', '', '| t | P | R | F1 | flagged |', '|--:|--:|--:|--:|--:|');
        for (const s of f.sweepMonotone) L.push(`| ${s.threshold} | ${pct(s.precision)} | ${pct(s.recall)} | ${num(s.f1)} | ${s.flagged} |`);
      }
      if (f.reliability.length) L.push('', 'Reliability:', '', '| Bin | n | Mean p | Positive rate |', '|:--|--:|--:|--:|');
      for (const b of f.reliability) L.push(`| ${b.lo}–${b.hi} | ${b.n} | ${num(b.meanP)} | ${pct(b.rate)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---- CLI ----------------------------------------------------------------------------------------------

async function main(argv) {
  const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const name = argv[0];
  if (!name || name.startsWith('--')) throw new Error('usage: node scripts/jev-eval.mjs <decision> [--labels FILE] [--limit N] [--batch N] [--max-usd 1] [--json OUT] [--md OUT] [--dry]');
  const adapter = await adapterFor(name);
  if (!adapter) throw new Error(`${name}: not a registered decision with an EVAL export, and not niche`);
  const labelsPath = flag('labels', `evals/jev/${adapter.labels}.jsonl`);
  const file = resolve(ROOT, labelsPath);
  if (!existsSync(file)) throw new Error(`no labels file: ${labelsPath}${adapter.labels === 'claims' ? ' (not committed; build it with node scripts/claims-weak-labels.mjs)' : ''}`);
  const dry = argv.includes('--dry');
  let client = null;
  const lib = await import('../lib.mjs');
  if (!dry) { const { jev } = await import('../jev.mjs'); client = jev(lib.loadEnv()); }
  const maxUsd = Number(flag('max-usd', DEFAULT_MAX_USD));
  const result = await evaluate(adapter, readLabels(file), {
    client, limit: flag('limit') ? Number(flag('limit')) : null, batch: flag('batch') ? Number(flag('batch')) : null,
    concurrency: Number(flag('concurrency', 8)), maxUsd, spent: () => lib.llmSpendSummary().costUsd || 0,
  });
  result.labels = { path: labelsPath, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  result.ranAt = new Date().toISOString();
  result.meteredUsd = round(lib.llmSpendSummary().costUsd || 0, 6);
  const date = result.ranAt.slice(0, 10);
  const md = renderMarkdown(result, { date, labelsPath });
  for (const [out, body] of [[flag('json'), `${JSON.stringify(result, null, 1)}\n`], [flag('md'), `${md}\n`]]) {
    if (!out) continue;
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), body);
  }
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
