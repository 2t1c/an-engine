// Conservative lifecycle repair. No deletes; complete fleet reads are an explicit prerequisite.
const PC = 'Published Content';
const blank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const id = (v) => blank(v) ? '' : String(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const stable = (v) => JSON.stringify(v, Object.keys(v).sort());
const equal = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function safeGhost(f) {
  if (!['', 'Draft', 'Scheduled', 'Stalled'].includes(f.Status || '')) return false;
  if (['X URL', 'Threads URL', 'Published At', 'Published Date'].some((k) => !blank(f[k]))) return false;
  // Negative reversals and malformed numbers are evidence too, never interpreted as zero.
  for (const [k, v] of Object.entries(f)) {
    if (/commission|revenue|sales|orders|clicks|impressions|likes|bookmarks/i.test(k) && !blank(v) && Number(v) !== 0) return false;
  }
  return true;
}

export function planRegistryReconciliation({ inventory = [], expectedAccounts = [], records = [], harvests = [], seeds = [], previousState = {}, complete = false, convertedNames = [], now = Date.now(), graceMs = 6 * 3600000 }) {
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 6 * 3600000) throw new Error('Invalid reconciliation clock/grace');
  const diagnostics = [], patches = [], nextState = { version: 1, missing: {}, lastReceipts: clone(Array.isArray(previousState.lastReceipts) ? previousState.lastReceipts.slice(-100) : []) };
  const expected = expectedAccounts.filter((a) => !a.external);
  const names = new Map(expected.map((a) => [a.name, a]));
  const accountsValid = expected.length > 0 && names.size === expected.length && new Set(expected.map((a) => id(a.socialSetId))).size === expected.length && expected.every((a) => a.name && /^\d+$/.test(id(a.socialSetId)));
  const inventoryValid = inventory.length === expected.length && new Set(inventory.map((x) => x.acc?.name)).size === expected.length && inventory.every((x) => names.has(x.acc?.name) && id(names.get(x.acc.name).socialSetId) === id(x.acc.socialSetId) && Array.isArray(x.drafts) && x.drafts.every((d) => /^\d+$/.test(id(d.id))));
  const duplicates = new Map();
  for (const r of records) if (id(r.fields['Draft ID'])) {
    const key = id(r.fields['Draft ID']);
    duplicates.set(key, [...(duplicates.get(key) || []), r.id]);
  }
  const duplicateIds = new Set([...duplicates].filter(([, rs]) => rs.length > 1).map(([key, rs]) => { diagnostics.push({ kind: 'duplicate-draft-id', draftId: key, records: rs }); return key; }));
  if (!complete || !accountsValid || !inventoryValid) {
    diagnostics.push({ kind: 'incomplete-inventory', message: 'All lifecycle writes and missing observations deferred' });
    return { patches, nextState: clone(previousState), diagnostics, blockFarm: true, complete: false };
  }
  const live = new Map(inventory.map(({ acc, drafts }) => [acc.name, new Set(drafts.map((d) => id(d.id)))]));
  let staleFarmLinks = false;
  const converted = new Set(convertedNames); let convertedHistory = 0;
  for (const rec of records) {
    const f = rec.fields, draftId = id(f['Draft ID']);
    if (f.Archived || duplicateIds.has(draftId)) continue;
    const acc = names.get(f.Account);
    // A no-ID record must be genuinely empty, not an untracked manually authored record.
    const empty = !draftId && Object.entries(f).every(([k, v]) => blank(v) || v === 0 || (k === 'Archived' && v === false) || (k === 'Status' && v === 'Draft'));
    // A page converted out of the PI fleet (accounts.mjs formerNames) leaves its history behind under the
    // old name. Those rows can never resolve to a live account again and the page no longer posts for
    // PI, so none of them is a ghost waiting to publish: they are counted and must not hold farm judgment back for every other page.
    if (!empty && !acc && converted.has(f.Account) && /^\d+$/.test(draftId)) { convertedHistory++; continue; }
    if (!empty && (!acc || !/^\d+$/.test(draftId))) { diagnostics.push({ kind: 'unresolved-account-or-id', recordId: rec.id }); staleFarmLinks ||= ['Harvest', 'Seed', 'Pot'].some((k) => !blank(f[k])); continue; }
    if (!empty && live.get(acc.name).has(draftId)) continue;
    staleFarmLinks ||= ['Harvest', 'Seed', 'Pot'].some((k) => !blank(f[k]));
    if (!safeGhost(f)) { diagnostics.push({ kind: 'missing-historical-record', recordId: rec.id, draftId }); continue; }
    const identity = stable({ draftId, account: acc?.name || '', socialSetId: id(acc?.socialSetId) });
    const old = previousState.missing?.[rec.id];
    const firstSeen = old?.identity === identity && Number.isFinite(old.firstSeen) && old.firstSeen <= now ? old.firstSeen : now;
    nextState.missing[rec.id] = { identity, firstSeen, lastSeen: now };
    if (now - firstSeen < graceMs) { diagnostics.push({ kind: 'missing-awaiting-second-observation', recordId: rec.id }); continue; }
    const fields = { Archived: true };
    for (const key of ['Harvest', 'Seed', 'Pot']) if (!blank(f[key])) fields[key] = [];
    patches.push({ table: PC, id: rec.id, fields, before: clone(f), reason: empty ? 'empty-record' : 'confirmed-missing-unpublished', ...(empty ? {} : { confirmDraft: { socialSetId: acc.socialSetId, draftId } }) });
  }
  const byHarvest = new Map();
  for (const s of seeds) for (const h of s.fields['Source Harvest'] || []) byHarvest.set(h, [...(byHarvest.get(h) || []), s]);
  for (const h of harvests) {
    const linked = byHarvest.get(h.id) || [];
    if (!linked.length || h.fields.Status === 'Seeded') continue;
    if (linked.length !== 1 || (linked[0].fields['Source Harvest'] || []).length !== 1) { diagnostics.push({ kind: 'ambiguous-seed-harvest', recordId: h.id }); continue; }
    const seed = linked[0];
    if (!['Approved', 'Dormant'].includes(seed.fields.Status) || !['In Pool', 'Potential', 'Seed-Eligible'].includes(h.fields.Status)) continue;
    patches.push({ table: 'Harvests', id: h.id, fields: { Status: 'Seeded' }, before: clone(h.fields), reason: 'existing-approved-seed', confirmSeed: { id: seed.id, before: clone(seed.fields) } });
  }
  if (convertedHistory) diagnostics.push({ kind: 'converted-page-history', count: convertedHistory });
  return { patches, nextState, diagnostics, blockFarm: duplicateIds.size > 0 || staleFarmLinks, complete: true };
}

export async function executeRegistryReconciliation({ plan, at, tf, dry = true, saveState }) {
  const result = { receipts: [], diagnostics: [...plan.diagnostics], blockFarm: plan.blockFarm, planned: plan.patches.length, applied: 0 };
  if (dry || !plan.complete) return result;
  const nextState = clone(plan.nextState);
  for (const patch of plan.patches) {
    let writeAttempted = false;
    try {
    // Re-read before touching a record: do not race an operator edit or a newly arrived metric.
    const fresh = await at.getRecord(patch.table, patch.id);
    if (!equal(fresh.fields, patch.before)) { result.diagnostics.push({ kind: 'concurrent-edit-deferred', recordId: patch.id }); result.blockFarm = true; continue; }
    if (patch.confirmSeed) {
      const seed = await at.getRecord('Seeds', patch.confirmSeed.id);
      if (!equal(seed.fields, patch.confirmSeed.before)) { result.diagnostics.push({ kind: 'seed-changed-deferred', recordId: patch.id }); result.blockFarm = true; continue; }
    }
    if (patch.confirmDraft) {
      try {
        await tf.getDraft(patch.confirmDraft.socialSetId, patch.confirmDraft.draftId);
        delete nextState.missing[patch.id];
        result.diagnostics.push({ kind: 'draft-reappeared', recordId: patch.id }); result.blockFarm = true; continue;
      } catch (e) {
        if (e.provider !== 'Typefully' || e.status !== 404) {
          result.diagnostics.push({ kind: 'draft-confirmation-failed', recordId: patch.id, status: e.status ?? null }); result.blockFarm = true; continue;
        }
      }
    }
    writeAttempted = true;
    await at.update(patch.table, [{ id: patch.id, fields: patch.fields }]);
    const verified = await at.getRecord(patch.table, patch.id);
    // Airtable omits empty linked-record fields from reads; normalize only that representation.
    const landed = Object.entries(patch.fields).every(([k, v]) => Array.isArray(v) && !v.length ? blank(verified.fields[k]) : JSON.stringify(verified.fields[k]) === JSON.stringify(v));
    result.receipts.push({ table: patch.table, id: patch.id, before: patch.before, after: clone(verified.fields), reason: patch.reason, verified: landed });
    if (!landed) { result.diagnostics.push({ kind: 'write-verification-failed', recordId: patch.id }); result.blockFarm = true; break; }
    result.applied++;
    delete nextState.missing[patch.id];
    nextState.lastReceipts = [...(nextState.lastReceipts || []), result.receipts.at(-1)].slice(-100);
    // Persist verified evidence immediately, before attempting the next mutation. A later
    // failure/crash must not erase the earlier repair's audit trail or replay its missing state.
    if (saveState) {
      try { await saveState(clone(nextState)); }
      catch { result.diagnostics.push({ kind: 'missing-state-save-failed', recordId: patch.id }); result.blockFarm = true; break; }
    }
    } catch (e) {
      // Preserve verified earlier receipts and retry unresolved records on the next run.
      result.diagnostics.push({ kind: writeAttempted ? 'write-outcome-unconfirmed' : 'record-read-failed', recordId: patch.id, status: e.status ?? null, ...(writeAttempted ? { before: patch.before, attemptedFields: patch.fields } : {}) });
      result.blockFarm = true;
      break;
    }
  }
  if (saveState) {
    try { await saveState(nextState); }
    catch { result.diagnostics.push({ kind: 'missing-state-save-failed' }); result.blockFarm = true; }
  }
  return result;
}
