import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, eventEnvelope } from './operation-model.mjs';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepBuffer, 0, 0, ms);

export function parseLedgerRows(text, { tolerateMalformed = true } = {}) {
  const rows = [];
  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) { if (!tolerateMalformed) throw new Error(`malformed ledger row ${index + 1}`); }
  }
  return rows;
}

export function readLedgerRows(file) {
  if (!existsSync(file)) return [];
  return parseLedgerRows(readFileSync(file, 'utf8'));
}

export function stableEventId(operationKey, discriminator = 'receipt') {
  const hex = createHash('sha256').update(`${operationKey}\0${discriminator}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function stateOperationKey(kind, parts) {
  const encoded = parts.map((part) => encodeURIComponent(String(part ?? '').trim()));
  if (!kind || encoded.some((part) => !part)) throw new Error('operation key kind and parts are required');
  return `${kind}:${encoded.join(':')}`;
}

function acquireLock(lock, { timeoutMs, staleMs }) {
  const started = Date.now();
  while (true) {
    try { mkdirSync(lock); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`local ledger lock timeout: ${basename(lock)}`);
      sleep(10);
    }
  }
}

export function appendLedgerEventSync(file, payload, options = {}) {
  const operationKey = options.operationKey;
  const eventId = options.eventId || (operationKey ? stableEventId(operationKey, options.discriminator) : randomUUID());
  const event = eventEnvelope(payload, { ...options, eventId, operationKey });
  const lock = `${file}.lock`;
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(dirname(file), { recursive: true });
  acquireLock(lock, { timeoutMs: options.lockTimeoutMs || 5_000, staleMs: options.staleLockMs || 120_000 });
  try {
    const rows = readLedgerRows(file);
    const existing = rows.find((row) => row.eventId === eventId);
    if (existing) {
      const existingPayload = Object.fromEntries(Object.entries(existing).filter(([key]) =>
        !['eventId', 'schemaVersion', 'operationKey', 'runId', 'source', 'occurredAt', 'ts'].includes(key)));
      const proposedPayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'ts'));
      if (canonicalJson(existingPayload) !== canonicalJson(proposedPayload)) {
        throw new Error('ledger event id already exists with different payload');
      }
      return { appended: false, event: existing };
    }
    const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\n?$/, '\n') : '';
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
    writeFileSync(temporary, `${current}${JSON.stringify(event)}\n`, { mode });
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, file);
    return { appended: true, event };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

export const LOCAL_LEDGER_LIMITATION = 'The lock coordinates one shared filesystem only; it does not serialize GitHub Actions runners.';
