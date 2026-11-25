// competitor-thread.mjs — pure helpers for the Competitor Threads rebuild (2026-09-28).
//
// The swipe file (Threads table) stores a thread as one row PER TWEET: the head carries Tweet
// Number 1 and a `Tweets` link to every row of the thread; each body row carries its own views,
// Tweet Number and Tweet Retention (views / head views). Thread Length, Thread Retention and Full
// Thread Text are rollups over that link. The Competitor Threads table has the same fields and
// the same self-link, but until now only the heads were ever written, so every competitor thread
// showed Thread Length 0 and the hook alone. This module is the parser the n8n "Get Thread"
// workflow uses, ported so the backfill and the tests share one definition.
//
// Shape-agnostic on purpose: twitter241 nests the conversation differently per tweet type, so
// every tweet object in the payload is collected and the self-thread is rebuilt by rule — same
// author, same conversation, and either the head or a reply the author made to THEMSELVES.
const unwrap = (r) => (r && r.__typename === 'TweetWithVisibilityResults') ? { ...r, ...r.tweet } : r;
export const cleanText = (s) => String(s || '').replace(/\s*https?:\/\/\S+\s*$/i, '').replaceAll('&amp;', '&').replaceAll('&gt;', '>').replaceAll('&lt;', '<');

/** The full text of a long ("note") tweet, or '' when the tweet has none. */
export const noteText = (t) => String(t?.note_tweet?.note_tweet_results?.result?.text || '');

export function collectAllTweets(o, out = [], depth = 0) {
  if (!o || typeof o !== 'object' || depth > 40) return out;
  if (Array.isArray(o)) { for (const x of o) collectAllTweets(x, out, depth + 1); return out; }
  const r = unwrap(o);
  if (r && r.rest_id && r.legacy && r.legacy.full_text !== undefined) out.push(r);
  for (const k of Object.keys(o)) collectAllTweets(o[k], out, depth + 1);
  return out;
}
const mediaOf = (t) => (((t.legacy && (t.legacy.extended_entities || t.legacy.entities)) || {}).media || []).map((x) => (x.media_url_https ? { url: x.media_url_https } : null)).filter(Boolean);
function mediaMeta(t) {
  const m = ((((t.legacy && (t.legacy.extended_entities || t.legacy.entities)) || {}).media) || [])[0];
  if (!m) return { type: '', videoUrl: '' };
  if (m.type === 'video' || m.type === 'animated_gif') {
    const mp4 = (((m.video_info || {}).variants) || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return { type: m.type === 'animated_gif' ? 'GIF' : 'Video', videoUrl: mp4 ? mp4.url : '' };
  }
  return { type: 'Photo', videoUrl: '' };
}
export function tweetRow(t, handle) {
  const u = t.core && t.core.user_results && t.core.user_results.result;
  const sn = (u && u.core && u.core.screen_name) || (u && u.legacy && u.legacy.screen_name) || handle;
  const meta = mediaMeta(t); const leg = t.legacy || {};
  return {
    // A long tweet (X Premium "note tweet") carries only its first ~275 chars in legacy.full_text;
    // the whole text sits in note_tweet. Reading full_text alone stored every long competitor tweet
    // cut mid-sentence (found 2026-11-12 on partner pages).
    rest_id: t.rest_id, screen_name: sn, text: cleanText(noteText(t) || leg.full_text),
    url: `https://x.com/${sn}/status/${t.rest_id}`,
    likes: leg.favorite_count || 0, comments: leg.reply_count || 0, retweets: leg.retweet_count || 0,
    quotes: leg.quote_count || 0, bookmarks: leg.bookmark_count || 0,
    impressions: Number((t.views && t.views.count) || 0) || 0,
    created_at: leg.created_at || null, published: leg.created_at ? new Date(leg.created_at).toISOString() : null,
    media: mediaOf(t), media_type: meta.type, video_url: meta.videoUrl,
    author_rest_id: u && u.rest_id,
  };
}
/** The self-thread behind one head id, ordered, with tweet_number and tweet_retention stamped.
 *  Returns { ok, head, thread, author } — ok false when the head is not in the payload. */
export function parseThread(payload, pid, handle) {
  const seen = new Set();
  const tweets = collectAllTweets(payload).filter((t) => !seen.has(t.rest_id) && seen.add(t.rest_id));
  const head = tweets.find((t) => t.rest_id === String(pid));
  if (!head) return { ok: false, thread: [], author: null };
  const authorId = head.core && head.core.user_results && head.core.user_results.result && head.core.user_results.result.rest_id;
  const convId = (head.legacy && head.legacy.conversation_id_str) || String(pid);
  const self = tweets
    .filter((t) => (t.core && t.core.user_results && t.core.user_results.result && t.core.user_results.result.rest_id) === authorId
      && ((t.legacy && t.legacy.conversation_id_str) || String(pid)) === convId
      && (t.rest_id === String(pid) || (t.legacy && t.legacy.in_reply_to_user_id_str) === authorId))
    .sort((a, b) => (BigInt(a.rest_id) < BigInt(b.rest_id) ? -1 : 1));
  const headViews = Number((head.views && head.views.count) || 0);
  const au = head.core.user_results.result; const al = au.legacy || {};
  const author = { Name: au.core && au.core.name, Handle: (au.core && au.core.screen_name) || al.screen_name, RestID: au.rest_id, Followers: Number(al.followers_count || 0), Following: Number(al.friends_count || 0), Posts: Number(al.statuses_count || 0) };
  const thread = self.map((t, i) => { const r = tweetRow(t, handle); r.tweet_number = i + 1; r.tweet_retention = headViews ? r.impressions / headViews : 1; return r; });
  return { ok: true, head: thread[0], thread, author };
}
/** Airtable field payload for one body tweet in Competitor Threads. Pure. */
export function bodyFields(r, { handle, restId, userRecId, source = 'n8n' }) {
  return {
    Text: r.text, TweetID: r.rest_id, 'Tweet URL': r.url, Handle: handle, 'User RestID': restId,
    ...(userRecId ? { User: [userRecId] } : {}),
    Impressions: r.impressions, Likes: r.likes, Comments: r.comments, Bookmarks: r.bookmarks, Retweets: r.retweets, Quotes: r.quotes,
    'Tweet Number': r.tweet_number, 'Tweet Retention': r.tweet_retention,
    ...(r.published ? { 'Published Date': r.published } : {}),
    ...(r.media && r.media.length ? { Media: r.media } : {}), ...(r.media_type ? { 'Media Type': r.media_type } : {}), ...(r.video_url ? { 'Video URL': r.video_url } : {}),
    Source: source,
  };
}
