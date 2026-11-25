// t0-direct.mjs — fire the T0 baseline RT ping at the SEVEN member networks directly, instead of
// buying it from the broker as one indivisible block.
//
// ===================== SUPERSEDED 2026-09-05 — STAYS DORMANT =====================
// The switch happened, but not through this module: the n8n RT Bridge now sends T0 direct itself
// (its "Fuel Gate" fans one bare-link send per Active Config row tagged Tier "T0", via the Vendor
// Bot, and bills one ledger line per network — see docs/bridge-nodes/ and vendors.json
// bundles.t0Direct). T0 is FIVE networks now (Life Mastery, GL Growth Lab, VOPE, Lewin, All VGNs;
// ConquerMM dropped, Lifepad moved to T1), $4.55 nominal. This module keeps its plan/refuse logic
// and tests as the PI-side fallback sender; T0_DIRECT stays false. Its broker interlock still
// applies: while the broker row is Active the Bridge is in broker mode and nothing else may send.
// ==================================================================================
//
// ============================ DORMANT BY DEFAULT ============================
// This module sends nothing until `T0_DIRECT` in config.mjs is flipped to true AND `--send` is
// passed. Without both it plans and prints. It is built and tested ahead of the decision so the
// switch is the only thing left to do (operator, 2026-09-03: "have it ready, don't turn it on").
// ===========================================================================
//
// WHY, precisely — because the obvious reason is wrong. Going direct does NOT save money. The
// broker's $8.60 is a PASS-THROUGH of what its members charge per ping (Life Mastery $2.30, GL
// Growth Lab $2.30, Lifepad $4.00), not a margin: VOPE and Lewin are on retainers the fleet already
// pays and All-VGNs is our own, so all three are free at the margin. ConquerMM is the one open
// figure — $2.50 per ping (operator 2026-09-03) but absent from that breakdown, so a direct fan-out
// is $11.10 if it is incremental and $8.60 if it is already covered. Either way there is no saving
// in the switch itself. What changes is CONTROL and VISIBILITY:
//
//   • Today T0 has no delivery confirms and no Boost Lift row. Nothing anywhere observes whether
//     those seven retweet. Every other tier has had velocity lift since the measurement layer
//     landed; T0 has had a charge and a shrug (IMPROVEMENTS.md, operator 2026-08-14).
//   • The bundle is all-or-nothing. Seven addressed sends can be pruned, held per vendor, or
//     reordered — and dropping a member that never delivers is the only real saving on offer.
//   • vendor-audit.mjs sees one line named "Boosting GA Bridge (T0)". Seven lines let it separate
//     lift and commission per network, which is the whole point of the leave-one-out rotation.
//
// The plan/send split is deliberate: the planning core below is pure and offline, so the arithmetic
// and every refusal are pinned by tests/t0-direct.test.mjs without a token, a PAT or a network.
//
//   node t0-direct.mjs --link <url> --account <name>      # plan only (default) — sends nothing
//   node t0-direct.mjs --link <url> --json                # machine-readable plan
//   node t0-direct.mjs --link <url> --send                # refuses while T0_DIRECT is false
import { loadEnv, requireEnv, airtable, telegram, esc, report, logRun, runMain } from './lib.mjs';
import { TABLES, T0_DIRECT } from './config.mjs';
import { fanout, expand, bundles, byKey, inSendingWindow } from './vendors.mjs';

// The broker's own Config row. While this row is Active the n8n RT Bridge still fires the bundle,
// so sending direct as well would pay twice AND post to every member group twice. `planT0` refuses
// on it — see INTERLOCK below.
export const BROKER_ROW_NAME = 'Vendor – Boosting GA Bridge (T0)';

/** One Fuel Log `Tier Breakdown` line, in the format facts-build.parseTierBreakdown reads back:
 *  `T0 · <vendor> · $<price> · <reach> reach · <iso>`. One per member replaces the single bundle
 *  line, which is what finally makes the seven separable in vendor-audit.mjs. */
export function tierLine({ vendor, price, reach, at }) {
  return `T0 · ${vendor} · $${Number(price).toFixed(2)} · ${Math.round(reach)} reach · ${at}`;
}

/**
 * Plan a direct T0 fan-out. PURE — no network, no env, no clock beyond what you pass.
 *
 * Returns `{ ok, refusals, sends, held, totals, lines }`. `ok` is false whenever anything would
 * make the send unsafe; `refusals` says which, in the operator's words rather than an error code.
 * A caller must never send on a plan whose `ok` is false.
 *
 * @param link        the tweet URL to ping
 * @param at          when the send would happen (Date)
 * @param brokerActive whether the broker's Config row is still Active — the double-pay interlock
 * @param enabled     the T0_DIRECT switch
 * @param armed       whether --send was passed
 * @param holdOffHours hold members outside their sending window (inert until Phase 3 measures one)
 * @param only        restrict to these vendor keys (the pruning the block never allowed)
 */
export function planT0(link, {
  at = new Date(), brokerActive = true, enabled = T0_DIRECT, armed = false,
  holdOffHours = false, only = null,
} = {}) {
  const refusals = [];
  if (!/^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/.test(String(link || ''))) {
    refusals.push('link is not an x.com/twitter.com status URL — nothing to ping');
  }
  if (!enabled) refusals.push('T0_DIRECT is false in config.mjs — direct sending is switched off');
  if (!armed) refusals.push('--send was not passed — this is a plan, not a dispatch');
  // INTERLOCK. The broker and the direct path fire the same seven groups. Running both pays $8.60
  // twice and posts the link to each group twice, which is the failure a vendor notices. Turning
  // the broker's Config row inactive is the FIRST step of the cutover, not a cleanup afterwards.
  if (brokerActive) {
    refusals.push(`the broker row "${BROKER_ROW_NAME}" is still Active — set it inactive first, or the bundle and the direct fan-out both fire (double charge, double post)`);
  }

  const members = expand('t0').filter((v) => !only || only.includes(v.key));
  if (only && members.length !== (only?.length ?? 0)) {
    const missing = only.filter((k) => !members.some((v) => v.key === k));
    if (missing.length) refusals.push(`not T0 members: ${missing.join(', ')}`);
  }
  for (const v of members) {
    if (!v.chatId) refusals.push(`${v.key} has no chat id`);
  }

  const sends = [], held = [];
  for (const v of members) {
    const w = inSendingWindow(at, v);
    const cost = bundles().t0.memberCost[v.key] ?? 0;
    const row = {
      key: v.key, title: v.title, chatId: v.chatId, airtableConfigId: v.airtableConfigId,
      cost, nominalReach: v.nominalReach, accounts: v.accounts,
      window: { inside: w.inside, basis: w.basis },
      // Costed at the BUNDLE rate, never the vendor's own cost.perPost — that figure is what the
      // RT bot pays when IT delivers for a paying client, a different arrangement. Confusing the
      // two is how an earlier draft priced this fan-out at $12.45 on stale rates and wrongly
      // concluded that going direct was categorically more expensive than the broker.
      costBasis: 'bundle:t0',
      // An ASSUMED cost is one the operator has not confirmed as incremental. ConquerMM is $2.50
      // per ping but absent from the $8.60 breakdown, so it may already be covered. Carried at the
      // higher figure because over-budgeting is the safe error on money, and surfaced everywhere
      // rather than buried — a plan that hides which of its numbers is a guess is worse than one
      // that costs nothing.
      assumed: (bundles().t0.assumedMembers || []).includes(v.key),
    };
    // Holding is opt-in and inert today: no vendor carries a MEASURED window yet, so every basis is
    // 'unmeasured' and holding on the bot's fleet-wide policy would hold all seven on every thread
    // slot. Phase 3 fills vendor.window from the bot's reacted_at history; this then starts biting.
    if (holdOffHours && !w.inside && w.basis === 'measured') held.push(row);
    else sends.push(row);
  }

  const at_ = at.toISOString();
  const cash = +sends.reduce((s, r) => s + r.cost, 0).toFixed(2);
  const assumedCash = +sends.filter((r) => r.assumed).reduce((s, r) => s + r.cost, 0).toFixed(2);
  const reach = sends.reduce((s, r) => s + r.nominalReach, 0);
  const full = fanout(['t0']);
  return {
    ok: refusals.length === 0 && sends.length > 0,
    refusals, link, at: at_, sends, held,
    totals: {
      vendors: sends.length,
      cash,
      // The floor: what this fan-out costs if every assumed member turns out to be already covered.
      cashIfAssumedCovered: +(cash - assumedCash).toFixed(2),
      assumedCash,
      brokerPrice: bundles().t0.price,
      // The headline the operator asked to be stated correctly: same money, not more.
      deltaVsBroker: +(cash - bundles().t0.price).toFixed(2),
      nominalReach: reach,
      expectedViews: Math.round(reach * (full.nominalReach ? full.expectedViews / full.nominalReach : 0)),
    },
    lines: sends.map((r) => tierLine({ vendor: r.title, price: r.cost, reach: r.nominalReach, at: at_ })),
  };
}

/** Human-readable plan. The thing an operator reads before flipping the switch. */
export function renderPlan(p) {
  const L = [];
  L.push(`T0 direct — ${p.link}`);
  L.push(`${p.at}\n`);
  const w = (r) => (r.window.basis === 'measured' ? (r.window.inside ? 'in-hour' : 'OFF-HOUR') : 'unmeasured');
  L.push(`${'vendor'.padEnd(30)} ${'chat id'.padEnd(15)} ${'cost'.padStart(7)} ${'reach'.padStart(10)}  window`);
  for (const r of p.sends) {
    L.push(`${r.title.slice(0, 30).padEnd(30)} ${String(r.chatId).padEnd(15)} ${('$' + r.cost.toFixed(2)).padStart(7)} ${r.nominalReach.toLocaleString().padStart(10)}  ${w(r)}`);
  }
  for (const r of p.held) L.push(`${('(held) ' + r.title).slice(0, 30).padEnd(30)} ${''.padEnd(15)} ${'—'.padStart(7)} ${r.nominalReach.toLocaleString().padStart(10)}  OFF-HOUR`);
  const t = p.totals;
  L.push('');
  L.push(`${t.vendors} vendors · $${t.cash.toFixed(2)} · ${t.nominalReach.toLocaleString()} nominal reach · ~${t.expectedViews.toLocaleString()} expected views`);
  if (t.assumedCash > 0) {
    L.push(`  of which $${t.assumedCash.toFixed(2)} is ASSUMED incremental (${p.sends.filter((r) => r.assumed).map((r) => r.key).join(', ')}) — $${t.cashIfAssumedCovered.toFixed(2)} if already covered`);
  }
  const range = t.assumedCash > 0 ? `$${t.cashIfAssumedCovered.toFixed(2)}-$${t.cash.toFixed(2)}` : `$${t.cash.toFixed(2)}`;
  L.push(`broker charges $${t.brokerPrice.toFixed(2)} for the same seven; direct is ${range}. The gain is per-vendor confirms and a prunable list, not price.`);
  if (p.refusals.length) {
    L.push('');
    L.push('WOULD NOT SEND:');
    for (const r of p.refusals) L.push(`  ✗ ${r}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// IO shell. Everything below touches the network; everything above is pure.
// ---------------------------------------------------------------------------

/** Is the broker's Config row still Active? Answers the double-pay interlock. Fails CLOSED — an
 *  unreadable Config table returns true (broker assumed live), because sending on a failed read is
 *  the one outcome that costs money and annoys a vendor. */
export async function brokerIsActive(env) {
  try {
    const rows = await airtable(env).list(TABLES.config, { fields: ['Name', 'Active'], pageSize: 100, max: 200 });
    const row = rows.find((r) => String(r.fields?.Name ?? '').trim() === BROKER_ROW_NAME);
    if (!row) {
      console.warn(`t0-direct: no Config row named "${BROKER_ROW_NAME}" — assuming the broker is live.`);
      return true;
    }
    return Boolean(row.fields?.Active);
  } catch (e) {
    console.warn(`t0-direct: could not read the Config table (${e.message}) — assuming the broker is live.`);
    return true;
  }
}

/** Per-vendor bot token. `Token` is PER Config row and the base holds several bots, so a group
 *  reachable by one is invisible to another — ONBOARDING.md records exactly this failure
 *  ("chat not found" means that bot was never added, not that the id is wrong). Falls back to the
 *  main Config row's token. */
export async function tokensFor(env, rows) {
  const at = airtable(env);
  const cfg = await at.list(TABLES.config, { fields: ['Name', 'Token', 'Chat ID'], pageSize: 100, max: 200 });
  const byId = new Map(cfg.map((r) => [String(r.fields?.['Chat ID'] ?? '').trim(), r.fields?.Token]));
  const fallback = cfg.find((r) => r.fields?.Token)?.fields?.Token;
  return new Map(rows.map((r) => [r.key, byId.get(String(r.chatId)) || fallback || null]));
}

/** Post the link into one vendor group. Returns {ok, messageId?, error?} — never throws, so one
 *  unreachable group cannot abort the fan-out (the bot's own send loop has the same property). */
export async function sendToVendor(token, chatId, text) {
  if (!token) return { ok: false, error: 'no bot token for this group' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: `${r.status}: ${String(j.description || '').slice(0, 120)}` };
    return { ok: true, messageId: j.result?.message_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Report one delivery to genius-rt-bot's `POST /vendor-rt`, which burns a post from that vendor's
 *  credit deal. It exists precisely for this case: Telegram never shows one bot another bot's
 *  messages, so a send we make is invisible to the RT bot unless we tell it. Deduped bot-side per
 *  vendor per tweet for 3h, so reporting a tweet the bot also delivered never double-counts.
 *  Best-effort: a metering failure must not stop the fan-out, but it IS reported. */
export async function meterToBot(env, chatId, link) {
  const base = env.RT_BOT_URL, secret = env.RT_BOT_WEBHOOK_SECRET;
  if (!base || !secret) return { ok: false, skipped: 'RT_BOT_URL / RT_BOT_WEBHOOK_SECRET unset' };
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/vendor-rt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ vendor_chat_id: Number(chatId), link, source: 'project-infinity/t0-direct' }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await runMain(async () => {
    const link = arg('link');
    const armed = process.argv.includes('--send');
    const holdOffHours = process.argv.includes('--hold-offhours');
    const only = arg('only') ? arg('only').split(',').map((s) => s.trim()) : null;
    const account = arg('account', '');

    // The interlock needs Airtable. Without a PAT we cannot know whether the broker is live, so the
    // plan assumes it is and refuses to send — the safe direction.
    let env = {}, brokerActive = true;
    try {
      env = loadEnv();
      if (armed) requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
      if (env.AIRTABLE_PAT && env.XDB_BASE_ID) brokerActive = await brokerIsActive(env);
    } catch (e) {
      if (armed) throw e;
      console.warn(`t0-direct: ${e.message} — planning offline, broker assumed live.`);
    }

    const plan = planT0(link, { brokerActive, armed, holdOffHours, only });

    if (process.argv.includes('--json')) { console.log(JSON.stringify(plan, null, 2)); return; }
    console.log(renderPlan(plan));

    if (!plan.ok) {
      console.log(`\nNothing sent.${armed ? ' Fix the refusals above and re-run.' : ' (Pass --send once T0_DIRECT is on.)'}`);
      logRun('t0-direct', { mode: 'plan', account, vendors: plan.totals.vendors, cash: plan.totals.cash, refusals: plan.refusals.length });
      return;
    }

    // ---- dispatch ----
    const tokens = await tokensFor(env, plan.sends);
    const results = [];
    for (const r of plan.sends) {
      const send = await sendToVendor(tokens.get(r.key), r.chatId, plan.link);
      // Meter ONLY what actually landed. Burning a vendor's credit for a post they never received
      // is the one bookkeeping error that costs us the relationship as well as the money.
      const meter = send.ok ? await meterToBot(env, r.chatId, plan.link) : { ok: false, skipped: 'send failed' };
      results.push({ ...r, send, meter });
      console.log(`  ${send.ok ? '✓' : '✗'} ${r.title.padEnd(30)} $${r.cost.toFixed(2)}  ${send.ok ? `msg ${send.messageId}` : send.error}${send.ok && meter.counted ? ` · metered: ${meter.status ?? ''}` : ''}`);
    }

    const landed = results.filter((r) => r.send.ok);
    const spend = +landed.reduce((s, r) => s + r.cost, 0).toFixed(2);
    console.log(`\n${landed.length}/${results.length} delivered · $${spend.toFixed(2)} · Tier Breakdown lines:`);
    for (const r of landed) console.log(`  ${tierLine({ vendor: r.title, price: r.cost, reach: r.nominalReach, at: plan.at })}`);

    const failed = results.filter((r) => !r.send.ok);
    if (failed.length) {
      await telegram(env, report({
        emoji: '⚠️', title: 'T0 direct — partial delivery', scope: account || plan.link,
        status: `${landed.length}/${results.length} groups delivered · $${spend.toFixed(2)} spent`,
        sections: [{ label: 'FAILED', body: failed.map((r) => `• ${esc(r.title)} — ${esc(r.send.error)}`).join('\n') }],
        action: 'A group the bot cannot reach is usually the wrong token for that Config row, not a wrong chat id.',
      }), 'fuel').catch((e) => console.error('telegram:', e.message));
    }
    logRun('t0-direct', { mode: 'send', account, delivered: landed.length, attempted: results.length, cash: spend });
  }, 't0-direct');
}
