import { Pool, QueryResult, QueryResultRow, PoolClient } from 'pg';
import { BootstrapAssets, validateSeedData } from './assets';
import { applyMigrations } from './migrate';
import { upsertSeeds } from './seed';
import { withTransaction } from './transaction';

const BOOTSTRAP_LOCK_NAMESPACE = 74201;
const BOOTSTRAP_LOCK_ID = 2;

function validatedMigrations(assets: BootstrapAssets): BootstrapAssets['migrations'] {
  if (!Array.isArray(assets?.migrations) || assets.migrations.length === 0) {
    throw new Error('Bootstrap assets must contain at least one migration');
  }
  return assets.migrations;
}

export class Database {
  private closePromise?: Promise<void>;

  private constructor(private readonly pool: Pool) {}

  static async open(databaseUrl: string, assets: BootstrapAssets): Promise<Database> {
    const seeds = validateSeedData(assets?.seeds);
    const migrations = validatedMigrations(assets);
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'listing-moderation',
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', () => {
      console.error('PostgreSQL idle connection failed; pg removed the connection from its pool.');
    });
    try {
      await withTransaction(pool, async (client: PoolClient) => {
        await client.query("SELECT set_config('lock_timeout', '5s', true)");
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOTSTRAP_LOCK_NAMESPACE, BOOTSTRAP_LOCK_ID]);
        await applyMigrations(client, migrations);
        await upsertSeeds(client, seeds);
      });
      return new Database(pool);
    } catch (startupError) {
      try {
        await pool.end();
      } catch (closeError) {
        throw new AggregateError([startupError, closeError], 'Database bootstrap and pool cleanup failed', {
          cause: startupError,
        });
      }
      throw startupError;
    }
  }

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    this.assertOpen();
    return this.pool.query<Row>(sql, values as unknown[] | undefined);
  }

  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertOpen();
    return withTransaction(this.pool, work);
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }

  async readinessProbe(): Promise<void> {
    this.assertOpen();
    const client = await this.pool.connect();
    let destroy = false;
    try {
      // pg 8.23.1 reads per-query query_timeout; @types/pg omits it from QueryConfig.
      const probe = { text: 'SELECT 1', query_timeout: 1000 };
      await client.query(probe);
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.release(destroy || undefined);
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.pool.end();
    return this.closePromise;
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }

  private assertOpen(): void {
    if (this.closePromise) throw new Error('Database is closed');
  }
}
