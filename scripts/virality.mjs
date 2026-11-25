// scripts/virality.mjs — reverse-engineer virality from our hooks and the swipe database's (owner,
// 2026-09-24: "Reverse engineer virality, that's the wording"; "only look at the data from the last 30
// days — at most 90 days"; "source is both the airtable database and our registry").
//
//   1. corpus   learnings/hook-corpus.jsonl (scripts/hook-corpus.mjs), cut to the window
//   2. target   lift = log(views / the author's median in the window): what lifted a post above its
//               own page's normal, so page size does not decide
//   3. read     Jev reads each hook once (hook-read: shape + eleven checks), cached by hook text
//   4. fit      ridge regression of lift on the linguistic fingerprint (hook-fingerprint.mjs) + Jev's
//               checks; lambda picked on the newest slice of the training set
//   5. test     on the newest 30% of the window, never seen in training: Spearman and AUC for the top
//               quarter, against today's hookStrength (similarity to the hook bank). It passes only when
//               it beats hookStrength on OUR posts with AUC >= 0.6; otherwise it stays report-only.
//   6. write    learnings/hook-fingerprint.json (the model, winners, labels, backtest) and
//               learnings/virality.md (the patterns, in words, with examples)
//
//   node scripts/virality.mjs [--days 30] [--no-jev]
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, runMain, cliArg, HERE_DIR } from '../lib.mjs';
import { hookStrength, bannedTopicIssue } from '../checks.mjs';
import {
  HOOK_QUESTIONS, hookFeatures, jevFeatures, hookKey, distinctKey, withLift, fitRidge, predict, spearman, auc, recencyWeight,
} from '../hook-fingerprint.mjs';
import { CORPUS, readCorpus, windowDays } from './hook-corpus.mjs';

export const FINGERPRINT = join(HERE_DIR, 'learnings', 'hook-fingerprint.json');
export const REPORT = join(HERE_DIR, 'learnings', 'virality.md');
export const READS = join(HERE_DIR, 'learnings', 'hook-reads.jsonl');
export const PASS_AUC = 0.6;
const safeBanned = (hook) => { try { return !!bannedTopicIssue([String(hook)]); } catch { return false; } };
const clipText = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const LAMBDAS = [2, 5, 10, 20, 40];

/** PURE. Human words for a feature key. */
export function labelOf(k) {
  const [kind, ...rest] = String(k).split(':'); const v = rest.join(':');
  const say = {
    w: `word "${v}"`, p2: `phrase "${v}"`, p3: `phrase "${v}"`, open: `opens with "${v}"`, shape: v, num: `number: ${v}`,
    punct: v, voice: `voice: ${v}`, form: `form: ${v}`, jev: `Jev: ${v.replace(/^shape /, 'shape = ')}`,
  }[kind];
  return (say || k).replace(/#/g, 'N');
}

/** PURE. Rows in the window, ordered oldest first. */
export function inWindow(rows, days, now = Date.now()) {
  const from = now - days * 864e5;
  return rows.filter((r) => Date.parse(r.postedAt) >= from).sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
}

/**
 * PURE. Train on the older part, test on the newest `share`, for each share in SHARES: one lucky split
 * must not switch the score on. Lambda is chosen on the newest slice of each training set.
 */
export const SHARES = [0.2, 0.3, 0.4];
export function backtestOne(rows, featuresOf, { share = 0.3, baseline = null, weightOf = null } = {}) {
  const cut = Math.floor(rows.length * (1 - share));
  const train = rows.slice(0, cut), test = rows.slice(cut);
  const vcut = Math.floor(train.length * 0.8);
  let best = null;
  for (const lambda of LAMBDAS) {
    const m = fitRidge(train.slice(0, vcut), featuresOf, { lambda, weightOf });
    const v = train.slice(vcut);
    const rho = spearman(v.map((r) => predict(m, featuresOf(r))), v.map((r) => r.lift));
    if (!best || rho > best.rho) best = { lambda, rho };
  }
  const model = fitRidge(train, featuresOf, { lambda: best.lambda, weightOf });
  const evalOn = (subset) => {
    if (subset.length < 10) return { n: subset.length };
    const lifts = subset.map((r) => r.lift);
    const q75 = [...lifts].sort((a, b) => a - b)[Math.floor(lifts.length * 0.75)];
    const top = lifts.map((l) => l >= q75);
    const pred = subset.map((r) => predict(model, featuresOf(r)));
    const out = { n: subset.length, spearman: +spearman(pred, lifts).toFixed(3), aucTop25: +auc(pred, top).toFixed(3) };
    if (baseline) {
      const b = subset.map((r) => baseline(r));
      out.baseline = { spearman: +spearman(b, lifts).toFixed(3), aucTop25: +auc(b, top).toFixed(3) };
    }
    return out;
  };
  return { share, lambda: best.lambda, train: train.length, test: evalOn(test), testOurs: evalOn(test.filter((r) => r.origin === 'ours')), testSwipe: evalOn(test.filter((r) => r.origin === 'swipe')) };
}

/** PURE. Every split, and the verdict: on OUR posts, mean AUC >= PASS_AUC and above hookStrength on every split. */
export function backtest(rows, featuresOf, opts = {}) {
  const splits = SHARES.map((share) => backtestOne(rows, featuresOf, { ...opts, share }));
  const ours = splits.map((s) => s.testOurs).filter((t) => Number.isFinite(t.aucTop25));
  const meanAuc = ours.length ? ours.reduce((a, t) => a + t.aucTop25, 0) / ours.length : NaN;
  const beatsEvery = ours.length === splits.length && ours.every((t) => t.aucTop25 > (t.baseline?.aucTop25 ?? 1));
  const lambdas = splits.map((s) => s.lambda).sort((a, b) => a - b);
  return { splits, meanAucOurs: +meanAuc.toFixed(3), beatsHookStrengthEverySplit: beatsEvery, pass: meanAuc >= PASS_AUC && beatsEvery, lambda: lambdas[Math.floor(lambdas.length / 2)] };
}

/** PURE. Mean lift with vs without each feature (support >= min), for the report's evidence column. */
export function featureStats(rows, featuresOf, keys, { min = 6 } = {}) {
  const all = rows.map((r) => ({ r, f: featuresOf(r) }));
  const out = {};
  for (const k of keys) {
    const withK = all.filter((x) => x.f.has(k)), without = all.filter((x) => !x.f.has(k));
    const distinct = new Set(withK.map((x) => distinctKey(x.r.hook))).size;
    if (distinct < min || !without.length) continue;
    const m = (a) => a.reduce((s, x) => s + x.r.lift, 0) / a.length;
    const shown = withK.filter((x) => x.r.origin === 'ours' && !safeBanned(x.r.hook)); // examples: ours only
    out[k] = { n: distinct, posts: withK.length, liftWith: +Math.exp(m(withK)).toFixed(2), liftWithout: +Math.exp(m(without)).toFixed(2),
      examples: shown.sort((a, b) => b.r.lift - a.r.lift).slice(0, 2).map((x) => ({ hook: clipText(x.r.hook, 120), account: x.r.account, views: x.r.views })) };
  }
  return out;
}

function loadReads() {
  const m = new Map();
  if (existsSync(READS)) for (const l of readFileSync(READS, 'utf8').split('\n')) { try { const j = JSON.parse(l); m.set(j.key, j.answers); } catch { /* skip */ } }
  return m;
}

/** Jev reads every hook not yet read (cached by hook text). Unread hooks simply carry no Jev features. */
export async function readHooks(rows, { client, ask, concurrency = 12 } = {}) {
  const cache = loadReads();
  const todo = [...new Map(rows.filter((r) => !cache.has(hookKey(r.hook))).map((r) => [hookKey(r.hook), r.hook])).entries()];
  let read = 0, failed = 0;
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async ([key, hook]) => {
      try {
        const r = await ask('hook-read', client, { state: { hook: String(hook).slice(0, 1200) }, questions: HOOK_QUESTIONS });
        cache.set(key, r.answers); read++;
        appendFileSync(READS, JSON.stringify({ key, answers: r.answers }) + '\n');
      } catch { failed++; }
    }));
  }
  return { cache, read, failed };
}

/**
 * PURE. Drop a phrase whose words sit inside a phrase already listed with the same distinct-hook count:
 * "to protect", "protect your" and "to protect your" are one pattern, shown once (the longest).
 */
export function mergeOverlaps(entries, stats) {
  const text = (k) => String(k).replace(/^(w|p2|p3):/, '');
  const byLen = [...entries].sort((a, b) => text(b[0]).length - text(a[0]).length);
  const kept = [];
  for (const [k, w] of byLen) {
    const n = stats[k]?.n;
    const inside = /^(w|p2|p3):/.test(k) && kept.some(([k2]) => /^(w|p2|p3):/.test(k2) && stats[k2]?.n === n && ` ${text(k2)} `.includes(` ${text(k)} `));
    if (!inside) kept.push([k, w]);
  }
  const keep = new Set(kept.map(([k]) => k));
  return entries.filter(([k]) => keep.has(k));
}

function report(fp, stats) {
  const L = [];
  const b = fp.backtest;
  L.push(`# Reverse-engineer virality — ${fp.window.days} days to ${fp.window.to.slice(0, 10)}`, '');
  L.push(`${fp.n.total} hooks: ${fp.n.ours} ours, ${fp.n.swipe} from the swipe database. Target: views over the author's own median in the window (so page size does not decide). Built ${fp.builtAt.slice(0, 16).replace('T', ' ')} UTC by scripts/virality.mjs.`, '');
  L.push('## Does it predict?', '');
  L.push('| Test: newest part of the window, never seen in training | our posts | AUC top quarter | hookStrength AUC | Spearman | hookStrength Spearman |', '|:--|--:|--:|--:|--:|--:|');
  for (const sp of b.splits) { const t = sp.testOurs; if (t?.spearman != null) L.push(`| newest ${Math.round(sp.share * 100)}% | ${t.n} | ${t.aucTop25} | ${t.baseline?.aucTop25 ?? '—'} | ${t.spearman} | ${t.baseline?.spearman ?? '—'} |`); }
  L.push('', `**Verdict: ${fp.pass ? 'PASS — the score ranks hooks at the hook pick' : 'report-only — it does not yet beat today\'s ranking on our posts, so it informs the critique and rewrite but does not pick'}.** (Bar: mean AUC ≥ ${PASS_AUC} on our posts, and above hookStrength on every split. Mean AUC ${b.meanAucOurs}.) Jev reads: ${fp.jev.read} new, ${fp.jev.cached} cached, ${fp.jev.failed} failed.`, '');
  const row = (k, w) => { const s = stats[k]; return `| ${labelOf(k)} | ${w > 0 ? '+' : ''}${w.toFixed(3)} | ${s ? `${s.n}${s.posts > s.n ? ` (${s.posts} posts)` : ''}` : '—'} | ${s ? `${s.liftWith}× vs ${s.liftWithout}×` : '—'} | ${s?.examples?.[0] ? `${s.examples[0].hook} (${s.examples[0].account}, ${s.examples[0].views.toLocaleString('en-US')})` : ''} |`; };
  const ranked = mergeOverlaps(Object.entries(fp.model.weights).sort((a, b) => b[1] - a[1]), stats);
  L.push('## What lifts a hook', '', '| Pattern | Weight | Hooks | Views vs author median (with / without) | Best example |', '|:--|--:|--:|:--|:--|');
  for (const [k, w] of ranked.filter(([, w]) => w > 0).slice(0, 30)) L.push(row(k, w));
  L.push('', '## What drags a hook', '', '| Pattern | Weight | Hooks | Views vs author median (with / without) | Example |', '|:--|--:|--:|:--|:--|');
  for (const [k, w] of ranked.filter(([, w]) => w < 0).reverse().slice(0, 20)) L.push(row(k, w));
  L.push('', '## Constructions and Jev checks (every one, ranked)', '', 'The shapes a writer can choose, whatever their rank above: named forms, voice, numbers, punctuation and Jev\'s eleven checks.', '', '| Pattern | Weight | Hooks | Views vs author median (with / without) | Best example |', '|:--|--:|--:|:--|:--|');
  for (const [k, w] of Object.entries(fp.model.weights).filter(([k]) => /^(form|jev|voice|num|punct|shape|open):/.test(k) && !/^open:/.test(k)).sort((a, b) => b[1] - a[1])) L.push(row(k, w));
  L.push('', 'Weights are ridge coefficients on log-lift: they add. "Hooks" counts distinct wordings (a harvest reposted nine times is one); a pattern with few is weaker evidence than its weight suggests. Overlapping phrases with the same hooks are shown once.');
  return L.join('\n') + '\n';
}

async function main() {
  const env = loadEnv();
  const days = windowDays(cliArg('days', 30));
  const now = Date.now();
  const rows = withLift(inWindow(readCorpus(CORPUS), days, now));
  if (rows.length < 60) throw new Error(`only ${rows.length} hooks in ${days} days: run scripts/hook-corpus.mjs --days ${days} first`);
  let jev = { read: 0, failed: 0, cached: 0 }, reads = new Map();
  if (!process.argv.includes('--no-jev')) {
    try {
      const [{ jev: client }, { askThrough }] = await Promise.all([import('../jev.mjs'), import('../jev-decide.mjs')]); // optional-import
      const before = loadReads().size;
      const r = await readHooks(rows, { client: client(env), ask: askThrough });
      reads = r.cache; jev = { read: r.read, failed: r.failed, cached: before };
    } catch (e) { console.log(`Jev not read (${String(e.message).slice(0, 80)}): the fingerprint is words only`); }
  }
  const featuresOf = (r) => new Set([...hookFeatures(r.hook), ...jevFeatures(reads.get(hookKey(r.hook)))]);
  const bank = JSON.parse(readFileSync(join(HERE_DIR, 'learnings', 'hook-bank.json'), 'utf8')).hooks || [];
  const baseline = (r) => { try { return Number(hookStrength(r.hook, bank)?.score) || 0; } catch { return 0; } };
  // Past 30 days, a newer post teaches more (half-life 30 days); inside 30 days every post counts once.
  const weightOf = days > 30 ? (r) => recencyWeight(r.postedAt, now, 30) : null;
  const bt = backtest(rows, featuresOf, { baseline, weightOf });
  const pass = bt.pass;
  const model = fitRidge(rows, featuresOf, { lambda: bt.lambda, weightOf });
  const ours = rows.filter((r) => r.origin === 'ours');
  const liftCut = [...rows.map((r) => r.lift)].sort((a, b) => a - b)[Math.floor(rows.length * 0.8)];
  // Winners are the examples a writer sees: never a banned topic (cancer…), whatever it earned.
  // Our own published hooks only: donor text never enters the repo (the swipe rows train the model).
  const winners = rows.filter((r) => r.origin === 'ours' && r.lift >= liftCut && !safeBanned(r.hook)).slice(-200)
    .map((r) => ({ hook: r.hook.slice(0, 400), account: r.account, views: r.views, lift: +r.lift.toFixed(3), origin: r.origin, features: [...featuresOf(r)] }));
  const keys = Object.keys(model.weights);
  const stats = featureStats(rows, featuresOf, keys);
  const fp = {
    version: 1, builtAt: new Date(now).toISOString(), window: { days, to: new Date(now).toISOString() },
    n: { total: rows.length, ours: ours.length, swipe: rows.length - ours.length }, jev, backtest: bt, pass, passAuc: PASS_AUC,
    model, labels: Object.fromEntries(keys.map((k) => [k, labelOf(k)])),
    predictedDistribution: ours.map((r) => +predict(model, featuresOf(r)).toFixed(4)).sort((a, b) => a - b),
    winners,
  };
  writeFileSync(FINGERPRINT, JSON.stringify(fp, null, 1));
  writeFileSync(REPORT, report(fp, stats));
  console.log(`virality: ${days}d · ${rows.length} hooks (${ours.length} ours) · Jev ${jev.read} read, ${jev.cached} cached, ${jev.failed} failed · lambda ${bt.lambda}`);
  for (const sp of bt.splits) console.log(`  newest ${Math.round(sp.share * 100)}% · ours n ${sp.testOurs.n}: AUC ${sp.testOurs.aucTop25} vs hookStrength ${sp.testOurs.baseline?.aucTop25} · Spearman ${sp.testOurs.spearman} vs ${sp.testOurs.baseline?.spearman}`);
  console.log(`  mean AUC (ours) ${bt.meanAucOurs} · beats hookStrength on every split: ${bt.beatsHookStrengthEverySplit} · ${pass ? 'PASS' : 'report-only'}`);
  console.log(`  → ${FINGERPRINT}\n  → ${REPORT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await runMain(main, 'virality');
