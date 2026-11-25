// cta.mjs — the shared CTA judge (LLM). ONE brain, used at GENERATION (recreate.mjs) AND the 4:30pm
// QC pass (qc.mjs), so a weak plug is caught the moment it's written, not patched the next night.
// The live shape is PAYOFF: two beats + a CTA line that carries its own `(#ad)` — docs/cta-spec.md §4
// is the authority, style/thread-checklist.md §4 the checklist view. judgeClassicPlug below still
// holds the RETIRED three-line shape (big idea + evidence + hedged superlative + "Aff link:") on
// purpose: qc.mjs re-reads live and scheduled drafts written under it, and judging those by today's
// rules would "repair" every one of them into a shape their thread never used.
import { anthropic, FLEET_MODEL } from './lib.mjs';
import { DISCLOSURE, DISCLOSURE_LINE_RE, discloseBlock, isDisclosed } from './disclosure.mjs';
import { plugTextLen, PLUG_LIMIT, stripDashes as stripEmDash } from './checks.mjs';
// The CTA-vintage judge, imported rather than re-derived: it is the single source of "does this CTA
// follow the current law", and the style sniff below needs exactly that answer. Its main() is
// guarded, so importing it runs nothing.
import { ctaLineOf, ctaStyleOf } from './unschedule-old-plugs.mjs';

const linkOf = (t) => (t.match(/https?:\/\/\S+/) || [''])[0];
// stripEmDash = shared stripDashes from checks.mjs (dash-only; QC/judge inputs are existing posts, not fresh LLM output)

// A judge that could not be READ is not a pass (fail safe, never fail open): an API error, a crash, or
// a reply that is not a JSON verdict with a boolean `ok` all come back as ok:null + unjudged, so every
// `if (v.ok)` reads it as not-passed and callers route it to a human instead of shipping it as judged.
const unjudged = (reason) => ({ ok: null, unjudged: true, reason });
const judgeError = (e) => `judge error: ${String(e?.message || e).slice(0, 80)}`;
function readVerdict(out) {
  try {
    const j = JSON.parse((String(out ?? '').match(/\{[\s\S]*\}/) || [''])[0]);
    return j && typeof j === 'object' && typeof j.ok === 'boolean' ? j : null;
  } catch { return null; }
}

// judgePlug(env, account, priorTweet, plug) -> { ok:true } | { ok:false, reason, rewrite|null }
//   | { ok:null, unjudged:true, reason } when the judge could not be read (never a pass).
// Any rewrite is validated against the 255-excl-link budget + the affiliate disclosure before it's
// returned, so callers can apply it blind.
export async function judgePlug(env, account, prior, plug, style = null) {
  const link = linkOf(plug);
  // Style comes from the caller when it knows it (recreate passes CTA_STYLE). qc.mjs re-reads LIVE
  // drafts and has no style, so the wording sniffs below stay as the fallback — but they must never
  // be the primary route: freeing the payoff CTA wording (2026-08-15) means a fresh CTA line no
  // longer contains "pick (aff link)" and would otherwise fall through to the classic 3-beat judge,
  // which would "repair" every varied plug back into the house formula.
  if (style === 'payoff') return judgePayoffPlug(env, account, prior, plug, link);
  if (style === 'dm') return judgeDmPlug(env, account, prior, plug, link);
  // NARRATIVE own-product style (operator ebook test 2026-08-08): different shape, same bridge +
  // compliance rules. CTA line is "Get it here:" (first-party product — no affiliate disclosure).
  if (account.plugStyle === 'narrative') return judgeNarrativePlug(env, account, prior, plug, link);
  // Fallback sniff for callers with no style (qc.mjs on live drafts). Ordered newest-shape-first:
  // a CTA line carrying a first-person recommendation verb IS the current payoff shape, whatever
  // wording the author chose around it. The legacy "pick (aff link)" form stays recognised so the
  // archive keeps judging correctly.
  if (ctaStyleOf(ctaLineOf(plug)).style === 'recommendation') return judgePayoffPlug(env, account, prior, plug, link);
  if (/pick \(aff link/i.test(plug)) return judgePayoffPlug(env, account, prior, plug, link);
  // DM-PREEMPT split-test style (operator 2026-08-08): detected from the plug itself (the split is
  // per-thread, not per-account), judged against its own 2-line + CTA shape.
  if (/dm me after reading|dms about this|get it here \(aff/i.test(plug)) return judgeDmPlug(env, account, prior, plug, link);
  const prompt = `You QC affiliate plugs for @${account.handle} (${account.name}) on X.
A plug is exactly THREE short lines + the disclosure, and must satisfy ALL of these:
(1) BIG IDEA / BRIDGE — line 1 is ONE short sentence that continues the idea of the tweet right before it (reuse one of its words) AND names the plug's lead concept: the substance (e.g. magnesium, NAD) or the core symptom (e.g. cortisol, inflammation). Never a cold open on a new topic.
(2) EVIDENCE — line 2 is ONE sentence of the form "Research links <substance> to <benefit>, <benefit>, and <benefit>." The verb MUST be an association (links / ties / is linked to / associates with) and NEVER "proves", "guarantees", "cures", "treats", or "prevents". The FIRST benefit MUST continue line 1's concept (line 1 says cortisol -> line 2 opens "...to lower cortisol, ..."), so line 2 flows from line 1 instead of jumping. Benefits are punchy and concrete; NO disease names.
(3) SUPERLATIVE — line 3 is a first-person, HEDGED superlative that names the product ONCE by a SHORT recognizable name and ends on a colon ("X is the best-absorbing one I've tried:", "one of the best I've found:", "the only one I trust now:"). It MUST stay hedged + first-person ("I've tried/found/use") — REJECT any ABSOLUTE superlative ("the best magnesium", "the #1", "nothing beats it") and any generic line with no superlative. Never a bare label, never the full title, never stacked on the disclosure line.
Then "Aff link:" ALONE on its own minimal line, then the link on its own line.
FORMAT (HARD — scannability): EVERY sentence on its OWN line with a BLANK LINE between; NEVER two sentences on one line and NEVER two lines stacked with no blank line between — reject a stacked plug even if everything else is perfect. Text EXCLUDING the link must stay under ${PLUG_LIMIT} chars.
REJECT: a cold open / no bridge; line 1 missing the lead concept; line 2 using "proves"/"guarantees" or any cure/treat/prevent claim or disease name; line 2's first benefit not continuing line 1's concept; an ABSOLUTE (non-hedged) superlative; a generic recommendation with no superlative; the product as a bare label, a full title, or stacked on "Aff link"; any two sentences sharing a line or stacked; anything that reads as a standalone ad.

PRIOR TWEET:
${prior}

PLUG:
${plug}

If it satisfies the rules, return {"ok":true}. Otherwise {"ok":false,"reason":"<6 words max>","rewrite":"<rewritten plug>"}. The rewrite MUST be three short sentences, each on its own line with a BLANK LINE between, the DISCLOSURE INLINE on the last of them (never a line of its own — cta-spec.md §6), in this shape:

<line 1: one short big-idea sentence continuing the prior tweet and naming the lead concept (substance or core symptom)>

<line 2: "Research links <substance> to <that same concept>, <benefit>, and <benefit>." — association verb (links/ties/is linked to), NEVER "proves", first benefit continues line 1's concept, no disease names>

<line 3: first-person HEDGED superlative naming <PRODUCT> once by its short name, DISCLOSING INLINE and ending " (#ad):" ("is the best-... one I've tried (#ad):" / "one of the best I've found (#ad):") — never an absolute>

<link on its own line>

Keep the SAME product, the link verbatim, no em dashes, and text EXCLUDING the link under ${PLUG_LIMIT} chars. Every sentence on its OWN line with a BLANK LINE between (never stacked). In the JSON the rewrite string must use real line breaks (\\n). Return ONLY JSON.`;
  try {
    const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
    const j = readVerdict(out);
    if (!j) return unjudged('judge reply unparseable');
    if (j.ok) return { ok: true };
    let rw = stripEmDash(String(j.rewrite || '').trim());
    if (rw && link && !rw.includes(link)) rw += `\n\n${link}`;
    if (rw && !isDisclosed(rw)) rw = rw.replace(link, discloseBlock(link));
    if (rw && plugTextLen(rw) <= PLUG_LIMIT && isDisclosed(rw) && rw.includes(link)) return { ok: false, reason: j.reason || 'weak CTA', rewrite: rw };
    return { ok: false, reason: j.reason || 'weak CTA', rewrite: null };
  } catch (e) { return unjudged(judgeError(e)); }
}

// Payoff judge (operator 2026-08-15): the June-winner personal recommendation — a thread-personalized
// payoff line + switch story + possessive pick CTA. The judge is the ENFORCEMENT half of the style:
// its one non-negotiable is that BOTH beats are composed from THIS thread's own words (the 8.8%-CVR
// property), so it must reject stock phrasing rather than repair toward any template.
async function judgePayoffPlug(env, account, prior, plug, link) {
  const first = String(account.name || '').split(' ')[0] || account.name;
  const prompt = `You QC affiliate plugs for @${account.handle} (${account.name}) on X, written in the PAYOFF style: the plug is the conclusion of the argument the prior tweet just made, then a personal switch story.
A plug is exactly TWO beats + the CTA, and must satisfy ALL of these:
(1) PAYOFF — beat 1 is ONE sentence that lands the PRIOR TWEET's specific point and names the substance as its answer. It MUST reuse at least one concrete word from the prior tweet. REJECT a generic opener that could sit under any thread ("Magnesium changed my life") — the whole style is that this line could ONLY belong to this thread.
(2) SWITCH — beat 2 is plain speech, the way a person answers "what do you actually take?". The shape is two short sentences: what you take and for how long, then the benefits. "I've taken KSM-66 ashwagandha for three months. Now I fall asleep faster, my jaw doesn't clench at night, and I don't crash at 4pm." Sentence one names the EXACT FORM ("glycinate", "KSM-66", "monohydrate") and a duration; sentence two runs TWO OR THREE BENEFITS together.
  Every benefit must be a plain fact about a body the reader could check against their own ("my nails don't split", "I skip the 3pm coffee", "I lift more"). REJECT beat 2 for gesturing instead of saying:
    - a FIGURE OF SPEECH the reader must decode ("stairs stopped being a conversation with my knees", "the last reps stopped being negotiations", "hills stopped feeling like a wall", "the fog lifted") — rewrite to the literal outcome ("stairs stopped hurting", "hills got easier").
    - a NARRATOR line that announces a change without naming it ("the change was quiet", "the tell was my appetite", "what shifted was the evening", "the difference was hard to miss").
    - WRITERLY FRAMING no one says out loud ("before I'd call it real", "what I noticed was", "where I noticed it was").
    - a single vague outcome where two or three plain ones would fit.
  Do NOT reject beat 2 for being two sentences — that is the shape. Reject it for sounding composed.
  A research association is ALLOWED and is not an ad-shaped defect ("Research links magnesium to calm, deeper sleep, and clearer mornings"), provided the verb associates (links / ties / is linked to) and never promises. An honest limit in the same sentence ("six weeks before I'd call it real", "it did nothing for my energy") is a STRENGTH, never a reject.
  Hedged — NEVER an absolute ("the best", "#1"), NEVER "cures"/"treats"/"prevents"/"guarantees", NO disease names, NEVER an attribute or certification the product does not actually carry.
Then ONE CTA line ALONE on its own line, written fresh for this thread and CARRYING THE DISCLOSURE INLINE as " (#ad):", then the link on its own line (operator 2026-09-02: "#ad is same line as the last item" — one closer format across the system, the same one the hand-written pod library uses). A plug whose disclosure sits on its OWN "#ad" line is the RETIRED shape but is still correctly disclosed: accept it, and if you are rewriting the plug for another reason, fold the disclosure up into the CTA line. Never fail a plug only for which of the two places its disclosure sits in. The one fixed requirement on the wording is a FIRST-PERSON RECOMMENDATION VERB — "I use", "I take", "I buy", "I keep", "I reach for", "I swear by" (CTA law 2026-08-19); past tense and one positive adverb are fine ("I actually use", "I switched to"), and a negated verb only with a cessation verb ("the one I never skip" endorses, "the one I never use" rejects). "This is the magnesium I use:", "This is the exact one I buy:", "I've taken this one for six months:" are all valid. A possessive closer that never reaches a verb is RETIRED — never rewrite a CTA toward one. Beyond the verb, DO NOT rewrite a valid CTA line into a house template: varied CTA wording is a measured property of the winners (12 distinct lines across 15 plugs in the era that converted at 8.8-9.5%, vs 2 shapes across 16 in the era that converted at 2.8%).
FORMAT (HARD): every beat on its own line with a BLANK LINE between; reject beats run together on one line. A beat MAY be two short sentences — that is the house shape, NOT a stacking defect, and splitting it into two lines is itself a rejectable rewrite. Text EXCLUDING the link must stay under ${PLUG_LIMIT} chars.
REJECT: no disclosure anywhere in the plug; a CTA line with no first-person recommendation verb, or one using the retired possessive closers; a payoff line that shares no concrete word with the prior tweet or reads stock; a switch with no exact form, no time-stamp, or fewer than two concrete benefits; a switch that gestures (narrator line / metaphor) instead of naming the benefit; an absolute superlative; any cure/treat/prevent claim or disease name; a FOURTH slot (an extra beat beyond payoff + switch + CTA — benefits belong inside the switch, not in their own block); beats run together on one line. Do NOT reject a CTA line merely for being unfamiliar wording, and do NOT reject a plug over WHERE its disclosure sits — inline on the CTA line is the current shape, a standalone "#ad" line is the retired one, and both count as disclosed.

PRIOR TWEET:
${prior}

PLUG:
${plug}

If it satisfies the rules, return {"ok":true}. Otherwise {"ok":false,"reason":"<6 words max>","rewrite":"<rewritten plug>"}. The rewrite MUST be two beats + the CTA in this shape:

<beat 1: payoff sentence landing the prior tweet's point, reusing one of its concrete words, naming the substance>

<beat 2: plain speech — "I take {form} for {how long}. Now {benefit}, {benefit}, and {benefit}." Literal benefits, no figure of speech>

<the SAME CTA line the plug already uses, its recommendation verb and wording intact — never swap the author's line for a template — ending " (#ad):">

<link on its own line>

Keep the SAME product, the link verbatim, no em dashes, and text EXCLUDING the link under ${PLUG_LIMIT} chars. In the JSON the rewrite string must use real line breaks (\\n). Return ONLY JSON.`;
  try {
    const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
    const j = readVerdict(out);
    if (!j) return unjudged('judge reply unparseable');
    if (j.ok) return { ok: true };
    let rw = stripEmDash(String(j.rewrite || '').trim());
    if (rw && link && !rw.includes(link)) rw += `\n\n${link}`;
    if (rw && !isDisclosed(rw)) rw = rw.replace(link, `This is the one I use:\n\n${discloseBlock(link)}`);
    if (rw && plugTextLen(rw) <= PLUG_LIMIT && isDisclosed(rw) && rw.includes(link)) return { ok: false, reason: j.reason || 'weak CTA', rewrite: rw };
    return { ok: false, reason: j.reason || 'weak CTA', rewrite: null };
  } catch (e) { return unjudged(judgeError(e)); }
}

// DM-preempt judge (CTA split test 2026-08-08; rewritten to the operator's two structures
// 2026-08-12): 2 beats + CTA with the disclosure inline. Hedging, no-disease, spacing, and length
// rules unchanged from the classic judge. The judge is the ENFORCEMENT half of the style — when the
// prompt's shape changes and this doesn't, the judge "repairs" every fresh plug back into the old
// wording and the split test measures the thing we just replaced.
async function judgeDmPlug(env, account, prior, plug, link) {
  const prompt = `You QC affiliate plugs for @${account.handle} (${account.name}) on X, written in the DM-PREEMPT style (the creator answering the question the DMs keep asking).
A plug is exactly TWO beats + the CTA, and must satisfy ALL of these:
(1) THE ASK — beat 1 says the question keeps coming AND names the product's substance, tied to the thread's topic. Both of these are correct and neither is preferred: "Every time I post about {topic}, the DMs ask the same thing. It's this {substance}." and "Since I know the DMs are coming: this is the {substance} I've been using." Any close variant of either is fine. Never a random topic jump.
(2) EARNED TRUST — beat 2 is a first-person lived line. Both of these are correct: "I've tried so many. This is the one I stayed on and trust." and "After burning money on the cheap ones, this is the one that stuck." Hedged — NEVER an absolute ("the best", "#1", "nothing beats it"), NEVER "cures"/"treats"/"prevents"/"guarantees", NO disease names, and NEVER an attribute or certification the product does not actually carry.
Then a CTA line "Get it here (aff link):" (optionally "(aff link, Made in USA)") ALONE on its own line — the "(aff link)" disclosure is REQUIRED — then the link on its own line.
FORMAT (HARD): every BEAT on its own line with a BLANK LINE between; reject a plug whose two beats are run together on one line. A single beat MAY be two short sentences ("I've tried so many. This is the one I stayed on and trust.") — that is the house shape, NOT a stacking defect, and splitting it into two lines is itself a rejectable rewrite. Text EXCLUDING the link must stay under ${PLUG_LIMIT} chars.
REJECT: missing or reworded-away disclosure; an absolute superlative; any cure/treat/prevent claim or disease name; a beat 1 that names no substance; a third beat (mechanism, benefit list, "Research links X to A, B and C"); the two beats run together on one line.

PRIOR TWEET:
${prior}

PLUG:
${plug}

If it satisfies the rules, return {"ok":true}. Otherwise {"ok":false,"reason":"<6 words max>","rewrite":"<rewritten plug>"}. The rewrite MUST be two beats + the CTA in this shape:

<beat 1: the recurring ask, naming the substance — keep whichever of the two openers the plug already uses>

<beat 2: first-person lived trust line — hedged, no disease names>

Get it here (aff link):

<link on its own line>

Keep the SAME product, the link verbatim, no em dashes, and text EXCLUDING the link under ${PLUG_LIMIT} chars. In the JSON the rewrite string must use real line breaks (\\n). Return ONLY JSON.`;
  try {
    const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
    const j = readVerdict(out);
    if (!j) return unjudged('judge reply unparseable');
    if (j.ok) return { ok: true };
    let rw = stripEmDash(String(j.rewrite || '').trim());
    if (rw && link && !rw.includes(link)) rw += `\n\n${link}`;
    if (rw && !isDisclosed(rw)) rw = rw.replace(link, `Get it here:\n\n${discloseBlock(link)}`);
    if (rw && plugTextLen(rw) <= PLUG_LIMIT && isDisclosed(rw) && rw.includes(link)) return { ok: false, reason: j.reason || 'weak CTA', rewrite: rw };
    return { ok: false, reason: j.reason || 'weak CTA', rewrite: null };
  } catch (e) { return unjudged(judgeError(e)); }
}

// Narrative own-product judge (ebook test): story arc instead of research-evidence, "Get it here:"
// instead of "Aff link:". Bridge, hedging, no-disease, spacing, and length rules are unchanged.
async function judgeNarrativePlug(env, account, prior, plug, link) {
  const prompt = `You QC product plugs for @${account.handle} (${account.name}) on X. The plug promotes OUR OWN digital product as a short personal story.
A plug is exactly THREE short story beats + the CTA, and must satisfy ALL of these:
(1) STORY OPEN — line 1 begins "I used to" (or an equivalent first-person before-state) and continues the idea of the tweet right before it (reuse one of its concrete words). Never a cold open on a new topic.
(2) THE TURN — line 2 begins "Then I" (or equivalent) and names the concrete change. Modest and lived — NEVER "cures", "treats", "prevents", "guarantees", NO disease names, no invented hard numbers.
(3) PAYOFF — line 3 is first-person, names the product ONCE by its short name, ends on a colon. Never an absolute superlative ("the best plan ever", "#1").
Then "Get it here:" ALONE on its own minimal line, then the link on its own line.
FORMAT (HARD — scannability): EVERY beat on its OWN line with a BLANK LINE between; reject a stacked plug even if everything else is perfect. Text EXCLUDING the link must stay under ${PLUG_LIMIT} chars.
REJECT: a cold open / no bridge; a turn with cure/treat/prevent claims or disease names; a payoff line missing the product name or the colon; an absolute superlative; hype that reads like an ad instead of a person talking; any two beats sharing a line or stacked.

PRIOR TWEET:
${prior}

PLUG:
${plug}

If it satisfies the rules, return {"ok":true}. Otherwise {"ok":false,"reason":"<6 words max>","rewrite":"<rewritten plug>"}. The rewrite MUST be three story beats + the CTA, each on its own line with a BLANK LINE between:

<line 1: "I used to ..." before-state continuing the prior tweet's idea>

<line 2: "Then I ..." the concrete change — modest, no cure/treat/prevent, no disease names>

<line 3: first-person payoff naming the product once by its short name, ending on a colon>

Get it here:

<link on its own line>

Keep the SAME product, the link verbatim, no em dashes, and text EXCLUDING the link under ${PLUG_LIMIT} chars. In the JSON the rewrite string must use real line breaks (\\n). Return ONLY JSON.`;
  try {
    const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
    const j = readVerdict(out);
    if (!j) return unjudged('judge reply unparseable');
    if (j.ok) return { ok: true };
    let rw = stripEmDash(String(j.rewrite || '').trim());
    if (rw && link && !rw.includes(link)) rw += `\n\n${link}`;
    if (rw && !isDisclosed(rw, { own: true })) rw = rw.replace(link, `Get it here:\n\n${link}`);
    if (rw && plugTextLen(rw) <= PLUG_LIMIT && isDisclosed(rw, { own: true }) && rw.includes(link)) return { ok: false, reason: j.reason || 'weak CTA', rewrite: rw };
    return { ok: false, reason: j.reason || 'weak CTA', rewrite: null };
  } catch (e) { return unjudged(judgeError(e)); }
}
