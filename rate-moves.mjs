// rate-moves.mjs — the commission rate a realized EPC was EARNED at, so the picker can stop
// ranking a product on terms that no longer exist.
//
// THE DEFECT THIS CLOSES. pick-product ranks on realized lifetime EPC, and EPC is
// CVR x payout x RATE. CVR and payout are measurements of the product; the rate is a term of the
// deal, and Levanta rates move. When Sports Research took our magnesium glycinate from 15% to 40%
// on 2026-09-10, the product's measured EPC stayed $0.2504 — a number earned across 2,082 clicks at
// a rate we no longer pay. Ranked on it, the bottle keeps competing at 15% until enough NEW clicks
// arrive to drag a lifetime average up, which on that click count is thousands of clicks away. The
// better deal we just negotiated is invisible to the thing that decides who gets promoted.
//
// THE FIX. Record every rate move, then restate the measured commission at today's rate before
// ranking. For each day of realized history, scale that day's commission by
// currentRate / rateInForceThatDay. Clicks earned BEFORE the move get corrected; clicks earned
// AFTER it are already at the current rate and are left alone — so the correction fades to nothing
// by itself as new traffic accumulates, with no decay constant to tune and nothing to switch off.
//
// WHY NOT the obvious alternatives, both of which were measured and rejected:
//   • sales x currentRate / clicks — inflates EVERY product by 1.1-1.7x, including ones whose rate
//     never moved, because Levanta's `sales` is the whole attributed basket while `commission` is
//     paid at this product's rate on its own units and Amazon's standard rates on the halo. The
//     implied rate (commission/sales) runs ~30% below nominal for every row on the board, so the
//     "correction" is mostly an artifact of halo attribution and it reshuffles the ranking on noise.
//   • the board's own `rate` column — it is a products.json snapshot taken when the board was
//     built, so it reads the CURRENT rate the moment the board is regenerated. The correction would
//     silently switch itself off one registry sync after the move, which is exactly when it is
//     still needed.
//
// The log is append-only and written by product-health, which already computes `commissionMoves` on
// every weekly sync and previously threw them away after the Telegram digest.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';

export const RATE_MOVES_FILE = join(HERE_DIR, 'learnings', 'rate-moves.jsonl');

/** PURE. Parse the log text into {asin -> [{d, from, to}]}, each list ascending by date.
 *  A malformed line is skipped rather than thrown on: this file only ever makes the ranking more
 *  accurate, so a bad line must degrade to "no correction", never to a crashed plan. */
export function parseRateMoves(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const asin = String(r?.a || '');
    const d = String(r?.d || '');
    const from = Number(r?.from), to = Number(r?.to);
    if (!/^[A-Z0-9]{10}$/.test(asin) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) continue;
    if (!out.has(asin)) out.set(asin, []);
    out.get(asin).push({ d, from, to });
  }
  for (const list of out.values()) list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}

let _moves;
/** The log, memoized. Missing file = no moves = every EPC stands as measured. */
export function rateMoves() {
  if (_moves !== undefined) return _moves;
  try { _moves = parseRateMoves(existsSync(RATE_MOVES_FILE) ? readFileSync(RATE_MOVES_FILE, 'utf8') : ''); }
  catch { _moves = new Map(); }
  return _moves;
}
/** Tests inject their own file; production reads it once. */
export const _resetRateMoves = () => { _moves = undefined; };

/**
 * PURE. The rate in force for `asin` on date `d`, given its move list.
 *
 * Before the first recorded move, the rate is that move's `from` — which is the whole point of
 * storing `from` as well as `to`: the log has to be able to price history that predates it.
 */
export function rateOn(moves, d) {
  if (!moves?.length) return null;
  let rate = moves[0].from;
  for (const m of moves) { if (m.d <= d) rate = m.to; else break; }
  return rate;
}

/**
 * PURE. How much to multiply a product's measured EPC by to restate it at `currentRate`.
 *
 * `dayRows` are this ASIN's levanta-days rows ({d, c, s}) — commission and attributed sales.
 *
 * ONLY THE PRODUCT'S OWN SHARE IS SCALED. A day's commission is not all earned at this product's
 * rate: Amazon pays a halo on whatever else the buyer put in the basket, at THOSE items' rates. On
 * the glycinate's history the halo is 19% of the money, so scaling the whole row 15% -> 40% credits
 * the rate rise with $0.08/click it will never pay. Split it instead: the own share is
 * sales x rateThen (never more than the commission actually received, which is what keeps a
 * returns-reversed day from exploding), the rest is halo, and only the own share moves.
 *
 * The factor is therefore always between 1 and currentRate/rateThen — it can restate the deal and
 * it cannot invent revenue past it.
 *
 * Returns 1 (no change) whenever the answer cannot be trusted: no moves, no earned commission, or a
 * log whose latest `to` disagrees with the live rate — a stale log must never invent a number.
 */
export function restatementFactor(moves, dayRows, currentRate) {
  if (!moves?.length) return 1;
  // A caller that knows the live rate passes it, and the guard below checks the log against it. A
  // caller that only has an ASIN (provenWinner) passes nothing, and the log's own latest `to` stands
  // in — it is the rate the last sync recorded, which is the same thing products.json holds.
  const rate = Number(currentRate) || moves[moves.length - 1].to;
  if (!rate) return 1;
  // A log that does not end where the catalog now sits is out of date (a rate moved and the sync has
  // not run, or someone edited products.json by hand). Fail closed: rank on the measurement.
  if (Math.abs(moves[moves.length - 1].to - rate) >= 0.005) return 1;
  let earned = 0, restated = 0;
  for (const r of dayRows || []) {
    const c = Number(r?.c) || 0;
    if (c <= 0) continue;
    const then = rateOn(moves, String(r?.d || ''));
    if (!then) continue;
    // min(): on a day whose commission came back smaller than the sales imply (a return reversed the
    // money but not the attributed sale), the own share cannot be larger than what we were paid.
    const own = Math.min(c, (Number(r?.s) || 0) * then);
    earned += c;
    restated += own * (rate / then) + (c - own);
  }
  return earned > 0 ? restated / earned : 1;
}

/** PURE. levanta-days text -> {asin -> [{d, c, s}]}. Only the three fields the restatement needs
 *  (date, commission, attributed sales), so a 794KB history collapses to a map the planner can hold. */
export function parseDayCommission(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const a = String(r?.a || ''); const c = Number(r?.c) || 0;
    if (!a || c <= 0) continue;
    if (!out.has(a)) out.set(a, []);
    out.get(a).push({ d: String(r?.d || ''), c, s: Number(r?.s) || 0 });
  }
  return out;
}

let _days;
function dayCommission() {
  if (_days !== undefined) return _days;
  const f = join(HERE_DIR, 'levanta-days.jsonl');
  try { _days = parseDayCommission(existsSync(f) ? readFileSync(f, 'utf8') : ''); }
  catch { _days = new Map(); }
  return _days;
}
export const _resetDayCommission = () => { _days = undefined; };

/**
 * The measured EPC restated at the product's CURRENT commission rate. This is the number the picker
 * should rank on: same traffic, same conversion, today's terms.
 *
 * Returns `epc` unchanged for every product whose rate has not moved, which is most of the catalog —
 * the correction is narrow by construction and cannot quietly reprice the fleet.
 */
export function restatedEpc(asin, epc, currentRate = null, { moves = null, days = null } = {}) {
  const base = Number(epc);
  if (!Number.isFinite(base) || base <= 0) return base;
  // Check the MOVE first and read the day history only if there is one. Most of the catalog has no
  // recorded move, and parsing 5,000 lines of levanta-days to multiply by 1 is work for nothing.
  const ms = (moves || rateMoves()).get(asin);
  if (!ms?.length) return base;
  return base * restatementFactor(ms, (days || dayCommission()).get(asin), currentRate);
}
