#!/usr/bin/env node
// scripts/claims-weak-labels.mjs — builds evals/jev/claims.jsonl, the claims battery's eval set.
//
// Why weak labels: docs/claim-safety.md (the 2026-08-31 audit of 1,110 tweets) publishes counts only
// (16 testimonials, 45 unsourced statistics) and one fixture. Its per-tweet labels were never committed
// (checked: no labels file in the tree or in git history), so they cannot be recovered. This script
// labels the thread specs in queues/threads/*.json with regexes instead, and marks every row
// `source: "regex-weak"`. A weak label is what a regex says, not the truth: recall against it is
// agreement with the regex.
//
// The weak labeler is deliberately NOT the incumbent (decisions/claims-battery.mjs incumbentTweet):
//   - results_testimonial and unsourced_statistic use the gate spec the audit itself proposed
//     (docs/claim-safety.md "Gate spec" 1 and 2), which no gate implements today;
//   - stated_as_proven and absolute_superlative use checks.mjs's own patterns (EVIDENCE_VERB_RE,
//     absoluteSuperlativeIssue) over EVERY tweet, where the gates read plug tweets only;
//   - disease_treatment is hardHealthClaim itself, so on that class the incumbent is the labeler and
//     its recall is 1 by construction (the report says so).
//
// No copy is written: each row is { id, path, index, sha256, plug, source, labeler, labels }. The harness
// reads the tweet from `path` at `index` and skips it when its sha256 no longer matches.
//
//   node scripts/claims-weak-labels.mjs [--neg-rate 0.1] [--out evals/jev/claims.jsonl] [--stats]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteSuperlativeIssue, hardHealthClaim } from '../checks.mjs';
import { getAccount } from '../accounts.mjs';
import { isBoilerplate } from '../content/text-shape.mjs';
import { HOLD_CLASSES } from '../decisions/claims-battery.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LABELER = 'claims-weak-v1';

// docs/claim-safety.md Gate spec 1: a first-person past-tense change construction.
export const TESTIMONIAL_RE = /\b(?:what changed was|stopped feeling|started feeling|no longer|used to (?:wake|feel|struggle|be)|went away|first time in)\b/i;
export const FIRST_PERSON_RE = /\b(?:I|I'm|I've|I'd|my|me|mine)\b/;
// docs/claim-safety.md Gate spec 2, with its own fix applied (no trailing \b after the % sign).
export const STAT_RES = [/\d{1,3}(?:\.\d+)?\s*(?:%|percent)/i, /\b\d[\d,]*\s+(?:reactions|studies|times)\b/i];
// checks.mjs EVIDENCE_VERB_RE (evidenceClaimIssue), read over every tweet instead of plug evidence lines.
export const PROVEN_RE = /\b(?:proves?|proven|guarantees?|cures?|treats?|prevents?|eliminates?)\b/i;
// The association wording checks.mjs asks plug evidence lines to use ("Research links X to …", links/ties/is linked to).
export const HEDGED_RE = /\b(?:research links|linked to|tied to|associated with|links? [^.\n]{1,40}? to (?:better|lower|higher|less|more|reduced|improved)|may (?:help|support|improve|reduce|lower)|studies suggest|research suggests)\b/i;

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Pure: the weak labels for one tweet. */
export function weakLabels(text) {
  const s = String(text ?? '');
  const testimonial = TESTIMONIAL_RE.test(s) && FIRST_PERSON_RE.test(s);
  const disease = hardHealthClaim(s);
  const cls = disease ? 'disease_treatment' : testimonial ? 'results_testimonial' : HEDGED_RE.test(s) ? 'hedged_association' : 'none';
  const labels = {
    class: cls,
    unsourced_statistic: STAT_RES.some((re) => re.test(s)),
    absolute_superlative: Boolean(absoluteSuperlativeIssue(s)),
    stated_as_proven: PROVEN_RE.test(s),
  };
  labels.hold = HOLD_CLASSES.includes(cls) || labels.unsourced_statistic || labels.absolute_superlative || labels.stated_as_proven;
  return labels;
}

const isPositive = (l) => l.class !== 'none' || l.unsourced_statistic || l.absolute_superlative || l.stated_as_proven;
const PLUG_RE = /lvnta\.com\/|gumroad\.com\/|\{\{LINK\d*\}\}/i;

/**
 * Pure over the files it is given: one row per distinct tweet (by text hash; the first file wins), our
 * own closing and disclaimer excluded. Every weak positive is kept; a negative is kept when its hash
 * falls under `negRate` (deterministic, so a rebuild keeps the same rows).
 */
export function buildRows(files, { negRate = 0.1 } = {}) {
  const seen = new Set();
  const rows = [];
  for (const { path, spec } of files) {
    let account = null;
    try { account = getAccount(spec?.account); } catch { /* an unknown account has no boilerplate to skip */ }
    (spec?.tweets || []).forEach((tweet, index) => {
      const text = String(tweet ?? '');
      if (!text.trim() || (account && isBoilerplate(account, text))) return;
      const h = sha(text);
      if (seen.has(h)) return;
      seen.add(h);
      const labels = weakLabels(text);
      if (!isPositive(labels) && parseInt(h.slice(0, 8), 16) / 0xffffffff >= negRate) return;
      rows.push({ id: h.slice(0, 16), path, index, sha256: h, plug: PLUG_RE.test(text), source: 'regex-weak', labeler: LABELER, labels });
    });
  }
  return rows;
}

export function threadFiles(root = ROOT) {
  const dir = join(root, 'queues', 'threads');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return { path: `queues/threads/${f}`, spec: j.spec || {} };
  });
}

function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const negRate = Number(flag('neg-rate', '0.1'));
  const out = resolve(ROOT, flag('out', 'evals/jev/claims.jsonl'));
  const rows = buildRows(threadFiles(), { negRate });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const count = (f) => rows.filter(f).length;
  const stats = {
    rows: rows.length, plug: count((r) => r.plug),
    class: Object.fromEntries(['none', 'hedged_association', 'results_testimonial', 'disease_treatment'].map((c) => [c, count((r) => r.labels.class === c)])),
    unsourced_statistic: count((r) => r.labels.unsourced_statistic), absolute_superlative: count((r) => r.labels.absolute_superlative),
    stated_as_proven: count((r) => r.labels.stated_as_proven), hold: count((r) => r.labels.hold),
  };
  console.log(JSON.stringify(stats));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
