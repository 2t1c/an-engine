#!/usr/bin/env node
// scripts/jev-cases.mjs — every time the owner overrules Jev, a test case (owner, 2026-09-25: "Yes let's
// build #1", after the recursive self-improvement read: "turn failing traces into versioned scenarios";
// "Weekly proposer --> once a week in the /run").
//
// Cases are DERIVED, never hand-kept: from files already in the repo, the same input always gives the
// same cases, so nothing new is written and no workflow needs write access. Sources:
//   learnings/run-verdicts.jsonl   the owner's approve/hold per row, with what Jev had decided (jevAtVerdict)
//   learnings/owner-edits.jsonl    a draft the owner edited in Typefully after review (changed tweet numbers)
//   learnings/jev-decisions/*      Jev's product picks (plug-fill, plug-replacement) ...
//   ledger.jsonl                   ... and the owner's later product swaps
//   facts.jsonl                    views after publish: under 100k is a flop (flop research's bar)
// A case holds ids, hashes, tweet numbers and labels — never copy. Its `copy` pointer names the published
// thread record (queues/threads/*.json) and the sha256 of its tweets, so a later replay (the weekly
// proposer's gate) reads the exact text and refuses a record that changed since.
//
// A case is a FAILURE when Jev and the owner disagree: Jev passed a draft the owner held or edited, Jev
// held one the owner approved, a Jev product pick the owner swapped within 14 days, or a Jev-passed draft
// the owner approved that then flopped. The weekly proposer (inside /run, once a week) works only on a
// decision with PROPOSER.minCases cases, so a change is replayed against enough history to mean something.
//
//   node scripts/jev-cases.mjs [--since YYYY-MM-DD] [--json]     the per-decision table (jev-weekly prints it)
//   node scripts/jev-cases.mjs --brief                           the /run weekly read: failures + readiness
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productLabels } from './jev-labels.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PROPOSER = { minCases: 30, flopViews: 100_000, minAgeDays: 7, swapDays: 14 };

const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// ---- the published thread records (pure over their parsed contents) --------------------------------------

/**
 * PURE. Index of published thread records: by draftId, and by `${batch}|${MMDD}|${accountKey}` (a run row
 * id is `<lane>-<MMDD>-<accountKey>`). Each entry: { path, sha256 (of the tweets JSON), draftId }.
 */
export function threadIndex(records) {
  const byDraft = new Map(), byRow = new Map();
  for (const { path, doc } of records) {
    const s = doc?.spec || {};
    const tweets = s.tweets || doc?.tweets;
    if (!Array.isArray(tweets) || !tweets.length) continue;
    const draftId = String(doc?.thread?.draftId || s.reviewDraftId || '');
    const e = { path, sha256: sha(JSON.stringify(tweets)), draftId: draftId || null };
    if (draftId) byDraft.set(draftId, e);
    if (s.batch && s.day && s.key) byRow.set(`${s.batch}|${String(s.day).slice(5, 7)}${String(s.day).slice(8, 10)}|${s.key}`, e);
  }
  return { byDraft, byRow };
}

/**
 * PURE. The tweet numbers an owner edit touched. run-review-drafts compares only positions the live copy
 * still has, so a deletion alone leaves changedTweets empty; a tweet-count change marks every position
 * from the first missing or added tweet.
 */
export function editedTweets(e) {
  const changed = Array.isArray(e?.changedTweets) ? [...e.changedTweets] : [];
  const live = Number(e?.liveTweets), proposed = Number(e?.proposedTweets);
  if (Number.isFinite(live) && Number.isFinite(proposed) && live !== proposed) {
    for (let n = Math.min(live, proposed) + 1; n <= Math.max(live, proposed); n++) if (!changed.includes(n)) changed.push(n);
  }
  return changed.sort((a, b) => a - b);
}

/** PURE. The thread record for a run row id (cov-0924-rafael) in run R2026-09-23, or null. */
export function threadForRow(index, run, rowId) {
  const m = String(rowId || '').match(/^[a-z]+-(\d{4})-(.+)$/);
  return m ? index.byRow.get(`${run}|${m[1]}|${m[2]}`) || null : null;
}

// ---- the cases (pure) ----------------------------------------------------------------------------------

/**
 * PURE. Views outcome for a PUBLISHED draft: { views, flop } once it is 7+ days old, else null. A draft
 * that never went out (Draft/Scheduled, no X link) has no outcome: its 0 views are not a flop.
 */
export function outcomeOf(facts, draftId, now) {
  const f = draftId ? facts.get(String(draftId)) : null;
  if (!f || !Number.isFinite(Number(f.views)) || !f.postedAt) return null;
  if (!['Posted', 'Reposted'].includes(f.status) && !f.xUrl) return null;
  if ((now - Date.parse(f.postedAt)) / 864e5 < PROPOSER.minAgeDays) return null;
  return { views: Number(f.views), flop: Number(f.views) < PROPOSER.flopViews };
}

/**
 * PURE. All cases. Inputs are parsed rows; `index` from threadIndex; `facts` a Map draftId -> facts row.
 * Returns [{ id, decision, at, source, jev, owner, failure, why, copy, outcome }].
 */
export function buildCases({ verdicts = [], edits = [], decisions = [], ledger = [], index = { byDraft: new Map(), byRow: new Map() }, facts = new Map(), now = Date.now() }) {
  const out = [];
  const editsByRow = new Map(edits.map((e) => [`${e.runId}|${e.rowId}`, e]));
  const seen = new Set();
  // Owner verdicts on rows Jev had read. The latest verdict per row wins (a hold then an approve after a fix
  // is an approve of the fixed copy; the hold stays its own case when the copy hash differs).
  for (const v of verdicts) {
    if (!['selection', 'drafts'].includes(v.stage) || !v.rowId || !v.jev?.action || v.jev.action === 'not read') continue;
    const decision = v.stage === 'drafts' ? 'editorial-prescore' : 'selection-read';
    const owner = v.verdict === 'approve' || v.verdict === 'inherit' ? 'approve' : v.verdict === 'hold' ? 'hold' : null;
    if (!owner) continue;
    const id = `verdict:${v.run}:${v.stage}:${v.rowId}:${v.jev.copy || ''}`;
    if (seen.has(id)) { const i = out.findIndex((c) => c.id === id); out.splice(i, 1); }
    seen.add(id);
    const thread = threadForRow(index, v.run, v.rowId);
    const edit = v.stage === 'drafts' ? editsByRow.get(`${v.run}|${v.rowId}`) : null;
    const jevPass = ['pass', 'clean'].includes(v.jev.action), jevStop = ['hold', 'flagged'].includes(v.jev.action);
    const outcome = v.stage === 'drafts' ? outcomeOf(facts, thread?.draftId, now) : null;
    let why = null;
    if (jevPass && owner === 'hold') why = 'Jev passed, the owner held';
    else if (jevStop && owner === 'approve') why = 'Jev held, the owner approved';
    else if (jevPass && edit && editedTweets(edit).length) why = `Jev passed, the owner edited tweet(s) ${editedTweets(edit).join(', ')}`;
    else if (jevPass && owner === 'approve' && outcome?.flop) why = `Jev passed, the owner approved, it flopped (${Math.round(outcome.views / 1000)}k views)`;
    out.push({
      id, decision, at: v.at, source: 'run-verdicts', jev: { action: v.jev.action, copy: v.jev.copy || null },
      owner: { verdict: owner, editedTweets: edit ? editedTweets(edit) : [] }, failure: Boolean(why), why,
      copy: thread ? { path: thread.path, sha256: thread.sha256 } : null, outcome,
    });
  }
  // Owner edits with no drafts verdict on file still teach the editorial pre-score where it missed.
  for (const e of edits) {
    if (out.some((c) => c.decision === 'editorial-prescore' && c.id.includes(`:drafts:${e.rowId}:`) && c.id.startsWith(`verdict:${e.runId}:`))) continue;
    if (!editedTweets(e).length) continue;
    const thread = index.byDraft.get(String(e.draftId)) || threadForRow(index, e.runId, e.rowId);
    out.push({
      id: `edit:${e.runId}:${e.rowId}:${e.liveSha256?.slice(0, 16) || ''}`, decision: 'editorial-prescore', at: e.at, source: 'owner-edits',
      jev: null, owner: { verdict: 'edited', editedTweets: editedTweets(e) }, failure: false, why: null,
      copy: thread ? { path: thread.path, sha256: thread.sha256 } : null, outcome: outcomeOf(facts, e.draftId, now),
    });
  }
  // Jev's product picks against the owner's later swaps (jev-labels productLabels' rule, per pick).
  for (const d of decisions) {
    if (!['plug-fill', 'plug-replacement'].includes(d.name) || d.source !== 'jev' || !String(d.subject || '').startsWith('draft:')) continue;
    if (!['fill', 'replace'].includes(d.action)) continue;
    const draftId = String(d.subject).slice(6);
    const one = productLabels([d], ledger, { days: PROPOSER.swapDays, now })[d.name];
    const state = one.overturned ? 'overturned' : one.stood ? 'stood' : 'open';
    if (state === 'open') continue;
    const thread = index.byDraft.get(draftId);
    out.push({
      id: `pick:${d.name}:${draftId}:${d.inputHash?.slice(0, 16) || d.ts}`, decision: d.name, at: d.ts, source: 'decision-log+ledger',
      jev: { action: d.action }, owner: { verdict: state }, failure: state === 'overturned', why: state === 'overturned' ? `Jev picked the product, the owner swapped it within ${PROPOSER.swapDays} days` : null,
      copy: thread ? { path: thread.path, sha256: thread.sha256 } : null, outcome: outcomeOf(facts, draftId, now),
    });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** PURE. Per decision: cases, failures, agreement, replayable (copy found), and readiness for the proposer. */
export function summarize(cases, { since = null } = {}) {
  const by = {};
  for (const c of cases) {
    const s = (by[c.decision] ||= { cases: 0, failures: 0, newFailures: 0, replayable: 0, flops: 0, ready: false });
    s.cases++;
    if (c.failure) { s.failures++; if (!since || String(c.at).slice(0, 10) >= since) s.newFailures++; }
    if (c.copy) s.replayable++;
    if (c.outcome?.flop) s.flops++;
  }
  for (const s of Object.values(by)) s.ready = s.replayable >= PROPOSER.minCases;
  return by;
}

export function renderTable(by, { since = null } = {}) {
  const L = ['## Owner overrides as test cases', '',
    `A failure is a case where the owner overruled Jev. The weekly proposer (in /run) works on a decision once it has ${PROPOSER.minCases}+ replayable cases.`, ''];
  const rows = Object.entries(by);
  if (!rows.length) return [...L, 'No cases yet: the next runs\' verdicts, Typefully edits and product swaps create them.', ''].join('\n');
  L.push(`| Decision | Cases | Failures | New${since ? ` since ${since}` : ''} | Replayable | Flopped | Proposer |`, '|:--|--:|--:|--:|--:|--:|:--|');
  for (const [n, s] of rows) L.push(`| ${n} | ${s.cases} | ${s.failures} | ${s.newFailures} | ${s.replayable} | ${s.flops} | ${s.ready ? 'ready' : `${PROPOSER.minCases - s.replayable} more`} |`);
  return [...L, ''].join('\n');
}

/** PURE. The /run weekly read: one line per decision with failures, the latest reasons, and readiness. */
export function renderBrief(cases, by, { max = 3 } = {}) {
  const lines = ['Jev vs your calls (weekly, in /run):'];
  const names = Object.keys(by).filter((n) => by[n].failures);
  if (!names.length) return `${lines[0]} no overrides on file yet${Object.keys(by).length ? ` (${Object.values(by).reduce((a, s) => a + s.cases, 0)} cases, all agreeing)` : ''}.`;
  for (const n of names) {
    const s = by[n];
    const recent = cases.filter((c) => c.decision === n && c.failure).slice(-max).map((c) => c.why);
    lines.push(`- ${n}: ${s.failures} of ${s.cases} overruled · proposer ${s.ready ? 'READY: propose one fix per cause, replay every case' : `waits for ${PROPOSER.minCases - s.replayable} more replayable case(s)`}`);
    for (const w of recent) lines.push(`    · ${w}`);
  }
  return lines.join('\n');
}

// ---- I/O --------------------------------------------------------------------------------------------------

export function loadInputs(root = ROOT) {
  const records = [];
  const dir = join(root, 'queues', 'threads');
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { records.push({ path: `queues/threads/${f}`, doc: JSON.parse(readFileSync(join(dir, f), 'utf8')) }); } catch { /* a torn record is skipped */ }
  }
  const facts = new Map(readJsonl(join(root, 'facts.jsonl')).filter((f) => f.draftId).map((f) => [String(f.draftId), f]));
  return {
    verdicts: readJsonl(join(root, 'learnings', 'run-verdicts.jsonl')),
    edits: readJsonl(join(root, 'learnings', 'owner-edits.jsonl')),
    ledger: readJsonl(join(root, 'ledger.jsonl')),
    index: threadIndex(records), facts,
  };
}

async function main() {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const since = arg('since');
  const { readRows } = await import('../jev-report.mjs');
  const { DECISION_LOG_DIR } = await import('../jev-decide.mjs');
  const inputs = loadInputs();
  const cases = buildCases({ ...inputs, decisions: readRows(DECISION_LOG_DIR, {}).rows });
  const by = summarize(cases, { since });
  if (process.argv.includes('--json')) console.log(JSON.stringify({ summary: by, cases }, null, 1));
  else if (process.argv.includes('--brief')) console.log(renderBrief(cases, by));
  else console.log(renderTable(by, { since }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
