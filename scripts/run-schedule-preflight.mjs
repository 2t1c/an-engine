// Pure, read-only schedule proposal checks for an owner-approved staged /run.
// The occupancy snapshot and provider copy are supplied by the caller; this module never
// talks to Typefully and its result is never authority to schedule a post.
import { createHash } from 'node:crypto';
import { ACCOUNTS } from '../accounts.mjs';
import { collisionReason, timeIssues } from './run-calendar.mjs';
import { bodyOverlap } from '../checks.mjs';
import { LAWS } from '../laws.mjs';
import { ADDITIVE_LANES, LANES as FARM_LANES } from '../lanes.mjs';

const MINUTE_MS = 60_000;
const SNAPSHOT_MAX_AGE_MS = 15 * MINUTE_MS;
// The farm's three plus the lanes that ride beside them: single, and article (owner, R2026-10-03:
// "Every account should do ≥2 articles a week"). An article row or booking is never an unknown lane.
const LANES = new Set([...FARM_LANES, ...ADDITIVE_LANES]);
const PLATFORMS = new Set(['x', 'threads']);
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const localDate = ms => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function parseUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::00(?:\.000)?)?Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 16) === value.slice(0, 16) ? ms : NaN;
}
function parseSaigon(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::00)?\+07:00$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16) === value.slice(0, 16) ? ms : NaN;
}
function normalizedPosts(posts) {
  if (!Array.isArray(posts) || !posts.length) return null;
  const normalized = [];
  for (const post of posts) {
    if (!post || typeof post.text !== 'string' || !post.text.trim()
      || !Array.isArray(post.mediaIds) || post.mediaIds.some(id => typeof id !== 'string' && typeof id !== 'number')) return null;
    normalized.push({ text: post.text, mediaIds: post.mediaIds.map(String) });
  }
  return normalized;
}
function normalizeCopy(copy, platforms) {
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)
    || Object.keys(copy).sort().join(',') !== platforms.slice().sort().join(',')) return null;
  const out = {};
  for (const platform of platforms) {
    const posts = normalizedPosts(copy[platform]);
    if (!posts) return null;
    out[platform] = posts;
  }
  return out;
}
// SAME-DAY DONOR (owner 2026-09-22: "avoid dedup or too many posts from similar donor in any given
// day"). Everything above is about SLOTS: one money thread per page per day, and spacing. None of it
// knew where a post came from, so the calendar could put the same donor on two pages on one day.
// That is not hypothetical: laws.json farm.$phase5 runs half the cover share as REMIXES OF THE SAME
// DONORS, and a cover and its remix landing together is exactly the repeat readers notice. The picker
// screens near-twins within each day it picks, but a lane written from an already-picked donor, a
// harvest whose body began as a cover, or a row moved at this stop never passes back through it.
//
// A donor is its origin: `source.donorId` when a row descends from one (a harvest, a pot, a remix),
// otherwise `source.id`. Near-identical is the picker's own measure, word-4-gram overlap at
// laws.json selection.donorOverlapWarn, read in both directions.
const donorKey = row => String(row.source?.donorId || row.source?.id || '').trim() || null;
function sourceIssues(row) {
  if (row.lane === 'single') return [];
  const issues = [];
  if (!donorKey(row)) issues.push('source identity is missing, so the same-day donor check cannot run');
  if (!Array.isArray(row.source?.tweets) || !row.source.tweets.length) issues.push('source body is missing, so the near-identical donor check cannot run');
  return issues;
}
function donorCollision(a, b, warn) {
  if (a.lane === 'single' || b.lane === 'single' || !Number.isFinite(a.ms) || !Number.isFinite(b.ms)) return null;
  const date = localDate(a.ms);
  if (date !== localDate(b.ms)) return null;
  if (a.donor && a.donor === b.donor) return `same donor already posts on ${date}`;
  const at = a.sourceTweets, bt = b.sourceTweets;
  if (at?.length && bt?.length) {
    const overlap = Math.max(bodyOverlap(at, bt), bodyOverlap(bt, at));
    if (overlap >= warn) return `near-identical source (${Math.round(overlap * 100)}% overlap) already posts on ${date}`;
  }
  return null;
}

/**
 * Propose exact schedule review rows. `checkDraftApproval(id)` must read run-studio's current
 * draft row and return its approved revision; throwing or returning null holds only that row.
 */
/**
 * CALENDAR MODE (R1, owner 2026-09-23). When the approved brief carried a PI_RUN_SLOTS_V1 calendar
 * (run-calendar.mjs approvedCalendar), every row is also classified against its approved slot:
 *   unchanged  the row is at its approved minute, page and platforms and holds nothing → it inherits
 *              the brief approval (run-studio inherit-row) and is written
 *   changed    the minute, page or platforms moved, or the slot is no longer clear → the owner sees
 *              "approved 12:10 → proposed 12:16 · why"; a changed timetable still needs approval
 *   blocked    the copy drifted from the approved draft → back to drafts
 * Without a calendar (a brief from before R1) nothing here changes.
 */
const COPY_DRIFT = /provider text\/media differs|draft row approval is missing|exact approved\/provider copy/;
const minuteOf = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, ':00Z') : null; };
const ict = value => { const ms = Date.parse(value || ''); return Number.isFinite(ms) ? new Date(ms + 7 * 3_600_000).toISOString().slice(11, 16) : '?'; };
export function calendarCheck(row, calendar) {
  if (!calendar) return null;
  const slot = (calendar.slots || []).find(s => s.slotId === row.id) || null;
  const approvedUtc = slot?.utc ?? null;
  if (row.holds.some(h => COPY_DRIFT.test(h))) return { verdict: 'blocked', approvedUtc, why: 'copy drifted from the approved draft; back to drafts' };
  if (!slot || slot.status !== 'open') return { verdict: 'changed', approvedUtc, why: `${row.id} is not an open slot of the approved calendar` };
  const samePlatforms = JSON.stringify([...(slot.platforms || [])].sort()) === JSON.stringify([...(row.platforms || [])].sort());
  const moved = slot.account !== row.account || minuteOf(slot.utc) !== minuteOf(row.utc) || !samePlatforms;
  const why = row.changeReason || row.holds[0] || (samePlatforms ? 'minute moved' : 'platforms changed');
  if (moved) return { verdict: 'changed', approvedUtc, why: `approved ${ict(slot.utc)} → proposed ${ict(row.utc)} ICT · ${why}` };
  if (row.holds.length) return { verdict: 'changed', approvedUtc, why: `approved ${ict(slot.utc)} ICT no longer clears · ${row.holds[0]}` };
  return { verdict: 'unchanged', approvedUtc, why: null };
}

// FINAL-COPY JEV READ (plan R1, report-only). `finalCopyLines(row)` returns the packet's
// `JEV final-copy:` lines (scripts/run-jev-final.mjs finalCopyLines). It only adds text to the
// packet: it is called after every hold is decided and never sees or changes a status or hold.
const jevFinalLines = (fn, row) => {
  if (typeof fn !== 'function') return [];
  try { return fn(row) || []; } catch (error) { return [`- JEV final-copy: not read (${String(error?.message || 'error').slice(0, 120)}) — read this copy in full before it ships`]; }
};

export function planRunSchedule(spec, { now = new Date(), checkDraftApproval = () => null, calendar = null, finalCopyLines = null } = {}) {
  if (!spec || !Array.isArray(spec.rows) || !spec.rows.length) throw new Error('rows[] is required');
  if (!Number.isInteger(spec.expectedRows) || spec.expectedRows < spec.rows.length) throw new Error('expectedRows must cover every input row');
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid current time');
  const chunkSize = spec.chunkSize ?? 8;
  const warn = LAWS.selection?.donorOverlapWarn ?? 0.2;
  const creatorCap = spec.perDayCreatorCap ?? 0;
  if (!Number.isInteger(creatorCap) || creatorCap < 0) throw new Error('perDayCreatorCap must be a whole number of 0 or more');
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 12) throw new Error('chunkSize must be 1–12');
  const ids = spec.rows.map(row => row?.id);
  if (ids.some(id => !ROW_ID.test(id || '')) || new Set(ids).size !== ids.length) throw new Error('Row IDs must be unique and run-studio compatible');

  const snapshot = spec.occupancy || {};
  const captureMs = Date.parse(snapshot.capturedAt || '');
  const occupancyProblems = [];
  if (snapshot.complete !== true) occupancyProblems.push('occupancy snapshot is incomplete');
  if (!Number.isFinite(captureMs) || captureMs > nowMs || nowMs - captureMs > SNAPSHOT_MAX_AGE_MS) {
    occupancyProblems.push('occupancy snapshot is missing, future-dated, or older than 15 minutes');
  }
  if (!Array.isArray(snapshot.coverage)) occupancyProblems.push('per-account/platform/date occupancy coverage is missing');
  if (!Array.isArray(snapshot.bookings)) occupancyProblems.push('bookings[] is missing; an empty queue must be confirmed by a complete read');
  const coverage = new Map();
  for (const item of Array.isArray(snapshot.coverage) ? snapshot.coverage : []) {
    if (!item || !validDate(item.date) || !PLATFORMS.has(item.platform) || !item.account) continue;
    const key = `${item.account}|${item.platform}|${item.date}`;
    coverage.set(key, (coverage.get(key) ?? true) && item.complete === true);
  }
  const booked = (Array.isArray(snapshot.bookings) ? snapshot.bookings : []).map((value, index) => {
    const item = value || {};
    return ({
    id: `booking-${index + 1}`, account: item.account, lane: item.lane, ms: parseUtc(item.publishAtUtc),
    draftId: item.draftId == null ? null : String(item.draftId), platforms: item.platforms,
    });
  });
  if (booked.some(item => !item.account || !LANES.has(item.lane) || !Number.isFinite(item.ms)
    || !Array.isArray(item.platforms) || !item.platforms.length || item.platforms.some(p => !PLATFORMS.has(p)))) {
    occupancyProblems.push('bookings[] contains malformed account, lane, platform, or UTC time');
  }
  const occupancyHash = sha256(JSON.stringify(snapshot));
  const assessed = spec.rows.map(row => {
    const holds = [...occupancyProblems], ms = parseUtc(row.publishAtUtc);
    const localMs = parseSaigon(row.publishAtLocal);
    const platforms = row.platforms;
    const platformList = Array.isArray(platforms) ? platforms : [];
    const account = ACCOUNTS[row.account];
    if (!account?.socialSetId || account.external || account.paused) holds.push('account is absent, external, or paused in the posting roster');
    if (!LANES.has(row.lane)) holds.push(`lane must be ${[...LANES].join(', ')}`);
    if (!Array.isArray(platforms) || !platforms.length || new Set(platforms).size !== platforms.length
      || platforms.some(p => !PLATFORMS.has(p))) holds.push('platforms must be a unique nonempty x/threads list');
    if (platforms?.includes('threads') && !account?.crossPost?.includes('threads')) holds.push('Threads is not enabled for this account in the roster');
    if (!Number.isFinite(ms) || !Number.isFinite(localMs) || ms !== localMs) holds.push('local +07:00 and UTC times are invalid or disagree');
    else {
      // The slot legality check lives in run-calendar.mjs: the brief computes the calendar with it.
      if (LANES.has(row.lane)) holds.push(...timeIssues({ lane: row.lane, ms }, nowMs));
      else if (ms - nowMs < 15 * MINUTE_MS) holds.push('slot is past or inside the 15-minute Typefully poller guard');
      for (const platform of platformList) {
        if (!coverage.get(`${row.account}|${platform}|${localDate(ms)}`)) holds.push(`occupancy coverage missing/incomplete for ${row.account}/${platform}/${localDate(ms)}`);
      }
    }
    const draft = row.draft || {};
    if (!draft.id || !/^https:\/\/typefully\.com\/t\/[A-Za-z0-9]+\/?$/.test(draft.url || '')) holds.push('Typefully draft ID or share URL is missing');
    if (!account || String(draft.socialSetId || '') !== String(account.socialSetId)) holds.push('draft social set does not match account');
    if (draft.status !== 'draft') holds.push('provider readback must be an unscheduled draft');
    if (!Array.isArray(draft.platforms) || draft.platforms.slice().sort().join(',') !== platformList.slice().sort().join(',')) {
      holds.push('draft platform flags do not match proposed platforms');
    }
    let draftRevision = null;
    try { draftRevision = checkDraftApproval(row.id); } catch { /* row-level hold below */ }
    if (!draftRevision || row.approvedDraftRevision !== draftRevision) holds.push('draft row approval is missing, stale, or does not match this revision');
    const approvedCopy = normalizeCopy(row.approvedCopy, platformList);
    const providerCopy = normalizeCopy(row.providerCopy, platformList);
    if (!approvedCopy || !providerCopy) holds.push('exact approved/provider copy or media mapping is missing');
    else if (JSON.stringify(approvedCopy) !== JSON.stringify(providerCopy)) holds.push('provider text/media differs from approved copy');
    const copyHash = approvedCopy ? sha256(JSON.stringify(approvedCopy)) : null;
    if (!Array.isArray(row.affiliateEvidence)) holds.push('affiliate evidence list is missing');
    if (row.lane !== 'single' && approvedCopy && Array.isArray(row.affiliateEvidence)) {
      for (const platform of platformList) {
        const text = approvedCopy[platform]?.map(post => post.text).join('\n') || '';
        const evidence = row.affiliateEvidence.filter(e => e?.platform === platform
          && /^https:\/\//.test(e.url || '') && e.source && Number.isFinite(Date.parse(e.checkedAt || ''))
          && Date.parse(e.checkedAt) <= nowMs && text.includes(e.url));
        if (!evidence.length) holds.push(`no checked affiliate link evidence in ${platform} copy`);
      }
      if (platforms?.includes('x') && platforms?.includes('threads') && row.lane !== 'harvest') {
        const x = row.affiliateEvidence.filter(e => e?.platform === 'x').map(e => e.url);
        const th = row.affiliateEvidence.filter(e => e?.platform === 'threads').map(e => e.url);
        if (x.some(url => th.includes(url))) holds.push('X and Threads share a tracking link; platform attribution would collapse');
      }
    }
    holds.push(...sourceIssues(row));
    return {
      id: row.id, account: row.account, lane: row.lane, local: row.publishAtLocal, utc: row.publishAtUtc,
      date: Number.isFinite(ms) ? localDate(ms) : null, ms, platforms, draft, draftRevision,
      draftId: draft.id == null ? null : String(draft.id),
      approvedCopy, providerCopy, copyHash, affiliateEvidence: row.affiliateEvidence || [], holds,
      changeReason: typeof row.changeReason === 'string' ? row.changeReason : null,
      donor: donorKey(row), creator: String(row.source?.handle || '').replace(/^@/, '').toLowerCase() || null,
      sourceTweets: Array.isArray(row.source?.tweets) ? row.source.tweets.map(String) : null,
    };
  });
  for (const a of assessed) {
    if (!Number.isFinite(a.ms)) continue;
    for (const b of booked) {
      const reason = collisionReason(a, b);
      if (reason) a.holds.push(`${reason} (${b.id}${b.draftId ? ` / draft ${b.draftId}` : ''})`);
    }
    for (const b of assessed) {
      if (b.id === a.id) continue;
      const reason = collisionReason(a, b);
      if (reason) a.holds.push(`${reason} (proposed ${b.id})`);
      const donor = donorCollision(a, b, warn);
      if (donor) a.holds.push(`${donor} (proposed ${b.id})`);
    }
  }
  // Creator concentration is the owner's per-run novelty dial (scripts/run-intake.mjs); 0 is the
  // standing rule of no cap. Every row in an over-cap group is held, because which one moves is a
  // choice for the owner, not for the order the rows happened to arrive in.
  if (creatorCap > 0) {
    const groups = new Map();
    for (const a of assessed) {
      if (a.lane === 'single' || !a.creator || !Number.isFinite(a.ms)) continue;
      const key = `${localDate(a.ms)}|${a.creator}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    for (const [key, group] of groups) {
      if (group.length <= creatorCap) continue;
      const [date, creator] = key.split('|');
      for (const a of group) a.holds.push(`${group.length} posts from @${creator} on ${date} exceed this run's cap of ${creatorCap} (${group.map(g => g.id).join(', ')})`);
    }
  }
  const rows = assessed.map(({ ms, sourceTweets, ...row }) => ({ ...row, status: row.holds.length ? 'hold' : 'proposal', calendar: calendarCheck(row, calendar) }));
  const ready = rows.filter(row => row.status === 'proposal');
  const held = rows.filter(row => row.status === 'hold');
  const batches = [];
  for (let i = 0; i < ready.length; i += chunkSize) {
    const slice = ready.slice(i, i + chunkSize);
    batches.push({
      batchId: `schedule-${sha256(JSON.stringify(slice.map(row => row.id))).slice(0, 12)}`,
      expectedRows: spec.expectedRows,
      rows: slice.map(row => ({ id: row.id, content: scheduleReviewMarkdown(row, occupancyHash, snapshot.capturedAt, jevFinalLines(finalCopyLines, row)) })),
    });
  }
  return {
    status: 'proposal-only', asOf: new Date(nowMs).toISOString(), occupancyCapturedAt: snapshot.capturedAt || null,
    occupancySha256: occupancyHash, expectedRows: spec.expectedRows,
    summary: { supplied: rows.length, proposed: ready.length, held: held.length, batches: batches.length,
      ...(calendar ? { calendar: Object.fromEntries(['unchanged', 'changed', 'blocked'].map(v => [v, rows.filter(row => row.calendar?.verdict === v).length])) } : {}) },
    rows, batches,
  };
}

function scheduleReviewMarkdown(row, occupancyHash, capturedAt, jevLines = []) {
  const lines = [
    `# ${row.id} · schedule proposal`,
    `- Account / lane: ${row.account} / ${row.lane}`,
    `- Exact time: ${row.local} Asia/Ho_Chi_Minh = ${row.utc} UTC`,
    `- Platforms: ${row.platforms.join(', ')}`,
    `- Typefully draft: ${row.draft.url} (ID ${row.draft.id}, social set ${row.draft.socialSetId}; readback status ${row.draft.status})`,
    `- Approved draft row revision: ${row.draftRevision}`,
    `- Supplied approved/provider copy + media match, SHA-256: ${row.copyHash}`,
    `- Occupancy snapshot: ${occupancyHash} (captured ${capturedAt}, complete as supplied)`,
    '- Preflight status: proposal only. Refresh live occupancy and exact provider copy immediately before the approved write.',
    ...(row.calendar ? [row.calendar.verdict === 'unchanged'
      ? '- Calendar: unchanged — the approved brief set this exact minute; it inherits that approval (run-studio inherit-row).'
      : `- Calendar: ${row.calendar.verdict.toUpperCase()} — ${row.calendar.why}. Owner decision needed.`] : []),
    ...jevLines,
  ];
  for (const platform of row.platforms) {
    lines.push(`\n## ${platform.toUpperCase()} exact copy`);
    row.providerCopy[platform].forEach((post, i) => lines.push(`${i + 1}. ${post.text}\n   Media IDs: ${post.mediaIds.join(', ') || '(none)'}`));
    const links = row.affiliateEvidence.filter(e => e.platform === platform);
    lines.push(`Affiliate evidence supplied: ${links.length ? links.map(e => `${e.url} [${e.source}; checked ${e.checkedAt}]`).join(' | ') : '(none required for single)'}`);
  }
  lines.push('', `<!-- PI_RUN_SCHEDULE_V1 ${JSON.stringify({ slotId: row.id, account: row.account, utc: minuteOf(row.utc), platforms: row.platforms, calendar: row.calendar?.verdict ?? null })} -->`);
  return lines.join('\n');
}
