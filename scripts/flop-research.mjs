// scripts/flop-research.mjs — what separates a thread that flops from one that hits (owner, 2026-09-25:
// "$ is still not the easiest to track — how about we track what flops (under 100k views) -- It's a
// direct correlation with clicks and $ ... keep on running it with ours and even with competitors to
// find insights we can leverage").
//
// Label: a FLOP is a thread under 100k views after 7 days. Checked 2026-09-25 on 1,245 of our threads:
// views vs clicks rank-correlate 0.75, views vs $ 0.70; flops were 72% of threads and earned 8% of the
// money (87% of flops earned $0 vs 22% of hits). The same 100k bar holds for competitor threads (the
// swipe DB: the pages Willie owns): page size doesn't decide virality (owner, 2026-09-25).
//
// Three owner hypotheses are tested first, in code (owner, 2026-09-25):
//   1. where the first CTA sits,  2. how many CTAs a thread carries,  3. retention (read-through, the
//   tweet 1 -> 2 drop, and the excess drop right at the first CTA).
// Each is compared over all threads pooled; how many pages agree is reported beside it as a check. Then an open loop: an LLM proposes yes/no questions from the threads
// the model misjudged most, Jev answers them (the `flop-read` reading, through the one door), and code
// keeps only questions that improve a validation split over the page baseline. The newest 25% is a
// locked holdout the loop never sees.
//
// READ-ONLY. Airtable (registry + swipe) and Typefully are read; nothing is written to any service.
// Text lives only in the gitignored caches (learnings/flop-corpus.jsonl, learnings/flop-answers.jsonl).
// Committed: learnings/flop-research.json (question text, weights, numbers, ids) and
// learnings/flop-research.md (five lines, then detail; example hooks are OUR published ones only).
// AI Evolution is excluded (owner, 2026-09-25). Budget: $2 a run, a hard stop (owner, 2026-09-25).
//
//   node scripts/flop-research.mjs [--days 90] [--offline | --no-refresh]   refresh the corpus (--no-refresh: reuse it), research, write the report
//   node scripts/flop-research.mjs --brief                    the top 3 insights + an experiment for each (/run brief)
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE_DIR, airtable, cliArg, llmSpendSummary, loadEnv, requireEnv, runMain, typefully } from '../lib.mjs';
import { ACCOUNTS } from '../accounts.mjs';
import { REGISTRY_TABLE, TABLES } from '../config.mjs';
import { plugFunnel, plugTweetIndices } from '../metrics.mjs';
import { auc } from '../hook-fingerprint.mjs';
import { noul } from '../jev.mjs';

// Reviewable in one place.
export const FLOP = {
  views: 100_000, minAgeDays: 7, maxDays: 90, capUsd: 2, jevCallUsd: 0.0002,
  pageBaseline: false, // owner 2026-09-25: page size doesn't decide virality; the baseline is ours vs competitors only
  rounds: 4, perRound: 8, maxQuestions: 12, minGain: 0.002,
  prior: 5, holdout: 0.25, valid: 0.15,
  bootstrap: 300, seed: 20260925, passAuc: 0.65, minPageN: 3, lines: 5,
  exclude: new Set(['AI Evolution']),
  lanes: new Set(['Cover', 'Harvest', 'Seed', 'Remix', 'Blitz']),
};

export const CORPUS = join(HERE_DIR, 'learnings', 'flop-corpus.jsonl');
export const ANSWERS = join(HERE_DIR, 'learnings', 'flop-answers.jsonl');
export const RESULT = join(HERE_DIR, 'learnings', 'flop-research.json');
export const REPORT = join(HERE_DIR, 'learnings', 'flop-research.md');

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const pct = (x) => `${Math.round(100 * x)}%`;
const LINK_RE = /https?:\/\/|t\.co\/|\{\{LINK\}\}|amzn\.|lvnta/i;

// ---- corpus rows (pure) -------------------------------------------------------------------------------

/** PURE. Registry record -> our thread row, or null (not a thread lane, AI Evolution, too young/old, unmeasured). */
export function oursRow(rec, { now = Date.now(), days = FLOP.maxDays } = {}) {
  const f = rec?.fields || {};
  if (!FLOP.lanes.has(f.Type) || !['Posted', 'Reposted'].includes(f.Status) || FLOP.exclude.has(f.Account)) return null;
  const age = (now - Date.parse(f['Posted Date'])) / 864e5;
  if (!(age >= FLOP.minAgeDays && age <= days)) return null;
  const views = Number(f.Impressions);
  let curve = null;
  try { curve = JSON.parse(f['Tweet Views'] || 'null'); } catch { curve = null; }
  if (!Number.isFinite(views) || views <= 0 || !Array.isArray(curve) || curve.length < 3) return null;
  const plugIdx = String(f['Plug Tweets'] || '').split(',').map(Number).filter((n) => n >= 1);
  return {
    origin: 'ours', id: String(f['Draft ID'] || rec.id), account: String(f.Account), postedAt: f['Posted Date'], views,
    curve: curve.map((c) => Number(c.v) || 0), plugIdx, fuel: String(f['Fuel Tiers'] || ''), xUrl: f['X URL'] || null,
  };
}

/** PURE. Swipe head + its tweet records -> a competitor thread row, or null. Plugs: tweets carrying a link. */
export function swipeThread(head, tweetRecs = [], { now = Date.now() } = {}) {
  const f = head?.fields || {};
  const handle = String(f['Tweet URL'] || '').match(/x\.com\/([^/?#]+)/i)?.[1];
  const views = Number(f.Impressions);
  if (!handle || !Number.isFinite(views) || views <= 0 || !f['Published Date']) return null;
  // Same 7-day floor as our threads: a young thread's views are still climbing, so it isn't a flop yet.
  if (!((now - Date.parse(f['Published Date'])) / 864e5 >= FLOP.minAgeDays)) return null;
  const rest = tweetRecs.map((r) => r.fields || {}).filter((t) => Number(t['Tweet Number']) > 1)
    .sort((a, b) => Number(a['Tweet Number']) - Number(b['Tweet Number']));
  if (rest.length < 2) return null;
  const tweets = [String(f.Text || ''), ...rest.map((t) => String(t.Text || ''))];
  const curve = [views, ...rest.map((t) => Number(t.Impressions) || 0)];
  return {
    origin: 'swipe', id: head.id, account: `@${handle.toLowerCase()}`, postedAt: f['Published Date'], views, curve, tweets,
    plugIdx: tweets.map((t, i) => (LINK_RE.test(t) ? i + 1 : 0)).filter(Boolean), source: f.Source || null,
  };
}

// ---- labels and features (pure) -------------------------------------------------------------------------

/**
 * PURE. Adds `flop`: under 100k views, for our pages and competitors alike. Page size does not decide
 * virality (owner, 2026-09-25: "any page can go viral and big pages are actually disadvantaged compared
 * to accounts under 1k"), so no per-page or per-creator bar.
 */
export function labelFlops(rows) {
  return rows.map((r) => ({ ...r, flop: r.views < FLOP.views }));
}

/** PURE. CTA position/count and retention from the per-tweet views (metrics.mjs plugFunnel, the registry's own maths). */
export function features(row) {
  const texts = row.tweets || [];
  const series = row.curve.map((v, i) => ({ i: i + 1, v, c: 0, text: texts[i] || '' }));
  const plugs = [...new Set(row.plugIdx || [])].filter((p) => p >= 2 && p <= row.curve.length).sort((a, b) => a - b);
  const f = plugFunnel(series, plugs);
  return {
    firstCta: plugs[0] ?? null, ctaCount: plugs.length, length: row.curve.length,
    readThrough: f.readThrough, ctaDrop: f.postPlugDrop, t2: row.curve[0] > 0 ? row.curve[1] / row.curve[0] : null,
  };
}

export const BUCKETS = {
  firstCta: ({ x }) => (x.firstCta == null ? 'no CTA' : x.firstCta <= 3 ? 'tweet 2–3' : x.firstCta <= 5 ? 'tweet 4–5' : x.firstCta <= 7 ? 'tweet 6–7' : 'tweet 8+'),
  ctaCount: ({ x }) => (x.ctaCount >= 4 ? '4+' : String(x.ctaCount)),
};

/** PURE. Tercile labels ('low'|'mid'|'high') of `key` within one origin. */
export function terciles(rows, key) {
  const vals = rows.map((r) => r.x[key]).filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = vals[Math.floor(vals.length / 3)], q2 = vals[Math.floor((2 * vals.length) / 3)];
  return (r) => (!Number.isFinite(r.x[key]) ? null : r.x[key] < q1 ? 'low' : r.x[key] < q2 ? 'mid' : 'high');
}

// ---- within-page comparison (pure) ------------------------------------------------------------------------

/**
 * PURE. Hit rate inside vs outside a group, pooled over all threads (`diff`), plus the same-page
 * Mantel-Haenszel difference (`samePage`) and how many pages (3+ threads each side) agree in direction.
 */
export function withinPage(rows, isIn) {
  const pages = new Map();
  for (const r of rows) {
    const inside = isIn(r);
    if (inside == null) continue;
    const p = pages.get(r.account) || pages.set(r.account, { a: 0, na: 0, b: 0, nb: 0 }).get(r.account);
    if (inside) { p.na++; if (!r.flop) p.a++; } else { p.nb++; if (!r.flop) p.b++; }
  }
  let num = 0, den = 0, nIn = 0, hitIn = 0, nOut = 0, hitOut = 0, eligible = 0, holding = 0, lower = 0;
  for (const p of pages.values()) {
    nIn += p.na; hitIn += p.a; nOut += p.nb; hitOut += p.b;
    if (!p.na || !p.nb) continue;
    const w = (p.na * p.nb) / (p.na + p.nb);
    num += w * (p.a / p.na - p.b / p.nb); den += w;
    if (p.na >= FLOP.minPageN && p.nb >= FLOP.minPageN) { eligible++; if (p.a / p.na > p.b / p.nb) holding++; else if (p.a / p.na < p.b / p.nb) lower++; }
  }
  const rateIn = nIn ? hitIn / nIn : null, rateOut = nOut ? hitOut / nOut : null;
  // The finding is the POOLED difference (owner, 2026-09-25: page size doesn't decide virality). The
  // same-page difference and the page counts stay as a consistency check: a real pattern shows up on
  // most pages, one page's streak does not.
  return { diff: rateIn != null && rateOut != null ? rateIn - rateOut : null, samePage: den ? num / den : null, nIn, nOut, rateIn, rateOut, pages: eligible, pagesHolding: holding, pagesLower: lower };
}

/** PURE. A finding must agree on at least half of the pages with 3+ threads each side (when there are 3+ such pages). */
export function agrees(w) {
  if (w.diff == null || w.pages < 3) return true;
  return (w.diff > 0 ? w.pagesHolding : w.pagesLower) >= Math.ceil(w.pages / 2);
}

export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** PURE. 95% bootstrap interval of a statistic over rows (resampled with a fixed seed). */
export function bootstrap(rows, stat, { n = FLOP.bootstrap, seed = FLOP.seed } = {}) {
  const rand = rng(seed); const out = [];
  for (let k = 0; k < n; k++) {
    const s = rows.map(() => rows[Math.floor(rand() * rows.length)]);
    const v = stat(s); if (Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.length ? [out[Math.floor(out.length * 0.025)], out[Math.floor(out.length * 0.975)]] : [null, null];
}

/** PURE. Every bucket of every hypothesis, per origin, with its within-page difference and interval. */
export function hypotheses(rows, { boot = FLOP.bootstrap } = {}) {
  const out = [];
  for (const origin of ['ours', 'swipe']) {
    const rs = rows.filter((r) => r.origin === origin);
    if (rs.length < 30) continue;
    // Competitor retention is left out: the swipe DB refreshes a thread's head views days after its
    // other tweets (34 of 40 checked 2026-09-25, median 4.8 days), so their ratios compare two dates.
    const retention = origin === 'ours' ? { readThrough: terciles(rs, 'readThrough'), t2: terciles(rs, 't2'), ctaDrop: terciles(rs.filter((r) => r.x.firstCta), 'ctaDrop') } : {};
    const groupers = { ...BUCKETS, ...retention };
    for (const [feature, g] of Object.entries(groupers)) {
      const labels = [...new Set(rs.map(g).filter((v) => v != null))];
      for (const bucket of labels) {
        const isIn = (r) => { const v = g(r); return v == null ? null : v === bucket; };
        const w = withinPage(rs, isIn);
        if (w.nIn < 15 || w.nOut < 15 || w.diff == null) continue;
        const [lo, hi] = boot ? bootstrap(rs, (s) => withinPage(s, isIn).diff, { n: boot }) : [null, null];
        out.push({ origin, feature, bucket, ...w, diff: round(w.diff), lo: round(lo), hi: round(hi), rateIn: round(w.rateIn), rateOut: round(w.rateOut), clear: lo != null && (lo > 0 || hi < 0) && agrees(w) });
      }
    }
  }
  return out;
}

// ---- the model: page baseline + Jev answers (pure) --------------------------------------------------------

/**
 * PURE. Each row's page hit rate, learned from `fitRows` only (the training split), shrunk toward the
 * origin's rate, as a logit offset. Never leave-one-out: dropping a row's own label from its page rate
 * biases every hit down and every flop up, which scores the baseline below chance within a page.
 */
export function pageOffsets(fitRows, rows = fitRows) {
  const by = new Map(), base = new Map();
  for (const r of fitRows) {
    const p = by.get(`${r.origin}|${r.account}`) || by.set(`${r.origin}|${r.account}`, { hit: 0, n: 0 }).get(`${r.origin}|${r.account}`); p.n++; if (!r.flop) p.hit++;
    const b = base.get(r.origin) || base.set(r.origin, { hit: 0, n: 0 }).get(r.origin); b.n++; if (!r.flop) b.hit++;
  }
  return rows.map((r) => {
    const b = base.get(r.origin) || { hit: 1, n: 2 };
    const p = FLOP.pageBaseline ? (by.get(`${r.origin}|${r.account}`) || { hit: 0, n: 0 }) : { hit: 0, n: 0 };
    const q = Math.min(0.98, Math.max(0.02, (p.hit + FLOP.prior * (b.hit / b.n)) / (p.n + FLOP.prior)));
    return Math.log(q / (1 - q));
  });
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** PURE. Logistic regression of HIT on centred features with a fixed offset, L2. Returns {w, means}. */
export function fitLogit(X, y, offset, { lambda = 1, iters = 300, lr = 0.5 } = {}) {
  const d = X[0]?.length || 0;
  const means = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const w = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < X.length; i++) {
      let z = offset[i] + w[d];
      for (let j = 0; j < d; j++) z += w[j] * (X[i][j] - means[j]);
      const e = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) g[j] += e * (X[i][j] - means[j]);
      g[d] += e;
    }
    for (let j = 0; j <= d; j++) w[j] -= lr * (g[j] / X.length + (j < d ? (lambda * w[j]) / X.length : 0));
  }
  return { w, means };
}

export function predictLogit(model, X, offset) {
  const d = model.means.length;
  return X.map((x, i) => { let z = offset[i] + model.w[d]; for (let j = 0; j < d; j++) z += model.w[j] * (x[j] - model.means[j]); return sigmoid(z); });
}

export function logLoss(p, y) { let s = 0; for (let i = 0; i < p.length; i++) s -= y[i] ? Math.log(Math.max(1e-9, p[i])) : Math.log(Math.max(1e-9, 1 - p[i])); return s / p.length; }

/** PURE. Oldest -> train, next -> valid, newest -> holdout (the loop never sees the holdout). */
export function splitByTime(rows) {
  const s = [...rows].sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)));
  const h = Math.floor(s.length * (1 - FLOP.holdout)), v = Math.floor(s.length * (1 - FLOP.holdout - FLOP.valid));
  return { train: s.slice(0, v), valid: s.slice(v, h), holdout: s.slice(h) };
}

/** PURE. Greedy: add each candidate question if it lowers validation log-loss by minGain; cap maxQuestions. */
export function selectQuestions({ keys, answer, split, offsets, kept = [] }) {
  const ids = new Map(); [...split.train, ...split.valid].forEach((r, i) => ids.set(r.id + r.origin, i));
  const Xof = (rows, ks) => rows.map((r) => ks.map((k) => answer(r, k) ?? 0.5));
  const yof = (rows) => rows.map((r) => (r.flop ? 0 : 1));
  const off = (rows) => rows.map((r) => offsets.get(r.id + r.origin));
  const score = (ks) => {
    if (!ks.length) return logLoss(split.valid.map((r, i) => sigmoid(off(split.valid)[i])), yof(split.valid));
    const m = fitLogit(Xof(split.train, ks), yof(split.train), off(split.train));
    return logLoss(predictLogit(m, Xof(split.valid, ks), off(split.valid)), yof(split.valid));
  };
  let chosen = [...kept]; let best = score(chosen);
  for (const k of keys) {
    if (chosen.includes(k) || chosen.length >= FLOP.maxQuestions) continue;
    const s = score([...chosen, k]);
    if (best - s >= FLOP.minGain) { chosen.push(k); best = s; }
  }
  return { chosen, validLoss: round(best, 4) };
}

/** PURE. Retire a kept question when dropping it costs less than minGain on validation (it stopped predicting). */
export function pruneQuestions({ kept, answer, split, offsets }) {
  const yof = (rows) => rows.map((r) => (r.flop ? 0 : 1));
  const off = (rows) => rows.map((r) => offsets.get(r.id + r.origin));
  const loss = (ks) => {
    if (!ks.length) return logLoss(off(split.valid).map(sigmoid), yof(split.valid));
    const X = (rows) => rows.map((r) => ks.map((k) => answer(r, k) ?? 0.5));
    return logLoss(predictLogit(fitLogit(X(split.train), yof(split.train), off(split.train)), X(split.valid), off(split.valid)), yof(split.valid));
  };
  let cur = [...kept];
  for (const k of kept) {
    const without = cur.filter((x) => x !== k);
    if (loss(without) - loss(cur) < FLOP.minGain) cur = without;
  }
  return cur;
}

// ---- the report (pure) -----------------------------------------------------------------------------------

const FEATURE_TEXT = {
  firstCta: (b) => (b === 'no CTA' ? 'No CTA at all' : `First CTA at ${b}`),
  ctaCount: (b) => `${b} CTA${b === '1' ? '' : 's'} in the thread`,
  readThrough: (b) => `${b[0].toUpperCase() + b.slice(1)} read-through (last tweet ÷ tweet 1)`,
  t2: (b) => `${b[0].toUpperCase() + b.slice(1)} tweet 1 → 2 retention`,
  ctaDrop: (b) => `${b[0].toUpperCase() + b.slice(1)} extra drop right after the first CTA`,
};

const EXPERIMENT = {
  firstCta: (h) => (h.diff > 0 ? `put the first CTA at ${h.bucket} on half of the covers` : `move the first CTA out of ${h.bucket} on half of the covers`),
  ctaCount: (h) => (h.diff > 0 ? `use ${h.bucket.replace('+', ' or more')} CTAs on half of the covers` : `avoid ${h.bucket} CTAs on half of the covers`),
  readThrough: () => 'cut one body tweet and tighten tweets 2–3 on half of the covers (retention is an outcome; this tests a lever for it)',
  t2: () => 'rewrite tweet 2 to pay off the hook immediately on half of the covers',
  ctaDrop: (h) => (h.diff > 0 ? 'keep the tweet after the first CTA a strong content beat on half of the covers' : 'follow the first CTA with the thread\'s strongest point on half of the covers'),
  question: (q) => (q.diff > 0 ? `on half of the covers, write so the answer is yes: ${q.text}` : `on half of the covers, write so the answer is no: ${q.text}`),
};

/** PURE. The ranked findings: clear hypothesis buckets and kept questions, strongest first. */
export function findings(result) {
  const hs = (result.hypotheses || []).filter((h) => h.clear).map((h) => ({ kind: 'hypothesis', ...h, strength: Math.abs(h.diff) }));
  const qs = (result.questions?.kept || []).filter((q) => q.clear).map((q) => ({ kind: 'question', ...q, strength: Math.abs(q.diff) }));
  // One line per hypothesis (its strongest bucket), so "low" and "high" of one measure never fill two lines.
  const best = new Map();
  for (const f of [...hs, ...qs].sort((a, b) => b.strength - a.strength)) {
    const k = f.kind === 'question' ? (f.qid ?? f.key) : `${f.origin}|${f.feature}`;
    if (!best.has(k)) best.set(k, f);
  }
  return [...best.values()];
}

export function findingLine(f) {
  const who = f.origin === 'swipe' ? 'competitors' : f.origin === 'ours' ? 'ours' : 'ours + competitors';
  const what = f.kind === 'question' ? `“${f.text}”` : FEATURE_TEXT[f.feature](f.bucket);
  return `${what} → ${pct(f.rateIn)} hits vs ${pct(f.rateOut)} (${f.diff > 0 ? '+' : ''}${Math.round(100 * f.diff)} pts) · ${who} n=${f.nIn} · holds on ${f.diff < 0 ? f.pagesLower ?? f.pages - f.pagesHolding : f.pagesHolding}/${f.pages} pages`;
}

export function experimentFor(f) { return f.kind === 'question' ? EXPERIMENT.question(f) : EXPERIMENT[f.feature](f); }

export function renderReport(result) {
  const top = findings(result).slice(0, FLOP.lines - 1);
  const m = result.model || {};
  const verdict = m.holdoutAuc == null ? 'model not scored' : `model (our threads): holdout AUC ${m.holdoutAuc} vs chance ${m.baselineAuc} → ${m.pass ? 'PASS' : `advisory (bar ${FLOP.passAuc})`}`;
  const lines = [
    `# Flop research — ${result.builtAt.slice(0, 10)} · last ${result.window.days} days · ours n=${result.n.ours} · competitors n=${result.n.swipe}`,
    '',
    ...(top.length ? top.map((f, i) => `${i + 1}. ${findingLine(f)}`) : ['1. Nothing cleared noise this week (every difference sits inside its 95% interval).']),
    `${Math.max(top.length, 1) + 1}. ${verdict}`,
    '',
    '_A flop is under 100k views after 7 days, for every page (page size does not decide virality). Differences pool all threads; "holds on X/Y pages" counts pages that agree. Findings listed only when their 95% interval excludes zero and at least half the pages agree._',
    '',
    '## Detail: the three hypotheses',
    '',
    '| Who | Hypothesis | Bucket | Hits in | Hits out | Diff | 95% | Same-page diff | n | Pages |',
    '|:--|:--|:--|--:|--:|--:|:--|--:|--:|--:|',
    ...(result.hypotheses || []).map((h) => `| ${h.origin === 'swipe' ? 'competitors' : 'ours'} | ${h.feature} | ${h.bucket} | ${pct(h.rateIn)} | ${pct(h.rateOut)} | ${h.diff > 0 ? '+' : ''}${Math.round(100 * h.diff)} | ${h.lo == null ? '—' : `${Math.round(100 * h.lo)}…${Math.round(100 * h.hi)}`} | ${h.samePage == null ? '—' : Math.round(100 * h.samePage)} | ${h.nIn} | ${h.pagesHolding}/${h.pages} |`),
    '',
    '## Detail: questions Jev answers',
    '',
    '| Question | Weight | Hits yes | Hits no | Diff | n yes |',
    '|:--|--:|--:|--:|--:|--:|',
    ...(result.questions?.kept || []).map((q) => `| ${q.text} | ${q.weight} | ${pct(q.rateIn)} | ${pct(q.rateOut)} | ${q.diff > 0 ? '+' : ''}${Math.round(100 * q.diff)} | ${q.nIn} |`),
    '',
    `Spend: $${result.spend.usd} of the $${FLOP.capUsd} cap · Jev calls ${result.spend.jevCalls} · proposer calls ${result.spend.llmCalls}${result.spend.capped ? ' · **stopped at the cap**' : ''}.`,
    ...(result.notes || []).map((n) => `- ${n}`),
    '',
  ];
  return lines.join('\n');
}

export function renderBrief(result, n = 3) {
  const top = findings(result).slice(0, n);
  if (!top.length) return `Flop research (${result.builtAt.slice(0, 10)}): nothing cleared noise yet — no experiment suggested.`;
  return [`Flop research (${result.builtAt.slice(0, 10)}, last ${result.window.days} days) — pick any to test this run:`,
    ...top.map((f, i) => `${i + 1}. ${findingLine(f)}\n   Try: ${experimentFor(f)}`)].join('\n');
}

// ---- I/O --------------------------------------------------------------------------------------------------

const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

async function fetchCorpus(env, { days, now }) {
  const reg = airtable(env, env.REGISTRY_BASE_ID);
  const raw = await reg.listAll(REGISTRY_TABLE, {
    formula: `IS_AFTER({Posted Date}, DATEADD(TODAY(), -${days}, 'days'))`,
    fields: ['Draft ID', 'Account', 'Posted Date', 'Impressions', 'Type', 'Status', 'X URL', 'Tweet Views', 'Plug Tweets', 'Fuel Tiers'],
  });
  const ours = (Array.isArray(raw) ? raw : raw.items || []).map((r) => oursRow(r, { now, days })).filter(Boolean);
  const cached = new Map(readJsonl(CORPUS).filter((r) => r.origin === 'ours' && r.tweets?.length).map((r) => [r.id, r.tweets]));
  const byName = new Map(Object.values(ACCOUNTS).map((a) => [a.name, a]));
  const tf = typefully(env);
  for (let i = 0; i < ours.length; i += 8) {
    await Promise.all(ours.slice(i, i + 8).map(async (r) => {
      if (cached.has(r.id)) { r.tweets = cached.get(r.id); return; }
      const acc = byName.get(r.account);
      if (!acc?.socialSetId || !/^\d+$/.test(r.id)) return;
      try { r.tweets = ((await tf.getDraft(acc.socialSetId, r.id))?.platforms?.x?.posts || []).map((p) => String(p.text || '')); } catch { /* text unread: CTA/retention still measured */ }
    }));
  }
  const sw = airtable(env);
  const heads = await sw.list(TABLES.swipe, {
    formula: `AND({Tweet Number}=1,{Thread Length}>=3,IS_AFTER({Published Date},DATEADD(NOW(),-${days},"days")))`,
    fields: ['Text', 'Impressions', 'Published Date', 'Tweet URL', 'Tweets', 'Source'], max: 20000, pageSize: 100,
  });
  const ids = heads.flatMap((h) => h.fields.Tweets || []);
  const tweetRecs = new Map();
  // A folded thread's body tweets have no rows to query: the client already holds them (thread-fold.mjs).
  for (const id of ids) { const v = sw.foldedRecord?.(id); if (v) tweetRecs.set(id, v); }
  const rowIds = ids.filter((id) => !tweetRecs.has(id));
  for (let i = 0; i < rowIds.length; i += 50) {
    const chunk = rowIds.slice(i, i + 50);
    const recs = await sw.list(TABLES.swipe, { formula: `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`, fields: ['Text', 'Impressions', 'Tweet Number'], max: 100, pageSize: 100 });
    for (const r of recs) tweetRecs.set(r.id, r);
  }
  const swipe = heads.map((h) => swipeThread(h, (h.fields.Tweets || []).map((id) => tweetRecs.get(id)).filter(Boolean), { now })).filter(Boolean);
  const rows = [...ours, ...swipe];
  writeFileSync(CORPUS, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows;
}

/** PURE. True when `text` shares a run of `n` words with any source text (a copied phrase). */
export function copiesSource(text, sources, n = 5) {
  const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const grams = new Set();
  for (const src of sources) { const w = words(src); for (let i = 0; i + n <= w.length; i++) grams.add(w.slice(i, i + n).join(' ')); }
  const w = words(text);
  for (let i = 0; i + n <= w.length; i++) if (grams.has(w.slice(i, i + n).join(' '))) return true;
  return false;
}

/** The questions an LLM proposes from the threads the model misjudged most. Returns [{key, text, yes, no}]. */
async function proposeQuestions(env, { worst, existing, n }) {
  const { anthropic } = await import('../lib.mjs');
  const sample = worst.map((r) => `${r.flop ? 'FLOPPED' : 'HIT'} (${r.origin}, predicted hit ${Math.round(100 * r.p)}%)\n${(r.tweets || []).slice(0, 4).map((t, i) => `T${i + 1}: ${t.slice(0, 280)}`).join('\n')}`).join('\n\n---\n\n');
  const text = await anthropic(env, {
    role: 'aux', max_tokens: 2000,
    system: 'You study X (Twitter) threads for a content team. You write yes/no questions a literal reader could answer from the thread text alone, that might separate threads that go viral from threads that flop. No counting, no dates, no positions like "tweet 5". Each question tests one idea. Never quote or copy any phrase from the threads: describe patterns in your own words.',
    messages: [{ role: 'user', content: `Existing questions (do not repeat):\n${existing.map((q) => `- ${q}`).join('\n') || '- none'}\n\nThreads the current model got most wrong:\n\n${sample}\n\nPropose ${n} new questions. Reply with JSON only: [{"text": "Does the thread ...?", "yes": "what a yes looks like", "no": "what a no looks like"}]` }],
  });
  const json = String(text).match(/\[[\s\S]*\]/)?.[0];
  let arr = [];
  try { arr = JSON.parse(json || '[]'); } catch { arr = []; }
  // The bank is committed, and the threads shown here include competitors' copy: a proposal that copies
  // a phrase from them (5+ words in a row) is dropped, so no thread text reaches the repo.
  const sources = worst.flatMap((r) => r.tweets || []);
  return arr.filter((q) => q && typeof q.text === 'string' && q.text.length > 10 && q.text.length < 240 && q.yes && q.no)
    .filter((q) => ![q.text, q.yes, q.no].some((t) => copiesSource(t, sources)))
    .slice(0, n).map((q) => ({ key: `q_${sha(q.text).slice(0, 10)}`, text: q.text.trim(), yes: String(q.yes).slice(0, 300), no: String(q.no).slice(0, 300) }));
}

export const threadState = (r) => ({ tweets: (r.tweets || []).slice(0, 12).map((t, i) => ({ id: `T${i + 1}`, text: String(t).slice(0, 500) })) });

async function main() {
  const env = { ...loadEnv(), TYPESAFE_DEFAULT_MODEL: 'jev-1.13' };
  const days = Math.min(FLOP.maxDays, Math.max(14, Number(cliArg('days', FLOP.maxDays)) || FLOP.maxDays));
  if (process.argv.includes('--brief')) {
    if (!existsSync(RESULT)) { console.log('Flop research: no report yet (run scripts/flop-research.mjs first).'); return; }
    console.log(renderBrief(JSON.parse(readFileSync(RESULT, 'utf8')))); return;
  }
  const now = Date.now();
  const offline = process.argv.includes('--offline');
  if (!offline) requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'XDB_BASE_ID', 'TYPEFULLY_API_KEY']);
  const raw = offline || process.argv.includes('--no-refresh') ? readJsonl(CORPUS) : await fetchCorpus(env, { days, now });
  // The 7-day floor again on the loaded corpus: a cached row can be younger than 7 days as of this run's fetch.
  const rows = labelFlops(raw.filter((r) => (now - Date.parse(r.postedAt)) / 864e5 >= FLOP.minAgeDays)).map((r) => ({ ...r, x: features(r) }));
  const notes = ['Competitor retention not measured: the swipe DB refreshes head views days after the other tweets.', 'Retention is measured on the same posts it is compared with, so it shows an association, not a cause.'];
  const prev = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : null;

  // 1. The owner's hypotheses (code only, $0).
  const hyp = hypotheses(rows);

  // 2. The question loop (Jev + an LLM proposer), inside the budget.
  let jevCalls = 0, llmCalls = 0, capped = false;
  // Conservative: the metered spend plus an estimate for every Jev call, so the $2 cap can only trip early.
  const spent = () => llmSpendSummary().costUsd + jevCalls * FLOP.jevCallUsd;
  const answers = new Map(readJsonl(ANSWERS).map((a) => [a.k, a.p]));
  const withText = rows.filter((r) => (r.tweets || []).filter(Boolean).length >= 2);
  const split = splitByTime(withText);
  const offs = pageOffsets(split.train, withText); const offsets = new Map(withText.map((r, i) => [r.id + r.origin, offs[i]]));
  // The committed file names a question's hash `qid`, not `key`: a secret scanner reads `"key": "q_<hex>"` as an API key.
  const fromDisk = (q) => ({ ...q, key: q.key ?? q.qid });
  const bank = new Map((prev?.questions?.bank || []).map(fromDisk).map((q) => [q.key, q]));
  const keyOf = (r, q) => sha(`${r.origin}|${r.id}|${q}`).slice(0, 24);
  const answer = (r, key) => answers.get(keyOf(r, key));
  // Belt and braces: drop any banked question that shares a 5-word run with any thread in the corpus.
  const allText = rows.flatMap((r) => r.tweets || []);
  for (const [k, q] of bank) if ([q.text, q.yes, q.no].some((t) => copiesSource(t, allText))) { bank.delete(k); notes.push(`dropped question ${k}: it copied a thread phrase`); }
  let kept = (prev?.questions?.kept || []).map((q) => q.key ?? q.qid).filter((k) => bank.has(k));
  let client = null, ask = null;
  if (!offline && env.OPENROUTER_API_KEY) {
    const [{ jev }, { askThrough }] = await Promise.all([import('../jev.mjs'), import('../jev-decide.mjs')]); // optional-import
    client = jev(env); ask = askThrough;
  } else notes.push('Jev not called (offline or no OPENROUTER_API_KEY): questions not re-read this run.');

  async function readAll(qs, targets) {
    const todo = targets.filter((r) => qs.some((q) => !answers.has(keyOf(r, q.key))));
    for (let i = 0; i < todo.length; i += 12) {
      if (spent() + 12 * FLOP.jevCallUsd > FLOP.capUsd) { capped = true; return; }
      await Promise.all(todo.slice(i, i + 12).map(async (r) => {
        const need = qs.filter((q) => !answers.has(keyOf(r, q.key)));
        const questions = Object.fromEntries(need.map((q) => [q.key, noul(q.text, { true: q.yes, false: q.no })]));
        try {
          const res = await ask('flop-read', client, { state: threadState(r), questions }, { subject: `${r.origin}:${r.id}` });
          jevCalls++;
          for (const q of need) {
            const p = res.answers?.[q.key]?.noul;
            if (Number.isFinite(p)) { answers.set(keyOf(r, q.key), p); appendFileSync(ANSWERS, JSON.stringify({ k: keyOf(r, q.key), p: round(p, 4) }) + '\n'); }
          }
        } catch { jevCalls++; }
      }));
    }
  }

  const loopRows = [...split.train, ...split.valid];
  if (client) {
    await readAll([...bank.values()].filter((q) => kept.includes(q.key)), withText);
    kept = pruneQuestions({ kept, answer, split, offsets });
    for (let round_ = 0; round_ < FLOP.rounds && !capped; round_++) {
      const cur = kept.length ? fitLogit(split.train.map((r) => kept.map((k) => answer(r, k) ?? 0.5)), split.train.map((r) => (r.flop ? 0 : 1)), split.train.map((r) => offsets.get(r.id + r.origin))) : null;
      const p = cur ? predictLogit(cur, loopRows.map((r) => kept.map((k) => answer(r, k) ?? 0.5)), loopRows.map((r) => offsets.get(r.id + r.origin))) : loopRows.map((r) => sigmoid(offsets.get(r.id + r.origin)));
      const worst = loopRows.map((r, i) => ({ ...r, p: p[i], err: Math.abs((r.flop ? 0 : 1) - p[i]) })).sort((a, b) => b.err - a.err).slice(0, 12);
      if (spent() > FLOP.capUsd * 0.9) { capped = true; break; }
      let fresh = [];
      try { fresh = await proposeQuestions(env, { worst, existing: [...bank.values()].map((q) => q.text), n: FLOP.perRound }); llmCalls++; } catch (e) { notes.push(`proposer failed in round ${round_ + 1}: ${e.message}`); break; }
      fresh = fresh.filter((q) => !bank.has(q.key));
      for (const q of fresh) bank.set(q.key, q);
      await readAll(fresh, loopRows);
      kept = selectQuestions({ keys: fresh.map((q) => q.key), answer, split, offsets, kept }).chosen;
    }
    if (kept.length) await readAll([...bank.values()].filter((q) => kept.includes(q.key)), split.holdout);
  }

  // 3. The locked holdout: model vs the page baseline.
  const Xof = (rs) => rs.map((r) => kept.map((k) => answer(r, k) ?? 0.5));
  const yof = (rs) => rs.map((r) => (r.flop ? 0 : 1));
  const off = (rs) => rs.map((r) => offsets.get(r.id + r.origin));
  let model = { holdoutAuc: null, baselineAuc: null, pass: false, n: split.holdout.length };
  if (split.holdout.length >= 30 && split.train.length >= 60) {
    const m = kept.length ? fitLogit(Xof(loopRows), yof(loopRows), off(loopRows)) : null;
    // Scored on OUR threads only: mixing in competitors (who hit far more often) would let the base rate
    // alone look predictive, and our drafts are what the score is for.
    const hold = split.holdout.filter((r) => r.origin === 'ours');
    const pm = m ? predictLogit(m, Xof(hold), off(hold)) : off(hold).map(sigmoid);
    const pb = off(hold).map(sigmoid);
    const y = yof(hold);
    const idx = hold.map((_, i) => i);
    const [lo] = bootstrap(idx, (s) => auc(s.map((i) => pm[i]), s.map((i) => y[i])) - auc(s.map((i) => pb[i]), s.map((i) => y[i])));
    const a = auc(pm, y), b = auc(pb, y);
    model = { holdoutAuc: round(a), baselineAuc: Number.isFinite(b) ? round(b) : 0.5, diffLo: round(lo), pass: a >= FLOP.passAuc && lo > 0, n: hold.length, weights: m ? Object.fromEntries(kept.map((k, j) => [k, round(m.w[j])])) : {} };
  }

  const keptOut = kept.map((k) => {
    const q = bank.get(k);
    const w = withinPage(withText.filter((r) => answer(r, k) != null), (r) => answer(r, k) >= 0.5);
    const [lo, hi] = bootstrap(withText.filter((r) => answer(r, k) != null), (s) => withinPage(s, (r) => answer(r, k) >= 0.5).diff);
    return { key: k, text: q.text, weight: model.weights?.[k] ?? null, origin: 'all', ...w, diff: round(w.diff), lo: round(lo), hi: round(hi), rateIn: round(w.rateIn), rateOut: round(w.rateOut), clear: lo != null && (lo > 0 || hi < 0) && agrees(w) };
  });
  const toDisk = ({ key, ...q }) => ({ qid: key, ...q });
  const retired = [...bank.values()].filter((q) => !kept.includes(q.key)).map((q) => q.key);
  const result = {
    builtAt: new Date(now).toISOString(), window: { days }, rule: { flopViews: FLOP.views, minAgeDays: FLOP.minAgeDays, excluded: [...FLOP.exclude] },
    n: { ours: rows.filter((r) => r.origin === 'ours').length, swipe: rows.filter((r) => r.origin === 'swipe').length, withText: withText.length, flopsOurs: rows.filter((r) => r.origin === 'ours' && r.flop).length },
    hypotheses: hyp, questions: { kept: keptOut.map(toDisk), bank: [...bank.values()].map(toDisk), retired }, model,
    spend: { usd: round(spent(), 2), jevCalls, llmCalls, capped }, notes,
  };
  writeFileSync(RESULT, JSON.stringify(result, null, 1) + '\n');
  writeFileSync(REPORT, renderReport(result));
  console.log(renderReport(result).split('\n').slice(0, FLOP.lines + 2).join('\n'));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await runMain(main, 'flop-research');
