// boosters.mjs — the booster pages and their day (owner, 2026-10-03; docs/booster-lane.md).
//
// Owner: "for the boosting account, they can cross over between the pages because now they will become a theme page"
// and, per booster per day, "3 reposted singles + 3 QRTs from the Article database + 3 QRTs of our accounts' threads
// (randomized), zig-zagged so QRTs aren't consecutive". The five pages and the defaults were agreed on 2026-10-03
// ("go with the booster defaults"): single → article QRT → thread QRT, three times a day, 5 minutes from any other
// fleet post. Natella and Lucinda are not boosters yet (owner: "don't use Natella and Lucinda yet").
// Owner, 2026-10-06, on the pages whose own threads paid back least (30 days to Oct 4: net after RT $180-$401):
// "move Rose Mary, Live, Violet, Džejla and Rasumus — let's keep Lorenzo in content lane." Ten boosters since; a booster
// takes no threads in a /run (scripts/run-intake.mjs eligibleAccounts).
//
// THE DAY, in UTC (fleet threads publish 05:00–16:00 UTC, most at 10:00–13:00; Published Feed, 2026-10-03):
//   S  02:00  a single, in the morning singles window (08:00–10:00 Saigon)
//   A  07:30  an Article-DB QRT (the cold lane)
//   T  09:00  a fleet thread's QRT: the morning's threads are 1–4h old
//   S  12:10  a single, in the evening singles window (19:00–22:00 Saigon)
//   A  12:50
//   T  13:30  the peak's threads, 1–3h old
//   S  14:00  (14:10 until 2026-10-06: ten boosters 6 minutes apart must all land inside the singles window)
//   A  14:50
//   T  16:30  the evening's threads
// Each booster runs the same day STAGGER_MIN later than the one before it, so five pages never post the same minute;
// at booking, every slot still moves forward to keep 5 minutes from any fleet post (slots.mjs MIN_SLOT_GAP_MIN).
export const BOOSTERS = Object.freeze(['muah', 'johnathan', 'felicia', 'peak', 'irana', 'rosemary', 'live', 'violet', 'dzejla', 'rasmus']);
export const NOT_YET = Object.freeze(['natella', 'lucinda']);
export const KINDS = Object.freeze({ S: 'single', A: 'article QRT', T: 'thread QRT' });
export const DAY = Object.freeze([
  { kind: 'S', utc: '02:00' }, { kind: 'A', utc: '07:30' }, { kind: 'T', utc: '09:00' },
  { kind: 'S', utc: '12:10' }, { kind: 'A', utc: '12:50' }, { kind: 'T', utc: '13:30' },
  { kind: 'S', utc: '14:00' }, { kind: 'A', utc: '14:50' }, { kind: 'T', utc: '16:30' },
].map(Object.freeze));
export const STAGGER_MIN = 6;
// Since 2026-10-07 a booster's thread QRTs are the sister lines on each thread's echo slate (echo-qrt.mjs pickSisters:
// 5 boosters per thread at about +6 minutes, +3h, +5h, +12h and +16h; owner: "the 3 sister QRTs should be on the Booster pages").
// The T slots below only book lines saved before then. Until then:
// Fleet-thread QRTs: a thread is eligible 1–8h after it publishes, at most this many boosters quote it, and the pick is
// random among the fastest few (owner: "randomized"; the agreed default: "the day's fastest threads").
export const THREAD_QRT = Object.freeze({ minAgeH: 1, maxAgeH: 8, maxBoostersPerThread: 2, pickFrom: 3, linesPerThread: 2 });

/** The booster's index, or -1 when the page is not a booster. */
export const boosterIndex = (key) => BOOSTERS.indexOf(String(key || '').toLowerCase());
export const isBooster = (key) => boosterIndex(key) >= 0;

/** PURE. One booster's day: nine slots in order, `{ kind, at }` with `at` an ISO UTC minute, on the UTC date `date`. */
export function boosterDay(key, date) {
  const i = boosterIndex(key);
  if (i < 0) throw new Error(`boosters: "${key}" is not a booster page (${BOOSTERS.join(', ')})`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`boosters: date must be YYYY-MM-DD, got "${date}"`);
  return DAY.map(({ kind, utc }) => {
    const [h, m] = utc.split(':').map(Number);
    return { kind, at: new Date(Date.parse(`${date}T00:00:00Z`) + ((h * 60 + m) + i * STAGGER_MIN) * 60000).toISOString() };
  });
}

/** PURE. A booster's slots of one kind ('S' | 'A' | 'T') over `days` UTC dates from `from`. */
export function boosterSlots(key, kind, from, days = 1) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    out.push(...boosterDay(key, date).filter((s) => s.kind === kind).map((s) => s.at));
  }
  return out;
}

/** PURE. True when no two QRT slots of the same kind are adjacent and the kinds alternate S → A → T. */
export const zigzags = (slots) => slots.every((s, i) => s.kind === 'SAT'[i % 3]);
