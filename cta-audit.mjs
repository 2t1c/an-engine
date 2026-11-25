// cta-audit.mjs — judge a SHIPPED draft the way the operator reads it.
//
// The gates answer "is this legal". This answers "is this any good", on the four things the operator
// named as the whole point (2026-08-17, 1am): where the CTA sits, how it is written, what it plugs,
// and whether the criterion comes BEFORE the ask. Plus the fifth that broke the first batch: did we
// keep the mold's shape, or improvise a hybrid.
//
// It exists because the first OUTLINE_MODE batch shipped three drafts that all passed validateDraft
// and two of which were wrong in ways only reading them revealed. A gate that a regex can satisfy is
// not judgement; this is the checklist that turns judgement into something repeatable overnight.
//
//   node cta-audit.mjs --draft 10373101
//   node cta-audit.mjs --draft 10373101 --json
import { LAWS } from './laws.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
// ctaStyleOf lives with the unscheduler because that tool was written to find dated closers; it is
// the one place the closer law is spelled out, so the judge reads it there rather than keeping a
// second copy that can drift. The module's main() is guarded, so importing it runs nothing.
import { ctaStyleOf } from './unschedule-old-plugs.mjs';
import {
  isTrackedLink, substanceTermsFor, bridgeableProducts, criterionOrderIssue, discriminationIssue,
  runUpIssue, plugStructure, classifyPlugMove, BAD_PLUG_MOVES, effLen, moldById, listicleKind,
  leadingNumbers, hookSimilarity, hookBodyText, brandOpenerIssue, duplicateLinkIssue,
  unlinkedSellIssue, truncationIssue, openerTwinIssue, formContradictionIssue, closingTexts,
} from './checks.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_RE = /https?:\/\/\S+/g;
const DP_RE = /\/dp\/(B[A-Z0-9]{9})/;

/**
 * What did this thread ACTUALLY plug? Resolved from the thread's own links, not from the ledger's
 * opinion of them.
 *
 * This function exists because of a fail-open that would have wasted the whole overnight batch. The
 * first cut trusted the ledger row alone: `products = row.asin ? [{...}] : []`. Two drafts had their
 * ledger rows destroyed by the persist-rebase bug and reconstructed WITHOUT an asin — so `products`
 * came back empty, the criterion loop hit `continue` on every plug, the product loop iterated zero
 * times, and both drafts scored 94/100 on the two axes that still ran. The operator had personally
 * read those two and called them broken. Thin data scored HIGHER than good data: exactly backwards,
 * and silent about it.
 *
 * So: the thread is the source of truth for what shipped, the ledger is only a lookup for metadata,
 * and anything unresolvable becomes a loud verdict rather than an empty array.
 */
export function resolveProducts(tweets, { rows = [], ledger = [], catalog = {} } = {}) {
  const byLink = new Map(); // every link ever minted -> its asin, from the WHOLE ledger
  for (const r of ledger) {
    if (r.link && r.asin) byLink.set(r.link, { asin: r.asin, title: r.product });
    if (r.link2 && r.asin2) byLink.set(r.link2, { asin: r.asin2, title: r.product2 });
  }
  for (const r of rows) { // this draft's own rows win, even without an asin
    if (r.link) byLink.set(r.link, { asin: r.asin || byLink.get(r.link)?.asin || null, title: r.product });
    if (r.link2) byLink.set(r.link2, { asin: r.asin2 || byLink.get(r.link2)?.asin || null, title: r.product2 });
  }
  const out = [];
  for (const [i, t] of (tweets || []).entries()) {
    for (const link of String(t).match(URL_RE) || []) {
      if (!isTrackedLink(link)) continue;
      const clean = link.replace(/[),.]+$/, '');
      // 1. an Amazon direct link carries its own asin; 2. else the ledger knows this exact link.
      const asin = clean.match(DP_RE)?.[1] || byLink.get(clean)?.asin || null;
      const title = catalog[asin]?.title || byLink.get(clean)?.title || null;
      out.push({ asin, title, link: clean, tweetIndex: i, resolved: Boolean(asin) });
    }
  }
  return out;
}

/**
 * Pure: the full judgement on one thread. `products` are what the ledger says we meant to sell.
 * Returns { score, verdicts[] } where each verdict is {axis, level, msg}. level: ok | warn | fail.
 * Exported for tests.
 */
export function judgeThread(tweets, { account = {}, products = [], mold = null, donorHook = null, shape = null } = {}) {
  const V = [];
  const add = (axis, level, msg) => V.push({ axis, level, msg });
  const plugIdx = (tweets || []).map((t, i) => ((String(t).match(URL_RE) || []).some(isTrackedLink) ? i : -1)).filter((i) => i >= 0);
  const bodyLen = tweets.length - plugIdx.length;

  if (!plugIdx.length) { add('plug', 'fail', 'no tracked plug at all — a monetized thread posting for free'); return { score: 0, verdicts: V, plugIdx }; }

  // ---- 1. POSITION -------------------------------------------------------------------------------
  // Only ~5-12% of hook readers reach the plug, so the first one's depth is the single biggest
  // controllable factor in what the thread earns.
  const first = plugIdx[0] + 1;
  if (first < LAWS.plugs.firstAt) add('position', 'fail', `first plug at tweet ${first} — too early to have earned it, and there is no room for a criterion beat`);
  // The proven window is tweets 3-4, measured on six pre-outline winners. A CONCEPTUAL thread plans a
  // four-beat run-up on purpose (operator 2026-08-17), which puts its first marker at tweet 5 by
  // design — so the old band could never score that shape anything but "past the window" for
  // following its own outline. The window follows the shape the outline actually emits.
  else if (first <= (shape === 'conceptual' ? LAWS.plugs.conceptualOkMax : LAWS.plugs.okWindowMax)) add('position', 'ok', `first plug at tweet ${first} — the proven early window${shape === 'conceptual' ? ' for a four-beat conceptual run-up' : ''}`);
  else if (first <= LAWS.plugs.warnWindowMax) add('position', 'warn', `first plug at tweet ${first} — past the proven window; every tweet of delay costs audience`);
  else add('position', 'fail', `first plug at tweet ${first} — deep in the thread where $/1k roughly halves`);
  for (let i = 1; i < plugIdx.length; i++) {
    if (plugIdx[i] - plugIdx[i - 1] === 1) add('position', 'fail', `plugs at tweets ${plugIdx[i - 1] + 1} and ${plugIdx[i] + 1} are ADJACENT — reads as an ad break`);
  }
  const signOffIdx = (tweets || []).findIndex((t) => closingTexts(account).includes(t)); // legacy-aware: old drafts end on the pre-2026-08-23 closer
  if (signOffIdx > 0 && plugIdx.some((i) => i > signOffIdx)) add('position', 'fail', 'a plug sits after the sign-off, where nobody is reading');

  // ---- 2. CRITERION ORDER (the operator's hard rule) ---------------------------------------------
  // Every plug MUST be judged. An unjudgeable plug is a fail, never a skip — see resolveProducts for
  // what silence cost us the first time.
  for (const i of plugIdx) {
    const p = products.find((x) => x.link && String(tweets[i]).includes(x.link)) || products.find((x) => x.tweetIndex === i);
    if (!p || !p.asin) {
      add('criterion', 'fail', `plug #${i + 1}: cannot resolve WHAT this plug sells (no asin for ${String(p?.link || 'its link').slice(0, 46)}) — the criterion rule could not be checked, so treat it as unchecked, not as passing`);
      continue;
    }
    const form = formContradictionIssue(tweets, i, p);
    if (form) add('product', 'fail', `plug #${i + 1} ${form}`);
    const order = criterionOrderIssue(tweets, i, p);
    if (order) { add('criterion', 'fail', order); continue; }
    const disc = discriminationIssue(tweets, i, p);
    if (disc) add('criterion', 'warn', disc);
    else add('criterion', 'ok', `plug #${i + 1}: the beat before it hands over a buying criterion`);
    const ru = runUpIssue(tweets, i, p, { shape });
    if (ru) add('criterion', 'warn', ru);
  }

  // ---- 3. WHAT WE PLUG ---------------------------------------------------------------------------
  // The product must be the substance the THREAD argued for. A plug the body never built a case for
  // is the mismatch that makes a thread read as an ad regardless of how the CTA is worded.
  const bodyText = tweets.filter((_, i) => !plugIdx.includes(i)).join('\n');
  const hostable = new Set(bridgeableProducts(bodyText));
  for (const p of products) {
    if (!p?.asin) {
      add('product', 'fail', `a plug points at ${String(p?.link || '(unknown)').slice(0, 52)} which resolves to NO product — nothing downstream can attribute it either`);
      continue;
    }
    const terms = substanceTermsFor(p);
    // No terms is OUR gap, not the thread's defect. The first archive pass fired "the body never
    // names this substance" 123 times against products whose titles we simply had no word for
    // (probiotics, B12, berberine, saffron...) — an empty list made `.some()` false and every one of
    // them a confident fail. Blame the vocabulary out loud instead of the copy.
    if (!terms.length) { add('product', 'warn', `${p.asin} (${String(p.title || '').slice(0, 34)}) — our substance vocabulary has no word for this product, so "does the body argue for it" could NOT be tested; add it to BRIDGE`); continue; }
    const named = terms.some((t) => bodyText.toLowerCase().includes(t));
    if (!named) add('product', 'fail', `${p.asin} (${String(p.title || '').slice(0, 34)}) — the BODY never names this substance; the thread argues for nothing we sell`);
    else if (!hostable.has(p.asin)) add('product', 'warn', `${p.asin} named but not bridge-gated by the body — check the case is really made`);
    else add('product', 'ok', `${p.asin}: the body builds the case for ${terms[0]}`);
  }
  if (products.length >= 2 && products[0]?.asin === products[1]?.asin) add('product', 'warn', 'the same product twice — two distinct products convert far better');
  for (const d of duplicateLinkIssue(tweets)) add('product', 'fail', d);

  // ---- 4. HOW IT IS WRITTEN ----------------------------------------------------------------------
  const moves = [];
  for (const i of plugIdx) {
    const t = String(tweets[i]);
    // plugStructure returns {ok, failed, detail} — it has never had a `beats` property. The first cut
    // tested `st.beats < 3`, which is `undefined < 3`, which is permanently false: the shape check
    // silently never ran, and lorenzo 10373108's two-beat plug sailed through. Read the real fields.
    const st = plugStructure(t);
    if (st && st.ok === false) add('craft', 'fail', `plug #${i + 1} shape is broken [${st.failed}] — ${st.detail}`);
    const brand = brandOpenerIssue(t, products.find((x) => t.includes(x.link)) || {});
    if (brand) add('craft', 'fail', `plug #${i + 1} ${brand}`);
    const mv = classifyPlugMove(t);
    moves.push(mv);
    if (BAD_PLUG_MOVES.has(mv)) add('craft', 'fail', `plug #${i + 1} opens on a banned move (${mv})`);
    // An own-product plug (our ebook, gumroad) legally carries "Get it here:" and NO affiliate
    // disclosure — it is first-party, there is no commission to disclose. checks.mjs has carried that
    // exemption in two places since the 2026-08-10 incident where Marcos and Jasper ebook drafts
    // failed every slot on "missing affiliate disclosure" for correct copy. This tool, written after,
    // never learned it and re-created the same incident.
    const firstParty = /gumroad\.com/i.test(t);
    if (!firstParty && !/aff\s*link|#ad\b/i.test(t)) add('craft', 'fail', `plug #${i + 1} carries no affiliate disclosure`);
    // One source of truth for the closer law: ctaStyleOf. The inline regex this replaced tested for
    // the literal "This is my <substance>", which meant three of the four operator-approved CTA
    // forms ("The one I take", "So this is where I get my nitric oxide", "I buy this standardised
    // KSM-66...") were scored as violations, and the one form it rewarded is the bare possessive the
    // operator retired on 2026-08-19 for stating ownership instead of endorsement.
    const ctaLine = t.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !URL_RE.test(l)).at(-1) || '';
    const ctaStyle = ctaStyleOf(ctaLine);
    if (ctaStyle.current) add('craft', 'ok', `plug #${i + 1} closes on a first-person recommendation: "${ctaLine.slice(0, 40)}"`);
    else add('craft', 'warn', `plug #${i + 1} closer is "${ctaLine.slice(0, 46)}" — ${ctaStyle.why || 'the law is a first-person recommendation ("I use", "I take", "the one I reach for")'}`);
    if (effLen(t) > 280) add('craft', 'fail', `plug #${i + 1} is ${effLen(t)} chars`);
  }
  if (moves.length >= 2 && new Set(moves).size === 1) add('craft', 'warn', `both plugs open on the same move (${moves[0]}) — they will read as the same ad twice`);
  for (const t of openerTwinIssue(tweets, plugIdx)) add('craft', 'warn', t);
  for (const u of unlinkedSellIssue(tweets)) add('plug', 'fail', u);
  tweets.forEach((t, i) => { const tr = truncationIssue(t); if (tr) add('craft', 'fail', `tweet ${i + 1} ${tr}`); });

  // ---- 5. DID WE KEEP THE MOLD'S SHAPE -----------------------------------------------------------
  if (mold) {
    const items = tweets.flatMap(leadingNumbers).length;
    if (/short BY DESIGN/i.test((mold.requirements || []).join(' ')) && tweets.length > 12) {
      add('mold', 'fail', `${mold.id} is short by design and this ran ${tweets.length} tweets`);
    }
    const maxPlugs = (mold.requirements || []).join(' ').match(/(\w+)\s+plugs?\s+maximum/i);
    const cap = maxPlugs ? ({ one: 1, two: 2, three: 3, four: 4, five: 5 }[maxPlugs[1].toLowerCase()] || Number(maxPlugs[1])) : null;
    if (cap && plugIdx.length > cap) add('mold', 'fail', `${mold.id} allows ${cap} plug(s), this has ${plugIdx.length}`);
    if (items === 0 && /listicle|checklist|shopping|table/i.test(mold.name || '')) {
      add('mold', 'fail', `${mold.id} ("${mold.name}") is a numbered shape and the thread has no numbered items`);
    } else add('mold', 'ok', `${mold.id} shape held (${items} items, ${plugIdx.length} plug(s), ${tweets.length} tweets)`);
  } else {
    // Not a pass. We simply did not look, and saying so is the whole point of this rewrite.
    add('mold', 'warn', 'no moldId on the ledger row — shape fidelity was NOT checked (unchecked, not clean)');
  }

  // ---- 6. HOOK FIDELITY --------------------------------------------------------------------------
  if (donorHook) {
    const att = /(^|\n)\s*\d+[.)]\s/.test(donorHook);
    const sim = Math.round(hookSimilarity(hookBodyText(tweets[0], att), hookBodyText(donorHook, att)) * 100);
    if (sim > 93) add('hook', 'fail', `hook is ${sim}% of the donor — near-identical string`);
    else if (sim < 72) add('hook', 'fail', `hook is only ${sim}% of the donor — the proven asset was thrown away`);
    else if (sim >= 85 && sim <= 90) add('hook', 'ok', `hook at ${sim}% — dead in the band`);
    else add('hook', 'warn', `hook at ${sim}% — inside the gate, outside the 85-90% target`);
  }

  const fails = V.filter((v) => v.level === 'fail').length, warns = V.filter((v) => v.level === 'warn').length;
  return { score: Math.max(0, 100 - fails * 25 - warns * 6), verdicts: V, plugIdx, bodyLen };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const draftId = arg('draft');
  if (!draftId) throw new Error('pass --draft <id>');

  const led = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rows = led.filter((e) => String(e.draftId) === String(draftId));
  const acc = Object.values(ACCOUNTS).find((a) => a.name === rows[0]?.account)
    || Object.values(ACCOUNTS).find((a) => a.name.toLowerCase().includes(String(arg('account') || '~').toLowerCase()));
  if (!acc) throw new Error('cannot resolve the account — pass --account');

  const full = await tf.getDraft(acc.socialSetId, Number(draftId));
  const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
  const catalog = Object.fromEntries((JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || []).map((p) => [p.asin, p]));
  const products = resolveProducts(tweets, { rows, ledger: led, catalog });
  const mold = rows[0]?.moldId ? moldById(rows[0].moldId) : null;

  const res = judgeThread(tweets, { account: acc, products, mold });
  const ICON = { ok: '✓', warn: '·', fail: '✗' };
  console.log(`CTA AUDIT — ${acc.name} draft ${draftId} · ${tweets.length} tweets · ${full.share_url || ''}`);
  console.log(`${full.draft_title}\n`);
  for (const axis of ['position', 'criterion', 'product', 'craft', 'mold', 'hook', 'plug']) {
    const rows2 = res.verdicts.filter((v) => v.axis === axis);
    if (!rows2.length) continue;
    console.log(`  ${axis.toUpperCase()}`);
    for (const v of rows2) console.log(`    ${ICON[v.level]} ${v.msg}`);
  }
  console.log(`\n  SCORE ${res.score}/100 · ${res.verdicts.filter((v) => v.level === 'fail').length} fail · ${res.verdicts.filter((v) => v.level === 'warn').length} warn`);
  if (arg('json') !== null && process.argv.includes('--json')) console.log(JSON.stringify(res, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'cta-audit');
