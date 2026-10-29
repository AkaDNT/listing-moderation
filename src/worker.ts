import { BeforeApplicationShutdown, Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { RuntimeModule } from './runtime.module';
import { BootstrapAssets, loadBootstrapAssets } from './db/assets';
import { Database } from './db/database';
import { DatabaseModule, DATABASE } from './db/database.module';
import { RuntimeConfig } from './config';
import { RUNTIME_CONFIG } from './runtime.module';
import { ModerationJobRepository } from './worker/moderation-job.repository';
import { WorkerLoop } from './worker/worker-loop';

@Injectable()
class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject('WORKER_LOOP') private readonly loop: WorkerLoop) {}
  onApplicationBootstrap() { this.loop.start(); }
  beforeApplicationShutdown() { return this.loop.stop(); }
}

export async function bootstrapWorker(env: NodeJS.ProcessEnv = process.env, suppliedAssets?: BootstrapAssets) {
  const config = loadConfig(env);
  const assets = suppliedAssets ?? await loadBootstrapAssets();
  const database = await Database.open(config.databaseUrl, assets);
  @Module({
    imports: [RuntimeModule.register(env), DatabaseModule.register(database)],
    providers: [
      { provide: 'WORKER_LOOP', useFactory: (db: Database, runtime: RuntimeConfig) =>
        new WorkerLoop(new ModerationJobRepository(db), runtime.pollIntervalMs), inject: [DATABASE, RUNTIME_CONFIG] },
      WorkerLifecycle,
    ],
  })
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
