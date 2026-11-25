#!/usr/bin/env node
// published-feed.mjs — refill the Airtable "Published Feed" from Typefully.
//
// The feed is written live by the n8n "Published Feed" workflow on Typefully's draft.published webhook (see
// docs/published-feed.md). Typefully never replays a missed delivery, so this is the repair path: it lists
// every social set's published drafts for the last N days and runs the REAL node code
// (docs/feed-nodes/Build-Feed-Row.js) on each one, so a refilled row is exactly what the webhook would have
// written. Rows are upserted on "Draft ID": refilling a day the webhook already covered changes nothing but
// Source and Received At.
//
//   node published-feed.mjs backfill            # dry: last 3 days, every social set, prints what it would write
//   node published-feed.mjs backfill --days 7 --apply
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR, cliArg } from './lib.mjs';

export const FEED_BASE = 'app4Orfi56ghELGix';
export const FEED_TABLE = 'tblb1d6l3byAMYdDd';
const NODE_SRC = () => readFileSync(join(HERE_DIR, 'docs', 'feed-nodes', 'Build-Feed-Row.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Run the live node's code for one published draft. `get(path)` is a Typefully v2 GET. Returns the row or null. */
export async function feedRow({ draftId, socialSetId, username = '', token, get, src = NODE_SRC() }) {
  const body = { event: 'draft.published', draft: { id: draftId, social_set_id: socialSetId, username } };
  const nodes = { 'Typefully Webhook': [{ json: { body } }], 'Get Feed Config': [{ json: { Name: 'Typefully', Token: token } }] };
  const $ = (name) => ({ all: () => nodes[name], first: () => nodes[name][0] });
  const http = async (req) => get(String(req.url).replace('https://api.typefully.com/v2', ''));
  const out = await new AsyncFunction('$input', '$', src).call({ helpers: { httpRequest: http } }, { all: () => [] }, $);
  return out[0] ? out[0].json : null;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'AIRTABLE_PAT']);
  const [cmd] = process.argv.slice(2);
  if (cmd !== 'backfill') { console.error('usage: node published-feed.mjs backfill [--days N] [--apply]'); process.exit(2); }
  const days = Number(cliArg('days', 3));
  const apply = process.argv.includes('--apply');
  const tf = typefully(env);
  const cutoff = Date.now() - days * 86400000;
  const sets = await tf.listAll('/social-sets', { limit: 50 });
  const rows = [];
  for (const s of sets) {
    for (let offset = 0; ; offset += 50) {
      const page = await tf.listPage(`/social-sets/${s.id}/drafts?status=published&order_by=-published_at`, { limit: 50, offset });
      let older = false;
      for (const d of page.items) {
        if (Date.parse(d.published_at || 0) < cutoff) { older = true; break; }
        const row = await feedRow({ draftId: d.id, socialSetId: s.id, username: s.username, token: env.TYPEFULLY_API_KEY, get: (p) => tf.get(p) });
        if (row) rows.push({ ...row, Source: 'backfill' });
      }
      if (older || !page.next) break;
    }
  }
  const kinds = rows.reduce((m, r) => ((m[r.Kind] = (m[r.Kind] || 0) + 1), m), {});
  console.log(`${sets.length} social sets · ${rows.length} published draft(s) in the last ${days}d · ${JSON.stringify(kinds)}`);
  if (!apply) { console.log('(dry — pass --apply to upsert into Published Feed)'); return; }
  for (let i = 0; i < rows.length; i += 10) {
    const res = await fetch(`https://api.airtable.com/v0/${FEED_BASE}/${FEED_TABLE}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['Draft ID'] }, typecast: true, records: rows.slice(i, i + 10).map((fields) => ({ fields })) }),
    });
    if (!res.ok) throw new Error(`Published Feed upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  console.log(`✓ upserted ${rows.length} row(s) into Published Feed`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runMain(main);
