// draft-inventory.mjs — what is SITTING in every account right now, and why it has not posted.
//
// The fleet's failure mode is silent: a draft that was written but never scheduled, or scheduled as
// "planned" (dated but INERT — Typefully never auto-publishes those until they are confirmed), or
// scheduled into a slot that has already passed. None of these announce themselves; the account
// just quietly goes dark. This walks every active account and buckets everything unpublished.
//
//   node draft-inventory.mjs              # table per account + fleet summary
//   node draft-inventory.mjs --json       # machine-readable
//   node draft-inventory.mjs --account lorenzo
import { isArticleDraft, isStandalonePost } from './monitoring-scope.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');
const NOW = Date.now();

// Pure: classify one draft into an actionable bucket. Exported for tests.
export function classifyDraft(d, { now = Date.now() } = {}) {
  const sched = d.scheduled_date ? Date.parse(d.scheduled_date) : null;
  if (d.status === 'scheduled') {
    if (sched && sched < now) return { bucket: 'overdue', why: 'scheduled time has passed and it has not published' };
    return { bucket: 'scheduled', why: 'queued to auto-publish' };
  }
  if (d.status === 'planned') return { bucket: 'planned-inert', why: 'has a date but will NEVER auto-publish until confirmed' };
  // Typefully marks the whole draft 'error' when ANY platform fails. When X published, only the
  // cross-post failed (owner, 2026-09-24: a Threads failure is "not as important as X").
  if (d.status === 'error') return d.x_post_published_at
    ? { bucket: 'threads-error', why: 'posted on X; only the Threads cross-post failed' }
    : { bucket: 'error', why: 'publishing failed on X' };
  // plain draft
  const age = (now - Date.parse(d.created_at || new Date().toISOString())) / 864e5;
  if (age >= 2) return { bucket: 'stale', why: `unscheduled for ${age.toFixed(0)}d` };
  return { bucket: 'fresh', why: 'unscheduled, written recently' };
}

/** PURE. One unpublished draft's inventory row, or null for a standalone single. A native X Article is
 *  listed (a stuck article goes dark like any draft) and flagged `article`: articles are additive (owner,
 *  R2026-10-03), so one never stands in for the page's thread (emptyAccounts). Fed the drafts LIST, which
 *  carries no platforms, so the title says article: scripts/run-articles.mjs titles every one it makes. */
export function inventoryRow(d, { now = Date.now(), ledgerRow = null } = {}) {
  const article = isArticleDraft(d);
  if (!article && isStandalonePost(d)) return null;
  const ageDays = d.created_at ? (now - Date.parse(d.created_at)) / 864e5 : 0;
  return {
    id: d.id, title: (d.draft_title || d.preview || '').slice(0, 58), status: d.status,
    scheduled: d.scheduled_date || null, ageDays: Number(ageDays.toFixed(1)),
    share: d.share_url, ...classifyDraft(d, { now }),
    monetized: !!ledgerRow?.subid1, source: ledgerRow ? (ledgerRow.handWritten ? 'hand' : 'engine') : 'unknown',
    mold: ledgerRow?.moldId || null, article,
  };
}

/** PURE. The accounts with no THREAD to post: nothing scheduled, fresh or stale except articles. */
export function emptyAccounts(out) {
  return out.filter((a) => !a.drafts.some((r) => !r.article && ['scheduled', 'fresh', 'stale'].includes(r.bucket))).map((a) => a.account);
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);

  // draftId -> ledger row (is it engine/hand made, and is it monetized?)
  const led = new Map();
  for (const l of readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(l); if (e.draftId) led.set(String(e.draftId), e); } catch {}
  }

  const only = arg('account');
  const accounts = Object.values(ACCOUNTS).filter((a) => !a.paused && a.socialSetId && (!only || a.name.toLowerCase().includes(only.toLowerCase())));
  const out = [];
  for (const acc of accounts) {
    const rows = [];
    for (const status of ['draft', 'scheduled', 'planned', 'error']) {
      let offset = 0;
      for (;;) {
        const page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=${status}&limit=50&offset=${offset}&order_by=-created_at`);
        const list = page?.results || [];
        for (const d of list) {
          const row = inventoryRow(d, { now: NOW, ledgerRow: led.get(String(d.id)) });
          if (row) rows.push(row);
        }
        if (list.length < 50) break;
        offset += 50;
      }
    }
    out.push({ account: acc.name, handle: acc.handle, drafts: rows });
  }

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); return; }

  const ORDER = ['overdue', 'error', 'planned-inert', 'stale', 'fresh', 'scheduled', 'threads-error'];
  const ICON = { overdue: '🔴', error: '🔴', 'threads-error': '⚪', 'planned-inert': '🟠', stale: '🟡', fresh: '🟢', scheduled: '📅' };
  const fleet = {};
  console.log(`DRAFT INVENTORY — ${new Date().toISOString().slice(0, 16)}Z · ${accounts.length} active accounts\n`);
  for (const a of out) {
    const by = {};
    for (const r of a.drafts) (by[r.bucket] ||= []).push(r);
    for (const k of Object.keys(by)) fleet[k] = (fleet[k] || 0) + by[k].length;
    const counts = ORDER.filter((k) => by[k]).map((k) => `${ICON[k]}${by[k].length} ${k}`).join('  ');
    console.log(`■ ${a.account} (@${a.handle})  ${counts || 'nothing unpublished'}`);
    for (const k of ORDER) for (const r of (by[k] || [])) {
      console.log(`   ${ICON[k]} ${String(r.id).padEnd(9)} ${r.bucket.padEnd(13)} ${r.monetized ? '$' : ' '}${r.source === 'engine' ? 'E' : r.source === 'hand' ? 'H' : '?'}${r.article ? 'A' : ' '}${r.mold ? ` ${r.mold}` : '   '} ${r.ageDays}d  ${r.title}`);
      if (['overdue', 'planned-inert', 'error'].includes(k)) console.log(`      ↳ ${r.why} · ${r.share || ''}`);
    }
    console.log('');
  }
  console.log(`FLEET: ${ORDER.filter((k) => fleet[k]).map((k) => `${k} ${fleet[k]}`).join(' · ')}`);
  const need = emptyAccounts(out);
  if (need.length) console.log(`EMPTY (no thread to post): ${need.join(', ')}`);
  console.log(`\nlegend: $ = monetized · E = engine-made, H = hand-written, ? = no ledger row · A = X Article (additive: never the page's thread)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'draft-inventory');
