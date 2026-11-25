#!/usr/bin/env node
// The questions that open an attended /run, their safe defaults, and exactly what each answer does.
//
// Owner, 2026-09-22: "the starting configuration of any /run [should] be super simple where you
// would ask me a series of questions ... and set a safe default option in case I don't have
// preferences for that particular run." And: give room for OG threads, prioritise novelty (not too
// many of the same donor), and let the plan say how the experiment will run.
//
// This file is the ONE place those questions live. It reads every default from the file that owns
// it — laws.json, accounts.mjs, queues/product-queue.json — and turns an answer into the flags the
// canonical picker, the brief and the schedule check already accept. It chooses nothing itself and
// adds no scoring: an answer only moves a dial that already exists.
//
//   node scripts/run-intake.mjs --defaults                     # the questions with live defaults
//   node scripts/run-intake.mjs --answers A.json --out R.json  # resolve answers (write outside Git)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS } from '../accounts.mjs';
import { isBooster } from '../boosters.mjs';
import { LAWS } from '../laws.mjs';
import { readProductQueue } from '../product-queue.mjs';
import { readDonorPins } from '../donor-pins.mjs';
import { contentQuestions, resolveContentRules } from './run-rules.mjs';

// Version 2 (2026-09-23) adds the content rules (scripts/run-rules.mjs): what a thread may carry,
// decided once here and checked at every stop.
export const INTAKE_VERSION = 2;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (message) => { throw new Error(message); };

// Cover age mix. The picker's three old-age shares are NESTED: the >30d target counts evergreen and OG
// picks, and the >90d target counts OG picks (pick-donors.mjs, "the vault target counts BOTH old arms").
// So a share may never exceed the wider one it sits inside, or the targets contradict each other.
// `fresh` is the share guaranteed to donors from the last 30 days; left out, it is 1 - archive, so the
// two floors bind every slot (owner 2026-09-28: "I think 60% — then within the OG we would divide into
// 30 - 90 days (15%), 90 - 365 days (15%) and 365 days+ (10%) this would be the default").
export const AGE_PRESETS = {
  default: { label: 'Standard', note: 'The laws.json mix: 60% from the last 30 days, 15% at 31–90 days, 15% at 91–365 days, 10% over a year' },
  'more-og': { label: 'More OG', og: 0.20, evergreen: 0.35, archive: 0.50, note: 'Twice the OG room: 50% recent, 15% at 31–90 days, 15% at 91–365 days, 20% over a year' },
  'no-og': { label: 'No OG', og: 0, evergreen: 0.15, archive: 0.30, note: 'Skip threads over a year old: 70% recent, 15% at 31–90 days, 15% at 91–365 days' },
  fresh: { label: 'Fresh only', og: 0, evergreen: 0, archive: 0, note: 'Donors from the last 30 days only' },
};

// Donor novelty. Three picker knobs decide reuse (donor-burn.mjs `isBurned`): maxUses is how many
// times we may already have PUBLISHED a donor, burnWindow how many recent runs it must sit out, and
// burnDays how long since it last posted; 0 turns a knob off. sourceHandleCap limits distinct posts
// per creator per picked day; the owner's standing rule is no creator cap unless a run asks for one.
// Owner, 2026-09-28: "remove the burn screen rule — so that's why I don't see many of the recent viral
// posts". No preset makes a donor sit out runs or days after we cover it; Standard (the default) has no
// reuse limit at all, and Balanced and Strict keep only the publish counts their labels name.
export const NOVELTY_PRESETS = {
  default: { label: 'Standard', maxUses: 0, burnWindow: 0, burnDays: 0, sourceHandleCap: 0, perDayCreatorCap: 0,
    note: 'No burn screen: a donor we covered before can be picked again, however recently; no creator cap' },
  balanced: { label: 'Balanced', maxUses: 2, burnWindow: 0, burnDays: 0, sourceHandleCap: 2, perDayCreatorCap: 2,
    note: 'At most one earlier publish; no more than 2 posts from one creator a day' },
  strict: { label: 'Strict', maxUses: 1, burnWindow: 0, burnDays: 0, sourceHandleCap: 1, perDayCreatorCap: 1,
    note: 'Only donors we have never published; one post per creator a day' },
};

/** Rules that hold on every run. They are stated in the intake so nobody has to ask, and they are
 *  deliberately NOT questions: each is a gate somewhere else and an answer must not weaken it. */
export function standingRules(laws = LAWS) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  return [
    { id: 'hook-fidelity', rule: `A cover's hook stays at ${pct(laws.hook.coverFloor)} or more of the donor's hook; between ${pct(laws.hook.gateMin)} and ${pct(laws.hook.coverFloor)} only with a declared drift class; above ${pct(laws.hook.gateMax)} it is refused as a duplicate.`,
      enforcedBy: 'publish-thread.mjs and hooks-check.mjs (laws.json hook.*); the drafts packet holds a failing row (the hooks packet in a six-stop run)' },
    { id: 'view-floor', rule: `Donors need ${(laws.selection.viewFloor / 1000).toFixed(0)}k+ source impressions.`,
      enforcedBy: 'preflight.mjs screenDonor (laws.json selection.viewFloor)' },
    { id: 'same-day-donor', rule: 'No donor posts twice on the same day across the fleet, and no two near-identical source bodies share a day.',
      enforcedBy: 'scripts/run-schedule-preflight.mjs at the calendar stop' },
    { id: 'review-drafts', rule: 'From stop 4 on, every thread lives in one unscheduled draft in its own page’s set, delivered batch by batch as it is written and published from that same draft; nothing posts before the calendar stop.',
      enforcedBy: 'scripts/run-review-drafts.mjs (never sends a publish time)' },
  ];
}

function normalizeMix(weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) fail('A lane mix needs a positive total');
  const raw = weights.map((w) => (w / total) * 100);
  const mix = raw.map(Math.round);
  const drift = 100 - mix.reduce((sum, v) => sum + v, 0);
  if (drift) mix[raw.indexOf(Math.max(...raw))] += drift;
  return mix;
}

/** The last phase in laws.json is the owner's most recent split decision; it is the default, not a
 *  rule, and only the owner moves it. */
export function currentPhase(laws = LAWS) {
  const phases = laws.farm?.phases || [];
  if (!phases.length) return null;
  const index = phases.length - 1;
  return { phase: index + 1, weights: phases[index].mix, mix: normalizeMix(phases[index].mix) };
}

/** Eligible X money pages: the same filter the brief uses. A booster page (boosters.mjs) posts singles and QRTs, never a
 *  run's threads (owner, 2026-10-06: "move Rose Mary, Live, Violet, Džejla and Rasumus — let's keep Lorenzo in content lane"). */
export function eligibleAccounts(accounts = ACCOUNTS) {
  return Object.entries(accounts)
    .filter(([key, a]) => a.socialSetId && !a.external && !a.burner && !a.client && !a.paused && !isBooster(key))
    .map(([key]) => key);
}

function laterDates(today, count, weekdays) {
  const out = [];
  const cursor = new Date(`${today}T12:00:00+07:00`);
  while (out.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short' }).format(cursor);
    if (!weekdays || weekdays.includes(day)) out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}

/** Monday runs cover Mon–Thu and Thursday runs Fri–Sun (the /run cadence); a Sunday run, the
 *  scheduled one fired the afternoon before (laws.json run.scheduled), covers the Mon–Thu ahead; any
 *  other day proposes the next three. A proposal only: the owner confirms the dates. */
export function proposedDates(today = new Date().toISOString().slice(0, 10)) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short' }).format(new Date(`${today}T12:00:00+07:00`));
  if (day === 'Mon') return [today, ...laterDates(today, 3)];
  if (day === 'Sun') return laterDates(today, 4);
  if (day === 'Thu') return laterDates(today, 3);
  return laterDates(today, 3);
}

/** The questions, in the order they are asked, each carrying its live default and where it came from. */
/** The earliest a slot may post on the run's first day: now + 4 hours (R1 default, owner 2026-09-23). */
export const TODAY_NOT_BEFORE_HOURS = 4;
export const defaultTodayNotBefore = (now = new Date()) => new Date(Math.ceil((new Date(now).getTime() + TODAY_NOT_BEFORE_HOURS * 3_600_000) / 60_000) * 60_000).toISOString();

export function intakeQuestions({ laws = LAWS, accounts = ACCOUNTS, queue = readProductQueue(), today, now = new Date() } = {}) {
  const phase = currentPhase(laws);
  const pages = eligibleAccounts(accounts);
  const tests = laws.product?.testProductsPerRun ?? 0;
  const head = (queue.queue || []).slice(0, tests).map((entry) => entry.asin);
  const sel = laws.selection;
  const pct = (value) => `${Math.round(value * 100)}%`;
  return [
    { id: 'dates', ask: 'Which days does this run cover?', default: proposedDates(today),
      source: 'today against the Mon/Thu cadence' },
    { id: 'accounts', ask: 'Which accounts?', default: { include: 'all', exclude: [] }, count: pages.length,
      source: 'accounts.mjs, minus paused, burner, client and external pages and the booster pages (boosters.mjs)' },
    { id: 'split', ask: 'Cover / harvest / seed split?', default: phase?.mix ?? null,
      source: phase ? `laws.json farm.phases, phase ${phase.phase}` : 'no phase defined' },
    { id: 'experiment', ask: 'Run an experiment this time?',
      default: { seedDials: [], productTests: tests },
      source: `laws.json product.testProductsPerRun rides ${tests} queued product(s) every run; no seed-dial test unless asked`,
      options: ['none beyond the standing product tests', 'seed-dial test (name seed + dial + pots)', 'product tests off'] },
    { id: 'productPriority', ask: 'Which products first?', default: head,
      source: 'head of queues/product-queue.json' },
    { id: 'ogRoom', ask: 'How much room for older and OG threads?', default: 'default',
      source: `laws.json selection: ${pct(freshShareOf(sel))} from the last 30 days; ${pct(sel.archiveShare)} over 30 days, ${pct(sel.evergreenShare)} over 90, ${pct(sel.ogShare)} over a year (nested)`,
      options: Object.entries(AGE_PRESETS).map(([id, p]) => ({ id, label: p.label, note: p.note })) },
    { id: 'novelty', ask: 'How strict on reusing donors and creators?', default: 'default',
      source: 'pick-donors.mjs burn defaults; no creator cap is the standing rule',
      options: Object.entries(NOVELTY_PRESETS).map(([id, p]) => ({ id, label: p.label, note: p.note })) },
    // R1 (owner 2026-09-23): the posting calendar is approved at the brief, so its two inputs are asked here.
    { id: 'todayNotBefore', ask: 'Earliest post time on the first day?', default: defaultTodayNotBefore(now),
      source: `now + ${TODAY_NOT_BEFORE_HOURS} h; slots before it are re-spread after it (scripts/run-calendar.mjs)` },
    { id: 'restDays', ask: 'Any rest days (a date, optionally only some pages)?', default: [],
      source: 'none; each entry is { date, accounts? } and leaves those page-days empty' },
    { id: 'other', ask: 'Anything else to respect?', default: '',
      source: 'exclusions, singles, Threads, a topic to avoid' },
    ...contentQuestions(laws).map((q) => ({ ...q, group: 'content' })),
  ];
}

/** The recent (last 30 days) share laws.json guarantees: freshShare, or whatever the old floors leave. */
const freshShareOf = (sel) => (Number.isFinite(sel.freshShare) ? sel.freshShare : +(1 - (sel.archiveShare ?? 0)).toFixed(4));

function ageShares(answer, laws) {
  const sel = laws.selection;
  const shares = (() => {
    if (answer == null || answer === 'default') {
      return { preset: 'default', fresh: freshShareOf(sel), og: sel.ogShare, evergreen: sel.evergreenShare, archive: sel.archiveShare };
    }
    const preset = typeof answer === 'string' ? AGE_PRESETS[answer] : null;
    if (typeof answer === 'string' && !preset) fail(`Unknown OG-room preset: ${answer}`);
    const picked = preset ? { preset: answer, ...preset } : { preset: 'custom', ...answer };
    const archive = Number(picked.archive);
    return { preset: picked.preset, og: Number(picked.og), evergreen: Number(picked.evergreen), archive,
      fresh: picked.fresh == null ? +(1 - archive).toFixed(4) : Number(picked.fresh) };
  })();
  const inRange = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  if (![shares.fresh, shares.og, shares.evergreen, shares.archive].every(inRange)) fail('Age shares must be numbers from 0 to 1');
  if (!(shares.og <= shares.evergreen && shares.evergreen <= shares.archive)) {
    fail('Age shares are nested: OG must not exceed over-90-days, which must not exceed over-30-days');
  }
  if (shares.fresh + shares.archive > 1 + 1e-9) fail('The recent share and the over-30-days share cannot add up to more than 100%');
  return shares;
}

function noveltyKnobs(answer) {
  if (answer == null) answer = 'default';
  const preset = typeof answer === 'string' ? NOVELTY_PRESETS[answer] : null;
  if (typeof answer === 'string' && !preset) fail(`Unknown novelty preset: ${answer}`);
  const knobs = preset ? { preset: answer, ...preset } : { preset: 'custom', ...NOVELTY_PRESETS.default, ...answer };
  for (const key of ['maxUses', 'burnWindow', 'burnDays', 'sourceHandleCap', 'perDayCreatorCap']) {
    if (!Number.isInteger(knobs[key]) || knobs[key] < 0) fail(`${key} must be a whole number of 0 or more`);
  }
  delete knobs.label; delete knobs.note;
  return knobs;
}

function seedDialPlan(entries) {
  if (!Array.isArray(entries)) fail('seedDials must be a list');
  return entries.map((entry, index) => {
    const seed = String(entry?.seed || '').trim();
    const dial = String(entry?.dial || '').trim();
    const pots = Number(entry?.pots);
    if (!seed || !dial) fail(`seedDials[${index}] needs a seed and a dial`);
    if (!Number.isInteger(pots) || pots < 1) fail(`seedDials[${index}] needs a whole number of pots`);
    // docs/seed-dials: two pots make a cell readable; topic is the biggest move and takes four.
    const readableAt = dial === 'topic' ? 4 : 2;
    return { seed, dial, pots, readableAt, readable: pots >= readableAt,
      readRule: `read against the ${seed} control (C1); ${readableAt} pots make the cell readable; each pot's verdict lands 48h after it posts` };
  });
}

/** Answers -> the run's configuration. Anything unanswered takes its default, and the result says
 *  which, so the brief can show which choices were the owner's and which were the safe default. */
function restDayPlan(entries, dates, accounts) {
  if (!Array.isArray(entries)) fail('restDays must be a list of { date, accounts? }');
  return entries.map((entry, index) => {
    const date = String(entry?.date || '');
    if (!DATE.test(date)) fail(`restDays[${index}] needs a YYYY-MM-DD date`);
    if (!dates.includes(date)) fail(`restDays[${index}] ${date} is not one of this run's dates`);
    if (entry.accounts != null && (!Array.isArray(entry.accounts) || entry.accounts.some((key) => !Object.hasOwn(accounts, key)))) fail(`restDays[${index}] names an unknown account`);
    return entry.accounts?.length ? { date, accounts: [...new Set(entry.accounts)].sort() } : { date };
  });
}

export function resolveIntake(answers = {}, { laws = LAWS, accounts = ACCOUNTS, queue = readProductQueue(), pins = readDonorPins(), today, now = new Date() } = {}) {
  const questions = intakeQuestions({ laws, accounts, queue, today, now });
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const defaultsUsed = [];
  const pick = (id) => {
    const value = answers[id];
    if (value === undefined || value === null || value === 'default') { defaultsUsed.push(id); return byId[id].default; }
    return value;
  };

  const dates = pick('dates');
  if (!Array.isArray(dates) || !dates.length || dates.some((d) => !DATE.test(String(d)))) fail('dates must be YYYY-MM-DD strings');
  if (new Set(dates).size !== dates.length) fail('Run dates must be unique');

  const pages = eligibleAccounts(accounts);
  const scope = pick('accounts');
  const exclude = [...new Set(scope?.exclude || [])];
  const include = scope?.include === 'all' || scope?.include == null ? pages : [...new Set(scope.include)];
  const unknown = [...include, ...exclude].filter((key) => !Object.hasOwn(accounts, key));
  if (unknown.length) fail(`Unknown account key(s): ${unknown.join(', ')}`);
  const accountKeys = include.filter((key) => !exclude.includes(key));

  const split = pick('split');
  if (!Array.isArray(split) || split.length !== 3 || split.some((v) => !Number.isInteger(v) || v < 0)) fail('split must be three whole numbers: cover, harvest, seed');
  const mix = normalizeMix(split);

  const experimentAnswer = pick('experiment');
  const productTests = experimentAnswer?.productTests ?? laws.product?.testProductsPerRun ?? 0;
  if (!Number.isInteger(productTests) || productTests < 0) fail('productTests must be a whole number of 0 or more');
  const seedDials = seedDialPlan(experimentAnswer?.seedDials || []);
  if (seedDials.length && mix[2] === 0) fail('A seed-dial test needs a seed share above 0');

  const priority = pick('productPriority');
  if (!Array.isArray(priority) || priority.some((asin) => !/^[A-Z0-9]{10}$/.test(String(asin)))) fail('productPriority must be a list of ASINs');

  const age = ageShares(pick('ogRoom'), laws);
  const novelty = noveltyKnobs(pick('novelty'));
  const pickerArgs = [
    '--og-share', String(age.og), '--evergreen-share', String(age.evergreen), '--archive-share', String(age.archive),
    '--max-uses', String(novelty.maxUses), '--burn-window', String(novelty.burnWindow), '--burn-days', String(novelty.burnDays),
    '--source-handle-cap', String(novelty.sourceHandleCap), '--fresh-share', String(age.fresh),
  ];
  const todayNotBefore = pick('todayNotBefore');
  if (typeof todayNotBefore !== 'string' || !Number.isFinite(Date.parse(todayNotBefore)) || !/T\d\d:\d\d/.test(todayNotBefore)) fail('todayNotBefore must be an ISO date-time');
  const restDays = restDayPlan(pick('restDays'), dates, accounts);
  const other = String(pick('other') || '').trim();
  const contentIds = contentQuestions(laws).map((q) => q.id);
  const content = resolveContentRules(Object.fromEntries(contentIds.map((id) => [id, answers[id]])), laws);
  defaultsUsed.push(...content.defaultsUsed);

  return {
    schema: 'run-intake-v1', version: INTAKE_VERSION, dates: [...dates].sort(),
    accounts: { keys: accountKeys, excluded: exclude, count: accountKeys.length },
    mix,
    // Donors the owner pinned to several pages (queues/donor-pins.json) whose window meets these dates.
    coverSelection: { age, novelty, pickerArgs,
      pins: pins.filter((p) => dates.some((d) => p.from <= d && d <= p.to))
        .map(({ recId, url, pages, from, to, why }) => ({ recId, url: url || null, pages, from, to, why })),
      pickerCommand: 'node scripts/pick-donors.mjs <date> --need <n> '
        + `${pickerArgs.join(' ')} --snapshot-out /outside/repo/<date>.json [--prior-snapshot /outside/repo/<earlier>.json]...` },
    experiment: { productTests, productPriority: priority, seedDials,
      productTestRule: 'each tested product rides the light plug on covers, never inside a pot; judged at the 100-click bar (product-test.mjs)' },
    schedule: { sameDayDonorDedup: true, perDayCreatorCap: novelty.perDayCreatorCap,
      todayNotBefore: new Date(todayNotBefore).toISOString(), restDays },
    content, other, rules: standingRules(laws), defaultsUsed,
  };
}

function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  if (argv.includes('--defaults')) return { questions: intakeQuestions(), rules: standingRules() };
  const answersPath = flag('answers');
  if (!answersPath) fail('Usage: run-intake.mjs --defaults | --answers ANSWERS.json [--out RESOLVED.json]');
  const resolved = resolveIntake(JSON.parse(readFileSync(resolve(answersPath), 'utf8')));
  const out = flag('out');
  if (out) writeFileSync(resolve(out), `${JSON.stringify(resolved, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return resolved;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
