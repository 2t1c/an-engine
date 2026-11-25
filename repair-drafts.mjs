// repair-drafts.mjs — fix the defects that need no judgement, on drafts already sitting in Typefully.
//
// audit-drafts sorts the backlog into three kinds of broken. One kind is purely mechanical: the
// thread is fine, it just lost its sign-off, or its legal disclaimer, or a recap tweet packed seven
// numbered items into one post. Those are deterministic edits — appending the account's own fixed
// boilerplate is not writing, and it recovers a finished thread for free. The other two kinds
// (a plug whose prior tweet never named the substance, a thread with no plug at all) need a writer
// and are deliberately OUT of scope here: a repair that guesses at copy is how a bad draft gets a
// clean bill of health.
//
// Every edit is re-audited before it is written. If a fix does not actually improve the tier, or
// introduces any new defect, the draft is left exactly as it was.
//
//   node repair-drafts.mjs                 # dry: show every proposed edit
//   node repair-drafts.mjs --go            # PATCH the drafts that improve
//   node repair-drafts.mjs --account tina --go
import { buildPlatforms, rebuildCrossPosts } from './platforms.mjs';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { auditThread } from './audit-drafts.mjs';
import { stripEmDash, respaceWall, isSignedTweet, boilerish, closingTexts } from './checks.mjs';
import { signOffOf } from './laws.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go');
const MAX_AGE_DAYS = Number(arg('max-age', 45));
// `--id 123,456` restricts the run to named drafts. It was needed because one of the mechanical
// repairs, restoring the account sign-off, was at odds with the operator stripping that sign-off by
// hand (2026-08-18). laws.json signOff now decides (off since R2026-09-26): while it is off, no
// repair puts a closer back, and one that is still on a draft comes off with the next repair.
const ONLY_IDS = new Set(String(arg('id', '') || '').split(',').map((s) => s.trim()).filter(Boolean));

// Pure: apply only the edits that need no judgement. Returns { tweets, applied[] }. Exported for tests.
export function mechanicalRepairs(tweets, account) {
  const out = [...tweets];
  const applied = [];
  const isSigned = (t) => isSignedTweet(t, account);

  // Em/en dashes are a fleet-wide tell and the replacement is fixed, never a rewrite.
  for (let i = 0; i < out.length; i++) {
    const s = stripEmDash(out[i]);
    if (s !== out[i]) { out[i] = s; applied.push(`tweet ${i + 1}: em/en dash removed`); }
  }

  // A recap that packs several numbered items into one tweet reads as a wall. The list stays
  // identical; only the leading "1." markers become bullets, which is what a recap should have been.
  for (let i = 0; i < out.length; i++) {
    if (out[i] === account.closing || out[i] === account.disclaimer) continue;
    const n = (String(out[i]).match(/^\s{0,3}\d{1,3}[.)]\s/gm) || []).length;
    if (n < 3) continue; // 2 is an ordinary two-item tweet; 3+ in one post is the packed recap
    const bulleted = String(out[i]).replace(/^(\s{0,3})\d{1,3}[.)]\s/gm, '$1- ');
    if (bulleted !== out[i]) { out[i] = respaceWall(bulleted); applied.push(`tweet ${i + 1}: packed recap ${n} numbered lines -> bullets`); }
  }

  // The disclaimer must be the LAST tweet and the sign-off must exist. Both are fixed account copy,
  // so restoring them is bookkeeping. Order matters: closing first, then disclaimer last.
  //
  // POP, don't just append. The old form asked `out.indexOf(account.disclaimer)`, which only ever
  // finds the canonical string — so a REWORDED disclaimer was invisible and the repair appended a
  // second one beneath it. Both drafts scheduled for 2026-08-31 were in exactly that state, and
  // both would have shipped saying the fine print twice while the gate called them clean, because
  // the gate only inspects the last tweet. `boilerish` is checks.mjs's own predicate, shared with
  // repostRepairs so the two repair paths cannot drift apart again.
  if (account.disclaimer) {
    const before = out.slice();
    const popped = [];
    while (out.length && boilerish(out[out.length - 1], account)) popped.push(out.pop());
    // A canonical disclaimer or closing BURIED mid-thread is not in the trailing run, so the pop
    // loop never reaches it. Pull those out too, or restoring the tail duplicates them — which is
    // the case the pop-only first cut of this broke.
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] === account.disclaimer || out[i] === account.closing || out[i] === account.siteCta) out.splice(i, 1);
    }
    // Only add the canonical sign-off when the thread does not already close in the persona's own
    // words. Adding it there stacks two goodbyes on a finished thread; the thread's words win. With
    // laws.json signOff off it is never added (owner R2026-09-26: content, then the disclaimer), so
    // a canonical sign-off popped above stays off.
    const keepClosing = !!signOffOf(account) && !out.some(isSigned);
    out.push(...[account.closing, account.siteCta, account.disclaimer]
      .filter(Boolean).filter((t) => t !== account.closing || keepClosing));
    // A tail that was already canonical pops and re-appends to the identical thing. Say nothing in
    // that case: an 'applied' entry that changed no text is a repair tool claiming credit for a
    // no-op, and the dry run is exactly what gets read before a --go.
    if (out.length !== before.length || out.some((t, i) => t !== before[i])) {
      const isClosing = (t) => closingTexts(account).includes(t);
      // Said by name, because it is a removal and the dry run is what gets read before a --go.
      const dropped = !signOffOf(account) && before.some(isClosing) && !out.some(isClosing);
      const rewritten = popped.filter((t) => t !== account.closing && t !== account.disclaimer && t !== account.siteCta && !(dropped && isClosing(t)));
      const what = keepClosing ? "the account's own closing + disclaimer" : 'the account disclaimer';
      if (dropped) applied.push('removed the sign-off: laws.json signOff is off, so the thread ends on content and then the disclaimer');
      if (rewritten.length) applied.push(`replaced ${rewritten.length} non-canonical boilerplate tweet(s) with ${what}`);
      else if (!dropped || before.at(-1) !== account.disclaimer) applied.push(`restored ${what}`);
    } else { out.length = 0; out.push(...before); }
  }
  // Remove a doubled sign-off. This is the damage an over-eager restore does: a thread already
  // closing "With warmth,\n\nTina." did not match the old full-name detector, so the canonical
  // closing landed right after it and the persona said goodbye twice. Drop the canonical copy and
  // keep the thread's own words — never the other way round.
  {
    const idx = out.map((t, i) => (isSigned(t) ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 1) {
      const drop = idx.filter((i) => out[i] === account.closing).slice(0, idx.length - 1);
      for (const i of drop.reverse()) { out.splice(i, 1); applied.push(`tweet ${i + 1}: removed a duplicate sign-off`); }
    }
  }

  if (signOffOf(account) && !out.some(isSigned)) {
    const end = account.disclaimer && out.at(-1) === account.disclaimer ? out.length - 1 : out.length;
    out.splice(end, 0, account.closing);
    applied.push('restored the account sign-off before the disclaimer');
  }
  return { tweets: out, applied };
}

// Pure: is this repair safe to write? Only if it removes defects and adds none. Exported for tests.
export function repairVerdict(before, after) {
  const RANK = { CLEAN: 0, DEGRADED: 1, BLOCKER: 2 };
  const had = new Set([...before.blockers, ...before.degraded]);
  const added = [...after.blockers, ...after.degraded].filter((x) => !had.has(x));
  if (added.length) return { write: false, why: `repair introduced a new defect: ${added[0]}` };
  const fixed = [...had].filter((x) => ![...after.blockers, ...after.degraded].includes(x));
  if (!fixed.length) return { write: false, why: 'nothing improved' };
  return { write: true, why: `${before.tier} -> ${after.tier}, fixed ${fixed.length}`, fixed, improved: RANK[after.tier] < RANK[before.tier] };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const only = arg('account');
  const accounts = Object.values(ACCOUNTS).filter((a) => !a.paused && a.socialSetId && a.levantaSubidPrefix && (!only || a.name.toLowerCase().includes(only.toLowerCase())));

  let written = 0, skipped = 0;
  for (const acc of accounts) {
    const heads = [];
    for (const status of ['draft', 'scheduled']) {
      for (let offset = 0; ; offset += 50) {
        const page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=${status}&limit=50&offset=${offset}&order_by=-created_at`);
        const list = page?.results || [];
        heads.push(...list);
        if (list.length < 50) break;
      }
    }
    for (const h of heads) {
      // Scope: this tool exists to recover THIS WEEK'S supply, not to edit the archive. A draft old
      // enough to have been passed over for a month and a half is either abandoned or deliberately
      // parked, and appending an account's legal boilerplate to someone's parked personal post is an
      // overreach a repair tool has no business making. `[parked]` is the existing opt-out marker.
      if (ONLY_IDS.size && !ONLY_IDS.has(String(h.id))) continue;
      const ageDays = (Date.now() - Date.parse(h.created_at || Date.now())) / 864e5;
      // An explicitly named draft is never age-gated: --id IS the deliberate choice the age cap
      // exists to stand in for.
      if (!ONLY_IDS.size && (ageDays > MAX_AGE_DAYS || /\[parked\]/i.test(h.draft_title || ''))) continue;
      let full; try { full = await tf.getDraft(acc.socialSetId, h.id); } catch { continue; }
      // Re-read, not from the listing: a draft can publish between the list and the write. Nothing
      // is touched once it is out, and nothing inside 15 minutes of its slot (the fleet's no-touch
      // window: an edit that lands while Typefully is assembling the post is how a thread goes out
      // half-old, half-new).
      if (full?.published_at) { console.log(`· ${acc.name} ${h.id}  already published — left alone`); continue; }
      if (full?.scheduled_date && Date.parse(full.scheduled_date) - Date.now() < 15 * 60e3) { console.log(`· ${acc.name} ${h.id}  inside 15 minutes of its slot — left alone`); continue; }
      const posts = full?.platforms?.x?.posts || [];
      const tweets = posts.map((p) => String(p.text || ''));
      if (!tweets.length) continue;
      const before = auditThread(tweets, { account: acc });
      if (before.tier === 'CLEAN') continue;
      const { tweets: fixed, applied } = mechanicalRepairs(tweets, acc);
      if (!applied.length) continue;
      const after = auditThread(fixed, { account: acc });
      const v = repairVerdict(before, after);
      console.log(`${v.write ? '✔' : '·'} ${acc.name} ${h.id}  ${before.tier} -> ${after.tier}  ${(h.draft_title || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 44)}`);
      for (const a of applied) console.log(`     ${a}`);
      if (!v.write) { console.log(`     ↳ NOT written: ${v.why}`); skipped++; continue; }
      if (!GO) { skipped++; continue; }
      // Preserve media: PATCH carries every post's media_ids, and an inserted tweet gets none.
      const byText = new Map(posts.map((p) => [String(p.text || ''), p.media_ids || []]));
      const repaired = fixed.map((t) => ({ text: t, media_ids: byText.get(t) || [] }));
      const { platformPosts, skipped } = rebuildCrossPosts(repaired, full?.platforms);
      for (const s of skipped) console.log(`     ↳ cross-post ${s.platform} left stale (${s.reason}) — it still carries the unrepaired text`);
      await tf.patchDraft(acc.socialSetId, h.id, {
        platforms: buildPlatforms(repaired, { existing: full?.platforms, platformPosts }),
      });
      written++;
      console.log(`     ↳ written`);
    }
  }
  console.log(`\n${GO ? `repaired ${written}` : `${skipped} repairable`} · run with --go to write`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'repair-drafts');
