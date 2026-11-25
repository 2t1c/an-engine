#!/usr/bin/env node
// The run card: one live page per collaborative /run, rebuilt from the run's own ledger after every
// step and republished to the same link until the run finishes.
//
// Owner, 2026-09-22: "each run should have its own card (artifact) so we can keep track of the
// progress. The card is ever updating until finish /run." Styling follows the Five Stops explainer
// the owner already reads, so the card and the explainer look like one thing.
//
// Everything on the card is derived: stop states and counts from run-studio `status`, page/day/lane
// from each row's own review packet, Typefully links from the review-drafts ledger, the plan from the
// resolved intake. Nothing here approves, writes to a provider or schedules. The file is written
// OUTSIDE the repository because the card names unpublished hooks.
//
//   node scripts/run-card.mjs --run-dir DIR --out /outside/run-card-R2026-09-25.html
//        [--run-id R2026-09-25] [--intake DIR/intake.json] [--now "Writing batch 3"] [--finished] [--sample]
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rowMarker, status as runStatus } from './run-studio.mjs';
import { readingsFor } from './run-jev.mjs';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const fail = (message) => { throw new Error(message); };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The owner's names for the stops, as the explainer uses them. */
export const STOP_NAMES = {
  brief: 'The plan', selection: 'The posts we copy', products: 'What we sell',
  hooks: 'The first lines', drafts: 'The threads', schedule: 'The calendar',
};
const SHORT_NAMES = { selection: 'Posts', products: 'Products', hooks: 'Hooks', drafts: 'Threads', schedule: 'Calendar' };
const STATE_LABEL = { done: 'Done', you: 'Waiting on you', me: 'I’m on it', later: 'Not yet', fix: 'Needs a fix' };
const ROW_MARK = {
  approved: ['done', '✓', 'approved'], 'awaiting approval': ['you', '●', 'waiting on you'],
  held: ['held', '✕', 'held by you'], stale: ['fix', '!', 'needs a fix'],
};

/** A stop's card state from its run-studio status. Rows move on their own, so a row stop can be
 *  waiting on the owner (a finished batch) and still in progress (the next batch being written). */
export function stopState(stop) {
  if (stop.mode !== 'rows' || !stop.counts) {
    return { approved: 'done', 'awaiting approval': 'you', 'ready to prepare': 'me', 'ready for approved rows': 'me', stale: 'fix' }[stop.status] || 'later';
  }
  if (stop.counts.stale) return 'fix';
  if (stop.counts['awaiting approval']) return 'you';
  if (stop.status === 'approved') return 'done';
  if (stop.status === 'blocked') return 'later';
  return 'me';   // more batches to write, or held rows to revise or drop
}

function safeLink(url) {
  return /^https:\/\/[^\s"'<>]+$/.test(String(url || '')) ? String(url) : null;
}

/** Page/day/lane from the row's own packet: every packet names them on one line near its top. */
function rowFacts(text) {
  const line = text.match(/^- Account\/date(?:\/lane)?: (.+)$/m)?.[1];
  if (!line) return {};
  const [account, date, lane] = line.split(' · ').map((part) => part.trim());
  return { account, date, lane: lane || (/^# Cover source/m.test(text) ? 'cover' : undefined) };
}

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** The run's found list: one `- ` line per problem the run noticed but should not fix. Capped, so a
 *  runaway list cannot bury the stops; the overflow is counted rather than dropped silently. */
export const FOUND_CAP = 30;
function readFound(file) {
  let body = '';
  try { body = existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { body = ''; }
  const items = body.split('\n').map((line) => line.match(/^\s*[-*]\s+(.*\S)\s*$/)?.[1]).filter(Boolean);
  return { items: items.slice(0, FOUND_CAP), more: Math.max(0, items.length - FOUND_CAP) };
}

// ---- card triage (plan Track A3) --------------------------------------------------------------------
// Source: RUN_DIR/jev/drafts.json, written by scripts/run-jev.mjs --stage drafts (schema run-jev-v1): one
// reading per row with its copy digest, the drafts flags and the editorial pre-score (shadow). A reading
// counts only for the copy the owner is shown: its digest must equal the PI_RUN_DRAFT_V1 marker in the
// row's current drafts packet. Every word of a hint is written here; tweet numbers come from the reading,
// and quoted copy is cut off, never shown.

/** The exact copy digest the row's current drafts packet records (run-content-packets.mjs). */
const packetDigest = (body) => String(rowMarker(body, 'PI_RUN_DRAFT_V1')?.copySha256 || '') || null;

/** null when the run has no readings file (the card is then unchanged); a broken file reads as not read. */
function readDraftReadings(dir) {
  if (!existsSync(join(dir, 'jev', 'drafts.json'))) return null;
  try {
    const rows = readingsFor(dir, 'drafts');
    if (rows.has(undefined)) throw new Error('a reading without an id');
    return { rows, error: null };
  } catch { return { rows: new Map(), error: 'the Jev readings file could not be read' }; }
}

const tweetRef = (value) => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').match(/^T(\d+)$/)?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? `T${n}` : null;
};
const CLAIM_HINT = { statistic: 'stat needs a named source', study: 'study needs a named source', quote: 'quote to verify verbatim',
  first_person: 'first-person claim to check against the persona', health_outcome: 'health-outcome claim (compliance read)' };

/** A safety class's name ("sexual behaviour", "banned topic"): plain words only, so no copy slips through. */
function safetyLabel(value) {
  const s = String(value ?? '').replace(/_/g, ' ').trim();
  return /^[a-z][a-z ]{0,40}$/i.test(s) ? s : 'safety';
}

/** A pre-score note's own words without its number or the tweet it quotes ("T5: repeats an earlier tweet"). */
function noteLabel(note, tweet) {
  let s = String(note || '');
  const quoted = s.indexOf(' "');
  if (quoted >= 0) s = s.slice(0, quoted);
  s = s.replace(/(?:, uncertain)?\s*\(\d[^)]*\)\s*$/, '').replace(/\s*\([QG]\d[^)]*\)\s*$/, '');
  if (tweet && s.startsWith(`${tweet}: `)) s = s.slice(tweet.length + 2);
  return s.trim().slice(0, 90) || 'see the packet';
}

/** Each thing Jev pointed at, weighted so the heaviest is the one line the owner sees. */
function triagePoints(reading) {
  const points = [];
  const add = (weight, tweet, label, hold = false) => points.push({ weight, tweet: tweetRef(tweet), label, hold });
  if (reading.status === 'read') {
    for (const f of Array.isArray(reading.flags) ? reading.flags : []) {
      const t = tweetRef(f?.tweet);
      if (f?.kind === 'safety') {
        const excluded = /excludes it/.test(String(f.note));
        add(excluded ? 95 : 90, null, `${safetyLabel(f.key)}${excluded ? ' (this run excludes it: swap)' : ''}`);
      }
      else if (f?.kind === 'owner-rule') add(90, null, 'may break one of your intake rules');
      else if (f?.kind === 'plug') add(80, t, 'plug may not lead to its linked product');
      else if (f?.kind === 'claim') add(60, t, 'unsourced claim');
      else if (f?.kind === 'promise') add(45, null, 'the promise may only be paid off in the sale');
      else if (f?.kind === 'seam') add(40, t, t ? `weakest seam after T${Number(t.slice(1)) - 1}` : 'weakest seam');
      else if (f?.kind === 'partial') add(10, null, 'thread is longer than Jev reads');
      else add(40, t, 'see the packet');
    }
  }
  const p = reading.prescore;
  if (p?.status === 'read') {
    for (const x of Array.isArray(p.pointers) ? p.pointers : []) {
      const t = tweetRef(x?.tweet);
      if (x?.kind === 'safety') add(x.level === 'hold' ? 100 : x.level === 'review' ? 70 : 30, null, safetyLabel(String(x.note || '').split(/ \(|:| "/)[0]), x.level === 'hold');
      else add(x?.level === 'hold' ? 100 : x?.level === 'review' ? 50 : 30, t, noteLabel(x?.note, t), x?.level === 'hold');
    }
    for (const c of Array.isArray(p.claims) ? p.claims : []) {
      add(20, c?.tweet, `${CLAIM_HINT[c?.kind] || 'claim to check'}${/a source is recorded/.test(String(c?.note)) ? ' (a source is recorded)' : ''}`);
    }
    if (p.action === 'hold' && !points.some((x) => x.hold)) add(100, null, 'the pre-score would hold it', true);
  }
  return points;
}

/**
 * Pure. One row's place in the queue and its one hint line. `copySha256` is the digest in the row's
 * current drafts packet. Groups: hold (the pre-score would hold it), check (something flagged),
 * not read (no reading, a stale one, or a partial read with nothing flagged), likely fine (both reads
 * complete for this exact copy and nothing flagged; a pre-score switched off in laws.json is not a
 * failed read). `score` is the pre-score as one number, lower is weaker: hold 0, review_needed 0–0.5
 * (more sure it is weak = lower), pass 0.5–1 (less sure = lower). `weight` is the heaviest finding's.
 */
export function triageRow(reading, copySha256, { fileError = null } = {}) {
  const unread = (why) => ({ group: 'not read', score: null, weight: 0, findings: 0, hint: `not read: ${why}; read it in full` });
  if (fileError) return unread(fileError);
  if (!reading) return unread('Jev has no reading for this row');
  if (!copySha256) return unread('this packet carries no copy digest to match');
  if (reading.copySha256 !== copySha256) return unread('the copy changed since Jev read it');
  const p = reading.prescore;
  const gaps = [...(reading.status === 'read' ? [] : ['Jev’s drafts read failed']), ...(p?.status === 'read' || p?.status === 'off' ? [] : ['pre-score not read'])];
  const conf = Number.isFinite(p?.confidence) ? Math.min(1, Math.max(0, p.confidence)) : null;
  const score = p?.status !== 'read' ? null : p.action === 'hold' ? 0
    : p.action === 'review_needed' ? 0.5 * (1 - (conf ?? 0)) : p.action === 'pass' ? 0.5 + 0.5 * (conf ?? 0) : null;
  const points = triagePoints(reading).sort((a, b) => b.weight - a.weight);
  if (!points.length) return gaps.length ? unread(gaps.join(' and ')) : { group: 'likely fine', score, weight: 0, findings: 0, hint: 'nothing flagged' };
  const [top] = points;
  const hold = p?.status === 'read' && p.action === 'hold';
  const tail = [points.length > 1 ? `+${points.length - 1} more` : '', ...gaps].filter(Boolean);
  return { group: hold ? 'hold' : 'check', score, weight: top.weight, findings: points.length,
    hint: `check${hold ? ' first (pre-score hold)' : ''}${top.tweet ? ` ${top.tweet}` : ''}: ${top.label}${tail.length ? ` · ${tail.join(' · ')}` : ''}` };
}

const TIER = { hold: 0, check: 1, 'not read': 2, 'likely fine': 3 };
const URGENT = 80;   // a safety, owner-rule or plug finding: it leads the checks whatever the pre-score says

/** Holds, then checks (urgent findings first, then lower pre-score), then not read, then likely fine.
 *  Ties keep the batch's own order. */
export function sortTriage(rows) {
  const s = (r) => r.triage.score ?? Infinity;
  const urgent = (r) => (r.triage.weight >= URGENT ? 0 : 1);
  return [...rows].sort((a, b) => TIER[a.triage.group] - TIER[b.triage.group] || urgent(a) - urgent(b)
    || s(a) - s(b) || b.triage.findings - a.triage.findings);
}

/** Everything the card shows, derived from the run directory. `now` is injectable for tests. */
export function cardModel({ runDir, runId = null, intake = undefined, nowText = '', finished = false, sample = false, now = new Date() }) {
  const dir = resolve(runDir);
  const stops = runStatus(dir);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const drafts = readJson(join(dir, 'review-drafts.json')) || {};
  const plan = intake === undefined ? readJson(join(dir, 'intake.json')) : intake;
  const rows = new Map();
  const row = (id) => rows.get(id) || rows.set(id, { id, stages: {} }).get(id);
  const draftDigests = new Map();
  for (const stop of stops) {
    if (stop.mode !== 'rows' || !stop.rows) continue;
    const group = state.rowStages?.[stop.stage];
    for (const item of stop.rows) {
      const entry = row(item.id);
      entry.stages[stop.stage] = { status: item.status, reason: item.reason };
      const snapshot = group?.rows?.[item.id];
      if (snapshot?.hold?.message) entry.holdMessage = snapshot.hold.message;
      let body = null;
      try { body = readFileSync(join(dir, 'reviews', snapshot.snapshot), 'utf8'); } catch { /* the ledger reports it */ }
      if (body == null) continue;
      Object.assign(entry, Object.fromEntries(Object.entries(rowFacts(body)).filter(([, v]) => v)));
      if (stop.stage === 'drafts') draftDigests.set(item.id, packetDigest(body));
    }
  }
  for (const [id, entry] of Object.entries(drafts)) {
    const target = row(id);
    for (const key of ['account', 'date', 'lane']) if (entry?.[key] && !target[key]) target[key] = String(entry[key]);
    target.link = safeLink(entry?.url || entry?.shareUrl);
    const hook = String(entry?.title || '').split(' — ').slice(1).join(' — ').trim();
    if (hook) target.hook = hook;
  }
  const expected = Math.max(0, ...stops.map((stop) => stop.expectedRows || 0)) || null;
  const numbered = stops.map((stop, index) => ({
    key: stop.stage, number: index + 1, name: STOP_NAMES[stop.stage] || stop.stage, status: stop.status,
    state: stopState(stop), mode: stop.mode === 'rows' && stop.counts ? 'rows' : 'whole',
    counts: stop.counts ? { approved: stop.counts.approved, waiting: stop.counts['awaiting approval'], held: stop.counts.held, stale: stop.counts.stale,
      submitted: stop.submittedRows, expected: stop.expectedRows } : null,
    expected: stop.expectedRows || (index > 0 ? expected : null),
    batches: (stop.batches || []).map((batch, i) => ({ number: i + 1, id: batch.id, rows: batch.rows.map((r) => ({ id: r.id, status: r.status })) })),
  }));
  // A stop with no rows yet is only "on it" once the stop before it has all its rows in and none
  // waiting; otherwise the calendar would claim to be in progress while threads are still written.
  for (const [index, stop] of numbered.entries()) {
    if (index === 0 || stop.counts || stop.state !== 'me') continue;
    const before = numbered[index - 1];
    const settled = before.state === 'done' || (before.counts && before.counts.submitted >= before.counts.expected && !before.counts.waiting && !before.counts.stale);
    if (!settled) stop.state = 'later';
  }
  const allDone = numbered.every((stop) => stop.state === 'done');
  // The headline follows the owner's attention: a stop waiting on them, then one needing a fix, then
  // the furthest stop with work under way. Rows move independently, so "earliest unfinished" would
  // point at a stop that only has a held row while the next one has a batch to review.
  const current = numbered.find((stop) => stop.state === 'you') || numbered.find((stop) => stop.state === 'fix')
    || numbered.filter((stop) => stop.state === 'me' && (stop.counts || stop.mode === 'whole')).at(-1)
    || numbered.find((stop) => stop.state !== 'done') || null;
  const waiting = [];
  for (const stop of numbered) {
    if (stop.mode === 'whole' && stop.state === 'you') waiting.push({ stop, batch: null, rows: [] });
    for (const batch of stop.batches) {
      const pending = batch.rows.filter((r) => r.status === 'awaiting approval').map((r) => rows.get(r.id));
      if (pending.length) waiting.push({ stop, batch, rows: pending });
    }
  }
  // Card triage (plan Track A3): Jev's drafts readings reorder the rows INSIDE each waiting drafts
  // batch and add one hint line per row. Display only: statuses, batches and approvals are untouched,
  // and with no readings file the card is exactly what it was.
  const readings = readDraftReadings(dir);
  if (readings) {
    for (const ask of waiting) {
      if (ask.stop.key !== 'drafts' || !ask.batch) continue;
      ask.triage = true;
      ask.rows = sortTriage(ask.rows.map((r) => ({ ...r, triage: triageRow(readings.rows.get(r.id), draftDigests.get(r.id), { fileError: readings.error }) })));
    }
  }
  const byDay = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.account || '').localeCompare(String(b.account || '')) || a.id.localeCompare(b.id);
  return {
    runId: runId || basename(dir), flow: state.flow || stops.map((s) => s.stage), stops: numbered, current, allDone, finished, sample,
    nowText: String(nowText || '').trim(), updatedAt: now.toISOString(), plan, waiting,
    found: readFound(join(dir, 'found.md')),
    rows: [...rows.values()].sort(byDay),
    held: [...rows.values()].filter((r) => Object.values(r.stages).some((s) => s.status === 'held')).sort(byDay),
    stale: [...rows.values()].filter((r) => Object.values(r.stages).some((s) => s.status === 'stale')).sort(byDay),
  };
}

// ---- rendering ------------------------------------------------------------------------------------
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const day = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? DAY.format(new Date(`${iso}T00:00:00Z`)) : (iso || '—');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function planFacts(plan) {
  if (!plan) return [];
  const dates = Array.isArray(plan.dates) ? plan.dates : [];
  const defaults = new Set(plan.defaultsUsed || []);
  const mine = (id) => defaults.has(id) ? '<span class="src">default</span>' : '<span class="src you">your choice</span>';
  const tests = plan.experiment?.productPriority || [];
  const dials = plan.experiment?.seedDials || [];
  return [
    ['Days', `${esc(dates.length ? `${day(dates[0])} – ${day(dates.at(-1))}` : '—')} · ${plural(dates.length, 'day')}`, mine('dates')],
    ['Pages', `${plural(plan.accounts?.count ?? 0, 'page')}${plan.accounts?.excluded?.length ? ` · not ${esc(plan.accounts.excluded.join(', '))}` : ''}`, mine('accounts')],
    ['Split', `${esc((plan.mix || []).join(' / '))} <span class="dim">covers / harvests / seeds</span>`, mine('split')],
    ['OG room', esc(plan.coverSelection?.age?.preset || '—'), mine('ogRoom')],
    ['Donor freshness', esc(plan.coverSelection?.novelty?.preset || '—'), mine('novelty')],
    ['Experiment', `${plural(plan.experiment?.productTests ?? tests.length, 'product test')}${tests.length ? ` <span class="dim mono">${esc(tests.join(' · '))}</span>` : ''}${dials.length ? ` · ${plural(dials.length, 'seed dial')}` : ''}`, mine('experiment')],
  ];
}

function bar(stop) {
  const c = stop.counts, total = stop.expected;
  if (!c && stop.number > 1 && total) return '<div class="bar" role="img" aria-label="not started"><span class="seg rest" style="flex:1"></span></div>';
  if (!c || !total) return '';
  const seg = (n, cls) => n ? `<span class="seg ${cls}" style="flex:${n}"></span>` : '';
  const rest = Math.max(0, total - c.approved - c.waiting - c.held - c.stale);
  return `<div class="bar" role="img" aria-label="${esc(`${c.approved} approved, ${c.waiting} waiting on you, ${c.held} held, ${c.stale} need a fix, ${rest} not written yet, of ${total}`)}">${seg(c.approved, 'done')}${seg(c.waiting, 'you')}${seg(c.held, 'held')}${seg(c.stale, 'fix')}${seg(rest, 'rest')}</div>`;
}

function stopCounts(stop) {
  const c = stop.counts;
  if (!c) return stop.mode === 'whole' ? '' : `<p class="counts">${stop.expected ? `0 of ${stop.expected}` : '&nbsp;'}</p>`;
  const bits = [`<b>${c.approved}</b> of ${c.expected} approved`];
  if (c.waiting) bits.push(`${c.waiting} waiting`);
  if (c.held) bits.push(`${c.held} held`);
  if (c.stale) bits.push(`${c.stale} to fix`);
  if (c.submitted < c.expected) bits.push(`${c.expected - c.submitted} to write`);
  return `<p class="counts">${bits.join(' · ')}</p>`;
}

function rowLine(r) {
  const facts = [r.account, day(r.date), r.lane].filter((x) => x && x !== '—').map(esc).join(' · ');
  const link = r.link ? `<a class="open" href="${esc(r.link)}" target="_blank" rel="noopener">Open draft ↗</a>` : '';
  const hint = r.triage && r.triage.group !== 'likely fine' ? `<span class="hint ${r.triage.group === 'not read' ? 'unread' : r.triage.group}">${esc(r.triage.hint)}</span>` : '';
  return `<li><span class="rid">${esc(r.id)}</span><span class="rfacts">${facts || '<span class="dim">details in the packet</span>'}${r.hook ? `<span class="hook">${esc(r.hook)}</span>` : ''}${hint}</span>${link}</li>`;
}

/** A triaged drafts batch: flagged and unread rows first, then the likely-fine group, every row still listed. */
function triagedRows(rows) {
  const first = rows.filter((r) => r.triage.group !== 'likely fine');
  const fine = rows.filter((r) => r.triage.group === 'likely fine');
  return `<p class="ask-n">Sorted by Jev’s read. Say “approve clean” to approve the likely-fine rows at once (a random audit sample stays for you); read the rest in full.</p>
      ${first.length ? `<ul class="rows">${first.map(rowLine).join('')}</ul>` : ''}${fine.length ? `
      <p class="ask-n fine">Likely fine · ${plural(fine.length, 'row')} with nothing flagged</p>
      <ul class="rows">${fine.map(rowLine).join('')}</ul>` : ''}`;
}
const TRIAGE_CSS = `
  .hint{display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere;}
  .hint.hold{color:var(--held);} .hint.check{color:var(--you);} .hint.unread{color:var(--muted);font-style:italic;}
  .ask-n.fine{margin-top:12px;}`;

export function renderCard(model) {
  const { stops, current } = model;
  const headline = model.finished ? { cls: 'done', label: 'Finished', text: 'This run is closed' }
    : model.allDone ? { cls: 'done', label: 'All stops approved', text: 'Scheduling runs next, then the receipt' }
      : { cls: current.state, label: STATE_LABEL[current.state], text: `Stop ${current.number} of ${stops.length} · ${current.name}` };
  const threadsStop = stops.find((s) => s.key === 'drafts');
  const waiting = model.waiting.length ? model.waiting.map(({ stop, batch, rows, triage }) => stop.mode === 'whole' && !batch
    ? `<div class="ask"><p class="ask-h"><b>${esc(stop.name)}</b> · ready for your yes</p><p class="ask-n">It is in the chat. Say yes, or tell me what to change.</p></div>`
    : `<div class="ask"><p class="ask-h"><b>${esc(stop.name)}</b> · batch ${batch.number} · ${plural(rows.length, 'row')} to review</p>
      ${stop.key === 'drafts' || stop.key === 'hooks' ? '<p class="ask-n">Each one is its own unscheduled draft in Typefully, on the page’s own account.</p>' : '<p class="ask-n">The packet is in the chat.</p>'}
      ${triage ? triagedRows(rows) : `<ul class="rows">${rows.map(rowLine).join('')}</ul>`}</div>`).join('')
    : `<p class="quiet">${model.finished || model.allDone ? 'Nothing. Every stop has your yes.' : 'Nothing right now. The next batch shows up here as soon as it passes the checks.'}</p>`;
  const flowNames = stops.map((s) => s.key);
  const rowStages = flowNames.slice(1);
  const table = model.rows.length ? `<div class="table"><table>
      <thead><tr><th>Row</th><th>Page</th><th>Day</th><th>Lane</th>${rowStages.map((k) => `<th class="c">${esc(SHORT_NAMES[k] || k)}</th>`).join('')}<th>Draft</th></tr></thead>
      <tbody>${model.rows.map((r) => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.account || '—')}</td><td class="nw">${esc(day(r.date))}</td><td>${esc(r.lane || '—')}</td>${rowStages.map((k) => {
        const s = r.stages[k]; const [cls, glyph, label] = ROW_MARK[s?.status] || ['none', '·', 'not yet'];
        return `<td class="c"><span class="mark ${cls}" title="${esc(label)}" aria-label="${esc(label)}">${glyph}</span></td>`;
      }).join('')}<td>${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">open ↗</a>` : '<span class="dim">—</span>'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="legend"><span class="mark done">✓</span> approved <span class="mark you">●</span> waiting on you <span class="mark held">✕</span> held by you <span class="mark fix">!</span> needs a fix <span class="mark none">·</span> not yet</p>`
    : '<p class="quiet">Rows appear once the posts are picked at stop 2.</p>';
  const plan = planFacts(model.plan);
  return `<title>${model.sample ? 'Run card sample' : `Run ${esc(model.runId)}`}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Work+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap">
<style>
  :root{
    --ground:#EDF0EA; --surface:#FFFFFF; --surface-2:#F6F8F3; --ink:#16231C; --muted:#5E6F66; --line:#D3DBD1;
    --stem:#2F6B45; --stem-soft:#DCE9DF; --you:#9A6212; --you-soft:#F6E9D2; --held:#A6402E; --held-soft:#F5E0DA;
    --on-stem:#FFFFFF;
    --display:'Fraunces',Georgia,'Times New Roman',serif;
    --body:'Work Sans','Helvetica Neue',Arial,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      color-scheme:dark;
      --ground:#101512; --surface:#181F1A; --surface-2:#141A16; --ink:#E8EFE8; --muted:#9DB0A4; --line:#2A342D;
      --stem:#6FBF8B; --stem-soft:#1D2C22; --you:#E2A64A; --you-soft:#2C2416; --held:#E58B73; --held-soft:#2E1C18; --on-stem:#0E1410;
    }
  }
  :root[data-theme="dark"]{
    color-scheme:dark;
    --ground:#101512; --surface:#181F1A; --surface-2:#141A16; --ink:#E8EFE8; --muted:#9DB0A4; --line:#2A342D;
    --stem:#6FBF8B; --stem-soft:#1D2C22; --you:#E2A64A; --you-soft:#2C2416; --held:#E58B73; --held-soft:#2E1C18; --on-stem:#0E1410;
  }
  body{background:var(--ground);color:var(--ink);font-family:var(--body);line-height:1.5;}
  .wrap{max-width:900px;margin:0 auto;padding-inline:20px;padding-block:36px 56px;}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 10px;}
  h1{font-family:var(--display);font-weight:600;font-size:clamp(30px,6vw,46px);line-height:1.05;letter-spacing:-.02em;margin:0 0 14px;}
  h2{font-family:var(--display);font-weight:600;font-size:clamp(20px,3.2vw,25px);letter-spacing:-.01em;margin:0 0 12px;text-wrap:balance;}
  .section{margin-top:40px;}
  .sample{background:var(--you-soft);color:var(--ink);border-radius:10px;padding:11px 15px;margin:0 0 22px;font-size:14px;}
  .where{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:0 0 8px;font-size:clamp(17px,2.6vw,20px);font-weight:500;}
  .meta,.now{margin:0;color:var(--muted);}
  .now{margin-top:6px;color:var(--ink);}
  .now b{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:500;margin-right:6px;}
  .chip{display:inline-block;border-radius:999px;padding:3px 11px;font-size:13px;font-weight:600;white-space:nowrap;}
  .chip.done{background:var(--stem-soft);color:var(--stem);}
  .chip.you{background:var(--you-soft);color:var(--you);}
  .chip.me{background:var(--surface);color:var(--stem);box-shadow:inset 0 0 0 1.5px var(--stem);}
  .chip.later{background:var(--surface-2);color:var(--muted);}
  .chip.fix{background:var(--held-soft);color:var(--held);}
  .ask{background:var(--you-soft);border-radius:12px;padding:14px 16px;}
  .ask + .ask{margin-top:10px;}
  .ask-h{margin:0;}
  .ask-n{margin:2px 0 0;color:var(--muted);font-size:14px;}
  .rows{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px;}
  .rows li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;background:var(--surface);border-radius:8px;padding:9px 12px;}
  .rid{font-family:var(--mono);font-size:12.5px;color:var(--muted);flex:0 0 auto;}
  .rfacts{flex:1 1 220px;min-width:0;}
  .hook{display:block;color:var(--muted);font-size:14px;overflow-wrap:anywhere;}
  .open,.table a{color:var(--stem);font-weight:600;text-decoration:none;white-space:nowrap;}
  .open:hover,.table a:hover,.open:focus-visible,.table a:focus-visible{text-decoration:underline;}
  a:focus-visible{outline:2px solid var(--stem);outline-offset:2px;border-radius:3px;}
  .quiet{margin:0;color:var(--muted);background:var(--surface-2);border-radius:10px;padding:12px 15px;}
  .track{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;}
  .stop{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
  .stop[data-state="you"]{border-color:var(--you);}
  .stop[data-state="fix"]{border-color:var(--held);}
  .stop-top{display:flex;align-items:center;gap:10px;}
  .dot{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-family:var(--mono);font-size:13px;background:var(--surface-2);color:var(--muted);box-shadow:inset 0 0 0 1.5px var(--line);}
  .stop[data-state="done"] .dot{background:var(--stem);color:var(--on-stem);box-shadow:none;}
  .stop[data-state="you"] .dot{background:var(--you);color:var(--on-stem);box-shadow:none;}
  .stop[data-state="me"] .dot{color:var(--stem);box-shadow:inset 0 0 0 1.5px var(--stem);}
  .stop[data-state="fix"] .dot{background:var(--held);color:var(--on-stem);box-shadow:none;}
  .stop h3{font-family:var(--display);font-weight:600;font-size:17px;line-height:1.2;margin:0;}
  .stop .chip{align-self:flex-start;}
  .counts{margin:0;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;}
  .counts b{color:var(--ink);}
  .bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--surface-2);gap:2px;}
  .seg.done{background:var(--stem);} .seg.you{background:var(--you);} .seg.held,.seg.fix{background:var(--held);} .seg.rest{background:var(--line);}
  .table{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;}
  .table table{border-collapse:collapse;width:100%;font-size:14px;}
  .table th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:500;padding:11px 10px 8px;border-bottom:1px solid var(--line);white-space:nowrap;}
  .table td{padding:8px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;}
  .table tr:last-child td{border-bottom:0;}
  .c{text-align:center;} .nw{white-space:nowrap;} .mono{font-family:var(--mono);font-size:12.5px;}
  .mark{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:700;line-height:1;}
  .mark.done{background:var(--stem-soft);color:var(--stem);} .mark.you{background:var(--you-soft);color:var(--you);}
  .mark.held,.mark.fix{background:var(--held-soft);color:var(--held);} .mark.none{color:var(--muted);}
  .legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:10px 0 0;font-size:13px;color:var(--muted);}
  .legend .mark{margin-left:6px;}
  .plan{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:4px 18px;}
  .plan div{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--line);}
  .plan div:last-child{border-bottom:0;}
  .plan dt{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);flex:0 0 140px;}
  .plan dd{margin:0;flex:1 1 200px;}
  .src{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-left:8px;}
  .src.you{color:var(--you);}
  .dim{color:var(--muted);}
  .list{list-style:none;margin:0;padding:0;display:grid;gap:6px;}
  .list li{background:var(--surface-2);border-left:3px solid var(--held);border-radius:0 8px 8px 0;padding:9px 13px;}
  .list.found li{border-left-color:var(--muted);overflow-wrap:anywhere;}
  .lead{margin:0 0 10px;color:var(--muted);font-size:14px;}
  .list + .lead{margin:10px 0 0;}
  footer{margin-top:36px;color:var(--muted);font-size:13px;}
  @media (max-width:620px){ .track{grid-template-columns:1fr;} }
  @media (max-width:520px){ .plan dt{flex-basis:100%;} }${model.waiting.some((ask) => ask.triage) ? TRIAGE_CSS : ''}
</style>

<div class="wrap">
  ${model.sample ? '<p class="sample"><b>Example data.</b> This is what a run card looks like. A real one is made when a /run starts and updates itself until the run is done.</p>' : ''}
  <p class="eyebrow">Run card</p>
  <h1>Run ${esc(model.runId)}</h1>
  <p class="where"><span class="chip ${headline.cls}">${esc(headline.label)}</span>${esc(headline.text)}</p>
  <p class="meta">Updated <time datetime="${esc(model.updatedAt)}">${esc(model.updatedAt.slice(0, 16).replace('T', ' '))} UTC</time>${threadsStop?.counts ? ` · ${threadsStop.counts.approved} of ${threadsStop.counts.expected} threads approved` : ''}</p>
  ${model.nowText ? `<p class="now"><b>Right now</b>${esc(model.nowText)}</p>` : ''}

  <section class="section">
    <h2>Waiting on you</h2>
    ${waiting}
  </section>

  <section class="section">
    <h2>The ${stops.length === 5 ? 'five' : stops.length === 6 ? 'six' : esc(stops.length)} stops</h2>
    <ol class="track">${stops.map((stop) => `<li class="stop" data-state="${stop.state}">
      <div class="stop-top"><span class="dot">${stop.state === 'done' ? '✓' : stop.number}</span><h3>${esc(stop.name)}</h3></div>
      <span class="chip ${stop.state}">${esc(STATE_LABEL[stop.state])}</span>
      ${bar(stop)}${stopCounts(stop)}
    </li>`).join('')}</ol>
  </section>
  ${model.held.length || model.stale.length ? `<section class="section">
    <h2>Being fixed</h2>
    <ul class="list">${model.held.map((r) => `<li><b class="mono">${esc(r.id)}</b> held by you${r.holdMessage ? `: “${esc(r.holdMessage)}”` : ''} — I revise it or drop it.</li>`).join('')}${model.stale.map((r) => `<li><b class="mono">${esc(r.id)}</b> needs a fix: ${esc(Object.values(r.stages).find((s) => s.status === 'stale')?.reason || 'an earlier stop changed')}</li>`).join('')}</ul>
  </section>` : ''}

  <section class="section">
    <h2>Every row</h2>
    ${table}
  </section>
  ${model.found.items.length ? `<section class="section">
    <h2>Found along the way</h2>
    <p class="lead">Things I noticed that this run should not fix. They close the final message too.</p>
    <ul class="list found">${model.found.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    ${model.found.more ? `<p class="lead">…and ${model.found.more} more in found.md</p>` : ''}
  </section>` : ''}
  ${plan.length ? `<section class="section">
    <h2>The plan you set</h2>
    <dl class="plan">${plan.map(([k, v, src]) => `<div><dt>${esc(k)}</dt><dd>${v}${src}</dd></div>`).join('')}</dl>
  </section>` : ''}

  <footer>Rebuilt from this run’s own ledger after every step${model.finished ? '; this is the final version' : ''}. A yes is recorded in your words. This card posts nothing.</footer>
</div>
<script>
  document.querySelectorAll('time[datetime]').forEach(function (t) {
    try { t.textContent = new Date(t.dateTime).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) {}
  });
</script>
`;
}

function outsideRepo(target) {
  let anchor = resolve(target); const tail = [];
  while (!existsSync(anchor)) { const parent = dirname(anchor); if (parent === anchor) break; tail.unshift(basename(anchor)); anchor = parent; }
  const actual = resolve(realpathSync(anchor), ...tail);
  if (actual === ROOT || actual.startsWith(ROOT + sep)) fail('The run card names unpublished hooks; write it outside the repository');
  return resolve(target);
}

/** Build the card and write it atomically, so a publish never picks up half a file. */
export function writeCard({ runDir, out, ...options }) {
  const file = outsideRepo(out);
  const html = renderCard(cardModel({ runDir, ...options }));
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, html, { flag: 'wx', mode: 0o600 });
  renameSync(temp, file);
  return file;
}

function main(argv) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const runDir = flag('run-dir'), out = flag('out');
  if (!runDir || !out) fail('Usage: run-card.mjs --run-dir DIR --out /outside/card.html [--run-id ID] [--intake FILE] [--now TEXT] [--finished] [--sample]');
  const intakeFile = flag('intake');
  const file = writeCard({ runDir, out, runId: flag('run-id'), nowText: flag('now') || '',
    intake: intakeFile ? JSON.parse(readFileSync(resolve(intakeFile), 'utf8')) : undefined,
    finished: argv.includes('--finished'), sample: argv.includes('--sample') });
  return { card: file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
