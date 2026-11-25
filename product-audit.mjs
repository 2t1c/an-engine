// product-audit.mjs — 🧪 bi-weekly product-curation audit. Keeps our KEEP_ASINS allowlist "top notch"
// by re-checking it against fresh sales, so a curated list can't quietly rot. Pulls our OWN realized
// Levanta sales over a window + the live catalog, then Telegrams one digest (performance topic):
//   - DROP    — curated products that went cold (little/no realized $ in the window)
//   - ADD     — non-curated products with real realized sales (proven earners we aren't stocking)
//   - GAPS    — topics with no curated product (coverage holes)
//   - BETS    — how the 80%-class high-commission bets (KEEP_BETS) actually convert vs the proven singles
// Read-only by default: it never edits the curated list — the operator does. With --propose it ALSO
// writes its DROP/ADD verdict into keep-asins.json (the curated list's data file), which the workflow
// turns into a one-click PR: merge = approval, edit-the-branch-first = partial approval. DENY and the
// bet designations stay operator-only either way. Runs on an Actions runner (Levanta is egress-blocked
// from the sandbox), on the 1st + 15th (~bi-weekly).
//   node product-audit.mjs            # send digest to the performance topic
//   node product-audit.mjs --dry      # console only
//   node product-audit.mjs --propose  # additionally write keep-asins.json (workflow opens the PR)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, levanta, telegram, esc, report, logRun, cliArg } from './lib.mjs';
import { KEEP_ASINS, KEEP_BETS, DENY_ASINS } from './checks.mjs';
import { topicsForProduct, TOPIC_KEYS } from './pick-product.mjs';
import { asinOfUrl } from './check-links.mjs';

const DRY = process.argv.includes('--dry');
const PROPOSE = process.argv.includes('--propose');
const arg = cliArg; // shared getter (lib.mjs, audit 2026-07-21 dedup)
const DAYS = Number(arg('days', '30'));
const COLD = Number(arg('cold', '15'));   // a curated product earning < $COLD over the window is "cold"
const ADD_MIN = Number(arg('addmin', '40')); // a non-curated product must earn >= $ADD_MIN to be an ADD candidate
const MINCLICKS = Number(arg('minclicks', '40')); // below this, a cold product is UNPROVEN (never promoted), not dead
// RECALIBRATED 2026-08-25: clicks are now REAL (deduped per date+link), where the old defaults were
// tuned against the ~6.4x-inflated column sum. MINCLICKS stays 40 — forty REAL clicks is a stricter
// exposure bar than forty restated ones, which errs toward UNPROVEN over DROP (the safe direction).
// The efficiency guard is re-based to real terms: the old 400-summed/$0.03 pair fired at roughly
// 60-250 real clicks and $0.06-0.19 per real click depending on a brand's echo rate; 150/$0.10 sits
// mid-range of the behavior it was tuned for (the 2026-08-07 post-mortem's own example, "$20 on
// 1,500 clicks", is ~235 real at $0.085). Tunable per run: --effclicks / --effepc.
const EFF_CLICKS = Number(arg('effclicks', '150'));
const EFF_EPC = Number(arg('effepc', '0.10'));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n) => `$${(n || 0).toFixed(0)}`;
const TOPICS = TOPIC_KEYS; // every taxonomy bucket (topics.json via pick-product) — no more hand-copied list to drift

/** The asin a Levanta link POINTS AT, from its raw Amazon URL. v1 report rows carry no
 *  link.product field — the /dp/ (or /gp/product/) path is the only place the linked product
 *  exists in a row. Delegates to check-links' asinOfUrl, the fleet's one URL→ASIN parser. */
export const linkedAsinOf = asinOfUrl;

/**
 * Two-key aggregation of v1 report rows. Pure; exported for test-scaffolds.
 *
 * The v1 report has two traps (documented in learn.mjs, and both were live here until 2026-08-25):
 *   1. CLICKS ARE LINK-LEVEL, RESTATED PER ASIN ROW. A row is (date, link, asin) and `clicks` is
 *      the click count for the LINK that day, repeated identically on every asin row the link's
 *      sessions produced. Summing the column multiplies real clicks by products-touched (6.37x
 *      measured), and — worse — parks phantom click totals on asins NO LINK POINTS AT: that is
 *      what manufactured the 2026-08-25 "variant-ASIN leak" (19,862 'clicks' on 20 never-linked
 *      asins, six creatine flavors 'earning $0' while the real creatine link earned $947).
 *   2. COMMISSION KEYS ON THE ASIN PURCHASED, not the asin linked. A product whose buyers grab a
 *      sibling in-session reads as clicks-at-$0 while its money sits under another asin (the same
 *      artifact once put the fleet's #3 earner on learn's drop list).
 *
 * So this returns BOTH views and callers must pick per question:
 *   linked: keyed by the asin the link points at. clicks deduped per (date, link) running max
 *           (same fix as learn.mjs #151 — an out-of-order page cannot double-count, a genuinely
 *           higher figure later in the day still lands). conversions/commission are everything the
 *           product's links earned, whatever was bought — the number a LINKING decision is about.
 *   bought: keyed by the asin purchased. commission/conversions only — clicks are meaningless
 *           under this key (they are the linked product's counts restated).
 */
export function aggregateReports(rows) {
  const linked = new Map();  // asin -> { clicks, conversions, commission, links:Set }
  const bought = new Map();  // asin -> { conversions, commission }
  const clicksByLinkDay = new Map();
  const linkAsin = new Map(); // link id -> linked asin (first parseable sighting wins; url is stable per link)
  for (const r of rows) {
    const id = r.link?.id;
    if (id && !linkAsin.has(id)) { const a = linkedAsinOf(r.link?.url); if (a) linkAsin.set(id, a); }
  }
  // A link whose URL never parses to an asin (storefront, search, re-pointed destination) cannot be
  // credited under the linked key — but its rows must not VANISH silently: the audit would read its
  // product as $0/0-clicks while it earns. Count the loss so main() can surface it (2026-08-25 review).
  const unparsed = { links: new Set(), rows: 0, clicks: 0 };
  for (const r of rows) {
    const conv = num(r.conversions), com = num(r.commissionEarned);
    const pa = r.asin || null;
    if (pa && (conv || com)) {
      const b = bought.get(pa) || { conversions: 0, commission: 0 };
      b.conversions += conv; b.commission += com; bought.set(pa, b);
    }
    const id = r.link?.id; if (!id) continue;
    const la = linkAsin.get(id);
    const dayKey = `${String(r.date || '').slice(0, 10)}|${id}`;
    const seen = clicksByLinkDay.get(dayKey) || 0;
    const rowClicks = num(r.clicks);
    if (!la) {
      unparsed.links.add(id); unparsed.rows++;
      if (rowClicks > seen) { unparsed.clicks += rowClicks - seen; clicksByLinkDay.set(dayKey, rowClicks); }
      continue;
    }
    const g = linked.get(la) || { clicks: 0, conversions: 0, commission: 0, links: new Set() };
    g.links.add(id);
    g.conversions += conv; g.commission += com;
    if (rowClicks > seen) { g.clicks += rowClicks - seen; clicksByLinkDay.set(dayKey, rowClicks); }
    linked.set(la, g);
  }
  return { linked, bought, unparsed: { links: unparsed.links.size, rows: unparsed.rows, clicks: unparsed.clicks } };
}

/**
 * The keep/drop verdict pipeline, pure so the 2026-08-25 blocker class stays testable. Rows are
 * perfOf-shaped ({asin, clicks, commission, boughtCommission, ...}, clicks REAL/deduped).
 *
 * Two arms nominate a DROP: cold (links earned < $COLD despite >= minClicks real exposure) and
 * efficiency (>= effClicks real clicks at < $effEpc per click — the 2026-08-07 reach-burner guard).
 *
 * The learn.mjs both-keys protection then spares nominees the audit can PROVE our audience wants:
 * boughtCommission − commission >= $COLD. Own-link purchases of the product can never exceed its
 * linked commission (they are a subset of it), so that difference is a floor on purchases arriving
 * through OTHER links — the B0DP3MT8YJ shape ($0 plugged, $425 bought) that once sat on a drop
 * list. Testing bought >= $COLD alone instead would hand the protection to the self-selling
 * reach-burner too (bought ≈ its own linked commission — the exact product the efficiency guard
 * exists for), making it undroppable and invisible; the 2026-08-25 adversarial review caught that
 * in this rewrite's first cut. Spared rows surface as `spared`, never silently: relink or drop is
 * the operator's call.
 */
export function auditVerdicts(keepPerf, { cold: COLD_ = 15, minClicks = 40, effClicks = 150, effEpc = 0.10 } = {}) {
  const epcOf = (r) => (r.clicks ? r.commission / r.clicks : 0);
  const cold = keepPerf.filter((r) => r.commission < COLD_);
  const inefficient = keepPerf.filter((r) => r.clicks >= effClicks && epcOf(r) < effEpc);
  const nominees = [...new Map([...cold.filter((r) => r.clicks >= minClicks), ...inefficient].map((r) => [r.asin, r])).values()];
  const sparedBy = (r) => r.boughtCommission - r.commission >= COLD_;
  const dead = nominees.filter((r) => !sparedBy(r)).sort((a, b) => b.clicks - a.clicks);
  const spared = nominees.filter(sparedBy).sort((a, b) => b.clicks - a.clicks);
  const unproven = cold.filter((r) => r.clicks < minClicks).sort((a, b) => b.clicks - a.clicks);
  return { dead, unproven, spared, epcOf };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY', ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const lev = levanta(env);

  // realized sales by ASIN over the window (Levanta caps 60-day spans → chunk + aggregate)
  async function realizedByAsin(days) {
    const iso = (d) => d.toISOString().slice(0, 10);
    const wins = []; let end = new Date(); let rem = days;
    while (rem > 0) { const span = Math.min(60, rem); const start = new Date(end.getTime() - span * 864e5); wins.push({ start: iso(start), end: iso(end) }); end = new Date(start.getTime() - 864e5); rem -= span; }
    const rows = [];
    for (const w of wins) {
      try { rows.push(...await lev.listReports(w)); } catch (e) { console.warn(`reports ${w.start}..${w.end}: ${e.message}`); }
    }
    return aggregateReports(rows);
  }
  // catalog index: asin -> {title, commission, epc, category} for naming + coverage classification
  async function catalogIndex() {
    const idx = new Map();
    for (const p of await lev.listAllProducts({ access: true })) {
      const a = p.primaryId || p.asin;
      if (a && !idx.has(a)) idx.set(a, { title: p.title || p.name || '', commission: num(p.commission?.totalCommission ?? p.commissionRate), epc: num(p.platformEpc), category: p.category || '' });
    }
    return idx;
  }

  const [{ linked, bought, unparsed }, cat] = [await realizedByAsin(DAYS), await catalogIndex()];
  const nameOf = (asin) => (cat.get(asin)?.title || asin).slice(0, 46);
  const pctC = (asin) => { const c = cat.get(asin)?.commission || 0; return c ? `${c <= 1 ? Math.round(c * 100) : Math.round(c)}%` : '?'; };
  const prodTopics = (asin) => { const c = cat.get(asin); return topicsForProduct(c ? `${c.title} ${c.category}` : ''); };

  // One row per asin, both keys side by side. `commission`/`conversions`/`clicks` are the LINKED
  // key (real clicks on links pointing at it; everything those links earned) — the basis of every
  // keep/drop decision, because that decision is about where to POINT links. `bought*` is what our
  // traffic purchased OF this asin regardless of which link it clicked.
  const perfOf = (asin) => {
    const l = linked.get(asin), b = bought.get(asin);
    return {
      asin,
      clicks: l?.clicks || 0, conversions: l?.conversions || 0, commission: l?.commission || 0,
      boughtCommission: b?.commission || 0, boughtConversions: b?.conversions || 0,
      neverLinked: !l,
    };
  };

  // Cold curated = its links earned < $COLD over the window. Split by exposure: a product with real
  // clicks that still didn't earn is genuinely DEAD (drop it); one with almost no clicks is UNPROVEN —
  // never promoted yet, so it needs content, not a drop. This is why a freshly-added product must
  // never read as "drop". The arm split (cold protected by the both-keys rule, efficiency not) and
  // the WHY live on auditVerdicts above.
  const keepPerf = [...KEEP_ASINS].map(perfOf);
  const { dead, unproven, spared, epcOf } = auditVerdicts(keepPerf, { cold: COLD, minClicks: MINCLICKS, effClicks: EFF_CLICKS, effEpc: EFF_EPC });
  // ADD: NOT curated, not denied, and PROVEN on either key — its links earned >= $ADD_MIN, or our
  // traffic bought >= $ADD_MIN of it through other links (that second kind is usually a size/flavor
  // variant of a curated product: buyers switching to it in-session is real demand, worth seeing —
  // but its row says so, instead of dressing echo clicks up as a CVR).
  const addAsins = [...new Set([...linked.keys(), ...bought.keys()])]
    .filter((a) => !KEEP_ASINS.has(a) && !DENY_ASINS.has(a))
    .map(perfOf)
    .filter((r) => Math.max(r.commission, r.boughtCommission) >= ADD_MIN);
  const adds = addAsins.sort((a, b) => Math.max(b.commission, b.boughtCommission) - Math.max(a.commission, a.boughtCommission)).slice(0, 12);
  // GAPS: topics with no curated product
  const covered = new Set([...KEEP_ASINS].flatMap(prodTopics));
  const gaps = TOPICS.filter((t) => !covered.has(t));
  // BETS: the 80%-class cohort, judged on realized earnings + CVR
  const bets = [...KEEP_BETS].map(perfOf).sort((a, b) => b.commission - a.commission);

  const totalKeep = keepPerf.reduce((s, r) => s + r.commission, 0);
  const cvr = (r) => (r.clicks ? `${((r.conversions / r.clicks) * 100).toFixed(1)}%` : '—');

  // `bought $N` rides along wherever the two keys tell different stories, so the operator sees WHY a
  // row was protected from (or surfaced for) a verdict without opening Levanta. A row with no link
  // rows in the window says exactly that — the report data alone cannot tell "never minted" from
  // "minted, no traffic", so the note must not claim either.
  const boughtNote = (r) => (r.neverLinked
    ? (r.boughtCommission > 0 ? ` · no link traffic in window — bought ${money(r.boughtCommission)} via other links' sessions` : ' · no link traffic in window')
    : (r.boughtCommission >= COLD ? ` · bought ${money(r.boughtCommission)}` : ''));
  const fmtRow = (r, extra = '') => `${money(r.commission)} · ${r.conversions} conv · ${cvr(r)} — ${esc(nameOf(r.asin))} (${pctC(r.asin)})${boughtNote(r)}${extra}`;
  const sections = [
    { label: `DROP CANDIDATES (curated: links earned <${money(COLD)}/${DAYS}d despite ≥${MINCLICKS} real clicks, OR ≥${EFF_CLICKS} real clicks at <$${EFF_EPC}/click — burning reach)`, body: dead.length ? dead.map((r) => `• ${fmtRow(r)} · ${r.clicks} clicks · EPC $${epcOf(r).toFixed(3)}`).join('\n') : 'none — no curated product is burning clicks without converting ✅' },
    ...(spared.length ? [{ label: `PROTECTED (drop nominee spared: our traffic provably buys ≥${money(COLD)} of it through OTHER links — relink or drop is the operator's call)`, body: spared.map((r) => `• ${fmtRow(r)} · ${r.clicks} clicks · EPC $${epcOf(r).toFixed(3)}`).join('\n') }] : []),
    { label: `UNPROVEN (curated, < ${MINCLICKS} real clicks — needs content, NOT a drop)`, body: unproven.length ? unproven.map((r) => `• ${fmtRow(r)}`).join('\n') : 'none — every curated product has had real exposure' },
    { label: `ADD CANDIDATES (proven, not curated, ≥ ${money(ADD_MIN)}/${DAYS}d on either key — no-link-traffic rows are usually size variants our buyers switch to)`, body: adds.length ? adds.map((r) => `• ${fmtRow(r)}`).join('\n') : 'none — no uncurated product is out-earning the list' },
    { label: 'COVERAGE GAPS', body: gaps.length ? `no curated product for: <b>${gaps.join(', ')}</b>` : 'all topics covered ✅' },
    { label: 'HIGH-COMMISSION BETS (80%-class)', body: bets.map((r) => `• ${fmtRow(r)}`).join('\n') },
  ];
  const unparsedNote = unparsed.links ? ` · ⚠ ${unparsed.links} link(s)/${unparsed.clicks} clicks on unparseable URLs (uncredited)` : '';
  const status = `${dead.length || gaps.length ? '⚠️' : '✅'} ${KEEP_ASINS.size} curated · <b>${money(totalKeep)}</b> realized/${DAYS}d · ${dead.length} drop · ${unproven.length} unproven · ${adds.length} add · ${gaps.length} gap${unparsedNote}`;
  const msg = report({
    emoji: '🧪', title: 'Product curation audit', scope: `last ${DAYS}d`, status, sections,
    action: dead.length || adds.length
      ? (PROPOSE ? 'A keep-asins.json proposal PR is opening — merge to approve, or edit the branch first.' : 'Review keep-asins.json — drop the dead, add the proven; unproven items just need content.')
      : (gaps.length ? 'Fill the coverage gap in keep-asins.json; no drops needed.' : 'Curated list is healthy — promote the unproven, no drops needed.'),
  });
  console.log(msg.replace(/<[^>]+>/g, ''));

  // --propose (curation-as-PR, 2026-07-21): write the DROP/ADD verdict into keep-asins.json so the
  // workflow can open a data-only PR the operator approves by merging. Only the keep list moves:
  // DEAD entries (real clicks, no earnings on either key) come out; proven ADD candidates go in,
  // stamped with the audit date + realized numbers so the diff explains itself. UNPROVEN entries are
  // untouched (they need content, not a drop); DENY and existing bet designations stay operator-only.
  // A ≥60%-commission add is marked bet:true so the audit keeps judging it in the bets cohort, not on
  // blended CVR.
  // --dry gates this too. It did not, so `--dry --propose` rewrote curated data while claiming
  // to be console-only — the one combination an operator reaches for to preview a proposal.
  if (PROPOSE && !DRY && (dead.length || adds.length)) {
    const file = new URL('./keep-asins.json', import.meta.url);
    const policy = JSON.parse(readFileSync(file, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    const dropSet = new Set(dead.map((r) => r.asin));
    const kept = policy.keep.filter((k) => !dropSet.has(k.asin));
    const dropped = policy.keep.length - kept.length;
    policy.keep = kept;
    let added = 0;
    for (const r of adds) {
      if (policy.keep.some((k) => k.asin === r.asin)) continue;
      const c = cat.get(r.asin);
      const pctNum = c ? (c.commission <= 1 ? c.commission * 100 : c.commission) : 0;
      policy.keep.push({
        asin: r.asin, topic: prodTopics(r.asin)[0] || '',
        ...(pctNum >= 60 ? { bet: true } : {}),
        note: `AUDIT ADD ${today}: ${r.neverLinked
          ? `no link traffic — ${money(r.boughtCommission)}/${DAYS}d bought via other links' sessions (${r.boughtConversions} conv)`
          : `${money(r.commission)}/${DAYS}d · ${r.conversions} conv · ${cvr(r)} CVR`} · ${nameOf(r.asin)}`,
      });
      added++;
    }
    policy.meta = { ...(policy.meta || {}), updated: today };
    writeFileSync(file, JSON.stringify(policy, null, 1) + '\n');
    console.log(`\n--propose: keep-asins.json updated (${dropped} dropped, ${added} added) — the workflow opens the PR if the file changed`);
  }

  if (PROPOSE && DRY) console.log('\n--propose skipped: --dry is set, and --dry writes nothing. Re-run without --dry to update keep-asins.json.');
  logRun('product-audit', { days: DAYS, curated: KEEP_ASINS.size, totalKeep, dead: dead.length, unproven: unproven.length, adds: adds.length, gaps, propose: PROPOSE, spared: spared.length, unparsedLinks: unparsed.links });
  if (!DRY) { await telegram(env, msg, 'performance'); console.log('\n✓ sent to performance topic'); }
}

// Only run when INVOKED, never when imported (same guard + reason as learn.mjs): importing this
// module to reach aggregateReports/auditVerdicts — from test-scaffolds, or any other script — must
// not fire a live two-catalog Levanta pull, a Telegram send, or a keep-asins.json rewrite.
// pathToFileURL, not string concat: a checkout path with a space would percent-encode in
// import.meta.url and silently no-op the whole audit under the concat form.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
