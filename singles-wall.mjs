#!/usr/bin/env node
// singles-wall.mjs <plan.json> --days a,b [--hours 1] [--apply] — keep a page's singles away from
// its own money threads.
//
// THE WALL (operator 2026-09-07): "there will be a wall before we post, and then there will be a
// wall after we post. In between, that's the room for our threads." An hour of the page's own
// silence either side of every cover and pot, and its singles get out of that hour.
//
// Why it is not merely tidy. The CTA experiment compares one-ask covers against two-ask covers, and
// a single landing twenty minutes after one arm's thread and not the other's competes for the same
// readers in the same feed. Measured before this ran: 4 of the 16 one-ask threads had a single
// inside the hour against 6 of the 15 controls. That imbalance is noise the comparison would have
// carried, and it costs nothing to remove.
//
// This is the RETIME PASS Run 2 did by hand every day, promoted. It is deliberately narrow:
//   · it moves SINGLES only, never a money thread — those carry the run's grid and the experiment
//   · it moves them within their own Saigon day, so a day's post count never changes
//   · it keeps the ≥75-minute gap between one page's own singles, and ≥2 minutes from any fleet post
//   · it never touches a published draft, or one inside 15 minutes of its slot
//   · it re-reads every draft immediately before writing it
//
//   node singles-wall.mjs queues/run-2026-09-08.json --days 2026-09-08,2026-09-09        # dry
//   node singles-wall.mjs queues/run-2026-09-08.json --days ... --hours 1 --apply
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, typefully, cliArg, runMain } from './lib.mjs';
import { ACCOUNTS, getAccount } from './accounts.mjs';

export const INTRA_GAP_MIN = 75;   // one page's own singles, minimum apart (plan-singles' rule)
export const FLEET_GAP_MIN = 2;    // any two fleet posts in the same minute read as a burst
const isSingle = (title) => /^\[single\]/i.test(String(title || ''));

/** PURE. The blocked minute ranges around one page's money threads, as [lo, hi] inclusive, in
 *  minutes-of-day UTC. `hours` is the wall on EACH side. */
export function walls(moneyMinutes, hours = 1) {
  const w = Math.round(hours * 60);
  return moneyMinutes.map((m) => [m - w, m + w]).sort((a, b) => a[0] - b[0]);
}

/** PURE. Is this minute inside any wall? */
export const walled = (min, ws) => ws.some(([lo, hi]) => min >= lo && min <= hi);

/** PURE. Where a walled single should go.
 *  min       — its current minute-of-day (UTC)
 *  ws        — the page's walls
 *  siblings  — the page's OTHER singles' minutes that day
 *  taken     — every fleet post's minute that day (any account)
 *  envelope  — [lo, hi] the day's allowed span for a single, UTC minutes
 *  nowMin    — minutes-of-day now, or -Infinity when the day is in the future
 *  Returns the new minute, or null when the day has no room.
 *
 *  TWO RULES THAT MATTER MORE THAN THEY LOOK.
 *
 *  BUFFER. A candidate must clear the wall by `buffer` minutes, not merely sit outside it. Without
 *  it the search lands one minute past the edge — legal, and exactly the kind of answer that honours
 *  the letter of an hour of silence while ignoring what it was for.
 *
 *  LATER FIRST, EXHAUSTIVELY. Every later minute is tried before any earlier one, rather than
 *  spiralling out to the nearest on either side. The money threads sit early in the day and the new
 *  singles evening window (18:00-22:00 Saigon) is late, so a single pushed later moves toward where
 *  singles are going to live anyway; one pulled earlier moves into what is becoming the cover lane. */
export function relocate(min, ws, siblings, taken, envelope, nowMin = -Infinity, buffer = 10) {
  const [lo, hi] = envelope;
  const padded = ws.map(([a, b]) => [a - buffer, b + buffer]);
  const free = (m) => {
    if (m < lo || m > hi) return false;
    if (m < nowMin + 20) return false;                       // never into the next twenty minutes
    if (walled(m, padded)) return false;
    if (m % 5 === 0) return false;                           // :00 and :05 read as a machine
    if (siblings.some((s) => Math.abs(s - m) < INTRA_GAP_MIN)) return false;
    if (taken.some((t) => Math.abs(t - m) < FLEET_GAP_MIN)) return false;
    return true;
  };
  for (let m = min + 1; m <= hi; m++) if (free(m)) return m;
  for (let m = min - 1; m >= lo; m--) if (free(m)) return m;
  return null;
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
const sg = (m) => hhmm((m + 420) % 1440);

async function main() {
  const file = process.argv[2];
  const days = (cliArg('days', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!file || !days.length) { console.error('usage: node singles-wall.mjs <plan.json> --days YYYY-MM-DD,... [--hours 1] [--apply]'); process.exit(2); }
  const HOURS = Number(cliArg('hours', 1));
  const APPLY = process.argv.includes('--apply');
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const env = loadEnv(); const tf = typefully(env);

  // The money threads that build the walls: covers and pots (a harvest posts in the small hours,
  // nowhere near a single). Only pages that actually run a COVER in the window are in scope —
  // the operator's rule is about the accounts carrying the experiment.
  const coverPages = new Set();
  for (const d of days) for (const r of (plan.days[d] || [])) if (r.bucket === 'cover' && r.draftId) coverPages.add(r.account);
  const moneyBy = {};
  for (const d of days) for (const r of (plan.days[d] || [])) {
    if (!r.draftId || r.bucket === 'harvest' || !coverPages.has(r.account)) continue;
    ((moneyBy[r.account] ||= {})[d] ||= []).push(r);
  }
  console.log(`${coverPages.size} page(s) running a cover over ${days.length} day(s) · wall ±${HOURS}h either side of each cover and pot\n`);

  // Read every scheduled draft once, fleet-wide: the walls need the page's own posts and the
  // relocation needs everyone's minutes, so one pass serves both.
  const sets = new Map();
  for (const [k, a] of Object.entries(ACCOUNTS)) if (a.socialSetId && !a.burner && k !== 'aiEvolution' && !sets.has(a.socialSetId)) sets.set(a.socialSetId, k);
  const all = [];
  for (const [sid, key] of sets) for (const st of ['scheduled']) for (let o = 0; ; o += 50) {
    const j = await tf.get(`/social-sets/${sid}/drafts?status=${st}&limit=50&offset=${o}`);
    for (const d of (j.results || [])) {
      if (!d.scheduled_date) continue;
      const t = Date.parse(d.scheduled_date);
      all.push({ key, sid, id: String(d.id), t, min: new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes(),
        day: new Date(t + 7 * 3600e3).toISOString().slice(0, 10), single: isSingle(d.draft_title), title: String(d.draft_title || '') });
    }
    if (!j.next || !(j.results || []).length) break;
  }

  const moves = [];
  for (const day of days) {
    const onDay = all.filter((x) => x.day === day);
    const nowMin = new Date().toISOString().slice(0, 10) === day ? new Date().getUTCHours() * 60 + new Date().getUTCMinutes() : -Infinity;
    for (const page of coverPages) {
      const money = (moneyBy[page]?.[day] || []).map((r) => onDay.find((x) => x.id === String(r.draftId))).filter(Boolean);
      if (!money.length) continue;
      const ws = walls(money.map((m) => m.min), HOURS);
      const mine = onDay.filter((x) => x.key === page && x.single).sort((a, b) => a.min - b.min);
      const offenders = mine.filter((x) => walled(x.min, ws));
      if (!offenders.length) continue;
      // The day's envelope: the span these singles were planned into, so a move stays inside the
      // schedule the week was built on rather than inventing a new one.
      const spans = mine.map((x) => x.min);
      const envelope = [Math.min(...spans, 6 * 60), Math.max(...spans, 15 * 60)];
      for (const s of offenders) {
        const siblings = mine.filter((x) => x.id !== s.id && !moves.some((mv) => mv.id === x.id)).map((x) => x.min)
          .concat(moves.filter((mv) => mv.key === page && mv.day === day).map((mv) => mv.to));
        const taken = onDay.filter((x) => x.id !== s.id).map((x) => x.min)
          .concat(moves.filter((mv) => mv.day === day).map((mv) => mv.to));
        const to = relocate(s.min, ws, siblings, taken, envelope, nowMin);
        if (to == null) { console.log(`   ✗ ${page.padEnd(9)} ${s.id} ${sg(s.min)} Saigon — no free minute left on ${day}`); continue; }
        moves.push({ key: page, day, id: s.id, sid: s.sid, from: s.min, to, near: money.map((m) => `${m.title.slice(0, 14)} ${sg(m.min)}`).join(', ') });
      }
    }
  }

  for (const m of moves) {
    const off = m.to - m.from;
    console.log(`${m.day} ${m.key.padEnd(9)} ${m.id}  ${sg(m.from)} -> ${sg(m.to)} Saigon  (${off > 0 ? '+' : ''}${off} min)   clear of ${m.near}`);
  }
  console.log(`\n${moves.length} single(s) to move${APPLY ? '' : ' (dry — pass --apply)'}`);
  if (!APPLY || !moves.length) return;

  let done = 0;
  for (const m of moves) {
    const fresh = await tf.getDraft(m.sid, m.id);
    if (fresh.published_at) { console.log(`  ✗ ${m.key} ${m.id} already published — left alone`); continue; }
    const when = Date.parse(fresh.scheduled_date || 0);
    if (when && when - Date.now() < 15 * 60e3) { console.log(`  ✗ ${m.key} ${m.id} inside the 15-minute window — left alone`); continue; }
    const iso = new Date(Date.parse(`${m.day}T00:00:00+07:00`) + (m.to - (m.to >= 420 ? 420 : 420 - 1440)) * 60e3).toISOString();
    // Build the target from the UTC day the draft actually sits on, not from arithmetic on Saigon:
    // the singles envelope never crosses UTC midnight, so the draft's own UTC date is correct.
    const utcDay = new Date(when).toISOString().slice(0, 10);
    const target = new Date(`${utcDay}T${hhmm(m.to)}:00Z`).toISOString();
    const r = await tf.patchDraft(m.sid, m.id, { publish_at: target });
    console.log(`  ✓ ${m.key.padEnd(9)} ${m.id} -> ${r.scheduled_date}`);
    done++;
  }
  console.log(`\n${done} moved`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'singles-wall');
