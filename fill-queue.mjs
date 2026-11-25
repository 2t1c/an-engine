// fill-queue.mjs — keep the queue moving: schedule idle workflow-tagged drafts that are
// sitting unscheduled (attach media, drop into the account's next open primary slot). Going forward the
// engines schedule on creation, so this mainly drains legacy/manual backlog + is a safety net.
//   node fill-queue.mjs            # drain across health accounts
//   node fill-queue.mjs --dry      # show what would be scheduled, no writes
//   node fill-queue.mjs --account julian
import { execFileSync } from 'node:child_process';
import { loadEnv, requireEnv, typefully, telegram, esc, fmtSaigon, report, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { takenSlots, openSlots, accountSlots, fleetSlotKeys } from './slots.mjs';
import { hookSimilarity, hasBannedTopic, bannedTopicIssue } from './checks.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
// Slots per account = exactly what the engines schedule with: accountSlots' two posting windows,
// plus the 11:30pm Saigon emergency overflow for drain-only surplus. This has now been wrong twice
// in the same way — first a hard-coded [9pm, 11:30pm] from the 9pm era, then `recreateSlots?.[0] ??
// {h:11}` which quietly became a fleet-wide 18:00 Saigon fallback (outside BOTH windows) the day the
// per-account overrides were deleted. Both bugs were a local copy of a truth that lives elsewhere,
// so there is no local copy any more: read the shared function or don't schedule.
const slotTimesFor = (acc) => accountSlots(acc.key, fleetSlotKeys(ACCOUNTS));
// Two near-identical hooks on one page days apart is the duplicate pattern X enforces against, and
// the drain backlog is FULL of them (Lorenzo held three "Everyone over 30 blames aging" drafts and
// three "High cortisol is aging you faster" on 2026-08-21). Nothing upstream deduped them because
// each was a legitimate separate generation; the collision only exists once they share a queue.
// Dice on the hook words, same threshold band the hook-fidelity gate uses for a faithful rewrite.
const DUP_HOOK = 0.72;
const hookOf = (d) => (d.draft_title || '').replace(/^\[[^\]]+\]\s*/, '').replace(/^[^—]*—\s*/, '');
const MAX_DAYS = 14;      // flexible window
const WORKFLOW = /^\[(infinity|cover|harvest|inspiration|ai ?evo|pot(?:·[a-z0-9-]+)?)\]/i; // cover + pot·<family> joined 2026-09-02 (farm); [Infinity] stays for old sitting drafts

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const only = flag('account');
  // `paused` = the page CANNOT publish (e.g. no X premium, so a thread is truncated at post time).
  // Scheduling into it books posts that will fail or ship broken; daily-winners already skips them
  // and this drain has to as well. Naming the account explicitly overrides, for deliberate testing.
  const accounts = Object.entries(ACCOUNTS).filter(([k, a]) => (only ? k === only : !a.paused)).map(([key, a]) => ({ key, ...a }));

  const lines = [];
  for (const acc of accounts) {
    // sitting (unscheduled) drafts
    const sitting = [];
    // Retrying read that throws (2026-08-30) — a short read here silently under-fills the queue:
    // fewer sitting drafts found means fewer threads scheduled, and nothing says why.
    for (let offset = 0; ; offset += 50) {
      const j = await typefully(env).get(`/social-sets/${acc.socialSetId}/drafts?status=draft&limit=50&offset=${offset}`);
      sitting.push(...(j.results || []));
      if (!j.next || !(j.results || []).length) break;
    }
    let workflow = sitting.filter((d) => WORKFLOW.test(d.draft_title || '')).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    // Banned topic (operator 2026-08-21). These were already IN the backlog when the ban landed —
    // Julian held four variants of "This oncologist said: if I have cancer..." queued to publish.
    // The drain is the last gate before they get a publish time, so it refuses them here rather
    // than scheduling them and hoping QC catches it afterwards.
    const banned = workflow.filter((d) => hasBannedTopic(String(d.draft_title || '')));
    workflow = workflow.filter((d) => !hasBannedTopic(String(d.draft_title || '')));
    // Oldest wins each collision: it has been waiting longest and its siblings are the later retries.
    const kept = [], dropped = [];
    for (const d of workflow) {
      const twin = kept.find((k) => hookSimilarity(hookOf(d), hookOf(k)) >= DUP_HOOK);
      if (twin) dropped.push([d, twin]); else kept.push(d);
    }
    workflow = kept;
    const junk = sitting.filter((d) => !WORKFLOW.test(d.draft_title || ''));
    if (!sitting.length) continue;

    const SLOT_TIMES = slotTimesFor(acc);
    const slots = openSlots(await takenSlots(env, acc.socialSetId, SLOT_TIMES), workflow.length, MAX_DAYS, SLOT_TIMES);
    console.log(`${acc.name}: ${workflow.length} workflow draft(s) sitting | ${junk.length} other | ${dropped.length} near-duplicate | ${banned.length} banned-topic | ${slots.length} open slot(s)`);
    for (const d of banned) console.log(`  ⛔ BANNED ${d.id} — ${bannedTopicIssue(String(d.draft_title || '')).slice(0, 96)}`);
    for (const [d, twin] of dropped) console.log(`  ⏭ dup ${hookOf(d).slice(0, 44)}  ~  ${hookOf(twin).slice(0, 44)}`);

    for (let i = 0; i < workflow.length && i < slots.length; i++) {
      const d = workflow[i], at = slots[i];
      console.log(`  → ${fmtSaigon(at)} ${(d.draft_title || d.id).slice(0, 55)}`);
      if (DRY) continue;
      try { execFileSync('node', [join(HERE_DIR, 'media.mjs'), String(d.id), '--account', acc.key], { encoding: 'utf8', timeout: 300000 }); } catch {}
      try {
        await tf.patchDraft(acc.socialSetId, d.id, { publish_at: at });
        lines.push(`✅ <b>${fmtSaigon(at)} · ${esc(acc.name)}</b> — <a href="${d.share_url || `https://typefully.com/?d=${d.id}&a=${acc.socialSetId}`}">${esc((d.draft_title || '').replace(WORKFLOW, '').replace(/^[^—]*—\s*/, '').slice(0, 55))}</a>`);
      } catch (e) { lines.push(`❌ ${esc(acc.name)} ${d.id}: ${esc((e.message || '').slice(0, 60))}`); }
    }
    if (junk.length) lines.push(`🗑️ <i>${esc(acc.name)}: ${junk.length} untagged draft(s) ignored (delete if unwanted): ${junk.slice(0, 4).map((d) => esc((d.draft_title || 'untitled').slice(0, 30))).join(', ')}</i>`);
  }
  if (!DRY && lines.length) {
    const drained = lines.filter((l) => l.startsWith('✅')).length;
    await telegram(env, report({
      emoji: '🧹', title: 'Queue Drain', scope: 'open primary slots',
      status: `✅ <b>${drained}</b> drained into open primary slots`,
      sections: [{ label: 'DRAINED', body: lines.join('\n') }],
    }), 'daily');
  }
  console.log(DRY ? '\n(dry run)' : `\nDone.`);
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
