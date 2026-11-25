// routing.mjs — where a post goes, when, and whether the vendor can take it.
//
// THE PROBLEM THIS EXISTS FOR. Every post today takes the same path: one destination set, fired at
// once, 24/7. That works at twelve accounts and it is the first thing that breaks as the fleet
// grows, because each new page multiplies load on the SAME vendors. Vendor overload is not a
// capacity problem to solve later — it is a routing problem, and routing is the only place it can
// be prevented. genius-rt-bot's /load detects strain after the fact (late-rate, pending count);
// this is the half that acts before the send.
//
// THE CONSTRAINT IS PER MEMBER ACCOUNT, NOT PER GROUP. Life Mastery is seven X accounts. A group
// taking 40 requests a day is asking each account to retweet the same source ~6 times a day — which
// reads as automation and costs the vendor the reach we are buying. So capacity is
// `accounts x perAccountPerDay`, and the vendor that saturates first is the one that caps the fleet.
//
// EVERY CAPACITY NUMBER HERE IS ASSUMED. Nobody has measured where a vendor account's retweets stop
// landing. The ceiling is declared once in routes.json so it is visible and tunable instead of
// implicit in nobody checking, and every result carries `basis: 'assumed'` so a caller can tell a
// policy from a measurement. The bot already holds what would calibrate it — per-vendor confirmation
// rate against daily volume IS the saturation curve.
//
// Pure and offline: no Airtable, no Telegram, no env, no wall clock unless you pass one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';
import { expand, byKey, bundles, inSendingWindow } from './vendors.mjs';

let _db = null;
export function db() {
  if (!_db) _db = JSON.parse(readFileSync(join(HERE_DIR, 'routes.json'), 'utf8'));
  return _db;
}
export const routes = () => db().routes;
export const route = (key) => db().routes[key] ?? null;

/** Daily send ceiling for one vendor. `accounts` is the vendor's own roster size from vendors.json,
 *  so a group that grows its roster earns capacity automatically. */
export function capacityOf(vendorKey) {
  const v = byKey(vendorKey);
  if (!v) return null;
  const d = db();
  const o = d.capacity?.overrides?.[vendorKey];
  // TWO WAYS TO STATE A CEILING, and the difference matters. `perAccountPerDay` is the modelled
  // form — roster size times a per-account limit — and is what an unmeasured vendor gets. `perDay`
  // is a GROUP-level number a vendor has actually told us ("we can do 17 posts a day"), which is
  // the better answer whenever it exists: it is their own statement about their own capacity, and
  // it does not silently change when their roster does. A stated perDay always wins.
  // THREE STATES, not two. `perDay: null` is an explicit UNCAPPED — a vendor who has told us they
  // have no ceiling (GL Growth Lab, operator 2026-09-06). That is different from having no override
  // at all, which falls back to the modelled roster x default and reports basis 'assumed'. Reading
  // null as "absent" is what made GL look like a 4/day vendor drowning under 16.
  const uncapped = o != null && Object.prototype.hasOwnProperty.call(o, 'perDay') && o.perDay == null;
  const stated = uncapped ? null : o?.perDay;
  const per = o?.perAccountPerDay ?? d.meta.defaultPerAccountPerDay;
  const perDay = uncapped ? Infinity : (stated ?? v.accounts * per);
  return {
    vendor: vendorKey,
    accounts: v.accounts,
    perAccountPerDay: uncapped ? Infinity : stated ? +(stated / Math.max(1, v.accounts)).toFixed(2) : per,
    perDay,
    // A SOFT ceiling is one the vendor says can be pushed past. Over it is a warning, never a refusal.
    soft: (d.capacity?.softCeilings || []).includes(vendorKey),
    // Delivery reliability is orthogonal to capacity and has to travel with it, or a route design
    // balances load onto a vendor that is under its ceiling and still not retweeting.
    unreliable: ((d.capacity?.delivery?.unreliable) || []).includes(vendorKey),
    basis: uncapped ? 'vendor-stated (uncapped)' : stated ? (o.basis || 'vendor-stated') : 'assumed',
    paused: (d.capacity?.paused || []).includes(vendorKey),
  };
}

/**
 * How many sends a window can hold at a given minimum spacing.
 *
 * This is the other half of capacity, and it is the one expanding the window actually moves. A
 * vendor's daily ceiling says how MANY posts they can take; the window says how much ROOM there is
 * to space them out. Seventeen posts into a five-hour window is one every eighteen minutes; the
 * same seventeen into eight hours is one every twenty-eight. Same volume, and far less like a burst
 * — to the vendor and to X.
 *
 * So expanding the window does not buy capacity. It buys SPACING at a given volume, which is what
 * keeps the volume deliverable.
 */
export function windowSlots({ startMin, endMin, minSpacingMin = 15 } = {}) {
  const minutes = endMin >= startMin ? endMin - startMin : 24 * 60 - startMin + endMin;
  return {
    windowMin: minutes,
    windowHours: +(minutes / 60).toFixed(1),
    minSpacingMin,
    slots: Math.floor(minutes / minSpacingMin),
    // At the measured 1.33 posts per fleet account per day, how many accounts fit?
    fleetAccounts: Math.floor(minutes / minSpacingMin / (16 / 12)),
  };
}

/** Spacing a given volume gets inside a window — the inverse question. */
export function spacingAt(postsPerDay, { startMin, endMin } = {}) {
  const minutes = endMin >= startMin ? endMin - startMin : 24 * 60 - startMin + endMin;
  return postsPerDay > 0 ? +(minutes / postsPerDay).toFixed(1) : Infinity;
}

/**
 * How much room a vendor has left today.
 *
 * `sendsToday` is a { vendorKey: count } tally the caller supplies — from the Fuel Log, from the
 * bot's forwards, or from a dry-run. Keeping it an argument rather than a read is what makes this
 * testable and what lets the same function answer "what happened" and "what would happen".
 */
export function headroom(vendorKey, sendsToday = {}) {
  const cap = capacityOf(vendorKey);
  if (!cap) return null;
  const used = sendsToday[vendorKey] || 0;
  const left = Math.max(0, cap.perDay - used);
  return {
    ...cap, used, left,
    // An uncapped vendor has no utilisation to report — 0, not NaN from Infinity/Infinity.
    utilisation: Number.isFinite(cap.perDay) && cap.perDay ? +(used / cap.perDay).toFixed(2) : 0,
    // An uncapped vendor never saturates; a paused one always does, whatever its ceiling.
    saturated: cap.paused || (Number.isFinite(cap.perDay) && used >= cap.perDay),
  };
}

/** Deterministic 0..1 from a string. Jitter must be STABLE per link — re-planning a post has to give
 *  the same answer, or a retry silently reschedules it and two sends race. */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i += 1) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Plan one post's fan-out down a named route.
 *
 * Returns `{ ok, route, sends, held, spilled, refusals, totals }`.
 *  • sends   — vendor, when to fire it, and what it costs
 *  • held    — saturated (or paused, or out of window) with nowhere to spill
 *  • spilled — a saturated vendor's traffic moved onto one of the route's alternates
 *
 * Nothing here fires anything. The caller decides what to do with a plan, and a plan whose `ok` is
 * false must not be dispatched.
 */
export function planRoute(routeKey, {
  link = '', at = new Date(), sendsToday = {}, only = null,
  respectWindows = false, ignoreCapacity = false,
} = {}) {
  const r = route(routeKey);
  const refusals = [];
  if (!r) return { ok: false, route: routeKey, refusals: [`no route named "${routeKey}"`], sends: [], held: [], spilled: [], totals: null };
  if (r.paused) refusals.push(`route "${routeKey}" is paused${r.pausedWhy ? ` — ${r.pausedWhy}` : ''}`);

  // Expand vendors and bundles into a deduplicated, ordered list. First mention wins, so a route
  // may name a bundle then an extra vendor without paying for anything twice.
  const seen = new Set(), members = [];
  for (const k of r.vendors) {
    for (const v of expand(k)) {
      if (seen.has(v.key)) continue;
      seen.add(v.key);
      members.push({ v, from: bundles()[k] ? k : null });
    }
  }
  const picked = only ? members.filter((m) => only.includes(m.v.key)) : members;

  // Running tally so two vendors in the SAME plan cannot both spend the last slot.
  const tally = { ...sendsToday };
  const sends = [], held = [], spilled = [];
  const jitter = r.jitterMin ? Math.round(hash01(link || routeKey) * r.jitterMin) : 0;

  const costFor = (m) => (m.from ? bundles()[m.from].memberCost?.[m.v.key] ?? 0 : byKey(m.v.key)?.cost.perPost ?? 0);

  const place = (m, i, reason = null) => {
    const delayMin = (r.delayMin || 0) + jitter + i * (r.staggerMin || 0);
    const when = new Date(at.getTime() + delayMin * 60000);
    tally[m.v.key] = (tally[m.v.key] || 0) + 1;
    return {
      key: m.v.key, title: m.v.title, chatId: m.v.chatId,
      cost: costFor(m), nominalReach: m.v.nominalReach,
      delayMin, at: when.toISOString(),
      headroom: headroom(m.v.key, tally),
      window: (({ inside, basis }) => ({ inside, basis }))(inSendingWindow(when, m.v)),
      ...(reason ? { spilledFrom: reason } : {}),
    };
  };

  picked.forEach((m, i) => {
    const h = headroom(m.v.key, tally);
    const blocked = !ignoreCapacity && h?.saturated;
    if (!blocked) { sends.push(place(m, i)); return; }

    // Saturated. Try the route's alternates before giving up — this is the whole mechanism: an
    // overloaded vendor sheds onto a vendor with room instead of the post being dropped or the
    // vendor being pushed past its ceiling.
    const alt = (r.spillTo || [])
      .map((k) => byKey(k))
      .filter((v) => v && !seen.has(v.key) && !headroom(v.key, tally)?.saturated)[0];
    if (alt) {
      seen.add(alt.key);
      spilled.push(place({ v: alt, from: null }, i, m.v.key));
    } else {
      held.push({
        key: m.v.key, title: m.v.title, reason: h.paused ? 'vendor paused' : 'at daily capacity',
        headroom: h,
      });
    }
  });

  // Window holding is opt-in and, today, inert by construction: no vendor carries a MEASURED window
  // yet (vendors.mjs returns basis 'unmeasured'), and holding on the bot's fleet-wide 07:00-12:00 ET
  // policy would hold every thread slot the fleet has. Phase 3 fills the windows; this then bites.
  let out = sends;
  if (respectWindows) {
    out = [];
    for (const s of sends) {
      if (s.window.basis === 'measured' && !s.window.inside) held.push({ ...s, reason: 'outside vendor window' });
      else out.push(s);
    }
  }

  const all = [...out, ...spilled];
  return {
    ok: refusals.length === 0 && all.length > 0,
    route: routeKey, label: r.label, link, at: at.toISOString(),
    refusals, sends: out, spilled, held,
    totals: {
      vendors: all.length,
      cost: +all.reduce((s, x) => s + x.cost, 0).toFixed(2),
      nominalReach: all.reduce((s, x) => s + x.nominalReach, 0),
      heldCount: held.length,
      spilledCount: spilled.length,
      spanMin: all.length ? Math.max(...all.map((x) => x.delayMin)) : 0,
    },
  };
}

/**
 * PEAK retweets asked of one MEMBER ACCOUNT per day, per vendor — measured, not modelled.
 *
 * `fires` is a flat list of {vendor, at} taken from the Fuel Log / facts.jsonl. Dividing observed
 * fires by the vendor's known roster size is the whole calculation, and it is what turns "vendor
 * overload" from a worry into a number. Only the ceiling it is compared against is assumed.
 *
 * The result is uncomfortable and worth stating plainly: the fleet's five most-loaded vendors are
 * its five SMALLEST, because routing by group treats a one-account vendor and a thirty-three-account
 * vendor as the same kind of destination.
 */
export function perAccountLoad(fires, { ceiling = null } = {}) {
  const cap = ceiling ?? db().meta.defaultPerAccountPerDay;
  const byDay = new Map();
  for (const f of fires) {
    const day = String(f.at || '').slice(0, 10);
    if (!day || !f.vendor) continue;
    if (!byDay.has(f.vendor)) byDay.set(f.vendor, new Map());
    const d = byDay.get(f.vendor);
    d.set(day, (d.get(day) || 0) + 1);
  }
  const rows = [];
  for (const [vendor, days] of byDay) {
    const v = byKey(vendor);
    if (!v) continue;
    const peak = Math.max(...days.values());
    const accounts = Math.max(1, v.accounts);
    const per = +(peak / accounts).toFixed(1);
    rows.push({
      vendor, accounts: v.accounts, peakPerDay: peak, perAccountPerDay: per,
      ceiling: cap, over: per > cap, ratio: +(per / cap).toFixed(2), basis: 'measured-load/assumed-ceiling',
    });
  }
  return rows.sort((a, b) => b.perAccountPerDay - a.perAccountPerDay);
}

/**
 * WHICH VENDOR SATURATES FIRST, AND AT HOW MANY ACCOUNTS.
 *
 * The scaling question, answered from the roster rather than from feel. Given the fleet's current
 * account count and observed peak posts/day, project forward: at N accounts each posting the same
 * way, which vendor on this route hits its ceiling first?
 *
 * This is the number that should gate onboarding. Adding a page is cheap; adding a page that pushes
 * a vendor past the point where its accounts stop retweeting costs the reach of every page already
 * on that vendor.
 */
export function projectSaturation(routeKey, { accountsNow, peakPostsPerDay, target = null, share = 1 } = {}) {
  const r = route(routeKey);
  if (!r) return null;
  // `share` is the fraction of fleet posts this route carries. Two ALTERNATING routes each carry
  // half, so a projection at share:1 understates a paired route's ceiling by 2x — which is exactly
  // the mistake this parameter exists to stop. It defaults to 1 (a route used alone).
  const perAccount = (peakPostsPerDay * share) / Math.max(1, accountsNow); // posts/day contributed by one page
  const seen = new Set(), rows = [];
  for (const k of r.vendors) {
    for (const v of expand(k)) {
      if (seen.has(v.key)) continue;
      seen.add(v.key);
      const cap = capacityOf(v.key);
      // Every page on this route sends to every vendor on it, so load per vendor == posts/day.
      const maxAccounts = perAccount > 0 ? Math.floor(cap.perDay / perAccount) : Infinity;
      rows.push({
        vendor: v.key, title: v.title, accounts: v.accounts,
        perDay: cap.perDay, loadNow: +(perAccount * accountsNow).toFixed(1),
        utilisationNow: cap.perDay ? +((perAccount * accountsNow) / cap.perDay).toFixed(2) : 0,
        maxFleetAccounts: maxAccounts,
        loadAtTarget: target ? +(perAccount * target).toFixed(1) : null,
        saturatedAtTarget: target ? perAccount * target > cap.perDay : null,
      });
    }
  }
  rows.sort((a, b) => a.maxFleetAccounts - b.maxFleetAccounts);
  return {
    route: routeKey, basis: 'assumed', accountsNow, peakPostsPerDay, share,
    postsPerAccountPerDay: +perAccount.toFixed(2),
    ceiling: rows[0] ? rows[0].maxFleetAccounts : null,
    firstToSaturate: rows[0] ? rows[0].vendor : null,
    rows,
  };
}

/** Human-readable saturation table — the thing to read before onboarding more pages. */
export function renderSaturation(p) {
  if (!p) return 'no such route';
  const L = [
    `Route "${p.route}" — saturation projection (capacity basis: ${p.basis})`,
    `${p.accountsNow} accounts firing · peak ${p.peakPostsPerDay} posts/day${p.share !== 1 ? ` · carrying ${Math.round(p.share * 100)}% of them` : ''} · ${p.postsPerAccountPerDay} posts/account/day`,
    '',
    `${'vendor'.padEnd(20)} ${'accts'.padStart(5)} ${'cap/day'.padStart(8)} ${'now'.padStart(6)} ${'util'.padStart(6)} ${'max fleet'.padStart(10)}`,
  ];
  for (const r of p.rows) {
    L.push(`${r.vendor.padEnd(20)} ${String(r.accounts).padStart(5)} ${String(r.perDay).padStart(8)} ${String(r.loadNow).padStart(6)} ${(Math.round(r.utilisationNow * 100) + '%').padStart(6)} ${String(r.maxFleetAccounts).padStart(10)}`);
  }
  L.push('');
  L.push(`First to saturate: ${p.firstToSaturate} — this route caps the fleet at ~${p.ceiling} accounts.`);
  L.push('Past that, another page does not add reach; it adds requests the vendor will not action.');
  return L.join('\n');
}

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const rk = arg('route', 'default');
  if (process.argv.includes('--saturation')) {
    // Defaults are the measured peak from facts.jsonl (38 days, 12 accounts firing fuel).
    console.log(renderSaturation(projectSaturation(rk, {
      accountsNow: Number(arg('accounts', 12)),
      peakPostsPerDay: Number(arg('peak', 16)),
      share: Number(arg('share', 1)),
      target: arg('target') ? Number(arg('target')) : null,
    })));
  } else {
    const p = planRoute(rk, { link: arg('link', ''), respectWindows: process.argv.includes('--windows') });
    if (process.argv.includes('--json')) { console.log(JSON.stringify(p, null, 2)); }
    else {
      console.log(`route "${p.route}" — ${p.label}`);
      for (const s of p.sends) console.log(`  +${String(s.delayMin).padStart(3)}m  ${s.title.slice(0, 30).padEnd(30)} $${s.cost.toFixed(2)}  ${Math.round(s.headroom.utilisation * 100)}% used`);
      for (const s of p.spilled) console.log(`  +${String(s.delayMin).padStart(3)}m  ${s.title.slice(0, 30).padEnd(30)} $${s.cost.toFixed(2)}  ↪ spilled from ${s.spilledFrom}`);
      for (const h of p.held) console.log(`  HELD    ${(h.title || h.key).slice(0, 30).padEnd(30)} ${h.reason}`);
      if (p.totals) console.log(`\n${p.totals.vendors} vendor(s) · $${p.totals.cost.toFixed(2)} · spread over ${p.totals.spanMin}m · ${p.totals.heldCount} held · ${p.totals.spilledCount} spilled`);
      for (const r of p.refusals) console.log(`  ✗ ${r}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// SUN / MOON — per-post route alternation (operator 2026-09-06, built 2026-09-07).
//
// These three are the REPO MIRROR of the helpers pasted byte-identically into the n8n nodes
// (docs/bridge-nodes: Handle Publish Event, Plan Polls, Fuel Gate · docs/fuel-nodes: Check
// Threshold). tests/bridge-routes.test.mjs runs the node sources and pins them against these, so a
// change in one place without the other fails CI instead of splitting the Bridge from Fuel the Fire.
//
// The switch is the Config row "Vendor Routes": Active, with `Routes` naming the routes in order
// ("Sun, Moon"). A vendor row's own `Routes` text ("Sun T0 · Moon T1") is its tier on each route; a row
// without one keeps its Tier on every route. Switch missing or inactive = the single-route behaviour.
// A post's route is an FNV-1a hash of its status id, so both workflows draw the same route for the
// same post — and unlike the id's parity (a snowflake's low bits are its sequence number, almost
// always 0) the hash spreads posts evenly over the routes.
export const routeNames = (cfg) => { const s = (cfg || []).find(r => r && r.Name === "Vendor Routes" && r.Active); if (!s) return []; const toks = String(s.Routes || "").split(/[·|,]/).map(x => x.trim()).filter(Boolean); const lanes = toks.map(t => { const m = t.match(/^(\S+)\s+(@\S+(?:\s+@\S+)*)$/); return m ? { name: m[1], accounts: m[2].split(/\s+/).map(h => h.replace(/^@/, "").toLowerCase()) } : null; }).filter(Boolean); if (lanes.length) return lanes; return toks.map(t => { const m = t.match(/^(\S+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/); return m ? { name: m[1], startMin: (+m[2]) * 60 + (+m[3]), endMin: (+m[4]) * 60 + (+m[5]) } : null; }).filter(Boolean); };
export const routeOf = (publishedAt, blocks, handle) => { if (!Array.isArray(blocks) || !blocks.length) return ""; if (blocks[0].accounts) { const h = String(handle || "").replace(/^@/, "").toLowerCase(); const b = h ? blocks.find(x => (x.accounts || []).includes(h)) : null; return b ? b.name : ""; } const t = publishedAt ? new Date(publishedAt) : null; if (!t || isNaN(t.getTime())) return ""; const m = (t.getUTCHours() * 60 + t.getUTCMinutes() + 420) % 1440; for (const b of blocks) { if (b.startMin <= b.endMin ? (m >= b.startMin && m < b.endMin) : (m >= b.startMin || m < b.endMin)) return b.name; } return ""; };
export const tierOn = (tier, routesText, route) => { if (!route) return tier || ""; const txt = String(routesText || ""); const m = txt.match(new RegExp("(?:^|[^A-Za-z])" + String(route).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*(T\\d+)", "i")); if (m) return m[1].toUpperCase(); return /(?:^|[^A-Za-z])[A-Za-z]\w*\s*:?\s*T\d+/i.test(txt) ? "" : (tier || ""); };

// ---------------------------------------------------------------------------------------------
// FUEL SPLIT TEST — A/B on the ladder itself (operator 2026-09-14).
//
// REPLACED 2026-09-27 by T1 OFF: B = "T0, T2, T3, T4, T5", so arm B never buys T1 and buys every other
// tier at its own bar (owner: "go t1 off to replace the arm a vs b test"). The mechanism below is
// unchanged. The rest of this block describes the first test, whose record is fuel-ops-core.mjs
// SPLIT_TESTS; `node fuel-split.mjs --test reduced-ladder` still reads it out.
//
// A = the full ladder, exactly as it runs today. B = a REDUCED ladder: the operator's pick is
// T0 + T1 + T4, so T2, T3 and T5 are muted for posts drawn into B.
//
// "T0, T1 and T3 (maven and Wealth Director)" is how the operator specified it. Maven/EM and
// Wealth Director are T4, not T3 — the vendor names are the binding half of that sentence, so B
// is T0+T1+T4 and the tier list lives in Airtable where it can be corrected without a deploy.
// T0 in the list is a deliberate no-op: the RT Bridge fires T0, Fuel the Fire never does, so
// naming it only keeps the Config row readable as the operator thinks about it.
//
// WHAT IS AND IS NOT CHANGED. The tier bars, the freshness windows and the late-rise override are
// untouched — "use the existing criterias". B changes only whether an EARNED tier may be BOUGHT.
// A muted tier still latches into `earned` (the post's age-independent high-water mark) exactly
// like `tooLate` does, so the timeline keeps recording what the post achieved and the experiment
// can be read as "what B declined to buy" rather than "what B never saw".
//
// AN ARM MAY ALSO BORROW ANOTHER TIER'S BAR. "T4@T3" in the Config row means: in arm B, the T4
// vendors become buyable at T3's requirements. The operator asked for this because T3 is a pure
// velocity gate (rise >= 30k/h) while T4 adds a 70k-view wall on top, and in his model the
// Maven/Wealth Director slot IS the third rung — it should fire when the post is T3-fast rather
// than waiting for T4's wall. Measured on 30 days of history that moves T4 from 6% to 14% of
// arm-B threads, about +$10/day.
//
// EARNED NEVER BORROWS. The high-water mark is always computed against the tier's OWN bar in both
// arms, so `tiersEarned` means the same thing in A and B and the two timelines stay comparable.
// Only `qualified` — what may actually be BOUGHT — sees the borrowed bar. A borrowed buy therefore
// shows up as a tier in `tiersFired` that is deliberately absent from `tiersEarned`; that gap is
// the remap doing its job, not an inconsistency.
//
// THE ARM IS A PURE FUNCTION OF THE STATUS ID — an FNV-1a hash, mod 100, against the configured
// percentage. Two properties follow, and both matter:
//   1. STABLE ACROSS POLLS. Fuel the Fire re-evaluates a post every 30-60 minutes for up to 24h.
//      A random draw per poll would let a post fire T1 in A at hour 2 and mute T4 in B at hour 6,
//      which is not an experiment, it is noise. The hash cannot drift.
//   2. RETROACTIVE. Every post ever published can be assigned an arm from its id alone, with no
//      stamp, so the denominator ("of the posts drawn into B, how many earned anything at all")
//      is recoverable for history. The `Arm` column on Fuel Log is for the operator's eyes and
//      for audit — proof the run used the arm the hash says it should have.
// Changing the percentage RESHUFFLES which posts sit in which arm, so it invalidates the
// comparison. Set it once and leave it.
//
// The switch is the Config row "Fuel Split Test": Active, with `Routes` carrying the B-arm tiers
// and optionally the B share — "B: T0, T1, T4 · 50%". Absent, inactive, or naming no tier at all
// means armOf returns "" and every gate below is a no-op: byte-for-byte the behaviour that ran
// before this existed, which is what makes the test safe to switch off mid-flight.
//
// These three are the REPO MIRROR of the helpers pasted byte-identically into
// docs/fuel-nodes/Check-Threshold.js; tests/fuel-split.test.mjs runs the node source and pins it
// against these, so changing one without the other fails CI.
export const splitTest = (cfg) => { const s = (cfg || []).find(r => r && r.Name === "Fuel Split Test" && r.Active); if (!s) return null; const txt = String(s.Routes || ""); const tiers = [], bars = {}; for (const tok of (txt.match(/T\d+(?:\s*@\s*T\d+)?/gi) || [])) { const [a, b] = tok.toUpperCase().split("@").map((x) => x.trim()); if (!tiers.includes(a)) tiers.push(a); if (b) bars[a] = b; } if (!tiers.length) return null; const p = txt.match(/(\d{1,3})\s*%/); return { tiers, bars, pct: p ? Math.max(0, Math.min(100, Number(p[1]))) : 50 }; };
export const armOf = (statusId, test) => { const s = String(statusId || ""); if (!test || !s) return ""; let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100) < test.pct ? "B" : "A"; };
export const armAllows = (tier, arm, test) => !test || arm !== "B" || test.tiers.includes(String(tier || "").toUpperCase());
export const armBar = (tier, arm, test) => ((test && arm === "B" && test.bars && test.bars[String(tier || "").toUpperCase()]) || String(tier || "").toUpperCase());

/** The `Routes` text the "Fuel Split Test" Config row must carry for the arm B the operator chose,
 *  so the tier list is typed once here and copied into Airtable rather than invented twice. Since
 *  2026-09-27 that is T1 off ("go t1 off to replace the arm a vs b test"): every tier but T1, each at
 *  its own bar. It replaced the reduced ladder above, `['T0', 'T1', 'T4@T3']`. At 50% until the owner's
 *  "Retire arm A." the same day; at 100% since, so every post runs arm B. fuel-ops-core.mjs SPLIT_TESTS
 *  dates each change, and a test pins the last entry to this default. */
export const splitSwitchText = (tiers = ['T0', 'T2', 'T3', 'T4', 'T5'], pct = 100) => `B: ${tiers.join(', ')} · ${pct}%`;

/** The routes that are live blocks: the ones carrying a `block`, in routes.json order. Cloud and
 *  Moon since 2026-09-26, when the owner took Sun off the "Vendor Routes" row ("Cloud 11:00-17:00 ·
 *  Moon 17:00-23:30"); Sun keeps its record under `retiredBlock`, which nothing here reads. */
export const blockRoutes = () => Object.keys(routes()).filter((k) => routes()[k].block || routes()[k].lane);

/** The chosen ladder per live block (routes.json → `tiers`), keyed by the route's name as the Config
 *  switch spells it. This is what the vendor rows' `Routes` text must encode; the Airtable values are
 *  derived from it, never typed twice. */
export const ROUTE_LADDER = Object.fromEntries(blockRoutes().map((k) => [route(k).name || k, route(k).tiers || {}]));

/** The block whose ladder the plain `Tier` column mirrors — the off-block default. Never Sun, whose
 *  ladder is deliberately inverted; see routes.json meta.defaultBlockWhy. */
export const defaultBlock = () => db().meta?.defaultBlock || 'Cloud';

/** The block boundaries as the `Vendor Routes` Config row must spell them, derived from routes.json
 *  so the hours are typed once. "Cloud 11:00-17:00 · Moon 17:00-23:30", the live row since 2026-09-26. */
export function routesSwitchText() {
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return blockRoutes().map((k) => {
    const r = route(k);
    return r.lane ? `${r.name} ${r.lane.accounts.map((h) => '@' + h).join(' ')}` : `${r.name} ${hhmm(r.block.startMin)}-${hhmm(r.block.endMin)}`;
  }).join(' · ');
}

/** The `Routes` text a vendor row should carry under the chosen ladder — "Sun T0 · Cloud T1 · Moon T1"
 *  when its tier differs between blocks — or '' when the vendor sits at the same tier on every block
 *  (its plain Tier already says so). Cloud and Moon run one ladder, so on the live ladder that is ''
 *  for every vendor. `ladder` is there for a test that needs a block whose ladder differs. */
/** The names of the client lanes in a ladder (routes.json `client: true`), e.g. AIE. */
const clientNames = (ladder) => new Set(Object.keys(ladder).filter((name) => Object.keys(routes()).some((k) => routes()[k].client && (route(k).name || k) === name)));

export function routesTextFor(vendorKey, ladder = ROUTE_LADDER) {
  const parts = [];
  for (const [name, tiers] of Object.entries(ladder)) {
    for (const [tier, keys] of Object.entries(tiers)) if ((keys || []).includes(vendorKey)) parts.push([name, tier]);
  }
  if (!parts.length) return '';
  // Nothing to say only when the vendor sits at ONE tier on EVERY route: its plain Tier then covers
  // it. A vendor on some routes but not others (Lifepad is Lane A T0 and nowhere in Lane B, the v8
  // test) must name the routes it IS on, so the others never fire it. Its plain Tier mirrors the
  // default lane: blank when that lane leaves it out, kept when the default lane is the one it is on.
  const tiersSeen = new Set(parts.map(([, t]) => t));
  // A CLIENT lane (routes.json `client`, AI Evolution's AIE since 2026-10-06) is T0 only and is not
  // asked of anyone else: a fleet vendor off it keeps its plain Tier there, which the Bridge never
  // reads past T0 and Fuel the Fire never reads at all (the client page has no Fuel Watch). So "on
  // every route" means every FLEET lane, and a vendor that is on the client lane alone names it.
  const fleetNames = clientNames(ladder);
  const onEvery = Object.keys(ladder).filter((name) => !fleetNames.has(name)).every((name) => parts.some(([n]) => n === name));
  return tiersSeen.size > 1 || !onEvery ? parts.map(([n, t]) => `${n} ${t}`).join(' · ') : '';
}
