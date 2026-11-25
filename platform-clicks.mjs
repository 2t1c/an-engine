// platform-clicks.mjs — READ-ONLY: split affiliate clicks by the PLATFORM that produced them.
//
// The write half of per-platform tracking has existed since 2026-08-21 (platforms.mjs' subid
// convention) and has been minting real links since 2026-08-28 (cross-post-links.mjs): a Threads
// link's subid is the X subid plus "-th", so Levanta — which reports on subids and never on
// referrers — can separate the two feeds on its own.
//
// Nothing ever read it back. `PLATFORM_SUBID_SUFFIX` was imported by exactly two files, the minter
// and its tests, and by no report at all. That gap is not cosmetic: a cross-post row carries the
// parent's draftId, so parseLedger files its "-th" link under the parent draft and every consumer
// downstream — registry-sync's Lifetime Clicks, revenue.mjs, levanta-stats, diagnose-clicks — adds
// Threads clicks straight into the thread's X total with no platform dimension anywhere. The split
// would have arrived, been silently summed back together, and reproduced the exact blindness it was
// built to end: "how many clicks came from Threads" had no answer on 2026-08-27, and without a
// reader it would still have had none once the data landed.
//
// So: this is the reader. It joins Levanta's per-link clicks to the ledger row that MINTED each
// link, takes the platform from that row, and reports the split.
//
// TWO THINGS IT IS CAREFUL ABOUT, because both have burned this codebase before:
//   1. Clicks are deduped per (date, link) via lib's aggregateLevReports. Raw v1 rows restate the
//      LINK-level click figure on every halo-ASIN row; summing them inflated one 31-day read 5.1x.
//   2. Zero is reported as zero, never as absence. A platform with links minted and no clicks yet
//      is a different fact from a platform with no links at all, and the operator needs to tell
//      them apart — otherwise "no Threads data" reads as "the split is broken" when it is simply
//      early. Coverage is printed next to the numbers for exactly that reason.
//
// Read-only: writes nothing. Needs LEVANTA_API_KEY; platform-clicks.yml runs it on a runner.
//   node platform-clicks.mjs --days 14
//   node platform-clicks.mjs --days 30 --account Julian
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, levanta, cliArg, lvIdOf, aggregateLevReports, HERE_DIR } from './lib.mjs';

// X carries no suffix, so it needs a name of its own to be groupable alongside the others.
export const X = 'x';

/** The platform a ledger row minted its link for. Cross-post rows stamp it; everything else is X.
 *  Pure. The `platform` field is authoritative over the subid suffix: a hand-edited subid that
 *  happens to end in "-th" is not evidence a Threads link was minted, and guessing from the string
 *  would quietly invent a split that the mint never made. */
export const platformOfRow = (row) => (row && typeof row.platform === 'string' && row.platform) || X;

/** Did the row SAY a platform, or is X only the default? A row carrying no `platform` key at all is
 *  silent on the question — it is not the same fact as a row that states `x`, and conflating the two
 *  is what filed 448 Threads links under X. Pure. */
export const statesPlatform = (row) => !!(row && typeof row.platform === 'string' && row.platform);

/**
 * Index every lv_ link the ledger has ever minted -> the platform, account and draft behind it.
 * Reads RAW rows rather than parseLedger's merged byDraft view, because a cross-post row is
 * `attributionOnly` and deliberately never becomes a draft's merged entry — the merged view is the
 * one place this information is guaranteed absent.
 * Pure over the text. Returns Map<lvId, {platform, account, draftId, subid1}>.
 */
export function indexLinksByPlatform(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const platform = platformOfRow(e);
    for (const l of [e.link, e.link2]) {
      const id = lvIdOf(l);
      if (!id) continue;
      // FIRST MINT WINS — for PLATFORM, but only among rows that actually STATE one. A later repair
      // row can re-state a link it did not mint (link-sentinel rewrites, re-mints); last-write-wins
      // would let an X repair row reassign a Threads link to X and collapse the split back into one
      // column, which is the failure this whole file exists to prevent.
      //
      // "States one" is the load-bearing part (2026-09-17). The mint-batch workflow writes a bare
      // `mode:"mint"` row with NO `platform` key, and that row is the one that introduces the link.
      // platformOfRow defaults a silent row to X, so first-mint-wins was locking in a DEFAULT and
      // calling it a mint: 448 links whose only real platform evidence was the `platform:"threads"`
      // cross-post row one line below, filed under X, carrying 415 clicks by the time it was caught.
      //
      // A row with no `platform` key is silent, not an X vote. It seeds the entry so account and
      // draftId still land, but it does not settle the platform — the first row that SAYS one does.
      // The guarantee survives intact because it never rested on silence: 32 rows carry an explicit
      // `platform:"x"`, and an explicit X row that lands first still wins, exactly as before.
      if (!out.has(id)) {
        out.set(id, { platform, platformStated: statesPlatform(e), account: e.account || null, draftId: e.draftId != null ? String(e.draftId) : null, subid1: e.subid1 || null });
        continue;
      }
      const prior = out.get(id);
      if (!prior.platformStated && statesPlatform(e)) { prior.platform = platformOfRow(e); prior.platformStated = true; }

      // ...BUT ACCOUNT IS A DIFFERENT FACT WITH A DIFFERENT RULE (2026-09-16).
      // The mint-batch workflow writes a bare row — {ts, mode, asin, subid1, link, note} — with no
      // `account` at all, and that row is the one that introduces the link. Applying first-mint-wins
      // to the account too pinned 490 links to `account: null` forever, and splitByPlatform buckets
      // an account-less link as "unclaimed": 40,818 clicks and $19,085 of real X revenue belonging
      // to real accounts, filed under nobody — MORE than the $16,818 that reached a named account.
      //
      // Every one of those 490 has a later row that does carry the account, so nothing here is
      // guesswork or inference: it is the same ledger, one row further down. Only fields the first
      // row LEFT EMPTY are filled, so a later row can never overwrite a value the mint already set —
      // which is what keeps the platform guarantee above intact.
      //
      // Deliberately NOT read from the subid, even though these subids embed the account name
      // ("x-thread-<page>-…"). A hand-edited subid is not evidence of ownership, for the same reason
      // platformOfRow refuses to infer a platform from a "-th" suffix.
      const cur = out.get(id);
      if (!cur.account && e.account) cur.account = e.account;
      if (!cur.draftId && e.draftId != null) cur.draftId = String(e.draftId);
      if (!cur.subid1 && e.subid1) cur.subid1 = e.subid1;
    }
  }
  return out;
}

/**
 * Fold Levanta's per-link totals into per-(account, platform) buckets.
 * `byLink` is aggregateLevReports' Map<lvId, {clicks, commission, orders, sales}>.
 * Links the ledger cannot claim are bucketed under `unclaimed` rather than dropped or guessed at.
 * Pure.
 */
export function splitByPlatform(byLink, index, { account = null } = {}) {
  const rows = new Map();          // `${account}\0${platform}` -> totals
  const unclaimed = { clicks: 0, commission: 0, links: 0 };
  const add = (acct, platform, g) => {
    const k = `${acct}\0${platform}`;
    const b = rows.get(k) || { account: acct, platform, clicks: 0, commission: 0, orders: 0, links: 0 };
    b.clicks += g.clicks || 0; b.commission += g.commission || 0; b.orders += g.orders || 0; b.links++;
    rows.set(k, b);
  };
  for (const [id, g] of byLink) {
    const meta = index.get(id);
    if (!meta || !meta.account) { unclaimed.clicks += g.clicks || 0; unclaimed.commission += g.commission || 0; unclaimed.links++; continue; }
    if (account && meta.account !== account) continue;
    add(meta.account, meta.platform, g);
  }
  return { rows: [...rows.values()], unclaimed };
}

/**
 * What the split CAN see, independent of whether it has seen anything yet: how many links exist per
 * platform and how many of them Levanta has reported on. This is what separates "no clicks yet"
 * from "no links minted" — the distinction the operator actually needs. Pure.
 */
export function coverage(index, byLink, { account = null } = {}) {
  const out = new Map();
  for (const [id, m] of index) {
    if (!m.account) continue;
    if (account && m.account !== account) continue;
    const b = out.get(m.platform) || { platform: m.platform, minted: 0, reported: 0, drafts: new Set() };
    b.minted++;
    if (byLink.has(id)) b.reported++;
    if (m.draftId) b.drafts.add(m.draftId);
    out.set(m.platform, b);
  }
  return [...out.values()].map((b) => ({ ...b, drafts: b.drafts.size }));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['LEVANTA_API_KEY']);
  const DAYS = Math.min(60, Number(cliArg('days', '14')));   // v1 caps a window at 60d
  const ONLY = cliArg('account', null);
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const start = isoDay(new Date(Date.now() - DAYS * 864e5));
  const end = isoDay(new Date());
  const money = (n) => `$${(n || 0).toFixed(2)}`;

  const f = join(HERE_DIR, 'ledger.jsonl');
  const index = indexLinksByPlatform(existsSync(f) ? readFileSync(f, 'utf8') : '');
  const { byLink } = aggregateLevReports(await levanta(env).listReports({ start, end }));
  const { rows, unclaimed } = splitByPlatform(byLink, index, { account: ONLY });
  const cov = coverage(index, byLink, { account: ONLY });

  console.log(`\n=== PLATFORM CLICK SPLIT · last ${DAYS}d (${start} → ${end})${ONLY ? ` · ${ONLY}` : ''} ===`);

  // Coverage first. A reader who sees "threads 0 clicks" with no context cannot tell whether the
  // split is broken, unbuilt, or simply young, and will reach for the wrong tool every time.
  console.log(`\ncoverage — links the ledger has minted per platform:`);
  for (const c of cov.sort((a, b) => b.minted - a.minted)) {
    console.log(`  ${c.platform.padEnd(10)} ${String(c.minted).padStart(5)} link(s) across ${String(c.drafts).padStart(4)} draft(s) · ${c.reported} reported by Levanta in window`);
  }
  const nonX = cov.filter((c) => c.platform !== X);
  if (!nonX.length) {
    console.log(`\n  no cross-post links minted${ONLY ? ` for ${ONLY}` : ''} — every click below is X by construction.`);
    console.log(`  a platform only becomes separable once its posts carry their OWN tracked links;`);
    console.log(`  until then its clicks are physically merged into X's and no report can split them.`);
  }

  const totals = new Map();
  for (const r of rows) {
    const t = totals.get(r.platform) || { clicks: 0, commission: 0, orders: 0, links: 0 };
    t.clicks += r.clicks; t.commission += r.commission; t.orders += r.orders; t.links += r.links;
    totals.set(r.platform, t);
  }
  const allClicks = [...totals.values()].reduce((a, t) => a + t.clicks, 0);

  console.log(`\n${ONLY ? 'split' : 'fleet split'}:`);
  for (const [p, t] of [...totals.entries()].sort((a, b) => b[1].clicks - a[1].clicks)) {
    const share = allClicks ? ((t.clicks / allClicks) * 100).toFixed(1) : '0.0';
    console.log(`  ${p.padEnd(10)} ${String(t.clicks).padStart(6)} clicks (${share.padStart(5)}%)  ${money(t.commission).padStart(10)}  ${String(t.orders).padStart(3)} orders  epc ${money(t.clicks ? t.commission / t.clicks : 0)}`);
  }
  // Unclaimed links belong to NO account, so an account filter cannot narrow them. Say that
  // plainly rather than letting a fleet-wide number read as this account's.
  if (unclaimed.links) console.log(`  ${'(unclaimed)'.padEnd(10)} ${String(unclaimed.clicks).padStart(6)} clicks              ${money(unclaimed.commission).padStart(10)}  — ${unclaimed.links} link(s) no ledger row claims${ONLY ? ', fleet-wide' : ''}`);

  console.log(`\nby account:`);
  const accts = [...new Set(rows.map((r) => r.account))].sort();
  for (const a of accts) {
    const mine = rows.filter((r) => r.account === a);
    const tot = mine.reduce((s, r) => s + r.clicks, 0);
    const parts = mine.sort((x, y) => y.clicks - x.clicks)
      .map((r) => `${r.platform} ${r.clicks}${tot ? ` (${((r.clicks / tot) * 100).toFixed(0)}%)` : ''}`).join('  ·  ');
    console.log(`  ${a.padEnd(16)} ${String(tot).padStart(6)} clicks   ${parts}`);
  }

  // The headline the operator actually asked for, stated so that zero is unmistakably a measurement
  // and not a missing one.
  for (const c of nonX) {
    const t = totals.get(c.platform) || { clicks: 0, commission: 0 };
    console.log(`\n${c.platform.toUpperCase()}: ${t.clicks} click(s), ${money(t.commission)} across ${c.minted} tracked link(s) on ${c.drafts} draft(s).`);
    if (!t.clicks) {
      console.log(c.reported
        ? `  A real zero: Levanta is returning rows for these links and not one carries a click in this window.`
        : `  A real zero: Levanta has returned no row for any of them, which is what it does for a link nobody has clicked.`);
    }
  }

  console.log(`\nplatform-clicks done — read-only, nothing written.`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
