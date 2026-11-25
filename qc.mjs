// qc.mjs — 4:30pm Saigon FINAL QC pass over every draft scheduled to post today, + a self-improving
// retro. For each scheduled draft it: (1) READS THE REFERENCE thread from the scratchpad/Airtable so it
// can judge faithfulness, (2) runs the shared deterministic gate (checks.mjs), (3) runs LLM judgments
// (does each plug satisfy the CTA principles? is the hook faithful?), (4) auto-fixes what is safe and
// flags the rest, (5) reports cleanly to the 🛡️ QC Telegram topic. Then a RETRO reads GOALS.md + the
// run's findings and fixes ROOT CAUSES (appends generator rules / logs proposals) — not capped at one.
// Mirrors style/thread-checklist.md.
//
//   node qc.mjs                 # all live accounts, drafts scheduled in the next 18h
//   node qc.mjs --dry           # check + print, never patch / send / write
//   node qc.mjs --account julian
//   node qc.mjs --draft 9469443 # one draft (ignores the window)
//   node qc.mjs --hours 18      # lookahead window (default 18)
//   node qc.mjs --no-retro      # skip the self-improvement step
import { buildPlatforms, rebuildCrossPosts } from './platforms.mjs';
import { DISCLOSURE_LINE_RE, discloseBlock, isDisclosed } from './disclosure.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv, LLM_KEYS, airtable, typefully, anthropic, FLEET_MODEL, telegram, esc, fmtSaigon, report, HERE_DIR, flushLlmSpend } from './lib.mjs';
import { ACCOUNTS, getAccount } from './accounts.mjs';
import { VOICE_BLOCKS_ON, signOffOf } from './laws.mjs';
import { checkThread, numberingIssue, renumberLeadingMarkers, leadingNumbers, effLen, plugTextLen, PLUG_LIMIT, TWEET_LIMIT, shortName, ctaSubReason, plugStructure, normalizePlugStructure, plugFingerprint, hookStrength, hookFirstItemIssue, srcTweet1AttachesItem, hookAttachIssue, attachFirstItemToHook, realignPosts, plugSubstanceMismatch, absoluteSuperlativeIssue, stripGenericSignoff, respaceWall, closingTexts, disclaimerTexts, stripDashes as stripEmDash, crossPostIntegrity } from './checks.mjs';
import { loadHookBank } from './skeleton.mjs'; // hook-strength corpus (skeleton-mode drafts)
import { TABLES } from './config.mjs';
import { runRetro } from './retro-core.mjs';
import { judgePlug } from './cta.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NO_RETRO = args.includes('--no-retro');
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const ONE = flag('draft');
const HOURS = parseInt(flag('hours', '18'), 10);
const ONLY = flag('account');
const THREADS = TABLES.swipe;

// stripEmDash = shared stripDashes from checks.mjs (dash-only; QC/judge inputs are existing posts, not fresh LLM output)
const linkOf = (t) => (t.match(/https?:\/\/\S+/) || [''])[0];

function draftLink(draft, posts) {
  const m = (draft.scratchpad_text || '').match(/Link:\s*(https?:\/\/\S+)/i);
  if (m) return m[1];
  for (const p of posts) { const u = linkOf(p.text); if (/lvnta\.com|gumroad\.com|levanta|geni\.us\//i.test(u)) return u; }
  return '';
}

// draftId -> Set of judge-approved (prior, plug) fingerprints recorded at generation (recreate.mjs).
// UNION across duplicate draftId lines (a --update re-run appends a second ledger line for the same
// draft). Used to skip the nightly judgePlug re-run on pairs the judge already passed byte-identically
// — a clean monetized draft drops from 3 baseline LLM calls (2× judgePlug + judgeHook) to 1, and a
// nondeterministic re-judge can no longer trigger a rewrite/regenPlug cascade on approved content.
function loadPlugFp() {
  const m = new Map();
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (!e.draftId || !Array.isArray(e.plugFp)) continue;
      const s = m.get(String(e.draftId)) || new Set();
      for (const fp of e.plugFp) s.add(fp);
      m.set(String(e.draftId), s);
    } catch {}
  }
  return m;
}

// ---- READ THE REFERENCE (scratchpad/ledger -> Airtable swipe row + child tweets) ----
function sourceUrlFor(draft) {
  const m = (draft.scratchpad_text || '').match(/Source:\s*(?:@\S+\s*[—-]\s*)?(https?:\/\/x\.com\/\S+?\/status\/\d+)/i);
  if (m) return m[1];
  const f = join(HERE_DIR, 'ledger.jsonl');
  if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (String(e.draftId) === String(draft.id)) return e.sourceUrl; } catch {}
  }
  return '';
}
async function loadReference(env, draft) {
  if (!env.AIRTABLE_PAT || !env.XDB_BASE_ID) return null;
  const url = sourceUrlFor(draft);
  if (!url) return null;
  try {
    const at = airtable(env);
    const recs = await at.list(THREADS, { formula: `{Tweet URL}="${url}"`, pageSize: 1 });
    if (!recs.length) return null;
    const rows = [];
    for (const id of recs[0].fields.Tweets || []) {
      const f = (await at.getRecord(THREADS, id)).fields;
      rows.push({ n: f['Tweet Number'] || 0, text: f.Text || '' });
    }
    rows.sort((a, b) => a.n - b.n);
    const texts = rows.map((r) => r.text).filter(Boolean);
    return { url, texts, hook: texts[0] || '', itemCount: texts.flatMap(leadingNumbers).length };
  } catch { return null; }
}

// ---- LLM single-tweet rewrites (each contained + re-validated before accepted) ----
async function tighten(env, account, text, isPlug) {
  const link = linkOf(text);
  const instr = isPlug
    ? `Shorten this X post so its TEXT EXCLUDING the link is UNDER ${PLUG_LIMIT} chars. Key point first, keep the URL verbatim, keep the "Aff link" line, keep ${account.name}'s personal first-person voice. No em dashes. Return ONLY the post.`
    : `Shorten this X post to UNDER ${TWEET_LIMIT} chars (a URL counts as 23). Keep the meaning, ${account.name}'s calm voice, the line-break rhythm, any numbering, and any URL verbatim. No em dashes. Return ONLY the post.`;
  const out = (await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 600, messages: [{ role: 'user', content: `${instr}\n\n${text}` }] })).trim().replace(/^```[\s\S]*?\n|\n```$/g, '').trim();
  let fixed = stripEmDash(out);
  if (link && !fixed.includes(link)) fixed += `\n\n${link}`;
  if (link && DISCLOSURE_LINE_RE.test(text) && !isDisclosed(fixed)) fixed = fixed.replace(link, discloseBlock(link));
  // Fresh LLM output for a PLUG is canonicalized exactly as the generation path does (recreate.mjs:365):
  // the tightener routinely returns the three sentence lines stacked with single "\n", which would
  // otherwise ship tonight's repaired plug carrying the very 'cta:spacing'/'merged-lines' defect QC
  // exists to clear. Mechanical only — never touches words. Normalize BEFORE the length gate below, so
  // the blank lines it re-adds are counted rather than silently pushing the plug over the limit.
  if (isPlug) fixed = normalizePlugStructure(fixed);
  return (isPlug ? plugTextLen(fixed) <= PLUG_LIMIT : effLen(fixed) <= TWEET_LIMIT) ? fixed : null;
}

// Auto-fix a failing plug: spin off an LLM fixer to REGENERATE it resolving the specific CTA defect,
// then re-validate (length + disclosure + judgePlug). Returns the repaired plug, or null if it still fails.
async function regenPlug(env, account, prior, productTitle, link, reason) {
  if (!productTitle || !link) return null;
  const name = shortName(productTitle);
  const out = (await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 500, messages: [{ role: 'user', content:
`Rewrite this affiliate plug to FIX this specific defect: "${reason}".
@${account.handle} (${account.name})${VOICE_BLOCKS_ON && account.voice ? ` — VOICE: ${account.voice}` : ''}
PRODUCT: ${productTitle}
PRIOR TWEET (bridge from ITS specific idea, never open on a new topic):
${prior}
Shape — exactly THREE short sentences + disclosure, ONE SENTENCE PER LINE, a BLANK LINE between each (never two sentences sharing a line or two lines stacked — scannability is mandatory), TEXT EXCLUDING THE LINK under ${PLUG_LIMIT} chars:
<line 1: one short big-idea sentence continuing the prior tweet AND naming the lead concept — the substance (e.g. magnesium) or the core symptom (e.g. cortisol)>

<line 2: "Research links <substance> to <that same concept>, <benefit>, and <benefit>." — verb is an association (links/ties/is linked to), NEVER "proves" or any cure/treat/prevent claim; the first benefit continues line 1's concept; benefits punchy, no disease names>

<line 3: a first-person HEDGED superlative naming ${name} ONCE (short name), DISCLOSING INLINE and ending " (#ad):" — "${name} is the best-... one I've tried (#ad):" / "one of the best I've found (#ad):" — never an absolute like "the best ...">

${link}
The disclosure is INLINE on the superlative line and the link stands alone below it. NEVER emit "#ad" or "Aff link:" on a line of its own — cta-spec.md §6 shows the inline form is the only shape that satisfies all three plug gates at once, and this repair path fed the judge that re-validates its own output. The product appears only inside the superlative line by its short name. No em dashes. Return ONLY the plug text.` }] })).trim();
  let p = stripEmDash(String(out).replace(/^```[\s\S]*?\n|\n```$/g, '').trim());
  if (!p.includes(link)) p += `\n\n${link}`;
  if (!isDisclosed(p)) p = p.replace(link, discloseBlock(link));
  p = normalizePlugStructure(p); // same deterministic shape pass generation runs on fresh plug output

  if (plugTextLen(p) > PLUG_LIMIT) { const t = await tighten(env, account, p, true); if (!t) return null; p = t; }
  const v = await judgePlug(env, account, prior, p);
  if (v.unjudged) console.log(`     ↳ regenerated plug not accepted: CTA judge unread (${v.reason})`);
  return v.ok === true ? p : null; // an unread judge is not a pass (plan §1.2.1) — same as a failed one
}

// judgePlug now lives in cta.mjs (shared with recreate.mjs so generation + QC use one CTA brain).

// Hook faithfulness vs the reference -> { faithful:true } | { faithful:false, reason }
//   | { faithful:null, unjudged:true, reason } when the judge could not be read. Fail safe, never fail
// open: an API error or a reply that is not a JSON verdict is "not read", never "faithful".
// { faithful:null, skipped:true } = no source hook to compare against (nothing was asked).
export async function judgeHook(env, account, refHook, ourHook) {
  if (!refHook) return { faithful: null, skipped: true };
  try {
    const out = await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 200, messages: [{ role: 'user',
      content: `Source hook:\n${refHook}\n\nOur hook:\n${ourHook}\n\nDoes our hook keep the SAME frame, promise type, and first item as the source (a faithful ~95% recreation, not a downgrade to something generic)? Reply ONLY JSON {"faithful":true} or {"faithful":false,"reason":"<6 words max>"}.` }] });
    let j = null;
    try { j = JSON.parse((String(out ?? '').match(/\{[\s\S]*\}/) || [''])[0]); } catch {}
    if (!j || typeof j.faithful !== 'boolean') return { faithful: null, unjudged: true, reason: 'judge reply unparseable' };
    return j.faithful ? { faithful: true } : { faithful: false, reason: j.reason || 'hook drifted from source' };
  } catch (e) { return { faithful: null, unjudged: true, reason: `judge error: ${String(e?.message || e).slice(0, 80)}` }; }
}

// ---- LLM renumber for the rare "numbering broken" case, strictly re-validated ----
async function renumber(env, posts, link, account) {
  const texts = posts.map((p) => p.text);
  const prompt = `This X thread is a numbered list whose numbering is broken. Re-add/fix numbers so every list item is numbered continuously 1..N in posting order. Do NOT change wording. Do NOT touch the plug tweets (they contain a link), the sign-off, or the disclaimer. Return ONLY a JSON array of corrected tweet texts, same length/order.\n\n${JSON.stringify(texts)}`;
  try {
    const raw = JSON.parse((((await anthropic(env, { role: 'aux', model: FLEET_MODEL, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })).match(/\[[\s\S]*\]/)) || ['[]'])[0]);
    if (!Array.isArray(raw) || raw.length !== texts.length) return null;
    const arr = raw.map(stripEmDash);
    const plugUnchanged = texts.every((t, i) => (link && t.includes(link) ? arr[i] === t : true));
    // The renumber must not LOSE a sign-off the thread had. It no longer demands one the thread never
    // had: with laws.json signOff off, a clean thread ends on content and the disclaimer.
    const closeOk = !texts.some((t) => closingTexts(account).includes(t)) || closingTexts(account).some((c) => arr.includes(c));
    const discOk = !account.disclaimer || disclaimerTexts(account).includes(arr[arr.length - 1]);
    const lenOk = arr.every((t) => /https?:\/\//.test(t) || effLen(t) <= TWEET_LIMIT);
    return (plugUnchanged && closeOk && discOk && lenOk && !numberingIssue(arr)) ? arr : null;
  } catch { return null; }
}

async function qcDraft(env, account, draft, plugFpByDraft = new Map()) {
  const monetized = !!account.plugHeavyExample;
  const posts = draft.platforms.x.posts.map((p) => ({ text: p.text, media_ids: [...(p.media_ids || [])] }));
  const link = draftLink(draft, posts);
  const productTitle = ((draft.scratchpad_text || '').match(/Product:\s*(.+?)\s*\([A-Z0-9]{10}\)/) || [])[1] || '';
  // Skeleton-variation drafts intentionally differ in TOPIC from their form-donor source, so hook
  // faithfulness + dropped-vs-source are meaningless — detect the mode from the scratchpad marker and skip
  // re-fetching the source; the item-count check runs against the skeleton's own itemCount instead.
  const skelMode = /(^|\n)MODE:\s*skeleton/i.test(draft.scratchpad_text || '');
  const skelItemCount = Number(((draft.scratchpad_text || '').match(/ITEMCOUNT:\s*(\d+)/i) || [])[1]) || 0;
  const ref = skelMode ? null : await loadReference(env, draft);
  const fixes = [], flags = [], notes = []; // fixes = short codes; notes = verbose reasons (console only)
  let changed = false, emDash = 0;

  // 1) em-dash strip (counted, not listed individually)
  posts.forEach((p) => { if (/[—–]/.test(p.text)) { p.text = stripEmDash(p.text); emDash++; changed = true; } });
  if (emDash) fixes.push(`em-dash ×${emDash}`);

  // 1b) leading markdown blockquote strip — QC uses the dash-only stripDashes, so a stray "> " prefix
  // the model emitted survives to schedule (the generation path strips it in checks.mjs stripEmDash,
  // but manual/legacy drafts and quote-heavy re-fetches don't). Deterministic: only a line-leading
  // "> " goes; mid-line "x > y" and ">50%" (no following space) are untouched. Same regex as the
  // generation-path blockquote clause, so both paths clean identically.
  let blockquote = 0;
  posts.forEach((p) => { const s = p.text.replace(/(^|\n)>[ \t]+/g, '$1'); if (s !== p.text) { p.text = s; blockquote++; changed = true; } });
  if (blockquote) fixes.push(`blockquote ×${blockquote}`);

  // 1c) generic engagement-bait sign-off strip ("Follow for more", "Thanks for reading"). checkThread
  // raises this as a hard ERROR, which at QC means the whole scheduled thread is blocked and pulled off
  // the calendar over one appended sentence. stripGenericSignoff deletes just that sentence and fails
  // closed (returns null) whenever there is no safe strip — the account closing, the legal disclaimer, a
  // persona-signed tweet and any link-bearing tweet are exempt by construction, so mandatory boilerplate
  // and the separately-gated plug shape are never touched. (IMPROVEMENTS 2026-08-04, QC final pass.)
  let baitStrip = 0;
  posts.forEach((p) => { const s = stripGenericSignoff(p.text, { account }); if (s) { p.text = s; baitStrip++; changed = true; } });
  if (baitStrip) fixes.push(`signoff-bait ×${baitStrip}`);

  // 1d) WALL-OF-TEXT respace (operator 2026-08-08, deal-breaker): a tweet generated as one unbroken
  // line has nothing for normalizeLineBreaks to normalize, so it reaches the scheduled draft as a
  // wall. respaceWall is deterministic and word-preserving (sentences packed into >=20-char blank-line
  // paragraphs). Link/plug tweets are exempt (their shape pipeline is 2a below), closing/disclaimer
  // ship pre-spaced (contain newlines -> untouched), and the 280 guard means a respace can never
  // introduce a length violation on an already-scheduled tweet.
  let wallFix = 0;
  posts.forEach((p) => {
    if (/https?:\/\//i.test(p.text)) return;
    const w = respaceWall(p.text);
    if (w !== p.text && effLen(w) <= TWEET_LIMIT) { p.text = w; wallFix++; changed = true; }
  });
  if (wallFix) fixes.push(`wall-respace ×${wallFix}`);

  // 2) plug fixes (disclosure, length, CTA principles) — monetized only
  if (monetized && link) {
    const plugIdx = posts.map((p, i) => (/lvnta\.com\/|gumroad\.com\/|geni\.us\//i.test(p.text) || (link && p.text.includes(link)) ? i : -1)).filter((i) => i >= 0);
    for (const i of plugIdx) {
      // 2a) Deterministic SHAPE repair, before anything else touches the plug. The generation path
      // canonicalizes every plug (recreate.mjs:365) but nothing did at QC, so the two shapes that reach
      // a scheduled draft — a legacy/live plug minted before the normalizer shipped, and one QC itself
      // reshaped last night — kept re-arriving as the 'cta:spacing' / 'cta:structure/merged-lines'
      // signals the retro tallies every night. normalizePlugStructure is mechanical-only (blank lines,
      // a leaked bullet/list marker, the disclosure respaced off its link) and never edits a word, a
      // claim, a superlative or the product name. (IMPROVEMENTS 2026-08-05, QC final pass.)
      //
      // GATED ON PROOF, not applied blindly: a QC plug is already scheduled, so it is only rewritten
      // when the fingerprint says the plug is genuinely broken AND the mechanical pass makes it whole
      // (plugStructure ok). A plug that is already canonical is untouched (no needless patch call), and
      // one the normalizer cannot actually fix is left exactly as-is for the LLM/judge path below —
      // so this can never turn a cosmetic defect into a differently-broken plug.
      if (!plugStructure(posts[i].text).ok) {
        const shaped = normalizePlugStructure(posts[i].text);
        if (shaped !== posts[i].text && plugStructure(shaped).ok && plugTextLen(shaped) <= PLUG_LIMIT) {
          posts[i].text = shaped; fixes.push(`cta:spacing·#${i + 1}`);
          notes.push(`CTA #${i + 1} shape repaired deterministically (blank-line/marker normalization)`);
          changed = true;
        }
      }
      // Own-shop Gumroad (ebook test): "Get it here:" is the CTA — never inject an affiliate disclosure
      // onto a first-party product plug.
      const ownShop = /gumroad\.com/i.test(link);
      if (!isDisclosed(posts[i].text, { own: ownShop })) { posts[i].text = posts[i].text.replace(link, ownShop ? `Get it here:\n\n${link}` : discloseBlock(link)); fixes.push(`disclosure·#${i + 1}`); changed = true; }
      if (plugTextLen(posts[i].text) > PLUG_LIMIT) { const t = await tighten(env, account, posts[i].text, true); if (t) { posts[i].text = t; fixes.push(`tightened·#${i + 1}`); changed = true; } else flags.push(`plug #${i + 1} >${PLUG_LIMIT}`); }
      // Fingerprint skip: this exact (prior, plug) pair already PASSED the judge at generation and is
      // byte-unchanged (the hash is computed AFTER tonight's em-dash/disclosure/tighten steps, so any
      // QC mutation above misses the hash and re-judges). Identical inputs ⇒ identical verdict — skip
      // the duplicate LLM call and the nondeterministic rewrite cascade it can trigger.
      // Deterministic superlative repair, BEFORE the fingerprint skip. checkThread raises an unhedged
      // absolute superlative as a hard ERROR, and an error blocks the patch below — so at QC (where the
      // draft is already scheduled) the only outcome today is the whole thread pulled off the calendar.
      // Mirror the generation-side repair loop (recreate.mjs:634): regenerate the plug natively rather
      // than mechanically templating over revenue copy, and accept ONLY a clean fix — regenPlug already
      // re-validates length + disclosure + judgePlug, and absoluteSuperlativeIssue is the final gate.
      // No fix ⇒ nothing changes and the hard error blocks exactly as it does today.
      // (IMPROVEMENTS 2026-08-04, QC final pass.)
      if (absoluteSuperlativeIssue(posts[i].text)) {
        const rew = await regenPlug(env, account, posts[i - 1]?.text || '', productTitle, link, 'absolute (non-hedged) superlative in the plug — use a first-person hedge ("one of the best I have tried")');
        if (rew && !absoluteSuperlativeIssue(rew)) {
          posts[i].text = rew; fixes.push(`cta:absolute-superlative·#${i + 1}`);
          notes.push(`CTA #${i + 1} auto-fixed: absolute (non-hedged) superlative`);
          changed = true;
          continue;                                   // freshly regenerated + judge-approved inside regenPlug
        }
        notes.push(`plug #${i + 1} absolute superlative — no clean regeneration; leaving the hard error to block`);
      }
      if (plugFpByDraft.get(String(draft.id))?.has(plugFingerprint(posts[i - 1]?.text || '', posts[i].text))) {
        notes.push(`plug #${i + 1} fp-skip (judge-passed at generation, unchanged)`);
        continue;
      }
      const v = await judgePlug(env, account, posts[i - 1]?.text || '', posts[i].text);
      // Unread judge = not a pass and not a defect either: no rewrite/regen on a guess, just a human look.
      if (v.unjudged) { flags.push(`plug #${i + 1}: CTA judge unread (${v.reason})`); continue; }
      if (!v.ok) {
        // A judge rewrite is fresh LLM output and was previously spliced in raw — so the judge's own fix
        // could ship a dash or a stacked plug the deterministic passes above had just cleared. Put it
        // through the same two mechanical passes generation applies to a rewrite (recreate.mjs:355).
        let rew = v.rewrite ? normalizePlugStructure(stripEmDash(v.rewrite)) : null;
        if (!rew) rew = await regenPlug(env, account, posts[i - 1]?.text || '', productTitle, link, v.reason); // spin off an LLM fixer to repair the defect now, instead of punting to "needs you"
        if (rew) {
          let sub = ctaSubReason(v.reason);
          const offending = posts[i].text;
          // Name the bucket: an unmatched judge reason WOULD ship as opaque 'cta:other/UNCLASSIFIED'. Before
          // falling back to that catch-all, run the deterministic 5-slot structural fingerprint on the
          // offending plug so a concrete SHAPE defect (merged lines, missing line-3 colon, extra slot, missing
          // disclosure/link) earns its own named tally key the retro can target — instead of a garbage bucket.
          // A structurally well-formed plug with an unmappable reason stays 'other' (a genuine semantic miss).
          const struct = sub === 'other' ? plugStructure(offending) : { ok: true };
          if (sub === 'other' && !struct.ok) sub = `structure/${struct.failed}`;
          posts[i].text = rew;
          fixes.push(`cta:${sub === 'other' ? 'other/UNCLASSIFIED' : sub}·#${i + 1}`);
          notes.push(`CTA #${i + 1} auto-fixed: ${v.reason}`);
          if (sub === 'other') notes.push(`cta:other/UNCLASSIFIED #${i + 1} — reason="${v.reason}" · structurally well-formed · plug="${offending.replace(/\n/g, ' ⏎ ').slice(0, 200)}"`);
          else if (sub.startsWith('structure/')) notes.push(`cta:${sub} #${i + 1} — ${struct.detail} · reason="${v.reason}" · plug="${offending.replace(/\n/g, ' ⏎ ').slice(0, 200)}"`);
          changed = true;
        }
        else flags.push(`plug #${i + 1}: ${v.reason}`);
      }
    }
  }

  // 3) body tweets over 280
  for (let i = 0; i < posts.length; i++) {
    if (!/https?:\/\//.test(posts[i].text) && effLen(posts[i].text) > TWEET_LIMIT) {
      const t = await tighten(env, account, posts[i].text, false); if (t) { posts[i].text = t; fixes.push(`tightened·#${i + 1}`); changed = true; } else flags.push(`#${i + 1} >${TWEET_LIMIT}`);
    }
  }

  // 4) sign-off / disclaimer repair
  if (monetized) {
    // Legacy-aware on purpose: drafts written before the 2026-08-23 boilerplate rewrite still end on
    // the OLD closing/disclaimer. They count as signed and disclaimed — repairing them here would
    // stack the new closer on top of the old one in every sitting draft.
    // The sign-off is restored only while laws.json signOff is on (owner R2026-09-26).
    if (signOffOf(account) && !posts.some((p) => closingTexts(account).includes(p.text))) {
      const at = account.disclaimer && disclaimerTexts(account).includes(posts[posts.length - 1].text) ? posts.length - 1 : posts.length;
      posts.splice(at, 0, { text: account.closing, media_ids: [] }); fixes.push('+sign-off'); changed = true;
    }
    if (account.disclaimer && !disclaimerTexts(account).includes(posts[posts.length - 1].text)) { posts.push({ text: account.disclaimer, media_ids: [] }); fixes.push('+disclaimer'); changed = true; }
  }

  // 5) numbering — deterministic renumber FIRST (cheap, pure, preserves item count), then guarded LLM
  // renumber, else flag. A mere marker gap ("1-7, 9-15, missing 8") on a thread whose item COUNT still
  // matches the source is a cosmetic slip renumberLeadingMarkers heals over instead of failing the slot;
  // a genuine dropped item survives (marker count unchanged) and is still caught by the ref-faithfulness
  // check below. This is the same deterministic pass recreate.mjs already runs at generation.
  if (numberingIssue(posts.map((p) => p.text))) {
    const det = renumberLeadingMarkers(posts.map((p) => p.text));
    if (!numberingIssue(det)) { det.forEach((t, i) => { posts[i].text = t; }); fixes.push('renumbered'); changed = true; }
    else {
      const fixed = await renumber(env, posts, link, account);
      if (fixed) { fixed.forEach((t, i) => { posts[i].text = t; }); fixes.push('renumbered'); changed = true; }
      else flags.push(numberingIssue(posts.map((p) => p.text)));
    }
  }

  // 6) faithfulness to the reference (flag only — never fabricate content)
  if (skelMode) {
    // Skeleton mode: no hook-vs-source judge (the hook is a deliberate NEW-topic variation); just keep
    // the item count at the skeleton's target so a variation can't silently drop half its list.
    const oursCount = posts.map((p) => p.text).flatMap(leadingNumbers).length;
    if (skelItemCount && oursCount && oursCount < skelItemCount) flags.push(`dropped ${skelItemCount - oursCount} item(s) vs skeleton (${oursCount}/${skelItemCount})`);
    // Hook strength (deterministic, vs the proven-hook bank) — a warn, not a block: the draft passed the
    // generation-time gate; a low score here (bank refreshed since, or an older draft) is operator signal.
    const bank = loadHookBank();
    const hs = bank.length ? hookStrength(posts[0]?.text || '', bank) : null;
    if (hs && hs.score < Number(process.env.HOOK_MIN ?? 45)) flags.push(`weak hook ${hs.score}/100 vs winner bank`);
  } else if (ref) {
    const oursCount = posts.map((p) => p.text).flatMap(leadingNumbers).length;
    if (ref.itemCount && oursCount && oursCount < ref.itemCount) flags.push(`dropped ${ref.itemCount - oursCount} item(s) vs ref (${oursCount}/${ref.itemCount})`);
    // Structural first-item attach — the "hook: missing first list item" signal (IMPROVEMENTS
    // 2026-08-06, QC final pass). GENERATION already gates AND repairs this shape (hookAttachIssue /
    // attachFirstItemToHook, recreate.mjs:253/507/583); QC imported neither, so a draft that reached
    // the calendar with the donor's "N." marker split off its hook stayed split and re-tallied every
    // night — the same half-wired shape the plug normalizer had (adopted 2026-08-06). Runs BEFORE the
    // hook judges so they see the donor's real shape. GATED ON PROOF, never blind: the donor must
    // actually attach, the pure reshaper must clear the gate, tweet 1 must still fit, and the rebuilt
    // thread must be a strict index-for-index match of the old one (only the folded item's marker line
    // moves) — so media_ids stay on their own tweets and no tweet can silently vanish. Anything the
    // reshaper cannot make whole (e.g. the marker line is all its tweet held, so the tweet would be
    // dropped) is left exactly as-is and flagged for the operator.
    const srcAttaches = srcTweet1AttachesItem(ref.texts?.[0] || '');
    const attachIssue = hookAttachIssue(posts.map((p) => p.text), { srcAttaches });
    if (attachIssue) {
      const before = posts.map((p) => p.text);
      const after = attachFirstItemToHook(before, { srcAttaches });
      // ADDITIVE ONLY: the reshaper is also allowed to drop a middle "flavor" block to make room for
      // the marker (checks.mjs:1222) — acceptable while a draft is still being rolled, NOT on live copy
      // already on the calendar. Require the hook's own words to survive verbatim, so QC's edit here can
      // only ever be "the marker line moved up".
      const realigned = after !== before && after[0].startsWith(before[0].trim())
        && !hookAttachIssue(after, { srcAttaches }) && effLen(after[0]) <= TWEET_LIMIT
        ? realignPosts(posts, after) : null;
      if (realigned) { posts.splice(0, posts.length, ...realigned); fixes.push('hook:attach-item'); changed = true; }
      else flags.push(`hook: ${attachIssue}`);
    }
    // Deterministic first-item gate FIRST — judgeHook is an LLM call that can come back unread (API
    // blip, garbled reply), so the "keep the same first item" rule (prompts.mjs:230) needs a pure twin.
    // This one always runs, and fails open only when the donor has no numbered first item.
    const itemDrift = hookFirstItemIssue(ref.hook, posts[0].text, posts[1]?.text || '');
    if (itemDrift) flags.push(`hook: ${itemDrift}`);
    const hook = await judgeHook(env, account, ref.hook, posts[0].text);
    if (hook.unjudged) flags.push(`hook: judge unread (${hook.reason})`);
    else if (hook.faithful === false) flags.push(`hook: ${hook.reason}`);
  }

  // Plug copy <-> product consistency (live 2026-07-21, published 7Coxfv8: plug sold "ashwagandha",
  // link went to Omega-3). The scratchpad names the HEAVY product + its link — check every plug tweet
  // carrying THAT link sells that product. The light plug may be a second product whose title the
  // scratchpad doesn't carry, so it is skipped here (generation-time gate covers both precisely).
  {
    const sp = draft.scratchpad_text || '';
    const prodTitle = (sp.match(/^Product:\s*(.+)$/m) || [])[1];
    const prodLink = (sp.match(/^Link:\s*(\S+)/m) || [])[1];
    if (monetized && prodTitle && prodLink) posts.forEach((po, i) => {
      if (!po.text.includes(prodLink)) return;
      const mm = plugSubstanceMismatch(po.text, prodTitle);
      if (mm) flags.push(`plug ${i + 1}: ${mm}`);
    });
  }

  // final deterministic re-check
  const remaining = checkThread(posts.map((p) => p.text), { account, link, monetized });
  const errors = remaining.filter((r) => r.severity === 'error');
  for (const r of remaining) if (!flags.some((f) => f.includes(r.msg))) flags.push(r.msg);

  if (changed && !DRY && errors.length === 0) {
    // Carry the repair onto every cross-posted copy, keeping each platform's own minted links.
    // Without this, QC's added disclosure and every structural fix landed on X alone.
    const { platformPosts, skipped } = rebuildCrossPosts(posts, draft?.platforms);
    for (const s of skipped) flags.push(`cross-post ${s.platform} left stale (${s.reason}) — it still carries the pre-QC text`);
    await typefully(env).patchDraft(account.socialSetId, draft.id, { platforms: buildPlatforms(posts, { existing: draft?.platforms, platformPosts }) });
  }
  return { account: account.name, title: draft.draft_title || `Draft ${draft.id}`, id: draft.id, share: draft.share_url || null, ss: account.socialSetId, when: draft.scheduled_date, ref: !!ref, fixes, flags, notes, patched: changed && !DRY && errors.length === 0, blocked: changed && errors.length > 0, clean: !changed && !flags.length };
}

async function listScheduled(env, account) {
  const r = await fetch(`https://api.typefully.com/v2/social-sets/${account.socialSetId}/drafts?limit=50`, { headers: { Authorization: `Bearer ${env.TYPEFULLY_API_KEY}` } });
  if (!r.ok) throw new Error(`drafts ${account.socialSetId} -> ${r.status}`);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j.results || j.drafts || j.data || []);
  const now = Date.now(), end = now + HOURS * 36e5;
  return arr.filter((d) => { const t = d.scheduled_date ? new Date(d.scheduled_date).getTime() : 0; return t >= now && t <= end; });
}

// ---- aggregate this run's QC issues into a compact signal for the shared retro brain ----
function tallyFindings(results) {
  const tally = {};
  for (const r of results) for (const f of [...r.fixes, ...r.flags]) {
    // An unread judge is an outage, not a copy defect: it stays a "needs you" flag in the report but
    // never reaches the retro, which would otherwise read one API blip as dozens of CTA/hook defects.
    if (/judge unread/.test(f)) continue;
    // Build a CLEAN ASCII enum key. Drop slot indices (#3), counts (×3), and any leftover
    // non-ASCII glyph (the · middot used as a separator in fix labels like "CTA·#3", the × in
    // "em-dash ×3", stray em dashes). Without the non-ASCII strip the retro receives a garbled
    // "cta·" token and has repeatedly hallucinated it as a literal middot defect in the OUTPUT —
    // spawning bogus "strip middot from the CTA" proposals. The middot only ever lived in this
    // fix-label, never in a posted tweet. Keep the key readable ("cta", "em-dash", "disclosure").
    const key = f
      .replace(/[·#]?\d+/g, '')      // slot indices / counts ("#3", "·3", "3")
      .replace(/×\d+/, '')            // explicit "×3" counts
      .replace(/\(.*$/, '')           // trailing "(...)" detail
      .replace(/[^\x20-\x7e]+/g, ' ') // strip any remaining non-ASCII glyph (·, ×, em dash)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase() || 'other';
    tally[key] = (tally[key] || 0) + 1;
  }
  return tally;
}

// ---- Clean, scannable Telegram report ----
function buildReport(results, retroOut) {
  const fixed = results.filter((r) => r.patched), blocked = results.filter((r) => r.blocked), flagged = results.filter((r) => r.flags.length);

  // Quiet-mode: an all-clear QC pass is a healthy non-event — say nothing (the ☀️ Morning Brief is
  // the daily heartbeat). QC only speaks when it FIXED, FLAGGED, or BLOCKED something.
  if (!results.length) return null;
  if (!fixed.length && !blocked.length && !flagged.length && !(retroOut?.improvements?.length)) return null;

  const draftLines = [];
  for (const r of results) {
    const tag = r.blocked ? '⛔' : r.flags.length ? '⚠️' : r.fixes.length ? '🔧' : '✅';
    // Every draft mention carries its clickable Typefully link (public share URL, private ?d= fallback).
    const block = [`${tag} <a href="${r.share || `https://typefully.com/?d=${r.id}&a=${r.ss}`}"><b>${esc(r.title.slice(0, 56))}</b></a>`,
      `<i>${esc(r.account)} · ${esc(fmtSaigon(r.when, true))}${r.ref ? '' : ' · ⚠ no ref'}</i>`];
    if (r.fixes.length) block.push(`   ✦ ${esc(r.fixes.join(' · '))}`);
    if (r.flags.length) block.push(`   ⚠️ <b>needs you:</b> ${esc(r.flags.join(' · '))}`);
    if (r.blocked) block.push(r.unscheduled
      ? '   ⛔ <b>pulled off the calendar</b> — fix the errors, then reschedule'
      : `   ‼️ <b>broken draft STILL SCHEDULED</b> (unschedule failed) — fix before ${esc(fmtSaigon(r.when, true))}`);
    draftLines.push(block.join('\n'));
  }
  const sections = [{ label: 'DRAFTS', body: draftLines.join('\n\n') }];
  if (retroOut?.improvements?.length) {
    const retroLines = retroOut.improvements.slice(0, 6).map((imp) => `   • <b>${esc(imp.severity)}:</b> ${esc(imp.title)}`);
    if (retroOut.applied?.length) retroLines.push(`   ✅ auto-applied ${retroOut.applied.length} generator rule(s) at root cause`);
    sections.push({ label: `RETRO — ${retroOut.improvements.length} improvement${retroOut.improvements.length === 1 ? '' : 's'}`, body: retroLines.join('\n') });
  }

  return report({
    emoji: '🛡️', title: 'QC — final pass', scope: fmtSaigon(new Date().toISOString()),
    status: `${flagged.length ? '⚠️' : '✅'} <b>${results.length}</b> draft${results.length === 1 ? '' : 's'} · ${fixed.length} fixed · ${flagged.length} flagged${blocked.length ? ` · ${blocked.length} pulled off calendar` : ''}`,
    sections,
    action: flagged.length ? 'Review the flagged drafts in Typefully' : '',
  });
}

async function main() {
  const env = loadEnv();
  requireEnv(env, ['TYPEFULLY_API_KEY', LLM_KEYS, ...(DRY ? [] : ['AIRTABLE_PAT', 'XDB_BASE_ID'])]);
  const tf = typefully(env);
  const accounts = (ONLY ? [ONLY] : Object.keys(ACCOUNTS)).map(getAccount).filter((a) => a.socialSetId && !a.external); // external = client (RT bridge only), not ours to QC
  const plugFpByDraft = loadPlugFp(); // judge-approved plug pairs from generation — see loadPlugFp

  const results = [];
  let listFailures = 0; // a total listing outage must NOT look like a healthy quiet night
  const crossPostTally = {}; // kind -> count, across every draft this run inspected
  let crossPostSeen = 0;     // drafts carrying at least one cross-post fault
  for (const account of accounts) {
    let drafts;
    if (ONE) drafts = [await tf.getDraft(account.socialSetId, ONE)].filter((d) => d?.platforms?.x);
    else { try { drafts = await listScheduled(env, account); } catch (e) { console.log(`${account.name}: ${e.message}`); listFailures++; continue; } }
    for (const d of drafts) {
      const full = d.platforms?.x?.posts ? d : await tf.getDraft(account.socialSetId, d.id);
      const res = await qcDraft(env, account, full, plugFpByDraft);
      results.push(res);
      console.log(`\n[${res.account}] ${res.title} (${res.id}) — ${fmtSaigon(res.when, true)}${res.ref ? '' : ' [no ref]'}`);
      console.log(res.fixes.length ? `  🔧 ${res.fixes.join(', ')}` : '  (no fixes)');
      res.notes.forEach((n) => console.log(`     ↳ ${n}`));
      if (res.flags.length) console.log(`  ⚠️ ${res.flags.join(' | ')}`);

      // CROSS-POST INTEGRITY — REPORT ONLY, never block and never repair (2026-09-08).
      // Nothing else in the pipeline inspects a cross-posted copy: link-sentinel, validate-thread,
      // audit-drafts and check-links are all X-only. That was survivable while Threads was one
      // pilot account; it is not now that fifteen accounts cross-post daily and the Levanta "-th"
      // subid split is the ONLY signal the channel has — the Meta insights API is deliberately out
      // of scope, so a copy that quietly stops being separable takes the whole measurement with it
      // and looks exactly like a healthy draft in every other report.
      //
      // Deliberately NOT a gate. A Harvest variation shares its parent's links BY DESIGN — "the
      // variations carry the parent's links, so their revenue merges into the parent's subid"
      // (crosspost-backfill.mjs' header) — so blocking on `collapsed` would fight an intentional
      // design and stall the queue nightly. QC names what it sees; crosspost-backfill.mjs repairs
      // the drafts that genuinely should be split.
      const cpIssues = crossPostIntegrity(full.platforms, { own: /gumroad\.com/i.test(draftLink(full, full.platforms?.x?.posts || [])) });
      if (cpIssues.length) {
        for (const i of cpIssues) crossPostTally[i.kind] = (crossPostTally[i.kind] || 0) + 1;
        crossPostSeen++;
        console.log(`  🔗 cross-post: ${cpIssues.map((i) => `${i.platform} ${i.kind}${
          i.kind === 'collapsed' ? ` (${i.ids.length} shared link${i.ids.length === 1 ? '' : 's'})`
          : i.kind === 'diverged' ? ` (${i.had} posts vs X's ${i.x})`
          : ` (post ${i.posts.join(', ')})`}`).join(' · ')}`);
      }
      if (res.blocked) {
        // A draft QC cannot repair must never reach the timeline (Jul-15: a 1804-char tweet stayed
        // scheduled after "NOT patched" and would have posted broken). Pull it off the calendar —
        // publish_at:null keeps the draft in Typefully, unscheduled, for human repair. If even the
        // unschedule fails, the report shouts that a broken draft is still live.
        if (!DRY) {
          try { await tf.patchDraft(res.ss, res.id, { publish_at: null }); res.unscheduled = true; }
          catch (e) { console.log(`  ‼️ unschedule failed: ${e.message}`); }
        }
        console.log(res.unscheduled ? '  ⛔ NOT patched — pulled off the calendar' : '  ⛔ NOT patched — unresolved errors');
      } else if (res.patched) console.log('  ✓ patched');
    }
  }

  // Say it even when clean: a silent line is indistinguishable from a check that never ran, and
  // this one exists precisely because the failure it looks for is invisible everywhere else.
  if (results.length) {
    const parts = Object.entries(crossPostTally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
    console.log(`\n🔗 cross-post integrity: ${parts.length ? `${parts.join(', ')} across ${crossPostSeen} draft(s)` : 'clean'} — reported, not repaired (node crosspost-backfill.mjs)`);
  }

  const retroOut = (NO_RETRO || !results.length) ? null : await runRetro(env, {
    source: 'QC final pass',
    context: "Findings = issue -> count across tonight's scheduled drafts (QC auto-fixes + flags).",
    signals: tallyFindings(results), dry: DRY, post: false,
  });
  if (retroOut?.improvements?.length) {
    console.log(`\n🔁 Retro: ${retroOut.improvements.length} improvement(s)${retroOut.applied?.length ? `, ${retroOut.applied.length} auto-applied` : ''}`);
    retroOut.improvements.forEach((i) => console.log(`   [${i.severity}] ${i.title} (${i.type})`));
  }

  // Quiet-mode escape hatch: zero results BECAUSE listing failed is a BLIND guard, not a clean pass —
  // tonight's drafts would go live unreviewed with no signal. Shout and exit non-zero (failure-handler
  // then tracks the workflow) instead of taking the silent path.
  if (!results.length && listFailures) {
    console.error(`✗ QC blind — could not list drafts for ${listFailures} account(s)`);
    if (!DRY) {
      await telegram(env, report({
        emoji: '🛑', title: 'QC Blind', scope: `${listFailures} account(s)`,
        status: `🛑 QC could not read scheduled drafts — tonight's posts go live UNREVIEWED`,
        action: 'Check the Typefully API key / status, then rerun qc.mjs before the 6pm slot.',
      }), 'alerts');
    }
    process.exitCode = 1;
    return;
  }
  const out = buildReport(results, retroOut);
  if (!out) { console.log('\n✓ QC all clear — quiet (no Telegram; the Morning Brief covers routine health)'); return; }
  console.log('\n' + out.replace(/<[^>]+>/g, ''));
  if (!DRY) { await telegram(env, out, 'qc'); console.log('\n✓ Sent to 🛡️ QC'); }
  // Needs-you surface: a flagged draft is a DECISION with a deadline — ping the one topic the user
  // must read (alerts), each flagged draft with its clickable Typefully link so it opens in one tap.
  const flaggedDrafts = results.filter((r) => r.flags.length);
  if (!DRY && flaggedDrafts.length) {
    await telegram(env, report({
      emoji: '👉', title: 'Drafts Need Review', scope: 'before the 6pm slot',
      status: `⚠️ <b>${flaggedDrafts.length}</b> flagged draft(s) go live this evening unless you act`,
      sections: [{ label: 'OPEN & FIX', body: flaggedDrafts.map((r) =>
        `• <a href="${r.share || `https://typefully.com/?d=${r.id}&a=${r.ss}`}">${esc(r.title.slice(0, 56))}</a>\n   ⚠️ ${esc(r.flags[0] || '')}`).join('\n\n') }],
      action: 'Fix or unschedule before 6pm Saigon. Full detail in 🏭 Machine Room.',
    }), 'alerts');
  }
}
// Spend flushes on success AND failure (flushLlmSpend never throws; exit-1 contract untouched).
// Guarded so a test can import judgeHook without running a QC pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
  .then(() => flushLlmSpend(null, 'qc'))
  .catch(async (e) => { console.error('ERROR:', e.stack || e.message); await flushLlmSpend(null, 'qc', 'crashed'); process.exit(1); });
