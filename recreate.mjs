// recreate.mjs — turn one inspiration thread (Airtable swipe row) into a monetized
// Julian recreation: hook ~95% of source (near-verbatim — the proven repost-winners template,
// restored 2026-08-01), body lightly reworded, 2 Levanta plugs, closing. (Skeleton-variation mode
// keeps its own anti-duplicate 7-word gate; faithful mode does not.)
//   node recreate.mjs <airtableRecordId> --asin <ASIN> --link <lvnta url> --product "<title>" [--subid <subid on that link>] [--create] [--model opus]
// Without --create it prints + validates only (no Typefully write).
import { buildPlatforms, withSiteCta } from './platforms.mjs';
import { withProcessResult } from './process-result.mjs';
import { crossPostLinks, crossPostLedgerRows } from './cross-post-links.mjs';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, LLM_KEYS, airtable, typefully, anthropic, FLEET_MODEL, STRONG_MODEL, levanta, tagGumroad, HERE_DIR, llmSpendSummary, flushLlmSpend } from './lib.mjs';
import { getAccount, defaultAccountKey } from './accounts.mjs';
import { signOffOf } from './laws.mjs';
import { effLen, hasUrl, plugTextLen, PLUG_LIMIT, TWEET_LIMIT, appendSubstanceBridge, unfuseBridge, substanceTermsFor, discriminationIssue, runUpIssue, numberingIssue, leadingNumbers, numeralizeBulletItems, renumberLeadingMarkers, hardTrimPlug, shortName, hardHealthClaim, hardHealthClaimMatch, normalizePlugStructure, absoluteSuperlativeIssue, plugFingerprint, plugStructure, plugEchoIssue, sharedNgramIssue, hookStrength, hookMoldIssue, plugPositions, splitMergedItems, packItems, hookBlockIssue, mergeHookBlock, stripItemMarkers, hookAttachIssue, attachFirstItemToHook, srcTweet1AttachesItem, attachRuleApplies, bulletizeRecapList, capItemCount, PLACEHOLDER_RE, placeholderIssue, fakePlugIssue, plugSubstanceMismatch, duplicateItemIssue, cutDuplicateItem, packedItemsIssue, stripEmDash, ensureDisclosure, validateDraft, normalizeLineBreaks, respaceWall, unstackParagraphs, splitLongTweet, hookTooLong, hookIdenticalIssue, hookFidelityIssue, hookSimilarity, hookDriftDirection, DANGLING_CTA_RE, firstItemFormIssue, listicleKind, hookBodyText, malformedLevanta, classifyPlugMove, isTrackedLink, wantsBonus, bonusSlot } from './checks.mjs';
import { DISCLOSURE_LINE_RE } from './disclosure.mjs';
import { selfQrtInsert, selfQrtQuotesHere, selfQrtEnabled } from './self-qrt.mjs'; // self-QRT: quote our own recent winner (SELF-QRT-PLAN.md)
import { assembleThread, parseSlotFills } from './assemble.mjs';
import { buildPrompt, buildSkeletonPrompt, buildPromptLite, buildOutlinePrompt, buildSlotPrompt, splicePlugMarkers, writePlugs, writeBridgePriors, tightenLong } from './prompts.mjs';
import { buildOutline, renderOutline, compileSkeleton, renderSkeleton, selectPod, selectAltPod, podFrame, podFill, numberPastedPods } from './outline.mjs';
import { renderPod, DEFAULT_POD_SYSTEM } from './pods.mjs';
import { classifyTopic } from './pick-product.mjs'; // tag each thread's topic in the ledger for the learn loop
import { hookIdOf, plugTweetIndices } from './metrics.mjs'; // hook identity + plug positions for the ledger (revenue-per-hook + plug-funnel metrics)
import { extractSkeleton, saveSkeleton, getSkeleton, loadHookBank, recordStructureUse } from './skeleton.mjs'; // skeleton-variation mode + structure×topic grid
import { TABLES } from './config.mjs';
import { judgePlug } from './cta.mjs';

const slugify = (s) => String(s).toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const args = process.argv.slice(2);
const recId = args.find((a) => /^rec[A-Za-z0-9]+$/.test(a));
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : def; };
const CREATE = args.includes('--create');
// Self-QRT (operator 2026-08-10, spec SELF-QRT-PLAN.md): quote the account's OWN recent winner —
// URL rides tweet 1 (the thread publishes as a QRT) + an echo tweet before the disclaimer.
// Caller (daily-winners) selects the winner via self-qrt.mjs and passes it here at DRAFT-CREATION
// time — never a later PATCH (reference-system hard rule: a late patch can silently wipe it).
// With the lane off — the default — the flag is dropped to '' right here, at the single place it is
// read. Everything downstream (the insert, the scratchpad note, the ledger's selfQrtOf, the per-post
// quote_post_url) already keys off a truthy SELF_QRT_URL, so the whole path no-ops. No caller passes
// --self-qrt-url today; this is the dormant path being nailed shut, not a live one.
const SELF_QRT_URL = selfQrtEnabled() ? flag('self-qrt-url', '') : '';
const SELF_QRT_TOPICS = flag('self-qrt-topics', 'this');
const SELF_QRT_META = flag('self-qrt-meta', ''); // "views·ageDays" — for the scratchpad note only
// (--alt-hooks removed 2026-07-21: always-off since the 07-19 audit — nothing read the "ALT n:"
// scratchpad lines, and its "~95% similar" goal contradicted the 85% rule. The hook-bank few-shot
// block in buildSkeletonPrompt is the living replacement for hook variety.)
// The writer model. INVERTED 2026-08-25 (operator: "remove GLM completely from all functions, let's
// just make sure accuracy is always priority"). This used to default to sonnet with opus as an
// opt-in; the money step now gets the strongest model unless someone deliberately asks for cheaper.
// Evidence for the flip: the three GLM writer runs all failed the gates on quality — duplicated
// content and a 69% hook — so the saving was never realised, it just moved cost from tokens to
// retries and operator attention. `--model sonnet` is the cheap lane; `--model opus` still resolves
// for any caller that passed it before.
const MODEL = flag('model') === 'sonnet' ? FLEET_MODEL : STRONG_MODEL;
const ACCOUNT = getAccount(flag('account', defaultAccountKey()));
const product = { asin: flag('asin'), link: flag('link'), title: flag('product'), suppliedSubid: flag('subid') };
// Optional SECOND product (--asin2 / --link2 / --product2): when present, the LIGHT plug promotes this
// product and the HEAVY plug promotes the primary, so the two CTAs can each fit the context of their own
// prior tweet. Omit all three and behaviour is identical to before (both plugs = the one product).
const product2 = (flag('asin2') || flag('link2') || flag('product2'))
  ? { asin: flag('asin2'), link: flag('link2'), title: flag('product2'), suppliedSubid: flag('subid2b') }
  : null;
const TWEETS_FILE = flag('tweets-file'); // LLM bypass: inject hand-authored tweets (JSON array; {{LINK}} -> tracked link)
// Mold-lane attribution (engine v2 part D): the plan consumer (run-plan.mjs) passes --mold <id>
// when this thread runs a molds.json template. The id rides the ledger row untouched — it is what
// mold-promote.mjs joins on to decide promotion/demotion, so without it the mold loop is blind.
const MOLD_ID = flag('mold', '');
const CONVERT_TO = flag('convert', ''); // plan's shape conversion (roundup|deepDive) — ledger stamp + outline hint
// SKELETON-VARIATION mode (X 2026-07 duplicate-content enforcement): keep the source's proven FORM,
// write NEW content on a product-fit topic sourced from real on-topic FACT threads. --skeleton <id|'auto'>
// selects/extracts the shape; --topic the new subject; --facts a CSV of swipe recIds for the substance.
const SKELETON = flag('skeleton');
const TOPIC = flag('topic');
const FACTS = (flag('facts') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SKEL_MODE = !!SKELETON;
// PRINCIPLED REMIX (operator rule 2026-07-22): on a structure's REUSE, the hook may be re-framed
// freely as long as the skeleton's foundational principles + shape metrics hold (prompts.mjs swaps
// the hook rule; the mold gate below steps aside and the strength floor gates unconditionally
// instead). daily-winners passes this when the structure×topic grid says the form has run before.
const HOOK_FREEDOM = args.includes('--hook-freedom') && SKEL_MODE;

const THREADS = TABLES.swipe;

// Reconstruct the source thread from its child tweet rows (the source of truth),
// so we don't depend on a volatile rollup field name. Returns ordered tweet texts,
// a verbatim original, and a media inventory in one pass.
async function loadThread(at, headRec) {
  const ids = headRec.fields.Tweets || [];
  const rows = [];
  for (const id of ids) {
    const f = (await at.getRecord(THREADS, id)).fields;
    const isVid = f['Media Type'] === 'Video' || (f['Video File'] || []).length || f['Video URL'];
    rows.push({ n: f['Tweet Number'] || 0, text: f.Text || '', imgs: f['Media Type'] === 'Photo' ? (f.Media || []).length : 0, vid: isVid ? 1 : 0 });
  }
  rows.sort((a, b) => a.n - b.n);
  const srcTweets = rows.map((r) => r.text).filter(Boolean);
  const verbatim = rows.map((r) => `[${r.n}] ${r.text}`).join('\n\n--------------------------------------------\n\n');
  const images = rows.reduce((s, r) => s + r.imgs, 0);
  const videos = rows.reduce((s, r) => s + r.vid, 0);
  const positions = rows.filter((r) => r.imgs || r.vid)
    .map((r) => `tweet ${r.n}: ${[r.vid ? '1 video' : '', r.imgs ? `${r.imgs} image(s)` : ''].filter(Boolean).join(' + ')}`);
  const summary = images + videos === 0
    ? '0 images, 0 videos (text-only thread). Match: post text-only, no media needed.'
    : `${images} image(s), ${videos} video(s).\n` + positions.map((p) => '  - ' + p).join('\n');
  return { srcTweets, verbatim, inv: { images, videos, summary } };
}

// The prompt layer (buildPrompt / buildSkeletonPrompt / buildPromptLite / writePlugs / tightenLong /
// learnedRules) lives in prompts.mjs; the pure draft validators (stripEmDash /
// ensureDisclosure / validateDraft) live in checks.mjs beside the other unit-tested gates
// (2026-07-21 split — moved verbatim, engine behavior unchanged).

async function main(resultChannel = null) {
  if (!recId) throw new Error('Pass an Airtable record id (rec...)');
  // Monetized accounts (Julian) carry plug config -> full craft. Client accounts (AI Evolution)
  // have none -> lightweight: faithful variation + handle swap, no products/plugs/disclaimer.
  const MONETIZED = !!ACCOUNT.plugHeavyExample;
  if (MONETIZED && !product.asin && !product.link) throw new Error('Monetized account needs --asin <ASIN> or --link <url>');
  // CTA STYLE SPLIT TEST (operator 2026-08-08): 50/50 per thread between the classic research-shape
  // plug and the "DM preempt" style ("And since I know most of you will DM me after reading this...").
  // A per-account plugStyle (e.g. the ebook pages' 'narrative') always wins — no split there. The
  // chosen style is stamped into the ledger (ctaStyle) so revenue can compare cohorts by style.
  // CTA_SPLIT=0 disables the split (everything classic).
  // DETERMINISTIC ALTERNATION (operator 2026-08-11): the random 50/50 held GLOBALLY but streaked per
  // account (Julian drew classic 3x running — reads as CTA fatigue on the page). Flip the account's
  // LAST used style instead: per-account max streak = 1, global A/B stays 50/50. Random only seeds
  // an account's very first monetized draft. Pinned plugStyle (narrative ebook pages) still wins.
  const lastCtaStyle = (() => {
    try {
      const lines = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const e = JSON.parse(lines[i]); if (e.account === ACCOUNT.name && e.ctaStyle && e.ctaStyle !== 'narrative') return e.ctaStyle; } catch {}
      }
    } catch {}
    return null;
  })();
  // Four arms since 2026-08-15: classic -> payoff -> dm -> lean -> classic. Same per-account
  // alternation rule as before (max streak 1, no CTA fatigue on a page), over the cycle. `payoff`
  // is the June-winner personalized testimonial (operator 2026-08-15) — the 8.8%-CVR style, now
  // measured as an arm instead of remembered as an era.
  // Operator ruling 2026-08-16: the personal payoff CTA is now the fleet default — the split test is
  // called (payoff cohort 8.8-9.5% CVR vs classic-formula 2.8%; June's winners were all bespoke
  // personal plugs). classic/dm/lean remain implemented for qc/judging of live drafts but no new
  // generation uses them. Restore the array to re-open the experiment.
  // CROSS-THREAD MOVE VARIETY (LAW 12c, operator 2026-08-16). The within-thread rule ("the two plugs
  // must not match") was already enforced, but nothing looked ACROSS threads — every thread this week
  // could open on the same move and no gate would notice. Read the opener moves this account used on
  // its last few monetized drafts and hand them to writePlugs as a do-not-reuse list. Ledger-derived,
  // so it needs no new state and works from the first run.
  const AVOID_MOVES_WINDOW = Number(process.env.PLUG_MOVE_WINDOW ?? 4);
  const recentMoves = (() => {
    try {
      const lines = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n');
      const seen = [];
      for (let i = lines.length - 1; i >= 0 && seen.length < AVOID_MOVES_WINDOW; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.account !== ACCOUNT.name || !Array.isArray(e.plugMoves)) continue;
          for (const mv of e.plugMoves) if (mv && mv !== 'other' && !seen.includes(mv)) seen.push(mv);
        } catch {}
      }
      return seen.slice(0, AVOID_MOVES_WINDOW);
    } catch { return []; }
  })();
  const CTA_ARMS = ['payoff'];
  const CTA_STYLE = ACCOUNT.plugStyle || (MONETIZED && process.env.CTA_SPLIT !== '0'
    ? (CTA_ARMS.includes(lastCtaStyle)
      ? CTA_ARMS[(CTA_ARMS.indexOf(lastCtaStyle) + 1) % CTA_ARMS.length]
      : CTA_ARMS[Math.floor(Math.random() * CTA_ARMS.length)])
    : 'classic');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', LLM_KEYS, 'TYPEFULLY_API_KEY', ...(MONETIZED && !product.link ? ['LEVANTA_API_KEY'] : [])]);
  const at = airtable(env), tf = typefully(env);

  const rec = await at.getRecord(THREADS, recId);
  const src = { url: rec.fields['Tweet URL'], impressions: rec.fields.Impressions || 0, niche: rec.fields.Niche };
  const { srcTweets, verbatim, inv } = await loadThread(at, rec);
  // FAITHFUL ITEM CAP (operator 2026-08-10): ideal thread is 7-13 tweets, leaning short — the
  // algorithm punishes 20+ and longer generations fail more. A donor above the cap gets an
  // INTENTIONAL TRIM: the strongest FAITHFUL_MAX_ITEMS items, renumbered, hook count updated
  // (buildPrompt writes the instruction; every count gate below validates against the TRIMMED
  // target). Skeleton mode has its own SKEL_MAX_ITEMS clamp.
  const FAITHFUL_MAX_ITEMS = Number(process.env.FAITHFUL_MAX_ITEMS ?? 13);
  const donorItemsN = srcTweets.flatMap(leadingNumbers).length;
  // Packed-donor detection (operator 2026-08-11: crammed listicles are a WINNING format — mirror
  // them). Packed = AVERAGE density >= 1.6 items per item-bearing tweet (same rule as skeleton.mjs);
  // a single stray double-marker tweet in an elaborated donor must NOT flip the thread packed (live
  // miss: an Ozempic donor with bullet elaborations classified packed and blew the 20-tweet gate).
  const _mcF = (t) => (String(t).match(/^\s*\d{1,3}[.)]\s/gm) || []).length;
  const _itemTweetsF = srcTweets.filter((t) => _mcF(t) >= 1).length;
  const FAITHFUL_DONOR_PACKED = donorItemsN >= 6 && _itemTweetsF > 0 && donorItemsN / _itemTweetsF >= 1.6;
  const _densityF = FAITHFUL_DONOR_PACKED ? donorItemsN / _itemTweetsF : 1;
  // TRIM APPLIES TO PACKED DONORS TOO (operator ruling 2026-08-11, resolving a live contradiction:
  // "mirror the donor's full list" vs the hard 20-tweet reject — 1 in 6 packed winners overflowed
  // and FAILED generation outright, burning the slot and both LLM attempts).
  // The unit being capped is BODY TWEETS, not raw items: FAITHFUL_MAX_ITEMS is a 13-BODY-TWEET
  // budget. Unpacked (1 item/tweet) -> 13 items, unchanged. Packed at ~2.9/tweet -> ~37 items in
  // those same 13 tweets, so a 41-item donor trims to its strongest 37 and lands ~19 total instead
  // of dying at 21. Capping packed donors at a flat 13 ITEMS would instead ship a 5-tweet stub.
  const _packedCap = Math.floor(FAITHFUL_MAX_ITEMS * _densityF);
  const ITEM_TARGET = Math.min(donorItemsN, FAITHFUL_DONOR_PACKED ? _packedCap : FAITHFUL_MAX_ITEMS);
  // How many of our numbered items are pasted PODS rather than donor items (see the faithfulness
  // gate below). Declared here because the splice that creates them runs far above the gate.
  let podItemsAdded = 0;
  if (ITEM_TARGET < donorItemsN) console.log(`  ↳ intentional trim: donor holds ${donorItemsN} items — writing the strongest ${ITEM_TARGET}${FAITHFUL_DONOR_PACKED ? ` (packed ~${_densityF.toFixed(1)}/tweet -> ${FAITHFUL_MAX_ITEMS} body tweets)` : ''}, hook number updated`);
  else if (FAITHFUL_DONOR_PACKED) console.log(`  ↳ packed donor: all ${donorItemsN} items fit (~${_densityF.toFixed(1)}/tweet), mirrored at donor density`);
  // Main-scope accessor (skeleton loads later; block-scoped consts below can't reach validation).
  const donorPackedNow = () => (SKEL_MODE ? !!(skeleton && skeleton.packed) : FAITHFUL_DONOR_PACKED);
  if (!srcTweets.length) throw new Error(`No tweet text found for ${recId} (check the Tweets link field)`);

  // --- Skeleton-variation setup: resolve the FORM (skeleton) + the SUBSTANCE (fact pool) ---
  let skeleton = null, factPool = [], factTexts = [];
  if (SKEL_MODE) {
    if (!TOPIC) throw new Error('skeleton mode needs --topic <t>');
    if (SKELETON === 'auto') {
      skeleton = await extractSkeleton(env, srcTweets, src);
      const id = `sk_${recId.slice(-8)}`;
      saveSkeleton({ id, ts: new Date().toISOString(), sourceRecId: recId, sourceUrl: src.url, sourceViews: src.impressions, niche: src.niche, skeleton });
      skeleton.id = id;
    } else {
      const entry = getSkeleton(SKELETON);
      if (!entry) throw new Error(`skeleton not found in library: ${SKELETON}`);
      skeleton = { ...entry.skeleton, id: entry.id };
    }
    for (const fid of FACTS) {
      try {
        const frec = await at.getRecord(THREADS, fid);
        const ft = await loadThread(at, frec);
        if (ft.srcTweets.length) { factPool.push({ recId: fid, url: frec.fields['Tweet URL'] || '', tweets: ft.srcTweets }); factTexts.push(...ft.srcTweets); }
      } catch (e) { console.warn(`fact ${fid}: ${e.message}`); }
    }
    // SKEL_MAX_ITEMS clamp (2026-08-08): skeleton borrows FORM, not size — a 39-item donor would need
    // 39+ one-per-tweet items (the inflation that once motivated packed reproduction, now removed).
    // Cap at the strongest N; the prompt writes and renumbers 1..N.
    const SKEL_MAX_ITEMS = Number(process.env.SKEL_MAX_ITEMS ?? 12);
    // Packed skeletons skip the clamp (operator 2026-08-11): packing compresses the full item count
    // into a normal thread length by itself — 39 one-liners at ~3/tweet is ~13 tweets, the winning form.
    if (!skeleton.packed && (skeleton.itemCount || 0) > SKEL_MAX_ITEMS) {
      console.log(`  ↳ itemCount clamp: donor holds ${skeleton.itemCount} items — this skeleton writes the strongest ${SKEL_MAX_ITEMS}`);
      skeleton.itemCount = SKEL_MAX_ITEMS;
    }
    console.log(`Skeleton mode: skeleton=${skeleton.id || SKELETON} · topic="${TOPIC}" · ${factPool.length} fact thread(s) · itemCount ${skeleton.itemCount}${skeleton.itemCategory ? ` · itemCategory ${skeleton.itemCategory}` : ''}`);
    // The full donor thread in the run log: review/no-create runs need the mold visible without a
    // draft (the scratchpad carries the same block on created drafts — operator request 2026-07-20).
    console.log(`\n=== FORM DONOR (full thread, ${src.url}) ===`);
    srcTweets.forEach((t, i) => console.log(`[donor ${i + 1}]\n${t}\n`));
    if (!factPool.length) throw new Error('skeleton mode needs at least one usable --facts thread (every claim must be sourced)');
  }
  // Hook-strength corpus (skeleton mode): the generated hook is scored for similarity in vocab /
  // phrasing / structure to PROVEN winner hooks (learnings/hook-bank.json). Fail-open: a missing bank
  // skips the gate (never a hard dependency); HOOK_MIN is the tunable floor (conservative default while
  // ledger hookScore data calibrates what "weak" actually is in production).
  const hookBank = SKEL_MODE ? loadHookBank() : [];
  const HOOK_MIN = Number(process.env.HOOK_MIN ?? 45);
  // Donor tweet-1 shape (computed once): does it pack the first item's marker line into the hook tweet?
  // Drives the RAW-stage reshaper, the computeIssues fidelity gate, and the repair-loop reshaper below.
  // BOTH modes (operator rule 2026-07-24, Julian "Jim Carrey" live miss): faithful donors attach the
  // first item to tweet 1 too ("Jim Carrey said:\n\n<quote>\n\n1. Action is the cure for anxiety."), so
  // ours must fold "1. ..." back into the hook. Donor-anchored, so it no-ops unless the donor attaches.
  // ...EXCEPT on a NARRATIVE donor, where the rule contradicts the marker strip a few lines below —
  // see attachRuleApplies in checks.mjs for the full case (live 2026-08-13, marcos protein donor).
  const srcAttaches = attachRuleApplies(srcTweets[0] || '', { skelMode: SKEL_MODE, format: skeleton?.format });
  if (SKEL_MODE && !hookBank.length) console.log('(no hook bank — strength gate skipped; run refresh-hook-bank.mjs)');

  if (MONETIZED) {
    // Per-thread tracked link: subid joins earnings back to this thread. NONCE (audit 2026-07-21 #6):
    // the old subid was fully deterministic (prefix+slug+recId), so two drafts from the SAME donor
    // minted the SAME subid and Levanta handed back the SAME lv_ link — revenue on that link then
    // "claimed to the newest ledger row" (the SUVaiu ambiguity class). A 4-char nonce makes every
    // draft's subid — and therefore its minted link — unique, so per-draft attribution is exact.
    const nonce = Math.random().toString(36).slice(2, 6);
    const baseSub = `${ACCOUNT.levantaSubidPrefix}-${slugify(srcTweets[0].split('\n')[0])}-${recId.slice(-6)}-${nonce}`;
    // subid2 = HOOK-FAMILY id (2026-08-17, replacing the tier- tag — that experiment never validated
    // in Levanta reports, and the views tier already rides the ledger as sourceViews, so nothing is
    // lost). The mint happens BEFORE generation, so the family anchor is the DONOR's tweet 1: every
    // fan-out sibling recreating the same donor shares this id, which is what lets revenue compare
    // "same hook family, different account/body". The EXACT shipped hook is stamped separately into
    // the ledger as hookId at draft-write time (see the ledger append), once tweet 1 finally exists.
    const subid2 = hookIdOf(srcTweets[0]) || undefined;
    // Provision each plug product on its OWN per-thread subid so revenue attributes per product. A single
    // product keeps the original subid (baseSub); a supplied second product gets a '-b' suffix.
    // A SUPPLIED link already carries a subid that was chosen when it was minted, and this function
    // cannot read it back out (lvnta ids are opaque). Stamping the generated subid anyway writes a
    // ledger row whose subid matches no link in existence: revenue still attributes, because byLvId
    // joins on the link, but the subid arm of the join silently never matches. Observed 2026-08-30
    // on a hand-minted rasmus thread. So --subid overrides for that case, and when it is absent the
    // mismatch is announced instead of being left for a revenue audit to trip over months later.
    const provision = async (p, subid1) => {
      p.subid1 = (p.link && p.suppliedSubid) || subid1; p.subid2 = subid2;
      if (p.link && !p.suppliedSubid) {
        console.log(`⚠ --link supplied without --subid: ledger will record "${p.subid1}", which is NOT the subid on that link. Revenue joins on the link id, but the subid arm will not match.`);
      }
      if (!p.link) {
        const minted = await levanta(env).mintLink(p.asin, p.subid1, p.subid2);
        // LINK SHAPE (operator finding 2026-08-11): Levanta's mobileOptimizedUrl (lvnta.com/lv_XXX)
        // serves its OWN interstitial to in-app browsers — a full-page 'Open in "Amazon"? [Cancel]
        // [Open]' tap gate (verified by fetching it with the X-for-iPhone UA). That is one extra tap
        // on EVERY mobile click, i.e. a conversion tax we chose ourselves; it is NOT an X or Amazon
        // change. minted.url is the SAME Amazon destination the interstitial forwards to, carrying
        // identical attribution (maas, tag, aa_campaignid, aa_adgroupid=<link id>, aa_creativeid, m),
        // so revenue attribution is preserved byte-for-byte.
        // TRADE-OFF (why this is per-account, not fleet-wide): Levanta's `clicks` metric counts
        // lvnta.com redirects, so a direct link likely reports 0 clicks — EPC/funnel-watch/weekly
        // reports would go blind for that account. Judge the A/B on conversions per 1k VIEWS
        // (Typefully-sourced), never on click-based EPC. Flip ACCOUNTS[x].directLink to widen.
        p.link = ACCOUNT.directLink ? (minted.url || minted.mobileOptimizedUrl || minted.mobile_optimized_url)
          : (minted.mobileOptimizedUrl || minted.mobile_optimized_url || minted.url);
        console.log(`Minted: ${p.link}  (subid1=${p.subid1}, subid2=${p.subid2})`);
        // Record the mint the moment it exists (2026-08-25): a draft that later FAILS validation
        // exits before the draft-write ledger append, and its real minted link vanished from the
        // books — two create-thread-glm runs did exactly that today. The monetized row at
        // draft-write time supersedes this one for attribution (byLvId is last-line-wins).
        appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({
          ts: new Date().toISOString(), account: ACCOUNT.name, mode: 'mint', recId,
          asin: p.asin, subid1: p.subid1, link: p.link, note: 'recreate pre-generation mint',
        }) + '\n');
      } else if (/gumroad\.com/.test(p.link) && !/[?&]ref=/.test(p.link)) {
        p.link = tagGumroad(p.link, p.subid1); // own-product attribution via ?ref
        console.log(`Tagged Gumroad link: ${p.link}`);
      }
    };
    await provision(product, baseSub);
    if (product2) await provision(product2, `${baseSub}-b`);
  }
  // The set of tracked plug links in this thread (one, or two when a second product was supplied).
  const plugLinks = MONETIZED ? [...new Set([product.link, product2?.link].filter(Boolean))] : [];
  const isPlugTweet = (t) => plugLinks.some((l) => l && t.includes(l));
  console.log(`Source: ${src.impressions.toLocaleString()} views | ${src.niche} | ${srcTweets.length} tweets | ${src.url}`);
  console.log(`Mode: ${MONETIZED ? 'monetized' : 'lightweight (client variation)'} | reference media: ${inv.summary.split('\n')[0]}\n`);

  let tweets;
  // (prior, plug) pairs the CTA judge actually PASSED (ok, not a crash-pass). Content-keyed, not
  // index-keyed, so ANY later mutation of either text (hard-trim, repair, splice shifting the prior)
  // silently drops the pair from the recorded set — only byte-identical judged pairs reach the ledger,
  // and the nightly QC skips re-judging exactly those. Fail-safe: a dropped pair = one redundant call.
  const judgeApprovedFp = new Set();
  // The move each plug's WRITER declared (writePlugs heavyMove/lightMove). FUNCTION-scoped like
  // judgeApprovedFp above and for the same reason: it is written wherever plugs get (re)written —
  // the primary write AND the substance-drift repair — and read once at the ledger stamp in the
  // create block, which is a SIBLING of the branch that writes plugs. A block-scoped declaration
  // here is exactly what crashed run-plan's first live dispatch (ReferenceError at the stamp,
  // 2026-08-17) — every monetized draft died at the finish line after generation succeeded.
  const declaredPlugMoves = [];
  // PASTE PATH state (step 6): products whose plug is pasted from the pod library. Tracked by LINK
  // rather than index because splices shift indices and links never do; every later pass that would
  // rewrite a plug (judge, substance-drift repair, bridge-prior repair) checks isPodPasted first —
  // proven copy is never LLM-rewritten.
  const podCoveredLinks = new Set();
  const podPastedTweets = new Set(); // exact pasted texts — a WRITTEN plug can share the LINK on a single-product thread
  // How many tweets the FIRST ask occupies (3 = full pod, 2 = compact, 1 = ctaOnly). The position
  // gate judges where the ask OPENS, so it needs the depth the splice actually used.
  let heavyCtaDepth = 1;
  // OUTLINE MODE's plan, declared HERE and not inside the writer's else-branch: computeIssues()
  // reads outline?.shape from the outer scope, and a block-scoped `let` made that a hard
  // ReferenceError that failed every slot on 2026-08-26 (23/23, $1.56 of tokens, zero posts).
  // Optional chaining guards a null VALUE, never an undeclared NAME.
  let outline = null;
  const podsUsed = [];
  const isPodPasted = (t) => podPastedTweets.has(String(t));
  // SLOT_MODE assembles the plugs INSIDE the writer pass (fields -> canonical block), so the plug
  // writing/splicing section below must not run — it would add a second set on top.
  let PLUGS_INLINE = false;
  if (TWEETS_FILE) {
    // LLM bypass (e.g. raw Anthropic API overloaded): use the COMPLETE hand-authored thread as-is.
    // The file is a JSON array of tweet strings incl. plugs/closing/disclaimer; {{LINK}} -> tracked link.
    tweets = JSON.parse(readFileSync(TWEETS_FILE, 'utf8')).map((t) => stripEmDash(String(t).replaceAll('{{LINK}}', product.link || '').replaceAll('{{LINK2}}', product2?.link || product.link || '')));
    console.log(`Injected ${tweets.length} hand-authored tweets from ${TWEETS_FILE} (LLM bypass)`);
  } else if (process.env.SLOT_MODE === '1' && MONETIZED && !SKEL_MODE) {
    // SLOT MODE (phase 3, the root fix — operator 2026-08-18). The writer decides NOTHING
    // structural: compileSkeleton fixes every tweet position, which item carries which criterion
    // tail, and where each plug sits; the writer fills named slots (plugs as {opener,middle,cta}
    // fields); assembleThread joins the beats, appends the disclosure and the bare link. The entire
    // body-repair chain below (renumber/split/merge/pack) is DELIBERATELY bypassed — it exists to
    // clean up after a writer that owned structure, and running it here would shift slots around
    // and re-create the drift the skeleton exists to kill. Structural problems come back as
    // per-slot issues and get ONE targeted retry; whatever survives faces the same validation
    // gates as every other mode.
    const prods = [product, product2].filter(Boolean);
    // The skeleton must be compiled from the SAME donor view the count rule describes. Clara
    // 10381407: a 20-item donor with ITEM_TARGET 13 — the donor block said "writing the strongest
    // 13" while the skeleton enumerated all 23 slots, so slots 17-23 came back missing by design.
    // Two orders, one thread, again. The trim is deterministic here (keep tweets whose first item
    // number is inside the target, plus every non-item tweet); "strongest" selection stays a
    // classic-path luxury.
    let slotDonor = srcTweets;
    const donorItemsN = srcTweets.flatMap(leadingNumbers).length;
    if (ITEM_TARGET && donorItemsN > ITEM_TARGET) {
      slotDonor = srcTweets.filter((t) => { const n = leadingNumbers(t)[0]; return n == null || n <= ITEM_TARGET; });
      console.log(`  ↳ slot skeleton trimmed to ${ITEM_TARGET} items (donor holds ${donorItemsN}) — ${srcTweets.length} -> ${slotDonor.length} donor tweets`);
    }
    const sk = compileSkeleton({ donorTweets: slotDonor, products: prods, account: ACCOUNT, moldId: MOLD_ID, convertTo: CONVERT_TO || null });
    console.log(`\n${renderSkeleton(sk)}\n`);
    const [slotBase, slotTail] = buildSlotPrompt(slotDonor, src, ACCOUNT, { skeleton: sk, products: prods, itemTarget: ITEM_TARGET });
    const slotMsgs = [{ role: 'user', content: [
      { type: 'text', text: slotBase, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: slotTail },
    ] }];
    // Clara, first slot batch: the writer returned EMPTY output once and the whole day died on
    // "no JSON object". A single blank response is an API mood, not a defect — one clean retry.
    let fills;
    for (let attempt = 1; ; attempt++) {
      const rawFills = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 6000, messages: slotMsgs });
      try { fills = parseSlotFills(rawFills); break; }
      catch (e) {
        if (attempt >= 2) throw e;
        console.warn(`  ↳ writer returned no JSON (attempt ${attempt}) — retrying once`);
      }
    }
    let asm = assembleThread(sk, fills, { products: prods });
    // Targeted retries: name the failing slots, merge the corrections, keep everything else. Two
    // rounds, because a missing plug MIDDLE was the dominant residual across two batches and one
    // round fixed it only sometimes — a plug with no middle is a cold two-line ad, and in
    // production (allow_invalid off) it costs the whole slot.
    for (let round = 1; asm.issues.length && round <= 2; round++) {
      console.log(`  ↳ slot issues (${asm.issues.length}, round ${round}): ${asm.issues.map((i) => `#${i.slot} ${i.code}`).join(', ')} — retrying those slots only`);
      const retryRaw = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 3000, messages: [{ role: 'user', content: [
        { type: 'text', text: slotBase, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `${slotTail}\n\nYOUR PREVIOUS FILLS (keep every slot not named below):\n${JSON.stringify(fills)}\n\nTHESE SLOTS FAILED — return a JSON object containing ONLY the corrected slots, complete (a plug slot needs ALL of opener, middle, cta):\n${asm.issues.map((i) => `  slot ${i.slot}: ${i.msg}`).join('\n')}` },
      ] }] }).catch((e) => { console.warn(`  ↳ slot retry failed: ${e.message}`); return null; });
      if (!retryRaw) break;
      try { fills = { ...fills, ...parseSlotFills(retryRaw) }; asm = assembleThread(sk, fills, { products: prods }); }
      catch (e) { console.warn(`  ↳ slot retry unparseable: ${e.message}`); break; }
    }
    if (asm.issues.length) console.warn(`  ↳ ${asm.issues.length} slot issue(s) survive the retries — validation decides:\n${asm.issues.map((i) => `      #${i.slot} [${i.code}] ${i.msg}`).join('\n')}`);
    tweets = asm.tweets;
    PLUGS_INLINE = true;
    const mv = fills && fills._moves && typeof fills._moves === 'object' ? Object.values(fills._moves) : [];
    if (mv.length) declaredPlugMoves.push(...mv.map(String));
    console.log(`Slot mode: ${tweets.length} tweets assembled from ${sk.totalFillable} slots (plugs inline at ${sk.slots.filter((x) => x.kind === 'plug').map((x) => x.n).join(', ')})`);
  } else {
    // OUTLINE MODE (phase 2, off by default). The single-pass writer: the product and the plug plan
    // go INTO the prompt, and the writer emits a bare {{PLUG:asin}} marker where each plug belongs
    // instead of being forbidden to know a product exists. Gated on OUTLINE_MODE=1 so the live
    // engine keeps running the proven path while the two are diffed against each other.
    const OUTLINE_MODE = process.env.OUTLINE_MODE === '1' && MONETIZED && !SKEL_MODE;
    if (OUTLINE_MODE) {
      outline = buildOutline({ donorTweets: srcTweets, products: [product, product2].filter(Boolean), account: ACCOUNT, moldId: MOLD_ID, convertTo: CONVERT_TO || null });
      console.log(`\n${renderOutline(outline)}\n`);
    }
    const pb = SKEL_MODE ? buildSkeletonPrompt(skeleton, TOPIC, factPool, ACCOUNT, srcTweets, hookBank, { hookFreedom: HOOK_FREEDOM })
      : OUTLINE_MODE ? buildOutlinePrompt(srcTweets, src, ACCOUNT, { outline, products: [product, product2].filter(Boolean), itemTarget: ITEM_TARGET })
      : MONETIZED ? buildPrompt(srcTweets, src, ACCOUNT, { itemTarget: ITEM_TARGET }) : [buildPromptLite(srcTweets, src, ACCOUNT)];
    // Block 1 = account-static (voice + rules + examples) -> prompt-cached across every slot, repair
    // and retry of this account's batch (5-min TTL); block 2 = this thread's products + source.
    const promptContent = pb.map((text, i) => (i === 0 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text }));
    const raw = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: promptContent }] });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`No JSON array returned:\n${raw.slice(0, 400)}`);
    let lastRaw = m[0];
    tweets = JSON.parse(lastRaw).map(stripEmDash); // house rule: no em dashes
    // GUARD (cheap-model safety): the raw body must contain NO links — the real tracked plugs are written
    // separately (writePlugs) and spliced in by CODE below, so any URL here is a hallucinated plug (a
    // weaker model inventing a fake product + a fake/untracked link, e.g. "example.com"). Drop those tweets
    // deterministically now — before plug-splicing and validation. No retry, no LLM. Non-numbered junk (the
    // common case) just vanishes; on the rare chance this removes a numbered lesson, the faithfulness repair
    // loop just below restores it. Model-agnostic: a no-op for well-behaved output (Claude rarely trips it).
    const preLinkN = tweets.length;
    // Also drop plug-SHAPED tweets with no URL at all — "Aff link:\n\n[LINK]" hallucinations (live
    // 2026-07-20: two such pseudo-plugs shipped scheduled; the URL-only filter never saw them). The
    // real plugs are spliced by code below, so ANY "aff link"/placeholder tweet in the raw body is fake.
    tweets = tweets.filter((t) => !/https?:\/\//i.test(t) && !/aff\s*link/i.test(t) && !PLACEHOLDER_RE.test(t));
    if (tweets.length < preLinkN) console.log(`  ↳ dropped ${preLinkN - tweets.length} hallucinated plug/link tweet(s) from the raw body (no URLs/ads allowed pre-splice)`);
    // The model mimicked the source's bullet syntax instead of the house "N." numerals — a cosmetic
    // defect that otherwise reads as 0 items and burns a whole regeneration on the faithfulness gate.
    // Restore the markers first, so every marker-aware step below (recap bulletizer, splitter, renumber,
    // plug placement) sees the true list shape. No-op unless the donor IS a numbered list and ours lost it.
    {
      const srcN = SKEL_MODE ? (skeleton.itemCount || 0) : ITEM_TARGET;
      const numeralized = numeralizeBulletItems(tweets, { srcItemCount: srcN, account: ACCOUNT });
      if (numeralized.some((t, i) => t !== tweets[i])) { console.log(`  ↳ restored "N." item markers on a bulleted body (donor has ${srcN} numbered items)`); tweets = numeralized; }
    }
    // A RECAP closer that re-lists every item as one packed numbered block (labosco 2026-07-20: a
    // 14-item thread closed "15.…28." continuing the sequence) is not a fresh run of items — bulletize
    // it so it stops counting as phantom items, and split it if it overflows 280. Runs FIRST so the
    // marker-splitter below never fans a recap block into individual phantom item tweets.
    if (SKEL_MODE) {
      const debulleted = bulletizeRecapList(tweets);
      if (debulleted.length !== tweets.length || debulleted.some((t, i) => t !== tweets[i])) { console.log(`  ↳ bulletized a packed recap list (was inflating the item count / over 280)`); tweets = debulleted; }
    }
    // An item marker fused into the previous tweet (e.g. the promise ending with "1. ...") corrupts
    // both the reading order and the plug placement — split it into its own element deterministically.
    const preSplitN = tweets.length;
    tweets = splitMergedItems(tweets);
    if (tweets.length > preSplitN) console.log(`  ↳ split ${tweets.length - preSplitN} merged item marker(s) into their own tweet(s)`);
    // NARRATIVE donors have NO numbering — strip any stray "N." marker the model invented (live
    // 2026-07-20 Jake case: a beat shipped as "7. Dr. Robert Sapolsky…"/"7. Andrew Huberman…"). Runs
    // BEFORE renumber, which would otherwise legitimize the stray marker as "1.". Keyed on the FORMAT,
    // not itemCount===0: a fresh extraction of a narrative donor sometimes returns itemCount 1-2 (a
    // couple of stray numbers the model latched onto) — still 'narrative' by the format rule, and a
    // narrative has no list, so a lone "7." must go regardless of the exact count (live 2026-07-20).
    if (SKEL_MODE && skeleton.format === 'narrative') {
      const stripped = stripItemMarkers(tweets);
      if (stripped.some((t, i) => t !== tweets[i])) { console.log('  ↳ stripped stray item marker(s) — narrative donor has none'); tweets = stripped; }
    }
    // HOOK-BLOCK grouping (operator rule 2026-07-20): a donor that packs hook + context + promise into
    // ONE first tweet ending ":" must not come back fragmented across our tweets 1-3. Deterministic
    // merge at the RAW stage (before plugs are positioned, so plugPositions sees the true shape).
    // BOTH modes (operator rule 2026-07-23: tweet 1's boundary is defined by the donor's tweet 1 —
    // one Airtable row — and is authoritative): the guard is donor-anchored via srcEndsColon, so it
    // is a no-op unless the DB-defined tweet 1 actually packs hook + context + promise into one tweet.
    if (hookBlockIssue(tweets, { srcEndsColon: /:\s*$/.test(String(srcTweets[0] || '').trim()) })) {
      const mergedHb = mergeHookBlock(tweets);
      if (mergedHb) { console.log(`  ↳ merged the split hook block into ONE first tweet (${tweets.length - mergedHb.length + 1} tweets -> 1, mirroring the donor's tweet-1 grouping)`); tweets = mergedHb; }
    }
    // ATTACHED FIRST ITEM (operator rule 2026-07-20, Austin donor): when the donor's tweet 1 is TWO
    // blocks — hook line + the first item's "N." marker line — ours must be too. Fold our first item's
    // marker line up into the hook tweet (its elaboration stays tweet 2). Runs after splitMergedItems
    // (which cleanly isolates the marker) and before renumber/plug-positioning.
    if (srcAttaches) {
      const attached = attachFirstItemToHook(tweets, { srcAttaches: true });
      if (attached.length < tweets.length || attached[0] !== tweets[0]) { console.log(`  ↳ attached the first item's marker line to the hook tweet (mirroring the donor's two-block tweet 1)`); tweets = attached; }
    }
    tweets = renumberLeadingMarkers(tweets);    // deterministic: force contiguous 1..N (kills cosmetic mis-numbering)
    // DUPLICATE ITEM (demo-3 2026-07-21): two items selling the same thing — cut the LATER duplicate's
    // span BEFORE the count repair, so a 5-with-dup roll becomes 4 distinct (target hit, no repair
    // needed) and a genuine under-count after the cut gets a DISTINCT item restored by the loop below.
    {
      const d0 = duplicateItemIssue(tweets);
      if (d0) {
        const cut = cutDuplicateItem(tweets);
        if (cut.length < tweets.length) { console.log(`  ↳ cut duplicated item (${d0})`); tweets = renumberLeadingMarkers(cut); }
      }
    }
    // RAW-stage repair: a dropped numbered item is the dominant stochastic failure (esp. long
    // listicles) — and a model FIXING ITS OWN near-miss converges far better and cheaper than the
    // fresh regeneration the outer retry does (short turn, cached prefix, the defect named exactly).
    // Runs BEFORE the expensive post-process (tighten/judge/media) so a doomed draft never gets there.
    const srcItemsN = SKEL_MODE ? (skeleton.itemCount || 0) : ITEM_TARGET; // trimmed target, not the raw donor count
    // Donor packing profile (operator 2026-08-11): packed donors are mirrored, so the one-item-per-
    // tweet gate must NOT fire on them — only unpacked donors reject multi-item tweets.
    const markerCount = (t) => (String(t).match(/^\s*\d{1,3}[.)]\s/gm) || []).length;
    const DONOR_PACKED = SKEL_MODE ? !!skeleton.packed : FAITHFUL_DONOR_PACKED;
    const DONOR_PER_TWEET = Math.max(2, Math.round(srcItemsN / Math.max(1, srcTweets.filter((t) => markerCount(t) >= 1).length)) || 2);
    for (let rep = 0; rep < 2; rep++) {
      const ourN = tweets.flatMap(leadingNumbers).length;
      const probs = [];
      if (srcItemsN >= 3 && ourN < srcItemsN) probs.push(`your array contains ${ourN} numbered items but the source has ${srcItemsN} — restore the missing lesson(s) at their original position(s)`);
      // Over-count (live 2026-07-20: matthew_labosco 28/14 doubled, CoachDanCole 5/4). The model numbered
      // lines that are NOT real items — an item's elaboration/continuation got its own "N.", or a point
      // repeated. Repairable by UNNUMBERING (safer than merging): keep all prose, drop the extra markers.
      else if (srcItemsN >= 3 && ourN > srcItemsN) probs.push(`your array has ${ourN} numbered items but the source has ONLY ${srcItemsN}. Reduce to EXACTLY ${srcItemsN}: (a) if you numbered lines that are NOT real items — a recap/summary that re-lists items you already covered, an elaboration, or a continuation — remove those markers (bullet or unnumber them); (b) if you genuinely wrote MORE distinct items than the source, delete the ${ourN - srcItemsN} least essential item(s) ENTIRELY. The remaining ${srcItemsN} items must renumber 1..${srcItemsN} as one continuous sequence`);
      const rawNi = numberingIssue(tweets);
      if (rawNi) probs.push(rawNi);
      const pk = donorPackedNow() ? null : packedItemsIssue(tweets); // packed donors are mirrored, not split
      if (pk) probs.push(`${pk} — split so every numbered item starts its OWN tweet, keeping all wording`);
      if (!probs.length) break;
      console.log(`  ↳ repair pass ${rep + 1}: ${probs.join(' | ')}`);
      const fixed = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 4096, messages: [
        { role: 'user', content: promptContent },
        { role: 'assistant', content: lastRaw },
        { role: 'user', content: `Your JSON array has defect(s): ${probs.join(' | ')}. Re-emit the COMPLETE corrected JSON array of ALL tweets — fix ONLY the defect(s), keep every other tweet exactly as it was, numbered items must run 1..${srcItemsN} as ONE continuous sequence, plugs stay unnumbered. Return ONLY the JSON array.` },
      ] });
      const fm = fixed.match(/\[[\s\S]*\]/);
      if (!fm) break;
      lastRaw = fm[0];
      tweets = renumberLeadingMarkers(JSON.parse(lastRaw).map(stripEmDash));
    }
    // Deterministic last resort for GENUINE over-generation (CoachDanCole 2026-07-20, twice): the model
    // wrote a 5th distinct item for a 4-item donor and refused to delete it even when the repair pass
    // told it to. Cut the surplus tail item(s) here — keep items 1..N and the closer — so the roll ships
    // instead of dying on the over-count gate. Also unblocks the validate-repair loop downstream (the
    // 'dropped -N' unrepairable no longer fires, so e.g. a tweet-1 lift finally gets its repair turn).
    {
      const ourNow = tweets.flatMap(leadingNumbers).length;
      if (srcItemsN >= 3 && ourNow > srcItemsN) {
        const capped = capItemCount(tweets, srcItemsN);
        if (capped.length < tweets.length) {
          console.log(`  ↳ hard item-cap: cut surplus item(s) ${srcItemsN + 1}..${ourNow} (${tweets.length - capped.length} tweet(s)) — LLM repair kept over-generating vs the donor's ${srcItemsN}`);
          tweets = renumberLeadingMarkers(capped);
        }
      }
    }
    // PACKED DENSITY RESTORED (operator 2026-08-11, reversing the 2026-08-08 retirement): crammed
    // numbered listicles are ALLOWED — they are among the pages' best performers. The Aug-8 incident
    // was broken EXECUTION (orphan markers, bare stubs, empty item 1), not the packed FORM; those
    // stay guarded by the numbering/placeholder/duplicate gates. When the DONOR packs several
    // one-line items per tweet, mirror that density in BOTH modes: atomize (splitMergedItems above
    // unpacks whatever the model produced) then regroup to the donor's items-per-tweet under the
    // 250-char budget. Unpacked donors keep one substantive item per tweet.
    if (donorPackedNow()) {
      const mc = (t) => (String(t).match(/^\s*\d{1,3}[.)]\s/gm) || []).length;
      const perTweet = SKEL_MODE ? Math.max(2, Math.round(skeleton.avgItemsPerTweet || 2))
        : Math.max(2, Math.round(srcTweets.flatMap(leadingNumbers).length / Math.max(1, srcTweets.filter((t) => mc(t) >= 1).length)) || 2);
      const atomized = [tweets[0], ...splitMergedItems(tweets.slice(1))];
      const packedTweets = renumberLeadingMarkers(packItems(atomized, { perTweet, limit: 250 }));
      if (JSON.stringify(packedTweets) !== JSON.stringify(tweets)) {
        console.log(`  ↳ packed body ~${perTweet}/tweet to mirror the donor's density (${tweets.length} -> ${packedTweets.length} tweets)`);
        tweets = packedTweets;
      }
    }
    if (MONETIZED && !PLUGS_INLINE) {
      // Plugs: written in their own small call, positioned + spliced by CODE — the generation above
      // never sees a product, so the numbered list can't lose an item to ad-interleaving.
      // (SLOT_MODE never enters: its plugs arrived assembled, disclosure and link included.)
      const heavy = product, light = product2 || product;
      const twoProducts = !!product2 && light.link !== heavy.link;
      const { heavyAfter, lightBefore: lightSlot } = plugPositions(tweets);
      // THE BONUS FRAME (operator 2026-09-02, backline only). A narrative host has no list for a
      // numbered entry line to join, and a host short enough that the never-adjacent clamp already
      // put the light plug at the end has nothing left to gain from the earlier slot — in both
      // cases the light plug takes the unnumbered "Bonus: Take X" frame and lands right after the
      // last item, before the closer. Every other host keeps the hook-derived frame at the
      // second-to-last slot (this morning's retention move). wantsBonus/bonusSlot are pure and
      // tested; this is only the wiring.
      // skeleton inherits backline's frames (FRAME_SETS), so it takes the bonus rule too.
      const useBonus = (DEFAULT_POD_SYSTEM === 'backline' || DEFAULT_POD_SYSTEM === 'skeleton') && wantsBonus(tweets, { lightBefore: lightSlot });
      const lightBefore = useBonus ? bonusSlot(tweets) : lightSlot;
      const lightFrame = useBonus ? 'bonus' : podFrame(srcTweets[0] || '');
      // BRIDGE PASS (operator law 2026-08-17): land each prior tweet's final beat on its plug's
      // substance BEFORE the plugs are written — the plug writer then sees priors that already name
      // the substance, and the reader reaches every plug pre-sold. Failure here is non-fatal: the
      // deterministic gate still decides, this pass just makes passing the normal case.
      const lightPriorIdx = lightBefore - 1 >= 0 ? lightBefore - 1 : lightBefore;
      // OUTLINE MODE: the writer placed its own {{PLUG:asin}} markers and wrote the run-up beats
      // into the body — that IS the single-pass design. Running the bridge patch pass here would
      // overwrite the writer's own criterion beats with a retrofit, undoing the whole point.
      const mIdx = (asin) => tweets.findIndex((x) => new RegExp(`^\\s*\\{\\{PLUG:${asin}\\}\\}\\s*$`).test(String(x)));
      const OUTLINE_SPLICE = process.env.OUTLINE_MODE === '1' && mIdx(heavy.asin) > 0;
      // PASTE PATH: a pod-covered product's plug is PASTED from the library, never written live.
      // OUTLINE mode reads the pod the outline already chose; the classic path asks selectPod
      // directly. The SECOND plug of a single-product thread is never pod-pasted — the same pod
      // twice IS the echo defect, so the writer varies that one instead.
      // asLight (not "light" — that name is already the light PRODUCT in this scope): the second ask
      // renders point -> plug with no bridge. The criterion argument was made by the heavy plug
      // earlier in the same thread, and repeating it is what made the second ask read as an ad break.
      const podInfoFor = (prod, viaOutline, asLight = false) => {
        if (!prod) return null;
        if (viaOutline) return (outline?.plugs || []).find((b) => b.product?.asin === prod.asin)?.pod || null;
        const frame = asLight ? lightFrame : podFrame(srcTweets[0] || '');
        const { pod } = selectPod(prod, { account: ACCOUNT.key, frame });
        const r = pod ? renderPod(pod, ACCOUNT.key, '{{LINK}}', { frame, light: asLight }) : null;
        // AND-ed with the RENDER's shape, not the pod's flag alone (2026-09-09): a pod may carry
        // 2-tweet variants in one system and a 3-tweet one in another, and podsSelfContained below
        // turns on this field.
        // `r.system` is the arm that ANSWERED (skeleton falls back to backline per SYSTEM_FALLBACK when a
        // pod has no skeleton variant yet), so the ledger stamp is the truth, not the requested default.
        return r ? { id: pod.id, frame, twoTweet: r.twoTweet, tweets: r.tweets, requiresHostMention: !!pod.requiresHostMention && r.twoTweet, move: pod.move, system: r.system || DEFAULT_POD_SYSTEM } : null;
      };
      const heavyPod = podInfoFor(heavy, !!outline);
      let lightPod = twoProducts ? podInfoFor(light, !!outline, true) : null;
      if (!twoProducts && heavyPod && !OUTLINE_SPLICE) {
        // Single-product thread: the second ask pastes too when the library holds a DIFFERENT pod
        // for this product on a DIFFERENT move (selectAltPod). Same copy twice measured 1.2% CVR
        // against 3.5% for two distinct arguments — and the alternative was the writer improvising
        // a second ad next to proven copy, which the first live smoke showed at its worst.
        const alt = selectAltPod(light, { id: heavyPod.id, move: heavyPod.move }, { account: ACCOUNT.key, frame: lightFrame });
        const rAlt = alt ? renderPod(alt, ACCOUNT.key, '{{LINK}}', { frame: lightFrame, light: true }) : null;
        if (rAlt) lightPod = { id: alt.id, frame: rAlt.frame, twoTweet: rAlt.twoTweet, tweets: rAlt.tweets, requiresHostMention: !!alt.requiresHostMention && rAlt.twoTweet, move: alt.move, system: rAlt.system || DEFAULT_POD_SYSTEM };
      }
      // STAMP THE SYSTEM (2026-08-30). Two pod libraries now ship side by side — `framed` (five
      // frames, one shared template) and `classic` (one body, a wording per account) — and the whole
      // reason for keeping both is to find out which converts. Without this field on the ledger row
      // that question is unanswerable after the fact: the copy is pasted into the draft and the pod
      // it came from is not recoverable from the text. One string is the difference between an A/B
      // and two months of threads nobody can attribute.
      if (heavyPod) { podCoveredLinks.add(heavy.link); podsUsed.push({ id: heavyPod.id, asin: heavy.asin, system: heavyPod.system }); }
      if (lightPod) { podCoveredLinks.add(light.link); podsUsed.push({ id: lightPod.id, asin: light.asin, system: lightPod.system }); }
      if (heavyPod || lightPod) console.log(`  ↳ PASTED from pod: ${[heavyPod && `${heavyPod.id} (heavy, ${heavyPod.tweets.length}t)`, lightPod && `${lightPod.id} (light, ${lightPod.tweets.length}t)`].filter(Boolean).join(', ')}`);
      // A 3-tweet pod carries its own POINT and BRIDGE, so the bridge-prior pass has nothing to add
      // for it; a 2-tweet pod (requiresHostMention) still wants the HOST prior landed on its
      // substance, so the pass runs. Skipped only when every plug slot is a self-contained pod.
      const podsSelfContained = !!heavyPod && !heavyPod.requiresHostMention && (!twoProducts || (!!lightPod && !lightPod.requiresHostMention));
      if (!OUTLINE_SPLICE && !podsSelfContained) try {
        const priors = await writeBridgePriors(env, ACCOUNT, {
          heavy: { prior: tweets[heavyAfter], product: heavy },
          light: { prior: tweets[lightPriorIdx], product: light },
        });
        const okPrior = (t) => typeof t === 'string' && t.trim() && effLen(stripEmDash(t)) <= 280;
        const hOk = okPrior(priors.heavy), lOk = okPrior(priors.light);
        if (hOk) tweets[heavyAfter] = stripEmDash(priors.heavy);
        if (lOk) tweets[lightPriorIdx] = stripEmDash(priors.light);
        console.log(`  ↳ bridge priors: heavy ${hOk ? 'landed' : `REJECTED (${effLen(stripEmDash(priors.heavy || ''))} chars)`}, light ${lOk ? 'landed' : `REJECTED (${effLen(stripEmDash(priors.light || ''))} chars)`}`);
      } catch (e) { console.warn(`  ↳ bridge-prior pass failed: ${e.message} — plugs will bridge as best they can`); }
      const hPrior = OUTLINE_SPLICE ? tweets[mIdx(heavy.asin) - 1] : tweets[heavyAfter];
      const lPrior = OUTLINE_SPLICE && light && mIdx(light.asin) > 0 ? tweets[mIdx(light.asin) - 1] : (tweets[lightBefore - 1] ?? tweets[lightBefore]);
      // Which plug slots still need the WRITER? The single-product outline emits one marker, so its
      // second slot does not exist; everywhere else the light slot is real. A covered slot costs no
      // LLM call at all — that is the point of the library.
      const needH = !heavyPod;
      const needL = twoProducts ? !lightPod : (!OUTLINE_SPLICE && !lightPod);
      let plugs = null;
      if (needH && needL) {
        plugs = await writePlugs(env, ACCOUNT, heavy, light, twoProducts, hPrior, lPrior, CTA_STYLE, { avoidMoves: recentMoves, thread: tweets });
        // ECHO RE-ROLL (operator 2026-08-12): two plugs in the same thread reading as the same ad
        // twice is what makes a monetized thread feel like an ad break. Advisory by design — if the
        // retry still echoes we ship it, because a slightly echoey plug earns and a blocked draft
        // does not. Only meaningful when the writer wrote BOTH plugs.
        const echo = plugEchoIssue(plugs.heavy, plugs.light, { style: CTA_STYLE });
        if (echo) {
          console.log(`  ↳ plugs echoed (${echo}) — re-rolling once`);
          const retry = await writePlugs(env, ACCOUNT, heavy, light, twoProducts, tweets[heavyAfter], tweets[lightBefore - 1] ?? tweets[lightBefore], CTA_STYLE, { avoidEcho: echo, avoidMoves: recentMoves, thread: tweets }).catch(() => null);
          const stillEcho = retry ? plugEchoIssue(retry.heavy, retry.light, { style: CTA_STYLE }) : 'retry failed';
          if (retry && !stillEcho) plugs = retry;
          else console.log(`  ↳ retry still echoed (${stillEcho}) — shipping the better of the two`);
        }
      } else if (needH || needL) {
        // One slot covered, one not: write ONLY the uncovered product (single-product call shape);
        // its copy and move arrive in the .heavy fields.
        const prod = needH ? heavy : light;
        const prior = needH ? hPrior : lPrior;
        plugs = await writePlugs(env, ACCOUNT, prod, prod, false, prior, prior, CTA_STYLE, { avoidMoves: recentMoves, thread: tweets });
      } else if (heavyPod && lightPod) {
        // Both pasted: cross-pod echo is a library-composition question, not a re-roll — warn only.
        const e2 = plugEchoIssue(heavyPod.tweets[heavyPod.tweets.length - 1], lightPod.tweets[lightPod.tweets.length - 1], { style: CTA_STYLE });
        if (e2) console.warn(`  ↳ pasted pods echo each other (${e2}) — consider different pods/variants for this pairing`);
      }
      declaredPlugMoves.length = 0; // this write wins — stale moves from any earlier pass never leak
      declaredPlugMoves.push(heavyPod ? heavyPod.move : plugs.heavyMove);
      if (twoProducts || !OUTLINE_SPLICE) declaredPlugMoves.push(lightPod ? lightPod.move : (needH && needL ? plugs.lightMove : plugs.heavyMove));
      if (heavyPod && lightPod) console.log(`  ↳ second ask pasted from a different pod: ${lightPod.id} (${lightPod.move}) — no writer call at all`);
      const heavyIns = heavyPod ? podFill(heavyPod.tweets, heavy.link) : [stripEmDash(plugs.heavy)];
      heavyCtaDepth = heavyIns.length;
      const lightIns = lightPod ? podFill(lightPod.tweets, light.link) : (plugs ? [stripEmDash(needH && needL ? plugs.light : plugs.heavy)] : null);
      if (heavyPod) for (const t of heavyIns) podPastedTweets.add(t);
      if (lightPod) for (const t of lightIns) podPastedTweets.add(t);
      const podHeads = []; // 1-based head positions of PASTED pods, for listicle numbering
      if (OUTLINE_SPLICE) {
        // Replace the writer's markers in place. A dropped marker falls back to the positional
        // insert so a plug is never lost; the unfilled-marker case cannot ship regardless, because
        // PLACEHOLDER_RE now catches {{PLUG:...}} at the validation gate.
        const fill = { [heavy.asin]: heavyIns, ...(light && twoProducts && lightIns ? { [light.asin]: lightIns } : {}) };
        const res = splicePlugMarkers(tweets, fill);
        tweets = res.tweets;
        console.log(`  ↳ outline splice: ${res.spliced.map((h) => `${h.asin}@${h.at}${h.count > 1 ? `x${h.count}` : ''}`).join(', ') || '(none)'}${res.missing.length ? ` · marker MISSING for ${res.missing.join(',')} — positional fallback` : ''}`);
        for (const asin of res.missing) {
          const text = fill[asin];
          if (text) tweets.splice(Math.min(heavyAfter + 1, tweets.length - 2), 0, ...[].concat(text));
        }
        if (outline?.shape !== 'roundup') for (const sp of res.spliced) {
          const podInfo = sp.asin === heavy.asin ? heavyPod : lightPod;
          // ctaOnly = a donor-ad hijack: the lone ask sits inside the donor's own item and must
          // never be numbered as a new list member.
          if (podInfo && !podInfo.ctaOnly) podHeads.push({ at: sp.at, frame: podInfo.frame });
        }
      } else {
        tweets.splice(heavyAfter + 1, 0, ...heavyIns);
        if (heavyPod) podHeads.push({ at: heavyAfter + 2, frame: heavyPod.frame });
        // The light insert index absorbs however many tweets the heavy insert added (the old
        // hardcoded +1 assumed exactly one), landing right BEFORE the final numbered lesson.
        tweets.splice(lightBefore + heavyIns.length, 0, ...lightIns);
        if (lightPod) podHeads.push({ at: lightBefore + heavyIns.length + 1, frame: lightPod.frame });
      }
      // In a numbered listicle the pasted pods join the list as numbered members and the hook's
      // promised count moves with them (operator 2026-08-23: "cta 1 didn't have the numbering").
      // numberPastedPods no-ops on non-listicles and never numbers the unnumbered frames (answer, bonus).
      if (podHeads.length) {
        const np = numberPastedPods(tweets, podHeads);
        tweets = np.tweets;
        if (np.added) console.log(`  ↳ ${np.added} pasted pod(s) numbered into the list, later items renumbered`);
        podItemsAdded += np.added;   // the faithfulness gate has to know these are OURS, not drift
      }
      for (const l of plugLinks) tweets = ensureDisclosure(tweets, l);  // every plug carries "Aff link"
      tweets = await tightenLong(tweets, env, ACCOUNT); // fix any >280 (incl. added disclosure)
      for (const l of plugLinks) tweets = ensureDisclosure(tweets, l);  // re-assert: the tightener may have dropped the line
      tweets = await tightenLong(tweets, env, ACCOUNT); // no-op unless re-asserting pushed a plug over 280
      // CTA self-check AT GENERATION (checklist §4): every plug must bridge its prior tweet + sound
      // personal. Catch + rewrite weak plugs here instead of waiting for tomorrow's QC pass.
      // The judges run in PARALLEL (the two plugs are independent — each is judged against its own
      // prior content tweet), saving ~30-40s/thread vs the old serial loop on slower/cheaper models.
      // Pasted pods are proven copy — the judge never rewrites them (and skipping saves the calls).
      const plugIdxs = tweets.map((t, i) => (isPlugTweet(t) ? i : -1)).filter((i) => i >= 0 && !isPodPasted(tweets[i]));
      const verdicts = await Promise.all(plugIdxs.map((i) => judgePlug(env, ACCOUNT, tweets[i - 1] || '', tweets[i], CTA_STYLE)));
      plugIdxs.forEach((i, k) => {
        const v = verdicts[k];
        if (!v.ok && v.rewrite) {
          // Accept a judge rewrite ONLY if its SHAPE is sound (3 sentence lines + disclosure + link,
          // one per line). Test-1 live failure 2026-07-20: a rewrite merged all three lines into one
          // paragraph and stacked a second disclosure — a structurally broken "fix" is worse than the
          // original semantic miss, which QC re-judges tonight anyway.
          const rw = normalizePlugStructure(stripEmDash(v.rewrite));
          const link = plugLinks.find((l) => tweets[i].includes(l));
          if ((!link || rw.includes(link)) && plugStructure(rw, link || plugLinks[0] || '').ok) { tweets[i] = rw; console.log(`  ↳ CTA #${i + 1} rewritten at generation (${v.reason})`); }
          else console.log(`  ↳ CTA #${i + 1} judge rewrite REJECTED (broken shape) — keeping original (${v.reason})`);
        }
        else if (v.ok === true) judgeApprovedFp.add(plugFingerprint(tweets[i - 1] || '', tweets[i])); // real pass only — a rewrite is applied unjudged
        // An unread judge is not a pass: no fingerprint, so tonight's QC re-judges it and flags it for a human.
        else if (v.unjudged) console.log(`  ↳ CTA #${i + 1} judge unread (${v.reason}) — not fingerprinted, left for QC`);
      });
      // Deterministic structure normalizer: canonicalize each plug's SHAPE (a leaked bullet, a triple blank
      // line, the disclosure stacked on the link) so a cosmetic slip the judge tolerated never leaks into the
      // nightly QC 'spacing'/'disclosure-stack' signal. Mechanical only — never touches the claims/superlative.
      for (let i = 0; i < tweets.length; i++) if (isPlugTweet(tweets[i]) && !isPodPasted(tweets[i])) tweets[i] = normalizePlugStructure(tweets[i]);
      // Deterministic safety net: if a plug is STILL over budget after the LLM tighten/judge passes,
      // hard-trim it so a valid tracked plug ships rather than the slot dying on a length miss.
      for (let i = 0; i < tweets.length; i++) {
        if (isPodPasted(tweets[i])) continue; // library lengths are pre-validated; never trim proven copy
        if (isPlugTweet(tweets[i]) && plugTextLen(tweets[i]) > PLUG_LIMIT) {
          const before = plugTextLen(tweets[i]);
          tweets[i] = hardTrimPlug(tweets[i]);
          console.log(`  ↳ plug #${i + 1} hard-trimmed ${before}→${plugTextLen(tweets[i])} chars (LLM tighten left it over ${PLUG_LIMIT})`);
        }
      }
      // Deterministic last-resort for CONTENT tweets a hair over 280 after both LLM tightens: drop
      // whole trailing SENTENCES — never mid-sentence words (a mid-cut can strand a clause or invert
      // a negated claim). Accept only a clean sentence-final result; otherwise the draft fails to the
      // retry as before. URL tweets are never trimmed.
      for (let i = 0; i < tweets.length; i++) {
        if (isPlugTweet(tweets[i]) || hasUrl(tweets[i])) continue;
        const l0 = effLen(tweets[i]);
        if (l0 > 280 && l0 <= 295) {
          let t = tweets[i];
          while (t && effLen(t) > 280) {
            const cut = t.replace(/\s*[^.!?\n]+[.!?]*\s*$/, ''); // strip the final sentence/fragment
            t = cut === t ? null : cut;
          }
          t = (t || '').trim();
          if (t && effLen(t) <= 280 && t.length >= 40 && /[.!?:"”)]$/.test(t)) {
            tweets[i] = t;
            console.log(`  ↳ tweet #${i + 1} sentence-trimmed ${l0}→${effLen(t)} chars`);
          }
        }
      }
      if (signOffOf(ACCOUNT)) tweets.push(ACCOUNT.closing); // optional sign-off: some accounts omit it, and laws.json signOff can retire it fleet-wide
      tweets.push(ACCOUNT.disclaimer); // disclaimer = literal last tweet
    } else if (PLUGS_INLINE) {
      // SLOT MODE lands here (its plugs arrived assembled, so the big monetized block above stood
      // down) — but it is still a MONETIZED thread and owes the same finishing. The first slot batch
      // fell through to the non-monetized else below: closing pushed, DISCLAIMER never pushed, and
      // every thread hit validate-repair with "last tweet is not the disclaimer | missing sign-off".
      tweets = await tightenLong(tweets, env, ACCOUNT);
      for (let i = 0; i < tweets.length; i++) if (isPlugTweet(tweets[i])) tweets[i] = normalizePlugStructure(tweets[i]);
      // Same deterministic net the classic path has always had: 5 of 8 first-batch slot plugs
      // shipped at 282-319 chars because the assembler FLAGS over-limit but deliberately never
      // rewrites prose, and the one targeted retry did not always trim enough. A tracked plug a few
      // words shorter beats a slot dying on a length miss.
      for (let i = 0; i < tweets.length; i++) {
        if (isPlugTweet(tweets[i]) && plugTextLen(tweets[i]) > PLUG_LIMIT) {
          const before = plugTextLen(tweets[i]);
          tweets[i] = hardTrimPlug(tweets[i]);
          console.log(`  ↳ plug #${i + 1} hard-trimmed ${before}→${plugTextLen(tweets[i])} chars`);
        }
      }
      if (signOffOf(ACCOUNT)) tweets.push(ACCOUNT.closing);
      tweets.push(ACCOUNT.disclaimer);
    } else {
      tweets = await tightenLong(tweets, env, ACCOUNT);
      if (signOffOf(ACCOUNT)) tweets.push(ACCOUNT.closing);
    }
  }

  // Self-QRT insertion — after full assembly so the URL can't be dropped by the pre-splice URL gate
  // or the tighten passes. Skips a placement rather than overflow (tweet 1 only if it stays <=280).
  let selfQrtPlaced = [];
  if (SELF_QRT_URL) {
    // NATIVE QRT (operator 2026-08-10): text stays clean — quote_post_url is attached per-post at the
    // createDraft build below (tweet 1 + the echo, matched by prefix so index drift can't misplace it).
    const r = selfQrtInsert(tweets, { topics: SELF_QRT_TOPICS, disclaimer: ACCOUNT.disclaimer || null });
    tweets = r.tweets; selfQrtPlaced = r.placed;
    console.log(`Self-QRT (native quote_post_url): ${SELF_QRT_URL} -> ${selfQrtPlaced.join(' + ')}`);
  }

  // Final deterministic dash sweep BEFORE validation/QC: the LLM tighten/judge passes above can
  // reintroduce an em/en dash after the earlier per-string strips, so normalize the whole thread once
  // here. This ships clean output (QC never has to normalize) and keeps the em-dash family out of the
  // nightly signals rather than re-asserting an already-failing prose rule. The disclaimer/closing are
  // skipped: validate() matches them by STRICT equality, so transforming them would convert a cosmetic
  // dash into a hard "last tweet is not the disclaimer" failure if boilerplate ever gains a dash.
  const isBoiler = (t) => t === ACCOUNT.disclaimer || t === ACCOUNT.closing;
  tweets = tweets.map((t) => (isBoiler(t) ? t : stripEmDash(t)));
  tweets = withSiteCta(tweets, ACCOUNT); // account's own-site line, before the sign-off (no-op without siteCta)
  // SPACING normalizer (deterministic, model-agnostic): Julian's scannability rule is one thought per
  // line with a BLANK line between. Cheap models (GLM) routinely stack lines with single \n despite the
  // voice rules; Claude rarely does. Convert single line breaks to blank-line breaks on CONTENT tweets
  // (plugs are already shaped by normalizePlugStructure; boilerplate is matched by strict equality), and
  // only keep the spaced version when it still fits 280 — never trade spacing for a length violation.
  // Skipped on --tweets-file (hand-authored threads ship as-is).
  // normalizeLineBreaks is paragraph-aware: real line breaks get one blank line (the scannability
  // rule), but a single sentence WRAPPED across two lines is rejoined with a space instead of being
  // double-spaced into two orphaned-looking lines ("Build the right routine,\n\nand skin settles
  // down."). Prefer the full blank-line spacing; if that pushes the tweet over 280, fall back to the
  // single-newline form (still rejoined, tighter) so a fitting tweet never inflates into a split.
  if (!TWEETS_FILE) tweets = tweets.map((t) => {
    if (isBoiler(t) || isPlugTweet(t)) return t;
    // A tweet with NO newline at all used to be skipped here — the wall-of-text hole (operator
    // 2026-08-08, deal-breaker): respaceWall first breaks it into sentence paragraphs; tweets
    // that already carry breaks keep the normalizeLineBreaks path unchanged.
    const w = /\n/.test(t) ? t : respaceWall(t);
    if (!/\n/.test(w)) return t; // single-sentence tweet — nothing to space
    const spaced = normalizeLineBreaks(w, '\n\n');
    if (effLen(spaced) <= TWEET_LIMIT) return spaced;
    const tight = normalizeLineBreaks(w, '\n');
    return effLen(tight) <= TWEET_LIMIT ? tight : spaced; // still over -> keep blank-line form for the splitter
  });
  // ...and unstack the pairs the respacer above cannot reach (operator 2026-08-25). It skips plug
  // tweets outright and only fires on a tweet with NO line break, so a two-sentence block sitting
  // inside an already-spaced tweet sails past it — which is where every plug MIDDLE lives ("300mg
  // of the glycinate an hour before bed since spring. I fall asleep faster..."). Plugs included
  // here; only the verbatim hook and the account boilerplate are left alone. Skips any tweet the
  // split would push over the limit rather than inflating it into a thread-lengthening split.
  if (!TWEETS_FILE) tweets = tweets.map((t, i) => {
    if (i === 0 || isBoiler(t)) return t;
    const u = unstackParagraphs(t);
    return u !== t && effLen(u) <= TWEET_LIMIT ? u : t;
  });
  // Deterministic overlong-content SPLITTER: a CONTENT tweet (not a plug, not boilerplate, no link) that
  // runs over 280 but is built from multiple blank-line-separated blocks — the recurring skeleton-mode case
  // where the model merges the closer into the last numbered item — is split at paragraph boundaries into
  // consecutive tweets, each <= 280, greedily packing blocks in order. The LLM tighten can only SHORTEN,
  // not split, so this is what rescues a merged last-item+closer instead of failing the length gate. It
  // preserves every block and every leading item marker (only the first sub-tweet keeps the "N." marker),
  // so item count is unchanged. A single block still over 280 is left for the tighten/gate. Skipped on
  // --tweets-file (hand-authored ships as-is).
  if (!TWEETS_FILE) {
    const split = [];
    for (let i = 0; i < tweets.length; i++) {
      const t = tweets[i];
      // Tweet 1's boundary comes from the donor's tweet 1 in Airtable and is AUTHORITATIVE — the hook
      // is never mechanically split. An overlong hook goes to the LLM tighten, which shortens WITHIN
      // the boundary; fragmenting tweet 1 is the single most damaging split failure.
      if (i === 0 || isBoiler(t) || isPlugTweet(t) || hasUrl(t) || effLen(t) <= TWEET_LIMIT) { split.push(t); continue; }
      split.push(...splitLongTweet(t, { limit: TWEET_LIMIT })); // orphan-safe: never a tiny final fragment
    }
    tweets = split;
  }
  console.log('=== RECREATION ===\n');
  tweets.forEach((t, i) => console.log(`[${i + 1}] (${effLen(t)} chars)\n${t}\n`));
  // THE PASTED PODS ARE ITEMS TOO (2026-08-28, found by the fifth live engine run).
  // numberPastedPods deliberately joins each pasted pod to the numbered list and moves the hook's
  // promised count with it — the operator's own call, 2026-08-23. The faithfulness gate then counted
  // those two extra markers as OUR over-generation and failed every single monetized listicle:
  // Julian 11/9, Rafael 8/6, both exactly +2 with exactly 2 numbered pods. The reference has to
  // include them, or the gate is measuring the design instead of the drift.
  const srcItems = (SKEL_MODE ? (skeleton.itemCount || 0) : ITEM_TARGET) + podItemsAdded;
  const computeIssues = () => {
    // WARM SLOT (operator 2026-08-25): a plug the outline placed in the donor's own ad span is
    // judged on the DONOR's surviving run-up. Stamp the product row BEFORE validation so the
    // criterion-order hard gate and the advisory warns below read the same truth.
    for (const p of [product, product2]) {
      if (p && (outline?.plugs || []).some((b) => b.donorAdSpan && b.product?.asin === p.asin)) p.donorSlot = true;
    }
    const iss = validateDraft(tweets, plugLinks, ACCOUNT, MONETIZED, [product, product2].filter((p) => p && (p.link || p.asin)), { shape: outline?.shape || null, ctaDepth: heavyCtaDepth });
    // Faithfulness gate: don't ship fewer numbered items than the reference had (source, or the skeleton's
    // itemCount in skeleton mode) — the 40/42 drop class.
    const ourItems = tweets.flatMap(leadingNumbers).length;
    if (srcItems >= 3 && ourItems < srcItems) iss.push(`dropped ${srcItems - ourItems} item(s) vs reference (${ourItems}/${srcItems})`);
    // Over-count is as wrong as under-count (test-2 2026-07-20: the donor's 3 items became 4 with a
    // duplicated point) — unrepairable here (merging items risks meaning), falls to the outer retry.
    if (srcItems >= 3 && ourItems > srcItems) iss.push(`dropped -${ourItems - srcItems} item(s) vs reference (${ourItems}/${srcItems} — EXTRA items/duplicates)`);
    // Duplicated item NAME (demo-3 class): count-valid threads can still sell the same thing twice.
    const pki = donorPackedNow() ? null : packedItemsIssue(tweets); // packed donors ship packed (operator 2026-08-11)
    if (pki) iss.push(pki);
    const dii = duplicateItemIssue(tweets);
    if (dii) iss.push(dii);
    // SKELETON anti-duplication gate: no run of 7+ words shared verbatim with the skeleton source OR any
    // (operator call 2026-07-17: a shared 6-word run is FINE — only 7+ is the "copied text" pattern) —
    // fact-pool thread (the exact "copied text, lightly edited" pattern X now down-ranks). Product names,
    // the disclaimer, and bare numbers are allowlisted so plugs/dosages don't false-flag; only prose lifts.
    // Plug copy ↔ product consistency (live 2026-07-21, published 7Coxfv8): a plug's COPY must sell
    // the product its OWN link goes to — plug 1 sold "ashwagandha" while its link went to Omega-3.
    // Each plug is matched to its product by link, so two-product threads check correctly. Repairable
    // (the plug-rewrite branch below re-runs writePlugs).
    if (MONETIZED) {
      for (let i = 0; i < tweets.length; i++) {
        const own = [product, product2].filter(Boolean).find((pr) => pr.link && tweets[i].includes(pr.link));
        if (!own) continue;
        const mm = plugSubstanceMismatch(tweets[i], own.title);
        if (mm) iss.push(`${mm} (plug #${i + 1})`);
      }
    }
    // Anti-verbatim gate — SKELETON MODE ONLY (operator rule 2026-08-01: restored the proven ~95%
    // repost-winners template for faithful mode). Faithful mode's near-verbatim hook + LIGHTLY-reworded
    // body INTENTIONALLY share long runs with the source — that IS the proven template — so the 7+-word
    // gate must NOT fire on it. It stays on for skeleton mode (new content on a proven form, where a
    // verbatim lift from the fact pool is a genuine defect). Content was flopping under the ~85% heavy
    // rewrite; this revert accepts X's duplicate-detection risk until a better solution lands.
    if (SKEL_MODE) {
      const allow = [product.title, product2?.title, shortName(product.title || ''), shortName(product2?.title || ''), ACCOUNT.disclaimer, ACCOUNT.closing].filter(Boolean);
      const ng = sharedNgramIssue(tweets, [...srcTweets, ...factTexts], { allow });
      if (ng) iss.push(`skeleton lift: ${ng}`);
    }
    if (SKEL_MODE) {
      // Mold gate (operator rule 2026-07-19): line 1 must visibly come from the donor's mold — similar
      // character count (±20% of the source's line 1) and the template's scaffold words kept in order.
      // Freedom mode: the mold gate steps aside (the hook is a remix by design); the strength floor
      // below then gates UNCONDITIONALLY — without the mold, the donor no longer vouches for the hook.
      const hm = HOOK_FREEDOM ? null : hookMoldIssue(tweets[0] || '', { template: skeleton.hookFirstLine || '', srcLine1: (srcTweets[0] || '').split('\n')[0], srcLine1Len: skeleton.hookLine1Len || 0 });
      if (hm) iss.push(hm);
      // Hook-block grouping gate (operator rule 2026-07-20): the donor's packed first tweet (ending
      // ":") must stay ONE tweet in ours. Normally fixed deterministically at the RAW stage; firing
      // here means the merge couldn't fit 280 — repairable below (mergeHookBlock retried after other
      // fixes shorten things), else the outer retry regenerates with the grouping rule in the prompt.
      const hb = hookBlockIssue(tweets, { srcEndsColon: /:\s*$/.test(String(srcTweets[0] || '').trim()), plugLinks });
      if (hb) iss.push(hb);
      // Attached-first-item gate (Austin donor 2026-07-20): if the donor's tweet 1 packs its first item's
      // marker line, ours must too. Normally fixed deterministically at the RAW stage; firing here means
      // the merge couldn't fit 280 or the marker never landed — repairable below, else the outer retry.
      const ha = hookAttachIssue(tweets, { srcAttaches });
      if (ha) iss.push(ha);
      // Hook-strength floor: the hook must LOOK like the winners (vocab/phrasing/structure similarity to
      // the proven-hook bank). sharedNgramIssue caps similarity from above; this gates it from below.
      // MOLD-PASS WAIVER (test-1 finding 2026-07-20): a hook that faithfully clones the donor's mold IS
      // proven-strong — the donor is a >=750k winner — even when that donor's style shares nothing with
      // the bank corpus (phrasing scored 0 and blocked a form-perfect hook). The floor only gates hooks
      // that ALSO drifted off-mold; the score is still computed + ledgered for calibration either way.
      const hs = hookBank.length ? hookStrength(tweets[0] || '', hookBank) : null;
      if (hs && hs.score < HOOK_MIN && (hm || HOOK_FREEDOM)) iss.push(`weak hook ${hs.score}/100 (floor ${HOOK_MIN}: vocab ${hs.vocab} · phrasing ${hs.phrasing} · structure ${hs.structure})`);
    }
    // Hook LENGTH fidelity (operator 2026-07-24) — BOTH modes: the rewritten hook must not read LONGER
    // than the donor's, or it turns clumsy and hard to scan. One-sided (bloat only); the attached "N."
    // item is excluded. Skeleton's ±20% line-1 mold gate above covers line 1; this covers the whole
    // hook block (setup + quote). Repairable below by shortening toward the donor's length.
    { const htl = hookTooLong(tweets[0] || '', srcTweets[0] || '', { srcAttaches, tolerance: 0.15 }); if (htl) iss.push(htl); }
    // Hook 90-95%, never 100% (operator 2026-08-17): keep the donor's shape and punch, but a
    // byte-identical hook against a post with millions of views is an exact-match string for X's
    // duplicate detection. Faithful mode only — a skeleton hook is a remix by construction.
    // 85-90% band, shape-aware (operator 2026-08-17): byte-identical was only the floor. A hook that
    // differs by two swapped words is still a near-identical string, so the gate now measures word
    // overlap AND the sentence shape the hook scans on. The attached "1." item line is excluded —
    // item 1 belongs to the thread, not the donor.
    if (!SKEL_MODE) { const hid = hookFidelityIssue(tweets[0] || '', srcTweets[0] || '', { srcAttaches, swapPromise: !!CONVERT_TO }); if (hid) iss.push(hid); }
    // Every plug's PRIOR tweet must hand the reader a buying criterion — the form, the
    // standardisation, what to avoid. Warn rather than block: the detector reads for form words and
    // contrast phrasing, and a good beat can be written in wording it does not recognise. A false
    // block on a revenue plug costs more than a missed warning.
    // (plugPositions returns {heavyAfter, lightBefore} for the SPLICE — locating the already-spliced
    // plugs is done by their links. Iterating that object crashed the first OUTLINE_MODE run.)
    {
      const links = [product?.link, product2?.link].filter(Boolean);
      const plugIdxs = tweets.map((t, i) => (links.some((l) => String(t).includes(l)) ? i : -1)).filter((i) => i > 0);
      for (const pi of plugIdxs) {
        const p = product2?.link && tweets[pi].includes(product2.link) ? product2 : product;
        // Without the donorSlot flag these warns fire on every hijack, which teaches the reader
        // to ignore them — the one thing an advisory must never do.
        const d = discriminationIssue(tweets, pi, p, { donorSlot: !!p.donorSlot, pod: podCoveredLinks.has(p.link) });
        if (d) console.warn(`  ⚠ ${d}`);
        // Same reason as the donorSlot flag above: a pod's first tweet withholds the substance on
        // four of its five frames BY DESIGN, so without this every podded plug warns and the
        // advisory teaches itself to be ignored. See runUpIssue's `pod` exemption.
        const ru = runUpIssue(tweets, pi, p, { donorSlot: !!p.donorSlot, pod: podCoveredLinks.has(p.link) });
        if (ru) console.warn(`  ⚠ ${ru}`);
      }
    }
    // Item 1 must be an INSTANCE of what the hook promised. Once the outline points item 1 at the
    // product this is the failure that appears: "Here are 7 SIGNS your cortisol is wrecking you:
    // 1. KSM-66 ashwagandha, 600mg" — a supplement is not a sign, and the thread reads as an ad from
    // its first line. Prescriptive lists ("ways", "things") take the product happily; diagnostic ones
    // need the OBSERVATION, with the substance arriving in the bridge instead.
    {
      const firstItem = (String(tweets[0] || '').split(/\n{2,}/).at(-1) || '');
      const fif = firstItemFormIssue(tweets[0] || '', firstItem, { products: [product, product2].filter(Boolean) });
      if (fif) iss.push(fif);
    }
    // Revenue gate: every monetized plug link must be TRACKED, else clicks attribute to nothing —
    // the #1 goal silently fails. "Tracked" is isTrackedLink's definition, the same one every audit
    // uses: lvnta short link, gumroad ?ref, OR the Amazon Attribution rail (maas + aa_adgroupid) —
    // this gate predated the direct-link A/B and flagged every deliberate direct-link plug as
    // "revenue won't attribute", which is false: the rail attributes through its adgroup mapping
    // (magnus 10380896, 2026-08-18 — two correctly minted direct links flagged at validation).
    // The lvnta arm additionally requires a real slug: a bare "https://lvnta.com/" (empty-id mint,
    // truncated paste) used to satisfy this test and ship a permanently dead plug — see the
    // "Knox Callahan monetization dark" item / malformedLevanta in checks.mjs.
    for (const l of plugLinks) {
      const lvntaBroken = /lvnta\.com\//.test(l) && malformedLevanta(l);
      const gumroadUnref = /gumroad\.com/.test(l) && !/[?&]ref=/.test(l);
      if (!isTrackedLink(l) || lvntaBroken || gumroadUnref) {
        iss.push(`untracked product link (${l}) — not a tracked rail (lvnta slug / gumroad ?ref / Amazon Attribution), revenue won't attribute`);
      }
    }
    return iss;
  };
  // Score + surface the hook's strength every skeleton run (even when it passes) — the printed line and
  // the ledger's hookScore are the calibration data for tuning HOOK_MIN against real performance.
  let hookScore = null;
  if (SKEL_MODE && hookBank.length) {
    const hs = hookStrength(tweets[0] || '', hookBank);
    if (hs) { hookScore = hs.score; console.log(`Hook strength vs winner bank: ${hs.score}/100 (vocab ${hs.vocab} · phrasing ${hs.phrasing} · structure ${hs.structure})${hs.dupRisk ? ' ⚠️ shares a 7-word run with a bank hook' : ''}`); }
  }
  let issues = computeIssues();

  // TARGETED REPAIR (validate stage): fix the NAMED defect in place instead of burning the caller's
  // outer retry on a full fresh generation (daily-winners/run-weekly re-exec this whole script on
  // "Skipped write" — ~60-90s + full tokens per attempt, and a fresh roll of the same dice). Mirrors
  // the RAW-stage repair above: bounded at 2 passes, deterministic fixes first, small defect-named LLM
  // calls second, EVERY acceptance strictly re-gated, then the FULL issue set recomputed (a fix that
  // regresses a different gate keeps the draft failing rather than shipping a new defect).
  // NON-repairable classes fall straight through to the outer retry untouched:
  //   - dropped items vs source (content can't be fabricated here — same policy as qc.mjs),
  //   - untracked product link (a provisioning failure, not prose — repair must never touch links),
  //   - plug-count mismatch (re-entering the writePlugs machinery here has more failure modes than a
  //     clean regeneration; it is also the rarest class since links are re-attached deterministically).
  // The --tweets-file path is the documented LLM BYPASS ("use the COMPLETE hand-authored thread
  // as-is", e.g. during an Anthropic outage) — the repair loop would both defeat it (LLM calls that
  // hang/crash exactly when the API is down) and silently rewrite hand-authored text, so it is
  // skipped entirely there: a hand file that fails validation falls through to "Skipped write".
  // 'plug-shaped tweet' left OFF this list from 2026-08-28: the donor-funnel half of it is repairable
  // (delete the creator's ad), and the loop re-gates everything afterwards, so a linkless plug of OUR
  // own still fails the re-check and still falls through to the outer retry.
  const unrepairable = (s) => s.startsWith('dropped ') || s.startsWith('untracked product link') || s.startsWith('expected 2 plugs') || s.startsWith('unfilled placeholder');
  // ONE UNREPAIRABLE ISSUE USED TO DISABLE EVERY REPAIR (2026-08-28, fifth engine run). The guard was
  // `!issues.some(unrepairable)`, so a draft carrying "dropped -2 item(s)" alongside a fixable hook
  // never got its hook touched — and the outer retry then had to roll BOTH dice correctly in one
  // generation. Julian and Rafael each failed five times over on exactly that pairing. The loop now
  // repairs what it can regardless; the unrepairable issue survives the re-check and still sends the
  // draft to the outer retry, so nothing ships that used to fail. It is bounded at 2 passes either way.
  for (let rep = 0; rep < 2 && !TWEETS_FILE && issues.length && issues.some((x) => !unrepairable(x)); rep++) {
    console.log(`  ↳ validate-repair pass ${rep + 1}: ${issues.join(' | ')}`);
    const has = (prefix) => issues.some((s) => s.startsWith(prefix));
    // -- deterministic fixes (free, safe, all existing helpers) --
    if (has('contains em/en dash')) tweets = tweets.map((t) => (isBoiler(t) ? t : stripEmDash(t)));
    if (has('numbering')) tweets = renumberLeadingMarkers(tweets); // marker-only; count-preserving, so the dropped-vs-source gate stays meaningful
    if (has('plug missing affiliate disclosure')) for (const l of plugLinks) tweets = ensureDisclosure(tweets, l);
    if (has('plug text over')) for (let i = 0; i < tweets.length; i++) {
      if (isPlugTweet(tweets[i]) && plugTextLen(tweets[i]) > PLUG_LIMIT) tweets[i] = hardTrimPlug(tweets[i]);
    }
    if (has('missing sign-off') && signOffOf(ACCOUNT) && !tweets.some((t) => t === ACCOUNT.closing)) {
      const di = tweets[tweets.length - 1] === ACCOUNT.disclaimer ? tweets.length - 1 : tweets.length;
      tweets.splice(di, 0, ACCOUNT.closing); // sign-off sits right before the disclaimer
    }
    if (has('last tweet is not the disclaimer') && ACCOUNT.disclaimer) {
      tweets = tweets.filter((t) => t !== ACCOUNT.disclaimer);
      tweets.push(ACCOUNT.disclaimer); // exactly one copy, literal last tweet
    }
    if (has('hook block split')) {
      const mhb = mergeHookBlock(tweets, { plugLinks });
      if (mhb) tweets = mhb; // deterministic; re-gated by the full computeIssues re-check below
    }
    if (has('hook tweet omits the first item marker')) {
      tweets = attachFirstItemToHook(tweets, { srcAttaches }); // deterministic; re-gated below
    }
    if (has('hook is ') || has('hook sentence')) {
      // HOOK AUTO-RETRY (operator ruling 2026-08-23): a hook that came back too close to the donor
      // used to kill the whole slot. Rewrite ONLY tweet 1 — body and pasted pods untouched — and
      // accept the proposal ONLY when the mechanical gate clears; a still-too-similar proposal is
      // discarded so this can never regress fidelity.
      //
      // DIRECTION-AWARE (2026-08-28). The gate fails in BOTH directions and this repair used to send
      // both to rewriteHook, whose entire prompt is "do NOT copy its sentences, rewrite EVERY
      // sentence, diverge harder". Handing a hook that is already 6 points UNDER the floor to a
      // diverge-harder prompt pushes it further out every retry — Julian's live slot went to 46% this
      // way. Too close still diverges; too far now CONVERGES, with the measured score fed back.
      const tooFarIssue = issues.find((x) => hookDriftDirection(x) === 'far');
      try {
        // ONE PROMPT, BOTH DIRECTIONS (2026-08-28, seventh run). rewriteHook is a sledgehammer: asked
        // to bring a 96% hook down under the ceiling it returned 36%, 38% and 31% across three live
        // attempts, every one of them straight through the band and out the far side, so the proposal
        // was rejected and the slot died holding its original. harvestHook with feedback names the
        // measured value and BOTH bounds, so the correction is a nudge toward the middle rather than
        // a shove in one direction. rewriteHook stays for its own callers.
        const { harvestHook } = await import('./prompts.mjs');
        const sim = hookSimilarity(tweets[0] || '', srcTweets[0] || '');
        const hookIssue = issues.find((x) => x.startsWith('hook ')) || '';
        const proposal = await harvestHook(env, ACCOUNT, srcTweets[0] || '', {
          variant: rep + 1, feedback: { sim, hook: tweets[0], issue: hookIssue },
        });
        const fid = proposal ? hookFidelityIssue(proposal, srcTweets[0] || '', { srcAttaches, swapPromise: !!CONVERT_TO }) : 'empty';
        if (proposal && !fid && effLen(proposal) <= 280) {
          tweets[0] = stripEmDash(proposal);
          console.log(`  ↳ hook ${tooFarIssue ? 'pulled back toward' : 'nudged away from'} the donor at repair (${Math.round(sim * 100)}% -> ${Math.round(hookSimilarity(proposal, srcTweets[0] || '') * 100)}%, fidelity cleared mechanically)`);
        } else console.log(`  ↳ hook ${tooFarIssue ? 'converge' : 'diverge'} proposal rejected (${fid || 'empty/overlong'}) — keeping the original`);
      } catch (e) { console.warn(`  ↳ hook rewrite failed: ${e.message}`); }
    }
    if (has('duplicated item')) {
      // Deterministic cut of the later duplicate span (plug/URL tweets are span-guards); if the count
      // then falls under the reference, the next re-check's 'dropped' gate routes to the outer retry.
      const cut = cutDuplicateItem(tweets);
      if (cut.length < tweets.length) tweets = renumberLeadingMarkers(cut);
    }
    if (has('plug-shaped tweet with NO link')) {
      // THE DONOR'S OWN AD IS DELETABLE; OURS IS NOT (2026-08-28).
      // Julian's donor carries a funnel tweet — "Here's the exact combo I use... You can check it
      // out here:" — and the recreation copied it verbatim. Now that the gate catches it, the donor
      // would fail forever, because the defect is a property of the SOURCE and the outer retry gets
      // the same source every time. Deleting it is the right answer and always was: it is the
      // creator's ad, it points at their funnel, and it is not part of the thread we are recreating.
      //
      // A linkless tweet carrying OUR disclosure is the opposite case — a plug whose URL went
      // missing — and deleting that would silently drop a plug. It stays unrepairable.
      const drop = tweets.map((t, i) => {
        const s = String(t);
        if (isBoiler(s) || /https?:\/\//i.test(s)) return -1;
        return (!DISCLOSURE_LINE_RE.test(s) && DANGLING_CTA_RE.test(s)) ? i : -1;
      }).filter((i) => i >= 0);
      if (drop.length) {
        tweets = tweets.filter((_, i) => !drop.includes(i));
        console.log(`  ↳ dropped ${drop.length} donor funnel tweet(s) — a click instruction with nowhere to click`);
      }
    }
    if (has('bridge stacks sentences')) {
      // THE BRIDGE GATE AND THE BRIDGE FIXER DISAGREED (2026-08-28, sixth engine run).
      // bridgeWallIssue uses gluedParagraphs, which flags ANY two-sentence block before a plug —
      // deliberately, because a bridge is the one place the airy rule beats the staccato exemption.
      // unstackParagraphs defaults to the STACKED_MIN rule and only splits when every sentence
      // clears 30 chars. So a bridge opening on a short beat ("That is not your temper." — 24) was
      // flagged by the gate and left untouched by the fixer, forever: Julian's slot failed it on
      // both attempts, on both repair passes, with no fix even attempted. Split it on the gate's own
      // rule instead of the fixer's default.
      for (let i = 2; i < tweets.length; i++) {
        if (!plugLinks.some((l) => l && String(tweets[i]).includes(l))) continue;
        const fixed = unstackParagraphs(tweets[i - 1], { min: 0 });
        if (fixed !== tweets[i - 1] && effLen(fixed) <= TWEET_LIMIT) {
          tweets[i - 1] = fixed;
          console.log(`  ↳ bridge #${i} unstacked (the gate's airy rule, not the staccato one)`);
        }
      }
    }
    if (has('plug bridge missing')) {
      // Bridge law repair: re-land the PRIOR tweets on their substances (a separate small call —
      // the plugs themselves are usually fine, it is the items that drifted).
      const pi = tweets.map((t, i) => (isPlugTweet(t) ? i : -1)).filter((i) => i >= 0);
      // The tweet BEFORE a pasted plug is the pod's own locked BRIDGE (3-tweet) or its labelled
      // bridge (2-tweet) — an LLM prior rewrite or a stapled sentence would destroy proven copy, and
      // the pod's bridge names its substance by construction, so the repair has nothing to fix there.
      const piRepair = pi.filter((idx) => !isPodPasted(tweets[idx]));
      if (piRepair.length === 2 && piRepair[0] > 0 && piRepair[1] > 0) {
        try {
          const priors = await writeBridgePriors(env, ACCOUNT, {
            heavy: { prior: tweets[piRepair[0] - 1], product },
            light: { prior: tweets[piRepair[1] - 1], product: product2 || product },
          });
          const okP = (t) => typeof t === 'string' && t.trim() && effLen(stripEmDash(t)) <= 280;
          const hOk = okP(priors.heavy), lOk = okP(priors.light);
          if (hOk) tweets[piRepair[0] - 1] = stripEmDash(priors.heavy);
          if (lOk) tweets[piRepair[1] - 1] = stripEmDash(priors.light);
          console.log(`  ↳ bridge priors rewritten: heavy ${hOk ? 'applied' : 'rejected'}, light ${lOk ? 'applied' : 'rejected'}`);
        } catch (e) { console.warn(`  ↳ bridge-prior repair failed: ${e.message}`); }
      }
      if (piRepair.length) {
        // DETERMINISTIC GUARANTEE: whatever the model returned, the law is mechanical — if a prior
        // still lacks its substance word, append one plain sentence. Never overrides a prior that
        // already bridges, never exceeds 280. Pod-pasted plugs are excluded above.
        const prodByIdx = new Map([[pi[0], product], [pi[1], product2 || product]]);
        for (const [plugIdx, prod] of piRepair.map((idx) => [idx, prodByIdx.get(idx) || product])) {
          const terms = substanceTermsFor(prod);
          const before = tweets[plugIdx - 1];
          const after = appendSubstanceBridge(before, terms);
          if (after !== before) tweets[plugIdx - 1] = after;
          console.log(`  ↳ deterministic bridge on tweet #${plugIdx} [${terms.join('|') || 'no terms'}]: ${after !== before ? 'APPLIED' : (terms.some((t) => before.toLowerCase().includes(t)) ? 'already bridged' : 'COULD NOT FIT')}`);
        }
        // ...then give each fused bridge its own tweet (operator 2026-08-25). Everything above writes
        // the bridge INTO the numbered item, which is the one-tweet heavy ask thinAskIssue rejects.
        // Highest plug index first, so splicing at the later plug never invalidates the earlier one.
        for (const [plugIdx, prod] of piRepair.map((idx) => [idx, prodByIdx.get(idx) || product]).slice().reverse()) {
          const n = tweets.length;
          tweets = unfuseBridge(tweets, plugIdx, substanceTermsFor(prod));
          if (tweets.length !== n) console.log(`  ↳ bridge un-fused into its own tweet before plug #${plugIdx}`);
        }
      }
    }
    // A plug can pass plugTextLen (<=255, link excluded) yet still break the 280 TWEET limit once
    // the disclosure label and link are counted (live: #11 at 281). Trim the plug's own beats to fit.
    for (let i = 0; i < tweets.length; i++) {
      const l = effLen(tweets[i]);
      if (isPlugTweet(tweets[i]) && l > 280) {
        const trimmed = hardTrimPlug(tweets[i], Math.max(80, plugTextLen(tweets[i]) - (l - 280) - 4));
        if (trimmed !== tweets[i]) { tweets[i] = trimmed; console.log(`  ↳ plug #${i + 1} trimmed to fit the 280 tweet limit (${l}→${effLen(trimmed)})`); }
      }
    }
    if (has("plug never names the linked product's substance") || has("plug's evidence line claims")) {
      // Substance drift: rewrite the WRITTEN plugs fresh — and never a pasted pod. A pod names its
      // substance by construction (the library gate refuses prose that does not), so a drift issue
      // can only belong to writer copy; rewriting a pasted pod here is how proven copy would die.
      const pi = tweets.map((t, i) => (isPlugTweet(t) ? i : -1)).filter((i) => i >= 0 && !isPodPasted(tweets[i]));
      const heavyP = product, lightP = product2 || product;
      if (pi.length === 2) {
        try {
          const plugs = await writePlugs(env, ACCOUNT, heavyP, lightP, !!product2 && lightP.link !== heavyP.link, tweets[pi[0] - 1] || '', tweets[pi[1] - 1] || '', CTA_STYLE, { avoidMoves: recentMoves, thread: tweets });
          tweets[pi[0]] = normalizePlugStructure(stripEmDash(plugs.heavy));
          tweets[pi[1]] = normalizePlugStructure(stripEmDash(plugs.light));
          declaredPlugMoves.length = 0; // the rewrite's declared moves supersede the originals
          declaredPlugMoves.push(plugs.heavyMove, plugs.lightMove);
          for (const l of plugLinks) tweets = ensureDisclosure(tweets, l);
          console.log('  ↳ plugs rewritten (copy sold a different substance than the linked product)');
        } catch (e) { console.warn(`  ↳ plug substance rewrite failed: ${e.message}`); }
      } else if (pi.length === 1) {
        try {
          const prod = tweets[pi[0]].includes(heavyP.link) ? heavyP : lightP;
          const plugs = await writePlugs(env, ACCOUNT, prod, prod, false, tweets[pi[0] - 1] || '', tweets[pi[0] - 1] || '', CTA_STYLE, { avoidMoves: recentMoves, thread: tweets });
          tweets[pi[0]] = normalizePlugStructure(stripEmDash(plugs.heavy));
          for (const l of plugLinks) tweets = ensureDisclosure(tweets, l);
          console.log('  ↳ written plug rewritten (substance drift) — the pasted pod was left alone');
        } catch (e) { console.warn(`  ↳ plug substance rewrite failed: ${e.message}`); }
      }
    }
    if (has('plugs are adjacent')) {
      // Move the SECOND plug one slot later so a content tweet sits between them — only when the tweet
      // being hopped over is a real content tweet (never leapfrog the sign-off/disclaimer).
      const pi = tweets.map((t, i) => (isPlugTweet(t) ? i : -1)).filter((i) => i >= 0);
      if (pi.length === 2 && pi[1] - pi[0] <= 1) {
        const [moved] = tweets.splice(pi[1], 1);
        if (pi[1] < tweets.length && !isBoiler(tweets[pi[1]])) tweets.splice(pi[1] + 1, 0, moved);
        else tweets.splice(pi[1], 0, moved); // can't move safely — restore; falls through to the outer retry
      }
    }
    // -- targeted LLM fixes (small per-tweet calls, defect named, acceptance strictly gated) --
    if (has('over 280')) tweets = await tightenLong(tweets, env, ACCOUNT); // existing helper; carries its own link/disclosure/marker re-asserts
    if (has('hard health claim')) {
      for (let i = 0; i < tweets.length; i++) {
        const t = tweets[i];
        if (isBoiler(t) || !hardHealthClaim(t)) continue;
        const out = await anthropic(env, { role: 'generate', model: FLEET_MODEL, max_tokens: 600, messages: [{ role: 'user', content:
`This X post contains a hard curative/disease health claim. The EXACT flagged wording is: "${hardHealthClaimMatch(t)}" — remove or reword THAT phrase specifically (even if it reads as criticism or a noun, the compliance scanner cannot tell). Rewrite it into hedged, supportive association language ("is linked to", "may support", "research ties X to"). Keep the meaning, ${ACCOUNT.name}'s calm voice, every line break, any leading item number (e.g. "7.") exactly, and any URL verbatim. Under 280 chars. No em dashes. Return ONLY the rewritten post.\n\n${t}` }] });
        let fixedT = stripEmDash(out.trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim());
        const mark = (t.match(/^(\d+)[.)]\s/) || [])[1];
        if (mark && !new RegExp(`^${mark}[.)]`).test(fixedT)) fixedT = `${mark}. ${fixedT}`; // never let a rewrite eat the item marker
        // Accept ONLY a clean fix. The hook (tweet #1) must keep its opening line — hook fidelity is
        // the top viral driver, so a softened hook is WORSE than falling through to a fresh generation.
        const hookOk = i !== 0 || fixedT.split('\n')[0] === t.split('\n')[0];
        if (!hardHealthClaim(fixedT) && effLen(fixedT) <= 280 && hookOk) tweets[i] = fixedT;
      }
    }
    if (has('plug shape (')) {
      // Deterministic, free, and the exact repair the gate was written around: re-run the canonicalizer
      // on the offending plug(s). Re-gated by the full computeIssues re-check below, so a plug the
      // normalizer can't canonicalize keeps the draft failing rather than shipping a broken CTA block.
      for (let i = 0; i < tweets.length; i++) {
        if (!isPlugTweet(tweets[i])) continue;
        const shaped = normalizePlugStructure(tweets[i]);
        if (shaped !== tweets[i] && plugTextLen(shaped) <= PLUG_LIMIT) tweets[i] = shaped;
      }
    }
    if (has('absolute (non-hedged) superlative')) {
      for (let i = 0; i < tweets.length; i++) {
        if (!isPlugTweet(tweets[i]) || !absoluteSuperlativeIssue(tweets[i])) continue;
        // judgePlug's rewrite is already length+disclosure validated inside cta.mjs, and an unread judge
        // carries no rewrite; the deterministic absoluteSuperlativeIssue re-check is the acceptance gate here.
        const v = await judgePlug(env, ACCOUNT, tweets[i - 1] || '', tweets[i], CTA_STYLE);
        const rw = v.rewrite ? stripEmDash(v.rewrite) : null;
        const plugLink = plugLinks.find((l) => tweets[i].includes(l));
        if (rw && !absoluteSuperlativeIssue(rw) && plugTextLen(rw) <= PLUG_LIMIT
            && (!plugLink || rw.includes(plugLink)) && /aff|affiliate|commission|paid/i.test(rw)) {
          tweets[i] = normalizePlugStructure(rw);
        }
      }
    }
    if (has('hook mold') || has('weak hook')) {
      // ONE combined hook re-cast, MULTI-CANDIDATE (2026-07-20): single-shot rewrites kept missing the
      // ±20% character band (models can't hit a char budget reliably), so ask for THREE alternative
      // lines and deterministically take the first that passes EVERY gate — mold (band + scaffold),
      // no 7+-word lift, no bank dupRisk, strength at/above floor or strictly improved.
      const lines = tweets[0].split('\n');
      const target = skeleton.hookLine1Len || lines[0].length;
      const lo = Math.ceil(target * 0.82), hi = Math.floor(target * 1.18);
      const before = hookBank.length ? hookStrength(tweets[0] || '', hookBank) : null;
      const srcL1 = (srcTweets[0] || '').split('\n')[0];
      const out = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 400, messages: [{ role: 'user', content:
`Below is a DONOR sentence (a proven viral hook line) and a CURRENT line carrying the topic to express. Rewrite the DONOR sentence about the CURRENT line's topic by swapping ONLY its content words (nouns, verbs, adjectives) — keep every connective/function word and the exact sentence shape. Because you keep the frame and swap words one-for-one, your line will naturally stay close to the donor's length (${lo}-${hi} chars); do not add clauses or extra modifiers. Never reuse the donor's own content words.${skeleton.itemCategory ? ` EXCEPTION — the category word "${skeleton.itemCategory}" is part of the mold: if the donor line contains it, KEEP it verbatim and swap only the surrounding content words.` : ''} No em dashes.\n\nDONOR LINE (the mold): ${srcL1}\n\nCURRENT LINE (the topic to express): ${lines[0]}\n\nReturn ONLY a JSON array of 3 different rewritten lines, e.g. ["...","...","..."].` }] });
      let cands = [];
      try { cands = JSON.parse((out.match(/\[[\s\S]*\]/) || ['[]'])[0]).filter((c) => typeof c === 'string'); } catch {}
      if (!cands.length) cands = [out.trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim().split('\n')[0]];
      const allowNgH = [product.title, product2?.title, shortName(product.title || ''), shortName(product2?.title || ''), ACCOUNT.disclaimer, ACCOUNT.closing].filter(Boolean);
      for (let cand of cands) {
        cand = stripEmDash(String(cand)).split('\n')[0].trim();
        if (!cand) continue;
        const rebuilt = [cand, ...lines.slice(1)].join('\n');
        const after = hookBank.length ? hookStrength(rebuilt, hookBank) : null;
        // No strength requirement here: a candidate can only be accepted if it passes the MOLD check
        // below, and a mold-pass WAIVES the strength floor in computeIssues (the donor is the proof of
        // strength). Demanding bank-similarity on top was stricter than the gate itself and rejected
        // every in-band candidate of an off-bank-style donor (live 2026-07-20). dupRisk still blocks.
        if (effLen(rebuilt) <= 280 && !(after && after.dupRisk)
            && (HOOK_FREEDOM || !hookMoldIssue(rebuilt, { template: skeleton.hookFirstLine || '', srcLine1: srcL1, srcLine1Len: skeleton.hookLine1Len || 0 }))
            && !sharedNgramIssue([rebuilt], [...srcTweets, ...factTexts], { allow: allowNgH })) {
          console.log(`  ↳ hook re-cast (mold + strength): ${lines[0].length} -> ${cand.length} chars${before && after ? `, ${before.score} -> ${after.score}/100` : ''}`);
          tweets[0] = rebuilt;
          break;
        }
      }
    }
    if (has('hook too long')) {
      // Shorten the hook toward the donor's length WITHOUT losing its shape (operator 2026-07-24).
      // Multi-candidate; accept the first that clears a TIGHTER +10% band — well under the +20% gate,
      // so the full re-check below can't re-flag it and thrash the roll. The attached "N." item (if
      // any) is stripped for the rewrite and re-appended verbatim, so item count/structure is untouched.
      const donorHook = hookBodyText(srcTweets[0] || '', srcAttaches);
      const budget = effLen(donorHook);
      const ourBody = hookBodyText(tweets[0] || '', srcAttaches);
      const attached = srcAttaches ? (String(tweets[0]).split(/\n{2,}/).filter((b) => /^\s*\d+[.)]\s/.test(b)).pop() || '') : '';
      const out = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 400, messages: [{ role: 'user', content:
`OUR HOOK reads LONGER than the DONOR hook it mirrors, so it feels clumsy and hard to scan. Rewrite OUR HOOK to be NO LONGER than ${budget} characters, matching the donor's SHAPE and rhythm: keep the same number of lines, keep any quotation marks, keep ${ACCOUNT.name}'s meaning and topic. Tighten wordy phrasings (e.g. "talk to my 25 year old self" -> "be 25 again"); drop no lines, add no clauses or modifiers. No em dashes.\n\nDONOR HOOK (${budget} chars, the mold):\n${donorHook}\n\nOUR HOOK (${effLen(ourBody)} chars, too long):\n${ourBody}\n\nReturn ONLY a JSON array of 3 shorter rewrites, each keeping the line breaks.` }] });
      let cands = []; try { cands = JSON.parse((out.match(/\[[\s\S]*\]/) || ['[]'])[0]).filter((c) => typeof c === 'string'); } catch {}
      for (let cand of cands) {
        cand = stripEmDash(String(cand)).trim();
        if (!cand) continue;
        const rebuilt = attached ? `${cand}\n\n${attached}` : cand;
        if (effLen(rebuilt) <= 280 && !hookTooLong(rebuilt, srcTweets[0] || '', { srcAttaches, tolerance: 0.08 })) {
          console.log(`  ↳ hook shortened toward donor length: ${effLen(ourBody)} -> ${effLen(cand)} chars (donor ${budget})`);
          tweets[0] = rebuilt;
          break;
        }
      }
    }
    if (has('skeleton lift')) {
      // Re-say EVERY content tweet that lifts a >=7-word run from a source. The fact pool often reuses the
      // same viral hook FORMAT ("Everyone over 30 blames aging for their ..."), so multiple tweets can lift
      // at once; fixing them all in one pass clears a multi-lift thread that the bounded repair loop would
      // otherwise run out of iterations on.
      const allowNg = [product.title, product2?.title, shortName(product.title || ''), shortName(product2?.title || ''), ACCOUNT.disclaimer, ACCOUNT.closing].filter(Boolean);
      for (let i = 0; i < tweets.length; i++) {
        if (isBoiler(tweets[i]) || isPlugTweet(tweets[i])) continue;
        const lift = sharedNgramIssue([tweets[i]], [...srcTweets, ...factTexts], { allow: allowNg });
        if (!lift) continue;
        const phrase = (lift.match(/"([^"]+)"/) || [])[1] || '';
        const out = await anthropic(env, { role: 'generate', model: MODEL, max_tokens: 500, messages: [{ role: 'user', content:
`This X post reuses a phrase verbatim from a source thread ("${phrase}"). Rewrite the post so it expresses the SAME idea in entirely different wording — NO run of 7+ words shared with the original. Keep ${ACCOUNT.name}'s voice, every line break, any leading item number (e.g. "3.") exactly, any URL verbatim, under 280 chars, no em dashes. Return ONLY the rewritten post.\n\n${tweets[i]}` }] });
        let fx = stripEmDash(out.trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim());
        const mk = (tweets[i].match(/^(\d+)[.)]\s/) || [])[1];
        if (mk && !new RegExp(`^${mk}[.)]`).test(fx)) fx = `${mk}. ${fx}`;
        if (fx && effLen(fx) <= 280) tweets[i] = fx;
      }
    }
    tweets = tweets.map((t) => (isBoiler(t) ? t : stripEmDash(t))); // an LLM fix can re-introduce a dash
    issues = computeIssues(); // FULL re-check — the write gate below sees only the final truth
  }
  if (SKEL_MODE && hookBank.length) { const hs = hookStrength(tweets[0] || '', hookBank); if (hs) hookScore = hs.score; } // final hook's score (post-repair) — this is what the ledger records
  console.log(issues.length ? `⚠️ VALIDATION: ${issues.join(' | ')}` : '✓ validation passed');

  const updateId = flag('update');
  // REVIEW ESCAPE HATCH (operator 2026-08-17: "show me the draft even if it's bad"). Opt-in via env,
  // never set by any cron: write the draft ANYWAY when validation failed, titled [NEEDS FIX] so it
  // can never be mistaken for shippable. The draft is created UNSCHEDULED by the same code path;
  // nothing auto-posts. Existence of a lookable artifact beats a log line when diagnosing copy.
  const ALLOW_INVALID = process.env.ALLOW_INVALID_DRAFT === '1' && issues.length > 0;
  if (ALLOW_INVALID) console.log(`⚠️ ALLOW_INVALID_DRAFT: writing this draft for REVIEW despite ${issues.length} validation issue(s) — it is NOT shippable.`);
  if ((CREATE || updateId) && (!issues.length || ALLOW_INVALID)) {
    const scratchpad = [
      `ENGINE ${SKEL_MODE ? 'SKELETON VARIATION' : 'RECREATION'}`,
      `Source: ${src.url} (${src.impressions.toLocaleString()} views, ${src.niche})`,
      ...(SELF_QRT_URL ? [`SELF-QRT: ${SELF_QRT_URL}${SELF_QRT_META ? ` (${SELF_QRT_META})` : ''} — placed: ${selfQrtPlaced.join(' + ') || 'none'}`] : []),
      ...(SKEL_MODE ? [`MODE: skeleton`, `SKELETON: ${skeleton.id || SKELETON}`, `TOPIC: ${TOPIC}`, `ITEMCOUNT: ${skeleton.itemCount}`, ...(hookScore != null ? [`HOOKSCORE: ${hookScore}`] : [])] : []),
      ...(MONETIZED ? [
        `Product: ${product.title} (${product.asin})`,
        `Link: ${product.link}`,
        `Subid1: ${product.subid1}  (revenue is tracked per-thread on this tag)`,
        ...(product2 ? [
          `Product 2 (light plug): ${product2.title} (${product2.asin})`,
          `Link 2: ${product2.link}`,
          `Subid1 (2): ${product2.subid1}`,
        ] : []),
      ] : [`Mode: lightweight client variation (no monetization)`]),
      ``,
      `REFERENCE MEDIA (match this when fact-checking):`,
      inv.summary,
      ``,
      ...(SKEL_MODE
        ? [
            `=== FACT SOURCES (the new content is drawn from these; the source above is the FORM donor only) ===`,
            ...factPool.map((f) => `- ${f.url || f.recId}`),
            ``,
            // Operator request 2026-07-20: the FULL donor thread lives in the scratchpad so the mold
            // and the variation can be assessed side by side without leaving Typefully.
            `=== FORM DONOR — FULL ORIGINAL THREAD (do not post; assess the mold side by side) ===`,
            ...srcTweets.flatMap((t, i) => [`[donor ${i + 1}]`, t, ``]),
          ]
        : [`=== VERBATIM ORIGINAL (do not post) ===`, verbatim]),
    ].join('\n');
    const publishAt = flag('at'); // ISO datetime to schedule, e.g. 2026-06-12T19:00:00-04:00
    // Per-platform tracked links (operator 2026-08-27). Levanta reports on subids, never referrers,
    // so a cross-post carrying X's links cannot be told apart from X in any report. Fails soft: a
    // mint failure keeps X's links on that platform, losing the split rather than the post.
    const xPosts = tweets.map((t, i) => ({ text: t, ...(SELF_QRT_URL && selfQrtQuotesHere(t, i) ? { quote_post_url: SELF_QRT_URL } : {}) }));
    const xpProducts = [product, product2].filter((p) => p?.link && p?.subid1 && p?.asin);
    const { platformPosts: xpPosts, minted: xpMinted } = await crossPostLinks(env, ACCOUNT, xPosts, xpProducts);
    const body = {
      draft_title: `${ALLOW_INVALID ? '[NEEDS FIX] ' : ''}[Infinity] ${ACCOUNT.name} — ${srcTweets[0].split('\n')[0].slice(0, 50)}`,
      scratchpad_text: scratchpad,
      share: true, // keep the public share_url live — also covers the patch/regenerate path (updateId) below
      platforms: buildPlatforms(xPosts, { account: ACCOUNT, platformPosts: xpPosts }),
      ...(publishAt ? { publish_at: publishAt } : {}),
    };
    const draft = updateId ? await tf.patchDraft(ACCOUNT.socialSetId, updateId, body) : await tf.createDraft(ACCOUNT.socialSetId, body);
    resultChannel?.confirm(draft.id, draft.share_url || `https://typefully.com/?d=${draft.id}`);
    const shareUrl = draft.share_url || `https://typefully.com/?d=${draft.id}`;
    console.log(`\n✓ Draft ${updateId ? 'updated' : 'created'}: id ${draft.id} | https://typefully.com/?d=${draft.id}`);
    console.log(`Share URL: ${shareUrl}`); // public link — downstream (daily-winners/run-weekly) puts THIS in Telegram, not the private editor URL
    // plugFp: judge-approved (prior, plug) fingerprints STILL byte-identical in the final array —
    // computed here (after every post-judge mutation: normalize, hard-trim, dash sweep, repair) so a
    // recorded fingerprint always matches exactly what ships. qc.mjs skips re-judging these pairs.
    const plugFp = MONETIZED
      ? tweets.map((t, i) => (isPlugTweet(t) ? plugFingerprint(tweets[i - 1] || '', t) : null)).filter((fp) => fp && judgeApprovedFp.has(fp))
      : [];
    // LAW 12c: stamp the opener MOVE each plug actually used, classified from the emitted text (so
    // it works whether the engine or a human wrote it). This is what the NEXT run of this account
    // reads back as its do-not-reuse list — without it, cross-thread variety has no memory.
    // Prefer the move the WRITER declared over the regex classifier: it knows which move it chose,
    // the regex only infers it. classifyPlugMove stays as the fallback (hand-written plugs, older
    // drafts, and any response that omitted the field) and as what validate-thread.mjs enforces.
    const declaredMoves = declaredPlugMoves.filter((m) => typeof m === 'string' && m.trim());
    const plugMoves = MONETIZED
      ? tweets.filter((t) => isPlugTweet(t)).map((t, i) => declaredMoves[i] || classifyPlugMove(t))
      : [];
    // Generation cost rides the ledger row: this process's LLM spend so far IS this thread's cost
    // (one recreate process = one thread). registry-sync copies it onto the Published Content row,
    // which is what lets the dashboard put "$0.14 to make" next to "$32 earned".
    const genSpend = llmSpendSummary();
    // Hook identity + plug positions ride the ledger so downstream never re-derives them:
    // hookId = the SHIPPED tweet 1 (reposts of identical text share it; a rotation's new hook gets
    // its own) — subid2 at mint time carried the donor FAMILY id, which is the coarser grouping.
    // plugTweets = 1-based positions of the plug tweets in the final array — the exact indices
    // registry-sync prices with per-tweet analytics (plug exposure / true plug CTR).
    const hookId = hookIdOf(tweets[0]) || undefined;
    const plugTweets = MONETIZED ? plugTweetIndices(tweets) : [];
    appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account: ACCOUNT.name, recId, draftId: draft.id, mode: SKEL_MODE ? 'skeleton' : (MONETIZED ? 'monetized' : 'lightweight'), ...(MOLD_ID ? { moldId: MOLD_ID } : {}), ...(CONVERT_TO ? { convertTo: CONVERT_TO } : {}), ...(genSpend.calls ? { llmCost: genSpend.costUsd, llmTokens: genSpend.tokensIn + genSpend.tokensOut, llmBasis: genSpend.basis } : {}), ...(MONETIZED ? { subid1: product.subid1, asin: product.asin, product: product.title, link: product.link, ctaStyle: CTA_STYLE, ...(product2 ? { asin2: product2.asin, product2: product2.title, link2: product2.link, subid1b: product2.subid1 } : {}), ...(plugFp.length ? { plugFp } : {}), ...(plugMoves.length ? { plugMoves } : {}), ...(plugTweets.length ? { plugTweets } : {}), ...(podsUsed.length ? { pods: podsUsed } : {}), ...([product, product2].some((p) => p?.donorSlot) ? { warmSlot: true } : {}) } : {}), ...(SKEL_MODE ? { skeletonId: skeleton.id || SKELETON, factRecIds: FACTS, factUrls: factPool.map((f) => f.url).filter(Boolean), ...(hookScore != null ? { hookScore } : {}), ...(HOOK_FREEDOM ? { hookFreedom: true } : {}) } : {}), ...(SELF_QRT_URL ? { selfQrtOf: SELF_QRT_URL } : {}), ...(hookId ? { hookId } : {}), ...(MONETIZED && product.subid2 ? { hookFamily: product.subid2 } : {}), sourceUrl: src.url, sourceViews: src.impressions, niche: src.niche, topic: SKEL_MODE ? TOPIC : classifyTopic(srcTweets[0] || '') }) + '\n');
    // A cross-posted platform's own link needs its own attribution row, or its clicks reach Levanta
    // under a subid the ledger has never seen and land in the unattributed pile.
    for (const row of crossPostLedgerRows(xpMinted, { account: ACCOUNT.name, draftId: draft.id, recId })) appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(row) + '\n');
    // Structure×topic grid stamp (2026-07-22): atomic with draft creation, keyed by the donor recId,
    // so the fleet never runs the same form on the same topic twice within the grid window.
    if (SKEL_MODE && TOPIC) recordStructureUse(recId, TOPIC, ACCOUNT.name);
    console.log(`✓ Ledger updated${MONETIZED ? ` (subid1=${product.subid1})` : ' (lightweight)'}`);
  } else if (CREATE || updateId) {
    console.log('\n✗ Skipped write — fix validation issues first.');
  }
}
// Spend flushes on success AND failure — a crashed run's tokens are still real money, and
// flushLlmSpend never throws, so the exit-1 contract is untouched.
withProcessResult(main, process.argv.slice(2), { llmCost: () => llmSpendSummary().costUsd })
  .then(() => flushLlmSpend(null, SKEL_MODE ? 'gen-skeleton' : 'gen-faithful', ACCOUNT.name))
  .catch(async (e) => { console.error('ERROR:', e.stack || e.message); await flushLlmSpend(null, SKEL_MODE ? 'gen-skeleton' : 'gen-faithful', `${ACCOUNT.name} · crashed`); process.exit(1); });
