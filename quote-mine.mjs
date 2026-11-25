#!/usr/bin/env node
// quote-mine.mjs — the key verbatim lines in an article, ranked for a QRT pull quote.
//
// Ported from 2t1c/genius (quote-mine.mjs at aba3896, owner 2026-10-02: "port into PI"). The only change: the URL
// mode carries its own articleText instead of importing Genius's x-articles.mjs.
//
//   node quote-mine.mjs qrts/cold/articles/<id>.md [--n 8]     # a stored article (a cold-lane material file)
//   node quote-mine.mjs https://x.com/<handle>/status/<id>      # any X Article, fetched through twitter241
//
// The operator, 2026-09-29: "try to improve your ability to depict KEY high value verbatim quote in articles so our QRT
// would be even stronger!!!" The pull quote is the proof line in the AIGuide formula (who + value line + "one verbatim
// line" + read-it-properly ask), and the lines that carried AIGuide's biggest article QRTs share a shape:
//
//   "Without feedback, 20 years of experience is just one year lived 20 times. With it, a few months can beat a career."  176K
//   "you are asking the exhausted system to fix itself using the resource it already ran out of."                        196K
//
// A line that stands on its own (no "this" or "he" pointing back into the article), turns on a contrast or a paradox,
// speaks to the reader or states a general rule, and fits in one breath. So the miner splits the body into sentences,
// also tries each pair of neighbours (a setup and its turn), and scores them on those moves. It never rewrites a word:
// every candidate is a substring of the article, so the saver's verbatim check passes by construction.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_CHARS = 40;
export const MAX_CHARS = 200;
const SWEET = [50, 150];

// Opening words that point back at something the reader of a QRT hasn't seen.
const DANGLING = /^(this|that|these|those|it|its|it's|he|she|they|them|his|her|their|here|there|so|and|but|or|also|then|which|such|both|another|the same|the other|in fact|for example|for instance|as a result|that's|this is|i mean|because|except|like|now|still|plus|again|well|therefore|however|thus|hence|anyway|perhaps|back to|why|what|how|as|after all|of course|in short|in other words|meaning|which means)\b/i;
// A pronoun that leans on a subject named earlier in the article.
const LEANS = /\b(he|she|they|them|his|her|their|him)\b/i;
const CONTRAST = /\b(but|not|isn't|aren't|doesn't|don't|won't|never|instead|than|without|rather|only|just|unless|until|yet|while|the difference between|more than|less than)\b/i;
const RULE = /\b(every|always|most people|nobody|no one|everyone|the best|the only|the real|the secret|the problem|the truth|the point|the goal|the purpose|the key|the reason|determines|decides|defines|shapes)\b/i;
// A paradox in one line: "X is just Y", "is not about", "is the opposite of".
const PARADOX = /\b(is|are|was) (just|only|not|never|really|actually) |\bthe opposite of\b|\bis not about\b|\b(isn't|aren't|wasn't)\b[^.]*,\s*(it's|they're|it is)\b|\bnot\b[^.]*,\s*but\b/i;
// Antonym roots: a setup and its turn often mirror by opposites ("Without feedback … With it …").
const MIRROR = [['with', 'without'], ['before', 'after'], ['most', 'few'], ['first', 'last'], ['win', 'lose'], ['rich', 'poor'], ['more', 'less'], ['start', 'finish'], ['always', 'never']];
const YOU = /\b(you|your|you're|yourself)\b/i;
const NUMBER = /\b\d[\d,.%$]*\b/;
const FIRST_PERSON = /^(i|i'm|i've|i'd|my|we|we're|our)\b/i;
const ASIDE = /\b(I|I've|I'm|I'd|me|my)\b/;

/** PURE. The article body as paragraphs of prose: headings, list items, media markers, links and quote-blocks are kept
 *  apart so a candidate never spans them. */
export function paragraphsOf(body) {
  return String(body || '').split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(#|\[media\]|---|\||!\[|https?:\/\/)/i.test(p) && !/^([-*•]|\d+[.)])\s/.test(p) && !/^[A-Z][^.!?]{0,80}$/.test(p));
}

/** PURE. One paragraph's sentences: split after . ! ? (and a closing quote) only where whitespace and a capital, a digit
 *  or an opening quote follow, and never after an abbreviation, so "3.5%" and "the U.S. economy" stay whole. */
export function sentencesOf(paragraph) {
  const p = String(paragraph).replace(/^>\s*/, '').trim();
  const out = [];
  const re = /[.!?]+["”’)]?(?=\s+["“‘(]?[A-Z0-9])/g;
  let start = 0, m;
  while ((m = re.exec(p))) {
    const end = m.index + m[0].length;
    const piece = p.slice(start, end).trim();
    const last = piece.split(/\s+/).pop();
    if (/^(e\.g\.|i\.e\.|vs\.|mr\.|mrs\.|ms\.|dr\.|st\.|no\.|(?:[A-Z]\.)+)$/i.test(last)) continue;
    out.push(piece);
    start = end;
  }
  if (start < p.length) out.push(p.slice(start).trim());
  return out.filter(Boolean);
}

/** PURE. A candidate line's score and the reasons for it (higher is a stronger pull quote). */
export function scoreLine(text) {
  // Curly apostrophes read as straight ones for the patterns (the text itself is never changed).
  const t = String(text).trim().replace(/[’‘]/g, "'");
  const why = [];
  let s = 0;
  const n = t.length;
  if (n < MIN_CHARS || n > MAX_CHARS) return { score: -Infinity, why: [`${n} chars`] };
  if (n >= SWEET[0] && n <= SWEET[1]) { s += 1; why.push('one breath'); } else s += 0.4;
  if (DANGLING.test(t)) { s -= 2; why.push('points back into the article'); }
  else if (/^(\S+\s){1,3}(this|that|these|those)\b/i.test(t)) { s -= 1; why.push('points back early'); }
  if (FIRST_PERSON.test(t)) { s -= 0.8; why.push('the author\'s own story'); }
  else if (ASIDE.test(t)) { s -= 0.4; why.push('the author in it'); }
  if (PARADOX.test(t)) { s += 0.8; why.push('a paradox'); }
  if (!DANGLING.test(t) && LEANS.test(t)) { s -= 0.5; why.push('leans on someone named earlier'); }
  if (CONTRAST.test(t)) { s += 1.2; why.push('a turn'); }
  if (RULE.test(t)) { s += 0.8; why.push('a general rule'); }
  if (YOU.test(t)) { s += 0.7; why.push('speaks to the reader'); }
  if (NUMBER.test(t)) { s += 0.4; why.push('a number'); }
  // A setup and its turn: two short sentences that mirror each other ("Without X, … With it, …").
  const halves = t.split(/(?<=[.!?]["”’]?)\s+/);
  if (halves.length === 2) {
    const [a, b] = halves.map((h) => h.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const shared = a.filter((w) => b.includes(w)).length;
    const opposed = MIRROR.some(([x, y]) => (a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x)));
    if (shared || opposed) { s += opposed ? 0.9 : 0.6; why.push(opposed ? 'mirrored by opposites' : 'mirrored'); }
    if (/^(with|without|if|when|once)\b/i.test(halves[1])) { s += 0.5; why.push('answers itself'); }
  }
  if (/\?$/.test(t)) { s -= 0.3; why.push('a question'); }
  if (/[:;]$|\(|\)|@|https?:/.test(t)) { s -= 1; why.push('not clean'); }
  if (/[“"][^”"]{3,}[”"]/.test(t) && !/^[“"]/.test(t)) { s -= 0.2; why.push('a quote inside'); }
  return { score: +s.toFixed(2), why };
}

/** PURE. The top `n` verbatim candidates in an article body: single sentences and neighbouring pairs, deduplicated,
 *  best first. Every `text` is copied from the body exactly. */
export function keyQuotesOf(body, { n = 8 } = {}) {
  const seen = new Set();
  const cands = [];
  paragraphsOf(body).forEach((para, pi) => {
    const ss = sentencesOf(para);
    ss.forEach((s, i) => {
      for (const [text, parts] of [[s, [`${pi}:${i}`]], i + 1 < ss.length ? [`${s} ${ss[i + 1]}`, [`${pi}:${i}`, `${pi}:${i + 1}`]] : [null, []]]) {
        if (!text || seen.has(text) || !String(body).includes(text)) continue;
        seen.add(text);
        const { score, why } = scoreLine(text);
        if (Number.isFinite(score)) cands.push({ text, score, why, at: pi, parts });
      }
    });
  });
  cands.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  // No sentence twice: a pair and either of its sentences, or two overlapping pairs, are near-duplicates.
  const out = [], used = new Set();
  for (const c of cands) {
    if (c.parts.some((x) => used.has(x))) continue;
    c.parts.forEach((x) => used.add(x));
    out.push({ text: c.text, score: c.score, why: c.why });
    if (out.length >= n) break;
  }
  return out;
}

/** PURE. An X Article's body as text, from its Draft.js `content_state` (twitter241's /tweet payload): headings, quote
 *  blocks and list items keep their markdown marks, media becomes [media]. (Genius's x-articles.mjs articleText.) */
export function articleText(contentState) {
  const blocks = contentState?.blocks || [];
  const lines = [];
  let n = 0;
  for (const b of blocks) {
    const text = (b.text || '').trim();
    switch (b.type) {
      case 'header-one': lines.push(`# ${text}`); break;
      case 'header-two': lines.push(`## ${text}`); break;
      case 'header-three': lines.push(`### ${text}`); break;
      case 'blockquote': lines.push(`> ${text}`); break;
      case 'unordered-list-item': lines.push(`- ${text}`); break;
      case 'ordered-list-item': lines.push(`${++n}. ${text}`); break;
      case 'atomic': lines.push('[media]'); break;
      default: if (text) lines.push(text);
    }
    if (b.type !== 'ordered-list-item') n = 0;
  }
  return lines.join('\n\n');
}

/** PURE. The body of a stored material file (qrts/cold/articles/*.md): everything after "# Article body". */
export const bodyOfMaterial = (md) => (String(md).split('# Article body')[1] ?? String(md)).trim();

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const src = process.argv[2];
  const nArg = process.argv.indexOf('--n');
  const n = nArg > 0 ? Number(process.argv[nArg + 1]) : 8;
  if (!src) { console.error('usage: node quote-mine.mjs <material.md | x.com status url> [--n 8]'); process.exit(1); }
  let body = '';
  if (/^https?:\/\//.test(src)) {
    const id = (src.match(/status\/(\d+)/) || [])[1];
    const { loadEnv } = await import('./lib.mjs');
    const env = loadEnv();
    const j = await fetch(`https://twitter241.p.rapidapi.com/tweet?pid=${id}`, { headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': 'twitter241.p.rapidapi.com' } }).then((r) => r.json());
    let art = null;
    const walk = (o) => { if (o && typeof o === 'object') { if (o.article?.article_results) art = o.article.article_results.result; for (const v of Object.values(o)) walk(v); } };
    walk(j);
    if (!art) { console.error('not an X Article (no article body on that post)'); process.exit(1); }
    body = articleText(art.content_state);
    console.log(`# ${art.title}\n`);
  } else body = bodyOfMaterial(fs.readFileSync(src, 'utf8'));
  keyQuotesOf(body, { n }).forEach((c, i) => console.log(`${String(i + 1).padStart(2)}. [${c.score}] "${c.text}"\n    ${c.why.join(' · ')}`));
}
