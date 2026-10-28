import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { RUNTIME_CONFIG, RuntimeModule } from './runtime.module';
import { BootstrapAssets, loadBootstrapAssets } from './db/assets';
import { DATABASE, DatabaseModule } from './db/database.module';
import { Database } from './db/database';

@Controller()
class LiveController {
  @Get('livez')
  live() { return { status: 'ok' }; }
}

export async function createApi(env: NodeJS.ProcessEnv = process.env, suppliedAssets?: BootstrapAssets) {
  const config = loadConfig(env);
  const assets = suppliedAssets ?? await loadBootstrapAssets();
  const database = await Database.open(config.databaseUrl, assets);
  @Module({ imports: [RuntimeModule.register(env), DatabaseModule.register(database)], controllers: [LiveController] })
  class ApiModule {}
  try {
    const app = await NestFactory.create(ApiModule, { logger: false, bodyParser: false, abortOnError: false });
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    app.get(RUNTIME_CONFIG);
    app.get(DATABASE);
    return app;
  } catch (startupError) {
    try {
      await database.close();
    } catch (closeError) {
      throw new AggregateError([startupError, closeError], 'API startup and database cleanup failed', { cause: startupError });
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
