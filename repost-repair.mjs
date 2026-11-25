// repost-repair.mjs — round two of the automatic repairs for the repost lane.
//
// checks.mjs's repostRepairs does three mechanical moves (unfuse a plug's lead-in, un-stack glued
// sentences, refresh the boilerplate) and after them 8 of 46 bench threads pass the gate. Triaging
// the other 32 showed the failures arrive in COMBINATIONS, not singly: fixing the largest class on
// its own — a missing plug bridge, 12 threads — clears exactly one thread, because those same
// threads also open their ask too late or carry a malformed plug. A repair pass only pays when it
// covers a thread's whole failure set.
//
// So this module adds the remaining mechanical moves, and it lives OUTSIDE checks.mjs for one
// reason: every repair here is sourced from the pod library, and pods.mjs already imports
// substanceTermsFor from checks.mjs. Putting these there would close the cycle.
//
// THE RULE THAT KEEPS THIS HONEST: every move is FAILURE-TRIGGERED. A repair fires only where the
// corresponding gate already refuses the thread — a plug that passes plugStructure is never
// rewritten, a bridge that names its substance is never replaced. These are winners; the body is
// the thing that won and nothing here touches it. The pass can only ever move a thread from
// "refused" toward "shippable", never rewrite one that was already fine.
//
// THE ASK-POSITION MOVE IS DELIBERATELY NOT APPLIED. It is the biggest class (17 threads) and the
// only one where a machine can produce a technically-passing but worse thread: relocating the ask
// moves it into a different part of the argument, so a plug that earned its place after item 4 now
// interrupts after item 2. That is a copy judgement. It comes back as a PROPOSAL with a preview,
// for a human to accept or refuse.
import { PODS, podFitsProduct, variantFor, renderPod } from './pods.mjs';
import { repostRepairs, plugStructure, substanceTermsFor, effLen, isTrackedLink, leadingNumbers, sentenceCount, plugTextLen, PLUG_LIMIT } from './checks.mjs';
import { LAWS } from './laws.mjs';
import { DISCLOSURE, isDisclosed } from './disclosure.mjs';

/** The first library pod that genuinely sells this product's substance, or null. */
export function podForProduct(product) {
  return PODS.find((p) => podFitsProduct(p, product)) || null;
}

/** Where a product's plug tweet sits, or -1. */
const plugIndexOf = (tweets, product) =>
  (tweets || []).findIndex((t) => product?.link && String(t).includes(product.link));

/**
 * How many tweets the first ask spans. Structural, matching thinAskIssue: if the tweet above the
 * plug still carries a numbered item marker then the bridge is fused into the list and the ask is
 * one tweet; a dedicated bridge tweet has no marker, so the ask opens one tweet earlier.
 */
export function askDepth(tweets, plugIdx) {
  if (plugIdx <= 0) return 1;
  return (leadingNumbers(String(tweets[plugIdx - 1] || '')) || []).length ? 1 : 2;
}

/**
 * deepRepostRepairs(tweets, account, products) -> { tweets, applied, proposals, unrepairable }
 *
 * `applied` lists what changed and why, so a triage or a publish log can show which winners had a
 * plug rewritten rather than just asserting the gate passed. `proposals` are the moves a human has
 * to sign off. `unrepairable` names what no move here can reach — a thread arguing a substance it
 * does not sell needs a product decision, not a repair.
 */
export function deepRepostRepairs(tweets = [], account = null, products = [], { maxThread = LAWS.tweet.maxThread, source = null } = {}) {
  const applied = [];
  const proposals = [];
  const unrepairable = [];
  const key = account?.key || null;
  let out = repostRepairs(tweets, account, products, { source }); // the three base moves first

  const live = (products || []).filter((p) => p?.link);

  // ---- MOVE 3.5: no one-sentence bridge, ever (operator 2026-09-06) -----------------------------
  // "Where did this type of 1 sentence bridge creep back in from? ... this will just waste our
  // money." From here. The previous MOVE 3.5 LIFTED the plug's first sentence into its own tweet to
  // satisfy the bridge law, and that manufactured exactly the shape the operator banned: a bare
  // "Silent inflammation was the hidden factor in those sudden heart attacks." standing alone above
  // the ask, on four queued attempts (Eleanor, Marcos twice, Jasper, 2026-09-06). A bridge is three
  // lines — the wrong form, what it costs, "So this is what I look for ↓" — and the library holds
  // one for every substance we sell, so the move now builds the operator's three beats instead:
  //
  //   · a one-sentence ORPHAN above the plug (an older lift, or an origin that was written that
  //     way, like Julian's Aug-26 D3+K2 thread) rejoins the plug when the whole fits — that is the
  //     author's own tweet restored. When it does not fit, the orphan plus the plug's lead-in
  //     become the POINT, the pod's bridge goes between them and the ask, and MOVE 5 restores the
  //     plug's shape from the library if a beat went missing.
  //   · a COLD plug whose own lead-in runs two sentences or more: the lead-in becomes the point, the
  //     pod bridge follows. A one-sentence lead-in stays inside the plug and MOVE 4 gives the plug
  //     the library bridge above it — the reader arrives holding the criterion either way.
  //
  // thinBridgeIssue (checks.mjs) refuses whatever this cannot reach, on every path. The hook is
  // never touched: index 0 is the donor's words and the reason the thread won.
  const hasLink = (t) => /https?:\/\/\S+/.test(String(t));
  // A wall (two sentences sharing a paragraph) is not a bridge either: bridgeWallIssue refuses it,
  // and the base unstack leaves a 279-character tweet stacked because the blank lines would not fit.
  const walled = (t) => String(t).split(/\n\n+/).some((par) => !/\n/.test(par) && sentenceCount(par) >= 2);
  const isBridged = (prev, terms) => !hasLink(prev) && sentenceCount(prev) >= 2 && !walled(prev) && terms.some((s) => String(prev).toLowerCase().includes(s));
  const podBridge = (p) => { const pod = podForProduct(p); const bridge = pod && key ? String(variantFor(pod, key)?.bridge || '').trim() : ''; return { pod, bridge }; };
  for (let n = live.length - 1; n >= 0; n--) {
    const p = live[n];
    const i = plugIndexOf(out, p);
    if (i <= 1) continue;                                   // a plug at tweet 2 has only the hook above it
    const terms = substanceTermsFor(p);
    if (!terms.length) continue;
    const prev = String(out[i - 1]);
    const orphan = !hasLink(prev) && sentenceCount(prev) < 2 && !(leadingNumbers(prev) || []).length;
    const paras = String(out[i]).split(/\n\n+/).map((x) => x.trim()).filter(Boolean);
    const lead = paras.length >= 3 && !hasLink(paras[0]) && !/#ad|aff\s*link/i.test(paras[0]) && terms.some((tm) => paras[0].toLowerCase().includes(tm)) ? paras[0] : null;
    if (orphan) {
      const merged = `${prev}\n\n${out[i]}`;
      // Rejoining is right only when what would then stand above the plug is a real bridge, and
      // when the first ask does not slide out of its window: Julian's Aug-26 D3+K2 thread carries
      // its orphan at T3 above a plug at T4, and the merge would open the ask at T2 with a stacked
      // "I became happier. I laughed more." tweet for a bridge. That thread takes the point-split.
      const above = String(out[i - 2] ?? '');
      const firstPlug = !out.slice(0, i - 1).some(hasLink);
      const opensAt = i - (askDepth(out, i - 1) - 1); // 1-based tweet the ask would open on after the merge
      const fits = effLen(merged) <= LAWS.tweet.limit && plugTextLen(merged) <= PLUG_LIMIT;
      if (fits && isBridged(above, terms) && (!firstPlug || opensAt >= (LAWS.plugs?.firstAt ?? 3))) {
        out.splice(i - 1, 2, merged);
        applied.push({ move: 'orphan-merge', at: i, note: 'the one-sentence tweet above the plug rejoined it — the lift that split them is gone' });
        continue;
      }
      const { pod, bridge } = podBridge(p);
      if (!bridge) { unrepairable.push(`a one-sentence tweet stands above plug #${i + 1} and no library bridge covers ${terms[0]}`); continue; }
      const point = lead ? `${prev}\n\n${lead}` : prev;
      const rest = lead ? paras.slice(1).join('\n\n') : String(out[i]);
      if (effLen(point) > LAWS.tweet.limit) { unrepairable.push(`the point above plug #${i + 1} would exceed ${LAWS.tweet.limit} chars`); continue; }
      if (out.length + 1 > maxThread) { unrepairable.push(`no room for a bridge before plug #${i + 1} (thread is at the ${maxThread}-tweet ceiling)`); continue; }
      out.splice(i - 1, 2, point, bridge, rest);
      applied.push({ move: 'point-split', at: i, pod: pod.id, note: `the one-sentence tweet and the plug's ${terms[0]} lead-in became the point; the ${pod.id} bridge now stands between them and the ask` });
      continue;
    }
    if (isBridged(prev, terms)) continue;                   // a real bridge already stands above the plug
    if (!lead || sentenceCount(lead) < 2) continue;          // nothing to build a point from; MOVE 4 bridges the cold plug
    const { pod, bridge } = podBridge(p);
    if (!bridge) continue;                                   // MOVE 4 reports the missing pod
    if (out.length + 2 > maxThread) continue;
    out.splice(i, 1, lead, bridge, paras.slice(1).join('\n\n'));
    applied.push({ move: 'point-split', at: i + 1, pod: pod.id, note: `the plug's own ${terms[0]} lead-in became the point; the ${pod.id} bridge now stands between it and the ask` });
  }

  // ---- MOVE 4: give a cold plug its bridge ------------------------------------------------------
  // plugSubstanceBridgeIssue refuses a plug whose prior tweet never names the substance. The pod
  // library already holds a written bridge for every substance we sell, so the repair is to splice
  // that one tweet in. The RAW variant bridge is used rather than renderPod's, because renderPod
  // prefixes an entry label meant for a numbered host item — inserting one mid-thread would invent
  // an item that the hook never promised. "Bridged" means a real bridge (two sentences or more that
  // name the substance), not any tweet that happens to mention it: a one-sentence item above the
  // ask gets the library bridge between itself and the plug (operator 2026-09-06).
  for (let n = live.length - 1; n >= 0; n--) {
    const p = live[n];
    const i = plugIndexOf(out, p);
    if (i <= 0) continue;
    const terms = substanceTermsFor(p);
    if (!terms.length) continue;
    if (isBridged(String(out[i - 1]), terms)) continue;      // a real bridge already stands above the plug
    if (out.length >= maxThread) { unrepairable.push(`no room for a bridge before plug #${i + 1} (thread is at the ${maxThread}-tweet ceiling)`); continue; }
    const pod = podForProduct(p);
    const bridge = pod && key ? String(variantFor(pod, key)?.bridge || '').trim() : '';
    if (!bridge) { unrepairable.push(`no library bridge for ${terms[0]} (plug #${i + 1}) — needs a pod or a hand-written tweet`); continue; }
    out.splice(i, 0, bridge);
    applied.push({ move: 'bridge-insert', at: i + 1, pod: pod.id, note: `inserted a ${terms[0]} bridge before the plug` });
  }

  // ---- MOVE 5: fix the plug's SHAPE, cheapest repair first --------------------------------------
  // These are threads that won. A full rebuild replaces the author's proven copy, so it is the last
  // resort, not the first: two of the three shape defects are pure formatting and have an exact fix
  // that changes no words at all. Measured on the bench, that is the difference between rewriting
  // 15 winning plugs and rewriting 2.
  for (const p of live) {
    const i = plugIndexOf(out, p);
    if (i < 0) continue;

    // 5a. the link sits ON the disclosure line. plugStructure splits beats on blank lines, so
    // "Aff link:\nhttps://..." is one beat holding both. A blank line between them is the whole fix.
    if (plugStructure(out[i]).failed === 'disclosure-stacked') {
      const split = out[i].replace(new RegExp(`([^\\n])\\n(${p.link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`), '$1\n\n$2');
      // The blank line is one more character, and a plug sitting exactly at the limit goes over it.
      // Two Magnus reposts landed at 281 that way — the repair itself creating the violation the
      // gate then refused. Better to leave the defect standing and say so.
      if (split !== out[i] && plugStructure(split).ok && effLen(split) <= LAWS.tweet.limit) {
        out[i] = split;
        applied.push({ move: 'disclosure-unstack', at: i + 1, note: 'link moved off the disclosure line onto its own' });
      } else if (split !== out[i] && effLen(split) > LAWS.tweet.limit) {
        unrepairable.push(`plug #${i + 1} stacks its link on the disclosure line and is at the ${LAWS.tweet.limit}-char ceiling — needs a word cut`);
      }
    }

    // 5b. no disclosure at all. The line is required by law, not by taste, and inserting it above
    // the link leaves every word of the author's copy intact.
    if (!isDisclosed(out[i])) {
      const withDisc = out[i].replace(p.link, `${DISCLOSURE}\n\n${p.link}`);
      if (effLen(withDisc) <= LAWS.tweet.limit) {
        out[i] = withDisc;
        applied.push({ move: 'disclosure-add', at: i + 1, note: 'affiliate disclosure added above the link' });
      } else unrepairable.push(`plug #${i + 1} has no disclosure and no room to add one`);
    }

    // 5c. a beat short, because MOVE 3.5 lifted the lead-in out. The bare "Aff link:" form demands
    // exactly three sentences above it; the CTA-carrying form ("This is the magnesium I take (#ad):")
    // allows two. So the cheapest legal repair is to swap ONE line — the disclosure — for the pod's
    // own CTA, and keep both of the author's remaining sentences. Rebuilding the whole plug here
    // would throw away an opener and a middle that a winning thread earned, to fix a line count.
    if (plugStructure(out[i]).failed === 'merged-lines') {
      const beats = String(out[i]).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
      const dIdx = beats.findIndex((b) => /aff\s*link|#ad|affiliate|commission/i.test(b));
      const bare = dIdx >= 0 && beats[dIdx].replace(/\(?\s*(aff(iliate)?\s*link|#ad|commission)s?\s*\)?/ig, ' ').replace(/[^a-z0-9]+/ig, '').length === 0;
      const pod5c = podForProduct(p);
      const cta = pod5c && key ? String(variantFor(pod5c, key)?.cta || '').replace(/:\s*$/, '') : '';
      if (bare && cta) {
        const swapped = [...beats.slice(0, dIdx), `${cta}:`, ...beats.slice(dIdx + 1)].join('\n\n');
        if (plugStructure(swapped).ok && effLen(swapped) <= LAWS.tweet.limit) {
          out[i] = swapped;
          applied.push({ move: 'cta-line', at: i + 1, pod: pod5c.id, note: "bare disclosure swapped for the pod's CTA line, author's sentences kept" });
        }
      }
    }

    // 5d. still malformed — the beats themselves are wrong, which no reformatting reaches. Swap in
    // the library plug: the proven three-beat shape in this account's own voice, carrying the
    // repost's freshly minted link verbatim.
    const verdict = plugStructure(out[i]);
    if (verdict.ok) continue;
    const pod = podForProduct(p);
    const rebuilt = pod && key ? renderPod(pod, key, p.link, { compact: true })?.plug : null;
    if (!rebuilt) { unrepairable.push(`plug #${i + 1} is malformed (${verdict.failed}) and no library pod covers ${p.asin || p.title || 'it'}`); continue; }
    if (effLen(rebuilt) > LAWS.tweet.limit) { unrepairable.push(`plug #${i + 1} rebuild would exceed ${LAWS.tweet.limit} chars`); continue; }
    out[i] = rebuilt;
    applied.push({ move: 'plug-rebuild', at: i + 1, pod: pod.id, note: `plug failed on "${verdict.failed}" — replaced with the library shape` });
  }

  // ---- MOVE 6: house style ----------------------------------------------------------------------
  // An em dash is a rule, not a judgement call.
  out = out.map((t, i) => {
    if (!/[—–]/.test(t)) return t;
    applied.push({ move: 'dash', at: i + 1, note: 'em/en dash replaced' });
    return t.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ');
  });

  // ---- PROPOSAL: move the ask into the tweet-3/4 band -------------------------------------------
  // Not applied. See the header. The proposal carries the exact block that would move and what it
  // would land between, so the judgement can be made by reading rather than by running the diff.
  const fp = out.findIndex((t) => (String(t).match(/https?:\/\/\S+/g) || []).some(isTrackedLink));
  if (fp > 0) {
    const depth = askDepth(out, fp);
    const opens = fp - (depth - 1);
    const lo = LAWS.plugs.firstAt;
    const hi = lo + 1;
    const openTweet = opens + 1; // 1-based, the number a reader counts
    if (openTweet < lo || openTweet > hi) {
      const block = out.slice(opens, fp + 1);
      const target = Math.max(1, lo - 1); // 0-based index the block would start at
      proposals.push({
        move: 'ask-position',
        from: openTweet,
        to: lo,
        depth,
        why: openTweet > hi
          ? `the ask opens at tweet ${openTweet}; $/1k roughly halves past tweet 4`
          : `the ask opens at tweet ${openTweet}, before the thread has earned it`,
        block: block.map((t) => String(t).split('\n')[0].slice(0, 72)),
        landsAfter: target > 0 ? String(out[target - 1] || '').split('\n')[0].slice(0, 72) : '(the hook)',
        displaces: String(out[target] || '').split('\n')[0].slice(0, 72),
      });
    }
  }

  return { tweets: out, applied, proposals, unrepairable };
}

/** Apply a proposal a human accepted. Separate on purpose: accepting is an act, not a default. */
export function applyAskMove(tweets = [], proposal = null) {
  if (!proposal || proposal.move !== 'ask-position') return [...tweets];
  const out = [...tweets];
  const opens = proposal.from - 1;
  const span = proposal.block.length;
  const block = out.splice(opens, span);
  const target = Math.max(1, proposal.to - 1);
  out.splice(target, 0, ...block);
  return out;
}
