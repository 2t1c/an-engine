// Owner scope (2026-09-21): own standalone X posts do not enter monitoring or
// Published Content. Swipe research and publishing/scheduling are separate lanes.
// A one-row analytics response is NOT proof of a single: it may contain only the
// head tweet or a partial page. Only explicit labels or the full X draft qualify.
export function isStandalonePost(input = {}) {
  const row = input?.fields || input || {};
  if (/^(single|warmup)$/i.test(String(row.Type || '').trim())) return true;
  if ([row.draft_title, row.Post].some(title => /^\s*\[(?:single|warmup)\]/i.test(String(title || '')))) return true;
  const posts = row.platforms?.x?.posts;
  return Array.isArray(posts) && posts.length === 1;
}

// AN X ARTICLE IS NOT A SINGLE (owner, R2026-10-03: "Every account should do ≥2 articles a week").
// Its body is in platforms.x_article, not in X posts, so the one-post test above must never be what
// classifies it. Recognised from the payload (an enabled x_article with a body, as the registry
// formatOf reads it, or the article's own published URL), from a registry row's Type, or from the
// titles scripts/run-articles.mjs writes: `[Article] <Account> · <MM-DD> · <title>` once scheduled,
// `[REVIEW] <run> · A<MMDD>-<key> · <key> · article — <title>` under review.
export function isArticleDraft(input = {}) {
  const row = input?.fields || input || {};
  const article = row.platforms?.x_article;
  if (article && article.enabled !== false && (article.enabled === true || article.content_markdown)) return true;
  if (row.x_article_published_url) return true;
  if (/^article$/i.test(String(row.Type || '').trim())) return true;
  const title = String(row.draft_title || '');
  return /^\s*\[article\]/i.test(title) || /^\s*\[REVIEW\][^·]*·[^·]*·[^·]*· article(?:\s+[—·]|\s*$)/.test(title);
}

/** A registry row or draft that is a thread: neither a standalone single nor an X Article. Thread metrics
 *  (shots, winners, hit rate) count only these. */
export function isThreadRow(input = {}) {
  return !isStandalonePost(input) && !isArticleDraft(input);
}

// Scope changes must not disable the registry's short-read invariant. Remove
// only previously hashed IDs now positively identified as singles from its
// comparison baseline; all missing/unknown thread IDs remain protected.
export function monitoredPreviousCount(stored, excludedIds) {
  if (stored?.count == null) return null;
  const retired = [...excludedIds].filter(id => Object.hasOwn(stored.hashes || {}, String(id))).length;
  return Math.max(0, stored.count - retired);
}

export function hasThreadEvidence(row = {}) {
  try {
    const curve = JSON.parse((row.fields || row)['Tweet Views'] || 'null');
    return Array.isArray(curve) && curve.some(p => Number.isInteger(p?.i) && p.i > 1);
  } catch { return false; }
}

// Registry list summaries omit bodies. Positive full-body results are cached;
// unknown/empty drafts are deferred without being created, updated or alerted.
// A run-wide budget makes a cold start bounded. Previously resolved IDs need no
// requests, so later runs naturally advance through the remaining inventory.
// `isArticle` lets a caller that holds more evidence (registry-sync's ledger: isArticleRow) say so.
export async function classifyMonitoringDrafts(tf, setId, drafts, { cache = {}, knownThreads = new Set(), now = Date.now(), budget = { remaining: 100 }, isArticle = isArticleDraft } = {}) {
  const included = [], excluded = [], deferred = [];
  const keyOf = d => `${setId}:${d.id}:${d.x_published_url || ''}:${d.updated_at || ''}`;
  const ordered = [...drafts].sort((a, b) => (cache[keyOf(a)]?.at || 0) - (cache[keyOf(b)]?.at || 0));
  for (const d of ordered) {
    const id = String(d.id);
    if (isArticle(d)) { included.push(d); continue; }
    if (isStandalonePost(d)) { excluded.push(id); continue; }
    if (knownThreads.has(id)) { included.push(d); continue; }
    // No X body exists on a deliberately non-X draft. Keep its existing behavior.
    if (d.x_post_enabled === false && !d.x_published_url) { included.push(d); continue; }
    const key = keyOf(d);
    const ttl = (d.x_published_url || d.updated_at) ? 30 * 86400000 : 3600000;
    let verdict = cache[key];
    if (verdict?.retryAfter > now) { deferred.push(id); continue; }
    if (!verdict || typeof verdict.single !== 'boolean' || !Number.isFinite(verdict.at) || now - verdict.at >= ttl || now < verdict.at) {
      if (budget.remaining <= 0) { deferred.push(id); continue; }
      budget.remaining--;
      let full;
      try { full = Array.isArray(d.platforms?.x?.posts) ? d : await tf.getDraft(setId, d.id); }
      catch { /* retry below; a provider error never proves this was a single */ }
      const posts = full?.platforms?.x?.posts;
      // An article has no X posts by design: that is its shape, not an unread body.
      const article = !!full && isArticle(full);
      if (!article && (!Array.isArray(posts) || posts.length === 0)) {
        cache[key] = { at: now, retryAfter: now + 3600000 };
        deferred.push(id); continue;
      }
      verdict = cache[key] = { single: !article && isStandalonePost(full), at: now };
    }
    if (verdict.single === true) excluded.push(id);
    else included.push(d);
  }
  // This cache stores classifications only, never post bodies or credentials.
  for (const [key, v] of Object.entries(cache)) if (!v || now - v.at > 30 * 86400000) delete cache[key];
  return { included, excluded, deferred };
}

// Positively classified historic singles keep their history but gain the shared
// exclusion label, so Telegram/readers stop seeing formerly unlabelled rows.
export function standaloneRecordUpdates(records, excludedIds) {
  return records.filter(r => r.fields?.['Draft ID'] != null && String(r.fields['Draft ID']).trim() && excludedIds.has(String(r.fields['Draft ID'])) && !isStandalonePost(r) && !isArticleDraft(r))
    .map(r => ({ id: r.id, fields: { Type: 'Single' } }));
}

// Empty/untracked draft inventory is not a monitoring backlog. Only candidates
// that buildRow would retain or report need additional classification reads.
export function registryMonitoringCandidate(d, { existingIds = new Set(), ledgerIds = new Set(), laneIds = new Set(), trackAll = false } = {}) {
  const id = String(d.id);
  return existingIds.has(id) || ledgerIds.has(id) || laneIds.has(id)
    || d.status === 'scheduled' || d.status === 'published' || !!d.x_published_url
    || /\[(harvest|evergreen|inspiration|cover|article|pot(?:·[a-z0-9-]+)?)\]/i.test(d.draft_title || '')
    || (trackAll && d.status !== 'draft');
}
