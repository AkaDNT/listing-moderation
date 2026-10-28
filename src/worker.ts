import { Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { RuntimeModule } from './runtime.module';
import { BootstrapAssets, loadBootstrapAssets } from './db/assets';
import { Database } from './db/database';
import { DatabaseModule, DATABASE } from './db/database.module';

@Injectable()
class WorkerLifecycle implements OnApplicationShutdown {
  private readonly timer = setInterval(() => undefined, 60_000);
  onApplicationShutdown() { clearInterval(this.timer); }
}

export async function bootstrapWorker(env: NodeJS.ProcessEnv = process.env, suppliedAssets?: BootstrapAssets) {
  const config = loadConfig(env);
  const assets = suppliedAssets ?? await loadBootstrapAssets();
  const database = await Database.open(config.databaseUrl, assets);
  @Module({ imports: [RuntimeModule.register(env), DatabaseModule.register(database)], providers: [WorkerLifecycle] })
  class WorkerModule {}
  try {
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false });
    app.get(WorkerLifecycle);
    app.get(DATABASE);
    return app;
  } catch (startupError) {
    try {
      await database.close();
    } catch (closeError) {
      throw new AggregateError([startupError, closeError], 'Worker startup and database cleanup failed', { cause: startupError });
    }
    throw startupError;
  }
}

if (require.main === module) {
  void bootstrapWorker()
    .then((app) => {
      if (process.send) process.send({ event: 'worker-started' });
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void app.close().then(() => { process.exitCode = 0; }).catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
