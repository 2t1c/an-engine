// scripts/reply-guard.mjs — the /run reply-intent guard (plan Track J, Phase 7a). A GUARD THAT CAN ONLY WARN.
//
// run-studio records the owner's words verbatim; this reads the same words with Jev (decisions/reply-intent.mjs,
// shadow) and prints ONE line beside that flow:
//
//   pass      Jev reads this reply as a clear approval of C01, C02 (report-only).
//   warn      Jev reads this reply as unclear for rows C02, C03: confirm with the owner (…). Report-only; …
//   not read  Jev: reply not read (no_client); … exactly as before.
//
// It never records, alters or blocks an approval and never approves: it has no path to run-studio's
// writers, returns a line, and swallows every error into "not read". Owner approvals are the owner's words;
// nothing here is supplied on their behalf.
//
// PI_RUN_REPLY_GUARD: unset or `on` reads with the env's Jev key; `dry` reads with no client (always
// "not read", nothing logged: a rehearsal); `off` skips the guard and prints nothing.
// jev-ask (and with it the Jev SDK) is imported only when a reading is made, so `off` stays cheap.

export const DECISION = 'reply-intent';
export const GUARD_MODES = Object.freeze(['on', 'dry', 'off']);

export function guardMode(env = process.env) {
  const v = String(env.PI_RUN_REPLY_GUARD ?? '').trim().toLowerCase();
  return GUARD_MODES.includes(v) ? v : 'on';
}

const list = (ids) => ids.join(', ');
const codeOf = (error) => String(error?.code || 'guard_error').slice(0, 48);

/** Pure: the one line for a guard result. `recorded` says whether the approval was already recorded. */
export function guardLine(result, { recorded = false } = {}) {
  const after = recorded ? 'the approval above is recorded as given' : 'nothing was recorded';
  if (result.verdict === 'not read') return `Jev: reply not read (${result.code}); ${after}, exactly as before.`;
  if (result.verdict === 'pass') return `Jev reads this reply as a clear approval of ${list(result.targets)} (report-only).`;
  const unclear = [...new Set([...result.unclear, ...result.notApproved])];
  const why = result.reasons.length ? ` (${result.reasons.join('; ')})` : '';
  return unclear.length
    ? `Jev reads this reply as unclear for rows ${list(unclear)}: confirm with the owner${why}. Report-only; ${after}.`
    : `Jev does not read this reply as a clear approval: confirm with the owner${why}. Report-only; ${after}.`;
}

/**
 * Read one reply with the client given. { reply, rows: [{ id, label, position }], targets: [id] } ->
 * { verdict: 'pass' | 'warn' | 'not read', code, targets, unclear, notApproved, reasons, intent, consent, line }.
 * Never throws.
 */
export async function checkReply({ reply, rows, targets }, { client = null, registry, laws, log, cache, recorded = false } = {}) {
  let result;
  try {
    const { ask } = await import('../jev-ask.mjs');
    const out = await ask(DECISION, { reply, rows, targets }, { client, registry, laws, log, cache });
    const d = out.detail;
    if (!out.read || !d || !['pass', 'warn'].includes(out.jevAction)) {
      result = { verdict: 'not read', code: String(out.fallback || 'not read: no detail').replace(/^not read: /, '') };
    } else {
      result = { verdict: out.jevAction, code: null, targets: d.targets, unclear: d.unclear, notApproved: d.notApproved,
        reasons: d.reasons, intent: d.intent, consent: d.consent };
    }
  } catch (error) {
    result = { verdict: 'not read', code: codeOf(error) };
  }
  return { ...result, line: guardLine(result, { recorded }) };
}

/**
 * Read one reply under PI_RUN_REPLY_GUARD: a client from env (`on`), none and no log (`dry`). `client`
 * overrides the env client (tests). Returns checkReply's result; never throws.
 */
export async function readReply(input, { env = process.env, client, recorded = false, ...rest } = {}) {
  try {
    const dry = guardMode(env) === 'dry';
    let c = null;
    if (!dry) c = client !== undefined ? client : await (await import('../jev-ask.mjs')).clientFromEnv();
    return await checkReply(input, { client: c, recorded, ...(dry ? { log: null } : {}), ...rest });
  } catch (error) {
    const result = { verdict: 'not read', code: codeOf(error) };
    return { ...result, line: guardLine(result, { recorded }) };
  }
}

/** The guard as run-studio's approve commands call it. Prints and returns the line; null when off. */
export async function runGuard(input, { env = process.env, print = (l) => console.error(l), recorded = true, ...rest } = {}) {
  if (guardMode(env) === 'off') return null;
  const { line } = await readReply(input, { env, recorded, ...rest });
  try { print(line); } catch { /* a guard line that cannot print changes nothing */ }
  return line;
}
