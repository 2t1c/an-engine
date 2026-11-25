// airtable-schema.mjs — what the registry base's schema is SUPPOSED to look like, and the check
// that notices when it stops looking like that.
//
// Exists because the base had no mechanism to move forward with the repo. lanes.mjs renamed the
// three lanes on 2026-08-29 (cover/harvest/seed); the base kept 'Recreation' and 'Harvest
// Variation' select options, 'Mold ID/Name/Status' columns and a Typefully Link formula that
// builds the members-only ?d= URL — for days, silently, because no process owned noticing. The
// operator noticed instead ("the Airtable is kind of lagging behind because there's no mechanism
// to update it forward"). This file is that mechanism.
//
// It DETECTS and REPORTS, it does not auto-rename. Two reasons:
//   1. The public API cannot rename select options or reliably migrate a formula — those are
//      UI-only edits, so the honest output is the exact click-path, not a half-fix.
//   2. accounts-sync already taught us what an engine that overwrites operator edits does: it
//      silently reverts them every run (the 'Active' master-switch lesson, 2026-07-22). Drift is
//      reported to the Ops Log once per registry run; the human decides.
//
// When the conventions move again, edit EXPECT below in the same PR that renames the code —
// the next registry run then tells the operator exactly what the base is still calling by the
// old name. That is the whole forward mechanism: one manifest, one warn, zero archaeology.
import { REGISTRY_TABLE } from './config.mjs';
import { DIALS as CELLS_DIALS } from './cells-sync.mjs';

/** The manifest. Choice lists are `expected` (should exist) and `retired` (should be GONE —
 *  their presence means a migration is incomplete or a writer is still emitting old names). */
export const EXPECT = Object.freeze({
  [REGISTRY_TABLE]: {
    // The farm fields (Batch → Archived, 2026-09-02) are written by harvest-gate.mjs and the
    // /attempt//pot skills — a missing one fails those writers with UNKNOWN_FIELD_NAME.
    fields: ['Share Link', 'Typefully Link', 'Type', 'Draft ID', 'Status',
             'Batch', 'Attempt Verdict', 'Judged At', 'Seed Version', 'Archived',
             'Attempt Performed #', 'Harvest', 'Harvest (Origin)', 'Seed', 'Pot',
             // link-sentinel's receipt (operator 2026-09-02): the tick that says every tracked link
             // in the thread was probed and resolved, and when. A missing field 422s the sentinel.
             'Links Verified', 'Links Checked At',
             // Products (2026-09-02): link → Products, both ASINs of a thread; buildRow writes it.
             'Products'],
    selects: {
      // 'Article': a native X Article (registry-sync isArticleRow; owner, R2026-10-03: "Every account
      // should do ≥2 articles a week"). Optional like Single and Threads: the upsert's typecast mints it.
      Type: { expected: ['Cover', 'Harvest', 'Seed', 'Inspiration', 'Manual'], optional: ['Single', 'Threads', 'Article'], retired: ['Recreation', 'Harvest Variation'] },
      // Lifecycle-only since 2026-09-02: the farm surgery retired the performance statuses.
      // Gate truth lives on Harvests; a row still carrying Winner/Repost Candidate after the
      // migration full-rewrite is an orphan awaiting the operator-eyeballed cleanup.
      Status: { expected: ['Draft', 'Scheduled', 'Posted', 'Reposted'], retired: ['Winner', 'Repost Candidate'] },
      'Attempt Verdict': { expected: ['Pending', 'Performed', 'Missed'] },
    },
    formulas: {
      // The public share URL must win; the members-only ?d= fallback only covers rows with no share.
      'Typefully Link': { mustReference: ['Share Link'] },
    },
  },
  // The farm's state tables (2026-09-02). harvest-gate.mjs upserts Harvests on Origin Draft ID and
  // moves machine states only; Seeds rows are minted by /seed-mint and owned by the operator.
  Harvests: {
    fields: ['Body', 'Origin Draft ID', 'Origin X URL', 'Origin Account', 'Status', 'Tier',
             'Attempts', 'Origin Post', 'Seed', 'Hearts Used', 'Performs', 'Inducted At', 'Expires At',
             'Origin Views', 'Origin Commission', 'Origin Clicks', 'Account Size At Origin',
             'Operator Note', 'Showman Override'],
    selects: {
      Status: { expected: ['Potential', 'In Pool', 'Seed-Eligible', 'Seeded', 'Evergreen', 'Retired', 'Expired'] },
      Tier: { expected: ['T3', 'T2', 'T1', 'Untiered'] },
    },
  },
  // Seed → Pots → Plants (2026-09-02): a pot is a filled skeleton written in the greenhouse (the
  // Pots table); a plant is that pot shipped to one garden (a Published Content row linked to both).
  Seeds: {
    fields: ['Name', 'Emoji', 'Status', 'Source Harvest', 'Burner Draft', 'Skeleton', 'Mechanics',
             'Version', 'Pots', 'Plants', 'Plant Performs', 'Plants Fired', 'Approved At', 'Origin Views', 'Origin Commission',
             // the dials program (2026-09-19): the origin's value on every dial, and the seed's cells
             'Home Cell', 'Cells'],
    selects: {
      Status: { expected: ['Proposed', 'Approved', 'Active', 'Dormant', 'Expired'] },
    },
  },
  Pots: {
    // No garden on a pot (operator 2026-09-02): it is account-agnostic; the garden is the PLANT's
    // (Published Content → Account). 'Written For' was retired twenty minutes after it was born.
    fields: ['Name', 'Seed', 'Status', 'Angle', 'Greenhouse Draft', 'Version', 'Products',
             'Variables', 'Operator Note', 'Potted At', 'Plants', 'Plants Fired', 'Plant Performs',
             // the dials program (2026-09-19): the ticket on the row, the cell it lands in, the money per pot
             'Dial', 'Ticket', 'Cell', 'Views', 'Clicks', 'Commission', '$ / 1k Views', 'Chances Left'],
    selects: {
      Status: { expected: ['Potted', 'Approved', 'Planted', 'Retired'] },
      Dial: { expected: CELLS_DIALS },
    },
  },
  // Cells (2026-09-19): one row per seed × dial, the unit of reading in the dials program. Kept by
  // cells-sync.mjs (rows, Home) and greenhouse-draft.mjs (a new pot's cell); the counts, money and
  // Verdict are the table's own rollups and formulas, so /farm (pool and weekly report) re-derive nothing.
  Cells: {
    fields: ['Cell', 'Dial', 'Seed', 'Home', 'Operator Note', 'Pots', 'Needs', 'Pots #', 'Chances', 'Performs',
             'Views', 'Commission', '$ / 1k Views', 'Verdict'],
    selects: {
      Dial: { expected: CELLS_DIALS },
    },
  },
  // Products (2026-09-02): the per-ASIN board gains the thread side — Threads is the reverse of
  // Published Content.Products, the rest roll it up. products-sync owns Name/ASIN.
  Products: {
    fields: ['Name', 'ASIN', 'Threads', 'Threads #', 'Thread Commission', 'Thread Views', 'Thread $ / 1k Views',
             // product-test.mjs (2026-09-02): the three-hearts test lifecycle.
             'Test Status', 'Test Hearts', 'Test Batch', 'Test Note', 'Test Judged At'],
    selects: {
      'Test Status': { expected: ['Untested', 'Testing', 'Promoted', 'Parked', 'Retired', 'Killed'] },
    },
  },
  // 'Week Plan' left the manifest 2026-09-02: the table is ARCHIVED (description-marked, the
  // Fuel Log precedent) — the /run manifest replaced the planning calendar, plan-publish.mjs is
  // retired with it, and a watched archive would log drift on every run forever.
});

/** Pure comparison of a live meta-API table list against EXPECT. Exported for tests. */
export function schemaDrift(tables, expect = EXPECT) {
  const drift = [];
  const byName = new Map((tables || []).map((t) => [t.name, t]));
  for (const [tableName, want] of Object.entries(expect)) {
    const t = byName.get(tableName);
    if (!t) { drift.push(`table "${tableName}" not found in the base`); continue; }
    const fields = new Map((t.fields || []).map((f) => [f.name, f]));
    for (const name of want.fields || []) {
      if (!fields.has(name)) drift.push(`${tableName}: field "${name}" is missing — a writer that sends it will fail with UNKNOWN_FIELD_NAME`);
    }
    for (const name of want.retiredFields || []) {
      if (fields.has(name)) drift.push(`${tableName}: field "${name}" still exists under its retired name — rename it in Airtable (field header ▸ Edit field) to match the repo convention`);
    }
    for (const [fieldName, rules] of Object.entries(want.selects || {})) {
      const f = fields.get(fieldName);
      if (!f) continue; // already reported as missing above if expected
      const choices = new Set((f.options?.choices || []).map((c) => c.name));
      for (const c of rules.expected || []) {
        if (!choices.has(c)) drift.push(`${tableName}.${fieldName}: select option "${c}" is missing — the next write emitting it will mint it with a random color (or fail without typecast)`);
      }
      for (const c of rules.retired || []) {
        if (choices.has(c)) drift.push(`${tableName}.${fieldName}: retired select option "${c}" is still configured — if no rows use it, delete it (field header ▸ Edit field ▸ ✕ on the option); if rows use it, a writer is still emitting the old name`);
      }
    }
    for (const [fieldName, rules] of Object.entries(want.formulas || {})) {
      const f = fields.get(fieldName);
      if (!f) continue;
      const formula = String(f.options?.formula || '');
      for (const ref of rules.mustReference || []) {
        // The meta API returns formulas with field IDS, not names — resolve the referenced name to
        // its id and accept either spelling, so the check works on both raw and prettified reads.
        const refId = fields.get(ref)?.id;
        if (!formula.includes(`{${ref}}`) && !(refId && formula.includes(refId))) {
          drift.push(`${tableName}.${fieldName}: formula does not reference {${ref}} — it is still building the members-only URL; update the formula to prefer {${ref}}`);
        }
      }
    }
  }
  return drift;
}

/** Fetch the live schema and return the drift list. Throws on network/permission failure —
 *  the caller treats a throw as "could not check", never as "no drift". */
export async function checkRegistrySchema(env) {
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${env.REGISTRY_BASE_ID}/tables`, {
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
  });
  if (r.status === 403) throw new Error('PAT lacks schema.bases:read — add the scope to enable the drift watch');
  if (!r.ok) throw new Error(`meta tables -> ${r.status}`);
  const j = await r.json();
  return schemaDrift(j.tables || []);
}
