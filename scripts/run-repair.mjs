#!/usr/bin/env node
// scripts/run-repair.mjs — the bounded repair loop for drafts: rewrite only the tweets Jev and the gates
// point at, prove nothing else moved, and let Jev read the copy again.
//
// Owner, 2026-09-23, approving it: "Firstly, let's work on your three suggestions to really improve the
// efficiency of this workflow. Let's do all 3." On the mock run about 30% of the time went to
// write/review loops where the whole thread was re-read and often re-written for one weak tweet.
//
// The loop (at most laws.json jev.repairLoops per row, then the row goes to the owner as it stands):
//   1. node scripts/run-row.mjs drafts --dry ...        Jev reads; the packet names holds and reviews
//   2. node scripts/run-repair.mjs plan  --run-dir RUN --input SPEC --plan PLAN.json
//        -> RUN/repairs/loop-N/<row>.md, one brief per row: the tweets to rewrite and why, the sources
//           to record, and what only the owner can settle. Uncertain readings are shown, never targets.
//   3. the writer (a subagent: it only writes) answers each brief with
//        { "id": "<row>", "tweets": { "5": "new text" }, "sources": [{ "tweet": 4, "source": "..." }] }
//   4. node scripts/run-repair.mjs apply --run-dir RUN --input SPEC --answers ANSWERS.json --output NEW
//        -> refuses any change outside the targets, a lost or moved link token, and a harvest edit
//           that changes the hook or reaches farm.harvestEditMax; writes the repaired spec.
//   5. back to 1 on NEW. Jev decides again; nobody marks a repair as passed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneOf } from '../lanes.mjs';
import { harvestEdit } from './run-content-packets.mjs';
import { copyDigest } from './run-jev.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAWS = JSON.parse(readFileSync(join(ROOT, 'laws.json'), 'utf8'));
export const REPAIR_LOOPS = LAWS.jev?.repairLoops ?? 2;
const HARVEST_EDIT_MAX = LAWS.farm?.harvestEditMax ?? 0;
const text = (v) => String(v ?? '').trim();
const tweetNums = (s) => [...String(s).matchAll(/\bT(\d{1,2})\b/g)].map((m) => Number(m[1]));
const LINK_TOKEN = /\{\{LINK\d*\}\}|https?:\/\/\S+/g;

export const FIVE_QUESTIONS = [
  'Does every numbered step do something? (A step that only introduces a product is not a step.)',
  'Does each beat follow the previous thought and add useful understanding or a next decision?',
  'Do the point and bridge earn the first buying criterion and recommendation with specific, supported reasoning?',
  'After CTA 1, does a substantive numbered point end with a brief relevant substance hint and lead directly to the existing light plug, without another bridge tweet?',
  'Would a reader who never buys still feel they got the whole protocol?',
];

/**
 * PURE. What a repair can fix on one row, from its Jev reading and its packet verdict.
 *   rewrite:  [{ tweet, why[] }]  tweets the writer rewrites: what decided the row (Jev hold/review
 *                                 pointers, gate findings that name a tweet)
 *   sources:  [tweet]             statistics to record in draft.sources (none since 2026-09-28: see asWritten)
 *   owner:    [reason]            findings no tweet rewrite can settle (safety, promise, a harvest hook)
 *   uncertain:[note]              Jev's uncertain-band readings and report-only flags: context, never targets
 *   asWritten:[tweet]             numbers or studies with no named source: they ship as written, counted
 */
export function repairTargets({ planRow = {}, reading = null, specRow = {} } = {}) {
  const rewrite = new Map(), sources = new Set(), owner = [], uncertain = [], asWritten = new Set();
  const add = (n, why) => { if (!(n >= 1)) return; const r = rewrite.get(n) || { tweet: n, why: [] }; if (!r.why.includes(why)) r.why.push(why); rewrite.set(n, r); };
  for (const p of reading?.prescore?.pointers || []) {
    const n = Number(String(p.tweet || '').replace(/^T/, ''));
    if (p.level === 'uncertain') { uncertain.push(p.note); continue; }
    if (p.kind === 'craft' && n) add(n, p.note);
    else owner.push(p.note);
  }
  // The report-only flags (plug lead-in, unsourced claim, weakest seam) did not decide the row, so they
  // are context, never targets: rewriting what the gate accepted churns the copy and its voice (owner,
  // 2026-09-23: "Add where it's needed and support the writing, not overused"). Safety-type flags are
  // the owner's.
  for (const f of reading?.flags || []) {
    if (['plug', 'claim', 'seam'].includes(f.kind)) uncertain.push(f.note);
    else owner.push(f.note);
  }
  for (const issue of [...(planRow.holds || []), ...(planRow.reviews || [])]) {
    if (/^Jev editorial (decision|hold after)/.test(issue)) continue; // its pointers are read above, with levels
    // SHIP AS WRITTEN (owner, 2026-09-28, on a number or study with no named source): no repair and no
    // source note. The row ships, and the run's receipt counts it.
    if (/Statistic or study without a named source/.test(issue)) { tweetNums(issue).forEach((n) => asWritten.add(n)); continue; }
    // MATCH THE NUMBER TO WHAT'S DELIVERED (owner, 2026-09-28, on a hook that promises more items than the
    // body holds): T1's count changes to the body's; no item is added or cut to fit the hook.
    const count = issue.match(/hook promises (\d+)\b.*?\bbut the body numbers (\d+) item/);
    if (count) { add(1, `Match the number to what's delivered: the body numbers ${count[2]} items, so T1 promises ${count[2]}, not ${count[1]}. Change only the count; never add or cut an item to fit the hook`); continue; }
    if (/^Harvest edit: .*confirm the edit/.test(issue)) { owner.push(issue); continue; }
    const nums = tweetNums(issue);
    if (nums.length) nums.forEach((n) => add(n, issue)); else owner.push(issue);
  }
  // A harvest keeps its hook: T1 is never the writer's to change there.
  if (laneOf(specRow.lane) === 'harvest' && rewrite.has(1)) { owner.push(`T1 of a harvest: ${rewrite.get(1).why.join('; ')}`); rewrite.delete(1); }
  const rows = [...rewrite.values()].sort((a, b) => a.tweet - b.tweet);
  return { rewrite: rows, sources: [...sources].sort((a, b) => a - b), owner: [...new Set(owner)], uncertain: [...new Set(uncertain)], asWritten: [...asWritten].sort((a, b) => a - b) };
}

/** PURE. What the row needs next: 'clean', 'repair' (a writer pass), 'owner' (nothing to rewrite, or
 *  the loop cap is spent). `loops` is how many repairs this row has had. */
export function nextStep(planRow, targets, loops = 0, cap = REPAIR_LOOPS) {
  if (planRow?.status === 'submit-ready' && !targets.rewrite.length && !targets.sources.length) return 'clean';
  if (!targets.rewrite.length && !targets.sources.length) return 'owner';
  return loops >= cap ? 'owner' : 'repair';
}

/** PURE. The writer's brief for one row: the whole thread for context, the tweets to rewrite and why,
 *  the rules that bind the rewrite, and the exact answer shape. */
export function repairBrief(specRow, targets, { loop = 1, cap = REPAIR_LOOPS } = {}) {
  const tweets = specRow.draft?.tweets || [];
  const lane = laneOf(specRow.lane);
  const want = new Set(targets.rewrite.map((r) => r.tweet));
  return [
    `# Repair ${specRow.id} · loop ${loop} of ${cap} · ${lane}`,
    '',
    'Rewrite ONLY the tweets listed under "Rewrite". Every other tweet stays byte-identical. Keep each',
    'link token ({{LINK}}, {{LINK2}}, or a URL) in the same tweet it is in now. Keep the numbering.',
    lane === 'harvest' ? `This is a harvest: the hook stays, and the whole body may change by less than ${+(HARVEST_EDIT_MAX * 100).toFixed(1)}% of its words. Change as few words as the fix needs.` : '',
    'Jev reads the result again; it decides, you only write. Answer the five questions for each tweet you change before you return it.',
    '',
    '## Rewrite',
    ...(targets.rewrite.length ? targets.rewrite.flatMap((r) => [`- **T${r.tweet}**`, ...r.why.map((w) => `  - ${w}`)]) : ['- none']),
    '',
    ...(targets.sources.length ? ['## Record a source (draft.sources; the copy needs no citation)', ...targets.sources.map((n) => `- T${n}: name the study or page the number rests on`), '- Never invent a source. If you cannot name a real one, leave that tweet out of "sources"; the owner decides.', ''] : []),
    ...(targets.uncertain.length ? ['## Jev was unsure, or only noticed (context; change these only where a listed rewrite touches them)', ...targets.uncertain.map((u) => `- ${u}`), ''] : []),
    ...(targets.owner.length ? ['## Not yours to fix (the owner decides)', ...targets.owner.map((o) => `- ${o}`), ''] : []),
    '## The five questions',
    ...FIVE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
    '',
    '## The thread',
    ...tweets.flatMap((t, i) => [`### T${i + 1}${want.has(i + 1) ? ' ← rewrite' : ''}`, String(t), '']),
    '## Answer (JSON only)',
    '```json',
    JSON.stringify({ id: specRow.id, tweets: Object.fromEntries(targets.rewrite.map((r) => [String(r.tweet), '<new text>'])), sources: targets.sources.map((n) => ({ tweet: n, source: '<study or page>' })) }, null, 1),
    '```',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

const tokensOf = (t) => (String(t).match(LINK_TOKEN) || []).sort();

/**
 * PURE. Apply one writer answer to its spec row. Refuses (issues, row unchanged) when the answer
 * touches a tweet outside the targets, empties a tweet, drops or moves a link token, adds a source for
 * a tweet not asked for, or, on a harvest, changes the hook or reaches the edit bar.
 */
export function applyRepair(specRow, answer, targets, { loop = 1 } = {}) {
  const issues = [];
  const allowed = new Set(targets.rewrite.map((r) => r.tweet));
  const allowedSources = new Set([...targets.sources, ...targets.rewrite.map((r) => r.tweet)]);
  const before = specRow.draft?.tweets || [];
  const after = [...before];
  for (const [key, value] of Object.entries(answer?.tweets || {})) {
    const n = Number(key);
    if (!allowed.has(n)) { issues.push(`T${key} was not a repair target`); continue; }
    if (!text(value) || /<new text>/.test(value)) { issues.push(`T${n} is empty`); continue; }
    if (JSON.stringify(tokensOf(before[n - 1])) !== JSON.stringify(tokensOf(value))) issues.push(`T${n} changed its links (${tokensOf(before[n - 1]).length} before, ${tokensOf(value).length} after)`);
    after[n - 1] = String(value).trim();
  }
  const added = [];
  for (const s of answer?.sources || []) {
    if (!allowedSources.has(Number(s?.tweet))) { issues.push(`a source for T${s?.tweet} was not asked for`); continue; }
    if (!text(s.source) || /<study or page>/.test(s.source)) { issues.push(`the source for T${s.tweet} is empty`); continue; }
    added.push({ tweet: Number(s.tweet), source: text(s.source) });
  }
  if (laneOf(specRow.lane) === 'harvest' && Array.isArray(specRow.source?.tweets) && specRow.source.variation !== true) {
    const edit = harvestEdit(specRow.source.tweets, after);
    if (!edit.hookSame) issues.push('the harvest hook changed');
    if (edit.share >= HARVEST_EDIT_MAX) issues.push(`the harvest now differs from its source by ${(edit.share * 100).toFixed(1)}% of words (the bar is ${+(HARVEST_EDIT_MAX * 100).toFixed(1)}%)`);
  }
  if (issues.length) return { row: specRow, issues, changed: [] };
  const changed = after.map((t, i) => (t !== before[i] ? i + 1 : null)).filter(Boolean);
  const keep = (specRow.draft?.sources || []).filter((s) => !added.some((a) => a.tweet === Number(s.tweet)));
  const draft = { ...specRow.draft, tweets: after, ...(added.length || specRow.draft?.sources ? { sources: [...keep, ...added].sort((a, b) => a.tweet - b.tweet) } : {}) };
  const repairs = [...(specRow.repairs || []), { loop, tweets: changed, sources: added.map((a) => a.tweet) }];
  return { row: { ...specRow, draft, repairs }, issues, changed };
}

// ---- CLI ------------------------------------------------------------------------------------------

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const loopsOf = (row) => (row.repairs || []).length;

function readingsById(runDir) {
  const f = join(runDir, 'jev', 'drafts.json');
  if (!existsSync(f)) return new Map();
  const j = readJson(f);
  return new Map((j.rows || []).map((r) => [r.id, r]));
}

function planCmd({ runDir, input, plan }) {
  const spec = readJson(input), packet = readJson(plan), readings = readingsById(runDir);
  const byId = new Map((packet.rows || []).map((r) => [r.id, r]));
  const loop = 1 + Math.max(0, ...spec.rows.map(loopsOf));
  const dir = join(runDir, 'repairs', `loop-${loop}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = [];
  for (const row of spec.rows) {
    const planRow = byId.get(row.id);
    if (!planRow) { out.push({ id: row.id, step: 'owner', note: 'not in the drafts plan' }); continue; }
    const reading = readings.get(row.id);
    const bound = reading && reading.copySha256 === copyDigest(row.draft?.tweets || []) ? reading : null; // a stale reading names the wrong tweets
    const targets = repairTargets({ planRow, reading: bound, specRow: row });
    const step = nextStep(planRow, targets, loopsOf(row));
    const entry = { id: row.id, step, status: planRow.status, rewrite: targets.rewrite.map((r) => r.tweet), sources: targets.sources, owner: targets.owner,
      ...(targets.asWritten.length ? { asWritten: targets.asWritten } : {}) };
    if (step === 'repair') {
      entry.brief = join(dir, `${row.id}.md`);
      writeFileSync(entry.brief, repairBrief(row, targets, { loop: loopsOf(row) + 1 }), { mode: 0o600 });
      writeFileSync(join(dir, `${row.id}.targets.json`), JSON.stringify(targets, null, 1), { mode: 0o600 });
    }
    out.push(entry);
  }
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ loop, rows: out }, null, 1), { mode: 0o600 });
  console.log(`repair plan · loop ${loop} · ${dir}`);
  for (const e of out) {
    const what = e.step === 'repair' ? `rewrite ${e.rewrite.map((n) => `T${n}`).join(' ') || '-'}${e.sources.length ? ` · sources ${e.sources.map((n) => `T${n}`).join(' ')}` : ''}`
      : e.step === 'owner' ? (e.owner?.[0] || e.note || `loop cap (${REPAIR_LOOPS}) reached`).slice(0, 110) : '';
    console.log(`  ${String(e.id).padEnd(16)} ${e.step.padEnd(7)} ${what}`);
  }
  const asWritten = out.filter((e) => e.asWritten?.length);
  if (asWritten.length) console.log(`  ${asWritten.length} row(s) carry a number or study with no named source: they ship as written (owner, 2026-09-28); count them in the receipt`);
  return out;
}

function applyCmd({ runDir, input, answers, output }) {
  const spec = readJson(input);
  const given = [readJson(answers)].flat();
  const plan = readJson(join(runDir, 'repairs', `loop-${1 + Math.max(0, ...spec.rows.map(loopsOf))}`, 'plan.json'));
  let refused = 0;
  const rows = spec.rows.map((row) => {
    const answer = given.find((a) => a?.id === row.id);
    if (!answer) return row;
    const entry = plan.rows.find((e) => e.id === row.id);
    if (entry?.step !== 'repair') { console.log(`  ✗ ${row.id}: no repair was asked for`); refused++; return row; }
    const targets = readJson(join(runDir, 'repairs', `loop-${plan.loop}`, `${row.id}.targets.json`));
    const { row: next, issues, changed } = applyRepair(row, answer, targets, { loop: plan.loop });
    if (issues.length) { console.log(`  ✗ ${row.id}: ${issues.join('; ')}`); refused++; return row; }
    console.log(`  ✓ ${row.id}: rewrote ${changed.map((n) => `T${n}`).join(' ') || 'nothing'}${next.draft.sources?.length ? ` · ${next.draft.sources.length} source(s)` : ''}`);
    return next;
  });
  writeFileSync(output, JSON.stringify({ ...spec, rows }, null, 1), { mode: 0o600 });
  console.log(`  wrote ${output}: now run \`node scripts/run-row.mjs drafts --dry --run-dir RUN --input ${output}\` so Jev reads it again`);
  if (refused) process.exitCode = 1;
}

function main(argv) {
  const [cmd] = argv;
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const runDir = flag('run-dir') && resolve(flag('run-dir'));
  if (!runDir || !flag('input') || !['plan', 'apply'].includes(cmd) || (cmd === 'plan' && !flag('plan')) || (cmd === 'apply' && (!flag('answers') || !flag('output')))) {
    throw new Error('Usage: run-repair.mjs plan --run-dir RUN --input SPEC --plan PLAN.json | apply --run-dir RUN --input SPEC --answers ANSWERS.json --output NEW_SPEC');
  }
  if (runDir === ROOT || runDir.startsWith(`${ROOT}/`)) throw new Error('RUN_DIR must be outside the repository: briefs quote unpublished copy');
  if (cmd === 'plan') return planCmd({ runDir, input: resolve(flag('input')), plan: resolve(flag('plan')) });
  const output = resolve(flag('output'));
  if (output.startsWith(`${ROOT}/`)) throw new Error('--output must be outside the repository: the spec quotes unpublished copy');
  return applyCmd({ runDir, input: resolve(flag('input')), answers: resolve(flag('answers')), output });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
