// learn.mjs — the data feedback loop. Harvests OUR threads' real outcomes (Levanta revenue per thread),
// joins them to the recreation ledger (which product + topic each thread used), and LEARNS, with
// TIME DECAY (recent threads weighted higher) + EXPLORE/EXPLOIT (only "exploit" a winner once it has
// enough real conversions), which product converts best PER TOPIC. Emits:
//   - learnings/product-topic.json   machine map -> pick-product.mjs biases selection toward proven converters
//   - a human report (console + Telegram 'ops')   high-leverage: which topics earn, what to route, what to drop
//   node learn.mjs              # 90-day window -> report + json + Telegram
//   node learn.mjs --dry        # preview only (no file write, no Telegram)
//   node learn.mjs --days 120 --halflife 21 --min-conv 3
// Env: LEVANTA_API_KEY, AIRTABLE_PAT, XDB_BASE_ID (+ Telegram via Airtable Config).
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, levanta, airtable, telegram, esc, logRun, report, HERE_DIR, lvIdOf } from './lib.mjs';
import { classifyTopic } from './pick-product.mjs';
import { createResolver } from './stamps.mjs';
import { isStack, DENY_ASINS } from './checks.mjs'; // never route back to a banned stack, even if it earned pre-singles-switch
import { TABLES } from './config.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const WINDOW = parseInt(flag('days', '90'), 10);
const HALFLIFE = parseInt(flag('halflife', '30'), 10); // days — a thread's weight halves every HALFLIFE (recency)
const MIN_CONV = parseInt(flag('min-conv', '2'), 10);  // explore/exploit gate: a topic route is "confident" only at >= this many REAL conversions
// ...and only on enough traffic for the rate to mean anything. 5 conversions on 15 clicks is a 33%
// CVR and tops the ranking, but fifteen clicks is not a measurement — one more or fewer sale moves
// it by seven points. Below this a route stays in EXPLORE and keeps gathering evidence instead of
// capturing a whole topic. The bound is on RAW clicks, not decayed ones.
const MIN_CLICKS = parseInt(flag('min-clicks', '50'), 10);
const DEAD_CLICKS = 25;                                 // a product with >= this many clicks and $0 = drop candidate
const isoDay = (d) => d.toISOString().slice(0, 10);
const money = (n) => `$${n.toFixed(2)}`;

/**
 * Wilson score lower bound on a proportion.
 *
 * Ranking on the point estimate lets a lucky pair of conversions beat a proven route: 2 conv on 13
 * clicks is a 15% CVR and outranks 66 conv on 5,000 at 1.3%, which is nonsense. The lower bound
 * asks "what is this rate at worst", so thin evidence is penalised for being thin rather than
 * trusted for being flattering. Wilson rather than the normal approximation because it stays inside
 * [0,1] and behaves at small n and p near 0 — which is exactly where these routes live.
 */
export function wilsonLower(successes, n, z = 1.96) {
  if (!(n > 0)) return 0;
  const p = successes / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** Pseudo-conversions of prior weight when estimating what a conversion is worth. */
export const VALUE_PRIOR_N = 3;

/**
 * Lower-confidence-bound EPC — the number to rank a route on.
 *
 * Two quantities, two treatments. Conversion rate is a proportion, so Wilson bounds it from below on
 * the RAW click count. Commission per conversion is a size with no such bound, and at two
 * conversions it is wild — one $36 order reads as $18/conversion and beats a route averaging $4.67
 * over sixty-six. So it is shrunk toward the fleet mean by VALUE_PRIOR_N pseudo-conversions: thin
 * evidence is pulled to the average, and a product only keeps a high per-order value by proving it.
 *
 * Multiplying the two gives a pessimistic $/click. A route rises by accumulating evidence rather
 * than by getting lucky once, which is the whole point — the previous ranking on raw commission
 * ranked by how much traffic the picker happened to send last month.
 */
export function lcbEpc({ rawConv, rawClicks, rawCommission, meanPerConv = 0 }) {
  const n = Math.max(1, Math.round(rawClicks));
  const perConv =
    (rawCommission + VALUE_PRIOR_N * meanPerConv) / (rawConv + VALUE_PRIOR_N);
  return wilsonLower(rawConv, n) * perConv;
}

/**
 * The ledger rows learn() joins: the latest row per subid1, minus light-plug mint duplicates.
 *
 * A light plug is minted on its own subid ("…-b"), which appends a `mode: 'mint'` row carrying the
 * link, and then ships as link2 on the thread's row. Both rows survive the per-subid1 dedup, so
 * the same Levanta link's full window of clicks, conversions and commission was counted twice —
 * once under the thread's topic, once under the mint row's (usually 'general'). A mint row whose
 * link is already carried as link2 by a non-mint row is dropped; the thread row is the one with
 * topic and account. Every other row is kept exactly as before.
 */
export function learnLedgerRows(text) {
  const m = new Map();
  for (const l of String(text || '').split('\n').filter(Boolean)) { try { const e = JSON.parse(l); if (e.subid1) m.set(e.subid1, e); } catch {} }
  const rows = [...m.values()];
  const link2Ids = new Set();
  for (const e of rows) if (e.mode !== 'mint' && /lv_/.test(e.link2 || '')) { const id = lvIdOf(e.link2); if (id) link2Ids.add(id); }
  return rows.filter((e) => !(e.mode === 'mint' && /lv_/.test(e.link || '') && link2Ids.has(lvIdOf(e.link))));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY', 'AIRTABLE_PAT', 'XDB_BASE_ID']);
  const at = airtable(env);
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const fullTitle = new Map(products.map((p) => [p.asin, `${p.title} ${p.category || ''}`])); // ledger titles can be truncated; gate on the full title
  const since = isoDay(new Date(Date.now() - WINDOW * 864e5)), until = isoDay(new Date());
  const now = Date.now();
  const decay = (ts) => Math.pow(0.5, Math.max(0, (now - new Date(ts).getTime()) / 864e5) / HALFLIFE);

  // ledger: subid1 -> generation metadata (latest per subid1), light-plug mint duplicates dropped
  const ledger = (() => { const f = join(HERE_DIR, 'ledger.jsonl');
    return learnLedgerRows(existsSync(f) ? readFileSync(f, 'utf8') : '');
  })();

  // Levanta: daily performance per link, summed per link id over the window (same join as revenue.mjs).
  //
  // CLICKS ARE LINK-LEVEL, REPEATED PER ASIN ROW. A row is (date, link, asin) and `clicks` is the
  // click count for the LINK that day, restated identically on every asin row it produced. Summing
  // the column multiplies it by the number of products bought through that link — 110,629 against
  // 17,380 real over 90 days, 6.37x. Conversions and commission ARE per-row and do sum.
  //
  // Take the running max per (date, link) and add only the increment, so out-of-order pages cannot
  // double-count and a genuinely higher figure later in the day still lands. Same fix as #151.
  const reports = await levanta(env).listReports({ start: since, end: until });
  const byLink = new Map();
  const clicksByLinkDay = new Map();
  for (const r of reports) { const id = r.link?.id; if (!id) continue;
    const g = byLink.get(id) || { clicks: 0, conv: 0, commission: 0 };
    g.conv += Number(r.conversions) || 0; g.commission += Number(r.commissionEarned) || 0;
    const dayKey = `${String(r.date || '').slice(0, 10)}|${id}`;
    const seen = clicksByLinkDay.get(dayKey) || 0;
    const rowClicks = Number(r.clicks) || 0;
    if (rowClicks > seen) { g.clicks += rowClicks - seen; clicksByLinkDay.set(dayKey, rowClicks); }
    byLink.set(id, g);
  }

  // WHAT WAS ACTUALLY BOUGHT, by asin.
  //
  // Levanta keys revenue on the asin PURCHASED; the ledger keys a thread on the asin PLUGGED. Amazon
  // pays on anything in the session, so those routinely differ — and a product that converts when
  // someone arrives via a different product's link earns nothing under the plugged key. That is not
  // hypothetical: B0DP3MT8YJ is the fleet's third-highest earning asin at $425.18 across 10
  // conversions, and the plugged-key aggregate had it at $0 and on the drop list.
  const boughtByAsin = new Map();
  for (const r of reports) { const a = r.asin; if (!a) continue;
    const g = boughtByAsin.get(a) || { conv: 0, commission: 0 };
    g.conv += Number(r.conversions) || 0; g.commission += Number(r.commissionEarned) || 0;
    boughtByAsin.set(a, g);
  }

  // topic per thread (plan v7 N3 consumer switch): Jev's back-stamp through the one resolver when one
  // clears its floor (stamps.mjs), else ledger.topic (new threads), else classify the source hook (cached fetch).
  const hookTopic = new Map();
  const stamps = createResolver();
  const topicOf = async (e) => {
    const stamped = e.draftId ? stamps.resolve('topic', e.draftId) : null;
    if (stamped?.source === 'stamp') return stamped.value;
    if (e.topic) return e.topic;
    if (!e.recId) return 'general';
    if (!hookTopic.has(e.recId)) { let hook = '';
      try { const rec = await at.getRecord(TABLES.swipe, e.recId); hook = (rec.fields.Text || '').split('\n')[0]; } catch {}
      hookTopic.set(e.recId, classifyTopic(hook));
    }
    return hookTopic.get(e.recId);
  };

  // join + aggregate
  const cell = new Map();     // `${topic}|${asin}` -> decayed {clicks,conv,commission} + rawConv
  const topicAgg = new Map(); // topic -> decayed commission + raw conv + threads
  const prodAgg = new Map();  // asin -> RAW {clicks,conv,commission,product} (for dead-product detection)
  const earners = [];
  let joined = 0;
  for (const e of ledger) {
    const w = decay(e.ts || until), topic = await topicOf(e);
    // A thread can carry a SECOND product (link2/asin2) — learn from BOTH so product-2 converters
    // aren't invisible. Sum each product's signal; count the thread once toward topicAgg.threads.
    let threadCounted = false;
    const prods = [[e.link, e.asin, e.product], ...(e.link2 ? [[e.link2, e.asin2, e.product2]] : [])];
    for (const [link, asinRaw, product] of prods) {
      if (!/lv_/.test(link || '')) continue;                 // Levanta-tracked only (MVP)
      const m = byLink.get(lvIdOf(link));
      if (!m || (m.clicks + m.conv + m.commission) === 0) continue; // no signal in window
      joined++;
      const asin = asinRaw || '?';
      const k = `${topic}|${asin}`;
      const c = cell.get(k) || { clicks: 0, conv: 0, commission: 0, rawConv: 0, rawClicks: 0, rawCommission: 0, product: product || asin };
      c.clicks += m.clicks * w; c.conv += m.conv * w; c.commission += m.commission * w;
      // RAW counts alongside the decayed ones. Decay expresses "how much do I care about this
      // evidence"; sample size expresses "how much evidence is there". Feeding a decayed denominator
      // into a confidence bound conflates them and inflates every rate by 1/decay — a three-month-old
      // route with 2 conversions on 500 clicks reads as 2 on 60.
      c.rawConv += m.conv; c.rawClicks += m.clicks; c.rawCommission += m.commission;
      cell.set(k, c);
      const ta = topicAgg.get(topic) || { commission: 0, conv: 0, threads: 0 }; ta.commission += m.commission * w; ta.conv += m.conv; if (!threadCounted) { ta.threads++; threadCounted = true; } topicAgg.set(topic, ta);
      const pa = prodAgg.get(asin) || { clicks: 0, conv: 0, commission: 0, product: product || asin }; pa.clicks += m.clicks; pa.conv += m.conv; pa.commission += m.commission; prodAgg.set(asin, pa);
      if (m.commission > 0) earners.push({ topic, account: e.account, product: product || asin, commission: m.commission, conv: m.conv, url: e.sourceUrl });
    }
  }

  // LEARN: best product per topic, gated by real conversions (exploit) vs. keep exploring.
  // The fleet's mean commission per conversion is the prior a thin route's value is shrunk toward.
  const totConv = [...cell.values()].reduce((s2, c) => s2 + c.rawConv, 0);
  const totCom = [...cell.values()].reduce((s2, c) => s2 + c.rawCommission, 0);
  const meanPerConv = totConv > 0 ? totCom / totConv : 0;
  const learned = {}; const routes = [], explore = [];
  for (const t of [...new Set([...cell.keys()].map((k) => k.split('|')[0]))]) {
    const cands = [...cell.entries()].filter(([k]) => k.startsWith(t + '|')).map(([k, v]) => ({ asin: k.split('|')[1], ...v }))
      .filter((c) => !DENY_ASINS.has(c.asin) && !isStack(fullTitle.get(c.asin) || c.product)) // SINGLES ONLY (gate on FULL title; exclude banned/stack even if it earned pre-switch)
      .map((c) => ({ ...c, lcb: lcbEpc({ ...c, meanPerConv }) }))
      // Rank on the LOWER BOUND, not raw commission. Raw commission ranks by how much traffic a
      // product happened to receive, which is mostly a record of what the picker chose last month.
      .sort((a, b) => b.lcb - a.lcb || b.commission - a.commission);
    if (!cands.length) continue;
    // Choose the best route that is ACTUALLY EXPLOITABLE, then fall back to the best of anything.
    //
    // Taking cands[0] and testing it afterwards loses routes: a thin candidate with a flattering
    // rate can outrank a proven one, fail the gate, and send the whole topic to EXPLORE — throwing
    // away a route that was ready. The eligibility test belongs in the selection, not after it.
    const eligible = cands.filter((c) => c.rawConv >= MIN_CONV && c.rawClicks >= MIN_CLICKS && c.lcb > 0);
    const top = eligible[0] ?? cands[0];
    const confident = eligible.length > 0;
    learned[t] = { asin: top.asin, product: top.product, commission: +top.commission.toFixed(2), conversions: +top.conv.toFixed(1), rawConv: top.rawConv, clicks: Math.round(top.clicks), rawClicks: Math.round(top.rawClicks), epc: top.clicks ? +(top.commission / top.clicks).toFixed(2) : null, lcbEpc: +top.lcb.toFixed(4), confident, updated: until };
    (confident ? routes : explore).push({ t, ...learned[t] });
  }
  // A product is only a drop candidate when it has real traffic AND earns nothing on EITHER key:
  // nothing through the links it was plugged on, and nothing when someone bought it having arrived
  // some other way. Checking only the plugged key put the fleet's third-best earner on this list.
  const dead = [...prodAgg.entries()]
    .map(([asin, v]) => ({ asin, ...v, bought: boughtByAsin.get(asin) || { conv: 0, commission: 0 } }))
    .filter((v) => v.clicks >= DEAD_CLICKS && v.commission <= 0 && v.bought.commission <= 0)
    .sort((a, b) => b.clicks - a.clicks);

  if (!DRY) {
    const dir = join(HERE_DIR, 'learnings'); if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'product-topic.json'), JSON.stringify(learned, null, 2));
    // REALIZED per-ASIN performance (audit 2026-07-21 fix: prodAgg was computed for the dead-product
    // report and then discarded — the picker kept ranking on the STATIC catalog epc, null on 107/341
    // products, plus a guessed 2% CVR). This file gives pick-product real $/click and CVR per ASIN
    // across all topics; valueOf() prefers it once a product has enough clicks to be meaningful.
    const perf = {};
    for (const [asin, v] of prodAgg) perf[asin] = { clicks: v.clicks, conv: v.conv, commission: +v.commission.toFixed(2), epc: v.clicks ? +(v.commission / v.clicks).toFixed(3) : null, cvr: v.clicks ? +(v.conv / v.clicks).toFixed(4) : null, product: (v.product || asin).slice(0, 80), updated: until };
    writeFileSync(join(dir, 'product-perf.json'), JSON.stringify(perf, null, 1));
  }

  // REPORT (high-leverage, scannable)
  const topicRank = [...topicAgg.entries()].sort((a, b) => b[1].commission - a[1].commission);
  const totalDecayed = topicRank.reduce((s, [, v]) => s + v.commission, 0);
  const sections = [
    { label: 'TOP TOPICS', body: (topicRank.length ? topicRank.slice(0, 8).map(([t, v], i) => `  ${i + 1}. ${t} — ${money(v.commission)} · ${v.conv} conv · ${v.threads} thread(s)`) : ['  <i>no revenue-attributed threads in window yet</i>']).join('\n') },
    { label: 'EXPLOIT ROUTES', body: (routes.length ? routes.sort((a, b) => b.lcbEpc - a.lcbEpc).map((r) => `  ${r.t} → ${esc(r.product.split(',')[0].slice(0, 30))} <code>${r.asin}</code> · ${r.rawConv} conv / ${r.rawClicks} clicks · ${money(r.commission)} · ${money(r.lcbEpc)} LCB`) : ['  <i>none confident yet (need ≥' + MIN_CONV + ' conversions on ≥' + MIN_CLICKS + ' clicks)</i>']).join('\n') },
    { label: 'EXPLORE', body: (explore.length ? [`  ${explore.map((e) => e.t).join(', ')}`] : ['  <i>—</i>']).join('\n') },
  ];
  if (dead.length) sections.push({ label: 'DROP CANDIDATES', body: dead.slice(0, 5).map((d) => `  ${esc(d.product.split(',')[0].slice(0, 30))} <code>${d.asin}</code> — ${d.clicks} clicks, $0 plugged and $0 bought`).join('\n') });
  if (earners.length) sections.push({ label: 'TOP EARNERS', body: earners.sort((a, b) => b.commission - a.commission).slice(0, 5).map((w) => `  ${money(w.commission)} · ${esc(w.account)} · ${w.topic}${w.url ? ` · <a href="${w.url}">src</a>` : ''}`).join('\n') });

  const out = report({
    emoji: '🧠',
    title: 'Learn — content feedback loop',
    scope: `${since} → ${until} · ${HALFLIFE}d half-life`,
    status: `${joined ? '✅' : 'ℹ️'} joined <b>${joined}</b>/${ledger.length} tracked thread(s) · ${money(totalDecayed)} (recency-weighted)`,
    sections,
    action: 'Picker auto-biased to the top routes — make more of the leaders.',
  });
  console.log(out.replace(/<[^>]+>/g, ''));
  logRun('learn', { window: WINDOW, halflife: HALFLIFE, joined, threads: ledger.length, totalDecayed: +totalDecayed.toFixed(2), confidentRoutes: routes.length, exploreTopics: explore.length, dead: dead.length });
  if (!DRY) { await telegram(env, out, 'ops'); console.log('\n✓ Sent to Telegram (ops) + wrote learnings/product-topic.json'); }
}
// Only run when INVOKED, never when imported. Without this guard, importing the module to reach
// wilsonLower/lcbEpc — from a test, or from any other script — silently executes the whole task:
// a live Levanta harvest, a Telegram send to ops, and an overwrite of the learnings the picker
// reads. A pure function should be reachable without firing the job that happens to live beside it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
