import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../http/errors';
import { ListingDto } from '../listings/listing.mapper';
import { isStorablePostgresText } from '../listings/listing-query';
import { HumanDecisionRepository } from './human-decision.repository';
import { HumanDecisionRequest } from './human-decision.pipe';

export const HUMAN_DECISION_REPOSITORY = Symbol('HUMAN_DECISION_REPOSITORY');
export const LISTING_TTL_DAYS = Symbol('LISTING_TTL_DAYS');

@Injectable()
export class HumanDecisionService {
  constructor(
    @Inject(HUMAN_DECISION_REPOSITORY) private readonly repository: HumanDecisionRepository,
    @Inject(LISTING_TTL_DAYS) private readonly ttlDays: number,
  ) {}

  async decide(listingId: string, request: HumanDecisionRequest): Promise<ListingDto> {
    if (!isStorablePostgresText(listingId)) throw new ApiError(404, 'not_found', 'Listing not found');
    const result = await this.repository.resolve(listingId, request, this.ttlDays);
    if (result.kind === 'missing') throw new ApiError(404, 'not_found', 'Listing not found');
    if (result.kind === 'conflict') throw new ApiError(409, 'conflict', 'Listing is not awaiting human review');
    return result.listing;
  }
}
