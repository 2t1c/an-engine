// thread-fold.mjs — one row per thread in the swipe file and Competitor Threads (owner, 2026-10-20,
// for the Airtable Team plan's 50,000-records-per-base cap: X Swipe held 72,781 rows, 62,705 of them
// body tweets, one row per tweet).
//
// A FOLDED thread is its head row alone. Its body tweets live in the head's {Body JSON} (one entry per
// tweet: its stored fields, in Tweet Number order) and their pictures and videos in {Body Media}, each
// file named `t<n><m|v><i>__<original filename>` (m = Media, v = Video File). Thread Length, Thread
// Retention and Full Thread Text are plain fields on the head now, copied from the old rollups (renamed
// "… (live)") at fold time; swipe-fold.mjs keeps them in step for threads not yet folded.
//
// Readers need not know: lib.mjs's airtable() client expands a folded head on read. Its {Tweets} link
// comes back as [head, `<head>_t2`, `<head>_t3`, …] and getRecord on one of those VIRTUAL ids returns
// the body tweet as if it were still a row (same field names, attachments as attachment objects). So
// `for (const id of head.fields.Tweets) at.getRecord(table, id)` keeps working on both shapes.
// Virtual rows are read-only: there is no row to PATCH.
//
// Writers need not know either: the n8n Get Thread flow and competitor-bodies.mjs still write one row
// per tweet; swipe-fold.mjs folds those rows into the head once the thread's numbers have settled.

export const BODY_JSON = 'Body JSON';
export const BODY_MEDIA = 'Body Media';
// The head fields that used to be rollups over {Tweets}: plain fields now, same names.
export const STORED = ['Full Thread Text', 'Thread Length', 'Thread Retention'];
export const LIVE_SUFFIX = ' (live)';
const ATTACHMENT_FIELDS = { Media: 'm', 'Video File': 'v' };
const VIRTUAL_RE = /^(rec[A-Za-z0-9]{14})_t(\d{1,3})$/;

/** `<head>_t<n>` for body tweet n of a folded head. Pure. */
export const virtualId = (headId, n) => `${headId}_t${n}`;
/** {headId, n} when `id` is a virtual body id, else null. Pure. */
export function parseVirtualId(id) {
  const m = VIRTUAL_RE.exec(String(id || ''));
  return m ? { headId: m[1], n: Number(m[2]) } : null;
}

/** `t3v0__clip.mp4` for the first Video File of tweet 3. Pure. */
export const mediaName = (n, field, i, filename) => `t${n}${ATTACHMENT_FIELDS[field]}${i}__${filename || 'file'}`;
function parseMediaName(name) {
  const m = /^t(\d{1,3})([mv])(\d{1,2})__(.*)$/s.exec(String(name || ''));
  if (!m) return null;
  return { n: Number(m[1]), field: m[2] === 'v' ? 'Video File' : 'Media', i: Number(m[3]), filename: m[4] };
}

/**
 * PURE. A head record + its body rows (any order; the head itself may be among them) -> the fold:
 * { body: <Body JSON value>, media: [{url, filename}] for {Body Media}, tweets: count }.
 * `keep(name)` says which body fields to store (writable, not links, not attachments); every other
 * field is dropped. Body rows are ordered by Tweet Number, then by their place in the head's link.
 */
export function foldBody(head, rows, { keep = () => true } = {}) {
  const order = new Map((head.fields?.Tweets || []).map((id, i) => [id, i]));
  const bodies = rows.filter((r) => r && r.id !== head.id && Number(r.fields?.['Tweet Number']) > 1)
    .sort((a, b) => (Number(a.fields['Tweet Number']) - Number(b.fields['Tweet Number'])) || ((order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)));
  const tweets = [];
  const media = [];
  const seen = new Set();
  for (const r of bodies) {
    const n = Number(r.fields['Tweet Number']);
    if (seen.has(n)) continue; // a duplicate row for the same tweet: the first one in link order wins
    seen.add(n);
    const fields = {};
    for (const [k, v] of Object.entries(r.fields || {})) {
      if (k === 'Tweet Number' || ATTACHMENT_FIELDS[k] || !keep(k)) continue;
      fields[k] = v;
    }
    for (const field of Object.keys(ATTACHMENT_FIELDS)) {
      (r.fields[field] || []).forEach((a, i) => { if (a?.url) media.push({ url: a.url, filename: mediaName(n, field, i, a.filename) }); });
    }
    tweets.push({ n, id: r.id, createdTime: r.createdTime, fields });
  }
  return { body: JSON.stringify({ v: 1, tweets }), media, tweets: tweets.length };
}

/** PURE. The parsed {Body JSON} of a head, or null when the head is not folded (or the JSON is bad). */
export function bodyOf(fields = {}) {
  const raw = fields[BODY_JSON];
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j && Array.isArray(j.tweets) ? j : null;
  } catch { return null; }
}

/**
 * PURE. A folded head -> { head, virtuals }: `head` is the same record with {Tweets} rewritten to
 * [head, ...virtual ids] (only when the head is folded and has no live body rows linked), `virtuals`
 * the body tweets as records { id, createdTime, fields } carrying Tweet Number, the stored fields, the
 * head's User link and their attachments from {Body Media} (original filenames restored).
 * A head that is not folded comes back untouched with no virtuals.
 */
export function expandFolded(rec) {
  const body = bodyOf(rec?.fields);
  if (!body) return { head: rec, virtuals: [] };
  const links = rec.fields.Tweets || [];
  // Links to the very rows that were folded (not deleted yet) are the same tweets: serve the fold. A link
  // to any other row — one the n8n flow re-created after the fold (an "Update Thread" click) — is the
  // newer truth: read the rows, and leave the re-fold to swipe-fold.mjs's next pass.
  const foldedIds = new Set(body.tweets.map((t) => t.id));
  if (links.some((id) => id !== rec.id && !foldedIds.has(id))) return { head: rec, virtuals: [] };
  const att = new Map();
  for (const a of rec.fields[BODY_MEDIA] || []) {
    const p = parseMediaName(a?.filename);
    if (!p) continue;
    const key = `${p.n}|${p.field}`;
    if (!att.has(key)) att.set(key, []);
    att.get(key).push({ i: p.i, a: { ...a, filename: p.filename } });
  }
  const virtuals = body.tweets.map((t) => {
    const fields = { ...t.fields, 'Tweet Number': t.n };
    if (rec.fields.User && !fields.User) fields.User = rec.fields.User;
    for (const field of Object.keys(ATTACHMENT_FIELDS)) {
      const list = att.get(`${t.n}|${field}`);
      if (list) fields[field] = list.sort((x, y) => x.i - y.i).map((x) => x.a);
    }
    return { id: virtualId(rec.id, t.n), createdTime: t.createdTime || rec.createdTime, fields };
  });
  const head = { ...rec, fields: { ...rec.fields, Tweets: [rec.id, ...virtuals.map((v) => v.id)] } };
  return { head, virtuals };
}

/**
 * PURE. The `fields[]` list to request so a folded head can be expanded: when the caller asks for
 * {Tweets}, ask for the fold fields too. No list (all fields) or no {Tweets}: unchanged.
 */
export function withFoldFields(fields) {
  if (!Array.isArray(fields) || !fields.includes('Tweets')) return fields;
  return [...new Set([...fields, BODY_JSON, BODY_MEDIA])];
}
