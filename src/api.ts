import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { RUNTIME_CONFIG, RuntimeModule } from './runtime.module';
import { BootstrapAssets, loadBootstrapAssets } from './db/assets';
import { DATABASE } from './db/database.module';
import { Database } from './db/database';
import { installHttpTransport } from './http/install-http-transport';
import { SubmissionModule } from './submission/submission.module';

export type HttpTransportInstaller = (app: INestApplication) => void;
export type ApiInitializer = (app: INestApplication) => Promise<void>;

@Controller()
class LiveController {
  @Get('livez')
  live() { return { status: 'ok' }; }
}

export async function createApi(
  env: NodeJS.ProcessEnv = process.env,
  suppliedAssets?: BootstrapAssets,
  transportInstaller: HttpTransportInstaller = installHttpTransport,
  initialize: ApiInitializer = async app => { await app.init(); },
) {
  const config = loadConfig(env);
  const assets = suppliedAssets ?? await loadBootstrapAssets();
  const database = await Database.open(config.databaseUrl, assets);
  @Module({
    imports: [RuntimeModule.register(env), SubmissionModule.register(database)],
    controllers: [LiveController],
  })
  class ApiModule {}
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(ApiModule, { logger: false, bodyParser: false, abortOnError: false });
    transportInstaller(app);
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    app.get(RUNTIME_CONFIG);
    app.get(DATABASE);
    await initialize(app);
    return app;
  } catch (startupError) {
    const cleanupErrors: unknown[] = [];
    try { await database.close(); }
    catch (closeError) { cleanupErrors.push(closeError); }
    if (app) {
      try { await app.close(); }
      catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([startupError, ...cleanupErrors], 'API startup and cleanup failed', { cause: startupError });
    }
    throw startupError;
  }
}

if (require.main === module) {
  void createApi().then(async (app) => {
    try {
      await app.listen(app.get(RUNTIME_CONFIG).port, '0.0.0.0');
    } catch (listenError) {
      try {
        await app.close();
      } catch (closeError) {
        throw new AggregateError([listenError, closeError], 'API listen and cleanup failed', { cause: listenError });
      }
      throw listenError;
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'API startup failed');
    process.exitCode = 1;
  });
}
