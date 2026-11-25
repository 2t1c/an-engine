// thread-note.mjs — the note that travels WITH a /run thread, from its [REVIEW] draft to the draft
// that ships. One pure renderer for both, so the owner reads the same page at review and after
// adoption (plan R2, owner 2026-09-23: "source notes back on every draft").
//
// WHY THIS EXISTS. The 2026-08-25 record format (thread-record.mjs) dropped the verbatim donor text
// and the Source:/Product:/Link:/Subid1: anchors, and review then moved to [REVIEW] drafts, which
// carried no note at all. Every question the owner asks of a thread — where did it come from, what
// does it sell and why, which donor line argues for that product, which tweet is ours — had no answer
// in Typefully. This renders one, from a `thread-provenance-v1` object (scripts/run-provenance.mjs).
//
// PARSER CONTRACT (tests/thread-note.test.mjs runs the live regexes against real notes):
//   - The donor URL is labelled `Source:` and never `link:` — qc.mjs draftLink takes the FIRST
//     `Link:` (case-insensitive) as the thread's tracked link. A harvest's own post is `Origin:`.
//   - `Source: <url>` is the whole line: provenance-controls reads everything after the label.
//   - The first `Product:` / `Link:` / `Subid1:` lines belong to the HEAVY product, each on its own
//     line and at column 0: qc.mjs reads `^Product:`/`^Link:` per line, and swap-product rewrites the
//     first of each line by line.
//   - Everything quoted (donor text, hooks) is indented behind `  │ `, so no quote can start a line
//     that a line-anchored parser reads.
//
// OWNERSHIP. The rendered text sits between NOTE_BEGIN and NOTE_END. refreshNote replaces only that
// block; whatever the owner writes above or below it survives every sync.
//
// NOTHING HERE IS ZERO BY DEFAULT. A fact the assembler could not read arrives as
// { status: 'not read', reason } and prints as "not read — <reason>". The renderer never reads a
// clock, a file or the network: the same inputs give the same bytes.
import { createHash } from 'node:crypto';

export const PROVENANCE_SCHEMA = 'thread-provenance-v1';
export const NOTE_BUDGET = 12000;
export const NOTE_BEGIN = '⟦pi-note v1 · machine-owned: replaced on every sync — write your own notes above or below these markers⟧';
export const NOTE_END = '⟦/pi-note⟧';
export const EDITED_BANNER = 'COPY EDITED IN TYPEFULLY — review and gates must re-run';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const str = (value) => (value == null ? '' : String(value));
const oneLine = (value, max = 200) => {
  const s = str(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The explicit "we could not read this" value. Never a zero, never an empty list. */
export const notRead = (reason) => ({ status: 'not read', reason: str(reason) || 'no reason recorded' });
export const isNotRead = (value) => !!value && typeof value === 'object' && value.status === 'not read';
const showNotRead = (value) => `not read — ${value.reason}`;

/** The copy digest every /run tool binds to: SHA-256 of JSON.stringify(tweets). Same as
 *  run-content-packets draftCopyDigest and run-review-drafts tweetsSha256. */
export const copyDigest = (tweets = []) => sha256(JSON.stringify((tweets || []).map(String)));

/** @handle from an x.com / twitter.com status URL — 220 of 254 records carry author null. */
export function handleFromUrl(url) {
  const m = str(url).match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/\d+/i);
  return m ? m[1] : null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ICT_OFFSET_MS = 7 * 3600e3; // Saigon, no daylight saving
const pad2 = (n) => String(n).padStart(2, '0');
/** "Thu 25 Sep 15:10 ICT · 08:10 UTC" — ICT first, because the owner plans in Saigon time. */
export function icUtc(iso) {
  const t = Date.parse(str(iso));
  if (!Number.isFinite(t)) return null;
  const ict = new Date(t + ICT_OFFSET_MS), utc = new Date(t);
  return `${DAYS[ict.getUTCDay()]} ${ict.getUTCDate()} ${MONTHS[ict.getUTCMonth()]} ${pad2(ict.getUTCHours())}:${pad2(ict.getUTCMinutes())} ICT · ${pad2(utc.getUTCHours())}:${pad2(utc.getUTCMinutes())} UTC`;
}
const shortTime = (iso) => { const t = Date.parse(str(iso)); return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : str(iso) || '(no time)'; };

const placeholderFor = (i) => (i === 0 ? ['{{LINK}}', '{{LINK1}}'] : [`{{LINK${i + 1}}}`]);
const firstLine = (text) => str(text).split('\n').map((l) => l.trim()).find(Boolean) || '';

/**
 * Where each product sits in the copy: the tweet carrying its link (or its {{LINK}} token before
 * minting), and the bridge above it. 1-based tweet numbers; null when the copy does not carry it.
 * An explicit plugTweet/bridgeTweet on the product wins over the search.
 */
export function plugMap(tweets = [], products = []) {
  const copy = (tweets || []).map(str);
  return (products || []).map((p, i) => {
    let plug = Number.isSafeInteger(p?.plugTweet) ? p.plugTweet : null;
    if (plug == null) {
      const marks = [...(p?.link ? [str(p.link)] : []), ...placeholderFor(i)];
      const at = copy.findIndex((t) => marks.some((m) => m && t.includes(m)));
      plug = at >= 0 ? at + 1 : null;
    }
    const bridge = Number.isSafeInteger(p?.bridgeTweet) ? p.bridgeTweet : plug && plug > 1 ? plug - 1 : null;
    return { asin: p?.asin || null, placement: p?.placement || (i === 0 ? 'heavy' : i === 1 ? 'light' : `extra-${i + 1}`),
      plugTweet: plug, bridgeTweet: bridge, bridgeLine: bridge ? oneLine(firstLine(copy[bridge - 1]), 180) || null : null };
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (term) => new RegExp(`(^|[^a-z0-9])${escapeRe(term.toLowerCase())}(?=$|[^a-z0-9])`, 'i');
// The substance a reader would recognise: Jev's label, else the shortest substance term, else the
// first words of the Amazon title (a brand name like "Heart of Steel" names no substance).
const productLabel = (p) => str(p?.label)
  || [...(Array.isArray(p?.terms) ? p.terms : [])].map(str).filter(Boolean).sort((a, b) => a.length - b.length)[0]
  || str(p?.title).split(/[,(|]/)[0].trim().split(/\s+/).slice(0, 3).join(' ') || str(p?.asin);
const productTerms = (p) => {
  const given = (Array.isArray(p?.terms) ? p.terms : []).map((t) => str(t).trim().toLowerCase()).filter((t) => t.length >= 3);
  if (given.length) return [...new Set(given)];
  return str(p?.label).split(/\s+or\s+/i).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
};

/**
 * The donor line that argues for a product. Jev's product-fit pointer (a donor tweet number) wins;
 * code then QUOTES the line of that tweet naming the product, so the quote is always the donor's own
 * words. Without a pointer, code searches the donor for the product's terms. Neither finding it is a
 * finding too: "donor never names X — the bridge is ours".
 */
export function donorLinesFor(product, donorTweets, jevCandidate = null) {
  if (isNotRead(donorTweets)) return donorTweets;
  if (!Array.isArray(donorTweets) || !donorTweets.length) return notRead('donor thread not in the run directory');
  const terms = productTerms(product);
  const quoteIn = (tweet) => {
    const lines = str(tweet).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => terms.some((t) => termRe(t).test(l))) || lines[0] || '';
  };
  const pointer = Number(jevCandidate?.pointer ?? jevCandidate?.tweet);
  if (Number.isSafeInteger(pointer) && pointer >= 1 && pointer <= donorTweets.length) {
    return { from: 'jev', tweet: pointer, line: oneLine(quoteIn(donorTweets[pointer - 1]), 220) };
  }
  if (terms.length) {
    for (let i = 0; i < donorTweets.length; i++) {
      const hit = str(donorTweets[i]).split('\n').map((l) => l.trim()).find((l) => terms.some((t) => termRe(t).test(l)));
      if (hit) return { from: 'text', tweet: i + 1, line: oneLine(hit, 220) };
    }
  }
  return { from: 'none', text: `donor never names ${productLabel(product)} — the bridge is ours` };
}

// A number worth sourcing: a unit, a percentage, a decimal, or two or more digits. List markers
// ("3." at a line start), tweet counters ("3/"), URLs and subids are not claims.
const UNIT = '%|x\\b|×|mg\\b|mcg\\b|µg\\b|g\\b|iu\\b|bpm\\b|kcal\\b|calories\\b|k\\b|million\\b|billion\\b|hours?\\b|hrs?\\b|minutes?\\b|mins?\\b|seconds?\\b|days?\\b|weeks?\\b|months?\\b|years?\\b|times\\b|people\\b|studies\\b|participants\\b';
const NUMBER = new RegExp(`(?<![\\w.,/-])(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:${UNIT}))?`, 'gi');
const normNum = (s) => str(s).replace(/,/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * CLAIMS (report-only): every number in the copy with its source, or UNSOURCED. A number is sourced
 * by a supplied claim (`claims: [{ tweet?, text, source }]`) or by appearing verbatim in the donor.
 */
export function statLines(tweets = [], { donorTweets = null, claims = [] } = {}) {
  const donor = Array.isArray(donorTweets) ? donorTweets.map((t) => normNum(t)) : null;
  const out = [];
  (tweets || []).forEach((tweet, ti) => {
    const text = str(tweet).replace(/https?:\/\/\S+/g, ' ').split('\n')
      .map((l) => l.replace(/^\s*\d+[.)]\s/, ' ').replace(/^\s*\d+\/\d*\s/, ' ')).join('\n');
    const seen = new Set();
    for (const m of text.matchAll(NUMBER)) {
      const [whole, digits, unit] = m;
      const value = Number(digits.replace(/,/g, ''));
      if (!unit && !(digits.includes('.') || value >= 10)) continue;
      const token = whole.trim();
      if (seen.has(normNum(token))) continue;
      seen.add(normNum(token));
      const supplied = (claims || []).find((c) => (!c.tweet || Number(c.tweet) === ti + 1) && normNum(c.text).includes(normNum(token)));
      let where;
      // Labelled "cited:", never "source:": qc.mjs and media.mjs read the first "source:" in a note as
      // the reference thread, and a harvest or pot note has no Source: line above this one.
      if (supplied?.source) where = `cited: ${oneLine(supplied.source, 120)}`;
      else if (donor) {
        const at = donor.findIndex((d) => d.includes(normNum(token)));
        where = at >= 0 ? `donor [${at + 1}]` : 'UNSOURCED';
      } else where = 'UNSOURCED (donor not read)';
      out.push(`  T${ti + 1} "${token}" — ${where}`);
    }
  });
  return out;
}

const rule = (label) => `── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`;
const quote = (text, lead = '  │ ') => str(text).split('\n').map((l) => `${lead}${l}`);
const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : `$${Number(v).toFixed(3)}`);

function sourceSection(p) {
  const s = p?.source;
  const L = [];
  if (!s || isNotRead(s)) { L.push(rule('SOURCE'), `  ${s ? showNotRead(s) : 'not read — no source in the provenance'}`); return L; }
  const kind = s.kind || 'donor';
  L.push(rule(`SOURCE — ${kind}`));
  if (kind === 'seed pot') {
    const seed = s.seed || {};
    L.push(`Seed: ${seed.family || '(family not recorded)'}${seed.version != null ? ` v${seed.version}` : ''}${seed.recId ? ` · ${seed.recId}` : ''}${seed.card ? ` · ${seed.card}` : ''}`);
    L.push(`Pot: ${s.potRecId || 'not read — no pot record id on the row'}${s.potCard ? ` · ${s.potCard}` : ''}`);
    L.push(`Greenhouse: ${s.greenhouseDraft ? `draft ${s.greenhouseDraft}` : 'not read — no greenhouse draft id on the row'}`);
    L.push(`Origin: ${s.origin ? (isNotRead(s.origin) ? showNotRead(s.origin) : s.origin) : 'not read — the seed row holds it'}`);
  } else if (kind === 'our own post') {
    const origin = s.url || (s.parentDraftId ? `draft ${s.parentDraftId}` : null);
    L.push(`Origin: ${origin || 'not read — no parent post recorded'}`);
    if (s.variationOf) L.push(`  variation of draft ${s.variationOf} — rewritten body, no heart spent`);
    if (s.harvestOf) L.push(`  harvest of draft ${s.harvestOf} — verbatim attempt`);
    if (s.harvestRecId) L.push(`  Harvests row ${s.harvestRecId}${s.card ? ` · ${s.card}` : ''}`);
  } else {
    if (s.url) L.push(`Source: ${s.url}`);
    else L.push(`  Source URL not read — ${s.urlReason || 'no donor URL on the row'}`);
  }
  const handle = s.handle || handleFromUrl(s.url);
  const by = [handle && `@${String(handle).replace(/^@/, '')}`, s.views != null && Number.isFinite(Number(s.views)) && `${Number(s.views).toLocaleString('en-US')} views`,
    s.publishedDate && `published ${s.publishedDate}`].filter(Boolean).join(' · ');
  if (by) L.push(`  ${by}`);
  if (kind !== 'our own post' && kind !== 'seed pot') {
    if (s.card) L.push(`  card: ${s.card}`);
    if (s.recId) L.push(`  recId: ${s.recId}`);
  }
  // The donor's hook is quoted under HOOK, below SELLS: donor text above the heavy product's lines
  // could hand a non-anchored parser (qc.mjs draftLink) a "link: https://…" from someone else's post.
  return L;
}

function sellsSection(p, tweets, donorTweets) {
  const L = [rule('SELLS')];
  const products = p?.products;
  if (!products || isNotRead(products)) { L.push(`  ${products ? showNotRead(products) : 'not read — no products in the provenance'}`); return L; }
  if (!products.length) { L.push('  (no tracked plug)'); return L; }
  const map = plugMap(tweets, products);
  const jevOk = p?.jev && p.jev.status === 'ok' ? p.jev : null;
  // No product gets a `Link:` line unless the heavy one has one: qc.mjs would otherwise take the
  // light product's link as the thread's link.
  const heavyMinted = /^https?:\/\//.test(str(products[0]?.link));
  products.forEach((prod, i) => {
    const at = map[i];
    const epc = prod.epc && !isNotRead(prod.epc)
      ? `EPC ${prod.epc.status || 'unknown'}${money(prod.epc.value) ? ` ${money(prod.epc.value)}` : ''}${prod.epc.clicks != null ? ` (${prod.epc.clicks} clicks)` : ''}`
      : `EPC ${prod.epc ? showNotRead(prod.epc) : 'not read'}`;
    L.push(`${i + 1}. ${String(at.placement).toUpperCase()} · plug ${at.plugTweet ? `T${at.plugTweet}` : 'not in copy'} · bridge ${at.bridgeTweet ? `T${at.bridgeTweet}` : 'none'} · pod ${prod.pod || 'none'} · ${epc}`);
    L.push(`Product: ${oneLine(prod.title, 160) || '(title not read)'} (${prod.asin || 'NO-ASIN'})`);
    if (heavyMinted && /^https?:\/\//.test(str(prod.link))) L.push(`Link: ${prod.link}`);
    else L.push('  tracking: not minted yet');
    if (heavyMinted && prod.subid1) L.push(`Subid1: ${prod.subid1}`);
    L.push(`  WHY ${prod.why ? oneLine(prod.why, 240) : 'not read — no CTA need recorded'}`);
    const candidate = jevOk?.candidates?.find((c) => c.asin === prod.asin) || null;
    const donor = donorLinesFor({ ...prod, label: prod.label || candidate?.label || null }, donorTweets, candidate);
    if (isNotRead(donor)) L.push(`  DONOR ${showNotRead(donor)}`);
    else if (donor.from === 'none') L.push(`  DONOR — ${donor.text}`);
    else L.push(`  DONOR [${donor.tweet}] "${donor.line}"${donor.from === 'jev' ? ' (Jev pointer)' : ' (text match)'}`);
    L.push(`  OURS ${at.bridgeTweet ? `T${at.bridgeTweet} "${at.bridgeLine || ''}"` : 'no bridge tweet found in the copy'}`);
    if (!p?.jev || isNotRead(p.jev)) L.push(`  JEV fit ${p?.jev ? showNotRead(p.jev) : 'not read'}`);
    else if (!jevOk) L.push(`  JEV fit not read — ${p.jev.reason || p.jev.code || p.jev.status}`);
    else {
      const c = jevOk.candidates?.find((x) => x.asin === prod.asin);
      L.push(`  JEV fit ${c?.noul != null ? Number(c.noul).toFixed(2) : 'not scored'}${c?.label ? ` (${c.label})` : ''}`);
    }
  });
  return L;
}

function slotSection(p) {
  const s = p?.slot;
  if (!s) return [rule('SLOT'), '  not planned yet'];
  if (isNotRead(s)) return [rule('SLOT'), `  ${showNotRead(s)}`];
  const when = icUtc(s.at);
  return [rule('SLOT'), `  ${[s.id, when || (s.at ? `time unreadable (${s.at})` : 'no time'), [].concat(s.platforms || []).join('+') || null].filter(Boolean).join(' · ')}`];
}

function hookSection(p, tweets) {
  const h = p?.hook;
  const L = [rule('HOOK')];
  const source = p?.source && !isNotRead(p.source) ? p.source : null;
  if (source?.hook) L.push('  source hook:', ...quote(source.hook));
  else L.push(`  source hook ${source?.kind === 'seed pot' ? 'none — a pot fills its seed\'s skeleton' : 'not read — none on the row'}`);
  L.push('  ours (T1):', ...quote(tweets?.[0] ?? '(no copy)'));
  if (!h || isNotRead(h)) { L.push(`  check ${h ? showNotRead(h) : 'not read'}`); return L; }
  if (h.check && !isNotRead(h.check)) {
    const c = h.check;
    L.push(`  check: ${c.sim != null ? `${Math.round(Number(c.sim) * 100)}% of the donor` : 'unmeasured'}${c.band ? ` · ${c.band}` : ''}${c.ok === false ? ` · HELD: ${oneLine(c.issue, 160)}` : c.ok ? ' · passes' : ''}`);
  } else L.push(`  check ${h.check ? showNotRead(h.check) : 'not read'}`);
  if (h.structure) L.push(`  structure: ${oneLine(h.structure, 300)}`);
  return L;
}

function mediaSection(p) {
  const m = p?.media;
  const L = [rule('MEDIA')];
  if (!m || isNotRead(m)) L.push(`  ${m ? showNotRead(m) : 'not read'}`);
  else if (Array.isArray(m.items) && m.items.length) for (const x of m.items) L.push(`  T${x.tweet}: ${oneLine(x.source, 160)}`);
  else L.push(`  none — ${m.noMediaReason ? oneLine(m.noMediaReason, 200) : 'no reason recorded'}`);
  return L;
}

function reviewSection(p, tweets) {
  const r = p?.review;
  const L = [rule('REVIEW')];
  if (!r || isNotRead(r)) { L.push(`  ${r ? showNotRead(r) : 'not read'}`); return L; }
  if (isNotRead(r.stopsNotRead)) L.push(`  stops      ${showNotRead(r.stopsNotRead)}`);
  else if (!(r.stops || []).length) L.push('  stops      not read — no run-studio verdicts in the provenance');
  for (const s of r.stops || []) {
    L.push(`  ${String(s.stage).padEnd(10)} ${s.status}${s.recordedAt ? ` ${shortTime(s.recordedAt)}` : ''}${s.revision ? ` · rev ${String(s.revision).slice(0, 12)}` : ''}${s.reason ? ` — ${oneLine(s.reason, 140)}` : ''}`);
  }
  const pk = r.packet;
  if (pk && isNotRead(pk)) L.push(`  packet     ${showNotRead(pk)}`);
  else if (pk) {
    L.push(`  packet     ${pk.status}${pk.contentSha256 ? ` · copy ${pk.contentSha256 === copyDigest(tweets) ? 'matches this copy' : 'DIFFERS from this copy'}` : ''}`);
    for (const h of pk.holds || []) L.push(`    HOLD ${oneLine(h, 200)}`);
    for (const x of pk.reviews || []) L.push(`    OWNER REVIEW ${oneLine(x, 200)}`);
  }
  const ed = r.editorial;
  if (ed && isNotRead(ed)) L.push(`  editorial  ${showNotRead(ed)}`);
  else if (ed) L.push(`  editorial  ${ed.verdict || '?'} by ${ed.reviewer || '?'} · ${ed.contentSha256 === copyDigest(tweets) ? 'bound to this copy' : 'bound to ANOTHER copy — re-review'}${ed.notes ? ` · ${oneLine(ed.notes, 200)}` : ''}`);
  return L;
}

function jevSection(p) {
  const j = p?.jev;
  const L = [rule('JEV')];
  if (!j || isNotRead(j)) { L.push(`  product fit ${j ? showNotRead(j) : 'not read'}`); return L; }
  if (j.status !== 'ok') { L.push(`  product fit not read — ${j.reason || j.code || j.status}`); return L; }
  L.push(`  product fit (report-only) · ${j.model || 'model not recorded'} · any product recommended ${j.anySupplement != null ? Number(j.anySupplement).toFixed(2) : 'n/a'}`);
  for (const c of (j.candidates || []).slice(0, 6)) L.push(`  ${c.noul != null ? Number(c.noul).toFixed(2) : 'n/a '} ${c.label || c.asin} (${c.asin})`);
  L.push(`  reading: ${j.agrees ? 'agrees with the placements' : (j.notes || []).map((n) => oneLine(n, 160)).join('; ') || 'no reading recorded'}`);
  return L;
}

function threadSection(p, tweets, opts) {
  const L = [rule('THIS THREAD')];
  const who = [opts.runId || p?.runId, opts.rowId || p?.rowId, p?.account, p?.lane, p?.date].filter(Boolean).join(' · ');
  if (who) L.push(`  ${who}`);
  if (opts.title) L.push(`  ${opts.title}`);
  if (opts.draftId) L.push(`  draft ${opts.draftId}${opts.shareUrl ? ` · ${opts.shareUrl}` : ''}`);
  L.push(`  copy sha256 ${copyDigest(tweets).slice(0, 16)} · ${tweets.length} tweet(s)`);
  return L;
}

function historySection(history) {
  const L = [rule('HISTORY — newest last')];
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) L.push('  (nothing recorded yet)');
  for (const h of rows) L.push(`  ${shortTime(h.at)}  ${oneLine(h.what, 200)}`);
  return L;
}

function donorSection(donorTweets) {
  const L = [rule('DONOR THREAD')];
  if (isNotRead(donorTweets)) { L.push(`  ${showNotRead(donorTweets)}`); return { head: L, tweets: [] }; }
  if (!Array.isArray(donorTweets) || !donorTweets.length) { L.push('  not read — donor thread not in the run directory'); return { head: L, tweets: [] }; }
  return { head: L, tweets: donorTweets.map((t, i) => quote(t).map((line, j) => (j === 0 ? `  [${i + 1}]${line.slice(1)}` : `     ${line.slice(2)}`))) };
}

function headerLines(state, opts) {
  if (state === 'shipped') {
    return [`STATUS: SHIPPED ${opts.shippedAt ? icUtc(opts.shippedAt) || opts.shippedAt : '(time not recorded)'}`,
      `  publishes ${opts.publishAt ? icUtc(opts.publishAt) || opts.publishAt : 'unscheduled — not booked yet'}`];
  }
  if (state === 'edited') return [`STATUS: ${EDITED_BANNER}`, '  the copy below the note is the owner\'s live copy; this note was re-rendered on it'];
  return ['STATUS: REVIEW — unscheduled draft, not approved to post'];
}

/**
 * The machine-owned note, markers included. `provenance` may be null: the note then says so and
 * carries only what the copy itself shows (plan §6 item 15: "a row without provenance gets a minimal
 * note marked as such"). Deterministic and never longer than NOTE_BUDGET: the donor thread is cut
 * first, then the claims, then the whole block.
 */
export function renderNote(provenance, { tweets = [], state = 'review', shippedAt = null, publishAt = null, title = null,
  draftId = null, shareUrl = null, runId = null, rowId = null, history = null, budget = NOTE_BUDGET } = {}) {
  const p = provenance && typeof provenance === 'object' ? provenance : null;
  const copy = (tweets || []).map(str);
  const opts = { title, draftId, shareUrl, runId, rowId };
  const donorTweets = p ? (p.donor?.tweets ?? p.donor ?? notRead('no donor in the provenance')) : notRead('no provenance');
  const top = [...headerLines(state, { shippedAt, publishAt })];
  if (!p) {
    top.push('  NO PROVENANCE RECORDED — minimal note. Run scripts/run-provenance.mjs and re-sync to fill it.');
    const body = [...top, '', ...threadSection(null, copy, opts), '', ...historySection(history)];
    return fit(body, [], [], budget);
  }
  if (p.schema && p.schema !== PROVENANCE_SCHEMA) top.push(`  provenance schema ${p.schema} is not ${PROVENANCE_SCHEMA}; read with care`);
  const main = [...top, '', ...sourceSection(p), '', ...sellsSection(p, copy, donorTweets), '', ...slotSection(p), '', ...hookSection(p, copy)];
  const claims = statLines(copy, { donorTweets: Array.isArray(donorTweets) ? donorTweets : null, claims: p.claims || [] });
  const claimHead = [rule('CLAIMS — report-only'), ...(claims.length ? [] : ['  no numbers in the copy'])];
  const rest = [...mediaSection(p), '', ...reviewSection(p, copy), '', ...jevSection(p), '', ...threadSection(p, copy, opts), '', ...historySection(history ?? p.history)];
  const donor = donorSection(donorTweets);
  return fit([...main, ''], [claimHead, claims], [rest, donor], budget);
}

// Assemble within the budget. Order of sacrifice: donor tweets from the end, then claim lines, then
// a hard cut. Each cut says what it removed, so a short note never passes for a complete one.
function fit(main, [claimHead, claims] = [], [rest, donor] = [], budget = NOTE_BUDGET) {
  const wrap = (lines) => [NOTE_BEGIN, ...lines, NOTE_END].join('\n');
  const build = (claimCount, donorCount) => {
    const lines = [...main];
    if (claimHead) {
      lines.push(...claimHead, ...claims.slice(0, claimCount));
      if (claimCount < claims.length) lines.push(`  … ${claims.length - claimCount} more number(s) cut to fit the ${budget.toLocaleString('en-US')}-character note`);
      lines.push('');
    }
    if (rest) lines.push(...rest);
    if (donor) {
      lines.push('', ...donor.head);
      for (const t of donor.tweets.slice(0, donorCount)) lines.push(...t);
      if (donorCount < donor.tweets.length) lines.push(`  … donor thread cut at ${donorCount} of ${donor.tweets.length} tweets to fit the ${budget.toLocaleString('en-US')}-character note`);
    }
    return wrap(lines);
  };
  const nClaims = claims?.length || 0, nDonor = donor?.tweets.length || 0;
  let out = build(nClaims, nDonor);
  for (let d = nDonor - 1; out.length > budget && d >= 0; d--) out = build(nClaims, d);
  for (let c = nClaims - 1; out.length > budget && c >= 0; c--) out = build(c, 0);
  if (out.length > budget) {
    const cut = `\n  … note cut at the ${budget.toLocaleString('en-US')}-character budget\n${NOTE_END}`;
    out = out.slice(0, budget - cut.length) + cut;
  }
  return out;
}

/**
 * Put a freshly rendered block into an existing note. Only the text between the markers is ours;
 * the owner's text above and below it is kept byte for byte. A note with no markers is the owner's
 * (or a legacy record) and stays whole, below the block, so the parsers read our anchors first.
 */
export function refreshNote(existing, block) {
  const text = str(existing);
  const b = text.indexOf(NOTE_BEGIN);
  const e = b >= 0 ? text.indexOf(NOTE_END, b + NOTE_BEGIN.length) : -1;
  if (b >= 0 && e > b) return text.slice(0, b) + block + text.slice(e + NOTE_END.length);
  if (!text.trim()) return block;
  return `${block}\n\n${text}`;
}

/** Just the machine block of a note, or null. */
export function machineBlock(note) {
  const text = str(note);
  const b = text.indexOf(NOTE_BEGIN);
  const e = b >= 0 ? text.indexOf(NOTE_END, b + NOTE_BEGIN.length) : -1;
  return b >= 0 && e > b ? text.slice(b, e + NOTE_END.length) : null;
}

/**
 * The provenance as it may be written into the REPO (a spec under queues/batch, a record under
 * queues/threads): the donor's text is replaced by its tweet count and per-tweet sha256
 * (scripts/cover-source-breadth.mjs:1-3). A by-reference provenance ({ file, rowId }) holds no text
 * and passes through untouched.
 */
export function redactProvenance(p) {
  if (!p || typeof p !== 'object' || p.file) return p;
  const tweets = Array.isArray(p.donor?.tweets) ? p.donor.tweets : null;
  if (!tweets) return p;
  return { ...p, donor: { status: 'not read', reason: 'donor text stays in the run directory', tweetCount: tweets.length,
    sha256: tweets.map((t) => sha256(str(t))) } };
}

/** Notes compare equal when Typefully only normalised line endings or trailing space. */
export const sameNote = (a, b) => str(a).replace(/\r\n/g, '\n').trimEnd() === str(b).replace(/\r\n/g, '\n').trimEnd();

/**
 * Readback of a note that landed: the header for the expected state, a Source:/Origin: line (when
 * the provenance has one to show) and every ASIN the thread sells. Report-only by design: a missing
 * note is a warning on the receipt (plan §6 item 15), never a reason to unship a thread.
 */
export function noteCheck(note, { state = null, asins = [], needsSource = true } = {}) {
  const block = machineBlock(note);
  if (!block) return { ok: false, missing: ['the machine-owned note block'] };
  const missing = [];
  const want = state === 'shipped' ? /^STATUS: SHIPPED /m : state === 'edited' ? new RegExp(`^STATUS: ${escapeRe(EDITED_BANNER)}`, 'm') : state === 'review' ? /^STATUS: REVIEW /m : null;
  if (want && !want.test(block)) missing.push(`the ${state} header`);
  if (needsSource && !/^(?:Source: https?:\/\/\S+|Origin: \S.*)$/m.test(block)) missing.push('a Source: or Origin: line');
  for (const asin of asins.filter(Boolean)) if (!block.includes(`(${asin})`)) missing.push(`ASIN ${asin}`);
  return { ok: missing.length === 0, missing };
}
