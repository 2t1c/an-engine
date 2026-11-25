#!/usr/bin/env node
// schedule-day.mjs <YYYY-MM-DD> [--apply] [--lane cover] [--only a,b,c]
//
// Places every UNSCHEDULED draft into its account's own slot on the target day. Dry by default.
//
// Three guards, each of which has already failed in production:
//
//  1. ONE POST PER ACCOUNT PER LANE PER DAY. A time-keyed check cannot answer a day-keyed question:
//     asking "is 06:24 free" says nothing about an account that already posts at 06:00. Nine
//     accounts were double-booked onto 2026-08-31 exactly that way.
//  2. MINUTE UNIQUENESS ACROSS ACCOUNTS, at MIN_SLOT_GAP_MIN. Typefully publishes on a polling tick,
//     so two drafts under five minutes apart can land in the same minute and read as a bot.
//  3. THE POLLER RACE. Never patch a draft whose scheduled time is inside SAFE_MIN, and re-read
//     published_at immediately before every write rather than trusting a status read from the top of
//     a loop. On 2026-08-30 a draft read `scheduled` at 11:34:56, the poller fired it at 11:35:45,
//     and the patch landed after publication. That post went out and could not be recalled.
import { loadEnv, typefully } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { accountSlots, fleetSlotKeys, windowForUtc, MIN_SLOT_GAP_MIN, spacingFailures } from './slots.mjs';

const DAY = process.argv[2];
if (!/^\d{4}-\d\d-\d\d$/.test(String(DAY))) { console.error('usage: schedule-day.mjs <YYYY-MM-DD> [--apply]'); process.exit(2); }
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const LANE = arg('lane', 'cover');
const ONLY = String(arg('only', '')).split(',').filter(Boolean);
const SAFE_MIN = 15;
const env = loadEnv(); const tf = typefully(env);
const keys = fleetSlotKeys(ACCOUNTS);
const sg = (iso) => new Date(Date.parse(iso) + 7 * 3600e3).toISOString().slice(11, 16);

// what each account already has in this lane on this day, and every unscheduled draft it holds
const plan = [], skipped = [], onDay = [];
const saigonDay = (iso) => new Date(Date.parse(iso) + 7 * 3600e3).toISOString().slice(0, 10);
for (const k of keys) {
  const acc = ACCOUNTS[k];
  const rows = { scheduled: [], draft: [] };
  for (const st of ['scheduled', 'draft']) {
    for (let o = 0; ; o += 50) {
      // Retrying read that THROWS. A bare fetch with `if (!r.ok) break` is indistinguishable
      // from "no more pages": one transient 429 truncates the scan and a TAKEN slot reports FREE.
      // Same defect main fixed in slots.mjs; a caller that cannot see the queue must fail, not guess.
      const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=${st}&limit=50&offset=${o}`);
      rows[st].push(...(j.results || []));
      if (!j.next || !(j.results || []).length) break;
    }
  }
  // Every post already on the day, on every page (--only narrows what is PLACED, never what is
  // checked against): guard 2 compares each new minute with these too.
  for (const d of rows.scheduled) if (d.scheduled_date && saigonDay(d.scheduled_date) === DAY) onDay.push({ name: `${acc.name} ${d.id}`, ms: Date.parse(d.scheduled_date) });
  if (ONLY.length && !ONLY.includes(k)) continue;
  // ONE THREAD PER ACCOUNT PER DAY, whatever lane it is (operator 2026-09-10). This asked
  // `w.lane === LANE` until then, which was the per-lane rule AND the last caller reading a lane off
  // a posting time — a thing that stopped being knowable once a block began carrying several lanes.
  const taken = rows.scheduled.some((d) => { const w = d.scheduled_date ? windowForUtc(d.scheduled_date) : null; return w && w.day === DAY; });
  if (taken) { skipped.push([acc.name, `already has a thread on ${DAY}`]); continue; }
  // NEWEST FIRST. An account can be sitting on twenty-odd unscheduled drafts, so "the first one the
  // API returns" is an arbitrary pick and will happily schedule something from three weeks ago. The
  // draft you just wrote is the one you mean, and it is the newest. Pass --only, or schedule by hand,
  // when that assumption does not hold.
  const free = rows.draft.filter((d) => !d.scheduled_date && !d.published_at)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!free.length) { skipped.push([acc.name, 'no unscheduled draft']); continue; }
  const [s] = accountSlots(k, keys, LANE);
  const to = `${DAY}T${String(s.h).padStart(2, '0')}:${String(s.m).padStart(2, '0')}:00Z`;
  plan.push({ k, name: acc.name, sid: acc.socialSetId, id: String(free[0].id), to, extra: free.length - 1 });
}
plan.sort((a, b) => a.to.localeCompare(b.to));

// guard 2: minute uniqueness across accounts, including anything already on the day
const failures = spacingFailures(plan.map((p) => ({ name: p.name, ms: Date.parse(p.to) })), onDay);
for (const f of failures) console.log(`  ✗ ${f}`);
const bad = failures.length;
console.log(`\n${DAY} · ${LANE} · ${plan.length} to place, ${skipped.length} skipped\n`);
for (const p of plan) console.log(`  ${p.to.slice(11, 16)}Z  ${sg(p.to)} SGN  ${p.name.padEnd(16)} ${p.id}${p.extra ? `   (+${p.extra} more unscheduled)` : ''}`);
for (const [n, why] of skipped) console.log(`  ~ ${n.padEnd(16)} ${why}`);
if (bad) { console.log(`\n✗ ${bad} spacing failure(s) — not applying`); process.exit(1); }
console.log(`\n✓ spacing >= ${MIN_SLOT_GAP_MIN}min, one ${LANE} post per account`);
if (!APPLY) { console.log('(dry run — pass --apply to write)'); process.exit(0); }

let ok = 0, held = 0;
for (const p of plan) {
  // guard 3, re-read per draft rather than once per run
  const cur = await tf.getDraft(p.sid, p.id);
  if (cur?.published_at) { console.log(`  ~ ${p.name.padEnd(16)} ALREADY PUBLISHED ${cur.published_at} — left alone`); held++; continue; }
  if (cur?.scheduled_date && (Date.parse(cur.scheduled_date) - Date.now()) / 60e3 < SAFE_MIN) {
    console.log(`  ~ ${p.name.padEnd(16)} fires inside ${SAFE_MIN}min — left alone`); held++; continue;
  }
  await tf.patchDraft(p.sid, p.id, { publish_at: p.to });
  const back = await tf.getDraft(p.sid, p.id);
  const good = String(back?.scheduled_date || '').startsWith(p.to.slice(0, 16));
  console.log(`  ${good ? '✓' : '✗'} ${p.name.padEnd(16)} ${p.id} -> ${back?.scheduled_date || 'NOT SET'}`);
  good ? ok++ : held++;
}
console.log(`\nplaced ${ok} · held ${held}`);
