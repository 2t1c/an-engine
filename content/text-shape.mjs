// Pure text formatting. Inputs carry policy limits; this module performs no I/O.
// ---- account boilerplate identity (closing + disclaimer, current AND legacy) ---------------------
// The nine accounts' closers/disclaimers were rewritten 2026-08-23 so the fleet stops sharing one
// searchable string (network-fingerprint risk). Sitting and scheduled drafts still END on the
// previous text, so every "is this the account's own boilerplate?" question must accept current and
// legacy alike — otherwise the nightly QC reads an old draft as missing its sign-off and stacks the
// new closer on top of the old one.
export const closingTexts = (a) => [a?.closing, ...[].concat(a?.closingLegacy || [])].filter(Boolean);
export const disclaimerTexts = (a) => [a?.disclaimer, ...[].concat(a?.disclaimerLegacy || [])].filter(Boolean);
export const isBoilerplate = (a, t) => closingTexts(a).includes(t) || disclaimerTexts(a).includes(t);
// First 5-word run two texts share, or null — the anti-fingerprint yardstick: an exact-match search
// must never chain two accounts. The boilerplate suite and the onboarding scaffolder both measure
// with this, so "unique enough to ship" means one thing.
export function sharedWordRun(a, b, n = 5) {
  const grams = (s) => { const w = String(s).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean); const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };
  const A = grams(a);
  for (const g of grams(b)) if (A.has(g)) return g;
  return null;
}

export const effLen = (t) => t.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length;
export const hasUrl = (t) => /https?:\/\/\S+/.test(t);
export const plugTextLen = (t) => t.replace(/https?:\/\/\S+/g, '').replace(/\n{2,}/g, '\n').trim().length;
// LENGTH OF A TWEET THAT MAY STILL CARRY A PLACEHOLDER. effLen counts a real URL as its 23 t.co
// characters; a pre-mint draft carries {{LINK}}, which is 8, so gating before minting undercounts a
// plug by 15 characters and the overflow only appears once the link is real.
export const effLenMinted = (t) => effLen(String(t).replace(/\{\{[^}]+\}\}/g, 'x'.repeat(23)));

// ---- precise in-tweet line handling ----------------------------------------------------------
// A tweet's boundary is the LLM's JSON array element — nothing re-splits a tweet on newlines except
// splitLongTweet below (and only when it truly overflows 280). WITHIN a tweet, the house style is one
// blank line between lines; the failure mode is a single sentence WRAPPED across two lines then
// double-spaced ("Build the right routine,\n\nand skin settles down."). These helpers make the
// spacing precise: real breaks get one blank line, a wrapped continuation is rejoined with a space.
const endsSentence = (l) => /[.!?:”"’)\]]$/.test(l.trim());     // terminal punctuation => a real line break
const isListItem = (l) => /^(?:[-•*]|\d+[.)])\s/.test(l.trim()); // "- ", "• ", "1. ", "2) " => its own line

// Older harvest repairs stored the number on its own paragraph. Join only that
// whitespace to the next title; never treat decimals or another list marker as a title.
export function joinNumberedHeadings(text) {
  return String(text).replace(
    /(^|\n)([ \t]*\d+[.)])[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*(?=\S)/g,
    (match, start, marker, offset, full) => {
      const next = full.slice(offset + match.length).split(/\r?\n/, 1)[0];
      if (/^(?:\d+[.)]|[-•*])(?:[ \t]|$)/.test(next)) return match;
      return `${start}${marker} `;
    },
  );
}

// Re-space a tweet's lines: split on any newline run, then between each adjacent non-empty pair insert
// `sep` (a real break) UNLESS the pair is a wrapped sentence continuation (previous line has no
// terminal punctuation and the next starts lowercase and is not itself a list item), which is rejoined
// with a single space. A list/marker line may absorb its own wrapped continuation ("3. Eat for your
// skin,\nnot just your appetite." rejoins, the marker stays leading), but a list item is never
// absorbed INTO the line above it. Never invents or drops words.
// Consecutive list items PACK with a single newline (operator rule: no blank line between bullets) —
// tracked via lastIsList so a bullet whose text wrapped onto a second line still counts as a bullet.
export function normalizeLineBreaks(text, sep = '\n\n') {
  const lines = String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return String(text).trim();
  let out = lines[0];
  let lastIsList = isListItem(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1], cur = lines[i];
    const continuation = !isListItem(cur) && !endsSentence(prev) && /^[a-z0-9]/.test(cur);
    if (continuation) { out += ` ${cur}`; continue; } // extends the current line — its list-ness is unchanged
    const curIsList = isListItem(cur);
    out += curIsList && lastIsList ? `\n${cur}` : `${sep}${cur}`;
    lastIsList = curIsList;
  }
  return out;
}

// WALL-OF-TEXT respace (operator 2026-08-08, deal-breaker): normalizeLineBreaks only normalizes
// EXISTING breaks, so a tweet the LLM emits as ONE unbroken line ships as a wall of text — the
// under-280 case no gate touched (splitLongTweet's sentence re-spacer only fires on overflow).
// Deterministic, word-preserving repair: split into sentences (same ender class splitLongTweet
// uses), greedily pack them into paragraphs of >= minPara chars (keeps "Pause. Choose." fragment
// runs together), join with blank lines. A leading list marker ("3. ") stays glued to its first
// sentence, and a colon introducing a numbered item breaks before the item. Texts that already
// contain a newline are returned untouched — normalizeLineBreaks owns structured spacing.
export function respaceWall(text, { minPara = 20 } = {}) {
  const t = String(text).trim();
  if (t.includes('\n')) return t;
  const m = t.match(/^(\d+[.)])\s+([\s\S]*)$/);
  const marker = m ? `${m[1]} ` : '';
  const body = m ? m[2] : t;
  const parts0 = body
    .split(/(?<=[.!?…]["')\]]*)\s+(?=[A-Z0-9“"'(])/g)
    .flatMap((p) => p.split(/(?<=:)\s+(?=\d+[.)](\s|$))/g));
  // Re-glue a bare enumerator ("1.") the sentence split orphaned from its item text —
  // "down: 1. No food" must never break between the marker and the item.
  const parts = [];
  for (const p of parts0) {
    if (parts.length && /^\d{1,2}[.)]$/.test(parts[parts.length - 1])) parts[parts.length - 1] += ` ${p}`;
    else parts.push(p);
  }
  if (parts.length < 2) return t;
  const paras = [];
  let cur = '';
  if (marker) paras.push(parts[0]); // the item's title sentence stands alone under its marker
  for (const s of marker ? parts.slice(1) : parts) {
    cur = cur ? `${cur} ${s}` : s;
    if (cur.length >= minPara) { paras.push(cur); cur = ''; }
  }
  if (cur) { if (paras.length) paras[paras.length - 1] += ` ${cur}`; else paras.push(cur); }
  paras[0] = marker + paras[0];
  return paras.join('\n\n');
}

// Greedy word wrap of one string into <= limit-char chunks at whitespace (link counts as 23 via effLen).
function wordWrap(text, limit) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = []; let line = '';
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (effLen(cand) <= limit || !line) line = cand;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

// Split one flat run of prose into TWO balanced pieces at the sentence boundary nearest the midpoint
// (falling back to the nearest word boundary), both <= limit and both >= minTail. Returns null when no
// boundary satisfies that. Greedy wrap can't do this — it packs the front and leaves a tiny tail.
function balancedSplit(text, limit, minTail) {
  const flat = String(text).replace(/\s*\n+\s*/g, ' ').trim();
  const cands = [];
  const sentRe = /[.!?…]["')\]]*\s+/g; let m;
  while ((m = sentRe.exec(flat))) cands.push(m.index + m[0].length);
  const wordCands = () => { const cs = []; const re = /\s+/g; let w; while ((w = re.exec(flat))) cs.push(w.index + w[0].length); return cs; };
  for (const pool of [cands, wordCands()]) {
    const valid = pool.filter((i) => {
      const h = flat.slice(0, i).trim(), t = flat.slice(i).trim();
      return h && t && effLen(h) <= limit && effLen(t) <= limit && effLen(h) >= minTail && effLen(t) >= minTail;
    });
    if (valid.length) {
      const mid = flat.length / 2;
      const best = valid.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
      // restore the house scannability style (blank line between sentences) when it still fits —
      // but a leading item marker ("1.") is not a sentence: it stays glued to its first line.
      return [flat.slice(0, best).trim(), flat.slice(best).trim()].map((p) => {
        const spaced = p.replace(/([.!?…]["')\]]*)\s+(?=[A-Z0-9])/g, '$1\n\n').replace(/^(\d+[.)])\n\n/, '$1 ');
        return effLen(spaced) <= limit ? spaced : p;
      });
    }
  }
  return null;
}

// Split a tweet that overflows `limit` into consecutive tweets, packing blank-line blocks greedily so
// each stays <= limit — and NEVER leaving an orphan (a final fragment under `minTail` chars). If the
// tail is tiny, the last two pieces are re-merged (kept as one tweet when they fit, else re-wrapped at
// a word boundary into two balanced tweets). A tweet already within the limit is returned unchanged.
export function splitLongTweet(text, { limit, minTail = 40 }) {
  const t = String(text);
  if (effLen(t) <= limit) return [t];
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length < 2) return [t]; // one paragraph over the limit — leave it for the LLM tighten, never fragment mid-thought
  const pieces = [];
  let cur = '';
  for (const b of blocks) {
    const cand = cur ? `${cur}\n\n${b}` : b;
    if (effLen(cand) <= limit) { cur = cand; continue; }
    if (cur) pieces.push(cur);
    cur = b; // a lone block still over the limit stays whole — same as the pre-split behavior
  }
  if (cur) pieces.push(cur);
  // orphan guard: never leave a tiny final fragment. Merge it back with the piece before it — as one
  // tweet if they fit; else move whole blocks from the end of the prior piece onto the tail until both
  // are non-tiny (preserves blank-line style); else re-split the flattened pair at the sentence
  // boundary nearest the midpoint (balancedSplit — greedy wrap would just recreate the orphan).
  if (pieces.length >= 2 && effLen(pieces[pieces.length - 1]) < minTail) {
    const b = pieces.pop(), a = pieces.pop();
    const merged = `${a}\n\n${b}`;
    if (effLen(merged) <= limit) pieces.push(merged);
    else {
      let head = a.split(/\n{2,}/), tail = b;
      while (head.length > 1 && effLen(tail) < minTail) { tail = `${head[head.length - 1]}\n\n${tail}`; head = head.slice(0, -1); }
      const headText = head.join('\n\n');
      if (effLen(headText) <= limit && effLen(tail) <= limit && effLen(headText) >= minTail && effLen(tail) >= minTail) pieces.push(headText, tail);
      else pieces.push(...(balancedSplit(merged, limit, minTail) || wordWrap(merged.replace(/\n{2,}/g, ' '), limit)));
    }
  }
  return pieces.length ? pieces : [t];
}
