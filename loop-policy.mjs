// loop-policy.mjs — SINGLE SOURCE OF TRUTH for what the autonomous loop may auto-merge vs. must
// route to a human one-tap. Imported by (a) the PR classifier, (b) the bounded Ralph loop's
// leave-as-draft logic, and (c) auto-fix's constraints — so the three can't drift (today the danger
// zones are prose in 3 places: auto-fix.yml HARD CONSTRAINTS, daily-improve-routine.md, and the
// IMPROVEMENTS.md standing triage). Pattern mirrors DENY_ASINS in checks.mjs: export structured data,
// import everywhere. Pure + dependency-free so CI can unit-test it.
//
// MODEL: a change is DANGER (human tap, never auto-merge) if it touches any protected PATH (a changed
// file matches a glob) OR any protected CONTENT pattern (an added/removed diff line matches a regex).
// Both granularities matter: whole files (secrets, workflows, schedulers) AND specific lines inside an
// otherwise-mixed file (a subid tweak buried in a big refactor). On a live money/publishing pipeline the
// safe-to-auto set is deliberately SMALL — CI green proves "compiles + structurally valid", NOT "the
// content got better" — so anything touching generation / plug / selection / money / schedule / publish
// defaults to a tap even when CI is green.

export const POLICY_VERSION = 4;

// A trusted reviewer uses this class only after reviewing the complete immutable diff and accepting
// every consequence of the change. Unlike the narrower classes below, it can authorize protected
// paths/content and the formerly human-only families. CI and every evidence/race guard still apply.
export const REVIEWED_ALL_CLASS = 'reviewed-all';

// ---- protected file globs (path-level danger -> always a tap) ----
export const DANGER_PATHS = [
  // secrets / credentials / identity-config
  '.env', '.env.*', '*.key', 'secrets.*', 'sync-secrets.mjs', 'sync-secrets.*', 'config.mjs', 'accounts.mjs',
  // money / attribution / link-minting / product policy
  'revenue.mjs', 'tracking-smoke.mjs', 'pick-product.mjs', 'swap-product.mjs', 'performance.mjs', 'checks.mjs',
  // generation / plug / selection / publish — "CI green != content good" zone
  'recreate.mjs', 'qc.mjs', 'cta.mjs', 'media.mjs', 'republish.mjs',
  'fill-queue.mjs', 'fill-account.mjs',
  // scheduling / cron / calendar (cron TIMES live in the workflows)
  'slots.mjs', 'reslot.mjs', 'reschedule-sync.mjs', 'calendar.mjs',
  // shared core lib + entrypoints + the registry/learn/retro brains
  'lib.mjs', 'mcp-server.mjs', 'registry-sync.mjs', 'learn.mjs', 'retro.mjs', 'retro-core.mjs', 'revenue.mjs',
  // the gates + infra themselves — a loop editing its own guardrails is THE canonical danger
  '.github/**', 'loop-policy.mjs', 'auto-merge-bot.mjs', 'auto-merge-evidence.mjs', 'smoke-test.mjs', 'package.json', 'package-lock.json',
  // Agent instructions and prompt/template inputs are executable policy even when written as Markdown.
  'AGENTS.md', '**/AGENTS.md', 'CLAUDE.md', '.claude/**', '.codex/**', 'skills/**', 'prompts/**', 'templates/**',
  // These directories are named docs, but their JavaScript is the source deployed into live n8n nodes.
  'docs/bridge-nodes/**', 'docs/fuel-nodes/**',
  // injected content policy + committed state the loop must never hand-edit
  'style/**', 'ledger.jsonl', 'queues/**', 'products.json', 'logs/**', 'learnings/**',
];

// ---- protected content patterns (line-level danger inside mixed/shared files, e.g. lib.mjs) ----
// Checked against ADDED/REMOVED diff lines only. Forces a tap even if the file isn't path-protected.
export const DANGER_PATTERNS = [
  { name: 'attribution/subid', re: /subid1|subid2|\blv_|lvnta|levanta|url_parameters|[?&]ref=|tagGumroad|mintLink/i },
  { name: 'money/commission',  re: /\bcommission\b|\bEPC\b|gumroad_fee|\bpayout\b|price\s*[-/]\s*|defaultProduct/i },
  { name: 'product-policy',    re: /DENY_ASINS|STACK_RE|isStack|PLUG_LIMIT|TWEET_LIMIT/i },
  { name: 'schedule/cron',     re: /cron:|publish_at|postHour|harvestHour|SLOT_TIMES|EMERG_SLOTS|Asia\/Saigon|\b\d{1,2}:\d{2}\b.*UTC/i },
  { name: 'compliance',        re: /disclaimer|disclosure|Aff link|#ad|affiliate/i },
  { name: 'secrets',           re: /[A-Z0-9_]*API_KEY|ACCESS_TOKEN|AIRTABLE_PAT|_TOKEN\b|Bearer\s/i },
  { name: 'publish',           re: /createDraft|patchDraft|socialSetId|typefully|scheduled_date/i },
];

// ---- structurally-safe allowlist (auto-merge ELIGIBLE iff CI green AND auto-review PASS AND no danger) ----
// Narrow on purpose. Code changes NOT clearly here must be CERTIFIED a safe class by the auto-review.
export const AUTO_MERGEABLE = {
  // Tests and docs/ are deliberately absent: both contain code CI executes or operators deploy.
  // A trusted review may still certify them as add-test/docs; their directory name is not approval.
  paths: ['README', 'README.md'],
  // semantic classes the Claude auto-review may certify even inside code (it must name one):
  classes: ['add-test', 'add-guard', 'add-alert', 'add-logging', 'docs', 'behavior-preserving-refactor', REVIEWED_ALL_CLASS],
};

// ---- families that are ALWAYS a human decision regardless of path/pattern (IMPROVEMENTS standing triage) ----
export const HUMAN_ONLY_FAMILIES = [
  'per-hook / per-plug subid attribution',
  'revenue-feedback into selection or the retro signal',
  'account-allocation / per-account quotas',
  'untracked-post hard-blocking / auto-backfill',
  'live money action (test purchase, real spend)',
];

// ---- Markdown-only self-merge (owner, 2026-10-07: approved the draft rule) ----
// A PR whose every changed file is prose in these places is not a protected change: the content
// patterns exist to catch code and match ordinary skill prose ("affiliate", "typefully", "cron").
// Code, workflows, hooks, settings, AGENTS.md, CLAUDE.md and committed state stay protected, and one
// file outside this set puts the whole PR back to a tap. CI and the exact-head checks still apply.
export const MARKDOWN_SELF_MERGE = {
  include: ['.claude/skills/**/*.md', 'docs/*.md', 'docs/**/*.md', '*.md'],
  exclude: ['AGENTS.md', 'CLAUDE.md', 'docs/bridge-nodes/**', 'docs/fuel-nodes/**'],
};

// minimal glob matcher (no deps): * within a segment, ** across segments.
const globToRe = (g) => new RegExp('^' + g
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\\u0000').replace(/\*/g, '[^/]*').replace(/\\u0000/g, '.*') + '$');
const matchesAny = (file, globs) => globs.some((g) => globToRe(g).test(file));

export const markdownSelfMerge = (f) => matchesAny(f, MARKDOWN_SELF_MERGE.include) && !matchesAny(f, MARKDOWN_SELF_MERGE.exclude);

// classify(changedFiles, unifiedDiff) -> { danger, reasons[], allSafePath, patternHits[] }
export function classify(changedFiles = [], unifiedDiff = '') {
  const reasons = [];
  if (changedFiles.length > 0 && changedFiles.every(markdownSelfMerge)) return { danger: false, reasons, allSafePath: false, patternHits: [], markdownOnly: true };
  const pathHits = changedFiles.filter((f) => matchesAny(f, DANGER_PATHS));
  pathHits.forEach((f) => reasons.push(`protected path: ${f}`));
  const changedLines = unifiedDiff.split('\n').filter((l) => /^[+-]/.test(l) && !/^[+-]{3} /.test(l)).join('\n');
  const patternHits = DANGER_PATTERNS.filter((p) => p.re.test(changedLines)).map((p) => p.name);
  patternHits.forEach((n) => reasons.push(`protected content: ${n}`));
  const allSafePath = changedFiles.length > 0 && changedFiles.every((f) => matchesAny(f, AUTO_MERGEABLE.paths));
  return { danger: pathHits.length > 0 || patternHits.length > 0, reasons, allSafePath, patternHits };
}

// The final auto-merge decision. Every merge requires green CI and an exact-head trusted review.
// Narrow review classes remain unable to cross a danger boundary. `reviewed-all` records an explicit
// full-scope decision and may cross that boundary; it does not bypass evidence, CI, or race checks.
export function autoMergeEligible({ classification, ciGreen, reviewPass, reviewClass }) {
  if (!ciGreen) return { auto: false, why: 'CI not green' };
  if (!reviewPass) return { auto: false, why: 'auto-review did not pass' };
  if (reviewClass === REVIEWED_ALL_CLASS) {
    const scope = classification.danger ? `; accepted: ${classification.reasons.join('; ')}` : '';
    return { auto: true, why: `trusted full review: ${REVIEWED_ALL_CLASS}${scope}` };
  }
  if (classification.danger) return { auto: false, why: `danger -> tap (${classification.reasons.join('; ')})` };
  if (classification.allSafePath) return { auto: true, why: 'all changes in safe-path allowlist' };
  if (reviewClass && AUTO_MERGEABLE.classes.includes(reviewClass)) return { auto: true, why: `review-certified: ${reviewClass}` };
  return { auto: false, why: 'code change not certified structurally-safe -> tap' };
}
