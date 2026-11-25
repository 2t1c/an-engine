// topic-intent.mjs — builds learnings/topic-intent.json: realized ORDERS PER CLICK by topic.
//
// The operator's thesis (2026-08-17, confirmed on the three EPC-spike days): some topics select
// READERS WHO BUY — the person who clicks into a cortisol or magnesium thread is already in a
// buy-curious mindset, and Amazon session baskets mean that intent pays beyond the plugged product
// (Jul 30-Aug 2: 25 conversions across ~20 ASINs on 271 clicks, most never plugged by us).
// Orders/clicks is the purest intent signal we have: it strips product price and commission out and
// asks only "did the people this topic attracted actually buy anything".
//
// Joins Published Content (orders + affiliate clicks per draft) to the ledger's topic stamp.
// Output feeds intentFactor() in checks.mjs, which selection multiplies in.
//   node topic-intent.mjs          # rebuild learnings/topic-intent.json + print
//   node topic-intent.mjs --dry    # print only
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, runMain, HERE_DIR } from './lib.mjs';
import { classifyTopic } from './pick-product.mjs';
import { createResolver } from './stamps.mjs';

const DRY = process.argv.includes('--dry');
const MIN_CLICKS = Number(process.env.TOPIC_INTENT_MIN_CLICKS ?? 100); // below this a topic's rate is noise

// Pure core: rows of { topic, clicks, orders } -> { topics: { topic: { clicks, orders, opc } }, fleet }
export function buildIntentTable(rows, { minClicks = MIN_CLICKS } = {}) {
  const agg = new Map();
  let clicks = 0, orders = 0;
  for (const r of rows) {
    if (!r?.topic || r.topic === 'general') continue;
    const a = agg.get(r.topic) || { clicks: 0, orders: 0 };
    a.clicks += Number(r.clicks) || 0;
    a.orders += Number(r.orders) || 0;
    agg.set(r.topic, a);
    clicks += Number(r.clicks) || 0;
    orders += Number(r.orders) || 0;
  }
  const fleet = clicks ? orders / clicks : 0;
  const topics = {};
  for (const [t, a] of agg) {
    topics[t] = { clicks: a.clicks, orders: a.orders, opc: a.clicks ? Number((a.orders / a.clicks).toFixed(4)) : 0, measured: a.clicks >= minClicks };
  }
  return { fleet: Number(fleet.toFixed(4)), minClicks, topics };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT']);

  // draftId -> topic from the ledger (last stamp wins, matching registry-sync)
  const topicOf = new Map();
  for (const l of readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(l); if (e.draftId && e.topic) topicOf.set(String(e.draftId), e.topic); } catch {}
  }

  const stamps = createResolver();
  const rows = [];
  let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${env.REGISTRY_BASE_ID || 'app4Orfi56ghELGix'}/${encodeURIComponent('Published Content')}`);
    u.searchParams.set('pageSize', '100');
    ['Draft ID', 'Orders', 'Affiliate Clicks', 'Link Clicks', 'Post'].forEach((f) => u.searchParams.append('fields[]', f));
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!r.ok) throw new Error(`registry -> ${r.status}`);
    const j = await r.json();
    for (const rec of j.records) {
      const f = rec.fields;
      const draft = String(f['Draft ID'] || '');
      // topic (plan v7 N3 consumer switch): Jev's back-stamp through the one resolver when one clears
      // its floor (stamps.mjs), else the ledger (generation-time truth), else classify the stored hook.
      const stamped = stamps.resolve('topic', draft);
      const topic = (stamped.source === 'stamp' ? stamped.value : null) || topicOf.get(draft) || classifyTopic(f.Post || '');
      // Affiliate Clicks (Levanta-deduped) preferred; blank means no tracked link, skip — Link
      // Clicks would count every URL in the thread and dilute the rate.
      const clicks = Number(f['Affiliate Clicks']);
      if (!Number.isFinite(clicks) || clicks <= 0) continue;
      rows.push({ topic, clicks, orders: Number(f.Orders) || 0 });
    }
    offset = j.offset;
  } while (offset);

  const table = buildIntentTable(rows);
  console.log(`fleet orders/click: ${(table.fleet * 100).toFixed(2)}% over ${rows.length} monetized threads\n`);
  for (const [t, a] of Object.entries(table.topics).sort((x, y) => y[1].opc - x[1].opc)) {
    console.log(`${t.padEnd(13)} ${(a.opc * 100).toFixed(2).padStart(6)}%  ${String(a.orders).padStart(4)} orders / ${String(a.clicks).padStart(6)} clicks ${a.measured ? '' : ' (below floor — scores neutral)'}`);
  }
  if (DRY) return;
  mkdirSync(join(HERE_DIR, 'learnings'), { recursive: true });
  writeFileSync(join(HERE_DIR, 'learnings', 'topic-intent.json'), JSON.stringify({ ts: new Date().toISOString(), ...table }, null, 1) + '\n');
  console.log('\n→ learnings/topic-intent.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'topic-intent');
