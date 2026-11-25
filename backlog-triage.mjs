// backlog-triage.mjs — weekly digest so the retro backlog actually gets CONSUMED, not just written.
// IMPROVEMENTS.md accumulates [proposed] items from up to 5 retro crons daily (126+ open at last
// count, ~6 ever applied) — proposals written faster than they're read are proposals written to
// /dev/null. This parses the backlog deterministically (the FIRST real parser; retro-core only ever
// fed the raw text to an LLM), buckets by triage state, and telegrams the top picks every Monday.
//
// BUCKETING IS LOAD-BEARING: ~111 of the open [proposed] items carry a human "*(skipped: ...)*"
// annotation — deliberately parked (money math / subid / scheduling zones per the standing triage
// in IMPROVEMENTS.md). A naive top-N digest would re-spam what a human already declined weekly.
// So: bucket A = UNTRIAGED + PARTIAL items (need a decision NOW), bucket B = the biggest recurring
// human-gated FAMILIES (a "still parked, still recurring" nudge with counts, not item spam).
//
//   node backlog-triage.mjs          # parse -> rank -> Telegram (retro topic)
//   node backlog-triage.mjs --dry    # parse -> rank -> print only (offline; used by CI-adjacent checks)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, telegram, esc, report, logRun, HERE_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const BACKLOG = join(HERE_DIR, 'IMPROVEMENTS.md');

// Recurring human-gated FAMILY keywords — mirrors the standing-triage blockquote in IMPROVEMENTS.md
// (the families the nightly retros re-propose). Matched against the full item text, lowercase.
export const FAMILIES = [
  ['subid/attribution', /subid|link[- ]?minting|attribution/],
  ['revenue-feedback', /revenue[- ]?feedback|money math|\$\/(hit|post|thread)|revenue[- ]?per/],
  ['account-allocation', /account[- ]?allocation|julian[- ]?priorit|fleet[- ]?provision|fan[- ]?out|quota/],
  ['untracked-blocking', /untracked|pre[- ]?publish block|hard block/],
  ['gumroad-ref', /gumroad \?ref|\?ref test|url_parameters/],
  ['freshness/reach', /freshness|reach[- ]?collapse|fresh[- ]?(net|window|swipe)/],
];

// parseBacklog(md) -> [{tag, title, type, severity, source, date, state, fix, text}]
// Tolerates BOTH format eras: machine-appended `## Retro — <source> — <date>` sections with
// `- **[tag] Title** *(type/severity, source, date)* — rootCause\n  Fix: ...` items, AND the loose
// hand-written top sections (items with no meta, `> ` standing-triage blockquotes, `- [applied]`
// plain bullets — the latter are ignored: they're already applied). Skip/verified annotations contain
// NESTED parens, so triage state is detected by opening substring, never by balanced-paren matching.
export function parseBacklog(md) {
  const items = [];
  let source = 'manual', sectionDate = null, cur = null;
  const push = () => { if (cur) { finishItem(cur); items.push(cur); cur = null; } };
  for (const line of String(md).split('\n')) {
    const sec = line.match(/^## Retro — (.+?) — (\d{4}-\d{2}-\d{2})\s*$/);
    if (sec) { push(); source = sec[1]; sectionDate = sec[2]; continue; }
    if (/^## /.test(line)) { push(); source = 'manual'; sectionDate = null; continue; }
    if (/^> /.test(line)) { push(); continue; } // standing-triage blockquote — doctrine, not items
    const item = line.match(/^- \*\*\[([a-z-]+)\] (.+?)\*\*/);
    if (item) { push(); cur = { tag: item[1], title: item[2], source, sectionDate, lines: [line] }; continue; }
    if (cur && (/^\s+\S/.test(line) || line.trim() === '')) { cur.lines.push(line); continue; } // continuation
    if (cur && /^- /.test(line)) { push(); continue; } // plain legacy bullet ends the item, starts nothing
  }
  push();
  return items;
}
function finishItem(it) {
  it.text = it.lines.join('\n');
  const meta = it.text.match(/\*\((rule|code|process)\/(critical|high|medium),\s*([^,]+?),\s*(\d{4}-\d{2}-\d{2})/);
  it.type = meta?.[1] || null;
  it.severity = meta?.[2] || null;
  if (meta?.[3]) it.source = meta[3].trim();
  it.date = meta?.[4] || (it.text.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || it.sectionDate || null;
  it.fix = (it.text.match(/^\s+Fix:\s*(.+)$/m) || [])[1] || '';
  // Triage state — opening-substring detection (annotations nest parens; see header note).
  it.state = it.text.includes('*(skipped:') ? 'human-gated'
    : it.text.includes('*(deferred') ? 'deferred'
    : it.text.includes('*(verified already-implemented') ? 'verified'
    : it.text.includes('*(attempted, reverted') ? 'reverted'
    : it.text.includes('*(partial') ? 'partial'
    : 'untriaged';
  delete it.lines; delete it.sectionDate;
}

// rankProposed(items, todayIso) -> { open, untriaged, humanGated, pickNext, families }
// pickNext = bucket A (untriaged + partial [proposed] items), scored: severity + recency.
// families = bucket B (human-gated items clustered by FAMILIES keyword), sorted by cluster size.
export function rankProposed(items, todayIso = null) {
  const today = todayIso ? Date.parse(todayIso) : Date.parse(items.map((i) => i.date).filter(Boolean).sort().pop() || '2026-01-01');
  const proposed = items.filter((i) => i.tag === 'proposed');
  const sevW = { critical: 3, high: 2, medium: 1 };
  const ageDays = (i) => (i.date ? (today - Date.parse(i.date)) / 864e5 : 999);
  const score = (i) => (sevW[i.severity] || 1) + (ageDays(i) <= 14 ? 2 : ageDays(i) <= 30 ? 1 : 0);
  const pickNext = proposed
    .filter((i) => i.state === 'untriaged' || i.state === 'partial')
    .sort((a, b) => score(b) - score(a) || String(b.date).localeCompare(String(a.date)));
  const fam = new Map();
  for (const i of proposed.filter((x) => x.state === 'human-gated')) {
    const low = i.text.toLowerCase();
    const hit = FAMILIES.find(([, re]) => re.test(low));
    const key = hit ? hit[0] : 'other';
    if (!fam.has(key)) fam.set(key, []);
    fam.get(key).push(i);
  }
  const families = [...fam.entries()].map(([name, arr]) => ({ name, count: arr.length, latest: arr.map((i) => i.date).filter(Boolean).sort().pop() || null }))
    .sort((a, b) => b.count - a.count);
  return {
    open: proposed.length,
    untriaged: proposed.filter((i) => i.state === 'untriaged').length,
    humanGated: proposed.filter((i) => i.state === 'human-gated').length,
    pickNext, families,
  };
}

async function main() {
  const env = loadEnv();
  if (!DRY) requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']); // telegram() with a route reads the Airtable Config row
  if (!existsSync(BACKLOG)) { console.log('No IMPROVEMENTS.md — nothing to triage.'); return; }
  const items = parseBacklog(readFileSync(BACKLOG, 'utf8'));
  const r = rankProposed(items, new Date().toISOString().slice(0, 10));

  const pickLines = r.pickNext.slice(0, 3).map((i) =>
    `• <b>${esc(i.severity || '?')}:</b> ${esc(i.title)} <i>(${esc(i.source)}, ${i.date || '?'}${i.state === 'partial' ? ', partial' : ''})</i>${i.fix ? `\n   ↳ ${esc(i.fix.slice(0, 140))}` : ''}`);
  const famLines = r.families.slice(0, 3).map((f) => `• <b>${esc(f.name)}</b> — parked ×${f.count}${f.latest ? `, last re-proposed ${f.latest}` : ''}`);

  const msg = report({
    emoji: '🗂️', title: 'Backlog triage', scope: 'weekly digest',
    status: `ℹ️ <b>${r.open}</b> proposed open · <b>${r.untriaged}</b> untriaged · <b>${r.humanGated}</b> human-gated`,
    sections: [
      { label: 'PICK NEXT (untriaged)', body: pickLines.length ? pickLines.join('\n') : '<i>Nothing untriaged — the backlog is fully triaged. 🎉</i>' },
      ...(famLines.length ? [{ label: 'RECURRING FAMILIES (human-gated, still re-proposing)', body: famLines.join('\n') }] : []),
    ],
    action: 'Reply with an item to green-light — the weekly implementation slot takes the top pick.',
  });

  console.log(msg.replace(/<[^>]+>/g, ''));
  if (!DRY) {
    logRun('triage', { open: r.open, untriaged: r.untriaged, humanGated: r.humanGated, top: r.pickNext.slice(0, 3).map((i) => i.title), families: r.families.slice(0, 3) });
    await telegram(env, msg, 'retro'); console.log('\n✓ Sent to retro topic');
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
