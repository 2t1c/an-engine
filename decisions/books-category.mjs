// decisions/books-category.mjs — which chart-of-accounts line does an uncategorised bank row belong to?
// (plan L "Books uncategorised rows"; v7 N2; owner, 2026-09-23: "become jev native".)
//
// books-weekly.mjs suggestAccounts asked an LLM for a JSON array of accounts and "why" notes and
// parsed it; a malformed reply meant no suggestions at all. It is a classification, so Jev answers it:
// a choice over the chart of accounts plus TRANSFER plus "?" per row. Below the confidence floor the
// suggestion is "?". ADVISORY ONLY, as before: the digest shows it beside the row and a human writes
// the rule into books-rules.json.
//
// Input: { description, accounts: [string] }.
import { choice } from '../jev.mjs';

export const name = 'books-category';
export const ACTIONS = Object.freeze(['suggest', 'unsure']);
export const HOLD = 'unsure';
export const safety = false;

const CONTEXT = 'a bank-statement row of a small US media business: X/Twitter growth pages earning affiliate commission (Levanta), an RT (retweet) service billed to clients through Stripe, Gumroad ebooks, boost vendors paid per post, LLM API bills, SaaS subscriptions. The row ends with a [tag] naming the mechanism.';
export const TRANSFER = 'TRANSFER';
export const UNSURE = '?';

export function questions(_state, input = {}) {
  const options = Object.fromEntries((input.accounts || []).map((a) => [String(a), null]));
  options[TRANSFER] = 'Not an account: the business moving its OWN money between its own accounts (a payout, a sweep, a top-up, a currency conversion leg).';
  options[UNSURE] = 'None of the accounts fits.';
  return { account: choice(`Which account does \`row\` belong to? It is ${CONTEXT}`, options) };
}
export const QUESTION_TEMPLATE = questions(null, { accounts: ['{account}'] });

export function stateOf(input = {}) {
  const row = String(input.description ?? '').trim().slice(0, 300);
  if (!row) throw new Error('books-category: no description');
  if (!(input.accounts || []).length) throw new Error('books-category: no chart of accounts');
  return { row };
}

/** No code incumbent: before Jev the suggestion was an LLM's. */
export async function incumbent() { return { action: 'unsure' }; }

/** Pure. thresholds: { floor }. Returns { action, confidence, account }. */
export function policy(answers, thresholds) {
  const a = answers?.account;
  if (!Number.isFinite(thresholds?.floor)) throw new Error('books-category: thresholds.floor is required');
  if (typeof a?.choice !== 'string') throw new Error('books-category: no answer');
  const sure = a.choice !== UNSURE && a.confidence >= thresholds.floor;
  return { action: sure ? 'suggest' : 'unsure', confidence: +(a.confidence ?? 0).toFixed(4), account: sure ? a.choice : UNSURE };
}
