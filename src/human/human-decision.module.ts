import { DynamicModule, Module } from '@nestjs/common';
import { DATABASE, DatabaseModule } from '../db/database.module';
import { Database } from '../db/database';
import { HttpTransportModule } from '../http/http-transport.module';
import { HumanDecisionController } from './human-decision.controller';
import { HumanDecisionRepository } from './human-decision.repository';
import { HUMAN_DECISION_REPOSITORY, HumanDecisionService, LISTING_TTL_DAYS } from './human-decision.service';

@Module({})
export class HumanDecisionModule {
  static register(database: Database, ttlDays: number): DynamicModule {
    return {
      module: HumanDecisionModule,
      imports: [DatabaseModule.register(database), HttpTransportModule],
      controllers: [HumanDecisionController],
      providers: [
        { provide: HUMAN_DECISION_REPOSITORY, useFactory: (registered: Database) => new HumanDecisionRepository(registered), inject: [DATABASE] },
        { provide: LISTING_TTL_DAYS, useValue: ttlDays },
        HumanDecisionService,
      ],
    };
  }
}
