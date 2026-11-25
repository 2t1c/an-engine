#!/usr/bin/env node
// plan-singles.mjs — build a WEEK of health-singles posts for the whole fleet.
//
// The singles lane posts other creators' viral health SINGLES (the pool in HEALTH_XDB_BASE_ID,
// fed by n8n-x-pipeline/harvest-health.mjs) as filler between the monetized threads. 3-5 posts per
// account per day in two windows, 08:00-10:00 and 18:00-22:00 Saigon (slots.mjs SINGLES_WINDOWS),
// IN ADDITION to — and never inside — the harvest and cover thread windows.
//
// PURE PLANNER. Reads Airtable and writes ONE json file. It never calls Typefully, never renders
// text (render-singles.mjs does that) and never records usage — run-singles.mjs writes the cooldown
// ledger only after a post is actually scheduled, so a planned-but-abandoned week burns nothing.
//
// Three things here are deliberate and easy to get wrong:
//
//   SELECTION BEATS REWRITING. Sorted by likes, the top of the pool is a bare reaction ("Def true
//   4 me"), a row with NO text at all (17.2M views, pure video), a Spanish caption, and an argument
//   for universal basic income. Two of the top eight are usable as standalone text. The reject
//   filters below are the load-bearing part of this file.
//
//   OLD FIRST, BY QUOTA. The point of the lane is second life for old winners, so age is a quota
//   (60/30/10 by bucket), not a coefficient. A score would let a fresh banger crowd out the whole
//   day; a quota cannot.
//
//   DETERMINISTIC BUT IRREGULAR TIMES. slots.mjs spreads the fleet evenly by alphabetical index and
//   carries no randomness at all, because "an erratic clock reads as a bot" — but an even spread of
//   450 posts a week reads as a bot too. A PRNG seeded on (accountKey, week) gives both: the same
//   week always regenerates the same plan (diffable, reproducible, like plan-week's seeded shuffle)
//   while no two accounts share a cadence.
//
// Usage:
//   node plan-singles.mjs --week 2026-09-07            # Monday of the target week
//   node plan-singles.mjs --week 2026-09-07 --days 3
//   node plan-singles.mjs --week 2026-09-07 --only kim,julian
//   node plan-singles.mjs --week 2026-09-07 --enable-voice
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { TABLES } from './config.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { accountSlots, fleetSlotKeys, MIN_SLOT_GAP_MIN, MOON_THREAD_GAP_MIN, SINGLES_WINDOW, SINGLES_WINDOWS, inSinglesWindow, singleSlotIssue } from './slots.mjs';
import { isBooster, boosterDay } from './boosters.mjs';
import { ADDITIVE_LANES } from './lanes.mjs';

const HEALTH_NICHES = ['Health', 'Fitness', 'Mental Health', 'Psychology']; // mirrors daily-winners

// ---- knobs (all tunable; none of them are laws yet) ----
// Per account per day. 3-5 is right with the full roster; the operator's call on 2026-09-05, with
// the roster narrowed to one creator, was 2-3 — five posts a day all from CoachDanGo reads as a Dan
// Go fan account rather than a health page. A flag rather than an edit, because this is the knob
// most likely to move again as the lane settles.
const [POSTS_MIN, POSTS_MAX] = parsePosts(cliArg('posts'), 3, 5);

// "2-3" -> [2,3]; "3" -> [3,3]; anything else -> the defaults, since a typo here should not
// silently halve the week.
export function parsePosts(spec, dmin, dmax) {
  const m = String(spec ?? '').trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return [dmin, dmax];
  const lo = Math.max(1, Number(m[1]));
  const hi = m[2] === undefined ? lo : Math.max(lo, Number(m[2]));
  return [lo, hi];
}
// Restrict the pool to named creators. Operator call 2026-09-03, from the session tally: across
// sixteen posts pulled on editorial grounds, seven were AlpacaAurelius and six were dr_ericberg,
// and CoachDanGo produced NONE in fourteen scheduled posts. Berg is structural rather than unlucky
// — 34% of his rows fail on inherited claim alone, because "just eat this to clean your arteries"
// IS his voice. A narrow allowlist beats another pass of regex.
const SOURCES = (cliArg('sources') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Fewer creators than posts makes the variety rules unsatisfiable, so they scale instead of being
// deleted: with the full roster this stays 1/creator/day and no back-to-back, exactly as before.
export const perCreatorCap = (n, creators) => Math.max(1, Math.ceil(n / Math.max(1, creators)));
const { startMin: WIN_START_UTC, endMin: WIN_END_UTC } = SINGLES_WINDOW; // the envelope, 09:00-22:00 Saigon; the cover gap inside it is never used
const INTRA_GAP_MIN = 75;                        // one account's own posts, minimum apart
const COVER_CLEAR_MIN = 15;                      // keep clear of this account's own cover thread
const COOLDOWN_DAYS = 90;                        // same tweet, same account
const AGE_QUOTAS = [                             // old first — the whole point of the lane
  { key: 'over1y', share: 0.6, min: 365, max: Infinity },
  { key: '3to12m', share: 0.3, min: 90, max: 365 },
  { key: 'under3m', share: 0.1, min: 0, max: 90 },
];
// A TEXT-ONLY post has to say something on its own. A post WITH MEDIA does not: we carry the image
// or video over with it, so "The kid in blue was raised right" arrives as a complete post rather
// than an orphaned caption. Operator call 2026-09-02: take the row as it stands, media and all.
const MIN_CHARS_TEXT = 40;
// Operator call 2026-09-02: these two carry the lane. They are preferred inside every age bucket,
// not exempted from any rule — the one-creator-per-account-per-day spread still applies, so a day
// takes at most one of each and the rest of the roster fills the remaining slots.
export const PRIORITY_SOURCES = ['CoachDanGo', 'dr_ericberg'];

// X handles are case-insensitive and the pool's {Handle} is whatever the harvester stored, so an
// exact match would make this whole preference a no-op on a casing difference alone — silently,
// with the plan still reporting success. Returns the canonical spelling, or null.
export function priorityHandle(handle) {
  const h = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
  return PRIORITY_SOURCES.find((p) => p.toLowerCase() === h) || null;
}

// ---- reject filters: no rewrite makes these postable ----
const RX = {
  mention: /(^|[^\w@])@\w{2,}/,
  // The mention gate with the @ filed off. "Alan is one of the most knowledgeable experts on
  // cardiovascular exercise on X. Highly recommend following him" reached Rasmus's last slot: a
  // bare first name carries no handle, so a reader cannot act on it, and it is Dan Go endorsing
  // his friend from our page either way. Same class as a mention, so trust does not lift it.
  // "Follow this routine" and "following a high protein diet" are untouched — the tell is a PERSON
  // pronoun, or recommend/shoutout sitting right next to the follow.
  endorsement: /\bshout\s?out\s+to\b|\bs\/o\s+to\b|\b(recommend|suggest)\w*\s+(\w+\s+){0,2}follow(ing)?\b|\bgo follow\b|\bgive (him|her|them) a follow\b|\bfollow (him|her|them)\b/i,
  link: /https?:\/\/|\bt\.co\b|\bwww\./i,
  funnel: /link in bio|linkinbio|my newsletter|\bdm me\b|check out my|sign ?up|join my|my (course|program|app|book|guide)|my own\b[^.!?]{0,40}\b(restaurant|brand|company|gym|clinic|line|store|shop|label|supplement)|coming to \w+[^.!?]{0,30}\bsoon\b|coming soon\b|now open\b|subscribe|patreon|promo ?code|use code|swipe up|👇\s*$|\bcomment\s+["“']?\w+["”']?[^.!?]{0,40}\bi'?ll send\b|\bfree [^.!?]{0,20}?(guide|training|challenge|masterclass|webinar|course)\b|\bour clients\b|\bwe (use|built) to help\b|\bour\s+(?:[\w-]+\s+){0,3}(protein\s+(bar|powder)|supplements?|electrolytes?|seasonings?)\b|\bmy favou?rite\s+[\w-]+\s+(bar|powder|supplement)s?\b|\b(back in stock|another flavou?r|new flavou?r)\b/i,
  offniche: /\b(vaccine|vaxx|fauci|covid|mandate|lockdown|pandemic|federal|government|president|election|senator|congress|politic|democrat|republican|trump|biden|war|shooting|shot at|israel|palestin|ukrain|inflation|universal (basic|high) income|\bUBI\b|tariff|immigration|violent|assault|attacked?|injured|killed|arrested|feminis[mt]|the patriarchy|red ?pill(ed)?)\b/i,
  // The pool's creators also go viral on shoes, gadgets and price drops. That is commerce, not health.
  commerce: /\$\s?\d|\bprice\b|just dropped|\bdeal\b|\bsale\b|new(est)? \w*\s?(shoe|sneaker|gadget|phone|watch|drop)\b/i,
  // Paraphrase PRESERVES a claim: rewording an unproven statistic makes the account assert it in
  // its own words, which is worse than quoting it. Hard gate, not a warning — these are monetized
  // health accounts and the FTC exposure is real.
  claim: /\b(cures?|curing|heals?|boosts?|destroys?|damages?|tanks?|reverses?|reversing|treats?|treatment|cancer|diabetes|alzheimer|dementia|autism|prescription|diagnos\w+|dosage|dose)\b|\d+\s?(mg|mcg|iu|hz|grams?)\b|\btumou?rs?\b|\bdiseased?\s+(tissues?|cells?|organs?)\b|clinical trial|stud(y|ies) (found|show|showed|shows|proves?)|\d+\s?%\s+(of|more|less|fewer)|\b(clean|cleanse|flush|detox\w*|unclog|melt|dissolve|shrink)s?\s+(out\s+)?(your\s+|the\s+)?(arter\w+|liver|kidneys?|colon|gut|blood|lymph|plaque|toxins?|fat)\b/i,
  // The anonymous-remedy clickbait shape: the remedy is hidden behind "this" and the promise is
  // bodily. "Just eat this to clean your arteries!" carries no trigger word the claim gate knows,
  // and it is the single most common form dr_ericberg goes viral in. A post that NAMES its remedy
  // ("mix 1 tablespoon of apple cider vinegar") is a different thing and stays.
  // "this" must be ANONYMOUS. "Use this system to get lean: 1) 10k steps 2) 8 hours sleep" names
  // its remedy and enumerates it — that is CoachDanGo's signature format and two of his best posts
  // (346K, 87K) were being dropped by the first version of this gate. So: not when a noun names the
  // thing, and not when the post spells it out as a list.
  // "Replace your regular deodorant with this, and your body will thank you" (1.0M) is the same
  // anonymous remedy with a verb the first list missed, and the promise is bodily in the same way.
  remedy: /\b(eat|drink|take|use|try|add|mix|sip|swallow|apply)\s+(this|these)\b(?!\s+(system|habit|routine|protocol|method|plan|rule|list|approach|formula|framework|guide|stack|combo))|\b(replace|swap)\s+(your|the)\b[^.!?]{0,40}\bwith\s+(this|these)\b|\b(one|a|1)\s+(cup|glass|spoon\w*|tbsp|tsp|shot)\s+of\s+this\b/i,
  // A post that enumerates its steps is not hiding anything, whatever verb it opens with.
  enumerated: /(^|\n)\s*(\d[).:]|[-•*])\s+\S/,
  // A thread's FIRST tweet, posted as a single. "There's a diet proven to cut visceral fat by 14%
  // ... Let me break down the science and show you exactly what foods to eat:" promises a breakdown
  // that never arrives, because the rest of it lives in replies we do not carry. Not truncation —
  // the row is complete — so isClipped cannot see it. The tell is the LAST non-empty line: a colon,
  // or a naked thread marker. A colon mid-post that introduces a list is fine and stays.
  danglingPromise: /(^|\n)[^\n]*:\s*$|(^|\n)\s*(a thread|thread\s*(below|👇)?|🧵|1\/\d*)\s*$/i,
  // A monetized health page cannot call a named brand poison, or tell people the drug industry is
  // hiding a cure. Trade libel on one side, conspiracy on the other, and neither is worth the reach.
  smear: /\bpoison(s|ed|ing|ous)?\b|\bbig pharma\b|\bdrug industry\b|\bthey don'?t want you\b|\bsuppress(ed|ing)?\s+(the\s+)?(truth|cure|research)\b/i,
  // Sexual-behaviour advice and manosphere framing. These go viral in the fitness pool and are
  // wrong for a monetized health page twice over: the mechanism claims are unproven, and "beta
  // male" is a register no supplement brand wants attached to it. Found 2026-09-03 on Rasmus's
  // first planned week, alongside a post claiming a 96-hour fast eats tumours.
  sexual: /\bmasturbat\w*|\bporn\b|\bsemen\s+retention\b|\bnofap\b|\b(beta|alpha)\s+males?\b|\bejaculat\w*/i,
  // Named prescription drugs and research peptides presented as things to TAKE. A supplement page
  // listing metformin and MOTS-c beside creatine is a different regulatory object than one talking
  // about creatine. Deliberately a NAME list, not a topic one: the pool's best-performing GLP-1
  // posts argue AGAINST the drugs ("Ozempic bod is not attractive or healthy"), and that commentary
  // is on-brand and stays. Found 2026-09-03 in a mitochondrial-optimiser stack on Rasmus's week.
  rxdrug: /\b(metformin|rapamycin|methylene\s+blue|BPC-?157|TB-?500|SS-?31|MOTS-?c|sermorelin|ipamorelin|tesamorelin|semaglutide|tirzepatide|clenbuterol|anavar|trenbolone|stanozolol)\b/i,
  // Including the asterisked forms creators use to dodge platform filters.
  // Creators asterisk to dodge platform filters, so the gate has to read the asterisked forms too.
  // The f-word had them; the s-word did not, which is how "Stop eating fake sh*t" and "holy sh*t..."
  // both reached the 2026-09-14 fleet preview.
  profanity: /\bf+u+c+k|\bf\*+k\b|\bf\*{2,}|\bs+h+i+t\b|\bsh\*+t\b|\bs\*{2,}t?\b|\bbitch|\bb\*tch\b|\bass+hole|\ba\*+hole\b/i,
  // First person is fine for STANCE; a borrowed LIFE is fabrication on a persona account. The
  // relations list alone missed "a day in my life in Costa Rica", "my college gym" and "I launched
  // an investigation" — every one of them a scene this account never lived (found 2026-09-02 on
  // Kim's first planned week).
  // Every relation takes a PLURAL. The singular-only list let "Some of my entrepreneur clients
  // swear by doing cardio in the morning" through onto Rasmus's 12th — Dan Go has coaching clients,
  // Rasmus does not. "my patients", "my sons", "my doctors" had the same hole.
  // Travel and place memories are the other half of the same post: "when I visited China" is a
  // scene this account never lived, exactly like "a day in my life in Costa Rica" was.
  biography: /\bmy\b(?:\s+[\w'-]+){0,4}?\s+(wi(fe|ves)|husbands?|sons?|daughters?|kids?|moms?|mums?|dads?|mothers?|fathers?|parents?|famil(y|ies)|neighbou?rs?|grandmas?|grandpas?|clients?|patients?|coach(es)?|doctors?|therapists?|boss(es)?|besties?|dogs?|cats?)\b|\bmy (college|school|childhood|hometown|local|old|backyard|garden)\b|\b(i had|had|with) an? client\b|\ba client (who|of mine)\b|\bi (eat|ate|drink|drank|make|made) (this|these)\b|\bmy best purchases?\b|\bone of my best purchases\b|\bmy (daily|morning|nightly|evening) (non-negotiables|routine|ritual)\b|\bfor the next \d+ days,? i\b|\bi'?m going to wear\b|\bi (stopped|started|quit|switched) [^.!?]{0,40}\b(years?|months?|weeks?) ago\b|\bi used to \w+|\bi just came back from\b|\bi (was|were) (working out|feeling|at the gym|gonna|going to)\b|\bi wake up at \d|\bi (drove|drive) my\b|\bi created a\b|\bi'?ve been (using|taking|doing|eating)\b|\bbeen taking [^.!?]{0,30}\bfor [\d.]+ years?\b|\bmy current [\w-]+ stack\b|\bat \d{2},? i'?m\b|\bi put [^.!?]{0,30}\binto my\b|\bquality of my (sleep|life)\b|\bthe gym is my\b|\b(solved|transformed|fixed|healed|cured)\b[^.!?]{0,30}\bmy\b|\bfoods i eat\b|\bi eat (every|each) (day|week)\b|\bthings i(?: have|'?ve) done\b|\bchanges i(?: have|'?ve) made\b|\bi(?: have|'?ve) made to my\b|\bthe other day i\b|\bi'?ve just\b|\bi call it\b|\bi wouldn'?t get\b|\bmy (morning|evening|nightly) (coffee|tea|walk|routine)\b|\bi realized (reading|seeing|working|watching)\b|\blately,? i'?(ve)?\b|\bday in my life\b|\bi (launched|filed|sued|founded|investigated)\b|\b(when|while) i (visited|lived|travel\w*|was in|worked at|grew up)\b|\b(younger|older) than me\b|\blast night\b|\bthis morning i\b|\bwhen i was \d|\bi'?m \d{2}\b|\bat \d{2} years old\b|\b\d+ years ago i\b/i,
  nonEnglish: /\b(que|como|para|con|muy|pero|porque|cuando|não|você|obrigado|então|c'est|est|dans|pour|avec|und|nicht|ist|för|про|это)\b/i,
  // MUST MATCH. Operator call 2026-09-02, after Kim's first planned week offered a $500 running
  // shoe, a bison attack, a boxing clip, a weather stunt and a wildlife photo — all genuinely viral,
  // none of them a health post. A health page has to read like one.
  onTopic: /\b(health|healthy|fitness|longevity|nutrition|diet|dieting|calorie|protein|carb|carbs|sugar|seed oil|fasting|fast(ed|ing)?|meal|eat|eats|eating|food|cook(ing)?|vitamin|mineral|magnesium|creatine|collagen|supplement|omega|fibre|fiber|sleep|slept|nap|rest|recovery|circadian|melatonin|gym|lift(ing)?|weights?|workout|train(ing)?|exercise|cardio|walk(ing)?|steps|muscle|strength|squat|pushups?|reps|shape|lean|fat|obesity|metabolism|testosterone|hormone|cortisol|insulin|blood sugar|gut|digestion|bloat|inflammation|energy|stress|anxiety|mood|brain|focus|discipline|habit|posture|hydrat\w+|water|alcohol|smoking|nicotine|caffeine|coffee|sunlight|body|weight|nature|outdoors|sunshine|calm|stillness|breath\w*|meditat\w+|relax\w*|mindful\w*)\b/i,
};
// Clipped longform: harvest-health stored legacy.full_text before the note_tweet fix, so the pool's
// longest rows end mid-clause. A clipped post schedules and publishes cleanly, so nothing catches
// it downstream. Repaired by `harvest-health.mjs --repair-longform`; rejected here until it is.
// A BAND, not a floor — see harvest-health.mjs. Nothing predating the note_tweet fix could exceed
// full_text's ~280-char cap, so a clipped body sits right at it; a longer row that merely ends
// without a full stop is a long post, not a truncated one.
const isClipped = (s) => {
  const t = (s || '').trim();
  return t.length >= 270 && t.length <= 290 && !/[.!?)"'…”’]$/.test(t);
};

const asciiRatio = (s) => {
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (!letters) return 1;
  return (s.match(/[A-Za-z]/g) || []).length / letters;
};

// Operator call 2026-09-05: "if it was written by dan go or eric berg then it's fine."
//
// That answers ONE question — is this claim, in this register, acceptable coming from a health
// page — so it lifts exactly the six gates that ask it: profanity, sexual, rxdrug, smear, remedy,
// claim. Every one of the sixteen posts pulled on editorial grounds this week tripped one of them.
//
// It does not answer the other two questions, so those gates hold for everyone:
//
//   CAN OUR ACCOUNT SAY IT — a link sends traffic to the creator, a mention tags a real person from
//   our page, their funnel promotes their business on ours, and a borrowed life is a lie whoever
//   first told it ("I started going to the gym because of my dad" is Dan Go's story, not Kim's).
//   Mechanical faults (no text, clipped, not English) sit here too: they break the post.
//
//   IS IT A HEALTH POST — onTopic, offniche and commerce. The operator chose "must be on-topic"
//   outright on 2026-09-03, and a $500 sneaker drop does not become a health post because a health
//   creator wrote it. Costs these two almost nothing: nearly everything they publish is health.
export function isTrusted(handle) { return !!priorityHandle(handle); }

// Typographic quotes, dashes and ellipses all reach us from X exactly as the creator typed them.
export const normalizeQuotes = (s) => String(s ?? '')
  .replace(/[\u2018\u2019\u201A\u201B\u02BC\u2032]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');

// Jaccard over word tokens. 0.8 catches a re-post and a one-word edit of one ("bed hungry" vs
// "sleep hungry" scores 0.82) while leaving genuinely different short posts far below: the two
// "luxury" aphorisms in the same week score 0.15. Deliberately not a substring or hash check —
// those miss the one-word edit, which is the common case in a creator's own re-posts.
export function textSimilarity(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / (A.size + B.size - hit);
}
export const tokenSet = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
export const NEAR_DUPLICATE = 0.8;

// A creator's share of the run follows how much usable material they actually HAVE, with the
// priority pair weighted up — and nobody is drawn past their own inventory.
//
// The fleet preview for 2026-09-14 is why. dr_ericberg has 73 eligible rows and was drawn 119
// times: every one of the 17 accounts got exactly 7 CoachDanGo + 7 dr_ericberg, because the
// per-day cap turns a PREFERENCE into a fixed allocation once the fleet is wide enough. One Berg
// post landed on four different pages in one week, 1,590 CoachDanGo rows went untouched, and all
// seventeen pages came out with the same creator skeleton.
//
// The cap stays soft on purpose: if it would leave a day short, the day is filled anyway. A page
// posting twice beats a page posting once to protect a ratio.
export const PRIORITY_WEIGHT = 3;
export function creatorBudgets(depth, totalPosts, isPriority = () => false, ceiling = Infinity) {
  const srcs = Object.keys(depth).filter((h) => depth[h] > 0);
  if (!srcs.length) return {};
  // A creator can never exceed what the per-day cap physically allows (accounts x days x cap), and
  // never their own inventory. The first budget ignored the day cap and handed CoachDanGo 210 when
  // 119 was the most the calendar could take — an 81-post hole that the soft pass then filled from
  // the priority list, which is how dr_ericberg came back at 66 against a budget of 10.
  const cap = Object.fromEntries(srcs.map((h) => [h, Math.max(1, Math.min(depth[h], ceiling))]));
  const weight = Object.fromEntries(srcs.map((h) => [h, depth[h] * (isPriority(h) ? PRIORITY_WEIGHT : 1)]));
  const out = Object.fromEntries(srcs.map((h) => [h, 0]));
  // Water-fill: share out by weight, cap, then redistribute what the capped ones could not take.
  // A single proportional pass leaves the budgets summing far below the run, and every post short
  // is a post the soft pass places with no regard for depth at all.
  let remaining = Math.max(0, totalPosts);
  let open = srcs.slice();
  for (let pass = 0; pass < 24 && remaining > 0 && open.length; pass++) {
    const tw = open.reduce((a, h) => a + weight[h], 0);
    if (!tw) break;
    let given = 0;
    const next = [];
    for (const h of open) {
      const got = Math.min(cap[h], out[h] + Math.ceil(remaining * weight[h] / tw));
      given += got - out[h];
      out[h] = got;
      if (got < cap[h]) next.push(h);
    }
    if (!given) break;
    remaining -= given;
    open = next;
  }
  // Never zero for a creator who has rows: a 0 budget makes the scan skip them for the whole run.
  for (const h of srcs) out[h] = Math.max(1, Math.min(cap[h], out[h]));
  return out;
}

// A year the reader has already lived through, used as THIS year. "Anyone else doing one more
// workout before 2023?" on a page in September 2026 is the plainest possible tell that the post is
// recycled — which is the one thing this whole lane is built to avoid.
//
// Only when the year is the TIME FRAME. "A 2022 study in the British Journal of Sports Medicine"
// is a citation and gets better with age; "2000 calories in one sitting" is not a year at all.
//
// And only when it is RECENT. "WTF happened since 2000 that caused average testosterone to fall
// almost 30%" is a historical reference point that reads fine forever — my first pattern caught it
// and a test said so. A year within STALE_WINDOW of now was written as "this year"; anything older
// is history. `since` and `throughout` are dropped entirely: they are almost always historical.
//
// Compared against the clock rather than a constant, so it ages out on its own.
const STALE_YEAR = /\b(?:in|before|for|during|by)\s+(20[0-4]\d)\b/i;
export const STALE_WINDOW = 6;
export function staleYear(text, now = new Date()) {
  const m = STALE_YEAR.exec(String(text ?? ''));
  if (!m) return null;
  const y = Number(m[1]), here = now.getFullYear();
  return y < here && y >= here - STALE_WINDOW ? y : null;
}

export function rejectReason(row) {
  const raw = (row.text || '').trim();
  // Creators type a curly apostrophe (U+2019) and X preserves it. Every pattern below is written
  // with a straight quote, so "At 43, I'm working out harder" was caught and "At 43, I’m working
  // out harder" — the actual row, at 244K — was not. 52 of the 294 posts in the 2026-09-14 fleet
  // plan carry one, so this was quietly disarming a slice of the biography, funnel and smear gates
  // against the exact text most likely to trip them. Same silent no-op class as cliArg.
  // Normalise once and match against that; length and clipping still read the real text.
  const text = normalizeQuotes(raw);
  const hasMedia = !!row.mediaType;
  const trusted = isTrusted(row.source);
  // A post with no words carries none of the account's voice, and a wordless repost of someone
  // else's video is the least defensible thing this lane could do (operator call 2026-09-02).
  if (!raw) return 'no text';
  if (!hasMedia && raw.length < MIN_CHARS_TEXT) return 'too short to stand alone';
  if (isClipped(raw)) return 'clipped longform (run --repair-longform)';
  // Mechanical, so it holds for trusted creators too: a promise with nothing behind it is broken
  // whoever wrote it.
  if (RX.danglingPromise.test(text.replace(/\s+$/, ''))) return 'a thread opener, not a single';
  if (RX.mention.test(text)) return 'mentions another account';
  if (RX.endorsement.test(text)) return 'endorses someone we cannot name';
  if (RX.link.test(text)) return 'contains a link';
  if (RX.funnel.test(text)) return "the creator's own funnel";
  if (RX.nonEnglish.test(text) || asciiRatio(text) < 0.6) return 'not English';
  if (!trusted && RX.profanity.test(text)) return 'profanity';
  if (!trusted && RX.sexual.test(text)) return 'sexual or manosphere framing';
  if (!trusted && RX.rxdrug.test(text)) return 'names a prescription drug or peptide';
  if (!trusted && RX.smear.test(text)) return 'names a brand or the drug industry';
  if (RX.offniche.test(text)) return 'off niche';
  if (!trusted && RX.remedy.test(text) && !RX.enumerated.test(text)) return 'anonymous-remedy clickbait';
  if (!trusted && RX.claim.test(text)) return 'inherited claim';
  if (RX.biography.test(text)) return 'fabricated biography';
  // Mechanical, so trust does not lift it: a stale year is stale whoever wrote it.
  if (staleYear(text)) return 'names a year already gone';
  // Catch-alls last, so a row is reported by its most specific fault. The burrito post carries
  // "$20" and read as commerce until the borrowed family came first.
  if (RX.commerce.test(text)) return 'commerce, not health';
  if (!RX.onTopic.test(text)) return 'off topic — not a health post';
  return null;
}

// ---- Jev on the meaning gates (owner, 2026-09-23; decisions/singles-screen.mjs) ----
// rejectReason's reasons by class. Anything not listed is MECHANICAL (link, mention, funnel, English,
// clipped, dangling, stale year, profanity, too short) and stays the code's whatever Jev reads.
export const REASON_CLASS = Object.freeze({
  'sexual or manosphere framing': 'sexual',
  'names a brand or the drug industry': 'smear',
  'names a prescription drug or peptide': 'rx_drug',
  'inherited claim': 'claim',
  'anonymous-remedy clickbait': 'remedy',
  'fabricated biography': 'biography',
  'off niche': 'off_niche',
  'commerce, not health': 'commerce',
  'off topic — not a health post': 'off_topic',
});
const SAFETY = new Set(['sexual', 'smear', 'rx_drug', 'claim', 'remedy', 'biography']);
const TOPIC = new Set(['off_niche', 'commerce', 'off_topic']);

/** PURE. Every safety regex that fires on the row, not just the first (rejectReason stops at one). */
export function regexSafetyHits(row) {
  const text = normalizeQuotes((row.text || '').trim());
  const trusted = isTrusted(row.source);
  const hits = [];
  if (!trusted && RX.sexual.test(text)) hits.push('sexual');
  if (!trusted && RX.rxdrug.test(text)) hits.push('rx_drug');
  if (!trusted && RX.smear.test(text)) hits.push('smear');
  if (!trusted && RX.remedy.test(text) && !RX.enumerated.test(text)) hits.push('remedy');
  if (!trusted && RX.claim.test(text)) hits.push('claim');
  if (RX.biography.test(text)) hits.push('biography');
  return hits;
}

/** PURE. Does this row need a Jev read? Only when Jev's answer could change the outcome. */
export function wantsJev(row) {
  const why = rejectReason(row);
  if (!why) return true; // passed the regex: Jev may add a safety or topic reject
  const cls = REASON_CLASS[why];
  return TOPIC.has(cls) && !regexSafetyHits(row).length; // a topic reject Jev may overturn
}

const JEV_LABEL = { sexual: 'sexual or manosphere framing', smear: 'names a brand or the drug industry', rx_drug: 'names a prescription drug or peptide',
  claim: 'inherited claim', remedy: 'anonymous-remedy clickbait', biography: 'fabricated biography', off_niche: 'off niche',
  commerce: 'commerce, not health', off_topic: 'off topic — not a health post' };

/**
 * PURE. The final verdict: { reason, source } where reason null means post.
 *   mechanical regex reason -> code rejects
 *   any safety regex hit    -> rejects (monotone: Jev never clears one)
 *   Jev unread              -> the regex answer stands
 *   Jev read                -> a Jev safety class rejects; a Jev topic class rejects; otherwise it posts,
 *                              even when the regex called it off topic, off niche or commerce
 */
export function singlesVerdict(row, jev) {
  const why = rejectReason(row);
  const cls = why ? REASON_CLASS[why] : null;
  if (why && !cls) return { reason: why, source: 'code' };
  const hits = regexSafetyHits(row);
  if (hits.length) return { reason: SAFETY.has(cls) ? why : JEV_LABEL[hits[0]], source: 'code' };
  if (!jev || jev.status !== 'read') return { reason: why, source: 'code' };
  // A priority creator keeps the trust the regex gives it (isTrusted): only biography binds them there,
  // so Jev reads the same classes the regex would have. A trusted "quit porn" habits list stays.
  const trusted = isTrusted(row.source);
  const jevSafety = (jev.classes || []).filter((c) => SAFETY.has(c) && (!trusted || c === 'biography'));
  if (jevSafety.length) return { reason: `${JEV_LABEL[jevSafety[0]]} (Jev)`, source: 'jev' };
  const jevTopic = (jev.classes || []).filter((c) => TOPIC.has(c));
  if (jevTopic.length) return { reason: `${JEV_LABEL[jevTopic[0]]} (Jev)`, source: 'jev' };
  return { reason: null, source: why ? 'jev-cleared' : 'jev' };
}

/**
 * Reads every row wantsJev() selects through decide('singles-screen'). Returns Map recId -> reading.
 * A plan reads thousands of posts (1,811 disagreements on one 2026-09-23 plan), too many for the
 * git-tracked decision log, so by default nothing is logged: the plan's diagnostics carry the counts
 * by reason, "(Jev)" marking Jev's. Pass `log` to keep the rows where Jev and the regex disagree.
 */
export async function screenWithJev(rows, env, { client = null, concurrency = 24, log: sink = null, cache } = {}) {
  const { decide, decisionConfig } = await import('./jev-decide.mjs');
  const { DECISIONS } = await import('./decisions/index.mjs');
  const jevClient = client || (await import('./jev.mjs')).jev(env);
  const base = sink;
  const log = base && { append: (r) => { if (r.jev !== r.incumbent || r.fallback) base.append(r); } };
  const todo = rows.filter(wantsJev);
  const out = new Map();
  const th = decisionConfig('singles-screen').thresholds;
  let i = 0, notRead = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (i < todo.length) {
      const row = todo[i++];
      try {
        const d = await decide('singles-screen', { text: row.text, regexReason: rejectReason(row) }, { client: jevClient, registry: DECISIONS, log, ...(cache ? { cache } : {}) });
        if (d.mode === 'off' || d.source === 'fallback' || !d.answers) { notRead++; out.set(row.recId, { status: 'not read', reason: d.fallback || d.mode }); continue; }
        out.set(row.recId, { status: 'read', ...DECISIONS['singles-screen'].policy(d.answers, th) });
      } catch (error) { notRead++; out.set(row.recId, { status: 'not read', reason: String(error?.message || error).slice(0, 120) }); }
    }
  }));
  base?.flush?.();
  console.log(`jev: ${todo.length - notRead}/${todo.length} singles read in ${((Date.now() - started) / 1000).toFixed(1)}s${notRead ? ` · ${notRead} not read (the regex answer stands)` : ''}`);
  return out;
}

// ---- shape -> render mode ----
// The classifier is mechanical on purpose: an LLM deciding how much to change is the failure this
// lane exists to avoid. Two rules the line count alone gets wrong, both from real rows:
//   - load-bearing content words ("Do cardio for a longer life. / Lift weights for a quality life.")
//     read as paraphrase by shape, but swapping the domain nouns changes the ADVICE.
//   - a punch riding on a banned word ("is it just me or is everybody cool quitting alcohol?")
//     cannot survive a rewrite that forbids the word. Route it, do not fight it.
const PUNCH_WORDS = /\b(just|literally|actually|really|simply|honestly|truly|basically|totally|absolutely)\b/i;
export function classifyShape(text) {
  const t = (text || '').trim();
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const words = t.split(/\s+/).filter(Boolean).length;
  if (lines.length === 1 && words <= 14) return { mode: 'verbatim', why: 'aphorism' };
  if (PUNCH_WORDS.test(t) && words <= 30) return { mode: 'verbatim', why: 'punch rides a banned word' };
  if (lines.length === 2 && words <= 16) {
    // A parallel couplet ("Do cardio for a longer life. / Lift weights for a quality life.") has
    // balanced halves and its domain nouns ARE the advice. A two-beat verdict ("Grandparents were
    // right." + a 12-word elaboration) is lopsided by design and paraphrases without losing the
    // beat, so length symmetry is what separates them — not the line count.
    const [a, b] = lines.map((l) => l.split(/\s+/).filter(Boolean).length);
    const ratio = Math.max(a, b) / Math.max(1, Math.min(a, b));
    if (ratio <= 1.6) return { mode: 'verbatim', why: 'parallel couplet, content words load-bearing' };
  }
  if (lines.length >= 4 || /^\s*([-•*]|\d+[.)])\s/m.test(t)) return { mode: 'voice', why: 'list or protocol' };
  return { mode: 'paraphrase', why: 'structure carries the punch' };
}

// ---- seeded PRNG: reproducible plans, irregular clocks ----
const seedOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rngFor = (s) => { let a = seedOf(s); return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// N times inside the window, each at least INTRA_GAP_MIN apart, on human-looking minutes.
// A day's times for one account: n posts across the singles WINDOWS, ≥INTRA_GAP_MIN apart, never
// inside a thread window. Until 2026-09-07 this drew over one window that contained the whole cover
// grid and steered clear of the account's OWN cover minute only, so every other page's cover, every
// pot and every attempt was fair game — 18 singles landed within a minute of a money thread in Run 2
// and each day needed a retime pass. The windows now exclude the thread windows outright.
//
// The count is split across the windows in proportion to their width (5 posts -> 2 in the morning,
// 3 in the afternoon), each window draws its own share with the same seeded irregularity as before,
// and the number of rnd() draws is still exactly n, so a frozen day keeps consuming the draws it
// would have made and "same week, same times" survives.
/**
 * PURE. The minutes (UTC minute-of-day) money threads are actually BOOKED at, keyed `account|YYYY-MM-DD`
 * (Saigon day), from a run-occupancy snapshot (`bookings[]`) or a run plan (`days[day][].at`). Singles
 * used to steer clear of each page's GRID minute only, which is wrong the moment a thread is nudged
 * off its grid minute at the brief (R1, 2026-09-23) or moved by hand. Singles are not threads, and
 * neither are articles (owner, R2026-10-03): an article's minute must never stand in for the thread's.
 */
export function bookedThreadMinutes(source) {
  const out = new Map();
  const put = (account, iso) => {
    const ms = Date.parse(iso || '');
    if (!account || !Number.isFinite(ms)) return;
    const day = new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
    out.set(`${account}|${day}`, new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes());
  };
  for (const b of Array.isArray(source?.bookings) ? source.bookings : []) if (!ADDITIVE_LANES.includes(b?.lane)) put(b.account, b.publishAtUtc);
  for (const rows of Object.values(source?.days && typeof source.days === 'object' ? source.days : {})) {
    for (const r of Array.isArray(rows) ? rows : []) if (r?.at && !ADDITIVE_LANES.includes(String(r.bucket || 'cover'))) put(r.account, r.at);
  }
  return out;
}

/**
 * PURE. A BOOSTER page's singles on `day` (owner, 2026-10-03: "3 reposted singles" a day, "zig-zagged"; docs/booster-lane.md):
 * the S slots of its zig-zag day (boosters.mjs), as UTC minutes of `day`, each moved by the fewest minutes (later first)
 * that satisfy the singles law (slots.mjs singleSlotIssue) and keep MOON_THREAD_GAP_MIN from the page's own thread
 * everywhere, not only inside Moon: a booster's single straight after its own thread reads as one burst.
 */
export function boosterSingleMinutes(key, day, threadMin = null) {
  const threadMins = threadMin == null ? [] : [threadMin];
  const ok = (m) => !singleSlotIssue(m, threadMins) && (threadMin == null || Math.abs(m - threadMin) >= MOON_THREAD_GAP_MIN);
  return boosterDay(key, day).filter((s) => s.kind === 'S').map((s) => {
    const base = Math.round((Date.parse(s.at) - Date.parse(`${day}T00:00:00Z`)) / 60000);
    for (let d = 0; d <= 60; d++) for (const m of [base + d, base - d]) if (ok(m)) return m;
    return base;
  });
}

export function dayTimes(rnd, n, coverMin, windows = SINGLES_WINDOWS) {
  const spans = windows.map((w) => w.endMin - w.startMin);
  const room = spans.map((sp) => Math.floor(sp / INTRA_GAP_MIN) + 1);        // posts a window can hold
  const total = spans.reduce((a, b) => a + b, 0);
  // Largest-remainder split: 5 posts over 3.5h + 6.5h is 1.75 / 3.25, so 2 / 3 — the morning keeps
  // a real share instead of every spare post piling into the evening. Never past what a window holds.
  const quota = spans.map((sp) => (n * sp) / total);
  const counts = quota.map((q, i) => Math.min(room[i], Math.floor(q)));
  let rem = n - counts.reduce((a, b) => a + b, 0);
  const byRemainder = quota.map((q, i) => i).sort((a, b) => (quota[b] - Math.floor(quota[b])) - (quota[a] - Math.floor(quota[a])) || spans[b] - spans[a]);
  let guard = 0;
  while (rem > 0 && guard++ < 50) for (const i of byRemainder) { if (rem > 0 && counts[i] < room[i]) { counts[i]++; rem--; } }
  if (rem > 0) throw new Error(`singles windows too narrow for ${n} posts`);

  const inCover = (x) => coverMin != null && Math.abs(x - coverMin) < COVER_CLEAR_MIN;
  const out = [];
  windows.forEach((w, wi) => {
    const k = counts[wi];
    if (!k) return;
    const span = w.endMin - w.startMin;
    const need = (k - 1) * INTRA_GAP_MIN;
    const draws = Array.from({ length: k }, () => rnd() * (span - need)).sort((a, b) => a - b);
    const base = draws.map((u, i) => Math.round(w.startMin + u + i * INTRA_GAP_MIN));
    // Jitter and cover-avoidance run INSIDE a range that already reserves room for every remaining
    // post, so they can never push a time out of the window or under the gap. Adjusting first and
    // clamping afterwards is what breaks those invariants.
    const first = out.length;
    for (let i = 0; i < k; i++) {
      const lo = i === 0 ? w.startMin : out[first + i - 1] + INTRA_GAP_MIN;
      const hi = w.endMin - (k - 1 - i) * INTRA_GAP_MIN;
      let m = Math.min(hi, Math.max(lo, base[i]));
      // :00, :05, :30 read as scheduled; a person posts at :07 and :23.
      const ok = (x) => x >= lo && x <= hi && x % 5 !== 0 && !inCover(x);
      if (!ok(m)) {
        for (let d = 1; d <= hi - lo; d++) {
          if (ok(m + d)) { m += d; break; }
          if (ok(m - d)) { m -= d; break; }
        }
      }
      out.push(Math.min(hi, Math.max(lo, m)));
    }
  });
  return out;
}

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5));
const utcAt = (day, min) => `${day}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00Z`;
const saigon = (min) => { const m = (min + 7 * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function nextMonday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return ymd(d);
}

// Fold an existing plan for this week into the run about to happen. Returns the days that are
// frozen (any post already carrying a draftId) and the accounts to carry through untouched, and
// seeds the two dedup structures from every prior post.
//
// Without this, `--only rasmus` rewrites the file containing only Rasmus and Kim's draft ids are
// gone; and re-planning an account whose day already shipped picks DIFFERENT rows for that day
// (the shipped ones are on cooldown), with no draft id to skip on, stacking a second full day on
// top of the first. Both were live hazards on 2026-09-03, one dispatch away.
export function mergePrior(priorAccounts, selectedKeys, planned, takenByAccount, plannedText = new Map()) {
  const selected = new Set(selectedKeys);
  const shippedDays = new Map();
  for (const a of priorAccounts) {
    const posts = a.posts || [];
    // AN UNSHIPPED PLAN FOR AN ACCOUNT WE ARE RE-PLANNING IS A DRAFT, NOT HISTORY. Nothing acted on
    // it, so it is superseded rather than merged. Merging marked its rows spent and the re-plan
    // silently picked DIFFERENT ones — so a second `stage: all, apply: true` on a previewed week
    // would ship a week nobody read, and getting a corrected preview meant deleting the plan file
    // by hand, which three separate commits on 2026-09-05 had to do.
    if (selected.has(a.key) && !posts.some((q) => q.draftId)) { shippedDays.set(a.key, new Set()); continue; }
    const days = new Set();
    const mine = takenByAccount.get(a.key) || new Set();
    takenByAccount.set(a.key, mine);
    for (const q of posts) {
      // Every remaining prior post holds its slot against the fleet rule and against its own
      // account, shipped or not: an account being CARRIED THROUGH keeps its rows out of the days
      // they already occupy (or a re-plan hands the same tweet to two accounts on one day), and a
      // frozen day's rows must not be picked again for a later day.
      if (!planned.has(q.recId)) planned.set(q.recId, new Set());
      planned.get(q.recId).add(q.day);
      if (!plannedText.has(q.day)) plannedText.set(q.day, []);
      plannedText.get(q.day).push(q.text || q.sourceText || '');
      mine.add(q.recId);
      if (q.draftId) days.add(q.day);
    }
    shippedDays.set(a.key, days);
  }
  return { shippedDays, carried: priorAccounts.filter((a) => !selected.has(a.key)) };
}

// Every OTHER plan file's BOOKED posts that land on a day this week covers. A week's plan is not
// the whole schedule. The 2026-09-03 week ran Sep 3-9; the 2026-09-07 week was planned as if its
// first three days were empty, and the two files together put twenty-two pairs under the
// five-minute floor — six of them in the same minute, one the very first post of the roll-out —
// while kim and rasmus, planned in both weeks, ran to eight posts on a five-post day.
//
// Only a post carrying a draftId counts. An unshipped row in another week's file is a draft
// someone may still re-plan, and holding a slot against it would let a preview nobody read shape
// a week that ships.
export function foreignBookings(plans, week, days) {
  const mine = new Set(Array.from({ length: days }, (_, i) => addDays(week, i)));
  const out = [];
  for (const plan of plans) {
    if (!plan || plan.week === week) continue;
    for (const a of plan.accounts || []) {
      for (const q of a.posts || []) {
        // A COPY, always: these objects belong to another file, and the collision pass writes to
        // what it is handed.
        if (q.draftId && mine.has(q.day)) out.push({ ...q, key: a.key, fromWeek: plan.week });
      }
    }
  }
  return out;
}

// Of `times`, keep `n` — the ones furthest from what is already booked on the day. Called when
// another week has already put posts on this account-day, so the day still gets its band's worth
// of posts in total rather than this plan's worth on top of the other plan's.
//
// The full n times are drawn before the trim, never fewer, because dayTimes consumes one PRNG draw
// per post: drawing 2 where the week draws 4 shifts every later day's clock, and "same week, same
// times" is the invariant a re-plan rests on.
export function spreadAround(times, taken, n) {
  if (n >= times.length) return times.slice();
  if (n <= 0) return [];
  const far = (t) => (taken.length ? Math.min(...taken.map((x) => Math.abs(t - x))) : Infinity);
  return times
    .map((t, i) => ({ t, i, d: far(t) }))
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .slice(0, n)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.t);
}

// Space every pair on a day at least `gap` apart, leaving BOOKED posts exactly where Typefully has
// them. Forward first, then backward for whatever the forward pass ran out of window for.
//
// The forward pass alone used to clamp to WIN_END_UTC, which made the collision fixer a collision
// maker: a crowded tail resolved one pair by stacking three posts on 22:00 Saigon exactly, and the
// 2026-09-14 week shipped that way. Clamping is never a resolution — if a post cannot go later it
// has to go earlier, and if it can do neither the day is over-subscribed and a person needs to
// know, so anything still colliding comes back in `unresolved` instead of being written out quietly.
export function spaceOut(byDay, gap = MIN_SLOT_GAP_MIN, lo = WIN_START_UTC, hi = WIN_END_UTC) {
  const moved = new Set();
  let frozenByShip = 0;
  const unresolved = [];
  const put = (p, min) => { p.minUtc = min; p.at = utcAt(p.day, min); p.atSaigon = saigon(min); moved.add(p); };
  // Where to put a post that is too close to the one behind it: exactly the floor past it, which
  // is the smallest move that can clear it. Aiming further — the middle of the room between both
  // neighbours, which is what this did for one draft — buys almost nothing on a fleet packed at
  // six-minute spacing (there is rarely room to aim at) and costs churn where the room is wide: it
  // turned a five-minute correction on the 7th into a 36-minute jump. Knowing the post AHEAD still
  // matters, but only for the one minute below.
  const slotBetween = (behind, ahead) => {
    let m = behind + gap;
    const ceil = ahead == null ? Infinity : ahead - gap;
    // dayTimes keeps off :00, :05 and :30 — a person posts at :07, not :05 — and a repair should
    // not quietly undo that, where there is room for the extra minute.
    if (m % 5 === 0 && m + 1 <= ceil) m += 1;
    return m;
  };
  for (const [day, list] of byDay) {
    for (let round = 0; round < 4; round++) {
      list.sort((a, b) => a.minUtc - b.minUtc);
      let tight = 0;
      for (let i = 1; i < list.length; i++) {
        if (list[i].minUtc - list[i - 1].minUtc >= gap) continue;
        tight++;
        if (list[i].draftId) { if (!round) frozenByShip++; continue; }
        // A forward move that lands in the cover gap between the two singles windows jumps to the
        // start of the next window instead (kept off the :00/:05 minute like everything else).
        let want = slotBetween(list[i - 1].minUtc, list[i + 1]?.minUtc);
        if (!inSinglesWindow(want)) { const next = SINGLES_WINDOWS.find((w) => w.startMin > want); want = next ? next.startMin + (next.startMin % 5 === 0 ? 1 : 0) : Infinity; }
        if (want <= hi) put(list[i], want);
      }
      if (!tight) break;
      list.sort((a, b) => a.minUtc - b.minUtc);
      for (let i = list.length - 2; i >= 0; i--) {
        if (list[i + 1].minUtc - list[i].minUtc >= gap) continue;
        if (list[i].draftId) continue;
        let want = list[i + 1].minUtc - gap - 1;
        if (!inSinglesWindow(want)) { const prev = [...SINGLES_WINDOWS].reverse().find((w) => w.endMin < want); want = prev ? prev.endMin - (prev.endMin % 5 === 0 ? 1 : 0) : -Infinity; }
        if (want >= lo && want < list[i].minUtc) put(list[i], want);
      }
    }
    list.sort((a, b) => a.minUtc - b.minUtc);
    for (let i = 1; i < list.length; i++) {
      if (list[i].minUtc - list[i - 1].minUtc < gap) {
        // The posts themselves, not labels: only the caller knows which account each belongs to.
        unresolved.push({ day, gap: list[i].minUtc - list[i - 1].minUtc, a: list[i - 1], b: list[i] });
      }
    }
  }
  return { nudged: moved.size, frozenByShip, unresolved };
}

async function main() {
  const WEEK = cliArg('week', nextMonday());
  const DAYS = Number(cliArg('days', 7));
  const ONLY = (cliArg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ENABLE_VOICE = process.argv.includes('--enable-voice');
  // PHASED ROLL-OUT (operator 2026-09-02): ship verbatim first. The classifier still runs and its
  // reading is recorded, so turning rewriting on later is one flag and no re-plan of the selection.
  const ALLOW_REWRITE = process.argv.includes('--allow-rewrite');
  const OUT = cliArg('out', join(HERE_DIR, 'queues', `singles-plan-${WEEK}.json`));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(WEEK)) { console.error('--week must be YYYY-MM-DD'); process.exit(2); }
  // --threads <occupancy.json | run plan>: steer clear of the minutes threads are really booked at
  // (bookedThreadMinutes); without it each page's grid minute stands in, as before.
  const threadMinutes = cliArg('threads', null) ? bookedThreadMinutes(JSON.parse(readFileSync(cliArg('threads'), 'utf8'))) : new Map();

  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);
  const healthBase = env.HEALTH_XDB_BASE_ID || 'appUkzz5Sq0vg3uiL';
  const at = airtable(env, healthBase);

  // A booster is a health theme page whatever its own niches (felicia's are Bloodsugar and Gut): it always takes singles.
  const accounts = Object.entries(ACCOUNTS)
    .filter(([k, a]) => a.plugHeavyExample && !a.paused && (isBooster(k) || (a.niches || []).some((n) => HEALTH_NICHES.includes(n))))
    .filter(([k]) => !ONLY.length || ONLY.includes(k));
  if (!accounts.length) { console.error('no accounts selected'); process.exit(2); }

  // Cover-slot minutes come from the FULL fleet list — accountSlots is index-based, so a filtered
  // list would move everyone's slot (slots.mjs:74, the 2026-08-20 incident).
  const fleetKeys = fleetSlotKeys(ACCOUNTS);

  const rows = await at.list(TABLES.healthTweets, {
    fields: ['Text', 'TweetID', 'Tweet URL', 'Handle', 'Impressions', 'Likes', 'Published Date', 'Media', 'Media Type', 'Video URL'],
    pageSize: 100, max: 20000,
  });

  const now = Date.now();
  const pool = [], rejects = new Map();
  // Per-source tallies for the priority creators only. The global reject map is keyed by reason
  // alone, so it cannot answer "did dr_ericberg reach the plan, and if not why not" — and a
  // priority source that is silently filtered out makes PRIORITY_SOURCES a knob that does nothing.
  const prioStats = Object.fromEntries(PRIORITY_SOURCES.map((h) => [h, { seen: 0, eligible: 0, rejects: {} }]));
  const built = rows.map((r) => {
    const f = r.fields || {};
    return {
      recId: r.id, tweetId: f.TweetID, url: f['Tweet URL'], source: f.Handle,
      text: f.Text || '', views: f.Impressions || 0, likes: f.Likes || 0,
      published: f['Published Date'], mediaType: f['Media Type'] || '', videoUrl: f['Video URL'] || '',
      // Airtable attachment URLs expire, so run-singles re-reads the row at publish time and only
      // uses these to know WHETHER there is media and how much.
      media: (f.Media || []).map((m) => ({ url: m.url, type: m.type, filename: m.filename })),
    };
  });
  // Jev reads the meaning (decisions/singles-screen.mjs): safety classes it can only add, topic classes
  // it decides. --no-jev keeps the regex answer alone.
  const jevReads = process.argv.includes('--no-jev') ? new Map() : await screenWithJev(built, env);
  for (const row of built) {
    const ps = prioStats[priorityHandle(row.source)];
    if (ps) ps.seen++;
    const why = singlesVerdict(row, jevReads.get(row.recId)).reason;
    if (why) {
      rejects.set(why, (rejects.get(why) || 0) + 1);
      if (ps) ps.rejects[why] = (ps.rejects[why] || 0) + 1;
      continue;
    }
    if (ps) ps.eligible++;
    row.ageDays = row.published ? (now - Date.parse(row.published)) / 864e5 : 0;
    const shape = classifyShape(row.text);
    const wanted = shape.mode === 'voice' && !ENABLE_VOICE ? 'paraphrase' : shape.mode;
    row.mode = ALLOW_REWRITE ? wanted : 'verbatim';
    row.shapeMode = wanted; // what the classifier WOULD have chosen, kept for when rewriting turns on
    row.shape = shape.why;
    pool.push(row);
  }
  // rank inside a bucket by reach; the bucket quota already carries the age preference
  if (SOURCES.length) {
    const want = new Set(SOURCES.map((h) => h.toLowerCase().replace(/^@/, '')));
    const before = pool.length;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!want.has(String(pool[i].source || '').toLowerCase())) pool.splice(i, 1);
    }
    console.log(`sources: ${SOURCES.join(', ')} — ${pool.length} of ${before} usable rows kept`);
  }
  const byReach = (x, y) => Math.log10(Math.max(1, y.views)) - Math.log10(Math.max(1, x.views));
  // The priority creators get their OWN list per bucket, not a sort key on the shared one. A sort
  // only puts them first ONCE: the selection cursor rolls forward across the whole run and never
  // rewinds, so after day one it has marched past them into the general mass and every remaining
  // priority row sits permanently behind it. Kim's first week came out 3/27 that way, with two
  // other creators on 7 each — the preference reporting a number that looked real.
  for (const b of AGE_QUOTAS) {
    const inBucket = pool.filter((r) => r.ageDays >= b.min && r.ageDays < b.max);
    b.prio = inBucket.filter((r) => priorityHandle(r.source)).sort(byReach);
    b.rows = inBucket.filter((r) => !priorityHandle(r.source)).sort(byReach);
  }

  const usedPath = join(HERE_DIR, 'queues', 'singles-used.json');
  const used = existsSync(usedPath) ? JSON.parse(readFileSync(usedPath, 'utf8')) : {};
  const onCooldown = (recId, key) => {
    const iso = used[recId]?.[key];
    return iso ? (now - Date.parse(iso)) / 864e5 < COOLDOWN_DAYS : false;
  };

  const depth = {};
  for (const r of pool) depth[r.source] = (depth[r.source] || 0) + 1;
  // The ceiling is what the per-day cap allows over the whole run. capPerCreator is 1 whenever the
  // roster has more creators than a day has posts, which is the normal case.
  const dayCap = perCreatorCap(POSTS_MAX, new Set(pool.map((r) => r.source)).size);
  const budgets = creatorBudgets(
    depth, accounts.length * DAYS * ((POSTS_MIN + POSTS_MAX) / 2),
    (h) => !!priorityHandle(h), accounts.length * DAYS * dayCap);
  const drawn = {};

  const cursors = Object.fromEntries(AGE_QUOTAS.flatMap((b) => [[b.key, 0], [`${b.key}!`, 0]]));
  const planned = new Map(); // recId -> Set(day)  — the one fleet rule: never twice on one day
  // ...and the same rule on what the READER sees. recId is not identity: CoachDanGo re-posts his
  // own lines with a word changed, so two different rows carry the same sentence. The 17-account
  // plan for 2026-09-14 put "Eating healthy is actually eating normally but most people think it's
  // dieting" on magnus AND camila on the 16th, byte for byte, and five more pairs like it. Someone
  // following two of our pages sees one post twice in a day, which is the exact thing the fleet
  // rule exists to stop — it was just checking the id instead of the words.
  const plannedText = new Map(); // day -> [text]
  const takenByAccount = new Map(); // key -> Set(recId) planned this run

  // The band travels WITH the plan. verify-singles carried its own copy of 3-5 and flagged all
  // eight 2-post days of the first --posts 2-3 week as critical — the checker was stale, the
  // drafts were exactly what was asked for. A constant in two files is a constant that will drift.
  const out = { week: WEEK, days: DAYS, postsPerDay: [POSTS_MIN, POSTS_MAX], generated: new Date().toISOString(), lane: 'single', accounts: [] };
  const allTimes = []; // for the fleet-wide minute-collision pass

  // MERGE into an existing plan for this week rather than replacing it. Two things break the moment
  // a second account joins a week, or a week is re-planned after a day has already shipped:
  //   - an account not named in --only would be dropped from the file along with its draft ids, and
  //     the next run for it would re-plan and double-book days that already have drafts;
  //   - a day that already carries drafts would be planned again from scratch. The shipped rows are
  //     on cooldown so they are not re-picked, but DIFFERENT rows are, with no draft id to skip on
  //     — so the account gets a second full day stacked on top of the first.
  // A day is frozen once any of its posts carries a draftId. Everything else re-plans freely.
  const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const priorAccounts = prior && prior.week === WEEK ? (prior.accounts || []) : [];
  const { shippedDays, carried } = mergePrior(priorAccounts, accounts.map(([k]) => k), planned, takenByAccount, plannedText);
  for (const a of carried) { out.accounts.push(a); allTimes.push(...(a.posts || [])); }

  // What OTHER weeks have already booked on these days. They are obstacles, not content: they go
  // into the collision pass and both halves of the fleet rule, and they lower this week's count on
  // the days they land on, but they are never written into this file — they live in theirs.
  const otherPlans = readdirSync(join(HERE_DIR, 'queues'))
    .filter((f) => /^singles-plan-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `singles-plan-${WEEK}.json`)
    .map((f) => { try { return JSON.parse(readFileSync(join(HERE_DIR, 'queues', f), 'utf8')); } catch { return null; } });
  const foreign = foreignBookings(otherPlans, WEEK, DAYS);
  const foreignByAccountDay = new Map(); // 'key|day' -> [minUtc]
  for (const q of foreign) {
    if (!planned.has(q.recId)) planned.set(q.recId, new Set());
    planned.get(q.recId).add(q.day);
    if (!plannedText.has(q.day)) plannedText.set(q.day, []);
    plannedText.get(q.day).push(q.text || q.sourceText || '');
    const k = `${q.key}|${q.day}`;
    if (!foreignByAccountDay.has(k)) foreignByAccountDay.set(k, []);
    foreignByAccountDay.get(k).push(q.minUtc);
    allTimes.push(q);
  }
  if (foreign.length) {
    const weeks = [...new Set(foreign.map((q) => q.fromWeek))].sort();
    console.log(`prior weeks [${weeks.join(', ')}] already hold ${foreign.length} booked post(s) inside ${WEEK}`);
  }
  const priorPostsFor = (key, day) =>
    (priorAccounts.find((a) => a.key === key)?.posts || []).filter((q) => q.day === day);

  for (const [key, acc] of accounts) {
    const [cover] = accountSlots(key, fleetKeys, 'cover');
    const coverMin = cover ? cover.h * 60 + cover.m : null;
    const rnd = rngFor(`${key}|${WEEK}`);
    const mine = takenByAccount.get(key) || new Set();
    takenByAccount.set(key, mine);
    // Same account, same week, the same post twice. recId dedup cannot see it, because the pool
    // holds a creator's own re-post as a SEPARATE row with its own tweet id: Rasmus drew "The
    // Average Person / The High Performer" verbatim on the 9th AND the 12th, and Kim drew "a sign
    // of fat loss is going to bed hungry" on the 9th and "...going to sleep hungry" on the 10th. A
    // reader sees one page repeating itself, which is the thing this whole lane exists to avoid.
    // Seeded from what the account already has in the week, so a re-plan cannot repeat a line a
    // frozen day already shipped.
    const myTexts = (priorAccounts.find((a) => a.key === key)?.posts || []).map((q) => q.text || q.sourceText || '').filter(Boolean);
    const entry = { account: acc.name, key, handle: acc.handle, socialSetId: acc.socialSetId, posts: [] };

    const frozen = shippedDays.get(key) || new Set();
    for (let d = 0; d < DAYS; d++) {
      const day = addDays(WEEK, d);
      if (frozen.has(day)) {
        // Already on Typefully. Carry it through exactly as it was scheduled.
        const kept = priorPostsFor(key, day);
        entry.posts.push(...kept);
        allTimes.push(...kept);
        // Consume exactly the draws this day would have made, so the days AFTER a frozen one keep
        // the clock a fresh plan of the same week would have given them. Skipping the draws would
        // shift the whole remaining sequence and quietly break "same week, same times".
        dayTimes(rnd, POSTS_MIN + Math.floor(rnd() * (POSTS_MAX - POSTS_MIN + 1)), coverMin);
        continue;
      }
      const drawnN = POSTS_MIN + Math.floor(rnd() * (POSTS_MAX - POSTS_MIN + 1));
      // The band is per account per DAY, across every plan that touches the day — not per plan.
      const alreadyBooked = foreignByAccountDay.get(`${key}|${day}`) || [];
      const threadMin = threadMinutes.get(`${key}|${day}`) ?? coverMin;
      // A booster's singles are its zig-zag S slots, always three, between its Article-DB and thread QRTs.
      const boosterTimes = isBooster(key) ? boosterSingleMinutes(key, day, threadMin) : null;
      const n = boosterTimes ? boosterTimes.length : drawnN;
      const times = boosterTimes || spreadAround(dayTimes(rnd, n, threadMin), alreadyBooked, n - alreadyBooked.length);
      const wantPerBucket = AGE_QUOTAS.map((b) => Math.round(b.share * n));
      let deficit = n - wantPerBucket.reduce((a, b) => a + b, 0);
      wantPerBucket[0] += deficit; // rounding lands on the oldest bucket, which is the point
      // How many distinct creators can actually serve this day. With the full roster this is well
      // above n, so the cap is 1 and behaviour is unchanged; with a single-creator allowlist it
      // rises to n and the day is simply that creator, spaced by INTRA_GAP_MIN.
      const availableCreators = new Set(AGE_QUOTAS.flatMap((b) => [...b.prio, ...b.rows]).map((r) => r.source)).size;
      const capPerCreator = perCreatorCap(n, availableCreators);
      const dayCreators = new Map(); // source -> count today
      let lastCreator = null;
      const picks = [];

      for (let bi = 0; bi < AGE_QUOTAS.length && picks.length < n; bi++) {
        for (let want = wantPerBucket[bi]; want > 0 && picks.length < n; want--) {
          const b = AGE_QUOTAS[bi];
          // Priority creators are offered first on every pick, then the general pool. They are
          // preferred, not exempted: dayCreators still caps each at one per account-day, so a day
          // takes at most one of each and the rest of the roster fills the remaining slots.
          const take = (list, ck, respectBudget) => {
            for (let scan = 0; scan < list.length; scan++) {
              const idx = (cursors[ck] + scan) % list.length;
              const cand = list[idx];
              if (mine.has(cand.recId)) continue;                     // already planned for this account
              if (onCooldown(cand.recId, key)) continue;              // posted here inside 90 days
              if (planned.get(cand.recId)?.has(day)) continue;        // THE fleet rule, by id
              if ((plannedText.get(day) || []).some((t) => textSimilarity(t, cand.text) >= NEAR_DUPLICATE)) continue; // ...and by words
              if ((dayCreators.get(cand.source) || 0) >= capPerCreator) continue; // per-creator day cap
              if (respectBudget && (drawn[cand.source] || 0) >= (budgets[cand.source] ?? Infinity)) continue; // spent their share
              if (myTexts.some((seen) => textSimilarity(seen, cand.text) >= NEAR_DUPLICATE)) continue; // said this already
              // Back-to-back only matters when someone else could take the slot instead.
              if (availableCreators > 1 && cand.source === lastCreator) continue;
              cursors[ck] = (idx + 1) % list.length;
              return cand;
            }
            return null;
          };
          // Budget first; then the same two lists again ignoring it, so a thin day still fills.
          // Budget first. Then the same lists ignoring it — but the GENERAL ROSTER FIRST on the way
          // back, because overflow handed to the priority list is exactly the over-draw the budget
          // exists to stop: dr_ericberg came back at 66 against a budget of 10 through this path.
          const chosen = take(b.prio, `${b.key}!`, true) || take(b.rows, b.key, true)
                      || take(b.rows, b.key, false) || take(b.prio, `${b.key}!`, false);
          if (!chosen) break; // bucket exhausted for this day; the next bucket covers the shortfall
          picks.push(chosen);
          mine.add(chosen.recId);
          myTexts.push(chosen.text);
          dayCreators.set(chosen.source, (dayCreators.get(chosen.source) || 0) + 1);
          drawn[chosen.source] = (drawn[chosen.source] || 0) + 1;
          lastCreator = chosen.source;
          if (!planned.has(chosen.recId)) planned.set(chosen.recId, new Set());
          planned.get(chosen.recId).add(day);
          if (!plannedText.has(day)) plannedText.set(day, []);
          plannedText.get(day).push(chosen.text);
        }
      }

      picks.forEach((p, i) => {
        const min = times[i] ?? times[times.length - 1];
        const post = {
          day, minUtc: min, at: utcAt(day, min), atSaigon: saigon(min),
          recId: p.recId, tweetId: p.tweetId, sourceUrl: p.url, sourceHandle: p.source,
          published: (p.published || '').slice(0, 10), ageDays: Math.round(p.ageDays),
          views: p.views, likes: p.likes, mediaType: p.mediaType, videoUrl: p.videoUrl, media: p.media,
          mode: p.mode, shape: p.shape, sourceText: p.text,
          // A verbatim post IS its source, so fill it here rather than making the operator run a
          // separate render stage to perform one assignment. Skipping that stage used to leave
          // text null and run-singles reported "not rendered yet, skipping" at exit 0 — a whole
          // day silently not created. Only a post awaiting a rewrite is left null now.
          text: p.mode === 'verbatim' ? p.text : null,
        };
        entry.posts.push(post);
        allTimes.push(post);
      });
    }
    out.accounts.push(entry);
  }

  // Fleet-wide minute collisions: Typefully publishes on its own polling tick, so two drafts booked
  // under MIN_SLOT_GAP_MIN apart can land in the same minute and the fleet reads as automation.
  const byDay = new Map();
  for (const p of allTimes) { if (!byDay.has(p.day)) byDay.set(p.day, []); byDay.get(p.day).push(p); }
  // A post that already carries a draft id is BOOKED ON TYPEFULLY. Moving it here changes nothing
  // but this file, so the plan quietly stops describing reality — which is exactly what happened
  // when 15 accounts joined the 2026-09-07 week: kim's and rasmus's shipped posts were nudged on
  // paper, their live drafts never moved, and verify reported twelve mismatches no one could act
  // on. Its neighbour still gets nudged away from it on the pass where the live post is the one
  // behind.
  const { nudged, frozenByShip, unresolved } = spaceOut(byDay);
  const ownerOf = new Map();
  for (const a of out.accounts) for (const q of a.posts) ownerOf.set(q, a.key);
  for (const q of foreign) ownerOf.set(q, `${q.key} (${q.fromWeek})`);
  const who = (q) => `${ownerOf.get(q) || '?'}${q.draftId ? ` draft ${q.draftId}` : ''}`;
  for (const u of unresolved) {
    console.log(`  ! ${u.day} — ${who(u.a)} at ${u.a.atSaigon} and ${who(u.b)} at ${u.b.atSaigon} are ${u.gap}m apart and neither can move`);
  }

  const total = out.accounts.reduce((a, x) => a + x.posts.length, 0);
  const modes = {}, buckets = { over1y: 0, '3to12m': 0, under3m: 0 }, sources = {}, chosen = {};
  for (const a of out.accounts) for (const p of a.posts) {
    modes[p.mode] = (modes[p.mode] || 0) + 1;
    sources[p.sourceHandle] = (sources[p.sourceHandle] || 0) + 1;
    const ph = priorityHandle(p.sourceHandle);
    if (ph) chosen[ph] = (chosen[ph] || 0) + 1;
    buckets[p.ageDays >= 365 ? 'over1y' : p.ageDays >= 90 ? '3to12m' : 'under3m']++;
  }
  // The breakdown is the health of the pool, and until now it lived only in a CI log that scrolls
  // away. Persist it next to the posts so the run can be audited after the fact.
  for (const h of PRIORITY_SOURCES) prioStats[h].chosen = chosen[h] || 0;
  // depth / budget / drawn side by side: the only view that shows a creator being drawn past what
  // they have, which is what the flat per-day cap was quietly doing at fleet scale.
  const share = Object.fromEntries(Object.keys(depth).sort((a, b) => depth[b] - depth[a])
    .map((h) => [h, { eligible: depth[h], budget: budgets[h] ?? null, drawn: drawn[h] || 0 }]));
  out.diagnostics = {
    rejects: Object.fromEntries(rejects), sources, modes, buckets, priority: prioStats, share,
    // Written even when empty, so its absence means an old plan file rather than a clean run.
    unresolvedCollisions: unresolved.map((u) => ({ day: u.day, gap: u.gap, a: who(u.a), b: who(u.b), at: u.a.atSaigon })),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`pool ${rows.length} rows -> ${pool.length} usable (${rows.length - pool.length} rejected)`);
  for (const [why, n] of [...rejects].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${why}`);
  console.log(`\n${total} posts · ${out.accounts.length} accounts · ${DAYS} days · week ${WEEK}`);
  console.log(`   modes:   ${Object.entries(modes).map(([k, v]) => `${k} ${v}`).join('  ')}${ALLOW_REWRITE ? '' : '  (verbatim-only: pass --allow-rewrite to enable rewriting)'}`);
  const prio = PRIORITY_SOURCES.reduce((n, h) => n + prioStats[h].chosen, 0);
  console.log(`   priority sources: ${prio}/${total}`);
  for (const h of PRIORITY_SOURCES) {
    const s = prioStats[h];
    const top = Object.entries(s.rejects).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([why, n]) => `${n} ${why}`).join(', ');
    console.log(`      ${h.padEnd(16)} ${String(s.chosen).padStart(3)} chosen  ${String(s.eligible).padStart(5)} eligible of ${s.seen} in pool${top ? `  — ${top}` : ''}`);
  }
  console.log(`   age mix: ${Object.entries(buckets).map(([k, v]) => `${k} ${Math.round(100 * v / total)}%`).join('  ')}  (target 60/30/10)`);
  console.log(`   ${nudged} time(s) nudged for fleet minute collisions${frozenByShip ? `, ${frozenByShip} left alone (already on Typefully)` : ''}`);
  console.log(`\nwrote ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'plan-singles');
