#!/usr/bin/env node
// node scripts/leftover-ids.mjs            scan every tracked file; exit 1 on any finding
// LEFTOVER_DENYLIST=/path/terms.txt ...     also scan for the operator's private terms
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, loadDenylist } from '../lib/leftovers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 2_000_000;

let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  console.error('leftover-ids: not a git checkout; run it from the repo');
  process.exit(2);
}

let denylist = [];
try { denylist = loadDenylist(process.env.LEFTOVER_DENYLIST); } catch (err) {
  console.error(`leftover-ids: cannot read LEFTOVER_DENYLIST (${err.message})`);
  process.exit(2);
}

const findings = [];
for (const f of files) {
  const abs = join(ROOT, f);
  let st;
  try { st = statSync(abs); } catch { continue; }
  if (!st.isFile() || st.size > MAX_BYTES) continue;
  const buf = readFileSync(abs);
  if (buf.includes(0)) continue; // binary
  findings.push(...scanText(f, buf.toString('utf8'), denylist));
}

const deny = denylist.length ? ` + ${denylist.length} private term(s)` : ' (no private denylist set)';
if (findings.length === 0) {
  console.log(`leftover-ids: clean · ${files.length} file(s) · patterns${deny}`);
  process.exit(0);
}
for (const x of findings) console.log(`${x.path}:${x.line}  ${x.kind}  ${x.match}`);
console.log(`leftover-ids: ${findings.length} finding(s)${deny}`);
process.exit(1);
