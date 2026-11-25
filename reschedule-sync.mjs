// reschedule-sync.mjs — Airtable -> Typefully (the "drag a card" direction).
// Airtable is the master scheduling calendar. For every Scheduled row whose
// "Posted Date" differs from the Typefully draft's scheduled_date, push the
// Airtable date to Typefully (publish_at). Guards: Scheduled-only, future-only,
// 60s tolerance (no churn). The reverse direction (status/published/analytics/
// revenue) is owned by the webhook + registry-sync — so the two never loop.
//   node reschedule-sync.mjs          # reconcile -> push changes to Typefully
//   node reschedule-sync.mjs --dry    # show what would change, no writes
// Env: AIRTABLE_PAT, REGISTRY_BASE_ID, TYPEFULLY_API_KEY (+ Telegram via Airtable Config)
import { loadEnv, requireEnv, typefully, telegram, esc, fmtSaigon, report } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { REGISTRY_TABLE } from './config.mjs';

const DRY = process.argv.includes('--dry');
const TABLE = encodeURIComponent(REGISTRY_TABLE);
const TOLERANCE_MS = 60_000;
const ssidByAccount = Object.fromEntries(Object.values(ACCOUNTS).map((a) => [a.name, a.socialSetId]));

async function scheduledRows(env) {
  const h = { Authorization: `Bearer ${env.AIRTABLE_PAT}` };
  const out = [];
  let offset;
  do {
    const u = `https://api.airtable.com/v0/${env.REGISTRY_BASE_ID}/${TABLE}?pageSize=100${offset ? `&offset=${offset}` : ''}` +
      `&filterByFormula=${encodeURIComponent('{Status}="Scheduled"')}` +
      ['Draft ID', 'Account', 'Posted Date', 'Post'].map((f) => `&fields%5B%5D=${encodeURIComponent(f)}`).join('');
    const r = await fetch(u, { headers: h });
    if (!r.ok) throw new Error(`Airtable list -> ${r.status}: ${await r.text()}`);
    const d = await r.json();
    out.push(...d.records);
    offset = d.offset;
  } while (offset);
  return out;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const rows = await scheduledRows(env);
  console.log(`${rows.length} scheduled row(s) to reconcile`);

  const changes = [];
  for (const r of rows) {
    const f = r.fields;
    const draftId = f['Draft ID'], want = f['Posted Date'];
    const ssid = ssidByAccount[f.Account];
    if (!draftId || !want || !ssid) continue;
    const wantMs = Date.parse(want);
    if (wantMs < Date.now()) { console.log(`  ⏭  ${f.Post?.slice(0, 40)} — Airtable date is in the past, skipped`); continue; }
    let draft;
    try { draft = await tf.getDraft(ssid, draftId); } catch { continue; }
    if (draft.status !== 'scheduled') continue; // can't move a live/published post
    const haveMs = draft.scheduled_date ? Date.parse(draft.scheduled_date) : 0;
    if (Math.abs(wantMs - haveMs) <= TOLERANCE_MS) continue; // already in sync
    changes.push({ draftId, ssid, want, from: draft.scheduled_date, post: f.Post || draftId, share: draft.share_url });
    if (!DRY) await tf.patchDraft(ssid, draftId, { publish_at: want });
    console.log(`  ${DRY ? '(would) ' : '✓ '}${(f.Post || draftId).slice(0, 45)}: ${draft.scheduled_date} -> ${want}`);
  }

  if (!changes.length) { console.log('Everything already in sync.'); return; }
  if (!DRY) {
    await telegram(env, report({
      emoji: '📅', title: 'Calendar Sync', scope: 'Airtable → Typefully',
      status: `✅ <b>${changes.length}</b> post(s) rescheduled from the calendar`,
      sections: [{ label: 'CHANGES', body:
        changes.map((c) => `• <a href="${c.share || `https://typefully.com/?d=${c.draftId}&a=${c.ssid}`}">${esc(String(c.post).slice(0, 50))}</a>\n   → <b>${fmtSaigon(c.want, true)}</b> Saigon`).join('\n\n') }],
      action: 'Verify in Typefully.',
    }), 'calendar');
  }
  console.log(`${DRY ? 'Would reschedule' : 'Rescheduled'} ${changes.length}.`);
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
