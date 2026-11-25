#!/usr/bin/env node
// fuel-split.mjs — the A/B readout for the Fuel the Fire split test. Read-only: nothing here fires,
// bills or edits.
//
// Arm A is the full ladder. Arm B is whatever the Config row "Fuel Split Test" names. Since
// 2026-09-27 07:00:42Z that is the T1-off test: every tier but T1, each at its own bar ("go t1 off to
// replace the arm a vs b test"), and since 07:38:58Z arm A's T1 needs 10,000 views and 5,000/h. Before
// it ran the reduced ladder (T0 + T1 + T4, with T4 buying at T3's requirements), 2026-09-14 → 09-27.
// The arm is an FNV-1a hash of the status id, so any thread can be
// placed whether or not it carries a stamp. The tests and their windows are fuel-ops-core.mjs
// SPLIT_TESTS: a new Config row needs a new entry there, or the readout says so.
//
// WHAT THIS REFUSES TO DO. Commission per thread has CV ~2.7 and about half of all threads earn
// exactly zero, so the two arms differ by double digits with nothing done to them. Splitting the
// pre-test history by this same hash and changing NOTHING already produced a 22.5% gap. This script
// therefore never prints a winner on a raw difference: every comparison carries a 95% interval and
// the verdict stays "not decidable" until that interval clears zero. The PLACEBO block is the
// control that makes it honest — threads that fired before the test existed, split the same way,
// whose gap is pure noise by construction. A live gap no bigger than the placebo gap is nothing.
//
// The SPEND block is different and is stated as exact: what each arm cost and reached is billed,
// not inferred, and is knowable on day one. That is the half of the experiment that resolves fast.
//
//   node fuel-split.mjs                         # the current test: table + Telegram digest (fuel topic)
//   node fuel-split.mjs --dry                   # console only
//   node fuel-split.mjs --test reduced-ladder   # an earlier test, over its own window
import { pathToFileURL } from 'node:url';
import { loadEnv, telegram, esc, report, logRun, runMain } from './lib.mjs';
import { fuelRows, configRows } from './fuel-ops-io.mjs';
import { splitReadout, splitWindow, SPLIT_TESTS, SPLIT_CURRENT, SPLIT_LAST_COMPARED } from './fuel-ops-core.mjs';
import { splitTest, armOf } from './routing.mjs';

const DRY = process.argv.includes('--dry');

/** `--test <key>` or `--test=<key>`; undefined without the flag, which reads the current test. A flag
 *  with no key is an error, never a silent read of the current test under another test's name. */
export function testKeyOf(argv = process.argv) {
  const eq = argv.find((a) => a.startsWith('--test='));
  const i = argv.indexOf('--test');
  if (!eq && i < 0) return undefined;
  const key = eq ? eq.slice('--test='.length) : argv[i + 1];
  if (!key || key.startsWith('--')) throw new Error('--test needs a test key');
  return key;
}
const labelOf = (t) => `${t.tiers.map((x) => (t.bars[x] ? `${x}@${t.bars[x]}` : x)).join('+')} · ${t.pct}% to B`;

/** The one line that says the Config row and the readout disagree, or '' when they agree. The row can
 *  be flipped in Airtable without a deploy, and a readout still anchored to the old test would blend
 *  both into one table without a word. `live` is splitTest() of the Config rows, null when off. */
export function switchMismatch(win, live) {
  if (win.to) return '';   // a finished test is read over its own window, whatever the row says now
  const own = splitTest([{ Name: 'Fuel Split Test', Active: true, Routes: win.routes }]);
  if (!live) return `the Config switch is off: this covers ${win.key} up to the moment it was switched off`;
  if (JSON.stringify(live) !== JSON.stringify(own)) return `the Config row runs ${labelOf(live)}, not ${win.key} (${labelOf(own)}): add it to SPLIT_TESTS in fuel-ops-core.mjs, or this readout blends two tests`;
  return '';
}
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const perM = (v) => (v == null ? '—' : '$' + v.toFixed(2));
const MIN_SPEND_N = 20;   // threads per arm before a per-thread cost average means anything

/** What each arm actually cost per thread. Billed, so it needs no confidence interval — but it is
 *  still an average over a tier mix, so it stays PROVISIONAL until both arms have real volume. */
export function spendLine(A, B) {
  if (!A.threads || !B.threads) return 'SPEND: not both arms have fired yet';
  const a = A.spend / A.threads, b = B.spend / B.threads;
  const d = a - b;
  const dir = d > 0 ? `${money(d)} LESS` : `${money(-d)} MORE`;
  const tag = Math.min(A.threads, B.threads) < MIN_SPEND_N
    ? `  (provisional — only ${Math.min(A.threads, B.threads)} thread(s) in the smaller arm; a tier mix needs ~${MIN_SPEND_N} to even out)`
    : '  (exact — billed, not estimated)';
  return `SPEND: B costs ${dir} per thread than A — ${money(b)} vs ${money(a)}${tag}`;
}

/** Plain-text verdict for one cohort. Deliberately blunt: the failure mode this guards against is
 *  the operator reading a noisy gap as a result and cutting three vendors on it. */
export function verdictOf(live, placebo) {
  const t = live.test;
  if (t.a.n < 2 || t.b.n < 2) return { text: 'not enough mature threads in both arms yet — no comparison is possible', decided: false };
  if (!t.decidable) {
    const need = t.nPerArm ? `${t.nPerArm.toLocaleString()} mature threads per arm would be needed to call a gap this size` : 'the arms are indistinguishable';
    const pl = placebo.test;
    const noise = pl.decidable || !pl.pct ? '' : ` · the same split applied to pre-test history moves ${pl.pct > 0 ? '+' : ''}${pl.pct.toFixed(1)}% with no intervention at all, which is the noise floor`;
    return { text: `NOT DECIDABLE — the 95% interval still straddles zero. ${need}${noise}`, decided: false };
  }
  return { text: `DECIDABLE — B is ${t.diff > 0 ? 'ahead' : 'behind'} by ${money(Math.abs(t.diff))}/thread (95% CI ${money(t.lo)} to ${money(t.hi)})`, decided: true };
}

async function main() {
  await runMain(async () => {
    const asked = testKeyOf();
    // Once an arm is retired nothing runs to compare, so the default is the last window that did.
    const retired = asked === undefined && SPLIT_CURRENT.compare === false;
    const key = retired ? SPLIT_LAST_COMPARED.key : asked;
    const win = splitWindow(key);
    if (!win) throw new Error(`--test ${key}: no such test (${SPLIT_TESTS.map((s) => s.key).join(', ')})`);
    const env = loadEnv();
    const cfg = (await configRows(env)).map((r) => r.fields || r);
    // The hash places unstamped rows; it only reads the B share (50% in every window that compared).
    const test = splitTest([{ Name: 'Fuel Split Test', Active: true, Routes: win.routes }]);
    const rows = (await fuelRows(env)).map((r) => r.fields || r);
    const out = splitReadout(rows, (id) => armOf(id, test), { liveFrom: win.from, liveTo: win.to, unit: win.unit });
    // WHICH THREADS: the unit follows the arms' entry tiers (fuel-ops-core.mjs SPLIT_TESTS). T1 off
    // counts every thread published in the window, because its arms enter the ladder at different tiers.
    const POST = win.unit === 'post';

    const label = `${win.key} — arm A = ${win.a} · arm B = ${labelOf(test)} · ${win.from.slice(0, 16)}Z → ${win.to ? `${win.to.slice(0, 16)}Z` : 'now'}`;
    console.log(`fuel split test ${label}`);
    const retiredLine = retired ? `No A/B test runs now: since ${SPLIT_CURRENT.from.slice(0, 16)}Z arm A is ${SPLIT_CURRENT.a} (${SPLIT_CURRENT.key}). This is the last comparison, closed.` : '';
    if (retiredLine) console.log(retiredLine);
    console.log(POST ? 'unit: every thread published in the window, fueled or not (the arms enter the ladder at different tiers)\n'
      : 'unit: threads the ladder bought for (both arms enter at the same tier)\n');
    // Checked against the CURRENT record entry, whichever window is being read: the row must be
    // what the record says runs now.
    const mismatch = switchMismatch(splitWindow(), splitTest(cfg));
    if (mismatch) console.log(`⚠ ${mismatch}\n`);

    const liveName = POST ? 'LIVE (every thread published under the test, by arm)' : 'LIVE (stamped — actually fired under the test)';
    for (const [name, c] of [[liveName, out.live], ['PLACEBO (pre-test threads, same hash, no intervention)', out.placebo]]) {
      console.log(name);
      console.log('  arm  threads    spend      reach     $/M   mature   comm/thread');
      for (const k of ['A', 'B']) {
        const a = c[k];
        console.log(`  ${k}   ${String(a.threads).padStart(7)} ${money(a.spend).padStart(9)} ${((a.reach / 1e6).toFixed(0) + 'M').padStart(9)} ${perM(a.perM).padStart(8)} ${String(a.mature).padStart(7)}   ${money(a.meanComm)}`);
      }
      const t = c.test;
      // Gated on `sufficient`, never on "both arms have at least one" — see welch(). An interval
      // computed from a single observation is narrower than the truth, not wider, so printing it
      // is worse than printing nothing.
      if (t.sufficient) console.log(`  B − A: ${money(t.diff)}/thread${t.pct == null ? '' : ` (${t.pct > 0 ? '+' : ''}${t.pct.toFixed(1)}%)`} · 95% CI ${money(t.lo)} to ${money(t.hi)}`);
      else if (t.a.n || t.b.n) console.log(`  B − A: not computable — ${t.a.n} mature in A, ${t.b.n} in B (need 2+ in each before an interval means anything)`);
      console.log('');
    }

    // Billed, not inferred — but a per-thread AVERAGE is still an average, so it is marked
    // provisional until each arm has enough threads for the mix of tiers to have evened out.
    // Reporting "B saves $X" off one thread per arm would be the same sin as calling the gap above.
    const L = out.live;
    console.log(spendLine(L.A, L.B));
    const did = POST ? 'published' : 'fueled';
    if (out.straddlers) console.log(`  (${out.straddlers} thread(s) held out — their ${POST ? 'ledger' : 'ladder spend'} crosses a start or end of this test, so they are neither arm)`);
    if (out.earlier) console.log(`  (${out.earlier} thread(s) ${did} before this test began — an earlier test's, not counted here)`);
    if (out.later) console.log(`  (${out.later} thread(s) ${did} after this test ended — a later test's, not counted here)`);
    if (out.undated) console.log(`  (${out.undated} thread(s) with no dated ledger line — cannot be placed, not counted)`);
    const v = verdictOf(out.live, out.placebo);
    console.log(`\nVERDICT: ${v.text}`);

    if (!DRY) {
      const line = (k, a) => `• ${k} — ${a.threads} threads · ${money(a.spend)} · ${(a.reach / 1e6).toFixed(0)}M · ${perM(a.perM)}/M · ${money(a.meanComm)}/thread (n=${a.mature})`;
      await telegram(env, report({
        emoji: '🧪', title: 'Fuel split test', scope: label,
        status: `${L.A.threads + L.B.threads} threads ${POST ? 'were published under' : 'have fired under'} ${win.key}`,
        sections: [
          ...(mismatch ? [{ label: 'SWITCH', body: esc(mismatch) }] : []),
          ...(retiredLine ? [{ label: 'STATUS', body: esc(retiredLine) }] : []),
          { label: 'LIVE', body: [line('A', L.A), line('B', L.B)].join('\n') },
          { label: 'SPEND', body: esc(spendLine(L.A, L.B)) },
          { label: 'VERDICT', body: esc(v.text) },
        ],
        action: v.decided ? 'The interval clears zero — this gap is real.' : 'Do not act on the gap above: it is still inside the noise.',
      }), 'fuel').catch((e) => console.error('telegram:', e.message));
    }
    logRun('fuel-split', { test: win.key, liveA: L.A.threads, liveB: L.B.threads, decided: v.decided });
  }, 'fuel-split');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
