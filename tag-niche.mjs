// tag-niche.mjs — self-healing Niche backfill for the swipe DB.
//
// WHY THIS EXISTS (2026-08-11 root-cause investigation)
// The Threads table's `Niche` is the field selection paths filter on (the weekly and daily engines,
// retired 2026-10-06, did). It is written during n8n ingestion — and it is missing on
// roughly 40% of thread heads. Two things the investigation established, both of which contradict
// what we assumed on 2026-08-08:
//   1. It is NOT a recent break. Untagged rows appear across the whole history (worst on the 2026-06-26
//      bulk import: 24 untagged / 7 tagged that day) and keep appearing intermittently since. Rows that
//      never got a niche are still stamped `Update Status = Done`, so the ingest pipeline considers them
//      complete — nothing retries them, and nothing ever will.
//   2. The swipe DB is NOT curated-health. The 100 biggest untagged heads (>=500K) include political
//      announcements, NVIDIA/Anthropic product launches, celebrity news and movie trailers, and ZERO of
//      them come from a known health creator. The "BLANK niche is safe for health pages" premise behind
//      the 2026-08-08 fallback was simply wrong, and it put "10 Types of Women that every men want" and
//      "Ivy league grads when they realize their plumber is cleaning up" onto live health pages.
// So the fix is not a smarter filter over missing data — it is to stop the data from being missing.
// This script classifies untagged heads and writes the real Niche back, so every engine can go back to
// trusting the tag (and the BLANK fallback can stay narrow and creator-vouched).
//
// JEV (2026-09-23, plan Appendix A step 4). The Sonnet batch prompt is gone: the rows the rules do not
// settle go to Jev with the swipe reclassification's calibrated call-1 questions (swipe-classify.mjs
// NICHE_QUESTIONS, pinned `jev-1.13`), under the MERGED taxonomy — Health, Fitness and Mental Health are
// one niche, `Health` (operator 2026-09-23). Fitness and Mental Health are never emitted. Below the 0.85
// confidence floor (rule D's floor) the row stays blank for the next run or a person, an answer from
// any build but the calibrated one is not written, and a Health answer carries rule D's safety hold.
//
// --normalize is the nightly normalizer: a PURE RENAME of Fitness / Mental Health heads to Health, with
// no Jev call and no other move. It exists because n8n's intake keyword scorer (outside this repo) keeps
// emitting the retired labels until someone updates it. Run it only AFTER the one-time
// `scripts/swipe-reclassify.mjs --apply`: before it, a rename would pre-empt that plan's A′/A″ moves.
//
// SAFE BY CONSTRUCTION: tagging only ever writes rows whose Niche is currently BLANK (never overwrites a
// human or ingest tag), batches of 10, typecast:false (an unknown value fails instead of minting a new
// select option), and --dry prints the full plan without writing.
//
//   node tag-niche.mjs --dry              # preview (no writes)
//   node tag-niche.mjs                    # tag the default window (last 30d, >=250K)
//   node tag-niche.mjs --days 120 --min 500000
//   node tag-niche.mjs --limit 50         # cap the batch (cost control)
//   node tag-niche.mjs --normalize --days 3 [--dry]   # rename recent Fitness/Mental Health heads to Health
//   node tag-niche.mjs --table healthTweets --min 0 --days 0 --limit 1000
//                                         # the Health Tweets pool: no view floor (its ingest bar is
//                                         # views-OR-likes, so likes-only keepers sit under 250K) and
//                                         # --days 0 = all-time (backfill pass; cron does daily top-ups)
import { loadEnv, requireEnv, airtable, logRun } from './lib.mjs';
import { TABLES, SWIPE_NICHE_ALIASES } from './config.mjs';
import {
  MERGED_NICHES, NICHE_QUESTIONS, RETIRED_NICHES, SAFETY_QUESTIONS, SWIPE_RULES, breakerReason, heldFlags, intakeState, nicheState, readNiche,
} from './swipe-classify.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const NORMALIZE = args.includes('--normalize');
const DAYS = parseInt(flag('days', '30'), 10);
const MIN_VIEWS = parseInt(flag('min', '250000'), 10);
const LIMIT = parseInt(flag('limit', '100'), 10);
// Which table to heal. Every target shares the row shape this script needs: {Tweet Number}=1 heads
// with Text/Impressions/Published Date and a blank-Niche gap to fill.
const TABLE_KEY = flag('table', 'swipe');
const TABLE = TABLES[TABLE_KEY];
if (!TABLE) { console.error(`Unknown --table "${TABLE_KEY}" — valid: ${Object.keys(TABLES).join(', ')}`); process.exit(1); }

// The niches this script may write: the merged taxonomy call 1 answers from. 'Other' (2026-08-24,
// operator call) is the terminal answer for hooks that fit no listed niche — without it an unmappable
// hook is re-selected every run forever. Selection pools filter by named niches, so 'Other' rows are
// tagged-and-parked, not recycled. It is kept out of NICHES (the named niches) and allowed by VALID.
export const NICHES = MERGED_NICHES.filter((n) => n !== 'Other');
const VALID = new Set(MERGED_NICHES);
// Rule D's floor: below it Jev is not confident enough to tag, and the row stays blank.
export const TAG_NICHE_FLOOR = SWIPE_RULES.dConf;

// Deterministic pre-pass: the unambiguous cases never need a model call. Order is semantic — the first
// match wins, so the specific patterns sit above the general ones. Training and mental-health words map
// to Health (the merge). Everything else falls through to Jev. Pure + exported for tests.
const RULES = [
  ['Politics', /\b(president|senator|congress|election|democrat|republican|white house|parliament|prime minister|voters?|campaign trail)\b/i],
  ['AI', /\b(\bAI\b|artificial intelligence|LLM|GPT|Claude|Gemini|OpenAI|Anthropic|NVIDIA|neural net|model release)\b/],
  ['Health', /\b(workout|gym|squat|deadlift|bench press|reps|sets|cardio|lifting|hypertrophy|marathon|training program)\b/i], // was Fitness
  ['Health', /\b(anxiety|depression|burnout|panic attack|therapy|therapist|mental health|nervous system|trauma)\b/i], // was Mental Health
  ['Health', /\b(cortisol|testosterone|insulin|thyroid|magnesium|zinc|omega|collagen|creatine|berberine|ashwagandha|supplement|blood sugar|liver|gut health|microbiome|inflammation|cholesterol|blood pressure|sleep apnea|fatty liver|hormone)\b/i],
  ['Finance', /\b(stocks?|investing|portfolio|crypto|bitcoin|interest rates?|inflation rate|net worth|retirement fund)\b/i],
  ['Business', /\b(startup|founder|revenue|SaaS|acquisition|IPO|hiring|payroll|business model)\b/i],
];
export function ruleNiche(hook) {
  for (const [niche, re] of RULES) if (re.test(hook)) return niche;
  return null;
}

/** Pure: Jev's call-1 result -> { niche, reason }. A null niche leaves the row blank. */
export function decideNiche(result, { floor = TAG_NICHE_FLOOR, build = SWIPE_RULES.calibratedBuild } = {}) {
  if (!result) return { niche: null, reason: 'unread' };
  if (result.model !== build) return { niche: null, reason: `build ${result.model} is not ${build}` };
  const { primary, primaryConf } = readNiche(result.answers);
  if (!primary || !VALID.has(primary) || RETIRED_NICHES.includes(primary)) return { niche: null, reason: `invalid answer ${primary}` };
  if (!(primaryConf >= floor)) return { niche: null, reason: `confidence ${Number(primaryConf).toFixed(2)} < ${floor}` };
  return { niche: primary, reason: null };
}

/**
 * Jev for everything the rules did not settle, one call per head (20 s deadline). A Health answer gets
 * rule D's safety hold: a second call with the three safety nouls, and explicit / off_brand /
 * about_cancer at >= 0.70 (or an unread flag) leaves the row blank. A failed head is left blank for the
 * next run; only an auth or model error (breakerReason) stops the Jev half, degrading the run to
 * rules-only instead of aborting it.
 */
export async function classifyWithJev(client, items, { concurrency = 6, deadlineMs = 20_000 } = {}) {
  const classified = [];
  let down = null;
  let next = 0;
  const work = async () => {
    while (!down && next < items.length) {
      const it = items[next++];
      try {
        const { askThrough } = await import('./jev-decide.mjs');
        const result = await askThrough('niche-tag', client, { state: nicheState(it.fields), questions: NICHE_QUESTIONS }, { log: null, role: 'tag-niche' });
        let d = decideNiche(result);
        if (d.niche === 'Health') {
          let flags = null;
          try {
            const s = await askThrough('niche-safety', client, { state: intakeState(it.fields), questions: SAFETY_QUESTIONS }, { log: null, role: 'tag-niche' });
            flags = Object.fromEntries(Object.keys(SAFETY_QUESTIONS).map((k) => [k, s.answers?.[k]?.noul ?? null]));
          } catch (e) { if (breakerReason(e)) throw e; }
          const held = heldFlags(flags);
          if (held.length) d = { niche: null, reason: `safety hold: ${held.join(', ')}` };
        }
        classified.push({ ...it, niche: d.niche, by: d.niche ? 'jev' : 'skip', why: d.reason });
      } catch (e) {
        const code = String(e.code || e.message || 'error').slice(0, 120);
        if (breakerReason(e)) down = down || code;
        else classified.push({ ...it, niche: null, by: 'skip', why: `jev ${code}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, work));
  return { classified, down };
}

/** Pure: the normalizer's writes — a Fitness / Mental Health head becomes Health; nothing else moves. */
export function normalizePlan(records) {
  return records.filter((r) => SWIPE_NICHE_ALIASES[r.fields?.Niche])
    .map((r) => ({ id: r.id, from: r.fields.Niche, fields: { Niche: SWIPE_NICHE_ALIASES[r.fields.Niche] } }));
}

async function normalize(at) {
  const parts = ['{Tweet Number}=1', `OR(${Object.keys(SWIPE_NICHE_ALIASES).map((n) => `{Niche}="${n}"`).join(',')})`];
  if (DAYS > 0) parts.push(`IS_AFTER({Created time},DATEADD(NOW(),-${DAYS},"days"))`);
  const recs = await at.listAll(TABLE, { formula: `AND(${parts.join(',')})`, fields: ['Niche'] });
  const plan = normalizePlan(recs);
  for (const p of plan) console.log(`↻ ${p.from.padEnd(13)} → Health  ${p.id}`);
  console.log(`\nNormalize: ${plan.length} head(s) carry a retired label (${TABLE_KEY}, ${DAYS > 0 ? `created in the last ${DAYS}d` : 'all-time'}).`);
  if (DRY) { console.log('(dry run — nothing written)'); return; }
  if (plan.length) await at.update(TABLE, plan.map(({ id, fields }) => ({ id, fields })), { typecast: false });
  console.log(`Renamed ${plan.length} head(s) to Health.`);
  await logRun('tag-niche', { mode: 'normalize', table: TABLE_KEY, renamed: plan.length, days: DAYS });
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
  // healthTweets lives in its OWN base (2026-08-31, attachment-storage headroom); everything else
  // sits in the default XDB base. The base id is public (like the tbl ids), so the env var is an
  // override, not a requirement.
  const TABLE_BASE = TABLE_KEY === 'healthTweets' ? (env.HEALTH_XDB_BASE_ID) : undefined;
  const at = airtable(env, TABLE_BASE);
  if (NORMALIZE) return normalize(at);
  // --days 0 = all-time: the IS_AFTER clause only joins the formula for a positive window.
  const parts = [`{Tweet Number}=1`, `{Niche}=BLANK()`, `{Impressions}>=${MIN_VIEWS}`];
  if (DAYS > 0) parts.push(`IS_AFTER({Published Date},DATEADD(NOW(),-${DAYS},"days"))`);
  const formula = `AND(${parts.join(',')})`;
  const WINDOW = DAYS > 0 ? `last ${DAYS}d` : 'all-time';
  // Full Thread Text is the swipe table's rollup; the Health Tweets pool is singles and has none.
  const fields = ['Text', 'Impressions', 'Tweet URL', ...(TABLE_KEY === 'swipe' ? ['Full Thread Text'] : [])];
  const recs = await at.list(TABLE, { formula, sort: [{ field: 'Impressions', direction: 'desc' }], fields, pageSize: 100, max: LIMIT });
  const items = recs.slice(0, LIMIT).map((r) => ({ id: r.id, fields: r.fields, hook: (r.fields.Text || '').split('\n')[0], views: r.fields.Impressions || 0, url: r.fields['Tweet URL'] }));
  if (!items.length) { console.log(`No untagged heads in the window (${TABLE_KEY}, ${WINDOW}, >=${MIN_VIEWS.toLocaleString()} views). Nothing to do.`); return; }
  console.log(`Untagged heads to classify: ${items.length} (${TABLE_KEY}, ${WINDOW}, >=${MIN_VIEWS.toLocaleString()} views)\n`);

  // Rules first (free + deterministic), Jev only for the remainder.
  const decided = [], undecided = [];
  for (const it of items) { const n = ruleNiche(it.hook); n ? decided.push({ ...it, niche: n, by: 'rule' }) : undecided.push(it); }
  const classified = [...decided];
  let jevDown = null;
  if (undecided.length) {
    try {
      const { jev } = await import('./jev.mjs');
      const client = jev({ ...env, TYPESAFE_DEFAULT_MODEL: SWIPE_RULES.model });
      const r = await classifyWithJev(client, undecided);
      classified.push(...r.classified);
      jevDown = r.down;
    } catch (e) { jevDown = String(e.message || e).slice(0, 120); }
  }
  for (const it of undecided) if (!classified.some((c) => c.id === it.id)) classified.push({ ...it, niche: null, by: 'skip', why: 'not read' });
  if (jevDown) console.warn(`⚠️ Jev unavailable (${jevDown}) — rules-only for the rest; unread hooks are left for the next run.\n`);

  const writable = classified.filter((c) => c.niche);
  for (const c of classified.sort((a, b) => b.views - a.views)) {
    console.log(`${c.niche ? '✓' : '✗'} ${(c.niche || 'BLANK').padEnd(17)} ${(c.by || '-').padEnd(4)} ${(c.views / 1e6).toFixed(1)}M  ${JSON.stringify(c.hook.slice(0, 60))}${c.why ? `  (${c.why})` : ''}`);
  }
  const spread = writable.reduce((m, c) => ({ ...m, [c.niche]: (m[c.niche] || 0) + 1 }), {});
  console.log(`\nClassified ${writable.length}/${items.length} · ${Object.entries(spread).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(' · ')}`);
  if (DRY) { console.log('(dry run — nothing written)'); await logRun('tag-niche', { mode: 'dry', table: TABLE_KEY, scanned: items.length, classified: writable.length, wrote: 0 }); return; }

  // Batching + 429 retry live in lib's client. typecast:false: a value outside the live options fails
  // loudly instead of minting a new select option.
  await at.update(TABLE, writable.map((c) => ({ id: c.id, fields: { Niche: c.niche } })), { typecast: false });
  console.log(`Tagged ${writable.length} thread head(s).`);
  await logRun('tag-niche', { table: TABLE_KEY, scanned: items.length, classified: writable.length, wrote: writable.length, days: DAYS, minViews: MIN_VIEWS });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
