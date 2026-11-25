import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';

export function measurementConfidence(file = join(HERE_DIR, 'attribution-audit.json'), { now = new Date(), policyFile = join(HERE_DIR, 'measurement-policy.json') } = {}) {
  if (!existsSync(file)) return { status: 'incomplete', reasons: ['attribution-audit-missing'] };
  try {
    const audit = JSON.parse(readFileSync(file, 'utf8'));
    const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
    const reasons = [...(Array.isArray(audit.unresolved) ? audit.unresolved : ['audit-unresolved-list-invalid'])];
    if (policy.schema !== 'project-infinity/measurement-policy/v1' || !Number.isFinite(policy.max_audit_age_hours) || policy.max_audit_age_hours <= 0) reasons.push('measurement-policy-invalid');
    if (audit.schema !== 'project-infinity/attribution-audit/v1') reasons.push('audit-schema-invalid');
    const evaluated = Date.parse(audit.evaluated_at);
    if (!Number.isFinite(evaluated) || evaluated > now.getTime() + 3_600_000 || now.getTime() - evaluated > policy.max_audit_age_hours * 3_600_000) reasons.push('audit-not-fresh');
    if (audit.contract_version !== policy.contract_version) reasons.push('metric-contract-version-mismatch');
    if (audit.source?.provider_reads !== 'verified') reasons.push('provider-evidence-not-verified');
    if (audit.reconciliation?.classified_lines !== audit.reconciliation?.candidate_lines) reasons.push('ledger-classification-incomplete');
    if (policy.minimum_end_to_end_coverage_percent == null || policy.minimum_mature_rows == null) reasons.push('decision-thresholds-unset');
    else {
      if (audit.coverage?.end_to_end_percent < policy.minimum_end_to_end_coverage_percent) reasons.push('end-to-end-coverage-below-policy');
      if (audit.maturity?.mature_rows < policy.minimum_mature_rows) reasons.push('mature-sample-below-policy');
    }
    return { status: audit.status === 'decision-grade' && reasons.length === 0 ? 'decision-grade' : 'incomplete', reasons: [...new Set(reasons)], evaluated_at: audit.evaluated_at || null, coverage: audit.coverage || null, newest_source_at: audit.source?.newest_record_at || null, contract_version: audit.contract_version || null };
  } catch { return { status: 'incomplete', reasons: ['attribution-audit-invalid'] }; }
}

export function withCurrentProviderEvidence(confidence, { affiliateClicksComplete, currentRevenueComplete }) {
  const reasons = [...(confidence.reasons || [])];
  if (!affiliateClicksComplete || !currentRevenueComplete) reasons.push('current-provider-partial');
  return { ...confidence, status: confidence.status === 'decision-grade' && reasons.length === 0 ? 'decision-grade' : 'incomplete', reasons: [...new Set(reasons)] };
}
