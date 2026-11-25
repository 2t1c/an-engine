// geni-swap.mjs — put Geniuslink (geni.us) in front of every plain lvnta.com plug in a scheduled
// Typefully draft, on X and on Threads, with the US-only rule on each link.
//
// WHY (owner, 2026-11-02): "Geniuslink i our default from now" and "replace with geniuslinks for
// these ones". The Nov restart shipped plain lvnta.com links because run-row's schedule stage never
// had the geni step the old /run carried. This is that step, run on the scheduled draft itself, so
// it covers every platform the draft posts to.
//
// HOW EACH LINK IS MADE (docs/geniuslink.md): Geniuslink refuses lvnta.com as a destination, so the
// lvnta link is resolved once to the amazon.com Attribution URL it 302s to (it keeps our maas and
// aa_adgroupid, so Levanta still joins the sale to the thread's lv_ id). geni.us wraps that URL, and
// the US-only rule (country not US -> the same URL) stops non-US clicks being localized away from
// our attribution. A link already made for the same lv_ id (same draft note) is reused, never doubled.
// One `mode: "geni"` ledger row per swapped link records lv -> geni.us.
//
//   node geni-swap.mjs --drafts SOCIALSET:DRAFT[,SOCIALSET:DRAFT…] [--dry]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { geniuslink, loadEnv, typefully, HERE_DIR } from './lib.mjs';

// BRAND LINKS PER THREAD (owner 2026-11-25: "we should also wrap brand links in geniuslink so we know where clicks
// came from"). Brand pages plug the brand's shared geni.us link per product (brand-lanes.json `glink`), so every
// thread on every brand page counted into one link. Each shared brand link in a scheduled draft is now swapped for
// a link of the draft's own (same group, same brand attribution URL, US-only rule), the way lvnta links are.
const BRAND_LANES = join(HERE_DIR, 'brand-lanes.json');
/** PURE. Shared brand glink -> { asin, dest, maas } from the brand-lanes config. */
export function brandShared(lanes = {}) {
  const out = new Map();
  for (const [k, lane] of Object.entries(lanes || {})) {
    if (k.startsWith('_') || !lane?.products) continue;
    for (const [asin, p] of Object.entries(lane.products)) {
      const maas = (String(p.attributionUrl || '').match(/maas=(maas_adg_[A-F0-9]+)/) || [])[1];
      if (p.glink && p.attributionUrl && maas) out.set(p.glink, { asin, dest: p.attributionUrl, maas });
    }
  }
  return out;
}
const loadShared = () => { try { return brandShared(JSON.parse(readFileSync(BRAND_LANES, 'utf8'))); } catch { return new Map(); } };
const linkRe = (url) => new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g');
/** PURE. Every shared brand link in a draft's enabled X and Threads posts, in order, once each. */
export function brandLinksOf(draft, shared) {
  const out = [];
  for (const plat of PLATFORMS) {
    const p = draft?.platforms?.[plat];
    if (!p?.enabled) continue;
    for (const post of p.posts || []) for (const g of shared.keys()) if (linkRe(g).test(String(post.text || '')) && !out.includes(g)) out.push(g);
  }
  return out;
}

export const GENI_GROUP = 445606;
// Countries new links hand to Geniuslink's localization instead of amazon.com (owner 2026-11-13,
// "UK + CA localize, test tomorrow"; France added 2026-11-14, "turn on localization for uk and Canada,
// I think we also have France"): their clicks earned nothing on amazon.com. These are the Amazon stores
// this Geniuslink account is enrolled in (geniuslink.mjs check). US and every other country keep the
// amazon.com Levanta URL. Empty = the plain US-only rule.
// OFF since 2026-11-16 (owner chose "Turn it off now"): on localized links Levanta clicks fell from 53%
// to 37% of Geniuslink human clicks and orders from 5.2 to 0.9 per 100 US clicks. All 96 localized links
// were moved back to the plain US-only rule the same day.
export const GENI_LOCALIZE = [];
export const PLATFORMS = ['x', 'threads'];
const LV_RE = /https:\/\/lvnta\.com\/lv_\w+/g;

/** PURE. Every plain lvnta.com link in a draft's enabled X and Threads posts, in order, once each. */
export function lvLinksOf(draft) {
  const out = [];
  for (const plat of PLATFORMS) {
    const p = draft?.platforms?.[plat];
    if (!p?.enabled) continue;
    for (const post of p.posts || []) for (const lv of String(post.text || '').match(LV_RE) || []) if (!out.includes(lv)) out.push(lv);
  }
  return out;
}

/** PURE. The PATCH body that swaps each lv link for its geni.us link, keeping every post's media. */
export function swapBody(draft, map) {
  const platforms = {};
  for (const plat of PLATFORMS) {
    const p = draft?.platforms?.[plat];
    if (!p?.enabled || !p.posts?.length) continue;
    platforms[plat] = { enabled: true, posts: p.posts.map((post) => ({
      text: [...map.keys()].filter((k) => !/lvnta\.com/.test(k)).reduce((t, g) => t.replace(linkRe(g), map.get(g)), String(post.text || '').replace(LV_RE, (lv) => map.get(lv) || lv)),
      media_ids: post.media_ids || [],
    })) };
  }
  return { platforms };
}

/** PURE. The subid each lvnta link was minted under (mint and cross-post rows), for the geni row's
 *  reference. A geni row carries no `link` of its own, so it is never counted as a second tracked
 *  thread; the sale still joins through the lv_ id inside the geni.us destination. */
export function subidsByLv(ledgerText) {
  const out = new Map();
  for (const line of String(ledgerText || '').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (/^https:\/\/lvnta\.com\//.test(r?.link || '') && r.subid1) out.set(r.link, r.subid1);
  }
  return out;
}

/** PURE. A resolved destination is usable only when it is amazon.com and still carries the lv_ id. */
export const usableDestination = (dest, lvId) =>
  /^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}\?/.test(String(dest || '')) && String(dest).includes(`aa_adgroupid=${lvId}`);

const resolveLv = (lv) => execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{redirect_url}', '--max-time', '20', lv], { encoding: 'utf8' }).trim();

async function geniFor(gl, lv, note) {
  const lvId = lv.match(/lv_\w+/)[0];
  const dest = resolveLv(lv);
  if (!usableDestination(dest, lvId)) throw new Error(`${lv} resolved to ${dest || 'nothing'}`);
  const prior = (await gl.listLinks({ groupId: GENI_GROUP, keyword: note })).find((l) => String(l.productUrl || l.destinationUrl || '').includes(lvId));
  const made = prior ? { code: prior.shortUrlCode } : await gl.createLink({ url: dest, groupId: GENI_GROUP, note });
  // Geniuslink stores its own form of the destination (adds linkCode/th/psc/language); the rule
  // writer checks against the stored one, so read it back and use that.
  const stored = (await gl.readDashboardLink(made.code)).linkOptions?.destination?.url;
  if (!usableDestination(stored, lvId)) throw new Error(`geni.us/${made.code} stored destination lost ${lvId}`);
  await gl.setUsOnlyRule(made.code, stored, GENI_GROUP, { localize: GENI_LOCALIZE });
  return { glink: `https://geni.us/${made.code}`, asin: dest.match(/\/dp\/([A-Z0-9]{10})/)[1] };
}

async function geniForBrand(gl, info, note) {
  const prior = (await gl.listLinks({ groupId: GENI_GROUP, keyword: note })).find((l) => String(l.productUrl || l.destinationUrl || '').includes(info.maas));
  const made = prior ? { code: prior.shortUrlCode } : await gl.createLink({ url: info.dest, groupId: GENI_GROUP, note });
  const stored = (await gl.readDashboardLink(made.code)).linkOptions?.destination?.url;
  if (!String(stored || '').includes(info.maas) || !String(stored).includes(`/dp/${info.asin}`)) throw new Error(`geni.us/${made.code} stored destination lost the brand attribution`);
  await gl.setUsOnlyRule(made.code, stored, GENI_GROUP, { localize: GENI_LOCALIZE });
  return { glink: `https://geni.us/${made.code}`, asin: info.asin };
}

/** Swap one scheduled draft. Returns { ok, swapped, line }. Never touches a draft that is not scheduled. */
export async function swapDraft({ tf, gl, socialSetId, draftId, account = '', dry = false, ledgerPath = join(HERE_DIR, 'ledger.jsonl') }) {
  const d = await tf.getDraft(socialSetId, draftId);
  if (!/scheduled/.test(d.status || '')) return { ok: false, swapped: 0, line: `not scheduled (${d.status})` };
  const lvs = lvLinksOf(d);
  const shared = loadShared(); const brands = brandLinksOf(d, shared);
  if (!lvs.length && !brands.length) return { ok: true, swapped: 0, line: 'no lvnta links' };
  if (dry) return { ok: true, swapped: 0, line: `would swap ${lvs.length + brands.length} link(s)` };
  const map = new Map(); const made = [];
  for (const lv of lvs) { const g = await geniFor(gl, lv, `${account} draft ${draftId}`.trim()); map.set(lv, g.glink); made.push({ lv, ...g }); }
  for (const b of brands) { const g = await geniForBrand(gl, shared.get(b), `${account} draft ${draftId} brand`.trim()); map.set(b, g.glink); made.push({ brandLink: b, ...g }); }
  await tf.patchDraft(socialSetId, draftId, swapBody(d, map));
  const back = await tf.getDraft(socialSetId, draftId);
  const left = lvLinksOf(back).length + brandLinksOf(back, shared).length;
  const sameTime = (back.scheduled_date || back.publish_at) === (d.scheduled_date || d.publish_at);
  const sameMedia = PLATFORMS.every((pl) => JSON.stringify((d.platforms?.[pl]?.posts || []).map((p) => p.media_ids || []))
    === JSON.stringify((back.platforms?.[pl]?.posts || []).map((p) => p.media_ids || [])));
  const ok = left === 0 && sameTime && sameMedia && /scheduled/.test(back.status || '');
  const ts = new Date().toISOString();
  const subids = subidsByLv(existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '');
  for (const m of made) appendFileSync(ledgerPath, JSON.stringify(m.brandLink ? { ts, account, draftId: String(draftId), mode: 'geni-brand', brandLink: m.brandLink, glink: m.glink, asin: m.asin, usOnlyRule: true, localize: GENI_LOCALIZE, source: 'geni-brand-per-thread' } : { ts, account, draftId: String(draftId), mode: 'geni', lvLink: m.lv, subid1Of: subids.get(m.lv) || null, glink: m.glink, asin: m.asin, usOnlyRule: true, localize: GENI_LOCALIZE, source: 'geni-default' }) + '\n');
  return { ok, swapped: made.length, line: `${made.length} link(s) -> geni.us${left ? ` · ${left} lvnta left` : ''}${sameTime ? '' : ' · TIME CHANGED'}${sameMedia ? '' : ' · MEDIA CHANGED'}` };
}

async function main(argv) {
  const i = argv.indexOf('--drafts');
  const pairs = (i >= 0 ? argv[i + 1] : '').split(',').filter(Boolean).map((s) => s.split(':'));
  if (!pairs.length || pairs.some((p) => p.length < 2)) { console.error('usage: node geni-swap.mjs --drafts SOCIALSET:DRAFT[:ACCOUNT][,…] [--dry]'); return 2; }
  const env = loadEnv(); const tf = typefully(env); const gl = geniuslink(env);
  let bad = 0;
  for (const [ss, id, account] of pairs) {
    try { const r = await swapDraft({ tf, gl, socialSetId: ss, draftId: id, account, dry: argv.includes('--dry') }); if (!r.ok) bad++; console.log(`  ${r.ok ? '✓' : '✗'} geni ${id} ${r.line}`); }
    catch (e) { bad++; console.log(`  ✗ geni ${id} ${String(e.message).slice(0, 160)}`); }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
