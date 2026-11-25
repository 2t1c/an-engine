// rebuild-plug-tweets.mjs — one-off (re-runnable) repair of the plug-funnel fields on historical
// Published Content rows (2026-09-13).
//
// WHY. metrics.plugTweetIndices keyed on the affiliate disclosure, and every account disclaimer
// says "affiliate" too, so the closing disclaimer was counted as a plug (fixed in metrics.mjs the
// same day: DISCLAIMER_TWEET_RE). registry-sync computes the funnel only while a post is inside
// PERTWEET_DAYS (21d) and then FREEZES it by omitting the keys, so the fixed detector never reaches
// a row that aged out — 217 of 730 plug rows on the 16 Aug → 13 Sep registry kept the wrong index
// and a diluted True Plug CTR. This script re-pulls Typefully's per-tweet analytics for the whole
// range (the endpoint has no 60d cap; the 21d window in registry-sync is a volume choice, not a
// limit), re-detects the plugs, recomputes the four derived fields with the SAME functions the
// nightly sync uses, and PATCHes only rows whose values change.
//
// Fields touched: Plug Tweets, Plug Exposure %, True Plug CTR %, Post-Plug Drop %. Tweet Views and
// Read-Through % do not depend on the plug index and are left alone. Rows Typefully no longer has
// per-tweet rows for (scrape-frozen, deleted, manual) are reported, never guessed at.
//
//   node rebuild-plug-tweets.mjs --since 2026-08-16 [--until YYYY-MM-DD] [--dry] [--account Julian]
//
// REFUSES SINCE 2026-10-02. Its only source was Typefully's per-tweet /analytics/x/posts
// (include_replies=true), which has answered 404 since 2026-09-30. X's public counts give per-tweet
// views but no link clicks, and True Plug CTR is clicks over views, so there is nothing honest to
// rebuild from. It used to catch each account's failed read, report every row as "no per-tweet
// rows (left as is)" and exit 0, which reads like a clean pass. It now stops before any read.
// rebuildFields stays for the day a per-tweet source returns.
import { ANALYTICS_GONE } from './x-views.mjs';
import { plugFunnel, plugTweetIndices } from './metrics.mjs';

const r4 = (x) => (x == null ? undefined : Math.round(x * 1e4) / 1e4);

// pure: the patch for one row, or null when nothing changes. Exported for the scaffolds.
export function rebuildFields(existing, series, stampedPlugs = []) {
  const detected = plugTweetIndices(series.map((t) => t.text));
  const stamped = (stampedPlugs || []).filter((p) => p >= 1 && p <= series.length);
  const plugIdx = detected.length ? detected : stamped;
  const f = plugFunnel(series, plugIdx);
  const next = {
    'Plug Tweets': plugIdx.length ? plugIdx.join(',') : null,
    'Plug Exposure %': f.plugExposure != null ? r4(f.plugExposure) : null,
    'True Plug CTR %': f.truePlugCtr != null ? r4(f.truePlugCtr) : null,
    'Post-Plug Drop %': f.postPlugDrop != null ? r4(f.postPlugDrop) : null,
  };
  const patch = {};
  for (const [k, v] of Object.entries(next)) {
    const cur = existing[k] == null ? null : (k === 'Plug Tweets' ? String(existing[k]) : r4(Number(existing[k])));
    if (cur !== v) patch[k] = v;
  }
  return Object.keys(patch).length ? { patch, plugIdx, detected, stamped } : null;
}

export const REFUSAL = `rebuild-plug-tweets: refusing to run — ${ANALYTICS_GONE}, and it was the only source of per-tweet views and link clicks. Nothing was read or written; the Plug Tweets / Plug Exposure % / True Plug CTR % / Post-Plug Drop % fields keep their current values.`;

async function main() {
  // The repair loop that read per-tweet analytics, re-detected plugs and PATCHed the registry was
  // removed with the endpoint (see git history before 2026-10-02 to restore it against a new source).
  throw new Error(REFUSAL);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
