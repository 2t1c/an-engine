// The config layer. Everything buyer-specific lives in config/*.json in the buyer's clone:
// engine.json (buyer, posting window, profit share, features), pages.json (the X pages) and
// products.json (the shelf). The engine repo ships only the *.example.json files.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');
export const CONFIG_FILES = ['engine', 'pages', 'products'];
export const RT_LANES = ['ladder', 't0-only', 'none'];
export const PRODUCT_SLOTS = ['heavy', 'light'];
export const COSTS = ['rtVendors', 'rapidapi', 'typefully', 'hosting', 'levantaFees'];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/** PURE. Problems in engine.json, as readable lines. Empty means valid. */
export function validateEngine(c) {
  const e = [];
  if (!isObj(c)) return ['engine: not an object'];
  if (!isObj(c.buyer) || !isStr(c.buyer.name)) e.push('engine.buyer.name: required');
  if (!isObj(c.buyer) || !isStr(c.buyer.timezone)) e.push('engine.buyer.timezone: required (IANA name, e.g. Asia/Saigon)');
  else {
    try { new Intl.DateTimeFormat('en-US', { timeZone: c.buyer.timezone }); } catch { e.push(`engine.buyer.timezone: unknown time zone ${c.buyer.timezone}`); }
  }
  const p = c.posting;
  if (!isObj(p)) e.push('engine.posting: required');
  else {
    for (const k of ['windowStart', 'windowEnd', 'heavyClusterStart', 'heavyClusterEnd']) {
      if (!HHMM.test(String(p[k] ?? ''))) e.push(`engine.posting.${k}: HH:MM required`);
    }
    if (HHMM.test(String(p.windowStart)) && HHMM.test(String(p.windowEnd)) && p.windowStart >= p.windowEnd) e.push('engine.posting: windowStart must be before windowEnd');
    if (!Number.isInteger(p.threadsPerPagePerDay) || p.threadsPerPagePerDay < 1 || p.threadsPerPagePerDay > 5) e.push('engine.posting.threadsPerPagePerDay: whole number 1-5');
  }
  const s = c.profitShare;
  if (!isObj(s)) e.push('engine.profitShare: required');
  else {
    if (typeof s.operatorPct !== 'number' || !(s.operatorPct >= 0 && s.operatorPct <= 100)) e.push('engine.profitShare.operatorPct: number 0-100');
    if (!Array.isArray(s.costs)) e.push('engine.profitShare.costs: list required');
    else for (const k of s.costs) if (!COSTS.includes(k)) e.push(`engine.profitShare.costs: unknown cost ${k} (known: ${COSTS.join(', ')})`);
  }
  if (!isObj(c.features)) e.push('engine.features: required');
  else for (const k of ['rtLadder', 'hookClips']) if (typeof c.features[k] !== 'boolean') e.push(`engine.features.${k}: true or false`);
  if (!isObj(c.swipe) || typeof c.swipe.copyDaily !== 'boolean') e.push('engine.swipe.copyDaily: true or false');
  return e;
}

/** PURE. Problems in pages.json. */
export function validatePages(c) {
  const e = [];
  if (!isObj(c) || !Array.isArray(c.pages)) return ['pages: { "pages": [...] } required'];
  const seen = new Set();
  c.pages.forEach((p, i) => {
    const at = `pages[${i}]`;
    if (!isObj(p)) { e.push(`${at}: not an object`); return; }
    if (!/^[a-z0-9-]+$/.test(String(p.id ?? ''))) e.push(`${at}.id: lowercase letters, digits and dashes`);
    else if (seen.has(p.id)) e.push(`${at}.id: duplicate ${p.id}`);
    else seen.add(p.id);
    if (!isStr(p.name)) e.push(`${at}.name: required`);
    if (!/^[A-Za-z0-9_]{1,15}$/.test(String(p.handle ?? ''))) e.push(`${at}.handle: X handle without @`);
    if (!['m', 'f'].includes(p.persona)) e.push(`${at}.persona: "m" or "f"`);
    if (!Number.isInteger(p.typefullySocialSetId) || p.typefullySocialSetId < 0) e.push(`${at}.typefullySocialSetId: whole number`);
    if (p.active === true && p.typefullySocialSetId === 0) e.push(`${at}: an active page needs its real typefullySocialSetId`);
    if (!/^[a-z0-9-]+$/.test(String(p.levantaSubidPrefix ?? ''))) e.push(`${at}.levantaSubidPrefix: lowercase letters, digits and dashes`);
    if (!RT_LANES.includes(p.rtLane)) e.push(`${at}.rtLane: one of ${RT_LANES.join(', ')}`);
    if (typeof p.active !== 'boolean') e.push(`${at}.active: true or false`);
    if (p.niches !== undefined && (!Array.isArray(p.niches) || p.niches.some((n) => !isStr(n)))) e.push(`${at}.niches: list of niche names`);
    if (p.voice !== undefined && !isStr(p.voice) && !(Array.isArray(p.voice) && p.voice.every(isStr))) e.push(`${at}.voice: text or list of lines`);
    if (p.active === true) for (const k of ['voice', 'closing', 'disclaimer']) if (!p[k] || (Array.isArray(p[k]) && !p[k].length)) e.push(`${at}.${k}: required on an active page`);
    if (p.defaultProduct !== undefined && (!isObj(p.defaultProduct) || !/^B0[A-Z0-9]{8}$/.test(String(p.defaultProduct.asin ?? '')))) e.push(`${at}.defaultProduct: { asin, title }`);
  });
  const texts = (k) => c.pages.filter((p) => isObj(p) && isStr(p[k])).map((p) => p[k].trim());
  for (const k of ['closing', 'disclaimer']) {
    const t = texts(k);
    if (new Set(t).size !== t.length) e.push(`pages: two pages share one ${k}; every page writes its own`);
  }
  return e;
}

/** PURE. Problems in products.json. */
export function validateProducts(c) {
  const e = [];
  if (!isObj(c) || !Array.isArray(c.products)) return ['products: { "products": [...] } required'];
  const seen = new Set();
  c.products.forEach((p, i) => {
    const at = `products[${i}]`;
    if (!isObj(p)) { e.push(`${at}: not an object`); return; }
    if (!/^B0[A-Z0-9]{8}$/.test(String(p.asin ?? ''))) e.push(`${at}.asin: Amazon ASIN (B0 + 8)`);
    else if (seen.has(p.asin)) e.push(`${at}.asin: duplicate ${p.asin}`);
    else seen.add(p.asin);
    if (!isStr(p.name)) e.push(`${at}.name: required`);
    if (!isStr(p.substance)) e.push(`${at}.substance: required`);
    if (!Array.isArray(p.slots) || p.slots.length === 0 || p.slots.some((s) => !PRODUCT_SLOTS.includes(s))) e.push(`${at}.slots: one or more of ${PRODUCT_SLOTS.join(', ')}`);
    if (p.prime !== true && p.active === true) e.push(`${at}: an active product must be Prime / ships from Amazon`);
    if (typeof p.active !== 'boolean') e.push(`${at}.active: true or false`);
  });
  return e;
}

const VALIDATORS = { engine: validateEngine, pages: validatePages, products: validateProducts };

/**
 * Load and validate the buyer's config. Throws one error listing every problem.
 * @param {{ dir?: string, examples?: boolean }} opts examples: read *.example.json (engine repo checks and tests only)
 */
export function loadConfig({ dir = CONFIG_DIR, examples = false } = {}) {
  const out = {};
  const problems = [];
  for (const name of CONFIG_FILES) {
    const file = join(dir, examples ? `${name}.example.json` : `${name}.json`);
    if (!existsSync(file)) {
      problems.push(`${file}: missing${examples ? '' : ` (copy config/${name}.example.json and fill it in)`}`);
      continue;
    }
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { problems.push(`${file}: not valid JSON (${err.message})`); continue; }
    problems.push(...VALIDATORS[name](data));
    out[name] = data;
  }
  if (problems.length) throw new Error(`config has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return /** @type {{ engine: any, pages: any, products: any }} */ (out);
}

/** The pages that post today. */
export const activePages = (cfg) => cfg.pages.pages.filter((p) => p.active);
