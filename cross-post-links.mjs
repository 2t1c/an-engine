// cross-post-links.mjs — give each cross-posted platform its OWN tracked link.
//
// Levanta reports on SUBIDS, never on referrers. It cannot tell a Threads click from an X click and
// it never will, so the only way to split platform revenue is to hand each platform a different
// link. Until now the cross-post carried a byte-identical copy of the X posts, same URL and all,
// which made the two feeds physically indistinguishable in every report we have — the reason
// "how many clicks came from Threads" had no answer on 2026-08-27.
//
// The convention already existed in platforms.mjs and nothing called it: a Threads link's subid is
// the X subid plus "-th", mirroring the light plug's "-b". Levanta's own source report then splits
// the platforms with no new infrastructure and no new report to build.
//
// THE COPY IS HELD CONSTANT. Only the links differ between platforms. That is deliberate: it makes
// any difference in conversion a fact about the audience rather than about the writing.
import { levanta } from './lib.mjs';
import { platformSubid, swapPostLinks, CROSS_POST_PLATFORMS } from './platforms.mjs';

/**
 * Mint a per-platform link for every product and return the posts each platform should carry.
 *
 * FAIL SOFT, ALWAYS. A mint failure returns no entry for that platform, which falls back to the X
 * posts — the old shared-link behaviour: correct copy, unattributable clicks. Losing the platform
 * split is a reporting loss; blocking the publish over it would be a revenue loss, and a cross-post
 * that does not go out is strictly worse than one we cannot measure.
 *
 * @param products [{ asin, link, subid1 }] — the X links already minted for this draft
 * @returns { platformPosts, minted } — minted is [{ platform, asin, subid1, link }] for the ledger
 */
export async function crossPostLinks(env, account, posts, products, { platforms = null } = {}) {
  const targets = (platforms || account?.crossPost || []).filter((p) => CROSS_POST_PLATFORMS.includes(p));
  const usable = (products || []).filter((p) => p?.link && p?.subid1 && p?.asin);
  if (!targets.length || !usable.length) return { platformPosts: null, minted: [] };

  const lev = levanta(env);
  const platformPosts = {};
  const minted = [];
  for (const platform of targets) {
    const linkMap = {};
    let failed = false;
    for (const p of usable) {
      const subid1 = platformSubid(p.subid1, platform);
      try {
        const m = await lev.mintLink(p.asin, subid1, account.levantaSubidPrefix);
        const url = account.directLink ? (m.url || m.mobileOptimizedUrl) : (m.mobileOptimizedUrl || m.url);
        if (!url) throw new Error('mint returned no url');
        linkMap[p.link] = url;
        minted.push({ platform, asin: p.asin, product: p.title || '', subid1, link: url });
      } catch (e) {
        console.warn(`  ⚠ ${platform} link for ${p.asin}: ${String(e.message).slice(0, 60)}`);
        failed = true;
      }
    }
    // ALL OR NOTHING PER PLATFORM. A partial map would ship a Threads copy where one plug is tracked
    // separately and the other silently shares X's link, which is worse than no split at all: the
    // split would look complete in the report while half of it merged into X.
    if (failed || !Object.keys(linkMap).length) {
      console.warn(`  ⚠ ${platform} keeps X's links — its clicks will not be separable`);
      continue;
    }
    platformPosts[platform] = swapPostLinks(posts, linkMap);
    console.log(`  ↳ ${platform}: ${Object.keys(linkMap).length} own link(s), subid +${platformSubid('', platform)}`);
  }
  return { platformPosts: Object.keys(platformPosts).length ? platformPosts : null, minted };
}

/** Ledger rows for the per-platform mints. attributionOnly, the same shape roundup plugs 3+ use:
 *  they carry a subid and a link so registry-sync can join revenue, and nothing else. Pure. */
export const crossPostLedgerRows = (minted, { account, draftId, recId }) =>
  (minted || []).map((m) => ({
    ts: new Date().toISOString(), account, recId, draftId: String(draftId),
    mode: 'cross-post', attributionOnly: true, platform: m.platform,
    subid1: m.subid1, asin: m.asin, product: m.product, link: m.link,
  }));
