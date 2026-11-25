// scripts/article-craft.mjs — the article lane's craft rules: which cover look, which title skeleton, and where the
// media breaks go. Pure; scripts/run-articles.mjs plans, checks and fills with them.
//
// Owner, 2026-10-07 (thread "Fix article covers, titles and media"), on R2026-10-08's articles:
//   "we have set a few formats that we can choose from, but why is it that it seems like most of them are following
//    one or two templates? … We also have set a very clear framework and templates for how to write those titles,
//    but these titles are just completely off the mark."
//   "Inside of these articles, I don't think you have included the media, like how we were doing clipping for the
//    articles … Clipping from the podcast, adding them in. … Split the content up to make it more readable."
// What went wrong, read off the 16 review drafts:
//   - covers: each one was a --ref copy of its source article's cover through the health system, so the run drew
//     from the sources (a blurred email screenshot, a book page, a medallion with a word on it) and the health
//     medium hash (eight of sixteen in ink or pencil), never from the eight graphic looks set for this lane
//     (style/cover-graphic-styles.md, cover-gen.mjs --style graphic).
//   - titles: each copied its source's skeleton, and the 8/10 bar let five titles through with no skeleton at
//     all; four were the [belief]. [reversal]. frame, which has never reached the top decile, three of them in
//     the banned "isn't X. They're Y." costume; the framework's best bands (how-in-timeframe, how-twist, if-you)
//     carried one between them; no title had alternates.
//   - media: not one article carried a clip or an image. The lane's brief never asked for one, and no step
//     placed one (the thread lane has scripts/run-media.mjs; the article lane had nothing).
// So the plan now ASSIGNS each article a cover look and a title skeleton, rotating across the run so no look or
// skeleton crowds it out, and the writer marks media slots that `run-articles.mjs media` fills from the podcast
// pool (clips) and the cover's own look (illustrations).
import { classify, score, TEMPLATES } from '../title-score.mjs';

// ---- cover looks --------------------------------------------------------------------------------

/** The eight looks of cover-gen.mjs --style graphic (style/cover-graphic-styles.md), with the "choosing a look"
 *  row the writer needs to write a scene in that look's grammar. Order is the rotation order: concept first. */
export const COVER_LOOKS = Object.freeze([
  { id: 'concept', fits: 'a thesis that fits one sentence: one visual sentence, crimson ground, cut-out men in black suits, white objects, nothing that is not the idea' },
  { id: 'threshold', fits: 'change, a decision, the other side of a wait: a torn opening between a starry black field and a fragment of old painting, one silhouette at the edge' },
  { id: 'bio', fits: 'a mechanism inside the body: one living structure (nerve, gut lining, vessel, cell, molecule) as a point cloud or wireframe in the dark, one hairline accent' },
  { id: 'spotlight', fits: 'one thing, one test, one substance: one ordinary object, slightly larger than life, cross-hatched under one hard spotlight on a black stage' },
  { id: 'flat', fits: 'a list, a choice, three of anything: a 1960s poster, two or three flat colours, a spatial metaphor (a road that forks, a wall with three doors)' },
  { id: 'wire', fits: 'a mechanism, a signal, a path: a two-colour screen print, one continuous line, the accent used once as the thing the picture is about' },
  { id: 'halftone', fits: "a person's routine or an authority's advice: a halftone figure, face hidden, with one oversized flat symbol for the substance" },
  { id: 'engraved', fits: 'stakes, time, a whole-life outcome: scratchboard engraving, one small figure from behind facing one enormous void' },
]);
const LOOK_IDS = COVER_LOOKS.map((l) => l.id);

/** PURE. One look per row, rotating so the run uses as many looks as it has rows (8 rows → 8 looks; 16 → each
 *  twice), never the page's previous article's look. `lastLook` = { pageKey: lookId } from the sources log. */
export function assignCoverLooks(rows, { lastLook = {} } = {}) {
  const used = new Map(LOOK_IDS.map((id) => [id, 0]));
  return rows.map((row, i) => {
    const order = LOOK_IDS.map((_, k) => LOOK_IDS[(i + k) % LOOK_IDS.length]);
    const pick = order.filter((id) => id !== lastLook[row.key])
      .sort((a, b) => used.get(a) - used.get(b) || order.indexOf(a) - order.indexOf(b))[0];
    used.set(pick, used.get(pick) + 1);
    return pick;
  });
}

// ---- title skeletons ----------------------------------------------------------------------------

/** The skeletons a run rotates through, best evidence band first (style/title-templates.md). The conditional
 *  ones (letter, n-list, hero-object, happening-now, imperative) are not assigned: they fit one piece in a
 *  hundred and the writer cannot bend an article to them. A listicle is the one exception: n-list. */
export const TITLE_ROTATION = Object.freeze(['how-time', 'how-twist', 'if-you', 'the-most', 'concept-colon', 'principles-of', 'how-plain', 'two-sentence']);
/** How often a skeleton may appear in one run: a fifth of the rows, at least two; once, for a skeleton that has
 *  never reached the corpus's top decile (two-sentence, principles-of): steady, never the run's backbone. */
export const skeletonCap = (n, id = null) => (TEMPLATES.find((t) => t.id === id)?.evidence.top === 0 ? 1 : Math.max(2, Math.ceil(n / 5)));

/** PURE. One skeleton per row. A row keeps its source's skeleton when that skeleton is in the rotation and still
 *  under the cap (the replica rule, docs/article-lane.md §3); otherwise it takes the least-used rotation skeleton,
 *  best band first. A listicle takes n-list. */
export function assignTitleSkeletons(rows) {
  const cap = (id) => skeletonCap(rows.length, id);
  const used = new Map(TITLE_ROTATION.map((id) => [id, 0]));
  return rows.map((row) => {
    if (row.listicle) return 'n-list';
    const own = classify(String(row.source?.title || ''))?.id;
    // A same-hook article keeps the source's skeleton whatever the rotation says: the hook is the point of it.
    const pick = own && row.mode === 'same-hook' && TEMPLATES.some((t) => t.id === own) ? own
      : own && used.has(own) && used.get(own) < cap(own) ? own
      : [...TITLE_ROTATION].sort((a, b) => (used.get(a) >= cap(a)) - (used.get(b) >= cap(b)) || used.get(a) - used.get(b)
        || TITLE_ROTATION.indexOf(a) - TITLE_ROTATION.indexOf(b))[0];
    used.set(pick, (used.get(pick) || 0) + 1);
    return pick;
  });
}

/** Topic spread (owner, 2026-10-07: "increase the diversity for the article topics we write about"): how many
 *  of a run's articles may share one reader problem. A quarter of the run, at least two. */
export const topicCap = (n) => Math.max(2, Math.ceil(n / 4));

/** The two ways an article takes its source. `replica`: the source's format and section order, our title skeleton
 *  and angle. `same-hook` (owner, 2026-10-07: "sometimes it could be taking the same angle/hook as the original
 *  post, rewrite our version and plug the product inside"): the source's angle, promise and hook, in our words. */
export const ARTICLE_MODES = Object.freeze(['replica', 'same-hook']);

/** PURE. One mode per row: the third of each source pool with the most-viewed sources takes `same-hook` (a hook that
 *  reached the most people is the one worth keeping); the rest `replica`. Ties keep plan order. */
export function assignArticleModes(rows) {
  // Per source pool: a thread's views and an article's views are not the same scale.
  const top = new Set();
  for (const kind of new Set(rows.map((r) => r.source?.kind || 'article'))) {
    const group = rows.map((r, i) => ({ i, r })).filter(({ r }) => (r.source?.kind || 'article') === kind);
    group.sort((a, b) => (Number(b.r.source?.views) || 0) - (Number(a.r.source?.views) || 0) || a.i - b.i)
      .slice(0, Math.ceil(group.length / 3)).forEach(({ i }) => top.add(i));
  }
  return rows.map((_, i) => (top.has(i) ? 'same-hook' : 'replica'));
}

/** The brief line for a mode. */
export function modeBrief(mode) {
  return mode === 'same-hook'
    ? 'Mode: same hook (owner, 2026-10-07: "taking the same angle/hook as the original post, rewrite our version and plug the product inside"). Keep the source\'s angle, its promise and how its opening hooks the reader, and the title in the source\'s skeleton (assigned below). Everything is in our words and this page\'s voice: never copy a sentence. The plug sits inside the steps as usual.'
    : 'Mode: replica. The source\'s format and section order; the angle, the opening and the title are ours (the title follows the skeleton assigned below).';
}

/** The brief line for a skeleton: its name, its slots and the corpus examples. */
export function skeletonBrief(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  return t ? `${t.name}. Slots: ${t.slots} Examples: ${t.examples.map((e) => `"${e}"`).join(' · ')}.` : id;
}

/** "isn't X. They're Y." in any costume: a negation in the first sentence and the subject restated in the second.
 *  The house ban (AGENTS.md GT voice) on "It's not X. It's Y."; title-score only catches the literal form. */
export const NOT_X_ITS_Y = /\b(isn'?t|aren'?t|wasn'?t|weren'?t|not|never)\b[^.!?]*[.!?]\s+(it|he|she|they|you|we)\b/i;

export const TITLE_RULES = Object.freeze({ minScore: 9, alternates: 8, alternateSkeletons: 5 });

/** PURE. Why a package's titles fail the framework, or []. `meta.titles` is the alternates, separated by " | ". */
export function titleIssues(meta = {}, { skeleton = null, rules = TITLE_RULES } = {}) {
  const issues = [];
  const h1 = String(meta.title || '').trim();
  if (!h1) return ['no title'];
  const s = score(h1);
  if (skeleton && s.template?.id !== skeleton) issues.push(`title skeleton is ${s.template?.id || 'none'}; the plan assigned ${skeleton} (${TEMPLATES.find((t) => t.id === skeleton)?.name || skeleton})`);
  if (s.score < rules.minScore) issues.push(`title-score ${s.score}/10 (${rules.minScore} or more): ${s.flags.join('; ') || 'see title-score.mjs'}`);
  if (NOT_X_ITS_Y.test(h1)) issues.push('title is the banned "isn\'t X. It\'s Y." construction');
  if (/^[a-z]/.test(h1)) issues.push('title starts lowercase: sentence case starts with a capital');
  const alts = String(meta.titles || '').split('|').map((x) => x.trim()).filter(Boolean).filter((x) => x !== h1);
  const kinds = new Set(alts.map((a) => classify(a)?.id).filter(Boolean));
  if (alts.length < rules.alternates) issues.push(`${alts.length} alternate titles (${rules.alternates} or more, in front-matter "titles:", separated by " | ")`);
  else if (kinds.size < rules.alternateSkeletons) issues.push(`alternates span ${kinds.size} skeletons (${rules.alternateSkeletons} or more)`);
  return issues;
}

/** PURE. The scratchpad block that carries the H1 and the scored alternates, so the owner can swap in Typefully. */
export function titlesBlock(meta = {}) {
  const all = [String(meta.title || '').trim(), ...String(meta.titles || '').split('|').map((x) => x.trim())].filter(Boolean);
  const rows = [...new Set(all)].map((t) => ({ t, s: score(t) })).sort((a, b) => b.s.score - a.s.score);
  return ['TITLES (H1 first, then alternates by score)', ...rows.map(({ t, s }, i) => `${i === 0 && t === all[0] ? 'H1 ' : '   '}${s.score}/10 · ${s.template?.id || 'no skeleton'} · ${t}`)].join('\n');
}

// ---- media breaks -------------------------------------------------------------------------------

/** Owner, 2026-10-07: "Clipping from the podcast, adding them in … Split the content up to make it more readable."
 *  The Jasper package (articles/2026-09-13-jasper-personality-back-60-days.md) is the reference: an illustration
 *  where the lens is introduced, a card after the protocol. `min` media in all, `minClips` of them clips, at
 *  least `gapWords` between two, none in the first `leadWords`, never beside a plug's link line. */
export const MEDIA_RULES = Object.freeze({ min: 3, max: 5, minClips: 2, gapWords: 150, leadWords: 120 });
export const MEDIA_SLOT = /^\{\{(CLIP|IMAGE):\s*(.+?)\s*\}\}$/;

/** PURE. The media slots in a body: [{ line, kind: 'clip'|'image', text, wordsBefore }]. */
export function mediaSlots(body) {
  const lines = String(body).split('\n');
  const out = [];
  let words = 0;
  lines.forEach((l, line) => {
    const m = l.trim().match(MEDIA_SLOT);
    if (m) out.push({ line, kind: m[1].toLowerCase(), text: m[2], wordsBefore: words });
    else if (!/^#/.test(l)) words += l.split(/\s+/).filter(Boolean).length;
  });
  return out;
}

/** PURE. The body without its media slot lines (what the gate and the word count read). */
export const stripMediaSlots = (body) => String(body).split('\n').filter((l) => !MEDIA_SLOT.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n');

/** PURE. Why a body's media slots break the rules, or []. */
export function mediaIssues(body, { rules = MEDIA_RULES } = {}) {
  const slots = mediaSlots(body);
  const lines = String(body).split('\n');
  const issues = [];
  if (slots.length < rules.min) issues.push(`${slots.length} media slot(s): at least ${rules.min} ({{CLIP: …}} / {{IMAGE: …}} alone on a line)`);
  if (slots.length > rules.max) issues.push(`${slots.length} media slots: at most ${rules.max}`);
  const clips = slots.filter((s) => s.kind === 'clip').length;
  if (clips < rules.minClips) issues.push(`${clips} clip slot(s): at least ${rules.minClips} {{CLIP: <the claim a podcast clip should prove>}}`);
  const near = (n) => [lines[n - 1], lines[n - 2], lines[n + 1], lines[n + 2]].some((l) => /^\{\{LINK\d*\}\}$/.test(String(l || '').trim()));
  slots.forEach((s, i) => {
    if (s.wordsBefore < rules.leadWords) issues.push(`media slot ${i + 1} sits in the first ${rules.leadWords} words`);
    if (i && s.wordsBefore - slots[i - 1].wordsBefore < rules.gapWords) issues.push(`media slots ${i} and ${i + 1} are under ${rules.gapWords} words apart`);
    if (near(s.line)) issues.push(`media slot ${i + 1} sits beside a plug link`);
    if (s.text.split(/\s+/).length < 5) issues.push(`media slot ${i + 1} is too thin to match: say the claim or the scene in a sentence`);
  });
  return issues;
}

/** PURE. Fill each slot with its media embed, or drop the slot when nothing was found for it. `media` is the
 *  media pass's slots for this revision: [{ line, mediaId|null }]. */
export function fillMedia(markdown, media = []) {
  const byLine = new Map((media || []).map((m) => [m.line, m.mediaId]));
  // Slot lines are counted on the body, which starts at the markdown's first line (parsePackage).
  const lines = String(markdown).split('\n');
  const out = lines.map((l, n) => (MEDIA_SLOT.test(l.trim()) ? (byLine.get(n) ? `<typ:media media_id="${byLine.get(n)}" />` : null) : l));
  return out.filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}
