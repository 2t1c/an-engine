#!/usr/bin/env node
// media-audit.mjs --day <YYYY-MM-DD> | --draft <id> --account <key> [--fix] [--json]
//
// Every tweet that carries media, the source item it came from, and whether the two are about the
// same thing. Read-only unless --fix, which DROPS the media on the mismatched tweets and nothing else.
//
// Run 2 (2026-09-08..11) shipped sixteen tweets carrying a donor image about something the tweet was
// not: a protein chart on a creatine weld, a PubMed magnesium paper on a beet item, a fish-oil photo
// on the protein item. Every one came from the same rule — the donor's item N is attached to our
// tweet that starts "N." — and our restructured bodies (pod points, welds, a pot's own products)
// change what "N" means. media-map.mjs now requires a shared topic word at attach time; this is the
// other half: the drafts already scheduled, and the check to run over a day before it posts.
//
//   node media-audit.mjs --day 2026-09-11              # the day's drafts, Saigon calendar
//   node media-audit.mjs --day 2026-09-11 --fix        # drop the mismatched media
//   node media-audit.mjs --draft 10658227 --account marko
//
// A draft's source is resolved the way the two media lanes resolve it: the ledger row's recId (the
// swipe donor, media.mjs's lane) or the seed's origin body (seed-media.mjs's lane). A draft with no
// resolvable source is REPORTED as unchecked, never called clean: media it should not carry looks
// exactly like media we cannot judge.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, airtable, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS, getAccount, resolveAccountKey } from './accounts.mjs';
import { TABLES } from './config.mjs';
import { judgeMedia, lessonNum, mediaAcrossPlatforms } from './media-map.mjs';
import { buildPlatforms } from './platforms.mjs';
import { seedOfDraft } from './seed-media.mjs';

const INSIDE_MIN = 15;

/** PURE. The ledger's view of one draft: its donor recId / source url, and its seed if it is a plant. */
export function sourceOf(lines, draftId) {
  const out = { recId: null, url: null, ...seedOfDraft(lines, draftId) };
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (String(e.draftId) !== String(draftId)) continue;
      if (e.recId) out.recId = e.recId;
      if (e.sourceUrl) out.url = e.sourceUrl;
    } catch { /* a torn ledger line is not a source */ }
  }
  return out;
}

/** PURE. One draft's verdicts as a line per tweet, plus the drop list --fix would apply. */
export function renderDraft({ account, id, when, title, judged, source }) {
  const bad = judged.filter((j) => j.verdict === 'mismatch');
  const L = [`${account.padEnd(16)} ${String(id).padEnd(9)} ${when || 'unscheduled'}  ${String(title || '').slice(0, 40)}  [${source}]`];
  for (const j of judged) {
    const mark = j.verdict === 'mismatch' ? '✗' : j.verdict === 'unmapped' ? '·' : j.verdict === 'unclear' ? '?' : '✓';
    L.push(`   ${mark} T${String(j.idx + 1).padStart(2)} ${String(j.count)} item(s)  ${j.verdict.padEnd(8)} ${j.why}`);
  }
  if (!judged.length) L.push('   (no media)');
  return { text: L.join('\n'), drop: bad.map((j) => j.idx) };
}

/** The donor's items, from the swipe row's per-tweet records: number, marker, text, has-media. */
async function donorItems(at, recId) {
  const head = await at.getRecord(TABLES.swipe, recId);
  const out = [];
  for (const id of head.fields.Tweets || []) {
    const f = (await at.getRecord(TABLES.swipe, id)).fields;
    const n = f['Tweet Number'] || 0;
    const hasMedia = !!((f.Media || []).length || f['Video URL'] || (f['Video File'] || []).length || f['Media Type'] === 'Video');
    if (!hasMedia) continue;
    out.push({ n, lesson: lessonNum(f.Text), text: f.Text || '', kind: (f.Media || [])[0]?.type?.startsWith('video') || f['Video URL'] ? 'video' : 'image' });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The items of one of OUR OWN drafts, by id — the attempt lane's source. An attempt is a verbatim
 *  repost of a body that already ran, and the ledger records that body as "evergreen-<draftId>"
 *  rather than a swipe record. Tries the page it is being judged on first, then the rest of the
 *  fleet, because a body travels across pages. */
export const parentDraftId = (recId) => { const m = String(recId || '').match(/^[a-z]+-(\d{6,})$/i); return m ? m[1] : null; };
async function parentItems(tf, id, preferKey) {
  const keys = [preferKey, ...Object.keys(ACCOUNTS).filter((k) => k !== preferKey)].filter(Boolean);
  for (const k of keys) {
    const a = ACCOUNTS[k];
    if (!a?.socialSetId) continue;
    let d; try { d = await tf.getDraft(a.socialSetId, id); } catch { continue; }
    return (d.platforms?.x?.posts || []).map((p, i) => ({ n: i + 1, lesson: lessonNum(p.text), text: String(p.text || ''), kind: 'image', has: (p.media_ids || []).length }))
      .filter((x) => x.has);
  }
  return null;
}

/** A plant's origin items: the harvested body its seed came from, read off Typefully. */
async function originItemsFor(env, at, tf, seedRecId, potOf) {
  const seeds = await at.listAll('Seeds', {});
  const seed = seeds.find((r) => r.id === seedRecId) || (potOf ? seeds.find((r) => r.fields.Name === potOf) : null);
  const harvestId = (seed?.fields?.['Source Harvest'] || [])[0];
  if (!harvestId) return null;
  const harvest = (await at.listAll('Harvests', {})).find((r) => r.id === harvestId);
  const originKey = String(harvest?.fields?.['Origin Account'] || '').trim().split(/\s+/)[0].toLowerCase();
  const originDraftId = String(harvest?.fields?.['Origin Draft ID'] || '');
  if (!originDraftId) return null;
  let origin; try { origin = getAccount(originKey); } catch { return null; }
  const d = await tf.getDraft(origin.socialSetId, originDraftId);
  return (d.platforms?.x?.posts || []).map((p, i) => ({ n: i + 1, lesson: lessonNum(p.text), text: p.text || '', kind: 'image', has: (p.media_ids || []).length }))
    .filter((x) => x.has);
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'AIRTABLE_PAT', 'XDB_BASE_ID']);
  const tf = typefully(env), xdb = airtable(env), reg = airtable(env, env.REGISTRY_BASE_ID);
  const DAY = cliArg('day', null), ONE = cliArg('draft', null), FIX = process.argv.includes('--fix');
  if (!DAY && !ONE) { console.error('usage: node media-audit.mjs --day <YYYY-MM-DD> | --draft <id> --account <key> [--fix] [--json]'); process.exit(2); }
  const lines = existsSync(join(HERE_DIR, 'ledger.jsonl')) ? readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean) : [];

  // Which drafts to read.
  const targets = [];
  if (ONE) {
    const key = resolveAccountKey(cliArg('account', '')) || null;
    if (!key) { console.error('--draft needs --account <key>'); process.exit(2); }
    targets.push({ key, id: String(ONE) });
  } else {
    const lo = Date.parse(`${DAY}T00:00:00+07:00`), hi = lo + 864e5;
    for (const [key, a] of Object.entries(ACCOUNTS)) {
      if (!a.socialSetId || a.paused || key === 'aiEvolution') continue;
      for (const st of ['scheduled', 'published']) for (let o = 0; ; o += 50) {
        const j = await tf.get(`/social-sets/${a.socialSetId}/drafts?status=${st}&limit=50&offset=${o}`);
        for (const d of (j.results || [])) {
          const t = Date.parse(d.published_at || d.scheduled_date || 0);
          if (!(t >= lo && t < hi)) continue;
          if (/^\[(single|warmup)\]/i.test(String(d.draft_title || ''))) continue;   // the singles lane carries no donor media
          targets.push({ key, id: String(d.id), live: !!d.published_at });
        }
        if (!j.next || !(j.results || []).length) break;
      }
    }
  }

  const rows = [], unchecked = [];
  for (const t of targets) {
    const acc = ACCOUNTS[t.key];
    const draft = await tf.getDraft(acc.socialSetId, t.id);
    const posts = (draft.platforms?.x?.posts || []).map((p) => ({ text: String(p.text || ''), media_ids: [...(p.media_ids || [])] }));
    if (!posts.some((p) => p.media_ids.length)) continue;                    // nothing to judge
    const src = sourceOf(lines, t.id);
    let items = null, label = null;
    const parent = parentDraftId(src.recId);
    if (parent) { try { items = await parentItems(tf, parent, t.key); label = `our own draft ${parent} (attempt)`; } catch (e) { label = `parent ${parent} unreadable: ${String(e.message).slice(0, 40)}`; } }
    else if (src.recId) { try { items = await donorItems(xdb, src.recId); label = `donor ${src.recId}`; } catch (e) { label = `donor ${src.recId} unreadable: ${String(e.message).slice(0, 40)}`; } }
    else if (src.seedRecId || src.potOf) { try { items = await originItemsFor(env, reg, tf, src.seedRecId, src.potOf); label = `seed ${src.potOf || src.seedRecId}`; } catch (e) { label = `seed unreadable: ${String(e.message).slice(0, 40)}`; } }
    if (!items) { unchecked.push({ ...t, name: acc.name, why: label || 'no source in the ledger', media: posts.filter((p) => p.media_ids.length).length }); continue; }
    const judged = judgeMedia(posts, items);
    rows.push({ key: t.key, account: acc.name, id: t.id, when: (draft.published_at || draft.scheduled_date || '').slice(0, 16).replace('T', ' '), live: !!draft.published_at,
      title: String(draft.draft_title || '').replace(/^\[[^\]]+\]\s*/, ''), source: label, judged, draft, posts });
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ day: DAY, rows: rows.map(({ draft, posts, ...r }) => r), unchecked }, null, 1));
    return;
  }
  console.log(`\nMEDIA AUDIT — ${DAY || `draft ${ONE}`} · ${rows.length} draft(s) with media${unchecked.length ? ` · ${unchecked.length} unchecked` : ''}\n`);
  let mismatches = 0, unclear = 0;
  for (const r of rows) {
    unclear += r.judged.filter((j) => j.verdict === 'unclear').length;
    const { text, drop } = renderDraft(r);
    mismatches += drop.length;
    console.log(text);
    r.drop = drop;
  }
  for (const u of unchecked) console.log(`⚠ ${u.name.padEnd(16)} ${u.id.padEnd(9)} ${u.media} tweet(s) with media — UNCHECKED: ${u.why}`);
  console.log(`\n${mismatches} mismatched tweet(s) across ${rows.filter((r) => r.drop.length).length} draft(s)${unclear ? ` · ${unclear} unclear (read those yourself; --fix never touches them)` : ''}${FIX ? '' : mismatches ? ' — pass --fix to drop that media' : ''}`);
  if (!FIX || !mismatches) return;

  console.log('\n── fix: dropping the mismatched media (the tweet keeps its text; nothing else is touched) ──');
  for (const r of rows.filter((x) => x.drop.length)) {
    const acc = ACCOUNTS[r.key];
    const fresh = await tf.getDraft(acc.socialSetId, r.id);       // re-read: it may have published since the scan
    if (fresh.published_at) { console.log(`   ✗ ${r.account} ${r.id} already published — left alone`); continue; }
    const when = Date.parse(fresh.scheduled_date || 0);
    if (when && when - Date.now() < INSIDE_MIN * 60e3) { console.log(`   ✗ ${r.account} ${r.id} inside ${INSIDE_MIN} minutes of its slot — left alone`); continue; }
    const posts = (fresh.platforms?.x?.posts || []).map((p) => ({ text: String(p.text || ''), media_ids: [...(p.media_ids || [])] }));
    for (const i of r.drop) { if (posts[i]) posts[i].media_ids = []; }
    const platformPosts = mediaAcrossPlatforms(posts, fresh.platforms);
    const res = await tf.patchDraft(acc.socialSetId, r.id, { platforms: buildPlatforms(posts, { existing: fresh.platforms, account: acc, platformPosts }) });
    const left = (res.platforms?.x?.posts || []).map((p, i) => ((p.media_ids || []).length ? `T${i + 1}[${p.media_ids.length}]` : null)).filter(Boolean).join(' ') || 'none';
    console.log(`   ✓ ${r.account.padEnd(16)} ${r.id} dropped ${r.drop.map((i) => `T${i + 1}`).join(', ')} → ${left} · sched ${res.scheduled_date || 'unscheduled'}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'media-audit');
