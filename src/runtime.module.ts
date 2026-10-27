import { DynamicModule, Module } from '@nestjs/common';
import { loadConfig } from './config';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

@Module({})
export class RuntimeModule {
  static register(env: NodeJS.ProcessEnv): DynamicModule {
    return { module: RuntimeModule, providers: [{ provide: RUNTIME_CONFIG, useFactory: () => loadConfig(env) }], exports: [RUNTIME_CONFIG] };
  }
}
