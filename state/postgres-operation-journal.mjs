import { IntentConflictError, StaleFenceError } from './operation-model.mjs';

function normalized(row) {
  if (!row) return null;
  return {
    operationKey: row.operation_key,
    intentId: row.intent_id,
    generationId: row.generation_id,
    operationType: row.operation_type,
    provider: row.provider,
    payloadHash: row.payload_hash,
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    fence: Number(row.fencing_token),
    runId: row.run_id,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error_code,
  };
}

export class PostgresOperationJournal {
  constructor(database, { now = () => new Date() } = {}) { this.database = database; this.now = now; }

  async #transaction(fn) {
    if (typeof this.database.transaction === 'function') return this.database.transaction(fn);
    const client = await this.database.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async get(key, client = this.database) {
    const result = await client.query('SELECT * FROM state_operations WHERE operation_key = $1', [key]);
    return normalized(result.rows[0]);
  }

  async effects(key, client = this.database) {
    const result = await client.query(`SELECT provider, resource_type, provider_id, receipt, observed_state
      FROM state_effects WHERE operation_key = $1 ORDER BY resource_type, provider_id`, [key]);
    return result.rows.map((row) => ({ operationKey: key, provider: row.provider, resourceType: row.resource_type,
      providerId: row.provider_id, receipt: row.receipt, observedState: row.observed_state }));
  }

  async appendEvent(event, client = this.database) {
    const result = await client.query(`WITH inserted AS (
      INSERT INTO state_events
        (event_id, operation_key, schema_version, event_type, aggregate_key, payload, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT (event_id) DO NOTHING RETURNING event_id
      )
      SELECT true AS inserted FROM inserted
      UNION ALL
      SELECT false AS inserted FROM state_events WHERE event_id=$1 AND NOT EXISTS (SELECT 1 FROM inserted)
        AND operation_key IS NOT DISTINCT FROM $2 AND schema_version=$3 AND event_type=$4
        AND aggregate_key=$5 AND payload=$6::jsonb AND occurred_at=$7`, [event.eventId, event.operationKey || null,
      event.schemaVersion, event.eventType, event.aggregateKey, JSON.stringify(event.payload), event.occurredAt]);
    if (!result.rows[0]) throw new Error('state event id already exists with different content');
    return { appended: result.rows[0].inserted === true, eventId: event.eventId };
  }

  async recoveryQueue(client = this.database) {
    const result = await client.query(`SELECT * FROM state_operations
      WHERE state IN ('submitted','unknown') ORDER BY updated_at, operation_key`);
    return result.rows.map(normalized);
  }

  async reserve(intent) {
    return this.#transaction(async (tx) => {
      const inserted = await tx.query(`INSERT INTO state_operations
        (operation_key, intent_id, generation_id, operation_type, provider, payload_hash, state, run_id)
        VALUES ($1,$2,$3,$4,$5,$6,'planned',$7)
        ON CONFLICT (operation_key) DO NOTHING RETURNING *`, [intent.operationKey, intent.intentId,
        intent.generationId, intent.operationType, intent.provider, intent.payloadHash, intent.runId || null]);
      const row = inserted.rows[0] || (await tx.query('SELECT * FROM state_operations WHERE operation_key = $1 FOR UPDATE', [intent.operationKey])).rows[0];
      if (row.payload_hash !== intent.payloadHash) throw new IntentConflictError(intent.operationKey);
      return { created: Boolean(inserted.rows[0]), operation: normalized(row) };
    });
  }

  async claim(key, { owner, leaseMs }) {
    const expires = new Date(this.now().getTime() + leaseMs);
    const result = await this.database.query(`UPDATE state_operations SET state='claimed', lease_owner=$2,
      lease_expires_at=$3, fencing_token=fencing_token+1, attempt_count=attempt_count+1, updated_at=clock_timestamp()
      WHERE operation_key=$1 AND (state='planned' OR (state='claimed' AND lease_expires_at <= $4)) RETURNING *`,
    [key, owner, expires, this.now()]);
    return normalized(result.rows[0]);
  }

  async markSubmitted(key, fence) { return this.#transition(key, fence, ['claimed'], 'submitted', null, false); }
  async markUnknown(key, fence, reason = 'ambiguous-provider-result') { return this.#transition(key, fence, ['submitted'], 'unknown', reason, true); }
  async markFailed(key, fence, reason = 'provider-rejected') { return this.#transition(key, fence, ['claimed', 'submitted'], 'failed', reason, true); }

  async claimReconciliation(key, { owner, leaseMs }) {
    const expires = new Date(this.now().getTime() + leaseMs);
    const result = await this.database.query(`UPDATE state_operations SET state='unknown', lease_owner=$2,
      lease_expires_at=$3, fencing_token=fencing_token+1, updated_at=clock_timestamp()
      WHERE operation_key=$1 AND state IN ('submitted','unknown')
        AND (lease_expires_at IS NULL OR lease_expires_at <= $4) RETURNING *`, [key, owner, expires, this.now()]);
    return normalized(result.rows[0]);
  }

  async confirm(key, fence, effect) {
    return this.#transaction(async (tx) => {
      const updated = await tx.query(`UPDATE state_operations SET state='confirmed', lease_owner=NULL,
        lease_expires_at=NULL, last_error_code=NULL, updated_at=clock_timestamp()
        WHERE operation_key=$1 AND fencing_token=$2 AND state IN ('submitted','unknown') RETURNING *`, [key, fence]);
      if (!updated.rows[0]) throw new StaleFenceError(key);
      await tx.query(`INSERT INTO state_effects
        (operation_key, provider, resource_type, provider_id, receipt, observed_state)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (operation_key, resource_type, provider_id) DO UPDATE SET
          receipt=EXCLUDED.receipt, observed_state=EXCLUDED.observed_state`, [key, effect.provider,
        effect.resourceType, effect.providerId, JSON.stringify(effect.receipt || {}), effect.observedState || 'confirmed']);
      return normalized(updated.rows[0]);
    });
  }

  async #transition(key, fence, from, state, reason, clearLease) {
    const result = await this.database.query(`UPDATE state_operations SET state=$3,
      lease_owner=CASE WHEN $6 THEN NULL ELSE lease_owner END,
      lease_expires_at=CASE WHEN $6 THEN NULL ELSE lease_expires_at END,
      last_error_code=$4, updated_at=clock_timestamp()
      WHERE operation_key=$1 AND fencing_token=$2 AND state = ANY($5::text[]) RETURNING *`,
    [key, fence, state, reason, from, clearLease]);
    if (!result.rows[0]) throw new StaleFenceError(key);
    return normalized(result.rows[0]);
  }
}
