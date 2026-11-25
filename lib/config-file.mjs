// Read one config/<name>.json from the buyer's clone. In the engine repo (no buyer config yet) it
// falls back to config/<name>.example.json, so the code loads and the tests run; that fallback is
// reported once on stderr unless ENGINE_EXAMPLES=1 says it is intended. Never throws: a missing or
// broken file comes back as the example (or {}), with the reason on stderr.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');
const warned = new Set();
const warn = (msg) => { if (!warned.has(msg) && process.env.ENGINE_EXAMPLES !== '1') { warned.add(msg); console.error(`[config] ${msg}`); } };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (err) { warn(`${file}: ${err.message}`); return null; }
}

/** @param {string} name e.g. 'pages' -> config/pages.json */
export function readConfigFile(name, { dir = DIR } = {}) {
  const real = join(dir, `${name}.json`);
  if (existsSync(real)) {
    const v = readJson(real);
    if (v) return v;
  }
  const example = join(dir, `${name}.example.json`);
  warn(`config/${name}.json not found; using config/${name}.example.json (engine defaults, not a buyer's)`);
  return (existsSync(example) && readJson(example)) || {};
}
