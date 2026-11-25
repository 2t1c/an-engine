// audit-drafts.mjs — run the CURRENT laws over every draft that is already sitting in Typefully.
//
// The fleet's real bottleneck is not writing. draft-inventory found 73 unpublished health drafts,
// enough for the whole week — but most predate this week's rulings (substance bridge before the
// plug, "This is my" closer, tracked-link classification, no placeholders). Some are shippable
// today, some need one edit, some must never post. Writing 60 new threads while 73 sit unread is
// the expensive mistake; this tells us which is which.
//
// Tiers, by what happens if it posts:
//   BLOCKER  — must never post: a placeholder, a plug with no link, a hard health claim, an
//              untracked commerce link (we pay for the click and earn nothing), a broken thread.
//   DEGRADED — posts fine, but leaves money or quality on the table: no plug on a monetized page,
//              a plug the prior tweet never set up, em dashes, plug spacing.
//   CLEAN    — passes everything we currently enforce.
//
//   node audit-drafts.mjs                 # table + fleet roll-up
//   node audit-drafts.mjs --json          # worklist for the batch scheduler
//   node audit-drafts.mjs --account lorenzo
//   node audit-drafts.mjs --include-ai    # AI Evolution too (skipped by default: unmonetized lane)
import { isThreadRow } from './monitoring-scope.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
// selectPod is the canonical "which pod covers this product" answer; importing it here keeps the
// audit and the writer using ONE definition rather than two that drift.
import { selectPod } from './outline.mjs';
import {
  checkThread, effLen, isTrackedLink, bareCommerceLink, placeholderIssue, fakePlugIssue,
  stageDirectionIssue, unfilledEnumIssue, danglingLeadInIssue, plugSubstanceBridgeIssue,
  numberingIssue, hardHealthClaim, hardHealthClaimMatch, sharedWordRun, isBoilerplate,
} from './checks.mjs';
import { provenanceRecordFromDraft, reviewProvenance } from './provenance-controls.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');
const INCLUDE_AI = process.argv.includes('--include-ai');
// --jev: every SCHEDULED draft also gets Jev's final-copy safety read (plan v7 N5, owner 2026-09-23:
// "become jev native"; the nightly re-gate passes it). Report-only: it adds `jevSafety` (class and
// probability, never copy) and never changes a draft's tier. An unread draft says so.
// It also runs Jev's editorial read on scheduled drafts with a craft finding (jevCraftRead): a craft
// regex hit Jev reads as no problem is settled and leaves the tier (owner 2026-09-24).
const JEV = process.argv.includes('--jev');

const URL_RE = /https?:\/\/\S+/g;

// Pure: given the thread text and whatever the ledger knows, decide what would happen if this
// posted right now. Exported so test-scaffolds can pin the tiering rules.
export function auditThread(tweets, { account, accountKey = '', ledgerRow = null, products = [], title = '', provenance = null, hasMedia = false } = {}) {
  const blockers = [];
  const degraded = [];
  const text = tweets.join('\n');
  const links = [...new Set((text.match(URL_RE) || []).map((u) => u.replace(/[),.]+$/, '')))];
  const plugLinks = links.filter(isTrackedLink);
  // A [single] is not a monetized thread and must not be tiered as one. The singles lane posts
  // 3-5 unmonetized viral-health singles per account per day, so judging them on the plug rules
  // marks every one DEGRADED and buries the real findings under ~450 a week. Same exemption
  // verify-day makes, keyed the same way — on a title publish-thread never writes.
  const single = /^\[single\]/i.test(String(title || ''));
  // A thread carrying an experiment arm is judged on that arm's laws. `[cta1]` marks the one-ask arm
  // of the CTA experiment (2026-09-07): sixteen scheduled covers deliberately carry one plug instead
  // of two, and without this every one of them reads BLOCKER on plug-count in the sweep, the nightly
  // re-gate and the legality step — sixteen false criticals of exactly the kind the Run 2 post-mortem
  // said buries the real ones. Keyed on the title, which publish-thread never writes.
  const arm = /^\[cta1\]/i.test(String(title || '')) ? 'single-cta' : null;
  const monetized = !!account?.levantaSubidPrefix && !single;

  // --- BLOCKERS: things that must never reach the timeline.
  for (const fn of [placeholderIssue, fakePlugIssue, stageDirectionIssue, unfilledEnumIssue, danglingLeadInIssue]) {
    // account, not just tweets: fakePlugIssue takes one and SKIPS the account's boilerplate with
    // it. Dropping it made every compliant disclaimer read as a 'plug-shaped tweet with NO link',
    // because the fine print says 'affiliate link' and carries no URL — audit-drafts was calling
    // legal, shipping threads BLOCKER fleet-wide. The other four ignore the extra argument.
    const m = fn(tweets, account); if (m) blockers.push(m);
  }
  const ni = numberingIssue(tweets); if (ni) blockers.push(ni);
  // Longform is in scope for the singles lane (week-singles: "the 280-character cap does not apply
  // to this lane"), so a [single] is never a blocker for length — on 2026-09-07 the sweep called 43
  // scheduled singles "must not post" for it and buried the four real claim findings among them.
  if (!single) tweets.forEach((t, i) => { if (effLen(t) > 280) blockers.push(`tweet ${i + 1} over 280 (${effLen(t)})`); });
  // The legal disclaimer literally reads "not intended to prevent, diagnose, or treat disease", and
  // the sign-off is fixed copy — exempt our own boilerplate exactly the way checkThread does, or
  // every compliant thread in the fleet reads as a compliance failure.
  // isBoilerplate is the canonical test and it honours closingLegacy/disclaimerLegacy, so a draft
  // written against last month's sign-off is still recognised as our own copy.
  const boiler = (t) => isBoilerplate(account, t);
  tweets.forEach((t, i) => { if (!boiler(t) && hardHealthClaim(t)) blockers.push(`tweet ${i + 1} hard health claim ("${hardHealthClaimMatch(t)}")`); });
  const bare = bareCommerceLink(text); if (bare) blockers.push(`untracked commerce link: ${String(bare).slice(0, 60)}`);

  // --- DEGRADED: it can post, but we would rather fix it first.
  if (monetized && !plugLinks.length) degraded.push('no tracked plug — a monetized page posting for free');
  // The bridge law only means something when we know which product each link is. The ledger carries
  // that; a draft with no ledger row is checked for links but not for bridges (we would be guessing
  // at the substance, and a guessed gate is worse than no gate).
  const known = products.filter((p) => p?.link && text.includes(p.link));
  if (known.length) { const b = plugSubstanceBridgeIssue(tweets, known); if (b) degraded.push(b); }
  const emdash = tweets.map((t, i) => (/[—–]/.test(t) ? i + 1 : 0)).filter(Boolean);
  if (emdash.length) degraded.push(`em/en dash in tweet ${emdash.join(', ')}`);

  // The full QC gate, minus what we already tiered above — its errors are blockers, warns degrade.
  const seen = new Set([...blockers, ...degraded].map((s) => String(s).slice(0, 24)));
  for (const i of checkThread(tweets, { account, link: plugLinks[0], monetized, arm })) {
    if (seen.has(String(i.msg).slice(0, 24))) continue;
    if (single && i.code === 'length') continue;   // longform singles: same exemption as above

    (i.severity === 'error' ? blockers : degraded).push(`[${i.code}] ${i.msg}`);
  }

  // A CTA written by hand while a MEASURED pod already covered that substance — but ONLY when the
  // ask is also structurally weak. That qualifier is the whole check.
  //
  // The first cut flagged any plug sharing no 5-word run with its pod, and on the live queue that
  // was 75 drafts. Reading them, 58 were well-formed CTAs that simply are not the generic copy:
  // Clara's creatine plug names Creapure, gives the purity criterion, and closes in her own voice
  // ("the one I buy for THEM" — she writes for people caring for elderly parents), where pod CR1's
  // shared variant offers "So I went back to the boring tub." Hers is better. Worse, 18 of 21 pods
  // carry only the `*` variant, so "matches the pod" across eleven personas would mean eleven pages
  // running one voice — the fleet fingerprint sharedWordRun exists to prevent.
  //
  // A finding that is 77% false teaches the operator to scroll past the audit, which is the failure
  // mode needs-you.mjs opens by warning about. So the pod is offered as the FIX for a cold or
  // unbridged ask, never as the standard a working ask failed to meet.
  const ctaWeak = [...blockers, ...degraded].some((d) => /cta-cold-open|plug-structure|bridge missing|plug-numbered|plug-adjacent|criterion/i.test(d));
  if (ctaWeak) {
    for (const p of known) {
      if (!p.asin) continue;                     // no asin means no pod lookup, not a silent pass
      let pod = null;
      try { ({ pod } = selectPod(p, { account: accountKey })); } catch { pod = null; }
      if (!pod) continue;                        // no pod covers this product: nothing to drift from
      const plugTweet = tweets.find((t) => String(t).includes(p.link)) || '';
      const podCopy = (pod.variants || []).flatMap((v) => [v.point, v.bridge, v.opener, v.middle, v.cta]).filter(Boolean);
      if (podCopy.some((c) => sharedWordRun(plugTweet, c))) continue;
      degraded.push(`pod ${pod.id} covers ${p.asin} (${pod.substance}) and this thread's ask is weak — paste the pod rather than rewriting it`);
    }
  }

  const tier = blockers.length ? 'BLOCKER' : degraded.length ? 'DEGRADED' : 'CLEAN';
  const provenanceReview = reviewProvenance(provenance || provenanceRecordFromDraft({ ledgerRow, posts: tweets }), {
    posts: tweets, hasMedia, disclosed: /#ad|aff(?:iliate)?\s+link/i.test(text),
  });
  return { tier, blockers, degraded, plugCount: plugLinks.length, monetized, arm, ledgerRow: !!ledgerRow, provenanceReview };
}

/**
 * Jev's final-copy safety read on every scheduled draft (scripts/run-jev-final.mjs readFinalCopy, the
 * stop-5 read, through the one door). Mutates each scheduled draft row with `jevSafety`: [] when clean,
 * [{ key, p, tweet }] when flagged, or null when Jev could not read it. `tweetsById` holds the copy.
 */
export async function jevSafetyRead(out, env, { client = null, tweetsById = JEV_TWEETS } = {}) {
  const drafts = out.flatMap((a) => a.drafts.filter((d) => d.status === 'scheduled' && tweetsById.has(String(d.id))));
  if (!drafts.length) return 0;
  try {
    const { readFinalCopy } = await import('./scripts/run-jev-final.mjs');
    const jevClient = client || (await import('./jev.mjs')).jev(env);
    const rows = drafts.map((d) => ({ id: String(d.id), platforms: ['x'] }));
    const readings = await readFinalCopy(rows, { client: jevClient, readCopy: async (row) => ({ copy: { x: tweetsById.get(row.id) }, source: 'Typefully, read by audit-drafts' }) });
    const byId = new Map(readings.map((r) => [r.id, r]));
    for (const d of drafts) {
      const r = byId.get(String(d.id));
      d.jevSafety = r?.status === 'read' ? (r.flags || []).filter((f) => f.kind === 'safety').map((f) => ({ key: f.key, p: +Number(f.p).toFixed(2), tweet: f.tweet ?? null })) : null;
    }
  } catch (e) {
    console.error(`jev safety read not run (${String(e.message).slice(0, 100)}); scheduled drafts are unread`);
    for (const d of drafts) d.jevSafety = null;
  }
  return drafts.length;
}
const JEV_TWEETS = new Map();

/**
 * Craft findings Jev's editorial read settles (plan v7 N3, the same rule the drafts packet and the
 * publish door use; owner 2026-09-24: wire Jev into the nightly re-gate). A craft regex hit on a
 * scheduled draft (a one-sentence bridge, a cold plug, a dangling lead-in…, craft-gates.mjs) is moved
 * to `jevSettled` only when Jev's editorial pre-score reads this exact copy at an acting mode and
 * points at no craft problem; it then drops out of the tier. Safety, links, counts, 280 and numbering
 * never settle. Unread (no key, error, a craft pointer from Jev) leaves every finding where it was.
 * `prescore` and `settle` are injectable for tests.
 */
export async function jevCraftRead(out, env, { client = null, tweetsById = JEV_TWEETS, prescore = null, settle = null, isCraft = null } = {}) {
  const craftOf = isCraft || (await import('./craft-gates.mjs')).isCraftGateIssue;
  const drafts = out.flatMap((a) => a.drafts.filter((d) => d.status === 'scheduled' && tweetsById.has(String(d.id))
    && [...(d.blockers || []), ...(d.degraded || [])].some((i) => craftOf(i))));
  if (!drafts.length) return 0;
  try {
    const read = prescore || (await import('./scripts/run-jev.mjs')).editorialPrescore;
    const settleFn = settle || (await import('./scripts/run-content-packets.mjs')).settleCraftGates;
    const jevClient = client || (await import('./jev.mjs')).jev(env);
    for (const d of drafts) {
      const pre = await read({ id: String(d.id) }, tweetsById.get(String(d.id)), { client: jevClient });
      if (pre?.status !== 'read') { d.jevCraft = 'not read'; continue; }
      const reading = { copySha256: 'live', prescore: pre };
      const b = settleFn(d.blockers || [], reading, 'live', { id: String(d.id) });
      const g = settleFn(d.degraded || [], reading, 'live', { id: String(d.id) });
      d.jevSettled = [...b.settled, ...g.settled];
      d.jevCraft = d.jevSettled.length ? 'settled' : 'upheld';
      d.blockers = b.holds; d.degraded = g.holds;
      d.tier = d.blockers.length ? 'BLOCKER' : d.degraded.length ? 'DEGRADED' : 'CLEAN';
    }
  } catch (e) {
    console.error(`jev craft read not run (${String(e.message).slice(0, 100)}); craft findings stand`);
    for (const d of drafts) if (d.jevCraft === undefined) d.jevCraft = 'not read';
  }
  return drafts.length;
}

/**
 * One account's unpublished queue, read in full and judged on the thread laws. `tf` is the Typefully
 * client (get + getDraft); `led` maps a draft id to its ledger rows. Returns the per-account entry
 * --json prints: { account, handle, drafts, failed }.
 *
 * THREADS ONLY (isThreadRow). A standalone single and a native X Article (owner, R2026-10-03: articles
 * are additive) are not judged on these laws: an article's body is platforms.x_article, so it has no X
 * posts by design, and read here it would be listed as an unreadable draft ("no x posts"), which the
 * sweep reports as unchecked. scripts/run-articles.mjs gates articles on their own checks.
 */
export async function auditAccountQueue(tf, { accKey, acc, led = new Map() }) {
  // Everything unpublished that could still go out. 'planned' is inert but one confirm away.
  const heads = [];
  for (const status of ['draft', 'scheduled', 'planned', 'error']) {
    for (let offset = 0; ; offset += 50) {
      const page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=${status}&limit=50&offset=${offset}&order_by=-created_at`);
      const list = page?.results || [];
      heads.push(...list.filter((d) => isThreadRow(d)));
      if (list.length < 50) break;
    }
  }
  // Full bodies, a few at a time — 150 serial round trips is a coffee break.
  const rows = [];
  for (let i = 0; i < heads.length; i += 5) {
    const batch = await Promise.all(heads.slice(i, i + 5).map(async (h) => {
      let full; try { full = await tf.getDraft(acc.socialSetId, h.id); } catch (e) { return { id: h.id, error: String(e.message).slice(0, 80) }; }
      if (!isThreadRow(full)) return null;
      const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
      if (!tweets.length) return { id: h.id, error: 'no x posts' };
      const rowsFor = led.get(String(h.id)) || [];
      // BOTH products, not just the first: a roundup's second plug has its own link2/asin2, and
      // mapping only link/asin left every second plug unbridged and unchecked against its pod.
      const products = rowsFor.flatMap((r) => [
        r.link ? { link: r.link, title: r.product, asin: r.asin } : null,
        r.link2 ? { link: r.link2, title: r.product2, asin: r.asin2 } : null,
      ]).filter(Boolean);
      const posts = full?.platforms?.x?.posts || [];
      const hasMedia = posts.some((p) => (p.media_ids || []).length);
      const provenance = provenanceRecordFromDraft({ ledgerRow: rowsFor[0] || null, scratchpad: full?.scratchpad_text || full?.scratchpad || full?.notes || '', posts: tweets });
      const a = auditThread(tweets, { account: acc, accountKey: accKey, ledgerRow: rowsFor[0] || null, products, title: full?.draft_title || '', provenance, hasMedia });
      if (JEV && h.status === 'scheduled') JEV_TWEETS.set(String(h.id), tweets);
      return {
        id: h.id, status: h.status, scheduled: h.scheduled_date || null,
        ageDays: Number(((Date.now() - Date.parse(h.created_at || Date.now())) / 864e5).toFixed(1)),
        title: (h.draft_title || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 52),
        share: h.share_url, tweetCount: tweets.length, media: hasMedia,
        ...a,
      };
    }));
    rows.push(...batch.filter(Boolean));
  }
  return { account: acc.name, handle: acc.handle, drafts: rows.filter((r) => !r.error), failed: rows.filter((r) => r.error) };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);

  // draftId -> ledger rows (a roundup writes one row per product against the same draft).
  const led = new Map();
  for (const l of readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(l); if (e.draftId) { const k = String(e.draftId); (led.get(k) || led.set(k, []).get(k)).push(e); } } catch {}
  }

  const only = arg('account');
  const accounts = Object.entries(ACCOUNTS).filter(([, a]) =>
    !a.paused && a.socialSetId && (INCLUDE_AI || !!a.levantaSubidPrefix) &&
    (!only || a.name.toLowerCase().includes(only.toLowerCase())));

  const out = [];
  for (const [accKey, acc] of accounts) out.push(await auditAccountQueue(tf, { accKey, acc, led }));

  if (JEV) { await jevSafetyRead(out, env); await jevCraftRead(out, env); }
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  const ICON = { CLEAN: '🟢', DEGRADED: '🟡', BLOCKER: '🔴' };
  const fleet = { CLEAN: 0, DEGRADED: 0, BLOCKER: 0 };
  const reasons = new Map();
  console.log(`DRAFT AUDIT — current laws, ${new Date().toISOString().slice(0, 16)}Z\n`);
  for (const a of out) {
    const by = { CLEAN: [], DEGRADED: [], BLOCKER: [] };
    for (const r of a.drafts) by[r.tier].push(r);
    for (const k of Object.keys(by)) fleet[k] += by[k].length;
    console.log(`■ ${a.account}  🟢${by.CLEAN.length} clean  🟡${by.DEGRADED.length} degraded  🔴${by.BLOCKER.length} blocked  (${a.drafts.length} total)`);
    for (const tier of ['BLOCKER', 'DEGRADED', 'CLEAN']) for (const r of by[tier]) {
      console.log(`   ${ICON[tier]} ${String(r.id).padEnd(9)} ${String(r.status).padEnd(9)} ${r.tweetCount}t ${r.plugCount}p ${r.media ? '🖼' : '  '} ${r.ageDays}d  ${r.title}`);
      for (const b of r.blockers) { console.log(`        ✗ ${b}`); reasons.set(b.slice(0, 40), (reasons.get(b.slice(0, 40)) || 0) + 1); }
      for (const d of r.degraded) { console.log(`        · ${d}`); reasons.set(d.slice(0, 40), (reasons.get(d.slice(0, 40)) || 0) + 1); }
      for (const f of r.provenanceReview.findings) console.log(`        ? [provenance:${f.code}] ${f.message} Next: ${f.remediation}`);
    }
    if (a.failed.length) console.log(`   ⚠ ${a.failed.length} could not be read: ${a.failed.map((f) => f.id).join(', ')}`);
    console.log('');
  }
  console.log(`FLEET: 🟢 ${fleet.CLEAN} clean · 🟡 ${fleet.DEGRADED} degraded · 🔴 ${fleet.BLOCKER} blocked  (${fleet.CLEAN + fleet.DEGRADED + fleet.BLOCKER} audited)`);
  console.log(`\nTOP DEFECTS`);
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(3)} × ${r}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'audit-drafts');
