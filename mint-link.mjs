// mint-link.mjs — mint ONE tracked Levanta link and print it. Exists because Levanta is
// egress-blocked from the agent sandbox (the proxy 502s on api.levanta.io), so a link that has to
// be created by hand can only be created on a runner. Everything else about a draft — Typefully,
// Airtable — is reachable from the sandbox; this is the single missing capability.
//   node mint-link.mjs --asin B07DX89ZHN --subid x-thread-clara-foods-abc123
import { join } from 'node:path';
import { loadEnv, levanta, HERE_DIR } from './lib.mjs';
import { DENY_ASINS } from './checks.mjs';
import { appendLedgerEventSync, stateOperationKey } from './state/ledger-store.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const asin = arg('asin');
const subid = arg('subid');
if (!asin || !subid) { console.error('usage: node mint-link.mjs --asin <ASIN> --subid <subid1>'); process.exit(1); }
// THE CHOKEPOINT. Every lane mints, so refusing here is the one guard nothing routes around: a
// denied ASIN with no link cannot become a plug. pick-product filters DENY when it CHOOSES a
// product, but the pod path, hand specs and repost re-mints arrive holding an ASIN already picked
// and never consulted the list — 32 plugs on 5 denied ASINs since 1 Aug 2026, 3,219 clicks at EPC
// $0.132 against a $0.348 fleet. --force exists for a deliberate one-off; it has to be typed.
if (DENY_ASINS.has(asin) && !process.argv.includes('--force')) {
  console.error(`REFUSED\t${asin}\ton the DENY list in keep-asins.json — pass --force to mint anyway`);
  process.exit(1);
}

const env = loadEnv();
if (!env.LEVANTA_API_KEY) { console.error('LEVANTA_API_KEY missing'); process.exit(1); }
const res = await levanta(env).mintLink(asin, subid);
// LEVANTA RAIL ONLY (operator 2026-08-18). Levanta returns two URLs for one link: `url` is the raw
// Amazon attribution link and `mobileOptimizedUrl` is the lvnta.com/lv_ redirect. Attribution is
// identical either way, but only the lvnta hop is counted by Levanta's own `clicks` metric — the
// direct rail reports through Amazon and lands on the dashboard 24-48h late. The operator reads that
// dashboard to steer, so a same-day number beats the one saved mobile tap. This used to prefer
// `url`, which quietly put every hand-minted link on the slow rail.
const url = res.mobileOptimizedUrl || res.mobile_optimized_url || res.shortUrl || res.short_url || res.url;
if (!url) { console.error('no url in response:', JSON.stringify(res)); process.exit(1); }
console.log(`MINTED\t${asin}\t${subid}\t${url}`);
// Every mint leaves a ledger row (audit 2026-08-24): a hand-minted link used to exist ONLY in the
// Actions console — once pasted into a draft by hand, its commission was permanently unjoinable.
// No draftId yet: loadLedger keeps it in `orphans`, reconcile shows it as minted-unattached (with
// age) until the thread's real row supersedes it via the subid.
const operationKey = stateOperationKey('link:mint', ['levanta', subid, asin]);
appendLedgerEventSync(join(HERE_DIR, 'ledger.jsonl'),
  { ts: new Date().toISOString(), mode: 'mint', asin, subid1: subid, link: url, note: 'hand mint (mint-link workflow)' },
  { operationKey, source: 'mint-link', runId: process.env.GITHUB_RUN_ID || null });
