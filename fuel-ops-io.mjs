// fuel-ops-io.mjs — the fetch side of the fuel-ops scripts (Airtable, the RT bot, Telegram membership).
// Everything that touches a network lives here so fuel-ops-core.mjs stays pure and testable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { airtable, HERE_DIR } from './lib.mjs';
import { TABLES, GROWTH, growthBase } from './config.mjs';

export const FUEL_LOG = 'tblNSMxxTggWNndI7';     // REGISTRY_BASE_ID
export const GROWTH_LOG = GROWTH.table;   // own base since 2026-11-25 (config.mjs GROWTH)
export const ACCOUNTS = 'tblwn2lLoJBuJKvUv';     // XDB_BASE_ID — the fleet roster the Bridge reads

export const FUEL_FIELDS = ['X URL', 'Account', 'Tiers Used', 'Networks', 'Tier Breakdown', 'Total Spend', 'Reach', 'First Fired', 'Last Fired', 'Ladder Version', 'Arm', 'Holdout', 'Skipped Vendor', 'Lifetime Commission Rollup (from Post)'];

export const fuelRows = (env) => airtable(env, env.REGISTRY_BASE_ID).listAll(FUEL_LOG, { fields: FUEL_FIELDS });
export const configRows = (env) => airtable(env).listAll(TABLES.config);
export const accountRows = (env) => airtable(env).listAll(ACCOUNTS);

/** Growth Log snapshots since `sinceIso`, as Map(tweetId -> [{at, views}] ascending). Filtered
 *  server-side: the table holds tens of thousands of hourly rows and a scorecard needs weeks, not all. */
export async function growthSnaps(env, sinceIso) {
  const rows = await airtable(env, growthBase(env)).listAll(GROWTH_LOG, {
    fields: ['X URL', 'At', 'Views'],
    formula: `IS_AFTER({At}, DATETIME_PARSE('${sinceIso}'))`,
  });
  const by = new Map();
  for (const r of rows) {
    const f = r.fields || {}; const k = (String(f['X URL'] || '').match(/status\/(\d+)/) || [])[1];
    if (!k || !f.At || f.Views == null) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ at: f.At, views: f.Views });
  }
  for (const arr of by.values()) arr.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return by;
}

/** Bot chat id -> the name the Fuel Log uses for that network (vendors.json fuelLogName). */
export function vendorByChat() {
  const v = JSON.parse(readFileSync(join(HERE_DIR, 'vendors.json'), 'utf8'));
  const out = {};
  for (const x of v.vendors || []) if (x.chatId) out[String(x.chatId)] = x.fuelLogName || x.title || x.key;
  return out;
}

/** GET /vendor-status on the RT bot, using the Config row "RT Count Webhook" (Token + Webhook URL).
 *  Never throws: {status, note} — note explains a null status (endpoint not deployed, bot down, row
 *  incomplete) so the callers can degrade instead of failing the run. */
export async function botStatus(cfgRows, fetchImpl = fetch) {
  const row = cfgRows.map((r) => r.fields || r).find((f) => f.Name === 'RT Count Webhook');
  const token = row && String(row.Token || '').trim(), url = row && String(row['Webhook URL'] || '').trim();
  if (!token || !url) return { status: null, note: 'Config "RT Count Webhook" row has no Token or Webhook URL' };
  const base = url.replace(/\/+$/, '').replace(/\/vendor-rt$/, '');
  try {
    const r = await fetchImpl(`${base}/vendor-status`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { status: null, note: `bot /vendor-status -> HTTP ${r.status}${r.status === 404 ? ' (endpoint not deployed yet)' : ''}` };
    return { status: await r.json(), note: '' };
  } catch (e) { return { status: null, note: `bot unreachable: ${e.message}` }; }
}

/** Is the Vendor Bot inside every chat it is expected to post to? One getChatMember per chat.
 *  chats: [{name, chatId}] -> [{name, chatId, status}] or [{..., error}]. */
export async function membership(cfgRows, chats, fetchImpl = fetch) {
  const vbot = cfgRows.map((r) => r.fields || r).find((f) => f.Name === 'Vendor Bot');
  const token = vbot && String(vbot.Token || '').trim();
  if (!token) return chats.map((c) => ({ ...c, error: 'no Vendor Bot token in Config' }));
  const me = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
  if (!me.ok) return chats.map((c) => ({ ...c, error: `getMe failed: ${me.description || '?'}` }));
  const out = [];
  for (const c of chats) {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(c.chatId)}&user_id=${me.result.id}`).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
    out.push(r.ok ? { ...c, status: r.result.status } : { ...c, error: r.description || 'unknown error' });
  }
  return out;
}
