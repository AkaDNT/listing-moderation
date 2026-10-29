import { createHash } from 'node:crypto';

const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = 0n;
const FINGERPRINT_VERSION = 'listing-r3-v1';
const LOCK_VERSION = 'listing-r3-lock-v1';

export interface DuplicateIdentityFields {
  sellerId: string;
  categoryId: string;
  priceVnd: bigint;
  title: string;
  description: string;
}

export interface DuplicateIdentity {
  canonical: string;
  fingerprint: string;
  lockKey: string;
}

function validateFields(value: DuplicateIdentityFields): void {
  if (!value || typeof value !== 'object' || typeof value.sellerId !== 'string' ||
      typeof value.categoryId !== 'string' || typeof value.title !== 'string' ||
      typeof value.description !== 'string') {
    throw new TypeError('R3 identity requires string seller, category, title and description fields');
  }
  if (typeof value.priceVnd !== 'bigint' || value.priceVnd < MIN_INT64 || value.priceVnd > MAX_INT64) {
    throw new TypeError('R3 identity price must be a nonnegative int64 bigint');
  }
}

export function normalizeDuplicateText(value: string): string {
  if (typeof value !== 'string') throw new TypeError('R3 text must be a string');
  return value.normalize('NFC')
    .toLowerCase()
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ | $/g, '');
}

function tuple(value: DuplicateIdentityFields): string[] {
  validateFields(value);
  return [FINGERPRINT_VERSION, value.sellerId, value.categoryId, value.priceVnd.toString(),
    normalizeDuplicateText(value.title), normalizeDuplicateText(value.description)];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function signedAdvisoryKey(hash: string): string {
  const unsigned = BigInt(`0x${hash.slice(0, 16)}`);
  const signed = unsigned >= (1n << 63n) ? unsigned - (1n << 64n) : unsigned;
  return signed.toString(10);
}

export function createDuplicateIdentity(value: DuplicateIdentityFields): DuplicateIdentity {
  const canonical = JSON.stringify(tuple(value));
  const fingerprintHash = sha256(canonical);
  const lockTuple = [LOCK_VERSION, ...tuple(value).slice(1)];
  const lockHash = sha256(JSON.stringify(lockTuple));
  return {
    canonical,
    fingerprint: `r3:v1:${fingerprintHash}`,
    lockKey: signedAdvisoryKey(lockHash),
  };
}

export function sameDuplicateIdentity(left: DuplicateIdentityFields, right: DuplicateIdentityFields): boolean {
  return JSON.stringify(tuple(left)) === JSON.stringify(tuple(right));
}