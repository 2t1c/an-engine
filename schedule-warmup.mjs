#!/usr/bin/env node
// schedule-warmup.mjs — place a new page's WARM-UP tweets, the two days before it goes live.
//
// Phase 2 of onboarding (operator 2026-08-31): "the first 2 days after connecting to Typefully...
// every day you post 2 tweets, and each is just a normal tweet about health advice, just 1 tweet
// each, and 2 tweets per day per account." After that the RT bridge and Fuel the Fire go on.
//
// A brand-new X account posting affiliate threads is a ban magnet. Two days of ordinary posting
// gives the page a history before it ever asks for anything, and that history is the whole point:
// no link, no #ad, no product, no CTA, no disclaimer. A disclaimer on a warm-up tweet advertises
// the page as a storefront on day one, which is the opposite of warming it.
//
// NEITHER EXISTING SCHEDULER FITS, and the reasons are worth stating rather than working around:
//   - schedule-day.mjs places ONE post per account per lane per day into that account's lane slot.
//     Warm-up is two a day and is not a lane; its day-guard would correctly refuse the second.
//   - publish-thread.mjs runs the full monetization gates. A warm-up tweet has no plug, closer or
//     disclaimer ON PURPOSE, so plug-count, disclaimer and closing would all reject it. Those
//     gates are right. The content is simply not a monetized thread.
//
//   node schedule-warmup.mjs                       # dry: the full plan, writes nothing
//   node schedule-warmup.mjs --apply               # create the drafts, scheduled
//   node schedule-warmup.mjs --file queues/x.json --days 2026-09-01,2026-09-02
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { buildPlatforms } from './platforms.mjs';
import { effLen, hardHealthClaim, hardHealthClaimMatch } from './checks.mjs';
import { POST_WINDOWS, MIN_SLOT_GAP_MIN } from './slots.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('file', 'queues/warmup-2026-08-31.json');

// Two slots a day, deliberately OUTSIDE every POST_WINDOW: a warm-up tweet landing in one would put
// a page with no history in the same minute as the fleet's monetized posts.
//
// RE-SITED 2026-09-19. The windows were restructured into Cloud (04:00-09:00 UTC) and Moon
// (10:00-16:30) at some point after this file was written, and the evening slot at 12:00 had been
// sitting squarely inside Moon ever since — the guard below caught it on the johnathan/felicia
// batch and refused to write, which is the guard doing its job while the constant lied. The comment
// here described a 06:00-08:00 cover window and a 21:00-00:00 harvest window; neither exists now.
//
// Derive rather than trust: outside Sun, Cloud and Moon the only free UTC gaps are 00:00-04:00
// (07:00-11:00 Saigon), 09:00-10:00 (16:00-17:00) and 16:30-18:00 (23:30-01:00). The last is the
// middle of the night in Saigon, so the two usable slots are the morning one and the hour between
// Cloud and Moon. 09:00 and 16:15 Saigon is when a person posts.
//
// The stagger below adds 7 minutes per account, so the afternoon slot has 45 minutes of headroom
// before it would reach Moon at 10:00 UTC — enough for six accounts in one batch.
const SLOTS_UTC = [{ h: 2, m: 0 }, { h: 9, m: 15 }];
// Per-account stagger. Same reasoning as the lane slots: Typefully publishes on a polling tick, so
// two drafts under MIN_SLOT_GAP_MIN apart can land in the same minute and read as automation.
const STAGGER_MIN = 7;

/** Every reason this tweet must not post as a warm-up. A warm-up tweet is defined as much by what
 *  it does NOT carry as by what it says, so the absences are checked as hard as the presences. */
export function warmupIssues(text) {
  const out = [];
  const n = effLen(text);
  if (n > 280) out.push(`over 280 (${n})`);
  if (!text.trim()) out.push('empty');
  if (/[—–]/.test(text)) out.push('em/en dash');
  if (/https?:\/\//.test(text)) out.push('carries a link — a warm-up tweet sells nothing');
  if (/#ad\b/i.test(text)) out.push('carries #ad with nothing to disclose');
  if (/affiliate|commission|not medical advice|FDA/i.test(text)) out.push('reads as a disclaimer — nothing to disclose yet');
  if (hardHealthClaim(text)) out.push(`hard health claim ("${hardHealthClaimMatch(text)}")`);
  if (/\bcancer\b|oncolog/i.test(text)) out.push('BANNED TOPIC');
  return out;
}

/** Pure: when each tweet fires. Two per day per account, staggered so no two accounts share a
 *  minute. Exported so a test can pin the spacing without touching the network.
 *
 *  `taken` (2026-09-07): minutes the FLEET already posts in, as 'YYYY-MM-DDTHH:MM' keys. The
 *  stagger only ever spaced warm-ups against each other; a single, a cover or an attempt on any
 *  other page sitting in the same minute was invisible, and Typefully's poller can land two posts
 *  under 2 minutes apart on one tick. A warm-up now slides forward, minute by minute, until it is
 *  at least `gap` minutes from everything taken and from every warm-up already placed. */
export function plan(accounts, days, { slots = SLOTS_UTC, stagger = STAGGER_MIN, taken = new Set(), gap = 2 } = {}) {
  const out = [];
  const minuteOf = (k) => Math.floor(Date.parse(`${k}:00Z`) / 60e3);
  const used = new Set([...taken].map(minuteOf).filter(Number.isFinite));
  const tooClose = (m) => { for (const u of used) if (Math.abs(u - m) < gap) return true; return false; };
  accounts.forEach((a, idx) => {
    days.forEach((day, di) => {
      const texts = di === 0 ? a.day1 : a.day2;
      (texts || []).forEach((text, ti) => {
        const s = slots[ti] || slots[slots.length - 1];
        const at = new Date(`${day}T00:00:00Z`);
        at.setUTCHours(s.h, s.m + idx * stagger, 0, 0);
        let shifted = 0;
        while (tooClose(Math.floor(at.getTime() / 60e3))) { at.setTime(at.getTime() + 60e3); shifted++; }
        used.add(Math.floor(at.getTime() / 60e3));
        out.push({ key: a.key, name: a.name, socialSetId: a.socialSetId, day, text, at: at.toISOString(), shifted });
      });
    });
  });
  return out.sort((x, y) => x.at.localeCompare(y.at));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const src = JSON.parse(readFileSync(join(HERE_DIR, FILE), 'utf8'));
  const days = String(arg('days', '2026-09-01,2026-09-02')).split(',').map((s) => s.trim());

  const accounts = Object.entries(src.accounts || {}).map(([key, v]) => ({ key, ...v, ...(ACCOUNTS[key] ? { name: ACCOUNTS[key].name, socialSetId: ACCOUNTS[key].socialSetId } : {}) }));
  const missing = accounts.filter((a) => !a.socialSetId);
  if (missing.length) throw new Error(`no socialSetId for ${missing.map((a) => a.key).join(', ')} — is the block in accounts.mjs?`);

  // 0. Every minute the FLEET already posts in on these days — all pages, all lanes — so a warm-up
  //    never shares a minute (or the neighbouring one) with a single, a cover or an attempt anywhere.
  const taken = new Set();
  const dayLo = Math.min(...days.map((d) => Date.parse(`${d}T00:00:00Z`))), dayHi = Math.max(...days.map((d) => Date.parse(`${d}T00:00:00Z`))) + 864e5;
  for (const [key, acc] of Object.entries(ACCOUNTS)) {
    if (!acc.socialSetId || key === 'burner') continue;
    for (let o = 0; ; o += 50) {
      const j = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=scheduled&limit=50&offset=${o}`);
      for (const d of (j.results || [])) { const t = Date.parse(d.scheduled_date || 0); if (t >= dayLo && t < dayHi) taken.add(new Date(t).toISOString().slice(0, 16)); }
      if (!j.next || !(j.results || []).length) break;
    }
  }

  const rows = plan(accounts, days, { taken });
  const moved = rows.filter((r) => r.shifted).length;
  console.log(`\nWARM-UP — ${accounts.length} account(s) × ${days.length} day(s) × 2 = ${rows.length} tweet(s) · ${taken.size} fleet minute(s) already taken on these days · ${moved} warm-up(s) shifted off them\n`);

  // 1. Copy checks, re-run at write time rather than trusted from when they were written.
  let bad = 0;
  for (const r of rows) {
    r.issues = warmupIssues(r.text);
    if (r.issues.length) bad++;
  }

  // 2. Nothing may share a minute, with anything — including the account's own live queue.
  const mins = rows.map((r) => r.at.slice(0, 16));
  const clash = [...new Set(mins.filter((m, i) => mins.indexOf(m) !== i))];
  const inWindow = rows.filter((r) => {
    const min = new Date(r.at).getUTCHours() * 60 + new Date(r.at).getUTCMinutes();
    return POST_WINDOWS.some((w) => (w.startMin < 0 ? min >= 1440 + w.startMin || min <= w.endMin : min >= w.startMin && min <= w.endMin));
  });

  // 3. The account's existing scheduled drafts, so a warm-up tweet cannot land on a lane post.
  const busy = new Map();
  for (const a of accounts) {
    const seen = new Set();
    for (let o = 0; ; o += 50) {
      const j = await tf.get(`/social-sets/${a.socialSetId}/drafts?status=scheduled&limit=50&offset=${o}`);
      for (const d of (j.results || [])) if (d.scheduled_date) seen.add(new Date(d.scheduled_date).toISOString().slice(0, 16));
      if (!j.next || !(j.results || []).length) break;
    }
    busy.set(a.key, seen);
  }
  for (const r of rows) if (busy.get(r.key)?.has(r.at.slice(0, 16))) r.issues.push('the account already has a draft in this minute');

  const sg = (iso) => new Date(Date.parse(iso) + 7 * 3600e3).toISOString().slice(11, 16);
  for (const r of rows) {
    console.log(`  ${r.at.slice(0, 16).replace('T', ' ')}Z  ${sg(r.at)} SGN  ${r.name.padEnd(16)} ${String(effLen(r.text)).padStart(3)}ch  ${r.issues.length ? `✗ ${r.issues.join(' · ')}` : '✓'}${r.shifted ? `  (+${r.shifted} min: fleet minute taken)` : ''}`);
    console.log(`      ${r.text.split('\n')[0].slice(0, 96)}`);
  }

  const blocked = rows.filter((r) => r.issues.length).length;
  console.log(`\n  ${rows.length - blocked} ready · ${blocked} blocked`
    + (clash.length ? `   ** MINUTE CLASH: ${clash.join(', ')} **` : '   no minute shared')
    + (inWindow.length ? `   ** ${inWindow.length} INSIDE A POSTING WINDOW **` : '   all clear of cover and harvest'));

  if (blocked || clash.length || inWindow.length) { console.log('\n✗ fix the above before writing\n'); process.exitCode = 1; return; }
  if (!APPLY) { console.log('\n(dry run — pass --apply to create the drafts)\n'); return; }

  let made = 0;
  for (const r of rows) {
    const acc = ACCOUNTS[r.key];
    // X only: none of these accounts declares a crossPost list, and a warm-up tweet has no business
    // fanning out to Threads and LinkedIn before the page has posted anything at all.
    const draft = await tf.createDraft(acc.socialSetId, {
      draft_title: `[warmup] ${acc.name} · ${r.day}`,
      share: true,
      platforms: buildPlatforms([{ text: r.text }], { account: acc }),
      publish_at: r.at,
    });
    made++;
    console.log(`  ✓ ${r.name.padEnd(16)} ${r.at.slice(0, 16).replace('T', ' ')}Z  ${draft.share_url || draft.id}`);
  }
  console.log(`\n✓ ${made} warm-up draft(s) scheduled. No ledger row and no media pass: there is nothing to attribute.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'schedule-warmup');
