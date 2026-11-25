#!/usr/bin/env node
// run-singles.mjs — create and schedule the singles a week plan has already chosen and rendered.
//
// DRY BY DEFAULT. Nothing is written to Typefully without --apply.
//
// It creates AND schedules in ONE call, following schedule-warmup rather than schedule-day. Both of
// schedule-day's assumptions are wrong for this lane: it grabs the NEWEST unscheduled draft rather
// than a named one, and its one-post-per-account-per-lane-per-day guard caps us at 1 where this
// lane wants 3-5.
//
// Every draft is titled "[single] …", mirroring "[warmup]". That prefix is load-bearing, not
// decoration: these posts carry no affiliate link, so without an exemption verify-day and sweep
// would report ~450 defects a week, and registry-sync/reslot would re-time them if the
// Airtable-as-master cron is ever switched back on.
//
// The cooldown ledger is written HERE and only on a draft that actually landed — a planned but
// abandoned week must not burn a tweet's 90 days.
//
// Usage:
//   node run-singles.mjs --week 2026-09-07                          # dry: show what would be created
//   node run-singles.mjs --week 2026-09-07 --only kim --day 2026-09-07 --apply
//   node run-singles.mjs --week 2026-09-07 --apply
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, typefully, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { TABLES } from './config.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { buildPlatforms } from './platforms.mjs';

const SAFE_MIN = 15;      // never book something Typefully's poller could already be firing
const MAX_PHOTOS = 4;     // X's own limit
const TITLE_PREFIX = '[single]';

const isVideo = (t) => t === 'Video' || t === 'GIF';

// Media is best effort by design: a post that loses its image is still a good post, and failing the
// whole run over one 404 attachment would strand the rest of the week.
async function attachMedia(tf, socialSetId, row, note) {
  const type = row['Media Type'] || '';
  const out = [];
  try {
    if (isVideo(type)) {
      const url = row['Video URL'];
      if (!url) return out;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`video GET ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      out.push(await tf.uploadMedia(socialSetId, `single-${row.TweetID}.mp4`, bytes));
    } else {
      for (const [i, m] of (row.Media || []).slice(0, MAX_PHOTOS).entries()) {
        const r = await fetch(m.url);
        if (!r.ok) throw new Error(`image GET ${r.status}`);
        const bytes = Buffer.from(await r.arrayBuffer());
        const ext = (m.type || '').includes('png') ? 'png' : 'jpg';
        out.push(await tf.uploadMedia(socialSetId, `single-${row.TweetID}-${i}.${ext}`, bytes));
      }
    }
  } catch (e) {
    note(`media skipped (${e.message}) — posting text-only`);
    return [];
  }
  return out;
}

async function main() {
  const WEEK = cliArg('week', null);
  if (!WEEK) { console.error('--week YYYY-MM-DD required'); process.exit(2); }
  const APPLY = process.argv.includes('--apply');
  // In a /run the singles ship with the threads: --run-dir reads the run ledger and refuses while the
  // schedule stop is not approved, so the write gate needs no permission prompt for the apply.
  const RUN_DIR = cliArg('run-dir', null);
  if (APPLY && RUN_DIR) {
    const { check } = await import('./scripts/run-studio.mjs');
    check(RUN_DIR, 'schedule');
    console.log(`ledger: ${RUN_DIR} schedule approved`);
  }
  const ONLY = (cliArg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const DAY = cliArg('day', null);
  const PATH = cliArg('plan', join(HERE_DIR, 'queues', `singles-plan-${WEEK}.json`));
  const USED = join(HERE_DIR, 'queues', 'singles-used.json');

  const plan = JSON.parse(readFileSync(PATH, 'utf8'));
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const at = airtable(env, env.HEALTH_XDB_BASE_ID || 'appUkzz5Sq0vg3uiL');
  const used = existsSync(USED) ? JSON.parse(readFileSync(USED, 'utf8')) : {};

  let created = 0, skipped = 0, held = 0, failed = 0;
  const now = Date.now();

  for (const acc of plan.accounts) {
    if (ONLY.length && !ONLY.includes(acc.key)) continue;
    const account = ACCOUNTS[acc.key];
    for (const p of acc.posts) {
      if (DAY && p.day !== DAY) continue;
      const tag = `${acc.handle} ${p.day} ${p.atSaigon}`;
      if (p.draftId) { skipped++; continue; }                       // already created; re-runs are safe
      // `== null`, not falsy: a media-only row renders to an empty string and is still a real post.
      if (p.text == null) { console.log(`  ~ ${tag} — not rendered yet, skipping`); skipped++; continue; }
      if (Date.parse(p.at) - now < SAFE_MIN * 60e3) {
        console.log(`  ~ ${tag} — inside the ${SAFE_MIN}min poller window, holding`); held++; continue;
      }

      if (!APPLY) {
        console.log(`  + ${tag} · ${p.renderedAs || p.mode} · @${p.sourceHandle} (${p.ageDays}d)${p.mediaType ? ` · ${p.mediaType}` : ''}`);
        console.log(`      ${p.text.replace(/\n/g, '\n      ')}`);
        created++;
        continue;
      }

      try {
        // Airtable attachment URLs expire, so the row is re-read at publish time rather than
        // trusting the URLs the planner saw.
        const rec = await at.getRecord(TABLES.healthTweets, p.recId);
        const media = p.mediaType ? await attachMedia(tf, acc.socialSetId, rec.fields, (m) => console.log(`      ${tag}: ${m}`)) : [];
        const posts = [{ text: p.text, ...(media.length ? { media_ids: media } : {}) }];
        const draft = await tf.createDraft(acc.socialSetId, {
          draft_title: `${TITLE_PREFIX} ${p.sourceHandle} ${p.day}`,
          platforms: buildPlatforms(posts, { account }),
          publish_at: p.at,
        });
        // Read back and confirm to the minute — a create that silently lands unscheduled is the
        // failure mode that looks like success.
        const back = await tf.getDraft(acc.socialSetId, draft.id);
        if (!String(back?.scheduled_date || '').startsWith(p.at.slice(0, 16))) {
          console.log(`  ! ${tag} — created ${draft.id} but scheduled_date is ${back?.scheduled_date || 'empty'}`);
          failed++;
        } else {
          console.log(`  ✓ ${tag} · draft ${draft.id}${media.length ? ` · ${media.length} media` : ''}`);
          created++;
        }
        p.draftId = draft.id;
        // Cooldown is stamped only now, on a draft that exists.
        (used[p.recId] ||= {})[acc.key] = new Date().toISOString();
        writeFileSync(PATH, JSON.stringify(plan, null, 2));
        writeFileSync(USED, JSON.stringify(used, null, 2));
      } catch (e) {
        console.log(`  ✗ ${tag} — ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n${APPLY ? 'created' : 'would create'} ${created} · skipped ${skipped} · held ${held} · failed ${failed}`);
  if (!APPLY) console.log('dry run — nothing written. Re-run with --apply.');
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'run-singles');
