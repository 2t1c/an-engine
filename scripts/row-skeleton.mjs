#!/usr/bin/env node
// scripts/row-skeleton.mjs — plan before words: Jev fixes a cover's plug plan before the writer writes
// (plan W1/A2; owner, 2026-09-23: "implement: 2,3,4, 6 first").
//
// The writer used to decide structure while writing, and a draft that failed on structure (a plug
// before its criterion, a plug that changed the subject) cost a full rewrite. Here the plan exists
// first:
//   code  pod-place.mjs placePods computes every LEGAL option: the donor's own sell slots, the
//         numbered items a pod may replace, the insert positions clear of the funnel tail, and the pod
//         and depth for each
//   Jev   chooses among them: where an insert anchors (plug-anchor), which item a pod replaces or none
//         (item-swap), how deep a donor-slot plug runs (cta-depth)
//   code  re-places with those choices (an option not on the legal list is ignored) and prints the plan
//         the writer fills: every plug's final tweet, what it replaces or follows, its pod and depth
//
// Two passes at most: a swap turned into an insert moves later positions, so the second pass reads
// any position the first did not. An unread choice keeps placePods' own pick.
//
// First of all, the lead item (lead-item.mjs; owner, 2026-09-28: "yes adopt fully — every numbered first
// tweet should have it implemented."): when the donor's tweet 1 shows item 1 and Jev reads another item
// as the stronger opener, that item trades places with item 1 in the DONOR before any plug is placed, so the
// plan and the writer both work from the new order. The plan prints the reordered donor; write from it.
//
//   node scripts/row-skeleton.mjs --in FILE [--json]
//     FILE: { account, donorTweets: [..], products: [asin, ..] } in RUN_DIR (donor text stays out of git)
//     --json carries `donorTweets`, the donor as the writer should write it (lead item first).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAWS } from '../laws.mjs';
import { leadLine } from '../lead-item.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Reads one decision; returns the policy verdict, or null when Jev could not read it. */
async function read(name, input, { client, log, cache, registry, laws }) {
  const { decide, decisionConfig } = await import('../jev-decide.mjs');
  try {
    const d = await decide(name, input, { client, registry, laws, log, ...(cache ? { cache } : {}) });
    if (d.mode === 'off' || d.source === 'fallback' || !d.answers) return null;
    return registry[name].policy(d.answers, decisionConfig(name, laws).thresholds);
  } catch { return null; }
}

/**
 * PURE. The choices from Jev's reads. `reads` = { depth: Map(asin -> verdict), swap: Map(`${asin}@${at}` ->
 * verdict), anchor: Map(`${asin}@${spot}` -> verdict) }; `plan` is a placePods result that carries each
 * plug's options. Returns { spot(asin), swapAt(asin), depth(asin) } for placePods' `choose`.
 */
export function choicesFrom(plan, reads) {
  const spots = new Map(), swaps = new Map(), depths = new Map();
  for (const p of plan.plugs) {
    const asin = p.product?.asin;
    if (!asin) continue;
    if (p.kind === 'donor-slot') {
      const v = reads.depth.get(asin);
      if (v) depths.set(asin, { depth: Number(v.action), why: v.why });
    }
    if (p.swapCandidates?.length) {
      const verdicts = p.swapCandidates.map((c) => ({ at: c.at, v: reads.swap.get(`${asin}@${c.at}`) }));
      // Only when every offered item was read: a partial read cannot say "none of them".
      if (verdicts.every((x) => x.v)) {
        const ok = verdicts.filter((x) => x.v.action === 'swap').sort((a, b) => b.v.argues - a.v.argues || a.at - b.at);
        swaps.set(asin, ok.length ? ok[0].at : null);
      }
    }
    if (p.legalSpots?.length) {
      const first = p.legalSpots.find((l) => reads.anchor.get(`${asin}@${l.spot}`)?.action === 'anchor');
      if (first) spots.set(asin, first.spot);
    }
  }
  return {
    spot: (asin) => spots.get(asin),
    swapAt: (asin) => (swaps.has(asin) ? swaps.get(asin) : undefined),
    depth: (asin) => depths.get(asin),
  };
}

/** Reads every option a plan offers that `reads` does not hold yet. */
async function readOptions(plan, tweets, reads, ctx) {
  const hook = tweets[0] || '';
  const jobs = [];
  for (const p of plan.plugs) {
    const asin = p.product?.asin, product = { title: p.product?.title || asin, criterion: p.pod?.criterion || '' };
    if (!asin) continue;
    if (p.kind === 'donor-slot' && p.runUp?.length && !reads.depth.has(asin)) {
      jobs.push(read('cta-depth', { runUp: p.runUp, product, codeDepth: p.depth }, ctx).then((v) => v && reads.depth.set(asin, v)));
    }
    for (const c of p.swapCandidates || []) {
      const k = `${asin}@${c.at}`;
      if (!reads.swap.has(k)) jobs.push(read('item-swap', { hook, item: tweets[c.at - 1], product, rank: c.rank }, ctx).then((v) => v && reads.swap.set(k, v)));
    }
    for (const l of p.legalSpots || []) {
      const k = `${asin}@${l.spot}`;
      if (!reads.anchor.has(k)) jobs.push(read('plug-anchor', { hook, before: l.before, product }, ctx).then((v) => v && reads.anchor.set(k, v)));
    }
  }
  await Promise.all(jobs);
  return jobs.length;
}

/** The whole step. Returns { code, plan, reads, asked, lead, donorTweets }: the code-only plan, the
 *  Jev-chosen one, and the donor as the writer should write it (lead item first). */
export async function rowSkeleton({ account, donorTweets, products, client, log = null, cache, laws = LAWS, registry = null, pods, leadAsk = null } = {}) {
  const { placePods } = await import('../pod-place.mjs');
  const reg = registry || (await import('../decisions/index.mjs')).DECISIONS;
  const ctx = { client, log, cache, registry: reg, laws };
  const { leadItem } = await import('../lead-item.mjs');
  const ask = leadAsk || (async (name, c, input, o) => (await import('../jev-decide.mjs')).askThrough(name, c, input, { ...o, log }));
  // The donor's own links do not matter here: our plugs are placed after, by placePods, for the new order.
  const led = await leadItem(donorTweets.map(String), { client, ask, keepFirstLink: false });
  const tweets = led.tweets;
  const opts = { account, products, ...(pods ? { pods } : {}) };
  const code = placePods(tweets, opts);
  const reads = { depth: new Map(), swap: new Map(), anchor: new Map() };
  let plan = code, asked = 0;
  for (let pass = 0; pass < 2; pass++) {
    const n = await readOptions(plan, tweets, reads, ctx);
    asked += n;
    if (!n && pass) break;
    plan = placePods(tweets, { ...opts, choose: choicesFrom(plan, reads) });
  }
  return { code, plan, reads, asked, lead: led.lead, donorTweets: tweets };
}

/** PURE. The writer's plan and the diff against the code-only plan. */
export function renderSkeleton({ code, plan, asked, lead = null, donorTweets = null }) {
  const where = (p) => (p.span ? `replaces donor tweets ${p.span.start}${p.span.end > p.span.start ? `-${p.span.end}` : ''}`
    : p.at ? `replaces item ${p.itemNumber ?? ''} (donor tweet ${p.at})` : p.afterTweet ? `inserted after tweet ${p.afterTweet}` : 'unplaced');
  const L = [`PLAN BEFORE WORDS: shape ${plan.shape} · ${plan.plugs.length} plug(s) · Jev read ${asked} option(s). Placement is decided; fill it, do not move it.`];
  plan.plugs.forEach((p, i) => {
    const was = code.plugs.find((c) => c.product?.asin === p.product?.asin);
    const changed = was && (where(was) !== where(p) || was.depth !== p.depth);
    L.push(`  PLUG ${i + 1} ${p.product?.asin || '?'} · final tweet ${p.finalAt} · ${where(p)} · pod ${p.pod?.id || 'NONE'} · depth ${p.depth}`);
    L.push(`    after: "${p.anchorQuote}"${p.spotBy === 'jev' ? ' (Jev anchor)' : ''}`);
    L.push(`    ${p.depthWhy}${p.swapWhy ? ` · ${p.swapWhy}` : ''}`);
    if (changed) L.push(`    code alone: ${where(was)}, depth ${was.depth}`);
    for (const a of p.preview?.advisories || []) L.push(`    ADVISORY${a.hard ? ' (hard)' : ''}: ${a.gate}: ${a.msg}`);
  });
  for (const w of plan.warnings) L.push(`  ⚠ ${w}`);
  if (lead) L.splice(1, 0, `  ${leadLine(lead)}`);
  if (lead?.moved && donorTweets) {
    L.push('', 'DONOR, REORDERED FOR THE LEAD ITEM: write from this, not the original donor.');
    donorTweets.forEach((t, i) => L.push(`--- ${i + 1}`, t));
  }
  return L;
}

/** PURE. Hard gate advisories across a plan (the proxy for "passes on the first write"). */
export const hardAdvisories = (plan) => plan.plugs.reduce((n, p) => n + (p.preview?.advisories || []).filter((a) => a.hard).length, 0);

async function main() {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  if (!arg('in')) throw new Error('usage: node scripts/row-skeleton.mjs --in FILE [--json]');
  const input = JSON.parse(readFileSync(arg('in'), 'utf8'));
  const all = JSON.parse(readFileSync(join(ROOT, 'products.json'), 'utf8')).products;
  const want = new Set((input.products || []).map(String));
  const products = want.size ? all.filter((p) => want.has(p.asin)) : all;
  const { loadEnv } = await import('../lib.mjs');
  const { jev } = await import('../jev.mjs');
  const { createDecisionLog } = await import('../jev-decide.mjs');
  const env = loadEnv();
  const log = createDecisionLog();
  try {
    const out = await rowSkeleton({ account: input.account, donorTweets: input.donorTweets, products, client: jev(env), log });
    if (process.argv.includes('--json')) console.log(JSON.stringify({ plan: out.plan, code: out.code, asked: out.asked, lead: out.lead, donorTweets: out.donorTweets }, null, 1));
    else console.log(renderSkeleton(out).join('\n'));
  } finally { log.flush(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
