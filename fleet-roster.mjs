// fleet-roster.mjs — the one place the supply scripts learn how big the fleet is.
//
// Demand history is measured on the pages that were posting when it was written; planning has to be
// done on the pages posting NOW. The Airtable Accounts roster (the operator's on/off panel — see
// accounts.mjs) is the live count. Fail-open: an unreadable roster leaves the fleet term at ×1 and
// says so on the board, rather than crashing a planning script over a lookup.
import { airtable, cliArg } from './lib.mjs';

const ROSTER_BASE = 'app7vXbBugWeCGctD', ROSTER_TABLE = 'tblwn2lLoJBuJKvUv';   // XDB "Accounts"

export async function rosterFleet(env) {
  try {
    const rows = (await airtable(env, env.XDB_BASE_ID || ROSTER_BASE).listAll(ROSTER_TABLE, { fields: ['Active', 'Handle'] })).map((r) => r.fields || r);
    const idle = rows.filter((f) => !f.Active).map((f) => f.Handle || '?');
    return { total: rows.length, active: rows.length - idle.length, idle };
  } catch (e) { return { total: null, active: null, idle: [], error: e.message }; }
}

/** The demand-model flags both scripts share.
 *    --window 14      days of history behind the mean and sigma
 *    --fleet <pages>  pages posting now — defaults to the roster's row count. The operator counts
 *                     pages, not just the ones ticked Active today: a page being warmed will be
 *                     posting inside the cover horizon, so it belongs in the plan.
 *    --base <pages>   pages whose posting the history measured — defaults to the distinct pages
 *                     that fired inside the window
 *    --buffer 1.3     viral allowance on top; --buffer 1 switches it off */
export const DEFAULT_BUFFER = 1.3;
export async function demandOptions(env) {
  const roster = await rosterFleet(env);
  return {
    window: Number(cliArg('window', 14)),
    fleet: Number(cliArg('fleet', roster.total || 0)) || null,
    base: Number(cliArg('base', 0)) || null,
    buffer: Number(cliArg('buffer', DEFAULT_BUFFER)),
    roster,
  };
}

/** One line that says what the plan assumed, for the top of every board. The factors are fleet-wide,
 *  so any vendor's planningDemand result carries them. */
export function describeModel(p, roster) {
  if (!p) return 'demand model: no history';
  const fleet = p.fleet ? `fleet ${p.fleet}/${p.baseFleet} pages ×${p.fleetFactor.toFixed(2)}` : 'fleet term off (no roster, no --fleet)';
  const who = roster && roster.total
    ? ` (roster ${roster.total}: ${roster.active} active${roster.idle.length ? `, not yet: ${roster.idle.join(', ')}` : ''})`
    : roster && roster.error ? ` (roster unreadable: ${roster.error})` : '';
  return `demand = measured (max of ${p.series.length}d mean, since-regime mean) × ${fleet}${who} × viral buffer ×${p.buffer.toFixed(2)}  ⇒  ×${p.scale.toFixed(2)} on measured`;
}
