#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const OUTPUT = join(ROOT, 'runtime-manifest.json');

const unique = (xs) => [...new Set(xs)].sort();
const uncommented = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line));

export function parseWorkflow(text, path, policy = {}) {
  const lines = uncommented(text);
  const activeText = lines.join('\n');
  const name = (lines.find((line) => /^name:\s*/.test(line)) || '').replace(/^name:\s*/, '').trim();
  const onIndex = lines.findIndex((line) => /^on:\s*/.test(line));
  if (onIndex < 0) throw new Error(`${path}: missing top-level on`);
  const inline = lines[onIndex].replace(/^on:\s*/, '').trim();
  const triggerLines = [];
  if (inline) triggerLines.push(...inline.replace(/[\[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean));
  for (let i = onIndex + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim()) break;
    const match = lines[i].match(/^  ([A-Za-z_][\w-]*):/);
    if (match) triggerLines.push(match[1]);
  }
  const triggers = unique(triggerLines);
  const crons = unique(lines.slice(onIndex + 1).map((line) => line.match(/^\s+-?\s*cron:\s*["']?([^"'#]+)["']?/)?.[1]?.trim()).filter(Boolean));
  const classification = triggers.includes('schedule') ? 'scheduled'
    : triggers.some((t) => t !== 'workflow_dispatch') ? 'event-triggered'
      : triggers.includes('workflow_dispatch') ? 'dispatch-only' : 'disabled';
  const credentials = unique([...activeText.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
  const scripts = unique([...activeText.matchAll(/(?:node\s+|npm\s+run\s+)([\w./:@-]+(?:\.mjs)?)/g)].map((m) => m[1]));
  const id = path.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
  const defaults = policy.defaults || {};
  const extra = policy.overrides?.[id] || {};
  const declaredWrites = Object.prototype.hasOwnProperty.call(extra, 'write_surfaces')
    ? extra.write_surfaces : defaults.write_surfaces;
  return {
    id,
    state_family_id: `github-workflow:${id}`,
    source: path,
    name,
    configured: { classification, triggers, crons, timezone: crons.length ? 'UTC' : null },
    enabled: 'unknown-until-github-observation',
    observed: null,
    credentials,
    scripts,
    owner: extra.owner || defaults.owner || null,
    runbook: extra.runbook || defaults.runbook || null,
    alert_destination: extra.alert_destination || defaults.alert_destination || null,
    write_surfaces: Array.isArray(declaredWrites) ? declaredWrites : null,
    write_surfaces_review: Array.isArray(declaredWrites)
      ? (declaredWrites.length ? 'reviewed-known-writes' : 'reviewed-no-writes')
      : 'unknown-unreviewed',
    writer_scope: 'GitHub Actions only; n8n, Railway, and manual writers are not coordinated by this workflow',
  };
}

export function buildInventory({ root = ROOT, observation = null } = {}) {
  const policy = JSON.parse(readFileSync(join(root, 'runtime-policy.json'), 'utf8'));
  const observedByPath = new Map((observation?.workflows || []).map((x) => [x.path, x]));
  const workflows = readdirSync(join(root, '.github', 'workflows'))
    .filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((file) => {
      const path = `.github/workflows/${file}`;
      const item = parseWorkflow(readFileSync(join(root, path), 'utf8'), path, policy);
      const seen = observedByPath.get(path);
      if (seen) {
        item.enabled = seen.state === 'active' ? 'enabled' : seen.state;
        item.observed = { verified_at: observation.verified_at, source: observation.source, workflow_id: seen.id, latest_run: seen.latest_run || null };
      }
      return item;
    });
  const configuredPaths = new Set(workflows.map((x) => x.source));
  return {
    schema: 'project-infinity/runtime-manifest/v1',
    generated_from: 'repository workflow configuration plus a dated read-only observation',
    counts: Object.fromEntries(['scheduled', 'event-triggered', 'dispatch-only', 'disabled'].map((key) => [key, workflows.filter((w) => w.configured.classification === key).length])),
    workflows,
    observed_unmatched: (observation?.workflows || []).filter((x) => !configuredPaths.has(x.path)).map((x) => ({
      id: x.id, name: x.name, path: x.path, state: x.state,
      note: 'Observed by GitHub but not backed by a repository workflow file in this snapshot',
    })),
    external_runtimes: policy.external_runtimes,
  };
}

export function serialize(manifest) { return `${JSON.stringify(manifest, null, 2)}\n`; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const observationPath = join(ROOT, 'runtime-observation.github.json');
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));
  const expected = serialize(buildInventory({ observation }));
  if (check) {
    if (readFileSync(OUTPUT, 'utf8') !== expected) {
      console.error('runtime-manifest.json is stale; run: node scripts/runtime-inventory.mjs');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(OUTPUT, expected);
    console.log(`wrote ${relative(ROOT, OUTPUT)}`);
  }
}
