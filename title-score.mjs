#!/usr/bin/env node
// title-score.mjs — the X Article TITLE TEMPLATE system (2026-09-02). One registry of title
// skeletons mined from the Articles corpus (n8n-x-pipeline → XDB base → Articles table, 167 viral
// articles from the 25-creator roster), and three things you can do with it:
//
//   node title-score.mjs "How the AI boom runs out of electricity this year" ["another title" …]
//       → which skeleton each candidate matches, a 0–10 score against the rules the corpus
//         rewards (frame, no proper noun, length, second person, case, time promise) minus the
//         house bans, and the skeleton's evidence band (median views among viral, top-decile rate).
//   node title-score.mjs --for Explainer        → the skeletons that fit an article type, with slots
//   node title-score.mjs --mine                 → recompute every skeleton's evidence from the live
//                                                 Articles table (paste into style/title-templates.md)
//
// The human-readable system (slot vocabularies, worked example, caveats) is
// style/title-templates.md. Keep the two in step: a skeleton lives here, its prose lives there.
// Evidence numbers below are the 2026-09-14 snapshot (n=190); --mine refreshes them as the daily scout
// grows the corpus. Caveat that never goes away: every row already cleared the viral floor, so a
// band says "among articles that went viral, this frame reached this far", not "this frame goes
// viral this often".
import { loadEnv, airtable } from './lib.mjs';

// ORDER MATTERS: a title is classified by its FIRST match, most specific skeleton first.
export const TEMPLATES = [
  { id: 'if-you', name: 'If you [condition], [consequence or command]', frame: 2,
    rx: /^if (you|we)\b/,
    fits: ['Explainer', 'Contrarian Thesis', 'How-To / System', 'Prediction'],
    slots: '[condition] a belief or situation the reader recognises in themselves; then EITHER a command ("do not waste the next 2-3 years", "read this") OR a consequence ("the next decade will confuse you", "you don\'t understand money").',
    evidence: { n: 5, med: 0.91, top: 20, bm: 4.1 },
    examples: ['If you have multiple interests, do not waste the next 2-3 years', 'If you don\'t understand AI by the end of this, the next decade will confuse you', 'If You Don\'t Understand the Petrodollar, You Don\'t Understand Money'] },
  { id: 'letter', name: 'I\'m [age]. If you\'re [audience], read this.', frame: 1,
    rx: /read this\.?$|^i'm \d+\b/,
    fits: ['Letter'],
    slots: '[age] a real number; [audience] an age band or a life stage the reader is in. Only for a letter-form piece; n=1 in the corpus, but the one is 25.8M.',
    evidence: { n: 1, med: 25.77, top: 100, bm: 3.0 },
    examples: ['I\'m 38. If You\'re in Your 20\'s or 30\'s, Read This.'] },
  { id: 'how-time', name: 'How to [outcome] in [timeframe]', frame: 2,
    rx: /^(full guide: )?how to .*\b(in|within|the next) (\d+|one|a|an) (day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|afternoon)\b/,
    fits: ['How-To / System', 'Framework', 'Tool Tutorial'],
    slots: '[outcome] a whole-life or whole-skill result ("fix your entire life", "master AI"); [timeframe] short and concrete (1 day, 30 days, 6 months). The bigger the outcome and the shorter the time, the stronger the title.',
    evidence: { n: 7, med: 1.21, top: 29, bm: 1.7 },
    examples: ['How to fix your entire life in 1 day', 'how to master AI in 30 days (the exact roadmap)', 'How To Become an Agentic AI Engineer in 6 Months'] },
  { id: 'how-twist', name: 'How to [outcome] ([twist])', frame: 2,
    rx: /^(full guide: )?how to .*(\(|:$)/,
    fits: ['How-To / System', 'Framework', 'Explainer', 'Tool Tutorial'],
    slots: '[outcome] a universal reader result; [twist] one of four kinds: the CONTRADICTION of the obvious method ("stop trying"), the BONUS ("& escape wage slavery"), the SPECIFICITY promise ("the exact roadmap", "5d thinking"), or the NEGATION of the expected answer ("not AI").',
    evidence: { n: 25, med: 1.37, top: 12, bm: 2.0 },
    examples: ['How to remember everything you read (stop trying)', 'How to survive AI mass replacement (& escape wage slavery)', 'How to think like a strategic genius (5d thinking)'] },
  { id: 'how-mechanism', name: 'How [force] [verb] [thing] [by when]', frame: 2,
    rx: /^how (?!to\b)/,
    fits: ['Explainer', 'Prediction', 'Market Analysis'],
    slots: 'The explainer\'s "how": [force] the thing that acts (a boom, a policy, a model, a trade); [verb] what it does (runs out, kills, rewires, unwinds); [thing] what it acts on; [by when] optional deadline ("this year"). Keep [force] generic: a named company or person is a proper noun and costs reach.',
    evidence: { n: 3, med: 0.55, top: 0, bm: 3.2 },
    examples: ['How Claude can easily sound exactly like you', 'How The US Iran Conflict Will Make Experienced Investors Rich'] },
  { id: 'how-plain', name: 'How to [outcome]', frame: 2,
    rx: /^(full guide: )?how to\b/,
    fits: ['How-To / System', 'Framework', 'Tool Tutorial'],
    slots: '[outcome] = [verb] + [universal reader result]: articulate yourself intelligently, unlock extreme focus on command, become so creative it feels illegal. Optional prefix "Full guide:" (14.1M). No object that names a product.',
    evidence: { n: 37, med: 0.82, top: 16, bm: 2.7 },
    examples: ['Full guide: how to unlock extreme focus on command', 'How to articulate yourself intelligently', 'How to become so creative it feels illegal'] },
  { id: 'n-list', name: 'N [things] [audience] must [verb] [before/in]', frame: 1,
    rx: /^\d+ /,
    fits: ['Listicle'],
    slots: 'Only when the body IS N discrete items. [N] 7–27 reads as a list, 78–100 as a canon; [things] concepts / rules / lessons / stocks; [audience] "every builder", "you"; [must verb] understand / know / master.',
    evidence: { n: 14, med: 0.91, top: 7, bm: 2.3 },
    examples: ['20 AI Concepts You Must Understand in 2026', '7 guides to become (ridiculously) good at Claude:', '100 Lessons For Your 20s'] },
  { id: 'two-sentence', name: '[Belief or fact]. [Reversal or promise].', frame: 2,
    rx: /^[^.:?!]{6,60}[.!] [^.]{4,}/,
    fits: ['Contrarian Thesis', 'Explainer', 'Prediction', 'Story'],
    slots: 'Sentence one states what everyone believes or what just happened; sentence two flips it or promises the exit. Four proven shapes: OBITUARY "[X] is dead. [Y] killed it." · CORRECTION "[Common practice] is the worst way to [goal]. Do this instead:" · REFRAME "You\'re not [self-blame]. You\'re [real cause]." · REVELATION "[X] is real. Here\'s [what they never showed you]."',
    evidence: { n: 11, med: 0.72, top: 0, bm: 4.7 },
    examples: ['SaaS is dead. Agents killed it.', 'Prompting is the worst way to use Claude. Do this instead:', 'Life is a mind game. Here\'s how you win.'] },
  { id: 'the-most', name: 'The most [superlative] [noun] [in timeframe] ([twist])', frame: 2,
    rx: /^the (most|only|single|best|one)\b/,
    fits: ['Prediction', 'Contrarian Thesis', 'Explainer', 'Framework'],
    slots: '[superlative] important / profitable / dangerous / only; [noun] skill / bottleneck / number / business; [in timeframe] "in the next 10 years", "this year"; optional [twist] in parentheses that negates the expected answer ("not AI"). Highest save rate of any skeleton.',
    evidence: { n: 7, med: 0.83, top: 14, bm: 7.5 },
    examples: ['The most important skill to learn in the next 10 years', 'The most profitable skill of the 21st century (not AI)', 'The only AI business worth building'] },
  { id: 'principles-of', name: 'The [principles / art / laws] of [X]', frame: 2,
    rx: /^the (principles|art|laws|science|rules|physics|economics|arithmetic|math|secrets?) of\b/,
    fits: ['Framework', 'Explainer'],
    slots: '[X] a universal capability or domain (learning faster, better decisions, strategic thinking). A canon title: steady reach, never top-decile, second-highest save rate. Optional "(How to …)" tail.',
    evidence: { n: 10, med: 1.19, top: 0, bm: 6.4 },
    examples: ['The Principles of Learning Faster.', 'The Principles of Better Decisions.', 'The Art Of Strategic Thinking (How To Become Wildly Successful)'] },
  { id: 'hero-object', name: 'The [one thing] that [saved / ruined / explains] [outcome]', frame: 1,
    rx: /^(the|this) (?!most\b|only\b|single\b|best\b|one\b|principles\b|art\b|laws\b|science\b|rules\b|physics\b|economics\b|arithmetic\b|math\b|secrets?\b)[^:]{2,50}\b(that|which|will)\b/,
    fits: ['How-To / System', 'Story', 'Explainer'],
    slots: 'One named thing (a habit, a test, a mineral, a lie) as the subject, then the verb that gives it consequence: saved my brain, keeps talented people broke, will change your life, explains your foggy afternoons. The article is about that one thing and nothing else. Conditional: never top-decile, but the second-highest save rate in the corpus (the writing-habit piece runs 13.5 bookmarks/1K). Health lane 2026-09-14: the single-substance and one-test threads.',
    evidence: { n: 5, med: 0.74, top: 0, bm: 5.6 },
    examples: ['The writing habit that saved my brain (and my future)', 'This prompt will change your life', 'The 10,000 hour lie that keeps talented people broke'] },
  { id: 'concept-colon', name: '[concept]: [what it is / why it works / how to see what others miss]', frame: 2,
    rx: /^[^:]{3,45}: \S/,
    fits: ['Explainer', 'Framework', 'Tool Tutorial'],
    slots: '[concept] a named idea, 1–3 words, lowercase is fine (first principles thinking, pattern recognition, loops); after the colon one of: "what every [audience] needs to know in [year]", "why it works (but not how you think)", "how to see what everyone else misses", "the N-step process [someone] uses to [do X]".',
    evidence: { n: 18, med: 1.10, top: 11, bm: 2.8 },
    examples: ['Loops: What Every AI Engineer Needs to Know in 2026', 'the neuroscience of visualization: why it works (but not how you think)', 'first principles thinking: how to see what everyone else misses'] },
  { id: 'happening-now', name: '[Shift] is happening now / is about to [event]', frame: 1,
    rx: /\b(is happening|about to|is real|changes everything|is unwinding|right now|has begun|is over)\b/,
    fits: ['Prediction', 'Market Analysis', 'Contrarian Thesis'],
    slots: '[shift] the change nobody is pricing in; [event] what it does next. Urgency frame: decent saves, modest reach in the corpus. Strongest when paired with a consequence for the reader ("here\'s how it affects anyone with a 401(k)").',
    evidence: { n: 2, med: 0.57, top: 0, bm: 2.3 },
    examples: ['The Most Dangerous Mind Control Is Happening Right Now', 'The Japan Carry Trade Is Unwinding — Here\'s How It Directly Affects Anyone With a 401(k)', 'this new AI benchmark changes everything'] },
  { id: 'imperative', name: '[Stop / Start / Do not] [behaviour]', frame: 1,
    rx: /^(stop|start|do |don't|do not|be |rise|lock|never|give me|become)\b/,
    fits: ['How-To / System', 'Contrarian Thesis'],
    slots: 'A command about one behaviour ("stop trying to improve your whole life at once"). Reliable mid-band, never top-decile: use when the piece is a single instruction, not for a thesis.',
    evidence: { n: 11, med: 0.56, top: 0, bm: 4.5 },
    examples: ['Start becoming someone you actually like', 'Stop trying to improve your whole life at once', 'Do not become a software developer...please'] },
];

// ---- the gate: what the corpus rewards, what the house forbids -------------------------------
const ENTITY = /\b(claude|chatgpt|gpt|openai|anthropic|gemini|grok|nvidia|musk|elon|tesla|spacex|google|apple|microsoft|meta|amazon|kimi|hermes|openclaw|fable|cowork|ikea|dwarkesh|iran|venezuela|japan|china|america|bitcoin|ethereum|matrix|fibonacci|petrodollar|hawkins|koe|sagrada)\b/i;
const ALLOW_CAPS = new Set(['AI', 'I', "I'm", "I'll", "I've", 'US', 'UK', 'EU', 'GPU', 'GPUs', 'LLM', 'LLMs', 'CEO', 'IPO', 'SaaS', 'X', 'OK', 'P.S.', 'A.I.', 'AI.', 'AI,', 'AI:', 'Earth', 'God', 'Internet']);
const BANNED = /\b(brutal(ly)?|quietly|delve|navigating|leveraging)\b/i;
const TIME = /\b(in|within|the next|for the next|over the next) (\d+|one|two|three|five|ten|a|an) (day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|decade|decades)\b|\bthis (year|month|week|decade)\b|\bby the end of\b|\btoday\b|\bnext (year|decade)\b/i;

export function classify(title) {
  const s = title.trim().toLowerCase();
  return TEMPLATES.find((t) => t.rx.test(s)) || null;
}

export function score(title) {
  const t = title.trim();
  const flags = [], notes = [];
  let pts = 0;
  const tpl = classify(t);
  if (tpl) { pts += tpl.frame; notes.push(`frame: ${tpl.id} (+${tpl.frame})`); }
  else flags.push('no skeleton matched: the corpus rewards a frame (how / if you / the most / concept: / two-sentence)');
  // proper nouns — the single strongest negative signal in the corpus (top decile 47% vs rest 71%)
  const words = t.split(/\s+/);
  const longWords = words.filter((w) => w.replace(/[^A-Za-z]/g, '').length >= 4);
  const capShare = longWords.length ? longWords.filter((w) => /^[A-Z]/.test(w)).length / longWords.length : 0;
  const titleCase = longWords.length >= 3 && capShare >= 0.6;
  const entities = new Set((t.match(ENTITY) || []).map((w) => w));
  if (!titleCase) for (let i = 1; i < words.length; i++) {
    if (/[.!?:]$/.test(words[i - 1])) continue; // sentence-initial after ". " / ": " is not a name
    const bare = words[i].replace(/^[("']+|[)"',.:;!?]+$/g, '');
    if (/^[A-Z][a-z]/.test(bare) && !ALLOW_CAPS.has(bare)) entities.add(bare);
  }
  if (entities.size) flags.push(`proper noun: ${[...entities].join(', ')} (−2; universal titles win)`);
  else { pts += 2; notes.push('no proper noun (+2)'); }
  // length — top decile runs 36–63 chars, median 50
  const L = t.length;
  if (L >= 36 && L <= 63) { pts += 2; notes.push(`length ${L} (+2)`); }
  else if ((L >= 30 && L < 36) || (L > 63 && L <= 70)) { pts += 1; flags.push(`length ${L}: edge of the 36–63 band (+1)`); }
  else flags.push(`length ${L}: outside 36–63 (0)`);
  // second person
  if (/\byou(r|'re|'ll|'ve)?\b/i.test(t)) { pts += 1; notes.push('second person (+1)'); }
  else notes.push('no "you" (0; +1 if the title can address the reader)');
  // case
  if (titleCase) flags.push('Title Case: use sentence case (0)');
  else { pts += 1; notes.push('sentence case (+1)'); }
  // caps-lock / question mark
  const shout = words.filter((w) => /^[A-Z]{4,}$/.test(w.replace(/[^A-Za-z]/g, '')));
  if (shout.length) flags.push(`caps-lock word: ${shout.join(', ')} (0% of top decile)`);
  if (/\?/.test(t)) flags.push('question mark (0% of top decile)');
  if (!shout.length && !/\?/.test(t)) { pts += 1; notes.push('no caps-lock, no question mark (+1)'); }
  // time promise (a duration or deadline, not a bare year)
  if (TIME.test(t)) { pts += 1; notes.push('time promise (+1)'); }
  else if (/\b20\d\d\b/.test(t)) notes.push('bare year (0): a duration or "this year" beats a year stamp');
  // house bans
  if (/—/.test(t)) { pts -= 2; flags.push('em-dash (−2; banned outside attribution)'); }
  if (/\bit'?s not\b[^.]*\.\s*it'?s\b/i.test(t) || /\bnot [^.]*\. it'?s\b/i.test(t)) { pts -= 2; flags.push('"It\'s not X. It\'s Y." construction (−2; banned)'); }
  const bw = t.match(BANNED);
  if (bw) { pts -= 1; flags.push(`banned word: ${bw[0]} (−1)`); }
  return { title: t, template: tpl, score: Math.max(0, Math.min(10, pts)), flags, notes };
}

export const band = (tpl) => tpl
  ? `${tpl.name} — median ${tpl.evidence.med}M views among viral (n=${tpl.evidence.n}), ${tpl.evidence.top}% reached the top decile, ${tpl.evidence.bm} bookmarks/1K`
  : 'no skeleton';

// ---- CLI ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && argv.includes('--for')) {
  const want = String(argv[argv.indexOf('--for') + 1] || '').toLowerCase();
  const hits = TEMPLATES.filter((t) => t.fits.some((f) => f.toLowerCase().includes(want)));
  if (!hits.length) { console.log(`No skeleton lists "${want}". Types: ${[...new Set(TEMPLATES.flatMap((t) => t.fits))].join(' · ')}`); process.exit(1); }
  console.log(`Skeletons that fit "${want}" (best band first):\n`);
  for (const t of hits.sort((a, b) => b.evidence.med - a.evidence.med)) {
    console.log(`▸ ${t.name}\n  ${band(t)}\n  slots: ${t.slots}\n  e.g. ${t.examples.map((e) => JSON.stringify(e)).join(' · ')}\n`);
  }
} else if (isMain && argv.includes('--mine')) {
  const env = loadEnv();
  if (!env.AIRTABLE_PAT) { console.error('AIRTABLE_PAT missing'); process.exit(1); }
  const at = airtable(env, env.XDB_BASE_ID || 'app7vXbBugWeCGctD');
  const rows = (await at.listAll('tblnvV3IusVkEX6jg', { fields: ['Title', 'Impressions', 'Bookmarks', 'Handle'] }))
    .map((r) => r.fields).filter((r) => r.Title);
  const V = (r) => r.Impressions || 0;
  const sortedV = rows.map(V).sort((a, b) => a - b);
  const TOP = sortedV[Math.floor(sortedV.length * 0.9)];
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const groups = new Map(TEMPLATES.map((t) => [t.id, []])); groups.set('other', []);
  for (const r of rows) groups.get(classify(r.Title)?.id || 'other').push(r);
  console.log(`Articles corpus: n=${rows.length}, top-decile floor ${(TOP / 1e6).toFixed(2)}M views\n`);
  console.log('| Skeleton | n | Median views | Top-decile hits | Bookmarks/1K | Top example |');
  console.log('|---|---|---|---|---|---|');
  const order = [...groups.entries()].sort((a, b) => med(b[1].map(V)) - med(a[1].map(V)));
  for (const [id, rs] of order) {
    if (!rs.length) continue;
    const top = rs.filter((r) => V(r) >= TOP).length;
    const bm = med(rs.map((r) => 1000 * (r.Bookmarks || 0) / Math.max(1, V(r))));
    const best = rs.sort((a, b) => V(b) - V(a))[0];
    const name = TEMPLATES.find((t) => t.id === id)?.name || '(no skeleton)';
    console.log(`| ${name} | ${rs.length} | ${(med(rs.map(V)) / 1e6).toFixed(2)}M | ${top} (${Math.round(100 * top / rs.length)}%) | ${bm.toFixed(1)} | ${(V(best) / 1e6).toFixed(1)}M \`${best.Title.replace(/`/g, '')}\` |`);
  }
  console.log('\nPaste the numbers into the evidence blocks in title-score.mjs and style/title-templates.md.');
} else if (isMain) {
  const titles = argv.filter((a) => !a.startsWith('--'));
  if (!titles.length) { console.log('usage: node title-score.mjs "title" ["title" …] | --for <type> | --mine'); process.exit(1); }
  const results = titles.map(score).sort((a, b) => b.score - a.score);
  for (const r of results) {
    console.log(`${String(r.score).padStart(2)}/10  ${JSON.stringify(r.title)}`);
    console.log(`       ${band(r.template)}`);
    for (const f of r.flags) console.log(`       ⚠ ${f}`);
    console.log(`       ${r.notes.join(' · ')}\n`);
  }
}
