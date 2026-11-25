// reslot.mjs — re-time scheduled health drafts onto the new slot grid via the REGISTRY (the scheduling
// authority). Airtable "Posted Date" is master; reschedule-sync pushes it to Typefully every 15 min, so
// patching Typefully directly gets reverted — we MUST update Posted Date here. Per account, per Saigon day,
// sort by current Posted Date and reassign to that account's OWN two window slots (collapses double-books).
// Run `node reschedule-sync.mjs` afterwards (or wait ≤15 min) to push the new times to Typefully.
//   node reslot.mjs          # dry: show every move
//   node reslot.mjs --go     # write Posted Date changes to the registry
import { loadEnv, requireEnv, airtable } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { accountSlots, fleetSlotKeys } from './slots.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { pathToFileURL } from 'node:url';
import { isThreadRow } from './monitoring-scope.mjs';

// The grid is PER ACCOUNT, not fleet-wide: accountSlots gives each page its own morning + afternoon
// minute inside the operator's two windows, and re-timing every page onto one shared grid is exactly
// the clustering the spread exists to prevent. This used to be a fleet-wide 6-point GRID guarded by
// `!a.recreateSlots` — which was safe only while every account carried an override. The overrides
// were deleted 2026-08-20, so that guard silently opened the whole fleet to a shared grid; one `--go`
// would have stacked nine pages on the same six minutes.
//
// Ordering matters: accountSlots returns [morning, afternoon] and a day's drafts are re-timed in
// that order, so the earliest-scheduled draft takes the morning slot. Anything beyond 2 drafts on a
// Saigon day is left alone rather than invented a slot for.
const gridFor = (name) => {
  const key = Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].name === name);
  return key ? accountSlots(key, fleetSlotKeys(ACCOUNTS)) : [];
};
// Every posting page is in scope. An account that re-adds `recreateSlots` for a deliberate
// experiment opts back out — re-timing it onto the window grid would silently destroy the test.
const HEALTH = new Set(Object.values(ACCOUNTS).filter((a) => a.plugHeavyExample && !a.recreateSlots).map((a) => a.name));
const TZ = 'Asia/Saigon';
const day = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
// Saigon day `d` + a slot -> UTC instant. The morning window crosses midnight (06:00 Saigon = 23:00
// UTC the PREVIOUS day), which accountSlots reports as dayOffset -1; ignoring it would book the
// morning post 24h late. The afternoon slot has dayOffset 0 and lands on the same UTC date.
const slotIso = (d, s) => {
  const dt = new Date(`${d}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + (s.dayOffset || 0));
  dt.setUTCHours(s.h, s.m, 0, 0);
  return dt.toISOString();
};

/** PURE. The registry rows reslot re-times: a health page's future Scheduled THREADS. A standalone
 *  single or a native X Article (owner, R2026-10-03: articles are additive) never takes one of the
 *  page's thread slots, so it is never moved onto one either. Needs each row's Type. */
export function reslotRows(rows, { now = Date.now(), health = HEALTH } = {}) {
  return rows.filter((r) => isThreadRow(r) && health.has(r.fields.Account) && r.fields['Posted Date'] && Date.parse(r.fields['Posted Date']) >= now);
}

async function main() {
  const GO = process.argv.includes('--go');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);

  // Pull all Scheduled registry rows. The old loop checked `d.error` but never `r.ok`, so it caught
  // Airtable's JSON errors and missed every non-JSON 5xx or gateway response — those parsed to an
  // object with no `.error` and no `.records`, and the run then rescheduled against a silently short
  // list. listAll retries and throws.
  const rows = await airtable(env, env.REGISTRY_BASE_ID).listAll(REGISTRY_TABLE, {
    formula: '{Status}="Scheduled"',
    fields: ['Type', 'Draft ID', 'Account', 'Posted Date', 'Post'],
  });

  const now = Date.now();
  const mine = reslotRows(rows, { now });
  const byKey = {};
  for (const r of mine) { const k = `${r.fields.Account}|${day(r.fields['Posted Date'])}`; (byKey[k] ||= []).push(r); }

  const updates = [];
  let over = 0, past = 0;
  for (const k of Object.keys(byKey).sort()) {
    const [acct, d] = k.split('|');
    const items = byKey[k].sort((a, b) => Date.parse(a.fields['Posted Date']) - Date.parse(b.fields['Posted Date']));
    const grid = gridFor(acct);
    for (let i = 0; i < items.length; i++) {
      if (i >= grid.length) { over++; console.log(`  ⚠ ${acct} ${d}: ${items.length} drafts > ${grid.length} slot(s) — ${items[i].id} left as-is`); continue; }
      const target = slotIso(d, grid[i]);
      const cur = new Date(items[i].fields['Posted Date']).toISOString();
      if (cur === target) continue;
      // The morning slot is ~15h EARLIER than an afternoon time on the same Saigon day, so re-timing
      // today's post onto today's morning slot moves it into the past. reschedule-sync would then push
      // a past Posted Date to Typefully and the draft publishes immediately or wedges. Observed on the
      // first dry run after the windows went live: 5 of 6 proposed moves were already-past targets.
      if (Date.parse(target) <= now) { past++; console.log(`  ⏭ ${acct} ${d}: ${target.slice(11, 16)}Z is already past — ${items[i].id} left at ${cur.slice(11, 16)}Z`); continue; }
      console.log(`  ${acct.padEnd(8)} ${d}: ${cur.slice(11, 16)} -> ${target.slice(11, 16)}Z  (${(items[i].fields.Post || items[i].id).slice(0, 32)})`);
      updates.push({ id: items[i].id, fields: { 'Posted Date': target } });
    }
  }

  if (GO && updates.length) {
    // A FAILED BATCH USED TO BE A LOG LINE AND NOTHING ELSE (fixed 2026-08-30). The loop carried on,
    // so a 429 partway through left SOME posts moved and some not — a half-applied reschedule, which
    // is worse than none at all, announced only in scrollback that nobody reads on a green run. The
    // shared client retries 429 and throws when it genuinely cannot write.
    await airtable(env, env.REGISTRY_BASE_ID).update(REGISTRY_TABLE, updates);
  }
  console.log(`\n${GO ? 'updated' : 'to update'}: ${updates.length} registry row(s)${over ? ` · over-slot/day left: ${over}` + (past ? ` · past-target skipped: ${past}` : '') : ''}`);
  console.log(GO ? 'Next: node reschedule-sync.mjs  (push Posted Date -> Typefully now, instead of waiting ~15 min)' : '(dry run — no writes)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
