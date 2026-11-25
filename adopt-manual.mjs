// adopt-manual.mjs — give hand-posted threads a ledger identity, so their money can land.
//
// Type='Manual' means "no ledger row": registry-sync counts these posts and moves on — no Airtable
// row, no Subid, no Commission, ever. But several manual posts carry REAL tracked links (a pasted
// mint, a Gumroad ?ref) whose revenue then sits in the store totals with no thread to claim it.
// This tool walks published drafts on monetized accounts, and for any draft the ledger does not
// know that carries a tracked link, appends a mode:'manual-adopt' row with the links it found.
// After that, every existing join (registry, revenue, reconcile) works on it unchanged.
//
// Dispatch-only, opt-in, additive: it never edits drafts, never touches rows the ledger already
// has, and re-running is idempotent (adopted drafts are in the ledger next run, so they skip).
//
//   node adopt-manual.mjs            # append rows
//   node adopt-manual.mjs --dry      # list what would be adopted
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, typefully, loadLedger, lvIdOf, railOf, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';

const DRY = process.argv.includes('--dry');

/** Pure: the adoptable attribution found in a draft's post texts. First two Levanta-family links
 *  become link/link2; a Gumroad ?ref becomes subid1 (that IS the Gumroad join key). */
export function adoptLinksFrom(texts) {
  const urls = [...new Set((texts || []).flatMap((t) => [...String(t || '').matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[).,]+$/, ''))))];
  const lev = urls.filter((u) => ['levanta', 'amazon-attr'].includes(railOf(u)) && lvIdOf(u));
  const gum = urls.map((u) => (railOf(u) === 'gumroad' ? (String(u).match(/[?&]ref=([^&\s]+)/) || [])[1] : null)).filter(Boolean);
  const out = {};
  if (lev[0]) out.link = lev[0];
  if (lev[1]) out.link2 = lev[1];
  if (gum[0]) out.subid1 = decodeURIComponent(gum[0]);
  return Object.keys(out).length ? out : null;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const { byDraft } = loadLedger();
  let adopted = 0, scanned = 0;
  for (const acc of Object.values(ACCOUNTS)) {
    if (!acc.levantaSubidPrefix || acc.paused || acc.external) continue;
    let drafts = [];
    try {
      for (let offset = 0; ; offset += 50) {
        const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=published&limit=50&offset=${offset}`);
        drafts.push(...(j.results || []));
        if (!j.next || !(j.results || []).length) break;
      }
    } catch (e) { console.error(`${acc.name}: draft list failed — ${e.message}`); continue; }
    for (const d of drafts) {
      const id = String(d.id);
      if (byDraft.has(id)) continue; // the ledger already knows it — not manual, or already adopted
      scanned++;
      let full;
      try { full = await tf.getDraft(acc.socialSetId, d.id); } catch { continue; }
      const posts = full?.platforms?.x?.posts || [];
      const found = adoptLinksFrom(posts.map((p) => p.text));
      if (!found) continue; // untracked manual post — the reconcile viral list covers the big ones
      const row = { ts: new Date().toISOString(), account: acc.name, draftId: d.id, mode: 'manual-adopt', ...found, note: 'adopt-manual: hand-posted thread with tracked link(s)' };
      console.log(`${DRY ? '[DRY] ' : ''}adopt ${acc.name} draft ${id}: ${found.link ? lvIdOf(found.link) : ''}${found.link2 ? ' +' + lvIdOf(found.link2) : ''}${found.subid1 ? ' ref=' + found.subid1 : ''}`);
      if (!DRY) appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify(row) + '\n');
      adopted++;
    }
  }
  console.log(`${DRY ? '[DRY] ' : ''}adopt-manual: ${adopted} adopted of ${scanned} ledger-unknown published draft(s)`);
}
