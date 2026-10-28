import { Pool, PoolClient } from 'pg';

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | boolean | undefined;
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await work(client);
    const committed = await client.query('COMMIT');
    transactionStarted = false;
    if (committed.command !== 'COMMIT') {
      throw new Error(`Transaction was not committed (PostgreSQL command: ${committed.command})`);
    }
    return result;
  } catch (workError) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
        transactionStarted = false;
      } catch (rollbackError) {
        releaseError = true;
        throw new AggregateError([workError, rollbackError], 'Transaction failed and rollback also failed', {
          cause: workError,
        });
      }
    } else if (workError instanceof Error) {
      releaseError = workError;
    }
    throw workError;
  } finally {
    client.release(releaseError);
  }
}
