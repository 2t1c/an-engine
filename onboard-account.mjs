// onboard-account.mjs — the NEW-ACCOUNT KIT (operator 2026-08-24: "one command builds an account's
// whole setup with its own unique wording"). Scaling to 15 accounts makes onboarding the bottleneck:
// the checklist in ONBOARDING.md is ~8 manual steps, and the two that actually eat a day are unique
// boilerplate authoring (the anti-fingerprint gates reject fleet-shared wording) and the "fuel off
// for the first ~2 days" rule, which used to live in code comments and got forgotten.
//
//   node onboard-account.mjs --scaffold --key nadia --name "Nadia Kovac" --handle NadiaKovacX \
//        --topics "sleep,stress" [--niche "women's recovery"]
//   node onboard-account.mjs --check <key>          # validate any account (new or live); exit 2 on issues
//
// scaffold: picks the first closer+disclaimer from onboarding-bank.json that shares NO 5-word run
// with any live account (checks.mjs sharedWordRun — the same yardstick the suite enforces), chooses
// default/alt products from the merged menu by the topics you name, stamps fuelEligibleAfter
// (+4 days) and paused: true (the roster row is created with Active off; lucinda, natella,
// johnathan and felicia came up Active without it), and prints the ready-to-paste accounts.mjs
// block plus the two human steps that stay human on purpose (X account, Typefully OAuth). Writes
// NOTHING — you paste, review, commit; the suite and --check then hold the line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR, runMain, cliArg, loadEnv, typefully } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { sharedWordRun, ALLOW_ASINS } from './checks.mjs';

const arg = cliArg;
const BANK = JSON.parse(readFileSync(join(HERE_DIR, 'onboarding-bank.json'), 'utf8'));
const POLICY = JSON.parse(readFileSync(join(HERE_DIR, 'keep-asins.json'), 'utf8'));

const DISC_ELEMENTS = {
  affiliate: /affiliate/i, 'commission/earn': /commission|earn/i,
  'medical advice': /medical advice/i, FDA: /FDA/, 'doctor/physician': /doctor|physician/i,
};

export const fleet = (accounts = ACCOUNTS) =>
  Object.entries(accounts).filter(([, a]) => a.disclaimer).map(([key, a]) => ({ key, closing: a.closing || '', disclaimer: a.disclaimer }));

/** First bank pair unique against every live account (and structurally valid). Bank entries already
 *  adopted by an account fail the uniqueness test automatically — the bank self-consumes. */
export function pickBoilerplate(bank = BANK, live = fleet()) {
  const freeOf = (text, field) => live.every((f) => !f[field] || !sharedWordRun(text, f[field]));
  const closers = bank.closers.filter((c) => c.length <= 280 && freeOf(c, 'closing'));
  const disclaimers = bank.disclaimers.filter((d) => d.length <= 280
    && Object.values(DISC_ELEMENTS).every((re) => re.test(d)) && freeOf(d, 'disclaimer'));
  return { closing: closers[0] || null, disclaimer: disclaimers[0] || null, closersLeft: closers.length, disclaimersLeft: disclaimers.length };
}

/** Menu products for the named topics: default = first keep entry whose topic matches, alts = next two. */
export function menuProductsFor(topics, policy = POLICY) {
  const want = topics.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const hits = (policy.keep || []).filter((e) => want.includes(String(e.topic || '').toLowerCase()) && ALLOW_ASINS.has(e.asin));
  return hits.slice(0, 3).map((e) => ({ asin: e.asin, title: e.note.split(' — ')[0] }));
}


// ---- handle -> socialSetId ---------------------------------------------------------------------
// ONBOARDING.md step 1 said "note the socialSetId (it's in the Typefully URL)" and the scaffold
// emitted `socialSetId: 0` with a TODO calling it "the one step that stays human". It never had to
// be: GET /social-sets returns id + username + team for every set the token can see. The repo has
// nineteen call sites that CONSUME a socialSetId and not one that ever listed them, which is the
// only reason this was still being copied out of a browser bar by hand.

/** Every social set this token can reach. Paginated; Typefully caps limit at 50. */
export async function socialSets(env) {
  const tf = typefully(env);
  const out = [];
  for (let offset = 0; ; offset += 50) {
    const j = await tf.get(`/social-sets?limit=50&offset=${offset}`);
    const page = j?.results || [];
    out.push(...page);
    if (page.length < 50 || !j?.next) break;
  }
  return out;
}

/** The live fleet's own team. A set outside it is not necessarily wrong, but it IS worth saying
 *  out loud — every monetized account sits in this one, and a set in "Inactive Accs" is a page
 *  somebody parked. */
export const FLEET_TEAM = 'REQy9XJCJeLvkUDr';

/** PURE. The X handle Typefully actually posts from, read off a social-set DETAIL response.
 *
 *  THE SET'S `username` IS NOT THE X HANDLE. It is Typefully's own name for the set, and the two
 *  agree only by coincidence. Felicia's set is `ThiisiisAii` while her posts land on
 *  One page was caught 2026-09-20 by reading the first warm-up post's published URL, a month
 *  after onboarding, because nothing had ever compared the two. Johnathan's matched, which is
 *  exactly why the bug survived: half the sample looked right.
 *
 *  `/social-sets` (the list resolveHandle reads) carries only the set username. The X handle is in
 *  the per-set detail under platforms.x.username, so knowing it costs one extra call — which is
 *  why handleDrift below takes the detail rather than re-deriving it.
 *
 *  Returns null when the set has no X platform connected, which is a different problem and says so.
 */
export const xHandleOf = (detail) => detail?.platforms?.x?.username || null;

/** PURE. Does what we believe about an account's handle match what Typefully posts from?
 *
 *  This is the guard that was missing. reconcile-handles.mjs covers the SWIPE DB's tracked
 *  creators — other people's pages, where a rename blacks out ingestion — and never looked at our
 *  own fleet. So our own handle could be wrong indefinitely, and the only places it shows up are
 *  quiet ones: store-catalog builds `x.com/<handle>` as the public profile link, accounts-sync
 *  writes it to the roster row, and every generation prompt frames the voice as "@<handle>".
 *  Nothing breaks loudly. Nothing breaks at all, in fact — it is just wrong.
 *
 *  Returns [] when the account is consistent, else one finding.
 */
export function handleDrift(account = {}, detail = null) {
  const live = xHandleOf(detail);
  const stored = String(account.handle || '').replace(/^@/, '').trim();
  if (!detail) return [{ key: account.key, why: 'no Typefully detail for this social set' }];
  if (!live) return [{ key: account.key, stored, why: `social set ${detail.id} has no X account connected` }];
  if (!stored) return [{ key: account.key, live, why: 'account has no handle recorded' }];
  if (stored.toLowerCase() === live.toLowerCase()) return [];
  return [{ key: account.key, stored, live, why: `accounts.mjs says @${stored}, Typefully posts from @${live}` }];
}

/**
 * Resolve an X handle to its Typefully social set. Pure so it can be tested without a token.
 *
 * REFUSES rather than guesses. A wrong socialSetId is the most expensive mistake available here:
 * ONBOARDING.md records the fleet once reporting Knox's posts as @Genius_Media_ because a Handle
 * and a Social Set ID were edited apart, and every downstream workflow joins on that id. So: an
 * exact case-insensitive username match, or nothing.
 */
export function resolveHandle(handle, sets = []) {
  const want = String(handle || '').replace(/^@/, '').trim().toLowerCase();
  if (!want) return { error: 'no handle given' };
  const hit = sets.filter((s) => String(s.username || '').toLowerCase() === want);
  if (!hit.length) {
    const near = sets.filter((s) => String(s.username || '').toLowerCase().includes(want)).slice(0, 5);
    return { error: `no Typefully social set has the username "${want}"`
      + (near.length ? ` — did you mean ${near.map((s) => `@${s.username} (${s.id})`).join(', ')}?` : ' — connect the X account in Typefully first') };
  }
  if (hit.length > 1) return { error: `"${want}" matches ${hit.length} social sets (${hit.map((s) => s.id).join(', ')}) — resolve by hand` };
  const s = hit[0];
  return {
    socialSetId: s.id, username: s.username, displayName: s.name || '',
    team: s.team?.name || '', teamId: s.team?.id || '',
    warning: s.team?.id && s.team.id !== FLEET_TEAM
      ? `set ${s.id} lives in team "${s.team?.name}", not the fleet workspace — confirm this is the right page before wiring it`
      : null,
  };
}

/** Every socialSetId already claimed in accounts.mjs. test-scaffolds hard-fails a duplicate
 *  (two accounts on one set = double generation), so catching it here saves a round trip. */
export const takenSocialSetIds = (accounts = ACCOUNTS) =>
  new Map(Object.entries(accounts).filter(([, a]) => a.socialSetId).map(([k, a]) => [String(a.socialSetId), k]));

/** The scaffold emits JS source, so anything interpolated into a single-quoted literal has to be
 *  escaped or the pasted block will not parse. Bit twice on 2026-09-19: "men's strength and
 *  hormones" as a niche, and two "Physician's Choice" product titles from the menu. An apostrophe
 *  is ordinary in both a niche and a brand name, so this is the common case rather than the edge.
 *  The page's name and handle go through it too: a name with an apostrophe broke the block, which
 *  the scaffold test found on 2026-09-26. */
const q = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function scaffoldBlock({ key, name, handle, topics, niche, socialSetId = 0 }) {
  const picked = pickBoilerplate();
  if (!picked.closing || !picked.disclaimer) {
    throw new Error(`onboarding bank exhausted (closers left: ${picked.closersLeft}, disclaimers left: ${picked.disclaimersLeft}) — author fresh entries in onboarding-bank.json; the suite validates them`);
  }
  const prods = menuProductsFor(topics);
  if (!prods.length) throw new Error(`no menu product matches topics "${topics.join(',')}" — check keep-asins.json topics`);
  const eligible = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\n/g, '\\n');
  const block = `  ${key}: {
    name: '${q(name)}',
    handle: '${q(handle)}',
    socialSetId: ${socialSetId || 0},${socialSetId ? '' : ' // TODO: --resolve could not reach Typefully; paste the id from the social-set URL'}
    niches: [${topics.map((t) => `'${t.trim()[0].toUpperCase()}${t.trim().slice(1)}'`).join(', ')}],
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-${key}',
    // NEW PAGES START PAUSED (owner, 2026-09-26). accounts-sync seeds the roster's Active box from
    // !paused once, when it creates the row on merge, so this keeps a new page Active=off and out of
    // /run until the owner ticks it after the warm-up. Drop it in the go-live PR.
    paused: true,
    // FUEL STAGING AS DATA (kit 2026-08-24): the hold date — the old "enable ~2 days after launch"
    // comment rule, made real. accounts-sync writes it to the roster; Fuel the Fire's Plan Watches
    // reads it (since 2026-09-03) and keeps the page out of the T1-T6 vendor ladder until it passes.
    // It does not gate T0: leave RT Row blank for that.
    fuelEligibleAfter: '${eligible}',
    defaultProduct: { asin: '${q(prods[0].asin)}', title: '${q(prods[0].title)}' },
    altProducts: [
${prods.slice(1).map((p) => `      { asin: '${q(p.asin)}', title: '${q(p.title)}' },`).join('\n') || '      // add 1-2 menu alternates for the fallback rotation'}
    ],
    voice: [
      '${q(niche || topics[0])} educator. Plain, specific, personally invested — never hypey.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Mechanism-driven: name the body system, then the simple fix.',
    ].join('\\n'),
    closing: \`${esc(picked.closing)}\`,
    disclaimer: \`${esc(picked.disclaimer)}\`,
    // TODO before first monetized thread: plugHeavyExample + plugLightExample in this voice
    // (copy the julian shape; the engine treats their absence as unmonetized).
  },`;
  return { block, picked, prods, eligible };
}

/** Everything wrong with one account entry — the same bars the fleet suite holds, callable per key. */
export function checkAccount(key, accounts = ACCOUNTS) {
  const a = accounts[key];
  if (!a) return [`no ACCOUNTS entry "${key}"`];
  const issues = [];
  if (!a.handle) issues.push('missing handle');
  if (!a.socialSetId) issues.push('socialSetId not set (Typefully OAuth pending)');
  if (a.levantaSubidPrefix && !/^x-thread-[a-z0-9-]+$/.test(a.levantaSubidPrefix)) issues.push(`levantaSubidPrefix "${a.levantaSubidPrefix}" breaks the x-thread-<key> convention`);
  if (a.disclaimer) {
    for (const [el, re] of Object.entries(DISC_ELEMENTS)) if (!re.test(a.disclaimer)) issues.push(`disclaimer missing ${el}`);
    if (a.disclaimer.length > 280) issues.push(`disclaimer ${a.disclaimer.length} chars (>280)`);
  } else if (a.levantaSubidPrefix) issues.push('monetized account with no disclaimer');
  if ((a.closing || '').length > 280) issues.push('closing over 280');
  for (const [k2, b] of Object.entries(accounts)) {
    if (k2 === key || !b.disclaimer) continue;
    const rc = a.closing && b.closing ? sharedWordRun(a.closing, b.closing) : null;
    if (rc) issues.push(`closing shares "${rc}" with ${k2}`);
    const rd = a.disclaimer ? sharedWordRun(a.disclaimer, b.disclaimer) : null;
    if (rd) issues.push(`disclaimer shares "${rd}" with ${k2}`);
  }
  if (a.defaultProduct && !ALLOW_ASINS.has(a.defaultProduct.asin)) issues.push(`default ${a.defaultProduct.asin} is not on the menu`);
  if (a.fuelEligibleAfter && isNaN(Date.parse(a.fuelEligibleAfter))) issues.push(`fuelEligibleAfter "${a.fuelEligibleAfter}" is not a date`);
  return issues;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await runMain(async () => {
    // --resolve on its own: "which social set is @handle, and is it free?" Safe to run any time.
    if (arg('resolve')) {
      const r = resolveHandle(arg('resolve'), await socialSets(loadEnv()));
      if (r.error) { console.log(`✗ ${r.error}`); process.exit(2); }
      const taken = takenSocialSetIds().get(String(r.socialSetId));
      console.log(`@${r.username} → socialSetId ${r.socialSetId}  (${r.displayName || 'no display name'}, team "${r.team}")`);
      if (r.warning) console.log(`  ⚠ ${r.warning}`);
      if (taken) console.log(`  ✗ ALREADY CLAIMED by accounts.mjs key "${taken}" — two accounts on one set means double generation, and the suite hard-fails it`);
      return;
    }

    if (process.argv.includes('--scaffold')) {
      const key = arg('key'), name = arg('name'), handle = arg('handle');
      const topics = String(arg('topics', '')).split(',').map((s) => s.trim()).filter(Boolean);
      if (!key || !name || !handle || !topics.length) throw new Error('need --key --name --handle --topics "sleep,stress"');
      if (ACCOUNTS[key]) throw new Error(`"${key}" already exists in accounts.mjs`);

      // Resolve the handle unless the caller pinned an id. Degrades to 0 with a TODO rather than
      // failing the whole scaffold — the boilerplate and product picks are worth having offline,
      // and --check will refuse the account later anyway ("socialSetId not set").
      let socialSetId = Number(arg('social-set-id', 0)) || 0;
      let resolveNote = socialSetId ? `pinned by --social-set-id` : null;
      if (!socialSetId) {
        try {
          const r = resolveHandle(handle, await socialSets(loadEnv()));
          if (r.error) resolveNote = `✗ ${r.error}`;
          else {
            socialSetId = r.socialSetId;
            resolveNote = `resolved @${r.username} → ${r.socialSetId} (team "${r.team}")${r.warning ? `\n  ⚠ ${r.warning}` : ''}`;
            const taken = takenSocialSetIds().get(String(socialSetId));
            if (taken) throw new Error(`social set ${socialSetId} already belongs to "${taken}" — two accounts on one set double-generates, and the suite hard-fails it`);
          }
        } catch (e) {
          if (/already belongs/.test(e.message)) throw e;
          resolveNote = `✗ could not reach Typefully (${String(e.message).slice(0, 70)})`;
        }
      }

      const { block, picked, prods, eligible } = scaffoldBlock({ key, name, handle, topics, niche: arg('niche'), socialSetId });
      console.log(`\n// ---- paste into accounts.mjs (then run --check ${key} and the suite) ----\n`);
      console.log(block);
      console.log(`\nsocial set: ${resolveNote}`);
      console.log(`bank remaining after this pick: ${picked.closersLeft - 1} closers · ${picked.disclaimersLeft - 1} disclaimers${picked.closersLeft <= 3 ? '  ⚠ REFILL SOON' : ''}`);
      console.log(`products from the menu (${topics.join(', ')}): ${prods.map((p) => p.asin).join(', ')}`);
      console.log(`paused: true — the roster row is created with Active OFF, so the page stays out of /run until the owner ticks it after the warm-up`);
      console.log(`fuel hold date ${eligible} (fuelEligibleAfter — synced to the roster; Fuel the Fire holds T1-T6 until it passes. T0 = RT Row, separately)`);
      console.log(`\nSTILL HUMAN (and staying that way):`);
      console.log(`  1. The X account itself: profile, avatar, bio, pinned post — and WARM it before any affiliate thread.`);
      console.log(`     A new account posting 3 plug threads a day is a ban magnet. This is the real risk step.`);
      console.log(`  2. Typefully queue slots set to the posting schedule.`);
      console.log(`  3. plugHeavyExample + plugLightExample in this account's voice — the engine reads their`);
      console.log(`     absence as unmonetized, so the account generates nothing sellable until they exist.`);
      console.log(`  4. Paste, run --check ${key} and node test-scaffolds.mjs, then open the PR.`);
      console.log(`     The Airtable roster row is created by accounts-sync ON MERGE, not before — so RT Row`);
      console.log(`     and the feature flags cannot be set until after it lands (they are create-only).`);
      return;
    }
    const key = arg('check');
    if (!key) throw new Error('usage: --resolve <handle> | --scaffold --key .. --name .. --handle .. --topics ".." [--social-set-id N] | --check <key>');
    const issues = checkAccount(key);
    if (!issues.length) { console.log(`✓ ${key}: clean — identity, boilerplate uniqueness, menu products, fuel staging all pass`); return; }
    console.log(`✗ ${key}: ${issues.length} issue(s)`);
    for (const i of issues) console.log(`  - ${i}`);
    process.exit(2);
  }, 'onboard-account');
}