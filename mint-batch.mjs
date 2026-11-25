// mint-batch.mjs — mint MANY tracked Levanta links in one runner job.
//
// mint-link.mjs mints exactly one, which is correct for a one-off but pathological for a refit:
// reworking 13 threads means ~26 links, and each one costs a workflow dispatch plus two API round
// trips to read the URL back out of the job log. That is the bottleneck in a product refit, not the
// writing. This takes a JSON array and prints every result in one block.
//
//   node mint-batch.mjs --jobs '[{"asin":"B01","subid":"x-thread-..."},{"asin":"B02","subid":"..."}]'
//
// Output is one MINTED line per job, in input order, plus a FAILED line for any that error — a bad
// ASIN must never abort the rest of the batch, or one typo costs the whole run.
// SIBLING SUGGESTIONS (operator 2026-08-25). When a listing 404s the substance is still the right
// answer — only that bottle is gone. Before this, a 404 read as a dead end and the recovery was to
// swap the SUBSTANCE, which is how a nitric-oxide thread shipped selling magnesium.
//
// This SUGGESTS live same-substance listings; it deliberately does NOT auto-substitute. The first
// draft of this did, and it was worse than the bug: matching on shared substance vocabulary offered
// magnesium OXIDE as the sibling for magnesium glycinate — the exact form our own pod copy tells the
// reader to avoid — and a protein powder for beet root. A wrong bottle minted silently is far more
// expensive than a failure that names the alternatives and lets the writer pick.
//
// Candidates must pass podFitsProduct against the SAME pod the dead listing was selling under, so
// the pod's criterion stays true of whatever gets chosen. No pod, no suggestion.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, levanta, HERE_DIR } from './lib.mjs';
import { PODS, podFitsProduct } from './pods.mjs';
import { DENY_ASINS } from './checks.mjs';
import { appendLedgerEventSync, stateOperationKey } from './state/ledger-store.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const raw = arg('jobs');
if (!raw) { console.error('usage: node mint-batch.mjs --jobs \'[{"asin":"...","subid":"..."}]\''); process.exit(1); }

let jobs;
try { jobs = JSON.parse(raw); } catch (e) { console.error('jobs is not valid JSON:', e.message); process.exit(1); }
if (!Array.isArray(jobs) || !jobs.length) { console.error('jobs must be a non-empty array'); process.exit(1); }
// THE CHOKEPOINT — see mint-link.mjs for the full reasoning. Refused UP FRONT, before a single link
// is created, so a batch carrying one denied ASIN does not half-mint and leave the caller to work
// out which rows landed. --force is deliberate and has to be typed.
const denied = jobs.map((j) => j?.asin).filter((a) => a && DENY_ASINS.has(a));
if (denied.length && !process.argv.includes('--force')) {
  console.error(`REFUSED\t${[...new Set(denied)].join(', ')}\ton the DENY list in keep-asins.json — nothing minted; pass --force to override`);
  process.exit(1);
}

const env = loadEnv();
if (!env.LEVANTA_API_KEY) { console.error('LEVANTA_API_KEY missing'); process.exit(1); }
const lev = levanta(env);

// Live catalog only: retired rows are retired because they do not mint, so suggesting them is noise.
let CATALOG = [];
try { CATALOG = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || []; } catch {}
const siblingsOf = (asin) => {
  const self = CATALOG.find((p) => p.asin === asin);
  if (!self) return [];
  // Every non-retired pod this bottle could have been selling under. A candidate has to fit the same
  // pod, which means same substance AND every declared buy-form — that is what keeps the criterion
  // ("look for glycinate, oxide passes through") true of the replacement.
  const pods = PODS.filter((pod) => pod.status !== 'retired' && podFitsProduct(pod, self));
  if (!pods.length) return [];
  // podFitsProduct alone is still too generous where a pod declares no buy-form: a protein powder
  // listing beet among its superfoods "fits" the beet pod, and the NAD rows fit the CoQ10 pod
  // because NAD vocabulary was rerouted onto the ubiquinol ASIN. So the candidate's title must also
  // NAME the pod's substance, and a title that names it up front (where a product says what it is)
  // outranks one that mentions it deep in an ingredient list.
  const out = [];
  for (const p of CATALOG) {
    if (p.asin === asin) continue;
    const title = String(p.title || '').toLowerCase();
    const pod = pods.find((x) => podFitsProduct(x, p) && title.includes(String(x.substance || '').toLowerCase()));
    if (!pod) continue;
    const upFront = title.indexOf(String(pod.substance).toLowerCase()) < 60 ? 0 : 1;
    out.push({ ...p, pod: pod.id, upFront });
  }
  return out.sort((a, b) => a.upFront - b.upFront || Number(b.commission || 0) - Number(a.commission || 0));
};

const record = (asin, subid, url, note) => {
  console.log(`MINTED\t${asin}\t${subid}\t${url}`);
  appendLedgerEventSync(join(HERE_DIR, 'ledger.jsonl'),
    { ts: new Date().toISOString(), mode: 'mint', asin, subid1: subid, link: url, note },
    { operationKey: stateOperationKey('link:mint', ['levanta', subid, asin]),
      source: 'mint-batch', runId: process.env.GITHUB_RUN_ID || null });
};
const urlOf = (res) => res.mobileOptimizedUrl || res.mobile_optimized_url || res.shortUrl || res.short_url || res.url;

let failures = 0;
for (const [i, j] of jobs.entries()) {
  const asin = String(j.asin || '').trim();
  const subid = String(j.subid || '').trim();
  if (!asin || !subid) { console.log(`FAILED\t${i}\t${asin || '?'}\t${subid || '?'}\tmissing asin or subid`); failures++; continue; }
  let firstErr = '';
  try {
    const res = await lev.mintLink(asin, subid);
    // Same rail preference as mint-link.mjs: the lvnta.com redirect, never the raw Amazon URL.
    const url = urlOf(res);
    if (url) { record(asin, subid, url, 'hand mint (mint-batch workflow)'); continue; }
    firstErr = 'no url in response';
  } catch (e) { firstErr = String(e.message || e).slice(0, 160); }
  // The bottle is gone, the substance is not. Name the listings that could carry the same copy.
  console.log(`FAILED\t${i}\t${asin}\t${subid}\t${firstErr}`);
  const sibs = siblingsOf(asin);
  if (sibs.length) {
    console.log(`  KEEP THE SUBSTANCE — ${sibs.length} live listing(s) fit the same pod. Re-run this subid against one of:`);
    for (const sib of sibs.slice(0, 5)) console.log(`    ${sib.asin}  ${String(Number(sib.commission || 0) * 100).slice(0, 4)}%  pod ${sib.pod}  ${String(sib.title || '').slice(0, 62)}`);
  } else {
    console.log('  No live listing fits this pod. Do NOT swap the substance — re-place the plug or drop it, and say so.');
  }
  failures++;
}
console.log(`\nBATCH DONE — ${jobs.length - failures}/${jobs.length} minted`);
if (failures) process.exitCode = 1;
