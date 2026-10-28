import { ApiError } from '../http/errors';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

export type DistinctRequestHeaders = Readonly<Record<string, readonly string[] | undefined>>;

export function parseIdempotencyKey(headersDistinct: DistinctRequestHeaders): string | undefined {
  const values = headersDistinct['idempotency-key'];
  if (values === undefined || values.length === 0) return undefined;
  if (values.length !== 1) {
    throw new ApiError(400, 'invalid_request', 'Idempotency-Key must appear at most once');
  }

  const value = values[0];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiError(400, 'invalid_request', 'Idempotency-Key has invalid syntax or length');
  }
  return value;
}
