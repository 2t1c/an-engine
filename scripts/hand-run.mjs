#!/usr/bin/env node
// hand-run.mjs: the daily hand-written run as three commands instead of nine scratch scripts.
//
// Owner, 2026-11-10: "how to speed up our thread generation speed?" ... "yes merge them to unify
// workflow" ... "if I approve the brief you don't need to wait for any other approval and you can
// one-shot schedule them". The writing was never the slow part (14 covers in six minutes); the
// separate hand steps around it were. This file is those steps, in order, resumable, with one report.
//
//   node scripts/hand-run.mjs check   --work DIR --date YYYY-MM-DD [--shared] [--only ID]
//   node scripts/hand-run.mjs prepare --work DIR --review DIR --date YYYY-MM-DD [--accept id,id] [--no-media]
//   node scripts/hand-run.mjs ship    --work DIR --review DIR --date YYYY-MM-DD [--dry] [--no-geni] [--no-link-check] [--log FILE] [--accept id,id]
//
// check    reads only: the gate (pot-gate.mjs), the plug rules (plug-lint.mjs), hook fidelity, overlap with the donor's body, and overlap
//          BETWEEN the day's threads (owner, same day: reuse "may increase similarity between threads
//          which means more linkage").
// prepare  check, then [REVIEW] drafts, the hook media pass and the about-me tweet. A row with a finding
//          is held unless its id is named in --accept, which is a person's decision and is printed.
// ship     re-reads the plug rules on each Typefully draft as it stands (a row that breaks one is NOT
//          scheduled unless its id is in --accept, a person's decision), then mints what is not minted, put the links in, mirror to Threads, schedule each row at its slot,
//          swap to Geniuslink, read every draft back, check every link lands on its product, and append
//          the test-log rows. --dry writes nothing.
//
// The work dir holds what the writer produced: rows.json ({ account: { donor, url, tweets, asins, group,
// slot: 'HH:MM' (UTC), boost, slug } }) and drafts/<ID>.json gate specs, ID = X<MMDD>-<account>. The
// script never writes copy and never calls a model.
//
// A POT row (a thread filled from a named seed) also carries, in rows.json: potOf (the seed's slug),
// seedRecId (the Seeds row), seedVersion, and optionally potRecId (the Pots row) and dials. Any row may
// carry variant (the CTA test side, e.g. 'ws' or 'sep'). Without these a pot was logged as a cover and
// never reached the farm gate (2026-11-16, -18 and -19).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LINK_RE = /\{\{LINK\d?\}\}/g;
const URL_RE = /https:\/\/(?:geni\.us|lvnta\.com)\/\S+/g;
const SUFFIX = ['', '-b', '-c', '-d', '-e']; // 5 plugs: product listicles plug every shelf item (owner 2026-11-19)

// The approved plug plan's duration, type flip and body ride into the CTA log, so the next brief can keep the
// same duration for the page and product (docs/cta-templates.md H3).
function planLog(work, account) {
  try {
    const P = JSON.parse(fs.readFileSync(path.join(work, 'plug-plan.json'), 'utf8'))[account];
    if (!P) return {};
    return { ...(P.heavy?.duration ? { duration: P.heavy.duration } : {}), ...(P.type === 'flip' ? { typeFlip: P.flip } : {}), ...(P.body ? { body: P.body } : {}) };
  } catch { return {}; }
}

// ---- pure helpers (tests/hand-run.test.mjs) ------------------------------------------------------
/** The word 4-grams of a text, lowercased, link placeholders and punctuation dropped. */
export function grams(text, n = 4) {
  const w = String(text || '').replace(LINK_RE, ' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
const union = (sets) => { const u = new Set(); for (const s of sets) for (const g of s) u.add(g); return u; };

/** Share of OUR body's 4-grams that also sit in the donor's body. Hooks are excluded on both sides. */
export function donorOverlap(tweets = [], donorTweets = []) {
  const ours = union(tweets.slice(1).map((t) => grams(t)));
  const theirs = union(donorTweets.slice(1).map((t) => grams(t)));
  if (!ours.size) return 0;
  let hit = 0; for (const g of ours) if (theirs.has(g)) hit++;
  return hit / ours.size;
}

/**
 * Share of each thread's body 4-grams that another of the day's threads also uses. The hook and the
 * last tweet (the disclaimer) are left out: the hook is the donor's, the disclaimer is per account.
 * A product bridge pasted into ten threads is what this catches. `exempt` is a set of 4-grams the
 * owner fixed in the templates (laws.json run.hand.fixedPhrases); they leave both sides of the share.
 */
export function crossOverlap(threads = {}, { exempt = new Set() } = {}) {
  const out = {};
  for (const [id, r] of Object.entries(crossShared(threads, { exempt }))) out[id] = r.share;
  return out;
}

/** The 4-grams of fixed phrases, built through grams() so "you're" matches the way bodies are cut. */
export function fixedGrams(phrases = []) {
  return union(phrases.map((p) => grams(p)));
}

/**
 * crossOverlap with the evidence: per thread the share (exempt grams left out), the raw share (all
 * grams), and per tweet the shared phrases (runs of shared 4-grams merged) with the threads that
 * also carry them, so a writer can fix every overlap in one pass.
 */
export function crossShared(threads = {}, { exempt = new Set() } = {}) {
  const words = (t) => String(t || '').replace(LINK_RE, ' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const body = Object.fromEntries(Object.entries(threads).map(([id, tw]) => [id, tw.slice(1, -1)]));
  const owners = new Map();
  for (const [id, tw] of Object.entries(body)) for (const g of union(tw.map((t) => grams(t)))) {
    if (!owners.has(g)) owners.set(g, new Set());
    owners.get(g).add(id);
  }
  const out = {};
  for (const [id, tw] of Object.entries(body)) {
    const set = union(tw.map((t) => grams(t)));
    let hit = 0, rawHit = 0, kept = 0;
    for (const g of set) {
      const shared = owners.get(g).size > 1;
      if (shared) rawHit++;
      if (exempt.has(g)) continue;
      kept++; if (shared) hit++;
    }
    const tweets = [];
    tw.forEach((t, i) => {
      const w = words(t), phrases = [];
      let cur = null;
      for (let k = 0; k + 4 <= w.length; k++) {
        const g = w.slice(k, k + 4).join(' ');
        const others = owners.get(g) && !exempt.has(g) ? [...owners.get(g)].filter((o) => o !== id) : [];
        if (others.length) {
          if (cur && k <= cur.end) { cur.end = k + 4; others.forEach((o) => cur.with.add(o)); } else { cur = { start: k, end: k + 4, with: new Set(others) }; phrases.push(cur); }
        } else if (cur && k >= cur.end) cur = null;
      }
      if (phrases.length) tweets.push({ n: i + 2, phrases: phrases.map((p) => ({ text: w.slice(p.start, p.end).join(' '), with: [...p.with].sort() })) });
    });
    out[id] = { share: kept ? hit / kept : 0, raw: set.size ? rawHit / set.size : 0, tweets };
  }
  return out;
}

export const placeholders = (tweets = []) => (tweets.join('\n').match(LINK_RE) || []).length;

/** {{LINK}}, {{LINK2}}, {{LINK3}} -> the minted URLs. Throws when a placeholder has no link. */
export function subLinks(text, links = []) {
  return String(text).replace(LINK_RE, (m) => {
    const i = m === '{{LINK}}' ? 0 : Number(m.match(/\d/)[0]) - 1;
    if (!links[i]) throw new Error(`no minted link for ${m}`);
    return links[i];
  });
}

/** x-thread-<account>-<yymmdd>-<slug>[-b|-c|-d]; the account is always the third dash field. */
export function subidFor({ account, date, slug, index = 0 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`bad date ${date}`);
  if (!/^[a-z0-9]+$/.test(String(slug || ''))) throw new Error(`slug must be lowercase letters and digits: ${slug}`);
  if (SUFFIX[index] == null) throw new Error(`no subid suffix for plug ${index + 1}`);
  const id = `x-thread-${account}-${date.slice(2).replace(/-/g, '')}-${slug}${SUFFIX[index]}`;
  if (id.length >= 50) throw new Error(`subid over 49 characters: ${id}`);
  return id;
}

/** mint-link.mjs output lines -> { subid: url }. Anything that is not a MINTED line is ignored. */
export function parseMinted(text = '') {
  const out = {};
  for (const line of String(text).split('\n')) {
    const [tag, , subid, url] = line.split('\t');
    if (tag === 'MINTED' && subid && /^https:\/\/lvnta\.com\//.test(url || '')) out[subid] = url.trim();
  }
  return out;
}

/**
 * PURE. The link each plug of a row carries, in plug order. A plug a brand lane owns (brandOf(asin) gives
 * the brand's geni.us link, brand-lanes.json) carries that link and is never minted on Levanta (owner
 * 2026-11-21: the Ultimate Health pages plug only on the brand's attribution links). Every other plug
 * carries its minted Levanta link, or undefined while it is not minted. Returns [{ subid, asin, link, brand }].
 */
export function plugLinks({ asins = [], subids = [] }, minted = {}, brandOf = () => null) {
  return subids.map((subid, i) => {
    const asin = asins[i], b = brandOf(asin);
    return { subid, asin, link: b || minted[subid], brand: Boolean(b) };
  });
}

/**
 * The about-me tweet goes second to last, above the disclaimer (owner, 2026-11-08, standing).
 * Returns { posts, changed }. Already there -> unchanged. A last tweet that is not a disclaimer throws,
 * because inserting above it would put the about-me in the wrong place.
 */
export function insertAboutMe(posts = [], aboutText, mediaIds = []) {
  if (posts.some((p) => p.text === aboutText)) return { posts, changed: false };
  const last = posts[posts.length - 1];
  if (!last || !/affiliate|commission/i.test(last.text)) throw new Error('last tweet is not the disclaimer');
  const out = posts.map((p) => ({ text: p.text, media_ids: p.media_ids || [] }));
  out.splice(out.length - 1, 0, { text: aboutText, media_ids: mediaIds });
  return { posts: out, changed: true };
}

/** PURE over the ledger text: shared brand link -> the per-thread link geni-swap made for this draft. */
export function brandSwapsOf(ledgerText, draftId) {
  const out = new Map();
  for (const line of String(ledgerText || '').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r?.mode === 'geni-brand' && String(r.draftId) === String(draftId) && r.brandLink && r.glink) out.set(r.brandLink, r.glink);
  }
  return out;
}
const brandSwapsFor = (draftId) => { try { return brandSwapsOf(fs.readFileSync(path.join(ROOT, 'ledger.jsonl'), 'utf8'), draftId); } catch { return new Map(); } };

/** What a scheduled draft must look like. Returns the list of problems, empty when it is right. */
export function readbackProblems(draft, { asins = [], aboutText = null, at = null, geni = true, brandLinks = [], brandSwaps = new Map() } = {}) {
  const p = [];
  const x = draft?.platforms?.x?.posts || [];
  const all = x.map((t) => t.text).join('\n');
  const links = all.match(URL_RE) || [];
  if (draft?.status !== 'scheduled') p.push(`status ${draft?.status}`);
  const when = draft?.scheduled_date || draft?.publish_at;
  if (at && new Date(when).getTime() !== new Date(at).getTime()) p.push(`scheduled ${when}, wanted ${at}`);
  if (placeholders([all])) p.push('a {{LINK}} placeholder is left');
  if (links.length !== asins.length) p.push(`${links.length} links for ${asins.length} products`);
  if (geni && links.some((l) => !l.includes('geni.us'))) p.push('a link is not Geniuslink');
  // A brand-lane plug must still carry the brand's own link after the Geniuslink swap (2026-11-22: two
  // runs shipped the Ultimate Health pages on Levanta links and the readback passed them).
  // Since 2026-11-25 geni-swap gives each brand plug a per-thread link to the same brand URL ("wrap brand links in
  // geniuslink so we know where clicks came from"); its geni-brand ledger row for this draft makes that link right.
  brandLinks.forEach((b, i) => { if (b && links[i] !== b && links[i] !== brandSwaps.get(b)) p.push(`link ${i + 1} is ${links[i] || 'missing'}, the brand lane wants ${b}`); });
  if (aboutText && x.at(-2)?.text !== aboutText) p.push('about-me tweet is not second to last');
  if (x.some((t) => t.text.replace(URL_RE, 'x'.repeat(23)).length > 280)) p.push('a tweet is over 280');
  if (/^\[REVIEW\]/.test(draft?.draft_title || '')) p.push('title still says [REVIEW]');
  return p;
}

/**
 * Hook clips the media pass took from the clip library. The pass uploads the stored Clip File as it is,
 * and the owner's rule (2026-10-13) is that a clip sits on a page only as a fresh cut ("recut everytime so
 * they have different meta-data"). Each one named here has to be recut before the thread posts.
 */
export function storedClipPlacements(hookFiles = {}) {
  const out = [];
  for (const [id, h] of Object.entries(hookFiles)) for (const d of (h?.recut ? [] : h?.decisions) || []) {
    if (d?.action === 'reuse' && d.pick?.kind === 'library' && d.pick.id) out.push({ id, clip: d.pick.id, start: d.pick.start, end: d.pick.end });
  }
  return out;
}

/** PURE. One line per row on the hook's media after the media pass; NO HOOK MEDIA when it is bare. */
export function hookLines(media = {}, ids = []) {
  return ids.map((id) => {
    const m = media?.[id];
    if (!m) return `${id}: hook media UNVERIFIED (no media pass record)`;
    const t1 = m.tweets?.[0];
    if (!t1?.media) {
      const why = m.original && !m.original.count ? 'donor hook is text-only' : (m.notes || []).join('; ') || 'nothing found';
      return `${id}: NO HOOK MEDIA (${why})`;
    }
    return `${id}: hook ${t1.source} · ${t1.why || ''}`.trim();
  });
}

/**
 * The link check for one shipped thread. `links` are the tracked links in tweet order, `asins` the
 * row's products in the same order, `resolved` what resolveLink (check-links.mjs) returned for each.
 * Returns [{ i, link, asin, got, verdict: 'ok' | 'wrong' | 'unverified', why }]. A link that lands on
 * the right ASIN with attribution is ok even when Amazon answers the bot with a 503 (the page load is
 * then unverified, which `why` says). A wrong or missing ASIN is wrong. No answer at all is unverified,
 * never ok.
 */
export function linkProblems(links = [], asins = [], resolved = []) {
  const out = [];
  const n = Math.max(links.length, asins.length);
  for (let i = 0; i < n; i++) {
    const link = links[i] || null, asin = asins[i] || null, r = resolved[i] || null;
    if (!link) { out.push({ i, link, asin, got: null, verdict: 'wrong', why: 'no link for this product' }); continue; }
    if (!asin) { out.push({ i, link, asin, got: r?.asin || null, verdict: 'wrong', why: 'a link with no product in the row' }); continue; }
    if (!r || (!r.asin && !r.status)) { out.push({ i, link, asin, got: null, verdict: 'unverified', why: r?.why || 'not resolved' }); continue; }
    if (r.asin && r.asin !== asin) { out.push({ i, link, asin, got: r.asin, verdict: 'wrong', why: `lands on ${r.asin}, wanted ${asin}` }); continue; }
    if (!r.asin) { out.push({ i, link, asin, got: null, verdict: r.status >= 500 || r.status === 429 ? 'unverified' : 'wrong', why: r.why || 'not a product page' }); continue; }
    if (!r.hasAttribution) { out.push({ i, link, asin, got: r.asin, verdict: 'wrong', why: 'product page but no attribution' }); continue; }
    out.push({ i, link, asin, got: r.asin, verdict: 'ok', why: r.ok ? 'ok' : `right ASIN, page load unverified (${r.why})` });
  }
  return out;
}

/**
 * PURE. The farm identity of a row. A row with potOf is a pot of that seed; everything else is a cover.
 * `issues` names what a pot row still lacks for its plant to be stamped to the seed.
 */
export function farmOf(row = {}) {
  const potOf = row.potOf ? String(row.potOf).trim().toLowerCase() : null;
  if (!potOf) return { lane: 'cover', potOf: null, issues: [] };
  const issues = [];
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(row.seedRecId || ''))) issues.push('seedRecId (the Seeds row) is missing, so the plant cannot be linked to its seed');
  const version = row.seedVersion == null || String(row.seedVersion).trim() === '' ? NaN : Number(row.seedVersion);
  if (!Number.isFinite(version)) issues.push('seedVersion is missing, so the pot cannot be told from an outdated one');
  if (row.potRecId && !/^rec[A-Za-z0-9]{14}$/.test(String(row.potRecId))) issues.push('potRecId is not an Airtable record id');
  return { lane: 'pot', potOf, seedRecId: row.seedRecId || null, potRecId: row.potRecId || null, seedVersion: Number.isFinite(version) ? version : null, dials: Array.isArray(row.dials) ? row.dials : null, issues };
}

/**
 * PURE. The spec pot-gate reads for a row. A pot row (potOf in rows.json) is gated as a pot of its seed:
 * lane "pot", its seed's Seeds row, no donor tweets (the origin is the seed's, from queues/origins). A
 * one-ask brand-lane page is gated on the single-cta arm. Anything else is returned unchanged (same object).
 * On 2026-11-22 all 7 pots went through as cover-pots of a "seed:" recId and failed donor reads that
 * cannot apply to them, so every pot needed --accept.
 */
export function gateSpec(spec = {}, row = {}, { singleCta = false } = {}) {
  const farm = farmOf(row);
  if (farm.lane !== 'pot' && !singleCta) return spec;
  const out = { ...spec };
  if (farm.lane === 'pot') {
    Object.assign(out, { lane: 'pot', potOf: farm.potOf, seedRecId: farm.seedRecId });
    if (!Array.isArray(out.dials)) out.dials = farm.dials || [];
    delete out.donorTweets;
    delete out.donorHook;
  }
  if (singleCta && !out.arm) out.arm = 'single-cta';
  return out;
}

/** PURE. What the farm identity adds to a test-log row: lane, and for a pot its seed, version and dials. */
export function farmLog(row = {}) {
  const f = farmOf(row);
  return {
    lane: f.lane,
    ...(f.lane === 'pot' ? { seed: f.potOf, seedVersion: f.seedVersion, ...(f.potRecId ? { potRecId: f.potRecId } : {}), ...(f.dials ? { dials: f.dials } : {}) } : {}),
    ...(row.variant ? { variant: String(row.variant) } : {}),
  };
}

/** PURE. A pot's title carries its family the way publish-thread writes it: [Pot·lotus]. Idempotent. */
export function potTitle(title = '', potOf = null) {
  const t = String(title).replace(/^\[REVIEW\]\s*/, '');
  if (!potOf || t.includes(`[Pot·${potOf}]`)) return t;
  return `[Pot·${potOf}] ${t}`;
}

// ---- wiring --------------------------------------------------------------------------------------
const arg = (argv, k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const idOf = (date, account) => `X${date.slice(5).replace('-', '')}-${account}`;

function load(argv) {
  const work = arg(argv, 'work'), date = arg(argv, 'date');
  if (!work || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('needs --work DIR and --date YYYY-MM-DD');
  const rows = readJson(path.join(work, 'rows.json'));
  const specs = {};
  for (const account of Object.keys(rows)) specs[account] = readJson(path.join(work, 'drafts', `${idOf(date, account)}.json`));
  return { work, date, rows, specs, review: arg(argv, 'review') };
}

async function check({ work, date, rows, specs }) {
  const C = await import(pathToFileURL(path.join(ROOT, 'checks.mjs')).href);
  const laws = readJson(path.join(ROOT, 'laws.json'));
  const bodyMax = laws.farm?.coverAsPot?.bodyMax ?? 0.1;
  const crossMax = laws.run?.hand?.crossOverlapMax ?? 0.1;
  const exempt = laws.run?.hand?.exemptFixedPhrases === false ? new Set() : fixedGrams(laws.run?.hand?.fixedPhrases || []);
  const detail = crossShared(Object.fromEntries(Object.entries(rows).map(([a, r]) => [a, r.tweets])), { exempt });
  const cross = Object.fromEntries(Object.entries(detail).map(([a, r]) => [a, r.share]));
  const PP = await import(pathToFileURL(path.join(ROOT, 'plug-plan.mjs')).href);
  const plans = PP.loadPlans(work); // the approved brief's plug plan; when it exists, drafts must follow it
  // Every locked plugging rule (plug-lint.mjs, owner 2026-11-20 "strong railguard"); the gate below
  // already runs the point frame, so it is not repeated here.
  const PL = await import(pathToFileURL(path.join(ROOT, 'plug-lint.mjs')).href);
  const products = PL.loadProducts(), prior = PL.loadPrior();
  const BL = await import(pathToFileURL(path.join(ROOT, 'brand-lanes.mjs')).href);
  const lanes = BL.loadLanes();
  const report = {};
  for (const [account, row] of Object.entries(rows)) {
    const farm = farmOf(row), pot = farm.lane === 'pot';
    const singleCta = BL.singleCtaLane(account, lanes);
    const spec = gateSpec(specs[account], row, { singleCta }), findings = [], warnings = [];
    if (plans && !plans[account]) findings.push('plan: no plug plan for this page on the approved brief');
    // A pot keeps its seed's point titles word for word (seed origin lock, owner 2026-11-19), so a plan
    // title that differs is the plan's slip, not the draft's; every other plan read still holds on pots.
    else if (plans) for (const m of PP.planMatchIssues(row.tweets, plans[account])) if (!(pot && /point title is not/.test(m))) findings.push(`plan: ${m}`);
    for (const f of PL.plugLint(row.tweets, { asins: row.asins || [], products, prior, account, kind: PL.kindOf(row), pointFrame: false, singleCta })) {
      // The approved brief already paired heavy and light (plug-plan.json); a payout nudge on a pairing
      // the owner signed off is noise that repeats on every check round.
      if (plans && f.rule === 'payout-first') continue;
      if (f.level === 'hard') findings.push(`plug: ${f.tweet ? `T${f.tweet} ` : ''}[${f.rule}] ${f.msg}`);
      else warnings.push(`plug: ${f.tweet ? `T${f.tweet} ` : ''}[${f.rule}] ${f.msg}`);
    }
    // pot-gate reads the spec file; a pot (or a one-ask lane page) is gated from a normalized copy so
    // the gate reads it as what the row says it is, whatever the drafts file was written with.
    let file = path.join(work, 'drafts', `${idOf(date, account)}.json`);
    if (spec !== specs[account]) {
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hand-run-')), `${idOf(date, account)}.json`);
      fs.writeFileSync(file, JSON.stringify(spec));
    }
    const g = spawnSync(process.execPath, [path.join(ROOT, 'pot-gate.mjs'), file], { cwd: ROOT, encoding: 'utf8' });
    const gateOut = `${g.stdout || ''}${g.stderr || ''}`;
    for (const line of gateOut.split('\n')) { const m = line.match(/^\s+(error|hard)\s+(.*)$/); if (m) findings.push(`gate: ${m[2]}`); }
    if (!/^✓/m.test(gateOut) && !findings.length) findings.push('gate: did not pass and printed no finding (read its output)');
    // A pot has no donor: its hook and body are read against the SEED's origin inside pot-gate (hook shape,
    // device). The donor-hook fidelity and donor-overlap reads are cover laws and stay off pots.
    const hook = pot ? '' : C.hookFidelityIssue(row.tweets[0], spec.donorHook); if (hook) findings.push(`hook: ${hook}`);
    const d = pot ? 0 : donorOverlap(row.tweets, spec.donorTweets); if (d > bodyMax) findings.push(`body shares ${Math.round(d * 100)}% with the donor (max ${Math.round(bodyMax * 100)}%)`);
    if (cross[account] > crossMax) findings.push(`body shares ${Math.round(cross[account] * 100)}% with today's other threads (max ${Math.round(crossMax * 100)}%)`);
    for (const m of farm.issues) findings.push(`pot: ${m}`);
    if (placeholders(row.tweets) !== row.asins.length) findings.push(`${placeholders(row.tweets)} link placeholders for ${row.asins.length} products`);
    report[account] = { id: idOf(date, account), donor: d, cross: cross[account], crossRaw: detail[account].raw, shared: detail[account].tweets, findings: [...new Set(findings)], warnings };
  }
  return report;
}

function printCheck(report, { shared = false, only = null } = {}) {
  for (const r of Object.values(report)) {
    if (only && r.id !== only) continue;
    const raw = r.crossRaw != null && Math.round(r.crossRaw * 100) !== Math.round(r.cross * 100) ? ` (raw ${Math.round(r.crossRaw * 100)}%)` : '';
    console.log(`${r.findings.length ? '✗' : '✓'} ${r.id.padEnd(16)} donor ${Math.round(r.donor * 100)}% · cross ${Math.round(r.cross * 100)}%${raw}`);
    for (const f of r.findings) console.log(`    ${f}`);
    for (const w of r.warnings || []) console.log(`    warn ${w}`);
    if (shared) for (const t of r.shared || []) for (const p of t.phrases) console.log(`      t${t.n} "${p.text}" <-> ${p.with.join(', ')}`);
  }
  const bad = Object.values(report).filter((r) => r.findings.length).length;
  console.log(`${Object.keys(report).length - bad} of ${Object.keys(report).length} clean`);
  return bad;
}

async function clients() {
  const L = await import(pathToFileURL(path.join(ROOT, 'lib.mjs')).href);
  const { ACCOUNTS } = await import(pathToFileURL(path.join(ROOT, 'accounts.mjs')).href);
  return { tf: L.typefully(L.loadEnv()), ACCOUNTS };
}
const aboutFile = () => process.env.ABOUT_ME_FILE || '/mnt/project-files/follow-cta/final/about-me-final.json';

async function prepare(ctx, argv) {
  const { work, date, rows, specs, review } = ctx;
  if (!review) throw new Error('prepare needs --review DIR');
  const report = await check(ctx); printCheck(report);
  const accept = new Set(list(arg(argv, 'accept')));
  const held = Object.entries(report).filter(([, r]) => r.findings.length && !accept.has(r.id)).map(([a]) => a);
  if (accept.size) console.log(`accepted with findings by a person: ${[...accept].join(', ')}`);
  if (held.length) console.log(`held, not created: ${held.map((a) => idOf(date, a)).join(', ')}`);
  const { tf, ACCOUNTS } = await clients();
  fs.mkdirSync(review, { recursive: true });
  const rdPath = path.join(review, 'review-drafts.json');
  const rd = fs.existsSync(rdPath) ? readJson(rdPath) : {};
  const input = { expectedRows: 0, rows: [] };
  for (const [account, row] of Object.entries(rows)) {
    if (held.includes(account)) continue;
    const id = idOf(date, account);
    input.rows.push({ id, account, date, lane: farmOf(row).lane, ctaArm: row.group, source: { id: row.donor, url: row.url, hook: specs[account].donorHook }, tweets: row.tweets });
    if (rd[id]) continue;
    const ss = ACCOUNTS[account]?.socialSetId; if (!ss) { console.log(`${id}: no social set, skipped`); continue; }
    const title = `[REVIEW] ${farmOf(row).potOf ? `[Pot·${farmOf(row).potOf}] ` : ''}R${date} · ${id} · ${account} · ${row.group}/${row.boost} — ${row.tweets[0].replace(/\s+/g, ' ').slice(0, 60)}`;
    const note = [`Test group: ${row.group} · boost: ${row.boost}`, `Slot ${row.slot} UTC ${date}`, `Donor ${row.url}`, `Products ${row.asins.join(', ')}`, 'Links are {{LINK}}/{{LINK2}}/{{LINK3}} until scheduling.'].join('\n');
    const res = await tf.createDraft(ss, { draft_title: title, platforms: { x: { enabled: true, posts: row.tweets.map((t) => ({ text: t })) } }, scratchpad_text: note });
    rd[id] = { stage: 'drafts', socialSetId: ss, draftId: String(res.id), shareUrl: res.share_url || res.private_url, url: res.share_url || res.private_url, account, lane: farmOf(row).lane, date, title };
    fs.writeFileSync(rdPath, JSON.stringify(rd, null, 1));
    console.log(`${id}: draft ${res.id} ${rd[id].shareUrl}`);
  }
  input.expectedRows = input.rows.length;
  fs.writeFileSync(path.join(review, 'input.json'), JSON.stringify(input, null, 1));
  if (!argv.includes('--no-media')) {
    const m = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-media.mjs'), '--run-dir', review, '--input', path.join(review, 'input.json'), '--hook-only'], { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(review, 'media.log'), `${m.stdout || ''}${m.stderr || ''}`);
    console.log(`hook media pass: exit ${m.status} (log in ${path.join(review, 'media.log')})`);
    const mediaDir = path.join(review, 'media'), hooks = {};
    for (const f of fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((n) => n.endsWith('.hook.json')) : []) hooks[f.replace(/\.hook\.json$/, '')] = readJson(path.join(mediaDir, f));
    for (const s of storedClipPlacements(hooks)) console.log(`${s.id}: RECUT NEEDED, the hook carries stored clip ${s.clip} (${s.start}-${s.end}s) as the library file`);
    // One line per row, loud when the hook is bare: a bare hook went unnoticed on 9 of 15 rows (2026-11-18).
    for (const l of hookLines(fs.existsSync(path.join(review, 'media.json')) ? readJson(path.join(review, 'media.json')) : {}, Object.keys(rd))) console.log(l);
  }
  const about = readJson(aboutFile()).accounts, imgDir = path.join(path.dirname(aboutFile()), 'images');
  for (const [id, d] of Object.entries(rd)) {
    const a = about[d.account]; if (!a) { console.log(`${id}: no about-me copy for ${d.account}`); continue; }
    const g = await tf.getDraft(d.socialSetId, d.draftId);
    if (g.platforms.x.posts.some((p) => p.text === a.x)) continue;
    const media = []; for (const f of a.images || []) media.push(await tf.uploadMedia(d.socialSetId, f, fs.readFileSync(path.join(imgDir, f))));
    const { posts } = insertAboutMe(g.platforms.x.posts, a.x, media);
    await tf.patchDraft(d.socialSetId, d.draftId, { platforms: { x: { enabled: true, posts } } });
    console.log(`${id}: about-me inserted (${posts.length} tweets)`);
  }
  return held.length ? 1 : 0;
}

async function ship(ctx, argv) {
  const { work, date, rows, review } = ctx;
  if (!review) throw new Error('ship needs --review DIR');
  const dry = argv.includes('--dry'), geni = !argv.includes('--no-geni');
  const rd = readJson(path.join(review, 'review-drafts.json'));
  const about = readJson(aboutFile()).accounts;
  const { tf, ACCOUNTS } = await clients();
  const mintedPath = path.join(work, 'minted.txt');
  let minted = parseMinted(fs.existsSync(mintedPath) ? fs.readFileSync(mintedPath, 'utf8') : '');
  const PL = await import(pathToFileURL(path.join(ROOT, 'plug-lint.mjs')).href);
  const products = PL.loadProducts(), prior = PL.loadPrior();
  const BL = await import(pathToFileURL(path.join(ROOT, 'brand-lanes.mjs')).href);
  const lanes = BL.loadLanes();
  const accept = new Set(list(arg(argv, 'accept')));
  if (accept.size) console.log(`plug rules waived by a person for: ${[...accept].join(', ')}`);
  const plan = []; let skipped = 0;
  for (const [account, row] of Object.entries(rows)) {
    const id = idOf(date, account); if (!rd[id]) { skipped++; console.log(`${id}: no draft, skipped`); continue; }
    if (!row.slug) throw new Error(`${id}: rows.json has no slug for the subid`);
    plan.push({ account, row, id, d: rd[id], subids: row.asins.map((_, i) => subidFor({ account, date, slug: row.slug, index: i })) });
  }
  const brandOf = (account) => (asin) => BL.brandLinkFor(account, asin, lanes)?.link || null;
  for (const p of plan) for (const [i, subid] of p.subids.entries()) {
    if (minted[subid]) continue;
    if (brandOf(p.account)(p.row.asins[i])) { console.log(`${p.id}: plug ${i + 1} ${p.row.asins[i]} carries the brand link ${brandOf(p.account)(p.row.asins[i])}, not minted`); continue; }
    if (dry) { console.log(`would mint ${p.row.asins[i]} ${subid}`); continue; }
    const m = spawnSync(process.execPath, [path.join(ROOT, 'mint-link.mjs'), '--asin', p.row.asins[i], '--subid', subid], { cwd: ROOT, encoding: 'utf8' });
    const line = `${m.stdout || ''}`.split('\n').find((l) => l.startsWith('MINTED\t'));
    if (!line) throw new Error(`mint failed for ${subid}: ${(m.stdout || m.stderr || '').trim().split('\n').pop()}`);
    fs.appendFileSync(mintedPath, `${line}\n`); minted = { ...minted, ...parseMinted(line) };
  }
  const done = [];
  for (const p of plan) {
    const { account, row, id, d } = p, at = `${date}T${row.slot}:00Z`;
    const cur = await tf.getDraft(d.socialSetId, d.draftId);
    if (cur.status === 'scheduled' || cur.status === 'published') { done.push(p); console.log(`${id}: already ${cur.status}`); continue; }
    const links = plugLinks({ asins: row.asins, subids: p.subids }, minted, brandOf(account)).map((l) => l.link);
    const xs = cur.platforms.x.posts;
    const problems = [];
    if (placeholders(xs.map((t) => t.text)) !== row.asins.length) problems.push('placeholder count does not match the products');
    if (about[account] && xs.at(-2)?.text !== about[account].x) problems.push('about-me tweet is not second to last');
    if (!dry && links.some((l) => !l)) problems.push('a link is not minted');
    // The plug rules on the text as it will be scheduled: Typefully edits after prepare are read here,
    // so a plug broken by hand never ships (owner 2026-11-20). A person can accept a row by id.
    if (!accept.has(id)) {
      const lint = PL.hard(PL.plugLint(xs.map((t) => t.text), { asins: row.asins || [], products, prior, account, kind: PL.kindOf(row), aboutText: about[account]?.x || null, singleCta: BL.singleCtaLane(account, lanes) }));
      for (const f of lint) problems.push(`plug ${f.tweet ? `T${f.tweet} ` : ''}[${f.rule}] ${f.msg}`);
    }
    if (problems.length) { skipped++; console.log(`${id}: NOT scheduled: ${problems.join('; ')}`); continue; }
    const edited = xs.map((t, i) => i).filter((i) => !(xs[i].text === about[account]?.x || row.tweets.includes(xs[i].text)));
    if (dry) { console.log(`${id}: would schedule ${at} · ${xs.length} tweets · hook media ${(xs[0].media_ids || []).length} · edited in Typefully: ${edited.map((i) => i + 1).join(',') || 'none'}`); continue; }
    const posts = xs.map((t) => ({ text: subLinks(t.text, links), media_ids: t.media_ids || [] }));
    const body = { draft_title: potTitle(cur.draft_title || d.title, farmOf(row).potOf), platforms: { x: { enabled: true, posts } } };
    if ((ACCOUNTS[account].crossPost || []).includes('threads')) {
      body.platforms.threads = { enabled: true, posts: posts.map((t, i) => (i === posts.length - 2 && about[account]?.threads ? { text: about[account].threads, media_ids: t.media_ids } : t)) };
    }
    await tf.patchDraft(d.socialSetId, d.draftId, body);
    await tf.patchDraft(d.socialSetId, d.draftId, { publish_at: at });
    p.fresh = true; done.push(p); console.log(`${id}: scheduled ${at}`);
  }
  if (dry) return skipped ? 1 : 0;
  if (geni && done.length) {
    const pairs = done.map((p) => `${p.d.socialSetId}:${p.d.draftId}:${p.account}`).join(',');
    const g = spawnSync(process.execPath, [path.join(ROOT, 'geni-swap.mjs'), '--drafts', pairs], { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(work, 'geni-swap.log'), `${g.stdout || ''}${g.stderr || ''}`);
    console.log(`Geniuslink swap: exit ${g.status} (log in ${path.join(work, 'geni-swap.log')})`);
  }
  const readback = {}; let bad = 0;
  const CL = argv.includes('--no-link-check') ? null : await import(pathToFileURL(path.join(ROOT, 'check-links.mjs')).href);
  for (const p of done) {
    const g = await tf.getDraft(p.d.socialSetId, p.d.draftId);
    const brandLinks = plugLinks({ asins: p.row.asins, subids: p.subids }, {}, brandOf(p.account)).map((l) => (l.brand ? l.link : null));
    const brandSwaps = brandSwapsFor(p.d.draftId);
    const problems = readbackProblems(g, { asins: p.row.asins, aboutText: about[p.account]?.x, at: `${date}T${p.row.slot}:00Z`, geni, brandLinks, brandSwaps });
    let linkCheck = null;
    if (CL) {
      // The link check runs here, not as a separate step: run by hand it needed --account per draft and
      // failed silently without it (2026-11-18). Every tracked link must land on its own product.
      const links = (g.platforms.x.posts.map((t) => t.text).join('\n').match(URL_RE) || []).map(CL.cleanUrl);
      const resolved = []; for (const l of links) resolved.push(await CL.resolveLink(l));
      linkCheck = linkProblems(links, p.row.asins, resolved);
      for (const c of linkCheck) if (c.verdict === 'wrong') problems.push(`link ${c.i + 1}: ${c.why}`);
    }
    const unverified = (linkCheck || []).filter((c) => c.verdict === 'unverified').length;
    readback[p.id] = { status: g.status, at: g.scheduled_date || g.publish_at, tweets: g.platforms.x.posts.length, problems, linkCheck };
    if (problems.length) bad++;
    const lc = linkCheck ? ` · links ${linkCheck.filter((c) => c.verdict === 'ok').length}/${linkCheck.length} right product${unverified ? `, ${unverified} UNVERIFIED` : ''}` : ' · links not checked';
    console.log(`${problems.length ? '✗' : '✓'} ${p.id} ${readback[p.id].at}${lc}${problems.length ? ` · ${problems.join('; ')} (still scheduled: fix or unschedule by hand)` : ''}`);
  }
  fs.writeFileSync(path.join(work, 'readback.json'), JSON.stringify(readback, null, 1));
  // FARM STAMP: a pot's Published Content row is linked to its seed (and its Pots row) when it is
  // scheduled, as publish-thread does, so the gate judges it as a pot at 48h. A failed stamp is said,
  // never swallowed: the plant then has to be linked by hand or it is judged as a cover.
  // A draft that was already scheduled before this ship (a re-run) gets its links repaired but keeps
  // whatever verdict the gate has written; only a newly scheduled pot starts at Pending.
  const pots = done.filter((p) => farmOf(p.row).lane === 'pot' && !farmOf(p.row).issues.length);
  for (const p of done) if (farmOf(p.row).lane === 'pot' && farmOf(p.row).issues.length) console.log(`${p.id}: pot of ${farmOf(p.row).potOf} NOT stamped: ${farmOf(p.row).issues.join('; ')}`);
  if (pots.length) {
    try {
      const L = await import(pathToFileURL(path.join(ROOT, 'lib.mjs')).href);
      const { farmStampRow } = await import(pathToFileURL(path.join(ROOT, 'harvest-gate.mjs')).href);
      const { REGISTRY_TABLE } = await import(pathToFileURL(path.join(ROOT, 'config.mjs')).href);
      const env = L.loadEnv(), at = L.airtable(env, env.REGISTRY_BASE_ID);
      await at.upsert(REGISTRY_TABLE, 'Draft ID', pots.map((p) => { const f = farmOf(p.row); return farmStampRow({ draftId: p.d.draftId, seedRecId: f.seedRecId, potRecId: f.potRecId, seedVersion: f.seedVersion, batch: `R${date}`, verdict: p.fresh ? 'Pending' : null }); }));
      for (const p of pots) console.log(`${p.id}: farm stamp, pot of ${farmOf(p.row).potOf} v${farmOf(p.row).seedVersion}`);
      const withPot = pots.filter((p) => p.fresh && farmOf(p.row).potRecId);
      if (withPot.length) {
        try { await at.update('Pots', withPot.map((p) => ({ id: farmOf(p.row).potRecId, fields: { Status: 'Planted' } }))); console.log(`Pots rows set Planted: ${withPot.length}`); }
        catch (e) { console.log(`Pots rows NOT set Planted for ${withPot.map((p) => p.id).join(', ')} (UNVERIFIED, the plants are stamped): ${String(e.message).slice(0, 120)}`); }
      }
    } catch (e) { console.log(`FARM STAMP FAILED for ${pots.map((p) => p.id).join(', ')} (UNVERIFIED, link these plants to their seeds by hand): ${String(e.message).slice(0, 120)}`); }
  }
  const logFile = arg(argv, 'log');
  if (logFile) {
    const log = readJson(logFile);
    for (const p of done) {
      if (log.rows.some((r) => r.draftId === p.d.draftId)) continue;
      log.rows.push({ date, account: p.account, arm: p.row.group, draftId: p.d.draftId, socialSetId: p.d.socialSetId, publishAt: `${date}T${p.row.slot}:00Z`, heavyAsin: p.row.asins[0], lightAsin: p.row.asins[1] || null, extraAsins: p.row.asins.slice(2), ok: !readback[p.id].problems.length, linkArm: geni ? 'geni' : 'plain', ...(BL.laneOf(p.account, lanes) && p.row.asins.some((a) => brandOf(p.account)(a)) ? { brandLane: BL.laneOf(p.account, lanes).id } : {}), aboutMe: true, boost: p.row.boost, donor: p.row.donor, ...farmLog(p.row), ...planLog(work, p.account) });
    }
    fs.writeFileSync(logFile, JSON.stringify(log, null, 1));
  }
  console.log(`${done.length - bad} of ${done.length} scheduled and read back clean${skipped ? ` · ${skipped} row(s) NOT scheduled` : ''}`);
  return bad || skipped ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (!['check', 'prepare', 'ship'].includes(cmd)) {
    console.error('usage: node scripts/hand-run.mjs check|prepare|ship --work DIR --date YYYY-MM-DD [--review DIR] [--accept id,id] [--no-media] [--dry] [--no-geni] [--log FILE]');
    return 2;
  }
  const ctx = load(argv);
  if (cmd === 'check') return printCheck(await check(ctx), { shared: argv.includes('--shared'), only: arg(argv, 'only') }) ? 1 : 0;
  if (cmd === 'prepare') return prepare(ctx, argv);
  return ship(ctx, argv);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
