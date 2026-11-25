import { DISCLOSURE_LINE_RE } from './disclosure.mjs';
// metrics.mjs — pure, offline helpers for the audience/funnel metrics layer (2026-08-17).
// No imports, no I/O: everything here is unit-tested in test-scaffolds.mjs and shared by
// recreate.mjs (hook/plug stamping), registry-sync.mjs (per-tweet plug funnel, redirect
// survival, follower snapshot) and weekly-metrics.mjs (north-star + growth-shape rollups).
//
// Blank-vs-zero rule (same as the registry): every function returns null for "not computable"
// — a thread with no per-tweet data must never read as "measured 0% exposure".

// ---- hook identity -------------------------------------------------------------------------------
// A stable id for a hook's TEXT: hk_ + FNV-1a hash of tweet 1, normalized so cosmetic noise
// (case, URLs, punctuation, whitespace) doesn't mint a new id. Two uses, stamped separately:
//   - subid2 at mint time = hookIdOf(DONOR tweet 1)  -> the hook FAMILY (mint happens before
//     generation, so the shipped hook can't exist yet; the donor hook is the family anchor —
//     fan-out siblings recreating the same donor share it).
//   - ledger hookId       = hookIdOf(FINAL tweet 1)  -> the exact shipped hook (reposts of the
//     same text share it; a rotation's new hook gets its own).
export function hookIdOf(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')  // links churn (t.co vs raw) without the hook changing
    .replace(/[^a-z0-9]+/g, ' ')     // punctuation/emoji/whitespace are cosmetic
    .trim();
  if (!norm) return null;
  let h = 0x811c9dc5;                // FNV-1a 32-bit
  for (let i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `hk_${h.toString(36).padStart(7, '0')}`;
}

// ---- plug detection ------------------------------------------------------------------------------
// 1-based indices of the plug (CTA) tweets. Keyed on the affiliate DISCLOSURE, not the link: every
// plug is hard-gated to carry one (ensureDisclosure), and the disclosure survives into the PUBLISHED
// text — where the URL itself becomes an opaque t.co, so link-matching would find nothing. Works
// identically on draft tweets and on Typefully's per-tweet preview_text. (Non-affiliate plugs — e.g.
// an ebook page's narrative CTA — carry no disclosure and are deliberately not counted: these
// metrics price the AFFILIATE funnel.)
//
// MUST match both tokens. The whole revenue history is disclosed with "Aff link:" and everything
// from 2026-08-21 with "#ad"; a marker that reads only one of them silently reports zero plugs for
// half the archive, and every rate this module computes is per-plug.
export const PLUG_MARKER_RE = DISCLOSURE_LINE_RE;
// NOT THE DISCLAIMER (2026-09-13). Every account's closing disclaimer says "affiliate" too — "Before
// you go: a few links above are affiliate links…", "Quick disclosure: some links in this thread are
// affiliate links…", the legacy "DISCLAIMER: This thread may contain affiliate links" — so the
// disclosure-keyed detector counted the disclaimer as a plug. Measured on the 16 Aug → 13 Sep
// registry: 217 of 730 "plug" rows pointed at the closing or disclaimer tweet, every one with zero
// clicks, and they dragged the fleet's per-plug CTR from 0.82% to a reported 0.62%. All 23 live and
// legacy disclaimers carry one of these medical markers and none carries a URL; a plug carries a
// URL and never a medical marker. Keyed on the marker rather than the URL because Typefully's
// preview_text is not guaranteed to keep the t.co.
// Historical rows were repaired once with rebuild-plug-tweets.mjs (388 rows, 2026-09-13); the nightly
// sync freezes the funnel after PERTWEET_DAYS, so a detector change never reaches old rows on its own.
export const DISCLAIMER_TWEET_RE = /medical advice|\bFDA\b|diagnose|physician|\bdoctor\b|practitioner|not intended to|^\s*DISCLAIMER:/im;
export const isDisclaimerTweet = (t) => DISCLAIMER_TWEET_RE.test(String(t || ''));
// The trailing tweet plugFunnel drops before measuring read-through: the legacy "DISCLAIMER" block,
// or any tweet carrying both a disclaimer marker and the affiliate disclosure word (every live,
// legacy and onboarding-bank disclaimer does; no closing does — pinned in tests).
export const isReadThroughDisclaimer = (t) => {
  const s = String(t || '');
  return /^\s*disclaimer\b/i.test(s) || (isDisclaimerTweet(s) && PLUG_MARKER_RE.test(s));
};
export function plugTweetIndices(texts) {
  const out = [];
  (texts || []).forEach((t, i) => { const s = String(t || ''); if (PLUG_MARKER_RE.test(s) && !isDisclaimerTweet(s)) out.push(i + 1); });
  return out;
}

// ---- per-tweet series ----------------------------------------------------------------------------
// Per-tweet rows for ONE draft -> ordered series. Thread order = created_at ascending (tweet 1 posts
// first); i is the 1-based position. Rows came from Typefully /analytics/x/posts (include_replies=true)
// until it went 404 on 2026-09-30; nothing in the repo supplies per-tweet rows today.
// A count the row does not carry is NULL, never 0: v is null without a numeric metrics.impressions,
// and c is null when the row carries no engagement block at all (a source that does not measure
// clicks). Inside an engagement block a null link_clicks stays 0 — Typefully's "no link in this
// tweet", which is a real zero.
const numOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export function tweetSeries(rows) {
  return [...(rows || [])]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((p, i) => ({
      i: i + 1,
      v: numOrNull(p.metrics?.impressions),
      c: p.metrics?.engagement && typeof p.metrics.engagement === 'object' ? (numOrNull(p.metrics.engagement.link_clicks) ?? 0) : null,
      text: p.preview_text || '',
    }));
}

export function median(xs) {
  const s = (xs || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- the plug funnel -----------------------------------------------------------------------------
// series = tweetSeries() output; plugIdx = 1-based plug positions (ledger plugTweets stamp, else
// plugTweetIndices over the series texts). Returns {plugExposure, truePlugCtr, postPlugDrop,
// readThrough, curve} — each null when its inputs don't support it.
//
//   plugExposure  = first-plug-tweet views / tweet-1 views. The missing middle of CTR: how much
//                   of the hook audience ever SAW the ask.
//   truePlugCtr   = plug-tweet link clicks / plug-tweet views (summed across plugs) — the plug
//                   copy's honest conversion, not diluted by hook reach.
//   postPlugDrop  = EXCESS drop at the first plug boundary: (1 - v[plug+1]/v[plug]) minus the
//                   median per-step drop across non-plug boundaries. The operator's retention
//                   signal: a steep drop right after the CTA means readers LEFT there — with a
//                   high truePlugCtr that's "clicked and left" (good); with a low one it's
//                   "bailed at the ad" (bad). Negative = the plug held readers above baseline.
//   readThrough   = last content tweet's views / tweet-1 views (a trailing DISCLAIMER tweet is
//                   excluded — it is mandated last and would understate every thread equally).
//   curve         = compact [{i, v, c?}] for the dashboard's drop-off chart (c omitted when 0).
export function plugFunnel(series, plugIdx = []) {
  const s = series || [];
  const curve = s.map(({ i, v, c }) => (c ? { i, v, c } : { i, v }));
  const out = { plugExposure: null, truePlugCtr: null, postPlugDrop: null, readThrough: null, curve };
  // An unread count (null) makes every ratio it feeds null: never computed as if it were 0.
  if (s.length < 3 || !(s[0].v > 0)) return out;
  const hook = s[0].v;

  // read-through, disclaimer excluded. The "DISCLAIMER:" prefix only ever matched the legacy block
  // retired 2026-08-23; every current per-account disclaimer ("Before you go: …", "Quick
  // disclosure: …") opens differently, so read-through was measured TO the disclaimer. A current
  // disclaimer is recognised as a medical marker (isDisclaimerTweet) plus the affiliate word every
  // disclaimer carries — both required, so a last content tweet that merely says "doctor" stays in.
  let end = s.length - 1;
  if (isReadThroughDisclaimer(s[end].text) && end > 0) end -= 1;
  if (end > 0 && s[end].v != null) out.readThrough = s[end].v / hook;

  const plugs = (plugIdx || []).filter((p) => p >= 1 && p <= s.length);
  if (!plugs.length) return out;

  if (s[plugs[0] - 1].v != null) out.plugExposure = s[plugs[0] - 1].v / hook;
  if (plugs.every((p) => s[p - 1].v != null && s[p - 1].c != null)) {
    const pv = plugs.reduce((sum, p) => sum + s[p - 1].v, 0);
    const pc = plugs.reduce((sum, p) => sum + s[p - 1].c, 0);
    if (pv > 0) out.truePlugCtr = pc / pv;
  }

  // Excess drop at the first plug boundary vs the thread's own baseline decline.
  // Boundary b sits between positions b+1 and b+2 (1-based); it is plug-adjacent when either
  // side is a plug tweet — those are excluded from the baseline so plugs can't grade themselves.
  const drops = [];  // [boundary 0-based, drop]
  for (let b = 0; b + 1 < s.length; b++) if (s[b].v > 0 && s[b + 1].v > 0) drops.push([b, 1 - s[b + 1].v / s[b].v]);
  const isPlugAdjacent = (b) => plugs.includes(b + 1) || plugs.includes(b + 2);
  const plugBoundary = drops.find(([b]) => b === plugs[0] - 1);
  const baseline = median(drops.filter(([b]) => !isPlugAdjacent(b)).map(([, d]) => d));
  if (plugBoundary && baseline != null && drops.length >= 4) out.postPlugDrop = plugBoundary[1] - baseline;
  return out;
}

// ---- redirect survival ---------------------------------------------------------------------------
// Levanta-measured clicks / Typefully-measured clicks: what share of clicks on X survived the
// lvnta.com hop (interstitial tap gate) to reach the destination. Null unless both sensors read
// AND Typefully >= Levanta — Typefully's sensor spends whole months half-alive reading BELOW the
// destination truth, and a ratio over an undercounting denominator is >100% nonsense, not a
// funnel measurement. minClicks keeps tiny samples from minting wild percentages.
export function redirectSurvival(affClicks, tfClicks, minClicks = 10) {
  if (!Number.isFinite(affClicks) || !Number.isFinite(tfClicks)) return null;
  if (tfClicks < minClicks || affClicks > tfClicks) return null;
  return affClicks / tfClicks;
}

// ---- follower series -----------------------------------------------------------------------------
// Typefully followers data ([{date, followers_count}]) -> per-day rows with deltas computed by
// EXACT date lookup (a gap in the series yields null deltas, never a wrong subtraction).
export function followerDeltas(data) {
  const rows = [...(data || [])]
    .map((d) => ({ date: String(d.date || '').slice(0, 10), followers: Number(d.followers_count ?? d.followers) }))
    .filter((d) => d.date && Number.isFinite(d.followers))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const byDate = new Map(rows.map((r) => [r.date, r.followers]));
  const shift = (date, days) => {
    const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  return rows.map((r) => ({
    ...r,
    delta1: byDate.has(shift(r.date, 1)) ? r.followers - byDate.get(shift(r.date, 1)) : null,
    delta7: byDate.has(shift(r.date, 7)) ? r.followers - byDate.get(shift(r.date, 7)) : null,
  }));
}

// ---- growth-curve shape (Growth Log hourly samples for one post) ---------------------------------
// samples = [{age, views, rise?}] (hours, cumulative views, views/hr). Returns
// {halfLifeH, peakRiseH, shareAfter12} — the three shape stats the X-ALGORITHM notes cite as
// one-off findings ("winners take 44% of views after h12, peak ~h9.8"), now computable weekly.
//   halfLifeH    = age at which views first reach 50% of the final observed count (interpolated).
//   peakRiseH    = age at the max Rise/hr sample.
//   shareAfter12 = 1 - views(h12)/final — requires the curve to have lived past MIN_LIFE_H so
//                  "final" is meaningfully later than h12.
const MIN_LIFE_H = 16;
export function growthShape(samples) {
  const s = [...(samples || [])]
    .map((x) => ({ age: Number(x.age), views: Number(x.views), rise: Number.isFinite(Number(x.rise)) ? Number(x.rise) : null }))
    .filter((x) => Number.isFinite(x.age) && Number.isFinite(x.views) && x.age >= 0)
    .sort((a, b) => a.age - b.age);
  const out = { halfLifeH: null, peakRiseH: null, shareAfter12: null };
  if (s.length < 3) return out;
  const final = Math.max(...s.map((x) => x.views));
  if (!(final > 0)) return out;

  // linear interpolation of the cumulative curve at an arbitrary age
  const viewsAt = (age) => {
    if (age <= s[0].age) return s[0].views;
    for (let i = 1; i < s.length; i++) {
      if (s[i].age >= age) {
        const a = s[i - 1], b = s[i];
        return b.age === a.age ? b.views : a.views + ((b.views - a.views) * (age - a.age)) / (b.age - a.age);
      }
    }
    return s[s.length - 1].views;
  };
  // half-life: first crossing of final/2
  const half = final / 2;
  for (let i = 0; i < s.length; i++) {
    if (s[i].views >= half) {
      if (i === 0) { out.halfLifeH = s[0].age; break; }
      const a = s[i - 1], b = s[i];
      out.halfLifeH = b.views === a.views ? b.age : a.age + ((half - a.views) * (b.age - a.age)) / (b.views - a.views);
      break;
    }
  }
  const withRise = s.filter((x) => x.rise != null);
  if (withRise.length) out.peakRiseH = withRise.reduce((best, x) => (x.rise > best.rise ? x : best)).age;
  if (s[s.length - 1].age >= MIN_LIFE_H && s[0].age <= 12) out.shareAfter12 = 1 - viewsAt(12) / final;
  return out;
}

// ---- week window ---------------------------------------------------------------------------------
// The last COMPLETE Mon..Sun week in a timezone (defaults to the operating tz). Run on Monday it
// is last week; run any other day it is still the most recent finished week — so a late dispatch
// never mints a partial week. Returns {start, end} as YYYY-MM-DD.
export function lastCompleteWeek(now = new Date(), timeZone = 'Asia/Saigon') {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const today = new Date(`${ymd}T00:00:00Z`);
  const dow = today.getUTCDay() || 7;            // ISO: Mon=1..Sun=7
  const lastSunday = new Date(today); lastSunday.setUTCDate(today.getUTCDate() - dow); // Sunday strictly before today
  const start = new Date(lastSunday); start.setUTCDate(lastSunday.getUTCDate() - 6);
  return { start: start.toISOString().slice(0, 10), end: lastSunday.toISOString().slice(0, 10) };
}
