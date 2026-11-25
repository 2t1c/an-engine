#!/usr/bin/env node
// scripts/hook-pick.mjs — five hooks, Jev picks (plan W3; owner, 2026-09-23: "implement: 2,3,4, 6 first").
//
// One writer call drafts N cover hooks from the donor's hook (the 90% hook-variant rule). Then:
//   code   keeps a candidate only when the hook gate passes it (hooks-check.mjs checkHook: coverFloor to
//          gateMax similarity, the same measurement as publish-thread), it has no dash, fits one tweet,
//          and, given the thread body, still promises the count the body numbers (hookPromiseIssue)
//   Jev    reads each survivor against the donor hook (decisions/hook-candidate.mjs): H1 fidelity can
//          drop it (a changed promise, an added claim, an ad), H2 strength ranks the rest
//   code   picks the strongest kept candidate; a tie goes to the similarity nearest the target band's
//          middle. With Jev unread or off, the pick is the code's: in band, nearest the middle.
//
// Jev never writes a hook and never loosens the gate: every candidate it can pick already passed it.
//
//   node scripts/hook-pick.mjs --in FILE [--n 5] [--candidates FILE] [--json]
//     --in          JSON { donorHook, tweets? } — tweets is our thread (tweet 1 is the current hook)
//     --candidates  JSON array of hooks to judge instead of calling the writer
//
// Prints to stdout only; hooks are unpublished copy, so FILE lives in RUN_DIR, outside the repository.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAWS } from '../laws.mjs';
import { HERE_DIR } from '../lib.mjs';
import { scoreHook, critiqueBrief, HOOK_QUESTIONS } from '../hook-fingerprint.mjs';

// Reverse-engineer virality (scripts/virality.mjs, owner 2026-09-24): what spreads on our pages in the
// last 30 days. Every candidate is scored against it; the score RANKS only when the fingerprint passed
// its backtest (fp.pass), otherwise it is printed as the critique and guides the writer's word choice.
export const FINGERPRINT_FILE = join(HERE_DIR, 'learnings', 'hook-fingerprint.json');
export function loadFingerprint(file = FINGERPRINT_FILE) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** PURE. The writer's word-choice guidance from the fingerprint: what lifts and what drags, in words. */
export function viralityGuidance(fp, { lifts = 8, drags = 6 } = {}) {
  if (!fp?.model?.weights) return '';
  const ranked = Object.entries(fp.model.weights).filter(([k]) => !/^(open|shape):/.test(k)).sort((a, b) => b[1] - a[1]);
  const say = (k) => fp.labels?.[k] || k;
  const up = ranked.filter(([, w]) => w > 0).slice(0, lifts).map(([k]) => say(k));
  const down = ranked.filter(([, w]) => w < 0).reverse().slice(0, drags).map(([k]) => say(k));
  return [`What spreads on our pages in the last ${fp.window?.days ?? 30} days (reverse-engineered from our own reach; use it only where you are already changing a word, never to change the claim):`,
    `  lifts: ${up.join('; ')}`, `  drags: ${down.join('; ')}`].join('\n');
}

export const HOOK_PICK_N = 5;
export const HOOK_PICK_ROUNDS = 3; // at most three writer calls (about $0.003 each)

export const WRITER_SYSTEM = [
  'You write X (Twitter) thread hooks for a supplement-education page. You get the donor hook: a first tweet that already earned millions of views.',
  'Write variations that keep about 85-90% of its words. Change one or two elements per variation: a number\'s framing (same fact), a word for a near-synonym of equal weight, the subject noun\'s angle, a clause order. Changing only punctuation, line breaks or one small word is too close: it reads as a copy of the donor\'s post.',
  'Never change the claim, the numbers, the promised count, the person (you/I) or the emotional register. Never add a claim, a cure or a product. No dashes of any kind.',
  'Each variation is one tweet of at most 280 characters, and each is different from the others.',
  'Reply with a JSON array of strings and nothing else.',
].join('\n');

const DASH = /[‒-―−]/;
const mid = () => (LAWS.hook.targetMin + LAWS.hook.targetMax) / 2;

/** PURE. The candidate hooks from the writer's reply: a JSON array, or one per numbered line. */
export function parseHooks(reply) {
  const s = String(reply ?? '').trim();
  const arr = s.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const v = JSON.parse(arr[0]);
      if (Array.isArray(v)) return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
    } catch { /* fall through to lines */ }
  }
  return [...new Set(s.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean))];
}

/**
 * PURE (given checkHook and hookPromiseIssue). The code's filter on one candidate: { ok, sim, why }.
 * `tweets` is our thread; its tweet 1 is replaced by the candidate for the promise check.
 */
export function codeCheck(hook, donorHook, { tweets = [], checkHook, hookPromiseIssue }) {
  const why = [];
  const c = checkHook(hook, donorHook);
  if (!c.ok) why.push(c.issue || `similarity ${c.sim} outside the gate`);
  if (DASH.test(hook)) why.push('has a dash');
  if (hook.length > 280) why.push(`${hook.length} characters`);
  if (tweets.length > 1) {
    const p = hookPromiseIssue([hook, ...tweets.slice(1)]);
    if (p) why.push(p);
  }
  return { ok: !why.length, sim: c.sim, why };
}

/**
 * PURE. The pick. `rows`: [{ hook, sim, code: { ok }, jev: { status, action, strength } }].
 * Jev-kept rows rank by strength, then nearness to the target band's middle; code-passed rows rank by
 * nearness alone when no candidate was read. Returns { chosen, by, ranked }.
 */
export function rank(rows, { fp = null } = {}) {
  const near = (r) => Math.abs((r.sim ?? 0) - mid());
  // The virality score ranks first only when its backtest passed; otherwise it is shown, never used.
  const viral = (r) => (fp?.pass && Number.isFinite(r.viral?.score) ? r.viral.score : 0);
  const legal = rows.filter((r) => r.code.ok);
  const read = legal.filter((r) => r.jev?.status === 'read');
  if (read.length && read.length === legal.length) {
    const kept = read.filter((r) => r.jev.action === 'keep')
      .sort((a, b) => viral(b) - viral(a) || (b.jev.strength ?? 0) - (a.jev.strength ?? 0) || near(a) - near(b));
    return { chosen: kept[0] || null, by: kept.length ? (fp?.pass ? 'virality + jev' : 'jev') : 'none', ranked: kept };
  }
  // Some candidate went unread: Jev's ranking is partial, so the code picks, and a Jev drop still removes one.
  const ranked = legal.filter((r) => !(r.jev?.status === 'read' && r.jev.action === 'drop')).sort((a, b) => viral(b) - viral(a) || near(a) - near(b));
  return { chosen: ranked[0] || null, by: ranked.length ? 'code' : 'none', ranked };
}

/** Reads every code-legal candidate through decide('hook-candidate'). A failed read is `not read`. */
export async function judge(rows, donorHook, { client, laws = LAWS, log = null, cache, registry = null } = {}) {
  const { decide, decisionConfig } = await import('../jev-decide.mjs');
  const reg = registry || (await import('../decisions/index.mjs')).DECISIONS;
  return Promise.all(rows.map(async (r) => {
    if (!r.code.ok) return { ...r, jev: { status: 'skipped' } };
    try {
      const d = await decide('hook-candidate', { donorHook, hook: r.hook, sim: r.sim }, { client, registry: reg, laws, log, ...(cache ? { cache } : {}) });
      if (d.mode === 'off') return { ...r, jev: { status: 'off' } };
      if (d.source === 'fallback' || !d.answers) return { ...r, jev: { status: 'not read', reason: d.fallback || 'not read' } };
      const v = reg['hook-candidate'].policy(d.answers, decisionConfig('hook-candidate', laws).thresholds);
      return { ...r, jev: { status: 'read', mode: d.mode, ...v } };
    } catch (error) { return { ...r, jev: { status: 'not read', reason: String(error?.message || 'error').slice(0, 160) } }; }
  }));
}

/** The whole step: candidates (written or given) → code filter → Jev → pick. */
export async function pickHook({ donorHook, tweets = [], candidates = null, n = HOOK_PICK_N, env = null, client = null, log = null, cache, write = null, fp = loadFingerprint() } = {}) {
  const { checkHook } = await import('../hooks-check.mjs');
  const system = [WRITER_SYSTEM, viralityGuidance(fp)].filter(Boolean).join('\n\n');
  const { hookPromiseIssue } = await import('../checks.mjs');
  let hooks = candidates;
  if (!hooks) {
    const writer = write || (async () => {
      const { anthropic } = await import('../lib.mjs');
      // Jev picks the model (laws.json modelRouting 'hook-writer'); a draft with fewer than two hooks
      // inside the gate is written once more one tier up before the feedback rounds start.
      return anthropic(env, { role: 'hook-writer', max_tokens: 1500, system,
        messages: [{ role: 'user', content: `Donor hook:\n${donorHook}\n\nWrite ${n} variations.` }],
        validate: (reply) => parseHooks(reply).filter((h) => codeCheck(h, donorHook, { tweets, checkHook, hookPromiseIssue }).ok).length >= 2 });
    });
    hooks = parseHooks(await writer()).slice(0, n);
    // Feedback rounds while fewer than two land in the gate: the band is narrow on a short hook (one word
    // swapped can read 95%, two can read 80%), so the writer sees how far each attempt was off.
    for (let round = 1; round < HOOK_PICK_ROUNDS; round++) {
      if (hooks.filter((h) => codeCheck(h, donorHook, { tweets, checkHook, hookPromiseIssue }).ok).length >= 2) break;
      const notes = hooks.map((h) => { const c = checkHook(h, donorHook); return `${c.sim > LAWS.hook.gateMax ? 'TOO CLOSE' : c.sim < LAWS.hook.coverFloor ? 'TOO FAR' : 'in band'} (${Math.round(c.sim * 100)}%): ${h}`; });
      const ask = `Donor hook:\n${donorHook}\n\nYour variations so far, measured against it (a cover ships at ${Math.round(LAWS.hook.coverFloor * 100)}-${Math.round(LAWS.hook.gateMax * 100)}%):\n${notes.join('\n')}\n\nWrite ${n} new variations inside that band: from a TOO CLOSE one change one more word, from a TOO FAR one change one fewer.`;
      const again = write ? await write(notes) : await (await import('../lib.mjs')).anthropic(env, { role: 'hook-writer', max_tokens: 1500, system, messages: [{ role: 'user', content: ask }] });
      hooks = [...new Set([...hooks, ...parseHooks(again).slice(0, n)])];
    }
  }
  const current = String(tweets[0] ?? '').trim();
  const all = [...new Set([...(current ? [current] : []), ...hooks])];
  const rows = all.map((hook) => ({ hook, current: hook === current, code: codeCheck(hook, donorHook, { tweets, checkHook, hookPromiseIssue }) }))
    .map((r) => ({ ...r, sim: r.code.sim }));
  const judged = await judge(rows, donorHook, { client, log, cache });
  const scored = fp ? await Promise.all(judged.map(async (r) => ({ ...r, viral: scoreHook(r.hook, fp, { jevAnswers: r.code.ok ? await hookRead(r.hook, client, log) : null }) }))) : judged;
  return { rows: scored, fp: fp ? { pass: !!fp.pass, days: fp.window?.days, builtAt: fp.builtAt } : null, ...rank(scored, { fp }) };
}

/** Jev's hook read (shape + eleven checks) for the virality score; unread is null (code features only). */
export async function hookRead(hook, client, log = null) {
  if (!client) return null;
  try {
    const { askThrough } = await import('../jev-decide.mjs');
    return (await askThrough('hook-read', client, { state: { hook: String(hook).slice(0, 1200) }, questions: HOOK_QUESTIONS }, log ? { log } : {})).answers;
  } catch { return null; }
}

/** Pure: the print lines. */
export function renderPick({ rows, chosen, by, fp = null }) {
  const lines = [];
  if (fp) lines.push(`virality: scored against our last ${fp.days ?? '?'} days (built ${String(fp.builtAt || '').slice(0, 10)}) · ${fp.pass ? 'ranks the pick' : 'report-only (its backtest did not pass): shown, not used to pick'}`);
  for (const r of rows) {
    const j = r.jev || {};
    const jl = j.status === 'read' ? `${j.action}${j.strength != null ? ` strength ${j.strength.toFixed(2)}` : ''}${j.reasons?.length ? ` (${j.reasons.join('; ')})` : ''}`
      : j.status === 'skipped' ? 'not asked' : `NOT READ${j.reason ? ` (${j.reason})` : ''}`;
    lines.push(`${r === chosen ? '→' : ' '} ${r.current ? '[current] ' : ''}${r.sim?.toFixed?.(3) ?? '?'} · code ${r.code.ok ? 'ok' : r.code.why.map((w) => w.split(/[.:]/)[0]).join('; ')} · Jev ${jl}`);
    if (r.viral) lines.push(`    virality ${r.viral.score ?? '?'}/100 · ${r.viral.expectedLift}× page median${r.viral.drags.length ? ` · drags: ${r.viral.drags.map((d) => d.pattern).join(', ')}` : ''}`);
    lines.push(`    ${r.hook.replace(/\n/g, ' / ')}`);
  }
  if (chosen?.viral) lines.push('', 'critique of the pick:', ...critiqueBrief(chosen.viral).split('\n').map((l) => `  ${l}`));
  lines.push(chosen ? `pick (${by}): ${chosen.current ? 'keep the current hook' : 'the → candidate'}` : 'no candidate passed: rewrite the hook by hand or re-run');
  return lines;
}

async function main() {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const inFile = arg('in');
  if (!inFile) throw new Error('usage: node scripts/hook-pick.mjs --in FILE [--n 5] [--candidates FILE] [--json]');
  const input = JSON.parse(readFileSync(inFile, 'utf8'));
  const candidates = arg('candidates') ? JSON.parse(readFileSync(arg('candidates'), 'utf8')) : null;
  const { loadEnv } = await import('../lib.mjs');
  const { jev } = await import('../jev.mjs');
  const { createDecisionLog } = await import('../jev-decide.mjs');
  const env = loadEnv();
  const log = createDecisionLog();
  try {
    const out = await pickHook({ donorHook: input.donorHook, tweets: input.tweets || [], candidates, n: Number(arg('n', HOOK_PICK_N)), env, client: jev(env), log });
    if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else console.log(renderPick(out).join('\n'));
  } finally { log.flush(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
