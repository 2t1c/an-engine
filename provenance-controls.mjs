import { createHash } from 'node:crypto';

export const PROVENANCE_POLICY = Object.freeze({
  id: 'project-infinity/provenance-review/v1',
  mode: 'report-only',
  source_revision: '7214bd75a0e570e469c3cdf8f0da485817855d2b',
  sources: ['README.md:47-55', 'README.md:281-283', 'style/thread-checklist.md:13-25', 'style/thread-checklist.md:79-149', 'SCALING.md:23-38'],
});

const text = (value) => typeof value === 'string' ? value.trim() : '';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const url = (value) => { try { const parsed = new URL(text(value)); return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password; } catch { return false; } };
const REVIEW_STATES = new Set(['approved', 'rejected', 'needs_review', 'unknown', 'not_applicable']);
const reviewed = (value, now) => { const stamp = Date.parse(value?.reviewed_at); return value && REVIEW_STATES.has(value.status) && text(value.reviewer) && Number.isFinite(stamp) && stamp <= now.getTime() && text(value.policy_version) && url(value.evidence_url); };
const approved = (value, now) => reviewed(value, now) && ['approved', 'not_applicable'].includes(value.status);
const HEALTH = /\b(cure|treat|prevent|diagnos|disease|dose|dosage|interact|clinical|research|study|reduces?|improves?|supports?)\b/i;

export function sourceExcerptHash(value) {
  return text(value) ? createHash('sha256').update(text(value)).digest('hex') : null;
}

export function provenanceRecordFromDraft({ ledgerRow = null, scratchpad = '', posts = [] } = {}) {
  const sourceLine = text(scratchpad).split('\n').find((line) => /^source:\s*/i.test(line));
  const sourceUrl = text(ledgerRow?.sourceUrl || sourceLine?.replace(/^source:\s*/i, ''));
  return {
    source: { url: sourceUrl || null, account: ledgerRow?.sourceAccount || null, captured_at: ledgerRow?.sourceCapturedAt || null, type: ledgerRow?.sourceType || 'viral-post', excerpt_hash: ledgerRow?.sourceExcerptHash || null },
    transformation_mode: ledgerRow?.variationMode || ledgerRow?.transformationMode || ledgerRow?.mode || null,
    imported_from: ledgerRow?.importedFrom || null,
    parent_source_ids: Array.isArray(ledgerRow?.parentSourceIds) ? ledgerRow.parentSourceIds : [],
    fact_sources: Array.isArray(ledgerRow?.factSources) ? ledgerRow.factSources : [],
    media: Array.isArray(ledgerRow?.mediaProvenance) ? ledgerRow.mediaProvenance : [],
    claims: Array.isArray(ledgerRow?.claimEvidence) ? ledgerRow.claimEvidence : [],
    disclosure_review: ledgerRow?.disclosureReview || null,
    originality_review: ledgerRow?.originalityReview || null,
    source_urls: Array.isArray(ledgerRow?.sourceUrls) ? ledgerRow.sourceUrls : [],
    candidate_hash: sourceExcerptHash(posts.join('\n')),
  };
}

export function reviewProvenance(record = {}, { posts = [], hasMedia = false, disclosed = false, now = new Date() } = {}) {
  const findings = [];
  const add = (code, area, message, remediation) => findings.push({ code, area, status: 'needs_review', message, remediation });
  if (!isRecord(record)) {
    add('record-schema-invalid', 'source', 'The provenance record is not an object.', 'Repair the provenance record before review.');
    record = {};
  }
  const source = isRecord(record.source) ? record.source : {};
  const captured = Date.parse(source.captured_at);
  if (!url(source.url) || !text(source.account) || !Number.isFinite(captured) || captured > now.getTime() || !/^[a-f0-9]{64}$/i.test(text(source.excerpt_hash)))
    add('source-lineage-incomplete', 'source', 'Source URL, account, capture time, and excerpt hash are not all recorded.', 'Capture the source identity and hash without storing the full source text.');
  if (record.source_urls != null && !Array.isArray(record.source_urls)) add('source-schema-invalid', 'source', 'Additional source URLs are not an array.', 'Repair the provenance record before review.');
  const declaredUrls = [source.url, ...(Array.isArray(record.source_urls) ? record.source_urls : [])].filter(Boolean);
  if (new Set(declaredUrls).size > 1) add('source-lineage-conflict', 'source', 'Candidate metadata names conflicting primary sources.', 'Resolve the primary source and retain other material as fact sources or parent lineage.');
  if (record.imported_from && (!record.parent_source_ids?.length || !text(record.imported_from)))
    add('import-lineage-incomplete', 'source', 'Imported content does not identify its upstream source records.', 'Record the importing system and parent source identifiers.');
  if (!['faithful', 'skeleton'].includes(record.transformation_mode)) add('transformation-mode-missing', 'originality', 'Transformation mode is missing or invalid.', 'Record faithful or skeleton mode and attach an originality review.');
  if (!approved(record.originality_review, now)) add('originality-review-missing', 'originality', 'No approved donor/fleet originality result with complete evidence is attached.', 'Run the labeled originality review and record its policy version and reviewer.');
  if (hasMedia) {
    if (!Array.isArray(record.media)) add('media-clearance-missing', 'media', 'Media is present without a valid provenance array.', 'Record each asset origin, permission or license basis, allowed use, and attribution requirement.');
    else if (!record.media.length) add('media-clearance-missing', 'media', 'Media is present without a provenance record.', 'Record each asset origin, permission or license basis, allowed use, and attribution requirement.');
    for (const asset of Array.isArray(record.media) ? record.media : []) {
      const evidenceComplete = isRecord(asset) && url(asset.origin_url) && text(asset.permission_basis) && text(asset.allowed_use) && approved(asset.clearance, now);
      if (!evidenceComplete) add('media-clearance-unresolved', 'media', 'A reused media asset lacks complete, approved clearance evidence.', 'Record origin, permission/license basis, allowed use, reviewer, date, and policy version, or omit it.');
      if (/viral|public|source post/i.test(text(asset?.permission_basis))) add('viral-source-not-rights-proof', 'media', 'Public or viral availability is not evidence of reuse rights.', 'Attach an actual permission or license basis.');
    }
  }
  if (record.claims != null && !Array.isArray(record.claims)) add('claims-schema-invalid', 'claims', 'Claim evidence is not an array.', 'Repair the provenance record and reconcile every extracted claim.');
  const suppliedClaims = Array.isArray(record.claims) ? record.claims : [];
  if (suppliedClaims.some((claim) => !isRecord(claim))) add('claims-schema-invalid', 'claims', 'A claim evidence entry is not an object.', 'Repair the provenance record and reconcile every extracted claim.');
  const extracted = posts.filter((post) => HEALTH.test(text(post))).map((claim) => ({ text: claim, excerpt_hash: sourceExcerptHash(claim) }));
  const candidateClaims = [...suppliedClaims, ...extracted.filter((found) => !suppliedClaims.some((claim) => isRecord(claim) && (claim.excerpt_hash === found.excerpt_hash || text(claim.text) === text(found.text))))];
  for (const claim of candidateClaims) if (!url(claim?.evidence_url) || !text(claim?.scope) || !approved(claim?.review, now))
    add('health-claim-review-required', 'claims', 'An objective health or product claim lacks approved, scoped evidence review.', 'Link evidence, classify the claim, define its scope, and obtain human review.');
  if (!approved(record.disclosure_review, now) || !text(record.disclosure_review?.scope))
    add('disclosure-policy-review-missing', 'disclosure', `${disclosed ? 'A disclosure token is present' : 'Disclosure presence is false'}, but no complete qualified policy review is recorded.`, 'Record applicability, reviewer, review date, jurisdiction/scope, and policy version.');
  return { policy: PROVENANCE_POLICY, mode: 'report-only', status: findings.length ? 'needs_review' : 'evidence_complete', complete: findings.length === 0, reviewer_identity: 'recorded-not-authenticated', findings };
}
