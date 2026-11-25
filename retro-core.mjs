// retro-core.mjs — ONE self-improvement brain, shared by:
//   - qc.mjs       (findings-based: tonight's QC issues)
//   - retro.mjs    (metrics-based: a pipeline's run logs)
// It reads GOALS.md + current learned rules + the backlog, proposes root-cause improvements toward
// the goals (>=1, NOT capped), writes "rule" fixes into style/learned-rules.md, logs everything to
// IMPROVEMENTS.md in one format, and optionally posts to the retro Telegram topic. This replaces the
// two separate retro implementations with a single loop.
//
// learned-rules.md IS NO LONGER INJECTED into generation (operator 2026-09-02). Rules written here
// are PROPOSALS a human promotes into style/operator-rules.md, docs/cta-spec.md or a prompt/gate.
// The append is unchanged — only its destination's standing is. See that file's header for the
// audit that ended the auto-injection: 40 accumulated bullets, 14 of them describing a CTA shape
// retired months earlier, because an append-only machine channel has no way to expire a rule.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { anthropic, STRONG_MODEL, telegram, esc, report, HERE_DIR } from './lib.mjs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const RULES = join(HERE_DIR, 'style', 'learned-rules.md');
const BACKLOG = join(HERE_DIR, 'IMPROVEMENTS.md');
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Tolerant parse: opus occasionally returns JSON truncated at max_tokens (this crashed the registry
// retro nightly). Try the whole object; on failure, salvage every complete improvement object.
function parseImprovements(out) {
  try { return JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]).improvements || []; } catch {}
  const objs = [];
  for (const m of out.matchAll(/\{[^{}]+\}/g)) { try { const o = JSON.parse(m[0]); if (o && o.title) objs.push(o); } catch {} }
  return objs;
}

// runRetro(env, { source, context?, signals, dry?, post? }) -> { improvements, applied }
export async function runRetro(env, { source, context = '', signals, dry = false, post = false }) {
  const goals = read(join(HERE_DIR, 'GOALS.md')).slice(0, 2500);
  const currentRules = read(RULES);
  const backlog = read(BACKLOG);
  const prompt = `You are the self-improvement brain for an automated X content pipeline. Read our GOALS, the source context, and this run's signals, then identify the ROOT CAUSES behind recurring issues and propose fixes that prevent them at the source — not symptom patches. Find AT LEAST ONE improvement; propose MORE if warranted (do not cap at one). Favor changes that raise revenue-per-thread, thread quality, and CTA conversion (see goals).

GOALS (excerpt):
${goals}

SOURCE: ${source}
${context}

THIS RUN'S SIGNALS:
${typeof signals === 'string' ? signals : JSON.stringify(signals, null, 1).slice(0, 3000)}

CURRENT LEARNED RULES (a review queue awaiting a human, NOT injected into the generator; do NOT duplicate these):
A RESTATEMENT IN DIFFERENT WORDS IS A DUPLICATE. Before proposing any "rule", check whether the constraint
is ALREADY covered above in ANY wording — if it is, do NOT propose it as a rule, even if tonight's issue
recurred despite it. A recurring issue that an existing rule already forbids is evidence the rule is being
IGNORED, not evidence a new rule is needed: propose a "code" fix (a deterministic gate in checks.mjs) or say
so in the root cause instead. Only propose a "rule" for a constraint that is genuinely absent above.
${currentRules || '(none yet)'}

OPEN BACKLOG (do NOT duplicate open 'proposed' items; you may escalate one):
${backlog.slice(0, 3000)}

For each improvement choose a type:
- "rule": a crisp NEW imperative rule to inject into the generator so it stops producing this issue (one actionable sentence).
- "code": a change to checks.mjs / qc.mjs / recreate.mjs / a pipeline script (describe it; a human applies it).
- "process": anything else.
Return ONLY JSON: {"improvements":[{"title":"...","rootCause":"...","type":"rule|code|process","rule":"<if rule>","recommendation":"<if code/process>","severity":"critical|high|medium"}]}`;

  let improvements = [];
  try {
    const out = await anthropic(env, { role: 'retro', model: STRONG_MODEL, max_tokens: 2800, messages: [{ role: 'user', content: prompt }] });
    improvements = parseImprovements(out);
  } catch (e) { return { improvements: [], applied: [], err: e.message }; }

  const applied = [];
  if (!dry && improvements.length) {
    const date = new Date().toISOString().slice(0, 10);
    // auto-apply "rule" improvements -> learned-rules.md (deduped, cap 5/run)
    const existing = new Set((currentRules.match(/^- .*/gm) || []).map((l) => norm(l).slice(0, 50)));
    const newRules = [];
    // Jev decides which proposals enter the queue (decisions/rule-proposal.mjs); the prefix dedupe stays
    // as the floor. An unread proposal keeps the old behaviour (queued), since the queue is human-reviewed.
    const listed = (currentRules.match(/^- .*/gm) || []).map((l) => l.slice(2));
    const verdicts = await gateRules(env, improvements.filter((i) => i.type === 'rule' && i.rule), listed);
    for (const imp of improvements.filter((i) => i.type === 'rule' && i.rule)) {
      const key = norm(imp.rule).slice(0, 50);
      const v = verdicts.get(imp);
      if (v?.action === 'refuse') { imp.jevRefused = v.reasons.join('; '); continue; }
      if (existing.has(key) || newRules.length >= 5) continue;
      existing.add(key); newRules.push(imp.rule.trim()); applied.push(imp.title); listed.push(imp.rule.trim());
    }
    if (newRules.length) {
      const header = existsSync(RULES) ? '' : '# Learned rules — REVIEW QUEUE (not injected)\n\nThe retro appends proposals here. Nothing in this file reaches a prompt: promote a rule into style/operator-rules.md, docs/cta-spec.md or a gate to make it real, then delete it from here.\n';
      writeFileSync(RULES, (header || currentRules.replace(/\n+$/, '') + '\n') + newRules.map((r) => `- ${r}`).join('\n') + '\n');
    }
    // log everything to the backlog in one consistent format
    const lines = improvements.map((i) => {
      const tag = i.type === 'rule' && applied.includes(i.title) ? 'applied-rule' : i.jevRefused ? `not queued (Jev: ${i.jevRefused})` : 'proposed';
      const fix = i.type === 'rule' ? i.rule : (i.recommendation || '');
      return `- **[${tag}] ${i.title}** *(${i.type}/${i.severity}, ${source}, ${date})* — ${i.rootCause}\n  Fix: ${fix}`;
    });
    writeFileSync(BACKLOG, (read(BACKLOG) || '# Improvement backlog\n') + `\n## Retro — ${source} — ${date}\n` + lines.join('\n') + '\n');
  }

  if (!dry && post && improvements.length) {
    const top = improvements.slice(0, 6).map((i) => `• <b>${esc(i.severity)}:</b> ${esc(i.title)}`).join('\n');
    await telegram(env, report({
      emoji: '🔁', title: 'Retro', scope: source,
      status: `${applied.length ? '✅' : 'ℹ️'} <b>${improvements.length}</b> improvement${improvements.length === 1 ? '' : 's'}${applied.length ? ` · <b>${applied.length}</b> auto-applied at root cause` : ''}`,
      sections: [{ label: 'TOP', body: top }],
      action: 'Logged to IMPROVEMENTS.md. Auto-handled — no action needed.',
    }), 'retro');
  }
  return { improvements, applied };
}

/** Jev's read of each proposed rule (decisions/rule-proposal.mjs). Map imp -> verdict; unread -> absent. */
export async function gateRules(env, proposals, existingRules, { client = null, log = undefined } = {}) {
  const out = new Map();
  if (!proposals.length) return out;
  try {
    const { decide, decisionConfig } = await import('./jev-decide.mjs');
    const { DECISIONS } = await import('./decisions/index.mjs');
    const jevClient = client || (await import('./jev.mjs')).jev(env);
    const th = decisionConfig('rule-proposal').thresholds;
    await Promise.all(proposals.map(async (imp) => {
      const r = await decide('rule-proposal', { rule: imp.rule, rootCause: imp.rootCause, existingRules }, { client: jevClient, registry: DECISIONS, ...(log === undefined ? {} : { log }) });
      if (r.source === 'fallback' || !r.answers) return;
      out.set(imp, DECISIONS['rule-proposal'].policy(r.answers, th));
    }));
  } catch (e) { console.warn(`retro: Jev rule gate not read (${String(e.message).slice(0, 80)}); rules queue as before`); }
  return out;
}
