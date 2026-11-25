import { createHash, randomUUID } from 'node:crypto';

export const OPERATION_STATES = Object.freeze(['planned', 'claimed', 'submitted', 'confirmed', 'unknown', 'failed']);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function payloadHash(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function operationKey({ type, account, slotId, generationId }) {
  for (const [name, value] of Object.entries({ type, account, slotId, generationId })) {
    if (!String(value || '').trim()) throw new Error(`operation ${name} is required`);
    if (String(value).includes(':')) throw new Error(`operation ${name} cannot contain ':'`);
  }
  return `${type}:${account}:${slotId}:${generationId}`;
}

export function eventEnvelope(payload, { eventId = randomUUID(), operationKey: key, runId = null, source, occurredAt = new Date().toISOString() } = {}) {
  if (!key || !source) throw new Error('event operationKey and source are required');
  return { ...payload, eventId, schemaVersion: 1, operationKey: key, runId, source, occurredAt };
}

export class IntentConflictError extends Error {
  constructor(key) { super(`operation intent payload conflict: ${key}`); this.code = 'INTENT_CONFLICT'; }
}

export class StaleFenceError extends Error {
  constructor(key) { super(`operation fencing token is stale: ${key}`); this.code = 'STALE_FENCE'; }
}
