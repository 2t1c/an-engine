// blitz.mjs — the winner-blitz lane (operator 2026-08-25: "if it's a winner, we want to reuse it
// across the accounts... we're actually building a machine").
//
// When a post goes viral AND pulls Levanta clicks, it spreads across the WHOLE fleet: six accounts
// over days 1-5, the rest by day 14 (wave knobs in laws.json scale.*). No total cap — we are
// reposting ourselves. CLICKS decide, never dollars (attribution can be wrong; the store-side
// counter is the aim). Viral posts UNDER the click bar are not blitzed: they get a pod-place CTA
// fix in their harvest variation first — weak clicks on big views is a placement defect, and
// spreading it multiplies the defect.
//
// This emits WORK ORDERS (queues/blitz/<parentDraftId>.json), never drafts: each scheduled account
// gets its thread written in-session (body verbatim, hook 90%-variant by default — identical is an
// allowed fast path), minted fresh per account, shipped via publish-thread with harvestOf stamped,
// so H4's readback can answer "does copy N still pull clicks".
//
//   node blitz.mjs            # list the queue, emit the top NEW rollout
//   node blitz.mjs --all      # emit every queued rollout
//   node blitz.mjs --dry      # list only
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAWS } from './laws.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { HERE_DIR, runMain } from './lib.mjs';

const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');

const levClicksOf = (f) => f.lifetimeClicks ?? f.affClicks ?? 0;

/** Pure: which published posts qualify for a blitz, best puller first. `emitted` = parent draftIds
 *  that already have a rollout (a blitz fires once per parent). */
export function blitzQueue(facts, { minViews = LAWS.scale.breakoutViews, minLevClicks = LAWS.scale.blitzMinLevClicks, emitted = new Set() } = {}) {
  const pub = (facts || []).filter((f) => ['Posted', 'Reposted', 'Winner', 'Repost Candidate'].includes(f.status));
  const q = pub
    .filter((f) => (f.views || 0) >= minViews && levClicksOf(f) >= minLevClicks && !emitted.has(String(f.draftId)))
    .sort((a, b) => levClicksOf(b) - levClicksOf(a));
  const fixFirst = pub
    .filter((f) => (f.views || 0) >= minViews && levClicksOf(f) < minLevClicks)
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  return { queue: q, fixFirst };
}

/** Pure: the fleet rollout for one parent. Wave 1 = blitzWave1Accounts over days 1..wave1Days;
 *  everyone else lands by blitzFullDays. The origin account is excluded (it re-runs via the
 *  auto-repost lane instead), day load respects the same-day source cap, and the account order is
 *  deterministic per parent so a re-run emits the identical schedule. */
export function buildRollout(parent, accounts, {
  wave1 = LAWS.scale.blitzWave1Accounts, wave1Days = LAWS.scale.blitzWave1Days,
  fullDays = LAWS.scale.blitzFullDays, perDay = LAWS.scale.sameDaySourceCap, startDate = null,
} = {}) {
  const others = (accounts || []).filter((a) => a.name !== parent.account);
  // Deterministic per-parent rotation: same parent -> same schedule, different parents start the
  // wave on different accounts, so blitzes spread the fleet's exposure instead of always leading
  // with the same page.
  const h = [...String(parent.draftId || '')].reduce((x, c) => (x * 31 + c.charCodeAt(0)) >>> 0, 7);
  const order = others.map((a, i) => others[(i + h) % others.length]);
  const start = startDate ? new Date(`${startDate}T00:00:00Z`) : null;
  const dayOf = (offset) => start ? new Date(start.getTime() + (offset - 1) * 864e5).toISOString().slice(0, 10) : offset;
  const schedule = [];
  let day = 1, onDay = 0;
  for (const [i, acc] of order.entries()) {
    const lastDay = i < wave1 ? wave1Days : fullDays;
    if (onDay >= perDay) { day++; onDay = 0; }
    if (i === wave1 && day < wave1Days + 1) { day = wave1Days + 1; onDay = 0; } // wave 2 never starts early
    if (day > lastDay) day = lastDay; // never overflow the window; the cap yields at most perDay*days accounts
    schedule.push({ account: acc.name, key: acc.key, day: dayOf(day) });
    onDay++;
  }
  return schedule;
}

async function main() {
  const facts = readFileSync(join(HERE_DIR, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const dir = join(HERE_DIR, 'queues', 'blitz');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const emitted = new Set(existsSync(dir) ? (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : []);
  const accounts = Object.values(ACCOUNTS).filter((a) => !a.paused && a.plugHeavyExample && a.socialSetId);

  const { queue, fixFirst } = blitzQueue(facts, { emitted });
  console.log(`BLITZ QUEUE — ${queue.length} ready (>=${(LAWS.scale.breakoutViews / 1e3).toFixed(0)}k views AND >=${LAWS.scale.blitzMinLevClicks} LEVANTA clicks) · ${emitted.size} already rolled out`);
  for (const f of queue.slice(0, 10)) console.log(`  ${String(levClicksOf(f)).padStart(5)} lev clicks · ${((f.views || 0) / 1e6).toFixed(1)}M · ${f.account} · draft ${f.draftId} · ${String(f.title || '').replace(/\s+/g, ' ').slice(0, 60)}`);
  if (fixFirst.length) {
    console.log(`\nCTA-FIX-FIRST (viral, under the click bar — pod-place their harvest variant, THEN blitz): ${fixFirst.length}`);
    for (const f of fixFirst.slice(0, 5)) console.log(`  ${String(levClicksOf(f)).padStart(5)} lev clicks · ${((f.views || 0) / 1e6).toFixed(1)}M · ${f.account} · draft ${f.draftId}`);
  }
  if (DRY || !queue.length) { if (!queue.length) console.log('\n(nothing new to roll out)'); return; }

  const led = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const monday = new Date(); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() + 1);
  for (const f of ALL ? queue : queue.slice(0, 1)) {
    const parentLed = led.find((e) => String(e.draftId) === String(f.draftId));
    const schedule = buildRollout(f, accounts, { startDate: monday.toISOString().slice(0, 10) });
    const spec = {
      blitzOf: String(f.draftId), parent: {
        account: f.account, hook: f.title || null, url: f.xUrl || null,
        views: f.views || 0, levClicks: levClicksOf(f),
        products: parentLed ? [
          ...(parentLed.asin ? [{ asin: parentLed.asin, title: parentLed.product }] : []),
          ...(parentLed.asin2 ? [{ asin: parentLed.asin2, title: parentLed.product2 }] : []),
        ] : [],
      },
      schedule,
      rules: [
        `Body VERBATIM; hook = 90% variant per account by default — identical is allowed when speed matters.`,
        'MINT FRESH per account (own subid). Same link merges every copy\'s revenue and the rollout is unreadable.',
        `Stamp harvestOf: "${f.draftId}" in every publish spec — the lineage that answers "does copy N still pull clicks".`,
        `Wave 1: ${LAWS.scale.blitzWave1Accounts} accounts by day ${LAWS.scale.blitzWave1Days}; full fleet by day ${LAWS.scale.blitzFullDays}; max ${LAWS.scale.sameDaySourceCap}/day.`,
      ],
    };
    writeFileSync(join(dir, `${f.draftId}.json`), JSON.stringify(spec, null, 1));
    console.log(`\n✓ rollout emitted → queues/blitz/${f.draftId}.json (${schedule.length} account(s), days 1-${LAWS.scale.blitzFullDays})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'blitz');
