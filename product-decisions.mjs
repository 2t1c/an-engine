// product-decisions.mjs — the products stop's registered Jev decisions (plan Track C, Phase 3b), run
// through jev-decide.mjs decide() beside product-fit.mjs's report-only reading:
//
//   product-fit-heavy      would Jev filter the picker's heavy (the donor does not argue it, or argues an
//                          unproposed rival more)? EPC x spread still orders the candidates, in code.
//   product-second-earned  is the light placement earned: supported by the donor, and a separate
//                          decision from the heavy (docs/glue.md LAW G1)?
//
// SHADOW / REPORT-ONLY. Both decisions run under their laws.json mode (shadow), pinned to laws.json
// `jev.model` (jev-1.13) by decide(). The result is stored on the plan row as `jevDecisions` and printed
// in the products packet; a pick, a status, a flag or an approval never changes. Any failure (no client,
// a transport error, a partial answer set, a policy error) is "not read", never a keep.
import { createMemoryLog, decide, decisionConfig } from './jev-decide.mjs';
import { LAWS } from './laws.mjs';

export const HEAVY = 'product-fit-heavy';
export const SECOND = 'product-second-earned';

const pct = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const text = (v) => String(v ?? '').trim();

/** Pure: the two decisions' inputs from a products-plan row and its donor text. */
export function decisionInputs(row, donorText, products, bridges = []) {
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const placements = (row.placements || []).map((p) => ({ asin: p.asin, placement: p.placement, needsBridge: !!p.needsBridge }));
  const heavy = { donorText, products, placements };
  const pair = (row.placements || []).slice(0, 2);
  if (pair.length < 2) return { heavy, second: null, skip: 'one placement: no second product to judge' };
  if (!pair.every((p) => byAsin.has(p.asin))) return { heavy, second: null, skip: 'a placed product is missing from the catalog: not read (the row holds on it)' };
  const second = { donorText, products: pair.map((p) => byAsin.get(p.asin)), needs: pair.map((p) => p.need || ''), bridges: pair.map((_, i) => String(bridges?.[i] ?? '')) };
  // The selector marked the light for a written bridge and none is supplied yet: the donor is EXPECTED not
  // to argue it (as product-fit's fitVerdict treats that light), so "unsupported" alone is no finding.
  return { heavy, second, bridgeExpected: !!pair[1].needsBridge && !text(second.bridges[1]) };
}

/**
 * One decision through decide(), reduced to what the packet prints. `registry` is the decisions
 * registry (imported lazily by default: decisions/product-fit-heavy.mjs imports product-fit.mjs).
 */
export async function runDecision(name, input, { client, laws = LAWS, log = null, cache, registry = null, unavailableReason = null } = {}) {
  try {
    const reg = registry || (await import('./decisions/index.mjs')).DECISIONS;
    const r = await decide(name, input, { client, registry: reg, laws, log: log ?? createMemoryLog(), ...(cache ? { cache } : {}) });
    const base = { mode: r.mode, incumbent: r.incumbentAction, action: r.action, questionSetHash: r.questionSetHash.slice(0, 12) };
    if (r.mode === 'off') return { ...base, status: 'off' };
    if (r.source === 'fallback' || !r.answers) {
      const code = r.fallback || 'not read';
      return { ...base, status: 'not read', reason: code === 'not read: no_client' && unavailableReason ? `not read: ${unavailableReason}` : code };
    }
    const decision = reg[name];
    const verdict = decision.policy(r.answers, decisionConfig(name, laws).thresholds, { input, state: decision.stateOf(input) });
    return { ...base, status: 'read', model: r.model, jevAction: verdict.action, confidence: verdict.confidence, reasons: verdict.reasons || [],
      ...(name === SECOND ? { supported: verdict.supported, sameDecision: verdict.sameDecision } : {}) };
  } catch (error) {
    return { status: 'not read', reason: `not read: ${String(error?.message || 'error').slice(0, 120)}` };
  }
}

/**
 * Attach `jevDecisions` to every cover row with a donor. Never throws for a provider failure and never
 * touches a row's placements, status, reasons or flags. Harvest and pot rows keep their contracts and
 * are not read (no donor text reaches the products stop for them).
 */
export async function attachProductDecisions(plan, rows, products, client, { concurrency = 4, ...opts } = {}) {
  const donors = new Map(rows.filter((r) => r.lane === 'cover' && r.donor?.text).map((r) => [r.id, r]));
  const targets = plan.rows.filter((r) => donors.has(r.id));
  let next = 0;
  const work = async () => {
    while (next < targets.length) {
      const row = targets[next++];
      const source = donors.get(row.id);
      const inputs = decisionInputs(row, source.donor.text, products, source.bridges);
      const [heavy, read] = await Promise.all([runDecision(HEAVY, inputs.heavy, { client, ...opts }),
        inputs.second ? runDecision(SECOND, inputs.second, { client, ...opts }) : null]);
      const second = read ? { ...read, ...(inputs.bridgeExpected ? { bridgeExpected: true } : {}) } : { status: 'skipped', reason: inputs.skip };
      row.jevDecisions = { heavy, second };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, work));
  const count = (key, pred) => targets.filter((r) => pred(r.jevDecisions?.[key])).length;
  plan.jevDecisions = { mode: productDecisionsActing(opts.laws) ? 'decide' : 'shadow', rows: targets.length,
    heavy: { read: count('heavy', (d) => d?.status === 'read'), wouldFilter: count('heavy', (d) => d?.jevAction === 'flag'), notRead: count('heavy', (d) => d?.status === 'not read') },
    second: { read: count('second', (d) => d?.status === 'read'), flagged: count('second', (d) => d?.jevAction === 'flag' && !(d.bridgeExpected && d.reasons.every((r) => r === 'second_unsupported'))), notRead: count('second', (d) => d?.status === 'not read') } };
  return plan;
}

// OWNER RULE, 2026-09-23: "everything related to decision making & gate must be made by Jev from now on".
// At decide (laws.json), Jev's product decisions decide the products stop. Since 2026-09-28 ("Keep donor,
// sell anyway") they resolve the row instead of holding it (scripts/product-allocation.mjs
// resolveJevProductDecisions): the donor's own argued product takes the heavy, an unargued heavy gets an
// explicit bridge, an unearned second is dropped. productDecisionIssues still says what Jev found.
const ACTING = new Set(['decide', 'enforce']);
export const productDecisionsActing = (laws = LAWS) => [HEAVY, SECOND].some((n) => ACTING.has(decisionConfig(n, laws).mode));
/** Pure: { holds, reviews } from Jev's product decisions for one plan row (both empty when they pass or are shadow). */
export function productDecisionIssues(row) {
  const d = row.jevDecisions; if (!d) return { holds: [], reviews: [] };
  const out = [], reviews = [];
  const h = d.heavy, s = d.second;
  if (h && ACTING.has(h.mode)) {
    if (h.status === 'not read') reviews.push(`Jev product decision (heavy) not read (${h.reason}): decide the heavy yourself`);
    else if (h.status === 'read' && h.jevAction === 'flag') out.push(`Jev product decision: the heavy is not argued by the donor (${words(h.reasons || [])}); choose another heavy`);
  }
  if (s && ACTING.has(s.mode)) {
    if (s.status === 'not read') reviews.push(`Jev product decision (second) not read (${s.reason}): decide the second product yourself`);
    else if (s.status === 'read' && s.jevAction === 'flag' && !(s.bridgeExpected && (s.reasons || []).every((r) => r === 'second_unsupported'))) {
      out.push(`Jev product decision: the second product is not earned (${words(s.reasons || [])}); drop or replace it`);
    }
  }
  return { holds: out, reviews };
}
/** The hold reasons only (kept for callers that only gate). */
export const productDecisionHolds = (row) => productDecisionIssues(row).holds;

const REASON_WORDS = {
  heavy_weak: 'the donor does not argue it', rival_beats_heavy: 'the donor argues an unproposed product more',
  no_product: 'the thread may recommend no product', no_heavy: 'no heavy to read',
  second_unsupported: 'the donor does not support it', same_decision: 'it does the same job as the heavy',
};
const words = (reasons) => reasons.map((r) => REASON_WORDS[r] || r).join('; ');

function heavyLine(h, heavyLabel) {
  if (!h) return null;
  if (h.status === 'off') return `- Heavy check: off (${h.mode})`;
  if (h.status !== 'read') return `- Heavy check: NOT READ (${h.reason}) — the picker's heavy stands; read the donor for it`;
  if (h.jevAction === 'flag') return `- Heavy check: Jev WOULD FILTER the heavy ${heavyLabel} (${words(h.reasons)}) · confidence ${pct(h.confidence)} · the picker's heavy stands (EPC × spread orders the candidates)`;
  return `- Heavy check: the donor argues the heavy ${heavyLabel} (keep) · confidence ${pct(h.confidence)}`;
}
function secondLine(s, lightLabel) {
  if (!s) return null;
  if (s.status === 'skipped') return `- Second product: ${s.reason}`;
  if (s.status === 'off') return `- Second product: off (${s.mode})`;
  if (s.status !== 'read') return `- Second product: NOT READ (${s.reason}) — read the pair yourself (distinct jobs, donor support)`;
  const nums = `supported ${pct(s.supported)} · same decision ${pct(s.sameDecision)}`;
  const reasons = s.bridgeExpected ? (s.reasons || []).filter((r) => r !== 'second_unsupported') : s.reasons || [];
  if (s.bridgeExpected && (s.reasons || []).includes('second_unsupported') && !reasons.length) return `- Second product: the light ${lightLabel} is not argued by the donor, as expected: the selector marked it for a written bridge · ${nums} · code check ${s.incumbent}`;
  if (reasons.length) return `- Second product: Jev reads the light ${lightLabel} as NOT EARNED (${words(reasons)}) · ${nums} · code check ${s.incumbent}`;
  return `- Second product: the light ${lightLabel} reads as earned · ${nums} · code check ${s.incumbent}`;
}

/** Markdown lines for a products packet. Empty for a row that was not attempted (harvest/pot, no --jev). */
export function productDecisionLines(block, placements = []) {
  if (!block) return [];
  const label = (i) => (placements[i] ? `"${String(placements[i].title || placements[i].asin).slice(0, 60)}"` : '');
  const mode = [block.heavy?.mode, block.second?.mode].find(Boolean) || 'shadow';
  const header = ACTING.has(mode) ? `## Jev product decisions (${mode}: Jev's reading resolves the row, by reselect, bridge or drop; owner 2026-09-28, "Keep donor, sell anyway")` : `## Jev product decisions (${mode} · report-only: picks, status and approval unchanged)`;
  return [header,
    heavyLine(block.heavy, label(0)), secondLine(block.second, label(1)), ''].filter((l) => l != null);
}
