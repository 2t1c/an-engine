// smoke-test.mjs — fast guardrail check before a batch. Proves the product-selection rules still hold
// (singles-only + thematic) offline, then runs the deterministic thread gate over the live scheduled
// drafts (CTA length, plug count/adjacency, numbering, disclosure, sign-off).
//   node smoke-test.mjs            # product rules + live drafts (next 72h)
//   node smoke-test.mjs --no-live  # product rules only (offline, no API)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, typefully, HERE_DIR } from './lib.mjs';
import { candidates } from './pick-product.mjs';
import { checkThread, isStack, DENY_ASINS, KEEP_ASINS } from './checks.mjs';
import { ACCOUNTS, getAccount } from './accounts.mjs';

const NO_LIVE = process.argv.includes('--no-live');
const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
const linkOf = (t) => (t.match(/https?:\/\/\S+/) || [''])[0];

const HOOKS = [
  'I fixed my 3am wakeups with one nightly habit',
  'High cortisol is aging you faster than junk food',
  'Early signs your heart is starting to fail',
  '5 things your gut is telling you about your health',
  'How I doubled my testosterone naturally at 40',
  'Your brain fog has one fixable cause',
  'Why your face is sagging years too early',
  'Lose belly fat this summer without cardio',
  'The signs you are insulin resistant',
];

console.log('=== PRODUCT SELECTION (singles-only + thematic) ===');
let pPass = 0, pFail = 0;
for (const h of HOOKS) {
  const c = candidates(h, products);
  const top = c[0];
  // Curated KEEP stacks (the 80%-class bets) are vetted and intentionally allowed via the singles-only
  // bypass — only a NON-curated stack leaking into the top 5 is a defect.
  const stackBad = (p) => isStack(p) && !KEEP_ASINS.has(p.asin);
  const stacksTop5 = c.slice(0, 5).filter(stackBad).length;
  const ok = top && !stackBad(top) && stacksTop5 === 0;
  console.log(`${ok ? '✅' : '❌'} ${h.slice(0, 38).padEnd(38)} -> ${(top?.title || 'NONE').slice(0, 42)}${stacksTop5 ? `  (⚠ ${stacksTop5} stacks in top5)` : ''}`);
  ok ? pPass++ : pFail++;
}
const deadLeak = HOOKS.some((h) => candidates(h, products).some((p) => DENY_ASINS.has(p.asin)));
console.log(`product rules: ${pPass} pass / ${pFail} fail · DENY list holding: ${deadLeak ? '❌ leaked' : '✅'}`);

if (NO_LIVE) process.exit(pFail ? 1 : 0);

console.log('\n=== LIVE DRAFTS — deterministic thread gate (next 72h) ===');
const env = loadEnv();
const tf = typefully(env);
const now = Date.now(), end = now + 72 * 36e5;
let dPass = 0, dViol = 0, drafts = 0;
for (const key of Object.keys(ACCOUNTS).filter((k) => k !== 'burner' && !ACCOUNTS[k].paused).slice(0, 3)) {
  const acc = getAccount(key);
  const j = await fetch(`https://api.typefully.com/v2/social-sets/${acc.socialSetId}/drafts?limit=50`, { headers: { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}` } }).then((r) => r.json());
  const sched = (j.results || []).filter((d) => d.scheduled_date && new Date(d.scheduled_date).getTime() >= now && new Date(d.scheduled_date).getTime() <= end && String(d.status).toLowerCase() !== 'published');
  for (const d of sched) {
    const full = await tf.getDraft(acc.socialSetId, d.id);
    const texts = full.platforms.x.posts.map((p) => p.text);
    const link = texts.map(linkOf).find((u) => /lvnta\.com|gumroad\.com/i.test(u)) || '';
    const issues = checkThread(texts, { account: acc, link, monetized: !!acc.plugHeavyExample }).filter((r) => r.severity === 'error');
    drafts++;
    if (issues.length) { dViol++; console.log(`❌ ${acc.name} ${d.id}: ${issues.map((i) => i.msg).join(' · ').slice(0, 90)}`); } else dPass++;
  }
}
console.log(`live drafts: ${dPass}/${drafts} clean · ${dViol} with violations`);
process.exit(pFail || dViol ? 1 : 0);
