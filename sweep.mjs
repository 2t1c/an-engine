#!/usr/bin/env node
// sweep.mjs — every checklist the fleet has, run once, in cost order.
//
// The checks all existed; nothing ran them together. ci.yml chains four OFFLINE checks, preflight
// gives a GO/NO-GO over the donor pool only, and the fleet-wide audits were each invoked by hand,
// per account, when someone remembered. So the fleet's actual state was never anybody's single
// question — which is how 22 threads shipped hand-written CTAs on 2026-08-30 while 21 measured
// pods sat unused, and how the harvest lane went quiet for days without anyone noticing.
//
//   node sweep.mjs                 # the whole sweep, human report
//   node sweep.mjs --json          # machine-readable; the human report is REPLACED
//   node sweep.mjs --dry           # zero writes: no logs/ file, no queue file, no Telegram
//   node sweep.mjs --loud          # Telegram even when clean (the manual escape hatch)
//   node sweep.mjs --no-alert      # write the log + findings file, send no Telegram
//   node sweep.mjs --alert-critical  # Telegram only when a finding is critical (the scheduled run)
//   node sweep.mjs --slow          # include audit-archive, the craft pass (minutes, not seconds)
//   node sweep.mjs --days 3        # how far forward verify-day looks (default 3)
//
// THREE THINGS THIS FILE EXISTS TO NORMALIZE, each of which will bite anyone who skips them:
//
//   1. EXIT CODES ARE UNRELIABLE. Only 4 of the 11 audits signal findings through exit status.
//      The rest exit 0 no matter what they find — link-sentinel exits 0 after logging "dead link
//      AND unschedule FAILED — publishes UNLESS FIXED BY HAND". Keying off exit status alone
//      misses most real problems, so every step below declares how to READ its output.
//   2. --json MEANS FOUR DIFFERENT THINGS. It REPLACES stdout (audit-drafts, preflight,
//      verify-day), APPENDS after the human text (cta-audit, check-links), TAKES A PATH and
//      writes a file (audit-archive), or does not exist (integrity-sentinel, tracking-smoke).
//      `parse` below says which, per step.
//   3. --account MEANS THREE DIFFERENT THINGS. Display-name substring (audit-drafts), exact
//      lowercase key (audit-archive, check-links), either (preflight), or getAccount which THROWS
//      (audit-account-links). A loop passing one key everywhere breaks.
//
// A step that does not COMPLETE is reported as unchecked, never as passing. needs-you.mjs states
// the rule this follows: absence of evidence is not evidence of absence, and on a money pipeline
// that distinction is the whole game.
//
// Ranking is NOT re-invented here. SEVERITY_RANK comes from needs-you.mjs, which declares itself
// the single source of truth for "something needs a human right now"; the draft tiers come from
// audit-drafts. A second ranking is how the brief and the dashboard once disagreed in public.
import { farmPcRows } from './farm-status.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, typefully, runMain, logRun, telegram, report, esc, HERE_DIR } from './lib.mjs';
import { SEVERITY_RANK } from './needs-you.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { LAWS } from './laws.mjs';
import { REGISTRY_TABLE } from './config.mjs';
import { findBreakouts, harvestCount, harvestRows, MAX_VARIATIONS } from './harvest.mjs';
import { resolveProducts } from './cta-audit.mjs';
import { selectPod } from './outline.mjs';
import { isTrackedLink } from './checks.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');
const DRY = process.argv.includes('--dry');
const LOUD = process.argv.includes('--loud');
const SLOW = process.argv.includes('--slow');
// Write the artifacts, skip the notification. --dry writes nothing at all, which makes the write
// path itself untestable without pinging the operator's phone; this is the seam between them.
const NO_ALERT = process.argv.includes('--no-alert');
// The daily scheduled sweep (owner, 2026-10-06) pages only for critical findings; warnings stay in the log.
const CRITICAL_ONLY = process.argv.includes('--alert-critical');
const DAYS = Math.max(1, Math.min(7, Number(arg('days', 3)) || 3));
const STEP_TIMEOUT_MS = Math.max(30, Number(arg('timeout', 300)) || 300) * 1000;

/** Findings share needs-you's item shape so the two lists can be merged rather than reconciled. */
const F = (severity, source, title, detail, action) => ({ severity, source, title, detail, action });
const bySeverity = (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);

/** Run a repo script, capture both streams, never let one hang the sweep. Returns
 *  { code, stdout, stderr, timedOut, ms }. A non-zero code is DATA, not an error: most of these
 *  scripts exit 1 by design when they find something. */
function run(script, args = [], { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [join(HERE_DIR, script), ...args], { cwd: HERE_DIR });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - t0 });
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e.message), timedOut, ms: Date.now() - t0 }); });
  });
}

/**
 * The JSON payload on stdout, whichever of the two conventions produced it.
 *
 * Both traps here have already been hit. Anchoring on the FIRST '[' finds a nested empty array
 * inside an object payload ("twice": []) which parses cleanly as [] and reports every check as
 * having found nothing. Anchoring on the first bracket of either kind then finds "[Infinity]" in
 * check-links' own draft TITLES, because the append convention prints a human table first and that
 * table contains arbitrary text.
 *
 * So: consider only starts at column 0 (console.log(JSON.stringify(...)) always begins a line),
 * try them EARLIEST first, and at each one allow a few trailing human lines to be trimmed —
 * check-links prints "N broken link(s)" AFTER its payload. Earliest-first matters: the first start
 * that parses is the OUTERMOST value, so a nested object that happens to land at column 0 can
 * never be returned in place of the payload that contains it. "[Infinity] header" simply fails to
 * parse and the scan moves on. Returns null rather than throwing — an unparseable payload is a
 * finding, and the caller decides how loud.
 */
export function lastJson(stdout) {
  const s = String(stdout);
  // Payloads come from console.log(JSON.stringify(...)), so they always begin a line.
  const starts = [];
  if (/^\s*[[{]/.test(s)) starts.push(s.search(/[[{]/));
  for (let i = 0; i < s.length; i++) if (s[i] === '\n' && (s[i + 1] === '[' || s[i + 1] === '{')) starts.push(i + 1);
  for (let si = 0; si < starts.length; si++) {
    const from = s.slice(starts[si]);
    // Try the whole tail, then progressively drop trailing lines (bounded: a human footer is short).
    const tail = from.split('\n');
    for (let drop = 0; drop <= Math.min(40, tail.length - 1); drop++) {
      const slice = tail.slice(0, tail.length - drop).join('\n').trim();
      if (!slice.endsWith(']') && !slice.endsWith('}')) continue;
      try { return JSON.parse(slice); } catch { /* keep trimming */ }
    }
  }
  return null;
}

const ymdSaigon = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const daysAhead = (n) => Array.from({ length: n }, (_, i) => ymdSaigon(new Date(Date.now() + i * 864e5)));

// ---- the subprocess steps, cheapest and safest first ------------------------------------------
// Order matters: fail fast, and put the expensive one last. `read` turns one run into findings —
// it is the per-script knowledge that makes the three uneven interfaces above survivable.

const monetized = Object.entries(ACCOUNTS).filter(([, a]) => a.plugHeavyExample && !a.paused).map(([k]) => k);

const STEPS = [
  {
    id: 'tracking',
    label: 'tracking smoke (static)',
    // The purest gate in the repo: it returns before loadEnv() is ever called, so it needs no
    // secrets and touches no network. First for exactly that reason.
    runs: () => [['tracking-smoke.mjs', ['--static']]],
    read: ([r]) => {
      const m = r.stdout.match(/static:\s*(\d+)\s*failure\(s\),\s*(\d+)\s*warning\(s\)/);
      if (!m) return { summary: 'no verdict line', findings: [F('warn', 'tracking', 'tracking-smoke printed no verdict', 'The "static: N failure(s)" line is missing, so the result could not be read.', 'node tracking-smoke.mjs --static')] };
      const [, fail, warn] = m.map(Number);
      const out = [];
      if (fail) out.push(F('critical', 'tracking', `${fail} tracking failure(s)`, 'Link attribution is broken at the shape level: clicks we pay for earn nothing.', 'node tracking-smoke.mjs --static'));
      if (warn) out.push(F('info', 'tracking', `${warn} tracking warning(s)`, 'Attribution shape drifted but nothing is provably lost yet.', 'node tracking-smoke.mjs --static'));
      return { summary: `${fail} failure(s), ${warn} warning(s)`, findings: out };
    },
  },
  {
    id: 'days',
    label: `verify-day × ${DAYS}`,
    // --json REPLACES stdout here (added 2026-08-31 for this caller). Read `dirty`, not the code.
    runs: () => daysAhead(DAYS).map((d) => [`verify-day.mjs`, [d, '--json']]),
    read: (rs) => {
      const out = []; const bits = [];
      for (const r of rs) {
        const day = r.args[0];
        const j = lastJson(r.stdout);
        if (!j) { out.push(F('warn', 'day', `${day} could not be read`, `verify-day exited ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''} with no parseable payload.`, `node verify-day.mjs ${day}`)); continue; }
        bits.push(`${day}: ${j.posts} post(s)${j.dirty ? ' ✗' : ''}`);
        for (const row of j.rows || []) for (const n of row.notes || []) {
          out.push(F('critical', 'day', `${row.account} ${day} ${row.saigon} — ${n.replace(/\*/g, '').trim()}`, `Draft ${row.id}, ${row.tweets} tweet(s), ${row.links} link(s).`, `node verify-day.mjs ${day}`));
        }
        for (const t of j.twice || []) out.push(F('critical', 'day', `${t.account} posts ${t.posts}× on ${day}`, 'One post per account per lane per day is the standing rule.', `node verify-day.mjs ${day}`));
        if ((j.minuteClash || []).length) out.push(F('warn', 'day', `minute clash on ${day}`, `Two accounts share ${j.minuteClash.join(', ')} — the fleet posts in lockstep and reads as automation.`, `node schedule-day.mjs ${day}`));
      }
      return { summary: bits.join(' · ') || 'no days read', findings: out };
    },
  },
  {
    id: 'preflight',
    label: 'preflight (can we write today)',
    // --json REPLACES stdout. `go` is the verdict; `problems` is already human-worded.
    runs: () => [['preflight.mjs', ['--json']]],
    read: ([r]) => {
      const j = lastJson(r.stdout);
      if (!j) return { summary: 'unreadable', findings: [F('warn', 'preflight', 'preflight produced no payload', `Exited ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''}.`, 'node preflight.mjs')] };
      const out = (j.problems || []).map((p) => F('warn', 'preflight', p, `Donor pool: ${j.pool?.usable ?? '?'} usable of ${j.pool?.raw ?? '?'} raw.`, 'node preflight.mjs'));
      return { summary: j.go ? '✓ GO' : `✗ NO-GO — ${(j.problems || []).length} problem(s)`, findings: out };
    },
  },
  {
    id: 'legality',
    label: 'audit-drafts (is the queue legal)',
    // --json REPLACES stdout: [{account, drafts:[{id,tier,blockers,degraded,...}], failed:[]}]
    runs: () => [['audit-drafts.mjs', ['--json']]],
    read: ([r]) => {
      const j = lastJson(r.stdout);
      if (!Array.isArray(j)) return { summary: 'unreadable', findings: [F('critical', 'legality', 'audit-drafts produced no payload', `Exited ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''} — the whole live queue went unchecked for legality.`, 'node audit-drafts.mjs')] };
      const out = []; let clean = 0, degraded = 0, blocked = 0, audited = 0;
      for (const a of j) {
        for (const d of a.drafts || []) {
          audited++;
          if (d.tier === 'BLOCKER') { blocked++; out.push(F('critical', 'legality', `${a.account} draft ${d.id} must not post`, (d.blockers || []).join(' · ') || 'blocked', `node gate-thread.mjs --draft ${d.id}`)); }
          else if (d.tier === 'DEGRADED') { degraded++; out.push(F('warn', 'legality', `${a.account} draft ${d.id} leaves money on the table`, (d.degraded || []).join(' · ') || 'degraded', `node cta-audit.mjs --draft ${d.id}`)); }
          else clean++;
        }
        if ((a.failed || []).length) out.push(F('warn', 'legality', `${a.account}: ${a.failed.length} draft(s) unreadable`, `ids ${a.failed.map((f) => f.id).join(', ')} — unchecked, not clean.`, 'node audit-drafts.mjs'));
      }
      return { summary: `${audited} audited · ${clean} clean · ${degraded} degraded · ${blocked} blocked`, findings: out, extra: { audited, clean, degraded, blocked, accounts: j } };
    },
  },
  {
    id: 'links',
    label: `check-links × ${monetized.length} accounts`,
    // --account takes the EXACT lowercase key here. --json APPENDS after the human text, so the
    // payload has to be dug out of stdout rather than parsed whole. Serial on purpose: this step
    // follows every redirect for real, landing on Levanta and Amazon.
    runs: () => monetized.map((k) => ['check-links.mjs', ['--account', k, '--json']]),
    serial: true,
    read: (rs) => {
      const out = []; let checked = 0, broken = 0;
      for (const r of rs) {
        const key = r.args[1];
        const j = lastJson(r.stdout);
        if (!Array.isArray(j)) { out.push(F('warn', 'links', `${key}: links unchecked`, `check-links exited ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''} with no payload.`, `node check-links.mjs --account ${key}`)); continue; }
        for (const rep of j) {
          checked++;
          // The failure condition is check-links' own, verbatim (its print() line 143): a link
          // that never resolved, one that lands on a DIFFERENT asin than the ledger records, or
          // one carrying trailing punctuation — the one-character truncation this tool was built
          // for returned HTTP 200 and landed on the amazon.com homepage.
          for (const f of rep.findings || []) {
            if (f.ok && !f.mismatch && !f.trailingJunk) continue;
            broken++;
            const why = !f.ok ? (f.why || 'never resolved')
              : f.mismatch ? `lands on ${f.asin} but the ledger sells ${f.expectedAsin}`
                : 'trailing punctuation is inside the link';
            out.push(F('critical', 'links', `${rep.account} draft ${rep.draftId} tweet ${f.tweet} — ${why}`, `${f.url} → ${(f.final || '(never resolved)').slice(0, 96)}`, `node check-links.mjs --draft ${rep.draftId}`));
          }
        }
      }
      return { summary: `${checked} draft(s) followed · ${broken} bad link(s)`, findings: out };
    },
  },
  {
    id: 'integrity',
    label: 'integrity-sentinel (--dry)',
    // No --json at all. --dry means no Telegram, but note it still writes a logs/ file and an Ops
    // canary row, so it is not literally zero-write; nothing it writes is fleet state.
    runs: () => [['integrity-sentinel.mjs', ['--dry']]],
    read: ([r]) => {
      const lines = r.stdout.split('\n');
      const breaches = lines.filter((l) => /BREACH|✗|FAIL(ED)?\b/.test(l) && !/0 breach/i.test(l));
      if (r.timedOut) return { summary: 'TIMED OUT', findings: [F('warn', 'integrity', 'integrity-sentinel did not finish', 'The four data guarantees went unchecked this sweep.', 'node integrity-sentinel.mjs --dry')] };
      return {
        summary: breaches.length ? `${breaches.length} breach line(s)` : 'no breach',
        findings: breaches.slice(0, 8).map((l) => F('warn', 'integrity', l.trim().slice(0, 120), 'One of the four standing data guarantees is not holding.', 'node integrity-sentinel.mjs --dry')),
      };
    },
  },
  {
    id: 'craft',
    label: 'audit-archive (craft base rates)',
    slow: true, // --slow only: minutes, and it judges rather than gates
    // --json here TAKES A PATH and writes a file; omitting the path silently writes nothing. So
    // this step reads the human summary instead, which is the honest option.
    runs: () => [['audit-archive.mjs', []]],
    read: ([r]) => {
      const tail = r.stdout.trim().split('\n').slice(-12).join('\n');
      return { summary: r.timedOut ? 'TIMED OUT' : 'see report', findings: [], extra: { tail } };
    },
  },
];

// ---- in-process checks: things no existing script asks ----------------------------------------

/** Is the harvest lane actually running? The funnel is cover (widest, from the public) → harvest
 *  (doubling down on what works) → seed. Cover has been healthy for months; harvest has repeatedly
 *  gone quiet for days at a time with SEVENTY-ONE proven winners sitting unused, because nothing
 *  ever said so out loud. Supply has never been the constraint here — attention is, so this is the
 *  cheapest possible thing that makes the gap visible on a schedule.
 *
 *  Pure functions only: findBreakouts and harvestCount are harvest.mjs's own, so this cannot drift
 *  from what `node harvest.mjs` would decide. harvest.mjs itself is never invoked — it WRITES spec
 *  files, and a read-only sweep must not call an actor. */
async function harvestSupply(env) {
  const H = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  // LIFETIME, not windowed (2026-09-02). `Link Clicks` is MAX(Typefully, Levanta) — Typefully counts
  // every link in the thread, not just the affiliate hop — and both windowed columns decay to zero
  // past the 59-day Levanta range. An audit that reads decaying numbers reports a fleet that is
  // quietly losing money it never lost. Same field preference harvest-gate.mjs already uses.
  const fields = ['Type', 'Post', 'Account', 'Draft ID', 'Impressions', 'Lifetime Clicks', 'Affiliate Clicks', 'Lifetime Commission', 'Commission', 'Posted Date'];
  let recs = [], offset;
  do {
    const p = new URLSearchParams({ pageSize: '100' });
    if (offset) p.set('offset', offset);
    p.set('filterByFormula', 'AND(OR({Status}="Posted",{Status}="Reposted",{Status}="Winner",{Status}="Repost Candidate"), {Impressions}>0)');
    fields.forEach((f) => p.append('fields[]', f));
    const r = await fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(REGISTRY_TABLE)}?${p}`, { headers: H });
    const d = await r.json();
    if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 160));
    recs.push(...d.records); offset = d.offset;
  } while (offset);

  // harvest.mjs's own rows (threads only: an article is never a harvestable winner).
  const rows = harvestRows(recs);

  const led = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const breakouts = findBreakouts(rows, { minViews: LAWS.scale.breakoutViews });
  const atMax = breakouts.filter((b) => harvestCount(led, b.draftId) >= MAX_VARIATIONS).length;
  const specDir = join(HERE_DIR, 'queues', 'harvest');
  const specs = existsSync(specDir) ? readdirSync(specDir).filter((f) => f.endsWith('.json')) : [];
  const shipped = led.filter((e) => e.harvestOf);
  // ts is the ledger's timestamp key; `at` does not exist on these rows. And never Date.parse(x || 0):
  // the 0 coerces to the string '0', which V8 parses as the year 2000 rather than failing, so a
  // missing timestamp reads as a real date 26 years stale. Filter first, parse second.
  const lastAt = shipped.map((e) => Date.parse(e.ts || e.at || '')).filter((n) => Number.isFinite(n)).sort((a, b) => b - a)[0] || 0;
  const daysQuiet = lastAt ? Math.floor((Date.now() - lastAt) / 864e5) : null;
  const built = new Set(shipped.map((e) => String(e.harvestOf)));
  const unbuilt = specs.filter((f) => !built.has(f.replace(/\.json$/, ''))).length;

  const findings = [];
  // Two different questions, and only the first is about recency. Three days is one full cover
  // cycle; past that the lane is not slow, it is stopped.
  if (daysQuiet === null || daysQuiet >= 3) {
    findings.push(F('warn', 'harvest',
      daysQuiet === null ? 'no harvest has EVER shipped' : `no harvest shipped in ${daysQuiet} day(s)`,
      `${breakouts.length - atMax} proven winner(s) are still harvestable and ${unbuilt} emitted spec(s) were never built.`,
      'node harvest.mjs   # emits specs, then harvest-build.mjs <parentId>'));
  }
  // The standing one. A quiet day is normal; a permanent backlog of emitted-but-unbuilt specs is
  // the lane silting up, and it stays true whether or not something shipped this week.
  if (unbuilt >= 10) {
    findings.push(F('info', 'harvest', `${unbuilt} harvest spec(s) emitted and never built`,
      `${breakouts.length - atMax} of ${breakouts.length} breakout(s) are still harvestable. Supply is not the constraint here; attention is.`,
      'node harvest-build.mjs <parentId>   # ls queues/harvest'));
  }
  return {
    findings,
    stats: { breakouts: breakouts.length, atMax, harvestable: breakouts.length - atMax, specs: specs.length, unbuilt, shipped: shipped.length, daysQuiet },
    summary: `${breakouts.length - atMax} harvestable · ${unbuilt} spec(s) unbuilt · ${shipped.length} ever shipped · ${daysQuiet === null ? 'never' : `${daysQuiet}d`} since the last`,
  };
}

/** The farm's three standing integrity questions (2026-09-02), pure so tests pin them:
 *  hearts overspend (more attempts linked than farm.hearts — a link error or a rule breach),
 *  cooldown violations (one body posted twice fleet-wide inside farm.cooldownHours), and
 *  orphaned farm state (a verdict-carrying PC row no Harvest/Seed link or ledger parent can
 *  explain — the gate cannot count it, so a heart or a pot chance is silently lost). */
export function farmAudit({ harvests = [], pcRows = [], ledgerRows = [], now = Date.now(), farm = LAWS.farm } = {}) {
  const findings = [];
  const attemptsPerHarvest = new Map();
  for (const r of pcRows) for (const hid of r.harvestIds || []) attemptsPerHarvest.set(hid, (attemptsPerHarvest.get(hid) || 0) + 1);
  for (const h of harvests) {
    const n = attemptsPerHarvest.get(h.id) || 0;
    if (n > farm.hearts) findings.push(F('warn', 'farm', `hearts overspent on "${String(h.fields?.Body || h.id).slice(0, 40)}"`,
      `${n} attempts linked where the law allows ${farm.hearts} — either a mislinked row or the cooldown/allocator let an extra heart through.`,
      'inspect the Harvests row and its Attempts links in Airtable'));
  }
  // The cooldown is about when a body POSTS, so an attempt counts at its publishAt; `ts` (when the
  // draft was created) is the fallback for rows that never carried a schedule. Measured on `ts`
  // alone, a batch of attempts created in one sitting for four different evenings read as nine
  // "violations" 0.0-9.5h apart on 2026-09-07 while every pair was ≥24h apart on the calendar.
  const bySource = new Map();
  for (const e of ledgerRows) {
    if (!e?.sourceDraftId || !(e.publishAt || e.ts)) continue;
    const k = String(e.sourceDraftId);
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(Date.parse(e.publishAt || e.ts));
  }
  for (const [src, times] of bySource) {
    const t = times.filter(Number.isFinite).sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) {
      if (t[i] - t[i - 1] < farm.cooldownHours * 3600e3) {
        findings.push(F('warn', 'farm', `cooldown violated on body ${src}`,
          `two reposts of the same body ${((t[i] - t[i - 1]) / 3600e3).toFixed(1)}h apart — the law is ${farm.cooldownHours}h fleet-wide (republish --force-cooldown leaves this trail deliberately).`,
          'check the two ledger rows for this sourceDraftId; if neither was operator-forced, the allocator has a hole'));
        break;
      }
    }
  }
  const parented = new Set(ledgerRows.filter((e) => e?.sourceDraftId || e?.harvestOf || e?.potOf).map((e) => String(e.draftId)));
  const orphans = pcRows.filter((r) => r.verdict && !(r.harvestIds || []).length && !(r.seedIds || []).length && !parented.has(String(r.draftId)));
  if (orphans.length) findings.push(F('warn', 'farm', `${orphans.length} verdict-carrying row(s) with no farm parent`,
    `Attempt Verdict is set but no Harvest/Seed link or ledger parent explains it — the gate cannot count these toward any body or seed: ${orphans.slice(0, 3).map((r) => r.draftId).join(', ')}${orphans.length > 3 ? '…' : ''}`,
    'link the row to its Harvest/Seed in Airtable, or clear the stray verdict'));
  return { findings, stats: { bodies: harvests.length, cooldownPairs: bySource.size, orphans: orphans.length } };
}

/** Live wrapper for farmAudit — reads the three sources and hands them to the pure check. */
async function farmIntegrity(env) {
  const H = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const list = async (table, fields) => {
    let recs = [], offset;
    do {
      const p = new URLSearchParams({ pageSize: '100' });
      if (offset) p.set('offset', offset);
      (fields || []).forEach((f) => p.append('fields[]', f));
      const r = await fetch(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(table)}?${p}`, { headers: H });
      const d = await r.json();
      if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 160));
      recs.push(...d.records); offset = d.offset;
    } while (offset);
    return recs;
  };
  const harvests = await list('Harvests', ['Body', 'Status', 'Origin Draft ID']);
  const pc = await list(REGISTRY_TABLE, ['Type', 'Post', 'Draft ID', 'Harvest', 'Seed', 'Attempt Verdict']);
  // The farm's own rows (farm-status farmPcRows: threads only, so an article is never an attempt on a body).
  const pcRows = farmPcRows(pc).filter((r) => r.draftId);
  const ledgerRows = readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const out = farmAudit({ harvests, pcRows, ledgerRows });
  return { ...out, summary: `${out.stats.bodies} body(ies) · ${out.findings.length} finding(s)` };
}

// ---- the driver -------------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const t0 = Date.now();
  const steps = [];
  const findings = [];
  let harvest = null;

  for (const step of STEPS) {
    if (step.slow && !SLOW) { steps.push({ id: step.id, label: step.label, skipped: 'slow — pass --slow to include' }); continue; }
    const jobs = step.runs();
    const results = [];
    if (step.serial) {
      // Serial, not parallel: this step follows redirects for real and lands on Levanta and
      // Amazon. Eleven accounts fired at once is a burst neither of them owes us a reply to.
      for (const [script, args] of jobs) results.push({ ...(await run(script, args)), script, args });
    } else {
      results.push(...await Promise.all(jobs.map(async ([script, args]) => ({ ...(await run(script, args)), script, args }))));
    }
    let readOut;
    try { readOut = step.read(results); } catch (e) { readOut = { summary: `read failed: ${e.message}`, findings: [F('warn', step.id, `${step.label}: output could not be interpreted`, String(e.message).slice(0, 160), `node ${jobs[0]?.[0] || step.id}`)] }; }
    // A step that never finished is UNCHECKED, not clean. needs-you.mjs states the rule: absence
    // of evidence is not evidence of absence, and a sweep that quietly downgrades a timeout to a
    // pass is worse than no sweep, because it is believed.
    for (const r of results) {
      if (!r.timedOut) continue;
      readOut.findings.push(F('warn', step.id, `${step.label} timed out after ${Math.round(STEP_TIMEOUT_MS / 1000)}s`, `${r.script} ${r.args.join(' ')} was killed — treat this area as UNCHECKED.`, `node ${r.script} ${r.args.join(' ')}`));
    }
    findings.push(...readOut.findings);
    steps.push({ id: step.id, label: step.label, summary: readOut.summary, ms: results.reduce((n, r) => n + r.ms, 0), runs: results.length, findings: readOut.findings.length, extra: readOut.extra });
  }

  // The funnel check is last because it is the only one that talks about a lane rather than a draft.
  if (env.AIRTABLE_PAT && env.REGISTRY_BASE_ID) {
    try {
      harvest = await harvestSupply(env);
      findings.push(...harvest.findings);
      steps.push({ id: 'harvest', label: 'harvest supply', summary: harvest.summary, findings: harvest.findings.length });
    } catch (e) {
      findings.push(F('info', 'harvest', 'harvest supply unchecked', String(e.message).slice(0, 160), 'node harvest.mjs'));
      steps.push({ id: 'harvest', label: 'harvest supply', summary: `unreadable: ${String(e.message).slice(0, 60)}` });
    }
  } else {
    steps.push({ id: 'harvest', label: 'harvest supply', skipped: 'no AIRTABLE_PAT / REGISTRY_BASE_ID' });
  }

  // The farm's own integrity questions (2026-09-02): hearts overspend, cooldown violations,
  // orphaned verdicts. Same read-only posture; the gate is the actor, this only asks.
  if (env.AIRTABLE_PAT && env.REGISTRY_BASE_ID) {
    try {
      const fa = await farmIntegrity(env);
      findings.push(...fa.findings);
      steps.push({ id: 'farm', label: 'farm integrity', summary: fa.summary, findings: fa.findings.length });
    } catch (e) {
      findings.push(F('info', 'farm', 'farm integrity unchecked', String(e.message).slice(0, 160), 'node harvest-gate.mjs --dry'));
      steps.push({ id: 'farm', label: 'farm integrity', summary: `unreadable: ${String(e.message).slice(0, 60)}` });
    }
  } else {
    steps.push({ id: 'farm', label: 'farm integrity', skipped: 'no AIRTABLE_PAT / REGISTRY_BASE_ID' });
  }

  findings.sort(bySeverity);
  const counts = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const dirty = counts.critical > 0 || counts.warn > 0;
  // The pod check earned its own line: it is the one finding that costs money silently, on drafts
  // every other gate calls clean.
  const podDrift = findings.filter((f) => /^pod [A-Z]/.test(String(f.detail || ''))).length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ ranAt: new Date().toISOString(), dirty, counts, podDrift, steps, harvest: harvest?.stats || null, findings }, null, 1));
  } else {
    console.log(`\nSWEEP — ${monetized.length} account(s), ${new Date().toISOString().slice(0, 16)}Z\n`);
    for (const s of steps) {
      const tag = s.skipped ? `skipped (${s.skipped})` : s.summary;
      console.log(`  ${s.findings ? '✗' : s.skipped ? '·' : '✓'} ${String(s.label).padEnd(34)} ${tag}${s.ms ? `   ${(s.ms / 1000).toFixed(1)}s` : ''}`);
    }
    if (findings.length) {
      console.log(`\nFINDINGS — ${counts.critical || 0} critical · ${counts.warn || 0} warn · ${counts.info || 0} info${podDrift ? ` · ${podDrift} CTA(s) written past a measured pod` : ''}\n`);
      const GLYPH = { critical: '🛑', warn: '⚠️ ', info: 'ℹ️ ' };
      for (const f of findings.slice(0, 60)) {
        console.log(`  ${GLYPH[f.severity] || '·'} [${f.source}] ${f.title}`);
        if (f.detail) console.log(`       ${String(f.detail).slice(0, 150)}`);
        if (f.action) console.log(`       → ${f.action}`);
      }
      if (findings.length > 60) console.log(`  ... and ${findings.length - 60} more (use --json)`);
    }
    console.log(`\n${dirty ? '✗ NEEDS ATTENTION' : '✓ CLEAN — nothing blocking'}  ·  ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }

  if (DRY) { process.exitCode = dirty ? 1 : 0; return; }

  // Findings that outlive the run, in the shape needs-you.mjs already reads. Cleared to an empty
  // list rather than deleted, so a stale file can never masquerade as "nothing found today".
  const qDir = join(HERE_DIR, 'queues'); mkdirSync(qDir, { recursive: true });
  writeFileSync(join(qDir, 'sweep-findings.json'), JSON.stringify({ updatedAt: new Date().toISOString(), count: findings.length, items: findings }, null, 1));

  // INTERRUPT-ONLY. A clean run says nothing at all. This convention is stated in three separate
  // places in this repo for one reason: a green report on a schedule trains the operator to swipe
  // past the red one. --loud is the manual escape hatch when you want to see it fire.
  if ((dirty || LOUD) && !NO_ALERT && (!CRITICAL_ONLY || LOUD || counts.critical)) {
    const top = findings.slice(0, 6).map((f) => `• ${esc(f.title)}`).join('\n');
    await telegram(env, report({
      emoji: counts.critical ? '🛑' : '⚠️',
      title: 'Fleet sweep',
      scope: `${monetized.length} accounts · ${steps.filter((s) => !s.skipped).length} checks`,
      status: dirty ? `${counts.critical || 0} critical · ${counts.warn || 0} warn` : '✅ clean (--loud)',
      sections: [
        { label: 'Top findings', body: top },
        harvest ? { label: 'Harvest lane', body: esc(harvest.summary) } : null,
      ].filter(Boolean),
      action: counts.critical ? 'node sweep.mjs — fix the critical ones before the next slot fires' : 'node sweep.mjs --json',
    }), 'alerts');
  }

  await logRun('sweep', {
    accounts: monetized.length, checks: steps.filter((s) => !s.skipped).length,
    critical: counts.critical || 0, warn: counts.warn || 0, info: counts.info || 0,
    podDrift, dirty, harvest: harvest?.stats || null,
  });
  process.exitCode = dirty ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'sweep');
