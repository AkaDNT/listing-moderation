import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'node:http';
import { ListingRequestPipe, ValidatedListingRequest } from '../http/listing-request.pipe';
import { parseIdempotencyKey } from './idempotency-key';
import { SubmissionService } from './submission.service';
import { SubmissionResult } from './submission.types';

@Controller('v1/listings')
export class ListingsController {
  constructor(private readonly submissions: SubmissionService) {}

  @Post()
  @HttpCode(202)
  async submit(
    @Body(ListingRequestPipe) body: ValidatedListingRequest,
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<{ id: string; status: SubmissionResult['status'] }> {
    const key = parseIdempotencyKey(request.headersDistinct);
    const result = await this.submissions.submit(body, key);
    if (result.kind === 'replayed') response.statusCode = 200;
    return { id: result.id, status: result.status };
  }
}
