// swipe-media.mjs — media for our tweets, found in the swipe DB by Jev (docs/typesafe-jev.md "Media from
// the swipe DB"). The swipe DB holds ~23k tweets that carried an image or a video; a tweet of ours that
// makes the same point as one of them can carry that media.
//
//   index   every swipe tweet with media: its text, what media it has, its thread's niche. Built from
//           Airtable, cached locally (12h) because a cold read of ~22k rows takes ~50s. No attachment
//           URLs in the cache: Airtable's expire, so a pick is re-read at attach time.
//   match   per tweet of ours: niche filter, BM25 shortlist (repost duplicates removed), then Jev asks
//           MEDIA_QUESTIONS per pair and the rules below decide.
//
// Jev reads TEXT ONLY: it judges the tweet the media was attached to, not the image. Operator
// 2026-09-23: that is enough for now. Questions and thresholds live here, in one place (AGENTS.md);
// the thresholds are first guesses until labelled picks calibrate them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choice, noul } from './jev.mjs';
import { askAll, shortlist, tokens } from './clip-judge.mjs';
import { swipeNiches, TABLES } from './config.mjs';
import { questionSetHash } from './swipe-classify.mjs';

export const MEDIA_QUESTIONS = {
  same_point: choice('How does the point of `source_tweet` relate to the point of `tweet` (`thread` is the thread `tweet` belongs to)?', {
    same: '`source_tweet` makes the same specific point as `tweet` (same topic and same claim), so the image or video that illustrated `source_tweet` would illustrate `tweet`.',
    related: 'Same topic, but a different claim or angle.',
    unrelated: 'A different topic.',
  }),
  same_subject: noul('Is the main subject of `source_tweet` (the substance, food, drink, condition, body part or habit it is about) the same as the main subject of `tweet`, which `subject` names when it is given?', {
    true: 'Both are about the same specific thing, for example both about B12, both about diet soda, both about caffeine timing.',
    false: 'They are about different things, even if the wording or the story is similar (for example one about vitamin D, the other about B12).',
  }),
  visual_ref: noul('Does `source_tweet` point at its attached image or video, rather than standing alone as text?', {
    true: 'It refers to the media: "this chart", "look at", "here is", "below", a diagram or a photo it describes.',
    false: 'The text stands alone; any media is decoration.',
  }),
};

export const MEDIA_RULES = {
  model: 'jev-1.13', // pinned; never jev-latest
  shortlist: 30, // pairs sent to Jev per tweet, after duplicates are removed
  shortlistPool: 150, // BM25 candidates before de-duplication
  relatedCredit: 0.3, // fit = P(same) + relatedCredit*P(related) + visualCredit*visual_ref
  visualCredit: 0.05,
  // 0.70 -> 0.75 (operator review 2026-09-24): both off-topic picks of the first run scored exactly 0.70,
  // every good one 0.77 or more.
  attach: { minSame: 0.75, minSubject: 0.6 }, // => 'attach' (both)
  // Image check on the top candidates: the pinned vision model only describes (the fleet LLM_MODEL may be
  // text-only); Jev decides: shows_subject >= minShows and other_brand < maxBrand.
  vision: { model: 'anthropic/claude-haiku-4.5', tries: 3, minShows: 0.6, maxBrand: 0.5 },
  review: { minSamePlusRelated: 0.5 }, // => 'review', else 'none'
  minTextChars: 30, // shorter swipe tweets carry too little text to judge
  terseChars: 80, // a tweet shorter than this is matched together with its thread's hook
  subject: { maxPhrases: 60, minConfidence: 0.3, boost: 3 }, // the named subject, and how much it weights the search
  // The MEDIA_QUESTIONS_HASH the attach thresholds were calibrated on (operator labels on review copies).
  // A question change leaves --attach refused until recalibrated (AGENTS.md); review copies still run.
  calibratedHash: null,
  hookVideoOnly: true, // operator 2026-09-24: media on the hook (tweet 1) must be a video
  // Placement (operator 2026-09-24): no video before a plug, on a bridge or on the weld (images only
  // there), and the first tweet of a CTA takes a video only of maxVideoS or less, at these higher bars.
  // The hook takes the same bars without the length cap (highBar, operator 2026-09-24).
  // First guesses above the ordinary attach and image bars.
  // Eased with the clip bar (operator 2026-09-24, 'make it more flexible'): a step above attach, not a wall.
  strict: { minSame: 0.8, minSubject: 0.7, minShows: 0.7, maxVideoS: 30 },
  // Days before the same swipe media may go on the same account again. 0 = no block: the operator dropped
  // the 30-day rule on 2026-09-24 ("reuse them as wish and as frequent as needed"), temporarily. Set 30 to
  // restore it. Uses are still recorded, and operator reject labels still block everywhere.
  cooldownDays: 0,
  cacheTtlMs: 12 * 3600 * 1000,
  workers: 12,
  deadlineMs: 20_000,
};

// ---- What media a swipe row carries (media.mjs rules) -----------------------------------------------
/**
 * A swipe row's attachable media. A video wins (Video File, else Video URL) and its poster image in
 * `Media` is never used; otherwise up to 4 images from `Media`. Returns { kind, items:[{url,name,type}] }
 * or null. Pure.
 */
export function mediaOf(fields = {}) {
  const vf = (fields['Video File'] || [])[0];
  if (vf?.url) return { kind: 'video', items: [{ url: vf.url, name: vf.filename || 'video.mp4', type: vf.type || 'video/mp4' }] };
  if (fields['Video URL']) return { kind: 'video', items: [{ url: fields['Video URL'], name: 'video.mp4', type: 'video/mp4' }] };
  if (fields['Media Type'] === 'Video') return null; // a video with no file: only its poster is left
  const imgs = (fields.Media || []).filter((a) => a?.url && !String(a.type || '').startsWith('video')).slice(0, 4);
  if (!imgs.length) return null;
  return { kind: 'images', items: imgs.map((a) => ({ url: a.url, name: a.filename || 'image.jpg', type: a.type || 'image/jpeg' })) };
}

/** Same media, different row (reposts): first attachment's filename+size, else the normalized text. Pure. */
export function dedupeKey(fields = {}) {
  const a = (fields['Video File'] || [])[0] || (fields.Media || [])[0];
  if (a?.filename && a?.size) return `att:${a.filename}:${a.size}`;
  if (fields['Video URL']) return `url:${fields['Video URL']}`;
  return 'txt:' + createHash('sha1').update(String(fields.Text || '').toLowerCase().replace(/\W+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** Heads -> child rec id -> {niche, impressions, threadUrl}. `Tweets` includes the head itself. Pure. */
export function headMap(heads = []) {
  const m = new Map();
  for (const h of heads) {
    const info = { niche: h.fields?.Niche ?? null, impressions: h.fields?.Impressions ?? 0, threadUrl: h.fields?.['Tweet URL'] ?? null };
    m.set(h.id, info);
    for (const c of h.fields?.Tweets || []) if (!m.has(c)) m.set(c, info);
  }
  return m;
}

/** Swipe rows + heads -> index entries (no URLs). Pure. */
export function indexEntries(rows, heads, { minTextChars = MEDIA_RULES.minTextChars } = {}) {
  const heads_ = headMap(heads);
  const out = [];
  for (const r of rows) {
    const f = r.fields || {};
    const text = String(f.Text || '').trim();
    const m = mediaOf(f);
    if (!m || text.length < minTextChars) continue;
    const h = heads_.get(r.id) || {};
    out.push({ id: r.id, text, kind: m.kind, count: m.items.length, key: dedupeKey(f), tweetUrl: f['Tweet URL'] ?? null,
      niche: h.niche ?? null, impressions: h.impressions ?? 0, threadUrl: h.threadUrl ?? null });
  }
  return out;
}

export const INDEX_FIELDS = ['Text', 'Media', 'Video File', 'Video URL', 'Media Type', 'Tweet URL'];

/** The index, from the local cache when fresh (TTL), else rebuilt from Airtable and cached. */
export async function loadIndex(at, { base = 'xdb', refresh = false, now = Date.now(), dir = join(tmpdir(), 'swipe-media'), rules = MEDIA_RULES, log = () => {} } = {}) {
  const path = join(dir, `index-${base}.json`);
  if (!refresh && existsSync(path)) {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (now - c.builtAt < rules.cacheTtlMs) return { entries: c.entries, builtAt: c.builtAt, cached: true };
  }
  log('Reading the swipe DB (media tweets + thread heads)…');
  const rows = await at.listAll(TABLES.swipe, { formula: 'OR({Media},{Video File},{Video URL})', fields: INDEX_FIELDS });
  const heads = await at.listAll(TABLES.swipe, { formula: '{Tweet Number}=1', fields: ['Tweets', 'Niche', 'Impressions', 'Tweet URL'] });
  // A folded thread's body tweets are not rows (thread-fold.mjs): the client expanded them from the heads.
  for (const h of heads) for (const id of h.fields?.Tweets || []) { const v = at.foldedRecord?.(id); if (v && mediaOf(v.fields)) rows.push(v); }
  const entries = indexEntries(rows, heads, rules);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ builtAt: now, entries }));
  return { entries, builtAt: now, cached: false };
}

// ---- Decisions (pure) --------------------------------------------------------------------------------
export function mediaDecision(answers = {}, { rules = MEDIA_RULES } = {}) {
  const p = answers.same_point?.probabilities;
  if (!p) return { fit: null, verdict: null };
  const same = Number(p.same ?? 0), related = Number(p.related ?? 0), visual = Number(answers.visual_ref?.noul ?? 0);
  const subject = answers.same_subject?.noul == null ? null : Number(answers.same_subject.noul);
  const fit = same + rules.relatedCredit * related + rules.visualCredit * visual;
  // Attach needs the same point AND the same subject: a shared anecdote ("my personality changed") about a
  // different substance is not a match (operator review 2026-09-24).
  const verdict = same >= rules.attach.minSame && (subject ?? 0) >= rules.attach.minSubject ? 'attach'
    : same + related >= rules.review.minSamePlusRelated ? 'review' : 'none';
  return { fit, verdict, same, related, subject, visual };
}

/**
 * One source per tweet, each source at most once per run, never a blocked one (cooldown). Tweets with the
 * strongest best match choose first, so a contested source goes where it fits best. `blocked` holds swipe
 * ids AND media keys, so a repost of media already placed (a different row, the same file) is blocked too. Pure.
 * `perTweet[i]` is that tweet's candidates ({id, fit, verdict, …}).
 */
export function pickForTweets(perTweet, { blocked = new Set() } = {}) {
  const order = perTweet.map((c, i) => [i, Math.max(-1, ...c.filter((x) => x.verdict === 'attach').map((x) => x.fit))]).sort((a, b) => b[1] - a[1]);
  const used = new Set();
  const picks = perTweet.map(() => null);
  for (const [i] of order) {
    const best = [...perTweet[i]].filter((c) => c.verdict === 'attach' && !used.has(c.key) && !blocked.has(c.id) && !blocked.has(c.key)).sort((a, b) => b.fit - a.fit || b.impressions - a.impressions)[0];
    if (best) { picks[i] = best; used.add(best.key); }
  }
  return picks;
}

// ---- The tweet's subject: code proposes phrases, Jev selects one (select, don't generate) -------------
const NO_SUBJECT = 'none of these'; // "of" is a stop word, so no candidate phrase can ever equal this key
/**
 * Candidate subject phrases from a tweet: runs of 1-3 content words inside one clause (a run never
 * crosses . , ; : ! ? or a dash), hyphenated compounds kept whole. Short words count only with a digit
 * (B12, D3) or 3+ letters (gut, tea). Ordered for the cap: phrases the tweet repeats first, then 1- and
 * 2-word runs in reading order, then 3-word runs. Pure.
 */
export function candidatePhrases(text, { max = MEDIA_RULES.subject.maxPhrases } = {}) {
  const clauses = String(text || '').replace(/[\u2019']/g, '').split(/[.,;:!?()\n\u2013\u2014]+|\s-+\s/);
  const isContent = (w) => /[a-z]/i.test(w) && tokens(w).length >= 1 && (w.length >= 3 || /\d/.test(w));
  const found = new Map();
  let pos = 0;
  for (const clause of clauses) {
    const words = clause.split(/[^A-Za-z0-9-]+/).map((w) => w.replace(/^-+|-+$/g, '')).filter(Boolean);
    for (let i = 0; i < words.length; i++, pos++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const run = words.slice(i, i + n);
        if (!run.every(isContent)) break;
        const phrase = run.join(' ').toLowerCase();
        const f = found.get(phrase);
        if (f) f.count++; else found.set(phrase, { phrase, n, pos, count: 1 });
      }
    }
  }
  const late = (x) => (x.n === 3 ? 1 : 0); // 3-word runs are rarely the subject and go last
  return [...found.values()].sort((a, b) => b.count - a.count || late(a) - late(b) || a.pos - b.pos || a.n - b.n).slice(0, max).map((x) => x.phrase);
}

/** The choice question over one tweet's candidate phrases. SUBJECT_TEMPLATE_HASH covers its wording. */
export const subjectQuestion = (phrases) => ({
  subject: choice('Which phrase names the main subject of `tweet`: the specific substance, food, drink, condition, body part or habit it is about?',
    Object.fromEntries([...phrases.filter((p) => p !== NO_SUBJECT).map((p) => [p, `The tweet is mainly about ${p}.`]), [NO_SUBJECT, 'None of these phrases names what the tweet is about.']])),
});

/**
 * Per tweet: the named subject, or null when Jev is unsure or none fits. Runs through askAll (worker cap,
 * breaker); `failed` counts reads that errored, so a caller can say the search ran unweighted.
 */
export async function tweetSubjects(client, tweets, { thread = null, rules = MEDIA_RULES } = {}) {
  const texts = tweets.map((tw) => (terseIn(tw, thread, rules) ? `${tw}\n${thread}` : tw));
  const phrases = texts.map((tx) => candidatePhrases(tx, { max: rules.subject.maxPhrases }));
  const ask = texts.map((_, i) => i).filter((i) => phrases[i].length);
  const { results, breaker } = await askAll(client, ask.map((i) => ({ tweet: texts[i] })), (k) => subjectQuestion(phrases[ask[k]]),
    { workers: rules.workers, role: 'swipe-media', reading: 'media-subject-read' });
  const subjects = tweets.map(() => null);
  let failed = 0;
  ask.forEach((i, k) => {
    const r = results[k];
    if (!r.ok) { failed++; return; }
    const a = r.answers.subject;
    if (a?.choice && a.choice !== NO_SUBJECT && (a.confidence ?? 0) >= rules.subject.minConfidence) subjects[i] = a.choice;
  });
  return { subjects, failed, breaker };
}

/** A tweet too short to match alone; it is read together with its thread's hook. Pure. */
const terseIn = (tw, thread, rules) => Boolean(thread) && thread !== tw && String(tw).trim().length < rules.terseChars;

// ---- Match --------------------------------------------------------------------------------------------
/** The rules for a strict tweet (the first tweet of a CTA): the attach bar raised to rules.strict. Pure. */
export const strictRules = (rules = MEDIA_RULES) => ({ ...rules, attach: { minSame: rules.strict.minSame, minSubject: rules.strict.minSubject } });

/**
 * Our tweets against the index. Returns per tweet: { tweet, candidates (ranked), pick }.
 * `niche`: an account niche list (swipeNiches aliases apply), or null for the whole DB.
 */
export async function matchMedia(client, tweets, entries, { niche = null, blocked = new Set(), thread = null, vision = null, videoOnly = new Set(), imagesOnly = new Set(), strict = new Set(), highBar = new Set(), subjects = null, rules = MEDIA_RULES } = {}) {
  const terse = (tw) => terseIn(tw, thread, rules);
  const allowed = niche?.length ? new Set(swipeNiches(niche)) : null;
  const pool = allowed ? entries.filter((e) => allowed.has(e.niche)) : entries;
  const videos = pool.filter((e) => e.kind === 'video');
  const read = subjects ? { subjects, failed: 0 } : await tweetSubjects(client, tweets, { thread, rules });
  const named = read.subjects;
  const pairs = [];
  tweets.forEach((tweet, t) => {
    // The hook takes a video or nothing (MEDIA_RULES.hookVideoOnly): its search runs over videos only.
    // A strict tweet with no image check cannot verify a video's length, so it takes images only.
    const noVideo = imagesOnly.has(t) || (strict.has(t) && !vision);
    const cands = videoOnly.has(t) ? videos : noVideo ? pool.filter((e) => e.kind !== 'video') : pool;
    const seen = new Set();
    // A terse tweet ("It gets worse.") is only matchable in its thread, so its hook rides along. A tweet
    // that says enough on its own is matched alone: the hook's other subjects would blur its judgment.
    // The named subject's words weigh `subject.boost` times the rest, so incidental words rank lower.
    const base = terse(tweet) ? `${tweet}\n${thread}` : tweet;
    const query = named[t] ? `${named[t]} ${base}` : base;
    const weights = named[t] ? new Map(tokens(named[t]).map((w) => [w, rules.subject.boost])) : null;
    for (const i of shortlist(query, cands.map((e) => e.text), rules.shortlistPool, { weights })) {
      if (seen.has(cands[i].key)) continue; // a repost of media already on the list
      seen.add(cands[i].key);
      pairs.push({ t, e: cands[i] });
      if (seen.size >= rules.shortlist) break;
    }
  });
  const { results, breaker } = await askAll(client, pairs.map(({ t, e }) => ({ tweet: tweets[t], subject: named[t] ?? null, thread: terse(tweets[t]) ? thread : null, source_tweet: e.text })), MEDIA_QUESTIONS,
    { workers: rules.workers, role: 'swipe-media', reading: 'media-pair-read' });
  const perTweet = tweets.map(() => []);
  pairs.forEach(({ t, e }, k) => {
    const r = results[k];
    perTweet[t].push({ ...e, ...(r.ok ? { ...mediaDecision(r.answers, { rules: strict.has(t) || highBar.has(t) ? strictRules(rules) : rules }), model: r.model } : { fit: null, verdict: null, error: r.error }) });
  });
  for (const c of perTweet) c.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1) || b.impressions - a.impressions);
  const picks = vision ? await pickWithVision(perTweet, tweets, vision, { blocked, rules, subjects: named, strict, highBar }) : pickForTweets(perTweet, { blocked });
  return { results: tweets.map((tweet, t) => ({ tweet, subject: named[t] ?? null, candidates: perTweet[t], pick: picks[t] })), breaker, pairs: pairs.length, pool: pool.length, subjectsFailed: read.failed };
}

/**
 * Like pickForTweets, but each tweet's attach candidates are shown to `vision(tweet, candidate)` in fit
 * order (up to rules.vision.tries) and the first it passes is picked. A candidate it rejects is marked
 * (`vision: {fits:false, reason}`) so the report can say why. Tweets with the strongest match go first.
 */
export async function pickWithVision(perTweet, tweets, vision, { blocked = new Set(), rules = MEDIA_RULES, subjects = [], strict = new Set(), highBar = new Set() } = {}) {
  const order = perTweet.map((c, i) => [i, Math.max(-1, ...c.filter((x) => x.verdict === 'attach').map((x) => x.fit))]).sort((a, b) => b[1] - a[1]);
  const used = new Set();
  const picks = perTweet.map(() => null);
  for (const [i] of order) {
    const pool = perTweet[i].filter((c) => c.verdict === 'attach' && !used.has(c.key) && !blocked.has(c.id) && !blocked.has(c.key))
      .sort((a, b) => b.fit - a.fit || b.impressions - a.impressions).slice(0, rules.vision.tries);
    for (const c of pool) {
      c.vision = await vision(tweets[i], c, { subject: subjects[i] ?? null, strict: strict.has(i), highBar: highBar.has(i) });
      if (c.vision?.fits && !c.vision?.otherBrand) { picks[i] = c; used.add(c.key); break; }
    }
  }
  return picks;
}

// ---- Image check: a vision model DESCRIBES the image, Jev DECIDES ---------------------------------------
// Owner rule (AGENTS.md): every decision is Jev's. Jev cannot see, so the vision model only writes what the
// image shows (it never sees our tweet, so it cannot lean toward a pass) and Jev judges that description
// against the tweet with two nouls.
export const DESCRIBE_PROMPT = `Describe this image (the first image, or the poster frame of a video, from a social post) for someone who cannot see it. Do not judge it.

Answer with JSON only: {"shows": "what the image shows, one or two sentences: the specific subject (substance, food, drink, condition, body part, habit) or what a chart, study, diagram or screenshot is about", "text": "the visible words, shortened", "branding": "any creator handle, watermark, channel name or personal logo, exactly as written; empty if none"}`;

export const IMAGE_QUESTIONS = {
  shows_subject: noul('Does the image described in `image` show the specific subject of `tweet` (named in `subject` when given): the same substance, food, drink, condition, body part or habit, or a chart, study or diagram about exactly that?', {
    true: 'The image is about the same specific thing the tweet is about.',
    false: 'The image shows a different subject, or a generic health or wellness picture that does not show the tweet\'s subject.',
  }),
  other_brand: noul('Does `image` carry another creator\'s handle, watermark, channel name or personal logo that makes it obviously someone else\'s post? Product packaging and study screenshots do not count.', {
    true: 'Another creator\'s branding is visible on it.',
    false: 'No creator branding, or only product packaging or a study.',
  }),
};

// The stamp on review notes and the calibration key: the pair questions, the subject template and the
// image questions together.
export const MEDIA_QUESTIONS_HASH = questionSetHash({ ...MEDIA_QUESTIONS, ...subjectQuestion(['{phrase}']), ...IMAGE_QUESTIONS });

/**
 * An MP4's duration in seconds from moov > mvhd, walking the boxes (never a byte search that could land in
 * mdat). `buf` starts at a box boundary: the file's head, or `moovAt` when the caller found moov in its
 * tail. null when the header is missing, cut off, or has no length (a fragmented file's mvhd says 0): an
 * unknown length is never read as short. Pure.
 */
export function mp4DurationS(buf, { moovAt = null } = {}) {
  if (!Buffer.isBuffer(buf)) return null;
  const boxes = (from, to) => {
    const out = [];
    for (let at = from; at + 8 <= to;) {
      let size = buf.readUInt32BE(at);
      const type = buf.toString('latin1', at + 4, at + 8);
      let head = 8;
      if (size === 1) { if (at + 16 > to) break; size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
      else if (size === 0) size = to - at;
      if (size < head) break;
      out.push({ type, at, head, end: at + size });
      at += size;
    }
    return out;
  };
  const moov = moovAt != null ? { at: moovAt, head: 8, end: moovAt + buf.readUInt32BE(moovAt) } : boxes(0, buf.length).find((x) => x.type === 'moov');
  if (!moov || moov.end > buf.length) return null;
  const mvhd = boxes(moov.at + moov.head, moov.end).find((x) => x.type === 'mvhd');
  if (!mvhd) return null;
  const p = mvhd.at + mvhd.head, v = buf[p];
  if (p + (v === 1 ? 32 : 20) > mvhd.end) return null;
  const timescale = v === 1 ? buf.readUInt32BE(p + 20) : buf.readUInt32BE(p + 12);
  const duration = v === 1 ? Number(buf.readBigUInt64BE(p + 24)) : buf.readUInt32BE(p + 16);
  return timescale > 0 && duration > 0 ? duration / timescale : null;
}

/**
 * A remote MP4's length without downloading it: the first 256 KB (moov usually leads a web video), else
 * the last 2 MB, where a tail moov is found at a box boundary it declares. null = unknown.
 */
export async function videoLengthS(url, { fetchImpl = fetch } = {}) {
  const head = await fetchImpl(url, { headers: { Range: 'bytes=0-262143' } });
  if (!head.ok) return null;
  const hb = Buffer.from(await head.arrayBuffer());
  const first = mp4DurationS(hb);
  if (first != null || head.status === 200) return first; // a 200 is the whole file: nothing more to read
  const total = Number(String(head.headers.get('content-range') || '').split('/')[1]);
  if (!Number.isFinite(total) || total <= hb.length) return null;
  const from = Math.max(0, total - 2 * 1024 * 1024);
  const tail = await fetchImpl(url, { headers: { Range: `bytes=${from}-${total - 1}` } });
  if (!tail.ok) return null;
  const tb = Buffer.from(await tail.arrayBuffer());
  for (let i = tb.indexOf('moov'); i >= 4; i = tb.indexOf('moov', i + 1)) {
    const size = tb.readUInt32BE(i - 4);
    if (size >= 8 && i - 4 + size === tb.length) return mp4DurationS(tb, { moovAt: i - 4 }); // moov ends the file
  }
  return null;
}

/** Parse the vision model's description. Pure. Unreadable = null (not verified, not attached). */
export function parseDescription(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : '');
    const shows = String(j.shows || '').trim();
    return shows ? { shows: shows.slice(0, 400), text: String(j.text || '').slice(0, 300), branding: String(j.branding || '').slice(0, 120) } : null;
  } catch { return null; }
}

/** Jev's image answers -> the verdict. Pure. A missing answer never passes. */
export function imageDecision(answers = {}, { rules = MEDIA_RULES, strict = false } = {}) {
  const shows = answers.shows_subject?.noul, brand = answers.other_brand?.noul;
  if (!Number.isFinite(shows) || !Number.isFinite(brand)) return { fits: false, otherBrand: false, shows: null, brand: null };
  return { fits: shows >= (strict ? rules.strict.minShows : rules.vision.minShows), otherBrand: brand >= rules.vision.maxBrand, shows, brand };
}

/**
 * The image check bound to env and Jev: fetches the candidate's image (first image, or the video's poster;
 * fresh URLs from Airtable), has the pinned vision model describe it (metered), then Jev decides fit and
 * branding from that description. No image, no description or no Jev answer = not verified = not attached.
 */
// THE DESCRIPTION IS THE IMAGE'S, so it is kept (owner, 2026-09-28: "Why is the media pass taking so long").
// A vision model's account of one swipe image (what it shows, its text, its branding) cannot change, while
// the same image is a candidate for many tweets, rows and runs. One file per image, keyed by the model, the
// swipe row and the Airtable attachment id (the URL expires, the id does not), so rows in flight never write
// the same file. Jev's read of the image against a tweet is never kept here: it depends on the tweet.
export function visionCacheKey(model, recId, attachment = {}) {
  return createHash('sha256').update(`${model}|${recId}|${attachment.id || attachment.url || ''}`).digest('hex').slice(0, 32);
}
function cachedDescription(dir, key) {
  try { const c = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')); return c?.d?.shows ? c.d : null; } catch { return null; }
}
function keepDescription(dir, key, d) {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), d }));
    renameSync(tmp, join(dir, `${key}.json`));
  } catch { /* a cache that cannot be written only costs the next call */ }
}

export function visionChecker(env, at, { client, rules = MEDIA_RULES, fetchImpl = fetch, meter = null, cacheDir = join(tmpdir(), 'swipe-media', 'vision') } = {}) {
  if (!client?.ask) throw new Error('visionChecker needs the Jev client: Jev makes the image decision');
  const no = (reason) => ({ fits: false, otherBrand: false, reason });
  return async (tweet, cand, { subject = null, strict = false, highBar = false } = {}) => {
    try {
      const row = await at.getRecord(TABLES.swipe, cand.id);
      // The first tweet of a CTA takes a video only of rules.strict.maxVideoS or less: measured from the file.
      if (strict && cand.kind === 'video') {
        const v = mediaOf(row.fields || {})?.items?.[0];
        const secs = v?.url ? await videoLengthS(v.url, { fetchImpl }).catch(() => null) : null;
        if (secs == null) return no('video length unreadable: a CTA\'s first tweet takes a video only when it is known to be short');
        if (secs > rules.strict.maxVideoS) return no(`video runs ${Math.round(secs)}s; a CTA's first tweet takes ${rules.strict.maxVideoS}s or less`);
      }
      const a = (row.fields?.Media || []).find((x) => String(x.type || '').startsWith('image'));
      const url = a?.thumbnails?.large?.url || a?.url;
      if (!url) return no('no image or poster to check');
      const key = visionCacheKey(rules.vision.model, cand.id, a);
      let d = cacheDir ? cachedDescription(cacheDir, key) : null;
      if (!d) {
        const img = await fetchImpl(url);
        if (!img.ok) return no(`image download ${img.status}`);
        const mime = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
        const data = Buffer.from(await img.arrayBuffer()).toString('base64');
        const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${String(env.OPENROUTER_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: rules.vision.model, max_tokens: 250, usage: { include: true }, messages: [
            { role: 'system', content: DESCRIBE_PROMPT },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }] },
          ] }),
        });
        const j = await r.json();
        if (!r.ok) return no(`vision ${r.status}`);
        meter?.({ model: rules.vision.model, role: 'swipe-media-describe', usage: j.usage || {}, exactCost: j.usage?.cost });
        d = parseDescription(j.choices?.[0]?.message?.content);
        if (!d) return no('unreadable image description');
        if (cacheDir) keepDescription(cacheDir, key, d);
      }
      const image = [d.shows, d.text && `Text: ${d.text}`, d.branding && `Branding: ${d.branding}`].filter(Boolean).join('\n');
      const { askThrough } = await import('./jev-decide.mjs');
      const ans = await askThrough('media-image-read', client, { state: { tweet, subject, image }, questions: IMAGE_QUESTIONS }, { role: 'swipe-media-image' });
      const v = imageDecision(ans.answers, { rules, strict: strict || highBar });
      return { ...v, reason: `${d.shows}${d.branding ? ` · branding: ${d.branding}` : ''} · Jev shows ${v.shows == null ? 'n/a' : v.shows.toFixed(2)}, brand ${v.brand == null ? 'n/a' : v.brand.toFixed(2)}` };
    } catch (e) { return no(`image check error: ${String(e.message).slice(0, 80)}`); }
  };
}
