// refresh-hook-bank.mjs — builds learnings/hook-bank.json: the corpus of PROVEN viral hooks that
// hookStrength (checks.mjs) scores generated hooks against (similarity in vocab / phrasing / structure
// to existing data — the operator's definition of hook strength, 2026-07-17). Pulls the top in-niche
// winner heads from the swipe DB, keeps the hook (first line + optional promise line), and commits the
// bank so every generation run has it in its checkout. Weekly Actions cron + manual dispatch.
//   node refresh-hook-bank.mjs            # write learnings/hook-bank.json
//   node refresh-hook-bank.mjs --dry      # print what would be written, no file write
//   node refresh-hook-bank.mjs --floor 500000 --cap 150
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, airtable, runMain, HERE_DIR } from './lib.mjs';
import { hookStrength } from './checks.mjs';
import { TABLES } from './config.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const FLOOR = parseInt(flag('floor', '500000'), 10); // a bank hook must be a real winner
const CAP = parseInt(flag('cap', '150'), 10);        // bank size (top by views)
const NICHES = ['Health', 'Fitness', 'Mental Health', 'Psychology']; // mirrors daily-winners HEALTH_NICHES
// Junk the bank must never learn from: formats that aren't text-thread hooks (mirrors UNRECREATABLE's
// media classes) — their vocab/structure would poison the similarity baseline.
const JUNK = /this video|watch this|sound on|a thread of (videos|photos|pictures)|\d+ (pictures|photos|images|memes)/i;
// Off-niche mega-virals mis-tagged into health niches (mirrors daily-winners' OFF_NICHE) plus pure
// quote-cards ("…" – Author): viral, but not the health-hook style we write — their vocab/structure
// would drag the similarity baseline toward philosophy/politics prose we never produce.
const OFF_STYLE = /\b(society|moral compass|civili[sz]ation|democracy|government|politic|election|communis|capitalis|religion|jesus|christ|the bible|quran|allah)\b|^["“].*["”]\s*[-–—]\s*\p{Lu}/iu;

/** Jev's exclusions, Map hook -> reason. Any failure reads nothing and the regex answer stands. */
export async function curateWithJev(env, candidates, { client = null, concurrency = 12 } = {}) {
  const out = new Map();
  if (!candidates.length || (!client && !env.OPENROUTER_API_KEY && !env.TYPESAFE_API_KEY)) return out;
  try {
    const { decide, decisionConfig } = await import('./jev-decide.mjs');
    const { DECISIONS } = await import('./decisions/index.mjs');
    const jevClient = client || (await import('./jev.mjs')).jev(env);
    const th = decisionConfig('hook-bank-curate').thresholds;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (i < candidates.length) {
        const c = candidates[i++];
        const r = await decide('hook-bank-curate', { hook: c.h, regexExcluded: false }, { client: jevClient, registry: DECISIONS, log: null, cache: null });
        if (r.source === 'fallback' || !r.answers) continue;
        const v = DECISIONS['hook-bank-curate'].policy(r.answers, th);
        if (v.action === 'exclude') out.set(c.h, `${c.h.split('\n')[0].slice(0, 50)} (${v.reasons.join(', ')})`);
      }
    }));
  } catch (e) { console.warn(`hook bank: Jev not read (${String(e.message).slice(0, 80)}); regex filters only`); }
  return out;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'XDB_BASE_ID']);
  const at = airtable(env);
  const nicheOr = 'OR(' + NICHES.map((n) => `{Niche}="${n}"`).join(',') + ')';
  const formula = `AND({Tweet Number}=1,{Thread Length}>=3,NOT({Quoted Junk}),NOT({Single Tweet}),{Impressions}>=${FLOOR},${nicheOr})`;
  const recs = await at.list(TABLES.swipe, { formula, sort: [{ field: 'Impressions', direction: 'desc' }], fields: ['Text', 'Impressions'], pageSize: 100 });

  // Hook = first line + the promise line when the head is a classic 2-beat hook (opener + "N ways...:").
  // Keeping both beats teaches the bank the full hook SHAPE, not just openers.
  const seen = new Set();
  const candidates = [];
  for (const r of recs) {
    const lines = String(r.fields.Text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const h = lines.slice(0, 2).join('\n');
    const key = h.toLowerCase().replace(/\s+/g, ' ');
    if (JUNK.test(h) || OFF_STYLE.test(h) || h.split(/\s+/).length < 4 || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ h, views: r.fields.Impressions || 0 });
    if (candidates.length >= CAP * 2) break; // Jev may exclude some: read up to twice the bank's size
  }
  // Jev reads what the regexes let through (decisions/hook-bank-curate.mjs, v7 N3); it can only exclude.
  const excluded = await curateWithJev(env, candidates);
  const hooks = candidates.filter((c) => !excluded.has(c.h)).slice(0, CAP);
  if (excluded.size) console.log(`jev: excluded ${excluded.size} hook(s): ${[...excluded.values()].slice(0, 5).join(' | ')}`);
  if (hooks.length < 20) throw new Error(`only ${hooks.length} bank hooks found (floor ${FLOOR}) — refusing to write a thin bank`);

  const bank = { ts: new Date().toISOString(), floorViews: FLOOR, niches: NICHES, count: hooks.length, hooks };
  console.log(`hook bank: ${hooks.length} winner hooks (floor ${FLOOR.toLocaleString()} views)`);
  hooks.slice(0, 5).forEach((x, i) => console.log(`  ${i + 1}. ${x.views.toLocaleString()} · ${x.h.split('\n')[0].slice(0, 78)}`));
  // Self-check: the bank must score its OWN members high — a top bank hook scoring low would mean the
  // scorer and the corpus disagree (a build bug), so fail loudly instead of committing a broken bank.
  const probe = hookStrength(hooks[0].h, hooks);
  console.log(`self-check: top bank hook scores ${probe?.score}/100 vs its own corpus`);
  if (!probe || probe.score < 50) throw new Error(`bank self-check failed (top hook scored ${probe?.score}) — not writing`);

  if (DRY) { console.log('(dry run — nothing written)'); return; }
  const dir = join(HERE_DIR, 'learnings');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hook-bank.json'), JSON.stringify(bank, null, 1) + '\n');
  console.log('✓ wrote learnings/hook-bank.json');
}
// Run only as a script, so tests can import curateWithJev without starting a refresh.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main, 'refresh-hook-bank'); // crash-alert wrapper (audit 2026-07-21)
