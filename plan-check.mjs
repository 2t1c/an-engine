#!/usr/bin/env node
// plan-check.mjs <queues/run-YYYY-MM-DD.json> [--phase N] — validate a run plan BEFORE a word is written.
//
// A run plan is cheap to fix and expensive to unship. On 2026-09-03 a 48-slot batch went out as 42
// covers and zero attempts against a phase-1 mix of 75/20/10, with 20 bodies in the pool sitting on
// 7 unspent hearts each. Nothing caught it, because nothing read the plan: /run computes the mix in
// prose and the plan file is written by hand next to it. The same batch also carried 14 slots whose
// donor already appeared on another day, which was over-strict rather than wrong, but no tool could
// say either way. This is that reader.
//
// Five rules, and they are the ones a plan can actually break:
//   MIX       bucket counts against laws.farm.phases[phase-1].mix, normalised by their own sum
//   DONOR     one body per DAY (operator 2026-09-03) — reuse across days is fine and is the point
//   SLOT      one slot per account per day
//   PRODUCTS  every cover names a heavy; a light is optional but a light without a heavy is a defect
//   GRID      if the plan carries times, every slotted account has one and no two share a minute
//   TIME      a row's approved minute (`at`, R1 2026-09-23) is a real minute on its own Saigon day,
//             inside a live block, and at least MIN_SLOT_GAP_MIN from every other row's minute
//
// Exit 1 on any breach so a runner can gate on it. --phase overrides the phase (default 1).
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LAWS, closingTail } from './laws.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { MIN_SLOT_GAP_MIN, windowForUtc } from './slots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The greenhouse body a pot row plants (queues/pots/<greenhouse>.greenhouse.json), or null. */
export function readGreenhouse(name) {
  const f = join(HERE, 'queues', 'pots', `${String(name)}.greenhouse.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
/** PURE. The tweet count a pot reaches at publish: the greenhouse body verbatim, the page's closing
 *  tweets (write-day pastes closingTail: the disclaimer, and the sign-off while laws.json signOff is
 *  on), and one site line when the page carries a siteCta (withSiteCta, platforms.mjs). Three parts,
 *  the same three publish-thread assembles. */
export function potPublishLength(pot, account) {
  return (pot?.tweets || []).length + closingTail(account).length + (account?.siteCta ? 1 : 0);
}

/** PURE. Everything above, over a parsed plan. Returns { errors, warnings, summary } so a caller can
 *  print it, test it, or gate on it without re-deriving any of the arithmetic. */
export function checkPlan(plan, { phase = 1, mix = null, potsBlocked = null, accounts = null, readPot = null } = {}) {
  const errors = [], warnings = [];
  const days = plan?.days && typeof plan.days === 'object' ? plan.days : null;
  if (!days) return { errors: ['plan has no `days` object'], warnings, summary: null };

  // THE CHECKPOINT (laws.farm, farm-status --checkpoint). A pot is a seed's child, and a seed earns
  // its next generation by having a pot PERFORM. Twenty pots fired across Runs 1 and 2 and none has
  // performed yet, so planting more of them buys no new information — the farm's own rule is to hold
  // until a verdict lands. Run 2 planted sixteen anyway, because nothing between the checkpoint and
  // the plan ever said no. The plan records what farm-status said (`plan.checkpoint`), and a pot row
  // written while it is ⛔ is a breach rather than a note; --pots-blocked / --pots-ok override it by
  // hand. When pots are blocked their share of the mix belongs to covers, so the MIX check below is
  // measured against that redistribution instead of failing twice for one decision.
  const cp = plan?.checkpoint && typeof plan.checkpoint === 'object' ? plan.checkpoint : null;
  const blocked = potsBlocked === null ? (cp ? cp.potPerformed === false : null) : !!potsBlocked;

  const rows = Object.entries(days).flatMap(([day, list]) => (list || []).map((r) => ({ ...r, day })));
  const buckets = { cover: 0, harvest: 0, pot: 0 };
  for (const r of rows) { const b = String(r.bucket || 'cover'); buckets[b] = (buckets[b] || 0) + 1; }

  // MIX. The phase numbers are WEIGHTS, not percents — phase 1's 75/20/10 totals 105 on purpose —
  // so normalise by their own sum. Rounding makes an exact match impossible on most slot counts;
  // one slot of slack per bucket is the tolerance, and a bucket at ZERO when the mix asks for some
  // is an error rather than a rounding argument, because that is the shape the miss actually took.
  const want = mix || LAWS.farm?.phases?.[phase - 1]?.mix;
  let target = null;
  if (!Array.isArray(want) || want.length !== 3) {
    warnings.push(`no mix for phase ${phase} in laws.farm.phases — MIX not checked`);
  } else {
    const sum = want.reduce((a, b) => a + b, 0);
    const total = rows.length;
    target = { cover: Math.round(total * want[0] / sum), harvest: Math.round(total * want[1] / sum), pot: Math.round(total * want[2] / sum) };
    if (blocked === true) { target = { ...target, cover: target.cover + target.pot, pot: 0 }; }
    for (const b of ['cover', 'harvest', 'pot']) {
      const got = buckets[b] || 0, exp = target[b];
      if (exp > 0 && got === 0) errors.push(`MIX: 0 ${b} slots, phase ${phase} mix wants ~${exp} of ${total} — the whole lane is missing`);
      else if (Math.abs(got - exp) > 1) errors.push(`MIX: ${got} ${b} slots, phase ${phase} mix wants ~${exp} of ${total}`);
    }
  }

  // POTS vs THE CHECKPOINT.
  const potRows = rows.filter((r) => String(r.bucket) === 'pot');
  if (blocked === true && potRows.length) {
    errors.push(`CHECKPOINT: ${potRows.length} pot row(s) while the checkpoint is ⛔${cp?.potsFired != null ? ` (${cp.potsFired} pot(s) fired, none performed)` : ''} — plant none until a verdict lands, or pass --pots-ok if the operator overrides`);
  } else if (blocked === null && potRows.length) {
    warnings.push(`CHECKPOINT: ${potRows.length} pot row(s) and no checkpoint recorded — run \`node farm-status.mjs --checkpoint\` and put its verdict in the plan as "checkpoint": { "potPerformed": <bool>, "potsFired": <n>, "readAt": "<iso>" }`);
  }

  // DONOR — per day, never per batch.
  for (const [day, list] of Object.entries(days)) {
    const seen = new Map();
    for (const r of (list || [])) {
      if (!r.donor) continue;
      if (seen.has(r.donor)) errors.push(`DONOR: ${r.donor} runs twice on ${day} (${seen.get(r.donor)} and ${r.account})`);
      else seen.set(r.donor, r.account);
    }
  }

  // SLOT — one per account per day.
  for (const [day, list] of Object.entries(days)) {
    const seen = new Set();
    for (const r of (list || [])) {
      if (!r.account) { errors.push(`SLOT: a row on ${day} has no account`); continue; }
      if (seen.has(r.account)) errors.push(`SLOT: ${r.account} has two slots on ${day}`);
      seen.add(r.account);
    }
  }

  // HARVEST ROWS CARRY THEIR PROBE VERDICT (Run 2 row 9). An allocation row naming a body is a
  // candidate, not a commitment: a body can be runnable and still not be runnable ON THAT PAGE,
  // because the pods its plugs need may have no variant there. Run 2 discovered that twice at write
  // time and paid for it in re-probes, re-creates and three orphan Levanta links. `pool-probe --pairs
  // --json` answers it for every (body × page) before a heart is spent; the row carries the answer:
  //   "probe": { "runnable": true, "at": "<iso>" }            — allocated from a probed pair
  //   "probe": { "runnable": false, "why": "pod E1 has no …" } — a pair that must not be allocated
  for (const r of rows) {
    if (String(r.bucket) !== 'harvest') continue;
    const pr = r.probe;
    if (pr && pr.runnable === false) errors.push(`PROBE: ${r.day} ${r.account} is allocated a body its page cannot run — ${pr.why || 'the probe said no'}`);
    else if (!pr) warnings.push(`PROBE: ${r.day} ${r.account} has no probe verdict — run \`node pool-probe.mjs --pairs --json\` and carry it as "probe": { "runnable": <bool>, "why": "…" }`);
  }

  // PRODUCTS — covers only; a pot's products come from its seed and a harvest reuses the body's own.
  for (const r of rows) {
    if (String(r.bucket || 'cover') !== 'cover') continue;
    if (!r.heavy) errors.push(`PRODUCTS: ${r.day} ${r.account} is a cover with no heavy product`);
    else if (r.light && r.light === r.heavy) errors.push(`PRODUCTS: ${r.day} ${r.account} plugs ${r.heavy} as both heavy and light`);
  }

  // POT LENGTH (Run 4, clara Tue 09-15). A pot is the greenhouse body VERBATIM plus the page's
  // sign-off, plus one more tweet on a page with a siteCta. The greenhouse never sees the page, so a
  // 21-tweet body was fine on every page but clara, where publish-thread refused it at 24 (max 23)
  // and the row came back NO_CONFIRMED_DRAFT at ship time, after the links were minted. Counted
  // here from the same parts publish-thread assembles, so the plan says no before anything is spent.
  // A row whose page or body cannot be resolved is left alone: the ship gates still stand behind it.
  const maxThread = Number(process.env.MAX_THREAD_TWEETS ?? LAWS.tweet?.maxThread ?? 23);
  const roster = accounts || ACCOUNTS, loadPot = readPot || readGreenhouse;
  for (const r of rows) {
    if (String(r.bucket) !== 'pot' || !r.greenhouse) continue;
    const acc = roster?.[r.account], pot = loadPot(r.greenhouse);
    if (!acc || !Array.isArray(pot?.tweets)) continue;
    const at = potPublishLength(pot, acc);
    if (at > maxThread) errors.push(`POT LENGTH: ${r.day} ${r.account} plants ${r.greenhouse} at ${at} tweets (${pot.tweets.length} body + sign-off${acc.siteCta ? ' + the page\'s site line' : ''}) over the ${maxThread} cap — swap the pot, or plant it on a page without a siteCta`);
  }

  // GRID. Optional — a plan without one is fine and batch-publish takes --grid instead — but a plan
  // that HAS one is the thing that publishes, so it gets checked. Two accounts on one minute is a
  // double-booking; a slotted account with no time silently drops out of the run.
  if (plan.grid && typeof plan.grid === 'object') {
    const times = new Map();
    for (const [acc, hm] of Object.entries(plan.grid)) {
      if (!/^[0-2]\d:[0-5]\d$/.test(String(hm))) { errors.push(`GRID: ${acc} has time "${hm}", expected HH:MM`); continue; }
      if (times.has(hm)) errors.push(`GRID: ${acc} and ${times.get(hm)} both post at ${hm}`);
      else times.set(hm, acc);
    }
    for (const r of rows) if (r.account && !plan.grid[r.account] && !r.at) errors.push(`GRID: ${r.day} ${r.account} has a slot but no time`);
  }

  // TIME (R1, 2026-09-23). A row that carries `at` is published at exactly that minute (batch-publish
  // prefers it over the grid), so it gets the checks the grid gets and the ones a grid cannot need:
  // it is on its own Saigon day, inside a live block (never on an exclusive block end), and clear of
  // every other timed row by the fleet floor. A slotId, when present, must name the row's page-day.
  const timed = [];
  for (const r of rows.filter((x) => x.at != null)) {
    const ms = Date.parse(r.at);
    if (!Number.isFinite(ms) || ms % 60_000) { errors.push(`TIME: ${r.day} ${r.account} has at "${r.at}", expected an exact ISO minute`); continue; }
    const saigon = new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
    if (saigon !== r.day) errors.push(`TIME: ${r.day} ${r.account} is timed on ${saigon} Saigon, not its plan day`);
    const win = windowForUtc(new Date(ms).toISOString());
    if (String(r.bucket || 'cover') !== 'single' && (!win || win.day !== saigon || win.block === 'Sun')) errors.push(`TIME: ${r.day} ${r.account} at ${r.at} is outside a live posting block`);
    if (r.slotId && r.slotId !== `S${r.day.slice(5, 7)}${r.day.slice(8, 10)}-${r.account}`) errors.push(`TIME: ${r.day} ${r.account} carries slot ${r.slotId}, which is not its page-day`);
    timed.push({ r, ms });
  }
  timed.sort((a, b) => a.ms - b.ms);
  for (let i = 1; i < timed.length; i++) {
    const gap = (timed[i].ms - timed[i - 1].ms) / 60_000;
    if (gap < MIN_SLOT_GAP_MIN) errors.push(`TIME: ${timed[i - 1].r.account} and ${timed[i].r.account} are ${gap} min apart at ${timed[i].r.at} (minimum ${MIN_SLOT_GAP_MIN})`);
  }

  // Advisory: an account selling the same heavy bottle on consecutive days reads as a loop. Not an
  // error — the operator may want a deliberate repeat — but it is the thing you want to see.
  const byAcc = new Map();
  for (const r of rows.filter((x) => String(x.bucket || 'cover') === 'cover' && x.heavy)) {
    if (!byAcc.has(r.account)) byAcc.set(r.account, []);
    byAcc.get(r.account).push([r.day, r.heavy]);
  }
  for (const [acc, list] of byAcc) {
    const sorted = list.sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][1] === sorted[i - 1][1]) warnings.push(`${acc} sells ${sorted[i][1]} on ${sorted[i - 1][0]} and again on ${sorted[i][0]}`);
    }
  }

  // CALENDAR — dates are computed, never typed. Run 2 (2026-09-07) was planned as "Mon Sep 8":
  // Sep 7 was the Monday, the run started a day late, and thirteen drafts were moved on the morning
  // the operator noticed. Every day key must be a real date, and any "Mon Sep 8"-style label in the
  // plan's prose must agree with what that date actually is.
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const calendar = [];
  for (const day of Object.keys(days)) {
    const wd = weekdayOf(day);
    if (!wd) errors.push(`CALENDAR: day key "${day}" is not a YYYY-MM-DD date`);
    else calendar.push(`${wd} ${day.slice(5)}`);
  }
  const year = (Object.keys(days).find((d) => weekdayOf(d)) || '').slice(0, 4);
  const prose = [plan.note, plan.run, plan.label, ...rows.map((r) => r.note)].filter(Boolean).join(' \n ');
  if (year) {
    for (const m of prose.matchAll(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/g)) {
      const ymd = `${year}-${String(MO.indexOf(m[2]) + 1).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      const real = weekdayOf(ymd);
      if (real && real !== m[1]) errors.push(`CALENDAR: "${m[0]}" — ${ymd} is a ${real}`);
    }
  }

  const donors = new Set(rows.filter((r) => r.donor).map((r) => r.donor));
  return { errors, warnings, summary: { slots: rows.length, days: Object.keys(days).length, buckets, target, donors: donors.size, calendar, checkpoint: blocked === null ? 'not recorded' : blocked ? '⛔ pots held' : '✅ pots allowed' } };
}

/** PURE. "Mon" for a YYYY-MM-DD, null for anything that is not a real date. UTC, like the plan. */
export function weekdayOf(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
  const d = new Date(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) return null;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node plan-check.mjs <queues/run-YYYY-MM-DD.json> [--phase N] [--pots-blocked|--pots-ok]'); process.exit(2); }
  const i = process.argv.indexOf('--phase');
  const phase = i > 0 ? Number(process.argv[i + 1]) : 1;
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const potsBlocked = process.argv.includes('--pots-blocked') ? true : process.argv.includes('--pots-ok') ? false : null;
  const { errors, warnings, summary } = checkPlan(plan, { phase, potsBlocked });
  console.log(`\n${plan.batch || file} — ${summary?.slots ?? 0} slot(s) over ${summary?.days ?? 0} day(s), ${summary?.donors ?? 0} distinct donor(s)`);
  if (summary?.calendar?.length) console.log(`  ${summary.calendar.join(' · ')}`);
  if (summary?.checkpoint) console.log(`  checkpoint: ${summary.checkpoint}`);
  console.log('');
  if (summary?.target) {
    console.log('  bucket    plan   phase ' + phase);
    for (const b of ['cover', 'harvest', 'pot']) console.log(`  ${b.padEnd(9)} ${String(summary.buckets[b] || 0).padStart(4)}   ~${summary.target[b]}`);
    console.log('');
  }
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(errors.length ? `\n✗ ${errors.length} breach(es) — fix the plan before writing a word of it` : '\n✓ plan is sound');
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
