#!/usr/bin/env node
// qrt-pick.mjs — the QRT rubric: which library template to use on which post.
//
// Ported from 2t1c/genius (qrt-pick.mjs at aba3896, owner 2026-10-02: "port into PI"). learnings/qrt/catalog.json is a
// snapshot of Genius's library on that day. One change: PI keeps no Genius-style runs/, so loadRuns returns [] without one.
//
//   node qrt-pick.mjs --kind article --whose self|other|sister --has quote,number,story,list,media [--post <piece key|x.com url>] [--top 8] [--json]
//
// The operator, 2026-09-29: "technically I would approve all of them — key is selecting a wide verse and remove the
// concept on Good Fit for specific accounts, since they are just structured, not account specific. Important thing is
// HOW we will select from this library and what is the rubric?" This file is that rubric, the same one the QRT Library
// page runs (learnings/qrt/catalog.json is its data):
//
//   1. Read the post: its kind (an X Article, a post or clip, a person's quote, a launch or news), whose it is (ours,
//      our sister account's, someone else's) and what it can back (a quotable line, a number, a story, a list, media).
//   2. Hard gates. A slot the post can't fill truthfully is out (Jev's per-row reading says the template needs it,
//      ≥ 0.6); a template whose donors ride on a clip or image needs one; vouching and praise may go on our own post
//      (owner, 2026-10-05: "don't filter out third person — that also works too — and self praise is fine", replacing
//      2026-09-29's "yeah no self praise"); house bans and
//      retired templates are out; a template that only works on its author's own post ("I wrote [N] free guides") is out
//      on anyone else's; and a template already used on this post, by either account, is out (operator 2026-09-29: yes
//      to "no shared template per post across accounts").
//   3. Rank: Fit 45 (the family's index on this kind of post, blended with the template's own donors on it when it has
//      3 or more), Proof 35 (median views ranked, a bump when creators re-run it), Saves 20 (median bookmarks ranked),
//      plus MEME_BONUS for a template that rides on its meme (operator 2026-09-30).
//      Free-form templates rank at half (operator 2026-09-29: "deprioritize @anishmoonka since the risk of it not
//      working is a lot higher than the more templated version"). Variety is a rule: the best of each family first.
//   4. Write in the chat, then the saver (qrt-fill.mjs --check): supported 0.7 and honest 0.5 or it's cut. No voice.
//
// THE SHELF (learnings/qrt/shelf.json): the formats the owner approved on the QRT Bookmark Formats sheet (2026-10-05) are
// the pool the self-QRT (echo) and booster lines draw from (owner, 2026-10-06: "yes shelve the formats"). loadCatalog()
// merges them into the library; a post asked for with `shelf: true` sees only them, and every other lane never sees them
// (they say "thread", and the other lanes quote articles and other people's posts).
//
// Our sister account (LearningToan ↔ GeniusGTX) counts as someone else, and vouching for it is allowed (operator
// 2026-09-29: "we can vouch"): `--direction sister` tells the saver so.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isMemeTemplate } from './qrt-meme.mjs';

export const CATALOG_FILE = new URL('./learnings/qrt/catalog.json', import.meta.url);
export const SHELF_FILE = new URL('./learnings/qrt/shelf.json', import.meta.url);
export const KINDS = Object.freeze({ article: 'Article', post: 'Post/clip', quote: 'Quote', launch: 'Launch/news' });
export const WHOSE = Object.freeze(['self', 'sister', 'other']);
export const BACKS = Object.freeze(['quote', 'number', 'story', 'list', 'media', 'clip', 'expert', 'myth']);
export const NEEDS_AT = 0.6;
export const WEIGHTS = Object.freeze({ fit: 0.45, proof: 0.35, saves: 0.2 });
// Operator 2026-09-30: "the templates with the memes tend to perform great — love to see a slight bias to prioritize
// them." A meme template (qrt-meme.mjs) ranks this much higher. Slight on purpose: the family rotation, the cooldown and
// the neighbour rule still decide, so memes win ties and near-ties, not every slot.
export const MEME_BONUS = 0.08;

let cache = null;
/** The library as the rubric reads it: catalog.json, plus the owner's shelf (shelf.json) when it is the default catalog. */
export function loadCatalog(file = CATALOG_FILE) {
  if (file !== CATALOG_FILE) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cache) {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (fs.existsSync(SHELF_FILE)) cache.templates = cache.templates.concat(JSON.parse(fs.readFileSync(SHELF_FILE, 'utf8')).templates);
  }
  return cache;
}

/** PURE. Our kind of post from a run piece's format: an X Article is an article, the rest are posts. */
export const kindOfFormat = (format) => (format === 'X Article' ? 'article' : 'post');

const rankOf = (vals) => { const s = [...vals].sort((a, b) => a - b); return (v) => { let lo = 0; while (lo < s.length && s[lo] < v) lo++; return s.length > 1 ? lo / (s.length - 1) : 1; }; };
const mediaLed = (t) => /^(clip|image)/.test(String(t.media || ''));

/** PURE. Why a template can't go on this post (empty when it can). `post` = { kind, whose, has: Set|[], used: Set|[], recentFamilies?: [], shelf?: true }. */
export function gateOf(t, post) {
  const has = new Set(post.has || []), used = new Set(post.used || []);
  const why = [];
  if (t.retired) why.push(`retired: ${t.retired}`);
  // The owner's shelf is its lanes' whole pool, and those lanes only (shelf.json).
  if (post.shelf && !t.shelf) why.push('not on the owner\'s shelf (this lane draws from the shelf only)');
  if (!post.shelf && t.shelf) why.push('a shelf format: the self-QRT and booster lanes only');
  if (t.unpicked) why.push(t.unpicked);
  if (Array.isArray(t.whose) && !t.whose.includes(post.whose)) why.push(`not for a ${post.whose} line`);
  for (const k of ['quote', 'number', 'story', 'list', 'clip', 'expert', 'myth']) if ((t.needs?.[k] || 0) >= NEEDS_AT && !has.has(k)) why.push(`needs ${{ quote: 'a quotable line', number: 'a number', story: 'a story', list: 'a list', clip: 'a video on the thread\'s first tweet', expert: 'an expert the thread names', myth: 'a belief the thread overturns' }[k]}`);
  // A meme template brings its own clip (qrt-meme.mjs, operator 2026-09-30: "attach the same meme/gif that some of the
  // original QRT had"), so it goes on a post with no media; a template whose clip is content still needs the post's own.
  if (mediaLed(t) && !has.has('media') && !isMemeTemplate(t.id)) why.push('rides on a clip or image');
  // Owner, 2026-10-05: "don't filter out third person — that also works too — and self praise is fine". A page may vouch
  // for and praise its own post; only a frame that speaks as the author stays off someone else's.
  if (post.whose !== 'self' && t.direction === 'self') why.push('only works on the author\'s own post ("I wrote…")');
  if (/house-ban/.test(t.flag || '') && !/near/.test(t.flag || '')) why.push('house-ban construction');
  // `as`: the template id an earlier row wrote for this format (the shelf's Oct 6-8 rewrite), so a cooldown still sees it.
  if (used.has(t.id) || (t.as && used.has(t.as))) why.push('already used on this post');
  return why;
}

/** PURE. Step 3's score for one template on one kind of post, against the whole library `all`. */
export function scorer(catalog) {
  // Ranked against the library alone: the shelf's records are copies of library frames', so adding the shelf moves no
  // other lane's ranking.
  const all = catalog.templates.filter((t) => !t.shelf);
  const proofRank = rankOf(all.map((t) => Math.log10(Math.max(1, t.medianViews || 0))));
  const savesRank = rankOf(all.map((t) => t.medianSaves || 0));
  return (t, kind) => {
    const fam = catalog.matrix[KINDS[kind]]?.families?.[t.family] ?? null;
    const own = t.kinds?.[kind]?.n >= 3 ? t.kinds[kind].fit : null;
    const raw = own != null && fam != null ? (own + fam) / 2 : own ?? fam ?? 1;
    const fit = Math.max(0, Math.min(1, (raw - 0.5) / 1.7));
    const proof = Math.min(1, proofRank(Math.log10(Math.max(1, t.medianViews || 0))) + ((t.reruns || 0) >= 3 ? 0.1 : 0));
    const saves = savesRank(t.medianSaves || 0);
    const base = WEIGHTS.fit * fit + WEIGHTS.proof * proof + WEIGHTS.saves * saves;
    const meme = isMemeTemplate(t.id);
    // `record` is the template's own record; `total` ranks, with the meme bias on top.
    const record = t.freeform ? base * 0.5 : base;
    const total = record + (meme ? MEME_BONUS : 0);
    return { fit: +fit.toFixed(3), proof: +proof.toFixed(3), saves: +saves.toFixed(3), record: +record.toFixed(3), total: +total.toFixed(3), meme, basis: own != null ? 'own + family' : fam != null ? 'family' : 'neutral' };
  };
}

/** PURE. The rubric: every template gated, the rest ranked with the best of each family first. */
export function pick(catalog, post) {
  if (!KINDS[post.kind]) throw new Error(`qrt-pick: kind must be one of ${Object.keys(KINDS).join(', ')}`);
  if (!WHOSE.includes(post.whose)) throw new Error(`qrt-pick: whose must be one of ${WHOSE.join(', ')}`);
  const score = scorer(catalog);
  const ok = [], out = [];
  for (const t of catalog.templates) { const g = gateOf(t, post); if (g.length) out.push({ t, why: g }); else ok.push({ t, s: score(t, post.kind) }); }
  ok.sort((a, b) => b.s.total - a.s.total);
  const seen = new Set(), first = [], rest = [];
  for (const x of ok) (seen.has(x.t.family) ? rest : (seen.add(x.t.family), first)).push(x);
  // In the automated lanes, a family the account used in its last 3 quote posts goes to the back (a rule, not a weight).
  const recent = new Set(post.recentFamilies || []);
  const fresh = first.filter((x) => !recent.has(x.t.family)), stale = first.filter((x) => recent.has(x.t.family));
  return { ranked: fresh.concat(stale, rest), out, families: seen.size };
}

// ─── Rule 1: one template per post, across both accounts ─────────────────────────────────────────────────────
/** PURE. The library or shelf id a run piece was written from: its `template`, else "QRT shelf XX" in its story. */
export const templateOfPiece = (p) => p.template || String(p.story || '').match(/QRT shelf (\w+)/)?.[1] || null;

/** PURE. The post a QRT piece quotes, as every name it goes by (the piece key and, once live, its URL). */
export const targetsOf = (p) => [p.quotes, p.quoteUrl].filter(Boolean).map(String);

/** PURE. Every template already used on `post` (a piece key or a URL) by any QRT in `runs`, whichever account. */
export function usedOn(runs, post) {
  const names = new Set([].concat(post).filter(Boolean).map(String));
  const used = new Set();
  for (const r of runs) for (const p of r.pieces || []) {
    if (p.format !== 'QRT' || !targetsOf(p).some((x) => names.has(x))) continue;
    const t = templateOfPiece(p);
    if (t) used.add(t);
  }
  return used;
}

/** Every run file in runs/. */
export function loadRuns(dir = new URL('./runs/', import.meta.url)) {
  if (!fs.existsSync(dir)) return []; // PI: no runs/ folder of QRT pieces (Genius files its promo QRTs there)
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
}

// ─── Rule 2 in the copy: no self-praise on our own post ───────────────────────────────────────────────────────
// The gate keeps praise templates off our own post; this catches praise written into any other template's slots.
// The saver's honest question cuts the rest (qrt-fill.mjs, "vouching we cannot honestly give").
const PRAISE = [
  /\b(best|greatest|most (important|profound|valuable|useful|honest|insightful)) (thing|piece|article|thread|essay|read|post|guide|explanation)\b/i,
  /\bmasterclass\b/i, /\b10\/10\b/, /\bincredible read\b/i, /\bby far (one of )?the\b/i, /\bshould have \d+\s*[kKmM]? views\b/i,
  /\b(this|the|our) (article|essay|thread|piece|post) (will|is going to) (change|force|make|blow)\b/i,
  /\bthe only (article|thread|essay|guide|piece) you('ll)? need\b/i, /\b(we|I) (re-?read|read) this (every|each)\b/i,
];
/** PURE. The praise a line puts on our own post (empty when none). */
export const selfPraiseOf = (text) => PRAISE.map((re) => String(text || '').match(re)?.[0]).filter(Boolean);

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const kind = arg('--kind', 'article'), whose = arg('--whose', 'other');
  const has = (arg('--has', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = has.filter((h) => !BACKS.includes(h));
  if (bad.length) { console.error(`--has takes ${BACKS.join(',')} (got ${bad.join(',')})`); process.exit(1); }
  const postName = arg('--post');
  const used = postName ? usedOn(loadRuns(), postName) : new Set();
  const cat = loadCatalog();
  const { ranked, out, families } = pick(cat, { kind, whose, has, used });
  const top = ranked.slice(0, Number(arg('--top', 8)));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(top.map((x) => ({ id: x.t.id, family: x.t.family, class: x.t.class, skeleton: x.t.skeleton, ...x.s, donor: x.t.donor })), null, 2)); process.exit(0); }
  console.log(`${KINDS[kind]} · ${whose === 'self' ? 'our own post' : whose === 'sister' ? 'our sister account\'s post' : 'someone else\'s post'} · backs ${has.join(', ') || 'nothing'}${used.size ? ` · already used on it: ${[...used].join(', ')}` : ''}`);
  console.log(`${ranked.length} fit, ${families} families, ${out.length} ruled out\n`);
  top.forEach((x, i) => console.log(`${String(i + 1).padStart(2)}. ${x.t.id} · ${x.t.family} · ${x.t.class}${x.t.freeform ? ' · free-form (half)' : ''} · score ${x.s.total} (fit ${x.s.fit} from ${x.s.basis}, proof ${x.s.proof}, saves ${x.s.saves})\n    ${x.t.skeleton.replace(/\n+/g, ' / ').slice(0, 140)}\n    donor ${x.t.donor?.url || '—'}`));
}
