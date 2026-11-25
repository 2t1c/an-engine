// seed-provenance.mjs — does every Seed's recorded origin describe ONE real, tracked post of ours?
//
// A Seed row carries two numbers, `Origin Views` and `Origin Commission`, and they are the whole
// argument for templatizing a body: this shape earned $X per 1k, so build children from it. Nothing
// checked that the pair described a single post, or any post at all — /seed-mint copies them from
// the Harvests row, and the HAND-INDUCTED path (the operator supplying a body directly) has no
// Harvests row to copy from, so the figures are typed in and the `Source Harvest` link is skipped.
//
// Audited 2026-09-16, and the discriminator turned out to be exactly that link:
//   - the five seeds WITH a Source Harvest all resolve to one post; their commission is merely the
//     mint-time snapshot, which settles on its own now that harvest-gate keeps origin figures live
//   - maple, no link: `Origin Views` is draft 10188373's and `Origin Commission` is draft 9582659's
//     — two different posts, so its $0.010/1k is a ratio between two threads and describes neither
//   - plum, no link: 2,332,780 views match NO post of ours, because the origin is a competitor's
//     thread (x.com/BeBetterMan_/status/2090434978278695303). $0.00 is not a stale number there,
//     it is the correct one — we never earned on someone else's post
// Between them those two seeds have fired 26 pots for 0 performs. The numbers that would have
// argued against minting them were never checkable.
//
//   node seed-provenance.mjs              # audit every seed, exit 1 if any cannot be resolved
//   node seed-provenance.mjs --json
//   node seed-provenance.mjs --fix        # link + correct every seed the evidence resolves
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain } from './lib.mjs';
import { REGISTRY_TABLE } from './config.mjs';

/** Worst first. The last two are clean; the first three each need a human to say which post. */
const SEVERITY = ['unsourced', 'split', 'mismatched', 'unlinked', 'stale', 'linked'];
const NEEDS_OPERATOR = ['unsourced', 'split', 'mismatched'];

const JSON_OUT = process.argv.includes('--json');
const FIX = process.argv.includes('--fix');

/**
 * `--adopt <seed>=<draftId>` — the operator naming an origin the evidence could not pick.
 *
 * split / mismatched / unsourced all mean the same thing: two or more posts are in play and
 * nothing in the data chooses between them. The auditor refuses to guess there, which leaves
 * exactly one way to resolve them, and it is not a hand edit in Airtable — it is this, so the
 * choice lands with the same link + settled-figure write every other seed gets, and re-running
 * the audit afterwards proves it took.
 */
export function parseAdoptions(argv = []) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--adopt') continue;
    const [seed, draftId] = String(argv[i + 1] || '').split('=');
    if (!seed || !/^\d+$/.test(String(draftId || ''))) throw new Error(`--adopt needs <seed>=<draftId>, got "${argv[i + 1]}"`);
    out.set(seed.toLowerCase(), String(draftId));
  }
  return out;
}
const ADOPT = parseAdoptions(process.argv);

/** Commission is stored to 2dp; views and clicks are integers. */
const money = (n) => Number(Number(n || 0).toFixed(2));

/**
 * One seed's provenance, resolved against the registry. PURE — every verdict below is argued from
 * the three tables alone, so the rules can be read and disputed offline.
 *
 *   rows      [{ draftId, account, views, commission, clicks, post }]  live registry figures
 *   harvests  raw Harvests records, for the Source Harvest -> Origin Draft ID hop
 *
 * Verdicts, worst first:
 *   unsourced  the recorded figures match no post of ours — the origin is external, or invented
 *   split      views and commission come from DIFFERENT posts, so the $/1k describes neither
 *   unlinked   one post explains both figures, but no Source Harvest records which
 *   stale      linked, and the settled figures have moved past the mint-time snapshot
 *   linked     linked, and current
 */
export function resolveSeedProvenance(seed, { harvests = [], rows = [] } = {}) {
  const f = seed.fields || {};
  const recorded = { views: Number(f['Origin Views'] || 0), commission: money(f['Origin Commission']) };
  const byDraft = new Map(rows.map((r) => [String(r.draftId), r]));
  const harvestById = new Map(harvests.map((h) => [h.id, h]));
  const link = (f['Source Harvest'] || [])[0] || null;
  const base = { name: String(f.Name || '?'), status: f.Status || '?', sourceHarvest: link, recorded };

  const exact = (pick, want) => rows.filter((r) => pick(r) === want && want > 0);
  const oneOf = (a) => (a.length === 1 ? a[0] : null);
  const byViews = oneOf(exact((r) => r.views, recorded.views));
  const byMoney = oneOf(exact((r) => money(r.commission), recorded.commission));

  if (link) {
    const h = harvestById.get(link);
    const origin = h ? byDraft.get(String(h.fields['Origin Draft ID'] || '')) : null;
    // A link pointing at a Harvests row we cannot resolve is worse than no link: it LOOKS checked.
    if (!origin) return { ...base, origin: null, verdict: 'unsourced', detail: 'Source Harvest resolves to no registry row' };
    // The link says one post; do the FIGURES say the same one? Views settle within days, so a
    // recorded view count that exactly matches some OTHER post is not lag, it is a different post.
    if (byViews && String(byViews.draftId) !== String(origin.draftId)) {
      return { ...base, origin: summarize(origin), verdict: 'mismatched', otherCandidate: summarize(byViews),
        detail: `linked to draft ${origin.draftId} but the recorded figures are draft ${byViews.draftId}'s — two posts, and only the operator knows which is the origin` };
    }
    const moved = origin.commission > recorded.commission + 0.005 || origin.views > recorded.views;
    return { ...base, origin: summarize(origin), verdict: moved ? 'stale' : 'linked',
      detail: moved ? `settled figures moved past the mint snapshot (+$${money(origin.commission - recorded.commission)})` : 'current' };
  }

  // No link: the figures have to identify the post by themselves.
  if (byViews && byMoney && String(byViews.draftId) === String(byMoney.draftId)) return { ...base, origin: summarize(byViews), verdict: 'unlinked', detail: 'both figures identify one post; only the Source Harvest link is missing' };
  if (byViews && byMoney) return { ...base, origin: summarize(byViews), verdict: 'split', otherCandidate: summarize(byMoney),
    detail: `views are draft ${byViews.draftId}'s and commission is draft ${byMoney.draftId}'s — the $/1k is a ratio between two threads and describes neither` };
  if (byViews) return { ...base, origin: summarize(byViews), verdict: 'unlinked', detail: `views identify draft ${byViews.draftId}; its commission has since settled past the recorded figure` };
  return { ...base, origin: null, verdict: 'unsourced', detail: 'no post of ours carries these figures — an external origin, or a number typed from nowhere' };
}

const summarize = (r) => ({ draftId: String(r.draftId), account: r.account || '?', views: r.views || 0,
  commission: money(r.commission), clicks: r.clicks || 0,
  perK: r.views ? Number((r.commission / (r.views / 1000)).toFixed(3)) : 0, post: String(r.post || '').slice(0, 48) });

/**
 * The patch that makes a resolvable seed honest: the Source Harvest link that records WHICH post,
 * and the settled figures from it. Returns {} when nothing moves, so a clean base writes nothing.
 * A seed the evidence cannot resolve is never guessed at — it is reported and left alone.
 */
export function seedProvenancePatch(p, { harvests = [], adopt = new Map(), rows = [] } = {}) {
  // An operator-named origin outranks every verdict below: they know which post it was, and the
  // whole reason the verdict is unresolved is that the data does not. The figures still come from
  // the REGISTRY, never from the operator — they choose the post, the base supplies its numbers.
  const chosen = adopt.get(String(p.name).toLowerCase());
  if (chosen) {
    const r = rows.find((x) => String(x.draftId) === String(chosen));
    if (!r) throw new Error(`--adopt ${p.name}=${chosen}: no registry row for that draft`);
    return originFields(summarize(r), p, harvests);
  }
  // ONLY what a single post fully explains. `split` and `mismatched` each have TWO posts in play
  // and no evidence that picks between them — writing either side would replace a wrong number
  // with a differently wrong one, and the first cut of this file proposed exactly that for maple
  // ($63.63 -> $0.00, from a post that is not its commission's source). Those are reported.
  if (!p.origin || !['stale', 'unlinked'].includes(p.verdict)) return {};
  return originFields(p.origin, p, harvests);
}

/** The write that makes a row say `origin`: its settled figures, and the link that records which
 *  post they came from. Only fields that actually move, so a correct row plans nothing. */
function originFields(origin, p, harvests) {
  const fields = {};
  if (origin.views !== p.recorded.views) fields['Origin Views'] = origin.views;
  if (origin.commission !== p.recorded.commission) fields['Origin Commission'] = origin.commission;
  const h = harvests.find((x) => String(x.fields['Origin Draft ID'] || '') === String(origin.draftId));
  if (h && h.id !== p.sourceHarvest) fields['Source Harvest'] = [h.id];
  return fields;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const seeds = await at.listAll('Seeds');
  const harvests = await at.listAll('Harvests');
  const rows = (await at.listAll(REGISTRY_TABLE, { fields: ['Draft ID', 'Post', 'Account', 'Impressions', 'Lifetime Commission', 'Lifetime Clicks'] }))
    .map((r) => ({ draftId: String(r.fields['Draft ID'] || ''), account: r.fields.Account || '', views: r.fields.Impressions || 0,
      commission: r.fields['Lifetime Commission'] || 0, clicks: r.fields['Lifetime Clicks'] || 0, post: String(r.fields.Post || '').split('\n')[0] }))
    .filter((r) => r.draftId);

  const audit = seeds.map((s) => resolveSeedProvenance(s, { harvests, rows }))
    .sort((a, b) => SEVERITY.indexOf(a.verdict) - SEVERITY.indexOf(b.verdict));
  const patches = seeds.map((s) => ({ id: s.id, p: resolveSeedProvenance(s, { harvests, rows }) }))
    .map(({ id, p }) => ({ id, name: p.name, fields: seedProvenancePatch(p, { harvests, adopt: ADOPT, rows }) }))
    .filter((x) => Object.keys(x.fields).length);

  if (JSON_OUT) { console.log(JSON.stringify({ audit, patches }, null, 1)); return { audit, patches }; }

  console.log(`SEED PROVENANCE — ${audit.length} seed(s)\n`);
  for (const p of audit) {
    const o = p.origin;
    console.log(`  ${p.verdict.toUpperCase().padEnd(10)} ${p.name.padEnd(8)} ${String(p.status).padEnd(9)} recorded ${String(p.recorded.views).padStart(9)} views · $${p.recorded.commission.toFixed(2).padStart(8)}`);
    console.log(`             ${o ? `origin draft ${o.draftId} (${o.account}) ${String(o.views).padStart(9)} views · $${o.commission.toFixed(2).padStart(8)} · ${o.clicks} clicks · $${o.perK}/1k` : 'origin UNRESOLVED'}`);
    console.log(`             ${p.detail}\n`);
  }
  const unresolved = audit.filter((p) => NEEDS_OPERATOR.includes(p.verdict) && !ADOPT.has(p.name.toLowerCase()));
  if (patches.length) {
    console.log(`${FIX ? 'WRITING' : 'WOULD WRITE'} ${patches.length} correction(s):`);
    for (const x of patches) console.log(`  ${x.name.padEnd(8)} ${JSON.stringify(x.fields)}`);
    if (FIX) { await at.update('Seeds', patches.map((x) => ({ id: x.id, fields: x.fields }))); console.log('✓ written'); }
    else console.log('(re-run with --fix to write)');
  } else console.log('No correction needed.');
  if (unresolved.length) {
    console.log(`\n⚠️  ${unresolved.length} seed(s) the evidence cannot resolve — operator decision, never guessed:`);
    for (const p of unresolved) console.log(`  ${p.name} [${p.verdict}]: ${p.detail}`);
    process.exitCode = 1;
  }
  return { audit, patches };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runMain(main);
