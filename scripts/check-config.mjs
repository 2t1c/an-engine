#!/usr/bin/env node
// node scripts/check-config.mjs              validate config/*.json (a buyer's clone)
// node scripts/check-config.mjs --examples   validate config/*.example.json (the engine repo)
import { loadConfig, activePages } from '../lib/config.mjs';

const examples = process.argv.includes('--examples');
try {
  const cfg = loadConfig({ examples });
  console.log(`config: ok · ${cfg.pages.pages.length} page(s), ${activePages(cfg).length} active · ${cfg.products.products.length} product(s)${examples ? ' (examples)' : ''}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
