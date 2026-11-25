#!/usr/bin/env node
// cta-experiment.mjs [--worksheet <f>] [--json] — read the one-ask arm against the control.
//
// The experiment (operator 2026-09-07): half the covers scheduled 8-11 September carry both asks,
// half carry only the heavy one. This is the readout, and it is built to be honest about its own
// limits, because the limit is the whole story here.
//
// WHY IT PRINTS ITS OWN POWER. Cover impressions have a log-scale spread of about 2.2 (median 42K,
// ninety-fifth percentile 1.9M). At sixteen per arm that only resolves a roughly eight-fold
// difference in views. A "no significant difference" from a sample this size is not evidence the
// second ask is free — it is evidence the sample is small. So every number here is printed next to
// the smallest effect it could have detected, and the verdict line refuses to call a null a result.
//
// Engagement rate is the primary metric: log-spread 0.85 rather than 2.2, and it is what the
// algorithm actually optimizes, so it is both better powered and closer to the mechanism.
//
//   node cta-experiment.mjs                 # the read
//   node cta-experiment.mjs --json          # machine-readable
//
// Mann-Whitney rather than a t-test: the outcome is heavy-tailed and small-n, so a rank test is the
// honest one. Ties are corrected for; with fewer than ~8 per arm the normal approximation is noted
// as unreliable rather than quietly reported.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFileSync as _rf } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, airtable, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { ARM, WORKSHEET } from './cta-strip.mjs';
import { PLATFORM_SUBID_SUFFIX } from './platforms.mjs';

const med = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q = (v, p) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sum = (v) => v.reduce((a, b) => a + b, 0);

/** PURE. Log-scale standard deviation, the spread that decides what this design can see. */
export function logSd(values) {
  const v = values.filter((x) => x > 0).map(Math.log);
  if (v.length < 3) return null;
  const m = sum(v) / v.length;
  return Math.sqrt(sum(v.map((x) => (x - m) ** 2)) / (v.length - 1));
}

/** PURE. Smallest ratio difference in medians detectable at 80% power, 5% two-sided, n per arm. */
export function mde(sd, n) {
  if (!sd || !n || n < 2) return null;
  return Math.exp(Math.sqrt((2 * (1.96 + 0.84) ** 2 * sd * sd) / n)) - 1;
}

/** PURE. Mann-Whitney U with the normal approximation and a tie correction. Returns
 *  { u, z, p, reliable } — `reliable` false under 8 per arm, where the approximation is not to be
 *  trusted and saying so is the only correct thing to do. */
export function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length;
  if (!n1 || !n2) return { u: null, z: null, p: null, reliable: false };
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  const tieGroups = [];
  for (let i = 0; i < all.length;) {
    let j = i; while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  const r1 = sum(all.map((x, i) => (x.g === 0 ? ranks[i] : 0)));
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const N = n1 + n2;
  const tieTerm = sum(tieGroups.map((t) => t ** 3 - t));
  const sd = Math.sqrt((n1 * n2 / (N * (N - 1))) * ((N ** 3 - N) / 12 - tieTerm / 12));
  if (!sd) return { u, z: null, p: null, reliable: false };
  const z = (u - (n1 * n2) / 2 + 0.5) / sd;
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { u, z, p: Math.min(1, Math.max(0, p)), reliable: n1 >= 8 && n2 >= 8 };
}
// Abramowitz & Stegun 7.1.26 — plenty for reporting a p-value to two decimals.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return y;
}

/** PURE. Split a draft's Levanta keys by the platform their subid names.
 *
 *  WHY THE REGISTRY NUMBER WILL NOT DO. `Link Clicks` on a Published Content row is
 *  max(Typefully's X clicks, Levanta clicks), and the Levanta side sums EVERY key the draft owns
 *  (registry-sync linksByDraft). Once a thread cross-posts, that includes its "-th" twins, so the
 *  row's clicks and commission are X plus Threads combined — fine for revenue, useless for a
 *  comparison where the arms carry different numbers of cross-posts.
 *
 *  The split has existed since 2026-08-27 and nothing ever read it back. Reading it is what makes
 *  "so we see actual results" true rather than aspirational. Returns { x: [...], threads: [...] }
 *  of ledger rows, keyed on the subid suffix that minted them. */
export function byPlatform(ledgerRows = []) {
  const out = { x: [], threads: [] };
  for (const r of ledgerRows) {
    const sub = String(r.subid1 || r.subid || '');
    const th = Object.entries(PLATFORM_SUBID_SUFFIX).find(([, suf]) => sub.endsWith(suf));
    (th ? (out[th[0]] ||= []) : out.x).push(r);
  }
  return out;
}

/** PURE. One metric, both arms, with the test and the power statement attached. */
export function compare(label, armed, control, { money = false } = {}) {
  const a = armed.filter((x) => Number.isFinite(x) && x > 0), c = control.filter((x) => Number.isFinite(x) && x > 0);
  const sd = logSd([...a, ...c]);
  const n = Math.min(a.length, c.length);
  const test = mannWhitney(a, c);
  const ma = med(a), mc = med(c);
  return {
    label, n1: a.length, n2: c.length,
    medianArm: ma, medianControl: mc,
    ratio: ma != null && mc ? ma / mc : null,
    iqrArm: [q(a, 0.25), q(a, 0.75)], iqrControl: [q(c, 0.25), q(c, 0.75)],
    totalArm: money ? sum(a) : null, totalControl: money ? sum(c) : null,
    logSd: sd, mde: mde(sd, n), p: test.p, reliable: test.reliable,
  };
}

const pct = (x) => (x == null ? '   —' : `${(x * 100).toFixed(0)}%`);
const num = (x) => (x == null ? '—' : Math.round(x).toLocaleString());

async function main() {
  const wsPath = cliArg('worksheet', WORKSHEET);
  if (!existsSync(wsPath)) throw new Error(`no worksheet at ${wsPath} — run cta-strip --assign first`);
  const ws = JSON.parse(readFileSync(wsPath, 'utf8'));
  const arms = new Map(ws.rows.map((r) => [String(r.draftId), r.arm]));
  const donorOf = new Map(ws.rows.map((r) => [String(r.draftId), r.donor || null]));

  const env = loadEnv();
  const at = airtable(env, env.REGISTRY_BASE_ID);
  const rows = await at.listAll('Published Content', { fields: ['Impressions', 'Engagement Rate', 'Link Clicks', 'Commission', 'Draft ID', 'Account'] });
  const byDraft = new Map(rows.map((r) => [String(r.fields['Draft ID']), r.fields]));

  const picked = { [ARM]: [], control: [] };
  const missing = [];
  for (const r of ws.rows) {
    const f = byDraft.get(String(r.draftId));
    if (!f || !(Number(f.Impressions) > 0)) { missing.push(r); continue; }
    picked[r.arm === ARM ? ARM : 'control'].push({ ...r, f });
  }
  const A = picked[ARM], C = picked.control;
  const pull = (list, key) => list.map((x) => Number(x.f[key])).filter((x) => Number.isFinite(x));

  const results = [
    compare('engagement rate (primary)', pull(A, 'Engagement Rate'), pull(C, 'Engagement Rate')),
    compare('impressions', pull(A, 'Impressions'), pull(C, 'Impressions')),
    compare('link clicks', pull(A, 'Link Clicks'), pull(C, 'Link Clicks')),
    compare('commission', pull(A, 'Commission'), pull(C, 'Commission'), { money: true }),
  ];

  if (process.argv.includes('--json')) { console.log(JSON.stringify({ armed: A.length, control: C.length, pending: missing.length, results }, null, 1)); return; }

  console.log(`\nCTA EXPERIMENT — one ask vs two\n`);
  console.log(`  ${A.length} stripped and measured · ${C.length} control measured · ${missing.length} not yet posted or not yet synced\n`);
  if (!A.length || !C.length) { console.log('  nothing to compare yet — the threads have not published or the registry has not synced.\n'); return; }

  for (const r of results) {
    const dir = r.ratio == null ? '' : r.ratio > 1 ? `one-ask HIGHER by ${((r.ratio - 1) * 100).toFixed(0)}%` : `one-ask lower by ${((1 - r.ratio) * 100).toFixed(0)}%`;
    console.log(`  ${r.label}`);
    console.log(`     one ask  median ${num(r.medianArm)}   (IQR ${num(r.iqrArm[0])}–${num(r.iqrArm[1])}, n=${r.n1})${r.totalArm != null ? `   total ${r.totalArm.toFixed(2)}` : ''}`);
    console.log(`     two asks median ${num(r.medianControl)}   (IQR ${num(r.iqrControl[0])}–${num(r.iqrControl[1])}, n=${r.n2})${r.totalControl != null ? `   total ${r.totalControl.toFixed(2)}` : ''}`);
    console.log(`     ${dir}${r.p != null ? ` · p ${r.p.toFixed(2)}${r.reliable ? '' : ' (too few per arm for the approximation — read as a direction, not a test)'}` : ''}`);
    console.log(`     this many threads could only have detected a ${pct(r.mde)} difference in the median\n`);
  }

  // The paired read: a donor that ran in BOTH arms cancels the single largest source of variance.
  const pairs = [];
  const byDonor = {};
  for (const x of [...A.map((v) => ({ ...v, arm: ARM })), ...C.map((v) => ({ ...v, arm: 'control' }))]) {
    const d = donorOf.get(String(x.draftId)); if (!d) continue;
    (byDonor[d] ||= []).push(x);
  }
  for (const [d, list] of Object.entries(byDonor)) {
    const a = list.find((x) => x.arm === ARM), c = list.find((x) => x.arm === 'control');
    if (a && c) pairs.push({ donor: d, a, c, ratio: Number(a.f.Impressions) / Number(c.f.Impressions) });
  }
  if (pairs.length) {
    console.log(`  PAIRED ON THE DONOR (${pairs.length} pair(s)) — the same body in both arms, so the donor cancels`);
    for (const p of pairs) console.log(`     ${p.a.account} vs ${p.c.account}: ${num(p.a.f.Impressions)} vs ${num(p.c.f.Impressions)} views  (${p.ratio > 1 ? '+' : ''}${((p.ratio - 1) * 100).toFixed(0)}%)`);
    const gm = Math.exp(sum(pairs.map((p) => Math.log(p.ratio))) / pairs.length);
    console.log(`     geometric mean of the pair ratios: ${gm.toFixed(2)}x\n`);
  } else console.log('  no donor ran in both arms, so there is no paired read.\n');

  // The money guardrail, split by the subid that minted each link. X is the comparison; Threads is
  // reported beside it so the cross-post's own earnings are visible instead of merged into X's.
  const lp = join(HERE_DIR, 'ledger.jsonl');
  let ledger = [];
  try { ledger = _rf(lp, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* no ledger, no split */ }
  const rowsOf = (list) => list.flatMap((r) => ledger.filter((l) => String(l.draftId) === String(r.draftId)));
  for (const [label, list] of [['one ask', A], ['two asks', C]]) {
    const sp = byPlatform(rowsOf(list));
    console.log(`  ${label.padEnd(9)} tracked links: ${sp.x.length} on X · ${(sp.threads || []).length} on Threads`);
  }
  console.log('  (the reach numbers above are X-only — Typefully\'s /analytics/x/posts — so a Threads copy cannot inflate them)\n');

  const primary = results[0];
  const verdict = primary.p == null || !primary.reliable ? 'NOT ANSWERED — too few threads per arm to test; this is a direction only'
    : primary.p < 0.05 ? `a real difference in engagement rate (p ${primary.p.toFixed(2)})`
    : `no difference large enough to see at this size; anything under ${pct(primary.mde)} would be invisible here`;
  console.log(`  VERDICT: ${verdict}`);
  console.log(`  Accumulate across runs until about 40 per arm before treating this as settled.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'cta-experiment');
