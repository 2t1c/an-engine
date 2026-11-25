// sync-cta-drafts.mjs — mirror the CTA pod library into the burner account as reviewable drafts.
//
// OPERATOR RULE (2026-08-26): "if you're updating the CTA pod, also update the draft on Typefully.
// That is how I will know what the latest CTA looks like." So this is not a one-off export — it is
// the step that runs after EVERY pods.json edit, and CI fails if it was skipped (--check).
//
// It renders through renderPod, deliberately. Reading the JSON fields directly would show what we
// WROTE; rendering shows what the engine actually PASTES — entry line, item number, disclosure and
// link placement included. When those two ever disagree, this surfaces it.
//
// One draft per live pod, tagged "cta", eight tweets:
//   1-5  the five first tweets (substance · symptom · action · cause · answer)
//   6    bridge
//   7    heavy plug
//   8    light plug — rendered WITHOUT the bridge, which is how a light placement ships
//
//   node sync-cta-drafts.mjs            # create or update every draft
//   node sync-cta-drafts.mjs --check    # exit 1 if any draft is out of date (CI)
//   node sync-cta-drafts.mjs --dry      # print what would change
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { buildPlatforms, rebuildCrossPosts } from './platforms.mjs';
import { PODS, renderPod, FRAME_SETS, UNNUMBERED_FRAMES } from './pods.mjs';

// The mirror shows the DEFAULT system's copy, because that is what ships (operator 2026-09-02:
// backline is the new default). Pinned by name rather than to DEFAULT_POD_SYSTEM so a stray
// POD_SYSTEM in the environment can never rewrite the review surface with another generation.
export const MIRROR_SYSTEM = 'backline';
export const FRAMES = FRAME_SETS[MIRROR_SYSTEM];
const TAG = 'cta';
const PLACEHOLDER = '{{LINK}}';
const ITEM_NUMBER = 7; // a stand-in slot, so the numbering is visible the way a host thread gives it
const TITLE_PREFIX = '[CTA]';

export const titleFor = (pod) => `${TITLE_PREFIX} ${pod.id} · ${pod.substance}`
  + (pod.status === 'retired' ? ' (RETIRED — not shipping)' : '');

/** Pure: the eight tweets that represent one pod. Exported so the shape is unit-testable. */
export function draftTweets(pod, { link = PLACEHOLDER, itemNumber = ITEM_NUMBER } = {}) {
  // PINNED to MIRROR_SYSTEM, never DEFAULT_POD_SYSTEM. These drafts are the operator's review
  // surface for the copy that ships; running this with POD_SYSTEM=classic set would silently
  // overwrite every draft with another generation and destroy that surface. framed and classic need
  // no mirror — framed is in pods.json and git, classic is the copy that already shipped.
  const opts = { itemNumber, system: MIRROR_SYSTEM };
  const firsts = FRAMES
    .map((frame) => renderPod(pod, '*', link, { ...opts, frame })?.point)
    .filter(Boolean);
  const heavy = renderPod(pod, '*', link, { ...opts, frame: 'substance' });
  const light = renderPod(pod, '*', link, { ...opts, frame: 'substance', light: true });
  if (!heavy) return null;
  return [...firsts, heavy.bridge, heavy.plug, light?.plug].filter(Boolean);
}

const SCRATCH = [
  'Mirrored from pods.json by sync-cta-drafts.mjs. Not for publishing.',
  'This is the BACKLINE system — the default since 2026-09-02, built from the back. The framed',
  'and classic libraries still live in pods.json (POD_SYSTEM=framed / classic) and are not',
  'mirrored here.',
  '',
  'Rendered through renderPod, so this is what the engine actually pastes into a thread —',
  'entry line, item number, disclosure and link placement included.',
  '',
  '  1 substance (action merged in)   2 symptom   3 cause   4 bonus (never numbered)',
  '  5 bridge      6 heavy plug       7 light plug (ships WITHOUT the bridge)',
  '',
  `Link is the ${PLACEHOLDER} placeholder — nothing minted, nothing scheduled.`,
].join('\n');

async function main() {
  const CHECK = process.argv.includes('--check');
  const DRY = process.argv.includes('--dry') || CHECK;
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const acc = getAccount('burner');
  const tf = typefully(env);

  // Retired pods are mirrored too, when they carry the current shape. The rule this script exists for
  // is "the drafts show me the latest CTA" — and a pod retired for a PRODUCT reason (NO1: no live
  // citrulline ASIN) still has reviewed, current copy that ships the day the listing returns. Leaving
  // its draft frozen at an older revision would make the mirror quietly wrong. The title says
  // RETIRED so nothing reads it as shippable; a retired pod with no framePoints is skipped, since
  // there is no current copy to show.
  const live = PODS.filter((p) => (p.status !== 'retired' || p.variants?.some((v) => v.framePoints))
    && p.variants?.some((v) => (v.system || 'framed') === MIRROR_SYSTEM));
  const existing = new Map();
  for (let offset = 0; ; offset += 50) {
    const page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?limit=50&offset=${offset}`);
    const list = page?.results || [];
    for (const d of list) {
      const m = String(d.draft_title || '').match(/^\[CTA\]\s+(\S+)\s+·/);
      if (m) existing.set(m[1], d);
    }
    if (list.length < 50) break;
  }

  let changed = 0, created = 0, same = 0;
  for (const pod of live) {
    const tweets = draftTweets(pod);
    if (!tweets) { console.warn(`  ⚠ ${pod.id}: renderPod returned nothing — skipped`); continue; }
    const title = titleFor(pod);
    const head = existing.get(pod.id);

    if (!head) {
      created++;
      if (DRY) { console.log(`  + ${pod.id.padEnd(5)} would be CREATED`); continue; }
      const d = await tf.createDraft(acc.socialSetId, {
        draft_title: title, scratchpad_text: SCRATCH, share: true, tags: [TAG],
        platforms: buildPlatforms(tweets.map((t) => ({ text: t })), { account: acc }),
      });
      console.log(`  + ${pod.id.padEnd(5)} created  ${d.share_url || d.id}`);
      continue;
    }

    // Compare against what is actually on the draft, so an unchanged pod is not rewritten.
    const full = await tf.getDraft(acc.socialSetId, head.id);
    const current = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
    if (current.length === tweets.length && current.every((t, i) => t === tweets[i])) { same++; continue; }

    changed++;
    if (DRY) { console.log(`  ~ ${pod.id.padEnd(5)} OUT OF DATE  ${full?.share_url || head.id}`); continue; }
    const posts = tweets.map((t) => ({ text: t }));
    const { platformPosts, skipped } = rebuildCrossPosts(posts, full?.platforms);
    for (const s of skipped) console.log(`  ! ${pod.id.padEnd(5)} cross-post ${s.platform} left stale (${s.reason})`);
    await tf.patchDraft(acc.socialSetId, head.id, {
      draft_title: title, scratchpad_text: SCRATCH, tags: [TAG],
      platforms: buildPlatforms(posts, { existing: full?.platforms, platformPosts }),
    });
    console.log(`  ~ ${pod.id.padEnd(5)} updated  ${full?.share_url || head.id}`);
  }

  const stale = changed + created;
  console.log(`\n${live.length} pods mirrored · ${same} already current · ${changed} out of date · ${created} missing`);
  if (CHECK && stale) {
    console.error(`\n✗ ${stale} draft(s) do not match pods.json. Run: node sync-cta-drafts.mjs`);
    process.exit(1);
  }
  if (!DRY) console.log(`\nDone — filter the burner by the "${TAG}" tag. All UNSCHEDULED, account is paused.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'sync-cta-drafts');
