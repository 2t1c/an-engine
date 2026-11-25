#!/usr/bin/env node
// qrt-score.mjs — how a QRT is judged: STRUCTURE FIRST.
//
// Ported from 2t1c/genius (qrt-score.mjs at aba3896, owner 2026-10-02: "port into PI"), unchanged.
//
//   node qrt-score.mjs --template T130 --text "…" [--kind article|post|quote|launch] [--views 173 --hours 0.7]
//
// The operator, 2026-09-29, after the saver cut "This article should have 100M views." and "MUST … MUST READ" and
// the lanes filled up with TL;DRs: "I don't think the honesty or support is that important. I want us to rely more on
// existing structure, existing viral structure from the [quote] tweets, and what we do is add on the information that
// we think is a good fit … Overselling and unsupported claims are okay … everything on social media is kind of
// exaggerated … This is more about just getting the structure with high confidence. If you can add information to it,
// then that's great. If not, then some of the ones from the AI guides or some of the more generic ones are okay as
// well. If there's the underlying structure, then I have the certainty, and you have the certainty that it would
// perform well. The more that we add to it, the more uncertainty that we add."
//
// So a QRT is judged the way a hook is: pick a proven structure, keep its frame, change only the information.
//
// STRUCTURE (`templateFit`), the gate: how exactly the line keeps its template, measured against the template's own
// parts so an exact fill scores 1.00 whether the template is all frame ("im begging you to read this:") or mostly
// slots ("[Counterintuitive claim]. [Researcher] at [institution] …"):
//   - kept:   the share of the template's fixed words present, in order (a longest common subsequence);
//   - filled: the share of its [slots] that got words;
//   - extra:  the share of our words where the template has no slot (an added line, a tacked-on clause, a slot
//             stretched past a phrase).
// structure = kept × (1 − extra) × (0.5 + 0.5 × filled). Under STRUCTURE_MIN (0.8) the line is rewritten closer to its
// template.
//
// ADDED (`templateFit().added`), a readout: the share of the line that is our information (the words in its slots).
// A generic template used as is adds nothing and carries all of its proof; information is welcome where it fits, and
// every word of it is a word the proof didn't test.
//
// EXPECTED VIRALITY (`viralityOf`), the rank: the proven structure, kept. Never a gate and never a forecast of views.
//   - proven 75%: the template's record for this kind of post (qrt-pick's rubric: its family's lift on the kind 45,
//                 the template's median views 35, its saves 20);
//   - momentum 15%: the quoted post's views an hour (a QRT rides the post it quotes), when known;
//   - length 10%: the @AIGuide_ bands (81–280 characters medianed 12.8K; over 280, 5.2K and none past 100K);
//   × structure: a line that drifts off its frame loses the certainty the frame carried.
//
// Jev's reading (supported, honest, stop, click) is advisory now (qrt-fill.mjs --check --read): it can flag a line,
// never cut one.
import { pathToFileURL } from 'node:url';
import { KINDS, loadCatalog, scorer } from './qrt-pick.mjs';

export const STRUCTURE_MIN = 0.8;
// Frames whose skeleton carries a format instruction the structure score reads as fixed words ("repeated 10-20 times",
// "(life-protocol greentext)", "(self clip caption)", alternatives inside one slot): a line written the way the frame
// means it scores under the bar, and one that passes posts the instruction as text (2026-10-04). The automated lanes
// never plan them; a person can still pick one by hand.
export const NOTE_FRAMES = Object.freeze(['T007', 'T009', 'T045', 'T046', 'T084', 'T085', 'T100']);
export const FIT_MIN = STRUCTURE_MIN; // the name the lanes used first
export const VIRALITY_WEIGHTS = Object.freeze({ proven: 0.75, momentum: 0.15, length: 0.1 });

const norm = (w) => String(w).toLowerCase().replace(/[’‘]/g, "'").replace(/^[^\w$#@%']+|[^\w%']+$/g, '');
const mainOf = (skeleton) => String(skeleton || '')
  .replace(/\s*\/?\s*\((?:variants?|optional|or)\b[^)]*\)/gi, '')
  .replace(/\s*\/\s*\(variants?:[\s\S]*$/i, '');

/** PURE. A template's skeleton as tokens: fixed words and SLOT, per line, with its variant notes dropped. */
export function templateTokens(skeleton) {
  const toks = [];
  for (const line of mainOf(skeleton).split(/\n|\s\/\s/)) {
    for (const part of line.split(/(\[[^\]]*\])/)) {
      if (/^\[[^\]]*\]$/.test(part)) { toks.push({ slot: true, label: part.slice(1, -1) }); continue; }
      for (const w of part.split(/\s+/)) { const n = norm(w); if (n && !/^(…|\.\.\.|x\d+)$/.test(n)) toks.push({ slot: false, w: n }); }
    }
  }
  return toks;
}

/** PURE. Whether a template's quotation marks are its structure rather than a citation: it puts a slot in quotes
 *  whose label is a belief or a voice ("[modern gatekeeping belief]"), not a quote from the piece ("[one verbatim line
 *  pulled from the piece]"). Such a line's quoted words don't have to be found in the source. */
export function voiceQuotesOf(skeleton) {
  const quoted = [...mainOf(skeleton).matchAll(/["“]\s*\[([^\]]*)\]\s*["”]/g)].map((m) => m[1]);
  return quoted.length > 0 && !quoted.some((label) => /quote|verbatim|pulled|said|line from|words/i.test(label));
}

/** PURE. The longest common subsequence of two word lists, as matched index pairs [[i, j], …]. */
function lcs(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < m && j < n;) { if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (d[i + 1][j] >= d[i][j + 1]) i++; else j++; }
  return out;
}

/** PURE. The skeleton's lines, variant notes dropped (as templateTokens reads them). */
const templateLines = (skeleton) => mainOf(skeleton).split(/\n|\s\/\s/).map((l) => l.trim()).filter(Boolean);

// A slot holds a phrase, not a paragraph: words past SLOT_MAX (or 4x its label, if longer) count as extra.
export const SLOT_MAX = 14;

/** PURE. How faithfully `text` fills `skeleton`: { fit, kept, filled, extra, added, fixed, slots }. Lines past the
 *  template's own line count are extra (an added line is not a slot fill). `added` is the share of the line that is
 *  our information: the words in its slots. */
export function templateFit(skeleton, text) {
  const toks = templateTokens(skeleton);
  const tLines = templateLines(skeleton).length;
  const xLines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const kept_ = xLines.slice(0, Math.max(1, tLines)).join('\n'), over = xLines.slice(Math.max(1, tLines)).join(' ');
  const overWords = over.split(/\s+/).map(norm).filter(Boolean).length;
  // A word the template repeats ("MUST MUST MUST … MUST READ") may repeat any number of times: runs collapse on both sides.
  const repeated = new Set(toks.filter((t, i) => !t.slot && toks[i + 1] && !toks[i + 1].slot && toks[i + 1].w === t.w).map((t) => t.w));
  const collapse = (arr, key) => arr.filter((x, i) => !(i && repeated.has(key(x)) && key(arr[i - 1]) === key(x)));
  toks.splice(0, toks.length, ...collapse(toks, (t) => (t.slot ? null : t.w)));
  const words = collapse(kept_.split(/\s+/).map(norm).filter(Boolean), (w) => w);
  const fixedIdx = toks.map((t, i) => (t.slot ? -1 : i)).filter((i) => i >= 0);
  const slots = toks.filter((t) => t.slot).length;
  const pairs = lcs(fixedIdx.map((i) => toks[i].w), words); // [k into fixedIdx, j into words]
  const kept = fixedIdx.length ? pairs.length / fixedIdx.length : 1;
  // Walk the gaps between matched anchors: our words in a gap the template gives a slot are a fill, else extra.
  const anchors = [[-1, -1], ...pairs.map(([k, j]) => [fixedIdx[k], j]), [toks.length, words.length]];
  let extra = 0, filledSlots = 0, fillWords = 0;
  for (let a = 0; a < anchors.length - 1; a++) {
    const [ti, wj] = anchors[a], [ti2, wj2] = anchors[a + 1];
    const gapWords = wj2 - wj - 1;
    const gap = toks.slice(ti + 1, ti2).filter((t) => t.slot);
    if (gap.length) {
      filledSlots += Math.min(gap.length, gapWords);
      const room = gap.reduce((n, t) => n + Math.max(SLOT_MAX, 4 * t.label.split(/\s+/).length), 0);
      fillWords += Math.min(gapWords, room);
      extra += Math.max(0, gapWords - room);
    } else extra += Math.max(0, gapWords);
  }
  extra += overWords;
  const total = words.length + overWords;
  const filled = slots ? filledSlots / slots : 1;
  const extraShare = total ? extra / total : 0;
  const fit = kept * (1 - extraShare) * (0.5 + 0.5 * filled);
  return { fit: +fit.toFixed(3), kept: +kept.toFixed(3), filled: +filled.toFixed(3), extra: +extraShare.toFixed(3), added: +(total ? (fillWords + extra) / total : 0).toFixed(3), fixed: fixedIdx.length, slots };
}

/** PURE. The length factor from the @AIGuide_ bands. */
export const lengthFactorOf = (n) => (n > 280 ? 0.4 : n >= 81 ? 1 : n >= 40 ? 0.8 : 0.6);

/** PURE. Views an hour, as 0–1 on a log scale (100 an hour ≈ 0.4, 10K an hour ≈ 0.8, 100K+ = 1), or null. */
export const momentumOf = (views, hours) => (views == null || !hours ? null : Math.max(0, Math.min(1, Math.log10(Math.max(1, views / hours)) / 5)));

/** PURE. The template's proven record for this kind of post: qrt-pick's rubric total (fit to the kind, median views,
 *  saves), 0–1. */
// The template's record, without qrt-pick's meme bias: the bias picks templates, it doesn't raise auto-pass or virality.
export const provenOf = (template, catalog, kind = 'article') => scorer(catalog)(template, kind).record;

/** PURE. Expected virality for one line on one template: the proven structure, kept. { score, parts, unknown }. */
export function viralityOf({ template, catalog, kind = 'article', text = '', views = null, hours = null, fit = null }) {
  const structure = fit ?? templateFit(template.skeleton, text).fit;
  const momentum = momentumOf(views, hours);
  const parts = { proven: provenOf(template, catalog, kind), momentum: momentum ?? 0.5, length: lengthFactorOf(String(text).trim().length), structure };
  const base = Object.entries(VIRALITY_WEIGHTS).reduce((acc, [k, w]) => acc + w * parts[k], 0);
  return { score: +(base * structure).toFixed(3), parts, unknown: [momentum == null && 'momentum (no post stats)'].filter(Boolean) };
}

/** PURE. Jev's numbers from qrt-fill's one-line reading (advisory). */
export const saverAnswersOf = (line) => Object.fromEntries([...String(line || '').matchAll(/(supported|shape|stop|click|honest|voice) ([0-9.]+)/g)].map((m) => [m[1], +m[2]]));

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
  const id = arg('--template'), text = arg('--text');
  if (!id || !text) { console.error('usage: node qrt-score.mjs --template <id> --text "<line>" [--kind article|post|quote|launch] [--views N --hours H]'); process.exit(1); }
  const catalog = loadCatalog();
  const t = catalog.templates.find((x) => x.id === id);
  if (!t) { console.error(`no template ${id} in the catalog`); process.exit(1); }
  const kind = arg('--kind', 'article');
  if (!KINDS[kind]) { console.error(`--kind is one of ${Object.keys(KINDS).join(', ')}`); process.exit(1); }
  const f = templateFit(t.skeleton, text);
  const v = viralityOf({ template: t, catalog, kind, text, fit: f.fit, views: arg('--views') != null ? Number(arg('--views')) : null, hours: arg('--hours') != null ? Number(arg('--hours')) : null });
  console.log(`${t.id} · ${t.family} · ${t.skeleton.split('\n')[0]}`);
  console.log(`  structure ${f.fit}${f.fit < STRUCTURE_MIN ? ` (under ${STRUCTURE_MIN}: rewrite closer to the template)` : ''} · kept ${Math.round(f.kept * 100)}% of ${f.fixed} fixed words · ${Math.round(f.filled * 100)}% of ${f.slots} slots filled · ${Math.round(f.extra * 100)}% extra · added ${Math.round(f.added * 100)}% · proven ${v.parts.proven} · virality ${v.score}`);
  if (v.unknown.length) console.log(`  (unknown, set to 0.5: ${v.unknown.join(', ')})`);
}
