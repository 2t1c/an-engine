// harvest-repair.mjs — the repair lane for Harvest pool bodies.
//
// WHY THIS EXISTS (2026-09-04). The first day the farm ever spent hearts, 18 pool bodies were
// examined and 4 were shippable. Nine were refused by today's gates — and five of those nine were
// refused on ASK GEOMETRY alone, including peach's own origin ($0.499/1k) whose ask opens at T2 and
// clover's ($0.146/1k) whose ask opens at T6. These bodies earned real money under older CTA rules.
// Without a repair lane they are dead: /attempt must stay verbatim, so a refusal means "pick
// another" forever, and 136 hearts expire 2026-10-31 with nowhere to go.
//
// WHAT A REPAIR MAY AND MAY NOT DO. The body is the evidence, so the boundary is what changes the
// ARGUMENT:
//
//   MECHANICAL  numbering, bridge walls, over-length, a bare disclosure, a brand leak left by a
//               dead-product swap. These restore the body to what it already meant to be. The
//               argument is untouched, so the result is still an ATTEMPT and still spends a heart.
//   GEOMETRY    move a plug and its own bridge, as a unit, into the legal CTA window. Every
//               sentence survives; only the order changes. This is the same operation the operator
//               approved at seed-mint when clover's first ask moved T6 -> T4. Still an attempt —
//               same substances, same copy, same claims — but it is RECORDED, so a verdict is never
//               read as proof the original geometry works.
//   DECLARED    a substance the body ARGUES and never sells. No text changes at all: the finding is
//               recorded as an `allowUnsold` declaration and the body ships exactly as it earned.
//               This used to be FORBIDDEN on the reasoning that it "needs new copy", and that is
//               only true if you want to SELL the substance. An /attempt is a VERBATIM repost of a
//               body that already made money in this precise shape, so the unsold mention is not a
//               defect the repost introduced — it is what the winner did, and the gate's own
//               documented escape (`allowUnsold`, which validateDraft has always taken) exists for
//               exactly this. Measured on the live pool 2026-09-18: thirteen of the twenty-eight
//               blocked findings were this one class, on bodies holding 7 hearts each, including
//               the pool's densest at $0.849/1k. The alternative was never "write new copy" — a
//               variation spends no heart — it was "let those hearts expire".
//               RECORDED, like GEOMETRY, so a verdict is never read as proof the pattern is fine.
//   CTA         the plug's own selling copy, rewritten to current CTA law. Added 2026-09-19 on the
//               operator's rule: "improve and tweak cta flow for harvest and especially also the
//               seeds". This is the one place NEW copy is allowed, and the reasoning is the mirror
//               of DECLARED's. A pool body earned its money as a BODY -- the hook, the argument,
//               the order of the claims -- and every one of them earned it behind the OLD CTA, the
//               formula era checks.mjs measures at 2 shapes across 16 plugs against the winning
//               era's 12 across 15. Reposting that plug verbatim is not preserving the evidence;
//               it is reproducing the worst-measured half of it. So the BODY stays verbatim and the
//               PLUG may be rewritten, which is exactly the line ctaOnlyChange enforces below.
//               RECORDED, like GEOMETRY and DECLARED, so a verdict is never read as proof the old
//               plug works -- and never as proof the new one does either, until the cells say so.
//   FORBIDDEN   a banned topic, or anything needing NEW copy OUTSIDE the plug: a claim, a hook
//               rewrite, a plug budget overrun, a new tweet. Never repaired here. A body that needs
//               new sentences in its argument needs a VARIATION (no heart), not a repair.
//
// NOTHING SHIPS UNVERIFIED. Every repair is re-gated after it is applied. A repair that does not
// come back clean is reported and discarded — never written, never shipped on a hope.
//
//   node harvest-repair.mjs <originDraftId> --from <accountKey> [--harvest <rec>] [--apply]
//   node harvest-repair.mjs --all                 # diagnose every In Pool body, write nothing

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, typefully, HERE_DIR, cliArg } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { validateDraft, isTrackedLink, substanceTermsFor, renumberLeadingMarkers } from './checks.mjs';
import { joinNumberedHeadings } from './content/text-shape.mjs';

export const REPAIR_DIR = join(HERE_DIR, 'queues', 'harvest-repairs');

// ---------------------------------------------------------------- classification

// A finding's class decides whether it may be touched at all. Matched on the gate's own text
// because that is the contract every caller already reads; unknown findings are FORBIDDEN by
// default, so a new gate can never be silently repaired by a rule that never considered it.
const MECHANICAL = [
  /numbering broken/i,
  /BRAND LEAK/i,
  /over 280|is \d+ characters/i,
  /bridgeWall|one sentence per line|is a wall/i,
  /bare disclosure|missing sign-off|last tweet is not the disclaimer/i,
];
const GEOMETRY = [
  /first ask opens at tweet \d+/i,
  /SELLS BEFORE IT JUSTIFIES/i,
];
// A substance the body argues and never sells. Declared, not rewritten — see the header.
const DECLARED = [
  /never sells it|never asked for|unsold/i,
];
// The plug's own selling copy. Matched narrowly and checked WIDELY: a finding landing here only
// permits the repair, and ctaOnlyChange still has to agree the edit stayed inside the plug.
const CTA = [
  /no affiliate disclosure line|bare disclosure/i,
  /disclosure line instead of its own|link appears before the disclosure/i,
  /CTA line/i,
];
const FORBIDDEN = [
  /BANNED topic/i,
  /superlative/i,
  /claim/i,
];

export function classify(finding) {
  const s = String(finding || '');
  if (FORBIDDEN.some((re) => re.test(s))) return 'FORBIDDEN';
  if (DECLARED.some((re) => re.test(s))) return 'DECLARED';
  // Before MECHANICAL: a bare disclosure is repairable either way, but calling it CTA records that
  // the plug was touched, and that record is what keeps the 48h verdict honest.
  if (CTA.some((re) => re.test(s))) return 'CTA';
  if (GEOMETRY.some((re) => re.test(s))) return 'GEOMETRY';
  if (MECHANICAL.some((re) => re.test(s))) return 'MECHANICAL';
  return 'FORBIDDEN'; // unknown gates are never auto-repaired
}

/** PURE. The substance names an unsold-substance finding is complaining about.
 *
 *  The gate's wording is stable and quoted: `thread argues "cortisol" across 5 tweets (route
 *  B079K32QB6), "d3" across 4 tweets (...) but never sells it`. Parsing its own message is the same
 *  contract `classify` already relies on, and a finding whose substances cannot be read yields an
 *  empty list — which declares nothing and leaves the body blocked, rather than waving it through. */
export function unsoldSubstances(finding) {
  const s = String(finding || '');
  if (!DECLARED.some((re) => re.test(s))) return [];
  const upTo = s.split(/but never sells it/i)[0];
  return [...new Set([...upTo.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim().toLowerCase()).filter(Boolean))];
}

// ---------------------------------------------------------------- mechanical

// bridgeWallIssue: two or more sentences sharing one line. The fix inserts a blank line between
// them and changes NOTHING else — same words, same order, same punctuation. This is the single
// most common defect left in the pool, because the house one-sentence-per-line rule post-dates
// most of these bodies.
export function splitWalls(text, { max = 280 } = {}) {
  const joined = joinNumberedHeadings(text);
  const split = joined.split('\n').map((line) => {
    const t = line.trim();
    if (!t || /https?:\/\//.test(t)) return line;           // never reflow a link line
    const parts0 = t.split(/(?<=[.?!])\s+(?=[A-Z"'\u201c])/).filter(Boolean);
    // A BARE ENUMERATOR IS NOT A SENTENCE. "1. Don't walk 10,000 steps." ends its marker in a full
    // stop, so the sentence split above cut between "1." and the item title and left the number
    // alone on its own line with a blank line under it — the first thing a reader sees on the tweet,
    // and the shape the operator reported on clara 10653364 (five items, five orphaned markers).
    // respaceWall has carried this guard since it was written, which is why the cover lane never
    // produced it; the harvest lane had its own splitter and did not.
    const parts = [];
    for (const p of parts0) {
      if (parts.length && /^\d{1,2}[.)/]$/.test(parts[parts.length - 1].trim())) parts[parts.length - 1] += ` ${p}`;
      else parts.push(p);
    }
    return parts.length > 1 ? parts.join('\n\n') : line;
  }).join('\n');
  // A REPAIR MUST NEVER CREATE A DEFECT. Each split trades one space for a blank line, +1 character,
  // so a tweet sitting at exactly 280 comes out at 282 and the repair has manufactured an
  // over-length failure that was not there. peach's origin ($0.499/1k) was broken this way. When
  // the split would overflow, leave the wall alone: the body then still fails bridgeWallIssue and
  // is honestly reported as unrepairable, which is the correct outcome.
  return split.length > max && joined.length <= max ? joined : split;
}

/** Apply the mechanical repairs that add no words: wall splits, then renumbering. */
export function mechanicalRepairs(tweets, findings) {
  const notes = [];
  let out = [...tweets];

  if (findings.some((f) => /stacks sentences in one paragraph|is a wall|one sentence per line/i.test(f))) {
    const split = out.map(splitWalls);
    if (split.some((t, i) => t !== out[i])) {
      notes.push({ move: 'split-walls', at: split.map((t, i) => (t !== out[i] ? i + 1 : 0)).filter(Boolean).join(',') });
      out = split;
    }
  }
  if (findings.some((f) => /numbering broken/i.test(f))) {
    const renum = renumberLeadingMarkers(out);
    if (Array.isArray(renum) && renum.length === out.length && renum.some((t, i) => t !== out[i])) {
      notes.push({ move: 'renumber', at: renum.map((t, i) => (t !== out[i] ? i + 1 : 0)).filter(Boolean).join(',') });
      out = renum;
    }
  }
  return { tweets: out, notes };
}

// ---------------------------------------------------------------- cta

/** PURE. Is this edit confined to the PLUG, leaving the body the evidence it was?
 *
 *  The whole value of a harvest is that the thing being reposted is the thing that earned. A CTA
 *  repair is allowed to spend that evidence on the selling half and nowhere else, so this is the
 *  line, and it is checked rather than trusted: an LLM asked to "improve the CTA" will cheerfully
 *  tighten a body sentence on the way past, and nothing downstream would ever notice.
 *
 *  Returns [] when the edit is legal, else one string per violation.
 *
 *  A plug tweet may be rewritten freely EXCEPT that it must keep its link: the link is the
 *  attribution, and a repair that drops or changes it makes the 48h verdict unreadable, which is
 *  the same failure /attempt's re-mintable check exists to prevent.
 */
export function ctaOnlyChange(before = [], after = []) {
  const out = [];
  if (before.length !== after.length) {
    out.push(`the thread changed length: ${before.length} tweets in, ${after.length} out — a CTA repair never adds or removes a tweet`);
    return out;
  }
  const plugs = new Set(plugIndices(before));
  if (!plugs.size) out.push('no plug tweet found in the original — nothing here is a CTA to repair');
  const linksOf = (t) => String(t).match(/https?:\/\/\S+/g) || [];
  for (let i = 0; i < before.length; i++) {
    const a = String(before[i]), b = String(after[i]);
    if (a === b) continue;
    if (!plugs.has(i)) {
      out.push(`tweet ${i + 1} is body, not plug, and it changed — the body is the evidence and stays verbatim`);
      continue;
    }
    const la = linksOf(a), lb = linksOf(b);
    if (la.length !== lb.length || la.some((l, n) => l !== lb[n])) {
      out.push(`tweet ${i + 1}'s link changed — the plug may be rewritten, its tracking link may not`);
    }
  }
  if (plugIndices(after).length !== plugs.size) {
    out.push('the number of plug tweets changed — a CTA repair rewrites plugs, it never adds or drops one');
  }
  return out;
}

// ---------------------------------------------------------------- geometry

export const plugIndices = (tweets) => tweets
  .map((t, i) => (isTrackedLink(String(t)) || /https?:\/\/(lvnta\.com|www\.amazon\.)/i.test(String(t)) ? i : -1))
  .filter((i) => i >= 0);

/** Does this tweet read as the plug's own bridge — does it name what the plug sells? */
export function isBridgeFor(tweet, product) {
  const terms = substanceTermsFor(product || {});
  if (!terms.length) return false;
  const lc = String(tweet).toLowerCase();
  return terms.some((t) => lc.includes(t));
}

/**
 * Move the FIRST plug into the legal window, carrying its own bridge with it.
 * Pure: returns { tweets, move } or { tweets, move: null } when nothing needed moving.
 *
 * Too LATE  (plug index > target): lift [bridge, plug] out and re-insert at target-1, so the pair
 *           arrives together and the bridge still sits immediately before its plug.
 * Too EARLY (plug index < target): push [bridge, plug] down to the target, which pulls the body
 *           beats that followed up above it. The pair still travels together, so the criterion
 *           still lands immediately before the link.
 */
export function moveFirstAskIntoWindow(tweets, { targetPlugIdx = 3, product = null } = {}) {
  const plugs = plugIndices(tweets);
  if (!plugs.length) return { tweets: [...tweets], move: null };
  const p = plugs[0];
  if (p === targetPlugIdx) return { tweets: [...tweets], move: null };

  // The bridge is the tweet immediately before the plug, but only when it is a real bridge:
  // it must name the plugged substance, and it must not be the hook (T1 never moves).
  const hasBridge = p > 1 && (product ? isBridgeFor(tweets[p - 1], product) : true);
  const block = hasBridge ? [p - 1, p] : [p];
  const rest = tweets.filter((_, i) => !block.includes(i));
  const moved = block.map((i) => tweets[i]);

  // Where the block lands so the PLUG ends up at targetPlugIdx.
  const insertAt = Math.max(0, targetPlugIdx - (moved.length - 1));
  if (insertAt > rest.length) return { tweets: [...tweets], move: null };
  const out = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];

  return {
    tweets: out,
    move: {
      from: block.map((i) => i + 1),
      to: Array.from({ length: moved.length }, (_, k) => insertAt + k + 1),
      carriedBridge: hasBridge,
      direction: p > targetPlugIdx ? 'earlier' : 'later',
    },
  };
}

// ---------------------------------------------------------------- gate

// PRODUCTS MUST COME FROM THE LEDGER, never left empty. validateDraft's unsoldSubstanceIssue reads
// the declared products to decide whether an argued substance was sold, so gating with `products: []`
// reports EVERY substance in the body as unsold — a first cut of this file did exactly that and
// declared 18 of 20 bodies unrepairable, including ones republish gates clean. Same class of error
// as gating with a placeholder title: an empty fixture invents failures that do not exist.
export function productsForDraft(originDraftId) {
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (!existsSync(f)) return [];
  let row = null;
  for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (String(e.draftId) === String(originDraftId)) row = e; } catch { /* skip */ }
  }
  if (!row) return [];
  return [[row.asin, row.product, row.link], [row.asin2, row.product2, row.link2]]
    .filter(([asin]) => asin)
    .map(([asin, title, link]) => ({ asin, title: title || '', link: link || null }));
}

export function gate(tweets, account, products) {
  const links = tweets.filter((t) => /https?:\/\//.test(t)).map((t) => (t.match(/https?:\/\/\S+/) || [''])[0]);
  const issues = validateDraft(tweets, links, account, true, products, { ctaDepth: 2 }) || [];
  return issues.map((i) => (typeof i === 'string' ? i : i.message || JSON.stringify(i)));
}

export const repairPath = (recId) => join(REPAIR_DIR, `${recId}.json`);
/** Drop a candidate repair from `path`. When a kept repair sat there before the candidate was
 *  written (`kept` = its text, null when there was none), it goes back byte for byte instead of
 *  disappearing with the candidate. Returns true when a kept file was restored. Pure apart from
 *  the one path it owns, so a dry run stays a dry run. */
export function discardCandidate(path, kept, why = '') {
  if (kept !== null && kept !== undefined) { writeFileSync(path, kept); return true; }
  rmSync(path, { force: true });
  return false;
}
export const loadRepair = (recId) => {
  const p = repairPath(recId);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

// ---------------------------------------------------------------- CLI

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY', 'REGISTRY_BASE_ID']);
  const tf = typefully(env);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const APPLY = process.argv.includes('--apply');
  const ALL = process.argv.includes('--all');

  const harvests = await at.listAll('Harvests', {});
  const pool = harvests.filter((r) => (r.fields.Status || '') === 'In Pool');

  const targets = ALL
    ? pool
    : [pool.find((r) => String(r.fields['Origin Draft ID']) === String(cliArg('', process.argv[2]) || process.argv[2]))].filter(Boolean);
  if (!targets.length) throw new Error('No matching In Pool body — pass an Origin Draft ID, or --all');

  mkdirSync(REPAIR_DIR, { recursive: true });
  let repairable = 0, forbidden = 0, alreadyClean = 0;

  for (const row of targets) {
    const draftId = String(row.fields['Origin Draft ID']);
    const acctKey = String(cliArg('from', '') || '').trim();
    let account, resolvedKey = acctKey || String(row.fields['Origin Account'] || '').split(' ')[0].toLowerCase();
    try { account = getAccount(resolvedKey); }
    catch { console.log(`? ${draftId} — cannot resolve account "${row.fields['Origin Account']}"; pass --from`); continue; }

    let posts;
    try { posts = ((await tf.getDraft(account.socialSetId, draftId)).platforms?.x?.posts || []).map((p) => p.text); }
    catch (e) { console.log(`? ${draftId} — ${String(e.message).slice(0, 70)}`); continue; }
    if (!posts.length) { console.log(`? ${draftId} — no X posts`); continue; }

    const prods = productsForDraft(draftId);
    const before = gate(posts, account, prods);
    const label = `${String(row.fields.Body || '').slice(0, 40)}`;
    if (!before.length) { alreadyClean++; console.log(`✓ ${draftId}  ${label} — already clean, no repair needed`); continue; }

    const classes = before.map((f) => [classify(f), f]);
    // What the body argues and never sells, declared rather than rewritten. Collected before the
    // FORBIDDEN check so a body carrying BOTH is still refused — a declaration never launders one.
    const allowUnsold = [...new Set(classes.filter(([c]) => c === 'DECLARED').flatMap(([, f]) => unsoldSubstances(f)))];
    const blocked = classes.filter(([c]) => c === 'FORBIDDEN');
    if (blocked.length) {
      forbidden++;
      console.log(`✗ ${draftId}  ${label}`);
      for (const [, f] of blocked) console.log(`    FORBIDDEN  ${f.slice(0, 96)}`);
      console.log('    → needs a VARIATION (new copy, no heart), not a repair.');
      continue;
    }

    // A declaration that declares nothing is not a repair. If the gate's wording changes and the
    // substances stop parsing, the body stays blocked and says why, rather than shipping unguarded.
    const undeclarable = classes.filter(([c, f]) => c === 'DECLARED' && !unsoldSubstances(f).length);
    if (undeclarable.length) {
      forbidden++;
      console.log(`✗ ${draftId}  ${label}`);
      for (const [, f] of undeclarable) console.log(`    UNDECLARABLE  ${f.slice(0, 96)}`);
      console.log('    → the unsold finding named no substance this could declare; check the gate wording.');
      continue;
    }

    // Geometry is the only structural move allowed, and only into the legal window.
    let tweets = [...posts];
    const moves = [];
    const mech = mechanicalRepairs(tweets, before);
    tweets = mech.tweets;
    for (const n of mech.notes) moves.push(n);
    if (classes.some(([c]) => c === 'GEOMETRY')) {
      const { tweets: moved, move } = moveFirstAskIntoWindow(tweets, { targetPlugIdx: 3, product: prods[0] || null });
      if (move) { tweets = moved; moves.push(move); }
    }

    // THE CTA BOUNDARY, checked on every repair rather than only on a CTA one. Mechanical fixes and
    // the geometry move both rewrite tweets, and neither is supposed to touch a body sentence; this
    // is the assertion that they did not. It is placed here, after every edit and before the
    // candidate is written, because a boundary checked only on the path that declares it is a
    // boundary anything else can walk around.
    const ctaTouched = classes.some(([c]) => c === 'CTA');
    if (ctaTouched) {
      const strayed = ctaOnlyChange(posts, tweets);
      if (strayed.length) {
        forbidden++;
        console.log(`✗ ${draftId}  ${label}`);
        for (const w of strayed) console.log(`    OUT OF BOUNDS  ${w}`);
        console.log('    → a CTA repair rewrites the plug and nothing else; this one left the plug.');
        continue;
      }
    }

    // VERIFY WITH REPUBLISH, NOT WITH A LOCAL GATE. A standalone gate is not faithful to what
    // actually ships: republish swaps in the target garden's current disclaimer and sign-off, runs
    // its own repost repairs, and re-mints links. Gating locally flagged "treat disease" inside a
    // stale disclaimer republish would have replaced. So the candidate is written first, then
    // republish --gate-only is asked to judge the body it would really send, and the candidate is
    // kept only if that comes back clean.
    //
    // A KEPT repair is evidence, not scratch. An earlier --apply left a file republish already gated
    // clean, and the candidate below overwrites that path so the gate call can read it. Until
    // 2026-09-07 both discard branches rmSync'd the path outright, so a plain dry run — the mode
    // that promises to touch nothing — deleted two kept repairs (two record ids,
    // since gone) and the next --harvest run shipped the unrepaired body. Remember what was
    // there, and put it back whenever the candidate is discarded.
    const kept = existsSync(repairPath(row.id)) ? readFileSync(repairPath(row.id), 'utf8') : null;
    const discard = (why) => discardCandidate(repairPath(row.id), kept, why);
    writeFileSync(repairPath(row.id), JSON.stringify({
      harvestRecId: row.id, originDraftId: draftId, originAccount: account.name, body: row.fields.Body,
      repairedAt: new Date().toISOString(), products: prods.map((x) => x.asin),
      classes: classes.map(([c, f]) => ({ class: c, finding: f })),
      moves, geometryChanged: moves.some((m) => m.direction),
      // RECORDED like geometryChanged, and for the same reason: a 48h verdict on a body whose plug
      // was rewritten is a verdict on the new plug too, and the next reader must be able to tell.
      ctaRepaired: ctaTouched,
      // republish unions this with its own --allow-unsold flag when it gates the repost.
      ...(allowUnsold.length ? { allowUnsold } : {}), tweets,
    }, null, 1) + '\n');

    let verdict = '';
    try {
      verdict = execFileSync('node', [join(HERE_DIR, 'republish.mjs'), draftId,
        '--account', resolvedKey, '--from', resolvedKey,
        '--harvest', row.id, '--gate-only'], { encoding: 'utf8', timeout: 180000 });
    } catch (e) { verdict = (e.stdout || '') + (e.stderr || ''); }
    // ONLY AN EXPLICIT "gates clean" IS A PASS. An earlier cut inferred success from "no findings
    // parsed", so when republish CRASHED — it did, on a printer bug — the empty output read as a
    // clean verdict and unverified repairs were written. Absence of evidence is not a pass.
    const clean = /gates clean/.test(verdict);
    // Only lines AFTER the REFUSED banner are gate findings — republish prints its own repair notes
    // with the same "· " prefix, and reporting those as the reason reads as nonsense.
    const vl = verdict.split('\n');
    const rAt = vl.findIndex((l) => /REFUSED/.test(l));
    const found = rAt < 0 ? [] : vl.slice(rAt + 1).filter((l) => l.trim().startsWith('· ')).map((l) => l.trim().slice(2));
    const after = clean ? [] : (found.length ? found : [`republish did not report a clean gate: ${(verdict.match(/ERROR:.*/) || ['no verdict parsed'])[0].slice(0, 70)}`]);
    console.log(`${after.length ? '✗' : '✓'} ${draftId}  ${label}`);
    for (const [c, f] of classes) console.log(`    ${c.padEnd(10)} ${f.slice(0, 92)}`);
    for (const m of moves) {
      if (m.move) console.log(`    FIX        ${m.move} @T${m.at}`);
      else console.log(`    MOVE       ask T${m.from.join('+T')} -> T${m.to.join('+T')} (${m.direction}${m.carriedBridge ? ', bridge carried' : ', NO bridge — verify'})`);
    }
    if (after.length) {
      const restored = discard('republish refused the candidate');
      console.log(`    → republish still refuses; candidate discarded${restored ? ', the kept repair restored' : ''}. ${(after[0] || '').slice(0, 88)}`);
      continue;
    }

    repairable++;
    if (!APPLY) {
      const restored = discard('dry run');
      console.log(`    → REPAIRABLE, republish gates it clean (dry run; pass --apply to keep${restored ? ' — the kept repair is back in place' : ''})`);
      continue;
    }
    console.log(`    ✓ kept: queues/harvest-repairs/${row.id}.json — republish gates it clean`);
  }

  console.log(`\n${repairable} repairable · ${forbidden} need a variation · ${alreadyClean} already clean`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
