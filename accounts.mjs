// Per-page config, built from the buyer's config/pages.json (lib/config-file.mjs). Adding a page =
// adding an entry there; nothing in code names a page. The shape below is what every consumer reads.
//
// SLOTS: posting times are not set here. Every page's daily slots come from accountSlots() in
// slots.mjs, inside the posting window in config/engine.json.
// CLOSING / DISCLAIMER: each page writes its own, so no two pages post one identical, searchable
// sentence (the cheapest network fingerprint there is).
// LIVE MASTER SWITCH: the Airtable Accounts table's Active checkbox pauses or resumes a page
// everywhere (overlay at the bottom of this file); config's `active` is the default when Airtable
// is unreachable.
import { readConfigFile } from './lib/config-file.mjs';
import { ACCOUNTS_TABLE } from './config.mjs';

const ENGINE = readConfigFile('engine');
const PAGES = Array.isArray(readConfigFile('pages').pages) ? readConfigFile('pages').pages : [];
const TZ = ENGINE.buyer?.timezone || 'Asia/Saigon';

// Fleet-uniform selection floors (identical on every monetized page); engine.json `fleet` overrides.
const FLEET = {
  slots: 7, weeklyFloor: 750_000, weeklyMax: 4, allTimeFloor: 2_000_000, allTimeSlots: 2,
  evergreenSlots: 1, weeklyTopTier: 5, backfillMax: 3,
  ...(ENGINE.fleet || {}),
};

/** PURE. One config/pages.json entry -> the account object every consumer reads. */
export function accountFromPage(p, { tz = TZ, fleet = FLEET } = {}) {
  const a = {
    name: p.name,
    sex: p.persona,
    handle: p.handle,
    socialSetId: p.typefullySocialSetId,
    niches: Array.isArray(p.niches) && p.niches.length ? p.niches : ['Health'],
    tz,
    levantaSubidPrefix: p.levantaSubidPrefix,
    rtLane: p.rtLane,
    paused: p.active !== true,
    voice: Array.isArray(p.voice) ? p.voice.join('\n') : (p.voice || ''),
    closing: p.closing || '',
    disclaimer: p.disclaimer || '',
    closingLegacy: p.closing ? [p.closing] : [],
    disclaimerLegacy: p.disclaimer ? [p.disclaimer] : [],
    ...fleet,
  };
  for (const k of ['plugHeavyExample', 'plugLightExample', 'defaultProduct', 'altProducts', 'crossPost', 'fuelEligibleAfter']) {
    if (p[k] !== undefined) a[k] = p[k];
  }
  return a;
}

export const ACCOUNTS = Object.fromEntries(PAGES.filter((p) => p && p.id).map((p) => [p.id, accountFromPage(p)]));

// THE BURNER: an optional staging page (engine.json `burner`: { handle, socialSetId }). It carries no
// levantaSubidPrefix, so every planner, roster and acceptance filter skips it, and publish-thread's
// --burner lane relaxes the monetization gates while keeping the per-tweet ones.
if (ENGINE.burner?.handle && Number.isInteger(ENGINE.burner?.socialSetId)) {
  ACCOUNTS.burner = {
    name: ENGINE.burner.name || 'Burner',
    handle: ENGINE.burner.handle,
    socialSetId: ENGINE.burner.socialSetId,
    burner: true,
    paused: true,
    tz: TZ,
    niches: ['Health'],
    voice: 'Neutral test page. No persona: whatever is being previewed keeps its own voice.',
    closing: '',
    disclaimer: '',
  };
}

// Every account carries its own code KEY. Found 2026-08-23: pod selection normalized the account as
// (key || name).toLowerCase(), and with no key present "Marcos Romano" -> "marcos romano", which
// matches no variant — the outline path could never render an account's own pod wording in
// production. The key is data the object should simply carry.
for (const [k, a] of Object.entries(ACCOUNTS)) a.key = k;

// Accepts the KEY ("example") or the DISPLAY NAME ("Example Page"), because both are in circulation and
// the mismatch is silent until something tries to round-trip. publish-thread stores the display name
// in the committed record on purpose — a record is meant to be read — but that made every shipped
// spec un-replayable: gating the 22 records of the 2026-08-28 batch failed 16 of them on "unknown
// account", when the copy was fine and only the label had changed shape.
export const resolveAccountKey = (name) => {
  const raw = String(name ?? '');
  if (ACCOUNTS[raw]) return raw;
  const lower = raw.toLowerCase();
  if (ACCOUNTS[lower]) return lower;
  const hit = Object.entries(ACCOUNTS).find(([, a]) => String(a?.name || '').toLowerCase() === lower);
  return hit ? hit[0] : null;
};

/** The page a command acts on when no --account is given: the first active page, else the first page. */
export const defaultAccountKey = () => (Object.entries(ACCOUNTS).find(([k, a]) => k !== 'burner' && !a.paused) || Object.entries(ACCOUNTS).find(([k]) => k !== 'burner') || [null])[0];

export const getAccount = (key) => {
  const a = ACCOUNTS[resolveAccountKey(key)];
  if (!a) throw new Error(`Unknown account: ${key}. Known: ${Object.keys(ACCOUNTS).join(', ')}`);
  return a;
};

// ---- Auto selection-mode for young pages (operator request 2026-08-08) -----------------------------
// A NEW page should EXPLORE (3x explorer products, no best-converter pin — pick-product.mjs) until it
// has enough of its own history to exploit, so it finds ITS winners instead of inheriting the old
// pages' habits. Graduation = EXPLORE_GRADUATE_DRAFTS created drafts in the ledger (default 30 ≈ a
// month at 1/day). Used by the roster overlay below ONLY when the Airtable "Selection Mode" field is
// blank — an explicit operator pick (Explore/Exploit) always wins. `lines` injectable for tests.
import { readFileSync, existsSync } from 'node:fs';
const GRADUATE_DRAFTS = Number(process.env.EXPLORE_GRADUATE_DRAFTS ?? 30);
let _draftCounts; // account name -> created-draft count, read once per process
export function autoSelectionMode(accountName, { minDrafts = GRADUATE_DRAFTS, lines } = {}) {
  let counts = _draftCounts;
  if (lines || !counts) {
    counts = new Map();
    try {
      const src = lines ?? (existsSync(new URL('./ledger.jsonl', import.meta.url)) ? readFileSync(new URL('./ledger.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean) : []);
      for (const line of src) {
        try { const e = typeof line === 'string' ? JSON.parse(line) : line; if (e.account && e.draftId) counts.set(e.account, (counts.get(e.account) || 0) + 1); } catch {}
      }
    } catch {}
    if (!lines) _draftCounts = counts;
  }
  return (counts.get(accountName) || 0) < minDrafts ? 'explore' : 'exploit';
}

// ---- Live master switch (operator decision 2026-07-22) ---------------------------------------------
// The Airtable "Accounts" table's Active checkbox is the operator's on/off control panel: flipping it
// pauses/resumes an account EVERYWHERE, no PR, no deploy (fleet-prep — 20 accounts need a panel, not
// code edits). This overlay runs once at import, before any consumer derives its account set (the
// engines' HEALTH filters read `paused` at module load): rows with an Engine Key map Active=false ->
// paused. accounts-sync used to overwrite Active from code on every run — that was the "I turned it
// on and it turned itself off" bug; the sync now seeds Active on row creation only.
// Fail-open by design: no AIRTABLE_PAT in the environment (local dev, CI tests), a fetch error, or a
// missing row all leave the accounts.mjs `paused` flags standing. LIVE_ROSTER=0 disables the overlay.
const ROSTER_TABLE = ACCOUNTS_TABLE;
try {
  const pat = process.env.AIRTABLE_PAT;
  if (pat && process.env.XDB_BASE_ID && /\d/.test(ROSTER_TABLE) && process.env.LIVE_ROSTER !== '0') {
    let off = '', applied = [];
    do {
      const qs = `pageSize=100&fields%5B%5D=Engine%20Key&fields%5B%5D=Active&fields%5B%5D=Selection%20Mode${off ? `&offset=${off}` : ''}`;
      const r = await fetch(`https://api.airtable.com/v0/${process.env.XDB_BASE_ID}/${ROSTER_TABLE}?${qs}`, { headers: { Authorization: `Bearer ${pat}` } });
      if (!r.ok) throw new Error(`Accounts table -> ${r.status}`);
      const j = await r.json();
      for (const rec of j.records || []) {
        const k = rec.fields['Engine Key'];
        if (!k || !ACCOUNTS[k]) continue;
        const wantPaused = !rec.fields.Active; // unchecked checkbox arrives as absent
        if (ACCOUNTS[k].paused !== wantPaused) { ACCOUNTS[k].paused = wantPaused; applied.push(`${k}→${wantPaused ? 'paused' : 'ACTIVE'}`); }
        // Selection Mode (operator knob, 2026-07-28, same panel as Active): Explore widens product
        // testing for this account (pick-product.mjs — 3x explorer allowance, learned-converter
        // pinning off). An explicit pick (Explore/Exploit) always wins; a BLANK field auto-resolves
        // by maturity (2026-08-08): a young page (< EXPLORE_GRADUATE_DRAFTS ledger drafts) explores
        // until it finds ITS winners, then graduates to exploit — so onboarding a new account needs
        // no manual mode flip. An unreachable overlay still fails to the code's flags.
        const sel = rec.fields['Selection Mode'];
        const wantMode = sel === 'Explore' ? 'explore' : sel === 'Exploit' ? 'exploit' : autoSelectionMode(ACCOUNTS[k].name);
        if ((ACCOUNTS[k].selectionMode ?? 'exploit') !== wantMode) { ACCOUNTS[k].selectionMode = wantMode; applied.push(`${k}→${wantMode}${sel ? '' : ' (auto)'}`); }
      }
      off = j.offset || '';
    } while (off);
    // stderr, not stdout (2026-08-31): this is a diagnostic, not data. Every --json path in the
    // repo has accounts.mjs in its import graph, so one stdout line here makes the payload
    // unparseable for any caller piping it. The catch below already wrote to stderr.
    if (applied.length) console.error(`[roster] Airtable master switch applied: ${applied.join(', ')}`);
  }
} catch (e) { console.warn(`[roster] live overlay skipped (${e.message}) — accounts.mjs paused flags stand`); }
