// prompts.mjs — the generation-prompt layer, extracted verbatim from recreate.mjs (2026-07-21 split:
// prompts here, deterministic gates/repairs in checks.mjs, orchestration stays in recreate.mjs).
// Everything here is either a pure prompt builder (unit-tested in test-scaffolds) or a thin LLM caller
// whose only state is its arguments — nothing reads recreate's CLI flags, so the engine's behavior is
// unchanged by the move.
import { readFileSync, existsSync } from 'node:fs';
import { DISCLOSURE, DISCLOSURE_LINE_RE, isDisclosed, discloseBlock } from './disclosure.mjs';
import { join } from 'node:path';
import { anthropic, FLEET_MODEL, STRONG_MODEL, HERE_DIR } from './lib.mjs';
import { effLen, hasUrl, plugTextLen, PLUG_LIMIT, leadingNumbers, shortName, hookBodyText, srcTweet1AttachesItem, bridgeAnchors, substanceTermsFor } from './checks.mjs';
import { renderSkeleton, podFill, numberPastedPods } from './outline.mjs'; // one-way: outline never imports prompts
import { VOICE_BLOCKS_ON, signOffOf } from './laws.mjs';

// The account's VOICE section, or nothing. One helper for all three prompt builders so the fleet
// switch cannot be honoured in one and forgotten in another. Emits its own leading newline, so a
// withheld voice collapses to a single blank line instead of leaving a dangling header.
const voiceSection = (account) => (VOICE_BLOCKS_ON && account.voice
  ? `\n== ${String(account.name).toUpperCase()} VOICE ==\n${account.voice}\n` : '');
import { PODS as _PODS } from './pods.mjs';
const PODS_SUBSTANCE = new Map(_PODS.map((p) => [p.id, p.substance]));

// A style/*.md rules file is top-level `- ` bullets in prose: only the bullets inject, everything
// else is documentation. Shared by both rule channels below (and unit-tested directly on temp files).
export function bulletRules(absPath, label) {
  if (!existsSync(absPath)) return '';
  const rules = (readFileSync(absPath, 'utf8').match(/^- .*/gm) || []).map((l) => l.replace(/^-\s*/, '').trim());
  return rules.length ? `\n== ${label} ==\n${rules.map((r) => '- ' + r).join('\n')}\n` : '';
}

// style/learned-rules.md IS NO LONGER INJECTED (operator 2026-09-02: "stop learned-rules — it has
// been quite outdated for a long time"). The retro still writes there, but the file is now a REVIEW
// QUEUE a human promotes from, not prompt text. Why the channel was cut rather than pruned:
//
//   The retro appended machine-written rules straight into every generation prompt, and nothing
//   expired them. By the audit it held 40 bullets: ~14 described the CTA shape retired on
//   2026-08-21 (three lines + "Aff link:" + a hedged superlative), 2 contradicted current law
//   (a hard "never two sentences on one line", which the payoff beat explicitly allows; and
//   "keep the source's opener AS-IS", which the 2026-08-17 85-90% paraphrase law replaced), and
//   ~20 restated rules buildPrompt already carries verbatim and better — with a concrete number
//   attached and a "(hard)" tag. Exactly one bullet was both true and unique: compose to ~85% of
//   the limit rather than to the cap, which now lives in the STYLE rule below.
//
//   The failure mode is structural, not editorial: a machine channel that only appends drifts, and
//   a prompt that contradicts itself lets the model pick. The human channel (operator-rules.md)
//   stays live because a person writes and retires those bullets.
//
// The operator's standing instructions, edited from the dashboard's Generate page (Airtable buffer +
// apply-instructions commit).
export function operatorRules() {
  return bulletRules(join(HERE_DIR, 'style', 'operator-rules.md'), "OPERATOR RULES (the human's standing instructions — obey every one)");
}

// DECOMPOSED GENERATION: the main prompt asks for ONLY the hook + numbered lessons — no plugs.
// The old single-pass prompt made the model juggle two counters at once (output-tweet position AND
// lesson number, offset by unnumbered plugs it had to interleave) — that dual-counter drift is why
// long listicles kept dropping a mid-thread item. Now: rewording a listicle (easy, what LLMs are
// good at), plugs written by writePlugs() in their own small call, and CODE splices them in at the
// canonical positions — item count survives any thread length by construction.
export function buildPrompt(srcTweets, src, account, { itemTarget } = {}) {
  // Inject the source's EXACT numbered-item count as a hard target. "Same count" as prose drifts;
  // a concrete number ("exactly 9, in one sequence 1..9") is the deterministic anchor that stops the
  // recurring dropped-item / skipped-index failures at generation rather than catching them in QC.
  // INTENTIONAL TRIM (operator 2026-08-10): the algorithm punishes long threads and long generations
  // multiply AI failure odds, so a donor above the faithful item cap is TRIMMED — write only the
  // STRONGEST itemTarget items and the hook's "N things" number says the trimmed count. Ideal thread
  // is 7-13 tweets, leaning short.
  const donorItems = srcTweets.flatMap(leadingNumbers).length;
  const itemCount = itemTarget && itemTarget < donorItems ? itemTarget : donorItems;
  const trimmed = itemCount < donorItems;
  const countRule = itemCount >= 3
    ? (trimmed
      ? `\nITEM COUNT (hard — INTENTIONAL TRIM, this overrides "recreate EVERY numbered lesson" below): the source has ${donorItems} numbered items, which is TOO LONG for the algorithm. Write ONLY the STRONGEST ${itemCount} items (judge by punch, specificity, and pluggable substance; keep the source's order), renumbered as ONE continuous sequence 1..${itemCount}. The hook's "N things" number MUST say ${itemCount}, not ${donorItems}. Never pack two items into one tweet to fit more in.`
      : `\nITEM COUNT (hard): the source has EXACTLY ${itemCount} numbered items. Your thread MUST contain EXACTLY ${itemCount} numbered items as ONE continuous sequence 1..${itemCount} — never drop, merge, split, skip, or renumber. If you are tempted to combine two, don't: keep all ${itemCount}.`)
    : '';
  // Hard hook-length target (operator 2026-07-24): "CHARACTER COUNT within ~10%" as prose drifts LONG
  // (the rephrase reads clumsy). A concrete donor char count is the deterministic anchor; a gate in
  // recreate.mjs enforces it after the fact.
  const dAttaches = srcTweet1AttachesItem(srcTweets[0] || '');
  const donorHookLen = effLen(hookBodyText(srcTweets[0] || '', dAttaches));
  // Per-sentence targets, not one whole-hook ceiling: the rhythm a proven hook scans on lives in the
  // sentence lengths, and a paraphrase that keeps the total but redistributes it loses that rhythm.
  const donorHookSents = hookBodyText(srcTweets[0] || '', dAttaches)
    .split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const donorHookSentences = donorHookSents.length;
  const donorSentenceSpec = donorHookSents.map((x, i) => `  ${i + 1}. ~${effLen(x)} chars: "${x}"`).join('\n');
  const hookLenRule = donorHookLen
    ? `\nHOOK SHAPE (hard): the donor's hook (tweet 1${dAttaches ? ', excluding its "1." item line' : ''}) is ${donorHookLen} characters across ${donorHookSentences} sentence(s):\n${donorSentenceSpec}\nWrite the SAME number of sentences in the same order, each within ~20% of its counterpart's character count. Paraphrase inside them; do not add clauses or modifiers, and never let the whole hook run longer than ${donorHookLen} characters. A hook that reads longer than the donor's is a failure.`
    : '';
  // Returns [staticPart, variablePart]: the static block (persona + voice + every generic rule +
  // plug examples) is byte-identical for ALL of an account's slots, so the caller marks it with
  // cache_control and Anthropic serves it from prompt cache on every slot/repair/retry after the
  // first — faster time-to-first-token and ~2K fewer fresh input tokens per call. Everything
  // per-thread (products, item count, the source thread itself) lives in the uncached tail.
  const staticPart = `You are the ghostwriter for @${account.handle} (${account.name}), a health page on X. Recreate the INSPIRATION THREAD below as a brand-new ${account.name} thread that is ~95% structurally faithful but in ${account.name}'s voice. Output ONLY the hook and the body tweets — the affiliate plugs, sign-off, and disclaimer are inserted programmatically afterwards.
${voiceSection(account)}
== RULES ==
HOOK (tweet 1): 85-90% OF THE SOURCE (operator law 2026-08-17, superseding the 90-95% word-swap rule). The proven hook is the asset. What must survive is its SHAPE: the SAME number of sentences, in the SAME order, each sentence about as long as the donor's corresponding sentence (within ~20% characters), carrying the same frame, the same promise and the same scale numbers.
  PARAPHRASE INSIDE EACH SENTENCE — this is now required, not optional. Rewrite the sentence in ${account.name}'s own phrasing rather than swapping one or two words. A hook that differs from the donor by two words is still a near-identical string X can match against a post with millions of views, and a duplicate hook is the one thing that can get the whole thread suppressed. Aim to land around 85-90% of the donor's wording: recognisably the same hook, not the same sentence.
  NEVER soften the punch. "revealed mind-blowing facts that 99% wouldn't know" must NOT become "shared facts most people never hear"; "shocked me" must NOT become "left me thinking". If a word carries the shock, the number or the promise, it either stays or it is replaced by something equally sharp — never by something milder. Do NOT restyle into hype, and do NOT change any FACTUAL number (a real person's age, a named statistic, a dollar figure); only a non-load-bearing round number may shift.
  FIRST ITEM: the hook's trailing "1. <first lesson>" line is NOT inherited from the donor — it is whatever YOUR item 1 is. Write it in the donor's item shape and length. It is excluded from the 85-90% measurement, so it may differ completely.
  FIRST ITEM MUST FIT THE LIST'S OWN NOUN (hard). Your hook promises a TYPE of thing, and item 1 has to be one of those things. If the hook says "N ways / things / supplements / habits / steps", item 1 may BE the substance itself ("1. Magnesium glycinate, an hour before bed."). If the hook says "N signs / symptoms / reasons / mistakes", item 1 must be the OBSERVATION the reader recognises in themselves ("1. Waking up at 3-4 AM.") — a supplement is NOT a sign, and naming one there makes the thread read as an ad from its first line. If the hook says "N foods / drinks / herbs", item 1 must be a member of THAT category. When the noun will not take the product, do not force it: the substance arrives in the bridge a tweet or two later instead, which is where it converts anyway.
  OPENING BLOCK WHEN ITEM 1 CANNOT BE THE PRODUCT (diagnostic lists): give the substance TWO beats before the ask, never one. Tweet 1 is the hook with its observation item. Tweet 2 EXPLAINS that item and NAMES the substance for the first time (why the 3am wake-up happens, and what the body is burning through to hold that dip). Tweet 3 AGITATES: the cost of leaving it, or why the obvious fix misses, closing again on the substance. Tweet 4 is the plug. Introducing a substance and asking for the click in consecutive tweets is a cold sell and reads as an ad.
  DISTRIBUTE THE REWRITE (hard): the 85-90% applies to EVERY sentence, not to the hook on average. Leaving one sentence verbatim and rewriting another past recognition averages out to a healthy number while neither sentence is right. Change something in each.
  The "N things" number in the hook MUST equal the count of numbered lesson tweets you write below.
BODY: recreate EVERY numbered lesson, the SAME count and the SAME order, each beginning with its exact number ("2.", "3.", ... through the last; the hook already holds "1."). Reword each lesson LIGHTLY in ${account.name}'s phrasing (synonyms, light rephrasing, cleaned grammar) so no tweet is a verbatim copy of the source or another account's version — but keep the item COUNT identical, the numbering continuous (1, 2, 3, … no gaps, no repeats, no second list), and each lesson's meaning and key numbers intact. NEVER add, drop, merge, split, or renumber items. If the source contains two separate numbered lists, flatten them into ONE continuous sequence. Drop the source's own ad lines (e.g. "Get it here") — our plugs are inserted programmatically afterwards. Keep the source's closing idea as the final numbered lesson. Mirror the source's item DENSITY: a source giving each item its own tweet gets one item per tweet; a PACKED source (several one-line items per tweet) is reproduced at that same packed density — adjacent numbered lines, no blank line between, never a bare dangling number or empty stub item.
SAFETY (health claims): supportive, hedged language only (supports, may help, is linked to). NEVER claim any product or habit cures, treats, prevents, or reverses a disease, and never name a disease as a promise.
DO NOT write a sign-off, a disclaimer, or ANY product/affiliate content — those are inserted automatically. End your output on the final numbered lesson.
REPLY BAIT (last tweet — operator 2026-08-13): after the final numbered lesson, add ONE short closing tweet that asks the reader a genuine question they can answer from their own experience. X's ranking weights a REPLY at 5.0 versus a like at 0.5, so a reply is worth ten likes: this tweet is the highest-leverage line in the thread. It must be SPECIFIC to what the thread just taught ("Which of these are you already doing?", "Which one wrecked you the longest?"), never generic engagement-bait ("Thoughts?", "Agree?", "Comment below", "Let me know!"). One sentence, no emoji, no hashtags, not numbered, and it must sound like ${account.name} genuinely curious — not a growth hack. Never ask a yes/no question a reader can answer without typing.
STYLE: no em dashes; no hype words; one blank line between separate lines inside a tweet, but NEVER split a single sentence across two lines (a line ends only at a sentence end, a colon, or a list item), and NO blank line between consecutive "- " sub-list items (bullets sit on adjacent lines, directly under their label line); every tweet under 280 chars (link = 23).
LENGTH TARGET: compose each tweet to land at or under ~238 characters, including its item number and any link. 280 is the hard ceiling, not the target — a tweet written to the cap leaves QC nothing to trim and reads dense. If a tweet would run past 238, shorten it rather than write to the limit.
RHYTHM (operator 2026-09-13, thresholds fixed 2026-09-15 against the finished remix): write it to be SKIMMED. NO SENTENCE OVER 17 WORDS \u2014 17 is the edge, not the target: aim for a median near 10 and VARY the lengths inside every tweet, because a 3-word line next to a 12-word line reads while five 11-word lines in a row is a wall with gaps in it. Staccato is allowed and is often the best close. THREE TO FOUR PARAGRAPHS per tweet, never more \u2014 a numbered listicle item is exempt, and a bullet block counts as one paragraph, the item's title line as one, the link line as one. A \u2022 BULLET ROW RUNS INLINE on one line (\u2022 Sardines \u2022 Organ meats \u2022 Peanuts), never one per line; this is separate from the \"- \" SUB-LIST SHAPE below, which keeps its own one-item-per-line form. The plug is NOT exempt: the first pot measured under these rules carried a 31-word sentence inside its own plug, the tweet the whole thread is built to reach. laws.json tweet.maxSentenceWords and tweet.maxParagraphs hold the numbers and checks.mjs rhythmIssues reports them, so this prompt and the gate cannot drift apart.
PLAIN TEXT (hard): X renders NO markdown — every markdown character ships to the reader as literal noise. Use no bold or italics (**, __, *, _), no backticks or code fences, no headers (#), no blockquotes (>), and no "*" bullets. Your structure toolkit: a plain "N." item marker, a blank line, ordinary punctuation, and — for SUB-LISTS inside a tweet — a plain "- " hyphen bullet. SUB-LIST SHAPE (operator 2026-08-11): when the source lists things under a label (a grocery list, a stack, steps), keep the label line ("Proteins:") DIRECTLY above its items, each item on its OWN "- " line, items on ADJACENT lines with NO blank line between them, and NEVER merge two items onto one line. Mirror the source's list density — a tight bullet block must stay a tight bullet block, never bare lines spaced apart.
${operatorRules()}`;
  // Faithful-side PACKING rule (operator 2026-08-11): a packed donor (several one-line items per
  // tweet — a proven winning format) is mirrored at its own density; without this the model writes
  // elaborated one-per-tweet items and the thread blows the length gate (live: 17 items -> 22 tweets).
  const mcF = (t) => (String(t).match(/^\s*\d{1,3}[.)]\s/gm) || []).length;
  const donorBodyTweetsF = Math.max(1, srcTweets.filter((t) => mcF(t) >= 1).length);
  const donorPackedF = itemCount >= 6 && itemCount / donorBodyTweetsF >= 1.6; // avg density, same rule as skeleton.mjs
  const packRuleF = donorPackedF
    ? `\nPACKING (hard — mirror the donor's density; this OVERRIDES any one-item-per-tweet guidance): the donor packs ~${Math.max(2, Math.round(itemCount / donorBodyTweetsF))} short items per tweet across ~${donorBodyTweetsF} body tweets. Reproduce that: each body element holds that many CONSECUTIVE numbered items on ADJACENT lines (single line break between, NEVER a blank line), each item ONE punchy line with NO elaboration paragraph, every element under 280 chars. Your body should be about ${donorBodyTweetsF} tweets, not ${itemCount}. Every item line carries real content — never a bare dangling number or empty stub.`
    : '';
  const variablePart = `${countRule}${hookLenRule}${packRuleF}
== INSPIRATION THREAD (source: ${src.url}, ${src.impressions.toLocaleString()} views) ==
${srcTweets.map((t, i) => `[${i === 0 ? 'HOOK' : 'tweet ' + (i + 1)}]\n${t}`).join('\n\n')}

Return ONLY a JSON array of strings — the hook first, then the body tweets in posting order, one element per tweet. Do NOT include plugs, ads, a sign-off, or a disclaimer. No commentary.`;
  return [staticPart, variablePart];
}

// ---- buildOutlinePrompt: the SINGLE-PASS writer (phase 2) ----------------------------------------
// The old buildPrompt carries four separate prohibitions against mentioning the product, so the body
// is written blind and two later calls go back and patch the product in. This one hands the writer
// the product and the outline instead, and asks for the plug POSITION as a bare marker rather than
// the plug itself.
//
// What that keeps and what it drops matters. It KEEPS the programmatic splice — code still owns the
// final link and the CTA copy — because the original decomposition fixed a real bug: making the model
// juggle output position and lesson number at once is what made long listicles drop items. It DROPS
// the blindfold, because that was never the part doing the work. The writer emits "{{PLUG:magnesium}}"
// as its own array element and never a URL; the counter never has to renumber around it.
//
// Returns [staticPart, variablePart] like buildPrompt so the account-static block stays prompt-cached.
// ---- buildSlotPrompt: the SLOT_MODE writer ---------------------------------------------------------
// The writer decides NOTHING structural. compileSkeleton (outline.mjs) has already fixed every tweet
// position, which item carries which criterion tail, and where each plug sits; assemble.mjs joins the
// plug beats, appends the disclosure and the bare link. The writer's whole job is prose per slot.
// Placement instructions are deliberately ABSENT from this prompt: two measured batches proved that
// when placement rules and body rules compete for a slot, the writer resolves the fight in whichever
// direction ships a defect. Here there is no fight left to resolve.
export function buildSlotPrompt(srcTweets, src, account, { skeleton, products = [], itemTarget } = {}) {
  const [base, donorTail] = buildPrompt(srcTweets, src, account, { itemTarget });
  // The first slot batch shipped hooks at 6-18% of the donor because this function took only the
  // STATIC half of buildPrompt — the donor thread lives in the VARIABLE half, so the writer was
  // told "paraphrase donor tweet 1" about a donor it had never seen. Keep the donor block (and the
  // count/packing rules that ride with it); strip only the ARRAY output contract, which slot mode
  // replaces with the JSON-object contract below.
  const donorBlock = donorTail.replace(
    'Return ONLY a JSON array of strings — the hook first, then the body tweets in posting order, one element per tweet. Do NOT include plugs, ads, a sign-off, or a disclaimer. No commentary.',
    '').trimEnd();
  // Same base as every other mode (voice, laws, banned phrases) minus the pre-splice prohibitions —
  // in slot mode the plugs ARE part of the writer's output, as fields.
  const DROP = [
    ' Output ONLY the hook and the body tweets — the affiliate plugs, sign-off, and disclaimer are inserted programmatically afterwards.',
    ' Drop the source\'s own ad lines (e.g. "Get it here") — our plugs are inserted programmatically afterwards.',
    '\nDO NOT write a sign-off, a disclaimer, or ANY product/affiliate content — those are inserted automatically. End your output on the final numbered lesson.',
  ];
  let staticPart = base;
  for (const d of DROP) staticPart = staticPart.split(d).join('');

  const productBlock = products.map((p, i) => {
    const terms = substanceTermsFor(p);
    return `  PRODUCT ${i + 1}: ${p.title} (${p.asin})\n    substance to argue for, by name: ${terms[0] || shortName(p.title)}${terms.length > 1 ? ` (also: ${terms.slice(1, 4).join(', ')})` : ''}`;
  }).join('\n');

  const tail = `${donorBlock}

== THE PRODUCTS ==
${productBlock || '  (none)'}

== THE SKELETON (every slot's job — placement is already decided) ==
${renderSkeleton(skeleton)}

== THE POD (how a product enters a thread) ==
Three tweets, in order, every time:
  1. the ITEM tweet ends on ONE line hinting the substance ("...the other half of the fix was ashwagandha")
  2. the SUBSTANCE TWEET — educate: why it is the lever (hedged), why most people get nothing
     (underdosed/wrong-form shelf versions), and END on what to LOOK FOR (the form/standard)
  3. the PLUG — the three beats below. The plug ANSWERS the substance tweet's criterion.
The skeleton already places all three; fill them.

== PLUG FIELDS ==
For each PLUG slot return an object with the fields its slot line names ({"opener": ..., "middle": ..., "cta": ...};
a roundup plug also carries "criterion" — ONE discriminating sentence code welds onto the item before it).
  opener — ONE move: objection, admission, failure-mode, personal limit, form-declaration,
           conditional usage, or sourcing question. Never a dose or spec. Never the brand name first.
           The plugs in this thread must open on DIFFERENT moves with structurally different sentences.
  middle — first person, a NUMERIC time stamp ("six weeks in", "since March"), the exact FORM by
           name, 2-3 outcomes that happened to a person. Texture, loyalty lines and usage
           instructions are not outcomes.
  cta    — short, first person, possessive, built on "This is my ..." — e.g. "This is my magnesium".
           No colon, no link, no disclosure: code appends the "#ad" line and the link.

== OUTPUT ==
Return ONE JSON object and nothing else. Keys are slot numbers as strings. Body/hook slots map to
the tweet text; plug slots map to their field object. Optionally include "_moves": {"<slot>": "<opener move>"}.
Example shape: {"1": "...", "2": "...", "3": "...", "4": {"opener": "...", "middle": "...", "cta": "..."}, "_moves": {"4": "admission"}}
No URLs anywhere. No markdown fences. Every slot present.`;

  return [staticPart, tail];
}

export function buildOutlinePrompt(srcTweets, src, account, { outline, products = [], itemTarget } = {}) {
  const [base, tail] = buildPrompt(srcTweets, src, account, { itemTarget });

  // Strip the four prohibitions. They exist as whole sentences, so removing them cleanly is a
  // matter of naming them rather than regexing around them.
  const DROP = [
    ' Output ONLY the hook and the body tweets — the affiliate plugs, sign-off, and disclaimer are inserted programmatically afterwards.',
    ' Drop the source\'s own ad lines (e.g. "Get it here") — our plugs are inserted programmatically afterwards.',
    '\nDO NOT write a sign-off, a disclaimer, or ANY product/affiliate content — those are inserted automatically. End your output on the final numbered lesson.',
  ];
  let staticPart = base;
  for (const d of DROP) staticPart = staticPart.split(d).join('');

  const productBlock = products.map((p, i) => {
    const terms = substanceTermsFor(p);
    return `  PRODUCT ${i + 1}: ${p.title}\n    substance the thread must name: ${terms[0] || shortName(p.title)}${terms.length > 1 ? ` (also: ${terms.slice(1, 4).join(', ')})` : ''}`;
  }).join('\n');

  const plugPlan = (outline?.plugs || []).map((b, i) => {
    // A pod-covered block is PASTED: the marker will be replaced by the pod's own tweets, so the
    // writer's only job is the marker line — and, for a 2-tweet pod (requiresHostMention), the
    // run-up mention the pod cannot supply itself. Writing selling copy for a covered substance
    // anywhere else would duplicate the pasted plug.
    if (b.pod) {
      const rows = b.pod.requiresHostMention
        ? b.runUp.map((r) => `      tweet ${r.tweet} — ${r.role.toUpperCase()}: ${r.must}`).join('\n')
        : b.runUp.map((r) => `      (advisory) tweet ${r.tweet} — ${r.role.toUpperCase()}: ${r.must}`).join('\n');
      const hijack = b.donorAdSpan
        ? `\n      HIJACK: source tweets ${b.donorAdSpan.start}-${b.donorAdSpan.end} are the creator's OWN AD — do not recreate ANY of them; the marker is their replacement, not an addition`
        : '';
      return `  PLUG ${i + 1} (${b.product.title.slice(0, 46)}) goes at tweet ${b.plugAt} — PASTED FROM THE LIBRARY (${b.pod.tweets.length} tweets, pod ${b.pod.id}):${hijack}\n${rows}\n      tweet ${b.plugAt} — write EXACTLY this one line as its own array element: {{PLUG:${b.product.asin}}}\n      do NOT write selling copy, a CTA, or a link for this product anywhere else — the marker is replaced by proven copy verbatim`;
    }
    const rows = b.runUp.map((r) => `      tweet ${r.tweet} — ${r.role.toUpperCase()}: ${r.must}`).join('\n');
    return `  PLUG ${i + 1} (${b.product.title.slice(0, 46)}) goes at tweet ${b.plugAt}:\n${rows}\n      tweet ${b.plugAt} — write EXACTLY this one line as its own array element: {{PLUG:${b.product.asin}}}`;
  }).join('\n\n');

  const sellRules = `
== YOU ARE WRITING A THREAD THAT SELLS SOMETHING. HERE IS WHAT. ==
${productBlock || '  (none — this thread is not monetized)'}

THE ONE RULE THAT DECIDES WHETHER IT CONVERTS — THE RUN-UP INTO EVERY MARKER, IN THIS ORDER:
${(outline?.plugs?.[0]?.runUp?.length || 2) >= 2 ? `
    the tweet TWO BEFORE the marker   NAME the substance and why it belongs here (the introduction)
    the tweet IMMEDIATELY BEFORE it   the BUYING CRITERION: what separates the version that works
                                      from the shelf junk
    then                              the {{PLUG:asin}} marker

Both run-up beats ride the numbered items that already occupy those slots — keep each item's own
meaning and number, and land its LAST line on the beat it owes. You are adding a tail, never
replacing an item.` : `
    the tweet IMMEDIATELY BEFORE the marker   this ONE beat does BOTH jobs: it names the substance
                                              AND ends on the BUYING CRITERION — what separates the
                                              version that works from the shelf junk
    then                                      the {{PLUG:asin}} marker

This shape gets a single run-up beat because the hook already primed the reader and the item tweet
IS the substance. That one tweet still owes the criterion in its final line — keep the item's own
meaning and number and add the criterion as its tail, never as a replacement.`}

The criterion is what separates a real product from junk, never just the substance's name:
  "Most ashwagandha on the shelf is raw root powder at a dose no study ever used."
  "The catch is the form. Glycinate absorbs cleanly, oxide mostly passes through."
  "High-EPA triglyceride, not the cheap ester capsules."
The CTA then ANSWERS a question the reader is already holding, instead of making a claim they have
to trust.

THE ORDER IS ABSOLUTE: introduce, THEN criterion, THEN marker. Never introduce-then-marker-then-criterion.

  ✗ WHAT KEEPS GOING WRONG — 82% of one measured batch did exactly this:
      [10] 7. Get sunlight within an hour of waking. ... alongside magnesium at night.   <- name only
      [11] {{PLUG:B0CV2SXX5M}}                                                            <- SELLS HERE
      [12] 8. Stop trying to outwork stress. ... The catch is the form: glycinate         <- justifies TOO LATE
                absorbs gently, oxide mostly passes through you.
    The criterion was written, correctly, one tweet past the sale. The reader bought or bounced
    before ever being told what to look for.

  ✓ THE SAME CONTENT, ORDERED RIGHT:
      [10] 7. Get sunlight within an hour of waking. ... and magnesium at night to help the fall.
      [11] 8. Stop trying to outwork stress. ... Your nervous system burns magnesium to recover.
                The catch is the form: glycinate absorbs gently, oxide mostly passes through you.
      [12] {{PLUG:B0CV2SXX5M}}

If you find yourself about to write a criterion in the tweet AFTER a marker, the marker is in the
wrong place: move the marker down, not the criterion up.
ITEM 1 (${outline?.firstItem?.form || 'concept'}): ${outline?.firstItem?.guidance || 'follow the donor.'}${outline?.firstItem?.form === 'donor-item' ? `
THE DONOR'S BODY IS THE ASSET (hard): recreate EVERY numbered item with ITS OWN meaning, count and order intact — the BODY rule above is not relaxed by the products listed here. The plugs are the ONLY product content in the thread, and they live in their marker lines between items. Rewriting an item into product copy is the failure this rule exists to prevent.` : ''}
SHAPE (${outline?.shape || 'standard'}): ${(outline && outline.plugs[0]?.note) || ''}${outline?.shape === 'roundup' && products.length ? `
PROMISE SWAP (this thread is being CONVERTED to a supplement roundup): rewrite the hook's PROMISE sentence to promise the supplements themselves — "Here are N things you must pay attention to:" becomes "Here are the N supplements that fix them:". That ONE sentence is exempt from the 85-90% rule; every OTHER hook sentence still lands in the band. The N must equal the numbered items you write.
CONVERTED SHAPE = THE M0 ANCHOR LISTICLE (operator law 2026-08-17: a conversion pours the donor into a PROVEN mold shape, never an improvised hybrid): hook carries item 1, each item names its substance and why it earns the spot, criterion beat, then the plug marker — repeat per product, recap list near the end, then the reply-bait question. Keep the donor's claims as the WHY inside each item; the donor's structure does not survive a conversion, its substance does.` : ''}

== WHERE THE PLUGS GO ==
${plugPlan || '  (no plugs)'}

NEVER WRITE A URL, a link, a price, or a disclosure token ("#ad", "aff link") anywhere. The marker line is the whole plug — code writes the CTA copy and the tracked link into it afterwards. A tweet containing a URL is a hallucinated plug and the draft is thrown away.
The marker is its OWN element in the array and carries nothing else. Do not number it. Do not count it as a numbered item.`;

  // The tail inherited buildPrompt's closing instruction, which FORBIDS plugs — the exact opposite
  // of the marker instruction above it. On the first live run the model obeyed the last instruction
  // it read and emitted no markers at all, so the whole outline path silently degraded to the old
  // positional flow. The closing line is rewritten, not merely deleted, so the JSON contract stays.
  const fixedTail = tail.replace(
    /Return ONLY a JSON array of strings[\s\S]*?No commentary\.`?$/,
    'Return ONLY a JSON array of strings — the hook first, then the body tweets in posting order, one element per tweet, INCLUDING each {{PLUG:asin}} marker line as its OWN element exactly where the plan places it. Never a URL, never ad copy, no sign-off, no disclaimer — code appends those. No commentary.'
  );
  return [staticPart, `${sellRules}\n${fixedTail}`];
}

// splicePlugMarkers — replace each {{PLUG:asin}} element with the written plug. Pure + testable.
// Returns { tweets, spliced, missing } so a writer that dropped or duplicated a marker is a visible
// failure rather than a thread that silently ships one plug short.
export const PLUG_MARKER_RE = /^\s*\{\{PLUG:([A-Za-z0-9_-]+)\}\}\s*$/;
// A fill value may be a STRING (one written plug tweet) or an ARRAY (a pasted pod's 2-3 tweets —
// point/bridge/plug land as separate tweets at the marker's position, in order).
export function splicePlugMarkers(tweets, plugTextByAsin = {}) {
  const out = [];
  const spliced = [];
  const missing = [];
  for (const t of tweets || []) {
    const m = String(t).match(PLUG_MARKER_RE);
    if (!m) { out.push(t); continue; }
    const asin = m[1];
    const text = plugTextByAsin[asin];
    if (text) { const arr = [].concat(text); out.push(...arr); spliced.push({ asin, at: out.length - arr.length + 1, count: arr.length }); }
    else missing.push(asin); // drop the marker rather than shipping "{{PLUG:...}}" to a timeline
  }
  return { tweets: out, spliced, missing };
}

/**
 * pasteOutlinePods — the OFFLINE half of the paste path, pure and testable: given the writer's
 * tweets (markers included), the outline whose blocks carry .pod, and the real products (with
 * minted links), splice every covered plug as pasted library tweets. recreate.mjs performs the same
 * fill inline (it also handles the classic no-marker path and partial writer coverage); this
 * function exists so the acceptance harness can prove the assembly end-to-end with no LLM and no
 * network, and drift between the two is a test failure rather than a production surprise.
 */
export function pasteOutlinePods(writerTweets, outline, products = []) {
  const fill = {};
  const pasted = [];
  for (const b of outline?.plugs || []) {
    if (!b.pod) continue;
    const prod = products.find((p) => p.asin === b.product?.asin);
    fill[b.product.asin] = podFill(b.pod.tweets, prod?.link || '{{LINK}}');
    pasted.push({ id: b.pod.id, asin: b.product.asin, count: b.pod.tweets.length });
  }
  const res = splicePlugMarkers(writerTweets, fill);
  // Numbered listicles absorb the pods as numbered members (operator 2026-08-23) — except in a
  // roundup, where the pod elaborates the item above it rather than adding one.
  const heads = (outline?.shape === 'roundup') ? [] : res.spliced
    .map((sp) => ({ sp, blk: (outline?.plugs || []).find((b) => b.product?.asin === sp.asin && b.pod) }))
    // A CTA-only hijack paste stands inside the donor's own item — numbering the lone ask as a new
    // list member would break the list it hijacked.
    .filter((x) => x.blk && !x.blk.pod.ctaOnly)
    .map((x) => ({ at: x.sp.at, frame: x.blk.pod.frame }));
  const numbered = numberPastedPods(res.tweets, heads);
  // A 2-tweet pod's run-up guarantee belongs to the HOST (requiresHostMention). The engine's writer
  // is instructed to land the prior tweet on the substance; an offline assembly has no writer, so
  // surface the miss instead of shipping it silently — this is exactly the "stairs to CoQ10" gap.
  const warnings = [];
  for (const sp of res.spliced) {
    const blk = (outline?.plugs || []).find((b) => b.product?.asin === sp.asin && b.pod);
    if (!blk?.pod?.requiresHostMention && !blk?.pod?.twoTweet) continue;
    const prior = String(numbered.tweets[sp.at - 2] || '').toLowerCase();
    const sub = String((blk?.pod && (PODS_SUBSTANCE.get(blk.pod.id) || '')) || '').toLowerCase();
    if (sub && !prior.includes(sub)) warnings.push(`${blk.pod.id}: 2-tweet pod but the HOST tweet before it never names "${sub}" — the writer owes that mention (requiresHostMention)`);
  }
  return { tweets: numbered.tweets, pasted, spliced: res.spliced, missing: res.missing, numberedPods: numbered.added, warnings };
}

// SKELETON-VARIATION generation: reuse the source thread's proven FORM (its extracted skeleton) but write
// a BRAND-NEW thread on a product-fit topic whose every claim comes from real on-topic FACT-POOL threads.
// Returns [staticPart, variablePart] like buildPrompt so the account-static block is prompt-cached per slot.
// THE HOOK RULE: line 1 is a ~95% STRUCTURAL clone of the skeleton's opener (backbone kept, key info
// swapped); everything after keeps the shape but is freely reworded from new, sourced substance. The
// similarity is STRUCTURAL only — checks.mjs sharedNgramIssue guarantees no verbatim run survives.
export function buildSkeletonPrompt(skeleton, topic, factPool, account, srcTweets = [], hookBank = [], { hookFreedom = false } = {}) {
  const n = skeleton.itemCount || 0;
  // PRINCIPLED REMIX (operator rule 2026-07-22): a structure's FIRST use holds the strict ~95%
  // structural hook clone — proof the form works as extracted. On REUSE (fleet-wide, tracked in the
  // structure×topic grid) the hook gets freedom: new framing, new key information, even a new angle —
  // as long as the skeleton's FOUNDATIONAL PRINCIPLES and shape metrics hold. This is what lets one
  // proven structure serve 20 pages without 20 same-mold hooks aging into a detectable pattern.
  const freedom = !!(hookFreedom && skeleton.principles);
  // FEW-SHOT WINNER HOOKS (audit #8, operator 2026-07-21: "use more few shot prompting — give it more
  // context"): show the model real >=500k-view hooks from the bank so the generated hook FEELS like a
  // winner while still filling the donor's mold. Style calibration only — copying is blocked by the
  // sharedNgramIssue gate and the bank dupRisk check. Run-constant, so it lives in the cached static part.
  const bankBlock = hookBank.length
    ? `\n\n== PROVEN WINNER HOOKS (few-shot style calibration — every one opened a 500k+-view thread. Study their bluntness, rhythm, concreteness, and stakes so YOUR hook feels like it belongs among them. NEVER copy their words or subjects — your hook fills the donor's mold on the NEW topic.) ==\n${hookBank.slice(0, 10).map((h) => `---\n${String(h.h || '').split('\n').slice(0, 3).join('\n')}`).join('\n')}`
    : '';
  // Form-neutral (2026-07-20): the old "the hook holds '1.'" wording was a faithful-mode legacy that
  // misled quote-form donors (item-NAME tweets + elaboration tweets) into numbering BOTH — 6 markers
  // for 4 items, two blocked rolls in a row on the same donor.
  const countRule = n >= 3
    ? `\nITEM COUNT (hard): write EXACTLY ${n} numbered items as ONE continuous sequence 1..${n}. Number ONLY the ${n} items themselves — an item's marker line begins its own tweet, an item's elaboration or continuation tweet is NEVER numbered, and no number ever repeats. Never drop, merge, split, skip, or renumber.`
    : '';
  const staticPart = `You are the ghostwriter for @${account.handle} (${account.name}), a health page on X. Write a BRAND-NEW thread that reuses a PROVEN viral thread's SHAPE (its skeleton) but on a DIFFERENT topic with ENTIRELY NEW substance. Output ONLY the hook and the body tweets — plugs, sign-off, and disclaimer are inserted programmatically afterwards.
${voiceSection(account)}
== THE METHOD (keep the FORM, replace the CONTENT — ONE source drives the WHOLE shape, hook AND body) ==
${freedom
    ? `HOOK LINE 1 — PRINCIPLED REMIX: this structure has already proven itself, so you are NOT cloning its opening line — you are writing a FRESH opener that delivers the same FOUNDATIONAL PRINCIPLES (listed below) on the new topic. Free to change the framing, the key information, the comparison, even the angle. NOT free to break the principles, the rhythm class (same number of lines, similar punch and brevity — a character target is given below), or the promise shape. The reader of both hooks should FEEL the same pull without seeing the same sentence.`
    : `HOOK LINE 1 — ~95% STRUCTURAL CLONE: reproduce the skeleton's hookFirstLine template EXACTLY (same clause skeleton, rhythm, shock), filling each <SLOT> with the NEW topic's key information. Keep every connective/structural word; swap the load-bearing nouns, numbers, and verbs ONE-FOR-ONE — never add clauses, extra adjectives, or a second modifier where the source had one word. A one-for-one swap naturally MATCHES THE SOURCE LINE'S LENGTH (a character target is given below); side by side, the two lines must read as the same mold. Do NOT soften, lengthen, or hype it — this line is held tighter than anything else.`}
HOOK LINE 2 / PROMISE: follow the skeleton's promise shape, adapted to the new topic (e.g. "N signs ...:").
NAME THE OUTCOME, DO NOT FILM IT (hard — operator 2026-09-19): "avoid metaphorical visual writing. What we want is the doctor-diagnosis type — specific, concise, naming the problem, the benefit and the solution clearly." Whatever the promise resolves to must be a NOUN: the thing the reader wants, stated. NEVER a scene they have to picture and decode back into it. Write "the 8 things that decide your strength and independence after 50", NOT "...that decide whether you keep your muscle after 50"; "your cellular energy and happiness", NOT "whether you need a coffee to finish the day"; "your quality of life", NOT "how well you age". THE TEST, and it settles every case: the promise has to follow "I want ___". "I want my strength and independence after 50" reads. "I want whether I keep my muscle" and "I want how well you age" do not. In practice this means the promise NEVER opens with whether, if, how, why, what, who, where or when — each of those starts a clause, and a clause is a little film. This applies to the SLOT YOU FILL, not to the structural words around it: keep the skeleton's clause shape exactly as the rule above requires, and fill it with a noun. A second clause bolted on to carry more information is not more information, it is fluff — cut it. checks.mjs hookClauseIssue reports this and pot-echo prints it, so this prompt and the gate cannot drift apart.
BODY — THE SOURCE'S FORM IS LAW: a listicle source produces a listicle (exactly its item count, each item in its item shape, ordered by its escalation); a NARRATIVE source produces a narrative (same beat sequence, same pacing, NO invented numbering). Never convert one form into the other. Always in the skeleton's style (sentence rhythm, person, line breaks).
STRUCTURE (hard): the hook, EACH item or beat, and the closer are SEPARATE array elements — one per tweet. An item's number line ("1.", "2.", ...) begins its own element (UNLESS the TWEET 1 GROUPING rule below tells you the donor packs the first item's marker line into the hook tweet — then follow that rule for the first item only). Never merge two items, or an item and the closer, into a single tweet. If the skeleton has a closer, it is the FINAL separate element AFTER the last item/beat. EVERY element must be under 280 characters on its own; if one runs long, tighten it — never fold it into another tweet.
SUBSTANCE RULE (hard): EVERY factual claim, symptom, mechanism, and number in the body MUST come from the FACT POOL threads below — real, proven, on-topic threads. NEVER invent a claim, a statistic, or a number; if the fact pool doesn't support an item, use a different fact it does support. Do NOT copy any fact-pool or skeleton sentence verbatim — rephrase in ${account.name}'s voice, with NO run of 7+ words shared with any source.
SAFETY (health claims): supportive, hedged language only (supports, may help, is linked to). NEVER claim a product or habit cures, treats, prevents, or reverses a disease, and never name a disease as a promise.
STYLE: no em dashes; no hype words; one blank line between separate lines inside a tweet, but NEVER split a single sentence across two lines (a line ends only at a sentence end, a colon, or a list item), and NO blank line between consecutive "- " sub-list items (bullets sit on adjacent lines, directly under their label line); every tweet under 280 chars.
LENGTH TARGET: compose each tweet to land at or under ~238 characters, including its item number and any link. 280 is the hard ceiling, not the target — a tweet written to the cap leaves QC nothing to trim and reads dense. If a tweet would run past 238, shorten it rather than write to the limit.
RHYTHM (operator 2026-09-13, thresholds fixed 2026-09-15 against the finished remix): write it to be SKIMMED. NO SENTENCE OVER 17 WORDS \u2014 17 is the edge, not the target: aim for a median near 10 and VARY the lengths inside every tweet, because a 3-word line next to a 12-word line reads while five 11-word lines in a row is a wall with gaps in it. Staccato is allowed and is often the best close. THREE TO FOUR PARAGRAPHS per tweet, never more \u2014 a numbered listicle item is exempt, and a bullet block counts as one paragraph, the item's title line as one, the link line as one. A \u2022 BULLET ROW RUNS INLINE on one line (\u2022 Sardines \u2022 Organ meats \u2022 Peanuts), never one per line; this is separate from the \"- \" SUB-LIST SHAPE below, which keeps its own one-item-per-line form. The plug is NOT exempt: the first pot measured under these rules carried a 31-word sentence inside its own plug, the tweet the whole thread is built to reach. laws.json tweet.maxSentenceWords and tweet.maxParagraphs hold the numbers and checks.mjs rhythmIssues reports them, so this prompt and the gate cannot drift apart.
PLAIN TEXT (hard): X renders NO markdown — every markdown character ships to the reader as literal noise. Use no bold or italics (**, __, *, _), no backticks or code fences, no headers (#), no blockquotes (>), and no "*" bullets. Your structure toolkit: a plain "N." item marker, a blank line, ordinary punctuation, and — for SUB-LISTS inside a tweet — a plain "- " hyphen bullet. SUB-LIST SHAPE (operator 2026-08-11): when the source lists things under a label (a grocery list, a stack, steps), keep the label line ("Proteins:") DIRECTLY above its items, each item on its OWN "- " line, items on ADJACENT lines with NO blank line between them, and NEVER merge two items onto one line. Mirror the source's list density — a tight bullet block must stay a tight bullet block, never bare lines spaced apart.
${operatorRules()}${bankBlock}`;
  // NARRATIVE sources (operator rule 2026-07-20): the body's form follows the SOURCE — a story/beat
  // thread must not be flattened into a numbered listicle just because listicles are the common case.
  const formRule = skeleton.format === 'narrative' && n < 3
    ? `\nFORM (hard): this source is a NARRATIVE, not a listicle — write ${skeleton.tweetCount ? `about ${skeleton.tweetCount}` : 'the same number of'} body tweets mirroring its beat sequence and pacing. Do NOT number the tweets, do NOT add "N ways/signs" framing, do NOT convert it into a list.`
    : '';
  // TWEET-1 GROUPING (operator rule 2026-07-20, LORWEN + Jake reviews): everything the donor packs
  // into its FIRST tweet (hook line + context + promise) stays ONE tweet in ours — the recurring
  // defect was fragmenting that block across tweets 1-3. checks.mjs hookBlockIssue is the gate;
  // this is the instruction that should make the gate never fire.
  const srcT1 = String((srcTweets || [])[0] || '');
  const t1Blocks = srcT1.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const t1Paras = t1Blocks.length;
  const t1Colon = /:\s*$/.test(srcT1.trim());
  // Does the donor pack its FIRST item's marker line into tweet 1 (hook line, then "1. <name>.")?
  const t1AttachesItem = t1Blocks.length >= 2 && !/^\d+[.)]\s/.test(t1Blocks[0]) && t1Blocks.slice(1).some((b) => /^\d+[.)]\s/.test(b));
  const groupRule = t1AttachesItem
    ? `\nTWEET 1 GROUPING (hard): the donor's first tweet is TWO blocks — the hook line, then a blank line, then the FIRST item's marker line ("1. <short item name>." — the NAME only, no elaboration). Your FIRST array element must do exactly the same: your hook line, a blank line, then "1. <your first item's short name>." Put that first item's ELABORATION in element 2 (unnumbered). Do NOT make the "1." line its own separate tweet, and do NOT fold the elaboration into tweet 1.`
    : srcT1
    ? `\nTWEET 1 GROUPING (hard): the donor's ENTIRE first tweet — ${t1Paras} paragraph block(s), ~${srcT1.length} chars${t1Colon ? ', ending with ":"' : ''} — is ONE single tweet. Your FIRST array element must mirror that grouping exactly: hook line, context, and promise together in ONE element with a blank line between blocks${t1Colon ? ', ending with the promise line and its ":"' : ''}. NEVER spread the donor's tweet-1 content across your elements 2-3, your element 2 is already the first body ${n >= 3 ? 'item' : 'beat'}.`
    : '';
  // ITEM CATEGORY (operator rule 2026-07-20, Austin-donor review): a stack thread's category IS its
  // form — a "supplements you need" donor varies into a DIFFERENT-supplements thread, never a habits
  // thread. The hook keeps the category word; the members change with the topic.
  const catRule = skeleton.itemCategory
    ? `\nITEM CATEGORY (hard): the donor's body items are all ${skeleton.itemCategory} — every one of YOUR items must ALSO be a ${skeleton.itemCategory.replace(/s$/, '')} (a DIFFERENT one, chosen for the NEW topic from the fact pool — never the donor's own), and the hook keeps the donor's category word "${skeleton.itemCategory}" verbatim. Do NOT swap the category for habits/tips/signs.`
    : '';
  // PACKING RESTORED (operator 2026-08-11, reversing 2026-08-08 which reversed 2026-07-25): crammed
  // numbered listicles are a WINNING format on these pages — a packed donor is mirrored at its own
  // density. What stays banned is the Aug-8 breakage class: orphan bare markers, empty stub items,
  // inconsistent splits. checks-side, recreate re-packs deterministically after generation.
  const perTweet = Math.max(2, Math.round(skeleton.avgItemsPerTweet || 0));
  const packRule = skeleton.packed
    ? `\nPACKING (hard — OVERRIDES the "one item per tweet" STRUCTURE rule above): the donor packs about ${perTweet} short items into EACH tweet (~${skeleton.bodyItemTweets} body tweets hold all ${n} items) — every item ONE punchy line. Mirror that: after the hook, each array element holds ~${perTweet} CONSECUTIVE numbered items on ADJACENT lines (single line break between, NEVER a blank line), under 280 chars per element. Every item line must carry real content — never a bare dangling number, never an empty stub.`
    : '';
  const variablePart = `${countRule}${formRule}${groupRule}${catRule}${packRule}
== THE INSPIRATION THREAD (few-shot FORM example — this is the viral donor your thread must feel like) ==
Study its hook shape, pacing, item rhythm, line breaks, and closer. Your thread mirrors this FORM on the NEW TOPIC below. Its topic is NOT yours: NEVER reuse its subject nouns, claims, or numbers, and NEVER share a run of 7 or more consecutive words with it (a deterministic gate rejects the draft if you do).
${(srcTweets || []).map((t, i) => `[${i === 0 ? 'HOOK' : 'tweet ' + (i + 1)}]\n${t}`).join('\n\n')}

== SKELETON (the FORM to reuse — shape ONLY, never the new content) ==
${skeleton.principles ? `FOUNDATIONAL PRINCIPLES (preserve these above all): ${skeleton.principles}\n` : ''}hookFirstLine ${freedom ? '(reference mold — REMIX it per the hook rule above, do not clone)' : '(fill the <SLOTS>, ~95% structural clone)'}: ${skeleton.hookFirstLine}${skeleton.hookLine1Len ? `\nhook line 1 target length: about ${skeleton.hookLine1Len} characters (stay within ±20%)` : ''}
promise / line 2 shape: ${skeleton.hookPattern || '(single-line hook)'}
one body item looks like: ${skeleton.packed ? 'a number, then a full-sentence tip with ONE short elaboration line beneath it — its OWN tweet, never packed (see DENSITY above)' : skeleton.itemShape}
ordering / escalation: ${skeleton.escalation}
closer shape: ${skeleton.closerShape}
style notes: ${skeleton.styleNotes}
format: ${skeleton.format}, ${n} items

== NEW TOPIC (what to write about) ==
${topic}

== FACT POOL (every body claim MUST come from these real on-topic threads — rephrase, never copy) ==
${factPool.map((f, i) => `--- fact thread ${i + 1} (${f.url || f.recId}) ---\n${f.tweets.join('\n')}`).join('\n\n')}

Return ONLY a JSON array of strings — the hook first, then the body tweets in posting order, one element per tweet. Do NOT include plugs, ads, a sign-off, or a disclaimer. No commentary.`;
  return [staticPart, variablePart];
}

// The two affiliate plugs, written in their OWN small call: each gets its product + the exact prior
// tweet it must bridge from. All the plug-craft rules live here (moved verbatim from the old
// single-pass prompt), so the main generation never has to interleave ads with a numbered list.
// Static block is account-constant -> prompt-cached across the account's whole batch.
// THE WHOLE THREAD (operator 2026-08-16). Until now the plug call saw ONLY the single tweet before
// each plug, so it was being asked to match a recommendation to content it could not read. That is
// the root cause of the LAW 14 failures: a plug landed after an item teaching a DIFFERENT substance
// because the writer had no way to know the right item existed three tweets further down. Pure and
// exported so the rendering is unit-tested rather than trapped inside an LLM caller.
// Truncated PER TWEET, never per thread, so a long thread still arrives whole instead of cut in half.
export function threadContextBlock(thread, heavyPrev, lightPrev) {
  if (!Array.isArray(thread) || !thread.length) return '';
  const mark = (t) => `${t === heavyPrev ? ' <- HEAVY plug goes AFTER this' : ''}${t === lightPrev ? ' <- LIGHT plug goes AFTER this' : ''}`;
  const lines = thread.map((t, i) => `[${i + 1}]${mark(t)} ${String(t).replace(/\s+/g, ' ').slice(0, 220)}`);
  return `== THE WHOLE THREAD (read it before writing; the plug must answer what THIS thread teaches) ==
${lines.join('\n')}
LAW 14: a plug must answer the item DIRECTLY above it. If the tweet above yours teaches a different substance than the product you are given, say so in your response instead of writing a plug that does not fit.

`;
}

// writeBridgePriors — the BRIDGE PASS (operator law 2026-08-17): before any plug is written, each
// prior tweet is rewritten so its final beat lands on the plug's substance. A SEPARATE small call
// on purpose: the fused contract (writePlugs also returning rewritten priors) shipped a prior and
// its plug MERGED into one 551-char tweet on the weaker generation model (run 4, 2026-08-17) —
// one call, one job. The substance words handed to the model are the EXACT terms
// plugSubstanceBridgeIssue gates on, so prompt and gate can never disagree.
export async function writeBridgePriors(env, account, { heavy, light }) {
  const item = (label, x) => {
    const terms = substanceTermsFor(x.product);
    return `${label} TWEET (rewrite its ending):\n${x.prior}\n${label} SUBSTANCE WORDS (the final beat must contain at least ONE of these VERBATIM): ${terms.length ? terms.join(', ') : shortName(x.product.title)}`;
  };
  const prompt = `You edit two tweets from a health thread by @${account.handle} (${account.name}). Each is the ITEM that sits right before an affiliate plug. Rewrite each so its FINAL one or two lines land on the named substance as the item's own natural conclusion — the gap, the depletion, or the mechanism that makes the substance the reader's next thought. (Example: an exercise item ends "...The catch: training also burns through magnesium, and low magnesium keeps muscles tight and sleep shallow.")
RULES:
- Keep the tweet's leading number marker, subject, facts, list lines and voice EXACTLY as given; touch ONLY the ending (add or reshape at most two short lines).
- The final beat MUST contain one of the given SUBSTANCE WORDS verbatim. Never a brand name.
- Each tweet stays UNDER 260 characters. No em dashes. Keep the tweet's existing line rhythm (blank line between thoughts).
- If a tweet's ending ALREADY names the substance, return it unchanged.

${item('HEAVY', heavy)}

${item('LIGHT', light)}

Return ONLY JSON: {"heavy": "<full rewritten HEAVY tweet>", "light": "<full rewritten LIGHT tweet>"}. No commentary.`;
  // pinNative: LLM_MODEL routes EVERY role (aux included) to the gateway model, which ignored the
  // verbatim-substance constraint on three consecutive live runs (4-6, 2026-08-17). This one call's
  // correctness IS instruction-following, so it pins to native Claude; ~$0.003/thread.
  // Opus 5 (operator 2026-08-17): sonnet-4-6 on the native lane STILL dropped the required word.
  // This is the highest-leverage sentence in the whole thread — the bridge that makes the plug land —
  // so it gets the strongest model. One small call per thread; BRIDGE_MODEL overrides.
  const out = await anthropic(env, { role: 'aux', model: process.env.BRIDGE_MODEL || STRONG_MODEL, max_tokens: 800, pinNative: true, messages: [{ role: 'user', content: prompt }] });
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('bridge priors: no JSON in response');
  const j = JSON.parse(m[0]);
  if (typeof j.heavy !== 'string' || typeof j.light !== 'string') throw new Error('bridge priors: malformed response');
  return j;
}

/**
 * rewriteHook — one tiny call that rewrites ONLY tweet 1 when the writer's hook came back too close
 * to the donor (operator ruling 2026-08-23: the slot must survive, the body and any pasted pods are
 * untouched). The caller verifies the result MECHANICALLY with hookFidelityIssue before accepting —
 * this function only proposes.
 */
export async function rewriteHook(env, account, donorHook, currentHook, { attempt = 1 } = {}) {
  const prompt = `You rewrite the FIRST TWEET of a health thread by @${account.handle} (${account.name}). The current hook is too close to the source tweet and would trip duplicate-content matching.

SOURCE HOOK (do NOT copy its sentences):
${donorHook}

CURRENT HOOK (too similar — rewrite it):
${currentHook}

RULES:
- Keep the same PROMISE, the same numbers (a count like "5 fixes" stays 5), and the same list teaser if one exists (e.g. a trailing "1. <item>" line stays, reworded only lightly).
- Rewrite EVERY sentence in your own words — reorder, reframe, change the phrasing inside each sentence. Shared short words are fine; shared word-for-word runs are not.${attempt > 1 ? '\n- Your previous attempt was STILL too similar. Diverge harder: change sentence order and sentence shapes, not just words.' : ''}
- Same energy and voice, no em dashes, under 270 characters, keep the blank-line rhythm.

Return ONLY the rewritten hook text. No commentary, no quotes.`;
  // Pinned native for the same reason as harvestHook below: this is the OTHER half of the same band.
  const out = await anthropic(env, { role: 'aux', model: process.env.HOOK_MODEL || STRONG_MODEL, pinNative: true, max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  return String(out || '').trim().replace(/^"|"$/g, '');
}

/**
 * harvestHook — a NEW hook for a proven body, landing INSIDE the fidelity band.
 *
 * The harvest lane used to call rewriteHook for this, and rewriteHook exists for the OPPOSITE
 * problem: it is the tool for a hook that came back TOO CLOSE to the donor, so its prompt says "do
 * NOT copy its sentences", "rewrite EVERY sentence in your own words", and on a retry "diverge
 * harder". harvest-build passed the parent hook as both the source AND the too-similar current
 * hook, then escalated attempt 1, 2, 3 — asking for maximum divergence three times over, while the
 * gate requires 72-93% similarity. The three candidates came back at 34% and 46% and the lane threw
 * "no hook passed fidelity" every run. The generator was doing exactly what it was told.
 *
 * So the harvest lane gets its own prompt, pointed the right way: same shape, same promise, same
 * numbers, paraphrased INSIDE each sentence, aiming at the band's middle. The `variant` index makes
 * the three candidates differ from each OTHER without any of them drifting from the parent.
 */
export async function harvestHook(env, account, parentHook, { variant = 1, band = [0.72, 0.93], feedback = null, tooFar = null } = {}) {
  // THE ANGLE IS FOR FRESH CANDIDATES ONLY, NEVER FOR A REPAIR (2026-08-28, Kim's live slot).
  // The three angles exist to make three fresh candidates differ from EACH OTHER. On a correction
  // pass they fight the correction: "lead with the cost of ignoring it" is an instruction to depart
  // from the parent, handed to a call whose whole job is to move back toward it. Kim's repair went
  // 38% -> 16%, further out than it started, and the second attempt came back empty. On a repair the
  // only instruction is the correction.
  const angle = (feedback || tooFar)
    ? 'Change as little as you can while still landing inside the band.'
    : [
        'Lead with the same promise, phrased as plainly as you can.',
        'Lead with the cost of ignoring it, keeping every number and the same promise.',
        'Lead with who it is for, keeping every number and the same promise.',
      ][(variant - 1) % 3];
  // CLOSED LOOP, BOTH DIRECTIONS (2026-08-28). Three open-loop candidates are three samples of the
  // same bias: the first live run landed 66%, 64%, 61% against a 72% floor, all three under, because
  // "aim near 82%" is not a number the model can measure itself against. Handing back the MEASURED
  // score turns the next call into a correction rather than another sample.
  //
  // The first cut of this only knew "too far", and it overshot: the seventh live run corrected 67%
  // straight past the 93% ceiling to 96%, and two harvest slots threw at 95% and 96% with no repair
  // attempted at all because the loop only looked downward. A band has two edges. The correction now
  // names the measured value and BOTH bounds every time, and says which way to move.
  const fb = feedback || tooFar;   // tooFar is the older one-directional name, kept for callers
  const lo = Math.round(band[0] * 100), hi = Math.round(band[1] * 100);
  const correction = fb ? (() => {
    const got = Math.round((fb.sim ?? 0) * 100);
    const under = (fb.sim ?? 0) < band[0];
    const move = under
      ? `You rewrote TOO MUCH. Keep MORE of the parent's exact words: keep its nouns, its numbers, its verbs and its sentence openings, and change only the connecting words plus one content word per sentence.`
      : `You kept TOO MUCH. It is close enough that X can match it as a duplicate string. Change two or three more content words per sentence, using ${account.name}'s own phrasing, WITHOUT touching the numbers, the promise or the sentence order.`;
    // AND THE WHOLE-HOOK RATIO IS NOT THE ONLY WAY TO FAIL (2026-08-28, eighth run). The last two
    // failures both sat INSIDE the band and died on shape: "sentence 1 is 75 chars vs the donor's 49"
    // and "sentence 1 is untouched". A percentage cannot tell the model either of those, so the
    // gate's own message goes in verbatim — it already names the sentence and the exact miss.
    const shape = fb.issue && !/^hook is /.test(fb.issue) ? `
THE GATE'S EXACT COMPLAINT WAS: ${fb.issue}
Fix THAT specific sentence and leave the others as they are.` : '';
    const ratio = Number.isFinite(fb.sim) ? `
YOUR LAST ATTEMPT SCORED ${got}% AND WAS REJECTED. The band is ${lo}% to ${hi}% and you must land INSIDE it.
${move}
Do not overshoot the other way: below ${lo}% is a different hook, above ${hi}% is a copy. Aim for the middle.` : '';
    return `
YOUR LAST ATTEMPT WAS REJECTED.
${fb.hook ? `It was:\n${fb.hook}\n` : ''}${shape}${ratio}
`;
  })() : '';
  const prompt = `You write the FIRST TWEET of a health thread by @${account.handle} (${account.name}). The body below already went viral under this hook. You are writing a FRESH hook for the same body.

PARENT HOOK:
${parentHook}

This is NOT a rewrite-to-diverge job. The hook is the proven asset and it must stay recognisably the same hook.

RULES:
- Keep the SAME number of sentences, in the SAME order, each WITHIN 25% of the length of the parent's
  corresponding sentence (the parent's sentences run ${parentHook.split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean).map((x) => x.length).join(', ')} characters).
- Keep the SAME promise, the SAME frame, and EVERY number exactly (a count like "7 signs" stays 7).
- PARAPHRASE INSIDE each sentence in ${account.name}'s phrasing. Change something in EVERY sentence — do not leave one verbatim and rewrite another past recognition.
- Target ${Math.round(band[0] * 100)}-${Math.round(band[1] * 100)}% of the parent's wording, aiming near ${Math.round(((band[0] + band[1]) / 2) * 100)}%. Recognisably the same hook, not the same sentence.
- ${angle}
- If the parent ends with a trailing "1. <item>" line, keep that line in the same shape.
- No em dashes, under 270 characters, keep the blank-line rhythm.
${correction}
Return ONLY the hook text. No commentary, no quotes.`;
  // PINNED NATIVE, same reasoning as writeBridgePriors above (2026-08-28, eighth live run).
  // LLM_MODEL routes EVERY role — 'aux' included — to the gateway model, and the job here is to land
  // a Dice score INSIDE a 21-point band. A cheap model cannot aim: the live log shows it answering a
  // "you are at 63%, the band is 72-93%" correction with 98%, then 96%, at $0.0001 a call. It is not
  // ignoring the feedback, it is flipping between copying and rewriting because it has no fine
  // control in between. That is exactly the failure the bridge-prior call already had to pin away
  // from, and this is the only other prompt in the file whose correctness IS the precision.
  const out = await anthropic(env, { role: 'aux', model: process.env.HOOK_MODEL || STRONG_MODEL, pinNative: true, max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  return String(out || '').trim().replace(/^"|"$/g, '');
}

export async function writePlugs(env, account, heavy, light, twoProducts, heavyPrev, lightPrev, style, { avoidEcho = '', avoidMoves = [], thread = [] } = {}) {
  const heavyShort = shortName(heavy.title || '');
  const lightShort = shortName(light.title || '');
  // Style resolution: an explicit per-call style (recreate's CTA split test) wins, then the account's
  // pinned plugStyle (ebook pages), then classic.
  //   'narrative' — own-product story arc (ebook test 2026-08-08): CTA "Get it here:", no affiliate
  //     disclosure (first-party product).
  //   'dm' — DM-preempt split-test style (operator 2026-08-08, REWRITTEN to the operator's own two
  //     structures 2026-08-12): the creator answering the question the DMs keep asking. TWO beats +
  //     CTA "Get it here (aff link):" (disclosure inline, so the affiliate gates hold; ", Made in
  //     USA" only when the title literally says so). The heavy anchors the ask to the THREAD'S TOPIC
  //     ("Every time I post about {topic}, the DMs ask the same thing"), the light is forward-looking
  //     ("Since I know the DMs are coming"). Gone from the old wording: "premium", "makes a
  //     difference", and the 17-word run-up before line 1 says anything.
  //     NOTE — a beat here may be TWO short sentences ("I've tried so many. This is the one I stayed
  //     on and trust."). That is the operator's shape, and it survives the pipeline because plugs are
  //     excluded from respaceWall/splitLongTweet and normalizePlugStructure only expands single \n
  //     into blank lines; it never sentence-splits within a beat. plugStructure counts BEATS, not
  //     sentences, so two sentences on one line stay one slot.
  // The bridge rule (tie into the prior tweet) is IDENTICAL in every style — that's what makes the
  // plug feel native to whatever thread it lands in.
  const styleKey = style || account.plugStyle || 'classic';
  const narrative = styleKey === 'narrative';
  const dm = styleKey === 'dm';
  //   'payoff' — the June-winner personal recommendation (operator 2026-08-15). The four
  //     highest-CVR posts ever (8.8% pooled vs classic's 2.8%) all plugged with a bespoke,
  //     thread-personalized testimonial: a PAYOFF line that lands the argument the prior tweet
  //     just made, a first-person SWITCH story naming the exact form, then a first-person
  //     recommendation line ("This is the magnesium I use:") — CTA law 2026-08-19. Adjacency data
  //     backs the same mechanic: a plug whose prior tweet sets up the substance converts 2x a
  //     cold pivot. NOTHING here is a fixed sentence template — the judge enforces shape, and
  //     the wording must be composed fresh from THIS thread's own words every time.
  const payoff = styleKey === 'payoff';
  //   'lean' — the trimmed arm (operator 2026-08-12). Two lines instead of three, ONE benefit
  //     instead of a benefit triple, and a light plug that reads as a CALLBACK rather than a second
  //     pitch. (The old rationale here called the "Research links X to A, B and C" triple the most
  //     ad-shaped sentence we write; the operator lifted that ban on 2026-08-26 — the defect was
  //     benefits that were never tied to the thread, not the sentence itself.) It reuses the
  //     DM style's "Get it here (aff link):" CTA deliberately: plugStructure already accepts a 2-3
  //     line plug behind that marker, so the shape needs no validator changes and no signal is lost.
  //     Rationale: the live split test has the LEANEST style ahead on clicks (dm 504 · classic 470 ·
  //     narrative 340), so trimming is the hypothesis worth measuring, not guessing at.
  const lean = styleKey === 'lean';
  const usa = (t) => (/made in (the )?usa/i.test(t || '') ? ', Made in USA' : '');
  const dmCta = (t) => `Get it here${usa(t) ? ` (${usa(t).replace(/^, /, '')})` : ''}:`;
  // LEAN CTAs (operator 2026-08-12, from two hand-written examples). The operator's originals read
  // "Get it here:" and "Check it out now (thank me later)👇" — neither carries a disclosure, and a
  // Levanta link without one fails plugStructure AND is an FTC problem, so the disclosure is folded
  // into the CTA line the same way the DM style does it. Heavy and light deliberately use DIFFERENT
  // CTA lines: the two plugs sit a few tweets apart and an identical closing line is precisely what
  // makes a thread read as an ad break.
  const leanCtaHeavy = (t) => `This is the one I use${usa(t) ? `, ${usa(t).replace(/^, /, '')}` : ''}:`;
  const leanCtaLight = (t) => `I keep this one on repeat${usa(t) ? `, ${usa(t).replace(/^, /, '')}` : ''}:`;
  const firstName = String(account.name || '').split(' ')[0] || account.name;
  const staticPart = payoff
    ? `You write the two affiliate plug tweets for @${account.handle} (${account.name}), a health page on X, in the PAYOFF style: the plug is the CONCLUSION of the argument the thread is making, followed by a personal switch story. Each plug is spliced into an existing thread right AFTER a specific PRIOR TWEET (provided below) — it must read as that tweet's next beat, never as an ad break.
== PLUG FORMAT (both plugs; each plug's TEXT EXCLUDING the link URL must be UNDER 255 characters) ==
Exactly TWO beats + the CTA line, EACH ON ITS OWN LINE with a BLANK LINE between:
  (1) PAYOFF — one sentence that LANDS the prior tweet's point and names the substance as its answer. It must reuse at least one CONCRETE word from the PRIOR TWEET and be written fresh for THIS thread — never a stock opener. (The mold, from a real winner: prior tweet explains sympathetic overdrive -> "That sympathetic lock is exactly why cortisol spikes at 2am." Yours must come from YOUR prior tweet, not this example.)
      SEEDING (measured on every winner, 10 of 12 plugs): the concept this plug answers is PLANTED EARLIER, not introduced here. The hook itself usually carries it — "It starts with inflammation, insulin resistance, and low nitric oxide" seeds the omega-3 plug two tweets later; "TAKING MAGNESIUM CORRECTLY" seeds the magnesium plug. So the reader meets the plug already holding the question. Write the payoff line so it ANSWERS something the thread has been circling, and if the hook or an earlier tweet never named that concept, say so in your response rather than inventing the connection here.
  (2) SWITCH — say what you take and what changed, the way you would say it OUT LOUD to someone who asked. The shape is two plain sentences: "I take {form} for {how long / why}. Now {benefit}, {benefit}, and {benefit}." Worked example: "I've taken KSM-66 ashwagandha for three months. Now I fall asleep faster, my jaw doesn't clench at night, and I don't crash at 4pm." Sentence one names the EXACT FORM ("glycinate", "KSM-66", "triple-strength", "monohydrate") and how long you have been on it. Sentence two runs TWO OR THREE BENEFITS together in one list.
      SHORT AND FLAT BEATS CLEVER. Every benefit is a plain fact about a body that the reader could check against their own: "I fall asleep faster", "my nails don't split", "my hands stopped going cold", "I skip the 3pm coffee", "I lift more". If the reader has to interpret it, it is not a benefit yet — rewrite it.
        • NEVER a FIGURE OF SPEECH — "stairs stopped being a conversation with my knees", "the last reps stopped being negotiations", "hills stopped feeling like a wall", "warm-ups that feel like they belong to a younger body", "the fog lifted", "afternoons stopped falling apart". Say the literal thing instead: "stairs stopped hurting", "my last reps don't fail", "hills got easier", "I think clearly in the afternoon".
        • NEVER a NARRATOR line that announces a change without naming it — "the change was quiet", "the tell was my appetite", "what shifted was the evening", "the difference was hard to miss", "the change showed up in boring places".
        • NEVER WRITERLY FRAMING no one says out loud — "before I'd call it real", "what I noticed was", "where I noticed it was". Just say what happened.
      READ IT ALOUD. If it sounds like something you would text a friend who asked what you take, it passes. If it sounds composed, cut words until it does not.
      A RESEARCH ASSOCIATION IS ALLOWED where it is genuinely earned and properly tied ("Research links magnesium to calm, deeper sleep, and clearer mornings" — the shape both of our highest-converting measured plugs used). It is an ASSOCIATION, never a promise: links / ties / is linked to only. The personal frame is the default; reach for the research frame when the thread has been arguing the mechanism, not as a way to avoid saying what happened to you.
      HEDGED AND HONEST — NEVER "cures"/"treats"/"prevents"/"guarantees"/"eliminates", NO disease names, no invented numbers, never an attribute the product's own title below does not state.
      ONE HONEST LIMIT EARNS THE REST. A recommendation where nothing cost anything reads as an ad. When it is true, say plainly what it did NOT do or what is annoying about it — "It did nothing for my energy, but I fall asleep in ten minutes now and I don't wake at 3am", "They're big capsules". Never invent one.
  (3) CTA — one line ALONE that ENDS " (#ad):", then {LINK} on its own line. The disclosure rides on the CTA line itself (operator 2026-09-02: "#ad is same line as the last item") — one closer format across the whole system, the same one the hand-written pod library uses. NEVER put "#ad" on a line of its own, and never drop it: the disclosure is what makes this legal and it is what the deterministic gates look for. WRITE THE LINE FRESH FOR THIS THREAD, as a FIRST-PERSON RECOMMENDATION — an "I" plus a verb the reader can hear a person saying: "I use", "I take", "I keep", "I reorder", "I stuck with", "I swear by" (operator 2026-08-19: the line has to say what you DO with it, not that you own it — a possessive that never reaches a verb does not sound like a person recommending something). Past tense is fine, and so is one positive adverb ("I actually use", "I still reorder"). A NEGATED verb only works with a cessation verb — "the one I never skip" endorses, "the one I never use" rejects. Shapes that have converted, as INSPIRATION not templates: "This is the magnesium I use (#ad):" · "This is the exact one I buy (#ad):" · "I've taken this one for six months (#ad):" · "The one I actually keep by my bed (#ad):". Invent your own in the account's voice — a CTA that reads like a line this person would type beats a line they have typed before.
NO third beat: the plug is exactly two beats plus the CTA line, so a mechanism paragraph or a separate benefit block is an extra slot the shape does not have. Benefits belong INSIDE beat 2, in its own sentence.
NEVER begin a plug line with a list marker: no "1.", no bullet, no dash.
Refer to the product by its SHORT recognizable name or plain substance — NEVER the long full title.
STYLE: no em dashes; plain spoken; hedged; a person finishing their own argument, not a label.
THE TWO PLUGS MUST NOT MATCH — and the CTA lines especially. Different payoff concepts, different switch stories, and two CTA lines whose TAILS differ. (They share only the recommendation verb and the trailing " (#ad):"; everything else must differ — "This is the magnesium I use (#ad):" against "I've kept this creatine in the routine since spring (#ad):". Two CTAs that differ by one word are one template twice.) Measured 2026-08-15: the era that converted at 8.8-9.5% used 12 DISTINCT CTA lines across 15 plugs; the era that converted at 2.8% used 2 shapes across 16. Repetition is the tell that a page is running a template, and a reader who has seen your last five threads notices before you do.
== THE BRIDGE LIVES IN THE PRIOR TWEET (operator law 2026-08-17) ==
The PRIOR TWEETS below have ALREADY been rewritten (by a separate pass) so their final beat lands on the plug's substance. Your plug CONTINUES that landing — it answers the question the prior tweet just raised. It must NEVER re-introduce the substance cold, and it must NEVER restate the prior tweet's content; the reader has just read it.
== THE BRAND IS ALLOWED, JUST NOT THE OPENING WORDS (LAW 12c, operator revision 2026-08-17) ==
Naming the brand is FINE and often better — a specific name reads more honest than a coy "the one I use", and the reader is about to see it on the card anyway. Put it where a person would say it: in the middle beat, next to the form ("the Nutricost glycinate is the one I stayed on"), or in the CTA line. What still fails is OPENING on it: a plug whose first six words are the brand reads as a paid placement, not a recommendation. Open on the substance or the reader's question; name the brand once you are telling them what you actually take.
== ROTATE THE OPENER MOVE (LAW 12c) ==
The skeleton above is fixed. What must change every single time is the rhetorical MOVE the opener makes. Choose the move that genuinely fits THIS item — this is not a random pick, and a move that does not fit the content is worse than a repeat:
  • OBJECTION — the thing people wrongly believe about it. ("The hardest part was convincing them it isn't a gym drug.")
  • ADMISSION — a mistake you personally made for a long time. ("D3 on its own was the mistake I made for years.")
  • FAILURE-MODE — why people abandon it, which is never the benefit. ("People quit fish oil over the burps, not the benefits.")
  • PERSONAL-LIMIT — the thing you could not fix. ("My dad's sleep was the one thing I couldn't fix for him.")
  • FORM-DECLARATION — the form is the whole game. ("The right form is the whole game here.")
  • CONDITIONAL-USAGE — when you specifically reach for it. ("Threonate is the one I add when the work is more mental heavy.")
  • SOURCING-QUESTION — the question a convinced reader now has, asked and answered. ("So which nitric oxide formula actually works?" / "So where do you find a clean omega-3?") A strong fit when your rewritten PRIOR TWEET has just made the case for the substance — but it ROTATES like every other move: one option among seven, never the house shape. A fleet where every plug opens on the same question is a template, and the reader notices first.
The two plugs in this thread MUST use two DIFFERENT moves. Two openers that are lexically different but make the same move still read as a template. Beyond that, CHOOSE THE MOVE THAT ACTUALLY FITS THIS ITEM (operator 2026-08-17): fit beats novelty every time. The recent-moves list below is INFORMATION, not a ban — if the best move for this content is one you used two threads ago, use it and write it differently.
BANNED OPENERS: never open on a dose, count or percentage ("1,250mg per softgel", "360 capsules, 210mg per serving") — that is a product label, not a person. And never open by naming the brand, per the rule above.
The MIDDLE beat carries a TIME-STAMPED detail — "three months", "six weeks", "since spring", "every morning" — in its FIRST sentence, next to the form. A specific duration is what makes the benefits that follow read as something that happened to a person rather than a claim about a product.
The CTA line is SHORT and FIRST-PERSON, and it must carry a RECOMMENDATION VERB — "I use", "I take", "I buy", "I keep", "I reach for", "I swear by" (operator 2026-08-19: a possessive that never reaches a verb states ownership without recommending, and the whole job of the last line is to recommend). "This is the magnesium I use (#ad):" · "This is the creatine I buy, the micronized one (#ad):" · "I've taken this omega-3 for six months (#ad):". Naming the brand here is allowed. The DISCLOSURE IS INLINE: the line ends " (#ad):" and the link goes on its own line below. NEVER put "#ad" on a line of its own — cta-spec.md §6 works the three plug gates and shows the inline form is the only shape that satisfies all three at once, because a CTA that discloses inline IS the closing beat; stored bare it broke 34 of 36 plugs. There is no word count (LAW 4c): the length is whatever the line has to carry. Vary the tail between the two plugs so they do not read as one template twice.${avoidMoves.length ? `\n== MOVES THIS ACCOUNT USED RECENTLY (context, not a veto) ==\n${avoidMoves.join(', ')} — most recent first. A follower seeing five of your threads a week notices a repeated shape, so PREFER a move that is not on this list. But a move that genuinely fits the item beats a fresh move that does not: if the best fit is on the list, take it and make the wording clearly different.` : ''}
== HEAVY PLUG SHAPE (payoff + switch, personalized to the PRIOR TWEET; {substance} from the real title) ==
{payoff sentence landing the prior tweet's point, naming ${heavyShort || '{substance}'}}

{"I take {form} for {how long}. Now {benefit}, {benefit}, and {benefit}." — plain spoken, literal benefits, no figure of speech}

{a CTA line you write for THIS thread — first person, carrying a recommendation verb, disclosing INLINE and ending " (#ad):", e.g. This is the ${heavyShort || '{substance}'} I use (#ad):}

{LINK}
== LIGHT PLUG SHAPE (callback payoff + durability line; a DIFFERENT CTA line again) ==
{one sentence landing the LIGHT PRIOR TWEET's point, naming ${lightShort || '{substance}'}}

{the same plain shape again: what you take, how long, then two or three literal benefits — different benefits and a different opening from the heavy's}

{a different CTA line again — also a recommendation verb, but a DIFFERENT shape and tail from the heavy's, disclosing INLINE, e.g. This is the creatine I buy, the micronized one (#ad):}

{LINK}`
    : lean
    ? `You write the two affiliate plug tweets for @${account.handle} (${account.name}), a health page on X, in the LEAN style: a short, plain personal recommendation — the way someone answers "what do you actually use?". Each plug is spliced into an existing thread right AFTER a specific PRIOR TWEET (provided below).
== PLUG FORMAT (both plugs; each plug's TEXT EXCLUDING the link URL must be UNDER 255 characters) ==
Exactly TWO short lines + the CTA, EACH ON ITS OWN LINE with a BLANK LINE between:
  (1) THE PICK — one plain declarative sentence naming the product category and claiming it as YOURS. Shapes: "This is the {substance} I've trusted for years." / "This is the premium {substance} I found." / "This is the {substance} I keep going back to." Where the PRIOR TWEET names the same substance or symptom, reuse that word so the line follows on naturally. No mechanism, no research, no explanation — that is line 2's job.
  (2) WHY THIS ONE — one sentence, EITHER of these two moves, never both:
      • ATTRIBUTES: "It's USA made, third-party tested, and the one I genuinely trust." ONLY state attributes that the product's own title/description below actually contains. If the title does not say third-party tested, DO NOT write it. Inventing a certification is a false claim about a real product — pick the other move instead.
      • LIVED + SOCIAL: "I can't live without it, and neither can any friend I've recommended it to." First-person and specific; the proof is that you and people you know use it.
  (3) CTA — the exact line given in the shape below, ALONE on its own line, DISCLOSING INLINE so it ends " (#ad):", then {LINK} on its own line. NEVER drop the disclosure: it is what makes this legal and what the deterministic gates look for. NEVER put "#ad" on a line of its own (cta-spec.md §6).
NO third line. The shape is two lines plus the CTA, so a mechanism paragraph or a separate benefit block is an extra slot it does not have.
SAFETY: no disease names, no cure/treat/prevent claims. "I can't live without it" is fine (personal); "it fixed my thyroid" is not.
NEVER begin a plug line with a list marker: no "1.", no bullet, no dash.
Refer to the product by its SHORT recognizable name or plain substance — NEVER the long full title.
STYLE: no em dashes; plain spoken; sound like a person recommending something, not a label.
THE TWO PLUGS MUST NOT MATCH: the heavy uses the ATTRIBUTES move, the light uses the LIVED + SOCIAL move, and their closing lines differ. A reader meeting the second one should feel reminded, not sold to twice.
== HEAVY PLUG SHAPE (attributes move; adapt substance + attributes from the real title) ==
This is the ${heavyShort || '{substance}'} I've trusted for years.

It's third-party tested and the one I genuinely trust.

${leanCtaHeavy(heavy.title)}

{LINK}
== LIGHT PLUG SHAPE (lived + social move; different closing line) ==
This is the premium ${lightShort || '{substance}'} I found.

I can't live without it, and neither can any friend I've recommended it to.

${leanCtaLight(light.title)}

{LINK}`
    : dm
    ? `You write the two affiliate plug tweets for @${account.handle} (${account.name}), a health page on X, in the DM-PREEMPT style: the creator answering the question the audience keeps asking in the DMs. Each plug will be spliced into an existing thread right AFTER a specific PRIOR TWEET (provided below) — it must feel native to that exact spot.
== PLUG FORMAT (both plugs; each plug's TEXT EXCLUDING the link URL must be UNDER 255 characters) ==
Every plug is exactly TWO beats + the CTA, separated by a BLANK LINE. A beat may be ONE OR TWO short sentences (the shapes below use two) — what must NEVER happen is two BEATS run together on one line with no blank line between them:
  (1) THE ASK — beat 1 says the question keeps coming, and answers it by naming the product's SUBSTANCE. The two plugs open DIFFERENTLY:
      • HEAVY (topic-anchored): "Every time I post about {topic}, the DMs ask the same thing. It's this {substance}." {topic} is the PRIOR TWEET's plain subject in its OWN words (sleep, energy, bloating, stress) and is NEVER a disease name. If the prior tweet has no clean one-word subject, write "Every time I post about this, the DMs ask the same thing."
      • LIGHT (forward-looking): "Since I know the DMs are coming: this is the {substance} I've been using."
  (2) EARNED TRUST — beat 2 is first-person, lived and hedged. The two plugs use DIFFERENT moves:
      • HEAVY — the long search that ended: "I've tried so many. This is the one I stayed on and trust."
      • LIGHT — the money burned on cheap versions: "After burning money on the cheap ones, this is the one that stuck."
      NEVER an absolute ("the best", "#1", "the perfect one"), NEVER "cures"/"treats"/"prevents"/"guarantees", NO disease names, and NEVER an attribute or certification the product's own title below does not actually state.
  (3) CTA — "${dmCta(heavy.title)}" ALONE on its own line, DISCLOSING INLINE so it ends " (#ad):", then {LINK} on its own line. NEVER drop the disclosure: it is what makes this legal and what the deterministic gates look for. NEVER put "#ad" on a line of its own (cta-spec.md §6).
NO third beat: the shape is two beats plus the CTA, so a mechanism paragraph or a separate benefit block is an extra slot it does not have.
NEVER begin a plug line with a list marker: no "1.", no bullet, no dash.
Refer to the product by its SHORT recognizable name or plain substance — NEVER the long full title.
STYLE: no em dashes; plain spoken; hedged; sound like a person answering a question they get a lot, not a label.
THE TWO PLUGS MUST NOT MATCH: a different opener AND a different trust beat, exactly as the two shapes below split them. A reader meeting the second one should feel reminded, not sold to twice.
== HEAVY PLUG SHAPE (topic-anchored ask + the long search; adapt {topic} to the PRIOR TWEET) ==
Every time I post about {topic}, the DMs ask the same thing. It's this ${heavyShort || '{substance}'}.

I've tried so many. This is the one I stayed on and trust.

${dmCta(heavy.title)}

{LINK}
== LIGHT PLUG SHAPE (forward-looking ask + the money burned; different closing line) ==
Since I know the DMs are coming: this is the ${lightShort || '{substance}'} I've been using.

After burning money on the cheap ones, this is the one that stuck.

${dmCta(light.title)}

{LINK}`
    : narrative
    ? `You write the two product plug tweets for @${account.handle} (${account.name}), a health page on X, promoting OUR OWN digital product. Each plug will be spliced into an existing thread right AFTER a specific PRIOR TWEET (provided below) — line 1 must continue that prior tweet's idea.
== PLUG FORMAT (both plugs; each plug's TEXT EXCLUDING the link URL must be UNDER 255 characters — scannable, key point lands fast) ==
SCANNABILITY IS THE WHOLE POINT — every plug is exactly THREE short story beats + the CTA, EACH ON ITS OWN LINE with a BLANK LINE between, NEVER two sentences sharing a line:
  (1) STORY OPEN — line 1 begins "I used to ..." and describes the BEFORE state, continuing the PRIOR TWEET's idea by reusing at least one CONCRETE NOUN or symptom phrase from it VERBATIM (a "cold open" on a new topic is INVALID). One or two short sentences max.
  (2) THE TURN — line 2 begins "Then I ..." and names the concrete CHANGE that fixed it. Modest, specific, lived — claims stay associative and gentle, NEVER "cures", "treats", "prevents", "guarantees", and NO disease names, NO invented numbers or timeframes beyond vague ones (e.g. "in a couple weeks").
  (3) PAYOFF — line 3 is first-person, names {PRODUCT} ONCE by its short name, and ends on a colon ("Everything I changed is in {PRODUCT}:" / "{PRODUCT} is that plan:" / "The exact day I follow is mapped in {PRODUCT}:"). Never an absolute superlative ("the best plan ever", "#1").
  (4) "Get it here:" ALONE on its own minimal line, then {LINK} on its own line.
THE (1)-(4) LABELS ABOVE NAME THE LINES FOR YOU — they are NOT text to emit. NEVER begin a plug line with a list marker: no "1.", no "2)", no bullet, no dash. A plug is four plain prose lines.
The two plugs must NOT echo: a DIFFERENT before-state on line 1 AND a DIFFERENT payoff form on line 3 — two different small stories, not the same story twice.
STYLE: no em dashes; warm, honest, zero hype; never name a disease; sounds like a person talking, not an ad.
== HEAVY PLUG SHAPE (match exactly; adapt the story to the prior tweet) ==
${account.plugHeavyExample}
== LIGHT PLUG SHAPE ==
${account.plugLightExample}`
    : `You write the two affiliate plug tweets for @${account.handle} (${account.name}), a health page on X. Each plug will be spliced into an existing thread right AFTER a specific PRIOR TWEET (provided below) — line 1 must continue that prior tweet's idea.
== PLUG FORMAT (both plugs; each plug's TEXT EXCLUDING the link URL must be UNDER 255 characters — scannable, key point lands fast) ==
SCANNABILITY IS THE WHOLE POINT — every plug is exactly THREE short sentences + the disclosure, EACH ON ITS OWN LINE with a BLANK LINE between, NEVER two sentences sharing a line or two lines stacked with no blank line between:
  (1) BIG IDEA — line 1 is ONE short sentence that continues the idea of the PRIOR TWEET by reusing at least one CONCRETE NOUN or symptom phrase from it VERBATIM (a "cold open" that introduces a brand-new topic is INVALID) AND names the lead concept: the substance (e.g. magnesium) or the core symptom (e.g. cortisol).
  (2) EVIDENCE — line 2 is "Research links {substance} to {benefit}, {benefit}, and {benefit}." The verb is an ASSOCIATION (links / ties / is linked to) — NEVER "proves", "guarantees", "cures", "treats", or "prevents". The FIRST benefit MUST continue line 1's concept (line 1 cortisol -> line 2 opens "...to lower cortisol, ..."), so line 2 flows from line 1 instead of jumping. Benefits punchy and concrete, NO disease names.
  (3) SUPERLATIVE — line 3 is a first-person HEDGED superlative naming {PRODUCT} ONCE by its short name, ending on a colon: "{PRODUCT} is the best-absorbing one I've tried:" / "one of the best I've found:" / "the only one I trust now:". Stay hedged + first-person — NEVER an absolute ("the best magnesium", "#1", "nothing beats it").
  (4) The superlative line above carries the disclosure INLINE, ending " (#ad):", then {LINK} on its own line. NEVER put "#ad" on a line of its own (cta-spec.md §6).
THE (1)-(4) LABELS ABOVE NAME THE LINES FOR YOU — they are NOT text to emit. NEVER begin a plug line with a list marker of any kind: no "1.", no "2)", no "(3)", no bullet, no dash. A plug is four plain prose lines. A CTA that opens "1. Magnesium ..." is INVALID.
The two plugs must NOT echo: a DIFFERENT lead concept on line 1 AND a DIFFERENT superlative form on line 3.
Refer to each product by its SHORT recognizable name (brand + the 2-4 key words a buyer would actually say) — NEVER paste the long full title, a size/count, or a marketing tail.
STYLE: no em dashes; hedged supportive language only; never name a disease.
== HEAVY PLUG SHAPE (match exactly; adapt concept, evidence, and product) ==
${account.plugHeavyExample}
== LIGHT PLUG SHAPE ==
${account.plugLightExample}`;
  // The bridge rule and the prior tweet are both already in this prompt, yet 'cta:cold-open' still
  // recurs — the model loses the prior tweet's concrete noun across a long context by the time it writes
  // line 1 (IMPROVEMENTS 2026-08-05, QC final pass). So extract the anchor words DETERMINISTICALLY and
  // put them right next to the tweet, using the very tokenizer plugBridgeIssue checks against: the model
  // is handed the exact words the gate looks for instead of re-deriving them. Additive hint only — it
  // restates rule (1)'s existing "reuse a concrete noun VERBATIM", it does not add a constraint, and it
  // is omitted entirely when the prior tweet yields nothing concrete rather than misdirecting the model.
  // NOT implemented, deliberately: the item's "line 1 MUST BEGIN with exactly this word" — an exact-
  // prefix anchor is the strictness declined on 2026-07-31 (#1351) and again 2026-08-05, because a
  // legitimate bridge paraphrases ("cortisol" -> "that stress hormone") and need not lead on the noun.
  const anchorHint = (label, prev) => {
    const a = bridgeAnchors(prev);
    return a.length ? `\n${label} ANCHOR WORDS (line 1 must reuse at least ONE of these VERBATIM — this is what makes it a bridge, not a cold open): ${a.join(', ')}` : '';
  };
  const threadBlock = threadContextBlock(thread, heavyPrev, lightPrev);
  const variablePart = `${threadBlock}== THIS THREAD'S PLUGS ==
HEAVY plug product (short name to use): ${heavyShort}   [full title for context only, NEVER paste verbatim: ${heavy.title}]
HEAVY plug link (own line, verbatim): ${heavy.link}
HEAVY PRIOR TWEET (heavy line 1 continues THIS):
${heavyPrev}${anchorHint('HEAVY', heavyPrev)}

LIGHT plug product (short name to use): ${lightShort}   [full title for context only, NEVER paste verbatim: ${light.title}]
LIGHT plug link (own line, verbatim): ${light.link}
LIGHT PRIOR TWEET (light line 1 continues THIS):
${lightPrev}${anchorHint('LIGHT', lightPrev)}
${twoProducts ? '' : '\nBoth plugs promote the SAME product — still use a DIFFERENT lead concept and a DIFFERENT superlative form in each.'}${avoidEcho ? `\n\nREJECTED PREVIOUS ATTEMPT — ${avoidEcho}. The two plugs read as the same ad twice. Rewrite the LIGHT plug with a different opening idea AND a different closing phrase; do not reuse either mold.` : ''}
Return ONLY a JSON object: {"heavy": "<complete heavy plug tweet>", "light": "<complete light plug tweet>", "heavyMove": "<the opener move you chose>", "lightMove": "<the opener move you chose>"}. The two move values MUST differ, and each must be one of: objection, admission, failure-mode, personal-limit, form-declaration, conditional-usage, sourcing-question. Choose the move that genuinely FITS what its item teaches — a move that does not fit is worse than a repeat — each value is the full tweet text including its "${narrative ? 'Get it here:' : DISCLOSURE}" line and its link. No commentary.`;
  const content = [{ type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } }, { type: 'text', text: variablePart }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await anthropic(env, { role: 'generate', model: FLEET_MODEL, max_tokens: 1000, messages: [{ role: 'user', content }] });
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        if (typeof j.heavy === 'string' && typeof j.light === 'string') {
          // Hard guarantee: a plug without its tracked link is worthless — re-attach deterministically.
          const ctaLabel = narrative ? 'Get it here:' : lean ? leanCtaHeavy(heavy.title) : dm ? dmCta(heavy.title) : DISCLOSURE;
          if (!j.heavy.includes(heavy.link)) j.heavy += `\n\n${ctaLabel}\n\n${heavy.link}`;
          if (!j.light.includes(light.link)) j.light += `\n\n${narrative ? 'Get it here:' : lean ? leanCtaLight(light.title) : dm ? dmCta(light.title) : DISCLOSURE}\n\n${light.link}`;
          return j;
        }
      } catch {}
    }
    if (attempt === 2) throw new Error('writePlugs: no valid {heavy, light} JSON after 2 attempts');
  }
}

// Lightweight client recreation: a ~85% faithful variation of the viral source with the
// handle/attribution adapted to the client. No products, plugs, disclaimers, or sales layer.
export function buildPromptLite(srcTweets, src, account) {
  return `You are the ghostwriter for @${account.handle} (${account.name}) on X. Recreate the INSPIRATION THREAD below as a ~85% faithful variation: same structure, same beats, same numbering, substantially reworded (different sentence constructions and word choices, same meaning) so no run of 7 or more consecutive words matches the source. This is the client's own post — do NOT add affiliate links, product mentions, disclaimers, or any sales pitch.
${voiceSection(account)}
== INSPIRATION THREAD (source: ${src.url}, ${src.impressions.toLocaleString()} views) ==
${srcTweets.map((t, i) => `[${i === 0 ? 'HOOK' : 'tweet ' + (i + 1)}]\n${t}`).join('\n\n')}

== RULES ==
HOOK (tweet 1): same opening frame, shape, and character count as the source hook, with key phrasings/names swapped for fresh equivalents — same mold, different words. Keep the same first item. Any "N things" count must equal the number of body items.
BODY: recreate every tweet in the same order, very similar substance, lightly reworded, preserve any numbering ("2.", "3.", ...).
HANDLE: if the source names or @-mentions a creator as the author/owner, replace that handle with @${account.handle}. Leave unrelated @-mentions as-is.
NO monetization: no affiliate links, no products, no disclaimer.
${signOffOf(account) ? 'CLOSE: do NOT write a sign-off — it is appended automatically.' : 'CLOSE: end on the source\'s final beat (no added sign-off).'}
STYLE: no em dashes; one blank line between separate lines inside a tweet, but NEVER split a single sentence across two lines (a line ends only at a sentence end, a colon, or a list item), and NO blank line between consecutive list items (bullets sit on adjacent lines); every tweet under 280 characters.

Return ONLY a JSON array of strings, one element per tweet, in posting order. No commentary.`;
}

// Re-prompt over-budget tweets. Budget: plugs (link-bearing) <= 255 chars EXCLUDING the link;
// other tweets <= 280 (URL counted as 23). Preserves meaning, link, breaks, voice. Up to 2 passes.
export async function tightenLong(tweets, env, account) {
  for (let pass = 0; pass < 2; pass++) {
    const over = tweets.map((t, i) => [i, hasUrl(t)]).filter(([i, url]) => (url ? plugTextLen(tweets[i]) > PLUG_LIMIT : effLen(tweets[i]) > 280));
    if (!over.length) break;
    for (const [i, url] of over) {
      const link = (tweets[i].match(/https?:\/\/\S+/) || [''])[0];
      const instr = url
        ? `Shorten this X post so its TEXT EXCLUDING the link URL is UNDER ${PLUG_LIMIT} characters — punchy, key point first. Keep the URL verbatim, keep the "#ad" (or legacy "Aff link") disclosure line, keep ${account.name}'s personal first-person voice and the core reason. No em dashes. Return ONLY the rewritten post.`
        : `Shorten this X post to UNDER 280 characters (a URL counts as 23). Keep the meaning, ${account.name}'s calm voice, the line-break rhythm, any URL verbatim, and any leading item number (e.g. "7.") exactly. No em dashes. Return ONLY the rewritten post.`;
      const out = await anthropic(env, { role: 'generate', model: FLEET_MODEL, max_tokens: 600, messages: [{ role: 'user', content: `${instr}\n\n${tweets[i]}` }] });
      let fixed = out.trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim();
      if (link && !fixed.includes(link)) fixed += `\n\n${link}`;
      // Hard re-assert: if the rewrite dropped the disclosure a plug had, restore it inline.
      if (link && DISCLOSURE_LINE_RE.test(tweets[i]) && !isDisclosed(fixed)) fixed = fixed.replace(link, discloseBlock(link));
      // Hard re-assert: a rewrite must never eat a numbered item's marker (the 15/17 post-process
      // erosion the stress test caught) — re-prefix the original "N." if the rewrite dropped it.
      const mark = (tweets[i].match(/^(\d+)[.)]\s/) || [])[1];
      if (mark && !new RegExp(`^${mark}[.)]`).test(fixed)) fixed = `${mark}. ${fixed}`;
      if (url ? plugTextLen(fixed) <= PLUG_LIMIT : effLen(fixed) <= 280) tweets[i] = fixed;
    }
  }
  return tweets;
}
