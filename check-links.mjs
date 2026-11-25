// check-links.mjs — does every plug link in a thread actually go where we think it goes?
//
// Built 2026-08-18 after a one-character truncation shipped inside a scheduled draft. The link
// returned HTTP 200 and looked fine; it landed on the amazon.com HOMEPAGE. No product, no
// attribution, $0 — and every existing check passed it, because they all stop at "is it a tracked
// URL" and "does it respond". Neither question is the one that matters.
//
// The one that matters: FOLLOW the redirect, read the FINAL url, and confirm it is the ASIN this
// thread's ledger row says we are selling. That also makes the reverse lookup possible — hand it a
// bare link and it names the draft, the account, the tweet and the product it belongs to.
//
//   node check-links.mjs --draft 10380538          # audit one draft
//   node check-links.mjs --account marcos          # every unpublished draft on an account
//   node check-links.mjs --link https://lvnta.com/lv_x   # reverse: which thread owns this link?
//   node check-links.mjs --draft 10380538 --json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain, HERE_DIR } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { isTrackedLink, malformedLevanta } from './checks.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_RE = /https?:\/\/\S+/g;

/** Pure: the ASIN a destination URL points at, or null when it is not a product page.
 *  The trailing (?![A-Za-z0-9]) closes the phantom-ASIN hole: an 11+-char segment after /dp/
 *  must return null, not its first 10 chars credited with a real link's money (audit 2026-08-25). */
export function asinOfUrl(url = '') {
  const m = String(url).match(/\/dp\/([A-Z0-9]{10})(?![A-Za-z0-9])|\/gp\/product\/([A-Z0-9]{10})(?![A-Za-z0-9])/i);
  return m ? (m[1] || m[2]).toUpperCase() : null;
}

/** Pure: strip trailing punctuation a writer glued onto a URL ("...abc)." -> "...abc"). */
export const cleanUrl = (u = '') => String(u).replace(/[.,;:)\]}'"]+$/, '');

/**
 * Follow one link and report where it really lands. Network, so not pure.
 * Returns { url, status, final, asin, hasAttribution, ok, why }.
 */
export async function resolveLink(url, { timeoutMs = 25000 } = {}) {
  const out = { url, status: 0, final: null, asin: null, hasAttribution: false, ok: false, why: '' };
  if (!isTrackedLink(url)) { out.why = 'not a tracked link — no commission can attach'; return out; }
  const bad = malformedLevanta(url);
  if (bad) { out.why = 'malformed lvnta link (no slug) — permanently dead'; return out; }
  const ctl = AbortSignal.timeout(timeoutMs);
  let res;
  try { res = await fetch(url, { redirect: 'follow', signal: ctl }); }
  catch (e) { out.why = `unreachable: ${String(e.message).slice(0, 60)}`; return out; }
  out.status = res.status;
  out.final = res.url || null;
  out.asin = asinOfUrl(out.final);
  out.hasAttribution = /[?&](maas|tag|aa_adgroupid|ref)=/i.test(out.final || '');
  if (!res.ok) out.why = `HTTP ${res.status}`;
  // THE check. A 200 onto the storefront is the failure mode that started this file: the link works,
  // the redirect works, and the reader lands on a page selling nothing we chose.
  else if (!out.asin) out.why = 'resolves to a NON-PRODUCT page (storefront/search) — reader lands nowhere, $0';
  else if (!out.hasAttribution) out.why = 'product page but NO attribution params — the click earns nothing';
  else { out.ok = true; out.why = 'ok'; }
  return out;
}

// ---- ledger index: link -> the thread that owns it ------------------------------------------------
function ledgerRows() {
  return readFileSync(join(HERE_DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Pure-ish: every (link, asin, subid, draftId, account) the ledger knows, newest last. */
export function linkIndex(rows = ledgerRows()) {
  const idx = new Map();
  for (const r of rows) {
    // Each slot carries its OWN product name. Pairing link2 with r.product (the HEAVY product's
    // name) made the reverse lookup confidently mislabel every light plug — caught on its first run.
    for (const [link, asin, subid, product] of [
      [r.link, r.asin, r.subid1, r.product],
      [r.link2, r.asin2, r.subid1b, r.product2],
      [r.glink, r.asin, r.subid1, r.product],
      [r.glink2, r.asin2, r.subid1b, r.product2],
    ]) {
      if (!link) continue;
      idx.set(cleanUrl(link), { link, asin, subid, draftId: String(r.draftId), account: r.account, product, ts: r.ts });
    }
  }
  return idx;
}

/** Which thread owns this link? The reverse lookup the operator asked for. */
export function ownerOf(link, idx = linkIndex()) { return idx.get(cleanUrl(link)) || null; }

/**
 * The clickable Typefully URL for a draft. A draft ID is not something a human can act on — the
 * whole point of the reverse lookup is to get from a broken link to the OPEN TAB where it is fixed
 * (operator, 2026-08-18). share_url is the good one (public, no account context needed); when a
 * draft was never shared, the private editor URL still opens for us and needs the social set id.
 */
export async function draftUrl(tf, acc, draftId) {
  try {
    const d = await tf.getDraft(acc.socialSetId, Number(draftId));
    return d?.share_url || `https://typefully.com/?d=${draftId}&a=${acc.socialSetId}`;
  } catch { return `https://typefully.com/?d=${draftId}&a=${acc.socialSetId}`; }
}

async function auditDraft(tf, acc, draftId, idx) {
  const full = await tf.getDraft(acc.socialSetId, Number(draftId));
  const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
  const rows = ledgerRows().filter((r) => String(r.draftId) === String(draftId));
  // What this thread is SUPPOSED to sell, by ledger.
  const expect = new Map();
  for (const r of rows) {
    if (r.asin && r.link) expect.set(cleanUrl(r.link), r.asin);
    if (r.asin2 && r.link2) expect.set(cleanUrl(r.link2), r.asin2);
    // A geni.us plug wraps the row's link; the ledger records it as glink/glink2 beside it.
    if (r.asin && r.glink) expect.set(cleanUrl(r.glink), r.asin);
    if (r.asin2 && r.glink2) expect.set(cleanUrl(r.glink2), r.asin2);
  }
  const findings = [];
  for (const [i, t] of tweets.entries()) {
    for (const raw of (t.match(URL_RE) || [])) {
      const url = cleanUrl(raw);
      if (!isTrackedLink(url)) continue;
      const res = await resolveLink(url);
      const want = expect.get(url) || null;
      const owner = ownerOf(url, idx);
      // Mismatch = the link resolves fine but to a DIFFERENT product than the ledger records, so
      // revenue attributes to a product the thread never argued for.
      const mismatch = want && res.asin && want !== res.asin;
      const foreign = owner && String(owner.draftId) !== String(draftId) ? owner : null;
      if (foreign) {
        const oAcc = Object.values(ACCOUNTS).find((a) => a.name === foreign.account);
        foreign.url = oAcc ? await draftUrl(tf, oAcc, foreign.draftId) : null;
      }
      findings.push({
        tweet: i + 1, url, ...res, expectedAsin: want, mismatch,
        trailingJunk: raw !== url, owner: foreign,
      });
    }
  }
  return { draftId: String(draftId), account: acc.name, title: full?.draft_title || '', shareUrl: full?.share_url || '', tweets: tweets.length, findings };
}

function print(rep) {
  console.log(`\nLINK CHECK — ${rep.account} draft ${rep.draftId} · ${rep.tweets} tweets · ${rep.shareUrl}`);
  console.log(`${rep.title}\n`);
  if (!rep.findings.length) { console.log('  (no tracked links in this thread)'); return 0; }
  let bad = 0;
  for (const f of rep.findings) {
    const fail = !f.ok || f.mismatch || f.trailingJunk;
    if (fail) bad++;
    console.log(`  ${fail ? '✗' : '✓'} tweet ${String(f.tweet).padStart(2)}  ${f.asin || '(no asin)'}  ${f.url.slice(0, 52)}`);
    console.log(`       -> ${(f.final || '(never resolved)').slice(0, 96)}`);
    if (!f.ok) console.log(`       ! ${f.why}`);
    if (f.mismatch) console.log(`       ! LEDGER SAYS ${f.expectedAsin} — this link sells ${f.asin}; revenue attributes to the wrong product`);
    if (f.trailingJunk) console.log('       ! trailing punctuation glued to the URL — some clients will break the link');
    if (f.owner) {
      console.log(`       ! this link belongs to draft ${f.owner.draftId} (${f.owner.account}) — reusing it merges two threads' revenue`);
      if (f.owner.url) console.log(`         ${f.owner.url}`);
    }
  }
  console.log(`\n  ${rep.findings.length - bad}/${rep.findings.length} clean`);
  return bad;
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const idx = linkIndex();

  // reverse lookup: hand it a link, it names the thread
  const link = arg('link');
  if (link) {
    const res = await resolveLink(cleanUrl(link));
    const own = ownerOf(link, idx);
    console.log(`\nLINK  ${link}`);
    console.log(`  resolves -> ${(res.final || '(never resolved)').slice(0, 100)}`);
    console.log(`  asin ${res.asin || '(none)'} · attribution ${res.hasAttribution ? 'present' : 'MISSING'} · ${res.ok ? 'OK' : 'FAIL: ' + res.why}`);
    if (own) {
      const oAcc = Object.values(ACCOUNTS).find((a) => a.name === own.account);
      const url = oAcc ? await draftUrl(tf, oAcc, own.draftId) : null;
      console.log(`  BELONGS TO: draft ${own.draftId} (${own.account})`);
      if (url) console.log(`     OPEN:    ${url}`);
      console.log(`     product: ${own.product || own.asin}`);
      console.log(`     subid:   ${own.subid}`);
      console.log(`     minted:  ${(own.ts || '').slice(0, 19)}`);
      if (own.asin && res.asin && own.asin !== res.asin) console.log(`     ! the ledger records ${own.asin} but the link lands on ${res.asin}`);
    } else console.log('  BELONGS TO: no ledger row — an unattributed link (manual mint or pre-ledger thread)');
    return;
  }

  const targets = [];
  const draftId = arg('draft');
  const accountKey = (arg('account') || '').toLowerCase();
  if (draftId) {
    const rows = ledgerRows().filter((r) => String(r.draftId) === String(draftId));
    // geni-swap.mjs writes the account KEY ("julian") to the ledger, older writers the display name ("Julian").
    const owner = rows[0]?.account;
    const acc = Object.values(ACCOUNTS).find((a) => a.name === owner) || ACCOUNTS[owner] || ACCOUNTS[accountKey];
    if (!acc) throw new Error('cannot resolve the account — pass --account <key>');
    targets.push([acc, draftId]);
  } else if (accountKey) {
    const acc = ACCOUNTS[accountKey];
    if (!acc) throw new Error(`unknown account "${accountKey}"`);
    // Ask the API for each status and PAGE it, rather than pulling one page of 50 across all
    // statuses and filtering client-side. The old form silently checked a fraction of a busy
    // account: 50 rows dominated by published drafts can contain no unpublished ones at all, and
    // the run still reported '0 broken link(s)' — a clean bill of health for an unread queue.
    for (const status of ['draft', 'scheduled']) {
      for (let offset = 0; ; offset += 50) {
        const page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=${status}&limit=50&offset=${offset}`);
        const list = page?.results || [];
        for (const d of list) targets.push([acc, d.id]);
        if (list.length < 50) break;
      }
    }
  } else throw new Error('pass --draft <id>, --account <key>, or --link <url>');

  let bad = 0; const reports = [];
  for (const [acc, id] of targets) {
    const rep = await auditDraft(tf, acc, id, idx);
    reports.push(rep);
    bad += print(rep);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(reports, null, 1));
  if (bad) { console.log(`\n${bad} broken link(s) — fix before scheduling.`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'check-links');
