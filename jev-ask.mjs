#!/usr/bin/env node
// jev-ask.mjs — the in-session CLI for Jev decisions (plan §1.1 "In-session CLI", Track K). A skill
// replaces "judge X in prose" with one command and reads a typed answer back:
//
//   node jev-ask.mjs <decision> --in <input.json | ->  [--dry] [--no-log]
//   node jev-ask.mjs --list
//
// It runs one registered decision (decisions/index.mjs) through decide(), under the mode, thresholds and
// PINNED model laws.json `jev.decisions.<name>` gives it (the env's TYPESAFE_DEFAULT_MODEL is not used:
// decide() always sends the laws model), and prints one JSON object on stdout:
//
//   { decision, read, action, jevAction, detail, answers, source, fallback, mode, configuredMode,
//     proposal, confidence, model, reason, ms, cached }
//
// `read` is false when Jev could not answer (no key, transport, deadline, breaker, a partial answer set):
// the answer is then "not read", never a pass, and the exit code is 3. In shadow, `action` is the
// incumbent's and `jevAction` is Jev's reading; `detail` is the rest of the policy's verdict when it was
// read. `answers` are typed values and confidences only.
//
// Read-only. The only side effect is the decision log (learnings/jev-decisions/, hashes and ids only);
// --no-log skips it. Spend is metered in-process and NOT flushed to Airtable (the same rule as
// scripts/jev-eval.mjs), so a skill calling it writes nothing outside the repo. --dry uses no client.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answersDigest, decide, decisionConfig, flushDecisionLog } from './jev-decide.mjs';
import { LAWS } from './laws.mjs';

export const EXIT_NOT_READ = 3;
export const EXIT_USAGE = 2;

/**
 * Typed answers without distributions: { noul } | { choice, confidence } | { score, confidence }. Built on
 * the decision log's answersDigest, so a long free-text choice is printed as its hash, exactly as logged.
 */
export function typedAnswers(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const names = { n: 'noul', s: 'score', ch: 'choice', c: 'confidence' };
  return Object.fromEntries(Object.entries(answersDigest(answers)).map(([k, v]) => [k,
    Object.fromEntries(Object.entries(v).map(([short, x]) => [names[short], x]))]));
}

async function registryOf(registry) {
  return registry ?? (await import('./decisions/index.mjs')).DECISIONS;
}

/**
 * Run one decision and shape the answer. Never throws for a Jev failure (decide() falls back); throws
 * only for a programming error (unknown decision, broken module, an incumbent that throws).
 */
export async function ask(name, input, { client = null, registry = null, laws = LAWS, log, cache, now } = {}) {
  const reg = await registryOf(registry);
  const r = await decide(name, input, { client, registry: reg, laws, log, cache, now, role: `jev-ask:${name}` });
  const read = r.source !== 'fallback' && r.answers != null;
  return {
    decision: name, read, action: r.action, jevAction: r.jevAction, detail: read ? r.detail : null, answers: typedAnswers(r.answers),
    source: r.source, fallback: r.fallback, mode: r.mode, configuredMode: r.configuredMode, proposal: r.proposal,
    confidence: r.confidence, model: r.model, reason: r.reason, ms: r.ms, cached: r.cached,
  };
}

export function parseArgs(argv) {
  const out = { name: null, inPath: null, dry: false, log: true, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') { out.inPath = argv[++i] ?? null; if (out.inPath == null) throw new Error('--in needs a file or -'); }
    else if (a === '--dry') out.dry = true;
    else if (a === '--no-log') out.log = false;
    else if (a === '--list') out.list = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (!out.name) out.name = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.list && (!out.name || !out.inPath)) throw new Error('usage: node jev-ask.mjs <decision> --in <input.json|-> [--dry] [--no-log] | --list');
  return out;
}

export function readInput(inPath, readStdin = () => readFileSync(0, 'utf8')) {
  const raw = inPath === '-' ? readStdin() : readFileSync(resolve(inPath), 'utf8');
  return JSON.parse(raw);
}

/** A client from env, or null (decide() then reads it as not read: no_client). */
export async function clientFromEnv() {
  try {
    const [{ jev }, { loadEnv }] = await Promise.all([import('./jev.mjs'), import('./lib.mjs')]);
    return jev(loadEnv());
  } catch { return null; }
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (error) { console.error(error.message); return EXIT_USAGE; }
  const registry = await registryOf(null);
  if (args.list) {
    console.log(JSON.stringify(Object.keys(registry).map((name) => ({ name, mode: decisionConfig(name).mode })), null, 2));
    return 0;
  }
  if (!Object.hasOwn(registry, args.name)) { console.error(`no decision named ${args.name} (node jev-ask.mjs --list)`); return EXIT_USAGE; }
  let input;
  try { input = readInput(args.inPath); } catch (error) { console.error(`input not read: ${error.message}`); return EXIT_USAGE; }
  const client = args.dry ? null : await clientFromEnv();
  try {
    const out = await ask(args.name, input, { client, registry, ...(args.log ? {} : { log: null }) });
    console.log(JSON.stringify(out, null, 2));
    return out.read ? 0 : EXIT_NOT_READ;
  } finally { flushDecisionLog(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
