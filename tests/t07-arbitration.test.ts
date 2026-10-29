import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool, PoolClient } from 'pg';
import { isLosslessNumber } from 'lossless-json';
import { createApi } from '../src/api';
import { Database } from '../src/db/database';
import { loadBootstrapAssets } from '../src/db/assets';
import { createTestDatabase } from './helpers/postgres';
import { parseJson } from '../src/http/json-codec';

interface ListingFields { sellerId: string; categoryId: string; title: string; description: string; priceVnd: bigint }
interface SubmissionResult { kind: string; id: string; status: string }
interface SubmissionRepository { submit(fields: ListingFields): Promise<SubmissionResult> }
interface AutomatedResult {
  kind: 'missing' | 'not_pending' | 'applied';
  listingId?: string;
  proposal?: { status: string; decision: { outcome: string; reasons: Array<{ rule_id: string; message: string; detail?: Record<string, unknown> }> } };
  decidedAt?: string;
  fingerprint?: string;
}
interface AutomatedRepository { applyAutomatedListing(client: PoolClient, listingId: string): Promise<AutomatedResult> }
interface Module<T> { [name: string]: unknown }

function loadModule<T>(path: string, name: string): T {
  let loaded: Module<T> = {};
  try { loaded = require(path) as Module<T>; } catch { /* availability is asserted explicitly */ }
  const value = loaded[name];
  assert.equal(typeof value, 'function', `production ${name} must be available`);
  return value as T;
}

async function withDb<T>(work: (database: Database, fixture: Awaited<ReturnType<typeof createTestDatabase>>) => Promise<T>): Promise<T> {
  const fixture = await createTestDatabase();
  let database: Database | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  try {
    database = await Database.open(fixture.url, await loadBootstrapAssets());
    result = await work(database, fixture);
  } catch (error) { primaryError = error; }
  const cleanupErrors: unknown[] = [];
  if (database) try { await database.close(); } catch (error) { cleanupErrors.push(error); }
  try { await fixture.dispose(); } catch (error) { cleanupErrors.push(error); }
  if (primaryError !== undefined || cleanupErrors.length) {
    const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
    throw new AggregateError(errors, `T07 PostgreSQL test/cleanup failure:\n${errors.map(error => error instanceof Error ? error.stack : String(error)).join('\n')}`, { cause: primaryError });
  }
  return result as T;
}

function productionRepositories() {
  const Submission = loadModule<new (database: Database) => SubmissionRepository>('../src/submission/submission.repository', 'SubmissionRepository');
  const Automated = loadModule<new () => AutomatedRepository>('../src/moderation/automated-listing.repository', 'AutomatedListingRepository');
  const Reference = loadModule<new (database: Database | PoolClient) => { load(sellerId: string, categoryId: string): Promise<unknown> }>('../src/moderation/reference-data.repository', 'ReferenceDataRepository');
  const Identity = loadModule<(value: ListingFields) => { canonical: string; fingerprint: string; lockKey: string }>(
    '../src/moderation/duplicate-fingerprint', 'createDuplicateIdentity');
  return { Submission, Automated, Reference, Identity };
}

const listing = (overrides: Partial<ListingFields> = {}): ListingFields => ({
  sellerId: 's-1007', categoryId: 'c-phones', title: 'ordinary T07 device', description: 'clean description',
  priceVnd: 6000000n, ...overrides,
});

async function submit(repo: SubmissionRepository, fields: ListingFields): Promise<string> {
  const result = await repo.submit(fields);
  assert.equal(result.kind, 'created');
  assert.equal(result.status, 'pending');
  return result.id;
}

async function apply(database: Database, repository: AutomatedRepository, id: string, settings = ''): Promise<AutomatedResult> {
  return database.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    if (settings) await client.query(settings);
    return repository.applyAutomatedListing(client, id);
  });
}

async function row(database: Database, id: string) {
  const result = await database.query<{
    id: string; seller_id: string; category_id: string; title: string; description: string; price_vnd: string;
    status: string; decision: any; decided_at: Date | null; normalized_fingerprint: string | null; version: string;
  }>(`SELECT id,seller_id,category_id,title,description,price_vnd::text,status,decision,decided_at,
             normalized_fingerprint,version::text FROM listings WHERE id=$1`, [id]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function exactDecision(database: Database, id: string): Promise<Record<string, any> | null> {
  const result = await database.query<{ decision_json: string | null }>(
    'SELECT decision::text AS decision_json FROM listings WHERE id=$1', [id]);
  assert.equal(result.rowCount, 1);
  return result.rows[0].decision_json === null ? null : parseJson(result.rows[0].decision_json) as Record<string, any>;
}

const committedDecision = { outcome: 'approved', reasons: [] };
async function insertReference(database: Database, fields: ListingFields, id: string, status: string, fingerprint: string | null) {
  const decision = status === 'pending' ? null : committedDecision;
  const decidedAt = status === 'pending' ? null : '2026-01-01T00:00:00Z';
  await database.query(
    `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,normalized_fingerprint,published_at)
     VALUES($1,$2,$3,$4,$5,$6::bigint,$7,$8::jsonb,$9::timestamptz,$10,CASE WHEN $7='published' THEN statement_timestamp() END)`,
    [id, fields.sellerId, fields.categoryId, fields.title, fields.description, fields.priceVnd.toString(), status,
      decision === null ? null : JSON.stringify(decision), decidedAt, fingerprint],
  );
}

async function pollFor<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value !== undefined) return value; }
    catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}; last read error=${String(last)}`);
}

const DUPLICATE_TEST_LOCK = 73423;
const DUPLICATE_TEST_LOCK_ID = 1;

test('production R3 apply uses persisted references and exact SQL rows, then actual GET serializes the committed decision', async () => {
  const { Submission, Automated, Reference } = productionRepositories();
  await withDb(async (database, fixture) => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const firstId = await submit(submissions, listing({ title: '  Café phone ', description: 'same\u00a0description' }));
    const first = await apply(database, automated, firstId);
    assert.equal(first.kind, 'applied');
    assert.equal(first.proposal?.status, 'auto_approved');
    assert.equal(first.decidedAt && Number.isFinite(Date.parse(first.decidedAt)), true);
    assert.match(first.fingerprint ?? '', /^r3:v1:[0-9a-f]{64}$/);
    const firstRow = await row(database, firstId);
    assert.equal(firstRow.status, 'auto_approved');
    assert.equal(firstRow.version, '1');
    assert.equal(firstRow.normalized_fingerprint, first.fingerprint);
    assert.equal(firstRow.decision.outcome, 'approved');
    assert.equal(firstRow.decided_at instanceof Date, true);

    const secondId = await submit(submissions, listing({ title: 'cafe\u0301\tPHONE', description: 'same description' }));
    const second = await apply(database, automated, secondId);
    assert.equal(second.kind, 'applied');
    assert.equal(second.proposal?.status, 'auto_rejected');
    assert.deepEqual(second.proposal?.decision.reasons.map(reason => reason.rule_id), ['R3']);
    assert.equal(second.proposal?.decision.reasons[0].detail?.listing_id, firstId);
    assert.equal((await row(database, secondId)).status, 'auto_rejected');

    const fixtureClientPool = new Pool({ connectionString: fixture.url });
    const client = await fixtureClientPool.connect();
    try {
      const references = new Reference(client);
      const persisted = await references.load('s-1007', 'c-phones');
      assert.deepEqual(persisted, {
        seller: { id: 's-1007', trustScore: 79, verified: true },
        category: { id: 'c-phones', medianPriceVnd: 6000000n },
        bannedKeywords: ['counterfeit', 'fake', 'hang gia', 'hang nhai', 'replica', 'stolen'],
      });
    } finally { client.release(); await fixtureClientPool.end(); }

    const app = await createApi({ DATABASE_URL: fixture.url, PORT: '8080', POLL_INTERVAL_MS: '1000', LISTING_TTL_DAYS: '30' }, await loadBootstrapAssets());
    try {
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/listings/${secondId}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const json = await response.text();
      assert.match(json, /"status":"auto_rejected"/);
      assert.ok(json.includes(`R3: duplicate of active listing ${firstId}`));
      assert.match(json, /"rule_id":"R3"/);
      const unsafeId = await submit(submissions, listing({ sellerId: 's-1001', title: 'unsafe int64 GET', priceVnd: 9007199254740993n }));
      const maxId = await submit(submissions, listing({ sellerId: 's-1001', title: 'maximum int64 GET', priceVnd: 9223372036854775807n }));
      assert.equal((await apply(database, automated, unsafeId)).proposal?.status, 'auto_approved');
      assert.equal((await apply(database, automated, maxId)).proposal?.status, 'auto_approved');
      assert.equal((await row(database, unsafeId)).price_vnd, '9007199254740993');
      assert.equal((await row(database, maxId)).price_vnd, '9223372036854775807');
      for (const [id, price] of [[unsafeId, '9007199254740993'], [maxId, '9223372036854775807']]) {
        const exactResponse = await fetch(`http://127.0.0.1:${address.port}/v1/listings/${id}`, { signal: AbortSignal.timeout(5000) });
        assert.equal(exactResponse.status, 200);
        const body = await exactResponse.text();
        assert.match(body, new RegExp(`"price_vnd":${price}(?:,|})`));
        assert.match(body, /"decided_at":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/);
      }
      const jobs = await database.query<{ state: string; history_count: string }>(
        `SELECT j.state,(SELECT count(*)::text FROM moderation_history h WHERE h.listing_id=j.listing_id) AS history_count
         FROM moderation_jobs j WHERE j.listing_id=$1`, [secondId]);
      assert.deepEqual(jobs.rows[0], { state: 'queued', history_count: '0' });
    } finally { await app.close(); }
  });
});

test('R3 PostgreSQL identity compares seller, category, price, title and description independently', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const base = listing();
    const originalId = await submit(submissions, base);
    const original = await apply(database, automated, originalId);
    assert.equal(original.proposal?.status, 'auto_approved');

    const distinctCases: Array<{ field: string; fields: ListingFields }> = [
      { field: 'seller', fields: { ...base, sellerId: 's-1002' } },
      { field: 'category', fields: { ...base, categoryId: 'c-laptops' } },
      { field: 'price', fields: { ...base, priceVnd: 6000001n } },
      { field: 'title', fields: { ...base, title: 'ordinary T07 alternate device' } },
      { field: 'description', fields: { ...base, description: 'another clean description' } },
    ];
    for (const scenario of distinctCases) {
      const id = await submit(submissions, scenario.fields);
      const result = await apply(database, automated, id);
      assert.equal(result.proposal?.status, 'auto_approved', `${scenario.field} difference must remain distinct`);
      assert.equal(result.proposal?.decision.reasons.some(reason => reason.rule_id === 'R3'), false,
        `${scenario.field} difference must not produce R3`);
      const persisted = await row(database, id);
      assert.equal(persisted.status, 'auto_approved');
      assert.equal(persisted.decision.outcome, 'approved');
    }

    const equivalentTitleId = await submit(submissions, {
      ...base, title: 'Ordinary  T07\tDevice',
    });
    const equivalentTitle = await apply(database, automated, equivalentTitleId);
    assert.equal(equivalentTitle.proposal?.decision.reasons.find(reason => reason.rule_id === 'R3')?.detail?.listing_id, originalId,
      'title normalization must match while description stays byte-for-byte equal');

    const equivalentDescriptionId = await submit(submissions, {
      ...base, description: 'clean\n description',
    });
    const equivalentDescription = await apply(database, automated, equivalentDescriptionId);
    assert.equal(equivalentDescription.proposal?.decision.reasons.find(reason => reason.rule_id === 'R3')?.detail?.listing_id, originalId,
      'description normalization must match while title stays byte-for-byte equal');
  });
});

test('active statuses match even with null or stale fingerprints; other listing states do not', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const cases: Array<{ status: string; active: boolean; fingerprint: string | null }> = [
      { status: 'auto_approved', active: true, fingerprint: null },
      { status: 'published', active: true, fingerprint: 'wrong-old-fingerprint' },
      { status: 'pending', active: false, fingerprint: null },
      { status: 'needs_human', active: false, fingerprint: 'r3:v0:old' },
      { status: 'auto_rejected', active: false, fingerprint: null },
      { status: 'rejected', active: false, fingerprint: null },
      { status: 'expired', active: false, fingerprint: null },
    ];
    for (const [index, scenario] of cases.entries()) {
      const fields = listing({ title: `status matrix ${index}` });
      await insertReference(database, fields, `status-ref-${index}`, scenario.status, scenario.fingerprint);
      const candidateId = await submit(submissions, fields);
      const result = await apply(database, automated, candidateId);
      assert.equal(result.kind, 'applied');
      assert.equal(result.proposal?.status === 'auto_rejected', scenario.active, scenario.status);
      if (scenario.active) assert.equal(result.proposal?.decision.reasons.find(reason => reason.rule_id === 'R3')?.detail?.listing_id, `status-ref-${index}`);
      else assert.equal(result.proposal?.status, 'auto_approved', scenario.status);
    }
  });
});

test('matching cached fingerprint alone never rejects different persisted identity fields', async () => {
  const { Submission, Automated, Identity } = productionRepositories();
  await withDb(async database => {
    const candidateFields = listing({ title: 'fingerprint false positive candidate' });
    const candidateFingerprint = Identity(candidateFields).fingerprint;
    const differentActiveFields = {
      ...candidateFields,
      title: 'different persisted title',
      description: 'different persisted description',
    };
    await insertReference(database, differentActiveFields, 'same-fingerprint-different-listing', 'auto_approved', candidateFingerprint);

    const candidateId = await submit(new Submission(database), candidateFields);
    const result = await apply(database, new Automated(), candidateId);
    assert.equal(result.proposal?.status, 'auto_approved');
    assert.equal(result.proposal?.decision.reasons.some(reason => reason.rule_id === 'R3'), false);
    assert.equal((await row(database, candidateId)).status, 'auto_approved');
  });
});

test('null or stale cached fingerprints do not hide an exact normalized active duplicate', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const scenarios = [
      { id: 'null-fingerprint-active-duplicate', status: 'auto_approved', fingerprint: null },
      { id: 'stale-fingerprint-active-duplicate', status: 'published', fingerprint: 'r3:v0:stale' },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const activeFields = listing({ title: `fingerprint fallback ${index}`, description: `same description ${index}` });
      await insertReference(database, activeFields, scenario.id, scenario.status, scenario.fingerprint);
      const candidateFields = {
        ...activeFields,
        title: activeFields.title.toUpperCase().replace(' ', '\t  '),
      };
      const candidateId = await submit(submissions, candidateFields);
      const result = await apply(database, automated, candidateId);
      assert.equal(result.proposal?.status, 'auto_rejected', scenario.id);
      assert.equal(result.proposal?.decision.reasons.find(reason => reason.rule_id === 'R3')?.detail?.listing_id,
        scenario.id, scenario.id);
      assert.equal((await row(database, candidateId)).status, 'auto_rejected');
    }
  });
});

test('duplicate lookup query error propagates, rolls back, and a later real transaction succeeds', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const candidateId = await submit(new Submission(database), listing({ title: 'duplicate lookup fault recovery' }));
    const automated = new Automated();
    const injectedError = new Error('T07 injected duplicate lookup failure');
    let injectedQueryCount = 0;

    await assert.rejects(database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const realQuery = client.query.bind(client);
      const faultingClient = Object.create(client) as PoolClient;
      faultingClient.query = ((...args: unknown[]) => {
        const statement = args[0];
        const sql = typeof statement === 'string'
          ? statement
          : statement && typeof statement === 'object' && 'text' in statement
            ? statement.text
            : undefined;
        if (typeof sql === 'string' && /FROM listings\s+WHERE seller_id=\$1 AND category_id=\$2/.test(sql)) {
          injectedQueryCount++;
          throw injectedError;
        }
        return Reflect.apply(realQuery, client, args);
      }) as PoolClient['query'];
      return automated.applyAutomatedListing(faultingClient, candidateId);
    }), error => error === injectedError);
    assert.equal(injectedQueryCount, 1, 'fault must hit only the production duplicate-page SELECT');

    let persisted = await row(database, candidateId);
    assert.equal(persisted.status, 'pending');
    assert.equal(persisted.decision, null);
    assert.equal(persisted.decided_at, null);
    assert.equal(persisted.normalized_fingerprint, null);
    assert.equal(persisted.version, '0');

    const retry = await apply(database, automated, candidateId);
    assert.equal(retry.proposal?.status, 'auto_approved');
    persisted = await row(database, candidateId);
    assert.equal(persisted.status, 'auto_approved');
    assert.equal(persisted.decision.outcome, 'approved');
    assert.ok(persisted.decided_at instanceof Date);
    assert.match(persisted.normalized_fingerprint ?? '', /^r3:v1:[0-9a-f]{64}$/);
    assert.equal(persisted.version, '1');
  });
});

test('R3 lookup keyset-pages through more than 100 nonmatching active rows and chooses stable first exact ID', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const fields = listing({ title: 'exact page 2 match' });
    for (let index = 0; index < 100; index++) {
      await insertReference(database, { ...fields, title: `distractor ${index}` }, `a-page-${String(index).padStart(3, '0')}`, 'auto_approved', null);
    }
    await insertReference(database, fields, 'z-page-match', 'published', 'false-positive');
    await insertReference(database, fields, 'zz-page-match', 'auto_approved', null);
    const candidateId = await submit(new Submission(database), fields);
    const result = await apply(database, new Automated(), candidateId);
    assert.equal(result.proposal?.status, 'auto_rejected');
    assert.equal(result.proposal?.decision.reasons[0].detail?.listing_id, 'z-page-match');
  });
});

test('two transactions racing one pending listing apply it once and leave stale state untouched', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const candidateId = await submit(new Submission(database), listing());
    const repository = new Automated();
    const results = await Promise.all([
      apply(database, repository, candidateId), apply(database, repository, candidateId),
    ]);
    assert.deepEqual(results.map(value => value.kind).sort(), ['applied', 'not_pending']);
    const persisted = await row(database, candidateId);
    assert.equal(persisted.status, 'auto_approved');
    assert.equal(persisted.version, '1');
    assert.ok(persisted.decided_at instanceof Date);
  });
});

test('two independent non-trusted transactions serialize at the R3 key and re-read after the owner commits (10 fresh pairs)', async () => {
  const { Submission, Automated, Identity } = productionRepositories();
  await withDb(async (database, fixture) => {
    await database.query(`CREATE FUNCTION t07_pause_approved_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status='pending' AND NEW.status='auto_approved' THEN
          PERFORM pg_advisory_xact_lock(${DUPLICATE_TEST_LOCK},${DUPLICATE_TEST_LOCK_ID});
        END IF;
        RETURN NEW;
      END $$`);
    await database.query(`CREATE TRIGGER t07_pause_approved BEFORE UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION t07_pause_approved_update()`);
    const submissions = new Submission(database);
    const automated = new Automated();
    const controlPool = new Pool({ connectionString: fixture.url, max: 1, application_name: 't07-lock-control' });
    const control = await controlPool.connect();
    let ownerLockHeld = false;
    const operations: Promise<AutomatedResult>[] = [];
    let releaseBarrier: () => void = () => {};
    try {
      const controlPid = Number((await control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await control.query('SELECT pg_advisory_lock($1,$2)', [DUPLICATE_TEST_LOCK, DUPLICATE_TEST_LOCK_ID]);
      ownerLockHeld = true;
      const pairs: Array<[string, string]> = [];
      const fieldsById = new Map<string, ListingFields>();
      for (let iteration = 0; iteration < 10; iteration++) {
        const fields = listing({ title: `synchronized pair ${iteration}` });
        const firstId = await submit(submissions, fields);
        const secondId = await submit(submissions, fields);
        fieldsById.set(firstId, fields);
        fieldsById.set(secondId, fields);
        pairs.push([firstId, secondId]);
      }
      const backendIds = new Map<number, string>();
      const expectedById = new Map<string, { status: string; outcome: string; conflictId?: string }>();
      for (const pair of pairs) {
        const before = new Set(backendIds.keys());
        let barrierWaiters = 0;
        let resolvePair!: () => void;
        const pairBarrier = new Promise<void>(resolve => { resolvePair = resolve; });
        releaseBarrier = resolvePair;
        const runCandidate = (id: string) => database.transaction(async client => {
          await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await client.query("SET LOCAL statement_timeout='20000ms'; SET LOCAL lock_timeout='15000ms'");
          const pid = Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          backendIds.set(pid, id);
          barrierWaiters++;
          if (barrierWaiters === 2) resolvePair();
          await pairBarrier;
          return automated.applyAutomatedListing(client, id);
        });
        const first = runCandidate(pair[0]);
        const second = runCandidate(pair[1]);
        operations.push(first, second);
        await pollFor('both transaction clients to reach the barrier', async () => barrierWaiters >= 2 ? true : undefined);
        // The first two transactions are released above. Wait for their observable wait chain before releasing the control lock.
        if (pair === pairs[0]) {
          const ids = [...backendIds.keys()].filter(pid => !before.has(pid));
          assert.equal(ids.length, 2);
          await pollFor('PostgreSQL wait chain from one candidate through the other', async () => {
            const waits = await database.query<{ pid: number; blockers: number[]; wait_event_type: string | null; wait_event: string | null }>(
              `SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,wait_event
               FROM pg_stat_activity WHERE pid=ANY($1::int[])`, [ids]);
            const owner = waits.rows.find(value => value.blockers.includes(controlPid));
            const follower = owner && waits.rows.find(value => value.pid !== owner.pid && value.blockers.includes(owner.pid));
            return owner && follower ? { owner, follower } : undefined;
          });
          await control.query('SELECT pg_advisory_unlock($1,$2)', [DUPLICATE_TEST_LOCK, DUPLICATE_TEST_LOCK_ID]);
          ownerLockHeld = false;
        }
        const outcomes = await Promise.all([first, second]);
        assert.deepEqual(outcomes.map(value => value.proposal?.status).sort(), ['auto_approved', 'auto_rejected']);
        const rejected = outcomes.find(value => value.proposal?.status === 'auto_rejected')!;
        const approved = outcomes.find(value => value.proposal?.status === 'auto_approved')!;
        assert.deepEqual(rejected.proposal?.decision.reasons.map(value => value.rule_id), ['R3']);
        assert.equal(rejected.proposal?.decision.reasons[0].detail?.listing_id, approved.listingId);
        expectedById.set(approved.listingId!, { status: 'auto_approved', outcome: 'approved' });
        expectedById.set(rejected.listingId!, { status: 'auto_rejected', outcome: 'rejected', conflictId: approved.listingId });
      }
      const listings = await database.query<{
        id: string; status: string; decision_json: string; decided_at: Date; version: string; fingerprint: string | null;
      }>(`SELECT id,status,decision::text AS decision_json,decided_at,version::text,
                 normalized_fingerprint AS fingerprint FROM listings WHERE id=ANY($1::text[])`, [[...expectedById.keys()]]);
      assert.equal(listings.rows.length, 20);
      for (const persisted of listings.rows) {
        const expected = expectedById.get(persisted.id);
        assert.ok(expected, `race result ${persisted.id} has an expected persisted state`);
        assert.equal(persisted.status, expected.status, persisted.id);
        const decision = parseJson(persisted.decision_json) as Record<string, any>;
        assert.equal(decision.outcome, expected.outcome, persisted.id);
        if (expected.conflictId) {
          assert.deepEqual(decision.reasons.map((reason: { rule_id: string }) => reason.rule_id), ['R3'], persisted.id);
          assert.equal(decision.reasons[0].detail.listing_id, expected.conflictId, persisted.id);
        } else {
          assert.deepEqual(decision.reasons, [], persisted.id);
        }
        assert.ok(persisted.decided_at instanceof Date && Number.isFinite(persisted.decided_at.getTime()), persisted.id);
        assert.equal(persisted.version, '1');
        assert.equal(persisted.fingerprint, Identity(fieldsById.get(persisted.id)!).fingerprint, persisted.id);
      }
    } finally {
      releaseBarrier();
      if (ownerLockHeld) try { await control.query('SELECT pg_advisory_unlock($1,$2)', [DUPLICATE_TEST_LOCK, DUPLICATE_TEST_LOCK_ID]); } catch { /* preserve the primary test error */ }
      const settled = await Promise.allSettled(operations);
      await control.release();
      await controlPool.end();
      const rejected = settled.find(value => value.status === 'rejected') as PromiseRejectedResult | undefined;
      if (rejected) throw rejected.reason;
    }
  });
});

test('R1 and trusted R4 finish while their R3 advisory keys are held externally', async () => {
  const { Submission, Automated, Identity } = productionRepositories();
  await withDb(async (database, fixture) => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const controlPool = new Pool({ connectionString: fixture.url, max: 1 });
    const control = await controlPool.connect();
    try {
      const trusted = listing({ sellerId: 's-1005', title: 'trusted bypass probe' });
      const banned = listing({ sellerId: 's-1001', title: 'Replica product' });
      const trustedKey = Identity(trusted).lockKey;
      const bannedKey = Identity(banned).lockKey;
      await control.query('SELECT pg_advisory_lock($1::bigint)', [trustedKey]);
      await control.query('SELECT pg_advisory_lock($1::bigint)', [bannedKey]);
      const trustedId = await submit(submissions, trusted);
      const bannedId = await submit(submissions, banned);
      const trustedResult = await apply(database, automated, trustedId, "SET LOCAL statement_timeout='1000ms'");
      const bannedResult = await apply(database, automated, bannedId, "SET LOCAL statement_timeout='1000ms'");
      assert.equal(trustedResult.proposal?.status, 'auto_approved');
      assert.equal(trustedResult.proposal?.decision.reasons[0].rule_id, 'R4');
      assert.equal(bannedResult.proposal?.status, 'auto_rejected');
      assert.equal(bannedResult.proposal?.decision.reasons[0].rule_id, 'R1');
    } finally {
      await control.query('SELECT pg_advisory_unlock_all()');
      await control.release();
      await controlPool.end();
    }
  });
});

test('identical listings from an unverified trusted seller both commit auto_approved with R4 only', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const fields = listing({ sellerId: 's-1005', title: 'identical trusted duplicate', description: 'same trusted description' });
    const firstId = await submit(submissions, fields);
    const secondId = await submit(submissions, fields);

    const firstResult = await apply(database, automated, firstId);
    assert.equal(firstResult.proposal?.status, 'auto_approved');
    const firstRow = await row(database, firstId);
    assert.equal(firstRow.status, 'auto_approved');
    assert.equal(firstRow.decision.outcome, 'approved');
    assert.deepEqual(firstRow.decision.reasons.map((reason: { rule_id: string }) => reason.rule_id), ['R4']);

    const secondResult = await apply(database, automated, secondId);
    assert.equal(secondResult.proposal?.status, 'auto_approved');
    const secondRow = await row(database, secondId);
    assert.equal(secondRow.status, 'auto_approved');
    assert.equal(secondRow.decision.outcome, 'approved');
    assert.deepEqual(secondRow.decision.reasons.map((reason: { rule_id: string }) => reason.rule_id), ['R4']);
    assert.deepEqual(
      [secondRow.seller_id, secondRow.category_id, secondRow.price_vnd, secondRow.title, secondRow.description],
      [firstRow.seller_id, firstRow.category_id, firstRow.price_vnd, firstRow.title, firstRow.description],
    );
    assert.equal(secondRow.decision.reasons.some((reason: { rule_id: string }) => ['R3', 'R5'].includes(reason.rule_id)), false);
    assert.equal(firstRow.decision.reasons.some((reason: { rule_id: string }) => ['R3', 'R5'].includes(reason.rule_id)), false);
  });
});

test('outer rollback after an applied proposal restores the pending row and a failed lock wait does not fail open', async () => {
  const { Submission, Automated, Identity } = productionRepositories();
  await withDb(async (database, fixture) => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const fields = listing({ title: 'rollback after apply' });
    const id = await submit(submissions, fields);
    const intentional = new Error('T07 outer rollback after apply');
    await assert.rejects(database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const result = await automated.applyAutomatedListing(client, id);
      assert.equal(result.kind, 'applied');
      throw intentional;
    }), error => error === intentional);
    let persisted = await row(database, id);
    assert.equal(persisted.status, 'pending');
    assert.equal(persisted.decision, null);
    assert.equal(persisted.decided_at, null);
    assert.equal(persisted.normalized_fingerprint, null);
    assert.equal(persisted.version, '0');

    const timeoutFields = listing({ title: 'advisory lock timeout' });
    const timeoutId = await submit(submissions, timeoutFields);
    const pool = new Pool({ connectionString: fixture.url, max: 1 });
    const holder = await pool.connect();
    try {
      const lockKey = Identity(timeoutFields).lockKey;
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
      await assert.rejects(apply(database, automated, timeoutId,
        "SET LOCAL statement_timeout='100ms'"), (error: any) => error?.code === '57014');
      persisted = await row(database, timeoutId);
      assert.equal(persisted.status, 'pending');
      assert.equal(persisted.decision, null);
      assert.equal(persisted.version, '0');
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
    } finally { await holder.release(); await pool.end(); }
    assert.equal((await apply(database, automated, timeoutId)).proposal?.status, 'auto_approved');
    assert.equal((await row(database, id)).status, 'pending');
  });
});

test('database update failure propagates and rolls the listing decision back', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    await database.query(`CREATE FUNCTION t07_reject_listing_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title='T07 forced update error' THEN
          RAISE EXCEPTION 'forced T07 listing update failure' USING ERRCODE='P0001';
        END IF;
        RETURN NEW;
      END $$`);
    await database.query(`CREATE TRIGGER t07_reject_listing_update BEFORE UPDATE ON listings
      FOR EACH ROW EXECUTE FUNCTION t07_reject_listing_update()`);
    const id = await submit(new Submission(database), listing({ title: 'T07 forced update error' }));
    await assert.rejects(apply(database, new Automated(), id), (error: any) => error?.code === 'P0001' &&
      /forced T07 listing update failure/.test(error.message));
    const persisted = await row(database, id);
    assert.equal(persisted.status, 'pending');
    assert.equal(persisted.decision, null);
    assert.equal(persisted.decided_at, null);
    assert.equal(persisted.normalized_fingerprint, null);
    assert.equal(persisted.version, '0');
  });
});

test('production apply refuses a client that is not inside an explicit transaction', async () => {
  const { Automated } = productionRepositories();
  await withDb(async (database, fixture) => {
    const candidateId = await submit(new (loadModule<new (database: Database) => SubmissionRepository>(
      '../src/submission/submission.repository', 'SubmissionRepository'))(database), listing());
    const repository = new Automated();
    await assert.rejects(database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return repository.applyAutomatedListing(client, candidateId);
    }), /active READ COMMITTED transaction/i);
    const pool = new Pool({ connectionString: fixture.url, max: 1 });
    const client = await pool.connect();
    try {
      await assert.rejects(repository.applyAutomatedListing(client, candidateId), /active READ COMMITTED transaction/i);
    } finally { client.release(); await pool.end(); }
  });
});

test('R3 combines exact bigint R2, duplicate R3 and unverified R5 in policy order; clear control keeps R2 and R5', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const fields = listing({
      sellerId: 's-1004', title: 'unsafe aggregate identity', description: 'aggregate clean text',
      priceVnd: 9007199254740993n,
    });
    await insertReference(database, fields, 'aggregate-active-reference', 'auto_approved', null);
    const duplicateId = await submit(submissions, fields);
    const duplicateResult = await apply(database, automated, duplicateId);
    assert.equal(duplicateResult.proposal?.status, 'auto_rejected');
    assert.deepEqual(duplicateResult.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2', 'R3', 'R5']);
    assert.equal(duplicateResult.proposal?.decision.reasons[0].detail?.price_vnd, 9007199254740993n);
    assert.equal(duplicateResult.proposal?.decision.reasons[0].detail?.median_price_vnd, 6000000n);
    assert.equal(duplicateResult.proposal?.decision.reasons[0].detail?.comparison, 'above_three_times');
    assert.equal(duplicateResult.proposal?.decision.reasons[1].detail?.listing_id, 'aggregate-active-reference');
    assert.equal(duplicateResult.proposal?.decision.reasons[2].detail?.verified, false);
    const duplicateRow = await row(database, duplicateId);
    const duplicateDecision = await exactDecision(database, duplicateId);
    assert.equal(duplicateRow.price_vnd, '9007199254740993');
    assert.equal(duplicateRow.status, 'auto_rejected');
    assert.equal(duplicateDecision?.outcome, 'rejected');
    assert.deepEqual(duplicateDecision?.reasons.map((reason: { rule_id: string }) => reason.rule_id), ['R2', 'R3', 'R5']);
    assert.equal(duplicateDecision?.reasons[0].detail.price_vnd.toString(), '9007199254740993');

    const controlId = await submit(submissions, { ...fields, title: 'different aggregate identity' });
    const controlResult = await apply(database, automated, controlId);
    assert.equal(controlResult.proposal?.status, 'needs_human');
    assert.deepEqual(controlResult.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2', 'R5']);
    const controlRow = await row(database, controlId);
    const controlDecision = await exactDecision(database, controlId);
    assert.equal(controlRow.status, 'needs_human');
    assert.equal(controlDecision?.outcome, 'escalated');
    assert.deepEqual(controlDecision?.reasons.map((reason: { rule_id: string }) => reason.rule_id), ['R2', 'R5']);
    assert.equal(controlDecision?.reasons.some((reason: { rule_id: string }) => reason.rule_id === 'R3'), false);
    assert.equal(controlDecision?.reasons[0].detail.price_vnd.toString(), '9007199254740993');
  });
});

test('actual apply returns missing and leaves every nonpending candidate state unchanged', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const repository = new Automated();
    const missingId = 't07-missing-candidate';
    const missingBeforeTotals = await database.query<{ listings: string; jobs: string; history: string }>(
      `SELECT (SELECT count(*)::text FROM listings) AS listings,
              (SELECT count(*)::text FROM moderation_jobs) AS jobs,
              (SELECT count(*)::text FROM moderation_history) AS history`);
    const missingBefore = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM listings WHERE id=$1', [missingId]);
    assert.equal(missingBefore.rows[0].count, '0');
    assert.deepEqual(await apply(database, repository, missingId), { kind: 'missing' });
    const missingAfter = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM listings WHERE id=$1`, [missingId]);
    assert.equal(missingAfter.rows[0].count, '0');
    const missingAfterTotals = await database.query<{ listings: string; jobs: string; history: string }>(
      `SELECT (SELECT count(*)::text FROM listings) AS listings,
              (SELECT count(*)::text FROM moderation_jobs) AS jobs,
              (SELECT count(*)::text FROM moderation_history) AS history`);
    assert.deepEqual(missingAfterTotals.rows[0], missingBeforeTotals.rows[0]);

    const states: Array<{ status: string; outcome: string; published: boolean; expired: boolean }> = [
      { status: 'auto_approved', outcome: 'approved', published: false, expired: false },
      { status: 'auto_rejected', outcome: 'rejected', published: false, expired: false },
      { status: 'needs_human', outcome: 'escalated', published: false, expired: false },
      { status: 'published', outcome: 'approved', published: true, expired: false },
      { status: 'rejected', outcome: 'rejected', published: false, expired: false },
      { status: 'expired', outcome: 'approved', published: true, expired: true },
    ];
    const ids: string[] = [];
    for (const [index, state] of states.entries()) {
      const id = `t07-state-${state.status}`;
      ids.push(id);
      const decision = JSON.stringify({
        outcome: state.outcome,
        reasons: [{ rule_id: `sentinel-${index}`, message: `keep ${state.status}`, detail: { state: state.status } }],
      });
      await database.query(
        `INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at,
          published_at,expires_at,normalized_fingerprint,version)
         VALUES($1,'s-1007','c-phones',$2,'state guard fixture',6000000,$3,$4::jsonb,'2026-01-02T03:04:05Z',
          CASE WHEN $5 THEN '2026-01-01T00:00:00Z'::timestamptz END,
          CASE WHEN $6 THEN '2026-01-01T00:00:00Z'::timestamptz END,'sentinel-fingerprint',7)`,
        [id, `state guard ${state.status}`, state.status, decision, state.published, state.expired],
      );
    }

    const beforeTotals = await database.query<{ listings: string; jobs: string; history: string }>(
      `SELECT (SELECT count(*)::text FROM listings) AS listings,
              (SELECT count(*)::text FROM moderation_jobs) AS jobs,
              (SELECT count(*)::text FROM moderation_history) AS history`);

    const snapshots = new Map<string, Record<string, unknown>>();
    for (const id of ids) {
      const result = await database.query<Record<string, unknown>>(
        `SELECT id,status,decision::text AS decision_json,decided_at::text,published_at::text,expires_at::text,
                normalized_fingerprint,version::text FROM listings WHERE id=$1`, [id]);
      snapshots.set(id, result.rows[0]);
    }
    for (const id of ids) assert.deepEqual(await apply(database, repository, id), { kind: 'not_pending' });
    for (const id of ids) {
      const after = await database.query<Record<string, unknown>>(
        `SELECT id,status,decision::text AS decision_json,decided_at::text,published_at::text,expires_at::text,
                normalized_fingerprint,version::text FROM listings WHERE id=$1`, [id]);
      assert.deepEqual(after.rows[0], snapshots.get(id), `${id} must remain byte-for-byte unchanged`);
    }
    const afterTotals = await database.query<{ listings: string; jobs: string; history: string }>(
      `SELECT (SELECT count(*)::text FROM listings) AS listings,
              (SELECT count(*)::text FROM moderation_jobs) AS jobs,
              (SELECT count(*)::text FROM moderation_history) AS history`);
    assert.deepEqual(afterTotals.rows[0], beforeTotals.rows[0]);
  });
});

test('non-trusted R3 SQL comparison preserves unsafe bigint equality and adjacent values through int64 maximum', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async database => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const unsafeFields = listing({ title: 'unsafe bigint R3 identity', description: 'unsafe bigint description', priceVnd: 9007199254740993n });
    await insertReference(database, unsafeFields, 'unsafe-bigint-active', 'auto_approved', null);
    const unsafeEqualId = await submit(submissions, unsafeFields);
    const unsafeEqual = await apply(database, automated, unsafeEqualId);
    assert.equal(unsafeEqual.proposal?.status, 'auto_rejected');
    assert.deepEqual(unsafeEqual.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2', 'R3']);
    assert.equal(unsafeEqual.proposal?.decision.reasons[1].detail?.listing_id, 'unsafe-bigint-active');
    assert.equal((await row(database, unsafeEqualId)).price_vnd, '9007199254740993');
    assert.equal((await exactDecision(database, unsafeEqualId))?.reasons[0].detail.price_vnd.toString(), '9007199254740993');

    const unsafeAdjacentId = await submit(submissions, { ...unsafeFields, priceVnd: 9007199254740992n });
    const unsafeAdjacent = await apply(database, automated, unsafeAdjacentId);
    assert.equal(unsafeAdjacent.proposal?.status, 'needs_human');
    assert.deepEqual(unsafeAdjacent.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2']);
    assert.equal((await row(database, unsafeAdjacentId)).price_vnd, '9007199254740992');
    assert.equal((await exactDecision(database, unsafeAdjacentId))?.reasons[0].detail.price_vnd.toString(), '9007199254740992');

    const unsafeUpperAdjacentId = await submit(submissions, { ...unsafeFields, priceVnd: 9007199254740994n });
    const unsafeUpperAdjacent = await apply(database, automated, unsafeUpperAdjacentId);
    assert.equal(unsafeUpperAdjacent.proposal?.status, 'needs_human');
    assert.deepEqual(unsafeUpperAdjacent.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2']);
    assert.equal((await row(database, unsafeUpperAdjacentId)).price_vnd, '9007199254740994');
    assert.equal((await exactDecision(database, unsafeUpperAdjacentId))?.reasons[0].detail.price_vnd.toString(), '9007199254740994');

    const maxFields = listing({ title: 'maximum bigint R3 identity', description: 'maximum bigint description', priceVnd: 9223372036854775807n });
    await insertReference(database, maxFields, 'maximum-bigint-active', 'published', null);
    const maxEqualId = await submit(submissions, maxFields);
    const maxEqual = await apply(database, automated, maxEqualId);
    assert.equal(maxEqual.proposal?.status, 'auto_rejected');
    assert.deepEqual(maxEqual.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2', 'R3']);
    assert.equal(maxEqual.proposal?.decision.reasons[1].detail?.listing_id, 'maximum-bigint-active');
    assert.equal((await row(database, maxEqualId)).price_vnd, '9223372036854775807');
    assert.equal((await exactDecision(database, maxEqualId))?.reasons[0].detail.price_vnd.toString(), '9223372036854775807');

    const maxAdjacentId = await submit(submissions, { ...maxFields, priceVnd: 9223372036854775806n });
    const maxAdjacent = await apply(database, automated, maxAdjacentId);
    assert.equal(maxAdjacent.proposal?.status, 'needs_human');
    assert.deepEqual(maxAdjacent.proposal?.decision.reasons.map(reason => reason.rule_id), ['R2']);
    assert.equal((await row(database, maxAdjacentId)).price_vnd, '9223372036854775806');
    assert.equal((await exactDecision(database, maxAdjacentId))?.reasons[0].detail.price_vnd.toString(), '9223372036854775806');
  });
});

test('actual GET one/list expose committed R2 int64 JSON tokens and filtered production DTOs', async () => {
  const { Submission, Automated } = productionRepositories();
  await withDb(async (database, fixture) => {
    const submissions = new Submission(database);
    const automated = new Automated();
    const fields = listing({ sellerId: 's-1004', title: 'HTTP unsafe R2 duplicate', description: 'HTTP exact detail', priceVnd: 9007199254740993n });
    await insertReference(database, fields, 'http-unsafe-active-reference', 'auto_approved', null);
    const rejectedId = await submit(submissions, fields);
    const reviewId = await submit(submissions, { ...fields, title: 'HTTP unsafe R2 no duplicate' });
    assert.equal((await apply(database, automated, rejectedId)).proposal?.status, 'auto_rejected');
    assert.equal((await apply(database, automated, reviewId)).proposal?.status, 'needs_human');

    const app = await createApi({ DATABASE_URL: fixture.url, PORT: '8080', POLL_INTERVAL_MS: '1000', LISTING_TTL_DAYS: '30' }, await loadBootstrapAssets());
    try {
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      assert.ok(address && typeof address !== 'string');
      const oneResponse = await fetch(`http://127.0.0.1:${address.port}/v1/listings/${rejectedId}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(oneResponse.status, 200);
      const oneText = await oneResponse.text();
      assert.match(oneText, new RegExp(`"price_vnd":9007199254740993(?:,|})`));
      assert.match(oneText, /"median_price_vnd":6000000(?:,|})/);
      const one = parseJson(oneText) as Record<string, any>;
      assert.equal(one.id, rejectedId);
      assert.equal(one.status, 'auto_rejected');
      assert.equal(one.decision.outcome, 'rejected');
      assert.ok(isLosslessNumber(one.price_vnd), 'GET one listing price must be a JSON number');
      assert.equal(one.decision.reasons[0].rule_id, 'R2');
      assert.ok(isLosslessNumber(one.decision.reasons[0].detail.price_vnd), 'GET one R2 price must be a JSON number');
      assert.ok(isLosslessNumber(one.decision.reasons[0].detail.median_price_vnd), 'GET one R2 median must be a JSON number');
      assert.equal(one.price_vnd.toString(), '9007199254740993');
      assert.equal(one.decision.reasons[0].detail.price_vnd.toString(), '9007199254740993');
      assert.equal(one.decision.reasons[0].detail.median_price_vnd.toString(), '6000000');
      assert.equal(one.decided_at, (await row(database, rejectedId)).decided_at?.toISOString());
      assert.equal(one.decision.reasons.map((reason: { rule_id: string }) => reason.rule_id).join(','), 'R2,R3,R5');
      assert.equal(one.decision.reasons[1].detail.listing_id, 'http-unsafe-active-reference');

      const listResponse = await fetch(`http://127.0.0.1:${address.port}/v1/listings?seller_id=s-1004&status=auto_rejected&limit=100`, { signal: AbortSignal.timeout(5000) });
      assert.equal(listResponse.status, 200);
      const listText = await listResponse.text();
      assert.match(listText, new RegExp(`"price_vnd":9007199254740993(?:,|})`));
      const listed = parseJson(listText) as { items: Array<Record<string, any>> };
      assert.deepEqual(listed.items.map(item => item.id), [rejectedId]);
      assert.equal(listed.items[0].status, 'auto_rejected');
      assert.equal(listed.items[0].decision.outcome, 'rejected');
      assert.deepEqual(listed.items[0].decision, one.decision);
      assert.ok(isLosslessNumber(listed.items[0].price_vnd), 'GET list listing price must be a JSON number');
      assert.equal(listed.items[0].decision.reasons[0].rule_id, 'R2');
      assert.ok(isLosslessNumber(listed.items[0].decision.reasons[0].detail.price_vnd), 'GET list R2 price must be a JSON number');
      assert.ok(isLosslessNumber(listed.items[0].decision.reasons[0].detail.median_price_vnd), 'GET list R2 median must be a JSON number');
      assert.equal(listed.items[0].price_vnd.toString(), '9007199254740993');
      assert.equal(listed.items[0].decision.reasons[0].detail.price_vnd.toString(), '9007199254740993');
      assert.equal(listed.items[0].decision.reasons[0].detail.median_price_vnd.toString(), '6000000');
      assert.equal(listed.items[0].decided_at, one.decided_at);
      assert.equal('normalized_fingerprint' in listed.items[0], false);
      assert.equal('version' in listed.items[0], false);
      assert.equal('job' in listed.items[0], false);

      const reviewResponse = await fetch(`http://127.0.0.1:${address.port}/v1/listings?seller_id=s-1004&status=needs_human&limit=100`, { signal: AbortSignal.timeout(5000) });
      assert.equal(reviewResponse.status, 200);
      const reviewList = parseJson(await reviewResponse.text()) as { items: Array<Record<string, any>> };
      assert.deepEqual(reviewList.items.map(item => item.id), [reviewId]);
      assert.equal(reviewList.items[0].status, 'needs_human');
      assert.equal(reviewList.items[0].decision.outcome, 'escalated');
      assert.equal(reviewList.items[0].decision.reasons.map((reason: { rule_id: string }) => reason.rule_id).join(','), 'R2,R5');
      assert.ok(isLosslessNumber(reviewList.items[0].price_vnd));
      assert.ok(isLosslessNumber(reviewList.items[0].decision.reasons[0].detail.price_vnd));
      assert.ok(isLosslessNumber(reviewList.items[0].decision.reasons[0].detail.median_price_vnd));
      assert.equal(reviewList.items[0].price_vnd.toString(), '9007199254740993');
      assert.equal(reviewList.items[0].decision.reasons[0].detail.price_vnd.toString(), '9007199254740993');
      assert.equal(reviewList.items[0].decision.reasons[0].detail.median_price_vnd.toString(), '6000000');
      assert.equal(reviewList.items[0].decided_at, (await row(database, reviewId)).decided_at?.toISOString());
    } finally { await app.close(); }
  });
});
