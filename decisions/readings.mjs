// decisions/readings.mjs — Jev READINGS that go through the one door (plan v7 N1, owner 2026-09-23:
// "scope a plan and implement plan to become jev native").
//
// These call sites ask Jev a battery and turn the answers into flags or a niche themselves; the code
// that reads the answers did not change. What changes is the door: each ask now runs through decide()
// (jev-decide.mjs askThrough), so it gets the decision log, the breaker, the per-call deadline, the
// pinned model and the hash lock on its question template like every other decision. The question
// sets are the call sites' own builders, byte for byte. ACTIONS is ['read']: a reading takes no action;
// its callers keep deciding what the answers mean.
import { draftQuestions, selectionQuestions } from '../scripts/run-jev.mjs';
import { finalCopyQuestions } from '../scripts/run-jev-final.mjs';
import { NICHE_QUESTIONS, SAFETY_QUESTIONS } from '../swipe-classify.mjs';
import { pointerQuestions, productFitQuestions } from '../product-fit.mjs';
import { BOUNDARY_QUESTIONS, CLIP_QUESTIONS, MAIN_IDEA_QUESTIONS, REEL_PICK_QUESTIONS, REEL_QUESTIONS, SUPPORT_QUESTIONS, focusQuestion } from '../clip-judge.mjs';
import { poolFitQuestions } from '../clip-pool.mjs';
import { IMAGE_QUESTIONS, MEDIA_QUESTIONS, subjectQuestion } from '../swipe-media.mjs';
import { HOOK_QUESTIONS } from '../hook-fingerprint.mjs';
import { LEAD_FOLLOW_QUESTIONS, LEAD_ORDER_QUESTIONS, LEAD_QUESTIONS } from '../lead-item.mjs';
import { noul } from '../jev.mjs';

/** A reading decision: the caller supplies { state, questions }; the template is what is hashed. */
export function reading(name, QUESTION_TEMPLATE) {
  return Object.freeze({
    name, ACTIONS: Object.freeze(['read']), HOLD: 'read', safety: false, QUESTION_TEMPLATE,
    stateOf: (input = {}) => {
      if (input.state == null) throw new Error(`${name}: no state`);
      return input.state;
    },
    questions: (_state, input = {}) => {
      if (!input.questions || !Object.keys(input.questions).length) throw new Error(`${name}: no questions`);
      return input.questions;
    },
    incumbent: async () => ({ action: 'read' }),
    policy: () => ({ action: 'read', confidence: 1 }),
  });
}

const TEMPLATE_TWEETS = ['{hook}', '{tweet 2} {{LINK}}', '{tweet 3}'];
const TEMPLATE_PRODUCTS = [{ asin: 'TEMPLATE', label: '{product}' }];

export const draftsRead = reading('drafts-read', draftQuestions({ tweets: TEMPLATE_TWEETS, products: TEMPLATE_PRODUCTS }).questions);
export const selectionRead = reading('selection-read', selectionQuestions());
export const finalRead = reading('final-read', finalCopyQuestions(TEMPLATE_TWEETS));
export const plugsRead = reading('plugs-read', Object.fromEntries(Object.entries(draftQuestions({ tweets: TEMPLATE_TWEETS, products: TEMPLATE_PRODUCTS }).questions).filter(([k]) => k.startsWith('plug_'))));
export const nicheTag = reading('niche-tag', NICHE_QUESTIONS);
export const nicheSafety = reading('niche-safety', SAFETY_QUESTIONS);

export const productFitRead = reading('product-fit-read', productFitQuestions([{ label: '{candidate}' }]));
export const productPointerRead = reading('product-pointer-read', pointerQuestions(TEMPLATE_TWEETS, [{ label: '{candidate}' }]));

// The /run media pass (scripts/run-media.mjs): clips matched to tweets (clip-find MATCH) and swipe-DB
// media (media-find). The callers build the questions and read the answers (clip-judge supportDecision,
// swipe-media mediaDecision / imageDecision); the door adds the log, breaker, pinned model and hash lock.
export const clipSupportRead = reading('clip-support-read', SUPPORT_QUESTIONS);
export const clipBoundaryRead = reading('clip-boundary-read', { ...SUPPORT_QUESTIONS, ...BOUNDARY_QUESTIONS });
// The hook's main idea (owner 2026-09-28): asked of the hook's on-point candidates the high bar held.
export const clipMainIdeaRead = reading('clip-main-idea-read', MAIN_IDEA_QUESTIONS);
// The clip pool (dispatch-only, plan v7 N1 closed 2026-09-25): MINE reads each candidate window, and the
// door check reads whether an episode fits the focus. Templates carry `{focus}` where the caller fills it.
export const clipMineRead = reading('clip-mine-read', { ...CLIP_QUESTIONS, focus: focusQuestion('{focus}') });
export const clipPoolRead = reading('clip-pool-read', poolFitQuestions('{focus}'));
// The IG Run's health reels (owner 2026-10-19: "shocking or high value … clip must be complete … just under 2
// minutes"): MINE with REEL_QUESTIONS over 45-115 s windows; clip-judge reelDecision decides.
export const reelMineRead = reading('reel-mine-read', { ...REEL_QUESTIONS, focus: focusQuestion('{focus}') });
// The reel pick (owner 2026-10-19: "optimize our clip selection and idea selection"): every mined reel, and the same
// reel with its lead-in trimmed, read for its first three seconds, payoff, reach and topic; igrun.mjs `rate` ranks on it.
export const reelPickRead = reading('reel-pick-read', REEL_PICK_QUESTIONS);
export const mediaPairRead = reading('media-pair-read', MEDIA_QUESTIONS);
export const mediaSubjectRead = reading('media-subject-read', subjectQuestion(['{phrase}']));
export const mediaImageRead = reading('media-image-read', IMAGE_QUESTIONS);

// Reverse-engineer virality (scripts/virality.mjs, owner 2026-09-24): each hook's shape and eleven checks,
// features for the fingerprint model; the model, not Jev, says what spreads.
export const hookRead = reading('hook-read', HOOK_QUESTIONS);

// The lead item (lead-item.mjs, owner 2026-09-28: "yes adopt fully — every numbered first tweet should have
// it implemented."): each list item alone under its hook, P(it makes readers open the thread). Code swaps
// the strongest item with item 1 when it beats item 1 by laws.json hook.leadItem.margin, unless Jev reads
// the list as a sequence (lead-order-read) or the item as leaning on a neighbour (lead-follow-read).
export const leadPullRead = reading('lead-pull-read', LEAD_QUESTIONS);
export const leadOrderRead = reading('lead-order-read', LEAD_ORDER_QUESTIONS);
export const leadFollowRead = reading('lead-follow-read', LEAD_FOLLOW_QUESTIONS);


// Flop research (scripts/flop-research.mjs, owner 2026-09-25: "track what flops (under 100k views)"): an
// LLM proposes yes/no questions each week and Jev answers them over a thread; code keeps only the ones
// that predict a flop beyond the page baseline. The questions change weekly, so the template is the shape.
export const flopRead = reading('flop-read', {
  q_template: noul('Does the thread {proposed question}?', { true: '{what a yes looks like}', false: '{what a no looks like}' }),
});

export const READINGS = Object.freeze([hookRead, draftsRead, selectionRead, finalRead, plugsRead, nicheTag, nicheSafety, productFitRead, productPointerRead,
  clipSupportRead, clipBoundaryRead, clipMainIdeaRead, mediaPairRead, mediaSubjectRead, mediaImageRead, flopRead, clipMineRead, reelMineRead, reelPickRead, clipPoolRead, leadPullRead, leadOrderRead, leadFollowRead]);

// Its own registry, loaded by askThrough when a reading is asked. Not in decisions/index.mjs: these
// templates import the /run scripts, and index.mjs is loaded by those scripts' own import graph
// (run-studio -> ... -> index would cycle through run-jev, a top-level-await deadlock).
export const READING_REGISTRY = Object.freeze(Object.fromEntries(READINGS.map((r) => [r.name, r])));
