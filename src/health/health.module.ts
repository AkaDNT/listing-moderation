import { DynamicModule, Inject, Injectable, Module, BeforeApplicationShutdown } from '@nestjs/common';
import { DATABASE, DatabaseModule } from '../db/database.module';
import { Database } from '../db/database';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Injectable()
class HealthDrain implements BeforeApplicationShutdown {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}
  beforeApplicationShutdown() { this.health.drain(); }
}

@Module({})
export class HealthModule {
  static register(database: Database): DynamicModule {
    return {
      module: HealthModule,
      imports: [DatabaseModule.register(database)],
      controllers: [HealthController],
      providers: [
        { provide: HealthService, useFactory: (db: Database) => new HealthService(db), inject: [DATABASE] },
        HealthDrain,
      ],
      exports: [HealthService],
    };
  }
}
