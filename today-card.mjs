// Editable Telegram pages per Saigon day: schedule -> live tracker, compact post rows,
// forecast earnings, actual RT spend and hour-over-hour velocity direction.
//
// AT A GLANCE (owner, 2026-10-03: "At a glance I should know my overall performance, then the rest I can
// open later ... or maybe it should link to the airtable view for today"). The card leads with four lines
// (live count, views vs yesterday at the same time, fleet velocity, RT and forecast), the three fastest
// threads, and the one exception line. Every thread still follows, one entry each, inside ONE native
// expandable quote that stays collapsed until tapped, and the Airtable "Published Today" view is a tap
// away. Nothing is dropped: the full list only moved under the fold.
import { isThreadRow } from './monitoring-scope.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE, GROWTH, growthBase } from './config.mjs';
import { isKnownLane } from './lanes.mjs';
import { airtable, esc, HERE_DIR, loadEnv, requireEnv, runMain, telegramCard, telegramTextLength } from './lib.mjs';
import { estimateEarnings, measureRates } from './earn-estimate.mjs';
import { TBL } from './config.mjs';

const FUEL_LOG = TBL.fuelLog;
const GROWTH_LOG = GROWTH.table; // own base since 2026-11-25 (config.mjs GROWTH)
const STATE_FILE = join(HERE_DIR, 'queues', 'telegram-today-card.json');
// Published Content's "Published Today" grid view. It lives in this base only, so the link is offered
// only when the registry base is this one, and only on the live card (Airtable's "today" is not a recap's).
// The registry's Today view link for the card; set TODAY_VIEW_URL (Railway variable) to show it.
export const TODAY_VIEW = { base: process.env.REGISTRY_BASE_ID || '', url: process.env.TODAY_VIEW_URL || '' };
const PAGE_LIMIT = 3900;
// Owner scope: canonical thread lanes or measured multi-tweet evidence; explicit
// singles and native X Articles (owner, R2026-10-03: articles are additive) always lose,
// and AI Evolution is outside this card.
const includedAccount = (name) => String(name || '').trim().toLowerCase() !== 'ai evolution';
export function isCardThread(row) {
  if (!isThreadRow(row)) return false;
  if (isKnownLane(row.Type)) return true;
  try {
    const curve = JSON.parse(row['Tweet Views'] || 'null');
    return Array.isArray(curve) && curve.some((tweet) => Number.isInteger(tweet?.i) && tweet.i > 1);
  } catch { return false; }
}
const liveStatus = new Set(['Posted', 'Reposted', 'Winner', 'Repost Candidate']);
const num = (v) => Number(v) || 0;
const tid = (u) => (String(u || '').match(/status\/(\d+)/) || [])[1] || '';
export const saigonDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export function validateCardDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('day must be a valid YYYY-MM-DD date');
  return day;
}
export function cardOptions(args = [], now = new Date()) {
  let day = saigonDay(now), recap = false, dry = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--day') day = validateCardDay(args[++i]);
    else if (args[i] === '--recap') recap = true;
    else if (args[i] === '--dry') dry = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (day > saigonDay(now)) throw new Error('Cannot send a future day card');
  return { day, recap: recap || day < saigonDay(now), dry };
}
export function growthWindow(day, now = new Date()) {
  validateCardDay(day);
  const start = new Date(`${day}T00:00:00+07:00`);
  const end = new Date(Math.min(start.getTime() + 86400e3, now.getTime()));
  return { start, end };
}
const dayOf = (v) => v ? saigonDay(new Date(v)) : '';
const clock = (v) => v ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) : '';
const compact = (v) => {
  const value = num(v);
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
};
const rtMoney = (v) => `$${num(v).toFixed(2)}`;
const money = (v) => `$${num(v).toFixed(num(v) >= 100 ? 0 : 2).replace(/\.00$/, '')}`;

export function velocityState(samples = []) {
  const s = [...samples].filter((x) => Number.isFinite(Number(x.rise)) && Number.isFinite(Date.parse(x.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // No sample yet is unknown, not zero: a fresh thread must never read as "0/h".
  if (!s.length) return { rise: null, arrow: '—', takingOff: false };
  const cur = num(s.at(-1).rise), prev = s.length > 1 ? num(s.at(-2).rise) : null;
  // A lone first snapshot carries 0/h only because there was nothing before it to measure against.
  if (prev == null) return { rise: cur || null, arrow: '—', takingOff: false };
  if (cur > prev * 1.1) return { rise: cur, arrow: '↑', takingOff: true };
  if (cur < prev * 0.9) return { rise: cur, arrow: '↓', takingOff: false };
  return { rise: cur, arrow: '→', takingOff: false };
}

/**
 * Views so far vs yesterday at the same moment. Each day's live threads are summed from their latest
 * Growth Log snapshot at or before the cut (now for today, now - 24h for yesterday), so both sides are
 * measured the same way. A thread with no snapshot counts on neither side. Under 1K views yesterday is no
 * comparison (an early morning would read as a meaningless +900%). Pure.
 */
export function paceVsYesterday({ rows = [], growth = [], growthPrev = [], now = new Date(), day = saigonDay(now) } = {}) {
  validateCardDay(day);
  const prevDay = saigonDay(new Date(Date.parse(`${day}T12:00:00+07:00`) - 86400e3));
  const cutToday = now.getTime(), cutPrev = cutToday - 86400e3;
  const sumFor = (d, snaps, cut) => {
    const ids = new Set(rows.filter((r) => includedAccount(r.Account) && isCardThread(r) && liveStatus.has(r.Status)
      && dayOf(r['Posted Date']) === d && Date.parse(r['Posted Date']) <= cut).map((r) => tid(r['X URL'])).filter(Boolean));
    const latest = new Map();
    for (const g of snaps) {
      const k = tid(g['X URL']), t = Date.parse(g.At);
      if (!ids.has(k) || !(t <= cut) || !Number.isFinite(Number(g.Views))) continue;
      if (!latest.has(k) || t > latest.get(k).t) latest.set(k, { t, v: num(g.Views) });
    }
    return [...latest.values()].reduce((a, x) => a + x.v, 0);
  };
  const today = sumFor(day, growth, cutToday), yesterday = sumFor(prevDay, growthPrev, cutPrev);
  if (yesterday < 1000) return null;
  return { today, yesterday, pct: Math.round(((today - yesterday) / yesterday) * 100) };
}

export function buildTodayModel({ rows = [], fuel = [], growth = [], growthPrev = [], accountNames = [], rates, now = new Date(), day = saigonDay(now), recap = false, todayView = null } = {}) {
  validateCardDay(day);
  const window = growthWindow(day, now);
  // A missing or duplicate ledger row is not evidence of zero spend. Do not
  // arbitrarily choose a row or fall back to the registry's possibly stale cache.
  const fuelByTid = new Map();
  for (const f of fuel) {
    const key = tid(f['X URL']);
    if (!key) continue;
    fuelByTid.set(key, fuelByTid.has(key) ? null : f);
  }
  const growthByTid = new Map();
  for (const g of growth) { if (Date.parse(g.At) < window.start.getTime() || Date.parse(g.At) >= window.end.getTime()) continue; const k = tid(g['X URL']); if (k) (growthByTid.get(k) || growthByTid.set(k, []).get(k)).push({ at: g.At, rise: g['Rise/hr'] }); }
  const posts = rows.filter((r) => {
    if (!includedAccount(r.Account) || !isCardThread(r)) return false;
    const anchor = liveStatus.has(r.Status) ? r['Posted Date'] : r['Scheduled For'];
    return dayOf(anchor) === day && (liveStatus.has(r.Status) || r.Status === 'Scheduled');
  }).map((r) => {
    const live = liveStatus.has(r.Status), f = fuelByTid.get(tid(r['X URL'])) || {};
    const velocity = velocityState(growthByTid.get(tid(r['X URL'])) || []);
    const forecast = estimateEarnings({ views: r.Impressions, clicks: r['Lifetime Clicks'] ?? r['Affiliate Clicks'] ?? 0 }, rates);
    return { account: r.Account || '?', title: r.Post || `Draft ${r['Draft ID']}`, live, at: live ? r['Posted Date'] : r['Scheduled For'],
      link: live ? r['X URL'] : r['Typefully Link'], views: num(r.Impressions), forecast: forecast?.value || 0,
      tiers: f['Tiers Used'] || r['Fuel Tiers'] || '', spend: typeof f['Total Spend'] === 'number' && Number.isFinite(f['Total Spend']) && f['Total Spend'] >= 0 ? f['Total Spend'] : null, velocity };
  }).sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(a.at) - Date.parse(b.at));
  const accounts = accountNames.filter(includedAccount).map((name) => {
    const mine = posts.filter((p) => p.account === name), live = mine.filter((p) => p.live);
    return { name, total: mine.length, live: live.length, views: live.reduce((a, p) => a + p.views, 0), forecast: live.reduce((a, p) => a + p.forecast, 0), spend: live.reduce((a, p) => a + (p.spend ?? 0), 0), spendUnknown: live.filter((p) => p.spend == null).length, takingOff: live.some((p) => p.velocity.takingOff) };
  });
  const live = posts.filter((p) => p.live);
  const isRecap = recap || day < saigonDay(now);
  return { day, recap: isRecap, updatedDay: saigonDay(now), posts, accounts, live: live.length, total: posts.length, views: live.reduce((a, p) => a + p.views, 0), forecast: live.reduce((a, p) => a + p.forecast, 0), spend: live.reduce((a, p) => a + (p.spend ?? 0), 0), spendUnknown: live.filter((p) => p.spend == null).length, updated: clock(now),
    rise: live.reduce((a, p) => a + num(p.velocity.rise), 0), rising: live.filter((p) => p.velocity.takingOff).length, slowing: live.filter((p) => p.velocity.arrow === '↓').length,
    pace: isRecap ? null : paceVsYesterday({ rows, growth, growthPrev, now, day }), todayView: isRecap ? null : todayView };
}

const dayLabel = (day) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${day}T05:00:00Z`));
const href = (u) => esc(u).replace(/"/g, '&quot;');
const iconOf = (p) => (!p.live ? '⏳' : p.velocity.rise == null ? '🆕' : p.velocity.takingOff ? '🔥' : p.velocity.arrow === '↓' ? '🟡' : '🟢');
const speed = (v) => (v.rise == null ? 'no reading yet' : `${compact(v.rise)}/h ${v.arrow}`);
// Fastest first: the list is prioritized the same way the glance is. Recaps rank by views (velocity there
// is the selected day's last reading, not "now"); queued threads follow in posting order.
const byPriority = (recap) => (a, b) => Number(b.live) - Number(a.live)
  || (a.live ? (recap ? b.views - a.views : num(b.velocity.rise) - num(a.velocity.rise) || b.views - a.views) : 0)
  || Date.parse(a.at) - Date.parse(b.at);

function todayParts(m) {
  const spendTotal = `${rtMoney(m.spend)}${m.spendUnknown ? ` + ${m.spendUnknown} unknown` : ''}`;
  const queued = m.total - m.live;
  const header = `📍 <b>${m.recap ? 'RECAP' : 'TODAY'}</b> · <i>${dayLabel(m.day)}</i> · ${m.live}/${m.total} ${m.recap ? 'posted' : 'live'}`;
  const glance = [];
  if (!m.live && !m.recap && m.total) {
    const times = m.posts.map((p) => p.at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
    glance.push(`⏳ <b>${m.total} queued</b> · first ${clock(times[0])} · last ${clock(times.at(-1))}`);
  } else if (m.total) {
    const pace = m.pace ? ` · ${m.pace.pct >= 0 ? '▲' : '▼'} ${Math.abs(m.pace.pct)}% vs yesterday` : '';
    glance.push(`👁 <b>${compact(m.views)} views</b>${pace}`);
    if (!m.recap) glance.push(`⚡ <b>${compact(m.rise)}/h</b>${m.rising ? ` · 🔥 ${m.rising} rising` : ''}${m.slowing ? ` · 🟡 ${m.slowing} slowing` : ''}${queued ? ` · ⏳ ${queued} queued` : ''}`);
    glance.push(`💸 RT <b>${spendTotal}</b> · 💵 <b>~${money(m.forecast)}</b> forecast`);
  } else glance.push(m.recap ? 'No posted or scheduled threads for this day.' : 'No threads scheduled today.');
  const live = m.posts.filter((p) => p.live).sort(byPriority(m.recap));
  if (live.length) {
    const medal = ['🥇', '🥈', '🥉'];
    glance.push('', `🏆 <b>${m.recap ? 'Top by views' : 'Top now'}</b>`, ...live.slice(0, 3).map((p, i) => {
      const who = p.link ? `<a href="${href(p.link)}">${esc(p.account)}</a>` : esc(p.account);
      const metric = m.recap || p.velocity.rise == null ? `<b>${compact(p.views)} views</b>` : `<b>${compact(p.velocity.rise)}/h</b> ${p.velocity.arrow} · ${compact(p.views)} views`;
      return `${medal[i]} ${who} ${clock(p.at)} · ${metric}${p.tiers ? ` · ${esc(p.tiers)}` : ''}`;
    }));
  }
  // Every account with activity already appears in the list. Only missing accounts need an exception.
  const missing = m.accounts.filter((a) => a.total === 0).map((a) => esc(a.name));
  const tail = [];
  if (missing.length) tail.push(`⚠️ No posts: ${missing.join(' · ')}`);
  if (m.todayView && m.total) tail.push(`📂 <a href="${href(m.todayView)}">All ${m.total} threads in Airtable</a>`);
  if (tail.length) glance.push('', ...tail);
  const row = (p) => {
    // Keep a recognizable hook excerpt; its link opens the full post. Escape after slicing so HTML
    // entities stay whole.
    const hook = Array.from(String(p.title).replace(/\s+/g, ' ').trim());
    const excerpt = hook.length > 48 ? `${hook.slice(0, 47).join('').trimEnd()}…` : hook.join('');
    const title = p.link ? `<a href="${href(p.link)}">${esc(excerpt)}</a>` : `${esc(excerpt)} (link unavailable)`;
    const head = `${iconOf(p)} <b>${esc(p.account)}</b> ${clock(p.at)} · ${title}`;
    if (!p.live) return m.recap ? `${head} · still Scheduled in registry` : head;
    return `${head}\n${compact(p.views)} views · ${speed(p.velocity)} · ~${money(p.forecast)} · RT ${p.spend == null ? 'unknown' : rtMoney(p.spend)}${p.tiers ? ` · ${esc(p.tiers)}` : ''}`;
  };
  const rows = [...m.posts].sort(byPriority(m.recap)).map(row);
  const listTitle = `<b>All ${m.total} threads</b> · ${m.recap ? 'most viewed first' : 'fastest first'}`;
  const footnote = `<i>~ forecast ≠ commission · RT = cumulative logged charges, not daily payments${m.pace ? ' · ▲▼ vs yesterday at the same time' : ''} · updated ${m.updatedDay} ${m.updated} Saigon${m.recap ? ' · latest recorded metrics, not an end-of-day snapshot; velocity from the selected day' : ''}</i>`;
  return { header, glance: glance.join('\n'), rows, listTitle, footnote };
}

// Full text for previews/analysis. Sending must use the bounded pages below.
export function renderToday(m) {
  const { header, glance, rows, listTitle, footnote } = todayParts(m);
  return [header, glance, rows.length ? `<blockquote expandable>${listTitle}\n${rows.join('\n')}\n${footnote}</blockquote>` : footnote].join('\n');
}

/**
 * Page 1 is the glance plus as much of the list as fits; any overflow continues on numbered pages, each
 * list part in its own collapsed quote. A thread never splits across pages. Sizes are what Telegram
 * counts (text after entity parsing), with the footnote reserved on every page so the last one fits too.
 */
export function renderTodayPages(m) {
  const { header, glance, rows, listTitle, footnote } = todayParts(m);
  if (!rows.length) return [`${header}\n${glance}\n${footnote}`];
  const quote = (lead, part, last) => `${lead}\n<blockquote expandable>${part.join('\n')}${last ? `\n${footnote}` : ''}</blockquote>`;
  const reserveNumbers = ` · ${rows.length + 1}/${rows.length + 1}`;
  const fits = (lead, part) => telegramTextLength(quote(lead + reserveNumbers, part, true)) <= PAGE_LIMIT;
  const chunks = [];
  let current = [listTitle];
  for (const r of rows) {
    if (!fits(`${header}\n...`, [r])) throw new Error('Today card row exceeds the Telegram page limit');
    const lead = chunks.length ? header : `${header}\n${glance}`;
    if (fits(lead, [...current, r])) current.push(r);
    else { chunks.push(current); current = [r]; }
  }
  chunks.push(current);
  const n = chunks.length;
  return chunks.map((part, i) => {
    const number = n > 1 ? ` · ${i + 1}/${n}` : '';
    const lead = i === 0 ? `${header}${number}\n${glance}` : `${header}${number}`;
    return quote(lead, part, i === n - 1);
  });
}

export async function sendTodayPages(env, day, pages, { state, persist, fetchFn = fetch } = {}) {
  validateCardDay(day);
  if (!state || typeof persist !== 'function') throw new Error('Today pages require state and a persistence callback');
  if (!pages.length || pages.some((page) => typeof page !== 'string' || !page.length || telegramTextLength(page) > PAGE_LIMIT)) throw new Error('Invalid Today pages');
  const key = `today:${day}`, pageKey = (n) => n === 1 ? key : `${key}:page:${n}`;
  const results = [];
  for (let i = 0; i < pages.length; i++) {
    const result = await telegramCard(env, pages[i], 'posted', pageKey(i + 1), { state, fetchFn });
    await persist(state); // Save each successful message before attempting another.
    results.push(result);
  }
  // Retain message ids for reuse if the card grows again. Never leave stale
  // thread lists visible when today's data fits fewer pages than a prior refresh.
  const surplus = Object.keys(state.cards || {}).filter((k) => k.startsWith(`${key}:page:`) && /^\d+$/.test(k.slice(`${key}:page:`.length)) && Number(k.slice(`${key}:page:`.length)) > pages.length);
  for (const stale of surplus) {
    const result = await telegramCard(env, `📍 <b>${day}</b> · This page is no longer needed. The complete thread list is on ${pages.length > 1 ? `pages 1–${pages.length}` : 'the card above'}.`, 'posted', stale, { state, fetchFn });
    await persist(state);
    results.push(result);
  }
  return results;
}

async function main() {
  const now = new Date(), { day, recap, dry } = cardOptions(process.argv.slice(2), now), env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', ...(dry ? [] : ['TELEGRAM_CEO_BOT_TOKEN'])]);
  const at = airtable(env, env.REGISTRY_BASE_ID), gat = airtable(env, growthBase(env)), window = growthWindow(day, now);
  // Yesterday up to this same moment, for the glance's "vs yesterday" (live card only).
  const prevStart = new Date(window.start.getTime() - 86400e3), prevCut = new Date(now.getTime() - 86400e3);
  const [pc, fuel, growth, growthPrev] = await Promise.all([
    at.listAll(REGISTRY_TABLE, { fields: ['Post', 'Account', 'Type', 'Tweet Views', 'Status', 'Draft ID', 'X URL', 'Typefully Link', 'Posted Date', 'Scheduled For', 'Impressions', 'Lifetime Clicks', 'Affiliate Clicks', 'Fuel Spend', 'Fuel Tiers'] }),
    at.listAll(FUEL_LOG),
    gat.listAll(GROWTH_LOG, { formula: `AND(NOT(IS_BEFORE({At}, "${window.start.toISOString()}")), IS_BEFORE({At}, "${window.end.toISOString()}"))`, fields: ['X URL', 'At', 'Rise/hr', 'Views'] }),
    recap ? Promise.resolve([]) : gat.listAll(GROWTH_LOG, { formula: `AND(NOT(IS_BEFORE({At}, "${prevStart.toISOString()}")), NOT(IS_AFTER({At}, "${prevCut.toISOString()}")))`, fields: ['X URL', 'At', 'Views'] }),
  ]);
  let facts = []; try { facts = readFileSync(join(HERE_DIR, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch {}
  const rates = measureRates(facts, { now: now.getTime() });
  const names = Object.values(ACCOUNTS).filter((a) => !a.paused).map((a) => a.name);
  const pages = renderTodayPages(buildTodayModel({ rows: pc.map((r) => r.fields), fuel: fuel.map((r) => r.fields), growth: growth.map((r) => r.fields), growthPrev: growthPrev.map((r) => r.fields),
    accountNames: names, rates, now, day, recap, todayView: TODAY_VIEW.url || null }));
  console.log(pages.join('\n\n---\n\n').replace(/<[^>]+>/g, ''));
  if (dry) return;
  let state = { cards: {} }; try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
  // Reuse Posts: this card replaces its old publish stream plus the Performance digest.
  const results = await sendTodayPages(env, day, pages, { state, persist: (saved) => writeFileSync(STATE_FILE, JSON.stringify(saved, null, 2) + '\n') });
  console.log(`Telegram Today: ${pages.length} active page(s); ${results.map((r) => r.action).join(', ')}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'today-card');
