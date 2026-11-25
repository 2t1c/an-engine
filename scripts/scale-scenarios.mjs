#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = {
  current_accounts: 'accounts',
  donor_arrivals_per_day: 'qualified-donors/day',
  mature_hit_rate: 'ratio',
  revenue_per_hit: 'USD/hit',
  variable_cost_per_thread: 'USD/thread',
  operator_minutes_per_thread: 'minutes/thread',
  runtime_minutes_per_thread: 'minutes/thread',
  runtime_capacity_minutes_per_day: 'minutes/day',
  downside_hit_rate_multiplier: 'ratio',
  provider_cost_multiplier: 'ratio',
  attribution_observed_share: 'ratio',
  upside_donor_multiplier: 'ratio',
  upside_hit_rate_multiplier: 'ratio',
};

function valueInBounds(name, value) {
  if (!Number.isFinite(value) || value < 0) return false;
  if (['mature_hit_rate', 'downside_hit_rate_multiplier', 'attribution_observed_share'].includes(name)) return value <= 1;
  if (name === 'provider_cost_multiplier') return value >= 1;
  if (['upside_donor_multiplier', 'upside_hit_rate_multiplier'].includes(name)) return value > 0;
  if (name === 'current_accounts') return Number.isInteger(value) && value >= 1;
  return true;
}

function validateInputs(raw = {}) {
  const values = {};
  const problems = [];
  for (const [name, unit] of Object.entries(SPECS)) {
    const input = raw[name];
    if (!input) {
      values[name] = null;
      problems.push(`missing-${name}`);
      continue;
    }
    const valid = valueInBounds(name, input.value)
      && input.unit === unit
      && Number.isFinite(Date.parse(input.as_of))
      && String(input.source || '').trim();
    values[name] = valid ? input.value : null;
    if (!valid) problems.push(`invalid-${name}`);
  }
  return { values, problems };
}

function calculate(values, accounts, slots, { donorFactor = 1, hitFactor = 1, costFactor = 1, revenueFactor = 1 } = {}) {
  const demand = Number.isFinite(accounts) ? accounts * slots : null;
  const supply = values.donor_arrivals_per_day == null ? null : values.donor_arrivals_per_day * donorFactor;
  const coverage = demand && supply != null ? Math.min(1, supply / demand) : null;
  const hits = demand != null && values.mature_hit_rate != null ? demand * values.mature_hit_rate * hitFactor : null;
  const contribution = hits != null && values.revenue_per_hit != null && values.variable_cost_per_thread != null
    ? hits * values.revenue_per_hit * revenueFactor - demand * values.variable_cost_per_thread * costFactor
    : null;
  const runtime = demand != null && values.runtime_minutes_per_thread != null ? demand * values.runtime_minutes_per_thread : null;
  return {
    accounts,
    fresh_donor_demand_per_day: demand,
    donor_supply_per_day: supply,
    donor_coverage_ratio: coverage,
    fallback_share_ratio: coverage == null ? null : 1 - coverage,
    expected_hits_per_day: hits,
    contribution_usd_per_day: contribution,
    operator_minutes_per_day: demand != null && values.operator_minutes_per_thread != null ? demand * values.operator_minutes_per_thread : null,
    runtime_headroom_minutes_per_day: runtime != null && values.runtime_capacity_minutes_per_day != null ? values.runtime_capacity_minutes_per_day - runtime : null,
  };
}

function sensitivity(values, cases, slots, id, transformation, factors, ready) {
  return {
    id,
    transformation,
    result_status: ready ? 'computed-from-explicit-input-snapshot' : 'not-computable',
    scenarios: ready ? cases.map(({ id: caseId, accounts }) => ({ id: caseId, ...calculate(values, accounts, slots, factors) })) : null,
  };
}

export function scenarios({ laws, confidence, inputs = {}, at = new Date() }) {
  const { values, problems } = validateInputs(inputs);
  const slots = laws.farm.postsPerAccountPerDay;
  const counts = [...new Set([values.current_accounts, 3, 6, 10, 20].filter(Number.isFinite))].sort((a, b) => a - b);
  const cases = [
    { id: 'no-expansion', accounts: values.current_accounts },
    ...counts.filter((count) => count !== values.current_accounts).map((accounts) => ({ id: `fleet-${accounts}`, accounts })),
  ];
  const unresolved = [
    ...problems,
    'required-margin-threshold',
    'required-donor-coverage-threshold',
    'required-operator-load-threshold',
    'required-runtime-headroom-threshold',
    'provenance-readiness',
  ];
  if (confidence.status !== 'decision-grade') unresolved.push('measurement-confidence-incomplete');

  return {
    schema: 'project-infinity/scale-scenarios/v2',
    policy_version: 'v1',
    evaluated_at: at.toISOString(),
    status: 'not-decision-ready',
    policy_sources: [{ path: 'laws.json', value: 'farm.postsPerAccountPerDay', applied: slots }],
    input_contract: Object.fromEntries(Object.entries(SPECS).map(([name, unit]) => [name, { unit, required: true, value: inputs[name] || null }])),
    measurement_status: confidence.status,
    contribution_scope: 'revenue per hit less supplied per-thread variable cost; excludes fixed subscriptions and optional labor; not net profit',
    unresolved_inputs: [...new Set(unresolved)],
    historical_context: [{ source: 'SCALING.md', as_of: '2026-07-21', qualified_donors_per_night: 6, status: 'historical-not-used-as-current-input' }],
    scenarios: cases.map(({ id, accounts }) => ({
      id,
      slots_per_account_day: slots,
      ...calculate(values, accounts, slots),
      decision_status: 'not-ready',
      first_binding_constraint: unresolved[0] || null,
    })),
    sensitivity_cases: [
      sensitivity(values, cases, slots, 'downside-donor-50-percent', 'donor arrivals × 0.5', { donorFactor: 0.5 }, values.donor_arrivals_per_day != null),
      sensitivity(values, cases, slots, 'downside-lower-hit', 'hit rate × supplied downside multiplier', { hitFactor: values.downside_hit_rate_multiplier }, values.downside_hit_rate_multiplier != null && values.mature_hit_rate != null),
      sensitivity(values, cases, slots, 'downside-provider-cost', 'variable cost × supplied provider-cost multiplier', { costFactor: values.provider_cost_multiplier }, values.provider_cost_multiplier != null && values.variable_cost_per_thread != null),
      sensitivity(values, cases, slots, 'delayed-attribution', 'revenue × supplied observed attribution share', { revenueFactor: values.attribution_observed_share }, values.attribution_observed_share != null && values.revenue_per_hit != null),
      sensitivity(values, cases, slots, 'upside', 'donor and hit rates × supplied upside multipliers', { donorFactor: values.upside_donor_multiplier, hitFactor: values.upside_hit_rate_multiplier }, values.upside_donor_multiplier != null && values.upside_hit_rate_multiplier != null),
    ],
    runtime_changes_applied: false,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const laws = JSON.parse(readFileSync(join(ROOT, 'laws.json'), 'utf8'));
  const confidence = JSON.parse(readFileSync(join(ROOT, 'attribution-audit.json'), 'utf8'));
  const argument = process.argv.find((value) => value.startsWith('--inputs='));
  const inputFile = argument?.slice('--inputs='.length);
  const inputs = inputFile && existsSync(resolve(inputFile)) ? JSON.parse(readFileSync(resolve(inputFile), 'utf8')) : {};
  const result = scenarios({ laws, confidence, inputs });
  if (process.argv.includes('--write')) writeFileSync(join(ROOT, 'scale-scenarios.json'), `${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
