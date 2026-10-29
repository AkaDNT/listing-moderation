import { Database } from '../db/database';
import { PoolClient } from 'pg';

export class ExpiryRepository {
  constructor(private readonly database: Database) {}

  async expireBatch(): Promise<string[]> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      return this.expireDueInTransaction(client);
    });
  }

  async expireDueInTransaction(client: PoolClient): Promise<string[]> {
    const result = await client.query<{ id: string }>(
      `WITH due AS MATERIALIZED (
         SELECT id FROM listings
         WHERE status='published' AND expires_at <= now()
         ORDER BY expires_at,id
         FOR UPDATE SKIP LOCKED
         LIMIT 100
       )
       UPDATE listings AS l
       SET status='expired',version=l.version+1
       FROM due
       WHERE l.id=due.id AND l.status='published' AND l.expires_at <= now()
       RETURNING l.id`,
    );
    return result.rows.map(row => row.id);
  }
}
