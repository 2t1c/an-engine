#!/usr/bin/env node
// node scripts/check.mjs   every gate a commit must pass: tests, example config, leftover ids.
// In a buyer's clone it also validates the real config.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['tests', ['--test', 'tests/**/*.test.mjs']],
  ['example config', ['scripts/check-config.mjs', '--examples']],
  ['leftover ids', ['scripts/leftover-ids.mjs']],
];
if (existsSync(join(ROOT, 'config', 'engine.json'))) steps.push(['buyer config', ['scripts/check-config.mjs']]);

let failed = 0;
for (const [label, args] of steps) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`);
}
process.exit(failed ? 1 : 0);
