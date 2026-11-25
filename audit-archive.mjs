// audit-archive.mjs — run the CTA judgement over EVERY thread we own, not the handful we just made.
//
// Ten fresh generation runs cost real fuel and sample one distribution. The archive is free, ~20x
// larger, and already contains every defect the engine has ever shipped — including the ones we
// stopped noticing. This walks every draft on every account, judges it with the same instrument used
// on a fresh draft, and reports the BASE RATE per defect so we fix by frequency instead of by
// whichever example happened to be on screen.
//
//   node audit-archive.mjs                      # every account, every status
//   node audit-archive.mjs --account magnus     # one account
//   node audit-archive.mjs --status draft       # only unpublished
//   node audit-archive.mjs --json out.json      # machine-readable, for the report
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { moldById } from './checks.mjs';
import { judgeThread, resolveProducts } from './cta-audit.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

/**
 * Pure: collapse a verdict message into a stable DEFECT CLASS so 40 instances of one bug group into
 * one line instead of 40. Ranked by frequency, this is the fix queue.
 */
export function defectClass(v) {
  const m = String(v.msg);
  if (/SELLS BEFORE IT JUSTIFIES/.test(m)) return 'criterion-inverted';
  if (/cannot resolve WHAT this plug sells/.test(m)) return 'plug-unresolvable';
  if (/resolves to NO product/.test(m)) return 'product-unresolvable';
  if (/never names this substance/.test(m)) return 'body-never-argues-product';
  if (/not bridge-gated/.test(m)) return 'weak-bridge';
  if (/ADJACENT/.test(m)) return 'plugs-adjacent';
  if (/after the sign-off/.test(m)) return 'plug-after-signoff';
  if (/too early to have earned/.test(m)) return 'plug-too-early';
  if (/past the proven window/.test(m)) return 'plug-late';
  if (/deep in the thread/.test(m)) return 'plug-very-late';
  if (/no tracked plug at all/.test(m)) return 'unmonetized';
  if (/carries no affiliate disclosure/.test(m)) return 'no-disclosure';
  if (/banned move/.test(m)) return 'banned-opener';
  if (/is \d+ chars/.test(m)) return 'over-280';
  if (/beat\(s\) —/.test(m)) return 'plug-under-3-beats';
  if (/closer is/.test(m)) return 'closer-not-first-person';
  if (/same move/.test(m)) return 'both-plugs-same-move';
  if (/same product twice/.test(m)) return 'same-product-twice';
  if (/short by design/.test(m)) return 'mold-too-long';
  if (/allows \d+ plug/.test(m)) return 'mold-plug-cap-broken';
  if (/numbered shape/.test(m)) return 'mold-numbering-lost';
  if (/NOT checked/.test(m)) return 'mold-unknown';
  if (/hook is/.test(m)) return 'hook-out-of-band';
  // The archive's biggest bucket was "other" (1410 hits) purely because these four bridge messages
  // had no class. They ARE the criterion family — the exact thing the operator cares most about —
  // and burying them in a catch-all hid the fleet's single most common real defect.
  if (/neither names the substance nor says what to look for/.test(m)) return 'no-bridge-no-criterion';
  if (/names the substance but gives no buying criterion/.test(m)) return 'criterion-missing';
  if (/arrives cold — no tweet in the/.test(m)) return 'plug-cold';
  if (/has only ONE run-up beat/.test(m)) return 'runup-thin';
  if (/opens on the brand/.test(m)) return 'brand-led-opener';
  if (/commercial ask with NO link/.test(m)) return 'unlinked-sell';
  if (/ends mid-sentence/.test(m)) return 'truncated-tweet';
  if (/SAME TEMPLATE/.test(m)) return 'opener-twins';
  if (/rival form/.test(m)) return 'form-contradiction';
  if (/share ONE tracked link/.test(m)) return 'duplicate-link';
  if (/shape is broken/.test(m)) return 'plug-shape-broken';
  if (/vocabulary has no word/.test(m)) return 'catalog-vocabulary-gap';
  if (/criterion sits/.test(m)) return 'criterion-late';
  if (/first appearance|introduces its own substance/i.test(m)) return 'criterion-is-first-mention';
  return 'other';
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const only = arg('account');
  const onlyStatus = arg('status');

  const led = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const catalog = Object.fromEntries((JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products || []).map((p) => [p.asin, p]));

  const results = [];
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    if (only && key !== String(only).toLowerCase()) continue;
    if (!acc.socialSetId) continue;
    for (const status of (onlyStatus ? [onlyStatus] : ['draft', 'scheduled', 'published'])) {
      for (let offset = 0; offset < 200; offset += 50) {
        let page;
        try { page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=${status}&limit=50&offset=${offset}&order_by=-created_at`); }
        catch (e) { console.warn(`  ! ${key}/${status}: ${String(e.message).slice(0, 70)}`); break; }
        const items = page?.results || page?.items || [];
        if (!items.length) break;
        for (const d of items) {
          let full;
          try { full = await tf.getDraft(acc.socialSetId, d.id); } catch { continue; }
          const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
          if (tweets.length < 3) continue; // a single post is not a thread; nothing to judge
          const rows = led.filter((e) => String(e.draftId) === String(d.id));
          const products = resolveProducts(tweets, { rows, ledger: led, catalog });
          if (!products.length) continue; // unmonetized on purpose (growth post) — not this tool's job
          const mold = rows[0]?.moldId ? moldById(rows[0].moldId) : null;
          const j = judgeThread(tweets, { account: acc, products, mold });
          results.push({
            account: acc.name, key, id: d.id, status, tweets: tweets.length,
            title: (full.draft_title || '').slice(0, 54), url: full.share_url || null,
            score: j.score, plugAt: (j.plugIdx || []).map((i) => i + 1),
            fails: j.verdicts.filter((v) => v.level === 'fail').map((v) => ({ cls: defectClass(v), msg: v.msg })),
            warns: j.verdicts.filter((v) => v.level === 'warn').map((v) => ({ cls: defectClass(v), msg: v.msg })),
          });
          process.stdout.write(`\r  judged ${results.length}...`);
        }
        if (items.length < 50) break;
      }
    }
  }
  console.log(`\n\nARCHIVE AUDIT — ${results.length} monetized threads judged\n`);

  const tally = new Map();
  for (const r of results) {
    for (const f of r.fails) tally.set(`FAIL ${f.cls}`, (tally.get(`FAIL ${f.cls}`) || 0) + 1);
    for (const w of r.warns) tally.set(`warn ${w.cls}`, (tally.get(`warn ${w.cls}`) || 0) + 1);
  }
  console.log('DEFECT BASE RATE (fix by frequency, not by whichever one was on screen)');
  for (const [cls, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((n / Math.max(1, results.length)) * 100);
    console.log(`  ${String(n).padStart(4)} ${String(pct + '%').padStart(5)}  ${cls}`);
  }

  const clean = results.filter((r) => !r.fails.length);
  console.log(`\nCLEAN (zero fails): ${clean.length}/${results.length} (${Math.round((clean.length / Math.max(1, results.length)) * 100)}%)`);
  console.log('\nWORST 15');
  for (const r of [...results].sort((a, b) => a.score - b.score).slice(0, 15)) {
    console.log(`  ${String(r.score).padStart(3)}  ${r.account.padEnd(16)} ${r.id}  ${r.status.padEnd(9)} plugs@${r.plugAt.join(',')}  ${r.fails.map((f) => f.cls).join(' ')}`);
  }
  const byAcc = new Map();
  for (const r of results) {
    const a = byAcc.get(r.account) || { n: 0, sum: 0, fails: 0 };
    a.n++; a.sum += r.score; a.fails += r.fails.length; byAcc.set(r.account, a);
  }
  console.log('\nBY ACCOUNT');
  for (const [a, s] of [...byAcc.entries()].sort((x, y) => x[1].sum / x[1].n - y[1].sum / y[1].n)) {
    console.log(`  ${a.padEnd(18)} n=${String(s.n).padStart(3)}  mean ${String(Math.round(s.sum / s.n)).padStart(3)}  ${s.fails} fail(s)`);
  }

  const out = arg('json');
  if (out) { writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 1)); console.log(`\n→ ${out}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'audit-archive');
