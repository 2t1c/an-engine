// fuel-send.mjs — buy ONE tier for ONE post by hand, exactly the way Fuel the Fire would.
//
// The ladder is a policy, and a policy sometimes says no to a post the operator can see is running.
// This is the manual override for that case. It does the same four things the workflow does, in the
// same order, so the post's history stays indistinguishable from an automatic fire:
//   1. bare link to each vendor group in the tier, via the Vendor Bot token (no thread id)
//   2. reports each delivered send to the bot's /vendor-rt, source "fuel-the-fire", so the vendor's
//      deal is metered and the reconcile still balances
//   3. appends the ledger lines to the post's Fuel Log row (tier · vendor · price · reach · ISO) AND
//      rewrites every field derived from them, so the row reads the same as an automatic fire
//   4. posts the same "Fuel Fired" card to the Fuel topic
//
// REFUSES to send a tier already on the post's ledger. That guard exists because the obvious way to
// misuse this is to re-send a tier the workflow already bought, which double-posts into the vendor's
// group and double-bills us.
//
// The workflow will NOT re-send behind us. This used to say the opposite — that its send-once memory
// is n8n static data we cannot reach, so a post re-qualifying in the workflow would be sent twice.
// True until 2026-09-07: the vendor dedup (#367) now asks the bot GET /vendor-sent for who already
// holds a thread, and step 2 above reports every hand delivery to the same bot, so the workflow sees
// our sends and skips those vendors. Verified 2026-09-09 — /vendor-sent listed Pammy and IP for two
// posts within seconds of a hand fire. The dedup fails OPEN, so this is a strong default and not a
// guarantee: on a post still inside the tier's window and still climbing, check the Fuel Log after.
//
//   node fuel-send.mjs --url https://x.com/H/status/123 --tier T2          # dry: prints, sends nothing
//   node fuel-send.mjs --url ... --tier T2 --send                          # fires
//   node fuel-send.mjs --url ... --tier T0 --missing [--send]              # only the tier's vendors not yet on the ledger
import { loadEnv, requireEnv, airtable, esc, logRun, runMain, cliArg } from './lib.mjs';
import { parseTierBreakdown, tweetId } from './facts-build.mjs';
import { configRows } from './fuel-ops-io.mjs';
import { routeNames, routeOf, tierOn } from './routing.mjs';

const tierOf = (f) => (typeof f.Tier === 'object' && f.Tier ? f.Tier.name : f.Tier) || '';
const clean = (n) => String(n).replace(/^Vendor\s[–-]\s/, '');

async function tg(token, chatId, text, threadId) {
  const body = { chat_id: chatId, text, disable_web_page_preview: false };
  if (threadId) body.message_thread_id = threadId;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok === true, detail: j.description || `HTTP ${r.status}` };
}

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID', 'REGISTRY_BASE_ID']);
  const url = cliArg('url', ''), tier = String(cliArg('tier', '')).toUpperCase();
  const live = process.argv.includes('--send');
  if (!url || !tier) throw new Error('need --url <post url> and --tier <T1..T5>');
  const tid = tweetId(url);
  if (!tid) throw new Error(`could not read a tweet id out of ${url}`);

  const reg = airtable(env, env.REGISTRY_BASE_ID);
  const row = (await reg.listAll('Fuel Log')).find((r) => String(r.fields['X URL'] || '').includes(tid));
  if (!row) throw new Error(`no Fuel Log row for ${tid} — the post is not in the ladder at all`);
  const already = new Set();
  for (const e of parseTierBreakdown(row.fields['Tier Breakdown'])) for (const t of e.tiers) if (t !== 'T?') already.add(t);
  // --missing: the tier IS on the ledger but some of its vendors were not (a route that left them off).
  // Sends only to this tier's vendors the ledger does not already name, so nothing is double-posted.
  const missing = process.argv.includes('--missing');
  const onLedger = new Set(parseTierBreakdown(row.fields['Tier Breakdown']).flatMap((e) => e.vendors));
  if (already.has(tier) && !missing) throw new Error(`${tier} is ALREADY on this post's ledger (has ${[...already].sort().join('+')}) — sending again would double-post and double-bill`);

  const cfg = (await configRows(env)).map((r) => r.fields || r);   // configRows yields raw records
  const byName = Object.fromEntries(cfg.map((f) => [f.Name, f]));
  const vbot = String((byName['Vendor Bot'] || {}).Token || '').trim();
  if (!vbot) throw new Error('Config "Vendor Bot" has no Token');
  // The post's LANE (v6, 2026-10-02): its account's lane in the "Vendor Routes" row, exactly as Fuel the
  // Fire draws it. A vendor's tier on that lane comes from its Routes text, so a Lane B post never buys
  // ME at T3 (ME is Lane B's T0) and Hey Brother is never bought on Lane A.
  const handle = (String(url).match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status\//) || [])[1] || '';
  const lane = routeOf(null, routeNames(cfg), handle);
  const nets = cfg.filter((f) => f.Active && /^Vendor\s[–-]\s/.test(String(f.Name || '')) && tierOn(tierOf(f), f.Routes, lane) === tier && String(f['Chat ID'] || '').trim())
    .filter((f) => !missing || !onLedger.has(clean(f.Name)));
  if (!nets.length) throw new Error(`no active vendor rows at tier ${tier}${lane ? ` on lane ${lane}` : ''}`);
  const isComment = (f) => /\bcomment\b/i.test(String(f.Name || ''));

  const cost = nets.reduce((s, f) => s + (Number(f.Price) || 0), 0);
  const reach = nets.reduce((s, f) => s + (Number(f['Network Size']) || 0), 0);
  console.log(`${live ? 'SENDING' : 'DRY RUN'} — ${tier} for ${row.fields.Account || tid}`);
  console.log(`  post      ${url}`);
  console.log(`  lane      ${lane || '(none — the plain Tier column)'}`);
  console.log(`  ledger    already has ${[...already].sort().join('+') || 'nothing'}`);
  for (const f of nets) console.log(`  -> ${clean(f.Name).padEnd(18)} chat ${String(f['Chat ID']).trim().padEnd(16)} $${(Number(f.Price) || 0).toFixed(2).padStart(6)}  ${(Number(f['Network Size']) || 0).toLocaleString()} reach`);
  console.log(`  cost      $${cost.toFixed(2)} · ${reach.toLocaleString()} reach`);
  if (!live) { console.log('\n(no --send, nothing sent)'); return; }

  const at = new Date().toISOString();
  const delivered = [];
  for (const f of nets) {
    const chat = String(f['Chat ID']).trim();
    // A comment row shares its RT vendor's chat: the message says which product it is (Build Broadcasts).
    const r = await tg(vbot, chat, isComment(f) ? `💬 COMMENT — please comment on this post (not an RT):\n${url}` : url);
    console.log(`  ${r.ok ? '✅' : '❌'} ${clean(f.Name)} — ${r.ok ? 'delivered' : r.detail}`);
    if (r.ok) delivered.push(f);
  }
  if (!delivered.length) { console.log('nothing delivered — ledger untouched'); return; }

  // meter each delivery against the vendor's deal, same source label the workflow uses
  const rt = byName['RT Count Webhook'] || {};
  const rtTok = String(rt.Token || '').trim();
  let rtUrl = String(rt['Webhook URL'] || '').trim().replace(/\/+$/, '');
  if (rtTok && rtUrl) {
    if (!/\/vendor-rt$/.test(rtUrl)) rtUrl += '/vendor-rt';
    for (const f of delivered) {
      try {
        const r = await fetch(rtUrl, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${rtTok}` },
          body: JSON.stringify({ vendor_chat_id: Number(String(f['Chat ID']).trim()), link: url, source: 'fuel-the-fire', ...(isComment(f) ? { kind: 'comment' } : {}) }) });
        const j = await r.json().catch(() => ({}));
        console.log(`  meter ${clean(f.Name)}: ${j.counted ? 'counted' : j.skipped || (j.deduped ? 'deduped' : 'no change')}${j.status ? ` — ${j.status}` : ''}`);
      } catch (e) { console.log(`  meter ${clean(f.Name)}: failed — ${e.message}`); }
    }
  } else console.log('  (RT Count Webhook not configured — deliveries not metered)');

  // ledger — the breakdown line AND every field derived from it.
  //
  // Writing only `Tier Breakdown` is not enough, and used to be all this did. Tiers Used, Networks,
  // Total Spend, Reach and Last Fired are NOT Airtable formulas: the n8n Build-Log node computes and
  // writes them on a workflow fire, and nothing recomputes them afterwards. So a hand fire left them
  // at whatever the last automatic fire wrote, and every readout that keys on them — registry-sync
  // (Total Spend + Tiers Used), facts-build, the digest, the scorecard — showed the post unboosted
  // and the money unspent. Measured 2026-09-09: four hand fires on two posts, $56.60, and both rows
  // still read "T0 · $9.05" until they were repaired by hand.
  //
  // Recomputed from the merged breakdown with the SAME rules as docs/fuel-nodes/Build-Log.js (tiers
  // unique and numerically sorted, vendors unique in first-seen order, price and reach summed across
  // every event, Last Fired = the newest stamp), so a hand fire and a workflow fire leave a row in
  // indistinguishable shape. First Fired and Ladder Version are deliberately NOT touched: they are
  // stamped once by the first fire and a later manual tier must not rewrite that history.
  const lines = delivered.map((f) => `${tier} · ${clean(f.Name)} · $${(Number(f.Price) || 0).toFixed(2)} · ${Number(f['Network Size']) || 0} reach · ${at}`);
  const merged = [String(row.fields['Tier Breakdown'] || '').trimEnd(), ...lines].filter(Boolean).join('\n');
  const events = parseTierBreakdown(merged);
  const ord = (t) => Number(String(t).replace(/^T/, '')) || 0;
  await reg.upsert('Fuel Log', 'X URL', [{
    'X URL': row.fields['X URL'],
    'Tier Breakdown': merged,
    'Tiers Used': [...new Set(events.flatMap((e) => e.tiers))].filter((t) => t !== 'T?').sort((a, b) => ord(a) - ord(b)).join('+'),
    'Networks': [...new Set(events.flatMap((e) => e.vendors))].join(', '),
    'Total Spend': Number(events.reduce((s, e) => s + e.price, 0).toFixed(2)),
    'Reach': events.reduce((s, e) => s + e.reach, 0),
    'Last Fired': at,
  }]);
  console.log(`  ledger    +${lines.length} line(s) · row now ${[...new Set(events.flatMap((e) => e.tiers))].filter((t) => t !== 'T?').sort((a, b) => ord(a) - ord(b)).join('+')} · $${events.reduce((s, e) => s + e.price, 0).toFixed(2)}`);

  // the same card the workflow posts
  const pipe = byName['Telegram'];
  if (pipe && pipe.Token && String(pipe['Chat ID'] || '').trim()) {
    let thread; try { thread = JSON.parse(pipe.Topics || '{}').fuel; } catch {}
    const dCost = delivered.reduce((s, f) => s + (Number(f.Price) || 0), 0);
    const total = parseTierBreakdown(merged).reduce((s, e) => s + e.price, 0);
    const text = `🔥 Fuel Fired · @${row.fields.Account || ''}\n✅ ${tier} → ${delivered.map((f) => clean(f.Name)).join(', ')}  (manual)\n\n💸 +$${dCost.toFixed(2)} now · $${total.toFixed(2)} total\n\n${url}`;
    const r = await tg(String(pipe.Token).trim(), String(pipe['Chat ID']).trim(), text, thread);
    console.log(`  card      ${r.ok ? 'posted to the Fuel topic' : 'failed — ' + r.detail}`);
  }
  await logRun('fuel-send', { tweet: tid, tier, networks: delivered.length, cost: Number(cost.toFixed(2)) });
}, 'fuel-send');
