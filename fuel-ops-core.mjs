// fuel-ops-core.mjs — the pure arithmetic behind the four fuel-ops scripts:
//   fuel-digest.mjs      what the fleet bought today, by tier and by network, plus vendor runway
//   fuel-scorecard.mjs   the v1-vs-v2 ladder comparison, keyed on the Fuel Log `Ladder Version` stamp
//   vendor-reconcile.mjs PI's per-network ledger lines against what the RT bot says it metered
//   vendor-health.mjs    Config + roster lint, and the Vendor Bot's membership in every active group
//
// Everything here takes plain rows and returns plain objects — no network, no env — so the numbers
// are pinned by tests/fuel-ops.test.mjs and every script is a thin fetch → compute → format shell.
//
// Ledger contract (shared with n8n "Build Log" / "Build T0 Fuel"): one "Tier Breakdown" line per
// tier fire, `T1 · Pammy · $12.00 · 380000 reach · <ISO>`. parseTierBreakdown owns the regex.
import { parseTierBreakdown, tweetId } from './facts-build.mjs';
import { esc } from './lib.mjs';

export const CUTOVER_V2 = '2026-09-05T04:55:00Z';   // v2 ladder published to Fuel the Fire
const SAIGON_MS = 7 * 3600e3;                        // the fleet's operating clock is UTC+7
export const utcDay = (iso) => String(iso || '').slice(0, 10);
export const saigonDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + SAIGON_MS).toISOString().slice(0, 10) : ''; };
export const todaySaigon = (now = Date.now()) => new Date(now + SAIGON_MS).toISOString().slice(0, 10);

/** Which Saigon day a DAILY WRAP-UP should report, given when it actually runs.
 *
 *  The digest cron is 16:05 UTC — 23:05 Saigon, chosen to sit after the day's fires but before the
 *  Saigon date rolls at 17:00 UTC. That leaves only 55 minutes of headroom, and GitHub's scheduler
 *  does not honour it: on 2026-09-05 the 16:05Z slot had still not fired at 17:15Z. A digest that
 *  defaulted to `todaySaigon()` would then have reported the brand-new day — fifteen minutes old,
 *  effectively empty — and the day the operator actually wanted would have gone unreported.
 *
 *  So a run in the small hours is treated as finishing the day that just ended, not opening the one
 *  that just began: before WRAPUP_HOUR Saigon, report yesterday. That covers the intended slot plus
 *  four hours of lateness. A deliberate run later in the day still means today; `--day` overrides
 *  either way. */
export const WRAPUP_HOUR = 4;
export function digestDay(now = Date.now()) {
  const local = new Date(now + SAIGON_MS);
  if (local.getUTCHours() < WRAPUP_HOUR) return new Date(now + SAIGON_MS - 864e5).toISOString().slice(0, 10);
  return local.toISOString().slice(0, 10);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n) => `$${num(n).toFixed(2)}`;
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const fmtK = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** Flatten Fuel Log rows into one record per ledger line. Pre-ledger seeds (`T?`) and lines whose
 *  timestamp is not an ISO date are dropped — they carry totals, not events. */
export function ledgerLines(rows) {
  const out = [];
  for (const r of rows) {
    const f = r.fields || r;
    const tid = tweetId(f['X URL']);
    for (const e of parseTierBreakdown(f['Tier Breakdown'])) {
      if (e.tiers.includes('T?')) continue;
      if (!Number.isFinite(Date.parse(e.at))) continue;
      out.push({
        tid, account: f.Account || '', tier: e.tiers[0], tiers: e.tiers,
        vendor: e.vendors[0] || '', vendors: e.vendors, price: e.price, reach: e.reach,
        at: e.at, day: utcDay(e.at), sday: saigonDay(e.at),
        stamp: String(f['Ladder Version'] || ''), holdout: !!f.Holdout,
      });
    }
  }
  return out;
}

// ---- digest --------------------------------------------------------------------------------------
/** What was bought on one Saigon day: fires and spend by tier and by network, threads touched. */
export function digest(rows, { day = todaySaigon() } = {}) {
  const lines = ledgerLines(rows).filter((l) => l.sday === day);
  const tiers = {}, byVendor = {}, threads = new Set(), t0Threads = new Set();
  let spend = 0;
  for (const l of lines) {
    threads.add(l.tid);
    spend += l.price;
    const t = (tiers[l.tier] ||= { fires: 0, spend: 0, threads: new Set(), vendors: {} });
    t.fires += 1; t.spend += l.price; t.threads.add(l.tid);
    for (const v of l.vendors) t.vendors[v] = (t.vendors[v] || 0) + 1;
    if (l.tier === 'T0') t0Threads.add(l.tid);
    for (const v of l.vendors) {
      const b = (byVendor[v] ||= { fires: 0, spend: 0, tiers: new Set() });
      b.fires += 1; b.spend += l.price / l.vendors.length; b.tiers.add(l.tier);
    }
  }
  const tierRows = Object.keys(tiers).sort().map((k) => ({ tier: k, fires: tiers[k].fires, spend: round2(tiers[k].spend), threads: tiers[k].threads.size, vendors: tiers[k].vendors }));
  const vendorRows = Object.entries(byVendor).map(([vendor, b]) => ({ vendor, fires: b.fires, spend: round2(b.spend), tiers: [...b.tiers].sort() })).sort((a, b) => b.spend - a.spend || b.fires - a.fires);
  return { day, lines: lines.length, threads: threads.size, t0Threads: t0Threads.size, spend: round2(spend), tiers: tierRows, vendors: vendorRows };
}
const round2 = (n) => Math.round(n * 100) / 100;

/** Days of deal left per metered vendor, at the trailing rate PI itself has been sending. `status`
 *  is the bot's /vendor-status payload; `rate` maps vendor title -> PI lines/day (7-day trailing). */
export function runway(status, rate = {}) {
  const out = [];
  for (const v of (status && status.vendors) || []) {
    if (!v.tracked) continue;
    const r = rate[v.title] || 0;
    const daysLeft = v.metered && v.remaining != null ? (r > 0 ? round2(v.remaining / r) : null) : null;
    out.push({ vendor: v.title, metered: !!v.metered, paused: !!v.paused, unlimited: !!v.unlimited, used: v.used, remaining: v.remaining, total: v.total, ratePerDay: round2(r), daysLeft, statusLine: v.status_line });
  }
  return out.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
}

/** Trailing per-vendor PI send rate (lines/day) over the last `days` UTC days ending today. */
export function vendorRate(rows, { days = 7, now = Date.now() } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const counts = {};
  for (const l of ledgerLines(rows)) if (l.at >= since) for (const v of l.vendors) counts[v] = (counts[v] || 0) + 1;
  const out = {};
  for (const [v, n] of Object.entries(counts)) out[v] = n / days;
  return out;
}

// ---- digest rendering ---------------------------------------------------------------------------
// Telegram gives us <pre> for monospace, which is the only way to get columns that line up on a
// phone. Everything that is a table is a table; everything that is prose is prose. Names are clipped
// to a fixed width so one long vendor ("Boosting GA Bridge (T0)") cannot push a column off-screen.
const clip = (v, n) => { const t = String(v ?? ''); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
const padR = (v, n) => clip(v, n).padEnd(n);
const padL = (v, n) => String(v ?? '').padStart(n);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How badly a vendor needs looking at. Lower is worse; null means it is fine.
 *  Runway used to sort on days-left alone, which buried the vendors that matter most: a network we
 *  do not send to ourselves has no rate, so no days-left, so "Navalism 1 left" sorted BELOW
 *  "ME ~134 days". Posts remaining is the signal that always exists — days-left only refines it. */
export function runwaySeverity(r, { minPosts = 5, minDays = 7 } = {}) {
  if (r.unlimited || r.remaining == null) return null;
  if (r.remaining < 0) return { rank: 0, why: 'over' };            // the ledger says we overdrew the deal
  if (r.remaining <= minPosts) return { rank: 1, why: 'low' };     // a handful of posts left, rate or no rate
  if (r.daysLeft != null && r.daysLeft <= minDays) return { rank: 2, why: 'soon' };
  return null;
}

export function formatDigest(d, { runway: rw = [], health = null, botNote = '' } = {}) {
  const out = [];
  const fires = d.tiers.reduce((n, t) => n + t.fires, 0);
  out.push(`<b>${money(d.spend)}</b>  ·  ${plural(d.threads, 'thread')}  ·  ${plural(fires, 'fire')}`);
  if (!d.lines) { out.push('\n<i>No fires logged this day.</i>'); return out.join('\n'); }

  // Spend by tier. Share of spend is what makes this worth a table — it answers "where did the money
  // actually go" without the reader dividing in their head.
  const tierRows = d.tiers.map((t) => {
    const pct = d.spend > 0 ? Math.round((t.spend / d.spend) * 100) : 0;
    return `${padR(t.tier, 3)}${padL(`${t.fires}×`, 5)}${padL(money(t.spend), 9)}${padL(pct ? `${pct}%` : '—', 6)}`;
  });
  out.push(`\n<b>Spend by tier</b>\n<pre>${esc(`${padR('', 3)}${padL('fires', 5)}${padL('spend', 9)}${padL('share', 6)}\n${tierRows.join('\n')}`)}</pre>`);

  // Networks, dearest first. The tier tags replace the per-tier vendor lists the old layout repeated.
  const paid = d.vendors.filter((v) => v.spend > 0);
  if (paid.length) {
    const rows = paid.map((v) => `${padR(v.vendor, 15)}${padL(money(v.spend), 9)}${padL(`${v.fires}×`, 5)}  ${v.tiers.join(',')}`);
    out.push(`\n<b>Paid networks</b>\n<pre>${esc(rows.join('\n'))}</pre>`);
  }
  const free = d.vendors.filter((v) => !v.spend);
  if (free.length) out.push(`<i>Free:</i> ${free.map((v) => `${esc(v.vendor)}${v.fires > 1 ? ` ×${v.fires}` : ''}`).join(' · ')}`);

  // Runway, urgency first. The whole point of this block is the vendor about to run dry, so the ones
  // that need a decision get a line each and the healthy majority collapses to one.
  if (rw.length) {
    const sev = new Map(rw.map((r) => [r.vendor, runwaySeverity(r)]));
    const urgent = rw.filter((r) => sev.get(r.vendor))
      .sort((a, b) => sev.get(a.vendor).rank - sev.get(b.vendor).rank || (a.remaining ?? 0) - (b.remaining ?? 0));
    const fine = rw.filter((r) => !sev.get(r.vendor) && !r.unlimited && r.remaining != null)
      .sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
    const unlimited = rw.filter((r) => r.unlimited);

    if (urgent.length) {
      const rows = urgent.map((r) => {
        const left = r.remaining < 0 ? `OVER ${-r.remaining}` : `${r.remaining} left`;
        const when = r.daysLeft != null && r.daysLeft > 0 ? ` ~${Math.round(r.daysLeft)}d` : '';
        return `${padR(r.vendor, 15)}${padL(`${r.used}/${r.total}`, 10)}${padL(left, 10)}${when}${r.paused ? ' ⏸' : ''}`;
      });
      out.push(`\n<b>⚠️ Runway</b> — ${plural(urgent.length, 'vendor needs', 'vendors need')} attention\n<pre>${esc(rows.join('\n'))}</pre>`);
    } else out.push('\n<b>Runway</b> — all vendors comfortable ✅');

    if (fine.length) {
      const tail = fine.map((r) => `${esc(r.vendor)} ${r.remaining}${r.daysLeft != null ? `/~${Math.round(r.daysLeft)}d` : ''}${r.paused ? ' ⏸' : ''}`).join(' · ');
      out.push(`<i>Fine:</i> ${tail}`);
    }
    if (unlimited.length) out.push(`<i>Unmetered:</i> ${unlimited.map((r) => esc(r.vendor)).join(' · ')}`);
    out.push('<i>⏸ = paused on the bot · OVER = the bot ledger says the deal is overdrawn</i>');
  } else if (botNote) out.push(`\n<i>${esc(botNote)}</i>`);

  if (health) {
    const errs = health.filter((f) => f.level === 'error').length, warns = health.filter((f) => f.level === 'warn').length;
    out.push(`\n<b>Health</b>: ${errs || warns ? `${plural(errs, 'error')}, ${plural(warns, 'warning')} — see vendor-health` : 'all clear ✅'}`);
  }
  return out.join('\n');
}

// ---- scorecard -----------------------------------------------------------------------------------
/** Views of one thread at ~hours after its first fire, from Growth Log snaps [{at, views}] sorted
 *  ascending. Nearest sample within ±tolMin of the target; null when none brackets it. */
export function viewsAt(snaps, firstFiredIso, hours, tolMin = 90) {
  const t0 = Date.parse(firstFiredIso); if (!Number.isFinite(t0) || !snaps || !snaps.length) return null;
  const target = t0 + hours * 3600e3;
  let best = null, bestGap = Infinity;
  for (const s of snaps) { const gap = Math.abs(Date.parse(s.at) - target); if (gap < bestGap) { bestGap = gap; best = s; } }
  return best && bestGap <= tolMin * 60e3 ? num(best.views) : null;
}

/** Two cohorts: v2 = rows stamped v2; v1 = unstamped rows first fired in the `v1Days` before the
 *  cutover. Holdout rows are excluded from both (they bought less on purpose). */
export function scorecard(rows, snapsByTid = new Map(), { cutover = CUTOVER_V2, v1Days = 14, now = Date.now() } = {}) {
  const cut = Date.parse(cutover), v1From = cut - v1Days * 864e5;
  const pick = (r) => {
    const f = r.fields || r;
    if (f.Holdout) return null;
    const stamp = String(f['Ladder Version'] || '');
    const ff = Date.parse(f['First Fired']);
    // A row with no real ledger line (pre-ledger seed only) has nothing to compare; keeping it would
    // read as a $0 thread and drag the cohort's spend down.
    if (!parseTierBreakdown(f['Tier Breakdown']).some((e) => !e.tiers.includes('T?'))) return null;
    if (stamp.startsWith('v2')) return 'v2';
    if (!stamp && Number.isFinite(ff) && ff >= v1From && ff < cut) return 'v1';
    return null;
  };
  const cohort = { v1: [], v2: [] };
  for (const r of rows) { const c = pick(r); if (c) cohort[c].push(r.fields || r); }
  const stats = (rs) => {
    const n = rs.length;
    const per = rs.map((f) => {
      const lines = parseTierBreakdown(f['Tier Breakdown']).filter((e) => !e.tiers.includes('T?'));
      const t0 = lines.filter((e) => e.tiers[0] === 'T0').reduce((s, e) => s + e.price, 0);
      const upper = lines.filter((e) => e.tiers[0] !== 'T0');
      const spend = lines.reduce((s, e) => s + e.price, 0);
      const tid = tweetId(f['X URL']);
      const snaps = snapsByTid.get(tid) || [];
      const v6 = viewsAt(snaps, f['First Fired'], 6), v24 = viewsAt(snaps, f['First Fired'], 24);
      const comm = num(f['Lifetime Commission Rollup (from Post)']);
      const ageH = (now - Date.parse(f['First Fired'])) / 3600e3;
      return { t0, spend, upper: upper.length, upperTiers: [...new Set(upper.map((e) => e.tiers[0]))], v6, v24, comm, ageH };
    });
    // Age gates, so a young cohort is never scored on what it has not had time to earn: T1+ fires
    // and 24h views need a day; affiliate commission needs ~48h to report.
    const mature24 = per.filter((p) => p.ageH >= 24);
    const mature48 = per.filter((p) => p.ageH >= 48);
    const sum = (arr, k) => arr.reduce((s, p) => s + p[k], 0);
    const v24s = mature24.map((p) => p.v24).filter((x) => x != null);
    const spendWith24 = mature24.filter((p) => p.v24 != null).reduce((s, p) => s + p.spend, 0);
    const views24Total = v24s.reduce((s, x) => s + x, 0);
    return {
      threads: n,
      t0SpendPerThread: n ? round2(sum(per, 't0') / n) : null,
      spendPerThread: n ? round2(sum(per, 'spend') / n) : null,
      upperFireRate: mature24.length ? round2(mature24.filter((p) => p.upper > 0).length / mature24.length) : null,
      upperTierMix: per.flatMap((p) => p.upperTiers).reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {}),
      medianViews6h: median(per.map((p) => p.v6)),
      medianViews24h: median(v24s),
      dollarsPer1k24h: views24Total ? round2(spendWith24 / views24Total * 1000) : null,
      commissionPerThread: mature48.length ? round2(sum(mature48, 'comm') / mature48.length) : null,
      commissionPerDollar: sum(mature48, 'spend') ? round2(sum(mature48, 'comm') / sum(mature48, 'spend')) : null,
      mature24: mature24.length,
      mature48: mature48.length,
    };
  };
  const v1 = stats(cohort.v1), v2 = stats(cohort.v2);
  const delta = {};
  for (const k of ['t0SpendPerThread', 'spendPerThread', 'upperFireRate', 'medianViews6h', 'medianViews24h', 'dollarsPer1k24h', 'commissionPerThread', 'commissionPerDollar']) {
    delta[k] = v1[k] != null && v2[k] != null && v1[k] !== 0 ? round2((v2[k] - v1[k]) / Math.abs(v1[k])) : null;
  }
  return { cutover, v1Window: [new Date(v1From).toISOString(), cutover], v1, v2, delta };
}

export function formatScorecard(sc) {
  const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`);
  const row = (label, a, b, d, f = (x) => (x == null ? '—' : String(x))) => `${label.padEnd(18)} ${String(f(a)).padStart(8)} ${String(f(b)).padStart(8)} ${String(pct(d)).padStart(7)}`;
  const m = (x) => (x == null ? '—' : money(x));
  const r = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const body = [
    `${'metric'.padEnd(18)} ${'v1'.padStart(8)} ${'v2'.padStart(8)} ${'Δ'.padStart(7)}`,
    row('threads', sc.v1.threads, sc.v2.threads, null),
    row('T0 $/thread', sc.v1.t0SpendPerThread, sc.v2.t0SpendPerThread, sc.delta.t0SpendPerThread, m),
    row('all-in $/thread', sc.v1.spendPerThread, sc.v2.spendPerThread, sc.delta.spendPerThread, m),
    row('T1+ fire rate', sc.v1.upperFireRate, sc.v2.upperFireRate, sc.delta.upperFireRate, r),
    row('median views 6h', sc.v1.medianViews6h, sc.v2.medianViews6h, sc.delta.medianViews6h, fmtK),
    row('median views 24h', sc.v1.medianViews24h, sc.v2.medianViews24h, sc.delta.medianViews24h, fmtK),
    row('$ per 1k @24h', sc.v1.dollarsPer1k24h, sc.v2.dollarsPer1k24h, sc.delta.dollarsPer1k24h, m),
    row('commission/thread', sc.v1.commissionPerThread, sc.v2.commissionPerThread, sc.delta.commissionPerThread, m),
    row('commission per $', sc.v1.commissionPerDollar, sc.v2.commissionPerDollar, sc.delta.commissionPerDollar),
  ].join('\n');
  const note = `v1 = unstamped rows first fired ${sc.v1Window[0].slice(0, 10)} → ${sc.cutover.slice(0, 10)} · v2 = rows stamped v2 · holdouts excluded · fire rate and 24h views count threads ≥24h old (${sc.v1.mature24} / ${sc.v2.mature24}) · commission counts threads ≥48h old (${sc.v1.mature48} / ${sc.v2.mature48})`;
  return `<pre>${esc(body)}</pre>\n<i>${esc(note)}</i>`;
}

// ---- reconcile -----------------------------------------------------------------------------------
/** PI's lines per (vendor, UTC day) against the bot's per-source tallies. `vendorByChat` maps the
 *  bot's chat id -> Fuel Log vendor name (from vendors.json), because the two sides spell names
 *  differently ("one network alone" vs "the bundle"). */
/** When the bot's per-source tallies began, as epoch ms. The payload's `tally_since` when the bot
 *  reports it (persisted from its first boot with the tally code); otherwise inferred as the start of
 *  the day AFTER the earliest tallied day, because that first day is partial; Infinity when the bot
 *  has tallied nothing for this source yet. A Fuel Log line older than this is not drift — the bot
 *  was not counting when PI sent it. */
export function tallySince(status, source = 'rt-bridge') {
  const s = status && status.tally_since;
  if (s && Number.isFinite(Date.parse(s))) return Date.parse(s);
  let first = null;
  for (const v of (status && status.vendors) || []) for (const day of Object.keys(((v.sources || {})[source]) || {})) if (!first || day < first) first = day;
  return first ? Date.parse(`${first}T00:00:00Z`) + 864e5 : Infinity;
}

export function reconcile(rows, status, { days = [], source = 'rt-bridge', vendorByChat = {}, since } = {}) {
  const from = since === undefined ? tallySince(status, source) : since === null ? -Infinity : Date.parse(since);
  const live = days.filter((d) => Date.parse(`${d}T00:00:00Z`) + 864e5 > from);   // days the bot was tallying for at least part of
  const pi = {};
  // A COMMENT line ("Maven Comment", v6) is not an RT delivery: the bot meters it on the comment
  // ledger, which keeps no per-source tally, so there is nothing here to compare it to.
  for (const l of ledgerLines(rows)) if (live.includes(l.day) && Date.parse(l.at) >= from) for (const v of l.vendors) if (!/\bcomment\b/i.test(v)) pi[`${v}|${l.day}`] = (pi[`${v}|${l.day}`] || 0) + 1;
  const out = [];
  const seen = new Set();
  for (const v of (status && status.vendors) || []) {
    const name = vendorByChat[String(v.id)] || v.title;
    const tally = (v.sources || {})[source] || {};
    for (const day of live) {
      const t = tally[day] || { counted: 0, deduped: 0, skipped: 0 };
      const piN = pi[`${name}|${day}`] || 0;
      seen.add(`${name}|${day}`);
      const botDelivered = num(t.counted) + num(t.deduped) + num(t.skipped);
      let state;
      if (!piN && !botDelivered) continue;                       // nothing either side, nothing to say
      if (v.metered) state = piN === num(t.counted) + num(t.deduped) ? 'ok' : 'drift';
      else state = piN === botDelivered ? (v.paused ? 'paused' : 'unmetered') : 'drift';
      out.push({ vendor: name, day, pi: piN, counted: num(t.counted), deduped: num(t.deduped), skipped: num(t.skipped), metered: !!v.metered, paused: !!v.paused, state });
    }
  }
  // PI lines to a vendor the bot does not know at all (no preset) — still a finding.
  for (const [k, n] of Object.entries(pi)) if (!seen.has(k)) { const [vendor, day] = k.split('|'); out.push({ vendor, day, pi: n, counted: 0, deduped: 0, skipped: 0, metered: false, paused: false, state: 'unknown-to-bot' }); }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.vendor.localeCompare(b.vendor));
}

export function formatReconcile(rowsOut) {
  const drift = rowsOut.filter((r) => r.state === 'drift' || r.state === 'unknown-to-bot');
  if (!rowsOut.length) return '<i>No lines on either side for the window.</i>';
  const lines = rowsOut.map((r) => {
    const tag = { ok: '✅', drift: '❗', paused: '⏸', unmetered: '·', 'unknown-to-bot': '❓' }[r.state] || '?';
    return `${tag} ${esc(r.day)} ${esc(r.vendor)}: PI ${r.pi} · bot counted ${r.counted}${r.deduped ? ` (+${r.deduped} deduped)` : ''}${r.skipped ? ` · skipped ${r.skipped}` : ''}${r.state === 'unknown-to-bot' ? ' · not a bot destination' : ''}`;
  });
  return `${drift.length ? `<b>${drift.length} drift line${drift.length === 1 ? '' : 's'}</b>` : '<b>Ledgers agree</b>'}\n${lines.join('\n')}`;
}

// ---- health / lint -------------------------------------------------------------------------------
const TIERS = new Set(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);   // T6 since the v6 ladder (2026-10-02)
const tierOf = (g) => (typeof g.Tier === 'object' && g.Tier ? g.Tier.name : g.Tier) || '';
const isVendorRow = (f) => /^Vendor\s[–-]\s/.test(String(f.Name || ''));
const isRtRow = (f) => /^RT\s/.test(String(f.Name || ''));

/** Findings for the Airtable Config + Accounts roster. Pure: pass the rows' `fields`. */
export function lintConfig(configRows, accounts = []) {
  const F = [];
  const err = (msg) => F.push({ level: 'error', msg }), warn = (msg) => F.push({ level: 'warn', msg });
  const rows = configRows.map((r) => r.fields || r);
  const active = rows.filter((f) => f.Active);
  const vendors = active.filter(isVendorRow);
  const rtRows = active.filter(isRtRow);
  const byName = Object.fromEntries(rows.map((f) => [f.Name, f]));

  const vbot = byName['Vendor Bot'];
  if (!vbot || !vbot.Active || !String(vbot.Token || '').trim()) err('Config "Vendor Bot" row missing, inactive or without a Token — no vendor sends can go out');
  const tg = byName['Telegram'];
  if (!tg || !tg.Token || !String(tg['Chat ID'] || '').trim()) err('Config "Telegram" row missing Token or Chat ID — pipeline notes have nowhere to go');
  else { let topics = {}; try { topics = JSON.parse(tg.Topics || '{}'); } catch { warn('Config "Telegram" Topics is not valid JSON'); } if (!topics.fuel) warn('Config "Telegram" Topics has no "fuel" thread — fuel notes land in General'); }

  const chats = {};
  for (const f of vendors) {
    const chat = String(f['Chat ID'] || '').trim(), tier = tierOf(f);
    if (!chat) err(`${f.Name}: active but no Chat ID`);
    // A comment row shares its RT vendor's chat on purpose (v6, "Maven Comment"): a second product,
    // sent as a labelled COMMENT request, so it is not a double-send.
    else if (!/\bcomment\b/i.test(String(f.Name || ''))) (chats[chat] ||= []).push(f.Name);
    // A blank Tier is valid when Routes places the row on a lane ("B T0" — Hey Brother, Lane B only).
    const laned = /(?:^|[^A-Za-z])[A-Za-z]\w*\s*:?\s*T\d+/i.test(String(f.Routes || ''));
    if (!TIERS.has(tier) && !(tier === '' && laned)) warn(`${f.Name}: active with Tier "${tier || '(blank)'}" — never fires (valid: T0–T6)`);
    if (f.Price == null || f.Price === '') warn(`${f.Name}: no Price — bills as $0`);
    if (!num(f['Network Size'])) warn(`${f.Name}: Network Size blank or 0 — reach reads 0 on every card`);
  }
  for (const [chat, names] of Object.entries(chats)) if (names.length > 1) err(`Chat ID ${chat} on ${names.length} active vendor rows: ${names.join(', ')} — every fire would double-send there`);

  const t0 = vendors.filter((f) => tierOf(f) === 'T0' && String(f['Chat ID'] || '').trim());
  if (!t0.length) err('No active T0 network — the Bridge sends nothing at publish');
  const rtChats = new Set(rtRows.map((f) => String(f['Chat ID'] || '').trim()));
  for (const f of t0) if (rtChats.has(String(f['Chat ID']).trim())) warn(`${f.Name}: T0 row shares a chat with an RT row — BROKER arrangement is active for that RT group (direct sends are the standard since 2026-09-05)`);
  for (const f of rtRows) if (!String(f.Token || '').trim()) warn(`${f.Name}: RT row without a Token — its accounts get no ping`);

  const activeAccounts = accounts.map((a) => a.fields || a).filter((a) => a.Active);
  for (const a of activeAccounts) {
    if (a['Fuel T0'] && !a['RT Row']) warn(`@${a.Handle}: Fuel T0 checked but no RT Row — the Bridge skips it entirely`);
    if (a['RT Row'] && !byName[a['RT Row']]) warn(`@${a.Handle}: RT Row "${a['RT Row']}" has no Config row`);
    else if (a['RT Row'] && !byName[a['RT Row']].Active && !(a['Fuel T0'] && t0.length)) warn(`@${a.Handle}: RT Row "${a['RT Row']}" is inactive and it fuels no T0 — nothing is sent for it`);
    if (!a['Social Set ID']) warn(`@${a.Handle}: no Social Set ID — invisible to the poller`);
  }
  return F;
}

/** Membership results -> findings. `results` = [{name, chatId, status, error}] from getChatMember. */
export function lintMembership(results, botName = 'Vendor Bot') {
  const F = [];
  for (const r of results) {
    if (r.error) F.push({ level: 'error', msg: `${r.name} (${r.chatId}): ${botName} cannot see the chat — ${r.error}` });
    else if (!['member', 'administrator', 'creator'].includes(r.status)) F.push({ level: 'error', msg: `${r.name} (${r.chatId}): ${botName} is "${r.status}" — sends there will fail` });
  }
  return F;
}

export function formatFindings(findings, { title = 'Vendor health' } = {}) {
  if (!findings.length) return `✅ <b>${esc(title)}</b>: all clear`;
  const errs = findings.filter((f) => f.level === 'error'), warns = findings.filter((f) => f.level === 'warn');
  const block = (arr, tag) => arr.map((f) => `${tag} ${esc(f.msg)}`).join('\n');
  return [`<b>${esc(title)}</b>: ${errs.length} error${errs.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}`, block(errs, '❗'), block(warns, '⚠️')].filter(Boolean).join('\n');
}

// ---- RT usage tracker -----------------------------------------------------------------------------
export const RT_USAGE_TABLE = 'RT Usage';            // REGISTRY_BASE_ID, by name (tblcQFdEhlUxMNYyQ)
export const USAGE_WINDOW_START = '2026-09-05';      // T0 went direct: the first day the Fuel Log bills per network
const cleanVendor = (n) => String(n || '').replace(/^Vendor\s[–-]\s/, '');

/** One upsert row per Config vendor row for the "RT Usage" table. Synced fields only — the
 *  operator-owned ones (Package Cost, Monthly Retainer, Package Start, Next Payment, Deal Type,
 *  Notes) are seeded on a row's FIRST appearance and never written again. `existing` = current
 *  RT Usage rows; `vendors` = vendors.json entries; `botStatus` = GET /vendor-status or null. */
export function usagePlan({ config = [], vendors = [], fuelRows = [], botStatus = null, existing = [], now = Date.now() } = {}) {
  const cfg = config.map((r) => r.fields || r).filter((f) => isVendorRow(f) && String(f['Chat ID'] || '').trim());
  const vByChat = Object.fromEntries(vendors.filter((v) => v.chatId).map((v) => [String(v.chatId), v]));
  const botByChat = Object.fromEntries((((botStatus || {}).vendors) || []).map((v) => [String(v.id), v]));
  const exByName = Object.fromEntries(existing.map((r) => r.fields || r).map((f) => [f.Vendor, f]));
  const rate = vendorRate(fuelRows, { days: 7, now });
  const lines = ledgerLines(fuelRows);
  const out = [];
  for (const f of cfg) {
    const name = cleanVendor(f.Name), chat = String(f['Chat ID']).trim();
    if (name === 'Test') continue;                                  // the test destination is not a vendor
    // A COMMENT row (v6: "Maven Comment") shares an RT vendor's chat but is its own product with its own
    // package: it reads the bot's comment ledger (/vendor-status `comments`), never the RT one, and
    // takes nothing from the RT vendor's vendors.json entry.
    const isComment = /\bcomment\b/i.test(name);
    const botRow = botByChat[chat];
    const bot = !isComment ? botRow : (botRow && botRow.comments
      ? { tracked: true, unlimited: false, paused: !!botRow.comments.paused, used: botRow.comments.used, total: botRow.comments.total }
      : null);
    const vj = isComment ? undefined : vByChat[chat], ex = exByName[name];
    const ledgerTracked = !!(bot && bot.tracked && !bot.unlimited);  // the bot keeps a used/remaining ledger (paused still counts as a ledger)
    const row = {
      Vendor: name, 'Chat ID': chat, Active: !!f.Active, Tier: tierOf(f) || '',
      'Cost per Post (config)': Number(f.Price) || 0,
      'Rate (posts/day)': round2(rate[name] || 0),
      'Paused on Bot': !!(bot && bot.paused),
      'Last Updated': new Date(now).toISOString(),
    };
    if (ledgerTracked) {
      row.Used = num(bot.used); row['Package Size'] = num(bot.total); row['Used Source'] = 'bot';
      // Burn: how fast the package is really going — the ledger's change since the last sync, over the
      // days between, averaged with the last estimate. The ledger counts every source the bot routes to
      // the vendor, so for a shared network this is the number Renew By must use; our own send rate
      // (Rate) understates it. Needs a previous bot-sourced sync to difference against; a same-day
      // re-run or a package reset (Used went down) carries the last estimate forward.
      const prevUsed = ex && ex['Used Source'] === 'bot' ? Number(ex.Used) : NaN;
      const prevBurn = ex ? Number(ex['Burn (posts/day)']) || 0 : 0;
      const elapsed = ex ? (now - Date.parse(ex['Last Updated'])) / 864e5 : NaN;
      if (Number.isFinite(prevUsed) && Number.isFinite(elapsed) && elapsed >= 0.5 && row.Used >= prevUsed) {
        const instant = (row.Used - prevUsed) / elapsed;
        row['Burn (posts/day)'] = round2(prevBurn > 0 ? (prevBurn + instant) / 2 : instant);
      } else if (prevBurn > 0) row['Burn (posts/day)'] = prevBurn;
    } else {
      const start = ex && ex['Package Start'] ? Date.parse(ex['Package Start']) : Date.parse(USAGE_WINDOW_START);
      row.Used = lines.filter((l) => l.vendors.includes(name) && Date.parse(l.at) >= start).length;
      row['Used Source'] = 'fuel-log';
    }
    if (!ex) {                                                       // seed once; the operator owns these afterwards
      row['Deal Type'] = ledgerTracked ? 'package' : ({ per_post: 'per_post', retainer: 'retainer', free: 'free' })[vj && vj.cost && vj.cost.model] || 'per_post';
      if (vj && vj.cost && vj.cost.monthlyRetainer) row['Monthly Retainer'] = vj.cost.monthlyRetainer;
      if (!ledgerTracked) row['Package Start'] = USAGE_WINDOW_START;
    }
    out.push(row);
  }
  return out.sort((a, b) => Number(b.Active) - Number(a.Active) || a.Vendor.localeCompare(b.Vendor));
}

export function formatUsagePlan(rows) {
  const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  const head = `${w('vendor', 20)} ${w('tier', 5)} ${'used'.padStart(5)} ${'pkg'.padStart(5)} ${'rate/d'.padStart(6)} ${'burn/d'.padStart(6)} ${w('source', 9)} ${w('deal', 9)} active`;
  return [head, ...rows.map((r) => `${w(r.Vendor, 20)} ${w(r.Tier, 5)} ${String(r.Used ?? '').padStart(5)} ${String(r['Package Size'] ?? '').padStart(5)} ${String(r['Rate (posts/day)']).padStart(6)} ${String(r['Burn (posts/day)'] ?? '').padStart(6)} ${w(r['Used Source'], 9)} ${w(r['Deal Type'] || '(kept)', 9)} ${r.Active ? '✓' : '·'}`)].join('\n');
}

// ---- supply model (vendor-supply.mjs, vendor-payments.mjs) ---------------------------------------
// The RT packages are inventory: a stock of posts that depletes at an uncertain rate and takes time
// to replenish. The arithmetic lives here, not in the scripts, so both plan from ONE demand figure
// and the numbers are pinned by tests/vendor-supply.test.mjs.
export const REGIME_START = CUTOVER_V2;             // T0 direct + v2 ladder: demand before and after are different populations
export const Z = { 90: 1.28, 95: 1.65, 99: 2.33 }; // one-sided normal quantiles for the service level

/** Daily demand series for one vendor: one entry per UTC day in the window, zeros included — a day we
 *  sent nothing is data, not a gap, and dropping it inflates both mean and sigma. */
export function dailySeries(lines, vendor, { days, now = Date.now() }) {
  const byDay = new Map();
  for (let d = 0; d < days; d++) byDay.set(new Date(now - d * 864e5).toISOString().slice(0, 10), 0);
  for (const l of lines) {
    if (!l.vendors.includes(vendor)) continue;
    const k = String(l.at).slice(0, 10);
    if (byDay.has(k)) byDay.set(k, byDay.get(k) + 1);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, n]) => ({ day, n }));
}

export function meanSd(xs) {
  if (!xs.length) return { mean: 0, sd: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varr = xs.length < 2 ? 0 : xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return { mean, sd: Math.sqrt(varr), n: xs.length };
}

export const safetyStock = (sd, leadDays, z) => z * sd * Math.sqrt(Math.max(leadDays, 0));
export const reorderPoint = (meanDemand, leadDays, safety) => meanDemand * leadDays + safety;

/** Where a vendor stands against its own reorder point. */
/** Where a vendor's stock comes from for planning. vendor-credits.json is hand-maintained and its
 *  own header says so: "The RT bot's counter is the source of truth for Used — other people send
 *  into these groups too, so our Fuel Log can only ever be a floor." So the ledger wins wherever the
 *  bot keeps one (a PAUSED vendor still has a ledger), and the file is the fallback for vendors the
 *  bot does not meter and for a run where /vendor-status is down. `stock` may be NEGATIVE when a
 *  pack is overdrawn — supplyStatus reads that as OUT and orderSize buys the hole back.
 *  `owed` is the delivered-but-unpaid quantity for a vendor marked unpaid: the whole pack was
 *  delivered, so consuming it does not change what it costs. */
export function stockOf(v, botByChat = {}) {
  const bot = botByChat[String(v.chatId)];
  const tracked = !!(bot && bot.tracked && !bot.unlimited && Number.isFinite(Number(bot.total)) && Number.isFinite(Number(bot.used)));
  const total = tracked ? Number(bot.total) : Number(v.total);
  const used = tracked ? Number(bot.used) : Number(v.used);
  return { total, used, stock: total - used, owed: Math.max(0, total), source: tracked ? 'bot' : 'file' };
}

/** GET /vendor-status keys its ledger by Telegram chat id, the same join usagePlan uses. */
export function botLedgerByChat(status) {
  return Object.fromEntries((((status || {}).vendors) || []).map((b) => [String(b.id), b]));
}

export function supplyStatus(stock, rop, meanDemand) {
  if (stock <= 0) return 'OUT';
  if (meanDemand <= 0) return 'IDLE';
  if (stock <= rop) return 'REORDER';
  if (stock <= rop * 1.5) return 'SOON';
  return 'OK';
}

/** Order up to the target cover, never past it. Returns 0 when stock already exceeds the target. */
export function orderSize(meanDemand, coverDays, leadDays, stock, safety) {
  const target = meanDemand * (coverDays + leadDays) + safety;
  return Math.max(0, Math.ceil(target - stock));
}

/** Distinct pages that fired at least once in the window — the population whose posting the history
 *  measured. Case-folded: the Fuel Log carries "SomePage" and "somepage" for one page. */
export function fleetInWindow(lines, { days, now = Date.now() }) {
  const since = now - days * 864e5;
  const seen = new Set();
  for (const l of lines) if (l.account && Date.parse(l.at) >= since) seen.add(String(l.account).trim().toLowerCase());
  return seen.size;
}

/** Planning demand for one vendor, posts/day, and how it was built:
 *
 *    measured = max(windowed mean, mean since REGIME_START)   the history — our own sends, a floor
 *    × fleet / base                                            pages posting now vs pages whose
 *                                                              posting the history measured
 *    × buffer                                                  the operator's viral allowance
 *
 *  The fleet term is structural and certain (the pages exist and post). The buffer is the allowance
 *  for content running hotter than the window did (operator, 2026-09-06: "add in buffer for possible
 *  extra usage as the content goes more viral"). Sigma is scaled by the same factor: for a counting
 *  process the spread grows at least with the square root of the level, so scaling it linearly is
 *  the conservative side — and supply planning is asymmetric: understating demand costs a stock-out
 *  mid-viral, overstating it costs a little cheap inventory that rolls over. */
export function planningDemand(lines, vendor, { window = 14, now = Date.now(), regimeStart = REGIME_START, fleet = null, base = null, buffer = 1 } = {}) {
  const series = dailySeries(lines, vendor, { days: window, now });
  const { mean, sd } = meanSd(series.map((s) => s.n));
  const cut = Date.parse(regimeStart);
  const sinceRegime = Math.max((now - cut) / 864e5, 0.5);
  const recent = lines.filter((l) => l.vendors.includes(vendor) && Date.parse(l.at) >= cut).length / sinceRegime;
  const measured = Math.max(mean, recent);
  const baseFleet = Number(base) > 0 ? Number(base) : fleetInWindow(lines, { days: window, now });
  const pages = Number(fleet) > 0 ? Number(fleet) : null;
  const fleetFactor = pages && baseFleet > 0 ? pages / baseFleet : 1;
  const viral = Number(buffer) > 0 ? Number(buffer) : 1;
  const scale = fleetFactor * viral;
  return { vendor, series, windowMean: mean, recent, measured, sd, fleet: pages, baseFleet, fleetFactor, buffer: viral, scale, demand: measured * scale, sigma: sd * scale };
}

// ---- rotation ------------------------------------------------------------------------------------
// Today every fire goes to EVERY active vendor in its tier, so a 30-post pack burns exactly as fast
// as a 1000-post pack beside it, and the thin packs run dry while the fat ones sit as dead cash.
// Rotation sends each fire to the K metered vendors in the tier with the most posts left above a
// reserve; unlimited vendors always send (they cost nothing per post). It is stateless — stock
// levels drive the alternation: two equal packs alternate, a fat pack drains before a thin one is
// touched, and a pack at its reserve rests until it is refilled. Reach per fire drops when K is
// below the tier's size; the board prints that cost next to the cover it buys.

/** Which vendors take the next fire. `vendors`: [{ name, stock, unlimited, reach, price }]. */
export function rotationPick(vendors, { k = Infinity, reserve = 3 } = {}) {
  const free = vendors.filter((v) => v.unlimited);
  const metered = vendors.filter((v) => !v.unlimited);
  // reserve null = today's ladder: no stock check at all, a pack keeps taking fires past zero (overdraw)
  let pool = reserve == null ? metered : metered.filter((v) => v.stock > reserve);
  if (!pool.length && reserve != null) pool = metered.filter((v) => v.stock > 0);   // a reserve is not a reason to let a tier go dark
  const n = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : pool.length;
  const pick = [...pool].sort((a, b) => b.stock - a.stock || String(a.name).localeCompare(String(b.name))).slice(0, n);
  return [...free, ...pick];
}

/** Run one tier forward `days` days with fires arriving at `rate` per day (an accumulator turns the
 *  fractional rate into whole fires). Returns per-vendor share, burn/day and the day each hits its
 *  reserve — its cover under the policy — plus reach and cost per fire and the fires nobody could
 *  take. k = Infinity with reserve = null reproduces today's ladder: everyone, every fire, past zero. */
export function rotationSim(vendors, rate, { k = Infinity, reserve = 3, days = 90 } = {}) {
  const state = vendors.map((v) => ({ ...v, stock: v.unlimited ? Infinity : Number(v.stock) || 0, taken: 0, coverDay: null }));
  const floor = reserve == null ? 0 : reserve;   // cover = the day a pack reaches this
  let acc = 0, fires = 0, reach = 0, cost = 0, dark = 0, darkFrom = null;
  for (let d = 0; d < days; d++) {
    acc += rate;
    while (acc >= 1) {
      acc -= 1; fires += 1;
      const pick = rotationPick(state, { k, reserve });
      if (!pick.length) { dark += 1; if (darkFrom == null) darkFrom = d + 1; }
      for (const p of pick) {
        p.taken += 1; reach += Number(p.reach) || 0; cost += Number(p.price) || 0;
        if (!p.unlimited) { p.stock -= 1; if (p.stock <= floor && p.coverDay == null) p.coverDay = d + 1; }
      }
    }
  }
  const served = fires - dark;
  return {
    fires, dark, served, darkFrom,
    reachPerFire: served ? reach / served : 0, costPerFire: served ? cost / served : 0,   // over the fires somebody took
    overdraw: state.reduce((s, v) => s + (v.unlimited ? 0 : Math.max(0, -v.stock)), 0),  // posts taken past zero (reserve null only)
    vendors: state.map((s) => ({ name: s.name, unlimited: !!s.unlimited, taken: s.taken, share: fires ? s.taken / fires : 0,
      burn: s.taken / days, left: s.unlimited ? Infinity : s.stock, coverDay: s.unlimited ? Infinity : s.coverDay ?? Infinity })),
  };
}

/** Steady state of a tier at fan-out k with every pack stocked: most-stock-first equalises the packs,
 *  so each metered vendor takes k/n of the fires. Reach and cost per fire follow directly, and the
 *  tier's monthly bill at `rate` fires/day is what the fan-out decision is really about. */
export function fanoutTable(vendors, rate) {
  const free = vendors.filter((v) => v.unlimited), metered = vendors.filter((v) => !v.unlimited);
  const freeReach = free.reduce((s, v) => s + (Number(v.reach) || 0), 0);
  const sumReach = metered.reduce((s, v) => s + (Number(v.reach) || 0), 0);
  const sumPrice = metered.reduce((s, v) => s + (Number(v.price) || 0), 0);
  const n = metered.length, out = [];
  for (let k = n; k >= 1; k--) {
    const f = k / n;
    out.push({ k, reachPerFire: freeReach + f * sumReach, costPerFire: f * sumPrice, postsPerDay: k * rate, monthly: f * sumPrice * rate * 30 });
  }
  return out;
}

/** Parse `--fanout "T1=2,T2=1,T3=1"` into { T1: 2, ... }; `all` (or anything non-numeric) means the whole tier. */
export function parseFanout(spec = '') {
  const out = {};
  for (const part of String(spec).split(',')) {
    const [t, v] = part.split('=').map((s) => s && s.trim());
    if (!t) continue;
    const n = Number(v);
    out[t.toUpperCase()] = Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
  }
  return out;
}

// ---- budget --------------------------------------------------------------------------------------
// "If we want to spend a maximum of $5k this month on RT supply, how should we spread it?"
// (operator, 2026-09-06). The ladder as it runs today sends every fire to every vendor in the tier,
// so a tier is ALIVE while any of its vendors has stock and at FULL REACH only while all of them do.
// The budget goes, in order:
//   1. fixed lines off the top — retainers (unlimited supply, the best value in the system) and the
//      installment on delivered-unpaid packs (a debt, not a purchase)
//   2. KEEP EVERY TIER ALIVE through the month: the tier that goes dark first is funded first, on
//      whichever of its vendors reaches the target most cheaply (usually the one with most stock)
//   3. FULL REACH with what is left: fill the remaining vendors to the month in order of reach per
//      dollar, so the last dollar buys the most audience
// A tier whose cheapest keep-alive is beyond the money left is reported as unfunded with the price
// of fixing it, not silently skipped. Offers are fixed packs (all or nothing); other vendors are
// bought per post with a minimum order, which is what a vendor will actually sell.

/** Cheapest way to give `vendor` `need` more posts: a whole number of offer packs if there is an
 *  offer, otherwise per-post at a minimum order. Returns { posts, cost, unit }. */
export function buyPosts(vendor, need, { minOrder = 50 } = {}) {
  if (need <= 0) return { posts: 0, cost: 0, unit: vendor.offer ? vendor.offer.price / vendor.offer.posts : vendor.price };
  if (vendor.offer && vendor.offer.posts > 0) {
    const packs = Math.ceil(need / vendor.offer.posts);
    return { posts: packs * vendor.offer.posts, cost: packs * vendor.offer.price, unit: vendor.offer.price / vendor.offer.posts, packs };
  }
  const posts = Math.max(Math.ceil(need), minOrder);
  return { posts, cost: posts * vendor.price, unit: vendor.price };
}

export function budgetPlan({ tiers, budget, days = 30, fixed = [], minOrder = 50, critical = [], targets = {}, installments = {} } = {}) {
  // INSTALLMENTS (operator, 2026-09-06: "I can spread Pammy into 6 payments of 500 — they are very
  // flexible, as long as we keep adding new payments on top of the current package"). A vendor on
  // terms delivers the posts NOW and bills monthly, so only the first payment competes for this
  // month's cash. The budget is therefore a CASH budget, not a purchase budget: `cash` is what a buy
  // costs this month, `cost` is what it costs in total. The catch is that each month's buys stack
  // into the next month's obligation, so the plan reports the committed total beside the cash.
  const nOf = (v) => Math.max(1, Math.floor(Number(installments[v.name]) || 1));
  const cashOf = (v, cost) => cost / nOf(v);
  // A tier can be TRIMMED: funded to fewer days than the month, deliberately, because its reach is
  // already carried by a cheaper tier that fires on the same post (operator, 2026-09-06: "we can trim
  // some of the other tiers like Hey Brother or Pst or WD"). targets is tier -> days; absent = month.
  const dayFor = (t) => { const n = Number(targets[t.tier]); return Number.isFinite(n) && n >= 0 ? n : days; };
  const fixedTotal = fixed.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  let left = budget - fixedTotal;
  const state = tiers.map((t) => ({ ...t, vendors: t.vendors.map((v) => ({ ...v, stock: v.unlimited ? Infinity : Number(v.stock) || 0, bought: 0, spent: 0 })) }));
  // A vendor's own demand is the tier rate times the share of fires it takes. Today every vendor in
  // a tier takes every fire (share 1); under rotation it takes k/n of them, which is the whole point
  // of the fan-out — it is four times cheaper to keep two vendors alive when they alternate.
  const rateOf = (t, v) => t.rate * (v.share == null ? 1 : v.share);
  const coverOf = (t, v) => (rateOf(t, v) > 0 ? v.stock / rateOf(t, v) : Infinity);
  const alive = (t) => Math.max(...t.vendors.map((v) => coverOf(t, v)));
  const full = (t) => Math.min(...t.vendors.map((v) => coverOf(t, v)));
  const before = Object.fromEntries(state.map((t) => [t.tier, { alive: alive(t), full: full(t) }]));
  const purchases = [], unfunded = [];
  const buy = (t, v, q, why) => {
    const n = nOf(v), cash = cashOf(v, q.cost);
    v.stock += q.posts; v.bought += q.posts; v.spent += q.cost; left -= cash;
    purchases.push({ tier: t.tier, name: v.name, posts: q.posts, cost: q.cost, cash, installments: n, unit: q.unit, ...(q.packs ? { packs: q.packs } : {}), why });
  };

  // 2. CRITICAL VENDORS FIRST (operator, 2026-09-06: "most important is Pammy and IP always alive").
  // A named vendor is funded to its own month of cover before any tier-level spending — keeping a
  // tier alive only guarantees SOMEBODY in it has posts, which is not the same promise.
  for (const name of critical) {
    for (const t of state) {
      const v = t.vendors.find((x) => x.name === name && !x.unlimited);
      if (!v) continue;
      const need = rateOf(t, v) * dayFor(t) - v.stock;
      if (need <= 0) continue;
      const q = buyPosts(v, need, { minOrder });
      if (cashOf(v, q.cost) > left) { unfunded.push({ kind: 'vendor', vendor: name, tier: t.tier, cover: coverOf(t, v), cheapest: { name, posts: q.posts, cost: q.cost, cash: cashOf(v, q.cost) } }); continue; }
      buy(t, v, q, `keep ${name} alive to day ${dayFor(t)} — CRITICAL`);
    }
  }
  // 3. keep every tier alive through the month, bottleneck first
  const skip = new Set();
  for (;;) {
    const short = state.filter((t) => !skip.has(t.tier) && alive(t) < dayFor(t)).sort((a, b) => alive(a) - dayFor(a) - (alive(b) - dayFor(b)));
    if (!short.length) break;
    const t = short[0];
    const options = t.vendors.filter((v) => !v.unlimited).map((v) => ({ v, q: buyPosts(v, rateOf(t, v) * dayFor(t) - v.stock, { minOrder }) })).sort((a, b) => a.q.cost - b.q.cost);
    const pick = options.find((o) => cashOf(o.v, o.q.cost) <= left && o.q.posts > 0);
    if (!pick) { unfunded.push({ kind: 'tier', tier: t.tier, alive: alive(t), cheapest: options[0] ? { name: options[0].v.name, posts: options[0].q.posts, cost: options[0].q.cost, cash: cashOf(options[0].v, options[0].q.cost) } : null }); skip.add(t.tier); continue; }
    buy(t, pick.v, pick.q, `keep ${t.tier} alive to day ${dayFor(t)}`);
  }
  // 4. full reach with what is left: reach per dollar, best first, partial fills allowed
  const unit = (v) => (v.offer ? v.offer.price / v.offer.posts : v.price);
  const fills = [];
  for (const t of state) for (const v of t.vendors) if (!v.unlimited && rateOf(t, v) > 0 && v.stock < rateOf(t, v) * dayFor(t)) fills.push({ t, v });
  fills.sort((a, b) => (b.v.reach || 0) / unit(b.v) - (a.v.reach || 0) / unit(a.v));
  for (const { t, v } of fills) {
    const need = rateOf(t, v) * dayFor(t) - v.stock;
    let q = buyPosts(v, need, { minOrder });
    if (cashOf(v, q.cost) > left && !v.offer) { const posts = Math.floor((left * nOf(v)) / v.price); if (posts < minOrder) continue; q = { posts, cost: posts * v.price, unit: v.price }; }
    if (cashOf(v, q.cost) > left || q.posts <= 0) continue;
    buy(t, v, q, `full reach on ${t.tier} (${(v.reach || 0) >= 1e6 ? (v.reach / 1e6).toFixed(2) + 'M' : Math.round((v.reach || 0) / 1e3) + 'k'} per post)`);
  }
  const after = Object.fromEntries(state.map((t) => [t.tier, { alive: alive(t), full: full(t) }]));
  const spent = purchases.reduce((s2, p) => s2 + p.cash, 0);          // cash out THIS month
  const committed = purchases.reduce((s2, p) => s2 + p.cost, 0);      // total value bought
  const nextMonths = purchases.filter((p) => p.installments > 1).reduce((s2, p) => s2 + p.cash, 0);
  return { budget, days, targets, fixed, fixedTotal, critical, installments, purchases, spent, committed, nextMonths, left, unfunded, before, after,
    vendors: state.flatMap((t) => t.vendors.filter((v) => !v.unlimited).map((v) => ({ tier: t.tier, name: v.name, bought: v.bought, spent: v.spent, cover: coverOf(t, v) }))) };
}

/** What each tier costs at a range of targets, so a trim is a priced choice rather than a guess.
 *  `alive` is the cheapest single vendor that carries the tier to N days; `full` is every metered
 *  vendor to N days (what the tier costs at today's send-to-all reach). */
export function trimMenu(tiers, { steps = [30, 20, 15, 10, 0], minOrder = 50 } = {}) {
  return tiers.map((t) => {
    const metered = t.vendors.filter((v) => !v.unlimited);
    const rateOf = (v) => t.rate * (v.share == null ? 1 : v.share);
    const at = steps.map((n) => {
      const buys = metered.map((v) => ({ v, q: buyPosts(v, rateOf(v) * n - v.stock, { minOrder }) }));
      const aliveNow = metered.length ? Math.max(...metered.map((v) => (rateOf(v) > 0 ? v.stock / rateOf(v) : Infinity))) : Infinity;
      const cheapest = buys.filter((b) => b.q.posts > 0).sort((a, b) => a.q.cost - b.q.cost)[0];
      return { days: n, alive: aliveNow >= n ? 0 : cheapest ? cheapest.q.cost : null, aliveVia: aliveNow >= n ? 'already' : cheapest ? cheapest.v.name : null,
        full: buys.reduce((s2, b) => s2 + b.q.cost, 0) };
    });
    return { tier: t.tier, rate: t.rate, reach: t.vendors.reduce((s2, v) => s2 + (Number(v.reach) || 0), 0),
      price: metered.reduce((s2, v) => s2 + (Number(v.price) || 0), 0),
      stockDays: metered.length ? Math.max(...metered.map((v) => (rateOf(v) > 0 ? v.stock / rateOf(v) : Infinity))) : Infinity, at };
  });
}

/** Reach a tier adds per dollar, and how long its own inventory lasts. The ladder is cumulative — a
 *  post that earns T5 also fired T0..T4 — so a tier whose reach is matched by a cheaper tier with
 *  months of stock is the first place to trim. Sorted worst value first: that is the trim order. */
export function trimOrder(menu) {
  return menu.filter((m) => m.price > 0).map((m) => ({ ...m, reachPerDollar: m.reach / m.price }))
    .sort((a, b) => a.reachPerDollar - b.reachPerDollar);
}

/** Trim the worst-value tiers until the budget covers everything it must, and no further.
 *  Steps down one notch at a time on the tier with the least reach per dollar that is not carrying a
 *  critical vendor, replanning after each notch. Returns the first plan with nothing unfunded, or the
 *  last one tried. Never trims a tier below `floor` days, and never trims a critical vendor's tier. */
export function autoTrim(args, { steps = [30, 20, 15, 10, 5, 0], floor = 0 } = {}) {
  const { tiers, critical = [] } = args;
  const protectedTiers = new Set(tiers.filter((t) => t.vendors.some((v) => critical.includes(v.name))).map((t) => t.tier));
  const order = trimOrder(trimMenu(tiers, { steps })).map((m) => m.tier).filter((t) => !protectedTiers.has(t));
  const targets = { ...(args.targets || {}) };
  let plan = budgetPlan({ ...args, targets });
  const trail = [];
  // Only trim a tier the plan is actually SPENDING on, or one it cannot afford. Cutting the target of
  // a tier its own stock already carries frees nothing and reads as abandoning a tier we were never
  // funding. An UNFUNDED tier is the other real candidate: its own stock often carries it to a
  // shorter target, so the trim costs nothing and removes the shortfall outright.
  const spendOn = (p, tier) => p.purchases.filter((x) => x.tier === tier).reduce((s2, x) => s2 + x.cash, 0);
  const shortOn = (p, tier) => p.unfunded.some((u) => u.kind === 'tier' && u.tier === tier);
  for (let guard = 0; guard < order.length * steps.length && plan.unfunded.length; guard++) {
    const tier = order.find((t) => {
      const cur = targets[t] ?? args.days ?? 30;
      return (spendOn(plan, t) > 0 || shortOn(plan, t)) && steps.some((x) => x < cur && x >= floor);
    });
    if (!tier) break;
    const cur = targets[tier] ?? args.days ?? 30;
    targets[tier] = steps.find((x) => x < cur && x >= floor);
    trail.push({ tier, to: targets[tier], frees: spendOn(plan, tier), was: shortOn(plan, tier) ? 'short' : 'spend' });
    plan = budgetPlan({ ...args, targets });
  }
  for (const t of Object.keys(targets)) if (targets[t] === (args.days ?? 30)) delete targets[t];
  return { ...plan, targets, trail, protectedTiers: [...protectedTiers] };
}

// ---- subscriptions -------------------------------------------------------------------------------
// Operator, 2026-09-06: "I just make a subscription so we only pay them that much at a fixed time
// every month, and then we know we will always have the usage... We never overspend or invest all of
// the budget into one vendor at any given point. We're spreading the money across the accounts."
//
// This is a different question from budgetPlan's. budgetPlan asks "what can this month's cash buy".
// A subscription asks "what does each vendor cost to RUN, forever" — demand x price x 30 — and then
// whether the budget covers the whole roster. If it does, nobody is ever renegotiated and no count
// ever reaches zero. If it does not, the honest answer is the gap and the cheapest way to close it,
// not a plan that quietly starves three vendors.
//
// Payments are staggered across the cycle so no single day is heavy — the operator's "spread the
// money across the accounts" — and the cadence can be monthly, biweekly or weekly.

/** How often each TIER fires, per day — not how often a given vendor was sent to.
 *
 *  This distinction is the whole ballgame and getting it wrong sized a package 2.5x too big. A
 *  vendor's own line history says how often it was fired at IN THE ROLE IT HELD THEN. The v2 ladder
 *  (2026-09-05) moved Pammy and IP out of T1 and into T2, and moved three vendors the
 *  other way; a 14-day window straddles that, so Pammy's history is T1 volume while its price is T1's
 *  no longer. What actually depletes a vendor's stock is how often ITS CURRENT TIER fires, times its
 *  share of that tier's fan-out.
 *
 *  A fire is one (thread, tier) event, counted once however many vendors it went to. */
export function tierFireRate(lines, { window = 14, now = Date.now(), regimeStart = REGIME_START, fleet = null, base = null, buffer = 1 } = {}) {
  const seen = new Set(), events = [];
  for (const l of lines) {
    const k = `${l.tid}|${l.tier}`;
    if (seen.has(k)) continue;
    seen.add(k);
    events.push({ tier: l.tier, at: l.at, vendors: [l.tier], account: l.account });   // vendors:[tier] so dailySeries can key on it
  }
  const out = {};
  for (const tier of [...new Set(events.map((e) => e.tier))]) {
    const p = planningDemand(events, tier, { window, now, regimeStart, fleet, base, buffer });
    out[tier] = p.demand;
  }
  return out;
}

/** Per-vendor monthly run cost at its own demand. `share` is its slice of the tier's fires. */
export function subscriptionCost(tiers, { days = 30 } = {}) {
  const out = [];
  for (const t of tiers) for (const v of t.vendors) {
    if (v.unlimited) continue;
    const rate = t.rate * (v.share == null ? 1 : v.share);
    const price = Number(v.price) || 0;
    out.push({ tier: t.tier, name: v.name, rate, price, posts: rate * days, monthly: rate * days * price,
      reach: Number(v.reach) || 0, reachPerDollar: price > 0 ? (Number(v.reach) || 0) / price : Infinity, stock: v.stock });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}

/** Fit the roster into a cash budget. Everything that fits is subscribed; what does not is reported
 *  with the cheapest lever to close the gap. Cuts come from the worst reach-per-dollar vendor first
 *  and never from `critical`. `cadence` splits each subscription into equal payments across the
 *  cycle, staggered so the outflow is level rather than lumpy. */
export function subscriptionPlan(tiers, { budget, days = 30, fixed = [], critical = [], cadence = 1, protectTiers = [] } = {}) {
  const fixedTotal = fixed.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const room = budget - fixedTotal;
  const all = subscriptionCost(tiers, { days });
  const keep = [], cut = [];
  const protect = new Set(protectTiers);
  // Best value first, so the money buys the most reach it can before anything is dropped.
  const ranked = [...all].sort((a, b) => b.reachPerDollar - a.reachPerDollar);
  let spent = 0;
  for (const v of ranked) {
    const must = critical.includes(v.name) || protect.has(v.tier);
    if (spent + v.monthly <= room || must) { keep.push(v); spent += v.monthly; }
    else cut.push(v);
  }
  const over = Math.max(0, spent - room);
  // Stagger: each kept vendor pays on its own day(s) of the cycle, biggest first onto the earliest
  // slots so a heavy vendor never shares a day with another heavy one.
  const perCycle = Math.max(1, Math.floor(cadence));
  const step = Math.max(1, Math.floor(28 / Math.max(1, keep.length)));
  const schedule = [...keep].sort((a, b) => b.monthly - a.monthly).map((v, i) => ({
    name: v.name, tier: v.tier, monthly: v.monthly, perPayment: v.monthly / perCycle,
    days: Array.from({ length: perCycle }, (_, k) => ((i * step + k * Math.floor(28 / perCycle)) % 28) + 1).sort((a, b) => a - b),
  }));
  const rosterCost = all.reduce((s2, v) => s2 + v.monthly, 0);   // EVERY vendor, fits or not
  return { budget, fixed, fixedTotal, room, all, keep, cut, spent, over, cadence: perCycle, schedule,
    rosterTotal: rosterCost + fixedTotal,        // what running the whole roster actually costs
    keptTotal: spent + fixedTotal,               // what the budget can actually carry
    gap: Math.max(0, rosterCost + fixedTotal - budget),
    covered: cut.length === 0 && rosterCost + fixedTotal <= budget };
}

// ===== SPLIT TEST READOUT (operator 2026-09-14) ==============================================
// Arm A is the full ladder; arm B the reduced one. What makes this readout worth writing is not
// the comparison — it is REFUSING to call one when the numbers cannot carry it.
//
// Commission per thread has CV ~2.7 with about half of all threads earning exactly zero, so two
// arms differ by double digits with no intervention at all. Assigning historical threads to arms
// with the same hash and changing NOTHING produced a 22.5% gap. A readout that printed "B is up
// 12%" would therefore be reporting noise as a result, and the operator would act on it.
//
// So every comparison here carries a Welch confidence interval and a verdict that stays "not
// decidable" until that interval clears zero. The PLACEBO row is the honest control: threads that
// fired before the test existed, split by the same hash, whose gap is pure sampling noise. If the
// live gap is not clearly bigger than the placebo gap, there is nothing here yet.

// THE TESTS, OLDEST FIRST. The Config row "Fuel Split Test" holds ONE arm B at a time, so starting a
// test ends the one before it. Each `from` is when that arm B began buying: the first Fuel the Fire
// run that read the row, which is not always the moment the row was edited.
//
// The first test shows why. Its switch went Active at 06:48Z on 2026-09-14, but the n8n node's
// filterByFormula did not fetch the switch row, so for five and a half hours the code drew no arm and
// muted no tier. Widening that formula at 12:14Z is its real start.
//
// Dates matter because the ledger is APPEND-ONLY and `Arm` is stamped whenever the column is empty,
// and the arm is the same hash in every test. A thread that bought T2 at 11:01Z under the broken
// full-ladder behaviour, then bought T4 at 13:01Z once the test worked, carries BOTH lines and an
// Arm of B. Counted as an arm-B thread it would say arm B buys T2 -- the exact opposite of what B
// did -- and it would keep saying that forever. So a stamped thread belongs to a test only when
// all of its ladder spend falls inside that test's window. A thread that crosses a boundary is
// a straddler; one wholly before or after the window belongs to another test. All of them are
// held out and COUNTED. T0 lines are exempt: the RT Bridge fires T0 in both arms of every test,
// so a T0 on either side of a boundary is not evidence of anything.
// `a` says what arm A ran, because a test is BOTH arms: changing A's ladder under an unchanged Config
// row is a new test too.
//
// `unit` says WHICH THREADS a test compares, and it must follow the arms' entry tiers.
//   'fueled' — threads the ladder actually bought for (stamped with an Arm). Fair only while both arms
//              enter the ladder at the same tier: in the reduced ladder both bought T1 first.
//   'post'   — every thread published in the window, T0-only ones included, by the same hash. T1 off
//              needs this: arm A enters at T1 and arm B only at T2, so counting fueled threads would
//              compare A's T1-and-up against B's T2-and-up, and B's would look richer and dearer per
//              thread for no reason but the filter. On 2026-09-27, 163 of the 275 fleet threads since
//              the first test began had T0 alone, and 'fueled' drops every one of them.
export const SPLIT_TESTS = Object.freeze([
  // Operator, 2026-09-14: B = T0 + T1 + T4, with T4 buying at T3's bar (see routing.mjs).
  Object.freeze({ key: 'reduced-ladder', routes: 'B: T0, T1, T4@T3 · 50%', from: '2026-09-14T12:14:00Z',
    a: 'full ladder, T1 at 7,000 views + 3,500/h', unit: 'fueled' }),
  // Owner, 2026-09-27: "go t1 off to replace the arm a vs b test". B buys every tier but T1, each at
  // its own bar. The row was edited at about 06:59Z; run 55802, at 07:00:42Z, was the first to read it
  // (armTiers T0+T2+T3+T4+T5, and an arm-B post that earned T1 bought nothing). Arm A kept the old T1
  // bar for 38 minutes, so this first stretch is a test of its own.
  Object.freeze({ key: 't1-off-old-bar', routes: 'B: T0, T2, T3, T4, T5 · 50%', from: '2026-09-27T07:00:42Z',
    a: 'full ladder, T1 at 7,000 views + 3,500/h', unit: 'post' }),
  // Owner, the same day: "for whatever one with the t1 still on, let's raise the bar to 10k and 5k/hr
  // velocity". Arm A's T1 went to 10,000 views AND 5,000/h (its 7,000/h escape unchanged) when
  // bridge-deploy.mjs read the new Check Threshold back byte-exact at 07:38:58Z (version 580791a2).
  // No Fuel run was in flight; the first one on the new bar starts at 08:00:42Z.
  Object.freeze({ key: 't1-off', routes: 'B: T0, T2, T3, T4, T5 · 50%', from: '2026-09-27T07:38:58Z',
    a: 'full ladder, T1 at 10,000 views + 5,000/h', unit: 'post' }),
  // Owner, the same day: "Retire arm A." The row went to 100%, so every post runs arm B (no T1) and
  // nothing is compared from here on (`compare: false`). The write landed seconds after 09:49:28Z, the
  // last clock reading before it; run 10:00:42Z was the first Fuel run to read it. An arm-A post
  // published before the write and still climbing lost T1 when it landed, the one way this boundary
  // leaks, and t1-off had 2 posts per arm by then.
  Object.freeze({ key: 'a-retired', routes: 'B: T0, T2, T3, T4, T5 · 100%', from: '2026-09-27T09:49:30Z',
    a: 'retired: every post runs arm B', unit: 'post', compare: false }),
]);

/** The test the Config row runs now: the last one started. */
export const SPLIT_CURRENT = SPLIT_TESTS[SPLIT_TESTS.length - 1];
export const SPLIT_LIVE_FROM = SPLIT_CURRENT.from;
/** The last window that compared two arms. The readout's default once an arm is retired. */
export const SPLIT_LAST_COMPARED = [...SPLIT_TESTS].reverse().find((s) => s.compare !== false);

/** One test and its window: from its start to the next test's start, or open (`to` null) while it
 *  is the current one. Null for a key that names no test. */
export function splitWindow(key = SPLIT_CURRENT.key) {
  const i = SPLIT_TESTS.findIndex((s) => s.key === key);
  return i < 0 ? null : { ...SPLIT_TESTS[i], to: SPLIT_TESTS[i + 1]?.from || null };
}

/** Mean, sd and n of a numeric sample. */
export function moments(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd };
}

/** Welch's two-sample comparison of B against A: the difference of means with a 95% interval.
 *  `decidable` is the whole point — false while the interval still straddles zero, which at this
 *  volume it will for months. `nPerArm` is what 80% power at the OBSERVED gap would require. */
export function welch(a, b) {
  const A = moments(a), B = moments(b);
  const se = Math.sqrt((A.sd ** 2) / Math.max(1, A.n) + (B.sd ** 2) / Math.max(1, B.n));
  const diff = B.mean - A.mean;
  const lo = diff - 1.96 * se, hi = diff + 1.96 * se;
  const pooled = Math.sqrt(((A.sd ** 2) + (B.sd ** 2)) / 2);
  const nPerArm = diff !== 0 && pooled > 0 ? Math.ceil(2 * ((1.96 + 0.84) ** 2) * pooled ** 2 / diff ** 2) : null;
  // SUFFICIENT is not the same as DECIDABLE. With one observation in an arm its sd is 0, so the
  // standard error collapses to the other arm's alone and the interval comes out artificially
  // NARROW -- n=1 vs n=2 printed "+56.0%, CI -$0.62 to $14.03", which reads as almost significant
  // and is pure arithmetic artefact. Callers must not render diff/lo/hi unless this is true.
  const sufficient = A.n > 1 && B.n > 1;
  return {
    a: A, b: B, diff, se, lo, hi, sufficient,
    // Guard the ratio: an arm that has earned nothing yet must not report an infinite lift.
    pct: A.mean > 0 ? (diff / A.mean) * 100 : null,
    decidable: sufficient && se > 0 && (lo > 0 || hi < 0),
    nPerArm,
  };
}

/** Split fuel rows into arms. `armOf(statusId)` is the same pure hash the node uses, so a row that
 *  fired before the test can still be placed — that is what makes the placebo possible.
 *  A row is LIVE when it carries a stamped Arm (it actually fired under a test) and all of its ladder
 *  spend falls inside this test's window; PLACEBO when it carries no stamp. Mixing the two would let
 *  months of pre-test threads drown the real signal.
 *  `liveFrom`/`liveTo` are the window (see SPLIT_TESTS); `liveTo` null leaves it open. */
export function splitArms(rows, armOf, { tweetId = (r) => (String(r['X URL'] || '').match(/status\/(\d+)/) || [])[1], liveFrom = SPLIT_LIVE_FROM, liveTo = null } = {}) {
  const from = Date.parse(liveFrom), to = liveTo ? Date.parse(liveTo) : NaN;
  const out = { live: { A: [], B: [] }, placebo: { A: [], B: [] }, straddler: [], earlier: [], later: [] };
  for (const r of rows) {
    const id = tweetId(r);
    if (!id) continue;
    const stamped = String(r.Arm || '').trim().toUpperCase();
    const arm = stamped || armOf(id);
    if (arm !== 'A' && arm !== 'B') continue;
    if (!stamped) { out.placebo[arm].push(r); continue; }
    // A stamped row whose ladder spend crosses a boundary of the window is neither cohort: part of it
    // ran under one rule and part under another. One wholly outside the window ran under another
    // test. Every one of them is held out and COUNTED, never silently binned. T0 lines are exempt
    // while a ladder line dates the row; a row with none is dated by its T0 lines instead, or it
    // would sit in every test's window at once. (Build Log stamps Arm only on a ladder send, so on
    // 2026-09-27 none of the 116 stamped rows was T0-only; this keeps it that way if that changes.)
    const lines = parseTierBreakdown(r['Tier Breakdown']);
    const dated = (xs) => xs.map((e) => Date.parse(e.at)).filter(Number.isFinite);
    const ladder = dated(lines.filter((e) => !e.tiers.every((t) => t === 'T0')));
    const when = ladder.length ? ladder : dated(lines);
    const before = Number.isFinite(from) ? when.filter((x) => x < from).length : 0;
    const after = Number.isFinite(to) ? when.filter((x) => x >= to).length : 0;
    if (when.length && before === when.length) out.earlier.push(r);
    else if (when.length && after === when.length) out.later.push(r);
    else if (before || after) out.straddler.push(r);
    else out.live[arm].push(r);
  }
  return out;
}

/** One arm's totals. Commission counts only threads old enough to have earned (default 48h), while
 *  spend and reach count every fueled thread — spend is known the moment it is billed, commission
 *  is not, and averaging a fresh thread's zero into the mean is how an arm looks falsely bad. */
export function armTotals(rows, { now = Date.now(), matureH = 48, everyRow = false } = {}) {
  let spend = 0, reach = 0, threads = 0;
  const comm = [];
  for (const r of rows) {
    const s = Number(r['Total Spend']) || 0;
    // A fueled-thread unit counts billed threads only. The 'post' unit counts every published thread,
    // a T0 billed at $0 (a free network) included, or it would quietly drop threads by what they cost.
    if (!s && !everyRow) continue;
    threads += 1; spend += s; reach += Number(r.Reach) || 0;
    const fired = Date.parse(r['First Fired']);
    if (Number.isFinite(fired) && now - fired >= matureH * 3600e3) comm.push(Number(r['Lifetime Commission Rollup (from Post)']) || 0);
  }
  const m = moments(comm);
  return { threads, spend, reach, mature: m.n, comm: comm.reduce((s, x) => s + x, 0), meanComm: m.mean, sdComm: m.sd, samples: comm,
    perM: reach ? spend / (reach / 1e6) : null };
}

/** When an X post was published, read from its status id: a snowflake whose top bits are milliseconds
 *  since X's epoch. NaN for anything that is not one. */
export function statusTime(id) {
  try { const ms = Number((BigInt(String(id)) >> 22n) + 1288834974657n); return ms > 1288834974657 ? ms : NaN; } catch { return NaN; }
}

/** Split EVERY thread into arms, fueled or not: the 'post' unit (see SPLIT_TESTS). A thread belongs to
 *  the window it was PUBLISHED in: the time inside its X status id (statusTime), else its first ledger
 *  line (the Bridge's T0 at publish), else First Fired. What it bought afterwards is its outcome, never
 *  its placement. Placing it by its whole ledger would hold out an arm-A thread that bought T1 after a
 *  boundary while its arm-B twin, which cannot buy T1, stayed in: the selection bias this unit exists
 *  to remove. So there are
 *  no straddlers here; a thread published near a boundary carries a little of the next window, the
 *  same in both arms. PLACEBO is the history published before any test began (`pretestFrom`), split
 *  by the same hash: the noise floor, as in splitArms. A thread it cannot date is counted, never guessed. */
export function splitPosts(rows, armOf, { tweetId = (r) => (String(r['X URL'] || '').match(/status\/(\d+)/) || [])[1], liveFrom = SPLIT_LIVE_FROM, liveTo = null, pretestFrom = SPLIT_TESTS[0].from } = {}) {
  const from = Date.parse(liveFrom), to = liveTo ? Date.parse(liveTo) : NaN, pre = Date.parse(pretestFrom);
  const out = { live: { A: [], B: [] }, placebo: { A: [], B: [] }, straddler: [], earlier: [], later: [], undated: [] };
  for (const r of rows) {
    const id = tweetId(r);
    if (!id) continue;
    const arm = String(r.Arm || '').trim().toUpperCase() || armOf(id);
    if (arm !== 'A' && arm !== 'B') continue;
    const when = parseTierBreakdown(r['Tier Breakdown']).map((e) => Date.parse(e.at)).filter(Number.isFinite);
    // A pre-ledger row carries its one line undated; its First Fired still dates the thread.
    if (!when.length && Number.isFinite(Date.parse(r['First Fired']))) when.push(Date.parse(r['First Fired']));
    const published = Number.isFinite(statusTime(id)) ? statusTime(id) : when.length ? Math.min(...when) : NaN;
    if (!Number.isFinite(published)) { out.undated.push(r); continue; }
    if (Number.isFinite(pre) && published < pre) out.placebo[arm].push(r);
    else if (Number.isFinite(from) && published < from) out.earlier.push(r);
    else if (Number.isFinite(to) && published >= to) out.later.push(r);
    else out.live[arm].push(r);
  }
  return out;
}

/** The whole readout: both cohorts, both arms, and the verdict. `unit` 'post' splits every thread
 *  (splitPosts); anything else keeps the fueled-only split (splitArms). */
export function splitReadout(rows, armOf, opts = {}) {
  const arms = opts.unit === 'post' ? splitPosts(rows, armOf, opts) : splitArms(rows, armOf, opts);
  const totalsOpts = { ...opts, everyRow: opts.unit === 'post' };
  const cohort = (c) => {
    const A = armTotals(arms[c].A, totalsOpts), B = armTotals(arms[c].B, totalsOpts);
    return { A, B, test: welch(A.samples, B.samples) };
  };
  return { live: cohort('live'), placebo: cohort('placebo'), straddlers: arms.straddler.length,
    earlier: arms.earlier.length, later: arms.later.length, undated: (arms.undated || []).length };
}
