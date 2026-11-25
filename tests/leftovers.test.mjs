import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, parseDenylist } from '../lib/leftovers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Built at runtime so this file never holds an id-shaped literal itself.
const fakeBase = 'app' + 'A1b2C3d4E5f6G7';
const fakeTable = 'tbl' + 'Z9y8X7w6V5u4T3';
const fakeChat = '-100' + '4345115000';

test('finds Airtable and Telegram ids with their line', () => {
  const f = scanText('lib/x.mjs', `ok\nconst base = '${fakeBase}';\nconst t = '${fakeTable}', chat = '${fakeChat}';`);
  assert.deepEqual(f.map((x) => [x.line, x.kind]), [[2, 'airtable-id'], [3, 'airtable-id'], [3, 'telegram-group-id']]);
});

test('id-shaped words without a digit are not ids', () => {
  assert.deepEqual(scanText('lib/x.mjs', 'const approvedSelection = recordsAreHereNow;'), []);
});

test("a buyer's own config files are not scanned, but the examples are", () => {
  assert.deepEqual(scanText('config/engine.json', fakeBase), []);
  assert.equal(scanText('config/engine.example.json', fakeBase).length, 1);
});

test('the private denylist matches whole words, case-insensitive, and never echoes the term', () => {
  const deny = parseDenylist('# operator pages\nSomeHandle\n\nx-thread-someone  # subid\nab\n');
  assert.deepEqual(deny, ['SomeHandle', 'x-thread-someone'], 'comments, blanks and <3-char terms dropped');
  const f = scanText('docs/a.md', 'Posted on @somehandle today\nSomeHandleX is a different page\nsubid x-thread-someone', deny);
  assert.deepEqual(f.map((x) => x.line), [1, 3]);
  for (const x of f) assert.ok(!x.match.toLowerCase().includes('somehandle') && !x.match.includes('someone'));
});

test('the engine repo itself is clean', () => {
  const r = spawnSync(process.execPath, ['scripts/leftover-ids.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LEFTOVER_DENYLIST: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
