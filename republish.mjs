// republish.mjs — evergreen repost: duplicate one of our OWN past winners (an existing
// published/scheduled Typefully draft) into a NEW scheduled draft. Media carries over via the
// original's media_ids (same social set). Marks the source registry row Reposted (+count).
//   node republish.mjs <originalDraftId> --account <key> --at <ISO> --create
//   node republish.mjs <originalDraftId> --account <key>            # dry preview (no mint, no create)
//   node republish.mjs <id> --account <key> --swap-asin B0CDFDDRCF=B0DXR7MPNV   # retarget a plug
//   node republish.mjs <id> --account <key> --plug-file B0CDFDDRCF=plug.txt    # hand-written plug for a swapped slot
//
// ATTRIBUTION (2026-08-08): the old version re-published AS-IS, reusing the SOURCE's Levanta link.
// registry-sync keys revenue by minted link id (lv_XXX) -> draftId from the ledger, so the repost's
// clicks/sales were credited to the SOURCE row (or dropped) and the repost showed $0 on the dashboard
// even when it earned. Now we MINT A FRESH link per plug (new subid1), swap the URLs in the copied
// posts, and write a COMPLETE ledger line (link/link2/subid1/asin/product) — so registry-sync
// attributes this repost's revenue to its OWN row. If the source has no ledger entry (can't find the
// products), we fall back to an as-is republish and say so — never crash a repost over attribution.
import { buildPlatforms } from './platforms.mjs';
import { crossPostLinks, crossPostLedgerRows } from './cross-post-links.mjs';
import { loadEnv, requireEnv, airtable, typefully, levanta, HERE_DIR, lvIdOf, loadLedger } from './lib.mjs';
import { linkGate, scheduledLinks } from './link-sentinel.mjs';
import { resolvePlugLinks, buildLedgerIndex, loadLevantaCatalog, resolutionLine } from './link-resolve.mjs';
import { LAWS } from './laws.mjs';
import { farmStampRow } from './harvest-gate.mjs';
import { getAccount } from './accounts.mjs';
import { loadRepair } from './harvest-repair.mjs';
import { joinNumberedHeadings } from './content/text-shape.mjs';
import { harvestRecord, attemptsOf } from './harvest-record.mjs';
import { renderScratchpad, writeRecord } from './thread-record.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { provenLoser, candidates } from './pick-product.mjs'; // dead-product swap on repost (operator 2026-08-11)
import { writePlugs } from './prompts.mjs';
import { plugTextLen, PLUG_LIMIT, validateDraft, isTrackedLink, leadingNumbers, DENY_ASINS } from './checks.mjs';
import { deepRepostRepairs } from './repost-repair.mjs';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withProcessResult } from './process-result.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const CREATE = args.includes('--create');
// --no-cross: ship this repost to X ONLY, skipping the account's cross-post platforms. For a page
// whose Threads connection is failing, the cross-post half is not neutral — it errors, Typefully
// marks the WHOLE draft `error`, and a Threads link is minted and ledgered for a post nobody will
// ever see. The X thread itself is unaffected either way, and since 2026-09-16 the RT bridge keys
// on the X url rather than the draft status, so the T0 ping fires regardless.
const NO_CROSS = args.includes('--no-cross');
// --allow-unsold "blood flow,nitric oxide": substances the thread ARGUES but deliberately does not
// sell, same field publish-thread takes on a spec. A repost had no way to say this, so a winner
// whose prose mentions a routed symptom word in passing was refused outright with no path forward
// (Marcos 10382059: "blood flow" appears as an omega-3 benefit and inside a sitting-is-bad item,
// neither of them a beet-root argument, yet the beet route fired and blocked the repost). This does
// not weaken the gate — an undeclared unsold substance still fails. It records the operator's call.
const ALLOW_UNSOLD = String(flag('allow-unsold', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const origId = args.find((a) => /^\d{6,}$/.test(a));
const ACCOUNT = getAccount(flag('account', 'julian'));
// --harvest <recXXXX>: this repost is a farm ATTEMPT — a heart spent on the named Harvests row.
// The new PC row is stamped at creation (Harvest link + Attempt Verdict 'Pending' + optional
// --batch), so the gate's 48h clock starts from a linked row instead of waiting for the ledger
// backfill. The stamp is an upsert on Draft ID: registry-sync's own upsert then enriches the row.
const HARVEST_REC = flag('harvest');
const BATCH = flag('batch');
// --from <key>: the account that OWNS the original draft, for a cross-account repost out of the
// fleet-wide harvest pool (operator 2026-08-27: "the harvest pool is spread across all accounts,
// not limited"). Omitted = same-account, exactly as before. Links are minted with the TARGET's
// subid prefix and the gates run against the TARGET account, so revenue and voice both land where
// the repost actually posts; only the fetch and the boilerplate pop-set know about the source.
const SOURCE = flag('from') ? getAccount(flag('from')) : ACCOUNT;

const slugify = (s) => String(s).toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// The substances this lane can recognise in a title or a tweet. Hoisted to module scope so the
// automatic dead-product swap and the operator's --swap-asin override apply the SAME test: a
// replacement is only honest if its substance is one the thread already argued.
export const substanceOf = (t = '') => (String(t).toLowerCase().match(/magnesium|ashwagandha|creatine|collagen|omega|fish oil|berberine|probiotic|beet|zinc|turmeric|curcumin|nad|b12|glucosamine|coq10|ubiquinol|theanine|vitamin d|vitamin c|iron|melatonin|nitric oxide|citrulline|arginine|electrolyte/g) || []);

// Distinctive words the OLD product's title carries and the new one does not — brand names, trade
// marks, proprietary forms. If one of those still sits in the plug copy after a swap, the tweet is
// selling a name the link no longer points at. This shipped once: Clara's plug read "Heart of Steel"
// over a D3+K2 link, caught by the operator 45 minutes before post time, because the LLM copy
// rewrite is the only thing that repairs the wording and it is unavailable whenever OPENROUTER_API_KEY
// is not set (which is always, in the sandbox). Deterministic backstop, no API needed.
// Stop-words keep generic supplement vocabulary out: those are the words the copy SHOULD share.
const TITLE_STOP = new Set(['with', 'plus', 'from', 'high', 'pure', 'each', 'daily', 'count', 'capsules', 'softgels', 'tablets', 'powder', 'serving', 'servings', 'supplement', 'supplements', 'extract', 'complex', 'strength', 'gummies', 'organic', 'natural', 'vegan', 'free', 'non', 'gmo', 'made', 'mens', 'womens', 'adults', 'formula', 'blend', 'grade', 'micro', 'ultra', 'triple', 'double', 'advanced', 'premium', 'support', 'health', 'research', 'sports', 'monohydrate', 'unflavored', 'flavored']);
export function brandLeak(plugText, oldTitle, newTitle) {
  const words = (t) => new Set(String(t).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []);
  const nw = words(newTitle);
  const hay = String(plugText).toLowerCase();
  for (const w of words(oldTitle)) {
    if (nw.has(w) || TITLE_STOP.has(w)) continue;
    if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)) return w;
  }
  return '';
}

// --swap-asin <from>=<to>, repeatable: retarget one plug's product by hand. The automatic swap only
// fires on a product that is DELISTED or a PROVEN LOSER, which leaves the case that actually costs
// us money — a live, profitable listing that is simply not the one routing now sends volume to.
// Rafael's creatine winner (1,413 clicks, $462) was unrepostable for exactly this reason: the gate
// demands the routed B0DXR7MPNV, the source ledger holds B0CDFDDRCF, and nothing could bridge them.
// This does NOT loosen the substance law — the target still has to answer what the slot argued, and
// applySwapOverrides refuses the swap outright when it does not.
const SWAP_ASIN = args.reduce((acc, a, i) => {
  if (a !== '--swap-asin') return acc;
  const [from, to] = String(args[i + 1] || '').split('=').map((x) => (x || '').trim().toUpperCase());
  if (from && to) acc.push({ from, to });
  else console.log(`  ⚠️ ignoring malformed --swap-asin "${args[i + 1]}" — expected <fromAsin>=<toAsin>`);
  return acc;
}, []);

// A SWAPPED PLUG'S COPY IS WRITTEN IN CHAT, NOT THROUGH THE API (owner, 2026-09-26: "We are using
// the Chat to generate the threads — NEVER the Claude API key"). Both swaps above leave a plug tweet
// whose words still describe the old product, and the only repair this file had was writePlugs, an
// LLM call. A swapped plug now needs one of:
//   --plug-file <fromAsin>=<file>  the operator's hand-written plug for that slot, repeatable. The
//                                   file is the whole plug tweet, with {{LINK}} where the fresh
//                                   tracked link goes (recreate's --tweets-file convention).
//   --allow-llm-plugs               the explicit opt-in to the old LLM rewrite, on a --create only.
// With neither, --create refuses before anything is minted, and the preview and --gate-only report
// "needs an LLM plug rewrite" without ever calling it.
const ALLOW_LLM_PLUGS = args.includes('--allow-llm-plugs');
const PLUG_FILES = args.reduce((acc, a, i) => {
  if (a !== '--plug-file') return acc;
  const s = String(args[i + 1] || ''), eq = s.indexOf('=');
  const asin = s.slice(0, Math.max(eq, 0)).trim().toUpperCase(), file = s.slice(eq + 1).trim();
  if (eq > 0 && asin && file) acc.push({ asin, file });
  else console.log(`  ⚠️ ignoring malformed --plug-file "${args[i + 1]}" — expected <fromAsin>=<file>`);
  return acc;
}, []);

/** Who writes each swapped plug's copy. A swap is `{ from: { asin }, to, why }`; `handPlugs` maps a
 *  from-ASIN to the operator's hand-written plug. `hand` ships that text, `llm` goes to writePlugs,
 *  `blocked` refuses. Nothing lands in `llm` unless `allowLlm` is set. Pure. */
export function plugRewritePlan(swaps = [], { handPlugs = new Map(), allowLlm = false } = {}) {
  const plan = { hand: [], llm: [], blocked: [] };
  for (const s of swaps) plan[handPlugs.has(s.from?.asin) ? 'hand' : allowLlm ? 'llm' : 'blocked'].push(s);
  return plan;
}

/** Why a hand-written plug cannot ship, or '' when it can. Read before anything is minted, so a
 *  bad file never strands a link. */
export function handPlugIssue(text = '') {
  const t = String(text).trim();
  if (!t.includes('{{LINK}}')) return 'no {{LINK}} in it, so the fresh tracked link has nowhere to go';
  const n = plugTextLen(t.replaceAll('{{LINK}}', 'https://lvnta.com/lv_x'));
  return n > PLUG_LIMIT ? `${n} characters without the link, over the ${PLUG_LIMIT} plug limit` : '';
}

/** The refusal for swapped plugs nobody has written copy for: one "· " line per plug (the line
 *  pool-probe and harvest-repair read as the reason), then the fix. */
export function plugRewriteRefusal(unwritten = [], { probe = false } = {}) {
  const name = (p) => (p ? ` (${String(p).slice(0, 28)})` : '');
  return [
    ...unwritten.map((s) => `  · needs an LLM plug rewrite: ${s.from.asin}${name(s.from.product)} -> ${s.to.asin}${name(s.to.title)}, ${s.why}. The plug copy still sells ${s.from.asin}.`),
    `Threads are written by hand in chat, never through the API${probe ? ', and a --gate-only probe never calls it' : ''}.`,
    `Fix: hand-write ${unwritten.length > 1 ? 'each plug' : 'the plug'} for the new product and pass ${unwritten.map((s) => `--plug-file ${s.from.asin}=<file>`).join(' ')} ({{LINK}} marks the fresh link), or pick another body.`,
  ];
}

/** Puts a swapped plug's new copy at posts[idx], by the route plugRewritePlan gave it, and returns
 *  the line to print. `write` is writePlugs unless a test injects a double, and it runs only for a
 *  swap in `plan.llm`. */
export async function rewriteSwappedPlug({ sw, plan, handPlugs = new Map(), posts, idx, link, product, env, account, write = writePlugs }) {
  if (plan.hand.includes(sw)) {
    posts[idx].text = handPlugs.get(sw.from.asin).replaceAll('{{LINK}}', link);
    return `    ↳ hand-written plug in place for ${sw.to.asin}`;
  }
  if (!plan.llm.includes(sw)) return `    ⚠️ no new plug copy for ${sw.to.asin} — link swapped, copy kept`;
  try {
    const w = await write(env, account, { title: product, link }, { title: product, link }, false, posts[idx - 1]?.text || '', posts[idx - 1]?.text || '', account.plugStyle || 'classic', { thread: posts.map((x) => x.text) });
    const fresh = w?.heavy;
    if (fresh && fresh.includes(link) && plugTextLen(fresh) <= PLUG_LIMIT) { posts[idx].text = fresh; return `    ↳ plug copy rewritten by the LLM for ${sw.to.asin} (--allow-llm-plugs)`; }
    return '    ⚠️ plug rewrite rejected (length/link) — link swapped, copy kept';
  } catch (e) { return `    ⚠️ plug rewrite failed (${String(e.message).slice(0, 40)}) — link swapped, copy kept`; }
}

/** The 24h body cooldown on POST times, not append times (2026-09-01 review finding: two attempts
 *  CREATED 25h apart can still be SCHEDULED into the same evening, and the law — laws.json
 *  farm.$cooldownHours, "one body never posts twice fleet-wide inside the window" — is about when
 *  readers see it). Each prior run's time is its recorded publishAt when the ledger has one
 *  (attempt rows carry it since this fix), else its append ts (the only clock older rows have).
 *  Pure; returns the violating prior run or null. */
export function cooldownViolation(ledgerRows, origId, newAtMs, cooldownMs) {
  for (const e of ledgerRows || []) {
    if (!e || String(e.sourceDraftId) !== String(origId)) continue;
    const t = Date.parse(e.publishAt || e.ts || '');
    if (!Number.isFinite(t)) continue;
    if (Math.abs(newAtMs - t) < cooldownMs) return { at: t, account: e.account || '?' };
  }
  return null;
}

// The source draft's most recent ledger entry — carries the plug products (asin/link/product) that
// recreate.mjs recorded when it was first minted, which is what we need to re-mint fresh links.
/** The source draft's PRIMARY ledger row — the one carrying its products, so a repost can re-mint
 *  a fresh link per plug instead of reusing the source's.
 *
 *  SATELLITES ARE NOT THE ROW (fixed 2026-09-16). This was last-write-wins over every row sharing the
 *  draft id, and since cross-posting started writing `attributionOnly` rows the last row is ALWAYS a
 *  satellite: it carries the platform's own link (…-th) and an empty `product`, and no link2. So the
 *  old→product map got one entry keyed on a Threads link that never appears in an X post, `remintable`
 *  came back 0, and every repost of a cross-posted thread silently took the as-is path — reusing the
 *  source's links and crediting this repost's clicks and sales to the SOURCE row. That is exactly the
 *  attribution bug this file's header says was fixed on 2026-08-08, re-opened from the side.
 *  `attributionOnly` is the fleet's existing word for a satellite (lib's parseLedger reads it the same
 *  way); honouring it here restores last-wins over real rows. */
export function sourceLedger(id, text = null) {
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (text == null && !existsSync(f)) return null;
  let found = null;
  for (const line of (text != null ? text : readFileSync(f, 'utf8')).split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (String(e.draftId) === String(id) && !e.attributionOnly) found = e; } catch {}
  }
  return found;
}

async function markReposted(env) {
  // Flip the source registry row (matched by Draft ID = original) to Reposted + bump count.
  if (!env.REGISTRY_BASE_ID) return;
  const base = env.REGISTRY_BASE_ID, T = encodeURIComponent(REGISTRY_TABLE), h = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
  // A FAILED READ IS NOT "NOTHING TO DO" (2026-08-30). Both calls were bare fetches whose failure
  // returned silently, so a transient 429 left the source row still reading Status=Winner with a
  // Repost Count that never incremented — the registry then disagrees with reality about a post that
  // definitely was reposted, and the repost-age rule reads off the wrong number afterwards. The read
  // now retries and throws; a genuinely absent row is still a legitimate no-op.
  const found = await airtable(env, base).list(REGISTRY_TABLE, { formula: `{Draft ID}="${origId}"`, pageSize: 1 });
  const rec = found[0];
  if (!rec) return;
  const r = await fetch(`https://api.airtable.com/v0/${base}/${T}/${rec.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ typecast: true, fields: { Status: 'Reposted', 'Repost Count': (rec.fields['Repost Count'] || 0) + 1 } }) });
  if (!r.ok) throw new Error(`mark-reposted PATCH -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
}


// A repaired body keeps every sentence but may reorder them, so media follows its OWN TWEET rather
// than its old slot — matched by exact text against the original posts. A beat the repair rewrote
// (a mechanical fix) simply carries no media, which is the safe direction: a mismatched image is
// worse than none.
function mediaForText(origPosts, text) {
  return (origPosts.find((p) => p.text === text) || {}).media_ids || [];
}

// CROSS-SET MEDIA TRANSFER (2026-08-27). A cross-account repost copies the source's media_ids,
// and Typefully 404s the whole create for ids that live in another set — AFTER the mints, so the
// failure stranded fresh links and, worse, died silently under a grep (tina's repost was reported
// shipped when it never existed). The source's media is recoverable through getMediaStatus
// (media_urls.original), so re-host each file into the TARGET set and remap the ids. A file that
// fails to transfer is dropped from its tweet rather than failing the repost — a missing image is
// recoverable, a 404'd create is not. A same-set repost keeps its ids as they are.
export async function transferMedia({ tf, posts, source, target, gateOnly = false }) {
  if (source === target) return;
  const mediaIds = [...new Set(posts.flatMap((p) => p.media_ids || []))];
  if (!mediaIds.length) return;
  // GATE-ONLY NEVER UPLOADS (2026-09-23). This transfer ran before both gate-only returns, so every
  // cross-account probe (--from, the attempt skill's step 1b) re-hosted the source's files into the
  // TARGET set, and 2026-09-23 alone left about 21 orphan uploads that no draft will ever carry. A
  // probe now reports what WOULD move and touches nothing, not even a read. Media ids never reach the
  // gates, so the verdict is unchanged. The ids stay the source set's: only a create could trip over
  // them, and a gate-only run never creates.
  if (gateOnly) {
    console.log(`  ↳ gate-only: ${mediaIds.length} media file(s) would transfer from ${source.name}'s set (${source.socialSetId}) — nothing fetched, nothing uploaded`);
    posts.forEach((p, i) => { if (p.media_ids?.length) console.log(`     · T${i + 1}: ${p.media_ids.length} media id(s) in set ${source.socialSetId}`); });
    return;
  }
  console.log(`  ↳ transferring ${mediaIds.length} media file(s) from ${source.name}'s set`);
  const idMap = new Map();
  for (const mid of mediaIds) {
    try {
      const st = await tf.getMediaStatus(source.socialSetId, mid);
      const u = st.media_urls?.original || st.media_urls?.large || st.media_urls?.medium || st.media_urls?.small;
      if (!u) throw new Error('no media url');
      const res = await fetch(u);
      if (!res.ok) throw new Error(`fetch -> ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const newId = await tf.uploadMedia(target.socialSetId, st.file_name || `${mid}.jpg`, bytes);
      idMap.set(mid, newId);
    } catch (e) { console.log(`    ⚠️ media ${mid.slice(0, 8)}… not transferred (${String(e.message).slice(0, 40)}) — dropped`); }
  }
  for (const p of posts) p.media_ids = (p.media_ids || []).map((m) => idMap.get(m)).filter(Boolean);
}

async function main(resultChannel = null) {
  if (!origId) throw new Error('Pass the original draft id to republish');
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'TYPEFULLY_API_KEY']);
  const tf = typefully(env);

  const orig = await tf.getDraft(SOURCE.socialSetId, origId);
  const posts = (orig.platforms?.x?.posts || []).map((p) => ({ text: p.text, media_ids: p.media_ids || [] }));
  if (!posts.length) throw new Error(`Original draft ${origId} has no X posts`);

  // A REPAIRED BODY, when one exists for this Harvests row (harvest-repair.mjs). The pool holds
  // bodies written under older CTA rules that today's gates refuse outright — five of the nine
  // refusals measured 2026-09-04 were ask geometry alone, on bodies that earned real money. A
  // repair file carries the same sentences with a legal ask position; it never adds copy, and it
  // was re-gated before it was written. Media rides by POSITION here, not by text, because a
  // geometry repair reorders the beats.
  const harvestRec = flag('harvest');
  const repair = harvestRec ? loadRepair(harvestRec) : null;
  if (repair) {
    const orig0 = posts.map((p) => ({ text: p.text, media_ids: p.media_ids }));
    posts.length = 0;
    // Cached repairs can predate the sentence splitter's numeric-marker fix.
    // Normalize whitespace in memory before the publication gates, retaining cached history.
    posts.push(...repair.tweets.map((originalText) => ({
      text: joinNumberedHeadings(originalText),
      media_ids: mediaForText(orig0, originalText),
    })));
    console.log(`  ⟳ REPAIRED BODY in use (${repair.repairedAt.slice(0, 10)})${repair.geometryChanged ? ' — ASK GEOMETRY CHANGED' : ''}`);
    // `moves` carries BOTH shapes: a geometry move {from,to,direction} and a mechanical note
    // {move,at}. Assuming the first shape here crashed on every mechanically-repaired body.
    for (const m of repair.moves || []) {
      if (m.from && m.to) console.log(`     · ask moved T${m.from.join('+T')} -> T${m.to.join('+T')} (${m.direction})`);
      else if (m.move) console.log(`     · ${m.move} @T${m.at}`);
    }
    console.log('     the verdict this earns belongs to the REPAIRED body, not the original geometry.');
  }
  const at = flag('at');

  // THE 24h BODY COOLDOWN (laws.json farm.cooldownHours — the farm's ONLY spacing rule): one body
  // never POSTS twice fleet-wide inside the window, on any account. Judged on this attempt's
  // intended publish time (--at, else now) against each prior run's recorded publishAt (else its
  // append ts) — creation spacing is not the law, reader spacing is. Enforced here because this is
  // the choke point every verbatim repost passes through. --force-cooldown = the operator's "I know".
  {
    const lf = join(HERE_DIR, 'ledger.jsonl');
    const rows = !existsSync(lf) ? [] : readFileSync(lf, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const newAt = flag('at') && Number.isFinite(Date.parse(flag('at'))) ? Date.parse(flag('at')) : Date.now();
    const hit = cooldownViolation(rows, origId, newAt, LAWS.farm.cooldownHours * 3600e3);
    if (hit && !args.includes('--force-cooldown')) {
      const msg = `body ${origId} ${hit.at > Date.now() ? 'is already scheduled' : 'already posted'} ${Math.abs((newAt - hit.at) / 3600e3).toFixed(1)}h from this attempt's slot, on ${hit.account} — the ${LAWS.farm.cooldownHours}h fleet-wide cooldown holds`;
      if (CREATE) { console.error(`✗ COOLDOWN: ${msg}. Pass --force-cooldown only if the operator says so.`); process.exitCode = 1; return; }
      console.log(`  ⚠️ cooldown: ${msg} (a --create would refuse)`);
    }
  }

  // Map each plug link present in the posts (by lv_ id) to its ASIN.
  const src = sourceLedger(origId);
  // URL-first extraction: a raw lv_ text scan swallowed the campaign+creative ids on direct-rail
  // threads (3 ids per link), inflating `present` and forcing `attributed` false on clean reposts.
  const present = [...new Set(posts.flatMap((p) => [...String(p.text).matchAll(/https?:\/\/\S+/g)].map((m) => lvIdOf(m[0]))).filter(Boolean))]; // plug link ids in the copied text
  // THE SOURCE ROW IS NOT THE ONLY WITNESS (2026-09-17). This used to read `link`/`link2` off the
  // source ledger row and nothing else — two slots, so a thread with three or more plugs could not
  // describe itself and reported `re-mintable: 2/3`. pool-probe then marked it unrunnable, because
  // a verdict measured through a link we did not re-mint is unreadable. Eight of the pool's bodies
  // sat there, including its three densest, holding hearts that could never be spent. Every one of
  // them simply had more plugs than the schema had slots. The resolver widens the search to any
  // ledger row that minted the same link and then to Levanta's own catalog, which knows the ASIN
  // behind 231 links the ledger never recorded.
  const resolution = resolvePlugLinks(present, { own: src, ledger: buildLedgerIndex(loadLedger().byDraft), levanta: loadLevantaCatalog() });
  const oldToProd = new Map(resolution.links.filter((l) => l.asin).map((l) => [l.id, { asin: l.asin, product: l.product }])); // old lv_id -> { asin, product }
  const remintable = present.filter((id) => oldToProd.has(id));

  console.log(`Evergreen repost of ${origId}: ${posts.length} tweets${at ? ` @ ${at}` : ''}`);
  console.log(`  plug links in source: ${present.length ? present.join(', ') : '(none)'} | re-mintable: ${resolutionLine(resolution)}` + (src ? '' : ' (no source ledger entry — will repost as-is)'));

  // DEAD-PRODUCT SWAP detection runs BEFORE the preview return so `--dry` shows pending swaps too.
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const threadText = posts.map((p) => p.text).join('\n').slice(0, 1400);
  const hookLine = (posts[0]?.text || '').split('\n')[0];
  const swaps = [];
  // DELISTED counts as dead, not just PROVEN LOSER (2026-08-27). The swap used to fire on
  // provenLoser alone, which silently missed the worse case: a product that was retired from the
  // catalogue while its board row still reads as a winner. B0DK61GRD2 (Formulation Factory nitric
  // oxide) sits at EPC $0.506 on 942 clicks and 404s at Levanta on every mint — provenLoser says
  // false, so the swap skipped it and the repost died at mint time with the copy already built.
  // Four proven winners were stranded on the bench this way (Clara 795 clicks, Marcos 227, Jasper
  // 214, Tina 103). Absence from products.json is the catalogue's own retirement signal, and it is
  // the check that catches a delisting the day it happens rather than after the EPC decays.
  const inCatalogue = new Set(products.map((p) => p.asin));
  const byAsin = new Map(products.map((p) => [p.asin, p]));

  // OPERATOR OVERRIDES FIRST. --swap-asin is a deliberate instruction, so it wins over the automatic
  // rules and the automatic loop then leaves that slot alone. Two things it may NOT override, because
  // both would ship a thread that lies to the reader:
  //   * a DENY-listed target — the kill list is the one verdict a repost cannot reopen;
  //   * a target whose substance the thread never argued — this is the nitric-oxide substitution the
  //     unsoldSubstance law exists to stop ("Restore nitric oxide" shipped selling magnesium), and an
  //     explicit flag is exactly how it would come back. Swap the LISTING, never the SUBSTANCE.
  const overridden = new Set();
  for (const { from, to } of SWAP_ASIN) {
    const hit = [...oldToProd].find(([, prod]) => prod.asin === from);
    if (!hit) {
      console.log(`  ⚠️ --swap-asin ${from}=${to}: this thread has no plug on ${from} (source plugs: ${[...oldToProd.values()].map((x) => x.asin).join(', ') || 'none'}) — ignored`);
      continue;
    }
    const [oldId, prod] = hit;
    const target = byAsin.get(to);
    if (!target) { console.log(`  ✗ --swap-asin ${from}=${to}: ${to} is not in products.json — refusing`); continue; }
    if (DENY_ASINS.has(to)) { console.log(`  ✗ --swap-asin ${from}=${to}: ${to} is on the DENY list — refusing`); continue; }
    const plugIdx = posts.findIndex((pp) => [...String(pp.text).matchAll(/https?:\/\/\S+/g)].some((m) => lvIdOf(m[0]) === oldId));
    const slotHay = (plugIdx > -1 ? `${posts[plugIdx - 1]?.text || ''}\n${posts[plugIdx].text}` : '').toLowerCase();
    const hay = threadText.toLowerCase();
    const subs = substanceOf(target.title);
    const argued = subs.some((sub) => slotHay.includes(sub)) || subs.some((sub) => hay.includes(sub));
    if (subs.length && !argued) {
      console.log(`  ✗ --swap-asin ${from}=${to}: this thread never argues ${subs[0]} — the reader was walked to ${substanceOf(prod.product)[0] || from} and would be handed something else. Refusing.`);
      continue;
    }
    swaps.push({ oldId, from: prod, to: target, manual: true, why: 'retargeted by --swap-asin' });
    oldToProd.set(oldId, { asin: target.asin, product: target.title, swappedFrom: prod.asin });
    overridden.add(oldId);
    console.log(`  ↻ --swap-asin (operator): ${from} (${(prod.product || '').slice(0, 28)}) -> ${to} (${target.title.slice(0, 28)})`);
  }

  for (const [oldId, prod] of oldToProd) {
    if (overridden.has(oldId)) continue;
    const delisted = !inCatalogue.has(prod.asin);
    if (!delisted && !provenLoser({ asin: prod.asin })) continue;
    const why = delisted ? 'retired from the catalogue' : 'a proven loser';
    const cands = candidates(hookLine, products, { bodyText: threadText })
      .filter((c) => c.asin !== prod.asin && !provenLoser(c) && inCatalogue.has(c.asin));
    // NATIVE FIT over rank (the collagen-on-a-NAD-thread lesson): candidates() is ordered by VALUE,
    // not by fit, so taking [0] would swap a magnesium thread onto whatever earns most. Prefer the
    // highest-ranked candidate whose own substance actually appears in this thread's text; only fall
    // back to rank when nothing matches. Deterministic — no LLM call, so reposts stay cheap.
    // SCOPE THE FIT TO THE SLOT, NOT THE THREAD (2026-08-27). This used to test the candidate's
    // substance against the whole thread, so on a multi-substance listicle any product whose
    // substance appeared ANYWHERE scored as a native fit. Marcos 10382059 sells omega-3 at one plug
    // and nitric oxide at another; swapping the dead nitric-oxide bottle matched "omega" from the
    // OTHER plug and handed this slot a second omega-3. That is the nitric-oxide substitution the
    // whole unsoldSubstance rule exists to stop, arrived at by a different road. The slot's own copy
    // plus its bridge is what the reader was walked through, so that is what the replacement has to
    // answer; the thread stays as the fallback when the slot names nothing.
    const plugIdx = posts.findIndex((pp) => [...String(pp.text).matchAll(/https?:\/\/\S+/g)].some((m) => lvIdOf(m[0]) === oldId));
    const slotText = plugIdx > -1 ? `${posts[plugIdx - 1]?.text || ''}\n${posts[plugIdx].text}` : '';
    const slotHay = slotText.toLowerCase();
    // AND SCOPE IT TO THE PLUG BEFORE THE SLOT (2026-09-18). The slot is the plug PLUS its bridge,
    // and on a chained thread the bridge is where the WELD lives — the sentence whose entire job is
    // to name the PREVIOUS product ("Vitamin D cannot be switched on without magnesium"). So the
    // bridge legitimately mentions a substance this slot does not sell, and because `cands` is
    // ordered by VALUE the find below takes the richest match rather than the right one.
    //
    // Measured: reposting Julian's 09-09 vitamin D thread onto Lucas, the retired magnesium bottle
    // (B08VW9496D) was swapped for a SECOND vitamin D3+K2 — the thread's own plug 1 — off the word
    // "Vitamin D" in the magnesium bridge. The LLM copy rewrite was then rejected on length, so the
    // plug shipped reading "This is my magnesium" over a vitamin D listing. The plug tweet is the
    // one that says what it sells; the bridge says why it follows. Ask the plug first.
    const plugHay = plugIdx > -1 ? String(posts[plugIdx].text).toLowerCase() : '';
    const hay = threadText.toLowerCase();
    // The nitric-oxide vocabulary was missing here, which made the whole lane invisible to native
    // fit: a thread whose plug copy reads "the ones pairing L-citrulline with L-arginine" matched
    // nothing, so the swap fell through to cands[0] and handed an omega-3 to a nitric-oxide plug —
    // on a thread that already sold omega-3 elsewhere. Same substance in, same substance out.
    const fits = (h) => cands.find((c) => substanceOf(c.title).some((sub) => h.includes(sub)));
    const replacement = fits(plugHay) || fits(slotHay) || fits(hay) || cands[0];
    if (!replacement) { console.log(`  ⚠️ ${prod.asin} is ${why} but no better topical fit exists — keeping it`); continue; }
    swaps.push({ oldId, from: prod, to: replacement, why });
    oldToProd.set(oldId, { asin: replacement.asin, product: replacement.title, swappedFrom: prod.asin });
    console.log(`  ↻ dead-product swap (${why}): ${prod.asin} (${(prod.product || '').slice(0, 28)}) -> ${replacement.asin} (${replacement.title.slice(0, 28)})`);
  }

  // Who writes each swapped plug's copy (see ALLOW_LLM_PLUGS at the top). Read before the preview
  // returns, so the preview names every plug that still needs one.
  const handPlugs = new Map();
  for (const { asin, file } of PLUG_FILES) {
    let text = '';
    try { text = readFileSync(file, 'utf8').trim(); } catch (e) { console.error(`✗ --plug-file ${asin}=${file}: ${e.message}`); process.exitCode = 1; return; }
    const bad = handPlugIssue(text);
    if (bad) { console.error(`✗ --plug-file ${asin}=${file}: ${bad}`); process.exitCode = 1; return; }
    if (!swaps.some((s) => s.from.asin === asin)) console.log(`  ⚠️ --plug-file ${asin}: no swapped plug sells ${asin} — ignored`);
    handPlugs.set(asin, text);
  }
  const plan = plugRewritePlan(swaps, { handPlugs, allowLlm: ALLOW_LLM_PLUGS });
  for (const s of plan.hand) console.log(`  ✎ hand-written plug for ${s.from.asin} -> ${s.to.asin}`);

  if (!CREATE && !args.includes('--gate-only')) {
    const hook = hookLine;
    remintable.forEach((id) => console.log(`  would re-mint: ${id} -> asin ${oldToProd.get(id).asin} (subid1 ${ACCOUNT.levantaSubidPrefix}-${slugify(hook)}-${String(origId).slice(-6)}-rXXXX)`));
    for (const s of plan.llm) console.log(`  ↳ needs an LLM plug rewrite: ${s.from.asin} -> ${s.to.asin}. Not called in a preview; --create --allow-llm-plugs would call it.`);
    if (plan.blocked.length) for (const l of plugRewriteRefusal(plan.blocked)) console.log(`  ${l.trim()}`);
    if (plan.blocked.length) console.log('  (a --create refuses until every swapped plug has copy)');
    if (present.length && !remintable.length) console.log('  ⚠️ has plug links but no source ledger products — as-is republish would leave revenue attributed to the source.');
    console.log('(no --create — preview only)');
    return;
  }

  // Mint a FRESH link per plug and swap it into the copied posts, so this repost is attributable.
  //
  // --gate-only: run the WHOLE pipeline — swap, repairs, gates — on probe links, minting nothing
  // and creating nothing. This lane mints BEFORE it gates, so every refusal used to strand real
  // Levanta links on no thread (three strays existed before this flag, plus four more from one
  // evening's refusals). Preview the verdict here first; mint only when it says clean.
  const GATE_ONLY = args.includes('--gate-only');
  // A swapped plug with no copy refuses HERE, before the first mint, so a refusal strands no link.
  // A probe refuses on an LLM-bound plug too: it never calls the LLM, so the copy a create would
  // ship does not exist yet and no gate can pass it.
  const unwritten = GATE_ONLY ? [...plan.llm, ...plan.blocked] : plan.blocked;
  if (unwritten.length) {
    console.error(`REFUSED: repost of ${origId} has ${unwritten.length} swapped plug(s) with no copy — nothing minted, nothing created.`);
    for (const l of plugRewriteRefusal(unwritten, { probe: GATE_ONLY })) console.error(l);
    process.exitCode = 1;
    return;
  }
  const lev = levanta(env);
  const hook = (posts[0]?.text || '').split('\n')[0];
  const nonce = Math.random().toString(36).slice(2, 6);
  const minted = []; const notes = [];
  // (DEAD-PRODUCT SWAP was detected above, before the --dry preview return: a thread can still be a
  // proven EARNER while the product it plugged has since decayed into a proven loser. Reposting
  // as-is would send traffic to a product the FRESH path refuses to plug — the repost lane was the
  // one route bypassing every product guardrail. Operator ruling 2026-08-11: keep the content, swap
  // the plug. Only DEAD plugs are touched; healthy ones stay byte-identical. A mint failure falls
  // back to the original product; a swapped plug with no copy refused above, before any mint.)
  for (let i = 0; i < remintable.length; i++) {
    const oldId = remintable[i], { asin, product } = oldToProd.get(oldId);
    const subid1 = `${ACCOUNT.levantaSubidPrefix}-${slugify(hook)}-${String(origId).slice(-6)}-r${nonce}${i ? `-${i}` : ''}`;
    try {
      const m = GATE_ONLY
        ? { url: `https://lvnta.com/lv_gateprobe${String(i + 1).padStart(2, '0')}` }
        : await lev.mintLink(asin, subid1, ACCOUNT.levantaSubidPrefix);
      // Honour the account's direct-link A/B (2026-08-13 fix): this path minted the lvnta redirect
      // UNCONDITIONALLY, so Magnus — whose output is mostly reposts — never actually entered the
      // test. Attribution is identical either way (aa_adgroupid = link id on both).
      const link = ACCOUNT.directLink
        ? (m.url || m.mobileOptimizedUrl || m.mobile_optimized_url)
        : (m.mobileOptimizedUrl || m.mobile_optimized_url || m.url);
      if (!link) throw new Error('mint returned no url');
      for (const p of posts) p.text = p.text.replace(new RegExp(`https?:\\/\\/[^\\s]*${oldId}[^\\s]*`, 'g'), link);
      // A swapped plug still NAMES the old product in its copy — replace that plug tweet so the words
      // match the new product: the operator's hand-written plug, or the LLM under --allow-llm-plugs.
      // An LLM rewrite is validated before it is accepted; on any failure the link swap stands and
      // the copy is left alone rather than shipping a broken plug.
      const sw = swaps.find((s) => s.oldId === oldId);
      if (sw) {
        const idx = posts.findIndex((p) => p.text.includes(link));
        if (idx > 0) {
          console.log(await rewriteSwappedPlug({ sw, plan, handPlugs, posts, idx, link, product, env, account: ACCOUNT }));
          // Whether the rewrite ran, was rejected, or threw, the copy that will SHIP is checked for a
          // name the new link does not sell. A leak is fatal: the alternative is shipping a plug that
          // sells one brand over another brand's link, which is the defect this whole guard exists for.
          const leak = brandLeak(posts[idx].text, sw.from.product || '', product || '');
          if (leak) {
            console.log(`  ✗ BRAND LEAK after swap: the plug still says "${leak}", which belongs to ${sw.from.asin}, not ${asin}.`);
            console.log(`     Hand-write that plug (--plug-file ${sw.from.asin}=<file>) — refusing to ship copy that sells a name the link does not.`);
            process.exitCode = 1; return;
          }
        }
      }
      // CARRY THE TITLE, NOT JUST THE NAME WE HAPPEN TO HAVE (2026-09-18). substanceTermsFor recovers
      // a product's own vocabulary from its TITLE — `wordIn(title, sub)` is how "coq10" and
      // "ubiquinol" become terms at all for an asin that is not itself a BRIDGE routing target. This
      // pushed `product` and never `title`, so that arm was dead for every repost, and a plug
      // resolved through the Levanta catalog carries `product: ''` on top of it.
      //
      // The result was a FALSE "plug bridge missing". B00B0YQ7JI is Healthy Origins Ubiquinol CoQ10;
      // its only asin-keyed term is `mitochondria`, so a bridge reading "the cheap CoQ10 is worse
      // than no CoQ10 at all. Ubiquinone is the oxidised form…" matched nothing and the gate refused
      // a body that names the substance twice. Five findings across the live pool were this.
      // products.json is already loaded above and knows the title; use it.
      const known = products.find((x) => x.asin === asin);
      minted.push({ asin, product, title: known?.title || product || '', subid1, link, ...(sw ? { swappedFrom: sw.from.asin } : {}) });
      console.log(`  ✓ re-minted ${oldId} -> ${link} (asin ${asin}, subid1 ${subid1})`);
    } catch (e) { notes.push(`mint(${asin}) failed: ${e.message.slice(0, 50)}`); console.log(`  ✗ mint failed for ${asin}: ${e.message.slice(0, 60)} — keeping source link`); }
  }
  const attributed = minted.length > 0 && minted.length === present.length; // every plug got its own fresh link
  const statusLine = attributed ? 'Fresh tracking links minted — this repost is attributed to its OWN row.'
    : present.length ? `PARTIAL/NO re-mint (${notes.join('; ') || (src ? 'no source products' : 'no source ledger')}) — revenue may track to the source link.`
    : 'No plug links in this thread.';
  // Per-platform tracked links for any cross-post (operator 2026-08-27). A repost that carries X's
  // links to Threads is unmeasurable there, exactly like a fresh thread would be.
  // (The cross-post copy is built further down, after repairs and the media transfer — see there.)
  // The note this draft carries is THE RECORD (harvest-record.mjs), built after the repairs below so
  // it can name them; statusLine rides in its gates line. The four-line "EVERGREEN REPOST" note
  // this replaced answered none of "where did this come from" (operator 2026-09-06).

  // ---- REPAIR, THEN GATE (operator 2026-08-25) ---------------------------------------------------
  // This lane published verbatim and unexamined. Replaying nine of our best-earning threads through
  // validateDraft the night this landed: zero passed. Old disclaimers tripping the compliance regex,
  // plugs with no bridge, asks fused into a numbered item, one hook naming a banned topic. Every
  // other route to publication is gated; this was the one that was not, and it is on a cron.
  // deepRepostRepairs runs the three base moves and then the pod-sourced ones (2026-08-26). The base
  // set alone cleared 8 of 46 bench threads, because the failures arrive in COMBINATIONS: the largest
  // single class, a missing plug bridge, clears exactly one thread on its own. Together they clear 13.
  // Everything it does is failure-triggered, so a winner that already passes comes back untouched.
  const { tweets: repaired, applied, proposals, unrepairable } = deepRepostRepairs(posts.map((p) => p.text), ACCOUNT, minted, { source: SOURCE !== ACCOUNT ? SOURCE : null });
  if (repaired.length !== posts.length || repaired.some((t, i) => t !== posts[i]?.text)) {
    // Repairs change the tweet COUNT (a lifted bridge, a refreshed sign-off), so rebuild the post
    // array around them. Media rides on the tweet it was attached to, matched by text.
    const byText = new Map(posts.map((p) => [p.text, p]));
    // A merged or split tweet (MOVE 3.5) no longer equals any original, so its media is matched by
    // the original's opening words instead, each original's media handed over at most once.
    const spent = new Set();
    const mediaFor = (t) => {
      const exact = byText.get(t);
      const src = exact || posts.find((p) => !spent.has(p) && p.media_ids?.length && (t.includes(p.text.slice(0, 60)) || p.text.includes(t.slice(0, 60))));
      if (src) spent.add(src);
      return src?.media_ids || [];
    };
    const rebuilt = repaired.map((t) => ({ text: t, media_ids: mediaFor(t) }));
    console.log(`  ↳ repost repairs: ${posts.length} -> ${rebuilt.length} tweets`);
    // Name every move. A repost that quietly rewrote a winner's plug and then reported "gates clean"
    // would be indistinguishable from one that changed nothing, and these are our best threads.
    for (const a of applied) console.log(`     · ${a.move} @${a.at}: ${a.note}`);
    posts.length = 0; posts.push(...rebuilt);
  }
  for (const u of unrepairable) console.log(`  ! beyond repair: ${u}`);
  // Never applied — moving the ask relocates it inside the argument, which is a copy call.
  for (const p of proposals) console.log(`  ? proposal (not applied): ${p.move} — ${p.why}; would move tweets ${p.from}-${p.from + p.block.length - 1} to ${p.to}`);
  // Cross-set media moves into the TARGET set here, after the repairs settle which tweet carries
  // what. A --gate-only probe only reports the move (see transferMedia).
  await transferMedia({ tf, posts, source: SOURCE, target: ACCOUNT, gateOnly: GATE_ONLY });
  const gateLinks = minted.map((m) => m.link).filter(Boolean);
  if (gateLinks.length) {
    const texts = posts.map((p) => p.text);
    const firstPlug = texts.findIndex((t) => (t.match(/https?:\/\/\S+/g) || []).some(isTrackedLink));
    const ctaDepth = firstPlug > 0 && !(leadingNumbers(texts[firstPlug - 1]) || []).length ? 2 : 1;
    // --first-plug-at <n>: the same declared loosening publish-thread specs carry — it only ever
    // WIDENS the 3-4 ask window and validateDraft caps it at 6, so it cannot push an ask deeper
    // than the law already allows. Needed here because pool winners published before the window
    // law tightened: Clara's 795-click listicle opens its ask at 5 and is otherwise clean.
    const FIRST_PLUG_AT = flag('first-plug-at') ? Number(flag('first-plug-at')) : null;
    // A REPAIR MAY CARRY ITS OWN DECLARATION (2026-09-18). harvest-repair classifies "argues X and
    // never sells it" as DECLARED rather than FORBIDDEN — no text changes, the finding is recorded
    // as an allowUnsold list — so the body ships exactly as it earned instead of the heart expiring.
    // Unioned with the CLI flag, never replacing it: an operator's explicit --allow-unsold still
    // applies on top of whatever the repair declared.
    const allowUnsold = [...new Set([...ALLOW_UNSOLD, ...((repair?.allowUnsold) || [])])];
    const issues = validateDraft(texts, gateLinks, ACCOUNT, true, minted, { ctaDepth, allowUnsold, firstPlugAt: FIRST_PLUG_AT });
    if (issues.length) {
      console.error(`REFUSED: repost of ${origId} fails ${issues.length} gate(s) — nothing published.`);
      for (const i of issues) console.error(`  · ${i}`);
      console.error('A winner is not exempt from the laws. Retrofit it by hand, or let the lane pick another candidate.');
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ gates clean (${posts.length} tweets, ask depth ${ctaDepth})`);
    if (GATE_ONLY) { console.log('(gate-only — nothing minted, nothing created)'); return; }
  }

  // --gate-only NEVER CREATES, by any path. The early return above lives inside the gating block,
  // which is skipped when a body has no re-mintable links (the as-is fallback) — so probing such a
  // body actually published a draft and wrote a ledger row. pool-probe.mjs hit this three times on
  // one body before it was caught. A read-only flag has to be read-only on every branch, so the
  // guard is repeated here, immediately before the only write.
  if (GATE_ONLY) { console.log('(gate-only — nothing minted, nothing created)'); return; }

  // Per-platform tracked links for any cross-post (operator 2026-08-27). A repost that carries X's
  // links to Threads is unmeasurable there, exactly like a fresh thread would be. Built HERE, after
  // the repairs and the cross-set media transfer: the copy used to be taken before both, so on a
  // Threads page it carried the unrepaired tweet list and the SOURCE set's media ids, and Typefully
  // answered the create with a 404 (julian, magnus and rafael attempts, 2026-09-06). It also means a
  // --gate-only probe no longer mints -th links for a draft it will never create.
  const { platformPosts: xpPosts, minted: xpMinted } = NO_CROSS
    ? { platformPosts: null, minted: [] }
    : await crossPostLinks(env, ACCOUNT, posts, minted);

  // THE RECORD, and the [Harvest] title (operator 2026-09-06: "it's just seed, harvest and cover").
  // Source = our own post: its hook, its X link from the registry, the parent draft, the Harvests
  // row and which heart this is; then the repairs this attempt carries, its links and its history.
  const ledgerRows = existsSync(join(HERE_DIR, 'ledger.jsonl'))
    ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  let originUrl = null;
  if (env.REGISTRY_BASE_ID) {
    try { originUrl = (await airtable(env, env.REGISTRY_BASE_ID).listAll(REGISTRY_TABLE, { formula: `{Draft ID}="${origId}"`, fields: ['X URL'] }))[0]?.fields?.['X URL'] || null; }
    catch { originUrl = null; }
  }
  const record = harvestRecord({
    account: ACCOUNT, sourceAccount: SOURCE, origin: orig, origId, originUrl, harvestRecId: HARVEST_REC || null,
    heart: attemptsOf(ledgerRows, origId).length + 1, batch: BATCH || null,
    products: minted.map((m) => ({ asin: m.asin, title: m.product, link: m.link, subid1: m.subid1 })),
    tweets: posts.map((p) => p.text), repair, applied, unrepairable,
    gates: `${minted.length ? 'validateDraft clean at create' : 'no re-mintable link, shipped as-is'} · ${statusLine}`,
    baseId: env.XDB_BASE_ID || null, harvestsTable: env.HARVESTS_TABLE || null,
  });
  // The link check before anything is scheduled (owner, 2026-09-24), as publish-thread runs it.
  if (at) {
    const gate = await linkGate(scheduledLinks(posts, xpPosts || {}));
    if (gate.dead.length) {
      console.log(`✗ ${gate.dead.length} dead link(s) — nothing written, nothing scheduled:`);
      for (const d of gate.dead) console.log(`   · ${d.url} — ${d.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ links live — ${gate.checked} tracked link(s) resolve to product pages`);
  }
  const draft = await tf.createDraft(ACCOUNT.socialSetId, {
    draft_title: record.thread.title,
    scratchpad_text: renderScratchpad(record),
    share: true, // public share_url stays live for Telegram/team links
    // On CREATE buildPlatforms reads the account's own crossPost list, so --no-cross is expressed by
    // handing it an account with that list emptied rather than by a flag it would have to learn.
    platforms: buildPlatforms(posts, { account: NO_CROSS ? { ...ACCOUNT, crossPost: [] } : ACCOUNT, platformPosts: xpPosts }),
    ...(at ? { publish_at: at } : {}),
  });
  const shareUrl = draft.share_url || `https://typefully.com/?d=${draft.id}`;
  resultChannel?.confirm(draft.id, shareUrl);
  console.log(`✓ Draft republished: id ${draft.id} | https://typefully.com/?d=${draft.id}`);
  console.log(`Share URL: ${shareUrl}`); // public link captured by run-weekly for its Telegram digest
  // The draft id and share url only exist after creation, so the note is completed here — one
  // PATCH, exactly as publish-thread does — and the durable copy lands in queues/threads/.
  record.thread.draftId = String(draft.id);
  record.thread.shareUrl = shareUrl;
  record.history[record.history.length - 1].draftId = String(draft.id);
  try {
    const file = writeRecord(record);
    await tf.patchDraft(ACCOUNT.socialSetId, draft.id, { scratchpad_text: renderScratchpad(record) });
    console.log(`  record: ${file.replace(HERE_DIR + '/', '')}`);
  } catch (e) { console.log(`  ⚠ record not written: ${e.message}`); } // never fail a shipped attempt over bookkeeping

  // Ledger: record the FRESH links/subids so registry-sync (byLvId: lv_id -> draftId) attributes this
  // repost's Levanta revenue to ITS OWN row instead of the source's. No minted link => attribution-blind
  // (kept honest: no link fields written, and the scratchpad says so).
  const entry = { ts: new Date().toISOString(), account: ACCOUNT.name, recId: `evergreen-${origId}`, draftId: draft.id, mode: 'evergreen', sourceDraftId: origId, reminted: attributed,
    // publishAt = when readers actually see this run — the clock the cooldown law is written in.
    ...(at && Number.isFinite(Date.parse(at)) ? { publishAt: new Date(Date.parse(at)).toISOString() } : {}) };
  if (minted[0]) { entry.subid1 = minted[0].subid1; entry.asin = minted[0].asin; entry.product = minted[0].product; entry.link = minted[0].link; }
  if (minted[1]) { entry.subid1b = minted[1].subid1; entry.asin2 = minted[1].asin; entry.product2 = minted[1].product; entry.link2 = minted[1].link; }
  appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(entry) + '\n');
  // Products 3+ (roundup reposts): attributionOnly rows, the publish-thread.mjs pattern — the mint
  // loop re-mints EVERY plug but only the first two ever reached the ledger, so a roundup's third
  // link earned into the void.
  for (const m of minted.slice(2)) {
    appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account: ACCOUNT.name, recId: `evergreen-${origId}`, draftId: draft.id, mode: 'evergreen', attributionOnly: true, subid1: m.subid1, asin: m.asin, product: m.product, link: m.link }) + '\n');
  }
  await markReposted(env);
  if (HARVEST_REC) {
    // Stamp-at-creation, gate-backfill-on-failure: the same two-layer rule reconcileLinks lives by.
    try {
      await airtable(env, env.REGISTRY_BASE_ID).upsert(REGISTRY_TABLE, 'Draft ID',
        [farmStampRow({ draftId: draft.id, harvestRecId: HARVEST_REC, batch: BATCH || null, verdict: 'Pending' })]);
      console.log(`  ✓ attempt stamped: Harvest ${HARVEST_REC} · verdict Pending${BATCH ? ` · batch ${BATCH}` : ''}`);
    } catch (e) { console.log(`  ⚠ attempt stamp failed (the gate backfills from the ledger): ${String(e.message).slice(0, 80)}`); }
  }
  for (const row of crossPostLedgerRows(xpMinted, { account: ACCOUNT.name, draftId: draft.id, recId: `evergreen-${origId}` })) {
    appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(row) + '\n');
  }
  console.log(`✓ Ledger + registry updated (Reposted)${attributed ? ` · attributed via ${minted.length} fresh link(s)` : ' · ⚠️ attribution NOT re-minted'}`);
}
// Run only when invoked as a script. Without this guard, importing republish.mjs to unit-test one of
// its pure helpers (brandLeak, substanceOf) fires the whole repost pipeline and dies on the missing
// draft id — which is why those helpers had no test coverage until now.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  withProcessResult(main).catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
