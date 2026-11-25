// sync-secrets.mjs — cross-repo secrets source-of-truth + sync. Each repo's local .env is canonical
// for its own secrets; this pushes them to that repo's GitHub Actions secrets so CI can never go
// stale — the exact drift that broke the n8n backup (local key worked, CI key 401'd). It also checks
// that SHARED secrets (needed by BOTH repos' CI) are identical across repos, comparing short SHA-256
// fingerprints so values are NEVER printed. Run it on the dev machine after rotating any key.
//   node sync-secrets.mjs          # dry: report in/out of sync (default, safe)
//   node sync-secrets.mjs --push   # actually `gh secret set` from local .env for both repos
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const PUSH = process.argv.includes('--push');
const HOME = process.env.HOME;
// This repo is wherever this file lives — the clone moved from ~/Downloads to ~ in 2026-09 and a stale
// clone's .env (no STRIPE_SECRET_KEY) was still being read as canonical.
const HERE = dirname(fileURLToPath(import.meta.url));
const RESERVED = new Set(['GITHUB_TOKEN']); // auto-provided by Actions — never settable as a secret
// Repos sharing one ecosystem (Airtable, Telegram, Typefully, Anthropic). A locally-cloned repo derives
// its needs from its own workflows; a CI-only repo (not cloned) lists `secrets` explicitly, and any
// value it lacks is sourced from the canonical project-infinity .env.
const REPOS = [
  { name: 'project-infinity', slug: '2t1c/project-infinity', dir: HERE },
  { name: 'n8n-x-pipeline', slug: '2t1c/n8n-x-pipeline', dir: join(HOME, 'Downloads/n8n-x-pipeline') },
  { name: 'genius-rt-bot', slug: '2t1c/genius-rt-bot', secrets: ['ANTHROPIC_API_KEY'] }, // Claude Code self-improvement bot
];

const parseEnv = (p) => Object.fromEntries((existsSync(p) ? readFileSync(p, 'utf8') : '')
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
// What CI actually needs = every `secrets.NAME` referenced in the repo's workflows (self-maintaining).
const ciSecrets = (dir) => {
  const d = join(dir, '.github/workflows'); if (!existsSync(d)) return [];
  const s = new Set();
  for (const f of readdirSync(d).filter((f) => /\.ya?ml$/.test(f)))
    for (const m of readFileSync(join(d, f), 'utf8').matchAll(/secrets\.([A-Z0-9_]+)/g)) s.add(m[1]);
  return [...s].sort();
};
const fp = (v) => createHash('sha256').update(v).digest('hex').slice(0, 8);

const canon = parseEnv(join(HERE, '.env')); // shared-secret source of truth
const repos = REPOS.map((r) => ({
  ...r,
  env: r.dir ? parseEnv(join(r.dir, '.env')) : {},
  needs: (r.secrets || ciSecrets(r.dir)).filter((n) => !RESERVED.has(n)),
}));
const valueOf = (r, n) => r.env[n] || canon[n]; // own .env first, then canonical (for shared / CI-only repos)

// 1) cross-repo consistency: secrets needed by >1 repo must have identical values (by fingerprint).
const counts = {};
for (const r of repos) for (const n of r.needs) counts[n] = (counts[n] || 0) + 1;
const shared = Object.keys(counts).filter((n) => counts[n] > 1).sort();
console.log('=== shared CI secrets (must match across repos) ===');
let drift = 0;
for (const n of shared) {
  const fps = repos.filter((r) => r.needs.includes(n)).map((r) => ({ name: r.name, fp: valueOf(r, n) ? fp(valueOf(r, n)) : 'MISSING' }));
  const uniq = new Set(fps.map((x) => x.fp));
  const ok = uniq.size === 1 && !uniq.has('MISSING');
  if (!ok) drift++;
  console.log(`  ${ok ? '✓' : '⚠️'} ${n}: ${fps.map((x) => `${x.name}=${x.fp}`).join('  ')}`);
}
if (drift) console.log(`  ⚠️ ${drift} shared secret(s) DIFFER across repos — reconcile the local .env files before pushing.`);

// 2) per-repo sync: push each CI-needed secret from that repo's local .env to its GitHub secrets.
for (const r of repos) {
  console.log(`\n=== ${r.name} (${r.slug}) ===`);
  for (const n of r.needs) {
    const v = valueOf(r, n);
    if (!v) { console.log(`  ⚠️ ${n}: needed by CI but missing in local .env`); continue; }
    if (!PUSH) { console.log(`  • ${n}: ready to push (${fp(v)})`); continue; }
    try { execFileSync('gh', ['secret', 'set', n, '-R', r.slug], { input: v }); console.log(`  ⬆ ${n}: pushed (${fp(v)})`); }
    catch (e) { console.log(`  ✗ ${n}: ${String(e.stderr || e.message).slice(0, 80)}`); }
  }
}
console.log(PUSH ? '\n✓ Synced local .env -> GitHub secrets across all repos.' : '\n(dry run — re-run with --push to sync)');
