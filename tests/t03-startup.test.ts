import assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { test } from 'node:test';
import { loadBootstrapAssets } from '../src/db/assets';
import { DATABASE } from '../src/db/database.module';
import { createApi } from '../src/api';
import { installHttpTransport } from '../src/http/install-http-transport';
import { createTestDatabase } from './helpers/postgres';

const valid = {
  POLL_INTERVAL_MS: '1000',
  LISTING_TTL_DAYS: '30',
};

async function verifyStartupFailure(
  configureFailure: (app: INestApplication, failure: Error) => void,
  initialize?: (app: INestApplication, failure: Error) => Promise<void>,
): Promise<void> {
  const fixture = await createTestDatabase();
  const observer = new Pool({ connectionString: fixture.url });
  let captured: INestApplication | undefined;
  const failure = new Error('startup-fault-sentinel');
  let verificationError: unknown;
  try {
    await assert.rejects(
      createApi(
        { ...valid, DATABASE_URL: fixture.url },
        await loadBootstrapAssets(),
        (app) => { captured = app; configureFailure(app, failure); },
        initialize ? app => initialize(app, failure) : undefined,
      ),
      error => error === failure,
    );
    assert.ok(captured);
    await assert.rejects(captured!.get(DATABASE).ping(), /Database is closed/);
    const deadline = Date.now() + 5000;
    let sessions = '1';
    let remaining: string[] = [];
    while (Date.now() < deadline) {
      const result = await observer.query<{ pid: number; state: string | null; application_name: string; query: string }>(
        `SELECT pid, state, application_name, query FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = 'listing-moderation'`,
      );
      remaining = result.rows.map(row => `${row.pid}:${row.state}:${row.application_name}:${row.query}`);
      sessions = String(result.rows.length);
      if (sessions === '0') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(sessions, '0', `startup failure must release the production PostgreSQL pool; remaining: ${remaining.join(' | ')}`);
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    await observer.end();
    try { await fixture.dispose(); }
    catch (cleanupError) { if (verificationError === undefined) throw cleanupError; }
  }
}

test('API factory closes the real app and database when transport installation fails', async () => {
  await verifyStartupFailure((app, failure) => {
    throw failure;
  });
});

test('API factory closes the real app and database when native app.init fails', async () => {
  await verifyStartupFailure(
    app => installHttpTransport(app),
    async (app, failure) => { await app.init(); throw failure; },
  );
});
