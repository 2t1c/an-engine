// swap-product.mjs — replace non-converting STACK products in scheduled drafts with a proven/single
// product (via the fixed picker), mint a tracked link, and regenerate the plug(s) spaced + bridged.
//   node swap-product.mjs           # dry: show every old -> new product swap
//   node swap-product.mjs --go      # execute (mint + regenerate plugs + patch)
import { buildPlatforms, rebuildCrossPosts } from './platforms.mjs';
import { loadEnv, typefully, levanta, anthropic, FLEET_MODEL, flushLlmSpend, HERE_DIR } from './lib.mjs';
import { getAccount, ACCOUNTS } from './accounts.mjs';
import { VOICE_BLOCKS_ON } from './laws.mjs';
import { candidates } from './pick-product.mjs';
import { PLUG_LIMIT, plugTextLen, STACK_RE, DENY_ASINS as DENY, isStack, stripDashes as stripEmDash } from './checks.mjs';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const GO = process.argv.includes('--go');
const LIMIT = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10) : Infinity;
const env = loadEnv(); const tf = typefully(env);
const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
// Derived from the roster (2026-07-21 scaling pass) — was a hand-copied 3-page map that would
// silently omit every new account. DENY/STACK_RE/isStack imported from checks.mjs.
// Keyed by ACCOUNT KEY (not display name): getAccount() takes the key, and a name like "Rafael Nasri"
// lowercased ("rafael nasri") is not a key — that mismatch crashed the whole run (2026-08-07 fix).
const HEALTH = Object.fromEntries(Object.entries(ACCOUNTS).filter(([, a]) => a.plugHeavyExample && !a.paused).map(([key, a]) => [key, a.socialSetId]));
const linkOf = (t) => (t.match(/https?:\/\/\S+/) || [''])[0];
// stripEmDash = shared stripDashes from checks.mjs (dash-only; QC/judge inputs are existing posts, not fresh LLM output)
const slug = (s) => String(s).toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// SINGLES ONLY: every 10-in-1/stack is removed (incl. Night Before + Self Obsessed). Route by the OLD
// product's theme (it was topic-matched to the thread) to a proven SINGLE; themes with no proven single
// fall to the best non-stack single. A plug that bridges the thread converts; an off-theme one doesn't.
const SINGLE_BY_THEME = [
  [/sleep|magnesium|melatonin|night ?before|insomnia|stress|cortisol|anxiety|\bcalm\b/i, 'B0DZ33GTQ2'], // Sports Research Magnesium Glycinate (proven single)
  [/heart|nitric|circulat|blood ?flow|cardio|pressure|cholesterol|artery/i, 'B0DK61GRD2'],              // Heart of Steel nitric oxide (proven single)
  [/weight|fat ?loss|metabolism|appetite|suppressant|diet pill|belly|slim|\blean\b|obes/i, 'B0DZ33GTQ2'], // fat-loss stacks -> Magnesium: these threads push SLEEP as the fat-loss lever (strong bridge)
];
function pickReplacement(hook, oldAsin) {
  const old = products.find((p) => p.asin === oldAsin) || {};
  const t = `${old.title || ''} ${old.category || ''}`;
  const isBundle = / x |×/i.test(old.title || ''); // multi-product "A x B x C" combos: let the thread topic decide
  if (!isBundle) for (const [re, asin] of SINGLE_BY_THEME) if (re.test(t)) return products.find((p) => p.asin === asin);
  // Bundle, or a theme with no proven single (testosterone, gut, brain, hair): best NON-stack single.
  const ctx = isBundle ? hook : `${old.title || ''} ${old.category || ''}`; // non-bundle: the old product's theme decides, not the hook
  const c = candidates(ctx, products).filter((p) => !DENY.has(p.asin));
  return c.find((p) => !isStack(`${p.title} ${p.category || ''}`)) || c[0];
}

async function generatePlug(account, prior, prod, link, heavy) {
  const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 500, messages: [{ role: 'user', content:
`Write ONE affiliate plug tweet for @${account.handle} (${account.name}).
${VOICE_BLOCKS_ON && account.voice ? `VOICE:\n${account.voice}\n` : ''}PRODUCT: ${prod.title}
PRIOR TWEET (bridge from this):\n${prior}
Rules: ${heavy ? 'heavy plug' : 'lighter plug'}. SPACED as separate beats, each on its own line with a BLANK LINE between, in this shape:
<one bridge line continuing the prior tweet's specific idea>

<a specific time-stamped first-person "before" moment + one mechanism clause for why ${prod.title.split(' ').slice(0, 3).join(' ')} works>

${prod.title.split(',')[0].slice(0, 40)}  Aff link

${link}
Keep text EXCLUDING the link under ${PLUG_LIMIT} chars. No em dashes. Return ONLY the plug text.` }] });
  let p = stripEmDash(out.trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim());
  if (!p.includes(link)) p += `\n\n${link}`;
  if (!/aff|affiliate|#ad/i.test(p)) p = p.replace(link, `Aff link\n\n${link}`);
  for (let i = 0; i < 3 && plugTextLen(p) > PLUG_LIMIT; i++) { // keep the plug under the limit (text excl link)
    const s = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 400, messages: [{ role: 'user', content:
`Shorten this plug so the text EXCLUDING the link is under ${PLUG_LIMIT - 25} chars (now ${plugTextLen(p)}). Keep the spaced beats (blank line between), the product name, "Aff link", and the link verbatim. No em dashes. Return ONLY the plug.\n\n${p}` }] });
    p = stripEmDash(s.trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim());
    if (!p.includes(link)) p += `\n\n${link}`;
  }
  return p;
}

let swapped = 0;
outer: for (const [name, ssid] of Object.entries(HEALTH)) {
  const account = getAccount(name); // `name` is now the account KEY (see HEALTH above)
  let off = 0, all = [];
  while (true) { const j = await fetch(`https://api.typefully.com/v2/social-sets/${ssid}/drafts?limit=50&offset=${off}`, { headers: { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}` } }).then((r) => r.json()); all.push(...(j.results || [])); if (!j.next || !j.results.length) break; off += j.results.length; }
  const now = Date.now();
  const sched = all.filter((d) => d.scheduled_date && new Date(d.scheduled_date).getTime() >= now && String(d.status).toLowerCase() !== 'published');
  for (const d of sched) {
    const full = await tf.getDraft(ssid, d.id);
    const pm = (full.scratchpad_text || '').match(/Product:\s*(.+?)\s*\(([A-Z0-9]{10})\)/);
    if (!pm) continue;
    const [, title, asin] = pm;
    const bad = isStack(title) || DENY.has(asin);
    if (!bad) continue;
    const posts = full.platforms.x.posts.map((p) => ({ text: p.text, media_ids: [...(p.media_ids || [])] }));
    const hook = posts[0].text;
    const np = pickReplacement(hook, asin);
    if (!np || np.asin === asin) { console.log(`  ${name} ${d.id}: no better replacement found (kept ${asin})`); continue; }
    console.log(`  ${name} ${d.id}: ${asin} "${title.slice(0, 32)}" -> ${np.asin} "${np.title.slice(0, 32)}"`);
    if (!GO) { swapped++; continue; }
    const subid1 = ((full.scratchpad_text || '').match(/Subid1?:\s*(\S+)/i) || [])[1] || `${account.levantaSubidPrefix}-${slug(hook)}-${String(d.id).slice(-6)}`;
    // -w<nonce>: a bare deterministic subid re-mints the SAME link (the SUVaiu collision class
    // recreate.mjs nonces against), and the fresh link needs its own identity in the ledger anyway.
    const swapSubid = `${subid1}-w${Math.random().toString(36).slice(2, 6)}`;
    const vb = 'tier-proven';
    let link;
    // Honour the account's direct-link A/B (2026-08-13) — same rule as recreate/republish.
    try { const m = await levanta(env).mintLink(np.asin, swapSubid, vb); link = account.directLink ? (m.url || m.mobileOptimizedUrl || m.mobile_optimized_url) : (m.mobileOptimizedUrl || m.mobile_optimized_url || m.url); }
    catch (e) { console.log(`    ✗ mint failed: ${e.message.slice(0, 60)}`); continue; }
    const plugIdx = posts.map((p, i) => (/lvnta\.com\/|gumroad\.com\//i.test(p.text) ? i : -1)).filter((i) => i >= 0);
    let heavy = true;
    for (const i of plugIdx) {
      try { posts[i].text = await generatePlug(account, posts[i - 1]?.text || '', np, link, heavy); heavy = false; }
      catch (e) { console.log(`    ✗ plug ${i + 1} regen failed: ${e.message.slice(0, 50)}`); }
    }
    const sp = (full.scratchpad_text || '') // keep scratchpad in sync so QC sees the new product and re-runs stay idempotent
      .replace(/Product:.*/, `Product: ${np.title} (${np.asin})`)
      .replace(/Subid1?:.*/i, `Subid1: ${swapSubid}`)
      .replace(/Link:.*/, `Link: ${link}`);
    // A swap mints a NEW link, so rebuildCrossPosts refuses to rewrite a copy it cannot re-link —
    // handing it X's link would collapse the "-th" split and make the copy unmeasurable. That skip
    // is correct here; what it leaves behind is a copy selling the OLD product, which is worse than
    // stale text and must be said out loud rather than logged as a footnote.
    const { platformPosts, skipped } = rebuildCrossPosts(posts, full?.platforms);
    for (const s of skipped) console.log(`    ! cross-post ${s.platform} NOT swapped (${s.reason}) — it still sells the old product; mint its own link via cross-post-links.mjs`);
    await tf.patchDraft(ssid, d.id, { platforms: buildPlatforms(posts, { existing: full?.platforms, platformPosts }), scratchpad_text: sp });
    // The swap finally reaches the ledger: before this row, the OLD link stayed the draft's claimant
    // (a stale row) while the NEW live link had no row at all — both ends of the join broken by one
    // patch. Replace-outright semantics make this row the draft's authoritative identity.
    appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account: account.name, draftId: d.id, mode: 'swap', subid1: swapSubid, asin: np.asin, product: np.title, link, swapOf: asin, note: 'swap-product remint' }) + '\n');
    console.log(`    ✓ patched (${plugIdx.length} plug(s) -> ${np.title.split(',')[0].slice(0, 30)})`);
    swapped++;
    if (swapped >= LIMIT) { console.log('(limit reached)'); break outer; }
  }
}
console.log(`\n${GO ? 'swapped' : 'to swap'}: ${swapped}`);
// Spend visibility: this script rewrites plugs with the LLM but exits without logRun, so its cost was
// invisible in the LLM Spend table (audit 2026-08-13). Fire-and-forget — never fail the run over it.
await flushLlmSpend(env, 'swap-product').catch(() => {});
