#!/usr/bin/env node
// verify-day.mjs <YYYY-MM-DD> — what is actually on a day, and whether it is shippable.
//
// Keyed on the SAIGON calendar date rather than POST_WINDOWS, because a hand-placed draft can sit
// outside both windows and slate.mjs cannot see it. That is not hypothetical: the 2026-08-30 posts
// were dragged into the evening and vanished from the window-keyed view entirely.
//
// --json replaces the table with a machine-readable payload for sweep.mjs; read `dirty`, not the exit code.
//
// Run it after drafting, after scheduling, and again the moment the operator says they have edited.
// An edit pass is where length and structure break, and nothing re-checks it for you.
//
// THREADS ARE JUDGED (monitoring-scope isThreadRow). A native X Article (owner, R2026-10-03: articles
// are additive) is not the page's thread for the day: it never counts toward one-per-account, never
// makes a silent page read as posting, and is never judged on the thread rules (its body has no
// tweets; scripts/run-articles.mjs checks articles). It is still listed, flagged `article`, because the
// fleet minute rule holds for every post (run-calendar: the fleet gap still applies to an article).
//
// SINGLES AND WARM-UPS ARE LISTED TOO, flagged and exempt the same way: never one-per-account, never a
// page posting, no link, length or glue rules. They take part in the minute clash (plan-singles spaces
// them off every other post), and a single at a thread minute is a shipping defect. Only drafts titled
// by their lane are read: an untitled one-post draft is our own standalone post, which the owner keeps
// out of monitoring (monitoring-scope, 2026-09-21).
import { pathToFileURL } from 'node:url';
import { isArticleDraft, isThreadRow } from './monitoring-scope.mjs';
import { loadEnv, typefully } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { effLen, unlinkedSellIssue, orphanSubstanceIssue, weldIssue, platformHookDriftIssue } from './checks.mjs';
import { singleSlotIssue, SINGLES_WINDOWS_FROM } from './slots.mjs';

const sg = (t) => new Date(t + 7 * 3600e3).toISOString().slice(11, 16);
const utcMin = (iso) => new Date(iso).getUTCHours() * 60 + new Date(iso).getUTCMinutes();
/** The lane a [single] or [warmup] title declares, or null (monitoring-scope's own title rule). */
export const standaloneLane = (title) => (String(title || '').match(/^\s*\[(single|warmup)\]/i)?.[1] || '').toLowerCase() || null;

/** Every thread on Saigon day `day`, read in full from each set's scheduled and published queues, every
 *  [single] and [warmup] (read in full, flagged), and every article (flagged `article`, its body unread),
 *  oldest first. `tf` is the Typefully client (get + getDraft); `sets` maps socialSetId -> name. The LIST
 *  carries no platforms, so a titled article ([Article], or an article [REVIEW]) is known from the list
 *  and an untitled one from its full read. */
export async function readDay(tf, sets, day) {
  const lo = Date.parse(`${day}T00:00:00+07:00`), hi = lo + 864e5;
  const rows = [];
  for (const [sid, name] of sets) {
    for (const st of ['scheduled', 'published']) {
      for (let o = 0; ; o += 50) {
        // Retrying read that THROWS. A bare fetch with `if (!r.ok) break` is indistinguishable
        // from "no more pages": one transient 429 truncates the scan and a TAKEN slot reports FREE.
        // Same defect main fixed in slots.mjs; a caller that cannot see the queue must fail, not guess.
        const j = await tf.get(`/social-sets/${sid}/drafts?status=${st}&limit=50&offset=${o}`);
        for (const d of (j.results || [])) {
          const lane = standaloneLane(d.draft_title);
          if (!isThreadRow(d) && !isArticleDraft(d) && !lane) continue;
          const when = d.published_at || d.scheduled_date; if (!when) continue;
          const t = Date.parse(when); if (t < lo || t >= hi) continue;
          const article = () => rows.push({ name, t, iso: when, id: String(d.id), live: !!d.published_at, article: true,
            tweets: [], warmup: false, single: false, drift: [], links: [], over: [] });
          if (isArticleDraft(d)) { article(); continue; }
          // The LIST endpoint returns `preview` but not the posts; only the detail call carries
          // platforms.x.posts. Verifying off the list silently reports every draft as empty.
          const full = await tf.getDraft(sid, d.id);
          if (!isThreadRow(full) && !lane) { if (isArticleDraft(full)) article(); continue; }
          const tw = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
          // A WARM-UP tweet is not a monetized thread and must not be judged as one. A new page
          // posts two plain single tweets a day for two days before anything is sold: no link by
          // design, and two a day by design. Judging them on the thread rules reported the day dirty
          // for drafts doing exactly what they are supposed to, which is how a check earns its way
          // into being ignored. Keyed on the title publish-thread never writes.
          const warmup = lane === 'warmup';
          // A SINGLE is the same kind of exemption for the same kind of reason. The singles lane
          // posts 3-5 unmonetized viral-health singles per account per day (run-singles.mjs), so on
          // the thread rules every one of them reports as a defect and the day is permanently dirty —
          // roughly 450 false criticals a week, which is how a check earns its way into being
          // ignored. Longform singles are in scope too (operator 2026-09-02), so the 280 cap does not
          // apply to them either. Keyed on the title, which publish-thread never writes.
          const single = lane === 'single';
          // Everything above reads platforms.x, which is every tool in this repo and is why a
          // cross-posted copy could keep a struck hook unseen (checks.mjs platformHookDriftIssue).
          // Computed here rather than stored: the detail payload is large and only the verdict travels.
          const drift = platformHookDriftIssue(full?.platforms || {});
          rows.push({ name, t, iso: when, id: String(d.id), live: !!d.published_at, tweets: tw, warmup, single, drift,
            links: tw.flatMap((x) => x.match(/https:\/\/(?:lvnta\.com|geni\.us)\/\S+/g) || []),
            over: tw.map((x, i) => ({ i: i + 1, n: effLen(x) })).filter((x) => x.n > 280) });
        }
        if (!j.next || !(j.results || []).length) break;
      }
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

/** PURE. The day's verdict over readDay's rows (each row gains its `notes` and `glue`). `names` are the
 *  accounts expected to post; one with no thread on the day is `idle`. An article row takes part in the
 *  minute clash only. */
export function judgeDay(rows, { day, names = [] } = {}) {
  // Each page's thread minutes that day: a single in Moon keeps its distance from its OWN page's thread.
  const threadMins = new Map();
  for (const r of rows) if (!r.single && !r.warmup && !r.article) threadMins.set(r.name, [...(threadMins.get(r.name) || []), utcMin(r.iso)]);
  for (const r of rows) {
    r.notes = [];
    if (r.article) continue;
    if (!r.links.length && !r.warmup && !r.single) r.notes.push('** NO AFFILIATE LINK **');
    if (r.over.length && !r.single) r.notes.push(`** OVER 280: ${r.over.map((o) => `#${o.i}(${o.n})`).join(' ')} **`);
    // A single off its slot is a shipping defect (since 2026-09-07), a planner bug rather than something
    // to retime by hand on the day. The law is slots.mjs singleSlotIssue, the same one the planner and
    // run-calendar book against: inside a singles window, never in Sun or Cloud, and in Moon (which the
    // evening window shares since 2026-09-09) MOON_THREAD_GAP_MIN from its own page's thread.
    const issue = r.single && day >= SINGLES_WINDOWS_FROM ? singleSlotIssue(utcMin(r.iso), threadMins.get(r.name)) : null;
    if (issue) r.notes.push(`** SINGLE: ${issue} **`);
    if (!r.tweets.length) r.notes.push('** NO TWEETS **');
    // A hook that differs between platforms is half a repair, never a writing call, so it is a
    // shipping defect rather than a reading note.
    for (const d of (r.drift || [])) r.notes.push(`** HOOK DRIFT on ${d.platform} **`);
    // GLUE (docs/glue.md), added 2026-09-03. This file verified links, length, one-per-account, minute
    // clashes and publish state — everything except whether the copy sells. So on 2026-09-03 it printed
    // "day is clean" over magnus 10527598, which argued nitric oxide across four tweets, wrote the CTA
    // "This is the one I actually use", and carried no link under it. A day check blind to that is a
    // day check that certifies the one defect that costs money.
    //
    // Reported as a soft note and deliberately NOT counted in `bad`: every one of these is a WARN in
    // checkThread because the writer decides. `dirty` stays a shipping question; this is a reading one.
    if (!r.warmup && !r.single && r.tweets.length) {
      const glue = [...unlinkedSellIssue(r.tweets), ...orphanSubstanceIssue(r.tweets), ...weldIssue(r.tweets)];
      r.glue = glue;
      if (glue.length) r.notes.push(`(glue: ${glue.length})`);
    }
  }
  // one per account, and no two accounts sharing a minute
  const bad = rows.filter((r) => r.notes.some((n) => n.startsWith('**'))).length;   // ** = shipping defect; (glue: n) is a reading note
  const byAcct = {}; for (const r of rows) if (!r.warmup && !r.single && !r.article) byAcct[r.name] = (byAcct[r.name] || 0) + 1;
  const twice = Object.entries(byAcct).filter(([, n]) => n > 1);
  // Singles and warm-ups clash from SINGLES_WINDOWS_FROM, the day the singles law binds: a day booked
  // before it stays judged exactly as booked (operator 2026-09-07: "this time it is fine").
  const mins = rows.filter((r) => !(r.single || r.warmup) || day >= SINGLES_WINDOWS_FROM).map((r) => r.iso.slice(11, 16));
  const clash = [...new Set(mins.filter((m, i) => mins.indexOf(m) !== i))];
  const idle = names.filter((n) => !byAcct[n]);
  const dirty = !!(bad || twice.length || clash.length);
  return { rows, bad, byAcct, twice, clash, idle, dirty };
}

async function main(argv = process.argv.slice(2)) {
  const DAY = argv.find((a) => /^\d{4}-\d\d-\d\d$/.test(a));
  const JSON_OUT = argv.includes('--json');
  if (!DAY) { console.error('usage: verify-day.mjs <YYYY-MM-DD> [--json]'); process.exit(2); }
  const env = loadEnv();
  const tf = typefully(env);
  const keys = Object.entries(ACCOUNTS).filter(([, a]) => a.plugHeavyExample).map(([k]) => k);
  const sets = new Map();
  for (const k of keys) if (!sets.has(ACCOUNTS[k].socialSetId)) sets.set(ACCOUNTS[k].socialSetId, ACCOUNTS[k].name);

  const rows = await readDay(tf, sets, DAY);
  const { byAcct, twice, clash, idle, dirty } = judgeDay(rows, { day: DAY, names: keys.map((k) => ACCOUNTS[k].name) });

  if (JSON_OUT) {
    // --json REPLACES the human output (the audit-drafts / preflight convention, not the
    // cta-audit one that appends after the table) so an aggregator can pipe stdout straight in.
    // Read `dirty` rather than the exit status: sweep.mjs treats exit codes as unreliable.
    console.log(JSON.stringify({
      day: DAY, dirty, posts: rows.length,
      accountsPosting: Object.keys(byAcct).length, accountsTotal: keys.length,
      twice: twice.map(([name, n]) => ({ account: name, posts: n })), minuteClash: clash, silent: idle,
      rows: rows.map((r) => ({
        account: r.name, id: r.id, saigon: sg(r.t), utc: r.iso.slice(11, 16), iso: r.iso, live: r.live, warmup: r.warmup, single: r.single, article: !!r.article,
        tweets: r.tweets.length, links: r.links.length, over: r.over, notes: r.notes, glue: r.glue || [], drift: r.drift || [],
      })),
    }, null, 1));
  } else {
    console.log(`\n${DAY} (Saigon) — ${rows.length} post(s)\n`);
    console.log('  Saigon  UTC    state      account          draft       tw  links  notes');
    for (const r of rows) {
      console.log(`  ${sg(r.t)}   ${r.iso.slice(11, 16)}  ${(r.live ? 'LIVE' : 'sched').padEnd(9)} ${r.name.padEnd(16)} ${r.id.padEnd(10)} ${String(r.tweets.length).padStart(3)} ${String(r.links.length).padStart(6)}  ${r.notes.join(' ') || (r.warmup ? 'ok (warm-up)' : r.single ? 'ok (single)' : r.article ? 'ok (article)' : 'ok')}`);
    }
    console.log(`\n  ${Object.keys(byAcct).length}/${keys.length} accounts posting`
      + (twice.length ? `   ** TWICE: ${twice.map(([k, n]) => `${k} x${n}`).join(', ')} **` : '   none twice')
      + (clash.length ? `   ** MINUTE CLASH: ${clash.join(', ')} **` : ''));
    if (idle.length) console.log(`  silent: ${idle.join(', ')}`);
    // The note says WHICH platform drifted; the fix needs to see BOTH hooks, and a table cell cannot
    // carry them. Printed under the table so the repair can be made without a second call.
    const drifted = rows.filter((r) => (r.drift || []).length);
    if (drifted.length) {
      console.log('\n  HOOK DRIFT — a repair touched X and left a cross-post behind:');
      for (const r of drifted) for (const d of r.drift) console.log(`    ${r.name} ${r.id}  ${d.msg}`);
    }
    console.log(dirty ? '\n✗ needs attention' : '\n✓ day is clean');
  }
  // exitCode, never exit(): a --json payload this size is still buffered when the process ends,
  // and exit() truncates it. Same rule the rest of the audit scripts follow.
  process.exitCode = dirty ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
