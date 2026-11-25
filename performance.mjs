// performance.mjs — daily digest of how OUR posts are performing, with links to navigate.
// Reads the "Published Content" registry (refreshed by registry-sync just before) and reports:
//   - posts that went live in the last 24h + their early numbers
//   - the current top performers (so there's always signal), with X + Typefully links
// Runs after registry-sync (data is fresh). Posts to the 📊 Performance topic.
//   node performance.mjs            # send digest
//   node performance.mjs --dry      # console only
//   node performance.mjs --hours 48
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, telegram, esc, fmtSaigon, report, logRun, HERE_DIR } from './lib.mjs';
import { REGISTRY_TABLE, SEND_STATE_DIGESTS } from './config.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const HOURS = parseInt(flag('hours', '24'), 10);
const TABLE = REGISTRY_TABLE;
const POSTED = new Set(['Posted', 'Winner', 'Repost Candidate', 'Reposted']);

async function fetchRows(env) {
  const out = [];
  let offset;
  do {
    const u = `https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${encodeURIComponent(TABLE)}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`registry read -> ${r.status}`);
    const d = await r.json(); out.push(...d.records.map((x) => x.fields)); offset = d.offset;
  } while (offset);
  return out;
}
const link = (f) => f['X URL'] || f['Typefully Link'] || '';
const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
const head = (f, n = 48) => { const u = link(f), name = esc((f.Post || '').slice(0, n)); return u ? `<a href="${u}">${name}</a>` : name; };
// leaderboard row: rank · post · account · impressions · clicks · engagement
const lbLine = (f, i) => `${medal(i)} ${head(f)}\n     ${esc(f.Account)} · ${(f.Impressions || 0).toLocaleString()} imp · ${reachClicksOf(f)} link clk · ${(((f['Engagement Rate'] || 0) * 100)).toFixed(1)}% eng`;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
// Clicks and money read the LIFETIME columns, never the 59-day window (docs/money-columns.md).
// `Link Clicks` is MAX(Typefully, Levanta) over every link in the thread, so it both decays past
// the window AND overcounts the affiliate hop; ranking a leaderboard on it ranks the wrong posts.
const clicksOf = (f) => f['Lifetime Clicks'] ?? f['Affiliate Clicks'] ?? 0;
// The 24h list is the ONE place that reads Link Clicks, and it labels it. Levanta reports on a lag,
// so a post published today has 0 lifetime clicks by construction: measured 2026-09-06, the last 18
// posts held 72 Typefully link clicks against 0 Levanta clicks. Printing the paying clicks there
// would put a truthful 0 on every row and say nothing. It is a REACH line, so it shows reach and
// names it; nothing here is divided into money.
const reachClicksOf = (f) => f['Link Clicks'] || 0;
const earnedBy = (f) => f['Lifetime Commission'] ?? f.Commission ?? 0;

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', ...(DRY ? [] : ['XDB_BASE_ID'])]);
  const rows = (await fetchRows(env)).filter((f) => POSTED.has(f.Status));
  const cutoff = Date.now() - HOURS * 36e5;
  const fresh = rows.filter((f) => f['Posted Date'] && new Date(f['Posted Date']).getTime() >= cutoff)
    .sort((a, b) => (b.Impressions || 0) - (a.Impressions || 0));
  // Winner is the registry's `Verdict` formula (500 lifetime clicks OR $500 lifetime commission),
  // not a Status. The 'Winner'/'Repost Candidate' statuses were retired 2026-09-02, so filtering on
  // them left this board quietly emptying as the last rows carrying them aged out. Verdict is a
  // formula over the lifetime columns, which makes it the one definition of the word in the system.
  const winners = rows.filter((f) => String(f.Verdict || '').includes('Winner'))
    .sort((a, b) => clicksOf(b) - clicksOf(a));
  // outlier score = a winner's reach vs its account's median reach among posts that ACTUALLY have reach
  // (exclude 0-impression rows — scheduled / not-yet-synced — or the median collapses to 0).
  const impByAcct = {}; rows.forEach((f) => { if ((f.Impressions || 0) > 0) (impByAcct[f.Account] ||= []).push(f.Impressions); });
  const outlier = (f) => { const arr = impByAcct[f.Account] || []; const m = arr.length ? median(arr) : 0; return m > 0 ? (f.Impressions || 0) / m : 0; };

  const sections = [{
    label: `PUBLISHED (last ${HOURS}h · ${fresh.length})`,
    body: (fresh.length ? fresh.slice(0, 10).map((f, i) => lbLine(f, i)) : ['<i>none published in this window</i>']).join('\n'),
  }];
  if (winners.length) {
    const winnerBlocks = winners.map((w) => {
      const action = w.Status === 'Repost Candidate'
        ? '♻️ queued for evergreen repost (enters the weekly slate)'
        : '🏆 live & compounding — auto-reposts at 90d';
      const sc = outlier(w);
      return [
        `• ${head(w)}`,
        // Commission is what we KEEP; Sales is what the customer paid Amazon. Adding them
        // reported roughly seven times our actual earnings on a converting post.
        `     ${esc(w.Account)} · ${(w.Impressions || 0).toLocaleString()} imp · ${clicksOf(w)} clicks · $${earnedBy(w).toFixed(2)}`,
        ...(sc > 0 ? [`     📈 outlier: ${sc.toFixed(1)}× typical reach`] : []),
        `     → ${action}`,
      ].join('\n');
    });
    sections.push({ label: `🏆 WINNERS (${winners.length})`, body: winnerBlocks.join('\n\n') });
  }

  // Trend vs yesterday's run (own log) — a count without a comparison isn't an insight.
  let delta = '';
  try {
    const y = JSON.parse(readFileSync(join(HERE_DIR, 'logs', `performance-${new Date(Date.now() - 864e5).toISOString().slice(0, 10)}.json`), 'utf8'));
    if (Number.isFinite(y.fresh)) { const d = fresh.length - y.fresh; delta = d ? ` (${d > 0 ? '▲ +' + d : '▼ ' + d} vs yesterday)` : ' (= yesterday)'; }
  } catch {}
  logRun('performance', { fresh: fresh.length, winners: winners.length });
  const out = report({
    emoji: '📊', title: 'Daily Performance', scope: `last ${HOURS}h · ${rows.length} live post(s)`,
    status: `✅ <b>${fresh.length}</b> live in last ${HOURS}h${delta} · <b>${winners.length}</b> winner(s)`,
    sections,
    action: 'Repost candidate → weekly slate; winner → auto-repost at 90d.',
  });
  console.log(out.replace(/<[^>]+>/g, ''));
  if (!DRY && SEND_STATE_DIGESTS) { await telegram(env, out, 'performance'); console.log('\n✓ Sent to 📊 Performance'); }
  else if (!DRY) console.log('\n(quiet: state digest — the dashboard renders this. SEND_STATE_DIGESTS in config.mjs restores it.)');
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
