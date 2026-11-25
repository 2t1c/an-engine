#!/usr/bin/env node
// The posting calendar of a collaborative /run, computed at the brief (stop 1) and checked again at
// the calendar stop (stop 5). Owner, 2026-09-23: "even the posting schedule should be in step one of
// the plan." Pure: occupancy is supplied by the caller (scripts/run-occupancy.mjs reads it), nothing
// here talks to Typefully, and a calendar is never authority to schedule a post on its own.
//
// A calendar is a list of SLOTS: page × Saigon date × exact minute × platforms. Every slot's minute
// starts at the page's own coverGrid minute (slots.mjs, the one definition of when a page posts) and
// is nudged only when the same legality check stop 5 runs says the grid minute cannot be used. Each
// nudge is deterministic and names its reason. From selection onward a row's ID is its slot ID
// (`S0925-julian`), so every later stop can say which approved minute it is bound to.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACCOUNTS } from '../accounts.mjs';
import {
  GENERATIVE_WINDOWS, MIN_SLOT_GAP_MIN, clockRanges, coverGrid, fleetSlotKeys, inSinglesWindow,
  singleSlotIssue, spreadWindow, windowForUtc,
} from '../slots.mjs';
import { check, checkRow, rowMarker } from './run-studio.mjs';
import { ADDITIVE_LANES, ARTICLE_LANE } from '../lanes.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const SCHEDULE_LEAD_MIN = 15;
export const SINGLE_INTRA_GAP_MIN = 75;
export const TODAY_NOT_BEFORE_HOURS = 4;
export const SLOTS_MARKER = 'PI_RUN_SLOTS_V1';
export const SLOT_STATUSES = ['open', 'booked', 'unknown', 'rest', 'held'];
const LANE_ORDER = ['cover', 'harvest', 'seed'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Saigon calendar date of a UTC instant. */
export const saigonDate = (ms) => new Date(ms + 7 * HOUR_MS).toISOString().slice(0, 10);
/** "HH:MM" Saigon clock of a UTC instant. */
export const saigonClock = (ms) => new Date(ms + 7 * HOUR_MS).toISOString().slice(11, 16);
const utcMinute = (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes();
const isoMinute = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, ':00Z');
/** `S<MMDD>-<account>`: fits run-studio's row ID pattern. */
export const slotIdOf = (date, account) => `S${date.slice(5, 7)}${date.slice(8, 10)}-${account}`;

/** The legal instants of a Saigon date's generative blocks, as [firstMs, lastMs] pairs in order. */
export function blockRanges(date) {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return GENERATIVE_WINDOWS.flatMap((w) => clockRanges(w).map(([lo, hi, shift]) => ({
    block: w.block, first: midnight + (lo - shift * 1440) * MINUTE_MS, last: midnight + (hi - shift * 1440) * MINUTE_MS,
  }))).filter((r) => { const win = windowForUtc(new Date(r.first).toISOString()); return win?.day === date; })
    .sort((a, b) => a.first - b.first);
}

// ---- slot legality (moved out of run-schedule-preflight.mjs, which now imports it) ----------------
/** True for a lane that posts beside the page-day's money thread (a single, an article) and is never it. */
const additive = (lane) => ADDITIVE_LANES.includes(lane);

/**
 * PURE. The reason post `b` makes post `a` illegal, or null. Posts are {account, lane, ms, draftId}.
 * An article rides beside the page-day's money thread (owner, R2026-10-03: "Every account should do
 * ≥2 articles a week"): it never collides with a thread or a single on its page-day, but two articles
 * on one page-day do. A QRT rides beside it the same way, any number a day (lanes.mjs QRT_LANE). The
 * fleet minute gap still applies to both like any other post.
 */
export function collisionReason(a, b) {
  if (!Number.isFinite(a.ms) || !Number.isFinite(b.ms)) return null;
  if (a.draftId && b.draftId && a.draftId === b.draftId && a.account === b.account) return 'draft is already booked';
  const sameDay = saigonDate(a.ms) === saigonDate(b.ms);
  if (a.lane === ARTICLE_LANE && b.lane === ARTICLE_LANE && a.account === b.account && sameDay) {
    return `account already has an article on ${saigonDate(a.ms)}`;
  }
  if (!additive(a.lane) && !additive(b.lane) && a.account === b.account && sameDay) {
    return `account already has a money thread on ${saigonDate(a.ms)}`;
  }
  const gapMs = Math.abs(a.ms - b.ms);
  if (gapMs < MIN_SLOT_GAP_MIN * MINUTE_MS) return `fleet slot is ${Math.floor(gapMs / MINUTE_MS)} minutes from another post (minimum ${MIN_SLOT_GAP_MIN})`;
  if (sameDay && a.account === b.account && a.lane === 'single' && b.lane === 'single' && gapMs < SINGLE_INTRA_GAP_MIN * MINUTE_MS) {
    return `own singles are ${Math.floor(gapMs / MINUTE_MS)} minutes apart (minimum ${SINGLE_INTRA_GAP_MIN})`;
  }
  if (sameDay && a.account === b.account && a.lane !== b.lane && (a.lane === 'single' || b.lane === 'single')) {
    const single = a.lane === 'single' ? a : b, thread = a.lane === 'single' ? b : a;
    // The Moon rule spaces a single from the page's THREAD; an article or a QRT beside it is not one.
    if (!additive(thread.lane)) {
      const issue = singleSlotIssue(utcMinute(single.ms), [utcMinute(thread.ms)]);
      if (issue?.includes('from a thread in Moon')) return issue;
    }
  }
  return null;
}

/** PURE. Why a post's own time is illegal: past the poller guard, or outside its lane's window. */
export function timeIssues(post, nowMs) {
  const issues = [];
  if (!Number.isFinite(post.ms)) return ['time is invalid'];
  if (post.ms - nowMs < SCHEDULE_LEAD_MIN * MINUTE_MS) issues.push('slot is past or inside the 15-minute Typefully poller guard');
  if (post.lane === 'single') {
    if (!inSinglesWindow(utcMinute(post.ms))) issues.push('single is outside the current singles windows');
  } else {
    const win = windowForUtc(new Date(post.ms).toISOString());
    if (!win || win.day !== saigonDate(post.ms) || win.block === 'Sun') issues.push(`${post.lane === ARTICLE_LANE ? 'article' : 'money thread'} is outside an active posting block`);
  }
  return issues;
}

/**
 * PURE. Every reason `post` cannot be booked: its own time, then each collision with `others`
 * (each may carry a `label`, appended in parentheses exactly as stop 5 prints it).
 */
export function slotIssues(post, { nowMs, others = [] } = {}) {
  const issues = timeIssues(post, nowMs);
  for (const other of others) {
    if (other === post || (other.id != null && other.id === post.id)) continue;
    const reason = collisionReason(post, other);
    if (reason) issues.push(other.label ? `${reason} (${other.label})` : reason);
  }
  return issues;
}

/**
 * PURE. The nearest legal minute to `fromMs` on Saigon `date`: the first one at or after it, else
 * (the day's blocks are full after it) the last one before it. Legal means inside a live block, not
 * before `notBeforeMs`, and clear of every post in `others`. Null when the day has none. Scans minute
 * by minute, so the answer is deterministic and the smallest possible move.
 */
export function nextLegalMinute(post, fromMs, { date, nowMs, others = [], notBeforeMs = -Infinity } = {}) {
  const floor = Math.ceil(notBeforeMs / MINUTE_MS) * MINUTE_MS;
  const start = Math.max(Math.ceil(fromMs / MINUTE_MS) * MINUTE_MS, floor);
  const legal = (ms) => !slotIssues({ ...post, ms }, { nowMs, others }).length;
  const ranges = blockRanges(date);
  for (const range of ranges) {
    for (let ms = Math.max(start, range.first); ms <= range.last; ms += MINUTE_MS) if (legal(ms)) return ms;
  }
  for (const range of [...ranges].reverse()) {
    for (let ms = Math.min(start - MINUTE_MS, range.last); ms >= Math.max(range.first, floor); ms -= MINUTE_MS) if (legal(ms)) return ms;
  }
  return null;
}

function restMatches(restDays, date, account) {
  return (restDays || []).some((r) => r?.date === date && (!Array.isArray(r.accounts) || !r.accounts.length || r.accounts.includes(account)));
}

/** PURE. Deal `n` slots to lanes in proportion to `counts` (largest deficit first); beyond the counts, cover. */
export function dealLanes(counts, n) {
  const weights = LANE_ORDER.map((lane) => Math.max(0, Number(counts?.[lane]) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const given = LANE_ORDER.map(() => 0);
  const out = [];
  for (let j = 0; j < n; j++) {
    if (j >= total) { out.push('cover'); continue; }
    let best = 0, bestDeficit = -Infinity;
    for (let i = 0; i < LANE_ORDER.length; i++) {
      if (given[i] >= weights[i]) continue;
      const deficit = (weights[i] / total) * (j + 1) - given[i];
      if (deficit > bestDeficit) { bestDeficit = deficit; best = i; }
    }
    given[best] += 1; out.push(LANE_ORDER[best]);
  }
  return out;
}

export const slotSha256 = (slot) => sha256(JSON.stringify({ slotId: slot.slotId, account: slot.account, date: slot.date,
  status: slot.status, utc: slot.utc ?? null, platforms: slot.platforms ?? [] }));

/**
 * PURE. The run's calendar.
 *  dates        Saigon dates of the run
 *  accounts     the run's pages
 *  fleetKeys    the grid basis (default: every posting account, slots.mjs fleetSlotKeys)
 *  occupancy    { capturedAt, complete, coverage:[{account,platform,date,complete}], bookings:[{account,lane,publishAtUtc,draftId,platforms}] }
 *  restDays     [{ date, accounts? }] — no accounts means the whole fleet rests
 *  holds        [{ account, date, reason }] — page-days the owner holds; a held slot stays empty
 *  todayNotBefore  ISO instant; slots before it are re-spread after it
 *  laneCounts   { cover, harvest, seed } — the brief's lane plan; lanes are proposals until selection
 */
export function planCalendar({ dates, accounts, fleetKeys = fleetSlotKeys(ACCOUNTS), platformsOf = defaultPlatforms,
  occupancy = {}, restDays = [], holds = [], todayNotBefore = null, now = new Date(), laneCounts = null } = {}) {
  if (!Array.isArray(dates) || !dates.length) throw new Error('dates[] is required');
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('accounts[] is required');
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid current time');
  const notBeforeMs = todayNotBefore == null ? nowMs + TODAY_NOT_BEFORE_HOURS * HOUR_MS : Date.parse(todayNotBefore);
  if (!Number.isFinite(notBeforeMs)) throw new Error('todayNotBefore must be an ISO instant');
  const grid = coverGrid([...new Set([...fleetKeys, ...accounts])]);
  const complete = occupancy?.complete === true && Array.isArray(occupancy?.bookings);
  const coverage = new Map();
  for (const item of Array.isArray(occupancy?.coverage) ? occupancy.coverage : []) {
    if (!item?.account || !item.date || !item.platform) continue;
    const key = `${item.account}|${item.platform}|${item.date}`;
    coverage.set(key, (coverage.get(key) ?? true) && item.complete === true);
  }
  const booked = (Array.isArray(occupancy?.bookings) ? occupancy.bookings : []).map((b, index) => ({
    id: `booking-${index + 1}`, account: b?.account, lane: b?.lane, ms: Date.parse(b?.publishAtUtc || ''),
    draftId: b?.draftId == null ? null : String(b.draftId),
    label: `booked ${b?.draftId ?? `#${index + 1}`}`,
  })).filter((b) => b.account && Number.isFinite(b.ms));

  const slots = [];
  const candidates = [];
  for (const date of [...dates].sort()) {
    for (const account of [...accounts].sort()) {
      const slotId = slotIdOf(date, account);
      const platforms = platformsOf(account);
      const base = { slotId, account, date, platforms, lane: null, utc: null, local: null, block: null, gridUtc: null, nudges: [], reason: null };
      const hold = (holds || []).find((h) => h?.account === account && h?.date === date);
      if (restMatches(restDays, date, account)) { slots.push({ ...base, status: 'rest', reason: 'rest day' }); continue; }
      if (hold) { slots.push({ ...base, status: 'held', reason: hold.reason || 'held by the owner' }); continue; }
      const covered = complete && platforms.every((p) => coverage.get(`${account}|${p}|${date}`) === true);
      if (!covered) { slots.push({ ...base, status: 'unknown', reason: 'occupancy for this page-day was not read to completion' }); continue; }
      const existing = booked.filter((b) => b.account === account && !additive(b.lane) && saigonDate(b.ms) === date);
      if (existing.length) {
        slots.push({ ...base, status: 'booked', reason: `already booked: ${existing.map((b) => `${saigonClock(b.ms)} ICT (${b.draftId ?? 'no id'})`).join(', ')}`, existing: existing.map((b) => ({ draftId: b.draftId, utc: isoMinute(b.ms), lane: b.lane })) });
        continue;
      }
      const hm = grid[account];
      if (!hm) { slots.push({ ...base, status: 'held', reason: 'page has no grid minute' }); continue; }
      const gridMs = Date.parse(`${date}T${hm}:00Z`);
      candidates.push({ ...base, status: 'open', gridMs, gridUtc: isoMinute(gridMs) });
    }
  }

  // Re-spread: on each date, the candidates whose grid minute falls before todayNotBefore are spread
  // across what is left of that day, in grid order, then legality-checked like every other slot.
  const target = new Map();
  for (const date of [...new Set(candidates.map((c) => c.date))]) {
    const early = candidates.filter((c) => c.date === date && c.gridMs < notBeforeMs).sort((a, b) => a.gridMs - b.gridMs || a.account.localeCompare(b.account));
    if (!early.length) continue;
    const ranges = blockRanges(date);
    const dayLast = ranges.length ? ranges.at(-1).last : -Infinity;
    const from = Math.ceil(notBeforeMs / MINUTE_MS) * MINUTE_MS;
    if (from > dayLast) { for (const c of early) target.set(c, { ms: null, why: `grid ${saigonClock(c.gridMs)} ICT is before todayNotBefore ${saigonClock(notBeforeMs)} ICT and no block time is left that day` }); continue; }
    const base = Date.parse(`${date}T00:00:00Z`);
    const spread = spreadWindow({ startMin: (from - base) / MINUTE_MS, endMin: (dayLast - base) / MINUTE_MS + 1 }, early.length).minutes;
    early.forEach((c, i) => target.set(c, { ms: base + spread[i] * MINUTE_MS, why: `grid ${saigonClock(c.gridMs)} ICT is before todayNotBefore ${saigonClock(notBeforeMs)} ICT; re-spread after it` }));
  }

  const placed = [];
  // Pages still on their grid minute are placed first, so they keep it; re-spread pages fit around them.
  const order = candidates.map((c) => ({ c, moved: target.has(c) ? 1 : 0, start: target.has(c) ? (target.get(c).ms ?? Infinity) : c.gridMs }))
    .sort((a, b) => a.c.date.localeCompare(b.c.date) || a.moved - b.moved || (a.start === b.start ? 0 : a.start - b.start) || a.c.account.localeCompare(b.c.account));
  for (const { c, start } of order) {
    const post = { id: c.slotId, account: c.account, lane: 'cover', label: `proposed ${c.slotId}` };
    const others = [...booked, ...placed];
    const moved = target.get(c);
    if (moved && moved.ms == null) { slots.push({ ...c, status: 'held', reason: moved.why }); continue; }
    const nudges = moved ? [{ from: c.gridUtc, reason: moved.why }] : [];
    const firstIssues = slotIssues({ ...post, ms: start }, { nowMs, others });
    const ms = firstIssues.length ? nextLegalMinute(post, start, { date: c.date, nowMs, others, notBeforeMs }) : start;
    if (ms == null) { slots.push({ ...c, status: 'held', nudges, reason: `no legal minute left on ${c.date}: ${firstIssues[0]}` }); continue; }
    if (ms !== start) nudges.push({ from: isoMinute(start), reason: firstIssues[0] });
    const slot = { ...c, utc: isoMinute(ms), local: `${c.date}T${saigonClock(ms)}+07:00`, block: windowForUtc(isoMinute(ms))?.block ?? null, nudges };
    slots.push(slot);
    placed.push({ ...post, ms });
  }

  const open = slots.filter((s) => s.status === 'open').sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
  const lanes = dealLanes(laneCounts, open.length);
  open.forEach((s, i) => { s.lane = lanes[i]; s.laneSource = laneCounts ? 'lane plan' : 'default'; });
  const clean = slots.map(({ gridMs, ...s }) => ({ ...s, sha256: slotSha256(s) }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.utc || '~').localeCompare(b.utc || '~') || a.account.localeCompare(b.account));
  const rules = { minGapMin: MIN_SLOT_GAP_MIN, leadMin: SCHEDULE_LEAD_MIN, onePerPageDay: true, grid: 'slots.mjs coverGrid',
    blockEndExclusive: true, todayNotBefore: isoMinute(notBeforeMs) };
  const summary = Object.fromEntries(SLOT_STATUSES.map((s) => [s, clean.filter((x) => x.status === s).length]));
  summary.nudged = clean.filter((x) => x.status === 'open' && x.nudges.length).length;
  return { schema: 'run-calendar-v1', rules, occupancySha256: sha256(JSON.stringify(occupancy ?? null)),
    occupancyCapturedAt: occupancy?.capturedAt ?? null, slots: clean, summary };
}

function defaultPlatforms(account) {
  return (ACCOUNTS[account]?.crossPost || []).includes('threads') ? ['x', 'threads'] : ['x'];
}

// ---- the brief marker ---------------------------------------------------------------------------
/** The brief's last line: rules, the occupancy sha and every slot with its sha256. */
export function slotsMarker(calendar) {
  const body = { rules: calendar.rules, occupancySha256: calendar.occupancySha256,
    slots: calendar.slots.map((s) => ({ slotId: s.slotId, account: s.account, date: s.date, status: s.status,
      utc: s.utc, platforms: s.platforms, lane: s.lane, sha256: s.sha256 })) };
  return `<!-- ${SLOTS_MARKER} ${JSON.stringify(body)} -->`;
}

/** PURE. The marker a brief ends with, verified slot by slot; null when the brief has none (a pre-calendar brief). */
export function parseSlotsMarker(text) {
  const body = String(text || '');
  if (!body.includes(`<!-- ${SLOTS_MARKER} `)) return null;
  const line = body.trimEnd().split('\n').at(-1);
  const match = line?.match(new RegExp(`^<!-- ${SLOTS_MARKER} (\\{.*\\}) -->$`));
  if (!match || body.split(`<!-- ${SLOTS_MARKER} `).length !== 2) throw new Error(`${SLOTS_MARKER} must appear once, as the brief's last line`);
  const parsed = JSON.parse(match[1]);
  if (!Array.isArray(parsed.slots)) throw new Error(`${SLOTS_MARKER} has no slots`);
  for (const slot of parsed.slots) {
    if (slotSha256(slot) !== slot.sha256) throw new Error(`${SLOTS_MARKER} slot ${slot.slotId} does not match its sha256`);
  }
  return parsed;
}

/**
 * The approved calendar of a run: the brief must be approved in run-studio, and its snapshot must end
 * with the marker. Returns null for a brief without the marker (today's stop 5 applies unchanged).
 */
export function approvedCalendar(runDir) {
  const brief = check(runDir, 'brief');
  const root = resolve(runDir);
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const entry = state.stages?.brief;
  if (!entry || entry.revision !== brief.revision) throw new Error('The approved brief is not the current brief');
  const parsed = parseSlotsMarker(readFileSync(join(root, 'reviews', entry.snapshot), 'utf8'));
  if (!parsed) return null;
  return { briefRevision: entry.revision, approval: entry.approval, ...parsed,
    bySlot: new Map(parsed.slots.map((s) => [s.slotId, s])) };
}

// ---- rendering (the brief's calendar section) ---------------------------------------------------
const cell = (v) => (v == null || v === '' ? '—' : String(v).replaceAll('|', '\\|').replaceAll('\n', ' '));
export function calendarMarkdown(calendar, { dates = [...new Set(calendar.slots.map((s) => s.date))].sort() } = {}) {
  const lines = ['## The posting calendar — approving this brief approves these times', '',
    `Rules: one money thread per page per Saigon day; at least ${calendar.rules.minGapMin} minutes between any two posts; each page starts at its own grid minute (${calendar.rules.grid}); block ends are exclusive; nothing before **${saigonClock(Date.parse(calendar.rules.todayNotBefore))} ICT ${saigonDate(Date.parse(calendar.rules.todayNotBefore))}** (todayNotBefore). Occupancy captured ${cell(calendar.occupancyCapturedAt)} · sha \`${calendar.occupancySha256.slice(0, 12)}\`.`, '',
    'Stop 5 re-reads the queue and asks you only about a slot that changed; an unchanged slot is written at the minute approved here.', ''];
  for (const date of dates) {
    const rows = calendar.slots.filter((s) => s.date === date);
    lines.push(`### ${date}`, '', '| ICT | UTC | Page | Lane (proposed) | Slot | Block | Already on this page-day | Check |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of rows) {
      const ict = s.utc ? saigonClock(Date.parse(s.utc)) : '—';
      const utc = s.utc ? s.utc.slice(11, 16) : '—';
      const already = s.status === 'booked' ? s.reason.replace(/^already booked: /, '') : '—';
      const check = s.status === 'open' ? (s.nudges.length ? `nudged: ${s.nudges.map((n) => `${n.from.slice(11, 16)} UTC — ${n.reason}`).join('; ')}` : 'grid minute, clear') : `${s.status}${s.reason ? ` — ${s.reason}` : ''}`;
      lines.push(`| ${ict} | ${utc} | ${cell(s.account)} | ${cell(s.lane)} | ${s.slotId} | ${cell(s.block)} | ${cell(already)} | ${cell(check)} |`);
    }
    lines.push('');
  }
  const accounts = [...new Set(calendar.slots.map((s) => s.account))].sort();
  const mark = { open: 'open', booked: 'booked', unknown: '?', rest: 'rest', held: 'held' };
  lines.push('### Page × day', '', `| Page | ${dates.join(' | ')} |`, `| --- | ${dates.map(() => '---').join(' | ')} |`,
    ...accounts.map((a) => `| ${a} | ${dates.map((d) => { const s = calendar.slots.find((x) => x.account === a && x.date === d); return s ? (s.status === 'open' ? `${saigonClock(Date.parse(s.utc))} ${s.lane}` : mark[s.status]) : '—'; }).join(' | ')} |`), '');
  const sm = calendar.summary;
  lines.push(`Summary: **${sm.open} open** slot(s) (${sm.nudged} nudged off the grid) · ${sm.booked} already booked · ${sm.unknown} unknown · ${sm.rest} rest · ${sm.held} held. An unknown page-day is not open: resolve its read before approving.`, '');
  return lines;
}

// ---- binding (selection, products and drafts packets) ---------------------------------------------
const weekdayOf = (date) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T12:00:00Z`));
/** "Thu 12:10 ICT" for a slot, used in packet lines and [REVIEW] titles. */
export const slotWhen = (slot) => (slot?.utc ? `${weekdayOf(slot.date)} ${saigonClock(Date.parse(slot.utc))} ICT` : null);
/**
 * PURE. The slot line a packet row carries, and the hold when the row is off its slot. From selection
 * onward a row's ID is its slot ID; without an approved calendar (an older brief) nothing is added.
 */
export function slotBinding(calendar, row) {
  if (!calendar) return { line: null, hold: null, slot: null };
  const slot = calendar.bySlot?.get(row.id) || (calendar.slots || []).find((s) => s.slotId === row.id) || null;
  if (!slot) return { line: `- Slot: ${row.id} · NOT IN THE APPROVED CALENDAR`, hold: `Row ${row.id} is not a slot of the approved calendar; from selection on, row IDs are slot IDs`, slot: null };
  const line = `- Slot: ${slot.slotId} · ${slot.date} ${slotWhen(slot) || slot.status} (${slot.utc ? `${slot.utc.slice(11, 16)} UTC` : 'no minute'}) · ${(slot.platforms || []).join('+')} · lane ${slot.lane || 'none'} proposed · approved at the brief`;
  if (slot.status !== 'open') return { line, hold: `Slot ${slot.slotId} is ${slot.status} in the approved calendar; a held slot stays empty`, slot };
  if ((row.account && row.account !== slot.account) || (row.date && row.date !== slot.date)) {
    return { line, hold: `Row is off its slot: ${slot.slotId} is ${slot.account} on ${slot.date}, the row says ${row.account || '?'} on ${row.date || '?'}`, slot };
  }
  return { line, hold: null, slot };
}

// ---- the write guard (ship-day --run-dir) --------------------------------------------------------
/**
 * The approved schedule row for a slot: run-studio must report it approved (by the owner, or
 * inherited from the brief for an unchanged slot) and its snapshot must end with PI_RUN_SCHEDULE_V1.
 * Throws otherwise.
 */
export function approvedScheduleRow(runDir, slotId) {
  const current = checkRow(runDir, 'schedule', slotId);
  const root = resolve(runDir);
  const entry = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).rowStages?.schedule?.rows?.[slotId];
  if (!entry || entry.revision !== current.revision) throw new Error('the approved schedule row is not the current one');
  const marker = rowMarker(readFileSync(join(root, 'reviews', entry.snapshot), 'utf8'), 'PI_RUN_SCHEDULE_V1');
  if (!marker?.utc) throw new Error('the approved schedule row carries no PI_RUN_SCHEDULE_V1 time');
  return { ...marker, revision: current.revision, inherited: entry.approval?.inherited?.from ?? null };
}

/**
 * PURE over `read`. Every plan row about to be written must name its slot (`slotId`, else its `id`),
 * carry the exact `at`, and match the approved schedule row: same page, same minute. Anything else is
 * SLOT_NOT_APPROVED — the thread is not written.
 */
export function slotWriteGuard(rows, runDir, { read = approvedScheduleRow } = {}) {
  return rows.map((row) => {
    const slotId = row.slotId || row.id || null;
    const out = { account: row.account, slotId, at: row.at ?? null, ok: false, reason: null };
    if (!slotId) return { ...out, reason: 'plan row names no slot' };
    if (!row.at || !Number.isFinite(Date.parse(row.at))) return { ...out, reason: 'plan row carries no approved `at`' };
    let approved;
    try { approved = read(runDir, slotId); } catch (error) { return { ...out, reason: error.message }; }
    if (approved.account && approved.account !== row.account) return { ...out, reason: `slot ${slotId} is ${approved.account}'s, not ${row.account}'s` };
    if (Date.parse(approved.utc) !== Date.parse(row.at)) return { ...out, reason: `approved ${approved.utc}, plan says ${row.at}` };
    return { ...out, ok: true, approvedUtc: approved.utc, inherited: approved.inherited };
  });
}
