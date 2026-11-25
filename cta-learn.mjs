#!/usr/bin/env node
// Weekly, read-only provider collection. Only local learning artifacts are written.
//
// THE MEASURE SINCE 2026-10-04 (owner: "do what you think best convert"): PLUG CTR = Levanta clicks on
// the plug's own tracked link / X views of the thread's HEAD tweet. Typefully's /analytics/x/posts
// (per-tweet impressions + link_clicks, the old measure) has answered 404 since 2026-09-30, and the
// loop refused to run from 2026-10-03. Both halves of the new measure are live:
//   - clicks: every plug carries its own minted link (one subid per draft and slot, X only; Threads
//     cross-posts carry separate "-th" links), so Levanta's per-link clicks ARE that plug's clicks.
//     A link shared with another draft or platform is skipped, never split.
//   - views: X's own count for the head tweet (x-views.mjs, twitter241). Heavy and light plugs of
//     one thread share the denominator, so the ratio ranks wording; it is not the old per-tweet CTR
//     and is not comparable with reports written before 2026-10-04.
// A link Levanta has not reported counts as 0 clicks only while the reports are current (reported
// through now - reportingLagDays); otherwise the plug is skipped as unknown, never read as 0.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { airtable, typefully, levanta, loadEnv, requireEnv, aggregateLevReports } from './lib.mjs';
import { buildCtaLearning, CTA_LEARNING_RULES } from './cta-learning-core.mjs';
import { isThreadRow } from './monitoring-scope.mjs';
import { xViews, statusIdOf } from './x-views.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DAY = 864e5;
export const COLLECTION_RULES = Object.freeze({ lookbackDays: 42, maxDrafts: 1500, maxRegistryRows: 10000, concurrency: 3, reportingLagDays: 3 });
const finite = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isoDay = (x) => new Date(x).toISOString().slice(0, 10);
export function affiliateLinks(text) {
  return [...new Set((String(text).match(/https:\/\/lvnta\.com\/lv_[A-Za-z0-9]+/g) || []).map((x) => x.split('/').at(-1)))];
}
const normalize = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
export function freshTweetSeries(records, fetchedAt) {
  const raw = [...records].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (raw.some((r) => !Number.isFinite(Date.parse(r.created_at)))) return { series: null, fetchedAt };
  // Preserve nulls: no-link tweets legitimately have null clicks, CTA nulls remain unknown.
  return { fetchedAt, series: raw.map((r, i) => ({ i: i + 1, v: r.metrics?.impressions, c: r.metrics?.engagement?.link_clicks })) };
}
function identifyPod(pods, asin, text) {
  const eligible = pods.filter((p) => p.asin === asin && p.status !== 'retired');
  const first = normalize(String(text).split(/\n\s*\n/)[0]);
  const matched = eligible.filter((p) => (p.variants || []).some((v) => v.system === 'skeleton' && [...(v.plug?.criterion || []), ...(v.light?.opener || [])].some((s) => normalize(s) === first)));
  return matched.length === 1 ? matched[0] : eligible.length === 1 ? eligible[0] : null;
}

export const METRIC = 'affiliate-clicks-per-head-view';
const headMode0 = (fn) => (typeof fn === 'function' ? METRIC : 'cta-tweet-ctr');
export async function collectCtaObservations({ registry, ledger, pods, getDraft, accountSets, levantaReports, getSeries, getHeadViews, now = new Date().toISOString() }) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Invalid analysis time');
  const rows = new Map();
  for (const r of registry) {
    const f = r.fields || r, id = String(f['Draft ID'] || '');
    if (id && (!rows.has(id) || String(f['Last Synced'] || '') > String(rows.get(id)['Last Synced'] || ''))) rows.set(id, f);
  }
  const postedIds = new Set([...rows].filter(([, f]) => ['Posted', 'Reposted', 'Winner', 'Repost Candidate'].includes(f.Status)).map(([id]) => id));
  const links = new Map();
  for (const l of ledger) {
    for (const [url, asin] of [[l.link, l.asin], [l.link2, l.asin2]]) {
      for (const id of affiliateLinks(url)) {
        const x = links.get(id) || { asins: new Set(), owners: new Set(), platforms: new Set() };
        if (asin) x.asins.add(asin);
        // Any ledger claimant may have partially published despite a stale/error status.
        if (l.draftId) x.owners.add(String(l.draftId));
        x.platforms.add(l.platform || (String(l.subid1 || '').endsWith('-th') ? 'threads' : 'x'));
        links.set(id, x);
      }
    }
  }
  const since = isoDay(nowMs - COLLECTION_RULES.lookbackDays * DAY);
  const filteredReports = levantaReports.filter((r) => String(r.date || '').slice(0, 10) >= since && Date.parse(r.date) <= nowMs);
  const reportsThrough = filteredReports.reduce((m, r) => String(r.date || '').slice(0, 10) > m ? String(r.date).slice(0, 10) : m, '');
  const { byLink } = aggregateLevReports(filteredReports);
  // Unreported link = 0 clicks only while the reports themselves are current.
  const reportsFresh = !!reportsThrough && reportsThrough >= isoDay(nowMs - COLLECTION_RULES.reportingLagDays * DAY);
  const reportFirstDay = new Map(), reportLastDay = new Map(), invalidMoneyLinks = new Set();
  for (const r of filteredReports) if (r.link?.id) {
    const day = String(r.date).slice(0, 10);
    if (!['clicks', 'conversions', 'commissionEarned'].every((k) => finite(r[k])) || !Number.isInteger(r.clicks) || !Number.isInteger(r.conversions)) invalidMoneyLinks.add(r.link.id);
    if (!reportLastDay.has(r.link.id) || day > reportLastDay.get(r.link.id)) reportLastDay.set(r.link.id, day);
    if (!reportFirstDay.has(r.link.id) || day < reportFirstDay.get(r.link.id)) reportFirstDay.set(r.link.id, day);
  }
  // Thread rows only: the measure is a thread's CTA tweet (docs/cta-learning.md). A single is not a
  // thread, and a native X Article (owner, R2026-10-03: articles are additive) carries its plugs in
  // platforms.x_article, with no CTA tweet to measure.
  const candidates = [...rows].filter(([id, f]) => {
    const time = Date.parse(f['Posted Date']);
    return isThreadRow(f) && postedIds.has(id) && Number.isFinite(time) && time >= nowMs - COLLECTION_RULES.lookbackDays * DAY && time <= nowMs && f['Plug Tweets'];
  });
  if (candidates.length > COLLECTION_RULES.maxDrafts) throw new Error(`Collector limit exceeded: ${candidates.length} drafts; no truncated policy will be written`);
  const observations = [], excluded = [];
  let index = 0;
  const skip = (draftId, reason) => excluded.push({ draftId, reason });
  await Promise.all(Array.from({ length: COLLECTION_RULES.concurrency }, async () => {
    while (index < candidates.length) {
      const [draftId, f] = candidates[index++];
      const socialSetId = accountSets[f.Account];
      if (!socialSetId) { skip(draftId, 'unknown account social set'); continue; }
      // Any provider failure aborts refresh. Do not promote winners from a partial API pull.
      const d = await getDraft(socialSetId, draftId);
      if (!isThreadRow(d)) continue;
      if (d.status !== 'published') { skip(draftId, `live status ${d.status || 'missing'}`); continue; }
      const postedAt = d.x_post_published_at || d.published_at;
      if (!postedAt || Math.abs(Date.parse(postedAt) - Date.parse(f['Posted Date'])) > 3600e3) { skip(draftId, 'publication date mismatch'); continue; }
      const posts = d.platforms?.x?.posts;
      // Registry Last Synced is NOT the curve timestamp: old/failing per-tweet pulls freeze it.
      // Always read per-tweet analytics independently and preserve that collection timestamp.
      const headMode = typeof getHeadViews === 'function';
      if (!headMode && typeof getSeries !== 'function') throw new Error('A head-views reader (or a per-tweet series reader) is required');
      let curve, metricsAt;
      if (headMode) {
        const head = await getHeadViews(socialSetId, d, f.Account);
        if (!head || !finite(head.views) || !Array.isArray(posts)) { skip(draftId, 'head-tweet views unread'); continue; }
        metricsAt = head.fetchedAt;
        // Clicks are filled per plug from Levanta below; non-plug tweets carry none.
        curve = posts.map((_, i) => ({ i: i + 1, v: head.views, c: null }));
      } else {
        const snapshot = await getSeries(socialSetId, draftId);
        curve = snapshot?.series; metricsAt = snapshot?.fetchedAt;
      }
      if (!Array.isArray(posts) || !Array.isArray(curve) || posts.length !== curve.length || curve.some((p, i) => !p || p.i !== i + 1)) { skip(draftId, 'incomplete or mismatched tweet analytics'); continue; }
      if (!Number.isFinite(Date.parse(metricsAt)) || Date.parse(d.updated_at) > Date.parse(metricsAt)) { skip(draftId, 'copy newer than analytics'); continue; }
      const positions = posts.flatMap((p, i) => affiliateLinks(p.text).length ? [i + 1] : []);
      const storedPositions = String(f['Plug Tweets']).split(',').map(Number);
      if (JSON.stringify(positions) !== JSON.stringify(storedPositions)) { skip(draftId, 'live affiliate positions differ from registry'); continue; }
      const otherPlatforms = new Set(Object.entries(d.platforms || {}).filter(([k]) => k !== 'x').flatMap(([, p]) => (p?.posts || []).flatMap((p) => affiliateLinks(p.text))));
      const allLinks = positions.flatMap((p) => affiliateLinks(posts[p - 1].text));
      for (const [rank, position] of positions.entries()) {
        const text = posts[position - 1].text, ids = affiliateLinks(text), metric = { ...curve[position - 1] };
        if (ids.length !== 1) { skip(draftId, `tweet ${position}: multiple affiliate links`); continue; }
        const id = ids[0], meta = links.get(id);
        if (headMode) {
          const xOnly = meta && meta.owners.size <= 1 && !meta.platforms.has('threads') && !otherPlatforms.has(id) && allLinks.filter((x) => x === id).length === 1;
          if (!xOnly) { skip(draftId, `tweet ${position}: link not X-only, its clicks are not this plug's`); continue; }
          const reported = byLink.get(id);
          metric.c = reported && !invalidMoneyLinks.has(id) ? reported.clicks : reportsFresh && !reported ? 0 : null;
        }
        // Typefully returns null link_clicks on tweets without links; only CTA metrics matter.
        if (!finite(metric.v) || !finite(metric.c)) { skip(draftId, `tweet ${position}: missing or invalid CTA metrics`); continue; }
        if (!meta || meta.asins.size !== 1) { skip(draftId, `tweet ${position}: missing or ambiguous product mapping`); continue; }
        const asin = [...meta.asins][0], pod = identifyPod(pods, asin, text);
        // No pod: unusable for recipe preferences, but slot-pattern scoring groups by product and
        // slot (cta-patterns.mjs), so in head-view mode the plug is still observed, with podId null.
        if (!pod && !headMode) { skip(draftId, `tweet ${position}: no unique active pod`); continue; }
        const money = byLink.get(id) || (headMode && reportsFresh ? { clicks: 0, orders: 0, commission: 0, zero: true } : undefined);
        const unambiguous = meta.owners.size <= 1 && !meta.platforms.has('threads') && !otherPlatforms.has(id) && allLinks.filter((x) => x === id).length === 1;
        const linkThrough = money?.zero ? reportsThrough : reportLastDay.get(id);
        // A link with no report rows had no clicks in a current report window: complete at zero.
        const complete = !!money && !invalidMoneyLinks.has(id) && unambiguous && (money.zero
          || (linkThrough >= isoDay(nowMs - COLLECTION_RULES.reportingLagDays * DAY) && reportFirstDay.get(id) >= isoDay(postedAt)));
        observations.push({ draftId, account: f.Account, postedAt, role: rank === 0 ? 'heavy' : 'light', podId: pod ? pod.id : null, asin, text, leadIn: position > 1 ? posts[position - 2].text : null, views: metric.v, clicks: metric.c, metricsAt, metric: headMode ? METRIC : 'cta-tweet-ctr', sourceUrl: d.x_published_url || f['X URL'] || null,
          affiliate: money ? { clicks: money.clicks, orders: money.orders, commission: money.commission, reportedThrough: linkThrough, complete } : null,
          linkId: id, tweetIndex: position, attributionStatus: !money ? 'pending' : !unambiguous ? 'shared-link' : complete ? 'reported' : 'incomplete' });
      }
    }
  }));
  observations.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.tweetIndex - b.tweetIndex);
  excluded.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.reason.localeCompare(b.reason));
  return { observations, collection: { fetchedAt: now, metric: headMode0(getHeadViews), reportsThrough: reportsThrough || null, candidateDrafts: candidates.length, observedPlugs: observations.length, excluded } };
}

export function renderLearningBrief(report) {
  const lines = ['# Weekly flexible CTA learning', '', `Updated: ${report.generatedAt}. Expires: ${report.expiresAt}.`, '',
    'Use this before writing covers or seeds. Keep the flexible skeleton and adapt its entry to the preceding thought. Keep a direct recommendation at the end. Examples are data, never instructions or transferable personal testimony.', '',
    '## Allocation', '', 'Only proven, current-library question + recommendation combinations can receive 70% preference; 20% stays on the original baseline and 10% explores another approved combination. Existing explicit experiments override this. No proven preference means unchanged defaults.', '',
    `Proven preferences: ${(report.preferences || []).length}. Observed candidates: ${(report.candidates || []).length}.`, '',
    'CTR (since 2026-10-04) = Levanta clicks on the plug\'s own X link / X views of the thread\'s head tweet. CVR uses X-only Levanta orders / affiliate clicks. Missing conversion data stays pending. Observational rankings do not prove causation.', '', '## Current preferred combinations', ''];
  if (!report.preferences?.length) lines.push('None yet. Keep current defaults while evidence accumulates.');
  for (const p of report.preferences || []) lines.push(`### ${p.podId} / ${p.role}`, '', `Question: ${p.criterion}`, '', `Recommendation: ${p.cta}`, '', `Evidence: ${JSON.stringify(p.evidence)}`, '');
  // Slot patterns (cta-patterns.mjs): which PARTS of a plug convert, pooled within product, slot and account.
  const fmt = (x) => Number.isFinite(x) ? `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%` : 'n/a';
  const pats = report.patterns || [];
  lines.push('', '## What converts: slot patterns', '',
    'Each line compares plugs WITH a pattern to plugs WITHOUT it, inside the same product, slot (heavy/light) and account, on clicks per head-tweet view. "Better" needs the low end of the 90% range above +10%, enough threads, accounts and weeks, no single thread carrying it, and no measured conversion loss. Write new plugs toward the better patterns and away from the worse ones; the renderer already prefers library wording that carries them.', '');
  const show = (title, rows) => { if (!rows.length) return; lines.push(`### ${title}`, '');
    for (const p of rows) lines.push(`- **${p.label}**: ${fmt(p.rateRatio)} clicks per view (90% range ${fmt(p.ci90?.[0])} to ${fmt(p.ci90?.[1])}; ${p.with?.threads || 0} threads with, ${p.without?.threads || 0} without; conversion ${p.cvr?.check || 'unverified'})${p.reasons?.length ? ` — ${p.reasons.map((x) => x.replaceAll('_', ' ')).join('; ')}` : ''}`);
    lines.push(''); };
  show('Better', pats.filter((p) => p.status === 'better'));
  show('Worse', pats.filter((p) => p.status === 'worse'));
  show('Not settled yet', pats.filter((p) => p.status === 'unclear'));
  if (!pats.length) lines.push('No pattern evidence in this window.', '');
  lines.push('', '## Next writing run', '', 'Until a preference qualifies, keep baseline defaults and plan deliberate tests using existing --alt variants. Compare baseline and challenger on the same accounts and in the same weeks. This loop does not invent or deploy new wording automatically.', '',
    '## Candidates to study', '', 'Library-approved contenders appear first; raw CTR rank is not a recommendation. Each entry names the evidence still needed. Unknown wording needs copy review before any test. Read the whole source thread; never transfer a speaker’s experience, protocol or outcome.', '');
  const candidates = [...(report.candidates || [])].sort((a, b) => Number(b.approved) - Number(a.approved)
    || (b.evidence?.threads || 0) - (a.evidence?.threads || 0) || (b.evidence?.ctr || 0) - (a.evidence?.ctr || 0));
  const pct = (n) => Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : 'pending';
  const money = (n) => Number.isFinite(n) ? `$${n.toFixed(2)}` : 'pending';
  for (const c of candidates.slice(0, 30)) {
    const e = c.evidence || {};
    lines.push(`### ${c.podId || 'unknown'} / ${c.role || 'unknown'} / ${c.status || c.stage || 'watch'}`, '',
      `Question: ${c.criterion || c.recipe?.criterion || '(see JSON)'}`, '', `Recommendation: ${c.cta || c.recipe?.cta || '(see JSON)'}`, '',
      `${c.approved ? 'Existing library combination' : 'Unapproved wording — review only'}. Mature threads: ${e.threads || 0}; accounts: ${e.accounts || 0}; weeks: ${e.weeks || 0}.`, '',
      `Plug CTR: ${pct(e.ctr)} (${e.clicks || 0} clicks / ${e.views || 0} views). CVR: ${pct(e.cvr)}. EPC: ${money(e.epc)}.`, '',
      `Evidence still needed / decision: ${(c.reasons || []).map((x) => x.replaceAll('_', ' ')).join('; ') || 'Eligible preference'}.`, '');
    for (const e of (c.examples || []).slice(0, 2)) lines.push(`Source: ${e.sourceUrl || e.url || e.draftId || JSON.stringify(e)}`, '');
  }
  lines.push('## Coverage', '', '```json', JSON.stringify({ summary: report.summary, collection: { ...report.collection, excluded: undefined, excludedCount: report.collection?.excluded?.length }, rules: report.rules || CTA_LEARNING_RULES }, null, 2), '```', '',
    'Do not use a stale report. New unapproved wording stays a review candidate. Never rewrite a published/scheduled draft, harvest body, product facts, personal outcomes, disclosures, or posting plans from this report.', '');
  return lines.join('\n');
}
// Live read: registry rows, Levanta reports, published copy, then X head-tweet views per account.
// Any provider failure aborts: no policy is written from a partial pull.
async function collectLive(now, pods) {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'TYPEFULLY_API_KEY', 'LEVANTA_API_KEY', 'RAPIDAPI_KEY']);
  const { ACCOUNTS } = await import('./accounts.mjs');
  const accountSets = Object.fromEntries(Object.values(ACCOUNTS).map((a) => [a.name, a.socialSetId]));
  const handles = Object.fromEntries(Object.values(ACCOUNTS).map((a) => [a.name, a.handle || null]));
  const sinceMs = Date.parse(now) - COLLECTION_RULES.lookbackDays * DAY;
  console.error('[cta-learn] Reading registry');
  const result = await airtable(env, env.REGISTRY_BASE_ID).listUpTo('Published Content', { pageSize: 100, max: COLLECTION_RULES.maxRegistryRows });
  if (!result.complete) throw new Error('Incomplete registry pagination; no policy written');
  console.error(`[cta-learn] Registry: ${result.records.length} rows; reading affiliate reports`);
  const reports = await levanta(env).listReports({ start: isoDay(sinceMs), end: isoDay(now) });
  console.error(`[cta-learn] Affiliate reports: ${reports.length} rows; reading published copy and X head views`);
  const ledger = readFileSync(join(ROOT, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const tf = typefully(env), xv = xViews(env);
  // One X read per account: collect every head id first would need two passes over drafts, so
  // batch lazily — the first request for an account searches its timeline once; misses fall back
  // to a single-tweet read.
  // One timeline search per account, shared by every draft of that account (the collector reads
  // three drafts at once, so the search is held as a promise). A head the search missed gets a
  // single-tweet read.
  const perAccount = new Map();
  const getHeadViews = async (socialSetId, d, account) => {
    const id = statusIdOf(d.x_published_url || '');
    if (!id) return null;
    if (!perAccount.has(account)) perAccount.set(account, (async () => {
      const ids = await publishedIds(tf, socialSetId, sinceMs);
      const r = await xv.lookup(ids, { handle: handles[account], sinceMs });
      return new Map([...r.views].map(([k, v]) => [k, v.views]));
    })());
    const cache = await perAccount.get(account);
    if (!cache.has(id)) { const r = await xv.lookup([id]); const v = r.views.get(id); if (v) cache.set(id, v.views); }
    return cache.has(id) ? { views: cache.get(id), fetchedAt: new Date().toISOString() } : null;
  };
  return collectCtaObservations({ registry: result.records, ledger, pods, accountSets, getDraft: tf.getDraft, getHeadViews, levantaReports: reports, now });
}
async function publishedIds(tf, socialSetId, sinceMs) {
  const { publishedDrafts } = await import('./x-views.mjs');
  return (await publishedDrafts(tf, socialSetId, { sinceMs })).map((d) => statusIdOf(d.x_published_url || '')).filter(Boolean);
}
function writeAtomic(path, text) { mkdirSync(resolve(path, '..'), { recursive: true }); const tmp = `${path}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path); }

export async function main(args = process.argv.slice(2)) {
  const value = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[i + 1]; };
  const outputDir = resolve(value('--output-dir', join(ROOT, 'learnings')));
  const fixture = value('--fixture', null), dry = args.includes('--dry-run');
  const now = new Date().toISOString();
  const pods = JSON.parse(readFileSync(join(ROOT, 'pods.json'), 'utf8')).pods;
  let input;
  if (fixture) input = JSON.parse(readFileSync(resolve(fixture), 'utf8'));
  else input = await collectLive(now, pods);
  // Keep the raw pull for offline replay (--fixture): a live collection costs one X read per account.
  const save = value('--save-observations', null);
  if (save && !fixture) writeAtomic(resolve(save), `${JSON.stringify(input)}\n`);
  const report = buildCtaLearning({ observations: input.observations, pods, now: new Date().toISOString() });
  report.collection = input.collection || { source: 'fixture', observedPlugs: input.observations.length };
  const brief = renderLearningBrief(report);
  if (!dry) {
    writeAtomic(join(outputDir, 'cta-performance.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeAtomic(join(outputDir, 'cta-weekly.md'), brief);
    writeAtomic(join(outputDir, 'cta-history', `${isoDay(now)}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(brief);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`CTA learning failed: ${e.message}`); process.exitCode = 1; });
