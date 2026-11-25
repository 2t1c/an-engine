#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const get = (value, path) => path.split('.').reduce((x, key) => x?.[key], value);
// The `*` stands for a run DATE (logRun writes <pipeline>-YYYY-MM-DD.json). A bare `.*` also matched
// logs/registry-latest.json — a workflow report of another shape that sorts after every date — so it
// was read as the newest registry log and raised registry:incomplete + registry:stale (both critical)
// on every evaluation.
const wildcard = (pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '\\d{4}-\\d{2}-\\d{2}.*')}$`);

export function inspectSignals({ root = ROOT, at = new Date(), previous = null } = {}) {
  const policy = JSON.parse(readFileSync(join(root, 'ops-signals.json'), 'utf8'));
  const logs = join(root, 'logs');
  const names = existsSync(logs) ? readdirSync(logs) : [];
  const findings = [];
  for (const signal of policy.signals) {
    const files = names.filter((name) => wildcard(signal.pattern).test(name)).sort();
    const next = new Date(at.getTime() + signal.max_age_hours * 3_600_000).toISOString();
    const base = { source: signal.id, owner: signal.owner, severity: signal.severity, runbook: signal.runbook, freshness_basis: signal.freshness_basis || null, next_check_at: next };
    if (!files.length) {
      findings.push({ finding_id: `${signal.id}:missing`, kind: 'missing', status: 'new', evidence: { expected_pattern: signal.pattern }, ...base });
      continue;
    }
    const file = files.at(-1);
    let row;
    try { row = JSON.parse(readFileSync(join(root, 'logs', file), 'utf8')); }
    catch { findings.push({ finding_id: `${signal.id}:invalid`, kind: 'incomplete', status: 'new', evidence: { file, reason: 'invalid-json' }, ...base }); continue; }
    const absent = signal.required_fields.filter((field) => get(row, field) === undefined || get(row, field) === null);
    if (absent.length) findings.push({ finding_id: `${signal.id}:incomplete`, kind: 'incomplete', status: 'new', evidence: { file, missing_fields: absent }, ...base });
    const stamp = Date.parse(get(row, signal.timestamp_field));
    const ageHours = Number.isFinite(stamp) ? (at.getTime() - stamp) / 3_600_000 : null;
    if (Number.isFinite(stamp) && ageHours < -1) findings.push({
      finding_id: `${signal.id}:future-timestamp`, kind: 'incomplete', status: 'new',
      evidence: { file, reason: 'timestamp-in-future', observed_at: new Date(stamp).toISOString() }, ...base,
    });
    if (ageHours === null || ageHours > signal.max_age_hours) findings.push({
      finding_id: `${signal.id}:stale`, kind: 'stale', status: 'new',
      evidence: { file, observed_at: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null, max_age_hours: signal.max_age_hours }, ...base,
    });
    const explicitAnomaly = row.clean === false || (signal.anomaly_fields || []).some((field) => {
      const value = get(row, field);
      return value === true || (typeof value === 'number' && value > 0) || (Array.isArray(value) && value.length > 0);
    });
    const botNotOk = signal.id === 'fuel-digest' && row.bot !== 'ok';
    if (explicitAnomaly || botNotOk) findings.push({
      finding_id: `${signal.id}:reported-anomaly`, kind: 'reported-anomaly', status: 'new', evidence: { file }, ...base,
    });
  }
  const prior = new Map((previous?.findings || []).map((x) => [x.finding_id, x]));
  const active = findings.map((finding) => {
    const old = prior.get(finding.finding_id);
    const continued = old && old.status !== 'resolved';
    const operator = continued ? Object.fromEntries(['status_reason', 'status_changed_at', 'status_changed_by'].filter((key) => old[key] != null).map((key) => [key, old[key]])) : {};
    return { ...finding, ...operator, status: continued ? old.status : 'new', first_seen_at: continued ? old.first_seen_at : at.toISOString(), last_seen_at: at.toISOString(), resolution: null,
      ...(old?.status === 'resolved' ? { prior_resolution: old.resolution || null } : {}) };
  });
  const activeIds = new Set(active.map((x) => x.finding_id));
  const resolved = [...prior.values()].filter((x) => x.status !== 'resolved' && !activeIds.has(x.finding_id)).map((x) => ({
    ...x, status: 'resolved', last_seen_at: at.toISOString(), resolution: { kind: 'signal-cleared', resolved_at: at.toISOString() },
  }));
  const history = [...prior.values()].filter((x) => x.status === 'resolved' && !activeIds.has(x.finding_id));
  return { schema: 'project-infinity/action-queue/v1', evaluated_at: at.toISOString(), findings: [...active, ...resolved, ...history].sort((a, b) => a.finding_id.localeCompare(b.finding_id)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const priorFiles = existsSync(join(ROOT, 'logs')) ? readdirSync(join(ROOT, 'logs')).filter((x) => /^ops-actions-.*\.json$/.test(x)).sort() : [];
  let previous = null;
  if (priorFiles.length) try { previous = JSON.parse(readFileSync(join(ROOT, 'logs', priorFiles.at(-1)), 'utf8')); } catch {}
  const result = inspectSignals({ previous });
  if (process.argv.includes('--write')) {
    const day = result.evaluated_at.slice(0, 10);
    writeFileSync(join(ROOT, 'logs', `ops-actions-${day}.json`), `${JSON.stringify(result, null, 2)}\n`);
  } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
