// products-sync.mjs — mirror the product money board into the Airtable "Products" tab.
//
// One row per ASIN: the full kept catalogue (products.json) plus every board row that has since
// been retired from it, so a delisted earner keeps its history visible instead of vanishing. The
// numbers come from learnings/product-board.json — the per-ASIN aggregation over levanta-days.jsonl,
// the same file routing ranks on — so the tab and the code can never disagree.
//
// AIRTABLE IS DISPLAY ONLY HERE (operator doctrine, UE7): nothing reads this table back. Routing
// reads the JSON; this exists so the operator can open one tab and see the whole catalogue's money.
//
//   node products-sync.mjs          # upsert every row (keyed on ASIN)
//   node products-sync.mjs --dry    # print what would be written
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, runMain, levanta, typefully, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { ALLOW_ASINS, DENY_ASINS } from './checks.mjs';
import { selectPod } from './outline.mjs';

const TABLE = 'Products';
const DRY = process.argv.includes('--dry');
// --reimage re-hosts every product shot even where one already sits on the row; --no-images skips the
// Levanta read entirely, for a stats-only sync when the catalogue is slow or down.
const REIMAGE = process.argv.includes('--reimage');
const NO_IMAGES = process.argv.includes('--no-images');
// --no-cta skips the burner read, for a stats-only sync.
const NO_CTA = process.argv.includes('--no-cta');
// --prune deletes rows the sync no longer writes. Reporting is the DEFAULT and deleting is opt-in on
// purpose: a board that shrinks for a bad reason (a short Levanta read, a join regression) would
// otherwise take real rows down with it, and an upsert-only sync cannot tell those apart. Nine ghost
// rows accumulated in one afternoon from a join that was later reverted, so silence is not an option
// either — the count is always printed. Since 2026-09-02 a Products row is also the target of
// Published Content.Products (registry-sync links every thread to its ASINs' rows): pruning a row
// drops those links until the ASIN is back on the board and the next sync relinks them.
const PRUNE = process.argv.includes('--prune');

// Pure: board + catalogue -> Airtable field rows. Exported for tests.
// `images` is a Map<asin, url> from Levanta's own catalogue. Optional by design: the money numbers
// are the point of this table and a Levanta outage must never block them, so a missing map simply
// omits the field and leaves whatever Airtable already holds.
// `ctaByPod` is a Map<podId, shareUrl> of the burner's canonical [CTA] reference threads, so a row
// links to the proven plug copy for its pod instead of the operator hunting for it.
// `haveImage` is a Set<asin> of rows whose attachment is already the file this URL points at.
// Airtable re-downloads and REPLACES an attachment every time a url is sent, so resending the same
// image on a twice-weekly sync would re-host ~300 files for nothing. Skip those.
export function productRows({ board, products, retired = null, images = null, haveImage = null, ctaByPod = null }) {
  const rows = board?.rows || [];
  const fleetEpc = board?.fleet?.epc || 0;
  const byAsin = new Map(rows.map((r) => [r.asin, r]));
  const catalogue = new Map((products || []).map((p) => [p.asin, p]));
  // products.json's `retired` list (2026-09-02): ASINs we plugged and then delisted. They earn no
  // new slots, but Published Content.Products links every thread to its ASIN's row, and eleven
  // ledgered ASINs had no row at all — a thread that sold Self Obsessed linked nothing. A retired
  // product gets its row (Tier Retired) so its history stays attached; the money numbers still
  // come from the board when it has any.
  const delisted = new Map((retired || []).map((p) => [p.asin, p]));
  const out = [];
  const asins = new Set([...catalogue.keys(), ...byAsin.keys(), ...delisted.keys()]);
  for (const asin of asins) {
    const cat = catalogue.get(asin) || delisted.get(asin);
    const b = byAsin.get(asin);
    // Retired = earned on the board but no longer in the kept catalogue (or on the retired list).
    // Tier verdicts otherwise come from the board itself, which already applies the 100-click rule.
    const tier = (!catalogue.has(asin)) ? 'Retired'
      : b?.tier ? b.tier[0].toUpperCase() + b.tier.slice(1)
      : 'Unjudged';
    let pod = null;
    try { pod = cat ? selectPod(cat).pod : null; } catch { pod = null; }
    out.push({
      // Name is the PRIMARY field — the card title the operator reads (operator 2026-08-27: "make
      // the Title the Name of the card, instead of the SKU"). ASIN stays as the machine join key.
      Name: String(b?.title || cat?.title || asin).slice(0, 250),
      ASIN: asin,
      Brand: b?.brand || cat?.brand || '',
      Tier: tier,
      Rate: Number(b?.rate ?? cat?.commission ?? 0),
      'Lifetime Clicks': b?.clicks || 0,
      Orders: b?.orders || 0,
      Commission: Number((b?.commission || 0).toFixed(2)),
      Sales: Number((b?.sales || 0).toFixed(2)),
      EPC: Number((b?.epc || 0).toFixed(3)),
      CVR: Number((b?.cvr || 0).toFixed(3)),
      AOV: Number((b?.aov || 0).toFixed(2)),
      // EPC is realised history at the rates that were ACTUALLY paid, and it must stay that way —
      // rewriting it would destroy the only honest record of what past traffic earned. This is the
      // forward number beside it: what the same sales would pay at today's rate. Exact rather than
      // estimated, because sales and clicks are both measured and rate is current, so no assumption
      // about when a rate changed is needed. The two columns are equal until a rate moves.
      'EPC at Current Rate': b?.clicks ? Number((((b.sales || 0) * (Number(b.rate ?? cat?.commission ?? 0))) / b.clicks).toFixed(3)) : 0,
      'vs Fleet EPC': fleetEpc ? Number(((b?.epc || 0) / fleetEpc).toFixed(2)) : 0,
      Pod: pod?.id || '',
      // Blank when the product has no pod, or when its pod has no burner reference yet (NA1, ML1).
      // An empty string clears a stale link rather than leaving one pointing at a deleted draft.
      // With no burner read at all (unreachable, --no-cta, or zero [CTA] drafts found) the field is
      // left out: the 2026-10-06 sync found none and blanked all 152 links.
      ...(ctaByPod?.size ? { 'CTA Draft': (pod?.id && ctaByPod.get(pod.id)) || '' } : {}),
      Allow: ALLOW_ASINS.has(asin),
      Deny: DENY_ASINS.has(asin),
      'Last Synced': new Date().toISOString(),
    });
    // Attachments are written by URL: Airtable fetches the file and re-hosts it under its own CDN,
    // so the m.media-amazon.com link is a one-time source, not a hotlink that can rot later.
    const img = images?.get(asin);
    if (img && !haveImage?.has(asin)) out[out.length - 1].Image = [{ url: img }];
  }
  // Money first: the tab opens on the earners, and the 200+ zero-click tail sorts under them.
  return out.sort((x, y) => y['Lifetime Clicks'] - x['Lifetime Clicks']);
}

// asin -> image url, from Levanta's live catalogue. products.json carries no image field, so this
// is the only source. FAIL SOFT: an unreachable catalogue returns an empty map and the stats sync
// runs exactly as it did before — same rule the lifetime upsert follows in registry-sync.
export async function fetchImages(env) {
  const out = new Map();
  try {
    const items = await levanta(env).listAllProducts({ access: true });
    for (const it of items) {
      const url = it.image || it.imageUrl || it.mainImage || (Array.isArray(it.images) ? it.images[0] : null);
      if (!url) continue;
      // Levanta keys a listing by primaryId but also carries the variant ASINs it covers under
      // `ids`. Map every one of them: our ledger plugs whichever ASIN the thread named, which is
      // not always the listing's primary.
      for (const k of [it.primaryId, it.asin, it.id, it.productId, ...(Array.isArray(it.ids) ? it.ids : [])]) {
        if (k && !out.has(k)) out.set(k, url);
      }
    }
  } catch (e) {
    console.warn(`⚠ Levanta catalogue unreachable (${String(e.message).slice(0, 60)}) — syncing stats without images`);
  }
  return out;
}

// ASINs whose Image attachment is already the file `images` points at, compared on filename. Airtable
// does not keep the source URL, but it names the attachment after it, which is enough to tell a
// re-host from a genuine change. A read failure returns an empty set: re-hosting is wasteful, not wrong.
async function alreadyImaged(env, images) {
  const have = new Set();
  if (!images.size) return have;
  const base = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch { return ''; } };
  try {
    const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
    let offset;
    do {
      const q = new URLSearchParams({ pageSize: '100', 'fields[]': 'ASIN' });
      q.append('fields[]', 'Image');
      if (offset) q.set('offset', offset);
      const r = await fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(TABLE)}?${q}`, { headers: h });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      for (const rec of j.records || []) {
        const asin = rec.fields?.ASIN;
        const att = rec.fields?.Image?.[0];
        if (asin && att?.filename && images.has(asin) && att.filename === base(images.get(asin))) have.add(asin);
      }
      offset = j.offset;
    } while (offset);
  } catch (e) {
    console.warn(`⚠ could not read existing images (${String(e.message).slice(0, 40)}) — re-hosting all`);
  }
  return have;
}

// podId -> the burner's canonical [CTA] reference thread. Discovered LIVE by title each run rather
// than stored in pods.json: the operator rebuilds and renames these drafts, and a stored URL would
// quietly rot into a link to a deleted draft. The title convention "[CTA] <podId> · <substance>"
// already exists and is what publish wrote, so the naming IS the index.
// FAIL SOFT, like every other enrichment here: no burner, no links, stats still sync.
export function ctaMapFrom(drafts) {
  const out = new Map();
  for (const d of drafts || []) {
    const m = String(d?.draft_title || '').match(/^\[CTA\]\s+([A-Z]+\d+)\s+·/);
    if (m && d.share_url && !out.has(m[1])) out.set(m[1], d.share_url);
  }
  return out;
}

async function fetchCtaDrafts(env) {
  try {
    const tf = typefully(env);
    const setId = getAccount('burner').socialSetId;
    const all = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ limit: '50' });
      if (cursor) q.set('cursor', cursor);
      const j = await tf.get(`/social-sets/${setId}/drafts?${q}`);
      const items = j.results || j.drafts || j.data || [];
      all.push(...items);
      cursor = j.next_cursor || j.cursor || null;
      if (!cursor || !items.length) break;
    }
    return ctaMapFrom(all);
  } catch (e) {
    console.warn(`⚠ burner unreachable (${String(e.message).slice(0, 50)}) — syncing without CTA links`);
    return new Map();
  }
}

// Rows the sync no longer writes: a product dropped from the catalogue AND off the board, or an ASIN
// that only ever existed because of a bad join. Always reported; deleted only under --prune.
async function reconcile(env, wanted) {
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const base = `https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(TABLE)}`;
  const stale = [];
  try {
    let offset;
    do {
      const q = new URLSearchParams({ pageSize: '100' });
      q.append('fields[]', 'ASIN');
      if (offset) q.set('offset', offset);
      const r = await fetch(`${base}?${q}`, { headers: h });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      for (const rec of j.records || []) if (!wanted.has(rec.fields?.ASIN)) stale.push(rec.id);
      offset = j.offset;
    } while (offset);
  } catch (e) { console.warn(`⚠ could not reconcile (${String(e.message).slice(0, 40)})`); return; }
  if (!stale.length) { console.log('✓ no stale rows'); return; }
  if (!PRUNE) { console.log(`⚠ ${stale.length} stale row(s) the sync no longer writes — re-run with --prune to delete them`); return; }
  for (let i = 0; i < stale.length; i += 10) {
    const q = new URLSearchParams();
    for (const id of stale.slice(i, i + 10)) q.append('records[]', id);
    const r = await fetch(`${base}?${q}`, { method: 'DELETE', headers: h });
    if (!r.ok) { console.warn(`⚠ delete -> ${r.status}`); return; }
  }
  console.log(`✓ pruned ${stale.length} stale row(s)`);
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const board = JSON.parse(readFileSync(join(HERE_DIR, 'learnings', 'product-board.json'), 'utf8'));
  const catalogueFile = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8'));
  const products = catalogueFile.products;
  const retired = catalogueFile.retired || [];
  const images = NO_IMAGES ? new Map() : await fetchImages(env);
  // --dry reads the live image state too: a preview that always claims 300 uploads is a preview
  // that lies about the only expensive part of this sync.
  const haveImage = REIMAGE ? new Set() : await alreadyImaged(env, images);
  const ctaByPod = NO_CTA ? new Map() : await fetchCtaDrafts(env);
  const rows = productRows({ board, products, retired, images, haveImage, ctaByPod });
  const withImg = rows.filter((r) => r.Image).length;
  console.log(`${rows.length} product rows (${rows.filter((r) => r.Tier === 'Retired').length} retired, ${rows.filter((r) => !r.Pod).length} without a pod)`);
  console.log(`CTA links: ${ctaByPod.size} pods have a burner reference, ${rows.filter((r) => r['CTA Draft']).length}/${rows.length} rows linked`);
  console.log(`images: ${images.size ? `${rows.filter((r) => images.has(r.ASIN)).length}/${rows.length} matched in Levanta` : 'none (skipped or unreachable)'}, ${withImg} to upload, ${haveImage.size} already current`);
  if (DRY) { for (const r of rows.slice(0, 10)) console.log(` ${r.ASIN} ${r.Tier.padEnd(8)} ${String(r['Lifetime Clicks']).padStart(5)}clk $${r.EPC}/clk ${r.Pod || '—'}`); return; }
  const url = `https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(TABLE)}`;
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' };
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10).map((fields) => ({ fields }));
    const r = await fetch(url, { method: 'PATCH', headers: h, body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['ASIN'] }, typecast: true, records: batch }) });
    if (!r.ok) throw new Error(`Airtable upsert -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  console.log(`✓ upserted ${rows.length} rows into "${TABLE}"`);
  await reconcile(env, new Set(rows.map((r) => r.ASIN)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'products-sync');
