// brand-lanes.mjs: pages that plug one brand's products only, through that brand's own links.
//
// Owner 2026-11-21: "Let's start with EAAs, Beef Organs and Berberine. I think we should dedicate 3
// accounts to push these products completely." Ultimate Health (Theta Brands) pays its Levanta rate + 10%
// off Levanta, monthly, on ONE Amazon Attribution link per product. So on a lane page:
//   - heavy and light both come from the lane's products (planIssues in plug-plan.mjs);
//   - batch-mint puts the lane's geni.us link on the plug instead of minting a Levanta link;
//   - a product whose Buy Box is not verified Prime is held, like any other test product (owner 2026-11-07).
// Every other page keeps these products on Levanta as before.
//
// The geni.us links wrap the brand's attribution URL with the US-only rule (geni-swap's group 445606).
// Live 2026-11-21: each 302s to amazon.com with the brand's maas_adg id intact; tag=maas is dropped, the
// same as on our Levanta links.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE_DIR } from './lib.mjs';

export function loadLanes(file = join(HERE_DIR, 'brand-lanes.json')) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('_')));
}

const key = (account) => String(account || '').toLowerCase().replace(/^@/, '');

/** PURE. The lane a page belongs to, as { id, ...lane }, or null. */
export function laneOf(account, lanes) {
  for (const [id, lane] of Object.entries(lanes || {})) if ((lane.pages || []).map(key).includes(key(account))) return { id, ...lane };
  return null;
}

/** PURE. The brand link for this page and product, or null when the page is not on that brand's lane. */
export function brandLinkFor(account, asin, lanes) {
  const lane = laneOf(account, lanes);
  const p = lane?.products?.[String(asin || '').toUpperCase()];
  return p ? { lane: lane.id, link: p.glink, attributionUrl: p.attributionUrl } : null;
}

/** PURE. Lane findings for a page's heavy and light ASINs (empty when the page is not on a lane). */
export function laneIssues(account, asins, lanes) {
  const lane = laneOf(account, lanes);
  if (!lane) return [];
  const out = [];
  ['heavy', 'light'].forEach((role, i) => {
    const a = String(asins?.[i] || '').toUpperCase();
    if (!a) return;
    const p = lane.products?.[a];
    if (!p) out.push(`${role} ${a}: ${account} is a ${lane.brand} page and plugs only ${Object.values(lane.products).map((x) => x.name).join(', ')}`);
    else if (p.prime !== 'verified') out.push(`${role} ${p.name} ${a}: Prime not verified (${p.primeNote || 'unchecked'}); hold until the owner confirms it ships from Amazon`);
  });
  return out;
}

/** PURE. True when a lane page can carry only ONE plug today: fewer than two of its products are
 *  Prime-verified, so there is no second product to put in a light CTA (owner 2026-11-21 brief default:
 *  "brand pages ship berberine heavy only, no light" while EAAs and Beef Organs are unconfirmed).
 *  The gates read the page as the one-ask arm instead of failing it for a missing light plug. */
export function singleCtaLane(account, lanes) {
  const lane = laneOf(account, lanes);
  if (!lane) return false;
  return Object.values(lane.products || {}).filter((p) => p.prime === 'verified').length < 2;
}
