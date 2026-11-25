#!/usr/bin/env node
// scripts/x-premium.mjs — which fleet pages can publish X Articles (X Premium, read as the account's
// blue verification), written to queues/x-premium.json for the article lane (laws.json `articles`).
//
// Owner, R2026-10-03: "Every account should do ≥2 articles a week". An X Article needs Premium, and nothing
// in the repo recorded which pages have it (accounts.mjs only says paused). One read per page through the
// same RapidAPI X host the rest of the repo uses; a page whose read fails is `null` (unknown), never false.
//
//   node scripts/x-premium.mjs            # read every active page, write queues/x-premium.json
//   node scripts/x-premium.mjs --dry      # print only
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PREMIUM_FILE = join(ROOT, 'queues', 'x-premium.json');

/** The recorded premium read: { checkedAt, pages: { key: true|false|null } }, or null when never read. */
export function readPremium(file = PREMIUM_FILE) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** PURE. True when the record is younger than maxAgeDays at `now`. */
export function premiumFresh(record, maxAgeDays, now = Date.now()) {
  const at = Date.parse(record?.checkedAt || '');
  return Number.isFinite(at) && now - at <= maxAgeDays * 864e5;
}

/** PURE. One user payload (twitter241 /user) -> true | false | null. */
export function blueOf(payload) {
  const u = payload?.result?.data?.user?.result || payload?.data?.user?.result || null;
  return typeof u?.is_blue_verified === 'boolean' ? u.is_blue_verified : null;
}

export async function readPremiumLive(accounts, { key = process.env.RAPIDAPI_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw new Error('RAPIDAPI_KEY is not set: X Premium cannot be read');
  const pages = {};
  for (const [k, a] of Object.entries(accounts)) {
    if (!a.handle || !a.socialSetId || a.paused || a.burner || a.client) continue;
    try {
      const r = await fetchImpl(`https://twitter241.p.rapidapi.com/user?username=${encodeURIComponent(a.handle)}`,
        { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'twitter241.p.rapidapi.com' } });
      pages[k] = r.ok ? blueOf(await r.json()) : null;
    } catch { pages[k] = null; }
  }
  return { checkedAt: new Date().toISOString(), source: 'twitter241 /user is_blue_verified', pages };
}

async function main(argv) {
  const { ACCOUNTS } = await import('../accounts.mjs');
  const record = await readPremiumLive(ACCOUNTS);
  for (const [k, v] of Object.entries(record.pages)) console.log(`${k.padEnd(14)} ${v === true ? 'premium' : v === false ? 'NO premium' : 'unknown'}`);
  const n = Object.values(record.pages);
  console.log(`premium ${n.filter((v) => v === true).length} · no ${n.filter((v) => v === false).length} · unknown ${n.filter((v) => v == null).length}`);
  if (!argv.includes('--dry')) { writeFileSync(PREMIUM_FILE, `${JSON.stringify(record, null, 2)}\n`); console.log(`wrote ${PREMIUM_FILE}`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 2; });
}
