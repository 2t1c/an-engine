#!/usr/bin/env node
// scripts/run-row.mjs — one command per /run stage, so a run is a few commands instead of hand glue.
//
// Owner, 2026-09-23, after the first Jev run: "It seems like it still takes a little bit more time than
// what I'm expecting." About a fifth of that run was glue written by hand in the session: a drafts
// builder, ship specs, provenance merges, readbacks. Each stage here chains the repo's own CLIs in their
// documented order (their gates and refusals are unchanged) and prints one table the owner can read.
//
//   node scripts/run-row.mjs drafts   --run-dir RUN --input SPEC.json [--rows a,b] [--dry]
//     Jev reads the rows (run-jev --stage drafts, the editorial DECISION since the owner rule), the drafts
//     packet is built (run-content-packets), every submit-ready batch is submitted (run-studio), and each
//     submitted row gets its [REVIEW] draft in Typefully (run-review-drafts), then the media pass
//     (run-media: a pool clip and the original's media on each hook, clips and swipe media on the body; Jev
//     decides) so the owner reviews each thread with its media. --no-media skips it; --hook-only, --clips and
//     --max-cuts pass through. --dry stops before submit.
//
//   node scripts/run-row.mjs schedule-packet --run-dir RUN --input SPEC.json [--rows a,b] [--at id=ISO,...] [--reason "owner words"]
//     The schedule stop's packet, for rows whose drafts are approved: links minted (the same publish specs
//     the schedule stage reuses), the [REVIEW] drafts re-pushed with the linked copy (their media kept),
//     an occupancy snapshot, the packet rows built from the live drafts (approved copy = linked copy + the
//     review draft's media), run-jev-final, plan-run-schedule, and every batch submitted with the
//     approve-batch command printed. --reason is required when --at moves a row off the brief's calendar.
//     Built after R2026-11-01, where this stop was hand glue three days running.
//
//   node scripts/run-row.mjs schedule --run-dir RUN --input SPEC.json [--rows a,b] [--at id=ISO,...] [--no-geni] [--dry]
//     Geniuslink is the default: after readback every lvnta plug (X + Threads) becomes a geni.us link with
//     the US-only rule (geni-swap.mjs); --no-geni keeps plain Levanta links.
//     For rows whose drafts are approved: a publish spec per row (lineage, the [REVIEW] draft to adopt,
//     the brief-approved slot time), links minted (batch-mint), the thread scheduled (publish-thread
//     --at; adoption keeps the review draft's media), and every draft read back from Typefully, media
//     included: exactly what the approved review draft carried. --dry mints and publishes nothing.
//   Every stage ends with the Notion tracker push (scripts/notion-sync.mjs push); a failed push is reported.
//
// SPEC is the drafts spec run-content-packets reads ({ rows: [{ id, account, date, lane, source, draft }] }).
// Everything written lands in RUN_DIR (outside the repo): specs quote unpublished copy.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneOf } from '../lanes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = (v) => String(v ?? '').trim();

// ---- pure -----------------------------------------------------------------------------------------

/** The pot's greenhouse body for a seed row: the file whose potRecId is the row's source id. */
export function greenhouseFor(row, greenhouses = []) {
  return greenhouses.find((g) => text(g?.potRecId) && text(g.potRecId) === text(row?.source?.id)) || null;
}

/**
 * PURE. One drafts-spec row -> the publish-thread spec. Lineage follows the lane: a harvest carries
 * harvestOf, a seed pot carries potOf (from its greenhouse), and every row names the [REVIEW] draft to
 * adopt when there is one (one thread, one draft). Throws, naming the row, when a lineage is missing.
 */
/**
 * PURE (given gateThread). The craft findings Jev settled for this row at the drafts stop, as keys the
 * door (publish-thread splitJevSettled) matches: the same canonical gate on the same draft copy, split
 * by the same rule as the packet (run-content-packets settleCraftGates). Null when nothing was settled.
 */
export function jevSettledFor(row, { reading, laws, gateThread, settleCraftGates, craftKey, digest }) {
  const tweets = row.draft?.tweets || [];
  if (!reading || tweets.length < 3) return null;
  const gate = gateThread({ account: row.account, tweets, products: row.draft?.products || [], ctaDepth: row.draft?.ctaDepth,
    allowUnsold: row.draft?.allowUnsold, shape: row.draft?.shape, firstPlugAt: row.draft?.firstPlugAt });
  if (!gate || gate.ok || gate.fatal) return null;
  const { raw } = settleCraftGates(gate.issues || [], reading, digest(tweets), { id: row.id, laws });
  return raw.length ? { by: 'editorial-prescore', keys: raw.map(craftKey) } : null;
}

// ONE PRODUCT, TWO PLUGS (the 21kg harvest body, R2026-09-27: T4 heavy and T16 light plug the same product).
// batch-mint puts each product's minted link on exactly one tweet, and each plug earns its own tracked link,
// so a link token that recurs in a later tweet becomes the next free token, with its product listed again.
// {{LINK}} is product 1, {{LINK2}} product 2 (gate-thread.mjs). Only the tokens move; no word changes.
const LINK_AT = (i) => (i === 0 ? '{{LINK}}' : `{{LINK${i + 1}}}`);
/** PURE. { tweets, products, split: [{ tweet, from, to }] }: every link token on one tweet only. */
export function splitRepeatedLinks(tweets = [], products = []) {
  const out = tweets.map(String), list = [...products], split = [];
  for (let i = 0; i < products.length; i++) {
    const token = LINK_AT(i);
    const at = out.map((t, n) => (t.includes(token) ? n : -1)).filter((n) => n >= 0);
    for (const n of at.slice(1)) {
      const to = LINK_AT(list.length);
      out[n] = out[n].split(token).join(to);
      list.push({ ...products[i] });
      split.push({ tweet: n + 1, from: token, to });
    }
  }
  return { tweets: out, products: list, split };
}

/** PURE. The row with the copy that ships: tweets and products from its minted publish spec (batch-mint
 *  fills every link token in place), so the schedule packet and the review draft carry the real links. */
export function linkedRow(row, minted) {
  const tweets = Array.isArray(minted?.tweets) ? minted.tweets.map(String) : null;
  if (!tweets || tweets.some((t) => /\{\{LINK\d*\}\}/.test(t))) throw new Error(`${row.id}: its publish spec still carries link tokens — mint first`);
  return { ...row, draft: { ...row.draft, tweets, products: minted.products || row.draft.products } };
}

/** PURE. One schedule-packet row (plan-run-schedule's input) from the linked row and its live [REVIEW]
 *  draft. The approved copy is the linked copy with the media the review draft carries: the owner approved
 *  the thread WITH its media at the drafts stop, so a hook clip is part of what was approved (R2026-11-01
 *  day 3: approved copy without media read as "copy drifted" against a draft carrying the hook video). */
export function schedulePacketRow(row, { draft, reviewDraft, at, revision, reason = null, now }) {
  const posts = (draft?.platforms?.x?.posts || []).map((p) => ({ text: String(p.text ?? ''), mediaIds: (p.media_ids || []).map(String) }));
  const enabled = Object.entries(draft?.platforms || {}).filter(([, v]) => v?.enabled).map(([k]) => k);
  const local = new Date(Date.parse(at) + 7 * 3600e3).toISOString().slice(0, 16) + ':00+07:00';
  return {
    id: row.id, account: row.account, lane: row.lane || 'cover', publishAtUtc: at, publishAtLocal: local, platforms: ['x'],
    ...(reason ? { changeReason: reason } : {}),
    draft: { id: String(reviewDraft.draftId), url: reviewDraft.shareUrl || reviewDraft.url || null, socialSetId: reviewDraft.socialSetId,
      status: draft?.status === 'draft' ? 'draft' : String(draft?.status), platforms: enabled.filter((p) => p === 'x') },
    enabledPlatforms: enabled,
    approvedDraftRevision: revision,
    approvedCopy: { x: row.draft.tweets.map((text, i) => ({ text, mediaIds: posts[i]?.mediaIds || [] })) },
    providerCopy: { x: posts },
    affiliateEvidence: (row.draft.products || []).filter((p) => p.link).map((p) => ({ platform: 'x', url: p.link, source: `levanta mint ledger (${p.subid1 || p.asin})`, checkedAt: now })),
    source: row.source,
  };
}

export function shipSpecFor(row, { batch, reviewDrafts = {}, greenhouses = [], jevSettled = null } = {}) {
  const lane = laneOf(row.lane);
  const tweets = row.draft?.tweets;
  if (!Array.isArray(tweets) || tweets.length < 3) throw new Error(`${row.id}: no complete thread to ship`);
  // What the thread was written and gated as rides to the door, which gates it again from the spec:
  // the ask window (firstPlugAt, shape, allowUnsold), the one-CTA arm, the site line dropped on a
  // one-CTA cover, and the style pilot's build for the readout. The draft's own value wins; the row's
  // is the selection's.
  const carried = Object.fromEntries(['arm', 'styleArm', 'noSiteCta', 'firstPlugAt', 'shape', 'allowUnsold']
    .map((k) => [k, row.draft?.[k] ?? row[k]]).filter(([, v]) => v != null && v !== false && !(Array.isArray(v) && !v.length)));
  const links = splitRepeatedLinks(tweets, (row.draft?.products || []).map((p) => ({ asin: p.asin, title: p.title })));
  const spec = {
    day: row.date, key: row.account, account: row.account, recId: text(row.source?.id), batch,
    ctaDepth: row.draft?.ctaDepth, cta: 'fresh', note: `${batch} ${row.id} (${lane})`,
    products: links.products, tweets: links.tweets, ...carried,
    ...(Array.isArray(row.draft?.sources) && row.draft.sources.length ? { sources: row.draft.sources } : {}),
    ...(reviewDrafts[row.id]?.draftId ? { reviewDraftId: String(reviewDrafts[row.id].draftId) } : {}),
  };
  if (lane === 'harvest') {
    if (!text(row.source?.harvestOf)) throw new Error(`${row.id}: harvest without harvestOf`);
    Object.assign(spec, { harvestOf: text(row.source.harvestOf), contentLane: 'harvest' });
  } else if (lane === 'seed') {
    const g = greenhouseFor(row, greenhouses);
    if (!g?.potOf) throw new Error(`${row.id}: no greenhouse body with potRecId ${text(row.source?.id) || '(none)'}`);
    Object.assign(spec, { potOf: g.potOf, contentLane: 'seed', ...(g.seedRecId ? { seedRecId: g.seedRecId } : {}), ...(g.seedVersion != null ? { seedVersion: g.seedVersion } : {}) });
  }
  if (row.operatorEdit?.message) spec.operatorEdit = row.operatorEdit;
  // The hook drift the drafts packet accepted rides to the door, which re-runs the same hook gate.
  if (row.hook?.hookDrift?.class) spec.hookDrift = row.hook.hookDrift;
  if (jevSettled?.keys?.length) spec.jevSettled = jevSettled;
  return spec;
}

/** PURE. "a=2026-09-27T05:10:00Z,b=..." -> { a: iso, b: iso }. Throws on a malformed pair. */
export function parseAt(value) {
  const out = {};
  for (const pair of text(value).split(',').filter(Boolean)) {
    const [id, at] = pair.split('=');
    if (!id || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00(?:\.000)?Z$/.test(text(at))) throw new Error(`--at needs id=YYYY-MM-DDTHH:MM:00Z pairs; got "${pair}"`);
    out[id.trim()] = text(at);
  }
  return out;
}

/** PURE. Each row's publish time: an explicit --at wins, else the brief-approved slot. A row with
 *  neither is named, never guessed. `slots` is approvedCalendar(runDir).bySlot (or any Map id -> {utc}). */
export function scheduleTimes(rows, { slots = new Map(), at = {} } = {}) {
  const times = {}, missing = [];
  for (const row of rows) {
    const t = at[row.id] || slots.get?.(row.id)?.utc || null;
    if (t) times[row.id] = t; else missing.push(row.id);
  }
  return { times, missing };
}

/**
 * PURE over `checkRow` and `slotWriteGuard`. The ledger's word on every row about to be minted and
 * scheduled: its drafts row is approved (the final revision the owner saw) and its minute is the approved
 * schedule row's, same page (scripts/run-calendar.mjs slotWriteGuard, the SLOT_NOT_APPROVED guard
 * ship-day runs). One hold per row that fails, with the ledger's reason; [] means every row may ship.
 * This is the guard that lets the live stage run without a permission prompt (write-gate.mjs `ledger`):
 * an `--at` that differs from the approved minute, or a row the owner never approved, is a hold here.
 */
export function ledgerHolds(rows, times, runDir, { checkRow, slotWriteGuard }) {
  const holds = [];
  for (const row of rows) {
    try { checkRow(runDir, 'drafts', row.id); } catch (error) { holds.push({ id: row.id, reason: `drafts row: ${error.message}` }); continue; }
    const [slot] = slotWriteGuard([{ account: row.account, slotId: row.slotId || row.id, at: times[row.id] ?? null }], runDir);
    if (!slot.ok) holds.push({ id: row.id, reason: `SLOT_NOT_APPROVED: ${slot.reason}` });
  }
  return holds;
}

/**
 * PURE. What is wrong with a scheduled draft as Typefully returns it: not scheduled, scheduled for another
 * minute, a post count that differs from the spec, a link token never minted, or media that differs from
 * the approved [REVIEW] draft's (`expectMedia`: media count per X post, read just before adoption; the
 * /run media pass put it there and the owner approved it). Without `expectMedia` (no review draft), any
 * media is an issue while ATTACH_MEDIA is off. [] means the readback matches.
 */
export function readbackIssues(draft, { at, tweets = [], attachMedia = false, expectMedia = null } = {}) {
  const issues = [];
  const minute = (v) => Math.floor(Date.parse(v) / 60000);
  const landed = draft?.scheduled_date || draft?.publish_at || null;
  if (!landed) issues.push(`not scheduled (status ${draft?.status ?? 'unknown'})`);
  else if (at && minute(landed) !== minute(at)) issues.push(`scheduled ${landed}, not ${at}`);
  const posts = draft?.platforms?.x?.posts || [];
  if (posts.length !== tweets.length) issues.push(`${posts.length} X posts, spec has ${tweets.length}`);
  const tokens = posts.filter((p) => /\{\{LINK\}\}|\[LINK\]/.test(String(p?.text || ''))).length;
  if (tokens) issues.push(`${tokens} post(s) still carry an unminted link token`);
  if (Array.isArray(expectMedia)) {
    const off = posts.map((p, i) => [i + 1, p?.media_ids?.length || 0, expectMedia[i] || 0]).filter(([, got, want]) => got !== want);
    if (off.length) issues.push(`media differs from the approved review draft: ${off.map(([n, got, want]) => `tweet ${n} has ${got}, approved ${want}`).join(', ')}`);
  } else {
    const media = posts.reduce((n, p) => n + (p?.media_ids?.length || 0), 0);
    if (media && !attachMedia) issues.push(`${media} media item(s) attached while ATTACH_MEDIA is off`);
  }
  return issues;
}

/**
 * PURE. The tweets where the media pass left the owner a choice (run-media: the hook's pool clip beside
 * the original's media) that is still open: that tweet still carries more than one item. X cannot publish
 * two videos, or a video with images, on one post, so the row holds until the owner keeps one.
 */
export function mediaChoicesOpen(entry, liveCounts = []) {
  return (entry?.tweets || []).filter((t) => String(t.source || '').includes('+') && (liveCounts[t.tweet - 1] || 0) > 1).map((t) => t.tweet);
}

/** PURE. One line per row from a run-content-packets plan: id, status and the first reason. */
export function planLines(plan) {
  return (plan?.rows || []).map((r) => {
    const why = (r.holds?.[0] || r.reviews?.[0] || '').replace(/\s+/g, ' ').slice(0, 110);
    return `  ${String(r.id).padEnd(16)} ${String(r.status).padEnd(22)} ${why}`;
  });
}

// ---- CLI ------------------------------------------------------------------------------------------

function run(args, { json = false, allowFail = false } = {}) {
  const child = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${child.stdout || ''}`;
  if (child.status !== 0 && !allowFail) throw new Error(`${args.slice(0, 2).join(' ')} failed (${child.status}): ${(child.stderr || out).split('\n').filter((l) => !/^\[roster\]/.test(l)).slice(-4).join(' | ')}`);
  if (!json) return { out, status: child.status, err: child.stderr || '' };
  const at = out.indexOf('{');
  return { data: at < 0 ? null : JSON.parse(out.slice(at)), out, status: child.status };
}

function nextDir(runDir, name) {
  const base = join(runDir, 'row-runs');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const n = readdirSync(base).filter((f) => f.startsWith(`${name}-`)).length + 1;
  const dir = join(base, `${name}-${String(n).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function subsetSpec(input, rowsFlag, dir, name) {
  const spec = JSON.parse(readFileSync(input, 'utf8'));
  const want = rowsFlag ? new Set(rowsFlag.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  if (want) spec.rows = spec.rows.filter((r) => want.has(r.id));
  const file = join(dir, `${name}-spec.json`);
  writeFileSync(file, JSON.stringify(spec, null, 1), { mode: 0o600 });
  return { spec, file };
}

async function draftsStage({ runDir, input, rows, dry, media }) {
  const dir = nextDir(runDir, 'drafts');
  // The lead item first, every lane (scripts/run-lead-item.mjs; owner, 2026-09-28: "yes adopt fully —
  // every numbered first tweet should have it implemented."). It writes back to the run's own spec, so the
  // Jev read, the packet, the review drafts and the schedule stage all see the copy that ships; a --dry run
  // leads only its own copy of the rows.
  const leadOn = (target, extra = []) => {
    const r = run(['scripts/run-lead-item.mjs', '--input', target, ...extra], { allowFail: true });
    const lines = `${r.out}`.split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l));
    console.log(r.status ? `  ✗ lead item not checked: ${(r.err || '').split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l)).at(-1) || r.status}` : lines.join('\n'));
  };
  if (!dry) leadOn(input, ['--backup', join(dir, 'before-lead-spec.json'), ...(rows ? ['--rows', rows] : [])]);
  const { spec: subset, file } = subsetSpec(input, rows, dir, 'drafts');
  if (dry) leadOn(file);
  const spec = dry ? JSON.parse(readFileSync(file, 'utf8')) : subset;
  console.log(`drafts · ${spec.rows.length} row(s) · ${dir}`);
  const jev = run(['scripts/run-jev.mjs', '--stage', 'drafts', '--run-dir', runDir, '--input', file], { allowFail: true });
  console.log(jev.out.split('\n').find((l) => /^drafts: /.test(l)) || '  Jev: no summary line (see run-jev output)');
  const plan = join(dir, 'plan.json'), packets = join(dir, 'packets');
  run(['scripts/run-content-packets.mjs', '--stage', 'drafts', '--run-dir', runDir, '--input', file, '--output', plan, '--review-dir', packets]);
  const planned = JSON.parse(readFileSync(plan, 'utf8'));
  console.log(planLines(planned).join('\n'));
  if ((planned.rows || []).some((r) => r.status !== 'submit-ready')) {
    // The bounded repair loop: briefs for the tweets that decided each row (scripts/run-repair.mjs).
    const repair = run(['scripts/run-repair.mjs', 'plan', '--run-dir', runDir, '--input', file, '--plan', plan], { allowFail: true });
    console.log(`${repair.out}${repair.err}`.split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l)).join('\n'));
  }
  if (dry) { console.log('  --dry: nothing submitted, no [REVIEW] drafts written'); return; }
  const submitted = [];
  for (const packet of planned.reviewPackets || []) {
    const r = run(['scripts/run-studio.mjs', 'submit-batch', runDir, 'drafts', packet], { json: true });
    for (const row of r.data?.rows || []) submitted.push(row.id);
    console.log(`  submitted ${r.data?.batchId} · revision ${String(r.data?.revision || '').slice(0, 12)} · ${(r.data?.rows || []).map((x) => x.id).join(' ')}`);
  }
  if (!submitted.length) { console.log('  nothing was submit-ready: resolve the holds above'); return; }
  const push = join(dir, 'push-spec.json');
  writeFileSync(push, JSON.stringify({ ...spec, rows: spec.rows.filter((r) => submitted.includes(r.id)) }, null, 1), { mode: 0o600 });
  const synced = run(['scripts/run-review-drafts.mjs', '--stage', 'drafts', '--run-dir', runDir, '--run-id', spec.runId || runIdOf(runDir), '--input', push]);
  console.log(synced.out.split('\n').filter((l) => /^(created|updated|note-updated|unchanged|owner-edited|refused|skip)/.test(l)).map((l) => `  ${l}`).join('\n'));
  if (media === false) { console.log('  --no-media: no media pass (run scripts/run-media.mjs before the owner reviews)'); notionPush(runDir, push); return; }
  // The media pass (scripts/run-media.mjs): Jev puts a pool clip and the original's media on each hook,
  // then clips and swipe media on the body, so the owner reviews each thread with its media.
  const m = run(['scripts/run-media.mjs', '--run-dir', runDir, '--input', push, '--rows', submitted.join(','), ...(media?.clips ? ['--clips', media.clips] : []), ...(media?.maxCuts ? ['--max-cuts', media.maxCuts] : []), ...(media?.hookOnly ? ['--hook-only'] : [])], { allowFail: true });
  console.log(`${m.out}${m.status ? `\n  ✗ media pass failed: ${m.err.split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l)).at(-1) || m.status}` : ''}`.split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l)).join('\n'));
  notionPush(runDir, push);
}

/** The publish spec per row (shipSpecFor) in DIR/ship, with the craft findings Jev settled at the drafts
 *  stop riding along (v7 N3). Shared by the schedule-packet and schedule stages, so both mint the same specs. */
async function writeShipSpecs({ runDir, spec, dir, batch, reviewDrafts }) {
  const potsDir = join(ROOT, 'queues', 'pots');
  const greenhouses = existsSync(potsDir) ? readdirSync(potsDir).filter((f) => f.endsWith('.greenhouse.json')).map((f) => JSON.parse(readFileSync(join(potsDir, f), 'utf8'))) : [];
  const ship = join(dir, 'ship');
  mkdirSync(ship, { recursive: true, mode: 0o700 });
  const { readingsFor: jevReadingsFor } = await import('./run-jev.mjs');
  const { gateThread } = await import('../gate-thread.mjs');
  const { settleCraftGates, draftCopyDigest } = await import('./run-content-packets.mjs');
  const { craftKey } = await import('../craft-gates.mjs');
  const { LAWS } = await import('../laws.mjs');
  let readings = new Map();
  try { readings = jevReadingsFor(runDir, 'drafts'); } catch { /* no drafts reading: nothing settled */ }
  for (const row of spec.rows) {
    const jevSettled = jevSettledFor(row, { reading: readings.get(row.id), laws: LAWS, gateThread, settleCraftGates, craftKey, digest: draftCopyDigest });
    if (jevSettled) console.log(`  ${row.id}: Jev settled ${jevSettled.keys.length} craft finding(s)`);
    writeFileSync(join(ship, `${row.id}.json`), JSON.stringify(shipSpecFor(row, { batch, reviewDrafts, greenhouses, jevSettled }), null, 1), { mode: 0o600 });
  }
  return ship;
}

const runIdOf = (runDir) => text(JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).runId) || resolve(runDir).split('/').pop();

/** The Notion tracker push (scripts/notion-sync.mjs): every stage ends with it, because a run driven
 *  stage by stage skipped it (R2026-11-01: 15 threads scheduled, none on the tracker until the owner
 *  asked). A failed push is reported, never fatal: Notion is the owner's view, not a source of truth. */
function notionPush(runDir, input, { refreshHooks = false } = {}) {
  const r = run(['scripts/notion-sync.mjs', 'push', '--run-dir', runDir, '--run-id', runIdOf(runDir), '--input', input, ...(refreshHooks ? ['--refresh-hooks'] : [])], { allowFail: true });
  const lines = `${r.out}`.split('\n').filter((l) => /: (created|updated|unchanged)/.test(l));
  const mode = `${r.out}`.match(/"mode": "([^"]+)"/)?.[1];
  console.log(r.status ? `  ✗ Notion not pushed: ${(r.err || r.out).split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l)).at(-1) || r.status}`
    : `  Notion: ${mode || 'pushed'} · ${lines.length} thread row(s)${mode === 'payload' ? ' (no token: push RUN_DIR/notion/payload.json through the connector)' : ''}`);
}

async function schedulePacketStage({ runDir, input, rows, atFlag, reason }) {
  const dir = nextDir(runDir, 'packet');
  const { spec } = subsetSpec(input, rows, dir, 'packet');
  const batch = spec.runId || runIdOf(runDir);
  const reviewDrafts = existsSync(join(runDir, 'review-drafts.json')) ? JSON.parse(readFileSync(join(runDir, 'review-drafts.json'), 'utf8')) : {};
  let slots = new Map();
  try { slots = (await import('./run-calendar.mjs')).approvedCalendar(runDir)?.bySlot || new Map(); } catch { /* no calendar: --at names every row */ }
  const at = parseAt(atFlag);
  const { times, missing } = scheduleTimes(spec.rows, { slots, at });
  if (missing.length) throw new Error(`No approved slot or --at time for ${missing.join(', ')}`);
  const moved = spec.rows.filter((r) => at[r.id] && slots.get(r.id) && Date.parse(slots.get(r.id)) !== Date.parse(times[r.id])).map((r) => r.id);
  if (moved.length && !reason) throw new Error(`--at moves ${moved.join(', ')} off the brief's calendar: pass --reason "the owner's words" for the schedule stop`);
  const { checkRow } = await import('./run-studio.mjs');
  const unapproved = [];
  for (const r of spec.rows) { try { checkRow(runDir, 'drafts', r.id); } catch (e) { unapproved.push(`${r.id} (${e.message})`); } }
  if (unapproved.length) throw new Error(`drafts not approved: ${unapproved.join(', ')} — approve the drafts batch first`);
  console.log(`schedule packet · ${spec.rows.length} row(s) · ${dir}`);
  // 1. Links: the same publish specs the schedule stage mints, so the live run reuses every link.
  const ship = await writeShipSpecs({ runDir, spec, dir, batch, reviewDrafts });
  const mint = run(['batch-mint.mjs', ship], { allowFail: true });
  console.log(mint.out.split('\n').filter((l) => /spec\(s\)|✗|NOT ready/.test(l)).map((l) => `  ${l.trim()}`).join('\n'));
  if (mint.status !== 0) throw new Error('minting did not complete: no packet built');
  const linked = { ...spec, rows: spec.rows.map((r) => linkedRow(r, JSON.parse(readFileSync(join(ship, `${r.id}.json`), 'utf8')))) };
  const linkedFile = join(dir, 'linked-spec.json');
  writeFileSync(linkedFile, JSON.stringify(linked, null, 1), { mode: 0o600 });
  // 2. The review drafts take the linked copy; their media stays (run-review-drafts postsKeepingMedia).
  const synced = run(['scripts/run-review-drafts.mjs', '--stage', 'drafts', '--run-dir', runDir, '--run-id', batch, '--input', linkedFile]);
  console.log(synced.out.split('\n').filter((l) => /^(updated|unchanged|owner-edited|refused|skip)/.test(l)).map((l) => `  ${l}`).join('\n'));
  // 3. Occupancy for the packet's dates, then the packet rows from the live drafts.
  const dates = [...new Set(Object.values(times).map((t) => new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(0, 10)))];
  const occFile = join(dir, 'occupancy.json');
  run(['scripts/run-occupancy.mjs', '--dates', dates.join(','), '--accounts', [...new Set(spec.rows.map((r) => r.account))].join(','), '--out', occFile]);
  const { loadEnv, typefully } = await import('../lib.mjs');
  const tf = typefully(loadEnv());
  const freshDrafts = JSON.parse(readFileSync(join(runDir, 'review-drafts.json'), 'utf8'));
  const now = new Date().toISOString();
  const packetRows = [];
  for (const row of linked.rows) {
    const rd = freshDrafts[row.id];
    if (!rd?.draftId) throw new Error(`${row.id}: no [REVIEW] draft in review-drafts.json`);
    const draft = await tf.getDraft(rd.socialSetId, rd.draftId);
    packetRows.push(schedulePacketRow(row, { draft, reviewDraft: rd, at: times[row.id], revision: checkRow(runDir, 'drafts', row.id).revision, reason: moved.includes(row.id) ? reason : null, now }));
  }
  const expectedRows = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).rowStages?.drafts?.expectedRows;
  const specFile = join(dir, 'schedule-spec.json');
  writeFileSync(specFile, JSON.stringify({ runDir, expectedRows, occupancy: JSON.parse(readFileSync(occFile, 'utf8')), rows: packetRows }, null, 1), { mode: 0o600 });
  // 4. Jev's final read, the plan, and the batches submitted for the owner.
  const jev = run(['scripts/run-jev-final.mjs', '--run-dir', runDir, '--input', specFile], { allowFail: true });
  console.log(`  ${jev.out.split('\n').find((l) => /^final-copy:/.test(l)) || 'Jev final: no summary line'}`);
  const planFile = join(dir, 'schedule-plan.json'), batches = join(dir, 'schedule-batches');
  const plan = run(['scripts/plan-run-schedule.mjs', '--input', specFile, '--output', planFile, '--review-dir', batches], { json: true });
  for (const c of plan.data?.calendar || []) if (c.verdict === 'blocked') console.log(`  ✗ ${c.id}: ${c.why}`);
  for (const f of existsSync(batches) ? readdirSync(batches).filter((x) => x.endsWith('.json')) : []) {
    const r = run(['scripts/run-studio.mjs', 'submit-batch', runDir, 'schedule', join(batches, f)], { json: true });
    console.log(`  submitted ${r.data?.batchId} · revision ${r.data?.revision} · ${(r.data?.rows || []).map((x) => x.id).join(' ')}`);
    console.log(`  approve with: node scripts/run-studio.mjs approve-batch ${runDir} schedule ${r.data?.batchId} --revision ${r.data?.revision} --message "<the owner's words>"`);
  }
  console.log(`  linked spec: ${linkedFile}`);
  notionPush(runDir, linkedFile);
}

async function scheduleStage({ runDir, input, rows, dry, atFlag, geni = true }) {
  const dir = nextDir(runDir, 'schedule');
  const { spec } = subsetSpec(input, rows, dir, 'schedule');
  const batch = spec.runId || runIdOf(runDir);
  const reviewDrafts = existsSync(join(runDir, 'review-drafts.json')) ? JSON.parse(readFileSync(join(runDir, 'review-drafts.json'), 'utf8')) : {};
  let slots = new Map();
  try { slots = (await import('./run-calendar.mjs')).approvedCalendar(runDir)?.bySlot || new Map(); } catch { /* no calendar: --at must name every row */ }
  const { times, missing } = scheduleTimes(spec.rows, { slots, at: parseAt(atFlag) });
  if (missing.length) throw new Error(`No approved slot or --at time for ${missing.join(', ')}`);
  // THE LEDGER'S WORD (owner, 2026-10-06: no permission prompts on the run). A live schedule writes only
  // rows whose drafts row is approved, at the minute the approved schedule row names (ship-day's own
  // SLOT_NOT_APPROVED guard); the write gate passes `--run-dir` on the strength of this check.
  if (!dry) {
    const { checkRow } = await import('./run-studio.mjs');
    const { slotWriteGuard } = await import('./run-calendar.mjs');
    const holds = ledgerHolds(spec.rows, times, runDir, { checkRow, slotWriteGuard });
    if (holds.length) throw new Error(`SLOT_NOT_APPROVED — nothing minted or scheduled:\n${holds.map((h) => `  ${h.id}: ${h.reason}`).join('\n')}`);
    console.log(`  ledger: ${spec.rows.length} row(s) approved at their approved minute`);
  }
  const ship = await writeShipSpecs({ runDir, spec, dir, batch, reviewDrafts });
  console.log(`schedule · ${spec.rows.length} row(s) · ${dir}`);
  const mint = run(['batch-mint.mjs', ship, ...(dry ? ['--dry'] : [])], { allowFail: true });
  console.log(mint.out.split('\n').filter((l) => /spec\(s\)|✓|✗|NOT ready/.test(l)).map((l) => `  ${l.trim()}`).join('\n'));
  if (mint.status !== 0 && !dry) throw new Error('minting did not complete: nothing was scheduled');
  if (dry) {
    // A dry mint writes no links, so publish-thread --dry would refuse every spec. When every link is
    // already in the ledger the real pass mints nothing: it only fills RUN_DIR specs, so run it.
    const toMint = Number(mint.out.match(/(\d+) to mint/)?.[1] ?? NaN);
    if (toMint !== 0) { console.log(`  --dry: ${Number.isFinite(toMint) ? toMint : 'an unknown number of'} link(s) still to mint, so the publish dry run is skipped`); return; }
    run(['batch-mint.mjs', ship]);
  }
  // The approved media: what each row's [REVIEW] draft carries right before adoption (the /run media pass
  // put it there; the owner may have removed a picture in Typefully). The readback holds the shipped draft
  // to exactly that.
  const expectMedia = new Map();
  if (!dry) {
    const { loadEnv, typefully } = await import('../lib.mjs');
    const tfr = typefully(loadEnv());
    for (const row of spec.rows) {
      const rd = reviewDrafts[row.id];
      if (!rd?.draftId || !rd?.socialSetId) continue;
      try { expectMedia.set(row.id, ((await tfr.getDraft(rd.socialSetId, rd.draftId))?.platforms?.x?.posts || []).map((p) => p?.media_ids?.length || 0)); }
      catch (e) { console.log(`  ⚠️ ${row.id}: could not read its review draft's media (${String(e.message).slice(0, 80)}) — readback falls back to ATTACH_MEDIA`); }
    }
  }
  const mediaLedger = existsSync(join(runDir, 'media.json')) ? JSON.parse(readFileSync(join(runDir, 'media.json'), 'utf8')) : {};
  const results = [];
  for (const row of spec.rows) {
    const open = expectMedia.has(row.id) ? mediaChoicesOpen(mediaLedger[row.id], expectMedia.get(row.id)) : [];
    if (open.length) {
      results.push({ id: row.id, ok: false, at: times[row.id], draftId: null, line: `held: tweet ${open.join(', ')} still carries the clip AND the original's media — keep one in the [REVIEW] draft, then re-run` });
      continue;
    }
    const args = ['publish-thread.mjs', '--file', join(ship, `${row.id}.json`), '--at', times[row.id], ...(dry ? ['--dry'] : [])];
    const r = run(args, { allowFail: true });
    const lines = `${r.out}\n${r.err}`.split('\n').filter((l) => l.trim() && !/^\[roster\]/.test(l));
    const line = lines.find((l) => /Draft (adopted|created)|ERROR|✗/.test(l)) || lines.find((l) => /validation passed|DRY/i.test(l)) || lines.at(-1) || '';
    const draftId = `${r.out}`.match(/Draft (?:adopted|created): (\d+)/)?.[1] || null;
    results.push({ id: row.id, ok: r.status === 0, at: times[row.id], draftId, line: line.trim().slice(0, 140) });
  }
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id.padEnd(16)} ${r.at}  ${r.line}`);
  if (dry) { console.log('  --dry: nothing minted or scheduled'); return; }
  // Readback: the publish lines above are the writer's own account; Typefully is the truth.
  const { loadEnv, typefully } = await import('../lib.mjs');
  const { ACCOUNTS, resolveAccountKey } = await import('../accounts.mjs');
  const { ATTACH_MEDIA } = await import('../config.mjs');
  const tf = typefully(loadEnv());
  console.log('readback (Typefully):');
  let bad = 0;
  for (const r of results.filter((x) => x.ok)) {
    const row = spec.rows.find((x) => x.id === r.id);
    const id = r.draftId;
    const acc = ACCOUNTS[resolveAccountKey(row.account)];
    let issues;
    if (!id || !acc?.socialSetId) issues = [`unverified: ${id ? 'no social set for the account' : 'no draft id in the publish output'}`];
    else {
      try { issues = readbackIssues(await tf.getDraft(acc.socialSetId, id), { at: r.at, tweets: row.draft.tweets, attachMedia: ATTACH_MEDIA, expectMedia: expectMedia.get(row.id) ?? null }); }
      catch (e) { issues = [`unverified: read failed (${String(e.message).slice(0, 80)})`]; }
    }
    if (issues.length) bad++;
    console.log(`  ${issues.length ? '✗' : '✓'} ${r.id.padEnd(16)} ${id || '-'}  ${issues.join('; ') || 'scheduled as approved'}`);
    if (!issues.length) r.geniTarget = { socialSetId: acc.socialSetId, draftId: id, account: row.account };
  }
  // GENIUSLINK IS THE DEFAULT (owner, 2026-11-02: "Geniuslink i our default from now"). After the copy
  // reads back as approved, every lvnta.com plug on X and Threads is wrapped in geni.us with the
  // US-only rule (geni-swap.mjs). --no-geni keeps plain Levanta links.
  if (geni) {
    const { swapDraft } = await import('../geni-swap.mjs');
    const { geniuslink } = await import('../lib.mjs');
    let gl = null;
    try { gl = geniuslink(loadEnv()); } catch (e) { bad++; console.log(`  ✗ geni: ${String(e.message).slice(0, 120)} — threads keep plain lvnta links`); }
    for (const r of gl ? results.filter((x) => x.geniTarget) : []) {
      try { const g = await swapDraft({ tf, gl, ...r.geniTarget }); if (!g.ok) bad++; console.log(`  ${g.ok ? '✓' : '✗'} ${r.id.padEnd(16)} geni: ${g.line}`); }
      catch (e) { bad++; console.log(`  ✗ ${r.id.padEnd(16)} geni: ${String(e.message).slice(0, 140)} — this thread keeps plain lvnta links`); }
    }
  }
  const failed = results.filter((x) => !x.ok).length;
  if (bad || failed) process.exitCode = 1;
  console.log(`  ${results.length - failed - bad}/${results.length} scheduled and read back${failed ? ` · ${failed} publish failure(s)` : ''}${bad ? ` · ${bad} readback problem(s)` : ''}`);
  notionPush(runDir, input, { refreshHooks: true });
}

async function main(argv) {
  const [stage] = argv;
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const runDir = flag('run-dir'), input = flag('input');
  if (!['drafts', 'schedule-packet', 'schedule'].includes(stage) || !runDir || !input) {
    throw new Error('Usage: run-row.mjs drafts|schedule-packet|schedule --run-dir RUN_DIR --input SPEC.json [--rows a,b] [--at id=ISO,...] [--reason "owner words"] [--no-media] [--hook-only] [--clips cut|reuse|off] [--max-cuts N] [--no-geni] [--dry]');
  }
  const target = resolve(runDir);
  if (target === ROOT || target.startsWith(`${ROOT}/`)) throw new Error('RUN_DIR must be outside the repository: specs quote unpublished copy');
  const media = argv.includes('--no-media') ? false : { clips: flag('clips'), maxCuts: flag('max-cuts'), hookOnly: argv.includes('--hook-only') };
  const opts = { runDir: target, input: resolve(input), rows: flag('rows'), dry: argv.includes('--dry'), atFlag: flag('at'), media, reason: flag('reason'), geni: !argv.includes('--no-geni') };
  if (stage === 'schedule-packet') return schedulePacketStage(opts);
  return stage === 'drafts' ? draftsStage(opts) : scheduleStage(opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
