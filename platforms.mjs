// platforms.mjs — build the `platforms` object every Typefully write sends.
//
// Typefully takes a draft's target platforms as one object: { x: {...}, threads: {...}, ... }. A
// PATCH REPLACES that object rather than merging into it, which is the trap this module exists to
// close. Thirteen call sites used to hardcode `platforms: { x: { enabled: true, posts } }`, so the
// moment a draft was cross-posted anywhere, the next repair, media pass or link swap silently
// switched the second platform back off — with no error and nothing in the diff to notice.
//
// So: one builder, used everywhere. It reads the account's cross-post list for CREATES, and carries
// the draft's own platform flags forward on EDITS.

// The platforms Typefully exposes besides x. Anything not in here is ignored rather than guessed at.
export const CROSS_POST_PLATFORMS = ['threads', 'linkedin', 'mastodon', 'bluesky', 'substack'];

// ---- PER-PLATFORM TRACKING (operator 2026-08-21) -------------------------------------------------
// Levanta reports on SUBIDS, not referrers. It has no idea a click came from Threads rather than X,
// and it never will — so the only way to split platform revenue is to give each platform its own
// tracked link. Until now the cross-post carried a byte-identical copy of the X posts, same URL and
// all, which makes the two feeds physically indistinguishable in every report we have.
//
// The convention mirrors the one that already works: the light plug's subid is the heavy's plus
// "-b", so a Threads link's subid is the X subid plus "-th". The Levanta source report then splits
// the platforms on its own, with no new infrastructure and no new report to build.
export const PLATFORM_SUBID_SUFFIX = { threads: '-th', linkedin: '-li', mastodon: '-ma', bluesky: '-bs', substack: '-ss' };
export const platformSubid = (subid, platform) => `${subid}${PLATFORM_SUBID_SUFFIX[platform] || ''}`;

// Pure: rewrite the tracked links inside a post array. `linkMap` is oldUrl -> newUrl; anything not
// in the map is left exactly as it was, so an untracked link or a plain reference never gets touched.
// Returns a NEW array — the caller's X posts must not be mutated into the Threads copy.
export function swapPostLinks(posts, linkMap = {}) {
  const pairs = Object.entries(linkMap).filter(([a, b]) => a && b && a !== b);
  if (!pairs.length) return posts.map((p) => ({ ...p }));
  return posts.map((p) => {
    let text = String(p.text ?? '');
    for (const [from, to] of pairs) text = text.split(from).join(to);
    return { ...p, text };
  });
}

// Pure: the platforms payload for a write. Exported for tests.
//   posts        — the X post array (text + media_ids)
//   account      — the account row; its `crossPost` names the extra platforms to enable on a CREATE
//   existing     — the draft's CURRENT platforms object on an EDIT. When given, it is the authority:
//                  a platform already enabled on the draft stays enabled, whatever the account says,
//                  because the operator may have toggled it by hand in Typefully.
//   platformPosts— { threads: [...] } to send a platform its OWN posts instead of a copy of X's.
//                  This is how per-platform tracked links reach the cross-post. A platform with no
//                  entry falls back to the X posts, which is the old shared-link behaviour: correct
//                  copy, but its clicks are then indistinguishable from X's in every report.
//   enable       — platforms to turn ON during an EDIT, the one deliberate way past the rule below.
//                  A BACKFILL needs it and nothing else does: when a page's Threads profile is
//                  connected after its drafts were written, those drafts target X alone forever,
//                  because `existing` is authority and the account's list is never consulted on an
//                  edit. That rule is load-bearing — every repair tool patches with `{ existing }`,
//                  and without it the media pass, QC or a link swap would silently flip a platform.
//                  So the door is NAMED rather than opened: a caller that means to add a platform
//                  says so, and a caller that does not still cannot. (marcos + lucas, 2026-09-07)
export function buildPlatforms(posts, { account = null, existing = null, platformPosts = null, enable = null } = {}) {
  // Every enabled platform carries its OWN copy of the posts. Typefully rejects the flag alone:
  //   422 platforms.threads — "posts is required when enabled is true"
  // The cross-posted copy is the same text as X apart from its tracked links (see platformPosts).
  // That is deliberate rather than a limitation: Threads allows 500 characters where X allows 280,
  // so our copy always fits, and holding the COPY constant while varying only the link is what makes
  // the platform comparison honest — any difference in conversion is the audience, not the writing.
  // A platform's posts come from platformPosts when the caller has them, then from what the draft
  // ALREADY carries, and only then from X's copy.
  //
  // That middle step is the one that matters and it was missing. Every repair tool — the media pass,
  // qc, link-sentinel, swap-product, fix-draft — patches with `{ existing }` and no platformPosts,
  // because none of them know about per-platform links. Falling straight back to `posts` meant each
  // of them silently overwrote the cross-post's own tracked links with X's, undoing the split the
  // moment anything touched the draft. Julian 10520126 lost it to the media pass seconds after
  // creation, on the first thread the feature ever ran on.
  const on = (p) => { out[p] = { enabled: true, posts: platformPosts?.[p] || existing?.[p]?.posts || posts }; };
  const out = { x: { enabled: true, posts } };
  // EDIT: carry forward whatever the draft already targets. Never demote a platform the draft has.
  if (existing) {
    for (const p of CROSS_POST_PLATFORMS) if (existing[p]?.enabled) on(p);
    for (const p of (enable || [])) if (CROSS_POST_PLATFORMS.includes(p)) on(p);
    return out;
  }
  // CREATE: the account's own configuration decides.
  for (const p of account?.crossPost || []) if (CROSS_POST_PLATFORMS.includes(p)) on(p);
  return out;
}

// Pure: which extra platforms will this write actually target? For logging, so a cross-post is
// visible in a run's output instead of being an invisible field in a JSON body.
export function crossPostedTo(platformsObj) {
  return CROSS_POST_PLATFORMS.filter((p) => platformsObj?.[p]?.enabled);
}

/** Every http(s) URL in a post array, in order. Deliberately NOT limited to lvnta: an account with
 *  `directLink` carries an Amazon attribution URL instead, and a site CTA or source reference is a
 *  plain link. Pairing positionally over ALL urls lets the untracked ones pair with themselves and
 *  drop out (swapPostLinks filters a === b), so this needs no list of which hosts are tracked. */
const urlsOf = (posts) => (posts || []).flatMap((p) => String(p?.text ?? '').match(/https?:\/\/\S+/g) || []);

/**
 * Carry a REPAIRED X copy's text onto every cross-posted platform, keeping each platform's own
 * tracked links. The mirror image of media.mjs's mediaAcrossPlatforms: that one carries media and
 * preserves text, this one carries text and preserves links.
 *
 * WHY THIS EXISTS (2026-08-31). buildPlatforms' `existing` fallback writes a cross-post back
 * byte-identical, which is right for links — it is what stopped repair tools clobbering the "-th"
 * split — but it means no repair to X ever reaches the copy. Eight write paths patch with
 * `{ existing }` and nothing else, so qc's added affiliate disclosure, a product swap, a re-minted
 * dead link and every structural fix landed on X alone while Threads kept the version we had already
 * rejected. Julian's draft 10243320 PUBLISHED with 11 posts on X and 9 on Threads.
 *
 * Pairing is by link ORDER, never post index, so a repair that adds or removes a post still maps.
 *
 * A platform is SKIPPED, not guessed at, when either:
 *   - its url count differs from X's, so the pairing is ambiguous; or
 *   - the repair introduced a url neither copy had, i.e. a fresh mint with no counterpart.
 * The second is the important one. Letting it through would write X's tracked link into the Threads
 * copy and collapse the split — and a collapsed draft is unmeasurable while looking identical to a
 * healthy one in every report. Stale text is visible and recoverable; a silent merge is neither.
 * Callers that legitimately introduce links (swap-product, link-sentinel) must mint the platform's
 * own link via cross-post-links.mjs rather than lean on this.
 *
 * Pure. Returns { platformPosts, skipped } — platformPosts is null when there is nothing to carry,
 * so a caller can hand it straight to buildPlatforms and fall back to `existing` exactly as before.
 */
// A CROSS-POSTED COPY IS NOT AN X POST. Typefully's per-platform post schemas are strict and
// reject unknown keys outright — an X post carries `quote_post_url`, `reply_settings`,
// `made_with_ai`, `paid_partnership` and `subscribers_only`, and every one of those is
// `422 Extra inputs are not permitted` on threads/linkedin/mastodon/bluesky/substack:
//
//   platforms.threads.posts.0.quote_post_url — "Extra inputs are not permitted"
//
// So carrying X's post objects across verbatim fails the whole PATCH. This was invisible for as
// long as rebuildCrossPosts had no production caller: its tests build bare `{ text }` objects,
// which carry no X-only field, so they passed against a shape the API never sees. Found 2026-09-19
// the first time it was run against real drafts — all 15 rejected, nothing written.
//
// LinkedIn's reshare target is the one field the target has and X does not, so it is carried
// forward from the copy's own post rather than dropped. Index pairing is safe for it alone and
// only where the counts line up; the TEXT pairing that matters is still by link order.
const CROSS_POST_FIELDS = ['text', 'media_ids', 'hide_link_preview'];

export function crossPostShape(post, platform, was = null) {
  const out = {};
  for (const k of CROSS_POST_FIELDS) if (post?.[k] !== undefined) out[k] = post[k];
  if (platform === 'linkedin' && was?.linkedin_reshare_target != null) out.linkedin_reshare_target = was.linkedin_reshare_target;
  return out;
}

export function rebuildCrossPosts(newPosts, existing) {
  const oldX = urlsOf(existing?.x?.posts);
  const fresh = urlsOf(newPosts);
  const platformPosts = {};
  const skipped = [];
  for (const p of CROSS_POST_PLATFORMS) {
    const pf = existing?.[p];
    if (!pf?.enabled || !Array.isArray(pf.posts)) continue;
    const theirs = urlsOf(pf.posts);
    if (theirs.length !== oldX.length) { skipped.push({ platform: p, reason: 'url-count', had: theirs.length, x: oldX.length }); continue; }
    const introduced = fresh.filter((u) => !oldX.includes(u) && !theirs.includes(u));
    if (introduced.length) { skipped.push({ platform: p, reason: 'new-link', urls: [...new Set(introduced)] }); continue; }
    const map = {};
    oldX.forEach((u, i) => { if (u !== theirs[i]) map[u] = theirs[i]; });
    const swapped = swapPostLinks(newPosts, map);
    platformPosts[p] = swapped.map((post, i) => crossPostShape(post, p, pf.posts[i]));
  }
  return { platformPosts: Object.keys(platformPosts).length ? platformPosts : null, skipped };
}

// ---- SITE CTA -----------------------------------------------------------------------------------
// An account may end its threads by pointing at its own site (Clara, operator 2026-08-20). This is
// FIRST-PARTY: no affiliate disclosure, not a tracked plug, never counted against the plug budget.
//
// Position is the whole trick. The account closing and the legal disclaimer are matched by STRICT
// equality and the disclaimer must be the final tweet, so the site line goes immediately BEFORE the
// sign-off — never after it, and never appended to the end.
//
// Pure and idempotent: running it twice does not produce two site tweets, which matters because
// repair and QC passes re-run over drafts that already have one.
export function withSiteCta(tweets, account) {
  const cta = account?.siteCta;
  if (!cta) return [...tweets];
  const out = [...tweets];
  if (out.some((t) => String(t).trim() === cta.trim())) return out;   // already present
  const closeAt = account.closing ? out.indexOf(account.closing) : -1;
  const discAt = account.disclaimer ? out.indexOf(account.disclaimer) : -1;
  // Before the sign-off; failing that before the disclaimer; failing both, at the end.
  const at = closeAt >= 0 ? closeAt : (discAt >= 0 ? discAt : out.length);
  out.splice(at, 0, cta);
  return out;
}
