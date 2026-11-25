#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresJournal } from '../state/postgres.mjs';
import { parseLedgerRows, stableEventId } from '../state/ledger-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'status';
const apply = process.argv.includes('--apply');

function historicalEvent(row, digest, occurrence) {
  const sourceKey = `ledger:historical:${digest}`;
  return { eventId: stableEventId(sourceKey, String(occurrence)), operationKey: null, schemaVersion: 1,
    eventType: 'ledger.historical', aggregateKey: String(row.draftId || row.recId || `historical-${digest.slice(0, 16)}`),
    payload: row, occurredAt: row.ts && Number.isFinite(Date.parse(row.ts)) ? new Date(row.ts) : new Date(0) };
}

export async function backfillLedger(journal, text, { apply: shouldApply = false } = {}) {
  const rows = parseLedgerRows(text, { tolerateMalformed: false });
  const occurrences = new Map();
  const events = rows.map((row) => {
    const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    const occurrence = occurrences.get(digest) || 0;
    occurrences.set(digest, occurrence + 1);
    return historicalEvent(row, digest, occurrence);
  });
  if (!shouldApply) return { mode: 'dry-run', rows: rows.length, wouldInsert: events.length };
  let inserted = 0;
  for (const event of events) if ((await journal.appendEvent(event)).appended) inserted++;
  return { mode: 'applied', rows: rows.length, inserted, duplicates: rows.length - inserted };
}

async function main() {
  if (!['migrate', 'backfill-ledger', 'recovery-queue'].includes(command)) throw new Error('usage: state-pilot.mjs <migrate|backfill-ledger|recovery-queue> [--apply]');
  if (!apply) {
    if (command === 'backfill-ledger') {
      const result = await backfillLedger(null, readFileSync(join(ROOT, 'ledger.jsonl'), 'utf8'), { apply: false });
      console.log(JSON.stringify(result)); return;
    }
    console.log(JSON.stringify({ mode: 'dry-run', command, note: 'pass --apply only in an approved pilot environment' })); return;
  }
  const { pool, journal } = createPostgresJournal({ connectionString: process.env.STATE_DATABASE_URL });
  try {
    if (command === 'migrate') await pool.query(readFileSync(join(ROOT, 'state/migrations/001_operation_journal.sql'), 'utf8'));
    else if (command === 'backfill-ledger') console.log(JSON.stringify(await backfillLedger(journal, readFileSync(join(ROOT, 'ledger.jsonl'), 'utf8'), { apply: true })));
    else console.log(JSON.stringify({ mode: 'read-only', operations: await journal.recoveryQueue() }));
  } finally { await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('state pilot failed; no database diagnostics were emitted'); process.exitCode = 1; });
}
