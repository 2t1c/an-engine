#!/usr/bin/env node
// scripts/deps-check.mjs — are package.json's dependencies installed? Prints the missing ones and exits 1,
// so a run finds out in a second at step 1, not as a crash halfway through the picker (2026-11-18:
// pick-donors died on a missing @typesafe-ai/sdk after its reads had run). No dependencies of its own.
//
//   node scripts/deps-check.mjs        # exit 0: all present · exit 1: run `npm install`
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The declared dependencies with no package.json under node_modules. */
export function missingDeps(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) });
  return names.filter((n) => !existsSync(join(root, 'node_modules', ...n.split('/'), 'package.json')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const miss = missingDeps();
  if (miss.length) { console.error(`missing ${miss.length} package(s): ${miss.join(', ')} · run npm install`); process.exit(1); }
  console.log('deps ok');
}
