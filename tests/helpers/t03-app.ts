import { Body, Controller, Get, HttpCode, Inject, Module, NotFoundException, Post, Req, UnprocessableEntityException } from '@nestjs/common';
import { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { loadBootstrapAssets } from '../../src/db/assets';
import { DATABASE, DatabaseModule } from '../../src/db/database.module';
import { Database } from '../../src/db/database';
import { ApiError } from '../../src/http/errors';
import { HttpTransportModule } from '../../src/http/http-transport.module';
import { installHttpTransport } from '../../src/http/install-http-transport';
import { ListingRequestPipe, ValidatedListingRequest } from '../../src/http/listing-request.pipe';
import { createTestDatabase } from './postgres';

let calls = 0;

@Controller('test')
class T03Controller {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get('object') @HttpCode(202)
  object() { return { price_vnd: 9007199254740993n, label: 'transport' }; }

  @Get('ok')
  ok() { return { ok: true }; }

  @Get('accepted') @HttpCode(202)
  accepted() { return { accepted: true }; }

  @Get('empty') @HttpCode(204)
  empty(): undefined { return undefined; }

  @Get('fail/400')
  badRequest(): never { throw new ApiError(400, 'invalid_request', 'Invalid request'); }

  @Get('fail/409')
  conflict(): never { throw new ApiError(409, 'conflict', 'Conflict'); }

  @Get('fail/422')
  unprocessable(): never { throw new UnprocessableEntityException('Unknown seller or category'); }

  @Get('fail/404')
  missing(): never { throw new NotFoundException('Not found'); }

  @Get('fail/500')
  internal(): never { throw new Error('sentinel database password'); }

  @Get('fault/unsafe')
  unsafe() { return { value: Number.MAX_SAFE_INTEGER + 1 }; }

  @Get('fault/nan')
  nan() { return { value: Number.NaN }; }

  @Get('fault/infinity')
  infinity() { return { value: Number.POSITIVE_INFINITY }; }

  @Get('fault/date')
  invalidDate() { return { value: new Date(Number.NaN) }; }

  @Get('fault/cycle')
  cycle() { const value: { self?: unknown } = {}; value.self = value; return value; }

  @Post('echo') @HttpCode(200)
  echo(@Body(ListingRequestPipe) body: ValidatedListingRequest) {
    return { price_vnd: body.price_vnd, extension: body.original.extension };
  }

  @Post('persist') @HttpCode(202)
  async persist(@Body(ListingRequestPipe) body: ValidatedListingRequest) {
    const inserted = await this.database.query<{ id: string }>(
      'INSERT INTO t03_transport_probe(price_vnd) VALUES($1) RETURNING id::text AS id',
      [body.price_vnd.toString()],
    );
    const stored = await this.database.query<{ price_vnd: string; created_at: Date }>(
      'SELECT price_vnd::text AS price_vnd, created_at FROM t03_transport_probe WHERE id=$1',
      [inserted.rows[0].id],
    );
    return { id: inserted.rows[0].id, price_vnd: BigInt(stored.rows[0].price_vnd), created_at: stored.rows[0].created_at };
  }

  @Post('raw') @HttpCode(200)
  raw(@Req() request: { body?: unknown }) {
    calls += 1;
    return { received: request.body !== undefined };
  }
}

export async function createT03HttpApp() {
  calls = 0;
  const fixture = await createTestDatabase();
  let database: Database | undefined;
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    database = await Database.open(fixture.url, await loadBootstrapAssets());
    await database.query('CREATE TABLE t03_transport_probe(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, price_vnd bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    @Module({ imports: [HttpTransportModule, DatabaseModule.register(database)], controllers: [T03Controller] })
    class T03Module {}

    app = await NestFactory.create(T03Module, { logger: false, bodyParser: false, abortOnError: false });
    installHttpTransport(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind a TCP port');
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      hits: () => calls,
      resetHits: () => { calls = 0; },
      nextIncomingRequest: () => new Promise<IncomingMessage>(resolve => {
        app!.getHttpServer().once('request', (request: IncomingMessage) => resolve(request));
      }),
      persistedCount: async () => Number((await database!.query<{ count: string }>('SELECT count(*)::text AS count FROM t03_transport_probe')).rows[0].count),
      close: async () => { await app!.close(); await fixture.dispose(); },
    };
  } catch (error) {
    if (app) await app.close();
    else if (database) await database.close();
    await fixture.dispose();
    throw error;
  }
}
