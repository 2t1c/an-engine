// lead-item.mjs — a numbered first tweet leads with the list's strongest item.
//
// Owner, 2026-09-28, after the retro test: "yes adopt fully — every numbered first tweet should have it
// implemented." The owner's question: "is it possible to lead the tweet 1 in a numbered thread with the
// most clickbaiting point first? Is that quantifiable with Jev."
//
// A numbered first tweet ends on its first item ("...told me the 8 things that decide your health at 60.
// 1. How often you walk."), and that one line is all of the list a reader sees in the feed. Over our last
// 90 days (612 such threads, learnings/lead-item.md), threads whose item 1 happened to be the list's
// strongest opener as Jev reads it reached 100k views 56% of the time against 41%, at 1.69x their page's
// median views and at the same money per view. Where item 1 sits in tweet 2, out of sight, the same split
// shows nothing (29% vs 28%), so it is the visible line that matters.
//
// So for every thread whose first tweet shows item 1, Jev reads each item alone under the hook (the
// lead-pull-read reading, one question), and when another item beats item 1 by laws.json
// hook.leadItem.margin, the two trade places: that item leads, and the old item 1 takes its slot. The swap
// is mechanical and keeps every word; each item's own tweets travel with it, and everything between keeps
// its position, so the plugs between stay where the CTA window wants them (in the last run's 69 drafts, a
// move to the front would have pushed the first ask past tweet 4 in all 19 moves). A swap that would still
// move the first link later is refused by default; the drafts step judges it with the canonical thread gate
// instead (scripts/run-lead-item.mjs). These never lead: the last item (it often closes the loop), an item
// whose tweets carry a link (tweet 2 would then sell), an item that shares a tweet or runs into the next
// item's tweet, and an item opening on a connective ("Then…"). Two reads keep a list whole: a list Jev
// reads as a sequence (steps, a story, a countdown) keeps its order (hook.leadItem.orderedMax), and an
// item that leans on its neighbour, or that its neighbour leans on ("Remember, don't take the wrong form."
// after "Magnesium glycinate"), stays where it is (hook.leadItem.followMax); the next strongest item is
// tried instead.
//
// Where it runs: scripts/row-skeleton.mjs swaps a cover's donor items before the plug plan and the writer
// (the writer then writes in the new order, and the plugs are placed for it), and scripts/run-lead-item.mjs
// checks every drafts row in every lane before the drafts packet. A verbatim harvest is measured against
// its source swapped the same way (scripts/run-content-packets.mjs), so a reorder is not an edit.
//
// PURE: listOf, candidatesOf, swapToFront, swapBack, sameWords, rankMoves, pickMove. The reads: readPulls,
// readOrdered, readFollows; the whole step: leadItem.
import { noul } from './jev.mjs';
import { LAWS } from './laws.mjs';
import { effLenMinted } from './content/text-shape.mjs';

const RULE = LAWS.hook?.leadItem || {};
export const LEAD_RULES = Object.freeze({
  margin: Number.isFinite(RULE.margin) ? RULE.margin : 0.05,
  minItems: Number.isFinite(RULE.minItems) ? RULE.minItems : 3,
  orderedMax: Number.isFinite(RULE.orderedMax) ? RULE.orderedMax : 0.4,
  followMax: Number.isFinite(RULE.followMax) ? RULE.followMax : 0.5,
  limit: LAWS.tweet?.limit ?? 280,
});

// The one question, as the retro test asked it (5,186 reads, learnings/lead-item.md).
export const LEAD_QUESTIONS = Object.freeze({
  pull: noul('If `item` were the first item shown right under `hook`, would it make most readers want to open the thread to see the other items?', {
    true: 'The item is surprising, specific or intriguing enough that a reader wants the rest of the list.',
    false: 'The item is expected, vague or already known, so it gives no extra reason to open the thread.',
  }),
});

// Is the list a sequence? Set on the retro test's 270 would-be moves: food and meal lists read 0.05, a
// story told in order and a morning/lunch/night stack 0.48, breakfast/lunch/dinner and narratives 0.8+.
export const LEAD_ORDER_QUESTIONS = Object.freeze({
  ordered: noul('Do the items in `items` have to be read in this order to make sense, as steps, a story or a countdown?', {
    true: 'The order carries meaning: each item builds on the one before, the items are steps in a sequence, a story told in order, or a countdown.',
    false: 'The items stand on their own; the list would read just as well in another order.',
  }),
});
// Does an item lean on the one before it? On the same 270: "Use that wake window gently." after "Expect a
// natural wake window" read 0.93, "Remember, don't take the wrong form." after "Magnesium Glycinate" 0.77;
// standalone neighbours stay under 0.5.
export const LEAD_FOLLOW_QUESTIONS = Object.freeze({
  follows: noul('Does `item` lean on `previous`, so that it only makes sense read right after it?', {
    true: '`item` refers back to `previous` or continues it: "then", "it", "that one", "the wrong one", a second half of the same point.',
    false: '`item` stands on its own; it would make sense after any other item.',
  }),
});
// An item that opens on a connective continues the one before it; it cannot open a list.
const CONNECTIVE = /^(then|next|finally|lastly|and|also|but|so|plus|after that|same)\b/i;

const MARKER = /^([ \t]*)(\d{1,3})([.)])([ \t]+)(\S.*)$/;
const LINK = /https?:\/\/|t\.co\/|\{\{LINK\d*\}\}|amzn\.|lvnta/i;
const linesOf = (t) => String(t).split('\n');
const firstLine = (t) => linesOf(t).findIndex((l) => l.trim());
const lastLine = (t) => { const ls = linesOf(t); for (let i = ls.length - 1; i >= 0; i--) if (ls[i].trim()) return i; return -1; };
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

/**
 * PURE. The list under a numbered first tweet, or { reason } when there is none, or its shape cannot be
 * moved safely. Two shapes:
 *   attached  tweet 1 ends on "1. <item>", and the items after it run 2..N;
 *   tease     tweet 1 ends on "1. <item>" and tweet 2 delivers it again as "1. <ITEM>", the list running
 *             1..N from there (numberingIssue's tease hook).
 * Items are found by their marker LINE, so a tweet may hold several items, and an item's text may run
 * into the next tweet ahead of that tweet's marker. Each item: { n, name, ti, line, to, tail, cont }:
 * ti/line where its marker is, `to` the last line of its text inside that tweet, `tail` the whole tweets
 * after it that belong to it, `cont` true when its text also runs into the next item's tweet. The last
 * item's tail is left empty: where it ends and the thread's tail begins is not knowable, and it never moves.
 */
export function listOf(tweets) {
  const T = (tweets || []).map((t) => String(t ?? ''));
  if (T.length < 2) return { reason: 'fewer than two tweets' };
  const marks = [];
  T.forEach((t, ti) => linesOf(t).forEach((l, li) => { const m = MARKER.exec(l); if (m) marks.push({ ti, li, n: +m[2], m }); }));
  const head = marks.filter((m) => m.ti === 0);
  if (!head.length) return { reason: 'tweet 1 shows no numbered item' };
  if (head.length > 1) return { reason: 'tweet 1 holds several items' };
  const one = head[0];
  if (one.n !== 1) return { reason: 'the item in tweet 1 is not item 1' };
  if (one.li !== lastLine(T[0])) return { reason: "item 1's text runs on inside tweet 1" };
  const body = marks.filter((m) => m.ti > 0);
  if (!body.length) return { reason: `fewer than ${LEAD_RULES.minItems} items` };
  const tease = body[0].n === 1;
  if (!body.every((m, i) => m.n === (tease ? 1 : 2) + i)) return { reason: 'the numbering after tweet 1 is not one clean list' };
  const count = tease ? body.length : body.length + 1;
  if (count < LEAD_RULES.minItems) return { reason: `fewer than ${LEAD_RULES.minItems} items` };
  const items = body.map((m, b) => {
    const next = body[b + 1];
    const sameTweet = next && next.ti === m.ti;
    return {
      n: m.n, name: m.m[5].trim(), ti: m.ti, line: m.li,
      to: sameTweet ? next.li - 1 : linesOf(T[m.ti]).length - 1,
      tail: sameTweet || !next ? [] : range(m.ti + 1, next.ti),
      cont: !!next && !sameTweet && next.li > firstLine(T[next.ti]),
    };
  });
  if (!tease) {
    const b0 = body[0];
    items.unshift({ n: 1, name: one.m[5].trim(), ti: 0, line: one.li, to: one.li, tail: range(1, b0.ti), cont: b0.li > firstLine(T[b0.ti]) });
  }
  return { shape: tease ? 'tease' : 'attached', hook: linesOf(T[0]).slice(0, one.li).join('\n').trim(), line: one.li,
    marker: { punct: one.m[3], space: one.m[4] }, items };
}

/** PURE. True when an item owns whole tweets: its marker opens its tweet and its text runs to that tweet's
 *  end (a swap trades whole tweets). */
const ownsTweets = (it, T) => it.line === firstLine(T[it.ti]) && it.to >= lastLine(T[it.ti]);

/** PURE. The items that may lead: not item 1, not the last item, owning whole tweets, no link in their
 *  text, no text running into the next item's tweet, not opening on a connective. None when item 1's own
 *  text runs into item 2's tweet (it could not travel). */
export function candidatesOf(list, tweets) {
  if (!list?.items) return [];
  const T = (tweets || []).map(String);
  const last = list.items.length - 1;
  const first = list.items[0];
  if (first.cont || (list.shape === 'tease' && !ownsTweets(first, T))) return [];
  const textOf = (it) => [linesOf(T[it.ti]).slice(it.line, it.to + 1).join('\n'), ...it.tail.map((b) => T[b])].join('\n');
  return list.items.map((it, i) => ({ it, i })).filter(({ it, i }) => i > 0 && i < last && it.name && !it.cont
    && ownsTweets(it, T) && !CONNECTIVE.test(it.name) && !LINK.test(textOf(it))).map(({ i }) => i);
}

// Every word of a thread, marker numbers left out (and, for a tease hook, tweet 1's mirror line), so a
// reorder is provably the same copy.
const wordsOf = (tweets, { skipLine = null } = {}) => tweets.flatMap((t, ti) => linesOf(t)
  .filter((_, li) => !(ti === 0 && li === skipLine)).map((l) => l.replace(MARKER, '$1$5')).join('\n').split(/\s+/).filter(Boolean));
/** PURE. True when two threads carry exactly the same words (in any order), marker numbers aside. */
export function sameWords(a, b, { skipLine = null } = {}) {
  const count = (ws) => ws.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map());
  const x = count(wordsOf(a, { skipLine })), y = count(wordsOf(b, { skipLine }));
  if (x.size !== y.size) return false;
  for (const [w, n] of x) if (y.get(w) !== n) return false;
  return true;
}

/** PURE. Renumbers every marker line in reading order: from 1 after tweet 1 for a tease list (tweet 1's
 *  mirror line stays 1), from tweet 1 on for an attached one. */
function renumber(tweets, { tease }) {
  let n = 0;
  return tweets.map((t, ti) => {
    if (tease && ti === 0) return t;
    return linesOf(t).map((l) => { const m = MARKER.exec(l); return m ? `${m[1]}${++n}${m[3]}${m[4]}${m[5]}` : l; }).join('\n');
  });
}

const trimBlank = (ls) => { let a = 0, b = ls.length; while (a < b && !ls[a].trim()) a++; while (b > a && !ls[b - 1].trim()) b--; return ls.slice(a, b); };
// A tease hook mirrors item 1 in its own case: "1. Green tea" over "1. GREEN TEA". Acronyms, and tokens with
// a digit or a "+", keep their capitals: "NAD+ AND NMN" mirrors as "NAD+ and NMN", "DHEA" stays "DHEA".
const ACRONYMS = new Set(['DHEA', 'NAD', 'NMN', 'EGCG', 'MCT', 'CBD', 'DNA', 'HRT', 'TRT', 'ADHD', 'IBS', 'PCOS', 'BPA', 'UTI', 'BMI', 'HIIT',
  'NSAID', 'NSAIDS', 'GABA', 'ATP', 'AI', 'TV', 'UV', 'USA', 'US', 'UK', 'FDA', 'LDL', 'HDL', 'PQQ', 'KSM', 'GLP', 'IGF', 'HGH', 'ACV', 'DIM', 'EPA', 'DHA']);
const sentenceCase = (name) => {
  const out = name.split(/(\s+)/).map((w) => (/\s/.test(w) || /[0-9+]/.test(w) || ACRONYMS.has(w.replace(/[^A-Za-z]/g, '')) ? w : w.toLowerCase())).join('');
  return out.charAt(0).toUpperCase() + out.slice(1);
};
const mirrorCase = (name, was, wasBody) => (wasBody === wasBody.toUpperCase() && was !== was.toUpperCase() && name === name.toUpperCase()
  ? sentenceCase(name) : name);

/** PURE. The 1-based index of the first tweet carrying a link, or Infinity when none does. */
export const firstLinkAt = (tweets) => { const i = (tweets || []).findIndex((t) => LINK.test(String(t))); return i < 0 ? Infinity : i + 1; };

/**
 * PURE. The thread with item `index` (0-based, in list.items) leading and the old item 1 in its slot, every
 * word kept:
 *   attached  tweet 1 now ends on the item's name, its text takes item 1's tweets; the old item 1 takes the
 *             item's tweets, its name on the marker (joined to its first tweet when the item wrote its text
 *             that way and it fits);
 *   tease     tweet 1's mirror line names the item, and the two whole blocks trade places.
 * Everything between keeps its position and the list is renumbered. Null when the result would not be the
 * same words, would put a tweet over the limit, would not parse as the same list, or (keepFirstLink, the
 * default) would move the first link later. The drafts step passes keepFirstLink: false and judges the
 * plugs with the canonical thread gate instead; the plan stage, on a donor whose plugs are not placed
 * yet, passes it too.
 */
export function swapToFront(tweets, list, index, opts = {}) {
  return swapDetailed(tweets, list, index, opts)?.tweets ?? null;
}

/** PURE. swapToFront with where each new tweet came from: { tweets, origin } where origin[i] is the old
 *  0-based index of new tweet i (null for a line the swap composed), plus `alias` (an old index whose words
 *  moved into another tweet), or null when the swap is refused. */
export function swapDetailed(tweets, list, index, { limit = LEAD_RULES.limit, keepFirstLink = true } = {}) {
  const T = (tweets || []).map(String);
  if (!list?.items || !(index > 0) || index >= list.items.length - 1) return null;
  if (!candidatesOf(list, T).includes(index)) return null;
  return swapRaw(T, list, index, { limit, keepFirstLink });
}

/** PURE. Old tweet number -> new tweet number (1-based) from a swap's origin list (and its aliases: an old
 *  0-based index whose words now sit in another new tweet). */
export function tweetMap(origin, alias = {}) {
  const map = {};
  (origin || []).forEach((from, i) => { if (Number.isInteger(from) && !(from + 1 in map)) map[from + 1] = i + 1; });
  for (const [from, to] of Object.entries(alias || {})) if (!(Number(from) + 1 in map)) map[Number(from) + 1] = to + 1;
  return map;
}

/**
 * PURE. The swap undone: the thread as it was before the lead item swapped in, found by the record's old
 * number (`from`: the old item 1 now sits there). Null when the thread no longer holds that swap. For a
 * check that needs the pre-swap copy (a harvest measured against a stored source hash).
 */
export function swapBack(tweets, lead, { limit = LEAD_RULES.limit } = {}) {
  const T = (tweets || []).map(String);
  if (!lead?.moved || !Number.isFinite(lead.from)) return null;
  const list = listOf(T);
  if (!list.items || list.items[0].name.toLowerCase() !== String(lead.name).toLowerCase()) return null;
  const index = list.items.findIndex((it) => it.n === lead.from);
  if (index < 1 || index >= list.items.length - 1) return null;
  return swapRaw(T, list, index, { limit, keepFirstLink: false })?.tweets ?? null;
}

function swapRaw(T, list, index, { limit, keepFirstLink }) {
  const it = list.items[index], first = list.items[0];
  const tease = list.shape === 'tease';
  const { punct, space } = list.marker;
  const t1 = linesOf(T[0]);
  const name = tease ? mirrorCase(it.name, MARKER.exec(t1[list.line])[5].trim(), first.name) : it.name;
  t1[list.line] = t1[list.line].replace(MARKER, (_, pre) => `${pre}1${punct}${space}${name}`);
  const blockOf = (x) => [x.ti, ...x.tail];                  // whole tweets (tease items, and item k)
  const inlineOf = (x) => trimBlank(linesOf(T[x.ti]).slice(x.line + 1, x.to + 1)).join('\n');
  // Each new tweet as [text, the old index it came from]: how a source note or a plug position follows it.
  let slot1, slotK;
  if (tease) {
    slot1 = blockOf(it).map((b) => [T[b], b]);
    slotK = blockOf(first).map((b) => [T[b], b]);
  } else {
    // item k's text, where item 1's text was
    slot1 = [...(inlineOf(it).trim() ? [[inlineOf(it), it.ti]] : []), ...it.tail.map((b) => [T[b], b])];
    // the old item 1, where item k was: its name on the marker, its text after it
    const head = `${index + 1}${punct}${space}${first.name}`;
    const text = first.tail.map((b) => [T[b], b]);
    const joined = text.length && inlineOf(it).trim() && effLenMinted(`${head}\n\n${text[0][0]}`) <= limit;
    slotK = joined ? [[`${head}\n\n${text[0][0]}`, text[0][1]], ...text.slice(1)] : [[head, null], ...text];
  }
  const range1 = tease ? blockOf(first) : first.tail;
  const rangeK = blockOf(it);
  const out = [[t1.join('\n'), 0]];
  for (let t = 1; t < T.length; t++) {
    if (t === (range1[0] ?? -1)) out.push(...slot1);
    if (range1.includes(t)) continue;
    if (t === rangeK[0]) { out.push(...slotK); continue; }
    if (rangeK.includes(t)) continue;
    out.push([T[t], t]);
  }
  if (!range1.length) out.splice(1, 0, ...slot1);            // item 1 had no text of its own: the item's text follows tweet 1
  const origin = out.map(([, from]) => from);
  // A name-only item's marker tweet held nothing but its name, which now sits in tweet 1.
  const alias = !tease && !inlineOf(it).trim() ? { [it.ti]: 0 } : {};
  const result = renumber(out.map(([text]) => text), { tease });
  if (!sameWords(T, result, tease ? { skipLine: list.line } : {})) return null;
  if (result.some((t) => effLenMinted(t) > limit)) return null;
  if (keepFirstLink && firstLinkAt(result) > firstLinkAt(T)) return null;
  const again = listOf(result);
  if (!again.items || again.items.length !== list.items.length || again.shape !== list.shape || again.items[0].name !== it.name) return null;
  return { tweets: result, origin, alias };
}

/** The key for the "does item j lean on item i" read (list indexes). */
export const pairKey = (i, j) => `${i}>${j}`;
/** PURE. The candidates that beat item 1 by the margin, strongest first (ties: the earlier item). */
export function rankMoves(pulls, candidates, { margin = LEAD_RULES.margin } = {}) {
  const p1 = pulls.get(0);
  if (!Number.isFinite(p1)) return [];
  return candidates.filter((i) => Number.isFinite(pulls.get(i)) && pulls.get(i) - p1 >= margin).sort((a, b) => pulls.get(b) - pulls.get(a) || a - b);
}
/** PURE. The neighbour pairs a swap of item i with item 1 breaks: item 2 losing item 1 before it, item i
 *  leaving its predecessor, and its successor losing it. */
export const pairsFor = (i, list) => [...new Map([[0, 1], [i - 1, i], ...(i + 1 < list.items.length ? [[i, i + 1]] : [])]
  .map((p) => [pairKey(...p), p])).values()];

/**
 * PURE. The move Jev's reads call for. `pulls` maps item index -> P(pull); `ordered` is P(the list is a
 * sequence) or null when unread; `follows` maps pairKey -> P(the second leans on the first), or null to
 * skip that check (an unread pair counts as leaning: a move is never made on a guess). The strongest
 * candidate that beats item 1 by the margin, is not in a leaning pair, swaps cleanly, and passes `accept`
 * (the caller's own gate, e.g. a cover's hook gate), wins.
 * Returns { index, tweets, origin, p1, pull } or { keep: reason, p1, best }.
 */
export function pickMove(tweets, list, pulls, { margin = LEAD_RULES.margin, candidates = candidatesOf(list, tweets), ordered = null, follows = null,
  orderedMax = LEAD_RULES.orderedMax, followMax = LEAD_RULES.followMax, accept = null, keepFirstLink = true } = {}) {
  const p1 = pulls.get(0);
  const read = candidates.filter((i) => Number.isFinite(pulls.get(i)));
  const best = read.length ? Math.max(...read.map((i) => pulls.get(i))) : null;
  if (!Number.isFinite(p1)) return { keep: 'item 1 was not read', p1: null, best };
  if (!candidates.length) return { keep: 'no item may lead', p1, best };
  if (!read.length) return { keep: 'no candidate was read', p1, best };
  if (Number.isFinite(ordered) && ordered >= orderedMax) return { keep: 'the list reads as a sequence (steps, a story or a countdown)', p1, best };
  const ranked = rankMoves(pulls, candidates, { margin });
  if (!ranked.length) return { keep: 'item 1 already leads', p1, best };
  let leaning = 0;
  for (const i of ranked) {
    if (follows && pairsFor(i, list).some(([a, b]) => !(follows.get(pairKey(a, b)) < followMax))) { leaning++; continue; }
    const moved = swapDetailed(tweets, list, i, { keepFirstLink });
    if (moved && (!accept || accept(moved.tweets))) return { index: i, tweets: moved.tweets, origin: moved.origin, alias: moved.alias, p1, pull: pulls.get(i) };
  }
  return { keep: leaning === ranked.length ? 'every stronger item leans on a neighbour' : 'the stronger items cannot be moved safely', p1, best };
}

/** Reads P(pull) for item 1 and every candidate through the one door (lead-pull-read). */
export async function readPulls(list, indexes, { client, ask, opts = {} } = {}) {
  const pulls = new Map();
  await Promise.all([0, ...indexes].map(async (i) => {
    try {
      const r = await ask('lead-pull-read', client, { state: { hook: list.hook.slice(0, 1200), item: list.items[i].name.slice(0, 400) }, questions: LEAD_QUESTIONS }, opts);
      const p = r?.answers?.pull?.noul;
      if (Number.isFinite(p)) pulls.set(i, p);
    } catch { /* unread: pickMove keeps item 1 when item 1 itself is unread */ }
  }));
  return pulls;
}

/** Reads P(the list is a sequence) through the one door (lead-order-read); null when unread. */
export async function readOrdered(list, { client, ask, opts = {} } = {}) {
  const items = list.items.map((it, k) => `${k + 1}. ${it.name}`).join('\n');
  try {
    const r = await ask('lead-order-read', client, { state: { hook: list.hook.slice(0, 1200), items: items.slice(0, 1500) }, questions: LEAD_ORDER_QUESTIONS }, opts);
    const p = r?.answers?.ordered?.noul;
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

/** Reads P(the second item leans on the first) for each pair (lead-follow-read); unread pairs are left out. */
export async function readFollows(list, pairs, { client, ask, opts = {} } = {}) {
  const follows = new Map();
  await Promise.all(pairs.map(async ([a, b]) => {
    try {
      const r = await ask('lead-follow-read', client, { state: { previous: list.items[a].name.slice(0, 400), item: list.items[b].name.slice(0, 400) }, questions: LEAD_FOLLOW_QUESTIONS }, opts);
      const p = r?.answers?.follows?.noul;
      if (Number.isFinite(p)) follows.set(pairKey(a, b), p);
    } catch { /* unread: pickMove treats the pair as leaning */ }
  }));
  return follows;
}

/**
 * The whole step for one thread. Returns { tweets, lead, map? } where map (on a swap) is old tweet number ->
 * new tweet number, for a caller that keeps notes by tweet, and lead records what happened:
 * { moved: true, from: <old item number>, name, pull, p1, was, ordered } or { moved: false, reason, p1?, best?, ordered? }.
 * `ask` defaults to jev-decide.mjs askThrough; tests pass a fake.
 */
export async function leadItem(tweets, { client = null, ask = null, margin = LEAD_RULES.margin, opts = {}, accept = null, keepFirstLink = true } = {}) {
  const T = (tweets || []).map(String);
  const list = listOf(T);
  if (!list.items) return { tweets: T, lead: { moved: false, reason: list.reason } };
  const candidates = candidatesOf(list, T);
  if (!candidates.length) return { tweets: T, lead: { moved: false, reason: 'no item may lead' } };
  const askFn = ask || (await import('./jev-decide.mjs')).askThrough;
  const [pulls, ordered] = await Promise.all([readPulls(list, candidates, { client, ask: askFn, opts }), readOrdered(list, { client, ask: askFn, opts })]);
  const ranked = Number.isFinite(ordered) && ordered >= LEAD_RULES.orderedMax ? [] : rankMoves(pulls, candidates, { margin });
  const pairs = [...new Map(ranked.flatMap((i) => pairsFor(i, list)).map((p) => [pairKey(...p), p])).values()];
  const follows = pairs.length ? await readFollows(list, pairs, { client, ask: askFn, opts }) : new Map();
  const pick = pickMove(T, list, pulls, { margin, candidates, ordered, follows, accept, keepFirstLink });
  const round = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  if (pick.tweets) {
    const it = list.items[pick.index];
    return { tweets: pick.tweets, map: tweetMap(pick.origin, pick.alias),
      lead: { moved: true, from: it.n, name: it.name, pull: round(pick.pull), p1: round(pick.p1), was: list.items[0].name, ordered: round(ordered) } };
  }
  return { tweets: T, lead: { moved: false, reason: pick.keep, p1: round(pick.p1), best: round(pick.best), ordered: round(ordered) } };
}

/** PURE. One line for a report. */
export function leadLine(lead) {
  if (!lead) return 'lead item: not checked';
  if (lead.moved) return `lead item: item ${lead.from} "${lead.name}" now leads (Jev pull ${lead.pull} vs ${lead.p1} for "${lead.was}")`;
  return `lead item: kept (${lead.reason}${lead.p1 != null ? `; item 1 pull ${lead.p1}${lead.best != null ? `, best other ${lead.best}` : ''}` : ''})`;
}
