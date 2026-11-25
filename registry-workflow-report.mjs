import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stageIds = ['registry', 'vendors', 'today', 'instructions', 'attribution', 'products'];
const outcomes = new Set(['success', 'failure', 'cancelled', 'skipped']);
const fallbackMarkdown = '## Registry sync quality\n\nCurrent run has not completed; no freshness claim is available.\n';
function context({ cwd = process.cwd(), env = process.env } = {}) {
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = env.GITHUB_RUN_ATTEMPT;
  if (env.GITHUB_ACTIONS === 'true' && !runId) throw new Error('GitHub run ID is required');
  if (env.GITHUB_ACTIONS === 'true' && !runAttempt) throw new Error('GitHub run attempt is required');
  mkdirSync(resolve(cwd, 'logs'), { recursive: true });
  return { env, runId: runId || 'local', runAttempt: runAttempt || 'local', jsonPath: resolve(cwd, 'logs/registry-latest.json'), markdownPath: resolve(cwd, 'logs/registry-latest.md') };
}
const fallback = (runId, runAttempt) => ({ status: 'failed', runId, runAttempt, error: 'Registry process has not completed', stages: [] });

export function initializeWorkflowReport(options = {}) {
  const { runId, runAttempt, jsonPath, markdownPath } = context(options);
  writeFileSync(jsonPath, JSON.stringify(fallback(runId, runAttempt), null, 2) + '\n');
  writeFileSync(markdownPath, fallbackMarkdown);
  return false;
}

export function finalizeWorkflowReport(options = {}) {
  const { env, runId, runAttempt, jsonPath, markdownPath } = context(options);
  let steps = {}, report, invalidSteps = false;
  try {
    steps = JSON.parse(env.REGISTRY_STAGE_OUTCOMES);
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) throw new Error('Invalid stages');
  } catch { invalidSteps = true; }
  try { report = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { /* fallback below */ }
  const currentReport = report && typeof report === 'object' && !Array.isArray(report)
    && report.runId === runId && report.runAttempt === runAttempt;
  const validCore = currentReport && ['completed', 'degraded'].includes(report.status);
  if (!currentReport) {
    report = fallback(runId, runAttempt);
    // Never append to a previous run's successful summary when this run failed
    // before its core report could be written.
    writeFileSync(markdownPath, fallbackMarkdown);
  }
  const workflowStages = Object.fromEntries(stageIds.map((id) => [id, outcomes.has(steps?.[id]?.outcome) ? steps[id].outcome : 'not-run']));
  const failed = stageIds.filter((id) => workflowStages[id] === 'failure' || workflowStages[id] === 'cancelled');
  if (workflowStages.registry !== 'success' && !failed.includes('registry')) failed.push('registry');
  if (!validCore) failed.push('core-report');
  if (invalidSteps) failed.push('stage-outcomes');
  report.runId = runId;
  report.runAttempt = runAttempt;
  report.workflowStages = workflowStages;
  if (failed.length) report.status = 'failed';
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  // Only fixed allowlisted stage names enter Markdown; no raw errors, statuses,
  // account titles, or step details from the environment are interpolated.
  const note = '\nWorkflow stages: ' + (failed.length ? 'FAILED: ' + failed.join(', ') : 'all requested stages completed') + '\n';
  appendFileSync(markdownPath, note);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, note);
  return failed.length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--init') initializeWorkflowReport();
    else if (process.argv[2] === '--finalize') process.exitCode = finalizeWorkflowReport() ? 0 : 1;
    else { console.error('Use --init or --finalize'); process.exitCode = 1; }
  } catch { console.error('Registry workflow report could not be written'); process.exitCode = 1; }
}
