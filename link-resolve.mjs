// link-resolve.mjs — what product is behind a plug link, when the ledger cannot say.
//
// A harvest attempt is a VERBATIM repost with fresh links, so every lv_ link in the body has to be
// re-minted. republish resolves each one through the source draft's ledger row — and that row holds
// exactly TWO links, `link` and `link2`. A thread with three, four or five plugs therefore cannot
// describe itself: the extra links resolve to nothing, republish reports `re-mintable: 2/3`, and
// pool-probe marks the body unrunnable because a verdict measured through a dead link is unreadable.
//
// This is not link rot. Measured on the live pool 2026-09-17: 8 of the 16 blocked bodies fail this
// way and EVERY one of them has more plugs than the ledger schema has slots — 1/4, 2/3, 2/3, 2/4,
// 2/5, 2/3, 2/3, 2/3. They are the densest bodies in the pool ($0.60, $0.59, $0.56/1k) and between
// them they were holding hearts that could never be spent. The pool was not short of winners; it
// was short of winners it could describe.
//
// THREE SOURCES, WIDEST LAST. Each is strictly more speculative than the one before, so a caller
// can see which answered and refuse the weak ones if it wants:
//   own      the draft's own ledger row — what republish already used, and always right
//   ledger   any OTHER ledger row that minted the same lv_ id — the same link, recorded elsewhere
//   levanta  Levanta's own link catalog, which knows the ASIN behind every link we ever minted,
//            including 231 ids the ledger never recorded at all
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lvIdOf, loadEnv, levanta, runMain, HERE_DIR } from './lib.mjs';

/** Levanta's link catalog, cached so a republish never waits on the API. registry-sync refreshes
 *  it from the reports it already pulls (six times a day) and its workflow commits it; `node
 *  link-resolve.mjs --refresh` does it by hand.
 *
 *  THE FILE IS NOT INTRODUCED BY A PULL REQUEST, ON PURPOSE. It is ~1,600 lines of machine-written
 *  cache, and the compare API omits a `patch` for a file that size — which auto-merge-evidence
 *  refuses outright ("immutable compare omitted a file patch"), correctly: nobody can review a diff
 *  that was never sent. So it is .gitignore'd, which makes that mechanical rather than a promise,
 *  and the registry sync force-adds it (`git add -f`) on its own direct push — the one route by
 *  which it reaches main. Until that run lands, this returns an empty index and resolution degrades
 *  to the ledger-only answer: never worse than what shipped before it existed. */
export const CATALOG_FILE = join(HERE_DIR, 'queues', 'levanta-links.json');

/** lv_ id -> { asin, product, from } for every link ANY ledger row recorded. Pure. */
export function buildLedgerIndex(byDraft = new Map()) {
  const out = new Map();
  for (const [draftId, e] of byDraft) {
    for (const [link, asin, product] of [[e?.link, e?.asin, e?.product], [e?.link2, e?.asin2, e?.product2]]) {
      const id = lvIdOf(link);
      // First writer wins: the earliest row to mint a link is the one that owns its provenance,
      // and a later row reusing the same link tells us nothing new about which product it points at.
      if (id && asin && !out.has(id)) out.set(id, { asin, product: product || '', from: String(draftId) });
    }
  }
  return out;
}

/** lv_ id -> { asin } from Levanta's daily report rows, which carry the link object inline. Pure. */
export function buildLevantaIndex(reports = []) {
  const out = new Map();
  for (const r of reports) {
    const id = r?.link?.id;
    if (!id || out.has(id)) continue;
    if (!r.asin) continue;
    out.set(id, { asin: r.asin, product: '', active: r.link.active !== false });
  }
  return out;
}

/**
 * Resolve every plug link a body carries. PURE — the caller supplies the indexes.
 *
 *   present  the lv_ ids found in the body's text, in order
 *   own      the source draft's own ledger row (or null)
 *
 * Returns { links, resolved, total, whole, bySource }. `whole` is the thing pool-probe's
 * `remintOk` really wanted to ask: can EVERY link in this body be re-minted?
 */
export function resolvePlugLinks(present = [], { own = null, ledger = new Map(), levanta = new Map() } = {}) {
  const ownIndex = new Map();
  for (const [link, asin, product] of [[own?.link, own?.asin, own?.product], [own?.link2, own?.asin2, own?.product2]]) {
    const id = lvIdOf(link);
    if (id && asin) ownIndex.set(id, { asin, product: product || '' });
  }
  const links = [...new Set(present.filter(Boolean))].map((id) => {
    const hit = ownIndex.get(id) ?? ledger.get(id) ?? levanta.get(id) ?? null;
    const via = ownIndex.has(id) ? 'own' : ledger.has(id) ? 'ledger' : levanta.has(id) ? 'levanta' : null;
    return { id, asin: hit?.asin ?? null, product: hit?.product ?? '', via };
  });
  const bySource = links.reduce((acc, l) => ({ ...acc, [l.via || 'unresolved']: (acc[l.via || 'unresolved'] || 0) + 1 }), {});
  const resolved = links.filter((l) => l.asin).length;
  return { links, resolved, total: links.length, whole: links.length > 0 && resolved === links.length, bySource };
}

/** The one-line summary republish prints, so the widened resolution is legible in a probe log. */
export const resolutionLine = (r) => {
  const extra = Object.entries(r.bySource).filter(([k]) => k !== 'own' && k !== 'unresolved').map(([k, n]) => `${n} via ${k}`);
  return `${r.resolved}/${r.total}${extra.length ? ` (${extra.join(', ')})` : ''}`;
};

/** The cached catalog as an index, or an empty one. A missing cache must never break a republish —
 *  it degrades to exactly the behaviour that shipped before this file existed. */
export function loadLevantaCatalog(file = CATALOG_FILE) {
  try {
    if (!existsSync(file)) return new Map();
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return new Map(Object.entries(j.links || {}));
  } catch { return new Map(); }
}

/** Persist the catalog. Additive: a link Levanta stops reporting on stays known, because a body
 *  posted months ago still carries it and still has to be re-mintable.
 *
 *  ONE LINE PER LINK, KEYS SORTED. registry-sync commits this file on every run — six times a day,
 *  forever — so the serialisation is a review decision, not a formatting one. A single-line blob
 *  re-writes all 114KB in each commit and shows a reviewer nothing; sorted line-per-link means the
 *  diff is exactly the links that were learned, and a run that learns nothing produces a byte-
 *  identical body so there is no commit at all. */
export function saveLevantaCatalog(index, file = CATALOG_FILE) {
  const links = Object.fromEntries([...loadLevantaCatalog(file), ...index]);
  const ids = Object.keys(links).sort();
  const body = ids.map((id) => ` ${JSON.stringify(id)}: ${JSON.stringify(links[id])}`).join(',\n');
  writeFileSync(file, `{\n "updatedAt": ${JSON.stringify(new Date().toISOString())},\n "count": ${ids.length},\n "links": {\n${body}\n }\n}\n`);
  return ids.length;
}

async function main() {
  const env = loadEnv();
  const days = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=180').split('=')[1]);
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const reports = await levanta(env).listReports({ start, end });
  const index = buildLevantaIndex(reports);
  const total = saveLevantaCatalog(index);
  console.log(`Levanta link catalog: ${index.size} link(s) seen in ${start}..${end}, ${total} known in total -> ${CATALOG_FILE}`);
  return { seen: index.size, total };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runMain(main);
