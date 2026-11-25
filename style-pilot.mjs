// style-pilot.mjs — the Willie style pilot: which build each page writes on each day of the pilot week,
// and a sheet of what actually shipped under each build.
//
// Owner, R2026-09-26 (the Willie study): "We should dedicate 3 low performing accounts to pilot his exact
// style of content — reposting and then also if doing cover then we would rewrite in his style. Learn
// from how he does the product as one point." On the point build: "pilot page + 50% of fleet". On the
// length: "1 week, about 20 threads". docs/willie-build.md holds the writing rules for both builds.
//
// A cover carries its build on the spec as `styleArm`, and it rides from there to the draft title
// ([Cover] [wil] …), the queue record and the ledger row, so the readout joins on what shipped:
//   wil  the full Willie build: the three pilot pages, every thread, all covers
//   pb   the point build only: the other pages on alternate days
//   —    control: today's format (no styleArm)
// The pb/control split alternates by DAY within each page, and the two halves of the fleet start on
// opposite days, so every page is its own control and about half the fleet writes pb on any one day.
// The halves are frozen lists rather than derived from the roster, so a page onboarded mid-week cannot
// reshuffle anyone's arm; a page on neither list is control.
//
//   node style-pilot.mjs --day 2026-09-28     # the build each page writes that day
//   node style-pilot.mjs --sheet [--json]     # what shipped in the window, by build, from the records
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliArg, runMain, HERE_DIR } from './lib.mjs';

export const STYLE_ARMS = Object.freeze(['wil', 'pb']);

export const STYLE_PILOT = Object.freeze({
  id: 'willie-2026-09',
  doc: 'docs/willie-build.md',
  // The first week the next run fills: R2026-09-26 scheduled Sat 26 and Sun 27.
  start: '2026-09-28',
  end: '2026-10-04',
  wil: Object.freeze(['rasmus', 'muah', 'dzejla']),
  // Every other monetized page, alphabetical and alternating, split into the half that writes pb on
  // even pilot days (day 0 is the start) and the half that writes it on odd days.
  pbEven: Object.freeze(['camila', 'eleanor', 'irana', 'johnathan', 'kim', 'lorenzo', 'lucinda', 'marcos', 'natella', 'rafael', 'sophia', 'violet']),
  pbOdd: Object.freeze(['clara', 'felicia', 'jasper', 'julian', 'live', 'lucas', 'magnus', 'marko', 'peak', 'rosemary', 'tina']),
  // His network (the study's cohort), so the sheet can tell a rebuilt winner of his from a cover of
  // another donor: the owner asked for half of each on the pilot pages.
  williePages: Object.freeze(['Dr_Biohacker', 'CoachDanCole_', 'TheFastedState', 'BeBetterMan_', 'CoachWillStone', '_Gut_Laboratory',
    'DPro_Coach', 'BeBetter_Athlet', 'Fitby_Chandler', 'NutritionCorp', 'EnergyUp_', 'LevelUpPrime', 'Solo_LevelUp_', '_ChrisPalmer_',
    'HumanUpgrade_', 'PeakLab_', 'Human_Optimise', 'Austin_Hart00']),
});

const DAY_MS = 864e5;
const dayMs = (day) => Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`);

/** PURE. The pilot day index (0 = start), or null outside the window or for a non-date. */
export function pilotDay(day, pilot = STYLE_PILOT) {
  const t = dayMs(day);
  if (!Number.isFinite(t) || t < dayMs(pilot.start) || t > dayMs(pilot.end)) return null;
  return Math.round((t - dayMs(pilot.start)) / DAY_MS);
}

/** PURE. The build a page's COVER is written in on a day: 'wil', 'pb', or null (control, or no pilot
 *  that day). Harvests and pots ship a body verbatim, so they never take a build. */
export function styleArmFor(key, day, pilot = STYLE_PILOT) {
  const i = pilotDay(day, pilot);
  if (i == null) return null;
  if (pilot.wil.includes(key)) return 'wil';
  if (pilot.pbEven.includes(key)) return i % 2 === 0 ? 'pb' : null;
  if (pilot.pbOdd.includes(key)) return i % 2 === 1 ? 'pb' : null;
  return null;
}

/** PURE. A spec's styleArm, checked: only a known build, only on a cover, and the full build is the
 *  one-ask arm. Returns the problems; an empty list is a pass. */
export function styleArmIssues(spec = {}) {
  const arm = spec.styleArm;
  if (arm == null || arm === '') return [];
  const out = [];
  if (!STYLE_ARMS.includes(arm)) out.push(`styleArm "${arm}" is not a build (${STYLE_ARMS.join(' | ')}; control carries none)`);
  if (spec.potOf || spec.harvestOf) out.push('styleArm is for covers: a pot or harvest ships its body verbatim, so no build applies');
  if (arm === 'wil' && spec.arm !== 'single-cta') out.push('the full Willie build sells one product: it needs arm "single-cta"');
  return out;
}

/** PURE. The X handle a donor URL belongs to, or null. */
export const donorHandle = (url) => (String(url || '').match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i) || [])[1] || null;

/** PURE. One sheet row per cover record scheduled inside the window: what shipped against what the
 *  plan assigned. `records` are queue records (queues/threads/*.json, parsed). */
export function pilotSheet(records = [], pilot = STYLE_PILOT) {
  const rows = [];
  for (const r of records) {
    const spec = r?.spec || {};
    const day = spec.day || String(r?.thread?.createdAt || '').slice(0, 10);
    if (pilotDay(day, pilot) == null || spec.potOf || spec.harvestOf) continue;
    const key = spec.key || null;
    const assigned = styleArmFor(key, day, pilot) || 'control';
    const shipped = spec.styleArm || 'control';
    const handle = donorHandle(spec.sourceUrl || r?.source?.url);
    rows.push({
      day, page: key, draftId: r?.thread?.draftId || null, build: shipped, assigned,
      ...(shipped !== assigned ? { mismatch: `assigned ${assigned}, shipped ${shipped}` } : {}),
      source: handle && pilot.williePages.some((h) => h.toLowerCase() === handle.toLowerCase()) ? 'his winner' : 'other donor',
      donor: handle, product: spec.heavyTitle || spec.products?.[0]?.title || null, asin: spec.heavy || spec.products?.[0]?.asin || null,
    });
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day) || String(a.page).localeCompare(String(b.page)));
}

function readRecords(dir = join(HERE_DIR, 'queues', 'threads')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

async function main() {
  const day = cliArg('day');
  if (day) {
    if (pilotDay(day) == null) { console.log(`${day} is outside the pilot (${STYLE_PILOT.start} to ${STYLE_PILOT.end}): every page writes today's format.`); return; }
    const pages = [...STYLE_PILOT.wil, ...STYLE_PILOT.pbEven, ...STYLE_PILOT.pbOdd];
    const by = (arm) => pages.filter((k) => (styleArmFor(k, day) || 'control') === arm);
    console.log(`${STYLE_PILOT.id} · ${day} (day ${pilotDay(day) + 1} of 7) · rules: ${STYLE_PILOT.doc}`);
    console.log(`  wil      ${by('wil').join(', ')}  (full build, covers only)`);
    console.log(`  pb       ${by('pb').join(', ')}  (point build on covers)`);
    console.log(`  control  ${by('control').join(', ')}`);
    return;
  }
  if (process.argv.includes('--sheet')) {
    const rows = pilotSheet(readRecords());
    if (process.argv.includes('--json')) { console.log(JSON.stringify({ pilot: STYLE_PILOT.id, rows }, null, 1)); return; }
    for (const r of rows) console.log(`${r.day}  ${String(r.page).padEnd(9)} ${r.build.padEnd(7)} ${String(r.draftId).padEnd(9)} ${r.source.padEnd(11)} ${String(r.donor || '-').padEnd(16)} ${r.product || '-'}${r.mismatch ? `  ⚠ ${r.mismatch}` : ''}`);
    const n = (b) => rows.filter((r) => r.build === b).length;
    console.log(`\n${rows.length} cover(s) in the window · wil ${n('wil')} · pb ${n('pb')} · control ${n('control')} · ${rows.filter((r) => r.mismatch).length} off-plan`);
    return;
  }
  console.log('usage: node style-pilot.mjs --day YYYY-MM-DD | --sheet [--json]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'style-pilot');
