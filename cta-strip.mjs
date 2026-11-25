#!/usr/bin/env node
// cta-strip.mjs <plan.json> --assign | --apply — the one-ask arm of the CTA experiment.
//
// THE QUESTION (operator 2026-09-07): does carrying two asks cost a thread reach against carrying
// one? The fleet standard is heavy + light. History cannot answer it — one-plug threads in the
// registry are June-July across 9 accounts and two-plug are August-September across 21, so the 3.9x
// view gap between them measures the fleet growing, not the ask count. Only a randomized split can.
//
// THE ARM. Half the covers already scheduled keep both asks (control); half lose the LIGHT one
// (treatment). Stripping is not deleting the plug tweet:
//
//   · deleting the whole light chain removes ~3 tweets, and thread LENGTH is itself a reach
//     variable — that measures two changes at once
//   · deleting only the ask leaves the body arguing a substance it never sells, which is the shape
//     orphanSubstanceIssue exists to catch
//
// So the light plug is REPLACED by a non-commercial tweet of similar length on the substance already
// argued, and its bridge loses only the hand-off line ("So this is what I look for ↓") so nothing
// dangles into an ask that is gone. Same tweet count, same length, one ask instead of two. That is
// the variable isolated, and it is the only thing that differs between the arms.
//
//   node cta-strip.mjs queues/run-2026-09-08.json --assign          # choose the arms, write the worksheet
//   node cta-strip.mjs queues/run-2026-09-08.json --apply --dry     # gate + show every edit, write nothing
//   node cta-strip.mjs queues/run-2026-09-08.json --apply           # patch, retitle [cta1], record the arm
//
// The replacement copy is NOT generated here. --assign writes a worksheet naming each thread's light
// chain; a writer fills in `replacement`; --apply refuses any row still blank. Copy gets read before
// it ships, the same rule every other lane follows.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, typefully, cliArg, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS, getAccount } from './accounts.mjs';
import { checkThread, effLen } from './checks.mjs';
import { buildPlatforms } from './platforms.mjs';
import { mediaAcrossPlatforms } from './media-map.mjs';

export const ARM = 'single-cta';
export const TITLE_TAG = '[cta1]';
export const WORKSHEET = 'queues/cta-experiment.json';
// The hand-off is the bridge's last line, the one that promises an ask on the next tweet. With the
// ask gone it is a lie, so it is the one line the strip removes. Every form the fleet's bridges use.
const HANDOFF_RE = /\n+\s*(?:so\s+)?(?:this is|here is|here's)?\s*what I look for\s*↓\s*$|\n+[^\n]*↓\s*$/i;
const isPlug = (t) => /lvnta\.com\/|gumroad\.com\//i.test(String(t));

/** PURE. FNV-1a, the same hash the vendor routes use, so one idiom covers every deterministic
 *  assignment in the repo. Stable across runs and machines, which is what makes an arm auditable. */
export function hash32(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** PURE. The light chain in a thread: every plug, the LIGHT one (the last), and its bridge (the
 *  tweet before it). Returns null when there is nothing to strip — one plug already, or none. */
export function lightChain(posts = []) {
  const plugs = posts.map((t, i) => (isPlug(t) ? i : -1)).filter((i) => i >= 0);
  if (plugs.length < 2) return null;
  const lightIdx = plugs[plugs.length - 1];
  const bridgeIdx = lightIdx - 1;
  const bridge = String(posts[bridgeIdx] ?? '');
  return { plugs, heavyIdx: plugs[0], lightIdx, bridgeIdx, hasHandoff: HANDOFF_RE.test(bridge) };
}

/** PURE. The bridge without its hand-off line. Untouched when it carries none. */
export const stripHandoff = (text) => String(text).replace(HANDOFF_RE, '').replace(/\s+$/, '');

/** PURE. Assign arms over one day's covers, hitting `want` treatments, and never leaving a page that
 *  has two or more covers in the window entirely in one arm.
 *  rows — [{ account, draftId }] for ONE day. Returns a Map draftId -> 'single-cta' | 'control'. */
export function assignDay(rows, want, seed, pageCounts = {}) {
  const ranked = [...rows].sort((a, b) => hash32(`${seed}:${a.account}:${a.draftId}`) - hash32(`${seed}:${b.account}:${b.draftId}`));
  const out = new Map(ranked.map((r) => [String(r.draftId), 'control']));
  for (const r of ranked.slice(0, Math.max(0, Math.min(want, ranked.length)))) out.set(String(r.draftId), ARM);
  return out;
}

/** PURE. Assign across every day at once, so the per-page rule can see the whole window.
 *  covers — [{ day, account, draftId }]. `perDay` — { day: treatmentCount }. */
export function assignArms(covers, perDay, seed = 'R2026-09-08') {
  const arms = new Map();
  const byDay = {};
  for (const c of covers) (byDay[c.day] ||= []).push(c);
  for (const [day, rows] of Object.entries(byDay)) for (const [id, arm] of assignDay(rows, perDay[day] ?? Math.floor(rows.length / 2), seed)) arms.set(id, arm);

  // Per-page repair. A page holding two or more covers in the window must appear in BOTH arms, or its
  // own effect rides entirely on one condition and the comparison inherits it. Repairs are made by
  // SWAPPING within a day, so every day's count stays exactly where the plan put it.
  const byPage = {};
  for (const c of covers) (byPage[c.account] ||= []).push(c);
  for (const [, list] of Object.entries(byPage)) {
    if (list.length < 2) continue;
    const armed = list.filter((c) => arms.get(String(c.draftId)) === ARM);
    if (armed.length && armed.length < list.length) continue;              // already split
    const lonely = armed.length ? list : list;                              // all one way, either way
    const from = lonely[0];
    const wantArm = armed.length ? 'control' : ARM;                         // what `from` must become
    // Find a partner on the SAME day, on a different page, currently holding wantArm, whose own page
    // would survive the swap. Swapping keeps the day's treatment count identical.
    const partner = covers.find((c) => c.day === from.day && c.account !== from.account
      && arms.get(String(c.draftId)) === wantArm
      && ((byPage[c.account] || []).length < 2 || (byPage[c.account] || []).some((x) => String(x.draftId) !== String(c.draftId) && arms.get(String(x.draftId)) === wantArm)));
    if (!partner) continue;                                                 // nothing safe to trade: leave it, the report says so
    const a = arms.get(String(from.draftId));
    arms.set(String(from.draftId), arms.get(String(partner.draftId)));
    arms.set(String(partner.draftId), a);
  }
  return arms;
}

/** PURE. Split a total across days by largest remainder, so the arm lands on half the pool overall
 *  rather than half of each day rounded down. Same idiom plan-singles uses to split a day's posts. */
export function splitByDay(counts, total) {
  const keys = Object.keys(counts);
  const exact = keys.map((k) => (counts[k] * total) / keys.reduce((s, x) => s + counts[x], 0));
  const out = {}; let used = 0;
  keys.forEach((k, i) => { out[k] = Math.min(counts[k], Math.floor(exact[i])); used += out[k]; });
  const order = keys.map((k, i) => ({ k, r: exact[i] - Math.floor(exact[i]) })).sort((a, b) => b.r - a.r || keys.indexOf(a.k) - keys.indexOf(b.k));
  for (const { k } of order) { if (used >= total) break; if (out[k] < counts[k]) { out[k]++; used++; } }
  return out;
}

/** PURE. The plan's cover rows for the days that can still carry an arm. */
export function coversOf(plan, days) {
  const out = [];
  for (const day of days) for (const r of (plan.days?.[day] || [])) if (r.bucket === 'cover' && r.draftId) out.push({ day, account: r.account, draftId: String(r.draftId), heavy: r.heavy, light: r.light, donor: r.donor || null });
  return out;
}

const short = (t, n = 90) => String(t).replace(/\s+/g, ' ').slice(0, n);

async function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) { console.error('usage: node cta-strip.mjs <plan.json> (--assign | --apply) [--dry] [--worksheet <f>] [--days a,b]'); process.exit(2); }
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const DRY = process.argv.includes('--dry');
  const wsPath = cliArg('worksheet', WORKSHEET);
  const days = (cliArg('days', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const env = loadEnv(); const tf = typefully(env);

  if (process.argv.includes('--assign')) {
    const today = new Date().toISOString().slice(0, 10);
    const use = days.length ? days : Object.keys(plan.days || {}).filter((d) => d > today).sort();
    const all = coversOf(plan, use);
    if (!all.length) throw new Error(`no cover rows with a draft id on ${use.join(', ')}`);
    // Read every thread FIRST: only a genuine two-ask cover can carry the arm. A roundup selling
    // three or four picks is a different animal — the plug budget deliberately allows one ask per
    // product there (LAWS.plugs.roundupMinProducts), so removing one leaves three asks rather than
    // one, and removing all but the heavy would destroy the form rather than test it.
    const read = new Map(); const excluded = [];
    for (const c of all) {
      const d = await tf.getDraft(ACCOUNTS[c.account].socialSetId, c.draftId);
      const posts = (d.platforms?.x?.posts || []).map((p) => String(p.text || ''));
      read.set(String(c.draftId), { d, posts, chain: lightChain(posts) });
      const n = posts.filter(isPlug).length;
      if (n !== 2) excluded.push({ ...c, plugs: n, why: n > 2 ? `${n}-ask roundup` : `${n} ask` });
    }
    const covers = all.filter((c) => !excluded.some((x) => String(x.draftId) === String(c.draftId)));
    if (excluded.length) {
      console.log(`excluded from the experiment — not two-ask covers:`);
      for (const x of excluded) console.log(`   ${x.day} ${x.account.padEnd(9)} ${x.draftId}  ${x.why}`);
      console.log('');
    }
    const counts = {};
    for (const d of use) counts[d] = covers.filter((c) => c.day === d).length;
    const perDay = splitByDay(counts, Math.round(covers.length / 2));
    const arms = assignArms(covers, perDay, String(plan.batch || 'run'));
    const rows = [];
    for (const c of covers) {
      const { d, posts, chain } = read.get(String(c.draftId));
      const arm = arms.get(String(c.draftId));
      rows.push({
        day: c.day, account: c.account, draftId: c.draftId, arm,
        title: d.draft_title, scheduled: d.scheduled_date, tweets: posts.length, plugs: chain ? chain.plugs.length : 0,
        hasHandoff: chain ? chain.hasHandoff : null,
        heavy: c.heavy, light: c.light, donor: c.donor,
        lightTweet: chain ? chain.lightIdx + 1 : null,
        bridgeTweet: chain ? chain.bridgeIdx + 1 : null,
        lightText: chain ? posts[chain.lightIdx] : null,
        bridgeText: chain ? posts[chain.bridgeIdx] : null,
        bridgeAfterStrip: chain ? stripHandoff(posts[chain.bridgeIdx]) : null,
        targetLen: chain ? effLen(posts[chain.lightIdx]) : null,
        replacement: arm === ARM ? '' : null,
      });
    }
    const armed = rows.filter((r) => r.arm === ARM);
    console.log(`${rows.length} cover(s) over ${use.length} day(s) — ${armed.length} to strip, ${rows.length - armed.length} control\n`);
    for (const d of use) {
      const on = rows.filter((r) => r.day === d);
      console.log(`${d}  ${on.filter((r) => r.arm === ARM).length} strip / ${on.length}`);
      for (const r of on.sort((a, b) => String(a.scheduled).localeCompare(String(b.scheduled)))) {
        console.log(`   ${r.arm === ARM ? '✂ STRIP ' : '  control'} ${r.account.padEnd(9)} ${r.draftId}  ${String(r.tweets).padStart(2)}t  light T${r.lightTweet ?? '?'} (${r.targetLen ?? '?'} ch)${r.arm === ARM && !r.lightTweet ? '  ** NO SECOND PLUG — cannot strip **' : ''}`);
      }
    }
    const pages = {};
    for (const r of rows) (pages[r.account] ||= []).push(r.arm);
    const lopsided = Object.entries(pages).filter(([, a]) => a.length > 1 && new Set(a).size === 1);
    console.log(`\npages in both arms: ${Object.values(pages).filter((a) => a.length > 1 && new Set(a).size > 1).length} of ${Object.values(pages).filter((a) => a.length > 1).length} with 2+ covers`);
    if (lopsided.length) console.log(`  ⚠ one-armed pages: ${lopsided.map(([k, a]) => `${k} (${a.length}x ${a[0]})`).join(', ')}`);
    writeFileSync(wsPath, JSON.stringify({ batch: plan.batch, seed: plan.batch, assignedAt: new Date().toISOString(), rows }, null, 1) + '\n');
    console.log(`\nworksheet: ${wsPath}\n  fill \`replacement\` on every ✂ row (a non-commercial tweet of about its target length), then --apply --dry`);
    return;
  }

  if (!process.argv.includes('--apply')) { console.error('pass --assign or --apply'); process.exit(2); }
  if (!existsSync(wsPath)) throw new Error(`no worksheet at ${wsPath} — run --assign first`);
  const ws = JSON.parse(readFileSync(wsPath, 'utf8'));
  const todo = ws.rows.filter((r) => r.arm === ARM);
  const blank = todo.filter((r) => !String(r.replacement || '').trim());
  if (blank.length) { console.log(`✗ ${blank.length} row(s) still have no replacement copy: ${blank.map((r) => r.account).join(', ')}`); process.exitCode = 1; return; }

  let done = 0, skipped = 0;
  for (const r of todo) {
    const acc = getAccount(r.account);
    const d = await tf.getDraft(acc.socialSetId, r.draftId);
    if (d.published_at) { console.log(`  ✗ ${r.account} ${r.draftId} already published — left alone`); skipped++; continue; }
    const when = Date.parse(d.scheduled_date || 0);
    if (when && when - Date.now() < 15 * 60e3) { console.log(`  ✗ ${r.account} ${r.draftId} inside the 15-minute window — left alone`); skipped++; continue; }
    const posts = (d.platforms?.x?.posts || []).map((p) => ({ text: String(p.text || ''), media_ids: [...(p.media_ids || [])] }));
    const chain = lightChain(posts.map((p) => p.text));
    if (!chain) { console.log(`  ✗ ${r.account} ${r.draftId} has no second plug any more — left alone`); skipped++; continue; }
    const before = posts.map((p) => p.text);
    const next = posts.map((p) => ({ ...p }));
    next[chain.lightIdx].text = String(r.replacement).trim();
    if (chain.hasHandoff) next[chain.bridgeIdx].text = stripHandoff(next[chain.bridgeIdx].text);
    const tweets = next.map((p) => p.text);

    const over = tweets.map((t, i) => ({ i: i + 1, n: effLen(t) })).filter((x) => x.n > 280);
    const issues = checkThread(tweets, { account: acc, link: null, monetized: true, arm: ARM });
    const errs = issues.filter((i) => i.severity === 'error');
    console.log(`\n${r.arm === ARM ? '✂' : ' '} ${r.account} ${r.draftId} — T${chain.bridgeIdx + 1} bridge, T${chain.lightIdx + 1} ask${chain.hasHandoff ? '' : '  (bridge carried no hand-off)'}`);
    console.log(`   T${chain.bridgeIdx + 1} was: …${short(before[chain.bridgeIdx].slice(-70), 70)}`);
    console.log(`   T${chain.bridgeIdx + 1} now: …${short(tweets[chain.bridgeIdx].slice(-70), 70)}`);
    console.log(`   T${chain.lightIdx + 1} was (${effLen(before[chain.lightIdx])} ch): ${short(before[chain.lightIdx])}`);
    console.log(`   T${chain.lightIdx + 1} now (${effLen(tweets[chain.lightIdx])} ch): ${short(tweets[chain.lightIdx])}`);
    console.log(`   plugs ${chain.plugs.length} -> ${tweets.filter(isPlug).length} · tweets ${before.length} -> ${tweets.length} · gate ${errs.length ? '✗ ' + errs.map((e) => `[${e.code}] ${e.msg}`).join(' | ') : '✓'}${over.length ? ` · OVER 280: ${over.map((o) => `#${o.i}(${o.n})`).join(' ')}` : ''}`);
    if (errs.length || over.length) { console.log('   → not written'); skipped++; continue; }
    if (DRY) continue;
    const title = String(d.draft_title || '').startsWith(TITLE_TAG) ? d.draft_title : `${TITLE_TAG} ${String(d.draft_title || '').replace(/^\[Cover\]\s*/i, '')}`;
    const platformPosts = mediaAcrossPlatforms(next, d.platforms);
    await tf.patchDraft(acc.socialSetId, r.draftId, {
      draft_title: title,
      platforms: buildPlatforms(next, { existing: d.platforms, account: acc, platformPosts }),
    });
    console.log(`   ✓ written · retitled ${TITLE_TAG}`);
    done++;
  }
  // The arm rides on the plan row too, so the readout joins on the same record the thread shipped from.
  if (!DRY && done) {
    for (const day of Object.keys(plan.days || {})) for (const row of plan.days[day]) {
      const hit = todo.find((t) => String(t.draftId) === String(row.draftId));
      if (hit) row.arm = ARM;
    }
    for (const day of Object.keys(plan.days || {})) for (const row of plan.days[day]) {
      if (row.bucket === 'cover' && row.draftId && !row.arm && ws.rows.some((x) => String(x.draftId) === String(row.draftId))) row.arm = 'control';
    }
    writeFileSync(file, JSON.stringify(plan, null, 1) + '\n');
    console.log(`\nplan: arms recorded on ${ws.rows.length} cover row(s)`);
  }
  console.log(`\n${done} stripped, ${skipped} skipped${DRY ? ' (dry — nothing written)' : ''}`);
  if (skipped) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'cta-strip');
