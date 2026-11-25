// x-followers.mjs — the fleet's follower counts, read from X itself.
//
// Typefully's GET /social-sets/{id}/analytics/x/followers returned a DAILY SERIES, and registry-sync
// re-wrote the last week of Account Metrics rows from it on every run. That endpoint answers 404: the
// 2026-09-30 05:28Z registry run still read it, a read-only check on 2026-10-03 got the 404.
//
// What replaces it: twitter241 on RapidAPI (the transport x-views.mjs and reconcile-handles.mjs use),
// GET /user?username=<handle> -> result.data.user.result.legacy.followers_count. That is the account's
// CURRENT count and nothing else — X has no history endpoint. So the history is the table's own:
//   - each run writes TODAY's row per account (Key "<date> · <account>", upserted, so the day's row
//     converges to the last read of that UTC day);
//   - deltas are looked up by EXACT DATE in the rows Account Metrics already holds (metrics.mjs
//     followerDeltas): no row for yesterday -> blank 1d delta, never a subtraction across a gap.
//
// THE RULE: a count that was not read is ABSENT, never 0. A failed read, an unparsed payload, or a
// payload for a different handle writes no row. A 0 X really reports is a measurement (Lucinda's page,
// opened 2026-09-21, has 0 followers on X and had 0 on every Typefully row since 09-23), but a 0 for a
// page whose last recorded count was ZERO_GUARD or more is a degraded payload and writes no row: a page
// does not lose every follower between two reads, and a suspended one reads as unavailable instead.
import { followerDeltas } from './metrics.mjs';
import { fxUser } from './fx-read.mjs';

const HOST = 'twitter241.p.rapidapi.com';
export const ZERO_GUARD = 50;
const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** PURE. One twitter241 /user payload -> { followers, restId } or { error }. The handle must match:
 *  a renamed page whose old handle was taken by someone else must not record that someone's count. */
export function followersFromUser(json, handle) {
  const u = json?.result?.data?.user?.result;
  if (!u || typeof u !== 'object') return { error: 'no user in the response' };
  if (u.__typename && u.__typename !== 'User') return { error: `account unavailable (${u.reason || u.message || u.__typename})` };
  const screenName = u.core?.screen_name || u.legacy?.screen_name;
  if (!screenName || screenName.toLowerCase() !== String(handle || '').toLowerCase()) return { error: `handle mismatch (asked @${handle}, got @${screenName || '?'})` };
  const n = u.legacy?.followers_count;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { error: `no usable followers_count (${JSON.stringify(n)})` };
  return { followers: n, restId: u.rest_id ? String(u.rest_id) : null };
}

/** X's current follower count per handle. available is false with no RAPIDAPI_KEY; read() then
 *  returns an error, never a number. read(handle) -> { followers, restId } | { error }. 429 and 5xx
 *  are retried; `calls` counts every request sent (the RapidAPI quota is per request). */
// OUTAGE (owner, 2026-11-25): with no key, or once twitter241 refuses the plan (401/403, "not subscribed"
// since 2026-11-24), the count is read from FxTwitter's free profile endpoint instead. X_FOLLOWERS_FX=0 turns that off.
export function xFollowers(env = {}, { fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 4, fxFallback = env.X_FOLLOWERS_FX !== '0' } = {}) {
  const key = env.RAPIDAPI_KEY;
  let rapidDead = false;
  const viaFx = async (handle) => { client.calls++; return fxUser(handle, { fetchImpl, sleepImpl }); };
  const client = {
    available: Boolean(key) || fxFallback,
    calls: 0,
    async read(handle) {
      if (!handle) return { error: 'no handle' };
      if (!key || rapidDead) return fxFallback ? viaFx(handle) : { error: 'RAPIDAPI_KEY not set' };
      let last = 'no response';
      for (let attempt = 0; attempt < tries; attempt++) {
        let res;
        client.calls++;
        try { res = await fetchImpl(`https://${HOST}/user?username=${encodeURIComponent(handle)}`, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key } }); }
        catch (e) { last = (e?.message || 'fetch failed').slice(0, 80); if (attempt < tries - 1) await sleepImpl(1000 * (attempt + 1)); continue; }
        if (res.status === 429 || res.status >= 500) { last = `HTTP ${res.status}`; if (attempt < tries - 1) await sleepImpl(1000 * (attempt + 1) ** 2); continue; }
        if ((res.status === 401 || res.status === 403) && fxFallback) { rapidDead = true; return viaFx(handle); }
        if (!res.ok) return { error: `HTTP ${res.status}` };
        let j;
        try { j = await res.json(); } catch { return { error: 'unparseable response' }; }
        return followersFromUser(j, handle);
      }
      return { error: `${last} after ${tries} tries` };
    },
  };
  return client;
}

/** PURE. Account Metrics records -> Map(account -> [{ date, followers }]). A row without a count is
 *  left out: followerDeltas reads Number(null) as 0, so a blank must never reach it as a baseline. */
export function historyByAccount(records) {
  const map = new Map();
  for (const rec of records || []) {
    const f = rec?.fields || {};
    const date = String(f.Date || '').slice(0, 10);
    if (!f.Account || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isCount(f.Followers)) continue;
    if (!map.has(f.Account)) map.set(f.Account, []);
    map.get(f.Account).push({ date, followers: f.Followers });
  }
  return map;
}

/** PURE. Why a count X returned must not be written, or null. Only a 0 is ever doubted: one after a
 *  recorded count of ZERO_GUARD or more (the account's latest row before `date`). */
export function doubtfulCount(followers, history = [], date = '9999-12-31') {
  if (followers !== 0) return null;
  const prior = history.filter((h) => h.date < date).sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
  return prior && prior.followers >= ZERO_GUARD ? `X says 0 after ${prior.followers} on ${prior.date} — a degraded payload, not a measurement` : null;
}

/** PURE. Today's Account Metrics row for one account. `history` is that account's rows already in the
 *  table; an earlier read of the same day is replaced, not used as a baseline. An unknown delta is
 *  written as null so a re-read never leaves a new count beside a subtraction made from an older one. */
export function followerRow({ account, date, followers, history = [] }) {
  if (!isCount(followers)) throw new Error(`followerRow: no count for ${account} — an unread count writes no row`);
  const series = [...history.filter((h) => h.date !== date), { date, followers }];
  const today = followerDeltas(series).find((d) => d.date === date);
  return {
    'Key': `${date} · ${account}`,
    'Date': date,
    'Account': account,
    'Followers': followers,
    'Follower Delta 1d': today.delta1,
    'Follower Delta 7d': today.delta7,
  };
}
