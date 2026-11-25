#!/usr/bin/env node
// regate-queue.mjs [--since <git-ref>] [--account <name>] [--apply] [--notify] [--json] [--strict all]
//
// Re-gate every unpublished draft in Typefully against the laws AS THEY ARE NOW, grouped by law.
//
// The gap this closes (Run 2, 2026-09-06/07): the thin-bridge law landed on a Saturday and the
// attempts written the day before were never read against it — three shipped with a one-sentence
// bridge above the ask and were repaired by hand minutes to hours before posting. A law that changes
// mid-run has to be run over the queue the moment it lands, and again every night, because nothing
// re-gates a draft that already passed. audit-drafts does the reading (current checks.mjs over every
// draft/scheduled/planned draft on every monetized page); this groups its findings BY LAW so a
// change's blast radius is one screen, tells scheduled from parked, applies the repairs that need no
// judgement behind --apply (repair-drafts: sign-off, disclaimer, dashes, split walls — never copy),
// and exits 1 when something SCHEDULED must not post.
//
//   node regate-queue.mjs                          # the queue against today's laws, by law
//   node regate-queue.mjs --since origin/main      # plus: which law files changed since that ref
//   node regate-queue.mjs --apply                  # mechanical repairs on the blocked/degraded drafts
//   node regate-queue.mjs --notify                 # Telegram qc when a scheduled draft is blocked
//
// Exit 1 when a SCHEDULED draft is a BLOCKER (`--strict all` counts unscheduled ones too). Parked
// and unscheduled drafts are reported, never the reason a law PR goes red: what posts is the gate.
// Runs nightly and on every push that touches checks.mjs / laws.json (.github/workflows/regate.yml).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, telegram, cliArg, runMain, HERE_DIR, esc } from './lib.mjs';

export const LAW_FILES = ['checks.mjs', 'laws.json', 'laws.mjs'];
export const INSIDE_MIN = 15;

/** PURE. The law a finding belongs to. checkThread findings arrive as "[code] msg"; the audit's own
 *  tiers are fixed phrases. Unknown text keeps its first words so nothing is lumped into "other". */
export function lawOf(reason = '') {
  const s = String(reason).trim();
  const m = s.match(/^\[([^\]]+)\]/);
  if (m) return m[1];
  if (/over 280/.test(s)) return 'length';
  if (/hard health claim/i.test(s)) return 'hard-claim';
  if (/untracked commerce link/i.test(s)) return 'untracked-link';
  if (/no tracked plug/i.test(s)) return 'no-plug';
  if (/em\/en dash/i.test(s)) return 'dash';
  if (/^pod \S+ covers/i.test(s)) return 'pod-drift';
  if (/placeholder/i.test(s)) return 'placeholder';
  if (/numbering|numbered/i.test(s)) return 'numbering';
  if (/stage direction/i.test(s)) return 'stage-direction';
  if (/bridge/i.test(s)) return 'bridge';
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 3).join('-') || 'other';
}

/** PURE. Inside the no-touch window: scheduled within INSIDE_MIN minutes of `now`, or already past. */
export const soon = (scheduled, now = Date.now()) => {
  if (!scheduled) return false;               // Date.parse(0) is the year 2000, not "never"
  const t = Date.parse(scheduled);
  return Number.isFinite(t) && t - now < INSIDE_MIN * 60e3;
};

/** PURE. audit-drafts' --json payload -> findings grouped by law.
 *  Returns { laws: [{ law, tier, drafts: [{ account, id, status, scheduled, title, reason, soon }] }],
 *            audited, blocked, blockedScheduled, degraded, failed, ids: { repairable } }. */
export function groupByLaw(payload = [], { now = Date.now() } = {}) {
  const byLaw = new Map();
  let audited = 0, blocked = 0, blockedScheduled = 0, degraded = 0, failed = 0;
  const repairable = new Set();
  for (const a of payload) {
    failed += (a.failed || []).length;
    for (const d of a.drafts || []) {
      audited++;
      const isSoon = soon(d.scheduled, now);
      if (d.tier === 'BLOCKER') { blocked++; if (d.status === 'scheduled') blockedScheduled++; }
      if (d.tier === 'DEGRADED') degraded++;
      if ((d.tier === 'BLOCKER' || d.tier === 'DEGRADED') && !isSoon && ['draft', 'scheduled'].includes(d.status)) repairable.add(String(d.id));
      for (const [tier, list] of [['BLOCKER', d.blockers || []], ['DEGRADED', d.degraded || []]]) {
        for (const reason of list) {
          const law = lawOf(reason);
          const key = `${tier}:${law}`;
          if (!byLaw.has(key)) byLaw.set(key, { law, tier, drafts: [] });
          byLaw.get(key).drafts.push({ account: a.account, id: String(d.id), status: d.status, scheduled: d.scheduled || null, title: d.title || '', reason: String(reason), soon: isSoon });
        }
      }
    }
  }
  const laws = [...byLaw.values()].sort((x, y) => (x.tier === y.tier ? y.drafts.length - x.drafts.length : x.tier === 'BLOCKER' ? -1 : 1));
  // Jev's final-copy safety read (audit-drafts --jev): scheduled drafts it flags, and those it could not read.
  const jev = { read: 0, flagged: [], unread: 0, settled: [], upheld: 0, craftUnread: 0 };
  for (const a of payload) for (const d of a.drafts || []) {
    // Craft findings Jev's editorial read settled (audit-drafts jevCraftRead): out of the tiers above,
    // listed here so the operator can see what Jev cleared (an AUDIT SAMPLE line asks for a full read).
    if (d.jevSettled?.length) jev.settled.push({ account: a.account, id: String(d.id), scheduled: d.scheduled || null, title: d.title || '', settled: d.jevSettled });
    if (d.jevCraft === 'upheld') jev.upheld++;
    if (d.jevCraft === 'not read') jev.craftUnread++;
    if (d.status !== 'scheduled' || d.jevSafety === undefined) continue;
    if (d.jevSafety === null) jev.unread++;
    else jev.read++;
    if (d.jevSafety?.length) jev.flagged.push({ account: a.account, id: String(d.id), scheduled: d.scheduled || null, title: d.title || '', flags: d.jevSafety });
  }
  return { laws, audited, blocked, blockedScheduled, degraded, failed, jev, ids: { repairable: [...repairable] } };
}

/** PURE. The one-screen report. */
export function renderReport(g, { lawsChanged = null, since = null } = {}) {
  const L = [];
  if (since) L.push(lawsChanged?.length ? `laws changed since ${since}:\n${lawsChanged.map((l) => `  ${l}`).join('\n')}` : `no law file changed since ${since} (${LAW_FILES.join(', ')})`);
  L.push(`RE-GATE — ${g.audited} unpublished draft(s) against today's laws · ${g.blocked} blocked (${g.blockedScheduled} scheduled) · ${g.degraded} degraded${g.failed ? ` · ${g.failed} unreadable` : ''}`);
  for (const x of g.laws) {
    L.push('', `${x.tier === 'BLOCKER' ? '🔴' : '🟡'} ${x.law} — ${x.drafts.length} draft(s)`);
    for (const d of x.drafts) L.push(`   ${d.account.padEnd(16)} ${d.id.padEnd(9)} ${d.status.padEnd(9)} ${d.scheduled ? d.scheduled.slice(0, 16).replace('T', ' ') + 'Z' : '—'.padEnd(17)}${d.soon ? ' ⏳' : '   '} ${d.reason.slice(0, 110)}`);
  }
  if (!g.laws.length) L.push('', '✓ every unpublished draft clears today\'s laws');
  return L.join('\n');
}

const run = (script, args) => {
  try { return { code: 0, out: execFileSync('node', [join(HERE_DIR, script), ...args], { encoding: 'utf8', cwd: HERE_DIR, timeout: 1200000, maxBuffer: 1 << 26 }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};
const lastJson = (s) => { const i = String(s).search(/^\s*[\[{]/m); if (i < 0) return null; try { return JSON.parse(String(s).slice(i)); } catch { return null; } };

async function main() {
  const since = cliArg('since', null);
  let lawsChanged = null;
  if (since) {
    try { lawsChanged = execFileSync('git', ['-C', HERE_DIR, 'log', '--oneline', `${since}..HEAD`, '--', ...LAW_FILES], { encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch (e) { lawsChanged = [`(git could not read ${since}: ${String(e.message).split('\n')[0]})`]; }
  }
  const auditArgs = ['--json', ...(cliArg('account', null) ? ['--account', cliArg('account')] : []), ...(process.argv.includes('--jev') ? ['--jev'] : [])];
  const r = run('audit-drafts.mjs', auditArgs);
  const payload = lastJson(r.out);
  if (!Array.isArray(payload)) { console.error(r.out.slice(-800)); throw new Error(`audit-drafts produced no payload (exit ${r.code})`); }
  const g = groupByLaw(payload);
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ since, lawsChanged, ...g }, null, 1)); return; }
  const report = renderReport(g, { lawsChanged, since });
  console.log(report);

  if (process.argv.includes('--apply')) {
    const ids = g.ids.repairable;
    console.log(`\n── apply: mechanical repairs on ${ids.length} draft(s) (repair-drafts --go; a draft inside ${INSIDE_MIN} min is never touched) ──`);
    if (ids.length) { const rr = run('repair-drafts.mjs', ['--go', '--id', ids.join(',')]); console.log(rr.out.split('\n').filter((l) => l.trim() && !l.startsWith('[roster]')).map((l) => '   ' + l).join('\n')); console.log('   re-run regate-queue to confirm what is left'); }
  }

  const strictAll = cliArg('strict', 'scheduled') === 'all';
  const red = strictAll ? g.blocked > 0 : g.blockedScheduled > 0;
  console.log(red ? `\n✗ ${strictAll ? g.blocked : g.blockedScheduled} ${strictAll ? '' : 'scheduled '}draft(s) must not post under today's laws` : `\n✓ nothing scheduled is illegal under today's laws${g.blocked ? ` (${g.blocked} unscheduled blocker(s) reported above)` : ''}`);
  if (red) process.exitCode = 1;
  if (process.argv.includes('--jev')) {
    console.log(`\nJev safety read (report-only): ${g.jev.read} scheduled draft(s) read · ${g.jev.flagged.length} flagged${g.jev.unread ? ` · ${g.jev.unread} not read` : ''}`);
    for (const f of g.jev.flagged) console.log(`   ${f.account} ${f.id} ${f.scheduled || ''} ${f.title} · ${f.flags.map((x) => `${x.key.replace(/_/g, ' ')} ${x.p}${x.tweet ? ` T${x.tweet}` : ''}`).join(', ')}`);
    console.log(`Jev craft read: ${g.jev.settled.length} scheduled draft(s) cleared of craft findings · ${g.jev.upheld} upheld${g.jev.craftUnread ? ` · ${g.jev.craftUnread} not read (findings stand)` : ''}`);
    for (const f of g.jev.settled) console.log(`   ${f.account} ${f.id} ${f.scheduled || ''} ${f.title}\n${f.settled.map((x) => `      · ${x}`).join('\n')}`);
  }
  // One Telegram line only when Jev flags something scheduled (owner default 3, plan v7 N5). Never copy.
  if (g.jev?.flagged.length && process.argv.includes('--notify')) {
    const list = g.jev.flagged.slice(0, 8).map((f) => `${esc(f.account)} ${esc(f.id)}: ${esc(f.flags.map((x) => x.key.replace(/_/g, ' ')).join(', '))}`).join('\n');
    await telegram(loadEnv(), `🟠 <b>Jev: ${g.jev.flagged.length} scheduled draft(s) to read before they post</b>\n<pre>${list}</pre>`, 'qc');
    console.log('notified qc (Jev safety)');
  }
  if (red && process.argv.includes('--notify')) {
    const head = report.split('\n').slice(0, 24).join('\n');
    await telegram(loadEnv(), `🔴 <b>Re-gate: ${g.blockedScheduled} scheduled draft(s) must not post</b>\n<pre>${esc(head)}</pre>\n\n👉 <i>node regate-queue.mjs --apply for the mechanical ones; the rest need a writer or an unschedule.</i>`, 'qc');
    console.log('notified qc');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'regate-queue');
