// laws.mjs — the reader for laws.json, the single source of numeric law.
//
// Sixteen instruction-vs-check contradictions were found in two days (2026-08-17/18), and every one
// had the same anatomy: a rule stated in one file and restated in another, then changed in only one.
// The ceiling said 20 while a mold required 21+. The prompt said "exactly two plugs" while the
// outline planned five. The brief said VERBATIM while the gate demanded 85-90%. None of those can
// recur for a rule that lives here, because there is nothing to drift: consumers import the value.
//
// Deep-frozen so no consumer can quietly mutate a law at runtime — a mutated law would be the same
// bug wearing a new face.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const freeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
};

export const LAWS = freeze(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'laws.json'), 'utf8')));

// VOICE BLOCKS — fleet kill switch (operator 2026-09-03, TEMPORARY). When false, no prompt receives
// an account's `voice`. The data stays in accounts.mjs untouched; this is the only thing that
// decides whether it is sent. Lives here rather than in accounts.mjs on purpose: accounts.mjs does a
// top-level await fetch of the Airtable roster at import, and prompts.mjs must not pay a network
// round-trip to learn a boolean. Flip laws.json voiceBlocks.enabled to restore.
export const VOICE_BLOCKS_ON = LAWS.voiceBlocks?.enabled !== false;

// THE SIGN-OFF — fleet switch (owner R2026-09-26: "Content, then the disclaimer"). While it is off, no
// thread is given the account's `closing`: nothing appends it, no gate requires it, no repair restores
// it. The text stays on every account in accounts.mjs, because recognising it is a separate job
// (closingTexts): a draft written before the switch still reads as signed, so nothing stacks a
// second goodbye on it. Every place that ADDS or REQUIRES the sign-off asks signOffOf; none reads
// `account.closing` for that. Flip laws.json signOff.enabled to restore.
export const SIGN_OFF_ON = LAWS.signOff?.enabled !== false;
/** The sign-off this account's threads carry now: its `closing` while the switch is on, else ''. */
export const signOffOf = (account) => (SIGN_OFF_ON && account?.closing ? account.closing : '');
/** The tweets that close a thread after its content, in order: the sign-off (while on), then the disclaimer. */
export const closingTail = (account) => [signOffOf(account), account?.disclaimer].filter(Boolean);
