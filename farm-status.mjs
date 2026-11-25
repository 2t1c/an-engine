// farm-status.mjs — the farm, in one read. Everything /farm answers comes from here: the pool by
// tier with hearts and performs, the Potential watchlist, the Seed-Eligible queue waiting on the
// operator, the seeds and their pots, active cooldowns, expiry clocks, and the phase checkpoint
// (has any pot performed yet — the /farm one-liner the Run-3 rollout gate asks for).
//
// READ-ONLY by construction: no Airtable write, no state file, no Telegram. harvest-gate.mjs is
// the actor; this is the console. Numbers come from the same fields the gate reads, so the two can
// never disagree about what the base holds — but this file re-derives NO verdicts: what it prints
// under Performs/Verdict is what the gate has actually written, lag included.
//
//   node farm-status.mjs             # the human console
//   node farm-status.mjs --json      # machine-readable (skills, checkpoint queries)
//   node farm-status.mjs --checkpoint  # ONE line: the Run-3 gate (any pot Performed?)
//   node farm-status.mjs --pots [family]   # EVERY pot fleet-wide, one flat list with links —
//     the high-level search Typefully cannot do (its queues are per-account; the operator's ask,
//     2026-09-02). Optionally filtered to one seed family.
import { isThreadRow } from './monitoring-scope.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, HERE_DIR, runMain } from './lib.mjs';
import { DIALS as CELLS_DIALS } from './cells-sync.mjs';
import { LAWS } from './laws.mjs';
import { REGISTRY_TABLE } from './config.mjs';

const JSON_OUT = process.argv.includes('--json');
const CHECKPOINT = process.argv.includes('--checkpoint');
const POTS_I = process.argv.indexOf('--pots');
const POTS = POTS_I > -1;
const POTS_FAMILY = POTS && process.argv[POTS_I + 1] && !process.argv[POTS_I + 1].startsWith('--') ? process.argv[POTS_I + 1].toLowerCase() : null;
const CELLS_I = process.argv.indexOf('--cells');
const CELLS = CELLS_I > -1;
const CELLS_FAMILY = CELLS && process.argv[CELLS_I + 1] && !process.argv[CELLS_I + 1].startsWith('--') ? process.argv[CELLS_I + 1].toLowerCase() : null;
// Derived — see pot-gate's COLUMNED for why this list is not written out by hand any more.
const CELL_ORDER = CELLS_DIALS;

/** Pure: Cells rows (one per seed × dial, kept by cells-sync.mjs) -> the per-seed read. A cell is
 *  read against its seed's control cell, never against the origin; the verdict is the table's own
 *  formula (open · readable · winner · closed), so the console re-derives nothing. The one verdict
 *  this model owns is `blocked`: a dial the seed's own mechanics forbid, written into the row's
 *  Operator Note by cells-sync from docs/seed-dials/blocked-cells.json, so an empty cell that owes
 *  no pots never reads as work waiting. */
export function cellsModel(cellRows = []) {
  const bySeed = new Map();
  for (const r of cellRows) {
    const f = r.fields || r;
    const [seed, dial] = String(f.Cell || '').split(' · ');
    if (!seed || !dial) continue;
    const perK = f['$ / 1k Views'];
    // A cell whose Operator Note opens with `blocked —` is a dial this seed cannot turn without
    // stopping being itself (cells-sync writes it from docs/seed-dials/blocked-cells.json). It owes
    // no pots, so it must never read as `open` and must never be counted as work waiting.
    const note = String(f['Operator Note'] || '');
    const isBlocked = /^blocked\s*[—-]/i.test(note);
    const cell = {
      dial, pots: Number(f['Pots #'] || 0), needs: Number(f.Needs || (dial === 'topic' ? 4 : 2)),
      chances: Number(f.Chances || 0), performs: Number(f.Performs || 0), views: Number(f.Views || 0), commission: Number(f.Commission || 0),
      perK: perK == null || perK === '' ? null : Number(perK),
      verdict: isBlocked && !Number(f['Pots #'] || 0) ? 'blocked' : String(f.Verdict || ''),
      blocked: isBlocked, why: isBlocked ? note.replace(/^blocked\s*[—-]\s*/i, '') : null,
    };
    if (!bySeed.has(seed)) bySeed.set(seed, []);
    bySeed.get(seed).push(cell);
  }
  return [...bySeed.entries()].map(([seed, cells]) => {
    cells.sort((a, b) => CELL_ORDER.indexOf(a.dial) - CELL_ORDER.indexOf(b.dial));
    const control = cells.find((c) => c.dial === 'control') || null;
    const singles = cells.filter((c) => c.dial !== 'control');
    const count = (v) => singles.filter((c) => c.verdict === v).length;
    return { seed, control, cells, winners: count('winner'), readable: count('readable'), open: count('open'), closed: count('closed'), blocked: count('blocked'), pots: cells.reduce((n, c) => n + c.pots, 0) };
  }).sort((a, b) => a.seed.localeCompare(b.seed));
}

// GREENHOUSE INVENTORY (owner 2026-09-22). `potsFired` below counts PLANTS — Published Content rows
// that already shipped — so a family sitting on four written, unplanted pots reads exactly like one
// with nothing left to plant. The run brief's supply table needs the other half, and asking for it
// is what the brief used to answer with a flat "unknown".
//
// The Pots table is that index (Seed -> Pots -> Plants, 2026-09-02). Status runs
// Potted -> Approved -> Planted, with Retired off to the side; `Version` is the seed version the pot
// was filled against, so a pot written before a seed revision is stock we own but must not plant as
// if it were current.
//
// Everything here refuses to guess. A pot whose status or version cannot be read is UNRESOLVED and
// is named in `flags`; it is never counted as ready stock, and never rounded down to zero either.
const POT_UNPLANTED = new Set(['Potted', 'Approved']);
const POT_KNOWN = new Set([...POT_UNPLANTED, 'Planted', 'Retired']);

/** Pure: one seed's Pots rows -> what is actually plantable. `pots` of null/undefined means the
 *  table was NOT read, which is unverified, not empty. Exported so the brief and its tests share
 *  one definition of "unused current-version pot" instead of restating it. */
export function greenhouseInventory(seedVersion, pots) {
  if (!Array.isArray(pots)) {
    return { status: 'unverified', currentVersion: seedVersion ?? null, unusedCurrentVersion: null,
      outdated: null, planted: null, retired: null, unresolved: null,
      flags: ['Pots table not read; greenhouse inventory is unknown, not zero'] };
  }
  const out = { status: 'verified', currentVersion: seedVersion ?? null, unusedCurrentVersion: 0,
    outdated: 0, planted: 0, retired: 0, unresolved: 0, flags: [] };
  const flag = (message) => { if (!out.flags.includes(message)) out.flags.push(message); };
  for (const pot of pots) {
    const status = pot?.fields?.Status;
    const version = pot?.fields?.Version;
    if (status === 'Planted') { out.planted++; continue; }
    if (status === 'Retired') { out.retired++; continue; }
    if (!POT_KNOWN.has(status)) {
      out.unresolved++;
      flag(`pot status ${JSON.stringify(status ?? null)} is outside the known Pots statuses`);
      continue;
    }
    // Unplanted from here. Without both versions the current/outdated split is not knowable, and
    // guessing it either strands good stock or plants a pot against a skeleton it was not filled for.
    if (seedVersion == null) { out.unresolved++; flag('seed has no Version; cannot tell current pots from outdated ones'); continue; }
    if (version == null) { out.unresolved++; flag('pot has no Version; cannot tell whether it matches the seed'); continue; }
    if (version === seedVersion) out.unusedCurrentVersion++;
    else out.outdated++;
  }
  if (out.unresolved) out.status = 'partial';
  return out;
}

// HARVEST CAPACITY (owner 2026-09-22). The brief asks the owner to set a harvest share before
// anything has told them whether the pool can fill it. That is not hypothetical: laws.json
// `farm.$phase5` records the run where it went wrong — "pool-probe on 09-17 returned 11 runnable of
// 27 bodies, and four of those eleven sit at zero hearts, so only SEVEN bodies could take a heart
// at all; against the 24h cooldown that is 7 x 3 days = 21 body-days total, and a 30% harvest share
// wanted 20 of them". The mix had to be rewritten afterwards.
//
// A harvest slot is a BODY-DAY, not a body. Three constraints bound it and all three are already in
// the model: `heartsLeft` caps a body's remaining attempts for good, `farm.cooldownHours` stops the
// same body running twice fleet-wide inside a day, and hearts expire on a date.
//
// This is a CEILING, read from Airtable alone. It cannot see whether today's gates still accept a
// body — only pool-probe.mjs republishes each one to find that out, and it routinely refuses more
// than half. Never present this as the runnable number.
export function harvestCapacity(pool, { dates = [], now = Date.now(), farm = LAWS.farm } = {}) {
  if (!Array.isArray(pool)) {
    return { status: 'unverified', bodyDays: null, bodies: null, dates: dates.length,
      flags: ['Harvest pool not read; capacity is unknown, not zero'] };
  }
  const runDays = dates.filter((date) => /^\d{4}-\d\d-\d\d$/.test(String(date))).sort();
  if (runDays.length !== dates.length) {
    return { status: 'unverified', bodyDays: null, bodies: null, dates: dates.length,
      flags: ['Run dates are missing or malformed; harvest capacity needs them to count body-days'] };
  }
  const flags = [];
  const endOf = (date) => Date.parse(`${date}T23:59:59+07:00`);
  let bodyDays = 0, bodies = 0, cooldownBlocked = 0, expiryBlocked = 0, spent = 0;
  for (const body of pool) {
    const heartsLeft = Number(body?.heartsLeft ?? 0);
    if (!(heartsLeft > 0)) { spent++; continue; }
    const coolUntil = body?.cooldownUntil ? Date.parse(body.cooldownUntil) : 0;
    const expires = body?.expiresAt ? Date.parse(`${body.expiresAt}T23:59:59+07:00`) : Infinity;
    const usable = runDays.filter((date) => endOf(date) > coolUntil && endOf(date) <= expires);
    if (!usable.length) {
      if (coolUntil && runDays.every((date) => endOf(date) <= coolUntil)) cooldownBlocked++;
      else expiryBlocked++;
      continue;
    }
    if (usable.length < runDays.length) {
      if (coolUntil > endOf(runDays[0])) cooldownBlocked++; else expiryBlocked++;
    }
    bodies++;
    bodyDays += Math.min(heartsLeft, usable.length);
  }
  if (spent) flags.push(`${spent} pool body(ies) have no hearts left`);
  if (cooldownBlocked) flags.push(`${cooldownBlocked} body(ies) lose day(s) to the ${farm.cooldownHours}h cooldown`);
  if (expiryBlocked) flags.push(`${expiryBlocked} body(ies) lose day(s) to heart expiry`);
  flags.push('Ceiling only: the gate screen (pool-probe.mjs) has not run, and it refuses bodies this cannot see');
  return { status: 'ceiling', bodyDays, bodies, dates: runDays.length, cooldownBlocked, expiryBlocked, spent, flags };
}

/** Pure: raw table reads -> the console's model. Exported so tests pin the derivations
 *  (cooldown windows, expiry buckets, the checkpoint) without a network.
 *  `potRows` is the optional Pots table read; omitting it leaves every existing caller's output
 *  unchanged and reports greenhouse inventory as unverified rather than inventing a zero. */
export function farmModel({ harvests = [], seeds = [], pcRows = [], potRows = null, ledgerRows = [], now = Date.now(), farm = LAWS.farm } = {}) {
  const attemptsByHarvest = new Map();
  const potsBySeed = new Map();
  const greenhouseBySeed = new Map();
  for (const r of pcRows) {
    for (const hid of r.harvestIds || []) { if (!attemptsByHarvest.has(hid)) attemptsByHarvest.set(hid, []); attemptsByHarvest.get(hid).push(r); }
    for (const sid of r.seedIds || []) { if (!potsBySeed.has(sid)) potsBySeed.set(sid, []); potsBySeed.get(sid).push(r); }
  }
  if (Array.isArray(potRows)) {
    for (const pot of potRows) {
      for (const sid of (pot?.fields?.Seed || [])) {
        if (!greenhouseBySeed.has(sid)) greenhouseBySeed.set(sid, []);
        greenhouseBySeed.get(sid).push(pot);
      }
    }
  }
  // Active cooldowns: the most recent fleet-wide post per body (ledger sourceDraftId), inside the
  // window — the "who can I NOT attempt right now" answer /run and /attempt need before minting.
  const lastPostBySource = new Map();
  for (const e of ledgerRows) {
    if (!e?.sourceDraftId) continue;
    const t = Date.parse(e.publishAt || e.ts || ''); // publishAt = the reader's clock, the one the law is written in
    if (!Number.isFinite(t)) continue;
    const k = String(e.sourceDraftId);
    if (t > (lastPostBySource.get(k)?.t || 0)) lastPostBySource.set(k, { t, account: e.account });
  }
  const bodies = harvests.map((h) => {
    const attempts = attemptsByHarvest.get(h.id) || [];
    const performs = attempts.filter((a) => a.verdict === 'Performed').length;
    const pending = attempts.filter((a) => !a.verdict || a.verdict === 'Pending').length;
    const cool = lastPostBySource.get(String(h.fields['Origin Draft ID'] || ''));
    const coolUntil = cool ? cool.t + farm.cooldownHours * 3600e3 : 0;
    const expiresAt = h.fields['Expires At'] ? Date.parse(h.fields['Expires At']) : null;
    return {
      id: h.id,
      body: String(h.fields.Body || '').slice(0, 60),
      originDraftId: String(h.fields['Origin Draft ID'] || ''),
      account: h.fields['Origin Account'] || '?',
      status: h.fields.Status || '?',
      tier: h.fields.Tier || '?',
      // THE seed-selection metric (operator ruling 2026-09-02: "this is exactly the metric we
      // optimize for"). Intent density, not reach: a pot inherits the shape's $/1k, and the
      // fleet manufactures the views. Reach monsters audition; dense shapes templatize.
      perK: Number(((h.fields['Origin Commission'] || 0) / ((h.fields['Origin Views'] || 1) / 1000)).toFixed(3)),
      heartsUsed: attempts.length,
      heartsLeft: Math.max(0, farm.hearts - attempts.length),
      performs, pending,
      cooldownUntil: coolUntil > now ? new Date(coolUntil).toISOString() : null,
      lastRanOn: cool?.account || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : null,
      expiresInDays: expiresAt ? Math.ceil((expiresAt - now) / 864e5) : null,
      url: h.fields['Origin X URL'] || null,
    };
  });
  const seedRows = seeds.map((s) => {
    const pots = potsBySeed.get(s.id) || [];
    return {
      id: s.id,
      name: String(s.fields.Name || '?'),
      emoji: s.fields.Emoji || '',
      status: s.fields.Status || '?',
      version: s.fields.Version ?? null,
      potsFired: pots.length,
      potPerforms: pots.filter((p) => p.verdict === 'Performed').length,
      potsPending: pots.filter((p) => !p.verdict || p.verdict === 'Pending').length,
      // What is written and still in the greenhouse, as opposed to what has already shipped above.
      greenhouse: greenhouseInventory(s.fields.Version ?? null, Array.isArray(potRows) ? (greenhouseBySeed.get(s.id) || []) : null),
    };
  });
  const inPool = bodies.filter((b) => b.status === 'In Pool');
  // A BODY THAT ALREADY HAS A SEED IS NOT WAITING ON /seed-mint (2026-09-19). A Harvests row only
  // leaves Seed-Eligible when the operator marks it Seeded by hand — step 7 of the skill, and the
  // one step of the sacred event nothing enforces. So a body stayed in "waiting on YOU" after its
  // seed had been minted AND approved, and the queue went on asking for work that was done.
  // It cost a duplicate: `cedar` was minted from recGwfmCRVXsBTEIb on 2026-09-19 against a
  // still-listed flag, and `ginger` had been Approved from that same row already. The Seeds table
  // is the answer and it was already loaded here for the SEEDS section — this just reads it.
  const seededFrom = new Map();
  for (const s of seeds) for (const h of (s.fields['Source Harvest'] || [])) {
    if (!seededFrom.has(h)) seededFrom.set(h, []);
    seededFrom.get(h).push({ name: String(s.fields.Name || '?'), emoji: s.fields.Emoji || '', status: s.fields.Status || '?' });
  }
  const eligible = bodies.filter((b) => b.status === 'Seed-Eligible');
  const withSeed = (b) => ({ ...b, seeds: seededFrom.get(b.id) || [] });
  return {
    // Sorted by $/1k — the operator's ruling makes intent density the pool's reading order.
    pool: inPool.sort((a, b) => b.perK - a.perK),
    potential: bodies.filter((b) => b.status === 'Potential'),
    // Waiting on the mint: no seed points at it yet.
    seedEligible: eligible.filter((b) => !seededFrom.has(b.id)).map(withSeed),
    // Already minted, and waiting only for the Harvests row to be marked Seeded.
    seededAwaitingGraduation: eligible.filter((b) => seededFrom.has(b.id)).map(withSeed),
    other: bodies.filter((b) => !['In Pool', 'Potential', 'Seed-Eligible'].includes(b.status)),
    seeds: seedRows,
    cooling: bodies.filter((b) => b.cooldownUntil),
    expiring: inPool.filter((b) => b.expiresInDays != null && b.expiresInDays <= 7),
    // The rollout gate before Run 3 (operator-overridable): has ANY pot cleared its provisional?
    checkpoint: { potPerformed: seedRows.some((s) => s.potPerforms > 0), potsFired: seedRows.reduce((n, s) => n + s.potsFired, 0) },
  };
}

/** PURE. The registry rows the farm is made of: threads only. A harvest attempt and a pot are runs of
 *  thread bodies, so a single or a native X Article (owner, R2026-10-03: articles are additive) never
 *  spends a heart or fires a pot here. */
export function farmPcRows(records) {
  return records.filter((r) => isThreadRow(r)).map((r) => ({
    draftId: String(r.fields['Draft ID'] || ''), harvestIds: r.fields.Harvest || [], seedIds: r.fields.Seed || [], verdict: r.fields['Attempt Verdict'] || null,
    post: r.fields.Post || '', account: r.fields.Account || '?', status: r.fields.Status || '?', batch: r.fields.Batch || '', link: r.fields['Typefully Link'] || '', postedAt: r.fields['Posted Date'] || null,
  }));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const harvests = await at.listAll('Harvests');
  const seeds = await at.listAll('Seeds');
  let cellRows = [];
  try { cellRows = await at.listAll('Cells', { fields: ['Cell', 'Pots #', 'Needs', 'Chances', 'Performs', 'Views', 'Commission', '$ / 1k Views', 'Verdict', 'Operator Note'] }); }
  catch (e) { console.error(`(cells: ${e.message} — the Cells table is kept by cells-sync.mjs; the console runs without it)`); }
  const pc = await at.listAll(REGISTRY_TABLE, { fields: ['Type', 'Draft ID', 'Harvest', 'Seed', 'Attempt Verdict', 'Post', 'Account', 'Status', 'Batch', 'Typefully Link', 'Posted Date'] });
  const pcRows = farmPcRows(pc);
  const lf = join(HERE_DIR, 'ledger.jsonl');
  const ledgerRows = existsSync(lf) ? readFileSync(lf, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const m = farmModel({ harvests, seeds, pcRows, ledgerRows });
  m.cells = cellsModel(cellRows);

  if (CELLS) {
    // The dials read: every seed × dial cell with its pots, chances, performs and money, read against the seed's control.
    const fam = m.cells.filter((s) => !CELLS_FAMILY || s.seed === CELLS_FAMILY);
    console.log(`\nCELLS — ${fam.reduce((n, s) => n + s.cells.length, 0)} cell(s) on ${fam.length} seed(s)  (pots/needs · chances · performs · $/1k · verdict, read against the seed's control)\n`);
    for (const s of fam) {
      const ctl = s.control ? `${s.control.pots} pot(s)${s.control.perK != null ? ` · $${s.control.perK.toFixed(2)}/1k` : ''}` : 'none';
      console.log(`  ${s.seed}  ·  control ${ctl}  ·  ${s.winners} winner(s) · ${s.readable} readable · ${s.open} open · ${s.closed} closed${s.blocked ? ` · ${s.blocked} blocked` : ''}`);
      for (const c of s.cells) console.log(`     ${c.dial.padEnd(10)} ${c.blocked && !c.pots ? '  —  ' : `${String(c.pots).padStart(2)}/${c.needs}`}  chances ${String(c.chances).padStart(2)}  perf ${c.performs}  ${c.perK == null ? '     —' : ('$' + c.perK.toFixed(2)).padStart(6)}  ${c.verdict}${c.blocked ? ` — ${c.why.slice(0, 64)}` : ''}`);
      console.log('');
    }
    if (!fam.length) console.log('  (no Cells rows — node cells-sync.mjs writes them from the pot specs)');
    return;
  }
  if (POTS) {
    // One flat list across every account: the search Typefully's per-set queues cannot give.
    const seedById = new Map(seeds.map((s) => [s.id, s.fields]));
    const pots = pcRows.filter((r) => r.seedIds.length).map((r) => ({ ...r, family: (seedById.get(r.seedIds[0])?.Name || '?').toLowerCase(), emoji: seedById.get(r.seedIds[0])?.Emoji || '' }))
      .filter((r) => !POTS_FAMILY || r.family === POTS_FAMILY)
      .sort((a, b) => a.family.localeCompare(b.family) || String(b.postedAt || '').localeCompare(String(a.postedAt || '')));
    console.log(`\nPOTS — ${pots.length} fleet-wide${POTS_FAMILY ? ` in family "${POTS_FAMILY}"` : ''}  (verdict · status · batch)\n`);
    for (const p of pots) console.log(`  ${(p.emoji + ' ' + p.family).padEnd(13)} ${String(p.verdict || 'unjudged').padEnd(10)} ${String(p.status).padEnd(10)} ${String(p.batch || '—').padEnd(12)} ${String(p.account).padEnd(16)} ${String(p.post).slice(0, 44).padEnd(45)} ${p.link}`);
    if (!pots.length) console.log('  (none yet — a pot appears here the sync after /pot ships it; the Seeds row\'s Pots field lists the same set)');
    return;
  }
  if (CHECKPOINT) {
    console.log(m.checkpoint.potPerformed
      ? `✅ checkpoint clear: at least one pot has Performed (${m.checkpoint.potsFired} fired) — Run 3 may advance to the 40/30/30 mix`
      : `⛔ checkpoint NOT met: ${m.checkpoint.potsFired} pot(s) fired, none Performed yet — hold Run 3 at 50/30/20 unless the operator overrides`);
    return;
  }
  if (JSON_OUT) { console.log(JSON.stringify(m, null, 1)); return; }

  const f = LAWS.farm;
  const heartBar = (b) => `${'♥'.repeat(b.performs)}${'♡'.repeat(Math.max(0, b.heartsUsed - b.performs))}${'·'.repeat(b.heartsLeft)}`;
  console.log(`\nTHE FARM — ${new Date().toISOString().slice(0, 16)}Z  (gate: ${f.gateViews / 1000}K+$${f.gateCommission} | ${f.gateViews / 1000}K+${f.gateClicks}c | ${f.gateViews / 1000}K+${f.gateTypefullyClicks}tf | $${f.gateStraightCommission} · ${f.hearts} hearts · ${f.performsToSeed} performs → seed)\n`);
  const line = (b) => `  $${b.perK.toFixed(2).padStart(5)}/1k ${String(b.tier).padEnd(9)} ${heartBar(b).padEnd(9)} ${String(b.account).padEnd(16)} ${b.body}${b.cooldownUntil ? '  🧊' : ''}${b.expiresInDays != null && b.expiresInDays <= 7 ? `  ⌛${b.expiresInDays}d` : ''}`;
  console.log(`POOL — ${m.pool.length} body(ies) auditioning, densest intent first  (♥ performed · ♡ spent · • left)`);
  for (const b of m.pool) console.log(line(b));
  if (m.seedEligible.length) {
    console.log(`\n🌱 SEED-ELIGIBLE — ${m.seedEligible.length} waiting on YOU (run /seed-mint)`);
    for (const b of m.seedEligible) console.log(line(b));
  }
  // Minted already. The only thing left is the Harvests row, and saying so is what stops the
  // queue asking twice for a seed that exists.
  if (m.seededAwaitingGraduation.length) {
    console.log(`\n🌾 ALREADY SEEDED — ${m.seededAwaitingGraduation.length} minted; mark the Harvests row Seeded to clear it`);
    for (const b of m.seededAwaitingGraduation) {
      console.log(`${line(b)}\n${' '.repeat(22)}↳ ${b.seeds.map((x) => `${x.emoji} ${x.name} (${x.status})`).join(', ')}`);
    }
  }
  if (m.potential.length) {
    console.log(`\nPOTENTIAL WATCH — ≥$${f.potentialFloor}, not yet across; auto-promotes`);
    for (const b of m.potential) console.log(line(b));
  }
  if (m.seeds.length) {
    console.log(`\nSEEDS`);
    for (const s of m.seeds) console.log(`  ${(s.emoji + ' ' + s.name).padEnd(14)} ${String(s.status).padEnd(9)} v${s.version ?? '?'} · ${s.potsFired} pot(s) fired · ${s.potPerforms} performed · ${s.potsPending} pending`);
    if (m.cells.length) {
      console.log(`\nCELLS  (each seed's dial cells: winners · readable · open · closed — node farm-status.mjs --cells [family] for the grid)`);
      for (const s of m.cells) {
        const ctl = s.control ? `${s.control.pots}${s.control.perK != null ? ` · $${s.control.perK.toFixed(2)}/1k` : ''}` : '—';
        console.log(`  ${s.seed.padEnd(8)} control ${ctl.padEnd(14)} ${s.winners} winner(s) · ${s.readable} readable · ${s.open} open · ${s.closed} closed${s.blocked ? ` · ${s.blocked} blocked` : ''}  ·  ${s.pots} pots`);
      }
    }
  }
  if (m.cooling.length) console.log(`\n🧊 COOLDOWNS — ${m.cooling.map((b) => `${b.body.slice(0, 30)} (until ${b.cooldownUntil.slice(11, 16)}Z, last on ${b.lastRanOn})`).join(' · ')}`);
  if (m.other.length) console.log(`\nPAST THE POOL — ${m.other.map((b) => `${b.status}: ${b.body.slice(0, 36)}`).join(' · ')}`);
  console.log(`\nCHECKPOINT (pre-Run-3): ${m.checkpoint.potPerformed ? '✅ a pot has performed' : `⛔ ${m.checkpoint.potsFired} pot(s) fired, none performed yet`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'farm-status');
