import { PipeTransform } from '@nestjs/common';
import { parsePriceInt64 } from './int64';
import { ApiError } from './errors';

export interface ValidatedListingRequest {
  seller_id: string;
  title: string;
  description: string;
  price_vnd: bigint;
  category_id: string;
  original: Record<string, unknown>;
}

export class ListingRequestPipe implements PipeTransform<unknown, ValidatedListingRequest> {
  transform(value: unknown): ValidatedListingRequest {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw invalidRequest('Request body must be a JSON object');
    }

    const request = value as Record<string, unknown>;
    for (const field of ['seller_id', 'title', 'description', 'price_vnd', 'category_id']) {
      if (!Object.hasOwn(request, field)) throw invalidRequest(`Missing required field: ${field}`);
    }

    const sellerId = requireString(request.seller_id, 'seller_id');
    const title = requireString(request.title, 'title');
    const description = requireString(request.description, 'description');
    const categoryId = requireString(request.category_id, 'category_id');

    const titleLength = Array.from(title).length;
    if (titleLength < 1 || titleLength > 200) {
      throw invalidRequest('title must contain 1 to 200 Unicode code points');
    }
    if (Array.from(description).length > 5000) {
      throw invalidRequest('description must contain at most 5000 Unicode code points');
    }

    let price: bigint;
    try { price = parsePriceInt64(request.price_vnd); }
    catch { throw invalidRequest('price_vnd must be an integer from 0 through 9223372036854775807'); }

    return {
      seller_id: sellerId,
      title,
      description,
      price_vnd: price,
      category_id: categoryId,
      original: request,
    };
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidRequest(`${field} must be a string`);
  return value;
}

function invalidRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}
