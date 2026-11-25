// Pure validators for the auto-merge trust boundary. Network/CLI calls live in auto-merge-bot.mjs;
// this module turns their responses into explicit accept/reject decisions that can be tested offline.
import { AUTO_MERGEABLE } from './loop-policy.mjs';

export const FULL_SHA_RE = /^[0-9a-f]{40}$/;
export const REVIEW_SCHEMA = 'v3';
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const GITHUB_ACTIONS_APP_ID = 15368;

export function validFullSha(value) {
  return FULL_SHA_RE.test(String(value || ''));
}

export function validateSnapshot({ meta, expectedBase = 'main' } = {}) {
  if (!meta || typeof meta !== 'object') return { ok: false, reason: 'PR metadata unavailable' };
  if (meta.state !== 'OPEN') return { ok: false, reason: 'PR is not open' };
  if (meta.baseRefName !== expectedBase) return { ok: false, reason: `PR base is not ${expectedBase}` };
  if (meta.mergeable !== 'MERGEABLE') return { ok: false, reason: 'PR is not currently mergeable' };
  if (!validFullSha(meta.headRefOid)) return { ok: false, reason: 'PR head SHA is missing or invalid' };
  if (!validFullSha(meta.baseRefOid)) return { ok: false, reason: 'PR base SHA is missing or invalid' };
  if (!Number.isInteger(meta.changedFiles) || meta.changedFiles < 1)
    return { ok: false, reason: 'changed-file count is missing or empty' };
  return { ok: true, headSha: meta.headRefOid, baseSha: meta.baseRefOid };
}

export function validateCompareEvidence(compare, { baseSha, headSha, changedFiles } = {}) {
  if (!compare || compare.base_commit?.sha !== baseSha) return { ok: false, reason: 'immutable compare base mismatch' };
  if (!Array.isArray(compare.commits) || compare.commits.at(-1)?.sha !== headSha)
    return { ok: false, reason: 'immutable compare head mismatch or missing commit history' };
  if (Number(compare.ahead_by) !== compare.commits.length)
    return { ok: false, reason: 'immutable compare commit list is capped or incomplete' };
  if (!Array.isArray(compare.files) || compare.files.length !== Number(changedFiles))
    return { ok: false, reason: 'immutable compare file list is capped or incomplete' };
  if (new Set(compare.files.map((file) => file.filename)).size !== compare.files.length)
    return { ok: false, reason: 'immutable compare contains duplicate file entries' };
  for (const file of compare.files) {
    if (!file.filename || typeof file.patch !== 'string'
      || !Number.isInteger(file.additions) || file.additions < 0
      || !Number.isInteger(file.deletions) || file.deletions < 0)
      return { ok: false, reason: 'immutable compare omitted a file patch or change counts; human review required' };
    const lines = file.patch.split('\n');
    const additions = lines.filter((line) => line.startsWith('+')).length;
    const deletions = lines.filter((line) => line.startsWith('-')).length;
    if (additions !== file.additions || deletions !== file.deletions)
      return { ok: false, reason: `immutable compare patch is incomplete for ${file.filename}` };
  }
  const files = [...new Set(compare.files.flatMap((file) => [file.filename, file.previous_filename]).filter(Boolean))];
  return { ok: true, files, diff: compare.files.map((file) => file.patch).join('\n') };
}

// Interim compatibility transport. It is disabled unless the repository owner explicitly configures
// one exact login. Association is a second check, never a substitute for the login allowlist.
export function selectTrustedReview(comments, { trustedLogin, prNumber, headSha, baseSha } = {}) {
  if (!trustedLogin) return { ok: false, seen: false, reason: 'no trusted review producer configured' };
  if (!validFullSha(headSha) || !validFullSha(baseSha)) return { ok: false, seen: false, reason: 'invalid expected review head/base SHA' };
  const associations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  const candidates = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const login = comment?.author?.login || '';
    if (login !== trustedLogin || !associations.has(String(comment?.authorAssociation || '').toUpperCase())) continue;
    const body = String(comment?.body || '').trim();
    const match = body.match(/^AUTO-REVIEW-VERDICT:\s*(PASS|BLOCK)\s+schema=(v\d+)\s+pr=(\d+)\s+class=([\w-]+)\s+sha=([0-9a-f]{40})\s+base=([0-9a-f]{40})\s*$/);
    if (!match || match[2] !== REVIEW_SCHEMA || Number(match[3]) !== Number(prNumber)
      || match[5] !== headSha || match[6] !== baseSha) continue;
    const createdAt = Date.parse(comment.createdAt || '');
    const id = String(comment.id || '');
    if (!Number.isFinite(createdAt) || !id) continue;
    candidates.push({
      pass: match[1].toUpperCase() === 'PASS',
      reviewClass: match[4],
      createdAt,
      id,
      login,
    });
  }
  if (!candidates.length) return { ok: false, seen: false, reason: 'no authorized exact-head/base review verdict' };
  candidates.sort((a, b) => a.createdAt - b.createdAt);
  const newestAt = candidates.at(-1).createdAt;
  const newest = candidates.filter((candidate) => candidate.createdAt === newestAt);
  // GitHub timestamps have finite precision. Conflicting simultaneous verdicts fail closed, with
  // BLOCK taking precedence; distinct PASS classes at one timestamp are ambiguous.
  const blocked = newest.find((candidate) => !candidate.pass);
  if (blocked) return { ok: false, seen: true, reason: 'trusted review blocked this head', ...blocked };
  if (new Set(newest.map((candidate) => candidate.reviewClass)).size !== 1)
    return { ok: false, seen: true, reason: 'simultaneous trusted review verdicts are ambiguous' };
  const latest = newest[0];
  if (!latest.pass) return { ok: false, seen: true, reason: 'trusted review blocked this head', ...latest };
  if (!AUTO_MERGEABLE.classes.includes(latest.reviewClass))
    return { ok: false, seen: true, reason: `review class ${latest.reviewClass} is not auto-mergeable`, ...latest };
  return { ok: true, seen: true, ...latest };
}

function runIdFromDetails(url) {
  const match = String(url || '').match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  return match?.[1] || null;
}

export function ciCandidates(checkRuns, { headSha, baseSha } = {}) {
  if (!validFullSha(headSha) || !validFullSha(baseSha)) return [];
  const expectedName = `check [head=${headSha} base=${baseSha}]`;
  return (Array.isArray(checkRuns) ? checkRuns : [])
    .filter((check) => check?.name === expectedName
      && check?.head_sha === headSha
      && check?.app?.slug === 'github-actions'
      && check?.app?.id === GITHUB_ACTIONS_APP_ID)
    .map((check) => ({ check, runId: runIdFromDetails(check.details_url) }))
    .filter((x) => x.runId);
}

export function validateCiRun(run, { repository, headSha, runId, checkSuiteId } = {}) {
  if (!run || String(run.id) !== String(runId)) return { ok: false, provenanceOk: false, reason: 'CI workflow run identity mismatch' };
  if (run.event !== 'pull_request') return { ok: false, provenanceOk: false, reason: 'CI workflow run is not a pull_request run' };
  if (run.repository?.full_name !== repository) return { ok: false, provenanceOk: false, reason: 'CI workflow run belongs to another repository' };
  if (run.path !== CI_WORKFLOW_PATH && !String(run.path || '').startsWith(`${CI_WORKFLOW_PATH}@`))
    return { ok: false, provenanceOk: false, reason: 'run did not execute the canonical CI workflow' };
  // GitHub reports the PR head here while the check run is attached to refs/pull/N/merge.
  if (run.head_sha !== headSha) return { ok: false, provenanceOk: false, reason: 'CI workflow run is for another PR head' };
  if (!checkSuiteId || String(run.check_suite_id) !== String(checkSuiteId)) return { ok: false, provenanceOk: false, reason: 'CI run/check-suite provenance mismatch' };
  if (Number(run.run_attempt || 0) < 1 || Number(run.run_number || 0) < 1)
    return { ok: false, provenanceOk: false, reason: 'CI workflow run sequence metadata is missing' };
  const ok = run.status === 'completed' && run.conclusion === 'success';
  return { ok, provenanceOk: true, reason: ok ? 'verified CI success' : `latest CI is ${run.status}/${run.conclusion || 'pending'}`, runId: String(run.id) };
}
