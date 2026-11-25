// Read-only audit of data already fetched by registry-sync. This verifies persistence,
// not independent financial reconciliation against a second accounting source.
const fieldsOf = (row) => row?.fields || row || {};
const draftId = (row) => String(fieldsOf(row)['Draft ID'] ?? '').trim();
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const moneyField = (name) => /Commission|Sales|Revenue|EPC/.test(name);
const blank = (value) => value == null || value === '';
function equivalent(expected, actual, field) {
  if (blank(expected) && blank(actual)) return true;
  if (expected === false && blank(actual)) return true; // unchecked Airtable checkbox is omitted
  if (typeof expected === 'number') {
    // Airtable omits empty numeric cells, but never equate a missing value to zero.
    if (!finite(expected) || !finite(actual)) return false;
    if (moneyField(field)) return Math.abs(expected - actual) < 0.005000001;
    if (Number.isInteger(expected)) return expected === actual;
    // Ratio fields can round at the provider's floating-point serialization boundary.
    return Math.abs(expected - actual) <= 1e-12 * Math.max(1, Math.abs(expected));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return expected.length === 0 && blank(actual);
    return JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());
  }
  if (typeof expected === 'string' && /Date|Synced|At$|^Scheduled For$/.test(field)) {
    const a = Date.parse(expected), b = Date.parse(actual);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}
function indexRows(rows) {
  const index = new Map();
  for (const row of rows) {
    const id = draftId(row);
    if (id) index.set(id, [...(index.get(id) || []), row]);
  }
  return index;
}
const sum = (rows, field) => rows.reduce((total, row) => total + (finite(fieldsOf(row)[field]) ? fieldsOf(row)[field] : 0), 0);
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function inspectRegistryQuality({ completeRows = [], writtenRows = completeRows, expectedRows = writtenRows,
  actualRecords = [], levantaByLink = new Map(), byLvId = new Map(),
  existingRecords = [], inventoryDraftIds = [], inventoryComplete = false,
  inventoryCounts = {}, analyticsDraftIds = null, analyticsSinceMs = null, now = new Date() } = {}) {
  const current = indexRows(actualRecords), built = indexRows(completeRows);
  const duplicateDraftIds = [...new Set([...current, ...built].filter(([, rows]) => rows.length > 1).map(([id]) => id))];
  const writeMismatches = [];
  for (const row of expectedRows) {
    const expected = fieldsOf(row), id = draftId(row), candidates = current.get(id) || [];
    if (!id || candidates.length !== 1) {
      writeMismatches.push({ draftId: id, field: 'record', reason: !id ? 'missing_draft_id' : candidates.length ? 'duplicate_record' : 'missing_record' });
      continue;
    }
    const actual = fieldsOf(candidates[0]);
    for (const [field, value] of Object.entries(expected)) {
      // Undefined properties are omitted from the JSON API request, preserving
      // existing fields; they are not assertions that the stored cell is empty.
      if (value === undefined) continue;
      if (!equivalent(value, actual[field], field)) writeMismatches.push({ draftId: id, field, reason: 'value_mismatch' });
    }
  }
  const active = actualRecords.filter((r) => fieldsOf(r).Archived !== true);
  const publishedStatuses = new Set(['Posted', 'Reposted', 'Winner', 'Repost Candidate']);
  const published = active.filter((row) => publishedStatuses.has(fieldsOf(row).Status));
  const positiveViews = published.filter((r) => finite(fieldsOf(r).Impressions) && fieldsOf(r).Impressions > 0);
  const zeroViews = published.filter((r) => fieldsOf(r).Impressions === 0);
  const missingViews = published.filter((r) => blank(fieldsOf(r).Impressions));
  const invalidViews = published.filter((r) => !blank(fieldsOf(r).Impressions) && (!finite(fieldsOf(r).Impressions) || fieldsOf(r).Impressions < 0));
  const analyticsIds = analyticsDraftIds == null ? null : new Set([...analyticsDraftIds].map(String));
  // Only rows the run ASKED X about can be missing a reading. The X read covers posts published since
  // analyticsSinceMs (3d, 21d on --full); every older row keeps its last views by design. Counting
  // those older rows flagged ~1,465 rows every run (2026-10-06) and read as a dead feed when it was not.
  // A row with no Posted Date cannot be placed outside the window, so it still counts.
  const inViewsWindow = (r) => analyticsSinceMs == null || !(Date.parse(fieldsOf(r)['Posted Date'] || '') < analyticsSinceMs);
  const publishedWithoutCurrentAnalytics = analyticsIds == null ? null : published.filter((r) => inViewsWindow(r) && !analyticsIds.has(draftId(r))).length;
  const zeroViewsConfirmed = analyticsIds == null ? null : zeroViews.filter((r) => analyticsIds.has(draftId(r))).length;
  const zeroViewsUnverified = analyticsIds == null ? zeroViews.length : zeroViews.length - zeroViewsConfirmed;
  const paired = positiveViews.filter((r) => finite(fieldsOf(r)['Lifetime Commission']));
  const views = sum(paired, 'Impressions'), commission = sum(paired, 'Lifetime Commission');
  let unclaimedLinks = 0, unclaimedCommission = 0, unclaimedClicks = 0, unclaimedOrders = 0, invalidLevantaMetrics = 0;
  const unclaimedDetails = [];
  for (const [id, metrics] of levantaByLink) {
    if (byLvId.get(id)) continue;
    unclaimedLinks++;
    unclaimedDetails.push({ linkId: String(id), commission: finite(metrics?.commission) ? round(metrics.commission) : null,
      clicks: finite(metrics?.clicks) ? metrics.clicks : null, orders: finite(metrics?.orders) ? metrics.orders : null });
    for (const key of ['commission', 'clicks', 'orders']) if (metrics?.[key] != null && !finite(metrics[key])) invalidLevantaMetrics++;
    unclaimedCommission += finite(metrics?.commission) ? metrics.commission : 0;
    unclaimedClicks += finite(metrics?.clicks) ? metrics.clicks : 0;
    unclaimedOrders += finite(metrics?.orders) ? metrics.orders : 0;
  }
  const nowMs = new Date(now).getTime(), inventory = new Set([...inventoryDraftIds].map(String));
  const stale = active.filter((r) => {
    const date = Date.parse(fieldsOf(r)['Last Synced']);
    return !Number.isFinite(date) || (Number.isFinite(nowMs) && nowMs - date > 24 * 3600_000);
  });
  // A complete inventory, not absence from the monetized ledger, establishes an orphan.
  const orphans = inventoryComplete ? active.filter((r) => draftId(r) && !inventory.has(draftId(r))) : [];
  const emptyRows = active.filter((r) => !draftId(r));
  const warnings = [];
  const warn = (code, count) => { if (count) warnings.push({ code, count }); };
  warn('unclaimed_levanta_links', unclaimedLinks);
  warn('invalid_levanta_metrics', invalidLevantaMetrics);
  warn('published_missing_views', missingViews.length);
  warn('published_invalid_views', invalidViews.length);
  warn('published_zero_views_unverified', zeroViewsUnverified);
  warn('published_without_current_analytics', publishedWithoutCurrentAnalytics);
  warn('active_last_changed_over_24h_or_missing', stale.length);
  warn('active_absent_from_complete_inventory', orphans.length);
  warn('active_missing_draft_id', emptyRows.length);
  return {
    schemaVersion: 1,
    verificationScope: 'Authoritative expected fields compared with post-write Airtable reads; not independent financial reconciliation.',
    hardFailure: duplicateDraftIds.length > 0 || writeMismatches.length > 0,
    duplicateDraftIds, writeMismatches, warnings,
    counts: { built: completeRows.length, written: writtenRows.length, verified: expectedRows.length, actual: actualRecords.length, existing: existingRecords.length,
      inventory: inventory.size, inventoryComplete, active: active.length, published: published.length,
      staleActive: stale.length, orphanActive: orphans.length, emptyActive: emptyRows.length },
    inventoryCounts,
    coverage: { positiveViews: positiveViews.length, zeroViews: zeroViews.length, missingViews: missingViews.length,
      invalidViews: invalidViews.length, zeroViewsConfirmed, zeroViewsUnverified,
      publishedWithoutCurrentAnalytics,
      analyticsCoverageKnown: analyticsIds !== null, analyticsSince: Number.isFinite(analyticsSinceMs) ? new Date(analyticsSinceMs).toISOString() : null, commissionAndPositiveViews: paired.length,
      positiveViewsMissingCommission: positiveViews.length - paired.length },
    totals: { publishedLifetimeCommission: round(sum(published, 'Lifetime Commission')),
      publishedLifetimeClicks: sum(published, 'Lifetime Clicks'), publishedLifetimeOrders: sum(published, 'Lifetime Orders'),
      pairedViews: views, pairedLifetimeCommission: round(commission),
      commissionPer100kViews: views > 0 ? round(commission / views * 100_000) : null,
      benchmarkCaveat: 'Lifetime attributed commission may include Threads; impressions are X views. Paired positive-view rows only.' },
    unclaimed: { links: unclaimedLinks, commission: round(unclaimedCommission), clicks: unclaimedClicks, orders: unclaimedOrders, details: unclaimedDetails,
      scope: 'Fresh Levanta reporting window, not lifetime.' },
  };
}

// Never interpolate arbitrary stage details, errors, record titles, IDs, or warning text
// into a GitHub summary. Only fixed prose, allowlisted status, and finite numbers.
const display = (n) => finite(n) ? String(n) : 'unavailable';
export function renderQualityMarkdown(report = {}) {
  const status = ['running', 'completed', 'degraded', 'failed'].includes(report.status) ? report.status : 'unknown';
  const a = report.audit;
  const lines = ['## Registry sync quality', '', `Status: **${status}**`, ''];
  const stages = Array.isArray(report.stages) ? report.stages : [];
  lines.push(`Stages: ${stages.filter((s) => s.status === 'completed').length} completed; ${stages.filter((s) => s.status === 'failed').length} failed.`, '');
  if (!a) return lines.concat('Audit unavailable; no completeness claim can be made.', '').join('\n');
  lines.push(`Records: ${display(a.counts?.actual)}; published: ${display(a.counts?.published)}; written: ${display(a.counts?.written)}; verified: ${display(a.counts?.verified)}.`,
    `Duplicate draft IDs: ${display(a.duplicateDraftIds?.length)}; write mismatches: ${display(a.writeMismatches?.length)}.`,
    `Active rows with old/missing Last Synced: ${display(a.counts?.staleActive)}. Last Synced can mean last changed on delta runs.`,
    `Active rows absent from a complete inventory: ${a.counts?.inventoryComplete ? display(a.counts?.orphanActive) : 'not assessed'}.`, '',
    `Published view coverage: ${display(a.coverage?.positiveViews)} positive; ${display(a.coverage?.zeroViews)} zero; ${display(a.coverage?.missingViews)} missing; ${display(a.coverage?.invalidViews)} invalid.`,
    `Zero-view rows without confirmed analytics coverage: ${display(a.coverage?.zeroViewsUnverified)}. Zero is not automatically evidence of poor performance.`, '',
    `Published rows${a.coverage?.analyticsSince ? ` posted since ${a.coverage.analyticsSince.slice(0, 10)} (this run's X views window)` : ''} with no X views read this run: ${display(a.coverage?.publishedWithoutCurrentAnalytics)}. Older rows keep their last views and are refreshed by the daily full run.`, '',
    `Weighted commission per 100k views: ${a.totals?.commissionPer100kViews == null ? 'unavailable' : '$' + display(a.totals.commissionPer100kViews)} (${display(a.coverage?.commissionAndPositiveViews)} paired positive-view rows).`,
    'This is blended lifetime attributed commission against X views, not a pure X earnings rate.', '',
    `Unclaimed Levanta links: ${display(a.unclaimed?.links)}; commission: $${display(a.unclaimed?.commission)}; clicks: ${display(a.unclaimed?.clicks)}; orders: ${display(a.unclaimed?.orders)} (fresh reporting window, not lifetime).`, '',
    'Verification compares authoritative expected fields with post-write Airtable reads. It is not an independent financial reconciliation.', '');
  return lines.join('\n');
}
