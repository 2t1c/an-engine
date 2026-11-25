#!/usr/bin/env node
// The occupancy snapshot a /run calendar is computed against: every post already booked on each
// page's Typefully queue for the run's dates. READ-ONLY: it lists drafts and never writes, and the
// client is injected so tests (and the offline CI) never touch the network.
//
// This is the missing producer of the snapshot run-calendar.mjs (stop 1) and
// run-schedule-preflight.mjs (stop 5) consume. Three rules, each one a way the old reads went wrong:
//   - A lane comes from the draft TITLE ([Cover], [Harvest], [Pot·x] …) or, for a one-post draft, is a
//     single. A multi-post draft with no lane title is UNCLASSIFIED and makes its page-day incomplete:
//     it occupies the day, but nobody may guess what it is. A native X Article (an x_article draft, an
//     [Article] title, or an article [REVIEW] title) is lane `article`: it occupies its page-day beside
//     the money thread and never as it (owner, R2026-10-03: "Every account should do ≥2 articles a week").
//     A quote post ([Echo QRT], [Booster QRT], [QRT], Cold QRT ·, QRT ·) is lane `qrt`, beside the
//     thread the same way (lanes.mjs QRT_LANE).
//   - An unscheduled [REVIEW] draft is the run's own copy under review. It occupies nothing.
//   - A failed read sets complete:false and marks that page's coverage incomplete. It is never an
//     empty queue: an unread queue that reads as empty is how nine pages were double-booked.
//
//   node scripts/run-occupancy.mjs --dates 2026-09-25,2026-09-26 [--accounts a,b] --out /outside/repo/occupancy.json
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS } from '../accounts.mjs';
import { REVIEW_PREFIX } from '../config.mjs';
import { isArticleDraft, isStandalonePost } from '../monitoring-scope.mjs';
import { QRT_LANE, isQrtTitle } from '../lanes.mjs';

export const PLATFORMS = ['x', 'threads'];
const saigonDate = (ms) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);

/** Whether a draft posts to `platform`: true, false, or null when the payload cannot say. */
export function draftPlatformOf(draft, platform) {
  if (platform === 'x' && draft.x_post_enabled === false) return false;
  if (platform === 'x' && draft.x_post_enabled === true) return true;
  const value = draft.platforms?.[platform];
  if (value === null || value?.enabled === false) return false;
  if (value?.enabled === true || Array.isArray(value?.posts)) return true;
  return null;
}

/** The lane a draft title declares, or null. [Article] (or an article [REVIEW] title) is article; a QRT title is qrt; [Pot·x] and [Seed] are seed; [Remix], [Evergreen] and [Infinity] are cover. */
export function laneFromTitle(title) {
  if (isArticleDraft({ draft_title: title })) return 'article';
  if (isQrtTitle(title)) return QRT_LANE;
  const m = String(title || '').match(/^\s*\[(cover|harvest|seed|pot(?:·[^\]]*)?|remix|evergreen|infinity|single|warmup)\]/i);
  if (!m) return null;
  const token = m[1].toLowerCase();
  if (token === 'single' || token === 'warmup') return 'single';
  if (token.startsWith('pot') || token === 'seed') return 'seed';
  if (token === 'harvest') return 'harvest';
  return 'cover';
}

/** The lane a booked draft occupies: article, qrt, single, cover, harvest, seed, or null when it cannot be told. */
export function laneOfDraft(draft) {
  if (isArticleDraft(draft)) return 'article';
  // Before the one-post test: a QRT is one post too, but it is not a single (no singles window, no
  // singles spacing), and the list endpoint carries no posts to test anyway.
  if (isQrtTitle(draft?.draft_title)) return QRT_LANE;
  if (isStandalonePost(draft)) return 'single';
  return laneFromTitle(draft?.draft_title);
}

/**
 * PURE. reads = [{ account, drafts: [...] } | { account, failed: true }]. Only scheduled or published
 * drafts with a time occupy a minute; unscheduled [REVIEW] drafts and planned drafts are ignored.
 */
export function occupancyFromDrafts({ reads = [], dates = [], capturedAt = new Date().toISOString() } = {}) {
  const dateSet = new Set(dates);
  const bookings = [], unclassified = [], seen = new Set();
  const incomplete = new Set();
  for (const read of reads) {
    if (read.failed) { for (const date of dates) incomplete.add(`${read.account}|${date}`); continue; }
    for (const draft of read.drafts || []) {
      const status = String(draft?.status || '').toLowerCase();
      const when = draft?.scheduled_date || draft?.publish_at || draft?.published_at;
      if (!when || !Number.isFinite(Date.parse(when))) continue;          // unscheduled: occupies nothing
      if (!['scheduled', 'published', 'publishing'].includes(status)) continue;
      const ms = Date.parse(when);
      const date = saigonDate(ms);
      if (!dateSet.has(date) || seen.has(String(draft.id))) continue;
      seen.add(String(draft.id));
      const lane = laneOfDraft(draft);
      const platforms = PLATFORMS.filter((p) => draftPlatformOf(draft, p) === true);
      if (!lane || (lane !== 'article' && String(draft.draft_title || '').startsWith(REVIEW_PREFIX))) {
        // A scheduled draft whose lane cannot be read (or a [REVIEW] draft somebody scheduled) still
        // occupies its minute; the page-day is marked incomplete so no slot is planned blind beside it.
        // An article is exempt: it never takes the thread's page-day, so nothing is planned blind.
        unclassified.push({ account: read.account, draftId: String(draft.id), publishAtUtc: new Date(ms).toISOString(), title: String(draft.draft_title || '').slice(0, 80) });
        incomplete.add(`${read.account}|${date}`);
      }
      bookings.push({ account: read.account, lane: lane || 'cover', publishAtUtc: new Date(ms).toISOString(), draftId: String(draft.id),
        platforms: platforms.length ? platforms : ['x'], status });
    }
  }
  const coverage = reads.flatMap((read) => dates.flatMap((date) => PLATFORMS.map((platform) => ({
    account: read.account, platform, date, complete: !read.failed && !incomplete.has(`${read.account}|${date}`) }))));
  return { schema: 'run-occupancy-v1', capturedAt, complete: reads.length > 0 && reads.every((read) => !read.failed),
    failedAccounts: reads.filter((read) => read.failed).map((read) => read.account),
    coverage, bookings: bookings.sort((a, b) => a.publishAtUtc.localeCompare(b.publishAtUtc) || a.account.localeCompare(b.account)), unclassified };
}

/**
 * Read every page's queue through an injected Typefully client ({ listAll(path) }). Scheduled drafts
 * always; published ones too when a run date is today or earlier. A read that throws marks that page
 * failed: never an empty queue.
 */
export async function readOccupancy({ client, accounts, dates, now = new Date(), concurrency = 4 } = {}) {
  if (!client?.listAll) throw new Error('readOccupancy needs a Typefully client with listAll');
  const today = saigonDate(new Date(now).getTime());
  const statuses = ['scheduled', ...(dates.some((d) => d <= today) ? ['published'] : [])];
  const reads = new Array(accounts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= accounts.length) return;
      const { key, socialSetId } = accounts[index];
      try {
        const pages = await Promise.all(statuses.map((status) => client.listAll(`/social-sets/${socialSetId}/drafts?status=${status}`)));
        reads[index] = { account: key, drafts: pages.flatMap((page, i) => page.map((d) => (d?.status ? d : { ...d, status: statuses[i] }))) };
      } catch { reads[index] = { account: key, failed: true }; }
    }
  }));
  return occupancyFromDrafts({ reads, dates, capturedAt: new Date(now).toISOString() });
}

/** The posting pages a run can book: the same filter as the brief. */
export function postingAccounts(accounts = ACCOUNTS, keys = null) {
  return Object.entries(accounts).filter(([key, a]) => a.socialSetId && !a.external && !a.burner && !a.client && (!keys || keys.includes(key)))
    .map(([key, a]) => ({ key, socialSetId: a.socialSetId }));
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const dates = String(flag('dates') || '').split(',').filter(Boolean);
  if (!dates.length || dates.some((d) => !/^\d{4}-\d\d-\d\d$/.test(d))) throw new Error('Usage: run-occupancy.mjs --dates YYYY-MM-DD[,…] [--accounts a,b] [--out FILE]');
  const keys = flag('accounts') ? flag('accounts').split(',') : null;
  const { loadEnv, typefully } = await import('../lib.mjs');
  const occupancy = await readOccupancy({ client: typefully(loadEnv()), accounts: postingAccounts(ACCOUNTS, keys), dates });
  const json = `${JSON.stringify(occupancy, null, 2)}\n`;
  if (flag('out')) writeFileSync(resolve(flag('out')), json, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(json);
  if (!occupancy.complete) console.error(`occupancy INCOMPLETE: ${occupancy.failedAccounts.join(', ')} could not be read; their page-days are unknown, not open`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`run occupancy failed: ${error.message}`); process.exitCode = 1; });
}
