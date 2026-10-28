import { ApiError } from '../http/errors';

const LISTING_STATUSES = new Set([
  'pending',
  'auto_approved',
  'auto_rejected',
  'needs_human',
  'published',
  'rejected',
  'expired',
]);

const KNOWN_QUERY_NAMES = ['seller_id', 'status', 'limit'] as const;

export type ListingStatus =
  | 'pending'
  | 'auto_approved'
  | 'auto_rejected'
  | 'needs_human'
  | 'published'
  | 'rejected'
  | 'expired';

export interface ParsedListingQuery {
  sellerId?: string;
  status?: ListingStatus;
  limit: number;
}

interface RawField {
  rawName: string;
  rawValue: string;
}

function invalidQuery(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

function splitRawQuery(input: string): RawField[] {
  const question = input.indexOf('?');
  const query = question >= 0 ? input.slice(question + 1) : input.replace(/^\?/, '');
  if (query === '') return [];

  return query.split('&').map(part => {
    const equals = part.indexOf('=');
    return equals < 0
      ? { rawName: part, rawValue: '' }
      : { rawName: part.slice(0, equals), rawValue: part.slice(equals + 1) };
  });
}

function classifyKnownName(rawName: string): { name?: typeof KNOWN_QUERY_NAMES[number]; bracket: boolean } {
  // URLSearchParams is used only to classify the name. Its forgiving decoder
  // must never supply a known parameter's value.
  const decodedName = new URLSearchParams(rawName + '=').keys().next().value as string | undefined;
  if (decodedName === undefined) return { bracket: false };

  for (const name of KNOWN_QUERY_NAMES) {
    if (decodedName === name) return { name, bracket: false };
    if (decodedName.startsWith(name + '[')) return { name, bracket: true };
  }
  return { bracket: false };
}

function decodeKnownComponent(rawValue: string, name: string): string {
  try {
    // Query strings use application/x-www-form-urlencoded plus semantics.
    return decodeURIComponent(rawValue.replace(/\+/g, ' '));
  } catch {
    throw invalidQuery(name + ' has malformed percent encoding or UTF-8');
  }
}

function parseLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw invalidQuery('limit must be a decimal integer from 1 through 100');
  }
  const normalized = value.replace(/^0+/, '') || '0';
  if (normalized === '0' || normalized.length > 3 || Number(normalized) > 100) {
    throw invalidQuery('limit must be a decimal integer from 1 through 100');
  }
  return Number(normalized);
}

export function parseListingQuery(rawQuery: string): ParsedListingQuery {
  const values = new Map<string, string>();
  const seen = new Set<string>();

  for (const field of splitRawQuery(rawQuery)) {
    const classified = classifyKnownName(field.rawName);
    if (classified.bracket) {
      throw invalidQuery('Array or object query parameters are not supported');
    }
    if (classified.name === undefined) continue;

    if (seen.has(classified.name)) {
      throw invalidQuery(classified.name + ' must appear at most once');
    }
    seen.add(classified.name);
    values.set(classified.name, decodeKnownComponent(field.rawValue, classified.name));
  }

  const sellerId = values.get('seller_id');
  const statusValue = values.get('status');
  const limitValue = values.get('limit');

  let status: ListingStatus | undefined;
  if (statusValue !== undefined) {
    if (!LISTING_STATUSES.has(statusValue)) throw invalidQuery('status is not supported');
    status = statusValue as ListingStatus;
  }

  const limit = limitValue === undefined ? 20 : parseLimit(limitValue);
  return { sellerId, status, limit };
}

export function isStorablePostgresText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}