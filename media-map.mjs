// media-map.mjs — WHERE a source thread's media lands in ours. Pure, no network, no argv.
//
// Extracted from media.mjs (2026-09-06) so the seed lane can reuse the EXACT mapping the donor lane
// has used since July rather than grow a second one. Two callers now share it:
//   · media.mjs      — a recreation follows its DONOR (an Airtable swipe row, someone else's thread).
//   · seed-media.mjs — a plant follows its SEED's ORIGIN (our own harvested body, via Typefully).
// Those two resolve their source completely differently and attach identically, which is the whole
// reason this file exists: a fix to the mapping must not have to be made twice.
import { isTrackedLink } from './checks.mjs';
import { CROSS_POST_PLATFORMS } from './platforms.mjs';

/** The leading "N." of a numbered item, or null. Reads the first marker anywhere in the tweet, so a
 *  hook that carries its own first item ("...\n\n1. Creatine.") answers 1. */
export const lessonNum = (text) => { const m = String(text).match(/(?:^|\n)\s*(\d{1,2})[.\/)]\s/); return m ? m[1] : null; };

/** A filename Typefully's presigned upload accepts, from whatever the source called it. */
export const cleanName = (s, ext) => (s || `media.${ext}`).replace(/[^a-zA-Z0-9_.()\-]/g, '-').replace(/-+/g, '-').slice(0, 100);

// ---- TOPIC, not just number (2026-09-07) --------------------------------------------------------
// Run 2 restructured donor items freely — a pod point at T3, a weld at T6 — and the mapping below
// stayed by number, so a donor's "2. Protein" chart landed on our "2. Creatine" and a PubMed magnesium
// screenshot on a beet item: 16 tweets over four days, every one found by opening the draft after it
// was scheduled. A number match is now only half the test; the donor item's title line and our
// tweet's first line have to share a topic word (a substance, its family, or the item's noun).
const TOPIC_STOP = new Set(('a an the and or of to in on for with your you yours take taking took get gets more most every daily day days morning night '
  + 'before after is are was were it its this that these those at my i me we they them from by as be do does not no up out if when than then one two three '
  + 'per plus use using try stop start eat eating drink drinking food foods supplement supplements dose doses mg iu how what why which who where here there '
  + 'right wrong good bad best better worse all any some each just only also into over under about like need needs want wants make makes made keep keeps way '
  + 'thing things time times year years old new big small first last next same other another own off on so too very really still even ever never always '
  + 'people person body brain health healthy natural naturally have has had been being can could should would will may might must').split(/\s+/));
// Aliases fold a family's forms onto one token so "fish oil" meets "omega-3" and "glycinate" meets
// "magnesium". Vitamins are normalised to "vitamin-<letter>" (D3 and D are one topic, D and B12 not).
const TOPIC_ALIASES = {
  omega: ['omega', 'omega3', 'fish', 'epa', 'dha', 'krill'], protein: ['protein', 'whey', 'casein'], creatine: ['creatine', 'creapure', 'monohydrate'],
  magnesium: ['magnesium', 'glycinate', 'threonate', 'magtein', 'bisglycinate', 'citrate'], coq10: ['coq10', 'ubiquinol', 'ubiquinone', 'coenzyme'],
  ashwagandha: ['ashwagandha', 'ksm', 'withania'], zinc: ['zinc', 'picolinate'], beet: ['beet', 'beets', 'beetroot', 'nitrate', 'nitrates', 'nitric'],
  berberine: ['berberine'], collagen: ['collagen', 'peptides'], nad: ['nad', 'nmn', 'nicotinamide', 'riboside'], 'vitamin-b12': ['b12', 'methylcobalamin', 'cobalamin'],
  'vitamin-d': ['d3', 'cholecalciferol', 'sunlight', 'sunshine'], 'vitamin-k': ['k2', 'mk7', 'menaquinone'], sleep: ['sleep', 'sleeping', 'melatonin', 'bed', 'bedtime', 'insomnia'],
  walk: ['walk', 'walking', 'steps'], sugar: ['sugar', 'glucose', 'insulin', 'carb', 'carbs'], cortisol: ['cortisol', 'stress'], gut: ['gut', 'probiotic', 'probiotics', 'microbiome', 'fiber', 'fibre'],
  iron: ['iron', 'ferritin'], turmeric: ['turmeric', 'curcumin'], electrolytes: ['electrolyte', 'electrolytes', 'sodium', 'potassium'], water: ['water', 'hydration', 'hydrate', 'hydrated'],
};
const ALIAS_OF = new Map();
for (const [canon, forms] of Object.entries(TOPIC_ALIASES)) { ALIAS_OF.set(canon, canon); for (const f of forms) ALIAS_OF.set(f, canon); }
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 4 ? '' : m));

/** PURE. The topic tokens of a tweet's TITLE line (its first non-empty line, the "N." marker dropped).
 *  Lowercased, stop words out, aliases folded, "vitamin X" made one token. */
export function topicTokens(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const raw = line.toLowerCase().replace(/^\s*\d{1,2}[.\/)]\s*/, '').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i < raw.length; i++) {
    let w = raw[i];
    if (w === 'vitamin' || w === 'vit') {
      const nx = raw[i + 1] || '';
      const m = nx.match(/^([a-z])(\d{0,2})$/);
      if (m) { out.add(`vitamin-${m[1]}${m[1] === 'b' ? m[2] : ''}`); i++; continue; }
      continue;
    }
    if (/^[a-z]\d{1,2}$/.test(w) && ALIAS_OF.has(w)) { out.add(ALIAS_OF.get(w)); continue; }
    if (TOPIC_STOP.has(w) || w.length < 3) continue;
    if (ALIAS_OF.has(w)) { out.add(ALIAS_OF.get(w)); continue; }
    const st = stem(w);
    out.add(ALIAS_OF.get(st) || st);
  }
  return out;
}
/** PURE. The topic as a short label, for logs. */
export const topicOf = (text) => [...topicTokens(text)].slice(0, 4).join(' ') || '(no topic word)';
/** PURE. The tokens of a line that name something we sell or a subject we recognise (the alias
 *  table). "2. Magnesium glycinate" has one; "10. Motivation vanishes" has none. */
export const knownTopics = (text) => new Set([...topicTokens(text)].filter((w) => TOPIC_ALIASES[w]));

/** PURE. Do two title lines agree on subject?
 *  'same'    — they share a topic word.
 *  'differ'  — BOTH lines name a subject we recognise, and it is a different one. Only this refuses.
 *  'unclear' — anything else: a bridge, a weld, a bare symptom line, or two subjects the alias table
 *              has never heard of. Reported, never dropped. The whole failure this rule exists for
 *              was substance against substance (a protein chart on a creatine item, a magnesium
 *              paper on a beet item); a symptom against another symptom is a judgement the operator
 *              made by hand on Run 2 and keeps. */
export function topicAgreement(a, b) {
  const ta = topicTokens(a), tb = topicTokens(b);
  if (!ta.size || !tb.size) return 'unclear';
  for (const w of ta) if (tb.has(w)) return 'same';
  return knownTopics(a).size && knownTopics(b).size ? 'differ' : 'unclear';
}
/** PURE. True only when both sides name a subject and it is the same one. */
export const sharesTopic = (a, b) => topicAgreement(a, b) === 'same';

/** PURE. Source item -> { idx, why } in OUR posts. Hook to hook; numbered item N to the tweet that
 *  starts "N." — and, when the item carries its text, only if the two title lines share a topic.
 *  idx is -1 when there is no confident mapping; `why` says which rule decided. Index 0 is never a
 *  target for a lesson: an item image on our hook is the donor's body art on the one tweet 95% of
 *  readers see. */
export function mapItem(item, posts) {
  if (item.n === 1) return { idx: 0, why: 'hook' };
  if (item.lesson) {
    // SEARCH FROM 1, don't find-then-reject. A body whose hook attaches its own first item ("4
    // supplements...\n\n1. Creatine.") matches at index 0, and `findIndex(...) > 0` threw away the
    // whole lookup — so the source's dedicated item-1 tweet found nothing even when our body had one
    // further down.
    const i = posts.findIndex((p, idx) => idx > 0 && new RegExp(`^\\s*${item.lesson}[.\\/)]\\s`).test(p.text));
    if (i > 0) {
      const agree = item.text == null ? 'unclear' : topicAgreement(item.text, posts[i].text);
      if (agree === 'differ') return { idx: -1, why: `item ${item.lesson} is about "${topicOf(item.text)}", our tweet ${i + 1} is about "${topicOf(posts[i].text)}"` };
      return { idx: i, why: `item ${item.lesson}${agree === 'same' ? ` (topic: ${topicOf(posts[i].text)})` : ' (number only — no two subjects to compare)'}` };
    }
    return { idx: -1, why: `our body has no item ${item.lesson}` };
  }
  return { idx: -1, why: 'not the hook and not a numbered item' };
}
/** Source item -> index in OUR posts, or -1. The index half of mapItem, kept for its callers. */
export const mapToDraft = (item, posts) => mapItem(item, posts).idx;

/** PURE. Judge the media already ON our tweets against the source items: for every tweet of ours
 *  that carries media, the source item that maps there by number and whether the topics agree.
 *  posts — [{ text, media_ids }], items — [{ n, lesson, text, kind }].
 *  Returns [{ idx, count, verdict, item, why }] where verdict is one of:
 *    hook     — our hook, which keeps the source hook's media by definition
 *    ok       — the numbers match and the subjects agree
 *    mismatch — the numbers match and the subjects DISAGREE: this is the one --fix drops
 *    unclear  — the numbers match and one line names no subject; reported, never dropped
 *    unmapped — no source item carries media for this tweet (parked, or added by hand) */
export function judgeMedia(posts = [], items = []) {
  const out = [];
  posts.forEach((p, idx) => {
    const count = (p.media_ids || []).length;
    if (!count) return;
    if (idx === 0) { out.push({ idx, count, verdict: 'hook', item: items.find((it) => it.n === 1) || null, why: 'the hook keeps the donor hook\'s media' }); return; }
    const num = lessonNum(p.text);
    const item = num ? items.find((it) => it.lesson === num && it.n !== 1) : null;
    if (!item) { out.push({ idx, count, verdict: 'unmapped', item: null, why: num ? `no source item ${num} carries media — parked or added by hand` : 'not a numbered item — parked or added by hand' }); return; }
    const agree = item.text == null ? 'unclear' : topicAgreement(item.text, p.text);
    if (agree === 'differ') { out.push({ idx, count, verdict: 'mismatch', item, why: `source item ${item.lesson} is about "${topicOf(item.text)}", our tweet ${idx + 1} is about "${topicOf(p.text)}"` }); return; }
    if (agree === 'unclear') { out.push({ idx, count, verdict: 'unclear', item, why: `source item ${item.lesson}: "${topicOf(item.text)}" vs ours "${topicOf(p.text)}" — not two substances, so not auto-dropped; read it yourself` }); return; }
    out.push({ idx, count, verdict: 'ok', item, why: `source item ${item.lesson} — topic "${topicOf(p.text)}"` });
  });
  return out;
}

/** Is this tweet the legal disclaimer? BY SHAPE, not by matching accounts.mjs.
 *
 *  The exact-text test alone is only correct for a draft written under the CURRENT garden text.
 *  Magnus's seed origin (draft 9928871) still ends "DISCLAIMER: This thread may contain affiliate
 *  links..." — the wording his garden used then — so an exact match returns false and the walk-back
 *  below settles on the disclaimer itself as the sign-off. Every fleet disclaimer, old and new,
 *  names the affiliate relationship and what it costs the reader; no body tweet or plug does.
 *  Kept deliberately narrow: a plug says "#ad" and carries a link, never both of these. */
export const isDisclaimerText = (t) => {
  const s = String(t || '');
  return /^\s*DISCLAIMER\b/i.test(s) || (/affiliate/i.test(s) && /commission|not intended to|medical advice|diagnose/i.test(s));
};

/** The sign-off: the last tweet that is neither the legal disclaimer nor one of our own plugs.
 *
 *  Two jobs, one definition. In OUR body it is where an unmappable image lands rather than being
 *  dropped (never under a CTA — donor B-roll there reads as a product shot we did not take). In a
 *  SOURCE body it is the slot whose media belongs on our sign-off, whatever number either sits at.
 *  Returns -1 when there is no safe target. Videos are never redirected here — a video posts alone. */
export function fallbackIndex(posts, voice = {}) {
  let i = posts.findIndex((p) => voice.closing && p.text === voice.closing);
  if (i < 0) { i = posts.length - 1; while (i > 0 && ((voice.disclaimer && posts[i].text === voice.disclaimer) || isDisclaimerText(posts[i].text))) i--; }
  if (i >= 0 && ((posts[i].text || '').match(/https?:\/\/\S+/g) || []).some(isTrackedLink)) return -1;
  return i;
}

/**
 * Carry this run's media ids into every cross-posted platform, WITHOUT touching their text.
 *
 * The bug this closes (2026-08-30): this file builds its working array from `platforms.x.posts`
 * alone, then patched with `{ existing }` and no `platformPosts`. buildPlatforms' precedence is
 * `platformPosts || existing[p].posts || posts`, so the cross-post was written back EXACTLY as it
 * was — media ids attached here reached X and nothing else. Since media is attached AFTER the draft
 * is created, which is the normal order, every cross-posted thread published medialess. Julian's
 * Threads copies went out as walls of text into a feed that is almost entirely pictures, and that
 * was the state the channel's first "does anyone click from Threads" read was taken in.
 *
 * TEXT IS NEVER COPIED FROM X. The cross-post's own text carries its own tracked links (the "-th"
 * subid split) and taking X's array would collapse the split back into one column — the exact
 * clobber platforms.mjs exists to prevent. Only `media_ids` is written; `...t` preserves the rest.
 *
 * A platform whose post count does not match X's is SKIPPED rather than index-matched, because a
 * misaligned copy would attach the hook image to a lesson tweet. Silently medialess beats silently
 * wrong, and the caller logs the skip.
 *
 * Pure. Returns null when there is nothing to carry, so the caller's buildPlatforms call falls back
 * to `existing` exactly as it did before.
 */
export function mediaAcrossPlatforms(posts, existing) {
  const out = {};
  for (const p of CROSS_POST_PLATFORMS) {
    const pf = existing?.[p];
    if (!pf?.enabled || !Array.isArray(pf.posts)) continue;
    if (pf.posts.length !== posts.length) continue;              // shape drift — leave it alone
    out[p] = pf.posts.map((t, i) => ({ ...t, media_ids: [...(posts[i].media_ids || [])] }));
  }
  return Object.keys(out).length ? out : null;
}
