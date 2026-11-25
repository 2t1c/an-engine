#!/usr/bin/env node
// Pinned upstream release assets, verified before extraction or execution.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERSION = '8.30.1';
// Reviewed false positives only; rule AND path AND exact extracted-secret shape must match.
// See docs/security-baseline.md. No blanket path, commit or rule suppression.
export const SCANNER_CONFIG = String.raw`[extend]
useDefault = true

[[rules]]
id = "airtable-api-key"
[[rules.allowlists]]
description = "Airtable record identifiers in vendor configuration are not API keys"
condition = "AND"
paths = ['''^vendors\.json$''']
regexTarget = "secret"
regexes = ['''^rec[A-Za-z0-9]{14}$''']

[[rules]]
id = "generic-api-key"
[[rules.allowlists]]
description = "Literal model names in legacy workflow comments"
condition = "AND"
paths = ['''^\.github/workflows/(revenue|registry-sync)\.yml$''']
regexTarget = "secret"
regexes = ['''^(GLM/)?Kimi/DeepSeek/Claude$''']
[[rules.allowlists]]
description = "Genius run-piece keys (imported Genius history) are not API keys"
condition = "AND"
paths = ['''^genius/runs/R2026-10-05\.json$''']
regexTarget = "secret"
regexes = ['''^nvidia-lost-china-qrt-[0-9]$''']
[[rules.allowlists]]
description = "A LearningToan run-piece key (Genius run LT-R2026-10-12, and the baseline note naming it) is not an API key"
condition = "AND"
paths = ['''^genius/runs/LT-R2026-10-12\.json$''', '''^docs/security-baseline\.md$''']
regexTarget = "secret"
regexes = ['''^liemandt-grade-in-26-hours$''']
[[rules.allowlists]]
description = "GTX run-piece keys (Genius run R2026-10-12) are not API keys"
condition = "AND"
paths = ['''^genius/runs/R2026-10-12\.json$''']
regexTarget = "secret"
regexes = ['''^(mined-2026-10-04-39-qrt-[0-3]|storonsky-55-executives)$''']

[[rules.allowlists]]
description = "GTX run-piece keys (Genius run R2026-10-19) are not API keys"
condition = "AND"
paths = ['''^genius/runs/R2026-10-19\.json$''']
regexTarget = "secret"
regexes = ['''^lf-2026-10-(19-huang-dario-very-conservative|22-tobi-lutke-ai-before-headcount|23-baker-blue-collar-wages|24-andreessen-least-qualified)$''']

[[rules]]
id = "grafana-cloud-api-token"
[[rules.allowlists]]
description = "An X status URL for @GLC_Research (imported Genius history) is not a Grafana token"
condition = "AND"
paths = ['''^genius/learnings/a16z-qt-playbook\.json$''']
regexTarget = "secret"
regexes = ['''^GLC_Research/status/[0-9]{19}$''']
`;
export const ASSETS = {
  'linux-x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  'linux-arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  'darwin-x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  'darwin-arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
};

export function verifyAsset(bytes, digest) {
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Scanner checksum mismatch');
}

export function scanArgs(range = '') {
  if (range && !/^[a-f0-9]{40}\.\.[a-f0-9]{40}$/.test(range)) throw new Error('Invalid commit range');
  // Ignore inline allow comments and repo ignore files: changes cannot suppress their own findings.
  return ['git', '--no-banner', '--redact=100', '--ignore-gitleaks-allow',
    '--gitleaks-ignore-path', '/dev/null', '--log-opts', range || '--all', '.'];
}

// The scanner is an untrusted parser of repository content. Its diagnostics and report may contain
// matched material, so outcome rendering accepts neither. Keep every message constant.
export function scannerOutcome({ status, error } = {}) {
  if (error || ![0, 1].includes(status)) return {
    exitCode: 2,
    message: 'Secret scan could not complete. Check platform, network, checksum and Git history; no scanner output was disclosed.',
  };
  if (status === 1) return {
    exitCode: 1,
    message: 'Secret scan failed: potential credential findings detected. Review locally with Gitleaks --redact=100; do not post raw findings.',
  };
  return { exitCode: 0, message: `Secret scan passed (Gitleaks ${VERSION}).` };
}

export async function main() {
  let temporary;
  try {
    const args = scanArgs(process.env.SECRET_SCAN_RANGE || '');
    const platform = `${process.platform}-${process.arch}`;
    const digest = ASSETS[platform];
    if (!digest) throw new Error('Unsupported scanner platform');
    temporary = mkdtempSync(join(tmpdir(), 'infinity-secret-scan-'));
    const name = `gitleaks_${VERSION}_${process.platform}_${process.arch}.tar.gz`;
    const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${name}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Scanner download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyAsset(bytes, digest);
    const archive = join(temporary, 'scanner.tar.gz');
    writeFileSync(archive, bytes, { mode: 0o600 });
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', temporary, 'gitleaks'], { stdio: 'pipe' });
    if (unpack.status !== 0) throw new Error('Scanner extraction failed');
    // Fixed reviewed config extends built-in rules, bypassing arbitrary repository-local config.
    const config = join(temporary, 'gitleaks.toml');
    writeFileSync(config, SCANNER_CONFIG, { mode: 0o600 });
    const report = join(temporary, 'report.json');
    const result = spawnSync(join(temporary, 'gitleaks'), [...args, '--config', config,
      '--report-format', 'json', '--report-path', report], {
      stdio: 'pipe', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: temporary },
    });
    // Never consume or echo scanner diagnostics/report: even redacted findings can contain source
    // context. Only a fixed outcome crosses the scanner trust boundary.
    const outcome = scannerOutcome({ status: result.status, error: result.error });
    (outcome.exitCode === 0 ? console.log : console.error)(outcome.message);
    return outcome.exitCode;
  } catch {
    console.error('Secret scan could not complete. Check platform, network, checksum and Git history; no scanner output was disclosed.');
    return 2;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
