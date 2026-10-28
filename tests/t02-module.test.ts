import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';

test('DatabaseModule registration exposes a real bootstrapped database and app.close closes its pool', async () => {
  const modulePath = '../src/db/database.module';
  const databaseModule = await import(modulePath).catch(() => ({} as {
    DATABASE?: symbol;
    DatabaseModule?: { register(database: Database): import('@nestjs/common').DynamicModule };
  })) as {
    DATABASE?: symbol;
    DatabaseModule?: { register(database: Database): import('@nestjs/common').DynamicModule };
  };
  assert.equal(typeof databaseModule.DatabaseModule?.register, 'function', 'DatabaseModule.register must be available');

  const fixture = await createTestDatabase();
  const database = await Database.open(fixture.url, await loadBootstrapAssets());
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    app = await NestFactory.createApplicationContext(databaseModule.DatabaseModule!.register(database), { logger: false });
    const registered = app.get<Database>(databaseModule.DATABASE!);
    const seeded = await registered.query<{ name: string; trust_score: number }>(
      "SELECT name,trust_score FROM sellers WHERE id='s-1001'",
    );
    assert.deepEqual(seeded.rows[0], { name: 'Nguyen Van A', trust_score: 92 });
  } finally {
    if (app) await app.close();
    await assert.rejects(database.ping(), /closed/);
    await fixture.dispose();
  }
});
