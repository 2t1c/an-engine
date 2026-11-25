// Leftover-ID check: the engine must carry nothing that belongs to the operator's own operation or
// to another buyer. Two layers:
//   1. PATTERNS, which need no list: Airtable ids (app/tbl/fld/rec/viw + 14) and Telegram group ids
//      (-100...). Real ones live only in config/ (the buyer's own) or in Railway variables.
//   2. A PRIVATE DENYLIST kept outside the repo (LEFTOVER_DENYLIST=/path/to/file, one term per line):
//      the operator's page handles, Typefully set ids, subid prefixes, product shelf names. It stays
//      outside so the list itself never ships in a clone.
import { readFileSync } from 'node:fs';

export const PATTERNS = [
  { name: 'airtable-id', re: /\b(?:app|tbl|fld|rec|viw)[A-Za-z0-9]{14}\b/g },
  { name: 'telegram-group-id', re: /-100\d{9,13}\b/g },
];

/** Paths a buyer's clone fills with its own ids, so they are never scanned. */
export const SKIP = [/^config\/(?!.*\.example\.json$)/, /^node_modules\//, /^\.git\//, /^package-lock\.json$/];

/** PURE. Terms from a denylist file's text: one per line, # comments, blank lines ignored. */
export function parseDenylist(text) {
  return String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.length >= 3);
}

export function loadDenylist(path) {
  if (!path) return [];
  return parseDenylist(readFileSync(path, 'utf8'));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * PURE. Findings in one file's text.
 * @param {string} path repo-relative
 * @param {string} text
 * @param {string[]} denylist
 */
export function scanText(path, text, denylist = []) {
  if (SKIP.some((re) => re.test(path))) return [];
  const found = [];
  const lines = String(text).split('\n');
  const deny = denylist.map((t) => ({ term: t, re: new RegExp(`(^|[^A-Za-z0-9_])${escape(t)}(?![A-Za-z0-9_])`, 'i') }));
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      for (const m of line.matchAll(p.re)) found.push({ path, line: i + 1, kind: p.name, match: m[0] });
    }
    for (const d of deny) {
      // The denylist term itself is never echoed back in full, so CI logs do not republish it.
      if (d.re.test(line)) found.push({ path, line: i + 1, kind: 'denylist', match: `${d.term.slice(0, 2)}…` });
    }
  });
  return found;
}
