#!/usr/bin/env node
// scripts/backstamp.mjs — back-stamp shipped threads with Jev labels (plan Track G, Phase 5 "Learning
// loops"). SHADOW and report-only: it never rewrites a ledger row (revenue joins on them), it appends
// stamp rows to learnings/stamps/<field>.jsonl, and those rows are read only through stamps.mjs. No
// existing reader (learn, topic-intent, cta-learn, mold-promote) switches to them here.
//
//   node scripts/backstamp.mjs [--field topic|cta-recipe|all]            # --dry (default): the plan, no network
//   node scripts/backstamp.mjs --write [--field …] [--limit N] [--batch 25] [--workers 8] [--max-usd 0.9]
//   node scripts/backstamp.mjs --report [--out file.md]                  # the shadow comparison, no network
//   --cache <file.jsonl> (with --write): keep Jev's typed answers (hashes and nouls, no copy) in a file
//   cache, so a rerun under the same hash reads them back instead of paying again.
//
// Source: queues/threads/*.json with spec.tweets whose draftId is on the ledger (shipped), latest
// version per draft. Decisions: decisions/topic-stamp.mjs and decisions/cta-recipe-stamp.mjs, run
// through jev-decide.mjs decide() at their laws.json mode (shadow), pinned model jev-1.13.
//
// Rows: {ts, key, field, value, p, model, questionSetHash} — ids, labels, confidence and model only;
// never copy. Keys are the ledger join keys (stamps.mjs). Resumable: a key already stamped under the
// current question-set hash is skipped, so a rerun only asks what is missing (a failed read writes no
// row and is asked again). Batched: each batch's rows are appended in one write after the batch.
// A Jev failure writes nothing for that key: unknown is never stamped as a value.
//
// Spend is metered by jev.mjs; the run's exact cost (usage.cost) is printed. `--max-usd` stops before
// the next batch once reached. `--no-spend-row` skips the LLM Spend row in Airtable (flushLlmSpend).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { breakerState, createDecisionCache, createMemoryLog, decide, decisionConfig, decisionHash } from '../jev-decide.mjs';
import { LAWS } from '../laws.mjs';
import { DECISIONS } from '../decisions/index.mjs';
import * as topicStamp from '../decisions/topic-stamp.mjs';
import * as ctaStamp from '../decisions/cta-recipe-stamp.mjs';
import { STAMPS_DIR, STAMP_FIELDS, currentStamps, isUsableStamp, readStamps, readerValue, stampFile, stampFloor } from '../stamps.mjs';
import { readLedgerRows } from '../state/ledger-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const THREADS_DIR = join(ROOT, 'queues', 'threads');
export const FIELDS = Object.freeze(['topic', 'cta-recipe']);
export const DEFAULTS = Object.freeze({ batch: 25, workers: 8, maxUsd: 0.9 });
const AFFILIATE = /https:\/\/lvnta\.com\/lv_[A-Za-z0-9]+/g;

// ---- Sources (pure over inputs) -----------------------------------------------------------------------

/**
 * Shipped threads with text: latest version per draftId, draftId on the ledger. Copy stays in memory.
 * "On the ledger" means minted (a link row exists), not confirmed published: the registry's Posted
 * status is not read here, so a minted-then-deleted draft is stamped too. Its stamp is keyed on the
 * draft and read only through stamps.mjs; report denominators include such drafts.
 */
export function shippedThreads(records, ledgerRows) {
  const onLedger = new Set(ledgerRows.filter((e) => e?.draftId).map((e) => String(e.draftId)));
  const latest = new Map();
  for (const { file, doc } of records) {
    const draftId = doc?.thread?.draftId != null ? String(doc.thread.draftId) : null;
    const tweets = doc?.spec?.tweets || doc?.tweets;
    if (!draftId || !onLedger.has(draftId) || !Array.isArray(tweets) || !tweets.some((t) => String(t || '').trim())) continue;
    const version = Number(doc.thread.version) || 0;
    const prev = latest.get(draftId);
    if (!prev || version > prev.version || (version === prev.version && file > prev.file)) {
      latest.set(draftId, { draftId, file, version, tweets: tweets.map(String), products: doc.spec?.products || doc.products || [] });
    }
  }
  return [...latest.values()].sort((a, b) => a.draftId.localeCompare(b.draftId));
}

export function readThreadRecords(dir = THREADS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => {
    try { return { file, doc: JSON.parse(readFileSync(join(dir, file), 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
}

export function topicItems(threads) {
  return threads.map((t) => ({ key: t.draftId, input: { draftId: t.draftId, tweets: t.tweets } }));
}

/**
 * Plug tweets as cta-learn sees them: tweets carrying an affiliate link, heavy for the first, light for
 * the rest; one per role (cta-learn keeps the first of a draft+role). The ASIN comes from the thread's
 * products by link. Returns { items, skipped: { reason: count } }.
 */
export function ctaItems(threads) {
  const items = [];
  const skipped = {};
  const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  for (const t of threads) {
    const plugs = t.tweets.map((text, i) => ({ text, i, links: [...new Set(String(text).match(AFFILIATE) || [])] })).filter((p) => p.links.length);
    const seen = new Set();
    plugs.forEach((p, rank) => {
      const role = rank === 0 ? 'heavy' : 'light';
      if (seen.has(role)) { skip('extra_light_plug'); return; }
      // cta-learn skips a multi-link plug before recording it, so the role stays open for the next plug.
      if (p.links.length !== 1) { skip('multiple_links'); return; }
      seen.add(role);
      const product = t.products.find((x) => x.link === p.links[0]);
      if (!product?.asin) { skip('link_not_in_products'); return; }
      if (!ctaStamp.recipesForAsin(product.asin).length) { skip('no_library_for_asin'); return; }
      if (!ctaStamp.recipesFor(product.asin, role).length) { skip('no_library_for_role'); return; }
      items.push({ key: `${t.draftId}:${role}`, input: { draftId: t.draftId, asin: product.asin, role, text: p.text } });
    });
  }
  return { items, skipped };
}

/** Items not yet stamped under this question-set hash. */
export function pendingItems(items, existingRows, qsHash) {
  const done = new Set(existingRows.filter((r) => r?.questionSetHash === qsHash).map((r) => String(r.key)));
  return items.filter((it) => !done.has(String(it.key)));
}

// ---- Stamp rows (ids, labels, confidence, model; never copy) ------------------------------------------

const round = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/** decide() result -> stamp rows for a field, or [] when Jev was not read. */
export function stampRows(field, key, out, { ts, thresholds = {} } = {}) {
  if (!out || out.source === 'fallback' || out.jevAction == null) return [];
  const base = { ts, key: String(key), model: out.model ?? null, questionSetHash: out.questionSetHash };
  const row = (f, value, p) => ({ ts: base.ts, key: base.key, field: f, value, p: round(p), model: base.model, questionSetHash: base.questionSetHash });
  if (field === 'topic') {
    const v = topicStamp.policy(out.answers, thresholds);
    const nouls = topicStamp.TOPIC_KEYS.map((k) => out.answers[`also_${k}`]?.noul).filter(Number.isFinite);
    const inSet = v.multi.map((k) => out.answers[`also_${k}`].noul);
    // topic-multi p: the weakest member's noul, or for an empty set how clearly nothing cleared the bar.
    const multiP = inSet.length ? Math.min(...inSet) : 1 - Math.max(0, ...nouls);
    return [row('topic', out.jevAction, out.confidence), row('topic-multi', v.multi, multiP)];
  }
  if (field === 'cta-recipe') return [row('cta-recipe', out.jevAction, out.confidence)];
  throw new Error(`backstamp: unknown field ${field}`);
}

export function appendStampRows(rows, dir = STAMPS_DIR) {
  const byField = new Map();
  for (const r of rows) {
    if (!STAMP_FIELDS[r.field]) throw new Error(`backstamp: unknown field ${r.field}`);
    if (!byField.has(r.field)) byField.set(r.field, []);
    byField.get(r.field).push(JSON.stringify(r));
  }
  if (byField.size) mkdirSync(dir, { recursive: true });
  for (const [field, lines] of byField) appendFileSync(stampFile(field, dir), `${lines.join('\n')}\n`);
  return rows.length;
}

const DECISION_OF = { topic: 'topic-stamp', 'cta-recipe': 'cta-recipe-stamp' };

/**
 * Ask Jev for every pending item of one field, in batches, and append each batch's rows (write) or keep
 * them (dry). Stops before the next batch when spend reaches maxUsd or the breaker opens.
 */
export async function runField({
  field, items, client, write = false, dir = STAMPS_DIR, batch = DEFAULTS.batch, workers = DEFAULTS.workers,
  maxUsd = DEFAULTS.maxUsd, spentUsd = 0, now = Date.now, laws = LAWS, registry = DECISIONS, cache, onBatch = () => {},
}) {
  const decisionName = DECISION_OF[field];
  const thresholds = decisionConfig(decisionName, laws).thresholds;
  const log = createMemoryLog();
  const summary = { field, asked: 0, stamped: 0, fallback: 0, fallbackCodes: {}, costUsd: 0, stoppedFor: null, rows: [] };
  for (let start = 0; start < items.length; start += batch) {
    if (spentUsd + summary.costUsd >= maxUsd) { summary.stoppedFor = `budget $${maxUsd}`; break; }
    const slice = items.slice(start, start + batch);
    const results = new Array(slice.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(workers, slice.length) }, async () => {
      while (next < slice.length) {
        const i = next++;
        results[i] = await decide(decisionName, slice[i].input, { client, registry, laws, log, now, ...(cache ? { cache } : {}) });
      }
    }));
    const rows = [];
    slice.forEach((it, i) => {
      const out = results[i];
      summary.asked++;
      const itemRows = out.source === 'fallback' ? [] : stampRows(field, it.key, out, { ts: new Date(now()).toISOString(), thresholds });
      if (!itemRows.length) {
        // Not read: a fallback, or a mode that did not call Jev. Nothing is stamped for this key.
        const code = out.fallback || `not read: mode ${out.mode}`;
        summary.fallback++;
        summary.fallbackCodes[code] = (summary.fallbackCodes[code] || 0) + 1;
        return;
      }
      rows.push(...itemRows);
      summary.stamped++;
    });
    const breaker = breakerState().open;
    summary.costUsd = log.rows.reduce((s, r) => s + (Number.isFinite(r.cost) ? r.cost : 0), 0);
    if (write) appendStampRows(rows, dir);
    else summary.rows.push(...rows);
    onBatch({ field, done: Math.min(start + batch, items.length), total: items.length, costUsd: summary.costUsd });
    if (breaker) { summary.stoppedFor = 'breaker'; break; }
    // A first batch with nothing read is a contract or credential problem, not bad luck: stop spending.
    if (start === 0 && !rows.length && slice.length) { summary.stoppedFor = 'first batch: nothing read'; break; }
  }
  return summary;
}

// ---- Plan (no network) --------------------------------------------------------------------------------

export function buildPlan({ threads, dir = STAMPS_DIR, fields = FIELDS }) {
  const plan = {};
  for (const field of fields) {
    const decision = DECISIONS[DECISION_OF[field]];
    const qs = decisionHash(decision);
    const { items, skipped } = field === 'topic' ? { items: topicItems(threads), skipped: {} } : ctaItems(threads);
    const pending = pendingItems(items, readStamps(field, { dir }), qs);
    plan[field] = { items, pending, skipped, questionSetHash: qs };
  }
  return plan;
}

// ---- Report (no network) ------------------------------------------------------------------------------

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const count = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const sortedEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/**
 * The shadow comparison. `ctaPerf` is learnings/cta-performance.json (cta-learn's last output) or null.
 * Returns { markdown, numbers }.
 */
export function buildReport({ threads, ledgerRows, dir = STAMPS_DIR, ctaPerf = null, spendUsd = null, laws = LAWS }) {
  const lines = [];
  const numbers = {};
  const topicFloor = stampFloor('topic', laws);
  const ctaFloor = stampFloor('cta-recipe', laws);
  const namedRoute = decisionConfig('topic-stamp', laws).thresholds.namedRoute;

  // Topic
  const topicLatest = currentStamps('topic', { dir, laws });
  const multiLatest = currentStamps('topic-multi', { dir, laws });
  const ledgerTopic = new Map();
  for (const e of ledgerRows) if (e?.draftId && e.topic) ledgerTopic.set(String(e.draftId), e.topic);
  const byId = new Map(threads.map((t) => [t.draftId, t]));
  const rows = [...topicLatest.values()].filter((s) => byId.has(String(s.key))).map((s) => {
    const t = byId.get(String(s.key));
    return { key: String(s.key), jev: s.value, jevReader: readerValue('topic', s.value), p: s.p, regex: topicStamp.incumbent({ tweets: t.tweets }).action,
      // learn.mjs classifies the hook alone (no body fallback); that is where its 'general' comes from.
      hookRegex: topicStamp.incumbent({ tweets: t.tweets.slice(0, 1) }).action,
      ledger: ledgerTopic.get(String(s.key)) ?? null, multi: multiLatest.get(String(s.key))?.value || [] };
  });
  const agree = rows.filter((r) => r.jevReader === r.regex).length;
  const confident = rows.filter((r) => r.p >= topicFloor);
  const agreeConf = confident.filter((r) => r.jevReader === r.regex).length;
  const withLedger = rows.filter((r) => r.ledger);
  const agreeLedger = withLedger.filter((r) => r.jevReader === r.ledger).length;
  const regexNamed = rows.filter((r) => r.regex !== 'general');
  const agreeNamed = regexNamed.filter((r) => r.jevReader === r.regex).length;
  const regexGeneral = rows.filter((r) => r.regex === 'general');
  const hookAgree = rows.filter((r) => r.jevReader === r.hookRegex).length;
  const hookNamed = rows.filter((r) => r.hookRegex !== 'general');
  const hookNamedAgree = hookNamed.filter((r) => r.jevReader === r.hookRegex).length;
  const hookGeneral = rows.filter((r) => r.hookRegex === 'general');
  const ledgerGeneral = rows.filter((r) => r.ledger === 'general');
  const jevGeneralish = rows.filter((r) => !topicStamp.TOPIC_KEYS.includes(r.jev));
  numbers.topic = { stamped: rows.length, agree, agreeConf, confident: confident.length, hookAgree, hookNamedAgree, hookNamed: hookNamed.length, agreeLedger, withLedger: withLedger.length, regexGeneral: regexGeneral.length, hookGeneral: hookGeneral.length, ledgerGeneral: ledgerGeneral.length, jevGeneral: jevGeneralish.length };

  lines.push('## Topic: Jev vs the classifyTopic regex', '');
  lines.push('Agreement reads Jev\'s general_health and not_health as \'general\', the label the regex and the ledger use.', '');
  lines.push('| Measure | Count | Share |', '|:--|--:|--:|');
  lines.push(`| Threads stamped | ${rows.length} | |`);
  lines.push(`| Jev = regex (hook, then body) | ${agree} | ${pct(agree, rows.length)} |`);
  lines.push(`| … where the regex named a topic | ${agreeNamed} / ${regexNamed.length} | ${pct(agreeNamed, regexNamed.length)} |`);
  lines.push(`| … Jev stamps at p ≥ ${topicFloor} (resolver floor) | ${agreeConf} / ${confident.length} | ${pct(agreeConf, confident.length)} |`);
  lines.push(`| Jev = regex on the hook alone (learn.mjs's reading) | ${hookAgree} | ${pct(hookAgree, rows.length)} |`);
  lines.push(`| … where that hook regex named a topic | ${hookNamedAgree} / ${hookNamed.length} | ${pct(hookNamedAgree, hookNamed.length)} |`);
  lines.push(`| Jev = ledger topic (where the ledger has one) | ${agreeLedger} / ${withLedger.length} | ${pct(agreeLedger, withLedger.length)} |`);
  lines.push(`| Stamps at p ≥ ${topicFloor} | ${confident.length} | ${pct(confident.length, rows.length)} |`, '');
  const pairs = sortedEntries(count(rows.filter((r) => r.jevReader !== r.regex), (r) => `${r.regex} → ${r.jev}`)).slice(0, 10);
  lines.push('Top disagreements (regex → Jev):', '', '| Regex → Jev | Threads |', '|:--|--:|', ...pairs.map(([k, v]) => `| ${k} | ${v} |`), '');

  lines.push('## How \'general\' splits', '');
  lines.push('| Reading | \'general\' | Share |', '|:--|--:|--:|');
  lines.push(`| Regex, hook then body (classifyTopic today) | ${regexGeneral.length} | ${pct(regexGeneral.length, rows.length)} |`);
  lines.push(`| Regex, hook alone (learn.mjs) | ${hookGeneral.length} | ${pct(hookGeneral.length, rows.length)} |`);
  lines.push(`| Ledger topic stamp | ${ledgerGeneral.length} | ${pct(ledgerGeneral.length, withLedger.length)} of ${withLedger.length} |`);
  lines.push(`| **Jev, after the split** (general_health + not_health) | **${jevGeneralish.length}** | ${pct(jevGeneralish.length, rows.length)} |`, '');
  for (const [label, set] of [['hook-alone regex', hookGeneral], ['ledger', ledgerGeneral], ['hook-then-body regex', regexGeneral]]) {
    if (!set.length) continue;
    lines.push(`Where the ${label}'s ${set.length} general threads go under Jev:`, '', '| Jev label | Threads |', '|:--|--:|');
    lines.push(...sortedEntries(count(set, (r) => r.jev)).map(([k, v]) => `| ${k} | ${v} |`), '');
  }
  // Jev's own general split: a general_health primary routed to a named topic by its also_ noul.
  const multiSize = count(rows, (r) => Math.min(r.multi.length, 3));
  lines.push(`Jev general labels: ${sortedEntries(count(jevGeneralish, (r) => r.jev)).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}.`);
  lines.push(`Multi-topic set (nouls ≥ ${namedRoute}): ${[0, 1, 2, 3].map((n) => `${n === 3 ? '3+' : n} topics ${multiSize[n] || 0}`).join(' · ')}.`, '');
  const routedFromGeneral = rows.filter((r) => topicStamp.TOPIC_KEYS.includes(r.jev) && r.regex === 'general');
  numbers.generalSplit = { regexGeneral: regexGeneral.length, hookGeneral: hookGeneral.length, hookGeneralToNamed: hookGeneral.filter((r) => topicStamp.TOPIC_KEYS.includes(r.jev)).length, ledgerGeneral: ledgerGeneral.length, toNamed: routedFromGeneral.length, generalHealth: rows.filter((r) => r.jev === 'general_health').length, notHealth: rows.filter((r) => r.jev === 'not_health').length };

  // CTA recipe
  const ctaLatest = currentStamps('cta-recipe', { dir, laws });
  const { items: plugItems, skipped } = ctaItems(threads);
  const lib = new Map(ctaStamp.libraryRecipes().map((r) => [r.id, r]));
  const plugRows = plugItems.filter((it) => ctaLatest.has(it.key)).map((it) => {
    const s = ctaLatest.get(it.key);
    return { key: it.key, role: it.input.role, jev: s.value, p: s.p, exact: ctaStamp.incumbent(it.input).action };
  });
  const mappedAny = plugRows.filter((r) => r.jev !== ctaStamp.NONE && r.p >= ctaFloor);
  const mapped = mappedAny.filter((r) => isUsableStamp('cta-recipe', r.key, r.jev));
  const exact = plugRows.filter((r) => r.exact !== ctaStamp.NONE);
  const exactAgree = exact.filter((r) => r.jev === r.exact).length;
  const roleMismatch = mappedAny.length - mapped.length;
  lines.push('## CTA recipe: plugs mapped onto the library', '');
  lines.push('| Measure | Count |', '|:--|--:|');
  lines.push(`| Plug tweets stamped (ASIN has library recipes) | ${plugRows.length} |`);
  for (const [k, v] of sortedEntries(skipped)) lines.push(`| Not asked: ${k} | ${v} |`);
  lines.push(`| Exact library text (cta-learn already matches) | ${exact.length} |`);
  lines.push(`| … Jev picks the same recipe | ${exactAgree} / ${exact.length} |`);
  lines.push(`| Jev maps to a library recipe of the plug's role at p ≥ ${ctaFloor} (usable) | ${mapped.length} (${pct(mapped.length, plugRows.length)}) |`);
  lines.push(`| … plus mappings onto the other role (the resolver ignores them) | ${roleMismatch} |`);
  lines.push(`| Jev 'none' or below ${ctaFloor} | ${plugRows.length - mappedAny.length} |`, '');
  numbers.cta = { stamped: plugRows.length, mapped: mapped.length, exact: exact.length, exactAgree, roleMismatch };

  if (ctaPerf?.candidates) {
    const nil = ctaPerf.candidates.filter((c) => (c.reasons || []).includes('recipe_not_in_library'));
    const libPods = new Set([...lib.values()].map((r) => r.podId));
    const status = nil.map((c) => {
      const keys = [...new Set((c.examples || []).map((e) => `${e.draftId}:${c.role}`))];
      const stamps = keys.map((k) => ctaLatest.get(k)).filter(Boolean);
      if (!stamps.length) return { c, s: libPods.has(c.podId) ? 'no_stamp_not_in_queue' : 'no_stamp_pod_has_no_library' };
      const hit = stamps.filter((s) => s.value !== ctaStamp.NONE && s.p >= ctaFloor && isUsableStamp('cta-recipe', s.key, s.value)).sort((a, b) => b.p - a.p)[0];
      if (!hit) return { c, s: 'none_or_low' };
      const r = lib.get(hit.value);
      return { c, s: r.podId === c.podId ? 'mapped_same_pod_role' : 'mapped_other_pod_or_role' };
    });
    const by = count(status, (x) => x.s);
    const mappedN = (by.mapped_same_pod_role || 0) + (by.mapped_other_pod_or_role || 0);
    const noStamp = (by.no_stamp_not_in_queue || 0) + (by.no_stamp_pod_has_no_library || 0);
    numbers.notInLibrary = { total: nil.length, mapped: mappedN, samePodRole: by.mapped_same_pod_role || 0, noStamp, noLibrary: by.no_stamp_pod_has_no_library || 0, noneOrLow: by.none_or_low || 0, generatedAt: ctaPerf.generatedAt };
    lines.push(`## The ${nil.length} recipe_not_in_library candidates (cta-performance.json, ${ctaPerf.generatedAt})`, '');
    lines.push('Joined on draftId + role through each candidate\'s examples (up to five drafts per candidate).', '');
    lines.push('| Candidate status | Count |', '|:--|--:|');
    lines.push(`| **Now maps to a library recipe of its role at p ≥ ${ctaFloor}** | **${mappedN}** |`);
    lines.push(`| … onto the candidate's own pod (same pod and role) | ${by.mapped_same_pod_role || 0} |`);
    lines.push(`| … another pod on the same ASIN | ${by.mapped_other_pod_or_role || 0} |`);
    lines.push(`| Stamped: Jev says 'none', below ${ctaFloor}, or maps to the other role | ${by.none_or_low || 0} |`);
    lines.push(`| No stamp: the candidate's pod has no skeleton recipes (cannot map) | ${by.no_stamp_pod_has_no_library || 0} |`);
    lines.push(`| No stamp: its drafts are not shipped threads in queues/threads | ${by.no_stamp_not_in_queue || 0} |`, '');
  } else {
    lines.push('learnings/cta-performance.json not present: the recipe_not_in_library join is **unverified**.', '');
  }
  if (spendUsd != null) lines.push(`Spend on this run: $${spendUsd.toFixed(4)} (usage.cost, exact).`, '');
  return { markdown: lines.join('\n'), numbers };
}

// ---- CLI ----------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const val = (name) => { const i = argv.indexOf(`--${name}`); return i > -1 ? argv[i + 1] : undefined; };
  const write = argv.includes('--write');
  const report = argv.includes('--report');
  if (write && argv.includes('--dry')) throw new Error('--dry and --write are exclusive');
  if (report && (write || argv.includes('--dry'))) throw new Error('--report runs alone: stamp first, then report');
  const fieldArg = val('field') || 'all';
  const fields = fieldArg === 'all' ? [...FIELDS] : fieldArg.split(',');
  for (const f of fields) if (!FIELDS.includes(f)) throw new Error(`--field takes ${FIELDS.join('|')}|all`);
  const num = (name, d) => { const v = val(name); if (v == null) return d; const n = Number(v); if (!(n > 0)) throw new Error(`--${name} must be positive`); return n; };
  return { mode: report ? 'report' : write ? 'write' : 'dry', fields, limit: val('limit') ? num('limit') : null, batch: num('batch', DEFAULTS.batch), workers: num('workers', DEFAULTS.workers), maxUsd: num('max-usd', DEFAULTS.maxUsd), out: val('out') || null, cache: val('cache') || null, spendRow: !argv.includes('--no-spend-row') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerRows = readLedgerRows(join(ROOT, 'ledger.jsonl'));
  const threads = shippedThreads(readThreadRecords(), ledgerRows);
  if (args.mode === 'report') {
    const perfFile = join(ROOT, 'learnings', 'cta-performance.json');
    const ctaPerf = existsSync(perfFile) ? JSON.parse(readFileSync(perfFile, 'utf8')) : null;
    const { markdown } = buildReport({ threads, ledgerRows, ctaPerf });
    if (args.out) writeFileSync(args.out, `${markdown}\n`);
    console.log(markdown);
    return;
  }
  const plan = buildPlan({ threads, fields: args.fields });
  console.log(`shipped threads with text: ${threads.length}`);
  for (const [field, p] of Object.entries(plan)) {
    console.log(`${field}: ${p.items.length} item(s), ${p.pending.length} pending, qs ${p.questionSetHash.slice(0, 12)}${Object.keys(p.skipped).length ? ` · not asked: ${JSON.stringify(p.skipped)}` : ''}`);
  }
  if (args.mode === 'dry') { console.log('(dry: no Jev calls, nothing written; --write to stamp)'); return; }

  const { loadEnv, flushLlmSpend } = await import('../lib.mjs');
  const { jev } = await import('../jev.mjs');
  const env = loadEnv();
  const client = jev({ ...env, TYPESAFE_DEFAULT_MODEL: LAWS.jev.model });
  const cache = args.cache ? createDecisionCache({ file: resolve(args.cache) }) : null;
  let spent = 0;
  try {
    for (const [field, p] of Object.entries(plan)) {
      const items = args.limit ? p.pending.slice(0, args.limit) : p.pending;
      const s = await runField({ field, items, client, write: true, batch: args.batch, workers: args.workers, maxUsd: args.maxUsd, spentUsd: spent,
        ...(cache ? { cache } : {}),
        onBatch: (b) => console.log(`  ${b.field} ${b.done}/${b.total} · $${(spent + b.costUsd).toFixed(4)}`) });
      spent += s.costUsd;
      console.log(`${field}: asked ${s.asked}, stamped ${s.stamped}, not read ${s.fallback}${s.fallback ? ` ${JSON.stringify(s.fallbackCodes)}` : ''}${s.stoppedFor ? ` · STOPPED: ${s.stoppedFor}` : ''}`);
      if (s.stoppedFor) { process.exitCode = 2; break; }
    }
  } finally {
    console.log(`spend: $${spent.toFixed(4)} (usage.cost)`);
    if (args.spendRow) await flushLlmSpend(env, 'backstamp');
    else console.log('LLM Spend row not written (--no-spend-row)');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
