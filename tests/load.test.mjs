// Every core module loads in a fresh clone with no secrets and no network: the engine must come up
// on the example config alone, and no module may reach out at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENGINE_EXAMPLES = '1';
for (const k of Object.keys(process.env)) if (/_(PAT|KEY|TOKEN|SECRET)$/.test(k)) delete process.env[k];
const calls = [];
globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in tests'); };

const CORE = [
  'lib.mjs', 'config.mjs', 'accounts.mjs', 'laws.mjs', 'checks.mjs', 'craft-gates.mjs', 'point-frame.mjs',
  'slots.mjs', 'plug-plan.mjs', 'pick-product.mjs', 'pot-gate.mjs', 'harvest-gate.mjs', 'routing.mjs', 'vendors.mjs',
  'link-sentinel.mjs', 'check-links.mjs', 'clip-lanes.mjs', 'decisions/index.mjs', 'publish-retry.mjs',
  'scripts/hotlist.mjs', 'farm-status.mjs', 'style-pilot.mjs', 'boosters.mjs', 'onboard-account.mjs',
];

for (const f of CORE) {
  test(`${f} loads offline`, async () => {
    await import(new URL(`../${f}`, import.meta.url).href);
  });
}

test('nothing fetched at import time', () => {
  assert.deepEqual(calls, []);
});

test('no roster, boosters or style pilot carried over', async () => {
  const { ACCOUNTS } = await import('../accounts.mjs');
  const { BOOSTERS } = await import('../boosters.mjs');
  const { STYLE_ARMS } = await import('../style-pilot.mjs');
  assert.deepEqual(Object.keys(ACCOUNTS), ['example']);
  assert.deepEqual([...BOOSTERS], []);
  assert.deepEqual([...STYLE_ARMS], []);
});
