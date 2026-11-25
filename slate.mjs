// slate.mjs — what a whole DAY looks like, before and after it is written.
//
// Nothing answered this question. Every other tool reads one slot (thread-brief), one draft
// (publish-thread), or one account (fill-queue), and the failures that actually cost us on the
// 2026-08-31 slate were none of those shapes:
//
//   - two accounts drew the same recycled donor and would have posted near-twin threads on one day
//   - magnesium glycinate ended up on 8 of 11 threads, against an asinCap of 0.3 nothing enforces
//     on the hand lane
//   - nine accounts were scheduled on top of a draft they already had, because the clash check
//     asked about a MINUTE and the rule is about a lane and a day
//
// Every one is invisible per-slot and obvious per-day. Three throwaway scripts were written to
// answer them one at a time and thrown away again; this is that, kept.
//
// READ-ONLY. It writes nothing, mints nothing and schedules nothing.
//
//   node slate.mjs                      # today
//   node slate.mjs --day 2026-08-31
//   node slate.mjs --day 2026-08-31 --json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { TABLES } from './config.mjs';
import { LAWS } from './laws.mjs';
import { laneOf, sameLane } from './lanes.mjs';
import { windowForUtc } from './slots.mjs';
import { tweetsFromRollup, bodyOverlap, hookSimilarity, donorAgeDays, fabricationFlags, numberingIssue } from './checks.mjs';
import { productPerf, fleetEpc } from './pick-product.mjs';
import { planFileFor } from './run-plan.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const pct = (x) => `${Math.round(x * 100)}%`;

/** PURE. Which pairs of donors on one day share enough phrasing to read as the same thread.
 *  Asymmetric by construction (bodyOverlap divides by the first), so both directions are reported
 *  and the louder one wins — "how much of A is already in B" is the question a writer has. */
export function donorCollisions(rows, warn = LAWS.selection?.donorOverlapWarn ?? 0.2) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (!rows[i].body?.length || !rows[j].body?.length) continue;
      const share = Math.max(bodyOverlap(rows[i].body, rows[j].body), bodyOverlap(rows[j].body, rows[i].body));
      if (share >= warn) out.push({ a: rows[i].account, b: rows[j].account, share });
    }
  }
  return out.sort((x, y) => y.share - x.share);
}

/** PURE. Hooks similar enough that two of our own accounts would read as one voice on the day.
 *  Measured on OUR hooks where they exist and the donor's where they do not, because the risk is
 *  what a reader scrolling two of our pages actually sees. */
export function hookCollisions(rows, warn = 0.6) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i].ourHook || rows[i].donorHook, b = rows[j].ourHook || rows[j].donorHook;
      if (!a || !b) continue;
      const sim = hookSimilarity(a, b);
      if (sim >= warn) out.push({ a: rows[i].account, b: rows[j].account, sim });
    }
  }
  return out.sort((x, y) => y.sim - x.sim);
}

/** PURE. Product concentration across the day, against the planner's own asinCap. */
export function concentration(rows, cap = 0.3) {
  const n = rows.length || 1;
  const count = {};
  for (const r of rows) for (const a of (r.products || [])) count[a] = (count[a] || 0) + 1;
  return Object.entries(count)
    .map(([asin, uses]) => ({ asin, uses, share: uses / n, over: uses / n > cap }))
    .sort((a, b) => b.uses - a.uses);
}

/** PURE. Accounts posting more than once in one lane on one day. */
export function doubleBooked(scheduled) {
  const byKey = {};
  for (const s of scheduled) {
    const w = windowForUtc(s.at);
    if (!w) continue;
    (byKey[`${s.account}#${w.lane}#${w.day}`] ||= []).push(s);
  }
  return Object.entries(byKey).filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ key: k, account: v[0].account, lane: k.split('#')[1], day: k.split('#')[2], drafts: v }));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY']);
  const at = airtable(env);
  const tf = typefully(env);
  const JSON_OUT = process.argv.includes('--json');
  const day = arg('day') || new Date().toISOString().slice(0, 10);

  const file = planFileFor(day, readdirSync(join(HERE_DIR, 'queues')));
  const plan = JSON.parse(readFileSync(join(HERE_DIR, 'queues', file), 'utf8'));
  const perf = productPerf(), fe = fleetEpc();
  const catalogue = new Map(JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products.map((p) => [p.asin, p.title]));

  // What the ledger says shipped for this day's slots, so the view covers written and unwritten alike.
  const ledger = existsSync(join(HERE_DIR, 'ledger.jsonl'))
    ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  // Keyed on recId AND account, never recId alone. The planner deliberately gives one donor to
  // several accounts on different days -- sameDaySourceCap bounds a DAY, not a week -- so five
  // donors on this plan appear on both 08-31 and 09-01 under different names. A recId-only lookup
  // credits Julian's shipped draft to Rafael's slot the next day and reports a written thread as an
  // unwritten one. Caught by this view flagging ten drafts as unscheduled that were scheduled.
  const draftByRec = new Map();
  for (const r of ledger) if (r.recId && r.draftId && !r.attributionOnly) draftByRec.set(`${r.recId}#${r.account}`, r);

  const rows = [];
  for (const acc of plan.accounts) {
    for (const slot of (acc.slots || []).filter((s) => s.day === day)) {
      const key = Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].name === acc.account);
      const row = {
        account: acc.account, key, lane: laneOf(slot.lane),
        recId: slot.recId || null, harvestOf: slot.harvestOf || null,
        donorHook: slot.hook || null, donorUrl: slot.url || null, views: slot.views || 0,
        products: (slot.products || []).map((p) => p.asin),
        body: [], ageDays: null, ourHook: null, draftId: null, scheduledAt: null, issues: [],
      };
      if (slot.recId) {
        try {
          const rec = await at.getRecord(TABLES.swipe, slot.recId);
          row.body = tweetsFromRollup(String(rec.fields['Full Thread Text'] || ''));
          row.ageDays = donorAgeDays(rec.fields);
          const n = numberingIssue(row.body); if (n) row.issues.push(`numbering: ${n}`);
          for (const f of fabricationFlags(row.body).slice(0, 3)) row.issues.push(`claim T${f.tweet}: ${f.kind}`);
        } catch (e) { row.issues.push(`donor unreadable: ${e.message.slice(0, 40)}`); }
      }
      const led = slot.recId ? draftByRec.get(`${slot.recId}#${acc.account}`) : null;
      if (led) {
        row.draftId = String(led.draftId);
        row.products = [led.asin, led.asin2].filter(Boolean);   // what SHIPPED beats what was planned
        try {
          const d = await tf.getDraft(ACCOUNTS[key]?.socialSetId, row.draftId);
          row.scheduledAt = d?.scheduled_date || null;
          row.ourHook = (d?.platforms?.x?.posts || [])[0]?.text || null;
        } catch { /* a draft we cannot read is still a planned slot */ }
      }
      rows.push(row);
    }
  }

  // Everything actually on the calendar for this day, which is what catches a pre-existing draft the
  // plan knows nothing about — the exact gap that double-booked nine accounts.
  const scheduled = [];
  for (const [k, a] of Object.entries(ACCOUNTS)) {
    if (!a.socialSetId || !a.plugHeavyExample) continue;
    try {
      const r = await fetch(`https://api.typefully.com/v2/social-sets/${a.socialSetId}/drafts?status=scheduled&limit=50`,
        { headers: { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}` } });
      const j = await r.json();
      for (const d of (j.results || [])) {
        const w = d.scheduled_date ? windowForUtc(d.scheduled_date) : null;
        if (w?.day === day) scheduled.push({ account: a.name, key: k, id: String(d.id), at: d.scheduled_date, lane: w.lane });
      }
    } catch { /* one unreachable account must not blank the whole view */ }
  }

  const cover = rows.filter((r) => sameLane(r.lane, 'cover'));
  const out = {
    day, file,
    rows, scheduled,
    collisions: { donors: donorCollisions(cover), hooks: hookCollisions(cover) },
    concentration: concentration(cover),
    doubles: doubleBooked(scheduled),
    fleetEpc: fe,
  };
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  console.log(`SLATE ${day} — from ${file}   (read-only)\n`);
  console.log('acct              lane     donor        age    products                         draft      scheduled');
  for (const r of rows) {
    const prod = (r.products || []).map((a) => `${a}${perf[a]?.epc != null ? `($${perf[a].epc.toFixed(2)})` : ''}`).join(' ') || '(none)';
    const src = r.recId || (r.harvestOf ? `h:${r.harvestOf}` : '—');
    console.log(`${r.account.slice(0, 16).padEnd(16)}  ${r.lane.padEnd(7)}  ${String(src).slice(0, 11).padEnd(11)}  ${r.ageDays != null ? `${r.ageDays.toFixed(1)}d`.padStart(5) : '    —'}  ${prod.slice(0, 31).padEnd(31)}  ${(r.draftId || '—').padEnd(9)}  ${r.scheduledAt ? r.scheduledAt.slice(11, 16) : '—'}`);
    for (const i of r.issues) console.log(`${' '.repeat(18)}⚠ ${i}`);
  }

  const cap = 0.3;
  const conc = out.concentration.filter((c) => c.over);
  console.log(`\nPRODUCT CONCENTRATION across ${cover.length} cover thread(s)  ·  planner cap ${pct(cap)}`);
  if (!out.concentration.length) console.log('  (nothing committed yet)');
  for (const c of out.concentration.slice(0, 6)) {
    console.log(`  ${c.asin}  ${String(c.uses).padStart(2)}  ${pct(c.share).padStart(4)}  ${(catalogue.get(c.asin) || '').slice(0, 44)}${c.over ? '   OVER CAP' : ''}`);
  }
  if (conc.length) console.log(`  ${conc.length} product(s) over the cap. Relevance decides first, but a day this concentrated cannot tell you which product converted.`);

  console.log('\nDUPLICATION');
  if (!out.collisions.donors.length && !out.collisions.hooks.length) console.log('  none — no two donors or hooks on this day read as the same thread');
  for (const c of out.collisions.donors) console.log(`  DONOR  ${pct(c.share).padStart(4)}  ${c.a} ↔ ${c.b}${c.share >= 0.4 ? '   near-twin' : ''}`);
  for (const c of out.collisions.hooks) console.log(`  HOOK   ${pct(c.sim).padStart(4)}  ${c.a} ↔ ${c.b}   two of our pages open the same way`);

  console.log('\nCALENDAR');
  console.log(`  ${scheduled.length} draft(s) scheduled into ${day} across the fleet`);
  for (const d of out.doubles) {
    console.log(`  *** ${d.account} has ${d.drafts.length} ${d.lane} posts on ${d.day}: ${d.drafts.map((x) => `${x.id}@${x.at.slice(11, 16)}`).join(', ')}`);
  }
  if (!out.doubles.length && scheduled.length) console.log('  one post per account per lane — clean');
  const unscheduled = rows.filter((r) => r.draftId && !r.scheduledAt);
  if (unscheduled.length) console.log(`  ${unscheduled.length} written but UNSCHEDULED: ${unscheduled.map((r) => r.draftId).join(', ')}`);
  const unwritten = rows.filter((r) => !r.draftId);
  if (unwritten.length) console.log(`  ${unwritten.length} slot(s) not yet written: ${unwritten.map((r) => `${r.account}/${r.lane}`).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'slate');
