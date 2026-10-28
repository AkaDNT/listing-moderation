import { PoolClient } from 'pg';
import { checksumMigration, Migration } from './assets';

export async function applyMigrations(client: PoolClient, migrations: Migration[]): Promise<void> {
  const ids = migrations.map(({ id }) => id);
  if (ids.some((id) => !/^\d{3}_[a-z0-9_]+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Migration manifest contains invalid or duplicate IDs');
  }
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) {
    throw new Error('Migration manifest is not in ascending version order');
  }
  for (const migration of migrations) {
    if (!migration.sql.trim() || checksumMigration(migration.sql) !== migration.checksum) {
      throw new Error(`Migration ${migration.id} is empty or has an invalid checksum`);
    }
  }

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const ledger = await client.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations ORDER BY id',
  );
  if (ledger.rows.length > migrations.length) throw new Error('Database contains migrations absent from the manifest');
  for (const [index, applied] of ledger.rows.entries()) {
    const expected = migrations[index];
    if (!expected || applied.id !== expected.id) throw new Error(`Database migration history has a gap or unknown migration at ${applied.id}`);
    if (applied.checksum !== expected.checksum) throw new Error(`Migration checksum mismatch for ${applied.id}`);
  }

  for (const migration of migrations.slice(ledger.rows.length)) {
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations(id, checksum) VALUES($1, $2)', [migration.id, migration.checksum]);
  }
}
