// product-fit.mjs — Jev reads a cover donor and says which candidate products the thread itself
// argues for. REPORT-ONLY (operator 2026-09-23, "let's try with product selection first"): the
// canonical picker (preflight commitSlateProducts: BRIDGE regex -> EPC x spread) still chooses; this
// puts a second, semantic reading beside it at the products stop so the two can be compared on real
// runs before Jev is allowed to move a placement. Nothing here changes a row's status or flags.
//
// Shape (docs/typesafe-jev.md; TypeSafe re-ranking pattern): ONE Noul per candidate over the same
// state, all in one call, then code sorts and thresholds. Money arithmetic (EPC, spread, caps) stays
// in code — Jev only answers "does this thread argue for X". Candidates are named by substance, not by
// the Amazon title, because jev-1.13 reads literally and a 200-character listing title is noise.
//
//   node product-fit.mjs --trial [--limit 12] [--days 30]   # live donors from the swipe DB, read-only
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeableProducts, SYMPTOM_TERMS, substanceTermsFor, tweetsFromRollup } from './checks.mjs';
import { choice, jev, noul } from './jev.mjs';

// Above this a candidate counts as argued. Report-only, so it only decides which notes print; tune it
// against operator verdicts at the products stop before it is ever used to move a placement.
export const PRODUCT_FIT_THRESHOLD = 0.5;
// A heavy placement Jev reads this far below a rival candidate is worth the operator's second look.
export const PRODUCT_FIT_MARGIN = 0.2;
export const PRODUCT_FIT_MAX_CANDIDATES = 12;
const STATE_MAX_CHARS = 20000; // well inside jev-1.13's 32k-token state budget

/** The words a candidate is asked about: its substance terms minus symptom words, else its category. */
export function candidateLabel(product = {}) {
  const symptoms = new Set(SYMPTOM_TERMS[product.asin] || []);
  const terms = [...substanceTermsFor(product)].filter((t) => !symptoms.has(t));
  // Shortest first: the generic name ("magnesium") leads its forms ("magnesium glycinate"). jev-1.13
  // reads literally, so a label led by the specific form scored a thread that only says "magnesium"
  // as not arguing it (trial 2026-09-23, T10: 0.24 on a thread whose own CTA was magnesium).
  const named = [...new Set(terms)].sort((a, b) => a.length - b.length).slice(0, 3);
  if (named.length) return named.join(' or ');
  const category = String(product.category || '').trim();
  if (category) return category;
  return String(product.title || product.asin || '').split(/\s[-|,]\s|,/)[0].slice(0, 60);
}

/** Candidates for one donor: the proposed placements first, then every product its text bridges. */
export function fitCandidates(donorText, products, proposedAsins = []) {
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const asins = [...new Set([...proposedAsins, ...bridgeableProducts(donorText)])].filter((a) => byAsin.has(a));
  return asins.slice(0, PRODUCT_FIT_MAX_CANDIDATES).map((asin) => ({ asin, label: candidateLabel(byAsin.get(asin)) }));
}

// The reviewable question set: one Noul per candidate plus a presence Noul, the "no-match" of this
// shape (a thread that recommends nothing makes every candidate a stretch).
export function productFitQuestions(candidates) {
  const questions = {
    any_supplement: noul('Does this thread recommend that the reader take a supplement or buy a health product?', {
      true: 'The thread tells the reader to take or use at least one supplement, food product or health product.',
      false: 'The thread only explains a mechanism, habit or lifestyle change and recommends no product to take.',
    }),
  };
  candidates.forEach((c, i) => {
    questions[`fit_${i}`] = noul(`Does this thread argue that the reader should take ${c.label}, in any form or brand?`, {
      true: `The thread recommends ${c.label} in any form or brand, or explains how it helps with the problem the thread is about.`,
      false: `${c.label} is not mentioned, is only named in passing or in a list without being argued for, or is discouraged.`,
    });
  });
  return questions;
}

/** One Jev call for one donor. Returns candidates sorted by noul, highest first. */
export async function judgeProductFit(client, donorText, candidates, { role = 'product-fit' } = {}) {
  const started = Date.now();
  const { askThrough } = await import('./jev-decide.mjs');
  const result = await askThrough('product-fit-read', client, { state: String(donorText || '').slice(0, STATE_MAX_CHARS), questions: productFitQuestions(candidates) }, { role });
  const scored = candidates.map((c, i) => ({ ...c, noul: result.answers[`fit_${i}`]?.noul ?? null }))
    .sort((a, b) => (b.noul ?? -1) - (a.noul ?? -1));
  return { model: result.model, ms: Date.now() - started, usage: result.usage,
    anySupplement: result.answers.any_supplement?.noul ?? null, candidates: scored };
}

// ---- the WHY pointer (plan R2/C): which donor tweet argues for each placed product ---------------------
// A second, separate call so the fit reading above stays exactly the question set it was trialled with.
// Jev points at a tweet by name and code quotes it into the note (thread-note donorLinesFor), so the
// evidence always exists in the donor. Tweets are numbered exactly as the note numbers them
// (tweetsFromRollup of the same Full Thread Text).
export const POINTER_MIN_CONFIDENCE = 0.5;
export function pointerQuestions(tweets, candidates) {
  const options = { ...Object.fromEntries(tweets.map((_, i) => [`T${i + 1}`, null])), none: 'No tweet argues for it.' };
  return Object.fromEntries(candidates.map((c, i) => [`where_${i}`,
    choice(`Which tweet argues most directly that the reader should take ${c.label}?`, options)]));
}
export async function pointProducts(client, donorText, candidates, { role = 'product-fit-pointer' } = {}) {
  const tweets = tweetsFromRollup(String(donorText || '')).slice(0, 25);
  if (tweets.length < 2 || !candidates.length) return candidates.map(() => null);
  const state = { tweets: Object.fromEntries(tweets.map((t, i) => [`T${i + 1}`, t])) };
  const { askThrough } = await import('./jev-decide.mjs');
  const result = await askThrough('product-pointer-read', client, { state, questions: pointerQuestions(tweets, candidates) }, { role });
  return candidates.map((_, i) => {
    const a = result.answers[`where_${i}`];
    if (!a?.choice || a.choice === 'none' || !(a.confidence >= POINTER_MIN_CONFIDENCE)) return null;
    return { tweet: Number(a.choice.slice(1)), confidence: a.confidence };
  });
}

const pct = (x) => (x == null ? 'n/a' : x.toFixed(2));

/** Compare Jev's reading with the proposed placements. Pure; notes are for the operator. */
export function fitVerdict(fit, placements = []) {
  const byAsin = new Map(fit.candidates.map((c) => [c.asin, c]));
  const proposed = placements.map((p) => ({ placement: p.placement, asin: p.asin, label: byAsin.get(p.asin)?.label || p.asin,
    noul: byAsin.get(p.asin)?.noul ?? null, needsBridge: !!p.needsBridge }));
  const notes = [];
  if (fit.anySupplement != null && fit.anySupplement < PRODUCT_FIT_THRESHOLD) notes.push(`thread may not recommend any product (${pct(fit.anySupplement)})`);
  // Heavy and light only: placements past the second are reviewed separately at the products stop.
  // A light the picker already marked needsBridge is EXPECTED to be unargued by the donor (the writer
  // builds that bridge), so it is noted as such rather than as a disagreement.
  for (const p of proposed.filter((x) => x.placement === 'heavy' || x.placement === 'light')) {
    if (p.noul == null || p.noul >= PRODUCT_FIT_THRESHOLD) continue;
    if (p.needsBridge && p.placement === 'light') continue;
    notes.push(`${p.placement} "${p.label}" is weakly argued (${pct(p.noul)})`);
  }
  const heavy = proposed.find((p) => p.placement === 'heavy');
  const rival = fit.candidates.find((c) => !proposed.some((p) => p.asin === c.asin));
  if (heavy?.noul != null && rival?.noul != null && rival.noul >= PRODUCT_FIT_THRESHOLD && rival.noul - heavy.noul >= PRODUCT_FIT_MARGIN) {
    notes.push(`thread argues "${rival.label}" more than the heavy (${pct(rival.noul)} vs ${pct(heavy.noul)})`);
  }
  return { agrees: notes.length === 0, notes, proposed };
}

/**
 * Attach a report-only `jev` block to every cover row of a product-review plan. Never throws for a
 * provider failure: a row Jev could not read says so, and the plan stands exactly as the picker made it.
 */
export async function attachProductFit(plan, rows, products, client, { concurrency = 4, unavailableReason = null } = {}) {
  const donors = new Map(rows.filter((r) => r.lane === 'cover' && r.donor?.text).map((r) => [r.id, r.donor.text]));
  const targets = plan.rows.filter((r) => donors.has(r.id));
  let next = 0;
  const work = async () => {
    while (next < targets.length) {
      const row = targets[next++];
      // No client (no key): every row says so in its packet rather than silently losing the section.
      if (!client) { row.jev = { status: 'unavailable', reason: unavailableReason || 'no Jev client' }; continue; }
      const candidates = fitCandidates(donors.get(row.id), products, row.placements.map((p) => p.asin));
      if (!candidates.length) { row.jev = { status: 'skipped', reason: 'no catalog candidates' }; continue; }
      try {
        const fit = await judgeProductFit(client, donors.get(row.id), candidates);
        // The pointer is best-effort: without it the note falls back to a text match, never to nothing.
        const placed = fit.candidates.filter((c) => row.placements.some((p) => p.asin === c.asin && ['heavy', 'light'].includes(p.placement)));
        try {
          const points = await pointProducts(client, donors.get(row.id), placed);
          placed.forEach((c, i) => { if (points[i]) { c.pointer = points[i].tweet; c.pointerConfidence = points[i].confidence; } });
        } catch { /* fit stands; the note says "text match" */ }
        row.jev = { status: 'ok', model: fit.model, ms: fit.ms, anySupplement: fit.anySupplement,
          candidates: fit.candidates, ...fitVerdict(fit, row.placements) };
      } catch (error) {
        row.jev = { status: 'unavailable', code: error.code || 'client_error' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, work));
  const read = targets.filter((r) => r.jev?.status === 'ok');
  plan.jevFit = { mode: 'report-only', threshold: PRODUCT_FIT_THRESHOLD, rows: targets.length, read: read.length,
    agrees: read.filter((r) => r.jev.agrees).length, unavailable: targets.filter((r) => r.jev?.status === 'unavailable').length };
  return plan;
}

/** Markdown lines for a products packet. Empty when the row was not read. */
export function productFitLines(jevBlock) {
  if (!jevBlock) return [];
  if (jevBlock.status !== 'ok') return ['## Jev fit (report-only)', `- Not read: ${jevBlock.reason || jevBlock.code}`, ''];
  return ['## Jev fit (report-only)',
    `- Model: ${jevBlock.model} · any product recommended: ${pct(jevBlock.anySupplement)}`,
    ...jevBlock.candidates.map((c) => `- ${pct(c.noul)} ${c.label} (${c.asin})${jevBlock.proposed.find((p) => p.asin === c.asin) ? ` ← ${jevBlock.proposed.find((p) => p.asin === c.asin).placement}` : ''}`),
    `- Reading: ${jevBlock.agrees ? 'agrees with the proposed placements' : jevBlock.notes.join('; ')}`, ''];
}

// --trial: live donors from the swipe DB through the canonical screen and picker, then Jev beside it.
// Read-only: Airtable reads, one metered Jev call per donor, nothing written anywhere.
async function trial() {
  const { loadEnv, airtable, HERE_DIR, llmSpendSummary } = await import('./lib.mjs');
  const { TABLES } = await import('./config.mjs');
  const { LAWS } = await import('./laws.mjs');
  const { ACCOUNTS } = await import('./accounts.mjs');
  const { screenDonor, commitSlateProducts } = await import('./preflight.mjs');
  const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? d : Number(process.argv[i + 1]); };
  const limit = arg('limit', 12), days = arg('days', LAWS.selection?.viralWindowDays ?? 30);
  const env = loadEnv();
  const client = jev(env);
  const products = JSON.parse(readFileSync(join(HERE_DIR, 'products.json'), 'utf8')).products;
  const floor = LAWS.selection?.viewFloor ?? 250000;
  const pool = await airtable(env).listAll(TABLES.swipe, {
    formula: `AND({Tweet Number}=1,{Thread Length}>=3,NOT({Quoted Junk}),NOT({Single Tweet}),{Impressions}>=${floor},IS_AFTER({Published Date},DATEADD(NOW(),-${days},"days")))`,
    fields: ['Text', 'Impressions', 'Published Date', 'Thread Length', 'Full Thread Text'], pageSize: 100,
  });
  const donors = pool.map((r) => screenDonor({ ...r.fields, recId: r.id }, { products })).filter((d) => d.usable)
    .sort((a, b) => b.views - a.views).slice(0, limit);
  const accounts = Object.entries(ACCOUNTS).filter(([, a]) => a.plugHeavyExample && !a.paused).map(([k]) => k);
  const slate = donors.map((donor, i) => ({ account: accounts[i % accounts.length], donor: { ...donor } }));
  commitSlateProducts(slate, products, { testProducts: [] });
  const plan = { rows: slate.map((s, i) => ({ id: `T${String(i + 1).padStart(2, '0')}`, lane: 'cover',
    placements: (s.products || []).map((p, j) => ({ asin: p.asin, needsBridge: !!p.needsBridge, placement: j === 0 ? 'heavy' : j === 1 ? 'light' : `extra-${j + 1}` })) })) };
  const rows = plan.rows.map((r, i) => ({ id: r.id, lane: 'cover', donor: donors[i] }));
  await attachProductFit(plan, rows, products, client);
  console.log(`Jev product fit · trial · ${pool.length} swipe rows, ${donors.length} usable donors read (report-only)\n`);
  for (const [i, row] of plan.rows.entries()) {
    console.log(`${row.id} ${donors[i].hook}`);
    if (row.jev?.status !== 'ok') { console.log(`   Jev: ${row.jev?.reason || row.jev?.code}\n`); continue; }
    for (const c of row.jev.candidates) {
      const p = row.jev.proposed.find((x) => x.asin === c.asin);
      console.log(`   ${pct(c.noul)}  ${c.label}${p ? `  ← picker ${p.placement}` : ''}`);
    }
    console.log(`   ${row.jev.agrees ? '✓ agrees' : `≠ ${row.jev.notes.join('; ')}`} · ${row.jev.ms}ms\n`);
  }
  const spend = llmSpendSummary();
  console.log(`read ${plan.jevFit.read}/${plan.jevFit.rows} · agrees ${plan.jevFit.agrees} · unavailable ${plan.jevFit.unavailable} · spend $${spend.costUsd} (${spend.basis})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--trial')) { console.error('usage: node product-fit.mjs --trial [--limit 12] [--days 30]'); process.exit(1); }
  await trial().catch((error) => { console.error(`product-fit trial failed: ${error.message}`); process.exit(1); });
}
