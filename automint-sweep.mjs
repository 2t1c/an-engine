// automint-sweep.mjs — poll every account for drafts tagged `needs-links` and mint them.
//
// THIS REPLACES THE n8n WEBHOOK (operator 2026-08-28). The webhook lane existed for one reason: to
// hold a GitHub token, so a Typefully tag change could dispatch a workflow. A cron needs no token at
// all — it already runs inside the repo with the same secrets the mint itself uses. No n8n, no PAT,
// no credential to attach, nothing to revoke.
//
// The trade is latency for simplicity. GitHub's cron has a five-minute floor and routinely lags five
// to fifteen minutes under load, so a tag is picked up within roughly a quarter hour instead of
// instantly. For minting links onto drafts you are still reviewing, that is not a cost worth paying
// a credential for.
//
// SAFE TO RUN TWICE. automintDraft claims the `minting` tag before it resolves anything and refuses
// a draft already claimed, so two overlapping ticks cannot buy two sets of subids for one thread.
//
//   node automint-sweep.mjs           # find and mint
//   node automint-sweep.mjs --dry     # find and report, mint nothing
//   node automint-sweep.mjs --account kim
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { automintDraft, jevContextFor, TAG_TODO } from './automint.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };

/** Which drafts on one account are asking for links. Pure — the tag shape is all that matters. */
export function tagged(drafts, tag = TAG_TODO) {
  return (drafts || []).filter((d) => (d.tags || [])
    .map((t) => (typeof t === 'string' ? t : (t?.slug ?? t?.name ?? '')))
    .includes(tag));
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', 'LEVANTA_API_KEY']);
  const DRY = args.includes('--dry');
  const only = flag('account', '');
  const tf = typefully(env);

  const accounts = Object.entries(ACCOUNTS)
    .filter(([k, a]) => a?.socialSetId && (!only || k === only));
  const found = [];

  for (const [key, acc] of accounts) {
    // 50 is deep enough to catch anything tagged today without paging the whole archive every tick.
    let list = [];
    try { list = (await tf.get(`/social-sets/${acc.socialSetId}/drafts?limit=50`)).results || []; }
    catch (e) { console.log(`⚠ ${acc.name}: list failed (${String(e.message).slice(0, 60)})`); continue; }
    for (const d of tagged(list)) found.push({ key, acc, draft: d });
  }

  if (!found.length) { console.log(`nothing tagged ${TAG_TODO} across ${accounts.length} account(s)`); return; }
  console.log(`${found.length} draft(s) tagged ${TAG_TODO}:\n`);

  // Jev once per tick, only when something is tagged (decisions/plug-fill.mjs); null = code picks.
  const jev = await jevContextFor(env);
  const tally = {};
  for (const { acc, draft } of found) {
    console.log(`── ${acc.name} · ${draft.id}`);
    try {
      const r = await automintDraft(env, acc, String(draft.id), { dry: DRY, jev });
      tally[r?.status || 'unknown'] = (tally[r?.status || 'unknown'] || 0) + 1;
    } catch (e) {
      // ONE BAD DRAFT MUST NOT END THE SWEEP. A tick that dies on draft three leaves drafts four
      // through eleven waiting a full cron interval for no reason, and the failure is usually
      // specific to that draft rather than to the run.
      console.log(`  ✗ ${String(e.message).slice(0, 110)}`);
      tally.error = (tally.error || 0) + 1;
    }
    console.log('');
  }
  console.log(Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join(' · '));
  if (tally.error) process.exitCode = 1;   // declined is a decision, an error is a defect
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) await runMain(main, 'automint-sweep');
