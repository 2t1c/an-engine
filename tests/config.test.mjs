import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateEngine, validatePages, validateProducts, activePages, CONFIG_DIR } from '../lib/config.mjs';

const example = (name) => JSON.parse(readFileSync(join(CONFIG_DIR, `${name}.example.json`), 'utf8'));

test('the shipped example config is valid', () => {
  const cfg = loadConfig({ examples: true });
  assert.equal(cfg.engine.profitShare.operatorPct, 50);
  assert.equal(activePages(cfg).length, 0, 'example pages ship inactive');
});

test('a fresh clone without config/*.json fails with a copy hint per file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  assert.throws(() => loadConfig({ dir }), (err) => {
    assert.match(err.message, /3 problem/);
    assert.match(err.message, /copy config\/pages\.example\.json/);
    return true;
  });
});

test('a buyer clone with filled config loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  for (const n of ['engine', 'pages', 'products']) copyFileSync(join(CONFIG_DIR, `${n}.example.json`), join(dir, `${n}.json`));
  assert.ok(loadConfig({ dir }).engine);
});

test('broken JSON is reported, not thrown raw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  for (const n of ['engine', 'pages', 'products']) copyFileSync(join(CONFIG_DIR, `${n}.example.json`), join(dir, `${n}.json`));
  writeFileSync(join(dir, 'pages.json'), '{ nope');
  assert.throws(() => loadConfig({ dir }), /pages\.json: not valid JSON/);
});

test('engine validation catches the mistakes that would mis-schedule or mis-split', () => {
  const e = example('engine');
  assert.deepEqual(validateEngine(e), []);
  assert.ok(validateEngine({ ...e, buyer: { name: 'x', timezone: 'Mars/Base' } }).some((m) => /unknown time zone/.test(m)));
  assert.ok(validateEngine({ ...e, posting: { ...e.posting, windowStart: '22:00', windowEnd: '10:00' } }).some((m) => /before windowEnd/.test(m)));
  assert.ok(validateEngine({ ...e, posting: { ...e.posting, windowStart: '25:00' } }).some((m) => /windowStart: HH:MM/.test(m)));
  assert.ok(validateEngine({ ...e, profitShare: { ...e.profitShare, operatorPct: 150 } }).some((m) => /operatorPct/.test(m)));
  assert.ok(validateEngine({ ...e, profitShare: { ...e.profitShare, costs: ['lunch'] } }).some((m) => /unknown cost lunch/.test(m)));
  assert.ok(validateEngine({ ...e, features: { rtLadder: 'yes', hookClips: true } }).some((m) => /rtLadder/.test(m)));
  assert.deepEqual(validateEngine(null), ['engine: not an object']);
});

test('page validation catches duplicates, bad handles and active pages without a Typefully set', () => {
  const p = example('pages').pages[0];
  assert.deepEqual(validatePages({ pages: [p] }), []);
  assert.ok(validatePages({ pages: [p, p] }).some((m) => /duplicate/.test(m)));
  assert.ok(validatePages({ pages: [{ ...p, handle: '@with-at' }] }).some((m) => /handle/.test(m)));
  assert.ok(validatePages({ pages: [{ ...p, active: true }] }).some((m) => /real typefullySocialSetId/.test(m)));
  assert.ok(validatePages({ pages: [{ ...p, rtLane: 'fast' }] }).some((m) => /rtLane/.test(m)));
  assert.deepEqual(validatePages([]), ['pages: { "pages": [...] } required']);
});

test('product validation keeps non-Prime products off the active shelf', () => {
  const p = example('products').products[0];
  assert.deepEqual(validateProducts({ products: [p] }), []);
  assert.ok(validateProducts({ products: [{ ...p, prime: false, active: true }] }).some((m) => /Prime/.test(m)));
  assert.deepEqual(validateProducts({ products: [{ ...p, prime: false, active: false }] }), []);
  assert.ok(validateProducts({ products: [{ ...p, asin: '12345' }] }).some((m) => /ASIN/.test(m)));
  assert.ok(validateProducts({ products: [{ ...p, slots: ['mid'] }] }).some((m) => /slots/.test(m)));
  assert.ok(validateProducts({ products: [p, p] }).some((m) => /duplicate/.test(m)));
});
