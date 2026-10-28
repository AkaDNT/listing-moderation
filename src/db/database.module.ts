import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Database } from './database';

export const DATABASE = Symbol('DATABASE');

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  onApplicationShutdown(): Promise<void> {
    return this.database.close();
  }
}

@Module({})
export class DatabaseModule {
  static register(database: Database): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE, useValue: database },
        DatabaseLifecycle,
      ],
      exports: [DATABASE],
    };
  }
}
