#!/usr/bin/env node
// article-gate.mjs — the pre-publish gate for X Articles (style/article-patterns.md §4).
// Eighteen numeric checks that separate the human corpus (167 viral articles, 18 Koe) from the
// machine fingerprint our first draft had. Strict (the default), a draft ships only at 18/18; the v1 power-wall draft
// scored 4/18 and the operator called the slop on sight, v2 scored 18/18 (2026-09-02).
//
//   node article-gate.mjs <file.md> [--json] [--min 1200 --max 2000] [--loose] [--listicle]
//
// --min / --max set the word band (default 2,500–4,000, the GTX corpus target). The health
// lane runs shorter pieces on purpose (operator 2026-09-13: "keep the posts shorter"), so it
// passes its own band; every other check is identical, because the rhythm and voice numbers
// are per-thousand-words and do not care how long the piece is. docs/health-articles.md.
//
// --loose keeps the principles and loosens the style (owner, 2026-09-29: "not all article should look the
// same — we want some differences in the way we write — loosen the gate, keep the principles, and then apply
// some insights from the original post"). Each check has a tier. The nine PRINCIPLES are our rules against
// the machine tells (style/article-patterns.md §3: walls of text, "Not X. Y." pivots, em-dashes, explaining
// your own sentence, quotable section endings, quote sandwiches, the bookend, banned words) plus the word
// band; they fail a draft in both modes, even where a viral source breaks them. The nine STYLE checks are one
// voice's fingerprint (Koe's one-sentence paragraphs,
// contractions, "you" and "I" rates, asides, claim headings, a numbered protocol); the corpus measures them
// differently per format (style/article-patterns.md §2: a listicle runs "you" 27 and "I" 1, a how-to 51
// and 4), so under --loose they are reported as advisory NOTEs and an article can take its source's shape.
// Without --loose all eighteen must pass, as GeniusGTX's write-article flow requires.
//
// --listicle adds a tenth principle: the items are numbered (owner, 2026-09-29: "if it's an listicle, then we
// should add numbering to it. The article becomes a little bit more skimmable, and the reader just has the
// expectation of how long the article is"). An item name is a bold line or a heading that opens with its
// number ("**3. Take D3 with K2**", "## 3. …"), and the numbers run 1, 2, 3… in order, at least three. A recap
// list of plain "1. …" lines is the TLDR, not the items, and is not counted.
//
// <file.md> is either a raw content_markdown body (first line "# Title") or an article package
// under articles/ (the body after its "# Article body" heading is used). The P.S. block after the
// standalone "---", the <typ:…> embeds, headings and blockquotes are excluded from the counts.
// Exit code 1 when a check the mode requires fails, so a pipeline can stop on it.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.log('usage: node article-gate.mjs <file.md> [--json] [--min N --max N] [--loose] [--listicle]'); process.exit(1); }
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const MIN_WORDS = flag('min', 2500), MAX_WORDS = flag('max', 4000);
const LOOSE = process.argv.includes('--loose'), LISTICLE = process.argv.includes('--listicle');
if (!(MIN_WORDS > 0 && MAX_WORDS > MIN_WORDS)) { console.log('--min must be > 0 and --max > --min'); process.exit(1); }
let raw = readFileSync(file, 'utf8');
const pkg = raw.lastIndexOf('\n# Article body');
if (pkg > -1) {
  const afterHead = raw.indexOf('\n', pkg + 1) + 1;
  const h1 = raw.indexOf('\n# ', afterHead - 1);
  raw = raw.slice(h1 + 1);
  const next = raw.indexOf('\n# ');
  if (next > -1) raw = raw.slice(0, next);
}
raw = raw.split('\n---\n')[0].replace(/<typ:[^>]+>/g, '');

const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
const heads = lines.filter((l) => l.startsWith('## '));
const paras = lines.filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('> ')).map((l) => l.trim());
const SENT = /(?<=[.!?])\s+(?=[A-Z"“(])/;
const sents = (p) => p.split(SENT).filter((s) => s.trim());
const words = (s) => s.split(/\s+/).filter(Boolean);
const W = paras.reduce((n, p) => n + words(p).length, 0);
const per = (n) => Math.round((1000 * n / Math.max(1, W)) * 10) / 10;
const body = paras.join('\n');
const outsideQuotes = body.replace(/"[^"]*"/g, '');
const count = (re, s = body) => (s.match(re) || []).length;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const plen = paras.map((p) => words(p).length);
let runs = 0; for (let i = 2; i < plen.length; i++) if (plen[i] > 30 && plen[i - 1] > 30 && plen[i - 2] > 30) runs++;
const oneSent = paras.filter((p) => sents(p).length === 1).length / Math.max(1, paras.length);

const sectionText = lines.filter((l) => !l.startsWith('> ')).join('\n').split(/\n## [^\n]+/).slice(1);
let shortEnd = 0; const quotesPerSec = [];
for (const sec of sectionText) {
  const ps = sec.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  if (ps.length) { const last = sents(ps[ps.length - 1]); if (words(last[last.length - 1]).length <= 8) shortEnd++; }
  quotesPerSec.push((sec.match(/"([^"]+)"/g) || []).filter((q) => words(q).length >= 6).length);
}
const firstI = words(body).findIndex((w) => /^(I|I'm|I've|I'd|I'll|my|me)[,.;:)]?$/.test(w));
const notXY = count(/\b(is not|isn't|not) [^.]{2,40}\. (It|That|This|He|She|They|We|You) (is|are|was|'s)\b/g)
  + count(/\bnot [^.,]{2,30}, but\b/g) + count(/\bnot [^.,]{2,30}\. [A-Z]\w+\./g)
  + count(/\b(isn't|doesn't|aren't) [^.,]{2,40}, (it's|it|they're|they) /g);
// A heading is a claim, not a label. Strip any numeral prefix first: "I – ", "1. ", "IV — " are
// free tokens that let a four-word label ("B12, in the morning") clear a five-word floor. Measured
// on Tim Denning's 94 headings (10 articles, 0.18–25.8M views): median 10 words, none under the
// floor except his two-word closers, 0 Roman numerals, 0 title case.
const headText = (h) => h.slice(3).replace(/^\s*(?:[IVXLCDM]+|\d+)\s*[.)\u2013\u2014-]\s*/, '').trim();
const labelHeads = heads.filter((h) => words(headText(h)).length < 6);
const keyWords = (p) => new Set(words(p).map((w) => w.toLowerCase().replace(/[.,]/g, '')).filter((w) => w.length > 4));
const bookend = [...keyWords(paras[0] || '')].filter((w) => keyWords(paras[paras.length - 1] || '').has(w));
const itemNums = lines.map((l) => l.match(/^(?:\*\*|#{2,3} )\s*(\d+)[.)]\s/)).filter(Boolean).map((m) => Number(m[1]));
const numbered = itemNums.length >= 3 && itemNums.every((x, i) => x === i + 1);
const banned = count(/\b(brutal(ly)?|quietly|delve|navigating|leveraging)\b/gi) + count(/\b(it'?s|that'?s|this is) not [^.]*\. (it'?s|that'?s|this is)\b/gi);

const checks = [
  ['Words', W, W >= MIN_WORDS && W <= MAX_WORDS, `${MIN_WORDS.toLocaleString('en-US')}–${MAX_WORDS.toLocaleString('en-US')}`, 'principle'],
  ['Words/para (median)', median(plen), median(plen) <= 25, '≤ 25', 'style'],
  ['Runs of 3 paras >30w', runs, runs === 0, '0', 'principle'],
  ['One-sentence paras %', Math.round(100 * oneSent), oneSent >= 0.55, '≥ 55%', 'style'],
  ['Contractions/1K (outside quotes)', per(count(/\b\w+['’](t|s|re|ve|ll|d|m)\b/g, outsideQuotes)), per(count(/\b\w+['’](t|s|re|ve|ll|d|m)\b/g, outsideQuotes)) >= 18, '≥ 18', 'style'],
  ['you/your /1K', per(count(/\byou(r|'re|'ll|'ve|'d)?\b/gi)), per(count(/\byou(r|'re|'ll|'ve|'d)?\b/gi)) >= 35, '≥ 35', 'style'],
  ['I/my/me /1K', per(count(/\b(I|I'm|I've|I'd|I'll|my|me)\b/g)), per(count(/\b(I|I'm|I've|I'd|I'll|my|me)\b/g)) >= 6, '≥ 6', 'style'],
  ['First "I" at word', firstI, firstI > -1 && firstI < 300, '< 300', 'style'],
  ['Parentheses /1K', per(count(/\(/g)), per(count(/\(/g)) >= 2, '≥ 2', 'style'],
  ['that is/this is/here is /1K', per(count(/\b(that is|this is|here is|that's|here's)\b/gi)), per(count(/\b(that is|this is|here is|that's|here's)\b/gi)) <= 4, '≤ 4', 'principle'],
  ['"Not X. Y." pivots', notXY, notXY === 0, '0', 'principle'],
  ['Em-dashes in body', count(/—/g), count(/—/g) === 0, '0 (attribution line only)', 'principle'],
  ['Sections ending <=8w', shortEnd, shortEnd <= 1, '≤ 1', 'principle'],
  ['Max quotes (6+ words) in a section', Math.max(0, ...quotesPerSec), Math.max(0, ...quotesPerSec) <= 1, '≤ 1', 'principle'],
  ['Label headings (<6 words, numeral prefix stripped)', labelHeads.length, labelHeads.length === 0, '0 — headings are claims', 'style'],
  ['Numbered steps present', count(/^Step \d\)/gm), count(/^Step \d\)/gm) > 0, '> 0', 'style'],
  ['Bookend words shared', bookend.join(', ') || 'none', bookend.length === 0, 'none', 'principle'],
  ['Banned words / It\'s-not-X-It\'s-Y', banned, banned === 0, '0', 'principle'],
  ...(LISTICLE ? [['Numbered items (listicle)', numbered ? `1–${itemNums.length}` : itemNums.join(', ') || 'none', numbered, '1, 2, 3… in order (≥ 3)', 'principle']] : []),
];
const passed = checks.filter((c) => c[2]).length;
const principles = checks.filter((c) => c[4] === 'principle'), style = checks.filter((c) => c[4] === 'style');
const pPassed = principles.filter((c) => c[2]).length, sPassed = style.filter((c) => c[2]).length;
// Strict needs all eighteen; --loose needs the principles, and a missed style check is a NOTE.
const ok = LOOSE ? pPassed === principles.length : passed === checks.length;
const advisory = (tier) => LOOSE && tier === 'style';
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ file, mode: LOOSE ? 'loose' : 'strict', ok, words: W, headings: heads.length, paragraphs: paras.length, passed, total: checks.length,
    principles: { passed: pPassed, total: principles.length }, style: { passed: sPassed, total: style.length },
    checks: checks.map(([name, value, pass, target, tier]) => ({ name, value, ok: pass, target, tier, advisory: advisory(tier) })) }, null, 1));
} else {
  for (const [name, value, pass, target, tier] of checks) console.log(`${pass ? 'PASS' : advisory(tier) ? 'NOTE' : 'FAIL'}  ${name.padEnd(36)} ${String(value).padEnd(12)} (${target})`);
  console.log(LOOSE
    ? `\n${pPassed}/${principles.length} principles pass · style ${sPassed}/${style.length} (advisory) · ${heads.length} headings · ${paras.length} paragraphs · ${W} words`
    : `\n${passed}/${checks.length} checks pass · ${heads.length} headings · ${paras.length} paragraphs · ${W} words`);
}
process.exit(ok ? 0 : 1);
