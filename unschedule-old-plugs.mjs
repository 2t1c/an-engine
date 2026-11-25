// unschedule-old-plugs.mjs — pull scheduled threads whose plugs predate the current CTA law.
//
// The CTA shape changed on 2026-08-17: the closer is first-person ("This is my magnesium (Aff
// link):"), replacing the possessive form ("Lorenzo's magnesium pick") and the generic ones ("My
// pick", "Get it here"). Threads written before that are already sitting in the queue set to
// auto-publish. Taking the fleet manual means those come OUT of the queue rather than going live
// under the old shape while we rebuild them.
//
// Unscheduling is non-destructive: publish_at:null returns a scheduled draft to a plain draft.
// Nothing is deleted, nothing is edited, and re-scheduling it later is one call.
//
//   node unschedule-old-plugs.mjs            # dry: list what would be unscheduled and why
//   node unschedule-old-plugs.mjs --go       # unschedule them
//   node unschedule-old-plugs.mjs --account lorenzo --go
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, typefully, runMain } from './lib.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { isTrackedLink, plugSubstanceBridgeIssue } from './checks.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes('--go');
const URL_RE = /https?:\/\/\S+/g;

// Pure: the CTA line is the last non-empty line before the bare link. Exported for tests.
export function ctaLineOf(tweet) {
  const lines = String(tweet || '').split('\n').map((l) => l.trim());
  const linkAt = lines.findIndex((l) => URL_RE.test(l) && isTrackedLink(l));
  if (linkAt < 1) return '';
  for (let i = linkAt - 1; i >= 0; i--) if (lines[i]) return lines[i];
  return '';
}

// The CTA line must carry a first-person RECOMMENDATION — an "I <verb>" the reader can hear a person
// saying: "I use", "I take", "I buy", "the one I reach for". Operator 2026-08-19: a bare possessive
// ("This is my magnesium") is too generic — it states ownership, not endorsement, and the whole job
// of the last line is to endorse. That possessive WAS the law until this date, so it is still
// recognised by name rather than falling into 'other' — a thread carrying it is dated, not broken.
//
// WIDENED 2026-08-30, to the law's own stated intent and no further. The list was thirteen present-
// tense verbs with nothing permitted between "I" and the verb, which rejected 23 of the library's
// CTA lines. Reading them, 13 are exactly what this rule says it wants — "the one I never skip",
// "the collagen I actually use", "the gut formula I kept", "the B12 I switched to" — blocked only by
// tense, by an adverb, or by a verb nobody thought to list. Worse, the narrowness was self-defeating:
// the safe way to satisfy a closed list is "This is the X I take", so the rule against generic
// closers was itself manufacturing generic closers. 17 of the 18 rewritten pods open their CTA
// "Since you'll ask, I take this one".
//
// The other 10 stay rejected, and should: "the turmeric that absorbs", "the one that survived the
// hype", "the form that took" describe the PRODUCT, not the speaker. No first person, no endorsement.
//
// NEGATION IS THE TRAP. "I never skip this" endorses; "I never use this" is a rejection, and a blanket
// adverb allowance would pass both. So negatives are admitted only with cessation verbs — the ones
// where not-doing-it IS the endorsement — and every other adverb is positive by enumeration.
const CTA_VERB = '(use|take|buy|recommend|keep|get|order|reorder|restock|run|trust|finish|dissolve'
  + '|used|took|bought|kept|got|ordered|reordered|restocked|trusted|finished|dissolved'
  + '|stick with|stuck with|reach for|reached for|swear by|swore by|go back to|went back to'
  + '|settle on|settled on|switch to|switched to|move to|moved to|come back to|came back to)';
const CTA_ADVERB = '(actually|still|genuinely|honestly|personally|only|happily|always|now|finally|just|quietly)';
// Present continuous (operator 2026-09-02, the backline closer: "this is the one I'm using"). Same
// verbs, -ing form, behind "I'm" or "I am". A person recommending something out loud says "the one
// I'm taking" at least as often as "the one I take"; the law never meant to prefer one tense.
const CTA_VERB_ING = '(using|taking|buying|recommending|keeping|getting|ordering|reordering|restocking|running|trusting|finishing'
  + '|sticking with|reaching for|swearing by|going back to|settling on|switching to|moving to|coming back to)';
const CTA_RECOMMEND_VERB = new RegExp(
  `\\bi\\s+(?:${CTA_ADVERB}\\s+)?${CTA_VERB}\\b`
  + `|\\bi(?:'m|\\s+am)\\s+(?:${CTA_ADVERB}\\s+)?${CTA_VERB_ING}\\b`
  + `|\\bi\\s+(?:never|do not|don't|no longer)\\s+(skip|miss|run out of|run out)\\b`, 'i');

// Pure: does this CTA follow the CURRENT law? Exported for tests.
export function ctaStyleOf(ctaLine) {
  const s = String(ctaLine || '').trim();
  if (!s) return { style: 'none', current: false, why: 'no CTA line before the link' };
  if (CTA_RECOMMEND_VERB.test(s)) return { style: 'recommendation', current: true, why: '' };
  if (/^this is my\b/i.test(s)) return { style: 'possessive-only', current: false, why: 'the possessive closer replaced on 2026-08-19 — say what you DO with it ("I use", "I take"), not that you own it' };
  if (/^[A-Z][a-z]+'s\b/.test(s)) return { style: 'persona-possessive', current: false, why: 'the possessive closer the operator replaced ("X\'s pick")' };
  if (/^(my|our)\b/i.test(s)) return { style: 'bare-possessive', current: false, why: 'generic "My pick" — names no substance' };
  if (/^get it here/i.test(s)) return { style: 'get-it-here', current: false, why: 'the old direct-response closer' };
  return { style: 'other', current: false, why: `unrecognised CTA shape: "${s.slice(0, 46)}"` };
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY']);
  const tf = typefully(env);
  const only = arg('account');
  // Monetized accounts only: an unmonetized page has no plugs and nothing to judge.
  const accounts = Object.values(ACCOUNTS).filter((a) => !a.paused && a.socialSetId && a.levantaSubidPrefix
    && (!only || a.name.toLowerCase().includes(only.toLowerCase())));

  const old = [], kept = [];
  for (const acc of accounts) {
    const heads = [];
    for (let offset = 0; ; offset += 50) {
      const page = await tf.get(`/social-sets/${acc.socialSetId}/drafts?status=scheduled&limit=50&offset=${offset}&order_by=scheduled_date`);
      const list = page?.results || [];
      heads.push(...list);
      if (list.length < 50) break;
    }
    for (const h of heads) {
      let full; try { full = await tf.getDraft(acc.socialSetId, h.id); } catch { continue; }
      const tweets = (full?.platforms?.x?.posts || []).map((p) => String(p.text || ''));
      const plugIdx = tweets.map((t, i) => ((t.match(URL_RE) || []).some(isTrackedLink) ? i : -1)).filter((i) => i >= 0);
      if (!plugIdx.length) continue; // nothing plugged — not what this tool is about
      const ctas = plugIdx.map((i) => ({ tweet: i + 1, ...ctaStyleOf(ctaLineOf(tweets[i])), line: ctaLineOf(tweets[i]) }));
      const stale = ctas.filter((c) => !c.current);
      // Bridge law is the other half of "the old way": a plug whose prior tweet never named the
      // substance. Judged only where the link tells us which product it is.
      const links = [...new Set(tweets.join('\n').match(URL_RE) || [])].filter(isTrackedLink);
      const bridge = plugSubstanceBridgeIssue(tweets, links.map((l) => ({ link: l, title: '' })));
      const row = { acc: acc.name, ssid: acc.socialSetId, id: h.id, when: h.scheduled_date,
        title: (h.draft_title || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 44), ctas, bridge };
      (stale.length ? old : kept).push(row);
    }
  }

  console.log(`SCHEDULED THREADS WITH A PLUG — ${old.length} on the OLD CTA, ${kept.length} on the current one\n`);
  for (const r of old) {
    console.log(`✗ ${String(r.when).slice(0, 16)}  ${r.acc.padEnd(15)} ${r.id}  ${r.title}`);
    for (const c of r.ctas) console.log(`     tweet ${String(c.tweet).padStart(2)} [${c.style}] "${c.line.slice(0, 52)}"${c.current ? ' ✓' : ` — ${c.why}`}`);
    if (r.bridge) console.log(`     ${r.bridge.slice(0, 110)}`);
  }
  if (kept.length) {
    console.log(`\nLEFT SCHEDULED (already on "This is my"):`);
    for (const r of kept) console.log(`  ✓ ${String(r.when).slice(0, 16)}  ${r.acc.padEnd(15)} ${r.id}  ${r.title}`);
  }
  if (!GO) { console.log(`\n(dry — nothing changed. --go to unschedule the ${old.length} above)`); return; }

  let n = 0;
  for (const r of old) {
    // publish_at:null returns it to a plain draft. Nothing is deleted or edited.
    try { await tf.patchDraft(r.ssid, r.id, { publish_at: null }); n++; console.log(`  unscheduled ${r.id} (${r.acc})`); }
    catch (e) { console.warn(`  ⚠ ${r.id}: ${String(e.message).slice(0, 90)}`); }
  }
  console.log(`\n✓ ${n} thread(s) unscheduled — still drafts, nothing deleted, re-schedule any of them with one call`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, 'unschedule-old-plugs');
