// instructions-sync.mjs — the repo side of the dashboard's Generate-page editors.
//
// The dashboard's GitHub token is Actions-only by design (it can dispatch workflows, never read or
// commit code), so everything it edits flows through Airtable and this script commits it:
//
//   --apply        Airtable -> repo. Two kinds of edit, applied in one pass:
//                    FILES    the Instructions table's editable rule files (style/*.md). The
//                             operator-rules row is hash-checked against EXPECTED_HASH — a mismatch
//                             means a NEWER save landed after this dispatch, so it is skipped and
//                             that save's own dispatch commits it.
//                    SWITCHES the Switches table's boolean flags -> the matching `export const NAME
//                             = true|false;` line in config.mjs. Exact-line rewrite against an
//                             allowlist: an unknown name or a missing constant is an error, never a
//                             blind append, so this can only ever flip a flag that already exists.
//                  The workflow commits; this script never pushes.
//   --mark-synced  After the push lands, stamp Synced At (+ Sha/Value) so the dashboard's "syncing…"
//                  chips flip to "synced". Separate from --apply because a record must never claim
//                  synced before the commit actually landed.
//   --mirror       Repo -> Airtable (registry-sync step). Refreshes the read-only display copies
//                  and bootstraps missing rows. It NEVER overwrites a row with an edit in flight
//                  (Synced Sha != the row's current content hash), so a 4-hourly sync can't clobber
//                  something the operator just typed and hasn't committed yet.
//
// Env: AIRTABLE_PAT, REGISTRY_BASE_ID; --apply also reads EXPECTED_HASH, --mark-synced SYNCED_SHA.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const TABLE = 'Instructions';
const SWITCH_TABLE = 'Switches';
// Files the dashboard may WRITE. operator-rules is the human's own channel; learned-rules is the
// retro's file, editable here so the operator can prune a rule that is no longer earning its place
// (safe while the retro is paused — if it is ever resumed, the two writers race on append and this
// list should shrink back to operator-rules alone).
const EDITABLE_FILES = ['style/operator-rules.md', 'style/learned-rules.md'];
const HASHED_FILE = 'style/operator-rules.md'; // the one EXPECTED_HASH guards
// Display-only copies: shown on the Generate page, never written from it. COMMANDS.md is the
// operator's /command index (2026-09-02, farm toolkit) — dashboard-visible, repo-edited.
const MIRROR_FILES = ['style/thread-checklist.md', 'COMMANDS.md'];
// config.mjs boolean constants the dashboard may flip. Allowlist, not discovery: adding a switch is
// a deliberate code change here, so a new Airtable row can never reach an arbitrary constant.
const SWITCH_FILE = 'config.mjs';
const SWITCHES = ['ATTACH_MEDIA', 'SEND_STATE_DIGESTS', 'LINK_SENTINEL_AUTOFIX'];
const MAX_BYTES = 64 * 1024; // dispatch sanity cap — a rules file near this size is a broken save, not rules

const env = process.env;
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const ghOut = (k, v) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`); };

function at(table, path, init = {}) {
  return fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(table)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// Named listAll and, until 2026-08-30, it took ONE page and stopped — a silent hard cap at
// Airtable's 100-record page maximum, under a name that promises the opposite. Now it actually
// paginates. The 404/403 branch is unchanged and deliberate.
async function listAll(table) {
  const out = [];
  let offset;
  do {
    const r = await at(table, `?pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`);
    if (!r.ok) {
      // A missing Switches table is not fatal: the file editors still work, and the table appears the
      // first time --mirror bootstraps it.
      if (r.status === 404 || r.status === 403) return null;
      throw new Error(`${table} list -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  return out;
}

async function findRecord(file) {
  const p = new URLSearchParams({ filterByFormula: `{File} = '${file}'`, maxRecords: '1' });
  const r = await at(TABLE, `?${p}`);
  if (!r.ok) throw new Error(`Instructions list -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).records?.[0] || null;
}

// ---- files ----------------------------------------------------------------------------------
async function applyFiles() {
  const changed = [];
  for (const file of EDITABLE_FILES) {
    const rec = await findRecord(file);
    if (!rec) continue;
    const content = String(rec.fields.Content || '');
    const hash = sha256(content);
    if (file === HASHED_FILE && env.EXPECTED_HASH && env.EXPECTED_HASH !== hash) {
      // Expected race, not an error: a newer save already replaced the buffer and its own dispatch
      // will commit it. Committing here would ship a torn state.
      console.log(`::notice::${file} moved on (expected ${env.EXPECTED_HASH.slice(0, 12)}, found ${hash.slice(0, 12)}) — skipping; the newer save's run commits it.`);
      continue;
    }
    if (!content.trim()) throw new Error(`apply: ${file} record Content is empty — refusing to blank a rules file`);
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error(`apply: ${file} exceeds ${MAX_BYTES} bytes`);
    const next = content.endsWith('\n') ? content : content + '\n';
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (prev === next) continue;
    writeFileSync(file, next);
    changed.push(file);
    console.log(`Applied -> ${file} (${content.length} chars, sha ${hash.slice(0, 12)}…).`);
  }
  return changed;
}

// ---- switches -------------------------------------------------------------------------------
// The rewrite itself is pure and exported so the unit tests can prove the two properties that
// matter: it flips ONLY the named constant's line, and it refuses (throws) rather than guessing
// when that line is absent — a config.mjs rename must fail the run, not silently no-op while the
// dashboard reports the new state.
export const switchRe = (name) => new RegExp(`^(export const ${name} = )(true|false);$`, 'm');

export function flipSwitch(src, name, want) {
  const re = switchRe(name);
  const m = src.match(re);
  if (!m) throw new Error(`apply: ${SWITCH_FILE} has no "export const ${name} = true|false;" line`);
  const before = m[2] === 'true';
  if (before === !!want) return { src, changed: false, before };
  return { src: src.replace(re, `$1${!!want};`), changed: true, before };
}

async function applySwitches() {
  const rows = await listAll(SWITCH_TABLE);
  if (!rows) { console.log('No Switches table — skipping switch apply.'); return []; }
  let src = readFileSync(SWITCH_FILE, 'utf8');
  const changed = [];
  for (const rec of rows) {
    const name = String(rec.fields.Name || '').trim();
    if (!SWITCHES.includes(name)) {
      if (name) console.log(`::warning::Switch "${name}" is not on the allowlist — ignored.`);
      continue;
    }
    const want = !!rec.fields.Value;
    const res = flipSwitch(src, name, want);
    if (!res.changed) continue;
    src = res.src;
    changed.push(`${name}=${want}`);
    console.log(`Applied -> ${SWITCH_FILE} ${name} ${res.before} -> ${want}.`);
  }
  if (changed.length) writeFileSync(SWITCH_FILE, src);
  return changed;
}

async function apply() {
  const files = await applyFiles();
  const switches = await applySwitches();
  const all = [...files, ...switches];
  ghOut('applied', all.length ? 'true' : 'false');
  ghOut('summary', all.join(', ').slice(0, 200));
  if (!all.length) console.log('::notice::Nothing to apply — repo already matches the buffers.');
  return all;
}

// ---- synced stamps --------------------------------------------------------------------------
async function markSynced() {
  const now = new Date().toISOString();
  const updates = [];
  for (const file of EDITABLE_FILES) {
    const rec = await findRecord(file);
    if (!rec) continue;
    updates.push({ id: rec.id, fields: { 'Synced At': now, 'Synced Sha': sha256(String(rec.fields.Content || '')) } });
  }
  if (updates.length) {
    const r = await at(TABLE, '', { method: 'PATCH', body: JSON.stringify({ typecast: true, records: updates }) });
    if (!r.ok) throw new Error(`mark-synced PATCH -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const rows = await listAll(SWITCH_TABLE);
  if (rows?.length) {
    const sw = rows
      .filter((rec) => SWITCHES.includes(String(rec.fields.Name || '').trim()))
      .map((rec) => ({ id: rec.id, fields: { 'Synced At': now, 'Synced Value': !!rec.fields.Value } }));
    if (sw.length) {
      const r = await at(SWITCH_TABLE, '', { method: 'PATCH', body: JSON.stringify({ typecast: true, records: sw }) });
      if (!r.ok) throw new Error(`mark-synced switches -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  }
  console.log(`Stamped synced: ${updates.length} file row(s), ${rows?.length ?? 0} switch row(s).`);
}

// ---- mirror ---------------------------------------------------------------------------------
async function mirror() {
  const now = new Date().toISOString();
  // Display-only files: always refreshed, nothing edits them from the dashboard.
  const records = [];
  for (const file of MIRROR_FILES) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    records.push({ fields: { File: file, Content: content, Source: 'repo', 'Synced At': now, 'Synced Sha': sha256(content) } });
  }
  if (records.length) {
    const r = await at(TABLE, '', { method: 'PATCH', body: JSON.stringify({ typecast: true, performUpsert: { fieldsToMergeOn: ['File'] }, records }) });
    if (!r.ok) throw new Error(`mirror upsert -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  // Editable files: refresh from the repo ONLY when the row has no edit in flight, so a sync can
  // never overwrite something the operator typed but has not committed yet. A row whose Content
  // hash still matches Synced Sha is settled and safe to refresh (this is what keeps learned-rules
  // current when the retro appends to it).
  for (const file of EDITABLE_FILES) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    const hash = sha256(content);
    const rec = await findRecord(file);
    if (!rec) {
      const r = await at(TABLE, '', {
        method: 'POST',
        body: JSON.stringify({ typecast: true, records: [{ fields: { File: file, Content: content, Source: 'operator', 'Synced At': now, 'Synced Sha': hash } }] }),
      });
      if (!r.ok) throw new Error(`mirror bootstrap ${file} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
      console.log(`Bootstrapped ${file} row.`);
      continue;
    }
    const bufHash = sha256(String(rec.fields.Content || ''));
    if (bufHash !== String(rec.fields['Synced Sha'] || '')) { console.log(`${file}: edit in flight — mirror skipped.`); continue; }
    if (bufHash === hash) continue; // already identical
    const r = await at(TABLE, `/${rec.id}`, { method: 'PATCH', body: JSON.stringify({ typecast: true, fields: { Content: content, 'Synced At': now, 'Synced Sha': hash } }) });
    if (!r.ok) throw new Error(`mirror refresh ${file} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
    console.log(`Refreshed ${file} from repo.`);
  }
  // Switches: bootstrap each allowlisted flag from config.mjs, and refresh only settled rows (same
  // in-flight rule as the files above).
  const src = readFileSync(SWITCH_FILE, 'utf8');
  const rows = (await listAll(SWITCH_TABLE)) || [];
  const byName = new Map(rows.map((r) => [String(r.fields.Name || '').trim(), r]));
  const creates = [];
  const patches = [];
  for (const name of SWITCHES) {
    const m = src.match(new RegExp(`^export const ${name} = (true|false);$`, 'm'));
    if (!m) { console.log(`::warning::${SWITCH_FILE} has no ${name} constant — switch not mirrored.`); continue; }
    const real = m[1] === 'true';
    const rec = byName.get(name);
    if (!rec) { creates.push({ fields: { Name: name, Value: real, 'Synced At': now, 'Synced Value': real } }); continue; }
    const settled = !!rec.fields.Value === !!rec.fields['Synced Value'];
    if (!settled) { console.log(`Switch ${name}: edit in flight — mirror skipped.`); continue; }
    if (!!rec.fields.Value === real) continue;
    patches.push({ id: rec.id, fields: { Value: real, 'Synced At': now, 'Synced Value': real } });
  }
  if (creates.length) {
    const r = await at(SWITCH_TABLE, '', { method: 'POST', body: JSON.stringify({ typecast: true, records: creates }) });
    if (!r.ok) console.log(`::warning::switch bootstrap -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    else console.log(`Bootstrapped ${creates.length} switch row(s).`);
  }
  if (patches.length) {
    const r = await at(SWITCH_TABLE, '', { method: 'PATCH', body: JSON.stringify({ typecast: true, records: patches }) });
    if (!r.ok) console.log(`::warning::switch refresh -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    else console.log(`Refreshed ${patches.length} switch row(s) from ${SWITCH_FILE}.`);
  }
  console.log(`Mirror done: ${records.length} display file(s).`);
}

// CLI only when executed directly — the pure helpers above are imported by test-scaffolds, and an
// unguarded entrypoint would process.exit(0) the moment the tests imported this file.
if (process.argv[1] && process.argv[1].endsWith('instructions-sync.mjs')) {
  const mode = process.argv[2];
  if (!env.AIRTABLE_PAT || !env.REGISTRY_BASE_ID) { console.log('AIRTABLE_PAT / REGISTRY_BASE_ID missing — skipping.'); process.exit(0); }
  const run = { '--apply': apply, '--mark-synced': markSynced, '--mirror': mirror }[mode];
  if (!run) { console.error('usage: node instructions-sync.mjs --apply | --mark-synced | --mirror'); process.exit(2); }
  run().catch((e) => { console.error(e.message || e); process.exit(1); });
}
