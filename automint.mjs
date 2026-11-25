// automint.mjs — fill a draft's [LINK] placeholders with freshly minted tracked links.
//
// The tag lane (operator 2026-08-28). You tag a Typefully draft `needs-links`, the existing webhook
// fires `draft.tags_changed` at n8n, n8n dispatches this, and the draft comes back with real URLs.
//
// THE TRIGGER WAS NEVER THE HARD PART. A tag says "mint this"; it cannot say which ASIN or which
// subid. Resolving that is the whole job, and it is the same walk the mint-link skill spells out for
// a human: start at the tweet holding the placeholder and walk BACKWARDS until one yields a
// substance, because the bridge — the tweet before the plug — is where the reader was handed it.
//
// THE RULE THAT HAS TO SURVIVE BEING AUTOMATED: if nothing resolves in range, mint NOTHING. A thread
// whose item 2 said "Restore nitric oxide" once shipped selling magnesium, because the nitric-oxide
// bottle was delisted and magnesium was the convenient thing nearby that minted cleanly. Every gate
// passed; a human caught it. An automation that never declines makes that mistake at volume instead
// of once. So an unresolved slot KEEPS its placeholder, the reason goes in the scratchpad, and the
// draft is tagged mint-failed — and because placeholderIssue already gates the [LINK] shape at
// publish, a draft this script could not finish physically cannot ship with a hole in it.
//
//   node automint.mjs <draftId> --account julian [--dry] [--force]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, levanta, typefully, runMain, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { selectPod } from './outline.mjs';
import { productPerf, provenLoser } from './pick-product.mjs';
import { bridgeableProducts, DENY_ASINS, ALLOW_ASINS, PLACEHOLDER_RE, isTrackedLink } from './checks.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };

// THE TAG IS THE STATE MACHINE, AND `minting` IS A LOCK (operator 2026-08-28).
//
//   needs-links → minting → minted
//                        ↘ mint-failed
//
// The lock is claimed BEFORE anything is resolved or minted, not after. Two things make that the
// right order. A webhook can fire twice — Typefully's does not promise exactly-once — and a second
// run that starts while the first is still minting would burn a second set of subids on the same
// draft, which silently splits one thread's revenue across two attribution keys and corrupts every
// split-test that reads it. And claiming first means the in-flight state is VISIBLE: a draft stuck
// on `minting` is a crashed run you can see in a tag filter, which is a far better failure than a
// duplicate mint you cannot.
export const TAG_TODO = 'needs-links';
export const TAG_BUSY = 'minting';
export const TAG_DONE = 'minted';
export const TAG_FAIL = 'mint-failed';
export const TAGS = [TAG_TODO, TAG_BUSY, TAG_DONE, TAG_FAIL];

/** The next tag set for a draft, dropping every state tag we own and adding one. Pure. */
export const retag = (current, next) =>
  [...new Set([...(current || []).filter((t) => !TAGS.includes(t)), ...(next ? [next] : [])])];

/**
 * Resolve ONE placeholder slot to a product. Pure — takes the tweets, the index holding the
 * placeholder, the catalogue and the perf table, and returns {asin,title} or null with a reason.
 *
 * The walk-back is the point. `hook` is passed only when testing tweet 0, so a symptom word dropped
 * once into a hook list cannot pull a plug into a thread about something else (SYMPTOM_GATED).
 *
 * Filters, in the order they bind and each for a reason already paid for: never denied, on the
 * allowlist (off the menu means the picker could never have chosen it), pod-covered (no pod means no
 * CTA copy exists, so the slot cannot be written), never a proven loser. Then rank on REALISED EPC,
 * ours, not Levanta's platform figure which runs high on warm audiences. `unjudged` is not a demerit:
 * a product under 100 lifetime clicks has no verdict, and if it is the only honest fit it is the pick.
 */
export function resolveSlot(tweets, idx, { products, perf = {}, used = new Set(), maxLookback = 4 } = {}) {
  const list = (tweets || []).map((t) => String(t || ''));
  for (let back = 0; back <= maxLookback && idx - back >= 0; back++) {
    const i = idx - back;
    const substances = bridgeableProducts(list[i], i === 0 ? { hook: list[0] } : {});
    if (!substances.size) continue;
    const fits = (products || [])
      .filter((p) => substances.has(p.asin))
      .filter((p) => !DENY_ASINS.has(p.asin) && !p.unavailable)
      .filter((p) => !ALLOW_ASINS.size || ALLOW_ASINS.has(p.asin))
      .filter((p) => { try { return !!selectPod(p)?.pod; } catch { return false; } })
      .filter((p) => !provenLoser(p, perf))
      .filter((p) => !used.has(p.asin))          // two distinct products convert ~3x the same one twice
      .sort((a, b) => Number(perf[b.asin]?.epc ?? 0) - Number(perf[a.asin]?.epc ?? 0));
    // `candidates` is the shortlist Jev reads (decisions/plug-fill.mjs); `product` stays the code's pick.
    if (fits.length) return { product: fits[0], candidates: fits.slice(0, 6), foundIn: i + 1, back };
    return { product: null, foundIn: i + 1, back, reason: `tweet ${i + 1} names a substance we hold no sellable product for` };
  }
  return { product: null, reason: `no substance in the ${maxLookback + 1} tweets up to and including ${idx + 1}` };
}

/**
 * Jev's pick for one slot (decisions/plug-fill.mjs). Returns { action: 'fill'|'decline', asin, source,
 * confidence, best }. Unread (no key, breaker, error, below the floor) is the incumbent: the code's
 * highest-EPC candidate, source 'incumbent' or 'fallback', exactly as before Jev.
 */
export async function jevFill({ tweets, idx, foundIn, candidates, subject = null }, jevCtx) {
  const first = candidates?.[0];
  const code = { action: first ? 'fill' : 'decline', asin: first?.asin ?? null, source: 'incumbent', confidence: null, best: null };
  if (!jevCtx?.decide || !candidates?.length) return { ...code, source: 'fallback', why: 'no Jev' };
  const list = (tweets || []).map((t) => String(t || ''));
  const from = Math.max(0, Math.min((foundIn || idx + 1) - 1, idx - 1));
  const input = { plug: list[idx], leadIn: list.slice(from, idx).join('\n\n'), candidates };
  try {
    const d = await jevCtx.decide('plug-fill', input, { client: jevCtx.client, registry: jevCtx.registry, laws: jevCtx.laws, log: jevCtx.log, cache: jevCtx.cache, subject });
    const best = Math.max(0, ...((d.detail?.readings || []).map((r) => (Number.isFinite(r.noul) ? r.noul : 0))));
    if (d.source !== 'jev') return { ...code, source: d.source, why: d.fallback || d.reason || null, best: d.answers ? +best.toFixed(2) : null };
    return { action: d.action, asin: d.action === 'fill' ? d.detail?.asin ?? null : null, source: 'jev', confidence: d.confidence, best: +best.toFixed(2) };
  } catch (e) {
    return { ...code, source: 'fallback', why: String(e?.message || e).slice(0, 80) };
  }
}

/** One line for the console and the scratchpad: who picked, and how sure. */
export const jevLine = (j) => (!j ? 'Jev not asked'
  : j.source === 'jev' ? `Jev ${j.action} ${j.confidence}`
  : `Jev not read (${j.why || j.source}); code pick`);

/** Jev for the sweep and the CLI, loaded once. Without a key it is null and the code pick stands. */
export async function jevContextFor(env) {
  try {
    const [{ jev }, { decide, createDecisionLog }, { DECISIONS }, { LAWS }] = await Promise.all([
      import('./jev.mjs'), import('./jev-decide.mjs'), import('./decisions/index.mjs'), import('./laws.mjs')]); // optional-import
    return { client: jev(env), decide, registry: DECISIONS, laws: LAWS, log: createDecisionLog() };
  } catch { return null; }
}

/** Where the placeholders are. `[LINK]`-shaped only — the token placeholderIssue already gates. */
export const placeholderSlots = (tweets) =>
  (tweets || []).map((t, i) => (PLACEHOLDER_RE.test(String(t)) ? i : -1)).filter((i) => i >= 0);

/** Subid: one stem per draft, one suffix per slot in reading order. Matches preflight's convention. */
export function automintSubid(accountKey, hook, draftId, index = 0) {
  const tail = String(draftId || '').slice(-6);
  const suffix = index > 0 ? `-${String.fromCharCode(97 + index)}` : '';
  const room = 50 - `x-thread-${accountKey}-`.length - tail.length - 1 - suffix.length;
  const slug = String(hook || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, Math.max(4, room)).replace(/-$/, '');
  return `x-thread-${accountKey}-${slug}-${tail}${suffix}`;
}

/**
 * Mint ONE draft. Exported so the sweep can drive it per draft in-process: a cron that shells out
 * once per account pays the module load eleven times over and throws away the shared perf table
 * between each one.
 *
 * Returns a status so a caller can report without re-reading the draft:
 *   'minted' | 'declined' (no honest product) | 'claimed' (lock held) | 'nothing' | 'dry'
 */
export async function automintDraft(env, acc, draftId, { dry = false, force = false, jev } = {}) {
  const DRY = dry, FORCE = force;
  const ctx = { jev };
  const tf = typefully(env);
  const draft = await tf.getDraft(acc.socialSetId, draftId);
  const posts = draft.platforms?.x?.posts || [];
  const tweets = posts.map((p) => String(p.text || ''));
  if (!tweets.length) throw new Error(`draft ${draftId} has no X posts`);

  const slots = placeholderSlots(tweets);
  console.log(`■ ${draft.draft_title || draftId} — ${tweets.length} tweet(s), ${slots.length} placeholder(s)`);
  if (!slots.length) { console.log('  nothing to mint — no [LINK] placeholders'); return { status: 'nothing' }; }

  // CLAIM THE LOCK FIRST. A draft already marked minting or minted is refused rather than re-run:
  // a duplicate webhook must never buy a second set of subids for one thread.
  const held = (draft.tags || []).find((t) => t === TAG_BUSY || t === TAG_DONE);
  if (held && !FORCE) {
    console.log(`\n✗ draft is already tagged ${held} — refusing. A duplicate mint splits one thread's revenue across two subids.`);
    console.log(`  If a previous run crashed and left it on ${TAG_BUSY}, re-run with --force.`);
    return { status: 'claimed', held };
  }
  if (!DRY) await tf.patchDraft(acc.socialSetId, draftId, { tags: retag(draft.tags, TAG_BUSY) });
  console.log(`  tag → ${TAG_BUSY}`);

  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || [];
  const perf = productPerf();

  // RESOLVE EVERY SLOT BEFORE MINTING ANYTHING. A half-minted draft is the worst outcome available:
  // it burns subids on links that may never be used and leaves the caller to work out which landed.
  // Code shortlists; Jev picks the one the words actually recommend (decisions/plug-fill.mjs), or
  // declines the slot. Slots run in order so the second product is never the first one again.
  const jevCtx = ctx.jev !== undefined ? ctx.jev : await jevContextFor(env); // null: no key, code picks
  const used = new Set();
  const plan = [];
  for (const [n, idx] of slots.entries()) {
    const r = resolveSlot(tweets, idx, { products, perf, used });
    const s = { ...r, idx, n, jev: null };
    if (r.product) {
      const pick = await jevFill({ tweets, idx, foundIn: r.foundIn, candidates: r.candidates, subject: `draft:${draftId}` }, jevCtx);
      s.jev = pick;
      if (pick.action === 'decline') { s.product = null; s.reason = `Jev: the words recommend none of ${r.candidates.length} candidate(s) (best ${pick.best ?? 'n/a'})`; }
      else if (pick.asin) s.product = r.candidates.find((c) => c.asin === pick.asin) || r.product;
    }
    if (s.product) used.add(s.product.asin);
    plan.push(s);
  }
  for (const s of plan) {
    if (s.product) {
      const epc = Number(perf[s.product.asin]?.epc ?? 0);
      const clicks = Number(perf[s.product.asin]?.clicks ?? 0);
      console.log(`  T${s.idx + 1} → ${s.product.asin}  ${String(s.product.title).slice(0, 40).padEnd(40)} ${clicks < 100 ? 'unjudged' : `EPC $${epc.toFixed(3)}`}   substance found in T${s.foundIn} · ${jevLine(s.jev)}`);
    } else console.log(`  T${s.idx + 1} → UNRESOLVED: ${s.reason}`);
  }

  const unresolved = plan.filter((s) => !s.product);
  if (unresolved.length) {
    // Declining is the feature. Nothing is minted, nothing is patched, the placeholders stay in, and
    // the tag says so — a slot we cannot fill honestly is a decision for a person, not a fallback.
    console.log(`\n✗ ${unresolved.length} slot(s) unresolved — minting NOTHING. The placeholder stays in and the draft is tagged ${TAG_FAIL}.`);
    if (!DRY) {
      await tf.patchDraft(acc.socialSetId, draftId, {
        tags: retag(draft.tags, TAG_FAIL),
        scratchpad_text: `${draft.scratchpad_text || ''}\n\nAUTOMINT DECLINED ${new Date().toISOString()}\n${unresolved.map((s) => `  T${s.idx + 1}: ${s.reason}`).join('\n')}`.trim(),
      });
    }
    return { status: 'declined', unresolved };
  }

  if (DRY) { console.log('\n--dry: nothing minted'); return { status: 'dry', plan }; }

  const lev = levanta(env);
  const minted = [];
  for (const s of plan) {
    // levantaSubidPrefix is ALREADY "x-thread-<key>", and automintSubid prepends "x-thread-" itself,
    // so passing the prefix produced "x-thread-x-thread-julian-..." on the first live run. Nine wasted
    // characters out of a 50-char budget, which silently truncates the slug that makes a subid
    // readable. Strip the prefix back to the bare key.
    const key = String(acc.levantaSubidPrefix || '').replace(/^x-thread-/, '');
    const subid1 = automintSubid(key, tweets[0], draftId, s.n);
    const m = await lev.mintLink(s.product.asin, subid1, acc.levantaSubidPrefix);
    const url = acc.directLink ? (m.url || m.mobileOptimizedUrl) : (m.mobileOptimizedUrl || m.url);
    if (!url) throw new Error(`mint returned no url for ${s.product.asin}`);
    if (!isTrackedLink(url)) throw new Error(`mint returned an untracked url for ${s.product.asin}: ${url}`);
    minted.push({ ...s, url, subid1 });
    console.log(`  ✓ minted ${s.product.asin} → ${url}`);
  }

  const next = [...tweets];
  for (const m of minted) next[m.idx] = next[m.idx].replace(PLACEHOLDER_RE, m.url);
  const stillHoles = placeholderSlots(next);
  if (stillHoles.length) throw new Error(`substitution missed tweet ${stillHoles.map((i) => i + 1).join(', ')} — refusing to patch a draft that still has holes`);

  await tf.patchDraft(acc.socialSetId, draftId, {
    platforms: { ...draft.platforms, x: { ...draft.platforms.x, posts: posts.map((p, i) => ({ ...p, text: next[i] })) } },
    tags: retag(draft.tags, TAG_DONE),
    scratchpad_text: `${draft.scratchpad_text || ''}\n\nAUTOMINT ${new Date().toISOString()}\n${minted.map((m) => `  T${m.idx + 1}  ${m.product.asin}  ${m.subid1}  (substance found in T${m.foundIn}; ${jevLine(m.jev)})`).join('\n')}`.trim(),
  });
  console.log(`\n✓ ${minted.length} link(s) in, tagged ${TAG_DONE}`);
  return { status: 'minted', minted };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'LEVANTA_API_KEY']);
  const acc = getAccount(flag('account', ''));
  const draftId = args.find((a) => /^\d{6,}$/.test(a));
  if (!draftId) throw new Error('usage: node automint.mjs <draftId> --account <key> [--dry] [--force]');
  const r = await automintDraft(env, acc, draftId, { dry: args.includes('--dry'), force: args.includes('--force') });
  if (r?.status === 'declined' || r?.status === 'claimed') process.exitCode = 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) await runMain(main, 'automint');
