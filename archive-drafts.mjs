// archive-drafts.mjs — save a draft's full content to git, THEN delete it from Typefully.
//
// The operator's rule (2026-08-21): "I want to delete the thread, but you should probably save the
// content somewhere. If we want to revisit and reuse them in the future."
//
// So this is deliberately two commands, not one, and the second refuses to run without the first:
//
//   node archive-drafts.mjs --export            # writes archive/drafts/<account>.jsonl. Deletes NOTHING.
//   node archive-drafts.mjs --delete            # deletes ONLY ids it can read back out of the archive
//
// WHY GIT AND NOT AIRTABLE. The archive has to survive the thing it is insuring against. Airtable is
// where the registry lives and is itself a moving part; a repo file is versioned, diffable, greppable
// from any future session, and restorable with `git show`. Every tweet, media id, link and platform
// flag is kept verbatim, so a draft can be recreated exactly rather than approximately.
//
// The delete pass re-reads each record from the archive FILE (not from memory) and compares it to
// what Typefully still holds, tweet for tweet. A draft whose archive copy is missing, short, or
// mismatched is skipped and reported. Deleting is irreversible; being slow about it is the point.
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, typefully, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { hasBannedTopic } from './checks.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const DIR = join(HERE_DIR, 'archive', 'drafts');
const fileFor = (key) => join(DIR, `${key}.jsonl`);

const env = loadEnv();
requireEnv(env, ['TYPEFULLY_API_KEY']);
const H = { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}`, 'Content-Type': 'application/json' };
const TF = typefully(env);
// Farm-era set (2026-09-02): [Cover] and [Pot·<family>] are live workflow output now, and
// [Inspiration]/[AI Evo] always were — before this line, all four read as 'not engine output'
// and were disposable at ANY age, which would have eaten a fresh farm draft on day one.
const WORKFLOW = /^\[(Infinity|Cover|Harvest|Evergreen|Roundup|Inspiration|AI ?Evo|Pot(?:·[a-z0-9-]+)?)\]/i;
// The REFERENCE population is never disposable, whatever its age: the burner's [CTA] pod library,
// [SEED] skeletons and the [POT] nursery (pots written on the burner, not yet planted — operator
// 2026-09-02), and anything the operator LOCKED or [parked]. Same title rule the harvest gate uses
// to bar these from induction (laws.json farm.excludeTitle, plus [SEED]/[POT]). Note the `]` right
// after POT: a PLANTED pot is titled [Pot·<family>] and stays ordinary workflow output above.
// [REVIEW] joined 2026-09-22: from stop 4 until the calendar stop, a collaborative /run keeps each
// thread in its own draft IN THE PAGE'S OWN SET (scripts/run-review-drafts.mjs) — the owner wants
// one draft per thread, on the account that will publish it — so unlike the [CTA]/[SEED]/[POT]
// reference above it is NOT shielded by the burner fence below; this line is the whole protection.
// Outside this list it would read as non-workflow and be disposable at any age, i.e. deletable
// mid-run, out of a live queue.
// [LATE PLUG of <id>] joined 2026-11-25: a delayed-plug thread's heavy block waits as a plain draft
// until late-plug.mjs replies it under the live thread; archiving it would leave the thread unplugged.
const REFERENCE = /^\[(CTA|SEED|POT|REVIEW|LATE PLUG of \d+)\]|LOCKED|\[parked\]/i;

// Which drafts are disposable. Deliberately explicit rather than "everything older than N": a rule
// you can read is a rule you can argue with, and this one deletes things.
function reasonToArchive(d) {
  const title = String(d.draft_title || '');
  const ageDays = (Date.now() - Date.parse(d.created_at)) / 864e5;
  if (REFERENCE.test(title)) return null;       // the library shelves — keep, always
  if (/\[NEEDS FIX\]/i.test(title)) return 'flagged NEEDS FIX';
  if (/\[dead-link\]/i.test(title)) return 'flagged dead-link';
  if (hasBannedTopic(title)) return 'banned topic';
  if (!WORKFLOW.test(title.replace(/^\[(NEEDS FIX|dead-link)\]\s*/i, ''))) return 'not engine output';
  if (ageDays > Number(flag('stale-days', 7))) return `engine draft ${Math.round(ageDays)}d old`;
  return null;                                  // fresh engine output — keep
}

const listDrafts = async (ssid) => {
  const out = [];
  // Retrying read that throws (2026-08-30) — a short read leaves stale drafts unarchived and reports
  // a clean sweep.
  for (let o = 0; ; o += 50) {
    const j = await TF.get(`/social-sets/${ssid}/drafts?status=draft&limit=50&offset=${o}`);
    out.push(...(j.results || []));
    if (!j.next || !(j.results || []).length) break;
  }
  return out;
};
const getFull = async (ssid, id) => (await fetch(`https://api.typefully.com/v2/social-sets/${ssid}/drafts/${id}`, { headers: H })).json();
// Read X if it has posts, otherwise whichever platform does. A Threads-only draft is real content
// (Julian published one on 2026-08-20 with x disabled and 19 posts on threads), and an archiver that
// only looks at `platforms.x` would record it as empty and then happily delete it.
const tweetsOf = (full) => {
  const pf = full?.platforms || {};
  const x = (pf.x?.posts || []).map((p) => String(p.text || ''));
  if (x.length) return x;
  for (const [, v] of Object.entries(pf)) {
    const posts = (v?.posts || []).map((p) => String(p.text || ''));
    if (posts.length) return posts;
  }
  return [];
};

async function doExport() {
  mkdirSync(DIR, { recursive: true });
  const only = flag('account', null);
  let saved = 0, kept = 0;
  const index = [];
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    if (!acc.socialSetId || (only && key !== only)) continue;
    // Never sweep pages we do not own the content policy for: the burner is the reference library,
    // client (trackAll) and external pages are other people's queues. Explicit --account overrides.
    if (!only && (acc.burner || acc.external || acc.trackAll)) continue;
    const drafts = await listDrafts(acc.socialSetId);
    const lines = [];
    for (const d of drafts) {
      const why = reasonToArchive(d);
      if (!why) { kept++; continue; }
      const full = await getFull(acc.socialSetId, d.id);
      const rec = {
        archivedAt: new Date().toISOString(), reason: why,
        account: key, accountName: acc.name, socialSetId: acc.socialSetId,
        id: full.id, title: full.draft_title, createdAt: full.created_at,
        shareUrl: full.share_url, scratchpad: full.scratchpad_text || null,
        tags: full.tags || [], platforms: full.platforms || {},   // verbatim: text, media_ids, per-platform
        tweets: tweetsOf(full),                                    // convenience copy for grepping
      };
      lines.push(JSON.stringify(rec));
      index.push({ id: rec.id, account: key, reason: why, title: rec.title, tweets: rec.tweets.length });
      saved++;
    }
    if (lines.length) writeFileSync(fileFor(key), lines.join('\n') + '\n');
    console.log(`${acc.name.padEnd(15)} archived ${String(lines.length).padStart(3)}  kept ${String(drafts.length - lines.length).padStart(3)}`);
  }
  writeFileSync(join(DIR, 'index.json'), JSON.stringify({ exportedAt: new Date().toISOString(), count: saved, drafts: index }, null, 1));
  console.log(`\nEXPORTED ${saved} draft(s) to archive/drafts/ · kept ${kept} fresh`);
  console.log('Commit this BEFORE running --delete. Nothing has been deleted.');
}

// Re-reads the archive from DISK and verifies it against live Typefully before deleting anything.
async function doDelete() {
  const only = flag('account', null);
  let gone = 0, skipped = 0;
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    if (!acc.socialSetId || (only && key !== only)) continue;
    if (!only && (acc.burner || acc.external || acc.trackAll)) continue; // same fence as the export
    const f = fileFor(key);
    if (!existsSync(f)) continue;
    const recs = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const rec of recs) {
      const live = await getFull(acc.socialSetId, rec.id);
      if (!live?.id) { console.log(`  – ${rec.id} already gone`); continue; }
      const liveTweets = tweetsOf(live);
      // Verbatim match, tweet for tweet. A near-copy is not an archive.
      const match = liveTweets.length === rec.tweets.length && liveTweets.every((t, i) => t === rec.tweets[i]);
      // A draft with no text anywhere is a blank Typefully leftover — 12 of them in the first export.
      // There is nothing to preserve, so requiring a non-empty archive would strand them forever.
      // Both sides must agree it is empty; an archive that is empty while the draft is NOT is the
      // dangerous case and still fails the match check above.
      const bothEmpty = rec.tweets.length === 0 && liveTweets.length === 0;
      if (!match) { console.log(`  ⚠ SKIP ${rec.id} — archive does not match live copy (${rec.tweets.length} archived vs ${liveTweets.length} live)`); skipped++; continue; }
      if (bothEmpty && !has('empties')) { console.log(`  – SKIP ${rec.id} — blank draft; pass --empties to delete it too`); skipped++; continue; }
      if (has('dry')) { console.log(`  would delete ${rec.id}  ${String(rec.title).slice(0, 52)}`); gone++; continue; }
      const r = await fetch(`https://api.typefully.com/v2/social-sets/${acc.socialSetId}/drafts/${rec.id}`, { method: 'DELETE', headers: H });
      if (r.ok) { gone++; } else { console.log(`  ✗ ${rec.id}: ${r.status} ${(await r.text()).slice(0, 70)}`); skipped++; }
    }
  }
  console.log(`\n${has('dry') ? 'WOULD DELETE' : 'DELETED'} ${gone} · skipped ${skipped}`);
}

if (has('export')) await doExport();
else if (has('delete')) await doDelete();
else console.log('usage: node archive-drafts.mjs --export | --delete [--dry] [--account <key>] [--stale-days 7]');
