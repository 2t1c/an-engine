// pool-probe.mjs — "which bodies can I actually run today?", for the whole Harvest pool at once.
//
// WHY (2026-09-04). Picking harvest candidates by density alone wastes hearts: on the first day the
// farm spent any, 18 bodies had to be probed one at a time to find 4 shippable ones. Two things
// disqualify a body and NEITHER is visible in /farm: today's gates refuse it, or its plug links
// cannot be re-minted, which makes its 48h verdict unreadable. A run that allocates harvest slots
// from the density ranking alone will keep picking bodies it cannot ship.
//
// This probes every In Pool body through republish itself — the same code that will really send it,
// including any repair file harvest-repair.mjs has written — and caches the verdict.
//
//   node pool-probe.mjs                 # probe all, print the runnable set
//   node pool-probe.mjs --json          # machine-readable, for /run's allocation
//   node pool-probe.mjs --cached        # last results, no network
//   node pool-probe.mjs --pairs         # …and WHICH PAGE can host each body (offline, from the cache)
//   node pool-probe.mjs --pairs --pages tina,kim --cached
//
// A body is RUNNABLE only when the gate is clean AND every plug link re-mints. Anything else is
// reported with the reason, so the gap is visible rather than discovered a heart at a time.
//
// BODY × PAGE (2026-09-07, Run 2 rows 9). A runnable body is not runnable EVERYWHERE. Run 2 lost two
// mid-run swaps and three orphan Levanta links to the same discovery, made at write time: the pods
// its plugs need (Q1 CoQ10, E1) have no backline variant on rafael or lucas, so the ask cannot be
// pasted there and the body has to move to another page after its links are already minted. That
// question is answerable offline, for every pair at once, before a heart is allocated: the ledger
// says which products the body plugs, `selectPod` says which pod covers each, and `variantFor` says
// whether that pod can speak on that page. `pairFit` below is that check, and it costs nothing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, HERE_DIR, cliArg } from './lib.mjs';
import { LAWS } from './laws.mjs';
import { loadRepair, productsForDraft } from './harvest-repair.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { selectPod } from './outline.mjs';
import { variantFor, DEFAULT_POD_SYSTEM } from './pods.mjs';

const pExecFile = promisify(execFile);
const CACHE = join(HERE_DIR, 'queues', 'pool-probe.json');
const CONCURRENCY = 4;

// The Harvests table stores Origin Views and Origin Commission, not a rate — derive it, so the
// ranking here is the same $/1k the farm optimises rather than a missing field printed as "?".
const per1k = (row) => {
  const v = Number(row.fields['Origin Views'] || 0), c = Number(row.fields['Origin Commission'] || 0);
  return v > 0 ? Math.round((c / (v / 1000)) * 1000) / 1000 : null;
};

const ACCOUNT_KEY = (name) => String(name || '').trim().split(/\s+/)[0].toLowerCase();

// HEARTS LEFT IS A BUDGET, NOT A SUBTRACTION (2026-09-17). This was `7 - Hearts Used`, with the 7
// written in. Both halves were wrong the moment harvest-classify merged donor bodies: consolidation
// moves the donors' spent attempts onto the survivor, so an 11-attempt body against a 7-heart law
// printed "♥-4" — and the total is `laws.json farm.hearts`, which the operator can change without
// ever thinking about this file. The floor matters more than the constant: `lost` below SUMS this
// over the blocked set to report how many hearts are stranded, so one negative row silently
// CANCELLED a stranded heart somewhere else and under-reported the very number this probe exists
// to surface. Clamped, and read from the law.
export const heartsLeftOf = (row) => Math.max(0, (LAWS.farm?.hearts ?? 7) - (Number(row.fields['Hearts Used']) || 0));

export function parseProbe(out) {
  const remint = (out.match(/re-mintable:\s*(\d+)\/(\d+)/) || []).slice(1).map(Number);
  // Only lines AFTER the REFUSED banner are gate findings. republish also prints its own repair
  // notes with the same "· " prefix ("leadin-lift @3: ..."), and a first cut of this reported those
  // as refusal reasons — so a body that republish had just successfully repaired read as blocked.
  const lines = out.split('\n');
  const at = lines.findIndex((l) => /REFUSED/.test(l));
  const refusedLine = at < 0 ? '' : (lines.slice(at + 1).find((l) => l.trim().startsWith('· ')) || '').trim().slice(2);
  return {
    clean: /gates clean/.test(out),
    refused: /REFUSED/.test(out),
    reason: refusedLine || null,
    remintOk: remint.length === 2 ? remint[0] === remint[1] : null,
    remint: remint.length === 2 ? `${remint[0]}/${remint[1]}` : null,
  };
}

/** RUNNABLE = the gate passes AND attribution is whole. Both, or the heart is wasted. */
export const isRunnable = (p) => p.clean === true && p.remintOk !== false;

/** PURE-ish (reads pods.json through selectPod/variantFor, no network, no clock).
 *  Can THIS page paste an ask for every product this body plugs?
 *  products — [{ asin, title }] from the body's ledger row.
 *  Returns { ok, plugs: [{ asin, pod, ok, why }] }. A body with no products in the ledger is
 *  `ok: null`: unknown is not the same as fine, and the caller says so rather than allocating it. */
export function pairFit(products = [], pageKey, { system = DEFAULT_POD_SYSTEM } = {}) {
  if (!products.length) return { ok: null, plugs: [], why: 'no ledger row for the origin draft — products unknown' };
  const plugs = products.map((p) => {
    let pod = null;
    try { ({ pod } = selectPod(p, { account: pageKey })); } catch { pod = null; }
    if (!pod) return { asin: p.asin, pod: null, ok: false, why: `no pod covers ${p.asin}` };
    const v = variantFor(pod, pageKey, { system });
    return { asin: p.asin, pod: pod.id, ok: !!v, why: v ? null : `pod ${pod.id} has no ${system} variant for ${pageKey}` };
  });
  return { ok: plugs.every((x) => x.ok), plugs, why: plugs.find((x) => !x.ok)?.why || null };
}

/** Every (runnable body × page) pair, with the reason a pair is refused. `pages` defaults to the
 *  monetized fleet. The origin page is included: a body usually re-runs on its own page. */
export function pairMatrix(results = [], pages = null, { system = DEFAULT_POD_SYSTEM, productsFor = productsForDraft } = {}) {
  const keys = pages && pages.length ? pages
    : Object.entries(ACCOUNTS).filter(([k, a]) => a.socialSetId && !a.paused && a.levantaSubidPrefix && k !== 'burner').map(([k]) => k);
  return results.filter(isRunnable).map((r) => {
    const products = productsFor(r.draftId);
    const fits = keys.map((k) => ({ page: k, ...pairFit(products, k, { system }) }));
    return { rec: r.rec, draftId: r.draftId, body: r.body, perK: r.perK, heartsLeft: r.heartsLeft, origin: ACCOUNT_KEY(r.account),
      products: products.map((p) => p.asin), pages: fits, runnableOn: fits.filter((f) => f.ok === true).map((f) => f.page),
      unknown: fits.some((f) => f.ok === null) };
  });
}

async function probeOne(row) {
  const draftId = String(row.fields['Origin Draft ID'] || '');
  const key = ACCOUNT_KEY(row.fields['Origin Account']);
  const base = {
    rec: row.id, draftId, account: row.fields['Origin Account'], perK: per1k(row),
    body: String(row.fields.Body || '').slice(0, 46), heartsLeft: heartsLeftOf(row),
    repaired: !!loadRepair(row.id),
  };
  if (!draftId || !key) return { ...base, clean: false, reason: 'no origin draft or account', remint: null, remintOk: null };
  try {
    const { stdout } = await pExecFile('node', [join(HERE_DIR, 'republish.mjs'), draftId,
      '--account', key, '--from', key, '--harvest', row.id, '--gate-only'], { encoding: 'utf8', timeout: 200000 });
    return { ...base, ...parseProbe(stdout) };
  } catch (e) {
    return { ...base, ...parseProbe((e.stdout || '') + (e.stderr || '')) };
  }
}

async function main() {
  const JSON_OUT = process.argv.includes('--json');
  const CACHED = process.argv.includes('--cached');

  if (CACHED) {
    if (!existsSync(CACHE)) throw new Error('no cache yet — run without --cached first');
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    return report(c.probedAt, c.results, JSON_OUT);
  }

  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY', 'REGISTRY_BASE_ID']);
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const pool = (await at.listAll('Harvests', {})).filter((r) => (r.fields.Status || '') === 'In Pool');

  const results = [];
  for (let i = 0; i < pool.length; i += CONCURRENCY) {
    results.push(...await Promise.all(pool.slice(i, i + CONCURRENCY).map(probeOne)));
    if (!JSON_OUT) process.stderr.write(`  probed ${Math.min(i + CONCURRENCY, pool.length)}/${pool.length}\r`);
  }
  const probedAt = new Date().toISOString();
  writeFileSync(CACHE, JSON.stringify({ probedAt, results }, null, 1) + '\n');
  report(probedAt, results, JSON_OUT);
}

// JEV READINESS (2026-09-23, owner: prepare the harvest between runs). scripts/pool-prep.mjs reads every
// body with the drafts-stop Jev read; its verdict rides along here so the allocation sees "ready" versus
// "light edit T12" before a heart is spent. Absent or unreadable cache: no tag, never "ready".
export function prepTag(prep, rec) {
  const b = (prep?.bodies || []).find((x) => x.id === rec);
  if (!b) return 'jev: not prepared';
  return `jev: ${b.readiness}${b.tweets?.length ? ` T${b.tweets.join(' T')}` : ''}`;
}
const PREP = join(HERE_DIR, 'queues', 'pool-prep.json');
const loadPrep = () => { try { return existsSync(PREP) ? JSON.parse(readFileSync(PREP, 'utf8')) : null; } catch { return null; } };

function report(probedAt, results, JSON_OUT) {
  const prep = loadPrep();
  for (const r of results) r.jev = prepTag(prep, r.rec);
  const runnable = results.filter(isRunnable).sort((a, b) => (b.perK || 0) - (a.perK || 0));
  const blocked = results.filter((r) => !isRunnable(r)).sort((a, b) => (b.perK || 0) - (a.perK || 0));
  const PAIRS = process.argv.includes('--pairs');
  const pages = (cliArg('pages', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const pairs = PAIRS ? pairMatrix(results, pages) : null;
  if (JSON_OUT) return console.log(JSON.stringify({ probedAt, runnable, blocked, ...(pairs ? { pairs } : {}) }, null, 1));

  console.log(`\nPOOL PROBE — ${probedAt.slice(0, 16)}Z · ${runnable.length} runnable of ${results.length}\n`);
  console.log('RUNNABLE  (gate clean + every plug link re-mints) — spend hearts here, densest first');
  for (const r of runnable) {
    console.log(`  $${String(r.perK ?? '?').padEnd(6)} ${String(r.remint || '-').padEnd(5)} ♥${r.heartsLeft}  ${r.repaired ? 'REPAIRED ' : '         '}${r.body}  · ${r.jev}`);
  }
  console.log('\nBLOCKED');
  for (const r of blocked) {
    const why = r.remintOk === false ? `attribution ${r.remint}` : (r.reason || 'gate refused').slice(0, 72);
    console.log(`  $${String(r.perK ?? '?').padEnd(6)} ${String(r.remint || '-').padEnd(5)} ♥${r.heartsLeft}  ${r.body}\n           ${why}`);
  }
  const lost = blocked.reduce((n, r) => n + r.heartsLeft, 0);
  // NAME THE BINDING CONSTRAINT, don't assume it. This line read "attribution needs the ledger" as
  // a standing fact; on 2026-09-17 link-resolve took that count from 8 to 0 and the advice became
  // false while still printing every run. The two blockers have different owners and different
  // costs, so the operator needs the split, measured, not a slogan.
  const dark = blocked.filter((r) => r.remintOk === false);
  console.log(`\n${lost} hearts sit on bodies that cannot ship: ${blocked.length - dark.length} gate-refused (harvest-repair.mjs fixes these), ${dark.length} attribution-broken${dark.length ? ' (link-resolve.mjs cannot name every plug — check the Levanta catalog is fresh)' : ''}.`);

  if (!pairs) return;
  console.log(`\nBODY × PAGE (${DEFAULT_POD_SYSTEM} pods) — allocate a harvest row only to a page listed here`);
  for (const p of pairs.sort((a, b) => (b.perK || 0) - (a.perK || 0))) {
    console.log(`  ${p.body}\n     origin ${p.origin} · ${p.products.join('+') || 'products unknown'} · runs on ${p.runnableOn.length}/${p.pages.length}: ${p.runnableOn.join(', ') || 'NOWHERE'}`);
    const refused = p.pages.filter((f) => f.ok !== true);
    for (const f of refused.slice(0, 4)) console.log(`     ✗ ${String(f.page).padEnd(10)} ${f.why || 'refused'}`);
    if (refused.length > 4) console.log(`     ✗ …and ${refused.length - 4} more page(s) for the same reason`);
  }
  const nowhere = pairs.filter((p) => !p.runnableOn.length);
  if (nowhere.length) console.log(`\n${nowhere.length} runnable body(ies) can be pasted on NO page — the pod library, not the body, is what blocks them.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
