// calendar.mjs — daily "what's publishing today" digest across ALL accounts -> 📅 Calendar topic.
// Lists every draft scheduled to go out TODAY (Asia/Saigon), in time order, with a Typefully link.
//   node calendar.mjs            # send digest
//   node calendar.mjs --dry      # console only
import { loadEnv, requireEnv, telegram, esc, fmtSaigon, report, typefully } from './lib.mjs';
import { SEND_STATE_DIGESTS } from './config.mjs';
import { ACCOUNTS, getAccount } from './accounts.mjs';

const DRY = process.argv.includes('--dry');
const TZ = 'Asia/Saigon';
const dayStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const today = dayStr(new Date());
  const accounts = Object.keys(ACCOUNTS).map(getAccount).filter((a) => a.socialSetId && !a.external); // external = client (RT bridge only), not in our calendar
  const tf = typefully(env);

  const items = [];
  for (const a of accounts) {
    const rows = await tf.listAll(`/social-sets/${a.socialSetId}/drafts`);
    for (const d of rows) {
        if (d.scheduled_date && dayStr(new Date(d.scheduled_date)) === today && String(d.status).toLowerCase() !== 'published') {
          items.push({ acct: a.name, at: d.scheduled_date, id: d.id, ss: a.socialSetId, share: d.share_url, title: (d.draft_title || `Draft ${d.id}`).replace(/^\[[^\]]*\]\s*\w*\s*[—-]?\s*/, '').slice(0, 60) });
        }
    }
  }
  items.sort((x, y) => new Date(x.at) - new Date(y.at));

  const acctCount = new Set(items.map((i) => i.acct)).size;
  const out = report({
    emoji: '📅',
    title: 'Publishing Today',
    scope: fmtSaigon(new Date().toISOString(), true).replace(/,?\s*\d{1,2}:\d{2}.*$/, ''),
    status: items.length
      ? `🆕 <b>${items.length}</b> post(s) across ${acctCount} account(s)`
      : '💤 Nothing scheduled for today',
    sections: items.length
      ? [{ label: 'TODAY', body: items.map((it) => `🕒 <b>${esc(fmtSaigon(it.at, true))}</b> · ${esc(it.acct)}\n   <a href="${it.share || `https://typefully.com/?d=${it.id}&a=${it.ss}`}">${esc(it.title)}</a>`).join('\n\n') }]
      : [],
  });
  console.log(out.replace(/<[^>]+>/g, ''));
  if (!DRY && SEND_STATE_DIGESTS) { await telegram(env, out, 'calendar'); console.log('\n✓ Sent to 📅 Calendar'); }
  else if (!DRY) console.log('\n(quiet: state digest — the dashboard renders this. SEND_STATE_DIGESTS in config.mjs restores it.)');
}
main().catch((e) => { console.error('ERROR:', e.stack || e.message); process.exit(1); });
