import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromPage, ACCOUNTS, getAccount, resolveAccountKey } from '../accounts.mjs';

test('the roster comes from config, not code: the example page is the only account', () => {
  assert.deepEqual(Object.keys(ACCOUNTS).filter((k) => k !== 'burner'), ['example']);
  assert.equal(getAccount('Example Page').handle, 'ExampleHealth');
  assert.equal(resolveAccountKey('nobody'), null);
});

test('a page entry becomes the account shape consumers read', () => {
  const a = accountFromPage({ id: 'p', name: 'P', persona: 'f', handle: 'P1', typefullySocialSetId: 5, levantaSubidPrefix: 'x-thread-p', rtLane: 't0-only', active: true, voice: ['a', 'b'], closing: 'c', disclaimer: 'd' }, { tz: 'UTC', fleet: { slots: 7 } });
  assert.equal(a.sex, 'f');
  assert.equal(a.socialSetId, 5);
  assert.equal(a.paused, false);
  assert.equal(a.voice, 'a\nb');
  assert.deepEqual(a.niches, ['Health']);
  assert.deepEqual(a.closingLegacy, ['c']);
  assert.equal(a.slots, 7);
  assert.equal(a.tz, 'UTC');
});

test('an inactive page is paused', () => {
  assert.equal(accountFromPage({ id: 'p', active: false }).paused, true);
});
