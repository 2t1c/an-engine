// hook-fingerprint.mjs — what our hooks that spread have in common, in words (owner, 2026-09-24:
// "Specific word choice, phrases, patterns and linguistic fingerprint is what we are looking for …
// it slots right into the position you suggested. And even for hook rewrite").
//
// Built from OUR recent threads only (scripts/hook-corpus.mjs; 30 days by default, never more than 90:
// "everything prior is noise and the algo changed maybe"). The target is virality, not money:
// lift = log(views / the account's median views in the window), so a big page's ordinary post does not
// outrank a small page's breakout.
//
//   code   the linguistic fingerprint: words, 2- and 3-word phrases, the opener, numbers, pronouns,
//          line shape, punctuation (hookFeatures) — exact and cheap, and every one explainable
//   Jev    reads each hook once for what words cannot say: its shape (list, warning, sign, story…) and
//          eleven yes/no checks (names the reader, promises a payoff, withholds the answer, reads as an ad…)
//   code   fits a ridge model of lift on both, backtests it on the newest posts it did not see, and
//          scores any hook: /100, the % of our window it beats, the patterns it carries or misses, and
//          the five nearest hooks that spread
//
// Jev decides the checks; the writer (hook-pick) explains and rewrites with the failed patterns and the
// nearest winners in front of it. Nothing here writes a hook.
import { createHash } from 'node:crypto';
import { choice, noul } from './jev.mjs';

// ---- the linguistic fingerprint (code) ------------------------------------------------------------
export const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'but', 'so', 'if', 'its', "it's"]);
export const EMOJI = /\p{Extended_Pictographic}/u;

/** PURE. Normalised words: lower case, links out, digits kept as '#', curly quotes straightened. */
export function words(text) {
  return String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/\d+([.,]\d+)?/g, '#').replace(/[^a-z#'\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * PURE. The fingerprint of one hook as a set of named features. Word and phrase features carry the
 * words themselves ("w:never", "p2:most people", "p3:over # years"), so a winning pattern reads as
 * what to write, not as a coefficient.
 */
export function hookFeatures(text) {
  const raw = String(text || '').trim();
  const w = words(raw);
  const f = new Set();
  for (const x of w) if (!STOP.has(x)) f.add(`w:${x}`);
  for (let i = 0; i + 1 < w.length; i++) f.add(`p2:${w[i]} ${w[i + 1]}`);
  for (let i = 0; i + 2 < w.length; i++) f.add(`p3:${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  if (w.length) f.add(`open:${w[0]}`);
  if (w.length > 1) f.add(`open:${w[0]} ${w[1]}`);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || '';
  f.add(`shape:lines ${Math.min(lines.length, 5)}${lines.length > 5 ? '+' : ''}`);
  f.add(`shape:words ${w.length <= 12 ? '≤12' : w.length <= 25 ? '13-25' : w.length <= 45 ? '26-45' : '46+'}`);
  f.add(`shape:first line ${words(first).length <= 8 ? 'short' : 'long'}`);
  if (/\d/.test(raw)) f.add('num:any');
  if (/\d+\s?%/.test(raw)) f.add('num:percent');
  if (/\$\s?\d/.test(raw)) f.add('num:money');
  if (/^\s*\d/.test(raw)) f.add('num:leads');
  if (/\b(19|20)\d\d\b/.test(raw)) f.add('num:year');
  if (/\bat \d{2}\b|\b\d{2}[- ]year[- ]old\b|\bover \d{2}\b|\bafter \d{2}\b/i.test(raw)) f.add('num:age');
  if (/^\s*(\d+[.)]|[-•])\s/m.test(raw)) f.add('shape:list marks');
  if (/\?\s*$/.test(first) || /\?/.test(raw)) f.add('punct:question');
  if (/:\s*$/.test(raw)) f.add('punct:ends colon');
  if (/(\.\.\.|…)\s*$/.test(raw)) f.add('punct:ends ellipsis');
  if (/👇|🧵|⬇️/.test(raw)) f.add('punct:points down');
  if (EMOJI.test(raw)) f.add('punct:emoji');
  if (/"[^"]{3,}"|“[^”]{3,}”/.test(raw)) f.add('punct:quote');
  if (/\b[A-Z]{3,}\b/.test(raw.replace(/\b(I|OK|US|UK|USA|DNA|ADHD|CEO|NAD|MCT|EPA|DHA|RDA|FDA)\b/g, ''))) f.add('punct:caps word');
  // Named constructions seen in our spreading hooks, so the pattern reads as a pattern, not as words.
  if ((raw.match(/\S\s?=\s?\S/g) || []).length >= 2) f.add('form:X = Y chain');
  if (/\b(told me|confessed|admitted|revealed|explained|said)\b[^\n]{0,12}[:"“]/i.test(raw)) f.add('form:expert told me + quote');
  if (/\bif I (wanted|were trying) to\b/i.test(raw)) f.add('form:inversion (if I wanted to…)');
  if (/\b\d+\s+(things|signs|rules|ways|habits|foods|mistakes|reasons|steps|supplements|symptoms|hacks)\b/i.test(raw)) f.add('form:N things list');
  if ((raw.match(/[A-Z]/g) || []).length > 0.6 * (raw.match(/[A-Za-z]/g) || []).length && raw.length > 20) f.add('form:all caps');
  if (/\b(dr\.?|doctor|cardiologist|neuroscientist|psychiatrist|scientists?|harvard|stanford|huberman|study|studies|research)\b/i.test(raw)) f.add('form:authority named');
  if (/\b(you|your|you're|yourself)\b/i.test(raw)) f.add('voice:you');
  if (/\b(I|I'm|I've|my|me)\b/.test(raw)) f.add('voice:I');
  if (/\b(he|she|his|her)\b/i.test(raw)) f.add('voice:third person');
  if (/\b(we|our|us)\b/i.test(raw)) f.add('voice:we');
  return f;
}

// ---- the Jev read: shape + eleven checks ------------------------------------------------------------
export const HOOK_SHAPES = Object.freeze({
  list_promise: 'Promises a list or a set of items (habits, foods, signs, steps) the thread will give.',
  warning: 'Warns about a mistake, a danger or something the reader is doing wrong.',
  sign_symptom: 'Names a sign, symptom or body signal and what it means.',
  contrarian: 'Contradicts common advice or a popular belief.',
  story: 'Opens a story about a specific person or event.',
  stat_study: 'Leads with a statistic, a study or a research finding.',
  question: 'Asks the reader a question.',
  authority: 'Quotes or leans on an expert, doctor or famous figure.',
  how_to: 'Promises to show how to do or fix something.',
  confession: 'A first-person admission or experience.',
  other: 'None of the above.',
});

export const HOOK_QUESTIONS = Object.freeze({
  shape: choice('Which ONE of these best describes how `hook` opens a thread?', HOOK_SHAPES),
  names_reader: noul('Does `hook` name a specific reader (an age, a condition, a habit, a group) rather than everyone?', {
    true: 'A specific reader is named or clearly implied: "over 40", "if you wake up at 3am", "women on birth control".',
    false: 'It speaks to anyone; no age, condition, habit or group is singled out.' }),
  payoff: noul('Does `hook` promise a concrete payoff the reader gets by reading on?', {
    true: 'The reader is told what they will get: the list, the fix, the reason, the sign to watch.',
    false: 'No takeaway is promised; it only states something or sets a mood.' }),
  curiosity_gap: noul('Does `hook` hold back the answer so the reader has to read on to get it?', {
    true: 'The key fact (what, which, why) is withheld and only the thread gives it.',
    false: 'The answer is already in the hook, or there is nothing to find out.' }),
  stakes: noul('Does `hook` say what the reader loses or risks by not knowing this?', {
    true: 'A cost, harm, danger or missed benefit is stated or clearly implied.',
    false: 'Nothing is at stake for the reader.' }),
  specific: noul('Is `hook` concrete: a named thing, number, time or body part rather than a general claim?', {
    true: 'It names specific things: a nutrient, an organ, a time of day, a number, a place.',
    false: 'It stays general: "your health", "some habits", "this changed everything".' }),
  counterintuitive: noul('Does `hook` claim something most readers would not expect to be true?', {
    true: 'It surprises: the reverse of what people assume, or a cause they would not guess.',
    false: 'It confirms what most readers already believe.' }),
  emotion: noul('Is `hook` written to make the reader feel fear, outrage, surprise or hope strongly?', {
    true: 'Strong emotional charge in the words.',
    false: 'Neutral, informational tone.' }),
  plain: noul('Is `hook` in plain everyday words a 12-year-old could read?', {
    true: 'Short common words; no jargon or long clauses.',
    false: 'Jargon, technical terms or long, heavy sentences.' }),
  credibility: noul('Does `hook` give a reason to believe it (a source, an expert, a study, a result)?', {
    true: 'A source, authority, study or concrete result backs it.',
    false: 'Nothing backs the claim.' }),
  reads_as_ad: noul('Does `hook` read like an advertisement or a sales pitch?', {
    true: 'It sells: product talk, a pitch, promotional tone.',
    false: 'It reads as information or a story, not a pitch.' }),
  one_idea: noul('Does `hook` make exactly one point the reader can hold in their head?', {
    true: 'One clear idea.',
    false: 'Several ideas compete, or none is clear.' }),
});
export const HOOK_READ_AT = 0.6; // a noul at or above this is "yes" for the fingerprint

/** PURE. Jev answers -> fingerprint features ("jev:shape story", "jev:payoff"). Unread -> none. */
export function jevFeatures(answers) {
  const f = new Set();
  if (!answers) return f;
  if (answers.shape?.choice) f.add(`jev:shape ${answers.shape.choice}`);
  for (const k of Object.keys(HOOK_QUESTIONS)) if (k !== 'shape' && Number(answers[k]?.noul) >= HOOK_READ_AT) f.add(`jev:${k.replace(/_/g, ' ')}`);
  return f;
}

/** PURE. Two hooks are the same wording when their first 60 normalised characters match. */
export const distinctKey = (text) => words(text).join(' ').slice(0, 60);

export const hookKey = (text) => createHash('sha256').update(String(text || '').trim()).digest('hex').slice(0, 16);

// ---- the target and the model (code) ---------------------------------------------------------------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

/** PURE. Each row's lift over its own account's median in the window; accounts under `minPerAccount` are dropped. */
export function withLift(rows, { minPerAccount = 5 } = {}) {
  const by = new Map();
  for (const r of rows) (by.get(r.account) || by.set(r.account, []).get(r.account)).push(r.views);
  const med = new Map([...by].filter(([, v]) => v.length >= minPerAccount).map(([a, v]) => [a, median(v)]));
  return rows.filter((r) => med.has(r.account) && med.get(r.account) > 0)
    .map((r) => ({ ...r, lift: Math.log(r.views / med.get(r.account)) }));
}

/**
 * PURE. Ridge regression of lift on binary features, by coordinate descent. Features seen in fewer
 * than `minSupport` training hooks are left out (a phrase used twice is an anecdote, not a pattern).
 */
export function fitRidge(rows, featuresOf, { lambda = 8, minSupport = 6, iters = 60, weightOf = null } = {}) {
  const feats = rows.map(featuresOf);
  // Support counts DISTINCT hooks: a harvest reposted nine times is one wording, not nine.
  const seen = new Map();
  feats.forEach((s, i) => { const h = distinctKey(rows[i].hook); for (const k of s) (seen.get(k) || seen.set(k, new Set()).get(k)).add(h); });
  const count = new Map([...seen].map(([k, v]) => [k, v.size]));
  const keep = [...count].filter(([, c]) => c >= minSupport).map(([k]) => k);
  const idx = new Map(keep.map((k, i) => [k, i]));
  const X = feats.map((s) => [...s].map((k) => idx.get(k)).filter((i) => i !== undefined));
  const y = rows.map((r) => r.lift);
  // Row weights (recency): a post from last week teaches more than one from two months ago.
  const rw = rows.map((r) => (weightOf ? weightOf(r) : 1));
  const W = rw.reduce((a, b) => a + b, 0) || 1;
  const bias = y.reduce((a, v, i) => a + v * rw[i], 0) / W;
  const w = new Float64Array(keep.length);
  const resid = y.map((v) => v - bias);
  const cols = keep.map(() => []);
  X.forEach((xs, r) => xs.forEach((j) => cols[j].push(r)));
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < keep.length; j++) {
      const rs = cols[j];
      let s = 0, sw = 0; for (const r of rs) { s += rw[r] * (resid[r] + w[j]); sw += rw[r]; }
      const nw = s / (sw + lambda);
      const d = nw - w[j];
      if (d) { for (const r of rs) resid[r] -= d; w[j] = nw; }
    }
  }
  const weights = Object.fromEntries(keep.map((k, j) => [k, +w[j].toFixed(5)]).filter(([, v]) => Math.abs(v) > 1e-4));
  return { bias: +bias.toFixed(5), weights, support: Object.fromEntries(keep.map((k) => [k, count.get(k)])) };
}

/** PURE. Recency weight: 1 for a post today, 0.5 at `halfLife` days old. */
export const recencyWeight = (postedAt, now = Date.now(), halfLife = 30) => 0.5 ** (Math.max(0, now - Date.parse(postedAt)) / 864e5 / halfLife);

/** PURE. Predicted lift for a feature set. */
export const predict = (model, feats) => [...feats].reduce((s, k) => s + (model.weights[k] || 0), model.bias);

/** PURE. Spearman rank correlation. */
export function spearman(a, b) {
  const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  if (n < 3) return NaN;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  return num / Math.sqrt(da * db);
}

/** PURE. AUC of `score` for the positives in `label` (ties count half). */
export function auc(score, label) {
  const pos = [], neg = [];
  score.forEach((s, i) => (label[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** PURE. Jaccard similarity of two feature sets. */
export const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };

/**
 * PURE. Score one hook against a built fingerprint (learnings/hook-fingerprint.json).
 * Returns { score (0-100: the % of our window's hooks it out-predicts), expectedLift (×median views),
 * carries (winning patterns present), misses (strongest winning patterns absent), drags (losing
 * patterns present), nearest (up to 5 of our hooks that spread, most alike first) }.
 */
export function scoreHook(text, fp, { jevAnswers = null } = {}) {
  const feats = new Set([...hookFeatures(text), ...jevFeatures(jevAnswers)]);
  const model = fp.model;
  const p = predict(model, feats);
  const dist = fp.predictedDistribution || [];
  const below = dist.filter((x) => x < p).length;
  const score = dist.length ? Math.round((100 * below) / dist.length) : null;
  const label = (k) => fp.labels?.[k] || k;
  const ranked = Object.entries(model.weights).sort((a, b) => b[1] - a[1]);
  const carries = ranked.filter(([k, v]) => v > 0 && feats.has(k)).slice(0, 6).map(([k, v]) => ({ pattern: label(k), weight: v }));
  const misses = ranked.filter(([k, v]) => v > 0 && !feats.has(k) && !k.startsWith('w:') && !k.startsWith('p3:')).slice(0, 6).map(([k, v]) => ({ pattern: label(k), weight: v }));
  const drags = ranked.filter(([k, v]) => v < 0 && feats.has(k)).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([k, v]) => ({ pattern: label(k), weight: v }));
  const nearest = (fp.winners || []).map((wn) => ({ ...wn, sim: jaccard(feats, new Set(wn.features)) }))
    .sort((a, b) => b.sim - a.sim).slice(0, 5).map(({ hook, account, views, lift, sim }) => ({ hook, account, views, lift, sim: +sim.toFixed(3) }));
  return { score, expectedLift: +Math.exp(p).toFixed(2), predicted: +p.toFixed(4), carries, misses, drags, nearest, jevRead: !!jevAnswers };
}

/** PURE. The brief the writer gets for a critique or a rewrite: failed patterns and the nearest winners. */
export function critiqueBrief(scored) {
  const L = [];
  L.push(`Hook score ${scored.score ?? 'n/a'}/100 against our last-window hooks (expected ${scored.expectedLift}× the page's median views).`);
  const list = (a) => a.map((d) => d.pattern).join('; ');
  if (scored.drags.length) L.push(`Patterns that drag reach on our pages, present here: ${list(scored.drags)}.`);
  if (scored.misses.length) L.push(`Patterns our spreading hooks carry that this one lacks: ${list(scored.misses)}.`);
  if (scored.carries.length) L.push(`Keep: ${list(scored.carries)}.`);
  if (scored.nearest.length) L.push('Our nearest hooks that spread (their words, not to copy):', ...scored.nearest.map((n) => `  - ${String(n.hook).replace(/\s+/g, ' ').slice(0, 160)} (${n.views.toLocaleString('en-US')} views, ${Math.exp(n.lift).toFixed(1)}× page median)`));
  return L.join('\n');
}
