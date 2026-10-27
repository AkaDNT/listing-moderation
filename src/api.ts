import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { RUNTIME_CONFIG, RuntimeModule } from './runtime.module';

@Controller()
class LiveController {
  @Get('livez')
  live() { return { status: 'ok' }; }
}

export async function createApi(env: NodeJS.ProcessEnv = process.env) {
  loadConfig(env);
  @Module({ imports: [RuntimeModule.register(env)], controllers: [LiveController] })
  class ApiModule {}
  const app = await NestFactory.create(ApiModule, { logger: false, bodyParser: false, abortOnError: false });
  app.get(RUNTIME_CONFIG);
  return app;
}

if (require.main === module) {
  void createApi().then((app) => app.listen(app.get(RUNTIME_CONFIG).port, '0.0.0.0'))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
