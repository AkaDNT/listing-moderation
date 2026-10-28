import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../http/errors';
import { isStorablePostgresText, parseListingQuery } from './listing-query';
import { ListingDto, mapListing } from './listing.mapper';
import { ListingReadRepository } from './listing-read.repository';

export const LISTING_READ_REPOSITORY = Symbol('LISTING_READ_REPOSITORY');

@Injectable()
export class ListingReadService {
  constructor(@Inject(LISTING_READ_REPOSITORY) private readonly repository: ListingReadRepository) {}

  async findById(id: string): Promise<ListingDto> {
    if (!isStorablePostgresText(id)) throw new ApiError(404, 'not_found', 'Listing not found');
    const row = await this.repository.findById(id);
    if (!row) throw new ApiError(404, 'not_found', 'Listing not found');
    return mapListing(row);
  }

  async list(rawQuery: string): Promise<{ items: ListingDto[] }> {
    const query = parseListingQuery(rawQuery);
    if (query.sellerId !== undefined && !isStorablePostgresText(query.sellerId)) return { items: [] };
    return { items: (await this.repository.list(query)).map(mapListing) };
  }
}
