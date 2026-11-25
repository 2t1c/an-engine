// cta-patterns.mjs — what converts, by PART of the plug rather than by exact sentence.
//
// Why (owner 2026-10-04, option "b"): the recipe learner in cta-learning-core.mjs compares exact
// (question, closer) sentences from the pod library. In its first live run on the new click source
// (2026-10-03) it saw 751 valid plugs spread over 549 distinct wordings, only 9 of them library text
// and all 9 the default itself, so no comparison could ever form. The same 751 plugs carry plenty of
// evidence about the PARTS they share: whether the plug opens on a question, whether the result is
// dated, whether the closer names a routine, whether the lead-in tweet ends on an arrow.
//
// Method. Each plug is reduced to a set of binary features (FEATURES below: fixed patterns over
// positions and words, counted by code). For each feature, plugs WITH it are compared to plugs
// WITHOUT it inside the same stratum (same product, slot and account, so a feature that merely
// rides on a high-clicking product or account earns nothing), and the strata are pooled with the Mantel-Haenszel rate
// ratio of clicks per view. Thread-level virality makes clicks far more dispersed than Poisson, so
// the interval is a seeded cluster bootstrap over threads, not a Poisson formula. A feature is
// "better" only when the lower bound of its 90% interval clears +10%, on enough threads, accounts,
// weeks and views, without one thread carrying the result, and without a measured conversion loss.
//
// This is observational: writers chose these features, the threads were not randomized. The
// thresholds are operating defaults in PATTERN_RULES, beside the code that applies them.
export const PATTERN_RULES = Object.freeze({
  minThreadsEachSide: 10, minAccounts: 3, minWeeks: 2, minViewsEachSide: 20000, minStrata: 3,
  maxThreadClickShare: 0.5, minLift: 0.10, bootstrapReps: 400, seed: 20261004,
  // Conversion guard: judged only when both sides carry this many orders; a click lift that loses
  // more than 15% of the conversion rate is not a win.
  minOrdersForCvr: 5, minCvrRetention: 0.85, // same band as CTA_LEARNING_RULES.minAffiliateRetention
});

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const URL_LINE = /^(?:https?:\/\/\S+|\{\{LINK\d*\}\})$/i;

/** Split a plug tweet into criterion (first line), middle lines and the closer (the "(#ad)" line). */
export function plugParts(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !URL_LINE.test(l));
  const ctaAt = lines.findLastIndex((l) => /#ad\b/i.test(l));
  const cta = ctaAt >= 0 ? lines[ctaAt] : '';
  const body = ctaAt >= 0 ? lines.slice(0, ctaAt) : lines;
  return { criterion: body[0] || '', middle: body.slice(1).join(' '), cta, words: lines.join(' ').split(/\s+/).filter(Boolean).length };
}
const lastLine = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) || '';
// The closer with its disclosure and trailing punctuation removed, for verb and tail checks.
const closer = (cta) => cta.replace(/\(?\s*#ad\s*\)?\s*[:.!?]*\s*$/i, '').trim();
const VERB = '(use|uses|take|takes|reorder|reorders|keep|keeps|wear|wears|recommend|settled on|stuck with|stick with|stayed on|swear by|reach for|put clients on|give)';
const afterVerb = (cta) => (closer(cta).match(new RegExp(`\\bi(?:'m| am)?\\s+(?:\\w+\\s+)?${VERB}\\b(.*)$`, 'i')) || [])[2] || '';

// Each feature: key, the plain-language label the brief prints, and the test. Mutually exclusive
// families (how the plug opens, the closer's verb) are separate binary features on purpose: each is
// read as "plugs that do X vs plugs that don't".
export const FEATURES = [
  { key: 'open_question', slot: 'open', label: 'Plug opens on a short question ("Which magnesium works? …")', test: (p) => /^(?:so )?(which|what|how)\b[^?]{0,60}\?/i.test(p.criterion) },
  { key: 'open_look_for', slot: 'open', label: 'Plug opens with "(I) look for …"', test: (p) => /^(?:i )?look for\b/i.test(p.criterion) },
  { key: 'open_if_you', slot: 'open', label: 'Plug opens with "If you …"', test: (p) => /^if (?:you|your)\b/i.test(p.criterion) },
  { key: 'open_contrast', slot: 'open', label: 'Opening line names what to avoid ("…, not oxide")', test: (p) => /\b(?:not|never|instead of|rather than|skip)\b/i.test(p.criterion) },
  { key: 'result_dated', slot: 'result', label: 'Result line carries a start date ("Since March: …")', test: (p) => new RegExp(`\\bsince (?:${MONTHS}|\\d{4}|my \\d)`, 'i').test(p.middle) || new RegExp(`^(?:${MONTHS})\\b`, 'i').test(p.middle) },
  { key: 'result_number', slot: 'result', label: 'Result line contains a number (dose, time, count)', test: (p) => /\d/.test(p.middle) },
  { key: 'result_dose', slot: 'result', label: 'Result line names the serving or routine ("one serving before bed")', test: (p) => /\b(?:one|two|1|2|a) (?:serving|scoop|capsule|softgel|chew|gummy|tablet|pill)s?\b|\b(?:before|after|with) (?:bed|breakfast|dinner|lunch|training|my|every|each)\b/i.test(p.middle) },
  { key: 'closer_here_is', slot: 'closer', label: 'Closer starts "Here\'s / This is the …"', test: (p) => /^(?:here'?s|here is|this is|these are)\b/i.test(p.cta) },
  { key: 'closer_the', slot: 'closer', label: 'Closer starts "The …" (no "Here\'s")', test: (p) => /^the\b/i.test(p.cta) },
  { key: 'closer_use', slot: 'closer', label: 'Closer verb: use', test: (p) => /\bi (?:\w+ )?use\b/i.test(closer(p.cta)) },
  { key: 'closer_take', slot: 'closer', label: 'Closer verb: take', test: (p) => /\bi (?:\w+ )?take\b/i.test(closer(p.cta)) },
  { key: 'closer_reorder', slot: 'closer', label: 'Closer verb: reorder / keep', test: (p) => /\bi (?:\w+ )?(?:reorder|keep)\b/i.test(closer(p.cta)) },
  { key: 'closer_recommend', slot: 'closer', label: 'Closer verb: recommend', test: (p) => /\bi (?:\w+ )?recommend\b/i.test(closer(p.cta)) },
  { key: 'closer_settled', slot: 'closer', label: 'Closer verb: settled on / stuck with / stayed on', test: (p) => /\bi (?:\w+ )?(?:settled on|stuck with|stick with|stayed on)\b/i.test(closer(p.cta)) },
  { key: 'closer_routine', slot: 'closer', label: 'Closer names when it is used ("… I take every night")', test: (p) => /\b(?:every|each|before|after|at|with|on)\b/i.test(afterVerb(p.cta)) },
  { key: 'closer_short', slot: 'closer', label: 'Closer is 6 words or fewer', test: (p) => closer(p.cta).split(/\s+/).filter(Boolean).length <= 6 },
  { key: 'plug_short', slot: 'whole', label: 'Whole plug is 40 words or fewer', test: (p) => p.words <= 40 },
  { key: 'lead_arrow', slot: 'lead', label: 'Tweet before the plug ends on "↓"', lead: true, test: (_, lead) => /↓\s*$/.test(lead) },
  { key: 'lead_look_for', slot: 'lead', label: 'Tweet before the plug promises "what to look for"', lead: true, test: (_, lead) => /\bwhat (?:i|to) look for\b/i.test(lead) },
];

export function plugFeatures(text, leadIn) {
  const p = plugParts(text), lead = lastLine(leadIn);
  const out = {};
  for (const f of FEATURES) out[f.key] = f.lead && leadIn == null ? null : Boolean(f.test(p, lead));
  return out;
}

// Seeded PRNG so the weekly report is reproducible from the same observations.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Mantel-Haenszel rate ratio over strata. rows: { stratum, has, clicks, views }.
function mhRatio(rows) {
  const strata = new Map();
  for (const r of rows) {
    if (!strata.has(r.stratum)) strata.set(r.stratum, { c1: 0, v1: 0, c0: 0, v0: 0 });
    const s = strata.get(r.stratum);
    if (r.has) { s.c1 += r.clicks; s.v1 += r.views; } else { s.c0 += r.clicks; s.v0 += r.views; }
  }
  let num = 0, den = 0, matched = 0;
  for (const s of strata.values()) {
    if (!s.v1 || !s.v0) continue;
    const v = s.v1 + s.v0; matched++;
    num += s.c1 * s.v0 / v; den += s.c0 * s.v1 / v;
  }
  return { rr: den > 0 ? num / den : null, matched };
}
const quantile = (xs, q) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const i = (v.length - 1) * q, lo = Math.floor(i); return v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo); };

/** rows: valid observations { draftId, account, week, asin, role, text, leadIn, clicks, views, affiliate?, affiliateValid }. */
export function scoreCtaPatterns(rows, rules = PATTERN_RULES) {
  // Stratum = product x slot x account. Account matters as much as product: an account's audience
  // sets its click rate, and accounts write differently, so without it a feature can win just by
  // being the habit of a high-clicking account (measured 2026-10-04: the "names what to avoid" lift
  // fell from +57% to +22% once account was held fixed).
  const prepared = rows.map((r) => ({ ...r, stratum: `${r.asin}|${r.role}|${r.account}`, f: plugFeatures(r.text, r.leadIn) }));
  const out = [];
  for (const feat of FEATURES) {
    const use = prepared.filter((r) => r.f[feat.key] !== null);
    // Only strata that contain both sides can say anything about this feature.
    const both = new Set(), side = new Map();
    for (const r of use) { const k = r.stratum; side.set(k, (side.get(k) || 0) | (r.f[feat.key] ? 1 : 2)); }
    for (const [k, m] of side) if (m === 3) both.add(k);
    const inScope = use.filter((r) => both.has(r.stratum)).map((r) => ({ ...r, has: r.f[feat.key] }));
    const withF = inScope.filter((r) => r.has), without = inScope.filter((r) => !r.has);
    const sideStats = (rs) => ({ plugs: rs.length, threads: new Set(rs.map((r) => r.draftId)).size, accounts: new Set(rs.map((r) => r.account)).size,
      weeks: new Set(rs.map((r) => r.week)).size, views: rs.reduce((n, r) => n + r.views, 0), clicks: rs.reduce((n, r) => n + r.clicks, 0) });
    const a = sideStats(withF), b = sideStats(without);
    const point = mhRatio(inScope);
    // Cluster bootstrap over threads: a thread's plugs move together.
    const byThread = new Map(); for (const r of inScope) { if (!byThread.has(r.draftId)) byThread.set(r.draftId, []); byThread.get(r.draftId).push(r); }
    const threads = [...byThread.values()], rand = rng(rules.seed + feat.key.length * 7919 + feat.key.charCodeAt(0));
    const boots = [];
    if (point.rr !== null && threads.length > 1) for (let i = 0; i < rules.bootstrapReps; i++) {
      const sample = []; for (let j = 0; j < threads.length; j++) sample.push(...threads[Math.floor(rand() * threads.length)]);
      const r = mhRatio(sample).rr; if (r !== null) boots.push(r);
    }
    const lo = quantile(boots, 0.05), hi = quantile(boots, 0.95);
    const threadClicks = new Map(); for (const r of withF) threadClicks.set(r.draftId, (threadClicks.get(r.draftId) || 0) + r.clicks);
    const maxShare = a.clicks ? Math.max(...threadClicks.values()) / a.clicks : null;
    // Conversion guard on complete affiliate rows, compared inside the same strata (conversion rate
    // differs far more by product than by wording, so a pooled comparison would mostly measure the
    // product mix): Mantel-Haenszel ratio of orders per affiliate click.
    const ok = inScope.filter((r) => r.affiliateValid && r.affiliate);
    const cvr = (rs) => { const c = rs.reduce((n, r) => n + r.affiliate.clicks, 0), o = rs.reduce((n, r) => n + r.affiliate.orders, 0); return { clicks: c, orders: o, cvr: c ? o / c : null }; };
    const ca = cvr(ok.filter((r) => r.has)), cb = cvr(ok.filter((r) => !r.has));
    const cvrRatio = mhRatio(ok.map((r) => ({ stratum: r.stratum, has: r.has, clicks: r.affiliate.orders, views: r.affiliate.clicks }))).rr;
    const reasons = [];
    if (a.threads < rules.minThreadsEachSide || b.threads < rules.minThreadsEachSide) reasons.push('insufficient_threads');
    if (a.accounts < rules.minAccounts) reasons.push('insufficient_accounts');
    if (a.weeks < rules.minWeeks) reasons.push('insufficient_weeks');
    if (a.views < rules.minViewsEachSide || b.views < rules.minViewsEachSide) reasons.push('insufficient_views');
    if (point.matched < rules.minStrata) reasons.push('insufficient_matched_products');
    if (maxShare !== null && maxShare > rules.maxThreadClickShare) reasons.push('single_thread_dominance');
    let cvrCheck = 'unverified';
    if (ca.orders >= rules.minOrdersForCvr && cb.orders >= rules.minOrdersForCvr && cvrRatio !== null) cvrCheck = cvrRatio >= rules.minCvrRetention ? 'preserved' : 'lost';
    const better = lo !== null && lo >= 1 + rules.minLift, worse = hi !== null && hi <= 1 / (1 + rules.minLift);
    let status = 'unclear';
    if (!reasons.length && better && cvrCheck !== 'lost') status = 'better';
    else if (!reasons.length && worse) status = 'worse';
    if (better && cvrCheck === 'lost') reasons.push('cvr_not_preserved');
    out.push({ key: feat.key, slot: feat.slot, label: feat.label, status, rateRatio: point.rr, ci90: [lo, hi], matchedProducts: point.matched,
      with: a, without: b, maxThreadClickShare: maxShare, cvr: { check: cvrCheck, ratio: cvrRatio, with: ca, without: cb }, reasons });
  }
  const rank = { better: 0, worse: 1, unclear: 2 };
  return out.sort((x, y) => rank[x.status] - rank[y.status] || (y.rateRatio ?? 0) - (x.rateRatio ?? 0));
}

/** Score one library (criterion, closer) pair by the proven patterns it carries: the sum of
 *  ln(rate ratio) over its 'better' and 'worse' features (a worse ratio is below 1, so it subtracts).
 *  Only opening and closer features count: a pair has no result line or lead-in of its own.
 *  Used by cta-learning-policy.mjs. */
const PAIR_SLOTS = new Set(['open', 'closer']);
export function patternScore(criterion, cta, patterns = []) {
  const f = plugFeatures(`${criterion}\n\n${cta}`, null);
  const slotOf = new Map(FEATURES.map((x) => [x.key, x.slot]));
  let score = 0;
  for (const p of patterns) {
    if (!p || !PAIR_SLOTS.has(slotOf.get(p.key)) || !(p.rateRatio > 0) || f[p.key] !== true) continue;
    if (p.status === 'better' || p.status === 'worse') score += Math.log(p.rateRatio);
  }
  return score;
}
