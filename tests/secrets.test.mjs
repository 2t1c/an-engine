import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRETS, PAIRS, secretsStatus, secret } from '../lib/secrets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('.env.example lists exactly the contract, in order', () => {
  const names = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split('=')[0]);
  assert.deepEqual(names, SECRETS.map((s) => s.name));
});

test('.env.example carries no values', () => {
  for (const l of readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')) {
    if (/^[A-Z0-9_]+=/.test(l)) assert.match(l, /=$/, `${l.split('=')[0]} has a value`);
  }
});

test('every pair names secrets in the contract', () => {
  const names = new Set(SECRETS.map((s) => s.name));
  for (const pair of PAIRS) for (const n of pair) assert.ok(names.has(n), n);
});

test('status reports missing required secrets and half pairs, never values', () => {
  const env = { TYPEFULLY_API_KEY: 'tf-secret-value', CLIPPER_URL: 'https://clip.example' };
  const s = secretsStatus(env);
  assert.equal(s.ok, false);
  assert.ok(s.missing.includes('LEVANTA_API_KEY'));
  assert.ok(!s.missing.includes('TYPEFULLY_API_KEY'));
  assert.deepEqual(s.halfPairs, [['CLIPPER_URL', 'CLIPPER_SERVICE_KEY']]);
  assert.ok(!JSON.stringify(s).includes('tf-secret-value'));
});

test('all required set and pairs whole is ok; whitespace does not count as set', () => {
  const env = Object.fromEntries(SECRETS.filter((s) => s.required).map((s) => [s.name, 'x']));
  assert.equal(secretsStatus(env).ok, true);
  assert.equal(secretsStatus({ ...env, LEVANTA_API_KEY: '   ' }).ok, false);
});

test('secret() names the missing secret without a value, and refuses names outside the contract', () => {
  assert.throws(() => secret('LEVANTA_API_KEY', {}), /LEVANTA_API_KEY is not set/);
  assert.throws(() => secret('SOME_OTHER_KEY', { SOME_OTHER_KEY: 'v' }), /not in the contract/);
  assert.equal(secret('LEVANTA_API_KEY', { LEVANTA_API_KEY: ' k ' }), 'k');
});
