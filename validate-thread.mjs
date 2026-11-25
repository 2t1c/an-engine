// validate-thread.mjs — gate a HAND-AUTHORED thread against the 10 conversion laws + the house gates,
// before it ever reaches Typefully. The engine's own threads go through recreate.mjs/qc.mjs; operator-
// written threads (Winner Factory output, pasted from any chat) had no checker at all until now.
//
// The ten laws are measured properties of every thread that converted 8.3-12.0%, not preferences —
// see docs/thread-molds.md. Most are STRUCTURAL and invisible while writing, which is exactly why a
// machine has to check them: three were violated within an hour of being written down.
//   node validate-thread.mjs draft.md
// Input: optional KEY: value header block, then tweets separated by lines containing only ---.
// {{LINK:ASIN}} placeholders are accepted and counted as a 23-char t.co link.
import { readFileSync } from 'node:fs';
import { DISCLOSURE_LINE_RE } from './disclosure.mjs';
import { TWEET_LIMIT, PLUG_LIMIT, effLen, plugTextLen, plugStructure, absoluteSuperlativeIssue, hardHealthClaim, classifyPlugMove, BAD_PLUG_MOVES, bannedTopicIssue} from './checks.mjs';

const raw = readFileSync(process.argv[2], 'utf8');
// Strip the leading KEY: value header block (ACCOUNT/PRODUCT/TOPIC/FORMAT/MOLD/BASED-ON/ROTATION-OF),
// however many lines it runs to — matching on one key name broke the moment a new key was added.
const lines = raw.split('\n');
let start = 0;
while (start < lines.length && /^[A-Z][A-Z0-9 -]*:/.test(lines[start].trim())) start++;
while (start < lines.length && !lines[start].trim()) start++;
const text = lines.slice(start).join('\n').trim();
const tweets = text.split(/\n---\n/).map((t) => t.trim()).filter(Boolean);
const MENU = new Set(['B0GT2JKMYZ', 'B0CV2SXX5M', 'B0CV2RSRFX', 'B079K32QB6', 'B07DX89ZHN', 'B07S76M4D5', 'B0CK4WTYP1', 'B09QFSDLL5', 'B0CDFDDRCF']);
const sub = (t) => t.replace(/\{\{LINK:([A-Z0-9]{10})\}\}/g, 'https://lvnta.com/lv_aQG4ojxH7uoD');
const isPlug = (t) => /\{\{LINK:/.test(t);
const plugIdx = tweets.map((t, i) => (isPlug(t) ? i : -1)).filter((i) => i >= 0);
// A QRT appendix numbers its entries 1/ 2/ 3/ too, so counting every leading number as a content
// item double-counts and then fails the hook's "only N" promise against a total that includes the
// appendix. Detected STRUCTURALLY, by the mechanism SELF-QRT-PLAN.md documents — "a tweet whose
// text ends with a status URL renders as a QUOTE card" — rather than by sniffing bridge phrasing,
// which would rot the moment someone writes a new one.
const isQuote = (t) => /(?:twitter|x)\.com\/[^\s/]+\/status\/\d+/i.test(t);
const itemIdx = tweets.map((t, i) => (!isPlug(t) && !isQuote(t) && /^\s*\d+[\.\/]\s/m.test(t) ? i : -1)).filter((i) => i >= 0);
const fail = [], warn = [];

// ---- LAW 1: plug count. OPERATOR RULING 2026-08-16: raised from "exactly 2" to "up to 5".
// Worth recording WHY the old rule existed, because it was never a finding: all 90 measured posts
// had exactly 2 plugs, but only because the engine can emit exactly 2 (plugPositions returns
// {heavyAfter, lightBefore} and recreate splices plugs.heavy + plugs.light). There was no variance
// to learn from, so "exactly 2" described the pipeline, not conversion. The one real signal we do
// have points the other way: threads plugging 2 DISTINCT products converted at 3.5% CVR / $0.229 EPC
// versus 1.2% / $0.120 for the same product twice. 3+ is genuinely untested — treat it as a live
// experiment and read it on revenue per 1k views, not on faith.
// LAW 1 (operator 2026-08-16): the plug budget scales with the BASE thread length — content tweets
// counted BEFORE the plugs were inserted. <=10 base -> 2 plugs, 11-15 -> 3, >15 -> up to 5. A longer
// thread gives more away, so it can ask more often without breaking the give-to-ask ratio.
const baseLen = tweets.length - plugIdx.length;
const MAX_PLUGS = baseLen <= 10 ? 2 : baseLen <= 15 ? 3 : 5;
if (!plugIdx.length) fail.push('LAW 1: no plugs');
if (plugIdx.length > MAX_PLUGS) fail.push(`LAW 1: ${plugIdx.length} plugs on a ${baseLen}-tweet base (max ${MAX_PLUGS} at that length)`);
// ---- LAW 2: plug #1 at tweet 3; the LAST plug deep but clear of the closer; and with 3+ plugs,
// no two adjacent (a reader must always get a give between two asks).
if (plugIdx[0] !== 2) fail.push(`LAW 2: plug #1 at tweet ${plugIdx[0] + 1} (must be tweet 3)`);
const last = plugIdx[plugIdx.length - 1];
if (plugIdx.length > 1) {
  const depth = (last + 1) / tweets.length;
  const lo = /anchor|listicle/i.test(raw.slice(0, 400)) ? 0.45 : 0.6;
  if (depth < lo || depth > 0.9) fail.push(`LAW 2: last plug at ${(depth * 100).toFixed(0)}% depth (want ${Math.round(lo * 100)}-90%)`);
  if (last >= tweets.length - 2) fail.push('LAW 2: last plug sits in the last two tweets (TLDR/sign-off territory)');
}
for (let i = 1; i < plugIdx.length; i++) if (plugIdx[i] - plugIdx[i - 1] < 2)
  fail.push(`LAW 2: plugs at tweets ${plugIdx[i - 1] + 1} and ${plugIdx[i] + 1} are adjacent — never two asks in a row`);
// ---- LAW 3: no plug carries a number
for (const i of plugIdx) if (/^\s*\d+[\.\/]\s/m.test(tweets[i])) fail.push(`LAW 3: plug at tweet ${i + 1} is written as a numbered item`);
// ---- LAW 4: give-to-ask ratio. Feed threads measured 7:2..16:2 (>=4 items per plug); the ANCHOR
// listicle is a different economy — its items ARE recommendations, and the proven original ran 5:2
// (40% of items linked). So the threshold is format-aware, read from the FORMAT/MOLD header.
const isAnchor = /anchor|listicle/i.test(raw.slice(0, 400));
const perPlug = isAnchor ? 2 : 4;
if (itemIdx.length < plugIdx.length * perPlug) fail.push(`LAW 4: ${itemIdx.length} items vs ${plugIdx.length} plugs (${isAnchor ? 'listicle' : 'feed'} needs >= ${plugIdx.length * perPlug})`);
// Half the items linked is the ceiling even on a listicle: the proven $1,608 anchor linked 40%, and
// past 50% the thread stops reading as curation and starts reading as a catalogue.
if (isAnchor && plugIdx.length / itemIdx.length > 0.5) fail.push(`LAW 4: ${(plugIdx.length / itemIdx.length * 100).toFixed(0)}% of items linked (cap 50%; the proven anchor linked 40%)`);
// Every plug must sell a DIFFERENT product — same-product-twice measured 1.2% CVR vs 3.5%.
const asins = plugIdx.map((i) => (tweets[i].match(/\{\{LINK:([A-Z0-9]{10})\}\}|dp\/([A-Z0-9]{10})/) || []).slice(1).find(Boolean));
asins.forEach((a, i) => { const d = asins.findIndex((x, j) => j < i && x && x === a); if (d >= 0) fail.push(`LAW 4: plug ${i + 1} sells the same ASIN as plug ${d + 1} (${a}) — distinct products convert 3x better`); });
// ---- LAW 5: each plug's first line reuses a content word from the tweet above
const STOP = new Set('the a an and or but is are was were of to in on for with that this it its your you my i we they he she as at by from be been being not no so if then than there here what which who how why when all any some more most other into over after before under again very can will just now'.split(' '));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
// Banned topic (operator 2026-08-21): checked across the WHOLE thread before anything else, because
// no per-tweet fix makes an off-limits subject shippable.
const bt = bannedTopicIssue(tweets); if (bt) fail.push(bt);

for (const i of plugIdx) {
  const openLine = tweets[i].split('\n')[0];
  const prev = new Set(words(tweets[i - 1] || ''));
  const shared = words(openLine).filter((w) => prev.has(w));
  if (!shared.length) fail.push(`LAW 5: plug at tweet ${i + 1} shares no content word with tweet ${i} (no bridge)`);
  // LAW 11 — SEEDING. The winners plant a plug's concept BEFORE the lead-in (10 of 12 plugs): the
  // hook seeds plug #1 ("It starts with inflammation..." -> omega-3 at tweet 3), an earlier item
  // seeds plug #2. The reader then meets the plug already holding the question it answers.
  const earlier = new Set(tweets.slice(0, Math.max(0, i - 1)).flatMap(words));
  const seeded = words(openLine).filter((w) => earlier.has(w));
  if (!seeded.length) warn.push(`LAW 11: plug at tweet ${i + 1} is not seeded earlier — its concept appears nowhere before tweet ${i}`);
}
// ---- LAW 8: a first-person admission somewhere
if (!/\bI (used to|did not|didn't|struggled|wasted|burned|tried|spent|ignored|switched|kept)\b/i.test(text)) warn.push('LAW 8: no clear first-person admission of having had the problem / wasted effort');
// ---- LAW 9: doses present
// Durations are protocol numbers too — "run it 8 to 12 weeks" is exactly the kind of specific
// instruction Law 9 is about, and counting only mg/g/minutes under-reported every thread whose
// protocol is measured in weeks.
const doses = text.match(/\b\d+(?:[.,]\d+)?\s?(?:mg|g|grams?|minutes?|min|hours?|hrs?|seconds?|sec|days?|weeks?|months?|steps|hz|iu|%)\b/gi) || [];
if (doses.length < 4) warn.push(`LAW 9: only ${doses.length} dose/protocol numbers (winners carry many)`);
// ---- LAW 10: no urgency/scarcity
const urgency = text.match(/\b(limited time|act now|hurry|don't wait|before it'?s too late|discount code|coupon|sale ends|only \d+ left)\b/gi);
if (urgency) fail.push(`LAW 10: urgency/scarcity language: ${[...new Set(urgency)].join(', ')}`);

// ---- house mechanics
tweets.forEach((t, i) => {
  const s = sub(t);
  if (effLen(s) > TWEET_LIMIT) fail.push(`tweet ${i + 1}: ${effLen(s)} effective chars > ${TWEET_LIMIT}`);
  if (/—|–/.test(t)) fail.push(`tweet ${i + 1}: em/en dash`);
  const sup = absoluteSuperlativeIssue?.(t); if (sup) fail.push(`tweet ${i + 1}: absolute superlative: ${sup}`);
  // Boilerplate (disclaimer / closing) is matched by STRICT equality in the engine and deliberately
  // skipped by its transforms — the disclaimer literally contains "prevent, diagnose, or treat
  // disease", so running the claim detector over it is a guaranteed false positive.
  const isBoiler = /^DISCLAIMER:/i.test(t) || /^Copy the link to this thread/i.test(t);
  const hc = isBoiler ? null : hardHealthClaim?.(t); if (hc) fail.push(`tweet ${i + 1}: health claim: ${JSON.stringify(hc).slice(0, 70)}`);
  for (const l of t.match(/\{\{LINK:([A-Z0-9]{10})\}\}/g) || []) if (!MENU.has(l.slice(7, 17))) fail.push(`tweet ${i + 1}: ASIN ${l.slice(7, 17)} off-menu`);
});
for (const i of plugIdx) {
  const s = sub(tweets[i]);
  const ps = plugStructure(s); if (!ps.ok) fail.push(`tweet ${i + 1}: plugStructure ${ps.failed}: ${ps.detail}`);
  if (plugTextLen(s) > PLUG_LIMIT) fail.push(`tweet ${i + 1}: plug text ${plugTextLen(s)} > ${PLUG_LIMIT}`);
  if (!DISCLOSURE_LINE_RE.test(tweets[i])) fail.push(`tweet ${i + 1}: no affiliate disclosure`);
}
// plug openers must differ
const openers = plugIdx.map((i) => words(tweets[i].split('\n')[0]).slice(0, 2).join(' '));
openers.forEach((o, i) => { const d = openers.findIndex((x, j) => j < i && x === o); if (d >= 0) fail.push(`plug ${i + 1} opens on "${o}" like plug ${d + 1}`); });
// STRUCTURAL variety, not just lexical. Checking that two plugs open on different WORDS and close
// on different CTA STRINGS passes happily while every plug runs the identical shape — measured live
// 2026-08-16: five plugs where four were "I wasted years on the cheap version, then switched" +
// "The {product} I {verb} (aff link):". A reader does not register vocabulary, they register the
// rhythm, and five identical rhythms read as five ads. June's winning era varied the SHAPE: some
// led with the product, some with a spec, some with a story, some were one blunt line.
const shape = plugIdx.map((i) => {
  const beats = tweets[i].split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const d = beats.findIndex((b) => DISCLOSURE_LINE_RE.test(b));
  const body = d > 0 ? beats.slice(0, d) : beats;
  return `${body.length}|${body.map((b) => (/^I\b/i.test(b) ? 'I' : 'x')).join('')}`;
});
if (plugIdx.length >= 3) {
  const counts = shape.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {});
  const [sig, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (n > plugIdx.length / 2) fail.push(`LAW 12: ${n} of ${plugIdx.length} plugs share the same shape (${sig} = beat count + which beats open first-person) — vary the STRUCTURE, not just the wording`);
}
// LAW 12c (operator 2026-08-16): the opener MOVE. Two plugs can differ in beat count and wording and
// still make the same rhetorical move, which is what a returning reader actually recognises. Also
// bans the two openers we are eliminating: a dose/count opener is a product label, and a
// brand-first opener reads as a placement when the link card already shows the brand.
const moves = plugIdx.map((i) => classifyPlugMove(tweets[i]));
moves.forEach((mv, n) => {
  if (BAD_PLUG_MOVES.has(mv)) fail.push(`LAW 12c: plug ${n + 1} opens ${mv} (${mv === 'spec-led' ? 'a dose/count opener is a product label, not a person' : 'the link card already shows the brand; naming it first reads as a placement'})`);
});
{
  const named = moves.filter((m) => m !== 'other');
  const dupes = named.filter((m, n) => named.indexOf(m) !== n);
  for (const m of [...new Set(dupes)]) fail.push(`LAW 12c: ${named.filter((x) => x === m).length} plugs open on the same move (${m}) — rotate: objection, admission, failure-mode, personal-limit, form-declaration, conditional-usage`);
}
// ...and so must their CTA lines. The era that converted at 8.8-9.5% used 12 distinct CTA lines
// across 15 plugs; the era that converted at 2.8% used 2 across 16. A page whose every plug closes
// on the same words is running a template, and a returning reader learns to skip that line.
const ctaLines = plugIdx.map((i) => {
  const beats = tweets[i].split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const d = beats.findIndex((b) => DISCLOSURE_LINE_RE.test(b));
  return d >= 0 ? beats[d].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() : '';
});
ctaLines.forEach((c, i) => { const d = ctaLines.findIndex((x, j) => j < i && x && x === c); if (d >= 0) fail.push(`plug ${i + 1} closes on the same CTA line as plug ${d + 1} ("${c.slice(0, 40)}") — vary it`); });
// item 1 attached to hook
// Mold 4 is the exception: its proven original opens on the caps promise alone and starts item 1
// in tweet 2. Every other mold attaches item 1 to the hook.
const isDeepDive = /MOLD:\s*4/i.test(raw.slice(0, 400));
if (!isDeepDive && !/\n\s*1[\.\/]\s/.test(tweets[0])) warn.push('item "1." is not attached to the end of tweet 1');
// forward pulls
const pulls = tweets.filter((t) => /↓\s*$/.test(t) || /(next|then|but|before|except|which brings|and last)[^\n]{0,60}$/i.test(t.trim())).length;
if (pulls < Math.floor(itemIdx.length / 2)) warn.push(`only ${pulls} tweets end with a forward pull`);

console.log(JSON.stringify({
  tweets: tweets.length, items: itemIdx.length, plugs: plugIdx.length,
  plugPositions: plugIdx.map((i) => i + 1), giveToAsk: `${itemIdx.length}:${plugIdx.length}`,
  maxEffChars: Math.max(...tweets.map((t) => effLen(sub(t)))), doses: doses.length,
  PASS: fail.length === 0, fail, warn,
}, null, 1));
