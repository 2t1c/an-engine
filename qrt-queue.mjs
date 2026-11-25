#!/usr/bin/env node
// qrt-queue.mjs — a page's quote posts, at most a few a day and hours apart, spread forward.
//
// Ported from 2t1c/genius (qrt-queue.mjs at aba3896, owner 2026-10-02: "port into PI"). PI's changes: a page's rule is
// its qrt-boxes.mjs `daily` block, --account is required, and PI keeps no Genius-style runs/ of promo QRTs, so the queue
// is Typefully's scheduled drafts plus the page's cold slates.
//
//   node qrt-queue.mjs show   --account <page>           # every queued post by Saigon day, QRTs marked
//   node qrt-queue.mjs list   --account <page> [--json]  # every queued QRT: time (ET and Saigon), where from, the line
//   node qrt-queue.mjs spread --account <page> [--apply] # move the non-urgent QRTs so no day is over its cap
//
// The operator, 2026-09-29: "we're doing way too many quote retweets in a short period of time. Is there a way for us
// to spread them out? For the non-urgent ones, we should spread them out so that, in a given day, we limit the number
// of quote retweets that we do, or else it just feels like spam … reschedule the draft so the schedule will be a little
// bit more spread out, and we have content going forward."
//
// THE RULE (boxes.mjs `qrt.daily`): at most `max` QRTs a Saigon day, at least `minGapHours` apart, and every post at
// least `postGapMin` from any other post of the page, inside the page's posting windows.
//   - URGENT QRTs keep their time and count toward their day: the partner lane's ASAP quotes (a16z) and any QRT timed
//     by hand (one the lanes and runs don't know about is the operator's).
//   - Everything else only moves LATER, never earlier: first the promotion QRTs of our own articles (in time order),
//     then the cold lane's (in time order). Each keeps its time if its day has room, else takes the day with room that
//     comes first, at the valid time nearest its old clock time.
//   - A cold-lane slot that has no draft yet is only a plan: when its day has no room, it is parked (kept in the slate's
//     `parked` list, not scheduled), so the weekly pick can't overfill the calendar.
// Posts inside the next LOCK_MIN minutes are never moved.
//
// BANDS (operator 2026-09-30: "I think we can accept up to 4 QRTs/day >> Just that we should spread them a little wider
// (2 within the morning EST + 2 throughout the day where possible)", and "if we have content in between the QRTs that
// would be great, since it's higher variety on the timeline, and it makes my timeline looks more natural"). A page may
// set `tz` (its audience's clock: the day and the bands are read there) and `bands`: [{ from, to, max, anchors }]. A
// movable QRT outside every band, or in a full one, moves (later only) into a band with room. Among the valid times it
// takes, in order: one with another of the page's posts between it and its neighbouring QRTs (`interleave`), then the
// band with the fewest QRTs that day (one in the morning and one later before either doubles up), then the time nearest
// a band anchor (the anchors sit hours apart, so the day's QRTs spread wide).
//
// MAIN POST FIRST (operator 2026-09-30: "our main post should come when the audience is awake … give it a little bit of
// time for it to mature, and then our [QRTs] will come in"). `afterPostMin` keeps a QRT that long after any other post
// (GTX: 2 hours), `weekendShiftMin` moves the bands later on Saturday and Sunday (GTX: 1 hour), and a run's `immediate`
// QRT (the one that goes out right after its article) is urgent: it keeps its time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60000;
const ICT = 7 * 60 * MIN;
export const LOCK_MIN = 60;
export const DEFAULTS = Object.freeze({ max: 2, minGapHours: 3, postGapMin: 45, windows: [['14:00', '18:00'], ['19:00', '22:00']] });

export const SAIGON = 'Asia/Ho_Chi_Minh';
const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t));
/** PURE. A zone's offset from UTC at a moment, in ms (Saigon is fixed; anywhere else asks Intl, so DST is right). */
export function offsetOf(ms, tz = SAIGON) {
  if (tz === SAIGON) return ICT;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** PURE. The calendar day of a time (ms or ISO) in `tz` (Saigon by default). */
export const dayOf = (t, tz = SAIGON) => new Date(msOf(t) + offsetOf(msOf(t), tz)).toISOString().slice(0, 10);
/** PURE. Minutes past midnight in `tz`. */
export const clockOf = (t, tz = SAIGON) => { const d = new Date(msOf(t) + offsetOf(msOf(t), tz)); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
/** PURE. The moment `day` at `min` minutes past midnight in `tz`. */
export function atClock(day, min, tz = SAIGON) {
  const guess = Date.parse(`${day}T00:00:00Z`) + min * MIN;
  const first = guess - offsetOf(guess, tz);
  return guess - offsetOf(first, tz);
}
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 1440 * MIN).toISOString().slice(0, 10);

/**
 * PURE. Spread a page's QRTs.
 *   qrts:  [{ id, at, prio }]: prio 0 = urgent (never moves), 1 = our own articles' promotion, 2 = cold lane.
 *   posts: [ISO] the page's other posts (articles, long-forms, threads): never move, kept postGapMin away.
 * Returns { moves: [{ id, from, to }], stuck: [id] } (stuck: no room within `horizonDays`).
 */
export function spreadQueue(qrts, posts, { max = DEFAULTS.max, minGapHours = DEFAULTS.minGapHours, postGapMin = DEFAULTS.postGapMin, afterPostMin = null, windows = DEFAULTS.windows, tz = SAIGON, bands = null, weekendShiftMin = 0, interleave = false, now = Date.now(), horizonDays = 45 } = {}) {
  const gapQ = minGapHours * 60 * MIN, gapP = postGapMin * MIN, gapAfter = (afterPostMin ?? postGapMin) * MIN;
  const postMs = posts.map((p) => Date.parse(p)).sort((a, b) => a - b);
  const placed = []; // ms of QRTs placed so far
  const count = {}, inBand = {};
  // The day's bands: on a Saturday or Sunday (in `tz`) every band and anchor moves `weekendShiftMin` later.
  const shift = (s, m) => { const t = hm(s) + m; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const bandsOn = (day) => {
    if (!bands) return null;
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const m = dow === 0 || dow === 6 ? weekendShiftMin : 0;
    return m ? bands.map((b) => ({ ...b, from: shift(b.from, m), to: shift(b.to, m), anchors: (b.anchors || [b.from]).map((a) => shift(a, m)) })) : bands;
  };
  const bandOf = (ms) => (bands ? bandsOn(dayOf(ms, tz)).findIndex((b) => clockOf(ms, tz) >= hm(b.from) && clockOf(ms, tz) < hm(b.to)) : -1);
  const take = (ms) => {
    placed.push(ms);
    const d = dayOf(ms, tz), b = bandOf(ms);
    count[d] = (count[d] || 0) + 1;
    if (b > -1) inBand[`${d}|${b}`] = (inBand[`${d}|${b}`] || 0) + 1;
  };
  const roomy = (ms) => { if (!bands) return true; const b = bandOf(ms); return b > -1 && (inBand[`${dayOf(ms, tz)}|${b}`] || 0) < bands[b].max; };
  // A QRT keeps postGapMin before any other post, and afterPostMin after one (the post gets time to mature first).
  const clearOfPosts = (ms) => postMs.every((p) => (ms >= p ? ms - p >= gapAfter : p - ms >= gapP));
  const ok = (ms) => ms > now + LOCK_MIN * MIN && (count[dayOf(ms, tz)] || 0) < max && roomy(ms)
    && placed.every((q) => Math.abs(q - ms) >= gapQ) && clearOfPosts(ms);
  // Another post of the page sits between `ms` and the QRT placed right before it, and the one right after it.
  const between = (ms) => {
    const prev = Math.max(-Infinity, ...placed.filter((q) => q < ms)), next = Math.min(Infinity, ...placed.filter((q) => q > ms));
    const has = (a, b) => postMs.some((p) => p > a && p < b);
    return (prev === -Infinity || has(prev, ms)) && (next === Infinity || has(ms, next));
  };
  const locked = (q) => q.prio === 0 || Date.parse(q.at) <= now + LOCK_MIN * MIN;
  for (const q of qrts.filter(locked)) take(Date.parse(q.at));
  const moves = [], stuck = [];
  const rest = qrts.filter((q) => !locked(q)).sort((a, b) => a.prio - b.prio || Date.parse(a.at) - Date.parse(b.at));
  for (const q of rest) {
    const at = Date.parse(q.at);
    if (ok(at)) { take(at); continue; }
    let best = null;
    for (let d = 0; d <= horizonDays && best == null; d++) {
      const day = addDays(dayOf(at, tz), d);
      if ((count[day] || 0) >= max) continue;
      const cands = [];
      const dayBands = bandsOn(day);
      for (const [a, b] of (dayBands ? dayBands.map((x) => [x.from, x.to]) : (windows || DEFAULTS.windows))) for (let m = hm(a); m < hm(b) + (dayBands ? 0 : 1); m += 15) cands.push(atClock(day, m, tz));
      const want = clockOf(at, tz);
      const anchorGap = (ms) => { const b = dayBands[bandOf(ms)]; const c = clockOf(ms, tz); return Math.min(...(b.anchors || [b.from]).map((x) => Math.abs(hm(x) - c))); };
      const rank = bands
        ? (ms) => (interleave && !between(ms) ? 1e6 : 0) + (inBand[`${day}|${bandOf(ms)}`] || 0) * 1e3 + anchorGap(ms)
        : (ms) => Math.abs(clockOf(ms, tz) - want);
      const fits = cands.filter((ms) => ms >= at && ok(ms)).sort((x, y) => rank(x) - rank(y) || x - y);
      if (fits.length) best = fits[0];
    }
    if (best == null) { stuck.push(q.id); continue; }
    take(best);
    moves.push({ id: q.id, from: q.at, to: iso(best) });
  }
  return { moves, stuck, perDay: count };
}

// ─── IO ──────────────────────────────────────────────────────────────────────────────────────────
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v, indent = 2) => fs.writeFileSync(f, `${JSON.stringify(v, null, indent)}\n`);

/** Everything a page has queued: Typefully's scheduled drafts, the cold slates, and the runs' planned QRTs. */
async function loadQueue(key) {
  const { loadEnv, typefully } = await import('./lib.mjs');
  const { boxOf } = await import('./qrt-boxes.mjs');
  const { DIR } = await import('./cold-qrt.mjs');
  const box = boxOf(key);
  const set = box.identity.socialSetId;
  const tf = typefully(loadEnv());
  const listed = [];
  for (let off = 0; off < 1000; off += 50) {
    const r = await tf.get(`/social-sets/${set}/drafts?status=scheduled&limit=50&offset=${off}`);
    const rows = r.results || r.data || r;
    if (!rows?.length) break;
    listed.push(...rows);
    if (rows.length < 50) break;
  }
  const drafts = [];
  for (const d of listed) {
    const full = await tf.getDraft(set, d.id);
    const post = full.platforms?.x?.posts?.[0] || {};
    drafts.push({ id: d.id, at: full.scheduled_date || full.publish_at, quote: post.quote_post_url || null, text: post.text || full.platforms?.x_article?.title || '', title: full.draft_title || '' });
  }
  const dir = path.join(DIR, key);
  const slateFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^W\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => path.join(dir, f)) : [];
  const slates = slateFiles.map((file) => ({ file, slate: readJson(file) }));
  const runsDir = path.join(HERE, 'runs'); // Genius's promo QRT pieces; PI has none
  const runFiles = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(runsDir, f)) : [];
  const runs = runFiles.map((file) => ({ file, run: readJson(file) })).filter(({ run }) => (run.account || 'gtx') === key);
  return { tf, set, box, drafts, slates, runs };
}

/** PURE. The queue as QRT items and fixed posts, with where each came from. */
export function itemsOf({ drafts, slates, runs, key = 'gtx', now = Date.now() }) {
  const slotByDraft = new Map();
  for (const s of slates) for (const x of s.slate.slots || []) if (x.draft) slotByDraft.set(String(x.draft), { s, x });
  const pieceByDraft = new Map();
  for (const r of runs) for (const p of r.run.pieces || []) if (p.draft && p.format === 'QRT' && (p.account || key) === key) pieceByDraft.set(String(p.draft), { r, p });
  const qrts = [], posts = [], seen = new Set();
  for (const d of drafts) {
    if (!d.at || Date.parse(d.at) < now) continue;
    seen.add(String(d.id));
    if (!d.quote && !pieceByDraft.has(String(d.id)) && !slotByDraft.has(String(d.id))) { posts.push({ id: d.id, at: d.at, what: d.title || d.text }); continue; }
    const slot = slotByDraft.get(String(d.id));
    const piece = pieceByDraft.get(String(d.id));
    // The QRT that goes out right after its article (operator 2026-09-30) is urgent like an ASAP quote: it keeps its time.
    const prio = slot ? (slot.x.asap ? 0 : 2) : piece && piece.p.lane !== 'cold' ? (piece.p.immediate ? 0 : 1) : 0;
    qrts.push({ id: String(d.id), at: d.at, prio, scheduled: true, slot, piece, what: slot ? `cold · @${slot.x.handle}` : piece ? piece.p.key : `by hand · ${String(d.text).slice(0, 40)}` });
  }
  // A run's promotion QRTs still waiting on their article (planned, not yet scheduled in Typefully).
  for (const r of runs) for (const p of r.run.pieces || []) {
    if (p.format !== 'QRT' || (p.account || key) !== key || p.lane === 'cold' || !p.schedule?.at || seen.has(String(p.draft))) continue;
    if (p.schedule.mode !== 'planned' || Date.parse(p.schedule.at) < now || p.posted) continue;
    qrts.push({ id: String(p.draft || p.key), at: p.schedule.at, prio: p.immediate ? 0 : 1, scheduled: false, piece: { r, p }, what: p.key });
  }
  // The cold lane's plans with no draft yet.
  const plans = [];
  for (const s of slates) for (const x of s.slate.slots || []) if (!x.draft && x.at && Date.parse(x.at) > now) plans.push({ s, x });
  return { qrts, posts, plans };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
  const { keyOf } = await import('./qrt-boxes.mjs');
  const key = keyOf(arg('--account'));
  if (!['show', 'list', 'spread'].includes(cmd) || !key) { console.error('usage: node qrt-queue.mjs show|list|spread --account <page> [--apply]'); process.exit(1); }
  const q = await loadQueue(key);
  const rule = { ...DEFAULTS, ...(q.box.qrt?.daily || {}) };
  const { qrts, posts, plans } = itemsOf({ ...q, key });
  const TZ = rule.tz || SAIGON;
  const clk = (t, tz) => { const c = clockOf(t, tz); return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`; };
  const hhmm = (t) => clk(t, TZ);
  const ict = (t) => `${dayOf(t)} ${clk(t, SAIGON)}`;
  const zone = TZ === SAIGON ? 'Saigon' : TZ === 'America/New_York' ? 'ET' : TZ;
  const byDay = (list) => list.reduce((m, x) => ((m[dayOf(x.at, TZ)] ||= []).push(x), m), {});
  const print = (qs, ps) => {
    const days = [...new Set([...qs, ...ps].map((x) => dayOf(x.at, TZ)))].sort();
    const Q = byDay(qs), P = byDay(ps);
    for (const d of days) {
      const row = [...(Q[d] || []).map((x) => ({ ...x, q: true })), ...(P[d] || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const n = (Q[d] || []).length;
      console.log(`${d} · ${n} QRT${n === 1 ? '' : 's'}${n > rule.max ? `  (over ${rule.max})` : ''}: ${row.map((x) => `${hhmm(x.at)}${x.q ? (x.prio === 0 ? '!' : '*') : ''}`).join(' · ')}`);
    }
    console.log(`  (${zone} days and times) * a QRT that can move · ! an urgent QRT (keeps its time) · the rest are the page's other posts`);
  };
  if (cmd === 'show') { print(qrts, posts); process.exit(0); }
  if (cmd === 'list') {
    const et = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = [];
    for (const x of [...qrts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const d = x.scheduled || !/^\d+$/.test(x.id) ? null : await q.tf.getDraft(q.set, Number(x.id)).catch(() => null);
      const draft = q.drafts.find((y) => String(y.id) === x.id);
      const post = d?.platforms?.x?.posts?.[0];
      const text = draft?.text || post?.text || x.slot?.x.text || '';
      const template = x.slot?.x.template || x.piece?.p.template || null;
      const media = x.slot?.x.media?.kind || (x.piece?.p.meme ? 'meme' : null) || ((d && post?.media_ids?.length) ? 'media' : null);
      rows.push({ id: x.id, at: x.at, et: et(x.at), saigon: ict(x.at), status: x.scheduled ? 'scheduled' : 'planned (waits for its article)', urgent: x.prio === 0, source: x.slot ? `cold · @${x.slot.x.handle}` : x.piece ? `promo · ${x.piece.p.key}` : 'by hand', template, media, text });
    }
    const undrafted = plans.map(({ x }) => ({ at: x.at, et: et(x.at), saigon: ict(x.at), source: `cold plan · @${x.handle}`, template: x.template || null }));
    if (argv.includes('--json')) { console.log(JSON.stringify({ qrts: rows, undrafted }, null, 1)); process.exit(0); }
    for (const r of rows) console.log(`${r.et} ET · ${r.saigon} ICT · ${r.status}${r.urgent ? ' · urgent' : ''} · ${r.source}${r.template ? ` · ${r.template}` : ''}${r.media ? ` · ${r.media}` : ''} · draft ${r.id}\n    ${r.text.replace(/\n+/g, ' / ').slice(0, 140)}`);
    if (undrafted.length) { console.log('\ncold plans, no draft yet:'); for (const u of undrafted) console.log(`  ${u.et} ET · ${u.saigon} ICT · ${u.source}${u.template ? ` · ${u.template}` : ''}`); }
    process.exit(0);
  }

  const { moves, stuck, perDay } = spreadQueue(qrts, posts.map((p) => p.at), rule);
  const moved = new Map(moves.map((m) => [m.id, m.to]));
  console.log(`rule: at most ${rule.max} QRTs a ${zone} day${rule.bands ? ` (${rule.bands.map((b) => `${b.max} in ${b.from}–${b.to}`).join(', ')}${rule.weekendShiftMin ? `, ${rule.weekendShiftMin} min later at weekends` : ''})` : ''}, ${rule.minGapHours}h apart, ${rule.postGapMin} min before and ${rule.afterPostMin ?? rule.postGapMin} min after any other post${rule.interleave ? ', another post between two QRTs where possible' : ''}\n`);
  for (const m of moves) { const x = qrts.find((y) => y.id === m.id); console.log(`  ${x.what.padEnd(46).slice(0, 46)} ${dayOf(m.from, TZ)} ${hhmm(m.from)} → ${dayOf(m.to, TZ)} ${hhmm(m.to)} ${zone} (${ict(m.to)} ICT)${x.scheduled ? '' : ' (planned)'}`); }
  if (stuck.length) console.log(`  no room within the horizon: ${stuck.join(', ')}`);
  // The cold plans with no draft: keep them where their day has room (at a valid time), park the rest.
  const planMoves = [], parked = [];
  const after = qrts.map((x) => ({ ...x, at: moved.get(x.id) || x.at }));
  const count = { ...perDay };
  for (const p of plans.sort((a, b) => Date.parse(a.x.at) - Date.parse(b.x.at))) {
    const r = spreadQueue([...after.map((x) => ({ id: x.id, at: x.at, prio: 0 })), { id: 'plan', at: p.x.at, prio: 2 }], posts.map((y) => y.at), { ...rule, horizonDays: 0 });
    const m = r.moves.find((y) => y.id === 'plan');
    if (r.stuck.includes('plan')) { parked.push(p); continue; }
    const at = m ? m.to : p.x.at;
    after.push({ id: `plan:${p.x.tid}:${p.x.at}`, at, prio: 2 });
    count[dayOf(at, TZ)] = (count[dayOf(at, TZ)] || 0) + 1;
    if (m) planMoves.push({ p, to: at });
  }
  console.log(`\ncold plans without a draft: ${plans.length - parked.length} kept (${planMoves.length} retimed), ${parked.length} parked (no room that day)`);
  console.log('\nafter:');
  print(after.map((x) => ({ ...x, prio: x.prio })), posts);
  if (!argv.includes('--apply')) { console.log('\n(dry run: --apply moves them)'); process.exit(0); }

  const { saigonOf, pieceKeyOf } = await import('./cold-qrt.mjs');
  const touchedSlates = new Set(), touchedRuns = new Set(), notion = [];
  for (const m of moves) {
    const x = qrts.find((y) => y.id === m.id);
    if (x.scheduled) await q.tf.patchDraft(q.set, Number(x.id), { publish_at: m.to });
    if (x.slot) {
      const s = x.slot.x;
      if (!s.key) s.key = pieceKeyOf(s); // the batch key stays with the slot when it moves
      s.at = m.to; s.saigon = saigonOf(m.to); if (s.scheduled) s.scheduled = m.to;
      touchedSlates.add(x.slot.s);
    }
    // The run piece of a moved QRT (a promotion piece, or a cold slot's piece in its batch).
    for (const r of q.runs) for (const p of r.run.pieces || []) {
      const same = (x.piece && p === x.piece.p) || (x.slot && p.lane === 'cold' && p.key === x.slot.x.key);
      if (!same) continue;
      p.schedule = { ...(p.schedule || {}), at: m.to };
      touchedRuns.add(r);
      if (p.notionPage) notion.push({ page: p.notionPage, key: p.key, at: m.to });
    }
  }
  for (const { p, to } of planMoves) { p.x.at = to; p.x.saigon = saigonOf(to); touchedSlates.add(p.s); }
  for (const p of parked) {
    p.s.slate.parked = [...(p.s.slate.parked || []), { ...p.x, parkedAt: new Date().toISOString(), why: `no room on ${dayOf(p.x.at, TZ)} (at most ${rule.max} QRTs a day)` }];
    p.s.slate.slots = p.s.slate.slots.filter((y) => y !== p.x);
    touchedSlates.add(p.s);
  }
  for (const s of touchedSlates) writeJson(s.file, s.slate);
  for (const r of touchedRuns) writeJson(r.file, r.run, 1);
  console.log(`\napplied: ${moves.filter((m) => qrts.find((y) => y.id === m.id).scheduled).length} Typefully drafts rescheduled, ${touchedSlates.size} slate(s) and ${touchedRuns.size} run(s) updated`);
  if (notion.length) console.log(`notion: ${JSON.stringify(notion)}`);
}
