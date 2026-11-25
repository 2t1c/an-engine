// decisions/index.mjs — the decision registry. One module per decision (decisions/<name>.mjs), each
// exporting { name, ACTIONS, QUESTIONS | questions(state, input) + QUESTION_TEMPLATE, stateOf(input),
// policy(answers, thresholds, { input, state }) -> { action, confidence }, incumbent(input) -> { action },
// safety?, HOLD? }. jev-decide.mjs validates the contract; laws.json `jev.decisions.<name>` holds the
// mode, thresholds and recorded question-set hash. Add a decision here and in laws.json together
// (docs/typesafe-jev.md "Decision platform").
import { validateDecision } from '../jev-decide.mjs';
import * as claimsBattery from './claims-battery.mjs';
import * as ctaRecipeStamp from './cta-recipe-stamp.mjs';
import * as donorAccountFit from './donor-account-fit.mjs';
import * as donorScreen from './donor-screen.mjs';
import * as donorWriteability from './donor-writeability.mjs';
import * as productFitHeavy from './product-fit-heavy.mjs';
import * as productSecondEarned from './product-second-earned.mjs';
import * as replyIntent from './reply-intent.mjs';
import * as editorialPrescore from './editorial-prescore.mjs';
import * as topicStamp from './topic-stamp.mjs';
import * as premiseTwin from './premise-twin.mjs';
import * as hookCandidate from './hook-candidate.mjs';
import * as singlesScreen from './singles-screen.mjs';
import * as plugAnchor from './plug-anchor.mjs';
import * as itemSwap from './item-swap.mjs';
import * as ctaDepth from './cta-depth.mjs';
import * as ruleProposal from './rule-proposal.mjs';
import * as booksCategory from './books-category.mjs';
import * as hookBankCurate from './hook-bank-curate.mjs';
import * as donorIntent from './donor-intent.mjs';
import * as potRead from './pot-read.mjs';
import * as modelRoute from './model-route.mjs';
import * as plugReplacement from './plug-replacement.mjs';
import * as plugFill from './plug-fill.mjs';
import * as aieLane from './aie-lane.mjs';
import * as aieRewrite from './aie-rewrite.mjs';
import * as qrtTemplate from './qrt-template.mjs';

const MODULES = [productFitHeavy, productSecondEarned, editorialPrescore, claimsBattery, topicStamp, ctaRecipeStamp, donorAccountFit, donorWriteability, donorScreen, replyIntent, premiseTwin, hookCandidate, singlesScreen, plugAnchor, itemSwap, ctaDepth, ruleProposal, booksCategory, hookBankCurate, donorIntent, potRead, modelRoute, plugReplacement, plugFill, aieLane, aieRewrite, qrtTemplate];

export const DECISIONS = Object.freeze(Object.fromEntries(MODULES.map((m) => [validateDecision(m).name, m])));

export const decisionNames = () => Object.keys(DECISIONS);
