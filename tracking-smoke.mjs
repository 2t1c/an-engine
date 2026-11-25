// tracking-smoke.mjs — prove the per-thread attribution chain is sound, so revenue numbers are trustworthy.
//   node tracking-smoke.mjs            # static integrity + (if secrets present) live reconciliation
//   node tracking-smoke.mjs --static   # offline only — ledger/link integrity, no API calls
//
// WHY: every dollar of the money model is joined back to a thread by a tracking key. Two distinct joins,
// and this test mirrors revenue.mjs's keys EXACTLY (keep in sync — the url_parameters join in revenue.mjs):
//   - Levanta  : the `lv_<id>` parsed from the stored link, matched to the v1 report's link.id
//   - Gumroad  : subid1 === the live sale's url_parameters.ref (set by tagGumroad as ?ref=<subid1>)
// A broken key doesn't error — it silently reports $0 while real money flows untracked. That's the failure
// this guards against: not "did it crash" but "are the numbers complete and attributable".
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, levanta, gumroad, telegram, esc, report, logRun, HERE_DIR, lvIdOf, railOf, nextDay } from './lib.mjs';

const STATIC = process.argv.includes('--static');
const NO_TG = process.argv.includes('--no-telegram'); // local runs: skip the Telegram pulse
const LEDGER = join(HERE_DIR, 'ledger.jsonl');
const money = (n) => `$${(n || 0).toFixed(2)}`;
// Mirror revenue.mjs, PLUS the rail revenue.mjs doesn't need to name: Levanta also mints DIRECT
// Amazon Attribution URLs (amazon.com/dp/…?maas=maas_adg_api_… or ?aa_adgroupid=lv_…). Those are
// real tracked links — registry-sync attributes their money by SUBID, and the aa_adgroupid form
// even joins by lv_ id — they just carry no lvnta.com host to match on. First seen live 2026-08-15
// (Magnus hand-minted plugs), then the 4 runner-minted attribution rows of 2026-08-17.
const refOf = (link = '') => { const m = link.match(/[?&]ref=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; };

let failures = 0, warns = 0, checksRun = 0, checksPass = 0;
const failedChecks = [];
let levSummary = null, gumSummary = null; // captured in the live section, surfaced in the Telegram pulse
const check = (ok, label, detail = '') => { console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`); checksRun++; if (ok) checksPass++; else { failures++; failedChecks.push(detail || label); } };
const warn = (label, detail = '') => { console.log(`⚠️  ${label}${detail ? ` — ${detail}` : ''}`); warns++; };

// ---------- load ledger ----------
if (!existsSync(LEDGER)) { console.error('No ledger.jsonl'); process.exit(1); }
const rawLines = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
const malformed = [];
const entries = rawLines.map((l, i) => { try { return JSON.parse(l); } catch { malformed.push(i + 1); return null; } }).filter(Boolean);
// A monetized (tracked) entry carries an affiliate link. `mode` is absent on legacy (pre-June-11) rows, so
// detect by link presence, not the mode tag — exactly what revenue.mjs's railOf-based join keys off.
const tracked = entries.filter((e) => railOf(e.link) !== 'other');

console.log('=== STATIC INTEGRITY (ledger → link → join key) ===');
console.log(`ledger lines ${rawLines.length} · parsed ${entries.length} · tracked(monetized) ${tracked.length}`);
check(malformed.length === 0, 'every line is valid JSON', malformed.length ? `bad lines: ${malformed.join(',')}` : '');

// 1) Every tracked entry has a subid1 (loadLedger DROPS entries without one — they'd be invisible to revenue).
//    EXEMPT mode:'backfill' recovery rows (#175): pre-ledger June links restored from published draft
//    text are subid1-less BY DEFINITION — subid tagging didn't exist when they were minted; that's what
//    made them ghosts. They join revenue by lv_id, so the assertion's job — catch a NEW thread shipped
//    without its subid tag — doesn't apply to them, and without the exemption every future PR fails CI
//    on 10 historical rows nothing can retroactively tag.
//    subidLost:true rows are the same class from the other direction (2026-08-17 persist-step
//    rebase incident): the runner's ledger commit was lost, links were recovered from the live
//    draft, but the subids exist only inside Levanta — unrecoverable by definition, documented in
//    each row's note. Their revenue still joins by lv_id in registry-sync. Keyed to the explicit
//    marker so a NEW row that simply forgot its subid still fails.
//    EXEMPT a Geniuslink overlay row (mode:'geni') whose link already has a subid-tagged row: it
//    records the geni.us wrapper of a link minted (and tagged) elsewhere, not a new thread. 48 such
//    rows from 2026-11-08..10 carried `link` and failed link-sentinel three times a day; every one
//    of their links has its tagged mint row. An overlay whose link has NO tagged row still fails.
const taggedLinks = new Set(tracked.filter((e) => e.subid1).map((e) => e.link));
const noSubid = tracked.filter((e) => !e.subid1 && e.mode !== 'backfill' && !e.subidLost && !(e.mode === 'geni' && taggedLinks.has(e.link)));
check(noSubid.length === 0, 'every tracked thread has a subid1 (backfill recovery rows exempt)', noSubid.length ? `${noSubid.length} missing (draftIds: ${noSubid.map((e) => e.draftId).join(',')})` : '');

// 2) No subid1 COLLISION across distinct threads. loadLedger dedups by subid1 keeping the LAST, so two
//    different threads sharing a subid1 means one is silently dropped AND its earnings mis-attributed.
const bySub = new Map();
for (const e of tracked) if (e.subid1) (bySub.get(e.subid1) || bySub.set(e.subid1, []).get(e.subid1)).push(e);
// Thread identity has TWO legitimate axes and a group is fine if it shares EITHER:
//   same draftId, different recIds — one draft with several attribution rows (a re-mint, an
//     evergreen re-attribution, a skeleton row + its monetized twin; all live on 2026-08-16);
//   same recId, different draftIds — a REGENERATED thread (retry replaces the draft, the slug and
//     subid legitimately survive; loadLedger keeps the last = live draft).
// Only rows differing on BOTH axes are two genuinely distinct threads sharing a subid — the
// mis-attribution this check exists for. recIds are compared by their last-6 tail (the same
// stable key check 7 uses) because rows record the SAME registry record in two spellings:
// hand-written rows carry the short tail ("rCs6xU"), event rows the full id ("recx9Tuhqt…").
// mode:'mint' rows carry NO thread identity by design — mint-link/mint-batch append them with
// null draftId/recId and the thread's real row supersedes them via the same subid (mint-link.mjs's
// own contract). Counting their nulls as a "thread" made the fix flag itself: the first two hand
// mints after it landed (2026-08-25, lines 767/771) collided with their own publish rows (786/787),
// same link, same subid — the supersede working exactly as documented. Mint rows are excluded from
// the identity axes; a group that is ONLY mints has no thread to collide with (reconcile tracks
// those as minted-unattached).
const collisions = [...bySub.entries()].filter(([, es]) => {
  const th = es.filter((e) => e.mode !== 'mint');
  return new Set(th.map((e) => String(e.recId || '').slice(-6))).size > 1 && new Set(th.map((e) => e.draftId)).size > 1;
});
check(collisions.length === 0, 'no subid1 collisions across distinct threads', collisions.length ? `${collisions.length} collided: ${collisions.slice(0, 3).map(([s]) => s).join(' ; ')}` : `${bySub.size} unique subid1`);

// 3) Rail classification: nothing tracked falls through to 'other' (an unjoinable link).
const other = entries.filter((e) => e.link && railOf(e.link) === 'other');
check(other.length === 0, "no tracked link classifies as 'other' rail", other.length ? `${other.length} unrecognised links` : '');

// 4) Levanta links: every one yields a parseable lv_<id> — the join key revenue.mjs matches on.
const lev = tracked.filter((e) => railOf(e.link) === 'levanta');
const lvBad = lev.filter((e) => !lvIdOf(e.link));
check(lvBad.length === 0, 'every Levanta link has a parseable lv_<id> join key', lvBad.length ? `${lvBad.length} unparseable (e.g. ${lvBad[0]?.link})` : `${lev.length} Levanta links`);

// 4b) Direct-rail links key by aa_adgroupid — the link id Levanta reports on. First-match parsing
//     took the SHARED campaign id instead (44 rows, 8 accounts, found 2026-08-24); this pins the
//     canonical parser against the live ledger so that class can never ship again.
const attrLinks = entries.flatMap((e) => [e.link, e.link2]).filter((l) => railOf(l) === 'amazon-attr');
const attrBad = attrLinks.filter((l) => { const m = String(l).match(/[?&]aa_adgroupid=(lv_[A-Za-z0-9]+)/); return m && lvIdOf(l) !== m[1]; });
check(attrBad.length === 0, 'every direct-rail link keys by its aa_adgroupid (never the shared campaign id)', attrBad.length ? `${attrBad.length} mis-keyed (e.g. ${attrBad[0]})` : `${attrLinks.length} direct-rail links`);

// 5) Gumroad links: ?ref present AND decodes to exactly subid1 (the join is gum.get(subid1) === url_parameters.ref).
const gumr = tracked.filter((e) => railOf(e.link) === 'gumroad');
const refMissing = gumr.filter((e) => !refOf(e.link));
const refMismatch = gumr.filter((e) => refOf(e.link) && refOf(e.link) !== e.subid1);
const refCaseOnly = refMismatch.filter((e) => refOf(e.link).toLowerCase() === e.subid1.toLowerCase());
check(refMissing.length === 0, 'every Gumroad link carries a ?ref tag', refMissing.length ? `${refMissing.length} untagged` : `${gumr.length} Gumroad links`);
check(refMismatch.length === 0, 'every Gumroad ?ref equals its subid1 (join key matches)', refMismatch.length ? `${refMismatch.length} mismatched${refCaseOnly.length ? ` (${refCaseOnly.length} differ by CASE only — platforms that lowercase params would break the join)` : ''}` : '');

// 6) subid1 length matters only on the rail that joins on subid text. Levanta-family revenue joins
//    on the opaque lv_id parsed from the link, so warning on those rows produced thousands of
//    unactionable notices. Gumroad joins on ?ref text; keep that unresolved warning until a live
//    sale round-trip proves the provider preserves a long ref.
const LONG = 50;
const longSubs = gumr.filter((e) => (e.subid1 || '').length > LONG);
if (longSubs.length) warn(`${longSubs.length} Gumroad refs longer than ${LONG} chars`, `stored links preserve the exact ref, but a sale round-trip is still required before treating long-ref attribution as verified`);

// 7) Current recreate IDs end `<recId tail>-<nonce>`; pre-nonce IDs end at the tail. The old test
//    required the tail at end-of-string and therefore mislabeled every correctly nonced row.
const shapeBad = tracked.filter((e) => {
  if (!e.subid1 || !/^rec[A-Za-z0-9]{14}$/.test(e.recId || '') || e.mode === 'mint' || e.suppliedSubid || e.handWritten || e.attributionOnly || e.harvestOf || e.note || e.event) return false;
  const tail = String(e.recId).slice(-6).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp(`-${tail}(?:-[a-z0-9]{4}(?:-[a-z0-9]+)*)?$`, 'i').test(e.subid1);
});
check(shapeBad.length === 0, 'generated subid1 matches the versioned recId-tail/nonce shape', shapeBad.length ? `${shapeBad.length} unrecognized generated IDs` : '');

// rail coverage summary
const byRail = entries.reduce((m, e) => { const r = railOf(e.link); if (e.link) m[r] = (m[r] || 0) + 1; return m; }, {});
console.log(`\nrail coverage: ${JSON.stringify(byRail)} · unique threads ${bySub.size}`);
if (!byRail.gumroad) warn('0 Gumroad-tagged links ever shipped', 'Gumroad per-thread attribution is UNPROVEN — any Gumroad store revenue is 100% unattributed until a ?ref link goes live');

// ---------- live reconciliation ----------
if (STATIC) { console.log(`\nstatic: ${failures} failure(s), ${warns} warning(s)`); process.exit(failures ? 1 : 0); }

const env = loadEnv();
if (!env.LEVANTA_API_KEY) { console.log('\n(no LEVANTA_API_KEY — skipping live reconciliation; run with secrets for the gap analysis)'); process.exit(failures ? 1 : 0); }

console.log('\n=== LIVE RECONCILIATION (store totals vs per-thread attributed) ===');
const isoDay = (d) => d.toISOString().slice(0, 10);
const since = isoDay(new Date(Date.now() - 30 * 864e5)), until = isoDay(new Date());
// EVERY claimable key: both products' links, on BOTH Levanta-family rails. The old set (e.link
// only, lvnta rail only) counted second-product and direct-rail commission as "unattributed" —
// most of the dashboard's phantom "-30% vs Levanta" was this measurement, not lost money. The
// store side below is transaction-dated; with the full key set an evergreen post older than the
// window still claims its in-window commission, so the residue is genuinely-outside-the-ledger.
const ledgerLvIds = new Set(entries.flatMap((e) => [e.link, e.link2])
  .filter((l) => ['levanta', 'amazon-attr'].includes(railOf(l)))
  .map((l) => lvIdOf(l)).filter(Boolean));

// Levanta: store total commission vs the slice attributable to ledger threads. A large gap = commission on
// links not minted by our pipeline (or outside the window) — real money the per-thread report can't see.
const reports = await levanta(env).listReports({ start: since, end: until });
let storeCommission = 0, attributedCommission = 0; const unattributed = new Map();
for (const r of reports) {
  const c = Number(r.commissionEarned) || 0; storeCommission += c; if (!c) continue;
  const id = r.link?.id;
  if (id && ledgerLvIds.has(id)) attributedCommission += c;
  else if (id) unattributed.set(id, (unattributed.get(id) || 0) + c);
}
const levGap = storeCommission - attributedCommission;
const gapPct = storeCommission ? Math.round(100 * levGap / storeCommission) : 0;
console.log(`Levanta ${since}→${until}: store ${money(storeCommission)} · claimable by ledger ${money(attributedCommission)} · outside the ledger ${money(levGap)} (${gapPct}%)`);
// FAIL only on a BLACKOUT (the join is broken): the store earned real commission but $0 joined to ANY
// thread — that's the lv_ key silently dying. The chronic partial under-count (links minted outside the
// pipeline / pre-ledger) is a known state GOALS already calls out, so it's a WARNING, never a daily alarm.
const MATERIAL = 1; // dollars — ignore sub-$1 noise
check(storeCommission < MATERIAL || attributedCommission > 0,
  'Levanta per-thread join is live (store commission ⇒ some attributed)',
  storeCommission >= MATERIAL && attributedCommission === 0 ? `BLACKOUT: ${money(storeCommission)} store commission but $0 joined to any thread — the lv_ join is broken` : '');
if (storeCommission >= MATERIAL && gapPct >= 50) warn(`Levanta: ${gapPct}% of commission (${money(levGap)}) on links outside the ledger`, `${unattributed.size} earning link(s) the ledger cannot name — run the reconcile report for the per-link list`);
levSummary = { store: storeCommission, attr: attributedCommission, gapPct, unattributed: unattributed.size };
// Persist the reconciliation so the dashboard reads a NUMBER instead of a vibe: before 2026-08-24
// the unclaimed list lived only in Actions console logs and the "$2,258 unclaimed" tile could
// never be audited. Fire-and-forget like every logRun — the smoke's outcome never depends on it.
logRun('tracking-smoke', { window: `${since}→${until}`, store: Number(storeCommission.toFixed(2)), attributed: Number(attributedCommission.toFixed(2)), gapPct, unattributedCount: unattributed.size, unattributedTop: [...unattributed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([lvId, c]) => ({ lvId, commission: Number(c.toFixed(2)) })) });
[...unattributed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([id, c]) => console.log(`    ${money(c)} on ${id} (not joined to any thread)`));

// Gumroad: total net vs tagged net. tagged=0 with net>0 is the loud attribution gap revenue.mjs warns on.
if (env.GUMROAD_ACCESS_TOKEN) {
  const sales = await gumroad(env).listSales({ after: since, before: nextDay(until) }); // `before` is date-EXCLUSIVE
  let net = 0, taggedNet = 0, tagged = 0, taggedInLedger = 0;
  const ledgerSubs = new Set(tracked.map((e) => e.subid1));
  for (const s of sales) {
    const n = (s.price - (s.gumroad_fee || 0)) / 100; net += n;
    const ref = s.url_parameters && (s.url_parameters.ref || s.url_parameters.subid1);
    if (ref) { tagged++; taggedNet += n; if (ledgerSubs.has(ref)) taggedInLedger++; }
  }
  console.log(`Gumroad ${since}→${until}: net ${money(net)} · ${sales.length} sale(s) · ${tagged} tagged · ${taggedInLedger} tagged-AND-in-ledger`);
  // Known chronic gap (0 tagged links ever shipped) is a WARNING, not a daily failure — it's a strategic
  // TODO, not a regression. But once tagged sales DO exist, a ref that resolves to no thread IS a broken
  // key (case/truncation) and fails.
  if (net > 0 && tagged === 0) warn('Gumroad: store revenue but 0 ?ref-tagged sales', `${money(net)} net, 100% per-thread blind — known gap until a tagged link ships`);
  if (tagged > 0) check(taggedInLedger > 0, 'Gumroad: tagged refs resolve to ledger threads', taggedInLedger === 0 ? 'tagged refs match NO subid1 (key mismatch — case? truncation?)' : '');
  gumSummary = { net, tagged, taggedInLedger };
} else {
  console.log('(no GUMROAD_ACCESS_TOKEN — Gumroad reconciliation skipped)');
}

console.log(`\nresult: ${failures} failure(s), ${warns} warning(s)`);

// --- Telegram pulse: a regression -> ⚠️ alerts topic; a clean run only when it is a recovery (same topic). Uses the canonical report() like every other operator message. ---
if (!STATIC && !NO_TG && env.XDB_BASE_ID && env.AIRTABLE_PAT) {
  const glyph = failures ? '🛑' : (warns ? '⚠️' : '✅');
  const rails = [
    levSummary ? `🔗 <b>Levanta:</b> store ${money(levSummary.store)} · attributed ${money(levSummary.attr)} <i>(${100 - levSummary.gapPct}% to threads)</i>` : '',
    gumSummary ? `🏪 <b>Gumroad:</b> ${money(gumSummary.net)} net · ${gumSummary.tagged} tagged${gumSummary.net > 0 && gumSummary.tagged === 0 ? ' <i>(per-thread blind)</i>' : ''}` : '',
  ].filter(Boolean).join('\n');
  const msg = report({
    emoji: '🔎', title: 'Attribution Check', scope: `${since} → ${until}`,
    status: failures
      ? `${glyph} <b>Attribution REGRESSION</b> — ${failures} check(s) failing`
      : `${glyph} Tracking healthy — integrity ${checksPass}/${checksRun}, per-thread join live`,
    sections: [{ body: rails }],
    action: failures
      ? (failedChecks[0] || 'investigate the failing check')
      : (gumSummary && gumSummary.net > 0 && gumSummary.tagged === 0 ? 'Ship a Gumroad ?ref link so store revenue attributes per-thread.' : 'no action'),
  });
  // Keyed (Phase 7b): this rides the 2h link-sentinel cron, so an unkeyed pulse said "healthy" 12
  // times a day. Healthy now sends only as a RECOVERY, and to Needs You, where the failure it closes
  // was paged. A failure re-pages when its failing checks change or the dedupe window passes. Dollar
  // figures are dropped from the fingerprint: the 30-day store total moves between runs while the
  // failure itself stays the same.
  const fingerprint = failedChecks.map((c) => String(c).replace(/\$[\d,.]+/g, '$')).sort().join('|');
  try { const r = await telegram(env, msg, 'alerts', { key: 'tracking-smoke', ok: !failures, fingerprint }); console.log(r.sent ? `✓ Telegram pulse sent (${r.decision})` : `Telegram pulse not sent (${r.decision})`); }
  catch (e) { console.log('telegram failed (non-blocking):', e.message); }
}
process.exit(failures ? 1 : 0);
