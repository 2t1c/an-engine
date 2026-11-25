// Pure source-coverage checks shared by the live cover picker and its offline tests.
// A picker snapshot contains the selected bodies and the Airtable records that supplied
// their source URLs; never persist the bodies in Git.
import { bodyOverlap } from '../checks.mjs';

export function sourceHandle(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())) return null;
    const [name] = parsed.pathname.split('/').filter(Boolean);
    if (!name || ['i', 'intent', 'home', 'search'].includes(name.toLowerCase())) return null;
    return name.toLowerCase();
  } catch { return null; }
}

export function priorSourceContexts(snapshots, targetDate) {
  const dates = new Set();
  const prior = [];
  for (const snap of snapshots) {
    if (snap?.schema !== 'cover-picker-snapshot-v1' || snap.complete !== true
      || !Array.isArray(snap.selected) || !Array.isArray(snap.records)) {
      throw new Error('prior snapshot must be a complete cover-picker-snapshot-v1 with selected and records');
    }
    if (!/^\d{4}-\d\d-\d\d$/.test(String(snap.date)) || snap.date >= targetDate || dates.has(snap.date)) {
      throw new Error('prior snapshots need distinct dates before the target date');
    }
    dates.add(snap.date);
    const records = new Map(snap.records.map((r) => [r.id, r]));
    for (const selected of snap.selected) {
      const record = records.get(selected.recId);
      if (!record || !Array.isArray(selected.body) || selected.body.length < 3) {
        throw new Error(`prior snapshot ${snap.date} has an incomplete selected donor: ${selected.recId}`);
      }
      prior.push({ recId: selected.recId, body: selected.body,
        handle: sourceHandle(record.fields?.['Tweet URL']), date: snap.date });
    }
  }
  return prior;
}

export function sourceBreadthConflict(candidate, used, { warn = 0.2, handleCap = 0 } = {}) {
  if (used.some((row) => row.recId === candidate.recId)) return 'source record already selected in this run';
  if (handleCap > 0 && candidate.handle && used.filter((row) => row.handle === candidate.handle).length >= handleCap) {
    return `@${candidate.handle} reaches source-handle cap ${handleCap} for this run`;
  }
  const overlap = (a, b) => Math.max(bodyOverlap(a, b), bodyOverlap(b, a));
  if (used.some((row) => overlap(candidate.body, row.body) >= warn)) return 'source body overlaps a donor already selected in this run';
  return null;
}
