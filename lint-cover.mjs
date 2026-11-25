#!/usr/bin/env node
// lint-cover.mjs <file|dir> [...] — the CHEAP half of the publish gate, run BEFORE gate-thread.
//
// gate-thread is the referee and this does not replace it. It exists because of how a writing session
// actually fails: on 2026-09-03 a 42-thread batch took roughly fifty gate round trips, and over half
// were a single tweet three characters too long. Each one cost a full gate run to learn one number.
//
// So this reports EVERY cheap deterministic defect in one pass, across as many files as you hand it,
// with no network and no Airtable: length, dashes, numbering, stacked paragraphs, duplicate markers,
// placeholders and the hard-claim words. Everything here is a pure function of the text. The
// expensive judgements gate-thread owns — plug placement, criterion order, substance bridges, pod
// fit — stay there, because they need the products and the roster.
//
//   node lint-cover.mjs covers/2026-09-04-julian.json
//   node lint-cover.mjs covers/            # every .json in the folder
//   node lint-cover.mjs covers/ --quiet    # only files with findings
//   node lint-cover.mjs covers/ --notes    # plus the advisory sentence-per-line and rhythm read
//
// Accepts a COVER ({ key, tweets }) or a publish-thread SPEC ({ account, tweets }); the account is
// resolved when it can be, purely so the disclaimer is exempt from the claim words it contains.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNTS, resolveAccountKey } from './accounts.mjs';
import { DEFAULT_POD_SYSTEM } from './pods.mjs';
import { SKELETON_SINCE_RE } from './checks.mjs';
import { effLenMinted, numberingIssue, duplicateMarkerIssue, placeholderIssue, stackedSentenceIssue,
  hardHealthClaimMatch, isBoilerplate, unfilledEnumIssue, stageDirectionIssue, danglingLeadInIssue,
  rhythmIssues, hookPromiseIssue } from './checks.mjs';

const TWEET_LIMIT = 280;


// The two tokens a COVER is supposed to carry: mint-batch fills them in later. Everything else that
// looks like a placeholder ([LINK], {PRODUCT}) is a real defect at every stage.
const MINT_TOKENS = /\{\{LINK\d*\}\}/g;

/** PURE, and the whole point of the file — every cheap finding for one thread, in one array.
 *  Never throws on a malformed tweet list: a lint that dies on bad input is a lint you stop running.
 *  `stage` is 'cover' before minting (the {{LINK}} tokens are expected) or 'spec' after. */
export function lintTweets(tweets, account = null, { stage = 'spec', allowItems = [] } = {}) {
  const arr = (tweets || []).map((t) => String(t ?? ''));
  const forPlaceholder = stage === 'cover' ? arr.map((t) => t.replace(MINT_TOKENS, 'x')) : arr;
  const out = [];
  arr.forEach((t, i) => {
    const n = effLenMinted(t);
    // The overshoot is the useful number, not the total: it says how much to cut.
    if (n > TWEET_LIMIT) out.push({ tweet: i + 1, kind: 'length', msg: `${n} chars, ${n - TWEET_LIMIT} over` });
    if (/[—–]/.test(t)) out.push({ tweet: i + 1, kind: 'dash', msg: 'em or en dash' });
    if (account && isBoilerplate(account, t)) return;   // our own disclaimer says "treat disease"
    const hm = hardHealthClaimMatch(t);
    if (hm) out.push({ tweet: i + 1, kind: 'claim', msg: `hard health claim: "${hm}"` });
  });
  const whole = [
    ['numbering', numberingIssue(arr)],
    // numbering proves the markers are contiguous; this proves they are what the hook said they were.
    // `allowItems` was documented on hookPromiseIssue as the escape and was reachable from nowhere:
    // this linter called it with no options, so a spec declaring the waiver was simply ignored and
    // the only way to clear the finding was to change a thread that was already right. The waiver is
    // for a list that deliberately mixes substances with the mechanism explaining them — a thread
    // whose argument is "the answer is not another bottle" cannot make every item a bottle.
    ['hook-promise', hookPromiseIssue(arr, { allowItems })],
    ['markers', duplicateMarkerIssue(arr)],
    ['placeholder', placeholderIssue(forPlaceholder)],
    ['unfilled-enum', unfilledEnumIssue(arr)],
    ['stage-direction', stageDirectionIssue(arr)],
    ['dangling-lead-in', danglingLeadInIssue(arr)],
  ];
  for (const [kind, msg] of whole) if (msg) out.push({ tweet: null, kind, msg: String(msg) });
  return out;
}

/** PURE. The pod system a thread is actually written in, against the one it should be.
 *
 *  THE DEFAULT WAS REAL FOR THE ENGINE AND INVISIBLE TO A WRITER (2026-09-18, operator: "let's make
 *  it the default and use skeleton from now"). DEFAULT_POD_SYSTEM has been `skeleton` since
 *  2026-09-13, but it governs renderPod — and the main production lane is hand-written threads,
 *  which never call it. Measured on the ledger: skeleton shipped 4 times in 260 monetized rows
 *  against backline's 101. So the gap is reported where the writing happens.
 *
 *  A REPORT LINE, NOT A FINDING. It is deliberately outside lintTweets: the four worked examples in
 *  style/examples are backline reference material and must stay lint-clean, and Run 5 keeps ten
 *  backline threads on purpose as the A/B control. Naming a drift is useful; refusing it is not. */
export function systemDrift(tweets, expect = DEFAULT_POD_SYSTEM) {
  const system = ctaSystemOf(tweets);
  if (!system || system === expect) return null;
  return `written in ${system}, default is ${expect} — write the plug as a criterion question, or pass --system ${system} if this arm is deliberate`;
}

/** PURE. Advisory only, and deliberately NOT part of lintTweets. validateDraft disabled the
 *  sentence-per-line rule as a hard block (checks.mjs ~3847) because it fires on the plug's middle
 *  beat and on legitimate staccato runs, so every one of the 42 threads shipped on 2026-09-03 trips
 *  it while passing the real gate. Reported under a separate heading, never counted as a finding:
 *  a lint whose output you learn to scroll past has stopped working. */
export function lintNotes(tweets, account = null) {
  const arr = (tweets || []).map((t) => String(t ?? ''));
  const ssi = stackedSentenceIssue(arr, account);
  // RHYTHM (operator 2026-09-13, thresholds fixed 2026-09-15 from the finished remix). Same channel
  // as `stacked` and for the same reason: these grade taste, so they report and never refuse. They
  // ride --notes because they are loud on the existing archive by design — the fleet was written
  // before the rules existed, and the point is to see that, not to block on it.
  return [
    ...(ssi ? [{ kind: 'stacked', msg: String(ssi) }] : []),
    ...rhythmIssues(arr, account),
  ];
}

// ---- The backline pod, as fingerprints (operator 2026-09-06: "I want my backline system to be the
// main active one") ------------------------------------------------------------------------------
// docs/cta-spec.md §0 is the template: POINT (entry line, benefits, where to get it, agitate ending
// on "…"), BRIDGE ("But then I learned that [bad form] is worse than none at all" → the penalty →
// "So this is what I look for ↓"), PLUG ("I look for [specific]…" → "Since switching…" → the CTA line).
// It was the documented default since 2026-09-02 and had shipped 0 of 275 hand-written plugs by
// 2026-09-06, because nothing between the doc and the gate ever said which plugs were on it. This
// does: for every plug, which of the template's lines the three tweets before and including it
// carry, and which they do not. Regexes, so ADVISORY by design — glue.md's own rule is that a regex
// which grades taste rejects good writing — but printed on every run, never behind a flag, because
// a lint whose output is optional is how the last shape drifted unseen.
const PLUG_RE = /\{\{LINK\d*\}\}|lvnta\.com\/|amazon\.com\/[^\s]*(?:maas=|aa_adgroupid=)/i;
const BL = {
  point: [
    ['an entry line the host can number (Take/Try [substance], a symptom, "You\'re low on")', /^(?:(?:[A-Za-z]+ )?\d+[.):]\s*)?(?:Bonus: )?(?:Take|Try)\b|^(?:[A-Za-z]+ )?\d+[.):]\s+\S|^You'?re low on\b/im],
    ['the reason to want it (benefits, "is good because", "Those usually mean", "is bad because")', /\b(?:is good because|is bad because|Those usually mean|supports?|steadies|opens|runs on|helps? with)\b/i],
    ['where to get it (foods, "You can get it through", a • list)', /\b(?:you can get it through|get it from|found in|comes? from)\b|^• /im],
    ['the agitate hand-off ("Most … …" ending on … or a caution)', /(?:…|↓|be careful[^\n]*|careful (?:which|what)[^\n]*)\s*$/i],
  ],
  weld: [
    ['the next item, numbered', /^(?:[A-Za-z]+ )?\d+[.):]\s+\S/m],
    ['the pull the bridge answers (… or ↓ or a caution at the end)', /(?:…|↓|be careful[^\n]*|careful (?:which|what)[^\n]*)\s*$/i],
  ],
  bridge: [
    ['opens with "But"', /^But\b/i],
    ['names the penalty of the wrong form ("worse than", the cheap form, what it costs you)', /\b(?:worse than|wrong (?:form|salt|one|tub|kind)|cheap(?:er|est)?\b|does nothing|none of the)\b/i],
    ['closes on "So this is what I look for ↓"', /look(?:ing)? for[^\n]*↓\s*$|what to look for/i],
  ],
  plug: [
    ['opens on the criterion ("I look for [specific]…", "If you\'re looking for…", "Please look for")', /^(?:I look for|If you'?re looking for|Please look for|Look for)\b/im],
    ['the comparative payoff ("Since switching…", or the light plug\'s "It … without the …")', /\bSince (?:switching|splitting|I switched|making the switch|moving)\b|\b(?:Since|After) \w+ing\b|^(?:It|They) [^\n]*\bwithout\b/im],
    ['a first-person CTA line disclosing inline "(#ad):"', /\bI(?:'m| am)?\s+(?:\w+\s+){0,3}?(?:use|using|take|taking|buy|buying|keep|keeping|trust|reorder|stick(?:ing)? with|sticking with|reach for|swear by|switched to|go back to)\b[^\n]*\(#ad\):?\s*$/im],
  ],
};
const missing = (text, checks) => checks.filter(([, re]) => !re.test(String(text || ''))).map(([label]) => label);

/** PURE. For each plug, the backline lines its three tweets carry and the ones they do not.
 *  Returns [] when every plug is on the template. The second plug's first tweet is the WELD
 *  (glue.md LAW G4), so it is judged as a weld, not as a point. */
export function backlineNotes(tweets) {
  const arr = (tweets || []).map((t) => String(t ?? ''));
  const out = [];
  let seen = 0;
  arr.forEach((t, i) => {
    if (!PLUG_RE.test(t) || i < 2) return;
    seen++;
    const gaps = [];
    const first = missing(arr[i - 2], seen === 1 ? BL.point : BL.weld);
    if (first.length) gaps.push(`${seen === 1 ? 'point' : 'weld'} (tweet ${i - 1}) lacks ${first.join('; ')}`);
    const b = missing(arr[i - 1], BL.bridge); if (b.length) gaps.push(`bridge (tweet ${i}) lacks ${b.join('; ')}`);
    const p = missing(t, BL.plug); if (p.length) gaps.push(`plug (tweet ${i + 1}) lacks ${p.join('; ')}`);
    if (gaps.length) out.push({ tweet: i + 1, kind: 'backline', msg: gaps.join(' · ') });
  });
  return out;
}

/** PURE. The stamp the ledger carries: 'backline' when every plug's bridge and plug carry the
 *  template's three fixed lines (the ones a pasted pod always has), 'fresh' otherwise, null when
 *  there is no plug. Deliberately narrower than backlineNotes: a stamp is a fact, a note is advice. */
// SKELETON (operator 2026-09-13, docs/cta-spec.md §0b): the measured plug shape — a since-month in
// the middle beat, the criterion as a question or a form statement up top, and a short possessive
// "I <verb>" CTA. Read off the text like the others so a hand-written plug on the skeleton stamps
// the same as a pasted one, and the two arms (skeleton vs backline) can be compared by stamp.
// ONE HOME FOR THE SINCE-MONTH (2026-09-18). It was written out here and needed again in
// checks.mjs, where repostRepairs must recognise a skeleton plug to leave it whole; two copies of a
// regex in two files is the drift laws.json exists to prevent, so checks.mjs owns it.
const SKELETON_MIDDLE_RE = SKELETON_SINCE_RE;
const SKELETON_CTA_LINE_RE = /^(?:the [^\n]{1,60}\bI\s+\w+[^\n]*|this is (?:the|my) [^\n]*)\(#ad\):?\s*$/im;
export function isSkeletonPlug(t) {
  return SKELETON_MIDDLE_RE.test(t) && SKELETON_CTA_LINE_RE.test(t);
}
export function ctaSystemOf(tweets) {
  const arr = (tweets || []).map((t) => String(t ?? ''));
  let plugs = 0, on = 0, skel = 0;
  arr.forEach((t, i) => {
    if (!PLUG_RE.test(t) || i < 1) return;
    plugs++;
    if (isSkeletonPlug(t)) { skel++; return; }
    const bridgeOk = /^But\b/i.test(arr[i - 1]) && /look(?:ing)? for[^\n]*↓\s*$|what to look for/i.test(arr[i - 1]);
    const plugOk = /^(?:I look for|If you'?re looking for|Please look for|Look for)\b/im.test(t);
    if (bridgeOk && plugOk) on++;
  });
  if (!plugs) return null;
  if (skel === plugs) return 'skeleton';
  if (on === plugs) return 'backline';
  return 'fresh';
}

/** PURE. A cover carries `key`, a spec carries `account`; both carry `tweets`. Returns null for
 *  neither, so a stray JSON file in the folder is skipped rather than reported as broken. */
export function readThread(json) {
  const tweets = json?.tweets;
  if (!Array.isArray(tweets)) return null;
  const key = json.key || (json.account ? resolveAccountKey(json.account) : null);
  const stage = json.account && Array.isArray(json.products) ? 'spec' : 'cover';
  // `allowItems` rides the spec so the waiver is declared where the thread is, and is read back by
  // whoever lints it — which is what makes it reviewable in the diff rather than a flag on a command.
  const allowItems = Array.isArray(json.allowItems) ? json.allowItems.map(Number).filter(Number.isFinite) : [];
  return { tweets, account: (key && ACCOUNTS[key]) || null, key, stage, allowItems };
}

const files = (p) => (statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => join(p, f))
  : [p]);

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const si = process.argv.indexOf('--system');
  const SYSTEM_FLAG = si > 0 ? process.argv[si + 1] : DEFAULT_POD_SYSTEM;
  const quiet = process.argv.includes('--quiet');
  if (!args.length) { console.error('usage: node lint-cover.mjs <file|dir> [...] [--quiet]'); process.exit(2); }
  let bad = 0, seen = 0, onShape = 0, offDefault = 0;
  for (const target of args.flatMap(files)) {
    let json; try { json = JSON.parse(readFileSync(target, 'utf8')); } catch (e) { console.log(`${target}\n  ! unreadable: ${e.message}`); bad++; continue; }
    const th = readThread(json);
    if (!th) continue;
    seen++;
    const hits = lintTweets(th.tweets, th.account, { stage: th.stage, allowItems: th.allowItems || [] });
    const notes = process.argv.includes('--notes') ? lintNotes(th.tweets, th.account) : [];
    const bl = backlineNotes(th.tweets);
    if (!bl.length) onShape++;
    if (!hits.length) { if (!quiet || bl.length) console.log(`✓ ${target}  (${th.tweets.length} tweets, ${th.stage}${bl.length ? '' : ', backline'})`); }
    else {
      bad++;
      console.log(`✗ ${target}  (${th.tweets.length} tweets, ${th.stage}${bl.length ? '' : ', backline'})`);
      for (const h of hits) console.log(`   ${h.tweet ? `#${String(h.tweet).padStart(2)}` : ' — '}  ${h.kind.padEnd(16)} ${h.msg}`);
    }
    // Always shown, never a finding: the shape is the operator's, the wording is the writer's.
    for (const b of bl) console.log(`   #${String(b.tweet).padStart(2)}  backline         ${b.msg}`);
    for (const n of notes) console.log(`   advisory  ${n.msg}`);
    // `--system <name>` declares a deliberate arm; otherwise the writing default is what is expected.
    const drift = systemDrift(th.tweets, SYSTEM_FLAG);
    if (drift) { offDefault++; console.log(`    —   cta-system       ${drift}`); }
  }
  const sysLine = offDefault ? `, ${seen - offDefault}/${seen} on the ${SYSTEM_FLAG} default` : `, all on ${SYSTEM_FLAG}`;
  console.log(`\n${seen - bad}/${seen} clean, ${onShape}/${seen} on the backline pod${sysLine} — gate-thread still has the final word on plugs, criteria and pods`);
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
