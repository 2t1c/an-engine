#!/usr/bin/env node
// cells-sync.mjs — keep the Airtable side of the dials program in step with the pot files.
//
// The pot spec is the source of truth for a pot's ticket (`dials`); docs/seed-dials/home-cells.json
// is the source of truth for a seed's home cell. This pushes both into the registry so the cells can
// be read where the money is:
//
//   Seeds.Home Cell        the seed's value on every dial (JSON)
//   Cells                  one row per seed × dial for every seed that has pots — Dial, Seed, Home
//   Pots.Dial / .Ticket    stamped from the spec's `dials`
//   Pots.Cell              the one Cells row the ticket puts the pot in
//   spec.potRecId          written back when a pre-ticket pot's row is found by name
//
// It never deletes, never touches Status, Plants or anything the plant lane owns, and creates a Pots
// row only for a spec that has none (a pre-ticket pot whose row the old lane never made).
//
//   node cells-sync.mjs            # sync everything
//   node cells-sync.mjs --dry      # say what would change
//   node cells-sync.mjs --seed X   # one family
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, HERE_DIR } from './lib.mjs';
import { COLUMNED } from './pot-gate.mjs';

// Derived from pot-gate's COLUMNED rather than copied: the two lists disagreeing is how a dial can
// be writable but have no column to land in. SINGLE was `DIALS.slice(1, 10)`, an index that quietly
// excluded anything appended after 'substance'.
export const DIALS = ['control', ...COLUMNED, '2 dials'];
const SINGLE = COLUMNED;
const POTS_DIR = join(HERE_DIR, 'queues', 'pots');
const HOME = join(HERE_DIR, 'docs', 'seed-dials', 'home-cells.json');
const BLOCKED = join(HERE_DIR, 'docs', 'seed-dials', 'blocked-cells.json');

/** The column a ticket lands in: [] control · one known dial · anything else a pair cell. */
export function cellOf(dials) {
  if (!Array.isArray(dials)) return null;
  if (dials.length === 0) return 'control';
  if (dials.length === 1 && SINGLE.includes(dials[0].dial)) return dials[0].dial;
  return '2 dials';
}
/** The ticket as one line for the Pots row. */
export function ticketText(dials) {
  if (!Array.isArray(dials) || dials.length === 0) return 'control';
  return dials.map((d) => `${d.dial}: ${d.from} → ${d.to}`).join(' | ');
}
export const cellName = (seed, dial) => `${seed} · ${dial}`;

// Pre-ticket rows the old lane named differently from the spec file. Everything else matches on
// `<fruit> · <angle>` with case and punctuation ignored.
const ALIASES = {
  'peach-glucose': 'peach · blood sugar chain', 'peach-energy': 'peach · energy chain', 'peach-immune': 'peach · immune chain',
  'peach-muscle': 'peach · muscle chain', 'peach-nerve': 'peach · nerve chain', 'peach-stress': 'peach · stress chain',
  'beet-omega3': 'omega-3 · the rheumatologist quote', 'beet-protein': 'protein · the gastroenterologist quote',
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function readSpecs(seedFilter) {
  const out = [];
  for (const f of readdirSync(POTS_DIR).filter((x) => x.endsWith('.greenhouse.json')).sort()) {
    const file = join(POTS_DIR, f);
    const raw = readFileSync(file, 'utf8');
    const spec = JSON.parse(raw);
    const name = f.replace(/\.greenhouse\.json$/, '');
    const seed = spec.potOf || name.split('-')[0];
    if (seedFilter && seed !== seedFilter) continue;
    const angle = spec.angle || (name.startsWith(`${seed}-`) ? name.slice(seed.length + 1) : name);
    out.push({ name, file, raw, spec, seed, angle, indent: (raw.match(/\n( +)"/) || [, ' '])[1].length });
  }
  return out;
}

/** Airtable's create() in lib returns a count; the rows come back only from the API itself. */
async function createReturning(env, base, table, records) {
  const made = [];
  for (let i = 0; i < records.length; i += 10) {
    const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, records: records.slice(i, i + 10) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${table} create -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    made.push(...(j.records || []));
  }
  return made;
}

/** lib's update() hides the response body; a refused batch needs its reason to be fixable. */
async function patchBatches(env, base, table, records) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, records: batch }),
    });
    if (!r.ok) throw new Error(`${table} update batch ${i / 10} (${batch.map((b) => b.id).join(', ')}) -> ${r.status} ${(await r.text()).slice(0, 400)}`);
  }
}

/** Find or make the Cells row for seed × dial. `cells` is the live map name → row, kept in step. */
export async function ensureCell({ at, env, base, cells, seedRow, dial, home, dry }) {
  const name = cellName(seedRow.fields.Name, dial);
  if (cells.get(name)) return cells.get(name);
  const fields = { Cell: name, Dial: dial, Seed: [seedRow.id], Home: home || '' };
  if (dry) { const fake = { id: `dry-${name}`, fields }; cells.set(name, fake); return fake; }
  const [row] = await createReturning(env, base, 'Cells', [{ fields }]);
  cells.set(name, row);
  return row;
}

export async function syncCells({ dry = false, seed: seedFilter = null, log = console.log } = {}) {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const base = env.REGISTRY_BASE_ID;
  const at = airtable(env, base);
  const homes = JSON.parse(readFileSync(HOME, 'utf8'));
  const blocked = JSON.parse(readFileSync(BLOCKED, 'utf8'));

  const seeds = await at.listAll('Seeds', { fields: ['Name', 'Home Cell'] });
  const seedByName = new Map(seeds.map((s) => [String(s.fields.Name || '').toLowerCase(), s]));
  const cellRows = await at.listAll('Cells', { fields: ['Cell', 'Dial', 'Seed', 'Home', 'Operator Note'] });
  const cells = new Map(cellRows.map((c) => [c.fields.Cell, c]));
  const potRows = await at.listAll('Pots', { fields: ['Name', 'Seed', 'Status', 'Dial', 'Ticket', 'Cell', 'Greenhouse Draft'] });
  const potById = new Map(potRows.map((p) => [p.id, p]));
  const potByKey = new Map();
  for (const p of potRows) { const k = norm(p.fields.Name); if (!potByKey.has(k)) potByKey.set(k, []); potByKey.get(k).push(p); }
  const specs = readSpecs(seedFilter);
  const report = { homeCells: 0, cellsMade: 0, blocked: 0, potsStamped: 0, potsMade: 0, potsLinked: 0, unmatched: [], ambiguous: [], missingSeed: [] };

  // 1. Seeds.Home Cell
  for (const [name, home] of Object.entries(homes)) {
    if (name.startsWith('_')) continue;
    if (seedFilter && name !== seedFilter) continue;
    const row = seedByName.get(name);
    if (!row) { report.missingSeed.push(name); continue; }
    const want = JSON.stringify(home, null, 1);
    if ((row.fields['Home Cell'] || '') === want) continue;
    if (!dry) await at.update('Seeds', [{ id: row.id, fields: { 'Home Cell': want } }]);
    report.homeCells++;
  }

  // 2. Cells rows for every seed that has pots, every dial
  const seedsWithPots = [...new Set(specs.map((s) => s.seed))];
  for (const seedName of seedsWithPots) {
    const seedRow = seedByName.get(seedName);
    if (!seedRow) { if (!report.missingSeed.includes(seedName)) report.missingSeed.push(seedName); continue; }
    for (const dial of DIALS) {
      const before = cells.size;
      await ensureCell({ at, env, base, cells, seedRow, dial, home: dial === '2 dials' ? 'two dials moved' : (homes[seedName] || {})[dial], dry });
      if (cells.size > before) report.cellsMade++;
    }
  }

  // 2b. A BLOCKED cell is a dial the seed cannot turn without stopping being itself (its own
  // mechanics say so). It owes no pots, so the read surfaces must not call it open: the reason goes
  // in the row's Operator Note, prefixed `blocked —`, which is what farm-status reads.
  for (const [seedName, dials] of Object.entries(blocked)) {
    if (seedName.startsWith('_')) continue;
    if (seedFilter && seedName !== seedFilter) continue;
    for (const [dial, why] of Object.entries(dials)) {
      const row = cells.get(cellName(seedName, dial));
      if (!row) continue;
      const want = `blocked — ${why}`;
      if ((row.fields['Operator Note'] || '') === want) continue;
      if (!dry) await patchBatches(env, base, 'Cells', [{ id: row.id, fields: { 'Operator Note': want } }]);
      report.blocked++;
    }
  }

  // 3. Pots: stamp Dial / Ticket / Cell; find pre-ticket rows by name; create the rows that never existed
  const updates = [];
  for (const s of specs) {
    const dials = s.spec.dials;
    if (!Array.isArray(dials)) { report.unmatched.push(`${s.name}: no dials ticket in the spec`); continue; }
    const seedRow = seedByName.get(s.seed);
    if (!seedRow) continue;
    const dial = cellOf(dials);
    const cell = cells.get(cellName(s.seed, dial));
    let row = s.spec.potRecId ? potById.get(s.spec.potRecId) : null;
    if (s.spec.potRecId && !row) report.unmatched.push(`${s.name}: spec points at Pots ${s.spec.potRecId}, which the table does not have`);
    if (!row) {
      let found = potByKey.get(norm(`${s.seed} · ${s.angle}`)) || [];
      if (!found.length && ALIASES[s.name]) {
        const k = norm(ALIASES[s.name]); // the old lane's own names, matched on their prefix only
        found = potRows.filter((p) => norm(p.fields.Name).startsWith(k));
      }
      if (found.length > 1) { report.ambiguous.push(`${s.name}: ${found.length} rows named alike (${found.map((p) => p.id).join(', ')}) — pick one and put it in the spec's potRecId`); continue; }
      if (found.length === 1) {
        row = found[0];
        if (!dry) { s.spec.potRecId = row.id; writeFileSync(s.file, JSON.stringify(s.spec, null, s.indent) + (s.raw.endsWith('\n') ? '\n' : '')); }
        report.potsLinked++;
      }
    }
    const want = { Dial: dial, Ticket: ticketText(dials), Cell: cell ? [cell.id] : [] };
    if (!row) {
      // a pre-ticket pot whose row the old lane never made: the minimum row, Status Potted, and the note says why
      const fields = {
        Name: `${s.seed} · ${s.angle}`, Seed: [seedRow.id], Status: 'Potted', Angle: s.angle,
        'Greenhouse Draft': s.spec.greenhouseDraft || undefined, Version: Number(s.spec.seedVersion) || 1,
        Products: (s.spec.products || []).map((p) => `${p.slot ? `[${p.slot}] ` : ''}${p.title || p.asin}`).join(' · '),
        Variables: Object.entries({ ...(s.spec.variables || {}), dials: ticketText(dials) }).map(([k, v]) => `${k}: ${v}`).join('\n'),
        'Operator Note': 'Row made by cells-sync.mjs (2026-09-19): a pre-ticket pot the old lane never rowed. Status and plants are not known here.',
        ...want,
      };
      if (!dry) {
        const [made] = await createReturning(env, base, 'Pots', [{ fields }]);
        s.spec.potRecId = made.id; writeFileSync(s.file, JSON.stringify(s.spec, null, s.indent) + (s.raw.endsWith('\n') ? '\n' : ''));
      }
      report.potsMade++;
      continue;
    }
    const have = { Dial: row.fields.Dial || null, Ticket: row.fields.Ticket || '', Cell: row.fields.Cell || [] };
    const same = have.Dial === want.Dial && have.Ticket === want.Ticket && have.Cell.length === want.Cell.length && have.Cell.every((id, i) => id === want.Cell[i]);
    if (same) continue;
    updates.push({ id: row.id, fields: want });
    log(`${dry ? '—' : '✓'} ${s.name}: ${want.Dial} · ${want.Ticket}`);
  }
  if (updates.length && !dry) await patchBatches(env, base, 'Pots', updates);
  report.potsStamped = updates.length;
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const si = argv.indexOf('--seed');
  const seed = si >= 0 ? argv[si + 1] : null;
  const r = await syncCells({ dry, seed });
  console.log(`\n${dry ? 'would write' : 'wrote'}: home cells ${r.homeCells} · cells made ${r.cellsMade} · blocked cells noted ${r.blocked} · pots stamped ${r.potsStamped} · pre-ticket rows linked to their spec ${r.potsLinked} · pots rows made ${r.potsMade}`);
  for (const m of r.missingSeed) console.log(`⚠ no Seeds row named "${m}"`);
  for (const m of report_lines(r)) console.log(m);
  process.exit(r.ambiguous.length ? 1 : 0);
}
function report_lines(r) { return [...r.unmatched.map((u) => `✗ ${u}`), ...r.ambiguous.map((a) => `✗ ${a}`)]; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
