// harvest-build.mjs — turn ONE harvest spec into a shippable publish spec, hooks and all.
//
// The harvest lane recycles a body that already went viral: same proven tweets, a NEW hook, FRESH
// links. Until now the writing happened in-session, which is why the lane never ran on a schedule.
// The operator relaxed that law for this lane specifically (2026-08-27, "automate fully"), because
// the body is not being written — it is being reused verbatim — so the only generated text is the
// hook, and a hook can be judged mechanically against the parent and the bank.
//
// THREE HOOKS, ONE SHIPS. Writing one hook and taking it is a sample of one from a generator we
// know is uneven. Writing three and ranking them costs three cheap calls and turns the choice into
// a measurement. The two that lose are parked in the draft's scratchpad, so the operator can swap
// one in by hand without regenerating anything.
//
//   node harvest-build.mjs <harvestOf> --account magnus            # build + print, mints nothing
//   node harvest-build.mjs <harvestOf> --account magnus --create   # mint, publish UNSCHEDULED
//   node harvest-build.mjs <harvestOf> --account magnus --create --at 2026-08-29T06:30:00Z
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runResultChild, withProcessResult } from './process-result.mjs';
import { loadEnv, requireEnv, levanta, runMain, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { harvestHook } from './prompts.mjs';
import { hookFidelityIssue, hookSimilarity, hookStrength, DENY_ASINS } from './checks.mjs';
import { LAWS } from './laws.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const BAND_MID = (LAWS.hook.gateMin + LAWS.hook.gateMax) / 2;

/**
 * Rank hook candidates against the parent. Pure + testable — the whole judgement lives here so it
 * can be argued with offline, without an LLM key or a network call.
 *
 * Order of operations matters and is not negotiable: FIDELITY FIRST, strength second. A hook that
 * drifts out of the band is not a weaker hook, it is a different thread wearing the parent's body,
 * and no amount of bank-measured punch redeems that. Only survivors get ranked.
 */
export function rankHooks(candidates, parentHook, { bank = [], band = [LAWS.hook.gateMin, LAWS.hook.gateMax] } = {}) {
  const scored = (candidates || []).map((hook) => {
    const text = String(hook || '').trim();
    const issue = text ? hookFidelityIssue(text, parentHook, { band }) : 'empty hook';
    const sim = text ? hookSimilarity(text, parentHook) : 0;
    // hookStrength returns null on a bank under 10 entries — a young account has no corpus to be
    // measured against, and inventing a score there would rank on noise. Null sorts as "no opinion".
    const strength = text ? hookStrength(text, bank) : null;
    return { hook: text, issue, ok: !issue, sim, strength: strength?.score ?? null };
  });
  return scored.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;                       // fidelity first, always
    if ((b.strength ?? -1) !== (a.strength ?? -1)) return (b.strength ?? -1) - (a.strength ?? -1);
    return Math.abs(a.sim - BAND_MID) - Math.abs(b.sim - BAND_MID); // then closest to the band's middle
  });
}

/** The parent's tracked links, in the order they appear in the body. Pure. */
export const linksInOrder = (tweets) =>
  (tweets || []).flatMap((t) => [...String(t).matchAll(/https?:\/\/lvnta\.com\/\S+/g)].map((m) => m[0].replace(/[.,)]+$/, '')));

/** Swap each parent link for its fresh mint, positionally. Pure. Extra links are left alone and
 *  reported by the caller — silently dropping one would ship a thread with a dead plug. */
export function substituteLinks(tweets, pairs) {
  let out = [...(tweets || [])];
  for (const { from, to } of pairs) out = out.map((t) => t.split(from).join(to));
  return out;
}

const slugify = (s) => String(s).toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34);

async function main(resultChannel = null) {
  const harvestOf = args.find((a) => /^\d{4,}$/.test(a));
  if (!harvestOf) throw new Error('usage: node harvest-build.mjs <harvestOf> --account <key> [--create] [--at ISO]');
  const env = loadEnv();
  const acc = getAccount(flag('account', ''));
  const CREATE = args.includes('--create');
  const N = Number(flag('variants', 3));

  const specPath = join(HERE_DIR, 'queues', 'harvest', `${harvestOf}.json`);
  if (!existsSync(specPath)) throw new Error(`no harvest spec at queues/harvest/${harvestOf}.json — run harvest.mjs first`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const parentHook = String(spec.parentHook || '');
  const body = (spec.bodyTweets || []).map(String);
  if (!parentHook || body.length < 3) throw new Error(`spec ${harvestOf} is incomplete (hook ${parentHook.length} chars, ${body.length} body tweets)`);

  // A denied product must not ride back in on a parent's coat-tails. The kill list is a verdict on
  // the product, not on the thread that once plugged it, so a harvest of an old winner is exactly
  // the path a denied ASIN would return through.
  // The spec's product titles come from the parent's ledger row, and pre-2026-08-26 rows stored a
  // title truncated at 70 characters. Resolve through the catalogue by ASIN so the plug copy and the
  // ledger carry the real name.
  const catalogue = new Map(JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products.map((p) => [p.asin, p.title]));
  const products = (spec.products || []).map((p) => ({ ...p, title: catalogue.get(p.asin) || p.title })).filter((p) => {
    if (DENY_ASINS.has(p.asin)) { console.warn(`  ⚠ dropping ${p.asin} — on the DENY list`); return false; }
    return true;
  });

  console.log(`Harvest of ${harvestOf} for ${acc.name}: ${body.length} body tweets, ${products.length} product(s)`);
  console.log(`  parent: ${parentHook.split('\n')[0].slice(0, 80)}`);
  console.log(`  stats:  ${(spec.parentStats?.impressions || 0).toLocaleString()} views · ${spec.parentStats?.clicks || 0} clicks · $${(spec.parentStats?.commission || 0).toFixed(0)}`);

  // ---- the three hooks ----
  let bank = [];
  try { bank = JSON.parse(readFileSync(join(HERE_DIR, 'learnings', 'hook-bank.json'), 'utf8')); } catch {}
  const cands = [];
  for (let i = 1; i <= N; i++) {
    try {
      const h = await harvestHook(env, acc, parentHook, { variant: i, band: [LAWS.hook.gateMin, LAWS.hook.gateMax] });
      if (h) cands.push(String(h).trim());
    } catch (e) { console.warn(`  ⚠ hook ${i}: ${String(e.message).slice(0, 70)}`); }
  }
  if (!cands.length) throw new Error('no hook candidates generated — needs an LLM key');

  let ranked = rankHooks(cands, parentHook, { bank: Array.isArray(bank) ? bank : bank?.hooks || [] });
  const show = (rr) => rr.forEach((r, i) => console.log(`   ${i === 0 && r.ok ? '→' : ' '} ${Math.round(r.sim * 100)}%${r.strength != null ? ` · strength ${r.strength.toFixed(2)}` : ''}  ${r.ok ? '' : `[${r.issue.slice(0, 60)}]`}\n     ${r.hook.split('\n')[0].slice(0, 88)}`));
  console.log(`\n  ${ranked.length} hook(s) written, ${ranked.filter((r) => r.ok).length} in band:`);
  show(ranked);

  // CLOSED LOOP (2026-08-28). Three open-loop candidates are three draws from one bias, not three
  // chances: the first live run returned 66/64/61 against a 72% floor and the lane threw. Feeding the
  // MEASURED score back and asking for a correction is a different call, not a fourth sample. Two
  // rounds, best candidate each time, and a round that does not improve the score stops the loop.
  for (let round = 1; round <= 2 && !ranked[0]?.ok; round++) {
    const best = ranked[0];
    // BOTH EDGES (2026-08-28, seventh run). This used to bail unless the best candidate was UNDER the
    // floor, so two harvest slots that came back at 95% and 96% threw with no repair attempted at all.
    // A band has two sides and the same correction call fixes either.
    // EVERY WAY OF FAILING IS REPAIRABLE, not just the ratio (2026-08-28, eighth run). Both remaining
    // failures sat INSIDE the band and died on shape — "sentence 1 is 75 chars vs the donor's 49",
    // "sentence 1 is untouched" — and the loop broke out without spending a single correction on
    // either, because it only understood the whole-hook percentage.
    if (!best) break;
    const inBand = best.sim >= LAWS.hook.gateMin && best.sim <= LAWS.hook.gateMax;
    console.log(`\n  repair ${round}: ${inBand ? `in band at ${Math.round(best.sim * 100)}% but ${best.issue.slice(0, 60)}` : `best is ${Math.round(best.sim * 100)}%, band is ${Math.round(LAWS.hook.gateMin * 100)}-${Math.round(LAWS.hook.gateMax * 100)}%`}`);
    const fixes = [];
    for (let i = 1; i <= 2; i++) {
      try {
        const h = await harvestHook(env, acc, parentHook, {
          variant: i, band: [LAWS.hook.gateMin, LAWS.hook.gateMax],
          feedback: { sim: inBand ? undefined : best.sim, hook: best.hook, issue: best.issue },
        });
        if (h) fixes.push(String(h).trim());
      } catch (e) { console.warn(`  ⚠ repair hook ${i}: ${String(e.message).slice(0, 70)}`); }
    }
    if (!fixes.length) break;
    const next = rankHooks([...fixes, ...ranked.map((r) => r.hook)], parentHook, { bank: Array.isArray(bank) ? bank : bank?.hooks || [] });
    show(next.slice(0, fixes.length));
    // "No movement" is directional: closing on the band from below means sim went UP, from above it
    // means sim went DOWN. The old test only understood the upward case.
    const mid = (LAWS.hook.gateMin + LAWS.hook.gateMax) / 2;
    const closer = Math.abs(next[0].sim - mid) < Math.abs(best.sim - mid);
    // A shape repair does not move `sim` at all, so "no movement" must not stop it after one round.
    if (!next[0]?.ok && !closer && !inBand) { ranked = next; break; }   // no movement, stop paying
    ranked = next;
  }

  const winner = ranked[0];
  if (!winner?.ok) throw new Error(`no hook passed fidelity: ${ranked.map((r) => r.issue).filter(Boolean)[0]}`);

  // ---- fresh links ----
  const parentLinks = linksInOrder(body);
  // RE-MINT, ALWAYS — enforced here rather than described (2026-08-29). This was a console.warn and
  // the build carried on, which made the lane's founding law advisory. The harvest rebuild exists
  // because the old engine shipped 15 variations for 2.9M impressions, 1,718 clicks and $0.00, and
  // every way that can happen again runs through this one comparison.
  //
  // The invariant is that the child's links are ALL its own, and that it has some. Three distinct
  // ways to break it, all of them live on the 08-31 slate:
  //
  //   links > products   every parent link past the last minted product SURVIVES into the child, so
  //                      those clicks pay the PARENT's subid and the variation can never be measured
  //                      against its parent. Slot 10217031 carried 2 links and 0 products.
  //   links < products   substituteLinks has nowhere to put the surplus, so a product committed on
  //                      the spec silently never appears in the thread.
  //   links === 0        the parent was never monetized, so the harvest cannot carry a plug at all.
  //                      Slots 10316443 and 10315411 are this. Adding one is a /money-thread job on
  //                      the body, not something this lane can invent.
  if (parentLinks.length !== products.length || parentLinks.length === 0) {
    console.error(`✗ REFUSING TO BUILD — ${parentLinks.length} link(s) in the parent body, ${products.length} product(s) in the spec.`);
    if (parentLinks.length === 0) {
      console.error('  The parent carries no tracked link, so this harvest would ship with no plug and earn nothing,');
      console.error('  which is the exact outcome this lane was rebuilt to stop. Give the BODY a plug first with');
      console.error('  /money-thread, then harvest it; a hook variation cannot add one.');
    } else if (parentLinks.length > products.length) {
      const short = parentLinks.length - products.length;
      console.error(`  ${short} link(s) would keep the PARENT's URL, so the child's clicks would pay the parent's subid`);
      console.error(`  and the variation could never be measured against it. Put ${short} more product(s) on`);
      console.error(`  queues/harvest/${harvestOf}.json, chosen from what the BODY already argues.`);
    } else {
      console.error(`  ${products.length - parentLinks.length} product(s) have no link position to occupy and would be dropped silently.`);
      console.error(`  Trim queues/harvest/${harvestOf}.json to the ${parentLinks.length} the body can actually carry.`);
    }
    console.error('  bridgeableProducts() over the body tells you which substances it can honestly host.');
    process.exitCode = 1;
    return;
  }
  const pairs = [];
  if (CREATE) {
    const lev = levanta(env);
    const stem = `${acc.levantaSubidPrefix}-${slugify(parentHook)}-h${String(harvestOf).slice(-6)}`;
    for (let i = 0; i < Math.min(parentLinks.length, products.length); i++) {
      const subid1 = `${stem}${i ? `-${'bcde'[i - 1]}` : ''}`;
      const m = await lev.mintLink(products[i].asin, subid1, acc.levantaSubidPrefix);
      const to = acc.directLink ? (m.url || m.mobileOptimizedUrl) : (m.mobileOptimizedUrl || m.url);
      if (!to) throw new Error(`mint returned no url for ${products[i].asin}`);
      pairs.push({ from: parentLinks[i], to, asin: products[i].asin, title: products[i].title, subid1 });
      console.log(`  ✓ minted ${products[i].asin} -> ${to}`);
    }
  }

  const tweets = [winner.hook, ...substituteLinks(body, pairs)];
  // The losers ride into the draft so a swap is a copy-paste, not a regeneration.
  const parked = ranked.slice(1).map((r, i) => `HOOK ${i + 2} (${Math.round(r.sim * 100)}%${r.ok ? '' : ', OUT OF BAND'}): ${r.hook}`).join('\n\n');

  const out = {
    account: acc.key || flag('account'),
    harvestOf: String(harvestOf),
    tweets,
    products: pairs.map((p) => ({ asin: p.asin, title: p.title, link: p.to, subid1: p.subid1 })),
    ctaStyle: 'payoff',
    sourceUrl: spec.parentUrl || null,
    builtBy: 'harvest-build.mjs',
    builtHow: `${ranked.length} hooks written, ranked on fidelity to the parent then bank strength; winner at ${Math.round(winner.sim * 100)}%`,
    scratchpadExtra: parked,
  };
  const outPath = join(HERE_DIR, 'queues', 'harvest', `${harvestOf}.publish.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`\n  spec: queues/harvest/${harvestOf}.publish.json (${tweets.length} tweets)`);

  if (!CREATE) { console.log('  (no --create: nothing minted, nothing published)'); return; }
  const at = flag('at');
  const operationKey = flag('operation-key') || `harvest:${harvestOf}:${acc.socialSetId}:${at || 'unscheduled'}`;
  const outcome = await runResultChild(join(HERE_DIR, 'publish-thread.mjs'), ['--file', outPath, ...(at ? ['--at', at] : [])],
    { operationKey, cwd: HERE_DIR, timeout: 300000 });
  const { evidencePath, ...receipt } = outcome;
  resultChannel?.adopt(receipt);
  if (outcome.result?.draftId) console.log(`    Draft created: ${outcome.result.draftId}${outcome.result.shareUrl ? `\n    Share URL: ${outcome.result.shareUrl}` : ''}`);
  if (!outcome.ok) throw new Error(`publish-thread ${outcome.phase}: ${outcome.error}${evidencePath ? `; reconcile receipt ${evidencePath}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(() => withProcessResult(main), 'harvest-build');
