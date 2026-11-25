// Auto-merge gate. Security evidence is fail-closed; comments/labels are best-effort cosmetics.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { classify, autoMergeEligible, POLICY_VERSION, REVIEWED_ALL_CLASS } from './loop-policy.mjs';
import { ciCandidates, selectTrustedReview, validateCiRun, validateCompareEvidence, validateSnapshot } from './auto-merge-evidence.mjs';

// maxBuffer: execFileSync defaults to 1 MiB and throws ENOBUFS above it. The immutable compare of a
// 158-file PR (Run 4 data on the branch, 1.2 MB of patches) crossed that on 2026-09-13, and the gate
// refused every PR of that size before it had read a single field. 64 MiB covers any PR GitHub serves.
const sh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }).trim();
const json = (args, label) => {
  const raw = sh(args);
  try { return JSON.parse(raw); } catch { throw new Error(`${label} returned invalid JSON`); }
};
const cosmetic = (fn, label) => {
  try { return fn(); }
  catch (error) { console.log(`! ${label}: ${(error.stderr || error.message || '').toString().slice(0, 200)}`); return null; }
};

export function decide({ classification, ciGreen, armed, isDraft, halted, reviewPass = false, reviewClass = null, evidenceOk = true }) {
  if (halted) return { action: 'skip', label: null, msg: '⏸️ Loop halted (`.loop-halt` present) — no action.' };
  if (isDraft) return { action: 'skip', label: null, msg: '📝 Draft — the bot waits until it is ready for review.' };
  if (!evidenceOk) return { action: 'wait', label: 'needs-review', msg: '⏳ Security evidence is incomplete or stale — refusing to merge.' };
  const trustedFullReview = reviewPass && reviewClass === REVIEWED_ALL_CLASS;
  if (classification.danger && !trustedFullReview)
    return { action: 'tap', label: 'needs-human-tap', msg: `🛑 **Protected change — trusted full review required.**\nReasons: ${classification.reasons.join('; ')}` };
  const eligible = autoMergeEligible({ classification, ciGreen, reviewPass, reviewClass });
  if (!eligible.auto) return { action: ciGreen ? 'review' : 'wait', label: ciGreen ? 'needs-review' : null,
    msg: ciGreen ? `🔍 ${eligible.why}. Left for a human tap.` : '⏳ Waiting for verified CI on the current head and base.' };
  return armed
    ? { action: 'merge', label: 'auto-merge-ready', msg: `✅ ${eligible.why} — **auto-merging** (squash).` }
    : { action: 'ready', label: 'auto-merge-ready', msg: `✅ ${eligible.why} — would **auto-merge**. DRY-RUN (set repo var \`AUTOMERGE_ENABLED=true\` to arm).` };
}

export function sameEvaluatedHead(meta, { headSha, baseSha } = {}) {
  return meta?.headRefOid === headSha && meta?.baseRefOid === baseSha && meta?.state === 'OPEN'
    && meta?.isDraft === false && meta?.mergeable === 'MERGEABLE';
}

export function mergeArgs(pr, repo, headSha) {
  return ['pr', 'merge', String(pr), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', headSha];
}

const BOT_LABELS = { 'auto-merge-ready': '0E8A16', 'needs-human-tap': 'B60205', 'needs-review': 'FBCA04' };

async function main() {
  const repository = process.env.REPO;
  const pr = process.env.PR_NUMBER;
  const armed = process.env.AUTOMERGE_ENABLED === 'true';
  const trustedLogin = process.env.AUTOMERGE_REVIEW_LOGIN || '';
  const halted = existsSync('.loop-halt');
  if (!repository || !pr) throw new Error('missing REPO/PR_NUMBER');

  const meta = json(['pr', 'view', pr, '--repo', repository, '--json', 'headRefOid,baseRefOid,baseRefName,isDraft,state,mergeable,changedFiles'], 'PR metadata');
  const snapshot = validateSnapshot({ meta });
  if (!snapshot.ok) throw new Error(snapshot.reason);
  const { headSha, baseSha } = snapshot;
  const triggerHead = process.env.TRIGGER_HEAD_SHA || '';
  if (triggerHead && triggerHead !== headSha) throw new Error('workflow_run trigger is stale for the current PR head');
  // Classify immutable commit objects, never mutable PR diff/file endpoints. This prevents an A→B→A
  // force-push from combining review/CI for A with a harmless-looking diff from B.
  const comparePath = `repos/${repository}/compare/${baseSha}...${headSha}`;
  const compare = json(['api', '-H', 'Accept: application/vnd.github+json', comparePath], 'immutable compare');
  const compareEvidence = validateCompareEvidence(compare, { baseSha, headSha, changedFiles: meta.changedFiles });
  if (!compareEvidence.ok) throw new Error(compareEvidence.reason);
  const diff = compareEvidence.diff;
  const files = compareEvidence.files;

  const checkPages = json(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', `repos/${repository}/commits/${headSha}/check-runs?per_page=100`], 'check runs');
  const checkRuns = checkPages.flatMap((page) => page.check_runs || []);
  if (checkPages.some((page) => Number(page.total_count || 0) > checkRuns.length)) throw new Error('check-run evidence is incomplete');
  const candidates = ciCandidates(checkRuns, { headSha, baseSha });
  const runPages = json(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`], 'CI workflow runs');
  const allRuns = runPages.flatMap((page) => page.workflow_runs || []);
  if (runPages.some((page) => Number(page.total_count || 0) > allRuns.length)) throw new Error('CI workflow-run evidence is incomplete');
  const canonicalRuns = allRuns.filter((run) => run.event === 'pull_request'
    && run.head_sha === headSha && run.repository?.full_name === repository
    && (run.path === '.github/workflows/ci.yml' || String(run.path || '').startsWith('.github/workflows/ci.yml@')));
  canonicalRuns.sort((a, b) => Number(a.run_number) - Number(b.run_number) || Number(a.run_attempt) - Number(b.run_attempt));
  const latestRun = canonicalRuns.at(-1) || null;
  const candidate = latestRun && candidates.find((item) => String(item.runId) === String(latestRun.id)
    && String(item.check?.check_suite?.id) === String(latestRun.check_suite_id));
  let authoritativeCi = latestRun ? { run: latestRun, check: candidate?.check, provenance: { ok: false, provenanceOk: true, reason: 'latest CI run has no matching attested check' } } : null;
  if (latestRun && candidate) {
    const provenance = validateCiRun(latestRun, { repository, headSha, runId: candidate.runId, checkSuiteId: candidate.check.check_suite.id });
    authoritativeCi = { run: latestRun, check: candidate.check, provenance: {
      ...provenance, ok: provenance.ok && candidate.check.status === 'completed' && candidate.check.conclusion === 'success',
    } };
  }
  const triggerRunId = process.env.TRIGGER_RUN_ID || '';
  if (triggerRunId && (!authoritativeCi || String(authoritativeCi.run.id) !== triggerRunId))
    throw new Error('workflow_run trigger is not the authoritative CI run for this head/base');
  const ciGreen = authoritativeCi?.provenance.ok === true;

  let review = { ok: false, seen: false, reason: 'no trusted review producer configured' };
  if (trustedLogin) {
    const commentPages = json(['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', `repos/${repository}/issues/${pr}/comments?per_page=100`], 'review comments');
    const comments = commentPages.flat().map((comment) => ({
      author: { login: comment.user?.login }, authorAssociation: comment.author_association,
      body: comment.body, createdAt: comment.created_at, id: comment.node_id || String(comment.id || ''),
    }));
    review = selectTrustedReview(comments, { trustedLogin, prNumber: pr, headSha, baseSha });
  }

  const classification = classify(files, diff);
  const decision = decide({ classification, ciGreen, armed, isDraft: meta.isDraft, halted, reviewPass: review.ok, reviewClass: review.reviewClass });
  const ciState = authoritativeCi ? `run ${authoritativeCi.run.id} attempt ${authoritativeCi.run.run_attempt}: ${authoritativeCi.run.conclusion}` : 'unverified';
  const reviewState = review.ok ? `PASS(${review.reviewClass}) by ${review.login}` : review.reason;
  console.log(`PR #${pr} head=${headSha} base=${baseSha} files=${files.length} ci=${ciState} review=${reviewState} policy=${POLICY_VERSION} -> ${decision.action}`);

  const body = `<!-- automerge-bot -->\n🤖 **auto-merge bot** · \`${decision.action}\`\n\n${decision.msg}\n\n<sub>head \`${headSha}\` · base \`${baseSha}\` · files ${files.length} · CI: ${ciState} · review: ${reviewState} · policy ${POLICY_VERSION} · armed: ${armed}${halted ? ' · HALTED' : ''}</sub>`;
  cosmetic(() => sh(['pr', 'comment', pr, '--repo', repository, '--edit-last', '--create-if-none', '--body', body]), 'comment');
  for (const [label, color] of Object.entries(BOT_LABELS)) cosmetic(() => sh(['label', 'create', label, '--repo', repository, '--force', '--color', color]), `label ${label}`);
  if (decision.label) cosmetic(() => sh(['pr', 'edit', pr, '--repo', repository, '--add-label', decision.label, '--remove-label', Object.keys(BOT_LABELS).filter((label) => label !== decision.label).join(',')]), 'set labels');

  if (decision.action !== 'merge') return;
  const current = json(['pr', 'view', pr, '--repo', repository, '--json', 'headRefOid,baseRefOid,baseRefName,isDraft,state,mergeable'], 'pre-merge PR metadata');
  if (current.baseRefName !== 'main') throw new Error('PR base changed after evaluation; refusing merge');
  if (!sameEvaluatedHead(current, { headSha, baseSha })) throw new Error('PR head/base/state changed after evaluation; refusing merge');
  sh(mergeArgs(pr, repository, headSha));
  console.log(`✓ merged PR #${pr} at ${headSha}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`SECURITY GATE REFUSED: ${error.message}`); process.exitCode = 1; });
}
