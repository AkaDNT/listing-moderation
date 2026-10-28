import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

const SESSION_RELEASE_TIMEOUT_MS = 1000;
const SESSION_RELEASE_POLL_MS = 25;

interface ActiveSession {
  pid: number;
  application_name: string;
  state: string | null;
  query: string;
  wait_event_type: string | null;
  wait_event: string | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export interface TestDatabase {
  url: string;
  databaseName: string;
  dispose(): Promise<void>;
}

function quoteDatabaseIdentifier(value: string): string {
  if (!/^t02_[a-z0-9_]+$/.test(value)) throw new Error('Refusing unsafe PostgreSQL test database name');
  return `"${value}"`;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL must point to the isolated PostgreSQL test service');
  const parsed = new URL(adminUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL with host and database');
  }
  const databaseName = `t02_${process.pid}_${randomBytes(8).toString('hex')}`;
  const quotedName = quoteDatabaseIdentifier(databaseName);
  const admin = new Pool({ connectionString: adminUrl, max: 1, application_name: 't02-test-db-admin' });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${quotedName}`);
    created = true;
  } catch (error) {
    await admin.end();
    throw new Error(`Unable to create isolated PostgreSQL test database ${databaseName}`, { cause: error });
  }

  const fixtureUrl = new URL(adminUrl);
  fixtureUrl.pathname = `/${databaseName}`;
  let disposed = false;
  return {
    url: fixtureUrl.toString(),
    databaseName,
    async dispose() {
      if (disposed) return;
      if (!created) throw new Error(`Refusing to dispose unowned PostgreSQL test database ${databaseName}`);
      let activeSessions = false;
      try {
        const deadline = Date.now() + SESSION_RELEASE_TIMEOUT_MS;
        let sessions: ActiveSession[] = [];
        while (true) {
          sessions = (await admin.query<ActiveSession>(
            `SELECT pid, application_name, state, query, wait_event_type, wait_event
             FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()
             ORDER BY pid`,
            [databaseName],
          )).rows;
          if (sessions.length === 0) break;
          if (Date.now() >= deadline) {
            activeSessions = true;
            throw new Error(
              `Refusing to drop ${databaseName}: ${sessions.length} PostgreSQL session(s) remain after ` +
              `${SESSION_RELEASE_TIMEOUT_MS}ms: ${JSON.stringify(sessions)}`,
            );
          }
          await delay(SESSION_RELEASE_POLL_MS);
        }
        await admin.query(`DROP DATABASE ${quotedName}`);
        disposed = true;
        created = false;
        await admin.end();
      } catch (error) {
        if (!activeSessions) await admin.end();
        throw error;
      }
    },
  };
}
