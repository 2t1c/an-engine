// reconcile-handles.mjs — keep the swipe DB's tracked-creator handles true to their RestIDs.
//
// WHY (operator, 2026-08-12): "we must use the REST ID to track the account, because there's a very
// high chance they change the handle and then we're dead."
//
// The risk is real. n8n's "Track Users Timelines" fetches each creator with a SEARCH:
//     from:{{ $json.Handle }} -filter:replies
// so the handle is the lookup key. If a creator renames, that query silently returns nothing: no
// error, no alert, the workflow still reports success, and that creator simply stops producing swipe
// rows. Same silent-failure shape as the Niche bug.
//
// The obvious fix — fetch by RestID instead — was measured and REJECTED: twitter241's
// /user-tweets?user=<rest_id> returns only ~6 posts per creator regardless of the count parameter,
// versus ~15 for the handle search, and misses 13 of the 15 the search finds. Swapping the fetch
// would have cost ~85% of ingestion to buy rename-safety.
//
// So RestID becomes the IDENTITY ANCHOR instead of the fetch key: this job resolves every tracked
// creator's immutable RestID to their CURRENT handle and writes it back when it has drifted. The
// search keeps its coverage, and a rename self-corrects within a day instead of blacking that
// creator out indefinitely. Suspended / deleted accounts are reported, never auto-untracked — that
// is an operator decision.
//
// Runs on GitHub Actions per the cross-repo ownership rule in n8n-x-pipeline's README:
// "GitHub Actions owns anything on a schedule; n8n keeps webhook/event-driven work."
//
//   node reconcile-handles.mjs --dry     # report drift, write nothing
//   node reconcile-handles.mjs           # fix drifted handles + alert
import { loadEnv, requireEnv, airtable, telegram, esc, report, logRun } from './lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const USERS_TABLE = 'Users';
const RAPID_HOST = 'twitter241.p.rapidapi.com';

// Resolve a RestID to its live handle. Returns:
//   { handle }            — live account, current screen_name
//   { unavailable: '...' } — suspended / deleted / withheld (X still knows the id, the account is gone)
//   { error: '...' }       — transport or parse failure; caller treats it as UNKNOWN, never as drift
export async function resolveRestId(env, restId, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://${RAPID_HOST}/get-users?users=${encodeURIComponent(restId)}`, {
      headers: { 'x-rapidapi-host': RAPID_HOST, 'x-rapidapi-key': env.RAPIDAPI_KEY },
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const res = j?.result?.data?.users?.[0]?.result;
    if (!res) return { error: 'unparsed' };
    if (res.__typename && res.__typename !== 'User') return { unavailable: res.reason || res.message || res.__typename };
    const handle = res.core?.screen_name || res.legacy?.screen_name;
    return handle ? { handle } : { error: 'no screen_name' };
  } catch (e) { return { error: (e.message || 'fetch failed').slice(0, 60) }; }
}

// Pure decision step — exported so the drift/unavailable/unknown split is unit-tested without network.
export function classify(stored, resolved) {
  if (resolved.error) return { state: 'unknown', detail: resolved.error };
  if (resolved.unavailable) return { state: 'unavailable', detail: resolved.unavailable };
  if (!stored) return { state: 'drift', detail: resolved.handle };
  return resolved.handle.toLowerCase() === stored.toLowerCase()
    ? { state: 'ok', detail: resolved.handle }
    : { state: 'drift', detail: resolved.handle };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'RAPIDAPI_KEY']);
  const at = airtable(env);
  const users = await at.list(USERS_TABLE, { formula: '{Track User}="True"', fields: ['Handle', 'RestID', 'Name'], pageSize: 100 });
  console.log(`tracked creators: ${users.length}`);

  const drift = [], gone = [], unknown = [];
  for (const u of users) {
    const stored = (u.fields.Handle || '').trim();
    const rest = (u.fields.RestID || '').trim();
    // No RestID = no anchor to reconcile against. Report it: that row can never self-heal.
    if (!rest) { unknown.push({ id: u.id, stored, why: 'no RestID stored' }); continue; }
    const c = classify(stored, await resolveRestId(env, rest));
    if (c.state === 'drift') drift.push({ id: u.id, stored, live: c.detail, rest });
    else if (c.state === 'unavailable') gone.push({ id: u.id, stored, why: c.detail, rest });
    else if (c.state === 'unknown') unknown.push({ id: u.id, stored, why: c.detail });
    await new Promise((r) => setTimeout(r, 350)); // stay well inside the RapidAPI rate budget
  }

  for (const d of drift) console.log(`  ↻ @${d.stored} -> @${d.live}  (RestID ${d.rest})`);
  for (const g of gone) console.log(`  ✗ @${g.stored} unavailable: ${g.why}`);
  for (const u of unknown) console.log(`  ? @${u.stored} unresolved: ${u.why}`);
  console.log(`renamed: ${drift.length} · unavailable: ${gone.length} · unresolved: ${unknown.length} · ok: ${users.length - drift.length - gone.length - unknown.length}`);
  if (DRY) { console.log('(dry run — nothing written)'); return; }

  let fixed = 0;
  for (let i = 0; i < drift.length; i += 10) {
    const batch = drift.slice(i, i + 10);
    const r = await fetch(`https://api.airtable.com/v0/${env.XDB_BASE_ID}/${encodeURIComponent(USERS_TABLE)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch.map((d) => ({ id: d.id, fields: { Handle: d.live } })) }),
    });
    if (!r.ok) { console.error(`PATCH failed (${r.status}): ${(await r.text()).slice(0, 200)}`); process.exitCode = 1; break; }
    fixed += batch.length;
  }
  if (fixed) console.log(`updated ${fixed} handle(s) — the tracker's from:@handle search now resolves again`);

  // Alert only when something actually needs a human: a rename we auto-fixed (so the operator knows the
  // creator moved) or an account that is gone (which we deliberately do NOT untrack automatically).
  if ((drift.length || gone.length) && env.TELEGRAM_BOT_TOKEN) {
    try {
      await telegram(env, report({
        emoji: '🪪', title: 'Tracked creator handles', scope: `${users.length} creators`,
        status: `${drift.length ? `↻ <b>${drift.length}</b> renamed (auto-fixed)` : '✅ no renames'}${gone.length ? ` · ✗ <b>${gone.length}</b> unavailable` : ''}`,
        sections: [
          ...(drift.length ? [{ label: 'RENAMED', body: drift.map((d) => `• @${esc(d.stored)} → <b>@${esc(d.live)}</b>`).join('\n') }] : []),
          ...(gone.length ? [{ label: 'UNAVAILABLE', body: gone.map((g) => `• @${esc(g.stored)} — ${esc(g.why)}`).join('\n') }] : []),
        ],
        action: gone.length ? 'Untrack the unavailable creator(s) in Airtable if they are not coming back.' : 'No action needed — the tracker picks up the new handle on its next run.',
      }), 'ops');
    } catch (e) { console.log(`alert send failed (handles already fixed): ${(e.message || '').slice(0, 120)}`); }
  }
  await logRun('reconcile-handles', { creators: users.length, renamed: drift.length, fixed, unavailable: gone.length, unresolved: unknown.length });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
