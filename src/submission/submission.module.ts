import { DynamicModule, Module } from '@nestjs/common';
import { DATABASE, DatabaseModule } from '../db/database.module';
import { Database } from '../db/database';
import { HttpTransportModule } from '../http/http-transport.module';
import { ListingsController } from './listings.controller';
import { SubmissionRepository } from './submission.repository';
import { SUBMISSION_REPOSITORY, SubmissionService } from './submission.service';

@Module({})
export class SubmissionModule {
  static register(database: Database): DynamicModule {
    return {
      module: SubmissionModule,
      imports: [DatabaseModule.register(database), HttpTransportModule],
      controllers: [ListingsController],
      providers: [
        {
          provide: SUBMISSION_REPOSITORY,
          useFactory: (registeredDatabase: Database) => new SubmissionRepository(registeredDatabase),
          inject: [DATABASE],
        },
        SubmissionService,
      ],
    };
  }
}
