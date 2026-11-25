#!/usr/bin/env node
// scripts/echo-qrt-setup.mjs — wire the echo QRT lane into n8n once (docs/echo-qrt.md). Idempotent; dry by default.
//
//   1. Published Feed (dnRto8vWTfhXVMVQ): add the Code node "Schedule Echo QRTs" after "Upsert Published Feed", with its
//      code from docs/feed-nodes/Schedule-Echo-QRTs.js. bridge-deploy.mjs refuses to create a node (a node also needs
//      its wiring), so this is the one place that adds it; after that bridge-deploy owns its code like any other.
//   2. Echo QRT falling check (ttDGqsy2NBlYlyPI, created inactive): confirm its code is the repo's, then activate it.
//   3. Booster thread QRTs (O8yFAg8NSx0HmIli, created inactive; docs/booster-lane.md): the same, for the boosters' slots.
// Every write is read back byte for byte. Run it AFTER the PR that brings these sources has merged.
//
//   node scripts/echo-qrt-setup.mjs            # dry: what would change
//   node scripts/echo-qrt-setup.mjs --apply
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, runMain, HERE_DIR } from '../lib.mjs';

export const FEED = 'dnRto8vWTfhXVMVQ', FALLING = 'ttDGqsy2NBlYlyPI', BOOSTER = 'O8yFAg8NSx0HmIli';
export const NODE = 'Schedule Echo QRTs', AFTER = 'Upsert Published Feed';
const SETTINGS_NOT_IN_API = ['binaryMode', 'timeSavedMode'];

/** PURE. The feed workflow with the scheduler node added after the upsert (unchanged when it is already there). */
export function withScheduler(w, jsCode) {
  if (w.nodes.some((n) => n.name === NODE)) return null;
  const after = w.nodes.find((n) => n.name === AFTER);
  if (!after) throw new Error(`"${AFTER}" is not in the feed workflow; refusing to guess where the scheduler goes`);
  const node = { name: NODE, type: 'n8n-nodes-base.code', typeVersion: 2, position: [after.position[0] + 240, after.position[1]], parameters: { jsCode } };
  const connections = { ...w.connections, [AFTER]: { main: [[...((w.connections[AFTER]?.main || [])[0] || []), { node: NODE, type: 'main', index: 0 }]] } };
  return { nodes: [...w.nodes, node], connections };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['N8N_API_KEY']);
  const APPLY = process.argv.includes('--apply');
  const HOST = String(env.N8N_URL || 'https://n8n-railway-production-7c55.up.railway.app').replace(/\/$/, '');
  const H = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
  const get = async (id) => { const r = await fetch(`${HOST}/api/v1/workflows/${id}`, { headers: H }); if (!r.ok) throw new Error(`GET ${id} -> ${r.status}`); return r.json(); };
  const put = async (w, nodes, connections) => {
    const settings = Object.fromEntries(Object.entries(w.settings || {}).filter(([k]) => !SETTINGS_NOT_IN_API.includes(k)));
    const r = await fetch(`${HOST}/api/v1/workflows/${w.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: w.name, nodes, connections, settings, ...(w.staticData !== undefined ? { staticData: w.staticData } : {}) }) });
    if (!r.ok) throw new Error(`PUT ${w.id} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  const src = (file) => readFileSync(join(HERE_DIR, 'docs', 'feed-nodes', file), 'utf8');

  const feed = await get(FEED);
  const plan = withScheduler(feed, src('Schedule-Echo-QRTs.js'));
  if (!plan) console.log(`✓ ${feed.name}: "${NODE}" already wired (bridge-deploy.mjs owns its code)`);
  else if (!APPLY) console.log(`(dry) ${feed.name}: would add "${NODE}" after "${AFTER}"`);
  else {
    await put(feed, plan.nodes, plan.connections);
    const back = await get(FEED);
    const n = back.nodes.find((x) => x.name === NODE);
    const wired = (back.connections[AFTER]?.main?.[0] || []).some((c) => c.node === NODE);
    if (!n || n.parameters.jsCode !== src('Schedule-Echo-QRTs.js') || !wired) throw new Error(`${NODE}: read-back mismatch (node ${!!n}, wired ${wired})`);
    console.log(`✓ ${back.name}: "${NODE}" added after "${AFTER}", byte-exact · active=${back.active} · version ${back.versionId}${back.versionId !== back.activeVersionId ? ' ** not the active version **' : ''}`);
  }

  // The two scheduled workflows: each goes live only once its live code is the repo's.
  for (const [id, node, file] of [[FALLING, 'Echo Falling Check', 'Echo-Falling-Check.js'], [BOOSTER, 'Booster Thread QRTs', 'Booster-Thread-QRTs.js']]) {
    const w = await get(id);
    const code = w.nodes.find((x) => x.name === node)?.parameters?.jsCode;
    if (code !== src(file)) throw new Error(`${w.name}: live code is not the repo's; run node bridge-deploy.mjs --apply first`);
    if (w.active) console.log(`✓ ${w.name}: active, code byte-exact`);
    else if (!APPLY) console.log(`(dry) ${w.name}: would activate (code byte-exact)`);
    else {
      const r = await fetch(`${HOST}/api/v1/workflows/${id}/activate`, { method: 'POST', headers: H });
      if (!r.ok) throw new Error(`activate ${id} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
      console.log(`✓ ${w.name}: activated (every 30 minutes)`);
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await runMain(main, 'echo-qrt-setup');
