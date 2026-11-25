#!/usr/bin/env node
// pot-gate.mjs — the greenhouse gate for a pot, in one run: the full publish gate as a garden would
// see it, the rhythm read, the hook-shape and family-device reads against the origin, and the DIALS
// TICKET every pot has carried since 2026-09-19.
//
//   node pot-gate.mjs queues/pots/mango-crossword.greenhouse.json [more files]
//   node pot-gate.mjs --all                     # every *.greenhouse.json under queues/pots
//   node pot-gate.mjs --all --family mango
//
// WHY THIS EXISTS. gate-thread refuses a spec without a garden ("unknown account null"), and a pot
// carries no garden by rule (pot/SKILL.md 2b) — so the 83 pots written before this file were gated
// by hand, one `checkThread` call at a time, and the three drifts the operator caught on 2026-09-18
// (free items collapsed into one domain, hooks naming a mechanism, item 1 a supplement) had all
// passed those hand checks. This gates a pot the way it will actually ship: julian's closing and
// disclaimer appended for the check (never written back), probe links in the {{LINK}} slots, and
// the reads pot-echo runs, so one command answers "can this leave the greenhouse".
//
// THE TICKET. `dials` is an array of { dial, from, to } — the dials this pot turned away from its
// seed's home cell. `[]` is a control. A pot without the key is refused: a ticket that is
// remembered instead of stamped is how beet's angle moved on 3 pots without anyone deciding to.
// Exit 1 on any gate error, any hard hook-shape/device finding, or a missing/invalid ticket.
// Rhythm findings are printed and counted but do not fail the run (they grade taste — pot-echo's
// ruling); the count is in the summary line so a writer cannot miss them.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE_DIR } from './lib.mjs';
import { getAccount, defaultAccountKey } from './accounts.mjs';
import { LAWS, closingTail } from './laws.mjs';
import { gateThread } from './gate-thread.mjs';
import { rhythmIssues, hookShapeIssue, hookDeviceIssue, bodyOverlap } from './checks.mjs';
import { pointFrameIssues } from './point-frame.mjs';

// THE DIAL VOCABULARY, and the one place it is written down.
//
// It used to be copied by hand into six files — this set, cells-sync's reporting list,
// farm-status's CELL_ORDER, seed-dials' COLS, airtable-schema's two `Dial` option lists and the
// scaffold fixtures — and cells-sync derived its single-dial columns with `DIALS.slice(1, 10)`, an
// index that silently drops whatever you append. Adding one dial meant six correct edits and a
// magic number; this makes it one.
//
// COLUMNED are the dials that get their own reporting column. `twist` deliberately does not: a lone
// twist reads as a pair cell, which is why it is added here and not there.
//
// `cta` ADDED 2026-09-19 (operator: "add a rule where you can improve and tweak cta flow for
// harvest and especially also the seeds"). A pot's plug is already written fresh each time rather
// than frozen by the seed, so nothing stopped an author varying the CTA — what was missing was a
// way to turn it ON PURPOSE and have the 48h read attributed to it. Without a dial, a varied CTA is
// indistinguishable from drift, and the cell grid counts it as a control. With one it is an
// experiment like any other: declare `{ dial: 'cta', from, to }` and the pot lands in its own cell.
export const COLUMNED = ['authority', 'topic', 'solution', 'angle', 'count', 'audience', 'direction', 'narrator', 'substance', 'cta'];
export const DIALS = new Set([...COLUMNED, 'twist']);
export const MAX_DIALS = 2;
const STAND_IN_GARDEN = defaultAccountKey();

/** PURE. The ticket's own rules: present, an array, ≤ MAX_DIALS entries, each a known dial with
 *  from/to strings, no dial twice. Returns [] when the ticket is valid. */
export function ticketIssues(spec = {}) {
  const out = [];
  if (!Array.isArray(spec.dials)) return ['no `dials` ticket — `[]` for a control, else [{ dial, from, to }]'];
  if (spec.dials.length > MAX_DIALS) out.push(`${spec.dials.length} dials turned — the cap is ${MAX_DIALS}; 3 is a new dish (seed-mint, not a pot)`);
  const seen = new Set();
  for (const d of spec.dials) {
    if (!d || typeof d !== 'object') { out.push('a ticket entry is not an object'); continue; }
    if (!DIALS.has(d.dial)) out.push(`unknown dial "${d.dial}" — one of ${[...DIALS].join(', ')}`);
    if (seen.has(d.dial)) out.push(`dial "${d.dial}" listed twice`);
    seen.add(d.dial);
    if (!d.from || !d.to) out.push(`dial "${d.dial}" needs both from and to`);
  }
  return out;
}

/** PURE. A COVER-POT's ticket (laws.json farm.$coverAsPot, owner 2026-10-12): the pot ticket's own
 *  rules, plus at least `minDials` turned (0 by default: `[]` is the control, the donor's hook shape
 *  with new items, exactly as for a seed). Returns [] when the law is off or the ticket is valid. */
export function coverTicketIssues(spec = {}, coverAsPot = LAWS.farm?.coverAsPot) {
  if (!coverAsPot?.on) return [];
  const out = ticketIssues(spec);
  const min = Number(coverAsPot.minDials ?? 0);
  if (Array.isArray(spec.dials) && spec.dials.length < min) out.push(`a cover is written as a pot of its donor and turns at least ${min} dial${min === 1 ? '' : 's'} (laws.json farm.coverAsPot)`);
  return out;
}

/** PURE. A COVER-POT's body against its donor's (laws.json farm.$coverBodyMax, owner 2026-10-12): the
 *  items are new, so tweet 2 onward may share at most `bodyMax` of the donor's word-4-grams, read in
 *  both directions. Returns [] when the law is off or the body is new; one issue when it is not, or
 *  when there is no donor body to read against. */
export function coverBodyIssues(tweets = [], donorTweets = [], coverAsPot = LAWS.farm?.coverAsPot) {
  const max = Number(coverAsPot?.bodyMax);
  if (!coverAsPot?.on || !Number.isFinite(max)) return [];
  const ours = (tweets || []).slice(1).map(String), theirs = (donorTweets || []).slice(1).map(String);
  if (!theirs.length) return ['no donor body to read against, so the new-items check cannot run'];
  const overlap = Math.max(bodyOverlap(ours, theirs), bodyOverlap(theirs, ours));
  return overlap > max ? [`body shares ${Math.round(overlap * 100)}% with the donor's (max ${Math.round(max * 100)}%): the items are the donor's, write new ones into its skeleton (laws.json farm.coverAsPot.bodyMax)`] : [];
}

/** The whole read for one spec. PURE apart from the origin cache lookup. A COVER-POT (lane "cover")
 *  is read against its donor: no potOf or Seeds row, since the donor's seed is never named. */
export function gatePot(spec, { origin = null } = {}) {
  const findings = { errors: [], hard: [], advisory: [], rhythm: [] };
  const coverPot = spec.lane === 'cover';
  for (const t of coverPot ? coverTicketIssues(spec) : ticketIssues(spec)) findings.errors.push(`ticket: ${t}`);
  if (coverPot) { if (!spec.recId) findings.errors.push('no recId — a cover-pot names its donor'); }
  else {
    if (!spec.potOf) findings.errors.push('no potOf — a pot names its seed');
    if (!spec.seedRecId) findings.errors.push('no seedRecId — a pot links its Seeds row');
  }
  if (coverPot) for (const b of coverBodyIssues(spec.tweets, origin || [])) findings.errors.push(`body: ${b}`);

  const garden = getAccount(spec.account || STAND_IN_GARDEN);
  const tweets = [...(spec.tweets || []).map((t) => String(t ?? ''))];
  // A greenhouse pot legitimately ends on its last body beat; the garden appends these at plant
  // (write-day, the same closingTail: the disclaimer, plus the sign-off only while laws.json signOff is on).
  const gated = [...tweets, ...closingTail(garden)];
  const g = gateThread({ ...spec, account: garden.key || spec.account || STAND_IN_GARDEN, tweets: gated });
  if (g.fatal) findings.errors.push(g.fatal);
  for (const i of g.issues || []) findings.errors.push(typeof i === 'string' ? i : (i.msg || JSON.stringify(i)));

  for (const r of rhythmIssues(tweets, null) || []) findings.rhythm.push(r.msg ? `T${r.tweet ?? '?'}: ${r.msg}` : String(r));
  if (origin) {
    // A prefix frame (authority or narrator turned on: "According to X:", "I tell everyone this:")
    // sits on its own line above a multi-line hook, so every origin line shifts down by one and a
    // line-for-line read fires on all of them. When the TICKET names that move and the hook is
    // exactly one line longer, the shape is read with the prefix line removed — the read the
    // page promised ("expected, and the ticket says why"). Any other length change stays hard.
    let shapeTweets = tweets;
    const prefixed = (spec.dials || []).some((d) => d && ['authority', 'narrator'].includes(d.dial));
    const mine = String(tweets[0] || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const theirs = String(origin[0] || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (prefixed && mine.length === theirs.length + 1) {
      shapeTweets = [mine.slice(1).join('\n\n'), ...tweets.slice(1)];
      findings.advisory.push(`hook shape: read with the ticket's prefix line removed ("${mine[0].slice(0, 40)}")`);
    }
    for (const s of hookShapeIssue(shapeTweets, origin) || []) (s.advisory ? findings.advisory : findings.hard).push(`hook shape: ${s.msg}`);
  }
  for (const d of hookDeviceIssue(tweets, spec.potOf || null) || []) (d.advisory ? findings.advisory : findings.hard).push(`device: ${d.msg}`);
  // The CTA points wear the list's own numbering and name their product (owner 2026-11-19, point-frame.mjs).
  for (const f of pointFrameIssues(tweets)) findings.hard.push(`point frame: T${f.tweet}: ${f.msg}`);

  const ok = findings.errors.length === 0 && findings.hard.length === 0;
  return { ok, plugsAt: g.plugsAt || [], tweets: tweets.length, ...findings };
}

function loadOrigin(seedRecId) {
  const p = join(HERE_DIR, 'queues', 'origins', `${seedRecId}.json`);
  if (!seedRecId || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).tweets || null; } catch { return null; }
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const fi = argv.indexOf('--family');
  const family = fi > -1 ? argv[fi + 1] : null;
  let files = argv.filter((a) => a.endsWith('.json'));
  if (all) {
    const dir = join(HERE_DIR, 'queues', 'pots');
    files = readdirSync(dir).filter((f) => f.endsWith('.greenhouse.json')).map((f) => join(dir, f));
  }
  if (family) files = files.filter((f) => f.split('/').pop().startsWith(`${family}-`));
  if (!files.length) { console.error('need one or more pot files, or --all'); process.exitCode = 2; return; }

  let bad = 0, rhythmTotal = 0;
  for (const f of files) {
    let spec;
    try { spec = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.log(`✗ ${f}: ${e.message}`); bad++; continue; }
    const origin = spec.lane === 'cover' ? (Array.isArray(spec.donorTweets) && spec.donorTweets.length ? spec.donorTweets : loadOrigin(spec.recId)) : loadOrigin(spec.seedRecId);
    const r = gatePot(spec, { origin });
    const name = f.split('/').pop().replace('.greenhouse.json', '');
    const ticket = Array.isArray(spec.dials) ? (spec.dials.length ? spec.dials.map((d) => `${d.dial}: ${d.from} → ${d.to}`).join(' · ') : 'control') : 'NO TICKET';
    rhythmTotal += r.rhythm.length;
    console.log(`${r.ok ? '✓' : '✗'} ${name} · ${r.tweets} tweets · plugs at ${r.plugsAt.map((n) => `T${n}`).join(', ') || 'none'} · ${ticket}${r.rhythm.length ? ` · ${r.rhythm.length} rhythm` : ''}`);
    for (const e of r.errors) console.log(`    error    ${e}`);
    for (const h of r.hard) console.log(`    hard     ${h}`);
    for (const a of r.advisory) console.log(`    advisory ${a}`);
    for (const m of r.rhythm) console.log(`    rhythm   ${m}`);
    if (!r.ok) bad++;
  }
  console.log(`\n${files.length - bad} of ${files.length} pot(s) clear the greenhouse gate${rhythmTotal ? ` · ${rhythmTotal} rhythm finding(s) to read` : ''}`);
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
