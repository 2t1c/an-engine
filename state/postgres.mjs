import { Pool } from 'pg';
import { PostgresOperationJournal } from './postgres-operation-journal.mjs';

export function createPostgresJournal({ connectionString, applicationName = 'project-infinity-state-pilot' }) {
  if (!connectionString) throw new Error('STATE_DATABASE_URL is required for the PostgreSQL pilot');
  const pool = new Pool({ connectionString, application_name: applicationName, max: 4,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
  return { pool, journal: new PostgresOperationJournal(pool) };
}
