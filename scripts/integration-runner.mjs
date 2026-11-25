#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_SCHEMA = 'project-infinity/integration-results/v1';
export const CTA_CHECK_ID = 'cta-draft-parity';
export const CTA_TIMEOUT_MS = 300_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function report(status, reason) {
  return {
    schema: REPORT_SCHEMA,
    mode: 'read-only',
    results: [{ id: CTA_CHECK_ID, status, reason }],
    summary: {
      passed: Number(status === 'passed'),
      failed: Number(status === 'failed'),
      skipped: Number(status === 'skipped'),
    },
  };
}

export function executeCtaCheck({ environment = process.env } = {}) {
  const child = spawnSync(process.execPath, [join(ROOT, 'sync-cta-drafts.mjs'), '--check'], {
    cwd: ROOT,
    env: {
      PATH: environment.PATH || '',
      TYPEFULLY_API_KEY: environment.TYPEFULLY_API_KEY,
      CI: 'true',
    },
    stdio: 'ignore',
    timeout: CTA_TIMEOUT_MS,
  });
  return { status: child.status, error: child.error };
}

export function runIntegration({
  argv = process.argv.slice(2),
  environment = process.env,
  execute = executeCtaCheck,
} = {}) {
  const allowed = new Set(['--allow-read-only', '--json']);
  if (argv.some((arg) => !allowed.has(arg)) || new Set(argv).size !== argv.length) {
    return { exitCode: 2, report: report('failed', 'invalid-options') };
  }
  if (!argv.includes('--allow-read-only')) {
    return { exitCode: 0, report: report('skipped', 'opt-in-required') };
  }
  if (!String(environment.TYPEFULLY_API_KEY || '').trim()) {
    return { exitCode: 0, report: report('skipped', 'credential-unavailable') };
  }

  try {
    const outcome = execute({ environment });
    if (outcome?.status === 0 && !outcome?.error) {
      return { exitCode: 0, report: report('passed', 'check-passed') };
    }
  } catch {
    // Errors may contain credentials or provider responses. The report is intentionally constant.
  }
  return { exitCode: 1, report: report('failed', 'check-command-failed') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = runIntegration();
  process.stdout.write(`${JSON.stringify(outcome.report)}\n`);
  process.exitCode = outcome.exitCode;
}
