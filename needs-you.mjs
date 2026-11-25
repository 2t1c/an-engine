// needs-you.mjs — SINGLE SOURCE OF TRUTH for "something needs a human right now".
//
// The Morning Brief and the dashboard's ActionQueue (infinity-ops-view) were two independent
// implementations of the same question. They overlapped on stalls and an empty queue, each carried
// signals the other lacked, and they were written in different languages in different repos. That
// drifts, and the failure mode is the worst kind: a Telegram alert about something the dashboard
// says is fine, or the reverse — at which point you stop believing either.
//
// So the DEFINITION lives here: what counts, how bad it is, and what to do about it. The brief
// renders these to Telegram HTML; the dashboard renders the same ids and severities to panels. The
// two can still be checked against each other because the ids and thresholds are exported.
//
// Pure and dependency-free (mirrors loop-policy.mjs) so CI can unit-test it and so no caller can
// accidentally make it do I/O.

export const POLICY_VERSION = 1;

/** Ranking. A page whose DATA has stopped arriving outranks a page merely losing money: every other
 *  number in both surfaces is computed from that data, so a dark account biases everything else. */
export const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };

/** Hours before an account's sync counts as dark. Mirrored by STALE_HOURS in the dashboard. */
export const STALE_HOURS = 18;

/** A committed queue file older than this is ignored. Without it a stale file left behind by a
 *  failed run raises the same phantom warning every morning until someone notices. */
export const QUEUE_FRESH_MS = 48 * 3600e3;

/** Weekly-cadence queues (reconcile.yml Mon 05:30 UTC, donor runway): a week plus a one-day delivery
 *  allowance. At 48h the unclaimed $ vanished from the brief five days a week while still true. */
export const WEEKLY_FRESH_MS = 8 * 864e5;

/** True when a queue artifact was refreshed recently enough to be believed. Weekly-cadence
 *  queues (reconcile, runway) pass their own window — 48h would hide them five days a week. */
export function isFresh(updatedAt, now = Date.now(), maxMs = QUEUE_FRESH_MS) {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && now - t < maxMs;
}

/**
 * Build the ranked list.
 *
 * Every input is optional and a missing input yields NO item rather than a false one — a brief that
 * cannot read the stall queue must not therefore claim there are no stalls. Absence of evidence is
 * not evidence of absence, and on a money pipeline that distinction is the whole game.
 *
 * @param {object} i
 * @param {{updatedAt?:string,count?:number}}                     [i.untracked]  queues/untracked-followups.json
 * @param {{updatedAt?:string,count?:number,drafts?:Array}}       [i.stalled]    queues/stalled-drafts.json
 * @param {{updatedAt?:string,honestUnclaimed?:number,count?:number}} [i.unclaimed] queues/unclaimed-revenue.json
 * @param {{updatedAt?:string,stock?:number,burnPerWeek?:number,weeks?:number}} [i.runway] queues/donor-runway.json
 * @param {{updatedAt?:string,count?:number,items?:Array}}        [i.sweep]      queues/sweep-findings.json
 * @param {number|null}                                          [i.lineupTotal] posts scheduled today; -1/null = UNKNOWN
 * @param {Array<{account:string,staleHours:number|null}>}        [i.staleAccounts]
 * @param {number}                                               [i.now]
 * @returns {Array<{id:string,severity:string,title:string,detail:string,action:string,path:string}>}
 */
export function needsYou(i = {}) {
  const now = i.now ?? Date.now();
  const out = [];

  // 1. Data has stopped arriving. Ranks first for the reason in SEVERITY_RANK.
  const dark = (i.staleAccounts ?? []).filter(
    (a) => a.staleHours === null || a.staleHours === undefined || a.staleHours > STALE_HOURS,
  );
  if (dark.length) {
    const never = dark.filter((a) => a.staleHours === null || a.staleHours === undefined);
    out.push({
      id: 'sync',
      severity: 'critical',
      title: `${dark.length} account${dark.length === 1 ? '' : 's'} not reporting`,
      detail: dark
        .map((a) => (a.staleHours == null ? `${a.account} (never)` : `${a.account} (${Math.round(a.staleHours)}h)`))
        .join(', '),
      action: never.length === dark.length
        ? 'Never synced — usually a missing Social Set ID on a new account.'
        : 'Every other figure excludes them until the sync recovers.',
      path: '/settings',
    });
  }

  // 2. Nothing ships today. -1 means the Typefully read FAILED, which is not the same as zero and
  //    must never fire this: a platform outage would otherwise read as an empty pipeline.
  if (i.lineupTotal === 0) {
    out.push({
      id: 'empty-queue',
      severity: 'critical',
      title: 'Zero posts scheduled for today',
      detail: 'No account has anything queued.',
      action: 'Check the pipeline before the 6pm slot — a day of reach is not recoverable.',
      path: '/calendar',
    });
  }

  // 3. Scheduled posts with no revenue tracking. They WILL post and earn $0 attributable.
  if (i.untracked && isFresh(i.untracked.updatedAt, now) && (i.untracked.count ?? 0) > 0) {
    out.push({
      id: 'untracked',
      severity: 'warn',
      title: `${i.untracked.count} scheduled post(s) have no revenue tracking`,
      detail: 'They will publish and earn $0 attributable.',
      action: 'Unschedule in Typefully, or ignore if intentional.',
      path: '/reports',
    });
  }

  // 4. Commission the ledger cannot claim. The reconcile run names every dollar (lv_id -> draft ->
  //    account); this item exists so real leak-money is never only a log line. $25 threshold: below
  //    that the residue is churn (reporting lag, sub-dollar halo rows), not an operator task.
  if (i.unclaimed && isFresh(i.unclaimed.updatedAt, now, WEEKLY_FRESH_MS) && (i.unclaimed.honestUnclaimed ?? 0) >= 25) {
    out.push({
      id: 'unclaimed',
      severity: 'warn',
      title: `$${Number(i.unclaimed.honestUnclaimed).toFixed(2)} commission the ledger can't claim`,
      detail: `${i.unclaimed.count ?? '?'} earning link(s) outside any post's claim (weekly reconcile, as of ${String(i.unclaimed.updatedAt).slice(0, 10)}).`,
      action: 'Open the reconcile log — every unclaimed dollar is named lv_id → draft → account.',
      path: '/reports',
    });
  }

  // 4b. Fresh-donor runway (H3, operator scaling phase). Under 8 weeks of stock at the current
  //     burn, the doubling eats the pool before anyone notices. Weekly cadence -> 8-day freshness.
  if (i.runway && isFresh(i.runway.updatedAt, now, WEEKLY_FRESH_MS) && i.runway.weeks != null && i.runway.weeks < 8) {
    out.push({
      id: 'runway',
      severity: 'warn',
      title: `~${i.runway.weeks} weeks of fresh donors left`,
      detail: `${i.runway.stock} engine-grade unused donors · burning ${i.runway.burnPerWeek}/wk.`,
      action: 'Widen the scraper sources, or lean the mix further into harvest/blitz.',
      path: '/reports',
    });
  }

  // 5. Built, monetized, never queued. Recoverable inventory rather than work to redo.
  if (i.stalled && isFresh(i.stalled.updatedAt, now) && (i.stalled.count ?? 0) > 0) {
    const oldest = i.stalled.drafts?.[0]?.days;
    out.push({
      id: 'stalled',
      severity: 'warn',
      title: `${i.stalled.count} finished thread(s) built but never queued`,
      detail: oldest != null ? `Oldest ${oldest}d, on monetized pages.` : 'On monetized pages.',
      action: 'Links are already live, so scheduling needs no regeneration. Add [parked] to a title to drop it.',
      path: '/reports',
    });
  }


  // 7. The fleet sweep's standing findings. sweep.mjs runs every checklist the repo has and writes
  //    what it found here; this surfaces the headline rather than the list, because the list is
  //    long by design and the brief is not where you work through it. Severity is the WORST thing
  //    it found, so a single broken link cannot hide behind eighty pod-drift warnings.
  if (i.sweep && isFresh(i.sweep.updatedAt, now) && (i.sweep.count ?? 0) > 0) {
    const items = i.sweep.items || [];
    const worst = items.reduce((w, f) => ((SEVERITY_RANK[f.severity] ?? 9) < (SEVERITY_RANK[w] ?? 9) ? f.severity : w), 'info');
    const n = (sev) => items.filter((f) => f.severity === sev).length;
    out.push({
      id: 'sweep',
      severity: worst === 'critical' ? 'critical' : 'warn',
      title: `Fleet sweep: ${n('critical')} critical · ${n('warn')} warn`,
      detail: items.slice(0, 3).map((f) => f.title).join(' · ') || `${i.sweep.count} finding(s)`,
      action: 'node sweep.mjs — the full list, ranked by what each costs.',
      path: '/reports',
    });
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Stable emoji per id, so the same problem looks the same wherever it is rendered. */
const ICON = { sync: '📡', 'empty-queue': '🗓', untracked: '⚠️', stalled: '🗃', unclaimed: '🧾' };

/**
 * Render for Telegram. Deep-links to the dashboard when DASHBOARD_URL is set, because the message
 * should say WHAT and HOW URGENT and then hand off — reproducing the detail inline is what turned
 * the channel into something to scroll past.
 */
export function renderTelegram(items, dashboardUrl) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Verb-first: the ACTION leads in bold, because the operator's actual question in this section
  // is "what do I DO", not "what is wrong" — the wrong order is how this list earned the review
  // "useless, I have no idea what to do there". The link goes straight to the page that fixes it.
  return items.map((it) => {
    const link = dashboardUrl
      ? ` → <a href="${dashboardUrl.replace(/\/$/, '')}${it.path}">fix it here</a>`
      : '';
    return `${ICON[it.id] ?? '•'} <b>${esc(it.action)}</b>${link}\n     ${esc(it.title)}: ${esc(it.detail)}`;
  });
}
