#!/usr/bin/env node
// greenhouse-draft.mjs — put a pot in the greenhouse: the `[POT] <fruit> · <angle>` draft on the
// burner set, tagged `pot` + the fruit, its scratchpad leading with the Airtable links and
// carrying the DIALS TICKET, and (with --pots-row) the Pots row that makes the seed see it.
//
//   node greenhouse-draft.mjs queues/pots/mango-crossword.greenhouse.json            # create or patch
//   node greenhouse-draft.mjs queues/pots/mango-crossword.greenhouse.json --pots-row # + the Pots row
//   node greenhouse-draft.mjs <files...> --dry                                      # say, do nothing
//
// The spec is the record: this writes `greenhouseDraft` (share URL), `greenhouseDraftId` (the numeric
// id — the share slug is NOT the id, and patchDraft 422s on it) and `potRecId` back into the file.
// A pot that fails pot-gate is refused: the greenhouse is where the operator reads, and a draft that
// cannot plant wastes their read. --force publishes anyway and says so.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, typefully, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { buildPlatforms } from './platforms.mjs';
import { gatePot } from './pot-gate.mjs';
import { cellOf, ticketText, cellName, ensureCell } from './cells-sync.mjs';
import { TBL } from './config.mjs';
import { readConfigFile } from './lib/config-file.mjs';

// The staging set (config/engine.json `burner.socialSetId`); 0 when none is configured.
const BURNER = readConfigFile('engine').burner?.socialSetId || 0;
const TABLES = { Seeds: TBL.seeds, Harvests: TBL.harvests, Pots: TBL.pots };

function angleOf(file, spec) {
  if (spec.angle) return spec.angle;
  const base = file.split('/').pop().replace('.greenhouse.json', '');
  return base.includes('-') ? base.slice(base.indexOf('-') + 1) : base;
}

function originMeta(seedRecId) {
  const p = join(HERE_DIR, 'queues', 'origins', `${seedRecId}.json`);
  if (!seedRecId || !existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

export function renderScratchpad(spec, { base, angle, potRecId = null, harvestId = null }) {
  const air = (tbl, id) => `https://airtable.com/${base}/${tbl}/${id}`;
  const lines = ['AIRTABLE'];
  if (potRecId) lines.push(`· Pot record:     ${air(TABLES.Pots, potRecId)}`);
  if (spec.seedRecId) lines.push(`· Seed record:    ${air(TABLES.Seeds, spec.seedRecId)}`);
  if (harvestId) lines.push(`· Source harvest: ${air(TABLES.Harvests, harvestId)}`);
  if (spec.originPost) lines.push(`· Origin post:    ${spec.originPost}`);
  lines.push('');
  lines.push(`POT · ${spec.potOf} v${spec.seedVersion ?? '?'} · ${angle}`);
  lines.push('Status: GREENHOUSE');
  const dials = Array.isArray(spec.dials) ? spec.dials : null;
  lines.push(`DIALS: ${dials ? (dials.length ? dials.map((d) => `${d.dial} · ${d.from} → ${d.to}`).join(' | ') : 'control — 0 dials turned, the dish as-is') : 'NO TICKET'}`);
  lines.push('');
  lines.push('PRODUCTS');
  for (const p of spec.products || []) lines.push(`· ${p.slot ? `[${p.slot}] ` : ''}${p.asin} — ${p.title || ''}`);
  if (spec.variables && typeof spec.variables === 'object') {
    lines.push('');
    lines.push('VARIABLES');
    for (const [k, v] of Object.entries(spec.variables)) lines.push(`· ${k}: ${v}`);
  }
  if (spec._note) { lines.push(''); lines.push(`NOTE · ${spec._note}`); }
  return lines.join('\n');
}

/** A Typefully tag has to exist on the set before a draft can carry it. Exported 2026-09-22 so the
 *  /run review drafts (scripts/run-review-drafts.mjs), which write to this same burner set, reuse it
 *  rather than keep a second copy of the rule. */
export async function ensureTags(tf, names, socialSetId = BURNER) {
  for (const name of names) {
    try { await tf.post(`/social-sets/${socialSetId}/tags`, { name }); } catch { /* exists, or the endpoint refused — the draft call reports */ }
  }
}

async function one(file, { dry, potsRow, force, env, tf, at }) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const angle = angleOf(file, spec);
  const gate = gatePot(spec, { origin: originMeta(spec.seedRecId).tweets || null });
  if (!gate.ok && !force) {
    console.log(`✗ ${file}: fails pot-gate — not sent. ${[...gate.errors, ...gate.hard].join(' | ')}`);
    return false;
  }
  if (!gate.ok) console.log(`⚠ ${file}: sent with --force over ${gate.errors.length + gate.hard.length} gate finding(s)`);
  const title = `[POT] ${spec.potOf} · ${angle}`;
  const burner = getAccount('burner');
  const posts = (spec.tweets || []).map((t) => ({ text: String(t) }));
  const harvestId = originMeta(spec.seedRecId).harvestId || null;
  const base = env.REGISTRY_BASE_ID;
  const tags = ['pot', String(spec.potOf)];

  if (dry) {
    console.log(`— ${file}\n  ${spec.greenhouseDraftId ? `would PATCH draft ${spec.greenhouseDraftId}` : 'would CREATE'} "${title}" · tags ${tags.join(', ')} · ${posts.length} tweets${potsRow ? ` · ${spec.potRecId ? 'Pots row exists' : 'would create the Pots row'}` : ''}`);
    return true;
  }

  await ensureTags(tf, tags);
  const body = { draft_title: title, tags, platforms: buildPlatforms(posts, { account: burner }) };
  let id = spec.greenhouseDraftId ? Number(spec.greenhouseDraftId) : null;
  let shareUrl = spec.greenhouseDraft || null;
  if (id) {
    await tf.patchDraft(BURNER, id, { ...body, scratchpad_text: renderScratchpad(spec, { base, angle, potRecId: spec.potRecId, harvestId }) });
  } else {
    const d = await tf.createDraft(BURNER, { ...body, share: true, scratchpad_text: renderScratchpad(spec, { base, angle, harvestId }) });
    id = d.id; shareUrl = d.share_url || shareUrl;
    spec.greenhouseDraftId = id; spec.greenhouseDraft = shareUrl;
    writeFileSync(file, JSON.stringify(spec, null, 1) + '\n');
  }

  if (potsRow && !spec.potRecId) {
    const dials = Array.isArray(spec.dials) ? spec.dials : [];
    const variables = { ...(spec.variables || {}), dials: dials.length ? dials.map((d) => `${d.dial}: ${d.from} → ${d.to}`).join(' | ') : 'control' };
    const fields = {
      Name: `${spec.potOf} · ${angle}`,
      Seed: [spec.seedRecId],
      Status: 'Potted',
      Angle: angle,
      'Greenhouse Draft': shareUrl,
      Version: Number(spec.seedVersion) || 1,
      Products: (spec.products || []).map((p) => `${p.slot ? `[${p.slot}] ` : ''}${p.title || p.asin}`).join(' · '),
      Variables: Object.entries(variables).map(([k, v]) => `${k}: ${v}`).join('\n'),
      'Potted At': new Date().toISOString().slice(0, 10),
    };
    // The ticket puts the pot in exactly one seed × dial cell (Cells table, cells-sync.mjs): the row
    // is born in its cell so the cell's count, chances and money read it from the first plant.
    {
      const dial = cellOf(dials);
      const cellRows = await at.listAll('Cells', { fields: ['Cell', 'Dial', 'Seed', 'Home'] });
      const cells = new Map(cellRows.map((c) => [c.fields.Cell, c]));
      const homes = existsSync(join(HERE_DIR, 'docs', 'seed-dials', 'home-cells.json')) ? JSON.parse(readFileSync(join(HERE_DIR, 'docs', 'seed-dials', 'home-cells.json'), 'utf8')) : {};
      const cell = await ensureCell({ at, env, base, cells, seedRow: { id: spec.seedRecId, fields: { Name: spec.potOf } }, dial, home: dial === '2 dials' ? 'two dials moved' : (homes[spec.potOf] || {})[dial], dry: false });
      Object.assign(fields, { Dial: dial, Ticket: ticketText(dials), Cell: [cell.id] });
      if (!cellRows.some((c) => c.fields.Cell === cellName(spec.potOf, dial))) console.log(`  + Cells row ${cellName(spec.potOf, dial)}`);
    }
    // lib's create() returns a count, not the rows, so the new id has to come from the API itself.
    const r = await fetch(`https://api.airtable.com/v0/${base}/${TABLES.Pots}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, records: [{ fields }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Pots create -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    const rec = (j.records || [])[0];
    if (rec?.id) {
      spec.potRecId = rec.id;
      writeFileSync(file, JSON.stringify(spec, null, 1) + '\n');
      await tf.patchDraft(BURNER, id, { scratchpad_text: renderScratchpad(spec, { base, angle, potRecId: rec.id, harvestId }) });
    }
  }
  console.log(`✓ ${title} · draft ${id} · ${shareUrl}${spec.potRecId ? ` · Pots ${spec.potRecId}` : ''}`);
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => a.endsWith('.json'));
  if (!files.length) { console.error('need one or more pot files'); process.exitCode = 2; return; }
  const dry = argv.includes('--dry'), potsRow = argv.includes('--pots-row'), force = argv.includes('--force');
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const tf = typefully(env);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  let bad = 0;
  for (const f of files) {
    try { if (!(await one(f, { dry, potsRow, force, env, tf, at }))) bad++; }
    catch (e) { console.log(`✗ ${f}: ${e.message}`); bad++; }
  }
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
