// swipe-clone.mjs — copy ONE swipe thread into a Typefully draft, verbatim, media and all.
//
// This is the button lane (operator 2026-08-28). You are looking at a donor in the swipe DB, you
// want it in an account's Typefully as a starting point, and you do not want to retype it. One
// click, one draft, nothing scheduled.
//
// VERBATIM MEANS VERBATIM, INCLUDING THE CREATOR'S AD. A donor's own funnel tweet comes across
// untouched — "Here's the exact routine I use. You can check it out here:" with no link behind it,
// which is a live defect this repo caught the same day. So the clone is for INSPECTION and
// HARVESTING, never for shipping as-is. It writes an UNSCHEDULED draft titled [Clone] and stamps
// the source into the scratchpad; validateDraft never runs, because a donor thread is not our
// thread and would fail on every one of our laws by construction.
//
// WHY THE CHILD ROWS AND NOT THE ROLLUP. `Full Thread Text` joins the tweets into one string and
// throws away which media belonged to which tweet. Walking the linked records keeps text and media
// paired, which is the entire point of the exercise.
//
//   node swipe-clone.mjs recXXXXXXXXXXXXXX --account kim
//   node swipe-clone.mjs https://x.com/user/status/123 --account rasmus --dry
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadEnv, requireEnv, airtable, typefully, runMain, HERE_DIR } from './lib.mjs';
import { getAccount } from './accounts.mjs';
import { buildPlatforms } from './platforms.mjs';
import { TABLES } from './config.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const THREADS = TABLES.swipe;

/**
 * Order the donor's tweets and pair each with its media. Pure apart from the shape of an Airtable
 * record, so the ordering and the X media rules can be argued with offline.
 *
 * X's rule, which Typefully will not enforce for us: a post carries ONE video alone, or up to FOUR
 * images, never a mix. A donor row can hold both (a video's poster frame lands in Media alongside
 * the Video File), so video wins and the poster is dropped — inserting a poster as an "image" is the
 * exact mismatch media.mjs already had to fix once.
 */
export function orderTweets(childRecords = []) {
  return childRecords
    .map((r) => {
      const f = r.fields || {};
      const vf = (f['Video File'] || [])[0];
      const videoUrl = vf?.url || f['Video URL'] || null;
      const isVideo = !!videoUrl || f['Media Type'] === 'Video';
      const media = isVideo
        ? (videoUrl ? [{ kind: 'video', url: videoUrl, name: vf?.filename || 'video.mp4' }] : [])
        : (f.Media || []).slice(0, 4).map((a, i) => ({
            kind: String(a.type || '').startsWith('video') ? 'video' : 'image',
            url: a.url,
            name: a.filename || `image-${i}.jpg`,
          }));
      return { n: Number(f['Tweet Number'] || 0), text: String(f.Text || '').trim(), media };
    })
    .filter((t) => t.text)
    .sort((a, b) => a.n - b.n);
}

/** The clone's title. Short, prefixed so it is obvious in a draft list what this is and is not. */
export const cloneTitle = (account, hook) =>
  `[Clone] ${account} — ${String(hook || '').replace(/\s+/g, ' ').trim().slice(0, 62)}`;

const scratchpad = (head, acc, tweets) => [
  'SWIPE CLONE — VERBATIM, NOT OURS',
  '',
  `Source:   ${head.fields['Tweet URL'] || '(no url on the row)'}`,
  `Airtable: ${head.id}`,
  `Copied to: ${acc.name} (@${acc.handle})`,
  `Tweets:   ${tweets.length} · media on ${tweets.filter((t) => t.media.length).length}`,
  '',
  'This is the creator\'s thread word for word. It has NOT been gated, it carries no tracked links,',
  'and any ad or funnel line the creator wrote is still in it. Rewrite before anything ships.',
].join('\n');

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY']);
  const DRY = args.includes('--dry');
  const acc = getAccount(flag('account', ''));
  const target = args.find((a) => /^rec[A-Za-z0-9]{14}$/.test(a) || /^https?:\/\/(x|twitter)\.com\//.test(a));
  if (!target) throw new Error('usage: node swipe-clone.mjs <recId|tweetUrl> --account <key> [--dry]');

  const at = airtable(env);
  const tf = typefully(env);

  // ---- the donor ----
  let head;
  if (target.startsWith('rec')) head = await at.getRecord(THREADS, target);
  else {
    const rows = await at.list(THREADS, { formula: `{Tweet URL}="${target}"`, pageSize: 1 });
    if (!rows.length) throw new Error(`no swipe row for ${target}`);
    head = rows[0];
  }
  const childIds = head.fields?.Tweets || [];
  if (!childIds.length) throw new Error(`${head.id} has no linked tweet rows — nothing to clone`);
  const children = [];
  for (const id of childIds) children.push(await at.getRecord(THREADS, id));
  const tweets = orderTweets(children);
  if (!tweets.length) throw new Error(`${head.id} linked ${childIds.length} row(s) but none carry text`);

  console.log(`■ ${head.fields['Tweet URL'] || head.id}`);
  console.log(`  ${tweets.length} tweet(s), ${tweets.reduce((n, t) => n + t.media.length, 0)} media file(s) → ${acc.name}\n`);
  tweets.forEach((t) => console.log(`  [${t.n}]${t.media.length ? ` (${t.media.map((m) => m.kind).join(',')})` : ''} ${t.text.split('\n')[0].slice(0, 88)}`));

  if (DRY) { console.log('\n--dry: nothing created'); return; }

  // ---- media first, so a draft is never created with files we could not fetch ----
  // A file that fails is DROPPED from its tweet rather than failing the clone: a missing image is
  // recoverable by hand, and losing the whole thread over one dead attachment URL is not a trade
  // worth making. Airtable attachment URLs expire, so this is a real failure mode, not a theoretical one.
  for (const t of tweets) {
    t.media_ids = [];
    for (const m of t.media) {
      try {
        const res = await fetch(m.url);
        if (!res.ok) throw new Error(`fetch -> ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        t.media_ids.push(await tf.uploadMedia(acc.socialSetId, m.name, bytes));
      } catch (e) {
        console.log(`  ⚠️ tweet ${t.n}: ${m.kind} not transferred (${String(e.message).slice(0, 44)}) — dropped`);
      }
    }
  }

  const posts = tweets.map((t) => ({ text: t.text, media_ids: t.media_ids }));
  const draft = await tf.createDraft(acc.socialSetId, {
    draft_title: cloneTitle(acc.name, tweets[0].text),
    scratchpad_text: scratchpad(head, acc, tweets),
    share: true,
    // X ONLY. A verbatim donor thread is not ours to cross-post: it carries the creator's voice and
    // sometimes their ad, so it must not fan out to Threads because the account happens to enable it.
    platforms: buildPlatforms(posts, { account: { ...acc, crossPost: [] } }),
  });
  const url = draft.share_url || `https://typefully.com/?d=${draft.id}`;
  console.log(`\n✓ Clone created: ${draft.id} (UNSCHEDULED, ungated — rewrite before shipping)\n  ${url}`);

  // Ledger row so media.mjs and every downstream read can resolve this draft back to its donor.
  appendFileSync(join(HERE_DIR, 'ledger.jsonl'), `${JSON.stringify({
    ts: new Date().toISOString(), account: acc.name, mode: 'swipe-clone',
    recId: head.id, draftId: String(draft.id), sourceUrl: head.fields['Tweet URL'] || null,
    note: 'verbatim clone, ungated',
  })}\n`);
}

// Guarded so the pure helpers above can be imported by the suite without the script running.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) await runMain(main, 'swipe-clone');
