// copy-change.mjs — what publishing does to a thread's copy, and what kind of change an edit is.
//
// Owner, 2026-09-23 (the R2026-09-23 post-mortem): a trailing space held jasper's thread, and one
// tweak forced a whole-batch resubmit. The publisher already reflows spacing and adds clara's site
// tweet, so a spacing or formatting edit changes nothing that ships. This module is the ONE
// definition of that reflow: publish-thread.mjs calls publishCopy to build the tweets it ships, and
// the change classifier hashes the same function's output. Equal normalized hashes therefore prove
// that the published words are identical; there is no second, hand-kept normaliser to drift.
import { createHash } from 'node:crypto';
import { normalizePlugStructure, stripEmDash } from './checks.mjs';
import { withSiteCta } from './platforms.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * PURE. The tweets publish-thread ships for `tweets`: the em-dash sweep everywhere, the canonical
 * plug structure on any tweet carrying one of the products' links, then the account's own-site line.
 * `plugLinks` are the minted product links; `account` is the accounts.mjs entry (siteCta et al.).
 */
export function publishCopy(tweets, { plugLinks = [], account = null } = {}) {
  const links = (plugLinks || []).filter(Boolean);
  return withSiteCta((tweets || []).map((t) => {
    const s = stripEmDash(String(t));
    return links.some((l) => s.includes(l)) ? normalizePlugStructure(s) : s;
  }), account);
}

/** PURE. The exact copy digest, identical to run-content-packets draftCopyDigest and run-review-drafts tweetsSha256. */
export const copySha256 = (tweets) => sha256(JSON.stringify((tweets || []).map(String)));
/** PURE. The digest of what would publish. Equal for two copies ⇒ no published word differs. */
export const normalizedCopySha256 = (tweets, opts = {}) => copySha256(publishCopy(tweets, opts));
/** PURE. Whitespace-insensitive digest: every run of whitespace is one space, tweet ends trimmed. */
export const spacingCopySha256 = (tweets) => copySha256((tweets || []).map((t) => String(t).replace(/\s+/g, ' ').trim()));

/** PURE. Tweets with every tracking link and every unminted {{LINK}} token replaced by one marker: a
 *  review draft written before minting and the minted ship copy compare equal on everything else. */
// A link ends before trailing punctuation ("{{LINK}}." must equal "https://lvnta.com/x."), every
// tracking host counts (Levanta, Amazon short links), and blank tweets are dropped on both sides
// because the review draft never carries them (run-review-drafts drops empty posts).
const TRACKING = /(?:https?:\/\/)?(?:www\.)?(?:lvnta\.com|amzn\.to|a\.co|levanta\.io)\/[^\s]*?(?=[.,;:!?)\]]*(?:\s|$))/gi;
export const trackingNeutral = (tweets) => (tweets || []).map((t) => String(t)
  .replace(TRACKING, '<TRACKING_LINK>')
  .replace(/\{\{LINK\d*\}\}/g, '<TRACKING_LINK>'))
  .filter((t) => t.trim());

export const CHANGE_KINDS = ['none', 'spacing', 'formatting', 'words'];

/**
 * PURE. Classify an edit from `before` to `after` (arrays of tweet strings):
 *   none        byte-identical
 *   spacing     only whitespace differs, and what publishes is identical
 *   formatting  what publishes is identical (the publisher's own reflow: plug spacing, bullet and
 *               list markers on a plug, dash sweep, the site line) but more than whitespace differs
 *   words       what publishes differs — review and approval re-open as before
 * A pure whitespace edit that the publisher does NOT reflow (a content tweet's inner spacing) still
 * ships differently, so it is `words`: the classifier is exactly as permissive as publishing is.
 */
export function classifyCopyChange(before, after, opts = {}) {
  const a = (before || []).map(String), b = (after || []).map(String);
  const digests = { before: copySha256(a), after: copySha256(b),
    normalizedBefore: normalizedCopySha256(a, opts), normalizedAfter: normalizedCopySha256(b, opts) };
  if (digests.before === digests.after) return { kind: 'none', ...digests };
  if (digests.normalizedBefore !== digests.normalizedAfter) return { kind: 'words', ...digests };
  return { kind: spacingCopySha256(a) === spacingCopySha256(b) ? 'spacing' : 'formatting', ...digests };
}

/**
 * PURE. Classify from two digest triples alone (a packet marker carries these, never the copy):
 * { copySha256, spacingCopySha256, normalizedCopySha256 }. Missing digests read as `words`.
 */
export function classifyDigests(before = {}, after = {}) {
  const ok = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (![before.copySha256, after.copySha256, before.normalizedCopySha256, after.normalizedCopySha256].every(ok)) return 'words';
  if (before.copySha256 === after.copySha256) return 'none';
  if (before.normalizedCopySha256 !== after.normalizedCopySha256) return 'words';
  return ok(before.spacingCopySha256) && before.spacingCopySha256 === after.spacingCopySha256 ? 'spacing' : 'formatting';
}

/** The owner's intake answer on what re-opens approval: 'words' (default) or 'any'. */
export const EDIT_POLICIES = ['words', 'any'];
export function editsPolicyOf(intake) {
  const value = intake?.content?.edits;
  return EDIT_POLICIES.includes(value) ? value : 'words';
}
/** PURE. Does this change keep an approval under `policy`? Only a non-words change under 'words'. */
export const keepsApproval = (kind, policy = 'words') => kind === 'none' || (policy === 'words' && (kind === 'spacing' || kind === 'formatting'));
