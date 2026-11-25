// point-frame.mjs — the CTA point carries no list number and names its product.
//
// Owner, 2026-11-19, on points that broke the list ("The fat your heart runs on: omega-3" in a numbered
// list, "The one detail that decides whether it works" after "1. ..."): "we might need better safeguard
// for this". Read across Nov 15-19: 10 of 64 numbered-list threads carried an unnumbered or
// wrong-style CTA point, and 21 of 85 titles did not name the product (owner 2026-11-19: the title names
// the product "so people are prepared and know this is about omega 3 already").
//
// pointFrameIssues(tweets) finds the heavy point (two tweets before the "Which X?" plug) and the light
// point (the tweet before the "If you're looking to" plug), reads the list style the thread already
// uses (numbers "3." / "3)" / "3/", or "Rule 3", "Step 3", "Day 3", "#3"), and reports when a point:
//   - carries a list number (owner 2026-11-22: "cta should not be numbered"; it reverses the
//     2026-11-19 rule that numbered the point as the next list item);
//   - has a first line (the title) that does not name its product.
// A thread with no list style (a story, a seed pot with no titled point) is only checked for the title.
// Pure: no I/O, so pot-gate and the scaffolds can call it on any draft.

// Non-native frame (owner 2026-11-21): a signs / symptoms / avoid / worst / causes / "can't cope" list, where
// every item reads as a sign. Its CTA point is the sign as the title and the mechanism under it, naming the
// substance as the fix (owner 2026-11-22), so the product is named in the body, not the title.
export const NON_NATIVE_HOOK = /\b(?:signs?|symptoms?|warning|red flags?|avoid\w*|worst|causes?|can(?:'|’)t cope|mistakes?)\b/i;
export const nonNativeFrame = (hook) => NON_NATIVE_HOOK.test(String(hook || ''));

export const STYLES = [
  { key: 'dot', re: /^\s*(\d{1,2})\.\s/ },
  { key: 'paren', re: /^\s*(\d{1,2})\)\s/ },
  { key: 'slash', re: /^\s*(\d{1,2})\/\s/ },
  { key: 'rule', re: /^\s*rule\s+(\d{1,2})\b/i },
  { key: 'step', re: /^\s*step\s+(\d{1,2})\b/i },
  { key: 'day', re: /^\s*day\s+(\d{1,2})\b/i },
  { key: 'hash', re: /^\s*#(\d{1,2})\b/ },
];

// Product nouns and the words that count as naming them in a title.
export const ALIASES = [
  ['omega', 'fish oil', 'epa', 'dha'],
  ['magnesium', 'glycinate', 'magtein', 'threonate'],
  ['creatine'],
  ['ashwagandha', 'ksm-66', 'ksm'],
  ['b12', 'methylcobalamin', 'b vitamin'],
  ['beet', 'nitrate'],
  ['nad'],
  ['vitamin d', 'd3', 'k2'],
  ['collagen'],
  ['zinc'],
  ['coq10', 'ubiquinol'],
  ['berberine'],
  ['protein', 'whey'],
];

export function styleOf(line) {
  for (const s of STYLES) {
    const m = String(line || '').match(s.re);
    if (m) return { key: s.key, n: Number(m[1]) };
  }
  return null;
}

export const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// Every line of every tweet before `end` that opens a list item, in order.
function listItems(tweets, end) {
  const out = [];
  for (let i = 0; i < end; i += 1) {
    for (const line of String(tweets[i] || '').split('\n')) {
      const s = styleOf(line);
      if (s) out.push({ ...s, tweet: i });
    }
  }
  return out;
}

export const has = (text, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(String(text || ''));

export function aliasGroup(text) {
  return ALIASES.find((g) => g.some((w) => has(text, w))) || null;
}

function productOf(plug, kind) {
  const t = String(plug || '');
  if (kind === 'heavy') {
    const m = t.match(/^\s*Which\s+([^?]{2,40})\?/);
    return m ? m[1] : '';
  }
  const m = t.match(/look for\s+([^,.\n]{2,60})/i);
  return m ? m[1] : '';
}

export function pointFrameIssues(tweets) {
  const T = (tweets || []).map((t) => String(t ?? ''));
  const issues = [];
  const heavy = T.findIndex((t) => /^\s*Which\s+[^?]{2,40}\?/.test(t));
  const light = T.findIndex((t, i) => i > heavy && /^\s*If you(?:'|’)re looking to\b/.test(t));
  const points = [];
  // The point is the tweet before its plug, or the one before that when the tweet in between is the
  // criterion (point / criterion / plug). A titled list item right before the plug is always the point.
  const isCriterion = (t) => /\bbut most\b|^\s*most\b|on the back|only one kind|the front says|\bcheap\b/i.test(String(t || ''));
  const locate = (plug) => {
    if (styleOf(firstLine(T[plug - 1]))) return plug - 1;
    if (plug >= 2 && isCriterion(T[plug - 1])) return plug - 2;
    return plug - 1;
  };
  if (heavy >= 1) points.push({ kind: 'heavy', at: locate(heavy), plug: heavy });
  if (light >= 1) points.push({ kind: 'light', at: locate(light), plug: light });

  for (const p of points) {
    let title = firstLine(T[p.at]);
    const label = `${p.kind} point (T${p.at + 1})`;
    const before = listItems(T, p.at);
    // When every list item so far sits in the hook ("1. Creatine." in the hook, its body in the tweets
    // after), the point still belongs to the hook's item: there is no new item to number yet.
    // Only when that hook item is the product itself ("1. Creatine."), so an unnumbered "The fix: ..."
    // after a hook item about something else is still caught.
    const group = aliasGroup(productOf(T[p.plug], p.kind));
    const hookLines = String(T[0]).split('\n').filter((l) => styleOf(l));
    const lastHookItem = (hookLines[hookLines.length - 1] || '').trim();
    const hookItem = !styleOf(title) && before.length > 0 && before.every((it) => it.tweet === 0)
      && !!group && group.some((w) => has(lastHookItem, w));
    if (hookItem) title = lastHookItem;
    // CTA points carry NO list number (owner 2026-11-22: "Fix the rule, cta should not be numbered").
    // This reverses the 2026-11-19 rule that numbered them as the next list item. The list's own items keep
    // their numbers; the CTA point stands outside the count. A point that continues the hook's own item
    // ("1. Creatine." in the hook) is that item, not a new numbered title, so it is not read here.
    const mine = styleOf(title);
    if (!hookItem && mine) {
      issues.push({ tweet: p.at + 1, kind: p.kind, msg: `${label} is numbered ("${title.slice(0, 40)}"); CTA points carry no list number, drop it (owner 2026-11-22)` });
    }
    // A thread whose hook already names the product (a how-to-take-it thread) has told the reader.
    // A signs-list point names the product in its mechanism, under the sign (owner 2026-11-22).
    const answer = nonNativeFrame(T[0]) ? String(T[p.at]) : '';
    if (group && p.at > 0 && !group.some((w) => has(T[0], w)) && !group.some((w) => has(title, w)) && !group.some((w) => has(answer, w))) {
      issues.push({ tweet: p.at + 1, kind: p.kind, msg: `${label} title "${title.slice(0, 50)}" does not name the product (${group[0]}); say it in the title` });
    }
  }
  return issues;
}
