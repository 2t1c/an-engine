// fix-untracked.mjs — auto-remediation for the untracked-affiliate-link leak (IMPROVEMENTS #6 escalation).
// Scans each monetized health account's SCHEDULED drafts for a money link missing its attribution tag
// (a Gumroad link with no ?ref) and, on --apply, re-tags it deterministically, patches the live draft
// (preserving media + every other tweet VERBATIM — only the link's query string changes), then reports
// the incident + how it was resolved to Telegram. Idempotent: a link that already carries ?ref is
// skipped, so re-runs never double-tag.
//
// SCOPE — it only auto-fixes the UNAMBIGUOUS case: a Gumroad link with no ?ref. It deliberately does NOT
// touch Levanta links: a Levanta short link encodes its subid SERVER-SIDE (invisible in the URL), and
// every pipeline draft already carries a tracked one, so there is no reliable "untracked Levanta" signal
// to act on without re-minting (which needs the ASIN). Genuinely-manual untracked posts are surfaced
// separately by registry-sync's worklist (queues/untracked-followups.json) for a human.
//
// SAFE BY DEFAULT: dry unless --apply is passed, because this mutates LIVE scheduled drafts.
//   node fix-untracked.mjs            # DRY: detect + print what WOULD be fixed; no writes, no Telegram
//   node fix-untracked.mjs --apply    # LIVE: re-tag + patch the draft + send the Telegram incident report
//   node fix-untracked.mjs --hours 96 # scan window (default: drafts scheduled in the next 72h)
import { buildPlatforms, rebuildCrossPosts } from './platforms.mjs';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, typefully, tagGumroad, telegram, report, esc, HERE_DIR } from './lib.mjs';
import { getAccount, ACCOUNTS } from './accounts.mjs';
import { untrackedGumroad } from './checks.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply'); // default is dry — this writes to the live publish path
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const HOURS = parseInt(flag('hours', '72'), 10);
// Derived from the roster (2026-07-21 scaling pass): every ACTIVE monetized page — a new account
// joins the scan the moment its block lands in accounts.mjs; a hand-copied list silently skipped it.
const ACCOUNTS_TO_SCAN = Object.entries(ACCOUNTS).filter(([, a]) => a.plugHeavyExample && !a.paused).map(([k]) => k);

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', ...(APPLY ? ['AIRTABLE_PAT', 'XDB_BASE_ID'] : [])]); // Telegram creds (Airtable Config) only needed for the live report
  const tf = typefully(env);
  const now = Date.now(), end = now + HOURS * 36e5;
  const fixed = [], errors = [];

  for (const key of ACCOUNTS_TO_SCAN) {
    const acc = getAccount(key);
    let sched;
    try {
      const j = await fetch(`https://api.typefully.com/v2/social-sets/${acc.socialSetId}/drafts?limit=50`, { headers: { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}` } }).then((r) => r.json());
      sched = (j.results || []).filter((d) => d.scheduled_date && new Date(d.scheduled_date).getTime() >= now && new Date(d.scheduled_date).getTime() <= end && String(d.status).toLowerCase() !== 'published');
    } catch (e) { errors.push(`${acc.name}: draft list failed — ${e.message}`); continue; }

    for (const d of sched) {
      let full;
      try { full = await tf.getDraft(acc.socialSetId, d.id); } catch (e) { errors.push(`${acc.name} #${d.id}: getDraft failed — ${e.message}`); continue; }
      const posts = full.platforms?.x?.posts || [];
      const subid = `manual-${key}-${String(d.id).slice(-6)}`; // deterministic -> idempotent
      // Re-tag every untracked Gumroad link, leaving each post's other text + media untouched (spread).
      // A pipeline draft's Gumroad link already carries ?ref, so untrackedGumroad() returns null and it
      // is never touched — only a genuinely-untracked link matches.
      let changed = false; const hits = [];
      const newPosts = posts.map((p) => {
        let text = p.text || '';
        const u = untrackedGumroad(text);
        if (u) { text = text.split(u).join(tagGumroad(u, subid)); changed = true; hits.push(u); }
        return { ...p, text };
      });
      if (!changed) continue; // tracked, or no Gumroad money link -> nothing to remediate here

      const incident = { account: acc.name, id: d.id, title: (d.draft_title || `draft ${d.id}`).slice(0, 60), when: d.scheduled_date, hits, subid };
      if (!APPLY) { fixed.push({ ...incident, dry: true }); continue; }
      try {
        // This job REPLACES an untracked link, so a cross-post it cannot re-link is skipped rather
        // than handed X's — and a copy still carrying the untracked link is the whole defect this
        // tool exists to clear, so the skip rides along on the incident.
        const { platformPosts, skipped } = rebuildCrossPosts(newPosts, full?.platforms);
        if (skipped.length) incident.crossPostStale = skipped.map((s) => `${s.platform}(${s.reason})`);
        await tf.patchDraft(acc.socialSetId, d.id, {
          ...(full.draft_title ? { draft_title: full.draft_title } : {}),          // echo back so PATCH can't null them
          ...(full.scratchpad_text ? { scratchpad_text: full.scratchpad_text } : {}),
          platforms: buildPlatforms(newPosts, { existing: full?.platforms, platformPosts }),
          ...(d.scheduled_date ? { publish_at: d.scheduled_date } : {}),            // preserve the schedule
        });
        fixed.push(incident);
        // The retag finally gets a join row: `manual-*` refs matched NOTHING before (0/1062 ledger
        // subids were non-x-thread), so every re-tagged sale stayed unattributed by construction.
        appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account: acc.name, draftId: d.id, mode: 'manual-tag', subid1: subid, link: tagGumroad(hits[0], subid), note: 'fix-untracked retag' }) + '\n');
      } catch (e) { errors.push(`${acc.name} #${d.id}: patch failed — ${e.message}`); }
    }
  }

  // ---- Console summary (always) ----
  console.log(`${APPLY ? '' : '[DRY] '}fix-untracked: ${fixed.length} ${APPLY ? 're-tagged' : 'fixable'} (untracked Gumroad), ${errors.length} error(s)`);
  for (const f of fixed) console.log(`  ${f.dry ? 'WOULD FIX' : '✓ FIXED'} ${f.account} #${f.id}: ${f.hits.join(', ')} -> ?ref=${f.subid}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (!APPLY) { console.log('\n(dry run — no drafts patched, no Telegram sent; pass --apply to remediate)'); return; }

  // ---- Telegram: ONE story per incident wave — problem → what was auto-fixed → what's left for YOU.
  // (registry-sync no longer sends its own bare "untracked posts" alert; this message carries the
  // whole arc, so a problem and its fix never arrive as two disconnected pings.)
  let found = 0, leftover = [];
  try {
    const u = JSON.parse(readFileSync(join(HERE_DIR, 'queues', 'untracked-followups.json'), 'utf8'));
    found = u.count || 0; leftover = u.posts || [];
  } catch {}
  const needsHuman = errors.length || found > fixed.length;
  if (found || fixed.length || errors.length) {
    await telegram(env, report({
      emoji: needsHuman ? '👉' : '🔧', title: 'Untracked Posts', scope: 'monetized accounts',
      status: `${found ? `⚠️ <b>${found}</b> post(s) found without revenue tracking` : `ℹ️ tracking sweep`} · ✅ <b>${fixed.length}</b> auto-fixed${errors.length ? ` · ✗ ${errors.length} error(s)` : ''}`,
      sections: [
        ...(fixed.length ? [{ label: '🤖 HANDLED — attribution restored', body: fixed.map((f) =>
          `• ${esc(f.account)}: <b>${esc(f.title)}</b> → tagged <code>?ref=${esc(f.subid)}</code>`).join('\n') }] : []),
        ...(needsHuman && leftover.length ? [{ label: '👉 LEFT FOR YOU', body: leftover.slice(0, 6).map((u) => `• ${esc(u.name || '')}: ${esc(u.title || '')}\n   ${esc(u.when || '')}${u.link ? ` · <a href="${u.link}">open draft</a>` : ''}`).join('\n\n') }] : []),
        ...(errors.length ? [{ label: 'ERRORS', body: errors.map((e) => `• ${esc(e)}`).join('\n') }] : []),
      ],
      action: needsHuman ? 'Unschedule the LEFT FOR YOU drafts in Typefully if accidental; ignore if intentional.' : 'No action needed — fully handled.',
    }), needsHuman ? 'alerts' : 'ops');
    console.log(`\n✓ Merged incident story sent (${needsHuman ? 'alerts — needs you' : 'ops — fully handled'}).`);
  }
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
