#!/usr/bin/env node
// railway-cron.mjs — run the repo's scheduled GitHub workflows on Railway instead of GitHub Actions.
//
// WHY (owner, 2026-11-01): the Actions bill hit its limit around Oct 25 and every run has failed to
// start since ("I don't have any money right now to pay for that bill"). The owner chose "Move
// essentials to Railway". This runner keeps each workflow file the single source of truth for WHAT a
// job does; only WHEN moved. The cron lines now live in scripts/railway-cron.json, and the workflows
// keep `workflow_dispatch` only, so GitHub never bills a schedule again.
//
// HOW
//   One Railway cron service fires this hourly (`5 * * * *`). Each tick:
//     1. clones main into a scratch dir with GH_PUSH_TOKEN (a fine-grained PAT, contents:write on
//        this repo) and runs `npm ci` once;
//     2. picks every workflow whose cron (scripts/railway-cron.json) matches this UTC HOUR — the
//        minute field is ignored, so '10 3,11,19 * * *' runs in the 03, 11 and 19 UTC ticks;
//     3. runs each one like Actions would: jobs in order, every `run:` step under
//        `bash -eo pipefail` with the step's env, `if:` / `continue-on-error` / timeouts honoured,
//        `${{ }}` evaluated with github.event_name = 'schedule' and github.event.schedule = the
//        matching cron string, so the workflows' own branching on it keeps working. `uses:` steps
//        are setup (checkout, setup-node, cache, artifacts) and are no-ops here.
//     4. Before each workflow the checkout is reset to origin/main, so the workflows' own
//        "git commit / git push" persist steps work exactly as they did on Actions.
//     5. A failed workflow posts one Telegram line to the Needs You topic (lib.mjs telegram).
//
//   node scripts/railway-cron.mjs                         # the hourly tick
//   node scripts/railway-cron.mjs --list [--at <ISO>]     # what would run this hour; runs nothing
//   node scripts/railway-cron.mjs --run link-sentinel     # one workflow now (first cron as the schedule)
//   node scripts/railway-cron.mjs --run fuel-ops --schedule '5 16 * * *'
//   --here      run in the current checkout instead of a fresh clone (persist steps need a git repo)
//
// Secrets: the service's Railway variables stand in for `secrets.*` and `vars.*`, by the same names.
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const REPO = '2t1c/project-infinity';

// ---------------------------------------------------------------- cron matching (hour granularity)
function fieldMatches(field, value, min, max) {
  return String(field).split(',').some((part) => {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    else { lo = Number(range); hi = stepStr ? max : lo; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(step > 0)) return false;
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** PURE. Does `cron` fire during the UTC hour that contains `date`? The minute field is ignored. */
export function cronMatchesHour(cron, date) {
  const f = String(cron).trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [, hour, dom, mon, dow] = f;
  const d = date.getUTCDay();
  const dowOk = fieldMatches(dow, d, 0, 7) || (d === 0 && fieldMatches(dow, 7, 0, 7));
  const domOk = fieldMatches(dom, date.getUTCDate(), 1, 31);
  // Standard cron: when both day fields are restricted, either may match.
  const dayOk = dom !== '*' && dow !== '*' ? (domOk || dowOk) : (domOk && dowOk);
  return fieldMatches(hour, date.getUTCHours(), 0, 23) && fieldMatches(mon, date.getUTCMonth() + 1, 1, 12) && dayOk;
}

/** PURE. The workflows due this hour, ordered by their cron minute, each with the cron that matched. */
export function dueThisHour(table, date) {
  const due = [];
  for (const [wf, crons] of Object.entries(table.workflows || {})) {
    // Every matching cron runs, as on Actions: two crons in the same hour are two runs.
    for (const cron of crons) {
      if (cronMatchesHour(cron, date)) due.push({ workflow: wf, schedule: cron, minute: Number(String(cron).split(/\s+/)[0]) || 0 });
    }
  }
  return due.sort((a, b) => a.minute - b.minute || a.workflow.localeCompare(b.workflow));
}

// ---------------------------------------------------------------- expressions
const FUNCS = {
  always: () => true,
  cancelled: () => false,
  toJSON: (v) => JSON.stringify(v ?? null, null, 2),
  fromJSON: (s) => JSON.parse(s),
  contains: (a, b) => Array.isArray(a) ? a.some((x) => String(x).toLowerCase() === String(b).toLowerCase()) : String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  startsWith: (a, b) => String(a ?? '').toLowerCase().startsWith(String(b ?? '').toLowerCase()),
  endsWith: (a, b) => String(a ?? '').toLowerCase().endsWith(String(b ?? '').toLowerCase()),
  format: (f, ...args) => String(f).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')),
  join: (a, sep = ',') => Array.isArray(a) ? a.join(sep) : String(a ?? ''),
};

/** PURE. Translate one GitHub expression into JS source over __g(path) lookups and __f.<fn>(). */
export function translateExpr(src) {
  let out = '', i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1, str = '';
      while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { str += "'"; j += 2; continue; } if (s[j] === "'") break; str += s[j++]; }
      out += JSON.stringify(str); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[\w.\-]/.test(s[j])) {
        // a '-' only continues an identifier when a word character follows (a-b), never `x - 1`
        if (s[j] === '-' && !/\w/.test(s[j + 1] || '')) break;
        j++;
      }
      let word = s.slice(i, j).replace(/\.$/, '');
      j = i + word.length;
      if (word === 'true' || word === 'false' || word === 'null') { out += word; i = j; continue; }
      let k = j; while (s[k] === ' ') k++;
      if (s[k] === '(' && !word.includes('.')) {
        if (word === 'success' || word === 'failure') out += `__${word}`;
        else out += `__f[${JSON.stringify(word)}]`;
        i = j; continue;
      }
      out += `__g(${JSON.stringify(word)})`; i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

export function evalExpr(expr, ctx) {
  const js = translateExpr(expr);
  const get = (path) => {
    let v = ctx;
    for (const p of path.split('.')) { if (v == null) return null; v = v[p]; }
    return v === undefined ? null : v;
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('__g', '__f', '__success', '__failure', `return (${js});`);
  return fn(get, FUNCS, () => !ctx.__failed, () => !!ctx.__failed);
}

const str = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Replace every ${{ expr }} inside a string. */
export function interpolate(text, ctx) {
  return String(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => str(evalExpr(e, ctx)));
}

/** An `if:` value: bare expression or wrapped in ${{ }}. Missing means success(). */
export function evalIf(cond, ctx, fallback = '__default') {
  if (cond === undefined || cond === null) return fallback === '__default' ? !ctx.__failed : fallback;
  if (typeof cond === 'boolean') return cond && !ctx.__failed;
  let e = String(cond).trim();
  const m = e.match(/^\$\{\{([\s\S]*)\}\}$/); if (m) e = m[1];
  const usesStatus = /\b(always|success|failure|cancelled)\s*\(/.test(e);
  const v = !!evalExpr(e, ctx);
  return usesStatus ? v : (v && !ctx.__failed);
}

// ---------------------------------------------------------------- GITHUB_ENV / GITHUB_OUTPUT files
export function parseEnvFile(text) {
  const out = {}; const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; if (!l) continue;
    const h = l.match(/^([^=<]+)<<(.+)$/);
    if (h) { const end = h[2]; const buf = []; i++; while (i < lines.length && lines[i] !== end) buf.push(lines[i++]); out[h[1]] = buf.join('\n'); continue; }
    const eq = l.indexOf('='); if (eq > 0) out[l.slice(0, eq)] = l.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------- running a workflow
function secretsProxy() {
  return new Proxy({}, { get: (_, k) => (typeof k === 'string' ? (process.env[k] ?? null) : undefined) });
}

function log(...a) { console.log(`[railway-cron ${new Date().toISOString()}]`, ...a); }

/** Default step executor: GitHub's own bash invocation. Tests pass a fake (offline CI bans subprocesses). */
function bashExec(script, { cwd, env, timeout }) {
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd, env, stdio: 'inherit', timeout, killSignal: 'SIGKILL' });
  return r.status ?? r.signal;
}

export function runWorkflow(file, schedule, { cwd, runId = String(Date.now()), exec = bashExec } = {}) {
  const wfPath = join(cwd, '.github', 'workflows', file);
  const wf = parseYaml(readFileSync(wfPath, 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'rc-'));
  const github = {
    event_name: 'schedule', event: { schedule }, ref: 'refs/heads/main', ref_name: 'main',
    repository: REPO, run_id: runId, run_attempt: '1', server_url: 'https://github.com', workspace: cwd, sha: '',
  };
  const results = { workflow: file, schedule, ok: true, failedStep: null, jobs: {} };
  const needsCtx = {};
  const defaults = wf.defaults?.run || {};
  for (const [jobId, job] of Object.entries(wf.jobs || {})) {
    const base = { github, secrets: secretsProxy(), vars: secretsProxy(), inputs: {}, env: {}, steps: {}, needs: needsCtx, matrix: {}, __failed: false };
    const needs = [].concat(job.needs || []);
    if (needs.some((n) => needsCtx[n]?.result !== 'success')) {
      const runIfSkipped = job.if && /\b(always|failure)\s*\(/.test(String(job.if));
      if (!runIfSkipped) { needsCtx[jobId] = { result: 'skipped', outputs: {} }; continue; }
    }
    if (!evalIf(job.if, base, true)) { log(`${file} · job ${jobId}: skipped (if)`); needsCtx[jobId] = { result: 'skipped', outputs: {} }; continue; }
    log(`${file} · job ${jobId}: start (schedule '${schedule}')`);
    const env = { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com', GITHUB_WORKSPACE: cwd, RUNNER_TEMP: scratch, RAILWAY_CRON: '1' };
    const ctx = { ...base, env: {} };
    for (const [k, v] of Object.entries(wf.env || {})) ctx.env[k] = interpolate(v, ctx);
    for (const [k, v] of Object.entries(job.env || {})) ctx.env[k] = interpolate(v, ctx);
    const deadline = Date.now() + (Number(job['timeout-minutes']) || 60) * 60e3;
    let n = 0;
    for (const step of job.steps || []) {
      n++;
      const name = step.name || step.uses || (step.run ? String(step.run).split('\n')[0].slice(0, 60) : `step ${n}`);
      const id = step.id || `__${n}`;
      if (!evalIf(step.if, ctx)) { ctx.steps[id] = { outcome: 'skipped', conclusion: 'skipped', outputs: {} }; continue; }
      if (step.uses || !step.run) { ctx.steps[id] = { outcome: 'success', conclusion: 'success', outputs: {} }; continue; }
      const stepEnv = { ...ctx.env };
      for (const [k, v] of Object.entries(step.env || {})) stepEnv[k] = interpolate(v, ctx);
      const files = { GITHUB_ENV: join(scratch, `env-${n}`), GITHUB_OUTPUT: join(scratch, `out-${n}`), GITHUB_STEP_SUMMARY: join(scratch, 'summary.md'), GITHUB_PATH: join(scratch, `path-${n}`) };
      for (const f of [files.GITHUB_ENV, files.GITHUB_OUTPUT, files.GITHUB_PATH]) writeFileSync(f, '');
      const script = join(scratch, `step-${n}.sh`);
      writeFileSync(script, interpolate(step.run, ctx));
      const wd = step['working-directory'] || defaults['working-directory'];
      const left = Math.min(deadline - Date.now(), (Number(step['timeout-minutes']) || 1e6) * 60e3);
      log(`${file} · ${jobId} · ${name}`);
      const status = exec(script, { cwd: wd ? join(cwd, wd) : cwd, env: { ...env, ...stepEnv, ...files }, timeout: Math.max(left, 1000) });
      const ok = status === 0;
      const outputs = parseEnvFile(readFileSync(files.GITHUB_OUTPUT, 'utf8'));
      Object.assign(ctx.env, parseEnvFile(readFileSync(files.GITHUB_ENV, 'utf8')));
      const outcome = ok ? 'success' : 'failure';
      const conclusion = ok || step['continue-on-error'] ? 'success' : 'failure';
      ctx.steps[id] = { outcome, conclusion, outputs };
      if (!ok) {
        log(`${file} · ${jobId} · ${name}: FAILED (exit ${status})${step['continue-on-error'] ? ' — continue-on-error' : ''}`);
        if (!step['continue-on-error']) { ctx.__failed = true; results.ok = false; results.failedStep ??= `${jobId} › ${name}`; }
      }
    }
    const jobOutputs = {};
    for (const [k, v] of Object.entries(job.outputs || {})) jobOutputs[k] = interpolate(v, ctx);
    needsCtx[jobId] = { result: ctx.__failed ? 'failure' : 'success', outputs: jobOutputs };
    results.jobs[jobId] = needsCtx[jobId].result;
  }
  rmSync(scratch, { recursive: true, force: true });
  return results;
}

// ---------------------------------------------------------------- the tick
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.filter((a) => !/x-access-token/.test(a)).join(' ')} failed (${r.status})`);
}

function prepareCheckout() {
  const token = process.env.GH_PUSH_TOKEN;
  if (!token) throw new Error('GH_PUSH_TOKEN is not set: the workflows persist their state with git push, so the runner needs a token with contents:write on ' + REPO);
  const dir = mkdtempSync(join(tmpdir(), 'pi-'));
  sh('git', ['clone', '--quiet', '--depth', '50', '--branch', 'main', `https://x-access-token:${token}@github.com/${REPO}.git`, dir]);
  sh('git', ['config', 'user.name', 'pi-cron[bot]'], { cwd: dir });
  sh('git', ['config', 'user.email', 'pi-cron@users.noreply.github.com'], { cwd: dir });
  sh('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
  return dir;
}

function resetToMain(dir) {
  sh('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: dir });
  sh('git', ['reset', '--quiet', '--hard', 'origin/main'], { cwd: dir });
  sh('git', ['clean', '-fdq'], { cwd: dir });
}

// Same sender and routing as every other alert: lib.mjs telegram() takes the bot and chat from the
// Airtable Config row (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID only override it), topic "alerts".
async function alert(text) {
  try {
    const { telegram } = await import('../lib.mjs');
    await telegram(process.env, text, 'alerts');
  } catch (e) { console.error('alert failed:', String(e?.message || e)); /* never fails the tick */ }
}

function arg(name) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const table = JSON.parse(readFileSync(join(HERE, 'railway-cron.json'), 'utf8'));
  const at = arg('at') ? new Date(arg('at')) : new Date();
  const only = arg('run');
  let due;
  if (only) {
    const file = only.endsWith('.yml') ? only : `${only}.yml`;
    const schedule = arg('schedule') || (table.workflows[file] || [])[0];
    if (!schedule) throw new Error(`${file} is not in scripts/railway-cron.json`);
    due = [{ workflow: file, schedule }];
  } else {
    due = dueThisHour(table, at);
  }
  if (process.argv.includes('--list')) { for (const d of due) console.log(`${d.workflow}\t${d.schedule}`); return; }
  if (!due.length) { log(`nothing due in the ${at.getUTCHours()}:00 UTC hour`); return; }
  log(`due: ${due.map((d) => d.workflow).join(', ')}`);
  const cwd = process.argv.includes('--here') ? REPO_ROOT : prepareCheckout();
  const failed = [];
  for (const d of due) {
    if (!process.argv.includes('--here')) {
      try { resetToMain(cwd); } catch (e) { failed.push(`${d.workflow}: checkout reset failed`); continue; }
    }
    if (!existsSync(join(cwd, '.github', 'workflows', d.workflow))) { failed.push(`${d.workflow}: no such workflow`); continue; }
    let r;
    try { r = runWorkflow(d.workflow, d.schedule, { cwd }); } catch (e) { r = { ok: false, failedStep: String(e?.message || e) }; }
    log(`${d.workflow}: ${r.ok ? 'ok' : 'FAILED at ' + r.failedStep}`);
    if (!r.ok) failed.push(`${d.workflow}: ${r.failedStep}`);
  }
  if (failed.length) {
    await alert(`⚠️ Railway cron (${at.toISOString().slice(0, 13)}:00 UTC)\n${failed.map((f) => '• ' + f).join('\n')}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
}
