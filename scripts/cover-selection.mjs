// Read-only account allocation for a canonical cover picker (scripts/pick-donors.mjs) snapshot.
// The picker, not this module, chooses the donor set and enforces arm/exploration floors,
// burn, hard attribution, and adjacent-day Typefully overlap. This pass gives that vetted
// set to the best-fitting accounts together instead of spending it in account iteration order.
import { createHash } from 'node:crypto';
import { screenDonor, rankDonors } from '../preflight.mjs';
import { bodyOverlap, fabricationFlags, tweetsFromRollup } from '../checks.mjs';
import { sourceHandle } from './cover-source-breadth.mjs';

const HARD = 'quote attributed to a named person';
const DAY_MS = 864e5;
// An out-of-niche match waits for the owner. Their approval of the exact row is that review
// (plan-product-review.mjs reads it so).
export const FIT_REVIEW_HOLD = 'held: account fit needs owner review';

const hashTie = (slotId, recId) => createHash('sha256').update(`${slotId}\0${recId}`).digest().readUInt16BE(0) % 100;
const overlap = (a, b) => Math.max(bodyOverlap(a, b), bodyOverlap(b, a));
const dayDistance = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

// ACCOUNT FIT IS RETIRED (owner 2026-11-04: "retire the concept of account-fit and niche-fit per page.
// That's BS. all pages are the same."). Every page takes every donor the picker vetted, so no row holds
// for an account-fit review and the matching no longer prefers a page's stated niches or topic focus.
// The function stays so callers and packets keep their shape; FIT_REVIEW_HOLD stays exported so an
// older approved packet that carries it still reads as approved.
export function accountFit(_account, donor = {}) {
  if (donor.offNicheException) return { tier: 'compatible', reason: `@${donor.offNicheException} is an owner off-niche exception` };
  return { tier: 'compatible', reason: 'every page is the same: no per-page fit (owner 2026-11-04)' };
}

// Rectangular maximum-weight matching. A dummy column for every slot permits honest unfilled
// results when its account cannot use any of the canonical picked donors. No account gets priority.
function maxWeightMatching(weights) {
  const n = weights.length;
  if (!n) return [];
  const realCols = weights[0].length;
  const m = realCols + n;
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0);
  const p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  const cost = (i, j) => j > realCols ? 0 : (weights[i - 1][j - 1] == null ? 1e9 : -weights[i - 1][j - 1]);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0, j) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]; p[j0] = p[j1]; j0 = j1;
    } while (j0 !== 0);
  }
  const result = Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] && j <= realCols) result[p[j] - 1] = j - 1;
  return result;
}

export function validateSnapshot(snapshot) {
  if (snapshot?.schema !== 'cover-picker-snapshot-v1' || snapshot.complete !== true
    || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.selected)
    || !/^\d{4}-\d\d-\d\d$/.test(snapshot.date || '')) {
    throw new Error('A complete cover-picker-snapshot-v1 is required; partial or legacy reads cannot plan a run');
  }
  if (snapshot.poolCount !== snapshot.records.length) throw new Error('Snapshot pool count does not match records');
  if (snapshot.selected.length !== snapshot.controls?.need) throw new Error('Canonical picker returned fewer donors than requested; resolve this before allocation');
  // A day short of RECENT donors is reported, not refused (owner 2026-09-28: the selection should never
  // hold up on a shortage; the picker filled those slots by merit). The older-band and topic targets
  // still refuse, as before: their pools are deep, so a miss there means the picker went wrong.
  if (snapshot.quotaMisses && Object.entries(snapshot.quotaMisses).some(([k, n]) => k !== 'fresh' && n > 0)) {
    throw new Error('Canonical picker missed an age or topic target; resolve the selection before allocation');
  }
  const ids = new Set(snapshot.records.map((r) => r.id));
  if (ids.size !== snapshot.records.length) throw new Error('Snapshot has duplicate Airtable record IDs');
  if (new Set(snapshot.selected.map((d) => d.recId)).size !== snapshot.selected.length
    || snapshot.selected.some((d) => !ids.has(d.recId))) throw new Error('Canonical selected donors are missing or duplicated in the complete pool');
  if (snapshot.selectedIds && JSON.stringify(snapshot.selectedIds) !== JSON.stringify(snapshot.selected.map((d) => d.recId))) {
    throw new Error('Snapshot selected IDs do not match the canonical selected donor objects');
  }
  return snapshot;
}

const sourceView = (donor, record, pickerRank = null) => ({
  recId: donor.recId, url: record?.fields?.['Tweet URL'] || null,
  sourceCreator: sourceHandle(record?.fields?.['Tweet URL']),
  hook: record?.fields?.Text || donor.hook || '',
  publishedDate: record?.fields?.['Published Date'] || null, pickerRank,
  views: donor.views, arm: donor.arm, age: donor.age, topic: donor.topic, ...(donor.pinned ? { pinned: true } : {}),
  ...(donor.freshWinner ? { freshWinner: donor.freshWinner } : {}), ...(donor.offNicheException ? { offNicheException: donor.offNicheException } : {}),
  ...(donor.jevPod ? { jevPod: donor.jevPod } : {}), ...(donor.translate ? { translate: donor.translate } : {}),
  score: donor.score, factors: {
    reach: donor.reach, recency: donor.recency, intent: donor.intent,
    novelty: donor.novelty, bridgesTest: donor.bridgesTest,
    sellSlots: donor.sellSlots?.length || 0, roundup: !!donor.roundup, listicle: !!donor.listicle,
  },
});

function quotaSafe(snapshot, removed, added) {
  const hot = new Set(snapshot.controls.hotTopics || []);
  const counts = (set) => ({
    archive: set.filter((d) => d.arm !== 'fresh').length,
    evergreen: set.filter((d) => ['evergreen', 'og'].includes(d.arm)).length,
    og: set.filter((d) => d.arm === 'og').length,
    explore: set.filter((d) => !hot.has(d.topic)).length,
  });
  const before = counts(snapshot.selected);
  const after = counts(snapshot.selected.map((d) => d.recId === removed.recId ? added : d));
  const targets = {
    archive: snapshot.controls.archiveTarget || 0, evergreen: snapshot.controls.evergreenTarget || 0,
    og: snapshot.controls.ogTarget || 0, explore: snapshot.controls.exploreTarget || 0,
  };
  return Object.keys(targets).every((k) => after[k] >= Math.min(before[k], targets[k]));
}

function alternativesFor({ snapshot, slot, assigned, recordsById, screened, allAssignments, account, priorAssignments, max = 2 }) {
  const taken = new Set(snapshot.selected.map((d) => d.recId));
  const blocked = new Set(snapshot.burnedIds || []);
  const committed = snapshot.shipped || [];
  const warn = snapshot.controls.warn;
  const others = allAssignments.filter((x) => x.slot.id !== slot.id && x.donor);
  const eligible = [];
  for (const d of screened) {
    if (!d.usable || taken.has(d.recId) || blocked.has(d.recId)) continue;
    const body = tweetsFromRollup(String(recordsById.get(d.recId)?.fields?.['Full Thread Text'] || ''));
    if (body.length < 3 || fabricationFlags(body).some((f) => f.kind === HARD)) continue;
    if (committed.some((x) => overlap(body, x) >= warn)) continue;
    if (others.some((x) => dayDistance(slot.date, x.slot.date) <= 1 && overlap(body, x.donor.body) >= warn)) continue;
    if (priorAssignments.some((x) => x.donor.recId === d.recId || overlap(body, x.donor.body) >= warn)) continue;
    if (priorAssignments.some((x) => x.slot.account === slot.account && x.donor.recId === d.recId)) continue;
    const ranked = rankDonors([d], { topicUses: snapshot.topicUses || {} })[0];
    if (!quotaSafe(snapshot, assigned, ranked)) continue;
    eligible.push({ donor: ranked, fit: accountFit(account, ranked) });
  }
  const level = { specific: 2, compatible: 1, review: 0 };
  eligible.sort((a, b) => level[b.fit.tier] - level[a.fit.tier]
    || b.donor.score - a.donor.score || a.donor.recId.localeCompare(b.donor.recId));
  return eligible.slice(0, max).map(({ donor, fit }) => ({
    ...sourceView(donor, recordsById.get(donor.recId)), fit,
    status: 'screened swap candidate; rerun canonical picker and group checks before approval',
  }));
}

/** Pure. A snapshot supplies exactly the N canonical picked donors for N dated account slots. */
export function allocateCoverSnapshot(snapshot, slots, accounts, priorAssignments = []) {
  validateSnapshot(snapshot);
  if (!Array.isArray(slots) || slots.length !== snapshot.selected.length
    || slots.some((s) => s.date !== snapshot.date || !s.id || !accounts[s.account])) {
    throw new Error(`Snapshot ${snapshot.date} requires exactly ${snapshot.selected.length} valid account slots on that date`);
  }
  if (new Set(slots.map((s) => s.id)).size !== slots.length) throw new Error('Slot IDs must be unique');
  const recordsById = new Map(snapshot.records.map((r) => [r.id, r]));
  const rankById = new Map(snapshot.selected.map((d, i) => [d.recId, i + 1]));
  const donors = snapshot.selected.slice().sort((a, b) => a.recId.localeCompare(b.recId));
  const orderedSlots = slots.slice().sort((a, b) => a.id.localeCompare(b.id));
  const usedByAccount = (slot, donor) => priorAssignments.some((x) => x.slot.account === slot.account && x.donor?.recId === donor.recId);
  // A donor the owner pinned (donor-pins.mjs) is meant to run on several pages across the run, so its own
  // earlier copies are not a conflict; another donor's body still is, and no page takes it twice.
  const priorConflictOf = (donor) => priorAssignments.some((x) => x.donor && !(donor.pinned && x.donor.recId === donor.recId)
    && (x.donor.recId === donor.recId || overlap(donor.body || [], x.donor.body || []) >= snapshot.controls.warn));
  const weights = orderedSlots.map((slot) => donors.map((donor) => {
    if (usedByAccount(slot, donor)) return null;
    if (priorConflictOf(donor)) return null;
    const tier = accountFit(accounts[slot.account], donor).tier;
    return ({ specific: 2, compatible: 1, review: 0 })[tier] * 100 + hashTie(slot.id, donor.recId);
  }));
  const assignment = maxWeightMatching(weights);
  const allAssignments = orderedSlots.map((slot, i) => ({ slot, donor: assignment[i] < 0 ? null : donors[assignment[i]] }));
  const screened = snapshot.records.map((r) => screenDonor({ ...r.fields, recId: r.id }, {
    products: (snapshot.productAsins || []).map((asin) => ({ asin })),
    now: Date.parse(snapshot.fetchedAt), viewFloor: snapshot.controls.floor,
  }));
  const rows = allAssignments.map(({ slot, donor }) => {
    const fit = donor ? accountFit(accounts[slot.account], donor) : null;
    const priorConflict = donor && priorConflictOf(donor);
    return {
      id: slot.id, account: slot.account, date: slot.date,
      status: donor ? (priorConflict ? 'held: planned-run source overlap'
        : fit.tier === 'review' ? FIT_REVIEW_HOLD : 'proposed') : 'held: no assignable canonical donor',
      selected: donor ? { ...sourceView(donor, recordsById.get(donor.recId), rankById.get(donor.recId)), fit } : null,
      alternatives: donor ? alternativesFor({ snapshot, slot, assigned: donor, recordsById, screened,
        allAssignments, account: accounts[slot.account], priorAssignments }) : [],
    };
  });
  const fitTiers = Object.fromEntries(['specific', 'compatible', 'review'].map((tier) =>
    [tier, rows.filter((r) => r.selected?.fit.tier === tier).length]));
  const heldReasons = Object.fromEntries([...new Set(rows.filter((r) => r.status.startsWith('held')).map((r) => r.status))]
    .map((reason) => [reason, rows.filter((r) => r.status === reason).length]));
  const distribution = (values) => Object.fromEntries([...new Set(values)].sort().map((value) =>
    [value, values.filter((item) => item === value).length]));
  // Treat even held canonical allocations as provisional occupancy for a later day. The owner may
  // explicitly approve one, so allowing a near-twin tomorrow would make that decision unsafe.
  return { rows, assignments: allAssignments.filter((x) => x.donor),
    summary: { date: snapshot.date, poolComplete: true, poolCount: snapshot.poolCount,
      canonicalSelected: snapshot.selected.length, allocated: rows.filter((r) => r.status === 'proposed').length,
      held: rows.filter((r) => r.status.startsWith('held')).length,
      fitTiers, heldReasons,
      topics: distribution(rows.map((r) => r.selected?.topic).filter(Boolean)),
      ageArms: distribution(rows.map((r) => r.selected?.arm).filter(Boolean)),
      recentShortfall: snapshot.quotaMisses?.fresh || 0,
      listicles: rows.filter((r) => r.selected?.factors.listicle).length,
      sourceCreators: distribution(rows.map((r) => r.selected?.sourceCreator).filter(Boolean)),
      unknownSourceCreators: rows.filter((r) => r.selected && !r.selected.sourceCreator).length,
      accounts: distribution(rows.map((r) => r.account)),
      controls: snapshot.controls, source: snapshot.source, fetchedAt: snapshot.fetchedAt } };
}

export function chunkSelectionRows(rows, size = 8) {
  if (!Number.isInteger(size) || size < 1 || size > 30) throw new Error('chunkSize must be an integer from 1 to 30');
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    const group = rows.slice(i, i + size);
    chunks.push({ id: `selection-${String(chunks.length + 1).padStart(3, '0')}`,
      rowIds: group.map((r) => r.id), rows: group });
  }
  return chunks;
}
