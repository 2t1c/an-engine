// craft-gates.mjs — the canonical-gate findings Jev's editorial read may settle (plan v7 N3; owner
// 2026-09-23, "become jev native": "Jev's reading settles a craft regex hit; safety stays regex OR Jev").
//
// These messages judge how a thread READS (a one-sentence bridge, a cold plug, a criterion after its
// plug, an introduce-and-sell, a generic sign-off, a dangling lead-in, an argued substance left unsold)
// with word tests; RUN-2's 52 of 62 false blockers were this class. Safety, links, placeholders, counts,
// numbering, 280 and disclosures are never here. Shared by the drafts packet (run-content-packets
// settleCraftGates), the ship spec (run-row shipSpecFor -> jevSettled) and the door (publish-thread).
export const CRAFT_GATE_PATTERNS = Object.freeze([
  /one-sentence bridge above the plug/i,
  /arrives cold — no tweet in the/i,
  /has only ONE run-up beat naming/i,
  /SELLS BEFORE IT JUSTIFIES/,
  /sells it in the same breath/i,
  /neither names the substance nor says what to look for/i,
  /generic engagement-bait sign-off/i,
  /thread ends on a colon lead-in/i,
  /thread argues .* but never sells it/i,
]);

export const isCraftGateIssue = (issue) => CRAFT_GATE_PATTERNS.some((re) => re.test(String(issue)));

/** PURE. A craft finding without its quotes and links, so the packet's (placeholder) and the door's
 *  (minted) copies of the same finding key the same, and a finding about other words does not. */
export const craftKey = (issue) => String(issue).replace(/"[^"]*"?/g, '""').replace(/https?:\/\/\S+|\{\{LINK\d*\}\}/g, 'L').replace(/\s+/g, ' ').trim().slice(0, 200);

/** PURE. The door's split: { issues, settled } — settled are craft findings the spec's jevSettled names. */
export function splitJevSettled(issues = [], jevSettled = null) {
  const keys = new Set(Array.isArray(jevSettled?.keys) ? jevSettled.keys : []);
  if (!keys.size) return { issues: [...issues], settled: [] };
  const settled = issues.filter((i) => isCraftGateIssue(i) && keys.has(craftKey(i)));
  return { issues: issues.filter((i) => !settled.includes(i)), settled };
}
