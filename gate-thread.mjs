#!/usr/bin/env node
// gate-thread.mjs — run the fleet's real publish gates over a thread that was written somewhere else.
//
// Everything else in this repo gates at the moment it writes. A thread drafted in a chat window has
// no such moment: the laws live in checks.mjs and only run where Node and this repo are. Copying them
// into a prompt was the obvious alternative and the wrong one — four of them changed on 2026-08-25
// alone, and a prose copy starts drifting the same day.
//
// So the gate becomes callable instead. Same validateDraft the engine and publish-thread use, no
// second implementation to keep in step. Dispatch .github/workflows/gate-thread.yml, read the verdict.
//
// Gate BEFORE you mint. Levanta links are cheap but not free, and a thread that fails the bridge rule
// fails it whether or not a real URL is in the tweet — so leave {{LINK}} / {{LINK2}} placeholders in
// the copy and this substitutes probe URLs that behave like plug links for every check.
//
//   node gate-thread.mjs --file thread.json
//   node gate-thread.mjs --json '{"account":"julian","tweets":["..."],"products":[...]}'
//   node gate-thread.mjs --file thread.json --json-out      # machine-readable verdict
//
// INPUT (only account + tweets are required):
//   { "account": "julian",
//     "tweets": ["hook", "...", "The magnesium I take (#ad):\n\n{{LINK}}"],
//     "products": [{ "asin": "B0CV2SXX5M", "title": "Nutricost Magnesium Glycinate", "link": null }],
//     "ctaDepth": 2,            // tweets the FIRST ask occupies: 3 = point+bridge+plug, 2 = compact
//     "allowUnsold": [],        // substances the thread argues but deliberately does not sell
//     "shape": null,            // "conceptual" plans a four-beat run-up
//     "firstPlugAt": null }     // only ever LOOSENS the 3-4 window, capped at 6
import { readFileSync } from 'node:fs';
import { validateDraft, checkThread, effLen, isTrackedLink, leadingNumbers, stackedParagraphs } from './checks.mjs';
import { getAccount } from './accounts.mjs';
import { runMain } from './lib.mjs';
import { pathToFileURL } from 'node:url';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PROBE = (n) => `https://lvnta.com/lv_gateprobe${String(n).padStart(2, '0')}`;

// Pure, exported for tests: spec in, verdict out. No network, no files, no clock.
export function gateThread(spec = {}) {
  const errors = [];
  // getAccount THROWS on an unknown key. A gate called from outside the repo has to answer, not
  // crash: a typo in a chat-pasted spec should read as a verdict, not a stack trace in a run log.
  let account = null;
  try { account = getAccount(spec.account); } catch { account = null; }
  if (!account) return { ok: false, fatal: `unknown account "${spec.account}" — one of: julian rafael magnus lorenzo marcos lucas jasper tina clara` };
  const tweets0 = (spec.tweets || []).map((t) => String(t ?? ''));
  if (tweets0.length < 3) return { ok: false, fatal: `only ${tweets0.length} tweet(s) — a thread needs a hook, a body and a close` };

  // Placeholders let a thread be gated before a single link is minted. {{LINK}} is product 1,
  // {{LINK2}} product 2; a product that already carries a real link keeps it.
  //
  // A product row often carries the placeholder in its own `link` field — that is the natural way to
  // write a spec whose links do not exist yet, and it is what the money-thread lane produces. A bare
  // `p.link ||` read that as a real link and substituted the token with itself, so the thread failed
  // on "unresolved {{token}}" and every plug read as link-less. A placeholder is an absent link.
  const minted = (l) => (/\{\{LINK\d*\}\}/.test(String(l || '')) ? '' : String(l || ''));
  const products = (spec.products || []).map((p, i) => ({ ...p, link: minted(p.link) || PROBE(i + 1) }));
  // {{LINK}} is product 1, {{LINK2}} product 2, {{LINK3}} product 3, and so on — the same mapping
  // batch-mint's TOKEN(i) already writes. This used to handle only the first two, so a thread with a
  // third ask could not be gated at all: the token survived substitution, the plug read as link-less,
  // and the gate reported an unresolved placeholder instead of judging the plug. The plug budget in
  // laws.json allows 3 asks on a mid-length body, so the gate has to be able to see them.
  const tweets = tweets0.map((t) => t.replace(/\{\{LINK(\d*)\}\}/g, (_, n) => {
    const i = n ? Number(n) - 1 : 0;
    return products[i]?.link || PROBE(i + 1);
  }));
  const links = products.map((p) => p.link).filter(Boolean);

  const plugAt = tweets.map((t, i) => (links.some((l) => t.includes(l)) ? i + 1 : 0)).filter(Boolean);
  // Depth decides where the ASK opens, so a caller who does not declare it gets the strict reading.
  const ctaDepth = Number(spec.ctaDepth) > 0 ? Math.floor(Number(spec.ctaDepth)) : 1;
  const monetized = spec.monetized !== false && links.length > 0;

  const issues = validateDraft(tweets, links, account, monetized, products, {
    allowUnsold: spec.allowUnsold || [], shape: spec.shape || null,
    firstPlugAt: spec.firstPlugAt ?? null, ctaDepth,
  });
  // TWO BUGS, both silent, both fixed 2026-08-26 — this whole layer was inert since it was written.
  // checkThread's second parameter is destructured `{ account, link, monetized }`, and this call
  // passed four positional arguments, so account/link/monetized all read as undefined and
  // `if (!monetized) return issues` bailed before a single monetized check ran. The filter then
  // read `v.level`, but checkThread emits `severity`, so `qc` came back empty regardless. Either bug
  // alone would have emptied it; together they made the Money · Gate a thread workflow report clean
  // on drafts validateDraft happened not to catch. Object form and the right field name, matching
  // every other caller (publish-thread.mjs:75, qc.mjs:410).
  // `link` is a single URL, not the array — it feeds `[link].filter(Boolean)` and `t.includes(link)`
  // inside, and plug detection is by URL pattern anyway (the param is back-compat). links[0] is what
  // publish-thread passes. `arm` is the spec's declared CTA-experiment arm: 'single-cta' is the only
  // thing that lets checkThread accept one plug, and dropping it here refused every one-CTA cover.
  const qc = (checkThread(tweets, { account, link: links[0], monetized, arm: spec.arm || null }) || []).filter((v) => v.severity === 'error');
  const over = tweets.map((t, i) => [i + 1, effLen(t)]).filter(([, l]) => l > 280);
  const unresolved = tweets.map((t, i) => (/\{\{[A-Z_0-9]+\}\}/.test(t) ? i + 1 : 0)).filter(Boolean);
  for (const i of unresolved) errors.push(`#${i} still carries an unresolved {{token}} — every placeholder must map to a product`);
  for (const [i, l] of over) errors.push(`#${i} is ${l} characters (max 280)`);

  const all = [...errors, ...issues, ...qc.map((v) => v.msg || String(v))];
  return {
    ok: all.length === 0,
    account: account.name, tweets: tweets.length, monetized,
    plugsAt: plugAt, askOpensAt: plugAt.length ? plugAt[0] - (ctaDepth - 1) : null, ctaDepth,
    products: products.map((p) => ({ asin: p.asin, minted: !/gateprobe/.test(p.link) })),
    issues: all,
  };
}

async function main() {
  const raw = arg('json') || (arg('file') ? readFileSync(arg('file'), 'utf8') : null);
  if (!raw) { console.error('need --file <path> or --json <string>'); process.exitCode = 2; return; }
  let spec; try { spec = JSON.parse(raw); } catch (e) { console.error(`input is not valid JSON: ${e.message}`); process.exitCode = 2; return; }
  const v = gateThread(spec);
  if (process.argv.includes('--json-out')) { console.log(JSON.stringify(v, null, 2)); process.exitCode = v.ok ? 0 : 1; return; }
  if (v.fatal) { console.log(`✗ ${v.fatal}`); process.exitCode = 2; return; }
  console.log(`${v.account} · ${v.tweets} tweets · ${v.monetized ? `plugs at ${v.plugsAt.map((n) => `T${n}`).join(', ')} · ask opens T${v.askOpensAt} (depth ${v.ctaDepth})` : 'unmonetized'}`);
  const unminted = v.products.filter((p) => !p.minted).length;
  if (unminted) console.log(`  (${unminted} product(s) gated on a probe link — mint before publishing)`);
  if (v.ok) { console.log('\n✓ PASSES every publish gate.'); return; }
  console.log(`\n✗ ${v.issues.length} issue(s):`);
  for (const i of v.issues) console.log(`  · ${i}`);
  process.exitCode = 1;
}
// Only when this file IS the entry point — the tests import gateThread and must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'gate-thread');
