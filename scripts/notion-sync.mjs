#!/usr/bin/env node
// scripts/notion-sync.mjs — the operator's Notion tracker, written from the run directory (one way).
//
// Owner, 2026-09-24: "This is simply the UI for me the operator to keep track of progress. Other
// information for the machine already have its place to stand and read from." Modelled on the owner's
// Sprint setup: one unified master database of threads (Threads · Master) across every run and page,
// a Runs row per /run, an Accounts row per fleet account. Notion is never a source of truth: Airtable, Typefully
// and RUN_DIR are. The only thing read back is the owner's own verdict ("Your call" + "Your note"),
// and only when the owner says "check Notion".
//
// What each thread row carries (owner, 2026-09-24):
//   - Donor hook and Our hook as properties, side by side, with the hook match and when it was read
//   - the thread's source note (thread-note.mjs, the same one the Typefully draft carries) in the body
//   - Your call / Your note: Approve, Revise or Hold, bound to the copy the owner saw (Copy sha) at the
//     stop it was shown at (Call stop). When the copy or the stop changes, the old call is cleared,
//     never carried onto the new copy.
//   - at the schedule stop, --refresh-hooks re-reads tweet 1 from Typefully: that live text is the
//     approved hook and replaces Our hook, so an edit made in Typefully is never shown stale.
//
// Unpublished copy never enters the repository: every file this reads or writes lives in RUN_DIR.
//
//   node scripts/notion-sync.mjs push  --run-dir DIR --run-id R2026-09-25 --input spec.json [--refresh-hooks] [--dry]
//   node scripts/notion-sync.mjs calls --run-dir DIR --run-id R2026-09-25 --input spec.json [--from rows.json]
//   node scripts/notion-sync.mjs pool [--dry] [--out FILE]      (after pool prep: the Pool copy)
//   node scripts/notion-sync.mjs theme --run-dir DIR [--set THEME]   (the run's cover theme, approved at the brief)
//   node scripts/notion-sync.mjs covers [--restyle] [--run-dir DIR --run-id ID]
//                                  (any page without a cover gets its own; with a run, that run's pages take
//                                   its theme; --restyle also redoes covers outside the theme they belong to)
//
// push  needs a Notion token: NOTION_TOKEN, or NOTION_API_TOKEN as the cloud environment names it (an
//       internal integration shared with the tracker page; see notionToken). Without one, or with
//       --dry, it writes RUN_DIR/notion/payload.json and prints the rows, so the in-session agent can
//       push them through the Notion connector instead. Either way the Threads schema gains what the
//       rows write first: the push adds missing properties and select options itself, and the payload
//       lists them under `schema` for the connector to add before the pages.
// calls reads the owner's calls for this run and prints one run-studio command per call. It records
//       nothing: the agent runs the commands (the owner's words go in verbatim), then pushes again.
//       --from FILE takes the rows as read through the connector: [{ key, copySha, callStop, call, note }].
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestWithPolicy, jsonWithSchema } from '../api-reliability.mjs';
import { copyDigest, renderNote } from '../thread-note.mjs';
import { checkHook } from '../hooks-check.mjs';

// The tracker built 2026-09-24 (private draft page "Project Infinity · Run Tracker").
export const NOTION_DBS = Object.freeze({
  threads: 'c89babd998204ed793f0bf2873784ee0',
  runs: '3fbb733381274261995606b67148c838',
  accounts: 'bf7ae5557bc94fdc91f7456ded137294',
});
export const NOTION_VERSION = '2022-06-28';
export const POOL_DB = '65b176c2b1fc46fb95444c64f4b101d1';
const HARVESTS_TABLE = 'tblOtEftJl2p43o6M';   // greenhouse-draft.mjs TABLES.Harvests
const POTS_TABLE = 'tblJg81qkmj1t3eRi';       // greenhouse-draft.mjs TABLES.Pots
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const TEXT_MAX = 2000;            // Notion's cap per rich-text item
const BODY_ITEMS = 100;           // and per block's rich-text array
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

// Owner, 2026-09-24: "add Notion cover automatically for the pages", then "for a new run you would
// suggest to me a style or theme and all covers would relate to it". Themes are Notion's own gallery
// covers (public, each checked to load). A run's theme is proposed at the brief and saved with
// `notion-sync.mjs theme --set`; every thread page of that run and its run page take it. Pages that
// span runs (accounts, pool) use the default. The pick inside a theme is by the row's key, so it
// varies across pages but never changes when a page is synced again.
const gallery = (files) => Object.freeze(files.map((f) => `https://www.notion.so/images/page-cover/${f}`));
export const COVER_STYLES = Object.freeze({
  gradients: gallery(['gradients_1.png', 'gradients_2.png', 'gradients_3.png', 'gradients_4.png', 'gradients_5.png', 'gradients_6.png',
    'gradients_7.png', 'gradients_8.png', 'gradients_9.png', 'gradients_10.jpg', 'gradients_11.jpg']),
  'japanese-prints': gallery(['woodcuts_1.jpg', 'woodcuts_2.jpg', 'woodcuts_3.jpg', 'woodcuts_4.jpg', 'woodcuts_5.jpg', 'woodcuts_6.jpg',
    'woodcuts_7.jpg', 'woodcuts_8.jpg', 'woodcuts_9.jpg', 'woodcuts_10.jpg', 'woodcuts_11.jpg', 'woodcuts_13.jpg', 'woodcuts_14.jpg',
    'woodcuts_15.jpg', 'woodcuts_16.jpg']),
  space: gallery(['nasa_earth_grid.jpg', 'nasa_the_blue_marble.jpg', 'nasa_orion_nebula.jpg', 'nasa_carina_nebula.jpg',
    'nasa_space_shuttle_columbia.jpg', 'nasa_robert_stewart_spacewalk.jpg', 'nasa_eagle_in_lunar_orbit.jpg', 'nasa_buzz_aldrin_on_the_moon.jpg',
    'nasa_reduced_gravity_walking_simulator.jpg', 'webb1.jpg', 'webb2.jpg', 'webb3.jpg', 'webb4.jpg']),
  'old-masters': gallery(['rijksmuseum_jansz_1636.jpg', 'rijksmuseum_vermeer_the_milkmaid.jpg', 'rijksmuseum_rembrandt_1642.jpg',
    'rijksmuseum_mignons_1660.jpg', 'rijksmuseum_claesz_1628.jpg', 'met_william_morris_1875.jpg', 'met_paul_signac.jpg', 'met_horace_pippin.jpg',
    'met_cezanne_1890.jpg', 'met_emanuel_leutze.jpg', 'met_vincent_van_gogh_cradle.jpg', 'met_the_unicorn_in_captivity.jpg']),
  'solid-colors': gallery(['solid_red.png', 'solid_yellow.png', 'solid_beige.png', 'solid_blue.png']),
});
export const DEFAULT_THEME = 'gradients';
export const COVERS = COVER_STYLES[DEFAULT_THEME];
const ALL_COVERS = new Set(Object.values(COVER_STYLES).flat());
const themeFile = (runDir) => join(runDir, 'notion', 'theme.json');
/** The run's cover theme: { theme, covers }. A missing or unknown theme is the default. */
export function runTheme(runDir) {
  let theme = DEFAULT_THEME;
  try { theme = JSON.parse(readFileSync(themeFile(runDir), 'utf8')).theme || DEFAULT_THEME; } catch { /* default */ }
  return COVER_STYLES[theme] ? { theme, covers: COVER_STYLES[theme] } : { theme: DEFAULT_THEME, covers: COVERS };
}
/** PURE. The cover for a page, fixed by its key. */
export const coverFor = (key, covers = COVERS) => covers[parseInt(sha256(str(key)).slice(0, 8), 16) % covers.length];
const str = (v) => (v == null ? '' : String(v));
const clip = (v, n = TEXT_MAX) => { const s = str(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ---- pure mapping ---------------------------------------------------------------------------------

const LANES = { cover: 'Cover', harvest: 'Harvest', pot: 'Pot', seed: 'Pot', remix: 'Remix' };
const STOP_TO_RUN_STATUS = { brief: 'Brief', selection: 'Selection', products: 'Products', drafts: 'Drafts', schedule: 'Schedule' };
export const CALLS = Object.freeze({ Approve: 'approve-row', Revise: 'revise-row', Hold: 'hold-row' });

/**
 * PURE. Where one row stands, from run-studio status(): { stage, stop, stopStatus, revision }.
 * `stop` is the furthest row-mode stop that holds the row; `stage` is the tracker's Stage option.
 */
export function stageOf(studio, rowId) {
  let last = null;
  for (const s of studio || []) {
    if (s.mode !== 'rows') continue;
    const r = (s.rows || []).find((x) => x.id === rowId);
    if (!r) continue;
    if (r.status === 'held') return { stage: 'Held', stop: s.stage, stopStatus: r.status, revision: r.revision || null };
    last = { stop: s.stage, stopStatus: r.status, revision: r.revision || null };
  }
  if (!last) return { stage: 'Selected', stop: null, stopStatus: null, revision: null };
  const approved = last.stopStatus === 'approved';
  const stage = last.stop === 'schedule' ? (approved ? 'Scheduled' : 'Approved')
    : last.stop === 'drafts' ? (approved ? 'Approved' : 'Draft')
      : last.stop === 'products' ? 'Products' : 'Selected';
  return { stage, ...last };
}

/** PURE. The Jev column from the drafts packet plan row carried in provenance. */
export function jevOf(provenance) {
  const packet = provenance?.review?.packet;
  if (!packet) return { jev: 'Not read', note: '' };
  const note = [...(packet.holds || []), ...(packet.reviews || [])].map(str).join(' · ');
  if (packet.status === 'not read') return { jev: 'Not read', note };
  if (packet.status === 'hold') return { jev: 'Held', note };
  if (packet.status === 'review_needed') return { jev: 'Needs you', note };
  if (packet.status === 'ready_for_owner_review') return { jev: 'Clean', note: '' };
  return { jev: 'Not read', note: `packet status ${packet.status}` };
}

/**
 * PURE. A card's Copy sha: the copy digest of its tweets (copyDigest, the same SHA-256 as copy-change
 * copySha256 and run-review-drafts tweetsSha256), cut to the 16 characters the note's "copy sha256"
 * line prints. '' when there is no copy. It used to hash the stop in with the tweets, so every card
 * synced before its copy existed carried the same value: R2026-09-26's Saturday cards all read
 * a28f6e68982aee9f, which is the selection stop over an empty tweet list.
 */
export const copySha = (tweets) => ((tweets || []).some((t) => str(t).trim()) ? copyDigest(tweets).slice(0, 16) : '');
/** PURE. The binding stored on a card: the stop (Call stop) and the copy (Copy sha). */
export const bindingOf = (stop, copy) => `${str(stop)}·${str(copy)}`;
/**
 * PURE. What the owner's call is bound to: the copy AND the stop it was made at. A call made on one
 * copy at one stop never applies to changed copy or to the next stop, and a call on a card with no
 * copy yet is still bound to its stop.
 */
export const callKey = (stop, tweets) => bindingOf(stop, copySha(tweets));
/**
 * PURE. The binding a card carried BEFORE Call stop existed: one hash of the stop and the copy, stored
 * in Copy sha. Cards written that way have an empty Call stop, so bindingOf() reads them as
 * `·<hash>` and nothing ever matches, which would wipe every Your call / Your note on the next push.
 * A legacy card still matches when its stored hash is this value for the row's current stop and copy.
 */
export const legacyCallKey = (stop, tweets) => sha256(`${str(stop)}\n${copyDigest(tweets || [])}`).slice(0, 16);
/** PURE. Whether a card's stored binding (as readThread returns it) still holds for a row. */
export const bindingHolds = (card, row) => card.callKey === row.callKey || (card.legacy === true && !!card.legacySha && card.legacySha === row.legacyCallKey);

const handleOf = (row) => str(row.account).replace(/^@/, '');

// Owner, 2026-09-24: a run is named MONTHdayA-dayB for the days it covers ("Sept17-20"), no weekday.
// AP month abbreviations, as the owner wrote "Sept".
const MONTHS = ['Jan', 'Feb', 'March', 'April', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
/** PURE. "Sept17-20", "Sept29-Oct2", "Sept17" for one day; null with no dates. Dates are YYYY-MM-DD. */
export function runName(dates) {
  const days = [...new Set((dates || []).map((d) => str(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (!days.length) return null;
  const part = (d) => ({ m: MONTHS[Number(d.slice(5, 7)) - 1], d: Number(d.slice(8, 10)) });
  const a = part(days[0]), b = part(days.at(-1));
  if (days.length === 1) return `${a.m}${a.d}`;
  return a.m === b.m ? `${a.m}${a.d}-${b.d}` : `${a.m}${a.d}-${b.m}${b.d}`;
}

/** PURE. A thread's name for its title: our hook's first line, cut at a word within 70 characters. */
export function threadName(hook) {
  const line = str(hook).split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (line.length <= 70) return line;
  const cut = line.slice(0, 70);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 70).trim()}…`;
}
const dateOf = (row, slot) => str(slot?.at || row.at || row.publishAt || row.date || '') || null;

/**
 * PURE. One spec row (+ its provenance, studio position, review-draft ledger entry and, at the
 * schedule stop, the live hook) → { key, title, account, properties, note }. The call binding
 * (Copy sha) covers the live hook when there is one, so a hook edited in Typefully is new copy.
 */
export function threadRow({ runId, row, provenance = null, position, ledger = null, liveHook = null, name = null }) {
  const tweets = Array.isArray(row.draft?.tweets) ? row.draft.tweets.map(String) : [];
  const donorHook = str(provenance?.source?.hook || row.source?.hook) || null;
  const lane = LANES[str(row.lane).toLowerCase()] || null;
  const { jev, note: jevNote } = jevOf(provenance);
  const key = `${runId}·${row.id}`;
  const products = Array.isArray(provenance?.products) ? provenance.products.map((p) => p.title || p.asin).filter(Boolean)
    : Array.isArray(row.draft?.products) ? row.draft.products.map((p) => p.title || p.asin).filter(Boolean) : [];
  const ourHook = liveHook ? liveHook.text : tweets[0] || null;
  let sim = liveHook ? liveHook.sim : provenance?.hook?.check?.sim;
  if (!Number.isFinite(sim) && donorHook && ourHook) {
    try { sim = checkHook(ourHook, donorHook, { lane: str(row.lane).toLowerCase() || 'cover' }).sim; } catch { sim = null; }
  }
  const copy = liveHook ? [liveHook.text, ...tweets.slice(1)] : tweets;
  const when = dateOf(row, provenance?.slot);
  // Owner, 2026-09-24: "MONTHdayA-dayB — Lane — Thread Name".
  const title = [name || runId, lane, threadName(ourHook) || handleOf(row) || row.id].filter(Boolean).join(' — ');
  const properties = {
    Thread: title,
    'Row key': key,
    Stage: position.stage,
    Lane: lane,
    Jev: jev,
    'Jev note': clip(jevNote, 600),
    Products: productOptions(products),
    Source: str(provenance?.source?.url || row.source?.url) || null,
    Typefully: str(ledger?.shareUrl) || null,
    'Donor hook': donorHook ? clip(donorHook) : null,
    'Our hook': ourHook ? clip(ourHook) : null,
    'Hook match': Number.isFinite(sim) ? Math.round(sim * 1000) / 1000 : null,
    Scheduled: when,
    'Copy sha': copySha(copy),
    'Call stop': str(position.stop),
    ...(liveHook ? { 'Hook as of': liveHook.at } : {}),
  };
  const note = provenance ? renderNote(provenance, { tweets, runId, rowId: row.id }) : 'No source note yet: this row has no provenance (scripts/run-provenance.mjs runs at the drafts stop).';
  return { key, title, account: handleOf(row), properties, note, callKey: callKey(position.stop, copy), legacyCallKey: legacyCallKey(position.stop, copy) };
}

/** PURE. The Runs row: where the run stands and its counts. */
export function runRow({ runId, studio, threads, name = null }) {
  const current = (studio || []).find((s) => !['approved'].includes(s.status)) || (studio || []).at(-1);
  const days = [...new Set(threads.map((t) => str(t.properties.Scheduled).slice(0, 10)).filter(Boolean))].sort();
  return {
    key: runId,
    properties: {
      Run: name || runId,
      'Run ID': runId,
      Status: current ? (current.status === 'approved' ? 'Done' : STOP_TO_RUN_STATUS[current.stage] || null) : null,
      Threads: threads.length,
      'Needs you': threads.filter((t) => ['Needs you', 'Held'].includes(t.properties.Jev)).length,
      Scheduled: threads.filter((t) => t.properties.Stage === 'Scheduled').length,
      Days: days.join(', ') || null,
    },
  };
}

/**
 * PURE. The owner's calls → run-studio commands. Only a call on the copy it was made on (Copy sha
 * still equals what this run holds now) at a stop awaiting the owner becomes a command; the rest are
 * reported with the reason, never recorded.
 */
export function callsToCommands({ runDir, notionRows, current }) {
  const commands = [], skipped = [];
  for (const n of notionRows) {
    if (!n.call) continue;
    const row = current.get(n.key);
    if (!row) { skipped.push({ key: n.key, call: n.call, why: 'not a row of this run' }); continue; }
    if (!CALLS[n.call]) { skipped.push({ key: n.key, call: n.call, why: 'unknown call' }); continue; }
    if (!bindingHolds(n, row)) { skipped.push({ key: n.key, call: n.call, why: 'the copy or the stop changed after your call; look again' }); continue; }
    if (!row.stop || !['awaiting approval', 'approved', 'held'].includes(row.stopStatus)) { skipped.push({ key: n.key, call: n.call, why: `nothing awaits you at this row (${row.stopStatus || 'not submitted'})` }); continue; }
    if (!row.revision) { skipped.push({ key: n.key, call: n.call, why: 'no revision to bind to' }); continue; }
    const message = `Notion · Your call: ${n.call}${n.note ? ` — ${n.note}` : ''}`;
    commands.push({ key: n.key, rowId: row.rowId, stop: row.stop, call: n.call, message,
      argv: ['scripts/run-studio.mjs', CALLS[n.call], runDir, row.stop, row.rowId, '--revision', row.revision, '--message', message] });
  }
  return { commands, skipped };
}

// ---- Notion property/body encoding ---------------------------------------------------------------

const rich = (s) => (s == null || s === '' ? [] : [{ type: 'text', text: { content: clip(s) } }]);

/**
 * PURE. Product names as multi-select options, short enough to group by: the catalogue title up to its
 * first size or spec clause ("Nutricost Magnesium Glycinate Capsules (360 Capsules…" → "Nutricost
 * Magnesium Glycinate Capsules"). Notion refuses commas and names over 100 characters.
 */
export const productName = (title) => clip(str(title).replace(/(\d),(\d)/g, '$1$2').split(/ \(| - | \| |,/)[0].replace(/\s+/g, ' ').trim(), 100);
export const productOptions = (names) => [...new Set((names || []).map(productName).filter(Boolean))];

// Each database's property types, by name. "Scheduled" is a date on a thread and a count on a run.
export const SCHEMAS = Object.freeze({
  threads: { Thread: 'title', Stage: 'select', Lane: 'select', Jev: 'select', 'Your call': 'select', Products: 'multi_select', Threads: 'select',
    Source: 'url', Typefully: 'url', 'Hook match': 'number', Scheduled: 'date', 'Hook as of': 'date' },
  runs: { Run: 'title', Status: 'select', Threads: 'number', 'Needs you': 'number', Scheduled: 'number' },
  accounts: { Account: 'title' },
  pool: { Body: 'title', Lane: 'select', 'Jev readiness': 'select', 'Hearts left': 'number', 'Hearts expire': 'date', Airtable: 'url' },
});

/** PURE. Tracker properties → Notion API property values; types from SCHEMAS[db], text otherwise. */
export function encodeProperties(props, relations = {}, db = 'threads') {
  const types = SCHEMAS[db] || {}, out = {};
  for (const [name, v] of Object.entries(props)) {
    if (v === undefined) continue;
    const type = types[name] || 'rich_text';
    if (type === 'title') out[name] = { title: rich(v) };
    else if (type === 'select') out[name] = { select: v ? { name: v } : null };
    else if (type === 'multi_select') out[name] = { multi_select: (v || []).map((name) => ({ name })) };
    else if (type === 'url') out[name] = { url: v || null };
    else if (type === 'number') out[name] = { number: Number.isFinite(v) ? v : null };
    else if (type === 'date') out[name] = { date: v ? { start: v } : null };
    else out[name] = { rich_text: rich(v) };
  }
  for (const [name, ids] of Object.entries(relations)) out[name] = { relation: ids.map((id) => ({ id })) };
  return out;
}

/**
 * PURE. What a database must gain before these rows are written. Given its `properties` as Notion
 * returns them, only what is missing: each property the rows write that it lacks (name → type), and
 * each select or multi-select option it lacks. With no schema (the connector path, which cannot read
 * it here) it is everything the rows need, for the pusher to add whichever the data source lacks.
 * R2026-09-26: Products had no option for "Sports Research® Magnesium L-Threonate 2000mg w/Magtein®"
 * (B0CDP398C6), and that card's write failed. A property of another type is left alone.
 */
export function schemaAdditions(rows, schema = null, db = 'threads') {
  const types = SCHEMAS[db] || {}, properties = {}, options = {};
  for (const row of rows || []) {
    for (const [name, v] of Object.entries(row.properties || {})) {
      if (v === undefined) continue;
      const type = types[name] || 'rich_text', existing = schema?.[name];
      if (type !== 'title' && !existing) properties[name] = type;
      if ((type !== 'select' && type !== 'multi_select') || (existing && existing.type !== type)) continue;
      const have = new Set((existing?.[type]?.options || []).map((o) => o.name));
      for (const option of (type === 'select' ? [v] : v || []).filter(Boolean)) if (!have.has(option)) (options[name] ||= new Set()).add(option);
    }
  }
  return { properties, options: Object.fromEntries(Object.entries(options).map(([name, set]) => [name, [...set].sort()])) };
}

/**
 * Adds what schemaAdditions finds missing, in one schema update, before any page is written. The
 * existing options go back unchanged beside the new ones, so none is dropped. Returns the additions.
 */
export async function ensureSchema(nc, db, rows, kind = 'threads') {
  const current = (await nc.database(db)).properties || {};
  const add = schemaAdditions(rows, current, kind);
  const optionsOf = (name, type) => [...(current[name]?.[type]?.options || []).map((o) => ({ id: o.id, name: o.name })),
    ...(add.options[name] || []).map((n) => ({ name: n }))];
  const patch = {};
  for (const [name, type] of Object.entries(add.properties)) {
    patch[name] = { [type]: type === 'select' || type === 'multi_select' ? { options: optionsOf(name, type) } : {} };
  }
  for (const name of Object.keys(add.options)) if (!patch[name]) patch[name] = { [current[name].type]: { options: optionsOf(name, current[name].type) } };
  if (Object.keys(patch).length) await nc.updateDatabase(db, patch);
  return add;
}

/** PURE. The connector's payload: the rows, and the schema they need first (see schemaAdditions). */
export function connectorPayload({ runId, run, threads, db = NOTION_DBS.threads }) {
  return { runId, schema: { threads: { database: db, ...schemaAdditions(threads, null, 'threads'),
    howTo: 'Before writing any page, add to the Threads data source each property and each option listed here that it lacks.' } },
  run, threads };
}

/** PURE. The note as one code block (keeps its layout; up to 100 × 2,000 characters). */
export function noteBlocks(note) {
  const s = str(note), parts = [];
  for (let i = 0; i < s.length && parts.length < BODY_ITEMS; i += TEXT_MAX) parts.push({ type: 'text', text: { content: s.slice(i, i + TEXT_MAX) } });
  return [{ object: 'block', type: 'code', code: { language: 'plain text', rich_text: parts } }];
}

// ---- Notion client --------------------------------------------------------------------------------

/**
 * PURE. The integration token, under either name. The cloud environment holds it as NOTION_API_TOKEN;
 * reading only NOTION_TOKEN there sent every push to the connector payload and left the Pool copy
 * unrefreshed (R2026-10-04 prep report, found 2026-10-05). NOTION_TOKEN wins when both are set.
 */
export const notionToken = (env = {}) => env.NOTION_TOKEN || env.NOTION_API_TOKEN || null;

export function notion(token, { fetchImpl } = {}) {
  if (!token) throw new Error('No Notion token: set NOTION_TOKEN or NOTION_API_TOKEN');
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const read = method === 'GET' || (method === 'POST' && path.endsWith('/query'));
    const result = await requestWithPolicy({ provider: 'Notion', operation: `${method} ${path.replace(/[0-9a-f-]{32,36}/g, ':id')}`,
      url: `https://api.notion.com/v1${path}`, init: { method, headers, body: body ? JSON.stringify(body) : undefined },
      replayable: read, fetchImpl, maxAttempts: read ? 5 : 1, retryableStatuses: new Set([429, 500, 502, 503, 504]) });
    return jsonWithSchema(result, { provider: 'Notion', operation: `${method} ${path}`, validate: (j) => j && typeof j === 'object' });
  };
  return {
    async queryAll(db, filter) {
      const out = [];
      let cursor;
      do {
        const page = await call('POST', `/databases/${db}/query`, { ...(filter ? { filter } : {}), page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        out.push(...(page.results || []));
        cursor = page.has_more ? page.next_cursor : null;
      } while (cursor);
      return out;
    },
    create: (db, properties, children, cover = null) => call('POST', '/pages', { parent: { database_id: db }, properties,
      ...(children ? { children } : {}), ...(cover ? { cover: { type: 'external', external: { url: cover } } } : {}) }),
    update: (id, properties) => call('PATCH', `/pages/${id}`, { properties }),
    database: (id) => call('GET', `/databases/${id}`),
    updateDatabase: (id, properties) => call('PATCH', `/databases/${id}`, { properties }),
    children: (id) => call('GET', `/blocks/${id}/children?page_size=100`),
    remove: (id) => call('DELETE', `/blocks/${id}`),
    append: (id, children) => call('PATCH', `/blocks/${id}/children`, { children }),
    archive: (id) => call('PATCH', `/pages/${id}`, { archived: true }),
    setCover: (id, url) => call('PATCH', `/pages/${id}`, { cover: { type: 'external', external: { url } } }),
  };
}

const plain = (p) => (p?.rich_text || p?.title || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');
/** PURE. A Notion thread page → the fields the sync reads back. */
export const readThread = (page) => ({ id: page.id, key: plain(page.properties?.['Row key']),
  callKey: bindingOf(plain(page.properties?.['Call stop']), plain(page.properties?.['Copy sha'])),
  legacy: !plain(page.properties?.['Call stop']).trim(), legacySha: plain(page.properties?.['Copy sha']).trim(),
  call: page.properties?.['Your call']?.select?.name || null, note: plain(page.properties?.['Your note']).trim() });

async function upsertByTitle(nc, db, kind, titleProp, title, cache) {
  if (cache.has(title)) return cache.get(title);
  const hit = await nc.queryAll(db, { property: titleProp, title: { equals: title } });
  const id = hit[0]?.id || (await nc.create(db, encodeProperties({ [titleProp]: title }, {}, kind), null, coverFor(title))).id;
  cache.set(title, id);
  return id;
}

/** Writes the rows. One write at a time; a failed write stops the pass (writes are never replayed). */
export async function pushToNotion(nc, { runId, threads, run, dbs = NOTION_DBS, covers = COVERS, log = () => {} }) {
  const added = await ensureSchema(nc, dbs.threads, threads, 'threads');
  for (const [name, type] of Object.entries(added.properties)) log(`schema: added property ${name} (${type})`);
  for (const [name, names] of Object.entries(added.options)) log(`schema: added ${names.length} ${name} option(s): ${names.join(', ')}`);
  const existing = new Map((await nc.queryAll(dbs.threads, { property: 'Row key', rich_text: { starts_with: `${runId}·` } }))
    .map((p) => [readThread(p).key, p]));
  const accountIds = new Map();
  // The run is found by its Run ID; its title (the days it covers) may change as rows are added.
  // A run row made before Run ID existed is titled with the run id: adopt it rather than duplicate it.
  const found = [...await nc.queryAll(dbs.runs, { property: 'Run ID', rich_text: { equals: runId } })];
  if (!found.length) found.push(...await nc.queryAll(dbs.runs, { property: 'Run', title: { equals: runId } }));
  const runId_ = found[0]?.id || (await nc.create(dbs.runs, encodeProperties(run.properties, {}, 'runs'), null, coverFor(runId, covers))).id;
  await nc.update(runId_, encodeProperties(run.properties, {}, 'runs'));
  const counts = { created: 0, updated: 0, callsCleared: 0 };
  for (const t of threads) {
    const accountId = t.account ? await upsertByTitle(nc, dbs.accounts, 'accounts', 'Account', t.account, accountIds) : null;
    const relations = { Run: [runId_], ...(accountId ? { Account: [accountId] } : {}) };
    const prior = existing.get(t.key);
    const priorState = prior ? readThread(prior) : null;
    const clear = !!(priorState?.call || priorState?.note) && !bindingHolds(priorState, t);
    const props = encodeProperties({ ...t.properties, ...(clear ? { 'Your call': null, 'Your note': '' } : {}) }, relations);
    if (!prior) {
      await nc.create(dbs.threads, props, noteBlocks(t.note), coverFor(t.key, covers));
      counts.created++;
    } else {
      await nc.update(prior.id, props);
      const kids = await nc.children(prior.id);
      for (const b of kids.results || []) if (b.type === 'code') await nc.remove(b.id);   // only the machine note; owner blocks stay
      await nc.append(prior.id, noteBlocks(t.note));
      counts.updated++;
      if (clear) counts.callsCleared++;
    }
    log(`${t.key}: ${prior ? 'updated' : 'created'}${clear ? ' (call cleared: copy or stop changed)' : ''}`);
  }
  return counts;
}

// ---- the pool: a copy of what pool prep last read (owner, 2026-09-24: "keep it super simple and link
// back to airtable") -----------------------------------------------------------------------------------

const READINESS = { ready: 'Ready', 'light-edit': 'Auto-edited', owner: 'Needs you', blocked: 'Blocked', unread: 'Not read' };

/**
 * PURE. queues/pool-prep.json bodies → Pool rows, keyed by their Airtable record link. `harvests`
 * maps a Harvests record id to its fields (In Pool rows). A body with no record id is skipped and
 * counted, never guessed.
 */
export function poolRows({ prep, harvests = new Map(), baseId, hearts }) {
  const rows = [], skipped = [];
  for (const b of prep?.bodies || []) {
    const harvest = b.kind === 'harvest';
    const rec = harvest ? b.id : b.ref;
    if (!/^rec[A-Za-z0-9]{14}$/.test(str(rec)) || !baseId) { skipped.push(b.id); continue; }
    const f = harvest ? harvests.get(rec) || {} : {};
    const used = Number(f['Hearts Used']);
    rows.push({ key: `https://airtable.com/${baseId}/${harvest ? HARVESTS_TABLE : POTS_TABLE}/${rec}`, properties: {
      Body: harvest ? threadName(f.Body) || rec : b.id,
      Lane: harvest ? 'Harvest' : 'Pot',
      Account: str(b.account || f['Origin Account']) || null,
      'Jev readiness': READINESS[b.readiness] || 'Not read',
      Why: clip((b.why || []).join(' · '), 600),
      Tier: str(f.Tier) || null,
      'Hearts left': harvest && Number.isFinite(used) && Number.isFinite(hearts) ? Math.max(0, hearts - used) : null,
      'Hearts expire': str(f['Expires At']).slice(0, 10) || null,
      Airtable: null,
    } });
    rows.at(-1).properties.Airtable = rows.at(-1).key;
  }
  return { rows, skipped };
}

/**
 * Upserts the pool copy by Airtable link and archives rows no longer in the pool (the copy mirrors it).
 * When any body was skipped, nothing is archived: a skipped body may still be in the pool.
 */
export async function pushPool(nc, { rows, skipped = [], db = POOL_DB }) {
  const existing = await nc.queryAll(db, undefined);
  const byKey = new Map(existing.map((p) => [p.properties?.Airtable?.url || '', p]));
  const counts = { created: 0, updated: 0, archived: 0 };
  const keep = new Set();
  for (const r of rows) {
    keep.add(r.key);
    const props = encodeProperties(r.properties, {}, 'pool');
    const prior = byKey.get(r.key);
    if (prior) { await nc.update(prior.id, props); counts.updated++; }
    else { await nc.create(db, props, null, coverFor(r.key)); counts.created++; }
  }
  if (!skipped.length) for (const [key, page] of byKey) if (key && !keep.has(key)) { await nc.archive(page.id); counts.archived++; }
  return counts;
}

/** PURE. The key a page's cover is picked by: the same one the sync used when it created the page. */
export function coverKey(page) {
  const p = page?.properties || {};
  return plain(p['Row key']) || plain(p['Run ID']) || p.Airtable?.url || plain(p.Account) || page?.id || '';
}

/**
 * Gives every page in the tracker's databases that has no cover its fixed gallery cover. `restyle`
 * also replaces a cover that belongs to no theme (a run's own theme is kept).
 */
export async function fillCovers(nc, { dbs = { ...NOTION_DBS, pool: POOL_DB }, restyle = false, runId = null, runCovers = null } = {}) {
  const counts = { checked: 0, set: 0 };
  // With a run named, that run's thread pages and run page take its theme (and --restyle moves them
  // onto it); every other page keeps the default.
  const inRun = (key) => !!runId && (key === runId || key.startsWith(`${runId}·`));
  for (const db of Object.values(dbs)) {
    for (const page of await nc.queryAll(db, undefined)) {
      counts.checked++;
      const key = coverKey(page), covers = inRun(key) && runCovers ? runCovers : COVERS;
      const current = page.cover?.external?.url || page.cover?.file?.url || null;
      const wrong = inRun(key) && runCovers ? !covers.includes(current) : !ALL_COVERS.has(current);
      if (current && !(restyle && wrong)) continue;
      await nc.setCover(page.id, coverFor(key, covers));
      counts.set++;
    }
  }
  return counts;
}

// ---- run directory ---------------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The live hook of every row that has a review draft, read from Typefully (schedule stop). */
export async function liveHooks({ tf, rows, ledger, provenance, checkHook, liveTweets, now = () => new Date().toISOString() }) {
  const out = new Map();
  for (const row of rows) {
    const entry = ledger[row.id];
    if (!entry?.draftId || !entry?.socialSetId) continue;
    const draft = await tf.getDraft(entry.socialSetId, entry.draftId);
    const text = liveTweets(draft)[0];
    if (!text) continue;
    const donor = str(provenance[row.id]?.source?.hook || row.source?.hook);
    let sim = null, ok = null;
    if (donor) { const c = checkHook(text, donor, { lane: str(row.lane).toLowerCase() || 'cover' }); sim = c.sim; ok = c.ok; }
    out.set(row.id, { text, sim, ok, at: now() });
  }
  return out;
}

// The last live hooks read from Typefully (--refresh-hooks), kept in RUN_DIR so every later push and
// every `calls` binds the owner's call to the same copy the refresh showed them.
const liveHookFile = (runDir) => join(runDir, 'notion', 'live-hooks.json');
export function loadLiveHooks(runDir) {
  const file = liveHookFile(runDir);
  return existsSync(file) ? new Map(Object.entries(readJson(file))) : new Map();
}
function saveLiveHooks(runDir, hooks) {
  mkdirSync(dirname(liveHookFile(runDir)), { recursive: true });
  const merged = new Map([...loadLiveHooks(runDir), ...hooks]);
  const temp = `${liveHookFile(runDir)}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, liveHookFile(runDir));
  return merged;
}

export async function buildRows({ runDir, runId, spec, studio, liveHook = loadLiveHooks(runDir) }) {
  const provFile = join(runDir, 'provenance.json');
  const provenance = existsSync(provFile) ? readJson(provFile).rows || {} : {};
  const ledgerFile = join(runDir, 'review-drafts.json');
  const ledger = existsSync(ledgerFile) ? readJson(ledgerFile) : {};
  const name = runName((spec.rows || []).map((row) => row.date || provenance[row.id]?.date || provenance[row.id]?.slot?.at));
  const threads = (spec.rows || []).map((row) => threadRow({ runId, row, provenance: provenance[row.id] || null,
    position: stageOf(studio, row.id), ledger: ledger[row.id] || null, liveHook: liveHook.get(row.id) || null, name }));
  // The cover each page gets, in the run's theme (the connector path reads it from the payload).
  const { theme, covers } = runTheme(runDir);
  for (const t of threads) t.cover = coverFor(t.key, covers);
  const run = runRow({ runId, studio, threads, name });
  run.cover = coverFor(runId, covers);
  return { threads, run, provenance, ledger, theme, covers };
}

function writePayload(runDir, payload) {
  const dir = join(runDir, 'notion');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'payload.json'), temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

const flagOf = (rest, n) => { const i = rest.indexOf(`--${n}`); return i < 0 ? null : rest[i + 1]; };

async function poolCommand(rest) {
  const { loadEnv, airtable } = await import('../lib.mjs');
  const { LAWS } = await import('../laws.mjs');
  const { PREP_FILE } = await import('./pool-prep.mjs');
  const env = loadEnv();
  const prep = readJson(PREP_FILE);
  const pool = (await airtable(env, env.REGISTRY_BASE_ID).listAll('Harvests', {})).filter((r) => (r.fields.Status || '') === 'In Pool');
  const { rows, skipped } = poolRows({ prep, harvests: new Map(pool.map((r) => [r.id, r.fields])), baseId: env.REGISTRY_BASE_ID, hearts: LAWS.farm?.hearts });
  const summary = { preparedAt: prep.preparedAt, rows: rows.length, skipped };
  const token = notionToken(env);
  if (rest.includes('--dry') || !token) {
    const out = flagOf(rest, 'out');
    if (out) writeFileSync(resolve(out), `${JSON.stringify({ rows }, null, 2)}\n`, { mode: 0o600 });
    return { mode: token ? 'dry' : 'payload (no Notion token: NOTION_TOKEN or NOTION_API_TOKEN)', ...summary, ...(out ? { out } : {}) };
  }
  return { mode: 'pushed', ...summary, ...(await pushPool(notion(token), { rows, skipped })) };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (n) => flagOf(rest, n);
  if (command === 'pool') return poolCommand(rest);
  if (command === 'theme') {
    const runDir = flag('run-dir') && resolve(flag('run-dir'));
    if (!runDir) throw new Error('Usage: notion-sync.mjs theme --run-dir DIR [--set THEME]');
    const want = flag('set');
    if (want) {
      if (!COVER_STYLES[want]) throw new Error(`Unknown theme "${want}". Themes: ${Object.keys(COVER_STYLES).join(', ')}`);
      mkdirSync(dirname(themeFile(runDir)), { recursive: true });
      writeFileSync(themeFile(runDir), `${JSON.stringify({ theme: want, setAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    }
    return { theme: runTheme(runDir).theme, themes: Object.fromEntries(Object.entries(COVER_STYLES).map(([k, v]) => [k, v.length])), sample: runTheme(runDir).covers.slice(0, 3) };
  }
  if (command === 'covers') {
    const { loadEnv } = await import('../lib.mjs');
    const runDir = flag('run-dir') && resolve(flag('run-dir')), runId = flag('run-id');
    const theme = runDir ? runTheme(runDir) : null;
    return { mode: 'covers', ...(theme ? { theme: theme.theme } : {}),
      ...(await fillCovers(notion(notionToken(loadEnv())), { restyle: rest.includes('--restyle'), runId, runCovers: theme?.covers || null })) };
  }
  const runDir = flag('run-dir') && resolve(flag('run-dir')), runId = flag('run-id'), input = flag('input');
  if (!['push', 'calls'].includes(command) || !runDir || !runId || !input) throw new Error('Usage: notion-sync.mjs push|calls --run-dir DIR --run-id ID --input spec.json [--refresh-hooks] [--dry] | pool [--dry] [--out FILE]');
  if (!RUN_ID.test(runId)) throw new Error('run-id must be a short safe identifier, e.g. R2026-09-25');
  const { status } = await import('./run-studio.mjs');
  const { loadEnv } = await import('../lib.mjs');
  const env = loadEnv();
  const token = notionToken(env);
  const spec = readJson(resolve(input));
  const studio = status(runDir);
  // Hooks refreshed now are saved; a push or `calls` without the flag reuses the last refresh.
  let liveHook = loadLiveHooks(runDir);
  if (rest.includes('--refresh-hooks')) {
    const { typefully } = await import('../lib.mjs');
    const { liveTweets } = await import('./run-review-drafts.mjs');
    const pre = await buildRows({ runDir, runId, spec, studio });
    const fresh = await liveHooks({ tf: typefully(env), rows: spec.rows || [], ledger: pre.ledger, provenance: pre.provenance, checkHook, liveTweets });
    liveHook = saveLiveHooks(runDir, fresh);
  }
  const { threads, run, theme, covers } = await buildRows({ runDir, runId, spec, studio, liveHook });
  const outOfBand = [...liveHook.entries()].filter(([, h]) => h.ok === false).map(([id, h]) => `${id} (${Math.round(h.sim * 100)}%)`);
  if (command === 'calls') {
    // --from FILE: the rows as the in-session agent read them through the Notion connector
    // ([{ key, copySha, callStop, call, note }]), for when no Notion token is set. A card with no
    // callStop predates it and is matched on its legacy hash (see legacyCallKey).
    const pages = flag('from') ? readJson(resolve(flag('from'))).map((n) => ({ ...n, callKey: bindingOf(n.callStop, n.copySha),
      legacy: !str(n.callStop).trim(), legacySha: str(n.copySha).trim() }))
      : (await notion(token).queryAll(NOTION_DBS.threads, { property: 'Row key', rich_text: { starts_with: `${runId}·` } })).map(readThread);
    const current = new Map((spec.rows || []).map((row) => {
      const pos = stageOf(studio, row.id), t = threads.find((x) => x.key === `${runId}·${row.id}`);
      return [t.key, { rowId: row.id, callKey: t.callKey, legacyCallKey: t.legacyCallKey, stop: pos.stop, stopStatus: pos.stopStatus, revision: pos.revision }];
    }));
    return callsToCommands({ runDir, notionRows: pages, current });
  }
  if (rest.includes('--dry') || !token) {
    const payload = connectorPayload({ runId, run, threads });
    const file = writePayload(runDir, payload);
    return { mode: token ? 'dry' : 'payload (no Notion token: push these through the Notion connector)', file, theme,
      threads: threads.length, outOfBand, schemaFirst: payload.schema.threads.options };
  }
  const counts = await pushToNotion(notion(token), { runId, threads, run, covers, log: (l) => console.error(l) });
  return { mode: 'pushed', theme, ...counts, threads: threads.length, outOfBand };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 2; });
}
