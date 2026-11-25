#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { railOf } from '../lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function auditLedger({ text, factsText = '', at = new Date() }) {
  const lines = text.split('\n').filter(Boolean);
  const buckets = { malformed: 0, unmonetized_or_unknown_rail: 0, recovery_without_subid: 0, tracked_missing_subid: 0, tracked_join_key_present: 0 };
  const samples = Object.fromEntries(Object.keys(buckets).map((key) => [key, []]));
  let newest = null, mature = 0, unsettled = 0, invalidTimestamps = 0;
  const seen = new Map();
  const byRail = {}, byAccount = {}, byCohort = {};
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { buckets.malformed++; if (samples.malformed.length < 3) samples.malformed.push({ line_number: buckets.malformed }); continue; }
    const stamp = Date.parse(row.ts);
    if (Number.isFinite(stamp)) { newest = newest === null ? stamp : Math.max(newest, stamp); (at.getTime() - stamp >= 48 * 3_600_000 ? mature++ : unsettled++); } else invalidTimestamps++;
    const rail = railOf(row.link);
    byRail[rail] = (byRail[rail] || 0) + 1;
    const account = row.account || 'unassigned'; byAccount[account] = (byAccount[account] || 0) + 1;
    const cohort = Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 7) : 'unknown'; byCohort[cohort] = (byCohort[cohort] || 0) + 1;
    let bucket;
    if (rail === 'other') bucket='unmonetized_or_unknown_rail';
    else if (!row.subid1 && (row.mode === 'backfill' || row.subidLost)) bucket='recovery_without_subid';
    else if (!row.subid1) bucket='tracked_missing_subid';
    else bucket='tracked_join_key_present';
    buckets[bucket]++; if (samples[bucket].length < 3) samples[bucket].push({ draft_id: row.draftId || null, account: row.account || null, timestamp: row.ts || null });
    if (bucket === 'tracked_join_key_present') { if (!seen.has(row.subid1)) seen.set(row.subid1, []); seen.get(row.subid1).push(row); }
  }
  const duplicate_claimants = [...seen.values()].filter((rows) => {
    const threads = rows.filter((row) => row.mode !== 'mint');
    return new Set(threads.map((row) => String(row.recId || '').slice(-6))).size > 1
      && new Set(threads.map((row) => row.draftId)).size > 1;
  }).length;
  const classified = Object.values(buckets).reduce((a, b) => a + b, 0);
  const ledgerDrafts = new Set([...text.split('\n').filter(Boolean)].flatMap((line) => { try { const row = JSON.parse(line); return row.draftId ? [String(row.draftId)] : []; } catch { return []; } }));
  const facts = factsText.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const factBuckets = { manual_or_untracked: 0, tracked_joined_to_ledger: 0, tracked_missing_ledger: 0 };
  for (const row of facts) {
    if (!row.subid1) factBuckets.manual_or_untracked++;
    else if (ledgerDrafts.has(String(row.draftId))) factBuckets.tracked_joined_to_ledger++;
    else factBuckets.tracked_missing_ledger++;
  }
  const unresolved = ['live-provider-reconciliation-not-run', 'published-registry-export-unavailable', 'order-and-click-source-coverage-unavailable'];
  if (buckets.malformed) unresolved.push('malformed-ledger-lines');
  if (buckets.tracked_missing_subid) unresolved.push('tracked-rows-missing-subid');
  if (duplicate_claimants) unresolved.push('duplicate-subid-claimants-require-review');
  if (invalidTimestamps) unresolved.push('ledger-timestamps-invalid');
  if (factBuckets.tracked_missing_ledger) unresolved.push('published-facts-missing-ledger-join');
  return {
    schema: 'project-infinity/attribution-audit/v1', contract_version: 'v1', status: 'incomplete', evaluated_at: at.toISOString(),
    source: { file: 'ledger.jsonl', newest_record_at: newest ? new Date(newest).toISOString() : null, provider_reads: 'not-run' },
    maturity: { rule_hours: 48, mature_rows: mature, unsettled_rows: unsettled, invalid_timestamp_rows: invalidTimestamps },
    reconciliation: { candidate_lines: lines.length, classified_lines: classified, buckets, duplicate_subid_claimants: duplicate_claimants, exception_samples: samples },
    breakdowns: { rail: byRail, account: byAccount, month_cohort: byCohort },
    published_facts_reconciliation: { candidate_rows: facts.length, buckets: factBuckets },
    coverage: { ledger_classification_percent: lines.length ? Number((100 * classified / lines.length).toFixed(2)) : null, end_to_end_percent: null },
    unresolved,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = auditLedger({ text: readFileSync(join(ROOT, 'ledger.jsonl'), 'utf8'), factsText: readFileSync(join(ROOT, 'facts.jsonl'), 'utf8') });
  if (process.argv.includes('--write')) writeFileSync(join(ROOT, 'attribution-audit.json'), `${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
