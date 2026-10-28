import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ListingRequestPipe } from './listing-request.pipe';
import { ApiExceptionFilter } from './api-exception.filter';
import { JsonResponseInterceptor } from './json-response.interceptor';

@Module({
  providers: [
    ListingRequestPipe,
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: JsonResponseInterceptor },
  ],
  exports: [ListingRequestPipe],
})
export class HttpTransportModule {}
