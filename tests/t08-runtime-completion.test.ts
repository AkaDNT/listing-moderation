import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLosslessNumber } from 'lossless-json';
import { createApi } from '../src/api';
import { parseJson } from '../src/http/json-codec';
import { createDuplicateIdentity } from '../src/moderation/duplicate-fingerprint';
import { scope, blocked, pending, stop, until } from './helpers/t08';

test('T08 actual worker recovers after both apply and retry persistence are rejected by PostgreSQL', { timeout: 25000 }, async () => {
  await scope(async s => {
    const id = await s.add('T08 retry writer DB failure');
    await s.database.query(`CREATE FUNCTION t08_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='private-body password=secret'; END $$`);
    await s.database.query('CREATE TRIGGER t08_reject_history BEFORE INSERT ON moderation_history FOR EACH ROW EXECUTE FUNCTION t08_reject_history()');
    await s.database.query(`CREATE FUNCTION t08_reject_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.state='running' AND NEW.state='queued' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='private-retry password=secret'; END IF; RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t08_reject_retry BEFORE UPDATE ON moderation_jobs FOR EACH ROW EXECUTE FUNCTION t08_reject_retry()');
    const first = await s.child();
    const recoveryLine = await until(async () => first.errors().split('\n')
      .find(line => line.includes('worker_job_recovery_write_failed') && line.includes(id)), line => line !== undefined);
    assert.ok(recoveryLine);
    const recoveryEvent = JSON.parse(recoveryLine) as Record<string, unknown>;
    assert.equal(recoveryEvent.listing_id, id);
    assert.equal(recoveryEvent.phase, 'auto');
    assert.equal(recoveryEvent.diagnostic, 'database_error:P0001');
    assert.doesNotMatch(recoveryLine, /private-body|private-retry|password|secret/);
    assert.doesNotMatch(first.errors(), /private-body|private-retry|password|secret/);
    await stop(first.process);
    await pending(s.observer, id);
    await s.database.query('DROP TRIGGER t08_reject_history ON moderation_history');
    await s.database.query('DROP TRIGGER t08_reject_retry ON moderation_jobs');
    await s.database.query("UPDATE moderation_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE listing_id=$1", [id]);
    await s.child();
    const row = await until(async () => (await s.observer.query(`SELECT j.state,j.attempts,l.status,l.version::text AS version,
      (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0], value => value.state === 'completed' && value.status === 'published');
    assert.deepEqual(row, { state: 'completed', attempts: 2, status: 'published', version: '2', history_count: 1 });
  });
});

test('T08 actual worker retries transient failure automatically with safe diagnostic and eventual progress', { timeout: 20000 }, async () => {
  await scope(async s => {
    const id = await s.add('T08 automatic transient retry');
    await s.database.query('CREATE TABLE t08_fault(enabled boolean NOT NULL)');
    await s.database.query('INSERT INTO t08_fault VALUES(true)');
    await s.database.query(`CREATE FUNCTION t08_transient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (SELECT enabled FROM t08_fault) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='private secret'; END IF; RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t08_transient BEFORE INSERT ON moderation_history FOR EACH ROW EXECUTE FUNCTION t08_transient()');
    const child = await s.child('40');
    const attemptLine = await until(async () => child.errors().split('\n')
      .find(line => line.includes('worker_job_attempt_failed') && line.includes(id)), line => line !== undefined);
    assert.ok(attemptLine);
    const attemptEvent = JSON.parse(attemptLine) as Record<string, unknown>;
    assert.equal(attemptEvent.listing_id, id);
    assert.equal(attemptEvent.phase, 'auto');
    assert.equal(attemptEvent.recovery, 'retried');
    assert.equal(attemptEvent.diagnostic, 'database_error:40001');
    assert.doesNotMatch(attemptLine, /private|secret/);
    assert.doesNotMatch(child.errors(), /private|secret/);
    await s.database.query('UPDATE t08_fault SET enabled=false');
    const row = await until(async () => (await s.observer.query(`SELECT j.state,j.attempts,j.last_error,l.version::text AS version,l.status,
      (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=$1`, [id])).rows[0], value => value.state === 'completed' && value.status === 'published');
    assert.ok(row.attempts >= 2 && row.attempts <= 5);
    assert.equal(row.last_error, null); assert.equal(row.version, '2'); assert.equal(row.history_count, 1);
    assert.equal(row.status, 'published');
  });
});

test('T08 SIGTERM awaits active work, stops new claims, then closes worker database sessions', { timeout: 20000 }, async () => {
  await scope(async s => {
    const id = await s.add('T08 graceful active shutdown');
    const control = await s.control();
    const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await control.query('SELECT pg_advisory_lock(82756,1)');
    await s.database.query(`CREATE FUNCTION t08_shutdown_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(82756,1); RETURN NEW; END $$`);
    await s.database.query('CREATE TRIGGER t08_shutdown_barrier BEFORE INSERT ON moderation_history FOR EACH ROW EXECUTE FUNCTION t08_shutdown_barrier()');
    const child = await s.child('60000');
    s.defer(() => control.query('SELECT pg_advisory_unlock(82756,1)'));
    const workerPid = await blocked(s.observer, pid, 'INSERT INTO moderation_history');
    const closed = stop(child.process);
    const queuedId = await s.add('T08 do not claim after shutdown');
    // The SQL barrier establishes active work; this short yield lets the OS deliver SIGTERM.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    assert.equal(child.process.exitCode, null); assert.equal(child.process.signalCode, null);
    await control.query('SELECT pg_advisory_unlock(82756,1)');
    await closed;
    assert.equal(child.process.exitCode, 0); assert.equal(child.process.signalCode, null);
    const rows = (await s.observer.query(`SELECT l.id,l.status,j.state,j.attempts,
      (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=ANY($1::text[])`, [[id, queuedId]])).rows;
    assert.deepEqual(rows.find(row => row.id === id), { id, status: 'auto_approved', state: 'completed', attempts: 1, history_count: 1 });
    assert.deepEqual(rows.find(row => row.id === queuedId), { id: queuedId, status: 'pending', state: 'queued', attempts: 0, history_count: 0 });
    await until(async () => (await s.observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1', [workerPid])).rows[0].n,
      value => value === 0);
  });
});

test('T08 SIGTERM interrupts an idle worker with a long polling interval', { timeout: 15000 }, async () => {
  await scope(async s => {
    const child = await s.child('60000');
    const start = Date.now();
    await stop(child.process);
    assert.equal(child.process.exitCode, 0);
    assert.ok(Date.now() - start < 3000, 'idle shutdown must not wait for the 60-second poll interval');
  });
});

test('T08 actual POST standalone worker GET one/list preserve all outcomes and unsafe/max int64 tokens', { timeout: 25000 }, async () => {
  await scope(async s => {
    const api = await createApi({ DATABASE_URL: s.url, PORT: '8080', POLL_INTERVAL_MS: '20', LISTING_TTL_DAYS: '30' });
    s.defer(() => api.close());
    await api.listen(0, '127.0.0.1');
    const address = api.getHttpServer().address();
    assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    const cases = [
      { seller: 's-1002', title: 'T08 public approved', price: '6000000', status: 'published', outcome: 'approved', rules: [] },
      { seller: 's-1001', title: 'T08 public fake', price: '6000000', status: 'auto_rejected', outcome: 'rejected', rules: ['R1'] },
      { seller: 's-1004', title: 'T08 public needs review', price: '6000000', status: 'needs_human', outcome: 'escalated', rules: ['R5'] },
      { seller: 's-1002', title: 'T08 public unsafe integer', price: '9007199254740993', status: 'needs_human', outcome: 'escalated', rules: ['R2'] },
      { seller: 's-1002', title: 'T08 public maximum integer', price: '9223372036854775807', status: 'needs_human', outcome: 'escalated', rules: ['R2'] },
    ];
    const ids: string[] = [];
    for (const item of cases) {
      const response = await fetch(base + '/v1/listings', { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: `{"seller_id":"${item.seller}","category_id":"c-phones","title":"${item.title}","description":"clean","price_vnd":${item.price}}`,
        signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 202);
      const body = await response.json() as { id: string; status: string };
      assert.equal(body.status, 'pending'); ids.push(body.id);
    }
    const before = (await s.observer.query(`SELECT l.status,l.decision,j.state,
      (SELECT count(*)::int FROM moderation_history WHERE listing_id=l.id) AS history_count
      FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id=ANY($1::text[])`, [ids])).rows;
    assert.equal(before.length, cases.length);
    for (const row of before) assert.deepEqual(row, { status: 'pending', decision: null, state: 'queued', history_count: 0 });
    await s.child();
    await until(async () => (await s.observer.query("SELECT count(*)::int AS n FROM moderation_jobs WHERE listing_id=ANY($1::text[]) AND state='completed'", [ids])).rows[0].n,
      value => value === cases.length);
    await until(async () => (await s.observer.query("SELECT count(*)::int AS n FROM listings WHERE id=ANY($1::text[]) AND status='auto_approved'", [ids])).rows[0].n,
      value => value === 0);
    const listResponse = await fetch(base + '/v1/listings?limit=100', { headers: { connection: 'close' }, signal: AbortSignal.timeout(5000) });
    assert.equal(listResponse.status, 200);
    const listRaw = await listResponse.text();
    const list = parseJson(listRaw) as { items: Record<string, any>[] };
    assert.equal(list.items.length, cases.length);
    for (const [index, item] of cases.entries()) {
      const response = await fetch(base + '/v1/listings/' + ids[index], { headers: { connection: 'close' }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const raw = await response.text();
      const dto = parseJson(raw) as Record<string, any>;
      assert.equal(dto.id, ids[index]); assert.equal(dto.status, item.status);
      assert.equal(dto.decision.outcome, item.outcome);
      assert.deepEqual(dto.decision.reasons.map((reason: any) => reason.rule_id), item.rules);
      assert.ok(isLosslessNumber(dto.price_vnd), 'GET one top-level price_vnd must be a JSON number');
      assert.equal(String(dto.price_vnd), item.price);
      assert.match(raw, new RegExp('"price_vnd"\\s*:\\s*' + item.price + '(?=[,}])'));
      assert.match(listRaw, new RegExp('"price_vnd"\\s*:\\s*' + item.price + '(?=[,}])'));
      for (const field of ['created_at', 'decided_at']) assert.equal(new Date(dto[field]).toISOString(), dto[field]);
      assert.deepEqual(Object.keys(dto).sort(), ['id','seller_id','category_id','title','description','price_vnd','status','decision','created_at','decided_at'].sort());
      const fromList = list.items.find(value => value.id === dto.id);
      assert.ok(fromList);
      assert.ok(isLosslessNumber(fromList.price_vnd), 'GET list top-level price_vnd must be a JSON number');
      assert.deepEqual(fromList, dto);
      if (item.rules.includes('R2')) {
        assert.ok(isLosslessNumber(dto.decision.reasons[0].detail.price_vnd), 'R2 price must be a JSON number');
        assert.ok(isLosslessNumber(dto.decision.reasons[0].detail.median_price_vnd), 'R2 median must be a JSON number');
        assert.ok(isLosslessNumber(fromList.decision.reasons[0].detail.price_vnd), 'GET list R2 price must be a JSON number');
        assert.ok(isLosslessNumber(fromList.decision.reasons[0].detail.median_price_vnd), 'GET list R2 median must be a JSON number');
        assert.equal(String(dto.decision.reasons[0].detail.price_vnd), item.price);
        assert.equal(String(dto.decision.reasons[0].detail.median_price_vnd), '6000000');
      }
      const audit = (await s.observer.query(`SELECT l.status,j.state,j.attempts,l.version::text AS version,
        h.phase,h.decision=l.decision AS same_decision,h.decided_at=l.decided_at AS same_time
        FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id JOIN moderation_history h ON h.listing_id=l.id WHERE l.id=$1`, [ids[index]])).rows;
      assert.deepEqual(audit, [{ status: item.status, state: 'completed', attempts: 1,
        version: item.status === 'published' ? '2' : '1', phase: 'auto', same_decision: true, same_time: true }]);
    }
  });
});

test('T08 real worker R3 wait chain serializes duplicates while terminal R1 and R4 bypass the held key', { timeout: 25000 }, async () => {
  await scope(async s => {
    const title = 'T08 synchronized worker duplicates';
    const firstId = await s.add(title); const secondId = await s.add(title);
    const identity = createDuplicateIdentity({ sellerId: 's-1002', categoryId: 'c-phones', title, description: 'clean description', priceVnd: 6000000n });
    const control = await s.control();
    const pid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await control.query('SELECT pg_advisory_lock($1::bigint)', [identity.lockKey]);
    const a = await s.child(); const b = await s.child();
    s.defer(() => control.query('SELECT pg_advisory_unlock_all()'));
    const chain = await until(async () => (await s.observer.query<{ pid: number; blockers: number[] }>(
      `SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database()
       AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(%'`)).rows,
      rows => rows.length >= 2 && rows.some(row => row.blockers.includes(pid)) && rows.some(row => row.blockers.some(value => rows.some(other => other.pid === value))));
    assert.equal(chain.length, 2);
    await control.query('SELECT pg_advisory_unlock($1::bigint)', [identity.lockKey]);
    await until(async () => (await s.observer.query("SELECT count(*)::int AS n FROM moderation_jobs WHERE listing_id=ANY($1::text[]) AND state='completed'", [[firstId, secondId]])).rows[0].n,
      value => value === 2);
    await until(async () => (await s.observer.query("SELECT count(*)::int AS n FROM listings WHERE id=ANY($1::text[]) AND status='auto_approved'", [[firstId, secondId]])).rows[0].n,
      value => value === 0);
    const states = (await s.observer.query(`SELECT status FROM listings WHERE id=ANY($1::text[]) ORDER BY status`, [[firstId, secondId]])).rows;
    assert.deepEqual(states.map(row => row.status), ['auto_rejected', 'published']);
    await stop(a.process); await stop(b.process);
    const terminalIds: string[] = [];
    for (const [terminalTitle, seller] of [['T08 fake terminal held key','s-1002'], ['T08 trusted terminal held key','s-1005']]) {
      terminalIds.push(await s.add(terminalTitle, seller));
      const key = createDuplicateIdentity({ sellerId: seller, categoryId: 'c-phones', title: terminalTitle,
        description: 'clean description', priceVnd: 6000000n }).lockKey;
      await control.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    }
    await s.child();
    await until(async () => (await s.observer.query("SELECT count(*)::int AS n FROM moderation_jobs WHERE listing_id=ANY($1::text[]) AND state='completed'", [terminalIds])).rows[0].n,
      value => value === 2);
    const reasons = (await s.observer.query(`SELECT id,status,decision->'reasons'->0->>'rule_id' AS rule FROM listings WHERE id=ANY($1::text[])`, [terminalIds])).rows;
    assert.deepEqual(reasons.find(row => row.id === terminalIds[0]), { id: terminalIds[0], status: 'auto_rejected', rule: 'R1' });
    const publishedTrusted = await until(async () => (await s.observer.query<{ status: string; rule: string }>(
      `SELECT id,status,decision->'reasons'->0->>'rule_id' AS rule FROM listings WHERE id=$1`, [terminalIds[1]])).rows[0],
      row => row.status === 'published');
    assert.deepEqual(publishedTrusted, { id: terminalIds[1], status: 'published', rule: 'R4' });
  });
});
