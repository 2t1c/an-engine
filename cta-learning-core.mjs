import { createHash } from 'node:crypto';
import { scoreCtaPatterns } from './cta-patterns.mjs';

// Operational evidence gates, not a claim of randomized causal inference.
export const CTA_LEARNING_RULES = Object.freeze({
  maturityDays: 7, lookbackDays: 42, maxMetricsAgeDays: 7, preferenceTtlDays: 14,
  minThreads: 5, minAccounts: 3, minWeeks: 2, minViews: 5000,
  minAffiliateClicks: 100, minOrders: 5, maxPostViewShare: 0.6,
  minCtrLift: 0.20, minAbsoluteCtrLift: 0.001, minRobustCtrLift: 0.10,
  minAffiliateRetention: 0.85, minMatchedStrata: 3, maxExamples: 5,
});
const DAY = 86400000;
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const count = x => number(x) && Number.isInteger(x);
const date = x => {
  if (x instanceof Date) return x.getTime();
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(x)) return NaN;
  const n = Date.parse(x);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === x.slice(0, 10) ? n : NaN;
};
export function normalizeCtaRecipeText(text) {
  return typeof text === 'string' ? text.normalize('NFKC').replace(/[’‘]/g, "'")
    .replace(/\(?\s*#ad\s*\)?\s*[:.!?]*\s*$/i, '').trim().replace(/[:.!?]+$/, '')
    .replace(/\s+/g, ' ').toLowerCase() : '';
}
export function ctaRecipeId({ podId, role, criterion, cta }) {
  return createHash('sha256').update(JSON.stringify([podId, role,
    normalizeCtaRecipeText(criterion), normalizeCtaRecipeText(cta)])).digest('hex').slice(0, 24);
}
// A plain first-person closer from the pod library ("The toe separators I use every day"). The
// library is written for every account ("account": "*"), so every account already ships these; the
// learner choosing between two of them transfers nothing a default render does not (owner
// 2026-10-04: "do what you think best convert" — before this, every live closer was blocked and no
// CTA could ever be promoted). Still blocked: anyone else's use (clients, kids, him, family),
// purchase history, switching stories and negations.
const PLAIN_USE_CLOSER = /^the .+ i (?:(?:actually|still|personally|always|now|just)\s+)?(?:use|take|keep|reorder|wear|reach for|swear by|stick with|stuck with|stayed on|settled on|come back to|go back to)\b/;
const THIRD_PARTY_OR_HISTORY = /\b(?:not|never|don't|do not|buy|bought|clients?|kids?|children|him|her|his|hers|wife|husband|son|daughter|mom|dad|family|patients?|since|switched?)\b/;
export function safeCtaLearningRecipe({ criterion, cta }) {
  // Never transfer a speaker's purchase, client/family history or outcomes.
  const ask = normalizeCtaRecipeText(cta);
  const directRecommendation = /\bi (?:recommend|suggest|would choose)\b/.test(ask)
    && !/\b(?:not|never|don't|do not|used?|take|took|taking|buy|bought|clients?|kids?|since|switched?|my|me)\b/.test(ask);
  const plainUse = PLAIN_USE_CLOSER.test(ask) && !THIRD_PARTY_OR_HISTORY.test(ask);
  return (directRecommendation || plainUse)
    && !/\b(?:i|i've|i'm|my|me|we|our|he|she|his|her|clients?|kids?|since)\b/i.test(criterion);
}
export function recipeFromText(text) {
  if (typeof text !== 'string') return { criterion: '', cta: '' };
  const paragraphs = text.split(/\n\s*\n/).map(x => x.trim())
    .filter(x => x && !/^(?:https?:\/\/\S+|\{\{LINK\}\})$/i.test(x));
  return { criterion: paragraphs[0] || '', cta: paragraphs.length > 1 ? paragraphs.at(-1) : '' };
}
function week(time) {
  const d = new Date(time); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
const median = values => {
  const v = [...values].sort((a, b) => a - b), i = Math.floor(v.length / 2);
  return v.length ? v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2 : null;
};
function stats(rows) {
  const views = sum(rows, 'views'), clicks = sum(rows, 'clicks');
  const complete = rows.length > 0 && rows.every(r => r.affiliateValid);
  const affiliateClicks = complete ? rows.reduce((n, r) => n + r.affiliate.clicks, 0) : null;
  const orders = complete ? rows.reduce((n, r) => n + r.affiliate.orders, 0) : null;
  const commission = complete ? rows.reduce((n, r) => n + r.affiliate.commission, 0) : null;
  return { threads: new Set(rows.map(r => r.draftId)).size,
    accounts: new Set(rows.map(r => r.account)).size, weeks: new Set(rows.map(r => r.week)).size,
    views, clicks, ctr: views ? clicks / views : null,
    medianCtr: median(rows.map(r => r.clicks / r.views)),
    maxPostViewShare: views ? Math.max(...rows.map(r => r.views)) / views : null,
    affiliateComplete: complete, affiliateClicks, orders, commission,
    cvr: affiliateClicks ? orders / affiliateClicks : null,
    epc: affiliateClicks ? commission / affiliateClicks : null };
}
function gates(s) {
  const r = CTA_LEARNING_RULES, reasons = [];
  for (const [key, min] of [['threads', r.minThreads], ['accounts', r.minAccounts],
    ['weeks', r.minWeeks], ['views', r.minViews]]) if (s[key] < min) reasons.push(`insufficient_${key}`);
  if (s.maxPostViewShare > r.maxPostViewShare) reasons.push('single_post_dominance');
  if (!s.affiliateComplete) reasons.push('affiliate_incomplete');
  if (s.affiliateClicks === null || s.affiliateClicks < r.minAffiliateClicks) reasons.push('insufficient_affiliate_clicks');
  if (s.orders === null || s.orders < r.minOrders) reasons.push('insufficient_orders');
  return reasons;
}
function comparison(rows, base) {
  const r = CTA_LEARNING_RULES, a = stats(rows), b = stats(base);
  const partition = rs => {
    const m = new Map(); for (const row of rs) {
      const key = `${row.account}\0${row.week}`;
      if (!m.has(key)) m.set(key, []); m.get(key).push(row);
    } return m;
  };
  const am = partition(rows), bm = partition(base), keys = [...am.keys()].filter(k => bm.has(k));
  const pairs = keys.map(k => [stats(am.get(k)), stats(bm.get(k))]);
  const matchedCandidateCtr = pairs.length ? pairs.reduce((n, [s]) => n + s.ctr, 0) / pairs.length : null;
  const matchedBaselineCtr = pairs.length ? pairs.reduce((n, [, s]) => n + s.ctr, 0) / pairs.length : null;
  const ratios = pairs.map(([x, y]) => y.ctr > 0 ? x.ctr / y.ctr : null);
  const leaveOneOutMinCtr = rows.length > 1 ? Math.min(...rows.map(x => (a.clicks - x.clicks) / (a.views - x.views))) : null;
  const baselineLeaveOneOutMaxCtr = base.length > 1 ? Math.max(...base.map(x => (b.clicks - x.clicks) / (b.views - x.views))) : null;
  const reasons = [];
  if (!(b.ctr > 0)) reasons.push('baseline_ctr_unusable');
  if (!(a.ctr >= b.ctr * (1 + r.minCtrLift) && a.ctr - b.ctr >= r.minAbsoluteCtrLift)) reasons.push('ctr_lift_too_small');
  if (!(a.medianCtr >= b.medianCtr * (1 + r.minRobustCtrLift)
    && leaveOneOutMinCtr >= baselineLeaveOneOutMaxCtr * (1 + r.minRobustCtrLift))) reasons.push('ctr_lift_not_robust');
  const matchedAccounts = new Set(keys.map(k => k.split('\0')[0])).size;
  const matchedWeeks = new Set(keys.map(k => k.split('\0')[1])).size;
  if (keys.length < r.minMatchedStrata || matchedAccounts < r.minAccounts || matchedWeeks < r.minWeeks)
    reasons.push('insufficient_matched_account_weeks');
  if (!(matchedBaselineCtr > 0 && matchedCandidateCtr >= matchedBaselineCtr * (1 + r.minCtrLift)
    && ratios.every(x => x !== null) && median(ratios) >= 1 + r.minRobustCtrLift)) reasons.push('matched_ctr_lift_too_small');
  if (!(a.cvr !== null && b.cvr > 0 && a.cvr >= b.cvr * r.minAffiliateRetention)) reasons.push('cvr_not_preserved');
  if (!(a.epc !== null && b.epc > 0 && a.epc >= b.epc * r.minAffiliateRetention)) reasons.push('epc_not_preserved');
  return { reasons, baseline: b, ctrLift: b.ctr > 0 ? a.ctr / b.ctr - 1 : null,
    matchedStrata: keys.length, matchedAccounts, matchedWeeks, matchedCandidateCtr, matchedBaselineCtr,
    medianMatchedCtrRatio: ratios.length && ratios.every(x => x !== null) ? median(ratios) : null,
    leaveOneOutMinCtr, baselineLeaveOneOutMaxCtr };
}

// The fields slot-pattern scoring reads, with the same affiliate validity the recipe gates use.
function patternRow(o, posted, at) {
  const aff = o.affiliate, reported = date(aff?.reportedThrough);
  const affiliateValid = aff?.complete === true && count(aff.clicks) && count(aff.orders) && number(aff.commission)
    && Number.isFinite(reported) && reported <= at && reported >= posted + CTA_LEARNING_RULES.maturityDays * DAY
    && at - reported <= CTA_LEARNING_RULES.maxMetricsAgeDays * DAY;
  return { draftId: String(o.draftId), account: o.account.trim().toLowerCase(), week: week(posted), asin: o.asin, role: o.role,
    text: o.text, leadIn: typeof o.leadIn === 'string' ? o.leadIn : null, clicks: o.clicks, views: o.views,
    affiliate: aff || null, affiliateValid };
}
export function buildCtaLearning({ observations = [], pods = [], now = new Date() } = {}) {
  const at = date(now);
  if (!Number.isFinite(at)) throw new Error('A valid evaluation time is required');
  if (!Array.isArray(observations)) throw new Error('observations must be an array');
  const library = new Map(), baselines = new Map(), podMap = new Map();
  for (const pod of Array.isArray(pods) ? pods : pods.pods || []) {
    podMap.set(pod.id, pod);
    for (const variant of (pod.variants || []).filter(v => v.system === 'skeleton')) for (const role of ['heavy', 'light']) {
      const criteria = role === 'heavy' ? variant.plug?.criterion : variant.light?.opener;
      const ctas = role === 'heavy' ? variant.plug?.cta : variant.light?.cta;
      if (!Array.isArray(criteria) || !Array.isArray(ctas)) continue;
      for (const criterion of criteria) for (const cta of ctas) {
        if (typeof criterion !== 'string' || typeof cta !== 'string') continue;
        const recipe = { podId: pod.id, role, criterion, cta };
        const id = ctaRecipeId(recipe); library.set(id, recipe);
        if (criterion === criteria[0] && cta === ctas[0]) {
          const key = `${pod.id}:${role}`; if (!baselines.has(key)) baselines.set(key, new Set());
          baselines.get(key).add(id);
        }
      }
    }
  }
  const summary = { observations: observations.length, uniqueObservations: 0, duplicateObservations: 0,
    validObservations: 0, excludedObservations: 0, exclusionReasons: {}, candidates: 0, promoted: 0 };
  const duplicates = new Map();
  for (const o of observations) {
    if (!o || typeof o !== 'object') { summary.excludedObservations++; continue; }
    const key = `${o.draftId}\0${o.role}`;
    if (!duplicates.has(key)) duplicates.set(key, []); duplicates.get(key).push(o);
  }
  const groups = new Map(), patternRows = [];
  for (const list of duplicates.values()) {
    const o = list[0]; summary.uniqueObservations++; summary.duplicateObservations += list.length - 1;
    // A plug matching no pod cannot join a recipe, but slot-pattern scoring needs only its product.
    if (o.podId == null) {
      const posted = date(o.postedAt), metrics = date(o.metricsAt);
      const ok = !list.some(row => JSON.stringify(row) !== JSON.stringify(o)) && o.draftId && typeof o.account === 'string' && o.account.trim()
        && ['heavy', 'light'].includes(o.role) && typeof o.asin === 'string' && o.asin && typeof o.text === 'string'
        && Number.isFinite(posted) && at - posted >= CTA_LEARNING_RULES.maturityDays * DAY && at - posted <= CTA_LEARNING_RULES.lookbackDays * DAY
        && count(o.views) && o.views > 0 && count(o.clicks) && o.clicks <= o.views
        && Number.isFinite(metrics) && metrics <= at && metrics >= posted + CTA_LEARNING_RULES.maturityDays * DAY && at - metrics <= CTA_LEARNING_RULES.maxMetricsAgeDays * DAY;
      if (ok) { summary.patternOnlyObservations = (summary.patternOnlyObservations || 0) + 1; patternRows.push(patternRow(o, posted, at)); }
      else { summary.excludedObservations++; summary.exclusionReasons.pattern_only_invalid = (summary.exclusionReasons.pattern_only_invalid || 0) + 1; }
      continue;
    }
    const recipe = { podId: o.podId, role: o.role, ...recipeFromText(o.text) }, recipeId = ctaRecipeId(recipe);
    if (!groups.has(recipeId)) groups.set(recipeId, { recipeId, ...library.get(recipeId) || recipe,
      approved: library.has(recipeId), rows: [], excluded: [], disqualifying: [], examples: [] });
    const g = groups.get(recipeId), reasons = [], posted = date(o.postedAt), metrics = date(o.metricsAt);
    const pod = podMap.get(o.podId);
    if (list.some(row => JSON.stringify(row) !== JSON.stringify(o))) reasons.push('conflicting_duplicate');
    if (!o.draftId || typeof o.account !== 'string' || !o.account.trim() || !['heavy', 'light'].includes(o.role)) reasons.push('invalid_identity');
    if (!pod || typeof o.asin !== 'string' || o.asin !== pod.asin) reasons.push('product_mismatch');
    if (!recipe.criterion || !recipe.cta) reasons.push('missing_copy');
    if (!Number.isFinite(posted) || posted > at) reasons.push('invalid_publication_time');
    else if (at - posted < CTA_LEARNING_RULES.maturityDays * DAY) reasons.push('immature');
    else if (at - posted > CTA_LEARNING_RULES.lookbackDays * DAY) reasons.push('outside_lookback');
    if (!count(o.views) || o.views <= 0 || !count(o.clicks) || o.clicks > o.views) reasons.push('invalid_plug_metrics');
    if (!Number.isFinite(metrics) || metrics > at || metrics < posted + CTA_LEARNING_RULES.maturityDays * DAY) reasons.push('invalid_metrics_time');
    else if (at - metrics > CTA_LEARNING_RULES.maxMetricsAgeDays * DAY) reasons.push('stale_metrics');
    const aff = o.affiliate, reported = date(aff?.reportedThrough);
    const affiliateValid = aff?.complete === true && count(aff.clicks) && count(aff.orders) && number(aff.commission)
      && Number.isFinite(reported) && reported <= at && reported >= posted + CTA_LEARNING_RULES.maturityDays * DAY
      && at - reported <= CTA_LEARNING_RULES.maxMetricsAgeDays * DAY;
    g.examples.push({ draftId: o.draftId, account: o.account, postedAt: o.postedAt, text: o.text,
      sourceUrl: o.sourceUrl ?? null, views: number(o.views) ? o.views : null, clicks: number(o.clicks) ? o.clicks : null,
      affiliateComplete: affiliateValid, reasons: [...reasons, ...affiliateValid ? [] : ['affiliate_incomplete']] });
    if (reasons.length) {
      summary.excludedObservations++; g.excluded.push(...reasons);
      // Routine rolling-window exclusions must not suppress valid mature evidence.
      if (!reasons.includes('immature') && !reasons.includes('outside_lookback')) g.disqualifying.push(...reasons);
      for (const reason of reasons) summary.exclusionReasons[reason] = (summary.exclusionReasons[reason] || 0) + 1;
    } else {
      summary.validObservations++;
      g.rows.push({ ...o, draftId: String(o.draftId), account: o.account.trim().toLowerCase(), week: week(posted), affiliateValid });
      patternRows.push(patternRow(o, posted, at));
    }
  }
  const candidates = [];
  for (const g of groups.values()) {
    const evidence = stats(g.rows), reasons = [...gates(evidence)];
    const baselineIds = baselines.get(`${g.podId}:${g.role}`) || new Set();
    if (!g.approved) reasons.push('recipe_not_in_library');
    const baselineRecipe = baselineIds.size === 1 ? library.get([...baselineIds][0]) : null;
    const unchangedCta = baselineRecipe && normalizeCtaRecipeText(g.cta) === normalizeCtaRecipeText(baselineRecipe.cta);
    const safeCriterion = !/\b(?:i|i've|i'm|my|me|we|our|he|she|his|her|clients?|kids?|since)\b/i.test(g.criterion);
    if (!safeCriterion || (!unchangedCta && !safeCtaLearningRecipe(g))) reasons.push('speaker_specific_or_not_direct_endorsement');
    if (g.disqualifying.length) reasons.push('excluded_observations_present');
    let compare = null;
    if (baselineIds.has(g.recipeId)) reasons.push('already_baseline');
    else if (baselineIds.size !== 1) reasons.push('ambiguous_or_missing_baseline');
    else {
      const baseline = groups.get([...baselineIds][0]);
      if (!baseline || gates(stats(baseline.rows)).length || baseline.disqualifying.length) reasons.push('baseline_insufficient');
      else { compare = comparison(g.rows, baseline.rows); reasons.push(...compare.reasons); }
    }
    candidates.push({ recipeId: g.recipeId, podId: g.podId, role: g.role, criterion: g.criterion, cta: g.cta,
      approved: g.approved, stage: reasons.length ? 'watch' : 'proven', reasons: [...new Set(reasons)],
      evidence: { ...evidence, promoted: reasons.length === 0, comparison: compare },
      exclusionReasons: [...new Set(g.excluded)],
      examples: g.examples.sort((a, b) => (b.views || 0) - (a.views || 0) || String(a.draftId).localeCompare(String(b.draftId))).slice(0, CTA_LEARNING_RULES.maxExamples) });
  }
  candidates.sort((a, b) => Number(b.stage === 'proven') - Number(a.stage === 'proven')
    || (b.evidence.ctr ?? -1) - (a.evidence.ctr ?? -1) || a.recipeId.localeCompare(b.recipeId));
  const chosen = new Set(), preferences = [];
  for (const c of candidates.filter(c => c.stage === 'proven')) {
    const key = `${c.podId}:${c.role}`; if (chosen.has(key)) continue; chosen.add(key);
    preferences.push({ status: 'proven', asin: podMap.get(c.podId).asin, podId: c.podId, role: c.role, criterion: c.criterion, cta: c.cta, recipeId: c.recipeId, evidence: c.evidence });
  }
  summary.candidates = candidates.length; summary.promoted = preferences.length;
  const patterns = scoreCtaPatterns(patternRows);
  summary.patternRows = patternRows.length;
  summary.patternsBetter = patterns.filter(p => p.status === 'better').length;
  summary.patternsWorse = patterns.filter(p => p.status === 'worse').length;
  return { schemaVersion: 1, generatedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + CTA_LEARNING_RULES.preferenceTtlDays * DAY).toISOString(), preferences, patterns, candidates, summary };
}
