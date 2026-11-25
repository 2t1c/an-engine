// accounts-sync.mjs — mirror the account roster from accounts.mjs (single source of truth) into the
// Airtable "Accounts" table, which n8n workflows read at runtime instead of hardcoded lists.
//
//   node accounts-sync.mjs          # upsert engine-managed rows
//   node accounts-sync.mjs --dry    # show the plan, write nothing
//
// Ownership contract (see the table description in Airtable):
//   - Rows WITH an "Engine Key" are owned by this script for IDENTITY fields (Label, Handle,
//     Social Set ID, Monetized, Engine Key) — overwritten on every run.
//   - "Active" is the OPERATOR'S master switch (2026-07-22): seeded from !paused when the row is
//     first created, then NEVER overwritten — flip it in Airtable to pause/resume an account
//     everywhere (the engines overlay it onto ACCOUNTS[key].paused at startup; see accounts.mjs).
//     It used to be engine-owned, which silently reverted the operator's toggle on every sync.
//   - Feature flags (Fuel Watch, Calendar, RT Row, RT Threads Only) are likewise create-only.
//   - Rows WITHOUT an Engine Key (RT-only / client accounts like GeniusGTX, Toan) are never touched.
//
// Runs automatically via .github/workflows/accounts-sync.yml on any push to main that changes
// accounts.mjs — so "add/pause an account" = edit accounts.mjs, merge, done.
import { loadEnv, requireEnv } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';

const DRY = process.argv.includes('--dry');
const env = loadEnv();
requireEnv(env, ['AIRTABLE_PAT']);
const BASE = env.XDB_BASE_ID || 'app7vXbBugWeCGctD';
const TABLE = 'tblwn2lLoJBuJKvUv'; // Accounts
const H = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };

const at = async (method, path, body) => {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}${path}`, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Airtable ${method} ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// Current table state, keyed by Engine Key (manual rows have none and are ignored).
const existing = new Map();
for (let offset = ''; ;) {
  const j = await at('GET', `?pageSize=100${offset ? `&offset=${offset}` : ''}`);
  for (const rec of j.records || []) {
    const k = rec.fields['Engine Key'];
    if (k) existing.set(k, rec);
  }
  if (!j.offset) break;
  offset = j.offset;
}

const creates = [], updates = [];
for (const [key, a] of Object.entries(ACCOUNTS)) {
  if (!a.socialSetId) continue; // no Typefully set -> nothing for n8n to act on
  const owned = { // overwritten every run — accounts.mjs is authoritative for IDENTITY only
    'Label': a.name, 'Handle': a.handle, 'Social Set ID': a.socialSetId,
    'Monetized': !!a.plugHeavyExample, 'Engine Key': key,
    // FUEL STAGING AS DATA (kit 2026-08-24): the hold date. Replaces the old "enable ~2 days after
    // launch" code comments, which got forgotten. Empty = eligible (grandfathers every existing
    // account). READ by Fuel the Fire's "Plan Watches" since 2026-09-03 17:18Z: a row whose date is
    // still ahead (UTC calendar compare) is left out of the T1-T6 watch list even when Active. Not
    // read by the RT Bridge — T0 stays on the manual RT Row switch. For three weeks before that fix
    // this column was written here and read nowhere, while four files said the opposite.
    'Fuel Eligible After': a.fuelEligibleAfter || null,
  };
  const prev = existing.get(key);
  if (!prev) {
    // First sighting: seed Active + feature flags with defaults (never touched again — the
    // operator owns them in Airtable; Active is the live master switch the engines read).
    // SINGLES ARE ALWAYS BLOCKED BY DEFAULT (operator rule, 2026-09-03): 'RT Threads Only' seeds
    // TRUE so a new page can never ping a one-post filler into a paid vendor group. It used to
    // seed blank (= false), which is how the fleet spent $8.60 a pop RT-boosting warm-up singles.
    // All 17 Project Infinity rows were backfilled to true the same day; this keeps future ones
    // correct. Since the owner's 2026-09-21 direction, the Bridge also enforces multi-post X
    // threads for every account, including client rows with a legacy false flag.
    // 'RT Row' is deliberately NOT seeded — blank is the bridge's off switch until warm-up ends.
    creates.push({ fields: { ...owned, 'Active': !a.paused, 'Fuel Watch': true, 'RT Threads Only': true, 'Calendar': !!a.plugHeavyExample } });
  } else {
    const drift = Object.entries(owned).filter(([f, v]) => (prev.fields[f] ?? false) !== v);
    if (drift.length) updates.push({ id: prev.id, fields: owned, drift: drift.map(([f]) => f) });
  }
}

console.log(`roster: ${Object.keys(ACCOUNTS).length} accounts.mjs entries | table rows owned: ${existing.size} | create: ${creates.length} | update: ${updates.length}`);
for (const c of creates) console.log(`  + ${c.fields.Label} (${c.fields['Engine Key']})`);
for (const u of updates) console.log(`  ~ ${u.fields.Label}: ${u.drift.join(', ')}`);
if (DRY) { console.log('(dry) no writes.'); process.exit(0); }

for (let i = 0; i < creates.length; i += 10) await at('POST', '', { records: creates.slice(i, i + 10).map(({ fields }) => ({ fields })), typecast: true });
for (let i = 0; i < updates.length; i += 10) await at('PATCH', '', { records: updates.slice(i, i + 10).map(({ id, fields }) => ({ id, fields })), typecast: true });
console.log(creates.length + updates.length ? '✓ synced.' : '✓ no drift — table already matches accounts.mjs.');
