// retrofit-brief.mjs — everything you need to turn ONE archived draft into a shippable, monetized
// thread. The companion to thread-brief: that one briefs a thread you are about to write, this one
// briefs a thread that already exists and only needs its money layer rebuilt.
//
// The premise (operator, 2026-08-17): most of the archive is fine. The body is written, the hook
// already proved itself, the voice is right. What is wrong is the product, the run-up to the plug,
// and the CTA. Those three are a bounded job, and fixing them is far cheaper than writing new.
//
// It prints, in the order you need it:
//   0. RESCUE CHECK   — is this worth doing at all (duplicate hook, foreign CTA, dead link)
//   1. THE THREAD     — every tweet, numbered, with current plug positions marked
//   2. PLUG BUDGET    — how many CTAs this length supports, and which slots are legal
//   3. PRODUCTS       — what it plugs now, and what the TEXT can honestly host (bridge-gated)
//   4. BRIDGE ROUTE   — per candidate slot: can we retarget an existing point, or must we add one
//   5. MOVES          — opener moves already used on this account recently, so the batch varies
//
//   node retrofit-brief.mjs --draft 10154532
//   node retrofit-brief.mjs --account lorenzo --worklist    # rank the archive by what to fix first
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import {
  bridgeableProducts, substanceTermsFor, plugBudget, isTrackedLink, effLen, plugTextLen,
  isSignedTweet, BRIDGE,
} from './checks.mjs';
import { recentAsinUse, classifyTopic } from './pick-product.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_RE = /https?:\/\/\S+/g;

// A thread that still carries the DONOR's call to action is not a monetization problem, it is a
// correctness problem: we would be sending our audience to someone else's funnel. These are the
// shapes that show up in the swipe file. Pure + testable.
// Widened 2026-08-28 after a top-40 audit of the swipe pool: the original list caught 1 of the 10
// funnel shapes actually present. The misses were not exotic — a competitor plug with a discount
// code, a coaching application, a follow-me tail, a newsletter pitch, a "watch the podcast" link.
// Each alternative below is anchored tightly enough not to fire on ordinary body copy: "my program"
// and a bare "subscribe" are deliberately NOT here, because a fitness thread says both innocently.
const FOREIGN_CTA_RE = new RegExp([
  // lead magnets and events
  'free (?:\\w+ )?(?:quiz|training|masterclass|webinar|guide|challenge|workshop|tool|course)',
  'take my ', 'join me (?:live|on)', 'live (?:thursday|friday|monday|tuesday|wednesday)',
  'register (?:here|now)', 'save your seat', 'spots? (?:are )?limited', 'enroll(?:ment)? (?:now|here)',
  '\\d{1,2}\\s?(?:am|pm)\\s?et\\b',
  // direct funnels
  'link in bio', 'dm me ', 'sign up (?:here|below)', 'click here',
  'apply (?:for|now|here)\\b', '\\b(?:1|one) on (?:1|one)\\b',
  'schedule a (?:call|audit|consult|session)', 'book a (?:call|consult|session)',
  // owned-media pitches
  'my (?:\\w+ )?(?:newsletter|community|cohort|masterclass|ebook|e-book|workshop|challenge)\\b',
  'watch the full (?:podcast|video|episode|interview)',
  // follow / repost tails
  'follow @[A-Za-z0-9_]+', '(?:retweet|repost) the first (?:post|tweet)',
  // a competitor's own affiliate offer
  '(?:use|with) (?:my )?(?:code|promo)\\b', 'discount code',
].join('|'), 'i');
export function foreignCtaIssue(tweets, account = {}) {
  const hits = [];
  (tweets || []).forEach((t, i) => {
    if (t === account.closing || t === account.disclaimer) return;
    const m = String(t).match(FOREIGN_CTA_RE);
    if (m) hits.push({ tweet: i + 1, phrase: m[0] });
  });
  return hits;
}

// Pure: which tweets carry a tracked plug, and which slots could legally take one.
// A plug may not sit adjacent to another, may not be the hook, and must clear the sign-off block.
export function plugSlots(tweets, account = {}) {
  const current = [];
  (tweets || []).forEach((t, i) => { if ((String(t).match(URL_RE) || []).some(isTrackedLink)) current.push(i + 1); });
  const tail = (tweets || []).findIndex((t) => isSignedTweet(t, account));
  const lastBody = tail > 0 ? tail : (tweets || []).length; // 1-based index of the last plug-eligible tweet
  const legal = [];
  for (let n = 3; n <= lastBody; n++) {
    if (current.includes(n - 1) || current.includes(n + 1)) continue; // never adjacent to an existing plug
    legal.push(n);
  }
  return { current, legal, lastBody };
}

// Pure: for a product and a proposed plug slot, can the tweet BEFORE it already carry the bridge, or
// does the run-up have to be rewritten? "retarget" means the prior tweet is already about a topic
// this substance belongs to and one closing sentence lands it. "insert" means it is not, and the
// point itself has to change. Exported for tests.
export function bridgeRoute(tweets, slot, product) {
  const prior = String(tweets[slot - 2] || '');
  const terms = substanceTermsFor(product);
  if (terms.some((t) => prior.toLowerCase().includes(t))) return { route: 'ready', why: 'the prior tweet already names the substance' };
  // Does the prior tweet at least sit in a topic this substance plausibly belongs to? If so we can
  // land it with one added sentence rather than rewriting the point.
  const topical = [...bridgeableProducts(prior)].includes(product.asin);
  return topical
    ? { route: 'retarget', why: 'the prior tweet is on-topic — close it on the substance in one sentence' }
    : { route: 'insert', why: 'the prior tweet is off-topic — change the POINT to be about this substance, or move the plug' };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const draftId = arg('draft');
  if (!draftId) throw new Error('pass --draft <id>');

  const led = [];
  for (const l of readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    try { led.push(JSON.parse(l)); } catch {}
  }
  const mine = led.filter((e) => String(e.draftId) === String(draftId));
  const acc = Object.values(ACCOUNTS).find((a) => a.name === mine[0]?.account)
    || Object.values(ACCOUNTS).find((a) => a.name.toLowerCase().includes(String(arg('account') || '~none~').toLowerCase()));
  if (!acc) throw new Error('could not resolve the account — pass --account');

  const full = await tf.getDraft(acc.socialSetId, Number(draftId));
  const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
  const text = tweets.join('\n');

  console.log(`RETROFIT BRIEF — ${acc.name} draft ${draftId} · ${tweets.length} tweets`);
  console.log(`  ${full.share_url || ''}`);
  console.log(`  status ${full.status} · created ${String(full.created_at).slice(0, 10)} · topic ${classifyTopic(tweets[0] || '')}\n`);

  // 0. RESCUE CHECK ------------------------------------------------------------------------------
  const foreign = foreignCtaIssue(tweets, acc);
  const dupHooks = led.filter((e) => e.draftId && String(e.draftId) !== String(draftId));
  console.log('0. RESCUE CHECK');
  if (foreign.length) for (const f of foreign) console.log(`   ✗ FOREIGN CTA in tweet ${f.tweet}: "${f.phrase}" — that is the donor's funnel, strip it`);
  const oldLinks = [...new Set((text.match(URL_RE) || []))].filter(isTrackedLink);
  if (oldLinks.length) console.log(`   ⚠ ${oldLinks.length} existing tracked link(s) — RE-MINT, never reuse: an old subid merges this thread's revenue with the thread it was minted for`);
  if (!foreign.length && !oldLinks.length) console.log('   ✓ nothing disqualifying');
  console.log('');

  // 1. THE THREAD --------------------------------------------------------------------------------
  const slots = plugSlots(tweets, acc);
  console.log('1. THE THREAD  (▸ = carries a tracked plug today)');
  tweets.forEach((t, i) => {
    const n = i + 1;
    const mark = slots.current.includes(n) ? '▸' : ' ';
    console.log(`  ${mark}[${String(n).padStart(2)}] ${effLen(t)}c  ${t.replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
  });
  console.log('');

  // 2. PLUG BUDGET -------------------------------------------------------------------------------
  const base = tweets.length - slots.current.length;
  const cands = [...bridgeableProducts(text, { hook: tweets[0] || '' })]; // Set; hook gates the symptom words
  const budget = plugBudget(base, { products: cands.length });
  console.log('2. PLUG BUDGET');
  console.log(`   base length ${base} → budget ${budget} plug(s)  (minimum 2, maximum 5)`);
  console.log(`   currently plugged at: ${slots.current.join(', ') || 'nowhere'}`);
  console.log(`   legal slots (never adjacent, never the hook, clear of the sign-off at ${slots.lastBody}): ${slots.legal.join(', ') || 'none'}`);
  console.log('');

  // 3. PRODUCTS ----------------------------------------------------------------------------------
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const used = recentAsinUse(acc.name, { days: 7 });
  console.log('3. PRODUCTS THIS TEXT CAN HONESTLY HOST (bridge-gated on the thread\'s own words)');
  if (mine[0]?.asin) console.log(`   plugged today: ${mine.map((m) => `${m.asin} (${m.product || ''})`.slice(0, 70)).join(' · ')}`);
  if (!cands.length) console.log('   (none — this thread names no allowlist substance; retarget a point or leave it unmonetized)');
  for (const asin of cands) {
    const p = byAsin.get(asin);
    const n = used[asin] || 0;
    console.log(`   ${asin}  ${String(p?.commission ?? p?.commissionRate ?? '?').padStart(5)}%  ${n ? `used ${n}x/7d` : 'unused this week'}  ${String(p?.title || '').slice(0, 58)}`);
  }
  console.log('');

  // 4. BRIDGE ROUTE ------------------------------------------------------------------------------
  console.log('4. BRIDGE ROUTE PER SLOT  (ready = prior tweet already lands it · retarget = one sentence · insert = change the point)');
  for (const asin of cands.slice(0, 3)) {
    const p = byAsin.get(asin) || { asin };
    const terms = substanceTermsFor(p);
    console.log(`   ${asin} [${terms.slice(0, 4).join(', ')}]`);
    for (const s of slots.legal.slice(0, 12)) {
      const r = bridgeRoute(tweets, s, p);
      if (r.route === 'insert') continue; // only show the slots worth using
      console.log(`      slot ${String(s).padStart(2)} → ${r.route.toUpperCase().padEnd(8)} ${r.why}`);
    }
  }
  console.log('');

  // 5. MOVES -------------------------------------------------------------------------------------
  const recent = led.filter((e) => e.account === acc.name && Array.isArray(e.plugMoves))
    .slice(-12).flatMap((e) => e.plugMoves);
  const tally = {};
  for (const m of recent) tally[m] = (tally[m] || 0) + 1;
  console.log('5. OPENER MOVES USED RECENTLY ON THIS ACCOUNT (vary across the batch, not just within one thread)');
  console.log(`   ${Object.entries(tally).map(([m, n]) => `${m} ${n}x`).join(' · ') || '(none recorded)'}`);
  const ALL = ['objection', 'admission', 'failure-mode', 'personal-limit', 'form-declaration', 'conditional-usage', 'sourcing-question'];
  console.log(`   unused: ${ALL.filter((m) => !tally[m]).join(', ') || '(all used — pick on fit)'}`);
  console.log(`\n   suggested subid stem: x-thread-${Object.entries(ACCOUNTS).find(([, a]) => a.name === acc.name)?.[0]}-${String(tweets[0] || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 52)}-rf`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'retrofit-brief');
