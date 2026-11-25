#!/usr/bin/env node
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXCLUDED_TESTS = new Set(['secret-scan-integration.test.mjs']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', timeout: 180000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} ${args.join(' ')} failed with exit ${result.status}`);
}

function resolveExecutable(command) {
  for (const directory of String(process.env.PATH || '').split(delimiter)) {
    const candidate = join(directory, command);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  throw new Error(`required executable is unavailable: ${command}`);
}

export function trackedFiles(root = PROJECT_ROOT) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('could not inventory tracked files');
  return result.stdout.split('\0').filter(Boolean);
}

export function discoverTests(root) {
  return readdirSync(join(root, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs') && !EXCLUDED_TESTS.has(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

export function copyTrackedSnapshot(source, destination, files = trackedFiles(source)) {
  for (const relative of files) {
    const name = basename(relative);
    if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') continue;
    const from = join(source, relative);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`tracked symlinks are not allowed in offline CI: ${relative}`);
    const to = join(destination, relative);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

export function offlinePlan(snapshot) {
  const modules = trackedFiles(snapshot).filter((file) => file.endsWith('.mjs')).sort();
  const commands = modules.map((file) => ({ label: `syntax ${file}`, args: ['--check', file] }));
  commands.push({ label: 'legacy scaffolds', args: ['test-scaffolds.mjs'] });
  for (const file of discoverTests(snapshot)) commands.push({ label: file, args: [file] });
  commands.push(
    { label: 'product rules', args: ['smoke-test.mjs', '--no-live'] },
    { label: 'attribution integrity', args: ['tracking-smoke.mjs', '--static'] },
    {
      label: 'batch helper behavior',
      args: ['-e', "import('./plan-check.mjs').then(m=>{const r=m.checkPlan({days:{d:[{account:'a',bucket:'cover',donor:'r',heavy:'B'}]}},{mix:[50,50,0]});if(!r.errors.some(e=>/0 harvest/.test(e)))process.exit(1)})"],
    },
    { label: 'pod capacity', args: ['pod-capacity.mjs', '--check'] },
  );
  return commands;
}

export function executePlan(snapshot, commands = offlinePlan(snapshot)) {
  const guard = join(snapshot, 'scripts', 'offline-network-guard.cjs');
  const home = join(snapshot, '.offline-home');
  mkdirSync(home, { recursive: true });
  const environment = {
    PATH: process.env.PATH || '',
    HOME: home,
    TMPDIR: home,
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
    PROJECT_INFINITY_OFFLINE_ROOT: snapshot,
    PROJECT_INFINITY_OFFLINE_GIT: resolveExecutable('git'),
  };
  for (const { label, args, timeout = 180000 } of commands) {
    console.log(`\n=== ${label} ===`);
    run(process.execPath, args, { cwd: snapshot, env: environment, timeout });
  }
}

export function runOffline({ root = PROJECT_ROOT, files = trackedFiles(root), commands } = {}) {
  const snapshot = mkdtempSync(join(tmpdir(), 'project-infinity-offline-'));
  try {
    copyTrackedSnapshot(root, snapshot, files);
    run('git', ['init', '-q'], { cwd: snapshot });
    run('git', ['add', '-A'], { cwd: snapshot });
    const dependencies = join(root, 'node_modules');
    if (!lstatSync(dependencies).isDirectory()) throw new Error('node_modules is missing; run npm ci first');
    symlinkSync(dependencies, join(snapshot, 'node_modules'), 'dir');
    executePlan(snapshot, commands);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runOffline();
    console.log('\nOffline CI passed in an isolated tracked-source snapshot.');
  } catch (error) {
    console.error(`\nOffline CI failed: ${error.message}`);
    process.exitCode = 1;
  }
}
