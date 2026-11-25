// disclosure.mjs — the affiliate disclosure token, in one place.
//
// Operator 2026-08-21: plugs disclose with `#ad` instead of `Aff link:`. The token appears in ~380
// places across generation, repair, QC, validation, prompts, per-account plug templates and docs,
// which is exactly why it lives here now rather than as a string literal in each of them.
//
// The split below is the whole point, and getting it backwards breaks the archive:
//
//   EMIT   — what we write today. One form: `#ad`.
//   ACCEPT — what still counts as a disclosed plug. BOTH forms, forever. Hundreds of live and
//            scheduled drafts carry `Aff link:`, harvested donor threads carry it, and the ledger
//            joins on plug POSITION which several detectors derive from the disclosure line. Narrow
//            the accept side to `#ad` and every one of those threads reads as an undisclosed plug:
//            QC "repairs" them by injecting a second disclosure, metrics counts zero plugs, and
//            validate-thread fails drafts that are actually fine.
//
// So: never write `Aff link` again, never stop reading it.

// What generation emits. No trailing colon — it is a hashtag, and `#ad:` reads as part of the tag.
export const DISCLOSURE = '#ad';

// What counts as disclosed. Covers the current token, the retired one, and the looser words the
// gates have always accepted ("affiliate", "commission", "paid") so a hand-written variant still
// passes. `#ad\b` rather than `#ad` so it does not fire inside `#adhd` or `#advice`.
export const DISCLOSURE_RE = /#ad\b|aff\s*link|affiliate|commission|paid/i;

// The tighter form, for code that locates the disclosure LINE inside a plug (the pivot the 5-line
// plug shape is measured from). Deliberately excludes "paid"/"commission", which appear in ordinary
// body copy ("paid attention", "commission a study") and would pick the wrong line.
export const DISCLOSURE_LINE_RE = /#ad\b|aff\s*link|affiliate/i;

// The retired token, for code that specifically needs to recognise or migrate legacy drafts.
export const LEGACY_DISCLOSURE_RE = /\(?\s*aff\s*link\s*\)?\s*:?/i;

// The disclosure + link block a plug ends on: token alone, one blank line, then the bare URL.
// The blank line is load-bearing — Typefully renders the link card off the final line, and a
// stacked "#ad https://..." suppresses it.
export function discloseBlock(link) {
  return `${DISCLOSURE}\n\n${link}`;
}

// Is this text already disclosed? Use everywhere instead of an inline regex, so widening the
// accepted set later is one edit rather than forty.
export function isDisclosed(text, { own = false } = {}) {
  const s = String(text || '');
  return DISCLOSURE_RE.test(s) || (own && /get it here/i.test(s));
}
