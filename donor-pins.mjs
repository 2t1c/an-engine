// donor-pins.mjs — donors the owner asked to cover on several pages in one run.
//
// Owner, 2026-09-28, on @BeBetter_Athlet's "Magnesium = Testosterone" (3.5M views, two days old, swapped
// out of R2026-09-27 at the products stop): "Cover it on 3 pages and mint a seed." A run otherwise never
// carries one donor twice (source breadth in the picker, the slot allocator, the run-wide twins rule), so
// a pin is the one declared exception: the donor is placed on up to `pages` of the run's days, one page
// each day, and those copies are not twins of each other. Every other screen still applies to it (the
// view floor, safety, the Jev donor screen, the day's own overlap screen), and no page covers it twice.
//
// queues/donor-pins.json is owner data, like queues/product-queue.json:
//   { "pins": [ { "recId": "rec…", "url": "https://x.com/…", "pages": 3, "from": "YYYY-MM-DD",
//                 "to": "YYYY-MM-DD", "why": "the owner's words", "added": "YYYY-MM-DD" } ] }
// `from`/`to` are the posting days the pin may land on, so it cannot leak into a later run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';

export const PINS_PATH = join(HERE_DIR, 'queues', 'donor-pins.json');
const REC = /^rec[A-Za-z0-9]{14}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Read and validate the pins file. A missing file is no pins; a malformed one throws, because a typo
 *  that silently dropped a pin is the owner's request quietly not happening. */
export function readDonorPins(path = PINS_PATH) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  const pins = JSON.parse(raw).pins || [];
  for (const [i, p] of pins.entries()) {
    if (!REC.test(p?.recId || '')) throw new Error(`donor-pins.json entry ${i}: "recId" must be a swipe record id`);
    if (!Number.isInteger(p.pages) || p.pages < 1) throw new Error(`donor-pins.json ${p.recId}: "pages" must be a whole number of 1 or more`);
    if (!DAY.test(p.from || '') || !DAY.test(p.to || '') || p.from > p.to) throw new Error(`donor-pins.json ${p.recId}: "from" and "to" must be YYYY-MM-DD days, from <= to`);
    if (!String(p.why || '').trim()) throw new Error(`donor-pins.json ${p.recId}: every pin needs a "why" in the owner's words`);
  }
  return pins;
}

/** PURE. The pins that land on `day`: inside their from/to window and placed on fewer than `pages` of
 *  this run's earlier days (`prior` are the run's earlier picker snapshots). */
export function pinsForDay(pins = [], { day, prior = [] } = {}) {
  return pins.filter((p) => p.from <= day && day <= p.to)
    .filter((p) => prior.filter((s) => (s?.selected || []).some((d) => d?.recId === p.recId)).length < p.pages);
}

/** PURE. HIS FRESH WINNERS (owner 2026-09-28, asked whether Cover should prioritise the Direct Competitor
 *  threads that cross 500k views within 24h: "yes. build this into selection"). Swipe records from a
 *  cohort handle, at most `maxAgeDays` old, whose day-one views clear `views`. The swipe row holds today's
 *  count, not the 24h one, so day one is estimated as views / (age in days)^dayOneExponent, never below
 *  one day: a 12h-old thread must already show 500k, a 48h one ~707k, a 72h one ~866k at 0.5. That
 *  exponent is an estimate (no stored view curve backs it), kept in laws.json so it can be refitted.
 *  Returns the qualifiers, highest estimated day one first. */
export function freshWinners(records = [], { handles = [], now = Date.now(), views = 500000, hours = 24,
  maxAgeDays = 3, dayOneExponent = 0.5 } = {}) {
  const cohort = new Set(handles.map((h) => String(h).toLowerCase()));
  const out = [];
  for (const r of records) {
    const f = r?.fields || {};
    const handle = (String(f['Tweet URL'] || '').match(/(?:x|twitter)\.com\/([^/]+)\/status\//i) || [])[1];
    const published = Date.parse(f['Published Date'] || '');
    if (!handle || !cohort.has(handle.toLowerCase()) || !Number.isFinite(published)) continue;
    const ageHours = (now - published) / 36e5;
    if (ageHours < 0 || ageHours > maxAgeDays * 24) continue;
    const seen = Number(f.Impressions) || 0;
    const dayOne = Math.round(seen / Math.pow(Math.max(ageHours, hours) / hours, dayOneExponent));
    if (dayOne >= views) out.push({ recId: r.id, handle, views: seen, ageHours: Math.round(ageHours), dayOne });
  }
  return out.sort((a, b) => b.dayOne - a.dayOne || a.recId.localeCompare(b.recId));
}

/** PURE. The donor ids pinned for any of `dates` (the run's days): what the twins rule and the slot
 *  allocator exempt from "the same donor twice in this run". */
export function pinnedDonors(pins = [], dates = []) {
  return [...new Set(pins.filter((p) => dates.some((d) => p.from <= d && d <= p.to)).map((p) => p.recId))];
}
