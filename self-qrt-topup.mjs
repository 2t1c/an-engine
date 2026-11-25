// self-qrt-topup.mjs — daily sweeps at 2:45pm + 3:40am Saigon (was a single 2pm sweep, operator 2026-08-11; moved off the generation-slot collision 2026-08-18): any SCHEDULED fresh draft still
// missing a native QRT gets the account's CURRENT best winner (spec: SELF-QRT-PLAN.md). Generation
// attaches QRTs at draft creation; this catches everything that path misses — manual/operator drafts,
// weekly-batch drafts, and queue drafts created before a newer, bigger winner landed.
//   node self-qrt-topup.mjs          # patch drafts + ledger
//   node self-qrt-topup.mjs --dry    # report only
// Skips: [Evergreen] reposts (stay faithful as-is), [HOLD...] drafts, drafts that already carry any
// quote_post_url, client/lightweight pages. Rotation is SHARED with generation via ledger selfQrtOf
// (recentSelfQrts reads the file fresh per pick, so multiple top-ups in one run rotate correctly).
import { buildPlatforms, rebuildCrossPosts } from './platforms.mjs';
import { loadEnv, requireEnv, typefully, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { pathToFileURL } from 'node:url';
import { pickSelfQrt, topicPhrase, SELF_QRT_ECHO_PREFIX, selfQrtEnabled } from './self-qrt.mjs';

// Draft ids the ledger marks as harvest. Pure over the file text so it is testable; a missing or
// unreadable ledger returns an empty set, which restores the previous behaviour rather than
// silently suppressing every quote.
export function harvestDraftIdsFrom(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || !line.includes('harvestOf')) continue;
    try { const e = JSON.parse(line); if (e.harvestOf && e.draftId) out.add(String(e.draftId)); } catch {}
  }
  return out;
}
function harvestDraftIds() {
  try {
    const f = join(HERE_DIR, 'ledger.jsonl');
    return existsSync(f) ? harvestDraftIdsFrom(readFileSync(f, 'utf8')) : new Set();
  } catch { return new Set(); }
}
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');

async function main() {
  const env = loadEnv();
  // THE LANE OFF, checked before ANY read. This is the single writer of self-QRTs since the
  // 2026-08-14 consolidation, so returning here is the whole lane dark: no analytics calls, no
  // draft patches, no ledger lines. Empty/unset SELF_QRT = off, and that is the default. It stops
  // NEW cards only; self-qrt-strip.mjs removes the ones already attached to scheduled drafts.
  if (!selfQrtEnabled(env)) { console.log('SELF_QRT is off — no quote cards will be attached. Set SELF_QRT=1 to re-enable.'); return; }
  requireEnv(env, ['TYPEFULLY_API_KEY', 'AIRTABLE_PAT', 'XDB_BASE_ID']);
  const tf = typefully(env);
  const now = Date.now();
  // HARVEST THREADS TAKE NO RETWEET (operator 2026-08-27). The viral lane earns its reach with the
  // pod CTA and Fuel the Fire; the harvest lane recycles a body that ALREADY went viral, and quoting
  // our own winner under a re-hook of that same winner shows the reader the same thread twice.
  // Keyed on the ledger's harvestOf stamp rather than a title prefix, because the stamp is the thing
  // that makes "did the variation beat the parent" answerable and it can never drift from the truth.
  const harvestDrafts = harvestDraftIds();
  if (harvestDrafts.size) console.log(`skipping ${harvestDrafts.size} harvest draft(s) — that lane ships without a quote`);
  let patched = 0, skipped = 0, failedPicks = 0;
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    if (!acc.plugHeavyExample || acc.paused || !acc.socialSetId) continue;
    const all = await tf.listAll(`/social-sets/${acc.socialSetId}/drafts`);
    const sched = all.filter((d) => d.scheduled_date && new Date(d.scheduled_date).getTime() >= now
      && String(d.status).toLowerCase() === 'scheduled'
      && !String(d.draft_title || '').startsWith('[Evergreen]')
      && !String(d.draft_title || '').startsWith('[HOLD'));
    for (const d of sched) {
      if (harvestDrafts.has(String(d.id))) { skipped++; continue; }
      const full = await tf.getDraft(acc.socialSetId, d.id);
      const posts = (full.platforms?.x?.posts || []).map((p) => ({ text: p.text, media_ids: [...(p.media_ids || [])], ...(p.quote_post_url ? { quote_post_url: p.quote_post_url } : {}) }));
      if (!posts.length || posts.some((p) => p.quote_post_url)) { skipped++; continue; } // already quoted
      // publishAt = this draft's scheduled time, so the 24h momentum cap is judged on the age the
      // READER will see, not the age at pick time (a 2pm pick for a 6am slot is 16h staler).
      const q = await pickSelfQrt(env, tf, acc, { newText: posts[0]?.text || '', publishAt: d.scheduled_date })
        .catch((e) => { console.warn(`  ${acc.name} pick FAILED: ${e.message}`); return undefined; });
      if (q === undefined) { failedPicks++; continue; } // unknown, not "no winner"
      if (!q) { skipped++; continue; }
      const topics = topicPhrase(q.preview);
      const echo = `${SELF_QRT_ECHO_PREFIX}, you will love this one where we go deeper on ${topics}:`;
      const di = posts.findIndex((p) => String(p.text).startsWith('DISCLAIMER'));
      const arr = [...posts];
      if (di >= 0) arr.splice(di, 0, { text: echo, media_ids: [] }); // manual drafts without our disclaimer: tweet-1 quote only
      const out = arr.map((p, i) => ({ ...p, ...(i === 0 || String(p.text).startsWith(SELF_QRT_ECHO_PREFIX) ? { quote_post_url: q.url } : {}) }));
      console.log(`${DRY ? '[dry] ' : ''}✓ ${acc.name} ${d.id} (${String(d.scheduled_date).slice(5, 16)}): QRT ${q.url} (${Math.round(q.views / 1000)}k, ${q.ageAtPublishH.toFixed(1)}h at publish)${di >= 0 ? ' · tweet1+echo' : ' · tweet1 only'}`);
      if (DRY) { patched++; continue; }
      // REPLACE any existing SELF-QRT line rather than appending. Generation used to write its own
      // "SELF-QRT: … — placed" note and then this job would attach a DIFFERENT winner, leaving the
      // scratchpad claiming one donor while the draft carried another (live example 2026-08-14:
      // Julian draft 10315101 said …2087130938555895871, actually carried …2087903028406014064).
      // One writer, one line — the note can no longer disagree with the draft.
      const sp = String(full.scratchpad_text || '').split('\n').filter((l) => !/^SELF-QRT\b/i.test(l.trim())).join('\n').trimEnd();
      const { platformPosts, skipped } = rebuildCrossPosts(out, full?.platforms);
      for (const s of skipped) console.log(`  ! ${acc.name} ${d.id}: cross-post ${s.platform} left stale (${s.reason})`);
      await tf.patchDraft(acc.socialSetId, d.id, {
        platforms: buildPlatforms(out, { existing: full?.platforms, platformPosts }),
        scratchpad_text: `${sp}\n\nSELF-QRT: ${q.url} (${Math.round(q.views / 1000)}k views, ${q.ageAtPublishH.toFixed(1)}h old at publish)`,
      });
      appendFileSync(join(HERE_DIR, 'ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account: acc.name, recId: `qrt-topup-${d.id}`, draftId: String(d.id), mode: 'self-qrt-topup', selfQrtOf: q.url }) + '\n');
      patched++;
    }
  }
  console.log(`\ntop-up done: ${patched} draft(s) ${DRY ? 'would be ' : ''}quoted · ${skipped} skipped (already quoted / no qualifying winner)${failedPicks ? ` · ${failedPicks} pick(s) FAILED (winner unknown)` : ''}`);
  if (failedPicks) process.exitCode = 1;
}
// Run only as a script. Without this, importing the module to test harvestDraftIdsFrom fires a live
// sweep against every account's Typefully drafts — which it did, once, before this guard existed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
}
