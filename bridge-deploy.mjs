#!/usr/bin/env node
// bridge-deploy.mjs — push the repo's n8n node sources into the live workflows, byte-exact.
//
// docs/bridge-nodes and docs/fuel-nodes ARE the code the RT Bridge and Fuel the Fire run; until
// 2026-09-07 a deploy was a hand paste into each Code node, and a paste is where a backslash or a
// unicode escape quietly changes. This reads each workflow through the public API, refuses when a
// live Code node no longer matches the version the repo's edit was based on (so nobody's hand edit in
// n8n gets overwritten unseen), then PUTs the new jsCode on exactly the listed nodes and reads back
// every one of them byte for byte. Everything else on the workflow is carried through unchanged.
//
// It also owns selected NON-Code node parameters, declared in docs/node-params.json -- an Airtable
// node's filterByFormula decides which Config rows a workflow can even see, and a row it never
// fetches turns a `find` into undefined that every consumer then fails OPEN on. That is exactly how
// dedup and the fuel split test each shipped dead. Same drift rule, same byte-exact read-back.
//
//   node bridge-deploy.mjs                 # dry: drift check + what would change
//   node bridge-deploy.mjs --apply         # write, read back, report the active version
//   node bridge-deploy.mjs --base HEAD~2   # the repo revision the live code is expected to match
//   node bridge-deploy.mjs --cards         # the Command Center card workflows instead (CARD_TARGETS), same rules
//
// Env: N8N_API_KEY (required), N8N_URL (defaults to the Railway host).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadEnv, requireEnv, runMain, HERE_DIR, cliArg } from './lib.mjs';

// Which Code nodes each workflow owns in the repo. A node missing here is never touched.
export const TARGETS = {
  ejuTtOnUskRYbqVi: { label: 'Typefully RT Bridge (241)', dir: 'bridge-nodes',
    nodes: ['Plan Polls', 'Find New Published', 'Thread Gate (Poll)', 'Handle Publish Event', 'Thread Gate (Hook)', 'Fuel Gate', 'Build T0 Fuel', 'Build T0 PC', 'Build RT Count Report', 'Log T0 Boost Event', 'Report T0 Send Failures',
      // AI Evolution's T0 delivery note (2026-10-06). New: create it live (wired from Send RT Ping) before the first deploy.
      'Confirm T0',
      // One retry on a Telegram transport error (2026-11-14), wired between Send RT Ping and its consumers.
      'Retry Network Fails'] },
  X0OzDwI0XluxEEtO: { label: 'Fuel the Fire (241)', dir: 'fuel-nodes',
    nodes: ['Plan Watches', 'Pick Candidates', 'Check Threshold', 'Build Broadcasts', 'Build Log', 'Track Fuel Cards', 'Update Fuel Lift', 'Report Send Failures', 'Build Delivery Report',
      // One retry on a Telegram transport error (2026-11-14), wired between Send Telegram and its consumers.
      'Retry Network Fails'] },
  // Typefully draft.published -> Airtable "Published Feed" (owner, 2026-10-03), then the thread's echo QRTs. See
  // docs/published-feed.md and docs/echo-qrt.md.
  dnRto8vWTfhXVMVQ: { label: 'Published Feed', dir: 'feed-nodes', nodes: ['Build Feed Row', 'Schedule Echo QRTs'] },
  // The 4th echo QRT, decided around +9.5h (docs/echo-qrt.md).
  ttDGqsy2NBlYlyPI: { label: 'Echo QRT falling check', dir: 'feed-nodes', nodes: ['Echo Falling Check'] },
  // The booster pages' fleet-thread QRTs, every 30 minutes (docs/booster-lane.md).
  O8yFAg8NSx0HmIli: { label: 'Booster thread QRTs', dir: 'feed-nodes', nodes: ['Booster Thread QRTs'] },
  // Sister pages retweet each thread through Zernio, every minute (owner 2026-11-18; docs/sister-rts.md).
  fanDr0MhUmZUM6Ks: { label: 'Sister RTs (Zernio)', dir: 'feed-nodes', nodes: ['Sister RTs'] },
  // Blend-in follows through Zernio, every 10 minutes (owner 2026-11-18; docs/sister-rts.md, Follow Plan).
  TzDpbZG1opPOLyYe: { label: 'Follow Plan (Zernio)', dir: 'feed-nodes', nodes: ['Follow Plan'] },
};
// Command Center presentation workflows (docs/n8n-nodes). Deliberately NOT in TARGETS: a money-path deploy
// never carries them, and --cards never touches a money path. A node whose repo file is new since --base is
// checked against its captured live baseline (<file>.original.js or .reference.js), so the drift guard still
// holds on its first deploy.
export const CARD_TARGETS = {
  fxcoO6VcpFobhqHS: { label: 'Daily Post Card (241)', dir: 'n8n-nodes', nodes: ['Render Post Card'] },
  '4VsoFAJSlNBODeuz': { label: 'Revenue Daily (241)', dir: 'n8n-nodes', nodes: ['Daily Sales Totals', 'Send Telegram (revenue)'] },
};
// The public API's settings schema rejects two UI-only keys; n8n keeps their stored values anyway.
const SETTINGS_NOT_IN_API = ['binaryMode', 'timeSavedMode'];
export const fileOf = (n) => n.replace(/[ ()]+/g, '-').replace(/-+$/, '') + '.js';
export const PARAMS_FILE = 'docs/node-params.json';

/** Declared node parameters for one workflow, as {nodeName: {param: value}}. Keys starting with "_"
 *  are prose, never config. Pure so the tests can drive it without a checkout. */
export function paramsFor(doc, workflowId) {
  const wf = (doc || {})[workflowId];
  if (!wf || typeof wf !== 'object') return {};
  return Object.fromEntries(Object.entries(wf).filter(([k]) => !k.startsWith('_')));
}

/** One line per declared parameter: its live value, the value the repo wants, and whether the live
 *  one is the --base value (safe to update), already correct, or a hand edit that must not be lost. */
export const sameParam = (a, b) => a !== undefined && b !== undefined && isDeepStrictEqual(a, b);
export function paramPlan(live, before, after) {
  if (sameParam(live, after)) return 'up to date';
  if (before === undefined) return live === undefined ? 'will add' : 'DRIFT — parameter is new in the repo but already set live';
  if (sameParam(live, before)) return 'will update';
  return 'DRIFT — live value is neither the repo base nor the new version';
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['N8N_API_KEY']);
  const HOST = String(env.N8N_URL || 'https://n8n-railway-production-7c55.up.railway.app').replace(/\/$/, '');
  const H = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
  const APPLY = process.argv.includes('--apply');
  const BASE = cliArg('base', 'HEAD~1');
  const newSrc = (dir, n) => readFileSync(`${HERE_DIR}/docs/${dir}/${fileOf(n)}`, 'utf8');
  const baselineOf = (dir, n) => {
    for (const kind of ['original', 'reference']) {
      try { return readFileSync(`${HERE_DIR}/docs/${dir}/${fileOf(n).replace(/\.js$/, `.${kind}.js`)}`, 'utf8'); } catch { /* next */ }
    }
    return null;
  };
  const oldSrc = (dir, n) => { try { return execFileSync('git', ['-C', HERE_DIR, 'show', `${BASE}:docs/${dir}/${fileOf(n)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return baselineOf(dir, n); } };
  const SET = process.argv.includes('--cards') ? CARD_TARGETS : TARGETS;
  const readJson = (txt) => { try { return JSON.parse(txt); } catch { return {}; } };
  const newParams = readJson(readFileSync(`${HERE_DIR}/${PARAMS_FILE}`, 'utf8'));
  const oldParams = readJson((() => { try { return execFileSync('git', ['-C', HERE_DIR, 'show', `${BASE}:${PARAMS_FILE}`], { encoding: 'utf8' }); } catch { return '{}'; } })());

  for (const [id, t] of Object.entries(SET)) {
    const r = await fetch(`${HOST}/api/v1/workflows/${id}`, { headers: H });
    if (!r.ok) throw new Error(`GET ${id} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    const w = await r.json();
    console.log(`\n== ${w.name} (${id}) active=${w.active} nodes=${w.nodes.length} version=${w.versionId || '-'}`);
    let drift = 0, changed = 0;
    const want = paramsFor(newParams, id), was = paramsFor(oldParams, id);
    const seenParamNodes = new Set();
    const nodes = w.nodes.map((n) => {
      // Declared non-Code parameters. A node can carry these AND be a Code node, so this runs first
      // and hands the (possibly rewritten) node on rather than returning early.
      if (want[n.name]) {
        seenParamNodes.add(n.name);
        const patch = {};
        for (const [k, after] of Object.entries(want[n.name])) {
          const live = n.parameters?.[k], before = (was[n.name] || {})[k];
          const status = paramPlan(live, before, after);
          if (/DRIFT/.test(status)) drift++;
          if (status !== 'up to date') { changed++; patch[k] = after; }
          console.log(`  ${(n.name + ' · ' + k).padEnd(40)} ${status}`);
        }
        if (Object.keys(patch).length) n = { ...n, parameters: { ...n.parameters, ...patch } };
      }
      if (!t.nodes.includes(n.name)) return n;
      const live = String(n.parameters?.jsCode ?? '');
      const before = oldSrc(t.dir, n.name), after = newSrc(t.dir, n.name);
      const same = (a, b) => a != null && a.trim() === b.trim();
      const status = same(live, after) ? 'up to date' : same(live, before) ? 'will update' : 'DRIFT — live code is neither the repo base nor the new version';
      if (/DRIFT/.test(status)) drift++;
      if (!same(live, after)) changed++;
      console.log(`  ${n.name.padEnd(24)} live ${String(live.length).padStart(5)}ch → repo ${String(after.length).padStart(5)}ch  ${status}`);
      return { ...n, parameters: { ...n.parameters, jsCode: after } };
    });
    for (const name of Object.keys(want)) if (!seenParamNodes.has(name)) { drift++; console.log(`  ✗ ${name} — declared in ${PARAMS_FILE} but no such node in this workflow`); }
    // A listed Code node the live workflow lacks is never created here (a node also needs its wiring): say so, and stop.
    for (const name of t.nodes) if (!w.nodes.some((n) => n.name === name)) { drift++; console.log(`  ✗ ${name} — listed for ${t.label} but not in the live workflow: add it with its connections first (scripts/echo-qrt-setup.mjs for the echo QRT nodes)`); }
    if (drift) { console.log(`  ✗ ${drift} node(s) drifted from ${BASE} — read the live code before deploying ${t.label}`); process.exitCode = 1; continue; }
    if (!changed) { console.log('  nothing to change'); continue; }
    if (!APPLY) { console.log(`  (dry — ${changed} node(s) would change; pass --apply)`); continue; }
    const settings = Object.fromEntries(Object.entries(w.settings || {}).filter(([k]) => !SETTINGS_NOT_IN_API.includes(k)));
    const body = { name: w.name, nodes, connections: w.connections, settings };
    if (w.staticData !== undefined) body.staticData = w.staticData;
    const p = await fetch(`${HOST}/api/v1/workflows/${id}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
    const txt = await p.text();
    if (!p.ok) throw new Error(`PUT ${id} -> ${p.status} ${txt.slice(0, 300)}`);
    const back = await (await fetch(`${HOST}/api/v1/workflows/${id}`, { headers: H })).json();
    let bad = 0;
    for (const n of back.nodes) if (t.nodes.includes(n.name)) { const ok = String(n.parameters.jsCode) === newSrc(t.dir, n.name); if (!ok) bad++; console.log(`    ${n.name.padEnd(24)} ${ok ? 'byte-exact' : 'MISMATCH after write'}`); }
    for (const n of back.nodes) for (const [k, v] of Object.entries(want[n.name] || {})) { const ok = sameParam(n.parameters?.[k], v); if (!ok) bad++; console.log(`    ${(n.name + ' · ' + k).padEnd(40)} ${ok ? 'byte-exact' : 'MISMATCH after write'}`); }
    console.log(`  ${bad ? '✗' : '✓'} active=${back.active} version=${back.versionId || '-'} activeVersion=${back.activeVersionId || '-'}${back.versionId && back.activeVersionId && back.versionId !== back.activeVersionId ? '  ** not the active version — publish it **' : ''}`);
    if (bad) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'bridge-deploy');
