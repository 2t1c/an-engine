// harvest-classify.mjs — is this performed cover a NEW body, or another run of one we already hold?
//
// The farm's induction rule was "anything that crosses the gate and is not a re-run of one of OUR
// drafts becomes its own body". That is right for a genuinely new shape and wrong for the case the
// fleet actually produces most: two accounts cover the SAME donor thread, both cross, and the pool
// gets two rows for one body. Each row then audits alone, on its own 7 hearts, needing its own 2
// performs — so a body that performed once under Rafael and once under Clara reads as two bodies
// that each performed once, and neither is ever seed-eligible. The pool fragments exactly where it
// is working (operator, 2026-09-16: "lots of performed Covers → identical Harvest but separated in
// pool since they aren't recognized").
//
// Live example, found by this file on the 45-row pool: "A heart doctor once admitted:" and "A Heart
// doctor admitted:" are two rows from ONE donor (x.com/longevitycode_/status/2092948651765293329)
// holding 11 spent hearts between them and 0 performs each.
//
// TWO SIGNALS, AND THEY ARE NOT EQUALS:
//   source  the ledger's donor sourceUrl. Two covers of one donor thread ARE one body wearing two
//           sets of words; this is definitional, not a guess, so it auto-links.
//   hook    similarity of the registry's Post field. That field is ~50 characters — a truncated
//           HOOK, not the thread — so it can say "these open the same way" and cannot say "these
//           are the same thread". "A neurologist shocked me when he said:" and "A cardiologist
//           shocked me when he said" score 0.75 on it and may well be different threads. It
//           REPORTS; the operator merges with --merge. Never auto-link on a hook alone.
//
//   node harvest-classify.mjs            # the fragmentation report over the live pool
//   node harvest-classify.mjs --json
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, loadLedger, runMain } from './lib.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { LAWS } from './laws.mjs';

const JSON_OUT = process.argv.includes('--json');
const MERGE_DONORS = process.argv.includes('--merge-donors');
/** `--merge recA+recB[+recC]`, repeatable — the operator confirming a cluster the hooks only proposed. */
const MERGES = process.argv.reduce((out, a, i, all) => (a === '--merge' ? [...out, String(all[i + 1] || '').split('+').filter(Boolean)] : out), []);
const WRITE = MERGE_DONORS || MERGES.length;

/** Donor identity. Two links to one thread differ by tracking params, host and trailing slash. */
export function normalizeSource(url) {
  if (!url) return null;
  const raw = String(url).trim();
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').replace(/^(mobile|m)\./, '').replace(/^twitter\.com$/, 'x.com');
    return `${host === 'twitter.com' ? 'x.com' : host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return raw.split('?')[0].replace(/\/+$/, '').toLowerCase() || null;
  }
}

/**
 * The comparable form of a hook. Strips the things that differ BETWEEN accounts running one body
 * and keeps the things that differ between bodies: the account byline the registry prefixes
 * ("Clara Brooks — ..."), bracket markers ([Recreate 5-plug], [Pot·peach]), links, and punctuation.
 */
export function normalizeHook(text) {
  return String(text || '')
    .split('\n')[0]
    .replace(/\[[^\]]*\]/g, ' ')                       // [Recreate 5-plug], [Pot·peach], [CTA]
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[^—\-:]{0,28}\s[—–-]\s/, ' ')           // a leading "Account Name — " byline
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The creator a donor link belongs to, lowercased, or null. The SECOND half of donor identity:
 *  a creator who reposts their own winner gets a new tweet id for the same thread, so the URL says
 *  "different donor" about two reads of one thread. See laws.json farm.$repost. */
export function donorHandle(url) {
  const m = String(url || '').match(/(?:^|\/\/)(?:[^/]*\.)?(?:x|twitter)\.com\/(?!i\/|home|search|hashtag)([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Is this pair the SAME donor thread, posted twice by its own author? Handle plus a near-verbatim
 *  hook. Both halves are load-bearing: the hook alone cannot tell "A neurologist shocked me" from
 *  "A cardiologist shocked me" (0.75, different creators, different threads), and the handle alone
 *  groups everything one prolific creator ever wrote. Together they are as definitional as the URL.
 *  Threshold from laws.json, measured — see farm.$repost. */
export function isRepost(a, b, { repostHookMin = LAWS.farm?.repostHookMin ?? 0.85 } = {}) {
  const ha = donorHandle(a?.sourceUrl), hb = donorHandle(b?.sourceUrl);
  if (!ha || !hb || ha !== hb) return false;
  if (normalizeSource(a?.sourceUrl) === normalizeSource(b?.sourceUrl)) return false; // that is `source`
  return hookAffinity(a?.post, b?.post) >= repostHookMin;
}

/** Two tokens are the same word if they match, or differ by one edit and are long enough for that
 *  to be a spelling variant rather than a different word (aging/ageing, cancelled/canceled). */
export function sameToken(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * How alike two hooks are, 0..1. The max of two views, because a truncated field breaks each one
 * differently: the shared OPENING RUN (which survives truncation and is what a reader sees), and
 * the shared VOCABULARY (which survives reordering). Symmetric.
 */
export function hookAffinity(a, b) {
  const A = normalizeHook(a).split(' ').filter(Boolean);
  const B = normalizeHook(b).split(' ').filter(Boolean);
  if (!A.length || !B.length) return 0;
  let run = 0;
  while (run < A.length && run < B.length && sameToken(A[run], B[run])) run++;
  const prefix = run / Math.min(A.length, B.length);
  const pool = [...B];
  let shared = 0;
  for (const t of A) { const k = pool.findIndex((x) => sameToken(t, x)); if (k > -1) { pool.splice(k, 1); shared++; } }
  const jaccard = shared / (A.length + B.length - shared);
  return Math.max(prefix, jaccard);
}

/**
 * Does this candidate belong to a body already in the pool?
 *
 *   cand    { draftId, post, sourceUrl }
 *   bodies  [{ id, draftId, post, sourceUrl, status }]
 * Returns the best candidate match with the signal that found it. `confident` is the only thing
 * callers may act on unattended, and only `source` ever earns it.
 */
export function classifyCover(cand, bodies = [], opts = {}) {
  if (cand.variationOf) return { match: null, via: null, score: 0, confident: false, why: 'explicit rewritten body: donor provenance does not establish verbatim identity' };
  const { hookReportMin = 0.6 } = opts;
  const src = normalizeSource(cand.sourceUrl);
  const pool = bodies.filter((b) => !b.variationOf && String(b.draftId) !== String(cand.draftId));
  if (src) {
    const hit = pool.find((b) => normalizeSource(b.sourceUrl) === src);
    if (hit) return { match: hit, via: 'source', score: 1, confident: true, why: `same donor thread (${src})` };
  }
  // THE CREATOR'S OWN REPOST (2026-09-18, operator). A donor who reposts their winner gets a new
  // tweet id, so `source` reads one thread as two and the covers of it fragment into two bodies
  // that each audit alone. Handle + near-verbatim hook is the same fact the URL states, said a
  // different way, so it links unattended like `source` does. See laws.json farm.$repost.
  const rep = pool
    .filter((b) => isRepost(cand, b, opts))
    .sort((x, y) => hookAffinity(cand.post, y.post) - hookAffinity(cand.post, x.post))[0];
  if (rep) {
    return { match: rep, via: 'repost', score: hookAffinity(cand.post, rep.post), confident: true,
      why: `@${donorHandle(cand.sourceUrl)} posted this thread twice — same creator, hooks ${Math.round(hookAffinity(cand.post, rep.post) * 100)}% alike` };
  }
  let best = null;
  for (const b of pool) {
    const score = hookAffinity(cand.post, b.post);
    if (!best || score > best.score) best = { match: b, via: 'hook', score, confident: false, why: `hooks ${Math.round(score * 100)}% alike — the Post field is a truncated hook, so this needs a human` };
  }
  return best && best.score >= hookReportMin ? best : { match: null, via: null, score: best?.score ?? 0, confident: false, why: 'no body in the pool looks like this one' };
}

/** Every group of pool rows that is really one body. Source clusters are facts; hook clusters are
 *  proposals. Ordered so the biggest waste (most hearts spread over most rows) reads first. */
export function poolClusters(bodies = [], opts = {}) {
  const { hookReportMin = 0.6 } = opts;
  const out = [];
  const bySource = new Map();
  for (const b of bodies) {
    if (b.variationOf) continue;
    const s = normalizeSource(b.sourceUrl);
    if (!s) continue;
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(b);
  }
  const claimed = new Set();
  for (const [source, rows] of bySource) {
    if (rows.length < 2) continue;
    rows.forEach((r) => claimed.add(r.id));
    out.push({ via: 'source', key: source, rows });
  }
  // Then the same creator's own reposts — one thread under two tweet ids. Grouped per handle so a
  // creator who reposted the same winner three times lands in ONE cluster rather than three pairs.
  const byHandle = new Map();
  for (const b of bodies) {
    if (b.variationOf) continue;
    const h = donorHandle(b.sourceUrl);
    if (!h || claimed.has(b.id)) continue;
    if (!byHandle.has(h)) byHandle.set(h, []);
    byHandle.get(h).push(b);
  }
  for (const [h, list] of byHandle) {
    if (list.length < 2) continue;
    const seen = new Set();
    for (const a of list) {
      if (seen.has(a.id)) continue;
      const kin = list.filter((b) => b.id !== a.id && !seen.has(b.id) && isRepost(a, b, opts));
      if (!kin.length) continue;
      const rows = [a, ...kin];
      rows.forEach((r) => { seen.add(r.id); claimed.add(r.id); });
      out.push({ via: 'repost', key: h, rows });
    }
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (claimed.has(a.id) && claimed.has(b.id)) continue;
      const score = hookAffinity(a.post, b.post);
      if (score >= hookReportMin) out.push({ via: 'hook', key: Number(score.toFixed(3)), rows: [a, b] });
    }
  }
  const weight = (c) => c.rows.reduce((n, r) => n + (r.hearts || 0), 0) + c.rows.length;
  const tier = (c) => (c.via === 'source' ? 0 : c.via === 'repost' ? 1 : 2);
  return out.sort((x, y) => (tier(x) === tier(y) ? weight(y) - weight(x) : tier(x) - tier(y)));
}

/**
 * Which row of a cluster survives, and what the merge does to the others. PURE.
 *
 * The survivor is the row carrying the most EVIDENCE, not the oldest or the biggest: performs
 * first (a body that has proven itself twice is the one a seed will be minted from), then hearts
 * spent, then settled commission. The absorbed rows hand over their attempts — that is the whole
 * point, since a heart spent on either row was spent on the same body — and are Retired so the
 * pool stops auditing one body twice.
 *
 * A row the OPERATOR owns (Seeded, Evergreen) is never absorbed and never silently retired. If a
 * cluster contains one, the merge is refused and reported: what a re-run means for a seed they
 * already minted is their call, not a script's.
 */
export function planMerge(rows = []) {
  const OPERATOR_OWNED = new Set(['Seeded', 'Evergreen']);
  if (rows.length < 2) return { ok: false, reason: 'a merge needs at least two rows' };
  const owned = rows.filter((r) => OPERATOR_OWNED.has(r.status));
  if (owned.length) return { ok: false, reason: `cluster contains a row the operator owns (${owned.map((r) => `${r.status}: ${String(r.post).slice(0, 32)}`).join(', ')}) — merging is their call`, rows };
  const rank = (r) => [r.performs || 0, r.hearts || 0, Number(r.commission) || 0];
  const survivor = [...rows].sort((a, b) => { const x = rank(a), y = rank(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; })[0];
  const absorbed = rows.filter((r) => r.id !== survivor.id);
  return { ok: true, survivor, absorbed,
    hearts: rows.reduce((n, r) => n + (r.hearts || 0), 0), performs: rows.reduce((n, r) => n + (r.performs || 0), 0) };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID']);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const harvests = await at.listAll('Harvests');
  const rows = await at.listAll(REGISTRY_TABLE, { fields: ['Draft ID', 'Post'] });
  const postOf = new Map(rows.map((r) => [String(r.fields['Draft ID'] || ''), String(r.fields.Post || '')]));
  const { byDraft } = loadLedger();
  const bodies = harvests.map((h) => {
    const draftId = String(h.fields['Origin Draft ID'] || '');
    return { id: h.id, draftId, post: postOf.get(draftId) || h.fields.Body || '', variationOf: byDraft.get(draftId)?.variationOf || null, sourceUrl: byDraft.get(draftId)?.sourceUrl || null,
      status: h.fields.Status, tier: h.fields.Tier, account: h.fields['Origin Account'], hearts: h.fields['Hearts Used'] || 0,
      performs: h.fields.Performs || 0, commission: h.fields['Origin Commission'] || 0 };
  });
  // A Retired row is a body the pool has already finished with — usually because a merge absorbed
  // it. Reporting it as fragmentation would re-propose a consolidation that has already happened.
  const clusters = poolClusters(bodies.filter((b) => !['Retired', 'Expired'].includes(b.status)));
  if (JSON_OUT) { console.log(JSON.stringify({ bodies: bodies.length, clusters }, null, 1)); return { clusters }; }

  console.log(`HARVEST FRAGMENTATION — ${bodies.length} bodies, ${clusters.length} cluster(s) that may be one body each\n`);
  for (const c of clusters) {
    const hearts = c.rows.reduce((n, r) => n + r.hearts, 0), performs = c.rows.reduce((n, r) => n + r.performs, 0);
    const LABEL = { source: 'SAME DONOR', repost: 'SAME CREATOR, REPOSTED', hook: 'HOOK MATCH' };
    const key = c.via === 'source' ? c.key : c.via === 'repost' ? `@${c.key}` : `${Math.round(c.key * 100)}% alike`;
    console.log(`${LABEL[c.via]}  ${key}`);
    console.log(`  ${c.rows.length} rows · ${hearts} hearts spent · ${performs} performs, which count SEPARATELY today`);
    for (const r of c.rows) console.log(`    ${String(r.status).padEnd(13)} ${String(r.tier).padEnd(9)} ♥${r.hearts} perf${r.performs}  $${Number(r.commission).toFixed(2).padStart(8)}  ${String(r.account).padEnd(15)} ${String(r.post).split('\n')[0].slice(0, 42)}`);
    const VERDICT = {
      source: '  → merging is a fact, not a judgement: one donor, one body\n',
      repost: '  → one thread the creator posted twice; --merge-donors links it, same as a shared URL\n',
      hook:   '  → hooks only; the Post field cannot prove the threads match. Operator decides.\n',
    };
    console.log(VERDICT[c.via]);
  }
  if (!clusters.length) console.log('No fragmentation found.');

  if (!WRITE) { console.log('To consolidate: --merge-donors (same donor, and the creator\'s own reposts) or --merge <recA>+<recB> for a hook cluster you have confirmed.'); return { clusters }; }

  // ---- consolidation -------------------------------------------------------------------------
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const chosen = MERGE_DONORS ? clusters.filter((c) => c.via === 'source' || c.via === 'repost').map((c) => c.rows) : [];
  for (const ids of MERGES) {
    const rows = ids.map((id) => byId.get(id));
    if (rows.some((r) => !r)) { console.log(`\n✗ --merge ${ids.join('+')}: unknown record id`); process.exitCode = 1; continue; }
    chosen.push(rows);
  }
  const attempts = await at.listAll(REGISTRY_TABLE, { fields: ['Draft ID', 'Harvest'] });
  console.log(`\nCONSOLIDATING ${chosen.length} cluster(s)\n`);
  for (const rows of chosen) {
    const plan = planMerge(rows);
    if (!plan.ok) { console.log(`✗ refused: ${plan.reason}`); process.exitCode = 1; continue; }
    const { survivor, absorbed } = plan;
    console.log(`  KEEP    ${String(survivor.post).split('\n')[0].slice(0, 44)}  (♥${survivor.hearts} perf${survivor.performs}, $${Number(survivor.commission).toFixed(2)})`);
    // Every attempt on an absorbed row moves to the survivor: the heart was spent on this body.
    const moved = [];
    for (const dead of absorbed) {
      console.log(`  ABSORB  ${String(dead.post).split('\n')[0].slice(0, 44)}  (♥${dead.hearts} perf${dead.performs}) -> Retired`);
      for (const a of attempts) {
        const links = a.fields.Harvest || [];
        if (!links.includes(dead.id)) continue;
        moved.push({ 'Draft ID': String(a.fields['Draft ID'] || ''), Harvest: [...new Set([...links.filter((x) => x !== dead.id), survivor.id])] });
      }
    }
    if (moved.length) await at.upsert(REGISTRY_TABLE, 'Draft ID', moved);
    await at.update('Harvests', absorbed.map((d) => ({ id: d.id, fields: { Status: 'Retired' } })));
    console.log(`  → ${moved.length} attempt(s) moved, ${absorbed.length} row(s) retired, body now holds ${plan.hearts} heart(s) and ${plan.performs} perform(s)\n`);
  }
  return { clusters };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runMain(main);
