#!/usr/bin/env node
// move-day.mjs — move a run day's covers and pots to another date, at their grid minutes, safely.
//
// Born on 2026-09-07, when Run 2's weekday labels turned out a day early and thirteen Friday drafts
// had to post on Monday. The scratchpad script that did it warned that three pages already had a
// money thread that day and moved them anyway; two of those pages then posted twice within nine
// hours. This tool REFUSES a move that gives a page a second money thread on the target day unless
// the operator passes --allow-double by hand, and it never touches a draft inside the 15-minute
// window or a draft that already published.
//
//   node move-day.mjs queues/run-2026-09-08.json --from 2026-09-11 --to 2026-09-07            # dry
//   node move-day.mjs <plan> --from D1 --to D2 --skip peak,live --apply
//   node move-day.mjs <plan> --from D1 --to D2 --only julian --at julian=11:03 --apply       # a hand-placed minute
//   node move-day.mjs <plan> --from D1 --to D2 --allow-double --apply                        # the operator's call
//
// A grid minute that has passed (or is inside the next 3 minutes) or is already taken by a fleet
// post slides to the next minute that sits ≥MIN_SLOT_GAP_MIN (5) minutes from everything already on the
// target day. It was a local 2 until 2026-09-23, which let move-day land a post inside the same
// Typefully polling tick the rest of the fleet keeps 5 minutes clear of.
// The plan follows the drafts: moved rows leave the source day, land on the target day with the
// reason, and plan-check still has to pass afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, typefully, cliArg, runMain } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { MIN_SLOT_GAP_MIN } from './slots.mjs';

const LANE = (title) => /^\[single\]/i.test(title) ? 'single' : /^\[warmup\]/i.test(title) ? 'warmup' : /^\[Harvest\]/i.test(title) ? 'harvest' : /^\[Pot/i.test(title) ? 'pot' : 'cover';
const MONEY = new Set(['harvest', 'pot', 'cover']);

/** PURE. Decide every move for one day.
 *  rows      — plan rows to move ({account, bucket, draftId, note})
 *  grid      — key -> "HH:MM" (UTC), the run plan's grid
 *  taken     — Set of UTC minute-of-day numbers already booked on the target day, fleet-wide
 *  byAccount — key -> [{lane, at}] money posts the account already has on the target day
 *  nowMin    — minute-of-day now (target day = today) or -Infinity (a future day)
 *  opts      — { at: {key: "HH:MM"}, allowDouble }
 *  Returns { moves: [{...row, minute, why, shifted}], refused: [{...row, why}] }. */
export function planMoves(rows, grid, taken, byAccount, nowMin, opts = {}) {
  const used = new Set(taken);
  const free = (m) => { for (const u of used) if (Math.abs(u - m) < MIN_SLOT_GAP_MIN) return false; return true; };
  const moves = [], refused = [];
  for (const r of rows) {
    const others = (byAccount[r.account] || []).filter((p) => MONEY.has(p.lane));
    if (others.length && !opts.allowDouble) {
      refused.push({ ...r, why: `already has ${others.map((p) => `${p.lane} ${p.at}`).join(', ')} on the target day — pass --allow-double to stack a second money thread` });
      continue;
    }
    const hm = (opts.at || {})[r.account] || grid[r.account];
    if (!/^[0-2]\d:[0-5]\d$/.test(String(hm || ''))) { refused.push({ ...r, why: 'no grid minute for this page' }); continue; }
    const [h, mm] = hm.split(':').map(Number);
    const target = h * 60 + mm;
    let m = target, why = (opts.at || {})[r.account] ? 'hand-placed' : 'grid';
    if (m < nowMin + 3) { m = nowMin + 3; why = 'grid minute passed'; }
    while (!free(m) && m < 1440) { m++; if (why === 'grid') why = 'grid minute taken'; }
    if (m >= 1440) { refused.push({ ...r, why: 'no free minute left on the target day' }); continue; }
    used.add(m);
    moves.push({ ...r, minute: m, why, shifted: m - target, others });
  }
  return { moves, refused };
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function main() {
  const file = process.argv[2];
  const FROM = cliArg('from'), TO = cliArg('to');
  if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(FROM || '') || !/^\d{4}-\d{2}-\d{2}$/.test(TO || '')) {
    console.error('usage: node move-day.mjs <plan.json> --from YYYY-MM-DD --to YYYY-MM-DD [--only a,b] [--skip a,b] [--at key=HH:MM,...] [--allow-double] [--apply]');
    process.exit(2);
  }
  const APPLY = process.argv.includes('--apply');
  const only = (cliArg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const skip = (cliArg('skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const at = Object.fromEntries((cliArg('at', '') || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('=')));
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  if (!plan.days?.[FROM]) throw new Error(`${file} has no day ${FROM}`);
  const rows = plan.days[FROM].filter((r) => r.bucket !== 'harvest' && r.draftId && (!only.length || only.includes(r.account)) && !skip.includes(r.account));
  if (!rows.length) { console.log('nothing to move'); return; }

  const env = loadEnv(); const tf = typefully(env);
  const lo = Date.parse(`${TO}T00:00:00Z`), hi = lo + 864e5;
  const taken = new Set(); const byAccount = {};
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    if (!a.socialSetId || key === 'burner' || key === 'aiEvolution') continue;
    for (const st of ['scheduled', 'published']) for (let o = 0; ; o += 50) {
      const j = await tf.get(`/social-sets/${a.socialSetId}/drafts?status=${st}&limit=50&offset=${o}`);
      for (const d of (j.results || [])) {
        const t = Date.parse(d.published_at || d.scheduled_date || 0);
        if (!(t >= lo && t < hi)) continue;
        const min = Math.floor((t - lo) / 60e3);
        taken.add(min);
        (byAccount[key] ||= []).push({ lane: LANE(String(d.draft_title || '')), at: hhmm(min) + 'Z' });
      }
      if (!j.next || !(j.results || []).length) break;
    }
  }
  const nowMin = Date.now() >= lo && Date.now() < hi ? Math.floor((Date.now() - lo) / 60e3) : -Infinity;
  const { moves, refused } = planMoves(rows, plan.grid || {}, taken, byAccount, nowMin, { at, allowDouble: process.argv.includes('--allow-double') });
  for (const x of moves) console.log(`${x.account.padEnd(9)} ${x.bucket.padEnd(5)} ${x.draftId}  ${FROM} ${plan.grid?.[x.account] || '--:--'} -> ${TO} ${hhmm(x.minute)}Z${x.shifted ? ` (+${x.shifted} min: ${x.why})` : ''}${x.others.length ? `  ⚠ double, allowed by hand: ${x.others.map((p) => `${p.lane} ${p.at}`).join(', ')}` : ''}`);
  for (const x of refused) console.log(`${x.account.padEnd(9)} ${x.bucket.padEnd(5)} ${x.draftId}  ✗ refused: ${x.why}`);
  console.log(`${moves.length} to move · ${refused.length} refused${APPLY ? '' : ' (dry — pass --apply)'}`);
  if (!APPLY || !moves.length) return;

  const done = [];
  for (const x of moves) {
    const sid = ACCOUNTS[x.account].socialSetId;
    const fresh = await tf.getDraft(sid, x.draftId);
    const when = Date.parse(fresh.scheduled_date || 0);
    if (fresh.published_at) { console.log(`  ✗ ${x.account} ${x.draftId} already published — left alone`); continue; }
    if (when && when - Date.now() < 15 * 60e3) { console.log(`  ✗ ${x.account} ${x.draftId} inside the 15-minute window — left alone`); continue; }
    if (!String(fresh.scheduled_date || '').startsWith(FROM)) { console.log(`  ✗ ${x.account} ${x.draftId} is not on ${FROM} (${fresh.scheduled_date}) — left alone`); continue; }
    const to = new Date(lo + x.minute * 60e3).toISOString();
    const r = await tf.patchDraft(sid, x.draftId, { publish_at: to });
    console.log(`  ✓ ${x.account} ${x.draftId} -> ${r.scheduled_date}`);
    done.push({ ...x, to });
  }
  if (!done.length) return;
  const ids = new Set(done.map((x) => String(x.draftId)));
  const why = cliArg('why', `moved from ${FROM} by move-day.mjs`);
  plan.days[TO] = [...(plan.days[TO] || []), ...done.map((x) => {
    const { minute, why: w, shifted, others, to, ...row } = x;
    return { ...row, slot: hhmm(minute) + 'Z', note: `${row.note || ''} · ${why}${shifted ? ` (+${shifted} min: ${w})` : ''}`.replace(/^ · /, '') };
  })];
  plan.days[FROM] = plan.days[FROM].filter((r) => !ids.has(String(r.draftId)));
  writeFileSync(file, JSON.stringify(plan, null, 1) + '\n');
  console.log(`plan: ${done.length} row(s) moved to ${TO}, ${plan.days[FROM].length} row(s) left on ${FROM} — run plan-check next`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'move-day');
