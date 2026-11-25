// decisions/reply-intent.mjs — what does the owner's reply at a /run stop say about each waiting row?
// Plan Track J "/run reply intent" and Track A3 "Reply parsing". SHADOW, and a GUARD THAT CAN ONLY WARN:
// the rung cap is propose, and even there consent is never recorded from a reading. The owner's words
// are the approval; run-studio records them verbatim, and this reading only prints a line beside it
// (scripts/reply-guard.mjs). A misread approval publishes, so nothing here can record, alter or block one.
//
// Input: { reply: string, rows: [{ id, label?, position? }], targets?: [id] }. `rows` are the rows
// waiting at the stop (a batch, or the stop itself); `targets` are the rows the agent is about to
// record (or just recorded) as approved, default every row. Labels are account/date/lane only, never copy.
//
// State: { reply, rows: { a: { id, label, position }, b: … } }. Letter keys, never digits: Jev is not
// asked to count (jev-lint.mjs). `position` is the row's place in the list the owner saw, computed in code,
// so "3 and 5 are fine" can be matched without Jev counting.
//
// Policy (numbers in laws.json `jev.decisions.reply-intent.thresholds`): PASS only when the intent is
// approve_all or approve_some, the consent noul is at least `consentPass`, no row's approval noul sits in
// the uncertain band [`bandLow`, `bandHigh`], and every target row reads `approves` above the band.
// Anything else is WARN with the rows that look unclear. A partial answer set is not read (decide()).
import { choice, noul } from '../jev.mjs';

export const name = 'reply-intent';
export const safety = false;
export const ACTIONS = Object.freeze(['pass', 'warn']);

export const INTENTS = Object.freeze(['approve_all', 'approve_some', 'hold', 'asks_for_change', 'unclear']);
export const APPROVE_INTENTS = Object.freeze(['approve_all', 'approve_some']);
export const ROW_READINGS = Object.freeze(['approves', 'holds', 'asks_for_change', 'unclear', 'not_mentioned']);

/** A batch holds at most 20 rows (run-studio submitBatch); two questions per row plus two keeps one call. */
export const ROW_KEYS = Object.freeze('abcdefghijklmnopqrst'.split(''));
export const MAX_REPLY_CHARS = 4000;
export const MAX_LABEL_CHARS = 80;

// ---- Questions (the reviewable set) -----------------------------------------------------------------
// Wording lifted from run-studio's verdict kinds (approve, hold, revise, swap) and the plan's row reading.
export const REPLY_QUESTIONS = Object.freeze({
  intent: choice('What does the owner\'s reply in `reply` do with the review rows listed in `rows`?', {
    approve_all: 'Approves every row in `rows` to go ahead as shown.',
    approve_some: 'Approves some rows to go ahead as shown, and holds, changes or leaves out others.',
    hold: 'Holds, stops or delays the rows, or says not yet, and approves none of them.',
    asks_for_change: 'Asks for edits, rewrites or swaps and approves none of the rows as shown.',
    unclear: 'A question, a comment or a hedge that neither clearly approves nor clearly holds anything.',
  }),
  consent: noul('Does `reply` give explicit consent to proceed with at least one row in `rows` as shown?', {
    true: 'Plain go-ahead words for the rows as they are, such as approve, yes go, ship it, these are fine, or a row named as good to go.',
    false: 'No go-ahead: a question, a hold, a change request, a hedge such as maybe or probably or I think, or only a comment on the copy.',
  }),
});

/** The two questions for the row under `rows.<key>`. */
export function rowQuestions(key) {
  const at = `\`rows.${key}\``;
  return {
    [`${key}_reading`]: choice(`What does \`reply\` say about the review row at ${at}? The owner may name it by its \`id\`, its \`label\` or its \`position\` in the list they saw, or speak to every row at once.`, {
      approves: 'Approves this row to go ahead as shown, by name, by position, or by approving every row.',
      holds: 'Holds, stops or delays this row.',
      asks_for_change: 'Asks for an edit, a rewrite or a swap on this row.',
      unclear: 'Speaks to this row, but it is not clear whether it approves, holds or asks for a change.',
      not_mentioned: 'Does not name this row, and does not speak to every row at once.',
    }),
    [`${key}_approved`]: noul(`Does \`reply\` approve the review row at ${at} to go ahead exactly as shown?`, {
      true: 'This row is approved as it is, by name, by position, or by a reply that approves every row.',
      false: 'This row is held, asked to change, not mentioned, or only commented on.',
    }),
  };
}

/** The hash-locked template: the fixed questions plus one row's (the key is the only variable). */
export const QUESTION_TEMPLATE = Object.freeze({ ...REPLY_QUESTIONS, ...rowQuestions('a') });

// ---- State ------------------------------------------------------------------------------------------
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function stateOf(input = {}) {
  const reply = String(input.reply ?? '').trim();
  if (!reply) throw new Error('reply-intent: empty reply');
  // A reply is never cut: a truncated reply can lose the words that hold a row. Too long is not read.
  if (reply.length > MAX_REPLY_CHARS) throw new Error('reply-intent: reply too long to read');
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length) throw new Error('reply-intent: no rows');
  if (rows.length > ROW_KEYS.length) throw new Error('reply-intent: too many rows for one reading');
  const ids = rows.map((r) => String(r?.id ?? '').trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('reply-intent: row ids must be unique and non-empty');
  return {
    reply,
    rows: Object.fromEntries(rows.map((r, i) => [ROW_KEYS[i], {
      id: ids[i],
      label: oneLine(r.label || ids[i], MAX_LABEL_CHARS),
      position: Number.isSafeInteger(r.position) && r.position > 0 ? r.position : i + 1,
    }])),
  };
}

export function questions(state) {
  return { ...REPLY_QUESTIONS, ...Object.assign({}, ...Object.keys(state.rows).map(rowQuestions)) };
}

// ---- Policy -----------------------------------------------------------------------------------------
/** Pure: each row's reading, keyed back to its id. */
export function readRows(answers, state) {
  return Object.entries(state.rows).map(([key, row]) => ({
    id: row.id,
    reading: answers[`${key}_reading`]?.choice ?? null,
    approved: answers[`${key}_approved`]?.noul ?? null,
  }));
}

/**
 * Pure. thresholds = laws.json `jev.decisions.reply-intent.thresholds` ({ consentPass, bandLow, bandHigh }).
 * Returns { action, confidence, intent, consent, unclear, notApproved, rows, reasons }. `unclear` lists
 * rows whose approval noul sits in the band, and target rows whose reading is `unclear`; `notApproved` lists target
 * rows Jev does not read as approved. Both are advisory: the caller prints them and records nothing.
 */
export function policy(answers, thresholds = {}, { state, input } = {}) {
  const { consentPass, bandLow, bandHigh } = thresholds;
  for (const [k, v] of Object.entries({ consentPass, bandLow, bandHigh })) {
    if (!Number.isFinite(v)) throw new Error(`reply-intent: thresholds.${k} is required`);
  }
  if (!state?.rows) throw new Error('reply-intent: policy needs the state');
  const intent = answers.intent?.choice;
  const consent = answers.consent?.noul;
  if (!INTENTS.includes(intent)) throw new Error(`reply-intent: unknown intent ${intent}`);
  if (!Number.isFinite(consent)) throw new Error('reply-intent: consent not read');
  const rows = readRows(answers, state);
  if (rows.some((r) => !ROW_READINGS.includes(r.reading) || !Number.isFinite(r.approved))) throw new Error('reply-intent: a row was not read');
  const ids = rows.map((r) => r.id);
  const targets = Array.isArray(input?.targets) && input.targets.length ? input.targets.map((t) => String(t).trim()) : ids;
  const unknown = targets.filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error('reply-intent: a target is not among the rows');

  // The band applies to every row (plan: "no row noul in 0.3-0.7": a reply that is half-sure about any
  // row is not a clear reply); an `unclear` reading counts only on a row being recorded.
  const inBand = (p) => p >= bandLow && p <= bandHigh;
  const unclear = rows.filter((r) => inBand(r.approved) || (targets.includes(r.id) && r.reading === 'unclear')).map((r) => r.id);
  const notApproved = rows.filter((r) => targets.includes(r.id) && !unclear.includes(r.id)
    && !(r.approved > bandHigh && r.reading === 'approves')).map((r) => r.id);

  const reasons = [];
  if (!APPROVE_INTENTS.includes(intent)) reasons.push(`intent reads as ${intent}`);
  if (consent < consentPass) reasons.push(`explicit consent ${consent.toFixed(2)} is below ${consentPass}`);
  if (unclear.length) reasons.push(`unclear for ${unclear.join(', ')}`);
  if (notApproved.length) reasons.push(`not read as approved: ${notApproved.join(', ')}`);
  return {
    action: reasons.length ? 'warn' : 'pass', confidence: consent,
    intent, consent, targets, unclear, notApproved, rows, reasons,
  };
}

/**
 * Today's path: the agent records the owner's words as given, with no reading. The guard never changes
 * that; in shadow decide() returns this action and the reading rides beside it as `jevAction`.
 */
export function incumbent() {
  return { action: 'pass' };
}
