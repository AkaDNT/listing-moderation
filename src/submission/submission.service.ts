import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../http/errors';
import { ValidatedListingRequest } from '../http/listing-request.pipe';
import { hashCanonicalRequest } from './canonical-request';
import { SubmissionRepository } from './submission.repository';
import {
  IdempotencyConflictError,
  SubmissionFields,
  SubmissionIdentity,
  SubmissionResult,
  UnknownReferenceError,
} from './submission.types';

export const SUBMISSION_REPOSITORY = Symbol('SUBMISSION_REPOSITORY');

@Injectable()
export class SubmissionService {
  constructor(@Inject(SUBMISSION_REPOSITORY) private readonly repository: SubmissionRepository) {}

  async submit(request: ValidatedListingRequest, key?: string): Promise<SubmissionResult> {
    const fields: SubmissionFields = {
      sellerId: request.seller_id,
      title: request.title,
      description: request.description,
      priceVnd: request.price_vnd,
      categoryId: request.category_id,
    };
    const identity: SubmissionIdentity | undefined = key === undefined
      ? undefined
      : { key, requestHash: hashCanonicalRequest(request.original) };

    try {
      return await this.repository.submit(fields, identity);
    } catch (error) {
      if (error instanceof UnknownReferenceError) {
        throw new ApiError(422, 'validation_error', 'Unknown seller or category');
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(409, 'conflict', error.message);
      }
      throw error;
    }
  }
}
