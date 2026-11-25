// assemble.mjs — turn slot FILLS into a thread. Code owns every structural decision.
//
// The counterpart of compileSkeleton (outline.mjs). The writer returns prose per slot — plugs as
// {opener, middle, cta} fields — and this module does the joining: blank lines between beats, the
// disclosure riding the CTA line, the bare link alone at the end. Merged plug lines (18 of 26
// threads in the measured batches) and doubled disclosures ("Aff link:" + "#ad:" stacked) cannot be
// written at all through this path, because the writer never emits that region of text.
//
// Pure: no LLM, no network, no writes. Issues come back structured {slot, code, msg} so a caller
// can retry EXACTLY the failing slots instead of regenerating the thread.
import { effLen, stripEmDash, leadingNumbers, TWEET_LIMIT, PLUG_LIMIT, COMMERCIAL_ASK_RE, looksLikeCriterion, substanceTermsFor } from './checks.mjs';
import { DISCLOSURE, DISCLOSURE_LINE_RE } from './disclosure.mjs';
import { LAWS } from './laws.mjs';

/** One field: trimmed, em-dash-free, internal blank lines collapsed (beat boundaries are OURS). */
const cleanField = (v) => stripEmDash(String(v ?? '').trim()).replace(/\n{2,}/g, '\n');

/**
 * Pure: {opener, middle, cta} + link -> the canonical plug tweet.
 * Beats joined by blank lines, disclosure guaranteed ON the CTA line, bare link last and alone.
 */
export function buildPlugTweet(fields = {}, { link = '', own = false } = {}) {
  const issues = [];
  const o = cleanField(fields.opener), m = cleanField(fields.middle);
  let c = cleanField(fields.cta).replace(/\s*:\s*$/, '');
  if (!o) issues.push('opener is empty');
  if (!m) issues.push('middle is empty');
  if (!c) issues.push('cta is empty');
  for (const [name, v] of [['opener', o], ['middle', m], ['cta', c]]) {
    if (/https?:\/\//i.test(v)) issues.push(`${name} contains a URL — the link is appended by code, never written`);
  }
  // REVERSED 2026-09-03. This block used to argue for a standalone `#ad` beat on the grounds that
  // parenthesising a hashtag suppresses it as a tag. That tag effect may well be real, and it is not
  // the deciding question: the operator ruled for the inline form (cta-spec.md §4, "#ad is same line
  // as the last item"), because a CTA that discloses inline IS the closing beat and so satisfies all
  // three plug gates at once, where a bare disclosure line demands three beats ahead of it and broke
  // 34 of 36 plugs. 311 inline disclosures have shipped from the pod library since. Losing the
  // clickable tag is the accepted cost; disclosure adjacency is what the line is for.
  // An own-product (gumroad) CTA is FIRST-PARTY: "Get it here:" carries no disclosure by law
  // (checks.mjs, 2026-08-10), so it keeps the 3-beat shape with no disclosure line at all.
  let disc = DISCLOSURE;
  if (own) {
    if (!/get it here/i.test(c)) c = c ? `${c}. Get it here` : 'Get it here';
    disc = '';
  }
  c = c.replace(/\s*\(\s*aff\s*link\s*\)\s*/i, ' ').trim();   // strip a retired inline token if the writer emitted one
  if (DISCLOSURE_LINE_RE.test(c)) disc = '';                      // writer already put a disclosure in the CTA — don't double it
  const text = [o, m, `${c}:`, disc, String(link || '').trim()].filter(Boolean).join('\n\n');
  const textLen = effLen([o, m, `${c}:`, disc].filter(Boolean).join('\n\n'));
  if (textLen > PLUG_LIMIT) issues.push(`plug text is ${textLen} chars before the link (max ${PLUG_LIMIT}) — trim the middle beat first`);
  return { text, issues, len: effLen(text) };
}

/**
 * Pure: skeleton + fills -> { tweets, issues[] }.
 * `fills` is keyed by slot number (number or string). Plug slots take field objects; everything else
 * takes a string. The signoff/disclaimer slots are skipped — the engine appends the account's own
 * literal lines, exactly as the non-slot path always has.
 */
export function assembleThread(skeleton, fills = {}, { products = [] } = {}) {
  const linkByAsin = Object.fromEntries(products.filter((p) => p?.asin && p?.link).map((p) => [p.asin, p.link]));
  const tweets = [];
  const issues = [];
  const say = (slot, code, msg) => issues.push({ slot, code, msg });

  for (const s of skeleton.slots) {
    if (s.kind === 'signoff' || s.kind === 'disclaimer') continue;
    const fill = fills[s.n] ?? fills[String(s.n)];

    if (s.kind === 'plug') {
      if (!fill || typeof fill !== 'object' || Array.isArray(fill)) {
        say(s.n, 'missing-plug-fields', `slot ${s.n} needs an object with ${s.fields.join('/')} for ${s.asin}`);
        continue;
      }
      const link = linkByAsin[s.asin] || '';
      if (!link) say(s.n, 'no-link', `no minted link for ${s.asin} — the plug cannot ship`);
      // THE CRITERION IS PLACED BY CODE (2026-08-18). Four batches of "criterion after the CTA"
      // shared one architectural cause: the criterion was the only load-bearing beat without its
      // own slot — an instruction riding the tail of someone else's tweet, and riders lose. Now it
      // is a field of the plug, and the assembler welds it to the END of the tweet BEFORE the plug.
      // "After the CTA" is no longer expressible through this path.
      if (!s.fields.includes('criterion')) {
        // Listicle lanes carry the criterion in the SUBSTANCE SLOT (its own tweet, handled below);
        // only a roundup still welds a one-line criterion onto its item's tail.
      } else {
      const crit = cleanField(fill.criterion);
      if (!crit) {
        say(s.n, 'plug-field', 'criterion is empty — one sentence: what separates the real version from the shelf junk');
      } else if (/https?:\/\//i.test(crit)) {
        say(s.n, 'plug-field', 'criterion contains a URL — it is a body sentence, never a link');
      } else if (!looksLikeCriterion(crit, { asin: s.asin, title: s.title })) {
        say(s.n, 'plug-field', `criterion does not discriminate ("${crit.slice(0, 48)}") — name the FORM to buy or the alternative to avoid, not praise`);
      } else if (!tweets.length) {
        say(s.n, 'plug-field', 'no prior tweet to carry the criterion — the slot before this plug came back empty');
      } else {
        const host = tweets.length - 1;
        const merged = `${tweets[host]}\n\n${crit}`;
        if (effLen(merged) > TWEET_LIMIT) {
          say(s.n, 'criterion-over-limit', `the tweet before the plug lands at ${effLen(merged)} chars with the criterion attached (max ${TWEET_LIMIT}) — return a shorter criterion`);
        } else {
          tweets[host] = merged;
        }
      }
      }
      const built = buildPlugTweet(fill, { link, own: /gumroad\.com/i.test(link) });
      for (const msg of built.issues) say(s.n, 'plug-field', msg);
      tweets.push(built.text);
      continue;
    }

    const t = stripEmDash(String(fill ?? '').trim());
    if (!t) { say(s.n, 'missing', `slot ${s.n} (${s.kind}${s.item != null ? `, item ${s.item}` : ''}) came back empty`); continue; }
    if (s.kind === 'substance') {
      // The pod's middle tweet. Content-gated the same way the welded criterion was: it must NAME
      // the substance and it must DISCRIMINATE — end-of-tweet "what to look for" is the criterion
      // the plug then answers. Praise alone is refused, an ask is refused (it is not the plug).
      const terms = substanceTermsFor({ asin: s.asin, title: s.title });
      if (/https?:\/\//i.test(t)) say(s.n, 'substance-slot', `slot ${s.n} carries a URL — the substance tweet is body, never a plug`);
      else if (/aff\s*link|#ad\b/i.test(t) || COMMERCIAL_ASK_RE.test(t)) say(s.n, 'substance-slot', `slot ${s.n} makes an ask — the substance tweet educates; the NEXT slot sells`);
      else if (terms.length && !terms.some((x) => t.toLowerCase().includes(x))) say(s.n, 'substance-slot', `slot ${s.n} never names ${terms[0]} — the substance tweet must name its substance plainly`);
      else if (!looksLikeCriterion(t, { asin: s.asin, title: s.title })) say(s.n, 'substance-slot', `slot ${s.n} does not end on what to LOOK FOR — name the form/standard that separates the real thing from shelf junk`);
      if (effLen(t) > TWEET_LIMIT) say(s.n, 'over-limit', `slot ${s.n} is ${effLen(t)} chars (max ${TWEET_LIMIT})`);
      tweets.push(t);
      continue;
    }
    if (/https?:\/\//i.test(t)) say(s.n, 'url-in-body', `slot ${s.n} carries a URL — only plug slots may sell, and even they never write the link`);
    if (/aff\s*link|#ad\b/i.test(t) || COMMERCIAL_ASK_RE.test(t)) say(s.n, 'sell-in-body', `slot ${s.n} makes a commercial ask — selling belongs in plug slots, where the link is; anywhere else it earns nothing and reads as spam`);
    if (s.item != null) {
      const got = leadingNumbers(t)[0] ?? null;
      if (got !== s.item) say(s.n, 'renumbered', `slot ${s.n} must stay item ${s.item} (came back ${got === null ? 'unnumbered' : `as item ${got}`})`);
    }
    if (effLen(t) > TWEET_LIMIT) say(s.n, 'over-limit', `slot ${s.n} is ${effLen(t)} chars (max ${TWEET_LIMIT})`);
    tweets.push(t);
  }
  return { tweets, issues };
}

/** Extract the writer's JSON object (fills keyed by slot number) from raw model output. */
export function parseSlotFills(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON object in the writer's output:\n${String(raw).slice(0, 300)}`);
  return JSON.parse(m[0]);
}
