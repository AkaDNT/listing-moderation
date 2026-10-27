import { Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { RuntimeModule } from './runtime.module';

@Injectable()
class WorkerLifecycle implements OnApplicationShutdown {
  private readonly timer = setInterval(() => undefined, 60_000);
  onApplicationShutdown() { clearInterval(this.timer); }
}

export async function bootstrapWorker(env: NodeJS.ProcessEnv = process.env) {
  loadConfig(env);
  @Module({ imports: [RuntimeModule.register(env)], providers: [WorkerLifecycle] })
  class WorkerModule {}
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false, abortOnError: false });
  app.get(WorkerLifecycle);
  return app;
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
